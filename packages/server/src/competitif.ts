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
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlayedMove } from "./game.ts";
import { ecrireLaPartieFigee, figerUnePartie, lireLaPartieFigee } from "./figees.ts";
import type { PartieFigee } from "./game.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";
import { deserialiser, type ConfigSerialisee } from "../../engine/src/config.ts";
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
/**
 * LES INSTANCES DEJA NEES : `modele|jour`. Elle survit a la suppression du
 * tournoi -- sinon il renaitrait au passage suivant.
 */
const hebdosFaits = new Set<string>();
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
  const t = tournoiDeLEpreuve(epreuve);
  if (t !== undefined) return t.parties;
  const e = lireLEpreuve(epreuve);
  return e === null ? undefined : partiesDuJour(e.jour, e.lexique)?.parties;
}

/** Le lexique d'une epreuve. */
export function lexiqueDeLEpreuve(epreuve: string): string | null {
  return tournoiDeLEpreuve(epreuve)?.lexique ?? lireLEpreuve(epreuve)?.lexique ?? null;
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
    });
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
export function ouvrirUneManche(o: {
  epreuve: string; partie: number; salon: string; compte: string;
  jeu: Jeu; noms: string; equipe: string[];
}): Manche {
  const ev = {
    t: "manche", id: randomUUID(), epreuve: o.epreuve, partie: o.partie, salon: o.salon,
    compte: o.compte, jeu: o.jeu, noms: o.noms.slice(0, 120),
    equipe: [...new Set([o.compte, ...o.equipe])], at: Date.now(),
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

/** Un identifiant de salon sur, et propre a ce compte sur cette partie. */
export function salonDeLaPartie(epreuve: string, partie: number, compte: string): string {
  const empreinte = createHash("sha1").update(compte).digest("hex").slice(0, 8);
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
