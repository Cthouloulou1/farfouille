/**
 * Les coups calcules d'avance sont les MEMES que ceux calcules en direct.
 * Voir SPEC.md §17.
 *
 *     node packages/server/test/check_avance.ts
 *
 * Le serveur prend de l'avance : pendant qu'un coup se joue, il pose deja son
 * top sur la grille du solveur, tire les tirages suivants dans une COPIE de sa
 * pioche, et en cherche les tops. C'est ce qui supprime l'attente entre deux
 * coups sur une grande grille.
 *
 * Tout repose sur une propriete : le coup pose est toujours le top, donc la
 * suite de la partie est deja ecrite au moment ou le coup commence. Si cette
 * propriete etait mal exploitee -- une grille de solveur decalee d'un coup, une
 * pioche qui derive, un coup pose deux fois -- les tops servis seraient ceux
 * d'une AUTRE position, et rien a l'ecran ne le dirait.
 *
 * On joue donc une partie entiere, puis on recalcule chaque top depuis zero,
 * avec le moteur seul, sans le serveur. Les deux doivent coincider exactement :
 * meme mot, meme sens, meme case, meme score.
 */
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { configParDefaut, avec } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";
import { Board } from "../../engine/src/board.ts";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { generateMoves, pickTop } from "../../engine/src/movegen.ts";
import { mulberry32, moveSeed } from "../../engine/src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../../engine/src/paths.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "avance-test";

function nettoyer(): void {
  for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${ID}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(52)} ${detail}`);
  if (!ok) echecs++;
}
const dors = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\nLes coups calcules d'avance\n");
nettoyer();

setLayout("classique");
const cfg = avec(configParDefaut(), { bornes: 7, pioche: "sac102", chrono: null });
const g = new Game(ID, "classique", cfg);
await g.start();
g.presents.add("essai");
await g.reveiller();
await g.demarrer();

// DEUX RYTHMES, parce qu'ils n'empruntent pas le meme chemin.
//
// Coup sur coup, la file n'a pas le temps de se remplir : le serveur ATTEND le
// pas de calcul deja lance plutot que d'en lancer un second en parallele.
// Avec une respiration, la file prend ses cinq coups d'avance et les coups
// suivants sont servis sans le moindre calcul.
for (let i = 0; i < 8 && !g.finie; i++) await g.reveal();
const directsAuGalop = g.calculsDirects;
const pretsAvant = g.coupsPrets;
for (let i = 0; i < 8 && !g.finie; i++) { await dors(250); await g.reveal(); }

verifie("la partie a avance", g.moves.length >= 15, `${g.moves.length} coups`);
// A LA CADENCE D'UNE TABLE, la file prend ses cinq coups d'avance et plus rien
// ne s'attend : c'est le seul rythme qui ressemble a une vraie partie.
verifie("a la cadence d'une table, plus aucune attente",
  g.coupsPrets - pretsAvant >= 7, `${g.coupsPrets - pretsAvant} coups sur 8`);
// AU GALOP, l'avance n'a pas le temps de se constituer -- mais le serveur ne
// doit pas pour autant relancer en parallele le calcul qui court deja. Seul le
// tout premier coup se cherche vraiment en direct.
verifie("coup sur coup, rien n'est calcule deux fois", directsAuGalop <= 2,
  `${directsAuGalop} calcul(s) en direct sur 9 coups servis`);

// LE JUGE DE PAIX : on refait toute la partie avec le moteur seul.
const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const plateau = new Board(dawg, cfg);
let faux = 0, premierFaux = "";
for (const m of g.moves) {
  const gen = generateMoves(plateau, gaddag, m.rack, { tiers: 40, maxMoves: 120 });
  const top = pickTop(gen.moves, mulberry32(moveSeed(g.seed, m.n)), cfg.joker);
  const attendu = top === null ? null : top.top;
  const pareil = attendu !== null && attendu.word === m.word && attendu.dir === m.dir
    && attendu.x === m.x && attendu.y === m.y && attendu.score === m.score;
  if (!pareil) {
    faux++;
    if (premierFaux === "") {
      premierFaux = `coup ${m.n} : ${m.word} ${m.score} pts, attendu ` +
        (attendu === null ? "aucun coup" : `${attendu.word} ${attendu.score} pts`);
    }
  }
  plateau.place(m.placements);
}
verifie("chaque top joue est bien LE top de sa position", faux === 0,
  faux === 0 ? `${g.moves.length} coups verifies un a un` : premierFaux);

// Le tirage de chaque coup doit aussi etre celui que la pioche aurait servi :
// c'est ce qui distingue une avance juste d'une avance qui invente. On le
// verifie en rejouant la partie depuis son journal -- la reprise refait les
// pioches dans l'ordre, et un ecart la ferait diverger.
const servieAvant = g.servedAt;
await g.stop();
await dors(400);
const relu = new Game(ID, "classique", cfg);
await relu.start();
const memesTirages = relu.moves.length === g.moves.length
  && relu.moves.every((m, i) => m.rack === g.moves[i]!.rack && m.word === g.moves[i]!.word);
verifie("la partie relue au journal est la meme", memesTirages,
  `${relu.moves.length} coups rejoues`);

// L'HEURE DU COUP EN COURS SURVIT AU REDEMARRAGE, sur une grille sans chrono.
// Le coup n'a pas ete joue : il reprend a l'age qu'il avait, temps d'arret
// compris. C'est le vrai temps ecoule depuis qu'il a commence.
relu.presents.add("essai");
await relu.reveiller();
const ecart = Math.abs(relu.servedAt - servieAvant);
verifie("l'heure du tirage a survecu a l'arret", ecart < 50,
  `${(Date.now() - relu.servedAt) / 1000 | 0} s d'age retrouves, a ${ecart} ms pres`);
await relu.stop();

nettoyer();
console.log(echecs === 0
  ? "\nOK : ce qui est calcule d'avance est exactement ce qui aurait ete calcule\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
