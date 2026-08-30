/**
 * Le client. Voir SPEC.md §9.
 *
 * Il partage le moteur avec le serveur -- meme dictionnaire, meme scoring, meme
 * resolution d'un mot tape. La validation est donc INSTANTANEE et locale, et un
 * mot accepte a l'ecran ne peut pas etre refuse ensuite.
 *
 * Le serveur reste seul juge de qui remporte le coup, sur l'ordre d'arrivee.
 */
import { Dict } from "../../engine/src/dictionary.ts";
import { Board, type Placement } from "../../engine/src/board.ts";
import { configParDefaut, deserialiser, type ConfigPartie } from "../../engine/src/config.ts";
import { bonusChar, setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { valueOf, BLANK } from "../../engine/src/alphabet.ts";
import { step, noteCoup, type Dir } from "../../engine/src/coords.ts";
import { resolveTypedWord, PLAY_MESSAGE } from "../../engine/src/play.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>("cv");
/**
 * Ou l'on dessine.
 *
 * Presque toujours le canevas de la page. Le temps d'une exportation, c'est un
 * canevas hors ecran, plus grand : `draw()` ne fait pas la difference, ce qui
 * garantit que l'image enregistree est bien ce qu'on voit -- memes caramels,
 * memes primes, meme mot cache si on l'a cache.
 */
let ctx = cv.getContext("2d")!;
/** Vrai le temps d'une exportation : le cache d'ecran ne sert alors a rien. */
let exportEnCours = false;
/** Numero du dernier coup a montrer sur une image d'archive, `null` sinon. */
let exportJusqua: number | null = null;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

interface Tile { x: number; y: number; l: string; b: 0 | 1; n: number }
interface MoveInfo {
  n: number; word: string; dir: Dir; x: number; y: number; score: number;
  player: string | null; ms: number; notation: string; rack: string;
  playerWord?: string; playerDir?: Dir; playerX?: number; playerY?: number;
  /** Demi-point : personne n'a trouve le top, celui-ci s'en est le plus approche. */
  demiPoint?: { joueur: string; word: string; score: number };
  /** DUPLICATE : ce que chaque joueur a marque sur ce coup. */
  scores?: Record<string, number>;
  /** DUPLICATE : qui a trouve le top, les plus rapides d'abord. */
  trouveurs?: string[];
  /** Ce que chaque joueur a reellement propose sur ce coup. */
  propositions?: Record<string, { word: string; dir: Dir; x: number; y: number; score: number }>;
  /** Nombre de "j'aime" recus, et qui les a donnes. */
  likes?: number; likers?: string[];
}
interface Chat { at: number; who: string; text: string; cell?: { x: number; y: number } }

let dict: Dict;
/** Le dictionnaire n'est telecharge qu'une fois, au premier salon rejoint. */
let dictCharge = false;
let board: Board;
/** La variante jouee, envoyee par le serveur a la connexion. */
let cfg: ConfigPartie = configParDefaut();
/** La partie est terminee : plus de tirage, plus de chrono, plus de saisie. */
let finie = false;
/** Duree d'un coup en secondes, quand la partie est chronometree. */
let chrono: number | null = null;
/** Le salon est vide : le coup ne s'ecoule pas. */
let endormi = false;
/** Au duplicate, chacun marque : le classement se lit en points et negatif. */
let duplicate = false;
let points: Record<string, number> = {};
let negatif: Record<string, number> = {};
/** Coups que personne n'a trouves. */
let nonTrouves = 0;
/** Fin du decompte d'avant-coup, 0 s'il n'y en a pas. */
let decompteJusqua = 0;
/** La partie du salon a-t-elle commence ? Un salon neuf attend ses reglages. */
let demarree = true;
/**
 * La configuration du salon est-elle arrivee ?
 *
 * Tant qu'elle manque, on ne dessine RIEN. Sans ce verrou, la grille etait
 * peinte une premiere fois avec le cadrage du salon precedent -- une grille
 * geante ou decalee -- avant de sauter en place a l'arrivee de `hello`. C'est
 * ce saut qu'on voyait clignoter.
 */
let configRecue = false;
/** Nombre de coups prevus, null si la partie est sans fin. */
let coupsMax: number | null = null;
/** Duree totale prevue en secondes, et instant du premier tirage. */
let dureeMax: number | null = null;
let debutDeLaPartie = 0;

/** Instant ou CE fichier a ete compile, grave par tools/build.mjs. */
declare const __COMPILE_A__: number;
let tiles: Tile[] = [];
let history: MoveInfo[] = [];
let me = "";
let ws: WebSocket | null = null;
let canReveal = false;

let rack = "";
let moveNumber = 0;
let cumul = 0;
let solving = true;
let players: Record<string, number> = {};
/** "J'aime" recus par joueur sur toute la partie. */
let likes: Record<string, number> = {};
let online: string[] = [];
let last: MoveInfo | null = null;
let createdAt = Date.now();
let servedAt = Date.now();
/** Ecart entre l'horloge du serveur et la notre. */
let clockSkew = 0;

let cursor: { x: number; y: number; dir: Dir } | null = null;
let typed = "";
let best: { word: string; score: number; dir: Dir; x: number; y: number } | null = null;
let openPlayer: string | null = null;
let marks: { x: number; y: number }[] = [];

/** Coup examine : la grille est rembobinee et une solution posee par-dessus. */
/** Le coup mis en evidence sur la grille, quand on en clique un. */
let ghost: [string, Dir, number, number] | null = null;
/**
 * Le mot du rejeu est-il cache sur la grille ?
 *
 * De quoi faire chercher un coup a quelqu'un : le tirage et la grille sont la,
 * la reponse ne l'est pas. Le reglage TIENT d'un coup a l'autre -- on fait
 * rarement deviner un seul coup -- et se retire en fermant le rejeu.
 */
let ghostCache = false;

interface Palier { score: number; moves: [string, Dir, number, number][] }
/**
 * Le rejeu : on remonte la partie coup par coup, une fois qu'elle est finie.
 *
 * `n` est le coup qu'on examine. La grille n'affiche que les caramels poses
 * AVANT lui : on voit ce que voyaient les joueurs au moment de chercher.
 */
let rejeu: { n: number; paliers: Palier[] | null } | null = null;

let cell = 30, ox = 0, oy = 0, W = 0, H = 0;

// ---------------------------------------------------------------- rendu

function resize() {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cadrer();
  draw();
}

/**
 * Une grille bornee tient toute a l'ecran, centree, et n'en bouge plus.
 *
 * Il n'y a rien a explorer : le plateau est entierement visible. Pouvoir le
 * deplacer ou le dezoomer n'apporte que des reglages a refaire et des lignes
 * qui bougent sous les yeux du joueur.
 */
function cadrer(): void {
  const b = cfg.bornes;
  if (b === null) return;
  const cotes = b * 2 + 1;
  const RULE = 34;   // place laissee aux regles, en haut et a gauche
  cell = Math.max(12, Math.floor(Math.min(W - RULE - 12, H - RULE - 12) / cotes));
  const taille = cell * cotes;
  ox = RULE + Math.max(0, (W - RULE - taille) / 2) + b * cell;
  oy = RULE + Math.max(0, (H - RULE - taille) / 2) + b * cell;
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function typedCells(): { x: number; y: number; letter: string }[] {
  if (cursor === null) return [];
  const { dx, dy } = step(cursor.dir);
  const out: { x: number; y: number; letter: string }[] = [];
  let i = 0, px = cursor.x, py = cursor.y, guard = 0;
  while (i < typed.length && guard++ < 40) {
    if (board.at(px, py) === undefined) { out.push({ x: px, y: py, letter: typed[i]! }); i++; }
    px += dx; py += dy;
  }
  return out;
}

function nextFree(): { x: number; y: number } | null {
  if (cursor === null) return null;
  const { dx, dy } = step(cursor.dir);
  const busy = new Set(typedCells().map((c) => `${c.x},${c.y}`));
  let px = cursor.x, py = cursor.y, guard = 0;
  while (guard++ < 40) {
    if (board.at(px, py) === undefined && !busy.has(`${px},${py}`)) return { x: px, y: py };
    px += dx; py += dy;
  }
  return null;
}

/** Quelles lettres tapees sont posees par un joker, d'apres le moteur lui-meme. */
function blankPositions(): Set<string> {
  const out = new Set<string>();
  if (cursor === null || typed.length === 0) return out;
  const r = resolveTypedWord(board, dict, cursor.dir, cursor.x, cursor.y, typed, rack, false, true);
  if (!r.ok) return out;
  for (const p of r.move.placements) if (p.blank) out.add(`${p.x},${p.y}`);
  return out;
}

/**
 * La couche des caramels, gardee en image.
 *
 * Se deplacer ne change ni la grille ni l'echelle : seule la camera bouge. Il
 * n'y a donc aucune raison de redessiner des milliers de caramels a chaque
 * image -- on les dessine UNE fois dans une image de cote, un peu plus grande
 * que l'ecran, et le deplacement n'est plus qu'une recopie.
 *
 * L'image de cote deborde de `MARGE` pixels de chaque cote : tant que la camera
 * reste dans cette marge, la recopie suffit. Au-dela, on la refait. Un
 * deplacement rapide la refait donc quelques fois par seconde au lieu de
 * soixante.
 *
 * C'est ce qui permet de garder les LETTRES a toutes les echelles. Elles
 * coutent un appel de dessin chacune -- l'essentiel du temps d'une image au
 * dezoom -- mais ce cout n'est plus paye qu'a la reconstruction.
 */
const MARGE_CACHE = 320;

/**
 * De combien l'image de cote deborde de l'ecran, selon l'echelle.
 *
 * La marge se compte en pixels, mais ce qu'elle coute se compte en CASES. A
 * douze pixels par case, 320 pixels font vingt-six cases de rab ; a deux
 * pixels, ils en font cent soixante, et l'image de cote couvre alors trois fois
 * la surface de l'ecran -- donc trois fois les caramels a peindre, pour une
 * marge dont on n'a pas plus besoin.
 *
 * Elle suit donc l'echelle. En dessous, le glissement se declenche un peu plus
 * souvent, mais chaque glissement coute d'autant moins.
 */
const margeVoulue = (): number => Math.max(48, Math.min(MARGE_CACHE, Math.round(cell * 26)));
let cache: HTMLCanvasElement | null = null;
let cacheCtx: CanvasRenderingContext2D | null = null;
let cacheCle = "";
let cacheOx = 0, cacheOy = 0;
/** Taille de case a laquelle l'image de cote a ete peinte. */
let cacheCell = 0;
/** Marge a laquelle l'image de cote a ete taillee. */
let cacheMarge = MARGE_CACHE;
/** Attend l'arret du zoom pour repeindre net. */
let zoomRepos = 0;

function draw() {
  if (!configRecue) {
    // Rien a montrer encore : un fond uni vaut mieux qu'une grille fausse.
    ctx.fillStyle = css("--ground");
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const C = {
    field: css("--field"), line: css("--field-line"), face: css("--tile-face"),
    edge: css("--tile-edge"), ink: css("--tile-ink"), accent: css("--accent"),
    cursor: css("--cursor"), mark: css("--mark"), faint: css("--ink-faint"),
    panel: css("--panel"), rule: css("--rule"), abg: css("--accent-bg"), dark: css("--ink"),
    gface: css("--ghost-face"), gedge: css("--ghost-edge"), gink: css("--ghost-ink"),
    ground: css("--ground"), bord: css("--ink-soft"),
    jface: css("--joker-face"), jedge: css("--joker-edge"),
    T: css("--mct"), D: css("--mcd"), t: css("--lct"), d: css("--lcd"),
  };
  ctx.fillStyle = C.field;
  ctx.fillRect(0, 0, W, H);

  const gx0 = Math.floor(-ox / cell) - 1, gx1 = Math.ceil((W - ox) / cell) + 1;
  const gy0 = Math.floor(-oy / cell) - 1, gy1 = Math.ceil((H - oy) / cell) + 1;
  // Sur une grille bornee, on ne peint que le plateau : au-dela il n'y a rien,
  // et une grille qui continue au-dela du bord donne l'impression d'etre infinie.
  const b = cfg.bornes;
  const px0 = b === null ? gx0 : Math.max(gx0, -b), px1 = b === null ? gx1 : Math.min(gx1, b);
  const py0 = b === null ? gy0 : Math.max(gy0, -b), py1 = b === null ? gy1 : Math.min(gy1, b);
  // Bords arrondis au pixel : sinon deux cases voisines tombent sur des
  // fractions differentes et laissent des lisieres irregulieres.
  const eX = (x: number) => Math.round(ox + x * cell);
  const eY = (y: number) => Math.round(oy + y * cell);

  if (b !== null) {
    // Hors plateau : un fond mat, distinct du damier.
    ctx.fillStyle = C.ground;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = C.field;
    ctx.fillRect(eX(-b), eY(-b), eX(b + 1) - eX(-b), eY(b + 1) - eY(-b));
  }

  /**
   * Les primes et le quadrillage, dans l'image de cote.
   *
   * Ils ne changent pas plus que les caramels quand la camera bouge, et au
   * dezoom maximum ils coutent bien davantage : la boucle des primes parcourt
   * CHAQUE case visible, soit cent quatre-vingt-dix mille cases a deux pixels
   * de cote. Les laisser dehors, c'etait payer 24 ms par image pour un fond
   * fixe.
   */
  const peindreLeFond = (
    g: CanvasRenderingContext2D, orgX: number, orgY: number,
    rx: number, ry: number, rw: number, rh: number,
  ): void => {
    const X = (x: number) => auPixelEcran(orgX + x * cell);
    const Y = (y: number) => auPixelEcran(orgY + y * cell);
    let a0 = Math.floor((rx - orgX) / cell) - 1, a1 = Math.ceil((rx + rw - orgX) / cell);
    let b0 = Math.floor((ry - orgY) / cell) - 1, b1 = Math.ceil((ry + rh - orgY) / cell);
    if (b !== null) {
      a0 = Math.max(a0, -b); a1 = Math.min(a1, b);
      b0 = Math.max(b0, -b); b1 = Math.min(b1, b);
    }
    const parPrime = new Map<string, [number, number][]>();
    for (let y = b0; y <= b1; y++) {
      for (let x = a0; x <= a1; x++) {
        const ch = bonusChar(x, y, cfg.pavage);
        if (ch === ".") continue;
        const cle = ch === "*" ? "D" : ch;
        const l = parPrime.get(cle);
        if (l === undefined) parPrime.set(cle, [[x, y]]); else l.push([x, y]);
      }
    }
    for (const [cle, cases] of parPrime) {
      g.fillStyle = (C as Record<string, string>)[cle] ?? C.D;
      g.beginPath();
      for (const [x, y] of cases) g.rect(X(x), Y(y), X(x + 1) - X(x), Y(y + 1) - Y(y));
      g.fill();
    }
    g.strokeStyle = C.line;
    g.lineWidth = 1;
    g.beginPath();
    const ly0 = b === null ? ry : Y(-b), ly1 = b === null ? ry + rh : Y(b + 1);
    const lx0 = b === null ? rx : X(-b), lx1 = b === null ? rx + rw : X(b + 1);
    for (let x = a0; x <= a1 + (b === null ? 0 : 1); x++) {
      const q = X(x) + .5; g.moveTo(q, ly0); g.lineTo(q, ly1);
    }
    for (let y = b0; y <= b1 + (b === null ? 0 : 1); y++) {
      const q = Y(y) + .5; g.moveTo(lx0, q); g.lineTo(lx1, q);
    }
    g.stroke();
  };

  // Le bord du plateau, trace franc pour qu'on voie ou la grille s'arrete.
  if (b !== null) {
    ctx.strokeStyle = C.bord;
    ctx.lineWidth = 2;
    ctx.strokeRect(eX(-b) - 1, eY(-b) - 1, eX(b + 1) - eX(-b) + 2, eY(b + 1) - eY(-b) + 2);
    ctx.lineWidth = 1;
  }

  if (tiles.length === 0) {
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
    ctx.strokeRect(eX(0) + 1, eY(0) + 1, eX(1) - eX(0) - 2, eY(1) - eY(0) - 2);
  }

  /**
   * Arrondi des coordonnees : au pixel D'ECRAN, pas au pixel de mise en page.
   *
   * C'EST L'ORIGINE DES LIGNES CLAIRES qui traversaient la grille.
   *
   * L'image de cote glisse d'un nombre entier de pixels d'ecran -- il le faut,
   * sinon elle se reechantillonne et devient floue. Sur un ecran a 125 %, cela
   * fait un nombre FRACTIONNAIRE de pixels de mise en page : 141 pixels d'ecran
   * valent 112,8 pixels de mise en page. Or les cases se calaient sur des
   * pixels de mise en page ENTIERS. La bande fraichement repeinte se trouvait
   * donc decalee de jusqu'a un demi-pixel par rapport a tout ce qui l'entourait
   * et qui, lui, avait simplement glisse. A la jonction : une couture claire,
   * droite, qui ne partait qu'a la reconstruction complete -- donc au premier
   * changement de zoom.
   *
   * En pixels d'ecran, le glissement et le trace parlent la meme langue.
   */
  const dprGrille = Math.min(devicePixelRatio || 1, 2);
  const auPixelEcran = (v: number) => Math.round(v * dprGrille) / dprGrille;

  const gap = cell >= 22 ? 1 : 0;
  const rad = Math.max(.8, cell * .05);
  /** Au-dela, l'arrondi se voit et vaut son prix. */
  const arrondi = cell >= 22;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const caramel = (x: number, y: number, letter: string, blank: boolean, face: string,
                   edge: string, encre?: string) => {
    const px = eX(x) + gap, py = eY(y) + gap;
    const w = eX(x + 1) - eX(x) - gap * 2, h = eY(y + 1) - eY(y) - gap * 2;
    roundRect(px, py, w, h, rad);
    ctx.fillStyle = face; ctx.fill();
    roundRect(px + .5, py + .5, w - 1, h - 1, rad);
    ctx.lineWidth = 1; ctx.strokeStyle = edge; ctx.stroke();
    ctx.fillStyle = encre ?? (blank ? C.jedge : C.ink);
    ctx.font = `700 ${Math.round(h * .62)}px Archivo, system-ui, sans-serif`;
    ctx.fillText(letter, px + w / 2, py + h * .53);
    // Un joker vaut zero, et il l'affiche : le 0 dit ce qu'il rapporte.
    const v = blank ? 0 : valueOf(letter);
    if (h >= 18) {
      ctx.fillStyle = encre ?? (blank ? C.jedge : C.ink); ctx.globalAlpha = blank ? .8 : .6;
      ctx.font = `500 ${Math.round(h * .27)}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "right";
      ctx.fillText(String(v), px + w - w * .1, py + h * .84);
      ctx.textAlign = "center"; ctx.globalAlpha = 1;
    }
  };

  /**
   * Un lot de caramels de meme couleur, en un seul chemin.
   *
   * La lettre ne se trace qu'a partir de `LISIBLE` : en dessous elle mesure
   * moins de dix pixels et ne se lit pas, alors qu'elle coute un appel de dessin
   * par caramel -- l'essentiel du temps d'une image au dezoom maximum. Ce qu'on
   * regarde a cette echelle, c'est la FORME de la grille, pas les lettres.
   */
  const caramels = (
    g: CanvasRenderingContext2D, lot: readonly Tile[], face: string, edge: string,
    orgX: number, orgY: number,
  ): void => {
    if (lot.length === 0) return;
    const X = (x: number) => auPixelEcran(orgX + x * cell);
    const Y = (y: number) => auPixelEcran(orgY + y * cell);
    g.beginPath();
    for (const q of lot) {
      const px = X(q.x) + gap, py = Y(q.y) + gap;
      const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
      if (arrondi) {
        g.moveTo(px + rad, py);
        g.arcTo(px + w, py, px + w, py + h, rad);
        g.arcTo(px + w, py + h, px, py + h, rad);
        g.arcTo(px, py + h, px, py, rad);
        g.arcTo(px, py, px + w, py, rad);
        g.closePath();
      } else {
        g.rect(px + .5, py + .5, w - 1, h - 1);
      }
    }
    g.fillStyle = face; g.fill();
    g.lineWidth = 1; g.strokeStyle = edge; g.stroke();

    // La lettre est dessinee A TOUTE ECHELLE. Meme reduite a une tache, elle
    // fait la difference entre une grille de jeu et un damier de couleurs :
    // c'est ce qu'on regarde quand on prend du recul sur une partie. Son cout
    // est paye a la construction de l'image de cote, pas a chaque deplacement.
    const hMoy = cell - gap * 2;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `700 ${Math.max(2, Math.round(hMoy * .62))}px Archivo, system-ui, sans-serif`;
    for (const q of lot) {
      const px = X(q.x) + gap, py = Y(q.y) + gap;
      const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
      g.fillStyle = q.b === 1 ? C.jedge : C.ink;
      g.fillText(q.l, px + w / 2, py + h * .53);
    }
    // La valeur du caramel, seulement quand elle tient : sous dix-huit pixels
    // de haut, le chiffre est un point gris qui n'apprend rien.
    if (hMoy < 18) return;
    g.font = `500 ${Math.round(hMoy * .27)}px "IBM Plex Mono", monospace`;
    g.textAlign = "right";
    for (const q of lot) {
      const px = X(q.x) + gap, py = Y(q.y) + gap;
      const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
      g.fillStyle = q.b === 1 ? C.jedge : C.ink;
      g.globalAlpha = q.b === 1 ? .8 : .6;
      g.fillText(String(q.b === 1 ? 0 : valueOf(q.l)), px + w - w * .1, py + h * .84);
    }
    g.globalAlpha = 1;
    g.textAlign = "center";
  };

  // Pendant le rejeu, on ne montre que ce qui etait pose AVANT le coup examine.
  // Une image tiree de la feuille de route fixe la meme borne, sans passer par
  // le rejeu : elle est disponible en cours de partie, y compris sur une grille
  // infinie ou le rejeu, lui, ne l'est pas.
  const jusqua = exportJusqua ?? (rejeu === null ? Infinity : rejeu.n - 1);
  // Le dernier coup joue reste souligne sur la grille.
  const hl = new Set(
    rejeu !== null || last === null
      ? [] : tiles.filter((t) => t.n === last!.n).map((t) => `${t.x},${t.y}`),
  );
  // Les caramels poses, groupes par couleur.
  //
  // Un caramel dessine seul coute deux chemins, un remplissage, un contour et
  // un texte. Au dezoom maximum, l'ecran en montre des milliers : mesure a
  // 59 ms par image pour trois mille, alors qu'une image en a seize. Groupes
  // par teinte et traces en carre, les memes trois mille tombent a 0,65 ms.
  //
  // Ce sont les COINS ARRONDIS qui coutent, pas le nombre de caramels : trois
  // mille arrondis dans un seul chemin demandent encore 70 ms. Un arrondi de
  // 0,8 pixel ne se voit pas ; en dessous de la taille ou il se voit, on trace
  // des carres.
  /**
   * Peint les caramels d'un rectangle de l'image de cote.
   *
   * `orgX`/`orgY` sont les coordonnees d'ecran, DANS L'IMAGE DE COTE, de la
   * case (0,0). On ne peint que ce qui tombe dans le rectangle demande : c'est
   * ce qui permet, apres un glissement, de ne repeindre que la bande decouverte.
   */
  const peindreLot = (
    g: CanvasRenderingContext2D, orgX: number, orgY: number,
    rxBrut: number, ryBrut: number, rwBrut: number, rhBrut: number,
    effacer = true,
  ): void => {
    if (rwBrut <= 0 || rhBrut <= 0) return;
    // La bande deborde d'un pixel d'ecran de chaque cote. Ce n'est pas ce qui
    // causait les coutures -- voir `auPixelEcran` -- mais repeindre un pixel
    // deja juste ne coute rien, et cela met la jonction a l'abri des arrondis.
    const unPixel = 1 / dprGrille;
    const rx = auPixelEcran(rxBrut) - unPixel;
    const ry = auPixelEcran(ryBrut) - unPixel;
    const rw = auPixelEcran(rwBrut) + unPixel * 2;
    const rh = auPixelEcran(rhBrut) + unPixel * 2;
    const x0 = Math.floor((rx - orgX) / cell) - 1, x1 = Math.ceil((rx + rw - orgX) / cell);
    // Le fond se peint meme sans un seul caramel dans la bande.

    const y0 = Math.floor((ry - orgY) / cell) - 1, y1 = Math.ceil((ry + rh - orgY) / cell);
    const groupes = new Map<string, { face: string; edge: string; t: Tile[] }>();
    for (const q of tiles) {
      if (q.n > jusqua) continue;
      if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) continue;
      const face = q.b === 1 ? C.jface : C.face;
      const edge = hl.has(`${q.x},${q.y}`) ? C.accent : q.b === 1 ? C.jedge : C.edge;
      const k = `${face}|${edge}`;
      const l = groupes.get(k);
      if (l === undefined) groupes.set(k, { face, edge, t: [q] }); else l.t.push(q);
    }
    g.save();
    g.beginPath(); g.rect(rx, ry, rw, rh); g.clip();
    if (effacer) g.clearRect(rx, ry, rw, rh);
    peindreLeFond(g, orgX, orgY, rx, ry, rw, rh);
    for (const l of groupes.values()) caramels(g, l.t, l.face, l.edge, orgX, orgY);
    g.restore();
  };

  if (exportEnCours) {
    // Une image d'exportation fait plusieurs milliers de pixels de cote : lui
    // reserver une image de cote plus grande encore couterait des centaines de
    // megaoctets pour un dessin qui n'aura lieu qu'une fois.
    peindreLot(ctx, ox, oy, 0, 0, W, H, false);
  } else {
    // Une marge qui change demande une image de cote d'une autre taille : on la
    // refait alors entierement, ce qui n'arrive qu'apres un changement d'echelle.
    const refaire = cacheCell === 0 || margeVoulue() !== cacheMarge;
    if (refaire) cacheMarge = margeVoulue();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    // La taille de l'image de cote se decide en pixels D'ECRAN, et sa taille en
    // pixels de mise en page s'en deduit. L'inverse -- arrondir une largeur de
    // mise en page en pixels d'ecran -- laissait un rapport qui n'etait pas
    // tout a fait un : l'image se reechantillonnait a chaque pose.
    const largeurCache = Math.round((W + cacheMarge * 2) * dpr);
    const hauteurCache = Math.round((H + cacheMarge * 2) * dpr);
    const cw = largeurCache / dpr, ch = hauteurCache / dpr;


    // La cle dit tout ce qui change le dessin des caramels, la position mise a
    // part : l'echelle, ce qui est pose, ce qui est souligne, le theme.
    // L'echelle ne fait PAS partie de la cle : la changer n'invalide pas ce
    // qu'on a peint, on sait l'etirer. Le reste, si.
    const cle = `${tiles.length}|${jusqua}|${last?.n ?? -1}|${C.face}|${W}x${H}`;
    if (cache === null) { cache = document.createElement("canvas"); cacheCtx = cache.getContext("2d"); }
    if (cache.width !== largeurCache || cache.height !== hauteurCache) {
      cache.width = largeurCache;
      cache.height = hauteurCache;
      cacheCle = "";
    }
    const g = cacheCtx!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (cacheCle !== cle || refaire) {
      // Tout a change : on repeint l'image entiere.
      g.clearRect(0, 0, cw, ch);
      peindreLot(g, ox + cacheMarge, oy + cacheMarge, 0, 0, cw, ch);
      cacheCle = cle; cacheOx = ox; cacheOy = oy; cacheCell = cell;
    } else if (cell !== cacheCell) {
      // ZOOM EN COURS. On ne repeint pas : on ETIRE ce qu'on a deja, et on
      // repeindra net des que la molette s'arrete.
      //
      // Repeindre a chaque cran coutait pres d'une seconde sur une partie de
      // cinq mille coups : une image de cote entiere, vingt-six mille caramels
      // et leurs lettres, pour un cran de molette aussitot suivi du suivant. La
      // vue est un peu molle le temps du geste, nette des qu'il cesse.
      clearTimeout(zoomRepos);
      zoomRepos = window.setTimeout(() => {
        cacheCell = 0;   // force la remise au net
        redessiner();
      }, 130);
    } else {
      // Seule la camera a bouge : on FAIT GLISSER l'image plutot que de la
      // refaire, et on ne repeint que les bandes que le glissement decouvre.
      // Refaire l'image entiere coutait 342 ms sur une partie de trois mille
      // coups -- une saccade nette tous les trois cents pixels de deplacement.
      // On ne fait glisser que lorsque la camera s'eloigne assez : recopier
      // l'image entiere coute 26 ms, la dessiner a l'ecran 6. Tant qu'on reste
      // dans la marge, la simple recopie a l'ecran suffit, et le glissement
      // n'arrive qu'une fois tous les SEUIL pixels parcourus.
      // Le decalage se compte en pixels D'ECRAN, pas en pixels de mise en page.
      //
      // C'est la cause du flou qui s'installait et ne partait plus. Sur un
      // ecran a 125 %, un pixel de mise en page en vaut 1,25 a l'ecran : glisser
      // d'un nombre ENTIER de pixels de mise en page tombait entre deux pixels
      // reels, le navigateur reechantillonnait, et comme l'image se recopie
      // dans elle-meme, le flou s'ajoutait a chaque glissement -- il ne partait
      // qu'a la reconstruction complete. Un nombre entier de pixels d'ecran ne
      // reechantillonne rien.
      const ddx = Math.round((ox - cacheOx) * dpr), ddy = Math.round((oy - cacheOy) * dpr);
      const dx = ddx / dpr, dy = ddy / dpr;
      // On glisse a mi-marge : au-dela, une bande decouverte depasserait ce que
      // l'image de cote contient.
      const SEUIL = cacheMarge * 0.45;
      if (Math.abs(dx) > SEUIL || Math.abs(dy) > SEUIL) {
        if (Math.abs(dx) >= cw || Math.abs(dy) >= ch) {
          g.clearRect(0, 0, cw, ch);
          peindreLot(g, ox + cacheMarge, oy + cacheMarge, 0, 0, cw, ch);
          cacheOx = ox; cacheOy = oy;
        } else {
          // Recopie a l'identite : un pixel d'ecran pour un pixel d'ecran.
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalCompositeOperation = "copy";
          g.drawImage(cache, 0, 0, cache.width, cache.height,
            ddx, ddy, cache.width, cache.height);
          g.globalCompositeOperation = "source-over";
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          cacheOx += dx; cacheOy += dy;
          const orgX = cacheOx + cacheMarge, orgY = cacheOy + cacheMarge;
          // La bande verticale decouverte, puis l'horizontale.
          if (dx > 0) peindreLot(g, orgX, orgY, 0, 0, dx, ch);
          else if (dx < 0) peindreLot(g, orgX, orgY, cw + dx, 0, -dx, ch);
          if (dy > 0) peindreLot(g, orgX, orgY, 0, 0, cw, dy);
          else if (dy < 0) peindreLot(g, orgX, orgY, 0, ch + dy, cw, -dy);
        }
      }
    }
    // Pose sur un pixel D'ECRAN entier, la encore : arrondir au pixel de mise
    // en page ne suffit pas quand l'ecran n'est pas a 100 %.
    const auPixel = (v: number) => Math.round(v * dpr) / dpr;
    if (cell === cacheCell) {
      ctx.drawImage(
        cache, 0, 0, cache.width, cache.height,
        auPixel(-cacheMarge + (ox - cacheOx)), auPixel(-cacheMarge + (oy - cacheOy)), cw, ch,
      );
    } else {
      // L'image a ete peinte a une autre echelle : on l'etire de sorte que la
      // case (0,0) retombe la ou la camera la place maintenant.
      const k = cell / cacheCell;
      ctx.drawImage(
        cache, 0, 0, cache.width, cache.height,
        ox - k * (cacheOx + cacheMarge), oy - k * (cacheOy + cacheMarge), cw * k, ch * k,
      );
    }
  }

  const blanks = blankPositions();
  for (const c of typedCells()) {
    const isBlank = blanks.has(`${c.x},${c.y}`);
    caramel(c.x, c.y, c.letter, isBlank, isBlank ? C.jface : C.face, isBlank ? C.jedge : C.cursor);
  }

  if (ghost !== null && !ghostCache && cell >= 6) {
    const [word, dir, gx, gy] = ghost;
    for (let i = 0; i < word.length; i++) {
      const x = dir === "H" ? gx + i : gx;
      const y = dir === "V" ? gy + i : gy;
      if (x < gx0 || x > gx1 || y < gy0 || y > gy1) continue;
      caramel(x, y, word[i]!, false, C.gface, C.gedge, C.gink);
    }
  }

  // Cases partagees dans le chat.
  for (const m of marks) {
    if (m.x < gx0 || m.x > gx1 || m.y < gy0 || m.y > gy1) continue;
    ctx.strokeStyle = C.mark; ctx.lineWidth = 2;
    ctx.strokeRect(eX(m.x) + 1, eY(m.y) + 1, eX(m.x + 1) - eX(m.x) - 2, eY(m.y + 1) - eY(m.y) - 2);
  }

  const nf = nextFree();
  if (cursor !== null && nf !== null) {
    const px = eX(nf.x), py = eY(nf.y);
    const w = eX(nf.x + 1) - px, h = eY(nf.y + 1) - py;
    ctx.strokeStyle = C.cursor; ctx.lineWidth = 1;
    ctx.strokeRect(px + 1.5, py + 1.5, w - 3, h - 3);
    ctx.fillStyle = C.cursor;
    ctx.beginPath();
    const m = w * .22;
    if (cursor.dir === "H") {
      ctx.moveTo(px + w - 3, py + h / 2);
      ctx.lineTo(px + w - 3 - m, py + h / 2 - m / 1.6);
      ctx.lineTo(px + w - 3 - m, py + h / 2 + m / 1.6);
    } else {
      ctx.moveTo(px + w / 2, py + h - 3);
      ctx.lineTo(px + w / 2 - m / 1.6, py + h - 3 - m);
      ctx.lineTo(px + w / 2 + m / 1.6, py + h - 3 - m);
    }
    ctx.closePath(); ctx.fill();
  }

  drawRulers(C, gx0, gx1, gy0, gy1);
}

/**
 * Regle graduee sur les deux bords, facon tableur. On lit la position d'un mot
 * sans compter les cases -- indispensable pour se reperer a l'oral ou dans le
 * chat, sur une grille qui n'a ni centre ni bord.
 */
function drawRulers(C: Record<string, string>, gx0: number, gx1: number, gy0: number, gy1: number) {
  const TOP = 17, LEFT = 30;
  ctx.fillStyle = C.panel!;
  ctx.fillRect(0, 0, W, TOP);
  ctx.fillRect(0, 0, LEFT, H);

  // Une seule case signalee : celle du DEPART du mot. Souligner toute son
  // etendue allumait toute une rangee de numeros -- et c'est bien la case de
  // depart que la notation nomme, « H ligne,colonne ».
  const depart = ghost !== null
    ? { x: ghost[2], y: ghost[3] }
    : cursor !== null ? { x: cursor.x, y: cursor.y } : null;
  const mark = depart === null ? null
    : { x0: depart.x, y0: depart.y, x1: depart.x, y1: depart.y };
  if (mark !== null) {
    ctx.fillStyle = C.abg!;
    const sx = ox + mark.x0 * cell, sw = (mark.x1 - mark.x0 + 1) * cell;
    const sy = oy + mark.y0 * cell, sh = (mark.y1 - mark.y0 + 1) * cell;
    if (sx + sw > LEFT) ctx.fillRect(Math.max(LEFT, sx), 0, Math.min(sw, W - Math.max(LEFT, sx)), TOP);
    if (sy + sh > TOP) ctx.fillRect(0, Math.max(TOP, sy), LEFT, Math.min(sh, H - Math.max(TOP, sy)));
  }

  ctx.strokeStyle = C.rule!;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, TOP + .5); ctx.lineTo(W, TOP + .5);
  ctx.moveTo(LEFT + .5, 0); ctx.lineTo(LEFT + .5, H);
  ctx.stroke();

  // Sur un plateau ferme, chaque ligne porte son repere : quinze suffisent.
  const bornes = cfg.bornes;
  // Sur la grille infinie, les coordonnees s'allongent en s'eloignant de
  // l'origine : « -1204 » prend le double de place que « 4 ». Espacer d'une
  // constante faisait donc empieter les nombres au dezoom. On mesure.
  const chiffres = String(Math.max(Math.abs(gx0), Math.abs(gx1), Math.abs(gy0), Math.abs(gy1))).length;
  const largeurTexte = chiffres * 6.2 + 12;
  const stepBy = bornes !== null ? 1 : Math.max(1, Math.ceil(largeurTexte / cell));
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let x = gx0; x <= gx1; x++) {
    const on = mark !== null && x >= mark.x0 && x <= mark.x1;
    if (!on && x % stepBy !== 0) continue;
    const px = ox + x * cell + cell / 2;
    if (px < LEFT + 9 || px > W - 4) continue;
    if (bornes !== null && (x < -bornes || x > bornes)) continue;
    ctx.fillStyle = on ? C.dark! : C.faint!;
    ctx.fillText(bornes === null ? String(x) : String(x + bornes + 1), px, TOP / 2);
  }
  for (let y = gy0; y <= gy1; y++) {
    const on = mark !== null && y >= mark.y0 && y <= mark.y1;
    if (!on && y % stepBy !== 0) continue;
    const py = oy + y * cell + cell / 2;
    if (py < TOP + 7 || py > H - 4) continue;
    if (bornes !== null && (y < -bornes || y > bornes)) continue;
    ctx.fillStyle = on ? C.dark! : C.faint!;
    ctx.fillText(
      // La ligne monte quand son numero grandit : voir `formatMove`.
      bornes === null ? String(-y) : String.fromCharCode(65 + y + bornes), LEFT / 2, py,
    );
  }
}

/**
 * Enregistre la grille entiere en image.
 *
 * On ne photographie pas l'ecran : on redessine la partie a une autre echelle,
 * dans un canevas hors ecran assez grand pour contenir TOUTE l'emprise des
 * caramels. C'est le meme `draw()` qui s'en charge, donc l'image montre
 * exactement ce que montre le jeu -- y compris le mot du rejeu masque par
 * l'oeil, ce qui donne une position a chercher.
 *
 * PNG plutot que JPEG : des lettres nettes sur un fond uni, c'est le cas ou le
 * PNG gagne sur tous les tableaux, poids compris.
 */
async function exporterImage(coup?: number): Promise<void> {
  const bouton = $("rb-image") as HTMLButtonElement;
  // Quel coup, et avec quelles lettres. Sans numero, c'est la position DU
  // MOMENT : celle du coup en cours, ou celle qu'examine le rejeu.
  const numero = coup ?? (rejeu !== null ? rejeu.n : moveNumber + 1);
  const m = history.find((q) => q.n === numero);
  const lettres = m !== undefined && coup !== undefined ? m.rack
    : rejeu !== null ? (m?.rack ?? "") : rack;
  // Ordre alphabetique, jokers a la fin : c'est ainsi qu'on lit son chevalet.
  // Le tirage en tete de l'image est ce qui permet de rejouer le coup.
  const tirage = [...lettres].sort((a, b) =>
    a === BLANK ? 1 : b === BLANK ? -1 : a < b ? -1 : a > b ? 1 : 0);
  const b = cfg.bornes;
  // L'emprise des caramels POSES A CE MOMENT-LA. Prendre celle de la partie
  // entiere montrerait une zone vide du cote ou elle a grandi ensuite.
  const jusque = coup === undefined ? Infinity : coup - 1;
  let ex0 = Infinity, ex1 = -Infinity, ey0 = Infinity, ey1 = -Infinity;
  for (const q of tiles) {
    if (q.n > jusque) continue;
    if (q.x < ex0) ex0 = q.x;
    if (q.x > ex1) ex1 = q.x;
    if (q.y < ey0) ey0 = q.y;
    if (q.y > ey1) ey1 = q.y;
  }
  const vide = ex0 === Infinity;

  // La marge fait la LONGUEUR D'UN MOT ENTIER, plus une case d'air.
  //
  // C'est ce qui rend l'image jouable : un coup peut partir de sept cases au-
  // dessus du dernier caramel pose et redescendre le toucher. Une marge de deux
  // cases coupait ces coups-la de l'image, et le top devenait introuvable pour
  // qui cherche dessus.
  const marge = cfg.jouables + 1;
  const x0 = b !== null ? -b - 1 : (vide ? -8 : ex0 - marge);
  const x1 = b !== null ? b + 1 : (vide ? 8 : ex1 + marge);
  const y0 = b !== null ? -b - 1 : (vide ? -8 : ey0 - marge);
  const y1 = b !== null ? b + 1 : (vide ? 8 : ey1 + marge);
  const cases = { l: x1 - x0 + 1, h: y1 - y0 + 1 };

  // Assez grand pour se lire, assez petit pour tenir en memoire. Un canevas de
  // six mille pixels de cote pese deja 144 Mo une fois developpe.
  const COTE_MAX = 6000, PIXELS_MAX = 36e6;
  let taille = Math.min(48, Math.floor(COTE_MAX / Math.max(cases.l, cases.h)));
  taille = Math.max(6, taille);
  while (cases.l * taille * cases.h * taille > PIXELS_MAX && taille > 6) taille--;

  const REGLE = { x: 30, y: 17 };
  // Le bandeau du tirage, quand il y en a un. Ses caramels sont plus grands que
  // ceux de la grille : c'est ce qu'on lit en premier.
  const tailleTirage = Math.max(28, Math.min(64, Math.round(cases.l * taille / 26)));
  const BANDEAU = tirage.length > 0 ? Math.round(tailleTirage * 1.9) : 0;
  const largeur = Math.round(cases.l * taille) + REGLE.x;
  const hauteur = Math.round(cases.h * taille) + REGLE.y + BANDEAU;

  const hors = document.createElement("canvas");
  hors.width = largeur; hors.height = hauteur;
  const g = hors.getContext("2d");
  if (g === null) return;

  // La grille se dessine sur SON canevas, que l'on pose ensuite sous le
  // bandeau. `draw()` place les numeros de colonnes tout en haut de ce qu'il
  // dessine : peindre le bandeau par-dessus les aurait recouverts, et c'est
  // justement ce qui permet de nommer la case ou l'on joue.
  const grille = document.createElement("canvas");
  grille.width = largeur; grille.height = hauteur - BANDEAU;
  const gg = grille.getContext("2d");
  if (gg === null) return;

  // On prete a `draw()` un autre canevas et un autre cadrage, puis on rend tout.
  const memoire = { ctx, W, H, ox, oy, cell, cle: cacheCle };
  bouton.disabled = true;
  try {
    ctx = gg; W = largeur; H = hauteur - BANDEAU; cell = taille;
    ox = REGLE.x - x0 * taille; oy = REGLE.y - y0 * taille;
    exportEnCours = true;
    exportJusqua = coup === undefined ? null : coup - 1;
    ctx.fillStyle = css("--field");
    ctx.fillRect(0, 0, W, H);
    draw();
  } finally {
    exportEnCours = false;
    exportJusqua = null;
    ctx = memoire.ctx; W = memoire.W; H = memoire.H;
    ox = memoire.ox; oy = memoire.oy; cell = memoire.cell;
    cacheCle = "";   // l'image de cote a servi a autre chose entre-temps
    bouton.disabled = false;
    draw();
  }

  if (tirage.length > 0) dessinerLeTirage(g, tirage, largeur, BANDEAU, tailleTirage, numero);
  g.drawImage(grille, 0, BANDEAU);

  const blob: Blob | null = await new Promise((res) => hors.toBlob(res, "image/png"));
  if (blob === null) { flash("l'image n'a pas pu être produite", "bad"); return; }
  const quand = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
  const quoi = `coup ${numero}`;
  const salonNom = ($("conn").textContent ?? "").split("·").pop()?.trim() || "grille";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${salonNom} — ${quoi} — ${quand}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  flash(`image enregistrée · ${largeur} × ${hauteur} px`, "ok");
}

/**
 * Le tirage en tete de l'image, en caramels, comme sur un chevalet.
 *
 * Le bandeau du jeu vit dans la page, pas sur le canevas : on le redessine ici,
 * sans quoi une image d'archive montrerait une grille sans les lettres avec
 * lesquelles il fallait chercher -- et ne servirait a rien.
 */
function dessinerLeTirage(
  g: CanvasRenderingContext2D, lettres: readonly string[],
  largeur: number, hauteur: number, taille: number, coup: number,
): void {
  g.save();
  g.fillStyle = css("--panel");
  g.fillRect(0, 0, largeur, hauteur);
  g.strokeStyle = css("--rule"); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, hauteur - .5); g.lineTo(largeur, hauteur - .5); g.stroke();

  const gap = Math.max(2, Math.round(taille * .09));
  const total = lettres.length * taille + (lettres.length - 1) * gap;
  let px = Math.round((largeur - total) / 2);
  const py = Math.round((hauteur - taille) / 2);
  const rad = Math.max(1.5, taille * .07);

  g.textAlign = "center"; g.textBaseline = "middle";
  for (const ch of lettres) {
    const joker = ch === BLANK;
    roundRectSur(g, px, py, taille, taille, rad);
    g.fillStyle = joker ? css("--joker-face") : css("--tile-face"); g.fill();
    g.lineWidth = Math.max(1, taille * .04);
    g.strokeStyle = joker ? css("--joker-edge") : css("--tile-edge"); g.stroke();
    g.fillStyle = joker ? css("--joker-edge") : css("--tile-ink");
    g.font = `700 ${Math.round(taille * .58)}px Archivo, system-ui, sans-serif`;
    g.fillText(joker ? "?" : ch, px + taille / 2, py + taille * .5);
    g.globalAlpha = .6;
    g.font = `500 ${Math.round(taille * .26)}px "IBM Plex Mono", monospace`;
    g.textAlign = "right";
    g.fillText(String(joker ? 0 : valueOf(ch)), px + taille * .9, py + taille * .84);
    g.textAlign = "center"; g.globalAlpha = 1;
    px += taille + gap;
  }

  // Le numero du coup, discret, a gauche : de quoi retrouver la position.
  g.fillStyle = css("--ink-faint");
  g.font = `500 ${Math.round(taille * .32)}px "IBM Plex Mono", monospace`;
  g.textAlign = "left"; g.textBaseline = "middle";
  g.fillText(`COUP ${coup}`, 14, hauteur / 2);
  g.restore();
}

/** Un rectangle arrondi sur un contexte quelconque. */
function roundRectSur(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

$("rb-image").addEventListener("click", () => { void exporterImage(); });

function extentOf(word: string, dir: Dir, x: number, y: number) {
  return { x0: x, y0: y, x1: dir === "H" ? x + word.length - 1 : x, y1: dir === "V" ? y + word.length - 1 : y };
}

// ------------------------------------------------------------- camera

function readableCell() { return Math.max(14, Math.min(36, Math.min(W, H) / 16)); }

/** L'emprise des caramels poses, recalculee quand leur nombre change. */
let emprise = { n: -1, x0: 0, x1: 0, y0: 0, y1: 0, vide: true };
function empriseDesCaramels() {
  if (emprise.n === tiles.length) return emprise;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of tiles) {
    if (q.x < x0) x0 = q.x;
    if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.y > y1) y1 = q.y;
  }
  emprise = { n: tiles.length, x0, x1, y0, y1, vide: tiles.length === 0 };
  return emprise;
}

/**
 * Jusqu'ou on peut s'eloigner.
 *
 * La limite n'est pas fixe : elle suit la partie. Une grille infinie grandit
 * sans fin, et un plancher en dur finissait par empecher d'embrasser du regard
 * ce qu'on avait construit -- or c'est precisement la vue qui donne son
 * caractere a une longue partie. On s'arrete quand toute l'emprise des
 * caramels tient a l'ecran, jamais plus tot.
 */
function cellMinimal(): number {
  const e = empriseDesCaramels();
  if (e.vide) return 12;
  // Deux cases de marge de chaque cote, et la place des regles : sans elles, la
  // derniere rangee tombait sous les numeros de colonnes. Le plancher descend
  // jusqu'a un pixel et demi -- au-dela un caramel n'occupe plus de surface,
  // mais jusque-la il en occupe une, et c'est ce qui fait l'image d'ensemble.
  const REGLES = 28;
  const largeur = e.x1 - e.x0 + 5, hauteur = e.y1 - e.y0 + 5;
  return Math.max(1.5, Math.min(12, Math.min((W - REGLES) / largeur, (H - REGLES) / hauteur)));
}

function alreadyVisible(word: string, dir: Dir, x: number, y: number) {
  if (cell < 11) return false;
  const e = extentOf(word, dir, x, y);
  const m = 1.5;
  return ox + (e.x0 - m) * cell >= 0 && ox + (e.x1 + 1 + m) * cell <= W
      && oy + (e.y0 - m) * cell >= 0 && oy + (e.y1 + 1 + m) * cell <= H;
}

let anim = 0;
function flyTo(word: string, dir: Dir, x: number, y: number) {
  const t = readableCell();
  const e = extentOf(word, dir, x, y);
  const to = { cell: t, ox: W / 2 - ((e.x0 + e.x1 + 1) / 2) * t, oy: H / 2 - ((e.y0 + e.y1 + 1) / 2) * t };
  if (anim) cancelAnimationFrame(anim);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cell = to.cell; ox = to.ox; oy = to.oy; draw(); return;
  }
  const from = { cell, ox, oy };
  const cx = (W / 2 - to.ox) / to.cell, cy = (H / 2 - to.oy) / to.cell;
  const nx = (W / 2 - from.ox) / from.cell, ny = (H / 2 - from.oy) / from.cell;
  const dist = Math.hypot(cx - nx, cy - ny);
  const far = dist > 30;
  const out = Math.max(4, Math.min(from.cell, to.cell) / Math.max(1, dist / 22));
  const dur = far ? 700 : 360;
  const t0 = performance.now();
  const ease = (p: number) => (p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const stepFn = (now: number) => {
    const p = Math.min(1, (now - t0) / dur), q = ease(p);
    const arc = far ? Math.sin(Math.PI * q) : 0;
    cell = from.cell + (to.cell - from.cell) * q - (Math.min(from.cell, to.cell) - out) * arc;
    const gx = nx + (cx - nx) * q, gy = ny + (cy - ny) * q;
    ox = W / 2 - gx * cell; oy = H / 2 - gy * cell;
    draw();
    anim = p < 1 ? requestAnimationFrame(stepFn) : 0;
  };
  anim = requestAnimationFrame(stepFn);
}

/** Ne bouge la camera QUE si la cible est hors champ : sinon on a le mal de mer. */
function reveal(word: string, dir: Dir, x: number, y: number) {
  // Sur un plateau ferme, tout est deja visible : il n'y a nulle part ou aller.
  if (cfg.bornes !== null) { draw(); return; }
  // Un vol DEJA EN COURS vise ailleurs. Le juger « deja visible » et le laisser
  // finir emportait la camera loin de ce qu'on venait de demander : en entrant
  // dans un salon, la vue part vers le dernier coup, et ouvrir le rejeu dans la
  // seconde qui suit laissait ce vol-la atterrir par-dessus. On refait donc le
  // trajet, ce qui annule l'autre au passage.
  if (anim !== 0 || !alreadyVisible(word, dir, x, y)) flyTo(word, dir, x, y);
  else draw();
}

// ---------------------------------------------------------------- panneaux

function remaining(): string[] {
  const left = [...rack];
  const blanks = blankPositions();
  for (const c of typedCells()) {
    const useBlank = blanks.has(`${c.x},${c.y}`);
    let i = useBlank ? left.indexOf(BLANK) : left.indexOf(c.letter);
    if (i === -1) i = left.indexOf(c.letter);
    if (i === -1) i = left.indexOf(BLANK);
    if (i !== -1) left.splice(i, 1);
  }
  return left;
}

/**
 * Les caramels du bandeau.
 *
 * Pendant le rejeu, c'est le tirage du coup EXAMINE qui s'affiche, pas celui de
 * la partie en cours : on revoit ce coup, on doit voir avec quoi on cherchait.
 */
function paintRack() {
  const ici = rejeu;
  if (ici !== null) {
    const m = history.find((q) => q.n === ici.n);
    peindreCaramels(m === undefined ? [] : [...m.rack]);
    return;
  }
  peindreCaramels(remaining());
}

function peindreCaramels(lettres: readonly string[]): void {
  const box = $("rb-tiles");
  box.replaceChildren();
  for (const ch of lettres) {
    const el = document.createElement("div");
    const joker = ch === BLANK;
    el.className = "caramel" + (joker ? " joker" : "");
    el.textContent = joker ? "?" : ch;
    if (!joker) {
      const v = valueOf(ch);
      if (v) { const s = document.createElement("i"); s.textContent = String(v); el.appendChild(s); }
    }
    box.appendChild(el);
  }
}

/**
 * Un temps ENREGISTRE : celui qu'a mis un joueur pour trouver un coup.
 *
 * Au centieme sous la minute. Ce n'est pas ce qu'on affiche pendant qu'on
 * joue -- un chrono qui defile au centieme est une source d'angoisse, pas
 * d'information -- mais une performance se note precisement.
 */
function fmtTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  // Un compte rond s'ecrit rond : « 5 s », pas « 5.00 s ». C'est le cas d'un
  // coup clos par l'echeance, qui a dure exactement le temps imparti.
  if (s < 60) return Number.isInteger(s) ? `${s} s` : `${s.toFixed(2)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} j ${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")} h`;
}

/**
 * La place du coup DU JOUEUR, quand elle differe de celle du top retenu.
 *
 * Le logiciel choisit un isotop canonique parmi les coups a score egal : celui
 * qu'un joueur a trouve n'est pas toujours celui qui est pose. Cliquer sur son
 * propre coup emmenait donc la camera ailleurs, sans rien qui l'explique. Un
 * demi-point est dans le meme cas : sa solution n'est pas sur la grille du tout.
 *
 * La cellule existe TOUJOURS, vide quand les deux places coincident : une
 * colonne qui apparait et disparait decalerait tout le reste de la ligne.
 */
function placeDuJoueur(
  ailleurs: boolean,
  sien: { word: string; dir: Dir; x: number; y: number } | undefined,
): string {
  if (!ailleurs || sien === undefined) return `<span class="place"></span>`;
  const ou = noteCoup(sien.dir, sien.x, sien.y, cfg.bornes);
  return `<button type="button" class="place" title="voir ${echapper(sien.word)} en ${ou}">${ou}</button>`;
}

/** Le mot en cours de frappe et son score, mis a jour a chaque lettre. */
function paintCurrent() {
  const w = $("cur-word"), meta = $("cur-meta"), bad = $("cur-bad");
  bad.hidden = true;

  if (cursor !== null && typed.length > 0) {
    const r = resolveTypedWord(board, dict, cursor.dir, cursor.x, cursor.y, typed, rack, false, true);
    if (r.ok) {
      w.className = "word";
      w.innerHTML = `<span>${r.move.word}</span><span class="pts">${r.move.score}</span>`;
      meta.textContent = noteCoup(r.move.dir, r.move.x, r.move.y, cfg.bornes);
      // Le score d'abord, toujours. Ce qui clocherait se dit a voix basse, en
      // dessous : « mot non valide » a la place du score, pendant qu'on tape,
      // cache la seule chose qu'on regardait.
      if (r.bad !== undefined && r.bad.length > 0) {
        bad.hidden = false;
        bad.textContent = r.bad.length > 1
          ? `collages faux : ${r.bad.join(", ")}` : `collage faux : ${r.bad[0]}`;
      }
      return;
    }
    w.className = "word";
    w.innerHTML = `<span>${r.word ?? typed}</span><span class="pts">—</span>`;
    meta.textContent = PLAY_MESSAGE[r.error];
    if (r.bad && r.bad.length > 0) {
      bad.hidden = false;
      bad.textContent = r.bad.length > 1 ? `collages faux : ${r.bad.join(", ")}` : `collage faux : ${r.bad[0]}`;
    }
    return;
  }

  if (best !== null) {
    w.className = "word";
    w.innerHTML = `<span>${best.word}</span><span class="pts">${best.score}</span>`;
    meta.textContent = `${noteCoup(best.dir, best.x, best.y, cfg.bornes)} · votre meilleure solution`;
    return;
  }
  w.className = "word none";
  w.textContent = "—";
  meta.textContent = "";
}

function paintSide() {
  // Le numero du coup suivant s'affiche MEME pendant le calcul : le faire
  // disparaitre le temps d'un solveur lent donne l'impression d'un jeu casse.
  $("rb-move").textContent = rejeu !== null ? String(rejeu.n)
    : !demarree || finie ? "—"
    : coupsMax === null ? String(moveNumber + 1)
    : `${moveNumber + 1} / ${coupsMax}`;
  if (rejeu !== null) paintRack();
  // Une partie bornee dans le TEMPS montre ce qu'il lui reste a vivre.
  $("rb-reste-wrap").hidden = rejeu !== null || dureeMax === null || !demarree || finie;
  $("fin").hidden = !finie;

  // Rejouer n'a de sens qu'une fois la partie close : avant, ce serait donner
  // les reponses d'une partie en cours.
  $("rejeu-wrap").hidden = !finie || history.length === 0;
  $("rb-cumul").textContent = cumul.toLocaleString("fr");
  // Au duplicate, chacun a son propre total : on le montre a cote du cumul de
  // la grille, pour qu'il se compare d'un coup d'oeil.
  $("rb-score-wrap").hidden = !duplicate;
  if (duplicate) $("rb-score").textContent = String(points[me] ?? 0);
  paintCurrent();

  const lw = $("last-word"), lm = $("last-meta"), ll = $("last-like");
  ll.replaceChildren();
  if (last === null) { lw.className = "word none"; lw.textContent = "—"; lm.textContent = ""; }
  else {
    lw.className = "word";
    lw.innerHTML = `<span>${last.word}</span><span class="pts">${last.score}</span>`;
    // Au duplicate, mon ecart au top sur CE coup. Il reste affiche tant que le
     // coup suivant ne l'a pas remplace : c'est le temps qu'on a de le lire.
    const mien = duplicate ? last.scores?.[me] : undefined;
    const ecart = mien === undefined ? 0 : mien - last.score;
    lm.textContent = `${noteCoup(last.dir, last.x, last.y, cfg.bornes)} · ${quiLaTrouve(last, true)}` +
      (duplicate ? (ecart < 0 ? ` · ${ecart}` : "") : ` · ${fmtTime(last.ms)}`);
    ll.appendChild(likeButton(last));
  }

  const rank = $("rank");
  rank.replaceChildren();
  const rows = duplicate
    ? Object.keys({ ...players, ...points }).map((k) => [k, points[k] ?? 0] as [string, number])
        .sort((a, b) => b[1] - a[1])
    : Object.entries(players).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    const s = document.createElement("div");
    s.className = "none"; s.textContent = "personne encore";
    rank.appendChild(s);
  }
  // Ce que personne n'a trouve merite sa ligne : sinon les coups perdus par
  // tout le monde disparaissent du tableau sans laisser de trace.
  if (!duplicate && nonTrouves > 0) {
    const perdu = document.createElement("div");
    perdu.className = "prow perdu";
    perdu.innerHTML = `<span class="tri"></span>` +
      `<span class="nom">Non trouvé${nonTrouves > 1 ? "s" : ""}</span>` +
      `<span class="likes"></span><span class="num">${nonTrouves}</span>`;
    rank.appendChild(perdu);
  }

  for (const [name, n] of rows) {
    const row = document.createElement("button");
    row.className = "prow" + (name === me ? " me" : "");
    const got = likes[name] ?? 0;
    // La case des « j'aime » est TOUJOURS presente, vide quand il n'y en a pas :
    // une colonne qui apparait et disparait decale tout le reste de la ligne.
    // Au duplicate on lit des points et un negatif ; un negatif nul, c'est TOP.
    const neg = negatif[name] ?? 0;
    // Les coeurs contre le pseudo : a l'autre bout de la ligne, ils se lisaient
    // comme un second nombre de points.
    const coeurs = got > 0 ? `<b class="coeurs">♥ ${got}</b>` : "";
    const droite = duplicate
      ? `<span class="likes">${neg === 0 ? "TOP" : "−" + neg}</span>` +
        `<span class="num">${points[name] ?? 0}</span>`
      : `<span class="likes"></span>` +
        `<span class="num">${Number.isInteger(n) ? n : n.toFixed(1)}</span>`;
    row.innerHTML = `<span class="tri">${openPlayer === name ? "▾" : "▸"}</span>` +
                    `<span class="nom">${name}${coeurs}</span>` + droite;
    row.addEventListener("click", () => { openPlayer = openPlayer === name ? null : name; paintSide(); });
    rank.appendChild(row);

    if (openPlayer === name) {
      const list = document.createElement("div");
      list.className = "plist";
      // Au duplicate, chacun marque sur TOUS les coups auxquels il a participe,
      // pas seulement sur ceux qu'il a remportes.
      const mine = (duplicate
        ? history.filter((m) => m.scores?.[name] !== undefined)
        : history.filter((m) => m.player === name || m.demiPoint?.joueur === name)
      ).reverse();
      if (mine.length === 0) {
        const e = document.createElement("div");
        e.className = "none"; e.textContent = "aucun coup enregistré";
        list.appendChild(e);
      }
      for (const m of mine) {
        const r = document.createElement("div");
        r.className = "pmove";
        r.tabIndex = 0;
        // Ou le joueur a pose SON mot. Le logiciel retient un isotop canonique
        // qui n'est pas toujours celui qu'on a joue : sans cette place-la, on
        // clique sur son propre coup et la camera part ailleurs.
        const sien = m.propositions?.[name]
          ?? (m.playerWord !== undefined && m.playerDir !== undefined
              && m.playerX !== undefined && m.playerY !== undefined
              ? { word: m.playerWord, dir: m.playerDir, x: m.playerX, y: m.playerY, score: 0 }
              : undefined);
        const ailleurs = sien !== undefined
          && (sien.dir !== m.dir || sien.x !== m.x || sien.y !== m.y);
        // Ce que le JOUEUR a tape, qui peut differer du mot retenu par le logiciel.
        if (duplicate) {
          // Son score du coup, et son ecart au top. Zero d'ecart, c'est le top.
          const sc = m.scores![name]!;
          const ecart = m.score - sc;
          // Le mot QU'IL a joue -- pas le top, qu'il n'a peut-etre pas trouve.
          const mot = m.propositions?.[name]?.word ?? (sc === 0 ? "—" : m.word);
          r.innerHTML = `<span class="n">${m.n}</span><span class="w">${mot}</span>` +
                        placeDuJoueur(ailleurs, sien) +
                        `<span class="s">${sc}</span>` +
                        `<span class="t ${ecart === 0 ? "top" : ""}">${ecart === 0 ? "Top" : `−${ecart}`}</span>`;
          r.title = `Coup ${m.n} : ${mot} pour ${sc} pts. ` +
            `Le top ${m.word} valait ${m.score} pts` +
            (ecart === 0 ? " — trouvé." : `, manqué de ${ecart} pts.`);
        } else {
          // Un demi-point porte le mot que le joueur a reellement propose, suivi
          // de « (0.5) » : c'etait sa meilleure solution, pas le top.
          const demi = m.player === null && m.demiPoint?.joueur === name;
          const shown = demi ? `${m.demiPoint!.word} (0.5)` : (m.playerWord ?? m.word);
          r.innerHTML = `<span class="n">${m.n}</span><span class="w">${shown}</span>` +
                        placeDuJoueur(ailleurs, sien) +
                        `<span class="s">${demi ? m.demiPoint!.score : m.score}</span>` +
                        `<span class="t">${fmtTime(m.ms)}</span>`;
        }
        if (!duplicate) {
          const demi2 = m.player === null && m.demiPoint?.joueur === name;
          const vu = demi2 ? m.demiPoint!.word : (m.playerWord ?? m.word);
          r.title = m.playerWord && m.playerWord !== m.word
            ? `${vu} — le logiciel a retenu ${m.word}` : vu;
        }
        r.addEventListener("click", () => focusMove(m));
        // La place du joueur mene a SON coup, pas a celui du logiciel.
        if (ailleurs && sien !== undefined) {
          const b = r.querySelector(".place") as HTMLElement | null;
          b?.addEventListener("click", (e) => {
            e.stopPropagation();
            ghost = [sien.word, sien.dir, sien.x, sien.y];
            reveal(sien.word, sien.dir, sien.x, sien.y);
          });
        }
        r.appendChild(likeButton(m));
        list.appendChild(r);
      }
      rank.appendChild(list);
    }
  }

  $("online").textContent = online.length > 0 ? online.join(", ") : "—";
  $("reveal-wrap").hidden = !canReveal;
  ($("reveal") as HTMLButtonElement).disabled = solving;
}

// ---------------------------------------------------------------- coups passes

/**
 * Amene la camera sur un coup et le met en evidence. Rien de plus.
 *
 * Les isotops et les sous-tops NE SONT PAS montres : ils restent dans le
 * fichier de partie, en reserve, pour l'analyse d'apres-partie. Le serveur ne
 * les envoie meme pas.
 */
function focusMove(m: MoveInfo) {
  ghost = [m.word, m.dir, m.x, m.y];
  $("roadmap").hidden = true;
  reveal(m.word, m.dir, m.x, m.y);
}

/**
 * Le bouton "j'aime". Le like va au joueur qui a trouve le top ; on ne s'aime
 * pas soi-meme, et un coup revele sans vainqueur n'a personne a feliciter.
 */
function likeButton(m: MoveInfo): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "like";
  b.type = "button";
  const mine = (m.likers ?? []).includes(me);
  b.setAttribute("aria-pressed", String(mine));
  b.title = m.player === null ? "coup révélé, personne à féliciter"
    : m.player === me ? "votre coup" : `bravo à ${m.player}`;
  b.disabled = m.player === null || m.player === me;
  b.innerHTML = `<span aria-hidden="true">${mine ? "♥" : "♡"}</span>` +
                `<span class="n">${m.likes ?? 0}</span>`;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    envoyer({ t: "like", n: m.n });
  });
  return b;
}

$("last-word").addEventListener("click", () => {
  if (last !== null) focusMove(last);
});

// ---------------------------------------------------------------- rejeu

/** Ouvre le rejeu sur un coup donne et demande ses paliers au serveur. */
function voirLeCoup(n: number): void {
  if (history.length === 0) return;
  const borne = Math.max(1, Math.min(history.length, n));
  rejeu = { n: borne, paliers: null };
  const m = history.find((q) => q.n === borne);
  $("panel-live").hidden = true;
  $("panel-rejeu").hidden = false;
  // Le journal des coups joues n'a pas sa place ici : il montre l'etat FINAL
  // de la partie, si bien qu'y cliquer depuis le coup 1 posait un mot du coup
  // 40 au milieu de nulle part. Le chat se replie sans disparaitre.
  document.querySelector(".side")!.classList.add("rejeu");
  $("journal-bloc").hidden = true;
  $("rj-titre").textContent = `Coup ${borne}`;
  for (const [id, off] of [["rj-debut", borne <= 1], ["rj-avant", borne <= 1],
                           ["rj-apres", borne >= history.length], ["rj-fin", borne >= history.length]] as const) {
    ($(id) as HTMLButtonElement).disabled = off;
  }
  ($("rj-q") as HTMLInputElement).value = "";
  $("rj-compte").textContent = "";
  peindreLOeil();
  $("rj-top").innerHTML = m === undefined ? "" :
    `<b>${m.word}</b> ${noteCoup(m.dir, m.x, m.y, cfg.bornes)} ` +
    `<span class="pts">${m.score} pts</span><br>` +
    `<span class="g">${m.notation ?? m.rack ?? ""}</span>`;
  const piste = $("rj-piste");
  piste.style.height = "";
  piste.replaceChildren();
  const attente = document.createElement("div");
  attente.className = "none";
  attente.style.padding = "10px 15px";
  attente.textContent = "chargement des solutions…";
  piste.appendChild(attente);
  $("rj-sols").scrollTop = 0;
  $("rj-qui").hidden = true;
  ghost = m ? [m.word, m.dir, m.x, m.y] : null;
  // Le bandeau reprend le tirage de CE coup : on revoit le coup avec ce qu'on
  // avait en main pour le chercher.
  paintSide();
  envoyer({ t: "tiers", n: borne });
  draw();
}

/**
 * Tous ceux qui comptaient sur ce coup, propositions ou non.
 *
 * En duplicate, `scores` porte une entree par PARTICIPANT, y compris ceux qui
 * n'ont rien rendu -- ils y valent zero. Se contenter des propositions faisait
 * disparaitre du tableau ceux qui n'avaient pas trouve, c'est-a-dire justement
 * ceux qu'on cherche quand on revoit un coup.
 */
function participantsDuCoup(m: MoveInfo): string[] {
  const noms = new Set(Object.keys(m.propositions ?? {}));
  for (const nom of Object.keys(m.scores ?? {})) noms.add(nom);
  return [...noms].sort();
}

/**
 * Qui a trouve le top de ce coup.
 *
 * En topping, c'est celui qui l'a pose. En duplicate, personne ne le pose -- le
 * coup se clot a l'echeance -- et les trouveurs sont une liste, qui peut etre
 * vide. Lire `player` en duplicate donnait « non trouve » a toutes les lignes.
 */
function trouveursDuCoup(m: MoveInfo): string[] {
  // A defaut de la liste -- une partie servie par un serveur qui ne l'envoyait
  // pas encore -- on la retrouve dans les scores : trouver le top, c'est
  // marquer exactement le score du top.
  return m.trouveurs
    ?? Object.entries(m.scores ?? {}).filter(([, s]) => s === m.score).map(([n]) => n).sort();
}

/**
 * Qui a trouve le top de ce coup, en une ligne qui tient dans sa colonne.
 *
 * Au-dela de deux noms, on compte au lieu d'enumerer : six pseudos bout a bout
 * debordaient sur la colonne suivante, et une ligne qui se chevauche ne se lit
 * plus du tout -- alors que le nombre, lui, se lit d'un coup d'oeil. La liste
 * complete reste dans l'infobulle.
 */
function quiLaTrouve(m: MoveInfo, complet = false): string {
  if (duplicate) {
    const t = trouveursDuCoup(m);
    if (t.length === 0) return "non trouvé";
    if (complet || t.length <= 2) return t.join(", ");
    return `${t.length} joueurs`;
  }
  return m.player ?? (m.demiPoint ? `${m.demiPoint.joueur} (0.5)` : "non trouvé");
}

/** Qui a joue ce mot, a cet endroit, sur ce coup. */
function joueursDuMot(m: MoveInfo, word: string, dir: Dir, x: number, y: number): string[] {
  const out: string[] = [];
  for (const [nom, p] of Object.entries(m.propositions ?? {})) {
    if (p.word === word && p.dir === dir && p.x === x && p.y === y) out.push(nom);
  }
  return out.sort();
}

/** Le tableau du bas : ce que chacun a propose sur ce coup. */
function montrerQui(m: MoveInfo, titre: string, noms: string[]): void {
  const box = $("rj-qui");
  box.replaceChildren();
  if (noms.length === 0) { box.hidden = true; return; }
  if (titre !== "") {
    const h = document.createElement("h4");
    h.textContent = titre;
    box.appendChild(h);
  }
  for (const nom of noms) {
    const p = m.propositions?.[nom];
    const r = document.createElement("button");
    r.type = "button";
    r.className = "qrow";
    r.innerHTML = `<span class="qui">${nom}</span>` +
      `<span class="p">${p ? p.word : "—"}</span>` +
      `<span class="s">${p ? p.score : 0}</span>`;
    if (p !== undefined) {
      r.addEventListener("click", () => {
        ghost = [p.word, p.dir, p.x, p.y];
        reveal(p.word, p.dir, p.x, p.y);
      });
    }
    box.appendChild(r);
  }
  box.hidden = false;
}

/** Une solution du coup examine, prete a l'affichage. */
interface Solution {
  word: string; dir: Dir; x: number; y: number; score: number;
  /** Ecart au top : 0 pour le top lui-meme, negatif pour tous les autres. */
  ecart: number;
  /** Coup joue par quelqu'un mais absent des paliers enregistres. */
  hors: boolean;
  noms: string[];
}

/** Toutes les solutions du coup examine, dans l'ordre des paliers. */
let solutions: Solution[] = [];
/** Celles que le filtre laisse passer, dans le meme ordre. */
let solutionsVues: Solution[] = [];
/** Index dans `solutionsVues` de la ligne selectionnee, -1 si aucune. */
let choisie = -1;

const echapper = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Affiche les paliers recus : le top et ses isotops, puis les sous-tops. */
function montrerPaliers(n: number, paliers: Palier[] | null, refus?: string): void {
  if (rejeu === null || rejeu.n !== n) return;
  rejeu.paliers = paliers;
  const joue = history.find((q) => q.n === n);
  solutions = [];
  solutionsVues = [];
  choisie = -1;

  if (paliers === null || paliers.length === 0) {
    const piste = $("rj-piste");
    piste.style.height = "";
    piste.replaceChildren();
    const e = document.createElement("div");
    e.className = "none";
    e.style.padding = "10px 15px";
    e.textContent = refus ?? "solutions non enregistrées pour ce coup";
    piste.appendChild(e);
    $("rj-compte").textContent = "";
    return;
  }

  // Qui a joue quoi, indexe UNE fois : la liste peut compter des milliers de
  // lignes, et refouiller les propositions a chacune serait quadratique.
  const parCase = new Map<string, string[]>();
  for (const [nom, p] of Object.entries(joue?.propositions ?? {})) {
    const cle = `${p.word}|${p.dir}|${p.x}|${p.y}`;
    const l = parCase.get(cle);
    if (l === undefined) parCase.set(cle, [nom]); else l.push(nom);
  }
  for (const l of parCase.values()) l.sort();

  const meilleur = paliers[0]!.score;
  const vus = new Set<string>();
  for (const p of paliers) {
    for (const [word, dir, x, y] of p.moves) {
      const cle = `${word}|${dir}|${x}|${y}`;
      vus.add(cle);
      solutions.push({
        word, dir, x, y, score: p.score, ecart: p.score - meilleur,
        hors: false, noms: parCase.get(cle) ?? [],
      });
    }
  }

  // Un mot joue qui ne figure dans AUCUN palier -- au-dela du plafond que
  // gardent les grilles infinies -- reste consultable : c'est le coup de
  // quelqu'un.
  if (joue !== undefined) {
    for (const [, p] of Object.entries(joue.propositions ?? {})) {
      const cle = `${p.word}|${p.dir}|${p.x}|${p.y}`;
      if (vus.has(cle)) continue;
      vus.add(cle);
      solutions.push({
        word: p.word, dir: p.dir, x: p.x, y: p.y, score: p.score,
        ecart: p.score - meilleur, hors: true, noms: parCase.get(cle) ?? [],
      });
    }
    // Et par defaut, le tableau montre ce que TOUT le monde a joue.
    montrerQui(joue, "", participantsDuCoup(joue));
  }

  peindreSolutions();

  // On ouvre sur le coup qui a effectivement ete joue.
  if (joue !== undefined) {
    const i = solutionsVues.findIndex((s) => s.word === joue.word && s.dir === joue.dir
                                          && s.x === joue.x && s.y === joue.y);
    if (i >= 0) { choisie = i; marquerLaChoisie(true, false); }
  }
}

/**
 * Hauteur d'une ligne de solution, fixee en dur dans la feuille de style.
 *
 * Elle doit etre CONNUE a l'avance : c'est elle qui permet de savoir quelles
 * lignes tombent dans la fenetre visible sans avoir a les poser toutes.
 */
const H_SOL = 26;

/** Marge de lignes peintes hors champ, pour que le defilement ne clignote pas. */
const MARGE_SOL = 12;

/**
 * Peint la liste, filtree par le champ de recherche.
 *
 * Seules les lignes VISIBLES sont posees. Sur un plateau borne, le serveur
 * garde maintenant toutes les solutions du coup : une position ouverte en
 * compte 18 655 au pire, et les poser toutes demandait 2,4 secondes de mise en
 * page -- l'essentiel pour des lignes que personne ne regarde. Ici on en pose
 * une quarantaine, quel que soit le total, et la piste porte la hauteur
 * complete pour que la barre de defilement dise la verite.
 */
function peindreSolutions(): void {
  const q = ($("rj-q") as HTMLInputElement).value.trim().toUpperCase();
  solutionsVues = q === "" ? solutions : solutions.filter((s) => s.word.includes(q));

  const box = $("rj-sols");
  const piste = $("rj-piste");
  box.scrollTop = 0;
  if (solutionsVues.length === 0) {
    piste.style.height = "";
    piste.innerHTML = `<div class="none" style="padding:10px 15px">aucun mot ne contient « ${echapper(q)} »</div>`;
  } else {
    piste.style.height = `${solutionsVues.length * H_SOL}px`;
    peindreLaFenetre();
  }

  const total = solutions.length;
  $("rj-compte").textContent = q === ""
    ? `${total} solution${total > 1 ? "s" : ""}`
    : `${solutionsVues.length} sur ${total}`;
}

/** Pose les lignes qui tombent dans la partie visible de la liste. */
function peindreLaFenetre(): void {
  if (solutionsVues.length === 0) return;
  const box = $("rj-sols");
  const debut = Math.max(0, Math.floor(box.scrollTop / H_SOL) - MARGE_SOL);
  const fin = Math.min(solutionsVues.length,
    Math.ceil((box.scrollTop + box.clientHeight) / H_SOL) + MARGE_SOL);

  let html = "";
  for (let i = debut; i < fin; i++) {
    const s = solutionsVues[i]!;
    html +=
      `<button type="button" class="sol${s.ecart === 0 ? " best" : ""}${s.hors ? " hors" : ""}"` +
      `${i === choisie ? ' aria-current="true"' : ""} data-i="${i}" style="top:${i * H_SOL}px"` +
      `${s.noms.length > 0 ? ` title="joué par ${echapper(s.noms.join(", "))}"` : ""}>` +
      `<span class="w">${echapper(s.word)}</span>` +
      `<span class="p">${noteCoup(s.dir, s.x, s.y, cfg.bornes)}</span>` +
      `<span class="s">${s.score}</span>` +
      `<span class="d">${s.ecart === 0 ? "top" : s.ecart}</span>` +
      `<span class="n">${s.noms.length > 0 ? s.noms.length : ""}</span>` +
      `</button>`;
  }
  $("rj-piste").innerHTML = html;
}

$("rj-sols").addEventListener("scroll", () => {
  if (solutionsVues.length > 0) peindreLaFenetre();
});

/**
 * Souligne la ligne choisie, la pose sur la grille, et la fait defiler.
 *
 * `choisiParLeJoueur` distingue le clic ou la fleche du soulignement fait a
 * l'ouverture. A l'ouverture, le tableau du bas doit montrer TOUS ceux qui
 * comptaient sur ce coup ; le reduire aux trouveurs du top faisait disparaitre
 * ceux qui ne l'avaient pas trouve -- justement ceux qu'on vient regarder.
 */
function marquerLaChoisie(deroule = false, choisiParLeJoueur = true): void {
  const s = solutionsVues[choisie];
  if (s === undefined) return;
  const box = $("rj-sols");
  if (deroule) {
    // Ramener la ligne dans le champ, sans bouger si elle y est deja.
    const haut = choisie * H_SOL;
    if (haut < box.scrollTop) box.scrollTop = haut;
    else if (haut + H_SOL > box.scrollTop + box.clientHeight) {
      box.scrollTop = haut + H_SOL - box.clientHeight;
    }
  }
  peindreLaFenetre();
  ghost = [s.word, s.dir, s.x, s.y];
  reveal(s.word, s.dir, s.x, s.y);
  const ici = rejeu;
  const joue = ici === null ? undefined : history.find((h) => h.n === ici.n);
  if (joue === undefined || !choisiParLeJoueur) return;
  // Une ligne choisie a la main montre QUI a joue ce mot-la. Une ligne que
  // personne n'a jouee rend la main a la liste complete, plutot que de laisser
  // en place le tableau du mot precedent.
  if (s.noms.length > 0) {
    montrerQui(joue, `${s.word} — ${s.noms.length} joueur${s.noms.length > 1 ? "s" : ""}`, s.noms);
  } else {
    montrerQui(joue, "", participantsDuCoup(joue));
  }
}

/** Les fleches haut et bas parcourent la liste des solutions. */
function deplacerDansLaListe(pas: number): void {
  if (solutionsVues.length === 0) return;
  choisie = choisie < 0
    ? (pas > 0 ? 0 : solutionsVues.length - 1)
    : Math.max(0, Math.min(solutionsVues.length - 1, choisie + pas));
  marquerLaChoisie(true);
}

$("rj-sols").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest(".sol") as HTMLElement | null;
  if (b === null) return;
  choisie = Number(b.dataset["i"]);
  marquerLaChoisie();
});

