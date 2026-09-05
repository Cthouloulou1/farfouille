/**
 * Ce que devient un joker, selon la pioche. Voir SPEC.md §16.
 *
 *     node packages/server/test/check_joker_sac.ts
 *
 * Un joker qui joue un R pose un vrai R : il vaudra ses points pour tous les
 * coups suivants, et le joker revient au tirage. La question est de savoir D'OU
 * VIENT CE R.
 *
 *   sac fini          du sac. Le jeu n'a qu'un W : le donner deux fois serait
 *                     en inventer un. Quand le sac ne l'a plus, le joker se
 *                     pose lui-meme, a zero pour toujours, et la reserve baisse.
 *   sac qui boucle    de nulle part. Le sac retrouve sa composition d'origine
 *                     des qu'il s'appauvrit : il n'a pas de stock a defendre,
 *                     et prelever le R n'avancait que la date du rechargement.
 *   probabilites      de nulle part non plus, et c'est un bug repare : il n'y
 *                     avait rien a prelever, si bien que TOUS les jokers
 *                     restaient jokers.
 *
 * Ce qui doit tenir, et que ce test verifie : sur une pioche qui ne s'epuise
 * pas, aucun joker ne reste jamais sur la grille, la reserve ne baisse jamais,
 * et une partie rejouee depuis son journal retrouve exactement le meme sac --
 * sans quoi les deux divergeraient au coup suivant.
 */
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { configParDefaut, avec } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";
import { dictionnaire } from "../../engine/src/dictionnaires.ts";

type NomDePioche = "probabilites" | "sac102" | "sac102boucle";

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

/** Joue une partie joker sur la pioche demandee, et rend ce qu'elle a fait. */
async function jouer(id: string, pioche: NomDePioche, coups: number): Promise<{
  jeu: Game; sortis: string[]; restes: number; reserve: number;
}> {
  nettoyer(id);
  setLayout("classique");
  const cfg = avec(configParDefaut(), { bornes: 7, pioche, chrono: null, joker: true });
  const g = new Game(id, "classique", cfg);
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  for (let i = 0; i < coups && !g.finie; i++) {
    await g.reveal();
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    jeu: g,
    sortis: g.moves.flatMap((m) => m.jokers?.sortis ?? []),
    restes: g.moves.reduce((a, m) => a + (m.jokers?.restes ?? 0), 0),
    reserve: g.jokersEnReserve,
  };
}

console.log("\nCe que devient un joker, selon la pioche\n");

// ------------------------------------------------------------ SAC QUI BOUCLE
console.log("  --- sac qui se recharge : la lettre nait ---\n");
{
  const ID = "joker-boucle-test";
  const r = await jouer(ID, "sac102boucle", 14);
  verifie("la partie a avance", r.jeu.moves.length >= 10, `${r.jeu.moves.length} coups`);
  verifie("des jokers ont joue de vraies lettres", r.sortis.length >= 3,
    `${r.sortis.length} lettres (${r.sortis.join(" ")})`);
  // LE POINT DU TEST. Un joker ne reste jamais sur la grille quand la pioche ne
  // s'epuise pas : il n'y a pas de lettre a manquer.
  verifie("aucun joker n'est reste sur la grille", r.restes === 0,
    r.restes === 0 ? "ils sont tous devenus des lettres" : `${r.restes} restes`);
  verifie("la reserve de jokers n'a pas bouge", r.reserve === Infinity,
    `${r.reserve === Infinity ? "inepuisable" : r.reserve}`);
  // Un joker substitue pose une VRAIE lettre : plus de drapeau sur la grille.
  const drapeaux = r.jeu.moves.filter((m) => m.placements.some((p) => p.blank)).length;
  verifie("les lettres posees ne portent plus le drapeau", drapeaux === 0,
    drapeaux === 0 ? "la substitution est faite" : `${drapeaux} coups en portent`);

  // LA REPRISE DOIT SUIVRE LA MEME REGLE. Si le jeu ne prelevait pas et que la
  // reprise prelevait, le sac divergerait des le premier joker relu -- et les
  // tirages d'apres avec lui.
  const sacAvant = r.jeu.restantDuSac();
  const suivant = r.jeu.rack;
  await r.jeu.stop();
  setLayout("classique");
  const cfg = avec(configParDefaut(), { bornes: 7, pioche: "sac102boucle", chrono: null, joker: true });
  const relu = new Game(ID, "classique", cfg);
  await relu.start();
  verifie("la partie se relit sans broncher", relu.moves.length === r.jeu.moves.length,
    `${relu.moves.length} coups rejoues`);
  verifie("et la reserve de jokers aussi", relu.jokersEnReserve === r.reserve);
  // ON REVEILLE AVANT DE COMPARER LE SAC. Le tirage en cours au moment de
  // l'arret a deja quitte le sac ; la partie relue ne le sert qu'au reveil, et
  // comparer avant ferait apparaitre un ecart qui n'est que d'horaire.
  await relu.reveiller();
  verifie("le tirage suivant est celui d'avant l'arret", relu.rack === suivant,
    `${relu.rack} contre ${suivant}`);
  verifie("le sac est le meme, caramel par caramel",
    relu.restantDuSac() === sacAvant,
    `${relu.restantDuSac().length} caramels contre ${sacAvant.length}`);
  await relu.stop();
  nettoyer(ID);
}

