/**
 * Le compétitif : les parties du jour, leurs manches, leurs classements.
 * Voir SPEC.md §29.
 *
 * TROIS OBJETS, ET UN JOURNAL.
 *
 *   partie figee   une partie entiere jouee d'avance (`figees.ts`)
 *   epreuve        des parties figees, une periode, qui peut y jouer
 *   manche         ce qu'un joueur ou une equipe a fait sur une partie figee
 *
 * Les parties du jour sont une epreuve comme les autres, une par jour et par
 * lexique : `pdj:2026-09-15:ods9`. Les tournois et les defis viendront s'y
 * ranger sans rien changer a ce qui lit les manches.
 *
 * LE JOURNAL FAIT FOI, en ajout seul, comme partout ailleurs (§11). Ce qui est
 * en memoire en est une vue, refaite au demarrage.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlayedMove } from "./game.ts";
import { ecrireLaPartieFigee, figerUnePartie, lireLaPartieFigee } from "./figees.ts";
import type { PartieFigee } from "./game.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";
import { deserialiser, type ConfigPartie, type ConfigSerialisee } from "../../engine/src/config.ts";
import type { Dir } from "../../engine/src/coords.ts";
import {
  JOURS_DE_LA_SEMAINE, LEXIQUES_DU_JOUR, PARTIES_DU_JOUR, configDuModele, consigneExacte,
  debutDuJour, decalerLeJour, jourDe, jourDeLaSemaine, joursEntre, modeleDeLaConfig,
  nomDeLaPartie, tirerUnModele, tirerUneConsigne,
  type ConsigneDePartie, type ModeleDePartie,
} from "../../engine/src/epreuves.ts";

const here = dirname(fileURLToPath(import.meta.url));
let DATA_DIR = join(here, "..", "data", "competitif");
const journal = (): string => join(DATA_DIR, "competitif.journal.jsonl");

/**
 * Change le dossier du compétitif. RESERVE AUX TESTS, qui ne doivent jamais
 * ecrire dans le vrai journal -- pas meme pour le remettre en place ensuite.
 */
export function definirDossierDuCompetitif(dir: string): void {
  DATA_DIR = dir;
  jours.clear();
  manches.clear();
  tournois.clear();
  apercus.clear();
  semaine.clear();
  hebdos.clear();
  hebdosFaits.clear();
  defis.clear();
  defiParPartie.clear();
}

/** Le dossier ou vivent les parties figees de l'epreuve. */
export const dossierDuCompetitif = (): string => DATA_DIR;

// ------------------------------------------------------------------ modele

/** Une partie d'une epreuve : son numero, sa partie figee, son nom. */
export interface PartieDEpreuve {
  n: number;
  figee: string;
  config: ConfigSerialisee;
}

export interface JourDePdj {
  jour: string;
  lexique: string;
  parties: PartieDEpreuve[];
  at: number;
}

/**
 * Comment la manche a ete jouee (SPEC.md §29).
 *
 * `seul`     un joueur, un compte ;
 * `compte`   plusieurs sur un meme compte, les noms en texte libre ;
 * `equipe`   des comptes invites, en topping collaboratif.
 */
export type Jeu = "seul" | "compte" | "equipe";

export interface CoupDeManche {
  n: number;
  notation: string;
  /** Le mot retenu. */
  mot: string;
  dir: Dir;
  x: number;
  y: number;
  score: number;
  /** Le coup a-t-il pose tout le tirage ? */
  farfouille: boolean;
  /** Le temps compte pour ce coup : le chrono plein s'il est rate. */
  ms: number;
  trouve: boolean;
  /** La meilleure solution soumise par la manche, ou `null`. */
  prop: { mot: string; dir: Dir; x: number; y: number; score: number } | null;
}

export interface FinDeManche {
  at: number;
  temps: number;
  negatif: number;
  score: number;
  coups: CoupDeManche[];
}

export interface Manche {
  id: string;
  epreuve: string;
  partie: number;
  salon: string;
  /** Qui l'a lancee. */
  compte: string;
  jeu: Jeu;
  /** Les noms ecrits a la main, a plusieurs sur un compte. */
  noms: string;
  /** Les comptes qui la jouent : un seul, sauf en equipe. */
  equipe: string[];
  at: number;
  fin: FinDeManche | null;
  /**
   * LA LIGNE D'UN JOUEUR DE LA PARTIE D'ORIGINE d'un defi (SPEC.md §29). Elle
   * n'a pas ete jouee ici : elle est le temps a battre, pas une reponse.
   */
  origine?: boolean;
}

/** Ce qu'un tournoi de battle regle a sa creation (SPEC.md §29). */
export interface ReglagesBattle {
  joueursParPoule: number;
  /** `null` : chacun rencontre tous les autres. */
  rencontresParPoule: number | null;
  manchesParPoule: number;
  /** `null` : tout le monde est qualifie. */
  qualifies: number | null;
  /** `null` : la moitie des qualifies. */
  tableauHaut: number | null;
  meilleurDe: number;
  meilleurDeDemi: number;
  meilleurDeFinale: number;
  partie: ModeleDePartie;
  /** Instant ou les poules doivent etre jouees. */
  limitePoules: number;
  joursParTour: number;
}

export interface Inscription {
  compte: string;
  /** Les noms ecrits a la main, pour une equipe qui joue sur un compte. */
  noms: string;
  /** Les partenaires nommes par pseudo. */
  partenaires: string[];
  at: number;
}

export interface Tournoi {
  id: string;
  type: "topping" | "battle";
  nom: string;
  lexique: string;
  /** Topping : l'ouverture des parties. Battle : le debut des rencontres. */
  debut: number;
  /** Topping : la fermeture. Battle : `null`, le tournoi finit a sa finale. */
  fin: number | null;
  equipe: number;
  parties: PartieDEpreuve[];
  battle: ReglagesBattle | null;
  par: string;
  at: number;
  inscrits: Inscription[];
  /** L'instance d'un tournoi de la semaine dit de quel modele et de quel jour. */
  hebdo: { modele: string; jour: string } | null;
}

const jours = new Map<string, JourDePdj>();
const manches = new Map<string, Manche>();
const tournois = new Map<string, Tournoi>();
/** Les consignes d'un lexique pour un jour de la semaine : `lexique|0..6`. */
const semaine = new Map<string, ConsigneDePartie[]>();
const hebdos = new Map<string, ModeleHebdo>();
const defis = new Map<string, Defi>();
/** `salon|graine` vers l'identifiant du defi : une partie n'en donne qu'un. */
const defiParPartie = new Map<string, string>();
/**
 * LES INSTANCES DEJA NEES : `modele|jour`. Elle survit a la suppression du
 * tournoi -- sinon il renaitrait au passage suivant.
 */
const hebdosFaits = new Set<string>();
/** Les poules d'un tournoi de battle : une liste de camps par poule. */
const poules = new Map<string, string[][]>();
const rencontres = new Map<string, Rencontre>();
/** Le salon d'une manche de rencontre vers elle : `salon` -> rencontre et n. */
const rencontreParSalon = new Map<string, { rencontre: string; n: number }>();
/** Les messages de creneau, par rencontre. */
const messages = new Map<string, MessageDeRencontre[]>();
/** Les disponibilites d'un compte dans un tournoi : `tournoi|compte`. */
const dispos = new Map<string, string>();
/** L'en-tete libre de la page d'un tournoi. */
const entetes = new Map<string, string>();
/**
 * QUI A REGARDE QUELLE PARTIE FIGEE AVANT DE LA JOUER : `figee|compte`.
 *
 * La cle est la partie figee, et non le numero de la partie : une nouvelle
 * graine donne une autre partie, que personne n'a vue -- son auteur y est donc
 * classe comme tout le monde (SPEC.md §29).
 */
const apercus = new Set<string>();

const cleDuJour = (jour: string, lexique: string): string => `${jour}|${lexique}`;

/** L'identifiant de l'epreuve des parties du jour. */
export const epreuveDuJour = (jour: string, lexique: string): string => `pdj:${jour}:${lexique}`;

/** L'identifiant de l'epreuve d'un tournoi. */
export const epreuveDuTournoi = (id: string): string => `tournoi:${id}`;

/** Le tournoi d'une epreuve, s'il en est un. */
export function tournoiDeLEpreuve(epreuve: string): Tournoi | undefined {
  return epreuve.startsWith("tournoi:") ? tournois.get(epreuve.slice("tournoi:".length)) : undefined;
}

/** Les parties d'une epreuve, quelle qu'elle soit. */
export function partiesDeLEpreuve(epreuve: string): PartieDEpreuve[] | undefined {
  const d = defiDeLEpreuve(epreuve);
  if (d !== undefined) return [{ n: 1, figee: d.figee, config: d.config }];
  const t = tournoiDeLEpreuve(epreuve);
  if (t !== undefined) return t.parties;
  const e = lireLEpreuve(epreuve);
  return e === null ? undefined : partiesDuJour(e.jour, e.lexique)?.parties;
}

/** Le lexique d'une epreuve. */
export function lexiqueDeLEpreuve(epreuve: string): string | null {
  return defiDeLEpreuve(epreuve)?.config.dictionnaire
    ?? tournoiDeLEpreuve(epreuve)?.lexique ?? lireLEpreuve(epreuve)?.lexique ?? null;
}

/** Ce que dit un identifiant d'epreuve des parties du jour, ou `null`. */
export function lireLEpreuve(id: string): { jour: string; lexique: string } | null {
  const m = /^pdj:(\d{4}-\d{2}-\d{2}):([a-z0-9]+)$/.exec(id);
  return m === null ? null : { jour: m[1]!, lexique: m[2]! };
}

// ----------------------------------------------------------------- journal

