/**
 * La montante : ses six etapes, et ce qu'elles imposent. Voir SPEC.md §23.
 *
 *     node packages/engine/test/check_montante.ts
 *
 * DEUX CHOSES A TENIR, ET LA SECONDE EST LA PLUS FRAGILE.
 *
 * La table des six formats, d'abord : c'est la definition de la montante, et
 * une etape dans le mauvais ordre ferait une suite qui n'en est pas une.
 *
 * Puis, et surtout : CHAQUE ETAPE DOIT POUVOIR PORTER UN RECORD. Une montante
 * dont l'etape 4 tomberait hors categorie s'enregistrerait a moitie, sans que
 * rien ne le dise -- une partie hors categorie se joue normalement, elle
 * n'entre simplement pas au tableau. C'est le seul defaut de ce genre qui ne se
 * verrait qu'apres avoir joue six parties.
 */
import {
  ETAPES, ETAPES_MONTANTE, configDeLEtape, etapeMontante, montantePossible,
} from "../src/montante.ts";
import {
  BORNES_NORMALE, BORNES_SUPER, categorie, categorieDesReglages,
  completeAuNegatif, reglagesRecevables,
} from "../src/categories.ts";
import { avec, configParDefaut, primesParDefaut, type ConfigPartie } from "../src/config.ts";
import { setLayout, LAYOUTS } from "../src/bonus.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(56)} ${detail}`);
  if (!ok) echecs++;
}

setLayout("classique15");

/** Une 15x15 reglable : ce sur quoi une montante se lance. */
function base(bornes = BORNES_NORMALE): ConfigPartie {
  return avec(configParDefaut(), {
    bornes,
    pavage: bornes === BORNES_SUPER ? LAYOUTS.super21 : LAYOUTS.classique15,
    pavageNom: bornes === BORNES_SUPER ? "super21" : "classique15",
    sacs: bornes === BORNES_SUPER ? 2 : 1,
    pioche: "sac102", mode: "topping", chrono: 60,
    coupsMax: null, dureeMax: null, primes: primesParDefaut(),
  });
}

console.log("\nLa montante\n");

// -------------------------------------------------------------- la table
console.log("  --- les six etapes ---\n");

verifie("il y en a six", ETAPES.length === ETAPES_MONTANTE);
verifie("elles sont numerotees dans l'ordre",
  ETAPES.every((e, i) => e.rang === i + 1));

const attendues = [
  [7, 7, false], [7, 7, true], [7, 8, false], [7, 8, true], [8, 8, false], [8, 8, true],
] as const;
verifie("le format monte, puis le joker alterne",
  ETAPES.every((e, i) =>
    e.jouables === attendues[i]![0] && e.tirage === attendues[i]![1]
    && e.joker === attendues[i]![2]),
  ETAPES.map((e) => `${e.jouables}/${e.tirage}${e.joker ? "j" : ""}`).join(" "));

// LES NOMS SONT CEUX DU SITE. « 7 et 8 » et non « 8 sur 8 » : c'est ainsi que le
// panneau de reglages et l'onglet des records l'appellent.
verifie("chaque etape porte le nom de sa categorie",
  ETAPES.every((e) => {
    const c = categorieDesReglages(configDeLEtape(base(), e.rang));
    return c !== null && c.nom === e.nom;
  }),
  ETAPES.map((e) => e.nom).join(", "));

verifie("un rang hors bornes est ramene dedans",
  etapeMontante(0).rang === 1 && etapeMontante(7).rang === 6
  && etapeMontante(-3).rang === 1);

// ------------------------------------------------ chaque etape est un record
console.log("\n  --- chaque etape peut porter un record ---\n");

for (const grille of [BORNES_NORMALE, BORNES_SUPER]) {
  const nom = grille === BORNES_SUPER ? "super grille" : "15x15";
  for (const e of ETAPES) {
    const cfg = configDeLEtape(base(grille), e.rang);
    const c = categorieDesReglages(cfg);
    verifie(`${nom}, etape ${e.rang} : reglages recevables`, reglagesRecevables(cfg));
    verifie(`${nom}, etape ${e.rang} : une categorie`, c !== null,
      c === null ? "aucune" : c.id);
  }
}

// -------------------------------------------------- ce qui traverse la suite
console.log("\n  --- ce que la montante laisse au joueur ---\n");

const mienne = avec(base(), { chrono: 45, dictionnaire: "ods9" });
verifie("le chrono traverse les six etapes",
  ETAPES.every((e) => configDeLEtape(mienne, e.rang).chrono === 45));
verifie("le lexique traverse les six etapes",
  ETAPES.every((e) => configDeLEtape(mienne, e.rang).dictionnaire === "ods9"));
verifie("la grille traverse les six etapes",
  ETAPES.every((e) => configDeLEtape(mienne, e.rang).bornes === BORNES_NORMALE));

// -------------------------------------------------- ce qu'elle impose
console.log("\n  --- ce que la montante impose ---\n");

// Un salon peut jouer n'importe quoi avant de lancer une montante : des primes
// bricolees, un duplicate, un terme en nombre de coups, deux jokers par tirage.
// Rien de tout cela ne doit survivre au lancement.
const bricolee = avec(base(), {
  primes: { 7: 500, 8: 900 }, mode: "duplicate", coupsMax: 30, dureeMax: null,
  joker: true, jokersParCoup: 2, pioche: "probabilites", tirage: 15, jouables: 15,
});
for (const e of ETAPES) {
  const cfg = configDeLEtape(bricolee, e.rang);
  verifie(`etape ${e.rang} : la variante bricolee ne survit pas`,
    reglagesRecevables(cfg) && categorieDesReglages(cfg) !== null
    && cfg.mode === "topping" && cfg.coupsMax === null
    && cfg.jokersParCoup === 1 && cfg.pioche === "sac102"
    && cfg.primes[7] === primesParDefaut()[7]);
}

// ------------------------------------------------ le decompte n'est qu'au depart
console.log("\n  --- le decompte ne vaut que pour la premiere etape ---\n");

const avecDecompte = avec(base(), { decompte: true });
verifie("l'etape 1 recoit le decompte si l'hote l'a coche",
  configDeLEtape(avecDecompte, 1).decompte);
verifie("les cinq suivantes en sont privees",
  ETAPES.filter((e) => e.rang > 1)
    .every((e) => !configDeLEtape(avecDecompte, e.rang).decompte));

const sansDecompte = avec(base(), { decompte: false });
verifie("eteint chez l'hote, il reste eteint partout",
  ETAPES.every((e) => !configDeLEtape(sansDecompte, e.rang).decompte));

// ------------------------------------------------------- la grille sans fin
console.log("\n  --- la grille sans fin n'a pas de bout ---\n");

verifie("montante possible en 15x15", montantePossible(BORNES_NORMALE));
verifie("montante possible sur la super grille", montantePossible(BORNES_SUPER));
verifie("montante impossible sans bornes", !montantePossible(null));
verifie("montante impossible sur une grille de travers", !montantePossible(9));

// ------------------------------------------------------- son propre tableau
console.log("\n  --- son tableau ---\n");

const cat = categorie("montante");
verifie("la categorie existe et se dit montante", cat?.montante === true);
// « Qui ne recommence pas continue : la montante s'acheve, le rouge reste
// jusqu'au bout, et elle ne concourt qu'au negatif. » Sans cette ligne, une
// montante ratee n'irait nulle part.
verifie("son tableau se complete au negatif", completeAuNegatif(cat));

console.log(`\n${echecs === 0 ? "tout est vert" : `${echecs} echec(s)`}\n`);
process.exit(echecs === 0 ? 0 : 1);
