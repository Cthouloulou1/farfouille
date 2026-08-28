/**
 * Generation exhaustive des coups (Gordon 1994, sur GADDAG). Voir SPEC.md §7.
 *
 * On part d'une case d'ancrage, on etend vers la gauche en consommant le
 * prefixe a l'envers, puis on franchit le separateur et on etend vers la droite.
 * Une seule passe, la ou un DAWG devrait regenerer les prefixes depuis la racine.
 *
 * Detail du format : dans nos rotations, le separateur est TOUJOURS present
 * (`rev(w[:i]) + SEP + w[i:]`, y compris pour i = n). Un mot qui s'arrete sur
 * l'ancrage a donc son drapeau terminal porte par l'arete SEPARATEUR, pas par
 * une arete lettre. D'ou deux tests de fin distincts selon la phase.
 */
import { Dict } from "./dictionary.ts";
import { code, letterOf, valueOf } from "./alphabet.ts";
import { keyX, keyY, step, type Dir } from "./coords.ts";
import { bonusAt } from "./bonus.ts";
import { MAX_WORD, type Board, type Placement } from "./board.ts";
import { type Move } from "./score.ts";
import { primeDe, valeurDe, type ConfigPartie } from "./config.ts";

const SEP_CODE = 27;
/** Nombre maximum de caramels posables, toutes variantes confondues. */
const MAX_PLACE = 15;

/**
 * Tables derivees d'une configuration, calculees une fois par appel.
 *
 * `val` evite un acces par nom a chaque case posee. `primeMax[n]` donne la plus
 * forte prime atteignable avec AU PLUS n caramels : le majorant doit rester
 * valide meme si la table des primes est reglee n'importe comment, par exemple
 * plus genereuse a deux caramels qu'a trois.
 */
function tables(cfg: ConfigPartie): { val: Int32Array; primeMax: Int32Array } {
  const val = new Int32Array(28);
  for (let c = 1; c <= 26; c++) val[c] = valeurDe(cfg, letterOf(c));
  const primeMax = new Int32Array(MAX_PLACE + 1);
  let m = 0;
  for (let n = 0; n <= MAX_PLACE; n++) { m = Math.max(m, primeDe(cfg, n)); primeMax[n] = m; }
  return { val, primeMax };
}
/** Decalage pour indexer des positions relatives negatives dans un tableau plat. */
const OFF = 20;

/**
 * Majorant du score atteignable depuis une case d'ancrage, dans un sens donne.
 *
 * ADMISSIBLE PAR CONSTRUCTION : chaque terme surestime separement, donc la
 * somme surestime. C'est ce qui garantit qu'aucun top n'est perdu.
 *
 * En particulier le majorant compte TOUJOURS la prime de scrabble et la valeur
 * des sept caramels, meme sur une zone sans la moindre case bonus. Un
 * "blanchard" -- sept caramels poses sur des cases blanches -- a donc un
 * plafond de 70 a 90 points et ne peut pas etre elague par erreur. C'est
 * exactement le piege qu'un elagage heuristique du genre "pas de bonus dans le
 * coin, on saute" ferait tomber.
 *
 * Le majorant est volontairement grossier : il doit couter beaucoup moins cher
 * que l'exploration qu'il evite. Sa qualite se juge au taux d'elagage, pas a sa
 * finesse.
 */