function inscrire(ev: Record<string, unknown>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const fd = openSync(journal(), "a");
  try {
    writeSync(fd, JSON.stringify(ev) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Relit le journal. Une ligne tronquee par une coupure est ignoree. */
export function ouvrirLeCompetitif(): void {
  jours.clear();
  manches.clear();
  semaine.clear();
  hebdos.clear();
  hebdosFaits.clear();
  defis.clear();
  defiParPartie.clear();
  tournois.clear();
  apercus.clear();
  poules.clear();
  rencontres.clear();
  rencontreParSalon.clear();
  messages.clear();
  dispos.clear();
  entetes.clear();
  if (!existsSync(journal())) return;
  let casses = 0;
  for (const ligne of readFileSync(journal(), "utf8").split("\n")) {
    if (ligne.trim() === "") continue;
    let e: Record<string, any>;
    try { e = JSON.parse(ligne); } catch { casses++; continue; }
    appliquer(e);
  }
  if (casses > 0) console.warn(`[competitif] ${casses} ligne(s) illisible(s) dans le journal`);
  console.log(`[competitif] ${jours.size} jour(s) de parties, ${manches.size} manche(s)`);
}

function appliquer(e: Record<string, any>): void {
  if (e["t"] === "pdj") {
    jours.set(cleDuJour(e["jour"], e["lexique"]), {
      jour: e["jour"], lexique: e["lexique"], parties: e["parties"], at: e["at"],
    });
  } else if (e["t"] === "manche") {
    manches.set(e["id"], {
      id: e["id"], epreuve: e["epreuve"], partie: e["partie"], salon: e["salon"],
      compte: e["compte"], jeu: e["jeu"], noms: e["noms"] ?? "", equipe: e["equipe"] ?? [e["compte"]],
      at: e["at"], fin: null,
      ...(e["origine"] === true ? { origine: true } : {}),
    });
  } else if (e["t"] === "defi") {
    defis.set(e["id"], {
      id: e["id"], salon: e["salon"], graine: e["graine"], nom: e["nom"] ?? e["salon"],
      figee: e["figee"], config: e["config"], par: e["par"], at: e["at"],
    });
    defiParPartie.set(`${e["salon"]}|${e["graine"]}`, e["id"]);
  } else if (e["t"] === "semaine") {
    semaine.set(cleDeLaSemaine(e["lexique"], Number(e["jour"])), e["consignes"] ?? []);
  } else if (e["t"] === "hebdo") {
    hebdos.set(e["id"], {
      id: e["id"], nom: e["nom"], lexique: e["lexique"], equipe: e["equipe"] ?? 1,
      jourDebut: Number(e["jourDebut"]), jourFin: Number(e["jourFin"]),
      consignes: e["consignes"] ?? [], actif: e["actif"] !== false, par: e["par"], at: e["at"],
    });
  } else if (e["t"] === "hebdo-supprime") {
    hebdos.delete(e["id"]);
  } else if (e["t"] === "apercu") {
    if (typeof e["figee"] === "string") apercus.add(`${e["figee"]}|${e["par"]}`);
  } else if (e["t"] === "tournoi-supprime") {
    tournois.delete(e["id"]);
  } else if (e["t"] === "tournoi") {
    // UN TOURNOI MODIFIE GARDE SES INSCRITS : la ligne qu'on reecrit porte ses
    // reglages, pas les gens.
    const inscrits = tournois.get(e["id"])?.inscrits ?? [];
    tournois.set(e["id"], {
      id: e["id"], type: e["type"], nom: e["nom"], lexique: e["lexique"],
      debut: e["debut"], fin: e["fin"] ?? null, equipe: e["equipe"] ?? 1,
      parties: e["parties"] ?? [], battle: e["battle"] ?? null, par: e["par"], at: e["at"],
      inscrits, hebdo: e["hebdo"] ?? null,
    });
    if (e["hebdo"] != null) hebdosFaits.add(`${e["hebdo"]["modele"]}|${e["hebdo"]["jour"]}`);
  } else if (e["t"] === "inscription") {
    const t = tournois.get(e["tournoi"]);
    if (t !== undefined && !t.inscrits.some((i) => i.compte === e["compte"])) {
      t.inscrits.push({ compte: e["compte"], noms: e["noms"] ?? "", partenaires: e["partenaires"] ?? [], at: e["at"] });
    }
  } else if (e["t"] === "fin") {
    const m = manches.get(e["manche"]);
    if (m !== undefined && m.fin === null) {
      m.fin = { at: e["at"], temps: e["temps"], negatif: e["negatif"], score: e["score"], coups: e["coups"] };
    }
  } else if (e["t"] === "desinscription") {
    const t = tournois.get(e["tournoi"]);
    if (t !== undefined) t.inscrits = t.inscrits.filter((i) => i.compte !== e["compte"]);
  } else if (e["t"] === "poules") {
    poules.set(e["tournoi"], (e["poules"] ?? []).map((p: string[]) => [...p]));
  } else if (e["t"] === "rencontre") {
    rencontres.set(e["id"], {
      id: e["id"], tournoi: e["tournoi"], phase: e["phase"], tour: Number(e["tour"] ?? 1),
      camps: [e["camps"][0], e["camps"][1]], bo: Number(e["bo"]),
      limite: Number(e["limite"]), butoir: Number(e["butoir"]), manches: [], fin: null,
    });
  } else if (e["t"] === "manche-rencontre") {
    const r = rencontres.get(e["rencontre"]);
    if (r !== undefined && !r.manches.some((m) => m.n === e["n"])) {
      r.manches.push({
        n: Number(e["n"]), salon: e["salon"], points: null, gagnant: null,
        at: e["at"], fin: null,
      });
      rencontreParSalon.set(e["salon"], { rencontre: r.id, n: Number(e["n"]) });
    }
  } else if (e["t"] === "manche-annulee") {
    const m = rencontres.get(e["rencontre"])?.manches.find((x) => x.n === e["n"]);
    if (m !== undefined && m.fin === null) m.fin = e["at"];
  } else if (e["t"] === "fin-rencontre") {
    const m = rencontres.get(e["rencontre"])?.manches.find((x) => x.n === e["n"]);
    if (m !== undefined && m.fin === null) {
      m.points = [Number(e["points"][0]), Number(e["points"][1])];
      m.gagnant = e["gagnant"] ?? null;
      m.fin = e["at"];
    }
  } else if (e["t"] === "rencontre-finie") {
    const r = rencontres.get(e["rencontre"]);
    if (r !== undefined && r.fin === null) {
      r.fin = { gagnant: e["gagnant"] ?? null, par: e["par"] ?? "jeu", at: e["at"] };
    }
  } else if (e["t"] === "rencontre-butoir") {
    const r = rencontres.get(e["rencontre"]);
    if (r !== undefined) r.butoir = Number(e["butoir"]);
  } else if (e["t"] === "message") {
    const l = messages.get(e["rencontre"]) ?? [];
    l.push({ de: e["de"], texte: e["texte"], at: e["at"] });
    messages.set(e["rencontre"], l);
  } else if (e["t"] === "dispo") {
    dispos.set(`${e["tournoi"]}|${e["compte"]}`, e["texte"] ?? "");
  } else if (e["t"] === "entete") {
    entetes.set(e["tournoi"], e["texte"] ?? "");
  }
}

// -------------------------------------------------------- les parties du jour

/** Les parties d'un jour et d'un lexique, si elles existent. */
export function partiesDuJour(jour: string, lexique: string): JourDePdj | undefined {
  return jours.get(cleDuJour(jour, lexique));
}

/** Les jours qui ont des parties, du plus recent au plus ancien, jusqu'a aujourd'hui. */
export function joursConnus(lexique: string, maintenant = Date.now()): string[] {
  const aujourdhui = jourDe(maintenant);
  return [...jours.values()]
    .filter((j) => j.lexique === lexique && j.jour <= aujourdhui)
    .map((j) => j.jour)
    .sort((a, b) => (a < b ? 1 : -1));
}

/** Le nom d'une partie d'epreuve : `P1 · Normale, 30s`. */
export function nomDeLaPartieDEpreuve(p: PartieDEpreuve): string {
  return `P${p.n} · ${nomDeLaPartie(p.config)}`;
}

let enPreparation: Promise<void> | null = null;

/**
 * FIGE LES PARTIES D'AUJOURD'HUI ET DE DEMAIN qui ne le sont pas encore.
 *
 * Celles de demain sont pretes des aujourd'hui : c'est ce qui laisse une journee
 * a l'administration pour les regarder, et c'est surtout ce qui fait qu'a
 * 5 h 30 personne n'attend un calcul (SPEC.md §29).
 *
 * Un appel pendant qu'un autre court attend celui-la : deux preparations
 * paralleles figeraient deux fois le meme jour.
 */
export function assurerLesPartiesDuJour(layout: LayoutName, maintenant = Date.now()): Promise<void> {
  if (enPreparation !== null) return enPreparation;
  enPreparation = (async () => {
    try {
      const aujourdhui = jourDe(maintenant);
      for (const jour of [aujourdhui, decalerLeJour(aujourdhui, 1)]) {
        for (const lexique of LEXIQUES_DU_JOUR) {
          if (partiesDuJour(jour, lexique) !== undefined) continue;
          await figerLeJour(jour, lexique, layout);
        }
      }
    } finally {
      enPreparation = null;
    }
  })();
  return enPreparation;
}

/**
 * Tire et fige les parties d'un jour. Le journal ne recoit la ligne du jour
 * qu'une fois TOUTES ses parties ecrites : un jour a moitie fige ne se voit pas,
 * et se refait entier au prochain passage.
 */
async function figerLeJour(jour: string, lexique: string, layout: LayoutName): Promise<void> {
  const t0 = Date.now();
  const parties: PartieDEpreuve[] = [];
  // LES CONSIGNES DU JOUR DE LA SEMAINE, tirees une a une (SPEC.md §29).
  const consignes = consignesPourLeJour(jour, lexique);
  for (let i = 0; i < consignes.length; i++) {
    const cfg = configDuModele(tirerUneConsigne(consignes[i]!), lexique);
    const f = await figerUnePartie(cfg, layout);
    ecrireLaPartieFigee(DATA_DIR, f);
    parties.push({ n: i + 1, figee: f.id, config: f.config });
  }
  const ev = { t: "pdj", jour, lexique, parties, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
  // Le nombre de parties et le temps, rien d'autre : ni tirage, ni top.
  console.log(`[competitif] parties du ${jour} (${lexique}) figees : `
    + `${parties.length} en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

/** La partie figee d'une partie d'epreuve. */
export function partieFigee(id: string): PartieFigee | null {
  return lireLaPartieFigee(DATA_DIR, id);
}

// ------------------------------------------------------------------ manches

/**
 * La manche de ce compte sur cette partie, qu'il l'ait lancee ou qu'il y ait
 * joue en equipe. UNE TENTATIVE PAR COMPTE ET PAR PARTIE : c'est ce qui la
 * retrouve.
 */
export function mancheDuCompte(compte: string, epreuve: string, partie: number): Manche | undefined {
  for (const m of manches.values()) {
    if (m.epreuve === epreuve && m.partie === partie && m.equipe.includes(compte)) return m;
  }
  return undefined;
}

export function mancheParId(id: string): Manche | undefined {
  return manches.get(id);
}

/** La manche jouee dans ce salon, s'il y en a une. */
export function mancheDuSalon(salon: string): Manche | undefined {
  let trouvee: Manche | undefined;
  for (const m of manches.values()) if (m.salon === salon) trouvee = m;
  return trouvee;
}

/** Ouvre une manche : la tentative de chacun de ses joueurs est consommee. */
/** Ce defi a-t-il ete releve ? Une ligne d'origine ne compte pas pour une. */
export function defiReleve(epreuve: string): boolean {
  for (const m of manches.values()) {
    if (m.epreuve === epreuve && m.fin !== null && m.origine !== true) return true;
  }
  return false;
}

export function ouvrirUneManche(o: {
  epreuve: string; partie: number; salon: string; compte: string;
  jeu: Jeu; noms: string; equipe: string[]; origine?: boolean;
}): Manche {
  const ev = {
    t: "manche", id: randomUUID(), epreuve: o.epreuve, partie: o.partie, salon: o.salon,
    compte: o.compte, jeu: o.jeu, noms: o.noms.slice(0, 120),
    equipe: [...new Set([o.compte, ...o.equipe])], at: Date.now(),
    ...(o.origine === true ? { origine: true } : {}),
  };
  inscrire(ev);
  appliquer(ev);
  return manches.get(ev.id)!;
}

/**
 * Ce que la manche a fait, coup par coup, tire des coups de la partie.
 *
 * LA MEILLEURE SOLUTION D'UNE EQUIPE EST CELLE DU MEMBRE QUI A TROUVE LE MIEUX
 * (§19) : une equipe joue une feuille, comme un joueur. Un coup trouve compte
 * pour le mot qui l'a trouve, au score du top.
 */
export function bilanDeLaManche(
  m: Pick<Manche, "equipe">, coups: readonly PlayedMove[], jouables: number, at = Date.now(),
): FinDeManche {
  const lignes: CoupDeManche[] = coups.map((c) => {
    let prop: CoupDeManche["prop"] = null;
    for (const nom of m.equipe) {
      const p = c.propositions?.[nom];
      if (p !== undefined && (prop === null || p.score > prop.score)) {
        prop = { mot: p.word, dir: p.dir, x: p.x, y: p.y, score: p.score };
      }
    }
    const trouve = c.player !== null && m.equipe.includes(c.player);
    return {
      n: c.n, notation: c.notation, mot: c.word, dir: c.dir, x: c.x, y: c.y, score: c.score,
      farfouille: c.placements.length >= jouables,
      ms: Math.max(0, Math.round(c.ms)), trouve, prop,
    };
  });
  return {
    at,
    temps: lignes.reduce((a, c) => a + c.ms, 0),
    score: lignes.reduce((a, c) => a + (c.prop?.score ?? 0), 0),
    negatif: lignes.reduce((a, c) => a + (c.score - Math.min(c.score, c.prop?.score ?? 0)), 0),
    coups: lignes,
  };
}

/** Clot une manche et l'ecrit. Sans effet sur une manche deja close. */
export function finirLaManche(
  id: string, coups: readonly PlayedMove[], jouables: number, at = Date.now(),
): FinDeManche | null {
  const m = manches.get(id);
  if (m === undefined || m.fin !== null) return null;
  const fin = bilanDeLaManche(m, coups, jouables, at);
  const ev = { t: "fin", manche: id, ...fin };
  inscrire(ev);
  appliquer(ev);
  return fin;
}

// -------------------------------------------------------------- classements

export interface LigneDeResultat {
  manche: string;
  compte: string;
  jeu: Jeu;
  noms: string;
  equipe: string[];
  temps: number;
  negatif: number;
  score: number;
  coups: number;
  /** Jouee avant la fermeture de l'epreuve. */
  aTemps: boolean;
  at: number;
  /** Jouee par qui avait vu la partie d'avance : hors classement. */
  apercu: boolean;
}

/** Une manche close a-t-elle ete jouee a temps ? */
function aTemps(m: Manche): boolean {
  // UN DEFI N'EXPIRE PAS (SPEC.md §29) : toutes ses manches sont a temps.
  if (m.epreuve.startsWith("defi:")) return true;
  if (m.fin === null) return true;
  const t = tournoiDeLEpreuve(m.epreuve);
  if (t !== undefined) return t.fin === null || m.fin.at <= t.fin;
  const e = lireLEpreuve(m.epreuve);
  return e === null || jourDe(m.fin.at) <= e.jour;
}

/** La manche est-elle jouee par quelqu'un qui avait vu CETTE partie figee ? */
function vueDAvance(m: Manche): boolean {
  const figee = partiesDeLEpreuve(m.epreuve)?.find((p) => p.n === m.partie)?.figee;
  if (figee === undefined) return false;
  return m.equipe.some((nom) => apercus.has(`${figee}|${nom}`));
}

function ligneDe(m: Manche): LigneDeResultat {
  return {
    manche: m.id, compte: m.compte, jeu: m.jeu, noms: m.noms, equipe: m.equipe,
    temps: m.fin!.temps, negatif: m.fin!.negatif, score: m.fin!.score,
    coups: m.fin!.coups.length, aTemps: aTemps(m), at: m.fin!.at, apercu: vueDAvance(m),
  };
}

/**
 * Les resultats d'une partie d'epreuve, tels que la page les lit.
 *
 * LES LIGNES PARTENT A TOUT LE MONDE : un temps et un negatif ne disent pas les
 * mots. LE DETAIL DES COUPS, lui, ne part qu'a qui a fini la partie -- il porte
 * les tops, et ce que chacun a joue.
 */
export function resultatsDeLaPartie(
  epreuve: string, partie: number, pour: string | null, maintenant = Date.now(),
) {
  const closes = [...manches.values()]
    .filter((m) => m.epreuve === epreuve && m.partie === partie && m.fin !== null);
  const mienne = pour === null ? undefined : mancheDuCompte(pour, epreuve, partie);
  const fini = mienne?.fin !== null && mienne !== undefined;
  // DANS UN TOURNOI, ON NE VOIT QUE CE QU'ON A FINI (SPEC.md §29) : les lignes
  // d'une partie a qui l'a jouee, et tout a tout le monde apres la fin.
  const t = tournoiDeLEpreuve(epreuve);
  const cache = t !== undefined && !fini && (t.fin === null || maintenant < t.fin);
  // Une epreuve close est publique, detail compris.
  const ouverte = fini || epreuveClose(epreuve, maintenant);
  return {
    cache,
    lignes: cache ? [] : closes.map(ligneDe),
    moi: {
      manche: mienne?.id ?? null,
      fini,
      enCours: mienne !== undefined && mienne.fin === null,
    },
    details: ouverte ? Object.fromEntries(closes.map((m) => [m.id, m.fin!.coups])) : null,
  };
}

/**
 * L'EPREUVE EST-ELLE CLOSE ? Une journee passee, un tournoi fini.
 *
 * Ce qui est clos est public : ses feuilles de route et ses rejeux s'ouvrent a
 * tout le monde. C'est ce que le palmares suppose -- un solo se revoit, meme par
 * qui n'a pas joue ce jour-la (SPEC.md §29).
 */
export function epreuveClose(epreuve: string, maintenant = Date.now()): boolean {
  const t = tournoiDeLEpreuve(epreuve);
  if (t !== undefined) return t.fin !== null && maintenant >= t.fin;
  const e = lireLEpreuve(epreuve);
  return e !== null && e.jour < jourDe(maintenant);
}

/** La cle d'une ligne de cumul : un compte seul, ou une equipe entiere. */
function cleDeCumul(m: Manche): string {
  if (m.jeu === "equipe") return `equipe:${[...m.equipe].sort().join("+")}`;
  if (m.jeu === "compte") return `compte:${m.compte}:${m.noms}`;
  return `seul:${m.compte}`;
}

/**
 * LE CUMUL DES PARTIES D'UNE EPREUVE (SPEC.md §29).
 *
 * Temps, negatif et score s'additionnent. Le rang, les groupes et le tri se font
 * cote client : ils dependent des cases que le lecteur coche.
 */
export function cumulDeLEpreuve(epreuve: string, pour: string | null, maintenant = Date.now()) {
  const par = new Map<string, LigneDeResultat & { parties: number[]; cle: string }>();
  const t = tournoiDeLEpreuve(epreuve);
  for (const m of manches.values()) {
    if (m.epreuve !== epreuve || m.fin === null) continue;
    const cle = cleDeCumul(m);
    const l = ligneDe(m);
    const deja = par.get(cle);
    if (deja === undefined) {
      par.set(cle, { ...l, cle, parties: [m.partie] });
      continue;
    }
    deja.temps += l.temps;
    deja.negatif += l.negatif;
    deja.score += l.score;
    deja.coups += l.coups;
    deja.aTemps = deja.aTemps && l.aTemps;
    deja.apercu = deja.apercu || l.apercu;
    deja.parties.push(m.partie);
  }
  const miennes = pour === null ? []
    : [...manches.values()].filter((m) => m.epreuve === epreuve && m.equipe.includes(pour));
  // Le General d'un tournoi s'ouvre a qui a tout joue, et a tous apres la fin.
  const toutJoue = t !== undefined && t.parties.every((p) =>
    miennes.some((m) => m.partie === p.n && m.fin !== null));
  const cache = t !== undefined && !toutJoue && (t.fin === null || maintenant < t.fin);
  return {
    cache,
    lignes: cache ? [] : [...par.values()],
    moi: miennes.map((m) => ({
      partie: m.partie, fini: m.fin !== null,
      temps: m.fin?.temps ?? null, negatif: m.fin?.negatif ?? null, score: m.fin?.score ?? null,
    })),
  };
}


// ------------------------------------------------- les medailles et les solos
//
// Voir SPEC.md §29. Les deux se calculent sur les JOURNEES CLOSES, et sur les
// seules manches jouees a temps : une partie rejouee le lendemain ne prend de
// medaille a personne, et ne prive personne de son solo.

/** Le palmares d'un joueur : ses trois metaux. */
export interface Medailles {
  compte: string;
  or: number;
  argent: number;
  bronze: number;
}

/** Un coup que personne d'autre n'a trouve, ce jour-la. */
export interface Solo {
  jour: string;
  lexique: string;
  partie: number;
  /** Le numero du coup. */
  coup: number;
  mot: string;
  dir: Dir;
  x: number;
  y: number;
  score: number;
  /** Qui l'a trouve : un compte, ou les membres d'une equipe. */
  equipe: string[];
  /** La manche ou le revoir. */
  manche: string;
  /** Combien de joueurs ont joue cette partie a temps. */
  joueurs: number;
}

/** Il en faut dix pour qu'un solo veuille dire quelque chose (SPEC.md §29). */
export const JOUEURS_POUR_UN_SOLO = 10;

/** Les manches closes, a temps et hors apercu, d'une partie d'un jour. */
function manchesQuiComptent(epreuve: string, partie: number): Manche[] {
  return [...manches.values()].filter((m) => m.epreuve === epreuve && m.partie === partie
    && m.fin !== null && aTemps(m) && !vueDAvance(m));
}

/** Les jours clos d'un lexique, du plus ancien au plus recent. */
function joursClos(lexique: string | undefined, depuis: string | null, maintenant: number): JourDePdj[] {
  const aujourdhui = jourDe(maintenant);
  return [...jours.values()]
    .filter((j) => j.jour < aujourdhui && (lexique === undefined || j.lexique === lexique)
      && (depuis === null || j.jour >= depuis))
    .sort((a, b) => (a.jour < b.jour ? -1 : 1));
}

/**
 * LE CLASSEMENT DES MEDAILLES (SPEC.md §29).
 *
 * Les trois premiers de chaque partie du jour gardent leur metal a la fermeture
 * de la journee. Deux temps egaux au centieme sont ex aequo : ils prennent le
 * meme metal, et le rang suivant saute d'autant -- deux premiers, puis un
 * troisieme. Une equipe en donne un a chacun de ses membres.
 */
export function classementDesMedailles(
  o: { lexique?: string; depuis?: string | null; maintenant?: number } = {},
): Medailles[] {
  const maintenant = o.maintenant ?? Date.now();
  const par = new Map<string, Medailles>();
  const donner = (compte: string, rang: number): void => {
    const m = par.get(compte) ?? { compte, or: 0, argent: 0, bronze: 0 };
    if (rang === 1) m.or++;
    else if (rang === 2) m.argent++;
    else m.bronze++;
    par.set(compte, m);
  };
  for (const j of joursClos(o.lexique, o.depuis ?? null, maintenant)) {
    const epreuve = epreuveDuJour(j.jour, j.lexique);
    for (const p of j.parties) {
      const lignes = manchesQuiComptent(epreuve, p.n)
        .sort((a, b) => a.fin!.temps - b.fin!.temps);
      let rang = 0, precedent = -1;
      lignes.forEach((m, i) => {
        const centiemes = Math.round(m.fin!.temps / 10);
        if (centiemes !== precedent) { rang = i + 1; precedent = centiemes; }
        if (rang > 3) return;
        for (const nom of m.equipe) donner(nom, rang);
      });
    }
  }
  return [...par.values()].sort((a, b) => b.or - a.or || b.argent - a.argent || b.bronze - a.bronze
    || (a.compte < b.compte ? -1 : 1));
}

/**
 * LA LISTE DES SOLOS (SPEC.md §29) : les coups qu'un seul joueur a trouves.
 *
 * Il faut dix joueurs a temps sur la partie pour qu'un solo compte : a trois, ne
 * pas etre trouve par les deux autres ne dit rien. Les plus recents d'abord.
 */
export function listeDesSolos(
  o: { lexique?: string; depuis?: string | null; maintenant?: number; plafond?: number } = {},
): Solo[] {
  const maintenant = o.maintenant ?? Date.now();
  const out: Solo[] = [];
  for (const j of joursClos(o.lexique, o.depuis ?? null, maintenant)) {
    const epreuve = epreuveDuJour(j.jour, j.lexique);
    for (const p of j.parties) {
      const lignes = manchesQuiComptent(epreuve, p.n);
      if (lignes.length < JOUEURS_POUR_UN_SOLO) continue;
      const combien = lignes[0]!.fin!.coups.length;
      for (let i = 0; i < combien; i++) {
        const trouveurs = lignes.filter((m) => m.fin!.coups[i]?.trouve === true);
        if (trouveurs.length !== 1) continue;
        const m = trouveurs[0]!;
        const c = m.fin!.coups[i]!;
        out.push({
          jour: j.jour, lexique: j.lexique, partie: p.n, coup: c.n, mot: c.mot,
          dir: c.dir, x: c.x, y: c.y, score: c.score,
          equipe: m.equipe, manche: m.id, joueurs: lignes.length,
        });
      }
    }
  }
  out.reverse();
  return out.slice(0, o.plafond ?? 300);
}

/**
 * LES MANCHES D'UN JOUEUR, de la plus recente a la plus ancienne (SPEC.md §30).
 *
 * Tout ce qui s'est joue en epreuve : parties du jour, tournois, defis. Les
 * parties de salon ordinaires ont leur journal a elles.
 */
export function manchesDe(nom: string, plafond = 300): {
  type: "pdj" | "tournoi" | "defi";
  manche: string;
  at: number;
  config: ConfigSerialisee | null;
  /** D'ou vient la partie : un jour, un tournoi, un defi. */
  dou: string;
  partie: number;
  temps: number;
  negatif: number;
  score: number;
  coups: number;
  equipe: string[];
  defi?: string;
  tournoi?: string;
}[] {
  const out = [];
  for (const m of manches.values()) {
    if (m.fin === null || !m.equipe.includes(nom)) continue;
    const d = defiDeLEpreuve(m.epreuve);
    const t = tournoiDeLEpreuve(m.epreuve);
    const j = lireLEpreuve(m.epreuve);
    const p = partiesDeLEpreuve(m.epreuve)?.find((x) => x.n === m.partie);
    if (d === undefined && t === undefined && j === null) continue;
    // UN DEFI QUE PERSONNE N'A RELEVE N'EST PAS UNE PARTIE JOUEE (SPEC.md §29) :
    // la ligne d'origine n'est que le temps a battre.
    if (d !== undefined && m.origine === true && !defiReleve(m.epreuve)) continue;
    out.push({
      type: (d !== undefined ? "defi" : t !== undefined ? "tournoi" : "pdj") as
        "pdj" | "tournoi" | "defi",
      manche: m.id, at: m.fin.at, config: p?.config ?? null,
      dou: d?.nom ?? t?.nom ?? j?.jour ?? "", partie: m.partie,
      // De quoi ouvrir le classement depuis l'historique, sans le rejeu.
      ...(d === undefined ? {} : { defi: d.id }),
      ...(t === undefined ? {} : { tournoi: t.id }),
      temps: m.fin.temps, negatif: m.fin.negatif,
      score: m.fin.coups.reduce((a, c) => a + c.score, 0), coups: m.fin.coups.length,
      equipe: m.equipe,
    });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, plafond);
}

/** Tous ceux qui ont fini cette partie d'epreuve, equipiers compris. */
export function ceuxQuiOntFini(epreuve: string, partie: number): string[] {
  const noms = new Set<string>();
  for (const m of manches.values()) {
    if (m.epreuve !== epreuve || m.partie !== partie || m.fin === null) continue;
    for (const nom of m.equipe) noms.add(nom);
  }
  return [...noms];
}

/** Un identifiant de salon sur, et propre a ce compte sur cette partie. */
export function salonDeLaPartie(epreuve: string, partie: number, compte: string): string {
  const empreinte = createHash("sha1").update(compte).digest("hex").slice(0, 8);
  const d = defiDeLEpreuve(epreuve);
  if (d !== undefined) return `defi-${d.id.slice(0, 8)}-${empreinte}`;
  const t = tournoiDeLEpreuve(epreuve);
  if (t !== undefined) return `tournoi-${t.id.slice(0, 8)}-p${partie}-${empreinte}`;
  const e = lireLEpreuve(epreuve);
  const lexique = e?.lexique ?? "x";
  return `pdj-${e?.jour ?? "jour"}-${lexique}-p${partie}-${empreinte}`;
}

// ------------------------------------- les modeles de la semaine

const cleDeLaSemaine = (lexique: string, jour: number): string => `${lexique}|${jour}`;

/** Les consignes d'un lexique pour un jour de la semaine, si elles existent. */
export function consignesDeLaSemaine(lexique: string, jour: number): ConsigneDePartie[] | undefined {
  const c = semaine.get(cleDeLaSemaine(lexique, jour));
  return c === undefined || c.length === 0 ? undefined : c;
}

/** Les sept jours d'un lexique, du lundi au dimanche. */
export function laSemaineDe(lexique: string): (ConsigneDePartie[] | null)[] {
  return JOURS_DE_LA_SEMAINE.map((_, j) => consignesDeLaSemaine(lexique, j) ?? null);
}

/**
 * CE QUI DECIDE DES PARTIES D'UN JOUR (SPEC.md §29) : les consignes de son jour
 * de la semaine, et a defaut les parties d'office du lexique.
 */
export function consignesPourLeJour(jour: string, lexique: string): ConsigneDePartie[] {
  return consignesDeLaSemaine(lexique, jourDeLaSemaine(jour))
    ?? (PARTIES_DU_JOUR[lexique] ?? []).map(consigneExacte);
}

/**
 * Ecrit les consignes d'un jour de la semaine. C'est persistant : tous les
 * lundis suivants suivront celles du lundi. Rien ne se refige ici -- les
 * parties de demain sont deja tirees, et « Tout retirer » les retire.
 */
export function reglerLaSemaine(
  lexique: string, jour: number, consignes: ConsigneDePartie[], par: string,
): void {
  const ev = { t: "semaine", lexique, jour, consignes, par, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
  console.log(`[competitif] ${JOURS_DE_LA_SEMAINE[jour]} (${lexique}) : `
    + `${consignes.length} partie(s) par ${par}`);
}

// ------------------------------------- les tournois de la semaine

/**
 * UN TOURNOI QUI REVIENT CHAQUE SEMAINE. Ses horaires ne se reglent pas : il
 * commence a 5 h 30 le matin de `jourDebut`, et finit a 5 h 30 le lendemain de
 * `jourFin`. `du dimanche au dimanche` est donc la journee du dimanche.
 */
export interface ModeleHebdo {
  id: string;
  nom: string;
  lexique: string;
  equipe: number;
  /** 0 pour lundi, 6 pour dimanche. */
  jourDebut: number;
  jourFin: number;
  consignes: ConsigneDePartie[];
  actif: boolean;
  par: string;
  at: number;
}

export function tousLesModelesHebdo(): ModeleHebdo[] {
  return [...hebdos.values()].sort((a, b) => a.jourDebut - b.jourDebut || a.at - b.at);
}

export function modeleHebdo(id: string): ModeleHebdo | undefined {
  return hebdos.get(id);
}

/** Cree un modele hebdomadaire, ou reecrit celui dont l'identifiant est donne. */
export function ecrireUnModeleHebdo(o: {
  id?: string; nom: string; lexique: string; equipe: number;
  jourDebut: number; jourFin: number; consignes: ConsigneDePartie[]; actif: boolean; par: string;
}): ModeleHebdo {
  const ancien = o.id === undefined ? undefined : hebdos.get(o.id);
  const ev = {
    t: "hebdo", id: ancien?.id ?? randomUUID(), nom: o.nom, lexique: o.lexique, equipe: o.equipe,
    jourDebut: o.jourDebut, jourFin: o.jourFin, consignes: o.consignes, actif: o.actif,
    par: ancien?.par ?? o.par, at: ancien?.at ?? Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
  console.log(`[competitif] tournoi de la semaine "${o.nom}" `
    + `${ancien === undefined ? "cree" : "modifie"} par ${o.par}`);
  return hebdos.get(ev.id)!;
}

/** Retire un modele hebdomadaire. Les instances deja nees restent. */
export function supprimerUnModeleHebdo(id: string, par: string): void {
  const ev = { t: "hebdo-supprime", id, par, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
}

/**
 * FAIT NAITRE LES INSTANCES DE LA SEMAINE, la veille de leur debut comme les
 * parties du lendemain : le tournoi parait avec ses dates, et l'on peut s'y
 * inscrire avant qu'il commence.
 *
 * Une instance supprimee ne renait pas : le journal garde qu'elle a existe.
 */
export function assurerLesTournoisDeLaSemaine(
  layout: LayoutName, maintenant = Date.now(),
): Promise<void> {
  return unParUn(async () => {
    const aujourdhui = jourDe(maintenant);
    for (const m of hebdos.values()) {
      if (!m.actif || m.consignes.length === 0) continue;
      for (const jour of [aujourdhui, decalerLeJour(aujourdhui, 1)]) {
        if (jourDeLaSemaine(jour) !== m.jourDebut) continue;
        if (hebdosFaits.has(`${m.id}|${jour}`)) continue;
        await naitreUnTournoiDeLaSemaine(m, jour, layout);
      }
    }
  });
}

async function naitreUnTournoiDeLaSemaine(
  m: ModeleHebdo, jour: string, layout: LayoutName,
): Promise<void> {
  const parties: PartieDEpreuve[] = [];
  for (let i = 0; i < m.consignes.length; i++) {
    const f = await figerUnePartie(configDuModele(tirerUneConsigne(m.consignes[i]!), m.lexique), layout);
    ecrireLaPartieFigee(DATA_DIR, f);
    parties.push({ n: i + 1, figee: f.id, config: f.config });
  }
  const dernier = decalerLeJour(jour, joursEntre(m.jourDebut, m.jourFin) + 1);
  const ev = {
    t: "tournoi", id: randomUUID(), type: "topping", nom: m.nom, lexique: m.lexique,
    debut: debutDuJour(jour), fin: debutDuJour(dernier), equipe: m.equipe,
    parties, battle: null, par: m.par, at: Date.now(), hebdo: { modele: m.id, jour },
  };
  inscrire(ev);
  appliquer(ev);
  console.log(`[competitif] "${m.nom}" du ${jour} : ${parties.length} partie(s) figees`);
}

// ------------------------------------------------------------------ defis

/**
 * UN DEFI : une partie qu'on a jouee et qu'on fait circuler (SPEC.md §29).
 *
 * C'est une troisieme sorte d'epreuve, `defi:<id>`, avec une seule partie. Tout
 * ce qui lit les manches -- classement, feuille de route, graphiques, rejeu --
 * marche dessus sans rien changer.
 */
export interface Defi {
  id: string;
  /** Le salon et la graine de la partie d'origine : un jeu, un defi. */
  salon: string;
  graine: string;
  /** Le nom du salon d'origine, pour dire d'ou vient la partie. */
  nom: string;
  figee: string;
  config: ConfigSerialisee;
  par: string;
  at: number;
}

export const epreuveDuDefi = (id: string): string => `defi:${id}`;

export function defi(id: string): Defi | undefined {
  return defis.get(id);
}

export function defiDeLEpreuve(epreuve: string): Defi | undefined {
  return epreuve.startsWith("defi:") ? defis.get(epreuve.slice("defi:".length)) : undefined;
}

/** Le defi deja ne de cette partie, s'il existe : une partie n'en donne qu'un. */
export function defiDeLaPartie(salon: string, graine: string): Defi | undefined {
  const id = defiParPartie.get(`${salon}|${graine}`);
  return id === undefined ? undefined : defis.get(id);
}

/**
 * CREE LE DEFI D'UNE PARTIE JOUEE, ou rend celui qui existe deja.
 *
 * La partie se refige DEPUIS LA GRAINE de celle d'origine, et s'arrete au coup
 * ou celle-ci s'est arretee. Les joueurs d'origine y prennent leur ligne :
 * une seule pour tous en topping, une chacun en duplicate (SPEC.md §29).
 */
export function creerUnDefi(o: {
  salon: string; graine: string; nom: string; cfg: ConfigPartie; layout: LayoutName;
  coups: number; par: string;
  /** Ce que les joueurs d'origine ont fait : leurs manches, deja finies. */
  lignes: { equipe: string[]; jeu: Jeu; bilan: FinDeManche }[];
}): Promise<Defi> {
  return unParUn(async () => {
    const deja = defiDeLaPartie(o.salon, o.graine);
    if (deja !== undefined) return deja;
    const f = await figerUnePartie(o.cfg, o.layout, o.graine, o.coups);
    ecrireLaPartieFigee(DATA_DIR, f);
    const ev = {
      t: "defi", id: randomUUID(), salon: o.salon, graine: o.graine, nom: o.nom,
      figee: f.id, config: f.config, par: o.par, at: Date.now(),
    };
    inscrire(ev);
    appliquer(ev);
    // LES JOUEURS D'ORIGINE ONT LEUR LIGNE, ecrite tout de suite : le defi
    // n'aurait aucun sens sans le temps a battre.
    const epreuve = epreuveDuDefi(ev.id);
    for (const [i, l] of o.lignes.entries()) {
      const m = ouvrirUneManche({
        epreuve, partie: 1, salon: `${o.salon}#origine${i}`, compte: l.equipe[0] ?? "",
        jeu: l.jeu, noms: "", equipe: l.equipe, origine: true,
      });
      const fin = {
        t: "fin", manche: m.id, at: Date.now(), temps: l.bilan.temps,
        negatif: l.bilan.negatif, score: l.bilan.score, coups: l.bilan.coups,
      };
      inscrire(fin);
      appliquer(fin);
    }
    console.log(`[competitif] defi "${o.nom}" cree par ${o.par} : `
      + `${f.coups.length} coups, ${o.lignes.length} ligne(s) d'origine`);
    return defis.get(ev.id)!;
  });
}

