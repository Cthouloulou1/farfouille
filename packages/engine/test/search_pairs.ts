/**
 * Recherche d'un reseau oblique APPARIE qui redonne le nonuple.
 *
 * Un reseau uniforme n'a jamais deux MCT a portee d'un mot : il faut les
 * apparier. Mais l'appariement peut recreer des paires trop proches ailleurs.
 * On balaie les parametres et on mesure, plutot que de deduire.
 */
const R = 60;
const mod = (n: number, m: number) => ((n % m) + m) % m;

type Rule = "h" | "v" | "alt-s" | "alt-t";

function build(a: number, b: number, gap: number, rule: Rule) {
  const n = a * a + b * b;
  const on = (u: number, v: number) => mod(a * u + b * v, n) === 0 && mod(a * v - b * u, n) === 0;
  const sOf = (u: number, v: number) => (a * u + b * v) / n;
  const tOf = (u: number, v: number) => (a * v - b * u) / n;
  const wantH = (u: number, v: number) =>
    rule === "h" ? true : rule === "v" ? false
    : rule === "alt-s" ? mod(sOf(u, v), 2) === 0 : mod(tOf(u, v), 2) === 0;
  return (x: number, y: number) => {
    if (on(x, y)) return true;
    if (on(x - gap, y) && wantH(x - gap, y)) return true;
    if (on(x, y - gap) && !wantH(x, y - gap)) return true;
    return false;
  };
}

function measure(f: (x: number, y: number) => boolean) {
  const pts: [number, number][] = [];
  let count = 0, total = 0;
  for (let x = -R; x <= R; x++) {
    for (let y = -R; y <= R; y++) {
      total++;
      if (f(x, y)) { count++; pts.push([x, y]); }
    }
  }
  let min = Infinity;
  for (const [x1, y1] of pts) {
    for (const [x2, y2] of pts) {
      if (x1 === x2 && y1 === y2) continue;
      let d = -1;
      if (y1 === y2) d = Math.abs(x2 - x1);
      else if (x1 === x2) d = Math.abs(y2 - y1);
      if (d > 0 && d + 1 < min) min = d + 1;
    }
  }
  return { density: 100 * count / total, min };
}

console.log("cible : densite proche de 3,6 %, jonction minimale de 8 cases (nonuple en 8 lettres)\n");
console.log("  a  b  gap  regle     densite   jonction");
console.log("  " + "-".repeat(44));
const rows: { k: string; d: number; j: number }[] = [];
for (const [a, b] of [[7, 2], [7, 3], [8, 1], [6, 5], [7, 4], [8, 3], [9, 2]] as [number, number][]) {
  for (const gap of [7]) {
    for (const rule of ["h", "alt-s", "alt-t"] as Rule[]) {
      const m = measure(build(a, b, gap, rule));
      rows.push({ k: `  ${a}  ${b}   ${gap}  ${rule.padEnd(8)}  ${m.density.toFixed(1)}%`, d: m.density, j: m.min });
    }
  }
}
for (const r of rows) {
  const ok = r.j === 8 && r.d > 2.8 && r.d < 4.6;
  console.log(`${r.k.padEnd(34)}  ${String(r.j).padStart(4)}   ${ok ? "<-- convient" : ""}`);
}
