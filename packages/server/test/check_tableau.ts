/**
 * Le double tableau d'un tournoi de battle : sa forme, son avancement, son
 * classement final. Voir SPEC.md §29.
 *
 *     node packages/server/test/check_tableau.ts
 *
 * TOUT SE PASSE DANS UN DOSSIER TEMPORAIRE.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arbitrerLaRencontre, classementFinalDuBattle, classementGeneralDesPoules,
  creerUnTournoiDeBattle, definirDossierDuCompetitif, finaleDuTournoi, inscrireAuTournoi,
  lancerLeTableau, lancerLesPoules, ouvrirLeCompetitif, phaseDuBattle, planifierLeTableau,
  poulesFinies, rencontreParId, rencontresDuTournoi, tableauDuTournoi, tournoi,
  butoirDeLaRencontre, dateImposeeDe, datesImposeesDe, limiteDeLaRencontre,
  reglerLaDateDeLaPhase, rencontreOuvrable,
  type Rencontre, type Tournoi,
} from "../src/competitif.ts";
import { configParDefaut } from "../../engine/src/config.ts";
import { modeleDeLaConfig } from "../../engine/src/epreuves.ts";

const dossier = mkdtempSync(join(tmpdir(), "tableau-"));
definirDossierDuCompetitif(dossier);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(62)} ${detail}`);
  if (!ok) echecs++;
}

const modele = modeleDeLaConfig(configParDefaut());

/** Un tournoi de battle avec ses inscrits, ses poules, et toutes leurs rencontres. */
function monter(noms: string[], parPoule: number, o: {
  qualifies: number | null; tableauHaut: number | null;
}): Tournoi {
  const t0 = creerUnTournoiDeBattle({
    nom: `Battle ${noms.length}`, lexique: "ods9", debut: Date.now() + 3_600_000, equipe: 1,
    battle: {
      joueursParPoule: parPoule, rencontresParPoule: null, manchesParPoule: 3,
      qualifies: o.qualifies, tableauHaut: o.tableauHaut,
      meilleurDe: 3, meilleurDeDemi: 5, meilleurDeFinale: 7,
      partie: modele, limitePoules: Date.now() + 7 * 86_400_000, joursParTour: 2,
    },
    par: "zulu",
  });
  for (const n of noms) inscrireAuTournoi(t0, n, "", []);
  const t = tournoi(t0.id)!;
  const poules: string[][] = [];
  for (let i = 0; i < noms.length; i += parPoule) poules.push(noms.slice(i, i + parPoule));
  lancerLesPoules(t, poules, "zulu");
  return tournoi(t.id)!;
}

/**
 * Tranche toutes les poules : le premier nomme gagne toujours. Le classement
 * suit donc l'ordre des noms, ce qui rend le tableau previsible.
 */
function trancherLesPoules(t: Tournoi, ordre: string[]): void {
  for (const r of rencontresDuTournoi(t.id)) {
    if (!r.phase.startsWith("poule:")) continue;
    const gagnant = ordre.indexOf(r.camps[0]) < ordre.indexOf(r.camps[1]) ? r.camps[0] : r.camps[1];
    arbitrerLaRencontre(r, { quoi: "victoire", qui: gagnant, par: "zulu" });
  }
}

/** Le plan d'un tableau, résumé en « phase×nombre ». */
const forme = (plan: { phase: string }[]): string => {
  const par = new Map<string, number>();
  for (const p of plan) par.set(p.phase, (par.get(p.phase) ?? 0) + 1);
  return [...par.entries()].map(([k, n]) => `${k}=${n}`).join(" ");
};

// ------------------------------------------- huit qualifiés, quatre en haut

const huit = ["a", "b", "c", "d", "e", "f", "g", "h"];
const t8 = monter(huit, 4, { qualifies: 8, tableauHaut: 4 });
verifie("les poules ne sont pas finies au depart", !poulesFinies(t8));
trancherLesPoules(t8, huit);
verifie("les poules sont finies", poulesFinies(tournoi(t8.id)!));

const general = classementGeneralDesPoules(tournoi(t8.id)!);
verifie("le classement general prend les premiers d'abord",
  general.slice(0, 2).every((l) => l.rang === 1), general.map((l) => l.camp).join(","));

