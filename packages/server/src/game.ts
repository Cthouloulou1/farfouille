/**
 * La partie, cote serveur. Fait autorite sur tout.
 *
 * PERSISTANCE -- deux fichiers, et c'est voulu.
 *
 *   <partie>.journal.jsonl   ajout seul, une ligne par evenement, jamais
 *                            reecrit, force sur le disque a chaque ligne.
 *                            C'EST LUI QUI FAIT FOI.
 *   <partie>.json            instantane complet, reecrit a chaque coup.
 *                            Commodite de lecture pour les outils.
 *
 * Une partie qui dure des mois ne doit pas tenir a un fichier qu'on reecrit
 * sans cesse : il suffit d'une coupure au mauvais moment, d'un disque qui
 * tousse ou d'une fausse manoeuvre pour tout perdre. Le journal ne se reecrit
 * jamais ; on peut effacer l'instantane sans rien perdre, il se reconstruit.
 *
 * La partie etant deterministe (SPEC.md §5), rejouer les placements au
 * demarrage suffit a retrouver la grille exacte, et refaire les pioches dans
 * l'ordre rend au sac son etat de compensation.
 */
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync,
  openSync, writeSync, fsyncSync, closeSync, unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Dict } from "../../engine/src/dictionary.ts";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { Board, type Placement } from "../../engine/src/board.ts";
