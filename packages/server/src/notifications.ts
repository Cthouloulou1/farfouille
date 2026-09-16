/**
 * Les notifications d'un compte. Voir SPEC.md §29.
 *
 * ELLES VIVENT HORS DES SALONS, et c'est toute leur raison d'etre. Un client
 * n'a de liaison avec le serveur que dans un salon : une invitation envoyee a
 * quelqu'un qui lisait la page Competitif ne trouvait personne, et rien n'en
 * restait. Une notification s'ecrit ici, et se relit d'ou qu'on soit.
 *
 * LE JOURNAL FAIT FOI, en ajout seul comme les comptes (§11). Deux sortes de
 * lignes : une notification qui nait, et une marque de lecture -- un instant
 * jusqu'auquel ce compte a tout lu. Marquer d'un trait plutot que case par case
 * evite une ligne par notification lue, pour une liste qui se lit d'un coup
 * d'oeil.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let DATA_DIR = join(here, "..", "data");
const journal = (): string => join(DATA_DIR, "notifications.journal.jsonl");

/** POUR LES TESTS SEULEMENT : un dossier isole, jamais `packages/server/data`. */
export function definirDossierDesNotifications(dir: string): void {
  DATA_DIR = dir;
  boites.clear();
  lues.clear();
  faites.clear();
}

/**
 * Ce qui allume une notification. Le texte ne s'ecrit pas ici : le serveur
 * n'affiche rien, et la phrase se traduit chez le client.
 */
export type Genre =
  | "salon" | "equipe" | "tournoi-debut" | "tournoi-invite" | "defi" | "defi-joue";

export interface Notification {
  id: string;
  /** Le pseudo du compte a qui elle est destinee. */
  pour: string;
  genre: Genre;
  /** De quoi ecrire la phrase et faire le lien : un salon, un tournoi, un nom. */
  params: Record<string, string>;
  at: number;
}

const boites = new Map<string, Notification[]>();
const lues = new Map<string, number>();
/** Les cles de ce qui ne doit arriver qu'une fois : `pour|cle`. */
const faites = new Set<string>();

/** Combien de notifications un compte garde. Au-dela, les plus vieilles tombent. */
const PLAFOND = 100;

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

function appliquer(e: Record<string, any>): void {
  if (e["t"] === "notif") {
    const n: Notification = {
      id: e["id"], pour: e["pour"], genre: e["genre"], params: e["params"] ?? {}, at: e["at"],
    };
    const boite = boites.get(n.pour) ?? [];
    boite.push(n);
    if (boite.length > PLAFOND) boite.splice(0, boite.length - PLAFOND);
    boites.set(n.pour, boite);
    if (typeof e["cle"] === "string") faites.add(`${n.pour}|${e["cle"]}`);
  } else if (e["t"] === "lu") {
    lues.set(e["pour"], Math.max(lues.get(e["pour"]) ?? 0, Number(e["jusqua"]) || 0));
  }
}

/** Relit le journal. Une ligne tronquee par une coupure est ignoree. */
export function ouvrirLesNotifications(): void {
  boites.clear();
  lues.clear();
  faites.clear();
  if (!existsSync(journal())) return;
  let casses = 0;
  for (const ligne of readFileSync(journal(), "utf8").split("\n")) {
    if (ligne.trim() === "") continue;
    try { appliquer(JSON.parse(ligne)); } catch { casses++; }
  }
  if (casses > 0) console.warn(`[notifications] ${casses} ligne(s) illisible(s) dans le journal`);
  console.log(`[notifications] ${boites.size} boite(s)`);
}

/**
 * ALLUME UNE NOTIFICATION. `cle` la rend unique : un tournoi ne previent qu'une
 * fois qu'il commence, meme si le serveur redemarre entre-temps.
 *
 * Rend vrai si elle est neuve.
 */
export function notifier(
  pour: string, genre: Genre, params: Record<string, string>, cle?: string,
): boolean {
  if (pour.trim() === "") return false;
  if (cle !== undefined && faites.has(`${pour}|${cle}`)) return false;
  const ev = {
    t: "notif", id: randomUUID(), pour, genre, params, at: Date.now(),
    ...(cle === undefined ? {} : { cle }),
  };
  inscrire(ev);
  appliquer(ev);
  return true;
}

/** Les notifications d'un compte, la plus recente d'abord, et combien sont neuves. */
export function notificationsDe(pour: string, plafond = 50): {
  notifications: (Notification & { lue: boolean })[]; nonLues: number;
} {
  const trait = lues.get(pour) ?? 0;
  const boite = [...(boites.get(pour) ?? [])].reverse();
  return {
    notifications: boite.slice(0, plafond).map((n) => ({ ...n, lue: n.at <= trait })),
    nonLues: boite.filter((n) => n.at > trait).length,
  };
}

/** Marque tout lu jusqu'a cet instant. Le trait ne recule jamais. */
export function marquerLues(pour: string, jusqua = Date.now()): void {
  if ((lues.get(pour) ?? 0) >= jusqua) return;
  const ev = { t: "lu", pour, jusqua, at: Date.now() };
  inscrire(ev);
  appliquer(ev);
}
