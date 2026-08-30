/**
 * Le sac fini de 102 caramels et la fin de partie. Voir SPEC.md §16.
 *
 *     node packages/engine/test/check_sac.ts
 */
import { SacFini, SAC_FRANCAIS, COUP_RELACHEMENT, politiqueSacFini } from "../src/sac.ts";
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
    // Le Y bascule des DEUX cotes : il tient lieu de consonne ici comme il
    // tenait lieu de voyelle plus bas. La partie continue, et la pioche
    // l'exigera dans le tirage pour qu'il soit joue.
    ["que des voyelles et le Y", { A: 3, Y: 1 }, [], false],
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


console.log("\nLe relachement du coup 16 ne vaut que pour un sac qui s'epuise\n");
{
  /** Voyelles et consonnes d'un tirage, le Y et le joker etant neutres. */
  const compte = (rack: string): { v: number; c: number } => {
    let v = 0, c = 0;
    for (const ch of rack) {
      if ("AEIOU".includes(ch)) v++;
      else if (ch !== "Y" && ch !== "?") c++;
    }
    return { v, c };
  };

  // Sac qui se recharge : la regle stricte du premier coup au dernier. C'est le
  // cas de la grille infinie ou un tirage a une seule voyelle est passe au 37e.
  {
    const sac = new SacFini(SAC_FRANCAIS, mulberry32(7), 7);
    sac.recharge = true;
    let pire = 9, coupFautif = 0, reliquat: string[] = [];
    for (let n = 1; n <= 300; n++) {
      const d = sac.draw(reliquat);
      const { v, c } = compte(d.rack);
      if (Math.min(v, c) < pire) { pire = Math.min(v, c); coupFautif = n; }
      reliquat = [...d.rack].slice(0, 2);
    }
    verifie("sac bouclant : jamais moins de 2 de chaque sur 300 coups",
      pire >= 2, pire < 2 ? `${pire} au coup ${coupFautif}` : `minimum vu : ${pire}`);
  }

  // Sac fini : le relachement reste, sinon la fin de partie serait injouable.
  {
    const sac = new SacFini(SAC_FRANCAIS, mulberry32(7), 7);
    let relache = false, reliquat: string[] = [];
    for (let n = 1; n <= 40 && !sac.estFinie(reliquat); n++) {
      const d = sac.draw(reliquat);
      const { v, c } = compte(d.rack);
      if (n >= COUP_RELACHEMENT && Math.min(v, c) === 1) relache = true;
      reliquat = [];
    }
    // Le relachement AUTORISE un tirage a un seul, il ne l'impose pas : on
    // verifie donc que la porte est ouverte, pas qu'on la franchit.
    verifie("sac fini : la politique se relache au coup 16",
      politiqueSacFini(() => COUP_RELACHEMENT)([..."BCDFGHA"]) === false,
      relache ? "un tirage a un seul est sorti" : "aucun tirage limite ce coup-ci");
    verifie("sac fini : avant le coup 16, elle refuse",
      politiqueSacFini(() => 1)([..."BCDFGHA"]) === true);
    verifie("sac bouclant : elle refuse meme apres le coup 16",
      politiqueSacFini(() => 99, () => false)([..."BCDFGHA"]) === true);
  }
}

console.log("\nLe Y devient obligatoire quand il tient seul un role\n");
{
  // Plus de voyelle en dehors du Y : exiger une voyelle serait exiger
  // l'impossible, et c'est ce qui faisait tourner la pioche mille fois avant de
  // lever une erreur. Le Y en tient lieu, donc on le TIRE -- il sera joue, et
  // la partie s'achevera pour de bon.
  const sansVoyelle = new SacFini({ Y: 1, N: 2, T: 2, R: 2, S: 2 }, mulberry32(3), 3);
  verifie("un Y et des consonnes : la partie n'est pas finie", !sansVoyelle.estFinie([]));
  let leve: string | null = null;
  const tires: string[] = [];
  try {
    for (let i = 0; i < 6; i++) tires.push(sansVoyelle.draw([]).rack);
  } catch (e) { leve = (e as Error).message; }
  verifie("aucune erreur levee", leve === null, leve ?? "");
  verifie("le Y sort au premier tirage", tires[0]?.includes("Y") === true, tires[0] ?? "");

  // Symetriquement, quand le Y est la derniere consonne.
  const sansConsonne = new SacFini({ Y: 1, A: 2, E: 3, O: 2 }, mulberry32(5), 3);
  verifie("un Y et des voyelles : la partie n'est pas finie", !sansConsonne.estFinie([]));
  verifie("le Y sort la aussi", sansConsonne.draw([]).rack.includes("Y"));

  // Et le cas ordinaire n'est pas abime : quand un tirage acceptable existe,
  // c'est lui qui sort, Y ou pas.
  const plein = new SacFini(SAC_FRANCAIS, mulberry32(11), 7);
  const d = plein.draw([]);
  let v = 0, c = 0;
  for (const ch of d.rack) {
    if ("AEIOU".includes(ch)) v++;
    else if (ch !== "Y" && ch !== "?") c++;
  }
  verifie("sac plein : le tirage respecte la regle", v >= 2 && c >= 2, d.rack);
}

console.log("\nUn tirage abandonne rend ses lettres\n");
{
  // Un tirage dont aucun coup n'est jouable est refait. Ses lettres restaient
  // dehors : le sac de 102 n'en comptait plus que 99, et l'invariant
  // « tirage + sac = la distribution de depart » tombait en silence.
  const sac = new SacFini(SAC_FRANCAIS, mulberry32(2), 7);
  const total = () => Object.values(sac.restant()).reduce((a, b) => a + b, 0);
  const avant = total();
  const d = sac.draw([]);
  verifie("sept caramels sortis", avant - total() === 7, `${avant} -> ${total()}`);
  sac.rendre([...d.rack]);
  verifie("rendus, le compte est bon", total() === avant, `${total()} sur ${avant}`);

  // Les lettres rendues sont bien les memes : on recompte par lettre.
  const r = sac.restant();
  const attendu = SAC_FRANCAIS;
  const identique = Object.keys(attendu).every((l) => (r[l] ?? 0) === attendu[l]);
  verifie("et ce sont les memes lettres", identique);
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
