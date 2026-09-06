/**
 * Le solveur de recherche retrouve les exemples verifies a la main.
 *
 *     node packages/engine/test/check_solveur.ts
 */
import { loadDict } from "../src/dictionary_node.ts";
import { DAWG_PATH } from "../src/paths.ts";
import {
  analyserSaisie, benjamins, estUnMotAvecJokers, JOKERS_MAX, LONGUEUR_MAX_SAISIE,
  motsFormables, rallongesArriere, rallongesAvant, solutions, squelette, superBenjamins,
} from "../src/solveur.ts";

const dawg = loadDict(DAWG_PATH);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(60)} ${detail}`);
  if (!ok) echecs++;
}

const mots = (r: { resultats: { mot: string }[] }) => r.resultats.map((c) => c.mot).sort();
const eg = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

console.log("\nLe solveur de recherche\n");

// --- Existence, jokers compris ---
verifie("BOL est un mot", estUnMotAvecJokers(dawg, "BOL"));
verifie("BO n'est pas un mot", !estUnMotAvecJokers(dawg, "BO"));
verifie("B?L trouve BOL (et donc existe)", estUnMotAvecJokers(dawg, "B?L"));
verifie("ZZZ n'est pas un mot", !estUnMotAvecJokers(dawg, "ZZZ"));

// --- Benjamins : RAGE -> 30 mots, exactement 3 lettres ajoutees devant ---
{
  const r = benjamins(dawg, "RAGE");
  const liste = mots(r);
  console.log(`  benjamins(RAGE) = ${r.resultats.length} mots : ${liste.join(", ")}`);
  verifie("benjamins(RAGE) a 30 mots, tous a +3 lettres",
    r.resultats.length === 30 && r.resultats.every((c) => c.mot.length === 7),
    `${r.resultats.length} mots`);
  verifie("benjamins(RAGE) commence par ANCRAGE et finit par VITRAGE",
    liste[0] === "ANCRAGE" && liste[liste.length - 1] === "VITRAGE");
}

// --- Rallonges : comprennent les benjamins, triees par ajout croissant, MAIS
//     jamais le mot lui-meme (l'ensemble vide n'est pas une rallonge) ---
{
  const av = rallongesAvant(dawg, "RAGE");
  const croissant = av.resultats.every((c, i) => i === 0
    || (c.mot.length - 4) >= (av.resultats[i - 1]!.mot.length - 4));
  verifie("rallongesAvant(RAGE) triee par ajout croissant", croissant);
  verifie("rallongesAvant(RAGE) ne contient PAS RAGE lui-meme", !av.resultats.some((c) => c.mot === "RAGE"));
  verifie("rallongesAvant(RAGE) contient les benjamins",
    av.resultats.some((c) => c.mot === "ANCRAGE") && av.resultats.some((c) => c.mot === "VITRAGE"));

  const arCourt = rallongesArriere(dawg, "PARENT");
  verifie("rallongesArriere(PARENT) ne contient PAS PARENT lui-meme",
    !arCourt.resultats.some((c) => c.mot === "PARENT"));
}
{
  const ar = rallongesArriere(dawg, "CHATTER");
  verifie("rallongesArriere(CHATTER) contient CHATTERTON", ar.resultats.some((c) => c.mot === "CHATTERTON"));
}

// --- Superbenjamins : contenu strict, au moins une lettre de chaque cote ---
{
  const tol = superBenjamins(dawg, "TOLES");
  console.log(`  superBenjamins(TOLES) = ${mots(tol).join(", ")}`);
  verifie("superBenjamins(TOLES) = HODJATOLESLAM(S)",
    eg(mots(tol), ["HODJATOLESLAM", "HODJATOLESLAMS"]) || eg(mots(tol), ["HODJATOLESLAM"]));

  // L'exemple donne ne citait que le radical -- l'ODS9 connait aussi les
  // formes flechies, qui contiennent tout autant YINS.
  const yins = superBenjamins(dawg, "YINS");
  console.log(`  superBenjamins(YINS) = ${mots(yins).join(", ")}`);
  verifie("superBenjamins(YINS) contient POLYINSATURE et ses formes flechies",
    eg(mots(yins), ["POLYINSATURE", "POLYINSATUREE", "POLYINSATUREES", "POLYINSATURES"]));
}

// --- Squelettes : *, . ---
{
  const po = squelette(dawg, "PO*IL");
  console.log(`  PO*IL = ${mots(po).join(", ")}`);
  verifie("PO*IL = POIL, POINTIL, POITRAIL, PONTIL, PORTAIL",
    eg(mots(po), ["POIL", "POINTIL", "POITRAIL", "PONTIL", "PORTAIL"]));

  const ppo = squelette(dawg, "P*O*IL");
  console.log(`  P*O*IL = ${mots(ppo).join(", ")}`);
  const attenduPPO = ["PARASOLEIL", "PASSEPOIL", "PROFIL", "POIL", "POINTIL", "POITRAIL", "PONTIL", "PORTAIL"];
  verifie("P*O*IL ajoute au moins PARASOLEIL, PASSEPOIL, PROFIL",
    ["PARASOLEIL", "PASSEPOIL", "PROFIL"].every((m) => mots(ppo).includes(m)));
  verifie("P*O*IL ne contient rien d'inattendu", mots(ppo).every((m) => attenduPPO.includes(m)),
    mots(ppo).filter((m) => !attenduPPO.includes(m)).join(", "));

  const man = squelette(dawg, "MAN.GER");
  console.log(`  MAN.GER = ${mots(man).join(", ")}`);
  verifie("MAN.GER = MANAGER, MANEGER", eg(mots(man), ["MANAGER", "MANEGER"]));
}

// --- Equivalences squelette <-> boutons ---
{
  const a = mots(rallongesAvant(dawg, "RAGE"));
  const b = mots(squelette(dawg, ".*RAGE"));
  verifie(".*MOT == rallongesAvant(MOT)", eg(a, b));

  const c = mots(rallongesArriere(dawg, "CHAT"));
  const d = mots(squelette(dawg, "CHAT.*"));
  verifie("MOT.* == rallongesArriere(MOT)", eg(c, d));

  const e = mots(benjamins(dawg, "RAGE"));
  const f = mots(squelette(dawg, "...RAGE"));
  verifie("...MOT == benjamins(MOT)", eg(e, f));

  const g = mots(superBenjamins(dawg, "TOLES"));
  const h = mots(squelette(dawg, ".*TOLES.*"));
  verifie(".*MOT.* == superBenjamins(MOT)", eg(g, h));
}

// --- Mots formables et Solutions, jokers compris ---
{
  const r = motsFormables(dawg, "AABEFRST??");
  console.log(`  motsFormables(AABEFRST??) : ${r.resultats.length} mots, ${r.stats.ms.toFixed(1)} ms, `
    + `${r.stats.operations} operations`);
  verifie("motsFormables(AABEFRST??) trouve des mots de toutes tailles jusqu'a 10",
    r.resultats.some((c) => c.mot.length === 10));
  const dix = r.resultats.filter((c) => c.mot.length === 10);
  for (const c of dix) {
    const codeJokers = c.jokers.map((i) => c.mot[i]).sort().join("");
    console.log(`    ${codeJokers.padEnd(4)} ${c.mot}`);
  }

  const s = solutions(dawg, "AABEFRST??");
  verifie("solutions(AABEFRST??) = les mots de 10 lettres de motsFormables",
    eg(mots(s), dix.map((c) => c.mot).sort()));
}

// --- Mode de saisie : longueur et nombre de jokers plafonnes ---
verifie("analyserSaisie(RAGE) = tirage", analyserSaisie("RAGE") === "tirage");
verifie("analyserSaisie(RA?E) = tirage", analyserSaisie("RA?E") === "tirage");
verifie("analyserSaisie(*RAGE) = squelette", analyserSaisie("*RAGE") === "squelette");
verifie("analyserSaisie(RA?E*) = invalide (joker + squelette)", analyserSaisie("RA?E*") === "invalide");
verifie("analyserSaisie(vide) = vide", analyserSaisie("") === "vide");
verifie("analyserSaisie(minuscule) = invalide", analyserSaisie("rage") === "invalide");
verifie(`analyserSaisie(${LONGUEUR_MAX_SAISIE} lettres) = tirage`,
  analyserSaisie("A".repeat(LONGUEUR_MAX_SAISIE)) === "tirage");
verifie(`analyserSaisie(${LONGUEUR_MAX_SAISIE + 1} lettres) = invalide (trop long)`,
  analyserSaisie("A".repeat(LONGUEUR_MAX_SAISIE + 1)) === "invalide");
verifie(`analyserSaisie(${JOKERS_MAX} jokers) = tirage`,
  analyserSaisie("?".repeat(JOKERS_MAX)) === "tirage");
verifie(`analyserSaisie(${JOKERS_MAX + 1} jokers) = invalide (trop de jokers)`,
  analyserSaisie("?".repeat(JOKERS_MAX + 1)) === "invalide");

console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