($("rj-q") as HTMLInputElement).addEventListener("input", () => {
  choisie = -1;
  peindreSolutions();
});

/** L'oeil : ouvert, le mot se voit ; barre, il est retire de la grille. */
function peindreLOeil(): void {
  const b = $("rj-oeil");
  b.setAttribute("aria-pressed", String(ghostCache));
  b.title = ghostCache ? "montrer le mot sur la grille" : "masquer le mot sur la grille";
}

$("rj-oeil").addEventListener("click", () => {
  ghostCache = !ghostCache;
  peindreLOeil();
  draw();
});

function fermerLeRejeu(): void {
  rejeu = null;
  ghost = null;
  ghostCache = false;
  solutions = [];
  solutionsVues = [];
  choisie = -1;
  ($("rj-q") as HTMLInputElement).value = "";
  $("panel-rejeu").hidden = true;
  $("panel-live").hidden = false;
  // Le journal et le chat pleine hauteur reviennent : ils sont du direct.
  document.querySelector(".side")!.classList.remove("rejeu");
  paintJournal();
  paintSide();
  draw();
}

$("rejeu-open").addEventListener("click", () => voirLeCoup(1));
$("rj-close").addEventListener("click", fermerLeRejeu);
$("rj-avant").addEventListener("click", () => { if (rejeu) voirLeCoup(rejeu.n - 1); });
$("rj-apres").addEventListener("click", () => { if (rejeu) voirLeCoup(rejeu.n + 1); });
$("rj-debut").addEventListener("click", () => voirLeCoup(1));
$("rj-fin").addEventListener("click", () => voirLeCoup(history.length));

