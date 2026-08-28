/**
 * Exporte une partie simulee en JSON, pour l'afficher.
 *
 *     node tools/export.ts [coups] [graine] [fichier]
 *
 * Chaque caramel porte le numero du coup qui l'a pose : c'est ce qui permettra
 * de rembobiner la grille coup par coup (SPEC.md §10).
 */
import { writeFileSync } from "node:fs";
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { bonusChar } from "../src/bonus.ts";
import { valueOf } from "../src/alphabet.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

// Autant de paliers ENTIERS que tiennent dans ~120 solutions. Les logiciels de
// topping en affichent une soixantaine ; 120 laisse de la marge pour revoir une
// partie sans jamais couper un palier en deux (SPEC.md §10).
const TIERS = 40;
const CAP = 120;

const MOVES = Number(process.argv[2] ?? 500);
const SEED = process.argv[3] ?? "mondiale";
const OUT = process.argv[4] ?? "grille.json";

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const board = new Board(dawg);
const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed(SEED, 0)));

interface OutTile { x: number; y: number; l: string; b: 0 | 1; n: number }
interface OutMove {
  n: number; rack: string; notation: string; word: string;
  dir: string; x: number; y: number; score: number; iso: number; placed: number;
  /** Paliers de score, du meilleur au moins bon. Chaque palier est COMPLET. */
  tiers: { score: number; moves: [string, string, number, number][] }[];
}

const tiles: OutTile[] = [];
const moves: OutMove[] = [];
let reliquat: string[] = [];
let cumul = 0;

for (let n = 1; n <= MOVES; n++) {
  const draw = bag.draw(reliquat);
  // TIERS paliers sous le top, plafonnes a CAP coups, toujours a une frontiere
  // de palier (SPEC.md §10). Un tirage explosif en rend naturellement moins.
  const gen = generateMoves(board, gaddag, draw.rack, { tiers: TIERS, maxMoves: CAP });
  if (gen.moves.length === 0) break;
  const top = pickTop(gen.moves, mulberry32(moveSeed(SEED, n)));
  if (top === null) break;
  const m = top.top;
  cumul += m.score;

  for (const p of m.placements) {
    tiles.push({ x: p.x, y: p.y, l: p.letter, b: p.blank ? 1 : 0, n });
  }
  moves.push({
    n, rack: draw.rack, notation: draw.notation, word: m.word,
    dir: m.dir, x: m.x, y: m.y, score: m.score,
    iso: top.isotops.length, placed: m.placements.length,
    tiers: top.tiers.map((t) => ({
      score: t[0]!.score,
      moves: t.map((q) => [q.word, q.dir, q.x, q.y] as [string, string, number, number]),
    })),
  });
  board.place(m.placements);
  reliquat = Bag.remainder(draw.rack, m.placements);
}

const b = board.bounds()!;
// Les cases bonus de l'emprise, avec une marge : bonusChar est une fonction
// pure, mais la recalculer dans le navigateur voudrait dire dupliquer le motif.
const pad = 6;
const bonus: string[] = [];
for (let y = b.minY - pad; y <= b.maxY + pad; y++) {
  let row = "";
  for (let x = b.minX - pad; x <= b.maxX + pad; x++) row += bonusChar(x, y);
  bonus.push(row);
}

const values: Record<string, number> = {};
for (const L of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") values[L] = valueOf(L);

writeFileSync(OUT, JSON.stringify({
  seed: SEED,
  moves,
  tiles,
  total: cumul,
  bounds: { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad },
  bonus,
  values,
}), "utf8");

const tierMoves = moves.reduce((a, m) => a + m.tiers.reduce((x, t) => x + t.moves.length, 0), 0);
console.log(
  `${moves.length} coups, ${tiles.length} caramels, ` +
  `emprise ${b.maxX - b.minX + 1}x${b.maxY - b.minY + 1}, ` +
  `${tierMoves.toLocaleString("fr")} coups de paliers -> ${OUT}`,
);
