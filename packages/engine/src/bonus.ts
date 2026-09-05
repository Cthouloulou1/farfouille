/**
 * Cases bonus de la grille infinie. Voir SPEC.md §3.
 *
 * Un motif est une FONCTION PURE de (x, y), sans aucun stockage : c'est ce qui
 * rend le design remplacable a volonte. Changer de motif = changer de fonction,
 * rien d'autre dans le moteur ne bouge.
 */

export interface Bonus {
  /** Multiplicateur de la lettre posee sur la case : 1, 2 ou 3. */
  letter: number;
  /** Multiplicateur du mot entier : 1, 2 ou 3. */
  word: number;
}

/**
 * Q = mot quadruple, T = mot triple, D = mot double,
 * q = lettre quadruple, t = lettre triple, d = lettre double, . = nue.
 */
export type LayoutFn = (x: number, y: number) => string;

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

// --------------------------------------------------------------- pave classique

const CLASSIQUE = [
  "T..d...T...d..T",
  ".D...t...t...D.",
  "..D...d.d...D..",
  "d..D...d...D..d",
  "....D.....D....",
  ".t...t...t...t.",
  "..d...d.d...d..",
  "T..d...*...d..T",
  "..d...d.d...d..",
  ".t...t...t...t.",
  "....D.....D....",
  "d..D...d...D..d",
  "..D...d.d...D..",
  ".D...t...t...D.",
  "T..d...T...d..T",
] as const;

/**
 * Variante "croix courte" : meme plateau, mais les branches de la croix de MCD
 * sont raccourcies -- on retire les MCD des indices 1, 2, 12 et 13.
 *
 * En periodicite 14, l'indice 13 d'un pave et l'indice 1 du suivant ne sont qu'a
 * 2 cases : la croix complete produisait des MCD a portee d'un mot de 3 lettres.
 */
const CROIX_COURTE = [
  "T..d...T...d..T",
  ".....t...t.....",
  "......d.d......",
  "d..D...d...D..d",
  "....D.....D....",
  ".t...t...t...t.",
  "..d...d.d...d..",
  "T..d...*...d..T",
  "..d...d.d...d..",
  ".t...t...t...t.",
  "....D.....D....",
  "d..D...d...D..d",
  "......d.d......",
  ".....t...t.....",
  "T..d...T...d..T",
] as const;

/**
 * Croix courte ENRICHIE : on ajoute quatre mots comptent triple a l'interieur
 * du pave, aux indices 3 et 10 des lignes 3 et 10.
 *
 * Le pavage souffre d'une penurie de MCT -- 1,5 % contre 3,6 % au plateau
 * officiel -- parce que ses MCT vivent sur les bords, et que les bords sont
 * partages entre paves. En ajouter a l'interieur est le seul moyen de remonter
 * la densite.
 *
 * Les indices 3 et 10 ne sont pas quelconques : ils sont distants de 7, et en
 * periodicite 14 une paire {i, i+7} donne un espacement de 7 REGULIER, aussi
 * bien dans le pave qu'entre paves. C'est la condition pour garder la jonction
 * de 8 cases, donc le nonuple en huit lettres.
 */
function withCells(tile: readonly string[], edits: readonly [number, number, string][]): string[] {
  const rows = tile.map((r) => r.split(""));
  for (const [x, y, c] of edits) rows[y]![x] = c;
  return rows.map((r) => r.join(""));
}

const CROIX_ENRICHIE = withCells(CROIX_COURTE, [
  [3, 3, "T"], [10, 3, "T"],
  [3, 10, "T"], [10, 10, "T"],
]);

/**
 * Pavage propose : pave 29x29, periode 28.
 *
 * Deux caracteres corriges par rapport a la saisie manuelle. Le motif est
 * rigoureusement egal a sa transposee partout ailleurs, et les seuls desaccords
 * etaient les cellules (26,5) et (26,23) : le `t` y devait etre un `d`.
 *
 * Mesure : MCT 1,8 %, MCD 6,1 %, LCT 4,6 %, LCD 9,9 %, jonctions 8 et 7 -- le
 * nonuple en huit lettres et le quadruple en sept sont preserves. C'est le seul
 * des paves proposes a porter des MCT a l'INTERIEUR et pas seulement sur ses
 * bords, ce qui lui donne le plus petit maximum de score de la serie.
 */
