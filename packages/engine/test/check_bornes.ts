/**
 * La grille bornee 15x15. Voir SPEC.md §16.
 *
 *     node packages/engine/test/check_bornes.ts
 *
 * Rien ne doit sortir du plateau : ni un coup genere, ni un mot tape, ni un
 * ancrage. Et le plateau du commerce ne doit pas se repeter -- ses quinze
 * colonnes sont distinctes, contrairement au pavage infini de meme nom.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { SacFini, SAC_FRANCAIS } from "../src/sac.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { resolveTypedWord } from "../src/play.ts";
import { LAYOUTS, bonusChar, setLayout } from "../src/bonus.ts";
import { configParDefaut, avec } from "../src/config.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";
import { keyX, keyY } from "../src/coords.ts";
import { DAWG_PATH, GADDAG_PATH } from "../src/paths.ts";

setLayout("pave1");
const dawg = loadDict(DAWG_PATH);
const gaddag = loadDict(GADDAG_PATH);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(46)} ${detail}`);
  if (!ok) echecs++;
}

const CFG15 = avec(configParDefaut(), {
  bornes: 7, pavage: LAYOUTS.classique15, pavageNom: "classique15",
  pioche: "sac102",
});

console.log("\nLe plateau du commerce, borne\n");
{
  // Les quatre coins sont des mots comptent triple, le centre est l'etoile.
  const c = (x: number, y: number) => LAYOUTS.classique15(x, y);
  verifie("les quatre coins sont des MCT",
    c(-7, -7) === "T" && c(7, -7) === "T" && c(-7, 7) === "T" && c(7, 7) === "T");
  verifie("le centre est l'etoile", c(0, 0) === "*", c(0, 0));
  // Le pavage infini fait coincider les bords ; le borne, non.
  verifie("les colonnes -7 et 7 different du pavage infini",
    LAYOUTS.classique(-7, 0) === LAYOUTS.classique(7, 0)
    && c(-7, 0) === "T" && c(7, 0) === "T", "bords distincts, tous deux MCT");
  verifie("hors du plateau, aucune case", c(8, 0) === "." && c(0, -8) === ".");
}

console.log("\nUne partie entiere sur 15x15\n");
{
  const board = new Board(dawg, CFG15);
  const sac = new SacFini(SAC_FRANCAIS, mulberry32(moveSeed("b15", 0)), CFG15.tirage);
  let reliquat: string[] = [];
  let coups = 0, horsPlateau = 0, cases = 0;

  while (!sac.estFinie(reliquat) && coups < 60) {
    const d = sac.draw(reliquat);
    const gen = generateMoves(board, gaddag, d.rack, { tiers: 1, maxMoves: 4 });
    const top = pickTop(gen.moves, mulberry32(moveSeed("b15", coups + 1)));
    if (top === null) { reliquat = []; continue; }
    for (const p of top.top.placements) {
      cases++;
      if (p.x < -7 || p.x > 7 || p.y < -7 || p.y > 7) horsPlateau++;
    }
    board.place(top.top.placements);
    reliquat = Bag.remainder(d.rack, top.top.placements);
    coups++;
  }
  verifie("la partie se joue et se termine", coups > 5, `${coups} coups, ${cases} caramels poses`);
  verifie("aucun caramel hors du plateau", horsPlateau === 0, `${horsPlateau} debordement(s)`);
  const ancragesDehors = [...board.anchors].filter((k) => {
    const x = keyX(k), y = keyY(k);
    return x < -7 || x > 7 || y < -7 || y > 7;
  });
  verifie("aucun ancrage hors du plateau", ancragesDehors.length === 0, `${ancragesDehors.length} en trop`);
}

console.log("\nUn mot tape ne deborde pas\n");
{
  const board = new Board(dawg, CFG15);
  const r = resolveTypedWord(board, dawg, "H", 0, 0, "LASSER", "ELRSSAZ");
  verifie("premier coup accepte", r.ok, r.ok ? `${r.move.word} en ${r.move.x},0` : r.error);
  if (r.ok) board.place(r.move.placements);
  // Un mot colle au bord droit, qui deborderait.
  const bord = resolveTypedWord(board, dawg, "H", 5, 3, "LASSER", "ELRSSAZ");
  verifie("un mot qui sort du plateau est refuse",
    !bord.ok && bord.error === "HORS_GRILLE", bord.ok ? "accepte" : bord.error);
}

console.log("\nLa grille infinie n'est pas bornee\n");
{
  const board = new Board(dawg, configParDefaut());
  verifie("tout est dans les bornes", board.dansLesBornes(9999, -9999));
  const b15 = new Board(dawg, CFG15);
  verifie("le plateau borne s'arrete a 7", b15.dansLesBornes(7, 7) && !b15.dansLesBornes(8, 0));
}

console.log(echecs === 0
  ? "\nOK : la grille 15x15 contient la partie, rien ne deborde\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
