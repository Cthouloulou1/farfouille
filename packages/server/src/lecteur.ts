/**
 * Le lecteur d'une partie archivee. Voir SPEC.md §23.
 *
 * LE REJEU NE FONCTIONNAIT QUE DANS UN SALON OUVERT. Il lui fallait un `Game`,
 * un fil de calcul et un verrou -- or une partie citee par un record est un
 * fichier inerte, que plus aucun salon ne tient. Les boutons « FdR » et
 * « Revoir » n'avaient donc rien a ouvrir.
 *
 * LE JOURNAL SUFFIT. Il porte la graine, la configuration, et pour chaque coup
 * le tirage, le mot, sa direction, sa case, son score, qui l'a trouve, en
 * combien de temps et quels caramels etaient des jokers. Rejouer les
 * placements dans l'ordre reconstruit la grille exacte (SPEC.md §11) : ni sac,
 * ni solveur, ni verrou, ni fil.
 *
 * CE QU'IL NE FAIT PAS, et c'est voulu : les PALIERS. Une partie bornee ne les
 * garde pas, et les refaire demanderait le solveur. Le rejeu d'une partie
 * archivee montre donc la grille, les tirages, les mots et leurs trouveurs --
 * ce qu'on vient y chercher -- et non la liste des solutions de chaque coup.
 *
 * IL NE SERT QUE DES PARTIES CITEES AU JOURNAL DES RECORDS. C'est la regle de
 * surete de ce fichier : servir un journal quelconque par son nom donnerait le
 * moyen de lire une partie EN COURS, donc le top que tout le monde cherche.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Dict } from "../../engine/src/dictionary.ts";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { Board, type Placement } from "../../engine/src/board.ts";
import { deserialiser, type ConfigSerialisee } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS, type LayoutName } from "../../engine/src/bonus.ts";
import { dawgPath } from "../../engine/src/paths.ts";
import type { Dir } from "../../engine/src/coords.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

/**
 * LES LEXIQUES CHARGES SONT GARDES.
 *
 * `loadDict` relit le fichier a chaque appel : 0,45 Mo pour le DAWG francais.
 * Une page de records qui ouvre trois parties de suite le relisait trois fois,
 * et chaque relance de partie le paie deja (SPEC.md §23). Ils ne changent
 * jamais en cours d'execution : un cache par fichier suffit.
 */
const lexiques = new Map<string, Dict>();

export function lexique(id: string): Dict {
  const chemin = dawgPath(id);
  let d = lexiques.get(chemin);
  if (d === undefined) { d = loadDict(chemin); lexiques.set(chemin, d); }
  return d;
}

/** Un coup, tel que le lecteur le rend. */
export interface CoupRelu {
  n: number;
  /** Le tirage tel qu'il s'affichait, jokers compris. */
  rack: string;
  notation: string;
  word: string;
  dir: Dir;
  x: number;
  y: number;
  score: number;
  /** Qui a trouve le top, ou `null` si personne. */
  player: string | null;
  /** Millisecondes de recherche. */
  ms: number;
  /** Les cases que ce coup a posees, refaites depuis la grille d'avant. */
  placements: Placement[];
  /** Le mot que le joueur a reellement tape, quand il differe du mot retenu. */
  playerWord?: string;
  /** DUPLICATE : ceux qui ont trouve le top. */
  trouveurs?: string[];
}

/** Une partie archivee, entiere. */
export interface PartieRelue {
  partie: string;
  layout: LayoutName;
  createdAt: number;
  config: ConfigSerialisee;
  /** Pourquoi elle s'est arretee, si le journal le dit. */
  fin: string | null;
  coups: CoupRelu[];
}

/**
 * Le fichier de journal d'une partie, retrouve par son nom ET sa graine.
 *
 * UNE RELANCE ARCHIVE LA PARTIE SOUS UN NOM HORODATE -- `salon.1788…` -- et le
 * nom seul ne suffit donc plus a la designer. La graine, elle, ne change pas :
 * on l'ecrit dans la manche a l'enregistrement, et on s'en sert ici pour
 * reconnaitre le bon fichier parmi les archives d'un meme salon.
 */
export function journalDeLaPartie(partie: string, graine: string): string | null {
  const direct = join(DATA_DIR, `${partie}.journal.jsonl`);
  if (existsSync(direct) && graineDuJournal(direct) === graine) return direct;
  let noms: string[];
  try { noms = readdirSync(DATA_DIR); } catch { return null; }
  for (const nom of noms) {
    if (!nom.startsWith(`${partie}.`) || !nom.endsWith(".journal.jsonl")) continue;
    const f = join(DATA_DIR, nom);
    if (graineDuJournal(f) === graine) return f;
  }
  return null;
}

