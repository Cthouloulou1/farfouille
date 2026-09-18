/**
 * Ce qu'un salon qui enchaine ses parties lit dans le journal de l'historique.
 * Voir SPEC.md §31.
 *
 *     node packages/server/test/check_enchaine.ts
 *
 * TOUT SE PASSE DANS UN DOSSIER TEMPORAIRE : `definirDossierDeLHistorique` est
 * appele avant quoi que ce soit d'autre, et le vrai journal n'est pas touche.
 *
 * Ce que ce test verifie : le numero de la partie en cours, la liste des
 * parties du salon, le partage entre partie topee et partie ratee, et le
 * classement cumule -- qui n'accueille que les comptes, et qui se refait a
 * l'identique apres une relecture du journal.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cumulDuSalon, definirDossierDeLHistorique, ecrireUnePartie, ouvrirLHistorique,
  partieTopee, partiesDuSalon,
} from "../src/historique.ts";
import type { PlayedMove } from "../src/game.ts";
import { avec, configParDefaut } from "../../engine/src/config.ts";

const dossier = mkdtempSync(join(tmpdir(), "enchaine-"));
definirDossierDeLHistorique(dossier);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(58)} ${detail}`);
  if (!ok) echecs++;
}

/** Un coup factice, remporte par quelqu'un ou par personne. */
function coup(n: number, player: string | null, props: Record<string, number>): PlayedMove {
  return {
    n, rack: "ABCDEFG", notation: "ABCDEFG", word: "MOT", dir: "H", x: 0, y: 0, score: 30,
    placements: [{ x: 0, y: 0, letter: "A", blank: false }],
    player, ms: 1000, isotops: 1,
    propositions: Object.fromEntries(Object.entries(props).map(([nom, sc]) =>
      [nom, { word: "MOT", dir: "H" as const, x: 0, y: 0, score: sc }])),
  };
}

/** Les comptes du site. Tout le reste est un invite. */
const comptes = new Set(["ana", "bob"]);
const estCompte = (n: string): boolean => comptes.has(n);

/** Ecrit une partie du salon, et rend ce qu'`ecrireUnePartie` en a dit. */
function partie(salon: string, graine: string, coups: PlayedMove[]): boolean {
  return ecrireUnePartie({
    salon, graine, nomSalon: "Patience", fin: "sac",
    cfg: avec(configParDefaut(), { chrono: null }), coups, estCompte,
  });
}

console.log("\nLe salon qui enchaine ses parties\n");

// LE SALON NEUF EN EST A SA PREMIERE PARTIE : rien au journal, numero 1.
verifie("un salon sans partie en est a la premiere",
  partiesDuSalon("patience").length + 1 === 1);
verifie("et son classement est vide", cumulDuSalon("patience").length === 0);

// PARTIE 1, TOPEE : chacun des trois coups a trouve son top.
verifie("la premiere partie s'ecrit", partie("patience", "g1", [
  coup(1, "ana", { ana: 30, bob: 20 }),
  coup(2, "bob", { ana: 10, bob: 30 }),
  coup(3, "ana", { ana: 30, bob: 25 }),
]));

// PARTIE 2, TOPEE ELLE AUSSI, avec un invite qui remporte un coup. Il est nomme
// sur le coup, mais n'entre pas au cumul.
verifie("la deuxieme partie s'ecrit", partie("patience", "g2", [
  coup(1, "ana", { ana: 30, zoe: 12 }),
  coup(2, "zoe", { ana: 11, zoe: 30 }),
]));

// PARTIE 3, RATEE : un coup sur trois n'a trouve personne.
verifie("la troisieme partie s'ecrit", partie("patience", "g3", [
  coup(1, "bob", { ana: 20, bob: 30 }),
  coup(2, null, { ana: 12, bob: 14 }),
  coup(3, "bob", { ana: 18, bob: 30 }),
]));

// UNE PARTIE D'UN AUTRE SALON NE COMPTE PAS ICI. C'est l'index par salon qu'on
// eprouve : sans lui, le numero et le cumul melangeraient tous les salons.
verifie("une partie d'un autre salon s'ecrit", partie("ailleurs", "g4", [
  coup(1, "ana", { ana: 30 }),
]));

