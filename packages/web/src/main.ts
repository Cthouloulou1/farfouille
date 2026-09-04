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
import {
  configParDefaut, deserialiser, valeurDe, type ConfigPartie,
} from "../../engine/src/config.ts";
import {
  DICO_PAR_DEFAUT, tousLesDictionnaires,
} from "../../engine/src/dictionnaires.ts";
import { choisirLaLangue, langue, t, t2, traduireLeDocument } from "./langue.ts";
import { bonusChar, setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { BLANK } from "../../engine/src/alphabet.ts";
import {
  step, noteCoup, setReperes, nomColonne, nomLigne, type Dir, type Reperes,
} from "../../engine/src/coords.ts";
import { resolveTypedWord, PLAY_MESSAGE } from "../../engine/src/play.ts";
import { chercherLeMot } from "../../engine/src/chercher.ts";

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
/**
 * Les lexiques deja telecharges, par identifiant.
 *
 * Un salon anglais et un salon francais ne lisent pas le meme fichier, et l'on
 * passe de l'un a l'autre sans recharger la page : on garde donc ce qui est
 * arrive plutot que de le redemander a chaque va-et-vient. Le DAWG anglais pese
 * 0,23 Mo, le francais 0,45 : les garder tous les deux ne coute rien.
 */
const lexiques = new Map<string, Dict>();
/** Le lexique actuellement dans `dict`. Vide tant que rien n'est charge. */
let dictId = "";

async function chargerLeDictionnaire(id: string): Promise<void> {
  const deja = lexiques.get(id);
  if (deja !== undefined) { dict = deja; dictId = id; return; }
  const bytes = await (await fetch(`/dawg.bin?d=${encodeURIComponent(id)}`)).arrayBuffer();
  const charge = Dict.fromBytes(bytes);
  lexiques.set(id, charge);
  dict = charge;
  dictId = id;
}
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
/** Combien de tops chacun a trouves, dans les deux modes. */
let tops: Record<string, number> = {};
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
/** Somme des coups joues, en millisecondes. Le calcul du serveur n'y entre pas. */
let tempsJoue = 0;
/** Cette partie laisse-t-elle revoir ses coups avant d'etre finie ? */
let rejeuOuvert = false;

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
/**
 * Les pseudos verifies parmi les presents.
 *
 * UNE VERIFICATION QUE PERSONNE NE VOIT NE SERT A RIEN : elle dit aux autres
 * joueurs que celui-la est bien qui il pretend etre. Elle se lit donc dans le
 * classement, la ou l'on regarde les noms.
 */
let verifies = new Set<string>();
/**
 * Le vrai nom des presents QUI ONT VOULU LE MONTRER.
 *
 * Il ne s'affiche pas d'office : il se pose en infobulle sur le pseudo, dans le
 * classement comme dans le chat. Le navigateur attend un instant avant de la
 * montrer, ce qui est exactement le bon rythme -- on ne le lit que si on l'a
 * cherche, et il n'encombre jamais la lecture des chiffres.
 */
let nomsPublics: Record<string, string> = {};
/** Les presents qui ont un compte : eux seuls ont une fiche a ouvrir. */
let inscrits = new Set<string>();
let last: MoveInfo | null = null;
let createdAt = Date.now();
let servedAt = Date.now();
/** Ecart entre l'horloge du serveur et la notre. */
let clockSkew = 0;

/**
 * Ou l'on ecrit, et dans quel sens.
 *
 * `rec` -- a reculons -- inverse la marche : les lettres se posent vers la
 * GAUCHE ou vers le HAUT, et le mot s'ecrit donc a l'envers. C'est une facon
 * de gagner du temps quand on repere d'abord la FIN du mot : on pose le
 * curseur sur le collage et on tape, au lieu de compter les cases en arriere
 * pour trouver ou commencer. Voir SPEC.md §18.
 *
 * Le moteur, lui, ne connait que la gauche-droite et le haut-bas : c'est
 * `coupCanonique` qui retourne la chose avant de la lui donner.
 */
let cursor: { x: number; y: number; dir: Dir; rec: boolean } | null = null;
let typed = "";
let best: { word: string; score: number; dir: Dir; x: number; y: number } | null = null;
let openPlayer: string | null = null;
/**
 * Qui REGLE le salon en ce moment -- pas toujours qui l'a cree.
 *
 * Le createur parti, les manettes vont a quelqu'un qui est la, et lui
 * reviennent des qu'il revient. C'est le serveur qui tranche ; l'ecran ne fait
 * que montrer ou cacher le bouton des reglages.
 */
let gerant: string | null = null;
/** La grille permanente : celle qui n'appartient a personne. */
let salonPermanent = false;
/** Ce salon ne se supprime ni ne se rerelance : c'est une grille d'etude. */
let permanent = false;
let marks: { x: number; y: number }[] = [];

/** Coup examine : la grille est rembobinee et une solution posee par-dessus. */
/**
 * Le coup mis en evidence sur la grille, quand on en clique un.
 *
 * `jokers` dit, lettre par lettre, laquelle est posee par un joker. Rien
 * d'autre ne le porte : le mot n'est qu'une suite de lettres, et un joker s'y
 * lit comme la lettre qu'il joue.
 */
let ghost: { word: string; dir: Dir; x: number; y: number; jokers: boolean[] } | null = null;
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
  // La rangee de caramels suit la grille : sa taille comme son centre se
  // deduisent de la place que le canevas occupe.
  calerLeChevalet();
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
/**
 * Largeur de la bande d'etiquettes collee au plateau borne.
 *
 * Elle suit la taille de son ecriture : des reperes qu'on lit de loin ont
 * besoin de place, et cette place vient du plateau. Les deux se decident donc
 * ensemble, jamais l'une sans l'autre.
 */
const REGLE_BORNEE = 26;
/** Air laisse autour de l'ensemble plateau + etiquettes. */
const MARGE_BORNEE = 8;

/**
 * Cadre le plateau borne, ETIQUETTES COMPRISES.
 *
 * On centrait le plateau dans ce qui restait sous une bande de reperes de
 * trente-quatre pixels, collee au bord du canevas : il se retrouvait avec
 * quarante pixels au-dessus et six en dessous, l'air d'avoir glisse au fond de
 * l'ecran. Les reperes viennent maintenant se coller au plateau, et c'est le
 * BLOC ENTIER qu'on centre -- autant d'air en haut qu'en bas.
 */
function cadrer(): void {
  const b = cfg.bornes;
  if (b === null) return;
  const cotes = b * 2 + 1;
  const dispo = Math.min(W, H) - REGLE_BORNEE - MARGE_BORNEE * 2;
  cell = Math.max(12, Math.floor(dispo / cotes));
  const taille = cell * cotes;
  const bloc = REGLE_BORNEE + taille;
  // Cale sur des pixels d'ecran : la moitie d'un ecart impair de largeur donne
  // un demi-pixel, et le plateau se decalait d'un cheveu a la moindre variation
  // de la mise en page -- ce qui se voit comme une secousse.
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cale = (v: number) => Math.round(v * dpr) / dpr;
  ox = cale((W - bloc) / 2 + REGLE_BORNEE + b * cell);
  // EN HAUTEUR, LE PLATEAU SE POSE EN HAUT. Centre, il descendait de tout l'air
  // qui restait -- et sur une fenetre haute et etroite, ou c'est la LARGEUR qui
  // decide de la taille des cases, cet air se compte en centaines de pixels. On
  // lit une grille du haut vers le bas ; l'espace qui reste va donc dessous.
  oy = cale(MARGE_BORNEE + REGLE_BORNEE + b * cell);
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

/**
 * Le sens suivant, quand on appuie sur espace.
 *
 * A DEUX SENS -- le reglage par defaut -- on alterne droite et bas, les deux
 * seuls sens dans lesquels un mot se lit. A QUATRE, le tour se poursuit par la
 * gauche et le haut : le mot s'ecrit alors a reculons, ce qui va plus vite
 * quand c'est la FIN du mot qu'on a reperee d'abord (SPEC.md §18).
 */
function pivoter(
  c: { x: number; y: number; dir: Dir; rec: boolean },
): { x: number; y: number; dir: Dir; rec: boolean } {
  const tour: { dir: Dir; rec: boolean }[] = prefs.quatre
    ? [{ dir: "H", rec: false }, { dir: "V", rec: false },
       { dir: "H", rec: true }, { dir: "V", rec: true }]
    : [{ dir: "H", rec: false }, { dir: "V", rec: false }];
  const i = tour.findIndex((s) => s.dir === c.dir && s.rec === c.rec);
  const suivant = tour[(i + 1) % tour.length]!;
  return { x: c.x, y: c.y, ...suivant };
}

/** Le pas du curseur, dans le sens ou il marche. */
function pasDuCurseur(): { dx: number; dy: number } {
  if (cursor === null) return { dx: 1, dy: 0 };
  const { dx, dy } = step(cursor.dir);
  return cursor.rec ? { dx: -dx, dy: -dy } : { dx, dy };
}

/**
 * Le coup TEL QUE LE MOTEUR L'ATTEND : un depart, un sens, et les lettres dans
 * l'ordre de lecture.
 *
 * Un curseur qui recule pose ses lettres de droite a gauche : la premiere tapee
 * est la DERNIERE du mot. Le moteur n'a pas a le savoir -- on lui rend le mot a
 * l'endroit, en partant de la case la plus lointaine atteinte. Les cases
 * occupees se sautent de la meme facon dans un sens comme dans l'autre, si bien
 * que les deux lectures posent exactement les memes caramels.
 */
function coupCanonique(): { dir: Dir; x: number; y: number; typed: string } | null {
  if (cursor === null) return null;
  if (!cursor.rec) return { dir: cursor.dir, x: cursor.x, y: cursor.y, typed };
  const cases = typedCells();
  if (cases.length === 0) return null;
  const fin = cases[cases.length - 1]!;
  return {
    dir: cursor.dir, x: fin.x, y: fin.y,
    typed: [...typed].reverse().join(""),
  };
}

/**
 * Une case LIBRE au milieu de ce qu'on regarde.
 *
 * C'est la ou le curseur apparait quand on appuie sur une fleche sans en avoir
 * un. Le milieu de l'ecran est le seul endroit qui ne surprenne pas -- et il
 * doit etre libre : poser le curseur sur une lettre deja posee obligerait a
 * repartir avant meme d'avoir commence. On s'ecarte donc en spirale jusqu'a
 * trouver de la place, ce qui est immediat meme sur une grille dense.
 */
function caseLibreAuCentre(): { x: number; y: number } | null {
  const cx = Math.floor((W / 2 - ox) / cell), cy = Math.floor((H / 2 - oy) / cell);
  for (let r = 0; r < 60; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Seulement le CONTOUR du carre de rayon r : l'interieur a deja ete vu.
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (!board.dansLesBornes(x, y)) continue;
        if (board.at(x, y) === undefined) return { x, y };
      }
    }
  }
  return null;
}

/**
 * Ramene le curseur dans l'ecran, s'il vient d'en sortir.
 *
 * On DEPLACE le strict necessaire, sans recentrer : une grille qui saute a
 * chaque fleche fait perdre le fil de ce qu'on lisait. Deux cases de marge
 * suffisent a voir ou l'on va.
 */
function suivreLeCurseur(): void {
  if (cursor === null || cfg.bornes !== null) return;
  const m = cell * 2;
  const px = ox + cursor.x * cell, py = oy + cursor.y * cell;
  if (px < m) ox += m - px;
  if (px + cell > W - m) ox -= px + cell - (W - m);
  if (py < m) oy += m - py;
  if (py + cell > H - m) oy -= py + cell - (H - m);
}

function typedCells(): { x: number; y: number; letter: string }[] {
  if (cursor === null) return [];
  const { dx, dy } = pasDuCurseur();
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
  const { dx, dy } = pasDuCurseur();
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
  const c = coupCanonique();
  if (c === null) return out;
  const r = resolveTypedWord(board, dict, c.dir, c.x, c.y, c.typed, rack, false, true);
  if (!r.ok) return out;
  // ON APPARIE DANS L'ORDRE, PAS PAR COORDONNEES.
  //
  // Au premier coup, le moteur DEPLACE le mot pour lui faire couvrir l'origine
  // au meilleur endroit : les coordonnees qu'il rend ne sont plus celles ou
  // l'on ecrit. Les comparer aux cases affichees ne rapprochait donc rien, et
  // le compte du tirage partait en morceaux -- une lettre posee revenait en
  // main, un joker disparaissait, et la lettre suivante etait refusee sans
  // qu'on comprenne pourquoi. C'etait le cas du premier coup a deux jokers.
  //
  // L'ordre, lui, ne change pas : le i-eme caramel pose est la i-eme lettre
  // tapee, ou que le mot ait ete recale.
  const cases = typedCells();
  r.move.placements.forEach((p, i) => {
    const c = cases[i];
    if (p.blank && c !== undefined) out.add(`${c.x},${c.y}`);
  });
  return out;
}

/**
 * Quelles lettres du mot mis en evidence sont posees par un joker.
 *
 * UN JOKER NE RAPPORTE RIEN, ET DOIT LE DIRE. Le mot en surbrillance affichait
 * la valeur ordinaire de chacune de ses lettres : le O de T(O)M y comptait
 * 1 point alors qu'il n'en vaut aucun, et le compte du mot ne tombait plus
 * juste sous les yeux de celui qui le relisait.
 *
 * La verite est sur la grille -- chaque caramel pose garde sa marque de joker,
 * et `tiles` les retient tous, y compris ceux que le rejeu masque. Encore
 * faut-il ne lire que les caramels DE CE COUP OU D'AVANT : un caramel pose plus
 * tard occupe la case sans rien dire du mot qu'on regarde.
 *
 * Reste le mot qui n'est nulle part sur la grille -- l'isotop d'un joueur que
 * le logiciel n'a pas retenu, une solution qu'on parcourt dans le rejeu. Celui
 * la vient de la main : les lettres que le tirage ne contient pas sont des
 * jokers. Un tirage qui a A LA FOIS la lettre et le joker laisse un doute ; on
 * prend la lettre, qui rapporte davantage et que le solveur prefere pour la
 * meme raison.
 */
function jokersDuMot(m: MoveInfo | undefined, word: string, dir: Dir,
                     gx: number, gy: number): boolean[] {
  // Jusqu'ou la grille fait foi. Le mot JOUE est sur la grille au coup `m.n` ;
  // tout autre mot du meme coup n'y est pas, et s'arrete au coup d'avant.
  const joue = m !== undefined && word === m.word && dir === m.dir && gx === m.x && gy === m.y;
  const borne = m === undefined ? Infinity : joue ? m.n : m.n - 1;
  const main = [...(m?.rack ?? "")];
  const out: boolean[] = [];
  for (let i = 0; i < word.length; i++) {
    const x = dir === "H" ? gx + i : gx;
    const y = dir === "V" ? gy + i : gy;
    const q = tiles.find((c) => c.x === x && c.y === y && c.n <= borne && c.l === word[i]);
    if (q !== undefined) { out.push(q.b === 1); continue; }
    const j = main.indexOf(word[i]!);
    if (j !== -1) { main.splice(j, 1); out.push(false); continue; }
    const k = main.indexOf(BLANK);
    if (k !== -1) main.splice(k, 1);
    out.push(k !== -1);
  }
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

  // LE CARAMEL COUVRE SA CASE ENTIEREMENT. Un pixel de jeu laissait passer la
  // couleur de la prime tout autour de chaque lettre : sur une grille dense,
  // cela faisait un lisere rouge ou bleu autour de chaque mot, qu'on prenait
  // pour une decoration. Ce qui est sous un caramel n'a plus a se voir -- le
  // rejeu sait deja retirer un mot pour montrer ce qu'il y avait dessous.
  const gap = 0;
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
    const v = blank ? 0 : valeurDe(cfg, letter);
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
    ink: string, trait: number, orgX: number, orgY: number,
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
    // Le trait du dernier top est plus epais : trace a l'INTERIEUR du chemin,
    // il ne mord pas sur les cases voisines et ne cree donc pas de couture.
    g.lineWidth = trait; g.strokeStyle = edge; g.stroke();

    // La lettre est dessinee A TOUTE ECHELLE. Meme reduite a une tache, elle
    // fait la difference entre une grille de jeu et un damier de couleurs :
    // c'est ce qu'on regarde quand on prend du recul sur une partie. Son cout
    // est paye a la construction de l'image de cote, pas a chaque deplacement.
    const hMoy = cell - gap * 2;
    // LA PLACE QUE LE CHIFFRE NE PREND PAS REVIENT A LA LETTRE. En dessous de
    // dix-huit pixels la valeur n'est pas tracee -- le coin bas du caramel est
    // libre, et la lettre peut s'y etendre, centree. C'est un ou deux pixels de
    // haut gagnes sur des lettres qui en font six : au dezoom, cela compte.
    const serre = hMoy < 18;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = `700 ${Math.max(2, Math.round(hMoy * (serre ? .74 : .62)))}px Archivo, system-ui, sans-serif`;
    for (const q of lot) {
      const px = X(q.x) + gap, py = Y(q.y) + gap;
      const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
      g.fillStyle = ink;
      g.fillText(q.l, px + w / 2, py + h * (serre ? .5 : .53));
    }
    // La valeur du caramel, seulement quand elle tient : sous dix-huit pixels
    // de haut, le chiffre est un point gris qui n'apprend rien.
    if (hMoy < 18) return;
    g.font = `500 ${Math.round(hMoy * .27)}px "IBM Plex Mono", monospace`;
    g.textAlign = "right";
    for (const q of lot) {
      const px = X(q.x) + gap, py = Y(q.y) + gap;
      const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
      g.fillStyle = ink;
      g.globalAlpha = q.b === 1 ? .8 : .6;
      g.fillText(String(q.b === 1 ? 0 : valeurDe(cfg, q.l)), px + w - w * .1, py + h * .84);
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
  // LE DERNIER TOP SE VOIT, ET C'EST LE MOT ENTIER QU'ON MONTRE.
  //
  // On ne soulignait que les caramels POSES : un mot de huit lettres accroche a
  // trois lettres deja la n'en montrait que cinq, eparpillees, et la table ne
  // voyait pas ou le coup avait ete joue. Ce qu'on cherche des yeux, c'est le
  // MOT -- il se lit d'un bloc ou pas du tout.
  const hl = new Set<string>();
  if (rejeu === null && last !== null) {
    const { dx, dy } = step(last.dir);
    for (let i = 0; i < last.word.length; i++) {
      hl.add(`${last.x + dx * i},${last.y + dy * i}`);
    }
  }
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
    const groupes = new Map<string, { face: string; edge: string; ink: string; trait: number; t: Tile[] }>();
    for (const q of tiles) {
      if (q.n > jusqua) continue;
      if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) continue;
      const face = q.b === 1 ? C.jface : C.face;
      // Le dernier top porte la couleur d'accent PARTOUT : contour, lettre et
      // valeur. Un simple lisere ne suffisait pas a le distinguer sur une
      // grille dense ; c'est l'encre qui se lit de loin.
      const marque = hl.has(`${q.x},${q.y}`);
      const edge = marque ? C.accent : q.b === 1 ? C.jedge : C.edge;
      const ink = marque ? C.accent : q.b === 1 ? C.jedge : C.ink;
      const trait = marque ? 2 : 1;
      const k = `${face}|${edge}|${ink}|${trait}`;
      const l = groupes.get(k);
      if (l === undefined) groupes.set(k, { face, edge, ink, trait, t: [q] }); else l.t.push(q);
    }
    g.save();
    g.beginPath(); g.rect(rx, ry, rw, rh); g.clip();
    if (effacer) g.clearRect(rx, ry, rw, rh);
    peindreLeFond(g, orgX, orgY, rx, ry, rw, rh);
    for (const l of groupes.values()) caramels(g, l.t, l.face, l.edge, l.ink, l.trait, orgX, orgY);
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
    const { word, dir, x: gx, y: gy, jokers } = ghost;
    for (let i = 0; i < word.length; i++) {
      const x = dir === "H" ? gx + i : gx;
      const y = dir === "V" ? gy + i : gy;
      if (x < gx0 || x > gx1 || y < gy0 || y > gy1) continue;
      caramel(x, y, word[i]!, jokers[i] === true, C.gface, C.gedge, C.gink);
    }
  }

  // Le curseur et les cases partagees appartiennent a CELUI QUI REGARDE, pas a
  // la position : une image qui les emporte montre le carre noir et la fleche
  // de son auteur a tous ceux a qui il l'envoie.
  for (const m of exportEnCours ? [] : marks) {
    if (m.x < gx0 || m.x > gx1 || m.y < gy0 || m.y > gy1) continue;
    ctx.strokeStyle = C.mark; ctx.lineWidth = 2;
    ctx.strokeRect(eX(m.x) + 1, eY(m.y) + 1, eX(m.x + 1) - eX(m.x) - 2, eY(m.y + 1) - eY(m.y) - 2);
  }

  const nf = nextFree();
  if (cursor !== null && nf !== null && !exportEnCours) {
    const px = eX(nf.x), py = eY(nf.y);
    const w = eX(nf.x + 1) - px, h = eY(nf.y + 1) - py;
    ctx.strokeStyle = C.cursor; ctx.lineWidth = 1;
    ctx.strokeRect(px + 1.5, py + 1.5, w - 3, h - 3);
    ctx.fillStyle = C.cursor;
    ctx.beginPath();
    // La pointe montre OU IRA LA PROCHAINE LETTRE. C'est la seule chose qui
    // distingue a l'oeil un curseur qui avance d'un curseur qui recule, et
    // sans elle on tape trois lettres avant de s'apercevoir du sens.
    const m = w * .22;
    const { dx, dy } = pasDuCurseur();
    if (dx !== 0) {
      const bx = dx > 0 ? px + w - 3 : px + 3;
      ctx.moveTo(bx, py + h / 2);
      ctx.lineTo(bx - m * dx, py + h / 2 - m / 1.6);
      ctx.lineTo(bx - m * dx, py + h / 2 + m / 1.6);
    } else {
      const by = dy > 0 ? py + h - 3 : py + 3;
      ctx.moveTo(px + w / 2, by);
      ctx.lineTo(px + w / 2 - m / 1.6, by - m * dy);
      ctx.lineTo(px + w / 2 + m / 1.6, by - m * dy);
    }
    ctx.closePath(); ctx.fill();
  }

  // LE BORD DU PLATEAU, D'UNE SEULE EPAISSEUR ET SANS LISIERE.
  //
  // Un trait centre sur le contour laissait un cheveu clair entre lui et les
  // cases : le fond du plateau s'arrondit au pixel de MISE EN PAGE, les cases
  // au pixel D'ECRAN, et les deux ne tombent pas au meme endroit des que
  // l'affichage n'est pas a 100 %. Quatre bandes pleines, a coordonnees
  // entieres, qui MORDENT d'un pixel sur les cases : plus rien ne peut passer
  // entre les deux, et l'epaisseur est la meme des quatre cotes par
  // construction.
  //
  // Trace en DERNIER, apres les caramels : un caramel de bord le recouvrait.
  if (b !== null) {
    const E = 3;
    const x0 = eX(-b), y0 = eY(-b), x1 = eX(b + 1), y1 = eY(b + 1);
    ctx.fillStyle = C.bord;
    ctx.fillRect(x0 - E, y0 - E, x1 - x0 + E * 2, E + 1);
    ctx.fillRect(x0 - E, y1 - 1, x1 - x0 + E * 2, E + 1);
    ctx.fillRect(x0 - E, y0 - E, E + 1, y1 - y0 + E * 2);
    ctx.fillRect(x1 - 1, y0 - E, E + 1, y1 - y0 + E * 2);
  }

  drawRulers(C, gx0, gx1, gy0, gy1);
}

/**
 * Regle graduee sur les deux bords, facon tableur. On lit la position d'un mot
 * sans compter les cases -- indispensable pour se reperer a l'oral ou dans le
 * chat, sur une grille qui n'a ni centre ni bord.
 */