export function anchorBound(
  board: Board, ax: number, ay: number, dir: Dir, rackValues: readonly number[],
  primeMax: Int32Array = tables(board.cfg).primeMax,
): number {
  const jouables = Math.min(board.cfg.jouables, MAX_PLACE);
  const { dx, dy } = step(dir);
  const { isOcc, occVal, cLm, cWm, cCs, topCross } = SCRATCH;

  for (let i = 0; i < SPAN; i++) {
    const p = i - (MAX_WORD - 1);
    const x = ax + dx * p;
    const y = ay + dy * p;
    const t = board.at(x, y);
    if (t !== undefined) {
      isOcc[i] = 1;
      occVal[i] = t.blank ? 0 : valeurDe(board.cfg, t.letter);
      continue;
    }
    const b = bonusAt(x, y, board.cfg.pavage);
    isOcc[i] = 0;
    cLm[i] = b.letter;
    cWm[i] = b.word;
    cCs[i] = board.crossScoreQuick(dir, x, y);
  }

  // Les plus gros mots perpendiculaires de toute la portee -- autant qu'on peut
  // poser de caramels. Majorer par la
  // portee entiere plutot que par fenetre est plus lache, mais ces scores sont
  // nuls presque partout sur une grille creuse, et ca evite de les faire glisser.
  topCross.fill(0);
  for (let i = 0; i < SPAN; i++) {
    if (isOcc[i] === 1) continue;
    const v = cCs[i]!;
    if (v > topCross[jouables - 1]!) {
      let j = jouables - 1;
      while (j > 0 && topCross[j - 1]! < v) { topCross[j] = topCross[j - 1]!; j--; }
      topCross[j] = v;
    }
  }

  // TOUT le reste se calcule par FENETRE DE 15 cases contenant l'ancrage, jamais
  // sur les 29 : un mot legal tient forcement dans l'une d'elles, donc le maximum
  // sur les fenetres reste un majorant valide, mais beaucoup plus serre.
  //
  // La fenetre GLISSE au lieu d'etre recalculee : on ajoute la case qui entre et
  // on retire celle qui sort. Le majorant passe de 225 a 29 operations par
  // couple (ancrage, sens) -- sur un tirage pauvre, l'ancienne version coutait
  // plus cher que la generation qu'elle evitait.
  let existing = 0, empties = 0, n3 = 0, n2 = 0, w3 = 0, w2 = 0;
  const enter = (i: number) => {
    if (isOcc[i] === 1) { existing += occVal[i]!; return; }
    empties++;
    const m = cLm[i]!;
    if (m === 3) n3++; else if (m === 2) n2++;
    const w = cWm[i]!;
    if (w === 3) w3++; else if (w === 2) w2++;
  };
  const leave = (i: number) => {
    if (isOcc[i] === 1) { existing -= occVal[i]!; return; }
    empties--;
    const m = cLm[i]!;
    if (m === 3) n3--; else if (m === 2) n2--;
    const w = cWm[i]!;
    if (w === 3) w3--; else if (w === 2) w2--;
  };

  for (let i = 0; i < MAX_WORD; i++) enter(i);

  let best = 0;
  for (let sIdx = 0; sIdx <= MAX_WORD - 1; sIdx++) {
    if (sIdx > 0) { leave(sIdx - 1); enter(sIdx + MAX_WORD - 1); }

    const n = Math.min(jouables, empties);
    if (n === 0) continue;

    // Comptages entiers plutot qu'un produit glissant : pas de division, donc
    // pas de derive numerique.
    const wordMult = Math.pow(3, w3) * Math.pow(2, w2);

    // Appariement trie : les plus fortes lettres du tirage sur les plus forts
    // multiplicateurs. Aucun placement reel ne peut faire mieux.
    const k3 = Math.min(n3, n);
    const k2 = Math.min(n2, n - k3);
    let letters = 0;
    let crossPart = 0;
    for (let i = 0; i < n; i++) {
      const m = i < k3 ? 3 : i < k3 + k2 ? 2 : 1;
      const here = (rackValues[i] ?? 0) * m;
      letters += here;
      crossPart += (here + topCross[i]!) * wordMult;
    }

    // On ne peut esperer que la meilleure prime atteignable avec le nombre de
    // cases libres qui tiennent ici.
    const b = (existing + letters) * wordMult + crossPart + primeMax[n]!;
    if (b > best) best = b;
  }
  return best;
}

const SPAN = MAX_WORD * 2 - 1;   // 29 cases : de -14 a +14 autour de l'ancrage

// Tampons reutilises : anchorBound est appele des milliers de fois par coup,
// allouer a chaque appel dominerait son cout.
const SCRATCH = {
  isOcc: new Uint8Array(SPAN),
  occVal: new Int32Array(SPAN),
  cLm: new Int32Array(SPAN),
  cWm: new Int32Array(SPAN),
  cCs: new Int32Array(SPAN),
  topCross: new Int32Array(MAX_PLACE),
};

