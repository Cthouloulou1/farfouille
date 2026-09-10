/**
 * Une montante jouee pour de vrai : la marque au journal, et ce que l'etape
 * laisse a la suite. Voir SPEC.md §23.
 *
 *     node packages/server/test/check_montante_jouee.ts
 *
 * `check_montante.ts` eprouve la mecanique de la suite sur des etapes
 * fabriquees. Celui-ci branche les vraies pieces : un `Game`, l'observation du
 * journal des records, et une partie jouee jusqu'au bout du sac.
 *
 * DEUX CHOSES QU'UNE ETAPE FABRIQUEE NE PEUT PAS DIRE :
 *
 * - **la marque de la suite arrive-t-elle dans l'en-tete du journal ?** C'est
 *   la seule trace durable qu'une partie appartenait a une montante, et un
 *   champ oublie ne se voit pas -- la partie se joue exactement pareil ;
 * - **l'observation rend-elle une etape juste ?** Ses coups, son temps, ses
 *   tops, son negatif, et surtout son `valide` : une montante entiere peut se
 *   jouer et n'entrer nulle part si celui-la tombe a faux.
 *
 * Le journal des records est mis de cote puis rendu : ce test ne doit rien
 * couter a la machine sur laquelle il tourne.
 */
import { existsSync, renameSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import type { Dir } from "../../engine/src/coords.ts";
import { observer, ouvrirLesRecords, refDeLaGraine } from "../src/records.ts";
import {
  cloreLEtape, etapeReprenable, marqueDeLaMontante, nouvelleMontante,
  passerALEtapeSuivante, reprendreLEtape, totaux,
} from "../src/montante.ts";
import { configDeLEtape } from "../../engine/src/montante.ts";
import { avec, configParDefaut, type ConfigPartie } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS } from "../../engine/src/bonus.ts";
import { BORNES_NORMALE, categorieDesReglages } from "../../engine/src/categories.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const JOURNAL = join(D, "records.journal.jsonl");
const DE_COTE = join(D, "records.essai-montante-jouee.jsonl");
const SUFFIXES = [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"];
const ID = "montante-jouee";

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

/** L'en-tete du journal d'une partie. */
function entete(id: string): Record<string, any> | null {
  const f = join(D, `${id}.journal.jsonl`);
  if (!existsSync(f)) return null;
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (l.trim() === "") continue;
    try {
      const e = JSON.parse(l) as Record<string, any>;
      if (e["t"] === "grille") return e;
    } catch { /* ligne illisible */ }
  }
  return null;
}

const dors = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ce sur quoi la montante se lance : une 15x15 au sac du commerce. */
function base(): ConfigPartie {
  return avec(configParDefaut(), {
    bornes: BORNES_NORMALE, pavage: LAYOUTS.classique15, pavageNom: "classique15",
    pioche: "sac102", sacs: 1, mode: "topping",
    chrono: null, coupsMax: null, dureeMax: null,
  });
}

/**
 * Le mot du top, TEL QU'UN JOUEUR LE TAPE : le curseur enjambe tout seul les
 * caramels deja poses, donc on ne tape que les lettres qu'on pose.
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

/** Joue la partie jusqu'au bout, `qui` trouvant chaque top. */
async function jouer(g: Game, qui: string, plafond = 300): Promise<void> {
  await g.demarrer();
  for (let i = 0; i < plafond && !g.finie; i++) {
    const t = g.tiers[0]?.moves[0];
    if (t === undefined) { await g.reveal(); await dors(15); continue; }
    const dir = t[1] as Dir;
    const saisie = commeUnJoueur(g, t[0], dir, t[2], t[3]);
    const r = await g.attempt(qui, dir, saisie.x, saisie.y, saisie.tape);
    // Un top refuse ne doit pas bloquer la partie : on le revele et le test le
    // dira au bilan, par un negatif qu'il n'attendait pas.
    if (!r.ok) await g.reveal();
    await dors(15);
  }
}

console.log("\nUne montante jouee\n");

const gardeAPart = existsSync(JOURNAL);
if (gardeAPart) renameSync(JOURNAL, DE_COTE);

