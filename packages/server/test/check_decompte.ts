/**
 * Le decompte d'avant-partie. Voir SPEC.md §2.
 *
 *     node packages/server/test/check_decompte.ts
 *
 * « 3, 2, 1, partez » lance la PARTIE, une fois. Ce n'est pas une pause avant
 * chaque coup : au deuxieme coup et aux suivants, le tirage tombe et le chrono
 * part dans la meme seconde.
 *
 * Tant que le decompte court, le tirage est affiche mais le chrono n'a pas
 * demarre -- ces secondes ne sont prises sur le temps de personne.
 */
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { configParDefaut, avec } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "decompte-test";

function nettoyer(): void {
  for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${ID}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(56)} ${detail}`);
  if (!ok) echecs++;
}

const dors = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\nDecompte d'avant-partie\n");
nettoyer();

// Plateau borne : le solveur y repond en quelques millisecondes, si bien que
// le temps mesure ici est bien celui du decompte et non celui du calcul.
setLayout("classique");
const cfg = avec(configParDefaut(), {
  bornes: 7, pioche: "sac102", chrono: 30, decompte: true, mode: "topping",
});
const g = new Game(ID, "classique", cfg);
await g.start();
g.presents.add("essai");
await g.reveiller();
await g.demarrer();

// Le premier tirage vient d'etre servi.
const reste = g.decompteJusqua - Date.now();
verifie("le premier coup ouvre sur un decompte", g.decompteJusqua > 0,
  `${(reste / 1000).toFixed(1)} s`);
verifie("il dure autour de trois secondes", reste > 2000 && reste <= 3000);

const servedAvant = g.servedAt;
await dors(1000);
verifie("le chrono ne court pas pendant le decompte",
  g.servedAt === servedAvant,
  "personne ne perd ces secondes-la");

await dors(2600);
verifie("le decompte fini, le chrono part", g.decompteJusqua === 0
  && g.servedAt > servedAvant);

// Deuxieme coup : le tirage tombe, et rien ne doit s'interposer.
await g.reveal();
await dors(150);
verifie("le deuxieme coup n'en refait pas", g.decompteJusqua === 0);
await g.reveal();
await dors(150);
verifie("le troisieme non plus", g.decompteJusqua === 0);

await g.stop();

// Sans le reglage, aucun decompte, pas meme au premier coup.
nettoyer();
const g2 = new Game(ID, "classique", avec(cfg, { decompte: false }));
await g2.start();
g2.presents.add("essai");
await g2.reveiller();
await g2.demarrer();
verifie("decompte decoche : la partie part sans attendre", g2.decompteJusqua === 0);
await g2.stop();

nettoyer();
console.log(echecs === 0
  ? "\nOK : le decompte lance la partie, une fois, et rien apres\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
