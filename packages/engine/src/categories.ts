/**
 * Les categories de records. Voir SPEC.md §23.
 *
 * UNE CATEGORIE EST UNE CONFIGURATION EXACTE, PAS UNE FAMILLE. Un record se
 * compare a d'autres records : une variante qui change le nombre de coups, la
 * valeur des lettres ou la fin de la partie ne se compare a rien. Tout ce qui
 * n'est pas dans la signature disqualifie la partie -- silencieusement : elle
 * se joue normalement, elle n'entre simplement pas au tableau.
 *
 * VIT DANS LE MOTEUR, ET PAS DANS LE SERVEUR, parce que trois endroits en ont
 * besoin : le serveur pour enregistrer une manche, le client pour dessiner la
 * page des records, et le reglage du chrono pour savoir ou son plancher
 * s'abaisse. Une seule table, et personne ne redit la regle a sa facon.
 */
import { primesParDefaut, type ConfigPartie, type ConfigSerialisee } from "./config.ts";

/** Demi-cote du plateau du commerce : 7 donne une grille de 15x15. */
export const BORNES_NORMALE = 7;
/** Demi-cote de la super grille : 10 donne un plateau de 21x21. */
export const BORNES_SUPER = 10;

/** Les deux grilles sur lesquelles un record peut se jouer. */
export type Grille = "normale" | "super";

export function grilleDeBornes(bornes: number | null): Grille | null {
  if (bornes === BORNES_NORMALE) return "normale";
  if (bornes === BORNES_SUPER) return "super";
  return null;
}

/**
 * Les trois tailles de chevalet, et ce qu'elles s'appellent a l'ecran.
 *
 * Le nom long de la grande est de Zulu : « un nombre consequent de lettres ».
 */
export type Taille = "petit" | "normal" | "grand";

export const TAILLES: readonly { id: Taille; nom: string }[] = [
  { id: "petit", nom: "Pas beaucoup" },
  { id: "normal", nom: "Normal" },
  { id: "grand", nom: "Un nombre conséquent de lettres" },
];

/** Seule la grande taille complete ses tableaux au negatif (SPEC.md §23). */
export function completeAuNegatif(c: Categorie | undefined): boolean {
  return c?.taille === "grand";
}

export interface Categorie {
  id: string;
  /** Le nom du tableau, tel qu'il s'affiche. */
  nom: string;
  /** Le Y de « X sur Y » : combien de caramels on tire. */
  tirage: number;
  /** Le X : combien on peut en poser. */
  jouables: number;
  joker: boolean;
  /**
   * Combien de caramels au chevalet : c'est l'axe « Lettres » de la page.
   *
   * TROIS TAILLES, ET ELLES NE SE COMPARENT PAS. Un 2 sur 2 se tope en quelques
   * secondes par coup, un 15 sur 15 ne se tope presque jamais : melanger leurs
   * tableaux ferait un classement ou la taille du chevalet compte plus que le
   * joueur.
   *
   * Seule la grande complete ses tableaux au negatif : elle est la seule ou les
   * parties topees se comptent sur les doigts d'une main (SPEC.md §23).
   */
  taille: Taille;
  /**
   * Un seul joueur a trouve TOUS les tops.
   *
   * Ce n'est pas « il etait seul dans le salon » : la definition se lit dans le
   * resultat, elle ne demande rien a personne, et elle est plus dure que
   * l'autre. Etre le seul a tout trouver pendant que cinq personnes cherchent
   * est plus difficile que d'etre seul a chercher.
   */
  solo: boolean;
  /** La suite de six parties enchainees, qui n'est pas une partie (SPEC.md §23). */
  montante: boolean;
}

function format(
  id: string, nom: string, jouables: number, tirage: number,
  joker: boolean, taille: Taille,
): Categorie {
  return { id, nom, tirage, jouables, joker, taille, solo: false, montante: false };
}

/**
 * Les categories, dans l'ordre des onglets.
 *
 * « Partie normale solo » vient tout de suite apres la categorie reine : c'est
 * la performance individuelle, et elle merite son propre tableau. Partout
 * ailleurs le solo n'est qu'un filtre.
 */
