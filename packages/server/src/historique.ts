/**
 * L'historique des parties d'un joueur. Voir SPEC.md §30.
 *
 * CE QUI MANQUAIT. Le journal des records ne retient qu'une partie sur
 * plusieurs -- grille bornee, sac qui s'epuise, topping -- et n'y nomme que
 * ceux qui ont trouve au moins un top. Une grille sans fin, un duplicate, ou
 * une partie ou l'on n'a rien tope n'etaient rattaches a personne : la page
 * personnelle d'un joueur n'avait rien a lire.
 *
 * UNE LIGNE PAR PARTIE FINIE, avec ce que chacun y a fait. Les manches du
 * competitif ne passent pas par ici : elles ont deja leur journal (§29).
 *
 * TROIS GARDE-FOUS, pour qu'un historique ne se remplisse pas de parties que
 * personne n'a vraiment jouees :
 *
 * - **la partie est allee au bout.** Une partie arretee en cours de route ne
 *   s'ecrit nulle part -- abandonnee par l'hote, ou relancee avant sa fin, ce
 *   qui revient au meme. C'est deja la regle du tableau des records (§23).
 * - **la partie** n'entre que si quelqu'un a propose un mot sur au moins trois
 *   quarts de ses coups. Pris au hasard, un coup sur quatre au plus est reste
 *   sans personne : c'est ce qui distingue une partie jouee d'une grille qu'on
 *   a laissee s'ecouler.
 * - **un joueur** n'y entre que s'il a propose un mot sur au moins un coup.
 *   Etre assis dans le salon ne suffit pas.
 *
 * Le dernier est plus juste que « avoir trouve un top » : en topping a
 * plusieurs, un joueur peut jouer toute la partie sans jamais gagner un coup
 * contre plus rapide que lui, et cette partie est la sienne quand meme.
 *
 * AU DUPLICATE, ETRE PRESENT N'EST PAS AVOIR JOUE. Le coup y porte un score
 * pour chacun des presents au tirage, zero compris (§16) : c'est ce qui donne
 * son negatif a qui n'a rien trouve, et cela ne dit rien de ce qu'il a joue.
 * Seul `propositions` -- et le top trouve -- fait foi ici.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlayedMove, RaisonDeFin } from "./game.ts";
import type { ConfigPartie } from "../../engine/src/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
let DATA_DIR = join(here, "..", "data");
const journal = (): string => join(DATA_DIR, "historique.journal.jsonl");

/** POUR LES TESTS SEULEMENT : un dossier isole, jamais `packages/server/data`. */
export function definirDossierDeLHistorique(dir: string): void {
  DATA_DIR = dir;
  parties.length = 0;
  parNom.clear();
  ecrites.clear();
}

/** Ce qu'il faut d'une configuration pour nommer une partie sans la rouvrir. */
export interface ResumeDePartie {
  tirage: number;
  jouables: number;
  joker: boolean;
  jokersParCoup?: number;
  bornes: number | null;
  chrono: number | null;
  primes?: Record<number, number>;
  dictionnaire: string;
  mode: string;
  pavage: string;
}

/** Ce qu'un joueur a fait dans une partie. */
export interface LigneDeJoueur {
  nom: string;
  /** Ce nom n'est adosse a aucun compte : il est reprenable par n'importe qui. */
  invite: boolean;
  /** Sur combien de coups il a propose un mot. */
  proposes: number;
  tops: number;
  score: number;
  negatif: number;
}

export interface PartieDHistorique {
  /** Le salon ou elle s'est jouee : c'est aussi le nom de son journal. */
  salon: string;
  /** La graine, qui reconnait le bon fichier parmi les archives d'un salon. */
  graine: string;
  /** Le nom du salon, tel qu'il s'affichait. */
  nomSalon: string;
  at: number;
  coups: number;
  /** Pourquoi elle s'est arretee : `sac`, `injouable`, `abandon`... */
  fin: string;
  resume: ResumeDePartie;
  joueurs: LigneDeJoueur[];
}

