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
 * LES PALIERS SE REFONT ICI AUSSI. Une partie bornee ne les garde pas -- et ce
 * n'est PAS le navigateur qui les calcule, contrairement a ce qu'on pourrait
 * croire : le client les demande au serveur, qui les cherche dans le fil du
 * salon. Un salon ferme, plus de fil, plus de paliers.
 *
 * Or la demande de paliers du fil est SANS ETAT : elle recoit les caramels
 * poses avant le coup et le tirage, et se batit une grille neuve. Il suffit
 * donc d'un fil a part, partage par toutes les parties archivees de meme
 * configuration, cree a la demande et rendu quand plus personne ne lit.
 *
 * IL NE SERT QUE DES PARTIES CITEES AU JOURNAL DES RECORDS. C'est la regle de
 * surete de ce fichier : servir un journal quelconque par son nom donnerait le
 * moyen de lire une partie EN COURS, donc le top que tout le monde cherche.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { Dict } from "../../engine/src/dictionary.ts";
import { lexiqueGarde } from "../../engine/src/dictionary_node.ts";
import { Board, type Placement } from "../../engine/src/board.ts";
import { deserialiser, type ConfigSerialisee } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS, type LayoutName } from "../../engine/src/bonus.ts";
import { dawgPath } from "../../engine/src/paths.ts";
import type { Dir } from "../../engine/src/coords.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

/**
 * LES LEXIQUES CHARGES SONT GARDES, et le cache vit maintenant dans le moteur
 * (`dictionary_node.ts`) : les parties du serveur s'en servent aussi.
 *
 * `loadDict` relit le fichier a chaque appel : 0,45 Mo pour le DAWG francais.
 * Une page de records qui ouvre trois parties de suite le relisait trois fois.
 * Ils ne changent jamais en cours d'execution : un cache par fichier suffit.
 */
export function lexique(id: string): Dict {
  return lexiqueGarde(dawgPath(id));
}

/**
 * LES FILS DE SOLVEUR DES PARTIES ARCHIVEES.
 *
 * Un par configuration -- lexique, pavage, format, primes -- et pas un par
 * partie : deux parties normales du meme lexique posent exactement la meme
 * question au solveur. Chacun coute les 4 Mo du GADDAG, d'ou le plafond et le
 * renvoi apres un quart d'heure sans lecture.
 */
const FILS_MAX = 3;
const FIL_INACTIF_MS = 15 * 60_000;

interface FilDeLecture {
  w: Worker;
  attente: Map<number, (r: any) => void>;
  minuteur: NodeJS.Timeout | null;
  vuA: number;
}

const fils = new Map<string, FilDeLecture>();
let prochaineDemande = 1;

function signature(layout: LayoutName, config: ConfigSerialisee): string {
  return `${layout}|` + createHash("sha256")
    .update(JSON.stringify(config)).digest("hex").slice(0, 12);
}

function rendreLeFil(cle: string): void {
  const f = fils.get(cle);
  if (f === undefined) return;
  fils.delete(cle);
  if (f.minuteur !== null) clearTimeout(f.minuteur);
  for (const [, done] of f.attente) done({ tiers: [] });
  void f.w.terminate();
  console.log(`[lecteur] fil de solveur rendu (${cle})`);
}

function filDeLecture(layout: LayoutName, config: ConfigSerialisee): FilDeLecture {
  const cle = signature(layout, config);
  let f = fils.get(cle);
  if (f === undefined) {
    // Le plus anciennement lu s'en va : trois fils suffisent, et chacun pese
    // le prix d'un GADDAG.
    while (fils.size >= FILS_MAX) {
      const vieux = [...fils].sort((a, b) => a[1].vuA - b[1].vuA)[0];
      if (vieux === undefined) break;
      rendreLeFil(vieux[0]);
    }
    const w = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { layout, seed: "lecture", config, rngAlgo: "mulberry32" },
    });
    const cree: FilDeLecture = { w, attente: new Map(), minuteur: null, vuA: Date.now() };
    w.on("message", (m: any) => {
      if (m?.t !== "paliers") return;
      const done = cree.attente.get(m.id);
      cree.attente.delete(m.id);
      done?.(m);
    });
    w.on("error", (e) => console.error("[lecteur]", e));
    fils.set(cle, cree);
    f = cree;
    console.log(`[lecteur] fil de solveur ouvert (${cle})`);
  }
  f.vuA = Date.now();
  if (f.minuteur !== null) clearTimeout(f.minuteur);
  f.minuteur = setTimeout(() => rendreLeFil(cle), FIL_INACTIF_MS);
  f.minuteur.unref?.();
  return f;
}