// ---------------------------------------------------------------- feuille de route

/**
 * Le resume de la partie, en une ligne au-dessus du tableau.
 *
 * C'est ce qu'on regarde en premier, et il fallait jusqu'ici le reconstituer
 * soi-meme en parcourant les lignes. Pas de classement ici : la feuille de
 * route sert a jeter un coup d'oeil a la partie, le classement a sa place.
 */
function enTeteDeLaRoute(): string {
  const n = history.length;
  if (n === 0) return "";
  let points = 0, trouves = 0, temps = 0;
  for (const m of history) {
    points += m.score;
    temps += Math.max(0, m.ms);
    if (quiLaTrouve(m) !== "non trouvé") trouves++;
  }
  const perdus = n - trouves;
  const bouts = [
    `<b>${n}</b> coup${n > 1 ? "s" : ""}`,
    `<b>${points.toLocaleString("fr")}</b> points`,
    `<b>${trouves}</b> trouvé${trouves > 1 ? "s" : ""}, <b>${perdus}</b> non trouvé${perdus > 1 ? "s" : ""}`,
  ];
  // Le cumul du temps ne vaut qu'en topping : ailleurs, c'est le chrono
  // multiplie par le nombre de coups, ce que personne n'a besoin de lire.
  if (!duplicate) bouts.push(`<b>${fmtTime(temps)}</b> en tout`);
  return bouts.join(" · ");
}

