/**
 * Recalcule les paliers de score des coups deja joues.
 *
 *     node packages/server/tools/rattraper.ts [partie]
 *
 * Les premieres parties ont ete jouees sans que les isotops ni les sous-tops
 * soient enregistres. Comme la partie est deterministe, on peut les retrouver :
 * on rejoue la grille coup par coup et on redemande au moteur ce qu'il avait
 * calcule a l'epoque.
 *
 * En revanche le MOT REELLEMENT TAPE par le joueur est definitivement perdu :
 * il n'a jamais ete ecrit, et rien ne permet de le reconstituer. Les coups
 * anciens garderont donc le mot retenu par le logiciel.
 *
 * La sauvegarde est archivee avant d'etre remplacee.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { Board } from "../../engine/src/board.ts";
import { Bag, DEFAULT_BAG } from "../../engine/src/bag.ts";
import { generateMoves, pickTop } from "../../engine/src/movegen.ts";
import { setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { mulberry32, moveSeed } from "../../engine/src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../../engine/src/paths.ts";
import type { PlayedMove, Tier } from "../src/game.ts";

const TIERS = 40;
const CAP = 120;

const here = dirname(fileURLToPath(import.meta.url));
const gameId = process.argv[2] ?? "mondiale";
const file = join(here, "..", "data", `${gameId}.json`);

if (!existsSync(file)) {
  console.error(`aucune partie "${gameId}" dans ${file}`);
  process.exit(1);
}

interface Saved {
  gameId: string; layout: LayoutName; seed: string; createdAt?: number;
  moves: PlayedMove[]; players: Record<string, number>; chat?: unknown[];
}

const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
const seed = saved.seed ?? saved.gameId;
setLayout(saved.layout);

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const board = new Board(dawg);
const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed(seed, 0)));

const backup = file.replace(/\.json$/, `.avant-rattrapage.${Date.now()}.json`);
copyFileSync(file, backup);
console.log(`sauvegarde archivee dans ${backup}`);
console.log(`${saved.moves.length} coups a rattraper sur le pavage "${saved.layout}"\n`);

let reliquat: string[] = [];
let done = 0;
let mismatch = 0;
const t0 = Date.now();

for (const m of saved.moves) {
  const draw = bag.draw(reliquat);
  if (draw.rack !== m.rack) {
    mismatch++;
    if (mismatch <= 3) {
      console.warn(
        `  coup ${m.n} : tirage rejoue ${draw.rack}, enregistre ${m.rack} — ` +
        `la partie ne se rejoue pas a l'identique, on s'arrete`,
      );
    }
    break;
  }

  if (m.tiers === undefined) {
    const gen = generateMoves(board, gaddag, draw.rack, { tiers: TIERS, maxMoves: CAP });
    const top = pickTop(gen.moves, mulberry32(moveSeed(seed, m.n)));
    if (top !== null) {
      m.tiers = top.tiers.map((g): Tier => ({
        score: g[0]!.score,
        moves: g.map((q) => [q.word, q.dir, q.x, q.y] as [string, string, number, number]),
      }));
      if (top.top.word !== m.word) {
        console.warn(`  coup ${m.n} : top recalcule ${top.top.word}, enregistre ${m.word}`);
      }
    }
  }

  board.place(m.placements);
  reliquat = Bag.remainder(m.rack, m.placements);
  done++;
  if (done % 25 === 0) {
    const s = (Date.now() - t0) / 1000;
    process.stdout.write(`\r  ${done} / ${saved.moves.length} coups · ${s.toFixed(0)} s`);
  }
}

process.stdout.write("\r" + " ".repeat(60) + "\r");
if (mismatch > 0) {
  console.error(`\nArret au coup ${done + 1} : la partie ne se rejoue pas a l'identique.`);
  console.error(`La sauvegarde n'a PAS ete modifiee. L'archive reste dans ${backup}.`);
  process.exit(1);
}

writeFileSync(file, JSON.stringify(saved), "utf8");
const withTiers = saved.moves.filter((m) => m.tiers !== undefined).length;
console.log(`${done} coups rejoues en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`${withTiers} / ${saved.moves.length} coups ont desormais leurs paliers`);
console.log(`\nLe mot reellement tape par les joueurs reste absent des coups anciens :`);
console.log(`il n'a jamais ete enregistre et ne peut pas etre reconstitue.`);