/**
 * Les reperes d'un PLATEAU BORNE, colles au plateau.
 *
 * Sur une grille infinie, les reperes doivent rester epingles au bord du
 * canevas : la grille defile sous eux, et une etiquette qui suivrait le plateau
 * sortirait de l'ecran. Un plateau borne, lui, ne bouge pas -- ses reperes
 * n'ont donc aucune raison de vivre a l'autre bout du canevas, loin de la case
 * qu'ils nomment. C'est ainsi que le font les jeux de societe et les logiciels
 * du genre, et cela se lit bien mieux.
 *
 * EN HAUT ET A GAUCHE SEULEMENT. Un plateau de bois les repete des quatre cotes
 * parce qu'on tourne autour ; ici on clique la case, et elle se nomme d'
 * elle-meme.
 */
function reglesCollees(
  C: Record<string, string>, b: number,
  mark: { x0: number; y0: number } | null,
  dernier: { x: number; y: number } | null,
): void {
  const R = REGLE_BORNEE;
  const g0x = ox - b * cell, g0y = oy - b * cell;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // On lit ces reperes d'un bout a l'autre de la piece, comme les caramels.
  ctx.font = `600 ${Math.max(11, Math.min(17, Math.round(cell * .46)))}px Archivo, system-ui, sans-serif`;

  for (let x = -b; x <= b; x++) {
    const on = mark !== null && mark.x0 === x;
    const passe = !on && dernier !== null && dernier.x === x;
    const cx = ox + x * cell + cell / 2, cy = g0y - R / 2;
    if (on) {
      ctx.fillStyle = C.abg!;
      ctx.fillRect(ox + x * cell + 1, g0y - R + 1, cell - 2, R - 3);
    }
    ctx.fillStyle = on ? C.accent! : passe ? C.mark! : C.faint!;
    ctx.fillText(nomColonne(x, b), cx, cy);
  }
  for (let y = -b; y <= b; y++) {
    const on = mark !== null && mark.y0 === y;
    const passe = !on && dernier !== null && dernier.y === y;
    const cx = g0x - R / 2, cy = oy + y * cell + cell / 2;
    if (on) {
      ctx.fillStyle = C.abg!;
      ctx.fillRect(g0x - R + 1, oy + y * cell + 1, R - 3, cell - 2);
    }
    ctx.fillStyle = on ? C.accent! : passe ? C.mark! : C.faint!;
    ctx.fillText(nomLigne(y, b), cx, cy);
  }
}

function drawRulers(C: Record<string, string>, gx0: number, gx1: number, gy0: number, gy1: number) {
  const bornes = cfg.bornes;
  const TOP = 17, LEFT = 30;
  // LES BANDES NE SERVENT QU'A LA GRILLE INFINIE. Ce sont elles qui portent ses
  // reperes, epingles au bord pendant que la grille defile dessous. Un plateau
  // borne a les siens colles a lui : les bandes n'y contenaient plus rien, deux
  // bandeaux gris qui mangeaient la place sans rien dire.
  if (bornes === null) {
    ctx.fillStyle = C.panel!;
    ctx.fillRect(0, 0, W, TOP);
    ctx.fillRect(0, 0, LEFT, H);
  }

  // Une seule case signalee : celle du DEPART du mot. Souligner toute son
  // etendue allumait toute une rangee de numeros -- et c'est bien la case de
  // depart que la notation nomme, « H ligne,colonne ».
  const depart = ghost !== null
    ? { x: ghost.x, y: ghost.y }
    : cursor !== null ? { x: cursor.x, y: cursor.y } : null;
  const mark = depart === null ? null
    : { x0: depart.x, y0: depart.y, x1: depart.x, y1: depart.y };
  // LE DERNIER TOP MARQUE SA LIGNE ET SA COLONNE, plus discretement. Le coup
  // vient d'etre pose, souvent loin de l'ecran ou l'on cherchait : sa place se
  // lit alors sur les regles, sans avoir a le suivre des yeux sur la grille.
  // Ce qu'on DESIGNE l'emporte : quand on a un curseur, c'est lui qu'on suit.
  const dernier = rejeu === null && last !== null ? { x: last.x, y: last.y } : null;
  if (bornes !== null) { reglesCollees(C, bornes, mark, dernier); return; }
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

  // Sur la grille infinie, les coordonnees s'allongent en s'eloignant de
  // l'origine : « -1204 » prend le double de place que « 4 ». Espacer d'une
  // constante faisait donc empieter les nombres au dezoom. On mesure.
  const chiffres = String(Math.max(Math.abs(gx0), Math.abs(gx1), Math.abs(gy0), Math.abs(gy1))).length;
  const largeurTexte = chiffres * 6.2 + 12;
  const stepBy = bornes !== null ? 1 : Math.max(1, Math.ceil(largeurTexte / cell));
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // LE REPERE DE LA CASE DESIGNEE PASSE AVANT LA GRADUATION.
  //
  // Loin de l'origine, « -186 » tombait sur le « -180 » de l'echelle : deux
  // nombres imprimes l'un sur l'autre, et plus moyen de lire ni la coordonnee
  // qu'on vient de demander, ni la graduation. Celle qu'on demande gagne -- la
  // graduation, elle, se retrouve deux crans plus loin, et l'echelle garde son
  // pas.
  const texteX = (x: number): string => bornes === null ? String(x) : String(x + bornes + 1);
  // La ligne monte quand son numero grandit : voir `formatMove`.
  const texteY = (y: number): string =>
    bornes === null ? String(-y) : String.fromCharCode(65 + y + bornes);

  const pxMarque = mark === null ? null : ox + mark.x0 * cell + cell / 2;
  const demiMarqueX = mark === null ? 0 : ctx.measureText(texteX(mark.x0)).width / 2;
  const pyMarque = mark === null ? null : oy + mark.y0 * cell + cell / 2;

  for (let x = gx0; x <= gx1; x++) {
    const on = mark !== null && x >= mark.x0 && x <= mark.x1;
    if (!on && x % stepBy !== 0) continue;
    const px = ox + x * cell + cell / 2;
    if (px < LEFT + 9 || px > W - 4) continue;
    if (bornes !== null && (x < -bornes || x > bornes)) continue;
    const texte = texteX(x);
    if (!on && pxMarque !== null
        && Math.abs(px - pxMarque) < demiMarqueX + ctx.measureText(texte).width / 2 + 3) continue;
    ctx.fillStyle = on ? C.dark!
      : dernier !== null && dernier.x === x ? C.mark! : C.faint!;
    ctx.fillText(texte, px, TOP / 2);
  }
  for (let y = gy0; y <= gy1; y++) {
    const on = mark !== null && y >= mark.y0 && y <= mark.y1;
    if (!on && y % stepBy !== 0) continue;
    const py = oy + y * cell + cell / 2;
    if (py < TOP + 7 || py > H - 4) continue;
    if (bornes !== null && (y < -bornes || y > bornes)) continue;
    // Les chiffres font dix pixels de haut : en deca, ils se chevauchent.
    if (!on && pyMarque !== null && Math.abs(py - pyMarque) < 12) continue;
    ctx.fillStyle = on ? C.dark!
      : dernier !== null && dernier.y === y ? C.mark! : C.faint!;
    ctx.fillText(texteY(y), LEFT / 2, py);
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
  // UN PLATEAU BORNE N'A PAS BESOIN DE MARGE : il n'y a rien au-dela de ses
  // bords, et une rangee de cases vides tout autour ne fait qu'eloigner la
  // grille de son cadre. Les reperes, eux, restent -- ce sont eux qui nomment
  // les cases.
  const marge = cfg.jouables + 1;
  const x0 = b !== null ? -b : (vide ? -8 : ex0 - marge);
  const x1 = b !== null ? b : (vide ? 8 : ex1 + marge);
  const y0 = b !== null ? -b : (vide ? -8 : ey0 - marge);
  const y1 = b !== null ? b : (vide ? 8 : ey1 + marge);
  const cases = { l: x1 - x0 + 1, h: y1 - y0 + 1 };

  // CE PLAFOND EST CE QUI DECIDE DE LA LISIBILITE DES LETTRES.
  //
  // La taille d'une case se deduit du plafond divise par le cote de la grille,
  // et la lettre fait les deux tiers de la case. Sur une grille de 518 cases de
  // cote -- onze mille coups joues -- le plafond ordinaire donne des cases de
  // 10 pixels, donc des lettres de 6 : on les devine, on ne les lit pas.
  //
  // Le plafond n'est pas une prudence excessive : un canevas se developpe a
  // quatre octets le pixel, et il faut ensuite l'encoder. Trente-six millions de
  // pixels pesent deja 144 Mo. La haute definition triple ce budget -- elle est
  // donc un CHOIX, pas la valeur par defaut, et elle peut echouer sur une
  // machine peu pourvue.
  const COTE_MAX = prefs.imageHD ? 10_000 : 6000;
  const PIXELS_MAX = prefs.imageHD ? 100e6 : 36e6;
  let taille = Math.min(48, Math.floor(COTE_MAX / Math.max(cases.l, cases.h)));
  taille = Math.max(6, taille);
  while (cases.l * taille * cases.h * taille > PIXELS_MAX && taille > 6) taille--;

  // La place des reperes : collee au plateau sur une grille bornee, la bande du
  // bord de l'ecran sur une grille infinie -- comme a l'ecran.
  const REGLE = b !== null
    ? { x: REGLE_BORNEE + 3, y: REGLE_BORNEE + 3 }
    : { x: 30, y: 17 };
  // Le bandeau du tirage, quand il y en a un. Ses caramels sont plus grands que
  // ceux de la grille : c'est ce qu'on lit en premier.
  const tailleTirage = Math.max(28, Math.min(64, Math.round(cases.l * taille / 26)));
  // Le tirage se pose JUSTE AU-DESSUS de la grille sur un plateau borne : le
  // bandeau ne fait plus que la hauteur des caramels et un peu d'air.
  const BANDEAU = tirage.length === 0 ? 0
    : Math.round(tailleTirage * (b === null ? 1.9 : 1.35));
  // TRES PEU D'AIR, MAIS PAS ZERO : le cadre du plateau borde ses cases par
  // l'exterieur, et sans ces quelques pixels il serait coupe net a droite et en
  // bas. C'est la seule marge qui reste sur un plateau borne.
  const AIR = b === null ? 0 : 6;
  const largeur = Math.round(cases.l * taille) + REGLE.x + AIR;
  const hauteur = Math.round(cases.h * taille) + REGLE.y + BANDEAU + AIR;

  const hors = document.createElement("canvas");
  hors.width = largeur; hors.height = hauteur;
  // Le navigateur RABOTE en silence un canevas trop grand : on redemande sa
  // taille plutot que de produire une image vide sans savoir pourquoi.
  if (hors.width !== largeur || hors.height !== hauteur) {
    flash(`image trop grande pour ce navigateur · ${largeur} × ${hauteur} px`, "bad");
    return;
  }
  const g = hors.getContext("2d");
  if (g === null) { flash("l'image n'a pas pu être produite", "bad"); return; }

  // UN SEUL CANEVAS, PAS DEUX.
  //
  // La grille se dessinait sur le sien pour etre reportee ensuite sous le
  // bandeau -- deux images de la taille de la page, donc le double de memoire,
  // et c'est la memoire qui limite la finesse des lettres. Un decalage du repere
  // suffit : `draw()` peint comme si le bandeau n'existait pas, et ses numeros
  // de colonnes tombent juste dessous au lieu d'etre recouverts.
  const memoire = { ctx, W, H, ox, oy, cell, cle: cacheCle };
  bouton.disabled = true;
  try {
    ctx = g; W = largeur; H = hauteur - BANDEAU; cell = taille;
    ox = REGLE.x - x0 * taille; oy = REGLE.y - y0 * taille;
    exportEnCours = true;
    exportJusqua = coup === undefined ? null : coup - 1;
    g.save();
    g.translate(0, BANDEAU);
    ctx.fillStyle = css("--field");
    ctx.fillRect(0, 0, W, H);
    draw();
    g.restore();
  } finally {
    exportEnCours = false;
    exportJusqua = null;
    ctx = memoire.ctx; W = memoire.W; H = memoire.H;
    ox = memoire.ox; oy = memoire.oy; cell = memoire.cell;
    cacheCle = "";   // l'image de cote a servi a autre chose entre-temps
    bouton.disabled = false;
    draw();
  }

  // Le numero du coup n'a de sens que sur une grille SANS FIN, ou il situe
  // l'image dans une partie qui n'en finit pas. Sur un plateau borne, la grille
  // se lit d'un coup d'oeil et le numero n'apprend rien.
  if (tirage.length > 0) {
    dessinerLeTirage(g, tirage, largeur, BANDEAU, tailleTirage, b === null ? numero : null);
  }

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
  const mo = blob.size / 1e6;
  flash(`image enregistrée · ${largeur} × ${hauteur} px · ${mo.toFixed(1)} Mo`, "ok");
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
  largeur: number, hauteur: number, taille: number, coup: number | null,
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
    g.fillText(String(joker ? 0 : valeurDe(cfg, ch)), px + taille * .9, py + taille * .84);
    g.textAlign = "center"; g.globalAlpha = 1;
    px += taille + gap;
  }

  // Le numero du coup, discret, a gauche : de quoi retrouver la position.
  if (coup !== null) {
    g.fillStyle = css("--ink-faint");
    g.font = `500 ${Math.round(taille * .32)}px "IBM Plex Mono", monospace`;
    g.textAlign = "left"; g.textBaseline = "middle";
    g.fillText(`COUP ${coup}`, 14, hauteur / 2);
  }
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
  // ON DOIT TOUJOURS POUVOIR RECULER JUSQU'A VOIR TOUTE L'EMPRISE. Le plancher
  // etait a un pixel et demi par case : passe sept cents cases de haut -- ce
  // que la grille permanente atteint vers le vingt-deuxieme mille --, la faire
  // tenir en demandait moins, et le dezoom s'arretait avant d'y arriver. On ne
  // voyait plus l'ensemble de la chose que l'on construit.
  //
  // Le plancher absolu ne sert plus qu'a se garder d'une division par zero : il
  // faudrait quatre mille cases de cote pour l'atteindre.
  const tient = Math.min((W - REGLES) / largeur, (H - REGLES) / hauteur);
  return Math.max(.25, Math.min(12, tient));
}

function alreadyVisible(word: string, dir: Dir, x: number, y: number) {
  if (cell < 11) return false;
  const e = extentOf(word, dir, x, y);
  const m = 1.5;
  return ox + (e.x0 - m) * cell >= 0 && ox + (e.x1 + 1 + m) * cell <= W
      && oy + (e.y0 - m) * cell >= 0 && oy + (e.y1 + 1 + m) * cell <= H;
}

let anim = 0;
/** Ou le vol en cours doit arriver. Sert a l'interrompre proprement. */
let volCible: { cell: number; ox: number; oy: number } | null = null;

/**
 * Termine sur-le-champ le vol en cours, s'il y en a un.
 *
 * On l'appelle avant de lire la case sous le pointeur : pendant un vol, la
 * camera bouge d'une image a l'autre, si bien que la case visee au moment du
 * clic n'etait plus celle qu'on avait sous les yeux quand il s'affichait. En
 * rejeu, ou l'on clique une solution puis la grille, cela se traduisait par une
 * case selectionnee a cote.
 */
function finirLeVol(): void {
  if (anim === 0 || volCible === null) return;
  cancelAnimationFrame(anim);
  anim = 0;
  cell = volCible.cell; ox = volCible.ox; oy = volCible.oy;
  volCible = null;
  draw();
}