try {
  ouvrirLesRecords();
  setLayout("classique15");
  const m = nouvelleMontante();

  // ------------------------------------------------ 1. l'etape 1, jusqu'au bout
  console.log("  --- l'etape 1, jouee jusqu'au bout du sac ---\n");
  nettoyer(ID);
  const cfg1 = configDeLEtape(base(), 1);
  verifie("l'etape 1 est la partie normale",
    categorieDesReglages(cfg1)?.id === "normale", categorieDesReglages(cfg1)?.id ?? "aucune");

  const g1 = new Game(ID, "classique15", cfg1, marqueDeLaMontante(m));
  await g1.start();
  const vue1 = observer(g1, (e) => cloreLEtape(m, e));
  g1.presents.add("alice");
  await g1.reveiller();

  // LA MARQUE DE LA SUITE EST DANS L'EN-TETE, et c'est la seule trace durable
  // qu'une partie appartenait a une montante.
  const e1 = entete(ID);
  verifie("l'en-tete porte la marque de la montante",
    e1?.["montante"]?.["id"] === m.id, JSON.stringify(e1?.["montante"] ?? null));
  verifie("elle dit son rang et son essai",
    e1?.["montante"]?.["etape"] === 1 && e1?.["montante"]?.["essai"] === 1);

  await jouer(g1, "alice");
  verifie("la partie est allee au bout de son sac",
    g1.finie && g1.raisonDeLaFin === "sac", `${g1.moves.length} coups`);

  // ------------------------------------------- 2. ce que l'etape a laisse
  console.log("\n  --- ce que l'etape laisse a la suite ---\n");
  const essai = m.essais[0];
  verifie("l'etape est close et a laisse son essai",
    m.close && m.essais.length === 1);
  verifie("elle compte les coups de la partie",
    essai?.coups === g1.moves.length, `${essai?.coups} contre ${g1.moves.length}`);
  verifie("son temps est celui des coups joues",
    essai?.temps === g1.tempsJoue, `${essai?.temps} contre ${g1.tempsJoue}`);
  verifie("son cumul est celui de la grille",
    essai?.cumul === g1.cumul, `${essai?.cumul} contre ${g1.cumul}`);
  verifie("alice a trouve tous les tops",
    essai?.tops?.["alice"] === g1.moves.length,
    `${essai?.tops?.["alice"] ?? 0} sur ${g1.moves.length}`);
  verifie("aucun coup rate, donc aucun negatif",
    essai?.rates === 0 && essai?.negatif === 0,
    `${essai?.rates} rate(s), negatif ${essai?.negatif}`);
  verifie("l'etape compte pour la montante", essai?.valide === true);
  verifie("sa reference est celle de sa manche",
    essai?.ref === refDeLaGraine(g1.seed), essai?.ref ?? "aucune");
  verifie("rien a reprendre : elle est topee", etapeReprenable(m) === null);
  // L'observation, relue APRES la fin, dit la meme chose que l'essai qu'elle a
  // laisse : c'est la meme lecture, prise deux fois.
  verifie("l'observation et l'essai s'accordent",
    vue1.etape().coups === essai?.coups && vue1.etape().temps === essai?.temps);

  // ---------------------------------------------- 3. l'etape 2 prend le relais
  console.log("\n  --- l'etape 2 prend le relais ---\n");
  verifie("l'hote passe a l'etape 2", passerALEtapeSuivante(m) === 2);
  await g1.stop();
  g1.releaseLock();
  // Une relance archive la partie precedente ; ici on la met simplement de cote
  // pour que la suivante reparte sur un journal neuf, comme le fait le salon.
  nettoyer(ID);

  const cfg2 = configDeLEtape(g1.cfg, 2);
  verifie("l'etape 2 est la partie joker",
    cfg2.joker && cfg2.jokersParCoup === 1
    && categorieDesReglages(cfg2)?.id === "joker",
    categorieDesReglages(cfg2)?.id ?? "aucune");
  verifie("le chrono et le lexique ont traverse",
    cfg2.chrono === cfg1.chrono && cfg2.dictionnaire === cfg1.dictionnaire);

  const g2 = new Game(ID, "classique15", cfg2, marqueDeLaMontante(m));
  await g2.start();
  const vue2 = observer(g2, (e) => cloreLEtape(m, e));
  g2.presents.add("alice");
  await g2.reveiller();
  await g2.demarrer();

  const e2 = entete(ID);
  verifie("l'en-tete de l'etape 2 porte la MEME suite",
    e2?.["montante"]?.["id"] === m.id);
  verifie("et son rang a avance", e2?.["montante"]?.["etape"] === 2);
  verifie("le tirage de l'etape 2 porte un joker",
    g2.rack.includes("?") || g2.rackNotation.includes("?"),
    `${g2.rack} / ${g2.rackNotation}`);

  // ------------------------------- 4. une reprise en pleine partie garde le temps
  console.log("\n  --- une reprise en pleine partie ---\n");
  // On rate le premier coup de l'etape 2 : la reprise s'ouvre.
  await g2.reveal();
  await dors(30);
  verifie("un coup rate ouvre la reprise de l'etape 2",
    etapeReprenable(m, vue2.etape()) === 2, String(etapeReprenable(m, vue2.etape())));
  const avant = totaux(m, vue2.etape());
  verifie("le negatif de l'etape en cours compte", avant.rates === 1 && avant.negatif > 0,
    `${avant.rates} rate(s), negatif ${avant.negatif}`);

  // C'est ce que fait le serveur : il clot l'essai abandonne pour que son temps
  // reste au compteur, puis reprend l'etape.
  const enCours = vue2.etape();
  cloreLEtape(m, enCours);
  verifie("l'etape 2 se reprend", reprendreLEtape(m, 2) === 2);
  const apres = totaux(m);
  verifie("le temps de l'essai abandonne est reste",
    apres.temps === essai!.temps + enCours.temps,
    `${apres.temps} contre ${essai!.temps} + ${enCours.temps}`);
  verifie("son negatif est oublie", apres.negatif === 0 && apres.rates === 0);
  verifie("et l'on rejoue l'etape 2, deuxieme essai",
    m.rang === 2 && m.essai === 2 && !m.close);

  await g2.stop();
  g2.releaseLock();
} finally {
  nettoyer(ID);
  if (existsSync(JOURNAL)) rmSync(JOURNAL);
  if (gardeAPart && existsSync(DE_COTE)) renameSync(DE_COTE, JOURNAL);
}

console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
