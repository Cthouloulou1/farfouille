/**
 * Les categories de records reconnaissent une partie, et refusent les autres.
 * Voir SPEC.md §23.
 *
 *     node packages/engine/test/check_categories.ts
 *
 * C'est le garde-fou du tableau des records. Une seule condition oubliee, et
 * l'on compare une partie de vingt-deux coups a une partie de cinquante-cinq,
 * ou une partie aux primes bricolees a une partie du commerce.
 */
import {
  BORNES_NORMALE, BORNES_SUPER, CATEGORIES, categorieDesReglages,
  completeAuNegatif, estPartieNormale, grilleDeBornes, reglagesRecevables,
} from "../src/categories.ts";
import { avec, configParDefaut, primesParDefaut, type ConfigPartie } from "../src/config.ts";
import { setLayout, LAYOUTS } from "../src/bonus.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(56)} ${detail}`);
  if (!ok) echecs++;
}

setLayout("classique15");

/** La configuration exacte de la partie normale : 15x15, 7 sur 7, sac du commerce. */
function normale(): ConfigPartie {
  return avec(configParDefaut(), {
    bornes: BORNES_NORMALE, pavage: LAYOUTS.classique15, pavageNom: "classique15",
    tirage: 7, jouables: 7, joker: false, jokersParCoup: 1,
    pioche: "sac102", sacs: 1, mode: "topping",
    coupsMax: null, dureeMax: null, chrono: 60,
    primes: primesParDefaut(),
  });
}

console.log("\nLes categories de records\n");

// ------------------------------------------------------------- la table
console.log("  --- la table ---\n");
{
  const ids = CATEGORIES.map((c) => c.id);
  verifie("aucun identifiant en double", new Set(ids).size === ids.length,
    `${ids.length} categories`);
  const petites = CATEGORIES.filter((c) => c.taille === "petit");
  const normales = CATEGORIES.filter((c) => c.taille === "normal");
  const grandes = CATEGORIES.filter((c) => c.taille === "grand");
  verifie("dix petits formats, de 2 sur 2 a 6 sur 6 joker", petites.length === 10,
    petites.map((c) => c.id).join(" "));
  verifie("onze categories normales", normales.length === 11,
    normales.map((c) => c.id).join(" "));
  verifie("douze grands formats", grandes.length === 12, "de 10 sur 10 a 15 sur 15 joker");
  verifie("les trois tailles couvrent la table",
    petites.length + normales.length + grandes.length === CATEGORIES.length);
  verifie("seuls les grands formats se completent au negatif",
    CATEGORIES.every((c) => completeAuNegatif(c) === (c.taille === "grand")));
  verifie("la categorie reine vient en tete des normales",
    normales[0]!.id === "normale");
  verifie("le solo la suit", normales[1]!.id === "normale-solo"
    && normales[1]!.solo === true);
  verifie("le temps par coup vient ensuite",
    normales[2]!.id === "temps-par-coup" && normales[2]!.parCoup === true);
  verifie("la montante est marquee comme telle",
    normales[3]!.id === "montante" && normales[3]!.montante === true);
  verifie("les petits formats sont reconnus",
    categorieDesReglages(avec(normale(), { tirage: 2, jouables: 2 }))?.id === "2-2");
  // Les trois categories qui ne sont pas des formats -- solo, temps par coup,
  // montante -- lisent la partie normale autrement et n'ont pas de jumelle.
  const formats = CATEGORIES.filter((c) => !c.solo && !c.montante && !c.parCoup);
  verifie("chaque format a sa variante joker",
    formats.filter((c) => c.joker).length === formats.filter((c) => !c.joker).length,
    `${formats.length} formats`);
}

// ----------------------------------------------------------- les grilles
console.log("\n  --- les grilles ---\n");
{
  verifie("sept donne la grille normale", grilleDeBornes(BORNES_NORMALE) === "normale");
  verifie("dix donne la super grille", grilleDeBornes(BORNES_SUPER) === "super");
  verifie("une grille sans fin n'en est pas une", grilleDeBornes(null) === null);
  verifie("une grille d'une autre taille non plus", grilleDeBornes(12) === null);
}

// --------------------------------------------------- ce qui est reconnu
console.log("\n  --- ce qui est reconnu ---\n");
{
  const c = categorieDesReglages(normale());
  verifie("la partie normale est reconnue", c?.id === "normale", c?.nom ?? "rien");
  verifie("et c'est bien la partie normale", estPartieNormale(normale()));

  const joker = avec(normale(), { joker: true });
  verifie("la partie joker aussi", categorieDesReglages(joker)?.id === "joker");
  verifie("mais ce n'est plus la partie normale", !estPartieNormale(joker));

  verifie("le 7 sur 8", categorieDesReglages(avec(normale(), { tirage: 8 }))?.id === "7-8");
  verifie("le 7 et 8",
    categorieDesReglages(avec(normale(), { tirage: 8, jouables: 8 }))?.id === "8-8");
  verifie("le 15 sur 15 joker", categorieDesReglages(
    avec(normale(), { tirage: 15, jouables: 15, joker: true }))?.id === "15-15-joker");

  const superGrille = avec(normale(), {
    bornes: BORNES_SUPER, pavage: LAYOUTS.super21, pavageNom: "super21", sacs: 2,
  });
  verifie("la super grille porte les memes categories",
    categorieDesReglages(superGrille)?.id === "normale");
  verifie("mais elle n'abaisse pas le plancher du chrono",
    !estPartieNormale(superGrille));
}

// ---------------------------------------------------- ce qui est refuse
console.log("\n  --- ce qui est refuse ---\n");
{
  const refuse = (nom: string, modifs: Partial<ConfigPartie>): void => {
    const cfg = avec(normale(), modifs);
    verifie(nom, categorieDesReglages(cfg) === null && !reglagesRecevables(cfg));
  };
  refuse("la grille sans fin", { bornes: null });
  refuse("les probabilites ponderees", { pioche: "probabilites" });
  refuse("le sac qui se recharge", { pioche: "sac102boucle" });
  refuse("le duplicate", { mode: "duplicate" });
  refuse("un nombre de coups impose", { coupsMax: 20 });
  refuse("une duree imposee", { dureeMax: 600 });
  refuse("le double joker", { joker: true, jokersParCoup: 2 });
  refuse("un second sac sur la grille normale", { sacs: 2 });
  refuse("des primes bricolees", { primes: { 7: 100 } });
  refuse("une prime en trop", { primes: { ...primesParDefaut(), 6: 10 } });
  refuse("une prime en moins", (() => {
    const p = { ...primesParDefaut() };
    delete p[15];
    return { primes: p };
  })());
  // Un format que la table ne porte pas : les reglages sont recevables, mais
  // aucun tableau ne les accueille. « 6 sur 6 » en etait un avant que les
  // petits formats n'existent ; « 7 sur 9 » n'a jamais eu de tableau.
  const horsTable = avec(normale(), { tirage: 9, jouables: 7 });
  verifie("un format hors table n'a pas de categorie",
    reglagesRecevables(horsTable) && categorieDesReglages(horsTable) === null, "7 sur 9");
  verifie("mais le 6 sur 6 en a une, maintenant",
    categorieDesReglages(avec(normale(), { tirage: 6, jouables: 6 }))?.id === "6-6");
}

console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