// ------------------------------------------ l'administration des parties du jour

/** Les changements d'administration passent un par un : ils figent, et durent. */
let fileDAdministration: Promise<unknown> = Promise.resolve();

function unParUn<T>(f: () => Promise<T>): Promise<T> {
  const suite = fileDAdministration.then(f, f);
  fileDAdministration = suite.catch(() => undefined);
  return suite;
}

export type ChangementDuJour =
  | { action: "nombre"; nombre: number }
  | { action: "retirer" }
  | { action: "graine"; partie: number }
  | { action: "reglages"; partie: number; consigne: ConsigneDePartie };

/**
 * CHANGE LES PARTIES DE DEMAIN (SPEC.md §29), et seulement celles-la : celles
 * d'aujourd'hui ont paru, des joueurs les ont peut-etre deja jouees.
 *
 * Chaque partie touchee se refige entiere, pour que l'apercu soit immediat et la
 * parution certaine. La ligne du jour se reecrit au journal -- la derniere fait
 * foi -- avec ce qui l'a changee et par qui.
 */
export function changerLesPartiesDeDemain(
  lexique: string, changement: ChangementDuJour, par: string, layout: LayoutName,
  maintenant = Date.now(),
): Promise<JourDePdj | string> {
  return unParUn(async () => {
    const demain = decalerLeJour(jourDe(maintenant), 1);
    const j = partiesDuJour(demain, lexique);
    if (j === undefined) return "Les parties de demain se préparent, réessayez dans un instant";
    const figer = async (n: number, m: ModeleDePartie): Promise<PartieDEpreuve> => {
      const f = await figerUnePartie(configDuModele(m, lexique), layout);
      ecrireLaPartieFigee(DATA_DIR, f);
      return { n, figee: f.id, config: f.config };
    };
    // LES CONSIGNES DU JOUR DE LA SEMAINE, quand il y en a : une partie qu'on
    // ajoute ou qu'on retire obeit a la regle du jour (SPEC.md §29).
    const regles = consignesDeLaSemaine(lexique, jourDeLaSemaine(demain));
    let parties: PartieDEpreuve[];
    if (changement.action === "nombre") {
      const n = Math.round(changement.nombre);
      if (!Number.isInteger(n) || n < 1 || n > 8) return "de 1 à 8 parties";
      parties = j.parties.slice(0, n);
      for (let i = parties.length; i < n; i++) {
        const c = regles?.[i];
        parties.push(await figer(i + 1, c === undefined
          ? (PARTIES_DU_JOUR[lexique]?.[i] ?? tirerUnModele()) : tirerUneConsigne(c)));
      }
    } else if (changement.action === "retirer") {
      parties = [];
      if (regles !== undefined) {
        for (let i = 0; i < regles.length; i++) parties.push(await figer(i + 1, tirerUneConsigne(regles[i]!)));
      } else {
        for (let i = 0; i < j.parties.length; i++) parties.push(await figer(i + 1, tirerUnModele()));
      }
    } else {
      const k = j.parties.findIndex((p) => p.n === changement.partie);
      if (k === -1) return "cette partie n'existe pas";
      const modele = changement.action === "graine"
        ? modeleDeLaConfig(j.parties[k]!.config) : tirerUneConsigne(changement.consigne);
      parties = [...j.parties];
      parties[k] = await figer(changement.partie, modele);
    }
    const ev = { t: "pdj", jour: demain, lexique, parties, at: Date.now(), par, motif: changement.action };
    inscrire(ev);
    appliquer(ev);
    // Le nombre de parties et le geste, rien d'autre.
    console.log(`[competitif] parties du ${demain} (${lexique}) changees par ${par} : ${changement.action}`);
    return partiesDuJour(demain, lexique)!;
  });
}

