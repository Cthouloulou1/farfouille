/** Les pics de temps de calcul sont-ils imputables aux jokers ? */
import { loadDict } from "../src/dictionary_node.ts";
import { simulate } from "../src/simulate.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const log = simulate(Number(process.argv[2] ?? 250), "mondiale", dawg, gaddag);

const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

const byBlanks = new Map<number, number[]>();
for (const r of log) {
  const b = (r.rack.match(/\?/g) ?? []).length;
  if (!byBlanks.has(b)) byBlanks.set(b, []);
  byBlanks.get(b)!.push(r.genMs);
}
console.log("jokers   coups   mediane      max     part des coups");
for (const b of [...byBlanks.keys()].sort()) {
  const v = byBlanks.get(b)!;
  console.log(
    `   ${b}   ${String(v.length).padStart(5)}   ${med(v).toFixed(0).padStart(6)} ms  ${Math.max(...v).toFixed(0).padStart(7)} ms   ${(100 * v.length / log.length).toFixed(0)} %`,
  );
}

const sorted = [...log].sort((a, b) => b.genMs - a.genMs);
console.log("\nles 8 coups les plus lents :");
for (const r of sorted.slice(0, 8)) {
  const b = (r.rack.match(/\?/g) ?? []).length;
  console.log(`  coup ${String(r.n).padStart(3)}  ${r.genMs.toFixed(0).padStart(6)} ms  tirage ${r.rack.padEnd(8)} ${b} joker(s)  ${String(r.anchors).padStart(4)} ancrages  ${r.candidates.toLocaleString("fr").padStart(7)} coups generes`);
}
