/**
 * Une partie archivee se relit sans salon, sans sac et sans solveur. SPEC.md §23.
 *
 *     node packages/server/test/check_lecteur.ts
 *
 * Le rejeu ne fonctionnait que dans un salon ouvert : il lui fallait un `Game`,
 * un fil de calcul et un verrou. Or une partie citee par un record est un
 * fichier inerte, que plus aucun salon ne tient -- les boutons « FdR » et
 * « Revoir » n'avaient rien a ouvrir.
 *
 * Ce test joue une vraie partie jusqu'au bout, la referme, puis la relit par le
 * seul journal et compare CARAMEL PAR CARAMEL avec ce que la partie avait sur
 * la grille. Puis il l'archive sous un nom horodate, comme une relance le fait,
 * et verifie qu'on la retrouve par sa graine.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { journalDeLaPartie, relire } from "../src/lecteur.ts";
import { avec, configParDefaut, type ConfigPartie } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS } from "../../engine/src/bonus.ts";
import { BORNES_NORMALE } from "../../engine/src/categories.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "lecteur-essai";
const SUFFIXES = [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"];

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(54)} ${detail}`);
  if (!ok) echecs++;
}

function nettoyer(): void {
  for (const s of SUFFIXES) {
    const f = join(D, `${ID}${s}`);
    if (existsSync(f)) rmSync(f);
  }
  // Les archives horodatees de ce test.
  for (const s of SUFFIXES) {
    for (const n of [1, 2]) {
      const f = join(D, `${ID}.${n}${s}`);
      if (existsSync(f)) rmSync(f);
    }
  }
}

function partieNormale(): ConfigPartie {
  return avec(configParDefaut(), {
    bornes: BORNES_NORMALE, pavage: LAYOUTS.classique15, pavageNom: "classique15",
    tirage: 7, jouables: 7, pioche: "sac102", sacs: 1,
    mode: "topping", chrono: null, coupsMax: null, dureeMax: null,
  });
}

console.log("\nUne partie archivee se relit sans salon\n");
nettoyer();
setLayout("classique15");

// --------------------------------------------------------- on joue, on ferme
const g = new Game(ID, "classique15", partieNormale());
await g.start();
g.presents.add("alice");
await g.reveiller();
await g.demarrer();
for (let i = 0; i < 200 && !g.finie; i++) {
  await g.reveal();
  await new Promise((r) => setTimeout(r, 12));
}
verifie("la partie est allee au bout", g.finie, `${g.moves.length} coups`);
/** Tout ce qui est sur la grille, case par case, lettre par lettre. */
const empreinte = (t: { x: number; y: number; l: string; b: 0 | 1 }[]): string =>
  t.map((c) => `${c.x},${c.y}${c.l}${c.b}`).sort().join(" ");
const attendu = empreinte(g.tiles());
const graine = g.seed;
const coupsJoues = g.moves.length;
await g.stop();

// ----------------------------------------------- la relecture par le journal
console.log("\n  --- relue par le seul journal ---\n");
{
  const f = join(D, `${ID}.journal.jsonl`);
  const p = relire(f);
  verifie("le journal se relit", p !== null);
  verifie("tous les coups sont la", p?.coups.length === coupsJoues,
    `${p?.coups.length} contre ${coupsJoues}`);
  verifie("la configuration revient", p?.config.tirage === 7 && p?.config.bornes === 7);
  verifie("la fin est dite", p?.fin === "sac", p?.fin ?? "aucune");

  // LA GRILLE REFAITE DOIT ETRE LA MEME, CARAMEL PAR CARAMEL. C'est tout
  // l'enjeu : les placements ne sont plus au journal, ils se recalculent a
  // partir du mot et de la grille telle qu'elle etait avant le coup.
  const refaits = (p?.coups ?? []).flatMap((c) =>
    c.placements.map((pl) => ({ x: pl.x, y: pl.y, l: pl.letter, b: (pl.blank ? 1 : 0) as 0 | 1 })));
  verifie("la grille refaite est identique", empreinte(refaits) === attendu,
    `${refaits.length} caramels contre ${g.tiles().length}`);

  const premier = p?.coups[0];
  verifie("le premier coup porte son tirage",
    (premier?.rack ?? "").length > 0, premier?.rack ?? "aucun");
  verifie("et son mot", (premier?.word ?? "").length > 0, premier?.word ?? "aucun");
  verifie("les coups reveles n'ont pas de trouveur",
    p?.coups.every((c) => c.player === null) === true);
}

// ------------------------------------------- retrouvee apres un archivage
console.log("\n  --- archivee sous un nom horodate ---\n");
{
  verifie("on la trouve sous son nom",
    journalDeLaPartie(ID, graine) === join(D, `${ID}.journal.jsonl`));
  verifie("mais pas avec une autre graine",
    journalDeLaPartie(ID, "une-graine-qui-n-est-pas-la-sienne") === null);

  // Une relance archive les fichiers sous `<nom>.<horodatage>`. On simule.
  for (const s of SUFFIXES) {
    const de = join(D, `${ID}${s}`);
    if (existsSync(de)) renameSync(de, join(D, `${ID}.1${s}`));
  }
  verifie("son nom direct ne repond plus",
    !existsSync(join(D, `${ID}.journal.jsonl`)));
  const trouve = journalDeLaPartie(ID, graine);
  verifie("mais la graine la retrouve dans les archives",
    trouve === join(D, `${ID}.1.journal.jsonl`), trouve ?? "introuvable");
  const p = relire(trouve ?? "");
  verifie("et elle se relit entiere", p?.coups.length === coupsJoues,
    `${p?.coups.length} coups`);
}

nettoyer();
console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
