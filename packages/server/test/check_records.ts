/**
 * Ce qui entre au tableau des records, et ce qui n'y entre pas. SPEC.md §23.
 *
 *     node packages/server/test/check_records.ts
 *
 * Le point dur n'est pas d'enregistrer une partie : c'est de REFUSER celles qui
 * n'ont pas ete jouees. Un onglet reste ouvert fait defiler une partie
 * chronometree tout seul, sans que le journal voie la moindre difference avec
 * une table de six joueurs -- en topping, il n'ecrit que le gagnant du coup, et
 * un coup rate n'y ecrit personne.
 *
 * Ce test joue donc cinq parties : une topee par un joueur qui cherche vraiment,
 * une que personne ne joue, une dont les reglages ne portent aucun record, une
 * reprise en cours de route, et une qu'on abandonne apres avoir rate. Une seule
 * doit entrer au tableau -- mais la derniere doit quand meme laisser ses coups
 * rates aux tableaux de mots, parce que relancer apres un rate est le geste le
 * plus courant du jeu.
 *
 * LE JOURNAL DES RECORDS EXISTANT EST MIS DE COTE puis rendu : ce test ne doit
 * rien couter a la machine sur laquelle il tourne.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import type { Dir } from "../../engine/src/coords.ts";
import {
  empreinteDuLexique, invaliderLaManche, manchesValides, motsRates, motsTrouves,
  observer, ouvrirLesRecords,
} from "../src/records.ts";
import { avec, configParDefaut, type ConfigPartie } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS } from "../../engine/src/bonus.ts";
import { BORNES_NORMALE } from "../../engine/src/categories.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const JOURNAL = join(D, "records.journal.jsonl");
const DE_COTE = join(D, "records.essai-en-cours.jsonl");
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

function partieNormale(): ConfigPartie {
  return avec(configParDefaut(), {
    bornes: BORNES_NORMALE, pavage: LAYOUTS.classique15, pavageNom: "classique15",
    tirage: 7, jouables: 7, pioche: "sac102", sacs: 1,
    mode: "topping", chrono: null, coupsMax: null, dureeMax: null,
  });
}

const dors = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Le mot du top, TEL QU'UN JOUEUR LE TAPE.
 *
 * Le palier donne le mot entier et sa case de depart ; le joueur, lui, ne tape
 * que les lettres qu'il POSE -- le curseur enjambe tout seul les caramels deja
 * presents (SPEC.md §9). Taper le mot entier depuis son origine reposerait des
 * lettres deja la, et le serveur repondait « trop de caramels » ou « le mot
 * sort de la grille ». Le curseur part donc de la premiere case LIBRE.
 */
function commeUnJoueur(
  g: Game, mot: string, dir: Dir, x: number, y: number,
): { x: number; y: number; tape: string } {
  const occupees = new Set(g.tiles().map((t) => `${t.x},${t.y}`));
  const dx = dir === "H" ? 1 : 0;
  const dy = dir === "H" ? 0 : 1;
  let sx = x, sy = y, tape = "", debut = false;
  for (let i = 0; i < mot.length; i++) {
    const cx = x + dx * i, cy = y + dy * i;
    if (occupees.has(`${cx},${cy}`)) continue;
    if (!debut) { sx = cx; sy = cy; debut = true; }
    tape += mot[i];
  }
  return { x: sx, y: sy, tape };
}

/**
 * Joue UN coup, et rend la main quand il est tombe.
 *
 * Le coup suivant n'est pas pret a l'instant ou celui-ci se clot : le serveur
 * doit encore tirer et chercher. On reessaie donc jusqu'a ce que le compteur de
 * coups avance -- sans quoi trois appels de suite rejouaient le meme top et un
 * seul coup passait.
 */
async function unCoup(g: Game, qui: string): Promise<boolean> {
  const avant = g.moves.length;
  for (let essai = 0; essai < 60 && g.moves.length === avant && !g.finie; essai++) {
    const t = g.tiers[0]?.moves[0];
    if (t !== undefined) {
      const dir = t[1] as Dir;
      const saisie = commeUnJoueur(g, t[0], dir, t[2], t[3]);
      await g.attempt(qui, dir, saisie.x, saisie.y, saisie.tape);
    }
    await dors(15);
  }
  return g.moves.length > avant;
}

/**
 * Joue la partie jusqu'au bout. `qui` cherche et trouve chaque top ; `null`
 * revele sans que personne ne touche a rien -- c'est l'onglet abandonne.
 */
async function jouer(g: Game, qui: string | null, plafond = 300): Promise<void> {
  await g.demarrer();
  for (let i = 0; i < plafond && !g.finie; i++) {
    if (qui === null) {
      await g.reveal();
    } else {
      // Le palier du top porte le mot, sa direction et sa case.
      const t = g.tiers[0]?.moves[0];
      if (t === undefined) { await g.reveal(); }
      else {
        const dir = t[1] as Dir;
        const saisie = commeUnJoueur(g, t[0], dir, t[2], t[3]);
        const r = await g.attempt(qui, dir, saisie.x, saisie.y, saisie.tape);
        if (!r.ok) {
          verifie(`le top ${t[0]} est accepte`, false, `${r.message} (tapé « ${saisie.tape} »)`);
          await g.reveal();
        }
      }
    }
    await dors(15);
  }
}