export interface GenOptions {
  /**
   * Elaguer les ancrages dont le majorant ne peut pas atteindre le meilleur
   * score deja trouve. Preserve le top ET tous ses isotops -- un isotop a par
   * definition le meilleur score, donc le majorant de son ancrage lui est
   * superieur ou egal, et l'ancrage n'est jamais saute.
   *
   * NE PRESERVE PAS les sous-tops au-dela de `keep` : un coup a 40 points peut
   * vivre sur un ancrage dont le majorant vaut 90 alors que le top en fait 150.
   */
  prune?: boolean;

  /**
   * Nombre de PALIERS DE SCORE a conserver sous le top.
   *
   * Un palier est un score, avec TOUS les coups qui le realisent. Le palier 0
   * est le top et ses isotops ; le palier 1 est "le" sous-top au sens du jargon
   * -- la deuxieme solution la plus lucrative de la grille.
   *
   * 0 (defaut) : le top seul, ce dont le serveur a besoin pour arbitrer un coup.
   *
   * On retient toujours des paliers ENTIERS. Un plafond exprime en nombre de
   * coups couperait au milieu d'un palier : sur `?AEILRT`, le palier a 78 points
   * compte 254 coups, et un plafond a 100 en afficherait 74 sans dire que les
   * 180 autres existent. Le nombre de coups par palier varie d'un facteur 300
   * d'un tirage a l'autre.
   *
   * Avec `prune: false`, le defaut devient Infinity : tout est retenu.
   */
  tiers?: number;

  /**
   * Garde-fou, en nombre de coups. On abandonne les paliers du bas jusqu'a
   * passer sous ce plafond, TOUJOURS a une frontiere de palier.
   *
   * Le palier du top n'est jamais sacrifie, meme s'il depasse a lui seul :
   * `??AEILR` produit 163 isotops, et tronquer des isotops n'aurait aucun sens
   * puisqu'ils sont tous des tops valables.
   */
  maxMoves?: number;
}

export interface GenStats {
  /** Coups distincts retenus (meme mot, meme case, meme sens = un seul coup). */
  moves: number;
  /** Coups produits avant deduplication : mesure le travail redondant. */
  raw: number;
  /** Ancrages reellement explores. */
  anchors: number;
  /** Ancrages ecartes par l'elagage. */
  pruned: number;
  ms: number;
}

export interface GenResult {
  moves: Move[];
  stats: GenStats;
}

/**
 * Tous les coups legaux pour ce tirage. `rack` est une chaine de lettres,
 * '?' pour un joker.
 *
 * Quand le tirage contient a la fois la lettre reelle et un joker, LES DEUX
 * branches sont explorees : le meilleur score gagne. C'est ainsi que
 * l'affectation joker / lettre reelle est optimisee sans post-traitement
 * (SPEC.md §6).
 */
