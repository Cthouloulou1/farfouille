/**
 * Les heures de Paris, les noms et les modeles des parties d'epreuve.
 * Voir SPEC.md §29.
 *
 *     node packages/engine/test/check_epreuves.ts
 */
import {
  heureDeParis, instantDeParis, jourDe, modeleRecevable, nomDeLaPartie, tirerUnModele,
} from "../src/epreuves.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(58)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nLes epreuves\n");
verifie("18 h a Paris en ete, c'est 16 h universelle",
  instantDeParis("2026-09-20T18:00") === Date.parse("2026-09-20T16:00:00Z"));
verifie("18 h a Paris en hiver, c'est 17 h universelle",
  instantDeParis("2026-12-20T18:00") === Date.parse("2026-12-20T17:00:00Z"));
verifie("l'aller-retour tombe juste", heureDeParis(instantDeParis("2026-03-29T12:15")!) === "2026-03-29T12:15");
verifie("une heure mal ecrite est refusee", instantDeParis("20/09/2026 18h") === null);
verifie("le jour de 5 h 30 a Paris", jourDe(instantDeParis("2026-09-20T05:30")!) === "2026-09-20"
  && jourDe(instantDeParis("2026-09-20T05:29")!) === "2026-09-19");
verifie("les noms separent chaque morceau par une virgule",
  nomDeLaPartie({ tirage: 7, jouables: 7, joker: false, bornes: 10, chrono: 60 }) === "Normale, super grille, 60s"
  && nomDeLaPartie({ tirage: 8, jouables: 7, joker: true, jokersParCoup: 2, bornes: 7, chrono: 90 })
    === "7/8 double joker, 1min30");
let tous = true;
for (let i = 0; i < 200; i++) if (typeof modeleRecevable(tirerUnModele()) === "string") tous = false;
verifie("la pool ne tire que des modeles recevables", tous);
verifie("un modele faux dit pourquoi",
  modeleRecevable({ bornes: 7, tirage: 7, jouables: 9, joker: false, chrono: 60 }) === "on pose de 2 lettres au plus à tout le tirage"
  && modeleRecevable({ bornes: 12 }) === "grille inconnue");

console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