export const CATEGORIES: readonly Categorie[] = [
  // ----------------------------------------------------------- pas beaucoup
  //
  // De deux a six caramels. Ce sont des parties courtes et tres rapides -- une
  // 2 sur 2 s'est jouee en cinquante-huit coups a six joueurs -- et elles ont
  // leurs tableaux a elles pour la meme raison que les grandes ont les leurs.
  ...[2, 3, 4, 5, 6].flatMap((n) => [
    format(`${n}-${n}`, `${n} sur ${n}`, n, n, false, "petit"),
    format(`${n}-${n}-joker`, `${n} sur ${n} joker`, n, n, true, "petit"),
  ]),
  // ---------------------------------------------------------------- normal
  format("normale", "Partie normale", 7, 7, false, "normal"),
  { ...format("normale-solo", "Partie normale solo", 7, 7, false, "normal"), solo: true },
  { ...format("montante", "Montante", 7, 7, false, "normal"), montante: true },
  format("joker", "Joker", 7, 7, true, "normal"),
  format("7-8", "7 sur 8", 7, 8, false, "normal"),
  format("7-8-joker", "7 sur 8 joker", 7, 8, true, "normal"),
  format("8-8", "7 et 8", 8, 8, false, "normal"),
  format("8-8-joker", "7 et 8 joker", 8, 8, true, "normal"),
  format("9-9", "7, 8 et 9", 9, 9, false, "normal"),
  format("9-9-joker", "7, 8 et 9 joker", 9, 9, true, "normal"),
  // ------------------------------------------------------------- les grands
  //
  // Elles se nomment « 10 sur 10 » et non « 7, 8, 9 et 10 » : les normales
  // enumerent parce que trois nombres se lisent, celles-ci en auraient neuf sur
  // un onglet, et « 7, 8, 9, 10, 11, 12, 13, 14 et 15 » ne se lit plus du tout.
  ...[10, 11, 12, 13, 14, 15].flatMap((n) => [
    format(`${n}-${n}`, `${n} sur ${n}`, n, n, false, "grand"),
    format(`${n}-${n}-joker`, `${n} sur ${n} joker`, n, n, true, "grand"),
  ]),
];

export function categorie(id: string): Categorie | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** Les primes de cette partie sont-elles celles du jeu, intactes ? */
function primesIntactes(primes: Readonly<Record<number, number>>): boolean {
  const attendues = primesParDefaut();
  const clesA = Object.keys(attendues).length;
  const clesB = Object.keys(primes).filter((k) => (primes[Number(k)] ?? 0) > 0).length;
  if (clesA !== clesB) return false;
  for (const [n, pts] of Object.entries(attendues)) {
    if (primes[Number(n)] !== pts) return false;
  }
  return true;
}

/**
 * Cette configuration peut-elle porter un record ?
 *
 * Elle ne dit rien de la PARTIE -- ni si elle est terminee, ni si elle a ete
 * topee, ni si quelqu'un jouait. Elle ne juge que les reglages, qui sont connus
 * avant le premier coup. C'est ce qui permet au reglage du chrono de s'en
 * servir pour savoir ou son plancher s'abaisse.
 */
export function reglagesRecevables(cfg: ConfigPartie | ConfigSerialisee): boolean {
  // Une grille sans fin n'a pas de fin, donc pas de record. La super grille en
  // a une, et elle a ses propres tableaux.
  if (grilleDeBornes(cfg.bornes) === null) return false;
  // Le sac du commerce, et lui seul : les probabilites ponderees ne s'epuisent
  // pas, et la meme 7 sur 7 y fait 48 a 55 coups au lieu de 22.
  if (cfg.pioche !== "sac102") return false;
  // Le nombre d'exemplaires decoule de la grille -- 441 cases ne se remplissent
  // pas avec 102 caramels -- mais on le verifie plutot que de le supposer.
  if (cfg.sacs !== (cfg.bornes === BORNES_SUPER ? 2 : 1)) return false;
  if (!primesIntactes(cfg.primes)) return false;
  // Le duplicate ne se termine pas sur un top trouve : il n'a pas de temps de
  // partie a comparer.
  if (cfg.mode !== "topping") return false;
  // La partie va au bout de son sac. Une partie tronquee se comparerait a des
  // parties entieres.
  if (cfg.coupsMax !== null || cfg.dureeMax !== null) return false;
  // Le double joker est une autre partie, et il n'a pas de categorie.
  if (cfg.joker && Math.round(cfg.jokersParCoup) !== 1) return false;
  return true;
}

/**
 * La categorie de cette configuration, ou `null` si elle n'en a aucune.
 *
 * Rend la categorie de BASE : ni le solo ni la montante, qui ne se lisent pas
 * dans les reglages. Le solo se lit dans le resultat de la partie, la montante
 * dans l'en-tete de son journal.
 */
export function categorieDesReglages(
  cfg: ConfigPartie | ConfigSerialisee,
): Categorie | null {
  if (!reglagesRecevables(cfg)) return null;
  return CATEGORIES.find((c) =>
    !c.solo && !c.montante
    && c.tirage === cfg.tirage && c.jouables === cfg.jouables
    && c.joker === cfg.joker) ?? null;
}

/**
 * La configuration EXACTE de la partie normale : 15x15, 7 sur 7, sans joker.
 *
 * C'est la seule ou le plancher du chrono s'abaisse a une seconde (SPEC.md
 * §23). Ailleurs il reste a quinze : chaque coup coute un calcul de top
 * complet, et la grille peut y etre bien plus grande.
 */
export function estPartieNormale(cfg: ConfigPartie | ConfigSerialisee): boolean {
  return cfg.bornes === BORNES_NORMALE
    && cfg.tirage === 7 && cfg.jouables === 7 && !cfg.joker
    && reglagesRecevables(cfg);
}
