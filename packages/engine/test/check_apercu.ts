/**
 * L'apercu pendant la frappe compte les points, il ne juge pas. Voir SPEC.md §6.
 *
 *     node packages/engine/test/check_apercu.ts
 *
 * Un mot en cours de frappe n'est presque jamais un mot : « ARBOUSE » passe par
 * « AR », et le detour est plus long encore quand on enjambe des caramels deja
 * poses. Repondre « mot non valide » a chacune de ces etapes, au lieu du score,
 * revient a taire la seule chose qu'on regardait.
 *
 * Le test verifie les deux moities de la regle :
 *   - en apercu, le score sort quand meme, et il est JUSTE ;
 *   - a la validation, le mot est refuse.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { resolveTypedWord } from "../src/play.ts";
import { DAWG_PATH } from "../src/paths.ts";
import { setLayout } from "../src/bonus.ts";
import { configParDefaut, avec } from "../src/config.ts";

const dawg = loadDict(DAWG_PATH);
setLayout("classique");
const cfg = avec(configParDefaut(), { bornes: 7 });

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(54)} ${detail}`);
  if (!ok) echecs++;
}

/** Une grille avec un mot déjà posé, pour avoir de quoi prendre appui. */
function grilleAvec(mot: string, dir: "H" | "V", x: number, y: number): Board {
  const b = new Board(dawg, cfg);
  b.place([...mot].map((l, i) => ({
    x: dir === "H" ? x + i : x, y: dir === "V" ? y + i : y, letter: l, blank: false,
  })));
  return b;
}

console.log("\nL'apercu compte, il ne juge pas\n");

// --- 1. Un debut de mot, en l'air : « AR » n'est pas un mot -----------------
{
  const b = grilleAvec("ARBRE", "H", -2, 0);
  // On repart du A pose pour ecrire quelque chose de plus long, vers le bas.
  const apercu = resolveTypedWord(b, dawg, "V", -2, 0, "R", "RSTLNEA", false, true);
  const strict = resolveTypedWord(b, dawg, "V", -2, 0, "R", "RSTLNEA");
  verifie("« AR » en apercu : le score sort", apercu.ok,
    apercu.ok ? `${apercu.move.word} = ${apercu.move.score} pts` : `refuse : ${strict.ok ? "" : strict.error}`);
  verifie("« AR » en apercu : la faute est notee",
    apercu.ok && apercu.faute === "MOT_INCONNU");
  verifie("« AR » a la validation : refuse",
    !strict.ok && strict.error === "MOT_INCONNU");
}

// --- 2. Le score de l'apercu est le VRAI score -----------------------------
{
  const b = grilleAvec("ARBRE", "H", -2, 0);
  // Un mot que le dictionnaire connait : son score doit etre le MEME en apercu
  // et a la validation. C'est ce qui garantit qu'on ne montre pas un chiffre
  // de complaisance pendant la frappe.
  const lettre = [..."SCTNEZ"].find((l) => dawg.contains("A" + l));
  if (lettre === undefined) {
    verifie("un mot de deux lettres a partir de A", false, "aucun trouve");
  } else {
    const a = resolveTypedWord(b, dawg, "V", -2, 0, lettre, "SCTNEZR", false, true);
    const s = resolveTypedWord(b, dawg, "V", -2, 0, lettre, "SCTNEZR");
    verifie("mot valide : meme score en apercu et a la validation",
      a.ok && s.ok && a.move.score === s.move.score,
      a.ok ? `A${lettre} = ${a.move.score} pts` : "refuse");
    verifie("mot valide : aucune faute notee", a.ok && a.faute === undefined);
  }

  // Et un non-mot au meme endroit rapporte quelque chose, pas rien.
  const faux = [..."BFHJKMPQVWXY"].find((l) => !dawg.contains("A" + l));
  const r = faux === undefined ? null
    : resolveTypedWord(b, dawg, "V", -2, 0, faux, faux + "RTLNEA", false, true);
  verifie("non-mot : un score, pas un zero",
    r !== null && r.ok && r.move.score > 0,
    r !== null && r.ok ? `${r.move.word} = ${r.move.score} pts` : "");
}

// --- 3. Un mot qui enjambe un caramel et redevient valide -------------------
{
  const b = grilleAvec("ARBRE", "H", -2, 0);
  const etapes = ["B", "BR", "BRA"];
  const scores: (number | null)[] = [];
  for (const e of etapes) {
    const r = resolveTypedWord(b, dawg, "V", -1, 0, e, "BRATLNE", false, true);
    scores.push(r.ok ? r.move.score : null);
  }
  verifie("chaque etape de la frappe a son score",
    scores.every((s) => s !== null), scores.join(" · "));
}

// --- 4. Le contact n'est pas exige non plus pendant la frappe ---------------
{
  const b = grilleAvec("ARBRE", "H", -2, 0);
  const loin = resolveTypedWord(b, dawg, "H", 3, 4, "MOT", "MOTLNEA", false, true);
  const strict = resolveTypedWord(b, dawg, "H", 3, 4, "MOT", "MOTLNEA");
  verifie("un mot qui ne touche rien : le score sort quand meme", loin.ok,
    loin.ok ? `${loin.move.word} = ${loin.move.score} pts` : "");
  verifie("mais la validation le refuse",
    !strict.ok && strict.error === "PAS_DE_CONTACT");
}

// --- 5. Ce qui reste refuse meme en apercu ---------------------------------
{
  const b = grilleAvec("ARBRE", "H", -2, 0);
  // Une lettre absente du tirage n'est pas une question de dictionnaire : on ne
  // peut pas la poser, il n'y a donc pas de score a montrer.
  const horsTirage = resolveTypedWord(b, dawg, "V", -1, 0, "ZZZ", "ABCDEFG", false, true);
  verifie("une lettre qu'on n'a pas reste refusee, meme en apercu",
    !horsTirage.ok && horsTirage.error === "HORS_TIRAGE");
}

console.log(echecs === 0
  ? "\nOK : pendant la frappe on compte, a la validation on juge\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