const les = partiesDuSalon("patience");
verifie("le salon compte ses trois parties", les.length === 3, `${les.length}`);
verifie("la partie en cours porte le numero 4", les.length + 1 === 4);
verifie("l'autre salon a la sienne, et une seule",
  partiesDuSalon("ailleurs").length === 1);

verifie("l'ordre est celui du journal, de la plus ancienne",
  les.map((p) => p.graine).join(",") === "g1,g2,g3");

verifie("les deux premieres sont topees",
  partieTopee(les[0]!) && partieTopee(les[1]!));
verifie("la troisieme ne l'est pas -- un coup sans personne",
  !partieTopee(les[2]!));
verifie("le salon totalise deux parties topees",
  les.filter(partieTopee).length === 2);

// LE CUMUL DES COUPS, parties precedentes comprises : c'est ce que la vignette
// de l'accueil montre a la place du coup de la partie du moment.
verifie("le total des coups des parties finies fait huit",
  les.reduce((a, p) => a + p.coups, 0) === 8);

// LE CUMUL DES POINTS de chaque partie est au journal depuis ce champ.
verifie("le cumul des points d'une partie est ecrit", les[0]!.cumul === 90, `${les[0]!.cumul}`);

// LE CLASSEMENT : les comptes seuls, du plus de tops au moins.
const cumul = cumulDuSalon("patience");
verifie("seuls les comptes cumulent", cumul.map((l) => l.nom).join(",") === "ana,bob",
  cumul.map((l) => `${l.nom}:${l.tops}`).join(" "));
verifie("l'invite n'a pas de ligne au cumul", !cumul.some((l) => l.nom === "zoe"));
verifie("ana totalise trois tops", cumul.find((l) => l.nom === "ana")?.tops === 3);
verifie("bob en totalise trois aussi", cumul.find((l) => l.nom === "bob")?.tops === 3);
verifie("ana a joue les trois parties", cumul.find((l) => l.nom === "ana")?.parties === 3);
verifie("bob n'en a joue que deux -- il manquait a la deuxieme",
  cumul.find((l) => l.nom === "bob")?.parties === 2);

// LE CACHE NE DOIT PAS SERVIR UN CUMUL PERIME. Une partie de plus, et le
// classement doit avoir bouge sans qu'on ait rien a invalider a la main.
partie("patience", "g5", [coup(1, "bob", { ana: 10, bob: 30 })]);
verifie("une partie de plus met le cumul a jour",
  cumulDuSalon("patience").find((l) => l.nom === "bob")?.tops === 4);
verifie("et le numero de la partie en cours passe a cinq",
  partiesDuSalon("patience").length + 1 === 5);

// APRES UNE RELECTURE DU JOURNAL, tout doit revenir identique : c'est ce qui se
// passe a chaque demarrage du serveur, et c'est de la que le salon tire son
// numero apres un redemarrage.
const avant = JSON.stringify(cumulDuSalon("patience"));
ouvrirLHistorique();
verifie("le journal relu rend les memes parties",
  partiesDuSalon("patience").length === 4);
verifie("et le meme classement", JSON.stringify(cumulDuSalon("patience")) === avant);

// UNE PARTIE ABANDONNEE N'A JAMAIS DE NUMERO : elle ne s'ecrit pas, donc elle
// ne laisse pas de trou dans la numerotation.
const refusee = ecrireUnePartie({
  salon: "patience", graine: "g6", nomSalon: "Patience", fin: "abandon",
  cfg: avec(configParDefaut(), { chrono: null }),
  coups: [coup(1, "ana", { ana: 30 })], estCompte,
});
verifie("une partie abandonnee ne s'ecrit pas", !refusee);
verifie("le numero de la partie en cours n'a pas bouge",
  partiesDuSalon("patience").length + 1 === 5);

rmSync(dossier, { recursive: true, force: true });
console.log(`\n${echecs === 0 ? "tout est bon" : `${echecs} echec(s)`}\n`);
process.exit(echecs === 0 ? 0 : 1);
