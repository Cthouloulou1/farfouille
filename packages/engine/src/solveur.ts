/**
 * Le solveur de recherche : anagrammes, mots formables depuis un tirage,
 * extensions d'un mot, squelettes a jokers. Rien a voir avec chercherLeMot
 * (ou poser un mot CONNU sur CETTE grille) ni movegen (tous les coups d'une
 * position) : ici il n'y a ni plateau ni ancrage, seulement le DAWG.
 *
 * TOUT REPOSE SUR LE DAWG SEUL, JAMAIS LE GADDAG. Un squelette avec une
 * etoile en tete ("*MOT", pour les rallonges avant) a l'air de demander un
 * prefixe non borne -- le terrain du GADDAG -- mais l'exploration reste bornee
 * par la taille du DAWG lui-meme (un noeud n'est jamais revisite dans le sens
 * ou on l'atteint), pas par la taille du dictionnaire : pas besoin d'un second
 * fichier compile pour ce module.
 *
 * DEUX FAMILLES DE RECHERCHE, DEUX ALGORITHMES :
 *   - un squelette (position par position : lettre fixe, "*" = un tronçon
 *     connexe quelconque, "." = une lettre libre) explore le DAWG en suivant
 *     le motif ;
 *   - un tirage (un sac de lettres, plus des jokers, sans ordre impose)
 *     explore le DAWG en consommant le sac.
 *
 * LE CHOIX REEL/JOKER NE SE DEVINE JAMAIS PAR ESSAIS : a chaque lettre d'un
 * mot en cours de formation, une lettre reelle disponible est TOUJOURS prise
 * en priorite, un joker seulement si le stock reel est epuise. Comme un joker
 * ne remplace jamais qu'UNE lettre precise, l'ordre dans lequel on consomme
 * les occurrences d'une meme lettre n'a aucune influence sur la faisabilite :
 * ce choix glouton ne rate donc jamais un mot formable, et il evite surtout
 * d'explorer deux fois le meme mot (une fois "avec la lettre", une fois "avec
 * le joker") -- ce qui aurait fait exploser le calcul avec plusieurs jokers.
 */
import { Dict, NO_EDGE } from "./dictionary.ts";
import { BLANK, code, letterOf } from "./alphabet.ts";

/** Un mot trouve, et les positions (index dans `mot`) a colorer differemment. */
export interface Correspondance {
  mot: string;
  jokers: number[];
}

/** Ce qu'a coute la recherche -- affiche pour garder un oeil sur le calcul. */
export interface StatsRecherche {
  ms: number;
  operations: number;
  limiteAtteinte: boolean;
}

export interface ResultatRecherche {
  resultats: Correspondance[];
  stats: StatsRecherche;
}

const PLAFOND_OPERATIONS = 4_000_000;

