/**
 * Les records du site. Voir SPEC.md §23.
 *
 * UN RECORD DIT UNE CHOSE : cette partie a ete entierement topee, et voila en
 * combien de temps. Tout le reste -- les categories, les axes, les tableaux
 * annexes -- n'est que la facon de comparer ce qui est comparable.
 *
 * DEUX MOITIES, ET ELLES NE SE RESSEMBLENT PAS.
 *
 * L'OBSERVATION vit dans le salon, en memoire, du premier coup au dernier. Elle
 * regarde qui est present et qui soumet -- ce que le journal de la partie ne
 * dit pas et ne dira pas : en topping il n'ecrit que le gagnant du coup, et un
 * coup rate n'y ecrit personne. Une table de six joueurs qui cherchent et six
 * onglets restes ouverts y laissent la meme trace.
 *
 * Le prix de ce choix : un serveur qui redemarre en cours de partie perd son
 * observation, et la partie cesse d'etre eligible. C'est faible -- une partie
 * normale dure une vingtaine de coups -- et cela evite d'ajouter deux champs a
 * chaque coup de chaque partie pour un cas qui ne concerne que les parties
 * bornees et terminees.
 *
 * LE JOURNAL, lui, est la moitie durable : une ligne par manche valide, en
 * ajout seul, `fsync` a chaque ligne, jamais reecrit -- la meme discipline que
 * les parties, les salons et les comptes. Tous les classements s'en derivent en
 * memoire au demarrage.
 *
 * AUCUN TABLEAU N'OUVRE UN FICHIER DE PARTIE. La ligne porte tout ce qui
 * s'affiche ; les fichiers de partie ne servent qu'au rejeu. C'est ce qui
 * permet a un record de rester lisible meme si sa partie a disparu du disque :
 * on perd le rejeu, pas le record.
 */
import {
  mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Game, PlayedMove, RaisonDeFin } from "./game.ts";
import { compte } from "./comptes.ts";
import {
  categorie, categorieDesReglages, completeAuNegatif, grilleDeBornes,
  type Categorie, type Grille,
} from "../../engine/src/categories.ts";
import { dawgPath } from "../../engine/src/paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const JOURNAL = join(DATA_DIR, "records.journal.jsonl");

/**
 * Ce qu'un coup laisse a l'observation.
 *
 * Le mot ET SES ISOTOPS, parce qu'un coup rate rate tous ses isotops : le mot
 * retenu par le logiciel est tire au sort parmi les coups au meilleur score
 * (§5), et le mettre seul au tableau des rates serait un accident de tirage au
 * sort. Le premier de la liste est celui qui a ete pose.
 */
export interface CoupObserve {
  n: number;
  mots: string[];
  score: number;
  /** Millisecondes de recherche. */
  ms: number;
  /** Qui a trouve le top, ou `null` si personne. */
  par: string | null;
  /**
   * Quelqu'un a-t-il soumis un mot sur CE coup ?
   *
   * Pas dans la partie : sur le coup. Un joueur qui ne trouve pas le top ne
   * reste pas les bras croises, il joue autre chose ; ne rien soumettre du tout,
   * c'est ne pas etre la. C'est le seul filtre qui distingue un mot vraiment
   * difficile d'un mot que personne ne regardait.
   */
  actif: boolean;
  /** Caramels poses : c'est lui qui dit si le coup est une farfouille. */
  poses: number;
  /** L'ecart au top, quand personne ne l'a trouve. Zero sinon. */
  negatif: number;
}

/** Une etape de montante, telle que la ligne de la montante la porte. */
export interface EtapeDeMontante {
  /** Le rang de l'etape, de 1 a 6. */
  rang: number;
  /** La reference de la manche de cette etape : c'est par elle qu'on la relit. */
  ref: string;
  /** Sa categorie, donc son format : « 7 sur 8 », « 7 et 8 joker »... */
  categorie: string;
  coups: number;
  temps: number;
  negatif: number;
  topee: boolean;
  /** Combien de fois cette etape a ete reprise avant celle-ci. */
  essai: number;
}

/** Une manche : une partie valide, jouee, terminee. */
export interface Manche {
  /**
   * LA REFERENCE PUBLIQUE DE LA MANCHE, ET SON IDENTITE.
   *
   * Une manche s'identifiait par le nom de son salon, qui est aussi le nom de
   * son fichier. Deux parties enregistrees au meme endroit portaient donc la
   * meme identite : « Revoir » ouvrait la premiere des deux, et invalider l'une
   * invalidait l'autre. Cela se voyait peu -- il faut jouer deux parties
   * completes dans le meme salon -- et une montante en joue six d'affilee.
   *
   * La graine, elle, est unique et ne change jamais, mais ELLE NE SORT PAS :
   * elle dirait comment refaire les tirages. La reference est donc douze
   * caracteres de son empreinte -- unique, stable, publique, et qui ne dit rien
   * de la graine.
   *
   * Les lignes deja ecrites n'en portent pas : elle se recalcule a la
   * relecture, depuis la graine (voir `refDeLaGraine`).
   */
  ref: string;
  /**
   * Le salon ou elle s'est jouee, qui est aussi le nom de son fichier AU
   * MOMENT DE L'ENREGISTREMENT. Une relance l'archive sous un nom horodate,
   * d'ou la graine, qui l'identifie a coup sur (voir `graine`).
   */
  partie: string;
  /**
   * La graine de la partie, pour retrouver son journal apres archivage.
   *
   * NE SORT JAMAIS VERS LES CLIENTS. La partie est finie, ses coups sont tous
   * publics, mais rien n'oblige a publier de quoi rejouer ses tirages.
   */
  graine: string;
  at: number;
  categorie: string;
  grille: Grille;
  lexique: string;
  /** Empreinte du lexique compile : deux listes de mots differentes se voient. */
  empreinte: string;
  chrono: number | null;
  coups: number;
  /** Somme des coups, en millisecondes. C'est le temps du bandeau (§16). */
  temps: number;
  cumul: number;
  farfouilles: number;
  topee: boolean;
  negatif: number;
  /**
   * Ceux qui ont trouve au moins un top, du plus gros compte de tops au plus
   * petit. `invite` dit que ce nom n'est adosse a aucun compte.
   *
   * UN INVITE EST NOMME, ET DIT COMME TEL. Un pseudo nu est reprenable par
   * n'importe qui : un record signe d'un pseudo n'est attribuable a personne.
   * Le taire ne rendrait service a personne pour autant -- c'est bien quelqu'un
   * qui a joue, et une ligne sans nom ne se lit pas. C'est la mention qui porte
   * la garantie, pas le nom.
   */
  joueurs: { nom: string; tops: number; invite: boolean }[];
  /** L'unique joueur a avoir trouve tous les tops, ou `null`. */
  solo: string | null;
  /**
   * Le coup le plus cher et le moins cher de la partie.
   *
   * LA MANCHE NE GARDE PLUS SES COUPS UN A UN. Elle en portait la liste
   * entiere -- mot, isotops, score, temps, trouveur -- soit 97 octets par coup
   * et 1 851 sur 2 235 pour une partie de dix-neuf coups. C'etait garder de
   * quoi RECONSTITUER la partie dans un fichier qui n'est pas fait pour ca : le
   * journal de la partie le fait deja, et mieux.
   *
   * Les mots, eux, vivent maintenant dans un compteur tenu au fil des coups
   * (voir `CompteurDeMot`). Il ne restait donc que ces deux coups-la, dont deux
   * tableaux annexes ont besoin.
   */
  coupCher: CoupNote | null;
  coupPasCher: CoupNote | null;
  /**
   * Les six etapes, sur la ligne d'une montante, et rien ailleurs.
   *
   * UNE MONTANTE N'A PAS UN JOURNAL, ELLE EN A SIX. Sa ligne porte donc de quoi
   * les retrouver et les resumer, plutot que d'aller le chercher dans les
   * manches des etapes -- qui peuvent avoir ete invalidees separement, et qui
   * ne sont de toute facon pas ce qu'une ligne de record va lire (voir l'entete
   * de ce fichier).
   */
  etapes?: EtapeDeMontante[];
}