/**
 * La feuille de route : la partie entiere, un coup par ligne.
 *
 * L'ordre suit la grille. Un plateau borne se lit du premier coup au dernier,
 * comme une feuille de match : la partie a une fin, on la parcourt. Une grille
 * infinie se lit a l'envers, du plus recent au plus ancien : elle n'a pas de
 * fin, et ce qu'on vient de jouer est ce qui interesse.
 */
function paintRoadmap() {
  const body = $("rm-body");
  body.replaceChildren();
  // Le duplicate n'a pas les memes colonnes : pas de temps -- le coup dure
  // toujours le chrono entier -- mais l'ecart au top et le nombre de trouveurs.
  body.classList.toggle("duplicate", duplicate);
  $("rm-tete").innerHTML = enTeteDeLaRoute();
  if (history.length === 0) {
    const e = document.createElement("div");
    e.className = "none"; e.style.padding = "14px 18px"; e.textContent = "aucun coup joué";
    body.appendChild(e);
    return;
  }
  // Le cumul se compte dans l'ordre de la partie, quel que soit celui de
  // l'affichage : c'est le temps ecoule depuis le premier coup.
  cumulRoute.clear();
  let somme = 0;
  for (const m of history) { somme += Math.max(0, m.ms); cumulRoute.set(m.n, somme); }

  body.innerHTML = `<div class="rm-piste" id="rm-piste"></div>`;
  filtrerLaRoute();
  body.scrollTop = 0;
  peindreLaRouteVisible();
}

