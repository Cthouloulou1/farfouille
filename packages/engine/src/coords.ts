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
 * Notation d'un coup : le sens DEVANT, puis la coordonnee CONSTANTE d'abord.
 *
 * C'est l'usage du duplicate, celui de la notation A5 / 5A : un mot horizontal
 * tient sur une seule LIGNE, donc la ligne vient en tete ; un mot vertical tient
 * sur une seule COLONNE, donc la colonne vient en tete.
 *
 *   H ligne,colonne     "H 0,-4"   mot horizontal, ligne 0, depuis la colonne -4
 *   V colonne,ligne     "V 12,-3"  mot vertical, colonne 12, depuis la ligne -3
 *
 * L'ordre de la paire depend donc du sens : c'est voulu, et c'est ce que lit un
 * joueur de duplicate.
 */
export function formatMove(dir: Dir, x: number, y: number): string {
  return dir === "H" ? `H ${y},${x}` : `V ${x},${y}`;
}

export function parseMove(s: string): { dir: Dir; x: number; y: number } | null {
  const m = /^([HV])\s+(-?\d+),(-?\d+)$/.exec(s.trim());
  if (!m) return null;
  const dir = m[1] as Dir;
  const a = Number(m[2]);
  const b = Number(m[3]);
  return dir === "H" ? { dir, x: b, y: a } : { dir, x: a, y: b };
}
