/**
 * Les tournois de battle : les poules, les rencontres, le classement.
 * Voir SPEC.md §29.
 *
 *     node packages/server/test/check_battle.ts
 *
 * TOUT SE PASSE DANS UN DOSSIER TEMPORAIRE. Le vrai journal du compétitif n'est
 * ni lu, ni déplacé, ni touché.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annulerLaMancheDeRencontre, arbitrerLaRencontre, campDuCompte, classementDeLaPoule,
  creerUnTournoiDeBattle, declarerUnForfait, definirDossierDuCompetitif, desinscrireDuTournoi,
  disposDe, ecrireUnMessageDeRencontre, enteteDuTournoi, finirUneMancheDeRencontre,
  inscrireAuTournoi, joueursDuCamp, lancerLesPoules, messagesDeLaRencontre,
  ouvrirLeCompetitif, ouvrirUneMancheDeRencontre, phaseDuBattle, poulesDuTournoi,
  reglerLEntete, reglerLesDispos, rencontreDuSalon, rencontreParId, rencontresDuTournoi,
  rondesDeLaPoule, tirerDesPoules, tournoi, tournoiModifiable,
  type Rencontre,
} from "../src/competitif.ts";
import { configParDefaut } from "../../engine/src/config.ts";
import { modeleDeLaConfig } from "../../engine/src/epreuves.ts";
import type { PlayedMove } from "../src/game.ts";

const dossier = mkdtempSync(join(tmpdir(), "battle-"));
definirDossierDuCompetitif(dossier);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(62)} ${detail}`);
  if (!ok) echecs++;
}

/** Un coup factice : seul `player` compte pour les points d'une manche. */
function coup(n: number, player: string | null): PlayedMove {
  return {
    n, rack: "ABCDEFG", notation: "ABCDEFG", word: "MOT", dir: "H", x: 0, y: 0, score: 20,
    placements: [{ x: 0, y: 0, letter: "A", blank: false }],
    player, ms: 1000, isotops: 1,
  } as unknown as PlayedMove;
}

// ------------------------------------------------------------ les rondes

const rondes4 = rondesDeLaPoule(["a", "b", "c", "d"]);
verifie("quatre joueurs font trois rondes de deux rencontres",
  rondes4.length === 3 && rondes4.every((r) => r.length === 2));
const paires4 = new Set(rondes4.flat().map(([x, y]) => [x, y].sort().join("-")));
verifie("chacun rencontre tous les autres, une fois", paires4.size === 6);

const rondes5 = rondesDeLaPoule(["a", "b", "c", "d", "e"]);
verifie("cinq joueurs font cinq rondes de deux rencontres",
  rondes5.length === 5 && rondes5.every((r) => r.length === 2));
const paires5 = new Set(rondes5.flat().map(([x, y]) => [x, y].sort().join("-")));
verifie("un effectif impair laisse un exempt par ronde", paires5.size === 10);

// ------------------------------------------------------------ le tirage

const onze = ["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8", "j9", "j10", "j11"];
const tirees = tirerDesPoules(onze, 4);
verifie("onze joueurs par poules de quatre donnent trois poules", tirees.length === 3);
verifie("les poules sont aussi egales que possible",
  tirees.map((p) => p.length).sort().join(",") === "3,4,4");
verifie("chacun est place une fois et une seule",
  new Set(tirees.flat()).size === 11 && tirees.flat().length === 11);

// ----------------------------------------------------- un tournoi entier

const modele = modeleDeLaConfig(configParDefaut());
const t0 = creerUnTournoiDeBattle({
  nom: "Le battle d'essai", lexique: "ods9", debut: Date.now() + 3_600_000, equipe: 1,
  battle: {
    joueursParPoule: 4, rencontresParPoule: null, manchesParPoule: 3,
    qualifies: null, tableauHaut: null, meilleurDe: 3, meilleurDeDemi: 3, meilleurDeFinale: 3,
    partie: modele, limitePoules: Date.now() + 7 * 86_400_000, joursParTour: 3,
  },
  par: "zulu",
});
for (const nom of ["ana", "bob", "cleo", "dan"]) inscrireAuTournoi(t0, nom, "", []);
verifie("quatre inscrits", tournoi(t0.id)?.inscrits.length === 4);
verifie("avant les poules, la phase est aux inscriptions",
  phaseDuBattle(tournoi(t0.id)!) === "inscriptions");