/** Les coups montres, dans l'ordre d'affichage et passes au filtre. */
let routeVues: MoveInfo[] = [];

/**
 * Le filtre de la feuille de route.
 *
 * Il remplace le Ctrl+F du navigateur, qui ne trouvait plus rien depuis que la
 * feuille ne pose que ses lignes visibles -- mais il cherche mieux : dans les
 * 5 400 coups de la partie, pas seulement dans les vingt affiches, et sur le
 * mot comme sur le tirage, la place ou le numero du coup.
 */
function filtrerLaRoute(): void {
  const champ = document.getElementById("rm-q") as HTMLInputElement | null;
  const q = (champ?.value ?? "").trim().toUpperCase();
  // Un plateau borne se lit du premier coup au dernier, une grille infinie a
  // l'envers.
  const base = cfg.bornes !== null ? history : [...history].reverse();
  routeVues = q === "" ? base : base.filter((m) =>
    m.word.includes(q)
    || m.notation.toUpperCase().includes(q)
    || noteCoup(m.dir, m.x, m.y, cfg.bornes).toUpperCase().includes(q)
    || quiLaTrouve(m, true).toUpperCase().includes(q)
    || String(m.n) === q);
  const piste = document.getElementById("rm-piste");
  if (piste !== null) piste.style.height = `${routeVues.length * H_RMROW}px`;
  const compte = document.getElementById("rm-compte");
  if (compte !== null) {
    compte.textContent = q === "" ? "" : `${routeVues.length} sur ${history.length}`;
  }
}

/**
 * Pose les lignes de la feuille de route qui tombent dans la partie visible.
 *
 * Comme le journal et la liste des solutions : une partie de 4 500 coups en a
 * 4 500, et le tableau en montre vingt.
 */
function peindreLaRouteVisible(): void {
  const body = $("rm-body");
  const n = routeVues.length;
  const piste = document.getElementById("rm-piste");
  if (piste === null) return;
  if (n === 0) { piste.innerHTML = ""; return; }
  const haut = Math.max(0, Math.floor(body.scrollTop / H_RMROW) - 5);
  const bas = Math.min(n, Math.ceil((body.scrollTop + body.clientHeight) / H_RMROW) + 5);
  let html = "";
  for (let i = haut; i < bas; i++) {
    const m = routeVues[i];
    if (m !== undefined) html += ligneDeRoute(m, i * H_RMROW);
  }
  piste.innerHTML = html;
}

$("rm-body").addEventListener("scroll", peindreLaRouteVisible);

$("rm-body").addEventListener("click", (e) => {
  const cible = e.target as HTMLElement;
  const image = cible.closest("[data-image]") as HTMLElement | null;
  if (image !== null) { void exporterImage(Number(image.dataset["image"])); return; }
  const revoir = cible.closest("[data-revoir]") as HTMLElement | null;
  if (revoir !== null) {
    $("roadmap").hidden = true;
    voirLeCoup(Number(revoir.dataset["revoir"]));
    return;
  }
  const aime = cible.closest("[data-aime]") as HTMLElement | null;
  if (aime !== null) { envoyer({ t: "like", n: Number(aime.dataset["aime"]) }); return; }
  const ligne = cible.closest("[data-coup]") as HTMLElement | null;
  if (ligne === null) return;
  const m = history.find((q) => q.n === Number(ligne.dataset["coup"]));
  if (m !== undefined) focusMove(m);
});

/** Temps ecoule au terme de chaque coup, pour la colonne de cumul. */
const cumulRoute = new Map<number, number>();

/**
 * Ajoute le coup qui vient d'etre joue a la feuille de route DEJA OUVERTE.
 *
 * Sans cela, elle se reconstruisait entierement a chaque coup : 400 ms sur une
 * partie de 2 568 coups, une fois par seconde sur une partie chronometree a la
 * seconde. Les lignes deja posees ne changent pas -- le cumul est croissant, le
 * reste est fige -- il n'y a donc qu'une ligne a poser, du cote ou elle va.
 */
