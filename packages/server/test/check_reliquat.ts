/**
 * Le reliquat d'une partie close compte TOUT ce qui n'a jamais ete joue.
 *
 *     node packages/server/test/check_reliquat.ts
 *
 * Une partie s'arrete (nombre de coups atteint, duree ecoulee, ou plus rien de
 * jouable a tirer) alors qu'il reste des lettres EN MAIN. Ces lettres-la ne
 * sont ni sur la grille ni dans le sac : sans rien faire, elles disparaissent
 * du compte, et le reliquat affiche ment d'autant.
 *
 * L'invariant tenu ici : sur une partie close, les caramels poses sur la grille
 * plus le reliquat rendent EXACTEMENT le sac de depart. Le tirage, lui, est
 * vide -- une partie finie ne se joue plus.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { avec, configParDefaut } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "essai-reliquat";
/** Le sac du commerce : c'est celui que `pioche: "sac102"` distribue. */
const SAC = 102;

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(56)} ${detail}`);
  if (!ok) echecs++;
}

function nettoyer(): void {
  for (const s of [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${ID}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

console.log("\nLe reliquat d'une partie close\n");

nettoyer();
setLayout("classique");
// Trois coups et la partie s'arrete : le tirage du troisieme coup n'est pas
// joue en entier, et c'est precisement le cas qu'on veut voir compte.
const cfg = avec(configParDefaut(), { bornes: 7, pioche: "sac102", chrono: null, coupsMax: 3 });
const jeu = new Game(ID, "classique", cfg);
await jeu.start();
jeu.presents.add("essai");
await jeu.reveiller();
await jeu.demarrer();
for (let i = 0; i < 12 && !jeu.finie; i++) {
  await jeu.reveal();
  await new Promise((r) => setTimeout(r, 20));
}

verifie("la partie est close", jeu.finie, `${jeu.moves.length} coups`);
verifie("le tirage est vide", jeu.rack === "", `"${jeu.rack}"`);

const poses = jeu.tiles().length;
const sacFinal = jeu.restantDuSac();
verifie("grille + reliquat = le sac entier", poses + sacFinal.length === SAC,
  `${poses} poses + ${sacFinal.length} au reliquat = ${poses + sacFinal.length}, attendu ${SAC}`);

await jeu.stop();

// UNE PARTIE CLOSE SE RELIT PAREIL. Le reliquat est reconstruit depuis le
// journal a chaque ouverture : s'il ne se retrouvait qu'en direct, un simple
// redemarrage du serveur reprendrait des lettres a la vue de tous.
const relu = new Game(ID, "classique", cfg);
await relu.start();
await relu.reveiller();
verifie("la partie relue est close", relu.finie);
verifie("le reliquat relu est le meme, caramel par caramel",
  relu.restantDuSac() === sacFinal, `${relu.restantDuSac()} contre ${sacFinal}`);
await relu.stop();
nettoyer();

console.log(echecs === 0
  ? "\nOK : rien ne se perd entre la main, la grille et le reliquat\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