function flyTo(word: string, dir: Dir, x: number, y: number) {
  // RIEN NE VOLE SUR UN PLATEAU BORNE. Il est deja entier a l'ecran, et le
  // cadrage y est calcule une fois pour toutes. Partager une case du chat
  // appelait pourtant `flyTo` : la grille se dezoomait, et le zoom etant
  // desactive sur ce format, elle y restait.
  if (cfg.bornes !== null) { draw(); return; }
  const t = readableCell();
  const e = extentOf(word, dir, x, y);
  const to = { cell: t, ox: W / 2 - ((e.x0 + e.x1 + 1) / 2) * t, oy: H / 2 - ((e.y0 + e.y1 + 1) / 2) * t };
  if (anim) cancelAnimationFrame(anim);
  volCible = to;
  // La camera se POSE au lieu de voler : le trajet donne le mal de mer a
  // certains, et sur une grande grille il traverse des milliers de cases.
  if (!prefs.vols) { cell = to.cell; ox = to.ox; oy = to.oy; draw(); return; }
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
    if (anim === 0) volCible = null;
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
/**
 * L'ordre dans lequel le joueur a range son chevalet.
 *
 * DEPLACER SES LETTRES EST UNE FACON DE CHERCHER. On groupe les voyelles, on
 * met le S au bout, on essaie une terminaison -- c'est le geste de tout joueur
 * devant un chevalet de bois, et il ne sert a rien s'il ne survit pas a la
 * premiere lettre tapee.
 *
 * L'arrangement porte donc sur le tirage ENTIER, pas sur ce qui reste en main :
 * on retire les lettres posees en gardant l'ordre des autres, et une lettre
 * reprise revient a sa place. Il se defait au coup suivant, avec le tirage
 * auquel il appartenait.
 */
let ordreChevalet: string[] = [];
/** Le tirage auquel cet arrangement se rapporte. */
let ordrePour = "";

function selonLeChevalet(restant: readonly string[]): string[] {
  if (rack !== ordrePour) { ordrePour = rack; ordreChevalet = [...rack]; }
  const reste = [...restant];
  const out: string[] = [];
  for (const c of ordreChevalet) {
    const i = reste.indexOf(c);
    if (i !== -1) { out.push(c); reste.splice(i, 1); }
  }
  // Ce que l'arrangement ne connait pas -- il ne devrait rien rester -- va au
  // bout plutot que de disparaitre.
  return [...out, ...reste];
}

/** A-t-on des lettres sur la grille ? Sert a savoir quand elles reviennent. */
let lettresDehors = false;

/**
 * Range le chevalet dans l'ordre du tirage.
 *
 * C'est l'ordre que le serveur envoie -- alphabetique, jokers en tete -- et
 * celui dans lequel on retrouve ses lettres sans avoir a les chercher.
 */
function rangerLeChevalet(): void {
  ordrePour = rack;
  ordreChevalet = [...rack];
  paintRack();
}

function paintRack() {
  const ici = rejeu;
  if (ici !== null) {
    const m = history.find((q) => q.n === ici.n);
    peindreCaramels(m === undefined ? [] : [...m.rack]);
    return;
  }
  // LES LETTRES REVIENNENT EN ORDRE. On range son chevalet pour chercher, on
  // pose un mot, et ce qui revient en main n'a plus de raison de garder
  // l'arrangement d'avant : c'etait celui d'une idee qu'on vient d'essayer.
  // L'arrangement TIENT pendant la frappe -- le voir se defaire lettre apres
  // lettre serait insupportable -- et se defait quand la main est rendue.
  if (typed !== "") lettresDehors = true;
  else if (lettresDehors) {
    lettresDehors = false;
    ordrePour = rack;
    ordreChevalet = [...rack];
  }
  peindreCaramels(selonLeChevalet(remaining()));
}

/** Ce qu'un caramel ne depassera jamais, et ce en dessous de quoi il ne descend pas. */
const CARAMEL_MAX = 64, CARAMEL_MIN = 30, CARAMEL_ECART = 5;

/**
 * LA TAILLE D'UN CARAMEL NE DEPEND QUE DE LA VARIANTE, JAMAIS DE CE QU'IL RESTE
 * EN MAIN.
 *
 * Elle se decidait au nombre de lettres AFFICHEES. Taper un mot en retirait du
 * chevalet, les autres grossissaient, la barre grandissait -- et la grille
 * descendait d'autant, en plein milieu d'une recherche. Poser ses sept lettres
 * vidait la rangee et faisait tout remonter. C'est ce sursaut que la table
 * voyait depuis des semaines.
 *
 * La rangee peut aller jusqu'a la largeur de la grille : c'est la limite que
 * l'oeil accepte -- des caramels plus larges que le plateau qu'ils servent
 * n'auraient plus l'air d'un chevalet.
 */
function tailleDuCaramel(dispo: number): number {
  const n = Math.max(1, cfg.tirage);
  const tient = Math.floor((dispo - (n - 1) * CARAMEL_ECART) / n);
  return Math.max(CARAMEL_MIN, Math.min(CARAMEL_MAX, tient));
}

/**
 * Cale la barre du chevalet une fois pour toutes.
 *
 * La hauteur est celle d'un caramel, POSEE MEME QUAND LA RANGEE EST VIDE :
 * sinon la barre se retracte a la hauteur des compteurs des qu'on a tout pose,
 * et la grille remonte. C'est le second sursaut.
 *
 * LES CARAMELS SE CENTRENT SUR LA GRILLE, pas sur la barre. La barre porte des
 * compteurs de largeurs inegales de chaque cote ; centrer la rangee dans ce qui
 * reste la posait a cote du plateau qu'elle sert. On la centre donc sur le
 * canevas lui-meme.
 */
function calerLeChevalet(): void {
  const box = $("rb-tiles");
  // La place disponible ne depend PAS des caramels : la rangee est un `flex: 1`
  // entre les compteurs, elle prend ce qui reste quoi qu'elle contienne. On
  // peut donc la mesurer avant de decider de leur taille.
  const dispo = box.clientWidth;
  if (dispo === 0) return;
  const taille = tailleDuCaramel(dispo);
  box.style.setProperty("--t", `${taille}px`);
  // Le decalage qui amene la rangee au-dessus du MILIEU DE LA GRILLE. Il est
  // borne par la place libre de chaque cote : une rangee de quinze caramels
  // remplit deja la barre, et la pousser plus loin la ferait passer sous les
  // compteurs.
  const rangee = cfg.tirage * taille + (cfg.tirage - 1) * CARAMEL_ECART;
  const cv = $("cv").getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const jeu = Math.max(0, (dispo - rangee) / 2);
  // ON MESURE LA RANGEE COMME SI ELLE N'AVAIT PAS BOUGE. Sa position lue a
  // l'ecran comprend deja le decalage qu'on lui a pose : recalculer sans le
  // retrancher trouvait la rangee bien placee, remettait donc zero, et la
  // rangee sautait a sa place d'origine. C'est ce qu'on voyait a chaque Ctrl+A,
  // qui repeint le chevalet -- et une fois sur deux seulement, puisque les deux
  // etats alternaient.
  const pose = parseFloat(box.style.getPropertyValue("--decalage")) || 0;
  const vise = (cv.left + cv.width / 2) - (b.left + b.width / 2 - pose);
  box.style.setProperty("--decalage", `${Math.round(Math.max(-jeu, Math.min(jeu, vise)))}px`);
}

function peindreCaramels(lettres: readonly string[]): void {
  const box = $("rb-tiles");
  calerLeChevalet();
  box.replaceChildren();
  // LA PARTIE CLOSE LE DIT LA OU L'ON REGARDE. La place du chevalet reste vide
  // -- il n'y a plus de lettres -- et c'est le premier endroit ou l'oeil va
  // chercher ce qu'il faut jouer. Autant y mettre la reponse.
  if (finie && rejeu === null && lettres.length === 0) {
    const fin = document.createElement("button");
    fin.type = "button";
    fin.className = "chevalet-fin";
    fin.innerHTML = `<b>Partie terminée</b>` +
      `<span>Feuille de route <i>(Ctrl+R)</i></span>`;
    fin.addEventListener("click", ouvrirLaRoute);
    box.appendChild(fin);
    return;
  }
  for (const ch of lettres) {
    const el = document.createElement("div");
    const joker = ch === BLANK;
    el.className = "caramel" + (joker ? " joker" : "");
    el.textContent = joker ? "?" : ch;
    if (!joker) {
      const v = valeurDe(cfg, ch);
      if (v) { const s = document.createElement("i"); s.textContent = String(v); el.appendChild(s); }
    }
    el.dataset["l"] = ch;
    box.appendChild(el);
  }
}

/**
 * Prendre un caramel et le poser ailleurs sur le chevalet.
 *
 * LE CARAMEL SUIT LE DOIGT. Il ne change pas de place dans la rangee tant qu'on
 * le tient : on le DEPLACE, sous le curseur, et ce sont les autres qui
 * s'ecartent pour lui faire une place -- comme une main qui pousse une piece de
 * bois entre deux autres. Echanger deux lettres a l'instant ou l'on franchit un
 * milieu donnait un sautillement dont on ne comprenait ni la cause ni la regle.
 *
 * Ne change rien a la partie : le chevalet est un aide-memoire, on joue en
 * tapant. C'est aussi pourquoi on n'y touche pas pendant le rejeu, ou le tirage
 * montre est celui d'un coup passe.
 *
 * Aucune image a fabriquer : un caramel n'est qu'une boite avec une bordure.
 */
$("rb-tiles").addEventListener("pointerdown", (e) => {
  const ev = e as PointerEvent;
  if (rejeu !== null || ev.button !== 0) return;
  const el = (ev.target as HTMLElement).closest(".caramel") as HTMLElement | null;
  if (el === null) return;
  const box = $("rb-tiles");
  const rangee = [...box.children] as HTMLElement[];
  const depart = rangee.indexOf(el);
  if (depart === -1) return;

  // Le pas d'une place : la largeur d'un caramel et l'ecart qui le suit. On le
  // mesure sur la rangee plutot que de le supposer -- la taille des caramels
  // s'adapte au nombre de lettres.
  const large = el.getBoundingClientRect().width;
  const pas = rangee.length > 1
    ? rangee[1]!.getBoundingClientRect().left - rangee[0]!.getBoundingClientRect().left
    : large;

  ev.preventDefault();
  el.setPointerCapture(ev.pointerId);
  el.classList.add("tire");
  box.classList.add("range");
  let bouge = false;
  let cible = depart;

  const glisser = (m: PointerEvent) => {
    const dx = m.clientX - ev.clientX;
    if (!bouge && Math.abs(dx) < 3) return;
    bouge = true;
    // Le caramel tenu suit le doigt, sans contrainte : c'est lui qu'on regarde.
    el.style.transform = `translateX(${dx}px)`;
    // Sa place VISEE se deduit du chemin parcouru, arrondie au plus proche.
    cible = Math.max(0, Math.min(rangee.length - 1, depart + Math.round(dx / pas)));
    // Les autres s'ecartent d'une place, dans le sens ou le trou se creuse.
    for (let i = 0; i < rangee.length; i++) {
      if (i === depart) continue;
      const decale = cible > depart && i > depart && i <= cible ? -pas
        : cible < depart && i >= cible && i < depart ? pas
        : 0;
      rangee[i]!.style.transform = decale === 0 ? "" : `translateX(${decale}px)`;
    }
  };
  const lacher = () => {
    el.removeEventListener("pointermove", glisser);
    el.removeEventListener("pointerup", lacher);
    el.removeEventListener("pointercancel", lacher);
    el.classList.remove("tire");
    box.classList.remove("range");
    for (const c of rangee) c.style.transform = "";
    if (!bouge || cible === depart) return;
    // L'arrangement porte sur le tirage entier : ce qui est pose sur la grille
    // n'est pas affiche, mais garde sa place pour quand on le reprendra.
    const montres = rangee.map((c) => c.dataset["l"] ?? "");
    const [pris] = montres.splice(depart, 1);
    montres.splice(cible, 0, pris ?? "");
    const caches = [...ordreChevalet];
    for (const c of montres) {
      const i = caches.indexOf(c);
      if (i !== -1) caches.splice(i, 1);
    }
    ordreChevalet = [...montres, ...caches];
    paintRack();
  };
  el.addEventListener("pointermove", glisser);
  el.addEventListener("pointerup", lacher);
  el.addEventListener("pointercancel", lacher);
});

/**
 * Un temps ENREGISTRE : celui qu'a mis un joueur pour trouver un coup.
 *
 * Au centieme sous la minute. Ce n'est pas ce qu'on affiche pendant qu'on
 * joue -- un chrono qui defile au centieme est une source d'angoisse, pas
 * d'information -- mais une performance se note precisement.
 */
/**
 * Une duree qui TOURNE, arrondie a la seconde.
 *
 * Les centiemes ont leur place dans la feuille de route, ou l'on compare des
 * performances figees : « 0,51 s » contre « 0,64 s » dit quelque chose. Sur un
 * compteur qui avance, ils ne disent rien -- deux chiffres qui defilent trop
 * vite pour etre lus, et qui font clignoter toute la ligne. La partie
 * enregistre toujours les centiemes ; c'est l'affichage qui les laisse.
 */
function fmtSecondes(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} j ${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")} h`;
}

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

  const canon = coupCanonique();
  if (cursor !== null && typed.length > 0 && canon !== null) {
    const r = resolveTypedWord(board, dict, canon.dir, canon.x, canon.y, canon.typed, rack, false, true);
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

  // LE VERDICT DU COUP QUI VIENT DE TOMBER.
  //
  // Entre deux coups, cette zone montrait un tiret -- et c'est precisement le
  // moment ou l'on veut savoir ce qu'on vient de faire. On y lit donc « TOP »
  // si on l'a trouve, sinon l'ecart, avec le mot qu'on avait propose. Cela
  // s'efface a la premiere lettre tapee : la zone redevient celle du mot en
  // cours.
  const verdict = monVerdict();
  if (verdict !== null) {
    if (verdict.top) {
      w.className = "word trouve";
      w.innerHTML = `<span class="topmot">TOP</span><span class="pts">${verdict.score}</span>`;
      meta.textContent = `${verdict.mot} · vous avez trouvé le top`;
      return;
    }
    w.className = "word";
    w.innerHTML = `<span>${verdict.mot}</span><span class="pts rate">−${verdict.ecart}</span>`;
    meta.textContent = `${verdict.score} pts · −${verdict.ecart}`;
    return;
  }

  w.className = "word none";
  w.textContent = "—";
  meta.textContent = "";
}

/**
 * Ce que VOUS avez fait du dernier coup joue : le top, ou de combien vous
 * l'avez manque.
 *
 * Rend `null` quand vous n'avez rien propose sur ce coup -- il n'y a alors
 * rien a dire, et surtout rien a reprocher.
 */
function monVerdict(): { top: boolean; mot: string; score: number; ecart: number } | null {
  if (rejeu !== null || last === null || me === "") return null;
  const gagne = duplicate ? (last.trouveurs ?? []).includes(me) : last.player === me;
  const sien = last.propositions?.[me];
  if (gagne) {
    return { top: true, mot: sien?.word ?? last.word, score: last.score, ecart: 0 };
  }
  if (sien === undefined) return null;
  return { top: false, mot: sien.word, score: sien.score, ecart: last.score - sien.score };
}

function paintSide() {
  // Le numero du coup suivant s'affiche MEME pendant le calcul : le faire
  // disparaitre le temps d'un solveur lent donne l'impression d'un jeu casse.
  // PARTIE CLOSE, ON MONTRE OU ELLE S'EST ARRETEE. Un duplicate qui se termine
  // au onzieme coup affiche « 11 » : le tiret effacait le compte au moment
  // precis ou tout le monde le regardait.
  $("rb-move").textContent = rejeu !== null ? String(rejeu.n)
    : finie ? (coupsMax === null ? String(moveNumber) : `${moveNumber} / ${coupsMax}`)
    : !demarree ? "—"
    : coupsMax === null ? String(moveNumber + 1)
    : `${moveNumber + 1} / ${coupsMax}`;
  // LE CHEVALET SUIT L'ECRAN, DANS LES DEUX SENS. Il n'etait repeint qu'en
  // ENTRANT dans le rejeu : en sortir laissait donc le tirage du coup examine
  // affiche par-dessus la partie en cours, jusqu'au prochain etat recu. Sur une
  // partie close on ne le voyait pas -- il n'en arrive plus. Sur une grille
  // vivante, cela dure le temps d'un coup, et sur la grille permanente un coup
  // peut durer des heures.
  paintRack();
  // Une partie bornee dans le TEMPS montre ce qu'il lui reste a vivre.
  $("rb-reste-wrap").hidden = rejeu !== null || dureeMax === null || !demarree || finie;
  $("fin").hidden = !finie;
  // Le bouton ne s'affiche qu'a qui peut s'en servir : le gerant du salon, et
  // seulement sur une partie close qui n'est pas une grille permanente.
  $("rejouer-wrap").hidden = !finie || gerant !== me || permanent;

  // Rejouer n'a de sens qu'une fois la partie close : avant, ce serait donner
  // les reponses d'une partie en cours.
  $("rejeu-wrap").hidden = (!finie && !rejeuOuvert) || history.length === 0;
  // EN REJEU, LE CUMUL EST CELUI DU COUP QU'ON REGARDE. Montrer le total de la
  // partie a cote d'un coup du milieu ne dit rien de ce coup-la : ce qu'on veut
  // savoir, c'est ou en etait la grille a ce moment.
  const ici = rejeu;
  $("rb-cumul").textContent = (ici === null ? cumul
    : history.reduce((s, m) => m.n <= ici.n ? s + m.score : s, 0)).toLocaleString("fr");
  // Au duplicate, chacun a son propre total : on le montre a cote du cumul de
  // la grille, pour qu'il se compare d'un coup d'oeil.
  // VOTRE TOTAL, ET CE QUE VOUS AVEZ LAISSE EN CHEMIN.
  //
  // Le score dit ce qu'on a pris ; il vaut dans les deux modes, comme mesure de
  // ce qu'on a su trouver.
  const monScore = points[me] ?? 0, monNegatif = negatif[me] ?? 0;
  $("rb-score-wrap").hidden = rejeu !== null || monScore === 0 && monNegatif === 0;
  $("rb-score").textContent = String(monScore);
  // LE NEGATIF SE MESURE CONTRE SOI, PAS CONTRE LES AUTRES.
  //
  // Un negatif dit ce qu'on a laisse au top sur SA PROPRE FEUILLE. Il a donc du
  // sens partout ou l'on joue pour son compte :
  //
  // - au **duplicate**, ou chacun tient la sienne et marque a chaque coup :
  //   l'ecart cumule est precisement ce qui departage la table ;
  // - au **topping en solitaire** -- une partie du jour, un entrainement --,
  //   ou il est la seule mesure de ce qu'on a manque.
  //
  // Il n'en a plus des qu'on est PLUSIEURS EN TOPPING. La grille n'avance alors
  // que parce que quelqu'un a trouve le top, et sur une grille permanente c'est
  // la seule facon d'avancer : le travail est commun, celui qui l'emporte le
  // fait pour tout le monde, et ce que les autres avaient propose ne compte ni
  // contre eux ni pour eux. Un ecart personnel n'y mesure rien, et l'afficher
  // invite a lire une partie collective comme un classement individuel.
  //
  // « Plusieurs » se compte sur la partie entiere, pas sur les connectes du
  // moment : sur une grille permanente ouverte depuis des semaines, se retrouver
  // seul devant a trois heures du matin n'en fait pas une partie solitaire.
  const monde = new Set([...online, ...Object.keys(players), ...Object.keys(points)]);
  const enGroupe = !duplicate && monde.size > 1;
  $("rb-neg-wrap").hidden = rejeu !== null || enGroupe
    || (monScore === 0 && monNegatif === 0);
  $("rb-neg").textContent = monNegatif === 0 ? "Top" : `−${monNegatif}`;
  paintCurrent();

  const lw = $("last-word"), lm = $("last-meta"), ll = $("last-like");
  ll.replaceChildren();
  if (last === null) { lw.className = "word none"; lw.textContent = "—"; lm.textContent = ""; }
  else {
    // UN TOP QUE PERSONNE N'A TROUVE SE VOIT. Il ne se lisait que dans la ligne
    // du dessous, en petit, entre la notation et le chrono -- au milieu de ce
    // qui ne change pas d'un coup a l'autre. Or c'est la seule chose que la
    // table veut savoir : la grille vient de gagner un coup. C'est aussi ce qui
    // decide une tablee a recommencer la partie, ce qu'on ne fait pas a sa
    // place.
    const trouve = duplicate ? trouveursDuCoup(last).length > 0 : last.player !== null;
    lw.className = trouve ? "word" : "word rate";
    lw.innerHTML = `<span>${last.word}</span>`
      + (trouve ? "" : `<span class="rate">non trouvé</span>`)
      + `<span class="pts">${last.score}</span>`;
    // Au duplicate, mon ecart au top sur CE coup. Il reste affiche tant que le
     // coup suivant ne l'a pas remplace : c'est le temps qu'on a de le lire.
    const mien = duplicate ? last.scores?.[me] : undefined;
    const ecart = mien === undefined ? 0 : mien - last.score;
    lm.textContent = `${noteCoup(last.dir, last.x, last.y, cfg.bornes)} · ${quiLaTrouve(last, true)}` +
      (duplicate ? (ecart < 0 ? ` · ${ecart}` : "") : ` · ${fmtTime(last.ms)}`);
    ll.appendChild(likeButton(last));
  }

  const rank = $("rank");
  // Les colonnes du duplicate ne sont pas celles du topping : la classe le dit
  // a la feuille de style, qui fixe les largeurs en consequence.
  rank.classList.toggle("duplicate", duplicate);
  rank.replaceChildren();
  // CEUX QUI SONT LA Y FIGURENT, meme a zero. Disparaitre du tableau parce
  // qu'on n'a rien marque, c'est ne pas savoir si l'on joue.
  const presents = Object.fromEntries(online.map((nom) => [nom, 0]));
  const rows = duplicate
    ? Object.keys({ ...presents, ...players, ...points })
        .map((k) => [k, points[k] ?? 0] as [string, number])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    : Object.entries({ ...presents, ...players })
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // CE QUE PERSONNE N'A TROUVE CONCOURT AVEC LES JOUEURS. Cette ligne etait
  // epinglee en tete du tableau, hors classement, quel que soit son compte : on
  // ne voyait plus si la grille menait devant la table ou derriere elle. Elle
  // se range maintenant a sa place, et les colonnes font le nombre de coups.
  if (!duplicate && nonTrouves > 0) {
    rows.push([PERSONNE, nonTrouves]);
    rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  if (rows.length === 0) {
    const s = document.createElement("div");
    s.className = "none"; s.textContent = "personne encore";
    rank.appendChild(s);
  }

  // LE TOP CONCOURT, EN TETE ET HORS CLASSEMENT.
  //
  // Un score de duplicate ne dit rien tout seul : 1 240 points, est-ce bien ?
  // La reponse est dans le total des tops, qu'il fallait aller chercher dans le
  // cumul de la grille, a l'autre bout de l'ecran. On le pose ici, sur la meme
  // ligne de lecture que les joueurs, et la comparaison se fait sans bouger les
  // yeux. Son negatif, lui, n'a pas de case : il est nul par construction.
  if (duplicate && moveNumber > 0) {
    const tete = document.createElement("div");
    tete.className = "prow lehaut";
    tete.innerHTML = `<span class="tri"></span><span class="nom">Top</span>` +
      `<span class="tops">${moveNumber}</span><span class="likes"></span>` +
      `<span class="num">${cumul}</span>`;
    rank.appendChild(tete);
  }

  for (const [name, n] of rows) {
    if (name === PERSONNE) {
      // Pas un bouton : il n'y a aucune liste de coups a deplier derriere.
      const perdu = document.createElement("div");
      perdu.className = "prow perdu";
      perdu.innerHTML = `<span class="tri"></span>` +
        `<span class="nom">Non trouvé${n > 1 ? "s" : ""}</span>` +
        (duplicate ? `<span class="tops"></span>` : "") +
        `<span class="likes"></span>` +
        `<span class="num">${Number.isInteger(n) ? n : n.toFixed(1)}</span>`;
      rank.appendChild(perdu);
      continue;
    }
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
      ? `<span class="tops">${tops[name] ?? 0}</span>` +
        `<span class="likes">${neg === 0 ? "TOP" : "−" + neg}</span>` +
        `<span class="num">${points[name] ?? 0}</span>`
      : `<span class="likes"></span>` +
        `<span class="num">${Number.isInteger(n) ? n : n.toFixed(1)}</span>`;
    const marque = verifies.has(name) ? '<b class="verifie" title="joueur vérifié">✓</b>' : "";
    const vrai = nomsPublics[name];
    const infobulle = vrai === undefined ? "" : ` title="${vrai.replace(/"/g, "&quot;")}"`;
    // LE BOUTON NE PARAIT QU'UNE FOIS LA LIGNE DEROULEE. Sur chaque ligne, il
    // encombrait un classement qu'on lit en jouant ; deroule, on regarde deja
    // ce joueur-la.
    const profil = inscrits.has(name) && openPlayer === name
      ? '<button type="button" class="voir-profil" title="Voir le profil">profil</button>' : "";
    row.innerHTML = `<span class="tri">${openPlayer === name ? "▾" : "▸"}</span>` +
                    `<span class="nom"${infobulle}>${name}${marque}${coeurs}${profil}</span>` + droite;
    row.querySelector(".voir-profil")?.addEventListener("click", (e) => {
      // Le clic sur la ligne DEROULE les coups : celui-ci ne doit pas y monter.
      e.stopPropagation();
      void ouvrirLaFiche(name);
    });
    row.addEventListener("click", () => { openPlayer = openPlayer === name ? null : name; paintSide(); });
    rank.appendChild(row);

    if (openPlayer === name) {
      const list = document.createElement("div");
      list.className = "plist";
      // AU DIX-MILLIEME COUP, LE NUMERO NE TIENT PLUS DANS SA COLONNE. Elle
      // etait figee a trois chiffres : au-dela, le numero debordait sur le mot
      // et la ligne se repliait en deux. La colonne suit donc la partie.
      list.style.setProperty("--w-pn", largeurDesNumeros(6.6, 24));
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
            ghost = { word: sien.word, dir: sien.dir, x: sien.x, y: sien.y,
                      jokers: jokersDuMot(m, sien.word, sien.dir, sien.x, sien.y) };
            reveal(sien.word, sien.dir, sien.x, sien.y);
          });
        }
        r.appendChild(likeButton(m));
        list.appendChild(r);
      }
      rank.appendChild(list);
    }
  }

  const boiteEnLigne = $("online");
  boiteEnLigne.replaceChildren();
  if (online.length === 0) boiteEnLigne.textContent = "—";
  for (const [i, n] of online.entries()) {
    const e = document.createElement("span");
    e.textContent = verifies.has(n) ? `${n} ✓` : n;
    const vrai = nomsPublics[n];
    if (vrai !== undefined) e.title = vrai;
    if (inscrits.has(n)) {
      e.classList.add("fiche-ouvrable");
      e.addEventListener("click", () => { void ouvrirLaFiche(n); });
    }
    boiteEnLigne.appendChild(e);
    if (i < online.length - 1) boiteEnLigne.appendChild(document.createTextNode(", "));
  }
  majDesPoignees();
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
  ghost = { word: m.word, dir: m.dir, x: m.x, y: m.y,
            jokers: jokersDuMot(m, m.word, m.dir, m.x, m.y) };
  if (!$("roadmap").hidden) fermerLaRoute();
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
  recherche = null;
  peindreLOeil();
  $("rj-top").innerHTML = m === undefined ? "" :
    `<b>${m.word}</b> ${noteCoup(m.dir, m.x, m.y, cfg.bornes)} ` +
    `<span class="pts">${m.score} pts</span><br>` +
    `<span class="g">${m.notation ?? m.rack ?? ""}</span>`;
  const piste = $("rj-piste");
  piste.style.height = "";
  piste.replaceChildren();
  const deja = paliersRecus.get(borne);
  if (deja === undefined) {
    const attente = document.createElement("div");
    attente.className = "none";
    attente.style.padding = "10px 15px";
    attente.textContent = "chargement des solutions…";
    piste.appendChild(attente);
  }
  $("rj-sols").scrollTop = 0;
  $("rj-qui").hidden = true;
  ghost = m === undefined ? null
    : { word: m.word, dir: m.dir, x: m.x, y: m.y,
        jokers: jokersDuMot(m, m.word, m.dir, m.x, m.y) };
  // Le bandeau reprend le tirage de CE coup : on revoit le coup avec ce qu'on
  // avait en main pour le chercher.
  paintSide();
  // Deja vu : on l'affiche sans repasser par le serveur. Sinon on le demande,
  // et on prepare ses voisins des qu'il est la.
  const enMemoire = paliersRecus.get(borne);
  if (enMemoire !== undefined) montrerPaliers(borne, enMemoire);
  else envoyer({ t: "tiers", n: borne });
  flairerLesVoisins();
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

/**
 * Le nom sous lequel les coups perdus concourent au classement.
 *
 * Un caractere nul en tete : aucun pseudo ne peut le porter, et la ligne se
 * reconnait sans risquer de se confondre avec un joueur du meme nom.
 */
const PERSONNE = "\u0000non trouvé";

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
  // DU MEILLEUR AU MOINS BON. C'est un tableau de resultats : range par ordre
  // alphabetique, il fallait lire les scores un a un pour savoir qui avait
  // trouve quoi. A egalite, le nom departage, pour que l'ordre soit stable.
  noms = [...noms].sort((a, b) =>
    (m.propositions?.[b]?.score ?? 0) - (m.propositions?.[a]?.score ?? 0)
    || a.localeCompare(b));
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
        ghost = { word: p.word, dir: p.dir, x: p.x, y: p.y,
                  jokers: jokersDuMot(m, p.word, p.dir, p.x, p.y) };
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

/**
 * Une recherche sur TOUTE la grille, quand on en a demande une.
 *
 * Le champ du rejeu fait deux choses, et c'est ce qui le rend utile : en
 * tapant, il filtre instantanement les paliers deja la ; sur ENTREE, il va
 * chercher le mot partout ailleurs. Tant que celle-ci n'est pas nulle, c'est
 * elle qu'on affiche.
 */
let recherche: { mot: string; total: number; vues: Solution[] } | null = null;

/** Ce qu'on montre d'une recherche qui ramene des milliers de placements. */
const PLAFOND_RECHERCHE = 100;

/**
 * Le plateau tel qu'il etait AVANT le coup examine, garde d'un appel a l'autre.
 *
 * Le reconstruire coute 187 ms sur une partie de onze mille coups -- peu, mais
 * pas assez peu pour le refaire a chaque recherche du meme coup.
 */
let plateauRejeu: { n: number; board: Board } | null = null;

function plateauAvant(n: number): Board {
  if (plateauRejeu !== null && plateauRejeu.n === n) return plateauRejeu.board;
  const b = new Board(dict, cfg);
  b.place(tiles.filter((q) => q.n < n).map((q): Placement => (
    { x: q.x, y: q.y, letter: q.l, blank: q.b === 1 }
  )));
  plateauRejeu = { n, board: b };
  return b;
}

/**
 * Cherche le mot tape sur toute la grille du coup examine.
 *
 * SUR UNE GRILLE INFINIE, SEULS LES CENT PREMIERS PALIERS SONT ENREGISTRES.
 * L'immense majorite des coups jouables n'existe donc nulle part, et chercher
 * un petit mot dans la liste ne rendait rien -- alors qu'il se posait peut-etre
 * a cinq cents endroits.
 *
 * La recherche ne porte que sur un coup DEJA JOUE : le rejeu ne s'ouvre pas
 * ailleurs, et le plateau reconstruit s'arrete au coup d'avant. Le top du coup
 * en cours reste hors d'atteinte, comme il doit l'etre.
 */
function chercherPartout(): void {
  const ici = rejeu;
  if (ici === null) return;
  const champ = $("rj-q") as HTMLInputElement;
  const mot = champ.value.trim().toUpperCase();
  const m = history.find((h) => h.n === ici.n);
  if (m === undefined) return;
  if (mot.length < 2) { $("rj-compte").textContent = "au moins deux lettres"; return; }
  if (!dict.contains(mot)) {
    recherche = { mot, total: 0, vues: [] };
    peindreSolutions();
    $("rj-compte").textContent = "mot inconnu";
    return;
  }
  // Le balayage dure de un a cinq dixiemes de seconde : on laisse l'ecran dire
  // ce qu'il fait avant de le bloquer, sinon il parait fige sans raison.
  $("rj-compte").textContent = "recherche…";
  // Un delai, pas une image : `requestAnimationFrame` ne se declenche pas quand
  // l'onglet est en arriere-plan, et la recherche restait alors en suspens.
  setTimeout(() => {
    {
    if (rejeu === null || rejeu.n !== ici.n) return;
    const t0 = performance.now();
    const tous = chercherLeMot(plateauAvant(ici.n), dict, mot, m.rack);
    const ms = performance.now() - t0;
    recherche = {
      mot, total: tous.length,
      vues: tous.slice(0, PLAFOND_RECHERCHE).map((s): Solution => ({
        word: s.word, dir: s.dir, x: s.x, y: s.y, score: s.score,
        ecart: s.score - m.score, hors: true, noms: [],
      })),
    };
    choisie = -1;
    peindreSolutions();
    if (tous.length === 0) $("rj-compte").textContent = "nulle part";
    console.log(`[rejeu] « ${mot} » cherche en ${ms.toFixed(0)} ms : ${tous.length} placements`);
    }
  }, 24);
}

