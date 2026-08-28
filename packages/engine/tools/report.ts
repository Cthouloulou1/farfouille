/**
 * Rapport de simulation en ligne de commande.
 *
 *     node tools/report.ts [coups] [graine]
 */
import { loadDict } from "../src/dictionary_node.ts";
import { simulate, type MoveRecord } from "../src/simulate.ts";
import { key, keyX, keyY, formatMove } from "../src/coords.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

function pct(v: number[], p: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? 0;
}

function mean(v: number[]): number {
  return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
}

function bucketTable(log: MoveRecord[], buckets: number): string {
  const size = Math.ceil(log.length / buckets);
  const rows: string[] = [];
  rows.push("  coups    tuiles  explores  coups produits  isotops med/max  calcul med/max");
  rows.push("  " + "-".repeat(74));
  for (let i = 0; i < log.length; i += size) {
    const b = log.slice(i, i + size);
    const iso = b.map((r) => r.isotops);
    const ms = b.map((r) => r.genMs);
    const last = b[b.length - 1]!;
    rows.push(
      `  ${String(b[0]!.n).padStart(3)}-${String(last.n).padEnd(4)} ` +
      `${String(last.tiles).padStart(7)} ` +
      `${String(Math.round(mean(b.map((r) => r.anchors)))).padStart(9)} ` +
      `${String(Math.round(mean(b.map((r) => r.candidates)))).padStart(15)} ` +
      `${String(pct(iso, 0.5)).padStart(9)}/${String(Math.max(...iso)).padEnd(6)} ` +
      `${pct(ms, 0.5).toFixed(0).padStart(8)} ms/${Math.max(...ms).toFixed(0)} ms`,
    );
  }
  return rows.join("\n");
}

/** Carte de densite : chaque caractere resume un bloc de `cell` cases. */
function densityMap(placed: Set<number>, cell: number, width: number): string {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const k of placed) {
    const x = keyX(k), y = keyY(k);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const counts = new Map<string, number>();
  for (const k of placed) {
    const bx = Math.floor((keyX(k) - minX) / cell);
    const by = Math.floor((keyY(k) - minY) / cell);
    const key = `${bx},${by}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cols = Math.min(width, Math.ceil((maxX - minX + 1) / cell));
  const rows = Math.ceil((maxY - minY + 1) / cell);
  const ramp = " .:-=+*#%@";
  const out: string[] = [];
  for (let by = 0; by < rows; by++) {
    let line = "  ";
    for (let bx = 0; bx < cols; bx++) {
      const c = counts.get(`${bx},${by}`) ?? 0;
      const frac = c / (cell * cell);
      line += c === 0 ? " " : ramp[Math.min(ramp.length - 1, 1 + Math.floor(frac * (ramp.length - 1)))]!;
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

const MOVES = Number(process.argv[2] ?? 500);
const SEED = process.argv[3] ?? "demo";

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

console.log(`Simulation : ${MOVES} coups, graine "${SEED}"\n`);
const t0 = performance.now();
const log = simulate(MOVES, SEED, dawg, gaddag);
const wall = (performance.now() - t0) / 1000;

const placed = new Set<number>();
let totalScore = 0;
let bingos = 0;
for (const r of log) {
  for (const p of r.move.placements) placed.add(key(p.x, p.y));
  totalScore += r.move.score;
  if (r.move.placements.length === 7) bingos++;
}

const iso = log.map((r) => r.isotops);
const ms = log.map((r) => r.genMs);
const scores = log.map((r) => r.move.score);
const rejections = log.reduce((a, r) => a + r.rejections, 0);

console.log(`${log.length} coups joues en ${wall.toFixed(1)} s de calcul total`);
console.log(`score cumule de la grille : ${totalScore.toLocaleString("fr")}   (moyenne ${mean(scores).toFixed(1)} par coup)`);
console.log(`scrabbles (7 caramels)    : ${bingos} (${(100 * bingos / log.length).toFixed(1)} %)`);
console.log(`tirages rejetes           : ${rejections} pour ${log.length} coups (${(100 * rejections / (rejections + log.length)).toFixed(1)} %)`);
console.log();

console.log("EVOLUTION AVEC LA TAILLE DE LA GRILLE");
console.log(bucketTable(log, 10));
console.log();

console.log("ISOTOPS");
console.log(`  mediane ${pct(iso, 0.5)}   moyenne ${mean(iso).toFixed(1)}   90e centile ${pct(iso, 0.9)}   maximum ${Math.max(...iso)}`);
const solo = iso.filter((v) => v === 1).length;
console.log(`  coups a top unique : ${solo} / ${log.length} (${(100 * solo / log.length).toFixed(0)} %)`);
console.log();

console.log("TEMPS DE CALCUL PAR COUP");
console.log(`  mediane ${pct(ms, 0.5).toFixed(0)} ms   90e centile ${pct(ms, 0.9).toFixed(0)} ms   maximum ${Math.max(...ms).toFixed(0)} ms`);
console.log();

const seams = log.filter((r) => r.wordMult >= 9);
console.log("MULTIPLICATEURS CUMULES (pavage periode 14)");
console.log(`  coups a multiplicateur de mot >= x9 : ${seams.length}`);
for (const r of seams.slice(0, 5)) {
  console.log(`    coup ${r.n} : ${r.move.word} ${formatMove(r.move.dir, r.move.x, r.move.y)} = ${r.move.score} pts (x${r.wordMult})`);
}
console.log();

const top10 = [...log].sort((a, b) => b.move.score - a.move.score).slice(0, 8);
console.log("MEILLEURS COUPS");
for (const r of top10) {
  console.log(`  coup ${String(r.n).padStart(3)} : ${r.move.word.padEnd(16)} ${formatMove(r.move.dir, r.move.x, r.move.y).padEnd(14)} ${String(r.move.score).padStart(4)} pts   tirage ${r.notation}   ${r.isotops} isotop(s)`);
}
console.log();

const bxs = [...placed].map(keyX), bys = [...placed].map(keyY);
const w = Math.max(...bxs) - Math.min(...bxs) + 1;
const h = Math.max(...bys) - Math.min(...bys) + 1;
console.log("FORME DE LA GRILLE");
console.log(`  emprise ${w} x ${h} cases, ${placed.size} caramels poses, densite ${(100 * placed.size / (w * h)).toFixed(1)} %`);
console.log();
console.log(densityMap(placed, Math.max(1, Math.ceil(w / 100)), 100));