function ajouterALaRoute(m: MoveInfo): void {
  $("rm-tete").innerHTML = enTeteDeLaRoute();
  if (history.length === 1) { paintRoadmap(); return; }
  cumulRoute.set(m.n, (cumulRoute.get(m.n - 1) ?? 0) + Math.max(0, m.ms));
  const piste = document.getElementById("rm-piste");
  if (piste === null) { paintRoadmap(); return; }
  const body = $("rm-body");
  const avant = routeVues.length;
  filtrerLaRoute();
  // Sur une grille infinie, le nouveau coup s'insere EN TETE : tout ce qui est
  // dessous descend d'une ligne. Qui lisait le milieu de la liste voyait donc
  // le texte glisser sous ses yeux, et un clic tomber a cote. On rattrape le
  // decalage -- sauf en haut de liste, ou l'on veut justement voir arriver le
  // coup.
  if (cfg.bornes === null && body.scrollTop > 0) {
    body.scrollTop += (routeVues.length - avant) * H_RMROW;
  }
  peindreLaRouteVisible();
}

/** Une ligne de la feuille de route. */
/** Hauteur d'une ligne de feuille de route, fixee dans la feuille de style. */
const H_RMROW = 26;

const ICONE_IMAGE =
  '<svg viewBox="0 0 18 16" width="13" height="11" aria-hidden="true">'
  + '<rect x="1" y="3" width="16" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  + '<path d="M6 3 7.2 1h3.6L12 3" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  + '<circle cx="9" cy="9" r="3.1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

/**
 * Une ligne de feuille de route, en TEXTE.
 *
 * Construite comme une chaine et non comme des elements : une partie de
 * 4 500 coups en demandait 1,7 seconde a l'ouverture, dont un tiers rien qu'a
 * analyser l'icone d'appareil photo, quatre mille cinq cents fois. Les clics
 * sont recueillis par un seul ecouteur pose sur le tableau.
 */
function ligneDeRoute(m: MoveInfo, haut: number): string {
  // Personne n'a trouve : une croix vaut mieux qu'une duree, qui serait celle
  // de l'echeance et n'apprendrait rien.
  const trouve = duplicate ? (m.trouveurs ?? []).length > 0 || quiLaTrouve(m) !== "non trouvé"
                           : m.player !== null || m.demiPoint !== undefined;
  let queue: string;
  if (duplicate) {
    const mien = m.scores?.[me];
    const ecart = mien === undefined ? null : mien - m.score;
    const trouveurs = m.trouveurs
      ?? Object.entries(m.scores ?? {}).filter(([, s]) => s === m.score).map(([n]) => n);
    const presents = Object.keys(m.scores ?? {}).length;
    queue =
      `<span class="d${ecart === 0 ? " top" : ""}">` +
      `${ecart === null ? "—" : ecart === 0 ? "top" : ecart}</span>` +
      `<span class="sur">${presents === 0 ? "" : `${trouveurs.length}/${presents}`}</span>`;
  } else {
    queue =
      `<span class="t${trouve ? "" : " non"}">${trouve ? fmtTime(m.ms) : "×"}</span>` +
      `<span class="cum">${fmtTime(cumulRoute.get(m.n) ?? 0)}</span>`;
  }

  const aime = (m.likers ?? []).includes(me);
  const muet = m.player === null || m.player === me;
  const like =
    `<button type="button" class="like" data-aime="${m.n}"${muet ? " disabled" : ""}` +
    ` aria-pressed="${aime}" title="${m.player === null ? "coup révélé, personne à féliciter"
      : m.player === me ? "votre coup" : `bravo à ${echapper(m.player)}`}">` +
    `<span aria-hidden="true">${aime ? "♥" : "♡"}</span>` +
    `<span class="n">${m.likes ?? 0}</span></button>`;

  // L'image de la position AVANT ce coup, tirage en tete. Disponible en cours
  // de partie et sur une grille infinie, la ou le rejeu ne l'est pas : c'est ce
  // qui permet de proposer un coup a chercher a tout moment.
  const image =
    `<button type="button" class="rm-image" data-image="${m.n}"` +
    ` title="image de la grille au coup ${m.n}, avec son tirage">${ICONE_IMAGE}</button>`;
  // Rejouer CE coup. Seulement sur une partie close : avant, le serveur refuse
  // les paliers, et le rejeu n'aurait rien a montrer.
  const rejouer = finie
    ? `<button type="button" class="rm-rejouer" data-revoir="${m.n}" title="revoir le coup ${m.n}">R</button>`
    : `<span class="r"></span>`;

  const tousLesTrouveurs = duplicate ? trouveursDuCoup(m) : [];
  const infobulle = tousLesTrouveurs.length > 2
    ? ` title="trouvé par ${echapper(tousLesTrouveurs.join(", "))}"` : "";
  return `<div class="rmrow" tabindex="0" data-coup="${m.n}"${infobulle} style="top:${haut}px">` +
    `<span class="n">${m.n}</span><span class="q">${echapper(m.notation)}</span>` +
    image + rejouer +
    `<span class="w">${echapper(m.word)}</span>` +
    `<span class="p">${noteCoup(m.dir, m.x, m.y, cfg.bornes)}</span>` +
    `<span class="s">${m.score}</span>` +
    `<span class="who">${echapper(quiLaTrouve(m))}</span>` + queue + like + `</div>`;
}
$("rm-open").addEventListener("click", () => {
  // On decouvre AVANT de peindre : le nombre de lignes a poser se deduit de la
  // hauteur du tableau, et un tableau cache n'en a pas. On n'en posait que cinq,
  // et les autres n'arrivaient qu'au premier defilement.
  $("roadmap").hidden = false;
  paintRoadmap();
});

($("rm-q") as HTMLInputElement).addEventListener("input", () => {
  filtrerLaRoute();
  $("rm-body").scrollTop = 0;
  peindreLaRouteVisible();
});
$("rm-close").addEventListener("click", () => { $("roadmap").hidden = true; });

// ---------------------------------------------------------------- chat

/** Hauteur d'une ligne du journal, fixee en dur dans la feuille de style. */
const H_JROW = 18;

/**
 * Les coups joues, du plus recent au plus ancien.
 *
 * Seules les lignes VISIBLES sont posees -- la boite fait 112 pixels de haut,
 * soit six lignes. Les poser toutes coutait 197 ms de mise en page sur une
 * partie de 1 756 coups, a chaque coup : sur une partie chronometree a la
 * seconde, un cinquieme du temps disponible passait a redessiner des lignes que
 * personne ne regardait, et la grille en devenait poussive au deplacement.
 */
function paintJournal(): void {
  // Muet pendant le rejeu : `voirLeCoup` l'a cache expres.
  $("journal-bloc").hidden = history.length === 0 || rejeu !== null;
  $("journal-n").textContent = String(history.length);
  $("journal-piste").style.height = `${history.length * H_JROW}px`;
  $("journal").scrollTop = 0;
  peindreLeJournalVisible();
}

/** Pose les lignes du journal qui tombent dans la partie visible. */
function peindreLeJournalVisible(): void {
  const box = $("journal");
  const n = history.length;
  if (n === 0) { $("journal-piste").replaceChildren(); return; }
  const haut = Math.max(0, Math.floor(box.scrollTop / H_JROW) - 4);
  const bas = Math.min(n, Math.ceil((box.scrollTop + box.clientHeight) / H_JROW) + 4);

  let html = "";
  for (let i = haut; i < bas; i++) {
    // Le plus recent en haut : la ligne i montre le coup n - i.
    const m = history[n - 1 - i];
    if (m === undefined) continue;
    const place = noteCoup(m.dir, m.x, m.y, cfg.bornes);
    const titre = `${m.word} · ${place} · ${m.score} pts · ${quiLaTrouve(m, true)}`
      + (duplicate ? "" : ` · en ${fmtTime(m.ms)}`);
    html +=
      `<button type="button" class="jrow" data-n="${m.n}" style="top:${i * H_JROW}px"` +
      ` title="${echapper(titre)}">` +
      `<span class="n">${m.n}</span><span class="w">${echapper(m.word)}</span>` +
      `<span class="p">${place}</span>` +
      `<span class="s">${m.score}</span>` +
      `<span class="t">${fmtTime(m.ms)}</span></button>`;
  }
  $("journal-piste").innerHTML = html;
}

$("journal").addEventListener("scroll", peindreLeJournalVisible);
$("journal").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest(".jrow") as HTMLElement | null;
  if (b === null) return;
  const m = history.find((q) => q.n === Number(b.dataset["n"]));
  if (m !== undefined) focusMove(m);
});

function paintChat(msgs: Chat[]) {
  const log = $("chat-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren();
  for (const m of msgs) log.appendChild(ligneDeChat(m));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/** Ajoute un seul message, en gardant le defilement s'il etait en bas. */
function ajouterAuChat(m: Chat): void {
  const log = $("chat-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.appendChild(ligneDeChat(m));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function ligneDeChat(m: Chat): HTMLElement {
  const el = document.createElement("div");
  el.className = "msg";
  const who = document.createElement("span");
  who.className = "who"; who.textContent = m.who;
  el.appendChild(who);
  if (m.text) el.appendChild(document.createTextNode(m.text));
  if (m.cell) {
    const b = document.createElement("button");
    b.className = "cellref";
    // Sur un plateau borne, la case se nomme comme au jeu de societe.
    // Ligne puis colonne, comme une notation de coup : la meme case ne peut
    // pas se lire « 12,-34 » dans le chat et « H -34,12 » au journal.
    b.textContent = cfg.bornes === null
      ? `${-m.cell.y},${m.cell.x}`
      : noteCoup("H", m.cell.x, m.cell.y, cfg.bornes);
    b.addEventListener("click", () => {
      marks = [m.cell!];
      flyTo("A", "H", m.cell!.x, m.cell!.y);
    });
    el.appendChild(b);
  }
  const at = document.createElement("span");
  at.className = "at";
  at.textContent = new Date(m.at).toLocaleTimeString("fr", { hour: "2-digit", minute: "2-digit" });
  el.appendChild(at);
  return el;
}

let chat: Chat[] = [];
function sendChat(withCell: boolean) {
  const input = $("chat-text") as HTMLInputElement;
  const text = input.value.trim();
  const cell = withCell && cursor !== null ? { x: cursor.x, y: cursor.y } : undefined;
  if (!text && !cell) return;
  envoyer({ t: "say", text, cell });
  input.value = "";
}
$("chat-send").addEventListener("click", () => sendChat(false));
$("chat-cell").addEventListener("click", () => {
  if (cursor === null) { flash("cliquez d'abord une case", "bad"); return; }
  sendChat(true);
});
$("chat-text").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e as KeyboardEvent).key === "Enter") sendChat(false);
});

// ---------------------------------------------------------------- saisie

let flashTimer = 0;
function flash(text: string, kind: "bad" | "ok" | "top") {
  const el = $("flash");
  el.textContent = text;
  el.className = `flash ${kind}`;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { el.hidden = true; }, kind === "top" ? 2600 : 1900);
}

cv.addEventListener("contextmenu", (e) => e.preventDefault());

/**
 * L'appui en cours. `cx`/`cy` retiennent la case visee AU MOMENT DE L'APPUI :
 * c'est elle qui compte, pas celle qu'on survole en relachant. Un doigt qui
 * frémit ne doit pas poser le curseur une case plus loin.
 */
let press: {
  x: number; y: number; button: number; moved: boolean; at: number;
  cx: number; cy: number;
} | null = null;
let holdTimer = 0;

cv.addEventListener("pointerdown", (e) => {
  const r0 = cv.getBoundingClientRect();
  press = {
    x: e.clientX, y: e.clientY, button: e.button, moved: false, at: Date.now(),
    cx: Math.floor((e.clientX - r0.left - ox) / cell),
    cy: Math.floor((e.clientY - r0.top - oy) / cell),
  };
  cv.setPointerCapture(e.pointerId);
  if (e.button === 1) e.preventDefault();
  // Clic droit MAINTENU : proposition de partager la case dans le chat.
  if (e.button === 2) {
    const gx = press.cx, gy = press.cy;
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      if (press === null || press.moved) return;
      press = null;
      // On ne partage pas une case qui n'existe pas.
      if (!board.dansLesBornes(gx, gy)) return;
      envoyer({ t: "say", text: "", cell: { x: gx, y: gy } });
      flash(`case ${noteCoup("H", gx, gy, cfg.bornes)} partagée`, "ok");
    }, 550);
  }
});

cv.addEventListener("pointermove", (e) => {
  if (press === null) return;
  const dx = e.clientX - press.x, dy = e.clientY - press.y;
  if (!press.moved && Math.hypot(dx, dy) < 4) return;
  clearTimeout(holdTimer);
  // Plateau ferme : il n'y a rien a faire glisser, donc rien qui puisse
  // transformer un clic en deplacement. Le clic reste un clic.
  if (cfg.bornes !== null) return;
  press.moved = true;
  if (anim) { cancelAnimationFrame(anim); anim = 0; }
  ox += dx; oy += dy;
  press.x = e.clientX; press.y = e.clientY;
  cv.style.cursor = "grabbing";
  redessiner();
});

cv.addEventListener("pointerup", (e) => {
  clearTimeout(holdTimer);
  const p = press;
  press = null;
  cv.style.cursor = "";
  try { cv.releasePointerCapture(e.pointerId); } catch { /* deja relache */ }
  if (p === null || p.moved || p.button === 1) return;

  // La case retenue est celle de l'APPUI, pas celle du relachement.
  const x = p.cx, y = p.cy;
  // Hors du plateau, il n'y a rien : on ne pose pas de curseur sur du vide.
  if (!board.dansLesBornes(x, y)) return;
  marks = [];
  if (cursor !== null && cursor.x === x && cursor.y === y) {
    // Recliquer la meme case fait pivoter le sens -- mais pas au milieu d'un mot.
    if (typed.length === 0) cursor = { x, y, dir: cursor.dir === "H" ? "V" : "H" };
  } else {
    cursor = { x, y, dir: p.button === 2 ? "V" : "H" };
    typed = "";
  }
  paintRack(); paintCurrent(); draw();
});
cv.addEventListener("pointercancel", () => { press = null; clearTimeout(holdTimer); cv.style.cursor = ""; });

addEventListener("keydown", (e) => {
  if (!$("join").hidden) return;
  // Toute zone de saisie garde ses touches : sans cela, Retour arriere etait
  // avale par le jeu et n'effacait rien dans les champs des reglages.
  const cible = document.activeElement;
  if (cible instanceof HTMLInputElement || cible instanceof HTMLTextAreaElement) {
    // Une exception : depuis le champ de recherche du rejeu, haut et bas
    // parcourent la liste, comme dans une liste de suggestions. Gauche et
    // droite restent au curseur, sinon on ne pourrait plus se corriger.
    if (cible.id === "rj-q" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      deplacerDansLaListe(e.key === "ArrowUp" ? -1 : 1);
      e.preventDefault();
    }
    return;
  }
  if (!$("panel-rejeu").hidden) {
    if (e.key === "Escape") { fermerLeRejeu(); return; }
    if (e.key === "ArrowUp") { deplacerDansLaListe(-1); e.preventDefault(); return; }
    if (e.key === "ArrowDown") { deplacerDansLaListe(1); e.preventDefault(); return; }
    if (e.key === "ArrowLeft" && rejeu) { voirLeCoup(rejeu.n - 1); e.preventDefault(); return; }
    if (e.key === "ArrowRight" && rejeu) { voirLeCoup(rejeu.n + 1); e.preventDefault(); return; }
    return;
  }
  if (!$("roadmap").hidden && e.key === "Escape") { $("roadmap").hidden = true; return; }
  if (ghost !== null && e.key === "Escape") { ghost = null; draw(); return; }

  if (e.key === "Escape") { typed = ""; paintRack(); paintCurrent(); draw(); return; }
  if (e.key === " " || e.code === "Space") {
    // On pivote, et le mot en cours s'efface : le retourner tel quel poserait
    // les memes caramels dans l'autre sens, ce qui n'a aucun sens.
    if (cursor !== null) {
      cursor = { ...cursor, dir: cursor.dir === "H" ? "V" : "H" };
      typed = "";
      paintRack(); paintCurrent(); draw();
    }
    e.preventDefault();
    return;
  }
  if (e.key === "Backspace") { typed = typed.slice(0, -1); paintRack(); paintCurrent(); draw(); e.preventDefault(); return; }
  if (e.key === "Enter") { submit(); e.preventDefault(); return; }
  if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
    if (finie || decompteJusqua > Date.now() + clockSkew) return;
    // Au tout premier coup, il n'y a qu'un endroit ou poser : on n'oblige pas a
    // cliquer pour le designer. Le curseur se pose quatre cases a gauche du
    // centre, a l'horizontale -- H4 sur un plateau 15x15, H 0,-4 sur une grille
    // infinie, c'est la meme case. Le placement exact est de toute facon
    // recalcule : un premier coup se glisse a la meilleure position qui couvre
    // le centre.
    if (cursor === null && tiles.length === 0) cursor = { dir: "H", x: -4, y: 0 };
    if (cursor === null) return;
    if (typed.length >= 15) return;
    const ch = e.key.toUpperCase();
    const left = remaining();
    // Lettre absente du tirage : il ne se passe simplement rien.
    if (!left.includes(ch) && !left.includes(BLANK)) return;
    typed += ch;
    paintRack(); paintCurrent(); draw();
    return;
  }
  const d = 60;
  if (e.key === "ArrowLeft") { ox += d; draw(); }
  if (e.key === "ArrowRight") { ox -= d; draw(); }
  if (e.key === "ArrowUp") { oy += d; draw(); }
  if (e.key === "ArrowDown") { oy -= d; draw(); }
});

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (cfg.bornes !== null) return;   // plateau ferme : le cadrage est fixe
  if (anim) { cancelAnimationFrame(anim); anim = 0; }
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const next = Math.max(cellMinimal(), Math.min(56, cell * Math.exp(-e.deltaY * .0016)));
  ox = mx - (mx - ox) * (next / cell);
  oy = my - (my - oy) * (next / cell);
  cell = next;
  redessiner();
}, { passive: false });

