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
  configParDefaut, deserialiser, valeurDe,
  type ConfigPartie, type ConfigSerialisee,
} from "../../engine/src/config.ts";
import {
  DICO_PAR_DEFAUT, DICO_PAR_LANGUE, LEXIQUE_TOUS, dictionnaire, tailleDuSac,
  tousLesDictionnaires,
} from "../../engine/src/dictionnaires.ts";
import { CATEGORIES, TAILLES, type Taille } from "../../engine/src/categories.ts";
import { ETAPES, ETAPES_MONTANTE } from "../../engine/src/montante.ts";
import { LAYOUTS, type LayoutFn } from "../../engine/src/bonus.ts";
import {
  analyserSaisie, benjamins, estUnMotAvecJokers, JOKERS_MAX, LONGUEUR_MAX_SAISIE, motsFormables,
  plusDeJokers, rallongesArriere, rallongesAvant, solutions as motsSolutions, squelette,
  superBenjamins,
  type Correspondance, type ResultatRecherche,
} from "../../engine/src/solveur.ts";
import {
  choisirLaLangue, langue, surChangementDeLangue, t, t2, tDans, traduireLeDocument,
  type Langue,
} from "./langue.ts";
import { bonusChar, setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { BLANK } from "../../engine/src/alphabet.ts";
import {
  step, noteCoup, setReperes, nomColonne, nomLigne, type Dir, type Reperes,
} from "../../engine/src/coords.ts";
import { resolveTypedWord, PLAY_MESSAGE } from "../../engine/src/play.ts";
import { chercherLeMot } from "../../engine/src/chercher.ts";
import {
  JOURS_DE_LA_SEMAINE, LEXIQUES_DU_JOUR, chronoDuNom, consigneExacte, heureDeParis,
  modeleDeLaConfig, nomDeLaConsigne, nomDeLaPartie, primesDUsage, primesLibres,
  type ConsigneDePartie, type ModeleDePartie,
} from "../../engine/src/epreuves.ts";

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

/** Le DAWG d'un lexique, telecharge une seule fois puis repris du cache. */
async function lexiquePour(id: string): Promise<Dict> {
  const deja = lexiques.get(id);
  if (deja !== undefined) return deja;
  const bytes = await (await fetch(`/dawg.bin?d=${encodeURIComponent(id)}`)).arrayBuffer();
  const charge = Dict.fromBytes(bytes);
  lexiques.set(id, charge);
  return charge;
}

async function chargerLeDictionnaire(id: string): Promise<void> {
  dict = await lexiquePour(id);
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
/** Le negatif de la feuille, en topping collaboratif. */
let negatifCollectif = 0;
/** Combien de tops chacun a trouves, dans les deux modes. */
let tops: Record<string, number> = {};
/** Coups que personne n'a trouves. */
let nonTrouves = 0;
/** Fin du decompte d'avant-coup, 0 s'il n'y en a pas. */
let decompteJusqua = 0;
/**
 * Instant ou le compte a rebours du lancement s'acheve. Zero = aucun en cours.
 *
 * Une grille permanente neuve n'a personne pour la regler : c'est
 * l'administration qui la lance, et tout le monde voit descendre les memes
 * dix secondes.
 */
let lancementA = 0;
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
/** Le journal des coups a-t-il deja ete replie pour cette partie de battle ? */
let journalReplie = false;

/** Ce que le serveur dit de la partie d'epreuve du salon (SPEC.md §29). */
interface EpreuveVue {
  epreuve: string;
  jour: string | null;
  lexique: string | null;
  partie: number;
  config: ConfigSerialisee | null;
  /** Le tournoi dont la partie fait partie, ou `null` pour une partie du jour. */
  tournoi: { id: string; nom: string } | null;
  compte: string;
  lancee: boolean;
  jeu: string | null;
  noms: string;
  equipe: string[];
  close: boolean;
}
/** La partie d'epreuve que sert ce salon, ou `null` pour un salon ordinaire. */
let epreuve: EpreuveVue | null = null;
/** La manche est en pause, et son coup avait deja dure `ecoulePause`. */
let enPause = false;
let ecoulePause = 0;

/**
 * LA MONTANTE DU SALON, ou `null` : six parties en topping a la suite
 * (SPEC.md §23).
 *
 * Tout vient du serveur, cumuls compris : la montante est une suite de parties,
 * et le client ne voit qu'une partie a la fois -- il ne pourrait pas additionner
 * ce qu'il n'a pas vu.
 */
interface MontanteVue {
  id: string;
  rang: number;
  etapes: number;
  essai: number;
  nom: string;
  suivante: string | null;
  temps: number;
  negatif: number;
  rates: number;
  coups: number;
  cumul: number;
  reprenable: number | null;
  nomReprenable: string | null;
  close: boolean;
  pause: boolean;
  finie: boolean;
  perdue: boolean;
}
let montante: MontanteVue | null = null;

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
/**
 * TOPPING COLLABORATIF SEULEMENT : la meilleure proposition de la table sur
 * le coup en cours, `null` sinon. Voir `cfg.toppingCollaboratif`.
 */
let meilleureCollective:
  { joueur: string; word: string; score: number; dir: Dir; x: number; y: number } | null = null;
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

/**
 * Les mots que le dictionnaire a refuses AU DERNIER ESSAI.
 *
 * Un bandeau qui passe ne se retient pas : le temps de relire, il est parti.
 * La liste, elle, reste sous les yeux tant qu'on ne tape pas.
 *
 * ELLE NE CUMULE PAS. Elle l'a fait, et c'etait pire que rien : un mot refuse
 * trois essais plus tot restait affiche sous une solution qui, elle, venait
 * d'etre acceptee -- on lisait « votre meilleure solution WAX » et,
 * juste dessous, un refus qui ne parlait plus de rien.
 */
let motsRefuses: string[] = [];

/**
 * Remplace la liste par ce que le dernier essai a fait refuser.
 *
 * ON NE NOTE QUE DES MOTS. Une lettre seule n'en est pas un -- elle ne forme
 * rien dans son propre sens -- et « trop de caramels » ou « le mot ne touche
 * rien » parlent du placement, pas du lexique : les ranger la ferait croire
 * que ces mots n'existent pas.
 */
function noterLesRefus(mots: readonly string[]): void {
  motsRefuses = [];
  for (const mot of mots) {
    if (mot.length > 1 && !motsRefuses.includes(mot)) motsRefuses.push(mot);
  }
}
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
/** Le salon est-il ferme a qui n'y est pas invite (SPEC.md §26) ? */
let salonPrive = false;
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

/**
 * Le coup a rouvrir en rejeu des que la partie qu'on vient d'abandonner
 * (SPEC.md §25) est confirmee finie par le serveur. `null` hors de cette
 * fenetre : ce n'est pas un etat de la partie, seulement l'intention du clic.
 */
let cibleDuRejeuApresAbandon: number | null = null;

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
 * Epaisseur du trait qui borde un plateau borne, en pixels.
 *
 * Elle est ecrite une fois et lue deux : par le trace du bord, et par les
 * reperes, qui doivent s'arreter AVANT lui. Le rectangle vert du repere allume
 * etait peint apres le bord et le rognait d'un pixel : le trait paraissait plus
 * fin sous la colonne et la ligne du curseur, exactement la ou l'oeil regarde.
 */
const BORD_PLATEAU = 3;

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

/**
 * Les quatre cotes d'un caramel qui touchent un autre caramel.
 *
 * Deux caramels colles n'ont pas de bord entre eux : c'est un MOT, pas deux
 * lettres posees l'une a cote de l'autre.
 */
export interface Cotes { g: boolean; d: boolean; h: boolean; b: boolean }

const SEUL: Cotes = { g: false, d: false, h: false, b: false };

/**
 * LE CONTOUR D'UN CARAMEL, QUI TIENT COMPTE DE SES VOISINS.
 *
 * Deux corrections, et elles vont ensemble :
 *
 * L'ARRONDI TOMBE DU COTE OU IL Y A UN VOISIN. Deux caramels colles laissaient
 * sinon, aux deux bouts de leur bord commun, deux petites lunes de la couleur
 * de la case en dessous -- des taches claires alignees le long de chaque
 * couture, qu'on prenait pour des trous dans la grille. Un coin ne s'arrondit
 * donc que s'il donne sur du vide.
 *
 * LE TRAIT SE POSE SUR LE PIXEL DE LA LIMITE, DES QUATRE COTES, ET TOUJOURS DE
 * LA MEME FACON.
 *
 * Le quadrillage occupe le PREMIER pixel de chaque case (trace a `X + .5`).
 * C'est donc ce pixel-la que le bord d'un caramel doit couvrir, en haut et a
 * gauche chez lui, en bas et a droite chez son voisin. Un trait d'un pixel
 * centre sur la limite ne le couvrirait qu'a moitie : il se partagerait entre
 * les deux pixels qui l'encadrent, et rendrait une ligne floue de deux pixels
 * au lieu d'une nette d'un seul.
 *
 * LA GEOMETRIE NE DEPEND PAS DES VOISINS, et c'est le point important. Elle en
 * dependait : un caramel qui avait un voisin a droite y poussait son bord, un
 * caramel qui n'en avait pas le gardait chez lui. Sa face visible faisait donc
 * un pixel de plus ou de moins SELON SON VOISINAGE -- une lettre en bout de mot
 * n'avait pas la meme largeur qu'une lettre du milieu, et une rangee de
 * caramels paraissait decalee. C'est ce qu'on voyait sur la super grille des
 * qu'un mot croisait une lettre deja posee.
 *
 * Deux voisins tombent maintenant d'accord sans se concerter : le bord commun
 * est le meme pixel pour les deux, il n'y en a qu'un, et il est plein.
 *
 * Les voisins ne decident plus que de L'ARRONDI : un coin ne s'arrondit que
 * s'il donne sur du vide, sinon la case en dessous se voyait aux deux bouts de
 * chaque couture -- des taches claires alignees qu'on prenait pour des trous.
 *
 * `retrait` est la moitie de l'epaisseur du trait, pour que celui-ci tienne
 * entierement dans un pixel. Zero pour un remplissage, qui doit couvrir sa case
 * en entier -- et zero aussi pour un trait qu'on veut CENTRE sur la limite,
 * comme le cerne epais du coup qu'on examine dans une partie relue.
 */
function cheminDuCaramel(
  g: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
  cotes: Cotes = SEUL, retrait = 0,
): void {
  const x0 = x + retrait, x1 = x + w + retrait;
  const y0 = y + retrait, y1 = y + h + retrait;
  const coin = (a: boolean, b: boolean): number => a || b ? 0 : r;
  const hg = coin(cotes.h, cotes.g), hd = coin(cotes.h, cotes.d);
  const bd = coin(cotes.b, cotes.d), bg = coin(cotes.b, cotes.g);
  g.moveTo(x0 + hg, y0);
  g.lineTo(x1 - hd, y0);
  if (hd > 0) g.arcTo(x1, y0, x1, y0 + hd, hd);
  g.lineTo(x1, y1 - bd);
  if (bd > 0) g.arcTo(x1, y1, x1 - bd, y1, bd);
  g.lineTo(x0 + bg, y1);
  if (bg > 0) g.arcTo(x0, y1, x0, y1 - bg, bg);
  g.lineTo(x0, y0 + hg);
  if (hg > 0) g.arcTo(x0, y0, x0 + hg, y0, hg);
  g.closePath();
}

/** Les cotes d'une case qui touchent une autre case occupee. */
function cotesDe(occupe: ReadonlySet<string>, x: number, y: number): Cotes {
  return {
    g: occupe.has(`${x - 1},${y}`), d: occupe.has(`${x + 1},${y}`),
    h: occupe.has(`${x},${y - 1}`), b: occupe.has(`${x},${y + 1}`),
  };
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
  // LE MOT ENVOYE OCCUPE SES CASES, LUI AUSSI. Sans cela, la seconde ou l'on
  // appuie sur Entree vidait le mot en cours, et le curseur -- qui cherche la
  // premiere case libre -- venait se poser SUR la premiere lettre du mot qu'on
  // venait d'envoyer : un cadre noir et une fleche par-dessus le caramel, le
  // temps de la reponse du serveur, puis un saut quand les vraies cases
  // devenaient occupees. C'est le clignotement qui restait a la validation.
  const busy = new Set(
    [...typedCells(), ...attente].map((c) => `${c.x},${c.y}`));
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
    // Les quadruples : la super grille est seule a en porter.
    Q: css("--mcq"), q: css("--lcq"),
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
    occupe: ReadonlySet<string>,
  ): void => {
    if (lot.length === 0) return;
    const X = (x: number) => auPixelEcran(orgX + x * cell);
    const Y = (y: number) => auPixelEcran(orgY + y * cell);
    if (arrondi) {
      // AU ZOOM DE LECTURE, chaque caramel regarde ses voisins : pas d'arrondi
      // ni de trait sur un bord partage. Voir `cheminDuCaramel`.
      g.beginPath();
      for (const q of lot) {
        const px = X(q.x) + gap, py = Y(q.y) + gap;
        const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
        cheminDuCaramel(g, px, py, w, h, rad, cotesDe(occupe, q.x, q.y));
      }
      g.fillStyle = face; g.fill();
      g.beginPath();
      for (const q of lot) {
        const px = X(q.x) + gap, py = Y(q.y) + gap;
        const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
        cheminDuCaramel(g, px, py, w, h, rad, cotesDe(occupe, q.x, q.y), trait / 2);
      }
      g.lineWidth = trait; g.strokeStyle = edge; g.stroke();
    } else {
      // AU DEZOOM, des carres : les coins arrondis coutent l'essentiel du temps
      // d'une image (70 ms pour trois mille), et a cette taille un arrondi de
      // huit dixiemes de pixel ne se voit pas. Les voisins non plus.
      g.beginPath();
      for (const q of lot) {
        const px = X(q.x) + gap, py = Y(q.y) + gap;
        const w = X(q.x + 1) - X(q.x) - gap * 2, h = Y(q.y + 1) - Y(q.y) - gap * 2;
        g.rect(px + .5, py + .5, w - 1, h - 1);
      }
      g.fillStyle = face; g.fill();
      g.lineWidth = trait; g.strokeStyle = edge; g.stroke();
    }

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

  /**
   * UN MOT QUI N'EST PAS ENCORE POSE : celui qu'on tape, celui qu'on vient
   * d'envoyer, ou le fantome d'une solution.
   *
   * IL PASSE PAR LA MEME ROUTINE QUE LES CARAMELS POSES, et c'est tout l'objet
   * de cette fonction. Il avait la sienne, et les deux ne tombaient pas
   * d'accord au pixel pres :
   *
   * - la position s'arrondissait au pixel de MISE EN PAGE d'un cote, au pixel
   *   D'ECRAN de l'autre. A 100 % les deux coincident ; a 125 %, elles peuvent
   *   differer d'un pixel d'ecran ;
   * - la taille de la lettre se calculait sur la hauteur ARRONDIE de la case
   *   d'un cote, sur la taille de case exacte de l'autre : un pixel de police
   *   d'ecart une ligne sur deux ;
   * - l'arrondi des coins et le seuil d'affichage du chiffre ne suivaient pas
   *   les memes regles.
   *
   * Le mot sautait donc imperceptiblement a la seconde ou le serveur le
   * confirmait -- le clignotement qui restait. Une seule routine, et il ne
   * bouge plus d'un pixel : seule sa COULEUR change, celle du dernier top.
   *
   * LES VOISINS COMPTENT LE PLATEAU. Un mot qui s'accroche a une lettre deja
   * posee doit y etre colle des la frappe : sinon le coin s'arrondissait a la
   * jonction et se carrait a la confirmation.
   */
  const peindreLeMot = (
    lot: readonly Tile[], face: string, edge: string, ink: string,
    jface = face, jedge = edge, jink = ink,
  ): void => {
    if (lot.length === 0) return;
    const occupe = new Set(lot.map((q) => `${q.x},${q.y}`));
    for (const q of lot) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = `${q.x + dx},${q.y + dy}`;
        if (!occupe.has(k) && board.at(q.x + dx, q.y + dy) !== undefined) occupe.add(k);
      }
    }
    caramels(ctx, lot.filter((q) => q.b === 0), face, edge, ink,
      1, orgEcranX, orgEcranY, occupe);
    caramels(ctx, lot.filter((q) => q.b === 1), jface, jedge, jink,
      1, orgEcranX, orgEcranY, occupe);
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
    // CE QUI EST POSE AUTOUR, pour que chaque caramel sache ou il touche un
    // voisin. La bande est elargie d'une case : un caramel du bord doit voir
    // celui d'a cote, meme s'il n'est pas repeint cette fois-ci.
    const occupe = new Set<string>();
    for (const q of tiles) {
      if (q.n > jusqua) continue;
      if (q.x < x0 - 1 || q.x > x1 + 1 || q.y < y0 - 1 || q.y > y1 + 1) continue;
      occupe.add(`${q.x},${q.y}`);
      if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) continue;
      const face = q.b === 1 ? C.jface : C.face;
      // Le dernier top porte la couleur d'accent PARTOUT : contour, lettre et
      // valeur. Un simple lisere ne suffisait pas a le distinguer sur une
      // grille dense ; c'est l'encre qui se lit de loin.
      const marque = hl.has(`${q.x},${q.y}`);
      const edge = marque ? C.accent : q.b === 1 ? C.jedge : C.edge;
      const ink = marque ? C.accent : q.b === 1 ? C.jedge : C.ink;
      // UN PIXEL, POUR TOUT LE MONDE. Le dernier top portait un trait de deux :
      // il debordait alors d'un pixel chez son voisin d'un cote et pas de
      // l'autre, ce qui decalait son cadre par rapport a sa case. C'est
      // l'ENCRE qui le distingue -- contour, lettre et valeur en couleur
      // d'accent -- et elle se lit de plus loin qu'un lisere.
      const trait = 1;
      const k = `${face}|${edge}|${ink}|${trait}`;
      const l = groupes.get(k);
      if (l === undefined) groupes.set(k, { face, edge, ink, trait, t: [q] }); else l.t.push(q);
    }
    g.save();
    g.beginPath(); g.rect(rx, ry, rw, rh); g.clip();
    if (effacer) g.clearRect(rx, ry, rw, rh);
    peindreLeFond(g, orgX, orgY, rx, ry, rw, rh);
    for (const l of groupes.values()) {
      caramels(g, l.t, l.face, l.edge, l.ink, l.trait, orgX, orgY, occupe);
    }
    g.restore();
  };

  /**
   * L'ORIGINE, A L'ECRAN, DE LA CASE (0,0) TELLE QUE LES CARAMELS VIENNENT
   * D'ETRE POSES.
   *
   * Ce n'est pas `ox` : les caramels du plateau passent par une image de cote,
   * peinte a son origine a elle et recopiee a l'ecran a un decalage arrondi au
   * pixel d'ecran. Un mot pas encore pose doit se dessiner sur CETTE grille-la,
   * pas sur celle de la camera, sans quoi il saute d'un pixel au moment ou il
   * devient un vrai mot. Voir `peindreLeMot`.
   */
  let orgEcranX = ox, orgEcranY = oy;

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
      const posX = auPixel(-cacheMarge + (ox - cacheOx));
      const posY = auPixel(-cacheMarge + (oy - cacheOy));
      ctx.drawImage(cache, 0, 0, cache.width, cache.height, posX, posY, cw, ch);
      // La grille sur laquelle les caramels sont reellement tombes. Le
      // decalage est un nombre entier de pixels d'ecran, donc s'ajoute sans
      // rien deplacer.
      orgEcranX = cacheOx + cacheMarge + posX;
      orgEcranY = cacheOy + cacheMarge + posY;
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
  // LE MOT QU'ON TAPE EST UN MOT, pas une file de lettres : ses caramels colles
  // ne portent pas de bord entre eux. Ils se voient par-dessus la grille, donc
  // leurs voisins sont les leurs, et non ceux du plateau.
  //
  // Le mot ENVOYE prend la meme place et le meme aspect, le temps de la
  // reponse (voir `attente`) : les deux ne coexistent jamais.
  const tapees = typedCells();
  const enMain = tapees.length > 0
    ? tapees.map((c) => ({ ...c, blank: blanks.has(`${c.x},${c.y}`) }))
    : attente;
  peindreLeMot(
    enMain.map((c) => ({ x: c.x, y: c.y, l: c.letter, b: (c.blank ? 1 : 0) as 0 | 1, n: 0 })),
    C.face, C.cursor, C.ink, C.jface, C.jedge, C.jedge,
  );

  if (ghost !== null && !ghostCache && cell >= 6) {
    const { word, dir, x: gx, y: gy, jokers } = ghost;
    const { dx, dy } = step(dir);
    const lot: Tile[] = [];
    for (let i = 0; i < word.length; i++) {
      const x = gx + dx * i, y = gy + dy * i;
      if (x < gx0 || x > gx1 || y < gy0 || y > gy1) continue;
      lot.push({ x, y, l: word[i]!, b: jokers[i] === true ? 1 : 0, n: 0 });
    }
    // Le fantome ne distingue pas le joker par sa face : il a la sienne, verte,
    // et le joker ne s'y lit qu'a sa valeur nulle.
    peindreLeMot(lot, C.gface, C.gedge, C.gink);
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
    const E = BORD_PLATEAU;
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
      // La hauteur s'arrete au bord du plateau : le trait garde son epaisseur.
      ctx.fillRect(ox + x * cell + 1, g0y - R + 1, cell - 2, R - BORD_PLATEAU - 1);
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
      ctx.fillRect(g0x - R + 1, oy + y * cell + 1, R - BORD_PLATEAU - 1, cell - 2);
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
  //
  // L'OEIL BARRE CACHE AUSSI LES REPERES. Le mot du rejeu disparaissait bien de
  // la grille, mais sa ligne et sa colonne restaient allumees sur les regles :
  // la position du top se lisait quand meme, capture d'ecran comprise -- et
  // c'est justement une capture qu'on envoie a qui doit chercher le coup.
  const montre = ghost !== null && !ghostCache;
  const depart = montre
    ? { x: ghost!.x, y: ghost!.y }
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
    flash(t2("image trop grande pour ce navigateur — {l} × {h} px",
      { l: largeur, h: hauteur }), "bad");
    return;
  }
  const g = hors.getContext("2d");
  if (g === null) { flash(t("l'image n'a pas pu être produite"), "bad"); return; }

  // UN SEUL CANEVAS, PAS DEUX.
  //
  // La grille se dessinait sur le sien pour etre reportee ensuite sous le
  // bandeau -- deux images de la taille de la page, donc le double de memoire,
  // et c'est la memoire qui limite la finesse des lettres. Un decalage du repere
  // suffit : `draw()` peint comme si le bandeau n'existait pas, et ses numeros
  // de colonnes tombent juste dessous au lieu d'etre recouverts.
  const memoire = { ctx, W, H, ox, oy, cell, cle: cacheCle, ghost };
  bouton.disabled = true;
  try {
    // L'IMAGE D'UN COUP NOMME NE MONTRE PAS SA SOLUTION.
    //
    // Sans numero, on photographie l'ecran tel qu'il est -- le mot du rejeu
    // compris, c'est ce qu'on regarde. Avec un numero, l'image vient de la
    // feuille de route : c'est une position a chercher, et elle partait avec le
    // mot du coup qu'on avait ouvert pose dessus, en clair.
    if (coup !== undefined) ghost = null;
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
    ghost = memoire.ghost;
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
  if (blob === null) { flash(t("l'image n'a pas pu être produite"), "bad"); return; }
  const quand = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "h");
  const quoi = t2("coup {n}", { n: numero });
  const salonNom = ($("conn").textContent ?? "").split("·").pop()?.trim() || "grille";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${salonNom} — ${quoi} — ${quand}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  const mo = blob.size / 1e6;
  flash(t2("image enregistrée — {l} × {h} px — {mo} Mo",
    { l: largeur, h: hauteur, mo: mo.toFixed(1) }), "ok");
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
  const decalage = Math.round(Math.max(-jeu, Math.min(jeu, vise)));
  box.style.setProperty("--decalage", `${decalage}px`);

  // LE BOUTON DE MELANGE SUIT LA RANGEE, PAS LA BARRE : pose en absolu (donc
  // hors du flux flex, sans grignoter la place que `dispo` mesure ci-dessus --
  // c'est ce qui le faisait decaler tout le chevalet avant qu'il ne sorte du
  // flux), juste apres le dernier caramel, quel que soit le decalage qui vient
  // d'etre pose.
  const melange = $("rb-melange");
  if (!melange.hidden) {
    const barre = box.parentElement as HTMLElement;
    const barreRect = barre.getBoundingClientRect();
    const centreRangee = (b.left + b.width / 2 - pose) + decalage - barreRect.left;
    melange.style.left = `${Math.round(centreRangee + rangee / 2 + 10)}px`;
  }
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

/**
 * LE MOT QU'ON VIENT D'ENVOYER, ENCORE A L'ECRAN.
 *
 * Le mot tape disparaissait a la seconde ou l'on appuyait sur Entree, et le
 * serveur reposait les memes caramels cinquante millisecondes plus tard : un
 * clignotement a chaque top trouve, precisement au moment ou l'on regarde ce
 * qu'on vient de poser. C'etait le pire des cas quand on avait RAISON.
 *
 * Les caramels restent donc en place, avec l'aspect exact qu'ils avaient sous
 * la main, jusqu'a la reponse. Si c'etait le top, l'etat les reprend a
 * l'identique et rien ne bouge ; sinon ils s'en vont, ce qui est l'information.
 *
 * Ce n'est pas un pari sur le resultat : on ne les dessine pas comme des
 * caramels POSES, on les laisse tels qu'on les tenait. Rien n'affirme qu'ils
 * sont acceptes -- ils attendent, comme le joueur.
 */
let attente: { x: number; y: number; letter: string; blank: boolean }[] = [];
let attenteMinuteur = 0;
/**
 * Au-dela, on renonce a attendre.
 *
 * Une reponse perdue -- liaison coupee au mauvais moment -- laisserait sinon
 * des caramels sur la grille pour le reste de la partie.
 */
const ATTENTE_MAX_MS = 4000;

function oublierLAttente(): void {
  if (attente.length === 0) return;
  attente = [];
  clearTimeout(attenteMinuteur);
}

/**
 * UNE LIGNE DE MOT : le mot, SA REFERENCE A DROITE DE LUI, et ses points au
 * bout. Elle etait sous le mot, sur la ligne des commentaires, ou l'oeil ne
 * l'allait pas chercher.
 *
 * `tape` est le score du mot qu'on est en train d'ecrire : il se pose a GAUCHE
 * du meilleur, pour qu'on compare les deux sans que l'un chasse l'autre.
 */
function ligneDeMot(o: {
  mot: string; ref?: string; pts: string; tape?: number | null;
  jeton?: { texte: string; classe: string };
}): string {
  return `<span class="mot">${echapper(o.mot)}</span>`
    + (o.ref === undefined ? "" : `<span class="ref">${echapper(o.ref)}</span>`)
    + (o.jeton === undefined ? "" : `<span class="${o.jeton.classe}">${echapper(o.jeton.texte)}</span>`)
    + `<span class="scores">`
    + (o.tape === undefined || o.tape === null ? "" : `<span class="pts-tape">${o.tape}</span>`)
    + `<span class="pts">${echapper(o.pts)}</span></span>`;
}

/** Le mot en cours de frappe et son score, mis a jour a chaque lettre. */
function paintCurrent() {
  const w = $("cur-word"), meta = $("cur-meta"), bad = $("cur-bad");
  bad.hidden = true;

  const canon = coupCanonique();
  const enFrappe = cursor !== null && typed.length > 0 && canon !== null;
  const r = enFrappe && canon !== null
    ? resolveTypedWord(board, dict, canon.dir, canon.x, canon.y, canon.typed, rack, false, true)
    : null;
  const scoreTape = r !== null && r.ok ? r.move.score : null;

  // LA MEILLEURE SOLUTION DU MOMENT : celle de la table en topping
  // collaboratif (SPEC.md §28), la sienne autrement.
  const collective = cfg.toppingCollaboratif && !duplicate && meilleureCollective !== null
    ? meilleureCollective : null;
  const meilleur = collective ?? best;
  const dit = collective !== null ? "meilleure solution du groupe" : "votre meilleure solution";

  if (meilleur !== null) {
    w.className = "word";
    w.innerHTML = ligneDeMot({
      mot: meilleur.word, ref: noteCoup(meilleur.dir, meilleur.x, meilleur.y, cfg.bornes),
      pts: String(meilleur.score), tape: scoreTape,
    });
    // ON NE NOMME PAS LES COLLAGES FAUTIFS PENDANT LA FRAPPE : ce serait dire
    // quelles lettres ne vont pas la avant qu'on ait rien risque. Seul le mot
    // impossible se dit, et il se dit ici.
    meta.textContent = r !== null && !r.ok ? t(PLAY_MESSAGE[r.error]) : t(dit);
    return;
  }

  // Rien de retenu encore : c'est le mot qu'on tape qui occupe la case.
  if (r !== null) {
    w.className = "word";
    if (r.ok) {
      w.innerHTML = ligneDeMot({
        mot: r.move.word, ref: noteCoup(r.move.dir, r.move.x, r.move.y, cfg.bornes),
        pts: String(r.move.score),
      });
      meta.textContent = "";
    } else {
      w.innerHTML = ligneDeMot({ mot: r.word ?? typed, pts: "—" });
      meta.textContent = t(PLAY_MESSAGE[r.error]);
    }
    return;
  }

  // Les mots refuses de ce coup, tant qu'on ne tape pas : la premiere lettre
  // tapee rend la place au mot en cours.
  if (motsRefuses.length > 0) {
    bad.hidden = false;
    bad.textContent = (motsRefuses.length > 1
      ? t("Mots non valides :") : t("Mot non valide :")) + " " + motsRefuses.join(", ");
  }

  // LE VERDICT DU COUP QUI VIENT DE TOMBER.
  //
  // Entre deux coups, cette zone montrait un tiret -- et c'est precisement le
  // moment ou l'on veut savoir ce qui vient de se passer. Trois cas, et un
  // seul montre un negatif.
  const dernier = rejeu === null ? last : null;
  if (dernier !== null) {
    const parQui = duplicate
      ? trouveursDuCoup(dernier) : (dernier.player === null ? [] : [dernier.player]);
    if (parQui.includes(me)) {
      w.className = "word trouve";
      w.innerHTML = ligneDeMot({
        mot: "TOP", pts: String(dernier.score),
        jeton: { texte: t("trouvé"), classe: "trouve-jeton" },
      });
      meta.textContent = `${dernier.word} · ${t("vous avez trouvé le top")}`;
      return;
    }
    // QUELQU'UN L'A PRIS : son ecart personnel n'apprend rien a personne -- la
    // grille avance parce que le top est tombe, et c'est CELA qu'on veut voir.
    if (parQui.length > 0) {
      w.className = "word trouve";
      w.innerHTML = ligneDeMot({
        mot: dernier.word, ref: noteCoup(dernier.dir, dernier.x, dernier.y, cfg.bornes),
        pts: String(dernier.score),
        jeton: { texte: t("trouvé"), classe: "trouve-jeton" },
      });
      meta.textContent = quiLaTrouve(dernier, true);
      return;
    }
    // PERSONNE NE L'A TROUVE : c'est la, et seulement la, que l'ecart compte.
    const sien = dernier.propositions?.[me];
    if (sien !== undefined) {
      const ecart = dernier.score - sien.score;
      w.className = "word";
      w.innerHTML = ligneDeMot({
        mot: sien.word, ref: noteCoup(sien.dir, sien.x, sien.y, cfg.bornes),
        pts: `−${ecart}`,
      });
      w.querySelector(".pts")?.classList.add("rate");
      meta.textContent = `${sien.score} pts`;
      return;
    }
  }

  w.className = "word none";
  w.textContent = "—";
  meta.textContent = "";
}

/**
 * LA MONTANTE : ses compteurs dans la barre, son panneau a droite.
 *
 * TOUT VIENT DU SERVEUR, cumuls compris. Le client ne voit qu'une partie a la
 * fois : il ne saurait pas additionner ce qu'il n'a pas vu.
 *
 * LES TROIS GESTES SONT A L'HOTE, lui seul. Les autres joueurs lisent où en est
 * la suite et ce qu'elle a coute -- ils jouent la meme montante, elle ne leur
 * appartient simplement pas.
 */
function peindreLaMontante(): void {
  const m = montante;
  const enJeu = m !== null && rejeu === null;
  $("rb-mont-wrap").hidden = !enJeu;
  $("rb-mont-neg-wrap").hidden = !enJeu;
  $("montante-wrap").hidden = !enJeu;
  // LE TEMPS DU BANDEAU REDEVIENT CELUI DE LA PARTIE quand la montante s'en va,
  // et perd son rouge avec elle.
  if (!enJeu) { $("age").classList.remove("rouge"); return; }
  const mm = m!;

  $("rb-mont").textContent = `${mm.rang} / ${mm.etapes}`;
  $("rb-mont-wrap").title = mm.essai > 1
    ? t2("{f}, essai {n}", { f: t(mm.nom), n: mm.essai })
    : t(mm.nom);
  // LE NEGATIF DE LA SUITE, PAS CELUI DE L'ETAPE. « Top » tant qu'aucun coup
  // n'a echappe a la table : c'est la meme lecture que le negatif personnel.
  $("rb-mont-neg").textContent = mm.negatif === 0 ? t("Top") : `−${mm.negatif}`;
  $("rb-mont-neg").classList.toggle("rouge", mm.rates > 0);
  // DES QU'UN COUP EST RATE, LE TOTAL PASSE AU ROUGE (SPEC.md §23). C'est le
  // temps qui fait le record de vitesse : c'est donc lui qui doit dire qu'il n'y
  // concourt plus.
  $("age").classList.toggle("rouge", mm.rates > 0);

  // Les six etapes, et où l'on en est.
  const chips = $("mt-etapes");
  chips.replaceChildren();
  for (const e of ETAPES) {
    const c = el("span", "mt-etape");
    c.appendChild(el("i", "", `${e.rang}. `));
    c.appendChild(document.createTextNode(t(e.nom)));
    if (e.rang === mm.rang && !mm.finie) c.classList.add("ici");
    else if (e.rang < mm.rang || mm.finie) c.classList.add("faite");
    chips.appendChild(c);
  }

  const points = mm.cumul.toLocaleString("fr");
  $("mt-etat").textContent = mm.finie
    ? [
      t2("{n} étapes", { n: mm.etapes }),
      t2("{n} coups", { n: mm.coups }),
      t2("{n} points", { n: points }),
      mm.rates === 0 ? t("topée") : t2("négatif -{n}", { n: mm.negatif }),
    ].join(" · ")
    : [
      t2("Étape {n} sur {t}", { n: mm.rang, t: mm.etapes }),
      t(mm.nom),
      ...(mm.essai > 1 ? [t2("essai {n}", { n: mm.essai })] : []),
      ...(mm.perdue ? [t("hors tableau")] : []),
    ].join(" · ");
  $("mt-titre").textContent = mm.finie ? t("Montante terminée") : t("Montante");

  // LES BOUTONS SONT A L'HOTE. Sur une grille permanente il n'y a pas de
  // montante du tout, mais la regle se redit plutot que de se supposer.
  const aMoi = gerant === me && !permanent;
  // LA CASE DE PAUSE EST A L'HOTE AUSSI, et disparait avec la montante.
  $("mt-pause-wrap").hidden = !aMoi || mm.finie;
  ($("mt-pause") as HTMLInputElement).checked = mm.pause;
  // « ETAPE SUIVANTE » N'EXISTE QUE SOUS PAUSE. Sans elle, la suite part
  // d'elle-meme deux secondes apres le dernier coup : un bouton qui parait pour
  // disparaitre aussitot ne sert a personne.
  const suivante = aMoi && mm.pause && mm.close && !mm.finie && mm.suivante !== null;
  const terminer = aMoi && mm.close && !mm.finie && mm.suivante === null;
  const reprendre = aMoi && mm.reprenable !== null && !mm.finie;
  $("mt-suivante").hidden = !suivante;
  $("mt-terminer").hidden = !terminer;
  $("mt-neuve").hidden = !(aMoi && mm.finie);
  $("mt-reprendre").hidden = !reprendre;
  $("mt-boutons").hidden = !(suivante || terminer || reprendre || (aMoi && mm.finie));
  if (suivante) {
    $("mt-suivante").textContent =
      t2("Étape {n} : {f}", { n: mm.rang + 1, f: t(mm.suivante!) });
  }
  if (reprendre) {
    $("mt-reprendre").textContent =
      t2("Recommencer l'étape {n} ({f})",
        { n: mm.reprenable!, f: t(mm.nomReprenable ?? "") });
    // LE PRIX EST DIT AVANT LE CLIC. Le temps deja passe reste au compteur ;
    // seul le negatif s'efface. Sans ce prix, on recommencerait jusqu'a tomber
    // sur une grille facile.
    $("mt-reprendre").title =
      t("Le temps déjà joué reste au compteur ; le négatif de la tentative abandonnée est oublié.");
  }
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
  //
  // PAS PENDANT UNE MONTANTE : la suite a ses propres boutons, et « Rejouer »
  // y relancerait une partie seule, ce qui mettrait fin a la montante sans le
  // dire. Qui veut en sortir passe par les reglages, et le voit.
  $("rejouer-wrap").hidden = !finie || gerant !== me || permanent || montante !== null
    || epreuve !== null;
  // DEFIER SUR CETTE PARTIE (SPEC.md §29) : a tous les joueurs, pas au seul
  // hote, et jamais sur une epreuve ni sur la grille permanente.
  // UNE MANCHE DE TOURNOI NE SE DEFIE PAS : elle appartient a sa rencontre.
  $("defier-wrap").hidden = !finie || permanent || epreuve !== null
    || rencontreSalon !== null || history.length === 0;
  peindreLaMontante();
  peindreLEpreuve();
  peindreLaRencontreDuSalon();
  peindreLeSpectateur();

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
  // « Plusieurs » se compte sur la partie entiere, pas sur les connectes du
  // moment : sur une grille permanente ouverte depuis des semaines, se retrouver
  // seul devant a trois heures du matin n'en fait pas une partie solitaire.
  const monde = new Set([...online, ...Object.keys(players), ...Object.keys(points)]);
  const enGroupe = !duplicate && monde.size > 1;
  // LA BATTLE : du topping a plusieurs, chacun pour soi. Le classement y est le
  // coeur de la partie ; la liste des connectes ne dit rien de plus que lui, et
  // le journal des coups peut attendre qu'on le deroule.
  const battle = enGroupe && cfg.toppingCollaboratif !== true;
  // EN BATTLE, LA LISTE DES CONNECTES NE DIT RIEN QUE LE CLASSEMENT NE DISE --
  // sauf quand on est regarde : ceux-la n'ont pas de ligne au classement.
  $("online-bloc").hidden = battle && ceuxQuiRegardent.length === 0;
  if (battle && !journalReplie) {
    journalReplie = true;
    $("journal").hidden = true;
    $("journal-tri").textContent = "▸";
    $("journal-tete").setAttribute("aria-expanded", "false");
  }
  // LE SCORE PERSONNEL DISPARAIT DES QU'ON EST PLUSIEURS EN TOPPING.
  //
  // Ce qu'il additionne, ce sont les points des mots qu'on a SOUMIS a chaque
  // coup : c'est la comptabilite du duplicate, ou chacun marque ce qu'il pose.
  // Le topping ne marche pas ainsi -- la grille n'avance que par le top, et ce
  // qu'on a propose a cote ne se pose sur aucune grille. Un total de mille
  // deux cents points n'y designe alors rien du tout, et il invite a lire une
  // partie collective comme un classement individuel.
  //
  // En solitaire il garde son sens : c'est ce qu'on a su prendre sur la partie
  // du jour, et il n'y a personne d'autre a qui le comparer.
  // ET NI L'UN NI L'AUTRE PENDANT UNE MONTANTE. Ce qui compte est le negatif de
  // la SUITE, affiche a cote : deux cases « Negatif » cote a cote, l'une pour
  // l'etape et l'autre pour la montante, ne se lisent pas.
  $("rb-score-wrap").hidden = rejeu !== null || enGroupe || montante !== null
    || monScore === 0 && monNegatif === 0;
  $("rb-score").textContent = String(monScore);
  // LE NEGATIF SUIT LE SCORE, ET POUR LA MEME RAISON. Il dit ce qu'on a laisse
  // au top sur SA PROPRE FEUILLE : il a du sens au duplicate, ou chacun tient la
  // sienne et marque a chaque coup, et en topping SOLITAIRE, ou il est la seule
  // mesure de ce qu'on a manque. A plusieurs en topping, la grille n'avance que
  // parce que quelqu'un a trouve le top : le travail est commun, et un ecart
  // personnel n'y mesure rien.
  // EN TOPPING COLLABORATIF, LE NEGATIF REVIENT, et c'est celui de la FEUILLE :
  // la table n'en tient qu'une, ce qu'elle a laisse au top la mesure entiere, et
  // c'est ce chiffre-la que le classement d'une epreuve retiendra (SPEC.md §29).
  const collectif = cfg.toppingCollaboratif === true && !duplicate;
  const negatifMontre = collectif ? negatifCollectif : monNegatif;
  $("rb-neg-wrap").hidden = rejeu !== null || montante !== null
    || (!collectif && enGroupe)
    || (monScore === 0 && negatifMontre === 0);
  // LE SOLVEUR NE S'UTILISE PAS PENDANT UNE PARTIE A PLUSIEURS : ce serait
  // presque tenter les joueurs a tricher. « Seul » se compte sur la partie
  // entiere (voir le commentaire de `monde` ci-dessus), pas seulement sur cet
  // instant. AVANT LE DEBUT ET UNE FOIS LA PARTIE CLOSE, plus personne n'a
  // d'avantage a en tirer -- disponible meme si on n'a jamais ete seul.
  // JAMAIS SUR UN SALON STAR (`salonPermanent`, sans proprietaire) : la
  // grille mondiale n'est jamais vraiment "seul", elle attend simplement le
  // prochain joueur, et ne se ferme ni ne se termine jamais.
  // UNE MANCHE FERME L'ANAGRAMMEUR PENDANT LA PARTIE, meme seul : c'est une
  // epreuve classee. Avant et apres, il est la comme ailleurs (SPEC.md §29).
  const soloEtHorsStar = !salonPermanent
    && (epreuve !== null ? (finie || !demarree) : (monde.size <= 1 || finie || !demarree));
  $("solveur-jeu").hidden = !soloEtHorsStar;
  if (!soloEtHorsStar) fermerLeSolveurMini();
  $("rb-neg").textContent = negatifMontre === 0 ? "Top" : `−${negatifMontre}`;
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
    lw.innerHTML = ligneDeMot({
      mot: last.word, ref: noteCoup(last.dir, last.x, last.y, cfg.bornes),
      pts: String(last.score),
      ...(trouve ? {} : { jeton: { texte: t("non trouvé"), classe: "rate" } }),
    });
    // Au duplicate, mon ecart au top sur CE coup. Il reste affiche tant que le
     // coup suivant ne l'a pas remplace : c'est le temps qu'on a de le lire.
    const mien = duplicate ? last.scores?.[me] : undefined;
    const ecart = mien === undefined ? 0 : mien - last.score;
    lm.textContent = quiLaTrouve(last, true) +
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
        `<span class="nom">${t(n > 1 ? "Non trouvés" : "Non trouvé")}</span>` +
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
      // TOPPING COLLABORATIF : le nombre de coups remportes par chacun reste
      // ecrit -- la feuille de route le porte toujours -- mais ne s'affiche
      // plus a table, pour un topping moins competitif (SPEC.md §16).
      : `<span class="likes"></span>` +
        `<span class="num">${cfg.toppingCollaboratif ? "" : Number.isInteger(n) ? n : n.toFixed(1)}</span>`;
    const marque = verifies.has(name) ? '<b class="verifie" title="joueur vérifié">✓</b>' : "";
    const vrai = nomsPublics[name];
    const infobulle = vrai === undefined ? "" : ` title="${vrai.replace(/"/g, "&quot;")}"`;
    // LE BOUTON NE PARAIT QU'UNE FOIS LA LIGNE DEROULEE. Sur chaque ligne, il
    // encombrait un classement qu'on lit en jouant ; deroule, on regarde deja
    // ce joueur-la.
    const profil = inscrits.has(name) && openPlayer === name
      ? '<button type="button" class="voir-profil" title="Voir le profil">profil</button>' : "";
    // UNE COULEUR PAR JOUEUR EN BATTLE : on suit le sien d'un coup d'oeil, au
    // classement comme sur la feuille de route.
    const teinte = battle ? ` style="color:${couleurDuJoueur(name)}"` : "";
    row.innerHTML = `<span class="tri">${openPlayer === name ? "▾" : "▸"}</span>` +
                    `<span class="nom"${infobulle}${teinte}>${pseudoOrne(name)}${marque}${coeurs}${profil}</span>` + droite;
    row.querySelector(".voir-profil")?.addEventListener("click", (e) => {
      // Le clic sur la ligne DEROULE les coups : celui-ci ne doit pas y monter.
      e.stopPropagation();
      void ouvrirLaFiche(name);
    });
    row.addEventListener("click", () => {
      openPlayer = openPlayer === name ? null : name;
      // REPLIER LA LISTE RETIRE LE MOT DE LA GRILLE.
      //
      // On l'y avait pose pour voir OU ce joueur avait joue ; la liste
      // refermee, il n'a plus de raison d'y etre -- et il barrait les cases ou
      // l'on voulait ecrire. Il fallait jusqu'ici recliquer le mot du top, ou
      // attendre la fin du coup, pour retrouver une grille libre.
      ghost = null;
      paintSide();
      draw();
    });
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
        e.className = "none"; e.textContent = t("aucun coup enregistré");
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
          r.title = t2("Coup {n} : {mot} pour {pts} pts.", { n: m.n, mot, pts: sc }) + " " +
            t2("Le top {top} valait {pts} pts", { top: m.word, pts: m.score }) +
            (ecart === 0 ? " " + t("— trouvé.") : t2(", manqué de {ecart} pts.", { ecart }));
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
    e.innerHTML = pseudoOrne(n) + (verifies.has(n) ? " ✓" : "");
    const vrai = nomsPublics[n];
    if (vrai !== undefined) e.title = vrai;
    if (inscrits.has(n)) {
      e.classList.add("fiche-ouvrable");
      e.addEventListener("click", () => { void ouvrirLaFiche(n); });
    }
    boiteEnLigne.appendChild(e);
    if (i < online.length - 1) boiteEnLigne.appendChild(document.createTextNode(", "));
  }
  // CEUX QUI REGARDENT, a part (SPEC.md §29) : ils ne comptent dans aucun
  // total, et les confondre avec les joueurs ferait croire a une table pleine.
  if (ceuxQuiRegardent.length > 0) {
    boiteEnLigne.appendChild(el("div", "sub", `${t("Regardent")} : ${ceuxQuiRegardent.join(", ")}`));
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
  b.title = m.player === null ? t("coup révélé, personne à féliciter")
    : m.player === me ? t("votre coup") : t2("bravo à {qui}", { qui: m.player });
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
  // MASQUER UN MOT EST UN GESTE EPHEMERE. On barre l'oeil pour chercher CETTE
  // position-la ; passer au coup suivant -- par les fleches ou par la feuille
  // de route -- c'est en regarder une autre, et l'on veut la voir. L'oeil se
  // rouvre donc a chaque coup, comme il se rouvre en fermant le rejeu.
  ghostCache = false;
  const m = history.find((q) => q.n === borne);
  $("panel-live").hidden = true;
  $("panel-rejeu").hidden = false;
  // Le journal des coups joues n'a pas sa place ici : il montre l'etat FINAL
  // de la partie, si bien qu'y cliquer depuis le coup 1 posait un mot du coup
  // 40 au milieu de nulle part. Le chat se replie sans disparaitre.
  document.querySelector(".side")!.classList.add("rejeu");
  $("journal-bloc").hidden = true;
  $("rj-titre").textContent = t2("Coup {n}", { n: borne });
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
    attente.textContent = t("chargement des solutions…");
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
    const trouveurs = trouveursDuCoup(m);
    if (trouveurs.length === 0) return t("non trouvé");
    if (complet || trouveurs.length <= 2) return trouveurs.join(", ");
    return t2("{n} joueurs", { n: trouveurs.length });
  }
  return m.player ?? (m.demiPoint ? `${m.demiPoint.joueur} (0.5)` : t("non trouvé"));
}

/**
 * SALONS STARS SEULEMENT : qui a deja tope WU ou QI, exactement -- pas un
 * isotop, pas un pluriel. La premiere lettre de son pseudo s'en pare, dans le
 * classement, les connectes et le chat, sans que rien ne le dise nulle part.
 *
 * Reconstruits entierement a l'arrivee d'un salon (la grille mondiale porte
 * des milliers de coups), puis tenus a jour coup par coup : rescanner tout
 * l'historique a chaque peinture de l'ecran couterait cher pour une grille
 * qui ne s'arrete jamais.
 */
let joueursWU = new Set<string>();
let joueursQI = new Set<string>();

function reconstituerLesJetons(): void {
  joueursWU = new Set();
  joueursQI = new Set();
  for (const m of history) enregistrerLeJetonDuCoup(m);
}

function enregistrerLeJetonDuCoup(m: MoveInfo): void {
  // Un coup DE DUPLICATE se reconnait a ses propositions, pas au drapeau
  // global `duplicate` -- celui-ci change de valeur pendant `applyState`, et
  // l'ordre entre les deux ne doit pas decider ce que ce coup-la a ete.
  if (m.trouveurs !== undefined || m.propositions !== undefined) {
    for (const nom of trouveursDuCoup(m)) {
      const mot = m.propositions?.[nom]?.word;
      if (mot === "WU") joueursWU.add(nom);
      if (mot === "QI") joueursQI.add(nom);
    }
    return;
  }
  if (m.player === null) return;
  const mot = m.playerWord ?? m.word;
  if (mot === "WU") joueursWU.add(m.player);
  if (mot === "QI") joueursQI.add(m.player);
}

/**
 * Or, argent ou bronze pour la premiere lettre de ce pseudo -- `null` hors
 * salon star, ou si ce joueur n'a encore rien de tout ca. Le WU n'existe pas
 * en anglais : le salon star anglais ne connait que l'argent du QI.
 */
function jetonDuJoueur(nom: string): "or" | "argent" | "bronze" | null {
  if (!salonPermanent) return null;
  const qi = joueursQI.has(nom);
  if (dictionnaire(cfg.dictionnaire).langue === "en") return qi ? "argent" : null;
  const wu = joueursWU.has(nom);
  if (wu && qi) return "or";
  if (wu) return "argent";
  if (qi) return "bronze";
  return null;
}

/** Le pseudo tel qu'il s'affiche, sa premiere lettre en metal s'il y a lieu. */
function pseudoOrne(nom: string): string {
  const jeton = jetonDuJoueur(nom);
  return jeton === null ? nom : `<span class="lettre-${jeton}">${nom.slice(0, 1)}</span>${nom.slice(1)}`;
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
    $("rj-compte").textContent = t("mot inconnu");
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
  // CE QU'ON A RENDU SOI-MEME SUR CE COUP se teinte : on ouvre la liste pour le
  // retrouver -- « j'avais mis quoi, moi ? » -- et le chercher a l'oeil dans
  // cent solutions ne sert personne.
  const ici = rejeu;
  const joue = ici === null ? undefined : history.find((h) => h.n === ici.n);
  const mien = joue?.propositions?.[me];

  let html = "";
  for (let i = debut; i < fin; i++) {
    const s = solutionsVues[i]!;
    const mienne = mien !== undefined && s.word === mien.word && s.dir === mien.dir
      && s.x === mien.x && s.y === mien.y;
    html +=
      `<button type="button" class="sol${s.ecart === 0 ? " best" : ""}${s.hors ? " hors" : ""}` +
      `${mienne ? " mienne" : ""}"` +
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
    `<b>${trouves}</b> ${t(trouves > 1 ? "trouvés" : "trouvé")}`
      + `, <b>${perdus}</b> ${t(perdus > 1 ? "non trouvés" : "non trouvé")}`
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
    e.className = "none"; e.style.padding = "14px 18px"; e.textContent = t("aucun coup joué");
    body.appendChild(e);
    return;
  }
  // Le cumul se compte dans l'ordre de la partie, quel que soit celui de
  // l'affichage : c'est le temps ecoule depuis le premier coup.
  cumulRoute.clear();
  cumulNegMot.clear();
  let somme = 0;
  let sommeNeg = 0;
  for (const m of history) {
    somme += Math.max(0, m.ms);
    cumulRoute.set(m.n, somme);
    if (duplicate) {
      const p = m.propositions?.[me];
      const negMot = p === undefined ? -m.score : p.score - m.score;
      sommeNeg += negMot;
      cumulNegMot.set(m.n, sommeNeg);
    }
  }

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
    piste.innerHTML = `<div class="rm-vide">${t("aucun coup ne correspond")}</div>`;
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

/** Cumul du négatif du mot joué en duplicate (différence avec le top). */
const cumulNegMot = new Map<number, number>();

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
  if (duplicate) {
    const p = m.propositions?.[me];
    const negMot = p === undefined ? -m.score : p.score - m.score;
    cumulNegMot.set(m.n, (cumulNegMot.get(m.n - 1) ?? 0) + negMot);
  }
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
  const trouve = duplicate ? (m.trouveurs ?? []).length > 0 || quiLaTrouve(m) !== t("non trouvé")
                           : m.player !== null || m.demiPoint !== undefined;
  // CE QUE VOUS AVEZ JOUE, comme sur une feuille de tournoi.
  //
  // Seulement quand cela differe du top affiche : sur un coup remporte avec le
  // mot montre, la colonne repeterait la precedente. Elle apparait donc dans
  // les deux cas ou elle apprend quelque chose -- un coup manque, et un isotop
  // joue a une autre place que celle que le logiciel a retenue.
  let sien = "";
  let motInfo = "";
  if (duplicate) {
    const p = m.propositions?.[me];
    const pareil = p !== undefined && p.word === m.word && p.dir === m.dir
      && p.x === m.x && p.y === m.y;
    sien = p === undefined || pareil
      ? `<span class="mw"></span><span class="mp"></span><span class="ms"></span>`
      : `<span class="mw">${echapper(p.word)}</span>` +
        `<span class="mp">${noteCoup(p.dir, p.x, p.y, cfg.bornes)}</span>` +
        `<span class="ms">${p.score}</span>`;

    const negMot = p === undefined ? -m.score : p.score - m.score;
    const cumulNeg = cumulNegMot.get(m.n) ?? 0;
    const affNegMot = negMot === 0 ? "top" : (negMot < 0 ? negMot : `+${negMot}`);
    motInfo = `<span class="md-mot${negMot === 0 ? " top" : ""}">${affNegMot}</span>` +
              `<span class="cumul-mot${cumulNeg >= 0 ? "" : " neg"}">${cumulNeg >= 0 ? cumulNeg : cumulNeg}</span>`;
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
    ` aria-pressed="${aime}" title="${m.player === null ? t("coup révélé, personne à féliciter")
      : m.player === me ? t("votre coup")
      : t2("bravo à {qui}", { qui: echapper(m.player) })}">` +
    `<span aria-hidden="true">${aime ? "♥" : "♡"}</span>` +
    `<span class="n">${m.likes ?? 0}</span></button>`;

  // L'image de la position AVANT ce coup, tirage en tete. Disponible en cours
  // de partie et sur une grille infinie, la ou le rejeu ne l'est pas : c'est ce
  // qui permet de proposer un coup a chercher a tout moment.
  const image =
    `<button type="button" class="rm-image" data-image="${m.n}"` +
    ` title="${t2("image de la grille au coup {n}, avec son tirage", { n: m.n })}">${ICONE_IMAGE}</button>`;
  // Rejouer CE coup. Sur une partie close, ou sur une grille qu'on etudie et
  // qui ouvre son rejeu : ailleurs, le serveur refuse les paliers et le rejeu
  // n'aurait rien a montrer. Une grille infinie n'a pas de fin -- sans cette
  // ouverture, ses isotops et ses sous-tops resteraient a jamais invisibles.
  const rejouer = finie || rejeuOuvert
    ? `<button type="button" class="rm-rejouer" data-revoir="${m.n}" title="${t2("revoir le coup {n}", { n: m.n })}">R</button>`
    : `<span class="r"></span>`;

  const tousLesTrouveurs = duplicate ? trouveursDuCoup(m) : [];
  const infobulle = tousLesTrouveurs.length > 2
    ? ` title="trouvé par ${echapper(tousLesTrouveurs.join(", "))}"` : "";
  // LA LIGNE PORTE LA COULEUR DE CELUI QUI A TROUVE LE TOP : on retrouve les
  // siens en descendant la feuille, sans lire un seul nom.
  const teinte = m.player === null ? "" : `;--qui:${couleurDuJoueur(m.player)}`;
  return `<div class="rmrow" tabindex="0" data-coup="${m.n}"${infobulle} style="top:${haut}px${teinte}">` +
    `<span class="n">${m.n}</span><span class="q">${echapper(m.notation)}</span>` +
    image + rejouer +
    `<span class="w">${echapper(m.word)}</span>` +
    `<span class="p">${noteCoup(m.dir, m.x, m.y, cfg.bornes)}</span>` +
    `<span class="s">${m.score}</span>` + sien + motInfo +
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
  if (history.length === 0) { flash(t("aucun coup à enregistrer"), "bad"); return; }
  const salonNom = ($("conn").textContent ?? "").split("·").pop()?.trim() || "grille";
  const q = ($("rm-q") as HTMLInputElement).value.trim();
  const quand = new Date().toLocaleString("fr", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const titre = `${salonNom} — feuille de route`;

  const colonnes = duplicate
    ? ["N°", "Tirage", "Top", "Pos.", "Pts", "Joué", "Pos.", "Pts", "−Mot", "−Cum", "Qui", "−Top", "Trouvé"]
    : ["N°", "Tirage", "Mot", "Place", "Points", "Qui", "Temps", "Cumul"];

  const lignes = routeVues.map((m) => {
    const trouve = duplicate ? trouveursDuCoup(m).length > 0 : m.player !== null;
    let fin: string[];
    if (duplicate) {
      const p = m.propositions?.[me];
      const mien = m.scores?.[me];
      const ecart = mien === undefined ? null : mien - m.score;
      const negMot = p === undefined ? -m.score : p.score - m.score;
      const cumulNeg = cumulNegMot.get(m.n) ?? 0;
      const trouveurs = trouveursDuCoup(m).length;
      const presents = Object.keys(m.scores ?? {}).length;
      const motJoue = p === undefined ? "" : p.word;
      const placeJoue = p === undefined ? "" : noteCoup(p.dir, p.x, p.y, cfg.bornes);
      const scoreJoue = p === undefined ? "" : String(p.score);
      const affNeg = negMot === 0 ? "top" : (negMot < 0 ? String(negMot) : `+${negMot}`);
      fin = [motJoue, placeJoue, scoreJoue,
             affNeg,
             String(cumulNeg),
             quiLaTrouve(m, true),
             ecart === null ? "—" : ecart === 0 ? "top" : String(ecart),
             presents === 0 ? "" : `${trouveurs}/${presents}`];
    } else {
      fin = [trouve ? fmtTime(m.ms) : "×", fmtTime(cumulRoute.get(m.n) ?? 0)];
    }
    const cases = [String(m.n), m.notation, m.word,
                   noteCoup(m.dir, m.x, m.y, cfg.bornes), String(m.score), ...fin];
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
  flash(t2("feuille enregistrée — {n} coup{s}",
    { n: routeVues.length, s: routeVues.length > 1 ? "s" : "" }), "ok");
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
function ajouterAuChat(m: Chat, chuchotement = false): void {
  // UN CHUCHOTEMENT NE S'ARCHIVE PAS : il ne vient pas du chat du salon, et
  // n'entre donc pas dans son historique. Il se pose au bas de la liste, en
  // italique, et disparait quand on recharge.
  if (chuchotement) {
    const log0 = $("chat-log");
    const enBas0 = log0.scrollHeight - log0.scrollTop - log0.clientHeight < 40;
    const ligne = ligneDeChat(m);
    ligne.classList.add("chuchote");
    log0.appendChild(ligne);
    if (enBas0) log0.scrollTop = log0.scrollHeight;
    return;
  }
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
  who.className = "who"; who.innerHTML = pseudoOrne(m.who);
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
  at.textContent = new Date(m.at).toLocaleTimeString(langue() === "en" ? "en-GB" : "fr-FR",
    { hour: "2-digit", minute: "2-digit" });
  el.appendChild(at);
  return el;
}

let chat: Chat[] = [];
function sendChat(withCell: boolean) {
  const input = $("chat-text") as HTMLInputElement;
  const text = input.value.trim();
  const cell = withCell && cursor !== null ? { x: cursor.x, y: cursor.y } : undefined;
  if (!text && !cell) return;
  envoyer({ t: "say", text, cell, ...(jeRegarde && chuchote ? { chuchote: true } : {}) });
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
   * Regle-t-on ses salons dans la fenetre simple ou dans la fenetre complete ?
   *
   * On arrive dans la simple : quatre decisions, pas quinze. Le jour ou l'on
   * bascule, on y reste -- qui a demande les reglages avances ne veut pas les
   * redemander a chaque salon.
   */
  avance: boolean;
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
   * Le tirage se melange-t-il au hasard, plutot que de rester range dans
   * l'ordre alphabetique que le serveur envoie ?
   *
   * Reglage, decoche par defaut, comme le curseur a quatre directions
   * ci-dessus : les deux vivent dans le meme panneau rapide, au-dessus de
   * l'anagrammeur (SPEC.md §28). Ce n'est qu'un arrangement d'affichage --
   * voir `ordreChevalet` -- rien n'en sort vers le serveur, et melanger ses
   * propres lettres ne donne aucun avantage a plusieurs.
   */
  melange: boolean;
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
  // LES REPERES SUIVENT LA LANGUE, tant que personne n'en a decide autrement.
  // L'ecole francaise nomme les lignes A a O, l'anglaise les colonnes : arriver
  // sur la version anglaise et lire « H8 » a la francaise, c'est chercher sa
  // case au mauvais endroit. Un choix explicite est relu ensuite et l'emporte.
  reperes: langue() === "en" ? "en" : "fr",
  avance: false,
  quatre: false,
  melange: false,
  zoomRoute: 1,
  zoomCote: 1,
};
const CLE_PREFS = "farfouille.preferences";

/**
 * A-t-on choisi ses reperes soi-meme ?
 *
 * Tant que non, ils suivent la langue. Des qu'on y touche, ils n'obeissent plus
 * qu'a ce choix -- un joueur francophone qui prefere les colonnes doit pouvoir
 * les garder en passant le site en anglais, et l'inverse aussi.
 */
let reperesChoisis = false;

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
    if (v.reperes === "fr" || v.reperes === "en") {
      prefs.reperes = v.reperes;
      reperesChoisis = true;
    }
    if (typeof v.quatre === "boolean") prefs.quatre = v.quatre;
    if (typeof v.melange === "boolean") prefs.melange = v.melange;
    if (typeof v.avance === "boolean") prefs.avance = v.avance;
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
  // Un bandeau deja ouvert qui redit la meme chose ne se voit pas : on lui
  // fait changer de teinte, et le refus suivant le ramene a la premiere.
  const repete = !el.hidden && el.classList.contains(kind);
  const encore = repete && !el.classList.contains("encore");
  el.textContent = text;
  el.className = `flash ${kind}${encore ? " encore" : ""}`;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { el.hidden = true; }, kind === "top" ? 2600 : 1900);
}

/** Referme le bandeau sur-le-champ, sans attendre son echeance. */
function fermerLeFlash(): void {
  clearTimeout(flashTimer);
  $("flash").hidden = true;
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
    // RECLIQUER LA CASE DE DEPART PIVOTE, comme la barre d'espace -- meme au
    // milieu d'un mot, et c'est la tout l'interet : on s'apercoit qu'on ecrit
    // MANGER a l'horizontale alors qu'on le voulait vertical, et la case de
    // depart est justement celle qu'on vise. Le mot s'efface, le retourner tel
    // quel poserait les memes caramels a l'envers.
    cursor = pivoter(cursor);
    typed = "";
  } else {
    cursor = { x, y, dir: p.button === 2 ? "V" : "H", rec: false };
    typed = "";
  }
  paintRack(); paintCurrent(); draw();
});
cv.addEventListener("pointercancel", () => { press = null; clearTimeout(holdTimer); cv.style.cursor = ""; });

addEventListener("keydown", (e) => {
  // LA CONFIRMATION PASSE AVANT TOUT LE RESTE, meme les reglages ou le voile
  // du pseudo qu'elle peut recouvrir : Entree vaut Oui, Echap vaut Non, comme
  // dans n'importe quelle boite de dialogue (SPEC.md §24-25).
  if (!$("voile-confirmer").hidden) {
    if (e.key === "Enter") { e.preventDefault(); ($("confirmer-oui") as HTMLButtonElement).click(); }
    else if (e.key === "Escape") { e.preventDefault(); ($("confirmer-non") as HTMLButtonElement).click(); }
    return;
  }
  // LE FORMULAIRE DES BUGS S'OUVRE DES DEUX COTES, donc Echap le referme des
  // deux cotes -- y compris depuis sa zone de texte, qui garderait la touche
  // pour elle si l'on attendait les branches suivantes.
  if (e.key === "Escape" && !$("voile-bug").hidden) {
    fermerLesBugs();
    e.preventDefault();
    return;
  }
  // SUR L'ACCUEIL, ECHAP REFERME CE QUI S'Y OUVRE, et rien d'autre ne passe :
  // les raccourcis du jeu n'ont pas cours tant qu'on n'est pas dans un salon.
  if (!$("join").hidden) {
    if (e.key !== "Escape") return;
    if (!$("voile-route").hidden) { fermerLaFeuille(); return; }
    if (!$("voile-tablee").hidden) { $("voile-tablee").hidden = true; return; }
    if (!$("voile-trouves").hidden) { $("voile-trouves").hidden = true; return; }
    if (!$("voile-joueur").hidden) { $("voile-joueur").hidden = true; return; }
    if (!$("voile-admin").hidden) { $("voile-admin").hidden = true; return; }
    if (!$("voile-compte").hidden) { $("voile-compte").hidden = true; return; }
    if (!$("voile-regles").hidden) { $("voile-regles").hidden = true; return; }
    if (!$("voile").hidden) { destination = null; $("voile").hidden = true; }
    return;
  }
  // ENTREE VALIDE LES REGLAGES, comme dans n'importe quel formulaire -- que le
  // curseur soit dans un de ses champs ou nulle part. Sans cela elle tombait
  // dans le jeu, derriere le panneau, et tentait de poser le mot en cours.
  if (!$("reglages").hidden && e.key === "Enter") {
    e.preventDefault();
    ($("r-appliquer") as HTMLButtonElement).click();
    return;
  }
  // ECHAP FERME LES REGLAGES SANS LES APPLIQUER, comme son bouton de
  // fermeture -- y compris depuis un champ de saisie a l'interieur, pour la
  // meme raison qu'Entree les valide depuis n'importe lequel de ses champs
  // juste au-dessus.
  if (!$("reglages").hidden && e.key === "Escape") {
    e.preventDefault();
    $("reglages").hidden = true;
    return;
  }
  // ENTREE LANCE LA PARTIE DU JOUR, SEUL (SPEC.md §29) : c'est le cas de presque
  // tout le monde, tous les matins. Depuis le champ des noms, elle la lance a
  // plusieurs sur le compte.
  if (e.key === "Enter" && epreuveALancer()) {
    e.preventDefault();
    if (document.activeElement === $("ep-noms")) ($("ep-lancer-compte") as HTMLButtonElement).click();
    else if (!$("ep-seul").hidden) ($("ep-seul") as HTMLButtonElement).click();
    else if (!$("ep-equipe").hidden) ($("ep-equipe") as HTMLButtonElement).click();
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
  // LA NOUVELLE PARTIE S'OUVRE AUSSI DEPUIS LE REJEU, pour la meme raison que
  // la feuille de route : on relit la partie qu'on vient de finir, et c'est
  // precisement de la qu'on veut en relancer une.
  //
  // Ctrl+D poserait un signet, ce qui n'a aucun sens ici -- on le prend, et on
  // le rend a son usage des qu'on est dans une zone de saisie, celles-ci ayant
  // rendu la main plus haut.
  //
  // CTRL+N N'EST PAS A PRENDRE. C'est le raccourci de « nouveau » partout
  // ailleurs, et il etait tentant de le servir ici aussi -- mais le navigateur
  // se le reserve AVANT la page : `preventDefault` n'y peut rien, et la touche
  // ouvre une fenetre neuve par-dessus le salon. Une moitie de raccourci est
  // pire que pas de raccourci du tout.
  if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    if (!$("reglages-open").hidden) ouvrirReglages();
    return;
  }
  // CTRL+ENTREE ABANDONNE LE COUP EN COURS (SPEC.md §24). Meme garde-fou que
  // le clic : le raccourci ne fait rien si le bouton n'est pas propose.
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    demanderLabandonDuCoup();
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
  if (!$("reglages-jeu-panneau").hidden && e.key === "Escape") { basculerLeReglageDeJeu(); return; }
  if (!$("roadmap").hidden && e.key === "Escape") { fermerLaRoute(); return; }
  if (ghost !== null && e.key === "Escape") { ghost = null; draw(); return; }

  // Ctrl+E ouvre le rejeu -- la ou le bouton l'ouvre, et nulle part ailleurs :
  // sur une partie en cours, montrer les paliers serait donner les reponses.
  if ((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E")) {
    e.preventDefault();
    if (!$("rejeu-wrap").hidden && rejeu === null) voirLeCoup(1);
    return;
  }
  // CTRL+G OUVRE (OU FERME) LE MINI ANAGRAMMEUR -- E etait deja pris par le
  // rejeu ci-dessus. Meme garde-fou que le bouton lui-meme : cache des qu'on
  // est plusieurs sur une partie en cours, ou sur un salon star (voir
  // paintSide()) -- le raccourci ne fait rien de plus que simuler ce clic.
  if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
    // LA TOUCHE EST PRISE MEME QUAND ELLE N'OUVRE RIEN. Rendre la main au
    // navigateur sur une partie a plusieurs y declenchait sa propre recherche,
    // qui s'ouvre en travers de la grille : on croit appeler l'anagrammeur, on
    // recoit la barre de recherche du navigateur. Le raccourci ne fait donc
    // rien du tout la ou le bouton lui-meme est cache.
    e.preventDefault();
    if ($("solveur-jeu").hidden) return;
    if (miniOuvert) fermerLeSolveurMini(); else ouvrirLeSolveurMini();
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
  // 1 MELANGE LE TIRAGE (SPEC.md §28), reglage decoche par defaut. `e.code`
  // et non `e.key`, comme les raccourcis 1-7 de l'anagrammeur : la touche
  // au-dessus du A vaut "Digit1" quel que soit ce qu'elle tape -- "1" en
  // QWERTY, "&" en AZERTY -- et le pave numerique la double. PAS QUAND LE
  // MINI ANAGRAMMEUR EST OUVERT : 1 y choisit deja une instance (SV_RACCOURCIS),
  // et l'anagrammeur plein ecran ferme cette meme touche plus haut (la page
  // se traite comme l'accueil, voir `$("join").hidden` en tete de cette
  // fonction).
  if ((e.code === "Digit1" || e.code === "Numpad1") && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (prefs.melange && !miniOuvert) {
      e.preventDefault();
      melangerLeChevalet();
    }
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
  // QUI REGARDE NE POSE RIEN (SPEC.md §29). Le serveur le refuserait de toute
  // facon ; le dire ici evite d'avoir tape un mot pour rien.
  if (jeRegarde) {
    flash(salonPermanent
      ? t("Pour pouvoir participer à la grille infinie il faut s'inscrire, ça ne prend qu'une minute.")
      : t("vous regardez cette partie"), "bad");
    return;
  }
  if (finie) { flash("la partie est terminée", "bad"); return; }
  if (solving) { flash("le coup n'est pas encore prêt", "bad"); return; }
  const c = coupCanonique();
  if (c === null) return;
  const r = resolveTypedWord(board, dict, c.dir, c.x, c.y, c.typed, rack);
  if (!r.ok) {
    noterLesRefus(r.error === "MOT_INCONNU" ? [r.word ?? c.typed, ...(r.bad ?? [])]
      : r.error === "COLLAGE_INCONNU" ? (r.bad ?? [])
      : []);
    flash(r.error === "TROP_DE_CARAMELS"
      ? t2("C'est une partie {x} sur {y}", { x: cfg.jouables, y: cfg.tirage })
      : t(PLAY_MESSAGE[r.error]), "bad");
    oublierLAttente();
    typed = ""; paintRack(); paintCurrent(); draw();
    return;
  }
  // Un mot accepte ferme le bandeau du refus precedent : le laisser vivre ses
  // deux secondes fait croire que celui-ci vient d'etre refuse aussi. Et il
  // efface la liste : elle ne parle que du dernier essai.
  fermerLeFlash();
  noterLesRefus([]);
  if (best === null || r.move.score > best.score) {
    best = { word: r.move.word, score: r.move.score, dir: r.move.dir, x: r.move.x, y: r.move.y };
  }
  // Les caramels tapes restent a l'ecran le temps de la reponse : voir
  // `attente`. A relever AVANT de vider `typed`, qui les decrit.
  const jokers = blankPositions();
  attente = typedCells().map((q) => ({
    x: q.x, y: q.y, letter: q.letter, blank: jokers.has(`${q.x},${q.y}`),
  }));
  clearTimeout(attenteMinuteur);
  attenteMinuteur = window.setTimeout(() => { attente = []; draw(); }, ATTENTE_MAX_MS);
  envoyer({ t: "try", dir: c.dir, x: c.x, y: c.y, typed: c.typed });
  typed = ""; paintRack(); paintSide(); draw();
}

$("reveal").addEventListener("click", () => envoyer({ t: "reveal" }));

$("lancer").addEventListener("click", () => {
  envoyer({ t: "lancer" });
  $("lancer-wrap").hidden = true;
});

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
/**
 * « Rejouer » REPART SUR LA MEME VARIANTE, champ pour champ.
 *
 * Un champ oublie ici ne se voit pas : le serveur retombe sur sa valeur par
 * defaut, et la partie repart en silence sur autre chose. `jokersParCoup`
 * manquait, si bien qu'un double joker se rejouait en joker simple.
 */
$("rejouer").addEventListener("click", () => {
  envoyer({
    t: "relancer", tirage: cfg.tirage, jouables: cfg.jouables, pioche: cfg.pioche,
    joker: cfg.joker, jokersParCoup: cfg.jokersParCoup,
    primes: cfg.primes, chrono: cfg.chrono, bornes: cfg.bornes,
    mode: cfg.mode, coupsMax: cfg.coupsMax, dureeMax: cfg.dureeMax,
    decompte: cfg.decompte, dictionnaire: cfg.dictionnaire,
    // REJOUER NE CHANGE AUCUN REGLAGE : sans cette ligne, le topping
    // collaboratif s'eteignait tout seul a chaque relance.
    toppingCollaboratif: cfg.toppingCollaboratif,
  });
});

/**
 * LES TROIS GESTES DE LA MONTANTE, ET LE QUATRIEME QUI EN RELANCE UNE.
 *
 * Tous a l'hote. Le serveur le verifie de son cote : un bouton cache est un
 * garde-fou, pas une regle.
 */
$("mt-suivante").addEventListener("click", () => envoyer({ t: "montante-suivante" }));
$("mt-reprendre").addEventListener("click", () => envoyer({ t: "montante-reprendre" }));
$("mt-terminer").addEventListener("click", () => envoyer({ t: "montante-terminer" }));

/**
 * La pause entre les parties. L'eteindre alors qu'une etape close attend relance
 * la suite aussitot -- c'est le serveur qui s'en charge.
 */
$("mt-pause").addEventListener("change", () => {
  envoyer({ t: "montante-pause", pause: ($("mt-pause") as HTMLInputElement).checked });
});

/**
 * Une montante neuve, sur les memes reglages : le chrono, le lexique et la
 * grille. Le format, lui, repart de l'etape 1 -- c'est le serveur qui l'impose,
 * et il n'y a rien a lui envoyer pour cela.
 */
$("mt-neuve").addEventListener("click", () => {
  envoyer({
    t: "relancer", montante: true,
    chrono: cfg.chrono, bornes: cfg.bornes, dictionnaire: cfg.dictionnaire,
    pioche: cfg.pioche, decompte: cfg.decompte,
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
  for (const b of $("p-reperes").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === prefs.reperes));
  }
  peuplerReperes();
}

/**
 * Les reperes se nomment d'apres LE PLATEAU QU'ON A SOUS LES YEUX.
 *
 * « lignes A–O » etait ecrit en dur : sur la super grille, les lettres vont
 * jusqu'a U, et l'exemple donne dans les parametres decrivait un plateau qui
 * n'etait pas celui de la partie.
 *
 * Sur l'accueil, et sur une grille infinie ou les regles portent des nombres
 * signes plutot que des lettres, on nomme le plateau du commerce : c'est la
 * reference des deux ecoles.
 */
function peuplerReperes(): void {
  const b = !$("join").hidden || !configRecue || cfg.bornes === null ? 7 : cfg.bornes;
  const derniere = String.fromCharCode(65 + b * 2);
  $("p-reperes-titre").textContent = t2("Repères du plateau {n}×{n}", { n: b * 2 + 1 });
  $("p-reperes-fr").textContent = t2("lignes A–{z}", { z: derniere });
  $("p-reperes-en").textContent = t2("colonnes A–{z}", { z: derniere });
}

// La langue ne vit pas dans `prefs`, qui se relit apres coup : elle vit dans
// langue.ts, qui doit etre lu AVANT que la page ne se peigne.
for (const b of $("p-langue").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const choisie = (b as HTMLElement).dataset["v"] === "en" ? "en" : "fr";
    if (choisie === langue()) return;
    // ELLE SUIT LE COMPTE, PAS LA MACHINE. Sans cela, se connecter depuis un
    // autre navigateur rendait le site a la langue de celui-la.
    if (moiCompte !== null) {
      void fetch("/api/langue", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ langue: choisie }),
      });
    }
    // Les reperes suivent, SAUF si on les a regles a la main : c'est le meme
    // principe qu'au demarrage, et le reglage reste juste a cote.
    if (!reperesChoisis) {
      prefs.reperes = choisie === "en" ? "en" : "fr";
      garderPreferences();
    }
    choisirLaLangue(choisie);
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
/**
 * Bascule le curseur a quatre directions -- ne se propose plus que d'un seul
 * endroit, le panneau rapide au-dessus de l'anagrammeur (SPEC.md §28) : la
 * saisie est un reglage de jeu, pas un reglage de site, et n'a donc plus sa
 * place dans les parametres generaux.
 */
function basculerQuatre(): void {
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
  peuplerReglagesJeu();
}
for (const b of $("p-reperes").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    prefs.reperes = (b as HTMLElement).dataset["v"] as Reperes;
    // A partir d'ici les reperes ne suivent plus la langue : on les a choisis.
    reperesChoisis = true;
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

// ------------------------------------------------- reglage de jeu rapide

/** Montre ou cache le bouton de melange, selon le reglage (SPEC.md §28). */
function appliquerMelangeVisible(): void {
  $("rb-melange").hidden = !prefs.melange;
  // LE POSITIONNE TOUT DE SUITE : sans cela il apparaissait a l'endroit ou le
  // CSS l'avait laisse la derniere fois -- souvent (0,0) -- en attendant le
  // prochain repaint du chevalet.
  calerLeChevalet();
}

/** Le panneau rapide suit les deux memes reglages que les parametres du site. */
function peuplerReglagesJeu(): void {
  $("rj-quatre").setAttribute("aria-pressed", String(prefs.quatre));
  $("rj-melange").setAttribute("aria-pressed", String(prefs.melange));
}

/** Ouvre ou ferme le panneau rapide, au-dessus de l'anagrammeur. */
function basculerLeReglageDeJeu(): void {
  const ouvert = $("reglages-jeu-panneau").hidden;
  $("reglages-jeu-panneau").hidden = !ouvert;
  $("reglages-jeu-open").setAttribute("aria-pressed", String(ouvert));
  if (ouvert) peuplerReglagesJeu();
}
$("reglages-jeu-open").addEventListener("click", (e) => {
  e.stopPropagation();
  basculerLeReglageDeJeu();
});
// UN CLIC AILLEURS LE REFERME, comme n'importe quel menu deroulant : rien
// dans la page n'appelle a le fermer explicitement, ce serait un bouton de
// plus a chercher pour deux reglages qu'on regle en un coup d'oeil.
document.addEventListener("pointerdown", (e) => {
  if ($("reglages-jeu-panneau").hidden) return;
  if ((e.target as HTMLElement).closest(".reglages-jeu-colonne")) return;
  basculerLeReglageDeJeu();
});
$("rj-quatre").addEventListener("click", basculerQuatre);
$("rj-melange").addEventListener("click", () => {
  prefs.melange = !prefs.melange;
  garderPreferences();
  peuplerReglagesJeu();
  appliquerMelangeVisible();
});

/**
 * Melange le chevalet au hasard (Fisher-Yates), sans rien changer a la
 * partie : comme un deplacement a la main (voir `ordreChevalet`), l'ordre ne
 * porte que sur l'affichage. Rejoue donc `selonLeChevalet` tel quel au
 * prochain repaint, et se defait avec le reste de l'arrangement quand la main
 * est rendue.
 */
function melangerLeChevalet(): void {
  if (rejeu !== null) return;
  if (rack !== ordrePour) { ordrePour = rack; ordreChevalet = [...rack]; }
  for (let i = ordreChevalet.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = ordreChevalet[i]!;
    ordreChevalet[i] = ordreChevalet[j]!;
    ordreChevalet[j] = tmp;
  }
  paintRack();
}
$("rb-melange").addEventListener("click", melangerLeChevalet);

lirePreferences();
setReperes(prefs.reperes);
appliquerLesTailles();
appliquerLeTheme();
appliquerLesHauteurs();
appliquerMelangeVisible();

// ---------------------------------------------------------------- chronos

setInterval(() => {
  const now = Date.now() + clockSkew;
  // Decompte d'avant-coup : 2, puis 1, puis le jeu commence.
  // Le compte a rebours du LANCEMENT se lit au meme endroit, en plus long :
  // dix secondes plutot que deux, et il ouvre la partie au lieu d'un coup.
  // LE DECOMPTE S'EFFACE DES QUE LE TIRAGE EST LA, sans attendre son propre
  // zero : les deux horloges ne tombent pas a la milliseconde, et l'on voyait
  // le tirage paraitre sous un « 1 » qui trainait.
  const reste2 = rack !== "" ? 0 : Math.max(decompteJusqua, lancementA) - now;
  if (reste2 > 0) {
    $("decompte").hidden = false;
    $("decompte").textContent = String(Math.ceil(reste2 / 1000));
  } else {
    $("decompte").hidden = true;
    // Le bouton reparait si le lancement a echoue ; il disparait des qu'il part.
    if (lancementA !== 0) lancementA = 0;
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
  // UNE MANCHE EN PAUSE montre ce que son coup avait dure, et le fige la.
  const enCours = enPause && demarree && !finie ? ecoulePause
    : solving || finie || !demarree || endormi || decompteJusqua > now
    ? 0 : Math.max(0, now - servedAt);
  // LE TEMPS ET LE NEGATIF SONT CEUX DE LA MONTANTE ENTIERE, pas de l'etape en
  // cours (SPEC.md §23). C'est le total qui s'affiche, et c'est le total qui
  // fait le record. Le serveur additionne les etapes closes -- abandons compris
  // -- et l'on y ajoute ici le coup en cours, comme pour une partie seule.
  $("age").textContent = montante !== null ? fmtSecondes(montante.temps + enCours)
    : demarree ? fmtSecondes(tempsJoue + enCours) : "—";
  if (finie) { $("elapsed").textContent = "—"; return; }
  if (dureeMax !== null && debutDeLaPartie !== 0 && demarree) {
    const reste = Math.max(0, debutDeLaPartie + dureeMax * 1000 - now);
    const mn = Math.floor(reste / 60000), sc = Math.floor((reste % 60000) / 1000);
    $("rb-reste").textContent = `${mn}:${String(sc).padStart(2, "0")}`;
  }
  if (!demarree) { $("elapsed").textContent = "—"; return; }
  if (enPause) {
    $("elapsed").textContent = chrono === null ? fmtSecondes(ecoulePause)
      : `${Math.ceil(Math.max(0, chrono * 1000 - ecoulePause) / 1000)} s`;
    $("elapsed").style.color = "var(--ink-faint)";
    return;
  }
  if (endormi) { $("elapsed").textContent = "en pause"; return; }
  if (solving) { $("elapsed").textContent = "…"; return; }
  if (chrono === null) { $("elapsed").style.color = ""; $("elapsed").textContent = fmtSecondes(enCours); return; }
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
  lancementA?: number;
  gerant?: string | null; proprietaire?: string | null; prive?: boolean;
  tempsJoue?: number; rejeuOuvert?: boolean; permanent?: boolean;
  demarree?: boolean; coupsMax?: number | null;
  dureeMax?: number | null; debutDeLaPartie?: number;
  points?: Record<string, number>; negatif?: Record<string, number>; negatifCollectif?: number;
  tops?: Record<string, number>;
  meilleureCollective?:
    { joueur: string; word: string; score: number; dir: Dir; x: number; y: number } | null;
  montante?: MontanteVue | null;
  spectateurs?: string[];
  epreuve?: EpreuveVue | null; enPause?: boolean; ecoulePause?: number;
  rencontre?: RencontreDuSalonVue | null;
  createdAt: number; now: number; servedAt: number; demarreA?: number;
}) {
  epreuve = s.epreuve ?? null;
  rencontreSalon = s.rencontre ?? null;
  enPause = s.enPause === true;
  ecoulePause = s.ecoulePause ?? 0;
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
  // UN COUP QUI TOMBE REND INUTILE LE MOT QU'ON ATTENDAIT : ou il vient d'etre
  // pose, ou il ne le sera plus. Garde-fou en plus de `placed` et de `result`,
  // pour le cas ou l'etat arriverait seul.
  if (s.moveNumber !== moveNumber) oublierLAttente();
  const sac = s.sac ?? "";
  $("rb-dico").textContent = dictionnaire(cfg.dictionnaire).nom;
  peindreLeTypeDePartie();
  $("sac").hidden = cfg.pioche === "probabilites";
  $("sac").textContent = sac;
  chrono = s.chrono ?? null;
  endormi = s.actif === false;
  duplicate = s.mode === "duplicate";
  nonTrouves = s.nonTrouves ?? 0;
  // LA MONTANTE VIENT ENTIERE DU SERVEUR, cumuls compris. Absente de l'etat,
  // c'est qu'il n'y en a pas : ce salon joue des parties seules.
  montante = s.montante ?? null;
  // Les manettes changent de mains sans qu'on se reconnecte : le bouton des
  // reglages suit l'etat, pas le seul message d'accueil.
  gerant = s.gerant ?? null;
  // SALON PRIVE (SPEC.md §26) : reglage du salon, pas de la partie -- il peut
  // changer sans que rien d'autre ne bouge. La case suit, si les reglages sont
  // ouverts en ce moment meme.
  salonPrive = s.prive === true;
  if (!$("reglages").hidden) ($("r-prive") as HTMLInputElement).checked = salonPrive;
  if (s.proprietaire !== undefined) salonPermanent = s.proprietaire === null;
  permanent = s.permanent === true;
  // UNE GRILLE PERMANENTE NE SE REREGLE PAS. Relancer, c'est archiver la partie
  // en cours et en ouvrir une neuve : sur une grille d'etude qui porte onze
  // mille coups, c'est le geste qu'on ne veut surtout pas faire par megarde. Le
  // serveur le refuse aussi -- un bouton cache est un garde-fou, pas une regle.
  // Les reglages d'une partie d'epreuve sont ceux de sa partie figee.
  $("reglages-open").hidden = gerant !== me || permanent || epreuve !== null
    || rencontreSalon !== null;
  // ABANDONNER UN COUP / LA PARTIE (SPEC.md §24-25). L'administration voit
  // toujours les deux boutons ; pour tout le monde, ils exigent le topping sur
  // une grille finie -- le duplicate et la grille sans fin n'ont pas la meme
  // notion de "coup" a abandonner. `s.finie`, et non `finie` : ce dernier n'est
  // reassigne que plus bas, et porterait encore la valeur d'avant ce message.
  {
    // JAMAIS SUR UN SALON PERMANENT (la grille mondiale, §16) : c'est LA
    // partie du site, et l'administration s'y promene aussi -- lui laisser un
    // bouton qui l'abandonnerait serait absurde. Ce veto passe avant tout le
    // reste, administration comprise.
    const admin = !permanent && moiCompte?.admin === true;
    const seProposeIci = !permanent && !duplicate && cfg.bornes !== null;
    const seul = (s.online ?? []).length <= 1;
    // UN COUP EN COURS, ET NON UNE PARTIE QUI ATTEND SON DECOMPTE OU SON
    // LANCEMENT : le tirage n'existe pas encore, `abandonnerLeCoup` n'aurait
    // rien a clore.
    const coupEnCours = s.demarree !== false && (s.rack ?? "") !== "";
    $("abandon-coup").hidden =
      s.finie === true || !coupEnCours || !(admin || (seProposeIci && seul));
    // Reserve a l'hote (ou l'administration), et seulement une fois un coup
    // manque -- l'historique le sait des qu'un joueur y a laisse un `player` nul.
    const coupManque = history.some((m) => m.player === null) || s.last?.player === null;
    // UNE MANCHE NE S'ABANDONNE PAS, meme par l'administration (SPEC.md §29).
    $("abandon-partie").hidden = epreuve !== null
      || s.finie === true || !(admin || (seProposeIci && gerant === me && coupManque));
  }
  // LE DEPART D'UNE PARTIE FERME LE MINI ANAGRAMMEUR, MEME EN SOLO : passe le
  // moment de s'en servir sans arriere-pensee, une fois que ca part pour de
  // bon (ou que le decompte l'annonce) on range l'outil, comme un reflexe
  // avant de jouer. Capture AVANT reaffectation, pour comparer un vrai avant/
  // apres plutot que la valeur qu'on est en train de poser.
  const lancementAvant = lancementA;
  const demarreeAvant = demarree;
  decompteJusqua = s.decompteJusqua ?? 0;
  lancementA = s.lancementA ?? 0;
  // LANCER, C'EST LE GESTE DU JOUR DU LANCEMENT. Une grille permanente
  // n'appartient a personne, donc personne ne la regle : sans ce bouton, une
  // grille neuve resterait a son coup zero pour toujours.
  $("lancer-wrap").hidden = !(permanent && s.demarree === false
    && moiCompte?.admin === true && lancementA === 0);
  demarree = s.demarree !== false;
  // SOIT LE DECOMPTE COMMENCE (`lancementA` part de zero), SOIT LA PARTIE
  // DEMARRE D'UN COUP SANS DECOMPTE (`demarree` passe a vrai directement) --
  // le plus precoce des deux ferme la fenetre.
  if ((lancementA !== 0 && lancementAvant === 0) || (demarree && !demarreeAvant)) {
    fermerLeSolveurMini();
  }
  coupsMax = s.coupsMax ?? null;
  dureeMax = s.dureeMax ?? null;
  debutDeLaPartie = s.debutDeLaPartie ?? 0;
  tempsJoue = s.tempsJoue ?? 0;
  rejeuOuvert = s.rejeuOuvert === true;
  points = s.points ?? {};
  negatif = s.negatif ?? {};
  negatifCollectif = s.negatifCollectif ?? 0;
  tops = s.tops ?? {};
  meilleureCollective = s.meilleureCollective ?? null;
  // Le serveur a-t-il ete relance depuis la derniere compilation du client ?
  // Sinon les reglages partent dans le vide et on croit a un bug du jeu.
  // Un serveur qui ne dit rien est forcement anterieur a ce controle : c'est
  // justement le cas qu'il faut attraper.
  if (s.demarreA === undefined || s.demarreA < __COMPILE_A__) {
    $("perime").hidden = false;
  }
  // LA PARTIE VIENT DE SE TERMINER PAR UN ABANDON QU'ON A SOI-MEME DEMANDE :
  // le rejeu s'ouvre directement sur le coup manque, sans qu'il faille le
  // rechercher dans une partie qu'on vient de refermer pour lui (SPEC.md §25).
  if (!finie && s.finie === true && cibleDuRejeuApresAbandon !== null) {
    voirLeCoup(cibleDuRejeuApresAbandon);
    cibleDuRejeuApresAbandon = null;
  }
  finie = s.finie === true;
  online = s.online ?? [];
  ceuxQuiRegardent = s.spectateurs ?? [];
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
    $("conn").textContent = t("déconnecté — reconnexion…");
    setTimeout(connect, 1500);
  });
  moi.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data as string);

    if (m.t === "hello") {
      jeRegarde = m.spectateur === true;
      chuchote = false;
      setLayout(m.layout as LayoutName);
      canReveal = m.reveal === true;
      tiles = m.tiles;
      history = m.moves;
      reconstituerLesJetons();
      chat = m.chat ?? [];
      // La variante vient du serveur : c'est elle qui dit combien de caramels se
      // posent, ce que vaut chaque lettre et quelle prime recompense quoi.
      cfg = m.config ? deserialiser(m.config) : configParDefaut();
      // Ce qu'on avait trouve de mieux sur ce coup-la, avant de fermer la page.
      best = m.maSolution ?? null;
      board = new Board(dict, cfg);
      // Seul le gerant regle son salon. La grille permanente n'en a pas.
      gerant = m.gerant ?? null;
      salonPermanent = m.proprietaire === null;
      permanent = m.permanent === true;
      epreuve = m.epreuve ?? null;
      // LA RENCONTRE AVANT LES REGLAGES : c'est elle qui decide si ce salon se
      // regle, et `applyState` ne passera qu'apres.
      rencontreSalon = m.state?.rencontre ?? null;
      $("reglages-open").hidden = gerant !== me || permanent || epreuve !== null
    || rencontreSalon !== null;
      $("conn").textContent = `${me} · ${m.nomSalon}`;
      // Une partie qui n'a pas commence s'ouvre sur ses reglages : c'est la
      // qu'on choisit la variante avant de lancer quoi que ce soit.
      // Une grille permanente ne s'ouvre pas non plus sur ses reglages : elle
      // n'est pas la pour etre reglee, meme le jour ou on la cree.
      // UNE MANCHE DE TOURNOI NE SE REGLE PAS : ses reglages sont ceux du
      // tournoi, et son panneau s'ouvrait par-dessus le bouton « Je suis pret ».
      if (m.state?.demarree === false && m.gerant === me && !permanent && epreuve === null
        && rencontreSalon === null) {
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
      // CES DEUX CACHES SONT INDEXES PAR NUMERO DE COUP, PAS PAR PARTIE. Sans
      // ce menage, rouvrir le rejeu sur le coup 7 de la partie neuve renvoyait
      // le plateau et les solutions du coup 7 de la partie qu'on vient de
      // quitter -- memes numeros, partie differente.
      paliersRecus.clear();
      plateauRejeu = null;
      cfg = m.config ? deserialiser(m.config) : cfg;
      tiles = m.tiles ?? [];
      history = [];
      reconstituerLesJetons();
      chat = m.chat ?? [];
      board = new Board(dict, cfg);
      board.place(tiles.map((t: Tile): Placement => ({ x: t.x, y: t.y, letter: t.l, blank: t.b === 1 })));
      accorderLeDictionnaire();
      typed = ""; ghost = null; best = null; motsRefuses = []; finie = false;
      cursor = null; marks = [];
      // Les listes deroulees parlaient de la partie d'avant : leurs coups
      // n'existent plus, et la ligne restait ouverte sur du vide.
      openPlayer = null;
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
    if (m.t === "said") {
      // UN CHUCHOTEMENT NE S'ARCHIVE PAS : il ne va qu'aux spectateurs presents,
      // et ne figure pas au chat du salon.
      if (m.chuchote === true) { ajouterAuChat(m.msg as Chat, true); return; }
      chat.push(m.msg);
      ajouterAuChat(m.msg);
      return;
    }

    // Le serveur a mis mon message de cote : il partira a la fin de la partie.
    if (m.t === "retenu") {
      ajouterAuChat({ at: Number(m.at), who: "", text: t("Votre message partira à la fin de la partie.") });
      return;
    }

    if (m.t === "placed") {
      const mv = m.move as MoveInfo;
      board.place(m.placements as Placement[]);
      for (const p of m.placements as Placement[]) {
        tiles.push({ x: p.x, y: p.y, l: p.letter, b: p.blank ? 1 : 0, n: mv.n });
      }
      history.push(mv);
      enregistrerLeJetonDuCoup(mv);
      best = null;
      // Les mots refuses parlaient de la position d'avant : elle vient de
      // changer, et certains sont peut-etre jouables maintenant.
      motsRefuses = [];
      typed = "";
      // Les caramels en attente viennent d'etre poses pour de vrai, ou ne le
      // seront jamais : dans les deux cas l'etat les remplace.
      oublierLAttente();
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

    // LA REPONSE A NOTRE ESSAI. Elle arrive APRES le coup, quand c'etait le top
    // -- le serveur diffuse la pose avant de repondre, et l'ordre des messages
    // est garanti : les caramels en attente sont deja devenus de vrais caramels
    // quand on cesse de les dessiner. C'est ce qui fait qu'on ne voit rien.
    //
    // Le serveur parle francais : ses messages passent par la table comme les
    // autres. Un message inconnu d'elle s'affiche tel quel.
    if (m.t === "result") {
      const restait = attente.length > 0;
      oublierLAttente();
      if (!m.ok) flash(t(m.message), "bad");
      if (restait) draw();
      return;
    }
    // La reponse a "connectes" (SPEC.md §26) : la fenetre d'invitation est
    // deja ouverte, avec son "Chargement…" a remplacer.
    if (m.t === "connectes") { peuplerInviter(m.noms ?? []); return; }
    // ON VIENT DE M'INVITER DANS UN SALON PRIVE, ou que je sois sur le site en
    // ce moment. Un simple message suffit : je vais l'y rejoindre quand je le
    // veux, rien ne m'y pousse.
    if (m.t === "invite") {
      flash(t2("Invité(e) dans « {nom} »", { nom: m.nomSalon }), "ok");
      void chargerLesNotifications();
      return;
    }
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
    /** Absent des serveurs d'avant le double joker : c'en etait un par coup. */
    jokersParCoup?: number;
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
/**
 * L'accroche d'un salon star, DANS LA LANGUE DU SALON.
 *
 * Pas dans celle de la page : « The Infinite Grid » se joue en anglais, et son
 * accroche le dit meme lue depuis la version francaise. C'est la promesse de
 * cette grille-la, pas un element de l'interface.
 */
function accrocheStar(l: Langue): string[] {
  return [
    tDans(l, "Grille infinie, sans limite de temps, sans fin."),
    tDans(l, "Jusqu'où pourrons-nous aller ?"),
    tDans(l, "Rejoignez la plus grande partie de topping jamais créée."),
  ];
}

/** Le filtre en cours. Il ne trie que la liste deja recue : aucun aller-retour. */
let filtre: "tous" | "bornee" | "super" | "infinie" | "attente" = "tous";

/**
 * QUELLE LANGUE DE SALON ON REGARDE : la sienne, l'autre, ou toutes.
 *
 * Un salon se joue dans un lexique, et un lexique est une langue : entrer dans
 * une partie francaise avec le site en anglais, c'est arriver devant un
 * chevalet dont aucun mot ne se forme. L'accueil s'ouvre donc sur la langue du
 * site.
 *
 * LES TROIS CHOIX SE MONTRENT, plutot qu'un interrupteur « toutes les langues ».
 * Celui-ci n'offrait que la langue du site et le tout : un anglophone n'avait
 * aucun moyen de regarder les salons francais seuls, et un francophone aucun
 * moyen de ne voir que les anglais.
 */
let langueMontree: Langue | "toutes" = langue();
/**
 * L'a-t-on choisie soi-meme ?
 *
 * Sans ce drapeau, changer la langue du site laissait le filtre sur l'ancienne
 * -- des salons francais sur un site passe en anglais. Tant que personne n'a
 * touche aux puces, le filtre suit la langue du site ; des qu'on en a choisi
 * une, c'est elle qui commande.
 */
let langueChoisie = false;

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
  /** La langue choisie par ce compte. Vide = jamais choisie. */
  langue?: string;
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
    // LA LANGUE DU COMPTE L'EMPORTE. Se connecter depuis un autre navigateur,
    // c'est retrouver le site comme on l'a laisse -- pas dans la langue de la
    // machine ou l'on se trouve. Tant que le compte n'en a jamais choisi, on
    // garde celle du navigateur : il n'y a rien a restaurer.
    const sienne = moiCompte.langue;
    if ((sienne === "fr" || sienne === "en") && sienne !== langue()) {
      choisirLaLangue(sienne);
    }
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
  $("c-valider").textContent = inscrit ? t("Créer un compte") : t("Se connecter");
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
  $("corps-partie").hidden = true;
  $("corps-records").hidden = true;
  $("corps-competitif").hidden = true;
  $("corps-admin").hidden = true;
  $("corps-tournoi").hidden = true;
  $("corps-palmares").hidden = true;
  $("corps-perso").hidden = true;
  $("corps-defi").hidden = true;
  $("corps-resultats").hidden = true;
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

/**
 * Le solveur : une page hors partie, comme le profil, mais sans compte a
 * demander -- c'est un outil de recherche, pas un reglage personnel.
 *
 * N'est pour l'instant joignable que depuis le pied du mur de salons, donc
 * jamais pendant une partie : l'acces depuis la partie elle-meme (solo
 * seulement, jamais a plusieurs) reste a construire.
 */
function ouvrirLeSolveur(pousser = true): void {
  $("corps-partie").hidden = true;
  $("corps-records").hidden = true;
  $("corps-competitif").hidden = true;
  $("corps-admin").hidden = true;
  $("corps-tournoi").hidden = true;
  $("corps-palmares").hidden = true;
  $("corps-perso").hidden = true;
  $("corps-defi").hidden = true;
  $("corps-resultats").hidden = true;
  $("corps-salons").hidden = true;
  $("corps-solveur").hidden = false;
  $("join").hidden = false;
  fermerLeSolveurMini();
  if (pousser) window.history.pushState({ page: "solveur" }, "", "?page=solveur");
  void solveurPage.peuplerDico();
  solveurPage.focaliser();
}

/** Referme le solveur et rend la place au mur de salons. */
function fermerLeSolveur(pousser = true): void {
  $("corps-solveur").hidden = true;
  $("corps-salons").hidden = false;
  // ON NE GARDE PAS UNE LISTE DE CENT MILLE LIGNES DERRIERE UNE PAGE FERMEE :
  // masquee, elle continue de peser sur le document et le reste de l'interface
  // trainait. La page se rouvre vide, comme la fenetre flottante.
  solveurPage.vider();
  if (pousser) window.history.pushState({ page: "salons" }, "", location.pathname);
}

// Le bouton « precedent » du navigateur suit la page, comme partout ailleurs.
addEventListener("popstate", () => {
  const page = new URLSearchParams(location.search).get("page");
  if (page === "compte" && moiCompte !== null) { ouvrirLeProfil(false); return; }
  if (page === "solveur") { ouvrirLeSolveur(false); return; }
  if (page === "records") { fermerLaPartie(false); ouvrirLesRecords(false); return; }
  if (page === "competitif") { ouvrirLeCompetitif(false); return; }
  if (page === "palmares") { ouvrirLePalmares(false); return; }
  if (page === "admin-competitif") { ouvrirLAdministrationDuCompetitif(false); return; }
  if (page === "tournoi") { ouvrirLeTournoi(new URLSearchParams(location.search).get("id") ?? "", false); return; }
  if (page === "defi") { ouvrirLeDefi(new URLSearchParams(location.search).get("id") ?? "", false); return; }
  if (page === "perso") {
    ouvrirLaPagePerso(new URLSearchParams(location.search).get("joueur") ?? "", false);
    return;
  }
  if (page === "resultats") { ouvrirLesResultatsDeLAdresse(); return; }
  if (page === "partie") {
    const p = new URLSearchParams(location.search);
    const id = p.get("partie");
    if (id !== null) {
      void ouvrirLaPartie(id, Math.max(1, Number(p.get("coup")) || 1), (p.get("source") === "competitif" ? "competitif"
        : p.get("source") === "historique" ? "historique" : "records"));
      return;
    }
  }
  fermerLeProfil(false);
  fermerLeSolveur(false);
  fermerLaPartie(false);
  fermerLesRecords(false);
  fermerLeCompetitif(false);
});

// --- Le solveur : anagrammes, mots formables, extensions, squelettes. ---
//
// DEUX INSTANCES, LE MEME MOTEUR : la page (toute la liste, jamais tronquee)
// et le mini solveur flottant du mur de salons (une liste courte, un outil
// rapide). `creerSolveur` porte tout le cablage une seule fois ; seuls les
// identifiants d'elements et la troncature different d'une instance a l'autre.

type SvCle = "solutions" | "formables" | "jokers" | "benjamins" | "rallongesAvant"
  | "rallongesArriere" | "superbenjamins";

interface SvConfig {
  mot: string; aide: string; resultats: string;
  /**
   * Les boutons de CETTE instance, dans l'ordre de `SV_CLES`. La page les a
   * tous ; la fenetre flottante en montre moins, et se numerote alors sur les
   * siens -- ses six boutons portent 1 a 6, sans trou la ou la page en a un
   * de plus.
   */
  boutons: Partial<Record<SvCle, string>>;
  /** `null` : la liste entiere, sans troncature -- c'est la page. */
  troncature: number | null;
  /**
   * L'id d'un `<select>` de lexique, ou `null` pour suivre celui DE LA
   * PARTIE (la variable globale `dict`) -- le mini solveur, ouvert dans un
   * salon qui a deja le sien, n'a rien a proposer.
   */
  dico: string | null;
}

const SV_CLES: SvCle[] = [
  "solutions", "formables", "jokers", "benjamins", "rallongesAvant", "rallongesArriere",
  "superbenjamins",
];

/** Au-dela, poser la liste entiere d'un coup se sent -- voir peindreResultats. */
const SV_SEUIL_CONFIRMATION = 20_000;

/**
 * Combien de longueurs sous le plus long mot la page garde, sur un tirage a
 * jokers (voir `resserrerLesFormables`). Cinq : de quoi voir le sept-lettres,
 * le six et leurs voisins immediats sans derouler tout le dictionnaire.
 */
const SV_FENETRE_LONGUEUR = 5;

/**
 * 1 a 7, rangee du haut ou pave numerique, pour lancer la recherche du meme
 * numero sans lacher le clavier. `e.code` et non `e.key` : la touche au-dessus
 * du A vaut "Digit1" quel que soit ce qu'elle tape -- "1" en QWERTY, "&" en
 * AZERTY. Aucun chiffre ne s'ecrit dans cette barre, la touche est donc libre.
 *
 * Le rang compte pour L'INSTANCE : la fenetre flottante n'a pas le bouton des
 * jokers, ses six boutons se numerotent donc 1 a 6 sans sauter le 3.
 */
const SV_RACCOURCIS: Readonly<Record<string, number>> = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5, Digit7: 6,
  Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4, Numpad6: 5, Numpad7: 6,
};

function creerSolveur(cfg: SvConfig): { peuplerDico: () => Promise<void>; focaliser: () => void; vider: () => void } {
  /** Son propre lexique choisi (page), inutilise quand cfg.dico est `null`. */
  let dictPropre: Dict | undefined;
  let dictPropreId = "";
  /** Le dernier bouton clique : reste enfonce, et se relance tant qu'on retape. */
  let modeActif: SvCle | null = null;

  /** Les recherches que CETTE instance propose, dans l'ordre de ses boutons. */
  const mesCles = SV_CLES.filter((cle) => cfg.boutons[cle] !== undefined);

  const champ = () => $(cfg.mot) as HTMLInputElement;
  const bouton = (cle: SvCle) => $(cfg.boutons[cle]!) as HTMLButtonElement;
  // Suit `dict`, la variable globale du client (le lexique de la partie en
  // cours), quand cfg.dico est `null` -- sinon son propre choix.
  const dictActif = (): Dict | undefined => (cfg.dico === null ? dict : dictPropre);

  function peindreLesBoutonsActifs(): void {
    for (const cle of mesCles) bouton(cle).setAttribute("aria-pressed", String(cle === modeActif));
  }

  function messageInvalide(saisie: string): string {
    if (saisie.length > LONGUEUR_MAX_SAISIE) return t2("{n} caractères au maximum.", { n: LONGUEUR_MAX_SAISIE });
    if (/[*.]/.test(saisie) && saisie.includes(BLANK)) {
      return t("Un joker (?) et un squelette (* ou .) ne se mélangent pas.");
    }
    if (saisie.includes(BLANK) && [...saisie].filter((c) => c === BLANK).length > JOKERS_MAX) {
      return t2("{n} jokers au maximum.", { n: JOKERS_MAX });
    }
    return t("Lettres, jokers (?) ou squelette (* et .) uniquement.");
  }

  /** Rouge/vert en direct, et quels boutons ont un sens pour ce qui est tape. */
  function peindreEtat(): void {
    const input = champ();
    const saisie = input.value;
    const mode = analyserSaisie(saisie);
    input.classList.remove("sv-valide", "sv-invalide");
    const aide = $(cfg.aide);
    aide.classList.remove("avert");
    aide.textContent = "";

    for (const cle of mesCles) {
      bouton(cle).disabled = cle === "solutions" ? (mode !== "tirage" && mode !== "squelette") : mode !== "tirage";
    }

    if (mode === "invalide") {
      aide.classList.add("avert");
      aide.textContent = messageInvalide(saisie);
      // `tirage` SEULEMENT, PAS « tout sauf vide » : un squelette n'est pas un
      // mot, le chercher au dictionnaire tel quel le peindrait en rouge alors
      // qu'il n'a rien d'incorrect. Il ne se colore donc ni d'un cote ni de
      // l'autre, et ne dit plus rien non plus : la ligne d'aide reste vide.
    } else if (mode === "tirage" && !saisie.includes(BLANK) && dictActif() !== undefined) {
      // UN JOKER DIT QU'ON NE TAPE PLUS UN MOT, MAIS UNE RECHERCHE : le
      // rouge/vert ne repond qu'a « ce mot precis existe-t-il ? », question
      // qui n'a plus de sens des qu'une lettre reste a deviner.
      input.classList.add(estUnMotAvecJokers(dictActif()!, saisie) ? "sv-valide" : "sv-invalide");
    }
  }

  function executer(cle: SvCle, refocus: boolean): void {
    const d = dictActif();
    if (d === undefined) return;
    const mot = champ().value;
    const mode = analyserSaisie(mot);
    let r: ResultatRecherche | null = null;
    let avecCode = false;
    let masques = 0;
    if (cle === "solutions") {
      if (mode === "tirage") {
        r = motsSolutions(d, mot);
        // Un tirage rend tout le monde a la meme longueur : le tri par code de
        // joker y range les anagrammes ensemble, comme aux mots formables. Le
        // code s'AFFICHE alors, sinon l'ordre paraitrait tire au sort ; sans
        // joker il n'y a rien a montrer et la colonne disparait.
        r.resultats.sort((a, b) => a.mot.length - b.mot.length
          || codeJoker(a).localeCompare(codeJoker(b))
          || a.mot.localeCompare(b.mot));
        avecCode = mot.includes(BLANK);
      } else if (mode === "squelette") {
        r = squelette(d, mot);
        // LONGUEUR CROISSANTE PUIS ALPHABETIQUE, comme les rallonges. Le tri
        // purement alphabetique melangeait les longueurs (ALUMINERAIENT entre
        // ALUMINERAI et ALUMINERAIS), et les en-tetes « N LETTRES » revenaient
        // trois fois dans la meme liste. Les lettres libres d'un squelette ne
        // sont PAS des jokers : elles ne rangent rien.
        r.resultats.sort((a, b) => a.mot.length - b.mot.length
          || a.mot.localeCompare(b.mot));
      }
    } else if (mode === "tirage") {
      if (cle === "formables") {
        r = motsFormables(d, mot);
        // TRIE PAR CODE DE JOKER, PAS PAR MOT : a longueur egale, deux
        // anagrammes (memes lettres, dont les memes jokers) partagent le
        // meme code -- les regrouper les fait apparaitre cote a cote,
        // plutot que dispersees par ordre alphabetique du mot lui-meme.
        r.resultats.sort((a, b) => b.mot.length - a.mot.length
          || codeJoker(a).localeCompare(codeJoker(b))
          || a.mot.localeCompare(b.mot));
        avecCode = true;
        // La page montre TOUT, et sur un tirage a jokers ce tout se compte en
        // dizaines de milliers de mots dont les plus courts n'apprennent rien.
        // La fenetre flottante, elle, s'arrete deja a cent lignes.
        if (cfg.troncature === null) {
          const serre = resserrerLesFormables(r, mot);
          r = serre.r;
          masques = serre.masques;
        }
      } else if (cle === "jokers") {
        // « Solutions » sur MOT?, MOT??, MOT???... : le moteur rend deja les
        // longueurs croissantes et l'alphabetique a l'interieur de chacune, il
        // n'y a rien a retrier. Les lettres ajoutees se colorent (elles sont
        // marquees comme jokers) ; pas de colonne de code, elles se lisent
        // dans le mot.
        r = plusDeJokers(d, mot);
      } else {
        const fn = cle === "benjamins" ? benjamins
          : cle === "rallongesAvant" ? rallongesAvant
          : cle === "rallongesArriere" ? rallongesArriere : superBenjamins;
        r = fn(d, mot);
      }
    }
    if (r === null) return;
    modeActif = cle;
    peindreLesBoutonsActifs();
    peindreResultats(r, avecCode, false, masques);
    if (refocus) { champ().focus(); champ().select(); }
  }

  /**
   * Les mots formables d'un tirage A JOKERS, resserres pour la page.
   *
   * Deux coupes, toutes deux sans regret :
   * - **les mots trop courts** : plus de SV_FENETRE_LONGUEUR lettres sous le
   *   plus long trouve, on ne lit plus une reponse au tirage mais une tranche
   *   du dictionnaire ;
   * - **les mots qui ne doivent RIEN au tirage** : toutes leurs lettres venant
   *   des jokers, la liste y rend exactement tous les mots de cette longueur.
   *   Zulu l'avait dit « les mots de N lettres quand il y a N jokers » : c'est
   *   le meme cas, mais coupe sur la bonne mesure. Coupe par LONGUEUR, un mot
   *   de six lettres qui emploie vraiment le A et le B d'un « AB?????? » s'en
   *   allait avec les autres, et il manquait une longueur entiere au milieu de
   *   la liste. La regle s'efface sur un tirage SANS aucune vraie lettre : tout
   *   y vient des jokers, il ne resterait rien du tout.
   */
  function resserrerLesFormables(r: ResultatRecherche, tirage: string): {
    r: ResultatRecherche; masques: number;
  } {
    const jokers = [...tirage].filter((c) => c === BLANK).length;
    if (jokers === 0) return { r, masques: 0 };
    const aDesLettres = jokers < tirage.length;
    let plusLong = 0;
    for (const c of r.resultats) if (c.mot.length > plusLong) plusLong = c.mot.length;
    const gardes = r.resultats.filter((c) => c.mot.length >= plusLong - SV_FENETRE_LONGUEUR
      && !(aDesLettres && c.jokers.length === c.mot.length));
    return { r: { resultats: gardes, stats: r.stats }, masques: r.resultats.length - gardes.length };
  }

  /** Les lettres jouees par les jokers, dans l'ordre alphabetique. */
  function codeJoker(c: Correspondance): string {
    return c.jokers.map((k) => c.mot[k]).sort().join("");
  }

  /** Une ligne de resultat : le code des jokers (facultatif), le mot colore. */
  function svLigneHTML(c: Correspondance, avecCode: boolean): string {
    const joker = new Set(c.jokers);
    let motHTML = "";
    let i = 0;
    while (i < c.mot.length) {
      const dansJoker = joker.has(i);
      let j = i;
      while (j < c.mot.length && joker.has(j) === dansJoker) j++;
      const segment = c.mot.slice(i, j);
      motHTML += dansJoker ? `<span class="sv-joker">${segment}</span>` : segment;
      i = j;
    }
    const code = avecCode ? `<span class="sv-code">${codeJoker(c)}</span>` : "";
    return `<div class="sv-ligne">${code}<span class="sv-mot-txt">${motHTML}</span></div>`;
  }

  /**
   * Construit toute la liste en une seule chaine plutot que par appendChild
   * repetes : sur des dizaines de milliers de lignes (peu de jokers, motif
   * tres permissif) c'est la difference entre un instant et un geste qui bloque
   * l'onglet. `c.mot` ne contient jamais que des lettres A-Z venues du
   * dictionnaire -- rien a echapper.
   */
  function peindreResultats(r: ResultatRecherche, avecCode: boolean, forcer = false,
    masques = 0): void {
    const boite = $(cfg.resultats);
    const compte = r.resultats.length;
    let ligneStats = t2("{n} résultat{s}", { n: compte, s: compte > 1 ? "s" : "" });
    if (r.stats.limiteAtteinte) ligneStats += ` - ${t("calcul interrompu, affinez la recherche")}`;
    // CE QUI A ETE COUPE SE DIT. Une liste qui rétrécit sans un mot d'explication
    // se lit comme un solveur qui oublie des mots -- et c'est la premiere chose
    // qu'on vient nous signaler.
    const coupes = masques > 0
      ? `<p class="sv-plus">${t2("{n} mot{s} masqué{s} : trop courts, ou sans une seule lettre du tirage.",
        { n: masques, s: masques > 1 ? "s" : "" })}</p>`
      : "";

    if (compte === 0) {
      boite.innerHTML = `<p class="none">${t("Aucun résultat.")}</p>${coupes}`;
      return;
    }

    // SANS TRONCATURE (la page), une liste de plusieurs centaines de milliers
    // de mots (beaucoup de jokers, rien qui les contraint) bloquerait l'onglet
    // une poignee de secondes en la posant d'un coup -- mesure : 340 000
    // lignes, environ 4 s. Au-dela du seuil, on demande avant de le faire.
    if (cfg.troncature === null && compte > SV_SEUIL_CONFIRMATION && !forcer) {
      boite.innerHTML = `<p class="sv-stats">${ligneStats}</p>`
        + `<p class="sv-plus">${t("Liste très longue : l'afficher en entier peut bloquer la page un instant.")}</p>`;
      const bouton = document.createElement("button");
      bouton.type = "button";
      bouton.textContent = t("Afficher quand même");
      bouton.addEventListener("click", () => peindreResultats(r, avecCode, true, masques));
      boite.appendChild(bouton);
      return;
    }

    const limite = cfg.troncature ?? compte;
    const visibles = r.resultats.slice(0, limite);
    // UN EN-TETE A CHAQUE CHANGEMENT DE LONGUEUR, AVEC SON PROPRE COMPTE : sur
    // les mots formables (et les rallonges), une liste triee par longueur mais
    // sans repere reste un mur de mots ou l'on perd sa place en descendant.
    // Le compte GLOBAL a disparu d'au-dessus de la liste (Zulu le trouvait de
    // trop) au profit d'un compte PAR GROUPE, colle au "N LETTRES" qu'il
    // qualifie : `8 LETTRES - 17 résultats`.
    //
    // LA LARGEUR DE COLONNE (mini solveur) SE MESURE EN CARACTERES, PAS EN
    // PIXELS : avec beaucoup de jokers, le code (une lettre par joker) peut
    // depasser la largeur fixe qu'on posait avant, et deborder par-dessus le
    // mot voisin -- ou forcer une barre de defilement laterale. `ch` colle a
    // la police a chiffres fixes (`--mono`) : sur ce resultat precis, jamais
    // trop court, jamais trop large. Peu de place -> 2 colonnes, ou 1 seule
    // si meme ca ne tient pas -- c'est `auto-fill` qui en decide, pas nous.
    let lignes = "";
    let longueurCourante = -1;
    let bufferGroupe = "";
    let compteGroupe = 0;
    let motMax = 0;
    let codeMax = 0;
    const clore = () => {
      if (compteGroupe === 0) return;
      const entete = t2("{n} résultat{s}", { n: compteGroupe, s: compteGroupe > 1 ? "s" : "" });
      lignes += `<div class="sv-longueur">${t2("{n} lettres", { n: longueurCourante })} - ${entete}</div>${bufferGroupe}`;
    };
    for (const c of visibles) {
      if (c.mot.length !== longueurCourante) {
        clore();
        longueurCourante = c.mot.length;
        bufferGroupe = "";
        compteGroupe = 0;
      }
      bufferGroupe += svLigneHTML(c, avecCode);
      compteGroupe++;
      if (c.mot.length > motMax) motMax = c.mot.length;
      if (avecCode && c.jokers.length > codeMax) codeMax = c.jokers.length;
    }
    clore();
    const reste = compte - visibles.length;
    const plus = reste > 0 ? `<p class="sv-plus">${t2("et {n} de plus.", { n: reste })}</p>` : "";
    const avert = r.stats.limiteAtteinte
      ? `<p class="sv-stats">${t("calcul interrompu, affinez la recherche")}</p>` : "";
    // LA COLONNE DU CODE A LA MEME LARGEUR POUR TOUTE LA LISTE, celle du code
    // le plus long : sans elle, deux mots de meme longueur mais dont l'un
    // demande un joker de plus commencaient a deux endroits differents, et la
    // colonne des mots ondulait. La largeur des colonnes de la grille suit
    // (code + mot), en `ch` puisque tout y est a chasse fixe.
    const colonne = Math.max(codeMax + motMax + 3, 10);
    boite.innerHTML = avert
      + `<div class="sv-liste" style="--sv-code: ${codeMax}ch; `
      + `grid-template-columns: repeat(auto-fill, minmax(${colonne}ch, 1fr))">${lignes}</div>${plus}${coupes}`;
  }

  /**
   * Majuscules, caracteres valides seulement, et au plus JOKERS_MAX jokers --
   * les jokers en trop sont retires, jamais les lettres autour. La position du
   * curseur suit : on normalise le prefixe d'avant-frappe de la meme facon, ce
   * qui donne exactement ce qu'il devient dans le texte normalise en entier.
   */
  function normaliser(brut: string): string {
    let jokers = 0;
    return brut.toUpperCase().replace(/[^A-Z?*.]/g, "").split("").filter((c) => {
      if (c !== BLANK) return true;
      jokers++;
      return jokers <= JOKERS_MAX;
    }).join("").slice(0, LONGUEUR_MAX_SAISIE);
  }

  function surSaisie(): void {
    peindreEtat();
    if (modeActif === null) return;
    // EN DIRECT, JUSQU'AU CHAMP VIDE : effacer tout le tirage (tout selectionner,
    // Suppr) desactive le bouton actif sans jamais reappeler `executer` -- sans
    // ce vidage, les anciens resultats restaient affiches, perimes.
    if (bouton(modeActif).disabled) {
      modeActif = null;
      peindreLesBoutonsActifs();
      $(cfg.resultats).innerHTML = "";
      return;
    }
    executer(modeActif, false);
  }

  const input = champ();
  input.addEventListener("input", () => {
    const brut = input.value;
    const curseurAvant = input.selectionStart ?? brut.length;
    const net = normaliser(brut);
    if (net !== brut) {
      const prefixeNet = normaliser(brut.slice(0, curseurAvant));
      input.value = net;
      input.setSelectionRange(prefixeNet.length, prefixeNet.length);
    }
    surSaisie();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { bouton("solutions").click(); return; }
    const idx = SV_RACCOURCIS[e.code];
    const cle = idx === undefined ? undefined : mesCles[idx];
    if (cle !== undefined) { e.preventDefault(); bouton(cle).click(); }
  });
  for (const cle of mesCles) bouton(cle).addEventListener("click", () => executer(cle, true));

  async function choisirDico(id: string): Promise<void> {
    dictPropreId = id;
    dictPropre = await lexiquePour(id);
    peindreEtat();
    if (modeActif !== null) executer(modeActif, false);
  }

  /**
   * Remplit le menu une seule fois puis choisit le lexique de la langue du
   * site (cfg.dico non nul), ou suit tout de suite le lexique de la partie
   * (cfg.dico nul, deja charge par le client a ce stade).
   */
  async function peuplerDico(): Promise<void> {
    if (cfg.dico === null) { peindreEtat(); if (modeActif !== null) executer(modeActif, false); return; }
    const menu = $(cfg.dico) as HTMLSelectElement;
    if (menu.options.length === 0) {
      for (const d of tousLesDictionnaires()) {
        const o = document.createElement("option");
        o.value = d.id;
        o.textContent = `${d.nom} - ${d.langue === "en" ? "English" : "Français"}`;
        o.title = t(d.detail);
        menu.appendChild(o);
      }
      menu.addEventListener("change", () => void choisirDico(menu.value));
    }
    if (dictPropreId === "") dictPropreId = DICO_PAR_LANGUE[langue()];
    menu.value = dictPropreId;
    await choisirDico(dictPropreId);
  }

  /** Remet a zero la saisie, les resultats et le bouton actif -- la fermeture. */
  function vider(): void {
    champ().value = "";
    modeActif = null;
    peindreLesBoutonsActifs();
    $(cfg.resultats).innerHTML = "";
    peindreEtat();
  }

  return { peuplerDico, focaliser: () => { champ().focus(); champ().select(); }, vider };
}

const solveurPage = creerSolveur({
  mot: "sv-mot", dico: "sv-dico", aide: "sv-aide", resultats: "sv-resultats",
  boutons: {
    solutions: "sv-solutions", formables: "sv-formables", jokers: "sv-jokers",
    benjamins: "sv-benjamins",
    rallongesAvant: "sv-rallonges-avant", rallongesArriere: "sv-rallonges-arriere",
    superbenjamins: "sv-superbenjamins",
  },
  troncature: null,
});

const solveurMini = creerSolveur({
  mot: "svm-mot", dico: null, aide: "svm-aide", resultats: "svm-resultats",
  boutons: {
    solutions: "svm-solutions", formables: "svm-formables", benjamins: "svm-benjamins",
    rallongesAvant: "svm-rallonges-avant", rallongesArriere: "svm-rallonges-arriere",
    superbenjamins: "svm-superbenjamins",
  },
  troncature: 100,
});

/**
 * Le mini solveur : une fenetre flottante DANS UN SALON, deplacable a la
 * souris comme au doigt. Position de depart en bas a droite, au-dessus de son
 * icone ; une fois saisie, elle suit le pointeur (`left`/`top`).
 */
let miniOuvert = false;
function ouvrirLeSolveurMini(): void {
  $("solveur-mini").hidden = false;
  miniOuvert = true;
  $("solveur-jeu").setAttribute("aria-pressed", "true");
  void solveurMini.peuplerDico();
  // LE FOCUS ATTEND LA PROCHAINE IMAGE : `.focus()` demande au navigateur
  // d'amener l'element dans le champ de vision, et le demander dans le meme
  // instant que le demasquage le fait travailler sur une mise en page qui n'est
  // pas encore posee. Un tour de boucle coute une image et enleve le doute.
  //
  // Ce n'est PAS ce qui causait le flash a gauche rapporte par Zulu : celui-la
  // venait du glisser-deposer, qui lachait `right` sans avoir pose `left` (voir
  // le `pointerdown` de la poignee, plus bas). Le report avait ete mal
  // attribue ici.
  requestAnimationFrame(() => solveurMini.focaliser());
}
function fermerLeSolveurMini(): void {
  $("solveur-mini").hidden = true;
  miniOuvert = false;
  $("solveur-jeu").setAttribute("aria-pressed", "false");
  // VIDE A LA FERMETURE : ni la saisie ni les resultats ne doivent survivre
  // d'une ouverture a l'autre.
  solveurMini.vider();
  // ET REMISE A LA POSITION DE DEPART : sans ca, un ancien `left`/`top` pose
  // par un glisser-deposer (voir plus bas) pouvait rouvrir la fenetre hors du
  // champ de vision, par exemple apres un redimensionnement de la fenetre du
  // navigateur entre-temps.
  const fenetre = $("solveur-mini") as HTMLElement;
  fenetre.style.left = "";
  fenetre.style.top = "";
  fenetre.style.right = "";
  fenetre.style.bottom = "";
}
$("solveur-jeu").addEventListener("click", () => {
  if (miniOuvert) fermerLeSolveurMini(); else ouvrirLeSolveurMini();
});
$("svm-fermer").addEventListener("click", fermerLeSolveurMini);
// ECHAP FERME LE MINI SOLVEUR, D'OU QU'ON Y AIT CLIQUE (champ, bouton...) --
// capte sur le conteneur entier plutot que sur chaque element un par un.
$("solveur-mini").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); fermerLeSolveurMini(); }
});

(() => {
  const poignee = $("svm-poignee");
  const fenetre = $("solveur-mini");
  const fermer = $("svm-fermer");
  let dx = 0, dy = 0, enCours = false;
  poignee.addEventListener("pointerdown", (e) => {
    // Le bouton de fermeture est DANS la poignee : sans ce garde-fou, la
    // capture du pointeur pour le glisser-deposer prenait le pas sur son
    // propre clic, et la croix ne fermait plus rien.
    if (e.target === fermer || fermer.contains(e.target as Node)) return;
    enCours = true;
    const r = fenetre.getBoundingClientRect();
    dx = e.clientX - r.left;
    dy = e.clientY - r.top;
    // LA FENETRE SE FIGE LA OU ELLE EST, AVANT DE LACHER SES ANCRAGES.
    //
    // Elle vit en bas a droite (`bottom`/`right` en CSS, `top`/`left` a `auto`).
    // Lacher `right` sans avoir pose `left` la laissait une image ou deux SANS
    // AUCUN REPERE HORIZONTAL : une boite `fixed` retombe alors sur sa position
    // statique, contre le bord gauche de l'ecran, et c'est le premier
    // `pointermove` qui la ramenait. D'ou le flash a gauche des qu'on
    // l'attrapait. On pose donc sa position mesuree AVANT de retirer les
    // ancrages du coin oppose : elle ne bouge pas d'un pixel.
    fenetre.style.left = `${r.left}px`;
    fenetre.style.top = `${r.top}px`;
    fenetre.style.right = "auto";
    fenetre.style.bottom = "auto";
    poignee.setPointerCapture(e.pointerId);
  });
  poignee.addEventListener("pointermove", (e) => {
    if (!enCours) return;
    const marge = 8;
    const x = Math.min(Math.max(e.clientX - dx, marge), window.innerWidth - marge - fenetre.offsetWidth);
    const y = Math.min(Math.max(e.clientY - dy, marge), window.innerHeight - marge - 40);
    fenetre.style.left = `${x}px`;
    fenetre.style.top = `${y}px`;
  });
  poignee.addEventListener("pointerup", (e) => { enCours = false; poignee.releasePointerCapture(e.pointerId); });
})();

/** Les trois etats de la verification, et ce qu'on peut en faire. */
function peindreLaVerification(): void {
  const boite = $("perso-verif");
  boite.replaceChildren();
  if (moiCompte === null) return;
  boite.appendChild(el("h2", "", "Vérification"));
  const dit = el("p");
  if (moiCompte.verifie) {
    dit.textContent = t("Votre vérification a été actée");
    boite.appendChild(dit);
    return;
  }
  if (moiCompte.demande) {
    dit.className = "attente";
    dit.textContent = t("Demande déposée.");
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
      t("Renseignez votre prénom et votre nom");
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
  $("fiche-page").hidden = j === undefined;
  if (j === undefined) {
    $("fiche-error").textContent = t("Ce joueur n'a pas de compte.");
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

$("fiche-page").addEventListener("click", () => {
  $("voile-joueur").hidden = true;
  ouvrirLaPagePerso($("fiche-pseudo").textContent ?? "");
});
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
/** Ce qu'on reprend une fois le pseudo donne, quand ce n'est pas un salon. */
let reprendreApresLePseudo: (() => void) | null = null;

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
  // LE LEXIQUE EN DERNIER, mais il y est : c'est ce qui decide si l'on peut
  // jouer dans ce salon, et rien d'autre ne le disait.
  // Le double joker se nomme : deux jokers par coup n'est pas la meme partie
  // qu'un, et c'est ce qu'on regarde avant d'entrer.
  const joker = c.joker !== true ? []
    : c.jokersParCoup === 2 ? [t("double joker")] : [t("joker")];
  return [mode, nomDeLaVariante(c), dureeDuChrono(c.chrono)]
    .concat(joker)
    .concat([dictionnaire(c.dictionnaire).nom])
    .join(" · ");
}

/** `15×15`, `21×21`… ou l'infini. */
function courtDeLaGrille(bornes: number | null): string {
  return bornes === null ? "∞" : `${bornes * 2 + 1}×${bornes * 2 + 1}`;
}

/** Les chiffres se lisent par tranches de trois, comme partout ailleurs. */
const chiffres = (n: number): string =>
  n.toLocaleString(langue() === "en" ? "en-US" : "fr-FR");

/** La langue d'un salon, c'est celle de son lexique. */
function langueDuSalon(s: ResumeSalon): Langue {
  return dictionnaire(s.config.dictionnaire).langue;
}

/** La super grille se reconnait a son demi-cote : dix cases, donc 21x21. */
const SUPER_BORNES = 10;

/**
 * Combien d'exemplaires du jeu le sac contient, pour cette grille.
 *
 * Deux sur la super grille, un partout ailleurs. C'est le serveur qui tranche
 * -- le client n'envoie pas ce reglage -- mais l'accueil et les reglages
 * doivent l'annoncer juste avant qu'il ne le fasse.
 */
function sacsDeLaGrille(bornes: number | null): number {
  return bornes === SUPER_BORNES ? 2 : 1;
}

function estSuper(c: ResumeSalon["config"]): boolean {
  return c.bornes === SUPER_BORNES;
}

/** Le filtre s'applique a tous les salons, la grille mondiale comprise. */
function retenu(s: ResumeSalon): boolean {
  if (langueMontree !== "toutes" && langueDuSalon(s) !== langueMontree) return false;
  // « 15x15 » attrape tous les plateaux bornes SAUF la super grille, qui a sa
  // puce a elle. Un plateau d'une autre taille -- le serveur en accepte, meme
  // si rien ne les propose -- reste ainsi visible quelque part.
  if (filtre === "bornee") return s.config.bornes !== null && !estSuper(s.config);
  if (filtre === "super") return estSuper(s.config);
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
  $("pseudo-quoi").textContent = t("Il vous suit d'un salon à l'autre.");
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

  const competitif = el("button", "records", t("Compétitif")) as HTMLButtonElement;
  competitif.type = "button";
  competitif.addEventListener("click", () => ouvrirLeCompetitif());
  boite.appendChild(competitif);

  const solveur = el("button", "records", t("Anagrammeur")) as HTMLButtonElement;
  solveur.type = "button";
  solveur.addEventListener("click", () => ouvrirLeSolveur());
  boite.appendChild(solveur);

  const records = el("button", "records", "Records") as HTMLButtonElement;
  records.type = "button";
  records.addEventListener("click", () => ouvrirLesRecords());
  boite.appendChild(records);

  const moi = pseudo();

  // Nomme, mais sans compte : on montre sous quel nom on joue, et la porte du
  // compte reste ouverte a cote.
  if (moiCompte === null && moi !== "") {
    const b = el("button", "moi") as HTMLButtonElement;
    b.type = "button";
    b.title = t("Changer de pseudo");
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

  // LA CLOCHE : ce qui s'est passe pendant qu'on n'etait pas la (SPEC.md §29).
  const cloche = el("button", "icon cloche") as HTMLButtonElement;
  cloche.id = "cloche-notifs";
  cloche.type = "button";
  cloche.setAttribute("aria-label", t("Notifications"));
  cloche.innerHTML = ICONE_CLOCHE;
  cloche.addEventListener("click", () => ouvrirLesNotifications());
  boite.appendChild(cloche);
  peindreLaCloche();
  void chargerLesNotifications();

  const b = el("button", "moi") as HTMLButtonElement;
  b.type = "button";
  b.title = "Votre profil";
  const rond = el("span", "avatar");
  peindreAvatar(rond, moiCompte.avatar, 30, moiCompte.avatarSombre);
  b.appendChild(rond);
  b.appendChild(el("span", "", moiCompte.pseudo));
  if (moiCompte.verifie) b.appendChild(el("span", "pastille", "vérifié"));
  // CLIQUER SON NOM MENE A SA PAGE, et non plus aux reglages (SPEC.md §30).
  b.addEventListener("click", () => ouvrirLaPagePerso(moiCompte!.pseudo));
  boite.appendChild(b);

  const roue = el("button", "icon roue") as HTMLButtonElement;
  roue.type = "button";
  roue.title = t("Paramètres");
  roue.setAttribute("aria-label", t("Paramètres"));
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
    ["tous", t("Tous")], ["bornee", "15×15"], ["super", "21×21"],
    ["infinie", t("Infinie")], ["attente", t("En attente")],
  ];
  for (const [cle, texte] of puces) {
    const b = el("button", "puce", texte) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(filtre === cle));
    b.addEventListener("click", () => { filtre = cle; peindreAccueil(); });
    barre.appendChild(b);
  }

  // LA LANGUE EST UN AUTRE AXE, DONC UN AUTRE GROUPE.
  //
  // « Tous » et « Toutes les langues » cote a cote dans la meme rangee se
  // lisaient comme deux reglages concurrents, alors que le premier ne parle que
  // de la forme de la grille. Un trait les separe, et la langue se choisit
  // entre trois puces qui s'excluent.
  //
  // LES DEUX LANGUES SE MONTRENT, pas seulement celle du site. Une puce unique
  // n'offrait que la sienne et le tout : un anglophone n'avait aucun moyen de
  // regarder les salons francais seuls.
  barre.appendChild(el("span", "coupure"));
  const langues: [Langue | "toutes", string, string][] = [
    ["fr", "FR", t2("Ne montrer que les salons en {l}", { l: "français" })],
    ["en", "EN", t2("Ne montrer que les salons en {l}", { l: "anglais" })],
    ["toutes", t("Toutes les langues"), t("Montrer les salons de toutes les langues")],
  ];
  for (const [valeur, texte, quoi] of langues) {
    const b = el("button", "puce", texte) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(langueMontree === valeur));
    b.title = quoi;
    b.addEventListener("click", () => {
      langueMontree = valeur;
      langueChoisie = true;
      peindreAccueil();
    });
    barre.appendChild(b);
  }
  // CREER UN SALON NE DEMANDE PAS DE COMPTE, ni meme d'etre deja nomme : le
  // pseudo se demande au clic, et la creation reprend toute seule ensuite.
  const creer = el("button", "creer-bar", t("Créer un salon")) as HTMLButtonElement;
  creer.type = "button";
  creer.addEventListener("click", () => { void creerSalon(); });
  barre.appendChild(creer);
}

/** La tuile du salon star : la grille mondiale, deux colonnes sur deux rangees. */
function tuileStar(s: ResumeSalon): HTMLElement {
  const tuile = el("button", "star") as HTMLButtonElement;
  tuile.type = "button";

  const pastille = el("span", "enligne");
  pastille.appendChild(el("span", "point"));
  pastille.appendChild(el("span", "", t2("{n} en ligne", { n: s.connectes })));
  tuile.appendChild(pastille);

  // Le surtitre appartient au salon, comme son accroche : « Featured room »
  // au-dessus de The Infinite Grid, meme lu depuis la version francaise.
  tuile.appendChild(el("span", "surtitre", tDans(langueDuSalon(s), "Salon star")));
  tuile.appendChild(el("span", "titre", s.nom));
  const accroche = el("span", "accroche");
  for (const ligne of accrocheStar(langueDuSalon(s))) {
    accroche.appendChild(el("span", "", ligne));
  }
  tuile.appendChild(accroche);

  const action = el("span", "action");
  action.appendChild(el("span", "jouer", t("Jouer")));
  // Le cumul manque tant que le serveur tourne une version anterieure : on
  // affiche alors le coup seul plutot qu'un « undefined points ».
  const compte = s.cumul === undefined
    ? t2("Coup {n}", { n: chiffres(s.coups) })
    : t2("Coup {n} · {p} points", { n: chiffres(s.coups), p: chiffres(s.cumul) });
  action.appendChild(el("span", "chiffres", compte));
  tuile.appendChild(action);

  tuile.appendChild(el("span", "lexique", dictionnaire(s.config.dictionnaire).nom));

  tuile.addEventListener("click", () => allerA(s.id));
  return tuile;
}

/** Une carte de salon : sa vraie grille, son nom, sa variante, son etat. */
function carteSalon(s: ResumeSalon): HTMLElement {
  const c = el("button", "carte") as HTMLButtonElement;
  c.type = "button";

  const vue = el("span", "vue");
  const infinie = s.config.bornes === null;
  // La super grille a sa vignette a elle : c'est la seule qui montre du vert,
  // et le vert est justement ce qu'elle a de plus que les autres.
  const quelle = infinie ? "infinie" : estSuper(s.config) ? "super" : "bornee";
  vue.appendChild(el("span", `vignette ${quelle}`));
  vue.appendChild(el("span", "badge", courtDeLaGrille(s.config.bornes)));

  // Le createur peut retirer son salon -- sauf s'il est permanent : des
  // milliers de coups joues a plusieurs ne tiennent pas a un clic.
  const moi = pseudo();
  const aLeDroit = s.proprietaire === moi || moiCompte?.admin === true;
  if (s.permanent !== true && moi !== "" && aLeDroit) {
    const jeter = el("button", "jeter", t("Supprimer")) as HTMLButtonElement;
    jeter.type = "button";
    // Le bouton dit ce qu'il fait VRAIMENT : seule une 15x15 terminee survit a
    // la disparition de son salon.
    jeter.title = !infinie && s.finie
      ? t("Retire le salon. La partie terminée est conservée.")
      : t("Retire le salon ET efface la partie. Sans retour.");
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
    ? t("permanent")
    : t2("{n} joueur{s}", { n: s.connectes, s: s.connectes > 1 ? "s" : "" })));
  etat.appendChild(el("span", "ou", s.finie
    ? t("terminée")
    : s.coups === 0 ? t("en attente") : t2("coup {n}", { n: chiffres(s.coups) })));
  dedans.appendChild(etat);
  c.appendChild(dedans);

  c.addEventListener("click", () => allerA(s.id));
  return c;
}

/** La tuile pointillee, en fin de mur — seulement si l'on s'est nomme. */
function tuileCreer(): HTMLElement {
  const tuile = el("button", "tuile-creer", t("Créer un salon")) as HTMLButtonElement;
  tuile.type = "button";
  tuile.addEventListener("click", () => { void creerSalon(); });
  return tuile;
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
  // UNE TUILE PAR GRILLE PERMANENTE. Il y en a une par langue, et « Tout
  // afficher » les montre toutes : la colonne s'allonge, elle ne les serre pas.
  const stars = vus.filter((s) => s.mondiale);
  for (const s of stars) vedette.appendChild(tuileStar(s));
  vedette.hidden = stars.length === 0;
  $("mur").classList.toggle("sans-star", stars.length === 0);

  const autres = vus.filter((s) => !s.mondiale);
  for (const s of autres) rouleau.appendChild(carteSalon(s));
  if (vus.length === 0) {
    rouleau.appendChild(el("div", "none",
      liste.length === 0 ? t("aucun salon ouvert") : t("aucun salon comme ça")));
  }
  if (pseudo() !== "") rouleau.appendChild(tuileCreer());

  // Un joueur ne compte qu'une fois : il n'est present que dans un salon.
  const total = salonsRecus.reduce((a, s) => a + s.connectes, 0);
  $("pied-total").textContent = t2("{n} joueur{s} en ligne",
    { n: chiffres(total), s: total > 1 ? "s" : "" });
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
/** La partie joker, en cours d'edition. */
let cJoker = false;
/**
 * Combien de jokers par tirage, en cours d'edition : un, ou deux en double
 * joker. Ne vaut que si `cJoker` est vrai.
 */
let cJokers = 1;
/**
 * LA MONTANTE, en cours d'edition : six parties en topping a la suite.
 *
 * Elle n'est pas un format de plus : c'est une SUITE de formats, et elle les
 * impose. Allumee, le format, le joker, la pioche et les primes ne se reglent
 * plus -- ils ne se lisent -- et la grille sans fin s'eteint.
 */
let cMontante = false;

/**
 * Le format en cours d'edition, dans la fenetre simple.
 *
 * Trois formats se nomment -- ce sont ceux qu'on joue en club -- et le
 * quatrieme ouvre les deux grilles de nombres de la fenetre complete. Le nom
 * dit la chose bien mieux que « 7 » et « 8 » cote a cote : « 7 sur 8 », on sait
 * ce que c'est ; « jouables 7, tirage 8 » demande un instant de traduction.
 */
let cFormat: "7/7" | "7/8" | "8/8" | "perso" = "7/7";

/** Le format nomme qui correspond a ces deux nombres, ou « perso ». */
function formatDe(tirage: number, jouables: number): typeof cFormat {
  if (tirage === 7 && jouables === 7) return "7/7";
  if (tirage === 8 && jouables === 7) return "7/8";
  if (tirage === 8 && jouables === 8) return "8/8";
  return "perso";
}
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
    appliquerLeModeDeReglages();
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
      `<b>${t2("Attention : sac sans fin sur une grille {c}×{c}.",
        { c: cBornes * 2 + 1 })}</b><br>` +
      t("Le sac se recharge indéfiniment : la partie ne s'arrête que lorsque") + " " +
      t("aucun coup n'est jouable, et elle sera très longue.");
    boite.hidden = false;
    return;
  }

  // LES PROBABILITES PONDEREES NE S'EPUISENT PAS. Sur une grille sans bord
  // c'est leur raison d'etre ; sur un plateau ferme, c'est un piege : rien
  // n'arrete la partie tant qu'un coup reste jouable, et un plateau se bouche
  // beaucoup plus lentement qu'un sac ne se vide.
  if (cBornes !== null && cPioche === "probabilites") {
    boite.innerHTML =
      `<b>${t2("Attention : probabilités pondérées sur une grille {c}×{c}.",
        { c: cBornes * 2 + 1 })}</b><br>` +
      t("Il n'y a pas de limite de lettres tirées : la partie ne s'arrête que lorsque") + " " +
      t("aucun coup n'est jouable, et elle sera très longue.");
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
    const choisi = v === "infinie" ? cBornes === null
      : v === "super" ? cBornes === SUPER_BORNES
      : cBornes !== null && cBornes !== SUPER_BORNES;
    b.setAttribute("aria-pressed", String(choisi));
  }
}

for (const b of $("r-grille").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    const v = (b as HTMLElement).dataset["v"];
    cBornes = v === "infinie" ? null : v === "super" ? SUPER_BORNES : 7;
    peuplerGrille();
    // LE DOUBLE JOKER NE SUIT PAS SUR UNE GRILLE SANS FIN : le serveur le
    // ramenerait a un joker sans le dire, et l'interrupteur resterait allume
    // au-dessus d'une partie qui ne le joue pas.
    if (cBornes === null) cJokers = 1;
    peuplerJoker();
    appliquerLeModeDeReglages();
    // Chaque grille a son tirage naturel : le sac sans fin ne s'epuise jamais,
    // ce qu'une grille sans bord demande ; le plateau ferme veut le sac de
    // 102, et le sac fini n'a plus lieu d'y etre.
    if (cBornes === null && cPioche === "sac102") cPioche = "sac102boucle";
    // Le plateau borne veut un vrai sac -- des probabilites ponderees n'y
    // finissent jamais de remplir la grille. Le sac SANS FIN, lui, y a
    // desormais sa place et n'est plus chasse.
    if (cBornes !== null && cPioche === "probabilites") cPioche = "sac102";
    // La fenetre simple ne montre pas le tirage : elle le decide. Le sac du jeu
    // classique sur un plateau ferme, le meme qui se recharge sans fin sur une
    // grille sans bord -- sinon elle s'arreterait au bout de cent caramels.
    if (!prefs.avance) cPioche = cBornes === null ? "sac102boucle" : "sac102";
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

/**
 * Le plancher du chrono d'une montante, en secondes.
 *
 * C'est celui de son etape la plus chere, et non de la premiere. La partie
 * normale descend a une seconde par coup parce que c'est la que se joue le
 * record de chrono ; les cinq autres etapes restent a quinze. Le serveur refuse
 * en dessous : le panneau remonte donc le chrono plutot que de laisser valider
 * un reglage qui sera rejete.
 */
const CHRONO_MONTANTE = 15;

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
  $("r-primes-open").textContent = ouvert ? t("Masquer les primes") : t("Primes de farfouilles");
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
        cFormat = formatDe(cTirage, cJouables);
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
  // LE NOMBRE DE CARAMELS SUIT LE LEXIQUE ET LA GRILLE. Le jeu francais en
  // compte cent deux, l'anglais cent : « sac de 102 lettres » au-dessus d'un
  // chevalet anglais serait faux, et c'est le genre de detail qu'un joueur
  // verifie. La super grille en demande deux exemplaires -- 441 cases ne se
  // remplissent pas avec 102 caramels -- et l'option de 102 devient donc celle
  // de 204, sans qu'il y ait rien de plus a choisir.
  const n = tailleDuSac(dictionnaire(cDico), sacsDeLaGrille(cBornes));
  for (const b of $("r-pioche").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    if (v === "sac102") b.textContent = t2("Sac de {n} lettres", { n });
    if (v === "sac102boucle") b.textContent = t2("Sac de {n} sans fin", { n });
    b.setAttribute("aria-pressed", String(v === cPioche));
    (b as HTMLButtonElement).disabled = false;
    (b as HTMLButtonElement).title = "";
  }
}

/**
 * Le lexique, en une ligne : son nom, puis sa langue.
 *
 * LE NOM D'ABORD. C'est lui qu'on cherche -- on vient chercher le CSW, pas
 * « l'anglais » -- et la liste se lit alors comme une colonne de noms alignes
 * plutot que comme deux « English » suivis d'un troisieme.
 *
 * Un tiret simple les separe, et non un cadratin : le cadratin est la marque de
 * ce qu'on n'a pas ecrit soi-meme.
 *
 * Un menu deroulant plutot qu'une rangee de boutons : quatre lexiques, et une
 * rangee qui grandit a chaque ajout mangerait la moitie du panneau pour un
 * reglage qu'on touche une fois.
 */
function peuplerDico(): void {
  const menu = $("r-dico") as HTMLSelectElement;
  menu.replaceChildren();
  for (const d of tousLesDictionnaires()) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = `${d.nom} - ${d.langue === "en" ? "English" : "Français"}`;
    o.title = t(d.detail);
    menu.appendChild(o);
  }
  menu.value = cDico;
}

($("r-dico") as HTMLSelectElement).addEventListener("change", () => {
  cDico = ($("r-dico") as HTMLSelectElement).value;
  // Le sac n'a pas le meme nombre de caramels d'un lexique a l'autre.
  peuplerPioche();
});

/** Les quatre formats de la fenetre simple. */
function peuplerFormat(): void {
  for (const b of $("r-format").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === cFormat));
  }
  // « Personnalise » fait apparaitre les deux grilles de nombres -- les memes
  // que la fenetre complete, pas une seconde paire a tenir a jour.
  if (!prefs.avance) $("r-nombres-bloc").hidden = cFormat !== "perso";
}

for (const b of $("r-format").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    cFormat = (b as HTMLElement).dataset["v"] as typeof cFormat;
    if (cFormat === "7/7") { cTirage = 7; cJouables = 7; }
    else if (cFormat === "7/8") { cTirage = 8; cJouables = 7; }
    else if (cFormat === "8/8") { cTirage = 8; cJouables = 8; }
    cPrimes = primesHabituelles();
    peuplerFormat();
    peuplerNombres();
    avertirSiExplosif();
  });
}

/**
 * Les deux interrupteurs du joker, QUI S'EXCLUENT.
 *
 * « Partie joker » et « double joker » sont deux modes de jeu voisins mais
 * distincts : on tire UN joker dans l'un et DEUX dans l'autre. Allumer le
 * second n'allume donc pas le premier -- ce ne sont pas deux crans du meme
 * reglage -- et allumer l'un eteint l'autre. Rallumer celui qui brille eteint
 * les jokers tout court.
 */
function peuplerJoker(): void {
  $("r-joker").setAttribute("aria-pressed", String(cJoker && cJokers === 1));
  $("r-joker2").setAttribute("aria-pressed", String(cJoker && cJokers === 2));
}

/**
 * L'interrupteur de la montante, et les six etapes qu'il affiche.
 *
 * Elles ne se reglent pas : elles se lisent. Cacher le bloc du format sans rien
 * mettre a la place laisserait un joueur sans savoir ce qu'il va jouer.
 */
function peuplerMontante(): void {
  $("r-montante").setAttribute("aria-pressed", String(cMontante));
  const boite = $("r-montante-etapes");
  boite.replaceChildren();
  for (const e of ETAPES) {
    const c = el("span", "mt-etape");
    c.appendChild(el("i", "", `${e.rang}. `));
    c.appendChild(document.createTextNode(t(e.nom)));
    boite.appendChild(c);
  }
}

$("r-montante").addEventListener("click", () => {
  cMontante = !cMontante;
  if (cMontante) {
    // LA MONTANTE IMPOSE CE QU'ELLE IMPOSE, ET LE PANNEAU LE MONTRE plutot que
    // de laisser le serveur corriger en silence : l'etape 1 est la partie
    // normale, en topping, au sac du commerce, aux primes du jeu.
    cMode = "topping";
    cFormat = "7/7";
    cTirage = 7;
    cJouables = 7;
    cJoker = false;
    cJokers = 1;
    cPioche = "sac102";
    cPrimes = {};
    cCoupsMax = null;
    cDureeMax = null;
    // Une grille sans fin n'a pas de bout : on retombe sur le plateau normal.
    if (cBornes === null) cBornes = 7;
    // Le plancher du chrono de la montante est celui de son etape la plus
    // chere, quinze secondes : le serveur refuserait moins.
    if (cChrono !== null && cChrono < CHRONO_MONTANTE) cChrono = CHRONO_MONTANTE;
  }
  peuplerMontante();
  peuplerMode();
  peuplerJoker();
  peuplerGrille();
  peuplerFormat();
  peuplerNombres();
  peuplerPioche();
  peuplerChrono();
  peuplerCoups();
  appliquerLeModeDeReglages();
  avertirSiExplosif();
});

/** Zero, un ou deux jokers par tirage. Un clic sur le mode allume choisit zero. */
function choisirLesJokers(combien: number): void {
  const deja = cJoker && cJokers === combien;
  cJoker = !deja;
  cJokers = deja ? 1 : combien;
  peuplerJoker();
  // Eteindre le double joker en fenetre simple l'y fait disparaitre : il n'y
  // figurait que parce qu'il etait allume.
  appliquerLeModeDeReglages();
}

$("r-joker").addEventListener("click", () => choisirLesJokers(1));
$("r-joker2").addEventListener("click", () => choisirLesJokers(2));

/**
 * Montre la fenetre simple ou la fenetre complete.
 *
 * CE QUI DISPARAIT N'EST PAS PERDU : les reglages caches gardent la valeur de
 * la partie en cours, et la fenetre simple en impose quelques-uns -- le lexique
 * de la langue, le sac du jeu classique. C'est le contrat : moins de decisions,
 * pas moins de partie.
 */
function appliquerLeModeDeReglages(): void {
  const avance = prefs.avance;
  $("r-avance").setAttribute("aria-pressed", String(avance));
  // CE QUE LA MONTANTE DECIDE NE SE REGLE PLUS. Le format, le joker, la pioche
  // et les primes appartiennent a la suite ; le chrono, le lexique et la grille
  // restent au joueur. Les six etapes prennent la place du bloc du format : un
  // reglage qui disparait sans rien dire laisserait ignorer ce qu'on va jouer.
  // LE TOPPING COLLABORATIF N'EXISTE QU'AU TOPPING : le duplicate compte des
  // points, il n'a pas de coup remporte a taire.
  $("r-topping-collab-case").hidden = cMode !== "topping";
  const mont = cMontante;
  $("r-montante").setAttribute("aria-pressed", String(mont));
  $("r-montante").hidden = cBornes === null || (!avance && !mont);
  $("r-montante-bloc").hidden = !mont;
  $("r-pioche-bloc").hidden = !avance || mont;
  $("r-primes-bloc").hidden = !avance || mont;
  $("r-format-bloc").hidden = avance || mont;
  $("r-nombres-bloc").hidden = mont || (!avance && cFormat !== "perso");
  // Le joker et le duplicate s'eteignent SANS DISPARAITRE : la rangee garderait
  // un trou, et l'on ne verrait plus que la montante les a decides.
  for (const b of [$("r-joker"), $("r-joker2")]) {
    (b as HTMLButtonElement).disabled = mont;
  }
  for (const b of $("r-mode").querySelectorAll("button")) {
    (b as HTMLButtonElement).disabled = mont && (b as HTMLElement).dataset["v"] !== "topping";
  }
  // Une grille sans fin n'a pas de bout, donc pas d'etape suivante.
  for (const b of $("r-grille").querySelectorAll("button")) {
    const infinie = (b as HTMLElement).dataset["v"] === "infinie";
    (b as HTMLButtonElement).disabled = mont && infinie;
  }
  // LA SUPER GRILLE SE MONTRE QUAND MEME SI L'ON Y JOUE. Cacher le reglage que
  // la partie en cours utilise laisserait le panneau sans aucun bouton allume,
  // et le premier clic ailleurs changerait de plateau sans le dire.
  for (const b of $("r-grille").querySelectorAll("button[data-avance]")) {
    (b as HTMLElement).hidden = !avance && cBornes !== SUPER_BORNES;
  }
  // Le double joker demande les reglages avances ET une grille bornee. Sur une
  // grille sans fin il n'existe pas du tout : ce n'est pas une option cachee,
  // c'est une option qui n'a pas cours.
  $("r-joker2").hidden = cBornes === null || mont || (!avance && cJokers !== 2);
  // Quinze secondes par coup, c'est un reglage de joueur aguerri : il coute
  // cher au serveur et ne laisse le temps de rien a qui decouvre.
  for (const b of $("r-chrono").querySelectorAll("button[data-avance]")) {
    (b as HTMLElement).hidden = !avance;
  }
  // Et inversement : trois minutes par coup est un rythme de decouverte, pas
  // une variante qu'on regle. Le champ libre reste la pour qui la veut.
  for (const b of $("r-chrono").querySelectorAll("button[data-simple]")) {
    (b as HTMLElement).hidden = avance;
  }
}

$("r-avance").addEventListener("click", () => {
  prefs.avance = !prefs.avance;
  garderPreferences();
  // La fenetre simple impose le sac et le lexique : en y revenant, on les
  // remet, sans quoi le panneau montrerait un reglage qu'il ne propose plus.
  if (!prefs.avance) simplifierLesReglages();
  appliquerLeModeDeReglages();
  peuplerPioche();
  peuplerDico();
  peuplerFormat();
  avertirSiExplosif();
});

/** Ce que la fenetre simple decide a la place du joueur. */
function simplifierLesReglages(): void {
  // Le sac du jeu classique, qui se recharge sur une grille sans bord -- sinon
  // elle s'arreterait au bout de cent caramels.
  cPioche = cBornes === null ? "sac102boucle" : "sac102";
  // LE DOUBLE JOKER N'EST PAS REMIS A ZERO ICI. C'est un reglage avance, mais
  // la fenetre simple garde son interrupteur visible tant qu'il est allume
  // (voir `appliquerLeModeDeReglages`) : l'eteindre en douce ferait repartir en
  // simple joker une partie qu'on venait juste rouvrir.
  cFormat = formatDe(cTirage, cJouables);
}

/** Ouvre les reglages sur l'etat courant de la partie. */
function ouvrirReglages(): void {
  cTirage = cfg.tirage;
  cJouables = cfg.jouables;
  cPioche = cfg.pioche;
  cDico = cfg.dictionnaire;
  cJoker = cfg.joker === true;
  cJokers = cfg.jokersParCoup === 2 ? 2 : 1;
  // Le panneau s'ouvre sur l'etat du salon : une montante en cours y est
  // allumee, et la refermer sans y toucher ne l'eteint pas.
  cMontante = montante !== null;
  cPrimes = { ...cfg.primes };
  cChrono = cfg.chrono;
  cBornes = cfg.bornes;
  cMode = cfg.mode === "duplicate" ? "duplicate" : "topping";
  cCoupsMax = cfg.coupsMax;
  cDureeMax = cfg.dureeMax;
  cBorne = cfg.dureeMax !== null ? "duree" : "coups";
  ($("r-decompte") as HTMLInputElement).checked = cfg.decompte === true;
  ($("r-topping-collab") as HTMLInputElement).checked = cfg.toppingCollaboratif === true;
  ($("r-prive") as HTMLInputElement).checked = salonPrive;
  peuplerMode();
  peuplerCoups();
  peuplerChrono();
  peuplerGrille();
  avertirSiExplosif();
  peuplerJoker();
  peuplerMontante();
  $("r-primes").hidden = true;
  $("r-primes-open").textContent = t("Primes de farfouilles");
  cFormat = formatDe(cTirage, cJouables);
  if (!prefs.avance) simplifierLesReglages();
  peuplerNombres();
  peuplerPioche();
  peuplerDico();
  peuplerFormat();
  appliquerLeModeDeReglages();
  $("r-error").hidden = true;
  // SOUS LE RELIQUAT, PAS PLUS HAUT. Regler une partie, c'est regarder le
  // tirage et les lettres restantes en meme temps : un panneau qui les
  // recouvre oblige a le fermer pour verifier ce qu'on vient de decider.
  //
  // La hauteur se MESURE plutot que de s'ecrire en dur : la barre du chevalet
  // change de hauteur avec la taille des caramels, qui change avec le nombre
  // de lettres. Une constante serait juste aujourd'hui et fausse au premier
  // tirage a quinze.
  // LA FENETRE DOIT TENIR A L'ECRAN, MEME SUR UN PETIT.
  //
  // Le panneau se posait sous le reliquat quoi qu'il arrive, avec une hauteur
  // plancher de 240 pixels : sur un ecran bas, son pied -- donc le bouton qui
  // valide -- tombait hors de la fenetre, et rien ne pouvait l'y ramener
  // puisque la page, elle, ne defile pas. On remonte donc le panneau autant
  // qu'il le faut, quitte a couvrir le chevalet : un reglage qu'on ne peut pas
  // valider ne sert a rien.
  const bas = Math.round($("sac").getBoundingClientRect().bottom);
  const MINIMUM = 260, AIR = 14;
  const haut = Math.max(0, Math.min(bas, innerHeight - MINIMUM - AIR));
  $("reglages").style.paddingTop = `${haut}px`;
  ($("reglages").firstElementChild as HTMLElement).style.maxHeight =
    `${Math.max(MINIMUM, innerHeight - haut - AIR)}px`;
  $("reglages").hidden = false;
}

$("reglages-open").addEventListener("click", ouvrirReglages);
// REJOUER EN CHANGEANT LES REGLAGES : le meme panneau que la roue, ouvert la ou
// l'on est -- c'est lui qui relance, une fois qu'on a choisi.
$("rejouer-reglages").addEventListener("click", ouvrirReglages);
$("rg-close").addEventListener("click", () => { $("reglages").hidden = true; });

// ------------------------------------------------ salon prive, et invitations
//
// A PART DU RESTE DES REGLAGES (SPEC.md §26) : la case agit tout de suite, sans
// passer par "Appliquer" -- c'est un reglage DU SALON, pas de la partie, et il
// n'y a aucune raison d'archiver une partie en cours pour la seule fermer aux
// nouveaux venus.
$("r-prive").addEventListener("change", () => {
  envoyer({ t: "salonPrive", prive: ($("r-prive") as HTMLInputElement).checked });
});

$("r-inviter").addEventListener("click", () => {
  $("inviter-liste").replaceChildren(el("p", "", t("Chargement…")));
  $("voile-inviter").hidden = false;
  envoyer({ t: "connectes" });
});
$("inviter-close").addEventListener("click", () => { $("voile-inviter").hidden = true; });
$("voile-inviter").addEventListener("click", (e) => {
  if (e.target === $("voile-inviter")) $("voile-inviter").hidden = true;
});

/** Peuple la fenetre d'invitation depuis la liste des connectes (SPEC.md §26). */
function peuplerInviter(noms: string[]): void {
  const autres = noms.filter((n) => n !== me);
  if (autres.length === 0) {
    $("inviter-liste").replaceChildren(el("p", "", t("Personne d'autre n'est connecté.")));
    return;
  }
  $("inviter-liste").replaceChildren(...autres.map((n) => {
    const ligne = el("div", "ligne");
    ligne.appendChild(el("span", "nom", n));
    const bouton = el("button", "", t("Inviter")) as HTMLButtonElement;
    bouton.type = "button";
    bouton.addEventListener("click", () => {
      envoyer({ t: "inviter", pseudo: n });
      // OPTIMISTE : la liste des invites n'a pas de raison de revenir en
      // arriere ici, et attendre le serveur pour un simple accuse ajouterait
      // un aller-retour a un geste qui n'en demande pas.
      bouton.disabled = true;
      bouton.textContent = t("Invité");
    });
    ligne.appendChild(bouton);
    return ligne;
  }));
}

$("r-appliquer").addEventListener("click", () => {
  envoyer({
    t: "relancer", tirage: cTirage, jouables: cJouables, pioche: cPioche,
    dictionnaire: cDico,
    joker: cJoker,
    jokersParCoup: cJokers,
    // VALIDER SANS LA MONTANTE MET FIN A CELLE QUI COURT : une suite dont la
    // variante changerait en chemin ne serait plus une suite.
    montante: cMontante,
    primes: cPrimes,
    chrono: cChrono,
    bornes: cBornes,
    mode: cMode,
    // Un plateau borne et un sac de 102 ont leur propre fin : on ne leur en
    // ajoute pas une seconde. C'est la meme condition qui masque les onglets.
    coupsMax: sansTerme() || cBorne !== "coups" ? null : cCoupsMax,
    dureeMax: sansTerme() || cBorne !== "duree" ? null : cDureeMax,
    decompte: ($("r-decompte") as HTMLInputElement).checked,
    toppingCollaboratif: ($("r-topping-collab") as HTMLInputElement).checked,
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
  // On revient sur la page d'ou l'on etait parti jouer : elle a change.
  if (!$("corps-competitif").hidden) void chargerLeCompetitif();
}

$("quitter").addEventListener("click", quitterSalon);

/** Le nom du site ramene a l'accueil, comme le titre du bandeau de jeu. */
$("site-nom").addEventListener("click", () => {
  if (!$("corps-profil").hidden) { fermerLeProfil(); return; }
  if (!$("corps-solveur").hidden) { fermerLeSolveur(); return; }
  if (!$("corps-partie").hidden) { fermerLaPartie(); return; }
  if (!$("corps-records").hidden) { fermerLesRecords(); return; }
  if (!$("corps-competitif").hidden || !$("corps-resultats").hidden || !$("corps-palmares").hidden
      || !$("corps-admin").hidden || !$("corps-tournoi").hidden
      || !$("corps-perso").hidden || !$("corps-defi").hidden) { fermerLeCompetitif(); return; }
  if ($("join").hidden) quitterSalon();
});

/** Le rappel de la regle se referme par son bouton comme par son voile. */
$("regles-close").addEventListener("click", () => { $("voile-regles").hidden = true; });
$("voile-regles").addEventListener("click", (e) => {
  if (e.target === $("voile-regles")) $("voile-regles").hidden = true;
});

// ---------------------------------------------- abandonner un coup, ou la partie

/**
 * Confirmation Oui/Non generique (SPEC.md §24-25) : `titre` est la question
 * posee, `oui` ce que valide une reponse positive. Rien n'y est specifique a
 * l'abandon -- une autre confirmation future peut la reutiliser telle quelle.
 */
/**
 * UNE FENETRE A TOUT FAIRE : un titre, un corps, et rien d'autre.
 *
 * Le battle en ouvre une pour le detail d'une rencontre, la liste des joueurs
 * d'une equipe, l'en-tete du tournoi. Chacune de ces vues est trop petite pour
 * meriter sa page, et trop grande pour tenir dans une infobulle.
 */
function ouvrirUneFenetre(titre: string, corps: HTMLElement): void {
  $("boite-titre").textContent = titre;
  $("boite-corps").replaceChildren(corps);
  $("voile-boite").hidden = false;
}

function fermerLaFenetre(): void { $("voile-boite").hidden = true; }

$("boite-close").addEventListener("click", fermerLaFenetre);
$("voile-boite").addEventListener("click", (e) => {
  if (e.target === $("voile-boite")) fermerLaFenetre();
});

function confirmer(titre: string, oui: () => void): void {
  $("confirmer-titre").textContent = titre;
  ($("confirmer-oui") as HTMLButtonElement).onclick = () => {
    $("voile-confirmer").hidden = true;
    oui();
  };
  ($("confirmer-non") as HTMLButtonElement).onclick = () => { $("voile-confirmer").hidden = true; };
  $("voile-confirmer").hidden = false;
}
$("voile-confirmer").addEventListener("click", (e) => {
  if (e.target === $("voile-confirmer")) $("voile-confirmer").hidden = true;
});

function demanderLabandonDuCoup(): void {
  if (($("abandon-coup") as HTMLButtonElement).hidden) return;
  confirmer(t("Passer le tour ?"), () => envoyer({ t: "abandonnerCoup" }));
}
$("abandon-coup").addEventListener("click", demanderLabandonDuCoup);

$("abandon-partie").addEventListener("click", () => {
  if (($("abandon-partie") as HTMLButtonElement).hidden) return;
  confirmer(t("Abandonner la partie ?"), () => {
    // Retenu AVANT l'envoi : c'est le dernier coup connu ICI, celui que
    // l'abandon va laisser comme dernier de la partie (SPEC.md §25).
    cibleDuRejeuApresAbandon = history.length > 0 ? history[history.length - 1]!.n : null;
    envoyer({ t: "abandonnerPartie" });
  });
});

// -------------------------------------------------------- signaler un bug

/**
 * LE FORMULAIRE DES BUGS S'OUVRE DES DEUX COTES : du pied de l'accueil et du
 * bandeau du salon. Un bug se rencontre en jouant, et quitter la partie pour
 * aller le raconter, c'est perdre l'ecran qui le montre.
 *
 * IL NE DEMANDE PAS DE COMPTE. Celui qui bute sur un bug de la connexion est
 * justement celui qui ne peut pas se connecter pour le dire.
 */
function contexteDuBug(): { salon: string; coup: number | null } {
  // Sur l'accueil, il n'y a ni salon ni coup : `#join` decouvert dit qu'on y est.
  if (!$("join").hidden) return { salon: "", coup: null };
  return { salon: salonChoisi, coup: moveNumber + 1 };
}

function ouvrirLesBugs(): void {
  $("bug-error").hidden = true;
  $("bug-merci").hidden = true;
  $("bug-champs").hidden = false;
  const envoyer = $("bug-envoyer") as HTMLButtonElement;
  envoyer.disabled = false;
  envoyer.hidden = false;
  ($("bug-texte") as HTMLTextAreaElement).value = "";
  // L'adresse du compte est deja connue : la retaper n'apprendrait rien.
  ($("bug-mail") as HTMLInputElement).value = moiCompte?.email ?? "";
  $("voile-bug").hidden = false;
  ($("bug-texte") as HTMLTextAreaElement).focus();
}

function fermerLesBugs(): void {
  $("voile-bug").hidden = true;
}

$("bug-accueil").addEventListener("click", ouvrirLesBugs);
$("bug-jeu").addEventListener("click", ouvrirLesBugs);
$("bug-close").addEventListener("click", fermerLesBugs);
$("voile-bug").addEventListener("click", (e) => {
  if (e.target === $("voile-bug")) fermerLesBugs();
});

$("form-bug").addEventListener("submit", (e) => {
  e.preventDefault();
  void envoyerLeBug();
});

async function envoyerLeBug(): Promise<void> {
  const texte = ($("bug-texte") as HTMLTextAreaElement).value.trim();
  if (texte === "") {
    $("bug-error").textContent = t("Décrivez ce qui ne va pas");
    $("bug-error").hidden = false;
    ($("bug-texte") as HTMLTextAreaElement).focus();
    return;
  }
  const envoyer = $("bug-envoyer") as HTMLButtonElement;
  envoyer.disabled = true;
  $("bug-error").hidden = true;
  const { salon, coup } = contexteDuBug();
  try {
    const r = await fetch("/api/bug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        texte,
        email: ($("bug-mail") as HTMLInputElement).value.trim(),
        pseudo: pseudo(), salon, coup,
        langue: langue(), agent: navigator.userAgent,
        version: String(__COMPILE_A__),
      }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      $("bug-error").textContent = d.erreur ?? t("Envoi impossible, réessayez");
      $("bug-error").hidden = false;
      envoyer.disabled = false;
      return;
    }
  } catch {
    $("bug-error").textContent = t("Serveur injoignable");
    $("bug-error").hidden = false;
    envoyer.disabled = false;
    return;
  }
  // LE FORMULAIRE CEDE LA PLACE AU REMERCIEMENT : les champs disparaissent, le
  // bouton d'envoi aussi. Il ne reste qu'a refermer, et rien ne part deux fois.
  $("bug-champs").hidden = true;
  envoyer.hidden = true;
  $("bug-merci").hidden = false;
}

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
  if (moi === "") {
    reprendreApresLePseudo = () => { void creerSalon(); };
    demanderLePseudo(null);
    return;
  }
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
    $("c-error").textContent = s.erreur ?? t("création impossible");
    $("c-error").hidden = false;
    return;
  }
  await rejoindre(s.id);
}

$("joinform").addEventListener("submit", (e) => {
  e.preventDefault();
  const moi = pseudo();
  if (moi === "") {
    $("join-error").textContent = t("Entrez un pseudo pour continuer");
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
  const suite = reprendreApresLePseudo;
  reprendreApresLePseudo = null;
  if (suite !== null) { suite(); return; }
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
  motsRefuses = [];
  openPlayer = null;
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
  plateauRejeu = null;
  flairEnCours = 0;
  nonTrouves = 0;
  gerant = null;
  salonPermanent = false;
  permanent = false;
  tempsJoue = 0;
  rejeuOuvert = false;
  journalReplie = false;
  epreuve = null;
  enPause = false;
  ecoulePause = 0;
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
  fermerLeSolveurMini();

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

/**
 * Repeint TOUT ce que le jeu a compose, dans la nouvelle langue.
 *
 * Le balisage, lui, s'est deja remis d'aplomb tout seul (`appliquerLaLangue`).
 * Restent les endroits ou le code ecrit : l'accueil, le bandeau, le journal, le
 * chat, la grille. On ne repeint que ce qui est A L'ECRAN -- un panneau ferme
 * se repeindra a son ouverture.
 */
surChangementDeLangue(() => {
  // Le filtre des salons suit le site, tant qu'on ne l'a pas choisi soi-meme.
  if (!langueChoisie) langueMontree = langue();
  peindreAccueil();
  peuplerPreferences();
  if (!$("join").hidden) return;
  paintSide();
  paintJournal();
  paintChat(chat);
  paintRack();
  if (!$("roadmap").hidden) paintRoadmap();
  // Le rejeu porte le numero du coup dans son titre : il se refait en entier.
  if (rejeu !== null) voirLeCoup(rejeu.n);
  // Les reglages ouverts se referment : leurs boutons sont batis a l'ouverture,
  // et rouvrir le panneau vaut mieux que de reconstruire chaque rangee.
  $("reglages").hidden = true;
  draw();
});

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
  if (new URLSearchParams(location.search).get("page") === "solveur") ouvrirLeSolveur(false);
  // UNE ADRESSE DE RECORD S'OUVRE AU CHARGEMENT, ET PAS SEULEMENT AU RETOUR
  // ARRIERE. Ces deux pages-la se poussaient a l'historique -- c'est ce qui
  // fait un lien qu'on partage -- mais seul `popstate` les relisait : coller
  // l'adresse dans une barre d'adresse rendait le mur de salons. La partie
  // s'ouvre par sa REFERENCE (SPEC.md §23), qui ne designe qu'une manche.
  const ou = new URLSearchParams(location.search);
  if (ou.get("page") === "records") ouvrirLesRecords(false);
  if (ou.get("page") === "competitif") ouvrirLeCompetitif(false);
  if (ou.get("page") === "palmares") ouvrirLePalmares(false);
  if (ou.get("page") === "admin-competitif") ouvrirLAdministrationDuCompetitif(false);
  if (ou.get("page") === "tournoi" && ou.get("id") !== null) ouvrirLeTournoi(ou.get("id")!, false);
  if (ou.get("page") === "defi" && ou.get("id") !== null) ouvrirLeDefi(ou.get("id")!, false);
  if (ou.get("page") === "perso" && ou.get("joueur") !== null) ouvrirLaPagePerso(ou.get("joueur")!, false);
  if (ou.get("page") === "resultats") ouvrirLesResultatsDeLAdresse();
  if (ou.get("page") === "partie" && ou.get("partie") !== null) {
    void ouvrirLaPartie(ou.get("partie")!, Math.max(1, Number(ou.get("coup")) || 1),
      ou.get("source") === "competitif" ? "competitif"
        : ou.get("source") === "historique" ? "historique" : "records");
  }
  // Retour du lien de confirmation : on le dit, et on nettoie l'adresse pour
  // qu'un rafraichissement ne rejoue pas le message.
  const retourMail = new URLSearchParams(location.search).get("email");
  if (retourMail !== null) {
    $("c-error").textContent = retourMail === "ok"
      ? t("Votre mail est confirmé.") : retourMail;
    $("c-error").hidden = false;
    window.history.replaceState({}, "", location.pathname);
  }
  return peuplerSalons();
});

// UN LIEN QUI PORTE UN SALON MENE AU SALON. On s'y nomme sur place si l'on ne
// s'est jamais nomme -- c'est le seul moment ou le pseudo est demande.
if (salonChoisi !== "") allerA(salonChoisi);

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());

// ---------------------------------------------------------- LA PAGE DES RECORDS
//
// Voir SPEC.md §23. Une page, comme le profil et l'anagrammeur : elle partage
// le bandeau de l'accueil, prend toute la largeur, et porte son adresse --
// `?page=records` -- pour qu'on puisse y revenir et en ressortir par le bouton
// « precedent » du navigateur.
//
// ELLE NE LIT QUE LE JOURNAL DES RECORDS. Aucun de ses trois points d'entree
// n'ouvre un fichier de partie : une ligne reste lisible meme si la partie
// qu'elle designe a disparu du disque.

/** Une etape, telle que la ligne d'une montante la porte. */
interface EtapeDeLigne {
  rang: number;
  ref: string;
  categorie: string;
  coups: number;
  temps: number;
  negatif: number;
  topee: boolean;
  essai: number;
}

interface LigneDeRecord {
  rang: number;
  /**
   * LA REFERENCE DE LA MANCHE, et son identite (SPEC.md §23).
   *
   * C'est par elle qu'on la relit et qu'on la cite. Le nom du salon ne suffit
   * plus : deux parties enregistrees au meme endroit le partagent, et une
   * montante en joue six d'affilee.
   */
  ref: string;
  partie: string;
  at: number;
  categorie: string;
  grille: string;
  lexique: string;
  empreinte: string;
  chrono: number | null;
  coups: number;
  temps: number;
  cumul: number;
  farfouilles: number;
  topee: boolean;
  negatif: number;
  joueurs: { nom: string; tops: number; invite: boolean }[];
  solo: string | null;
  /** Les six etapes, sur une ligne de montante, et rien ailleurs. */
  etapes?: EtapeDeLigne[];
}

interface LigneDeCoup {
  rang: number; mot: string; score: number; partie: string;
  categorie: string; lexique: string; at: number; par: string | null;
}

interface LigneDeMot {
  rang: number; mot: string; fois: number; trouves: number; rates: number; part: number;
}

type VueDesRecords = "classement" | "annexes" | "mots";

let rcCategorie = "normale";
/** L'axe « Lettres » : combien de caramels au chevalet. */
let rcTaille: Taille = "normal";
let rcGrille: "normale" | "super" = "normale";
let rcLexique: string = LEXIQUE_TOUS;

/**
 * LE LEXIQUE SUR LEQUEL LA PAGE DES RECORDS S'OUVRE.
 *
 * Celui de la langue du COMPTE : un francophone ne veut pas commencer par
 * chercher son tableau, et un anglophone encore moins -- le francais serait
 * arrive le premier.
 *
 * « Tous » pour qui n'a pas de compte. La langue du site suffirait a deviner,
 * mais elle se devine justement : elle vient du navigateur, pas d'un choix. Un
 * visiteur voit donc les cent meilleurs temps du site, toutes langues
 * confondues, et choisit ensuite s'il veut restreindre.
 */
function lexiqueDesRecords(): string {
  const l = moiCompte?.langue;
  if (l === "fr" || l === "en") return DICO_PAR_LANGUE[l];
  return LEXIQUE_TOUS;
}
let rcSolo = false;
let rcVue: VueDesRecords = "classement";
let rcAnnexe = "chrono";
let rcSens: "rates" | "trouves" | "wuqi" = "rates";
/** `null` : toutes les longueurs confondues. */
let rcLongueur: number | null = null;
/** Ce qu'on attend en ce moment : une reponse en retard ne repeint pas. */
let rcDemande = 0;

function hslVersRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

/** La luminance relative de sRGB, celle dont se sert le calcul de contraste. */
function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

const couleursDejaVues = new Map<string, string>();

/**
 * La couleur d'un joueur, derivee de son nom.
 *
 * RIEN A ENREGISTRER, et le meme joueur garde la sienne d'un tableau a
 * l'autre, d'une partie a l'autre, sans que personne n'ait a la choisir.
 *
 * FNV-1a plutot qu'une somme : deux pseudos qui se ressemblent -- « Zulu » et
 * « Zulu2 », les plus frequents a une meme table -- tombaient sur des teintes
 * voisines, donc sur deux couleurs qu'on ne distinguait pas.
 *
 * LA CLARTE SE CALCULE, ELLE NE SE FIXE PAS. A clarte HSL egale, un jaune est
 * quatre fois plus lumineux qu'un bleu : la meme valeur donnait des jaunes
 * delaves qu'on ne lisait pas sur fond clair, et des bleus sourds qu'on ne
 * lisait pas sur fond de nuit. On cherche donc, par dichotomie, la clarte qui
 * amene CETTE teinte a la luminance voulue -- la meme pour toutes. Le contraste
 * avec le fond est alors le meme partout, et la saturation peut rester haute
 * sans que rien ne devienne illisible.
 */
function couleurDuJoueur(nom: string): string {
  const nuit = themeSombre();
  const cle = `${nuit ? "n" : "j"}|${nom}`;
  const deja = couleursDejaVues.get(cle);
  if (deja !== undefined) return deja;

  let h = 0x811c9dc5;
  for (let i = 0; i < nom.length; i++) {
    h = Math.imul(h ^ nom.charCodeAt(i), 0x01000193) >>> 0;
  }
  const teinte = h % 360;
  // 0,15 sur fond clair et 0,34 sur fond de nuit : environ cinq pour un de
  // contraste des deux cotes, ce qu'il faut pour lire un pseudo en petit.
  const cible = nuit ? 0.34 : 0.15;
  let bas = 0.06, haut = 0.94;
  for (let i = 0; i < 16; i++) {
    const m = (bas + haut) / 2;
    if (luminance(hslVersRgb(teinte, 0.82, m)) < cible) bas = m; else haut = m;
  }
  const [r, v, b] = hslVersRgb(teinte, 0.82, (bas + haut) / 2);
  const couleur = `rgb(${r}, ${v}, ${b})`;
  couleursDejaVues.set(cle, couleur);
  return couleur;
}

/** Un temps de partie, au centieme : une performance se mesure (SPEC.md §16). */
function tempsDeManche(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const reste = s - m * 60;
  return `${m} min ${reste < 10 ? "0" : ""}${reste.toFixed(2)} s`;
}

/** Le temps d'un coup : la meme precision, sans les minutes. */
const tempsParCoup = (ms: number, coups: number): string =>
  coups === 0 ? "—" : `${(ms / coups / 1000).toFixed(2)} s`;

function dateDeManche(at: number): string {
  return new Date(at).toLocaleDateString(langue() === "en" ? "en-GB" : "fr-FR",
    { day: "numeric", month: "short", year: "numeric" });
}

/** Le chrono d'une partie, ou « Infini » quand elle n'en avait pas. */
function chronoDeManche(c: number | null): string {
  if (c === null) return t("Infini");
  if (c % 60 === 0 && c >= 60) return `${c / 60} min`;
  return `${c} s`;
}

/**
 * Combien de pseudos une cellule montre avant de compter les autres.
 *
 * UNE PARTIE PEUT SE JOUER A AUTANT DE JOUEURS QU'ELLE A DE COUPS : c'est la
 * seule borne, et une 2 sur 2 en a compte cinquante-huit.
 *
 * DEUX LIMITES, ET C'EST LA PREMIERE ATTEINTE QUI COMPTE. Un nombre seul ne
 * suffit pas : cinq pseudos courts tiennent sur une ligne, cinq comme
 * « Pierre-Antoine » non. On compte donc aussi les CARACTERES -- la mention
 * « (invité) » comprise, qui en pese neuf -- et l'on s'arrete au premier des
 * deux plafonds. Le premier nom passe toujours, aussi long soit-il : une
 * cellule qui ne montrerait que « +1 » ne dirait rien.
 */
const NOMS_MONTRES = 5;
const CARACTERES_MONTRES = 40;

/**
 * Ce que ce nom occupe, en largeur de caractere ordinaire.
 *
 * La mention de l'invite compte pour sept et non pour ses neuf signes : elle
 * s'ecrit en plus petit. C'est elle qui coute le plus cher dans cette cellule
 * -- cinq invites ne tiennent pas sur une ligne, cinq comptes si.
 */
function placeDuNom(j: { nom: string; invite: boolean }): number {
  return j.nom.length + (j.invite ? 7 : 0);
}

/** Combien de noms tiennent sur la ligne, avant de compter les autres. */
function nomsQuiTiennent(joueurs: readonly { nom: string; invite: boolean }[]): number {
  let n = 0, place = 0;
  for (const j of joueurs) {
    if (n >= NOMS_MONTRES) break;
    place += placeDuNom(j);
    if (n > 0 && place > CARACTERES_MONTRES) break;
    n++;
  }
  return Math.max(1, n);
}

/** Un pseudo de sa couleur, cliquable : il mene a la fiche de son joueur. */
function pseudoCliquable(nom: string): HTMLButtonElement {
  const b = el("button", "rc-nom", nom) as HTMLButtonElement;
  b.type = "button";
  b.style.color = couleurDuJoueur(nom);
  b.addEventListener("click", (e) => { e.stopPropagation(); void ouvrirLaFiche(nom); });
  return b;
}

/**
 * LA TABLEE AU COMPLET, quand la cellule ne peut plus l'enumerer.
 *
 * L'infobulle contenait deja la liste entiere, mais une infobulle ne se lit ni
 * au doigt ni au clavier, ne defile pas, et ne mene nulle part. Ici chaque nom
 * ouvre sa fiche.
 */
function ouvrirLaTablee(joueurs: LigneDeRecord["joueurs"]): void {
  const liste = $("tablee-liste");
  liste.replaceChildren();
  for (const j of joueurs) {
    const ligne = el("button", "") as HTMLButtonElement;
    ligne.type = "button";
    const point = el("span", "pastille-couleur");
    point.style.background = couleurDuJoueur(j.nom);
    ligne.appendChild(point);
    const qui = el("span", "qui");
    const nom = el("span", "", j.nom);
    nom.style.color = couleurDuJoueur(j.nom);
    qui.appendChild(nom);
    if (j.invite) qui.appendChild(el("i", "", ` ${t("(invité)")}`));
    ligne.appendChild(qui);
    ligne.appendChild(el("span", "tops",
      t2(j.tops > 1 ? "{n} tops" : "{n} top", { n: j.tops })));
    ligne.addEventListener("click", () => {
      $("voile-tablee").hidden = true;
      void ouvrirLaFiche(j.nom);
    });
    liste.appendChild(ligne);
  }
  $("voile-tablee").hidden = false;
}

$("tablee-close").addEventListener("click", () => { $("voile-tablee").hidden = true; });
$("voile-tablee").addEventListener("click", (e) => {
  if (e.target === $("voile-tablee")) $("voile-tablee").hidden = true;
});

/**
 * La cellule des joueurs : chacun de sa couleur, l'invite dit comme tel.
 *
 * AU-DELA DE TROIS NOMS ON COMPTE AU LIEU D'ENUMERER, comme la feuille de
 * route le fait deja (SPEC.md §10). Le compte est un BOUTON : il ouvre la
 * tablee entiere, ou chaque nom mene a sa fiche. Une infobulle ne se lit ni au
 * doigt ni au clavier, et ne mene nulle part.
 */
function cellulesDesJoueurs(joueurs: LigneDeRecord["joueurs"]): HTMLElement {
  const boite = el("div", "rc-joueurs");
  if (joueurs.length === 0) {
    boite.appendChild(el("span", "rc-de-plus", "—"));
    return boite;
  }
  const tiennent = nomsQuiTiennent(joueurs);
  for (const j of joueurs.slice(0, tiennent)) {
    const un = el("span", "rc-joueur");
    const point = el("span", "pastille-couleur");
    point.style.background = couleurDuJoueur(j.nom);
    un.appendChild(point);
    un.appendChild(pseudoCliquable(j.nom));
    if (j.invite) un.appendChild(el("i", "", t("(invité)")));
    boite.appendChild(un);
  }
  if (joueurs.length > tiennent) {
    const plus = el("button", "rc-plus",
      `+${joueurs.length - tiennent}`) as HTMLButtonElement;
    plus.type = "button";
    plus.title = t("Voir tous les joueurs");
    plus.addEventListener("click", (e) => { e.stopPropagation(); ouvrirLaTablee(joueurs); });
    boite.appendChild(plus);
  }
  boite.title = joueurs
    .map((j) => `${j.nom}${j.invite ? ` ${t("(invité)")}` : ""} · ${j.tops}`)
    .join("\n");
  return boite;
}

/**
 * La cellule du rang : un jeton pour les trois premiers, un chiffre ensuite.
 *
 * LE JETON NE VAUT QUE POUR UN PODIUM DE JOUEURS. Un tableau de mots classe des
 * mots, pas des gens, et ses ex aequo sont nombreux : quatre disques d'or l'un
 * sous l'autre ne disent plus rien. Le bloc des negatifs non plus n'a pas de
 * podium -- c'est ce qui vient sous le podium.
 */
function celluleDuRang(rang: number, podium = true): HTMLElement {
  const td = el("td", "rang");
  if (podium && rang <= 3) {
    const j = el("span", `rc-jeton ${rang === 1 ? "or" : rang === 2 ? "argent" : "bronze"}`,
      String(rang));
    td.appendChild(j);
  } else {
    td.textContent = String(rang);
  }
  return td;
}

/**
 * L'entete d'un tableau. `tri` nomme la colonne QUI FAIT LE CLASSEMENT.
 *
 * Sans elle, un tableau annexe ne dit pas sur quoi il est trie : « la plus
 * chere » et « la plus courte » montrent les memes colonnes, et rien ne dit
 * laquelle decide de l'ordre.
 */
function tete(
  colonnes: { texte: string; classe?: string }[], tri = "",
): HTMLElement {
  const thead = el("thead");
  const tr = el("tr");
  for (const c of colonnes) {
    const th = el("th", c.classe ?? "", c.texte);
    if (tri !== "" && c.texte === tri) {
      th.classList.add("tri");
      th.appendChild(el("span", "rc-tri", "▾"));
    }
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  return thead;
}

function tableauVide(quoi: string): HTMLElement {
  return el("div", "rc-vide", quoi);
}

/**
 * Les deux outils de fin de ligne : la feuille de route, et le rejeu.
 *
 * LES DEUX OUVRENT LA MEME PAGE, a deux endroits differents : « FdR » la montre
 * finie, ce qu'on lit d'abord ; « Revoir » la reprend au premier coup.
 */
function outilsDeLigne(partie: string, retourEtapes: LigneDeRecord | null = null): HTMLElement[] {
  const feuille = el("button", "rc-outil", t("FdR")) as HTMLButtonElement;
  feuille.title = t("La feuille de route de cette partie");
  feuille.type = "button";
  feuille.addEventListener("click", (e) => {
    e.stopPropagation();
    void ouvrirLaFeuille(partie, retourEtapes);
  });
  const revoir = el("button", "rc-outil", t("Revoir")) as HTMLButtonElement;
  revoir.title = t("Revoir la partie, coup par coup");
  revoir.type = "button";
  revoir.addEventListener("click", (e) => {
    e.stopPropagation();
    // Le rejeu prend la page entiere : la fenetre ouverte par-dessus n'a plus
    // d'objet, et la laisser la ferait flotter au-dessus de la grille -- ce qui
    // vaut aussi pour « Les six parties » d'ou l'on a pu venir : on ne revient
    // pas dessus, on la quitte pour de bon.
    frRetourEtapes = null;
    fermerLaFeuille();
    void ouvrirLaPartie(partie);
  });
  return [feuille, revoir];
}

/** Le nom d'une categorie, tel que les onglets l'ecrivent. */
function nomDeCategorie(id: string): string {
  return t(CATEGORIES.find((c) => c.id === id)?.nom ?? id);
}

/**
 * LE BOUTON D'UNE MONTANTE : ses six etapes, et non une feuille de route.
 *
 * Une montante n'a pas un journal, elle en a six (SPEC.md §23) : « FdR » et
 * « Revoir » n'auraient rien a ouvrir. Le bouton ouvre donc la liste des
 * etapes, et chacune y porte ses deux outils a elle.
 */
let frRetourEtapes: LigneDeRecord | null = null;

function boutonDesEtapes(l: LigneDeRecord): HTMLElement {
  const b = el("button", "rc-outil", t("Parties")) as HTMLButtonElement;
  b.title = t("Les six parties de cette montante");
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    ouvrirLesEtapes(l);
  });
  return b;
}

/**
 * Les six etapes d'une montante, dans la fenetre de la feuille de route.
 *
 * ELLES VIENNENT DE LA LIGNE, et d'aucun fichier. C'est la regle du journal des
 * records : la ligne porte tout ce qui s'affiche, et un record reste lisible
 * meme si ses parties ont disparu du disque. Les deux outils de chaque etape,
 * eux, demandent bien son journal -- et le diront s'il n'y est plus.
 */
function ouvrirLesEtapes(l: LigneDeRecord): void {
  frPartie = null;
  frRetourEtapes = null;
  $("fr-titre").textContent = t("Les six parties");
  $("voile-route").hidden = false;
  const joueurs = l.joueurs
    .map((j) => j.invite ? `${j.nom} ${t("(invité)")}` : j.nom).join(", ");
  $("fr-detail").textContent = [
    nomDeCategorie(l.categorie),
    joueurs || t("personne"),
    tempsDeManche(l.temps),
    l.topee ? t("topée") : t2("négatif -{n}", { n: l.negatif }),
    dateDeManche(l.at),
  ].join(" · ");
  const table = el("table");
  table.appendChild(tete([
    { texte: t("Étape") }, { texte: t("Format"), classe: "g" },
    { texte: t("Coups") }, { texte: t("Temps") }, { texte: t("Négatif") },
    { texte: "", classe: "c" },
  ]));
  const corps = el("tbody");
  for (const e of l.etapes ?? []) {
    const tr = el("tr");
    tr.appendChild(el("td", "", String(e.rang)));
    const format = el("td", "g fort", nomDeCategorie(e.categorie));
    // L'ESSAI SE DIT QUAND IL Y EN A EU PLUSIEURS. Une etape reprise a coute du
    // temps a la montante, et c'est la seule trace qu'il en reste.
    if (e.essai > 1) format.appendChild(el("i", "pr-sien", ` (${t2("essai {n}", { n: e.essai })})`));
    tr.appendChild(format);
    tr.appendChild(el("td", "", String(e.coups)));
    tr.appendChild(el("td", "fort", tempsDeManche(e.temps)));
    tr.appendChild(el("td", e.topee ? "" : "fort", e.topee ? t("Top") : `-${e.negatif}`));
    const outils = el("td", "c");
    for (const b of outilsDeLigne(e.ref, l)) outils.appendChild(b);
    tr.appendChild(outils);
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  $("pr-route").replaceChildren(table);
}

/**
 * Une ligne de partie : les colonnes demandees, dans cet ordre.
 *
 * UN SEUL JEU DE COLONNES POUR LES DEUX BLOCS. La colonne du negatif ne parait
 * que si le tableau en compte au moins une, et vaut alors « — » sur les parties
 * topees -- leur negatif est nul par definition, et une colonne de zeros
 * n'apprend rien. Inserer une cellule dans les seules lignes du bas decalait
 * tout le reste sous une entete qui ne bougeait pas.
 */
function ligneDePartie(
  l: LigneDeRecord, opts: { negatif?: boolean; farfouilles?: boolean } = {},
): HTMLElement {
  const tr = el("tr");
  // A PARTIR DE DEUX JOUEURS, LA LIGNE ENTIERE OUVRE LA TABLEE. Un seul nom
  // n'a rien de plus a montrer ; des deux, la fenetre dit qui a trouve quoi.
  // Les elements cliquables de la ligne (pseudos, "+N", outils) arretent la
  // propagation de leur propre clic : voir `cellulesDesJoueurs` et
  // `outilsDeLigne`.
  if (l.joueurs.length >= 2) {
    tr.classList.add("rc-cliquable");
    tr.addEventListener("click", () => ouvrirLaTablee(l.joueurs));
  }
  tr.appendChild(celluleDuRang(l.rang, l.topee));

  const joueurs = el("td", "g");
  joueurs.appendChild(cellulesDesJoueurs(l.joueurs));
  tr.appendChild(joueurs);

  tr.appendChild(el("td", "fort", tempsDeManche(l.temps)));
  if (opts.negatif === true) {
    // LE NEGATIF EST NEGATIF. C'est un manque, pas un gain : une partie ou
    // l'on a laisse sept points au top affiche -7, et non +7.
    const neg = el("td", l.topee ? "" : "fort", l.topee ? t("Top") : `-${l.negatif}`);
    tr.appendChild(neg);
  }
  tr.appendChild(el("td", "", chronoDeManche(l.chrono)));
  tr.appendChild(el("td", "", String(l.coups)));
  tr.appendChild(el("td", "", tempsParCoup(l.temps, l.coups)));
  tr.appendChild(el("td", "", String(l.cumul)));
  if (opts.farfouilles === true) tr.appendChild(el("td", "", String(l.farfouilles)));
  tr.appendChild(el("td", "", dateDeManche(l.at)));

  const lex = el("td", "", nomCourtDuDico(l.lexique));
  lex.title = t2("Empreinte du lexique : {e}", { e: l.empreinte });
  tr.appendChild(lex);

  const outils = el("td", "c");
  // Une montante ouvre ses six etapes ; une partie, sa feuille de route.
  const boutons = l.etapes !== undefined && l.etapes.length > 0
    ? [boutonDesEtapes(l)] : outilsDeLigne(l.ref);
  for (const b of boutons) outils.appendChild(b);
  tr.appendChild(outils);
  return tr;
}

/** Le nom court d'un lexique, tel que les reglages l'ecrivent. */
function nomCourtDuDico(id: string): string {
  if (id === LEXIQUE_TOUS) return t("Tous");
  return tousLesDictionnaires().find((d) => d.id === id)?.nom ?? id;
}

function rendreLeClassement(d: { topees: LigneDeRecord[]; negatifs: LigneDeRecord[] }): void {
  const boite = $("rc-tableau");
  if (d.topees.length === 0 && d.negatifs.length === 0) {
    boite.replaceChildren(tableauVide(t("Aucune partie enregistrée dans cette catégorie.")));
    return;
  }
  const avecNegatif = d.negatifs.length > 0;
  const colonnes = [
    { texte: "#" }, { texte: t("Joueur(s)"), classe: "g" }, { texte: t("Temps") },
    ...(avecNegatif ? [{ texte: t("Négatif") }] : []),
    { texte: t("Chrono") }, { texte: t("Coups") }, { texte: t("Temps / coup") },
    { texte: t("Cumul") }, { texte: t("Date") }, { texte: t("Lexique") },
    { texte: "", classe: "c" },
  ];
  const table = el("table");
  // Le chevron suit CE QUI CLASSE, et non la colonne du temps : les deux
  // colonnes existent, et rien d'autre ne dirait laquelle decide.
  const surLeCoup = CATEGORIES.find((c) => c.id === rcCategorie)?.parCoup === true;
  table.appendChild(tete(colonnes, t(surLeCoup ? "Temps / coup" : "Temps")));
  const corps = el("tbody");
  for (const l of d.topees) corps.appendChild(ligneDePartie(l, { negatif: avecNegatif }));
  if (avecNegatif) {
    // LE BLOC DES NEGATIFS SE DISTINGUE DE CE QUI EST AU-DESSUS, sans quoi on
    // lirait un classement de vitesse la ou il n'y en a pas.
    const coupure = el("tr", "rc-coupure");
    const td = el("td", "", t("Parties non topées, du plus petit négatif")) as HTMLTableCellElement;
    td.colSpan = colonnes.length;
    coupure.appendChild(td);
    corps.appendChild(coupure);
    for (const l of d.negatifs) corps.appendChild(ligneDePartie(l, { negatif: true }));
  }
  table.appendChild(corps);
  boite.replaceChildren(table);
}

function rendreLesAnnexes(lignes: LigneDeRecord[]): void {
  const boite = $("rc-tableau");
  if (lignes.length === 0) {
    boite.replaceChildren(tableauVide(t("Aucune partie topée dans cette catégorie.")));
    return;
  }
  const triPar: Record<string, string> = {
    chrono: t("Chrono"), chere: t("Cumul"), pasChere: t("Cumul"),
    courte: t("Coups"), longue: t("Coups"),
    farfouilles: t("Farfouilles"), peuDeFarfouilles: t("Farfouilles"),
  };
  const table = el("table");
  table.appendChild(tete([
    { texte: "#" }, { texte: t("Joueur(s)"), classe: "g" }, { texte: t("Temps") },
    { texte: t("Chrono") }, { texte: t("Coups") }, { texte: t("Temps / coup") },
    { texte: t("Cumul") }, { texte: t("Farfouilles") }, { texte: t("Date") },
    { texte: t("Lexique") }, { texte: "", classe: "c" },
  ], triPar[rcAnnexe] ?? ""));
  const corps = el("tbody");
  for (const l of lignes) corps.appendChild(ligneDePartie(l, { farfouilles: true }));
  table.appendChild(corps);
  boite.replaceChildren(table);
}

function rendreLesCoups(coups: LigneDeCoup[]): void {
  const boite = $("rc-tableau");
  if (coups.length === 0) {
    boite.replaceChildren(tableauVide(t("Aucun coup enregistré dans cette catégorie.")));
    return;
  }
  const table = el("table");
  table.appendChild(tete([
    { texte: "#" }, { texte: t("Mot"), classe: "g" }, { texte: t("Points") },
    { texte: t("Trouvé par"), classe: "g" }, { texte: t("Date") }, { texte: t("Lexique") },
  ], t("Points")));
  const corps = el("tbody");
  for (const c of coups) {
    const tr = el("tr");
    tr.appendChild(celluleDuRang(c.rang));
    tr.appendChild(el("td", "g fort", c.mot));
    tr.appendChild(el("td", "fort", String(c.score)));
    const par = el("td", "g");
    if (c.par === null) par.appendChild(el("span", "rc-de-plus", t("non trouvé")));
    else par.appendChild(cellulesDesJoueurs([{ nom: c.par, tops: 1, invite: false }]));
    tr.appendChild(par);
    tr.appendChild(el("td", "", dateDeManche(c.at)));
    tr.appendChild(el("td", "", nomCourtDuDico(c.lexique)));
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  boite.replaceChildren(table);
}

function rendreLesMots(lignes: LigneDeMot[]): void {
  const boite = $("rc-tableau");
  if (lignes.length === 0) {
    boite.replaceChildren(tableauVide(t("Aucun mot compté pour l'instant.")));
    return;
  }
  const table = el("table");
  table.appendChild(tete([
    { texte: "#" }, { texte: t("Mot"), classe: "g" }, { texte: t("Sorti en top") },
    { texte: t("Trouvé") }, { texte: t("Raté") }, { texte: t("Part trouvée") },
  ], rcSens === "trouves" ? t("Trouvé") : t("Raté")));
  const corps = el("tbody");
  for (const l of lignes) {
    const tr = el("tr");
    tr.appendChild(celluleDuRang(l.rang, false));
    tr.appendChild(el("td", "g fort", l.mot));
    tr.appendChild(el("td", "", String(l.fois)));
    tr.appendChild(el("td", "", String(l.trouves)));
    tr.appendChild(el("td", "fort", String(l.rates)));
    tr.appendChild(el("td", "", `${l.part} %`));
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  boite.replaceChildren(table);
}

/** Va chercher ce que la vue courante demande, et le peint. */
async function chargerLesRecords(): Promise<void> {
  const mien = ++rcDemande;
  $("rc-tableau").replaceChildren(tableauVide(t("chargement…")));
  const base = `categorie=${encodeURIComponent(rcCategorie)}`
    + `&grille=${rcGrille}&lexique=${encodeURIComponent(rcLexique)}`;
  let url: string;
  if (rcVue === "mots") {
    url = `/api/records/mots?lexique=${encodeURIComponent(rcLexique)}&sens=${rcSens}`
      + (rcLongueur === null || rcSens === "wuqi" ? "" : `&longueur=${rcLongueur}`);
  } else if (rcVue === "annexes") {
    url = `/api/records/annexe?${base}&quoi=${rcAnnexe}`;
  } else {
    url = `/api/records?${base}${rcSolo ? "&solo=1" : ""}`;
  }
  let data: any;
  try {
    const r = await fetch(url);
    data = await r.json();
    if (!r.ok) {
      if (mien !== rcDemande) return;
      // Un serveur qui ne connait pas encore cette categorie repond ici. Le
      // dire vaut mieux qu'un tableau vide, qui ferait chercher la partie
      // manquante du mauvais cote.
      $("rc-tableau").replaceChildren(tableauVide(
        typeof data?.message === "string" ? data.message : t("serveur injoignable")));
      return;
    }
  } catch {
    if (mien !== rcDemande) return;
    $("rc-tableau").replaceChildren(tableauVide(t("serveur injoignable")));
    return;
  }
  // Une reponse en retard ne repeint pas : on a change d'onglet entre-temps.
  if (mien !== rcDemande) return;
  if (rcVue === "mots") {
    if (rcSens === "wuqi") rendreWuQi(data.wuqi ?? []);
    else rendreLesMots(data.lignes ?? []);
  }
  else if (rcVue === "annexes") {
    if (data.coups !== undefined) rendreLesCoups(data.coups);
    else rendreLesAnnexes(data.lignes ?? []);
  } else rendreLeClassement({ topees: data.topees ?? [], negatifs: data.negatifs ?? [] });
}

/**
 * WU et QI : le pari d'avant-partie, tenu a jour. Voir SPEC.md §13 et §23.
 *
 * On compte le TOP POSE, exactement `WU` ou `QI` -- ni `WUS`, ni `QIS`, ni les
 * collantes formees a cote d'un autre mot. « Trouvé » est ce que le compteur
 * regarde : un top que personne n'a vu n'a ete joue par personne.
 */
function rendreWuQi(lignes: { mot: string; sorti: number; trouve: number }[]): void {
  const boite = $("rc-tableau");
  const total = lignes.reduce((a, l) => a + l.trouve, 0);
  if (total === 0) {
    boite.replaceChildren(tableauVide(t("Ni WU ni QI n'ont encore été joués.")));
    return;
  }
  const table = el("table");
  table.appendChild(tete([
    { texte: "#" }, { texte: t("Mot"), classe: "g" },
    { texte: t("Trouvé") }, { texte: t("Sorti en top") }, { texte: t("Part trouvée") },
  ], t("Trouvé")));
  const corps = el("tbody");
  lignes.forEach((l, i) => {
    const tr = el("tr");
    tr.appendChild(celluleDuRang(i + 1, false));
    tr.appendChild(el("td", "g fort", l.mot));
    tr.appendChild(el("td", "fort", String(l.trouve)));
    tr.appendChild(el("td", "", String(l.sorti)));
    tr.appendChild(el("td", "",
      l.sorti === 0 ? "—" : `${Math.round((l.trouve / l.sorti) * 1000) / 10} %`));
    corps.appendChild(tr);
  });
  table.appendChild(corps);
  boite.replaceChildren(table);
}

/**
 * Les onglets de categorie, pour la taille de chevalet choisie.
 *
 * ILS VIENNENT SOUS LES PARAMETRES, et non au-dessus : c'est « Lettres » qui
 * decide de leur liste, et ce qui commande se lit avant ce qui est commande.
 */
function peindreLesCategories(): void {
  const boite = $("rc-categories");
  boite.replaceChildren();
  for (const c of CATEGORIES.filter((x) => x.taille === rcTaille)) {
    const b = el("button", "", t(c.nom)) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(c.id === rcCategorie));
    b.addEventListener("click", () => {
      rcCategorie = c.id;
      peindreLesCategories();
      void chargerLesRecords();
    });
    boite.appendChild(b);
  }
}

/** Les trois tailles de chevalet, et la categorie qui s'affiche avec. */
function peindreLesTailles(): void {
  const boite = $("rc-taille");
  boite.replaceChildren();
  for (const taille of TAILLES) {
    const b = el("button", "", t(taille.nom)) as HTMLButtonElement;
    b.type = "button";
    b.dataset["v"] = taille.id;
    b.setAttribute("aria-pressed", String(taille.id === rcTaille));
    b.addEventListener("click", () => {
      if (taille.id === rcTaille) return;
      rcTaille = taille.id;
      // La categorie choisie n'existe pas dans la nouvelle taille : on prend la
      // premiere, plutot que de montrer un tableau que rien ne selectionne.
      const premiere = CATEGORIES.find((c) => c.taille === rcTaille);
      if (premiere !== undefined) rcCategorie = premiere.id;
      peindreLesTailles();
      peindreLesCategories();
      void chargerLesRecords();
    });
    boite.appendChild(b);
  }
}

/** Pose l'etat presse sur un groupe de boutons a valeur. */
function presser(id: string, valeur: string): void {
  for (const b of $(id).querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === valeur));
  }
}

function peindreLesDeclinaisons(): void {
  presser("rc-grille", rcGrille);
  presser("rc-solo", rcSolo ? "solo" : "tous");
  presser("rc-annexe", rcAnnexe);
  presser("rc-sens", rcSens);
  presser("rc-longueur", rcLongueur === null ? "toutes" : String(rcLongueur));
  presser("rc-vues", rcVue);
  $("rc-annexes").hidden = rcVue !== "annexes";
  $("rc-mots").hidden = rcVue !== "mots";
  // WU et QI ne se filtrent pas par longueur : ils font deux lettres, tous les
  // deux, et c'est tout le sujet.
  $("rc-longueur-bloc").hidden = rcSens === "wuqi";
  // LES MOTS NE DEPENDENT NI DE LA CATEGORIE, NI DE LA GRILLE, NI DU CHEVALET :
  // ce sont les memes mots partout, et seul le lexique les distingue. Ce qui ne
  // change rien a ce qu'on lit ne doit pas rester affiche a cote.
  const surLesMots = rcVue === "mots";
  $("rc-categories").hidden = surLesMots;
  for (const id of ["rc-grille", "rc-taille", "rc-solo"]) {
    ($(id).parentElement as HTMLElement).hidden = surLesMots;
  }
}

/** Les lexiques, en puces : quatre, et l'on veut les voir tous d'un coup. */
function peindreLesLexiques(): void {
  const boite = $("rc-lexique");
  boite.replaceChildren();
  const choisir = (id: string): void => {
    rcLexique = id;
    peindreLesLexiques();
    void chargerLesRecords();
  };
  for (const d of tousLesDictionnaires()) {
    const b = el("button", "", d.nom) as HTMLButtonElement;
    b.type = "button";
    b.dataset["v"] = d.id;
    b.title = d.detail;
    b.setAttribute("aria-pressed", String(d.id === rcLexique));
    b.addEventListener("click", () => choisir(d.id));
    boite.appendChild(b);
  }
  // TOUS LES LEXIQUES CONFONDUS, EN DERNIER. Ce n'est pas un lexique -- on ne
  // joue pas avec, une partie se joue avec UNE liste de mots -- et le mettre en
  // tete le faisait passer pour le premier de la rangee. Il vient donc apres les
  // vraies listes, comme ce qu'il est : la table ou elles se rejoignent
  // (SPEC.md §23).
  const tous = el("button", "", t("Tous")) as HTMLButtonElement;
  tous.type = "button";
  tous.dataset["v"] = LEXIQUE_TOUS;
  tous.title = t("Toutes les listes de mots, à la même table");
  tous.setAttribute("aria-pressed", String(rcLexique === LEXIQUE_TOUS));
  tous.addEventListener("click", () => choisir(LEXIQUE_TOUS));
  boite.appendChild(tous);
}

/** Les longueurs de mots : toutes, puis deux a quinze lettres. */
function peindreLesLongueurs(): void {
  const boite = $("rc-longueur");
  if (boite.childElementCount > 0) return;
  const faire = (valeur: string, texte: string): void => {
    const b = el("button", "", texte) as HTMLButtonElement;
    b.type = "button";
    b.dataset["v"] = valeur;
    b.addEventListener("click", () => {
      rcLongueur = valeur === "toutes" ? null : Number(valeur);
      peindreLesDeclinaisons();
      void chargerLesRecords();
    });
    boite.appendChild(b);
  };
  faire("toutes", t("Toutes"));
  for (let n = 2; n <= 15; n++) faire(String(n), String(n));
}

/**
 * Les records : une page hors partie, publique, sans compte a demander.
 *
 * Joignable depuis le bandeau, en partie comme a l'accueil -- mais la partie
 * n'est pas quittee pour autant : le bouton du bandeau n'existe qu'a
 * l'accueil, ou il n'y a rien a interrompre.
 */
function ouvrirLesRecords(pousser = true): void {
  $("corps-partie").hidden = true;
  $("corps-competitif").hidden = true;
  $("corps-admin").hidden = true;
  $("corps-tournoi").hidden = true;
  $("corps-palmares").hidden = true;
  $("corps-perso").hidden = true;
  $("corps-defi").hidden = true;
  $("corps-resultats").hidden = true;
  $("corps-salons").hidden = true;
  $("corps-profil").hidden = true;
  $("corps-solveur").hidden = true;
  $("corps-records").hidden = false;
  $("join").hidden = false;
  // LE LEXIQUE SE REPOSE A CHAQUE OUVERTURE : le compte a pu se connecter, ou
  // changer de langue, depuis la derniere fois.
  rcLexique = lexiqueDesRecords();
  peindreLesTailles();
  peindreLesCategories();
  peindreLesLexiques();
  peindreLesLongueurs();
  peindreLesDeclinaisons();
  void chargerLesRecords();
  if (pousser) window.history.pushState({ page: "records" }, "", "?page=records");
}

/**
 * LA PAGE SE VIDE ET SE REMET A ZERO EN LA QUITTANT.
 *
 * Deux raisons, et elles vont ensemble. La table de cent lignes continuerait de
 * peser sur le document une fois masquee, comme la liste de l'anagrammeur. Et
 * la retrouver telle qu'on l'avait laissee -- sur un tableau annexe d'un format
 * a douze lettres en anglais -- oblige a se rappeler ce qu'on y avait mis. Elle
 * rouvre donc toujours au meme endroit : partie normale, grille normale,
 * chevalet normal, tous les joueurs.
 */
function fermerLesRecords(pousser = true): void {
  $("corps-records").hidden = true;
  $("corps-salons").hidden = false;
  $("rc-tableau").replaceChildren();
  rcCategorie = "normale";
  rcTaille = "normal";
  rcGrille = "normale";
  rcLexique = lexiqueDesRecords();
  rcSolo = false;
  rcVue = "classement";
  rcAnnexe = "chrono";
  rcSens = "rates";
  rcLongueur = null;
  if (pousser) window.history.pushState({ page: "salons" }, "", location.pathname);
}

for (const [id, poser] of [
  ["rc-grille", (v: string) => { rcGrille = v === "super" ? "super" : "normale"; }],
  ["rc-solo", (v: string) => { rcSolo = v === "solo"; }],
  ["rc-annexe", (v: string) => { rcAnnexe = v; }],
  ["rc-sens", (v: string) => { rcSens = v as typeof rcSens; }],
  ["rc-vues", (v: string) => { rcVue = v as VueDesRecords; }],
] as [string, (v: string) => void][]) {
  $(id).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (b === null || b.dataset["v"] === undefined) return;
    poser(b.dataset["v"]);
    peindreLesDeclinaisons();
    void chargerLesRecords();
  });
}

$("rc-regles").addEventListener("click", () => { $("voile-regles").hidden = false; });

// ------------------------------------------------ UNE PARTIE ARCHIVEE, RELUE
//
// Voir SPEC.md §23. « FdR » et « Revoir » ouvrent cette page.
//
// CE N'EST PAS LE REJEU DU SALON, et c'est deliberé. Celui-la est soude au
// direct : il lui faut un salon ouvert, un fil de calcul et une liaison, et il
// va chercher les paliers de chaque coup au serveur. Une partie citee par un
// record est un fichier inerte, que plus aucun salon ne tient.
//
// Ce qu'on vient y chercher tient en deux choses : la grille telle qu'elle
// s'est remplie, et la feuille de route. Les deux sont ici, dessinees a part,
// sans toucher a une seule variable de la partie en cours.

interface CoupRelu {
  n: number;
  rack: string;
  notation: string;
  word: string;
  dir: "H" | "V";
  x: number;
  y: number;
  score: number;
  player: string | null;
  ms: number;
  placements: { x: number; y: number; letter: string; blank?: boolean }[];
  playerWord?: string;
  playerDir?: "H" | "V";
  playerX?: number;
  playerY?: number;
  trouveurs?: string[];
}

interface PartieRelue {
  partie: string;
  /** Le titre de la page, quand la partie n'est pas une manche de records. */
  titre?: string;
  /** D'ou elle vient : le nom d'un tournoi, ou le jour d'une partie du jour. */
  dou?: string;
  layout: string;
  createdAt: number;
  config: ConfigSerialisee;
  fin: string | null;
  coups: CoupRelu[];
  manche: {
    /** La reference de la manche : c'est elle qui la designe partout. */
    ref: string;
    categorie: string; grille: string; lexique: string; chrono: number | null;
    at: number; temps: number; cumul: number; topee: boolean; negatif: number;
    joueurs: { nom: string; tops: number; invite: boolean }[]; solo: string | null;
  };
}

let prPartie: PartieRelue | null = null;
/** Le coup qu'on regarde, de 0 (grille vide) au dernier. */
let prVu = 0;
/**
 * LA PARTIE DONT LA FEUILLE DE ROUTE EST OUVERTE EN FENETRE.
 *
 * Elle est a part de `prPartie` : la feuille s'ouvre par-dessus la page des
 * records, sans y toucher, et les deux peuvent porter sur deux parties
 * differentes -- on lit une feuille, on la ferme, on en rejoue une autre.
 */
let frPartie: PartieRelue | null = null;

/** Le pavage de la partie relue, retrouve par son nom. */
function prPavage(): LayoutFn {
  const nom = prPartie?.config.pavageNom ?? "classique15";
  return (LAYOUTS as Record<string, LayoutFn>)[nom] ?? LAYOUTS.classique15;
}

/**
 * Peint la grille telle qu'elle etait apres le coup `prVu`.
 *
 * UN RENDU A PART, ET VOLONTAIREMENT SIMPLE. Le canevas de la partie sait
 * faire bien plus -- panoramique, zoom, curseur, apercu, fantomes -- et il lit
 * une douzaine de variables du direct. Le reprendre ici, c'est risquer de
 * casser ce sur quoi Zulu joue. Celui-ci ne sait qu'une chose : dessiner un
 * plateau borne et des caramels dessus.
 */
function prDessiner(): void {
  const cv = $<HTMLCanvasElement>("pr-grille");
  const g = cv.getContext("2d");
  if (g === null || prPartie === null) return;
  const bornes = prPartie.config.bornes ?? 7;
  const cotes = bornes * 2 + 1;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const taille = cv.getBoundingClientRect().width || 560;
  cv.width = Math.round(taille * dpr);
  cv.height = Math.round(taille * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = taille / cotes;

  const C = {
    field: css("--field"), line: css("--field-line"),
    face: css("--tile-face"), edge: css("--tile-edge"), ink: css("--tile-ink"),
    jface: css("--joker-face"), jedge: css("--joker-edge"),
    accent: css("--accent"),
    T: css("--mct"), D: css("--mcd"), t: css("--lct"), d: css("--lcd"),
    Q: css("--mcq"), q: css("--lcq"),
  };
  g.fillStyle = C.field;
  g.fillRect(0, 0, taille, taille);

  /**
   * LES CASES SE JOIGNENT, AU PIXEL D'ECRAN.
   *
   * Elles etaient peintes a `c - 1`, ce qui laissait un pixel de fond a droite
   * et en bas de CHACUNE : entre une case coloree et un caramel, ce pixel clair
   * se voyait comme un trou dans la grille. Le quadrillage suffit a separer les
   * cases, et il se trace par-dessus.
   *
   * Et le cote d'une case ne tombe presque jamais sur un pixel entier -- 560
   * divise par quinze fait 37,33 -- si bien que chaque bord se partageait entre
   * deux pixels. Les bornes s'arrondissent donc au pixel d'ecran, comme sur la
   * grille du salon (§9).
   */
  const bord = (i: number): number => Math.round(i * c * dpr) / dpr;

  const pavage = prPavage();
  for (let i = 0; i < cotes; i++) {
    for (let j = 0; j < cotes; j++) {
      const cle = pavage(i - bornes, j - bornes);
      const teinte = (C as Record<string, string>)[cle];
      g.fillStyle = teinte ?? C.field;
      g.fillRect(bord(i), bord(j), bord(i + 1) - bord(i), bord(j + 1) - bord(j));
    }
  }
  g.strokeStyle = C.line;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i <= cotes; i++) {
    const q = bord(i) + .5;
    g.moveTo(q, 0); g.lineTo(q, taille);
    g.moveTo(0, q); g.lineTo(taille, q);
  }
  g.stroke();

  // Les caramels, jusqu'au coup regarde. Ceux du coup lui-meme se cernent :
  // c'est la seule chose qu'on cherche en avancant d'un coup.
  const valeurs = prPartie.config.valeurs ?? {};
  const dernier = prVu > 0 ? prPartie.coups[prVu - 1] : undefined;
  const neufs = new Set((dernier?.placements ?? []).map((p) => `${p.x},${p.y}`));
  // UNE SOLUTION REGARDEE REMPLACE LE COUP JOUE, elle ne s'y ajoute pas : les
  // deux mots poses ensemble sur la meme grille ne se lisent pas. Recliquer la
  // ligne rend le top a sa place.
  const remplace = prLignes[prChoisie] !== undefined;
  // Ce qui est pose, pour que deux caramels colles ne tracent pas deux traits
  // le long de leur bord commun. Voir `cheminDuCaramel`.
  const poses = new Set<string>();
  const jusqua = remplace ? prVu - 1 : prVu;
  for (let k = 0; k < jusqua; k++) {
    for (const p of prPartie.coups[k]?.placements ?? []) poses.add(`${p.x},${p.y}`);
  }
  for (let k = 0; k < jusqua; k++) {
    for (const p of prPartie.coups[k]?.placements ?? []) {
      const i = p.x + bornes, j = p.y + bornes;
      if (i < 0 || j < 0 || i >= cotes || j >= cotes) continue;
      // LE CARAMEL COUVRE SA CASE EXACTEMENT, aux memes bornes que la case
      // elle-meme : c'est ce qui garantit qu'aucun pixel de fond ne subsiste
      // entre les deux.
      const px = bord(i), py = bord(j);
      const w = bord(i + 1) - px, h = bord(j + 1) - py;
      const joker = p.blank === true;
      const neuf = neufs.has(`${p.x},${p.y}`);
      g.fillStyle = joker ? C.jface : C.face;
      g.fillRect(px, py, w, h);
      g.strokeStyle = neuf ? C.accent : (joker ? C.jedge : C.edge);
      g.lineWidth = neuf ? 2 : 1;
      g.beginPath();
      // LE CERNE DU COUP QU'ON EXAMINE EST CENTRE SUR LA LIMITE, et non rentre
      // d'un cote : un trait de deux pixels pose comme celui d'un pixel
      // deborderait chez le voisin de droite sans deborder chez celui de
      // gauche, et son cadre paraitrait decale d'un pixel. Centre, il mord
      // d'un pixel des quatre cotes. C'est le seul marqueur de ce coup ici --
      // la lettre garde son encre ordinaire -- donc il reste epais.
      cheminDuCaramel(g, px, py, w, h, 0,
        cotesDe(poses, p.x, p.y), neuf ? 0 : 0.5);
      g.stroke();
      g.fillStyle = C.ink;
      g.font = `600 ${Math.round(c * 0.5)}px Archivo, system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(p.letter, px + w / 2, py + h / 2 - h * 0.02);
      // La valeur du caramel, en petit et DANS le caramel : elle debordait.
      const v = joker ? 0 : (valeurs[p.letter] ?? 0);
      g.font = `500 ${Math.round(c * 0.24)}px "IBM Plex Mono", monospace`;
      g.textAlign = "right";
      g.textBaseline = "alphabetic";
      g.fillText(String(v), px + w - w * 0.12, py + h - h * 0.12);
    }
  }

  // ------------------------------------------------ LA SOLUTION QU'ON REGARDE
  //
  // CLIQUER UNE SOUS-SOLUTION LA POSE SUR LA GRILLE, comme dans le rejeu d'un
  // salon : une liste de mots sans la voir tombe ne dit pas ou elle se pose, et
  // c'est justement ce qu'on vient chercher. Les caramels deja la gardent leur
  // encre ; seuls ceux que la solution AJOUTE se peignent en fantome.
  const vue = prLignes[prChoisie];
  if (vue !== undefined) {
    const { dx, dy } = step(vue.dir);
    for (let k = 0; k < vue.mot.length; k++) {
      const x = vue.x + dx * k, y = vue.y + dy * k;
      if (poses.has(`${x},${y}`)) continue;
      const i = x + bornes, j = y + bornes;
      if (i < 0 || j < 0 || i >= cotes || j >= cotes) continue;
      const px = bord(i), py = bord(j);
      const w = bord(i + 1) - px, h = bord(j + 1) - py;
      g.fillStyle = C.field;
      g.fillRect(px, py, w, h);
      g.globalAlpha = 0.9;
      g.fillStyle = C.face;
      g.fillRect(px, py, w, h);
      g.globalAlpha = 1;
      g.strokeStyle = C.accent;
      g.lineWidth = 1.5;
      g.strokeRect(px + 0.75, py + 0.75, w - 1.5, h - 1.5);
      g.fillStyle = C.accent;
      g.font = `600 ${Math.round(c * 0.5)}px Archivo, system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(vue.mot[k]!, px + w / 2, py + h / 2 - h * 0.02);
    }
  }
}


/**
 * LES SOLUTIONS DU COUP REGARDE, et celle qu'on a choisie dans la liste.
 * `prChoisie` est un rang dans `prLignes`, ou -1 quand on ne regarde rien.
 */
let prLignes: { mot: string; dir: Dir; x: number; y: number; score: number }[] = [];
let prChoisie = -1;

$("pr-sols").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest(".sol") as HTMLElement | null;
  if (b === null) return;
  const i = Number(b.dataset["i"]);
  // Recliquer la ligne qu'on regarde rend la grille a la partie seule.
  prChoisie = i === prChoisie ? -1 : i;
  prMarquerLaChoisie();
  prDessiner();
});

/** Souligne la ligne choisie dans la liste, sans repeindre toute la piste. */
function prMarquerLaChoisie(): void {
  for (const b of $("pr-piste").querySelectorAll(".sol")) {
    b.classList.toggle("choisie", Number((b as HTMLElement).dataset["i"]) === prChoisie);
  }
}

/** Le coup regarde, en une ligne sous la grille. */
function prPeindreLeCoup(): void {
  const boite = $("pr-coup");
  boite.replaceChildren();
  if (prPartie === null) return;
  if (prVu === 0) {
    boite.appendChild(el("span", "pr-rien", t("Grille vide, avant le premier coup.")));
    return;
  }
  const m = prPartie.coups[prVu - 1];
  if (m === undefined) return;
  const ligne = el("div");
  ligne.appendChild(el("span", "", `${t("Coup")} ${m.n} · `));
  const tirage = el("b", "", m.notation || m.rack);
  ligne.appendChild(tirage);
  ligne.appendChild(el("span", "", " · "));
  const mot = el("b", "", m.word);
  mot.style.color = m.player === null ? "" : couleurDuJoueur(m.player);
  ligne.appendChild(mot);
  if (m.playerWord !== undefined && m.playerWord !== m.word) {
    ligne.appendChild(el("i", "pr-sien", ` (${m.playerWord})`));
  }
  ligne.appendChild(el("span", "pr-pts", ` ${m.score}`));
  boite.appendChild(ligne);

  const qui = el("div");
  if (m.player === null) {
    qui.appendChild(el("span", "pr-rien", t("Personne n'a trouvé ce top.")));
  } else {
    qui.appendChild(el("span", "", `${t("Trouvé par")} `));
    const nom = el("b", "", m.player);
    nom.style.color = couleurDuJoueur(m.player);
    qui.appendChild(nom);
    if (m.ms > 0) qui.appendChild(el("span", "", ` ${t("en")} ${(m.ms / 1000).toFixed(2)} s`));
  }
  boite.appendChild(qui);
}

/** La feuille de route de la partie relue : un coup par ligne. */
function prPeindreLaRoute(): void {
  const boite = $("pr-route");
  const partie = frPartie;
  if (partie === null) { boite.replaceChildren(); return; }
  const table = el("table");
  const thead = el("thead");
  const tr = el("tr");
  for (const [texte, classe] of [
    ["#", ""], [t("Tirage"), "g"], [t("Top"), "g"], [t("Référence"), "g"],
    [t("Points"), ""], [t("Temps"), ""], [t("Trouvé par"), "g"],
  ] as [string, string][]) tr.appendChild(el("th", classe, texte));
  thead.appendChild(tr);
  table.appendChild(thead);

  const corps = el("tbody");
  partie.coups.forEach((m, i) => {
    const l = el("tr");
    l.appendChild(el("td", "", String(m.n)));
    l.appendChild(el("td", "g", m.notation || m.rack));
    // LE MOT REELLEMENT POSE SE LIT A COTE DU MOT RETENU. Le logiciel tire au
    // sort parmi les isotops (SPEC.md §5) : un joueur qui a trouve WUS lisait
    // WU a une case ou il n'a rien joue. Les deux figurent donc, le retenu
    // d'abord et le sien entre parentheses.
    const mot = el("td", "g pr-mot", m.word);
    // LE TOP PORTE LA COULEUR DE CELUI QUI L'A TROUVE, comme son nom au bout de
    // la ligne : l'oeil relie les deux sans traverser le tableau.
    if (m.player !== null) mot.style.color = couleurDuJoueur(m.player);
    if (m.playerWord !== undefined && m.playerWord !== m.word) {
      mot.appendChild(el("i", "pr-sien", ` (${m.playerWord})`));
    }
    l.appendChild(mot);
    const bornes = partie.config.bornes ?? null;
    const ref = el("td", "g", noteCoup(m.dir, m.x, m.y, bornes));
    if (m.playerDir !== undefined && m.playerX !== undefined && m.playerY !== undefined
        && (m.playerDir !== m.dir || m.playerX !== m.x || m.playerY !== m.y)) {
      ref.appendChild(el("i", "pr-sien",
        ` (${noteCoup(m.playerDir, m.playerX, m.playerY, bornes)})`));
    }
    l.appendChild(ref);
    l.appendChild(el("td", "", String(m.score)));
    l.appendChild(el("td", "", m.player === null ? "—" : `${(m.ms / 1000).toFixed(2)} s`));
    const par = el("td", "g");
    if (m.player === null) par.appendChild(el("span", "pr-non", t("non trouvé")));
    else {
      const nom = el("span", "", m.player);
      nom.style.color = couleurDuJoueur(m.player);
      par.appendChild(nom);
    }
    l.appendChild(par);
    // CLIQUER UNE LIGNE OUVRE CE COUP DANS « REVOIR ». La feuille n'a pas de
    // grille a cote d'elle : ce qu'on veut en cliquant un coup, c'est le voir.
    l.addEventListener("click", () => {
      // LA REFERENCE, ET NON LE NOM DU SALON : c'est elle qui designe la manche
      // dans une adresse, et deux parties du meme salon la partageaient.
      const id = partie.manche.ref;
      fermerLaFeuille();
      void ouvrirLaPartie(id, i + 1);
    });
    corps.appendChild(l);
  });
  table.appendChild(corps);
  boite.replaceChildren(table);
}

/**
 * Les solutions du coup regarde : le top et ses isotops, puis les sous-tops.
 *
 * ELLES VIENNENT DU SERVEUR, comme dans le rejeu d'un salon. Le navigateur ne
 * sait pas chercher tous les coups d'une position : son lexique sert a valider
 * un mot tape et a l'anagrammeur, pas a balayer la grille. Le serveur, lui, a
 * le GADDAG et un fil pour s'en servir.
 */
const prPaliers = new Map<number, PalierRelu[]>();
/** Ce qu'on attend : une reponse en retard ne repeint pas. */
let prAttente = 0;

interface PalierRelu { score: number; moves: [string, string, number, number][] }

function prPeindreLesPaliers(n: number, paliers: PalierRelu[] | null): void {
  const piste = $("pr-piste");
  const compte = $("pr-sols-compte");
  piste.style.height = "";
  prLignes = [];
  prChoisie = -1;
  if (n === 0 || paliers !== null && paliers.length === 0) {
    piste.replaceChildren(el("div", "pr-attente",
      n === 0 ? t("Aucun coup joué.") : t("Aucune solution trouvée.")));
    compte.textContent = "";
    return;
  }
  if (paliers === null) {
    piste.replaceChildren(el("div", "pr-attente", t("recherche des solutions…")));
    compte.textContent = "";
    return;
  }

  // A PLAT ET PAR POINTS DECROISSANTS, comme dans le rejeu d'un salon : les
  // paliers ne sont qu'une facon de grouper, et de gros pavés se lisent moins
  // bien qu'une liste continue. Le top et ses isotops sont en gras.
  const joue = prPartie?.coups[n - 1];
  const bornes = prPartie?.config.bornes ?? null;
  const meilleur = paliers[0]?.score ?? 0;
  const lignes: { mot: string; dir: "H" | "V"; x: number; y: number; score: number }[] = [];
  for (const p of paliers) {
    for (const [mot, dir, x, y] of p.moves) {
      lignes.push({ mot, dir: dir as "H" | "V", x, y, score: p.score });
    }
  }

  const H = 26;
  piste.style.height = `${lignes.length * H}px`;
  piste.replaceChildren();
  // LA GRILLE OUBLIE CE QU'ON REGARDAIT quand on change de coup : la solution
  // choisie appartenait a l'autre tirage.
  prLignes = lignes;
  prChoisie = -1;
  lignes.forEach((s, i) => {
    const b = el("button", `sol${s.score === meilleur ? " best" : ""}`) as HTMLButtonElement;
    b.type = "button";
    b.dataset["i"] = String(i);
    b.style.top = `${i * H}px`;
    // Le coup REELLEMENT joue se marque, comme le rejeu marque celui qu'on
    // examine : c'est ce qu'on cherche des l'ouverture.
    if (joue !== undefined && joue.word === s.mot && joue.dir === s.dir
        && joue.x === s.x && joue.y === s.y) {
      b.setAttribute("aria-current", "true");
      if (joue.player !== null) b.title = t2("trouvé par {qui}", { qui: joue.player });
    }
    b.appendChild(el("span", "w", s.mot));
    b.appendChild(el("span", "p", noteCoup(s.dir, s.x, s.y, bornes)));
    b.appendChild(el("span", "s", String(s.score)));
    b.appendChild(el("span", "d", s.score === meilleur ? t("top") : String(s.score - meilleur)));
    b.appendChild(el("span", "n", ""));
    piste.appendChild(b);
  });
  compte.textContent = t2(lignes.length > 1 ? "{n} solutions" : "{n} solution",
    { n: lignes.length });
  $("pr-sols").scrollTop = 0;
}

/** Va chercher les solutions du coup, si on ne les a pas deja. */
async function prChercherLesPaliers(n: number): Promise<void> {
  if (prPartie === null || n === 0) { prPeindreLesPaliers(n, []); return; }
  const deja = prPaliers.get(n);
  if (deja !== undefined) { prPeindreLesPaliers(n, deja); return; }
  const mien = ++prAttente;
  prPeindreLesPaliers(n, null);
  try {
    const base = prSource === "competitif" ? "/api/competitif/paliers/"
      : prSource === "historique" ? "/api/historique/paliers/" : "/api/paliers/";
    const r = await fetch(`${base}${encodeURIComponent(prPartie.manche.ref)}/${n}`);
    const d = await r.json();
    if (mien !== prAttente) return;
    const paliers = (d.paliers ?? []) as PalierRelu[];
    prPaliers.set(n, paliers);
    prPeindreLesPaliers(n, paliers);
  } catch {
    if (mien !== prAttente) return;
    prPeindreLesPaliers(n, []);
  }
}

/** Mene la vue au coup `n` : la grille, la ligne, le curseur. */
function prAller(n: number): void {
  if (prPartie === null) return;
  prVu = Math.max(0, Math.min(prPartie.coups.length, n));
  ($("pr-curseur") as HTMLInputElement).value = String(prVu);
  ($("pr-debut") as HTMLButtonElement).disabled = prVu === 0;
  ($("pr-avant") as HTMLButtonElement).disabled = prVu === 0;
  ($("pr-apres") as HTMLButtonElement).disabled = prVu >= prPartie.coups.length;
  ($("pr-fin") as HTMLButtonElement).disabled = prVu >= prPartie.coups.length;
  prDessiner();
  prPeindreLeCoup();
  void prChercherLesPaliers(prVu);
}

/**
 * Ouvre une partie archivee. `auDebut` distingue les deux boutons : « Revoir »
 * la reprend au premier coup, « FdR » la montre finie, ce qu'on lit d'abord.
 */
/** Va chercher une partie archivee. Rend le message d'erreur, ou la partie. */
/**
 * D'OU VIENT LA PARTIE QU'ON RELIT : une manche de records, ou une manche du
 * competitif (SPEC.md §29). Les deux se lisent sur la meme page ; seules
 * l'adresse et la porte de sortie changent.
 */
let prSource: "records" | "competitif" | "historique" = "records";
/** Ou revenir en fermant le rejeu, quand ce n'est pas la page des records. */
let prRetour: (() => void) | null = null;

async function chercherLaPartie(id: string): Promise<PartieRelue | string> {
  try {
    const base = prSource === "competitif" ? "/api/competitif/partie/"
      : prSource === "historique" ? "/api/historique/partie/" : "/api/partie/";
    const r = await fetch(`${base}${encodeURIComponent(id)}`);
    const brut = await r.json();
    if (!r.ok) {
      return typeof brut?.message === "string" ? brut.message : t("serveur injoignable");
    }
    return brut as PartieRelue;
  } catch {
    return t("serveur injoignable");
  }
}

/** Ce qu'on dit d'une partie sous son titre : qui, combien de coups, quand. */
function resumeDeLaPartie(d: PartieRelue): string {
  const joueurs = d.manche.joueurs
    .map((j) => j.invite ? `${j.nom} ${t("(invité)")}` : j.nom).join(", ");
  return [
    joueurs || t("personne"),
    `${d.coups.length} ${d.coups.length > 1 ? t("coups") : t("coup")}`,
    `${d.manche.cumul} ${t("points")}`,
    new Date(d.manche.at).toLocaleDateString(langue() === "en" ? "en-GB" : "fr-FR",
      { day: "numeric", month: "short", year: "numeric" }),
  ].join(" · ");
}

/**
 * LA FEUILLE DE ROUTE S'OUVRE EN FENETRE, par-dessus la page des records.
 *
 * C'est un tableau : il n'a besoin ni de grille, ni de curseur, ni de page a
 * lui. Le salon en a deja une exactement comme ca (Ctrl+R), et la page des
 * records reste derriere -- rien a retrouver en revenant.
 */
async function ouvrirLaFeuille(id: string, retourEtapes: LigneDeRecord | null = null): Promise<void> {
  frPartie = null;
  frRetourEtapes = retourEtapes;
  // La meme fenetre a pu servir aux etapes d'une montante : on lui rend son
  // titre, sinon une feuille de route s'ouvrirait sous « Les six parties ».
  $("fr-titre").textContent = t("Feuille de route");
  $("pr-route").replaceChildren();
  $("fr-detail").textContent = t("chargement…");
  $("voile-route").hidden = false;
  const d = await chercherLaPartie(id);
  // Fermee entre-temps : on ne repeint pas une fenetre qu'on a quittee.
  if ($("voile-route").hidden) return;
  if (typeof d === "string") { $("fr-detail").textContent = d; return; }
  frPartie = d;
  const cat = CATEGORIES.find((c) => c.id === d.manche.categorie);
  $("fr-detail").textContent = `${t(cat?.nom ?? d.manche.categorie)} · ${resumeDeLaPartie(d)}`;
  prPeindreLaRoute();
}

function fermerLaFeuille(): void {
  // OUVERTE DEPUIS « LES SIX PARTIES », UNE FDR Y REVIENT EN SE FERMANT. Les
  // deux partagent la meme fenetre ; la refermer purement et simplement
  // effacait jusqu'a la liste qu'on venait de quitter pour y regarder un coup.
  if (frRetourEtapes !== null) {
    const l = frRetourEtapes;
    frRetourEtapes = null;
    ouvrirLesEtapes(l);
    return;
  }
  $("voile-route").hidden = true;
  // Une partie relue, ce sont des centaines de placements : on ne la garde pas
  // derriere une fenetre fermee.
  frPartie = null;
  $("pr-route").replaceChildren();
}

$("fr-close").addEventListener("click", fermerLaFeuille);
$("voile-route").addEventListener("click", (e) => {
  if (e.target === $("voile-route")) fermerLaFeuille();
});

/** « Revoir » : la grille coup par coup, et les solutions de chacun. */
async function ouvrirLaPartie(
  id: string, coup = 1, source: "records" | "competitif" | "historique" = "records",
  retour: (() => void) | null = null,
): Promise<void> {
  prSource = source;
  prRetour = retour;
  for (const pid of ["corps-records", "corps-salons", "corps-profil", "corps-solveur",
    "corps-competitif", "corps-resultats", "corps-admin", "corps-tournoi", "corps-palmares", "corps-perso", "corps-defi"]) $(pid).hidden = true;
  $("corps-partie").hidden = false;
  $("join").hidden = false;
  $("pr-titre").textContent = t("chargement…");
  $("pr-detail").textContent = "";
  $("pr-coup").replaceChildren();
  window.history.pushState({ page: "partie", id, coup }, "",
    `?page=partie&partie=${encodeURIComponent(id)}&coup=${coup}`
    + (source === "records" ? "" : `&source=${source}`));

  const d = await chercherLaPartie(id);
  if (typeof d === "string") { $("pr-titre").textContent = d; return; }
  prPartie = d;

  const cat = CATEGORIES.find((c) => c.id === d.manche.categorie);
  $("pr-titre").textContent = d.titre ?? t(cat?.nom ?? d.manche.categorie);
  $("pr-detail").textContent = (d.dou === undefined || d.dou === "" ? "" : `${d.dou} · `)
    + resumeDeLaPartie(d);

  const curseur = $("pr-curseur") as HTMLInputElement;
  curseur.max = String(d.coups.length);
  prAller(Math.max(1, Math.min(d.coups.length, coup)));
}

function fermerLaPartie(pousser = true): void {
  $("corps-partie").hidden = true;
  const retour = prRetour;
  const duCompetitif = prSource === "competitif";
  prRetour = null;
  prSource = "records";
  if (!duCompetitif) $("corps-records").hidden = false;
  // ON NE GARDE RIEN DERRIERE UNE PAGE FERMEE. Une partie relue, ce sont des
  // centaines de placements et jusqu'a cent solutions par coup : masquee, elle
  // continuerait de peser sur le document et sur la memoire.
  prPartie = null;
  prPaliers.clear();
  prVu = 0;
  $("pr-piste").replaceChildren();
  $("pr-coup").replaceChildren();
  $("pr-sols-compte").textContent = "";
  if (duCompetitif) {
    if (retour !== null) retour();
    else ouvrirLeCompetitif(pousser);
    return;
  }
  if (pousser) window.history.pushState({ page: "records" }, "", "?page=records");
}

$("pr-retour").addEventListener("click", () => fermerLaPartie());
$("pr-debut").addEventListener("click", () => prAller(1));
$("pr-avant").addEventListener("click", () => prAller(prVu - 1));
$("pr-apres").addEventListener("click", () => prAller(prVu + 1));
$("pr-fin").addEventListener("click", () => prAller(prPartie?.coups.length ?? 0));
$("pr-curseur").addEventListener("input", (e) => {
  prAller(Number((e.target as HTMLInputElement).value));
});
// Les fleches parcourent la partie, comme dans le rejeu du salon.
addEventListener("keydown", (e) => {
  if ($("corps-partie").hidden) return;
  if (e.key === "ArrowLeft") { prAller(prVu - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { prAller(prVu + 1); e.preventDefault(); }
});
// Le plateau se redessine quand la fenetre change de taille : il est en
// pourcentage, et un canevas ne se remet pas a l'echelle tout seul.
addEventListener("resize", () => { if (!$("corps-partie").hidden) prDessiner(); });

// ---------------------------------------------------------------- LE COMPETITIF
//
// Voir SPEC.md §29. Une page, comme les records : les parties du jour a gauche,
// les tournois a droite. Et une seconde page pour les resultats d'une partie :
// le classement a gauche, la feuille de route a droite.

/** Une partie du jour, telle que la liste la montre. */
interface PartieDuJourVue {
  n: number;
  config: ConfigSerialisee;
  etat: "a-jouer" | "en-cours" | "jouee";
  temps: number | null;
  negatif: number | null;
  /** La manche qu'on a jouee, s'il y en a une : c'est elle qu'on revoit. */
  manche: string | null;
  joueurs: number;
}

/** Le lexique des parties du jour a l'arrivee : celui de la langue du site. */
function lexiqueDuJourParDefaut(): string {
  const l = moiCompte?.langue === "en" || moiCompte?.langue === "fr" ? moiCompte.langue : langue();
  return l === "en" ? "csw24" : "ods9";
}

let cpLexique = "";
/** Le jour regarde, ou `null` pour aujourd'hui. */
let cpJour: string | null = null;
let cpDemande = 0;

/**
 * UN TEMPS D'EPREUVE, AU CENTIEME : `01:23.45`, et `1:02:03.45` au-dela de
 * l'heure. Les colonnes s'alignent : chaque temps a la meme largeur.
 */
function tempsCentiemes(ms: number): string {
  const c = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(c / 360000);
  const m = Math.floor((c % 360000) / 6000);
  const s = Math.floor((c % 6000) / 100);
  const cc = c % 100;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Un negatif : `top` a zero, `-3` sinon. */
const negatifDit = (n: number): string => (n <= 0 ? "top" : `-${n}`);

/** Un jour, en toutes lettres : « mardi 15 septembre 2026 ». */
function jourEnLettres(jour: string): string {
  const [a, m, j] = jour.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, j, 12)).toLocaleDateString(
    langue() === "en" ? "en-GB" : "fr-FR",
    { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function ouvrirLeCompetitif(pousser = true, jour: string | null = null): void {
  $("corps-partie").hidden = true;
  $("corps-salons").hidden = true;
  $("corps-profil").hidden = true;
  $("corps-solveur").hidden = true;
  $("corps-records").hidden = true;
  $("corps-resultats").hidden = true;
  $("corps-admin").hidden = true;
  $("corps-tournoi").hidden = true;
  $("corps-palmares").hidden = true;
  $("corps-perso").hidden = true;
  $("corps-defi").hidden = true;
  $("corps-competitif").hidden = false;
  $("join").hidden = false;
  if (cpLexique === "") cpLexique = lexiqueDuJourParDefaut();
  cpJour = jour;
  // Le bouton n'existe que pour l'administration ; le serveur refuse le reste.
  $("cp-admin").hidden = moiCompte?.admin !== true;
  peindreLesLexiquesDuJour();
  void chargerLeCompetitif();
  void chargerLesTournois();
  if (pousser) window.history.pushState({ page: "competitif" }, "", "?page=competitif");
}

function fermerLeCompetitif(pousser = true): void {
  $("corps-competitif").hidden = true;
  $("corps-admin").hidden = true;
  $("corps-tournoi").hidden = true;
  $("corps-palmares").hidden = true;
  $("corps-perso").hidden = true;
  $("corps-defi").hidden = true;
  $("corps-resultats").hidden = true;
  $("corps-salons").hidden = false;
  $("cp-parties").replaceChildren();
  $("rs-classement").replaceChildren();
  $("rs-feuille").replaceChildren();
  rsDonnees = null;
  if (pousser) window.history.pushState({ page: "salons" }, "", location.pathname);
}

/** Les trois lexiques, en puces, dans l'ordre des parties du jour. */
function peindreLesLexiquesDuJour(): void {
  const boite = $("cp-lexique");
  boite.replaceChildren();
  for (const id of LEXIQUES_DU_JOUR) {
    const b = el("button", "", dictionnaire(id).nom.split(" ")[0]!) as HTMLButtonElement;
    b.type = "button";
    b.title = dictionnaire(id).nom;
    b.setAttribute("aria-pressed", String(id === cpLexique));
    b.addEventListener("click", () => {
      cpLexique = id;
      peindreLesLexiquesDuJour();
      void chargerLeCompetitif();
    });
    boite.appendChild(b);
  }
}

async function chargerLeCompetitif(): Promise<void> {
  const mien = ++cpDemande;
  $("cp-error").hidden = true;
  let d: {
    jour: string; aujourdhui: string; lexique: string; pret: boolean;
    jours: string[]; parties: PartieDuJourVue[];
  };
  try {
    const r = await fetch(`/api/competitif/jour?lexique=${encodeURIComponent(cpLexique)}`
      + (cpJour === null ? "" : `&jour=${cpJour}`));
    d = await r.json();
  } catch {
    if (mien !== cpDemande) return;
    $("cp-parties").replaceChildren(tableauVide(t("serveur injoignable")));
    return;
  }
  if (mien !== cpDemande) return;
  $("cp-date").textContent = jourEnLettres(d.jour);
  if (!d.pret) {
    $("cp-parties").replaceChildren(tableauVide(
      d.jour === d.aujourdhui ? t("Les parties du jour se préparent.") : t("Aucune partie ce jour-là.")));
  } else {
    $("cp-parties").replaceChildren(...d.parties.map((p) => ligneDePartieDuJour(d.jour, d.lexique, p)));
  }
  peindreLeCalendrier(d.jours, d.jour);
}

/** Une partie du jour : son numero, son nom, et les deux gestes. */
function ligneDePartieDuJour(jour: string, lexique: string, p: PartieDuJourVue): HTMLElement {
  const ligne = el("div", "cp-partie");
  ligne.appendChild(el("div", "cp-num", String(p.n)));
  const nom = ecrireLeNomDeLaPartie(p.config, el("div", "cp-nom"));
  nom.appendChild(el("span", "", t2(p.joueurs > 1 ? "{n} joueurs" : "{n} joueur", { n: p.joueurs })));
  ligne.appendChild(nom);

  const jouer = el("button", "cp-jouer") as HTMLButtonElement;
  jouer.type = "button";
  if (p.etat === "jouee" && p.temps !== null) {
    // UNE PARTIE JOUEE MONTRE CE QU'ON Y A FAIT, a la place du bouton -- et
    // mene au rejeu : c'est ce qu'on veut rouvrir d'une partie qu'on a jouee.
    jouer.className = "cp-faite";
    jouer.textContent = `${tempsCentiemes(p.temps)} · ${negatifDit(p.negatif ?? 0)}`;
    jouer.title = t("Revoir la partie");
    jouer.addEventListener("click", () => {
      if (p.manche === null) { ouvrirLesResultats(jour, lexique, p.n); return; }
      void ouvrirLaPartie(p.manche, 1, "competitif", () => ouvrirLeCompetitif());
    });
  } else {
    jouer.textContent = p.etat === "en-cours" ? t("Reprendre") : t("Jouer");
    jouer.addEventListener("click", () => void jouerLaPartieDuJour(jour, lexique, p.n));
  }
  ligne.appendChild(jouer);

  const resultats = el("button", "", t("Résultats")) as HTMLButtonElement;
  resultats.type = "button";
  resultats.addEventListener("click", () => ouvrirLesResultats(jour, lexique, p.n));
  ligne.appendChild(resultats);
  return ligne;
}

/**
 * JOUER, OU REPRENDRE : le serveur rend le salon de la partie, et l'on y entre.
 * Sans compte, on propose de se connecter : les parties du jour se jouent avec
 * un compte (SPEC.md §29).
 */
async function jouerLaPartieDuJour(jour: string, lexique: string, n: number): Promise<void> {
  await jouerUnePartie({ jour, lexique, partie: n }, $("cp-error"));
}

/** Jouer une partie d'epreuve, du jour ou de tournoi : `corps` dit laquelle. */
async function jouerUnePartie(
  corps: Record<string, unknown>, erreur: HTMLElement, sansCompte = false,
): Promise<void> {
  // UN DEFI SE JOUE SANS COMPTE (SPEC.md §29) ; tout le reste en demande un.
  if (moiCompte === null && !sansCompte) { ouvrirLeCompte("connexion"); return; }
  erreur.hidden = true;
  try {
    const r = await fetch("/api/competitif/jouer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(corps),
    });
    const d = await r.json();
    if (!r.ok || typeof d.salon !== "string") {
      erreur.textContent = t(d.erreur ?? "serveur injoignable");
      erreur.hidden = false;
      return;
    }
    ($("name") as HTMLInputElement).value = moiCompte?.pseudo ?? pseudo();
    allerA(d.salon);
  } catch {
    erreur.textContent = t("serveur injoignable");
    erreur.hidden = false;
  }
}

/** Le calendrier : les jours qui ont eu des parties, le plus recent d'abord. */
function peindreLeCalendrier(jours: string[], vu: string): void {
  // LE CALENDRIER S'OUVRE DES QU'ON N'EST PLUS SUR AUJOURD'HUI, et reste ferme
  // sinon : c'est la seule chose qui dise ou l'on se trouve dans le temps.
  $("cp-jours").hidden = jours.length === 0 || vu === jours[0];
  const boite = $("cp-jours");
  boite.replaceChildren(...jours.map((j) => {
    const b = el("button", "", new Date(`${j}T12:00:00Z`).toLocaleDateString(
      langue() === "en" ? "en-GB" : "fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }),
    ) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(j === vu));
    b.addEventListener("click", () => {
      cpJour = j;
      void chargerLeCompetitif();
    });
    return b;
  }));
}

$("cp-calendrier").addEventListener("click", () => { $("cp-jours").hidden = !$("cp-jours").hidden; });

// ------------------------------------------------------------- LES RESULTATS

interface LigneVue {
  manche: string;
  compte: string;
  jeu: "seul" | "compte" | "equipe";
  noms: string;
  equipe: string[];
  temps: number;
  negatif: number;
  score: number;
  coups: number;
  aTemps: boolean;
  at: number;
  /** Jouee par qui avait vu la partie d'avance : hors classement. */
  apercu?: boolean;
  /** Au cumul seulement. */
  parties?: number[];
  cle?: string;
}

interface CoupVue {
  n: number;
  notation: string;
  mot: string;
  dir: Dir;
  x: number;
  y: number;
  score: number;
  farfouille: boolean;
  ms: number;
  trouve: boolean;
  prop: { mot: string; dir: Dir; x: number; y: number; score: number } | null;
}

interface ResultatsVue {
  jour: string | null;
  tournoi?: { id: string; nom: string; fin: number | null };
  /** Dans un tournoi, les resultats qu'on n'a pas encore le droit de voir. */
  cache?: boolean;
  lexique: string;
  parties: { n: number; config: ConfigSerialisee }[];
  partie: number | "cumul";
  lignes: LigneVue[];
  moi: any;
  details?: Record<string, CoupVue[]> | null;
}

let rsJour = "";
let rsLexique = "";
/** Le tournoi dont on lit les resultats, ou `null` pour les parties du jour. */
let rsTournoi: string | null = null;
/** Le defi dont on lit le classement, ou `null`. */
let rsDefi: string | null = null;
let rsPartie: number | "cumul" = 1;
let rsDonnees: ResultatsVue | null = null;
let rsTri: "temps" | "negatif" = "temps";
let rsSolo = false;
let rsATemps = false;
/** La manche dont la feuille de route est ouverte a droite. */
let rsVue: string | null = null;
let rsDemande = 0;

function ouvrirLesResultats(jour: string, lexique: string, partie: number | "cumul", pousser = true): void {
  $("corps-partie").hidden = true;
  $("corps-salons").hidden = true;
  $("corps-profil").hidden = true;
  $("corps-solveur").hidden = true;
  $("corps-records").hidden = true;
  $("corps-competitif").hidden = true;
  $("corps-admin").hidden = true;
  $("corps-tournoi").hidden = true;
  $("corps-palmares").hidden = true;
  $("corps-perso").hidden = true;
  $("corps-defi").hidden = true;
  $("corps-resultats").hidden = false;
  $("join").hidden = false;
  rsJour = jour;
  rsLexique = lexique;
  rsTournoi = null;
  rsDefi = null;
  rsPartie = partie;
  rsVue = null;
  rsTri = "temps";
  $("rs-retour").textContent = t("← Parties du jour");
  void chargerLesResultats();
  if (pousser) window.history.pushState({ page: "resultats" }, "", adresseDesResultats(partie));
}

/** Les resultats d'un tournoi : le General d'abord (SPEC.md §29). */
function ouvrirLesResultatsDuTournoi(id: string, partie: number | "cumul" = "cumul", pousser = true): void {
  ouvrirLesResultats("", "", partie, false);
  rsTournoi = id;
  $("rs-retour").textContent = t("← Tournoi");
  void chargerLesResultats();
  if (pousser) window.history.pushState({ page: "resultats" }, "", adresseDesResultats(partie));
}

/** L'adresse des resultats regardes, pour l'historique et les liens. */
function adresseDesResultats(partie: number | "cumul"): string {
  if (rsDefi !== null) return `?page=resultats&defi=${encodeURIComponent(rsDefi)}`;
  return rsTournoi !== null
    ? `?page=resultats&tournoi=${encodeURIComponent(rsTournoi)}&partie=${partie}`
    : `?page=resultats&jour=${rsJour}&lexique=${encodeURIComponent(rsLexique)}&partie=${partie}`;
}

/** Une adresse de resultats s'ouvre au chargement comme au retour arriere. */
function ouvrirLesResultatsDeLAdresse(): void {
  const p = new URLSearchParams(location.search);
  const partie = p.get("partie") === "cumul" ? "cumul" : Math.max(1, Number(p.get("partie")) || 1);
  if (p.get("defi") !== null) { ouvrirLesResultatsDuDefi(p.get("defi")!, false); return; }
  if (p.get("tournoi") !== null) { ouvrirLesResultatsDuTournoi(p.get("tournoi")!, partie, false); return; }
  ouvrirLesResultats(p.get("jour") ?? "", p.get("lexique") ?? "ods9", partie, false);
}

$("rs-retour").addEventListener("click", () => {
  if (rsDefi !== null) { ouvrirLeDefi(rsDefi); return; }
  if (rsTournoi !== null) { ouvrirLeTournoi(rsTournoi); return; }
  cpLexique = rsLexique;
  // ON REVIENT AU JOUR QU'ON REGARDAIT, calendrier ouvert : revenir a
  // aujourd'hui apres avoir etudie le 3 septembre n'a pas de sens.
  ouvrirLeCompetitif(true, rsJour === "" ? null : rsJour);
});

async function chargerLesResultats(): Promise<void> {
  const mien = ++rsDemande;
  $("rs-classement").replaceChildren(tableauVide(t("chargement…")));
  $("rs-feuille").replaceChildren();
  $("rs-resume").replaceChildren();
  let d: ResultatsVue;
  try {
    const sans = moiCompte === null && pseudo() !== "" ? `&pseudo=${encodeURIComponent(pseudo())}` : "";
    const r = await fetch(rsDefi !== null
      ? `/api/competitif/resultats?defi=${encodeURIComponent(rsDefi)}${sans}`
      : rsTournoi !== null
        ? `/api/competitif/resultats?tournoi=${encodeURIComponent(rsTournoi)}&partie=${rsPartie}`
        : `/api/competitif/resultats?jour=${rsJour}&lexique=${encodeURIComponent(rsLexique)}&partie=${rsPartie}`);
    d = await r.json();
    if (!r.ok) {
      if (mien !== rsDemande) return;
      $("rs-classement").replaceChildren(tableauVide(t((d as any).erreur ?? "serveur injoignable")));
      return;
    }
  } catch {
    if (mien !== rsDemande) return;
    $("rs-classement").replaceChildren(tableauVide(t("serveur injoignable")));
    return;
  }
  if (mien !== rsDemande) return;
  rsDonnees = d;
  // Sa propre feuille s'ouvre d'office, des qu'on a joue la partie.
  if (rsVue === null && d.partie !== "cumul" && d.moi?.fini === true) rsVue = d.moi.manche;
  peindreLesResultats();
}

function peindreLesOngletsDesResultats(d: ResultatsVue): void {
  const boite = $("rs-onglets");
  const parties = d.parties.map((p) => ({ v: p.n as number | "cumul", texte: `P${p.n}` }));
  // UN TOURNOI SE JUGE SUR SON TOTAL : son General vient en premier.
  const onglets: { v: number | "cumul"; texte: string }[] = d.tournoi !== undefined
    ? [{ v: "cumul", texte: t("Général") }, ...parties]
    : [...parties, { v: "cumul", texte: t("Cumul") }];
  boite.replaceChildren(...onglets.map((o) => {
    const b = el("button", "", o.texte) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(o.v === rsPartie));
    b.addEventListener("click", () => {
      if (o.v === rsPartie) return;
      rsPartie = o.v;
      rsVue = null;
      window.history.replaceState({ page: "resultats" }, "", adresseDesResultats(o.v));
      void chargerLesResultats();
    });
    return b;
  }));
}

/**
 * Les lignes que les cases cochees laissent. Une ligne jouee par qui avait vu la
 * partie d'avance n'y est jamais : elle est hors classement (SPEC.md §29).
 */
function lignesRetenues(d: ResultatsVue): LigneVue[] {
  return d.lignes.filter((l) => l.apercu !== true
    && (!rsSolo || l.jeu === "seul") && (!rsATemps || l.aTemps));
}

/** Deux temps egaux au centieme sont ex aequo (SPEC.md §23). */
const centiemes = (ms: number): number => Math.round(ms / 10);

function peindreLesResultats(): void {
  const d = rsDonnees;
  if (d === null) return;
  peindreLesOngletsDesResultats(d);
  $("rs-solo").setAttribute("aria-pressed", String(rsSolo));
  $("rs-atemps").setAttribute("aria-pressed", String(rsATemps));
  const partie = d.partie === "cumul" ? null : d.parties.find((p) => p.n === d.partie);
  $("rs-titre").textContent = partie === null || partie === undefined
    ? t(d.tournoi !== undefined ? "Général" : "Cumul") : `P${partie.n} · ${nomDeLaPartie(partie.config, t)}`;
  $("rs-detail").textContent = `${d.tournoi !== undefined ? d.tournoi.nom : jourEnLettres(d.jour ?? "")}`
    + ` · ${dictionnaire(d.lexique).nom}`;
  // DANS UN TOURNOI, on ne voit que ce qu'on a fini (SPEC.md §29).
  if (d.cache === true) {
    $("rs-classement").replaceChildren(tableauVide(d.partie === "cumul"
      ? t("Le général s'ouvre une fois toutes les parties jouées, ou à la fin du tournoi.")
      : t("Les résultats de cette partie s'ouvrent une fois la partie jouée, ou à la fin du tournoi.")));
    $("rs-feuille").replaceChildren();
    $("rs-resume").replaceChildren();
    $("rs-graphes").hidden = true;
    return;
  }
  if (d.partie === "cumul") peindreLeCumul(d);
  else peindreLeClassementDeLaPartie(d);
}

/** Le nom d'une ligne : le pseudo, les noms ecrits a la main, ou l'equipe. */
function celluleDuJoueur(l: LigneVue): HTMLElement {
  const td = el("td", "g rs-noms");
  if (l.jeu === "equipe") {
    l.equipe.forEach((nom, i) => {
      if (i > 0) td.appendChild(document.createTextNode(" + "));
      td.appendChild(pseudoCliquable(nom));
    });
    return td;
  }
  td.appendChild(pseudoCliquable(l.compte));
  if (l.jeu === "compte") td.appendChild(el("i", "", l.noms === "" ? ` ${t("(à plusieurs)")}` : ` · ${l.noms}`));
  return td;
}

/** Trie et classe : au temps, ou au negatif puis au temps. */
function classer(lignes: LigneVue[]): { l: LigneVue; rang: number }[] {
  const tries = [...lignes].sort((a, b) => rsTri === "negatif"
    ? a.negatif - b.negatif || a.temps - b.temps
    : a.temps - b.temps);
  const out: { l: LigneVue; rang: number }[] = [];
  tries.forEach((l, i) => {
    const p = out[i - 1];
    const egal = p !== undefined && centiemes(p.l.temps) === centiemes(l.temps)
      && (rsTri === "temps" || p.l.negatif === l.negatif);
    out.push({ l, rang: egal ? p!.rang : i + 1 });
  });
  return out;
}

/** L'entete du classement : Temps et Negatif se cliquent pour trier. */
function teteDuClassement(avecParties: boolean): HTMLElement {
  const thead = el("thead");
  const tr = el("tr");
  const colonne = (texte: string, classe = "", tri?: "temps" | "negatif"): void => {
    const th = el("th", classe, texte);
    if (tri !== undefined) {
      th.classList.add("triable");
      if (rsTri === tri) { th.classList.add("tri"); th.appendChild(el("span", "rc-tri", "▾")); }
      th.addEventListener("click", () => { rsTri = tri; peindreLesResultats(); });
    }
    tr.appendChild(th);
  };
  colonne("#");
  colonne(t("Joueur"), "g");
  if (avecParties) colonne(t("Parties"));
  colonne(t("Temps"), "", "temps");
  colonne(t("Négatif"), "", "negatif");
  colonne(t("Score"));
  thead.appendChild(tr);
  return thead;
}

function ligneDeClassement(l: LigneVue, rang: number, avecParties: boolean): HTMLElement {
  const tr = el("tr");
  if (!l.aTemps) {
    tr.classList.add("rs-tard");
    tr.title = t("Jouée après la fermeture");
  }
  if (l.apercu === true) {
    tr.classList.add("rs-apercu");
    tr.title = t("A vu la partie avant de la jouer : hors classement");
  }
  if (l.manche === rsVue) tr.classList.add("rs-vu");
  if (rang === 0) tr.appendChild(el("td", "rang", "—"));
  else tr.appendChild(celluleDuRang(rang));
  tr.appendChild(celluleDuJoueur(l));
  if (avecParties) tr.appendChild(el("td", "", String(l.parties?.length ?? 1)));
  tr.appendChild(el("td", rsTri === "temps" ? "fort" : "", tempsCentiemes(l.temps)));
  tr.appendChild(el("td", rsTri === "negatif" ? "fort" : "", negatifDit(l.negatif)));
  tr.appendChild(el("td", "", String(l.score)));
  return tr;
}

function peindreLeClassementDeLaPartie(d: ResultatsVue): void {
  const lignes = lignesRetenues(d);
  if (lignes.length === 0 && !d.lignes.some((l) => l.apercu === true)) {
    $("rs-classement").replaceChildren(tableauVide(t("Personne n'a encore joué cette partie.")));
  } else {
    const table = el("table");
    table.appendChild(teteDuClassement(false));
    const corps = el("tbody");
    const horsClassement = d.lignes.filter((l) => l.apercu === true);
    for (const { l, rang } of [...classer(lignes), ...horsClassement.map((l) => ({ l, rang: 0 }))]) {
      const tr = ligneDeClassement(l, rang, false);
      tr.addEventListener("click", () => {
        if (d.details === null || d.details === undefined) return;
        rsVue = l.manche;
        peindreLesResultats();
      });
      corps.appendChild(tr);
    }
    table.appendChild(corps);
    $("rs-classement").replaceChildren(table);
  }
  peindreLaFeuille(d, lignes);
}

/**
 * LE CUMUL : ceux qui ont tout joue d'abord, puis ceux a qui il manque une
 * partie, et ainsi de suite, separes par une ligne legere (SPEC.md §29).
 */
function peindreLeCumul(d: ResultatsVue): void {
  const lignes = lignesRetenues(d);
  const total = d.parties.length;
  if (lignes.length === 0) {
    $("rs-classement").replaceChildren(tableauVide(t("Personne n'a encore joué ces parties.")));
  } else {
    const table = el("table");
    table.appendChild(teteDuClassement(true));
    const corps = el("tbody");
    let rangDepart = 0;
    for (let n = total; n >= 1; n--) {
      const groupe = lignes.filter((l) => (l.parties?.length ?? 1) === n);
      if (groupe.length === 0) continue;
      if (rangDepart > 0) {
        const coupure = el("tr", "rc-coupure");
        const td = el("td", "", t2(n > 1 ? "{n} parties" : "{n} partie", { n })) as HTMLTableCellElement;
        td.colSpan = 6;
        coupure.appendChild(td);
        corps.appendChild(coupure);
      }
      for (const { l, rang } of classer(groupe)) {
        corps.appendChild(ligneDeClassement(l, rangDepart + rang, true));
      }
      rangDepart += groupe.length;
    }
    table.appendChild(corps);
    $("rs-classement").replaceChildren(table);
  }
  // A DROITE, ses propres parties, une ligne chacune.
  $("rs-graphes").hidden = true;
  ($("rs-revoir") as HTMLButtonElement).hidden = true;
  $("rs-feuille-titre").textContent = t("Vos parties");
  const miennes = (d.moi ?? []) as { partie: number; fini: boolean; temps: number | null;
    negatif: number | null; score: number | null }[];
  if (miennes.length === 0) {
    $("rs-feuille").replaceChildren(el("div", "rs-vide", t("Vous n'avez pas encore joué ces parties.")));
    $("rs-resume").replaceChildren();
    return;
  }
  const table = el("table");
  table.appendChild(tete([
    { texte: t("Partie"), classe: "g" }, { texte: t("Temps") }, { texte: t("Négatif") }, { texte: t("Score") },
  ]));
  const corps = el("tbody");
  for (const p of [...miennes].sort((a, b) => a.partie - b.partie)) {
    const tr = el("tr");
    const conf = d.parties.find((x) => x.n === p.partie)?.config;
    tr.appendChild(el("td", "g", `P${p.partie}${conf === undefined ? "" : ` · ${nomDeLaPartie(conf, t)}`}`));
    tr.appendChild(el("td", "", p.temps === null ? t("en cours") : tempsCentiemes(p.temps)));
    tr.appendChild(el("td", "", p.negatif === null ? "" : negatifDit(p.negatif)));
    tr.appendChild(el("td", "", p.score === null ? "" : String(p.score)));
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  $("rs-feuille").replaceChildren(table);
  const finies = miennes.filter((p) => p.fini);
  $("rs-resume").textContent = finies.length === 0 ? "" : t2("Total : {temps} · {neg} · {score} points", {
    temps: tempsCentiemes(finies.reduce((a, p) => a + (p.temps ?? 0), 0)),
    neg: negatifDit(finies.reduce((a, p) => a + (p.negatif ?? 0), 0)),
    score: finies.reduce((a, p) => a + (p.score ?? 0), 0),
  });
}

/** Le tirage tel que la feuille l'ecrit : les jokers colles a leur partie. */
const tirageDeLaFeuille = (notation: string): string => notation.replace(/\+(\?+)$/, "$1");

/** Qui a joue cette ligne, pour les titres : le pseudo, ou l'equipe. */
const nomDeLaLigne = (l: LigneVue): string => (l.jeu === "equipe" ? l.equipe.join(" + ") : l.compte);

/**
 * LA FEUILLE DE ROUTE DU CLASSEMENT (SPEC.md §29).
 *
 * Elle ne s'ouvre qu'a qui a fini la partie : le serveur n'envoie le detail des
 * coups qu'a lui. « Trouve par » et le meilleur temps se comptent sur les lignes
 * que les cases laissent -- un meilleur temps ne doit pas appartenir a une
 * ligne qu'on vient de masquer.
 */
function peindreLaFeuille(d: ResultatsVue, lignes: LigneVue[]): void {
  const details = d.details ?? null;
  $("rs-feuille-titre").textContent = t("Feuille de route");
  $("rs-graphes").hidden = true;
  ($("rs-revoir") as HTMLButtonElement).hidden = true;
  if (details === null) {
    $("rs-feuille").replaceChildren(el("div", "rs-vide",
      d.moi?.enCours === true ? t("La feuille de route s'affiche une fois la partie finie.")
        : t("La feuille de route s'affiche une fois la partie jouée.")));
    $("rs-resume").replaceChildren();
    return;
  }
  const vue = d.lignes.find((l) => l.manche === rsVue);
  const coups = vue === undefined ? undefined : details[vue.manche];
  if (vue === undefined || coups === undefined) {
    $("rs-feuille").replaceChildren(el("div", "rs-vide", t("Choisissez une ligne du classement.")));
    $("rs-resume").replaceChildren();
    return;
  }
  // REVOIR LA PARTIE : la meme page que le rejeu d'une partie archivee, sur la
  // manche qu'on regarde (SPEC.md §29).
  const revoir = $("rs-revoir") as HTMLButtonElement;
  revoir.hidden = false;
  revoir.onclick = () => {
    const ou = { tournoi: rsTournoi, jour: rsJour, lexique: rsLexique, partie: rsPartie };
    void ouvrirLaPartie(vue.manche, 1, "competitif", () => {
      if (ou.tournoi !== null) ouvrirLesResultatsDuTournoi(ou.tournoi, ou.partie);
      else ouvrirLesResultats(ou.jour, ou.lexique, ou.partie);
    });
  };
  const mienne = vue.manche === d.moi?.manche;
  // LE NOM EST TOUJOURS DIT, le sien compris : on lit plusieurs feuilles de
  // suite, et rien d'autre ne dit laquelle on regarde.
  $("rs-feuille-titre").textContent = t2("Feuille de route de {nom}", { nom: nomDeLaLigne(vue) });
  const partie = d.parties.find((p) => p.n === d.partie);
  const bornes = partie?.config.bornes ?? 7;
  const chronoMs = (partie?.config.chrono ?? 0) * 1000;

  // Pour chaque coup : qui l'a trouve, et en combien de temps.
  const trouveurs = (n: number): { l: LigneVue; ms: number }[] => lignes
    .map((l) => ({ l, c: details[l.manche]?.[n - 1] }))
    .filter((x) => x.c?.trouve === true)
    .map((x) => ({ l: x.l, ms: x.c!.ms }));

  const table = el("table");
  const thead = el("thead");
  const groupes = el("tr", "rs-groupes");
  const groupe = (texte: string, span: number, sep = true): void => {
    const th = el("th", sep ? "rs-sep" : "", texte) as HTMLTableCellElement;
    th.colSpan = span;
    groupes.appendChild(th);
  };
  groupe("", 2, false);
  groupe(t("Temps"), 2);
  groupe(t("Mot retenu"), 3);
  groupe(mienne ? t("Votre mot") : t2("Mot de {nom}", { nom: nomDeLaLigne(vue) }), 4);
  groupe(t("Trouvé par"), 1);
  groupe(t("Meilleur temps"), 2);
  groupe(t("Cumul"), 3);
  thead.appendChild(groupes);
  const noms = el("tr");
  const col = (texte: string, classe = ""): void => { noms.appendChild(el("th", classe, texte)); };
  col(t("Cp.")); col(t("Tirage"), "g");
  col(t("Coup"), "rs-sep"); col(t("Cumul"));
  col(t("Mot"), "g rs-sep"); col(t("Pos.")); col(t("Score"));
  col(t("Mot"), "g rs-sep"); col(t("Pos.")); col(t("Score")); col(t("Nég."));
  col(t2("/{n} joueurs", { n: lignes.length }), "rs-sep");
  col(t("Temps"), "rs-sep"); col(t("Joueurs"), "g");
  col(t("Score"), "rs-sep"); col(t("Nég.")); col(t("Partie"));
  thead.appendChild(noms);
  table.appendChild(thead);

  const corps = el("tbody");
  let cumulTemps = 0, cumulScore = 0, cumulNeg = 0, cumulPartie = 0, cumulMeilleurs = 0;
  let tops = 0, farfouilles = 0, farfouillesTrouvees = 0;
  for (const c of coups) {
    const tr = el("tr");
    if (!c.trouve) tr.classList.add("rs-rate");
    const td = (texte: string, classe = ""): HTMLElement => {
      const x = el("td", classe, texte);
      tr.appendChild(x);
      return x;
    };
    cumulTemps += c.ms;
    const sienne = c.prop?.score ?? 0;
    const neg = Math.max(0, c.score - sienne);
    cumulScore += sienne;
    cumulNeg += neg;
    cumulPartie += c.score;
    if (c.trouve) tops++;
    if (c.farfouille) { farfouilles++; if (c.trouve) farfouillesTrouvees++; }

    td(String(c.n));
    td(tirageDeLaFeuille(c.notation), "g");
    td(tempsCentiemes(c.ms), "rs-sep");
    td(tempsCentiemes(cumulTemps));
    td(c.mot, "g rs-sep rs-mot");
    td(noteCoup(c.dir, c.x, c.y, bornes));
    td(String(c.score));
    if (c.prop === null) {
      td("", "g rs-sep"); td(""); td("");
    } else {
      td(c.prop.mot, "g rs-sep");
      td(noteCoup(c.prop.dir, c.prop.x, c.prop.y, bornes));
      td(String(c.prop.score));
    }
    td(negatifDit(neg), neg === 0 ? "rs-top" : "");

    // TROUVE PAR : le nombre dans la case, le total dans l'entete. Un seul
    // trouveur s'ecrit « SOLO de Ana ».
    const qui = trouveurs(c.n);
    const cellule = el("td", "rs-sep");
    const bouton = el("button", "rs-trouves",
      qui.length === 1 ? t2("SOLO de {nom}", { nom: nomDeLaLigne(qui[0]!.l) }) : String(qui.length),
    ) as HTMLButtonElement;
    bouton.type = "button";
    bouton.addEventListener("click", () => ouvrirLesTrouveurs(c, lignes, details, bornes));
    cellule.appendChild(bouton);
    tr.appendChild(cellule);

    // LE MEILLEUR TEMPS : le plus rapide parmi ceux qui ont trouve, au centieme.
    if (qui.length === 0) {
      td("", "rs-sep"); td("", "g");
      cumulMeilleurs += chronoMs;
    } else {
      const meilleur = Math.min(...qui.map((q) => q.ms));
      cumulMeilleurs += meilleur;
      const ex = qui.filter((q) => centiemes(q.ms) === centiemes(meilleur)).map((q) => nomDeLaLigne(q.l));
      td(tempsCentiemes(meilleur), "rs-sep");
      const nomsCell = td(ex.length <= 2 ? ex.join(", ")
        : t2("{a}, {b} et {n} autres", { a: ex[0]!, b: ex[1]!, n: ex.length - 2 }), "g");
      nomsCell.title = ex.join("\n");
    }
    td(String(cumulScore), "rs-sep");
    td(negatifDit(cumulNeg), cumulNeg === 0 ? "rs-top" : "");
    td(String(cumulPartie));
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  $("rs-feuille").replaceChildren(table);

  const pc = (a: number, b: number): string => (b === 0 ? "0" : String(Math.round((a / b) * 100)));
  const ecart = cumulTemps - cumulMeilleurs;
  const resume = $("rs-resume");
  resume.replaceChildren();
  const morceau = (etiquette: string, valeur: string): void => {
    if (resume.childNodes.length > 0) resume.appendChild(document.createTextNode(" · "));
    resume.appendChild(document.createTextNode(`${etiquette} : `));
    resume.appendChild(el("b", "", valeur));
  };
  morceau(t("Temps moyen par coup"), `${(cumulTemps / Math.max(1, coups.length) / 1000).toFixed(2)} s`);
  morceau(t("Tops trouvés"), `${tops}/${coups.length} (${pc(tops, coups.length)} %)`);
  morceau(t("Farfouilles trouvées"), `${farfouillesTrouvees}/${farfouilles} (${pc(farfouillesTrouvees, farfouilles)} %)`);
  morceau(t("Négatif"), negatifDit(cumulNeg));
  morceau(t("Cumul des meilleurs temps"), `${tempsCentiemes(cumulMeilleurs)} (+${tempsCentiemes(Math.max(0, ecart))})`);
  peindreLesGraphes(d, lignes, vue, details);
}

/**
 * QUI A TROUVE CE COUP, ET CE QUE LES AUTRES ONT JOUE (SPEC.md §29).
 *
 * La vue que publie la federation, en plus court : les trouveurs du plus rapide
 * au plus lent, puis chaque autre solution avec le nombre de joueurs qui s'y
 * sont arretes.
 */
function ouvrirLesTrouveurs(
  c: CoupVue, lignes: LigneVue[], details: Record<string, CoupVue[]>, bornes: number | null,
): void {
  $("trouves-titre").textContent = `${t("Coup")} ${c.n} · ${c.mot} ${noteCoup(c.dir, c.x, c.y, bornes)} · ${c.score}`;
  const liste = $("trouves-liste");
  liste.replaceChildren();
  const ligne = (qui: string, chiffre: string): HTMLElement => {
    const x = el("div", "ligne");
    x.appendChild(el("span", "qui", qui));
    x.appendChild(el("span", "chiffre", chiffre));
    return x;
  };
  const leurs = lignes.map((l) => ({ l, c: details[l.manche]?.[c.n - 1] }))
    .filter((x): x is { l: LigneVue; c: CoupVue } => x.c !== undefined);
  const trouves = leurs.filter((x) => x.c.trouve).sort((a, b) => a.c.ms - b.c.ms);
  liste.appendChild(el("h3", "", t2("Trouvé par {n}", { n: trouves.length })));
  for (const x of trouves) liste.appendChild(ligne(nomDeLaLigne(x.l), tempsCentiemes(x.c.ms)));

  const autres = new Map<string, { mot: string; pos: string; score: number; noms: string[] }>();
  let sansRien = 0;
  for (const x of leurs.filter((y) => !y.c.trouve)) {
    const p = x.c.prop;
    if (p === null) { sansRien++; continue; }
    const pos = noteCoup(p.dir, p.x, p.y, bornes);
    const cle = `${p.mot}|${pos}|${p.score}`;
    const g = autres.get(cle) ?? { mot: p.mot, pos, score: p.score, noms: [] };
    g.noms.push(nomDeLaLigne(x.l));
    autres.set(cle, g);
  }
  if (autres.size > 0 || sansRien > 0) {
    liste.appendChild(el("h3", "", t("Les autres solutions")));
    for (const g of [...autres.values()].sort((a, b) => b.score - a.score || b.noms.length - a.noms.length)) {
      const x = ligne(`${g.mot} ${g.pos} · ${g.score}`, String(g.noms.length));
      x.title = g.noms.join("\n");
      liste.appendChild(x);
    }
    if (sansRien > 0) liste.appendChild(ligne(t("Sans solution"), String(sansRien)));
  }
  $("voile-trouves").hidden = false;
}

$("trouves-close").addEventListener("click", () => { $("voile-trouves").hidden = true; });
$("voile-trouves").addEventListener("click", (e) => {
  if (e.target === $("voile-trouves")) $("voile-trouves").hidden = true;
});
$("rs-solo").addEventListener("click", () => { rsSolo = !rsSolo; peindreLesResultats(); });
$("rs-atemps").addEventListener("click", () => { rsATemps = !rsATemps; peindreLesResultats(); });

// ------------------------------------------------------ LE SALON D'UNE EPREUVE

/** Ce que le salon d'une rencontre de tournoi sait d'elle (SPEC.md §29). */
interface RencontreDuSalonVue {
  tournoi: string;
  nomDuTournoi: string;
  rencontre: string;
  manche: number;
  bo: number;
  camps: [string, string];
  noms: [string, string];
  joueurs: [string[], string[]];
  score: [number, number];
  prets: string[];
}

let rencontreSalon: RencontreDuSalonVue | null = null;

/**
 * JE REGARDE, JE NE JOUE PAS (SPEC.md §29).
 *
 * Le serveur le dit a l'entree : dans le salon d'une rencontre dont je ne suis
 * ni d'un camp ni de l'autre, ou sur la grille permanente quand je n'ai pas de
 * compte. La grille se ferme, le chat attend la fin de la partie, et le
 * chuchotement s'ouvre.
 */
let jeRegarde = false;
/** Ceux qui regardent, tels que le salon les annonce. */
let ceuxQuiRegardent: string[] = [];
let chuchote = false;

function peindreLeSpectateur(): void {
  const note = $("spectateur-note");
  const bouton = $("chat-chuchoter") as HTMLButtonElement;
  note.replaceChildren();
  bouton.hidden = !jeRegarde;
  note.hidden = !jeRegarde;
  $("chat-in").hidden = false;
  if (!jeRegarde) return;

  // SUR LE SALON STAR, IL N'A PAS DE COMPTE, donc pas de chat : c'est un compte
  // qu'on lui propose, a la place meme ou il allait ecrire.
  if (salonPermanent) {
    bouton.hidden = true;
    $("chat-in").hidden = true;
    note.appendChild(document.createTextNode(
      t("Pour pouvoir participer à la grille infinie il faut s'inscrire, ça ne prend qu'une minute.")));
    const sInscrire = el("button", "lien", t("S'inscrire")) as HTMLButtonElement;
    sInscrire.type = "button";
    sInscrire.addEventListener("click", () => ouvrirLeCompte("inscription"));
    note.appendChild(sInscrire);
    return;
  }

  note.textContent = chuchote
    ? t("Vous chuchotez : seuls les autres spectateurs vous lisent.")
    : (demarree && !finie
      ? t("Vous regardez. Votre message arrivera aux joueurs à la fin de la partie.")
      : t("Vous regardez cette partie."));
  bouton.setAttribute("aria-pressed", String(chuchote));
  ($("chat-text") as HTMLInputElement).placeholder = chuchote
    ? t("Chuchoter aux spectateurs…") : t("Message…");
}

$("chat-chuchoter").addEventListener("click", () => {
  chuchote = !chuchote;
  peindreLeSpectateur();
  ($("chat-text") as HTMLInputElement).focus();
});

/**
 * LE BLOC DE LA RENCONTRE, dans le panneau du salon (SPEC.md §29).
 *
 * Contre qui l'on joue, quelle manche, ou en est le score -- et, tant que la
 * partie n'est pas partie, le bouton qui la lance. ELLE ATTEND LES DEUX CAMPS :
 * on charge une page, on s'installe, on relit le score, et c'est le joueur qui
 * dit quand il est pret.
 */
function peindreLaRencontreDuSalon(): void {
  const r = rencontreSalon;
  $("rencontre-wrap").hidden = r === null;
  if (r === null) return;
  $("rn-titre").textContent = t2("{a} contre {b}", { a: r.noms[0], b: r.noms[1] });
  $("rn-detail").textContent = [
    r.nomDuTournoi,
    t2("manche {n}", { n: r.manche }),
    t2("au meilleur de {n}", { n: r.bo }),
  ].join(" · ");
  $("rn-score").textContent = `${r.score[0]} – ${r.score[1]}`;

  const avant = !demarree && !finie;
  const monCamp = r.joueurs.findIndex((l) => l.includes(me));
  const jeSuisPret = r.prets.includes(me);
  const bouton = $("rn-pret") as HTMLButtonElement;
  bouton.hidden = !avant || monCamp < 0;
  bouton.textContent = jeSuisPret ? t("Je ne suis plus prêt") : t("Je suis prêt");
  bouton.setAttribute("aria-pressed", String(jeSuisPret));

  $("rn-attente").hidden = !avant;
  if (!avant) return;
  const pret = (i: number): boolean => r.joueurs[i]!.some((n) => r.prets.includes(n));
  const autre = monCamp === 0 ? 1 : 0;
  $("rn-attente").textContent = monCamp < 0
    ? t("La manche part quand les deux joueurs se disent prêts.")
    : pret(autre)
      ? t2("{nom} est prêt.", { nom: r.noms[autre] })
      : t2("{nom} n'est pas encore prêt.", { nom: r.noms[autre] });
}

$("rn-pret").addEventListener("click", () => envoyer({ t: "pret" }));
$("rn-page").addEventListener("click", () => {
  if (rencontreSalon !== null) ouvrirLeTournoi(rencontreSalon.tournoi);
});

/** La partie d'epreuve attend-elle qu'on la lance, et est-ce a nous de le faire ? */
function epreuveALancer(): boolean {
  return epreuve !== null && !epreuve.lancee && epreuve.compte === me && $("join").hidden === true;
}

/**
 * LE BLOC DE LA PARTIE D'EPREUVE, dans le panneau du salon (SPEC.md §29).
 *
 * Avant : comment on la joue. Pendant : la pause. Apres : les resultats.
 */
function peindreLEpreuve(): void {
  const e = epreuve;
  $("epreuve-wrap").hidden = e === null;
  if (e === null) return;
  $("ep-titre").textContent = e.config === null ? `P${e.partie}` : `P${e.partie} · ${nomDeLaPartie(e.config, t)}`;
  $("ep-detail").textContent = [
    e.tournoi?.nom ?? "",
    e.lexique === null ? "" : dictionnaire(e.lexique).nom,
    e.jour === null ? "" : jourEnLettres(e.jour),
  ].filter((x) => x !== "").join(" · ");

  const hote = e.compte === me;
  // Les comptes presents : a deux ou plus, la partie se lance en equipe.
  const comptes = online.filter((n) => inscrits.has(n));
  const aPlusieurs = comptes.length > 1;
  const avant = !e.lancee;
  $("ep-avant").hidden = !avant || !hote;
  $("ep-seul").hidden = aPlusieurs;
  $("ep-plusieurs").hidden = aPlusieurs;
  if (aPlusieurs) { $("ep-noms").hidden = true; $("ep-lancer-compte").hidden = true; }
  $("ep-equipe").hidden = !aPlusieurs;
  $("ep-attente").hidden = !avant || hote;
  $("ep-attente").textContent = t2("{nom} lance la partie.", { nom: e.compte });

  const joueur = e.equipe.includes(me);
  const enJeu = e.lancee && !finie && !e.close && joueur;
  $("ep-pause").hidden = !enJeu || enPause;
  $("ep-reprendre").hidden = !enJeu || !enPause;
  $("ep-resultats").hidden = !(finie || e.close) || (e.jour === null && e.tournoi === null);
}

$("ep-seul").addEventListener("click", () => { envoyer({ t: "epreuve-lancer", jeu: "seul" }); });
$("ep-plusieurs").addEventListener("click", () => {
  $("ep-noms").hidden = false;
  $("ep-lancer-compte").hidden = false;
  ($("ep-noms") as HTMLInputElement).focus();
});
$("ep-lancer-compte").addEventListener("click", () => {
  envoyer({ t: "epreuve-lancer", jeu: "compte", noms: ($("ep-noms") as HTMLInputElement).value });
});
$("ep-equipe").addEventListener("click", () => { envoyer({ t: "epreuve-lancer", jeu: "equipe" }); });
$("ep-inviter").addEventListener("click", () => {
  $("inviter-liste").replaceChildren(el("p", "", t("Chargement…")));
  $("voile-inviter").hidden = false;
  envoyer({ t: "connectes" });
});
$("ep-pause").addEventListener("click", () => { envoyer({ t: "pause" }); });
$("ep-reprendre").addEventListener("click", () => { envoyer({ t: "reprendre" }); });
$("ep-resultats").addEventListener("click", () => {
  const e = epreuve;
  if (e === null) return;
  const { jour, lexique, partie, tournoi } = e;
  if (tournoi !== null) {
    quitterSalon();
    ouvrirLesResultatsDuTournoi(tournoi.id, partie);
    return;
  }
  if (jour === null || lexique === null) return;
  quitterSalon();
  ouvrirLesResultats(jour, lexique, partie);
});

// ----------------------------------------------------------- LES GRAPHIQUES
//
// Voir SPEC.md §29. Sous la feuille de route, cinq onglets, a la meme condition
// qu'elle : la partie finie. Dessines en SVG, sans bibliotheque -- le client n'a
// aucune dependance, et cinq graphiques n'en justifient pas une.
//
// Ils se comptent sur les lignes que les cases laissent, comme « Trouve par ».
// Les couleurs sont celles du theme : l'encre pour la table, l'accent pour vous,
// l'avertissement pour un coup rate -- c'est deja ce que dit la feuille de route.

type Graphe = "temps" | "course" | "difficulte" | "rang" | "repartition" | "rates";

const GRAPHES: { v: Graphe; nom: string }[] = [
  { v: "temps", nom: "Temps par coup" },
  { v: "rang", nom: "Rang au fil des coups" },
  { v: "repartition", nom: "Répartition des temps" },
  { v: "course", nom: "Écart au cumul médian" },
  { v: "difficulte", nom: "Difficulté des coups" },
  { v: "rates", nom: "Coups ratés" },
];

let rsGraphe: Graphe = "temps";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Un element SVG, ses attributs, et son infobulle s'il en a une. */
function svgEl(tag: string, attrs: Record<string, string | number>, titre?: string): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (titre !== undefined) {
    const t0 = document.createElementNS(SVG_NS, "title");
    t0.textContent = titre;
    e.appendChild(t0);
  }
  return e;
}

/** La mediane d'une liste de nombres. */
function mediane(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Un ecart deterministe dans [-1, 1], pour que les points ne s'empilent pas. */
function ecartDe(cle: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cle.length; i++) h = Math.imul(h ^ cle.charCodeAt(i), 0x01000193) >>> 0;
  return (h % 2001) / 1000 - 1;
}

/** Une duree courte, lisible sur un axe : `800 ms`, `2 s`, `1 min`. */
function dureeDAxe(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const min = ms / 60_000;
  return Number.isInteger(min) ? `${min} min` : `${Math.round(min * 10) / 10} min`;
}

/** Le cadre commun : une zone de trace, et de quoi y placer les coups. */
interface Cadre {
  svg: SVGElement;
  g: number; d: number; h: number; b: number;
  largeur: number; hauteur: number;
  xCoup: (n: number) => number;
  pas: number;
}

function cadre(nCoups: number, droite = 16): Cadre {
  const largeur = 900, hauteur = 280;
  const g = 58, h = 12, b = 30, d = droite;
  const svg = svgEl("svg", { viewBox: `0 0 ${largeur} ${hauteur}`, role: "img" });
  const pas = (largeur - g - d) / Math.max(1, nCoups);
  const c: Cadre = {
    svg, g, d, h, b, largeur, hauteur, pas,
    xCoup: (n) => g + (n - 0.5) * pas,
  };
  // L'axe des coups : un numero sur deux quand ils sont nombreux.
  const saut = nCoups > 30 ? 5 : nCoups > 15 ? 2 : 1;
  for (let n = 1; n <= nCoups; n++) {
    if (n !== 1 && n % saut !== 0) continue;
    svg.appendChild(svgEl("text", {
      x: c.xCoup(n), y: hauteur - b + 17, "text-anchor": "middle", class: "g-texte",
    })).textContent = String(n);
  }
  svg.appendChild(svgEl("text", {
    x: largeur - d, y: hauteur - 2, "text-anchor": "end", class: "g-texte",
  })).textContent = t("coup");
  return c;
}

/** Une ligne de grille horizontale et son etiquette. */
function repere(c: Cadre, y: number, texte: string, classe = "g-grille"): void {
  c.svg.appendChild(svgEl("line", { x1: c.g, x2: c.largeur - c.d, y1: y, y2: y, class: classe }));
  c.svg.appendChild(svgEl("text", {
    x: c.g - 8, y: y + 4, "text-anchor": "end", class: "g-texte",
  })).textContent = texte;
}

/** Une ligne brisee a partir de points. */
function trace(points: [number, number][], classe: string, style = ""): SVGElement {
  return svgEl("polyline", {
    points: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
    class: classe, ...(style === "" ? {} : { style }),
  });
}

/**
 * 6. LES COUPS RATES : un tableau, et non un graphique.
 *
 * UNE LIGNE PAR JOUEUR, UNE COLONNE PAR COUP, et dans la case ce qu'il a laisse
 * au top. Une case vide veut dire qu'il l'a trouve. C'est la lecture des
 * tableaux de duplicate : on voit d'un coup d'oeil quel coup a coute cher a
 * tout le monde, et qui l'a pris.
 *
 * L'en-tete d'une colonne porte le numero du coup, le mot retenu ECRIT EN
 * COLONNE -- vingt-cinq mots a l'horizontale ne tiennent sur aucun ecran -- et
 * ce qu'il valait.
 */
function teinteDuCoup(o: {
  perdu: number; score: number; ms: number; mediane: number; chronoMs: number;
}): string {
  // LE ROUGE NE CONNAIT QU'UNE MESURE : la part du coup qu'on a laissee. Tout
  // perdre le rend plein, deux points sur cinquante le laissent a peine.
  if (o.perdu > 0) {
    const part = Math.min(1, o.perdu / Math.max(1, o.score));
    return `color-mix(in srgb, var(--mct) ${(9 + 66 * part).toFixed(1)}%, transparent)`;
  }
  const chrono = Math.max(1, o.chronoMs);
  const brut = 1 - Math.min(1, o.ms / chrono);
  const relatif = Math.min(1, Math.max(0, 0.5 + (o.mediane - o.ms) / chrono));
  const v = 0.55 * brut + 0.45 * relatif;
  return `color-mix(in srgb, var(--accent) ${(10 + 82 * v).toFixed(1)}%, transparent)`;
}

function tableauDesCoupsRates(
  lignes: LigneVue[], vue: LigneVue, details: Record<string, CoupVue[]>, chronoMs: number,
): HTMLElement {
  const modele = details[vue.manche] ?? [];
  const boite = el("div", "g-tableur");
  if (modele.length === 0) {
    boite.appendChild(tableauVide(t("Aucun coup à montrer.")));
    return boite;
  }
  const table = el("table");

  const tete = el("thead");
  const tr = el("tr");
  // LES DEUX PREMIERES COLONNES TRIENT, comme celles du classement au-dessus :
  // c'est le meme classement, et il n'a pas a se lire dans deux ordres.
  const colonne = (classe: string, texte: string, tri: "temps" | "negatif"): HTMLElement => {
    const th = el("th", classe, texte);
    th.classList.add("triable");
    // LA FLECHE EST TOUJOURS LA, creuse quand la colonne ne trie pas : elle
    // elargissait sinon sa colonne au clic, et tout le tableau se decalait.
    if (rsTri === tri) th.classList.add("tri");
    th.appendChild(el("span", `rc-tri${rsTri === tri ? "" : " creux"}`, "▾"));
    th.addEventListener("click", () => { rsTri = tri; peindreLesResultats(); });
    return th;
  };
  tr.append(colonne("tb-rang", t("Rang"), "temps"), el("th", "tb-nom", t("Joueur")),
    colonne("tb-neg", t("Nég"), "negatif"));
  for (const c of modele) {
    const th = el("th", "tb-coup");
    th.title = `${t("Coup")} ${c.n} · ${c.mot} · ${c.score} ${t("points")}`;
    th.appendChild(el("span", "tb-n", String(c.n)));
    const mot = el("span", "tb-mot");
    for (const lettre of c.mot) mot.appendChild(el("span", "", lettre));
    th.appendChild(mot);
    th.appendChild(el("span", "tb-pts", String(c.score)));
    tr.appendChild(th);
  }
  tete.appendChild(tr);
  table.appendChild(tete);

  // LA MEDIANE DE CEUX QUI ONT TROUVE, coup par coup : c'est a elle que la
  // teinte compare chacun. On prend la mediane et non le plus rapide -- a deux
  // joueurs, le second passait sinon au plus pale pour deux dixiemes de retard.
  const medianes = new Map<number, number>();
  for (const c of modele) {
    const temps: number[] = [];
    for (const l of lignes) {
      const sien = details[l.manche]?.find((x) => x.n === c.n);
      if (sien !== undefined && (sien.prop?.score ?? 0) >= c.score) temps.push(sien.ms);
    }
    if (temps.length > 0) {
      temps.sort((a, b) => a - b);
      medianes.set(c.n, temps[(temps.length - 1) >> 1] ?? 0);
    }
  }

  const corps = el("tbody");
  for (const { l, rang } of classer(lignes)) {
    const ligne = el("tr");
    if (l.manche === vue.manche) ligne.classList.add("tb-vue");
    ligne.appendChild(el("td", "tb-rang", String(rang)));
    const nom = celluleDuJoueur(l);
    nom.className = "tb-nom";
    ligne.appendChild(nom);
    ligne.appendChild(el("td", "tb-neg", l.negatif === 0 ? "" : String(l.negatif)));
    const siens = details[l.manche];
    for (const c of modele) {
      const sien = siens?.find((x) => x.n === c.n);
      // LA CASE VIDE VEUT DIRE « TROUVE » : c'est ce qui fait qu'un tableau
      // rempli de blancs se lit, et qu'un coup rate par tous saute aux yeux.
      const perdu = sien === undefined ? null : c.score - (sien.prop?.score ?? 0);
      const td = el("td", "tb-case", perdu === null || perdu <= 0 ? "" : String(perdu));
      if (perdu !== null && perdu > 0) td.classList.add("tb-rate");
      if (sien !== undefined && perdu !== null) {
        td.style.setProperty("--teinte", teinteDuCoup({
          perdu, score: c.score, ms: sien.ms,
          mediane: medianes.get(c.n) ?? sien.ms, chronoMs,
        }));
        td.title = perdu > 0
          ? `${nomDeLaLigne(l)} · ${t2("{n} de moins", { n: perdu })}`
          : `${nomDeLaLigne(l)} · ${tempsCentiemes(sien.ms)}`;
      }
      ligne.appendChild(td);
    }
    corps.appendChild(ligne);
  }
  table.appendChild(corps);
  boite.appendChild(table);
  return boite;
}

/** La legende sous le graphique : une pastille, un mot. */
function legende(elements: { classe: string; texte: string; style?: string }[]): void {
  const p = $("rs-graphe-legende");
  p.replaceChildren(...elements.map((e) => {
    const s = el("span", "g-cle");
    const pastille = el("i", e.classe);
    if (e.style !== undefined) pastille.setAttribute("style", e.style);
    s.appendChild(pastille);
    s.appendChild(document.createTextNode(e.texte));
    return s;
  }));
}

/**
 * Les graphiques de la partie, pour la ligne regardee.
 *
 * `lignes` sont celles que les cases laissent, `vue` celle dont la feuille est
 * ouverte : c'est elle qui porte la couleur d'accent.
 */
function peindreLesGraphes(
  d: ResultatsVue, lignes: LigneVue[], vue: LigneVue, details: Record<string, CoupVue[]>,
): void {
  $("rs-graphes").hidden = false;
  $("rs-graphes-onglets").replaceChildren(...GRAPHES.map((x) => {
    const b = el("button", "", t(x.nom)) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(x.v === rsGraphe));
    b.addEventListener("click", () => {
      rsGraphe = x.v;
      peindreLesGraphes(d, lignes, vue, details);
    });
    return b;
  }));
  const partie = d.parties.find((p) => p.n === d.partie);
  const chronoMs = (partie?.config.chrono ?? 60) * 1000;
  const miens = details[vue.manche] ?? [];
  const nCoups = miens.length;
  // Les lignes qui ont un detail, la ligne regardee toujours comprise.
  const avec = lignes.filter((l) => details[l.manche] !== undefined);
  if (!avec.some((l) => l.manche === vue.manche)) avec.push(vue);
  const boite = $("rs-graphe");
  // LES COUPS RATES SONT UN TABLEAU, pas un dessin : ce qu'on y cherche est un
  // nombre par joueur et par coup, et un nuage de points ne le donnerait pas.
  if (rsGraphe === "rates") {
    // LA LEGENDE DIT LE DEGRADE, sans quoi une case verte pale ne se distingue
    // pas d'une case vide : les deux veulent dire des choses opposees.
    legende([
      { classe: "g-cle-carre", texte: t("trouvé vite"), style: "background: color-mix(in srgb, var(--accent) 78%, transparent)" },
      { classe: "g-cle-carre", texte: t("trouvé tard"), style: "background: color-mix(in srgb, var(--accent) 15%, transparent)" },
      { classe: "g-cle-carre", texte: t("raté de peu"), style: "background: color-mix(in srgb, var(--mct) 20%, transparent)" },
      { classe: "g-cle-carre", texte: t("raté en entier"), style: "background: color-mix(in srgb, var(--mct) 75%, transparent)" },
    ]);
    boite.replaceChildren(tableauDesCoupsRates(avec, vue, details, chronoMs));
    return;
  }
  let c: Cadre;
  if (rsGraphe === "temps") c = grapheDesTemps(avec, vue, details, nCoups, chronoMs);
  else if (rsGraphe === "course") c = grapheDeLaCourse(avec, vue, details, nCoups);
  else if (rsGraphe === "difficulte") c = grapheDeLaDifficulte(avec, vue, details, nCoups);
  else if (rsGraphe === "rang") c = grapheDuRang(avec, vue, details, nCoups);
  else c = grapheDeLaRepartition(avec, vue);
  boite.replaceChildren(c.svg);
}

/** 1. LE TEMPS DE CHACUN SUR CHAQUE COUP, en echelle logarithmique. */
function grapheDesTemps(
  lignes: LigneVue[], vue: LigneVue, details: Record<string, CoupVue[]>, nCoups: number, chronoMs: number,
): Cadre {
  const c = cadre(nCoups);
  // Sur une echelle lineaire, un coup trouve en deux secondes s'ecrase contre
  // l'axe des qu'un autre en demande trente.
  const trouves = lignes.flatMap((l) => (details[l.manche] ?? []).filter((x) => x.trouve).map((x) => x.ms));
  const bas = Math.max(100, Math.min(chronoMs / 20, ...trouves) / 1.4);
  const haut = chronoMs * 1.08;
  const y = (ms: number): number => c.h + (c.hauteur - c.h - c.b)
    * (1 - (Math.log(Math.max(bas, ms)) - Math.log(bas)) / (Math.log(haut) - Math.log(bas)));
  for (const s of [0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 180, 300, 600]) {
    const ms = s * 1000;
    if (ms < bas || ms > haut) continue;
    repere(c, y(ms), dureeDAxe(ms));
  }
  // Les autres, en gris ; les coups rates au chrono, couleur d'avertissement.
  for (const l of lignes) {
    if (l.manche === vue.manche) continue;
    for (const x of details[l.manche] ?? []) {
      const ecart = ecartDe(`${l.manche}:${x.n}`) * c.pas * 0.3;
      c.svg.appendChild(svgEl("circle", {
        cx: (c.xCoup(x.n) + ecart).toFixed(1), cy: y(x.trouve ? x.ms : chronoMs).toFixed(1),
        r: 3, class: x.trouve ? "g-point" : "g-rate",
      }, `${nomDeLaLigne(l)} · ${t("coup")} ${x.n} · ${x.trouve ? tempsCentiemes(x.ms) : t("raté")}`));
    }
  }
  // Mediane, moyenne et meilleur temps de chaque coup.
  const med: [number, number][] = [], moy: [number, number][] = [], best: [number, number][] = [];
  for (let n = 1; n <= nCoups; n++) {
    const temps = lignes.map((l) => details[l.manche]?.[n - 1]).filter((x): x is CoupVue => x !== undefined)
      .map((x) => (x.trouve ? x.ms : chronoMs));
    if (temps.length === 0) continue;
    med.push([c.xCoup(n), y(mediane(temps))]);
    moy.push([c.xCoup(n), y(temps.reduce((a, b) => a + b, 0) / temps.length)]);
    const t2s = lignes.map((l) => details[l.manche]?.[n - 1]).filter((x) => x?.trouve === true).map((x) => x!.ms);
    if (t2s.length > 0) best.push([c.xCoup(n), y(Math.min(...t2s))]);
  }
  c.svg.appendChild(trace(best, "g-meilleur"));
  c.svg.appendChild(trace(moy, "g-moyenne"));
  c.svg.appendChild(trace(med, "g-mediane"));
  // Vous, par-dessus tout le reste.
  const miens = details[vue.manche] ?? [];
  c.svg.appendChild(trace(miens.map((x) => [c.xCoup(x.n), y(x.trouve ? x.ms : chronoMs)]), "g-moi"));
  for (const x of miens) {
    c.svg.appendChild(svgEl("circle", {
      cx: c.xCoup(x.n).toFixed(1), cy: y(x.trouve ? x.ms : chronoMs).toFixed(1), r: 4.5,
      class: x.trouve ? "g-moi-point" : "g-moi-rate",
    }, `${t("coup")} ${x.n} · ${x.trouve ? tempsCentiemes(x.ms) : t("raté")}`));
  }
  legende([
    { classe: "g-cle-moi", texte: nomDeLaLigne(vue) },
    { classe: "g-cle-mediane", texte: t("médiane") },
    { classe: "g-cle-moyenne", texte: t("moyenne") },
    { classe: "g-cle-meilleur", texte: t("meilleur temps") },
    { classe: "g-cle-point", texte: t("les autres joueurs") },
    { classe: "g-cle-rate", texte: t("coup raté") },
  ]);
  return c;
}

/**
 * 2. LA COURSE : votre temps cumule moins le cumul median, coup par coup.
 * Au-dessus de zero, on est en retard sur la mediane.
 */
function grapheDeLaCourse(
  lignes: LigneVue[], vue: LigneVue, details: Record<string, CoupVue[]>, nCoups: number,
): Cadre {
  const c = cadre(nCoups);
  const cumuls = new Map<string, number[]>();
  for (const l of lignes) {
    let s = 0;
    cumuls.set(l.manche, (details[l.manche] ?? []).map((x) => (s += x.ms)));
  }
  const ecarts: number[] = [];
  for (let n = 1; n <= nCoups; n++) {
    const med = mediane(lignes.map((l) => cumuls.get(l.manche)?.[n - 1]).filter((v): v is number => v !== undefined));
    ecarts.push((cumuls.get(vue.manche)?.[n - 1] ?? 0) - med);
  }
  // L'ECHELLE VA DE L'ECART LE PLUS BAS AU PLUS HAUT, zero compris : un joueur
  // toujours en retard n'a pas a laisser vide la moitie basse du graphique.
  const lo0 = Math.min(0, ...ecarts), hi0 = Math.max(0, ...ecarts);
  const marge = Math.max(1000, (hi0 - lo0) * 0.1);
  const lo = lo0 - marge, hi = hi0 + marge;
  const y = (v: number): number => c.h + (c.hauteur - c.h - c.b) * ((hi - v) / (hi - lo));
  const pas = pasDeDuree((hi - lo) / 5);
  for (let v = Math.ceil(lo / pas) * pas; v <= hi; v += pas) {
    if (v === 0) continue;
    repere(c, y(v), `${v > 0 ? "+" : "−"}${dureeDAxe(Math.abs(v))}`);
  }
  repere(c, y(0), t("médiane"), "g-zero");
  const points: [number, number][] = ecarts.map((v, i) => [c.xCoup(i + 1), y(v)]);
  c.svg.appendChild(trace(points, "g-moi"));
  ecarts.forEach((v, i) => {
    c.svg.appendChild(svgEl("circle", {
      cx: points[i]![0].toFixed(1), cy: points[i]![1].toFixed(1), r: 4,
      class: (details[vue.manche]?.[i]?.trouve ?? true) ? "g-moi-point" : "g-moi-rate",
    }, `${t("coup")} ${i + 1} · ${v >= 0 ? "+" : "−"}${tempsCentiemes(Math.abs(v))}`));
  });
  legende([
    { classe: "g-cle-moi", texte: t2("{nom}, écart au cumul médian", { nom: nomDeLaLigne(vue) }) },
    { classe: "g-cle-rate", texte: t("coup raté") },
  ]);
  return c;
}

/** Un pas d'axe qui se lit, pour une duree : une seconde, cinq, trente, une minute... */
function pasDeDuree(ms: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]) {
    if (s * 1000 >= ms) return s * 1000;
  }
  return 3_600_000;
}

/** Un pas d'axe rond, pour un compte : 1, 2 ou 5 fois une puissance de dix. */
function pasRond(ms: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, ms)));
  for (const k of [1, 2, 5, 10]) if (k * p >= ms) return k * p;
  return 10 * p;
}

/** 3. LA DIFFICULTE DES COUPS : la part des joueurs qui ont trouve chacun. */
function grapheDeLaDifficulte(
  lignes: LigneVue[], vue: LigneVue, details: Record<string, CoupVue[]>, nCoups: number,
): Cadre {
  const c = cadre(nCoups);
  const y = (part: number): number => c.h + (c.hauteur - c.h - c.b) * (1 - part);
  for (const p of [0.25, 0.5, 0.75, 1]) repere(c, y(p), `${p * 100} %`);
  const base = y(0);
  c.svg.appendChild(svgEl("line", { x1: c.g, x2: c.largeur - c.d, y1: base, y2: base, class: "g-zero" }));
  const largeur = Math.max(3, c.pas - 4);
  for (let n = 1; n <= nCoups; n++) {
    const leurs = lignes.map((l) => details[l.manche]?.[n - 1]).filter((x): x is CoupVue => x !== undefined);
    const trouves = leurs.filter((x) => x.trouve).length;
    const part = leurs.length === 0 ? 0 : trouves / leurs.length;
    const haut = base - y(part);
    const moi = details[vue.manche]?.[n - 1];
    const x0 = c.xCoup(n) - largeur / 2;
    const r = Math.min(4, largeur / 2, haut);
    // Le haut arrondi, la base posee sur l'axe.
    c.svg.appendChild(svgEl("path", {
      d: haut <= 0 ? "" : `M${x0},${base} V${base - haut + r} Q${x0},${base - haut} ${x0 + r},${base - haut} `
        + `H${x0 + largeur - r} Q${x0 + largeur},${base - haut} ${x0 + largeur},${base - haut + r} V${base} Z`,
      class: moi?.trouve === false ? "g-barre g-barre-ratee" : "g-barre",
    }, `${t("coup")} ${n} · ${trouves}/${leurs.length} (${Math.round(part * 100)} %)`));
  }
  legende([
    { classe: "g-cle-barre", texte: t2("coups trouvés par {nom}", { nom: nomDeLaLigne(vue) }) },
    { classe: "g-cle-barre-ratee", texte: t2("coups ratés par {nom}", { nom: nomDeLaLigne(vue) }) },
  ]);
  return c;
}

/** 4. LE RANG AU FIL DES COUPS, pour les dix premiers et pour vous. */
function grapheDuRang(
  lignes: LigneVue[], vue: LigneVue, details: Record<string, CoupVue[]>, nCoups: number,
): Cadre {
  const c = cadre(nCoups, 110);
  const cumuls = new Map<string, number[]>();
  for (const l of lignes) {
    let s = 0;
    cumuls.set(l.manche, (details[l.manche] ?? []).map((x) => (s += x.ms)));
  }
  const rangs = new Map<string, number[]>();
  for (const l of lignes) rangs.set(l.manche, []);
  for (let n = 1; n <= nCoups; n++) {
    const ordre = [...lignes].sort((a, b) =>
      (cumuls.get(a.manche)?.[n - 1] ?? Infinity) - (cumuls.get(b.manche)?.[n - 1] ?? Infinity));
    ordre.forEach((l, i) => rangs.get(l.manche)!.push(i + 1));
  }
  const final = [...lignes].sort((a, b) => a.temps - b.temps);
  const montres = final.slice(0, 10);
  if (!montres.includes(vue)) montres.push(vue);
  const maxRang = lignes.length;
  const y = (r: number): number => c.h + 8 + (c.hauteur - c.h - c.b - 16) * ((r - 1) / Math.max(1, maxRang - 1));
  const sautRang = maxRang > 20 ? 5 : maxRang > 10 ? 2 : 1;
  for (let r = 1; r <= maxRang; r++) if (r === 1 || r % sautRang === 0) repere(c, y(r), String(r));
  const etiquettes: { y: number; texte: string; couleur: string; moi: boolean }[] = [];
  for (const l of montres) {
    const moi = l.manche === vue.manche;
    const couleur = moi ? "var(--accent)" : couleurDuJoueur(l.compte);
    const pts: [number, number][] = (rangs.get(l.manche) ?? []).map((r, i) => [c.xCoup(i + 1), y(r)]);
    c.svg.appendChild(trace(pts, moi ? "g-moi" : "g-rang", `stroke: ${couleur}`));
    const dernier = pts[pts.length - 1];
    if (dernier !== undefined) etiquettes.push({ y: dernier[1], texte: nomDeLaLigne(l), couleur, moi });
  }
  // Les noms au bout de leur ligne, ecartes s'ils se touchent.
  etiquettes.sort((a, b) => a.y - b.y);
  let precedent = -Infinity;
  for (const e of etiquettes) {
    const yy = Math.max(e.y + 4, precedent + 12);
    precedent = yy;
    c.svg.appendChild(svgEl("text", {
      x: c.largeur - c.d + 8, y: yy, class: e.moi ? "g-texte g-texte-moi" : "g-texte",
    })).textContent = e.texte.length > 14 ? `${e.texte.slice(0, 13)}…` : e.texte;
  }
  legende([{ classe: "g-cle-moi", texte: t2("{nom}, et les dix premiers au temps cumulé", { nom: nomDeLaLigne(vue) }) }]);
  return c;
}

/** 5. LA REPARTITION DES TEMPS TOTAUX, et votre place dedans. */
function grapheDeLaRepartition(lignes: LigneVue[], vue: LigneVue): Cadre {
  const n = lignes.length;
  const classes = Math.max(4, Math.min(14, Math.ceil(Math.sqrt(n)) + 2));
  const mini = Math.min(...lignes.map((l) => l.temps));
  const maxi = Math.max(...lignes.map((l) => l.temps));
  const pasT = Math.max(1, (maxi - mini) / classes);
  const compte = Array.from({ length: classes }, () => 0);
  const classeDe = (tps: number): number => Math.min(classes - 1, Math.floor((tps - mini) / pasT));
  for (const l of lignes) compte[classeDe(l.temps)]!++;
  const c = cadre(0);
  // L'axe du bas est celui des temps, pas des coups : on le refait.
  c.svg.replaceChildren();
  const pas = (c.largeur - c.g - c.d) / classes;
  const plusHaut = Math.max(1, ...compte);
  const y = (v: number): number => c.h + (c.hauteur - c.h - c.b) * (1 - v / plusHaut);
  const sautV = pasRond(plusHaut / 4);
  for (let v = sautV; v <= plusHaut; v += sautV) repere(c, y(v), String(v));
  const base = y(0);
  const mienne = classeDe(vue.temps);
  compte.forEach((v, i) => {
    const x0 = c.g + i * pas + 2;
    const largeur = pas - 4;
    const haut = base - y(v);
    const r = Math.min(4, largeur / 2, haut);
    c.svg.appendChild(svgEl("path", {
      d: haut <= 0 ? "" : `M${x0},${base} V${base - haut + r} Q${x0},${base - haut} ${x0 + r},${base - haut} `
        + `H${x0 + largeur - r} Q${x0 + largeur},${base - haut} ${x0 + largeur},${base - haut + r} V${base} Z`,
      class: i === mienne ? "g-barre g-barre-moi" : "g-barre",
    }, t2("{a} à {b} : {n}", { a: tempsCentiemes(mini + i * pasT), b: tempsCentiemes(mini + (i + 1) * pasT), n: v })));
  });
  c.svg.appendChild(svgEl("line", { x1: c.g, x2: c.largeur - c.d, y1: base, y2: base, class: "g-zero" }));
  for (const i of [0, Math.floor(classes / 2), classes]) {
    c.svg.appendChild(svgEl("text", {
      x: c.g + i * pas, y: c.hauteur - c.b + 17,
      "text-anchor": i === 0 ? "start" : i === classes ? "end" : "middle", class: "g-texte",
    })).textContent = tempsCentiemes(mini + i * pasT);
  }
  const plusLents = lignes.filter((l) => l.temps > vue.temps).length;
  const part = n <= 1 ? 100 : Math.round((plusLents / (n - 1)) * 100);
  legende([
    { classe: "g-cle-barre-moi", texte: t2("{nom} : plus rapide que {p} % des joueurs", { nom: nomDeLaLigne(vue), p: part }) },
    { classe: "g-cle-barre", texte: t2("{n} joueurs, au temps total", { n }) },
  ]);
  return c;
}

// --------------------------------------------------- L'EDITEUR DE PARTIE
//
// Voir SPEC.md §29. Une partie d'epreuve ne varie que par cinq choses -- la
// grille, le format, le joker, le temps par coup, les primes -- et l'editeur ne
// montre qu'elles. Le nom se lit en direct dessous : c'est lui qu'on verifie.
//
// CHAQUE LIGNE PORTE UN BOUTON ALEATOIRE, et ce que l'editeur rend n'est donc
// pas une partie mais une CONSIGNE. Un modele de la semaine la garde telle
// quelle et la tire chaque nuit ; une partie de demain la tire tout de suite.
//
// Le meme editeur sert aux parties du jour, aux modeles de la semaine et aux
// deux tournois.

/** Ce que l'editeur regle. */
type ConsigneVue = ConsigneDePartie;

/** Un modele deja tire : ce que le serveur rend d'une partie figee. */
type ModeleVue = ModeleDePartie;

const CONSIGNE_NORMALE: ConsigneVue = {
  bornes: 7, format: { t: "exact", tirage: 7, jouables: 7 },
  egal: false, joker: 0, chrono: 60, primes: null,
};

/** Une copie franche : le format et les primes sont des objets a part. */
function clonerLaConsigne(c: ConsigneVue): ConsigneVue {
  return {
    ...c,
    format: { ...c.format },
    primes: c.primes === null || c.primes === "alea" ? c.primes : { ...c.primes },
  };
}

/** Le modele d'une configuration recue du serveur. */
function modeleDe(c: ConfigSerialisee): ModeleVue {
  return modeleDeLaConfig(c);
}

/** La consigne qui ne peut donner que cette configuration-la. */
function consigneDe(c: ConfigSerialisee): ConsigneVue {
  return consigneExacte(modeleDe(c));
}

/** Une rangee de boutons a valeur, et ce qui se passe au clic. */
function rangeeDeChoix(
  etiquette: string, choix: { v: string; texte: string }[], valeur: string, surChoix: (v: string) => void,
): { rang: HTMLElement; presser: (v: string) => void } {
  const rang = el("div", "ed-rang");
  rang.appendChild(el("label", "", etiquette));
  const boite = el("div", "rc-choix");
  const presser = (v: string): void => {
    for (const b of boite.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["v"] === v));
    }
  };
  for (const c of choix) {
    const b = el("button", "", c.texte) as HTMLButtonElement;
    b.type = "button";
    b.dataset["v"] = c.v;
    b.addEventListener("click", () => { presser(c.v); surChoix(c.v); });
    boite.appendChild(b);
  }
  rang.appendChild(boite);
  presser(valeur);
  return { rang, presser };
}

/** Un champ numerique dans une rangee. */
function champNombre(min: number, max: number, valeur: number, titre: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.min = String(min);
  i.max = String(max);
  i.value = String(valeur);
  i.title = titre;
  i.setAttribute("aria-label", titre);
  return i;
}

/** Un bouton a bascule, au bout d'une rangee : « Aléatoire », « Égal ». */
function bascule(
  texte: string, actif: boolean, surChange: (v: boolean) => void, titre = "",
): { el: HTMLButtonElement; poser: (v: boolean) => void; valeur: () => boolean } {
  const b = el("button", "ed-bascule", texte) as HTMLButtonElement;
  b.type = "button";
  if (titre !== "") b.title = titre;
  let v = actif;
  const peindre = (): void => { b.setAttribute("aria-pressed", String(v)); };
  b.addEventListener("click", () => { v = !v; peindre(); surChange(v); });
  peindre();
  return { el: b, poser: (x) => { v = x; peindre(); }, valeur: () => v };
}

/** Le nombre de caramels lu dans un champ, borne. */
function nombreLu(champ: HTMLInputElement, defaut: number): number {
  const n = Math.round(Number(champ.value));
  return Number.isFinite(n) && n >= 2 && n <= 15 ? n : defaut;
}

/**
 * L'EDITEUR DE CONSIGNE. `surChange` est prevenu a chaque reglage ; `valeur`
 * rend la consigne du moment, et `poser` en impose une autre (« Toutes comme la
 * premiere »).
 */
function editeurDePartie(
  initial: ConsigneVue, surChange: (c: ConsigneVue) => void = () => undefined,
): { el: HTMLElement; valeur: () => ConsigneVue; poser: (c: ConsigneVue) => void } {
  let c: ConsigneVue = clonerLaConsigne(initial);
  const boite = el("div", "editeur");
  const nom = el("div", "ed-nom");

  // Ce qu'on a choisi avant de passer une ligne au hasard : la revenir la rend.
  let bornes: 7 | 10 = c.bornes === "alea" ? 7 : c.bornes;
  let exact = c.format.t === "exact"
    ? { tirage: c.format.tirage, jouables: c.format.jouables } : { tirage: 7, jouables: 7 };
  let plage = c.format.t === "plage"
    ? { jouablesMin: c.format.jouablesMin, jouablesMax: c.format.jouablesMax,
        tirageMin: c.format.tirageMin, tirageMax: c.format.tirageMax }
    : { jouablesMin: 5, jouablesMax: 9, tirageMin: 10, tirageMax: 15 };
  let quelFormat: "exact" | "plage" = c.format.t === "plage" ? "plage" : "exact";
  let joker: 0 | 1 | 2 = c.joker === "alea" ? 0 : c.joker;
  let chrono = c.chrono === "alea" ? 60 : c.chrono;
  let primes: Record<number, number> | null = c.primes === "alea" || c.primes === null ? null : c.primes;

  const changer = (): void => {
    peuplerLesPrimes();
    nom.replaceChildren(document.createTextNode(`${t("Nom de la partie")} : `),
      el("b", "", nomDeLaConsigne(c, t)));
    surChange(clonerLaConsigne(c));
  };

  // ------------------------------------------------------------- la grille
  const grille = rangeeDeChoix(t("Grille"), [
    { v: "7", texte: t("Normale") }, { v: "10", texte: t("Super grille") },
  ], String(bornes), (v) => {
    bornes = v === "10" ? 10 : 7;
    c.bornes = bornes;
    changer();
  });
  const grilleAlea = bascule(t("Aléatoire"), c.bornes === "alea", (on) => {
    c.bornes = on ? "alea" : bornes;
    grille.rang.classList.toggle("ed-mort", on);
    changer();
  }, t("Normale ou super grille, à pile ou face"));
  grille.rang.classList.toggle("ed-mort", c.bornes === "alea");
  grille.rang.appendChild(grilleAlea.el);

  // -------------------------------------------------------------- le format
  const posables = champNombre(2, 15, exact.jouables, t("Lettres posables"));
  const tires = champNombre(2, 15, exact.tirage, t("Lettres tirées"));
  const autreTirage = el("span", "");
  autreTirage.append(document.createTextNode(` ${t("sur")} `), tires);
  const autreFormat = el("span", "ed-rang");
  autreFormat.append(posables, autreTirage);

  const pJMin = champNombre(2, 15, plage.jouablesMin, t("Posables au moins"));
  const pJMax = champNombre(2, 15, plage.jouablesMax, t("Posables au plus"));
  const pTMin = champNombre(2, 15, plage.tirageMin, t("Tirées au moins"));
  const pTMax = champNombre(2, 15, plage.tirageMax, t("Tirées au plus"));
  const plageTirage = el("span", "");
  plageTirage.append(document.createTextNode(` ${t("sur")} `), pTMin,
    document.createTextNode(` ${t("à")} `), pTMax);
  const plageFormat = el("span", "ed-rang");
  plageFormat.append(document.createTextNode(`${t("De")} `), pJMin,
    document.createTextNode(` ${t("à")} `), pJMax, plageTirage);

  const choixDuFormat = (): string =>
    quelFormat === "plage" ? "plage"
      : exact.tirage === 7 && exact.jouables === 7 ? "7/7"
        : exact.tirage === 8 && exact.jouables === 7 ? "7/8"
          : exact.tirage === 8 && exact.jouables === 8 ? "8/8" : "autre";
  let choix = choixDuFormat();

  const poserLeFormat = (): void => {
    c.format = formatAlea.valeur() ? { t: "alea" }
      : quelFormat === "plage" ? { t: "plage", ...plage }
        : { t: "exact", tirage: exact.tirage, jouables: exact.jouables };
  };
  const montrerLeFormat = (): void => {
    const alea = formatAlea.valeur();
    format.rang.classList.toggle("ed-mort", alea);
    autreFormat.hidden = alea || choix !== "autre";
    plageFormat.hidden = alea || choix !== "plage";
    autreTirage.hidden = c.egal;
    plageTirage.hidden = c.egal;
  };
  const remplirLeFormat = (): void => {
    posables.value = String(exact.jouables);
    tires.value = String(exact.tirage);
    pJMin.value = String(plage.jouablesMin);
    pJMax.value = String(plage.jouablesMax);
    pTMin.value = String(plage.tirageMin);
    pTMax.value = String(plage.tirageMax);
  };

  const format = rangeeDeChoix(t("Format"), [
    { v: "7/7", texte: t("7 sur 7") }, { v: "7/8", texte: t("7 sur 8") },
    { v: "8/8", texte: t("8 sur 8") }, { v: "autre", texte: t("Autre") },
    { v: "plage", texte: t("Plage") },
  ], choix, (v) => {
    choix = v;
    quelFormat = v === "plage" ? "plage" : "exact";
    if (v === "7/7") { exact.jouables = 7; exact.tirage = 7; }
    if (v === "7/8") { exact.jouables = 7; exact.tirage = 8; }
    if (v === "8/8") { exact.jouables = 8; exact.tirage = 8; }
    if (c.egal) exact.tirage = exact.jouables;
    remplirLeFormat();
    montrerLeFormat();
    poserLeFormat();
    changer();
  });
  const formatAlea = bascule(t("Aléatoire"), c.format.t === "alea", () => {
    montrerLeFormat();
    poserLeFormat();
    changer();
  }, t("Le tirage de 2 à 15 lettres, les posables de 2 au tirage"));
  const egal = bascule(t("Égal"), c.egal, (on) => {
    c.egal = on;
    if (on) { exact.tirage = exact.jouables; remplirLeFormat(); }
    montrerLeFormat();
    poserLeFormat();
    changer();
  }, t("Le tirage et les posables sont le même nombre : 2 sur 2, 3 sur 3…"));
  format.rang.append(autreFormat, plageFormat, formatAlea.el, egal.el);

  const surLesNombres = (): void => {
    exact.jouables = nombreLu(posables, exact.jouables);
    exact.tirage = c.egal ? exact.jouables : nombreLu(tires, exact.tirage);
    plage.jouablesMin = nombreLu(pJMin, plage.jouablesMin);
    plage.jouablesMax = nombreLu(pJMax, plage.jouablesMax);
    plage.tirageMin = nombreLu(pTMin, plage.tirageMin);
    plage.tirageMax = nombreLu(pTMax, plage.tirageMax);
    poserLeFormat();
    changer();
  };
  for (const champ of [posables, tires, pJMin, pJMax, pTMin, pTMax]) {
    champ.addEventListener("input", surLesNombres);
  }

  // --------------------------------------------------------------- le joker
  const jokerRang = rangeeDeChoix(t("Joker"), [
    { v: "0", texte: t("Sans") }, { v: "1", texte: t("Un") }, { v: "2", texte: t("Deux") },
  ], String(joker), (v) => {
    joker = (v === "2" ? 2 : v === "1" ? 1 : 0);
    c.joker = joker;
    changer();
  });
  const jokerAlea = bascule(t("Aléatoire"), c.joker === "alea", (on) => {
    c.joker = on ? "alea" : joker;
    jokerRang.rang.classList.toggle("ed-mort", on);
    changer();
  }, t("Sans, un ou deux jokers"));
  jokerRang.rang.classList.toggle("ed-mort", c.joker === "alea");
  jokerRang.rang.appendChild(jokerAlea.el);

  // -------------------------------------------------------- le temps par coup
  const CHRONOS = [15, 30, 60, 90, 120, 180];
  const secondes = champNombre(5, 3600, chrono, t("Secondes par coup"));
  secondes.max = "3600";
  const autreChrono = el("span", "ed-rang");
  autreChrono.append(secondes, document.createTextNode(` ${t("secondes")}`));
  const chronoRang = rangeeDeChoix(t("Temps par coup"), [
    ...CHRONOS.map((x) => ({ v: String(x), texte: chronoDuNom(x) })), { v: "autre", texte: t("Autre") },
  ], CHRONOS.includes(chrono) ? String(chrono) : "autre", (v) => {
    autreChrono.hidden = v !== "autre" || chronoAlea.valeur();
    if (v !== "autre") chrono = Number(v);
    secondes.value = String(chrono);
    c.chrono = chrono;
    changer();
  });
  const chronoAlea = bascule(t("Aléatoire"), c.chrono === "alea", (on) => {
    c.chrono = on ? "alea" : chrono;
    chronoRang.rang.classList.toggle("ed-mort", on);
    autreChrono.hidden = on || CHRONOS.includes(chrono);
    changer();
  }, t("De 15 secondes à 3 minutes"));
  chronoRang.rang.classList.toggle("ed-mort", c.chrono === "alea");
  chronoRang.rang.append(autreChrono, chronoAlea.el);
  autreChrono.hidden = c.chrono === "alea" || CHRONOS.includes(chrono);
  secondes.addEventListener("input", () => {
    const s = Math.round(Number(secondes.value));
    if (Number.isFinite(s) && s >= 5 && s <= 3600) chrono = s;
    c.chrono = chrono;
    changer();
  });

  // --------------------------------------------------------------- les primes
  //
  // UNE CASE PAR NOMBRE DE CARAMELS POSABLES. Au-dela de ce que le format
  // permet, la prime ne servirait jamais -- et quand le format est au hasard,
  // on montre tout : la partie tiree peut poser quinze caramels.
  const grillePrimes = el("div", "primes-grille");
  let primesAffichees = -1;
  const jouablesMax = (): number =>
    c.format.t === "exact" ? c.format.jouables : c.format.t === "plage" ? c.format.jouablesMax : 15;
  function peuplerLesPrimes(): void {
    const max = jouablesMax();
    if (max === primesAffichees) return;
    primesAffichees = max;
    grillePrimes.replaceChildren();
    for (let n = 2; n <= max; n++) {
      const l = document.createElement("label");
      l.className = "prime";
      const champ = document.createElement("input");
      champ.type = "text";
      champ.inputMode = "numeric";
      champ.maxLength = 4;
      champ.value = String(primes?.[n] ?? 0);
      champ.addEventListener("input", () => {
        const propre = champ.value.replace(/[^0-9]/g, "");
        if (propre !== champ.value) champ.value = propre;
        primes = primes ?? {};
        primes[n] = Math.max(0, Math.min(9999, Number(propre) || 0));
        if (c.primes !== "alea") c.primes = primes;
        changer();
      });
      const b = document.createElement("b");
      b.textContent = String(n);
      l.append(b, champ);
      grillePrimes.appendChild(l);
    }
  }
  const primesRang = rangeeDeChoix(t("Primes de farfouilles"), [
    { v: "usage", texte: t("Habituelles") }, { v: "libres", texte: t("Choisies") },
  ], primes === null ? "usage" : "libres", (v) => {
    if (v === "usage") { primes = null; c.primes = null; }
    else {
      primes = primes ?? primesDUsage(jouablesMax());
      c.primes = primes;
      primesAffichees = -1;
    }
    grillePrimes.hidden = v !== "libres";
    changer();
  });
  const primesAlea = bascule(t("Aléatoire"), c.primes === "alea", (on) => {
    c.primes = on ? "alea" : primes;
    primesRang.rang.classList.toggle("ed-mort", on);
    grillePrimes.hidden = on || primes === null;
    changer();
  }, t("Un seuil et une progression tirés au sort"));
  primesRang.rang.classList.toggle("ed-mort", c.primes === "alea");
  primesRang.rang.appendChild(primesAlea.el);
  grillePrimes.hidden = c.primes === "alea" || primes === null;

  boite.append(grille.rang, format.rang, jokerRang.rang, chronoRang.rang,
    primesRang.rang, grillePrimes, nom);
  montrerLeFormat();
  changer();

  const poser = (x: ConsigneVue): void => {
    c = clonerLaConsigne(x);
    if (c.bornes !== "alea") bornes = c.bornes;
    grille.presser(String(bornes));
    grilleAlea.poser(c.bornes === "alea");
    grille.rang.classList.toggle("ed-mort", c.bornes === "alea");

    if (c.format.t === "exact") {
      quelFormat = "exact";
      exact = { tirage: c.format.tirage, jouables: c.format.jouables };
    } else if (c.format.t === "plage") {
      quelFormat = "plage";
      plage = { jouablesMin: c.format.jouablesMin, jouablesMax: c.format.jouablesMax,
        tirageMin: c.format.tirageMin, tirageMax: c.format.tirageMax };
    }
    choix = choixDuFormat();
    format.presser(choix);
    formatAlea.poser(c.format.t === "alea");
    egal.poser(c.egal);
    remplirLeFormat();
    montrerLeFormat();

    if (c.joker !== "alea") joker = c.joker;
    jokerRang.presser(String(joker));
    jokerAlea.poser(c.joker === "alea");
    jokerRang.rang.classList.toggle("ed-mort", c.joker === "alea");

    if (c.chrono !== "alea") chrono = c.chrono;
    chronoRang.presser(CHRONOS.includes(chrono) ? String(chrono) : "autre");
    chronoAlea.poser(c.chrono === "alea");
    chronoRang.rang.classList.toggle("ed-mort", c.chrono === "alea");
    autreChrono.hidden = c.chrono === "alea" || CHRONOS.includes(chrono);
    secondes.value = String(chrono);

    primes = c.primes === "alea" || c.primes === null ? primes : { ...c.primes };
    primesRang.presser(c.primes === null ? "usage" : "libres");
    primesAlea.poser(c.primes === "alea");
    primesRang.rang.classList.toggle("ed-mort", c.primes === "alea");
    grillePrimes.hidden = c.primes === "alea" || c.primes === null;
    primesAffichees = -1;

    changer();
  };
  return { el: boite, valeur: () => clonerLaConsigne(c), poser };
}

/** Envoie un formulaire au serveur, et rend sa reponse ou son erreur. */
async function envoyerAuServeur(url: string, corps: unknown): Promise<{ ok: boolean; d: any }> {
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corps),
    });
    return { ok: r.ok, d: await r.json() };
  } catch {
    return { ok: false, d: { erreur: "serveur injoignable" } };
  }
}

/** Montre une erreur dans sa boite, ou la cache. */
function direLErreur(boite: HTMLElement, message: string | null): void {
  boite.textContent = message === null ? "" : t(message);
  boite.hidden = message === null;
}

// ------------------------------------------------- LES PRIMES D'UNE PARTIE
//
// PERSONNE NE DEVINE UNE PRIME DE 500 POINTS A CINQ CARAMELS (SPEC.md §29), et
// une partie se joue tout autrement quand on la sait. Le nom d'une partie dit
// donc que ses primes sortent de l'usage, et ce bout de nom s'ouvre.

/** Une partie a-t-elle des primes qui sortent de l'usage ? */
function primesCustom(c: { primes?: Readonly<Record<number, number>>; jouables: number }): boolean {
  return primesLibres(c.primes, c.jouables);
}

/**
 * Le nom d'une partie, ecrit dans `dans`. Le dernier morceau devient un bouton
 * quand les primes ne sont pas celles d'usage.
 */
function ecrireLeNomDeLaPartie(
  c: ConfigSerialisee | ConfigPartie, dans: HTMLElement, avecBouton = true,
): HTMLElement {
  const custom = primesCustom(c);
  // TOUT SUR UNE LIGNE : le nom et son dernier morceau vivent dans la meme
  // boite en ligne, sinon une colonne les separe en deux lignes.
  const ligne = el("span", "nom-partie");
  const sansPrimes = nomDeLaPartie({ ...c, primes: undefined }, t);
  ligne.appendChild(document.createTextNode(custom ? `${sansPrimes}, ` : sansPrimes));
  if (custom && avecBouton) {
    const b = el("button", "primes-libres", t("primes de farfouilles custom")) as HTMLButtonElement;
    b.type = "button";
    b.title = t("Voir les primes de cette partie");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      ouvrirLesPrimes(c);
    });
    ligne.appendChild(b);
  } else if (custom) {
    // Dans la barre du salon, la pastille entiere est deja un bouton : un
    // bouton dans un bouton ne se fait pas.
    ligne.appendChild(el("span", "primes-libres", t("primes de farfouilles custom")));
  }
  dans.appendChild(ligne);
  return dans;
}

/** La table des primes d'une partie, case par case, en face de l'usage. */
function ouvrirLesPrimes(c: ConfigSerialisee | ConfigPartie): void {
  const custom = primesCustom(c);
  $("primes-titre").textContent = t("Primes de farfouilles");
  $("primes-quoi").textContent = custom
    ? t("Les primes de cette partie ne sont pas standards.")
    : t("Les primes sont standards.");
  const usage = primesDUsage(c.jouables);
  const table = el("table");
  table.appendChild(tete([
    { texte: t("Lettres posées") }, { texte: t("Prime") }, { texte: t("Standard") },
  ]));
  const corps = el("tbody");
  for (let n = 2; n <= c.jouables; n++) {
    const valeur = c.primes[n] ?? 0, ordinaire = usage[n] ?? 0;
    if (valeur === 0 && ordinaire === 0) continue;
    const tr = el("tr");
    if (valeur !== ordinaire) tr.classList.add("change");
    tr.append(el("td", "", String(n)), el("td", "", String(valeur)), el("td", "", String(ordinaire)));
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  $("primes-vue").replaceChildren(table);
  $("voile-primes").hidden = false;
}

$("primes-close").addEventListener("click", () => { $("voile-primes").hidden = true; });
$("voile-primes").addEventListener("click", (e) => {
  if (e.target === $("voile-primes")) $("voile-primes").hidden = true;
});

/**
 * LE TYPE DE PARTIE, DANS LA BARRE DU SALON. On joue mieux en sachant qu'on
 * joue une 7/8 joker, et c'est la seule chose qui le dise pendant la partie.
 */
function peindreLeTypeDePartie(): void {
  const b = $("type-partie") as HTMLButtonElement;
  b.replaceChildren();
  ecrireLeNomDeLaPartie(cfg, b, false);
  b.hidden = false;
  b.title = primesCustom(cfg)
    ? t("Voir les primes de cette partie") : t("Ce que cette partie a de particulier");
  b.onclick = () => ouvrirLesPrimes(cfg);
}

/** LES PAGES DU SITE : en montrer une, c'est cacher toutes les autres. */
const CORPS = ["corps-partie", "corps-salons", "corps-profil", "corps-solveur", "corps-records",
  "corps-competitif", "corps-resultats", "corps-admin", "corps-tournoi", "corps-palmares",
  "corps-perso", "corps-defi"];

function montrerLaPage(id: string): void {
  for (const x of CORPS) $(x).hidden = x !== id;
  $("join").hidden = false;
}

// ------------------------------------------------- CHOISIR DES JOUEURS
//
// LA MEME FENETRE DEFIE ET INVITE A UN TOURNOI (SPEC.md §29). Elle liste les
// comptes du site, connectes ou non : une notification les rattrape.

let choixSelection = new Set<string>();
let choixTous: string[] = [];
/** Ceux qu'on n'a pas a proposer : ils sont deja la. */
let choixSauf = new Set<string>();
let choixFaire: ((pseudos: string[]) => Promise<string | null>) | null = null;

async function choisirDesJoueurs(o: {
  titre: string; quoi: string; valider: string; lien?: string; sauf?: string[];
  faire: (pseudos: string[]) => Promise<string | null>;
}): Promise<void> {
  choixSelection = new Set();
  choixFaire = o.faire;
  choixSauf = new Set(o.sauf ?? []);
  $("choix-titre").textContent = o.titre;
  $("choix-quoi").textContent = o.quoi;
  $("choix-quoi").hidden = o.quoi === "";
  ($("choix-valider") as HTMLButtonElement).textContent = o.valider;
  ($("choix-filtre") as HTMLInputElement).value = "";
  direLErreur($("choix-error"), null);
  const lien = $("choix-lien") as HTMLButtonElement;
  lien.hidden = o.lien === undefined;
  lien.textContent = t("Copier le lien");
  lien.onclick = o.lien === undefined ? null : () => { void copierLeLien(o.lien!, lien); };
  $("choix-liste").replaceChildren(el("div", "none", t("Chargement…")));
  $("voile-choix").hidden = false;
  try {
    const r = await fetch("/api/comptes");
    const d = await r.json();
    choixTous = (d.pseudos ?? []) as string[];
  } catch {
    choixTous = [];
  }
  peindreLeChoix();
}

function peindreLeChoix(): void {
  const q = ($("choix-filtre") as HTMLInputElement).value.trim().toLowerCase();
  const moi = moiCompte?.pseudo ?? "";
  const vus = choixTous.filter((n) =>
    n !== moi && !choixSauf.has(n) && (q === "" || n.toLowerCase().includes(q)));
  if (vus.length === 0) {
    $("choix-liste").replaceChildren(el("div", "none", t("Aucun compte à ce nom.")));
    return;
  }
  $("choix-liste").replaceChildren(...vus.map((n) => {
    const b = el("button", "", n) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(choixSelection.has(n)));
    b.addEventListener("click", () => {
      if (choixSelection.has(n)) choixSelection.delete(n); else choixSelection.add(n);
      b.setAttribute("aria-pressed", String(choixSelection.has(n)));
    });
    return b;
  }));
}

($("choix-filtre") as HTMLInputElement).addEventListener("input", () => peindreLeChoix());
$("choix-close").addEventListener("click", () => { $("voile-choix").hidden = true; });
$("voile-choix").addEventListener("click", (e) => {
  if (e.target === $("voile-choix")) $("voile-choix").hidden = true;
});
$("choix-valider").addEventListener("click", () => {
  void (async () => {
    if (choixFaire === null) return;
    if (choixSelection.size === 0) {
      direLErreur($("choix-error"), "Choisissez au moins un joueur");
      return;
    }
    const b = $("choix-valider") as HTMLButtonElement;
    b.disabled = true;
    const erreur = await choixFaire([...choixSelection]);
    b.disabled = false;
    if (erreur !== null) { direLErreur($("choix-error"), erreur); return; }
    $("voile-choix").hidden = true;
    flash(t2("{n} joueur(s) prévenu(s)", { n: choixSelection.size }), "ok");
  })();
});

/** Copie un lien, et le dit. Sans presse-papier, on le montre a recopier. */
async function copierLeLien(lien: string, bouton: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(lien);
    bouton.textContent = t("Lien copié");
    setTimeout(() => { bouton.textContent = t("Copier le lien"); }, 2000);
  } catch {
    $("choix-quoi").textContent = lien;
  }
}

// ------------------------------------------------------------- LES DEFIS
//
// Voir SPEC.md §29. Une partie qu'on a jouee se refige depuis sa graine et se
// fait circuler ; elle n'entre pas aux records, puisqu'on peut la connaitre
// d'avance.

const lienDuDefi = (id: string): string =>
  `${location.origin}${location.pathname}?page=defi&id=${encodeURIComponent(id)}`;

$("defier").addEventListener("click", () => { void defierSurCettePartie(); });

async function defierSurCettePartie(): Promise<void> {
  const b = $("defier") as HTMLButtonElement;
  const dit = b.textContent;
  b.disabled = true;
  b.textContent = t("Préparation…");
  const { ok, d } = await envoyerAuServeur("/api/defi", { salon: salonChoisi, pseudo: me });
  b.disabled = false;
  b.textContent = dit;
  if (!ok) { flash(t(d.erreur ?? "serveur injoignable"), "bad"); return; }
  const id = String(d.defi.id);
  void choisirDesJoueurs({
    titre: t("Défier sur cette partie"),
    quoi: "",
    valider: t("Défier"),
    lien: lienDuDefi(id),
    // ON NE DEFIE PAS QUELQU'UN QUI EST DEJA LA : il a joue la partie, et il a
    // deja sa ligne au classement du defi.
    sauf: [...online, ...history.flatMap((m) => Object.keys(m.propositions ?? {}))],
    faire: async (pseudos) => {
      const r = await envoyerAuServeur(`/api/defi/${encodeURIComponent(id)}/inviter`,
        { pseudos, pseudo: me });
      return r.ok ? null : String(r.d.erreur ?? "serveur injoignable");
    },
  });
}

let deId = "";

function ouvrirLeDefi(id: string, pousser = true): void {
  montrerLaPage("corps-defi");
  deId = id;
  void chargerLeDefi();
  if (pousser) window.history.pushState({ page: "defi" }, "", `?page=defi&id=${encodeURIComponent(id)}`);
}

$("de-retour").addEventListener("click", () => {
  montrerLaPage("corps-salons");
  peindreAccueil();
  window.history.pushState({ page: "salons" }, "", "/");
});

async function chargerLeDefi(): Promise<void> {
  direLErreur($("de-error"), null);
  $("de-partie").replaceChildren(tableauVide(t("chargement…")));
  let d: { defi: { id: string; nom: string; config: ConfigSerialisee; par: string; at: number };
    moi: { etat: string; temps: number | null; negatif: number | null; manche: string | null }; };
  try {
    const url = `/api/defi/${encodeURIComponent(deId)}`
      + (moiCompte === null && pseudo() !== "" ? `?pseudo=${encodeURIComponent(pseudo())}` : "");
    const r = await fetch(url);
    d = await r.json();
    if (!r.ok) { direLErreur($("de-error"), (d as any).erreur ?? "serveur injoignable"); return; }
  } catch {
    direLErreur($("de-error"), "serveur injoignable");
    return;
  }
  const x = d.defi;
  $("de-detail").textContent = [
    t2("Défi de {qui}", { qui: x.par }), x.nom, dateDeTournoi(x.at),
  ].filter((s) => s !== "").join(" · ");

  const ligne = el("div", "cp-partie");
  ligne.appendChild(el("div", "cp-num", "1"));
  ligne.appendChild(ecrireLeNomDeLaPartie(x.config, el("div", "cp-nom")));
  const jouer = el("button", "cp-jouer") as HTMLButtonElement;
  jouer.type = "button";
  if (d.moi.etat === "jouee" && d.moi.temps !== null) {
    jouer.className = "cp-faite";
    jouer.textContent = `${tempsCentiemes(d.moi.temps)} · ${negatifDit(d.moi.negatif ?? 0)}`;
    jouer.title = t("Revoir la partie");
    jouer.addEventListener("click", () => {
      const m = d.moi.manche;
      if (m === null) { ouvrirLesResultatsDuDefi(x.id); return; }
      void ouvrirLaPartie(m, 1, "competitif", () => ouvrirLeDefi(x.id));
    });
  } else {
    jouer.textContent = d.moi.etat === "en-cours" ? t("Reprendre") : t("Relever le défi");
    jouer.addEventListener("click", () => { void jouerLeDefi(x.id); });
  }
  ligne.appendChild(jouer);
  const resultats = el("button", "", t("Résultats")) as HTMLButtonElement;
  resultats.type = "button";
  resultats.addEventListener("click", () => ouvrirLesResultatsDuDefi(x.id));
  ligne.appendChild(resultats);
  $("de-partie").replaceChildren(ligne);

  const gestes = $("de-gestes");
  gestes.replaceChildren();
  const defier = el("button", "", t("Défier d'autres joueurs")) as HTMLButtonElement;
  defier.type = "button";
  defier.addEventListener("click", () => {
    void choisirDesJoueurs({
      titre: t("Défier sur cette partie"),
      quoi: "",
      valider: t("Défier"),
      lien: lienDuDefi(x.id),
      faire: async (pseudos) => {
        const r = await envoyerAuServeur(`/api/defi/${encodeURIComponent(x.id)}/inviter`,
          { pseudos, pseudo: pseudo() });
        return r.ok ? null : String(r.d.erreur ?? "serveur injoignable");
      },
    });
  });
  gestes.appendChild(defier);
}

/**
 * UN DEFI SE JOUE SANS COMPTE (SPEC.md §29). Sans pseudo, la fenetre habituelle
 * en demande un, et le defi reprend la ou on l'avait laisse.
 */
async function jouerLeDefi(id: string): Promise<void> {
  if (moiCompte === null && pseudo() === "") {
    reprendreApresLePseudo = () => { void jouerLeDefi(id); };
    demanderLePseudo(null);
    return;
  }
  await jouerUnePartie({ defi: id, pseudo: moiCompte?.pseudo ?? pseudo() }, $("de-error"), true);
}

/** Le classement d'un defi : la meme page que les autres resultats. */
function ouvrirLesResultatsDuDefi(id: string, pousser = true): void {
  ouvrirLesResultats("", "", 1, false);
  rsDefi = id;
  $("rs-retour").textContent = t("← Défi");
  void chargerLesResultats();
  if (pousser) window.history.pushState({ page: "resultats" }, "", adresseDesResultats(1));
}

// ------------------------------------------------------ LA PAGE PERSONNELLE
//
// Voir SPEC.md §30. Publique, avec l'historique de ce qu'un joueur a joue. Les
// reglages sont derriere « Modifier mon profil », et n'y paraissent que chez
// soi.

let peQui = "";
let peOnglet = "tout";
let peLignes: LigneDHistorique[] = [];

interface LigneDHistorique {
  type: "salon" | "pdj" | "tournoi" | "defi";
  source: "records" | "competitif" | "historique";
  id: string;
  at: number;
  config: (ConfigSerialisee & { mode?: string }) | null;
  dou: string;
  partie: number;
  temps: number | null;
  negatif: number;
  score: number;
  coups: number;
  equipe: string[];
  grille?: string;
  lexique?: string;
  chrono?: number | null;
  /** De quoi ouvrir le classement, quand la ligne en a un. */
  defi?: string;
  tournoi?: string;
}

function ouvrirLaPagePerso(qui: string, pousser = true): void {
  montrerLaPage("corps-perso");
  peQui = qui;
  peOnglet = "tout";
  presser("pe-onglets", peOnglet);
  $("pe-pseudo").textContent = qui;
  $("pe-nom").textContent = "";
  $("pe-badge").hidden = true;
  $("pe-avatar").replaceChildren();
  $("pe-historique").replaceChildren(tableauVide(t("chargement…")));
  void chargerLaPagePerso();
  if (pousser) {
    window.history.pushState({ page: "perso" }, "", `?page=perso&joueur=${encodeURIComponent(qui)}`);
  }
}

$("pe-retour").addEventListener("click", () => { window.history.back(); });
$("pe-onglets").addEventListener("click", (e) => {
  const v = ((e.target as HTMLElement).closest("button") as HTMLElement | null)?.dataset["v"];
  if (v === undefined) return;
  peOnglet = v;
  presser("pe-onglets", v);
  peindreLHistorique();
});

async function chargerLaPagePerso(): Promise<void> {
  const qui = peQui;
  try {
    const r = await fetch(`/api/joueur/${encodeURIComponent(qui)}`);
    const d = await r.json();
    const j = d.joueur;
    if (j !== undefined && peQui === qui) {
      $("pe-pseudo").textContent = j.pseudo;
      $("pe-badge").hidden = !j.verifie;
      peindreAvatar($("pe-avatar"), j.avatar, 44, j.avatarSombre);
      $("pe-nom").textContent = j.nom ?? "";
    }
  } catch { /* la fiche n'est qu'un ornement */ }

  // MODIFIER MON PROFIL n'apparait que chez soi (SPEC.md §30).
  const gestes = $("pe-gestes");
  gestes.replaceChildren();
  if (moiCompte !== null && moiCompte.pseudo === qui) {
    const b = el("button", "", t("Modifier mon profil")) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => ouvrirLeProfil());
    gestes.appendChild(b);
  }

  try {
    const r = await fetch(`/api/joueur/${encodeURIComponent(qui)}/historique`);
    const d = await r.json();
    if (peQui !== qui) return;
    peLignes = (d.lignes ?? []) as LigneDHistorique[];
  } catch {
    peLignes = [];
  }
  peindreLHistorique();
}

const GENRES: Record<string, string> = {
  salon: "Salon", pdj: "Partie du jour", tournoi: "Tournoi", defi: "Défi",
};

function peindreLHistorique(): void {
  const vues = peLignes.filter((l) => peOnglet === "tout" || l.type === peOnglet);
  if (vues.length === 0) {
    $("pe-historique").replaceChildren(tableauVide(t("Aucune partie ici.")));
    return;
  }
  $("pe-historique").replaceChildren(...vues.map((l) => {
    const ligne = el("div", "pe-ligne");
    ligne.appendChild(el("span", "pe-quand", dateDeTournoi(l.at)));
    const quoi = el("span", "pe-quoi");
    quoi.appendChild(el("span", "pe-genre", t(GENRES[l.type] ?? l.type)));
    if (l.config !== null) {
      ecrireLeNomDeLaPartie(l.config, quoi);
    } else {
      // Une vieille manche de records ne garde pas sa configuration entiere.
      quoi.appendChild(document.createTextNode([
        l.grille === "super" ? t("Super grille") : t("Normale"),
        l.chrono == null ? "" : chronoDuNom(l.chrono),
      ].filter((s) => s !== "").join(", ")));
    }
    const dou = [
      l.type === "pdj" && l.dou !== "" ? `${jourEnLettres(l.dou)} · P${l.partie}` : "",
      l.type === "tournoi" || l.type === "defi" ? `${l.dou}${l.partie > 1 ? ` · P${l.partie}` : ""}` : "",
      l.type === "salon" ? l.dou : "",
      l.equipe.length > 1 ? l.equipe.join(", ") : "",
    ].filter((s) => s !== "").join(" · ");
    if (dou !== "") quoi.appendChild(el("i", "", dou));
    ligne.appendChild(quoi);
    ligne.appendChild(el("span", "pe-chiffre", l.temps === null ? "—" : tempsCentiemes(l.temps)));
    ligne.appendChild(el("span", "pe-chiffre", negatifDit(l.negatif)));
    const gestes = el("span", "pe-gestes-ligne");
    // LE CLASSEMENT SE LIT DEPUIS L'HISTORIQUE : c'est ce qu'on vient y chercher
    // d'un defi ou d'une partie de tournoi, autant que la grille.
    if (l.defi !== undefined || l.tournoi !== undefined) {
      const clt = el("button", "pe-revoir", t("Classement")) as HTMLButtonElement;
      clt.type = "button";
      clt.addEventListener("click", () => {
        if (l.defi !== undefined) ouvrirLesResultatsDuDefi(l.defi);
        else ouvrirLesResultatsDuTournoi(l.tournoi!, l.partie);
      });
      gestes.appendChild(clt);
    }
    const revoir = el("button", "pe-revoir", t("Revoir")) as HTMLButtonElement;
    revoir.type = "button";
    revoir.addEventListener("click", () => {
      void ouvrirLaPartie(l.id, 1, l.source, () => ouvrirLaPagePerso(peQui, false));
    });
    gestes.appendChild(revoir);
    ligne.appendChild(gestes);
    return ligne;
  }));
}

// ------------------------------------------------------- LES NOTIFICATIONS
//
// Voir SPEC.md §29. ELLES VIVENT HORS DES SALONS : le client n'a de liaison
// avec le serveur que dans un salon, et une invitation envoyee a quelqu'un qui
// lisait la page Competitif ne trouvait personne. On les demande donc au
// serveur, toutes les trente secondes, d'ou qu'on soit.

interface NotificationVue {
  id: string;
  genre: string;
  params: Record<string, string>;
  at: number;
  lue: boolean;
}

let notifs: NotificationVue[] = [];
let notifsNonLues = 0;

const ICONE_CLOCHE =
  '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">'
  + '<path fill="currentColor" d="M12 2.6c-3.2 0-5.4 2.5-5.4 5.6v3.4L4.8 15c-.3.6.1 1.3.8 1.3h12.8'
  + 'c.7 0 1.1-.7.8-1.3l-1.8-3.4V8.2c0-3.1-2.2-5.6-5.4-5.6Z"/>'
  + '<path fill="currentColor" d="M9.8 17.8a2.3 2.3 0 0 0 4.4 0Z"/></svg>';

/** La phrase d'une notification, et ou elle mene. */
function phraseDeLaNotification(n: NotificationVue): { quoi: string; aller: (() => void) | null } {
  const p = n.params;
  if (n.genre === "salon") {
    return {
      quoi: t2("{de} vous invite dans « {nom} »", { de: p["de"] ?? "", nom: p["nom"] ?? "" }),
      aller: p["salon"] === undefined ? null : () => allerA(p["salon"]!),
    };
  }
  if (n.genre === "equipe") {
    return {
      quoi: t2("{de} vous inscrit en équipe dans « {nom} »", { de: p["de"] ?? "", nom: p["nom"] ?? "" }),
      aller: p["tournoi"] === undefined ? null : () => ouvrirLeTournoi(p["tournoi"]!),
    };
  }
  if (n.genre === "tournoi-invite") {
    return {
      quoi: t2("{de} vous invite au tournoi « {nom} »", { de: p["de"] ?? "", nom: p["nom"] ?? "" }),
      aller: p["tournoi"] === undefined ? null : () => ouvrirLeTournoi(p["tournoi"]!),
    };
  }
  if (n.genre === "defi") {
    return {
      quoi: t2("{de} vous défie sur « {nom} »", { de: p["de"] ?? "", nom: p["nom"] ?? "" }),
      aller: p["defi"] === undefined ? null : () => ouvrirLeDefi(p["defi"]!),
    };
  }
  if (n.genre === "defi-joue") {
    return {
      quoi: t2("{de} vient de relever le défi « {nom} »", { de: p["de"] ?? "", nom: p["nom"] ?? "" }),
      aller: p["defi"] === undefined ? null : () => ouvrirLeDefi(p["defi"]!),
    };
  }
  if (n.genre === "tournoi-debut") {
    return {
      quoi: t2("« {nom} » commence", { nom: p["nom"] ?? "" }),
      aller: p["tournoi"] === undefined ? null : () => ouvrirLeTournoi(p["tournoi"]!),
    };
  }
  // LE BATTLE (SPEC.md §29) : les trois temps du tournoi, et ce qui se passe
  // entre deux joueurs qui cherchent une date.
  const versLeTournoi = p["tournoi"] === undefined
    ? null : () => ouvrirLeTournoi(p["tournoi"]!);
  if (n.genre === "tournoi-poules") {
    return { quoi: t2("Les poules de « {nom} » sont tirées", { nom: p["nom"] ?? "" }), aller: versLeTournoi };
  }
  if (n.genre === "tournoi-qualifie") {
    return { quoi: t2("Vous êtes qualifié pour la phase suivante de « {nom} »", { nom: p["nom"] ?? "" }), aller: versLeTournoi };
  }
  if (n.genre === "tournoi-elimine") {
    return { quoi: t2("Vous n'avez pas atteint la phase suivante de « {nom} »", { nom: p["nom"] ?? "" }), aller: versLeTournoi };
  }
  if (n.genre === "tournoi-creneau") {
    return {
      quoi: `${t2("{de} vous propose un créneau pour « {nom} »", { de: p["de"] ?? "", nom: p["nom"] ?? "" })}`
        + (p["texte"] === undefined ? "" : ` : ${p["texte"]}`),
      aller: versLeTournoi,
    };
  }
  if (n.genre === "tournoi-rappel") {
    return { quoi: t2("La date limite de votre rencontre de « {nom} » approche", { nom: p["nom"] ?? "" }), aller: versLeTournoi };
  }
  return { quoi: n.genre, aller: null };
}

async function chargerLesNotifications(): Promise<void> {
  if (moiCompte === null) {
    notifs = [];
    notifsNonLues = 0;
    peindreLaCloche();
    return;
  }
  try {
    const r = await fetch("/api/notifications");
    if (!r.ok) return;
    const d = await r.json();
    notifs = (d.notifications ?? []) as NotificationVue[];
    notifsNonLues = Number(d.nonLues ?? 0);
  } catch {
    return;
  }
  peindreLaCloche();
  if (!$("voile-notifs").hidden) rendreLesNotifications();
}

function peindreLaCloche(): void {
  const b = document.getElementById("cloche-notifs");
  if (b === null) return;
  const vieux = b.querySelector(".compteur");
  if (vieux !== null) vieux.remove();
  if (notifsNonLues > 0) {
    b.appendChild(el("span", "compteur", notifsNonLues > 9 ? "9+" : String(notifsNonLues)));
  }
  b.title = notifsNonLues > 0
    ? t2(notifsNonLues > 1 ? "{n} notifications" : "{n} notification", { n: notifsNonLues })
    : t("Notifications");
}

function rendreLesNotifications(): void {
  const boite = $("notifs-liste");
  if (notifs.length === 0) {
    boite.replaceChildren(el("div", "none", t("Rien pour l'instant.")));
    return;
  }
  boite.replaceChildren(...notifs.map((n) => {
    const { quoi, aller } = phraseDeLaNotification(n);
    const ligne = el("button", `ligne${n.lue ? "" : " neuve"}`) as HTMLButtonElement;
    ligne.type = "button";
    ligne.append(el("span", "quoi", quoi), el("span", "quand", dateDeTournoi(n.at)));
    ligne.addEventListener("click", () => {
      $("voile-notifs").hidden = true;
      if (aller !== null) aller();
    });
    return ligne;
  }));
}

function ouvrirLesNotifications(): void {
  $("voile-notifs").hidden = false;
  rendreLesNotifications();
  if (notifsNonLues === 0) return;
  void (async () => {
    try {
      const r = await fetch("/api/notifications/lues", { method: "POST" });
      if (!r.ok) return;
      const d = await r.json();
      notifs = (d.notifications ?? []) as NotificationVue[];
      notifsNonLues = Number(d.nonLues ?? 0);
    } catch {
      return;
    }
    peindreLaCloche();
    rendreLesNotifications();
  })();
}

$("notifs-close").addEventListener("click", () => { $("voile-notifs").hidden = true; });
$("voile-notifs").addEventListener("click", (e) => {
  if (e.target === $("voile-notifs")) $("voile-notifs").hidden = true;
});

// TOUTES LES TRENTE SECONDES, et rien ne depend d'une liaison ouverte.
setInterval(() => { void chargerLesNotifications(); }, 30_000);

/**
 * LA PAGE D'UN TOURNOI SE RAFRAICHIT TOUTE SEULE (SPEC.md §29).
 *
 * Le client n'a de liaison permanente avec le serveur que dans un salon : hors
 * salon, on demande, comme le fait la cloche. Un resultat parait donc a la
 * minute pres, et non a la seconde -- et c'est assez pour suivre des poules.
 *
 * ON NE DEMANDE RIEN QUAND L'ONGLET EST CACHE : personne ne regarde.
 */
setInterval(() => {
  if ($("corps-tournoi").hidden || document.hidden) return;
  if (!$("to-modif").hidden) return;
  void chargerLeTournoi();
}, 45_000);

// ------------------------------------------------ LA PAGE D'ADMINISTRATION

type OngletAdmin = "pdj" | "hebdo" | "topping" | "battle";
let adOnglet: OngletAdmin = "pdj";
let adLexique = "ods9";
let adOccupe = false;

function ouvrirLAdministrationDuCompetitif(pousser = true): void {
  if (moiCompte?.admin !== true) { ouvrirLeCompetitif(pousser); return; }
  for (const id of ["corps-partie", "corps-salons", "corps-profil", "corps-solveur", "corps-records",
    "corps-competitif", "corps-resultats", "corps-tournoi", "corps-palmares", "corps-perso", "corps-defi"]) $(id).hidden = true;
  $("corps-admin").hidden = false;
  $("join").hidden = false;
  peindreLOngletAdmin();
  if (pousser) window.history.pushState({ page: "admin-competitif" }, "", "?page=admin-competitif");
}

function peindreLOngletAdmin(): void {
  presser("ad-onglets", adOnglet);
  $("ad-pdj").hidden = adOnglet !== "pdj";
  $("ad-hebdo").hidden = adOnglet !== "hebdo";
  $("ad-topping").hidden = adOnglet !== "topping";
  $("ad-battle").hidden = adOnglet !== "battle";
  if (adOnglet === "pdj") {
    peindreLesLexiquesDAdmin();
    void chargerLesPartiesDeDemain();
    void chargerLaSemaine();
  }
  if (adOnglet === "hebdo") void chargerLesTournoisDeLaSemaine();
  if (adOnglet === "topping" && $("ad-topping").childElementCount === 0) {
    $("ad-topping").appendChild(formulaireDuTournoiDeTopping((id) => ouvrirLeTournoi(id)));
  }
  if (adOnglet === "battle" && $("ad-battle").childElementCount === 0) {
    $("ad-battle").appendChild(formulaireDuTournoiDeBattle((id) => ouvrirLeTournoi(id)));
  }
}

$("ad-onglets").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  const v = b?.dataset["v"];
  if (v !== "pdj" && v !== "hebdo" && v !== "topping" && v !== "battle") return;
  adOnglet = v;
  peindreLOngletAdmin();
});
$("ad-retour").addEventListener("click", () => ouvrirLeCompetitif());
$("cp-admin").addEventListener("click", () => ouvrirLAdministrationDuCompetitif());

function peindreLesLexiquesDAdmin(): void {
  const boite = $("ad-lexique");
  boite.replaceChildren(...LEXIQUES_DU_JOUR.map((id) => {
    const b = el("button", "", dictionnaire(id).nom.split(" ")[0]!) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(id === adLexique));
    b.addEventListener("click", () => {
      if (adOccupe) return;
      adLexique = id;
      peindreLesLexiquesDAdmin();
      void chargerLesPartiesDeDemain();
      void chargerLaSemaine();
    });
    return b;
  }));
}

interface PartiesDeDemain {
  jour: string; lexique: string; pret: boolean;
  parties: { n: number; config: ConfigSerialisee }[];
  apercus: number[];
}

async function chargerLesPartiesDeDemain(): Promise<void> {
  direLErreur($("ad-error"), null);
  try {
    const r = await fetch(`/api/admin/pdj?lexique=${encodeURIComponent(adLexique)}`);
    const d = await r.json();
    if (!r.ok) { direLErreur($("ad-error"), d.erreur ?? "serveur injoignable"); return; }
    peindreLesPartiesDeDemain(d as PartiesDeDemain);
  } catch {
    direLErreur($("ad-error"), "serveur injoignable");
  }
}

/**
 * UN CHANGEMENT DES PARTIES DE DEMAIN. Il refige ce qu'il touche : quelques
 * secondes, pendant lesquelles les boutons se taisent.
 */
async function changerDemain(corps: Record<string, unknown>): Promise<void> {
  if (adOccupe) return;
  adOccupe = true;
  $("ad-occupe").hidden = false;
  for (const b of $("corps-admin").querySelectorAll("#ad-pdj button")) (b as HTMLButtonElement).disabled = true;
  const { ok, d } = await envoyerAuServeur("/api/admin/pdj", { lexique: adLexique, ...corps });
  adOccupe = false;
  $("ad-occupe").hidden = true;
  for (const b of $("corps-admin").querySelectorAll("#ad-pdj button")) (b as HTMLButtonElement).disabled = false;
  if (!ok) { direLErreur($("ad-error"), d.erreur ?? "serveur injoignable"); return; }
  direLErreur($("ad-error"), null);
  peindreLesPartiesDeDemain(d as PartiesDeDemain);
}

let adNombre = 0;

function peindreLesPartiesDeDemain(d: PartiesDeDemain): void {
  $("ad-date").textContent = jourEnLettres(d.jour);
  adNombre = d.parties.length;
  $("ad-nombre").textContent = d.pret ? String(adNombre) : "—";
  if (!d.pret) {
    $("ad-parties").replaceChildren(tableauVide(t("Les parties de demain se préparent.")));
    return;
  }
  // RIEN D'UNE PARTIE NE SE VOIT SANS APERCU : ici, son nom seulement.
  $("ad-parties").replaceChildren(...d.parties.map((p) => {
    const ligne = el("div", "ad-partie");
    ligne.appendChild(el("div", "cp-num", String(p.n)));
    const nom = el("div", "ad-nom", nomDeLaPartie(p.config, t));
    if (d.apercus.includes(p.n)) nom.appendChild(el("i", "", t("aperçu ouvert : vous la jouerez hors classement")));
    ligne.appendChild(nom);
    const bouton = (texte: string, faire: () => void): void => {
      const b = el("button", "", texte) as HTMLButtonElement;
      b.type = "button";
      b.addEventListener("click", faire);
      ligne.appendChild(b);
    };
    bouton(t("Nouvelle graine"), () => void changerDemain({ action: "graine", partie: p.n }));
    let editeur: ReturnType<typeof editeurDePartie> | null = null;
    const zone = el("div", "");
    zone.style.flexBasis = "100%";
    bouton(t("Réglages"), () => {
      if (editeur !== null) { zone.replaceChildren(); editeur = null; return; }
      editeur = editeurDePartie(consigneDe(p.config));
      const pied = el("div", "ed-pied");
      const appliquer = el("button", "", t("Appliquer")) as HTMLButtonElement;
      appliquer.type = "button";
      appliquer.addEventListener("click", () => {
        void changerDemain({ action: "reglages", partie: p.n, consigne: editeur!.valeur() });
      });
      pied.appendChild(appliquer);
      editeur.el.appendChild(pied);
      zone.replaceChildren(editeur.el);
    });
    bouton(t("Aperçu"), () => {
      // L'APERCU SE PAIE : qui l'ouvre joue ensuite cette partie hors classement.
      confirmer(t("Ouvrir l'aperçu ? Vous jouerez cette partie hors classement."), () => {
        void ouvrirLApercu(p.n);
      });
    });
    ligne.appendChild(zone);
    return ligne;
  }));
}

$("ad-moins").addEventListener("click", () => {
  if (adNombre > 1) void changerDemain({ action: "nombre", nombre: adNombre - 1 });
});
$("ad-plus").addEventListener("click", () => {
  if (adNombre < 8) void changerDemain({ action: "nombre", nombre: adNombre + 1 });
});
$("ad-retirer").addEventListener("click", () => {
  confirmer(t("Tout retirer ? Les réglages et les tirages de toutes les parties changent."), () => {
    void changerDemain({ action: "retirer" });
  });
});

/** L'apercu d'une partie de demain : tous ses coups, ses tops, sa fin. */
async function ouvrirLApercu(n: number): Promise<void> {
  const { ok, d } = await envoyerAuServeur("/api/admin/pdj/apercu", { lexique: adLexique, partie: n });
  if (!ok) { direLErreur($("ad-error"), d.erreur ?? "serveur injoignable"); return; }
  const coups = d.coups as { n: number; notation: string; word: string; dir: Dir; x: number; y: number;
    score: number; isotops: number }[];
  const config = d.config as ConfigSerialisee;
  $("apercu-titre").textContent = `P${n} · ${nomDeLaPartie(config, t)}`;
  $("apercu-detail").textContent = t2("{jour} · {n} coups · {total} points", {
    jour: jourEnLettres(d.jour), n: coups.length, total: coups.reduce((a, c) => a + c.score, 0),
  });
  const table = el("table");
  table.appendChild(tete([
    { texte: t("Cp.") }, { texte: t("Tirage"), classe: "g" }, { texte: t("Top"), classe: "g" },
    { texte: t("Pos.") }, { texte: t("Score") }, { texte: t("Isotops") },
  ]));
  const corps = el("tbody");
  for (const c of coups) {
    const tr = el("tr");
    tr.append(el("td", "", String(c.n)), el("td", "g", tirageDeLaFeuille(c.notation)),
      el("td", "g rs-mot", c.word), el("td", "", noteCoup(c.dir, c.x, c.y, config.bornes)),
      el("td", "", String(c.score)), el("td", "", String(c.isotops)));
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  $("apercu-route").replaceChildren(table);
  $("voile-apercu").hidden = false;
  void chargerLesPartiesDeDemain();
}

$("apercu-close").addEventListener("click", () => { $("voile-apercu").hidden = true; });
$("voile-apercu").addEventListener("click", (e) => {
  if (e.target === $("voile-apercu")) $("voile-apercu").hidden = true;
});

// ------------------------------------------ LES MODELES DE LA SEMAINE
//
// Sept listes de consignes par lexique (SPEC.md §29). Ce sont elles qui
// decident des parties du lendemain ; les parties de demain, deja tirees, se
// corrigent au-dessus.

/** 0 pour lundi, 6 pour dimanche. */
let adJour = 0;
let semaineVue: (ConsigneVue[] | null)[] = [];
let semEditeurs: ReturnType<typeof editeurDePartie>[] = [];

/** Le nom d'un jour de la semaine, majuscule en tete. */
function nomDuJourDeLaSemaine(i: number): string {
  const j = JOURS_DE_LA_SEMAINE[i] ?? "";
  return t(j.charAt(0).toUpperCase() + j.slice(1));
}

function peindreLeChoixDuJour(): void {
  const s = $("ad-jour") as HTMLSelectElement;
  if (s.childElementCount === 0) {
    for (let i = 0; i < JOURS_DE_LA_SEMAINE.length; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = nomDuJourDeLaSemaine(i);
      s.appendChild(o);
    }
    s.addEventListener("change", () => {
      adJour = Number(s.value);
      peindreLeJourDeLaSemaine();
    });
  }
  s.value = String(adJour);
}

async function chargerLaSemaine(): Promise<void> {
  peindreLeChoixDuJour();
  direLErreur($("ad-sem-error"), null);
  try {
    const r = await fetch(`/api/admin/semaine?lexique=${encodeURIComponent(adLexique)}`);
    const d = await r.json();
    if (!r.ok) { direLErreur($("ad-sem-error"), d.erreur ?? "serveur injoignable"); return; }
    semaineVue = d.semaine as (ConsigneVue[] | null)[];
    peindreLeJourDeLaSemaine();
  } catch {
    direLErreur($("ad-sem-error"), "serveur injoignable");
  }
}

function peindreLeJourDeLaSemaine(): void {
  const consignes = semaineVue[adJour] ?? [];
  semEditeurs = [];
  peindreLesConsignesDuJour(consignes.length, consignes);
  $("ad-sem-etat").hidden = consignes.length > 0;
  $("ad-sem-etat").textContent = t("Aucune consigne : les parties d'office.");
}

function peindreLesConsignesDuJour(n: number, depart: ConsigneVue[] = []): void {
  while (semEditeurs.length < n) {
    semEditeurs.push(editeurDePartie(depart[semEditeurs.length]
      ?? semEditeurs[semEditeurs.length - 1]?.valeur() ?? CONSIGNE_NORMALE));
  }
  semEditeurs.length = n;
  $("ad-sem-nombre").textContent = String(n);
  $("ad-sem-parties").replaceChildren(...semEditeurs.map((e, i) => {
    const bloc = el("div", "ad-sem-partie");
    const titre = el("h3", "", `P${i + 1}`);
    bloc.append(titre, e.el);
    return bloc;
  }));
}

$("ad-sem-moins").addEventListener("click", () => {
  if (semEditeurs.length > 0) peindreLesConsignesDuJour(semEditeurs.length - 1);
});
$("ad-sem-plus").addEventListener("click", () => {
  if (semEditeurs.length < 8) peindreLesConsignesDuJour(semEditeurs.length + 1);
});
$("ad-sem-valider").addEventListener("click", () => { void enregistrerLeJour(semEditeurs.map((e) => e.valeur())); });
$("ad-sem-vider").addEventListener("click", () => {
  confirmer(t2("Retirer les consignes du {jour} ? Ce jour reprendra les parties d'office.",
    { jour: nomDuJourDeLaSemaine(adJour).toLowerCase() }), () => void enregistrerLeJour([]));
});

async function enregistrerLeJour(consignes: ConsigneVue[]): Promise<void> {
  const { ok, d } = await envoyerAuServeur("/api/admin/semaine",
    { lexique: adLexique, jour: adJour, consignes });
  if (!ok) { direLErreur($("ad-sem-error"), d.erreur ?? "serveur injoignable"); return; }
  direLErreur($("ad-sem-error"), null);
  semaineVue = d.semaine as (ConsigneVue[] | null)[];
  peindreLeJourDeLaSemaine();
  flash(t2("{jour} enregistré", { jour: nomDuJourDeLaSemaine(adJour) }), "ok");
}

// ------------------------------------------ LES TOURNOIS DE LA SEMAINE

interface ModeleHebdoVue {
  id: string;
  nom: string;
  lexique: string;
  equipe: number;
  jourDebut: number;
  jourFin: number;
  consignes: ConsigneVue[];
  actif: boolean;
}

async function chargerLesTournoisDeLaSemaine(): Promise<void> {
  const boite = $("ad-hebdo");
  boite.replaceChildren(el("p", "fo-aide", t("Chargement…")));
  let modeles: ModeleHebdoVue[];
  try {
    const r = await fetch("/api/admin/hebdo");
    const d = await r.json();
    if (!r.ok) { boite.replaceChildren(el("p", "fo-aide", t(d.erreur ?? "serveur injoignable"))); return; }
    modeles = d.modeles as ModeleHebdoVue[];
  } catch {
    boite.replaceChildren(el("p", "fo-aide", t("serveur injoignable")));
    return;
  }
  boite.replaceChildren();
  boite.appendChild(el("p", "fo-aide", t("Un tournoi commence à 5 h 30 le matin de son jour de début, "
    + "et finit à 5 h 30 le lendemain de son jour de fin. Son instance naît la veille, avec ses parties.")));
  if (modeles.length === 0) boite.appendChild(el("p", "fo-aide", t("Aucun tournoi de la semaine.")));
  for (const m of modeles) {
    const ligne = el("div", "ad-hebdo-modele");
    const tete = el("div", "ad-ligne");
    const nom = el("div", "ad-nom", m.nom);
    nom.style.flex = "1";
    nom.appendChild(el("i", "", [
      t2("du {a} au {b}", { a: nomDuJourDeLaSemaine(m.jourDebut).toLowerCase(),
        b: nomDuJourDeLaSemaine(m.jourFin).toLowerCase() }),
      dictionnaire(m.lexique).nom,
      t2(m.consignes.length > 1 ? "{n} parties" : "{n} partie", { n: m.consignes.length }),
      m.actif ? "" : t("en sommeil"),
    ].filter((s) => s !== "").join(" · ")));
    tete.appendChild(nom);
    const zone = el("div", "");
    const modifier = el("button", "", t("Modifier")) as HTMLButtonElement;
    modifier.type = "button";
    modifier.addEventListener("click", () => {
      if (zone.childElementCount > 0) { zone.replaceChildren(); return; }
      zone.replaceChildren(formulaireDuTournoiDeLaSemaine(() => void chargerLesTournoisDeLaSemaine(), m));
    });
    const jeter = el("button", "", t("Supprimer")) as HTMLButtonElement;
    jeter.type = "button";
    jeter.addEventListener("click", () => {
      confirmer(t2("Supprimer « {nom} » ?", { nom: m.nom }), () => {
        void (async () => {
          await envoyerAuServeur("/api/admin/hebdo", { supprimer: true, id: m.id });
          void chargerLesTournoisDeLaSemaine();
        })();
      });
    });
    tete.append(modifier, jeter);
    ligne.append(tete, zone);
    boite.appendChild(ligne);
  }
  const neuf = el("div", "ad-hebdo-modele");
  neuf.appendChild(formulaireDuTournoiDeLaSemaine(() => void chargerLesTournoisDeLaSemaine()));
  boite.appendChild(neuf);
}

/** Les sept jours en puces, pour le début et la fin d'un tournoi de la semaine. */
function choixDuJourDeLaSemaine(valeur: number, surChoix: (n: number) => void): HTMLElement {
  return rangeeDeChoix("", JOURS_DE_LA_SEMAINE.map((_, i) => ({ v: String(i), texte: nomDuJourDeLaSemaine(i) })),
    String(valeur), (v) => surChoix(Number(v))).rang;
}

/**
 * LE FORMULAIRE D'UN TOURNOI DE LA SEMAINE. Le meme cree et modifie : ses
 * horaires ne se reglent pas, seulement ses deux jours (SPEC.md §29).
 */
function formulaireDuTournoiDeLaSemaine(surFait: () => void, initial?: ModeleHebdoVue): HTMLElement {
  const f = el("div", "formulaire");
  const nom = document.createElement("input");
  nom.type = "text";
  nom.maxLength = 60;
  nom.placeholder = t("Nom du tournoi");
  nom.value = initial?.nom ?? "";
  let lexique = initial?.lexique ?? adLexique;
  let equipe = initial?.equipe ?? 1;
  let jourDebut = initial?.jourDebut ?? 6;
  let jourFin = initial?.jourFin ?? 6;
  let actif = initial?.actif ?? true;

  const parties = el("div", "fo-deux");
  parties.style.flexDirection = "column";
  const depart = initial?.consignes ?? [];
  const editeurs: ReturnType<typeof editeurDePartie>[] = [];
  const peindreLesParties = (n: number): void => {
    while (editeurs.length < n) {
      editeurs.push(editeurDePartie(
        depart[editeurs.length] ?? editeurs[editeurs.length - 1]?.valeur() ?? CONSIGNE_NORMALE));
    }
    editeurs.length = n;
    parties.replaceChildren(...editeurs.map((e, i) => {
      const bloc = el("div", "fo-partie");
      const titre = el("h3", "", `P${i + 1}`);
      if (i === 0 && n > 1) {
        const toutes = el("button", "", t("Toutes comme la première")) as HTMLButtonElement;
        toutes.type = "button";
        toutes.addEventListener("click", () => {
          for (const autre of editeurs.slice(1)) autre.poser(editeurs[0]!.valeur());
        });
        titre.appendChild(toutes);
      }
      bloc.append(titre, e.el);
      return bloc;
    }));
  };
  peindreLesParties(Math.max(1, depart.length));

  // EN SERVICE OU EN SOMMEIL : un modele en sommeil garde ses reglages mais
  // cesse de produire un tournoi chaque semaine.
  const sommeil = rangeeDeChoix("", [
    { v: "1", texte: t("En service") }, { v: "0", texte: t("En sommeil") },
  ], actif ? "1" : "0", (v) => { actif = v === "1"; }).rang;
  const erreur = el("div", "join-error");
  erreur.hidden = true;
  const faire = el("button", "valider",
    t(initial === undefined ? "Créer le tournoi de la semaine" : "Enregistrer les changements")) as HTMLButtonElement;
  faire.type = "button";
  faire.addEventListener("click", () => {
    void (async () => {
      faire.disabled = true;
      const { ok, d } = await envoyerAuServeur("/api/admin/hebdo", {
        ...(initial === undefined ? {} : { id: initial.id }),
        nom: nom.value, lexique, equipe, jourDebut, jourFin, actif,
        parties: editeurs.map((e) => e.valeur()),
      });
      faire.disabled = false;
      if (!ok) { direLErreur(erreur, d.erreur ?? "serveur injoignable"); return; }
      direLErreur(erreur, null);
      surFait();
    })();
  });

  f.append(
    champ(t("Nom du tournoi"), nom),
    champ(t("Lexique"), choixDuLexique(lexique, (v) => { lexique = v; })),
    champ(t("Du"), choixDuJourDeLaSemaine(jourDebut, (n) => { jourDebut = n; })),
    champ(t("Au"), choixDuJourDeLaSemaine(jourFin, (n) => { jourFin = n; })),
    champ(t("Joueurs par équipe"), compteur(1, 4, equipe, (n) => { equipe = n; })),
    champ(t("Nombre de parties"), compteur(1, 10, Math.max(1, depart.length), (n) => peindreLesParties(n))),
    champ(t("Ce modèle"), sommeil),
    el("p", "fo-aide", t("En sommeil, il garde ses réglages et ne crée plus de tournoi chaque semaine.")),
    parties, erreur, faire,
  );
  return f;
}

// ------------------------------------------------ CREER UN TOURNOI DE TOPPING
//
// CE FORMULAIRE EST CONSTRUIT POUR DEVENIR PUBLIC (SPEC.md §29) : il ne suppose
// rien d'un administrateur, et le serveur verifie tout. Le jour ou tout compte
// pourra creer son tournoi, il suffira d'un bouton sur la page Competitif.

/** Un champ du formulaire, avec son etiquette. */
function champ(etiquette: string, contenu: HTMLElement): HTMLElement {
  const c = el("div", "fo-champ");
  c.append(el("label", "", etiquette), contenu);
  return c;
}

/** Un champ de date et d'heure, a l'heure de Paris. */
function champDate(valeur: number): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "datetime-local";
  i.value = heureDeParis(valeur);
  return i;
}

/** Les trois lexiques, en puces a choix unique. */
function choixDuLexique(valeur: string, surChoix: (v: string) => void): HTMLElement {
  return rangeeDeChoix("", LEXIQUES_DU_JOUR.map((id) => ({ v: id, texte: dictionnaire(id).nom })),
    valeur, surChoix).rang;
}

/** Un compteur -/+ borne. */
function compteur(min: number, max: number, valeur: number, surChange: (n: number) => void): HTMLElement {
  const boite = el("div", "ad-ligne");
  boite.style.margin = "0";
  let n = valeur;
  const moins = el("button", "", "−") as HTMLButtonElement;
  const plus = el("button", "", "+") as HTMLButtonElement;
  const vu = el("b", "", String(n));
  const poser = (x: number): void => {
    n = Math.max(min, Math.min(max, x));
    vu.textContent = String(n);
    moins.disabled = n <= min;
    plus.disabled = n >= max;
    surChange(n);
  };
  moins.type = "button";
  plus.type = "button";
  moins.addEventListener("click", () => poser(n - 1));
  plus.addEventListener("click", () => poser(n + 1));
  boite.append(moins, vu, plus);
  moins.disabled = n <= min;
  plus.disabled = n >= max;
  return boite;
}

/** L'heure pleine qui suit, pour les dates proposees d'office. */
function prochaineHeure(decalageJours = 0): number {
  const h = 3_600_000;
  return Math.ceil(Date.now() / h) * h + decalageJours * 86_400_000;
}

/**
 * LE FORMULAIRE D'UN TOURNOI DE TOPPING. Le meme sert a le creer et a le
 * modifier tant qu'il n'a pas commence (SPEC.md §29) : `initial` le remplit.
 */
function formulaireDuTournoiDeTopping(surFait: (id: string) => void, initial?: TournoiVue): HTMLElement {
  const f = el("div", "formulaire");
  const nom = document.createElement("input");
  nom.type = "text";
  nom.maxLength = 60;
  nom.placeholder = t("Nom du tournoi");
  nom.value = initial?.nom ?? "";
  let lexique = initial?.lexique ?? (cpLexique === "" ? lexiqueDuJourParDefaut() : cpLexique);
  let equipe = initial?.equipe ?? 1;
  const debut = champDate(initial?.debut ?? prochaineHeure());
  const fin = champDate(initial?.fin ?? prochaineHeure(7));

  const parties = el("div", "fo-deux");
  parties.style.flexDirection = "column";
  const modelesDeDepart = (initial?.parties ?? []).map((p) => consigneDe(p.config));
  const editeurs: ReturnType<typeof editeurDePartie>[] = [];
  const peindreLesParties = (n: number): void => {
    while (editeurs.length < n) {
      editeurs.push(editeurDePartie(
        modelesDeDepart[editeurs.length] ?? editeurs[editeurs.length - 1]?.valeur() ?? CONSIGNE_NORMALE));
    }
    editeurs.length = n;
    parties.replaceChildren(...editeurs.map((e, i) => {
      const bloc = el("div", "fo-partie");
      const titre = el("h3", "", `P${i + 1}`);
      if (i === 0 && n > 1) {
        const toutes = el("button", "", t("Toutes comme la première")) as HTMLButtonElement;
        toutes.type = "button";
        // Les reglages seulement : chaque partie garde sa propre graine.
        toutes.addEventListener("click", () => {
          for (const autre of editeurs.slice(1)) autre.poser(editeurs[0]!.valeur());
        });
        titre.appendChild(toutes);
      }
      bloc.append(titre, e.el);
      return bloc;
    }));
  };
  peindreLesParties(Math.max(1, modelesDeDepart.length));

  const dates = el("div", "fo-deux");
  dates.append(champ(t("Début (heure de Paris)"), debut), champ(t("Fin (heure de Paris)"), fin));
  const erreur = el("div", "join-error");
  erreur.hidden = true;
  const faire = el("button", "valider",
    t(initial === undefined ? "Créer le tournoi" : "Enregistrer les changements")) as HTMLButtonElement;
  faire.type = "button";
  faire.addEventListener("click", () => {
    void (async () => {
      const dit = faire.textContent;
      faire.disabled = true;
      faire.textContent = t("Création…");
      const { ok, d } = await envoyerAuServeur(
        initial === undefined ? "/api/tournois" : `/api/tournoi/${encodeURIComponent(initial.id)}/modifier`, {
          type: "topping", nom: nom.value, lexique, equipe, debut: debut.value, fin: fin.value,
          parties: editeurs.map((e) => e.valeur()),
        });
      faire.disabled = false;
      faire.textContent = dit;
      if (!ok) { direLErreur(erreur, d.erreur ?? "serveur injoignable"); return; }
      direLErreur(erreur, null);
      surFait(d.tournoi.id);
    })();
  });

  f.append(
    champ(t("Nom du tournoi"), nom),
    champ(t("Lexique"), choixDuLexique(lexique, (v) => { lexique = v; })),
    dates,
    el("p", "fo-aide", t("Chaque partie se joue une fois, dans l'ordre qu'on veut, entre ces deux dates.")),
    champ(t("Joueurs par équipe"), compteur(1, 4, equipe, (n) => { equipe = n; })),
    champ(t("Nombre de parties"), compteur(1, 10, Math.max(1, modelesDeDepart.length), (n) => peindreLesParties(n))),
    parties, erreur, faire,
  );
  return f;
}

// ------------------------------------------------ CREER UN TOURNOI DE BATTLE

function formulaireDuTournoiDeBattle(surFait: (id: string) => void, initial?: TournoiVue): HTMLElement {
  const f = el("div", "formulaire");
  const nom = document.createElement("input");
  nom.type = "text";
  nom.maxLength = 60;
  nom.placeholder = t("Nom du tournoi");
  nom.value = initial?.nom ?? "";
  let lexique = initial?.lexique ?? (cpLexique === "" ? lexiqueDuJourParDefaut() : cpLexique);
  const b0 = initial?.battle ?? null;
  const debut = champDate(initial?.debut ?? prochaineHeure(3));
  const limite = champDate(b0?.limitePoules ?? prochaineHeure(10));
  const r = {
    equipe: initial?.equipe ?? 1,
    joueursParPoule: b0?.joueursParPoule ?? 4,
    rencontresParPoule: b0?.rencontresParPoule ?? null,
    manchesParPoule: b0?.manchesParPoule ?? 2,
    qualifies: b0?.qualifies ?? null,
    tableauHaut: b0?.tableauHaut ?? null,
    meilleurDe: b0?.meilleurDe ?? 3,
    meilleurDeDemi: b0?.meilleurDeDemi ?? 3,
    meilleurDeFinale: b0?.meilleurDeFinale ?? 3,
    joursParTour: b0?.joursParTour ?? 3,
  };
  const editeur = editeurDePartie(b0 == null ? CONSIGNE_NORMALE : consigneExacte(b0.partie));

  /** Un choix « tous / un nombre », pour les rencontres et les qualifies. */
  const tousOuNombre = (
    texteTous: string, min: number, max: number, valeur: number | null,
    surChange: (n: number | null) => void,
  ): HTMLElement => {
    const boite = el("div", "ed-rang");
    const nombre = champNombre(min, max, valeur ?? min, texteTous);
    nombre.hidden = valeur === null;
    const rangee = rangeeDeChoix("", [
      { v: "tous", texte: texteTous }, { v: "n", texte: t("Un nombre") },
    ], valeur === null ? "tous" : "n", (v) => {
      nombre.hidden = v === "tous";
      surChange(v === "tous" ? null : Math.round(Number(nombre.value)));
    });
    rangee.rang.firstElementChild?.remove();
    nombre.addEventListener("input", () => surChange(Math.round(Number(nombre.value))));
    boite.append(rangee.rang, nombre);
    return boite;
  };
  /** Un « meilleur de » impair. */
  const impair = (valeur: number, surChange: (n: number) => void): HTMLElement => {
    const rangee = rangeeDeChoix("", [1, 3, 5, 7, 9].map((n) => ({ v: String(n), texte: String(n) })),
      String(valeur), (v) => surChange(Number(v)));
    rangee.rang.firstElementChild?.remove();
    return rangee.rang;
  };

  const erreur = el("div", "join-error");
  erreur.hidden = true;
  const faire = el("button", "valider",
    t(initial === undefined ? "Créer le tournoi" : "Enregistrer les changements")) as HTMLButtonElement;
  faire.type = "button";
  faire.addEventListener("click", () => {
    void (async () => {
      faire.disabled = true;
      const { ok, d } = await envoyerAuServeur(
        initial === undefined ? "/api/tournois" : `/api/tournoi/${encodeURIComponent(initial.id)}/modifier`, {
          type: "battle", nom: nom.value, lexique, debut: debut.value, limitePoules: limite.value,
          ...r, partie: editeur.valeur(),
        });
      faire.disabled = false;
      if (!ok) { direLErreur(erreur, d.erreur ?? "serveur injoignable"); return; }
      direLErreur(erreur, null);
      surFait(d.tournoi.id);
    })();
  });

  const debuts = el("div", "fo-deux");
  debuts.append(champ(t("Début des rencontres (heure de Paris)"), debut),
    champ(t("Date limite des poules (heure de Paris)"), limite));
  const poules = el("div", "fo-deux");
  poules.append(
    champ(t("Joueurs par poule"), compteur(3, 12, r.joueursParPoule, (n) => { r.joueursParPoule = n; })),
    champ(t("Manches par rencontre de poule"), compteur(1, 9, r.manchesParPoule, (n) => { r.manchesParPoule = n; })),
  );
  const tableau = el("div", "fo-deux");
  tableau.append(
    champ(t("Meilleur de, en tableau"), impair(r.meilleurDe, (n) => { r.meilleurDe = n; })),
    champ(t("En demi-finale"), impair(r.meilleurDeDemi, (n) => { r.meilleurDeDemi = n; })),
    champ(t("En finale"), impair(r.meilleurDeFinale, (n) => { r.meilleurDeFinale = n; })),
  );
  f.append(
    champ(t("Nom du tournoi"), nom),
    champ(t("Lexique"), choixDuLexique(lexique, (v) => { lexique = v; })),
    debuts,
    el("p", "fo-aide", t("Les inscriptions ferment au début des rencontres. Les poules se tirent ensuite.")),
    champ(t("Joueurs par équipe"), compteur(1, 4, r.equipe, (n) => { r.equipe = n; })),
    poules,
    champ(t("Rencontres par poule"),
      tousOuNombre(t("Tous contre tous"), 1, 11, r.rencontresParPoule, (n) => { r.rencontresParPoule = n; })),
    champ(t("Qualifiés"), tousOuNombre(t("Tous"), 2, 256, r.qualifies, (n) => { r.qualifies = n; })),
    champ(t("Dont au tableau haut"),
      tousOuNombre(t("La moitié"), 1, 256, r.tableauHaut, (n) => { r.tableauHaut = n; })),
    tableau,
    champ(t("Jours par tour de tableau"), compteur(1, 30, r.joursParTour, (n) => { r.joursParTour = n; })),
    champ(t("La partie d'une manche"), editeur.el),
    erreur, faire,
  );
  return f;
}

// ---------------------------------------------------------------- LES TOURNOIS

interface TournoiVue {
  id: string;
  type: "topping" | "battle";
  nom: string;
  lexique: string;
  debut: number;
  fin: number | null;
  equipe: number;
  parties: { n: number; config: ConfigSerialisee }[];
  battle: {
    joueursParPoule: number; rencontresParPoule: number | null; manchesParPoule: number;
    qualifies: number | null; tableauHaut: number | null; meilleurDe: number;
    meilleurDeDemi: number; meilleurDeFinale: number; partie: ModeleVue;
    limitePoules: number; joursParTour: number;
  } | null;
  par: string;
  inscrits: { compte: string; noms: string; partenaires: string[] }[];
  /** Ce que j'y ai fait, quand je suis connecte. */
  moi?: { inscrit: boolean; finies: number; modifiable: boolean; proprietaire?: boolean } | null;
  /** Combien d'inscrits ont fini toutes les parties. */
  resultats?: number;
}

/** Une date de tournoi, a l'heure de Paris : « 20 sept., 18:00 ». */
function dateDeTournoi(instant: number): string {
  return new Date(instant).toLocaleString(langue() === "en" ? "en-GB" : "fr-FR", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris",
  });
}

/** Les dates d'un tournoi, en une ligne. */
function datesDuTournoi(x: TournoiVue): string {
  return x.fin === null
    ? t2("rencontres dès le {d}", { d: dateDeTournoi(x.debut) })
    : t2("du {d} au {f}", { d: dateDeTournoi(x.debut), f: dateDeTournoi(x.fin) });
}

/** Ou en est un tournoi : a venir, en cours, termine. */
function etatDuTournoi(x: TournoiVue, maintenant: number): "avenir" | "encours" | "termine" {
  if (maintenant < x.debut) return "avenir";
  if (x.fin !== null && maintenant >= x.fin) return "termine";
  return "encours";
}

/** Retire un tournoi, puis repeint ce qui le montrait. */
async function supprimerLeTournoi(id: string): Promise<void> {
  const { ok, d } = await envoyerAuServeur(`/api/tournoi/${encodeURIComponent(id)}/supprimer`, {});
  if (!ok) { direLErreur($("cp-error"), d.erreur ?? "serveur injoignable"); return; }
  if ($("corps-tournoi").hidden) void chargerLesTournois();
  else ouvrirLeCompetitif();
}

async function chargerLesTournois(): Promise<void> {
  let d: { maintenant: number; tournois: TournoiVue[] };
  try {
    d = await (await fetch("/api/tournois")).json();
  } catch {
    $("cp-tournois").replaceChildren(tableauVide(t("serveur injoignable")));
    return;
  }
  if (d.tournois.length === 0) {
    $("cp-tournois").replaceChildren(tableauVide(t("Aucun tournoi pour l'instant.")));
    return;
  }
  const groupes: { etat: "encours" | "avenir" | "termine"; titre: string }[] = [
    { etat: "encours", titre: t("En cours") }, { etat: "avenir", titre: t("À venir") },
    { etat: "termine", titre: t("Terminés") },
  ];
  const enfants: HTMLElement[] = [];
  for (const g of groupes) {
    const les = d.tournois.filter((x) => etatDuTournoi(x, d.maintenant) === g.etat);
    if (les.length === 0) continue;
    enfants.push(el("h3", "", g.titre));
    for (const x of g.etat === "termine" ? [...les].reverse() : les) enfants.push(tuileDeTournoi(x));
  }
  $("cp-tournois").replaceChildren(...enfants);
}

/** La tuile d'un tournoi : la vignette de sa grille, son nom, son type, ses dates. */
function tuileDeTournoi(x: TournoiVue): HTMLElement {
  const c = el("button", "carte") as HTMLButtonElement;
  c.type = "button";
  const vue = el("span", "vue");
  // UN TOURNOI QU'ON A FINI SE VOIT D'UN REGARD : grise, et coche.
  const fini = x.type === "topping" && x.parties.length > 0
    && (x.moi?.finies ?? 0) >= x.parties.length;
  if (fini) {
    c.classList.add("terminee");
    vue.appendChild(el("span", "fini", `✓ ${t("Fini")}`));
  }
  // Son createur peut le retirer, comme un salon.
  if (x.moi?.proprietaire === true) {
    const jeter = el("button", "jeter", t("Supprimer")) as HTMLButtonElement;
    jeter.type = "button";
    jeter.title = t("Retire le tournoi et ses classements. Sans retour.");
    jeter.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmer(t2("Supprimer « {nom} » ?", { nom: x.nom }), () => void supprimerLeTournoi(x.id));
    });
    vue.appendChild(jeter);
  }
  const bornes = x.type === "battle" ? x.battle?.partie.bornes : x.parties[0]?.config.bornes;
  vue.appendChild(el("span", `vignette ${bornes === 10 ? "super" : "bornee"}`));
  vue.appendChild(el("span", "badge", x.type === "battle" ? t("Battle") : t("Topping")));
  c.appendChild(vue);
  const dedans = el("span", "dedans");
  dedans.appendChild(el("b", "nom", x.nom));
  dedans.appendChild(el("span", "quoi", [
    x.type === "topping" ? t2(x.parties.length > 1 ? "{n} parties" : "{n} partie", { n: x.parties.length }) : "",
    dictionnaire(x.lexique).nom,
    x.equipe > 1 ? t2("équipes de {n}", { n: x.equipe }) : "",
  ].filter((s) => s !== "").join(" · ")));
  const etat = el("span", "etat");
  etat.appendChild(el("span", "", datesDuTournoi(x)));
  etat.appendChild(el("span", "ou", [
    t2(x.inscrits.length > 1 ? "{n} inscrits" : "{n} inscrit", { n: x.inscrits.length }),
    // COMBIEN ONT FINI : c'est ce qui dit si un tournoi est vivant, et un zero
    // le dit autant qu'un autre nombre.
    ...(x.type === "topping"
      ? [t2((x.resultats ?? 0) > 1 ? "{n} résultats" : "{n} résultat", { n: x.resultats ?? 0 })] : []),
  ].join(" · ")));
  dedans.appendChild(etat);
  c.appendChild(dedans);
  c.addEventListener("click", () => {
    if (fini) ouvrirLesResultatsDuTournoi(x.id, "cumul"); else ouvrirLeTournoi(x.id);
  });
  return c;
}

// -------------------------------------------------------- LA PAGE D'UN TOURNOI

let toId = "";
let toDemande = 0;

function ouvrirLeTournoi(id: string, pousser = true): void {
  for (const pid of ["corps-partie", "corps-salons", "corps-profil", "corps-solveur", "corps-records",
    "corps-competitif", "corps-resultats", "corps-admin", "corps-palmares", "corps-perso", "corps-defi"]) $(pid).hidden = true;
  $("corps-tournoi").hidden = false;
  $("join").hidden = false;
  toId = id;
  void chargerLeTournoi();
  if (pousser) window.history.pushState({ page: "tournoi" }, "", `?page=tournoi&id=${encodeURIComponent(id)}`);
}

$("to-retour").addEventListener("click", () => ouvrirLeCompetitif());

async function chargerLeTournoi(): Promise<void> {
  const mien = ++toDemande;
  direLErreur($("to-error"), null);
  let d: {
    maintenant: number; tournoi: TournoiVue; resultats?: number;
    /** Ce qu'un tournoi de battle ajoute a sa page (SPEC.md §29). */
    battle?: BattleVue | null;
    moi: {
      inscrit: boolean; modifiable?: boolean; proprietaire?: boolean;
      parties: {
        n: number; etat: string; temps: number | null; negatif: number | null; manche?: string | null;
      }[];
    } | null;
    erreur?: string;
  };
  try {
    const r = await fetch(`/api/tournoi/${encodeURIComponent(toId)}`);
    d = await r.json();
    if (!r.ok) { direLErreur($("to-error"), d.erreur ?? "serveur injoignable"); return; }
  } catch {
    direLErreur($("to-error"), "serveur injoignable");
    return;
  }
  if (mien !== toDemande) return;
  const x = d.tournoi;
  const etat = etatDuTournoi(x, d.maintenant);
  $("to-nom").textContent = x.nom;
  $("to-detail").textContent = [
    x.type === "battle" ? t("Tournoi de battle") : t("Tournoi de topping"),
    dictionnaire(x.lexique).nom, datesDuTournoi(x),
  ].join(" · ");

  // LES PARTIES : pour un inscrit, entre les deux dates, comme les parties du jour.
  $("to-parties-titre").textContent = x.type === "battle" ? t("Format") : t("Parties");
  if (x.type === "topping") {
    $("to-parties").replaceChildren(...x.parties.map((p) => {
      const mienne = d.moi?.parties.find((q) => q.n === p.n);
      const ligne = el("div", "cp-partie");
      ligne.appendChild(el("div", "cp-num", String(p.n)));
      ligne.appendChild(ecrireLeNomDeLaPartie(p.config, el("div", "cp-nom")));
      const jouer = el("button", "cp-jouer") as HTMLButtonElement;
      jouer.type = "button";
      if (mienne?.etat === "jouee" && mienne.temps !== null) {
        jouer.className = "cp-faite";
        jouer.textContent = `${tempsCentiemes(mienne.temps)} · ${negatifDit(mienne.negatif ?? 0)}`;
        jouer.title = t("Revoir la partie");
        jouer.addEventListener("click", () => {
          const manche = mienne.manche ?? null;
          if (manche === null) { ouvrirLesResultatsDuTournoi(x.id, p.n); return; }
          void ouvrirLaPartie(manche, 1, "competitif", () => ouvrirLeTournoi(x.id));
        });
      } else {
        jouer.textContent = mienne?.etat === "en-cours" ? t("Reprendre") : t("Jouer");
        // JOUER INSCRIT (SPEC.md §29) : le formulaire ne sert plus qu'aux equipes.
        jouer.disabled = etat !== "encours" || moiCompte === null;
        jouer.title = etat === "avenir" ? t("Le tournoi n'a pas commencé")
          : etat === "termine" ? t("Le tournoi est terminé")
          : moiCompte === null ? t("Connectez-vous pour jouer")
            : d.moi?.inscrit !== true ? t("Jouer vous inscrit au tournoi") : "";
        jouer.addEventListener("click", () => void jouerUnePartie({ tournoi: x.id, partie: p.n }, $("to-error")));
      }
      ligne.appendChild(jouer);
      const resultats = el("button", "", t("Résultats")) as HTMLButtonElement;
      resultats.type = "button";
      resultats.addEventListener("click", () => ouvrirLesResultatsDuTournoi(x.id, p.n));
      ligne.appendChild(resultats);
      return ligne;
    }));
    const general = el("button", "cp-jouer", t("Général")) as HTMLButtonElement;
    general.type = "button";
    general.style.marginTop = "6px";
    general.style.alignSelf = "flex-start";
    general.style.padding = "8px 18px";
    general.addEventListener("click", () => ouvrirLesResultatsDuTournoi(x.id, "cumul"));
    $("to-parties").appendChild(general);
    $("to-format").replaceChildren(el("span", "", x.equipe > 1
      ? t2("Équipes de {n} joueurs. Chaque partie se joue une fois, dans l'ordre qu'on veut.", { n: x.equipe })
      : t("Chaque partie se joue une fois, dans l'ordre qu'on veut.")));
  } else if (x.battle !== null) {
    const b = x.battle;
    $("to-parties").replaceChildren();
    const lignes: [string, string][] = [
      [t("Joueurs par équipe"), String(x.equipe)],
      [t("Joueurs par poule"), String(b.joueursParPoule)],
      [t("Rencontres par poule"), b.rencontresParPoule === null ? t("Tous contre tous") : String(b.rencontresParPoule)],
      [t("Manches par rencontre de poule"), String(b.manchesParPoule)],
      [t("Date limite des poules"), dateDeTournoi(b.limitePoules)],
      [t("Qualifiés"), b.qualifies === null ? t("Tous") : String(b.qualifies)],
      [t("Dont au tableau haut"), b.tableauHaut === null ? t("La moitié") : String(b.tableauHaut)],
      [t("Meilleur de, en tableau"), `${b.meilleurDe} · ${t("demi-finale")} ${b.meilleurDeDemi} · ${t("finale")} ${b.meilleurDeFinale}`],
      [t("Jours par tour de tableau"), String(b.joursParTour)],
      [t("La partie d'une manche"), nomDeLaPartie(b.partie, t)],
    ];
    $("to-format").replaceChildren(...lignes.map(([k, v]) => {
      const p = el("div", "");
      p.append(document.createTextNode(`${k} : `), el("b", "", v));
      return p;
    }));
  }

  // MODIFIER ET SUPPRIMER : a son createur, tant qu'il n'a pas commence.
  const gestes = $("to-gestes");
  gestes.replaceChildren();
  $("to-modif").hidden = true;
  $("to-modif").replaceChildren();
  $("to-colonnes").hidden = false;
  if (d.moi?.modifiable === true) {
    const modifier = el("button", "", t("Modifier le tournoi")) as HTMLButtonElement;
    modifier.type = "button";
    modifier.addEventListener("click", () => {
      $("to-colonnes").hidden = true;
      $("to-modif").hidden = false;
      $("to-modif").replaceChildren(x.type === "battle"
        ? formulaireDuTournoiDeBattle(() => ouvrirLeTournoi(x.id, false), x)
        : formulaireDuTournoiDeTopping(() => ouvrirLeTournoi(x.id, false), x));
    });
    gestes.appendChild(modifier);
  }
  // INVITER DES JOUEURS (SPEC.md §29) : ils recoivent une notification, meme
  // s'ils ne sont pas connectes.
  if (moiCompte !== null) {
    const inviter = el("button", "vert", t("Inviter des joueurs")) as HTMLButtonElement;
    inviter.type = "button";
    inviter.addEventListener("click", () => {
      void choisirDesJoueurs({
        titre: t("Inviter au tournoi"),
        quoi: t2("Chacun reçoit une notification qui le mène à « {nom} ».", { nom: x.nom }),
        valider: t("Inviter"),
        faire: async (pseudos) => {
          const r = await envoyerAuServeur(`/api/tournoi/${encodeURIComponent(x.id)}/inviter`, { pseudos });
          return r.ok ? null : String(r.d.erreur ?? "serveur injoignable");
        },
      });
    });
    gestes.appendChild(inviter);
  }
  if (d.moi?.proprietaire === true) {
    const supprimer = el("button", "", t("Supprimer le tournoi")) as HTMLButtonElement;
    supprimer.type = "button";
    supprimer.addEventListener("click", () => {
      confirmer(t2("Supprimer « {nom} » ?", { nom: x.nom }), () => void supprimerLeTournoi(x.id));
    });
    gestes.appendChild(supprimer);
  }

  // LE BATTLE : les poules, mes rencontres, ce qui se joue en ce moment.
  $("to-battle").hidden = true;
  $("to-entete").hidden = true;
  if (d.battle != null) {
    peindreLeBattle(x, d.battle, d.maintenant, d.moi?.proprietaire === true);
  }

  // L'INSCRIPTION.
  peindreLInscription(x, d.moi?.inscrit === true, d.maintenant, d.battle ?? null);
  $("to-inscrits-titre").textContent = [
    t2(x.inscrits.length > 1 ? "{n} inscrits" : "{n} inscrit", { n: x.inscrits.length }),
    ...(x.type === "topping"
      ? [t2((d.resultats ?? 0) > 1 ? "{n} résultats" : "{n} résultat", { n: d.resultats ?? 0 })] : []),
  ].join(" · ");
  $("to-inscrits").replaceChildren(...x.inscrits.map((i) => {
    const s = el("span", "rc-joueur");
    s.appendChild(pseudoCliquable(i.compte));
    for (const p of i.partenaires) {
      s.appendChild(document.createTextNode(" + "));
      s.appendChild(pseudoCliquable(p));
    }
    if (i.noms !== "") s.appendChild(el("i", "", ` · ${i.noms}`));
    return s;
  }));
}

/** Le bloc d'inscription : le bouton, et les partenaires quand on joue a plusieurs. */
function peindreLInscription(
  x: TournoiVue, inscrit: boolean, maintenant: number, bat: BattleVue | null = null,
): void {
  const boite = $("to-inscription");
  const closes = x.type === "topping" ? (x.fin !== null && maintenant >= x.fin) : maintenant >= x.debut;
  if (inscrit) {
    boite.replaceChildren(el("p", "to-bloc", t("Vous êtes inscrit.")));
    // SE DESINSCRIRE, tant que le tournoi n'est pas engage (SPEC.md §29) : d'un
    // battle tant que les poules ne sont pas tirees, d'un topping tant qu'on
    // n'a lance aucune partie. Le serveur tranche ; le bouton disparait quand
    // il n'a plus rien a faire.
    const engage = x.type === "battle" ? (bat !== null && bat.phase !== "inscriptions") : false;
    if (!engage) {
      const partir = el("button", "lien", t("Me retirer du tournoi")) as HTMLButtonElement;
      partir.type = "button";
      partir.addEventListener("click", () => {
        confirmer(t2("Vous retirer de « {nom} » ?", { nom: x.nom }), () => {
          void (async () => {
            const { ok, d } = await envoyerAuServeur(
              `/api/tournoi/${encodeURIComponent(x.id)}/desinscription`, {});
            if (!ok) { direLErreur($("to-error"), String(d.erreur ?? "serveur injoignable")); return; }
            ouvrirLeTournoi(x.id, false);
          })();
        });
      });
      boite.appendChild(partir);
    }
    return;
  }
  if (closes) { boite.replaceChildren(el("p", "to-bloc", t("Les inscriptions sont closes."))); return; }
  if (moiCompte === null) {
    const b = el("button", "valider", t("Se connecter pour s'inscrire")) as HTMLButtonElement;
    b.type = "button";
    b.style.width = "auto";
    b.addEventListener("click", () => ouvrirLeCompte("connexion"));
    boite.replaceChildren(b);
    return;
  }
  const f = el("div", "to-inscription");
  const pseudos = document.createElement("input");
  const noms = document.createElement("input");
  if (x.equipe > 1) {
    // LES PARTENAIRES SE NOMMENT PAR PSEUDO, OU PAR ECRIT (SPEC.md §29).
    pseudos.placeholder = t("Pseudos des partenaires, séparés par des virgules");
    noms.placeholder = t("Ou leurs noms, s'ils jouent sur votre compte");
    noms.maxLength = 120;
    f.append(pseudos, noms);
  }
  const erreur = el("div", "join-error");
  erreur.hidden = true;
  const b = el("button", "valider", t("S'inscrire")) as HTMLButtonElement;
  b.type = "button";
  b.addEventListener("click", () => {
    void (async () => {
      b.disabled = true;
      const { ok, d } = await envoyerAuServeur(`/api/tournoi/${encodeURIComponent(x.id)}/inscription`, {
        partenaires: pseudos.value.split(",").map((s) => s.trim()).filter((s) => s !== ""),
        noms: noms.value,
      });
      b.disabled = false;
      if (!ok) { direLErreur(erreur, d.erreur ?? "serveur injoignable"); return; }
      void chargerLeTournoi();
    })();
  });
  f.append(erreur, b);
  boite.replaceChildren(f);
}

// ------------------------------------------------------------- LE PALMARES
//
// Voir SPEC.md §29. Les medailles des parties du jour closes, et les solos --
// les coups qu'un seul joueur a trouves. Deux vues, trois periodes, un lexique.

type OngletPalmares = "medailles" | "solos";

interface LigneDeMedailles { compte: string; or: number; argent: number; bronze: number }

interface SoloVue {
  jour: string;
  lexique: string;
  partie: number;
  coup: number;
  mot: string;
  dir: Dir;
  x: number;
  y: number;
  score: number;
  equipe: string[];
  manche: string;
  joueurs: number;
}

let paOnglet: OngletPalmares = "medailles";
/** `null` : tous les lexiques a la meme table. */
let paLexique: string | null = null;
let paPeriode: "tout" | "annee" | "30j" = "tout";
let paDemande = 0;

function ouvrirLePalmares(pousser = true): void {
  for (const id of ["corps-partie", "corps-salons", "corps-profil", "corps-solveur", "corps-records",
    "corps-competitif", "corps-resultats", "corps-admin", "corps-tournoi"]) $(id).hidden = true;
  $("corps-palmares").hidden = false;
  $("join").hidden = false;
  peindreLesChoixDuPalmares();
  void chargerLePalmares();
  if (pousser) window.history.pushState({ page: "palmares" }, "", "?page=palmares");
}

$("pa-retour").addEventListener("click", () => ouvrirLeCompetitif());
$("cp-palmares").addEventListener("click", () => ouvrirLePalmares());

$("pa-onglets").addEventListener("click", (e) => {
  const v = ((e.target as HTMLElement).closest("button") as HTMLElement | null)?.dataset["v"];
  if (v !== "medailles" && v !== "solos") return;
  paOnglet = v;
  peindreLesChoixDuPalmares();
  void chargerLePalmares();
});

$("pa-periode").addEventListener("click", (e) => {
  const v = ((e.target as HTMLElement).closest("button") as HTMLElement | null)?.dataset["v"];
  if (v !== "tout" && v !== "annee" && v !== "30j") return;
  paPeriode = v;
  peindreLesChoixDuPalmares();
  void chargerLePalmares();
});

function peindreLesChoixDuPalmares(): void {
  presser("pa-onglets", paOnglet);
  presser("pa-periode", paPeriode);
  const boite = $("pa-lexique");
  boite.replaceChildren(...[null, ...LEXIQUES_DU_JOUR].map((id) => {
    const b = el("button", "", id === null ? t("Tous") : dictionnaire(id).nom.split(" ")[0]!) as HTMLButtonElement;
    b.type = "button";
    b.setAttribute("aria-pressed", String(id === paLexique));
    b.addEventListener("click", () => {
      paLexique = id;
      peindreLesChoixDuPalmares();
      void chargerLePalmares();
    });
    return b;
  }));
}

async function chargerLePalmares(): Promise<void> {
  const mien = ++paDemande;
  $("pa-tableau").replaceChildren(tableauVide(t("chargement…")));
  const quoi = paOnglet === "medailles" ? "medailles" : "solos";
  try {
    const r = await fetch(`/api/competitif/${quoi}?periode=${paPeriode}`
      + (paLexique === null ? "" : `&lexique=${encodeURIComponent(paLexique)}`));
    const d = await r.json();
    if (mien !== paDemande) return;
    if (!r.ok) { $("pa-tableau").replaceChildren(tableauVide(t(d.erreur ?? "serveur injoignable"))); return; }
    if (paOnglet === "medailles") rendreLesMedailles(d.lignes ?? []);
    else rendreLesSolos(d.solos ?? [], d.minimum ?? 10);
  } catch {
    if (mien !== paDemande) return;
    $("pa-tableau").replaceChildren(tableauVide(t("serveur injoignable")));
  }
}

/** Une pastille de metal, devant son compte. */
function metal(classe: string, n: number): HTMLElement {
  const td = el("td", "");
  td.appendChild(el("span", `pa-metal pa-${classe}`));
  td.appendChild(document.createTextNode(` ${n}`));
  return td;
}

function rendreLesMedailles(lignes: LigneDeMedailles[]): void {
  $("pa-detail").textContent = t("Les trois premiers de chaque partie du jour, une fois la journée close.");
  if (lignes.length === 0) {
    $("pa-tableau").replaceChildren(tableauVide(t("Aucune médaille pour l'instant.")));
    return;
  }
  const table = el("table");
  table.appendChild(tete([
    { texte: "#" }, { texte: t("Joueur"), classe: "g" }, { texte: t("Or") },
    { texte: t("Argent") }, { texte: t("Bronze") }, { texte: t("Total") },
  ], t("Or")));
  const corps = el("tbody");
  lignes.forEach((l, i) => {
    const tr = el("tr");
    tr.appendChild(celluleDuRang(i + 1));
    const qui = el("td", "g");
    qui.appendChild(pseudoCliquable(l.compte));
    tr.appendChild(qui);
    tr.append(metal("or", l.or), metal("argent", l.argent), metal("bronze", l.bronze));
    tr.appendChild(el("td", "fort", String(l.or + l.argent + l.bronze)));
    corps.appendChild(tr);
  });
  table.appendChild(corps);
  $("pa-tableau").replaceChildren(table);
}

function rendreLesSolos(solos: SoloVue[], minimum: number): void {
  $("pa-detail").textContent = t2("Les coups qu'un seul joueur a trouvés, sur les parties jouées par au moins {n} joueurs.",
    { n: minimum });
  if (solos.length === 0) {
    $("pa-tableau").replaceChildren(tableauVide(t("Aucun solo pour l'instant.")));
    return;
  }
  const table = el("table");
  table.appendChild(tete([
    { texte: t("Jour") }, { texte: t("Partie"), classe: "g" }, { texte: t("Cp.") },
    { texte: t("Mot"), classe: "g" }, { texte: t("Pos.") }, { texte: t("Score") },
    { texte: t("Joueur"), classe: "g" }, { texte: t("Joueurs") }, { texte: "", classe: "c" },
  ]));
  const corps = el("tbody");
  for (const s of solos) {
    const tr = el("tr");
    tr.appendChild(el("td", "", new Date(`${s.jour}T12:00:00Z`).toLocaleDateString(
      langue() === "en" ? "en-GB" : "fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })));
    tr.appendChild(el("td", "g", `P${s.partie} · ${dictionnaire(s.lexique).nom.split(" ")[0]}`));
    tr.appendChild(el("td", "", String(s.coup)));
    tr.appendChild(el("td", "g rs-mot", s.mot));
    tr.appendChild(el("td", "", noteCoup(s.dir, s.x, s.y, 7)));
    tr.appendChild(el("td", "", String(s.score)));
    const qui = el("td", "g");
    s.equipe.forEach((nom, i) => {
      if (i > 0) qui.appendChild(document.createTextNode(" + "));
      qui.appendChild(pseudoCliquable(nom));
    });
    tr.appendChild(qui);
    tr.appendChild(el("td", "", String(s.joueurs)));
    const outils = el("td", "c");
    const revoir = el("button", "rc-outil", t("Revoir")) as HTMLButtonElement;
    revoir.type = "button";
    revoir.title = t("Revoir ce coup");
    revoir.addEventListener("click", () => {
      void ouvrirLaPartie(s.manche, s.coup, "competitif", () => ouvrirLePalmares());
    });
    outils.appendChild(revoir);
    tr.appendChild(outils);
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  $("pa-tableau").replaceChildren(table);
}

// ------------------------------------------------- LES TOURNOIS DE BATTLE

interface LigneDePouleVue {
  camp: string;
  rang: number;
  points: number;
  gagnees: number;
  nulles: number;
  perdues: number;
  manchesGagnees: number;
  manchesPerdues: number;
  pointsDeManche: number;
  jouees: number;
}

interface MancheDeRencontreVue {
  n: number;
  salon: string;
  points: [number, number] | null;
  gagnant: string | null;
  fin: number | null;
  ouverte: boolean;
}

interface RencontreVue {
  id: string;
  phase: string;
  tour: number;
  camps: [string, string];
  bo: number;
  limite: number;
  butoir: number;
  /** L'heure imposée à sa phase, ou `null` si elle est libre. */
  imposee: number | null;
  fin: { gagnant: string | null; par: string; at: number } | null;
  manches: MancheDeRencontreVue[];
  messages: { de: string; texte: string; at: number }[];
  moi: boolean;
}

interface BattleVue {
  phase: "inscriptions" | "poules" | "tableau" | "fini";
  entete: string;
  camps: { camp: string; nom: string; joueurs: string[] }[];
  poules: { n: number; camps: string[]; classement: LigneDePouleVue[]; tours: number }[];
  rencontres: RencontreVue[];
  /** Toutes les rencontres de poule sont-elles tranchées ? */
  poulesFinies: boolean;
  /** Qui est entré par le haut et par le bas, `null` tant que rien n'est posé. */
  tableau: { haut: string[]; bas: string[] } | null;
  /** La grande finale, quand le tableau est lancé. */
  finale: string | null;
  /** Le classement final, une fois la grande finale jouée. */
  classement: { camp: string; place: number }[];
  /** Les heures imposées, par phase. Vide tant qu'aucune ne l'est. */
  dates: Record<string, number>;
  moi: { camp: string | null; dispos: string; arbitre: boolean } | null;
  dispos: Record<string, string>;
}

/** La composition en cours d'édition, tant que les poules ne sont pas validées. */
let poulesEnCours: string[][] | null = null;

/** Le nom d'un camp : celui de l'équipe s'il y en a un, le pseudo sinon. */
function nomDuCamp(b: BattleVue, camp: string): string {
  return b.camps.find((c) => c.camp === camp)?.nom ?? camp;
}

/**
 * LE NOM D'UN CAMP, CLIQUABLE.
 *
 * Un camp d'un seul joueur mène à sa page ; une équipe ouvre la liste de ses
 * joueurs, chaque pseudo cliquable à son tour (SPEC.md §29).
 */
function campCliquable(b: BattleVue, camp: string): HTMLElement {
  const c = b.camps.find((x) => x.camp === camp);
  if (c === undefined || c.joueurs.length <= 1) return pseudoCliquable(camp);
  const s = el("button", "lien camp-equipe", c.nom) as HTMLButtonElement;
  s.type = "button";
  s.title = c.joueurs.join(", ");
  s.addEventListener("click", () => {
    const corps = el("div", "camp-joueurs");
    for (const j of c.joueurs) corps.appendChild(pseudoCliquable(j));
    ouvrirUneFenetre(c.nom, corps);
  });
  return s;
}

/** Le score d'une rencontre en manches gagnées, « 2-1 ». */
function scoreDeLaRencontre(r: RencontreVue): [number, number] {
  const compte = (i: 0 | 1): number =>
    r.manches.filter((m) => m.gagnant !== null && m.gagnant === r.camps[i]).length;
  return [compte(0), compte(1)];
}

/** Ce qu'une rencontre a donné pour un camp : gagnée, nulle, perdue, en attente. */
function issueDeLaRencontre(r: RencontreVue, camp: string): "gagnee" | "nulle" | "perdue" | "absente" | "attente" {
  if (r.fin === null) return "attente";
  if (r.fin.gagnant === null) return r.fin.par === "arbitrage" ? "absente" : "nulle";
  return r.fin.gagnant === camp ? "gagnee" : "perdue";
}

/**
 * LA TABLE D'UNE POULE (SPEC.md §29).
 *
 * Le rang, le joueur, son bilan, puis UNE COLONNE PAR TOUR portant le score en
 * manches et l'adversaire. La bande de gauche dit la qualification ; elle reste
 * indicative tant que le tableau n'est pas validé, parce que les qualifiés se
 * prennent sur toutes les poules à la fois.
 */
function tableDeLaPoule(
  x: TournoiVue, b: BattleVue, p: BattleVue["poules"][number],
): HTMLElement {
  const boite = el("div", "pl-poule");
  boite.appendChild(el("h2", "pl-titre", t2("Poule {n}", { n: p.n })));
  const table = el("table");
  const tete = el("tr");
  tete.append(
    el("th", "pl-rang", "#"), el("th", "pl-nom", t("Joueur")),
    el("th", "pl-bilan", t("Renc.")), el("th", "pl-bilan", t("Manches")),
    el("th", "pl-pts", t("Pts")),
  );
  for (let tour = 1; tour <= p.tours; tour++) tete.appendChild(el("th", "pl-tour", `T${tour}`));
  const thead = el("thead");
  thead.appendChild(tete);
  table.appendChild(thead);

  // COMBIEN PASSENT, PAR POULE. Le réglage compte les qualifiés du tournoi
  // entier ; on le répartit pour dessiner la bande, faute de mieux avant que
  // le tableau soit posé.
  const nbPoules = Math.max(1, b.poules.length);
  const parPoule = x.battle?.qualifies == null
    ? p.classement.length : Math.ceil(x.battle.qualifies / nbPoules);
  const hautParPoule = x.battle?.tableauHaut == null
    ? Math.ceil(parPoule / 2) : Math.ceil(x.battle.tableauHaut / nbPoules);

  const corps = el("tbody");
  for (const l of p.classement) {
    const tr = el("tr");
    tr.classList.add(l.rang <= hautParPoule ? "pl-haut" : l.rang <= parPoule ? "pl-bas" : "pl-hors");
    if (b.moi?.camp === l.camp) tr.classList.add("pl-moi");
    tr.appendChild(el("td", "pl-rang", String(l.rang)));
    const nom = el("td", "pl-nom");
    nom.appendChild(campCliquable(b, l.camp));
    tr.appendChild(nom);
    tr.appendChild(el("td", "pl-bilan", l.nulles > 0
      ? `${l.gagnees} - ${l.nulles} - ${l.perdues}` : `${l.gagnees} - ${l.perdues}`));
    tr.appendChild(el("td", "pl-bilan", `${l.manchesGagnees} - ${l.manchesPerdues}`));
    tr.appendChild(el("td", "pl-pts", String(l.points)));
    for (let tour = 1; tour <= p.tours; tour++) {
      const r = b.rencontres.find((y) =>
        y.phase === `poule:${p.n - 1}` && y.tour === tour && y.camps.includes(l.camp));
      const td = el("td", "pl-tour");
      if (r === undefined) {
        // EXEMPT DE CE TOUR : un effectif impair en laisse un par ronde.
        td.classList.add("pl-exempt");
        td.textContent = "—";
        tr.appendChild(td);
        continue;
      }
      const issue = issueDeLaRencontre(r, l.camp);
      td.classList.add(`pl-${issue}`);
      const sien = r.camps[0] === l.camp ? 0 : 1;
      const score = scoreDeLaRencontre(r);
      const autre = r.camps[sien === 0 ? 1 : 0]!;
      // UNE RENCONTRE QU'ON N'A PAS ENCORE JOUEE N'AFFICHE PAS « 0:0 » : ce
      // serait un resultat, et c'en n'est pas un. Reste l'adversaire, qui est
      // justement ce qu'on vient lire.
      const joue = r.manches.some((m) => m.points !== null);
      td.appendChild(el("span", "pl-score", issue === "absente" || !joue ? "—"
        : `${score[sien]}:${score[sien === 0 ? 1 : 0]}`));
      td.appendChild(el("span", "pl-contre", nomDuCamp(b, autre)));
      td.title = `${t("contre")} ${nomDuCamp(b, autre)}`;
      td.addEventListener("click", () => ouvrirLaRencontre(x, b, r));
      tr.appendChild(td);
    }
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  boite.appendChild(table);
  return boite;
}

/** Le détail d'une rencontre : ses manches, et le rejeu de chacune. */
function ouvrirLaRencontre(x: TournoiVue, b: BattleVue, r: RencontreVue): void {
  const corps = el("div", "rn-detail");
  const score = scoreDeLaRencontre(r);
  const titre = el("div", "rn-tete");
  titre.append(campCliquable(b, r.camps[0]), el("b", "rn-score", `${score[0]} - ${score[1]}`),
    campCliquable(b, r.camps[1]));
  corps.appendChild(titre);
  corps.appendChild(el("p", "sub", r.fin === null
    ? t2("Au meilleur de {n} manches.", { n: r.bo })
    : r.fin.gagnant === null
      ? (r.fin.par === "arbitrage" ? t("Rencontre non jouée.") : t("Rencontre nulle."))
      : t2("{nom} l'emporte.", { nom: nomDuCamp(b, r.fin.gagnant) })));
  const faites = r.manches.filter((m) => m.points !== null);
  if (faites.length === 0) corps.appendChild(el("p", "none", t("Aucune manche jouée.")));
  for (const m of faites) {
    const ligne = el("div", "rn-manche");
    ligne.append(
      el("span", "rn-n", t2("Manche {n}", { n: m.n })),
      el("span", "rn-pts", `${m.points![0]} - ${m.points![1]}`),
    );
    const revoir = el("button", "lien", t("Revoir")) as HTMLButtonElement;
    revoir.type = "button";
    revoir.addEventListener("click", () => { fermerLaFenetre(); allerA(m.salon); });
    ligne.appendChild(revoir);
    corps.appendChild(ligne);
  }
  if (r.messages.length > 0) {
    corps.appendChild(el("h3", "rn-sous", t("Messages")));
    for (const msg of r.messages) {
      const ligne = el("div", "rn-msg");
      ligne.append(el("b", "", msg.de), document.createTextNode(` · ${msg.texte}`));
      corps.appendChild(ligne);
    }
  }
  if (b.moi?.arbitre === true && r.fin === null) corps.appendChild(boutonsDArbitrage(x, b, r));
  ouvrirUneFenetre(t2("{a} contre {b}", {
    a: nomDuCamp(b, r.camps[0]), b: nomDuCamp(b, r.camps[1]),
  }), corps);
}

/** L'arbitrage d'une rencontre non jouée : à son créateur et à l'administration. */
function boutonsDArbitrage(x: TournoiVue, b: BattleVue, r: RencontreVue): HTMLElement {
  const boite = el("div", "rn-arbitrage");
  boite.appendChild(el("h3", "rn-sous", t("Arbitrage")));
  const erreur = el("div", "join-error");
  erreur.hidden = true;
  const envoyer = async (corps: Record<string, unknown>): Promise<void> => {
    const { ok, d } = await envoyerAuServeur(
      `/api/rencontre/${encodeURIComponent(r.id)}/arbitrer`, corps);
    if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
    fermerLaFenetre();
    ouvrirLeTournoi(x.id, false);
  };
  const ligne = el("div", "ad-ligne");
  for (const camp of r.camps) {
    const bt = el("button", "", t2("{nom} gagne", { nom: nomDuCamp(b, camp) })) as HTMLButtonElement;
    bt.type = "button";
    bt.addEventListener("click", () => void envoyer({ quoi: "victoire", qui: camp }));
    ligne.appendChild(bt);
  }
  const personne = el("button", "", t("Personne ne gagne")) as HTMLButtonElement;
  personne.type = "button";
  personne.addEventListener("click", () => void envoyer({ quoi: "personne" }));
  ligne.appendChild(personne);
  boite.appendChild(ligne);
  const date = champDate(r.butoir);
  const delai = el("button", "", t("Repousser la date butoir")) as HTMLButtonElement;
  delai.type = "button";
  delai.addEventListener("click", () => {
    const quand = Date.parse(`${date.value}:00`);
    if (!Number.isFinite(quand)) { direLErreur(erreur, t("Donnez une date")); return; }
    void envoyer({ quoi: "delai", butoir: quand });
  });
  const ligne2 = el("div", "ad-ligne");
  ligne2.append(date, delai);
  boite.append(ligne2, erreur);
  return boite;
}

/**
 * MES RENCONTRES (SPEC.md §29).
 *
 * L'adversaire, les deux dates, et les deux gestes : l'inviter tout de suite,
 * ou lui laisser un mot pour fixer un créneau.
 */
function mesRencontres(x: TournoiVue, b: BattleVue, maintenant: number): HTMLElement | null {
  const miennes = b.rencontres.filter((r) => r.moi && r.fin === null);
  if (b.moi?.camp == null) return null;
  const boite = el("section", "to-b-bloc");
  boite.appendChild(el("h1", "", t("Mes rencontres")));

  // MES DISPONIBILITES, ECRITES UNE FOIS POUR LE TOURNOI : les réécrire pour
  // chaque adversaire n'aurait pas de sens.
  const dispos = document.createElement("textarea");
  dispos.className = "to-dispos";
  dispos.rows = 2;
  dispos.value = b.moi.dispos;
  dispos.placeholder = t("Mes disponibilités, lues par tous mes adversaires");
  dispos.addEventListener("change", () => {
    void envoyerAuServeur(`/api/tournoi/${encodeURIComponent(x.id)}/dispos`, { texte: dispos.value });
  });
  boite.appendChild(dispos);

  if (miennes.length === 0) {
    boite.appendChild(el("p", "none", t("Aucune rencontre à jouer.")));
    return boite;
  }
  for (const r of miennes) {
    const autre = r.camps[0] === b.moi.camp ? r.camps[1]! : r.camps[0]!;
    const carte = el("div", "rn-carte");
    const tete = el("div", "rn-carte-tete");
    tete.append(el("span", "rn-contre", t("contre")), campCliquable(b, autre));
    const score = scoreDeLaRencontre(r);
    if (score[0] + score[1] > 0) {
      const mien = r.camps[0] === b.moi.camp ? 0 : 1;
      tete.appendChild(el("b", "rn-score",
        `${score[mien]} - ${score[mien === 0 ? 1 : 0]}`));
    }
    carte.appendChild(tete);
    // UNE PHASE A HEURE FIXEE NE SE NEGOCIE PAS : on dit l'heure, et rien
    // d'autre. Les fenêtres n'ont plus de sens quand le rendez-vous est pris.
    carte.appendChild(el("div", "sub", [
      t2("Au meilleur de {n} manches", { n: r.bo }),
      ...(r.imposee !== null
        ? [t2("le {d}", { d: dateDeTournoi(r.imposee) })]
        : [t2("limite le {d}", { d: dateDeTournoi(r.limite) }),
          t2("butoir le {d}", { d: dateDeTournoi(r.butoir) })]),
    ].join(" · ")));
    const sien = b.dispos[autre] ?? "";
    if (sien.trim() !== "") {
      carte.appendChild(el("div", "rn-dispos",
        `${t2("Disponibilités de {nom}", { nom: nomDuCamp(b, autre) })} : ${sien}`));
    }
    const erreur = el("div", "join-error");
    erreur.hidden = true;
    const gestes = el("div", "ad-ligne");
    const jouer = el("button", "vert", t("Inviter et jouer")) as HTMLButtonElement;
    jouer.type = "button";
    if (r.imposee !== null && maintenant < r.imposee) {
      jouer.disabled = true;
      jouer.title = t2("Cette phase se joue le {d}", { d: dateDeTournoi(r.imposee) });
    }
    jouer.addEventListener("click", () => {
      void (async () => {
        jouer.disabled = true;
        const { ok, d } = await envoyerAuServeur(
          `/api/rencontre/${encodeURIComponent(r.id)}/inviter`, {});
        jouer.disabled = false;
        if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
        allerA(String(d.salon));
      })();
    });
    const ecrire = el("button", "", t("Proposer un créneau")) as HTMLButtonElement;
    ecrire.type = "button";
    ecrire.addEventListener("click", () => demanderUnCreneau(x, b, r, autre));
    gestes.append(jouer, ecrire);
    if (maintenant > r.butoir) {
      carte.appendChild(el("div", "rn-tard", t("La date butoir est passée : l'organisateur tranchera.")));
    }
    const fil = el("button", "lien", r.messages.length > 0
      ? t2("Messages ({n})", { n: r.messages.length }) : t("Messages")) as HTMLButtonElement;
    fil.type = "button";
    fil.addEventListener("click", () => ouvrirLaRencontre(x, b, r));
    gestes.appendChild(fil);
    carte.append(gestes, erreur);
    boite.appendChild(carte);
  }
  return boite;
}

/** Une demande de créneau : le message part en notification à l'adversaire. */
function demanderUnCreneau(x: TournoiVue, b: BattleVue, r: RencontreVue, autre: string): void {
  const corps = el("div", "");
  corps.appendChild(el("p", "sub",
    t2("{nom} recevra une notification avec votre message.", { nom: nomDuCamp(b, autre) })));
  const texte = document.createElement("textarea");
  texte.rows = 3;
  texte.className = "to-dispos";
  texte.placeholder = t("Mardi ou jeudi après 20 h ?");
  const erreur = el("div", "join-error");
  erreur.hidden = true;
  const envoyer = el("button", "valider", t("Envoyer")) as HTMLButtonElement;
  envoyer.type = "button";
  envoyer.addEventListener("click", () => {
    void (async () => {
      envoyer.disabled = true;
      const { ok, d } = await envoyerAuServeur(
        `/api/rencontre/${encodeURIComponent(r.id)}/message`, { texte: texte.value });
      envoyer.disabled = false;
      if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
      fermerLaFenetre();
      ouvrirLeTournoi(x.id, false);
    })();
  });
  corps.append(texte, erreur, envoyer);
  ouvrirUneFenetre(t("Proposer un créneau"), corps);
}

/** Les rencontres qui se jouent en ce moment, et le bouton pour les regarder. */
function rencontresEnCours(x: TournoiVue, b: BattleVue): HTMLElement | null {
  const vivantes = b.rencontres
    .filter((r) => r.manches.some((m) => m.ouverte))
    .map((r) => ({ r, m: r.manches.find((m) => m.ouverte)! }));
  if (vivantes.length === 0) return null;
  const boite = el("section", "to-b-bloc");
  boite.appendChild(el("h1", "", t("Rencontres en cours")));
  for (const { r, m } of vivantes) {
    const ligne = el("div", "rn-carte");
    const tete = el("div", "rn-carte-tete");
    tete.append(campCliquable(b, r.camps[0]), el("span", "rn-contre", t("contre")),
      campCliquable(b, r.camps[1]), el("span", "sub", t2("manche {n}", { n: m.n })));
    const regarder = el("button", "", t("Regarder")) as HTMLButtonElement;
    regarder.type = "button";
    regarder.addEventListener("click", () => allerA(m.salon));
    ligne.append(tete, regarder);
    boite.appendChild(ligne);
  }
  return boite;
}

/**
 * L'EDITEUR DE POULES (SPEC.md §29).
 *
 * On tire, on retouche à la main, on retire, et l'on valide. Rien n'est acquis
 * avant la validation : c'est elle qui ferme les inscriptions pour de bon.
 */
function editeurDesPoules(x: TournoiVue, b: BattleVue): HTMLElement {
  const bat = x.battle!;
  const boite = el("section", "to-b-bloc");
  boite.appendChild(el("h1", "", t("Composer les poules")));
  let joueursParPoule = bat.joueursParPoule;
  let manchesParPoule = bat.manchesParPoule;
  let qualifies = bat.qualifies;
  let tableauHaut = bat.tableauHaut;
  const limite = champDate(bat.limitePoules);

  const grille = el("div", "pl-edit");
  const erreur = el("div", "join-error");
  erreur.hidden = true;

  const peindre = (): void => {
    grille.replaceChildren();
    const les = poulesEnCours ?? [];
    if (les.length === 0) {
      grille.appendChild(el("p", "none", t("Tirez les poules pour commencer.")));
      return;
    }
    les.forEach((poule, i) => {
      const colonne = el("div", "pl-colonne");
      colonne.appendChild(el("h2", "pl-titre", t2("Poule {n}", { n: i + 1 })));
      for (const camp of poule) {
        const ligne = el("div", "pl-chip");
        ligne.appendChild(el("span", "pl-chip-nom", nomDuCamp(b, camp)));
        // ON DEPLACE PAR UNE LISTE, PAS PAR GLISSER-DEPOSER : le geste est le
        // meme au doigt et a la souris, et rien ne se perd en route.
        const ou = document.createElement("select");
        les.forEach((_, j) => {
          const o = document.createElement("option");
          o.value = String(j);
          o.textContent = t2("Poule {n}", { n: j + 1 });
          o.selected = j === i;
          ou.appendChild(o);
        });
        ou.addEventListener("change", () => {
          const vers = Number(ou.value);
          if (vers === i || poulesEnCours === null) return;
          poulesEnCours[i] = poulesEnCours[i]!.filter((c) => c !== camp);
          poulesEnCours[vers]!.push(camp);
          peindre();
        });
        ligne.appendChild(ou);
        colonne.appendChild(ligne);
      }
      colonne.appendChild(el("div", "pl-compte",
        t2(poule.length > 1 ? "{n} joueurs" : "{n} joueur", { n: poule.length })));
      grille.appendChild(colonne);
    });
  };

  const tirer = el("button", "", t("Tirer les poules")) as HTMLButtonElement;
  tirer.type = "button";
  tirer.addEventListener("click", () => {
    void (async () => {
      tirer.disabled = true;
      const { ok, d } = await envoyerAuServeur(
        `/api/tournoi/${encodeURIComponent(x.id)}/poules/tirer`, { joueursParPoule });
      tirer.disabled = false;
      if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
      poulesEnCours = d.poules as string[][];
      // Le bouton dit ce qu'il fera la prochaine fois : le premier tirage
      // compose, les suivants recommencent.
      tirer.textContent = t("Retirer au sort");
      peindre();
    })();
  });

  const valider = el("button", "valider", t("Valider et lancer la phase de poules")) as HTMLButtonElement;
  valider.type = "button";
  valider.addEventListener("click", () => {
    if (poulesEnCours === null) { direLErreur(erreur, t("Tirez les poules d'abord")); return; }
    confirmer(t("Lancer la phase de poules ? Les inscriptions seront closes."), () => {
      void (async () => {
        valider.disabled = true;
        const { ok, d } = await envoyerAuServeur(`/api/tournoi/${encodeURIComponent(x.id)}/poules`, {
          poules: poulesEnCours, joueursParPoule, manchesParPoule, qualifies, tableauHaut,
          limitePoules: limite.value,
        });
        valider.disabled = false;
        if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
        poulesEnCours = null;
        ouvrirLeTournoi(x.id, false);
      })();
    });
  });

  const reglages = el("div", "pl-reglages");
  reglages.append(
    champ(t("Joueurs par poule"), compteur(2, 32, joueursParPoule, (n) => { joueursParPoule = n; })),
    champ(t("Manches par rencontre"), compteurImpair(manchesParPoule, (n) => { manchesParPoule = n; })),
    champ(t("Qualifiés"), compteurOuTous(2, 256, qualifies, t("Tous"), (n) => { qualifies = n; })),
    champ(t("Dont au tableau haut"), compteurOuTous(1, 256, tableauHaut, t("La moitié"), (n) => { tableauHaut = n; })),
    champ(t("Date limite des poules"), limite),
  );
  const gestes = el("div", "ad-ligne");
  gestes.append(tirer, valider);
  peindre();
  boite.append(reglages, gestes, grille, erreur);
  return boite;
}

/** Un compteur qui ne passe que par les nombres impairs. */
function compteurImpair(valeur: number, surChange: (n: number) => void): HTMLElement {
  const boite = el("div", "ad-ligne");
  boite.style.margin = "0";
  let n = valeur % 2 === 0 ? valeur + 1 : valeur;
  const moins = el("button", "", "−") as HTMLButtonElement;
  const plus = el("button", "", "+") as HTMLButtonElement;
  const vu = el("b", "", String(n));
  const poser = (x: number): void => {
    n = Math.max(1, Math.min(9, x));
    vu.textContent = String(n);
    moins.disabled = n <= 1;
    plus.disabled = n >= 9;
    surChange(n);
  };
  moins.type = "button";
  plus.type = "button";
  moins.addEventListener("click", () => poser(n - 2));
  plus.addEventListener("click", () => poser(n + 2));
  boite.append(moins, vu, plus);
  poser(n);
  return boite;
}

/** Un compteur qu'une case ramène à « tout le monde ». */
function compteurOuTous(
  min: number, max: number, valeur: number | null, tous: string,
  surChange: (n: number | null) => void,
): HTMLElement {
  const boite = el("div", "ad-ligne");
  boite.style.margin = "0";
  let n = valeur;
  const dedans = el("div", "");
  const case1 = document.createElement("label");
  case1.className = "case";
  const coche = document.createElement("input");
  coche.type = "checkbox";
  coche.checked = n === null;
  case1.append(coche, document.createTextNode(` ${tous}`));
  const refaire = (): void => {
    dedans.replaceChildren();
    if (n !== null) dedans.appendChild(compteur(min, max, n, (v) => { n = v; surChange(v); }));
    surChange(n);
  };
  coche.addEventListener("change", () => {
    n = coche.checked ? null : Math.max(min, valeur ?? min);
    refaire();
  });
  refaire();
  boite.append(case1, dedans);
  return boite;
}

/** L'en-tête libre de la page, écrit par le créateur ou l'administration. */
function peindreLEnteteDuTournoi(x: TournoiVue, b: BattleVue, peutEcrire: boolean): void {
  const boite = $("to-entete");
  boite.replaceChildren();
  boite.hidden = b.entete.trim() === "" && !peutEcrire;
  if (b.entete.trim() !== "") boite.appendChild(el("p", "to-entete-texte", b.entete));
  if (!peutEcrire) return;
  const modifier = el("button", "lien", b.entete.trim() === ""
    ? t("Écrire un en-tête") : t("Modifier l'en-tête")) as HTMLButtonElement;
  modifier.type = "button";
  modifier.addEventListener("click", () => {
    const corps = el("div", "");
    const texte = document.createElement("textarea");
    texte.rows = 6;
    texte.className = "to-dispos";
    texte.value = b.entete;
    texte.placeholder = t("Ce que les joueurs doivent savoir et que le format ne dit pas");
    const erreur = el("div", "join-error");
    erreur.hidden = true;
    const valider = el("button", "valider", t("Enregistrer")) as HTMLButtonElement;
    valider.type = "button";
    valider.addEventListener("click", () => {
      void (async () => {
        const { ok, d } = await envoyerAuServeur(
          `/api/tournoi/${encodeURIComponent(x.id)}/entete`, { texte: texte.value });
        if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
        fermerLaFenetre();
        ouvrirLeTournoi(x.id, false);
      })();
    });
    corps.append(texte, erreur, valider);
    ouvrirUneFenetre(t("En-tête du tournoi"), corps);
  });
  boite.appendChild(modifier);
}

/** Tout ce qu'un tournoi de battle ajoute à sa page. */
function peindreLeBattle(x: TournoiVue, b: BattleVue, maintenant: number, regle: boolean): void {
  peindreLEnteteDuTournoi(x, b, regle);
  const boite = $("to-battle");
  boite.hidden = false;
  const blocs: HTMLElement[] = [];
  if (regle && b.phase === "inscriptions") blocs.push(editeurDesPoules(x, b));
  const miennes = mesRencontres(x, b, maintenant);
  if (miennes !== null && b.phase !== "inscriptions") blocs.push(miennes);
  const vivantes = rencontresEnCours(x, b);
  if (vivantes !== null) blocs.push(vivantes);
  // LE CLASSEMENT FINAL D'ABORD : quand un tournoi est fini, c'est ce qu'on
  // vient lire, et non le chemin qui y a mene.
  const podium = classementFinalDuBattle(b);
  if (podium !== null) blocs.push(podium);
  if (regle && b.phase === "poules") blocs.push(editeurDuTableau(x, b));
  if (regle) {
    const heures = heuresDesPhases(x, b);
    if (heures !== null) blocs.push(heures);
  }
  const dessin = tableauDuBattle(x, b);
  if (dessin !== null) {
    const section = el("section", "to-b-bloc");
    section.appendChild(el("h1", "", t("Double tableau")));
    section.appendChild(dessin);
    blocs.push(section);
  }
  if (b.poules.length > 0) {
    const section = el("section", "to-b-bloc");
    section.appendChild(el("h1", "", t("Poules")));
    const tables = el("div", "pl-tables");
    for (const p of b.poules) tables.appendChild(tableDeLaPoule(x, b, p));
    section.appendChild(tables);
    section.appendChild(el("p", "sub", t(
      "Les bandes de couleur disent la qualification ; elles restent indicatives tant que le tableau n'est pas validé.")));
    blocs.push(section);
  }
  // LE FORFAIT : à l'organisateur, et il touche toutes les rencontres restantes.
  if (regle && b.phase !== "inscriptions") {
    const section = el("section", "to-b-bloc");
    section.appendChild(el("h1", "", t("Déclarer un forfait")));
    const erreur = el("div", "join-error");
    erreur.hidden = true;
    const choix = document.createElement("select");
    for (const c of b.camps) {
      const o = document.createElement("option");
      o.value = c.camp;
      o.textContent = c.nom;
      choix.appendChild(o);
    }
    const bt = el("button", "", t("Déclarer forfait")) as HTMLButtonElement;
    bt.type = "button";
    bt.addEventListener("click", () => {
      confirmer(t2("Toutes les rencontres restantes de {nom} seront perdues. Continuer ?",
        { nom: choix.value }), () => {
        void (async () => {
          const { ok, d } = await envoyerAuServeur(
            `/api/tournoi/${encodeURIComponent(x.id)}/forfait`, { camp: choix.value });
          if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
          ouvrirLeTournoi(x.id, false);
        })();
      });
    });
    const ligne = el("div", "ad-ligne");
    ligne.append(choix, bt);
    section.append(ligne, erreur);
    blocs.push(section);
  }
  boite.replaceChildren(...blocs);
}

// -------------------------------------------------- LE DOUBLE TABLEAU

/** Un côté d'une rencontre, tel que le tableau le dessine. */
interface CoteDeTableau {
  /** Le nom du camp, ou ce qui l'y amènera : « Vainqueur du tour 1 ». */
  nom: string;
  camp: string | null;
  score: number | null;
  gagnant: boolean;
}

/** Le nom d'un tour, tel qu'il se lit en tête de colonne. */
function nomDuTour(phase: string, tour: number, dernierHaut: number, dernierBas: number): string {
  if (phase === "finale") return t("Grande finale");
  if (phase.startsWith("haut:")) {
    if (tour === dernierHaut) return t("Finale du tableau haut");
    if (tour === dernierHaut - 1) return t("Demi-finales du tableau haut");
    return t2("Tableau haut, tour {n}", { n: tour });
  }
  if (tour === dernierBas) return t("Finale du tableau bas");
  return t2("Tableau bas, tour {n}", { n: tour });
}

/** Une carte de rencontre dans le tableau : deux noms, deux scores. */
function carteDeTableau(
  cotes: [CoteDeTableau, CoteDeTableau], ouvrir: (() => void) | null,
): HTMLElement {
  const carte = el("div", "tb-match");
  if (ouvrir !== null) {
    carte.classList.add("tb-cliquable");
    carte.addEventListener("click", ouvrir);
  }
  for (const c of cotes) {
    const ligne = el("div", "tb-cote");
    if (c.gagnant) ligne.classList.add("tb-gagnant");
    if (c.camp === null) ligne.classList.add("tb-attente");
    ligne.append(
      el("span", "tb-cote-nom", c.nom),
      el("span", "tb-cote-score", c.score === null ? "" : String(c.score)),
    );
    carte.appendChild(ligne);
  }
  return carte;
}

/**
 * LE DOUBLE TABLEAU (SPEC.md §29).
 *
 * Une colonne par tour, le tableau haut puis le tableau bas, et la grande
 * finale au bout du haut. Chaque rencontre s'ouvre au clic sur ses manches.
 */
function tableauDuBattle(x: TournoiVue, b: BattleVue): HTMLElement | null {
  const duTableau = b.rencontres.filter((r) => !r.phase.startsWith("poule:"));
  if (duTableau.length === 0) return null;
  const derniere = (prefixe: string): number =>
    duTableau.reduce((a, r) => (r.phase.startsWith(prefixe) ? Math.max(a, r.tour) : a), 0);
  const dernierHaut = derniere("haut:");
  const dernierBas = derniere("bas:");

  const colonnes: { phase: string; tour: number; les: RencontreVue[] }[] = [];
  const ajouter = (prefixe: string, dernier: number): void => {
    for (let tour = 1; tour <= dernier; tour++) {
      const les = duTableau.filter((r) => r.phase === `${prefixe}${tour}`);
      if (les.length > 0) colonnes.push({ phase: `${prefixe}${tour}`, tour, les });
    }
  };
  const boite = el("div", "tb-tableau");

  const bande = (titre: string, colonnes: { phase: string; tour: number; les: RencontreVue[] }[]): void => {
    if (colonnes.length === 0) return;
    const rangee = el("div", "tb-bande");
    rangee.appendChild(el("h3", "tb-bande-titre", titre));
    const cols = el("div", "tb-colonnes");
    for (const c of colonnes) {
      const colonne = el("div", "tb-colonne");
      const impose = b.dates[c.phase];
      colonne.appendChild(el("h4", "tb-colonne-titre",
        nomDuTour(c.phase, c.tour, dernierHaut, dernierBas)));
      if (impose !== undefined) {
        colonne.appendChild(el("div", "tb-colonne-heure", dateDeTournoi(impose)));
      }
      for (const r of c.les) {
        const score = scoreDeLaRencontre(r);
        const joue = r.manches.some((m) => m.points !== null);
        const cotes = [0, 1].map((i): CoteDeTableau => ({
          nom: r.camps[i] === "" ? t("À désigner") : nomDuCamp(b, r.camps[i]!),
          camp: r.camps[i] === "" ? null : r.camps[i]!,
          score: joue ? score[i]! : null,
          gagnant: r.fin !== null && r.fin.gagnant === r.camps[i] && r.camps[i] !== "",
        })) as [CoteDeTableau, CoteDeTableau];
        colonne.appendChild(carteDeTableau(cotes, () => ouvrirLaRencontre(x, b, r)));
      }
      cols.appendChild(colonne);
    }
    rangee.appendChild(cols);
    boite.appendChild(rangee);
  };

  ajouter("haut:", dernierHaut);
  const finale = duTableau.filter((r) => r.phase === "finale");
  if (finale.length > 0) colonnes.push({ phase: "finale", tour: 1, les: finale });
  bande(t("Tableau haut"), colonnes);
  const basses: { phase: string; tour: number; les: RencontreVue[] }[] = [];
  for (let tour = 1; tour <= dernierBas; tour++) {
    const les = duTableau.filter((r) => r.phase === `bas:${tour}`);
    if (les.length > 0) basses.push({ phase: `bas:${tour}`, tour, les });
  }
  bande(t("Tableau bas"), basses);
  return boite;
}

/** Le classement final, avec ses trois médailles. */
function classementFinalDuBattle(b: BattleVue): HTMLElement | null {
  if (b.classement.length === 0) return null;
  const section = el("section", "to-b-bloc");
  section.appendChild(el("h1", "", t("Classement final")));
  const table = el("table", "pd-table");
  const corps = el("tbody");
  const MEDAILLES = ["\u{1F947}", "\u{1F948}", "\u{1F949}"];
  for (const l of b.classement) {
    const tr = el("tr");
    tr.append(el("td", "pd-place", MEDAILLES[l.place - 1] ?? String(l.place)));
    const nom = el("td", "pd-nom");
    nom.appendChild(campCliquable(b, l.camp));
    tr.appendChild(nom);
    corps.appendChild(tr);
  }
  table.appendChild(corps);
  section.appendChild(table);
  return section;
}

/**
 * L'APERÇU ET LA VALIDATION DU DOUBLE TABLEAU (SPEC.md §29).
 *
 * Les qualifiés s'y posent d'après leur classement de poule. L'organisateur
 * regarde, corrige ses réglages, et valide.
 */
function editeurDuTableau(x: TournoiVue, b: BattleVue): HTMLElement {
  const bat = x.battle!;
  const boite = el("section", "to-b-bloc");
  boite.appendChild(el("h1", "", t("Composer le tableau")));
  if (!b.poulesFinies) {
    boite.appendChild(el("p", "sub",
      t("Les poules ne sont pas toutes jouées : ce qui n'a pas été joué compte pour zéro.")));
  }
  let qualifies = bat.qualifies;
  let tableauHaut = bat.tableauHaut;
  let meilleurDe = bat.meilleurDe;
  let meilleurDeDemi = bat.meilleurDeDemi;
  let meilleurDeFinale = bat.meilleurDeFinale;
  let joursParTour = bat.joursParTour;

  const vue = el("div", "tb-apercu");
  const erreur = el("div", "join-error");
  erreur.hidden = true;

  const corps = (): Record<string, unknown> => ({
    qualifies, tableauHaut, meilleurDe, meilleurDeDemi, meilleurDeFinale, joursParTour,
  });

  const voir = async (): Promise<void> => {
    const { ok, d } = await envoyerAuServeur(
      `/api/tournoi/${encodeURIComponent(x.id)}/tableau/apercu`, corps());
    if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
    vue.replaceChildren(apercuDuPlan(b, d as {
      plan: { i: number; phase: string; tour: number; bo: number;
        sources: ({ t: "camp"; camp: string } | { t: "gagnant" | "perdant"; i: number })[] }[];
      haut: string[]; bas: string[];
    }));
  };

  const bouton = el("button", "", t("Voir l'aperçu")) as HTMLButtonElement;
  bouton.type = "button";
  bouton.addEventListener("click", () => { void voir(); });

  const valider = el("button", "valider", t("Valider et lancer le tableau")) as HTMLButtonElement;
  valider.type = "button";
  valider.addEventListener("click", () => {
    confirmer(t("Lancer le double tableau ? Les places y sont posées pour de bon."), () => {
      void (async () => {
        valider.disabled = true;
        const { ok, d } = await envoyerAuServeur(
          `/api/tournoi/${encodeURIComponent(x.id)}/tableau`, corps());
        valider.disabled = false;
        if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
        ouvrirLeTournoi(x.id, false);
      })();
    });
  });

  const reglages = el("div", "pl-reglages");
  reglages.append(
    champ(t("Qualifiés"), compteurOuTous(2, 256, qualifies, t("Tous"), (n) => { qualifies = n; })),
    champ(t("Dont au tableau haut"), compteurOuTous(1, 256, tableauHaut, t("La moitié"), (n) => { tableauHaut = n; })),
    champ(t("Meilleur de, en tableau"), compteurImpair(meilleurDe, (n) => { meilleurDe = n; })),
    champ(t("En demi-finale"), compteurImpair(meilleurDeDemi, (n) => { meilleurDeDemi = n; })),
    champ(t("En finale"), compteurImpair(meilleurDeFinale, (n) => { meilleurDeFinale = n; })),
    champ(t("Jours par tour"), compteur(1, 30, joursParTour, (n) => { joursParTour = n; })),
  );
  const gestes = el("div", "ad-ligne");
  gestes.append(bouton, valider);
  boite.append(reglages, gestes, vue, erreur);
  void voir();
  return boite;
}

/**
 * LES HEURES IMPOSEES, phase par phase (SPEC.md §29).
 *
 * Le régime ordinaire ne force rien : les joueurs s'arrangent entre la date
 * limite et la date butoir. L'organisateur peut clouer une phase à une heure
 * précise, et c'est ce qu'il faut pour une finale retransmise.
 */
function heuresDesPhases(x: TournoiVue, b: BattleVue): HTMLElement | null {
  const duTableau = b.rencontres.filter((r) => !r.phase.startsWith("poule:"));
  if (duTableau.length === 0) return null;
  const derniere = (prefixe: string): number =>
    duTableau.reduce((a, r) => (r.phase.startsWith(prefixe) ? Math.max(a, r.tour) : a), 0);
  const dernierHaut = derniere("haut:");
  const dernierBas = derniere("bas:");
  const phases: { phase: string; tour: number }[] = [];
  for (let n = 1; n <= dernierHaut; n++) phases.push({ phase: `haut:${n}`, tour: n });
  for (let n = 1; n <= dernierBas; n++) phases.push({ phase: `bas:${n}`, tour: n });
  if (duTableau.some((r) => r.phase === "finale")) phases.push({ phase: "finale", tour: 1 });

  const section = el("section", "to-b-bloc");
  section.appendChild(el("h1", "", t("Heures des phases")));
  section.appendChild(el("p", "sub", t(
    "Sans heure imposée, chaque tour garde sa fenêtre : les joueurs s'arrangent entre la date limite et la date butoir.")));
  const erreur = el("div", "join-error");
  erreur.hidden = true;
  const envoyer = async (phase: string, quand: string | null): Promise<void> => {
    const { ok, d } = await envoyerAuServeur(
      `/api/tournoi/${encodeURIComponent(x.id)}/date-phase`, { phase, quand });
    if (!ok) { direLErreur(erreur, String(d.erreur ?? "serveur injoignable")); return; }
    ouvrirLeTournoi(x.id, false);
  };
  for (const { phase, tour } of phases) {
    const impose = b.dates[phase];
    const ligne = el("div", "hp-ligne");
    ligne.appendChild(el("span", "hp-nom", nomDuTour(phase, tour, dernierHaut, dernierBas)));
    const date = champDate(impose ?? (duTableau.find((r) => r.phase === phase)?.limite ?? Date.now()));
    ligne.appendChild(date);
    const poser = el("button", "", impose === undefined ? t("Imposer") : t("Changer")) as HTMLButtonElement;
    poser.type = "button";
    poser.addEventListener("click", () => { void envoyer(phase, date.value); });
    ligne.appendChild(poser);
    if (impose !== undefined) {
      const libre = el("button", "lien", t("Laisser libre")) as HTMLButtonElement;
      libre.type = "button";
      libre.addEventListener("click", () => { void envoyer(phase, null); });
      ligne.appendChild(libre);
    }
    section.appendChild(ligne);
  }
  section.appendChild(erreur);
  return section;
}

/** Le plan d'un tableau, dessiné comme le tableau lui-même. */
function apercuDuPlan(b: BattleVue, d: {
  plan: { i: number; phase: string; tour: number; bo: number;
    sources: ({ t: "camp"; camp: string } | { t: "gagnant" | "perdant"; i: number })[] }[];
  haut: string[]; bas: string[];
}): HTMLElement {
  const boite = el("div", "tb-tableau");
  const dernier = (prefixe: string): number =>
    d.plan.reduce((a, p) => (p.phase.startsWith(prefixe) ? Math.max(a, p.tour) : a), 0);
  const dernierHaut = dernier("haut:");
  const dernierBas = dernier("bas:");
  const etiquette = (s: { t: string; camp?: string; i?: number }): string => {
    if (s.t === "camp") return nomDuCamp(b, s.camp ?? "");
    const p = d.plan[s.i ?? 0];
    const ou = p === undefined ? "" : nomDuTour(p.phase, p.tour, dernierHaut, dernierBas);
    return s.t === "gagnant"
      ? t2("Vainqueur · {ou}", { ou }) : t2("Perdant · {ou}", { ou });
  };
  const bande = (titre: string, phases: string[]): void => {
    const cols = el("div", "tb-colonnes");
    let vide = true;
    for (const phase of phases) {
      const les = d.plan.filter((p) => p.phase === phase);
      if (les.length === 0) continue;
      vide = false;
      const colonne = el("div", "tb-colonne");
      colonne.appendChild(el("h4", "tb-colonne-titre",
        `${nomDuTour(phase, les[0]!.tour, dernierHaut, dernierBas)} · ${t2("au meilleur de {n}", { n: les[0]!.bo })}`));
      for (const p of les) {
        colonne.appendChild(carteDeTableau([
          { nom: etiquette(p.sources[0]!), camp: p.sources[0]!.t === "camp" ? "x" : null, score: null, gagnant: false },
          { nom: etiquette(p.sources[1]!), camp: p.sources[1]!.t === "camp" ? "x" : null, score: null, gagnant: false },
        ], null));
      }
      cols.appendChild(colonne);
    }
    if (vide) return;
    const rangee = el("div", "tb-bande");
    rangee.append(el("h3", "tb-bande-titre", titre), cols);
    boite.appendChild(rangee);
  };
  const hauts = [];
  for (let i = 1; i <= dernierHaut; i++) hauts.push(`haut:${i}`);
  hauts.push("finale");
  bande(t("Tableau haut"), hauts);
  const basses = [];
  for (let i = 1; i <= dernierBas; i++) basses.push(`bas:${i}`);
  bande(t("Tableau bas"), basses);
  return boite;
}