import { Bag, DEFAULT_BAG } from "../../engine/src/bag.ts";
import { BLANK } from "../../engine/src/alphabet.ts";
import { SacFini, SAC_FRANCAIS, type Pioche } from "../../engine/src/sac.ts";
import {
  configParDefaut, serialiser, deserialiser,
  type ConfigPartie, type ConfigSerialisee,
} from "../../engine/src/config.ts";
import { setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { mulberry32, moveSeed } from "../../engine/src/rng.ts";
import { resolveTypedWord, PLAY_MESSAGE, type PlayError } from "../../engine/src/play.ts";
import { noteCoup, type Dir } from "../../engine/src/coords.ts";
import { DAWG_PATH } from "../../engine/src/paths.ts";
import type { Move } from "../../engine/src/score.ts";

/** Un palier de score : un score, et TOUS les coups qui l'atteignent. */
export interface Tier {
  score: number;
  moves: [string, string, number, number][];
}

export interface PlayedMove {
  n: number;
  rack: string;
  notation: string;
  /** Le mot RETENU par le logiciel, celui qui est pose. */
  word: string;
  dir: Dir;
  x: number;
  y: number;
  score: number;
  placements: Placement[];
  /** Qui a trouve le top. null = revele sans joueur. */
  player: string | null;
  /**
   * Le mot que le joueur a REELLEMENT tape, qui peut differer du mot retenu
   * quand le logiciel a choisi un autre isotop. Absent des parties d'avant son
   * enregistrement : il n'a jamais ete ecrit et ne peut pas etre reconstitue.
   */
  playerWord?: string;
  playerDir?: Dir;
  playerX?: number;
  playerY?: number;
  /** Millisecondes ecoulees depuis la diffusion du tirage. */
  ms: number;
  isotops: number;
  /**
   * Paliers de score du coup. Gardes EN RESERVE pour l'analyse d'apres-partie :
   * ils ne sont jamais diffuses aux joueurs (SPEC.md §5).
   */
  tiers?: Tier[];
  /** Qui a aime ce coup. Un nom au plus une fois. */
  likes?: string[];
  /**
   * DUPLICATE seulement : le score de chaque joueur sur ce coup, et ceux qui
   * ont trouve le top. Chacun marque sa meilleure solution ; l'ecart au top est
   * son negatif (SPEC.md §16).
   */
  scores?: Record<string, number>;
  trouveurs?: string[];
  /**
   * Ce que CHAQUE joueur a reellement propose sur ce coup : son meilleur mot,
   * ou il l'a pose et ce qu'il valait.
   *
   * C'est ce qui permet, apres la partie, de montrer le coup de chacun plutot
   * que le top -- et de retrouver un mot qui ne figure dans aucun palier.
   */
  propositions?: Record<string, { word: string; dir: Dir; x: number; y: number; score: number }>;
  /**
   * TOPPING chronometre : personne n'a trouve le top a l'echeance. Un demi-point
   * va au joueur qui avait propose la solution la plus rentable, le plus vite.
   */
  demiPoint?: { joueur: string; word: string; score: number };
}

export interface ChatMessage {
  at: number;
  who: string;
  text: string;
  /** Case partagee, cliquable dans le chat. */
  cell?: { x: number; y: number };
}

export interface TryResult {
  ok: boolean;
  message: string;
  word?: string;
  score?: number;
  /** Vrai si ce coup atteint le score du top : le coup est remporte. */
  top?: boolean;
  /** DUPLICATE : la meilleure solution retenue pour ce joueur sur ce coup. */
  retenu?: number;
}

interface Saved {
  gameId: string;
  layout: LayoutName;
  /**
   * Graine de la partie, tiree au hasard a la creation.
   *
   * Elle ne derive PAS du nom de la grille : deux grilles nommees pareil
   * rejoueraient sinon exactement la meme partie, tirages compris. Une fois
   * ecrite, elle ne bouge plus -- c'est elle qui rend l'historique rejouable.
   */
  seed: string;
  /** La variante jouee. Absente des parties d'avant les parties parametrables. */
  config?: ConfigSerialisee;
  /** Instant de creation de la grille, pour l'age de la partie. */
  createdAt: number;
  moves: PlayedMove[];
  players: Record<string, number>;
  chat: ChatMessage[];
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

/** Duree du decompte d'avant-partie : 3, 2, 1, partez. */
const DECOMPTE_MS = 3000;

/**
 * Combien de tirages sans le moindre coup jouable avant de clore la partie.
 *
 * Un tirage dont rien ne se pose est deja rarissime -- il faut une grille tres
 * fermee et beaucoup de malchance. Que ce soit vrai HUIT fois de suite, avec un
 * tirage refait a chaque fois, ne s'explique plus par la malchance : le sac ne
 * contient plus de quoi jouer, et la partie est finie.
 *
 * Huit, parce que chaque essai coute un calcul de top complet -- quelques
 * millisecondes sur un plateau borne, jusqu'a une seconde sur une grille de
 * trois mille coups. Assez pour ecarter le hasard, assez peu pour ne pas figer
 * le serveur sur un evenement qui ne devrait jamais arriver.
 */
const TIRAGES_INJOUABLES = 8;

/** Ce processus existe-t-il encore ? EPERM veut dire oui, mais pas a nous. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Le verrou bat toutes les dix secondes ; on le tient pour mort au-dela de
 * quarante.
 *
 * Le numero de processus ne suffit pas a savoir si un serveur vit encore : le
 * systeme les RECYCLE. Un verrou laisse par un serveur tue a ainsi bloque le
 * demarrage parce que son numero avait ete repris par un processus Windows sans
 * aucun rapport -- « ce processus existe-t-il ? » repondait oui. Le battement
 * tranche : un verrou qui ne bat plus n'est tenu par personne.
 */
const BATTEMENT_MS = 10_000;
const VERROU_MORT_MS = 40_000;

export class Game {
  readonly gameId: string;
  readonly layout: LayoutName;
  private readonly dawg: Dict;
  private readonly board: Board;
  private bag!: Pioche;
  /** La configuration de cette partie : tirage, pose, primes, pioche. */
  readonly cfg: ConfigPartie;
  /** La partie est terminee : le sac ne permet plus de jouer (SPEC.md §16). */
  finie = false;
  /**
   * Jokers encore disponibles, en partie joker. Ils ne sont PAS dans le sac :
   * ils vivent au tirage, et n'en sortent que le jour ou aucune vraie lettre ne
   * peut les remplacer sur la grille.
   */
  jokersEnReserve = 0;
  /** Cree dans start(), une fois la graine connue. */
  private worker!: Worker;
  private readonly file: string;
  private readonly journal: string;
  private readonly lockFile: string;
  private holdsLock = false;
  private battement: ReturnType<typeof setInterval> | null = null;
  /** Descripteur du journal, ouvert en ajout pour toute la duree de la partie. */
  private jfd: number | null = null;
  seed = "";

  moves: PlayedMove[] = [];
  players: Record<string, number> = {};
  chat: ChatMessage[] = [];
  createdAt = Date.now();
  reliquat: string[] = [];
  rack = "";
  rackNotation = "";
  /** Score du top du coup courant. -1 tant que le solveur n'a pas repondu. */
  bestScore = -1;
  isotops = 0;
  tiers: Tier[] = [];
  private canonicalTop: Move | null = null;
  /** Instant ou le tirage courant a ete diffuse. Le chrono du coup part de la. */
  servedAt = 0;
  /** Minuterie du coup en cours, quand la partie est chronometree. */
  private echeance: ReturnType<typeof setTimeout> | null = null;
  /**
   * Fin du decompte d'avant-coup, quand il est active. Tant qu'il court, le
   * tirage est connu mais le chrono n'a pas demarre : personne ne perd de temps.
   */
  decompteJusqua = 0;
  /** Instant du premier tirage. Sert a mesurer la duree d'une partie bornee. */
  debutDeLaPartie = 0;

  /**
   * Le tirage, tel qu'il part aux clients.
   *
   * VIDE pendant le decompte. « 3, 2, 1 » est un depart, et partir en ayant
   * deja lu ses lettres n'en est pas un. La regle est ici, dans la partie, et
   * non dans le transport : le tirage ne doit pas etre public, pas seulement
   * ne pas s'afficher -- cache a l'ecran, il resterait lisible dans la console.
   */
  get rackPublic(): string {
    return this.decompteJusqua > Date.now() ? "" : this.rack;
  }

  /** La notation du tirage, muette elle aussi pendant le decompte. */
  get notationPublique(): string {
    return this.decompteJusqua > Date.now() ? "" : this.rackNotation;
  }
  /**
   * Y a-t-il quelqu'un dans le salon ?
   *
   * Une partie endormie ne pioche pas et ne chronometre pas. Sans cela, un
   * salon vide continuait a devorer des coups -- et sur une grande grille a
   * gros tirage, des MINUTES de calcul chacun -- pour personne.
   */
  actif = false;
  /**
   * La partie a-t-elle commence ?
   *
   * Un salon neuf s'ouvre sur ses reglages : ni tirage, ni chrono, tant que
   * son proprietaire n'a pas valide la variante. Entrer quelque part ne doit
   * pas lancer une partie qu'on n'a pas choisie.
   */
  demarree = false;
  /**
   * Qui est dans le salon. Tenu a jour par le transport : le moteur n'a pas de
   * WebSocket, mais le duplicate a besoin de savoir QUI etait la au moment du
   * tirage -- c'est ce qui distingue un joueur compte d'un visiteur arrive en
   * cours de coup.
   */
  readonly presents = new Set<string>();
  /** DUPLICATE : la meilleure solution de chacun sur le coup en cours. */
  private propositions = new Map<
    string, { score: number; word: string; dir: Dir; x: number; y: number; at: number }
  >();
  /** DUPLICATE : qui etait present quand le tirage est tombe. */
  private participants = new Set<string>();
  solving = false;

  private nextId = 1;
  private pending = new Map<number, (r: any) => void>();
  private listeners: (() => void)[] = [];
  private surCoup: ((m: PlayedMove) => void)[] = [];
  private surChat: ((m: ChatMessage) => void)[] = [];

  constructor(gameId: string, layout: LayoutName, cfg?: ConfigPartie) {
    this.gameId = gameId;
    this.layout = layout;
    setLayout(layout);
    this.cfg = cfg ?? configParDefaut();
    this.dawg = loadDict(DAWG_PATH);
    this.board = new Board(this.dawg, this.cfg);
    this.file = join(DATA_DIR, `${gameId}.json`);
    this.journal = join(DATA_DIR, `${gameId}.journal.jsonl`);
    this.lockFile = join(DATA_DIR, `${gameId}.verrou`);
  }

  /**
   * Un seul serveur a la fois sur une partie.
   *
   * Deux processus qui ecrivent dans le meme journal en font une bouillie :
   * les coups s'entrelacent, les numeros se repetent, et la partie devient
   * irrecuperable. Le port ne protege pas -- deux serveurs sur deux ports
   * differents ouvrent tres bien la meme partie.
   */
  private acquireLock(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(this.lockFile)) {
      let held: { pid?: number; since?: number; vu?: number } = {};
      try { held = JSON.parse(readFileSync(this.lockFile, "utf8")); } catch { /* verrou illisible */ }
      const pid = held.pid;
      // Un verrou d'avant le battement n'a pas de `vu` : on se rabat sur son
      // horodatage de prise, faute de mieux.
      const dernierSigne = held.vu ?? held.since ?? 0;
      const bat = Date.now() - dernierSigne < VERROU_MORT_MS;
      if (pid !== undefined && pid !== process.pid && alive(pid) && bat) {
        throw new Error(
          `la partie "${this.gameId}" est deja ouverte par le processus ${pid}` +
          (held.since ? ` depuis ${new Date(held.since).toLocaleString("fr")}` : "") +
          `.
  Deux serveurs sur la meme partie corrompraient le journal.` +
          `
  Arretez l'autre serveur, ou lancez celui-ci avec --partie <autre-nom>.` +
          `
  Si vous etes certain qu'aucun serveur ne tourne : supprimez ${this.lockFile}`,
        );
      }
      if (pid !== undefined && pid !== process.pid) {
        console.log(
          `[partie] verrou perime du processus ${pid}` +
          (alive(pid) ? " (numero recycle par un autre programme)" : " (arret brutal)") +
          `, on le reprend`,
        );
      }
    }
    this.ecrireLeVerrou(Date.now());
    this.holdsLock = true;
    // Le battement dit « je suis toujours la ». Sans lui, rien ne distingue un
    // serveur vivant d'un numero de processus recycle.
    this.battement = setInterval(() => {
      if (this.holdsLock) this.ecrireLeVerrou(this.depuis);
    }, BATTEMENT_MS);
    this.battement.unref?.();
  }

  /** Instant de prise du verrou, conserve pour l'affichage. */
  private depuis = 0;

  private ecrireLeVerrou(depuis: number): void {
    this.depuis = depuis === 0 ? Date.now() : depuis;
    try {
      const fd = openSync(this.lockFile, "w");
      writeSync(fd, JSON.stringify({ pid: process.pid, since: this.depuis, vu: Date.now() }));
      closeSync(fd);
    } catch { /* un verrou qu'on n'arrive pas a ecrire ne doit pas tuer la partie */ }
  }

/**
   * Arrete la partie : le fil de calcul se termine et le verrou est rendu.
   *
   * Indispensable quand un salon relance une partie : sans cela le fil du
   * solveur precedent survivrait, avec sa grille et ses 4 Mo de dictionnaires,
   * et le verrou empecherait la nouvelle partie de s'ouvrir.
   */
  async stop(): Promise<void> {
    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    this.releaseLock();
    for (const [, done] of this.pending) done({ result: null, ms: 0 });
    this.pending.clear();
    this.listeners = [];
    this.surCoup = [];
    this.surChat = [];
    if (this.worker !== undefined) await this.worker.terminate();
  }

  /** Rend le verrou. Sans effet s'il ne nous appartient pas. */
  releaseLock(): void {
    if (this.battement !== null) { clearInterval(this.battement); this.battement = null; }
    if (!this.holdsLock) return;
    this.holdsLock = false;
    try {
      const held = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: number };
      if (held.pid === process.pid) unlinkSync(this.lockFile);
    } catch { /* deja parti, tant mieux */ }
  }

  /**
   * Ecrit un evenement dans le journal et le force sur le disque. Le fsync
   * coute une milliseconde ; c'est le prix pour qu'une coupure de courant
   * juste apres un coup ne le fasse pas disparaitre.
   */
  private append(ev: Record<string, unknown>): void {
    mkdirSync(DATA_DIR, { recursive: true });
    if (this.jfd === null) this.jfd = openSync(this.journal, "a");
    writeSync(this.jfd, JSON.stringify(ev) + "\n");
    fsyncSync(this.jfd);
  }

  /** Relit le journal. Les lignes tronquees par une coupure sont ignorees. */
  private readJournal(): Record<string, any>[] {
    if (!existsSync(this.journal)) return [];
    const out: Record<string, any>[] = [];
    let broken = 0;
    for (const line of readFileSync(this.journal, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try { out.push(JSON.parse(line)); } catch { broken++; }
    }
    if (broken > 0) {
      console.warn(`[partie] ${broken} ligne(s) illisible(s) dans le journal, ignorees`);
    }
    return out;
  }

  /**
   * La variante d'une partie deja commencee, lue sans la demarrer.
   *
   * Le serveur doit la connaitre avant de construire la grille : une partie
   * reprise garde sa variante, on ne rejoue pas une 8 sur 8 en 7 sur 7.
   */
  static configEnregistree(gameId: string): ConfigSerialisee | null {
    const journal = join(DATA_DIR, `${gameId}.journal.jsonl`);
    if (existsSync(journal)) {
      for (const ligne of readFileSync(journal, "utf8").split("\n")) {
        if (ligne.trim() === "") continue;
        try {
          const e = JSON.parse(ligne) as Record<string, unknown>;
          if (e["t"] === "grille") return (e["config"] as ConfigSerialisee) ?? null;
        } catch { /* ligne illisible */ }
      }
      return null;
    }
    const instantane = join(DATA_DIR, `${gameId}.json`);
    if (!existsSync(instantane)) return null;
    try {
      return (JSON.parse(readFileSync(instantane, "utf8")) as Saved).config ?? null;
    } catch { return null; }
  }

  onChange(fn: () => void): void { this.listeners.push(fn); }

  /**
   * Prevenu a chaque coup pose, QUELLE QUE SOIT SON ORIGINE.
   *
   * Un coup remporte par un joueur, revele a la main ou pose par le minuteur
   * doit atteindre les clients de la meme facon. Diffuser depuis le point
   * d'entree du message laissait les coups du chrono invisibles : la grille
   * avancait sans que personne ne recoive les caramels.
   */
  onMove(fn: (m: PlayedMove) => void): void { this.surCoup.push(fn); }

  /**
   * Prevenu a chaque message du chat, y compris ceux que le MOTEUR emet.
   *
   * La liste des trouveurs du duplicate vient de la, pas d'un joueur : diffuser
   * depuis le point d'entree du message « say » la laissait invisible, comme
   * l'etaient les coups poses par le chrono.
   */
  onChat(fn: (m: ChatMessage) => void): void { this.surChat.push(fn); }
  private emit(): void { for (const f of this.listeners) f(); }

  /** Rejoue le journal, puis prepare le coup courant. */
  async start(): Promise<void> {
    this.acquireLock();

    // Le journal fait foi. L'instantane ne sert que s'il n'y a pas de journal
    // -- parties d'avant son existence, ou journal efface a la main.
    const events = this.readJournal();
    let saved: Saved | null = null;

    if (events.length > 0) {
      saved = this.rebuild(events);
      console.log(`[partie] ${events.length} evenements relus dans le journal`);
    } else if (existsSync(this.file)) {
      saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
      console.log(`[partie] pas de journal, reprise depuis l'instantane`);
    }

    // Nouvelle grille = nouvelle graine, tiree au hasard. Les parties anciennes
    // n'en avaient pas : on retombe sur le nom, pour ne pas les casser.
    this.seed = saved?.seed ?? (saved ? this.gameId : randomUUID());
    this.createdAt = saved?.createdAt ?? Date.now();
    this.chat = saved?.chat ?? [];

    // Le journal commence par l'entete de la grille : graine, pavage, date.
    // Sans lui on ne saurait pas rejouer la partie a partir du seul journal.
    if (events.length === 0) {
      this.append({
        t: "grille", gameId: this.gameId, layout: this.layout,
        seed: this.seed, createdAt: this.createdAt, config: serialiser(this.cfg),
      });
      // Migration : une partie qui n'avait qu'un instantane se voit dotee d'un
      // journal complet, retroactivement.
      if (saved !== null) {
        for (const m of saved.moves) this.append({ t: "coup", move: m });
        for (const c of this.chat) this.append({ t: "chat", msg: c });
        console.log(`[partie] journal cree a partir de l'instantane`);
      }
    }
    // En partie joker, le tirage contient toujours un joker : le sac ne
    // distribue donc que `tirage - 1` lettres, et les deux jokers sont mis de
    // cote. Ils ne sont pas piochables, ils accompagnent le tirage.
    // Combien de jokers ? Deux si le sac est fini -- ce sont ceux du jeu. Sur
    // une pioche qui ne s'epuise pas, ils ne s'epuisent pas non plus : on en
    // reprend un chaque fois qu'un est pose.
    this.jokersEnReserve = this.cfg.joker
      ? (this.cfg.pioche === "sac102" ? 2 : Infinity)
      : 0;
    const parTirage = this.cfg.tirage - (this.cfg.joker ? 1 : 0);
    const alea = mulberry32(moveSeed(this.seed, 0));

    if (this.cfg.pioche === "probabilites") {
      this.bag = new Bag(DEFAULT_BAG, alea, undefined, parTirage);
    } else {
      const distribution = this.cfg.joker
        ? Object.fromEntries(Object.entries(SAC_FRANCAIS).filter(([l]) => l !== BLANK))
        : SAC_FRANCAIS;
      const sac = new SacFini(distribution, alea, parTirage);
      sac.recharge = this.cfg.pioche === "sac102boucle";
      this.bag = sac;
    }

    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { layout: this.layout, seed: this.seed, config: serialiser(this.cfg) },
    });
    this.worker.on("message", (m: any) => {
      if (m.t !== "solved" && m.t !== "paliers") return;
      const done = this.pending.get(m.id);
      this.pending.delete(m.id);
      done?.(m);
    });
    this.worker.on("error", (e) => console.error("[solveur]", e));

    if (saved !== null) {
      if (saved.layout !== this.layout) {
        throw new Error(
          `la partie ${this.gameId} a ete jouee sur le pavage "${saved.layout}", ` +
          `pas "${this.layout}" -- changer de pavage invaliderait tous les scores`,
        );
      }
      this.players = saved.players ?? {};
      for (const m of saved.moves) {
        // La pioche doit etre refaite dans l'ordre : c'est elle qui porte l'etat
        // de compensation, et il depend de tout l'historique.
        this.bag.draw(this.reliquat);
        this.board.place(m.placements);
        this.worker.postMessage({ t: "place", placements: m.placements });
        this.reliquat = Bag.remainder(m.rack, m.placements);
        this.moves.push(m);
      }
      console.log(`[partie] ${this.moves.length} coups rejoues`);
    } else {
      console.log(`[partie] nouvelle grille, graine ${this.seed.slice(0, 8)}`);
    }
    // Une partie qui a deja des coups a evidemment commence : on ne va pas
    // redemander ses reglages a celui qui la reprend.
    this.demarree = this.moves.length > 0;
    // On ne pioche PAS ici : le premier joueur qui entre declenchera le
    // calcul. Distribuer au demarrage faisait calculer le top de chaque salon
    // enregistre, y compris ceux que personne n'ouvrira.
  }

  /**
   * Reconstruit la partie a partir des seuls evenements du journal. C'est le
   * chemin de recuperation : meme si l'instantane a disparu, tout est ici.
   */
  private rebuild(events: Record<string, any>[]): Saved {
    const out: Saved = {
      gameId: this.gameId, layout: this.layout, seed: this.gameId,
      createdAt: Date.now(), moves: [], players: {}, chat: [],
    };
    const byNumber = new Map<number, PlayedMove>();
    for (const ev of events) {
      if (ev["t"] === "grille") {
        out.seed = ev["seed"] ?? out.seed;
        out.createdAt = ev["createdAt"] ?? out.createdAt;
        out.layout = ev["layout"] ?? out.layout;
      } else if (ev["t"] === "coup") {
        const m = ev["move"] as PlayedMove;
        out.moves.push(m);
        byNumber.set(m.n, m);
      } else if (ev["t"] === "chat") {
        out.chat.push(ev["msg"] as ChatMessage);
      } else if (ev["t"] === "like") {
        const m = byNumber.get(ev["n"] as number);
        if (m === undefined) continue;
        const likes = m.likes ?? (m.likes = []);
        const i = likes.indexOf(ev["who"] as string);
        if (ev["on"] === true && i === -1) likes.push(ev["who"] as string);
        if (ev["on"] === false && i !== -1) likes.splice(i, 1);
      }
    }
    // Le classement se recompte, il ne se stocke pas : ainsi il ne peut pas
    // deriver de la liste des coups.
    for (const m of out.moves) {
      if (m.player !== null) out.players[m.player] = (out.players[m.player] ?? 0) + 1;
      if (m.demiPoint !== undefined) {
        out.players[m.demiPoint.joueur] = (out.players[m.demiPoint.joueur] ?? 0) + 0.5;
      }
    }
    return out;
  }

  /**
   * Aimer un coup, ou retirer son "j'aime". Le like va au joueur qui a trouve
   * le top ; un coup revele sans joueur ne s'aime pas.
   */
  like(who: string, n: number): boolean {
    const m = this.moves.find((q) => q.n === n);
    if (m === undefined || m.player === null || m.player === who) return false;
    const likes = m.likes ?? (m.likes = []);
    const i = likes.indexOf(who);
    const on = i === -1;
    if (on) likes.push(who); else likes.splice(i, 1);
    this.append({ t: "like", n, who, on });
    this.save();
    this.emit();
    return true;
  }

  /** Coups que PERSONNE n'a trouves. Ni un joueur, ni un demi-point. */
  get nonTrouves(): number {
    return this.moves.filter((m) => m.player === null).length;
  }

  /**
   * DUPLICATE : points et negatif de chacun, sur toute la partie.
   *
   * Le negatif est l'ecart cumule au top. Un joueur qui a trouve tous les tops
   * a un negatif nul -- c'est le « TOP » du tableau.
   */
  classementDuplicate(): { points: Record<string, number>; negatif: Record<string, number> } {
    const points: Record<string, number> = {};
    const negatif: Record<string, number> = {};
    for (const m of this.moves) {
      if (m.scores === undefined) continue;
      for (const [nom, sc] of Object.entries(m.scores)) {
        points[nom] = (points[nom] ?? 0) + sc;
        negatif[nom] = (negatif[nom] ?? 0) + (m.score - sc);
      }
    }
    return { points, negatif };
  }

  /** Nombre de "j'aime" recus par un joueur sur l'ensemble de la partie. */
  likesOf(player: string): number {
    let n = 0;
    for (const m of this.moves) if (m.player === player) n += m.likes?.length ?? 0;
    return n;
  }

  /** Tire le prochain tirage et lance le calcul du top. */
  private async deal(injouables = 0): Promise<void> {
    // Fin de partie (SPEC.md §16) : le sac ne permet plus de composer un tirage
    // jouable. On ne distribue plus, et l'etat diffuse le dit.
    // Nombre de coups atteint : la partie s'arrete la, meme si le sac pourrait
    // continuer. C'est ce qui donne un terme a un duplicate sur grille infinie.
    const assezJoue = this.cfg.coupsMax !== null && this.moves.length >= this.cfg.coupsMax;
    // Meme idee, comptee en temps : la partie s'arrete quand sa duree est
    // ecoulee. Le compte part du premier tirage, pas de la creation du salon.
    const assezDure = this.cfg.dureeMax !== null && this.debutDeLaPartie !== 0
      && Date.now() - this.debutDeLaPartie >= this.cfg.dureeMax * 1000;
    if (assezJoue || assezDure || this.bag.estFinie(this.reliquat)) {
      this.finie = true;
      this.solving = false;
      this.canonicalTop = null;
      // Le tirage DISPARAIT. Le laisser en place laissait taper des mots sur une
      // partie close, sans que rien ne dise qu'elle etait finie. Les caramels
      // qui restent dans le sac ne sont pas piochés : ils ne serviront plus.
      this.rack = "";
      this.rackNotation = "";
      this.bestScore = -1;
      this.isotops = 0;
      this.tiers = [];
      console.log(`[partie] terminee apres ${this.moves.length} coups` +
        (assezJoue ? " (nombre de coups atteint)" : assezDure ? " (duree ecoulee)" : ""));
      this.emit();
      return;
    }
    // Le joker ne repasse pas par le sac : on le retire du reliquat avant de
    // completer, et on le remet ensuite.
    const gardeJoker = this.cfg.joker && this.jokersEnReserve > 0;
    const reliquatSansJoker = gardeJoker
      ? this.reliquat.filter((c) => c !== BLANK)
      : this.reliquat;
    // Nouveau coup : les propositions repartent a zero, et on fige QUI est la.
    this.propositions.clear();
    this.participants = new Set(this.presents);
    const draw = this.bag.draw(reliquatSansJoker);
    this.rack = gardeJoker ? [...draw.rack, BLANK].sort().join("") : draw.rack;
    this.rackNotation = gardeJoker ? `${draw.notation}+${BLANK}` : draw.notation;
    this.bestScore = -1;
    this.canonicalTop = null;
    this.isotops = 0;
    this.tiers = [];
    this.solving = true;
    this.emit();

    const id = this.nextId++;
    const reply: any = await new Promise((res) => {
      this.pending.set(id, res);
      // Autant de paliers ENTIERS que tiennent dans 120 solutions. C'est ce
      // qu'on enregistre sur une grille infinie ; sur un plateau borne on ne
      // les enregistre plus du tout et le rejeu les refait, complets, a la
      // demande. Pas la peine d'en calculer davantage ici.
      this.worker.postMessage({
        t: "solve", id, rack: this.rack, moveNumber: this.moveNumber + 1, tiers: 40,
      });
    });

    this.solving = false;
    if (reply.result === null) {
      // AUCUN COUP POSSIBLE avec ce tirage. On le rend au sac et on retire.
      //
      // Rendre est le point important : les lettres abandonnees restaient
      // dehors, et un sac de 102 n'en comptait plus que 99. Le reliquat aussi
      // repart, puisque le tirage entier est refait.
      //
      // Le compte est BORNE. La retraite etait recursive et sans fin : un sac
      // dont plus rien n'est jouable -- le cas du Y seul en 2 sur 3 -- faisait
      // tourner le serveur jusqu'a l'epuisement de la pile. Au-dela de
      // TIRAGES_INJOUABLES essais, on tient la partie pour terminee : ce n'est
      // pas une panne, c'est une fin de partie, et elle se dit comme telle.
      this.bag.rendre([...this.rack].filter((l) => l !== BLANK || !this.cfg.joker));
      this.reliquat = [];
      if (injouables + 1 >= TIRAGES_INJOUABLES) {
        console.log(`[partie] terminee apres ${this.moves.length} coups ` +
          `(${TIRAGES_INJOUABLES} tirages de suite sans un seul coup jouable)`);
        this.finie = true;
        this.rack = "";
        this.rackNotation = "";
        this.bestScore = -1;
        this.isotops = 0;
        this.tiers = [];
        this.emit();
        return;
      }
      console.warn(`[partie] aucun coup possible avec ${this.rack}, on repioche ` +
        `(${injouables + 1}/${TIRAGES_INJOUABLES})`);
      await this.deal(injouables + 1);
      return;
    }
    this.canonicalTop = reply.result.top;
    this.bestScore = reply.result.bestScore;
    this.isotops = reply.result.isotops;
    this.tiers = reply.result.tiers;
    // Le chrono du coup ne part qu'ICI : le temps de calcul du serveur ne doit
    // jamais etre compte dans le temps de recherche des joueurs (SPEC.md §2).
    this.servedAt = Date.now();
    if (this.debutDeLaPartie === 0) this.debutDeLaPartie = this.servedAt;
    this.decompteJusqua = 0;
    if (!this.lancerLeDecompte()) this.armerLeChrono();
    // Le journal ne dit RIEN du top tant qu'il n'est pas joue : ni son score, ni
    // son mot, ni le nombre d'isotops. Ces valeurs ne partent deja jamais aux
    // clients, mais quelqu'un qui regarde le terminal de l'hote les lirait.
    console.log(
      `[partie] coup ${this.moveNumber + 1} · tirage ${this.rackNotation} · ` +
      `calcule en ${reply.ms.toFixed(0)} ms`,
    );
    this.emit();
  }

  get moveNumber(): number { return this.moves.length; }
  get cumul(): number { return this.moves.reduce((a, m) => a + m.score, 0); }

  /**
   * Ce qui reste dans le sac, lettres triees. Information PUBLIQUE et attendue :
   * au duplicate on suit les lettres restantes pour deviner les tirages a venir.
   * Vide sur une pioche ponderee, ou rien ne s'epuise.
   */
  restantDuSac(): string {
    const r = this.bag.restant();
    let out = "";
    // Les jokers a la FIN : ils ne sont pas des lettres, les voir en tete de
    // ligne brouille la lecture du reliquat.
    for (const lettre of Object.keys(r).sort()) {
      if (lettre !== BLANK) out += lettre.repeat(r[lettre]!);
    }
    if (r[BLANK] !== undefined) out += BLANK.repeat(r[BLANK]);
    return out;
  }

  tiles(): { x: number; y: number; l: string; b: 0 | 1; n: number }[] {
    const out: { x: number; y: number; l: string; b: 0 | 1; n: number }[] = [];
    for (const m of this.moves) {
      for (const p of m.placements) out.push({ x: p.x, y: p.y, l: p.letter, b: p.blank ? 1 : 0, n: m.n });
    }
    return out;
  }

  /** Un joueur propose un mot. Le serveur fait autorite. */
  async attempt(player: string, dir: Dir, x: number, y: number, typed: string): Promise<TryResult> {
    if (this.solving || this.canonicalTop === null) {
      return { ok: false, message: "le coup n'est pas encore prêt" };
    }
    const r = resolveTypedWord(this.board, this.dawg, dir, x, y, typed.toUpperCase(), this.rack);
    if (!r.ok) {
      // Le rappel de la variante vaut mieux qu'un « trop de caramels » sec :
      // le joueur ne sait pas forcement combien il a le droit d'en poser.
      const message = r.error === "TROP_DE_CARAMELS"
        ? `C'est une partie ${this.cfg.jouables} sur ${this.cfg.tirage}`
        : PLAY_MESSAGE[r.error as PlayError];
      return { ok: false, message, word: r.word };
    }
    // EN DUPLICATE, rien ne filtre. On enregistre la meilleure solution du
    // joueur et on lui rend son score, sans jamais dire s'il a trouve le top :
    // le savoir lui apprendrait que sa solution est la bonne, et l'apprendrait
    // aux autres par ricochet. Le coup dure le temps plein (SPEC.md §16).
    if (this.cfg.mode === "duplicate") {
      const avant = this.propositions.get(player);
      if (avant === undefined || r.move.score > avant.score) {
        this.propositions.set(player, {
          score: r.move.score, word: r.move.word,
          dir: r.move.dir, x: r.move.x, y: r.move.y, at: Date.now(),
        });
      }
      const garde = this.propositions.get(player)!;
      return {
        ok: true, message: "", word: r.move.word, score: r.move.score,
        top: false, retenu: garde.score,
      };
    }

    // On retient la meilleure proposition de chacun, meme en topping : c'est
    // elle qui decide du demi-point si personne n'atteint le top.
    const avant = this.propositions.get(player);
    if (avant === undefined || r.move.score > avant.score) {
      this.propositions.set(player, {
        score: r.move.score, word: r.move.word,
        dir: r.move.dir, x: r.move.x, y: r.move.y, at: Date.now(),
      });
    }

    if (r.move.score < this.bestScore) {
      return { ok: true, message: "", word: r.move.word, score: r.move.score, top: false };
    }
    // Score du top atteint : ce joueur remporte le coup. C'est le premier
    // message ARRIVE AU SERVEUR qui gagne -- ici, l'ordre de traitement.
    await this.commit(player, Date.now() - this.servedAt, r.move);
    return { ok: true, message: "top !", word: r.move.word, score: r.move.score, top: true };
  }

  /**
   * Duree d'un coup clos par l'ECHEANCE, et non par un joueur.
   *
   * `setTimeout` promet de ne pas se declencher AVANT le delai, jamais de se
   * declencher exactement dessus : la boucle d'evenements finit ce qu'elle
   * faisait, et rend la main quelques millisecondes plus tard. Mesurer
   * `Date.now() - servedAt` donnait donc 5,00 s le plus souvent, mais 5,01 s
   * quand le reveil avait tarde -- alors que la regle du jeu, elle, dit cinq
   * secondes tout rond.
   *
   * On note donc le temps IMPARTI, qui est la verite du coup.
   */
  private dureeDuCoup(): number {
    return this.cfg.chrono !== null ? this.cfg.chrono * 1000 : Date.now() - this.servedAt;
  }

  /**
   * TOPPING chronometre : l'echeance tombe sans que personne ait trouve.
   *
   * Le top se pose quand meme, et un DEMI-POINT va au joueur qui avait propose
   * la solution la plus rentable — a egalite de score, le plus rapide a l'avoir
   * soumise. Personne n'a « trouve le coup », mais chercher a rapporte.
   */
  private async cloreParDefaut(): Promise<void> {
    if (this.canonicalTop === null) return;
    // Le coup a dure le temps IMPARTI, pas le temps que la minuterie a mis a
    // se reveiller. Voir dureeDuCoup().
    let meilleur: { joueur: string; word: string; score: number; at: number } | null = null;
    for (const [joueur, p] of this.propositions) {
      if (meilleur === null || p.score > meilleur.score
          || (p.score === meilleur.score && p.at < meilleur.at)) {
        meilleur = { joueur, word: p.word, score: p.score, at: p.at };
      }
    }
    await this.commit(null, this.dureeDuCoup(), undefined, undefined,
      meilleur === null ? undefined
        : { joueur: meilleur.joueur, word: meilleur.word, score: meilleur.score });
  }

  /**
   * DUPLICATE : l'echeance tombe, on clot le coup.
   *
   * Le top se pose, chacun marque sa meilleure solution, et ceux qui l'ont
   * trouve sont annonces dans le chat. Personne ne « remporte » le coup : au
   * duplicate on compte des points, pas des coups.
   *
   * Seuls sont notes les joueurs presents AU MOMENT DU TIRAGE. Qui arrive en
   * cours de coup joue, figure dans la liste des trouveurs s'il trouve, mais
   * n'entre au classement qu'au coup suivant.
   */
  private async clore(): Promise<void> {
    if (this.canonicalTop === null) return;
    const scores: Record<string, number> = {};
    const trouveurs: string[] = [];
    for (const [nom, p] of this.propositions) {
      if (p.score >= this.bestScore) trouveurs.push(nom);
      if (this.participants.has(nom)) scores[nom] = p.score;
    }
    // Present au tirage mais rien propose : zero, et le negatif du top entier.
    for (const nom of this.participants) if (scores[nom] === undefined) scores[nom] = 0;
    // Les plus rapides d'abord, c'est ainsi qu'on lit la liste.
    trouveurs.sort((a, b) =>
      (this.propositions.get(a)?.at ?? 0) - (this.propositions.get(b)?.at ?? 0));

    const n = this.moveNumber + 1;
    await this.commit(null, this.dureeDuCoup(), undefined, { scores, trouveurs });
    // Pas de points dans le chat : ils figurent deja au tableau, au journal des
    // coups et sur la grille. Les repeter ici n'ajoute que du bruit.
    this.say("", trouveurs.length === 0
      ? `Coup ${n} : non trouvé`
      : `Coup ${n} : trouvé par ${trouveurs.join(", ")}`);
  }

  /** Pose le top canonique et passe au coup suivant. */
  private async commit(
    player: string | null, ms: number, played?: Move,
    duplicate?: { scores: Record<string, number>; trouveurs: string[] },
    demiPoint?: { joueur: string; word: string; score: number },
  ): Promise<void> {
    const propositions: PlayedMove["propositions"] = {};
    for (const [nom, p] of this.propositions) {
      propositions[nom] = { word: p.word, dir: p.dir, x: p.x, y: p.y, score: p.score };
    }
    // Celui qui remporte le coup en topping n'est pas toujours passe par une
    // proposition enregistree : on l'ajoute depuis le mot qu'il a tape.
    if (player !== null && played !== undefined) {
      propositions[player] = {
        word: played.word, dir: played.dir, x: played.x, y: played.y, score: played.score,
      };
    }
    const top = this.canonicalTop!;
    const move: PlayedMove = {
      n: this.moveNumber + 1,
      rack: this.rack,
      notation: this.rackNotation,
      word: top.word,
      dir: top.dir,
      x: top.x,
      y: top.y,
      score: top.score,
      placements: top.placements,
      player,
      // Ce que le joueur a tape peut differer du mot retenu : le logiciel choisit
      // son isotop canonique, pas celui du joueur (SPEC.md §5).
      playerWord: played?.word,
      playerDir: played?.dir,
      playerX: played?.x,
      playerY: played?.y,
      ms,
      isotops: this.isotops,
      // Les paliers ne sont enregistres QUE sur une grille infinie.
      //
      // Ils representaient 86 % du poids d'un journal -- 3 028 octets par coup
      // contre 415 sans eux. Sur un plateau borne on les refait a la demande en
      // cinq millisecondes ; sur une grille infinie au trois millieme coup il
      // faudrait presque une seconde, et la question ne se pose pas.
      ...(this.cfg.bornes === null ? { tiers: this.tiers as Tier[] } : {}),
      ...(Object.keys(propositions).length > 0 ? { propositions } : {}),
      ...(duplicate ?? {}),
      ...(demiPoint ? { demiPoint } : {}),
    };
    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    this.moves.push(move);
    if (player !== null) this.players[player] = (this.players[player] ?? 0) + 1;
    // Un demi-point vaut la moitie d'un coup trouve : chercher sans atteindre
    // le top rapporte quand meme quelque chose.
    if (demiPoint !== undefined) {
      this.players[demiPoint.joueur] = (this.players[demiPoint.joueur] ?? 0) + 0.5;
    }
    // Le reliquat se calcule sur le tirage TEL QU'IL A ETE DISTRIBUE, avant
    // toute substitution de joker : c'est bien un joker qui a quitte le tirage.
    this.reliquat = Bag.remainder(this.rack, top.placements);
    if (this.cfg.joker) this.substituerJokers(top.placements);
    this.board.place(top.placements);
    this.worker.postMessage({ t: "place", placements: top.placements });
    // Le journal d'abord, force sur le disque : a partir d'ici le coup existe,
    // meme si la machine s'eteint dans la seconde.
    this.append({ t: "coup", move });
    this.save();
    for (const f of this.surCoup) f(move);
    // Ici le coup est joue : tout est devenu public, on peut l'ecrire.
    console.log(
      `[partie] coup ${move.n} remporte par ${player ?? "personne"} : ` +
      `${move.word} ${noteCoup(move.dir, move.x, move.y, this.cfg.bornes)} ${move.score} pts ` +
      `en ${(ms / 1000).toFixed(1)} s` +
      (move.isotops > 1 ? ` (${move.isotops} isotops)` : ""),
    );
    await this.deal();
  }

  /**
   * Le « 3, 2, 1, partez » d'avant-partie, s'il est demande.
   *
   * Il n'arrive qu'UNE fois, au tout premier tirage -- ce n'est pas une pause
   * avant chaque coup. C'est pourquoi il part d'ici, du premier tirage servi,
   * et non de l'armement du chrono : demander a chaque coup « faut-il
   * decompter ? » pour repondre non quatre-vingt-dix-neuf fois sur cent etait
   * une facon detournee de dire une chose qui ne se produit qu'au debut.
   *
   * Pendant qu'il court, le tirage est affiche mais le chrono n'a pas demarre :
   * ces trois secondes ne sont prises sur le temps de personne.
   *
   * Rend vrai s'il a ete lance -- le chrono s'armera alors tout seul a sa fin.
   */
  private lancerLeDecompte(): boolean {
    if (!this.cfg.decompte || this.moves.length > 0 || !this.actif || this.finie) return false;
    this.decompteJusqua = Date.now() + DECOMPTE_MS;
    this.emit();
    setTimeout(() => {
      this.decompteJusqua = 0;
      this.servedAt = Date.now();
      this.armerLeChrono();
      this.emit();
    }, DECOMPTE_MS);
    return true;
  }

  /**
   * Lance la minuterie du coup courant. Sans personne dans le salon, il n'y a
   * rien a chronometrer : le coup attend.
   */
  private armerLeChrono(): void {
    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    if (!this.actif || this.finie) return;

    if (this.cfg.chrono === null) return;
    this.servedAt = Date.now();
    this.echeance = setTimeout(() => {
      this.echeance = null;
      void (this.cfg.mode === "duplicate" ? this.clore() : this.cloreParDefaut());
    }, this.cfg.chrono * 1000);
  }

  /**
   * Quelqu'un entre. On pioche si ce n'est pas encore fait, et le chrono part.
   *
   * Le premier arrivant recoit le temps PLEIN : reprendre un decompte entame
   * pendant que la salle etait vide n'aurait aucun sens.
   */
  async reveiller(): Promise<void> {
    if (this.actif) return;
    this.actif = true;
    if (this.finie || !this.demarree) { this.emit(); return; }
    if (this.canonicalTop === null && !this.solving) {
      await this.deal();
      return;
    }
    this.armerLeChrono();
    this.emit();
  }

  /** Lance la partie : premier tirage, et le chrono si la variante en a un. */
  async demarrer(): Promise<void> {
    if (this.demarree) return;
    this.demarree = true;
    if (this.actif && !this.finie && this.canonicalTop === null && !this.solving) {
      await this.deal();
    } else this.emit();
  }

  /** La salle s'est vidée : le coup en cours gele, rien ne se calcule plus. */
  endormir(): void {
    this.actif = false;
    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    this.emit();
  }

  /** Ajoute un message au chat et le persiste. */
  say(who: string, text: string, cell?: { x: number; y: number }): ChatMessage {
    const msg: ChatMessage = { at: Date.now(), who, text: text.slice(0, 400), ...(cell ? { cell } : {}) };
    this.chat.push(msg);
    this.append({ t: "chat", msg });
    this.save();
    for (const f of this.surChat) f(msg);
    return msg;
  }

