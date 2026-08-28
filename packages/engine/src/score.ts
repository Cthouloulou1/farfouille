/**
 * Calcul du score d'un coup. Voir SPEC.md §6.
 *
 * Les multiplicateurs ne s'appliquent qu'aux tuiles NOUVELLEMENT posees. Un mot
 * perpendiculaire forme par une tuile nouvelle rapporte, et prend le
 * multiplicateur de mot de cette case.
 */
import { bonusAt } from "./bonus.ts";
import { valueOf } from "./alphabet.ts";
import { step, type Dir } from "./coords.ts";
import type { Board, Placement } from "./board.ts";

/** Prime pour les 7 caramels poses en un coup. */
export const BINGO_BONUS = 50;
export const RACK_SIZE = 7;

export interface Move {
  dir: Dir;
  /** Coordonnees de la PREMIERE lettre du mot tel qu'il se lit. */
  x: number;
  y: number;
  /** Le mot complet, tuiles preexistantes incluses. */
  word: string;
  /** Uniquement les tuiles nouvelles. */
  placements: Placement[];
  score: number;
}

/**
 * Score d'un mot pose en (x,y) dans le sens dir.
 *
 * `newAt` indique, pour chaque position du mot, si la tuile est nouvelle ;
 * `blankAt` si elle est posee avec un joker.
 */
export function scoreWord(
  board: Board,
  dir: Dir,
  x: number,
  y: number,
  word: string,
  newAt: readonly boolean[],
  blankAt: readonly boolean[],
): number {
  const { dx, dy } = step(dir);
  let main = 0;
  let mainMult = 1;
  let cross = 0;
  let placed = 0;

  for (let i = 0; i < word.length; i++) {
    const cx = x + dx * i;
    const cy = y + dy * i;
    const letter = word[i]!;
    const isBlank = blankAt[i] === true;
    const raw = isBlank ? 0 : valueOf(letter);

    if (!newAt[i]) {
      // Tuile preexistante : aucun bonus, elle a deja servi.
      main += raw;
      continue;
    }

    placed++;
    const b = bonusAt(cx, cy);
    const here = raw * b.letter;
    main += here;
    mainMult *= b.word;

    const cc = board.crossCheck(dir, cx, cy);
    if (cc.has) cross += (cc.score + here) * b.word;
  }

  return main * mainMult + cross + (placed === RACK_SIZE ? BINGO_BONUS : 0);
}

/** Score d'un coup deja construit. Le plateau doit etre dans l'etat AVANT le coup. */
export function scoreMove(board: Board, move: Move): number {
  const { dx, dy } = step(move.dir);
  const newAt: boolean[] = [];
  const blankAt: boolean[] = [];
  const byKey = new Map<string, Placement>();
  for (const p of move.placements) byKey.set(`${p.x},${p.y}`, p);

  for (let i = 0; i < move.word.length; i++) {
    const p = byKey.get(`${move.x + dx * i},${move.y + dy * i}`);
    newAt.push(p !== undefined);
    blankAt.push(p?.blank === true);
  }
  return scoreWord(board, move.dir, move.x, move.y, move.word, newAt, blankAt);
}

/**
 * Poids d'une case pour l'arbitrage joker / lettre reelle.
 *
 * Perdre une lettre reelle au profit d'un joker coute
 * `valeur(L) x poids(case)`. Comme toutes les positions candidates portent la
 * MEME lettre, il suffit de classer par ce poids : les jokers vont sur les
 * cases de poids le plus faible.
 */
export function blankWeight(
  board: Board,
  dir: Dir,
  cx: number,
  cy: number,
  mainWordMult: number,
): number {
  const b = bonusAt(cx, cy);
  const cc = board.crossCheck(dir, cx, cy);
  return b.letter * (mainWordMult + (cc.has ? b.word : 0));
}

/**
 * Choisit ou placer les jokers pour maximiser le score. Voir SPEC.md §6.
 *
 * Jamais de gauche a droite : si un `E` reel et un joker peuvent tous deux
 * servir et que l'une des cases est une lettre compte triple, le vrai `E` doit
 * y aller.
 *
 * `positions` liste, par lettre, les index du mot ou cette lettre est posee
 * depuis le chevalet. Retourne l'ensemble des index qui doivent etre des jokers,
 * ou null si le chevalet ne suffit pas.
 */
export function assignBlanks(
  positions: ReadonlyMap<string, readonly number[]>,
  realCounts: ReadonlyMap<string, number>,
  blanksAvailable: number,
  weightOf: (index: number) => number,
): Set<number> | null {
  const blanks = new Set<number>();
  let left = blanksAvailable;

  for (const [letter, idxs] of positions) {
    const real = realCounts.get(letter) ?? 0;
    const need = idxs.length - real;
    if (need <= 0) continue;
    if (need > left) return null;
    left -= need;
    // Les jokers vont sur les cases qui rapportent le moins.
    const sorted = [...idxs].sort((a, b) => weightOf(a) - weightOf(b));
    for (let i = 0; i < need; i++) blanks.add(sorted[i]!);
  }
  return blanks;
}