/** Un coup retenu pour lui-meme : son mot, ses points, qui l'a trouve. */
export interface CoupNote {
  mot: string;
  score: number;
  par: string | null;
}
/**
 * Ce qu'un mot a fait, en tout et pour tout.
 *
 * UN COUP COMPTE UNE FOIS, quoi qu'il arrive. Six joueurs qui ratent le meme
 * top ne font pas six rates ; six joueurs qui le trouvent en duplicate ne font
 * pas six trouvailles ; et un top trouve par un seul alors que cinq l'ont rate
 * compte comme TROUVE. C'est le coup qu'on compte, pas les joueurs.
 */
export interface CompteurDeMot {
  trouves: number;
  rates: number;
}

/**
 * Ce qu'une partie ajoute aux compteurs. Une ligne au journal, par partie.
 *
 * ELLE NE PERMET PAS DE RECONSTITUER LA PARTIE, et c'est voulu : seules les
 * parties terminees se gardent, et leur journal a elles fait deja ce travail.
 * Ici il n'y a que des mots et un sens -- trouve ou rate.
 *
 * Une partie ABANDONNEE n'ecrit que cela. Une table qui rate un top relance
 * aussitot : c'est le geste le plus courant du jeu, et le mot qui vient
 * d'echapper a tout le monde est justement celui qui interesse le tableau.
 */
export interface DeltaDeMots {
  lexique: string;
  at: number;
  /** Un mot par coup gagne, isotops compris. Les repetitions comptent. */
  trouves: string[];
  rates: string[];
}

/** Ce que le journal des records peut porter. */
type Evenement =
  | ({ t: "manche" } & Manche)
  | ({ t: "mots" } & DeltaDeMots)
  | {
    t: "invalide";
    /** La manche visee. Les lignes d'avant les references portaient `partie`. */
    ref: string;
    partie: string;
    par: string;
    raison: string;
    at: number;
  };

// ------------------------------------------------------------- l'empreinte

const empreintes = new Map<string, string>();

/**
 * Une empreinte courte du lexique compile.
 *
 * Le nom du lexique ne suffit pas : le jour ou la liste de mots est corrigee,
 * « ODS 9 » designe deux choses. Huit caracteres du condense du fichier compile
 * suffisent a les distinguer, et se calculent une fois par lexique et par
 * demarrage.
 */
export function empreinteDuLexique(id: string): string {
  const connue = empreintes.get(id);
  if (connue !== undefined) return connue;
  let e = "inconnue";
  try {
    e = createHash("sha256").update(readFileSync(dawgPath(id))).digest("hex").slice(0, 8);
  } catch { /* un lexique qu'on ne sait pas lire n'empeche pas de jouer */ }
  empreintes.set(id, e);
  return e;
}

/**
 * La reference publique d'une manche, tiree de sa graine.
 *
 * Douze caracteres suffisent : le journal comptera des dizaines de milliers de
 * lignes, pas des milliards, et une collision sur douze caracteres d'un
 * condense en demanderait bien davantage.
 *
 * ELLE NE DIT RIEN DE LA GRAINE, ce qui est tout l'objet : la graine dirait
 * comment refaire les tirages d'une partie, et ne sort donc jamais.
 */
