/**
 * Test croise du generateur GADDAG contre le generateur de reference naif.
 *
 * Joue des parties aleatoires et, a chaque coup, verifie que :
 *   - les deux generateurs produisent EXACTEMENT le meme ensemble de coups ;
 *   - chaque coup produit est legal et son score se recalcule a l'identique ;
 *   - le cache des cross-checks donne le meme resultat qu'un recalcul complet.
 *
 * Le troisieme point est le plus important : l'invalidation incrementale du
 * cache est l'optimisation la plus risquee du moteur, et un cache perime
 * produirait des coups faux de facon silencieuse.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { mulberry32 } from "../src/rng.ts";
import { keyX, keyY } from "../src/coords.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";
import { generateMovesNaive, signature, validateMove } from "./reference.ts";

const GAMES = Number(process.argv[2] ?? 12);
const MOVES = Number(process.argv[3] ?? 10);

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

let failures = 0;
let checkedMoves = 0;
let checkedPositions = 0;
let totalGenerated = 0;

function fail(msg: string): void {
  failures++;
  if (failures <= 12) console.log("  ECHEC :", msg);
}

/** Le cache incremental doit donner exactement le meme resultat qu'un recalcul. */
function checkCrossCache(board: Board): void {
  const probes: [number, number][] = [];
  for (const k of board.anchors) probes.push([keyX(k), keyY(k)]);
  const b = board.bounds();
  if (b) {
    for (let x = b.minX - 2; x <= b.maxX + 2; x++) {
      for (let y = b.minY - 2; y <= b.maxY + 2; y++) if (!board.occupied(x, y)) probes.push([x, y]);
    }
  }
  const cached = probes.map(([x, y]) => {
    const h = board.crossCheck("H", x, y);
    const v = board.crossCheck("V", x, y);
    return `${h.mask},${h.score},${h.has}|${v.mask},${v.score},${v.has}`;
  });
  board.clearCrossCache();
  probes.forEach(([x, y], i) => {
    const h = board.crossCheck("H", x, y);
    const v = board.crossCheck("V", x, y);
    const fresh = `${h.mask},${h.score},${h.has}|${v.mask},${v.score},${v.has}`;
    if (fresh !== cached[i]) {
      fail(`cache de cross-check perime en ${x},${y} : cache "${cached[i]}" vs recalcul "${fresh}"`);
    }
  });
}

const t0 = performance.now();

for (let g = 1; g <= GAMES; g++) {
  const board = new Board(dawg);
  const bag = new Bag(DEFAULT_BAG, mulberry32(g * 7919));
  let reliquat: string[] = [];

  for (let n = 1; n <= MOVES; n++) {
    const draw = bag.draw(reliquat);
    const rack = draw.rack;

    // Sans elagage : ce test compare l'ensemble COMPLET des coups, alors que
    // l'elagage ne garantit que le top et ses isotops (voir check_prune.ts).
    const fast = generateMoves(board, gaddag, rack, { prune: false });
    const slow = generateMovesNaive(board, dawg, rack);
    checkedPositions++;
    totalGenerated += fast.moves.length;

    const a = signature(fast.moves);
    const b = signature(slow);
    if (a.length !== b.length || a.some((s, i) => s !== b[i])) {
      const setA = new Set(a), setB = new Set(b);
      const missing = b.filter((s) => !setA.has(s));
      const extra = a.filter((s) => !setB.has(s));
      fail(
        `partie ${g} coup ${n} tirage ${rack} : GADDAG ${a.length} coups, reference ${b.length}\n` +
        `      manques par le GADDAG : ${missing.slice(0, 4).join(" | ") || "aucun"}\n` +
        `      en trop dans le GADDAG : ${extra.slice(0, 4).join(" | ") || "aucun"}`,
      );
    }

    for (const m of fast.moves) {
      const err = validateMove(board, dawg, rack, m);
      if (err) fail(`partie ${g} coup ${n} tirage ${rack} : ${err}`);
      checkedMoves++;
    }

    if (fast.moves.length === 0) break;

    const top = pickTop(fast.moves, mulberry32(g * 1000 + n));
    if (!top) break;
    board.place(top.top.placements);
    checkCrossCache(board);
    reliquat = Bag.remainder(rack, top.top.placements);
  }
}

const secs = (performance.now() - t0) / 1000;
console.log(
  `${checkedPositions} positions, ${checkedMoves.toLocaleString("fr")} coups verifies ` +
  `(${totalGenerated.toLocaleString("fr")} generes) en ${secs.toFixed(1)} s`,
);
console.log(failures === 0
  ? "OK : les deux generateurs sont d'accord, tous les coups sont legaux, le cache est sain"
  : `${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
