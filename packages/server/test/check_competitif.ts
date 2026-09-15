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

rmSync(dossier, { recursive: true, force: true });
console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