/**
 * L'APERCU D'UNE PARTIE DE DEMAIN, et la trace qu'il laisse : qui l'a ouvert la
 * joue ensuite hors classement (SPEC.md §29).
 */
export function apercuDeDemain(lexique: string, partie: number, par: string, maintenant = Date.now()) {
  const demain = decalerLeJour(jourDe(maintenant), 1);
  const p = partiesDuJour(demain, lexique)?.parties.find((x) => x.n === partie);
  if (p === undefined) return null;
  const f = partieFigee(p.figee);
  if (f === null) return null;
  const epreuve = epreuveDuJour(demain, lexique);
  if (!apercus.has(`${p.figee}|${par}`)) {
    const ev = { t: "apercu", epreuve, partie, figee: p.figee, par, at: Date.now() };
    inscrire(ev);
    appliquer(ev);
  }
  return { jour: demain, partie, config: f.config, coups: f.coups, fin: f.fin };
}

/**
 * Les parties de demain que ce compte a deja regardees. Une partie retiree
 * depuis n'y figure plus : ce n'est plus la meme partie.
 */
export function apercusDe(par: string, lexique: string, maintenant = Date.now()): number[] {
  const j = partiesDuJour(decalerLeJour(jourDe(maintenant), 1), lexique);
  return (j?.parties ?? []).filter((p) => apercus.has(`${p.figee}|${par}`)).map((p) => p.n);
}

