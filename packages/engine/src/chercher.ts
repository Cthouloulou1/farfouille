/**
 * Ou peut-on poser CE mot-la, et combien vaut-il ? Voir SPEC.md §10.
 *
 * CHERCHER UN MOT DONNE N'EST PAS LE MEME PROBLEME QUE TROUVER TOUS LES COUPS.
 * Le solveur explore le dictionnaire depuis chaque ancrage avec toutes les
 * combinaisons du tirage ; ici le mot est connu, et il ne reste qu'a essayer,
 * pour chaque ancrage et chaque decalage, s'il tient. On ne touche plus au
 * GADDAG du tout -- seulement au plateau et aux mots croises.
 *
 * Mesure sur une partie reelle de 11 647 coups (66 800 caramels, 71 411
 * ancrages), la grille permanente :
 *
 * | | |
 * |---|---|
 * | generation complete des 960 816 coups | 8,3 s |
 * | le calcul que fait le serveur a chaque coup | 1,6 s |
 * | **balayage d'un mot** | **0,15 a 0,5 s** |
 *
 * C'est ce qui permet de repondre a « ou aurais-je pu jouer MA ? » sur une
 * grille infinie, ou seuls les cent premiers paliers sont enregistres et ou
 * tout le reste -- l'immense majorite des coups jouables -- n'existe nulle part.
 */
import { Board, type Placement } from "./board.ts";
import { bonusAt } from "./bonus.ts";
import { scoreWord } from "./score.ts";
import { code, BLANK } from "./alphabet.ts";
import { step, key, keyX, keyY, type Dir } from "./coords.ts";
import type { Dict } from "./dictionary.ts";

/** Un endroit ou le mot se pose, avec ce qu'il y rapporte. */
export interface Trouvaille {
  dir: Dir;
  x: number;
  y: number;
  word: string;
  score: number;
  placements: Placement[];
}

/**
 * Tous les endroits ou `mot` peut se poser avec ce tirage, du plus cher au
 * moins cher.
 *
 * Rend une liste vide si le mot n'est pas au dictionnaire : autant le dire tout
 * de suite plutot que de balayer soixante-dix mille ancrages pour rien.
 */
export function chercherLeMot(
  board: Board, dict: Dict, mot: string, rack: string,
): Trouvaille[] {
  const L = mot.length;
  if (L < 2 || !dict.contains(mot)) return [];

  const lettres = new Int32Array(L);
  for (let i = 0; i < L; i++) lettres[i] = code(mot[i]!) - 1;

  const enMain = new Int32Array(27);
  let jokers = 0;
  for (const ch of rack) {
    if (ch === BLANK) jokers++;
    else enMain[code(ch) - 1]!++;
  }

  // Les ancrages : les cases vides voisines d'un caramel. Un mot qui en couvre
  // une touche la grille -- la connexite est donc acquise, sans avoir a la
  // verifier apres coup.
  const ax: number[] = [], ay: number[] = [];
  for (const k of board.anchors) { ax.push(keyX(k)); ay.push(keyY(k)); }

  const sorties: Trouvaille[] = [];
  const vus = new Set<number>();
  const restant = new Int32Array(27);
  const n = ax.length;

  for (const dir of ["H", "V"] as const) {
    const { dx, dy } = step(dir);
    const marque = dir === "H" ? 0 : 1;
    for (let a = 0; a < n; a++) {
      for (let i = 0; i < L; i++) {
        const ox = ax[a]! - dx * i, oy = ay[a]! - dy * i;
        // Le meme depart est atteint depuis plusieurs ancrages : on ne l'essaie
        // qu'une fois. La cle est numerique -- sur soixante-dix mille ancrages
        // et quinze decalages, deux millions de chaines coutaient plus cher que
        // le balayage lui-meme.
        const cle = key(ox, oy) * 2 + marque;
        if (vus.has(cle)) continue;
        vus.add(cle);
        // Le mot ne doit pas PROLONGER un mot deja pose : ce serait un autre
        // mot que celui qu'on cherche.
        if (board.occupied(ox - dx, oy - dy)) continue;
        if (board.occupied(ox + dx * L, oy + dy * L)) continue;

        restant.set(enMain);
        let jok = jokers, poses = 0, ok = true;
        for (let j = 0; j < L; j++) {
          const x = ox + dx * j, y = oy + dy * j;
          if (!board.dansLesBornes(x, y)) { ok = false; break; }
          const t = board.at(x, y);
          const c = lettres[j]!;
          if (t !== undefined) {
            if (code(t.letter) - 1 !== c) { ok = false; break; }
            continue;
          }
          if (restant[c]! > 0) restant[c]!--;
          else if (jok > 0) jok--;
          else { ok = false; break; }
          // Le mot perpendiculaire doit exister lui aussi.
          if ((board.crossCheck(dir, x, y).mask & (1 << c)) === 0) { ok = false; break; }
          poses++;
        }
        if (!ok || poses === 0 || poses > board.cfg.jouables) continue;

        sorties.push(poser(board, dir, ox, oy, mot, enMain, jokers));
      }
    }
  }
  // A score egal, un ordre stable : sans lui, deux placements de meme valeur
  // changent de place d'un affichage a l'autre.
  sorties.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir)
    || a.y - b.y || a.x - b.x);
  return sorties;
}