// ------------------------------------------------------------- PROBABILITES
console.log("\n  --- probabilites ponderees : la lettre nait aussi ---\n");
{
  const ID = "joker-proba-test";
  const r = await jouer(ID, "probabilites", 14);
  verifie("la partie a avance", r.jeu.moves.length >= 10, `${r.jeu.moves.length} coups`);
  // C'ETAIT LE BUG : sans sac, il n'y avait rien a retirer, donc la
  // substitution echouait toujours et chaque joker restait joker a zero point.
  verifie("des jokers ont joue de vraies lettres", r.sortis.length >= 3,
    `${r.sortis.length} lettres (${r.sortis.join(" ")})`);
  verifie("aucun joker n'est reste sur la grille", r.restes === 0,
    r.restes === 0 ? "ils sont tous devenus des lettres" : `${r.restes} restes`);
  verifie("la reserve de jokers n'a pas bouge", r.reserve === Infinity);
  await r.jeu.stop();
  nettoyer(ID);
}

// ----------------------------------------------------------------- SAC FINI
console.log("\n  --- sac fini : la lettre sort du sac ---\n");
{
  const ID = "joker-fini-test";
  const r = await jouer(ID, "sac102", 14);
  verifie("la partie a avance", r.jeu.moves.length >= 10, `${r.jeu.moves.length} coups`);
  verifie("des jokers ont fait sortir de vraies lettres", r.sortis.length >= 2,
    `${r.sortis.length} lettres (${r.sortis.join(" ")})`);
  // L'INVARIANT DU SAC FINI : rien ne se cree, rien ne se perd.
  //
  // Tout ce que le jeu contient est soit dans le sac, soit sur le chevalet,
  // soit pose sur la grille. Les jokers sont hors de ce compte -- ils ne sont
  // pas piochables et accompagnent le tirage -- sauf ceux qui sont restes sur
  // la grille faute de lettre, qui n'y ont rien pris non plus.
  //
  // C'est ce compte qui dirait qu'un joker a fait naitre une lettre : il y
  // aurait alors un caramel de plus que le jeu n'en contient.
  const distribution = dictionnaire(configParDefaut().dictionnaire).sac;
  let total = 0;
  for (const [l, c] of Object.entries(distribution)) if (l !== "?") total += c;
  const sac = r.jeu.restantDuSac().length;
  const enMain = [...r.jeu.rack].filter((c) => c !== "?").length;
  const posees = r.jeu.moves.flatMap((m) => m.placements).filter((p) => !p.blank).length;
  verifie("rien ne se cree, rien ne se perd", sac + enMain + posees === total,
    `${sac} au sac + ${enMain} en main + ${posees} sur la grille = ${sac + enMain + posees} sur ${total}`);
  // La reserve, elle, ne baisse que lorsqu'un joker ne trouve pas sa lettre.
  verifie("la reserve suit les jokers restes", r.reserve === 2 - r.restes,
    `${r.reserve} en reserve, ${r.restes} reste(s) sur la grille`);

  const sacAvant = r.jeu.restantDuSac();
  const suivant = r.jeu.rack;
  await r.jeu.stop();
  setLayout("classique");
  const cfg = avec(configParDefaut(), { bornes: 7, pioche: "sac102", chrono: null, joker: true });
  const relu = new Game(ID, "classique", cfg);
  await relu.start();
  await relu.reveiller();
  verifie("le tirage suivant est celui d'avant l'arret", relu.rack === suivant,
    `${relu.rack} contre ${suivant}`);
  verifie("le sac relu est le meme, caramel par caramel",
    relu.restantDuSac() === sacAvant,
    `${relu.restantDuSac().length} caramels contre ${sacAvant.length}`);
  verifie("et la reserve de jokers aussi", relu.jokersEnReserve === r.reserve,
    `${relu.jokersEnReserve} contre ${r.reserve}`);
  await relu.stop();
  nettoyer(ID);
}

console.log(echecs === 0
  ? "\nOK : le joker prend sa lettre au sac quand il y en a un, et nulle part ailleurs\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
