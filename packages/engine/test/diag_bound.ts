/** D'ou vient la marge du majorant ? On compare, ancrage par ancrage, le
 *  majorant au meilleur score reellement atteignable depuis cet ancrage. */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop, anchorBound } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { keyX, keyY } from "../src/coords.ts";
import { valueOf } from "../src/alphabet.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const dawg = loadDict(DAWG_PATH), gaddag = loadDict(GADDAG_PATH);
const board = new Board(dawg);
const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed("diag", 0)));
let reliquat: string[] = [];
for (let n = 1; n <= 120; n++) {
  const d = bag.draw(reliquat);
  const g = generateMoves(board, gaddag, d.rack, { prune: false });
  const t = pickTop(g.moves, mulberry32(n));
  if (!t) break;
  board.place(t.top.placements);
  reliquat = Bag.remainder(d.rack, t.top.placements);
}

const draw = bag.draw(reliquat);
const rack = draw.rack;
const g = generateMoves(board, gaddag, rack, { prune: false });
const best = Math.max(...g.moves.map((m) => m.score));
const rv = [...rack].map((c) => (c === "?" ? 0 : valueOf(c))).sort((a, b) => b - a);

// meilleur score REEL par ancrage : un coup appartient a tout ancrage qu'il couvre
const realBy = new Map<string, number>();
for (const m of g.moves) {
  for (let i = 0; i < m.word.length; i++) {
    const x = m.dir === "H" ? m.x + i : m.x;
    const y = m.dir === "V" ? m.y + i : m.y;
    const k = `${m.dir}|${x},${y}`;
    if ((realBy.get(k) ?? -1) < m.score) realBy.set(k, m.score);
  }
}

const bounds: number[] = [];
let above = 0, total = 0;
const ratios: number[] = [];
for (const k of board.anchors) {
  const x = keyX(k), y = keyY(k);
  for (const dir of ["H", "V"] as const) {
    const b = anchorBound(board, x, y, dir, rv);
    bounds.push(b);
    total++;
    if (b >= best) above++;
    const real = realBy.get(`${dir}|${x},${y}`);
    if (real !== undefined && real > 0) ratios.push(b / real);
  }
}
bounds.sort((a, b) => a - b);
const q = (p: number) => bounds[Math.floor((bounds.length - 1) * p)]!;
ratios.sort((a, b) => a - b);

console.log(`tirage ${rack} · ${board.size} caramels · ${total} couples (ancrage, sens)`);
console.log(`meilleur score reel de la position : ${best}`);
console.log();
console.log(`majorants : min ${q(0)}  q25 ${q(.25)}  mediane ${q(.5)}  q75 ${q(.75)}  q90 ${q(.9)}  max ${q(1)}`);
console.log(`couples dont le majorant >= ${best} (donc inelagables) : ${above} / ${total} = ${(100 * above / total).toFixed(1)} %`);
console.log();
console.log(`rapport majorant / meilleur score reel de l'ancrage :`);
console.log(`   mediane x${ratios[Math.floor(ratios.length / 2)]!.toFixed(1)}   q90 x${ratios[Math.floor(ratios.length * .9)]!.toFixed(1)}   max x${ratios[ratios.length - 1]!.toFixed(1)}`);
