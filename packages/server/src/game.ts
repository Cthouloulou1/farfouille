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
import { setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { mulberry32, moveSeed } from "../../engine/src/rng.ts";
import { resolveTypedWord, PLAY_MESSAGE, type PlayError } from "../../engine/src/play.ts";
import { formatMove, type Dir } from "../../engine/src/coords.ts";
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
  /** Instant de creation de la grille, pour l'age de la partie. */
  createdAt: number;
  moves: PlayedMove[];
  players: Record<string, number>;
  chat: ChatMessage[];
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

/** Ce processus existe-t-il encore ? EPERM veut dire oui, mais pas a nous. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export class Game {
  readonly gameId: string;
  readonly layout: LayoutName;
  private readonly dawg: Dict;
  private readonly board: Board;
  private bag!: Bag;
  /** Cree dans start(), une fois la graine connue. */
  private worker!: Worker;
  private readonly file: string;
  private readonly journal: string;
  private readonly lockFile: string;
  private holdsLock = false;
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
  solving = false;

  private nextId = 1;
  private pending = new Map<number, (r: any) => void>();
  private listeners: (() => void)[] = [];

  constructor(gameId: string, layout: LayoutName) {
    this.gameId = gameId;
    this.layout = layout;
    setLayout(layout);
    this.dawg = loadDict(DAWG_PATH);
    this.board = new Board(this.dawg);
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
      let held: { pid?: number; since?: number } = {};
      try { held = JSON.parse(readFileSync(this.lockFile, "utf8")); } catch { /* verrou illisible */ }
      const pid = held.pid;
      if (pid !== undefined && pid !== process.pid && alive(pid)) {
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
        console.log(`[partie] verrou perime du processus ${pid} (arret brutal), on le reprend`);
      }
    }
    const fd = openSync(this.lockFile, "w");
    writeSync(fd, JSON.stringify({ pid: process.pid, since: Date.now() }));
    closeSync(fd);
    this.holdsLock = true;
  }

  /** Rend le verrou. Sans effet s'il ne nous appartient pas. */
  releaseLock(): void {
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

  onChange(fn: () => void): void { this.listeners.push(fn); }
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
        seed: this.seed, createdAt: this.createdAt,
      });
      // Migration : une partie qui n'avait qu'un instantane se voit dotee d'un
      // journal complet, retroactivement.
      if (saved !== null) {
        for (const m of saved.moves) this.append({ t: "coup", move: m });
        for (const c of this.chat) this.append({ t: "chat", msg: c });
        console.log(`[partie] journal cree a partir de l'instantane`);
      }
    }
    this.bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed(this.seed, 0)));

    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { layout: this.layout, seed: this.seed },
    });
    this.worker.on("message", (m: any) => {
      if (m.t !== "solved") return;
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
    await this.deal();
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

  /** Nombre de "j'aime" recus par un joueur sur l'ensemble de la partie. */
  likesOf(player: string): number {
    let n = 0;
    for (const m of this.moves) if (m.player === player) n += m.likes?.length ?? 0;
    return n;
  }

  /** Tire le prochain tirage et lance le calcul du top. */
  private async deal(): Promise<void> {
    const draw = this.bag.draw(this.reliquat);
    this.rack = draw.rack;
    this.rackNotation = draw.notation;
    this.bestScore = -1;
    this.canonicalTop = null;
    this.isotops = 0;
    this.tiers = [];
    this.solving = true;
    this.emit();

    const id = this.nextId++;
    const reply: any = await new Promise((res) => {
      this.pending.set(id, res);
      // Autant de paliers ENTIERS que tiennent dans 120 solutions -- le meme
      // reglage que le visualiseur, pour que l'inspection montre la meme chose.
      this.worker.postMessage({
        t: "solve", id, rack: this.rack, moveNumber: this.moveNumber + 1, tiers: 40,
      });
    });

    this.solving = false;
    if (reply.result === null) {
      console.warn(`[partie] aucun coup possible avec ${this.rack}, on repioche`);
      this.reliquat = [];
      await this.deal();
      return;
    }
    this.canonicalTop = reply.result.top;
    this.bestScore = reply.result.bestScore;
    this.isotops = reply.result.isotops;
    this.tiers = reply.result.tiers;
    // Le chrono du coup ne part qu'ICI : le temps de calcul du serveur ne doit
    // jamais etre compte dans le temps de recherche des joueurs (SPEC.md §2).
    this.servedAt = Date.now();
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
      return { ok: false, message: PLAY_MESSAGE[r.error as PlayError], word: r.word };
    }
    if (r.move.score < this.bestScore) {
      return { ok: true, message: "", word: r.move.word, score: r.move.score, top: false };
    }
    // Score du top atteint : ce joueur remporte le coup. C'est le premier
    // message ARRIVE AU SERVEUR qui gagne -- ici, l'ordre de traitement.
    await this.commit(player, Date.now() - this.servedAt, r.move);
    return { ok: true, message: "top !", word: r.move.word, score: r.move.score, top: true };
  }

  /** Pose le top canonique et passe au coup suivant. */
  private async commit(player: string | null, ms: number, played?: Move): Promise<void> {
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
      tiers: this.tiers as Tier[],
    };
    this.moves.push(move);
    if (player !== null) this.players[player] = (this.players[player] ?? 0) + 1;
    this.board.place(top.placements);
    this.worker.postMessage({ t: "place", placements: top.placements });
    this.reliquat = Bag.remainder(this.rack, top.placements);
    // Le journal d'abord, force sur le disque : a partir d'ici le coup existe,
    // meme si la machine s'eteint dans la seconde.
    this.append({ t: "coup", move });
    this.save();
    // Ici le coup est joue : tout est devenu public, on peut l'ecrire.
    console.log(
      `[partie] coup ${move.n} remporte par ${player ?? "personne"} : ` +
      `${move.word} ${formatMove(move.dir, move.x, move.y)} ${move.score} pts ` +
      `en ${(ms / 1000).toFixed(1)} s` +
      (move.isotops > 1 ? ` (${move.isotops} isotops)` : ""),
    );
    await this.deal();
  }

  /** Ajoute un message au chat et le persiste. */
  say(who: string, text: string, cell?: { x: number; y: number }): ChatMessage {
    const msg: ChatMessage = { at: Date.now(), who, text: text.slice(0, 400), ...(cell ? { cell } : {}) };
    this.chat.push(msg);
    this.append({ t: "chat", msg });
    this.save();
    return msg;
  }

  /** Revele le top sans vainqueur. Commodite de test en solo. */
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
