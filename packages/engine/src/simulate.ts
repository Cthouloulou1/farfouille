/**
 * Simulateur headless : joue une partie tout seul et mesure.
 *
 * C'est le livrable de la phase 0 (SPEC.md §14). Il repond aux questions qu'on
 * a laissees ouvertes faute de donnees : combien d'isotops par coup, comment le
 * temps de calcul evolue avec la taille de la grille, a quoi ressemble une
 * grille infinie en fin de partie, et si le pavage 15x15 produit des scores
 * aberrants a ses coutures.
 *
 * Bibliotheque pure : aucun effet de bord a l'import. Le rapport en ligne de
 * commande vit dans tools/report.ts.
 */
import { Dict } from "./dictionary.ts";
import { Board } from "./board.ts";
import { Bag, DEFAULT_BAG, type BagConfig } from "./bag.ts";
import { generateMoves, pickTop } from "./movegen.ts";
import { mulberry32, moveSeed } from "./rng.ts";
import { bonusAt } from "./bonus.ts";
import type { Move } from "./score.ts";

export interface MoveRecord {
  n: number;
  rack: string;
  notation: string;
  rejections: number;
  move: Move;
  isotops: number;
  /** Coups reellement produits par la descente (pas ceux retenus). */
  candidates: number;
  /** Couples (ancrage, sens) explores, apres elagage. */
  anchors: number;
  tiles: number;
  genMs: number;
  wordMult: number;
}

export function simulate(
  moves: number, gameId: string, dawg: Dict, gaddag: Dict,
  bagConfig: BagConfig = DEFAULT_BAG,
): MoveRecord[] {
  const board = new Board(dawg);
  const bag = new Bag(bagConfig, mulberry32(moveSeed(gameId, 0)));
  const log: MoveRecord[] = [];
  let reliquat: string[] = [];

  for (let n = 1; n <= moves; n++) {
    const draw = bag.draw(reliquat);
    const gen = generateMoves(board, gaddag, draw.rack);
    if (gen.moves.length === 0) break;

    const top = pickTop(gen.moves, mulberry32(moveSeed(gameId, n)));
    if (top === null) break;

    // Multiplicateur de mot cumule : detecte les cases bonus qui se cumulent.
    let wordMult = 1;
    for (const p of top.top.placements) wordMult *= bonusAt(p.x, p.y).word;

    log.push({
      n, rack: draw.rack, notation: draw.notation, rejections: draw.rejections,
      move: top.top, isotops: top.isotops.length, candidates: gen.stats.raw,
      anchors: gen.stats.anchors, tiles: board.size, genMs: gen.stats.ms, wordMult,
    });

    board.place(top.top.placements);
    reliquat = Bag.remainder(draw.rack, top.top.placements);
  }
  return log;
}
