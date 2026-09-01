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
}
export interface PlaceRequest {
  t: "place";
  placements: Placement[];
}

/**
 * Le meme calcul, mais pour un coup QUI N'EST PAS ENCORE JOUE.
 *
 * Sur une grande grille, chercher le top demande plus d'une seconde : jouee au
 * moment ou le coup precedent tombe, cette seconde est du temps mort a l'ecran.
 * On la prend donc EN AVANCE, pendant que les joueurs cherchent encore.
 *
 * Le calcul est le meme que celui de `solve` ; c'est la SUITE qui differe. Le
 * serveur pose aussitot le top rendu, par un `place` ordinaire, et cherche
 * alors le coup d'apres sur la position d'apres. La partie etant un topping, le
 * coup pose est toujours le top : la position ainsi devinee est la vraie.
 *
 * La pose reste du cote du serveur, et n'est pas faite ici, parce qu'en partie
 * joker elle depend d'une decision qu'il est seul a pouvoir prendre : le joker
 * qui joue un R fait sortir un vrai R du sac, et c'est ce R qu'il faut poser.
 * En consequence le serveur ne renvoie pas de second `place` quand ce coup-la
 * est enfin joue : il serait pose deux fois.
 */
export interface AvanceRequest {
  t: "avance";
  id: number;
  rack: string;
  moveNumber: number;
  tiers: number;
}

/**
 * Refaire les paliers d'un coup PASSE, pour le rejeu.
 *
 * Sur un plateau borne, les paliers ne sont plus ecrits dans le journal : ils
 * en representaient 86 % du poids, et une position s'y resout en cinq
 * millisecondes. On les recalcule donc a la demande, sur une grille reconstruite
 * a partir des coups qui precedent -- au plus une cinquantaine.
 *
 * La grille du solveur n'est pas touchee : elle suit la partie en cours, et la
 * remonter dans le temps lui ferait perdre son cache de croisements.
 */
export interface PaliersRequest {
  t: "paliers";
  id: number;
  rack: string;
  /** Les caramels poses avant ce coup-la. */
  avant: Placement[];
}

/**
 * Combien de coups la grille du solveur porte.
 *
 * Ne sert qu'a se faire confiance : chaque demande dit sur quel numero de coup
 * elle croit tomber, et un desaccord se voit tout de suite plutot que de
 * produire, en silence, le top d'une autre position.
 */
let coupsPoses = 0;

parentPort!.on(
  "message",
  (msg: SolveRequest | PlaceRequest | PaliersRequest | AvanceRequest) => {
  if (msg.t === "place") {
    board.place(msg.placements);
    coupsPoses++;
    return;
  }
  if (msg.t === "paliers") {
    const t0 = performance.now();
    const passe = new Board(dawg, deserialiser(config));
    passe.place(msg.avant);
    const gen = generateMoves(passe, gaddag, msg.rack, { prune: false });
    // La graine ne sert qu'a departager les isotops ; les paliers, eux, ne
    // dependent que de la position et du tirage.
    const top = pickTop(gen.moves, mulberry32(1), passe.cfg.joker);
    parentPort!.postMessage({
      t: "paliers",
      id: msg.id,
      ms: performance.now() - t0,
      tiers: top === null ? [] : top.tiers.map((g) => ({
        score: g[0]!.score,
        moves: g.map((m) => [m.word, m.dir, m.x, m.y] as const),
      })),
    });
    return;
  }
  const t0 = performance.now();
  const gen = generateMoves(board, gaddag, msg.rack, { tiers: msg.tiers, maxMoves: 120 });
  const top = pickTop(
    gen.moves, mulberry32(moveSeed(seed, msg.moveNumber)), board.cfg.joker,
  );
  const result = top === null ? null : {
    top: top.top,
    bestScore: top.bestScore,
    isotops: top.isotops.length,
    tiers: top.tiers.map((g) => ({
      score: g[0]!.score,
      moves: g.map((m) => [m.word, m.dir, m.x, m.y] as const),
    })),
  };
  parentPort!.postMessage({
    t: msg.t === "avance" ? "avancee" : "solved",
    id: msg.id,
    ms: performance.now() - t0,
    coupsPoses,
    result,
  });
});