// ------------------------------------------------------------------ tournois

/** Ce qu'un tournoi montre a tout le monde. */
export function tournoiPublic(t: Tournoi) {
  return {
    id: t.id, type: t.type, nom: t.nom, lexique: t.lexique, debut: t.debut, fin: t.fin,
    equipe: t.equipe, parties: t.parties.map((p) => ({ n: p.n, config: p.config })),
    battle: t.battle, par: t.par, at: t.at, hebdo: t.hebdo,
    inscrits: t.inscrits.map((i) => ({ compte: i.compte, noms: i.noms, partenaires: i.partenaires })),
  };
}

export function tousLesTournois(): Tournoi[] {
  return [...tournois.values()].sort((a, b) => a.debut - b.debut);
}

export function tournoi(id: string): Tournoi | undefined {
  return tournois.get(id);
}

/**
 * CREE UN TOURNOI DE TOPPING. Les reglages arrivent deja verifies ; ses parties
 * se figent ici, TOUTES, avant que le tournoi n'existe (SPEC.md §29).
 */
export function creerUnTournoiDeTopping(o: {
  nom: string; lexique: string; debut: number; fin: number; equipe: number;
  modeles: ModeleDePartie[]; par: string;
}, layout: LayoutName): Promise<Tournoi> {
  return unParUn(async () => {
    const parties: PartieDEpreuve[] = [];
    for (let i = 0; i < o.modeles.length; i++) {
      const f = await figerUnePartie(configDuModele(o.modeles[i]!, o.lexique), layout);
      ecrireLaPartieFigee(DATA_DIR, f);
      parties.push({ n: i + 1, figee: f.id, config: f.config });
    }
    const ev = {
      t: "tournoi", id: randomUUID(), type: "topping", nom: o.nom, lexique: o.lexique,
      debut: o.debut, fin: o.fin, equipe: o.equipe, parties, battle: null, par: o.par, at: Date.now(),
      hebdo: null,
    };
    inscrire(ev);
    appliquer(ev);
    console.log(`[competitif] tournoi de topping "${o.nom}" cree par ${o.par} : ${parties.length} partie(s)`);
    return tournois.get(ev.id)!;
  });
}