// ------------------------------------ le journal existant est mis de cote
if (existsSync(JOURNAL)) renameSync(JOURNAL, DE_COTE);
function rendreLeJournal(): void {
  if (existsSync(JOURNAL)) rmSync(JOURNAL);
  if (existsSync(DE_COTE)) renameSync(DE_COTE, JOURNAL);
}
process.on("exit", rendreLeJournal);

console.log("\nCe qui entre au tableau des records\n");
setLayout("classique15");
ouvrirLesRecords();
verifie("on part d'un tableau vide", manchesValides().length === 0);

// ------------------------------------- 1. une partie topee par un joueur
console.log("\n  --- une partie topee ---\n");
const ID = "records-topee";
nettoyer(ID);
{
  const g = new Game(ID, "classique15", partieNormale());
  await g.start();
  observer(g);
  g.presents.add("alice");
  await g.reveiller();
  await jouer(g, "alice");

  verifie("la partie est terminee", g.finie, `${g.moves.length} coups`);
  const tousTrouves = g.moves.every((m) => m.player === "alice");
  verifie("alice a trouve tous les tops", tousTrouves,
    `${g.moves.filter((m) => m.player !== null).length}/${g.moves.length}`);

  const vues = manchesValides();
  verifie("une manche est enregistree", vues.length === 1, `${vues.length}`);
  const m = vues[0];
  verifie("dans la categorie reine", m?.categorie === "normale", m?.categorie ?? "aucune");
  verifie("sur la grille normale", m?.grille === "normale");
  verifie("elle est topee", m?.topee === true);
  verifie("son negatif est nul", m?.negatif === 0, String(m?.negatif));
  verifie("elle est solo", m?.solo === "alice", m?.solo ?? "personne");
  verifie("alice est nommee, et dite invitee",
    m?.joueurs.length === 1 && m?.joueurs[0]?.nom === "alice"
    && m?.joueurs[0]?.invite === true,
    m?.joueurs.map((j) => `${j.nom}${j.invite ? " (invité)" : ""} ×${j.tops}`).join(", ") ?? "personne");
  verifie("le temps est la somme des coups",
    m?.temps === g.moves.reduce((a, c) => a + Math.max(0, c.ms), 0), `${m?.temps} ms`);
  verifie("le cumul est celui de la partie",
    m?.cumul === g.moves.reduce((a, c) => a + c.score, 0), `${m?.cumul} points`);
  verifie("le nombre de coups tient dans ce qu'une 15x15 donne",
    (m?.coups ?? 0) >= 15 && (m?.coups ?? 0) <= 40, `${m?.coups} coups`);
  verifie("le coup le plus cher est retenu",
    m?.coupCher !== null && (m?.coupCher?.score ?? 0) > 0,
    `${m?.coupCher?.mot} à ${m?.coupCher?.score} points`);
  verifie("le moins cher aussi",
    m?.coupPasCher !== null
    && (m?.coupPasCher?.score ?? 0) <= (m?.coupCher?.score ?? 0),
    `${m?.coupPasCher?.mot} à ${m?.coupPasCher?.score} points`);
  verifie("le lexique porte son empreinte",
    /^[0-9a-f]{8}$/.test(m?.empreinte ?? ""), m?.empreinte ?? "aucune");
  // LA MANCHE NE GARDE PLUS SES COUPS : les mots sont au compteur, et le
  // journal de la partie porte le detail. On verifie donc le compteur.
  const auCompteur = motsTrouves("ods9");
  verifie("les mots de la partie sont au compteur",
    auCompteur.length > 0, `${auCompteur.length} mot(s)`);
  verifie("et le mot du premier coup y est",
    auCompteur.some((l) => l.mot === g.moves[0]?.word),
    g.moves[0]?.word ?? "aucun");
  await g.stop();
}

// -------------------------------- 2. une partie que personne ne joue
console.log("\n  --- un onglet reste ouvert ---\n");
const ID2 = "records-personne";
nettoyer(ID2);
{
  const g = new Game(ID2, "classique15", partieNormale());
  await g.start();
  observer(g);
  g.presents.add("fantome");
  await g.reveiller();
  await jouer(g, null);

  verifie("la partie est terminee", g.finie, `${g.moves.length} coups`);
  verifie("aucun top n'a ete trouve", g.moves.every((m) => m.player === null));
  verifie("elle n'entre pas au tableau", manchesValides().length === 1,
    `${manchesValides().length} manche(s)`);
  await g.stop();
}

// ------------------------- 3. des reglages qui ne portent aucun record
console.log("\n  --- des reglages hors categorie ---\n");
const ID3 = "records-hors";
nettoyer(ID3);
{
  const cfg = avec(partieNormale(), { pioche: "probabilites", coupsMax: 3 });
  const g = new Game(ID3, "classique15", cfg);
  await g.start();
  observer(g);
  g.presents.add("alice");
  await g.reveiller();
  await jouer(g, "alice", 20);

  verifie("la partie est terminee", g.finie, `${g.moves.length} coups`);
  verifie("elle n'entre pas au tableau", manchesValides().length === 1,
    `${manchesValides().length} manche(s)`);
  await g.stop();
}