export function refDeLaGraine(graine: string): string {
  return createHash("sha256").update(`manche:${graine}`).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------- le journal

let manches: Manche[] = [];
const invalidees = new Set<string>();
let ouvert = false;

/**
 * LE TABLEAU DES MOTS, TENU AU FIL DES COUPS.
 *
 * Il se lisait jusqu'ici en reparcourant le detail de toutes les manches a
 * chaque affichage : dix millions de mots a visiter par requete au bout d'une
 * annee de jeu, pour un resultat qui ne change qu'a la fin d'une partie. Un
 * compteur qu'on incremente coute une addition par coup et se lit sans rien
 * recalculer.
 *
 * Un lexique par entree : deux lexiques n'ont pas les memes mots, et les
 * melanger ferait un tableau qui ne veut rien dire.
 */
const mots = new Map<string, Map<string, CompteurDeMot>>();

function compteurs(lexique: string): Map<string, CompteurDeMot> {
  let t = mots.get(lexique);
  if (t === undefined) { t = new Map(); mots.set(lexique, t); }
  return t;
}

/** Ajoute un mot au compteur du lexique. */
function compter(lexique: string, mot: string, trouve: boolean): void {
  const t = compteurs(lexique);
  let e = t.get(mot);
  if (e === undefined) { e = { trouves: 0, rates: 0 }; t.set(mot, e); }
  if (trouve) e.trouves++; else e.rates++;
}

function appliquer(d: DeltaDeMots): void {
  for (const m of d.trouves) compter(d.lexique, m, true);
  for (const m of d.rates) compter(d.lexique, m, false);
}

function inscrire(ev: Evenement): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const fd = openSync(JOURNAL, "a");
  try {
    writeSync(fd, JSON.stringify(ev) + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Relit le journal des records. A appeler une fois, au demarrage.
 *
 * Les lignes illisibles sont ignorees avec un avertissement : une ligne perdue
 * ne condamne pas les precedentes, comme au journal d'une partie.
 */
export function ouvrirLesRecords(): void {
  manches = [];
  mots.clear();
  invalidees.clear();
  ouvert = true;
  if (!existsSync(JOURNAL)) {
    console.log("[records] aucun record enregistre");
    return;
  }
  let cassees = 0;
  let deltas = 0;
  for (const ligne of readFileSync(JOURNAL, "utf8").split("\n")) {
    if (ligne.trim() === "") continue;
    let ev: any;
    try { ev = JSON.parse(ligne) as Evenement; } catch { cassees++; continue; }
    if (ev.t === "manche") {
      // UNE LIGNE D'AVANT LES REFERENCES N'EN PORTE PAS. Elle se recalcule ici,
      // depuis la graine que la ligne porte : le journal n'est pas reecrit.
      const m = ev as Manche;
      if (typeof m.ref !== "string" || m.ref === "") m.ref = refDeLaGraine(m.graine);
      manches.push(m);
      // UN JOURNAL D'AVANT LES COMPTEURS porte le detail de ses coups. On le
      // lit pour ne rien perdre, et on n'en ecrit plus de pareil.
      if (Array.isArray(ev.vus)) { deltas++; appliquer(deltaDAncienneManche(ev)); }
    } else if (ev.t === "mots") {
      deltas++;
      appliquer(ev as DeltaDeMots);
    } else if (ev.t === "releve") {
      // Meme chose pour les releves d'avant : leurs coups deviennent des mots.
      deltas++;
      appliquer(deltaDAncienneManche(ev));
    } else if (ev.t === "invalide") {
      invalidees.add(ev.ref ?? ev.partie);
    }
  }
  if (cassees > 0) console.warn(`[records] ${cassees} ligne(s) illisible(s), ignorees`);
  const total = [...mots.values()].reduce((a, t) => a + t.size, 0);
  console.log(`[records] ${manches.length} manche(s) relues, ${deltas} lot(s) de mots, `
    + `${total} mot(s) au compteur, ${invalidees.size} invalidee(s)`);
}

/**
 * Le delta d'un enregistrement d'AVANT les compteurs, qui portait ses coups.
 *
 * Les nouveaux n'en ont plus ; celui-ci ne sert qu'a relire ce qui a deja ete
 * ecrit, et disparaitra avec la remise a zero du lancement.
 */
function deltaDAncienneManche(ev: { lexique?: string; vus?: unknown }): DeltaDeMots {
  const d: DeltaDeMots = { lexique: ev.lexique ?? "ods9", at: 0, trouves: [], rates: [] };
  for (const c of (ev.vus ?? []) as CoupObserve[]) {
    if (!c.actif) continue;
    for (const m of c.mots) (c.par !== null ? d.trouves : d.rates).push(m);
  }
  return d;
}

/**
 * La manche d'une partie, invalidee ou non.
 *
 * C'EST LA CLE DU REJEU, et sa garde : le lecteur ne sert que les parties
 * citees ici. Servir un journal quelconque par son nom donnerait le moyen de
 * lire une partie EN COURS, donc le top que tout le monde cherche.
 *
 * Une manche invalidee reste lisible : la partie a bien ete jouee, on lui a
 * seulement retire son rang.
 */
export function mancheDe(ref: string): Manche | undefined {
  return manches.find((m) => m.ref === ref);
}

/** Les manches qui comptent : tout ce qui n'a pas ete invalide. */
export function manchesValides(): Manche[] {
  return manches.filter((m) => !invalidees.has(m.ref));
}

/**
 * Retire une manche des tableaux, sans l'effacer.
 *
 * ON N'EFFACE PAS UNE LIGNE D'UN FICHIER EN AJOUT SEUL : l'invalidation est
 * elle-meme un evenement, et le journal garde la trace de ce qui a ete retire,
 * par qui et pourquoi.
 */
export function invaliderLaManche(ref: string, par: string, raison: string): boolean {
  const m = manches.find((x) => x.ref === ref);
  if (m === undefined) return false;
  if (invalidees.has(ref)) return true;
  invalidees.add(ref);
  inscrire({ t: "invalide", ref, partie: m.partie, par, raison, at: Date.now() });
  console.log(`[records] manche ${ref} ("${m.partie}") invalidee par ${par} : ${raison}`);
  return true;
}

/** Met le journal des records de cote. Il repart vide. Rien n'est efface. */
export function remettreLesRecordsAZero(): string | null {
  if (!existsSync(JOURNAL)) { manches = []; mots.clear(); invalidees.clear(); return null; }
  const archive = join(DATA_DIR, `records.${Date.now()}.journal.jsonl`);
  renameSync(JOURNAL, archive);
  manches = [];
  mots.clear();
  invalidees.clear();
  return archive;
}

/**
 * CE QU'UNE PARTIE LAISSE A LA MONTANTE QUI L'A LANCEE.
 *
 * C'est l'observation, resumee, et lisible A TOUT MOMENT : la montante affiche
 * ses cumuls pendant qu'on joue, et ne peut donc pas attendre la fin de
 * l'etape pour les connaitre. Les mots n'y sont pas -- ils vivent dans leur
 * compteur, et une montante n'en fait rien.
 *
 * Rien ici ne suppose que la partie soit terminee ni recevable : `valide` le
 * dit, et c'est la montante qui en tire les consequences.
 */
export interface EtapeObservee {
  /** Le salon, et la graine, pour retrouver le journal de cette etape. */
  partie: string;
  graine: string;
  /** La reference de sa manche, si elle en ecrit une. */
  ref: string;
  /** Sa categorie, donc son format, ou `null` si aucun tableau ne l'accueille. */
  categorie: string | null;
  coups: number;
  /** Somme des coups, en millisecondes. */
  temps: number;
  cumul: number;
  farfouilles: number;
  /** L'ecart au top cumule sur les coups que personne n'a trouves. */
  negatif: number;
  /** Combien de coups personne n'a trouves. */
  rates: number;
  /**
   * Le DERNIER coup joue a-t-il ete rate ?
   *
   * C'est ce qui decide de la fenetre du bouton de reprise : un rate au dernier
   * coup clot l'etape sur-le-champ, et le bouton doit alors paraitre dans
   * l'etape suivante (SPEC.md §23).
   */
  rateAuDernierCoup: boolean;
  /** Combien de tops chacun a trouves. */
  tops: Record<string, number>;
  /** Quelqu'un a-t-il joue au moins un coup de cette etape ? */
  joue: boolean;
  /**
   * Cette etape compte-t-elle pour la montante ?
   *
   * Il faut tout : une observation complete depuis le premier coup, une
   * categorie, une partie allee au bout de son sac, et quelqu'un pour la jouer.
   * Une seule qui manque, et la montante ne portera pas de record -- elle se
   * joue quand meme jusqu'a la sixieme etape.
   */
  valide: boolean;
  coupCher: CoupNote | null;
  coupPasCher: CoupNote | null;
}

/** Ce qu'un salon peut demander a l'observation de sa partie. */
export interface Lecture {
  /** L'etape telle qu'elle se presente en cet instant. */
  etape(): EtapeObservee;
}

// ------------------------------------------------------------ l'observation

/**
 * Ce qu'un salon retient de sa partie en cours.
 *
 * Vit et meurt avec la partie. Rien n'en sort avant la fin : c'est a ce
 * moment-la, et a ce moment-la seulement, qu'une ligne part au journal.
 */
class Observation {
  private readonly vus: CoupObserve[] = [];
  private readonly partie: Game;
  /**
   * La categorie de la partie, ou `null` si aucun tableau ne l'accueille.
   *
   * UNE PARTIE HORS CATEGORIE S'OBSERVE QUAND MEME, DEPUIS LA MONTANTE. Elle
   * n'ecrit ni manche ni mot -- le compteur de mots ne regarde que la ou le
   * journal des records regarde (SPEC.md §13) -- mais une montante veut savoir
   * ce que son etape a fait, ne serait-ce que pour afficher ses cumuls et pour
   * cesser de pretendre a un record.
   */
  private readonly categorie: Categorie | null;
  /** L'observation est complete depuis le premier coup. */
  private entiere: boolean;
  /**
   * Ce que cette partie ajoutera aux compteurs de mots.
   *
   * Les compteurs, eux, sont deja a jour : ils s'incrementent au coup, comme
   * Zulu l'a demande. Ceci n'est que la trace a ecrire au journal, pour qu'un
   * redemarrage les retrouve.
   */
  private readonly delta: DeltaDeMots;

  constructor(partie: Game, categorie: Categorie | null) {
    this.partie = partie;
    this.categorie = categorie;
    this.delta = {
      lexique: partie.cfg.dictionnaire, at: Date.now(), trouves: [], rates: [],
    };
    // UN SERVEUR QUI REDEMARRE EN COURS DE PARTIE PERD SON OBSERVATION.
    // La partie cesse alors d'etre eligible plutot que d'entrer au tableau
    // avec des coups dont personne ne sait s'ils ont ete cherches.
    //
    // Les COUPS, eux, comptent quand meme : ceux qu'on a vus, on les a bien
    // vus, et un mot rate sous les yeux d'un joueur reste un mot rate.
    this.entiere = partie.moves.length === 0;
  }

  /** Ce que cette partie a ajoute aux compteurs, ou `null` si rien. */
  mots(): DeltaDeMots | null {
    return this.delta.trouves.length + this.delta.rates.length > 0 ? this.delta : null;
  }

  /** Un coup vient de se clore. Le salon a vu ce qu'il fallait voir. */
  coup(m: PlayedMove): void {
    // Les isotops se lisent AVANT le tirage suivant, qui les remet a zero. Le
    // mot pose vient en tete : c'est celui que la feuille de route montre.
    const isotops = this.partie.isotopsDuCoup;
    const mots = [m.word, ...isotops.filter((w) => w !== m.word)];
    // Le negatif d'un coup rate : l'ecart entre le top et la meilleure
    // solution proposee, ou le score entier du top si personne n'a rien
    // propose. Un coup trouve n'a pas de negatif.
    const negatif = m.player !== null ? 0 : m.score - (m.demiPoint?.score ?? 0);
    const actif = this.partie.actifsDuCoup.length > 0;
    this.vus.push({
      n: m.n,
      mots,
      score: m.score,
      ms: Math.max(0, m.ms),
      par: m.player,
      actif,
      poses: m.placements.length,
      negatif,
    });
    // LE COMPTEUR SE MET A JOUR ICI, au coup, et pas a la lecture du tableau.
    //
    // Un coup que personne n'a cherche ne compte pas : c'est le seul filtre qui
    // distingue un mot vraiment difficile d'un mot que personne ne regardait.
    // Et un coup compte UNE FOIS, quel que soit le nombre de joueurs -- six
    // joueurs qui ratent le meme top ne font pas six rates.
    // NI COMPTEUR NI DELTA POUR UNE PARTIE HORS CATEGORIE. Les coups, eux, sont
    // deja retenus au-dessus : la montante les lui demandera.
    if (this.categorie === null) return;
    if (!actif) return;
    const trouve = m.player !== null;
    for (const mot of mots) {
      compter(this.delta.lexique, mot, trouve);
      (trouve ? this.delta.trouves : this.delta.rates).push(mot);
    }
  }

  /**
   * L'etape telle qu'elle se presente MAINTENANT, finie ou non.
   *
   * `raison` n'est connue qu'a la fin ; sans elle, l'etape ne peut pas etre
   * valide -- une partie en cours n'est pas allee au bout de son sac.
   */
  etape(raison?: RaisonDeFin): EtapeObservee {
    const tops: Record<string, number> = {};
    for (const c of this.vus) {
      if (c.par === null) continue;
      tops[c.par] = (tops[c.par] ?? 0) + 1;
    }
    const dernier = this.vus[this.vus.length - 1];
    const trouves = this.vus.filter((c) => c.par !== null)
      .sort((a, b) => b.score - a.score);
    const note = (c: CoupObserve | undefined): CoupNote | null =>
      c === undefined ? null : { mot: c.mots[0] ?? "", score: c.score, par: c.par };
    // Le meme jugement que `manche`, aux memes conditions : c'est la meme
    // question, posee par la montante au lieu du journal.
    const complete = raison === "sac" || raison === "injouable";
    return {
      partie: this.partie.gameId,
      graine: this.partie.seed,
      ref: refDeLaGraine(this.partie.seed),
      categorie: this.categorie?.id ?? null,
      coups: this.vus.length,
      temps: this.vus.reduce((a, c) => a + c.ms, 0),
      cumul: this.vus.reduce((a, c) => a + c.score, 0),
      farfouilles: this.vus.filter((c) => c.poses >= this.partie.cfg.jouables).length,
      negatif: this.vus.reduce((a, c) => a + c.negatif, 0),
      rates: this.vus.filter((c) => c.par === null).length,
      rateAuDernierCoup: dernier !== undefined && dernier.par === null,
      tops,
      joue: this.vus.some((c) => c.actif),
      valide: this.entiere && this.categorie !== null && complete
        && this.vus.length > 0 && this.vus.some((c) => c.actif),
      coupCher: note(trouves[0]),
      coupPasCher: note(trouves[trouves.length - 1]),
    };
  }

  /** La partie s'arrete. Rend la manche a enregistrer, ou `null`. */
  manche(raison: RaisonDeFin): Manche | null {
    if (this.categorie === null) return null;
    if (!this.entiere) {
      console.log(`[records] "${this.partie.gameId}" ecartee : observation incomplete`);
      return null;
    }
    // Une partie tronquee ne se compare pas a des parties entieres. Seul le sac
    // qui s'epuise -- ou qui ne donne plus rien de jouable -- fait une partie
    // complete.
    if (raison !== "sac" && raison !== "injouable") return null;
    if (this.vus.length === 0) return null;
    // AU MOINS UN JOUEUR ACTIF. Un onglet reste ouvert fait defiler une partie
    // chronometree tout seul, et ce n'est pas une partie jouee.
    if (!this.vus.some((c) => c.actif)) {
      console.log(`[records] "${this.partie.gameId}" ecartee : personne n'a joue`);
      return null;
    }
    const grille = grilleDeBornes(this.partie.cfg.bornes);
    if (grille === null) return null;

    const tops = new Map<string, number>();
    for (const c of this.vus) {
      if (c.par === null) continue;
      tops.set(c.par, (tops.get(c.par) ?? 0) + 1);
    }
    const topee = this.vus.every((c) => c.par !== null);
    // SOLO VEUT DIRE QU'UN SEUL JOUEUR A TROUVE TOUS LES TOPS, pas qu'il etait
    // seul dans le salon. La definition se lit dans le resultat, et elle est
    // plus dure que l'autre.
    const solo = topee && tops.size === 1 ? [...tops.keys()][0]! : null;

    // Le compte se lit au moment ou la manche s'enregistre, et il est fige la :
    // ouvrir un compte demain sous le pseudo qu'un invite portait hier ne doit
    // pas lui faire heriter de ses records.
    const joueurs: Manche["joueurs"] = [...tops]
      .sort((a, b) => b[1] - a[1])
      .map(([nom, n]) => ({ nom, tops: n, invite: compte(nom) === undefined }));

    // Les deux seuls coups que la manche retient : les tableaux annexes en ont
    // besoin, et eux seuls.
    //
    // ON NE RETIENT QUE DES COUPS TROUVES. Ces deux tableaux-la nomment un
    // joueur a cote d'un mot : un top que personne n'a vu n'a personne a
    // nommer, et il n'entre donc pas au tableau. C'est aussi la seule chose
    // qu'on leur demande -- ils ne reclament plus une partie topee (SPEC.md
    // §23) : le coup se juge sur lui-meme, et un beau coup reste un beau coup
    // dans une partie ou l'on a rate autre chose.
    const note = (c: CoupObserve): CoupNote =>
      ({ mot: c.mots[0] ?? "", score: c.score, par: c.par });
    const trie = this.vus.filter((c) => c.par !== null)
      .sort((a, b) => b.score - a.score);

    const cfg = this.partie.cfg;
    return {
      ref: refDeLaGraine(this.partie.seed),
      partie: this.partie.gameId,
      graine: this.partie.seed,
      at: Date.now(),
      categorie: this.categorie.id,
      grille,
      lexique: cfg.dictionnaire,
      empreinte: empreinteDuLexique(cfg.dictionnaire),
      chrono: cfg.chrono,
      coups: this.vus.length,
      temps: this.vus.reduce((a, c) => a + c.ms, 0),
      cumul: this.vus.reduce((a, c) => a + c.score, 0),
      // Une farfouille pose tout ce que le tirage permet de poser.
      farfouilles: this.vus.filter((c) => c.poses >= cfg.jouables).length,
      topee,
      negatif: this.vus.reduce((a, c) => a + c.negatif, 0),
      joueurs,
      solo,
      coupCher: trie[0] === undefined ? null : note(trie[0]),
      coupPasCher: trie[trie.length - 1] === undefined ? null : note(trie[trie.length - 1]!),
    };
  }
}

/**
 * Met une partie sous observation, si ses reglages peuvent porter un record.
 *
 * Sans categorie, on n'observe pas : garder une liste de coups pour une grille
 * sans fin, c'est accumuler des milliers d'entrees que personne ne lira jamais.
 */
export function observer(
  partie: Game, surEtape?: (e: EtapeObservee) => void,
): Lecture {
  // LA PARTIE HORS CATEGORIE S'OBSERVE SI UNE MONTANTE LA REGARDE, ET RIEN DE
  // PLUS.
  //
  // Elle ne s'observait pas du tout : rien ne sortait de ce module pour une
  // grille sans fin ou un duplicate. Une montante, elle, veut connaitre ses
  // cumuls meme si son etape ne peut porter aucun record -- ne serait-ce que
  // pour cesser de pretendre au tableau plutot que de s'arreter en silence.
  //
  // MAIS RIEN NE S'OBSERVE QUAND RIEN NE REGARDE. La grille mondiale porte des
  // milliers de coups et ne peut porter aucun record : lui retenir chaque coup
  // et ses isotops serait des megaoctets gardes pour personne.
  //
  // Ce qui n'est pas ecrit reste non ecrit : ni manche, ni mot. Le compteur de
  // mots ne compte que la ou le journal des records regarde (SPEC.md §13), et
  // `Observation` le tient de son cote.
  const categorie = categorieDesReglages(partie.cfg);
  const vue = new Observation(partie, categorie);
  if (categorie === null && surEtape === undefined) return { etape: () => vue.etape() };
  /** Ce que cette partie a deja ecrit : on n'ecrit pas deux fois. */
  let ecrit = false;
  partie.onMove((m) => vue.coup(m));

  /** Ecrit ce que la partie a ajoute aux compteurs, une fois pour toutes. */
  const ecrireLesMots = (): void => {
    const d = vue.mots();
    if (d === null) return;
    inscrire({ t: "mots", ...d });
  };

  partie.onFin((raison) => {
    // LA MONTANTE EST SERVIE LA PREMIERE, et avant toute ecriture : c'est elle
    // qui decide s'il y a une septieme ligne a ajouter apres les six.
    if (surEtape !== undefined) surEtape(vue.etape(raison));
    const m = vue.manche(raison);
    if (!ouvert) ouvrirLesRecords();
    // LES MOTS PARTENT DANS TOUS LES CAS, la manche seulement si elle compte.
    // Une partie qu'aucun tableau n'accueille a quand meme fait rater des mots.
    ecrit = true;
    ecrireLesMots();
    if (m === null) return;
    manches.push(m);
    inscrire({ t: "manche", ...m });
    const qui = m.joueurs.map((j) => j.invite ? `${j.nom} (invité)` : j.nom);
    console.log(
      `[records] ${m.categorie} · ${m.coups} coups en ${(m.temps / 1000).toFixed(2)} s · ` +
      `${m.topee ? "topée" : `négatif ${m.negatif}`} · ${qui.join(", ") || "personne"}`,
    );
  });

  // LA PARTIE QU'ON ABANDONNE LAISSE SES MOTS, ET RIEN D'AUTRE. Une table qui
  // rate un top relance aussitot : sans cela, le mot rate -- celui-la meme qui
  // fait abandonner -- partirait avec elle. Elle ne laisse pas de quoi la
  // reconstituer : seules les parties terminees se gardent.
  partie.onArret(() => {
    if (ecrit) return;
    ecrit = true;
    if (!ouvert) ouvrirLesRecords();
    const d = vue.mots();
    if (d === null) return;
    inscrire({ t: "mots", ...d });
    console.log(`[records] "${partie.gameId}" abandonnée : `
      + `${d.trouves.length} mot(s) trouvé(s), ${d.rates.length} raté(s) au compteur`);
  });

  return { etape: () => vue.etape() };
}

/**
 * Ajoute une manche au journal et aux tableaux, telle quelle.
 *
 * Pour la MONTANTE, et pour elle seule : sa ligne ne nait pas d'une partie mais
 * de six, et c'est le salon qui l'assemble (`server/src/montante.ts`). Le reste
 * du fichier n'a pas d'autre porte d'entree, et n'en veut pas : une manche qui
 * ne vient pas d'une observation ne serait pas verifiable.
 */
export function ajouterUneManche(m: Manche): void {
  if (!ouvert) ouvrirLesRecords();
  manches.push(m);
  inscrire({ t: "manche", ...m });
}

// ------------------------------------------------------------ les classements

/**
 * Ce qu'une ligne de tableau montre. C'est la manche AMPUTEE de ce qui ne
 * regarde pas les clients : sa graine, et le detail de ses coups.
 */
export interface LigneDeRecord {
  /** La reference de la manche : c'est par elle qu'on la relit et qu'on la cite. */
  ref: string;
  /**
   * Le rang, avec les ex aequo.
   *
   * DEUX TEMPS EGAUX AU CENTIEME PRES SONT EX AEQUO : ils portent le meme rang,
   * et le rang suivant saute d'autant -- deux premiers, puis un troisieme.
   * Departager au millieme deux performances que rien ne distingue a
   * l'affichage serait un classement invente.
   */
  rang: number;
  partie: string;
  at: number;
  categorie: string;
  grille: Grille;
  lexique: string;
  empreinte: string;
  chrono: number | null;
  coups: number;
  temps: number;
  cumul: number;
  farfouilles: number;
  topee: boolean;
  negatif: number;
  joueurs: { nom: string; tops: number; invite: boolean }[];
  solo: string | null;
  /** Les six etapes, sur une ligne de montante, et rien ailleurs. */
  etapes?: EtapeDeMontante[];
}

function pourLAffichage(m: Manche, rang: number): LigneDeRecord {
  // LA GRAINE NE SORT PAS : elle dirait comment rejouer les tirages d'une
  // partie dont on peut, par ailleurs, tout voir.
  const { graine: _g, coupCher: _c, coupPasCher: _p, ...reste } = m;
  return { rang, ...reste };
}

export interface Filtre {
  categorie: string;
  grille?: Grille;
  lexique?: string;
  /** Ne garder que les manches ou un seul joueur a tout trouve. */
  solo?: boolean;
}

/** Cent lignes : ce qu'un tableau montre, et pas une de plus. */
export const LIGNES_PAR_TABLEAU = 100;

/** Les manches d'une categorie, sans les classer. */
function retenues(f: Filtre): Manche[] {
  const cat = categorie(f.categorie);
  // « Partie normale solo » n'est pas une configuration : une manche porte la
  // categorie de BASE, et le solo se lit dans son resultat. L'onglet solo et la
  // case a cocher passent donc par le meme chemin.
  // « Partie normale solo » et « Temps par coup » ne sont pas des
  // configurations : ce sont la meme partie normale, lue autrement. Une manche
  // porte donc la categorie de BASE, et ces deux-la y renvoient.
  const base = cat?.solo === true || cat?.parCoup === true ? "normale" : f.categorie;
  const seulement = cat?.solo === true || f.solo === true;
  return manchesValides().filter((m) =>
    m.categorie === base
    && (f.grille === undefined || m.grille === f.grille)
    && (f.lexique === undefined || m.lexique === f.lexique)
    && (!seulement || m.solo !== null));
}

/** Le temps au centieme : c'est a cette precision que deux manches sont egales. */
const auCentieme = (ms: number): number => Math.round(ms / 10);

/**
 * Pose les rangs sur une liste DEJA TRIEE, en respectant les ex aequo.
 *
 * `egales` dit ce qui rend deux lignes indiscernables. Deux manches qui le sont
 * portent le meme rang, et la suivante saute d'autant.
 */
function ranger(
  triees: Manche[], egales: (a: Manche, b: Manche) => boolean,
): LigneDeRecord[] {
  const out: LigneDeRecord[] = [];
  let rang = 0;
  for (let i = 0; i < triees.length; i++) {
    const m = triees[i]!;
    const avant = triees[i - 1];
    if (avant === undefined || !egales(avant, m)) rang = i + 1;
    out.push(pourLAffichage(m, rang));
  }
  return out;
}

/**
 * Le temps par coup, au centieme.
 *
 * IL NE SE DEDUIT PAS DU TEMPS TOTAL POUR CLASSER. Une partie de dix-neuf coups
 * et une de vingt-six ne demandent pas le meme travail : le temps total dit qui
 * a fini le premier, le temps par coup dit qui a cherche le plus vite. Ce sont
 * deux questions, et Zulu veut les deux.
 */
const parCoup = (m: Manche): number =>
  m.coups === 0 ? Infinity : Math.round(m.temps / m.coups / 10);

/**
 * Le classement de vitesse : les parties topees, la plus rapide en tete.
 *
 * Seules les parties TOPEES y figurent. Une partie presque topee ne se compare
 * a rien : il faudrait dire ce que « presque » vaut.
 */
export function classementDeVitesse(f: Filtre): LigneDeRecord[] {
  // C'est la CATEGORIE qui dit sur quoi on classe : « Temps par coup » est un
  // tableau a elle, avec son propre podium, et non un tri de la partie normale.
  const cle = categorie(f.categorie)?.parCoup === true
    ? parCoup : (m: Manche): number => auCentieme(m.temps);
  const triees = retenues(f)
    .filter((m) => m.topee)
    .sort((a, b) => cle(a) - cle(b) || a.at - b.at);
  return ranger(triees, (a, b) => cle(a) === cle(b)).slice(0, LIGNES_PAR_TABLEAU);
}

/**
 * Les meilleurs negatifs, pour completer un tableau qui n'a pas cent parties
 * topees. Voir SPEC.md §23 : a partir de 10 sur 10, elles sont rares.
 *
 * Un negatif nul serait une partie topee : elles sont deja au-dessus et ne se
 * repetent pas ici.
 */
export function classementAuNegatif(f: Filtre, place = LIGNES_PAR_TABLEAU): LigneDeRecord[] {
  if (place <= 0) return [];
  const triees = retenues(f)
    .filter((m) => !m.topee)
    .sort((a, b) => a.negatif - b.negatif || auCentieme(a.temps) - auCentieme(b.temps));
  return ranger(triees, (a, b) => a.negatif === b.negatif).slice(0, place);
}

/**
 * Un tableau complet : les topees, puis les negatifs s'il reste de la place.
 *
 * LES NEGATIFS NE COMPLETENT QUE LES GRANDS FORMATS. A dix caramels et plus,
 * une partie topee est rare, et un tableau de trois lignes n'apprend rien ; en
 * dessous, il s'en trouve, et melanger les deux ferait passer pour un record
 * une partie ou l'on a rate un top.
 */
export function tableau(f: Filtre): { topees: LigneDeRecord[]; negatifs: LigneDeRecord[] } {
  const topees = classementDeVitesse(f);
  if (!completeAuNegatif(categorie(f.categorie))) return { topees, negatifs: [] };
  return {
    topees,
    negatifs: classementAuNegatif(f, LIGNES_PAR_TABLEAU - topees.length),
  };
}

// -------------------------------------------------------- les tableaux annexes

/** Ce que les tableaux annexes classent. Voir SPEC.md §23. */
export type Annexe =
  | "chrono" | "chere" | "pasChere" | "courte" | "longue"
  | "farfouilles" | "peuDeFarfouilles";

/**
 * Les tableaux annexes portent sur des parties TOPEES elles aussi. Une partie
 * entierement revelee par l'echeance afficherait sinon le cumul du generateur,
 * pas celui d'une table.
 */
export function annexe(quoi: Annexe, f: Filtre): LigneDeRecord[] {
  const topees = retenues(f).filter((m) => m.topee);
  // Un chrono infini n'est pas un chrono serre : il ne concourt pas au tableau
  // qui classe la contrainte de temps.
  const base = quoi === "chrono" ? topees.filter((m) => m.chrono !== null) : topees;
  const cle = (m: Manche): number => {
    switch (quoi) {
      case "chrono": return m.chrono ?? Infinity;
      case "chere": return -m.cumul;
      case "pasChere": return m.cumul;
      case "courte": return m.coups;
      case "longue": return -m.coups;
      case "farfouilles": return -m.farfouilles;
      case "peuDeFarfouilles": return m.farfouilles;
    }
  };
  const triees = [...base].sort((a, b) => cle(a) - cle(b) || a.at - b.at);
  return ranger(triees, (a, b) => cle(a) === cle(b)).slice(0, LIGNES_PAR_TABLEAU);
}

/** Un coup, pas une partie : le mot, ses points, et d'ou il vient. */
export interface LigneDeCoup {
  rang: number;
  mot: string;
  score: number;
  partie: string;
  categorie: string;
  lexique: string;
  at: number;
  par: string | null;
}

/**
 * Le coup le plus cher, ou le moins cher. Voir SPEC.md §23.
 *
 * IL SUFFIT QUE LE COUP AIT ETE TROUVE : la partie n'a pas besoin d'etre topee.
 * C'est le seul tableau qui classe un COUP et non une partie, et un coup se
 * juge sur lui-meme -- avoir manque un top trois coups plus loin n'enleve rien
 * a celui-la. Les tableaux qui classent des parties, eux, exigent toujours
 * qu'elle soit topee : leur mesure porte sur l'ensemble.
 *
 * UNE PARTIE N'Y PRESENTE QU'UN COUP : le sien. La manche ne garde plus la
 * liste de ses coups -- c'etait de quoi la reconstituer, dans un fichier qui
 * n'est pas fait pour ca -- mais elle retient son meilleur et son pire parmi
 * ceux qu'un joueur a trouves, ce qui suffit exactement a ces deux tableaux.
 */
export function coupsExtremes(f: Filtre, sens: "cher" | "pasCher"): LigneDeCoup[] {
  const coups: LigneDeCoup[] = [];
  for (const m of retenues(f)) {
    const c = sens === "cher" ? m.coupCher : m.coupPasCher;
    if (c === null || c === undefined) continue;
    // Les manches ecrites avant la regle ci-dessus pouvaient retenir un top que
    // personne n'avait trouve : le journal ne se recrit pas, on les ecarte ici.
    if (c.par === null) continue;
    coups.push({
      rang: 0, mot: c.mot, score: c.score,
      partie: m.partie, categorie: m.categorie, lexique: m.lexique,
      at: m.at, par: c.par,
    });
  }
  coups.sort((a, b) => sens === "cher" ? b.score - a.score : a.score - b.score);
  let rang = 0;
  return coups.slice(0, LIGNES_PAR_TABLEAU).map((c, i, tout) => {
    if (i === 0 || tout[i - 1]!.score !== c.score) rang = i + 1;
    return { ...c, rang };
  });
}

// ---------------------------------------------------------------- les mots

export interface LigneDeMot {
  rang: number;
  mot: string;
  /** Combien de fois ce mot est sorti en top, isotops compris. */
  fois: number;
  trouves: number;
  rates: number;
  /** Part des fois ou il a ete trouve, en pourcentage a une decimale. */
  part: number;
}

/**
 * Le classement d'un compteur de mots.
 *
 * IL NE SE RECALCULE PLUS A CHAQUE LECTURE. Le compteur est tenu au fil des
 * coups (voir `Observation.coup`) ; il ne reste ici qu'a trier ce qui y est.
 */
/**
 * TOUS LES LEXIQUES CONFONDUS. Voir SPEC.md §23.
 *
 * Le meme mot vit souvent dans plusieurs listes -- il est de l'ODS comme du CSW
 * -- et il n'y a alors qu'un seul mot a classer : les compteurs s'additionnent.
 * La table ne se garde pas, elle vaut le temps d'une lecture : la garder
 * obligerait a l'invalider a chaque coup joue, pour un tableau qu'on regarde
 * une fois par jour.
 */
function compteursConfondus(): Map<string, CompteurDeMot> {
  const t = new Map<string, CompteurDeMot>();
  for (const table of mots.values()) {
    for (const [mot, e] of table) {
      const deja = t.get(mot);
      if (deja === undefined) t.set(mot, { trouves: e.trouves, rates: e.rates });
      else { deja.trouves += e.trouves; deja.rates += e.rates; }
    }
  }
  return t;
}

function classerLesMots(
  /** `null` : tous les lexiques confondus. */
  lexique: string | null,
  longueur: number | undefined,
  cle: (e: CompteurDeMot) => number,
  garder: (e: CompteurDeMot) => boolean,
): LigneDeMot[] {
  const lignes: LigneDeMot[] = [];
  for (const [mot, e] of lexique === null ? compteursConfondus() : compteurs(lexique)) {
    if (longueur !== undefined && mot.length !== longueur) continue;
    if (!garder(e)) continue;
    const fois = e.trouves + e.rates;
    lignes.push({
      rang: 0, mot, fois, trouves: e.trouves, rates: e.rates,
      part: fois === 0 ? 0 : Math.round((e.trouves / fois) * 1000) / 10,
    });
  }
  lignes.sort((a, b) =>
    cle({ trouves: b.trouves, rates: b.rates }) - cle({ trouves: a.trouves, rates: a.rates })
    || a.mot.localeCompare(b.mot));
  let rang = 0;
  return lignes.slice(0, LIGNES_PAR_TABLEAU).map((l, i, tout) => {
    const avant = tout[i - 1];
    if (avant === undefined
        || cle({ trouves: avant.trouves, rates: avant.rates })
          !== cle({ trouves: l.trouves, rates: l.rates })) rang = i + 1;
    return { ...l, rang };
  });
}

/**
 * Les mots les plus rates. `longueur` restreint au tableau de cette longueur.
 *
 * UN MOT JAMAIS RATE N'A RIEN A FAIRE DANS LES RATES. Il y figurait, tout en
 * bas, avec un zero : c'est un tableau des mots vus, pas des mots rates.
 */
export function motsRates(lexique: string | null, longueur?: number): LigneDeMot[] {
  return classerLesMots(lexique, longueur, (e) => e.rates, (e) => e.rates > 0);
}

/**
 * Les mots les plus trouves : le tableau symetrique, et exclusif de l'autre.
 *
 * Un mot rate une seule fois n'est pas un mot que la table connait : il sort
 * des trouves, meme s'il a par ailleurs ete trouve dix fois.
 */
export function motsTrouves(lexique: string | null, longueur?: number): LigneDeMot[] {
  return classerLesMots(lexique, longueur, (e) => e.trouves,
    (e) => e.trouves > 0 && e.rates === 0);
}

/**
 * WU et QI, exactement. Voir SPEC.md §13 et §23.
 *
 * NI `WUS`, NI `QIS`, NI LES COLLANTES formees a cote d'un autre mot : ce sont
 * d'autres mots. Ils se lisent au compteur, comme tous les autres.
 *
 * `WU` n'existe pas en anglais : le compteur ne vaut que pour le lexique
 * officiel du jeu francophone.
 */
export function compteurWuQi(lexique: string): { mot: string; sorti: number; trouve: number }[] {
  const t = compteurs(lexique);
  return ["QI", "WU"].map((mot) => {
    const e = t.get(mot) ?? { trouves: 0, rates: 0 };
    return { mot, sorti: e.trouves + e.rates, trouve: e.trouves };
  }).sort((a, b) => b.trouve - a.trouve || a.mot.localeCompare(b.mot));
}
