/**
 * Le sac fini de 102 caramels et la fin de partie. Voir SPEC.md §16.
 *
 *     node packages/engine/test/check_sac.ts
 */
import { SacFini, SAC_FRANCAIS } from "../src/sac.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { mulberry32 } from "../src/rng.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(48)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nComposition du sac\n");
{
  const total = Object.values(SAC_FRANCAIS).reduce((a, b) => a + b, 0);
  verifie("102 caramels au total", total === 102, `${total}`);
  verifie("15 E, 9 A, 2 jokers", SAC_FRANCAIS["E"] === 15 && SAC_FRANCAIS["A"] === 9 && SAC_FRANCAIS["?"] === 2);
}

console.log("\nLe sac s'epuise, et rend ce qu'il a distribue\n");
{
  const sac = new SacFini(SAC_FRANCAIS, mulberry32(1), 7);
  verifie("102 au depart", sac.reste === 102, `${sac.reste}`);
  const d = sac.draw([]);
  verifie("7 caramels tires", d.rack.length === 7, d.rack);
  verifie("95 restants", sac.reste === 95, `${sac.reste}`);

  // Un caramel garde au reliquat n'est pas repioche.
  const reliquat = [...d.rack].slice(0, 3);
  const d2 = sac.draw(reliquat);
  verifie("le reliquat complete a 7", d2.rack.length === 7, d2.rack);
  verifie("91 restants apres 4 nouveaux", sac.reste === 91, `${sac.reste}`);
  verifie("notation avec reliquat", d2.notation.includes("+") || d2.notation.startsWith("-"), d2.notation);
}

console.log("\nTirage de taille libre\n");
for (const n of [2, 8, 15]) {
  const sac = new SacFini(SAC_FRANCAIS, mulberry32(4), n);
  const d = sac.draw([]);
  verifie(`tirage de ${n}`, d.rack.length === n, d.rack);
  const pond = new Bag(DEFAULT_BAG, mulberry32(4), undefined, n);
  const p = pond.draw([]);
  verifie(`probabilites ponderees, tirage de ${n}`, p.rack.length === n, p.rack);
}

console.log("\nFin de partie -- la convention\n");
{
  // On construit des sacs reduits pour eprouver chaque cas de la regle.
  const cas: [string, Record<string, number>, string[], boolean][] = [
    ["sac vide, reliquat vide", {}, [], true],
    ["que des voyelles", { A: 3, E: 2 }, [], true],
    ["que des voyelles et le Y", { A: 3, Y: 1 }, [], true],
    ["le Y seul", { Y: 1 }, [], true],
    ["consonnes seules avec le Y", { B: 2, T: 1, Y: 1 }, [], false],
    ["consonnes seules sans le Y", { B: 2, T: 1 }, [], true],
    ["un joker traine", { A: 3, "?": 1 }, [], false],
    ["voyelles et consonnes", { A: 2, B: 2 }, [], false],
    ["le reliquat compte aussi", { A: 3 }, ["B", "T"], false],
    ["reliquat de voyelles seulement", { A: 3 }, ["E"], true],
  ];
  for (const [nom, distribution, reliquat, attendu] of cas) {
    const sac = new SacFini(distribution, mulberry32(1), 7);
    verifie(nom, sac.estFinie(reliquat) === attendu, attendu ? "finie" : "on continue");
  }
}

console.log("\nSac rechargeable : sac + reliquat ne depasse jamais la distribution\n");
{
  const total = Object.values(SAC_FRANCAIS).reduce((a, b) => a + b, 0);
  const sac = new SacFini(SAC_FRANCAIS, mulberry32(5), 7);
  sac.recharge = true;
  let rel: string[] = [], pireW = 0, pireTotal = 0, fautes = 0;
  for (let n = 1; n <= 600; n++) {
    const d = sac.draw(rel);
    // On garde les lettres cheres : c'est le cas qui revelait le defaut, un W
    // conserve en main pendant que le rechargement en remettait un au sac.
    rel = [...d.rack].filter((c) => "WKXZJQY".includes(c)).slice(0, 5);
    const restant = sac.restant();
    const w = (restant["W"] ?? 0) + rel.filter((c) => c === "W").length;
    const somme = Object.values(restant).reduce((a, b) => a + b, 0) + rel.length;
    pireW = Math.max(pireW, w);
    pireTotal = Math.max(pireTotal, somme);
    if (w > 1 || somme > total) fautes++;
  }
  verifie("jamais deux W en jeu", pireW <= 1, `maximum vu : ${pireW}`);
  verifie("sac + reliquat <= 102", pireTotal <= total, `maximum vu : ${pireTotal}`);
  verifie("aucun coup en faute", fautes === 0, `${sac.rechargements} rechargements`);
}


console.log("\nRetrait d'une lettre -- ce dont la partie joker a besoin\n");
{
  const sac = new SacFini({ K: 1, A: 5 }, mulberry32(1), 7);
  verifie("le K est la", sac.contient("K"));
  verifie("on le retire", sac.retirer("K"));
  verifie("il n'y est plus", !sac.contient("K"));
  verifie("on ne peut pas le retirer deux fois", !sac.retirer("K"));
}

console.log(echecs === 0
  ? "\nOK : le sac fini distribue, s'epuise, et sait quand la partie est terminee\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