export function generateMoves(
  board: Board, gaddag: Dict, rack: string, opts: GenOptions = {},
): GenResult {
  const prune = opts.prune !== false;
  // `prune: false` veut dire "donne-moi tout" : sans ce defaut, la generation
  // dite complete ne rendait que le top, et une comparaison de sous-tops se
  // faisait entre deux listes vides sans que rien ne le signale.
  const wantTiers = Math.max(0, opts.tiers ?? (opts.prune === false ? Infinity : 0));
  const maxMoves = Math.max(1, opts.maxMoves ?? Infinity);
  const t0 = performance.now();
  const E = gaddag.edges;
  // Tables de la partie jouee sur CETTE grille -- valeurs des lettres et primes.
  const { val: VAL, primeMax } = tables(board.cfg);
  const jouables = Math.min(board.cfg.jouables, MAX_PLACE);

  const counts = new Int32Array(27);
  let blanks = 0;
  for (const ch of rack) {
    if (ch === "?") blanks++;
    else counts[code(ch)]!++;
  }

  const cellCode = new Int32Array(OFF * 2 + 4);
  const cellNew = new Uint8Array(OFF * 2 + 4);
  const cellBlank = new Uint8Array(OFF * 2 + 4);

  const best = new Map<string, Move>();
  let raw = 0;
  let bestScore = -1;
  /** Score minimum pour meriter d'etre materialise. */
  let threshold = -Infinity;
  let trimAt = 64;

  /**
   * Garde tout ce qui est au meilleur score -- les isotops, dont le nombre n'est
   * pas plafonne -- plus les `wantSubTops` meilleurs coups strictement en
   * dessous, et remonte le seuil en consequence.
   *
   * Sur : le meilleur score et le K-ieme sous-top ne peuvent que MONTER au fil
   * de la generation, donc ce qui passe deja sous le seuil courant n'y
   * reviendra jamais.
   */
  function trim(): void {
    if (wantTiers === Infinity) return;

    const counts = new Map<number, number>();
    for (const m of best.values()) counts.set(m.score, (counts.get(m.score) ?? 0) + 1);
    const levels = [...counts.keys()].sort((a, b) => b - a);

    let kept = levels.slice(0, wantTiers + 1);
    if (maxMoves < Infinity) {
      let total = 0;
      let n = 0;
      for (const sc of kept) {
        const c = counts.get(sc)!;
        // Le palier du top passe toujours, quel que soit le plafond.
        if (n > 0 && total + c > maxMoves) break;
        total += c;
        n++;
      }
      kept = kept.slice(0, Math.max(1, n));
    }

    const cut = kept[kept.length - 1] ?? bestScore;
    // Le seuil ne redescend jamais : un coup deja ecarte ne pourrait pas revenir.
    if (cut > threshold) threshold = cut;
    for (const [k, m] of best) if (m.score < threshold) best.delete(k);

    // Amorti : sans cela, une position a 163 isotops declencherait un tri a
    // chaque coup retenu.
    trimAt = best.size * 2 + 64;
  }

  let ax = 0, ay = 0, dx = 1, dy = 0;
  let dir: Dir = "H";

  const occupied = (pos: number): boolean => board.occupied(ax + dx * pos, ay + dy * pos);
  /**
   * La case est-elle sur le plateau ? Sur une grille bornee, on ne descend pas
   * au-dela du bord. Attention : hors bornes n'est PAS occupe -- un mot a le
   * droit de commencer contre le bord, donc `occupied` doit continuer a
   * repondre faux la-bas.
   */
  const surLePlateau = (pos: number): boolean =>
    board.dansLesBornes(ax + dx * pos, ay + dy * pos);

  /**
   * Le score arrive DEJA CALCULE : il a ete accumule pendant la descente, case
   * par case. On ne reconstruit le mot, les placements et la cle que pour les
   * coups qui peuvent encore etre le top.
   *
   * C'est le gain principal : materialiser un coup coute environ 5 us, et une
   * position en produit des centaines de milliers dont un seul nous interesse.
   */
  function record(from: number, to: number, score: number): void {
    raw++;
    if (score > bestScore) bestScore = score;
    if (score < threshold) return;

    let word = "";
    const placements: Placement[] = [];
    const newAt: boolean[] = [];
    const blankAt: boolean[] = [];
    let blankRank = 0;
    for (let p = from; p <= to; p++) {
      const i = p + OFF;
      const L = letterOf(cellCode[i]!);
      const isNew = cellNew[i] === 1;
      const isBlank = cellBlank[i] === 1;
      word += L;
      newAt.push(isNew);
      blankAt.push(isBlank);
      if (isNew) placements.push({ x: ax + dx * p, y: ay + dy * p, letter: L, blank: isBlank });
      if (isBlank) blankRank += 0x10000 + (1 << (p - from));
    }
    const sx = ax + dx * from;
    const sy = ay + dy * from;

    // Meme mot, meme case, meme sens = un seul coup. On garde le meilleur score,
    // ce qui tranche aussi entre deux affectations de jokers concurrentes.
    const k = `${dir}${sx},${sy}:${word}`;
    const prev = best.get(k);
    let take = prev === undefined || score > prev.score;
    if (!take && prev !== undefined && score === prev.score) {
      // MEME mot, MEME case, MEME score, mais les jokers ne sont pas aux memes
      // lettres. Sans departage canonique on garderait celui trouve en premier,
      // donc un resultat dependant de l'ordre d'exploration -- et l'ordre change
      // avec l'elagage. Constate sur ?ADEFSZ : DESAMEZ vaut 148 points que le
      // joker soit sur l'un ou l'autre E, mais le caramel pose differe, la
      // grille evolue autrement, et les parties divergent 110 coups plus loin.
      //
      // Regle : le moins de jokers possible, puis les jokers le plus tot dans
      // le mot. Arbitraire, mais fixe.
      take = blankRank < prevBlankRank(prev, dir);
    }
    if (take) {
      best.set(k, { dir, x: sx, y: sy, word, placements, score });
      if (best.size >= trimAt) trim();
    }
  }

  /** Meme rang que `blankRank`, recalcule depuis un coup deja retenu. */
  function prevBlankRank(m: Move, d: Dir): number {
    let r = 0;
    for (const p of m.placements) {
      if (!p.blank) continue;
      r += 0x10000 + (1 << (d === "H" ? p.x - m.x : p.y - m.y));
    }
    return r;
  }

  function goOn(
    pos: number, c: number, isNew: boolean, isBlank: boolean,
    newNode: number, terminal: boolean,
    left: number, right: number, placed: number,
    sc: number, mult: number, cross: number,
  ): void {
    // Hors du plateau : rien a poser ici, ni au-dela.
    if (!surLePlateau(pos)) return;

    const nPlaced = placed + (isNew ? 1 : 0);
    // « X sur Y » : on pioche Y caramels mais on n'en pose que X au plus. Toute
    // descente qui depasserait X est abandonnee ici -- inutile de la poursuivre,
    // aucun mot plus long ne redeviendrait legal.
    if (nPlaced > jouables) return;

    const i = pos + OFF;
    cellCode[i] = c;
    cellNew[i] = isNew ? 1 : 0;
    cellBlank[i] = isBlank ? 1 : 0;

    // Score accumule case par case, exactement comme scoreWord() le ferait a la
    // fin -- mais le prefixe est partage par tous les mots qui en descendent.
    let nsc: number, nmult = mult, ncross = cross;
    if (isNew) {
      const b = bonusAt(ax + dx * pos, ay + dy * pos, board.cfg.pavage);
      const here = (isBlank ? 0 : VAL[c]!) * b.letter;
      nsc = sc + here;
      nmult = mult * b.word;
      const cc = board.crossCheck(dir, ax + dx * pos, ay + dy * pos);
      if (cc.has) ncross = cross + (cc.score + here) * b.word;
    } else {
      nsc = sc + (isBlank ? 0 : VAL[c]!);
    }
    const total = nsc * nmult + ncross + primeDe(board.cfg, nPlaced);

    if (pos <= 0) {
      const nLeft = pos;
      const prevFree = !occupied(pos - 1);

      if (newNode !== 0) {
        const si = gaddag.findEdge(newNode, SEP_CODE);
        if (si !== -1) {
          const se = E[si]!;
          // Arete separateur terminale : le mot s'arrete sur l'ancrage.
          if (Dict.isTerminal(se) && prevFree && nPlaced > 0 && !occupied(1)) {
            record(nLeft, 0, total);
          }
          const sepNode = Dict.target(se);
          if (sepNode !== 0 && prevFree) {
            gen(1, sepNode, nLeft, 0, nPlaced, nsc, nmult, ncross);
          }
        }
        // Poursuite vers la gauche, si la longueur maximale le permet.
        if (right - (pos - 1) + 1 <= MAX_WORD) {
          gen(pos - 1, newNode, nLeft, right, nPlaced, nsc, nmult, ncross);
        }
      }
    } else {
      const nRight = pos;
      if (terminal && nPlaced > 0 && !occupied(pos + 1)) {
        record(left, nRight, total);
      }
      if (newNode !== 0 && nRight + 1 - left + 1 <= MAX_WORD) {
        gen(pos + 1, newNode, left, nRight, nPlaced, nsc, nmult, ncross);
      }
    }
  }

  function tryLetter(
    pos: number, c: number, isNew: boolean, isBlank: boolean,
    node: number, left: number, right: number, placed: number,
    sc: number, mult: number, cross: number,
  ): void {
    const ei = gaddag.findEdge(node, c);
    if (ei === -1) return;
    const e = E[ei]!;
    goOn(pos, c, isNew, isBlank, Dict.target(e), Dict.isTerminal(e), left, right, placed, sc, mult, cross);
  }

  function gen(
    pos: number, node: number, left: number, right: number, placed: number,
    sc: number, mult: number, cross: number,
  ): void {
    const cx = ax + dx * pos;
    const cy = ay + dy * pos;
    const tile = board.at(cx, cy);

    if (tile !== undefined) {
      tryLetter(pos, code(tile.letter), false, tile.blank, node, left, right, placed, sc, mult, cross);
      return;
    }

    if (node === 0) return;
    const mask = board.crossCheck(dir, cx, cy).mask;

    // UNE SEULE passe sur les aretes reellement presentes sur le noeud, au lieu
    // de 26 recherches indexees. Decisif sur les tirages a joker : l'ancienne
    // version sondait les 26 lettres a chaque case vide, alors que la plupart
    // des noeuds n'ont qu'une poignee de continuations.
    for (let i = node; ; i++) {
      const e = E[i]!;
      const c = e >>> 27;
      const last = ((e >>> 26) & 1) === 1;
      // c === 27 est le separateur GADDAG : ce n'est pas une lettre jouable.
      if (c <= 26 && (mask & (1 << (c - 1))) !== 0) {
        const tgt = Dict.target(e);
        const term = Dict.isTerminal(e);
        if (counts[c]! > 0) {
          counts[c]!--;
          goOn(pos, c, true, false, tgt, term, left, right, placed, sc, mult, cross);
          counts[c]!++;
        }
        if (blanks > 0) {
          blanks--;
          goOn(pos, c, true, true, tgt, term, left, right, placed, sc, mult, cross);
          blanks++;
        }
      }
      if (last) break;
    }
  }

  // Premier coup : la grille est vide, le mot doit etre HORIZONTAL et couvrir
  // l'origine, qui est l'unique ancrage (SPEC.md §3).
  const dirs: Dir[] = board.isEmpty ? ["H"] : ["H", "V"];

  // Valeurs du tirage, triees decroissant : le majorant les apparie aux
  // meilleurs multiplicateurs a portee. Un joker vaut 0.
  const rackValues = [...rack]
    .map((c) => (c === "?" ? 0 : valeurDe(board.cfg, c)))
    .sort((a, b) => b - a);

  interface Task { x: number; y: number; d: Dir; bound: number }
  const tasks: Task[] = [];
  for (const k of board.anchors) {
    const x = keyX(k);
    const y = keyY(k);
    if (!board.dansLesBornes(x, y)) continue;
    for (const d of dirs) tasks.push({ x, y, d, bound: Infinity });
  }

  const run = (t: Task): void => {
    ax = t.x;
    ay = t.y;
    dir = t.d;
    const st = step(t.d);
    dx = st.dx;
    dy = st.dy;
    gen(0, gaddag.root, 0, 0, 0, 0, 1, 0);
  };

  let explored = 0;
  let pruned = 0;

  // Phase 1 : un echantillon d'ancrages est explore sans majorant.
  //
  // Il sert a deux choses : etablir un premier `bestScore`, qui rendra
  // l'elagage mordant tout de suite, et estimer le cout d'un ancrage sur cette
  // position-ci.
  //
  // L'estimation compte des COUPS PRODUITS, jamais des millisecondes. Une
  // premiere version chronometrait avec performance.now() : le moteur elaguait
  // ou non selon la vitesse de la machine, donc deux serveurs ne jouaient pas
  // la meme partie. SPEC.md §5 exige l'inverse.
  const SAMPLE = Math.min(96, tasks.length);
  for (let i = 0; i < SAMPLE; i++) { run(tasks[i]!); explored++; }
  const producedPerTask = raw / Math.max(1, SAMPLE);

  let i = SAMPLE;

  // Majorer un ancrage coute une trentaine de consultations de la grille, quoi
  // qu'il arrive ; l'explorer coute a peu pres proportionnellement au nombre de
  // coups qu'il produit. En dessous de ce seuil, le majorant coute plus cher que
  // l'exploration qu'il eviterait -- c'est le cas des tirages pauvres, ou la
  // position entiere ne produit qu'un ou deux coups par ancrage.
  const PRUNE_WORTH_IT = 8;

  if (prune && i < tasks.length && producedPerTask > PRUNE_WORTH_IT) {
    {
      for (let j = i; j < tasks.length; j++) {
        tasks[j]!.bound = anchorBound(
          board, tasks[j]!.x, tasks[j]!.y, tasks[j]!.d, rackValues, primeMax,
        );
      }
      const rest = tasks.slice(i);
      rest.sort((a, b) => b.bound - a.bound);
      for (let j = 0; j < rest.length; j++) {
        // Les taches etant triees, si celle-ci ne peut pas atteindre le seuil de
        // retenue, aucune des suivantes ne le peut non plus. Avec keep = 1 le
        // seuil est le meilleur score ; au-dela, c'est le K-ieme.
        const cut = wantTiers === 0 ? bestScore : threshold;
        if (rest[j]!.bound < cut) { pruned = rest.length - j; break; }
        run(rest[j]!);
        explored++;
      }
      i = tasks.length;
    }
  }

  // Pas d'elagage (desactive, ou juge non rentable) : on finit la liste.
  for (; i < tasks.length; i++) { run(tasks[i]!); explored++; }

  trim();
  const moves = [...best.values()];
  return {
    moves,
    stats: { moves: moves.length, raw, anchors: explored, pruned, ms: performance.now() - t0 },
  };
}

