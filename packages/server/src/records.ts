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
  categorieDesReglages, grilleDeBornes, type Categorie, type Grille,
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

/** Une manche : une partie valide, jouee, terminee. */
export interface Manche {
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
  /** Le detail, pour les mots rates et les tableaux annexes. */
  vus: CoupObserve[];
}

/** Ce que le journal des records peut porter. */
type Evenement =
  | ({ t: "manche" } & Manche)
  | { t: "invalide"; partie: string; par: string; raison: string; at: number };

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

// ---------------------------------------------------------------- le journal

let manches: Manche[] = [];
const invalidees = new Set<string>();
let ouvert = false;

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
  invalidees.clear();
  ouvert = true;
  if (!existsSync(JOURNAL)) {
    console.log("[records] aucun record enregistre");
    return;
  }
  let cassees = 0;
  for (const ligne of readFileSync(JOURNAL, "utf8").split("\n")) {
    if (ligne.trim() === "") continue;
    let ev: Evenement;
    try { ev = JSON.parse(ligne) as Evenement; } catch { cassees++; continue; }
    if (ev.t === "manche") manches.push(ev);
    else if (ev.t === "invalide") invalidees.add(ev.partie);
  }
  if (cassees > 0) console.warn(`[records] ${cassees} ligne(s) illisible(s), ignorees`);
  console.log(`[records] ${manches.length} manche(s) relues, ${invalidees.size} invalidee(s)`);
}

/** Les manches qui comptent : tout ce qui n'a pas ete invalide. */
export function manchesValides(): Manche[] {
  return manches.filter((m) => !invalidees.has(m.partie));
}

/**
 * Retire une manche des tableaux, sans l'effacer.
 *
 * ON N'EFFACE PAS UNE LIGNE D'UN FICHIER EN AJOUT SEUL : l'invalidation est
 * elle-meme un evenement, et le journal garde la trace de ce qui a ete retire,
 * par qui et pourquoi.
 */
export function invaliderLaManche(partie: string, par: string, raison: string): boolean {
  if (!manches.some((m) => m.partie === partie)) return false;
  if (invalidees.has(partie)) return true;
  invalidees.add(partie);
  inscrire({ t: "invalide", partie, par, raison, at: Date.now() });
  console.log(`[records] manche "${partie}" invalidee par ${par} : ${raison}`);
  return true;
}

/** Met le journal des records de cote. Il repart vide. Rien n'est efface. */
export function remettreLesRecordsAZero(): string | null {
  if (!existsSync(JOURNAL)) { manches = []; invalidees.clear(); return null; }
  const archive = join(DATA_DIR, `records.${Date.now()}.journal.jsonl`);
  renameSync(JOURNAL, archive);
  manches = [];
  invalidees.clear();
  return archive;
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
  private readonly categorie: Categorie;
  /** L'observation est complete depuis le premier coup. */
  private entiere: boolean;

  constructor(partie: Game, categorie: Categorie) {
    this.partie = partie;
    this.categorie = categorie;
    // UN SERVEUR QUI REDEMARRE EN COURS DE PARTIE PERD SON OBSERVATION.
    // La partie cesse alors d'etre eligible plutot que d'entrer au tableau
    // avec des coups dont personne ne sait s'ils ont ete cherches.
    this.entiere = partie.moves.length === 0;
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
    this.vus.push({
      n: m.n,
      mots,
      score: m.score,
      ms: Math.max(0, m.ms),
      par: m.player,
      actif: this.partie.actifsDuCoup.length > 0,
      poses: m.placements.length,
      negatif,
    });
  }

  /** La partie s'arrete. Rend la manche a enregistrer, ou `null`. */
  manche(raison: RaisonDeFin): Manche | null {
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

    const cfg = this.partie.cfg;
    return {
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
      vus: this.vus,
    };
  }
}

/**
 * Met une partie sous observation, si ses reglages peuvent porter un record.
 *
 * Sans categorie, on n'observe pas : garder une liste de coups pour une grille
 * sans fin, c'est accumuler des milliers d'entrees que personne ne lira jamais.
 */
export function observer(partie: Game): void {
  const categorie = categorieDesReglages(partie.cfg);
  if (categorie === null) return;
  const vue = new Observation(partie, categorie);
  partie.onMove((m) => vue.coup(m));
  partie.onFin((raison) => {
    const m = vue.manche(raison);
    if (m === null) return;
    if (!ouvert) ouvrirLesRecords();
    manches.push(m);
    inscrire({ t: "manche", ...m });
    const qui = m.joueurs.map((j) => j.invite ? `${j.nom} (invité)` : j.nom);
    console.log(
      `[records] ${m.categorie} · ${m.coups} coups en ${(m.temps / 1000).toFixed(2)} s · ` +
      `${m.topee ? "topée" : `négatif ${m.negatif}`} · ${qui.join(", ") || "personne"}`,
    );
  });
}
