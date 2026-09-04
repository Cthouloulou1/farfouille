/** Simule la meme partie sur chaque pave : ce que les mesures statiques ne disent pas. */
import { readFileSync } from "node:fs";
import { loadDict } from "../src/dictionary_node.ts";
import { simulate } from "../src/simulate.ts";
import { setCustomLayout, setLayout, type LayoutName } from "../src/bonus.ts";
import { bonusAt } from "../src/bonus.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const N = Number(process.argv[3] ?? 150);

function parseTiles(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.length > 0 && /^[TDtd.*]+$/.test(t)) cur.push(t);
    else { if (cur.length >= 5) out.push(cur); cur = []; }
  }
  if (cur.length >= 5) out.push(cur);
  return out;
}
const tiles = parseTiles(readFileSync(process.argv[2]!, "utf8"));
if (tiles[0]?.length === 29) for (const y of [5, 23]) {
  const r = tiles[0][y]!;
  if (r[26] === "t") tiles[0][y] = r.slice(0, 26) + "d" + r.slice(27);
}
if (tiles[2] && tiles[2][13]?.length === 14) tiles[2][13] += ".";

function run(label: string) {
  const log = simulate(N, "compare", dawg, gaddag);
  const total = log.reduce((a, r) => a + r.move.score, 0);
  const farfouilles = log.filter((r) => r.move.placements.length === 7).length;
  let nonuples = 0, quadruples = 0;
  for (const r of log) {
    let m = 1;
    for (const p of r.move.placements) m *= bonusAt(p.x, p.y).word;
    if (m >= 9) nonuples++;
    else if (m >= 4) quadruples++;
  }
  const best = Math.max(...log.map((r) => r.move.score));
  const iso = log.map((r) => r.isotops).sort((a, b) => a - b);
  console.log(
    `${label.padEnd(16)} ${(total / log.length).toFixed(1).padStart(6)} ` +
    `${String(best).padStart(6)} ${(100 * farfouilles / log.length).toFixed(0).padStart(7)}% ` +
    `${(100 * nonuples / log.length).toFixed(1).padStart(8)}% ${(100 * quadruples / log.length).toFixed(1).padStart(9)}% ` +
    `${String(iso[Math.floor(iso.length / 2)]).padStart(8)}`,
  );
}

console.log(`${N} coups, meme graine de pioche pour tous.`);
console.log("Les parties divergent des le coup 2 : le top retenu differe selon le pave,");
console.log("donc le reliquat aussi. La comparaison est statistique, pas coup a coup.
");
console.log("pave             score  meilleur farfouil.  nonuples quadruples  isotops");
console.log("-".repeat(76));
for (const name of ["croixCourte", "croixEnrichie"] as LayoutName[]) { setLayout(name); run(name); }
tiles.forEach((t, i) => { setCustomLayout(t); run(`pavage ${i + 1}`); });
