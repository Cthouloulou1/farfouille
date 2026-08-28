/**
 * Generateur de reference, volontairement NAIF et LENT.
 *
 * Il n'existe que pour contredire le generateur GADDAG. Il est donc construit
 * sur un algorithme deliberement different : pas de GADDAG du tout, mais un
 * balayage de toutes les fenetres (depart, longueur) couvrant l'ancrage, chaque
 * fenetre etant remplie par un parcours en profondeur du DAWG contraint par le
 * motif des tuiles deja posees.
 *
 * Si les deux implementations tombent d'accord sur des milliers de positions,
 * les chances qu'elles partagent le meme bug sont faibles.
 */
import { Dict } from "../src/dictionary.ts";
import { code, letterOf } from "../src/alphabet.ts";
import { keyX, keyY, step, type Dir } from "../src/coords.ts";
import { MAX_WORD, type Board, type Placement } from "../src/board.ts";
import { scoreWord, type Move } from "../src/score.ts";

export function generateMovesNaive(board: Board, dawg: Dict, rack: string): Move[] {
  const counts = new Int32Array(27);
  let blanks = 0;
  for (const ch of rack) {
    if (ch === "?") blanks++;
    else counts[code(ch)]!++;
  }
  const rackSize = rack.length;
  const best = new Map<string, Move>();
  const dirs: Dir[] = board.isEmpty ? ["H"] : ["H", "V"];

  for (const k of board.anchors) {
    const ax = keyX(k);
    const ay = keyY(k);
    for (const dir of dirs) {
      const { dx, dy } = step(dir);
      const occ = (p: number) => board.occupied(ax + dx * p, ay + dy * p);

      for (let start = -(MAX_WORD - 1); start <= 0; start++) {
        for (let len = 1; len <= MAX_WORD; len++) {
          const end = start + len - 1;
          if (end < 0) continue;                 // le mot doit couvrir l'ancrage
          if (occ(start - 1) || occ(end + 1)) continue;  // maximalite

          let empties = 0;
          for (let p = start; p <= end; p++) if (!occ(p)) empties++;
          if (empties === 0 || empties > rackSize) continue;

          const cells: string[] = [];
          const isNew: boolean[] = [];
          const isBlank: boolean[] = [];

          const walk = (p: number, node: number, terminal: boolean, placed: number): void => {
            if (p > end) {
              if (terminal && placed > 0) {
                const word = cells.join("");
                const sx = ax + dx * start;
                const sy = ay + dy * start;
                const placements: Placement[] = [];
                for (let i = 0; i < len; i++) {
                  if (isNew[i]) {
                    placements.push({
                      x: ax + dx * (start + i), y: ay + dy * (start + i),
                      letter: cells[i]!, blank: isBlank[i]!,
                    });
                  }
                }
                const score = scoreWord(board, dir, sx, sy, word, isNew, isBlank);
                const key = `${dir}${sx},${sy}:${word}`;
                const prev = best.get(key);
                if (prev === undefined || score > prev.score) {
                  best.set(key, { dir, x: sx, y: sy, word, placements, score });
                }
              }
              return;
            }

            const cx = ax + dx * p;
            const cy = ay + dy * p;
            const tile = board.at(cx, cy);
            const i = p - start;

            if (tile !== undefined) {
              const ei = dawg.findEdge(node, code(tile.letter));
              if (ei === -1) return;
              const e = dawg.edges[ei]!;
              cells[i] = tile.letter;
              isNew[i] = false;
              isBlank[i] = tile.blank;
              walk(p + 1, Dict.target(e), Dict.isTerminal(e), placed);
              return;
            }

            const cc = board.crossCheck(dir, cx, cy);
            for (let c = 1; c <= 26; c++) {
              if ((cc.mask & (1 << (c - 1))) === 0) continue;
              const ei = dawg.findEdge(node, c);
              if (ei === -1) continue;
              const e = dawg.edges[ei]!;
              const L = letterOf(c);

              if (counts[c]! > 0) {
                counts[c]!--;
                cells[i] = L; isNew[i] = true; isBlank[i] = false;
                walk(p + 1, Dict.target(e), Dict.isTerminal(e), placed + 1);
                counts[c]!++;
              }
              if (blanks > 0) {
                blanks--;
                cells[i] = L; isNew[i] = true; isBlank[i] = true;
                walk(p + 1, Dict.target(e), Dict.isTerminal(e), placed + 1);
                blanks++;
              }
            }
          };

          walk(start, dawg.root, false, 0);
        }
      }
    }
  }
  return [...best.values()];
}

/** Signature comparable d'un ensemble de coups : mot, case, sens et score. */
export function signature(moves: readonly Move[]): string[] {
  return moves.map((m) => `${m.dir} ${m.x},${m.y} ${m.word} ${m.score}`).sort();
}

/**
 * Verifie qu'un coup est legal, independamment de qui l'a produit :
 * mot au dictionnaire, mots perpendiculaires valides, maximalite, chevalet
 * respecte, et score recalcule a l'identique.
 */
export function validateMove(board: Board, dawg: Dict, rack: string, m: Move): string | null {
  const { dx, dy } = step(m.dir);
  if (!dawg.contains(m.word)) return `mot absent du dictionnaire : ${m.word}`;
  if (m.word.length > MAX_WORD) return `mot trop long : ${m.word}`;
  if (m.placements.length === 0) return "aucune tuile posee";

  if (board.occupied(m.x - dx, m.y - dy)) return `mot non maximal a gauche : ${m.word}`;
  const ex = m.x + dx * m.word.length;
  const ey = m.y + dy * m.word.length;
  if (board.occupied(ex, ey)) return `mot non maximal a droite : ${m.word}`;

  const avail = new Int32Array(27);
  let blanks = 0;
  for (const ch of rack) {
    if (ch === "?") blanks++;
    else avail[code(ch)]!++;
  }

  const newAt: boolean[] = [];
  const blankAt: boolean[] = [];
  const byPos = new Map<string, Placement>();
  for (const p of m.placements) byPos.set(`${p.x},${p.y}`, p);

  for (let i = 0; i < m.word.length; i++) {
    const cx = m.x + dx * i;
    const cy = m.y + dy * i;
    const p = byPos.get(`${cx},${cy}`);
    const tile = board.at(cx, cy);

    if (p !== undefined) {
      if (tile !== undefined) return `tuile posee sur une case occupee en ${cx},${cy}`;
      if (p.letter !== m.word[i]) return `placement incoherent avec le mot en ${cx},${cy}`;
      if (p.blank) {
        if (blanks === 0) return "joker utilise sans joker au tirage";
        blanks--;
      } else {
        const c = code(p.letter);
        if (avail[c]! === 0) return `lettre ${p.letter} absente du tirage`;
        avail[c]!--;
      }
      // Le mot perpendiculaire, s'il existe, doit etre valide.
      const cc = board.crossCheck(m.dir, cx, cy);
      if ((cc.mask & (1 << (code(m.word[i]!) - 1))) === 0) {
        return `mot perpendiculaire invalide en ${cx},${cy} pour ${m.word[i]}`;
      }
      newAt.push(true);
      blankAt.push(p.blank);
    } else {
      if (tile === undefined) return `trou dans le mot en ${cx},${cy}`;
      if (tile.letter !== m.word[i]) return `tuile existante differente en ${cx},${cy}`;
      newAt.push(false);
      blankAt.push(tile.blank);
    }
  }

  const expect = scoreWord(board, m.dir, m.x, m.y, m.word, newAt, blankAt);
  if (expect !== m.score) return `score incoherent : annonce ${m.score}, recalcule ${expect}`;
  return null;
}
