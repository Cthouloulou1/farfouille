/** Exporte chaque motif de cases bonus, avec ses mesures, pour comparaison. */
import { writeFileSync } from "node:fs";
import { bonusChar, setLayout, LAYOUTS, type LayoutName } from "../src/bonus.ts";

const W = 61, H = 41, R = 40;

function measure() {
  const counts: Record<string, number> = {};
  const pos: Record<string, [number, number][]> = { T: [], D: [], t: [], d: [] };
  let total = 0;
  for (let x = -R; x <= R; x++) {
    for (let y = -R; y <= R; y++) {
      const c = bonusChar(x, y);
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
        let dd = -1;
        if (y1 === y2) dd = Math.abs(x2 - x1);
        else if (x1 === x2) dd = Math.abs(y2 - y1);
        if (dd > 0 && dd + 1 < best) best = dd + 1;
      }
    }
    junction[k] = best === Infinity ? null : best;
  }
  const pc = (k: string) => Number((100 * (counts[k] ?? 0) / total).toFixed(1));
  return { T: pc("T"), D: pc("D") + pc("*"), t: pc("t"), d: pc("d"), junction };
}

const out: Record<string, unknown> = {};
for (const name of Object.keys(LAYOUTS) as LayoutName[]) {
  setLayout(name);
  const rows: string[] = [];
  for (let y = -(H >> 1); y <= (H >> 1); y++) {
    let r = "";
    for (let x = -(W >> 1); x <= (W >> 1); x++) r += bonusChar(x, y);
    rows.push(r);
  }
  out[name] = { rows, stats: measure(), x0: -(W >> 1), y0: -(H >> 1) };
}
const dst = process.argv[2] ?? "layouts.json";
writeFileSync(dst, JSON.stringify(out), "utf8");
console.log(`${Object.keys(out).length} motifs -> ${dst}`);
