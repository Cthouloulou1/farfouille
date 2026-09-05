/**
 * Le double sac et le double joker. Voir SPEC.md §16.
 *
 *     node packages/server/test/check_double.ts
 *
 * Deux reglages qui doublent quelque chose, et qui ne se ressemblent pas :
 *
 *   double sac      la super grille verse DEUX jeux dans le meme sac -- 204
 *                   caramels en francais, 200 en anglais. Il decoule de la
 *                   grille, personne ne le choisit. 441 cases ne se remplissent
 *                   pas avec 102 caramels.
 *   double joker    le tirage porte DEUX jokers a chaque coup au lieu d'un. Le
 *                   sac ne distribue alors que `tirage - 2` lettres, et les
 *                   jokers reviennent au tirage suivant des qu'ils ont joue une
 *                   vraie lettre.
 *
 * Ce que ce test verifie : le compte du sac tombe juste a chaque instant, le
 * tirage porte exactement le nombre de jokers demande, et une partie relue
 * depuis son journal retrouve le meme sac et le meme tirage -- sans quoi les
 * deux divergeraient au coup suivant.
 */
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { configParDefaut, avec, avecDictionnaire } from "../../engine/src/config.ts";
import { LAYOUTS, setLayout } from "../../engine/src/bonus.ts";
import { dictionnaire, tailleDuSac } from "../../engine/src/dictionnaires.ts";
import { BLANK } from "../../engine/src/alphabet.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(52)} ${detail}`);
  if (!ok) echecs++;
}