// ------------------------------- 4. une partie reprise en cours de route
console.log("\n  --- un serveur qui redemarre ---\n");
const ID4 = "records-reprise";
nettoyer(ID4);
{
  const g = new Game(ID4, "classique15", partieNormale());
  await g.start();
  observer(g);
  g.presents.add("alice");
  await g.reveiller();
  await g.demarrer();
  for (let i = 0; i < 3; i++) await unCoup(g, "alice");
  verifie("elle a commence", g.moves.length >= 3, `${g.moves.length} coups`);
  await g.stop();

  // Le serveur redemarre : le salon rouvre la partie et la met sous
  // observation, mais il a manque les premiers coups.
  const r = new Game(ID4, "classique15", partieNormale());
  await r.start();
  observer(r);
  r.presents.add("alice");
  await r.reveiller();
  await jouer(r, "alice");

  verifie("elle va jusqu'au bout", r.finie, `${r.moves.length} coups`);
  verifie("mais elle n'entre pas au tableau", manchesValides().length === 1,
    `${manchesValides().length} manche(s)`);
  await r.stop();
}

// ------------------- 5. une partie abandonnee laisse ses coups aux mots
//
// C'EST LE CAS LE PLUS COURANT DU JEU. Une table qui rate un top relance
// aussitot : sans le releve ecrit a l'arret, le mot rate -- celui-la meme qui
// fait abandonner -- ne serait compte nulle part.
console.log("\n  --- une partie qu'on relance apres un rate ---\n");
const ID5 = "records-abandon";
nettoyer(ID5);
{
  const avant = motsRates("ods9").length;
  // TROIS SECONDES PAR COUP : assez pour qu'une soumission tombe DANS le coup.
  //
  // Un mot soumis entre deux coups ne compte pas, et c'est juste : le serveur
  // cherche encore, il n'y a pas de coup sur lequel etre actif. Avec un chrono
  // d'une seconde, toutes les soumissions du test tombaient dans cet
  // intervalle, et pas un seul rate n'etait compte.
  const g = new Game(ID5, "classique15", avec(partieNormale(), { chrono: 3 }));
  await g.start();
  observer(g);
  g.presents.add("alice");
  await g.reveiller();
  await g.demarrer();
  for (let i = 0; i < 3 && !g.finie; i++) {
    // On attend que le coup soit servi, puis on propose un mot qui n'existe
    // pas : alice a cherche, elle n'a pas trouve. C'est exactement le cas que
    // le tableau des rates doit compter.
    for (let attente = 0; attente < 40 && g.tiers.length === 0; attente++) await dors(50);
    await g.attempt("alice", "H", 0, 0, "ZZZZ");
    const n = g.moves.length;
    for (let attente = 0; attente < 80 && g.moves.length === n; attente++) await dors(100);
  }
  const rates = g.moves.filter((m) => m.player === null).length;
  verifie("des coups ont ete rates", rates > 0, `${rates} sur ${g.moves.length} coups`);
  verifie("la partie n'est pas finie", !g.finie);

  // On abandonne : c'est ici que le releve part.
  await g.stop();
  verifie("elle n'ajoute aucune manche", manchesValides().length === 1,
    `${manchesValides().length} manche(s)`);
  const apres = motsRates("ods9");
  verifie("mais ses coups rates comptent dans les mots", apres.length > avant,
    `${avant} mot(s) avant, ${apres.length} apres`);
  verifie("et chaque mot du tableau a bien ete rate",
    apres.every((l) => l.rates > 0));
}

// ------------------------------------------------- 6. l'invalidation
console.log("\n  --- l'invalidation ---\n");
{
  verifie("une manche inconnue ne s'invalide pas",
    !invaliderLaManche("cette-partie-n-existe-pas", "zulu", "essai"));
  verifie("la manche enregistree s'invalide",
    invaliderLaManche(ID, "zulu", "temps invraisemblables"));
  verifie("le tableau est vide", manchesValides().length === 0);

  // Le journal fait foi : on le relit, et l'invalidation tient.
  ouvrirLesRecords();
  verifie("la manche est toujours au journal apres relecture",
    manchesValides().length === 0);
}

// -------------------------------------------------- 6. l'empreinte
console.log("\n  --- l'empreinte du lexique ---\n");
{
  const a = empreinteDuLexique("ods9");
  const b = empreinteDuLexique("ods9");
  verifie("elle fait huit caracteres", /^[0-9a-f]{8}$/.test(a), a);
  verifie("elle ne change pas d'un appel a l'autre", a === b);
  const anglais = empreinteDuLexique("csw24");
  verifie("deux lexiques ont deux empreintes", a !== anglais, `${a} contre ${anglais}`);
}

for (const id of [ID, ID2, ID3, ID4, ID5]) nettoyer(id);
rendreLeJournal();
console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
