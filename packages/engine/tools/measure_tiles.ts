/**
 * Mesure d'un pave de cases bonus fourni en texte.
 *
 * Trois criteres decident si un pave "fonctionne" :
 *   - la COUTURE : bords haut/bas et gauche/droite identiques, sinon les bonus
 *     des deux bords se collent quand le pave se repete ;
 *   - la JONCTION : plus court mot reliant deux bonus de meme type, qui decide
 *     seule si le nonuple et le quadruple sont atteignables ;
 *   - la DENSITE, qui decide du niveau general des scores.
 */
import { readFileSync } from "node:fs";

const R = 60;
const mod = (n: number, m: number) => ((n % m) + m) % m;

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

function measure(tile: readonly string[], label: string) {
  const n = tile.length;
  const period = n - 1;
  const center = period / 2;
  const at = (x: number, y: number) => tile[mod(y + center, period)]![mod(x + center, period)]!;

  const counts: Record<string, number> = {};
  const pos: Record<string, [number, number][]> = { T: [], D: [], t: [], d: [] };
  let total = 0;
  for (let x = -R; x <= R; x++) {
    for (let y = -R; y <= R; y++) {
      const c = at(x, y);
      counts[c] = (counts[c] ?? 0) + 1;
      total++;
      if (c in pos) pos[c]!.push([x, y]);
    }
  }

  const junction: Record<string, number | null> = {};
  for (const k of ["T", "D", "t", "d"]) {
    let best = Infinity;
    for (const [x1, y1] of pos[k]!) {
      for (const [x2, y2] of pos[k]!) {
        if (x1 === x2 && y1 === y2) continue;
        let d = -1;
        if (y1 === y2) d = Math.abs(x2 - x1);
        else if (x1 === x2) d = Math.abs(y2 - y1);
        if (d > 0 && d + 1 < best) best = d + 1;
      }
    }
    junction[k] = best === Infinity ? null : best;
  }

  const pc = (k: string) => (100 * (counts[k] ?? 0) / total);
  const bonusPc = 100 - pc(".");
  const j = (k: string) => (junction[k] === null ? " —" : String(junction[k]));
  console.log(
    `${label.padEnd(16)} ${period.toString().padStart(2)}  ` +
    `${pc("T").toFixed(1).padStart(5)}% ${pc("D").toFixed(1).padStart(6)}% ` +
    `${pc("t").toFixed(1).padStart(6)}% ${pc("d").toFixed(1).padStart(6)}%  ` +
    `${bonusPc.toFixed(0).padStart(4)}%  │ ` +
    `${j("T").padStart(3)} ${j("D").padStart(4)} ${j("t").padStart(4)} ${j("d").padStart(4)}  │ ` +
    `${at(0, 0) === "." ? "nue" : at(0, 0)}`,
  );
  return { junction, T: pc("T"), D: pc("D"), t: pc("t"), d: pc("d"), bonusPc };
}

const text = readFileSync(process.argv[2]!, "utf8");
const tiles = parseTiles(text);

// Corrections de transcription, etablies par les symetries du motif lui-meme.
if (tiles[0] && tiles[0].length === 29) {
  for (const y of [5, 23]) {
    const r = tiles[0][y]!;
    if (r[26] === "t") tiles[0][y] = r.slice(0, 26) + "d" + r.slice(27);
  }
}
if (tiles[2] && tiles[2][13]?.length === 14) tiles[2][13] += ".";

console.log("                per   MCT    MCD     LCT     LCD   bonus  │ jonctions T D t d │ origine");
console.log("-".repeat(96));
const OFF = ["officiel  15x15", "  3.6", "  7.6", "  5.3", " 10.7"];
console.log(`${OFF[0]!.padEnd(16)} --   ${OFF[1]}%  ${OFF[2]}%   ${OFF[3]}%   ${OFF[4]}%    26%  │   8    7    3    3  │ D`);
console.log("-".repeat(96));
tiles.forEach((t, i) => measure(t, `pavage ${i + 1}`));