const echapper = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Affiche les paliers recus : le top et ses isotops, puis les sous-tops. */
/**
 * LES PALIERS DEJA RECUS NE SE REDEMANDENT PAS.
 *
 * On navigue dans le rejeu : coup 40, coup 41, retour au 40. Sans memoire, le
 * retour coutait un aller-retour au serveur et, sur un plateau borne, un calcul
 * complet -- pour un resultat identique au caramel pres, puisque la position
 * d'avant le coup et le tirage ne changent plus.
 *
 * Le serveur a deja sa propre memoire (`paliersRefaits`) ; celle-ci evite en
 * plus le voyage, qui est l'essentiel de l'attente sur une grosse position.
 */
const paliersRecus = new Map<number, Palier[]>();
/** Ce qu'on garde : de quoi couvrir un aller-retour dans la partie, pas plus. */
const PALIERS_GARDES = 60;

/** Les coups voisins qu'on prepare pendant que le joueur regarde celui-ci. */
let flairEnCours = 0;

/**
 * Prepare les coups d'a cote, du plus proche au plus lointain.
 *
 * Pendant qu'on lit un coup, le serveur ne fait rien : autant qu'il prepare ce
 * qu'on va demander ensuite, qui est presque toujours le coup suivant ou le
 * precedent. UN SEUL A LA FOIS -- le fil du solveur sert aussi les parties en
 * cours, et lui envoyer six demandes d'un coup ferait attendre une vraie table.
 */
function flairerLesVoisins(): void {
  const ici = rejeu;
  if (ici === null || flairEnCours !== 0) return;
  for (let d = 1; d <= 3; d++) {
    for (const n of [ici.n + d, ici.n - d]) {
      if (n < 1 || n > history.length || paliersRecus.has(n)) continue;
      flairEnCours = n;
      envoyer({ t: "tiers", n });
      return;
    }
  }
}

