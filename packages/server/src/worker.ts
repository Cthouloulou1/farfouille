/**
 * Fil d'execution dedie au calcul des tops.
 *
 * Un tirage a deux jokers sur une grille ouverte demande plusieurs secondes.
 * Le faire sur le fil principal figerait le serveur -- plus de WebSocket, plus
 * de reponse a personne. Le solveur vit donc a part.
 *
 * Il garde sa PROPRE copie de la grille et ne recoit que les coups joues :
 * reconstruire la grille a chaque appel viderait le cache des cross-checks, qui
 * est le principal levier de performance du moteur.
 */
import { parentPort, workerData } from "node:worker_threads";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { Board } from "../../engine/src/board.ts";
import { generateMoves, pickTop } from "../../engine/src/movegen.ts";
import { setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { deserialiser, type ConfigSerialisee } from "../../engine/src/config.ts";
import { mulberry32, moveSeed } from "../../engine/src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../../engine/src/paths.ts";
import type { Placement } from "../../engine/src/board.ts";

const { layout, seed, config } = workerData as {
  layout: LayoutName; seed: string; config: ConfigSerialisee;
};
setLayout(layout);

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
// La grille du solveur porte la MEME configuration que celle du serveur, sinon
// il calculerait des tops pour une autre variante.
const board = new Board(dawg, deserialiser(config));

export interface SolveRequest {
  t: "solve";
  id: number;
  rack: string;
  moveNumber: number;
  /** Paliers de sous-tops a renvoyer, pour l'inspection. */
  tiers: number;
  /**
   * Garder TOUTES les solutions du coup, sans plafond.
   *
   * Reserve aux grilles bornees. Mesure sur trois parties de 15x15 : 537 coups
   * distincts par position en moyenne, 6 755 au pire, pour 4,7 ms de calcul au
   * lieu de 4,1 et 0,44 Mo par partie entiere -- autant dire rien.
   *
   * Sur une grille infinie ce serait 15 333 coups par position, 166 659 au
   * pire, et 35 Mo pour cent vingt coups : la grille grandit sans fin, donc le
   * nombre d'ancrages aussi, et avec lui le nombre de solutions.
   */
  tousLesPaliers?: boolean;
}
export interface PlaceRequest {
  t: "place";
  placements: Placement[];
}

parentPort!.on("message", (msg: SolveRequest | PlaceRequest) => {
  if (msg.t === "place") {
    board.place(msg.placements);
    return;
  }
  const t0 = performance.now();
  const gen = msg.tousLesPaliers === true
    ? generateMoves(board, gaddag, msg.rack, { prune: false })
    : generateMoves(board, gaddag, msg.rack, { tiers: msg.tiers, maxMoves: 120 });
  const top = pickTop(
    gen.moves, mulberry32(moveSeed(seed, msg.moveNumber)), board.cfg.joker,
  );
  parentPort!.postMessage({
    t: "solved",
    id: msg.id,
    ms: performance.now() - t0,
    result: top === null ? null : {
      top: top.top,
      bestScore: top.bestScore,
      isotops: top.isotops.length,
      tiers: top.tiers.map((g) => ({
        score: g[0]!.score,
        moves: g.map((m) => [m.word, m.dir, m.x, m.y] as const),
      })),
    },
  });
});
