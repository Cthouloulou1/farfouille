/**
 * Calibre les poids d'une pioche ponderee pour un dictionnaire donne.
 *
 *     node packages/engine/tools/calibrer_poids.ts dictionnaire-eel22.txt
 *
 * LE POIDS N'EST PAS LA FREQUENCE VISEE. La compensation anti-secheresse
 * (bag.ts) reevalue une lettre tant qu'elle n'est pas sortie, ce qui gonfle les
 * lettres rares : une table de poids egale aux frequences du lexique sort trop
 * de K et pas assez de E. Le bon poids se TROUVE donc, en tirant beaucoup et en
 * corrigeant : `poids <- poids x cible / sortie`, jusqu'a ce que la sortie
 * mesuree colle a la frequence du lexique.
 *
 * C'est ainsi que la table francaise de bag.ts a ete obtenue, et c'est ce qu'il
 * faut refaire pour tout nouveau dictionnaire -- le NWL, le CSW, un lexique
 * d'une autre langue.
 *
 * DEUX CORRECTIONS SONT VOULUES et ne viennent pas de la mesure :
 *   - le S est ramene a 79 % de sa frequence. Il doit sa place au pluriel et a
 *     la conjugaison, pas aux mots eux-memes ; le servir a sa frequence brute
 *     rend les tirages trop faciles.
 *   - le joker vise 2 %, la proportion du jeu classique (2 sur 102), et non une
 *     frequence de lexique -- il n'y en a pas.
 */
import { readFileSync } from "node:fs";
import { Bag, type BagConfig } from "../src/bag.ts";
import { mulberry32 } from "../src/rng.ts";
import { BLANK, LETTERS } from "../src/alphabet.ts";

/** Le S doit sa frequence au pluriel : on le ramene sous sa mesure. */
const CORRECTION_S = 0.786;
/** Part visee du joker, celle du jeu classique. */
const CIBLE_JOKER = 2.0;
/** Longueurs qui comptent : les mots qu'on pose vraiment. */
const COURT = 2, LONG = 9;

function frequences(src: string): Record<string, number> {
  const compte: Record<string, number> = {};
  let total = 0;
  for (const ligne of readFileSync(src, "ascii").split("\n")) {
    const mot = ligne.trim();
    if (mot.length < COURT || mot.length > LONG) continue;
    for (const c of mot) { compte[c] = (compte[c] ?? 0) + 1; total++; }
  }
  const f: Record<string, number> = {};
  for (const L of LETTERS) f[L] = 100 * (compte[L] ?? 0) / total;
  return f;
}

/** Frequence de sortie effective de la pioche, joker compris. */
function sortie(poids: Record<string, number>, joker: number, tirages: number): Record<string, number> {
  const cfg: BagConfig = { weights: poids, blankWeight: joker, alpha: 0.08, cap: 4, maxBlanks: 2 };
  const bag = new Bag(cfg, mulberry32(20260904));
  const compte: Record<string, number> = {};
  let total = 0;
  for (let i = 0; i < tirages; i++) {
    for (const c of bag.draw([]).rack) { compte[c] = (compte[c] ?? 0) + 1; total++; }
  }
  const f: Record<string, number> = {};
  for (const L of [...LETTERS, BLANK]) f[L] = 100 * (compte[L] ?? 0) / total;
  return f;
}

const src = process.argv[2] ?? "dictionnaire.txt";
const cible = frequences(src);
cible["S"] = cible["S"]! * CORRECTION_S;

// On part des frequences elles-memes : c'est deja la bonne echelle.
const poids: Record<string, number> = { ...cible };
let joker = CIBLE_JOKER;

for (let passe = 1; passe <= 12; passe++) {
  // Peu de tirages au debut -- la correction est grossiere -- beaucoup a la
  // fin, ou le bruit d'echantillonnage deviendrait la seule erreur restante.
  const tirages = passe < 8 ? 60_000 : 400_000;
  const mesure = sortie(poids, joker, tirages);
  let pire = 0;
  for (const L of LETTERS) {
    const m = mesure[L]!;
    if (m > 0) poids[L] = poids[L]! * cible[L]! / m;
    pire = Math.max(pire, Math.abs(m - cible[L]!));
  }
  joker = joker * CIBLE_JOKER / mesure[BLANK]!;
  console.error(`passe ${passe} : ecart max ${pire.toFixed(3)} point`);
}

const finale = sortie(poids, joker, 400_000);
console.error(`\n${"L".padEnd(2)} ${"cible".padStart(7)} ${"sortie".padStart(7)} ${"poids".padStart(7)}`);
for (const L of [...LETTERS].sort((a, b) => cible[b]! - cible[a]!)) {
  console.error(`${L.padEnd(2)} ${cible[L]!.toFixed(3).padStart(7)} ` +
    `${finale[L]!.toFixed(3).padStart(7)} ${poids[L]!.toFixed(3).padStart(7)}`);
}
console.error(`joker ${CIBLE_JOKER.toFixed(3)} ${finale[BLANK]!.toFixed(3)} ${joker.toFixed(3)}`);

// Sur la sortie standard, la table prete a coller dans dictionnaires.ts.
const ordre = [...LETTERS].sort((a, b) => poids[b]! - poids[a]!);
const lignes: string[] = [];
for (let i = 0; i < ordre.length; i += 7) {
  lignes.push("  " + ordre.slice(i, i + 7)
    .map((L) => `${L}: ${poids[L]!.toFixed(3)}`).join(", ") + ",");
}
console.log(lignes.join("\n"));
console.log(`// joker : ${joker.toFixed(3)}`);