function montrerPaliers(n: number, paliers: Palier[] | null, refus?: string): void {
  // Une reponse a une demande de flair : on la range, et on enchaine.
  if (paliers !== null && paliers.length > 0) {
    paliersRecus.set(n, paliers);
    while (paliersRecus.size > PALIERS_GARDES) {
      paliersRecus.delete(paliersRecus.keys().next().value as number);
    }
  }
  if (flairEnCours === n) { flairEnCours = 0; flairerLesVoisins(); }
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
  const brut = ($("rj-q") as HTMLInputElement).value;
  const q = brut.trim().toUpperCase();
  // Une espace finale, ou le bouton « ab » : voir `motEntier`.
  const exact = q !== "" && (motEntier("rj-motEntier") || brut !== brut.trimEnd());
  const box = $("rj-sols");
  const piste = $("rj-piste");
  box.scrollTop = 0;

  // Une recherche large remplace la liste : c'est elle qu'on a demandee, et
  // elle ne se refiltre pas -- tous ses placements portent deja le mot cherche.
  if (recherche !== null) {
    solutionsVues = recherche.vues;
    if (solutionsVues.length === 0) {
      piste.style.height = "";
      piste.innerHTML = `<div class="none" style="padding:10px 15px">`
        + `« ${echapper(recherche.mot)} » ne se pose nulle part sur cette grille</div>`;
    } else {
      piste.style.height = `${solutionsVues.length * H_SOL}px`;
      peindreLaFenetre();
    }
    // Le compte NOMME LE MOT : la liste filtree juste au-dessus disait « 25 sur
    // 109 » pour les mots qui CONTIENNENT « NI », et celle-ci en donne 68 du mot
    // NI lui-meme. Sans le mot, les deux nombres semblent se contredire.
    const n = recherche.total;
    $("rj-compte").textContent = n > solutionsVues.length
      ? `${solutionsVues.length} sur ${n} · ${recherche.mot}`
      : `${n} × ${recherche.mot}`;
    return;
  }

  solutionsVues = q === "" ? solutions
    : solutions.filter((s) => exact ? s.word === q : s.word.includes(q));

  if (solutionsVues.length === 0) {
    piste.style.height = "";
    piste.innerHTML = `<div class="none" style="padding:10px 15px">`
      + `aucun mot ${exact ? "ne vaut" : "ne contient"} « ${echapper(q)} »`
      + `<br><span style="font-size:10.5px">Entrée pour le chercher sur toute la grille</span></div>`;
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
  const ici = rejeu;
  const joue = ici === null ? undefined : history.find((h) => h.n === ici.n);
  ghost = { word: s.word, dir: s.dir, x: s.x, y: s.y,
            jokers: jokersDuMot(joue, s.word, s.dir, s.x, s.y) };
  reveal(s.word, s.dir, s.x, s.y);
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

// ENTREE VA CHERCHER PLUS LOIN. Rien ne part tant qu'on tape : un balayage par
// frappe ferait cinq recherches pour un mot de cinq lettres, dont quatre sur des
// mots incomplets.
$("rj-q").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key !== "Enter") return;
  e.preventDefault();
  chercherPartout();
});
($("rj-q") as HTMLInputElement).addEventListener("input", () => {
  // La liste revient aux paliers des qu'on retouche au champ.
  recherche = null;
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
  // UN DEMI-POINT N'EST PAS UN TOP, ET NE RACHETE PAS LE COUP. Le compter parmi
  // les tops disait « 5 trouves » la ou il y en avait un seul et quatre
  // sous-tops ; le compter a part des perdus faisait un total qui ne tombait
  // plus sur le nombre de coups. Le coup reste perdu, et le demi-point se lit
  // entre parentheses.
  let points = 0, trouves = 0, demis = 0, temps = 0;
  for (const m of history) {
    points += m.score;
    temps += Math.max(0, m.ms);
    const eu = duplicate ? trouveursDuCoup(m).length > 0 : m.player !== null;
    if (eu) trouves++;
    else if (m.demiPoint !== undefined) demis++;
  }
  const perdus = n - trouves;
  const bouts = [
    `<b>${n}</b> coup${n > 1 ? "s" : ""}`,
    `<b>${points.toLocaleString("fr")}</b> points`,
    `<b>${trouves}</b> trouvé${trouves > 1 ? "s" : ""}`
      + `, <b>${perdus}</b> non trouvé${perdus > 1 ? "s" : ""}`
      + (demis > 0 ? ` (dont <b>${demis}</b> demi-point${demis > 1 ? "s" : ""})` : ""),
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
  const brut = champ?.value ?? "";
  const q = brut.trim().toUpperCase();
  // UNE ESPACE FINALE FERME LE MOT. Chercher « QI » ramenait QIS, QING et
  // TAQIYA avec les QI, ce qui est juste quand on cherche une racine et faux
  // quand on veut compter ses QI. L'espace est le signe naturel de la fin d'un
  // mot ; on ne garde alors que ce qui vaut EXACTEMENT ce qui est tape.
  const exact = q !== "" && (motEntier("rm-motEntier") || brut !== brut.trimEnd());
  const tient = (champ2: string): boolean =>
    exact ? champ2.toUpperCase() === q : champ2.toUpperCase().includes(q);
  // Un plateau borne se lit du premier coup au dernier, une grille infinie a
  // l'envers.
  const base = cfg.bornes !== null ? history : [...history].reverse();
  routeVues = q === "" ? base : base.filter((m) =>
    tient(m.word)
    || tient(m.notation)
    || tient(noteCoup(m.dir, m.x, m.y, cfg.bornes))
    || tient(quiLaTrouve(m, true))
    || String(m.n) === q);
  routeVues = trierLaRoute(routeVues);
  const piste = document.getElementById("rm-piste");
  if (piste !== null) piste.style.height = `${routeVues.length * hauteurDeLigne()}px`;
  const compte = document.getElementById("rm-compte");
  if (compte !== null) {
    compte.textContent = q === "" ? "" : `${routeVues.length} sur ${history.length}`;
  }
}

/**
 * Le bouton « mot entier » d'un champ de recherche est-il enfonce ?
 *
 * Deux façons de demander la meme chose, parce que les deux se rencontrent :
 * TERMINER SA RECHERCHE PAR UNE ESPACE, geste deja dans les doigts et qui ne
 * s'apprend pas ; ou APPUYER SUR « ab », comme dans un editeur de texte, quand
 * on veut que ça tienne sans y penser.
 *
 * Sans cela, chercher « MA » parmi les sous-tops d'un coup ramenait MAS, MAT,
 * AMAS, MADRE et deux cents autres : le mot de deux lettres qu'on cherchait
 * etait quelque part dedans, et il fallait le trouver a la main.
 */
function motEntier(id: string): boolean {
  return $(id).getAttribute("aria-pressed") === "true";
}

/** Branche un bouton « mot entier » sur le champ qu'il commande. */
function brancherMotEntier(id: string, refaire: () => void): void {
  const b = $(id);
  b.innerHTML = '<span>ab</span>';
  b.setAttribute("aria-pressed", "false");
  b.title = "mot entier — ou terminez votre recherche par une espace";
  b.addEventListener("click", () => {
    b.setAttribute("aria-pressed", String(!motEntier(id)));
    refaire();
  });
}

/**
 * L'ordre des coups dans la feuille de route.
 *
 * L'ordre de la partie reste celui par defaut -- une feuille de match se lit
 * dans l'ordre ou elle a ete ecrite. Les autres tris repondent a des questions
 * qu'on se pose apres coup : quel a ete le plus gros coup, le plus long mot,
 * celui qu'on a trouve le plus vite. Chaque critere se donne dans les DEUX
 * sens, ecrits en toutes lettres : « points, du plus cher » ne se lit pas de
 * travers, une fleche dans un coin si.
 *
 * A egalite, l'ordre de la partie tranche : sans cela, deux coups de meme
 * valeur changeaient de place d'un affichage a l'autre.
 */
function trierLaRoute(coups: MoveInfo[]): MoveInfo[] {
  const menu = document.getElementById("rm-tri") as HTMLSelectElement | null;
  const tri = menu?.value ?? "partie";
  if (tri === "partie") return coups;
  const cle = tri.slice(0, -1);
  const sens = tri.endsWith("-") ? -1 : 1;
  const valeur = (m: MoveInfo): number =>
    cle === "pts" ? m.score
    : cle === "len" ? m.word.length
    // Un coup que personne n'a trouve n'a pas de temps de recherche : il a duré
    // le chrono entier. Il part au bout, dans les deux sens.
    : m.player === null ? Number.POSITIVE_INFINITY : Math.max(0, m.ms);
  return [...coups].sort((a, b) => {
    const va = valeur(a), vb = valeur(b);
    if (va !== vb) {
      if (!Number.isFinite(va)) return 1;
      if (!Number.isFinite(vb)) return -1;
      return (va - vb) * sens;
    }
    return a.n - b.n;
  });
}

/**
 * Pose les lignes de la feuille de route qui tombent dans la partie visible.
 *
 * Comme le journal et la liste des solutions : une partie de 4 500 coups en a
 * 4 500, et le tableau en montre vingt.
 */
function peindreLaRouteVisible(): void {
  const body = $("rm-body");
  body.style.setProperty("--w-rn", largeurDesNumeros(7, 38));
  const n = routeVues.length;
  const piste = document.getElementById("rm-piste");
  if (piste === null) return;
  // Un filtre qui ne ramene rien laissait un grand blanc, sans rien qui dise si
  // la recherche avait echoue ou si le tableau s'etait casse.
  if (n === 0) {
    piste.innerHTML = `<div class="rm-vide">aucun coup ne correspond</div>`;
    return;
  }
  const haut = Math.max(0, Math.floor(body.scrollTop / hauteurDeLigne()) - 5);
  const bas = Math.min(n, Math.ceil((body.scrollTop + body.clientHeight) / hauteurDeLigne()) + 5);
  let html = "";
  for (let i = haut; i < bas; i++) {
    const m = routeVues[i];
    if (m !== undefined) html += ligneDeRoute(m, i * hauteurDeLigne());
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
    fermerLaRoute();
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
    body.scrollTop += (routeVues.length - avant) * hauteurDeLigne();
  }
  peindreLaRouteVisible();
}

/** Une ligne de la feuille de route. */
/** Hauteur d'une ligne de feuille de route, fixee dans la feuille de style. */
const H_RMROW_BASE = 26;
/**
 * La hauteur d'une ligne de la feuille de route.
 *
 * Le tableau est VIRTUALISE : seules les lignes visibles existent, posees a la
 * main a leur hauteur. Grossir la police sans grossir ce pas les ferait se
 * chevaucher -- c'est la seule chose qui rende le reglage de taille delicat, et
 * elle tient en une multiplication.
 */
function hauteurDeLigne(): number {
  return Math.round(H_RMROW_BASE * prefs.zoomRoute);
}

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
  // CE QUE VOUS AVEZ JOUE, comme sur une feuille de tournoi.
  //
  // Seulement quand cela differe du top affiche : sur un coup remporte avec le
  // mot montre, la colonne repeterait la precedente. Elle apparait donc dans
  // les deux cas ou elle apprend quelque chose -- un coup manque, et un isotop
  // joue a une autre place que celle que le logiciel a retenue.
  let sien = "";
  if (duplicate) {
    const p = m.propositions?.[me];
    const pareil = p !== undefined && p.word === m.word && p.dir === m.dir
      && p.x === m.x && p.y === m.y;
    sien = p === undefined || pareil
      ? `<span class="mw"></span><span class="mp"></span><span class="ms"></span>`
      : `<span class="mw">${echapper(p.word)}</span>` +
        `<span class="mp">${noteCoup(p.dir, p.x, p.y, cfg.bornes)}</span>` +
        `<span class="ms">${p.score}</span>`;
  }

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
      // TROUVEURS SUR PRESENTS. A cinq, « 3/5 » dit la difficulte du coup ; seul,
      // il ne peut dire que 0/1 ou 1/1, ce que la colonne d'a cote dit deja.
      `<span class="sur">${presents < 2 ? "" : `${trouveurs.length}/${presents}`}</span>`;
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
  // Rejouer CE coup. Sur une partie close, ou sur une grille qu'on etudie et
  // qui ouvre son rejeu : ailleurs, le serveur refuse les paliers et le rejeu
  // n'aurait rien a montrer. Une grille infinie n'a pas de fin -- sans cette
  // ouverture, ses isotops et ses sous-tops resteraient a jamais invisibles.
  const rejouer = finie || rejeuOuvert
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
    `<span class="s">${m.score}</span>` + sien +
    `<span class="who">${echapper(quiLaTrouve(m))}</span>` + queue + like + `</div>`;
}
const ICONE_ENREGISTRER =
  '<svg viewBox="0 0 18 18" width="13" height="13" aria-hidden="true">'
  + '<path d="M9 2v9m0 0-3.4-3.4M9 11l3.4-3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
  + '<path d="M2.6 12.6v1.8a1.6 1.6 0 0 0 1.6 1.6h9.6a1.6 1.6 0 0 0 1.6-1.6v-1.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/**
 * La feuille de route, en un document a garder.
 *
 * UN DOCUMENT N'EST PAS UNE COPIE D'ECRAN DE L'APPLICATION. Ce qu'on enregistre
 * se relira ailleurs, hors du jeu, peut-etre dans des annees : les boutons n'y
 * ont plus de sens -- rejouer un coup, tirer une image, aimer un coup sont des
 * gestes qui demandent un serveur et un salon. Ils ne partent donc pas dans le
 * fichier ; ce qui reste est le tableau, et rien d'autre.
 *
 * On enregistre CE QUI EST AFFICHE, filtre et ordre compris : chercher « QI »
 * puis enregistrer, c'est vouloir la liste de ses QI, pas la partie entiere.
 * Le document le dit en tete, pour que personne ne le prenne plus tard pour la
 * feuille complete.
 *
 * Le format est une page autonome : elle s'ouvre d'un double-clic dans
 * n'importe quel navigateur, s'imprime, et garde ses colonnes. Un tableur
 * demanderait de choisir un separateur et perdrait la mise en page ; une image
 * ne se chercherait pas.
 */
function enregistrerLaRoute(): void {
  if (history.length === 0) { flash("aucun coup à enregistrer", "bad"); return; }
  const salonNom = ($("conn").textContent ?? "").split("·").pop()?.trim() || "grille";
  const q = ($("rm-q") as HTMLInputElement).value.trim();
  const quand = new Date().toLocaleString("fr", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const titre = `${salonNom} — feuille de route`;

  const colonnes = duplicate
    ? ["N°", "Tirage", "Mot", "Place", "Points", "Qui", "Écart", "Trouvé"]
    : ["N°", "Tirage", "Mot", "Place", "Points", "Qui", "Temps", "Cumul"];

  const lignes = routeVues.map((m) => {
    const trouve = duplicate ? trouveursDuCoup(m).length > 0 : m.player !== null;
    let fin: string[];
    if (duplicate) {
      const mien = m.scores?.[me];
      const ecart = mien === undefined ? null : mien - m.score;
      const trouveurs = trouveursDuCoup(m).length;
      const presents = Object.keys(m.scores ?? {}).length;
      fin = [ecart === null ? "—" : ecart === 0 ? "top" : String(ecart),
             presents === 0 ? "" : `${trouveurs}/${presents}`];
    } else {
      fin = [trouve ? fmtTime(m.ms) : "×", fmtTime(cumulRoute.get(m.n) ?? 0)];
    }
    const cases = [String(m.n), m.notation, m.word,
                   noteCoup(m.dir, m.x, m.y, cfg.bornes), String(m.score),
                   quiLaTrouve(m, true), ...fin];
    return "<tr>" + cases.map((c, i) =>
      `<td class="${i === 2 ? "mot" : i === 4 ? "pts" : i >= 6 || i === 0 ? "num" : ""}">${echapper(c)}</td>`,
    ).join("") + "</tr>";
  }).join("\n");

  // Le resume porte deja ses <b> : on le reprend tel quel, il est de nous.
  const resume = enTeteDeLaRoute();
  const filtre = q === ""
    ? ""
    : `<p class="filtre">Extrait : les ${routeVues.length} coups qui correspondent à `
      + `« ${echapper(q)} », sur ${history.length}.</p>`;

  const doc = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${echapper(titre)}</title>
<style>
  body { margin: 0; padding: 28px 26px 40px; background: #FBFAF7; color: #1C221F;
         font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  h1 { margin: 0 0 3px; font-size: 20px; font-weight: 600; }
  .quand { margin: 0 0 14px; font-size: 12px; color: #6B7770; }
  .resume { margin: 0 0 6px; font-size: 12.5px; color: #6B7770; }
  .resume b { color: #1C221F; font-weight: 600; }
  .filtre { margin: 0 0 6px; font-size: 12.5px; color: #B4541C; }
  table { border-collapse: collapse; width: 100%; margin-top: 14px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11.5px; font-variant-numeric: tabular-nums; }
  th { text-align: left; padding: 5px 9px; border-bottom: 1.5px solid #C9CFCB;
       font-weight: 600; font-size: 10px; letter-spacing: .09em;
       text-transform: uppercase; color: #6B7770; }
  td { padding: 3px 9px; border-bottom: 1px solid #EBEEEC; color: #4A5651;
       white-space: nowrap; }
  td.mot { color: #1C221F; font-weight: 600; letter-spacing: .04em; }
  td.pts { color: #1E7A4D; font-weight: 600; text-align: right; }
  td.num { text-align: right; }
  th:nth-child(5), th:nth-child(7), th:nth-child(8), th:first-child { text-align: right; }
  tr:nth-child(even) td { background: #F4F2ED; }
  @media print { body { background: #fff; padding: 0; } tr:nth-child(even) td { background: none; } }
</style></head><body>
<h1>${echapper(titre)}</h1>
<p class="quand">${echapper(quand)}</p>
<p class="resume">${resume}</p>
${filtre}
<table><thead><tr>${colonnes.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
<tbody>
${lignes}
</tbody></table>
</body></html>`;

  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([doc], { type: "text/html;charset=utf-8" }));
  a.download = `${titre} — ${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  flash(`feuille enregistrée · ${routeVues.length} coup${routeVues.length > 1 ? "s" : ""}`, "ok");
}

/**
 * Ouvre la feuille de route, LE CURSEUR DANS LA RECHERCHE.
 *
 * On decouvre AVANT de peindre : le nombre de lignes a poser se deduit de la
 * hauteur du tableau, et un tableau cache n'en a pas. On n'en posait que cinq,
 * et les autres n'arrivaient qu'au premier defilement.
 *
 * Le champ prend la main tout de suite : on ouvre cette feuille pour y chercher
 * un mot neuf fois sur dix, et cliquer dans un champ avant de pouvoir taper est
 * un geste de trop.
 */
function ouvrirLaRoute(): void {
  $("roadmap").hidden = false;
  paintRoadmap();
  ($("rm-q") as HTMLInputElement).focus();
}

$("rm-open").addEventListener("click", ouvrirLaRoute);

($("rm-q") as HTMLInputElement).addEventListener("input", () => {
  filtrerLaRoute();
  $("rm-body").scrollTop = 0;
  peindreLaRouteVisible();
});
brancherMotEntier("rm-motEntier", () => {
  filtrerLaRoute();
  $("rm-body").scrollTop = 0;
  peindreLaRouteVisible();
});
brancherMotEntier("rj-motEntier", () => { choisie = -1; peindreSolutions(); });
$("rm-tri").addEventListener("change", () => {
  filtrerLaRoute();
  $("rm-body").scrollTop = 0;
  peindreLaRouteVisible();
});
$("rm-save").innerHTML = ICONE_ENREGISTRER;
$("rm-save").addEventListener("click", enregistrerLaRoute);

/**
 * Fermer la feuille efface la recherche.
 *
 * Un filtre qu'on retrouve en rouvrant est un tableau amputé sans qu'on sache
 * pourquoi : on a cherché « QI » il y a un quart d'heure, et la partie de
 * neuf mille coups n'en montre plus que douze.
 */
function fermerLaRoute(): void {
  $("roadmap").hidden = true;
  ($("rm-q") as HTMLInputElement).value = "";
  ($("rm-tri") as HTMLSelectElement).value = "partie";
  $("rm-motEntier").setAttribute("aria-pressed", "false");
  $("rm-compte").textContent = "";
}
$("rm-close").addEventListener("click", fermerLaRoute);

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
/**
 * Largeur de la colonne des numeros de coup, en pixels.
 *
 * PASSE DIX MILLE COUPS, « 10059 » MORDAIT SUR LE MOT. La colonne etait fixee a
 * la largeur de quatre chiffres, ce qui suffisait a toutes les parties du
 * monde -- jusqu'a celle-ci. On la calcule donc sur le nombre de coups joues :
 * elle ne prend que ce qu'il lui faut, et les colonnes restent alignees d'une
 * ligne a l'autre puisque toutes lisent la meme valeur.
 */
function largeurDesNumeros(parChiffre: number, mini: number): string {
  const chiffres = String(Math.max(1, history.length)).length;
  return `${Math.max(mini, Math.round(chiffres * parChiffre + 4))}px`;
}

function peindreLeJournalVisible(): void {
  const box = $("journal");
  $("journal-bloc").style.setProperty("--w-n", largeurDesNumeros(6.7, 26));
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

/** Le jour d'un message, tel qu'on le compare : « 2026-09-03 ». */
function jourDe(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * La date en toutes lettres, avec « aujourd'hui » et « hier ».
 *
 * L'annee ne parait que si ce n'est pas la nôtre : la porter partout ferait
 * lire un numero de plus a chaque separation, pour un renseignement qu'on a
 * dans quatre-vingt-dix-neuf cas sur cent.
 */
function dateEnToutesLettres(at: number): string {
  const d = new Date(at);
  const aujourdhui = new Date();
  const hier = new Date(aujourdhui.getTime() - 86_400_000);
  if (jourDe(at) === jourDe(aujourdhui.getTime())) return "aujourd'hui";
  if (jourDe(at) === jourDe(hier.getTime())) return "hier";
  return d.toLocaleDateString("fr", {
    weekday: "long", day: "numeric", month: "long",
    ...(d.getFullYear() === aujourdhui.getFullYear() ? {} : { year: "numeric" }),
  });
}

function separateurDeJour(at: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "jour";
  el.textContent = dateEnToutesLettres(at);
  return el;
}

/**
 * LA DATE NE PARAIT QUE QUAND ELLE DISTINGUE QUELQUE CHOSE.
 *
 * Tant que tout le chat tient dans une journee, l'heure suffit : une date
 * repetee au-dessus de chaque message n'apprendrait rien. Des qu'un deuxieme
 * jour commence, les deux se separent -- le PREMIER compris, sans quoi on ne
 * saurait pas de quand datent les messages du haut.
 */
function paintChat(msgs: Chat[]) {
  const log = $("chat-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren();
  const jours = new Set(msgs.map((m) => jourDe(m.at)));
  let courant = "";
  for (const m of msgs) {
    const j = jourDe(m.at);
    if (jours.size > 1 && j !== courant) log.appendChild(separateurDeJour(m.at));
    courant = j;
    log.appendChild(ligneDeChat(m));
  }
  if (atBottom) log.scrollTop = log.scrollHeight;
}

/** Ajoute un seul message, en gardant le defilement s'il etait en bas. */
function ajouterAuChat(m: Chat): void {
  // Un message qui ouvre un jour nouveau fait apparaitre TOUTES les dates, y
  // compris celle du premier jour, tout en haut : on repeint plutot que de
  // recoudre l'historique par le bas. Cela n'arrive qu'une fois par jour.
  const avant = chat.length >= 2 ? chat[chat.length - 2] : undefined;
  if (avant !== undefined && jourDe(avant.at) !== jourDe(m.at)) {
    paintChat(chat);
    return;
  }
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
  const vrai = nomsPublics[m.who];
  if (vrai !== undefined) who.title = vrai;
  if (inscrits.has(m.who)) {
    who.classList.add("fiche-ouvrable");
    who.addEventListener("click", () => { void ouvrirLaFiche(m.who); });
  }
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
/**
 * Les preferences du joueur : les siennes, sur cet appareil.
 *
 * A NE PAS CONFONDRE AVEC LES REGLAGES DU SALON, qui decident de la partie et
 * valent pour tout le monde. Ici, rien ne sort de ce navigateur : le theme et
 * le son ne regardent que celui qui est devant l'ecran, et les imposer aux
 * autres n'aurait aucun sens.
 *
 * Le rangement local peut manquer -- navigation privee, site bloque, un
 * navigateur qui jette tout en fermant. Ce n'est pas une panne : on repart des
 * valeurs par defaut, et le jeu tourne pareil.
 */
interface Preferences {
  theme: "auto" | "light" | "dark";
  sons: boolean;
  /** La camera vole-t-elle vers un coup, ou s'y pose-t-elle d'un coup ? */
  vols: boolean;
  /** Hauteur choisie pour chaque section du panneau, `null` = celle d'origine. */
  hauteurs: { live: number | null; journal: number | null; rank: number | null };
  /** Largeur choisie pour le panneau de droite, `null` = celle d'origine. */
  largeurCote: number | null;
  /** Les images de grille sont-elles tirees en haute definition ? */
  imageHD: boolean;
  /** De quel cote du plateau se lisent les lettres : « fr » ou « en ». */
  reperes: Reperes;
  /**
   * La barre d'espace fait-elle le tour des QUATRE sens ?
   *
   * Par defaut elle alterne droite et bas, les deux seuls sens dans lesquels
   * un mot se lit. Ouverte aux quatre, elle permet d'ecrire a reculons : on
   * pose le curseur sur la FIN du mot et on tape a l'envers, ce qui evite de
   * compter les cases en arriere pour trouver ou commencer (SPEC.md §18).
   */
  quatre: boolean;
  /**
   * De combien le texte est grossi, dans la feuille de route et dans le
   * panneau de droite.
   *
   * Deux reglages plutot qu'un : on ne lit pas ces deux endroits de la meme
   * facon. Le panneau se suit du coin de l'oeil pendant qu'on cherche, la
   * feuille se lit apres coup, penche dessus. Ils n'appellent pas la meme
   * taille, et un facteur commun aurait force a choisir.
   */
  zoomRoute: number;
  zoomCote: number;
}
const prefs: Preferences = {
  theme: "auto", sons: true,
  // Le navigateur sait deja que son proprietaire n'aime pas ce qui bouge :
  // c'est notre valeur de depart, et le panneau permet d'en changer.
  vols: !matchMedia("(prefers-reduced-motion: reduce)").matches,
  hauteurs: { live: null, journal: null, rank: null },
  largeurCote: null,
  imageHD: false,
  reperes: "fr",
  quatre: false,
  zoomRoute: 1,
  zoomCote: 1,
};
const CLE_PREFS = "farfouille.preferences";

/** Les bornes du grossissement, et le pas d'un clic. */
const ZOOM_MIN = 0.8, ZOOM_MAX = 1.6, ZOOM_PAS = 0.1;

/** Pose les deux facteurs de taille la ou le style les attend. */
function appliquerLesTailles(): void {
  (document.querySelector(".side") as HTMLElement)
    .style.setProperty("--z", String(prefs.zoomCote));
  $("roadmap").style.setProperty("--zr", String(prefs.zoomRoute));
  for (const [id, cle] of [["rm-zoom", "zoomRoute"], ["cote-zoom", "zoomCote"]] as const) {
    for (const b of $(id).querySelectorAll("button")) {
      const pas = Number((b as HTMLElement).dataset["z"]);
      const apres = +(prefs[cle] + pas * ZOOM_PAS).toFixed(2);
      (b as HTMLButtonElement).disabled = apres < ZOOM_MIN || apres > ZOOM_MAX;
    }
  }
}

for (const [id, cle] of [["rm-zoom", "zoomRoute"], ["cote-zoom", "zoomCote"]] as const) {
  $(id).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b === null) return;
    const pas = Number(b.dataset["z"]);
    prefs[cle] = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX,
      +(prefs[cle] + pas * ZOOM_PAS).toFixed(2)));
    appliquerLesTailles();
    garderPreferences();
    // La feuille de route est virtualisee : ses lignes se reposent a la main,
    // et leur pas vient de changer.
    if (!$("roadmap").hidden) paintRoadmap();
    // La barre du chevalet se recale : le panneau a change de largeur, donc le
    // milieu de la grille aussi.
    calerLeChevalet();
  });
}

function lirePreferences(): void {
  try {
    const brut = localStorage.getItem(CLE_PREFS);
    if (brut === null) return;
    const v = JSON.parse(brut) as Partial<Preferences>;
    if (v.theme === "auto" || v.theme === "light" || v.theme === "dark") prefs.theme = v.theme;
    if (typeof v.sons === "boolean") prefs.sons = v.sons;
    if (typeof v.vols === "boolean") prefs.vols = v.vols;
    if (typeof v.imageHD === "boolean") prefs.imageHD = v.imageHD;
    if (v.reperes === "fr" || v.reperes === "en") prefs.reperes = v.reperes;
    if (typeof v.quatre === "boolean") prefs.quatre = v.quatre;
    for (const cle of ["zoomRoute", "zoomCote"] as const) {
      const z = v[cle];
      if (typeof z === "number" && z >= ZOOM_MIN && z <= ZOOM_MAX) prefs[cle] = z;
    }
    const l = v.largeurCote;
    if (l === null || (typeof l === "number" && Number.isFinite(l))) {
      prefs.largeurCote = l === null ? null : borneLaLargeur(l);
    }
    const h = v.hauteurs;
    if (h !== undefined && h !== null) {
      for (const cle of ["live", "journal", "rank"] as const) {
        const n = h[cle];
        if (n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0)) {
          prefs.hauteurs[cle] = n;
        }
      }
    }
  } catch { /* rien de garde : les valeurs par defaut suffisent */ }
}

function garderPreferences(): void {
  try { localStorage.setItem(CLE_PREFS, JSON.stringify(prefs)); }
  catch { /* rangement refuse : le reglage vaut pour cette session */ }
}

/**
 * Applique le theme et repeint la grille.
 *
 * « Automatique » ne pose PAS d'attribut : la feuille de style suit alors le
 * navigateur toute seule, et suivra ses changements -- quelqu'un qui bascule
 * son systeme en sombre a la tombee du jour n'a rien a rouvrir ici.
 *
 * La grille lit ses couleurs a chaque image, mais garde ses caramels dans une
 * image de cote : il faut l'invalider, sinon les anciennes teintes restent
 * posees jusqu'au prochain changement d'echelle.
 */
/**
 * Applique les reperes choisis, et repeint tout ce qui porte une notation.
 *
 * Le changement touche la grille, le journal, la feuille de route, le rejeu et
 * le chat : partout ou une case se nomme. On repeint donc large plutot que de
 * tenir la liste des endroits concernes, qui serait fausse au premier ajout.
 */
function appliquerLesReperes(): void {
  setReperes(prefs.reperes);
  if (!configRecue) return;
  cacheCle = "";
  paintJournal();
  paintSide();
  draw();
}

function appliquerLeTheme(): void {
  const r = document.documentElement;
  if (prefs.theme === "auto") r.removeAttribute("data-theme");
  else r.setAttribute("data-theme", prefs.theme);
  cacheCle = "";
  if (configRecue) draw();
}

/**
 * La sonnerie de la grille permanente, par paliers.
 *
 * SUR LA GRILLE PERMANENTE, UN COUP PEUT DURER DES HEURES -- ou des jours.
 * Personne ne reste devant : on la laisse ouverte dans un onglet et on fait
 * autre chose. Quand le coup finit par tomber, le son dit DEPUIS COMBIEN DE
 * TEMPS il resistait : c'est la seule chose qu'on veut savoir de loin, et un
 * signal unique ne la disait pas.
 *
 * L'echelle va du sourd a la fete. Cinq minutes, c'est un coup qui a un peu
 * traine : deux notes graves qui descendent, filtrees, presque un raclement de
 * gorge. Dix jours, c'est un mur que quelqu'un vient d'abattre : ca s'entend.
 *
 * En dessous de cinq minutes, rien. La partie se suit a l'oeil, et une sonnerie
 * toutes les deux minutes serait une nuisance, pas un service.
 *
 * CELUI QUI TROUVE L'ENTEND AUSSI. Il sait deja ce qu'il a fait -- mais un
 * signal qui vous felicite fait plaisir, et se le refuser n'economise rien.
 */
interface Note {
  /** Hauteur en hertz. */
  hz: number;
  /** Depart, en secondes depuis le debut de la sonnerie. */
  a: number;
  /** Duree de l'extinction. */
  d: number;
  /** Timbre : le sinus est doux, le triangle chante, la dent de scie sonne. */
  t?: OscillatorType;
  /** Volume. Les accords empilent des voix : chacune doit rester discrete. */
  g?: number;
}

/** Un accord : la meme figure a plusieurs hauteurs, d'un seul coup. */
const accord = (hzs: number[], a: number, d: number, t: OscillatorType, g: number): Note[] =>
  hzs.map((hz) => ({ hz, a, d, t, g }));

/** Les degres tempères dont se servent les sonneries. */
const MI3 = 164.81, SOL3 = 196.00, DO4 = 261.63, MI4 = 329.63, FA4 = 349.23,
      SOL4 = 392.00, LA4 = 440.00, DO5 = 523.25, RE5 = 587.33, MI5 = 659.25,
      FA5 = 698.46, SOL5 = 783.99, LA5 = 880.00, DO6 = 1046.50, MI6 = 1318.51;

/**
 * Les paliers, du plus sobre au plus fetard. Lus du dernier au premier : c'est
 * le plus haut palier atteint qui sonne.
 */
const SONNERIES: { apres: number; nom: string; coupure: number; notes: Note[] }[] = [
  {
    apres: 5 * 60_000, nom: "cinq minutes", coupure: 600,
    // Deux notes graves qui DESCENDENT, sous un filtre qui leur ote tout
    // eclat : on signale, on ne felicite pas.
    notes: [
      { hz: SOL3, a: 0, d: 0.30, t: "sine", g: 0.08 },
      { hz: MI3, a: 0.17, d: 0.34, t: "sine", g: 0.08 },
    ],
  },
  {
    apres: 10 * 60_000, nom: "dix minutes", coupure: 1800,
    // Meme brievete, mais ca MONTE, et le triangle laisse passer un harmonique.
    notes: [
      { hz: SOL4, a: 0, d: 0.26, t: "triangle", g: 0.07 },
      { hz: DO5, a: 0.15, d: 0.32, t: "triangle", g: 0.07 },
    ],
  },
  {
    apres: 15 * 60_000, nom: "un quart d'heure", coupure: 2800,
    // Un accord parfait egrene : trois notes suffisent a rendre une phrase gaie.
    notes: [
      { hz: DO5, a: 0, d: 0.24, t: "triangle", g: 0.065 },
      { hz: MI5, a: 0.13, d: 0.24, t: "triangle", g: 0.065 },
      { hz: SOL5, a: 0.26, d: 0.38, t: "triangle", g: 0.07 },
    ],
  },
  {
    apres: 30 * 60_000, nom: "une demi-heure", coupure: 4000,
    // La meme montee, poussee jusqu'a l'octave, et le sommet tenu.
    notes: [
      { hz: DO5, a: 0, d: 0.20, t: "triangle", g: 0.06 },
      { hz: MI5, a: 0.11, d: 0.20, t: "triangle", g: 0.06 },
      { hz: SOL5, a: 0.22, d: 0.20, t: "triangle", g: 0.06 },
      { hz: DO6, a: 0.33, d: 0.46, t: "triangle", g: 0.075 },
      { hz: SOL5, a: 0.33, d: 0.46, t: "sine", g: 0.04 },
    ],
  },
  {
    apres: 24 * 3600_000, nom: "un jour", coupure: 5200,
    // Une petite fanfare : levee, montee, et un accord tenu pour finir.
    notes: [
      { hz: SOL4, a: 0, d: 0.16, t: "triangle", g: 0.055 },
      { hz: DO5, a: 0.12, d: 0.16, t: "triangle", g: 0.06 },
      { hz: MI5, a: 0.24, d: 0.16, t: "triangle", g: 0.06 },
      { hz: SOL5, a: 0.36, d: 0.18, t: "triangle", g: 0.065 },
      { hz: MI5, a: 0.50, d: 0.14, t: "triangle", g: 0.05 },
      { hz: SOL5, a: 0.60, d: 0.14, t: "triangle", g: 0.055 },
      ...accord([DO5, MI5, SOL5, DO6], 0.72, 0.85, "triangle", 0.045),
    ],
  },
  {
    apres: 10 * 24 * 3600_000, nom: "dix jours", coupure: 6000,
    // Un petit orchestre : quatre accords, une basse qui marche dessous, et une
    // volee de notes pour finir. Deux secondes et demie -- de quoi lever la tete.
    notes: [
      ...accord([DO4, MI4, SOL4, DO5], 0.00, 0.55, "triangle", 0.042),
      { hz: DO4 / 2, a: 0.00, d: 0.55, t: "sine", g: 0.07 },
      ...accord([DO4, FA4, LA4, DO5], 0.46, 0.55, "triangle", 0.042),
      { hz: FA4 / 2, a: 0.46, d: 0.55, t: "sine", g: 0.07 },
      ...accord([RE5, SOL4, SOL5, SOL4], 0.92, 0.50, "triangle", 0.038),
      { hz: SOL4 / 2, a: 0.92, d: 0.50, t: "sine", g: 0.07 },
      // La volee : une gamme rapide qui court vers le sommet.
      { hz: DO5, a: 1.34, d: 0.12, t: "triangle", g: 0.05 },
      { hz: MI5, a: 1.42, d: 0.12, t: "triangle", g: 0.05 },
      { hz: SOL5, a: 1.50, d: 0.12, t: "triangle", g: 0.05 },
      { hz: DO6, a: 1.58, d: 0.14, t: "triangle", g: 0.055 },
      { hz: MI6, a: 1.66, d: 0.16, t: "triangle", g: 0.05 },
      ...accord([DO5, MI5, SOL5, DO6], 1.78, 1.10, "triangle", 0.04),
      { hz: DO4 / 2, a: 1.78, d: 1.10, t: "sine", g: 0.08 },
      { hz: LA5, a: 1.78, d: 1.10, t: "sine", g: 0.028 },
    ],
  },
];

/** Le premier palier : en dessous, on ne sonne pas. */
const SEUIL_SONNERIE_MS = SONNERIES[0]!.apres;
let audio: AudioContext | null = null;

/** Le palier qu'atteint un coup de cette duree, ou `null` s'il n'en atteint aucun. */
function palierDeSonnerie(ms: number): (typeof SONNERIES)[number] | null {
  for (let i = SONNERIES.length - 1; i >= 0; i--) {
    const p = SONNERIES[i]!;
    if (ms >= p.apres) return p;
  }
  return null;
}

/**
 * Joue le palier qui convient a un coup de cette duree.
 *
 * Toutes les voix passent par un filtre passe-bas : c'est lui qui fait la
 * difference entre le sourd et l'eclatant, bien plus que la hauteur des notes.
 * Chaque note monte en vingt millisecondes et s'eteint en courbe : une attaque
 * franche fait sursauter, ce qui est le contraire de ce qu'on cherche.
 */
function sonner(ms: number): void {
  if (!prefs.sons) return;
  const p = palierDeSonnerie(ms);
  if (p === null) return;
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const son = audio;
    const t0 = son.currentTime + 0.03;
    const filtre = son.createBiquadFilter();
    filtre.type = "lowpass";
    filtre.frequency.value = p.coupure;
    filtre.Q.value = 0.7;
    filtre.connect(son.destination);
    for (const n of p.notes) {
      const o = son.createOscillator(), g = son.createGain();
      o.type = n.t ?? "sine";
      o.frequency.value = n.hz;
      const d = t0 + n.a;
      const v = n.g ?? 0.07;
      g.gain.setValueAtTime(0, d);
      g.gain.linearRampToValueAtTime(v, d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0004, d + n.d);
      o.connect(g).connect(filtre);
      o.start(d);
      o.stop(d + n.d + 0.06);
    }
  } catch { /* le navigateur refuse le son : le jeu n'en depend pas */ }
}

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
  // La camera se pose AVANT qu'on lise la case : on clique ce qu'on voit.
  finirLeVol();
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
    if (typed.length === 0) cursor = pivoter(cursor);
  } else {
    cursor = { x, y, dir: p.button === 2 ? "V" : "H", rec: false };
    typed = "";
  }
  paintRack(); paintCurrent(); draw();
});
cv.addEventListener("pointercancel", () => { press = null; clearTimeout(holdTimer); cv.style.cursor = ""; });

addEventListener("keydown", (e) => {
  // SUR L'ACCUEIL, ECHAP REFERME CE QUI S'Y OUVRE, et rien d'autre ne passe :
  // les raccourcis du jeu n'ont pas cours tant qu'on n'est pas dans un salon.
  if (!$("join").hidden) {
    if (e.key !== "Escape") return;
    if (!$("voile-joueur").hidden) { $("voile-joueur").hidden = true; return; }
    if (!$("voile-admin").hidden) { $("voile-admin").hidden = true; return; }
    if (!$("voile-compte").hidden) { $("voile-compte").hidden = true; return; }
    if (!$("voile-records").hidden) { $("voile-records").hidden = true; return; }
    if (!$("voile").hidden) { destination = null; $("voile").hidden = true; }
    return;
  }
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
    // ECHAP EFFACE LA RECHERCHE, PUIS FERME CE QU'ELLE CHERCHAIT.
    //
    // Le navigateur vide un champ de recherche sur Echap, et c'est ce qu'on
    // veut tant qu'il y a du texte. Mais sur un champ deja vide il ne se
    // passait plus rien : le panneau restait ouvert, et la touche paraissait
    // morte. Vide, Echap ferme donc le panneau, comme partout ailleurs.
    if (e.key === "Escape" && cible.value === "") {
      if (cible.id === "rm-q" && !$("roadmap").hidden) { fermerLaRoute(); e.preventDefault(); }
      else if (cible.id === "rj-q" && !$("panel-rejeu").hidden) { fermerLeRejeu(); e.preventDefault(); }
    }
    return;
  }
  // LES RACCOURCIS DU JEU PASSENT AVANT TOUT LE RESTE, LE REJEU COMPRIS.
  //
  // Le rejeu prenait la main sur les fleches et rendait tout le reste au
  // navigateur : Ctrl+R y RECHARGEAIT donc la page, ce qui ramenait au salon et
  // faisait perdre le coup qu'on examinait. La feuille de route s'ouvre depuis
  // le rejeu comme d'ailleurs.
  if ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    if ($("roadmap").hidden) ouvrirLaRoute();
    else fermerLaRoute();
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
  if (!$("prefs").hidden && e.key === "Escape") { $("prefs").hidden = true; return; }
  if (!$("roadmap").hidden && e.key === "Escape") { fermerLaRoute(); return; }
  if (ghost !== null && e.key === "Escape") { ghost = null; draw(); return; }

  // Ctrl+D poserait un signet, ce qui n'a aucun sens ici. On le prend, et on le
  // rend a son usage des qu'on est dans une zone de saisie -- celles-ci ont
  // rendu la main plus haut.
  if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    if (!$("reglages-open").hidden) ouvrirReglages();
    return;
  }
  // Ctrl+E ouvre le rejeu -- la ou le bouton l'ouvre, et nulle part ailleurs :
  // sur une partie en cours, montrer les paliers serait donner les reponses.
  if ((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E")) {
    e.preventDefault();
    if (!$("rejeu-wrap").hidden && rejeu === null) voirLeCoup(1);
    return;
  }
  // CTRL+A RANGE LE CHEVALET, comme sur le logiciel historique. Le navigateur
  // s'en sert pour tout selectionner, mais nous sommes hors de toute zone de
  // saisie -- celles-ci ont rendu la main plus haut -- et il n'y a ici rien a
  // selectionner qu'une grille dessinee.
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    rangerLeChevalet();
    return;
  }
  if (e.key === "Escape") { typed = ""; paintRack(); paintCurrent(); draw(); return; }
  if (e.key === " " || e.code === "Space") {
    // On pivote, et le mot en cours s'efface : le retourner tel quel poserait
    // les memes caramels dans l'autre sens, ce qui n'a aucun sens.
    if (cursor !== null) {
      cursor = pivoter(cursor);
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
    if (cursor === null && tiles.length === 0) cursor = { dir: "H", x: -4, y: 0, rec: false };
    if (cursor === null) return;
    if (typed.length >= 15) return;
    // La lettre irait-elle hors du plateau ? Alors elle ne part pas. Mieux vaut
    // qu'une touche ne fasse rien que d'ecrire dans le vide et de l'annoncer
    // apres coup : « le mot sort de la grille » ne se lit qu'une fois le mal
    // fait, et le joueur voit ses lettres flotter dehors en attendant.
    const libre = nextFree();
    if (libre !== null && !board.dansLesBornes(libre.x, libre.y)) return;
    const ch = e.key.toUpperCase();
    const left = remaining();
    // Lettre absente du tirage : il ne se passe simplement rien.
    if (!left.includes(ch) && !left.includes(BLANK)) return;
    typed += ch;
    paintRack(); paintCurrent(); draw();
    return;
  }
  // LES FLECHES DEPLACENT LE CURSEUR, pas la grille.
  //
  // On se place ou l'on veut ecrire sans quitter le clavier : c'est ce qui
  // separe une saisie confortable d'un aller-retour a la souris a chaque mot.
  // Le sens d'ecriture, lui, ne change pas -- il appartient a la barre d'espace.
  //
  // La grille se deplace toujours a la souris, et avec MAJ + fleche pour qui
  // preferait le clavier.
  const fleches: Record<string, { dx: number; dy: number }> = {
    ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 },
    ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 },
  };
  const f = fleches[e.key];
  if (f !== undefined && !e.shiftKey) {
    e.preventDefault();
    // SANS CURSEUR, LA FLECHE EN FAIT APPARAITRE UN. Au milieu de ce qu'on
    // regarde, et sur une case LIBRE : se retrouver sur une lettre deja posee
    // obligerait a repartir avant meme d'avoir commence.
    if (cursor === null) {
      const c = caseLibreAuCentre();
      if (c === null) return;
      cursor = { ...c, dir: "H", rec: false };
      typed = "";
    } else {
      // Deplacer, c'est repartir : les lettres en cours n'ont plus d'ancre.
      const vise = { x: cursor.x + f.dx, y: cursor.y + f.dy };
      if (!board.dansLesBornes(vise.x, vise.y)) return;
      cursor = { ...cursor, ...vise };
      typed = "";
    }
    suivreLeCurseur();
    paintRack(); paintCurrent(); draw();
    return;
  }
  // Un plateau borne tient tout entier a l'ecran : il n'y a nulle part ou
  // aller, et le deplacer ne fait que decadrer ce que `cadrer()` a pose.
  if (cfg.bornes !== null) return;
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
  const c = coupCanonique();
  if (c === null) return;
  const r = resolveTypedWord(board, dict, c.dir, c.x, c.y, c.typed, rack);
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
  envoyer({ t: "try", dir: c.dir, x: c.x, y: c.y, typed: c.typed });
  typed = ""; paintRack(); paintSide(); draw();
}

$("reveal").addEventListener("click", () => envoyer({ t: "reveal" }));

/**
 * REJOUER LA MEME PARTIE, une fois celle-ci finie.
 *
 * Rouvrir les reglages pour tout retrouver a l'identique et ne rien changer est
 * un detour : neuf fois sur dix, une table qui vient de finir veut recommencer
 * telle quelle. Le bouton se pose sous « Partie terminee », la ou l'on regarde
 * deja, et il n'apparait qu'a celui qui tient les manettes -- lui seul peut
 * relancer.
 *
 * Il renvoie la variante EN COURS, pas celle du panneau de reglages : celui-ci
 * a pu etre ouvert et tripote sans etre valide.
 */
$("rejouer").addEventListener("click", () => {
  envoyer({
    t: "relancer", tirage: cfg.tirage, jouables: cfg.jouables, pioche: cfg.pioche,
    joker: cfg.joker, primes: cfg.primes, chrono: cfg.chrono, bornes: cfg.bornes,
    mode: cfg.mode, coupsMax: cfg.coupsMax, dureeMax: cfg.dureeMax,
    decompte: cfg.decompte, dictionnaire: cfg.dictionnaire,
  });
});

// ------------------------------------------------- sections du panneau

/**
 * Les separations du panneau de droite s'attrapent.
 *
 * CHACUN NE SUIT PAS LA PARTIE DE LA MEME FAÇON. L'un veut voir tous les coups
 * joues, l'autre le chat, un troisieme rien que le classement et la grille.
 * Plutot que de choisir a leur place, on laisse tirer les lignes -- jusqu'a
 * effacer une section, si c'est ce qu'on veut d'elle. Un double-clic lui rend
 * sa taille d'origine.
 *
 * Deux lignes suffisent : celle qui separe le tableau de bord des coups joues,
 * et celle qui separe les coups joues du chat. Le chat prend ce qui reste --
 * il n'a pas de taille propre a defendre, et c'est lui qu'on veut voir grandir
 * quand on rapetisse le reste.
 *
 * Les hauteurs sont gardees avec les autres preferences : on ne rearrange pas
 * son ecran a chaque visite.
 */
const SECTIONS = [
  { poignee: "poignee-haut", section: "panel-live", cle: "live" },
  { poignee: "poignee-bas", section: "journal-bloc", cle: "journal" },
  // Le classement se tire DANS son bloc : c'est lui qui grandit avec le nombre
  // de joueurs, et lui seul qu'on veut pouvoir contenir.
  { poignee: "poignee-rank", section: "rank", cle: "rank" },
] as const;

/** Ce qu'on laisse au chat, quoi qu'on tire : sans quoi il disparait pour de bon. */
const RESTE_AU_CHAT = 90;

/**
 * LES BORNES DU PANNEAU DE DROITE.
 *
 * Le maximum est sa largeur d'origine : on le retrecit pour rendre de la place
 * a la grille, on ne l'elargit pas -- au-dela, le classement et le chat
 * gagneraient du vide, la grille perdrait des cases.
 *
 * Le minimum tient a ce qu'on y lit. En dessous de 360 px, la ligne du
 * classement -- nom, coeurs, points -- se replie en deux, et le journal ne
 * tient plus un coup par ligne. C'est la que le panneau cesse de servir.
 */
const COTE_MAX = 572, COTE_MIN = 360;
const borneLaLargeur = (l: number): number => Math.max(COTE_MIN, Math.min(COTE_MAX, Math.round(l)));

function reglerLaLargeur(l: number | null): void {
  const cote = document.querySelector(".side") as HTMLElement;
  cote.style.width = l === null ? "" : `${borneLaLargeur(l)}px`;
}

function reglerHauteur(section: HTMLElement, h: number | null): void {
  if (h === null) {
    section.style.height = "";
    section.style.maxHeight = "";
    section.classList.remove("regle");
    return;
  }
  // La fenetre a pu retrecir depuis : une hauteur gardee hier ne doit pas
  // chasser le chat hors de l'ecran aujourd'hui.
  const cote = document.querySelector(".side")!.getBoundingClientRect().height;
  const plafond = cote > 0 ? Math.max(0, cote - RESTE_AU_CHAT) : h;
  section.style.height = `${Math.round(Math.min(h, plafond))}px`;
  section.style.maxHeight = "none";
  section.classList.add("regle");
}

function appliquerLesHauteurs(): void {
  for (const s of SECTIONS) reglerHauteur($(s.section), prefs.hauteurs[s.cle]);
  reglerLaLargeur(prefs.largeurCote);
  peindreLeJournalVisible();
}

{
  // TIRER VERS LA GAUCHE ELARGIT : la poignee est au bord gauche du panneau, et
  // c'est le bord qu'on deplace, pas le panneau.
  const poignee = $("poignee-cote");
  const cote = document.querySelector(".side") as HTMLElement;
  poignee.addEventListener("pointerdown", (e) => {
    const ev = e as PointerEvent;
    ev.preventDefault();
    poignee.setPointerCapture(ev.pointerId);
    poignee.classList.add("tire");
    document.body.classList.add("redimensionne", "colonne");
    const depart = ev.clientX;
    const l0 = cote.getBoundingClientRect().width;
    const bouger = (m: PointerEvent) => {
      const l = borneLaLargeur(l0 + depart - m.clientX);
      prefs.largeurCote = l;
      reglerLaLargeur(l);
    };
    const lacher = () => {
      poignee.removeEventListener("pointermove", bouger);
      poignee.removeEventListener("pointerup", lacher);
      poignee.removeEventListener("pointercancel", lacher);
      poignee.classList.remove("tire");
      document.body.classList.remove("redimensionne", "colonne");
      garderPreferences();
    };
    poignee.addEventListener("pointermove", bouger);
    poignee.addEventListener("pointerup", lacher);
    poignee.addEventListener("pointercancel", lacher);
  });
  poignee.addEventListener("dblclick", () => {
    prefs.largeurCote = null;
    reglerLaLargeur(null);
    garderPreferences();
  });
}

/** Une poignee n'a de sens qu'entre deux sections visibles. */
function majDesPoignees(): void {
  const journal = !$("journal-bloc").hidden;
  $("poignee-haut").hidden = $("panel-live").hidden || !journal;
  $("poignee-bas").hidden = !journal;
  $("poignee-rank").hidden = $("panel-live").hidden;
}

for (const s of SECTIONS) {
  const poignee = $(s.poignee), section = $(s.section);
  poignee.addEventListener("pointerdown", (e) => {
    const ev = e as PointerEvent;
    ev.preventDefault();
    poignee.setPointerCapture(ev.pointerId);
    poignee.classList.add("tire");
    document.body.classList.add("redimensionne");
    const depart = ev.clientY;
    const h0 = section.getBoundingClientRect().height;
    const cote = document.querySelector(".side")!.getBoundingClientRect().height;
    const plafond = Math.max(0, cote - RESTE_AU_CHAT);
    const bouger = (m: PointerEvent) => {
      const h = Math.max(0, Math.min(plafond, h0 + m.clientY - depart));
      prefs.hauteurs[s.cle] = h;
      reglerHauteur(section, h);
      peindreLeJournalVisible();
    };
    const lacher = () => {
      poignee.removeEventListener("pointermove", bouger);
      poignee.removeEventListener("pointerup", lacher);
      poignee.removeEventListener("pointercancel", lacher);
      poignee.classList.remove("tire");
      document.body.classList.remove("redimensionne");
      garderPreferences();
    };
    poignee.addEventListener("pointermove", bouger);
    poignee.addEventListener("pointerup", lacher);
    poignee.addEventListener("pointercancel", lacher);
  });
  // Rendre a la section sa taille d'origine, sans avoir a la retrouver a l'oeil.
  poignee.addEventListener("dblclick", () => {
    prefs.hauteurs[s.cle] = null;
    reglerHauteur(section, null);
    peindreLeJournalVisible();
    garderPreferences();
  });
}

// ---------------------------------------------------------------- paramètres

const ICONE_ROUE =
  '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true">'
  + '<path fill="currentColor" fill-rule="evenodd" d="'
  + 'M10.09 1.17 L13.91 1.17 L13.48 4.75 L16.08 5.83 L18.31 2.99 L21.01 5.69'
  + ' L18.17 7.92 L19.25 10.52 L22.83 10.09 L22.83 13.91 L19.25 13.48'
  + ' L18.17 16.08 L21.01 18.31 L18.31 21.01 L16.08 18.17 L13.48 19.25'
  + ' L13.91 22.83 L10.09 22.83 L10.52 19.25 L7.92 18.17 L5.69 21.01'
  + ' L2.99 18.31 L5.83 16.08 L4.75 13.48 L1.17 13.91 L1.17 10.09'
  + ' L4.75 10.52 L5.83 7.92 L2.99 5.69 L5.69 2.99 L7.92 5.83 L10.52 4.75 Z'
  + ' M12 8.3 a3.7 3.7 0 1 0 0 7.4 a3.7 3.7 0 1 0 0-7.4 Z"/></svg>';

$("prefs-open").innerHTML = ICONE_ROUE;

function peuplerPreferences(): void {
  for (const b of $("p-langue").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === langue()));
  }
  for (const b of $("p-theme").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === prefs.theme));
  }
  for (const b of $("p-sons").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(((b as HTMLElement).dataset["v"] === "on") === prefs.sons));
  }
  $("p-vols").setAttribute("aria-pressed", String(!prefs.vols));
  $("p-image").setAttribute("aria-pressed", String(prefs.imageHD));
  $("p-quatre").setAttribute("aria-pressed", String(prefs.quatre));
  for (const b of $("p-reperes").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === prefs.reperes));
  }
}

