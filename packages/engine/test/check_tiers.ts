/**
 * Les paliers de score doivent etre COMPLETS, jamais tronques.
 *
 * Pour chaque tirage on genere deux fois : une fois en demandant N paliers, une
 * fois exhaustivement. Chaque palier retenu doit alors contenir EXACTEMENT les
 * memes coups que dans la generation exhaustive -- pas un de moins.
 *
 * C'est le point que le compte plat ratait : sur `?AEILRT`, le palier a 78
 * points compte 254 coups, et une coupe a 100 en affichait 74 sans signaler que
 * les 180 autres existaient.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG, strictRejectPolicy } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";
import type { Move } from "../src/score.ts";

const TIERS = 10;
const CAP = 400;

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

const board = new Board(dawg);
const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed("bench", 0)));
let rel: string[] = [];
for (let n = 1; n <= 150; n++) {
  const d = bag.draw(rel);
  const g = generateMoves(board, gaddag, d.rack);
  if (g.moves.length === 0) break;
  const t = pickTop(g.moves, mulberry32(moveSeed("bench", n)));
  if (t === null) break;
  board.place(t.top.placements);
  rel = Bag.remainder(d.rack, t.top.placements);
}

const RACKS = ["AEILRST", "AEBCDFG", "AEQVWXZ", "IOUVWXZ", "?AEILRT", "??AEILR"];
const sig = (l: readonly Move[]) =>
  l.map((m) => `${m.dir}${m.x},${m.y}:${m.word}`).sort().join("|");

const ms = (f: () => unknown, runs = 3) => {
  f();
  let b = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    b = Math.min(b, performance.now() - t);
  }
  return b;
};

let failures = 0;
console.log(`Paliers demandes : ${TIERS} sous le top, plafond ${CAP} coups\n`);
console.log("tirage      top seul   + paliers   surcout   isotops   paliers   coups   verdict");
console.log("-".repeat(88));

for (const rack of RACKS) {
  if (strictRejectPolicy([...rack])) { console.log(`${rack} : tirage rejete a la pioche, ignore`); continue; }

  const t0 = ms(() => generateMoves(board, gaddag, rack, { tiers: 0 }));
  const t1 = ms(() => generateMoves(board, gaddag, rack, { tiers: TIERS, maxMoves: CAP }));

  const got = pickTop(generateMoves(board, gaddag, rack, { tiers: TIERS, maxMoves: CAP }).moves, mulberry32(1))!;
  const all = pickTop(generateMoves(board, gaddag, rack, { prune: false }).moves, mulberry32(1))!;

  const fullByScore = new Map<number, Move[]>();
  for (const t of all.tiers) fullByScore.set(t[0]!.score, t);

  let verdict = "complets";
  // Chaque palier retenu doit etre identique au palier correspondant complet.
  for (const t of got.tiers) {
    const ref = fullByScore.get(t[0]!.score);
    if (ref === undefined || sig(t) !== sig(ref)) {
      verdict = `PALIER ${t[0]!.score} TRONQUE (${t.length}/${ref?.length ?? 0})`;
      failures++;
      break;
    }
  }
  // Les paliers retenus doivent etre les meilleurs, sans trou.
  if (verdict === "complets") {
    for (let i = 0; i < got.tiers.length; i++) {
      if (got.tiers[i]![0]!.score !== all.tiers[i]![0]!.score) {
        verdict = `PALIER MANQUANT au rang ${i}`;
        failures++;
        break;
      }
    }
  }
  // Les isotops ne sont jamais tronques, meme au-dessus du plafond.
  if (got.isotops.length !== all.isotops.length) {
    verdict = `ISOTOPS TRONQUES (${got.isotops.length}/${all.isotops.length})`;
    failures++;
  }

  const total = got.tiers.reduce((a, t) => a + t.length, 0);
  console.log(
    `${rack.padEnd(10)} ${t0.toFixed(0).padStart(6)} ms ${t1.toFixed(0).padStart(9)} ms   ` +
    `x${(t1 / t0).toFixed(2).padStart(5)}   ${String(got.isotops.length).padStart(7)}   ` +
    `${String(got.tiers.length).padStart(7)}   ${String(total).padStart(5)}   ${verdict}`,
  );
}

console.log();
console.log(failures === 0
  ? "OK : tous les paliers retenus sont complets et contigus, aucun isotop tronque"
  : `${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
