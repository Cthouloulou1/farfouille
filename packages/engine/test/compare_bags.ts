/**
 * Le taux de scrabbles vient-il de la table de poids, ou de la grille infinie ?
 *
 * On rejoue la meme partie avec les frequences du sac classique (102 caramels)
 * et avec la table calibree. Si les deux donnent le meme taux, la cause est la
 * grille, pas les probabilites.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { simulate } from "../src/simulate.ts";
import { DEFAULT_BAG, type BagConfig } from "../src/bag.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

const CLASSIC: BagConfig = {
  ...DEFAULT_BAG,
  weights: {
    A: 9, B: 2, C: 2, D: 3, E: 15, F: 2, G: 2, H: 2, I: 8, J: 1, K: 1, L: 5, M: 3,
    N: 6, O: 6, P: 2, Q: 1, R: 6, S: 6, T: 6, U: 6, V: 2, W: 1, X: 1, Y: 1, Z: 1,
  },
  blankWeight: 2,
};

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
const N = Number(process.argv[2] ?? 100);

for (const [label, cfg] of [["sac classique 102 caramels", CLASSIC], ["table calibree", DEFAULT_BAG]] as const) {
  let bingos = 0, moves = 0, score = 0, rej = 0;
  for (const seed of ["a", "b", "c"]) {
    const log = simulate(N, seed, dawg, gaddag, cfg);
    for (const r of log) {
      moves++;
      score += r.move.score;
      rej += r.rejections;
      if (r.move.placements.length === 7) bingos++;
    }
  }
  console.log(
    `${label.padEnd(28)} scrabbles ${(100 * bingos / moves).toFixed(1)} %   ` +
    `score moyen ${(score / moves).toFixed(1)}   rejets ${(100 * rej / (rej + moves)).toFixed(1)} %`,
  );
}
