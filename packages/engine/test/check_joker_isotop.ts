/**
 * A score egal, on garde le joker. Voir SPEC.md §16.
 *
 *     node packages/engine/test/check_joker_isotop.ts
 *
 * LE CAS QUI A REVELE LA REGLE MANQUANTE. Tirage `AEEMRR?`, un S sur la grille,
 * deux isotops au meme score : GERMERAS avec le joker en G, CREMERAS avec le
 * joker en C. Il ne restait plus de G au sac, mais il restait des C. Le solveur
 * a tire au sort et a pose GERMERAS : le joker n'a trouve aucun G a se
 * substituer, il s'est pose lui-meme, a zero pour toujours, et la reserve a
 * perdu une unite -- pour rien, puisque CREMERAS valait le meme score et rendait
 * le joker au tirage.
 *
 * LE SOLVEUR NE VOYAIT PAS LE SAC. Il ne pouvait donc pas savoir si l'emploi du
 * joker le consommerait vraiment, et se contentait de preferer les isotops qui
 * ne l'employaient pas DU TOUT. Quand ils l'employaient tous, cette prudence ne
 * disait plus rien. Il recoit maintenant ce qu'il reste dans le sac, par lettre.
 *
 * Ce test ne demande ni lexique ni grille : la regle est dans `pickTop`, et se
 * lit sur des coups fabriques a la main. C'est aussi ce qui permet de poser le
 * cas exact de Zulu, qui ne se retrouverait pas facilement en jouant.
 */
import { pickTop } from "../src/movegen.ts";
import type { Move } from "../src/score.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(58)} ${detail}`);
  if (!ok) echecs++;
}

/**
 * Un coup fabrique : son mot, son score, et lesquelles de ses lettres sont
 * posees par un joker.
 *
 * `jokers` liste les lettres jouees PAR UN JOKER. Les autres lettres sont de
 * vraies lettres du tirage ; leur identite n'a aucune importance ici.
 */
function coup(mot: string, score: number, jokers: string[] = [], y = 0): Move {
  const restants = [...jokers];
  return {
    dir: "H", x: 0, y, word: mot, score,
    placements: [...mot].map((l, i) => {
      const i2 = restants.indexOf(l);
      if (i2 !== -1) { restants.splice(i2, 1); return { x: i, y, letter: l, blank: true }; }
      return { x: i, y, letter: l, blank: false };
    }),
  };
}

/** Le tirage au sort, remplace par un choix ferme : on veut voir le filtre. */
const premier = () => 0;
const dernier = () => 0.999999;

console.log("\nA score egal, on garde le joker\n");

// ------------------------------------------------------- le cas de Zulu
console.log("  --- AEEMRR? : GERMERAS ou CREMERAS ---\n");
{
  const germeras = coup("GERMERAS", 74, ["G"]);
  const cremeras = coup("CREMERAS", 74, ["C"]);
  // Plus un seul G, mais il reste deux C : c'est CREMERAS qu'il faut retenir.
  const sac = { C: 2, E: 5, A: 4, I: 3, T: 3 };

  for (const [nom, alea] of [["premier", premier], ["dernier", dernier]] as const) {
    const r = pickTop([germeras, cremeras], alea, true, sac);
    verifie(`le joker survit, quel que soit le tirage au sort (${nom})`,
      r?.top.word === "CREMERAS", r?.top.word ?? "aucun");
  }
  // L'ordre de la liste ne doit rien changer non plus.
  const r = pickTop([cremeras, germeras], premier, true, sac);
  verifie("l'ordre de la liste ne change rien", r?.top.word === "CREMERAS",
    r?.top.word ?? "aucun");

  // Les deux isotops restent listes : ils existent, ils sont seulement moins
  // bons a jouer.
  verifie("les deux isotops restent listes", r?.isotops.length === 2,
    `${r?.isotops.length ?? 0}`);

  // SANS LE SAC, L'ANCIENNE PRUDENCE : les deux emploient le joker, donc le
  // tirage au sort tranche. C'est exactement le bug.
  const aveugleA = pickTop([germeras, cremeras], premier, true);
  const aveugleB = pickTop([germeras, cremeras], dernier, true);
  verifie("sans le sac, le choix redevient un tirage au sort",
    aveugleA?.top.word !== aveugleB?.top.word,
    `${aveugleA?.top.word} puis ${aveugleB?.top.word}`);
}

// ------------------------------------------- le sac vide, et le sac sans stock
console.log("\n  --- ce que le sac dit, et ce qu'il ne dit pas ---\n");
{
  const germeras = coup("GERMERAS", 74, ["G"]);
  const cremeras = coup("CREMERAS", 74, ["C"]);
  // SAC VIDE : aucun des deux ne sauve le joker. Le tirage au sort reprend ses
  // droits, et c'est juste -- il n'y a plus rien a preferer.
  const a = pickTop([germeras, cremeras], premier, true, {});
  const b = pickTop([germeras, cremeras], dernier, true, {});
  verifie("sac vide : plus rien a preferer", a?.top.word !== b?.top.word,
    `${a?.top.word} puis ${b?.top.word}`);

  // PIOCHE SANS STOCK (`null`) : la lettre du joker NAIT, aucun joker ne s'y
  // perd jamais. Rien a preferer non plus.
  const c = pickTop([germeras, cremeras], premier, true, null);
  const d = pickTop([germeras, cremeras], dernier, true, null);
  verifie("pioche sans stock : plus rien a preferer", c?.top.word !== d?.top.word,
    `${c?.top.word} puis ${d?.top.word}`);
}

