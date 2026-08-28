/** Banc d'essai : avec et sans elagage, sur une position de milieu de partie. */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const dawg = loadDict(DAWG_PATH), gaddag = loadDict(GADDAG_PATH);
const board = new Board(dawg);
const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed("bench", 0)));
let rel: string[] = [];
for (let n = 1; n <= 150; n++) {
  const d = bag.draw(rel);
  const g = generateMoves(board, gaddag, d.rack);
  if (!g.moves.length) break;
  const t = pickTop(g.moves, mulberry32(moveSeed("bench", n)));
  if (!t) break;
  board.place(t.top.placements);
  rel = Bag.remainder(d.rack, t.top.placements);
}
console.log(`position : ${board.size} caramels, ${board.anchors.size} ancrages\n`);
console.log("tirage      sans elagage   avec elagage   gain   ancrages ecartes   top");
for (const r of ["AEILRST", "?AEILRT", "?ADIORS", "??AEILR", "BCDFGHJ", "?AILNOS"]) {
  generateMoves(board, gaddag, r, { prune: true });
  const slow = Math.min(...[0, 0].map(() => generateMoves(board, gaddag, r, { prune: false }).stats.ms));
  const runs = [0, 0, 0].map(() => generateMoves(board, gaddag, r, { prune: true }).stats);
  const fast = Math.min(...runs.map((s) => s.ms));
  const st = runs[0]!;
  const top = pickTop(generateMoves(board, gaddag, r, { prune: true }).moves, mulberry32(1))!;
  console.log(
    `${r.padEnd(10)} ${slow.toFixed(0).padStart(8)} ms ${fast.toFixed(0).padStart(11)} ms   ` +
    `x${(slow / fast).toFixed(1).padStart(4)}   ${(100 * st.pruned / (st.anchors + st.pruned)).toFixed(0).padStart(3)} %` +
    `             ${String(top.bestScore).padStart(4)}`,
  );
}