const parties: PartieDHistorique[] = [];
/** Les parties d'un nom, de la plus recente a la plus ancienne. */
const parNom = new Map<string, PartieDHistorique[]>();
/** Les parties deja ecrites : `salon|graine`. Une partie ne s'ecrit qu'une fois. */
const ecrites = new Set<string>();

/** La part des coups qui doivent avoir recu une proposition de quelqu'un. */
export const PART_JOUEE = 0.75;

/**
 * LES FINS QUI FONT UNE PARTIE ALLEE AU BOUT.
 *
 * `abandon` n'y est pas, et la relance non plus : relancer par-dessus une
 * partie qui n'a pas fini, c'est l'abandonner. Voir SPEC.md §30.
 */
const FINS_COMPLETES: ReadonlySet<string> = new Set(["sac", "injouable", "coups", "duree"]);

const cle = (salon: string, graine: string): string => `${salon}|${graine}`;

export function resumeDeLaConfig(cfg: ConfigPartie): ResumeDePartie {
  return {
    tirage: cfg.tirage, jouables: cfg.jouables, joker: cfg.joker,
    ...(cfg.joker && cfg.jokersParCoup === 2 ? { jokersParCoup: 2 } : {}),
    bornes: cfg.bornes, chrono: cfg.chrono,
    primes: { ...cfg.primes },
    dictionnaire: cfg.dictionnaire, mode: cfg.mode, pavage: cfg.pavageNom,
  };
}