const PAVE_1 = [
  "T..d...T...d..T..d...T...d..T",
  ".t..d.......d...d.......d..t.",
  "..t..d.......d.d.......d..t..",
  "d..D..d..D....d....D..d..D..d",
  ".d..D...t...t...t...t...D..d.",
  "..d..D.....D.....D.....D..d..",
  "...d..D...............D..d...",
  "T......T..d...T...d..T......T",
  "....t...D...t...t...D...t....",
  "...D.....D...d.d...D.....D...",
  ".......d..D...d...D..d.......",
  "d....D.....D.....D.....D....d",
  ".d..t...t...t...t...t...t..d.",
  "..d......d...d.d...d......d..",
  "T..d...T..d...D...d..T...d..T",
  "..d......d...d.d...d......d..",
  ".d..t...t...t...t...t...t..d.",
  "d....D.....D.....D.....D....d",
  ".......d..D...d...D..d.......",
  "...D.....D...d.d...D.....D...",
  "....t...D...t...t...D...t....",
  "T......T..d...T...d..T......T",
  "...d..D...............D..d...",
  "..d..D.....D.....D.....D..d..",
  ".d..D...t...t...t...t...D..d.",
  "d..D..d..D....d....D..d..D..d",
  "..t..d.......d.d.......d..t..",
  ".t..d.......d...d.......d..t.",
  "T..d...T...d..T..d...T...d..T",
] as const;

/**
 * Pavage a l'infini d'un plateau 15x15, avec PERIODE 14 et non 15.
 *
 * Les bords du plateau officiel sont deja identiques -- la ligne 14 est la copie
 * exacte de la ligne 0. On fait donc COINCIDER ces bords au lieu de les
 * juxtaposer : les paves se recouvrent d'une ligne et l'indice 14 n'est jamais
 * atteint. Avec une periode de 15, les MCT des bords se retrouvaient collees.
 */
/**
 * Le pave est decrit sur n x n cases, mais la PERIODE vaut n-1 : la derniere
 * ligne est la copie de la premiere, la derniere colonne celle de la premiere.
 * On les fait coincider au lieu de les juxtaposer, sans quoi les bonus des deux
 * bords se retrouvent colles.
 */
function tiled(tile: readonly string[]): LayoutFn {
  const n = tile.length;
  const period = n - 1;
  const center = period / 2;
  return (x, y) => tile[mod(y + center, period)]![mod(x + center, period)]!;
}

// ------------------------------------------------------------- reseau oblique

/**
 * Appartenance au reseau engendre par (a, b) et (-b, a) -- un reseau carre
 * TOURNE. Son indice, donc une case sur n, vaut n = a² + b².
 *
 * Etre incline est tout l'interet : deux points du reseau ne sont jamais
 * alignes sur une meme ligne ou colonne a courte distance, alors que le pavage
 * classique aligne ses bonus par construction.
 */
function onLattice(a: number, b: number, dx = 0, dy = 0): (x: number, y: number) => boolean {
  const n = a * a + b * b;
  return (x, y) => {
    const u = x - dx;
    const v = y - dy;
    return mod(a * u + b * v, n) === 0 && mod(a * v - b * u, n) === 0;
  };
}

/**
 * Chaque type de bonus sur son propre reseau oblique. Les decalages evitent que
 * tout se superpose a l'origine, qui doit rester une case de depart neutre.
 *
 * Densites visees, celles du plateau officiel : MCT 3,6 %, MCD 7,6 %, LCT 5,3 %,
 * LCD 10,7 %.
 */
const MCT_OBL = onLattice(5, 1, 3, 4);    // 1 case sur 26
const MCD_OBL = onLattice(3, 2, 1, 0);    // 1 sur 13
const LCT_OBL = onLattice(4, 1, 2, 2);    // 1 sur 17
const LCD_OBL = onLattice(3, 1, 0, 1);    // 1 sur 10

/**
 * Reseau oblique APPARIE.
 *
 * Un reseau uniforme repartit ses bonus si regulierement qu'aucun mot n'atteint
 * jamais deux MCT : la jonction minimale monte a 27 cases, alors qu'un mot en
 * fait 15 au plus. Le nonuple devient impossible.
 *
 * Or le nonuple du plateau officiel ne vient pas de la densite mais d'un
 * APPARIEMENT deliberé : ses MCT vont par deux, a 7 cases l'une de l'autre. On
 * reproduit donc ce couplage -- un reseau de base plus creux, chaque point
 * portant un partenaire a 7 cases, horizontalement ou verticalement en
 * alternance.
 */