// --- on se desinscrit tant que les poules ne sont pas tirees
inscrireAuTournoi(tournoi(t0.id)!, "eve", "", []);
verifie("cinq inscrits", tournoi(t0.id)?.inscrits.length === 5);
verifie("on se desinscrit avant les poules",
  desinscrireDuTournoi(tournoi(t0.id)!, "eve") === null
  && tournoi(t0.id)?.inscrits.length === 4);

// --- l'en-tete et les disponibilites
reglerLEntete(t0.id, "Rendez-vous le samedi.", "zulu");
reglerLesDispos(t0.id, "ana", "Le soir, après 20 h.");
verifie("l'en-tete se garde", enteteDuTournoi(t0.id) === "Rendez-vous le samedi.");
verifie("les disponibilites se gardent", disposDe(t0.id, "ana") === "Le soir, après 20 h.");

// --- les poules
const t = tournoi(t0.id)!;
verifie("un battle se regle encore apres son debut",
  tournoiModifiable({ ...t, debut: Date.now() - 1000 }, "zulu", false) === null);
const nees = lancerLesPoules(t, [["ana", "bob", "cleo", "dan"]], "zulu");
verifie("une poule de quatre fait six rencontres", nees.length === 6);
verifie("les poules se relisent", poulesDuTournoi(t.id)?.[0]?.length === 4);
verifie("apres les poules, la phase est aux poules", phaseDuBattle(tournoi(t.id)!) === "poules");
verifie("les poules tirees ferment les reglages",
  tournoiModifiable(tournoi(t.id)!, "zulu", false) !== null);
verifie("on ne se desinscrit plus", desinscrireDuTournoi(tournoi(t.id)!, "ana") !== null);
verifie("chaque rencontre porte trois manches a jouer", nees.every((r) => r.bo === 3));
verifie("les deux dates sont celles de la poule",
  nees.every((r) => r.butoir === r.limite + 3 * 86_400_000));

// --- les camps
const ab = rencontresDuTournoi(t.id).find((r) =>
  r.camps.includes("ana") && r.camps.includes("bob"))!;
verifie("ana et bob se rencontrent", ab !== undefined);
verifie("le camp d'un compte se retrouve",
  campDuCompte(t, ab, "ana") >= 0 && campDuCompte(t, ab, "cleo") === -1);
verifie("un camp d'un seul joueur n'a qu'un pseudo",
  joueursDuCamp(t, "ana").join(",") === "ana");

// --- une manche : le premier qui trouve marque 1, personne donne 1/2 chacun
ouvrirUneMancheDeRencontre(ab, "salon-ab-1");
verifie("le salon mene a sa rencontre",
  rencontreDuSalon("salon-ab-1")?.rencontre.id === ab.id
  && rencontreDuSalon("salon-ab-1")?.n === 1);
finirUneMancheDeRencontre(t, ab, 1, [
  coup(1, "ana"), coup(2, "ana"), coup(3, "bob"), coup(4, null),
]);
const m1 = rencontreParId(ab.id)!.manches[0]!;
const iAna = ab.camps[0] === "ana" ? 0 : 1;
verifie("le premier qui trouve marque un point",
  m1.points !== null && m1.points[iAna] === 2.5 && m1.points[1 - iAna] === 1.5);
verifie("le total des deux fait le nombre de coups",
  m1.points !== null && m1.points[0]! + m1.points[1]! === 4);
verifie("ana gagne la manche", m1.gagnant === "ana");
verifie("la rencontre n'est pas finie a la premiere manche",
  rencontreParId(ab.id)?.fin === null);

// --- une manche abandonnee ne compte pas
ouvrirUneMancheDeRencontre(rencontreParId(ab.id)!, "salon-ab-2");
annulerLaMancheDeRencontre(rencontreParId(ab.id)!, 2);
verifie("une manche annulee n'a pas de points",
  rencontreParId(ab.id)!.manches[1]!.fin !== null
  && rencontreParId(ab.id)!.manches[1]!.points === null);

