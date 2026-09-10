/**
 * Combien de fois la regle « a score egal, on garde le joker » mord vraiment.
 *
 *     node packages/server/test/mesure_joker.ts [parties]
 *
 * Ce n'est pas un test, c'est une mesure : elle joue des parties joker entieres
 * et compte, coup par coup, ce que le solveur AVEUGLE aurait choisi -- celui qui
 * ne voit pas le sac -- puis ce que lui aurait coute ce choix en jokers perdus.
 *
 * Elle rejoue la position de chaque coup avec le moteur seul, comme le juge de
 * paix de `check_avance.ts`, et compare les deux `pickTop` : avec le sac, et
 * sans. Le coup joue est celui du premier ; le second est ce qui se passait
 * avant.
 */
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { Board } from "../../engine/src/board.ts";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { generateMoves, pickTop } from "../../engine/src/movegen.ts";
import { dawgPath, gaddagPath } from "../../engine/src/paths.ts";
import { chacha20 } from "../src/rngSecurise.ts";
import { configParDefaut, avec, type ConfigPartie } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS } from "../../engine/src/bonus.ts";
import { BORNES_NORMALE } from "../../engine/src/categories.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const PARTIES = Math.max(1, Number(process.argv[2]) || 6);
const ID = "mesure-joker";

function nettoyer(id: string): void {
  for (const s of [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${id}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

function partieJoker(): ConfigPartie {
  return avec(configParDefaut(), {
    bornes: BORNES_NORMALE, pavage: LAYOUTS.classique15, pavageNom: "classique15",
    tirage: 7, jouables: 7, pioche: "sac102", sacs: 1, joker: true, jokersParCoup: 1,
    mode: "topping", chrono: null, coupsMax: null, dureeMax: null,
  });
}

/** Combien de jokers ce coup perdrait, vu ce sac. Le meme compte que le moteur. */
function perdus(
  placements: readonly { letter: string; blank: boolean }[],
  reliquat: Readonly<Record<string, number>> | null | undefined,
): number {
  if (reliquat === null || reliquat === undefined) return 0;
  const reste: Record<string, number> = { ...reliquat };
  let n = 0;
  for (const p of placements) {
    if (!p.blank) continue;
    const dispo = reste[p.letter] ?? 0;
    if (dispo > 0) reste[p.letter] = dispo - 1;
    else n++;
  }
  return n;
}

const dawg = loadDict(dawgPath("ods9"));
const gaddag = loadDict(gaddagPath("ods9"));

let coups = 0, avecJoker = 0, choixDifferent = 0, jokersSauves = 0;
const exemples: string[] = [];

for (let p = 0; p < PARTIES; p++) {
  nettoyer(ID);
  setLayout("classique15");
  const cfg = partieJoker();
  const g = new Game(ID, "classique15", cfg);
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  for (let i = 0; i < 400 && !g.finie; i++) {
    await g.reveal();
    await new Promise((r) => setTimeout(r, 12));
  }

  // On refait chaque position avec le moteur seul, et on compare les deux choix.
  const plateau = new Board(dawg, cfg);
  for (const m of g.moves) {
    coups++;
    const gen = generateMoves(plateau, gaddag, m.rack, { tiers: 40, maxMoves: 120 });
    const alea = () => chacha20(`${g.seed}:${m.n}`)();
    const voyant = pickTop(gen.moves, alea, true, m.reliquatDuSac);
    const aveugle = pickTop(gen.moves, alea, true);
    if (voyant !== null && voyant.top.placements.some((q) => q.blank)) avecJoker++;
    if (voyant !== null && aveugle !== null && voyant.top.word !== aveugle.top.word) {
      choixDifferent++;
      const a = perdus(aveugle.top.placements, m.reliquatDuSac);
      const b = perdus(voyant.top.placements, m.reliquatDuSac);
      if (a > b) {
        jokersSauves += a - b;
        if (exemples.length < 6) {
          exemples.push(`partie ${p + 1}, coup ${m.n} : ${voyant.top.word} `
            + `(${b} perdu) au lieu de ${aveugle.top.word} (${a} perdu)`);
        }
      }
    }
    plateau.place(m.placements);
  }
  const restes = g.moves.reduce((a, m) => a + (m.jokers?.restes ?? 0), 0);
  console.log(`  partie ${p + 1} : ${g.moves.length} coups, `
    + `${restes} joker(s) reste(s) sur la grille`);
  await g.stop();
  g.releaseLock();
}
nettoyer(ID);

console.log(`\n  ${coups} coups sur ${PARTIES} parties joker`);
console.log(`  ${avecJoker} coups dont le top emploie le joker`);
console.log(`  ${choixDifferent} coups ou le choix differe de celui du solveur aveugle`);
console.log(`  ${jokersSauves} joker(s) sauve(s) par la regle\n`);
for (const e of exemples) console.log(`    ${e}`);
console.log("");
