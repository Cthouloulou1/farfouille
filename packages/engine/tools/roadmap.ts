/**
 * Feuille de route d'une partie simulee. Voir SPEC.md §10.
 *
 *     node tools/roadmap.ts [coups] [graine] [fichier]
 *
 * Trois colonnes de la feuille de route definitive manquent forcement ici --
 * "temps mis", "joueur" et "mot tape" n'existent que s'il y a de vrais joueurs.
 * Le moteur joue son propre top a chaque coup, il n'y a personne a chronometrer.
 * Elles apparaitront en phase 2.
 */
import { writeFileSync } from "node:fs";
import { loadDict } from "../src/dictionary_node.ts";
import { simulate } from "../src/simulate.ts";
import { formatMove } from "../src/coords.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const MOVES = Number(process.argv[2] ?? 500);
const SEED = process.argv[3] ?? "mondiale";
const OUT = process.argv[4] ?? "feuille-de-route.txt";

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const log = simulate(MOVES, SEED, dawg, gaddag);

const lines: string[] = [];
lines.push(`FEUILLE DE ROUTE — partie "${SEED}", ${log.length} coups`);
lines.push("");
lines.push("Les colonnes « temps mis », « joueur » et « mot tapé » sont absentes :");
lines.push("le moteur joue son propre top, il n'y a aucun joueur à chronométrer.");
lines.push("");
lines.push(" coup │ tirage    │ mot retenu       │ position    │  pts │  cumul │ iso");
lines.push("──────┼───────────┼──────────────────┼─────────────┼──────┼────────┼─────");

let cumul = 0;
for (const r of log) {
  cumul += r.move.score;
  const iso = r.isotops > 1 ? String(r.isotops) : "";
  lines.push(
    ` ${String(r.n).padStart(4)} │ ` +
    `${r.notation.padEnd(9)} │ ` +
    `${r.move.word.padEnd(16)} │ ` +
    `${formatMove(r.move.dir, r.move.x, r.move.y).padEnd(11)} │ ` +
    `${String(r.move.score).padStart(4)} │ ` +
    `${String(cumul).padStart(6)} │ ` +
    `${iso.padStart(3)}`,
  );
}

lines.push("");
lines.push(`Total : ${cumul} points en ${log.length} coups (moyenne ${(cumul / log.length).toFixed(1)}).`);
lines.push(`Les coups marqués dans la colonne « iso » avaient plusieurs tops à égalité ;`);
lines.push(`le logiciel en a retenu un par tirage au sort déterministe.`);

writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log(`${log.length} coups écrits dans ${OUT}`);
console.log(lines.slice(5, 26).join("\n"));