function pairedLattice(a: number, b: number, dx: number, dy: number, gap = 7) {
  const n = a * a + b * b;
  const on = (u: number, v: number) => mod(a * u + b * v, n) === 0 && mod(a * v - b * u, n) === 0;
  const index = (u: number, v: number) => (a * u + b * v) / n;
  return (x: number, y: number): boolean => {
    const u = x - dx;
    const v = y - dy;
    if (on(u, v)) return true;
    // Le partenaire, a `gap` cases : c'est lui qui rend le nonuple atteignable.
    if (on(u - gap, v)) return mod(index(u - gap, v), 2) === 0;
    if (on(u, v - gap)) return mod(index(u, v - gap), 2) === 1;
    return false;
  };
}

// Parametres trouves par balayage (test/search_pairs.ts) : ce sont les seuls,
// parmi ceux essayes, qui rendent le nonuple ET gardent une jonction de 8 cases.
// Un appariement mal choisi recree des MCT a 3 cases -- exactement le defaut de
// couture qu'on avait elimine.
const MCT_PAIR = pairedLattice(6, 5, 3, 4, 7);   // jonction 8, densite 3,3 %
const MCD_PAIR = pairedLattice(4, 3, 1, 0, 6);   // jonction 7, comme au plateau

const OBLIQUE_PAIRE: LayoutFn = (x, y) =>
  MCT_PAIR(x, y) ? "T"
  : MCD_PAIR(x, y) ? "D"
  : LCT_OBL(x, y) ? "t"
  : LCD_OBL(x, y) ? "d"
  : ".";

const OBLIQUE: LayoutFn = (x, y) =>
  MCT_OBL(x, y) ? "T"
  : MCD_OBL(x, y) ? "D"
  : LCT_OBL(x, y) ? "t"
  : LCD_OBL(x, y) ? "d"
  : ".";

// --------------------------------------------------- periodes premieres entre elles

/**
 * Un type de bonus par forme lineaire, modulo une periode qui lui est propre.
 *
 * `(a·x + b·y) ≡ 0 [n]` place exactement UN bonus toutes les n cases sur
 * n'importe quelle ligne et n'importe quelle colonne, des lors que a et b sont
 * inversibles modulo n. L'espacement est donc parfaitement regulier sans jamais
 * aligner deux bonus du meme type a courte distance.
 *
 * Les quatre periodes etant premieres entre elles, le motif combine ne se repete
 * qu'au bout de 29 x 13 x 17 x 11 = 70 499 cases : a l'echelle d'une partie, il
 * ne se repete pas.
 */
function onLine(a: number, b: number, n: number, off = 0): (x: number, y: number) => boolean {
  return (x, y) => mod(a * x + b * y + off, n) === 0;
}

const MCT_PRE = onLine(2, 5, 29, 7);
const MCD_PRE = onLine(3, 1, 13, 5);
const LCT_PRE = onLine(1, 3, 17, 3);
const LCD_PRE = onLine(1, 2, 11, 4);

const PREMIERS: LayoutFn = (x, y) =>
  MCT_PRE(x, y) ? "T"
  : MCD_PRE(x, y) ? "D"
  : LCT_PRE(x, y) ? "t"
  : LCD_PRE(x, y) ? "d"
  : ".";

// --------------------------------------------------------------------- API

// ------------------------------------------------------------ plateaux bornes

/**
 * La SUPER GRILLE : 21x21, avec des cases qui comptent quadruple.
 *
 * Le plateau du commerce agrandi de trois cases de chaque cote. Les quatre
 * coins portent des mots comptent QUADRUPLE, et huit cases portent des
 * lettres comptent quadruple : ce sont les deux primes que le plateau du
 * commerce n'a pas, et elles n'existent que la.
 *
 * Verifie par programme : le motif est invariant par les quatre symetries du
 * carre -- les deux miroirs et les deux diagonales. Densites : MCQ 0,91 %,
 * MCT 3,63 %, MCD 9,30 %, LCQ 1,81 %, LCT 4,54 %, LCD 8,16 %.
 *
 * Il ne se PAVE PAS : c'est un plateau borne, comme le 15x15 du commerce, et
 * ses bords ne sont pas faits pour se recouvrir.
 */
