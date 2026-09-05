/**
 * La super grille 21x21 et ses quadruples. Voir SPEC.md §3 et §16.
 *
 *     node packages/engine/test/check_super.ts
 *
 * Trois choses a tenir :
 *
 *   - LA SYMETRIE. Le motif a ete recopie a la main. Il doit etre invariant par
 *     les quatre symetries du carre -- les deux miroirs et les deux diagonales
 *     -- faute de quoi une case bonus manque quelque part sans que rien ne le
 *     dise, et la grille n'est plus la meme selon le cote ou l'on joue ;
 *   - LES QUADRUPLES COMPTENT QUADRUPLE. C'est la seule chose que cette grille
 *     ajoute au plateau du commerce, et le score la lit par `bonusAt` ;
 *   - LE PLATEAU CONTIENT LA PARTIE, comme le 15x15 : rien ne sort de 21x21.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { Bag } from "../src/bag.ts";
import { SacFini, SAC_FRANCAIS } from "../src/sac.ts";
import { generateMoves, pickTop } from "../src/movegen.ts";
import { resolveTypedWord } from "../src/play.ts";
import { LAYOUTS, bonusAt, setLayout } from "../src/bonus.ts";
import { scoreMove } from "../src/score.ts";
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

/** Le demi-cote : dix cases, donc 21x21. */
const B = 10;
const CFG = avec(configParDefaut(), {
  bornes: B, pavage: LAYOUTS.super21, pavageNom: "super21", pioche: "sac102",
});
const c = (x: number, y: number) => LAYOUTS.super21(x, y);

console.log("\nLe motif, recopie a la main\n");
{
  let miroirH = 0, miroirV = 0, diag = 0, antidiag = 0;
  for (let y = -B; y <= B; y++) {
    for (let x = -B; x <= B; x++) {
      if (c(x, y) !== c(-x, y)) miroirH++;
      if (c(x, y) !== c(x, -y)) miroirV++;
      if (c(x, y) !== c(y, x)) diag++;
      if (c(x, y) !== c(-y, -x)) antidiag++;
    }
  }
  verifie("symetrique gauche-droite", miroirH === 0, `${miroirH} ecart(s)`);
  verifie("symetrique haut-bas", miroirV === 0, `${miroirV} ecart(s)`);
  verifie("symetrique par la diagonale", diag === 0, `${diag} ecart(s)`);
  verifie("symetrique par l'antidiagonale", antidiag === 0, `${antidiag} ecart(s)`);

  const compte: Record<string, number> = {};
  for (let y = -B; y <= B; y++) for (let x = -B; x <= B; x++) {
    const ch = c(x, y);
    compte[ch] = (compte[ch] ?? 0) + 1;
  }
  verifie("quatre mots comptent quadruple", compte["Q"] === 4, `${compte["Q"] ?? 0} case(s)`);
  verifie("huit lettres comptent quadruple", compte["q"] === 8, `${compte["q"] ?? 0} case(s)`);
  verifie("les quatre coins sont des MCQ",
    c(-B, -B) === "Q" && c(B, -B) === "Q" && c(-B, B) === "Q" && c(B, B) === "Q");
  verifie("le centre est un mot compte double", c(0, 0) === "D", c(0, 0));
  verifie("hors du plateau, aucune case",
    c(B + 1, 0) === "." && c(0, -B - 1) === ".");
  const total = 21 * 21;
  const nues = compte["."] ?? 0;
  console.log(`         ${total - nues} cases bonus sur ${total}, dont `
    + `${compte["Q"]} MCQ, ${compte["T"]} MCT, ${compte["D"]} MCD, `
    + `${compte["q"]} LCQ, ${compte["t"]} LCT, ${compte["d"]} LCD`);
}

