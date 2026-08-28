/**
 * Resolution d'un mot tape par un joueur. Voir SPEC.md §9.
 *
 * Le joueur clique une case, choisit un sens, et tape les lettres qu'il POSE :
 * le curseur enjambe tout seul les caramels deja presents. Prolonger BONJOUR en
 * BONJOURS ne demande donc que de taper le S.
 *
 * Cette fonction tourne des deux cotes : dans le navigateur pour la reponse
 * immediate, sur le serveur qui fait autorite. C'est la meme, exactement, pour
 * qu'un mot accepte a l'ecran ne soit jamais refuse par le serveur.
 */
import type { Dict } from "./dictionary.ts";
import { code, BLANK } from "./alphabet.ts";
import { configParDefaut, valeurDe, type ConfigPartie } from "./config.ts";
import { step, type Dir } from "./coords.ts";
import { MAX_WORD, type Board, type Placement } from "./board.ts";
import { bonusAt } from "./bonus.ts";
import { scoreWord, type Move } from "./score.ts";

export type PlayError =
  | "AUCUNE_LETTRE"
  | "MOT_TROP_LONG"
  | "MOT_INCONNU"
  | "COLLAGE_INCONNU"
  | "HORS_TIRAGE"
  | "PAS_DE_CONTACT"
  | "PREMIER_COUP_HORIZONTAL"
  | "HORS_GRILLE"
  | "DOIT_COUVRIR_ORIGINE";

/** Message destine au joueur, tel qu'il s'affiche. */
export const PLAY_MESSAGE: Readonly<Record<PlayError, string>> = {
  AUCUNE_LETTRE: "aucune lettre posée",
  MOT_TROP_LONG: "mot trop long",
  MOT_INCONNU: "mot non valide",
  COLLAGE_INCONNU: "collage non valide",
  HORS_TIRAGE: "lettre absente du tirage",
  PAS_DE_CONTACT: "le mot ne touche rien",
  HORS_GRILLE: "le mot sort de la grille",
  PREMIER_COUP_HORIZONTAL: "le premier coup est horizontal",
  DOIT_COUVRIR_ORIGINE: "le premier coup doit couvrir l'origine",
};

export type PlayOutcome =
  | { ok: true; move: Move }
  | {
      ok: false;
      error: PlayError;
      word?: string;
      /**
       * Les mots perpendiculaires fautifs, quand le refus vient d'un collage.
       * Dire "collage non valide" sans dire lequel n'aide personne a corriger.
       */
      bad?: string[];
    };

interface Cell {
  x: number;
  y: number;
  letter: string;
  isNew: boolean;
  blank: boolean;
}

