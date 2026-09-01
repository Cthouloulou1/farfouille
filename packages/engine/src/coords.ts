/**
 * Coordonnees de la grille infinie. Voir SPEC.md §3.
 *
 * x vers la droite, y VERS LE BAS. Origine (0,0) = case de depart.
 * Les deux axes sont signes : la grille s'etend dans les quatre directions.
 */

/** Bornes imposees par l'encodage en cle. Largement au-dela de tout usage reel. */
export const COORD_MIN = -524_288;
export const COORD_MAX = 524_287;

const OFFSET = 524_288;
const SPAN = 1_048_576;

/**
 * (x,y) -> entier unique. Reste sous Number.MAX_SAFE_INTEGER (max ~1.1e12),
 * donc utilisable directement comme cle de Map sans passer par une chaine.
 */
export function key(x: number, y: number): number {
  return (x + OFFSET) * SPAN + (y + OFFSET);
}

export function keyX(k: number): number {
  return Math.floor(k / SPAN) - OFFSET;
}

export function keyY(k: number): number {
  return (k % SPAN) - OFFSET;
}

export type Dir = "H" | "V";

/** Pas d'avancement selon le sens. H = vers la droite, V = vers le bas. */
export function step(dir: Dir): { dx: number; dy: number } {
  return dir === "H" ? { dx: 1, dy: 0 } : { dx: 0, dy: 1 };
}

export function perpendicular(dir: Dir): Dir {
  return dir === "H" ? "V" : "H";
}

/**
 * Notation d'un coup sur la grille INFINIE : le sens devant, puis toujours
 * LIGNE PUIS COLONNE, quel que soit le sens.
 *
 *   "H 0,-4"    mot horizontal, ligne 0, depuis la colonne -4
 *   "V 3,12"    mot vertical, depuis la ligne 3, colonne 12
 *
 * L'ordre ne depend plus du sens : une paire qui change de signification selon
 * la lettre qui la precede se lit mal.
 *
 * LA LIGNE MONTE quand son numero grandit, comme en geometrie. A l'interieur,
 * `y` descend -- c'est la convention des ecrans, et tous les journaux deja
 * ecrits la suivent -- mais ce serait un mauvais service a rendre au joueur
 * que de la lui imposer : les colonnes se lisent deja comme des abscisses, les
 * lignes se liront comme des ordonnees. Le signe se retourne ici, a la
 * frontiere de l'affichage, et nulle part ailleurs.
 */
export function formatMove(dir: Dir, x: number, y: number): string {
  return `${dir} ${-y},${x}`;
}

export function parseMove(s: string): { dir: Dir; x: number; y: number } | null {
  const m = /^([HV])\s+(-?\d+),(-?\d+)$/.exec(s.trim());
  if (!m) return null;
  return { dir: m[1] as Dir, x: Number(m[3]), y: -Number(m[2]) };
}

/**
 * Notation d'un coup sur une grille BORNEE : celle du jeu de societe.
 *
 * Les lignes portent des lettres a partir de A, les colonnes des numeros a
 * partir de 1. Un mot horizontal tient sur une ligne, donc sa LETTRE vient en
 * tete ; un mot vertical tient sur une colonne, donc son NUMERO vient en tete.
 *
 *   "B13"   mot horizontal, ligne B, depuis la colonne 13
 *   "13B"   mot vertical, colonne 13, depuis la ligne B
 *
 * Sur un plateau de 15, les lignes vont de A a O et les colonnes de 1 a 15.
 */
export function formatMoveBorne(dir: Dir, x: number, y: number, bornes: number): string {
  const ligne = String.fromCharCode(65 + y + bornes);
  const colonne = x + bornes + 1;
  return dir === "H" ? `${ligne}${colonne}` : `${colonne}${ligne}`;
}

/**
 * Notation d'un coup sur une grille bornee, A LA MANIERE ANGLAISE.
 *
 * Les deux ecoles n'ont pas mis les reperes du meme cote du plateau :
 *
 * | | lignes | colonnes | centre horizontal | centre vertical |
 * |---|---|---|---|---|
 * | francaise | A a O | 1 a 15 | `H8` | `8H` |
 * | anglaise  | 1 a 15 | A a O | `8H` | `H8` |
 *
 * La regle de lecture, elle, est la MEME des deux cotes : c'est l'axe FIXE qui
 * vient en tete. Un mot horizontal tient sur une ligne, donc le repere de la
 * ligne d'abord ; un mot vertical tient sur une colonne, donc celui de la
 * colonne. Ce qui change n'est pas la grammaire, c'est l'alphabet des axes.
 *
 * Piege : au centre, les deux notations produisent les memes deux chaines en
 * les echangeant. `H8` designe un coup horizontal en francais et un coup
 * VERTICAL en anglais. Une partie ne doit donc jamais melanger les deux.
 */
export function formatMoveBorneAnglais(
  dir: Dir, x: number, y: number, bornes: number,
): string {
  const colonne = String.fromCharCode(65 + x + bornes);
  const ligne = y + bornes + 1;
  return dir === "H" ? `${ligne}${colonne}` : `${colonne}${ligne}`;
}

/** De quel cote du plateau se lisent les lettres. */
export type Reperes = "fr" | "en";

/**
 * Les reperes en vigueur, pour tout ce qui s'affiche.
 *
 * Un reglage de LECTEUR, pas de partie : deux joueurs du meme salon peuvent
 * lire la meme grille dans deux conventions sans que rien ne change au jeu.
 * C'est aussi pourquoi il vit ici plutot que dans la configuration, qui voyage
 * avec la grille et vaut pour tout le monde.
 */
let reperes: Reperes = "fr";
export function setReperes(r: Reperes): void { reperes = r; }
export function reperesActifs(): Reperes { return reperes; }

/** L'etiquette d'une colonne, dans les reperes en vigueur. */
export function nomColonne(x: number, bornes: number): string {
  return reperes === "en"
    ? String.fromCharCode(65 + x + bornes)
    : String(x + bornes + 1);
}

/** L'etiquette d'une ligne, dans les reperes en vigueur. */
export function nomLigne(y: number, bornes: number): string {
  return reperes === "en"
    ? String(y + bornes + 1)
    : String.fromCharCode(65 + y + bornes);
}

/** La notation qui convient a la grille : bornee ou infinie. */
export function noteCoup(dir: Dir, x: number, y: number, bornes: number | null): string {
  if (bornes === null) return formatMove(dir, x, y);
  return reperes === "en"
    ? formatMoveBorneAnglais(dir, x, y, bornes)
    : formatMoveBorne(dir, x, y, bornes);
}
