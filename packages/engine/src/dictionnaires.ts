/**
 * Les dictionnaires disponibles. Voir SPEC.md §7.
 *
 * UN DICTIONNAIRE, C'EST PLUS QU'UNE LISTE DE MOTS. Changer de lexique change
 * aussi ce que vaut chaque lettre, ce que contient le sac et avec quels poids
 * la pioche ponderee tire : le W anglais est une lettre ordinaire a 4 points
 * dont on a deux exemplaires, le W francais une rarete a 10 points dont il n'y
 * en a qu'un. Tout cela tient donc ensemble, dans une seule entree.
 *
 * Les fichiers compiles ne sont pas dans le depot -- ils se reconstruisent :
 *
 *     python packages/engine/tools/build_dawg.py   <source> packages/engine/data/<dawg>
 *     python packages/engine/tools/build_gaddag.py <source> packages/engine/data/<gaddag>
 *
 * POUR AJOUTER UN DICTIONNAIRE : deposer le fichier texte (un mot par ligne, en
 * MAJUSCULES ASCII, trie), compiler ses deux structures, calibrer ses poids
 * (`tools/calibrer_poids.ts`), et ajouter une entree ici. Rien d'autre : le
 * serveur, le solveur et le client lisent tous cette table.
 */
import { VALUES } from "./alphabet.ts";
import { DEFAULT_BLANK_WEIGHT, DEFAULT_WEIGHTS } from "./bag.ts";
import { SAC_FRANCAIS } from "./sac.ts";

/** Les langues du site. C'est aussi ce qui choisit le dictionnaire par defaut. */
export type Langue = "fr" | "en";

export interface Dictionnaire {
  id: string;
  /** Le nom court, celui des reglages. */
  nom: string;
  langue: Langue;
  /** Une ligne pour dire ce que c'est. */
  detail: string;
  /** Le fichier texte source, a la racine du depot. */
  source: string;
  /** Les deux structures compilees, dans packages/engine/data. */
  dawg: string;
  gaddag: string;
  /** Ce que vaut chaque lettre. */
  valeurs: Readonly<Record<string, number>>;
  /** Le sac du jeu du commerce, jokers compris. */
  sac: Readonly<Record<string, number>>;
  /** Poids de la pioche ponderee, calibres (voir tools/calibrer_poids.ts). */
  poids: Readonly<Record<string, number>>;
  poidsJoker: number;
}

/** Valeurs anglaises classiques. Le joker vaut 0. */
export const VALEURS_ANGLAISES: Readonly<Record<string, number>> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1,
  J: 8, K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1,
  S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

/**
 * Distribution anglaise classique : 98 lettres et 2 jokers.
 *
 * Le nom interne de la pioche reste « sac102 » -- c'est le compte francais, et
 * le renommer casserait les parties deja enregistrees. Ce qu'il designe, c'est
 * « le sac du jeu du commerce », qui compte 100 caramels en anglais.
 */
export const SAC_ANGLAIS: Readonly<Record<string, number>> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
  "?": 2,
};

/**
 * Poids anglais, obtenus par `tools/calibrer_poids.ts` sur le EEL 22.
 *
 * La sortie mesuree colle a la frequence du lexique sur les mots de 2 a 9
 * lettres a moins d'un centieme de point pres, le S mis a part -- ramene a 79 %
 * comme en francais, parce qu'il doit sa place au pluriel plus qu'aux mots.
 */
export const POIDS_ANGLAIS: Readonly<Record<string, number>> = {
  E: 12.552, R: 10.184, S: 10.090, N: 8.248, T: 8.216, L: 6.572, I: 6.571,
  A: 6.495, D: 5.016, O: 4.747, C: 3.855, G: 3.146, P: 2.781, M: 2.478,
  U: 2.133, H: 1.997, B: 1.838, F: 1.265, Y: 1.265, K: 0.929, W: 0.884,
  V: 0.755, Z: 0.229, X: 0.203, J: 0.142, Q: 0.123,
};

export const POIDS_JOKER_ANGLAIS = 1.700;

export const DICTIONNAIRES: Readonly<Record<string, Dictionnaire>> = {
  ods9: {
    id: "ods9",
    nom: "ODS 9",
    langue: "fr",
    detail: "Le dictionnaire officiel du Scrabble francophone. 407 128 mots.",
    source: "dictionnaire.txt",
    dawg: "dawg.bin",
    gaddag: "gaddag.bin",
    valeurs: VALUES,
    sac: SAC_FRANCAIS,
    poids: DEFAULT_WEIGHTS,
    poidsJoker: DEFAULT_BLANK_WEIGHT,
  },
  eel22: {
    id: "eel22",
    nom: "EEL 22",
    langue: "en",
    detail: "Everyday English lexicon: common words only, 2 to 15 letters. 68 135 words.",
    source: "dictionnaire-eel22.txt",
    dawg: "dawg-eel22.bin",
    gaddag: "gaddag-eel22.bin",
    valeurs: VALEURS_ANGLAISES,
    sac: SAC_ANGLAIS,
    poids: POIDS_ANGLAIS,
    poidsJoker: POIDS_JOKER_ANGLAIS,
  },
};

/** Celui qu'on joue quand rien ne dit lequel : les parties d'avant en sont la. */
export const DICO_PAR_DEFAUT = "ods9";

/** Le dictionnaire choisi par une langue. */
export const DICO_PAR_LANGUE: Readonly<Record<Langue, string>> = {
  fr: "ods9",
  en: "eel22",
};

/**
 * Le dictionnaire nomme, ou celui par defaut.
 *
 * JAMAIS D'ERREUR ICI. Un identifiant inconnu vient d'une partie enregistree
 * sous un dictionnaire depuis retire, ou d'un client qui envoie n'importe quoi :
 * dans les deux cas mieux vaut jouer en francais que ne pas ouvrir la partie.
 */
export function dictionnaire(id: string | undefined): Dictionnaire {
  return DICTIONNAIRES[id ?? ""] ?? DICTIONNAIRES[DICO_PAR_DEFAUT]!;
}

/** Cet identifiant designe-t-il un dictionnaire connu ? */
export function dictionnaireConnu(id: unknown): boolean {
  return typeof id === "string" && id in DICTIONNAIRES;
}

/** Les dictionnaires, dans l'ordre d'affichage. */
export function tousLesDictionnaires(): Dictionnaire[] {
  return Object.values(DICTIONNAIRES);
}