/**
 * Un dessin par image, pas un par evenement.
 *
 * Une souris rapide emet plus de `pointermove` que l'ecran n'affiche d'images :
 * dessiner a chacun refait deux fois le meme travail pour un seul affichage.
 */
let imageDemandee = 0;
function redessiner(): void {
  if (imageDemandee !== 0) return;
  imageDemandee = requestAnimationFrame(() => { imageDemandee = 0; draw(); });
}

function submit() {
  if (cursor === null || typed.length === 0) return;
  if (finie) { flash("la partie est terminée", "bad"); return; }
  if (solving) { flash("le coup n'est pas encore prêt", "bad"); return; }
  const r = resolveTypedWord(board, dict, cursor.dir, cursor.x, cursor.y, typed, rack);
  if (!r.ok) {
    flash(r.error === "TROP_DE_CARAMELS"
      ? `C'est une partie ${cfg.jouables} sur ${cfg.tirage}`
      : PLAY_MESSAGE[r.error], "bad");
    typed = ""; paintRack(); paintCurrent(); draw();
    return;
  }
  if (best === null || r.move.score > best.score) {
    best = { word: r.move.word, score: r.move.score, dir: r.move.dir, x: r.move.x, y: r.move.y };
  }
  envoyer({ t: "try", dir: cursor.dir, x: cursor.x, y: cursor.y, typed });
  typed = ""; paintRack(); paintSide(); draw();
}

$("reveal").addEventListener("click", () => envoyer({ t: "reveal" }));

// ---------------------------------------------------------------- chronos

/** Instant du dernier coup d'une partie terminee : l'age se fige dessus. */
let finieA = 0;

setInterval(() => {
  const now = Date.now() + clockSkew;
  // Decompte d'avant-coup : 2, puis 1, puis le jeu commence.
  const reste2 = decompteJusqua - now;
  if (reste2 > 0) {
    $("decompte").hidden = false;
    $("decompte").textContent = String(Math.ceil(reste2 / 1000));
  } else {
    $("decompte").hidden = true;
  }
  if (finie) {
    // Partie close : l'age s'arrete au dernier coup, et il n'y a plus de coup
    // en cours dont on pourrait chronometrer la recherche.
    $("age").textContent = fmtTime((finieA || servedAt) - createdAt);
    $("elapsed").textContent = "—";
    return;
  }
  $("age").textContent = fmtTime(now - createdAt);
  if (dureeMax !== null && debutDeLaPartie !== 0 && demarree && !finie) {
    const reste = Math.max(0, debutDeLaPartie + dureeMax * 1000 - now);
    const mn = Math.floor(reste / 60000), sc = Math.floor((reste % 60000) / 1000);
    $("rb-reste").textContent = `${mn}:${String(sc).padStart(2, "0")}`;
  }
  if (!demarree) { $("elapsed").textContent = "—"; $("age").textContent = "—"; return; }
  if (endormi) { $("elapsed").textContent = "en pause"; return; }
  if (solving) { $("elapsed").textContent = "…"; return; }
  if (chrono === null) { $("elapsed").textContent = fmtTime(now - servedAt); return; }
  // Compte a rebours : c'est le temps qui reste qui interesse le joueur.
  const reste = Math.max(0, servedAt + chrono * 1000 - now);
  $("elapsed").textContent = `${Math.ceil(reste / 1000)} s`;
  $("elapsed").style.color = reste < 6000 ? "var(--warn)" : "";
}, 200);

// ---------------------------------------------------------------- reseau

function applyState(s: {
  rack?: string; moveNumber: number; cumul: number; solving: boolean;
  players?: Record<string, number>; online?: string[]; last?: MoveInfo | null;
  likes?: Record<string, number>; sac?: string; finie?: boolean; chrono?: number | null;
  actif?: boolean; mode?: string; nonTrouves?: number; decompteJusqua?: number;
  demarree?: boolean; coupsMax?: number | null;
  dureeMax?: number | null; debutDeLaPartie?: number;
  points?: Record<string, number>; negatif?: Record<string, number>;
  createdAt: number; now: number; servedAt: number; demarreA?: number;
}) {
  rack = s.rack ?? "";
  moveNumber = s.moveNumber;
  cumul = s.cumul;
  solving = s.solving;
  players = s.players ?? {};
  likes = s.likes ?? {};
  // Les lettres qui restent dans le sac. Rien a montrer sur une pioche
  // ponderee : elle ne s'epuise pas, il n'y a pas de reste.
  const sac = s.sac ?? "";
  $("sac").hidden = sac === "";
  if (sac !== "") $("sac").textContent = sac;
  chrono = s.chrono ?? null;
  endormi = s.actif === false;
  duplicate = s.mode === "duplicate";
  nonTrouves = s.nonTrouves ?? 0;
  decompteJusqua = s.decompteJusqua ?? 0;
  demarree = s.demarree !== false;
  coupsMax = s.coupsMax ?? null;
  dureeMax = s.dureeMax ?? null;
  debutDeLaPartie = s.debutDeLaPartie ?? 0;
  points = s.points ?? {};
  negatif = s.negatif ?? {};
  // Le serveur a-t-il ete relance depuis la derniere compilation du client ?
  // Sinon les reglages partent dans le vide et on croit a un bug du jeu.
  // Un serveur qui ne dit rien est forcement anterieur a ce controle : c'est
  // justement le cas qu'il faut attraper.
  if (s.demarreA === undefined || s.demarreA < __COMPILE_A__) {
    $("perime").hidden = false;
  }
  if (s.finie === true && !finie) finieA = s.servedAt;
  finie = s.finie === true;
  online = s.online ?? [];
  last = s.last ?? null;
  createdAt = s.createdAt;
  servedAt = s.servedAt;
  clockSkew = s.now - Date.now();
  paintRack();
  paintSide();
  draw();
}

/** Vrai quand c'est NOUS qui avons ferme : pas de reconnexion automatique. */
let quitteVolontairement = false;

/**
 * Ferme la connexion en cours et attend qu'elle le soit VRAIMENT.
 *
 * Sans cette attente, changer de salon rouvrait une connexion pendant que
 * l'ancienne vivait encore : le serveur voyait deux fois le meme pseudo et
 * refusait le second avec « Ce nom d'utilisateur n'est pas disponible ». On
 * n'entrait donc jamais dans le salon suivant.
 */
function fermerConnexion(): Promise<void> {
  const vieux = ws;
  ws = null;
  if (vieux === null) return Promise.resolve();
  quitteVolontairement = true;
  if (vieux.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((res) => {
    const fini = (): void => res();
    vieux.addEventListener("close", fini, { once: true });
    vieux.close();
    // Filet : une fermeture qui ne se signale pas ne doit pas bloquer le jeu.
    setTimeout(fini, 1200);
  });
}

/**
 * Envoie un message au serveur, ou le dit quand c'est impossible.
 *
 * `ws?.send` se perdait sans bruit tant que la liaison n'etait pas ouverte :
 * un reglage applique juste apres etre entre dans un salon ne partait jamais,
 * et rien ne le signalait -- on croyait le reglage casse.
 */
function envoyer(msg: unknown): boolean {
  if (ws === null || ws.readyState !== WebSocket.OPEN) {
    flash("pas encore connecté au salon", "bad");
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  quitteVolontairement = false;
  const moi = new WebSocket(`${proto}://${location.host}`);
  ws = moi;
  moi.addEventListener("open", () => {
    $("dot").classList.add("on");
    $("conn").textContent = me;
    moi.send(JSON.stringify({ t: "join", name: me, salon: salonChoisi }));
  });
  moi.addEventListener("close", () => {
    // Une connexion remplacee ou fermee expres ne se rouvre pas toute seule.
    if (quitteVolontairement || ws !== moi) return;
    $("dot").classList.remove("on");
    $("conn").textContent = "déconnecté — reconnexion…";
    setTimeout(connect, 1500);
  });
  moi.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data as string);

    if (m.t === "hello") {
      setLayout(m.layout as LayoutName);
      canReveal = m.reveal === true;
      tiles = m.tiles;
      history = m.moves;
      chat = m.chat ?? [];
      // La variante vient du serveur : c'est elle qui dit combien de caramels se
      // posent, ce que vaut chaque lettre et quelle prime recompense quoi.
      cfg = m.config ? deserialiser(m.config) : configParDefaut();
      board = new Board(dict, cfg);
      // Seul le proprietaire regle son salon. La grille permanente n'en a pas.
      $("reglages-open").hidden = m.proprietaire !== me;
      $("conn").textContent = `${me} · ${m.nomSalon}`;
      // Une partie qui n'a pas commence s'ouvre sur ses reglages : c'est la
      // qu'on choisit la variante avant de lancer quoi que ce soit.
      if (m.state?.demarree === false && m.proprietaire === me) {
        setTimeout(ouvrirReglages, 60);
      }
      board.place(tiles.map((t: Tile): Placement => ({ x: t.x, y: t.y, letter: t.l, blank: t.b === 1 })));
      paintChat(chat);
      paintJournal();
      applyState(m.state);
      // Le cadrage depend de la variante, qu'on ne connait qu'ici : un plateau
      // borne se centre, une grille infinie se pose sur son dernier coup.
      configRecue = true;
      if (cfg.bornes !== null) {
        cadrer();
        draw();
      } else {
        ox = W / 2 - cell / 2;
        oy = H / 2 - cell / 2;
        if (tiles.length > 0 && last !== null) flyTo(last.word, last.dir, last.x, last.y);
        else draw();
      }
      return;
    }
    if (m.t === "refus") {
      void fermerConnexion();
      $("join").hidden = false;
      void peuplerSalons();
      $("join-error").textContent = m.message;
      $("join-error").hidden = false;
      ($("name") as HTMLInputElement).select();
      return;
    }
    if (m.t === "relance") {
      // Le rejeu portait sur la partie precedente : il n'a plus d'objet, et sa
      // liste de solutions renvoie a une grille qui vient peut-etre de changer
      // de taille.
      if (rejeu !== null) fermerLeRejeu();
      cfg = m.config ? deserialiser(m.config) : cfg;
      tiles = m.tiles ?? [];
      history = [];
      chat = m.chat ?? [];
      board = new Board(dict, cfg);
      board.place(tiles.map((t: Tile): Placement => ({ x: t.x, y: t.y, letter: t.l, blank: t.b === 1 })));
      typed = ""; ghost = null; best = null; finie = false; finieA = 0;
      cursor = null; marks = [];
      paintChat(chat);
      paintJournal();
      applyState(m.state);
      // La relance a pu changer de grille : on recadre selon la NOUVELLE.
      if (cfg.bornes !== null) cadrer();
      else { ox = W / 2 - cell / 2; oy = H / 2 - cell / 2; }
      flash("nouvelle partie dans ce salon", "ok");
      draw();
      return;
    }
    if (m.t === "state") { applyState(m.state); return; }
    // Un "j'aime" est arrive : on met a jour le coup concerne, partout.
    if (m.t === "tiers") { montrerPaliers(m.n, m.tiers, m.refus); return; }
    if (m.t === "likes") {
      const upd = (q: MoveInfo | null) => {
        if (q === null || q.n !== m.n) return;
        q.likers = m.likers; q.likes = m.likers.length;
      };
      for (const q of history) upd(q);
      upd(last);
      paintSide();
      if (!$("roadmap").hidden) paintRoadmap();
      return;
    }
    // Une ligne de plus, pas tout le journal : en duplicate le moteur poste un
    // message PAR COUP, et repeindre les 2 568 precedents a chaque fois coutait
    // 135 ms -- pour ajouter une ligne.
    if (m.t === "said") { chat.push(m.msg); ajouterAuChat(m.msg); return; }

    if (m.t === "placed") {
      const mv = m.move as MoveInfo;
      board.place(m.placements as Placement[]);
      for (const p of m.placements as Placement[]) {
        tiles.push({ x: p.x, y: p.y, l: p.letter, b: p.blank ? 1 : 0, n: mv.n });
      }
      history.push(mv);
      best = null;
      typed = "";
      ghost = null;
      applyState(m.state);
      paintJournal();
      if (!$("roadmap").hidden) ajouterALaRoute(mv);

      // La camera NE BOUGE PAS. Se faire deplacer sans l'avoir demande, en
      // pleine recherche, donne le mal de mer : c'est au joueur de cliquer le
      // coup s'il veut aller le voir.
      draw();
      // Pas de bandeau flottant pour annoncer le top : il est deja au tableau
      // « Top », au journal des coups et sur la grille. Le repeter une seconde
      // en bas de l'ecran n'apprenait rien a personne.
      return;
    }

    if (m.t === "result" && !m.ok) flash(m.message, "bad");
  });
}

// ---------------------------------------------------------------- amorçage

// ---------------------------------------------------------------- accueil

/** Le salon qu'on rejoint. Vient de l'adresse, ou du salon clique. */
let salonChoisi = new URLSearchParams(location.search).get("salon") ?? "";

interface ResumeSalon {
  id: string; nom: string; proprietaire: string | null; mondiale: boolean;
  coups: number; finie: boolean; connectes: number;
  config: { tirage: number; jouables: number; pioche: string; bornes: number | null; joker?: boolean };
}

function nomPioche(p: string): string {
  return p === "sac102" ? "sac de 102" : p === "sac102boucle" ? "sac de 102 sans fin"
    : "probabilités pondérées";
}

function decritJoker(j: boolean): string {
  return j ? " · joker" : "";
}

function decritVariante(c: ResumeSalon["config"]): string {
  const grille = c.bornes === null ? "grille infinie" : `${c.bornes * 2 + 1}×${c.bornes * 2 + 1}`;
  return `${grille} · ${c.jouables} sur ${c.tirage} · ${nomPioche(c.pioche)}${decritJoker(c.joker === true)}`;
}

/** Deux icones : la grille sans bord, et le plateau ferme. */
function icone(infinie: boolean): string {
  return infinie
    ? `<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2">
         <path d="M1 5.5h14M1 10.5h14M5.5 1v14M10.5 1v14" stroke-dasharray="2 1.6"/>
       </svg>`
    : `<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2">
         <rect x="1.6" y="1.6" width="12.8" height="12.8" rx="1"/>
         <path d="M1.6 6h12.8M1.6 10h12.8M6 1.6v12.8M10 1.6v12.8"/>
       </svg>`;
}

async function peuplerSalons(): Promise<void> {
  const box = $("salons");
  let data: { salons: ResumeSalon[] };
  try {
    data = await (await fetch("/api/salons")).json();
  } catch {
    box.replaceChildren();
    const e = document.createElement("div");
    e.className = "none"; e.textContent = "serveur injoignable";
    box.appendChild(e);
    return;
  }
  box.replaceChildren();
  const moi = ($("name") as HTMLInputElement).value.trim();
  // La grille permanente d'abord, toujours : c'est celle qu'on vient jouer, et
  // elle se retrouvait au milieu des salons du moment, a une place qui changeait
  // avec eux. Le reste garde l'ordre du serveur, du plus ancien au plus recent.
  const liste = [...data.salons].sort((a, b) => Number(b.mondiale) - Number(a.mondiale));
  for (const s of liste) {
    const b = document.createElement("div");
    b.className = "salon";
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    const qui = s.mondiale ? '<span class="mondiale">permanent</span>' : `par ${s.proprietaire}`;
    const etat = s.finie ? "terminée" : `${s.coups} coup${s.coups > 1 ? "s" : ""}`;
    b.innerHTML =
      `<span class="icone">${icone(s.config.bornes === null)}</span>` +
      `<span class="nom">${s.nom}</span>` +
      `<span class="qui">${qui}<br>${s.connectes} connecté${s.connectes > 1 ? "s" : ""}</span>` +
      `<span class="quoi">${decritVariante(s.config)} · ${etat}</span>`;
    b.addEventListener("click", () => rejoindre(s.id));
    b.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") rejoindre(s.id);
    });
    // Le createur peut retirer son salon.
    if (!s.mondiale && s.proprietaire === moi && moi !== "") {
      const jeter = document.createElement("button");
      jeter.type = "button";
      jeter.className = "jeter";
      jeter.textContent = "Supprimer";
      // Le bouton dit ce qu'il fait VRAIMENT. Il promettait que la partie
      // restait sur le disque, ce qui n'est plus vrai depuis qu'une partie
      // suit son salon : seule une 15x15 terminee lui survit.
      jeter.title = s.config.bornes !== null && s.finie
        ? "Retire le salon. La partie terminée est conservée."
        : "Retire le salon ET efface la partie. Sans retour.";
      jeter.addEventListener("click", async (e) => {
        e.stopPropagation();
        const r = await fetch(`/api/salon/${encodeURIComponent(s.id)}`, {
          method: "DELETE", headers: { "x-pseudo": moi },
        });
        if (!r.ok) {
          const d = await r.json();
          $("join-error").textContent = d.erreur ?? "suppression impossible";
          $("join-error").hidden = false;
        }
        void peuplerSalons();
      });
      b.appendChild(jeter);
    }
    box.appendChild(b);
  }
  if (data.salons.length === 0) {
    const e = document.createElement("div");
    e.className = "none"; e.textContent = "aucun salon ouvert";
    box.appendChild(e);
  }
}

/** Les reglages en cours d'edition dans le salon. */
let cTirage = 7, cJouables = 7, cPioche = "probabilites";
/** Primes en cours d'edition : points par nombre de caramels poses. */
let cPrimes: Record<number, number> = {};
/** Chrono en cours d'edition, en secondes. null = sans chrono. */
let cChrono: number | null = null;
/** Grille en cours d'edition : demi-cote, ou null pour l'infini. */
let cBornes: number | null = 7;
/** Mode en cours d'edition. */
let cMode: "topping" | "duplicate" = "topping";
/** Nombre de coups a jouer, ou null pour sans fin. */
let cCoupsMax: number | null = null;
/** Duree totale en secondes, ou null. */
let cDureeMax: number | null = null;
/** Lequel des deux termes on regle : par les coups ou par le temps. */
let cBorne: "coups" | "duree" = "coups";