// Changer de langue recharge la page : voir `choisirLaLangue`. Le reglage ne
// vit donc pas dans `prefs`, qui se relit apres coup -- il vit dans langue.ts,
// qui doit etre lu AVANT que la page ne se peigne.
for (const b of $("p-langue").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const choisie = (b as HTMLElement).dataset["v"] === "en" ? "en" : "fr";
    if (choisie !== langue()) choisirLaLangue(choisie);
  });
}
for (const b of $("p-theme").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    prefs.theme = (b as HTMLElement).dataset["v"] as Preferences["theme"];
    garderPreferences();
    appliquerLeTheme();
    peuplerPreferences();
  });
}
for (const b of $("p-sons").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    prefs.sons = (b as HTMLElement).dataset["v"] === "on";
    garderPreferences();
    peuplerPreferences();
  });
}
// Un seul interrupteur : la question est « faut-il reduire ? », elle appelle
// oui ou non. Deux boutons cote a cote obligeaient a lire les deux etiquettes
// pour comprendre laquelle etait allumee.
$("p-vols").addEventListener("click", () => {
  prefs.vols = !prefs.vols;
  garderPreferences();
  peuplerPreferences();
});
$("p-image").addEventListener("click", () => {
  prefs.imageHD = !prefs.imageHD;
  garderPreferences();
  peuplerPreferences();
});
$("p-quatre").addEventListener("click", () => {
  prefs.quatre = !prefs.quatre;
  // ON NE LAISSE PAS UN CURSEUR A RECULONS derriere soi : le reglage referme,
  // la barre d'espace ne saurait plus revenir a l'endroit, et le curseur
  // resterait bloque a ecrire en arriere sans qu'on comprenne pourquoi.
  if (!prefs.quatre && cursor !== null && cursor.rec) {
    cursor = { ...cursor, rec: false };
    typed = "";
    paintRack(); paintCurrent(); draw();
  }
  garderPreferences();
  peuplerPreferences();
});
for (const b of $("p-reperes").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    prefs.reperes = (b as HTMLElement).dataset["v"] as Reperes;
    garderPreferences();
    appliquerLesReperes();
    peuplerPreferences();
  });
}

/** Ouvre les reglages, d'ou qu'on les demande : le jeu, ou le bandeau. */
function ouvrirLesPreferences(): void {
  peuplerPreferences();
  $("prefs").hidden = false;
}

$("prefs-open").addEventListener("click", ouvrirLesPreferences);
$("prefs-close").addEventListener("click", () => { $("prefs").hidden = true; });

lirePreferences();
setReperes(prefs.reperes);
appliquerLesTailles();
appliquerLeTheme();
appliquerLesHauteurs();

// ---------------------------------------------------------------- chronos

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
  // LE TEMPS DE LA PARTIE EST LA SOMME DE SES COUPS, PAS L'HORLOGE DU MUR.
  //
  // Entre deux coups, le serveur cherche le top -- une seconde et demie sur une
  // grande grille. Ce temps-la n'appartient a personne : ni au coup qui vient
  // de tomber, ni a celui qui n'a pas encore commence. Le compteur se fige donc
  // pendant le calcul et reprend quand le coup part.
  //
  // Ce qui se lit alors tombe juste : « Temps » vaut exactement le cumul des
  // coups joues plus le coup en cours, et l'on peut suivre l'un par l'autre.
  // Un salon endormi ne compte pas non plus : personne n'y cherche, et le
  // chrono repart a plein au premier arrivant -- le total reculerait.
  const enCours = solving || finie || !demarree || endormi || decompteJusqua > now
    ? 0 : Math.max(0, now - servedAt);
  $("age").textContent = demarree ? fmtSecondes(tempsJoue + enCours) : "—";
  if (finie) { $("elapsed").textContent = "—"; return; }
  if (dureeMax !== null && debutDeLaPartie !== 0 && demarree) {
    const reste = Math.max(0, debutDeLaPartie + dureeMax * 1000 - now);
    const mn = Math.floor(reste / 60000), sc = Math.floor((reste % 60000) / 1000);
    $("rb-reste").textContent = `${mn}:${String(sc).padStart(2, "0")}`;
  }
  if (!demarree) { $("elapsed").textContent = "—"; return; }
  if (endormi) { $("elapsed").textContent = "en pause"; return; }
  if (solving) { $("elapsed").textContent = "…"; return; }
  if (chrono === null) { $("elapsed").textContent = fmtSecondes(enCours); return; }
  // Compte a rebours : c'est le temps qui reste qui interesse le joueur.
  const reste = Math.max(0, servedAt + chrono * 1000 - now);
  $("elapsed").textContent = `${Math.ceil(reste / 1000)} s`;
  $("elapsed").style.color = reste < 6000 ? "var(--warn)" : "";
}, 200);

// ---------------------------------------------------------------- reseau