export function resolveTypedWord(
  board: Board,
  dawg: Dict,
  dir: Dir,
  sx: number,
  sy: number,
  typed: string,
  rack: string,
  /** Garde-fou de la bascule d'orientation ci-dessous. Ne pas passer. */
  flipped = false,
  /**
   * Apercu pendant la frappe : le mot n'a pas encore a toucher la grille.
   *
   * Un mot commence presque toujours par flotter dans le vide avant d'atteindre
   * un caramel deja pose. Refuser « le mot ne touche rien » a la deuxieme lettre
   * n'apprend rien et empeche d'afficher le score en cours. Le contact n'est
   * exige qu'a la validation.
   */
  apercu = false,
  /**
   * L'emplacement du premier coup est deja arrete : on ne cherche plus le
   * meilleur, on valide celui-la. Sert a la recherche de `premierCoup`, qui
   * s'appellerait sinon sans fin.
   */
  origineFixee = false,
): PlayOutcome {
  if (typed.length === 0) return { ok: false, error: "AUCUNE_LETTRE" };
  const { dx, dy } = step(dir);

  // 1. On avance en posant les lettres tapees, et en ENJAMBANT les caramels
  //    deja presents : ils font partie du mot sans etre retapes.
  const cells: Cell[] = [];
  let i = 0;
  let px = sx;
  let py = sy;
  while (i < typed.length) {
    if (cells.length > MAX_WORD) return { ok: false, error: "MOT_TROP_LONG" };
    const t = board.at(px, py);
    if (t !== undefined) {
      cells.push({ x: px, y: py, letter: t.letter, isNew: false, blank: t.blank });
    } else {
      cells.push({ x: px, y: py, letter: typed[i]!, isNew: true, blank: false });
      i++;
    }
    px += dx;
    py += dy;
  }

  // 2. Prolongement automatique : un caramel colle au mot en fait partie, meme
  //    si le joueur ne l'a pas tape. Sans cela on validerait CAT alors que la
  //    grille lit CATS.
  for (;;) {
    const t = board.at(px, py);
    if (t === undefined) break;
    cells.push({ x: px, y: py, letter: t.letter, isNew: false, blank: t.blank });
    px += dx;
    py += dy;
    if (cells.length > MAX_WORD) return { ok: false, error: "MOT_TROP_LONG" };
  }
  let bx = sx - dx;
  let by = sy - dy;
  for (;;) {
    const t = board.at(bx, by);
    if (t === undefined) break;
    cells.unshift({ x: bx, y: by, letter: t.letter, isNew: false, blank: t.blank });
    bx -= dx;
    by -= dy;
    if (cells.length > MAX_WORD) return { ok: false, error: "MOT_TROP_LONG" };
  }

  // Une seule case en tout : le sens choisi ne dit rien. Poser un A derriere
  // LASSER forme LASSERA que le curseur soit horizontal ou vertical -- exiger
  // le bon sens pour une lettre unique n'a aucun sens pour le joueur. On bascule
  // donc dans l'autre sens, ou le mot a une chance d'exister.
  if (cells.length === 1 && !flipped && !board.isEmpty) {
    const other: Dir = dir === "H" ? "V" : "H";
    const alt = resolveTypedWord(board, dawg, other, sx, sy, typed, rack, true);
    if (alt.ok) return alt;
  }

  if (cells.length > MAX_WORD) return { ok: false, error: "MOT_TROP_LONG" };
  // Sur une grille bornee, un mot ne deborde pas du plateau.
  for (const c of cells) {
    if (!board.dansLesBornes(c.x, c.y)) {
      return { ok: false, error: "HORS_GRILLE", word: cells.map((q) => q.letter).join("") };
    }
  }
  const word = cells.map((c) => c.letter).join("");
  const placed = cells.filter((c) => c.isNew);
  if (placed.length === 0) return { ok: false, error: "AUCUNE_LETTRE" };

  // 3. Le premier coup a ses regles propres (SPEC.md §3).
  if (board.isEmpty) {
    // Le joueur tape ou il veut : le logiciel replace le mot a l'horizontale et
    // le fait passer par l'origine, en choisissant l'emplacement qui rapporte
    // le plus. Exiger de viser la case centrale au premier coup, sur une grille
    // vide ou rien ne sert de repere, n'aurait aucun interet.
    if (!origineFixee) return premierCoup(board, dawg, word, rack);
    if (dir !== "H") return { ok: false, error: "PREMIER_COUP_HORIZONTAL", word };
    if (!cells.some((c) => c.x === 0 && c.y === 0)) {
      return { ok: false, error: "DOIT_COUVRIR_ORIGINE", word };
    }
  } else {
    // Sinon le mot doit toucher l'existant : soit il absorbe un caramel, soit
    // l'une de ses lettres forme un mot perpendiculaire.
    const touches =
      cells.some((c) => !c.isNew) ||
      placed.some((c) => board.crossCheck(dir, c.x, c.y).has);
    if (!touches && !apercu) return { ok: false, error: "PAS_DE_CONTACT", word };
  }

  if (!dawg.contains(word)) return { ok: false, error: "MOT_INCONNU", word };

  // 4. Les mots perpendiculaires formes doivent exister eux aussi.
  const bad: string[] = [];
  for (const c of placed) {
    const cc = board.crossCheck(dir, c.x, c.y);
    if (cc.has && (cc.mask & (1 << (code(c.letter) - 1))) === 0) {
      bad.push(crossWordAt(board, dir, c.x, c.y, c.letter));
    }
  }
  if (bad.length > 0) return { ok: false, error: "COLLAGE_INCONNU", word, bad };

  // 5. Affectation des jokers. Une lettre absente du tirage en consomme un ;
  //    quand la lettre reelle ET un joker sont disponibles, le joker va sur la
  //    case qui rapporte le MOINS (SPEC.md §6). Le classement se fait par le
  //    poids de la case, jamais de gauche a droite.
  const have = new Map<string, number>();
  let blanks = 0;
  for (const ch of rack) {
    if (ch === BLANK) blanks++;
    else have.set(ch, (have.get(ch) ?? 0) + 1);
  }

  let mainMult = 1;
  for (const c of placed) mainMult *= bonusAt(c.x, c.y, board.cfg.pavage).word;

  const weight = (c: Cell): number => {
    const b = bonusAt(c.x, c.y, board.cfg.pavage);
    const cc = board.crossCheck(dir, c.x, c.y);
    return b.letter * (mainMult + (cc.has ? b.word : 0));
  };

  const byLetter = new Map<string, Cell[]>();
  for (const c of placed) {
    let g = byLetter.get(c.letter);
    if (g === undefined) { g = []; byLetter.set(c.letter, g); }
    g.push(c);
  }
  for (const [letter, group] of byLetter) {
    const real = have.get(letter) ?? 0;
    const need = group.length - real;
    if (need <= 0) continue;
    if (need > blanks) return { ok: false, error: "HORS_TIRAGE", word };
    blanks -= need;
    // Le joker va la ou la lettre reelle rapporterait le moins.
    const sorted = [...group].sort((a, b) => weight(a) - weight(b));
    for (let k = 0; k < need; k++) sorted[k]!.blank = true;
  }

  const placements: Placement[] = placed.map((c) => ({
    x: c.x, y: c.y, letter: c.letter, blank: c.blank,
  }));
  const start = cells[0]!;
  const score = scoreWord(
    board, dir, start.x, start.y, word,
    cells.map((c) => c.isNew),
    cells.map((c) => c.blank),
  );

  return { ok: true, move: { dir, x: start.x, y: start.y, word, placements, score } };
}

