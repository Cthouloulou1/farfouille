/**
 * Comparaison des motifs de cases bonus.
 *
 * Trois choses comptent : la DENSITE de chaque type (un plateau trop genereux
 * fait exploser les scores), la JONCTION MINIMALE entre deux bonus de meme type
 * (c'est elle qui decide si un nonuple est atteignable, et en combien de
 * lettres), et l'ORIGINE, qui doit rester une case neutre.
 */
import { bonusAt, bonusChar, setLayout, LAYOUTS, type LayoutName } from "../src/bonus.ts";

const R = 40;   // demi-fenetre d'echantillonnage

function stats() {
  const counts: Record<string, number> = { T: 0, D: 0, t: 0, d: 0, ".": 0, "*": 0 };
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
  // jonction minimale : plus court mot couvrant deux bonus du meme type
  const junction: Record<string, number> = {};
  for (const k of ["T", "D", "t", "d"]) {
    let best = Infinity;
    const p = pos[k]!;
    for (const [x1, y1] of p) {
      for (const [x2, y2] of p) {
        if (x1 === x2 && y1 === y2) continue;
        let d = -1;
        if (y1 === y2) d = Math.abs(x2 - x1);
        else if (x1 === x2) d = Math.abs(y2 - y1);
        if (d > 0 && d + 1 < best) best = d + 1;
      }
    }
    junction[k] = best;
  }
  return { counts, total, junction };
}

const NAMES: LayoutName[] = Object.keys(LAYOUTS) as LayoutName[];
console.log("Reference plateau officiel : MCT 3,6 %  MCD 7,6 %  LCT 5,3 %  LCD 10,7 %");
console.log("Jonctions officielles      : MCT 8 cases (nonuple en 8 lettres), MCD 7 cases\n");
console.log("motif          MCT    MCD    LCT    LCD   nues  │ jonction MCT / MCD  │ origine");
console.log("-".repeat(84));
for (const name of NAMES) {
  setLayout(name);
  const s = stats();
  const p = (k: string) => `${(100 * (s.counts[k] ?? 0) / s.total).toFixed(1)}%`;
  const j = (k: string) => (s.junction[k] === Infinity ? "aucune" : `${s.junction[k]}`);
  console.log(
    `${name.padEnd(13)} ${p("T").padStart(5)} ${p("D").padStart(6)} ${p("t").padStart(6)} ` +
    `${p("d").padStart(6)} ${p(".").padStart(6)}  │ ${j("T").padStart(6)} / ${j("D").padEnd(8)}   │ ` +
    `${bonusChar(0, 0) === "." || bonusChar(0, 0) === "*" ? "neutre" : "BONUS " + bonusChar(0, 0)}`,
  );
}