function applyState(s: {
  rack?: string; moveNumber: number; cumul: number; solving: boolean;
  players?: Record<string, number>; online?: string[]; verifies?: string[];
  noms?: Record<string, string>; inscrits?: string[];
  last?: MoveInfo | null;
  likes?: Record<string, number>; sac?: string; finie?: boolean; chrono?: number | null;
  actif?: boolean; mode?: string; nonTrouves?: number; decompteJusqua?: number;
  gerant?: string | null;
  tempsJoue?: number; rejeuOuvert?: boolean; permanent?: boolean;
  demarree?: boolean; coupsMax?: number | null;
  dureeMax?: number | null; debutDeLaPartie?: number;
  points?: Record<string, number>; negatif?: Record<string, number>;
  tops?: Record<string, number>;
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
  // LA BANDE DU RELIQUAT NE DOIT PAS CHANGER LA HAUTEUR DU PLATEAU.
  //
  // Elle vit AU-DESSUS de la grille, dans le flux : la faire apparaitre ou
  // disparaitre, ou la laisser passer a deux lignes, redimensionne le canevas.
  // Sur un plateau borne, `cadrer()` recalcule alors la taille des cases et
  // recentre tout : la grille sursaute. Sa presence ne depend donc plus de son
  // CONTENU -- qui change a chaque coup et finit vide -- mais de la variante,
  // qui ne change pas de la partie.
  const sac = s.sac ?? "";
  $("sac").hidden = cfg.pioche === "probabilites";
  $("sac").textContent = sac;
  chrono = s.chrono ?? null;
  endormi = s.actif === false;
  duplicate = s.mode === "duplicate";
  nonTrouves = s.nonTrouves ?? 0;
  // Les manettes changent de mains sans qu'on se reconnecte : le bouton des
  // reglages suit l'etat, pas le seul message d'accueil.
  gerant = s.gerant ?? null;
  permanent = s.permanent === true;
  // UNE GRILLE PERMANENTE NE SE REREGLE PAS. Relancer, c'est archiver la partie
  // en cours et en ouvrir une neuve : sur une grille d'etude qui porte onze
  // mille coups, c'est le geste qu'on ne veut surtout pas faire par megarde. Le
  // serveur le refuse aussi -- un bouton cache est un garde-fou, pas une regle.
  $("reglages-open").hidden = gerant !== me || permanent;
  decompteJusqua = s.decompteJusqua ?? 0;
  demarree = s.demarree !== false;
  coupsMax = s.coupsMax ?? null;
  dureeMax = s.dureeMax ?? null;
  debutDeLaPartie = s.debutDeLaPartie ?? 0;
  tempsJoue = s.tempsJoue ?? 0;
  rejeuOuvert = s.rejeuOuvert === true;
  points = s.points ?? {};
  negatif = s.negatif ?? {};
  tops = s.tops ?? {};
  // Le serveur a-t-il ete relance depuis la derniere compilation du client ?
  // Sinon les reglages partent dans le vide et on croit a un bug du jeu.
  // Un serveur qui ne dit rien est forcement anterieur a ce controle : c'est
  // justement le cas qu'il faut attraper.
  if (s.demarreA === undefined || s.demarreA < __COMPILE_A__) {
    $("perime").hidden = false;
  }
  finie = s.finie === true;
  online = s.online ?? [];
  verifies = new Set(s.verifies ?? []);
  nomsPublics = s.noms ?? {};
  // LES LIGNES DE CHAT SONT PEINTES AVANT QUE L'ETAT N'ARRIVE, et rien ne les
  // repeint ensuite : sans cela, les pseudos deja affiches n'apprenaient jamais
  // qu'ils menent a une fiche. On ne repeint que si la liste a vraiment change.
  const neufs = s.inscrits ?? [];
  const memeListe = neufs.length === inscrits.size && neufs.every((n) => inscrits.has(n));
  inscrits = new Set(neufs);
  if (!memeListe) paintChat(chat);
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
      // Seul le gerant regle son salon. La grille permanente n'en a pas.
      gerant = m.gerant ?? null;
      salonPermanent = m.proprietaire === null;
      permanent = m.permanent === true;
      $("reglages-open").hidden = gerant !== me || permanent;
      $("conn").textContent = `${me} · ${m.nomSalon}`;
      // Une partie qui n'a pas commence s'ouvre sur ses reglages : c'est la
      // qu'on choisit la variante avant de lancer quoi que ce soit.
      // Une grille permanente ne s'ouvre pas non plus sur ses reglages : elle
      // n'est pas la pour etre reglee, meme le jour ou on la cree.
      if (m.state?.demarree === false && m.gerant === me && !permanent) {
        setTimeout(ouvrirReglages, 60);
      }
      board.place(tiles.map((t: Tile): Placement => ({ x: t.x, y: t.y, letter: t.l, blank: t.b === 1 })));
      accorderLeDictionnaire();
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
      // UN REFUS NE PARLE PAS TOUJOURS DU PSEUDO. Cliquer un salon disparu
      // ouvrait le voile qui demande un nom -- ce qui n'avait aucun rapport, et
      // donnait a croire qu'il fallait se reconnecter. Seul un refus qui porte
      // sur le nom rouvre ce voile ; les autres se disent sur l'accueil.
      if (m.quoi === "pseudo") {
        demanderLePseudo(salonChoisi === "" ? null : salonChoisi);
        $("join-error").textContent = m.message;
        $("join-error").hidden = false;
        ($("name") as HTMLInputElement).select();
      } else {
        $("c-error").textContent = m.message;
        $("c-error").hidden = false;
      }
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
      accorderLeDictionnaire();
      typed = ""; ghost = null; best = null; finie = false;
      cursor = null; marks = [];
      paintChat(chat);
      paintJournal();
      applyState(m.state);
      // La relance a pu changer de grille : on recadre selon la NOUVELLE.
      if (cfg.bornes !== null) cadrer();
      else { ox = W / 2 - cell / 2; oy = H / 2 - cell / 2; }
      // Rien a annoncer : la grille s'est videe, le compteur est revenu a 1 et
      // le tirage a change. Un bandeau qui repete ce que l'ecran montre deja
      // masque la grille au moment ou l'on veut justement la regarder.
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
      // EN REJEU, LE MOT EN EVIDENCE EST CE QU'ON EXAMINE. Un coup qui tombe
      // ailleurs ne doit pas l'effacer -- on regarde le passe, pas le direct.
      // La regle datait des parties closes, ou aucun coup ne tombe plus ; elle
      // s'est mise a mordre le jour ou le rejeu s'est ouvert sur une partie en
      // cours, qui pose un coup toutes les deux secondes.
      if (rejeu === null) ghost = null;
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
      //
      // Rien non plus pour le coup que personne n'a trouve : le tableau « Top »
      // le dit maintenant en toutes lettres, jeton rouge et points rouges. Un
      // bandeau qui repete la meme chose une seconde plus bas n'apprend rien --
      // et il masquait le bas de la grille au moment ou l'on y regarde le mot.
      const trouve = duplicate ? trouveursDuCoup(mv).length > 0 : mv.player !== null;
      // Un coup qui a dure sur la grille permanente : la sonnerie dit combien
      // de temps il a resiste. Celui qui l'a trouve l'entend aussi -- il le
      // sait deja, mais se voir feliciter fait plaisir.
      if (salonPermanent && trouve && mv.ms >= SEUIL_SONNERIE_MS) sonner(mv.ms);
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
  permanent?: boolean;
  coups: number; finie: boolean; connectes: number;
  /** Le total des points. Absent tant que le serveur n'a pas ete relance. */
  cumul?: number;
  config: {
    tirage: number; jouables: number; pioche: string; bornes: number | null;
    joker?: boolean; chrono?: number | null; mode?: string;
    /** Absent des serveurs d'avant les dictionnaires multiples : c'etait le francais. */
    dictionnaire?: string;
  };
}

/**
 * L'ACCROCHE DU SALON STAR.
 *
 * Elle ne vient pas du serveur : c'est la promesse du site, pas l'etat d'une
 * partie. Elle vit ici, en un seul endroit.
 */
const ACCROCHE_STAR = [
  "Grille infinie, sans limite de temps, sans fin.",
  "Jusqu'où pourrons-nous aller ?",
  "Rejoignez la plus grande partie de topping jamais créée.",
];

/** Le filtre en cours. Il ne trie que la liste deja recue : aucun aller-retour. */
let filtre: "tous" | "bornee" | "infinie" | "attente" = "tous";

/** La derniere liste recue du serveur. Les filtres repeignent depuis elle. */
let salonsRecus: ResumeSalon[] = [];

// ---------------------------------------------------------------- le compte

/**
 * LE COMPTE EST OPTIONNEL (SPEC.md §8).
 *
 * Trois etats, et non deux : on peut n'etre personne, etre quelqu'un sous un
 * pseudo local -- comme depuis toujours --, ou etre quelqu'un dont le serveur
 * garantit le nom. Le troisieme n'enleve rien au deuxieme : le site reste
 * ouvert a qui ne veut pas s'inscrire.
 */
interface MonCompte {
  pseudo: string; verifie: boolean;
  /** L'adresse a-t-elle ete confirmee par son porteur ? */
  emailVerifie: boolean;
  avatar: number;
  /** L'avatar garde les couleurs du jour ou on l'a tire : il ne suit pas le theme. */
  avatarSombre: boolean;
  /** Jamais lue par les autres joueurs : elle ne sert qu'a nous retrouver. */
  email: string;
  prenom: string; nom: string; nomPublic: boolean;
  demande: boolean; admin: boolean;
}

/** Le theme en cours, tel que la feuille de style le voit. */
function themeSombre(): boolean {
  const pose = document.documentElement.dataset["theme"];
  if (pose === "dark") return true;
  if (pose === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

let moiCompte: MonCompte | null = null;

/** Demande au serveur qui nous sommes. Le cookie parle a notre place. */
async function lireLeCompte(): Promise<void> {
  try {
    const d = await (await fetch("/api/moi")).json();
    moiCompte = d.compte ?? null;
  } catch { moiCompte = null; }
  if (moiCompte !== null) {
    // Le pseudo du compte l'emporte sur celui qui trainait dans le navigateur :
    // c'est sous ce nom-la que le serveur nous fera jouer, de toute facon.
    ($("name") as HTMLInputElement).value = moiCompte.pseudo;
    try { localStorage.setItem("pseudo", moiCompte.pseudo); } catch { /* navigation privee */ }
  }
}

/**
 * L'AVATAR EST UN PAVE DE LA GRILLE.
 *
 * Pas une initiale dans un rond, pas une image a televerser -- qu'il faudrait
 * heberger et moderer : un carre de cinq cases pris dans le motif des primes,
 * a un endroit qui n'appartient qu'a vous. C'est le meme dessin que le plateau,
 * donc le site se reconnait dans ses avatars.
 */
/**
 * LES COULEURS DE L'AVATAR SONT ECRITES ICI, PAS LUES DANS LE THEME.
 *
 * Elles repetent les jetons du plateau, a dessein : un avatar ne doit PAS
 * changer de couleurs parce que son porteur a bascule son ecran en sombre. Il
 * changeait a chaque ouverture de profil, comme s'il ne lui appartenait pas.
 * C'est une image qu'on s'est choisie ; elle ne bouge que si on la redemande.
 */
const TEINTES_AVATAR = {
  clair: { T: "#C2493D", D: "#E08D7E", "*": "#E08D7E", t: "#3B7DA4", d: "#90BCD4", ".": "#E3E8E5" },
  sombre: { T: "#99392F", D: "#B2665A", "*": "#B2665A", t: "#2E5D7C", d: "#4C84A2", ".": "#17211D" },
} as const;

function peindreAvatar(cible: HTMLElement, graine: number, cote: number, sombre: boolean): void {
  const dpr = Math.min(3, devicePixelRatio || 1);
  const cv = document.createElement("canvas");
  cv.width = Math.round(cote * dpr);
  cv.height = Math.round(cote * dpr);
  const g = cv.getContext("2d");
  if (g === null) return;
  g.scale(dpr, dpr);
  const cases = 5;
  const pas = cote / cases;
  // La graine choisit l'endroit du pavage : deux octets, deux coordonnees.
  const ox = (graine & 0xff) - 128;
  const oy = ((graine >> 8) & 0xff) - 128;
  const teintes: Record<string, string> = sombre ? TEINTES_AVATAR.sombre : TEINTES_AVATAR.clair;
  for (let y = 0; y < cases; y++) {
    for (let x = 0; x < cases; x++) {
      g.fillStyle = teintes[bonusChar(ox + x, oy + y)] ?? teintes["."]!;
      g.fillRect(x * pas, y * pas, pas + 0.5, pas + 0.5);
    }
  }
  cible.replaceChildren(cv);
}

/** Ouvre le panneau de connexion, sur l'un ou l'autre de ses onglets. */
let ongletCompte: "connexion" | "inscription" = "connexion";
function ouvrirLeCompte(onglet: "connexion" | "inscription" = "connexion"): void {
  ongletCompte = onglet;
  peindreOngletsDuCompte();
  $("c-compte-error").hidden = true;
  ($("c-pseudo") as HTMLInputElement).value = pseudo();
  ($("c-mdp") as HTMLInputElement).value = "";
  $("voile-compte").hidden = false;
  ($("c-pseudo") as HTMLInputElement).focus();
}

function peindreOngletsDuCompte(): void {
  for (const b of $("compte-onglets").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === ongletCompte));
  }
  const inscrit = ongletCompte === "inscription";
  $("c-email").hidden = !inscrit;
  $("compte-titre").textContent = inscrit ? "Inscription" : "Connexion";
  $("c-valider").textContent = inscrit ? "Créer mon compte" : "Se connecter";
  ($("c-mdp") as HTMLInputElement).autocomplete = inscrit ? "new-password" : "current-password";
}

/**
 * LE PROFIL EST UNE PAGE, pas une fenetre.
 *
 * Il prend la place du mur de salons sous le meme bandeau, et porte son adresse
 * -- `?page=profil` -- pour qu'on puisse y revenir, la garder en signet, et
 * ressortir par le bouton « precedent » du navigateur.
 */
function ouvrirLeProfil(pousser = true): void {
  if (moiCompte === null) { ouvrirLeCompte(); return; }
  $("perso-pseudo").textContent = moiCompte.pseudo;
  $("perso-badge").hidden = !moiCompte.verifie;
  ($("mdp-ancien") as HTMLInputElement).value = "";
  ($("mdp-neuf") as HTMLInputElement).value = "";
  $("mdp-error").hidden = true;
  $("mdp-fait").hidden = true;
  peindreAvatar($("perso-avatar"), moiCompte.avatar, 84, moiCompte.avatarSombre);
  ($("perso-prenom") as HTMLInputElement).value = moiCompte.prenom;
  ($("perso-nom") as HTMLInputElement).value = moiCompte.nom;
  ($("perso-email") as HTMLInputElement).value = moiCompte.email;
  $("perso-public").setAttribute("aria-pressed", String(moiCompte.nomPublic));
  peindreLeNomPublic();
  $("perso-admin").hidden = !moiCompte.admin;
  peindreLEtatDuMail();
  $("perso-error").hidden = true;
  peindreLaVerification();
  $("corps-salons").hidden = true;
  $("corps-profil").hidden = false;
  $("join").hidden = false;
  if (pousser) window.history.pushState({ page: "compte" }, "", "?page=compte");
}

/** Referme le profil et rend la place au mur de salons. */
function fermerLeProfil(pousser = true): void {
  $("corps-profil").hidden = true;
  $("corps-salons").hidden = false;
  if (pousser) window.history.pushState({ page: "salons" }, "", location.pathname);
}

// Le bouton « precedent » du navigateur suit la page, comme partout ailleurs.
addEventListener("popstate", () => {
  const veutLeProfil = new URLSearchParams(location.search).get("page") === "compte";
  if (veutLeProfil && moiCompte !== null) ouvrirLeProfil(false);
  else fermerLeProfil(false);
});

/** Les trois etats de la verification, et ce qu'on peut en faire. */
function peindreLaVerification(): void {
  const boite = $("perso-verif");
  boite.replaceChildren();
  if (moiCompte === null) return;
  boite.appendChild(el("h2", "", "Vérification"));
  const dit = el("p");
  if (moiCompte.verifie) {
    dit.textContent = "Votre identité a été vérifiée. La pastille suit votre pseudo.";
    boite.appendChild(dit);
    return;
  }
  if (moiCompte.demande) {
    dit.className = "attente";
    dit.textContent = "Demande déposée.";
    boite.appendChild(dit);
    return;
  }
  const b = el("button", "appliquer", "Demander la vérification") as HTMLButtonElement;
  b.type = "button";
  b.addEventListener("click", () => { void demanderLaVerif(); });
  boite.appendChild(b);
  boite.appendChild(el("p", "apres-bouton",
    "Demandez à être un joueur vérifié (les joueurs vérifiés n'auront leur nom "
    + "affiché que s'ils le veulent)."));
}

/** Enregistre le profil. Le nom part au serveur, le reste suit. */
async function enregistrerLeProfil(): Promise<boolean> {
  if (moiCompte === null) return false;
  const r = await fetch("/api/moi", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prenom: ($("perso-prenom") as HTMLInputElement).value,
      nom: ($("perso-nom") as HTMLInputElement).value,
      nomPublic: $("perso-public").getAttribute("aria-pressed") === "true",
      email: ($("perso-email") as HTMLInputElement).value,
      avatar: moiCompte.avatar,
      avatarSombre: moiCompte.avatarSombre,
    }),
  });
  const d = await r.json();
  if (!r.ok) {
    $("perso-error").textContent = d.erreur ?? "enregistrement impossible";
    $("perso-error").hidden = false;
    return false;
  }
  moiCompte = d.compte;
  return true;
}

async function demanderLaVerif(): Promise<void> {
  // ON NE VERIFIE PAS QUELQU'UN QUI NE S'EST PAS NOMME : c'est son identite
  // qu'on va confronter, et le dire ici evite un aller-retour pour rien.
  const prenom = ($("perso-prenom") as HTMLInputElement).value.trim();
  const nom = ($("perso-nom") as HTMLInputElement).value.trim();
  if (prenom === "" || nom === "") {
    $("perso-error").textContent =
      "Renseignez votre prénom et votre nom : c'est votre identité qui se vérifie.";
    $("perso-error").hidden = false;
    ($(prenom === "" ? "perso-prenom" : "perso-nom") as HTMLInputElement).focus();
    return;
  }
  // Le nom en cours de saisie part AVANT la demande : sans cela on demanderait
  // la verification d'un nom que le serveur n'a pas encore recu.
  if (!(await enregistrerLeProfil())) return;
  const r = await fetch("/api/verification", { method: "POST" });
  const d = await r.json();
  if (!r.ok) {
    $("perso-error").textContent = d.erreur ?? "demande impossible";
    $("perso-error").hidden = false;
    return;
  }
  moiCompte = d.compte;
  $("perso-error").hidden = true;
  peindreLaVerification();
}

/**
 * Ouvre la fiche d'un joueur.
 *
 * Elle ne montre que ce que le serveur accepte de dire de lui : son avatar, sa
 * pastille, et son nom s'il a choisi de le rendre public. Rien d'autre
 * n'existe encore -- les statistiques viendront s'y loger.
 */
async function ouvrirLaFiche(qui: string): Promise<void> {
  $("fiche-pseudo").textContent = qui;
  $("fiche-nom").hidden = true;
  $("fiche-badge").hidden = true;
  $("fiche-error").hidden = true;
  $("fiche-avatar").replaceChildren();
  $("voile-joueur").hidden = false;
  let d: { joueur?: { pseudo: string; verifie: boolean; avatar: number; avatarSombre: boolean; nom?: string } };
  try { d = await (await fetch(`/api/joueur/${encodeURIComponent(qui)}`)).json(); }
  catch { d = {}; }
  const j = d.joueur;
  if (j === undefined) {
    $("fiche-error").textContent = "Ce joueur n'a pas de compte.";
    $("fiche-error").hidden = false;
    return;
  }
  $("fiche-pseudo").textContent = j.pseudo;
  $("fiche-badge").hidden = !j.verifie;
  peindreAvatar($("fiche-avatar"), j.avatar, 84, j.avatarSombre);
  if (j.nom !== undefined) {
    $("fiche-nom").textContent = j.nom;
    $("fiche-nom").hidden = false;
  }
}

$("fiche-close").addEventListener("click", () => { $("voile-joueur").hidden = true; });
$("voile-joueur").addEventListener("click", (e) => {
  if (e.target === $("voile-joueur")) $("voile-joueur").hidden = true;
});

/** La liste des demandes, pour qui a le droit de trancher. */
async function ouvrirLAdministration(): Promise<void> {
  const boite = $("admin-liste");
  boite.replaceChildren(el("div", "none", "chargement…"));
  $("voile-admin").hidden = false;
  let d: { demandes: any[] };
  try { d = await (await fetch("/api/admin/demandes")).json(); }
  catch { boite.replaceChildren(el("div", "none", "serveur injoignable")); return; }
  boite.replaceChildren();
  if (!Array.isArray(d.demandes) || d.demandes.length === 0) {
    boite.appendChild(el("div", "none", "aucune demande, aucun joueur vérifié"));
    return;
  }
  for (const v of d.demandes) {
    const ligne = el("div", "demande");
    const qui = el("div");
    qui.appendChild(el("b", "", v.pseudo));
    qui.appendChild(document.createElement("br"));
    qui.appendChild(el("span", "vrai", v.nomReel || "— sans nom —"));
    if (v.email) qui.appendChild(el("span", "mail", v.email));
    ligne.appendChild(qui);
    const actions = el("span", "actions");
    if (v.verifie) {
      actions.appendChild(el("span", "vrai", "vérifié"));
      const non = el("button", "non", "Retirer") as HTMLButtonElement;
      non.type = "button";
      non.addEventListener("click", () => { void trancher(v.pseudo, false); });
      actions.appendChild(non);
    } else {
      const oui = el("button", "oui", "Vérifier") as HTMLButtonElement;
      oui.type = "button";
      oui.addEventListener("click", () => { void trancher(v.pseudo, true); });
      const non = el("button", "non", "Refuser") as HTMLButtonElement;
      non.type = "button";
      non.addEventListener("click", () => { void trancher(v.pseudo, false); });
      actions.appendChild(oui);
      actions.appendChild(non);
    }
    ligne.appendChild(actions);
    boite.appendChild(ligne);
  }
}

async function trancher(pseudoCible: string, verifie: boolean): Promise<void> {
  await fetch("/api/admin/verdict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pseudo: pseudoCible, verifie }),
  });
  await ouvrirLAdministration();
}

// Les onglets du panneau de connexion.
for (const b of $("compte-onglets").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    ongletCompte = (b as HTMLElement).dataset["v"] === "inscription" ? "inscription" : "connexion";
    peindreOngletsDuCompte();
  });
}

$("form-compte").addEventListener("submit", (e) => {
  e.preventDefault();
  void envoyerLeCompte();
});

async function envoyerLeCompte(): Promise<void> {
  const pseudoDonne = ($("c-pseudo") as HTMLInputElement).value.trim();
  const mdp = ($("c-mdp") as HTMLInputElement).value;
  const email = ($("c-email") as HTMLInputElement).value.trim();
  const chemin = ongletCompte === "inscription" ? "/api/inscription" : "/api/connexion";
  const r = await fetch(chemin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pseudo: pseudoDonne, motDePasse: mdp, email,
      // L'avatar nait aux couleurs du theme sous lequel on s'inscrit.
      avatarSombre: themeSombre(),
    }),
  });
  const d = await r.json();
  if (!r.ok) {
    $("c-compte-error").textContent = d.erreur ?? "impossible";
    $("c-compte-error").hidden = false;
    return;
  }
  moiCompte = d.compte;
  ($("name") as HTMLInputElement).value = moiCompte!.pseudo;
  try { localStorage.setItem("pseudo", moiCompte!.pseudo); } catch { /* navigation privee */ }
  $("voile-compte").hidden = true;
  ($("c-mdp") as HTMLInputElement).value = "";
  // On repart ou l'on allait, exactement comme apres avoir donne un pseudo.
  const ou = destination;
  destination = null;
  if (ou !== null) { void rejoindre(ou); return; }
  peindreAccueil();
}

$("c-sans-compte").addEventListener("click", () => {
  $("voile-compte").hidden = true;
  demanderLePseudo(destination);
});

$("perso-close").addEventListener("click", () => {
  void (async () => {
    if (await enregistrerLeProfil()) { fermerLeProfil(); peindreAccueil(); }
  })();
});

$("perso-public").addEventListener("click", () => {
  const b = $("perso-public");
  b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
  peindreLeNomPublic();
});

/**
 * L'ESPACE PERSONNEL N'EST PAS LE PROFIL.
 *
 * Ici l'on regle ce qui nous appartient ; le profil est ce que les autres
 * lisent. Le pseudo mene de l'un a l'autre, ce qui est la seule facon de voir
 * ce qu'on montre vraiment.
 */
$("perso-pseudo").addEventListener("click", () => {
  if (moiCompte !== null) void ouvrirLaFiche(moiCompte.pseudo);
});

$("mdp-changer").addEventListener("click", () => { void changerMonMotDePasse(); });

async function changerMonMotDePasse(): Promise<void> {
  const ancien = ($("mdp-ancien") as HTMLInputElement).value;
  const nouveau = ($("mdp-neuf") as HTMLInputElement).value;
  $("mdp-fait").hidden = true;
  const r = await fetch("/api/motdepasse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ancien, nouveau }),
  });
  const d = await r.json();
  if (!r.ok) {
    $("mdp-error").textContent = d.erreur ?? "changement impossible";
    $("mdp-error").hidden = false;
    return;
  }
  $("mdp-error").hidden = true;
  ($("mdp-ancien") as HTMLInputElement).value = "";
  ($("mdp-neuf") as HTMLInputElement).value = "";
  $("mdp-fait").className = "apres fait";
  $("mdp-fait").hidden = false;
}

$("perso-nom").addEventListener("input", peindreLeNomPublic);
$("perso-prenom").addEventListener("input", peindreLeNomPublic);

/**
 * L'etat de l'adresse : confirmee, ou pas encore.
 *
 * Rien ne part encore -- le lien s'ecrit dans la console de l'hote. L'ecran
 * dit donc la verite : l'adresse n'a jamais ete verifiee.
 */
function peindreLEtatDuMail(): void {
  const boite = $("etat-mail");
  boite.replaceChildren();
  if (moiCompte === null || moiCompte.email === "") return;
  if (moiCompte.emailVerifie) {
    boite.appendChild(el("span", "verifiee", "Adresse vérifiée."));
    return;
  }
  boite.appendChild(el("span", "attente", "Adresse non vérifiée."));
  const b = el("button", "", "Envoyer le lien") as HTMLButtonElement;
  b.type = "button";
  b.addEventListener("click", () => { void demanderLeLienDeMail(b); });
  boite.appendChild(b);
}

async function demanderLeLienDeMail(b: HTMLButtonElement): Promise<void> {
  b.disabled = true;
  const r = await fetch("/api/email/envoyer", { method: "POST" });
  const d = await r.json();
  b.disabled = false;
  if (!r.ok) {
    $("mdp-error").textContent = d.erreur ?? "envoi impossible";
    $("mdp-error").hidden = false;
    return;
  }
  b.replaceWith(el("span", "", " Lien demandé."));
}

/**
 * Le nom sous le pseudo : c'est CE QUE LES AUTRES VERRONT.
 *
 * L'interrupteur seul demandait de se fier a une promesse. Montrer le nom a sa
 * place, sur son propre profil, dit exactement ce qu'on rend public -- et le
 * fait disparaitre quand on rend l'interrupteur.
 */
function peindreLeNomPublic(): void {
  const prenom = ($("perso-prenom") as HTMLInputElement).value.trim();
  const nom = ($("perso-nom") as HTMLInputElement).value.trim();
  const complet = `${prenom} ${nom}`.trim();
  const ouvert = $("perso-public").getAttribute("aria-pressed") === "true";
  $("perso-nom-public").textContent = complet;
  $("perso-nom-public").hidden = !ouvert || complet === "";
}

$("perso-avatar-neuf").addEventListener("click", () => {
  if (moiCompte === null) return;
  // On en tire un neuf AUX COULEURS DU MOMENT : c'est le seul instant ou le
  // theme decide de quelque chose, parce que c'est le seul ou on l'a demande.
  moiCompte.avatar = Math.floor(Math.random() * 65536);
  moiCompte.avatarSombre = themeSombre();
  peindreAvatar($("perso-avatar"), moiCompte.avatar, 84, moiCompte.avatarSombre);
});

$("perso-admin").addEventListener("click", () => { void ouvrirLAdministration(); });
$("admin-close").addEventListener("click", () => { $("voile-admin").hidden = true; });

$("perso-sortir").addEventListener("click", () => {
  void (async () => {
    await fetch("/api/deconnexion", { method: "POST" });
    moiCompte = null;
    // SE DECONNECTER, C'EST REDEVENIR UN VISITEUR. Garder le pseudo dans le
    // champ menait droit dans un mur : il appartient a un compte, desormais, et
    // la partie suivante aurait ete refusee sans qu'on comprenne pourquoi.
    ($("name") as HTMLInputElement).value = "";
    try { localStorage.removeItem("pseudo"); } catch { /* navigation privee */ }
    fermerLeProfil();
    peindreAccueil();
  })();
});

/** Ou l'on voulait aller quand on nous a demande notre pseudo. */
let destination: string | null = null;

/** Le pseudo tel qu'il est saisi. Tant qu'il est vide, on est un visiteur. */
const pseudo = (): string => ($("name") as HTMLInputElement).value.trim();

/**
 * LA DUREE SEULE, JAMAIS LE MOT « BLITZ ».
 *
 * Une minute s'ecrit `60 s` et non `1 min` : a cette echelle-la on compte
 * encore en secondes, et deux salons voisins se comparent d'un coup d'oeil.
 */
function dureeDuChrono(c: number | null | undefined): string {
  if (c === null || c === undefined) return "sans chrono";
  return c < 120 || c % 60 !== 0 ? `${c} s` : `${c / 60} min`;
}

/**
 * LE NOM DE LA VARIANTE.
 *
 * Sept lettres tirees, sept jouables : c'est la partie que tout le monde
 * connait, et elle s'appelle « Normale ». Les autres se nomment par ce qui les
 * en ecarte -- `7 sur 9` se lit tout seul, « Normale » ne se devine pas.
 */
function nomDeLaVariante(c: ResumeSalon["config"]): string {
  return c.tirage === 7 && c.jouables === 7 ? "Normal" : `${c.jouables} sur ${c.tirage}`;
}

/**
 * CE QUI DISTINGUE DEUX SALONS, ET RIEN D'AUTRE.
 *
 * La pioche n'y figure pas : « probabilites ponderees » est illisible pour qui
 * arrive, et n'a jamais aide personne a choisir un salon.
 */
function specDuSalon(c: ResumeSalon["config"]): string {
  // LE MODE EN TETE : c'est ce qui change le plus la partie qu'on va trouver,
  // et il ne se lisait nulle part.
  const mode = c.mode === "duplicate" ? "Duplicate" : "Topping";
  return [mode, nomDeLaVariante(c), dureeDuChrono(c.chrono)]
    .concat(c.joker === true ? ["joker"] : [])
    .join(" · ");
}

/** `15×15`, `21×21`… ou l'infini. */
function courtDeLaGrille(bornes: number | null): string {
  return bornes === null ? "∞" : `${bornes * 2 + 1}×${bornes * 2 + 1}`;
}

/** Les chiffres se lisent par tranches de trois, comme partout ailleurs. */
const chiffres = (n: number): string => n.toLocaleString("fr-FR");

/** Le filtre s'applique a tous les salons, la grille mondiale comprise. */
function retenu(s: ResumeSalon): boolean {
  if (filtre === "bornee") return s.config.bornes !== null;
  if (filtre === "infinie") return s.config.bornes === null;
  if (filtre === "attente") return s.coups === 0;
  return true;
}

/** Un element, sa classe, son texte : le DOM se construit a la main. */
function el(tag: string, classe = "", texte = ""): HTMLElement {
  const e = document.createElement(tag);
  if (classe !== "") e.className = classe;
  if (texte !== "") e.textContent = texte;
  return e;
}

/**
 * Aller dans un salon, en se nommant d'abord si l'on ne s'est pas nomme.
 *
 * LE PSEUDO EST DEMANDE AU DERNIER MOMENT, et l'on revient exactement la ou
 * l'on voulait aller. Les comptes (SPEC.md §8) sont OPTIONNELS : rien ici ne
 * barre le site a qui arrive.
 */
function allerA(id: string): void {
  if (pseudo() === "") { demanderLePseudo(id); return; }
  void rejoindre(id);
}