export interface TopResult {
  /** Le coup retenu, choisi parmi les isotops. */
  top: Move;
  /** Tous les coups au score maximum, le top inclus. Identique a tiers[0]. */
  isotops: Move[];
  /**
   * "Le" sous-top au sens strict : tous les coups du palier juste sous le top,
   * la deuxieme solution la plus lucrative. Vide si la generation n'a demande
   * aucun palier.
   */
  subTop: Move[];
  /**
   * Les paliers de score, du meilleur au moins bon, chacun COMPLET.
   * tiers[0] = isotops, tiers[1] = sous-top, tiers[2] = palier suivant...
   */
  tiers: Move[][];
  bestScore: number;
}

/**
 * Le top et ses isotops. Le departage est un TIRAGE AU SORT DETERMINISTE :
 * la graine vient de (idPartie, numeroDeCoup), sans quoi l'historique n'est pas
 * rejouable et deux serveurs divergent (SPEC.md §5).
 */
export function pickTop(moves: readonly Move[], random: () => number): TopResult | null {
  if (moves.length === 0) return null;
  let bestScore = -1;
  for (const m of moves) if (m.score > bestScore) bestScore = m.score;

  const isotops = moves.filter((m) => m.score === bestScore);
  // Ordre canonique avant tirage : deux serveurs doivent voir la meme liste.
  isotops.sort((a, b) =>
    a.dir === b.dir
      ? a.x !== b.x ? a.x - b.x : a.y !== b.y ? a.y - b.y : a.word < b.word ? -1 : a.word > b.word ? 1 : 0
      : a.dir < b.dir ? -1 : 1,
  );
  const top = isotops[Math.floor(random() * isotops.length)]!;

  // Regroupement en paliers complets : on n'affiche jamais une partie d'un
  // palier sans le reste (SPEC.md §10).
  const byScore = new Map<number, Move[]>();
  for (const m of moves) {
    let g = byScore.get(m.score);
    if (g === undefined) { g = []; byScore.set(m.score, g); }
    g.push(m);
  }
  const order = (a: Move, b: Move) =>
    a.dir === b.dir
      ? a.x !== b.x ? a.x - b.x : a.y !== b.y ? a.y - b.y : a.word < b.word ? -1 : a.word > b.word ? 1 : 0
      : a.dir < b.dir ? -1 : 1;
  const tiers = [...byScore.keys()]
    .sort((a, b) => b - a)
    .map((sc) => byScore.get(sc)!.sort(order));

  return { top, isotops, subTop: tiers[1] ?? [], tiers, bestScore };
}
