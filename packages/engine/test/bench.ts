/** Banc d'essai du generateur, en isolant les tirages a joker. */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

// On construit une position de milieu de partie, puis on chronometre des
// tirages fixes -- avec et sans joker -- pour comparer des choses comparables.
const board = new Board(dawg);
const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed("bench", 0)));
let reliquat: string[] = [];
for (let n = 1; n <= 150; n++) {
  const d = bag.draw(reliquat);
  const g = generateMoves(board, gaddag, d.rack);
  if (g.moves.length === 0) break;
  const t = pickTop(g.moves, mulberry32(moveSeed("bench", n)));
  if (!t) break;
  board.place(t.top.placements);
  reliquat = Bag.remainder(d.rack, t.top.placements);
}

const racks = ["AEILRST", "?AEILRT", "?ADIORS", "??AEILR", "BCDFGHJ".slice(0, 7), "?AILNOS"];
console.log(`position de reference : ${board.size} caramels, ${board.anchors.size} ancrages\n`);
console.log("tirage     coups generes    temps");
for (const r of racks) {
  generateMoves(board, gaddag, r); // chauffe
  const runs = [0, 0, 0].map(() => generateMoves(board, gaddag, r).stats.ms);
  const g = generateMoves(board, gaddag, r);
  const best = Math.min(...runs);
  console.log(`${r.padEnd(10)} ${g.moves.length.toLocaleString("fr").padStart(10)}    ${best.toFixed(0).padStart(6)} ms`);
}
