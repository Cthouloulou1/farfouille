/**
 * Le journal du compétitif : manches, bilans, classements. Voir SPEC.md §29.
 *
 *     node packages/server/test/check_competitif.ts
 *
 * TOUT SE PASSE DANS UN DOSSIER TEMPORAIRE. Le vrai journal du compétitif n'est
 * ni lu, ni deplace, ni touche : `definirDossierDuCompetitif` est appele avant
 * quoi que ce soit d'autre.
 */
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bilanDeLaManche, cumulDeLEpreuve, definirDossierDuCompetitif, epreuveDuJour, finirLaManche,
  mancheDuCompte, ouvrirLeCompetitif, ouvrirUneManche, resultatsDeLaPartie,
  creerUnTournoiDeTopping, epreuveDuTournoi, inscriptionDe, inscrireAuTournoi, tournoiDeLEpreuve,
  classementDesMedailles, listeDesSolos,
} from "../src/competitif.ts";
import type { PlayedMove } from "../src/game.ts";

const dossier = mkdtempSync(join(tmpdir(), "competitif-"));
definirDossierDuCompetitif(dossier);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(60)} ${detail}`);
  if (!ok) echecs++;
}

/** Un coup factice : le top, qui l'a trouve, et ce que chacun a propose. */
function coup(n: number, score: number, player: string | null, ms: number,
  props: Record<string, number>, poses = 3): PlayedMove {
  return {
    n, rack: "ABCDEFG", notation: "ABCDEFG", word: "MOT", dir: "H", x: 0, y: 0, score,
    placements: Array.from({ length: poses }, (_, i) => ({ x: i, y: 0, letter: "A", blank: false })),
    player, ms, isotops: 1,
    propositions: Object.fromEntries(Object.entries(props).map(([nom, sc]) =>
      [nom, { word: "MOT", dir: "H" as const, x: 0, y: 0, score: sc }])),
  };
}

console.log("\nLe compétitif\n");
ouvrirLeCompetitif();

/** Un jour de parties du jour, ecrit a la main : les tests ne figent rien. */
function inscrireUnJour(jour: string, lexique: string, parties: number): void {
  appendFileSync(join(dossier, "competitif.journal.jsonl"), JSON.stringify({
    t: "pdj", jour, lexique, at: Date.now(),
    parties: Array.from({ length: parties }, (_, i) => ({
      n: i + 1, figee: `figee-${jour}-${lexique}-${i + 1}`,
      config: { tirage: 7, jouables: 7, bornes: 7, joker: false, jokersParCoup: 1, chrono: 30 },
    })),
  }) + "\n");
  ouvrirLeCompetitif();
}

// ------------------------------------------------------------------ bilans
const coups = [
  coup(1, 40, "ana", 2000, { ana: 40 }),
  coup(2, 90, null, 30000, { ana: 60 }, 7),
  coup(3, 25, null, 30000, {}),
];
const b = bilanDeLaManche({ equipe: ["ana"] }, coups, 7);
verifie("le temps compte le chrono plein des coups rates", b.temps === 62000, `${b.temps} ms`);
verifie("le score additionne les meilleures solutions", b.score === 100, String(b.score));
verifie("le negatif compte aussi le coup sans solution", b.negatif === 55, String(b.negatif));
verifie("une farfouille se reconnait", b.coups[1]!.farfouille && !b.coups[0]!.farfouille);

const equipe = bilanDeLaManche({ equipe: ["ana", "bob"] }, [
  coup(1, 90, null, 30000, { ana: 50, bob: 70 }),
  coup(2, 40, "bob", 5000, { bob: 40, ana: 12 }),
], 7);
verifie("une equipe garde la meilleure solution de ses membres",
  equipe.score === 110 && equipe.negatif === 20 && equipe.coups[1]!.trouve);

// ------------------------------------------------------------------ manches
const jour = "2026-09-15";
const ep = epreuveDuJour(jour, "ods9");
const m1 = ouvrirUneManche({ epreuve: ep, partie: 1, salon: "s1", compte: "ana", jeu: "seul", noms: "", equipe: [] });
verifie("une manche ouverte consomme la tentative", mancheDuCompte("ana", ep, 1)?.id === m1.id);
finirLaManche(m1.id, coups, 7);
const m2 = ouvrirUneManche({
  epreuve: ep, partie: 1, salon: "s2", compte: "bob", jeu: "equipe", noms: "", equipe: ["bob", "cy"],
});
verifie("en equipe, la tentative de chaque membre part", mancheDuCompte("cy", ep, 1)?.id === m2.id);
finirLaManche(m2.id, [coup(1, 40, "cy", 1500, { cy: 40 }), coup(2, 90, "bob", 9000, { bob: 90 }),
  coup(3, 25, "cy", 800, { cy: 25 })], 7);
verifie("une manche close ne se reclot pas", finirLaManche(m1.id, [], 7) === null);

const avant = resultatsDeLaPartie(ep, 1, "dan");
verifie("les lignes partent a qui n'a pas joue", avant.lignes.length === 2);
verifie("le detail des coups, non", avant.details === null);
const apres = resultatsDeLaPartie(ep, 1, "ana");
verifie("le detail part a qui a fini", apres.details !== null && apres.moi.fini
  && apres.details[m1.id]!.length === 3);

// Une manche en cours ne se classe pas.
ouvrirUneManche({ epreuve: ep, partie: 2, salon: "s3", compte: "ana", jeu: "seul", noms: "", equipe: [] });
const cumul = cumulDeLEpreuve(ep, "ana");
verifie("le cumul additionne par joueur ou par equipe", cumul.lignes.length === 2
  && cumul.lignes.find((l) => l.compte === "ana")!.temps === 62000);
verifie("ses propres parties, en cours comprise", cumul.moi.length === 2
  && cumul.moi.some((p) => p.partie === 2 && !p.fini));

// Tout se relit au journal.
ouvrirLeCompetitif();
verifie("le journal se relit a l'identique", resultatsDeLaPartie(ep, 1, "ana").lignes.length === 2
  && mancheDuCompte("cy", ep, 1)?.fin?.temps === 11300);

// UNE MANCHE CLOSE APRES LA FERMETURE EST TEINTEE, et non retiree.
const tard = ouvrirUneManche({ epreuve: ep, partie: 3, salon: "s4", compte: "ana", jeu: "seul", noms: "", equipe: [] });
mkdirSync(dossier, { recursive: true });
appendFileSync(join(dossier, "competitif.journal.jsonl"), JSON.stringify({
  t: "fin", manche: tard.id, at: Date.parse("2026-09-16T08:00:00Z"), temps: 1, negatif: 0, score: 0, coups: [],
}) + "\n");
ouvrirLeCompetitif();
const lignesTard = resultatsDeLaPartie(ep, 3, null).lignes;
verifie("jouee apres 5 h 29 le lendemain, elle est au classement mais pas a temps",
  lignesTard.length === 1 && lignesTard[0]!.aTemps === false);
verifie("jouee le jour meme, elle est a temps",
  resultatsDeLaPartie(ep, 1, null).lignes.every((l) => l.aTemps));

// ---------------------------------------------------------------- tournois
const heure = Date.now();
const t = await creerUnTournoiDeTopping({
  nom: "Essai", lexique: "ods9", debut: heure - 1000, fin: heure + 3_600_000, equipe: 2,
  modeles: [{ bornes: 7, tirage: 7, jouables: 7, joker: false, chrono: 30 },
    { bornes: 7, tirage: 8, jouables: 7, joker: false, chrono: 60 }],
  par: "admin",
}, "pave1");
verifie("un tournoi de topping fige ses parties avant d'exister", t.parties.length === 2
  && t.parties[1]!.config.tirage === 8);
verifie("on s'inscrit avec un partenaire", inscrireAuTournoi(t, "ana", "", ["bob"]) === null
  && inscriptionDe(t, "bob")?.compte === "ana");
verifie("un partenaire deja inscrit ne se reinscrit pas", inscrireAuTournoi(t, "bob", "", []) === "bob est déjà inscrit");
verifie("une equipe ne depasse pas sa taille", inscrireAuTournoi(t, "cy", "", ["dan", "eve"]) === "Une équipe compte 2 joueurs au plus");
const ept = epreuveDuTournoi(t.id);
const mt = ouvrirUneManche({ epreuve: ept, partie: 1, salon: "t1", compte: "ana", jeu: "equipe", noms: "", equipe: ["ana", "bob"] });
finirLaManche(mt.id, coups, 7);
verifie("dans un tournoi, les lignes d'une partie se cachent a qui ne l'a pas jouee",
  resultatsDeLaPartie(ept, 1, "cy").cache && resultatsDeLaPartie(ept, 1, "cy").lignes.length === 0);
verifie("et se montrent a qui l'a jouee", !resultatsDeLaPartie(ept, 1, "bob").cache
  && resultatsDeLaPartie(ept, 1, "bob").lignes.length === 1);
verifie("le General reste cache tant qu'il manque une partie", cumulDeLEpreuve(ept, "ana").cache);
verifie("tout s'ouvre apres la fin", !resultatsDeLaPartie(ept, 1, "cy", heure + 7_200_000).cache
  && !cumulDeLEpreuve(ept, "cy", heure + 7_200_000).cache);
verifie("apres la fin, on ne s'inscrit plus",
  inscrireAuTournoi(t, "cy", "", [], heure + 7_200_000) === "Les inscriptions sont closes");
ouvrirLeCompetitif();
verifie("les tournois et les inscriptions se relisent au journal",
  tournoiDeLEpreuve(ept)?.inscrits.length === 1 && tournoiDeLEpreuve(ept)?.parties.length === 2);


// ----------------------------------------------------- medailles et solos
//
// Une journee close, douze joueurs : les trois premiers prennent un metal, et
// le coup qu'un seul a trouve devient un solo (SPEC.md §29).
const veille = "2026-09-14";
const epv = epreuveDuJour(veille, "ods9");
inscrireUnJour(veille, "ods9", 1);
for (let i = 0; i < 12; i++) {
  const nom = `j${i}`;
  const m = ouvrirUneManche({
    epreuve: epv, partie: 1, salon: `v${i}`, compte: nom, jeu: "seul", noms: "", equipe: [],
  });
  // Le coup 1 n'est trouve que par j0 : c'est le solo. Les temps s'echelonnent.
  finirLaManche(m.id, [
    coup(1, 40, i === 0 ? nom : null, 1000 + i * 100, { [nom]: i === 0 ? 40 : 10 }),
    coup(2, 30, nom, 2000 + i * 10, { [nom]: 30 }),
  ], 7, Date.parse("2026-09-14T20:00:00Z"));
}
const medailles = classementDesMedailles({ lexique: "ods9", maintenant: Date.parse("2026-09-15T12:00:00Z") });
verifie("les trois premiers prennent leur metal",
  medailles.length === 3 && medailles[0]!.compte === "j0" && medailles[0]!.or === 1
  && medailles[1]!.argent === 1 && medailles[2]!.bronze === 1,
  medailles.map((m) => `${m.compte}:${m.or}/${m.argent}/${m.bronze}`).join(" "));
const solos = listeDesSolos({ lexique: "ods9", maintenant: Date.parse("2026-09-15T12:00:00Z") });
verifie("le coup qu'un seul a trouve est un solo", solos.length === 1
  && solos[0]!.equipe[0] === "j0" && solos[0]!.coup === 1 && solos[0]!.joueurs === 12);
verifie("une journee en cours ne distribue rien",
  classementDesMedailles({ lexique: "ods9", maintenant: Date.parse("2026-09-14T12:00:00Z") }).length === 0);
verifie("la periode filtre les jours",
  classementDesMedailles({ lexique: "ods9", depuis: "2026-09-15",
    maintenant: Date.parse("2026-09-16T12:00:00Z") }).length === 0);

// A NEUF JOUEURS, PAS DE SOLO : le coup n'a rien prouve.
const veille2 = "2026-09-13";
const epv2 = epreuveDuJour(veille2, "csw24");
inscrireUnJour(veille2, "csw24", 1);
for (let i = 0; i < 9; i++) {
  const m = ouvrirUneManche({
    epreuve: epv2, partie: 1, salon: `w${i}`, compte: `k${i}`, jeu: "seul", noms: "", equipe: [],
  });
  finirLaManche(m.id, [coup(1, 40, i === 0 ? `k${i}` : null, 1000 + i, { [`k${i}`]: 40 })], 7,
    Date.parse("2026-09-13T20:00:00Z"));
}
verifie("neuf joueurs ne font pas un solo",
  listeDesSolos({ lexique: "csw24", maintenant: Date.parse("2026-09-15T12:00:00Z") }).length === 0);

rmSync(dossier, { recursive: true, force: true });
console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