const SUPER = [
  "Q..d...T..d..T...d..Q",
  ".D..t...D...D...t..D.",
  "..D..q...D.D...q..D..",
  "d..T..d...T...d..T..d",
  ".t..D...t...t...D..t.",
  "..q..D...d.d...D..q..",
  "...d..D...d...D..d...",
  "T......D.....D......T",
  ".D..t...t...t...t..D.",
  "..D..d...d.d...d..D..",
  "d..T..d...D...d..T..d",
  "..D..d...d.d...d..D..",
  ".D..t...t...t...t..D.",
  "T......D.....D......T",
  "...d..D...d...D..d...",
  "..q..D...d.d...D..q..",
  ".t..D...t...t...D..t.",
  "d..T..d...T...d..T..d",
  "..D..q...D.D...q..D..",
  ".D..t...D...D...t..D.",
  "Q..d...T..d..T...d..Q",
] as const;

/**
 * Le plateau du commerce, NON pave : une seule grille de 15x15 centree sur
 * l'origine. Le pavage `classique` repete le motif a l'infini avec une periode
 * de 14, ce qui fait coincider les bords ; sur une grille bornee il faut au
 * contraire les quinze colonnes distinctes.
 */
export const CLASSIQUE_15: LayoutFn = (x, y) => {
  const i = y + 7, j = x + 7;
  if (i < 0 || i > 14 || j < 0 || j > 14) return ".";
  return CLASSIQUE[i]![j]!;
};

/**
 * La super grille, NON pavee : une seule grille de 21x21 centree sur l'origine.
 * Le demi-cote correspondant est 10, comme 7 pour le plateau du commerce.
 */
export const SUPER_21: LayoutFn = (x, y) => {
  const i = y + 10, j = x + 10;
  if (i < 0 || i > 20 || j < 0 || j > 20) return ".";
  return SUPER[i]![j]!;
};

export const LAYOUTS = {
  classique: tiled(CLASSIQUE),
  classique15: CLASSIQUE_15,
  super21: SUPER_21,
  croixCourte: tiled(CROIX_COURTE),
  pave1: tiled(PAVE_1),
  croixEnrichie: tiled(CROIX_ENRICHIE),
  oblique: OBLIQUE,
  obliquePaire: OBLIQUE_PAIRE,
  premiers: PREMIERS,
} as const;

export type LayoutName = keyof typeof LAYOUTS;

// Motif actif. Mutable au niveau du module : acceptable en phase 0, ou un seul
// pavage tourne a la fois. En phase 3, chaque Board porte sa propre config de
// bonus (SPEC.md §8) et ceci devra devenir un parametre du Board.
let active: LayoutFn = LAYOUTS.classique;
let activeName: LayoutName = "classique";

/** Installe un pave quelconque, decrit par ses n lignes. Voir tools/compare_tiles.ts. */
export function setCustomLayout(tile: readonly string[], label = "custom"): void {
  active = tiled(tile);
  activeName = label as LayoutName;
}

export function setLayout(name: LayoutName): void {
  active = LAYOUTS[name];
  activeName = name;
}

export function currentLayout(): LayoutName {
  return activeName;
}

/**
 * Le pavage actif, sous forme de fonction. Sert a figer le reglage courant dans
 * la configuration d'une partie au moment ou sa grille est creee.
 */
export function activeLayout(): LayoutFn {
  return active;
}

/** Symbole brut de la case, pour l'affichage et les tests. '.' = case nue. */
/**
 * Symbole brut de la case. `pavage` permet de repondre pour une partie donnee
 * plutot que pour le reglage global -- sans quoi l'affichage peint le motif
 * d'une autre variante que celle qui se joue.
 */
export function bonusChar(x: number, y: number, pavage: LayoutFn = active): string {
  return pavage(x, y);
}

const PLAIN: Bonus = Object.freeze({ letter: 1, word: 1 });

/**
 * Le bonus d'une case. `pavage` permet de repondre pour une partie donnee
 * plutot que pour le reglage global -- indispensable des que plusieurs salons
 * tournent dans le meme processus.
 */
export function bonusAt(x: number, y: number, pavage: LayoutFn = active): Bonus {
  switch (pavage(x, y)) {
    case "Q": return { letter: 1, word: 4 };
    case "T": return { letter: 1, word: 3 };
    case "D": case "*": return { letter: 1, word: 2 };
    case "q": return { letter: 4, word: 1 };
    case "t": return { letter: 3, word: 1 };
    case "d": return { letter: 2, word: 1 };
    default: return PLAIN;
  }
}

/** La case de depart, que le premier mot doit couvrir. */
export const START_X = 0;
export const START_Y = 0;
