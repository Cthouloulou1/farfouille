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
import { BLANK, isVowel, isConsonant } from "../../engine/src/alphabet.ts";
import { COUP_RELACHEMENT, regleDuDoubleJoker } from "../../engine/src/bag.ts";
import { politiqueSacFini } from "../../engine/src/sac.ts";

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

/**
 * Les tirages qui ne portent pas le compte de jokers attendu.
 *
 * DEUX JOKERS, TANT QUE LA RESERVE LES PORTE. Un joker qui n'a pas trouve sa
 * lettre s'est pose lui-meme et ne revient plus : la reserve baisse, et le
 * tirage n'en recoit plus que ce qu'elle a. Exiger deux jokers a tous les coups
 * rendrait ce test dependant du hasard du sac.
 */
function tiragesFautifs(g: Game, reserveInitiale: number): string[] {
  let reserve = reserveInitiale;
  const fautifs: string[] = [];
  for (const m of g.moves) {
    const attendu = Math.min(2, reserve);
    if (compte(m.rack, BLANK) !== attendu) fautifs.push(`${m.rack} au lieu de ${attendu}`);
    reserve -= m.jokers?.restes ?? 0;
  }
  return fautifs;
}

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

  const debut = Date.now();
  await jouer(g, 12);
  const parCoup = Math.round((Date.now() - debut) / Math.max(1, g.moves.length));

  verifie("la partie avance", g.moves.length >= 10, `${g.moves.length} coups`);
  // LE POINT DU TEST. Chaque tirage porte ses deux jokers, du premier au
  // dernier -- tant que la reserve les porte.
  const sansDeux = tiragesFautifs(g, 4);
  verifie("tous les tirages portent deux jokers", sansDeux.length === 0,
    sansDeux.length === 0 ? `${g.moves.length} tirages` : sansDeux.join(" "));
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

console.log("\nLa regle de rejet du double joker\n");
{
  // Refuse = `true`. Cinq consonnes et deux jokers se jouent tres bien : la
  // regle ne les refuse que le temps que la grille se garnisse.
  const cinqConsonnes = [..."BCDFG"];
  const cinqVoyelles = [..."AEIOU"];
  const melange = [..."BCDFA"];
  verifie("au coup 1, cinq consonnes sont refusees",
    regleDuDoubleJoker(cinqConsonnes, 1) === true);
  verifie("au coup 1, cinq voyelles sont refusees",
    regleDuDoubleJoker(cinqVoyelles, 1) === true);
  verifie("au coup 1, une de chaque suffit",
    regleDuDoubleJoker(melange, 1) === false);
  verifie("au coup 15, la regle vaut encore",
    regleDuDoubleJoker(cinqConsonnes, COUP_RELACHEMENT - 1) === true);
  // LE POINT DU TEST. Passe le coup 15, il n'y a plus de regle du tout.
  verifie("au coup 16, cinq consonnes passent",
    regleDuDoubleJoker(cinqConsonnes, COUP_RELACHEMENT) === false);
  verifie("au coup 16, cinq voyelles passent",
    regleDuDoubleJoker(cinqVoyelles, COUP_RELACHEMENT) === false);

  // LA REGLE ORDINAIRE NE TOMBE JAMAIS ENTIEREMENT, elle se relache seulement :
  // meme au coup 30, il faut au moins une voyelle. C'est tout l'ecart avec le
  // double joker, ou plus rien n'est exige.
  const sansVoyelle = [..."BCDFGHJ"];
  const ordinaire30 = politiqueSacFini(() => 30, () => true);
  const double30 = politiqueSacFini(() => 30, () => true, () => true);
  verifie("sans double joker, sept consonnes restent refusees au coup 30",
    ordinaire30(sansVoyelle) === true);
  verifie("en double joker, elles passent au coup 30",
    double30(sansVoyelle) === false);
  // ET LA REGLE NE SE DEDUIT PLUS DE LA TAILLE DU TIRAGE : en « 7 sur 9 » le
  // sac distribue sept lettres, et le deux-et-deux revenait sans qu'on l'ait
  // voulu -- au coup 1, la regle ordinaire refuse un tirage a une seule voyelle.
  const uneVoyelle = [..."BCDFGHA"];
  const ordinaire1 = politiqueSacFini(() => 1, () => true);
  const double1 = politiqueSacFini(() => 1, () => true, () => true);
  verifie("sans double joker, sept lettres a une voyelle sont refusees",
    ordinaire1(uneVoyelle) === true, "il en faut deux");
  verifie("en double joker, elles passent", double1(uneVoyelle) === false,
    "une voyelle suffit");
}

console.log("\nLes tirages servis suivent la regle\n");
{
  const ID = "double-rejet-test";
  nettoyer(ID);
  setLayout("classique");
  const g = new Game(ID, "classique", cfgSuper({ joker: true, jokersParCoup: 2 }));
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  const tirages = [g.rack];
  await jouer(g, 14);
  for (const m of g.moves) tirages.push(m.rack);

  // Les quinze premiers tirages : au moins une voyelle et une consonne parmi
  // les VRAIES lettres, jokers mis a part.
  const fautifs: string[] = [];
  for (const r of tirages.slice(0, COUP_RELACHEMENT - 1)) {
    const vraies = [...r].filter((c) => c !== BLANK);
    if (vraies.filter(isVowel).length < 1 || vraies.filter(isConsonant).length < 1) {
      fautifs.push(r);
    }
  }
  verifie("les quinze premiers tirages ont une de chaque", fautifs.length === 0,
    fautifs.length === 0 ? `${Math.min(tirages.length, 15)} tirages` : fautifs.join(" "));
  await g.stop();
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
  const fautifs = tiragesFautifs(g, 2);
  verifie("tous les tirages en portent deux", fautifs.length === 0,
    fautifs.length === 0 ? `${g.moves.length} coups` : fautifs.join(" "));
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
