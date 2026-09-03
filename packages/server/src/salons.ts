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
import { mkdirSync, openSync, writeSync, fsyncSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "./game.ts";
import { serialiser, deserialiser, type ConfigPartie, type ConfigSerialisee } from "../../engine/src/config.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const REGISTRE = join(DATA_DIR, "salons.journal.jsonl");

/** Plafond de salons actifs : chaque partie tient un fil de calcul (SPEC.md §16). */
export const MAX_SALONS = 50;

/**
 * Plafond de grilles INFINIES ouvertes en meme temps.
 *
 * Ce sont les seules vraiment couteuses : une grille bornee se ferme quand le
 * sac se vide, tandis qu'une grille sans bord grandit sans fin, et le temps de
 * calcul d'un top grandit avec elle. Dix suffisent largement, et laissent la
 * machine a la grille mondiale, qui en est une.
 */
export const MAX_INFINIES = 10;

/** Combien de grilles sans bord tournent en ce moment. */
export function comptedesInfinies(saufId = ""): number {
  return [...salons.values()]
    .filter((s) => s.id !== saufId && s.partie.cfg.bornes === null).length;
}

export interface Salon {
  id: string;
  nom: string;
  /** null = la grille mondiale : personne ne la possede, on ne la reregle pas. */
  proprietaire: string | null;
  /**
   * Qui regle le salon EN CE MOMENT.
   *
   * Le proprietaire est celui qui l'a cree : c'est une identite, elle ne
   * change pas. Le gerant est celui qui en tient les manettes, et il change
   * avec les presents. Voir `confierLesReglages`.
   */
  gerant: string | null;
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
  "sillon", "damier", "chevalet", "collage", "farfouille", "top", "isotop",
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
export function resume(s: Salon, connectes: number, permanent = false) {
  return {
    id: s.id,
    nom: s.nom,
    proprietaire: s.proprietaire,
    prive: s.prive,
    mondiale: s.proprietaire === null,
    /**
     * Un salon qu'on ne peut pas supprimer.
     *
     * La grille mondiale l'est par nature -- personne ne la possede. Une grille
     * d'etude l'est par decision : elle a un proprietaire, qui la regle, mais
     * onze mille coups joues a plusieurs ne doivent pas tenir a un clic.
     */
    permanent: s.proprietaire === null || permanent,
    coups: s.partie.moveNumber,
    // Le total des points de la partie : la tuile du salon star l'affiche a
    // cote du numero du coup, et l'accueil n'a pas d'autre moyen de l'obtenir.
    cumul: s.partie.cumul,
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
    id: opts.id, nom: opts.nom, proprietaire: opts.proprietaire,
    gerant: opts.proprietaire, prive: opts.prive,
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

/**
 * A qui sont les reglages du salon, maintenant.
 *
 * UN SALON SANS PERSONNE POUR LE REGLER EST UN SALON MORT. Le createur ferme sa
 * page, et plus personne ne peut relancer une partie ni changer la variante :
 * il ne reste qu'a refaire un salon ailleurs.
 *
 * Les manettes suivent donc les presents, selon deux regles qui ne se
 * contredisent pas :
 *
 * - **le createur les reprend des qu'il revient.** Le salon est le sien, son
 *   depart n'est le plus souvent qu'un rechargement de page ;
 * - **en son absence, elles vont a quelqu'un au hasard** parmi les presents, et
 *   y restent tant que cette personne est la.
 *
 * Le tirage au sort vaut mieux que l'anciennete : personne n'a a comprendre
 * pourquoi c'est tombe sur lui, et il n'y a pas de file d'attente a expliquer.
 *
 * Rend le nom du nouveau gerant QUAND IL Y A LIEU DE L'ANNONCER, `null` sinon.
 * Il n'y a lieu que dans un sens : celui ou les manettes echoient a quelqu'un
 * d'autre que le createur, car des manettes qu'on recoit sans le savoir ne
 * servent a rien. Le createur qui revient, lui, voit son bouton reparaitre et
 * n'a rien a apprendre.
 */
export function confierLesReglages(s: Salon, presents: string[]): string | null {
  // La grille permanente n'a pas de manettes : elle ne se regle pas.
  if (s.proprietaire === null) return null;
  const avant = s.gerant;
  if (presents.includes(s.proprietaire)) s.gerant = s.proprietaire;
  else if (s.gerant !== null && presents.includes(s.gerant)) return null;
  else if (presents.length === 0) s.gerant = null;
  else s.gerant = presents[Math.floor(Math.random() * presents.length)]!;
  if (s.gerant === avant || s.gerant === null) return null;
  // LE RETOUR DU PROPRIETAIRE S'ANNONCE AUSSI. Il ne s'annoncait pas, et l'on
  // pouvait continuer a croire que quelqu'un d'autre tenait les manettes.
  // Seule la toute premiere attribution reste muette : ouvrir son salon et
  // s'entendre dire qu'on en devient l'hote n'apprend rien a personne.
  if (avant === null && s.gerant === s.proprietaire) return null;
  return s.gerant;
}

/**
 * Une partie merite-t-elle de survivre a son salon ?
 *
 * OUI pour une partie 15x15 TERMINEE : c'est une partie complete, elle pese
 * quelques dizaines de kilo-octets depuis qu'on n'y ecrit plus les paliers, et
 * elle se rejoue entierement.
 *
 * NON pour tout le reste. Une 15x15 abandonnee en cours de route ne se rejoue
 * pas et n'interesse personne. Une grille infinie n'a pas de fin : la garder,
 * c'est accumuler des megaoctets qu'on ne rouvrira jamais -- l'une d'elles
 * pesait a elle seule 9,4 Mo.
 */
export function meriteDEtreGardee(s: Salon): boolean {
  return s.partie.cfg.bornes !== null && s.partie.finie;
}

/**
 * Ferme un salon.
 *
 * Ses fichiers partent avec lui, sauf s'il s'agit d'une 15x15 terminee. C'est
 * la seule chose qu'on efface volontairement dans ce programme, et elle est
 * annoncee au journal du serveur, nom et nombre de coups compris.
 */
export async function fermerSalon(id: string): Promise<void> {
  const s = salons.get(id);
  if (s === undefined) return;
  const garder = meriteDEtreGardee(s);
  const coups = s.partie.moves.length;
  s.partie.releaseLock();
  await s.partie.stop();
  salons.delete(id);
  inscrire({ t: "ferme", id });
  if (garder) {
    console.log(`[salon] "${s.nom}" ferme -- partie 15x15 terminee, ${coups} coups conserves`);
    return;
  }
  const partis: string[] = [];
  for (const suffixe of [".json", ".journal.jsonl", ".secours.json", ".verrou"]) {
    const f = join(DATA_DIR, `${id}${suffixe}`);
    if (!existsSync(f)) continue;
    rmSync(f);
    partis.push(suffixe);
  }
  console.log(`[salon] "${s.nom}" ferme -- ${coups} coups effaces (${partis.join(", ") || "rien a effacer"})`);
}

export type { ConfigSerialisee };
