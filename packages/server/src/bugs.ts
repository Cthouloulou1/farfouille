/**
 * Les rapports de bug. Voir SPEC.md §8.
 *
 * IL N'Y A PAS ENCORE D'ADRESSE OU LES ENVOYER. Le formulaire, lui, existe :
 * ce qu'un joueur ecrit ne doit pas attendre qu'une boite aux lettres soit
 * ouverte pour etre garde. Chaque rapport part donc dans un journal en ajout
 * seul, `fsync` a chaque ligne, comme les comptes et les parties -- et s'ecrit
 * en clair dans la console de l'hote, ou il se lit tout de suite.
 *
 * Le jour ou l'adresse existera, il n'y aura qu'a brancher l'envoi ici : rien
 * d'autre dans le serveur ne connait ce chemin.
 *
 * ON N'ECRIT PAS L'ADRESSE IP. Elle ne sert a rien pour comprendre un bug, et
 * elle transformerait un fichier de rapports en fichier de joueurs.
 */
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const JOURNAL = join(DATA_DIR, "bugs.journal.jsonl");

/** L'adresse qui recevra les rapports. Elle n'existe pas encore. */
export const ADRESSE_DES_BUGS = "bugs@farfouille.jeu";

/** Ce qu'un rapport porte le plus long : au-dela, on tronque. */
const TEXTE_MAX = 4000;
const CHAMP_MAX = 254;

export interface Rapport {
  /** Ce que le joueur a ecrit. C'est le seul champ obligatoire. */
  texte: string;
  /** Pour lui repondre. Facultatif : le formulaire le dit. */
  email: string;
  /** Sous quel nom il jouait. Vide s'il n'est pas nomme. */
  pseudo: string;
  /** Le compte, si le cookie en designe un. C'est celui-la qui fait foi. */
  compte: string;
  /** Le salon d'ou part le rapport, et le coup en cours. Vide depuis l'accueil. */
  salon: string;
  coup: number | null;
  /** La langue du site, le navigateur, et l'heure de compilation du client. */
  langue: string;
  agent: string;
  version: string;
}

const court = (v: unknown, max: number): string =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Lit un rapport dans ce que le client a envoye.
 *
 * Retourne `null` si le texte est vide : un rapport sans description ne dit
 * rien, et le formulaire refuse deja de l'envoyer.
 */
export function lireLeRapport(corps: Record<string, unknown>): Rapport | null {
  // Le texte garde ses retours a la ligne : c'est un recit, pas une etiquette.
  const texte = String(corps["texte"] ?? "").trim().slice(0, TEXTE_MAX);
  if (texte === "") return null;
  const coup = Number(corps["coup"]);
  return {
    texte,
    email: court(corps["email"], CHAMP_MAX),
    pseudo: court(corps["pseudo"], 64),
    compte: "",
    salon: court(corps["salon"], 64),
    coup: Number.isFinite(coup) && coup > 0 ? Math.round(coup) : null,
    langue: court(corps["langue"], 8),
    agent: court(corps["agent"], CHAMP_MAX),
    version: court(corps["version"], 32),
  };
}

/**
 * Garde le rapport et l'annonce. Le journal fait foi ; la console est la pour
 * qu'on le voie passer sans avoir a ouvrir le fichier.
 */
export function enregistrerLeRapport(r: Rapport): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const fd = openSync(JOURNAL, "a");
  try {
    writeSync(fd, JSON.stringify({ t: "bug", quand: Date.now(), ...r }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const qui = r.compte !== "" ? `${r.compte} (compte)` : r.pseudo !== "" ? r.pseudo : "anonyme";
  const ou = r.salon === "" ? "accueil" : `salon ${r.salon}${r.coup !== null ? `, coup ${r.coup}` : ""}`;
  console.log(`
  [bug] AUCUN COURRIEL NE PART -- ${ADRESSE_DES_BUGS} n'existe pas encore.
  Le rapport est dans ${JOURNAL}.
  De ${qui}${r.email !== "" ? ` <${r.email}>` : ""}, depuis ${ou} :
${r.texte.split("\n").map((l) => `    ${l}`).join("\n")}
`);
}