/**
 * UN TOURNOI SE MODIFIE TANT QU'IL N'A PAS COMMENCE (SPEC.md §29), et par celui
 * qui l'a cree. Apres, il a des manches jouees : ses reglages sont figes.
 */
export function tournoiModifiable(t: Tournoi, compte: string, admin: boolean, maintenant = Date.now()): string | null {
  if (t.par !== compte && !admin) return "Seul son créateur modifie ce tournoi";
  // UN BATTLE RESTE OUVERT APRES SON DEBUT (SPEC.md §29). L'organisateur ne
  // sait combien de poules faire qu'une fois qu'il sait qui est venu : ce sont
  // les poules tirees qui ferment ses reglages, et non l'horloge.
  if (t.type === "battle") {
    return poules.has(t.id) ? "Les poules sont tirées : ces réglages ne changent plus" : null;
  }
  if (maintenant >= t.debut) return "Le tournoi a commencé : ses réglages ne changent plus";
  return null;
}

/** Reecrit les reglages d'un tournoi de topping, et refige toutes ses parties. */
export function modifierUnTournoiDeTopping(t: Tournoi, o: {
  nom: string; lexique: string; debut: number; fin: number; equipe: number; modeles: ModeleDePartie[];
}, layout: LayoutName): Promise<Tournoi> {
  return unParUn(async () => {
    const parties: PartieDEpreuve[] = [];
    for (let i = 0; i < o.modeles.length; i++) {
      const f = await figerUnePartie(configDuModele(o.modeles[i]!, o.lexique), layout);
      ecrireLaPartieFigee(DATA_DIR, f);
      parties.push({ n: i + 1, figee: f.id, config: f.config });
    }
    const ev = {
      t: "tournoi", id: t.id, type: "topping", nom: o.nom, lexique: o.lexique,
      debut: o.debut, fin: o.fin, equipe: o.equipe, parties, battle: null, par: t.par, at: t.at,
      hebdo: t.hebdo, modifieLe: Date.now(),
    };
    inscrire(ev);
    appliquer(ev);
    console.log(`[competitif] tournoi "${o.nom}" modifie : ${parties.length} partie(s) refigees`);
    return tournois.get(t.id)!;
  });
}

