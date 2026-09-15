/**
 * Une partie figee se rejoue a l'identique, et une manche se met en pause.
 * Voir SPEC.md §29.
 *
 *     node packages/server/test/check_figees.ts
 *
 * Trois choses doivent tenir :
 *
 * 1. LA PARTIE FIGEE EST LA PARTIE. Figer, c'est jouer une vraie partie en
 *    revelant chaque top : une partie ordinaire lancee sur la meme graine doit
 *    donner les memes tirages, les memes tops et la meme fin.
 * 2. UN SALON QUI LA SERT LA REJOUE COUP POUR COUP, sans pioche ni solveur, et
 *    sa grille finit caramel pour caramel comme celle de la partie d'origine --
 *    jokers compris.
 * 3. LA PAUSE GARDE LE TEMPS. Un coup mis en pause reprend au temps qu'il avait,
 *    y compris apres un redemarrage du serveur.
 *
 * Les parties de ce test portent des noms a elles, et sont retirees par ces
 * noms-la en fin de test. Rien d'autre du dossier de donnees n'est touche.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game, type PartieFigee } from "../src/game.ts";
import { figerUnePartie } from "../src/figees.ts";
import { configDuModele, jourDe, nomDeLaPartie, PARTIES_DU_JOUR } from "../../engine/src/epreuves.ts";
import { avec } from "../../engine/src/config.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const IDS = ["figees-test-ordinaire", "figees-test-servie", "figees-test-joker", "figees-test-pause"];

function nettoyer(): void {
  for (const id of IDS) {
    for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json", ".paliers.jsonl"]) {
      const f = join(D, `${id}${s}`);
      if (existsSync(f)) rmSync(f);
    }
  }
}

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(60)} ${detail}`);
  if (!ok) echecs++;
}
const dors = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Revele chaque top jusqu'a la fin : la partie d'un joueur qui ne trouve rien. */
async function jusquAuBout(g: Game): Promise<void> {
  let immobile = 0;
  while (!g.finie && immobile < 400) {
    const avant = g.moves.length;
    await g.reveal();
    if (g.moves.length === avant) { immobile++; await dors(25); } else immobile = 0;
  }
}

const grille = (g: Game): string =>
  g.tiles().map((t) => `${t.x},${t.y}${t.l}${t.b}`).sort().join(" ");

console.log("\nLes parties figees\n");
nettoyer();

// ------------------------------------------------------------------ le jour
verifie("le jour change a 5 h 30, heure d'ete",
  jourDe(Date.parse("2026-09-15T03:29:00Z")) === "2026-09-14"
  && jourDe(Date.parse("2026-09-15T03:30:00Z")) === "2026-09-15");
verifie("le jour change a 5 h 30, heure d'hiver",
  jourDe(Date.parse("2026-12-15T04:29:00Z")) === "2026-12-14"
  && jourDe(Date.parse("2026-12-15T04:30:00Z")) === "2026-12-15");
verifie("la nuit du changement d'heure", jourDe(Date.parse("2026-10-25T04:30:00Z")) === "2026-10-25"
  && jourDe(Date.parse("2026-10-25T03:30:00Z")) === "2026-10-24");
verifie("les noms des parties",
  nomDeLaPartie({ tirage: 7, jouables: 7, joker: false, bornes: 7, chrono: 60 }) === "Normale, 60s"
  && nomDeLaPartie({ tirage: 9, jouables: 5, joker: false, bornes: 7, chrono: 90 }) === "5/9, 1min30"
  && nomDeLaPartie({ tirage: 11, jouables: 11, joker: false, bornes: 10, chrono: 180 })
    === "11/11, super grille, 3min"
  && nomDeLaPartie({ tirage: 7, jouables: 7, joker: false, bornes: 10, chrono: 60 })
    === "Normale, super grille, 60s"
  && nomDeLaPartie({ tirage: 7, jouables: 7, joker: true, bornes: 7, chrono: 120 }) === "Joker, 2min");

// ----------------------------------------------- 1. la partie figee est la partie
const cfg = configDuModele(PARTIES_DU_JOUR["ods9"]![0]!, "ods9");
const t0 = Date.now();
const figee = await figerUnePartie(cfg, "pave1", "graine-de-test-figees");
verifie("une partie normale se fige", figee.coups.length >= 15 && figee.fin.raison === "sac",
  `${figee.coups.length} coups en ${Date.now() - t0} ms`);
verifie("elle n'a laisse aucun fichier de travail",
  !existsSync(join(D, `figee-${figee.id}.journal.jsonl`)));

