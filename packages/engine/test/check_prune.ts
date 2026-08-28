/**
 * L'elagage des ancrages ne doit RIEN changer au top ni aux isotops.
 *
 * On genere deux fois chaque position -- avec et sans elagage -- et on exige
 * un top identique et un ensemble d'isotops identique.
 *
 * Un cas est surveille a part : le "blanchard", un top pose entierement sur des
 * cases sans le moindre bonus. C'est precisement celui qu'un elagage
 * heuristique ferait disparaitre, puisqu'aucun multiplicateur ne signale
 * l'endroit. Le compteur en fin de rapport dit combien il y en a eu et combien
 * ont survecu.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { bonusAt } from "../src/bonus.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";
import type { Move } from "../src/score.ts";

const GAMES = Number(process.argv[2] ?? 4);
const MOVES = Number(process.argv[3] ?? 60);

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

let failures = 0;
let positions = 0;
let blanchards = 0;
let blanchardsKept = 0;
let msFull = 0;
let msFast = 0;
let anchorsSeen = 0;
let anchorsPruned = 0;

const fail = (m: string) => { failures++; if (failures <= 10) console.log("  ECHEC :", m); };

/** Le coup ne touche-t-il aucune case bonus ? */
function isBlanchard(m: Move): boolean {
  for (const p of m.placements) {
    const b = bonusAt(p.x, p.y);
    if (b.letter !== 1 || b.word !== 1) return false;
  }
  return true;
}

const sig = (ms: readonly Move[]) =>
  ms.map((m) => `${m.dir} ${m.x},${m.y} ${m.word} ${m.score}`).sort().join(" | ");

for (let g = 1; g <= GAMES; g++) {
  const board = new Board(dawg);
  const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed(`prune${g}`, 0)));
  let reliquat: string[] = [];

  for (let n = 1; n <= MOVES; n++) {
    const draw = bag.draw(reliquat);

    const full = generateMoves(board, gaddag, draw.rack, { prune: false });
    const fast = generateMoves(board, gaddag, draw.rack, { prune: true });
    if (full.moves.length === 0) break;
    positions++;
    msFull += full.stats.ms;
    msFast += fast.stats.ms;
    anchorsSeen += fast.stats.anchors + fast.stats.pruned;
    anchorsPruned += fast.stats.pruned;

    const a = pickTop(full.moves, mulberry32(1))!;
    const b = pickTop(fast.moves, mulberry32(1))!;

    if (a.bestScore !== b.bestScore) {
      fail(`partie ${g} coup ${n} ${draw.rack} : meilleur score ${a.bestScore} sans elagage, ${b.bestScore} avec`);
    }
    if (sig(a.isotops) !== sig(b.isotops)) {
      fail(`partie ${g} coup ${n} ${draw.rack} : isotops differents (${a.isotops.length} vs ${b.isotops.length})`);
    }

    if (isBlanchard(a.top)) {
      blanchards++;
      if (a.bestScore === b.bestScore && sig(a.isotops) === sig(b.isotops)) blanchardsKept++;
    }

    board.place(a.top.placements);
    reliquat = Bag.remainder(draw.rack, a.top.placements);
  }
}

console.log(`${positions} positions comparees avec et sans elagage`);
console.log(`ancrages ecartes : ${(100 * anchorsPruned / anchorsSeen).toFixed(1)} % (${anchorsPruned.toLocaleString("fr")} sur ${anchorsSeen.toLocaleString("fr")})`);
console.log(`temps total      : ${(msFull / 1000).toFixed(1)} s sans elagage -> ${(msFast / 1000).toFixed(1)} s avec  (x${(msFull / msFast).toFixed(2)})`);
console.log(`blanchards (top sans aucune case bonus) : ${blanchards} rencontres, ${blanchardsKept} retrouves a l'identique`);
if (blanchards > 0 && blanchardsKept !== blanchards) fail("un blanchard a ete perdu par l'elagage");
console.log(failures === 0
  ? "OK : l'elagage ne change ni le top ni les isotops"
  : `${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