/** Reecrit les reglages d'un tournoi de battle. */
export function modifierUnTournoiDeBattle(t: Tournoi, o: {
  nom: string; lexique: string; debut: number; equipe: number; battle: ReglagesBattle;
}): Tournoi {
  const ev = {
    t: "tournoi", id: t.id, type: "battle", nom: o.nom, lexique: o.lexique,
    debut: o.debut, fin: null, equipe: o.equipe, parties: [], battle: o.battle,
    par: t.par, at: t.at, hebdo: null, modifieLe: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
  return tournois.get(t.id)!;
}

/**
 * SUPPRIME UN TOURNOI. Le journal garde sa creation et sa suppression -- rien ne
 * s'efface d'un fichier en ajout seul -- et les manches deja jouees restent au
 * journal ; elles ne se rattachent simplement plus a rien.
 */
export function supprimerUnTournoi(t: Tournoi, par: string): void {
  const ev = { t: "tournoi-supprime", id: t.id, par, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
  console.log(`[competitif] tournoi "${t.nom}" supprime par ${par}`);
}

/**
 * COMBIEN ONT FINI LE TOURNOI : le nombre de lignes qu'aura son General.
 *
 * On compte des EQUIPES et non des comptes, comme le cumul : deux joueurs
 * inscrits ensemble ne font qu'un resultat (SPEC.md §29).
 */
export function finisseursDuTournoi(t: Tournoi): number {
  if (t.type !== "topping" || t.parties.length === 0) return 0;
  const epreuve = epreuveDuTournoi(t.id);
  const par = new Map<string, Set<number>>();
  for (const m of manches.values()) {
    if (m.epreuve !== epreuve || m.fin === null) continue;
    const cle = cleDeCumul(m);
    const faites = par.get(cle) ?? new Set<number>();
    faites.add(m.partie);
    par.set(cle, faites);
  }
  return [...par.values()].filter((faites) => t.parties.every((p) => faites.has(p.n))).length;
}

/** Combien de parties d'un tournoi ce compte a finies. */
export function partiesFiniesDe(t: Tournoi, compte: string): number {
  const epreuve = epreuveDuTournoi(t.id);
  return t.parties.filter((p) => mancheDuCompte(compte, epreuve, p.n)?.fin != null).length;
}

/** Cree un tournoi de battle : ses parties se tirent a chaque manche. */
export function creerUnTournoiDeBattle(o: {
  nom: string; lexique: string; debut: number; equipe: number; battle: ReglagesBattle; par: string;
}): Tournoi {
  const ev = {
    t: "tournoi", id: randomUUID(), type: "battle", nom: o.nom, lexique: o.lexique,
    debut: o.debut, fin: null, equipe: o.equipe, parties: [], battle: o.battle, par: o.par, at: Date.now(),
    hebdo: null,
  };
  inscrire(ev);
  appliquer(ev);
  console.log(`[competitif] tournoi de battle "${o.nom}" cree par ${o.par}`);
  return tournois.get(ev.id)!;
}

/** L'inscription de ce compte a ce tournoi, comme inscrit ou comme partenaire. */
export function inscriptionDe(t: Tournoi, compte: string): Inscription | undefined {
  return t.inscrits.find((i) => i.compte === compte || i.partenaires.includes(compte));
}

/**
 * INSCRIT UN COMPTE, et ses partenaires nommes par pseudo (SPEC.md §29).
 *
 * Rend le message qui dit ce qui ne va pas, ou `null`. L'existence des comptes
 * nommes se verifie chez l'appelant : ce fichier ne connait pas les comptes.
 */
export function inscrireAuTournoi(
  t: Tournoi, compte: string, noms: string, partenaires: string[], maintenant = Date.now(),
): string | null {
  const closes = t.type === "topping" ? (t.fin !== null && maintenant >= t.fin) : maintenant >= t.debut;
  if (closes) return "Les inscriptions sont closes";
  const tous = [compte, ...partenaires];
  if (new Set(tous).size !== tous.length) return "Un même joueur est nommé deux fois";
  if (partenaires.length > t.equipe - 1) {
    return t.equipe === 1 ? "Ce tournoi se joue seul" : `Une équipe compte ${t.equipe} joueurs au plus`;
  }
  for (const nom of tous) {
    if (inscriptionDe(t, nom) !== undefined) return `${nom} est déjà inscrit`;
  }
  const ev = {
    t: "inscription", tournoi: t.id, compte, noms: noms.trim().slice(0, 120), partenaires,
    at: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
  return null;
}

/** La configuration d'une partie d'epreuve, prete pour un salon. */
export const configDeLaPartie = (p: PartieDEpreuve) => deserialiser(p.config);

// ------------------------------------------------------ les tournois de battle

/**
 * UNE MANCHE DE RENCONTRE : une partie de battle entre deux camps.
 *
 * Elle naît quand le salon s'ouvre, et se clôt quand la partie finit. Entre les
 * deux, `points` vaut `null` : la manche est en cours, et la page du tournoi la
 * montre comme telle.
 */
export interface MancheDeRencontre {
  n: number;
  salon: string;
  /** Les points de chaque camp, dans l'ordre de `camps`. Des demis y figurent. */
  points: [number, number] | null;
  /** Le camp qui l'emporte, `null` pour une manche nulle ou en cours. */
  gagnant: string | null;
  at: number;
  fin: number | null;
}

/**
 * UNE RENCONTRE EST UN OBJET, PAS UNE SEANCE (SPEC.md §29).
 *
 * Elle garde son score entre deux séances : deux joueurs qui se quittent à 1-0
 * sur un meilleur de 3 rouvrent plus tard pour la manche 2, et la rencontre
 * reprend là où elle était. Sans cela, une coupure de réseau annulerait une
 * demi-heure de jeu, et personne ne rejouerait.
 */
export interface Rencontre {
  id: string;
  tournoi: string;
  /** `poule:0` pour la première poule, `haut:0`, `bas:0`, `finale`. */
  phase: string;
  /** Le tour de la poule, ou du tableau. Il numérote les colonnes du classement. */
  tour: number;
  /** Les deux camps, par compte porteur de l'inscription. */
  camps: [string, string];
  /** Meilleur de X en tableau ; le nombre de manches à jouer en poule. */
  bo: number;
  /** La fin normale du tour. */
  limite: number;
  /** Le dernier délai, passé lequel l'arbitrage s'ouvre. */
  butoir: number;
  manches: MancheDeRencontre[];
  /**
   * Comment elle s'est terminée. `gagnant: null` veut dire nulle quand elle
   * vient du jeu, et « personne ne passe » quand elle vient de l'arbitrage.
   */
  fin: { gagnant: string | null; par: "jeu" | "arbitrage"; at: number } | null;
}

export interface MessageDeRencontre {
  de: string;
  texte: string;
  at: number;
}

/** Une ligne du classement d'une poule. */
export interface LigneDePoule {
  camp: string;
  rang: number;
  points: number;
  gagnees: number;
  nulles: number;
  perdues: number;
  manchesGagnees: number;
  manchesPerdues: number;
  /** Le cumul des 1 et des ½ pris coup par coup, sur toutes ses manches. */
  pointsDeManche: number;
  /** Les rencontres jouées, à temps ou non. */
  jouees: number;
}

/** Combien de points rapporte une rencontre de poule (SPEC.md §29). */
export const POINTS_DE_POULE = { victoire: 3, nul: 2, defaite: 1, absent: 0 } as const;

/** Où en est un tournoi de battle. */
export type PhaseDeBattle = "inscriptions" | "poules" | "tableau" | "fini";

export function phaseDuBattle(t: Tournoi): PhaseDeBattle {
  if (t.type !== "battle") return "fini";
  return poulesDuTournoi(t.id) === undefined ? "inscriptions" : "poules";
}

/**
 * MELANGE UNE LISTE, sans biais.
 *
 * `randomInt` plutôt que `Math.random` : le tirage des poules décide d'un
 * tournoi, et le générateur du moteur JavaScript n'est pas fait pour ça.
 */
function melanger<T>(l: T[]): T[] {
  const m = [...l];
  for (let i = m.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [m[i], m[j]] = [m[j]!, m[i]!];
  }
  return m;
}

/**
 * TIRE DES POULES AUSSI EGALES QUE POSSIBLE.
 *
 * Onze inscrits par poules de quatre donnent 4, 4 et 3, et non 4, 4, 3 dans cet
 * ordre-là seulement : on distribue en serpentin, chaque poule prenant à son
 * tour. L'administrateur les retouche ensuite à la main (SPEC.md §29).
 */
export function tirerDesPoules(camps: string[], parPoule: number): string[][] {
  if (camps.length === 0) return [];
  const combien = Math.max(1, Math.ceil(camps.length / Math.max(1, parPoule)));
  const poules: string[][] = Array.from({ length: combien }, () => []);
  melanger(camps).forEach((c, i) => { poules[i % combien]!.push(c); });
  return poules;
}

/**
 * LES RONDES D'UN TOUS-CONTRE-TOUS, par la méthode du cercle.
 *
 * Un camp fictif complète un effectif impair : celui qui se retrouve en face de
 * lui est exempt de cette ronde, et ne joue simplement pas.
 */
export function rondesDeLaPoule(camps: string[]): [string, string][][] {
  const l = [...camps];
  if (l.length < 2) return [];
  if (l.length % 2 === 1) l.push("");
  const n = l.length;
  const rondes: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const ronde: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = l[i]!, b = l[n - 1 - i]!;
      // On alterne qui reçoit d'une ronde à l'autre : sans cela, le premier de
      // la liste serait toujours le camp de gauche.
      if (a !== "" && b !== "") ronde.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rondes.push(ronde);
    l.splice(1, 0, l.pop()!);
  }
  return rondes;
}

export const poulesDuTournoi = (id: string): string[][] | undefined => poules.get(id);
export const rencontreParId = (id: string): Rencontre | undefined => rencontres.get(id);
export const enteteDuTournoi = (id: string): string => entetes.get(id) ?? "";
export const disposDe = (tournoi: string, compte: string): string =>
  dispos.get(`${tournoi}|${compte}`) ?? "";
export const messagesDeLaRencontre = (id: string): MessageDeRencontre[] =>
  messages.get(id) ?? [];

/** Toutes les rencontres d'un tournoi, dans l'ordre où elles ont été écrites. */
export function rencontresDuTournoi(id: string): Rencontre[] {
  return [...rencontres.values()].filter((r) => r.tournoi === id);
}

/** La rencontre et la manche que sert ce salon, s'il en sert une. */
export function rencontreDuSalon(salon: string): { rencontre: Rencontre; n: number } | undefined {
  const cle = rencontreParSalon.get(salon);
  if (cle === undefined) return undefined;
  const r = rencontres.get(cle.rencontre);
  return r === undefined ? undefined : { rencontre: r, n: cle.n };
}

/** Le camp d'un compte dans une rencontre : 0, 1, ou -1 s'il n'y joue pas. */
export function campDuCompte(t: Tournoi, r: Rencontre, compte: string): number {
  for (let i = 0; i < 2; i++) {
    const porteur = r.camps[i]!;
    const ins = t.inscrits.find((x) => x.compte === porteur);
    if (ins === undefined) continue;
    if (ins.compte === compte || ins.partenaires.includes(compte)) return i;
  }
  return -1;
}

/** Tous les pseudos d'un camp : le porteur de l'inscription et ses partenaires. */
export function joueursDuCamp(t: Tournoi, camp: string): string[] {
  const ins = t.inscrits.find((x) => x.compte === camp);
  return ins === undefined ? [camp] : [ins.compte, ...ins.partenaires];
}

/**
 * ECRIT LES POULES ET TOUTES LEURS RENCONTRES (SPEC.md §29).
 *
 * C'est le geste qui ferme les inscriptions pour de bon : après lui, on ne se
 * désinscrit plus, et les réglages de poule ne changent plus.
 */
export function lancerLesPoules(
  t: Tournoi, lesPoules: string[][], par: string,
): Rencontre[] {
  const b = t.battle;
  if (b === null) throw new Error("ce tournoi n'est pas un battle");
  const ev = {
    t: "poules", tournoi: t.id, poules: lesPoules.map((p) => [...p]), par, at: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);

  const nees: Rencontre[] = [];
  // LES DEUX DATES D'UNE RENCONTRE DE POULE sont celles de la poule entière :
  // rien n'oblige à jouer les rondes dans l'ordre, et les imposer ferait
  // attendre deux joueurs disponibles tout de suite.
  const limite = b.limitePoules;
  const butoir = limite + b.joursParTour * 86_400_000;
  lesPoules.forEach((poule, i) => {
    const rondes = rondesDeLaPoule(poule);
    const combien = b.rencontresParPoule === null
      ? rondes.length : Math.min(rondes.length, b.rencontresParPoule);
    for (let tour = 0; tour < combien; tour++) {
      for (const [a, c] of rondes[tour]!) {
        const r = {
          t: "rencontre", id: randomUUID(), tournoi: t.id, phase: `poule:${i}`,
          tour: tour + 1, camps: [a, c], bo: b.manchesParPoule, limite, butoir,
          at: Date.now(),
        };
        inscrire(r);
        appliquer(r);
        nees.push(rencontres.get(r.id)!);
      }
    }
  });
  console.log(`[competitif] ${lesPoules.length} poule(s) et ${nees.length} rencontre(s) pour "${t.nom}"`);
  return nees;
}

/** Ouvre une manche de rencontre : le salon est noté avant qu'on y joue. */
export function ouvrirUneMancheDeRencontre(r: Rencontre, salon: string): MancheDeRencontre {
  const n = r.manches.length + 1;
  const ev = { t: "manche-rencontre", rencontre: r.id, n, salon, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
  return r.manches[r.manches.length - 1]!;
}

/**
 * CLOT UNE MANCHE DE RENCONTRE et, si le compte y est, la rencontre.
 *
 * Le premier qui trouve le top prend 1 point ; un top que personne ne trouve en
 * donne ½ à chacun. Le total des deux fait donc toujours le nombre de coups.
 */
export function finirUneMancheDeRencontre(
  t: Tournoi, r: Rencontre, n: number, coups: PlayedMove[],
): void {
  const m = r.manches.find((x) => x.n === n);
  if (m === undefined || m.fin !== null) return;
  const points: [number, number] = [0, 0];
  for (const c of coups) {
    if (c.player === null) { points[0] += 0.5; points[1] += 0.5; continue; }
    const camp = campDuCompte(t, r, c.player);
    if (camp >= 0) points[camp]! += 1;
  }
  const gagnant = points[0] === points[1] ? null : (points[0] > points[1] ? r.camps[0] : r.camps[1]);
  const ev = {
    t: "fin-rencontre", rencontre: r.id, n, points, gagnant, at: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
  conclureLaRencontre(r);
}

/**
 * LA RENCONTRE EST-ELLE FINIE ? On la clôt dès qu'un camp ne peut plus être
 * rejoint, et non à la dernière manche : un 2-0 sur un meilleur de 3 ne se
 * prolonge pas.
 */
function conclureLaRencontre(r: Rencontre): void {
  if (r.fin !== null) return;
  const faites = r.manches.filter((m) => m.fin !== null && m.points !== null);
  const gagnees = (camp: string) => faites.filter((m) => m.gagnant === camp).length;
  const [a, b] = r.camps;
  const enPoule = r.phase.startsWith("poule:");
  const reste = r.bo - faites.length;
  let gagnant: string | null | undefined;
  if (enPoule) {
    // EN POULE, ON JOUE TOUTES LES MANCHES : elles comptent au départage, et
    // une rencontre peut finir nulle.
    if (reste > 0) return;
    gagnant = gagnees(a) === gagnees(b) ? null : (gagnees(a) > gagnees(b) ? a : b);
  } else {
    // EN TABLEAU, UNE MANCHE NULLE NE COMPTE PAS : elle se rejoue, et il faut
    // toujours la majorité des manches décisives.
    const seuil = Math.floor(r.bo / 2) + 1;
    if (gagnees(a) >= seuil) gagnant = a;
    else if (gagnees(b) >= seuil) gagnant = b;
    else return;
  }
  const ev = { t: "rencontre-finie", rencontre: r.id, gagnant, par: "jeu", at: Date.now() };
  inscrire(ev);
  appliquer(ev);
}

/**
 * UNE MANCHE ABANDONNEE NE SE REPREND PAS : sa partie est close, et l'on en
 * ouvre une neuve. La rencontre, elle, garde le score qu'elle avait.
 */
export function annulerLaMancheDeRencontre(r: Rencontre, n: number): void {
  const m = r.manches.find((x) => x.n === n);
  if (m === undefined || m.fin !== null) return;
  const ev = { t: "manche-annulee", rencontre: r.id, n, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
}

/** L'arbitrage d'une rencontre non jouée (SPEC.md §29). */
export function arbitrerLaRencontre(r: Rencontre, o: {
  quoi: "victoire" | "personne" | "delai"; qui?: string; butoir?: number; par: string;
}): string | null {
  if (o.quoi === "delai") {
    if (o.butoir === undefined || !Number.isFinite(o.butoir)) return "Il faut une date";
    const ev = { t: "rencontre-butoir", rencontre: r.id, butoir: o.butoir, par: o.par, at: Date.now() };
    inscrire(ev);
    appliquer(ev);
    return null;
  }
  if (r.fin !== null) return "Cette rencontre est déjà tranchée";
  const gagnant = o.quoi === "personne" ? null : (o.qui ?? "");
  if (o.quoi === "victoire" && !r.camps.includes(gagnant!)) return "Ce camp ne joue pas cette rencontre";
  const ev = {
    t: "rencontre-finie", rencontre: r.id, gagnant, par: "arbitrage", at: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
  return null;
}

/**
 * DECLARE UN FORFAIT : le camp quitte le tournoi, et toutes ses rencontres
 * restantes sont perdues d'un coup.
 */
export function declarerUnForfait(t: Tournoi, camp: string, par: string): number {
  let faites = 0;
  for (const r of rencontresDuTournoi(t.id)) {
    if (r.fin !== null || !r.camps.includes(camp)) continue;
    const autre = r.camps[0] === camp ? r.camps[1]! : r.camps[0]!;
    const ev = {
      t: "rencontre-finie", rencontre: r.id, gagnant: autre, par: "arbitrage",
      forfait: camp, at: Date.now(),
    };
    inscrire(ev);
    appliquer(ev);
    faites++;
  }
  console.log(`[competitif] forfait de ${camp} sur "${t.nom}" par ${par} : ${faites} rencontre(s)`);
  return faites;
}

/** Un message de créneau, gardé pour l'adversaire et pour l'arbitrage. */
export function ecrireUnMessageDeRencontre(r: Rencontre, de: string, texte: string): void {
  const ev = {
    t: "message", rencontre: r.id, de, texte: texte.trim().slice(0, 600), at: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
}

/** Les disponibilités d'un joueur, écrites une fois pour tout le tournoi. */
export function reglerLesDispos(tournoi: string, compte: string, texte: string): void {
  const ev = {
    t: "dispo", tournoi, compte, texte: texte.trim().slice(0, 400), at: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
}

/** L'en-tête libre de la page d'un tournoi. */
export function reglerLEntete(tournoi: string, texte: string, par: string): void {
  const ev = {
    t: "entete", tournoi, texte: texte.trim().slice(0, 4000), par, at: Date.now(),
  };
  inscrire(ev);
  appliquer(ev);
}

/**
 * RETIRE UNE INSCRIPTION (SPEC.md §29).
 *
 * Tant que le tournoi n'est pas engagé : d'un topping tant qu'on n'a lancé
 * aucune partie, d'un battle tant que les poules ne sont pas tirées.
 */
export function desinscrireDuTournoi(t: Tournoi, compte: string): string | null {
  const ins = inscriptionDe(t, compte);
  if (ins === undefined) return "Vous n'êtes pas inscrit";
  if (t.type === "battle" && poules.has(t.id)) {
    return "Les poules sont tirées : seul l'organisateur peut vous retirer";
  }
  if (t.type === "topping" && manchesDe(epreuveDuTournoi(t.id)).some((m) => m.equipe.includes(compte))) {
    return "Vous avez déjà joué une partie de ce tournoi";
  }
  const ev = { t: "desinscription", tournoi: t.id, compte: ins.compte, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
  return null;
}

/**
 * LE CLASSEMENT D'UNE POULE (SPEC.md §29).
 *
 * Les points, puis les manches gagnées, puis les POINTS DE MANCHE : le cumul
 * des 1 et des ½ pris coup par coup. Ils viennent avant la rencontre directe
 * parce qu'ils existent toujours, même quand la rencontre n'a pas été jouée.
 */
export function classementDeLaPoule(t: Tournoi, i: number): LigneDePoule[] {
  const poule = poulesDuTournoi(t.id)?.[i] ?? [];
  const par = new Map<string, LigneDePoule>();
  for (const camp of poule) {
    par.set(camp, {
      camp, rang: 0, points: 0, gagnees: 0, nulles: 0, perdues: 0,
      manchesGagnees: 0, manchesPerdues: 0, pointsDeManche: 0, jouees: 0,
    });
  }
  for (const r of rencontresDuTournoi(t.id)) {
    if (r.phase !== `poule:${i}`) continue;
    for (let c = 0; c < 2; c++) {
      const l = par.get(r.camps[c]!);
      if (l === undefined) continue;
      for (const m of r.manches) {
        if (m.fin === null || m.points === null) continue;
        l.pointsDeManche += m.points[c]!;
        if (m.gagnant === null) continue;
        if (m.gagnant === r.camps[c]) l.manchesGagnees++; else l.manchesPerdues++;
      }
      if (r.fin === null) continue;
      l.jouees++;
      if (r.fin.gagnant === null && r.fin.par === "arbitrage") {
        // PERSONNE N'A JOUE : 0 point aux deux. Une défaite rapporte plus,
        // parce que venir jouer compte.
        l.points += POINTS_DE_POULE.absent;
      } else if (r.fin.gagnant === null) {
        l.nulles++;
        l.points += POINTS_DE_POULE.nul;
      } else if (r.fin.gagnant === r.camps[c]) {
        l.gagnees++;
        l.points += POINTS_DE_POULE.victoire;
      } else {
        l.perdues++;
        l.points += POINTS_DE_POULE.defaite;
      }
    }
  }
  const lignes = [...par.values()].sort((a, b) =>
    b.points - a.points
    || b.manchesGagnees - a.manchesGagnees
    || b.pointsDeManche - a.pointsDeManche
    || a.camp.localeCompare(b.camp));
  lignes.forEach((l, n) => { l.rang = n + 1; });
  return lignes;
}