// --- deux manches de plus : ana l'emporte 2-1 et la rencontre se clot
ouvrirUneMancheDeRencontre(rencontreParId(ab.id)!, "salon-ab-3");
finirUneMancheDeRencontre(t, rencontreParId(ab.id)!, 3, [coup(1, "bob"), coup(2, "bob")]);
ouvrirUneMancheDeRencontre(rencontreParId(ab.id)!, "salon-ab-4");
finirUneMancheDeRencontre(t, rencontreParId(ab.id)!, 4, [coup(1, "ana"), coup(2, "ana")]);
verifie("la poule joue toutes ses manches avant de conclure",
  rencontreParId(ab.id)?.fin?.gagnant === "ana"
  && rencontreParId(ab.id)?.fin?.par === "jeu");

// --- le classement
let classement = classementDeLaPoule(tournoi(t.id)!, 0);
const ligneAna = classement.find((l) => l.camp === "ana")!;
verifie("une victoire vaut trois points", ligneAna.points === 3 && ligneAna.gagnees === 1);
verifie("les manches gagnees se comptent",
  ligneAna.manchesGagnees === 2 && ligneAna.manchesPerdues === 1);
verifie("les points de manche cumulent les 1 et les demis",
  ligneAna.pointsDeManche === 2.5 + 0 + 2);
const ligneBob = classement.find((l) => l.camp === "bob")!;
verifie("une defaite vaut un point, plus qu'une absence", ligneBob.points === 1);
verifie("ana passe devant bob", ligneAna.rang < ligneBob.rang);

// --- l'arbitrage
const cd = rencontresDuTournoi(t.id).find((r) =>
  r.camps.includes("cleo") && r.camps.includes("dan"))!;
ecrireUnMessageDeRencontre(cd, "cleo", "Mardi soir ?");
verifie("un message reste sur la rencontre",
  messagesDeLaRencontre(cd.id).length === 1 && messagesDeLaRencontre(cd.id)[0]!.de === "cleo");
verifie("un delai repousse la butoir",
  arbitrerLaRencontre(cd, { quoi: "delai", butoir: cd.butoir + 86_400_000, par: "zulu" }) === null
  && rencontreParId(cd.id)!.butoir > nees[0]!.butoir);
verifie("personne ne gagne une rencontre que personne n'a jouee",
  arbitrerLaRencontre(rencontreParId(cd.id)!, { quoi: "personne", par: "zulu" }) === null
  && rencontreParId(cd.id)?.fin?.gagnant === null
  && rencontreParId(cd.id)?.fin?.par === "arbitrage");
classement = classementDeLaPoule(tournoi(t.id)!, 0);
verifie("une rencontre non jouee ne rapporte rien",
  classement.find((l) => l.camp === "cleo")!.points === 0);

// --- le forfait
const avant = rencontresDuTournoi(t.id).filter((r) => r.fin === null && r.camps.includes("dan"));
verifie("dan a encore des rencontres", avant.length === 2);
verifie("un forfait perd tout ce qui reste",
  declarerUnForfait(tournoi(t.id)!, "dan", "zulu") === 2
  && rencontresDuTournoi(t.id).every((r: Rencontre) => !r.camps.includes("dan") || r.fin !== null));
verifie("l'adversaire d'un forfait gagne",
  avant.every((r) => rencontreParId(r.id)!.fin!.gagnant !== "dan"));

// --- tout se relit au journal
const avantRelecture = JSON.stringify(classementDeLaPoule(tournoi(t.id)!, 0));
ouvrirLeCompetitif();
verifie("les poules se relisent au journal",
  poulesDuTournoi(t.id)?.[0]?.join(",") === "ana,bob,cleo,dan");
verifie("les rencontres se relisent au journal", rencontresDuTournoi(t.id).length === 6);
verifie("le classement est le meme apres relecture",
  JSON.stringify(classementDeLaPoule(tournoi(t.id)!, 0)) === avantRelecture);
verifie("les messages se relisent au journal", messagesDeLaRencontre(cd.id).length === 1);
verifie("l'en-tete et les dispos se relisent",
  enteteDuTournoi(t.id) === "Rendez-vous le samedi." && disposDe(t.id, "ana") !== "");
verifie("la desinscription se relit", tournoi(t.id)?.inscrits.length === 4);

rmSync(dossier, { recursive: true, force: true });
console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