const vu = planifierLeTableau(tournoi(t8.id)!);
if (typeof vu === "string") {
  verifie("le plan se calcule", false, vu);
} else {
  verifie("quatre en haut, quatre en bas", vu.haut.length === 4 && vu.bas.length === 4);
  // QUATRE EN HAUT : deux tours. QUATRE EN BAS : un tour majeur, un mineur,
  // un majeur, un mineur. Puis la grande finale.
  verifie("le tableau a dix rencontres", vu.plan.length === 10, forme(vu.plan));
  verifie("le tableau haut a deux tours",
    vu.plan.filter((p) => p.phase === "haut:1").length === 2
    && vu.plan.filter((p) => p.phase === "haut:2").length === 1);
  verifie("le tableau bas a quatre tours",
    ["bas:1", "bas:2", "bas:3", "bas:4"].map((f) => vu.plan.filter((p) => p.phase === f).length)
      .join(",") === "2,2,1,1");
  verifie("il y a une grande finale", vu.plan.filter((p) => p.phase === "finale").length === 1);
  // LE MEILLEUR DE X PAR PHASE : la derniere rencontre de chaque tableau est
  // une demi-finale, et la grande finale a le sien.
  verifie("les demi-finales se jouent au meilleur de 5",
    vu.plan.filter((p) => p.phase === "haut:2" || p.phase === "bas:4").every((p) => p.bo === 5));
  verifie("la grande finale se joue au meilleur de 7",
    vu.plan.find((p) => p.phase === "finale")?.bo === 7);
  verifie("les autres se jouent au meilleur de 3",
    vu.plan.filter((p) => p.phase === "haut:1" || p.phase === "bas:1").every((p) => p.bo === 3));
  // LES DATES SUIVENT LA PROFONDEUR : un tour qui attend deux resultats vient
  // apres celui qui n'en attend qu'un.
  verifie("un tour plus profond a une limite plus lointaine",
    (vu.plan.find((p) => p.phase === "finale")?.ordre ?? 0)
    > (vu.plan.find((p) => p.phase === "haut:1")?.ordre ?? 99));
}

verifie("le tableau se lance", lancerLeTableau(tournoi(t8.id)!, "zulu") === null);
verifie("on ne le lance pas deux fois",
  lancerLeTableau(tournoi(t8.id)!, "zulu") !== null);
verifie("la phase est au tableau", phaseDuBattle(tournoi(t8.id)!) === "tableau");
verifie("le tableau garde qui est entre par ou",
  tableauDuTournoi(t8.id)?.haut.length === 4 && tableauDuTournoi(t8.id)?.bas.length === 4);

const duTableau = (): Rencontre[] =>
  rencontresDuTournoi(t8.id).filter((r) => !r.phase.startsWith("poule:"));
verifie("le premier tour du haut est deja rempli",
  duTableau().filter((r) => r.phase === "haut:1").every((r) => r.camps.every((c) => c !== "")));
verifie("le second tour attend ses vainqueurs",
  duTableau().filter((r) => r.phase === "haut:2").every((r) => r.camps.every((c) => c === "")));

// --- on joue le tableau entier : le mieux classe gagne toujours
const rang = (c: string) => huit.indexOf(c);
let tours = 0;
while (finaleDuTournoi(tournoi(t8.id)!)?.fin === null && tours < 40) {
  tours++;
  const prete = duTableau().find((r) => r.fin === null && r.camps.every((c) => c !== ""));
  if (prete === undefined) break;
  const gagnant = rang(prete.camps[0]) < rang(prete.camps[1]) ? prete.camps[0] : prete.camps[1];
  arbitrerLaRencontre(prete, { quoi: "victoire", qui: gagnant, par: "zulu" });
}
verifie("tout le tableau se joue", duTableau().every((r) => r.fin !== null), `${tours} tours`);
verifie("la phase est finie", phaseDuBattle(tournoi(t8.id)!) === "fini");

const final = classementFinalDuBattle(tournoi(t8.id)!);
verifie("le classement final nomme tout le monde", final.length === 8,
  final.map((x) => `${x.place}.${x.camp}`).join(" "));
verifie("le mieux classe gagne", final[0]?.camp === "a");
// LE BRONZE VA AU PERDANT DE LA FINALE DU TABLEAU BAS : il n'y a pas de petite
// finale (SPEC.md §29).
const bas = duTableau().filter((r) => r.phase.startsWith("bas:"));
const dernierBas = Math.max(...bas.map((r) => r.tour));
const finaleBasse = bas.find((r) => r.tour === dernierBas)!;
const perdantBas = finaleBasse.camps[0] === finaleBasse.fin!.gagnant
  ? finaleBasse.camps[1] : finaleBasse.camps[0];
verifie("le bronze est le perdant de la finale du tableau bas",
  final[2]?.camp === perdantBas, `${final[2]?.camp} / ${perdantBas}`);

// --- tout se relit au journal
const avant = JSON.stringify(classementFinalDuBattle(tournoi(t8.id)!));
ouvrirLeCompetitif();
verifie("le tableau se relit au journal",
  duTableau().length === 10 && duTableau().every((r) => r.sources !== undefined));
