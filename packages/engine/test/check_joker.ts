/**
 * Les caramels poses sortent DANS L'ORDRE DE LA FRAPPE. Voir SPEC.md §6.
 *
 *     node packages/engine/test/check_joker.ts
 *
 * L'ecran compte le tirage restant en appariant les caramels poses aux lettres
 * tapees. Il ne peut pas le faire par coordonnees : au premier coup, le moteur
 * DEPLACE le mot pour lui faire couvrir l'origine au meilleur endroit. Il le
 * fait donc dans l'ordre -- et c'est cet ordre que le test garantit.
 *
 * Sans lui, un premier coup a deux jokers partait en morceaux : une lettre
 * posee revenait en main, un joker disparaissait, et la lettre suivante etait
 * refusee sans qu'on comprenne pourquoi.
 */
import { loadDict } from "../src/dictionary_node.ts";
import { Board } from "../src/board.ts";
import { resolveTypedWord } from "../src/play.ts";
import { DAWG_PATH } from "../src/paths.ts";
import { setLayout } from "../src/bonus.ts";
import { configParDefaut, avec } from "../src/config.ts";

const dawg = loadDict(DAWG_PATH);
setLayout("classique");
const cfg = avec(configParDefaut(), { bornes: 7, pioche: "sac102" });

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(56)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nLes caramels poses suivent l'ordre de la frappe\n");

// --- 1. Premier coup : le mot est deplace, l'ordre tient -------------------
{
  const board = new Board(dawg, cfg);
  const r = resolveTypedWord(board, dawg, "H", -4, 0, "DEBACLE", "??ABCDE", false, true);
  verifie("un premier coup a deux jokers se resout", r.ok, r.ok ? `${r.move.word} ${r.move.score} pts` : "refuse");
  if (r.ok) {
    const lettres = r.move.placements.map((p) => p.letter).join("");
    verifie("les caramels sortent dans l'ordre du mot", lettres === "DEBACLE", lettres);
    verifie("le mot a bien ete deplace", r.move.x !== -4, `pose en x = ${r.move.x}`);
    const jokers = r.move.placements.filter((p) => p.blank).length;
    verifie("deux jokers employes", jokers === 2, `${jokers}`);
  }
}

// --- 2. Le compte du tirage, tel que l'ecran le fait -----------------------
{
  /** Ce qui reste en main apres avoir tape `mot`, apparie DANS L'ORDRE. */
  const restant = (rack: string, mot: string): string | null => {
    const board = new Board(dawg, cfg);
    const r = resolveTypedWord(board, dawg, "H", -4, 0, mot, rack, false, true);
    if (!r.ok) return null;
    const left = [...rack];
    r.move.placements.forEach((p) => {
      const i = p.blank ? left.indexOf("?") : left.indexOf(p.letter);
      if (i !== -1) left.splice(i, 1);
    });
    return left.join("");
  };

  // A chaque lettre de plus, le tirage restant doit PERDRE une lettre : jamais
  // en regagner. C'est exactement ce qui clochait.
  const rack = "??ABCDE";
  let faute: string | null = null;
  for (const mot of ["DEBACLE", "CABANE", "BADACE", "ABBE"]) {
    let precedent = rack.length + 1;
    for (let i = 1; i <= mot.length; i++) {
      const reste = restant(rack, mot.slice(0, i));
      if (reste === null) continue;
      if (reste.length !== precedent - 1 && precedent !== rack.length + 1) {
        faute ??= `${mot.slice(0, i)} : ${precedent} puis ${reste.length} lettres`;
      }
      precedent = reste.length;
    }
  }
  verifie("le tirage ne fait que diminuer, lettre apres lettre",
    faute === null, faute ?? "quatre mots eprouves, aucune remontee");

  // Et le compte final est juste.
  verifie("DEBACLE consomme les sept caramels", restant("??ABCDE", "DEBACLE") === "");
  verifie("CABANE en laisse un", restant("??ABCDE", "CABANE") === "D", restant("??ABCDE", "CABANE") ?? "");
}

console.log(echecs === 0
  ? "\nOK : l'ecran peut compter le tirage sans se fier aux coordonnees\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
