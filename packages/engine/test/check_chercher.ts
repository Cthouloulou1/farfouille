/**
 * Chercher un mot donne trouve EXACTEMENT ce que le solveur aurait trouve.
 *
 *     node packages/engine/test/check_chercher.ts
 *
 * Sur une grille infinie, seuls les cent premiers paliers sont enregistres :
 * l'immense majorite des coups jouables n'existe nulle part, et chercher « MA »
 * dans le rejeu ne rendait rien. Le balayage cible repond a la question sans
 * refaire la generation complete -- mais il ne vaut que s'il rend LA MEME
 * CHOSE.
 *
 * C'est ce que ce test etablit : on genere tous les coups d'une position avec
 * le solveur, et pour chaque mot rencontre on verifie que le balayage retrouve
 * les memes placements, aux memes scores, ni un de plus ni un de moins.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { generateMoves } from "../src/movegen.ts";
import { chercherLeMot } from "../src/chercher.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";
import { setLayout } from "../src/bonus.ts";
import { configParDefaut, avec } from "../src/config.ts";
import { mulberry32 } from "../src/rng.ts";
import { SacFini } from "../src/sac.ts";

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(56)} ${detail}`);
  if (!ok) echecs++;
}

/** Une signature stable d'un ensemble de placements. */
const signer = (l: readonly { dir: string; x: number; y: number; score: number }[]): string =>
  [...l].map((m) => `${m.dir}${m.x},${m.y}:${m.score}`).sort().join(" ");

console.log("\nChercher un mot donne\n");

for (const [nom, bornes] of [["15x15", 7], ["grille infinie", null]] as const) {
  setLayout("classique");
  const cfg = avec(configParDefaut(), { bornes, pioche: "sac102" });
  const board = new Board(dawg, cfg);
  const sac = new SacFini(undefined, mulberry32(4), 7);

  // On joue une dizaine de coups pour ouvrir la position.
  let reliquat: string[] = [];
  let dernierRack = "";
  for (let coup = 0; coup < 10; coup++) {
    const d = sac.draw(reliquat);
    dernierRack = d.rack;
    const gen = generateMoves(board, gaddag, d.rack, { maxMoves: 1 });
    const m = gen.moves[0];
    if (m === undefined) break;
    board.place(m.placements);
    reliquat = [];
  }

  // Tous les coups de la position, avec le dernier tirage.
  const tous = generateMoves(board, gaddag, dernierRack, { prune: false }).moves;
  const parMot = new Map<string, typeof tous>();
  for (const m of tous) {
    const l = parMot.get(m.word);
    if (l === undefined) parMot.set(m.word, [m]); else l.push(m);
  }

  console.log(`  ${nom} : ${board.size} caramels, tirage ${dernierRack}, ` +
    `${tous.length} coups en ${parMot.size} mots`);

  // Vingt mots pris dans le lot, du plus frequent au plus rare.
  const mots = [...parMot.keys()].sort((a, b) =>
    parMot.get(b)!.length - parMot.get(a)!.length || a.localeCompare(b)).slice(0, 20);
  let faute: string | null = null;
  for (const mot of mots) {
    const attendu = signer(parMot.get(mot)!);
    const obtenu = signer(chercherLeMot(board, dawg, mot, dernierRack));
    if (attendu !== obtenu && faute === null) {
      faute = `${mot} : le solveur donne « ${attendu.slice(0, 90)} », `
        + `le balayage « ${obtenu.slice(0, 90) || "rien"} »`;
    }
  }
  verifie(`${nom} : vingt mots, memes placements et memes scores`, faute === null,
    faute ?? `${mots.length} mots eprouves`);

  // Un mot que le solveur n'a PAS retenu ne doit pas apparaitre non plus.
  const absent = chercherLeMot(board, dawg, "ZZZZZ", dernierRack);
  verifie(`${nom} : un mot hors dictionnaire ne rend rien`, absent.length === 0,
    `${absent.length}`);

  // Et un mot du dictionnaire qu'on ne peut pas former : rien non plus.
  const impossible = chercherLeMot(board, dawg, "KWAS", "AAAAAAA");
  verifie(`${nom} : un mot que le tirage ne permet pas ne rend rien`,
    impossible.length === 0, `${impossible.length}`);
}

// --- Le cas qui motive tout : un petit mot au-dela des cent paliers ---------
{
  setLayout("classique");
  const cfg = avec(configParDefaut(), { bornes: null, pioche: "sac102boucle" });
  const board = new Board(dawg, cfg);
  const sac = new SacFini(undefined, mulberry32(11), 7);
  sac.recharge = true;
  let reliquat: string[] = [];
  let rack = "";
  for (let coup = 0; coup < 40; coup++) {
    const d = sac.draw(reliquat);
    rack = d.rack;
    const gen = generateMoves(board, gaddag, d.rack, { maxMoves: 1 });
    const m = gen.moves[0];
    if (m === undefined) break;
    board.place(m.placements);
    reliquat = [];
  }
  // Les cent premiers paliers, comme les garde une grille infinie.
  const gen = generateMoves(board, gaddag, rack, { tiers: 100, maxMoves: 120 });
  const enregistres = new Set(gen.moves.map((m) => `${m.word}|${m.dir}|${m.x}|${m.y}`));

  // Un mot court, jouable, et absent des paliers enregistres.
  const tous = generateMoves(board, gaddag, rack, { prune: false }).moves;
  const oublie = tous.find((m) => m.word.length === 2
    && !enregistres.has(`${m.word}|${m.dir}|${m.x}|${m.y}`));
  if (oublie === undefined) {
    verifie("un petit mot echappe bien aux cent paliers", false, "aucun trouve");
  } else {
    const r = chercherLeMot(board, dawg, oublie.word, rack);
    const bon = r.some((t) => t.dir === oublie.dir && t.x === oublie.x && t.y === oublie.y
      && t.score === oublie.score);
    verifie(`« ${oublie.word} » est hors des paliers, le balayage le retrouve`, bon,
      `${r.length} placements, ${oublie.score} pts en ${oublie.dir} ${oublie.x},${oublie.y}`);
  }
}

console.log(echecs === 0
  ? "\nOK : le balayage rend exactement ce que le solveur aurait trouve\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
