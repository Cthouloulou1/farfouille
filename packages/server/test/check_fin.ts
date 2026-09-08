/**
 * Le journal dit qu'une partie est terminee. Voir SPEC.md §23.
 *
 *     node packages/server/test/check_fin.ts
 *
 * Le journal portait la grille, les coups, le chat et les « j'aime ». Rien n'y
 * disait qu'une partie etait FINIE : `finie` se recalculait au demarrage en
 * rejouant le sac entier. Tout ce qui lit un journal sans embarquer le moteur
 * etait donc incapable de distinguer une partie complete d'une partie
 * abandonnee -- « 26 coups » pouvait vouloir dire les deux.
 *
 * Ce test joue une 15x15 jusqu'a ce que le sac ne donne plus rien, verifie
 * qu'une ligne de fin est ecrite, UNE SEULE, avec la bonne raison ; puis rouvre
 * la partie et verifie qu'aucune seconde ligne n'apparait. C'est ce dernier
 * point qui compte : sans lui, chaque demarrage du serveur ferait naitre un
 * record de plus pour la meme partie.
 */
import { rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game, type RaisonDeFin } from "../src/game.ts";
import { avec, configParDefaut, type ConfigPartie } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS } from "../../engine/src/bonus.ts";
import { BORNES_NORMALE } from "../../engine/src/categories.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const SUFFIXES = [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"];

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(54)} ${detail}`);
  if (!ok) echecs++;
}

function nettoyer(id: string): void {
  for (const s of SUFFIXES) {
    const f = join(D, `${id}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

/** Les evenements de fin ecrits au journal de cette partie. */
function finsDuJournal(id: string): Record<string, any>[] {
  const f = join(D, `${id}.journal.jsonl`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((e) => e["t"] === "fin");
}

function partieNormale(): ConfigPartie {
  return avec(configParDefaut(), {
    bornes: BORNES_NORMALE, pavage: LAYOUTS.classique15, pavageNom: "classique15",
    tirage: 7, jouables: 7, pioche: "sac102", sacs: 1,
    mode: "topping", chrono: null, coupsMax: null, dureeMax: null,
  });
}

/** Joue la partie jusqu'a sa fin, en revelant chaque top. */
async function jusquAuBout(g: Game, plafond = 300): Promise<void> {
  await g.demarrer();
  for (let i = 0; i < plafond && !g.finie; i++) {
    await g.reveal();
    await new Promise((r) => setTimeout(r, 15));
  }
}

console.log("\nLe journal dit qu'une partie est terminee\n");

// -------------------------------- 1. une partie qui va au bout de son sac
console.log("  --- le sac s'epuise ---\n");
const ID = "fin-test";
nettoyer(ID);
{
  setLayout("classique15");
  const g = new Game(ID, "classique15", partieNormale());
  const annonces: RaisonDeFin[] = [];
  await g.start();
  g.onFin((r) => annonces.push(r));
  g.presents.add("essai");
  await g.reveiller();
  await jusquAuBout(g);

  verifie("la partie s'est terminee", g.finie, `${g.moves.length} coups`);
  verifie("le nombre de coups est celui d'une 15x15",
    g.moves.length >= 15 && g.moves.length <= 40, `${g.moves.length} coups`);
  verifie("la raison est le sac", g.raisonDeLaFin === "sac", g.raisonDeLaFin ?? "aucune");
  verifie("la fin a ete annoncee une fois", annonces.length === 1, annonces.join(","));

  const fins = finsDuJournal(ID);
  verifie("une ligne de fin au journal", fins.length === 1, `${fins.length} ligne(s)`);
  verifie("elle porte la raison", fins[0]?.["raison"] === "sac");
  verifie("elle porte le nombre de coups", fins[0]?.["coups"] === g.moves.length,
    `${fins[0]?.["coups"]} contre ${g.moves.length}`);
  verifie("elle porte son heure", typeof fins[0]?.["at"] === "number"
    && (fins[0]!["at"] as number) > 0);
  await g.stop();
}

// ------------------------------- 2. la rouvrir n'en ecrit pas une seconde
console.log("\n  --- on referme, on rouvre ---\n");
{
  const g = new Game(ID, "classique15", partieNormale());
  const annonces: RaisonDeFin[] = [];
  g.onFin((r) => annonces.push(r));
  await g.start();
  // LA RELECTURE NE MARQUE PAS LA PARTIE FINIE, et c'est voulu : c'est le
  // reveil qui redistribue, et c'est cette distribution-la qui rend au reliquat
  // les lettres restees en main. Voir le commentaire de `rebuild`.
  verifie("la relecture seule ne la clot pas", !g.finie);
  verifie("mais elle sait deja pourquoi elle s'est arretee",
    g.raisonDeLaFin === "sac", g.raisonDeLaFin ?? "aucune");
  await g.reveiller();

  verifie("la partie revient terminee", g.finie);
  verifie("elle se souvient pourquoi", g.raisonDeLaFin === "sac", g.raisonDeLaFin ?? "aucune");
  verifie("la fin n'est PAS reannoncee", annonces.length === 0,
    annonces.length === 0 ? "" : `${annonces.length} annonce(s) de trop`);
  verifie("le journal n'a toujours qu'une ligne de fin", finsDuJournal(ID).length === 1);
  await g.stop();
}

// ----------------------- 3. une partie bornee en coups le dit autrement
console.log("\n  --- le nombre de coups est atteint ---\n");
const ID2 = "fin-test-coups";
nettoyer(ID2);
{
  const g = new Game(ID2, "classique15", avec(partieNormale(), { coupsMax: 4 }));
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await jusquAuBout(g, 40);

  verifie("la partie s'arrete au compte demande", g.moves.length === 4,
    `${g.moves.length} coups`);
  verifie("la raison est le nombre de coups", g.raisonDeLaFin === "coups",
    g.raisonDeLaFin ?? "aucune");
  verifie("le journal la porte", finsDuJournal(ID2)[0]?.["raison"] === "coups");
  await g.stop();
}

// --------------- 4. une partie en cours n'a ni fin ni ligne au journal
console.log("\n  --- une partie qu'on abandonne ---\n");
const ID3 = "fin-test-abandon";
nettoyer(ID3);
{
  const g = new Game(ID3, "classique15", partieNormale());
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  for (let i = 0; i < 3; i++) {
    await g.reveal();
    await new Promise((r) => setTimeout(r, 15));
  }
  verifie("elle a joue sans finir", g.moves.length >= 3 && !g.finie, `${g.moves.length} coups`);
  verifie("aucune ligne de fin au journal", finsDuJournal(ID3).length === 0);
  verifie("et aucune raison", g.raisonDeLaFin === null);
  await g.stop();
  verifie("meme apres l'avoir refermee", finsDuJournal(ID3).length === 0);
}

nettoyer(ID);
nettoyer(ID2);
nettoyer(ID3);
console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