const ordinaire = new Game(IDS[0]!, "pave1", avec(cfg, { chrono: null }), null, { graine: figee.graine });
await ordinaire.start();
ordinaire.presents.add("essai");
await ordinaire.reveiller();
await ordinaire.demarrer();
await jusquAuBout(ordinaire);
const memes = ordinaire.moves.length === figee.coups.length && ordinaire.moves.every((m, i) => {
  const c = figee.coups[i]!;
  return m.rack === c.rack && m.word === c.word && m.x === c.x && m.y === c.y
    && m.dir === c.dir && m.score === c.score;
});
verifie("une partie ordinaire sur la meme graine joue la meme partie", memes,
  `${ordinaire.moves.length} coups contre ${figee.coups.length}`);
const grilleOrdinaire = grille(ordinaire);
await ordinaire.stop();

// ------------------------------------ 2. un salon qui la sert la rejoue coup pour coup
async function servir(id: string, f: PartieFigee, c = cfg): Promise<Game> {
  const g = new Game(id, "pave1", c, null, { figee: f, epreuve: true });
  await g.start();
  g.presents.add("essai");
  await g.reveiller();
  await g.demarrer();
  return g;
}
const servie = await servir(IDS[1]!, figee);
const premierTirage = servie.rack;
await jusquAuBout(servie);
verifie("le premier tirage servi est celui de la partie figee", premierTirage === figee.coups[0]!.rack);
verifie("la partie servie a les memes coups",
  servie.moves.length === figee.coups.length
  && servie.moves.every((m, i) => m.word === figee.coups[i]!.word && m.score === figee.coups[i]!.score));
verifie("elle finit comme la partie figee", servie.finie && servie.raisonDeLaFin === figee.fin.raison);
verifie("sa grille est la meme, caramel pour caramel", grille(servie) === grilleOrdinaire);
await servie.stop();

// Et relue au journal : une manche reprise apres un redemarrage retrouve ses coups.
const relue = new Game(IDS[1]!, "pave1", cfg, null, { figee, epreuve: true });
await relue.start();
verifie("la partie servie se relit a son journal", relue.moves.length === figee.coups.length
  && grille(relue) === grilleOrdinaire);
await relue.stop();

// ------------------------------------------------------------- en partie joker
const cfgJ = configDuModele(PARTIES_DU_JOUR["csw24"]![2]!, "csw24");
const figeeJ = await figerUnePartie(cfgJ, "pave1", "graine-de-test-joker");
const servieJ = await servir(IDS[2]!, figeeJ, cfgJ);
await jusquAuBout(servieJ);
const jokersPoses = figeeJ.coups.filter((c) => c.jokers !== undefined).length;
verifie("une partie joker figee se rejoue a l'identique",
  servieJ.moves.length === figeeJ.coups.length
  && servieJ.moves.every((m, i) => m.word === figeeJ.coups[i]!.word
    && JSON.stringify(m.jokers ?? null) === JSON.stringify(figeeJ.coups[i]!.jokers ?? null)),
  `${figeeJ.coups.length} coups, ${jokersPoses} avec une trace de joker`);
await servieJ.stop();

// ---------------------------------------------------------------- 3. la pause
const avecChrono = avec(cfg, { chrono: 30 });
const p = new Game(IDS[3]!, "pave1", avecChrono, null, { figee, epreuve: true });
await p.start();
p.presents.add("essai");
await p.reveiller();
await p.demarrer();
await dors(400);
verifie("la pause prend", p.mettreEnPause() && p.enPause);
const ecoule = p.ecoulePause;
verifie("elle retient ce que le coup avait dure", ecoule >= 350 && ecoule < 1500, `${ecoule} ms`);
const refus = await p.attempt("essai", "H", 0, 0, "ZZ");
verifie("en pause, un mot ne part pas", !refus.ok && refus.message === "la partie est en pause");
await dors(600);
p.reprendre();
const apres = Date.now() - p.servedAt;
verifie("la reprise repart du temps d'avant la pause", apres >= ecoule && apres < ecoule + 200,
  `${apres} ms au lieu de ${ecoule + 600} ms`);
await dors(300);
// Le joueur ferme sa page : la manche se met en pause d'elle-meme.
p.endormir();
const avantArret = p.ecoulePause;
verifie("fermer la page met en pause", p.enPause && avantArret >= ecoule + 250, `${avantArret} ms`);
await p.stop();
await dors(200);

const reprise = new Game(IDS[3]!, "pave1", avecChrono, null, { figee, epreuve: true });
await reprise.start();
reprise.presents.add("essai");
await reprise.reveiller();
verifie("apres un redemarrage, la manche est toujours en pause", reprise.enPause
  && Math.abs(reprise.ecoulePause - avantArret) < 5, `${reprise.ecoulePause} ms`);
verifie("et sur le meme coup", reprise.moves.length === 0 && reprise.rack === figee.coups[0]!.rack);
reprise.reprendre();
await reprise.reveal();
verifie("le coup joue apres la reprise compte le temps d'avant l'arret",
  reprise.moves[0] !== undefined && reprise.moves[0].ms >= avantArret,
  `${reprise.moves[0]?.ms} ms`);
await reprise.stop();

nettoyer();
console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
