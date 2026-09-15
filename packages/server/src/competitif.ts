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
  LEXIQUES_DU_JOUR, PARTIES_DU_JOUR, configDuModele, decalerLeJour, jourDe, nomDeLaPartie,
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

const jours = new Map<string, JourDePdj>();
const manches = new Map<string, Manche>();

const cleDuJour = (jour: string, lexique: string): string => `${jour}|${lexique}`;

/** L'identifiant de l'epreuve des parties du jour. */
export const epreuveDuJour = (jour: string, lexique: string): string => `pdj:${jour}:${lexique}`;

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
}

/** Une manche close a-t-elle ete jouee a temps ? */
function aTemps(m: Manche): boolean {
  const e = lireLEpreuve(m.epreuve);
  return e === null || m.fin === null || jourDe(m.fin.at) <= e.jour;
}

function ligneDe(m: Manche): LigneDeResultat {
  return {
    manche: m.id, compte: m.compte, jeu: m.jeu, noms: m.noms, equipe: m.equipe,
    temps: m.fin!.temps, negatif: m.fin!.negatif, score: m.fin!.score,
    coups: m.fin!.coups.length, aTemps: aTemps(m), at: m.fin!.at,
  };
}

/**
 * Les resultats d'une partie d'epreuve, tels que la page les lit.
 *
 * LES LIGNES PARTENT A TOUT LE MONDE : un temps et un negatif ne disent pas les
 * mots. LE DETAIL DES COUPS, lui, ne part qu'a qui a fini la partie -- il porte
 * les tops, et ce que chacun a joue.
 */
export function resultatsDeLaPartie(epreuve: string, partie: number, pour: string | null) {
  const closes = [...manches.values()]
    .filter((m) => m.epreuve === epreuve && m.partie === partie && m.fin !== null);
  const mienne = pour === null ? undefined : mancheDuCompte(pour, epreuve, partie);
  const fini = mienne?.fin !== null && mienne !== undefined;
  return {
    lignes: closes.map(ligneDe),
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
export function cumulDeLEpreuve(epreuve: string, pour: string | null) {
  const par = new Map<string, LigneDeResultat & { parties: number[]; cle: string }>();
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
    deja.parties.push(m.partie);
  }
  const miennes = pour === null ? []
    : [...manches.values()].filter((m) => m.epreuve === epreuve && m.equipe.includes(pour));
  return {
    lignes: [...par.values()],
    moi: miennes.map((m) => ({
      partie: m.partie, fini: m.fin !== null,
      temps: m.fin?.temps ?? null, negatif: m.fin?.negatif ?? null, score: m.fin?.score ?? null,
    })),
  };
}

/** Un identifiant de salon sur, et propre a ce compte sur cette partie. */
export function salonDeLaPartie(epreuve: string, partie: number, compte: string): string {
  const e = lireLEpreuve(epreuve);
  const empreinte = createHash("sha1").update(compte).digest("hex").slice(0, 8);
  const lexique = e?.lexique ?? "x";
  return `pdj-${e?.jour ?? "jour"}-${lexique}-p${partie}-${empreinte}`;
}

/** La configuration d'une partie d'epreuve, prete pour un salon. */
export const configDeLaPartie = (p: PartieDEpreuve) => deserialiser(p.config);