function maintenant(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Les aretes d'un noeud, dans l'ordre alphabetique -- c'est deja l'ordre du fichier. */
function* aretesDe(dict: Dict, node: number): Generator<{ code: number; cible: number; terminal: boolean }> {
  if (node === 0) return;
  const E = dict.edges;
  let i = node;
  for (;;) {
    const e = E[i]!;
    yield { code: e >>> 27, cible: e & 0x1ffffff, terminal: ((e >>> 25) & 1) === 1 };
    if (((e >>> 26) & 1) === 1) return;
    i++;
  }
}

// --- Squelettes : lettre fixe, "*" (tronçon quelconque, vide compris), "." (une lettre libre) ---

function explorerSquelette(
  dict: Dict, motif: string, onTrouve: (mot: string, jokers: number[]) => boolean,
): StatsRecherche {
  const t0 = maintenant();
  let operations = 0;
  let limiteAtteinte = false;

  function rec(pi: number, node: number, terminal: boolean, chemin: string, jokers: number[]): boolean {
    if (limiteAtteinte) return false;
    if (++operations > PLAFOND_OPERATIONS) { limiteAtteinte = true; return false; }
    if (pi === motif.length) {
      if (terminal && chemin.length > 0) return onTrouve(chemin, jokers);
      return true;
    }
    const c = motif[pi]!;
    if (c === "*") {
      // Zero lettre : on passe au symbole suivant sans bouger dans le DAWG.
      if (!rec(pi + 1, node, terminal, chemin, jokers)) return false;
      // Une lettre de plus, en restant sur la meme etoile.
      for (const a of aretesDe(dict, node)) {
        if (!rec(pi, a.cible, a.terminal, chemin + letterOf(a.code), jokers)) return false;
      }
      return true;
    }
    if (c === ".") {
      for (const a of aretesDe(dict, node)) {
        if (!rec(pi + 1, a.cible, a.terminal, chemin + letterOf(a.code), [...jokers, chemin.length])) return false;
      }
      return true;
    }
    const idx = dict.findEdge(node, code(c));
    if (idx === NO_EDGE) return true;
    const e = dict.edges[idx]!;
    return rec(pi + 1, Dict.target(e), Dict.isTerminal(e), chemin + c, jokers);
  }

  rec(0, dict.root, false, "", []);
  return { ms: maintenant() - t0, operations, limiteAtteinte };
}

/**
 * Tous les mots qui correspondent au squelette, dedupliques -- un motif avec
 * plusieurs etoiles peut retrouver le meme mot par plusieurs decoupages.
 */
export function squelette(dict: Dict, motif: string): ResultatRecherche {
  const trouves = new Map<string, number[]>();
  const stats = explorerSquelette(dict, motif, (mot, jokers) => {
    if (!trouves.has(mot)) trouves.set(mot, jokers);
    return true;
  });
  return { resultats: [...trouves].map(([mot, jokers]) => ({ mot, jokers })), stats };
}

/** Existe-t-il au moins une solution ? S'arrete au premier trouve. */
export function squeletteExiste(dict: Dict, motif: string): boolean {
  let trouve = false;
  explorerSquelette(dict, motif, () => { trouve = true; return false; });
  return trouve;
}

/** Le mot tape, jokers "?" compris, est-il au dictionnaire pour AU MOINS un choix des jokers ? */
export function estUnMotAvecJokers(dict: Dict, saisie: string): boolean {
  if (saisie.length === 0) return false;
  if (!saisie.includes(BLANK)) return dict.contains(saisie);
  return squeletteExiste(dict, saisie.split(BLANK).join("."));
}

// --- Tirages : un sac de lettres (jokers compris), n'importe quel ordre ---

function analyserTirage(tirage: string): { reel: Int32Array; jokers: number } {
  const reel = new Int32Array(26);
  let jokers = 0;
  for (const ch of tirage) {
    if (ch === BLANK) jokers++;
    else reel[code(ch) - 1]!++;
  }
  return { reel, jokers };
}

/**
 * Quelles lettres du mot trouve sont venues d'un joker : celles qui manquent
 * au reel, en prenant TOUJOURS la premiere occurrence rencontree -- c'est la
 * seule convention qui ne depende pas de l'ordre d'exploration.
 */
function positionsJoker(mot: string, reel: Int32Array): number[] {
  const besoin = new Int32Array(26);
  for (const ch of mot) besoin[code(ch) - 1]!++;
  const deficit = new Int32Array(26);
  for (let i = 0; i < 26; i++) deficit[i] = Math.max(0, besoin[i]! - reel[i]!);
  const vu = new Int32Array(26);
  const positions: number[] = [];
  for (let i = 0; i < mot.length; i++) {
    const idx = code(mot[i]!) - 1;
    if (vu[idx]! < deficit[idx]!) { positions.push(i); vu[idx]!++; }
  }
  return positions;
}

function explorerTirage(
  dict: Dict, reel: Int32Array, jokersDispo: number, onTrouve: (mot: string) => boolean,
): StatsRecherche {
  const t0 = maintenant();
  let operations = 0;
  let limiteAtteinte = false;
  const pris = new Int32Array(26);

  function rec(node: number, terminal: boolean, chemin: string, jokersPris: number): boolean {
    if (limiteAtteinte) return false;
    if (++operations > PLAFOND_OPERATIONS) { limiteAtteinte = true; return false; }
    if (terminal && chemin.length > 0) {
      if (!onTrouve(chemin)) return false;
    }
    for (const a of aretesDe(dict, node)) {
      const idx = a.code - 1;
      if (pris[idx]! < reel[idx]!) {
        pris[idx]!++;
        const suite = rec(a.cible, a.terminal, chemin + letterOf(a.code), jokersPris);
        pris[idx]!--;
        if (!suite) return false;
      } else if (jokersPris < jokersDispo) {
        if (!rec(a.cible, a.terminal, chemin + letterOf(a.code), jokersPris + 1)) return false;
      }
    }
    return true;
  }

  rec(dict.root, false, "", 0);
  return { ms: maintenant() - t0, operations, limiteAtteinte };
}

/**
 * Les mots formables avec ce tirage (jokers "?" compris, sans limite de
 * joker). `longueurExacte` restreint aux mots qui utilisent tout le tirage --
 * c'est ce que rend le bouton Solutions.
 */
export function motsFormables(dict: Dict, tirage: string, longueurExacte?: number): ResultatRecherche {
  const { reel, jokers } = analyserTirage(tirage);
  const mots: string[] = [];
  const stats = explorerTirage(dict, reel, jokers, (mot) => {
    if (longueurExacte === undefined || mot.length === longueurExacte) mots.push(mot);
    return true;
  });
  const resultats = mots.map((mot) => ({ mot, jokers: positionsJoker(mot, reel) }));
  return { resultats, stats };
}

/** Solutions : tout le tirage utilise, aucune lettre de reste. */
export function solutions(dict: Dict, tirage: string): ResultatRecherche {
  return motsFormables(dict, tirage, tirage.length);
}

// --- Extensions d'un mot : cas particuliers d'un squelette ---

/** Ajoute exactement trois lettres devant le mot tape. */
export function benjamins(dict: Dict, mot: string): ResultatRecherche {
  return trieParAjoutCroissant(squelette(dict, "..." + mot), mot.length);
}

/**
 * Tous les mots qui finissent par le mot tape, AU MOINS UNE LETTRE AJOUTEE --
 * le mot tape lui-meme ne compte pas comme sa propre rallonge (".*", pas "*" :
 * une lettre libre puis un tronçon quelconque, jamais rien du tout).
 */
export function rallongesAvant(dict: Dict, mot: string): ResultatRecherche {
  return trieParAjoutCroissant(squelette(dict, ".*" + mot), mot.length);
}

/** Tous les mots qui commencent par le mot tape, au moins une lettre ajoutee. */
export function rallongesArriere(dict: Dict, mot: string): ResultatRecherche {
  return trieParAjoutCroissant(squelette(dict, mot + ".*"), mot.length);
}

/** Le mot tape strictement CONTENU : au moins une lettre avant ET apres. */
export function superBenjamins(dict: Dict, mot: string): ResultatRecherche {
  return trieParAjoutCroissant(squelette(dict, ".*" + mot + ".*"), mot.length);
}

/**
 * Trie par ajout croissant, et NE COLORE RIEN : le squelette sous-jacent
 * marque comme joker la seule lettre libre qui commence le "*" (BenjaminS ->
 * SUPERchampion aurait son S d'une autre couleur mais pas le reste de SUPER),
 * ce qui ne veut rien dire ici -- il n'y a pas de joker, seulement des lettres
 * ajoutees. Deux issues se valaient (tout colorer, ou rien) ; rien est plus
 * simple et n'invente pas une convention de plus.
 */
function trieParAjoutCroissant(r: ResultatRecherche, longueurBase: number): ResultatRecherche {
  for (const c of r.resultats) c.jokers = [];
  r.resultats.sort((a, b) => (a.mot.length - longueurBase) - (b.mot.length - longueurBase)
    || a.mot.localeCompare(b.mot));
  return r;
}

// --- Ce qu'on tape ---

export type ModeSaisie = "vide" | "tirage" | "squelette" | "invalide";

const CARACTERES_VALIDES = /^[A-Z?*.]*$/;

/** L'ODS s'arrete a 15 lettres, la grille non -- mais la saisie, elle, oui. */
export const LONGUEUR_MAX_SAISIE = 15;

/**
 * Au-dela, motsFormables/solutions restent rapides (le calcul suit la taille
 * du dictionnaire, pas le nombre de jokers) mais la liste devient enorme --
 * voir [[solveur-de-recherche]]. Un plafond raisonnable evite d'afficher le
 * dictionnaire entier.
 */
export const JOKERS_MAX = 12;

/**
 * Un joker et un symbole de squelette ne se melangent jamais dans la meme
 * saisie : "?" veut dire "une lettre du tirage, laquelle on ne sait pas
 * encore", "." veut dire "une lettre du dictionnaire, n'importe laquelle" --
 * deux questions differentes, qui ne se repondent pas ensemble.
 */
export function analyserSaisie(saisie: string): ModeSaisie {
  if (saisie.length === 0) return "vide";
  if (saisie.length > LONGUEUR_MAX_SAISIE) return "invalide";
  if (!CARACTERES_VALIDES.test(saisie)) return "invalide";
  const aSquelette = saisie.includes("*") || saisie.includes(".");
  const aJoker = saisie.includes(BLANK);
  if (aSquelette && aJoker) return "invalide";
  if (aJoker && [...saisie].filter((c) => c === BLANK).length > JOKERS_MAX) return "invalide";
  return aSquelette ? "squelette" : "tirage";
}