/**
 * COMBIEN DE SOLUTIONS UN COUP ARCHIVE EN REND.
 *
 * La demande de paliers du fil n'en avait AUCUN plafond : elle appelle le
 * generateur avec `prune: false`, qui rend alors tout -- une position ouverte a
 * deux jokers en compte 18 655 (SPEC.md §10). C'est ce que le rejeu d'un salon
 * demande, et il le peut : il est virtualise, et la memoire du serveur y est
 * bornee a 60 000 solutions.
 *
 * Ici, on relit une partie finie : cent lignes suffisent a comprendre le coup,
 * et le reste ne serait ni lu ni utile. Le generateur tronque TOUJOURS a une
 * frontiere de palier et ne sacrifie jamais le palier du top, meme s'il depasse
 * a lui seul.
 */
const SOLUTIONS_MAX = 100;

/** Un palier : un score, et tous les coups qui l'atteignent. */
export interface PalierRelu {
  score: number;
  moves: [string, string, number, number][];
}

/**
 * Les paliers d'un coup d'une partie archivee : le top, ses isotops, puis les
 * sous-tops. Toutes les solutions, sur un plateau borne.
 *
 * LA POSITION EST CELLE D'AVANT LE COUP. On lui donne les caramels poses par
 * les coups precedents, et le tirage de celui-la : le fil se batit une grille
 * neuve et cherche tout.
 */
export function paliersDuCoup(
  partie: PartieRelue, n: number,
): Promise<PalierRelu[]> {
  const coup = partie.coups.find((c) => c.n === n);
  if (coup === undefined) return Promise.resolve([]);
  const avant: Placement[] = [];
  for (const c of partie.coups) {
    if (c.n >= n) break;
    avant.push(...c.placements);
  }
  const f = filDeLecture(partie.layout, partie.config);
  const id = prochaineDemande++;
  return new Promise((resolve) => {
    f.attente.set(id, (r) => resolve((r.tiers ?? []) as PalierRelu[]));
    f.w.postMessage({ t: "paliers", id, rack: coup.rack, avant, maxMoves: SOLUTIONS_MAX });
  });
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
  /**
   * CE QUE LE JOUEUR A REELLEMENT POSE, quand le logiciel a retenu un autre
   * isotop (SPEC.md §5). Absent des parties d'avant son enregistrement, et des
   * coups ou le mot retenu est celui qui a ete tape.
   *
   * La feuille de route les montre entre parenthèses : « WU (WUS) » a la
   * reference « A1 (12H) ». Sans eux, un joueur qui a isotope lit un mot et une
   * case qu'il n'a jamais joues.
   */
  playerWord?: string;
  playerDir?: Dir;
  playerX?: number;
  playerY?: number;
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
 * LES PARTIES RELUES SONT GARDEES, quelques-unes.
 *
 * Le rejeu navigue -- coup 7, coup 8, retour au 7 -- et chaque demande de
 * paliers a besoin de la partie entiere pour savoir ce qui etait pose avant.
 * La relire a chaque fois, c'est refaire vingt fois la meme grille.
 */
const RELUES_GARDEES = 4;
const relues = new Map<string, PartieRelue>();

export function relireEtGarder(fichier: string): PartieRelue | null {
  const deja = relues.get(fichier);
  if (deja !== undefined) return deja;
  const p = relire(fichier);
  if (p === null) return null;
  relues.set(fichier, p);
  while (relues.size > RELUES_GARDEES) {
    const premier = relues.keys().next().value as string;
    relues.delete(premier);
  }
  return p;
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
      ...(typeof m["playerDir"] === "string" ? { playerDir: m["playerDir"] as Dir } : {}),
      ...(typeof m["playerX"] === "number" ? { playerX: m["playerX"] } : {}),
      ...(typeof m["playerY"] === "number" ? { playerY: m["playerY"] } : {}),
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