// ------------------------------------------- l'ancienne regle tient toujours
console.log("\n  --- entre employer le joker et ne pas l'employer ---\n");
{
  // La regle d'avant reste : a score egal, un coup qui n'emploie PAS le joker
  // passe devant un coup qui l'emploie, meme quand le sac le rendrait.
  const sansJoker = coup("MARIERES", 74, [], 0);
  const avecJoker = coup("CREMERAS", 74, ["C"], 2);
  const sac = { C: 2 };
  for (const alea of [premier, dernier]) {
    const r = pickTop([sansJoker, avecJoker], alea, true, sac);
    verifie("celui qui n'emploie pas le joker passe devant",
      r?.top.word === "MARIERES", r?.top.word ?? "aucun");
  }
  // Et il passe devant a plus forte raison quand l'autre le perdrait.
  const perdu = coup("GERMERAS", 74, ["G"], 2);
  const r = pickTop([sansJoker, perdu], dernier, true, { C: 2 });
  verifie("a plus forte raison quand l'autre le perdrait",
    r?.top.word === "MARIERES", r?.top.word ?? "aucun");
}

// ------------------------------------------- deux jokers, et les exemplaires
console.log("\n  --- deux jokers, et le compte des exemplaires ---\n");
{
  // DOUBLE JOKER : le coup qui n'en perd aucun passe devant celui qui en perd
  // un, qui passe devant celui qui en perd deux.
  const zero = coup("CAREMES", 60, ["C", "M"], 0);
  const un = coup("GAREMES", 60, ["G", "M"], 2);
  const deux = coup("GAREZES", 60, ["G", "Z"], 4);
  const sac = { C: 1, M: 1 };
  for (const alea of [premier, dernier]) {
    const r = pickTop([zero, un, deux], alea, true, sac);
    verifie("celui qui ne perd aucun joker", r?.top.word === "CAREMES",
      r?.top.word ?? "aucun");
  }
  const r = pickTop([un, deux], dernier, true, sac);
  verifie("puis celui qui n'en perd qu'un", r?.top.word === "GAREMES",
    r?.top.word ?? "aucun");

  // DEUX JOKERS SUR LA MEME LETTRE demandent DEUX exemplaires. Un seul C au
  // sac, et le second joker se perd : le coup qui joue un C et un M, dont il
  // reste un de chaque, est meilleur.
  const deuxC = coup("CC", 60, ["C", "C"], 0);
  const unChacun = coup("CM", 60, ["C", "M"], 2);
  for (const alea of [premier, dernier]) {
    const q = pickTop([deuxC, unChacun], alea, true, { C: 1, M: 1 });
    verifie("un seul C ne sert qu'un joker sur deux", q?.top.word === "CM",
      q?.top.word ?? "aucun");
  }
  // Deux C au sac, et les deux se valent de nouveau.
  const e = pickTop([deuxC, unChacun], premier, true, { C: 2, M: 1 });
  const f = pickTop([deuxC, unChacun], dernier, true, { C: 2, M: 1 });
  verifie("deux C, et les deux coups se valent", e?.top.word !== f?.top.word,
    `${e?.top.word} puis ${f?.top.word}`);
}

// ------------------------------------------- hors partie joker, rien ne change
console.log("\n  --- hors partie joker, la regle ne s'applique pas ---\n");
{
  // Un joker peut sortir du sac de 102 dans une partie ORDINAIRE : il se pose
  // alors pour ce qu'il est, a zero, et il n'y a rien a conserver. Le sac ne
  // doit donc rien changer au choix.
  const germeras = coup("GERMERAS", 74, ["G"]);
  const cremeras = coup("CREMERAS", 74, ["C"]);
  const a = pickTop([germeras, cremeras], premier, false, { C: 2 });
  const b = pickTop([germeras, cremeras], dernier, false, { C: 2 });
  verifie("le sac ne pese pas hors partie joker", a?.top.word !== b?.top.word,
    `${a?.top.word} puis ${b?.top.word}`);
}

// ------------------------------------------- le score reste le premier juge
console.log("\n  --- le score passe avant tout ---\n");
{
  // UN COUP MOINS CHER NE PASSE JAMAIS DEVANT, quel que soit le sort du joker.
  // La regle ne departage que des isotops -- des coups de MEME score.
  const cher = coup("GERMERAS", 74, ["G"]);
  const moinsCher = coup("CREMERA", 70, ["C"], 2);
  const r = pickTop([cher, moinsCher], premier, true, { C: 2 });
  verifie("le top reste le plus cher, joker perdu ou non",
    r?.top.word === "GERMERAS" && r?.bestScore === 74, r?.top.word ?? "aucun");
  verifie("et le coup moins cher n'est pas un isotop", r?.isotops.length === 1);
}

console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
