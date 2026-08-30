/**
 * Ce qu'on garde en fermant un salon. Voir SPEC.md §16.
 *
 *     node packages/server/test/check_menage.ts
 *
 * C'est le seul endroit du programme qui efface volontairement une partie. La
 * regle tient en une phrase : une 15x15 TERMINEE survit a son salon, rien
 * d'autre. Une 15x15 abandonnee ne se rejoue pas ; une grille infinie n'a pas
 * de fin et accumulerait des megaoctets qu'on ne rouvrira jamais.
 *
 * Le test verifie les deux sens : ce qui doit rester reste, ce qui doit partir
 * part -- fichiers a l'appui.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ouvrirSalon, fermerSalon, meriteDEtreGardee } from "../src/salons.ts";
import { configParDefaut, avec } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const SUFFIXES = [".json", ".journal.jsonl", ".secours.json", ".verrou"];

const fichiers = (id: string): string[] =>
  SUFFIXES.map((s) => join(D, `${id}${s}`)).filter(existsSync);

function nettoyer(id: string): void {
  for (const f of fichiers(id)) rmSync(f);
}

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(52)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nCe qu'on garde en fermant un salon\n");
setLayout("classique");

/** Ouvre un salon d'essai, y joue quelques coups, et le referme. */
async function essai(id: string, bornes: number | null, jusquAuBout: boolean) {
  nettoyer(id);
  const cfg = avec(configParDefaut(), {
    bornes,
    pioche: bornes === null ? "probabilites" : "sac102",
    chrono: null,
    // Une partie qu'on veut voir se terminer s'arrete au bout de trois coups.
    coupsMax: jusquAuBout ? 3 : null,
  });
  const s = await ouvrirSalon({
    id, nom: id, proprietaire: "essai", prive: false,
    layout: bornes === null ? "pave1" : "classique", cfg, nouveau: false,
  });
  s.partie.presents.add("essai");
  await s.partie.reveiller();
  await s.partie.demarrer();
  for (let i = 0; i < 5 && !s.partie.finie; i++) {
    await s.partie.reveal();
    await new Promise((r) => setTimeout(r, 20));
  }
  const finie = s.partie.finie;
  const garde = meriteDEtreGardee(s);
  const coups = s.partie.moves.length;
  await fermerSalon(id);
  return { finie, garde, coups, restants: fichiers(id).length };
}

// 1. Plateau borne, partie menee a son terme : on garde.
{
  const r = await essai("menage-borne-finie", 7, true);
  verifie("15x15 terminee : la partie survit au salon",
    r.finie && r.garde && r.restants > 0, `${r.coups} coups, ${r.restants} fichiers`);
}

// 2. Plateau borne, partie abandonnee : on efface.
{
  const r = await essai("menage-borne-en-cours", 7, false);
  verifie("15x15 en cours : rien ne reste",
    !r.finie && !r.garde && r.restants === 0, `${r.coups} coups, ${r.restants} fichiers`);
}

// 3. Grille infinie : on efface, terminee ou non.
{
  const r = await essai("menage-infinie", null, false);
  verifie("grille infinie : rien ne reste",
    !r.garde && r.restants === 0, `${r.coups} coups, ${r.restants} fichiers`);
}

for (const id of ["menage-borne-finie", "menage-borne-en-cours", "menage-infinie"]) {
  nettoyer(id);
}

console.log(echecs === 0
  ? "\nOK : seule une 15x15 terminee survit a son salon\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