function nettoyer(id: string): void {
  for (const s of [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${id}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

/** La configuration d'un salon sur la super grille : bornes 10, double sac. */
function cfgSuper(extra: Record<string, unknown> = {}) {
  return avec(configParDefaut(), {
    bornes: 10, pavage: LAYOUTS.super21, pavageNom: "super21",
    pioche: "sac102", sacs: 2, chrono: null, ...extra,
  });
}

const compte = (s: string, ch: string): number => [...s].filter((c) => c === ch).length;

/** Joue `coups` coups et rend la partie, encore ouverte. */
async function jouer(g: Game, coups: number): Promise<void> {
  for (let i = 0; i < coups && !g.finie; i++) {
    await g.reveal();
    await new Promise((r) => setTimeout(r, 20));
  }
}

console.log("\nLe double sac de la super grille\n");
{
  const ID = "double-sac-test";
  nettoyer(ID);
  setLayout("classique");
  const g = new Game(ID, "classique", cfgSuper());
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();

  const attendu = tailleDuSac(dictionnaire("ods9"), 2);
  verifie("le lexique annonce 204 caramels", attendu === 204, `${attendu}`);
  // A tout instant : ce qui reste dans le sac plus ce qui est au chevalet fait
  // le sac entier. C'est l'invariant qui tient tout le reste.
  verifie("sac + chevalet = 204 au premier tirage",
    g.restantDuSac().length + g.rack.length === attendu,
    `${g.restantDuSac().length} + ${g.rack.length}`);

  await jouer(g, 12);
  verifie("la partie avance", g.moves.length >= 10, `${g.moves.length} coups`);
  // Les caramels poses ont quitte le sac ET le chevalet : ils sont sur la
  // grille. Le compte doit toujours tomber sur 204.
  const poses = g.moves.reduce((a, m) => a + m.placements.length, 0);
  verifie("sac + chevalet + grille = 204 douze coups plus tard",
    g.restantDuSac().length + g.rack.length + poses === attendu,
    `${g.restantDuSac().length} + ${g.rack.length} + ${poses}`);
  // Deux exemplaires de chaque lettre : le jeu francais n'a qu'un Q, le double
  // sac en a deux. On le verifie sur la lettre la plus rare.
  const tousLesQ = compte(g.restantDuSac(), "Q") + compte(g.rack, "Q")
    + g.moves.reduce((a, m) => a + m.placements.filter((p) => p.letter === "Q" && !p.blank).length, 0);
  verifie("le sac contient bien deux Q", tousLesQ === 2, `${tousLesQ} exemplaire(s)`);
  await g.stop();
  nettoyer(ID);
}

console.log("\nLe double sac anglais : deux jeux, donc 200\n");
{
  const ID = "double-sac-en-test";
  nettoyer(ID);
  setLayout("classique");
  const base = avecDictionnaire(cfgSuper(), "csw24");
  const g = new Game(ID, "classique", base);
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  const attendu = tailleDuSac(dictionnaire("csw24"), 2);
  verifie("le lexique anglais annonce 200 caramels", attendu === 200, `${attendu}`);
  verifie("sac + chevalet = 200 au premier tirage",
    g.restantDuSac().length + g.rack.length === attendu,
    `${g.restantDuSac().length} + ${g.rack.length}`);
  await g.stop();
  nettoyer(ID);
}

console.log("\nLe double joker : deux jokers a chaque tirage\n");
{
  const ID = "double-joker-test";
  nettoyer(ID);
  setLayout("classique");
  const g = new Game(ID, "classique", cfgSuper({ joker: true, jokersParCoup: 2 }));
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();

  // Quatre jokers en reserve : deux par sac, et il y a deux sacs.
  verifie("quatre jokers en reserve", g.jokersEnReserve === 4, `${g.jokersEnReserve}`);
  verifie("le premier tirage porte deux jokers", compte(g.rack, BLANK) === 2, g.rack);
  verifie("et cinq vraies lettres", g.rack.length === 7, `${g.rack.length} caramels`);

  const tirages: string[] = [g.rack];
  const debut = Date.now();
  await jouer(g, 12);
  const parCoup = Math.round((Date.now() - debut) / Math.max(1, g.moves.length));
  for (const m of g.moves) tirages.push(m.rack);

  verifie("la partie avance", g.moves.length >= 10, `${g.moves.length} coups`);
  // LE POINT DU TEST. Chaque tirage porte ses deux jokers, du premier au
  // dernier -- tant que la reserve n'est pas epuisee.
  const sansDeux = tirages.filter((r) => compte(r, BLANK) !== 2);
  verifie("tous les tirages portent deux jokers", sansDeux.length === 0,
    sansDeux.length === 0 ? `${tirages.length} tirages` : sansDeux.join(" "));
  console.log(`         ${parCoup} ms par coup, calcul du top compris`);

  // Le compte du sac tient malgre les substitutions : un joker qui joue un R
  // fait sortir un vrai R du sac, et le joker revient au tirage.
  const attendu = tailleDuSac(dictionnaire("ods9"), 2);
  const poses = g.moves.reduce((a, m) => a + m.placements.length, 0);
  const total = g.restantDuSac().length + g.rack.length + poses + g.jokersEnReserve
    - compte(g.rack, BLANK);
  verifie("sac + chevalet + grille + reserve = 204", total === attendu, `${total}`);

  // LA REPRISE DOIT SERVIR LE MEME TIRAGE. Deux jokers retires du reliquat au
  // lieu d'un, et le sac diverge des le premier coup relu.
  const sacAvant = g.restantDuSac();
  const suivant = g.rack;
  const coups = g.moves.length;
  await g.stop();
  setLayout("classique");
  const relu = new Game(ID, "classique", cfgSuper({ joker: true, jokersParCoup: 2 }));
  await relu.start();
  verifie("la partie se relit sans broncher", relu.moves.length === coups,
    `${relu.moves.length} coups rejoues`);
  await relu.reveiller();
  verifie("le tirage suivant est celui d'avant l'arret", relu.rack === suivant,
    `${relu.rack} contre ${suivant}`);
  verifie("le sac est le meme, caramel par caramel", relu.restantDuSac() === sacAvant,
    `${relu.restantDuSac().length} caramels contre ${sacAvant.length}`);
  await relu.stop();
  nettoyer(ID);
}

console.log("\nLe double joker sur le plateau du commerce : un seul sac\n");
{
  const ID = "double-joker-15-test";
  nettoyer(ID);
  setLayout("classique");
  const cfg = avec(configParDefaut(), {
    bornes: 7, pavage: LAYOUTS.classique15, pavageNom: "classique15",
    pioche: "sac102", chrono: null, joker: true, jokersParCoup: 2,
  });
  const g = new Game(ID, "classique", cfg);
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  verifie("deux jokers en reserve", g.jokersEnReserve === 2, `${g.jokersEnReserve}`);
  verifie("le tirage en porte deux", compte(g.rack, BLANK) === 2, g.rack);
  await jouer(g, 8);
  const tous = g.moves.every((m) => compte(m.rack, BLANK) === 2);
  verifie("tous les tirages en portent deux", tous, `${g.moves.length} coups`);
  await g.stop();
  nettoyer(ID);
}

console.log("\nUne partie sans joker n'en recoit aucun\n");
{
  const ID = "sans-joker-test";
  nettoyer(ID);
  setLayout("classique");
  const g = new Game(ID, "classique", cfgSuper({ joker: false, jokersParCoup: 2 }));
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  // `jokersParCoup` ne veut rien dire sans `joker` : les deux jokers du sac
  // restent piochables comme n'importe quel caramel.
  verifie("aucun joker en reserve", g.jokersEnReserve === 0, `${g.jokersEnReserve}`);
  verifie("le tirage fait sept caramels", g.rack.length === 7, g.rack);
  await g.stop();
  nettoyer(ID);
}

console.log(echecs === 0
  ? "\nOK : le double sac compte juste, le double joker sert ses deux jokers\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
