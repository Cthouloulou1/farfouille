/**
 * La configuration de partie fait-elle ce qu'elle promet ? Voir SPEC.md §16.
 *
 *     node packages/engine/test/check_config.ts
 *
 * Trois choses a prouver : le defaut reproduit le jeu d'aujourd'hui, la limite
 * « X sur Y » est respectee par le generateur, et la table des primes commande
 * reellement le score.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { generateMoves } from "../src/movegen.ts";
import { scoreMove } from "../src/score.ts";
import { setLayout } from "../src/bonus.ts";
import { configParDefaut, avec, primesParDefaut } from "../src/config.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

setLayout("pave1");
const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(46)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nLimite « X sur Y » -- tirage de 7 caramels\n");

for (const jouables of [7, 5, 3, 2]) {
  const cfg = avec(configParDefaut(), { tirage: 7, jouables });
  const b = new Board(dawg, cfg);
  const g = generateMoves(b, gaddag, "AEINRST", { prune: false });
  const max = Math.max(...g.moves.map((m) => m.placements.length));
  const combien = g.moves.length;
  verifie(
    `jouables = ${jouables}`,
    max <= jouables && combien > 0,
    `${combien} coups, au plus ${max} caramels poses`,
  );
}

console.log("\nLe defaut reproduit le jeu classique\n");

{
  const b = new Board(dawg, configParDefaut());
  const g = generateMoves(b, gaddag, "AEINRST", { prune: false });
  const sept = g.moves.filter((m) => m.placements.length === 7);
  const six = g.moves.filter((m) => m.placements.length === 6);
  // Meme mot, prime retiree : l'ecart doit valoir exactement 50.
  const sansPrime = new Board(dawg, avec(configParDefaut(), { primes: {} }));
  const m = sept[0]!;
  const ecart = scoreMove(b, m) - scoreMove(sansPrime, m);
  verifie("prime de 50 pour 7 caramels", ecart === 50, `${sept.length} coups a 7 caramels, ecart ${ecart}`);
  verifie("aucune prime a 6 caramels", six.length > 0
    && scoreMove(b, six[0]!) === scoreMove(sansPrime, six[0]!), `${six.length} coups a 6 caramels`);
}

console.log("\nLa table des primes commande le score -- partie 8 sur 8\n");

{
  const base = avec(configParDefaut(), { tirage: 8, jouables: 8 });
  const b = new Board(dawg, base);
  const g = generateMoves(b, gaddag, "AEINRSTB", { prune: false });
  const huit = g.moves.filter((m) => m.placements.length === 8);
  if (huit.length === 0) {
    verifie("un coup de 8 caramels existe", false, "aucun trouve avec AEINRSTB");
  } else {
    const m = huit[0]!;
    const nue = new Board(dawg, avec(base, { primes: {} }));
    const genereuse = new Board(dawg, avec(base, { primes: { ...primesParDefaut(), 8: 200 } }));
    const sans = scoreMove(nue, m);
    const defaut = scoreMove(b, m);
    const riche = scoreMove(genereuse, m);
    verifie("prime par defaut de 75 a 8 caramels", defaut - sans === 75, `${m.word} : ${sans} + 75 = ${defaut}`);
    verifie("prime personnalisee de 200 respectee", riche - sans === 200, `${m.word} : ${sans} + 200 = ${riche}`);
  }
}

console.log("\nLes primes personnalisees sur une petite partie -- 3 sur 6\n");

{
  // Ton exemple : 15 points pour 2 caramels, 25 pour 3, alors que le jeu
  // classique n'accorde rien en dessous de 7.
  const cfg = avec(configParDefaut(), { tirage: 6, jouables: 3, primes: { 2: 15, 3: 25 } });
  const b = new Board(dawg, cfg);
  const nue = new Board(dawg, avec(cfg, { primes: {} }));
  const g = generateMoves(b, gaddag, "AEINRS", { prune: false });
  for (const n of [2, 3]) {
    const m = g.moves.find((q) => q.placements.length === n);
    if (m === undefined) { verifie(`coup de ${n} caramels`, false, "aucun trouve"); continue; }
    const attendu = n === 2 ? 15 : 25;
    const ecart = scoreMove(b, m) - scoreMove(nue, m);
    verifie(`prime de ${attendu} a ${n} caramels`, ecart === attendu, `${m.word} : ecart ${ecart}`);
  }
  const max = Math.max(...g.moves.map((q) => q.placements.length));
  verifie("jamais plus de 3 caramels poses", max <= 3, `maximum observe ${max}`);
}

console.log(echecs === 0
  ? "\nOK : la configuration commande le tirage, la pose et les primes\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