/**
   * Partie joker : la lettre jouee par le joker devient une VRAIE lettre.
   *
   * Le joker a compte zero pour le coup qui vient d'etre joue -- c'est deja
   * fait, le score est calcule. Mais ce qui se pose sur la grille est un vrai R
   * sorti du sac, qui vaudra un point pour tous les coups suivants, et le joker
   * revient au tirage.
   *
   * Si le sac n'a plus de R, le joker se pose lui-meme, a zero pour toujours,
   * et la reserve perd une unite. Les deux jokers poses, la partie continue
   * sans (SPEC.md §16).
   */
  private substituerJokers(placements: Placement[]): void {
    const sac = this.bag as SacFini;
    const avecSac = typeof sac.retirer === "function";
    for (const p of placements) {
      if (!p.blank) continue;
      // Avec un sac, la lettre jouee par le joker en sort pour de vrai : elle
      // vaudra ses points pour la suite, et le joker revient au tirage.
      if (avecSac && sac.retirer(p.letter)) {
        p.blank = false;
        console.log(`[partie] le joker joue ${p.letter} : un vrai ${p.letter} sort du sac`);
        continue;
      }
      // Sans sac -- ou sans lettre disponible -- le joker se pose lui-meme, a
      // zero pour toujours. La reserve n'en souffre que si elle est finie.
      this.jokersEnReserve--;
      const reste = this.jokersEnReserve === Infinity ? "on en reprend un"
        : `${this.jokersEnReserve} joker${this.jokersEnReserve > 1 ? "s" : ""} en reserve`;
      console.log(
        `[partie] ${avecSac ? `plus de ${p.letter} dans le sac : ` : ""}` +
        `le joker reste sur la grille (${reste})`,
      );
    }
  }

  /** Revele le top sans vainqueur. Commodite de test en solo. */
  /**
   * Les paliers d'un coup deja joue, recalcules si le journal ne les a pas.
   *
   * C'est le cas des plateaux bornes, ou on ne les enregistre plus. La grille
   * se reconstruit a partir des coups qui precedent, ce qui est immediat sur un
   * plateau de quinze cases de cote.
   */
  async paliersDuCoup(n: number): Promise<Tier[]> {
    const m = this.moves.find((q) => q.n === n);
    if (m === undefined) return [];
    if (m.tiers !== undefined && m.tiers.length > 0) return m.tiers;
    const avant: Placement[] = [];
    for (const q of this.moves) {
      if (q.n >= n) break;
      avant.push(...q.placements);
    }
    const id = this.nextId++;
    const reply: any = await new Promise((res) => {
      this.pending.set(id, res);
      this.worker.postMessage({ t: "paliers", id, rack: m.rack, avant });
    });
    return (reply.tiers ?? []) as Tier[];
  }

  async reveal(): Promise<void> {
    if (this.solving || this.canonicalTop === null) return;
    await this.commit(null, Date.now() - this.servedAt);
  }

  private save(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    // Filet de secours : tous les VINGT coups on garde une copie de la partie
    // telle qu'elle etait. Une partie qui dure des mois sur un PC de maison ne
    // doit pas tenir a un seul fichier -- une fausse manoeuvre, un disque qui
    // tousse, et des centaines de coups joues a plusieurs disparaissent.
    if (this.moves.length > 0 && this.moves.length % 20 === 0 && existsSync(this.file)) {
      try {
        copyFileSync(this.file, this.file.replace(/\.json$/, ".secours.json"));
      } catch {
        // Un secours qui echoue ne doit pas empecher la sauvegarde principale.
      }
    }
    const data: Saved = {
      gameId: this.gameId, layout: this.layout, seed: this.seed,
      config: serialiser(this.cfg),
      createdAt: this.createdAt,
      moves: this.moves, players: this.players, chat: this.chat,
    };
    // Ecriture atomique : une coupure de courant ne doit pas laisser un fichier
    // a moitie ecrit, qui rendrait la partie irrecuperable.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, this.file);
  }
}