/** Minutes vers secondes et retour, pour un champ qui accepte « 3,5 ». */
const enSecondes = (min: number): number => Math.round(min * 60);
const enMinutes = (s: number): string => {
  const m = s / 60;
  return Number.isInteger(m) ? String(m) : String(Math.round(m * 100) / 100).replace(".", ",");
};

function peuplerDuree(): void {
  const perso = $("r-duree-perso") as HTMLInputElement;
  let reconnu = false;
  for (const b of $("r-duree").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    const choisi = v === "sansfin" ? cDureeMax === null : Number(v) === cDureeMax;
    b.setAttribute("aria-pressed", String(choisi));
    if (choisi) reconnu = true;
  }
  perso.value = !reconnu && cDureeMax !== null ? enMinutes(cDureeMax) : "";
  $("r-duree-perso-case").setAttribute("aria-pressed", String(!reconnu && cDureeMax !== null));
}

for (const b of $("r-duree").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const v = (b as HTMLElement).dataset["v"]!;
    cDureeMax = v === "sansfin" ? null : Number(v);
    peuplerDuree();
  });
}

($("r-duree-perso") as HTMLInputElement).addEventListener("input", () => {
  const champ = $("r-duree-perso") as HTMLInputElement;
  // Des minutes, decimales acceptees : « 3,5 » comme « 3.5 ».
  const propre = champ.value.replace(/[^0-9.,]/g, "");
  if (propre !== champ.value) champ.value = propre;
  const v = Number(propre.replace(",", "."));
  if (!Number.isFinite(v) || v <= 0) return;
  cDureeMax = enSecondes(v);
  for (const b of $("r-duree").querySelectorAll("button")) b.setAttribute("aria-pressed", "false");
});

for (const b of $("r-borne-onglets").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    cBorne = (b as HTMLElement).dataset["v"] === "duree" ? "duree" : "coups";
    // Les deux termes s'excluent : choisir l'un efface l'autre.
    if (cBorne === "coups") cDureeMax = null; else cCoupsMax = null;
    peuplerCoups();
  });
}

/**
 * Le terme de la partie : un nombre de coups OU une duree, jamais les deux.
 *
 * Les deux onglets valent pour les deux modes -- une partie de topping infini
 * se borne comme une autre. On ne montre que la ligne de l'onglet choisi :
 * voir les deux ne dirait pas laquelle compte.
 */
/** La variante a-t-elle deja une fin naturelle ? */
function sansTerme(): boolean {
  return cBornes !== null || cPioche === "sac102";
}

function peuplerCoups(): void {
  // Ces bornes ne se posent que sur une partie qui n'a PAS de fin naturelle :
  // un plateau borne s'arrete quand le sac se vide, et le sac de 102 aussi.
  // En poser une la-dessus donnerait deux fins concurrentes.
  $("r-borne-bloc").hidden = sansTerme();
  for (const b of $("r-borne-onglets").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === cBorne));
  }
  $("r-coups").hidden = cBorne !== "coups";
  $("r-duree").hidden = cBorne !== "duree";
  peuplerDuree();
  const perso = $("r-coups-perso") as HTMLInputElement;
  let reconnu = false;
  for (const b of $("r-coups").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    const choisi = v === "sansfin" ? cCoupsMax === null : Number(v) === cCoupsMax;
    b.setAttribute("aria-pressed", String(choisi));
    if (choisi) reconnu = true;
  }
  perso.value = !reconnu && cCoupsMax !== null ? String(cCoupsMax) : "";
  $("r-coups-perso-case").setAttribute("aria-pressed", String(!reconnu && cCoupsMax !== null));
}

for (const b of $("r-coups").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const v = (b as HTMLElement).dataset["v"]!;
    cCoupsMax = v === "sansfin" ? null : Number(v);
    peuplerCoups();
  });
}

($("r-coups-perso") as HTMLInputElement).addEventListener("input", () => {
  const champ = $("r-coups-perso") as HTMLInputElement;
  const propre = champ.value.replace(/[^0-9]/g, "");
  if (propre !== champ.value) champ.value = propre;
  const brut = propre.trim();
  if (brut === "") return;
  const v = Math.round(Number(brut));
  if (!Number.isFinite(v) || v < 1) return;
  cCoupsMax = Math.min(9999, v);
  for (const b of $("r-coups").querySelectorAll("button")) b.setAttribute("aria-pressed", "false");
});

function peuplerMode(): void {
  for (const b of $("r-mode").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === cMode));
  }
}

for (const b of $("r-mode").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    cMode = (b as HTMLElement).dataset["v"] === "duplicate" ? "duplicate" : "topping";
    peuplerMode();
    peuplerCoups();
    // Le duplicate a besoin d'une echeance : c'est elle qui clot le coup.
    if (cMode === "duplicate" && cChrono === null) { cChrono = 60; peuplerChrono(); }
  });
}

/**
 * Previent quand la variante choisie va etouffer le solveur.
 *
 * Le cout de recherche du top croit avec le nombre d'ancrages -- donc sans fin
 * sur une grille infinie -- ET avec la taille du tirage, qui multiplie les
 * combinaisons. Les deux ensemble sont explosifs : mesure a 40 coups en 15 sur
 * 15, un tirage a deux jokers demande pres de trois minutes de calcul, contre
 * une demi-seconde sur un plateau borne, ou la grille cesse de grandir.
 */
function avertirSiExplosif(): void {
  const boite = $("r-alerte");
  if (cBornes !== null || cTirage < 10) { boite.hidden = true; return; }
  boite.innerHTML =
    `<b>Attention : tirage de ${cTirage} lettres sur une grille infinie.</b><br>` +
    `Le temps de calcul du top grandit avec la grille et le tirage. ` +
    `Ça risque de lagger au bout d'un moment.`;
  boite.hidden = false;
}

function peuplerGrille(): void {
  for (const b of $("r-grille").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    b.setAttribute("aria-pressed", String(v === "infinie" ? cBornes === null : cBornes !== null));
  }
}

for (const b of $("r-grille").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    cBornes = (b as HTMLElement).dataset["v"] === "infinie" ? null : 7;
    peuplerGrille();
    // Chaque grille a son tirage naturel : les probabilites ponderees ne
    // s'epuisent jamais, ce qu'une grille sans bord demande ; le plateau ferme
    // veut le sac de 102, et le sac sans fin n'a plus lieu d'y etre.
    if (cBornes === null && cPioche === "sac102") cPioche = "probabilites";
    if (cBornes !== null && cPioche !== "sac102") cPioche = "sac102";
    peuplerPioche();
    // APRES le tirage : l'affichage des bornes depend des deux, et le tirage
    // vient de changer sous nos pieds.
    peuplerCoups();
    avertirSiExplosif();
  });
}

/** Les quatre reglages proposes, plus la saisie libre. */
function peuplerChrono(): void {
  const perso = $("r-perso") as HTMLInputElement;
  let reconnu = false;
  for (const b of $("r-chrono").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    const choisi = v === "libre" ? cChrono === null : Number(v) === cChrono;
    b.setAttribute("aria-pressed", String(choisi));
    if (choisi) reconnu = true;
  }
  // Une duree qui ne tombe sur aucun bouton s'affiche dans la case libre.
  perso.value = !reconnu && cChrono !== null ? String(cChrono) : "";
  $("r-perso-case").setAttribute("aria-pressed", String(!reconnu && cChrono !== null));
}

for (const b of $("r-chrono").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const v = (b as HTMLElement).dataset["v"]!;
    cChrono = v === "libre" ? null : Number(v);
    peuplerChrono();
  });
}

/** Duree la plus courte acceptee, en secondes. */
const CHRONO_MIN = 1;

($("r-perso") as HTMLInputElement).addEventListener("input", () => {
  const champ = $("r-perso") as HTMLInputElement;
  // Rien que des chiffres : une lettre tapee la n'a aucun sens, et la laisser
  // s'afficher fait croire qu'elle compte.
  const propre = champ.value.replace(/[^0-9]/g, "");
  if (propre !== champ.value) champ.value = propre;
  const brut = propre.trim();
  // Un champ vide, ou une valeur qu'on est en train de taper, ne doit RIEN
  // changer. Retomber sur « sans chrono » en silence -- ce que faisait un
  // plancher a cinq secondes -- fait passer un reglage refuse pour un reglage
  // accepte, et c'est le pire des deux mondes.
  if (brut === "") return;
  const v = Math.round(Number(brut));
  if (!Number.isFinite(v) || v < CHRONO_MIN) return;
  cChrono = Math.min(3600, v);
  for (const b of $("r-chrono").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", "false");
  }
});

/** La table habituelle : 50 a sept caramels, puis 25 de plus par caramel. */
function primesHabituelles(): Record<number, number> {
  const t: Record<number, number> = {};
  for (let n = 7; n <= 15; n++) t[n] = 50 + (n - 7) * 25;
  return t;
}

/**
 * Une case par nombre de caramels posables. On ne montre que ce qui est
 * atteignable : au-dela de `jouables`, la prime ne servirait jamais.
 */
function peuplerPrimes(): void {
  const box = $("r-primes-grille");
  box.replaceChildren();
  for (let n = 2; n <= cJouables; n++) {
    const l = document.createElement("label");
    l.className = "prime";
    const champ = document.createElement("input");
    champ.type = "text";
    champ.inputMode = "numeric";
    champ.maxLength = 4;
    champ.value = String(cPrimes[n] ?? 0);
    champ.addEventListener("input", () => {
      // Rien que des chiffres : une lettre tapee la n'a aucun sens.
      const propre = champ.value.replace(/[^0-9]/g, "");
      if (propre !== champ.value) champ.value = propre;
      cPrimes[n] = Math.max(0, Math.min(9999, Number(propre) || 0));
    });
    const b = document.createElement("b");
    b.textContent = String(n);
    l.append(b, champ);
    box.appendChild(l);
  }
}

$("r-primes-open").addEventListener("click", () => {
  const ouvert = $("r-primes").hidden;
  $("r-primes").hidden = !ouvert;
  $("r-primes-open").textContent = ouvert ? "Masquer les primes" : "Primes de farfouilles";
  if (ouvert) peuplerPrimes();
});

$("r-primes-defaut").addEventListener("click", () => {
  cPrimes = primesHabituelles();
  peuplerPrimes();
});

function peuplerNombres(): void {
  for (const [id, get] of [["r-tirage", () => cTirage], ["r-jouables", () => cJouables]] as const) {
    const box = $(id);
    box.replaceChildren();
    for (let n = 2; n <= 15; n++) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = String(n);
      b.dataset["n"] = String(n);
      b.setAttribute("aria-pressed", String(get() === n));
      // On ne peut pas poser plus de caramels qu'on n'en pioche.
      if (id === "r-jouables") (b as HTMLButtonElement).disabled = n > cTirage;
      b.addEventListener("click", () => {
        if (id === "r-tirage") {
          cTirage = n;
          if (cJouables > n) cJouables = n;
        } else cJouables = n;
        peuplerNombres();
        avertirSiExplosif();
        if (!$("r-primes").hidden) peuplerPrimes();
      });
      box.appendChild(b);
    }
  }
}

for (const b of $("r-pioche").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    cPioche = (b as HTMLElement).dataset["v"] ?? "probabilites";
    peuplerPioche();
    peuplerCoups();
  });
}

/**
 * Les trois tirages possibles. Le sac sans fin n'a de sens que sur une grille
 * infinie : sur un plateau ferme la partie s'arrete avant qu'il ne se recharge.
 */
function peuplerPioche(): void {
  for (const b of $("r-pioche").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    b.setAttribute("aria-pressed", String(v === cPioche));
    const interdit = v === "sac102boucle" && cBornes !== null;
    (b as HTMLButtonElement).disabled = interdit;
    (b as HTMLButtonElement).title = interdit
      ? "réservé aux grilles infinies" : "";
  }
}

/** Ouvre les reglages sur l'etat courant de la partie. */
function ouvrirReglages(): void {
  cTirage = cfg.tirage;
  cJouables = cfg.jouables;
  cPioche = cfg.pioche;
  cPrimes = { ...cfg.primes };
  cChrono = cfg.chrono;
  cBornes = cfg.bornes;
  cMode = cfg.mode === "duplicate" ? "duplicate" : "topping";
  cCoupsMax = cfg.coupsMax;
  cDureeMax = cfg.dureeMax;
  cBorne = cfg.dureeMax !== null ? "duree" : "coups";
  ($("r-decompte") as HTMLInputElement).checked = cfg.decompte === true;
  peuplerMode();
  peuplerCoups();
  peuplerChrono();
  peuplerGrille();
  avertirSiExplosif();
  ($("r-joker") as HTMLInputElement).checked = cfg.joker === true;
  $("r-primes").hidden = true;
  $("r-primes-open").textContent = "Primes de farfouilles";
  peuplerNombres();
  peuplerPioche();
  $("r-error").hidden = true;
  $("reglages").hidden = false;
}

$("reglages-open").addEventListener("click", ouvrirReglages);
$("rg-close").addEventListener("click", () => { $("reglages").hidden = true; });

$("r-appliquer").addEventListener("click", () => {
  envoyer({
    t: "relancer", tirage: cTirage, jouables: cJouables, pioche: cPioche,
    joker: ($("r-joker") as HTMLInputElement).checked,
    primes: cPrimes,
    chrono: cChrono,
    bornes: cBornes,
    mode: cMode,
    // Un plateau borne et un sac de 102 ont leur propre fin : on ne leur en
    // ajoute pas une seconde. C'est la meme condition qui masque les onglets.
    coupsMax: sansTerme() || cBorne !== "coups" ? null : cCoupsMax,
    dureeMax: sansTerme() || cBorne !== "duree" ? null : cDureeMax,
    decompte: ($("r-decompte") as HTMLInputElement).checked,
  });
  $("reglages").hidden = true;
});

// Quitter le salon sans le detruire : on revient a l'accueil, la partie continue.
function quitterSalon(): void {
  void fermerConnexion();
  // Le rejeu regarde une partie qu'on quitte : il n'a plus d'objet, et le
  // laisser ouvert le ferait reapparaitre par-dessus le salon suivant.
  if (rejeu !== null) fermerLeRejeu();
  $("dot").classList.remove("on");
  $("reglages").hidden = true;
  $("roadmap").hidden = true;
  $("join").hidden = false;
  void peuplerSalons();
}

$("quitter").addEventListener("click", quitterSalon);

$("creer-open").addEventListener("click", () => { void creerSalon(); });

// Le pseudo commande l'affichage des boutons Supprimer : on rafraichit la liste
// des qu'il change, sinon le createur ne verrait pas ses propres salons.
$("name").addEventListener("input", () => void peuplerSalons());

/**
 * Cree un salon et y entre, sans rien demander.
 *
 * Le nom vient du serveur, tire au hasard : on ne fait pas remplir un
 * formulaire pour entrer quelque part. Le salon s'ouvre sur ses reglages, la
 * partie ne commence qu'une fois qu'on les a valides.
 */
async function creerSalon(): Promise<void> {
  const pseudo = ($("name") as HTMLInputElement).value.trim();
  if (pseudo === "") {
    $("c-error").textContent = "Entrez d'abord votre pseudo";
    $("c-error").hidden = false;
    ($("name") as HTMLInputElement).focus();
    return;
  }
  $("c-error").hidden = true;
  const r = await fetch("/api/salons", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proprietaire: pseudo }),
  });
  const s = await r.json();
  if (!r.ok) {
    $("c-error").textContent = s.erreur ?? "création impossible";
    $("c-error").hidden = false;
    return;
  }
  await rejoindre(s.id);
}

$("joinform").addEventListener("submit", (e) => {
  e.preventDefault();
  rejoindre(salonChoisi || "");
});

$("journal-tete").addEventListener("click", () => {
  const ouvert = $("journal").hidden;
  $("journal").hidden = !ouvert;
  $("journal-tri").textContent = ouvert ? "▾" : "▸";
  $("journal-tete").setAttribute("aria-expanded", String(ouvert));
});

/** Le titre ramene aux salons, sans rien detruire. */
$("accueil").addEventListener("click", () => {
  if ($("join").hidden) quitterSalon();
});

/** Quitte l'accueil et entre dans un salon. */
async function rejoindre(id: string): Promise<void> {
  const pseudo = ($("name") as HTMLInputElement).value.trim();
  if (pseudo === "") {
    $("join-error").textContent = "Entrez votre pseudo pour rejoindre";
    $("join-error").hidden = false;
    ($("name") as HTMLInputElement).focus();
    return;
  }
  me = pseudo;
  salonChoisi = id;
  try { localStorage.setItem("pseudo", me); } catch { /* navigation privee */ }
  $("join-error").hidden = true;
  $("join").hidden = true;

  await fermerConnexion();

  if (!dictCharge) {
    const bytes = await (await fetch("/dawg.bin")).arrayBuffer();
    dict = Dict.fromBytes(bytes);
    dictCharge = true;
    new ResizeObserver(resize).observe(cv);
  }
  // Table rase AVANT de se brancher. Sans cela, la grille du salon precedent
  // restait affichee jusqu'a l'arrivee de `hello` : on voyait ses caramels,
  // parfois HORS des bornes du nouveau plateau, comme si des mots avaient deja
  // ete joues. La camera, elle, gardait le cadrage de l'ancienne grille.
  if (rejeu !== null) fermerLeRejeu();
  tiles = [];
  history = [];
  chat = [];
  last = null;
  cursor = null;
  ghost = null;
  best = null;
  typed = "";
  rack = "";
  marks = [];
  finie = false;
  endormi = false;
  decompteJusqua = 0;
  players = {};
  likes = {};
  points = {};
  negatif = {};
  nonTrouves = 0;
  cfg = configParDefaut();
  configRecue = false;
  board = new Board(dict, cfg);
  paintChat(chat);
  paintJournal();
  resize();
  connect();
}

void peuplerSalons();

try {
  const saved = localStorage.getItem("pseudo");
  if (saved) ($("name") as HTMLInputElement).value = saved;
} catch { /* navigation privee : sans importance */ }

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());