function inscrire(ev: Record<string, unknown>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const fd = openSync(journal(), "a");
  try {
    writeSync(fd, JSON.stringify(ev) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appliquer(e: Record<string, any>): void {
  if (e["t"] !== "partie") return;
  const p: PartieDHistorique = {
    salon: e["salon"], graine: e["graine"], nomSalon: e["nomSalon"] ?? e["salon"],
    at: e["at"], coups: e["coups"], fin: e["fin"] ?? "", resume: e["resume"],
    joueurs: e["joueurs"] ?? [],
  };
  if (ecrites.has(cle(p.salon, p.graine))) return;
  ecrites.add(cle(p.salon, p.graine));
  parties.push(p);
  for (const j of p.joueurs) {
    const sienne = parNom.get(j.nom) ?? [];
    sienne.unshift(p);
    parNom.set(j.nom, sienne);
  }
}

/** Relit le journal. Une ligne tronquee par une coupure est ignoree. */
export function ouvrirLHistorique(): void {
  parties.length = 0;
  parNom.clear();
  ecrites.clear();
  if (!existsSync(journal())) return;
  let casses = 0;
  for (const ligne of readFileSync(journal(), "utf8").split("\n")) {
    if (ligne.trim() === "") continue;
    try { appliquer(JSON.parse(ligne)); } catch { casses++; }
  }
  if (casses > 0) console.warn(`[historique] ${casses} ligne(s) illisible(s) dans le journal`);
  console.log(`[historique] ${parties.length} partie(s), ${parNom.size} joueur(s)`);
}

/**
 * QUI A VRAIMENT JOUE CE COUP : un mot propose, ou le top trouve.
 *
 * `scores` n'y figure pas, et c'est tout l'objet de cette fonction : au
 * duplicate il porte un zero pour chaque present au tirage, et le lire comme
 * une proposition faisait entrer a l'historique des parties que personne
 * n'avait touchees.
 *
 * `player` est le vainqueur du coup en topping ; au duplicate il est nul et
 * c'est `trouveurs` qui nomme ceux qui ont trouve le top.
 */
function joueursDuCoup(c: PlayedMove): Set<string> {
  const qui = new Set<string>(Object.keys(c.propositions ?? {}));
  for (const nom of c.trouveurs ?? []) qui.add(nom);
  if (c.player !== null) qui.add(c.player);
  if (c.demiPoint !== undefined) qui.add(c.demiPoint.joueur);
  return qui;
}

/**
 * CE QUE CHAQUE JOUEUR A FAIT DANS CETTE PARTIE.
 *
 * En duplicate, chacun a son score au coup et il se lit tel quel ; en topping,
 * il se deduit de ce que chacun a propose. Le negatif est l'ecart au top,
 * compte sur tous les coups -- un coup ou l'on n'a rien propose coute son top
 * entier, comme partout ailleurs (§29).
 */
export function lignesDesJoueurs(
  coups: PlayedMove[], estCompte: (nom: string) => boolean,
): LigneDeJoueur[] {
  const par = new Map<string, LigneDeJoueur>();
  const trouver = (nom: string): LigneDeJoueur => {
    const deja = par.get(nom);
    if (deja !== undefined) return deja;
    const neuf: LigneDeJoueur = {
      nom, invite: !estCompte(nom), proposes: 0, tops: 0, score: 0, negatif: 0,
    };
    par.set(nom, neuf);
    return neuf;
  };
  for (const c of coups) {
    const scores: Record<string, number> = {};
    for (const [nom, p] of Object.entries(c.propositions ?? {})) scores[nom] = p.score;
    for (const [nom, s] of Object.entries(c.scores ?? {})) scores[nom] = Math.max(scores[nom] ?? 0, s);
    // LE SCORE SE PREND PARTOUT, LE COUP JOUE NE SE COMPTE QUE POUR CEUX QUI
    // ONT JOUE : au duplicate, `scores` nomme aussi les presents restes muets.
    for (const [nom, s] of Object.entries(scores)) trouver(nom).score += s;
    for (const nom of joueursDuCoup(c)) trouver(nom).proposes++;
    if (c.player !== null) trouver(c.player).tops++;
    else for (const nom of c.trouveurs ?? []) trouver(nom).tops++;
  }
  // Le negatif se compte une fois tous les joueurs connus : un coup sans
  // proposition coute son top a qui a joue la partie.
  for (const l of par.values()) {
    l.negatif = coups.reduce((a, c) => {
      const p = c.propositions?.[l.nom]?.score ?? c.scores?.[l.nom] ?? 0;
      return a + Math.max(0, c.score - p);
    }, 0);
  }
  return [...par.values()].filter((l) => l.proposes > 0).sort((a, b) => b.score - a.score);
}

/**
 * ECRIT UNE PARTIE FINIE, si elle a vraiment ete jouee. Rend vrai si la ligne
 * est partie. Une partie deja ecrite ne s'ecrit pas deux fois.
 */
export function ecrireUnePartie(o: {
  salon: string; graine: string; nomSalon: string; fin: RaisonDeFin;
  cfg: ConfigPartie; coups: PlayedMove[]; estCompte: (nom: string) => boolean;
}): boolean {
  if (ecrites.has(cle(o.salon, o.graine))) return false;
  // LA PARTIE EST ALLEE AU BOUT. Une partie abandonnee, ou relancee avant sa
  // fin, ne s'ecrit nulle part : elle n'a pas de resultat a montrer.
  if (!FINS_COMPLETES.has(o.fin)) return false;
  if (o.coups.length === 0) return false;
  // TROIS QUARTS DES COUPS AU MOINS ONT RECU UN MOT DE QUELQU'UN : une grille
  // laissee a elle-meme, ou revelee coup par coup, n'est pas une partie jouee.
  const joues = o.coups.filter((c) => joueursDuCoup(c).size > 0).length;
  if (joues / o.coups.length < PART_JOUEE) return false;
  const joueurs = lignesDesJoueurs(o.coups, o.estCompte);
  if (joueurs.length === 0) return false;
  const ev = {
    t: "partie", salon: o.salon, graine: o.graine, nomSalon: o.nomSalon,
    at: Date.now(), coups: o.coups.length, fin: o.fin,
    resume: resumeDeLaConfig(o.cfg), joueurs,
  };
  inscrire(ev);
  appliquer(ev);
  return true;
}

/** Les parties de ce joueur, de la plus recente a la plus ancienne. */
export function partiesDe(nom: string, plafond = 200): PartieDHistorique[] {
  return (parNom.get(nom) ?? []).slice(0, plafond);
}

/** Une partie de l'historique, par son salon et sa graine. */
export function partieDeLHistorique(salon: string, graine: string): PartieDHistorique | undefined {
  return parties.find((p) => p.salon === salon && p.graine === graine);
}

/** Combien de parties ce joueur a jouees en salon. */
export function combienDeParties(nom: string): number {
  return (parNom.get(nom) ?? []).length;
}
