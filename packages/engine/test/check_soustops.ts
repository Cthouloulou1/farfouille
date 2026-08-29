/**
 * Toutes les solutions d'un coup, sur un plateau borne. Voir SPEC.md §10.
 *
 *     node packages/engine/test/check_soustops.ts [parties]
 *
 * Le rejeu d'une partie 15x15 montre CHAQUE solution du coup, pas seulement le
 * haut du classement. Deux choses doivent tenir pour que ce soit honnete :
 *
 *   - aucun palier n'est coupe par le milieu. Afficher trois coups a 34 points
 *     sur les neuf qui existent, sans le dire, ferait croire a une liste
 *     complete ;
 *   - le total affiche est bien le total genere.
 *
 * Le test mesure aussi ce que ca coute, parce que c'est la raison pour laquelle
 * les grilles infinies gardent, elles, un plafond.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";
import { configParDefaut, avec } from "../src/config.ts";
import { setLayout } from "../src/bonus.ts";

const PARTIES = Number(process.argv[2] ?? 2);

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);
setLayout("classique");
const cfg = avec(configParDefaut(), { bornes: 7, pioche: "sac102" });

let echecs = 0;
const echoue = (m: string): void => { echecs++; if (echecs <= 8) console.log("  ECHEC :", m); };

let positions = 0;
let coupsTotal = 0;
let coupsMax = 0;
let msTotal = 0;
let octetsTotal = 0;
let octetsMax = 0;

for (let g = 1; g <= PARTIES; g++) {
  const board = new Board(dawg, cfg);
  const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed(`soustops${g}`, 0)));
  let reliquat: string[] = [];

  for (let n = 1; n <= 60; n++) {
    let draw;
    try { draw = bag.draw(reliquat); } catch { break; }
    if (draw.rack.length === 0) break;

    const t0 = performance.now();
    const gen = generateMoves(board, gaddag, draw.rack, { prune: false });
    msTotal += performance.now() - t0;
    if (gen.moves.length === 0) break;
    const r = pickTop(gen.moves, mulberry32(1))!;
    positions++;

    // 1. Rien ne manque : la somme des paliers, c'est tous les coups generes.
    const dansLesPaliers = r.tiers.reduce((s, t) => s + t.length, 0);
    if (dansLesPaliers !== gen.moves.length) {
      echoue(`partie ${g} coup ${n} ${draw.rack} : ${dansLesPaliers} coups dans les paliers `
        + `pour ${gen.moves.length} generes`);
    }

    // 2. Aucun palier coupe : tous les coups d'un meme score sont ensemble.
    const compte = new Map<number, number>();
    for (const m of gen.moves) compte.set(m.score, (compte.get(m.score) ?? 0) + 1);
    for (const t of r.tiers) {
      const sc = t[0]!.score;
      if (t.some((m) => m.score !== sc)) {
        echoue(`partie ${g} coup ${n} : un palier melange plusieurs scores`);
      }
      if (t.length !== compte.get(sc)) {
        echoue(`partie ${g} coup ${n} : palier ${sc} a ${t.length} coups sur ${compte.get(sc)}`);
      }
    }

    // 3. Les paliers descendent, sans doublon de score.
    for (let i = 1; i < r.tiers.length; i++) {
      if (r.tiers[i]![0]!.score >= r.tiers[i - 1]![0]!.score) {
        echoue(`partie ${g} coup ${n} : paliers dans le desordre`);
      }
    }

    coupsTotal += gen.moves.length;
    coupsMax = Math.max(coupsMax, gen.moves.length);
    const charge = JSON.stringify(r.tiers.map((t) => ({
      score: t[0]!.score, moves: t.map((m) => [m.word, m.dir, m.x, m.y]),
    }))).length;
    octetsTotal += charge;
    octetsMax = Math.max(octetsMax, charge);

    board.place(r.top.placements);
    reliquat = Bag.remainder(draw.rack, r.top.placements);
  }
}

console.log(`\nToutes les solutions sur plateau borne\n`);
console.log(`  ${positions} positions sur ${PARTIES} parties de 15x15`);
console.log(`  solutions par position : ${(coupsTotal / positions).toFixed(0)} en moyenne, `
  + `${coupsMax.toLocaleString("fr")} au pire`);
console.log(`  calcul                 : ${(msTotal / positions).toFixed(1)} ms par position`);
console.log(`  poids des paliers      : ${(octetsTotal / positions / 1024).toFixed(1)} Ko en moyenne, `
  + `${(octetsMax / 1024).toFixed(0)} Ko au pire, `
  + `${(octetsTotal / PARTIES / 1024 / 1024).toFixed(2)} Mo par partie entiere`);

console.log(echecs === 0
  ? `\nOK : chaque palier est complet, et la liste ne cache rien\n`
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