console.log("\nUn quadruple compte quadruple\n");
{
  verifie("le coin multiplie le mot par 4",
    bonusAt(-B, -B, LAYOUTS.super21).word === 4,
    `x${bonusAt(-B, -B, LAYOUTS.super21).word}`);
  // La premiere LCQ rencontree, pour ne pas ecrire ses coordonnees en dur.
  let lcq: [number, number] | null = null;
  for (let y = -B; y <= B && lcq === null; y++) {
    for (let x = -B; x <= B; x++) if (c(x, y) === "q") { lcq = [x, y]; break; }
  }
  verifie("une LCQ existe", lcq !== null, lcq === null ? "" : `en ${lcq[0]},${lcq[1]}`);
  if (lcq !== null) {
    verifie("elle multiplie la lettre par 4",
      bonusAt(lcq[0], lcq[1], LAYOUTS.super21).letter === 4,
      `x${bonusAt(lcq[0], lcq[1], LAYOUTS.super21).letter}`);
  }
}

console.log("\nLe score le lit vraiment\n");
{
  // Le premier coup couvre le centre, qui est un mot compte double : on mesure
  // donc le meme mot pose deux fois, une fois sur la case nue et une fois sur
  // la case quadruple, et l'on compare.
  const nu = new Board(dawg, avec(CFG, { pavage: () => ".", pavageNom: "custom" }));
  const quad = new Board(dawg, avec(CFG, { pavage: (x, y) => (x === -4 && y === 0 ? "Q" : "."), pavageNom: "custom" }));
  const a = resolveTypedWord(nu, dawg, "H", -4, 0, "RATES", "RATESZZ");
  const b = resolveTypedWord(quad, dawg, "H", -4, 0, "RATES", "RATESZZ");
  const ok = a.ok && b.ok;
  verifie("le mot se pose des deux cotes", ok, ok ? "" : "refuse");
  if (a.ok && b.ok) {
    const sa = scoreMove(nu, a.move), sb = scoreMove(quad, b.move);
    verifie("la case Q quadruple le mot", sb === sa * 4, `${sa} pts -> ${sb} pts`);
  }
  const lettre = new Board(dawg, avec(CFG, { pavage: (x, y) => (x === -4 && y === 0 ? "q" : "."), pavageNom: "custom" }));
  const d = resolveTypedWord(lettre, dawg, "H", -4, 0, "RATES", "RATESZZ");
  if (a.ok && d.ok) {
    const sa = scoreMove(nu, a.move), sd = scoreMove(lettre, d.move);
    // R vaut 1 point : la case en ajoute trois.
    verifie("la case q quadruple la lettre", sd === sa + 3, `${sa} pts -> ${sd} pts`);
  }
}

console.log("\nUne partie entiere sur la super grille\n");
{
  const board = new Board(dawg, CFG);
  const sac = new SacFini(SAC_FRANCAIS, mulberry32(moveSeed("s21", 0)), CFG.tirage);
  let reliquat: string[] = [];
  let coups = 0, horsPlateau = 0, cases = 0;

  while (!sac.estFinie(reliquat) && coups < 60) {
    const d = sac.draw(reliquat);
    const gen = generateMoves(board, gaddag, d.rack, { tiers: 1, maxMoves: 4 });
    const top = pickTop(gen.moves, mulberry32(moveSeed("s21", coups + 1)));
    if (top === null) { reliquat = []; continue; }
    for (const p of top.top.placements) {
      cases++;
      if (p.x < -B || p.x > B || p.y < -B || p.y > B) horsPlateau++;
    }
    board.place(top.top.placements);
    reliquat = Bag.remainder(d.rack, top.top.placements);
    coups++;
  }
  verifie("la partie se joue et se termine", coups > 5, `${coups} coups, ${cases} caramels poses`);
  verifie("aucun caramel hors du plateau", horsPlateau === 0, `${horsPlateau} debordement(s)`);
  const dehors = [...board.anchors].filter((k) => {
    const x = keyX(k), y = keyY(k);
    return x < -B || x > B || y < -B || y > B;
  });
  verifie("aucun ancrage hors du plateau", dehors.length === 0, `${dehors.length} en trop`);
  verifie("le plateau s'arrete a dix", board.dansLesBornes(B, B) && !board.dansLesBornes(B + 1, 0));
}

console.log(echecs === 0
  ? "\nOK : la super grille est symetrique, ses quadruples comptent, rien ne deborde\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