/** La graine ecrite dans l'entete d'un journal, sans lire tout le fichier. */
function graineDuJournal(fichier: string): string | null {
  try {
    // L'entete est la premiere ligne : on ne lit que ce qu'il faut pour elle.
    const debut = readFileSync(fichier, "utf8");
    const premiere = debut.slice(0, debut.indexOf("\n"));
    const e = JSON.parse(premiere) as Record<string, unknown>;
    return e["t"] === "grille" ? (e["seed"] as string) ?? null : null;
  } catch { return null; }
}

/**
 * Relit une partie archivee et rend tout ce qu'il faut pour l'afficher.
 *
 * LA GRILLE SE REFAIT COUP PAR COUP, dans l'ordre : c'est elle qui dit quelles
 * cases du mot etaient libres, donc lesquelles le coup a posees. Un journal
 * d'avant ce changement porte encore ses placements, et on les prend tels
 * quels (SPEC.md §11).
 */
export function relire(fichier: string): PartieRelue | null {
  let brut: string;
  try { brut = readFileSync(fichier, "utf8"); } catch { return null; }

  let entete: Record<string, any> | null = null;
  const bruts: Record<string, any>[] = [];
  let fin: string | null = null;
  for (const ligne of brut.split("\n")) {
    if (ligne.trim() === "") continue;
    let e: Record<string, any>;
    try { e = JSON.parse(ligne); } catch { continue; }
    if (e["t"] === "grille") entete = e;
    else if (e["t"] === "coup") bruts.push(e["move"]);
    else if (e["t"] === "fin") fin = (e["raison"] as string) ?? "sac";
  }
  if (entete === null) return null;

  const config = entete["config"] as ConfigSerialisee | undefined;
  if (config === undefined) return null;
  const layout = (entete["layout"] as LayoutName) ?? "classique15";
  // Le pavage est un reglage de module : on le pose avant de batir la grille,
  // comme le fait l'ouverture d'une partie.
  setLayout(layout in LAYOUTS ? layout : "classique15");
  const cfg = deserialiser(config);
  const board = new Board(lexique(cfg.dictionnaire), cfg);

  const coups: CoupRelu[] = [];
  for (const m of bruts) {
    const placements: Placement[] = Array.isArray(m["placements"])
      ? m["placements"] as Placement[]
      : refairePlacements(board, m);
    board.place(placements);
    coups.push({
      n: m["n"] as number,
      rack: (m["rack"] as string) ?? "",
      notation: (m["notation"] as string) ?? "",
      word: (m["word"] as string) ?? "",
      dir: (m["dir"] as Dir) ?? "H",
      x: (m["x"] as number) ?? 0,
      y: (m["y"] as number) ?? 0,
      score: (m["score"] as number) ?? 0,
      player: (m["player"] as string | null) ?? null,
      ms: Math.max(0, (m["ms"] as number) ?? 0),
      placements,
      ...(typeof m["playerWord"] === "string" ? { playerWord: m["playerWord"] } : {}),
      ...(Array.isArray(m["trouveurs"]) ? { trouveurs: m["trouveurs"] as string[] } : {}),
    });
  }

  return {
    partie: (entete["gameId"] as string) ?? "",
    layout,
    createdAt: (entete["createdAt"] as number) ?? 0,
    config,
    fin,
    coups,
  };
}

/**
 * Les cases qu'un coup a posees, refaites a partir du mot et de la grille.
 *
 * LA GRILLE DOIT ETRE DANS L'ETAT D'AVANT CE COUP. C'est la meme regle que
 * dans `Game`, et la meme raison : c'est elle qui dit quelles cases du mot
 * etaient vides.
 */
function refairePlacements(board: Board, m: Record<string, any>): Placement[] {
  const dir = (m["dir"] as Dir) ?? "H";
  const dx = dir === "H" ? 1 : 0;
  const dy = dir === "H" ? 0 : 1;
  const blancs = (m["blancs"] as number[] | undefined) ?? [];
  const mot = (m["word"] as string) ?? "";
  const out: Placement[] = [];
  for (let k = 0; k < mot.length; k++) {
    const x = (m["x"] as number) + dx * k;
    const y = (m["y"] as number) + dy * k;
    if (board.occupied(x, y)) continue;
    out.push({ x, y, letter: mot[k]!, blank: blancs.includes(out.length) });
  }
  return out;
}