/**
 * Pose le mot a cet endroit : ou vont les jokers, et combien cela rapporte.
 *
 * Quand la lettre reelle ET un joker sont disponibles, LE JOKER VA SUR LA CASE
 * QUI RAPPORTE LE MOINS -- jamais de gauche a droite. C'est la meme regle que
 * pour un mot tape a la main (SPEC.md §6), et elle change le score : un E reel
 * sur une lettre compte triple ne vaut pas un joker au meme endroit.
 */
function poser(
  board: Board, dir: Dir, ox: number, oy: number, mot: string,
  enMain: Int32Array, jokers: number,
): Trouvaille {
  const { dx, dy } = step(dir);
  const L = mot.length;
  const neufs: boolean[] = [], blancs: boolean[] = [];
  const poses: { x: number; y: number; letter: string; index: number }[] = [];
  for (let j = 0; j < L; j++) {
    const x = ox + dx * j, y = oy + dy * j;
    const occupe = board.at(x, y);
    neufs.push(occupe === undefined);
    blancs.push(occupe?.blank === true);
    if (occupe === undefined) poses.push({ x, y, letter: mot[j]!, index: j });
  }

  let mainMult = 1;
  for (const p of poses) mainMult *= bonusAt(p.x, p.y, board.cfg.pavage).word;
  const poids = (p: { x: number; y: number }): number => {
    const b = bonusAt(p.x, p.y, board.cfg.pavage);
    const cc = board.crossCheck(dir, p.x, p.y);
    return b.letter * (mainMult + (cc.has ? b.word : 0));
  };

  const parLettre = new Map<string, typeof poses>();
  for (const p of poses) {
    let g = parLettre.get(p.letter);
    if (g === undefined) { g = []; parLettre.set(p.letter, g); }
    g.push(p);
  }
  const joker = new Set<number>();
  let reste = jokers;
  for (const [lettre, groupe] of parLettre) {
    const vrais = enMain[code(lettre) - 1]!;
    const manque = groupe.length - vrais;
    if (manque <= 0) continue;
    const tries = [...groupe].sort((a, b) => poids(a) - poids(b));
    for (let k = 0; k < manque && reste > 0; k++, reste--) joker.add(tries[k]!.index);
  }
  for (const p of poses) if (joker.has(p.index)) blancs[p.index] = true;

  return {
    dir, x: ox, y: oy, word: mot,
    score: scoreWord(board, dir, ox, oy, mot, neufs, blancs),
    placements: poses.map((p) => ({
      x: p.x, y: p.y, letter: p.letter, blank: joker.has(p.index),
    })),
  };
}
