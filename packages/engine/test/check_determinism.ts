/**
 * Le moteur doit rendre EXACTEMENT la meme partie a chaque execution, sur
 * n'importe quelle machine (SPEC.md §5).
 *
 * On rejoue la meme partie avec plusieurs configurations de generation. Le top
 * retenu ne doit dependre ni du mode, ni de l'ordre d'exploration, ni -- surtout
 * -- de la vitesse de la machine. Une version precedente decidait d'elaguer en
 * chronometrant avec performance.now() : deux executions du meme programme
 * jouaient des parties differentes.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop, type GenOptions } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const N = Number(process.argv[2] ?? 200);
const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

function play(opts: GenOptions): { keys: string[]; total: number; tiles: number } {
  const board = new Board(dawg);
  const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed("mondiale", 0)));
  let rel: string[] = [];
  const keys: string[] = [];
  let total = 0;
  for (let n = 1; n <= N; n++) {
    const d = bag.draw(rel);
    const g = generateMoves(board, gaddag, d.rack, opts);
    if (g.moves.length === 0) break;
    const t = pickTop(g.moves, mulberry32(moveSeed("mondiale", n)));
    if (t === null) break;
    total += t.top.score;
    // Les jokers font partie de la cle : deux affectations de meme score posent
    // des caramels differents et font diverger la suite de la partie.
    const jok = t.top.placements.filter((p) => p.blank).map((p) => `${p.x},${p.y}`).join("/");
    keys.push(`${t.top.word}|${t.top.dir}${t.top.x},${t.top.y}|${t.top.score}|${t.isotops.length}|${jok}`);
    board.place(t.top.placements);
    rel = Bag.remainder(d.rack, t.top.placements);
  }
  return { keys, total, tiles: board.size };
}

const runs: [string, GenOptions][] = [
  ["exhaustif", { prune: false }],
  ["defaut", {}],
  ["defaut (bis)", {}],
  ["paliers", { tiers: 10, maxMoves: 200 }],
];

let failures = 0;
const ref = play(runs[0]![1]);
console.log(`${N} coups — reference exhaustive : ${ref.total} pts, ${ref.tiles} caramels\n`);

for (const [name, opts] of runs.slice(1)) {
  const r = play(opts);
  let first = -1;
  for (let i = 0; i < Math.max(ref.keys.length, r.keys.length); i++) {
    if (ref.keys[i] !== r.keys[i]) { first = i; break; }
  }
  const ok = first === -1 && r.total === ref.total && r.tiles === ref.tiles;
  if (!ok) failures++;
  console.log(
    `${name.padEnd(14)} ${String(r.total).padStart(6)} pts  ${String(r.tiles).padStart(5)} caramels  ` +
    (ok ? "identique" : `DIVERGE au coup ${first + 1} : "${ref.keys[first]}" vs "${r.keys[first]}"`),
  );
}

console.log();
console.log(failures === 0
  ? "OK : la partie est identique quel que soit le mode de generation"
  : `${failures} ECHEC(S) — le moteur n'est pas deterministe`);
process.exit(failures === 0 ? 0 : 1);