verifie("le classement final est le meme apres relecture",
  JSON.stringify(classementFinalDuBattle(tournoi(t8.id)!)) === avant);

// -------------------------------------------- personne ne gagne : un exempt

const six = ["p1", "p2", "p3", "p4", "p5", "p6"];
const t6 = monter(six, 3, { qualifies: 4, tableauHaut: 4 });
trancherLesPoules(tournoi(t6.id)!, six);
const vu6 = planifierLeTableau(tournoi(t6.id)!);
verifie("quatre qualifies, tous en haut",
  typeof vu6 !== "string" && vu6.haut.length === 4 && vu6.bas.length === 0);
// PERSONNE N'ENTRE DIRECTEMENT EN BAS, mais le tableau bas existe quand meme :
// il recueille ceux qui tombent d'en haut. Quatre joueurs font six rencontres.
verifie("quatre joueurs font six rencontres",
  typeof vu6 !== "string" && vu6.plan.length === 6,
  typeof vu6 === "string" ? vu6 : forme(vu6.plan));
lancerLeTableau(tournoi(t6.id)!, "zulu");
const t6Tableau = () => rencontresDuTournoi(t6.id).filter((r) => !r.phase.startsWith("poule:"));
verifie("la grande finale existe", finaleDuTournoi(tournoi(t6.id)!)?.phase === "finale");

// LE PREMIER TOUR DU HAUT : personne ne gagne l'une des deux rencontres. Son
// vainqueur n'existera jamais, et l'autre demi-finaliste passe tout seul.
const premiers = t6Tableau().filter((r) => r.phase === "haut:1");
arbitrerLaRencontre(premiers[0]!, { quoi: "personne", par: "zulu" });
arbitrerLaRencontre(premiers[1]!, { quoi: "victoire", qui: premiers[1]!.camps[0], par: "zulu" });
const haut2 = rencontreParId(t6Tableau().find((r) => r.phase === "haut:2")!.id)!;
verifie("le camp d'en face passe sans jouer",
  haut2.fin?.par === "exempt" && haut2.fin.gagnant === premiers[1]!.camps[0],
  JSON.stringify({ camps: haut2.camps, fin: haut2.fin }));

// ------------------------------------------ les heures imposees par phase

const finale6 = rencontreParId(finaleDuTournoi(tournoi(t6.id)!)!.id)!;
const libreLimite = finale6.limite;
const QUAND = Date.now() + 3 * 86_400_000;
verifie("une phase se cloue a une heure",
  reglerLaDateDeLaPhase(tournoi(t6.id)!, "finale", QUAND, "zulu") === null
  && dateImposeeDe(t6.id, "finale") === QUAND);
verifie("une phase qui n'existe pas se refuse",
  reglerLaDateDeLaPhase(tournoi(t6.id)!, "haut:9", QUAND, "zulu") !== null);
verifie("l'heure imposee remplace la limite du tour",
  limiteDeLaRencontre(rencontreParId(finale6.id)!) === QUAND
  && libreLimite !== QUAND);
// LE DELAI D'UN TOUR RESTE APRES L'HEURE : rien ne se declenche tout seul
// quand quelqu'un manque, et l'arbitrage a besoin d'une fenetre.
verifie("la butoir suit l'heure imposee d'un tour",
  butoirDeLaRencontre(rencontreParId(finale6.id)!) === QUAND + 2 * 86_400_000);
verifie("on n'ouvre pas la rencontre avant l'heure",
  rencontreOuvrable(rencontreParId(finale6.id)!, QUAND - 60_000) !== null);
verifie("on l'ouvre a l'heure",
  rencontreOuvrable(rencontreParId(finale6.id)!, QUAND + 1) === null);
verifie("les autres phases restent libres", dateImposeeDe(t6.id, "haut:1") === undefined);
verifie("la liste des heures ne porte que celle-la",
  JSON.stringify(datesImposeesDe(t6.id)) === JSON.stringify({ finale: QUAND }));

ouvrirLeCompetitif();
verifie("l'heure imposee se relit au journal", dateImposeeDe(t6.id, "finale") === QUAND);

verifie("on libere une phase",
  reglerLaDateDeLaPhase(tournoi(t6.id)!, "finale", null, "zulu") === null
  && dateImposeeDe(t6.id, "finale") === undefined);
verifie("la rencontre retrouve ses dates",
  limiteDeLaRencontre(rencontreParId(finale6.id)!) === libreLimite
  && rencontreOuvrable(rencontreParId(finale6.id)!, Date.now()) === null);

rmSync(dossier, { recursive: true, force: true });
console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
