/**
 * Le registre des salons. Voir SPEC.md §16.
 *
 * UN SALON EST UN LIEU, UNE PARTIE EST CE QUI TOURNE DEDANS. Le salon garde son
 * nom, son proprietaire et ses reglages ; la partie a sa grille, son sac et son
 * journal. Quand une partie se termine, le proprietaire en relance une autre
 * dans le meme salon : les gens et le chat restent, la partie change.
 *
 * La grille mondiale est un salon comme un autre -- permanent, sans
 * proprietaire, a configuration verrouillee.
 */
import { mkdirSync, openSync, writeSync, fsyncSync, readFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "./game.ts";
import { serialiser, deserialiser, type ConfigPartie, type ConfigSerialisee } from "../../engine/src/config.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const REGISTRE = join(DATA_DIR, "salons.journal.jsonl");

/** Plafond de salons actifs : chaque partie tient un fil de calcul (SPEC.md §16). */
export const MAX_SALONS = 12;

export interface Salon {
  id: string;
  nom: string;
  /** null = la grille mondiale : personne ne la possede, on ne la reregle pas. */
  proprietaire: string | null;
  prive: boolean;
  layout: LayoutName;
  partie: Game;
  creeLe: number;
}

const salons = new Map<string, Salon>();

/**
 * Un nom de salon tire au hasard, le temps qu'on en choisisse un vrai.
 *
 * Deux mots accoles, pris a des listes courtes : c'est assez pour distinguer
 * les salons entre eux et ca se retient mieux qu'un numero.
 */
const ADJECTIFS = [
  "vif", "calme", "clair", "sombre", "leger", "grave", "tiede", "vaste",
  "menu", "franc", "rude", "doux", "fier", "sage", "vieux", "neuf",
];
const NOMS = [
  "caramel", "pavage", "ancrage", "joker", "tirage", "palier", "reliquat",
  "sillon", "damier", "chevalet", "collage", "scrabble", "top", "isotop",
];

export function nomAuHasard(): string {
  const a = ADJECTIFS[Math.floor(Math.random() * ADJECTIFS.length)]!;
  const n = NOMS[Math.floor(Math.random() * NOMS.length)]!;
  return `${n.charAt(0).toUpperCase()}${n.slice(1)} ${a}`;
}

/** Un identifiant sur, utilisable comme nom de fichier et dans une adresse. */
export function slug(nom: string): string {
  const base = nom.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base === "" ? "salon" : base;
}

function inscrire(ev: Record<string, unknown>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const fd = openSync(REGISTRE, "a");
  writeSync(fd, JSON.stringify(ev) + "\n");
  fsyncSync(fd);
}

/** Les salons deja connus, relus du registre. Leur partie n'est pas encore ouverte. */
export function salonsEnregistres(): Record<string, any>[] {
  if (!existsSync(REGISTRE)) return [];
  const vus = new Map<string, Record<string, any>>();
  for (const ligne of readFileSync(REGISTRE, "utf8").split("\n")) {
    if (ligne.trim() === "") continue;
    try {
      const e = JSON.parse(ligne) as Record<string, any>;
      if (e["t"] === "ouvert") vus.set(e["id"], e);
      if (e["t"] === "ferme") vus.delete(e["id"]);
    } catch { /* ligne illisible, on passe */ }
  }
  return [...vus.values()];
}

export function salon(id: string): Salon | undefined {
  return salons.get(id);
}

/**
 * Cet identifiant est-il deja pris ?
 *
 * Pas seulement par un salon ouvert : par des FICHIERS aussi. Supprimer un
 * salon laisse sa partie sur le disque -- c'est voulu, on ne detruit jamais une
 * partie jouee. Mais recreer un salon du meme nom rouvrait alors l'ancienne
 * partie, avec sa variante et ses coups, au lieu de la partie normale attendue.
 */
export function identifiantPris(id: string): boolean {
  if (salons.has(id)) return true;
  for (const suffixe of [".json", ".journal.jsonl"]) {
    if (existsSync(join(DATA_DIR, `${id}${suffixe}`))) return true;
  }
  return false;
}

export function tousLesSalons(): Salon[] {
  return [...salons.values()].sort((a, b) => a.creeLe - b.creeLe);
}

/** Ce qu'un client a besoin de savoir pour choisir un salon. */
export function resume(s: Salon, connectes: number) {
  return {
    id: s.id,
    nom: s.nom,
    proprietaire: s.proprietaire,
    prive: s.prive,
    mondiale: s.proprietaire === null,
    coups: s.partie.moveNumber,
    finie: s.partie.finie,
    connectes,
    config: serialiser(s.partie.cfg),
    creeLe: s.creeLe,
  };
}

/**
 * Ouvre un salon et demarre sa partie.
 *
 * `nouveau` distingue la creation d'une reprise : un salon relu du registre ne
 * doit pas etre reinscrit, sinon le registre grossit a chaque demarrage.
 */
export async function ouvrirSalon(opts: {
  id: string; nom: string; proprietaire: string | null; prive: boolean;
  layout: LayoutName; cfg: ConfigPartie; nouveau: boolean; creeLe?: number;
}): Promise<Salon> {
  if (salons.has(opts.id)) throw new Error(`le salon "${opts.id}" existe deja`);
  if (salons.size >= MAX_SALONS) {
    throw new Error(`trop de salons ouverts (${MAX_SALONS} au maximum)`);
  }
  // Une partie deja commencee garde SA variante : on ne rejoue pas une 8 sur 8
  // en 7 sur 7 parce que le salon a ete recree avec d'autres reglages.
  const enregistree = Game.configEnregistree(opts.id);
  const cfg = enregistree !== null ? deserialiser(enregistree) : opts.cfg;

  const partie = new Game(opts.id, opts.layout, cfg);
  await partie.start();
  const s: Salon = {
    id: opts.id, nom: opts.nom, proprietaire: opts.proprietaire, prive: opts.prive,
    layout: opts.layout, partie, creeLe: opts.creeLe ?? Date.now(),
  };
  salons.set(s.id, s);
  if (opts.nouveau) {
    inscrire({
      t: "ouvert", id: s.id, nom: s.nom, proprietaire: s.proprietaire,
      prive: s.prive, layout: s.layout, config: serialiser(cfg), creeLe: s.creeLe,
    });
  }
  return s;
}

/** Met les fichiers d'une partie de cote. Rien n'est efface. */
export function archiver(gameId: string): string[] {
  const horodatage = Date.now();
  const faits: string[] = [];
  for (const suffixe of [".json", ".journal.jsonl", ".secours.json"]) {
    const f = join(DATA_DIR, `${gameId}${suffixe}`);
    if (!existsSync(f)) continue;
    renameSync(f, join(DATA_DIR, `${gameId}.${horodatage}${suffixe}`));
    faits.push(`${gameId}.${horodatage}${suffixe}`);
  }
  return faits;
}

/**
 * Relance une partie neuve dans le meme salon. L'ancienne est archivee, jamais
 * effacee : elle reste ouvrable sous son nom horodate.
 */
export async function relancer(s: Salon, cfg?: ConfigPartie): Promise<string[]> {
  s.partie.releaseLock();
  await s.partie.stop();
  const archives = archiver(s.id);
  s.partie = new Game(s.id, s.layout, cfg ?? s.partie.cfg);
  await s.partie.start();
  return archives;
}

/** Ferme un salon : sa partie s'arrete, ses fichiers restent. */
export async function fermerSalon(id: string): Promise<void> {
  const s = salons.get(id);
  if (s === undefined) return;
  s.partie.releaseLock();
  await s.partie.stop();
  salons.delete(id);
  inscrire({ t: "ferme", id });
}

export type { ConfigSerialisee };
