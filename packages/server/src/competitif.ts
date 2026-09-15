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
  LEXIQUES_DU_JOUR, PARTIES_DU_JOUR, configDuModele, decalerLeJour, jourDe, modeleDeLaConfig,
  nomDeLaPartie, tirerUnModele, type ModeleDePartie,
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
}

const jours = new Map<string, JourDePdj>();
const manches = new Map<string, Manche>();
const tournois = new Map<string, Tournoi>();
/** Qui a regarde quelle partie avant de la jouer : `epreuve|partie|compte`. */
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
  } else if (e["t"] === "apercu") {
    apercus.add(`${e["epreuve"]}|${e["partie"]}|${e["par"]}`);
  } else if (e["t"] === "tournoi") {
    tournois.set(e["id"], {
      id: e["id"], type: e["type"], nom: e["nom"], lexique: e["lexique"],
      debut: e["debut"], fin: e["fin"] ?? null, equipe: e["equipe"] ?? 1,
      parties: e["parties"] ?? [], battle: e["battle"] ?? null, par: e["par"], at: e["at"],
      inscrits: [],
    });
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
  const modeles = PARTIES_DU_JOUR[lexique] ?? [];
  for (let i = 0; i < modeles.length; i++) {
    const cfg = configDuModele(modeles[i]!, lexique);
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
export function finirLaManche(id: string, coups: readonly PlayedMove[], jouables: number): FinDeManche | null {
  const m = manches.get(id);
  if (m === undefined || m.fin !== null) return null;
  const fin = bilanDeLaManche(m, coups, jouables);
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

/** La manche est-elle jouee par quelqu'un qui avait vu la partie ? */
function vueDAvance(m: Manche): boolean {
  return m.equipe.some((nom) => apercus.has(`${m.epreuve}|${m.partie}|${nom}`));
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
  return {
    cache,
    lignes: cache ? [] : closes.map(ligneDe),
    moi: {
      manche: mienne?.id ?? null,
      fini,
      enCours: mienne !== undefined && mienne.fin === null,
    },
    details: fini ? Object.fromEntries(closes.map((m) => [m.id, m.fin!.coups])) : null,
  };
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

/** Un identifiant de salon sur, et propre a ce compte sur cette partie. */
export function salonDeLaPartie(epreuve: string, partie: number, compte: string): string {
  const empreinte = createHash("sha1").update(compte).digest("hex").slice(0, 8);
  const t = tournoiDeLEpreuve(epreuve);
  if (t !== undefined) return `tournoi-${t.id.slice(0, 8)}-p${partie}-${empreinte}`;
  const e = lireLEpreuve(epreuve);
  const lexique = e?.lexique ?? "x";
  return `pdj-${e?.jour ?? "jour"}-${lexique}-p${partie}-${empreinte}`;
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
  | { action: "reglages"; partie: number; modele: ModeleDePartie };

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
    let parties: PartieDEpreuve[];
    if (changement.action === "nombre") {
      const n = Math.round(changement.nombre);
      if (!Number.isInteger(n) || n < 1 || n > 8) return "de 1 à 8 parties";
      parties = j.parties.slice(0, n);
      for (let i = parties.length; i < n; i++) {
        parties.push(await figer(i + 1, PARTIES_DU_JOUR[lexique]?.[i] ?? tirerUnModele()));
      }
    } else if (changement.action === "retirer") {
      parties = [];
      for (let i = 0; i < j.parties.length; i++) parties.push(await figer(i + 1, tirerUnModele()));
    } else {
      const k = j.parties.findIndex((p) => p.n === changement.partie);
      if (k === -1) return "cette partie n'existe pas";
      const modele = changement.action === "graine"
        ? modeleDeLaConfig(j.parties[k]!.config) : changement.modele;
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
  if (!apercus.has(`${epreuve}|${partie}|${par}`)) {
    const ev = { t: "apercu", epreuve, partie, par, at: Date.now() };
    inscrire(ev);
    appliquer(ev);
  }
  return { jour: demain, partie, config: f.config, coups: f.coups, fin: f.fin };
}

/** Les parties de demain que ce compte a deja regardees. */
export function apercusDe(par: string, lexique: string, maintenant = Date.now()): number[] {
  const epreuve = epreuveDuJour(decalerLeJour(jourDe(maintenant), 1), lexique);
  return [...apercus].filter((a) => a.startsWith(`${epreuve}|`) && a.endsWith(`|${par}`))
    .map((a) => Number(a.split("|")[1]));
}

// ------------------------------------------------------------------ tournois

/** Ce qu'un tournoi montre a tout le monde. */
export function tournoiPublic(t: Tournoi) {
  return {
    id: t.id, type: t.type, nom: t.nom, lexique: t.lexique, debut: t.debut, fin: t.fin,
    equipe: t.equipe, parties: t.parties.map((p) => ({ n: p.n, config: p.config })),
    battle: t.battle, par: t.par, at: t.at,
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
    };
    inscrire(ev);
    appliquer(ev);
    console.log(`[competitif] tournoi de topping "${o.nom}" cree par ${o.par} : ${parties.length} partie(s)`);
    return tournois.get(ev.id)!;
  });
}

/** Cree un tournoi de battle : ses parties se tirent a chaque manche. */
export function creerUnTournoiDeBattle(o: {
  nom: string; lexique: string; debut: number; equipe: number; battle: ReglagesBattle; par: string;
}): Tournoi {
  const ev = {
    t: "tournoi", id: randomUUID(), type: "battle", nom: o.nom, lexique: o.lexique,
    debut: o.debut, fin: null, equipe: o.equipe, parties: [], battle: o.battle, par: o.par, at: Date.now(),
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
