/**
 * L'historique des parties d'un joueur, et ses deux garde-fous. Voir SPEC.md §30.
 *
 *     node packages/server/test/check_historique.ts
 *
 * TOUT SE PASSE DANS UN DOSSIER TEMPORAIRE : `definirDossierDeLHistorique` est
 * appele avant quoi que ce soit d'autre, et le vrai journal n'est pas touche.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  combienDeParties, definirDossierDeLHistorique, ecrireUnePartie, lignesDesJoueurs,
  ouvrirLHistorique, partieDeLHistorique, partiesDe,
} from "../src/historique.ts";
import type { PlayedMove } from "../src/game.ts";
import { configParDefaut } from "../../engine/src/config.ts";

const dossier = mkdtempSync(join(tmpdir(), "historique-"));
definirDossierDeLHistorique(dossier);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(58)} ${detail}`);
  if (!ok) echecs++;
}

/** Un coup factice : son top, qui l'a trouve, et ce que chacun a propose. */
function coup(n: number, score: number, player: string | null,
  props: Record<string, number>): PlayedMove {
  return {
    n, rack: "ABCDEFG", notation: "ABCDEFG", word: "MOT", dir: "H", x: 0, y: 0, score,
    placements: [{ x: 0, y: 0, letter: "A", blank: false }],
    player, ms: 1000, isotops: 1,
    propositions: Object.fromEntries(Object.entries(props).map(([nom, sc]) =>
      [nom, { word: "MOT", dir: "H" as const, x: 0, y: 0, score: sc }])),
  };
}

const cfg = configParDefaut();
const comptes = new Set(["ana", "bob"]);
const estCompte = (n: string): boolean => comptes.has(n);

console.log("\nL'historique\n");

// QUATRE COUPS SUR QUATRE ONT RECU UN MOT : la partie est jouee.
const jouee = [
  coup(1, 40, "ana", { ana: 40, bob: 20 }),
  coup(2, 30, "bob", { ana: 10, bob: 30 }),
  coup(3, 50, "ana", { ana: 50 }),
  coup(4, 20, "bob", { bob: 20, cy: 12 }),
];
verifie("une partie jouee s'ecrit", ecrireUnePartie({
  salon: "s1", graine: "g1", nomSalon: "Farfouille rude", fin: "sac",
  cfg, coups: jouee, estCompte,
}));
verifie("elle ne s'ecrit pas deux fois", !ecrireUnePartie({
  salon: "s1", graine: "g1", nomSalon: "Farfouille rude", fin: "sac",
  cfg, coups: jouee, estCompte,
}));
verifie("chacun la retrouve", combienDeParties("ana") === 1 && combienDeParties("bob") === 1
  && combienDeParties("cy") === 1);

const l = partiesDe("ana")[0]!.joueurs;
const ana = l.find((x) => x.nom === "ana")!;
const cy = l.find((x) => x.nom === "cy")!;
verifie("le score additionne ce qu'on a propose", ana.score === 100, String(ana.score));
// 0 sur le coup 1, 20 sur le 2 (30 - 10), 0 sur le 3, 20 sur le 4 (rien propose).
verifie("le negatif compte les coups ou l'on n'a rien propose",
  ana.negatif === 40, String(ana.negatif));
verifie("les tops se comptent", ana.tops === 2, String(ana.tops));
verifie("un nom sans compte est dit invite", cy.invite && !ana.invite);
verifie("le journal garde le nom du salon",
  partieDeLHistorique("s1", "g1")?.nomSalon === "Farfouille rude");

// UN JOUEUR QUI N'A RIEN PROPOSE N'Y ENTRE PAS : etre assis dans le salon ne
// suffit pas (SPEC.md §30).
verifie("qui n'a rien propose n'y entre pas",
  !lignesDesJoueurs(jouee, estCompte).some((x) => x.nom === "dan"));

// MOINS DE TROIS QUARTS DES COUPS JOUES : la partie n'a pas ete jouee.
const survolee = [
  coup(1, 40, "ana", { ana: 40 }),
  coup(2, 30, null, {}),
  coup(3, 50, null, {}),
  coup(4, 20, null, {}),
];
verifie("une partie survolee ne s'ecrit pas", !ecrireUnePartie({
  salon: "s2", graine: "g2", nomSalon: "Vide", fin: "sac", cfg, coups: survolee, estCompte,
}));
verifie("et personne n'en herite", combienDeParties("ana") === 1);

// TROIS COUPS SUR QUATRE, c'est assez.
const juste = [
  coup(1, 40, "ana", { ana: 40 }),
  coup(2, 30, "ana", { ana: 30 }),
  coup(3, 50, "ana", { ana: 50 }),
  coup(4, 20, null, {}),
];
verifie("trois coups sur quatre suffisent", ecrireUnePartie({
  salon: "s3", graine: "g3", nomSalon: "Juste", fin: "sac", cfg, coups: juste, estCompte,
}));

// UNE PARTIE SANS COUP N'EST PAS UNE PARTIE.
verifie("une partie sans coup ne s'ecrit pas", !ecrireUnePartie({
  salon: "s4", graine: "g4", nomSalon: "Rien", fin: "abandon", cfg, coups: [], estCompte,
}));

// LE JOURNAL FAIT FOI.
ouvrirLHistorique();
verifie("le journal se relit a l'identique", combienDeParties("ana") === 2
  && partiesDe("ana")[0]!.nomSalon === "Juste", `${combienDeParties("ana")} partie(s)`);
verifie("la plus recente est en tete", partiesDe("ana")[0]!.salon === "s3");

rmSync(dossier, { recursive: true, force: true });
console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
