/**
 * Longueur minimale d'un mot capable de couvrir deux cases de meme type.
 *
 * Sur le plateau officiel, relier deux MCD demande 7 cases et deux MCT en
 * demandent 8. Un pavage mal raccorde peut raccourcir ces jonctions et rendre
 * les x4 et x9 bien trop faciles.
 */
import { bonusAt, setLayout, type LayoutName } from "../src/bonus.ts";

function scan(kind: "word3" | "word2") {
  const want = kind === "word3" ? 3 : 2;
  const hits: [number, number][] = [];
  for (let x = -30; x <= 30; x++) {
    for (let y = -30; y <= 30; y++) {
      const b = bonusAt(x, y);
      if (b.word === want) hits.push([x, y]);
    }
  }
  // paires alignees : un mot ne se lit qu'en ligne ou en colonne
  let best = Infinity;
  let where: string = "";
  for (const [x1, y1] of hits) {
    for (const [x2, y2] of hits) {
      if (x1 === x2 && y1 === y2) continue;
      let d = -1;
      if (y1 === y2) d = Math.abs(x2 - x1);
      else if (x1 === x2) d = Math.abs(y2 - y1);
      if (d > 0 && d + 1 < best) { best = d + 1; where = `(${x1},${y1}) et (${x2},${y2})`; }
    }
  }
  return { count: hits.length, minCells: best, where };
}

console.log("motif          MCT nb  jonction   MCD nb  jonction");
console.log("-".repeat(52));
for (const name of ["classique", "croixCourte"] as LayoutName[]) {
  setLayout(name);
  const t = scan("word3");
  const d = scan("word2");
  const flag = (v: number, ref: number) => (v >= ref ? "ok " : "!! ");
  console.log(
    `${name.padEnd(14)} ${String(t.count).padStart(5)}  ${flag(t.minCells, 8)}${t.minCells} cases` +
    `  ${String(d.count).padStart(6)}  ${flag(d.minCells, 7)}${d.minCells} cases`,
  );
}
console.log("");
console.log("reference plateau officiel : MCT 8 cases, MCD 7 cases");
