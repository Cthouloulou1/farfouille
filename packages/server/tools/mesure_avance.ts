/**
 * Ce que l'avance fait gagner, en millisecondes. Voir SPEC.md §17.
 *
 *     node packages/server/tools/mesure_avance.ts 1500
 *
 * Joue une grille sans fin jusqu'au nombre de coups demande, en laissant entre
 * chaque coup une respiration -- de quoi laisser le calcul d'avance travailler,
 * comme le ferait une vraie table. On mesure ce que dure, vu du serveur, le
 * passage d'un coup au suivant : c'est exactement le temps pendant lequel les
 * joueurs regardent un chevalet vide.
 *
 * Puis on mesure le prix BRUT d'un top sur la grille ainsi construite : c'est
 * ce que l'attente aurait coute sans avance.
 */
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { configParDefaut, avec } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";
import { Board } from "../../engine/src/board.ts";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { generateMoves } from "../../engine/src/movegen.ts";
import { DAWG_PATH, GADDAG_PATH } from "../../engine/src/paths.ts";

const COUPS = Number(process.argv[2] ?? 800);
const RESPIRATION = Number(process.argv[3] ?? 3000);
const MESURES = Number(process.argv[4] ?? 12);
const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "mesure-avance";

function nettoyer(): void {
  for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${ID}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

const dors = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mediane = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;

nettoyer();
setLayout("pave1");
const cfg = avec(configParDefaut(), {
  bornes: null, pioche: "sac102boucle", chrono: null, mode: "topping",
});
const g = new Game(ID, "pave1", cfg);
await g.start();
g.presents.add("mesure");
await g.reveiller();
await g.demarrer();

// D'abord CONSTRUIRE la grille, aussi vite que la machine le permet. Cette
// phase-la ne mesure rien : a ce rythme le calcul d'avance ne peut pas prendre
// d'avance, il n'y a pas d'intervalle a remplir.
console.log(`\nOn construit une grille sans fin de ${COUPS} coups...`);
for (let i = 0; i < COUPS && !g.finie; i++) await g.reveal();
const pretsConstruction = g.coupsPrets;
console.log(`  ${g.moves.length} coups, dont ${pretsConstruction} sans attente ` +
  `(au galop, l'avance n'a pas le temps de se constituer)\n`);

// Puis JOUER A LA CADENCE D'UNE VRAIE TABLE. C'est le seul rythme qui
// ressemble a une partie : un coup dure des dizaines de secondes, largement de
// quoi preparer les cinq suivants.
console.log(`Puis on joue ${MESURES} coups a la cadence d'une table ` +
  `(${(RESPIRATION / 1000).toFixed(1)} s par coup)\n`);
const attentes: number[] = [];
const pretsAvant = g.coupsPrets;
for (let i = 0; i < MESURES && !g.finie; i++) {
  await dors(RESPIRATION);
  const t0 = performance.now();
  await g.reveal();
  attentes.push(performance.now() - t0);
}
const prets = g.coupsPrets - pretsAvant;
console.log(`  attente mediane entre deux coups   ${mediane(attentes).toFixed(1)} ms`);
console.log(`  pire attente                       ${Math.max(...attentes).toFixed(0)} ms`);
console.log(`  coups servis sans aucune attente   ${prets} sur ${attentes.length}`);

// Le prix brut d'un top sur cette grille : ce que l'attente aurait coute.
const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const plateau = new Board(dawg, cfg);
for (const m of g.moves) plateau.place(m.placements);
const brut: number[] = [];
for (const tirage of ["AEILNRT", "?ADEMOU", "BEIOPST", "CEHIRSU", "AEGLNOS"]) {
  const t0 = performance.now();
  generateMoves(plateau, gaddag, tirage, { tiers: 40, maxMoves: 120 });
  brut.push(performance.now() - t0);
}
console.log(`  un top sur cette grille de ${g.moves.length} coups coute ` +
  `${mediane(brut).toFixed(0)} ms -- c'est l'attente qui a disparu\n`);

await g.stop();
nettoyer();