/** Ouvre le voile du pseudo. `ou` est la destination a reprendre ensuite. */
function demanderLePseudo(ou: string | null): void {
  destination = ou;
  $("pseudo-quoi").textContent = ou === null
    ? "Il vous suit d'un salon à l'autre."
    : "Un nom, et vous entrez. Il vous suit d'un salon à l'autre.";
  $("join-error").hidden = true;
  $("voile").hidden = false;
  ($("name") as HTMLInputElement).focus();
}

/**
 * Le cote droit du bandeau : Records, le compte, et la roue des reglages.
 *
 * La roue n'apparait qu'une fois nomme : elle regle des choses qui n'ont de
 * sens qu'en jouant, et le bandeau du visiteur ne porte qu'une seule porte.
 */
function peindreCompte(): void {
  const boite = $("compte");
  boite.replaceChildren();

  const records = el("button", "records", "Records") as HTMLButtonElement;
  records.type = "button";
  records.addEventListener("click", () => { $("voile-records").hidden = false; });
  boite.appendChild(records);

  const moi = pseudo();

  // Nomme, mais sans compte : on montre sous quel nom on joue, et la porte du
  // compte reste ouverte a cote.
  if (moiCompte === null && moi !== "") {
    const b = el("button", "moi") as HTMLButtonElement;
    b.type = "button";
    b.title = "Changer de pseudo";
    b.appendChild(el("span", "avatar", moi.slice(0, 1).toUpperCase()));
    b.appendChild(el("span", "", moi));
    b.addEventListener("click", () => demanderLePseudo(null));
    boite.appendChild(b);
  }

  if (moiCompte === null) {
    const b = el("button", "entrer", "Connexion / Inscription") as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => ouvrirLeCompte());
    boite.appendChild(b);
    return;
  }

  const b = el("button", "moi") as HTMLButtonElement;
  b.type = "button";
  b.title = "Votre profil";
  const rond = el("span", "avatar");
  peindreAvatar(rond, moiCompte.avatar, 30, moiCompte.avatarSombre);
  b.appendChild(rond);
  b.appendChild(el("span", "", moiCompte.pseudo));
  if (moiCompte.verifie) b.appendChild(el("span", "pastille", "vérifié"));
  b.addEventListener("click", () => ouvrirLeProfil());
  boite.appendChild(b);

  const roue = el("button", "icon roue") as HTMLButtonElement;
  roue.type = "button";
  roue.title = "Paramètres";
  roue.setAttribute("aria-label", "Paramètres");
  roue.innerHTML = ICONE_ROUE;
  roue.addEventListener("click", () => ouvrirLesPreferences());
  boite.appendChild(roue);
}

/**
 * La barre de filtres, et — SEULEMENT SI L'ON S'EST NOMME — « Créer un salon ».
 *
 * Le bouton n'est pas masque : il n'existe pas dans le DOM du visiteur.
 */
function peindreFiltres(): void {
  const barre = $("filtres");
  barre.replaceChildren();
  const puces: [typeof filtre, string][] = [
    ["tous", "Tous"], ["bornee", "15×15"], ["infinie", "Infinie"],
    ["attente", "En attente"],
  ];
  for (const [cle, texte] of puces) {
    const b = el("button", "puce", texte) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(filtre === cle));
    b.addEventListener("click", () => { filtre = cle; peindreAccueil(); });
    barre.appendChild(b);
  }
  if (pseudo() === "") return;
  const creer = el("button", "creer-bar", "Créer un salon") as HTMLButtonElement;
  creer.type = "button";
  creer.addEventListener("click", () => { void creerSalon(); });
  barre.appendChild(creer);
}

/** La tuile du salon star : la grille mondiale, deux colonnes sur deux rangees. */
function tuileStar(s: ResumeSalon): HTMLElement {
  const t = el("button", "star") as HTMLButtonElement;
  t.type = "button";

  const pastille = el("span", "enligne");
  pastille.appendChild(el("span", "point"));
  pastille.appendChild(el("span", "", `${s.connectes} en ligne`));
  t.appendChild(pastille);

  t.appendChild(el("span", "surtitre", "Salon star"));
  t.appendChild(el("span", "titre", s.nom));
  const accroche = el("span", "accroche");
  for (const ligne of ACCROCHE_STAR) accroche.appendChild(el("span", "", ligne));
  t.appendChild(accroche);

  const action = el("span", "action");
  action.appendChild(el("span", "jouer", "Jouer"));
  // Le cumul manque tant que le serveur tourne une version anterieure : on
  // affiche alors le coup seul plutot qu'un « undefined points ».
  const compte = s.cumul === undefined
    ? `Coup ${chiffres(s.coups)}`
    : `Coup ${chiffres(s.coups)} · ${chiffres(s.cumul)} points`;
  action.appendChild(el("span", "chiffres", compte));
  t.appendChild(action);

  t.addEventListener("click", () => allerA(s.id));
  return t;
}

/** Une carte de salon : sa vraie grille, son nom, sa variante, son etat. */
function carteSalon(s: ResumeSalon): HTMLElement {
  const c = el("button", "carte") as HTMLButtonElement;
  c.type = "button";

  const vue = el("span", "vue");
  const infinie = s.config.bornes === null;
  vue.appendChild(el("span", `vignette ${infinie ? "infinie" : "bornee"}`));
  vue.appendChild(el("span", "badge", courtDeLaGrille(s.config.bornes)));

  // Le createur peut retirer son salon -- sauf s'il est permanent : des
  // milliers de coups joues a plusieurs ne tiennent pas a un clic.
  const moi = pseudo();
  if (s.permanent !== true && moi !== "" && s.proprietaire === moi) {
    const jeter = el("button", "jeter", "Supprimer") as HTMLButtonElement;
    jeter.type = "button";
    // Le bouton dit ce qu'il fait VRAIMENT : seule une 15x15 terminee survit a
    // la disparition de son salon.
    jeter.title = !infinie && s.finie
      ? "Retire le salon. La partie terminée est conservée."
      : "Retire le salon ET efface la partie. Sans retour.";
    jeter.addEventListener("click", (e) => {
      e.stopPropagation();
      void supprimerSalon(s.id, moi);
    });
    vue.appendChild(jeter);
  }
  c.appendChild(vue);

  const dedans = el("span", "dedans");
  dedans.appendChild(el("b", "nom", s.nom));
  dedans.appendChild(el("span", "quoi", specDuSalon(s.config)));

  const etat = el("span", "etat");
  // Le point dit d'un regard si l'on joue : vert quand la partie court, ambre
  // quand le salon attend encore son premier coup.
  const vif = s.finie ? "close" : s.coups === 0 ? "attente" : "encours";
  etat.appendChild(el("span", `point ${vif}`));
  etat.appendChild(el("span", "", s.mondiale
    ? "permanent"
    : `${s.connectes} joueur${s.connectes > 1 ? "s" : ""}`));
  etat.appendChild(el("span", "ou", s.finie
    ? "terminée"
    : s.coups === 0 ? "en attente" : `coup ${chiffres(s.coups)}`));
  dedans.appendChild(etat);
  c.appendChild(dedans);

  c.addEventListener("click", () => allerA(s.id));
  return c;
}

/** La tuile pointillee, en fin de mur — seulement si l'on s'est nomme. */
function tuileCreer(): HTMLElement {
  const t = el("button", "tuile-creer", "Créer un salon") as HTMLButtonElement;
  t.type = "button";
  t.addEventListener("click", () => { void creerSalon(); });
  return t;
}

/**
 * Repeint l'accueil depuis la liste deja recue.
 *
 * Filtrer ou changer de pseudo ne redemande RIEN au serveur : c'est cette
 * fonction qu'on rappelle, et l'ecran suit sans attendre.
 */
function peindreAccueil(): void {
  peindreCompte();
  peindreFiltres();

  const vedette = $("vedette");
  const rouleau = $("salons");
  vedette.replaceChildren();
  rouleau.replaceChildren();

  // La grille permanente tient la colonne de gauche, a elle seule : c'est celle
  // qu'on vient jouer, et elle se retrouvait au milieu des salons du moment, a
  // une place qui changeait avec eux. Le reste garde l'ordre du serveur, du plus
  // ancien au plus recent.
  const liste = [...salonsRecus].sort((a, b) => Number(b.mondiale) - Number(a.mondiale));
  const vus = liste.filter(retenu);
  const star = vus.find((s) => s.mondiale);
  if (star !== undefined) vedette.appendChild(tuileStar(star));
  vedette.hidden = star === undefined;
  $("mur").classList.toggle("sans-star", star === undefined);

  const autres = vus.filter((s) => !s.mondiale);
  for (const s of autres) rouleau.appendChild(carteSalon(s));
  if (vus.length === 0) {
    rouleau.appendChild(el("div", "none",
      liste.length === 0 ? "aucun salon ouvert" : "aucun salon de cette sorte"));
  }
  if (pseudo() !== "") rouleau.appendChild(tuileCreer());

  // Un joueur ne compte qu'une fois : il n'est present que dans un salon.
  const total = salonsRecus.reduce((a, s) => a + s.connectes, 0);
  $("pied-total").textContent = `${chiffres(total)} joueur${total > 1 ? "s" : ""} en ligne`;
}

/** Demande la liste des salons au serveur, puis repeint. */
async function peuplerSalons(): Promise<void> {
  let data: { salons: ResumeSalon[] };
  try {
    data = await (await fetch("/api/salons")).json();
  } catch {
    $("salons").replaceChildren(el("div", "none", "serveur injoignable"));
    return;
  }
  salonsRecus = data.salons;
  peindreAccueil();
}

/** Retire un salon, et dit pourquoi quand le serveur refuse. */
async function supprimerSalon(id: string, moi: string): Promise<void> {
  const r = await fetch(`/api/salon/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { "x-pseudo": moi },
  });
  if (!r.ok) {
    const d = await r.json();
    $("c-error").textContent = d.erreur ?? "suppression impossible";
    $("c-error").hidden = false;
  }
  void peuplerSalons();
}

/** Les reglages en cours d'edition dans le salon. */
let cTirage = 7, cJouables = 7, cPioche = "probabilites";
/** Le lexique en cours d'edition. */
let cDico = DICO_PAR_DEFAUT;
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
    avertirSiExplosif();
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
  avertirSiExplosif();
});

for (const b of $("r-borne-onglets").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    cBorne = (b as HTMLElement).dataset["v"] === "duree" ? "duree" : "coups";
    // Les deux termes s'excluent : choisir l'un efface l'autre.
    if (cBorne === "coups") cDureeMax = null; else cCoupsMax = null;
    peuplerCoups();
    avertirSiExplosif();
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
    avertirSiExplosif();
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
  avertirSiExplosif();
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
/**
 * Ce qu'on tient pour une partie assez courte pour que le cout n'ait pas le
 * temps de devenir genant. Le top se paie a peu pres une seconde au millier de
 * coups joues : cinq cents coups, ou deux heures, se jouent sans y penser.
 */
const COUPS_TRANQUILLES = 500, DUREE_TRANQUILLE = 2 * 3600;

function avertirSiExplosif(): void {
  const boite = $("r-alerte");

  // LE SAC SANS FIN SUR UN PLATEAU BORNE se joue, mais il faut savoir a quoi on
  // s'engage : rien n'arrete la partie tant qu'un coup reste jouable, et une
  // grille de quinze cases met longtemps a se boucher pour de bon.
  if (cBornes !== null && cPioche === "sac102boucle") {
    boite.innerHTML =
      `<b>Attention : sac sans fin sur une grille ${cBornes * 2 + 1}×${cBornes * 2 + 1}.</b><br>` +
      `Le sac se recharge indéfiniment : la partie ne s'arrête que lorsque plus ` +
      `aucun coup n'est jouable, et elle sera très longue.`;
    boite.hidden = false;
    return;
  }

  // LA GRILLE INFINIE N'EST DANGEREUSE QUE SI ELLE DURE. Le cout croit avec le
  // nombre de coups joues : une partie qui s'arrete a cent coups ne l'atteint
  // jamais, meme a quinze lettres. L'avertissement ne vaut donc que pour une
  // partie sans terme -- ou dont le terme est assez lointain pour en etre une.
  const borneCourte = (cCoupsMax !== null && cCoupsMax <= COUPS_TRANQUILLES)
    || (cDureeMax !== null && cDureeMax <= DUREE_TRANQUILLE);
  if (cBornes !== null || cTirage < 10 || borneCourte) { boite.hidden = true; return; }
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
    // Le plateau borne veut un vrai sac -- des probabilites ponderees n'y
    // finissent jamais de remplir la grille. Le sac SANS FIN, lui, y a
    // desormais sa place et n'est plus chasse.
    if (cBornes !== null && cPioche === "probabilites") cPioche = "sac102";
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
        const avant = `${cTirage}/${cJouables}`;
        if (id === "r-tirage") {
          cTirage = n;
          if (cJouables > n) cJouables = n;
        } else cJouables = n;
        // CHANGER DE FORMAT REMET LES PRIMES D'USAGE.
        //
        // Une prime se lit « tant de points pour tant de caramels poses », et
        // ce qu'elle vaut depend entierement du format : trois points pour deux
        // caramels a du sens en 2 sur 2, aucun en 7 sur 7, ou poser deux
        // lettres est le contraire d'un exploit. Les garder d'un format a
        // l'autre, c'est emporter un bareme qui ne veut plus rien dire -- et
        // sans rien dire, puisque la section est repliee.
        if (`${cTirage}/${cJouables}` !== avant) cPrimes = primesHabituelles();
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
    avertirSiExplosif();
  });
}

/**
 * Les trois tirages possibles, sur les deux grilles.
 *
 * LE SAC SANS FIN EST DESORMAIS JOUABLE SUR UN PLATEAU BORNE. Il y etait
 * interdit parce qu'un sac qui ne s'epuise pas ne termine pas la partie -- et
 * qu'a l'epoque rien d'autre ne la terminait. Ce n'est plus vrai : un plateau
 * de quinze cases finit par se remplir, et la regle des tirages injouables
 * (SPEC.md §16) clot la partie quand plus rien ne se pose. La grille se remplit
 * donc jusqu'au bout, ce qui est une variante en soi.
 */
function peuplerPioche(): void {
  for (const b of $("r-pioche").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    b.setAttribute("aria-pressed", String(v === cPioche));
    (b as HTMLButtonElement).disabled = false;
    (b as HTMLButtonElement).title = "";
  }
}

/**
 * Un bouton par lexique.
 *
 * CHOISIR LE LEXIQUE, C'EST CHOISIR LA LANGUE DE LA PARTIE. Le nom de la langue
 * passe donc avant celui du dictionnaire : on cherche « English » bien avant de
 * savoir ce qu'est un EEL 22. Le detail se lit dessous.
 */
function peuplerDico(): void {
  const box = $("r-dico");
  if (box.childElementCount === 0) {
    for (const d of tousLesDictionnaires()) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset["v"] = d.id;
      b.innerHTML = "";
      b.append(d.langue === "en" ? "English" : "Français");
      const em = document.createElement("em");
      em.textContent = d.nom;
      b.append(document.createElement("br"), em);
      b.title = d.detail;
      b.addEventListener("click", () => { cDico = d.id; peuplerDico(); });
      box.appendChild(b);
    }
  }
  for (const b of box.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === cDico));
  }
}

/** Ouvre les reglages sur l'etat courant de la partie. */
function ouvrirReglages(): void {
  cTirage = cfg.tirage;
  cJouables = cfg.jouables;
  cPioche = cfg.pioche;
  cDico = cfg.dictionnaire;
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
  peuplerDico();
  $("r-error").hidden = true;
  // SOUS LE RELIQUAT, PAS PLUS HAUT. Regler une partie, c'est regarder le
  // tirage et les lettres restantes en meme temps : un panneau qui les
  // recouvre oblige a le fermer pour verifier ce qu'on vient de decider.
  //
  // La hauteur se MESURE plutot que de s'ecrire en dur : la barre du chevalet
  // change de hauteur avec la taille des caramels, qui change avec le nombre
  // de lettres. Une constante serait juste aujourd'hui et fausse au premier
  // tirage a quinze.
  const bas = Math.round($("sac").getBoundingClientRect().bottom);
  $("reglages").style.paddingTop = `${bas}px`;
  ($("reglages").firstElementChild as HTMLElement).style.maxHeight =
    `${Math.max(240, innerHeight - bas - 14)}px`;
  $("reglages").hidden = false;
}

$("reglages-open").addEventListener("click", ouvrirReglages);
$("rg-close").addEventListener("click", () => { $("reglages").hidden = true; });

$("r-appliquer").addEventListener("click", () => {
  envoyer({
    t: "relancer", tirage: cTirage, jouables: cJouables, pioche: cPioche,
    dictionnaire: cDico,
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

/** Le nom du site ramene a l'accueil, comme le titre du bandeau de jeu. */
$("site-nom").addEventListener("click", () => {
  if (!$("corps-profil").hidden) { fermerLeProfil(); return; }
  if ($("join").hidden) quitterSalon();
});

/** Le panneau des records se referme par son bouton comme par son voile. */
$("records-close").addEventListener("click", () => { $("voile-records").hidden = true; });
$("voile-records").addEventListener("click", (e) => {
  if (e.target === $("voile-records")) $("voile-records").hidden = true;
});

/** On peut refermer le voile sans se nommer : le site reste ouvert. */
$("renoncer").addEventListener("click", () => {
  destination = null;
  $("voile").hidden = true;
});

/**
 * Cree un salon et y entre, sans rien demander.
 *
 * Le nom vient du serveur, tire au hasard : on ne fait pas remplir un
 * formulaire pour entrer quelque part. Le salon s'ouvre sur ses reglages, la
 * partie ne commence qu'une fois qu'on les a valides.
 */
async function creerSalon(): Promise<void> {
  const moi = pseudo();
  if (moi === "") { demanderLePseudo(null); return; }
  $("c-error").hidden = true;
  const r = await fetch("/api/salons", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Le salon nait dans la langue du site : venu de la version anglaise, on
    // n'ouvre pas une partie en francais.
    body: JSON.stringify({ proprietaire: moi, langue: langue() }),
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
  const moi = pseudo();
  if (moi === "") {
    $("join-error").textContent = "Entrez un pseudo pour continuer";
    $("join-error").hidden = false;
    return;
  }
  // Le pseudo tient d'une visite a l'autre, meme sans compte : c'est tout ce
  // qu'un joueur a a retenir tant que les comptes n'existent pas.
  try { localStorage.setItem("pseudo", moi); } catch { /* navigation privee */ }
  $("join-error").hidden = true;
  $("voile").hidden = true;
  const ou = destination;
  destination = null;
  // On revient sur la destination demandee, pas sur l'accueil.
  if (ou !== null) { void rejoindre(ou); return; }
  peindreAccueil();
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

/** Le lexique qu'annonce la liste des salons, a defaut le francais. */
function dicoDuSalon(id: string): string {
  return salonsRecus.find((q) => q.id === id)?.config?.dictionnaire ?? DICO_PAR_DEFAUT;
}

/**
 * Le plateau a-t-il ete bati sur le bon lexique ?
 *
 * La liste des salons peut etre perimee -- le salon a pu changer de
 * dictionnaire entre-temps. `hello` fait foi : si les deux ne s'accordent pas,
 * on telecharge le bon et l'on refait le plateau. Rien ne se voit, sinon un
 * repeignage.
 */
function accorderLeDictionnaire(): void {
  if (cfg.dictionnaire === dictId) return;
  void chargerLeDictionnaire(cfg.dictionnaire).then(() => {
    board = new Board(dict, cfg);
    board.place(tiles.map((t: Tile): Placement => (
      { x: t.x, y: t.y, letter: t.l, blank: t.b === 1 }
    )));
    plateauRejeu = null;
    draw();
  });
}

/** Quitte l'accueil et entre dans un salon. */
async function rejoindre(id: string): Promise<void> {
  const moi = pseudo();
  if (moi === "") { demanderLePseudo(id); return; }
  me = moi;
  salonChoisi = id;
  try { localStorage.setItem("pseudo", me); } catch { /* navigation privee */ }
  $("join-error").hidden = true;

  // TABLE RASE AVANT MEME DE DECOUVRIR LA GRILLE.
  //
  // Sans cela, ce qui etait peint pour le salon precedent restait a l'ecran
  // jusqu'a l'arrivee de `hello` : ses caramels, parfois HORS des bornes du
  // nouveau plateau comme si des mots y avaient deja ete joues -- et son
  // TIRAGE, le temps que la connexion se ferme et que la nouvelle reponde.
  //
  // Le menage se fait donc AVANT le premier `await`, pas apres : entre les deux
  // il s'ecoule le temps de fermer une liaison, et c'est justement pendant ce
  // temps-la que l'ecran est decouvert.
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
  tops = {};
  // La memoire du rejeu appartient a la partie qu'on quitte.
  paliersRecus.clear();
  flairEnCours = 0;
  nonTrouves = 0;
  gerant = null;
  salonPermanent = false;
  permanent = false;
  tempsJoue = 0;
  rejeuOuvert = false;
  // LA TABLE RASE DOIT SE VOIR, PAS SEULEMENT SE FAIRE. Les variables etaient
  // bien remises a zero, mais l'ecran gardait ce qu'on y avait peint pour le
  // salon precedent jusqu'a l'arrivee de `hello` : on voyait un instant le
  // tirage d'a cote, son classement et son compteur de coups.
  moveNumber = 0;
  cumul = 0;
  solving = false;
  demarree = false;
  coupsMax = null;
  dureeMax = null;
  debutDeLaPartie = 0;
  chrono = null;
  duplicate = false;
  online = [];
  verifies = new Set();
  nomsPublics = {};
  inscrits = new Set();
  servedAt = Date.now();
  createdAt = Date.now();
  $("sac").textContent = "";
  cfg = configParDefaut();
  configRecue = false;
  paintChat(chat);
  paintJournal();
  paintRack();
  paintSide();
  $("join").hidden = true;

  await fermerConnexion();

  // LE LEXIQUE AVANT LA CONNEXION. Le plateau ne peut pas naitre sans
  // dictionnaire, et `hello` arrive trop tard pour attendre un telechargement
  // sans laisser l'ecran vide. On prend donc celui qu'annonce la liste des
  // salons ; `accorderLeDictionnaire` rattrapera si elle etait perimee.
  const premier = dictId === "";
  await chargerLeDictionnaire(dicoDuSalon(id));
  if (premier) new ResizeObserver(resize).observe(cv);
  // Le plateau, lui, attend le dictionnaire : il ne peut pas naitre plus tot.
  board = new Board(dict, cfg);
  resize();
  connect();
}

try {
  const saved = localStorage.getItem("pseudo");
  if (saved) ($("name") as HTMLInputElement).value = saved;
} catch { /* navigation privee : sans importance */ }

// LE BALISAGE SE TRADUIT AVANT LE PREMIER PEIGNAGE. Sinon la page s'affiche en
// francais le temps d'un battement, puis bascule -- ce qui se voit.
traduireLeDocument();
peindreAccueil();
// LE COMPTE AVANT LES SALONS : c'est lui qui decide de ce que le bandeau
// affiche, et une seconde d'accueil peint en visiteur alors qu'on est connecte
// se remarque.
void lireLeCompte().then(() => {
  peindreAccueil();
  // Une adresse qui demande le profil l'ouvre, des que l'on sait qui l'on est.
  if (new URLSearchParams(location.search).get("page") === "compte" && moiCompte !== null) {
    ouvrirLeProfil(false);
  }
  // Retour du lien de confirmation : on le dit, et on nettoie l'adresse pour
  // qu'un rafraichissement ne rejoue pas le message.
  const retourMail = new URLSearchParams(location.search).get("email");
  if (retourMail !== null) {
    $("c-error").textContent = retourMail === "ok"
      ? "Votre adresse est confirmée." : retourMail;
    $("c-error").hidden = false;
    window.history.replaceState({}, "", location.pathname);
  }
  return peuplerSalons();
});

// UN LIEN QUI PORTE UN SALON MENE AU SALON. On s'y nomme sur place si l'on ne
// s'est jamais nomme -- c'est le seul moment ou le pseudo est demande.
if (salonChoisi !== "") allerA(salonChoisi);

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());
