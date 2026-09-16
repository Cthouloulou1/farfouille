/**
 * Les heures de Paris, les noms et les modeles des parties d'epreuve.
 * Voir SPEC.md §29.
 *
 *     node packages/engine/test/check_epreuves.ts
 */
import {
  CHRONO_ALEA_MAX, CHRONO_ALEA_MIN, consigneExacte, consigneRecevable, debutDuJour, heureDeParis,
  instantDeParis, jourDe, jourDeLaSemaine, joursEntre, modeleRecevable, nomDeLaConsigne,
  nomDeLaPartie, primesDUsage, tirerUnModele, tirerUneConsigne, type ConsigneDePartie,
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


// ----------------------------------------------------------- les consignes
//
// UNE CONSIGNE TIREE MILLE FOIS reste un modele recevable : c'est tout ce que
// le reste du serveur attend d'elle (SPEC.md §29).
const toutAuHasard: ConsigneDePartie = {
  bornes: "alea", format: { t: "alea" }, egal: false, joker: "alea", chrono: "alea", primes: "alea",
};
let recevables = true, chronoHorsBornes = false, posablesTropNombreuses = false;
let primesQuiDecroissent = false;
for (let i = 0; i < 1000; i++) {
  const m = tirerUneConsigne(toutAuHasard);
  if (typeof modeleRecevable(m) === "string") recevables = false;
  if (m.chrono < CHRONO_ALEA_MIN || m.chrono > CHRONO_ALEA_MAX || m.chrono % 5 !== 0) chronoHorsBornes = true;
  if (m.jouables > m.tirage) posablesTropNombreuses = true;
  let avant = -1;
  for (let n = 2; n <= m.jouables; n++) {
    const v = m.primes?.[n] ?? 0;
    if (v !== 0 && v < avant) primesQuiDecroissent = true;
    if (v !== 0) avant = v;
  }
}
verifie("tout au hasard donne toujours un modele recevable", recevables);
verifie("le chrono tire va de 15 s a 3 min, par pas de 5", !chronoHorsBornes);
verifie("on ne pose jamais plus que le tirage", !posablesTropNombreuses);
verifie("des primes tirees au sort ne decroissent pas", !primesQuiDecroissent);

let toutesEgales = true;
for (let i = 0; i < 200; i++) {
  const m = tirerUneConsigne({ ...toutAuHasard, egal: true });
  if (m.tirage !== m.jouables) toutesEgales = false;
}
verifie("« égal » donne toujours un n sur n", toutesEgales);

let dansLaPlage = true;
for (let i = 0; i < 200; i++) {
  const m = tirerUneConsigne({
    bornes: 7, egal: false, joker: 0, chrono: 30, primes: null,
    format: { t: "plage", jouablesMin: 5, jouablesMax: 9, tirageMin: 10, tirageMax: 15 },
  });
  if (m.jouables < 5 || m.jouables > 9 || m.tirage < 10 || m.tirage > 15) dansLaPlage = false;
}
verifie("une plage ne sort pas de ses bornes", dansLaPlage);

const exacte = tirerUneConsigne(consigneExacte({ bornes: 10, tirage: 8, jouables: 7, joker: true, chrono: 90 }));
verifie("une consigne exacte rend son modele", exacte.bornes === 10 && exacte.tirage === 8
  && exacte.jouables === 7 && exacte.joker && exacte.chrono === 90);

verifie("des primes custom se lisent dans le nom",
  nomDeLaPartie({ tirage: 7, jouables: 7, joker: false, bornes: 7, chrono: 30, primes: { 5: 40, 7: 60 } })
    === "Normale, 30s, primes de farfouilles custom"
  && nomDeLaPartie({ tirage: 7, jouables: 7, joker: false, bornes: 7, chrono: 30, primes: primesDUsage(7) })
    === "Normale, 30s");

verifie("le nom d'une consigne dit ce qui est au hasard",
  nomDeLaConsigne(toutAuHasard)
    === "format au hasard, joker au hasard, grille au hasard, temps au hasard, primes au hasard",
  nomDeLaConsigne(toutAuHasard));

verifie("une consigne mal ecrite dit pourquoi",
  consigneRecevable({ ...toutAuHasard, bornes: 12 }) === "grille inconnue"
  && consigneRecevable({ ...toutAuHasard, chrono: 2 }) === "le temps par coup va de 5 secondes à une heure"
  && consigneRecevable({ ...toutAuHasard, format: { t: "plage", jouablesMin: 9, jouablesMax: 5, tirageMin: 7, tirageMax: 7 } })
    === "une plage commence par son plus petit nombre");
verifie("une consigne bien ecrite revient entiere",
  typeof consigneRecevable(toutAuHasard) === "object");

// -------------------------------------------------------------- la semaine
verifie("lundi est le premier jour", jourDeLaSemaine("2026-09-14") === 0
  && jourDeLaSemaine("2026-09-20") === 6);
verifie("du dimanche au dimanche dure un jour", joursEntre(6, 6) === 0);
verifie("du lundi au dimanche dure la semaine", joursEntre(0, 6) === 6);
verifie("un jour commence a 5 h 30 a Paris",
  debutDuJour("2026-09-20") === instantDeParis("2026-09-20T05:30"));

console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