/**
 * Le premier coup, pose au mieux.
 *
 * Le mot est horizontal et doit couvrir l'origine : il reste `longueur`
 * emplacements possibles, du mot commencant tout a gauche de l'origine a celui
 * qui commence dessus. On les evalue tous et on garde le plus rentable. A score
 * egal, le plus a gauche, pour que le choix soit reproductible.
 */
function premierCoup(board: Board, dawg: Dict, word: string, rack: string): PlayOutcome {
  if (!dawg.contains(word)) return { ok: false, error: "MOT_INCONNU", word };
  let best: PlayOutcome | null = null;
  let bestScore = -1;
  for (let x = -(word.length - 1); x <= 0; x++) {
    const essai = resolveTypedWord(board, dawg, "H", x, 0, word, rack, true, false, true);
    if (!essai.ok) { best ??= essai; continue; }
    if (essai.move.score > bestScore) { bestScore = essai.move.score; best = essai; }
  }
  return best ?? { ok: false, error: "DOIT_COUVRIR_ORIGINE", word };
}

/**
 * Le mot perpendiculaire que formerait `letter` posee en (x, y).
 * Sert a montrer au joueur ce qui cloche, pas a valider.
 */
function crossWordAt(board: Board, dir: Dir, x: number, y: number, letter: string): string {
  const dx = dir === "H" ? 0 : 1;
  const dy = dir === "H" ? 1 : 0;
  let before = "";
  for (let i = 1; i <= MAX_WORD; i++) {
    const t = board.at(x - dx * i, y - dy * i);
    if (t === undefined) break;
    before = t.letter + before;
  }
  let after = "";
  for (let i = 1; i <= MAX_WORD; i++) {
    const t = board.at(x + dx * i, y + dy * i);
    if (t === undefined) break;
    after += t.letter;
  }
  return before + letter + after;
}

/** Le tirage tel qu'il s'affiche : sept caramels, ordre alphabetique. */
export function displayRack(rack: string): string {
  return [...rack].sort().join("");
}

/** Ce qui reste du tirage apres avoir pose ces caramels. */
export function rackAfter(rack: string, placements: readonly Placement[]): string {
  const left = [...rack];
  for (const p of placements) {
    const ch = p.blank ? BLANK : p.letter;
    const i = left.indexOf(ch);
    if (i !== -1) left.splice(i, 1);
  }
  return left.join("");
}

/** Valeur d'un caramel dans le tirage, pour l'affichage. */
export function tileValue(ch: string, cfg: ConfigPartie = configParDefaut()): number {
  return ch === BLANK ? 0 : valeurDe(cfg, ch);
}
