/**
 * La saisie joueur et le generateur doivent tomber d'accord.
 *
 * Pour chaque coup que le generateur trouve, on simule ce que le joueur
 * taperait -- ses lettres a lui, le curseur enjambant les caramels deja poses --
 * et on exige le MEME mot et le MEME score. Sans quoi le serveur refuserait des
 * mots que l'ecran vient d'accepter.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { resolveTypedWord, PLAY_MESSAGE } from "../src/play.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { step } from "../src/coords.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";
import type { Move } from "../src/score.ts";

const GAMES = Number(process.argv[2] ?? 3);
const MOVES = Number(process.argv[3] ?? 25);
const PER_POSITION = 300;

const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

let failures = 0;
let checked = 0;
const fail = (m: string) => { failures++; if (failures <= 10) console.log("  ECHEC :", m); };

/** Ce que le joueur tape : ses lettres a lui, dans l'ordre, sans les existantes. */
function typedFor(m: Move): string {
  const { dx, dy } = step(m.dir);
  const set = new Map(m.placements.map((p) => [`${p.x},${p.y}`, p.letter]));
  let out = "";
  for (let i = 0; i < m.word.length; i++) {
    const k = `${m.x + dx * i},${m.y + dy * i}`;
    const p = set.get(k);
    if (p !== undefined) out += p;
  }
  return out;
}

for (let g = 1; g <= GAMES; g++) {
  const board = new Board(dawg);
  const bag = new Bag(DEFAULT_BAG, mulberry32(moveSeed(`play${g}`, 0)));
  let reliquat: string[] = [];

  for (let n = 1; n <= MOVES; n++) {
    const draw = bag.draw(reliquat);
    const gen = generateMoves(board, gaddag, draw.rack, { prune: false });
    if (gen.moves.length === 0) break;

    // Un echantillon deterministe des coups de la position.
    const stepBy = Math.max(1, Math.floor(gen.moves.length / PER_POSITION));
    for (let i = 0; i < gen.moves.length; i += stepBy) {
      const m = gen.moves[i]!;
      const typed = typedFor(m);
      const r = resolveTypedWord(board, dawg, m.dir, m.x, m.y, typed, draw.rack);
      checked++;
      if (!r.ok) {
        fail(`partie ${g} coup ${n} : "${typed}" en ${m.dir} ${m.x},${m.y} refuse (${PLAY_MESSAGE[r.error]}), attendu ${m.word} ${m.score} pts`);
        continue;
      }
      if (r.move.word !== m.word) { fail(`mot different : ${r.move.word} au lieu de ${m.word}`); continue; }

      if (board.isEmpty) {
        // Au premier coup, le logiciel REPLACE le mot au meilleur endroit, quel
        // que soit l'endroit tape (SPEC.md §9). On ne verifie donc pas qu'il
        // rend la position demandee, mais qu'il rend bien la MEILLEURE : le
        // score doit egaler le maximum du generateur pour ce mot-la.
        const best = Math.max(...gen.moves.filter((q) => q.word === m.word).map((q) => q.score));
        if (r.move.score !== best) {
          fail(`premier coup ${m.word} : ${r.move.score} au lieu du meilleur ${best}`);
        }
        if (r.move.dir !== "H" || r.move.y !== 0) {
          fail(`premier coup ${m.word} : place en ${r.move.dir} ${r.move.x},${r.move.y}`);
        }
      } else if (r.move.score !== m.score) {
        fail(`score different sur ${m.word} en ${m.dir} ${m.x},${m.y} : ${r.move.score} au lieu de ${m.score}`);
      }
    }

    const top = pickTop(gen.moves, mulberry32(moveSeed(`play${g}`, n)));
    if (top === null) break;
    board.place(top.top.placements);
    reliquat = Bag.remainder(draw.rack, top.top.placements);
  }
}

// Quelques refus attendus, sur une grille fraiche.
const b2 = new Board(dawg);
const cases: [string, string, string][] = [];
// Au premier coup, le sens et l'endroit tapes ne comptent plus : le logiciel
// replace le mot a l'horizontale, a travers l'origine, la ou il rapporte le
// plus (SPEC.md §9). Ces deux cas ne sont donc plus des refus.
const r1 = resolveTypedWord(b2, dawg, "V", 0, 0, "MER", "EMRTUIO");
cases.push(["premier coup tape a la verticale", r1.ok ? `${r1.move.dir} y=${r1.move.y}` : r1.error, "H y=0"]);
const r2 = resolveTypedWord(b2, dawg, "H", 20, 20, "MER", "EMRTUIO");
cases.push(["premier coup tape loin de l'origine",
  r2.ok ? (r2.move.x <= 0 && r2.move.x + 2 >= 0 ? "passe par l'origine" : `x=${r2.move.x}`) : r2.error,
  "passe par l'origine"]);
// Le mot lui-meme reste juge : replacer n'est pas absoudre.
const r2b = resolveTypedWord(b2, dawg, "V", 3, 9, "AB", "ABCDEFG");
cases.push(["premier coup, mot inexistant", r2b.ok ? "accepte" : r2b.error, "MOT_INCONNU"]);
const r3 = resolveTypedWord(b2, dawg, "H", 0, 0, "XQZ", "XQZAEIO");
cases.push(["mot inexistant", r3.ok ? "accepte" : r3.error, "MOT_INCONNU"]);
const r4 = resolveTypedWord(b2, dawg, "H", 0, 0, "MER", "ABCDEFG");
cases.push(["lettres absentes du tirage", r4.ok ? "accepte" : r4.error, "HORS_TIRAGE"]);
const r5 = resolveTypedWord(b2, dawg, "H", -1, 0, "MER", "EMRTUIO");
cases.push(["premier coup valide", r5.ok ? "accepte" : r5.error, "accepte"]);

console.log(`${checked.toLocaleString("fr")} coups verifies contre le generateur\n`);
console.log("cas particuliers :");
for (const [label, got, want] of cases) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok   " : "ECHEC"} ${label.padEnd(32)} ${got}`);
}
console.log();
console.log(failures === 0
  ? "OK : la saisie joueur donne exactement les memes coups que le generateur"
  : `${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
