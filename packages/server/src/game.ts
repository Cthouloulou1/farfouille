/**
 * La partie, cote serveur. Fait autorite sur tout.
 *
 * PERSISTANCE -- deux fichiers, et c'est voulu.
 *
 *   <partie>.journal.jsonl   ajout seul, une ligne par evenement, jamais
 *                            reecrit, force sur le disque a chaque ligne.
 *                            C'EST LUI QUI FAIT FOI.
 *   <partie>.json            instantane complet, reecrit a chaque coup.
 *                            Commodite de lecture pour les outils.
 *
 * Une partie qui dure des mois ne doit pas tenir a un fichier qu'on reecrit
 * sans cesse : il suffit d'une coupure au mauvais moment, d'un disque qui
 * tousse ou d'une fausse manoeuvre pour tout perdre. Le journal ne se reecrit
 * jamais ; on peut effacer l'instantane sans rien perdre, il se reconstruit.
 *
 * La partie etant deterministe (SPEC.md §5), rejouer les placements au
 * demarrage suffit a retrouver la grille exacte, et refaire les pioches dans
 * l'ordre rend au sac son etat de compensation.
 */
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync,
  openSync, writeSync, readSync, fsyncSync, closeSync, unlinkSync, statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Dict } from "../../engine/src/dictionary.ts";
import { loadDict } from "../../engine/src/dictionary_node.ts";
import { Board, type Placement } from "../../engine/src/board.ts";
import { Bag, type BagConfig } from "../../engine/src/bag.ts";
import { BLANK, rangerLeTirage } from "../../engine/src/alphabet.ts";
import { SacFini, type Pioche } from "../../engine/src/sac.ts";
import { dictionnaire } from "../../engine/src/dictionnaires.ts";
import {
  configParDefaut, serialiser, deserialiser,
  type ConfigPartie, type ConfigSerialisee,
} from "../../engine/src/config.ts";
import { setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { mulberry32, moveSeed } from "../../engine/src/rng.ts";
import { resolveTypedWord, PLAY_MESSAGE, type PlayError } from "../../engine/src/play.ts";
import { noteCoup, type Dir } from "../../engine/src/coords.ts";
import { dawgPath } from "../../engine/src/paths.ts";
import type { Move } from "../../engine/src/score.ts";

/** Ce que chacun a marque, rate, et trouve. Voir `bilanDesJoueurs`. */
export interface Bilan {
  points: Record<string, number>;
  negatif: Record<string, number>;
  tops: Record<string, number>;
}

/** Un palier de score : un score, et TOUS les coups qui l'atteignent. */
export interface Tier {
  score: number;
  moves: [string, string, number, number][];
}

export interface PlayedMove {
  n: number;
  rack: string;
  notation: string;
  /** Le mot RETENU par le logiciel, celui qui est pose. */
  word: string;
  dir: Dir;
  x: number;
  y: number;
  score: number;
  /**
   * Les cases posees par ce coup, dans l'ordre du mot.
   *
   * EN MEMOIRE SEULEMENT. Le journal ne les porte plus : elles se refont a
   * partir du mot, de sa case et de la grille telle qu'elle etait avant le
   * coup. Un journal d'avant ce changement les porte encore, et on les prend
   * telles quelles.
   */
  placements: Placement[];
  /**
   * AU JOURNAL SEULEMENT : le rang des caramels poses qui sont des jokers.
   *
   * C'est la seule chose que le mot ne dit pas. Rien dans « SIZE » n'indique
   * que le S vaut zero, et rien ne permet de le deviner : il faut l'ecrire.
   * Trois octets la ou les placements en prenaient deux cent trente.
   *
   * Le rang est celui du caramel POSE, pas de la lettre dans le mot -- un mot
   * qui s'appuie sur des lettres deja la n'en pose que quelques-unes.
   *
   * Un joker qui a joue une vraie lettre n'y figure pas : ce n'est plus un
   * joker, c'est un R, et `jokers.sortis` en garde la trace.
   */
  blancs?: number[];
  /** Qui a trouve le top. null = revele sans joueur. */
  player: string | null;
  /**
   * Le mot que le joueur a REELLEMENT tape, qui peut differer du mot retenu
   * quand le logiciel a choisi un autre isotop. Absent des parties d'avant son
   * enregistrement : il n'a jamais ete ecrit et ne peut pas etre reconstitue.
   */
  playerWord?: string;
  playerDir?: Dir;
  playerX?: number;
  playerY?: number;
  /** Millisecondes ecoulees depuis la diffusion du tirage. */
  ms: number;
  isotops: number;
  /**
   * Paliers de score du coup. Gardes EN RESERVE pour l'analyse d'apres-partie :
   * ils ne sont jamais diffuses aux joueurs (SPEC.md §5).
   */
  tiers?: Tier[];
  /** Qui a aime ce coup. Un nom au plus une fois. */
  likes?: string[];
  /**
   * DUPLICATE seulement : le score de chaque joueur sur ce coup, et ceux qui
   * ont trouve le top. Chacun marque sa meilleure solution ; l'ecart au top est
   * son negatif (SPEC.md §16).
   */
  scores?: Record<string, number>;
  trouveurs?: string[];
  /**
   * Ce que CHAQUE joueur a reellement propose sur ce coup : son meilleur mot,
   * ou il l'a pose et ce qu'il valait.
   *
   * C'est ce qui permet, apres la partie, de montrer le coup de chacun plutot
   * que le top -- et de retrouver un mot qui ne figure dans aucun palier.
   */
  propositions?: Record<string, { word: string; dir: Dir; x: number; y: number; score: number }>;
  /**
   * TOPPING chronometre : personne n'a trouve le top a l'echeance. Un demi-point
   * va au joueur qui avait propose la solution la plus rentable, le plus vite.
   */
  demiPoint?: { joueur: string; word: string; score: number };
  /**
   * PARTIE JOKER : ce que les jokers de ce coup sont devenus (SPEC.md §16).
   *
   * `sortis` liste les lettres qui ont quitte le sac -- un joker qui joue un R
   * fait sortir un vrai R, et ce R vaudra ses points pour toujours. `restes`
   * compte les jokers qui n'ont pas trouve leur lettre et sont restes jokers.
   *
   * SANS CETTE TRACE, UNE PARTIE JOKER NE SE RELIT PAS. Ce qui est ecrit dans
   * `placements` est le resultat de la substitution : un R ordinaire, dont rien
   * ne dit plus qu'un joker l'a joue. A la reprise, le reliquat se recalculait
   * alors en cherchant un R dans un tirage qui n'avait qu'un joker -- et la
   * partie refusait de s'ouvrir. Le sac, lui, ne perdait pas les lettres
   * sorties, et sa composition derivait.
   */
  jokers?: { sortis: string[]; restes: number };
}

export interface ChatMessage {
  at: number;
  who: string;
  text: string;
  /** Case partagee, cliquable dans le chat. */
  cell?: { x: number; y: number };
}

export interface TryResult {
  ok: boolean;
  message: string;
  word?: string;
  score?: number;
  /** Vrai si ce coup atteint le score du top : le coup est remporte. */
  top?: boolean;
  /** DUPLICATE : la meilleure solution retenue pour ce joueur sur ce coup. */
  retenu?: number;
}

interface Saved {
  gameId: string;
  layout: LayoutName;
  /**
   * Graine de la partie, tiree au hasard a la creation.
   *
   * Elle ne derive PAS du nom de la grille : deux grilles nommees pareil
   * rejoueraient sinon exactement la meme partie, tirages compris. Une fois
   * ecrite, elle ne bouge plus -- c'est elle qui rend l'historique rejouable.
   */
  seed: string;
  /** La variante jouee. Absente des parties d'avant les parties parametrables. */
  config?: ConfigSerialisee;
  /** Instant de creation de la grille, pour l'age de la partie. */
  createdAt: number;
  moves: PlayedMove[];
  players: Record<string, number>;
  chat: ChatMessage[];
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

/**
 * Ce qu'on garde de paliers refaits, compte en SOLUTIONS et non en coups.
 *
 * Un coup ordinaire en a quelques centaines ; un coup a deux jokers sur une
 * position ouverte en a compte 18 655. Compter les coups laisserait donc la
 * memoire varier d'un facteur cent selon la partie -- alors qu'ici on cherche
 * a la borner. Soixante mille solutions tiennent dans quelques megaoctets, et
 * couvrent une partie 15x15 entiere dans presque tous les cas.
 */
const PALIERS_EN_MEMOIRE = 60_000;

/**
 * Ce qu'une partie d'AVANT le reglage enregistrait : quarante paliers.
 *
 * Une partie qui existait deja garde le comportement avec lequel elle est nee.
 * Son entete ne porte pas le champ, et c'est ce qui la designe.
 */
const PALIERS_D_AVANT = 40;

/**
 * Tous les combien l'instantane est reecrit.
 *
 * Il l'etait a CHAQUE coup, en entier, sur le fil principal : neuf cent
 * vingt-huit millisecondes de gel par coup sur une grande partie, et cent
 * cinquante-cinq gigaoctets ecrits au fil d'une partie qui n'en conserve
 * quatre-vingts. C'est une vue derivee : le journal fait foi, et une partie
 * reprise se relit toujours depuis lui. Le retard de l'instantane ne coute
 * donc rien -- il est de toute facon reecrit a l'arret.
 */
const INSTANTANE_TOUS_LES = 20;

/**
 * AU-DELA DE QUOI UNE PARTIE NE GARDE PLUS SES SOUS-TOPS.
 *
 * « Bornee » ne veut pas dire « courte ». Mille coups font une annexe de 2,6 Mo,
 * ce qui est le prix d'une analyse d'apres-partie ; cinq mille minutes en chrono
 * d'une seconde en feraient sept cent soixante-treize, pour une partie que
 * personne ne relira coup par coup.
 *
 * Les deux bornes valent pour le REGLAGE de la partie. Le plafond en coups vaut
 * en plus a l'ecriture : une partie bornee en temps peut jouer bien plus de
 * coups que prevu si le chrono est court, et l'annexe s'arrete alors d'elle-meme.
 */
const PALIERS_JUSQU_A_COUPS = 1000;
const PALIERS_JUSQU_A_DUREE = 5000 * 60;

/**
 * Combien de paliers de sous-tops une partie neuve garde.
 *
 * Le palier du top -- le top et ses isotops -- est toujours ecrit au journal
 * sur une grille infinie : il pese soixante et un octets, et le refaire demande
 * dix-sept secondes au vingt-sept-millieme coup, en supposant que le lexique
 * n'ait pas bouge depuis.
 *
 * Les sous-tops, eux, ne sont gardes que si quelqu'un va les regarder :
 *
 *   plateau borne      rien. Le rejeu les refait en dix-neuf millisecondes.
 *   grille sans fin    rien. Elle ne se termine jamais, donc rien ne s'analyse
 *                      a la fin ; et les montrer en cours de partie apprend au
 *                      joueur des mots et des points d'appui qu'il n'a pas
 *                      trouves -- la grille, elle, est toujours la.
 *   grille limitee     tout, dans l'annexe : une partie en soixante minutes ou
 *                      en mille coups a une fin, donc une analyse d'apres-coup.
 */
function paliersParDefaut(cfg: ConfigPartie): number {
  if (cfg.bornes !== null) return 0;
  const assezCourte =
    (cfg.coupsMax !== null && cfg.coupsMax <= PALIERS_JUSQU_A_COUPS)
    || (cfg.dureeMax !== null && cfg.dureeMax <= PALIERS_JUSQU_A_DUREE);
  return assezCourte ? PALIERS_D_AVANT : 0;
}

/** Duree du decompte d'avant-partie : 3, 2, 1, partez. */
const DECOMPTE_MS = 3000;

/**
 * Combien de coups on calcule d'avance. Voir SPEC.md §17.
 *
 * Le prix d'un top monte avec la grille : cinq millisecondes sur un plateau
 * borne, plus d'une seconde au dix-millieme coup d'une grille sans fin. En
 * direct, ce temps-la se voit -- le coup precedent est tombe, les caramels
 * sont poses, et le tirage suivant se fait attendre.
 *
 * Cinq coups d'avance suffisent : au rythme ou l'on joue, ils representent
 * plusieurs minutes de marge, et ils tiennent en memoire. En chercher
 * davantage ne ferait qu'immobiliser plus longtemps le fil du solveur, qui
 * doit rester disponible pour le rejeu.
 */
const COUPS_D_AVANCE = 5;

/**
 * Un coup entierement pret, tire et resolu, qui n'a pas encore ete servi.
 *
 * CES DONNEES NE SORTENT JAMAIS. Ni l'etat public, ni le journal, ni le
 * terminal n'en voient la couleur : elles disent le tirage a venir et son top,
 * c'est-a-dire tout ce qu'un joueur aurait interet a savoir.
 */
interface CoupPret {
  n: number;
  rack: string;
  notation: string;
  top: Move;
  bestScore: number;
  isotops: number;
  tiers: Tier[];
  /** Ce que sa recherche a coute, pour que le terminal puisse encore le dire. */
  ms: number;
  /** Ce qui restera en main apres le top -- le point de depart du tirage suivant. */
  reliquatApres: string[];
  /**
   * PARTIE JOKER : ce que les jokers de ce coup ont decide.
   *
   * `sorties` liste les lettres qui quittent le sac pour de vrai -- un joker
   * qui joue un R fait sortir un vrai R. `restes` compte les jokers qui sont
   * restes jokers, faute de lettre disponible. Le double a pris ces decisions
   * sur sa copie du sac ; il faut pouvoir les rejouer telles quelles sur le
   * vrai, sinon les deux sacs divergeraient au coup suivant.
   */
  jokersSortis: string[];
  jokersRestes: number;
}

/**
 * Combien de tirages sans le moindre coup jouable avant de clore la partie.
 *
 * Un tirage dont rien ne se pose est deja rarissime -- il faut une grille tres
 * fermee et beaucoup de malchance. Que ce soit vrai autant de fois de suite,
 * avec un tirage refait a chaque fois, ne s'explique plus par la malchance : le
 * sac ne contient plus de quoi jouer, et la partie est finie.
 *
 * Le nombre suit le PRIX D'UN ESSAI, qui n'est pas le meme des deux cotes :
 * quelques millisecondes sur un plateau borne, jusqu'a une seconde sur une
 * grille de trois mille coups. On peut donc se montrer large la ou c'est
 * gratuit, et rester sobre la ou chaque essai se paie.
 */
const tiragesInjouables = (bornes: number | null): number => bornes !== null ? 40 : 8;

/** Ce processus existe-t-il encore ? EPERM veut dire oui, mais pas a nous. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Le verrou bat toutes les dix secondes ; on le tient pour mort au-dela de
 * quarante.
 *
 * Le numero de processus ne suffit pas a savoir si un serveur vit encore : le
 * systeme les RECYCLE. Un verrou laisse par un serveur tue a ainsi bloque le
 * demarrage parce que son numero avait ete repris par un processus Windows sans
 * aucun rapport -- « ce processus existe-t-il ? » repondait oui. Le battement
 * tranche : un verrou qui ne bat plus n'est tenu par personne.
 */
const BATTEMENT_MS = 10_000;
const VERROU_MORT_MS = 40_000;

export class Game {
  readonly gameId: string;
  readonly layout: LayoutName;
  private readonly dawg: Dict;
  private readonly board: Board;
  private bag!: Pioche;
  /** La configuration de cette partie : tirage, pose, primes, pioche. */
  readonly cfg: ConfigPartie;
  /** La partie est terminee : le sac ne permet plus de jouer (SPEC.md §16). */
  finie = false;
  /**
   * Jokers encore disponibles, en partie joker. Ils ne sont PAS dans le sac :
   * ils vivent au tirage, et n'en sortent que le jour ou aucune vraie lettre ne
   * peut les remplacer sur la grille.
   */
  jokersEnReserve = 0;
  /** Cree dans start(), une fois la graine connue. */
  private worker!: Worker;
  private readonly file: string;
  private readonly journal: string;
  private readonly lockFile: string;
  private holdsLock = false;
  private battement: ReturnType<typeof setInterval> | null = null;
  /** Descripteur du journal, ouvert en ajout pour toute la duree de la partie. */
  private jfd: number | null = null;
  /** Taille du journal en octets : c'est l'adresse ou la prochaine ligne ira. */
  private tailleJournal = 0;
  /**
   * OU TROUVER LES PALIERS DE CHAQUE COUP, dans le journal.
   *
   * Ils ne sont PAS gardes en memoire. Ils pesent 86 % du journal -- deux cent
   * quarante-quatre megaoctets pour vingt-deux mille coups -- et ne servent
   * qu'au rejeu, sur un coup a la fois. On retient donc l'octet ou leur ligne
   * commence, et on va la relire a la demande (SPEC.md §20).
   */
  private ouEstLeCoup = new Map<number, number>();
  /**
   * L'ANNEXE DES SOUS-TOPS -- un fichier qu'on peut effacer.
   *
   * Les paliers sous le top ne font pas foi : ils se recalculent a partir de la
   * position et du tirage. Les mettre dans le journal, en ajout seul et
   * adresse a l'octet, revenait a les rendre indestructibles : on ne peut pas
   * en retirer une ligne sans reecrire le fichier, et reecrire le fichier
   * invalide toutes les adresses.
   *
   * Ils vivent donc a part, avec le meme adressage. Une fois la partie finie et
   * analysee, l'annexe s'efface d'un geste et le journal ne bouge pas.
   */
  private readonly annexe: string;
  private afd: number | null = null;
  private tailleAnnexe = 0;
  private ouEstLePalier = new Map<number, number>();
  /** Combien de paliers sous le top cette partie garde. Voir `paliersParDefaut`. */
  private paliersGardes = PALIERS_D_AVANT;
  seed = "";

  moves: PlayedMove[] = [];
  players: Record<string, number> = {};
  chat: ChatMessage[] = [];
  createdAt = Date.now();
  reliquat: string[] = [];
  rack = "";
  rackNotation = "";
  /**
   * Paliers refaits a la demande, gardes le temps de la partie.
   *
   * Ne sert qu'aux plateaux bornes, seuls a ne pas les enregistrer au journal.
   * Une grille infinie les a deja : elle ne passe jamais par ici.
   */
  private paliersRefaits = new Map<number, Tier[]>();
  /** Score du top du coup courant. -1 tant que le solveur n'a pas repondu. */
  bestScore = -1;
  isotops = 0;
  tiers: Tier[] = [];
  private canonicalTop: Move | null = null;
  /** Instant ou le tirage courant a ete diffuse. Le chrono du coup part de la. */
  servedAt = 0;
  /**
   * L'heure du tirage retrouvee au journal, quand le serveur redemarre.
   *
   * Sur une grille sans chrono, un coup dure jusqu'a ce que quelqu'un trouve le
   * top -- des heures, parfois des jours. Redemarrer le serveur remettait ce
   * compteur a zero : le coup paraissait neuf, et les sonneries des cinq et dix
   * minutes repartaient pour un tour. L'heure du tirage est donc ecrite au
   * journal, et reprise ici. Zero quand il n'y a rien a reprendre.
   */
  private repriseServie = 0;
  private repriseCoup = 0;
  /** Minuterie du coup en cours, quand la partie est chronometree. */
  private echeance: ReturnType<typeof setTimeout> | null = null;
  /**
   * Fin du decompte d'avant-coup, quand il est active. Tant qu'il court, le
   * tirage est connu mais le chrono n'a pas demarre : personne ne perd de temps.
   */
  decompteJusqua = 0;
  /** Instant du premier tirage. Sert a mesurer la duree d'une partie bornee. */
  debutDeLaPartie = 0;

  /**
   * Le tirage, tel qu'il part aux clients.
   *
   * VIDE pendant le decompte. « 3, 2, 1 » est un depart, et partir en ayant
   * deja lu ses lettres n'en est pas un. La regle est ici, dans la partie, et
   * non dans le transport : le tirage ne doit pas etre public, pas seulement
   * ne pas s'afficher -- cache a l'ecran, il resterait lisible dans la console.
   */
  get rackPublic(): string {
    return this.decompteJusqua > Date.now() ? "" : this.rack;
  }

  /** La notation du tirage, muette elle aussi pendant le decompte. */
  get notationPublique(): string {
    return this.decompteJusqua > Date.now() ? "" : this.rackNotation;
  }
  /**
   * Y a-t-il quelqu'un dans le salon ?
   *
   * Une partie endormie ne pioche pas et ne chronometre pas. Sans cela, un
   * salon vide continuait a devorer des coups -- et sur une grande grille a
   * gros tirage, des MINUTES de calcul chacun -- pour personne.
   */
  actif = false;
  /**
   * La partie a-t-elle commence ?
   *
   * Un salon neuf s'ouvre sur ses reglages : ni tirage, ni chrono, tant que
   * son proprietaire n'a pas valide la variante. Entrer quelque part ne doit
   * pas lancer une partie qu'on n'a pas choisie.
   */
  demarree = false;

  /**
   * Instant, en millisecondes, ou le lancement s'acheve. Zero = aucun en cours.
   *
   * UNE GRILLE PERMANENTE NE DEMARRE PAS TOUTE SEULE quand elle est neuve.
   * C'est le jour du lancement : on veut que la salle soit pleine quand le
   * premier tirage tombe, pas qu'il soit tombe la veille devant personne. Un
   * administrateur ouvre donc un compte a rebours, tout le monde le voit
   * descendre, et le tirage arrive a zero.
   */
  lancementA = 0;
  /**
   * Qui est dans le salon. Tenu a jour par le transport : le moteur n'a pas de
   * WebSocket, mais le duplicate a besoin de savoir QUI etait la au moment du
   * tirage -- c'est ce qui distingue un joueur compte d'un visiteur arrive en
   * cours de coup.
   */
  readonly presents = new Set<string>();
  /**
   * La meilleure solution de chacun sur le coup EN COURS.
   *
   * Le duplicate en a besoin pour compter les points ; le topping s'en sert
   * pour le demi-point, et pour rendre a un joueur qui revient ce qu'il avait
   * trouve avant de fermer sa page. Elle ne survit pas a un redemarrage du
   * serveur : elle n'est ecrite au journal qu'a la cloture du coup.
   */
  private propositions = new Map<
    string, { score: number; word: string; dir: Dir; x: number; y: number; at: number }
  >();

  /**
   * Ce que ce joueur a propose de mieux sur le coup en cours, ou null.
   *
   * NE SE DIFFUSE PAS. Chacun ne recoit que la sienne, a la connexion : savoir
   * qu'un voisin tient 84 points est deja un renseignement sur la position.
   */
  propositionDe(joueur: string): { word: string; score: number; dir: Dir; x: number; y: number } | null {
    const p = this.propositions.get(joueur);
    return p === undefined ? null : { word: p.word, score: p.score, dir: p.dir, x: p.x, y: p.y };
  }
  /** DUPLICATE : qui etait present quand le tirage est tombe. */
  private participants = new Set<string>();
  solving = false;

  /**
   * LES COUPS D'AVANCE. Voir SPEC.md §17.
   *
   * La file des coups deja tires et deja resolus, dans l'ordre. Elle est
   * strictement privee : rien ici ne part aux clients, ne s'ecrit au journal,
   * ni ne s'affiche au terminal.
   */
  private avance: CoupPret[] = [];
  /**
   * La pioche du double, une COPIE de la vraie.
   *
   * Piocher dans le vrai sac pour calculer d'avance avancerait aussi le
   * reliquat affiche : les joueurs verraient disparaitre des lettres avant
   * qu'elles ne soient tirees, et pourraient en deduire les tirages a venir.
   * Le double pioche donc a part, et la vraie pioche ne bouge qu'au moment du
   * vrai tirage -- ou l'on verifie que les deux tombent bien d'accord.
   */
  private sacAvance: Pioche | null = null;
  private reliquatAvance: string[] = [];
  /** La reserve de jokers du double, en partie joker. */
  private jokersAvance = 0;
  /**
   * Le coup en cours, tel que le double l'a prepare.
   *
   * Il porte le reliquat et les decisions de joker prises SUR LA COPIE du sac.
   * `commit` les rejoue sur le vrai plutot que de les reprendre a son compte :
   * a ce moment-la les placements sont deja resolus, et la question ne peut
   * plus se poser dans le bon ordre. Vaut `null` quand l'avance ne tourne pas.
   */
  private pretCourant: CoupPret | null = null;
  /** Le coup servi vient de la file : sa pose est deja faite chez le solveur. */
  private posePrise = false;
  /** Combien de coups ont ete servis SANS ATTENTE, parce qu'ils etaient prets. */
  coupsPrets = 0;
  /** Ce que la recherche du top courant a coute. Dit au terminal, jamais aux clients. */
  private msDuTop = 0;
  /**
   * Combien de coups ont du etre cherches en direct, la file vide et aucun pas
   * de calcul en cours. C'est le compte des occasions manquees.
   */
  calculsDirects = 0;
  private avanceEnCours = false;
  /** Le pas de calcul en cours, s'il y en a un. Voir `deal` : on l'attend. */
  private pasDAvance: Promise<boolean> | null = null;
  /** Un desaccord entre le double et la vraie partie : on renonce, sans risque. */
  private avanceRenoncee = false;
  /** La partie est arretee : plus rien ne doit partir au fil de calcul. */
  private arretee = false;
  /**
   * Combien de coups la grille du SOLVEUR porte.
   *
   * Elle prend de l'avance sur celle de la partie : le coup en cours y est deja
   * pose, et les coups prets aussi. C'est ce compte, et non le numero du coup
   * joue, qui dit sur quelle position le prochain calcul tombera.
   */
  private posesSolveur = 0;

  private nextId = 1;
  private pending = new Map<number, (r: any) => void>();
  private listeners: (() => void)[] = [];
  private surCoup: ((m: PlayedMove) => void)[] = [];
  private surChat: ((m: ChatMessage) => void)[] = [];

  constructor(gameId: string, layout: LayoutName, cfg?: ConfigPartie) {
    this.gameId = gameId;
    this.layout = layout;
    setLayout(layout);
    this.cfg = cfg ?? configParDefaut();
    // Le lexique de la partie, pas celui du serveur : deux salons voisins
    // peuvent jouer l'un en francais et l'autre en anglais.
    this.dawg = loadDict(dawgPath(this.cfg.dictionnaire));
    this.board = new Board(this.dawg, this.cfg);
    this.file = join(DATA_DIR, `${gameId}.json`);
    this.journal = join(DATA_DIR, `${gameId}.journal.jsonl`);
    this.annexe = join(DATA_DIR, `${gameId}.paliers.jsonl`);
    this.lockFile = join(DATA_DIR, `${gameId}.verrou`);
  }

  /**
   * Un seul serveur a la fois sur une partie.
   *
   * Deux processus qui ecrivent dans le meme journal en font une bouillie :
   * les coups s'entrelacent, les numeros se repetent, et la partie devient
   * irrecuperable. Le port ne protege pas -- deux serveurs sur deux ports
   * differents ouvrent tres bien la meme partie.
   */
  private acquireLock(): void {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(this.lockFile)) {
      let held: { pid?: number; since?: number; vu?: number } = {};
      try { held = JSON.parse(readFileSync(this.lockFile, "utf8")); } catch { /* verrou illisible */ }
      const pid = held.pid;
      // Un verrou d'avant le battement n'a pas de `vu` : on se rabat sur son
      // horodatage de prise, faute de mieux.
      const dernierSigne = held.vu ?? held.since ?? 0;
      const bat = Date.now() - dernierSigne < VERROU_MORT_MS;
      if (pid !== undefined && pid !== process.pid && alive(pid) && bat) {
        throw new Error(
          `la partie "${this.gameId}" est deja ouverte par le processus ${pid}` +
          (held.since ? ` depuis ${new Date(held.since).toLocaleString("fr")}` : "") +
          `.
  Deux serveurs sur la meme partie corrompraient le journal.` +
          `
  Arretez l'autre serveur, ou lancez celui-ci avec --partie <autre-nom>.` +
          `
  Si vous etes certain qu'aucun serveur ne tourne : supprimez ${this.lockFile}`,
        );
      }
      if (pid !== undefined && pid !== process.pid) {
        console.log(
          `[partie] verrou perime du processus ${pid}` +
          (alive(pid) ? " (numero recycle par un autre programme)" : " (arret brutal)") +
          `, on le reprend`,
        );
      }
    }
    this.ecrireLeVerrou(Date.now());
    this.holdsLock = true;
    // Le battement dit « je suis toujours la ». Sans lui, rien ne distingue un
    // serveur vivant d'un numero de processus recycle.
    this.battement = setInterval(() => {
      if (this.holdsLock) this.ecrireLeVerrou(this.depuis);
    }, BATTEMENT_MS);
    this.battement.unref?.();
  }

  /** Instant de prise du verrou, conserve pour l'affichage. */
  private depuis = 0;

  private ecrireLeVerrou(depuis: number): void {
    this.depuis = depuis === 0 ? Date.now() : depuis;
    try {
      const fd = openSync(this.lockFile, "w");
      writeSync(fd, JSON.stringify({ pid: process.pid, since: this.depuis, vu: Date.now() }));
      closeSync(fd);
    } catch { /* un verrou qu'on n'arrive pas a ecrire ne doit pas tuer la partie */ }
  }

/**
   * Arrete la partie : le fil de calcul se termine et le verrou est rendu.
   *
   * Indispensable quand un salon relance une partie : sans cela le fil du
   * solveur precedent survivrait, avec sa grille et ses 4 Mo de dictionnaires,
   * et le verrou empecherait la nouvelle partie de s'ouvrir.
   */
  async stop(): Promise<void> {
    // D'ABORD couper l'avance. Les demandes en attente vont etre denouees juste
    // en dessous ; sans ce drapeau, la boucle de calcul en relancerait une
    // aussitot, vers un fil qui n'existe plus, et n'aurait plus jamais de
    // reponse.
    this.arretee = true;
    this.viderLAvance();
    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    // L'instantane est en retard d'au plus vingt coups : on le remet a jour
    // avant de partir, pour que les outils qui le lisent trouvent la partie
    // telle qu'elle s'est arretee. Le journal, lui, est a jour au coup pres.
    if (this.moves.length > 0) this.save(true);
    for (const fd of [this.jfd, this.afd]) {
      if (fd !== null) { try { closeSync(fd); } catch { /* deja ferme */ } }
    }
    this.jfd = null;
    this.afd = null;
    this.releaseLock();
    for (const [, done] of this.pending) done({ result: null, ms: 0 });
    this.pending.clear();
    this.listeners = [];
    this.surCoup = [];
    this.surChat = [];
    if (this.worker !== undefined) await this.worker.terminate();
  }

  /** Rend le verrou. Sans effet s'il ne nous appartient pas. */
  releaseLock(): void {
    if (this.battement !== null) { clearInterval(this.battement); this.battement = null; }
    if (!this.holdsLock) return;
    this.holdsLock = false;
    try {
      const held = JSON.parse(readFileSync(this.lockFile, "utf8")) as { pid?: number };
      if (held.pid === process.pid) unlinkSync(this.lockFile);
    } catch { /* deja parti, tant mieux */ }
  }

  /**
   * Ecrit un evenement dans le journal et le force sur le disque. Le fsync
   * coute une milliseconde ; c'est le prix pour qu'une coupure de courant
   * juste apres un coup ne le fasse pas disparaitre.
   */
  private append(ev: Record<string, unknown>): number {
    mkdirSync(DATA_DIR, { recursive: true });
    if (this.jfd === null) {
      this.jfd = openSync(this.journal, "a");
      if (this.tailleJournal === 0 && existsSync(this.journal)) {
        this.tailleJournal = statSync(this.journal).size;
      }
    }
    const ligne = JSON.stringify(ev) + "\n";
    // L'octet ou cette ligne commence : de quoi la retrouver sans relire tout
    // le journal. Le fichier ne se reecrit jamais, l'adresse est donc definitive.
    const ou = this.tailleJournal;
    writeSync(this.jfd, ligne);
    fsyncSync(this.jfd);
    this.tailleJournal += Buffer.byteLength(ligne, "utf8");
    return ou;
  }

  /**
   * Ecrit les sous-tops d'un coup dans l'annexe, et rend l'octet ou ils sont.
   *
   * PAS DE FSYNC ICI, a la difference du journal. Ce qui est ecrit la se
   * recalcule ; perdre la derniere ligne dans une coupure ne coute qu'un
   * recalcul, et le fsync coutait une milliseconde a chaque coup.
   */
  private appendPaliers(n: number, tiers: readonly Tier[]): number {
    mkdirSync(DATA_DIR, { recursive: true });
    if (this.afd === null) {
      this.afd = openSync(this.annexe, "a");
      if (this.tailleAnnexe === 0 && existsSync(this.annexe)) {
        this.tailleAnnexe = statSync(this.annexe).size;
      }
    }
    const ligne = JSON.stringify({ n, tiers }) + "\n";
    const ou = this.tailleAnnexe;
    writeSync(this.afd, ligne);
    this.tailleAnnexe += Buffer.byteLength(ligne, "utf8");
    return ou;
  }

  /**
   * Releve les adresses de l'annexe SANS EN LIRE LE CONTENU.
   *
   * Le fichier peut peser des dizaines de megaoctets et rien n'oblige a le
   * comprendre au demarrage : on repere le debut de chaque ligne et on y lit le
   * seul numero de coup, ecrit en tete par construction.
   */
  private relireLAnnexe(): void {
    if (!existsSync(this.annexe)) return;
    const brut = readFileSync(this.annexe);
    let debut = 0, casses = 0;
    for (let i = 0; i <= brut.length; i++) {
      if (i !== brut.length && brut[i] !== 10) continue;
      if (i > debut) {
        const tete = brut.toString("latin1", debut, Math.min(debut + 32, i));
        const m = /^\{"n":(\d+),/.exec(tete);
        if (m !== null) this.ouEstLePalier.set(Number(m[1]), debut);
        else casses++;
      }
      debut = i + 1;
    }
    this.tailleAnnexe = brut.length;
    if (this.ouEstLePalier.size > 0) {
      console.log(`[partie] ${this.ouEstLePalier.size} coup(s) avec sous-tops en annexe`);
    }
    if (casses > 0) console.warn(`[partie] ${casses} ligne(s) illisible(s) dans l'annexe`);
  }

  /** Relit le journal. Les lignes tronquees par une coupure sont ignorees. */
  private readJournal(): { ev: Record<string, any>; ou: number }[] {
    if (!existsSync(this.journal)) return [];
    // LU EN OCTETS, PAS EN CARACTERES. On retient ou commence chaque ligne pour
    // pouvoir y revenir plus tard (voir `paliersDuCoup`) ; un journal porte des
    // accents, et l'indice d'un caractere n'y est pas celui d'un octet.
    const brut = readFileSync(this.journal);
    const out: { ev: Record<string, any>; ou: number }[] = [];
    let broken = 0, debut = 0;
    for (let i = 0; i <= brut.length; i++) {
      if (i !== brut.length && brut[i] !== 10) continue;
      const ligne = brut.toString("utf8", debut, i).trim();
      const ou = debut;
      debut = i + 1;
      if (ligne === "") continue;
      try { out.push({ ev: JSON.parse(ligne), ou }); } catch { broken++; }
    }
    this.tailleJournal = brut.length;
    if (broken > 0) {
      console.warn(`[partie] ${broken} ligne(s) illisible(s) dans le journal, ignorees`);
    }
    return out;
  }

  /**
   * Relit UNE ligne du journal, celle qui commence a cet octet.
   *
   * C'est ce qui permet de ne pas garder les paliers en memoire : ils restent
   * la ou ils ont ete ecrits, et on va les chercher quand -- et seulement
   * quand -- quelqu'un ouvre le rejeu sur ce coup-la.
   */
  private ligneDuJournal(ou: number, fichier = this.journal): Record<string, any> | null {
    let taille = 65536;
    for (let essai = 0; essai < 8; essai++) {
      let fd: number | null = null;
      try {
        fd = openSync(fichier, "r");
        const tampon = Buffer.allocUnsafe(taille);
        const lus = readSync(fd, tampon, 0, taille, ou);
        const fin = tampon.indexOf(10, 0);
        // Pas de fin de ligne dans ce qu'on a lu : la ligne est plus longue --
        // un coup a deux jokers en compte des dizaines de milliers. On elargit.
        if (fin === -1 && lus === taille) { taille *= 4; continue; }
        return JSON.parse(tampon.toString("utf8", 0, fin === -1 ? lus : fin));
      } catch {
        return null;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
    return null;
  }

  /**
   * La variante d'une partie deja commencee, lue sans la demarrer.
   *
   * Le serveur doit la connaitre avant de construire la grille : une partie
   * reprise garde sa variante, on ne rejoue pas une 8 sur 8 en 7 sur 7.
   */
  static configEnregistree(gameId: string): ConfigSerialisee | null {
    const journal = join(DATA_DIR, `${gameId}.journal.jsonl`);
    if (existsSync(journal)) {
      for (const ligne of readFileSync(journal, "utf8").split("\n")) {
        if (ligne.trim() === "") continue;
        try {
          const e = JSON.parse(ligne) as Record<string, unknown>;
          if (e["t"] === "grille") return (e["config"] as ConfigSerialisee) ?? null;
        } catch { /* ligne illisible */ }
      }
      return null;
    }
    const instantane = join(DATA_DIR, `${gameId}.json`);
    if (!existsSync(instantane)) return null;
    try {
      return (JSON.parse(readFileSync(instantane, "utf8")) as Saved).config ?? null;
    } catch { return null; }
  }

  onChange(fn: () => void): void { this.listeners.push(fn); }

  /**
   * Prevenu a chaque coup pose, QUELLE QUE SOIT SON ORIGINE.
   *
   * Un coup remporte par un joueur, revele a la main ou pose par le minuteur
   * doit atteindre les clients de la meme facon. Diffuser depuis le point
   * d'entree du message laissait les coups du chrono invisibles : la grille
   * avancait sans que personne ne recoive les caramels.
   */
  onMove(fn: (m: PlayedMove) => void): void { this.surCoup.push(fn); }

  /**
   * Prevenu a chaque message du chat, y compris ceux que le MOTEUR emet.
   *
   * La liste des trouveurs du duplicate vient de la, pas d'un joueur : diffuser
   * depuis le point d'entree du message « say » la laissait invisible, comme
   * l'etaient les coups poses par le chrono.
   */
  onChat(fn: (m: ChatMessage) => void): void { this.surChat.push(fn); }
  private emit(): void { for (const f of this.listeners) f(); }

  /**
   * Ouvre le fil du solveur. A part, parce qu'il faut savoir le refaire : voir
   * `renoncerALAvance`.
   */
  private demarrerLeSolveur(): void {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { layout: this.layout, seed: this.seed, config: serialiser(this.cfg) },
    });
    this.worker.on("message", (m: any) => {
      if (m.t !== "solved" && m.t !== "paliers" && m.t !== "avancee") return;
      const done = this.pending.get(m.id);
      this.pending.delete(m.id);
      done?.(m);
    });
    this.worker.on("error", (e) => console.error("[solveur]", e));
  }

  /** Rejoue le journal, puis prepare le coup courant. */
  async start(): Promise<void> {
    this.acquireLock();

    // Le journal fait foi. L'instantane ne sert que s'il n'y a pas de journal
    // -- parties d'avant son existence, ou journal efface a la main.
    const events = this.readJournal();
    this.relireLAnnexe();
    let saved: Saved | null = null;

    if (events.length > 0) {
      saved = this.rebuild(events);
      console.log(`[partie] ${events.length} evenements relus dans le journal`);
    } else if (existsSync(this.file)) {
      saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
      console.log(`[partie] pas de journal, reprise depuis l'instantane`);
    }

    // Nouvelle grille = nouvelle graine, tiree au hasard. Les parties anciennes
    // n'en avaient pas : on retombe sur le nom, pour ne pas les casser.
    this.seed = saved?.seed ?? (saved ? this.gameId : randomUUID());
    this.createdAt = saved?.createdAt ?? Date.now();
    this.chat = saved?.chat ?? [];

    // COMBIEN DE PALIERS CETTE PARTIE GARDE.
    //
    // Le reglage est ecrit dans l'entete a la creation, et la partie garde le
    // sien jusqu'a son dernier coup : changer la valeur par defaut ne doit pas
    // modifier une partie deja commencee, sans quoi une grille qu'on a ouverte
    // pour l'etudier cesserait en cours de route d'enregistrer ce qu'on
    // voulait etudier.
    //
    // Un entete SANS le champ designe une partie d'avant le reglage : elle
    // garde ses quarante paliers, dans le journal, comme elle a toujours fait.
    const entete = events.find((e) => e.ev["t"] === "grille")?.ev ?? null;
    const dejaCommencee = entete !== null || saved !== null;
    this.paliersGardes = typeof entete?.["paliers"] === "number"
      ? (entete["paliers"] as number)
      : dejaCommencee ? PALIERS_D_AVANT : paliersParDefaut(this.cfg);

    // Le journal commence par l'entete de la grille : graine, pavage, date.
    // Sans lui on ne saurait pas rejouer la partie a partir du seul journal.
    if (events.length === 0) {
      this.append({
        t: "grille", gameId: this.gameId, layout: this.layout,
        seed: this.seed, createdAt: this.createdAt, config: serialiser(this.cfg),
        paliers: this.paliersGardes,
      });
      // Migration : une partie qui n'avait qu'un instantane se voit dotee d'un
      // journal complet, retroactivement.
      if (saved !== null) {
        for (const m of saved.moves) {
          // Le journal neuf recoit les paliers que l'instantane portait, et
          // retient ou il les a mis : la partie migree se relit ensuite comme
          // toutes les autres.
          this.ouEstLeCoup.set(m.n, this.append({ t: "coup", move: m }));
        }
        for (const c of this.chat) this.append({ t: "chat", msg: c });
        console.log(`[partie] journal cree a partir de l'instantane`);
      }
    }
    // En partie joker, le tirage contient toujours un joker : le sac ne
    // distribue donc que `tirage - 1` lettres, et les deux jokers sont mis de
    // cote. Ils ne sont pas piochables, ils accompagnent le tirage.
    // Combien de jokers ? Deux si le sac est fini -- ce sont ceux du jeu. Sur
    // une pioche qui ne s'epuise pas, ils ne s'epuisent pas non plus : on en
    // reprend un chaque fois qu'un est pose.
    this.jokersEnReserve = this.cfg.joker
      ? (this.cfg.pioche === "sac102" ? 2 : Infinity)
      : 0;
    const parTirage = this.cfg.tirage - (this.cfg.joker ? 1 : 0);
    const alea = mulberry32(moveSeed(this.seed, 0));

    // Le sac et les poids suivent le dictionnaire : le W anglais est une
    // lettre ordinaire dont on a deux exemplaires, le W francais une rarete
    // unique.
    const lexique = dictionnaire(this.cfg.dictionnaire);
    if (this.cfg.pioche === "probabilites") {
      const ponderee: BagConfig = {
        weights: lexique.poids, blankWeight: lexique.poidsJoker,
        alpha: 0.08, cap: 4, maxBlanks: 2,
      };
      this.bag = new Bag(ponderee, alea, undefined, parTirage);
    } else {
      const distribution = this.cfg.joker
        ? Object.fromEntries(Object.entries(lexique.sac).filter(([l]) => l !== BLANK))
        : lexique.sac;
      const sac = new SacFini(distribution, alea, parTirage);
      sac.recharge = this.cfg.pioche === "sac102boucle";
      this.bag = sac;
    }

    this.demarrerLeSolveur();

    if (saved !== null) {
      if (saved.layout !== this.layout) {
        throw new Error(
          `la partie ${this.gameId} a ete jouee sur le pavage "${saved.layout}", ` +
          `pas "${this.layout}" -- changer de pavage invaliderait tous les scores`,
        );
      }
      this.players = saved.players ?? {};
      let sansTrace = 0;
      for (const m of saved.moves) {
        // La pioche doit etre refaite dans l'ordre : c'est elle qui porte l'etat
        // de compensation, et il depend de tout l'historique. En partie joker
        // elle est completee SANS le joker, exactement comme au tirage.
        const gardeJoker = this.cfg.joker && this.jokersEnReserve > 0;
        this.bag.draw(gardeJoker ? this.reliquat.filter((c) => c !== BLANK) : this.reliquat);
        // LES PLACEMENTS SE REFONT ICI, avant de poser quoi que ce soit : la
        // grille est encore telle qu'elle etait avant ce coup, et c'est elle
        // qui dit quelles cases du mot etaient libres. Un journal d'avant ce
        // changement les porte : on les prend alors tels quels.
        if ((m as { placements?: Placement[] }).placements === undefined) {
          m.placements = this.refairePlacements(m);
        }
        this.board.place(m.placements);
        this.worker.postMessage({ t: "place", placements: m.placements });
        if (this.cfg.joker) {
          const trace = m.jokers;
          if (trace === undefined) sansTrace++;
          this.reliquat = Bag.remainder(m.rack, Game.avantSubstitution(m, trace));
          // Les lettres que les jokers ont fait sortir doivent RESSORTIR : le
          // sac n'en a plus, et sans cela sa composition derive coup apres coup.
          // Rien a ressortir d'une pioche qui ne s'epuise pas : elle n'avait
          // rien donne.
          const sac = this.bag as SacFini;
          if (Game.preleveLesLettres(this.bag)) {
            for (const l of trace?.sortis ?? []) sac.retirer(l);
          }
          this.jokersEnReserve -= trace?.restes ?? 0;
        } else {
          this.reliquat = Bag.remainder(m.rack, m.placements);
        }
        this.moves.push(m);
      }
      if (sansTrace > 0) {
        console.warn(`[partie] ${sansTrace} coup(s) joker sans trace de substitution : ` +
          `le reliquat est reconstitue au mieux`);
      }
      this.posesSolveur = this.moves.length;
      console.log(`[partie] ${this.moves.length} coups rejoues`);
    } else {
      console.log(`[partie] nouvelle grille, graine ${this.seed.slice(0, 8)}`);
    }
    // Une partie qui a deja des coups a evidemment commence : on ne va pas
    // redemander ses reglages a celui qui la reprend.
    this.demarree = this.moves.length > 0;
    // On ne pioche PAS ici : le premier joueur qui entre declenchera le
    // calcul. Distribuer au demarrage faisait calculer le top de chaque salon
    // enregistre, y compris ceux que personne n'ouvrira.
  }

  /**
   * Les placements d'un coup joker TELS QU'ILS ONT QUITTE LE TIRAGE.
   *
   * Le journal garde le resultat de la substitution -- un vrai R -- mais le
   * reliquat se compte sur le tirage, ou il n'y avait qu'un joker. On remet
   * donc le drapeau sur les lettres que la trace signale comme sorties du sac.
   *
   * SANS TRACE -- un journal joker d'avant son existence -- on se rabat sur une
   * regle qui n'est pas sure mais qui ouvre la partie : une lettre absente du
   * tirage ne peut venir que d'un joker. Elle se trompe quand le joker a joue
   * une lettre que le tirage contenait par ailleurs ; c'est mieux que de
   * refuser d'ouvrir.
   */
  private static avantSubstitution(
    m: PlayedMove, trace: { sortis: string[]; restes: number } | undefined,
  ): Placement[] {
    if (trace === undefined) {
      const reste = [...m.rack];
      return m.placements.map((p) => {
        if (p.blank) return p;
        const i = reste.indexOf(p.letter);
        if (i !== -1) { reste.splice(i, 1); return p; }
        return { ...p, blank: true };
      });
    }
    const sortis = [...trace.sortis];
    return m.placements.map((p) => {
      if (p.blank) return p;
      const i = sortis.indexOf(p.letter);
      if (i === -1) return p;
      sortis.splice(i, 1);
      return { ...p, blank: true };
    });
  }

  /**
   * Reconstruit la partie a partir des seuls evenements du journal. C'est le
   * chemin de recuperation : meme si l'instantane a disparu, tout est ici.
   */
  private rebuild(events: { ev: Record<string, any>; ou: number }[]): Saved {
    const out: Saved = {
      gameId: this.gameId, layout: this.layout, seed: this.gameId,
      createdAt: Date.now(), moves: [], players: {}, chat: [],
    };
    const byNumber = new Map<number, PlayedMove>();
    let servi: { n: number; at: number } | null = null;
    for (const { ev, ou } of events) {
      if (ev["t"] === "servi") {
        servi = { n: ev["n"] as number, at: ev["at"] as number };
        continue;
      }
      if (ev["t"] === "grille") {
        out.seed = ev["seed"] ?? out.seed;
        out.createdAt = ev["createdAt"] ?? out.createdAt;
        out.layout = ev["layout"] ?? out.layout;
      } else if (ev["t"] === "coup") {
        const m = ev["move"] as PlayedMove;
        // LES PALIERS RESTENT AU JOURNAL, PAS EN MEMOIRE. On note l'octet ou la
        // ligne commence, et on jette ce qu'elle portait : c'est ce qui divise
        // par sept la memoire d'une grande partie, et par treize le prix de
        // l'instantane, reecrit a chaque coup.
        this.ouEstLeCoup.set(m.n, ou);
        delete m.tiers;
        out.moves.push(m);
        byNumber.set(m.n, m);
      } else if (ev["t"] === "chat") {
        out.chat.push(ev["msg"] as ChatMessage);
      } else if (ev["t"] === "like") {
        const m = byNumber.get(ev["n"] as number);
        if (m === undefined) continue;
        const likes = m.likes ?? (m.likes = []);
        const i = likes.indexOf(ev["who"] as string);
        if (ev["on"] === true && i === -1) likes.push(ev["who"] as string);
        if (ev["on"] === false && i !== -1) likes.splice(i, 1);
      }
    }
    // L'HEURE DU COUP EN COURS SURVIT AU REDEMARRAGE. Voir SPEC.md §17.
    //
    // Le dernier tirage servi n'a pas ete joue : c'est celui que la partie va
    // reprendre. Son heure est celle a laquelle il est VRAIMENT parti, et sur
    // une grille sans chrono c'est tout ce qui compte -- un coup qui dure
    // depuis six heures doit continuer d'en dire six, meme si le serveur a
    // redemarre entre-temps, et les sonneries des cinq et dix minutes ne
    // doivent pas repartir de zero.
    //
    // Un chrono, lui, repart entier : reprendre une minuterie interrompue
    // ferait expirer le coup a la seconde ou le serveur revient.
    if (servi !== null && servi.n === out.moves.length + 1 && this.cfg.chrono === null) {
      this.repriseCoup = servi.n;
      this.repriseServie = servi.at;
    }
    // Le classement se recompte, il ne se stocke pas : ainsi il ne peut pas
    // deriver de la liste des coups.
    for (const m of out.moves) {
      if (m.player !== null) out.players[m.player] = (out.players[m.player] ?? 0) + 1;
      if (m.demiPoint !== undefined) {
        out.players[m.demiPoint.joueur] = (out.players[m.demiPoint.joueur] ?? 0) + 0.5;
      }
    }
    return out;
  }

  /**
   * Aimer un coup, ou retirer son "j'aime". Le like va au joueur qui a trouve
   * le top ; un coup revele sans joueur ne s'aime pas.
   */
  like(who: string, n: number): boolean {
    const m = this.moves.find((q) => q.n === n);
    if (m === undefined || m.player === null || m.player === who) return false;
    const likes = m.likes ?? (m.likes = []);
    const i = likes.indexOf(who);
    const on = i === -1;
    if (on) likes.push(who); else likes.splice(i, 1);
    this.append({ t: "like", n, who, on });
    this.save();
    this.emit();
    return true;
  }

  /**
   * Coups que personne n'a remportes, comptes comme le serait un joueur.
   *
   * UN DEMI-POINT N'EST PAS UNE TROUVAILLE, ET NE RACHETE PAS LE COUP. Il
   * recompense celui qui s'est le plus approche quand le top a echappe a tout
   * le monde : le coup reste entierement perdu, et il compte ici pour un plein
   * point. Les deux ne s'excluent donc pas -- un coup a demi-point vaut 1 aux
   * perdus ET 0,5 au joueur, et le tableau distribue 1,5 sur ce coup-la.
   */
  get nonTrouves(): number {
    return this.moves.filter((m) => m.player === null).length;
  }

  /** Le bilan, refait seulement quand un coup s'ajoute. */
  private bilanFait = -1;
  private bilanGarde: Bilan = { points: {}, negatif: {}, tops: {} };

  /**
   * POINTS, NEGATIF ET TOPS DE CHACUN, dans les deux modes.
   *
   * Le negatif est l'ecart cumule au top : un joueur qui a trouve tous les tops
   * l'a nul. Il ne compte QUE LES COUPS OU L'ON A PROPOSE quelque chose --
   * compter les coups regardes sans rien tenter donnerait un negatif qui mesure
   * l'absence, pas le jeu.
   *
   * Le duplicate tient ses scores dans `scores`, ou tout le monde marque a
   * chaque coup. Le topping n'en a pas : on lit alors les propositions, qui y
   * sont enregistrees de la meme facon. Les deux modes ont donc le meme bilan,
   * ce qui permet d'afficher un negatif la ou il n'y en avait pas.
   *
   * Le calcul parcourt toute la partie -- dix-sept mille coups sur la grille
   * permanente. Il ne se refait qu'a l'arrivee d'un coup.
   */
  bilanDesJoueurs(): Bilan {
    if (this.bilanFait === this.moves.length) return this.bilanGarde;
    const points: Record<string, number> = {};
    const negatif: Record<string, number> = {};
    const tops: Record<string, number> = {};
    for (const m of this.moves) {
      const solutions: Record<string, number> = m.scores ?? Object.fromEntries(
        Object.entries(m.propositions ?? {}).map(([nom, p]) => [nom, p.score]),
      );
      for (const [nom, sc] of Object.entries(solutions)) {
        points[nom] = (points[nom] ?? 0) + sc;
        negatif[nom] = (negatif[nom] ?? 0) + (m.score - sc);
      }
      const trouve = m.trouveurs ?? (m.player !== null ? [m.player] : []);
      for (const nom of trouve) tops[nom] = (tops[nom] ?? 0) + 1;
    }
    this.bilanFait = this.moves.length;
    this.bilanGarde = { points, negatif, tops };
    return this.bilanGarde;
  }

  /** Nombre de "j'aime" recus par un joueur sur l'ensemble de la partie. */
  likesOf(player: string): number {
    let n = 0;
    for (const m of this.moves) if (m.player === player) n += m.likes?.length ?? 0;
    return n;
  }

  /** Tire le prochain tirage et lance le calcul du top. */
  private async deal(injouables = 0): Promise<void> {
    // Fin de partie (SPEC.md §16) : le sac ne permet plus de composer un tirage
    // jouable. On ne distribue plus, et l'etat diffuse le dit.
    // Nombre de coups atteint : la partie s'arrete la, meme si le sac pourrait
    // continuer. C'est ce qui donne un terme a un duplicate sur grille infinie.
    const assezJoue = this.cfg.coupsMax !== null && this.moves.length >= this.cfg.coupsMax;
    // Meme idee, comptee en temps : la partie s'arrete quand sa duree est
    // ecoulee. Le compte part du premier tirage, pas de la creation du salon.
    const assezDure = this.cfg.dureeMax !== null && this.debutDeLaPartie !== 0
      && Date.now() - this.debutDeLaPartie >= this.cfg.dureeMax * 1000;
    if (assezJoue || assezDure || this.bag.estFinie(this.reliquat)) {
      this.finie = true;
      this.solving = false;
      this.canonicalTop = null;
      // Les coups prets ne seront jamais servis : la partie s'arrete ici.
      this.viderLAvance();
      // Le tirage DISPARAIT. Le laisser en place laissait taper des mots sur une
      // partie close, sans que rien ne dise qu'elle etait finie. Les caramels
      // qui restent dans le sac ne sont pas piochés : ils ne serviront plus.
      this.rack = "";
      this.rackNotation = "";
      this.bestScore = -1;
      this.isotops = 0;
      this.tiers = [];
      console.log(`[partie] terminee apres ${this.moves.length} coups` +
        (assezJoue ? " (nombre de coups atteint)" : assezDure ? " (duree ecoulee)" : ""));
      this.emit();
      return;
    }
    // Le joker ne repasse pas par le sac : on le retire du reliquat avant de
    // completer, et on le remet ensuite.
    const gardeJoker = this.cfg.joker && this.jokersEnReserve > 0;
    const reliquatSansJoker = gardeJoker
      ? this.reliquat.filter((c) => c !== BLANK)
      : this.reliquat;
    // Nouveau coup : les propositions repartent a zero, et on fige QUI est la.
    this.propositions.clear();
    this.participants = new Set(this.presents);
    const draw = this.bag.draw(reliquatSansJoker);
    this.rack = rangerLeTirage(gardeJoker ? [...draw.rack, BLANK] : draw.rack);
    this.rackNotation = gardeJoker ? `${draw.notation}+${BLANK}` : draw.notation;
    this.bestScore = -1;
    this.canonicalTop = null;
    this.isotops = 0;
    this.tiers = [];
    this.posePrise = false;
    this.pretCourant = null;

    // LE TIRAGE PART TOUT DE SUITE, AVANT TOUTE ATTENTE.
    //
    // Il ne doit rien au top : il sort de la pioche, il est deja tire, et le
    // temps que le serveur passe a chercher la solution est du temps que les
    // joueurs peuvent passer a chercher la leur. Ce qu'ils ne peuvent pas
    // faire, c'est VALIDER -- pour departager il faut connaitre le top -- et
    // c'est la seule chose que `solving` retient.
    //
    // La regle avait ete perdue en installant les coups d'avance : le tirage
    // n'etait plus diffuse qu'apres l'attente du calcul deja lance, et sur une
    // grille ou le solveur ne suit pas la cadence -- une seconde par coup --
    // cela faisait une seconde et demie d'ecran vide a chaque coup.
    this.solving = true;
    this.emit();

    // LE COUP EST-IL DEJA PRET ? Voir SPEC.md §17.
    //
    // Le double a pioche et cherche ce coup-la pendant que le precedent se
    // jouait. On verifie que sa pioche est tombee sur le MEME tirage que la
    // vraie -- c'est la seule chose qui puisse les separer, et elle ne le
    // devrait jamais : les deux suivent la meme suite aleatoire. Si les deux
    // divergent quand meme, on jette l'avance et on calcule en direct : le
    // resultat est le bon, il arrive seulement plus tard.
    // UN CALCUL DEJA LANCE EST UN CALCUL QU'ON N'A PAS A REFAIRE. Quand la file
    // est vide et qu'un pas d'avance court, ce pas cherche precisement le coup
    // qu'on est en train de servir : l'attendre est plus court que de relancer
    // la meme recherche en parallele -- et cela evite surtout que les deux
    // posent le meme coup chacun de son cote sur la grille du solveur.
    const sansAttendre = this.avance.length > 0;
    if (this.avance.length === 0 && this.pasDAvance !== null) {
      await this.pasDAvance.catch(() => false);
    }
    const pret = this.avance.shift();
    if (pret !== undefined && pret.rack === this.rack && pret.n === this.moveNumber + 1) {
      this.canonicalTop = pret.top;
      this.bestScore = pret.bestScore;
      this.isotops = pret.isotops;
      this.tiers = pret.tiers;
      this.posePrise = true;
      this.pretCourant = pret;
      this.msDuTop = pret.ms;
      // « Pret » veut dire servi SANS LA MOINDRE ATTENTE. Un coup qu'il a fallu
      // attendre -- parce que le pas de calcul courait encore -- compte comme
      // un coup calcule en direct : c'est bien ce que les joueurs ont vu.
      if (sansAttendre) this.coupsPrets++;
      this.ouvrirLeDecompte();
      this.servir(pret.ms, true);
      return;
    }
    if (pret !== undefined) {
      this.renoncerALAvance(
        `le coup ${pret.n} prepare ne repond pas au coup ${this.moveNumber + 1} servi`,
      );
    }

    this.calculsDirects++;
    // LE DECOMPTE COURT PENDANT LE CALCUL. « 3, 2, 1 » n'est pas du repos : le
    // tirage y est deja tire mais tenu secret, et ces trois secondes sont
    // exactement celles qu'il faut au serveur pour trouver le top du premier
    // coup. Les depenser deux fois -- chercher, puis decompter -- retardait le
    // depart sans rien apporter a personne.
    this.ouvrirLeDecompte();
    this.emit();

    const id = this.nextId++;
    const reply: any = await new Promise((res) => {
      this.pending.set(id, res);
      // ON NE CALCULE QUE CE QU'ON GARDE.
      //
      // Le solveur en rendait quarante paliers a toutes les parties, y compris
      // a celles qui n'en ecrivaient aucun. Or l'elagage se resserre quand on
      // n'en demande pas : le seuil monte aussitot au meilleur score, et le
      // calcul du top y gagne jusqu'a un quart de son temps. Le top et ses
      // isotops, eux, ne bougent pas d'une virgule -- un isotop a par
      // definition le meilleur score, son ancrage n'est jamais saute.
      this.worker.postMessage({
        t: "solve", id, rack: this.rack, moveNumber: this.moveNumber + 1,
        tiers: this.paliersGardes,
      });
    });

    this.solving = false;
    if (reply.result === null) {
      // AUCUN COUP POSSIBLE avec ce tirage. On le rend au sac et on retire.
      //
      // Rendre est le point important : les lettres abandonnees restaient
      // dehors, et un sac de 102 n'en comptait plus que 99. Le reliquat aussi
      // repart, puisque le tirage entier est refait.
      //
      // Le compte est BORNE. La retraite etait recursive et sans fin : un sac
      // dont plus rien n'est jouable -- le cas du Y seul en 2 sur 3 -- faisait
      // tourner le serveur jusqu'a l'epuisement de la pile. Au-dela de
      // TIRAGES_INJOUABLES essais, on tient la partie pour terminee : ce n'est
      // pas une panne, c'est une fin de partie, et elle se dit comme telle.
      this.bag.rendre([...this.rack].filter((l) => l !== BLANK || !this.cfg.joker));
      this.reliquat = [];
      const plafond = tiragesInjouables(this.cfg.bornes);
      if (injouables + 1 >= plafond) {
        console.log(`[partie] terminee apres ${this.moves.length} coups ` +
          `(${plafond} tirages de suite sans un seul coup jouable)`);
        this.finie = true;
        this.rack = "";
        this.rackNotation = "";
        this.bestScore = -1;
        this.isotops = 0;
        this.tiers = [];
        this.viderLAvance();
        this.emit();
        return;
      }
      console.warn(`[partie] aucun coup possible avec ${this.rack}, on repioche ` +
        `(${injouables + 1}/${plafond})`);
      await this.deal(injouables + 1);
      return;
    }
    this.canonicalTop = reply.result.top;
    this.bestScore = reply.result.bestScore;
    this.isotops = reply.result.isotops;
    this.tiers = reply.result.tiers;
    this.msDuTop = reply.ms;
    this.servir(reply.ms, false);
  }

  /**
   * Le tirage part. C'est ici, et nulle part ailleurs, que le coup commence.
   *
   * `msCalcul` vaut zero pour un coup pris dans la file d'avance : il n'a rien
   * coute a ce moment-la, il etait deja pret.
   */
  private servir(msCalcul: number, avance: boolean): void {
    // Le top est connu : on peut de nouveau departager, donc valider.
    this.solving = false;
    // Ce qui reste du decompte, s'il court encore. Le tirage n'apparait qu'a
    // zero -- `rackPublic` le tait jusque-la -- et le coup ne s'ouvre qu'apres.
    //
    // On n'ATTEND PAS ici : `deal` est appele depuis le message d'un joueur, et
    // le faire patienter trois secondes bloquerait la reponse a tout le monde.
    const reste = this.decompteJusqua - Date.now();
    if (reste > 0) {
      // Le coup qu'on ouvrira dans trois secondes doit etre CELUI-CI. Rien ne
      // devrait le jouer entre-temps -- le tirage n'est pas public -- mais un
      // reveal en console suffirait, et la minuterie ouvrirait alors un coup
      // deja passe.
      const attendu = this.moveNumber;
      setTimeout(() => {
        if (this.moveNumber === attendu) this.ouvrirLeCoup(msCalcul, avance);
      }, reste);
      this.emit();
      return;
    }
    this.ouvrirLeCoup(msCalcul, avance);
  }

  /** Le tirage devient public, le chrono part, le coup commence. */
  private ouvrirLeCoup(msCalcul: number, avance: boolean): void {
    this.decompteJusqua = 0;
    // Le chrono du coup ne part qu'ICI : le temps de calcul du serveur ne doit
    // jamais etre compte dans le temps de recherche des joueurs (SPEC.md §2).
    //
    // Sauf a la reprise d'un serveur arrete : le coup avait alors commence
    // AVANT, et sur une grille sans chrono son age est ce qui compte. On
    // retrouve son heure au journal plutot que de la reinventer.
    const n = this.moveNumber + 1;
    const reprise = this.repriseCoup === n ? this.repriseServie : 0;
    this.repriseCoup = 0;
    this.repriseServie = 0;
    this.servedAt = reprise !== 0 ? reprise : Date.now();
    if (this.debutDeLaPartie === 0) this.debutDeLaPartie = this.servedAt;
    // Un chrono, lui, repart entier : reprendre une minuterie interrompue une
    // heure plus tot ferait expirer le coup a la seconde ou le serveur revient.
    this.armerLeChrono();
    // L'HEURE DU TIRAGE VA AU JOURNAL, et rien d'autre. Ni le tirage, ni le
    // top : le journal est relu par le serveur, mais il est aussi lisible par
    // l'hote, et un coup en cours ne doit se lire nulle part.
    this.append({ t: "servi", n, at: this.servedAt });
    // Le journal ne dit RIEN du top tant qu'il n'est pas joue : ni son score, ni
    // son mot, ni le nombre d'isotops. Ces valeurs ne partent deja jamais aux
    // clients, mais quelqu'un qui regarde le terminal de l'hote les lirait.
    // LE TEMPS DE CALCUL SE DIT TOUJOURS, meme quand le coup etait pret.
    //
    // « pret d'avance » disait quand le calcul avait eu lieu, pas ce qu'il avait
    // coute -- et c'est le cout qui interesse : c'est lui qui dit si la machine
    // suit. On garde donc les deux : le prix, et le fait qu'il ait ete paye
    // avant que quiconque attende.
    console.log(
      `[partie] coup ${n} · tirage ${this.rackNotation} · ` +
      `calcule en ${msCalcul.toFixed(0)} ms` + (avance ? " (d'avance)" : ""),
    );
    this.emit();
    // Et on prend de l'avance sur ce qui vient.
    this.avancerLaGrilleDuSolveur();
    void this.precalculer();
  }

  /**
   * Peut-on prendre de l'avance en ce moment ?
   *
   * Deux refus de principe :
   *
   * - **Salon vide.** Une partie endormie ne pioche pas ; elle n'a pas non plus
   *   a faire tourner un fil de calcul pour personne.
   * - **Partie non commencee ou finie.** Il n'y a pas de suite a preparer.
   *
   * LA PARTIE JOKER N'EST PAS EXCLUE. Le joker pose devient une vraie lettre
   * tiree du sac, mais cette lettre est connue des que le top l'est : le double
   * prend la meme decision sur SA copie du sac, et la note pour que la vraie
   * partie la rejoue a l'identique.
   */
  private peutPrendreDeLAvance(): boolean {
    if (this.arretee || this.avanceRenoncee) return false;
    if (!this.demarree || this.finie || !this.actif) return false;
    if (this.canonicalTop === null) return false;
    if (this.cfg.coupsMax !== null && this.posesSolveur >= this.cfg.coupsMax) return false;
    return true;
  }

  /**
   * CALCULE LES COUPS SUIVANTS PENDANT QUE CELUI-CI SE JOUE. Voir SPEC.md §17.
   *
   * Le principe tient a une propriete de la partie : en topping comme en
   * duplicate, LE COUP POSE EST TOUJOURS LE TOP. La suite de la partie ne
   * depend donc pas de ce que les joueurs trouveront -- elle est deja ecrite,
   * et on peut la calculer d'avance sans rien deviner.
   *
   * Le double avance en deux temps, coup par coup : on pose le top connu sur la
   * grille du solveur, on tire le tirage suivant dans la pioche copiee, et on
   * cherche son top. Ce qui en sort est range dans une file privee.
   *
   * Un seul calcul court a la fois. Le fil du solveur est unique et sert aussi
   * le rejeu : l'occuper de cinq demandes d'un coup ferait attendre un joueur
   * qui feuillette la feuille de route.
   */
  private async precalculer(): Promise<void> {
    if (this.avanceEnCours || this.sacAvance === null || !this.peutPrendreDeLAvance()) return;
    this.avanceEnCours = true;
    try {
      while (this.avance.length < COUPS_D_AVANCE && this.peutPrendreDeLAvance()) {
        // Le pas courant est expose : `deal` s'en sert pour ATTENDRE plutot que
        // de relancer en direct un calcul qui est deja en train de se faire.
        const pas = this.unCoupDAvance();
        this.pasDAvance = pas;
        const suite = await pas;
        this.pasDAvance = null;
        if (!suite) break;
      }
    } finally {
      this.avanceEnCours = false;
      this.pasDAvance = null;
    }
  }

  /**
   * Pose le top du coup COURANT sur la grille du solveur, et remet le double
   * de la pioche a hauteur.
   *
   * C'est le premier pas de l'avance : sans lui, le coup suivant se chercherait
   * sur la position d'avant. On le fait ici, TOUT DE SUITE apres avoir servi le
   * tirage, et non dans la boucle : `commit` lit `posePrise` pour savoir s'il
   * doit poser a son tour, et un joueur qui tape un mot deja trouve peut
   * arriver dans la milliseconde.
   *
   * Ne s'applique qu'au coup servi EN DIRECT -- un coup pris dans la file est
   * deja pose, et le double est deja plus loin.
   */
  private avancerLaGrilleDuSolveur(): void {
    if (this.posePrise || !this.peutPrendreDeLAvance()) return;
    const top = this.canonicalTop!;
    // LE RELIQUAT SE PREND AVANT LA SUBSTITUTION : c'est un joker qui a quitte
    // le tirage, meme si c'est un R qui se pose.
    const reliquatApres = Bag.remainder(this.rack, top.placements);
    // La copie du sac se prend ICI, avant que les jokers n'y touchent : la
    // vraie pioche n'en est pas plus loin, et les deux doivent partir ensemble.
    this.sacAvance = this.bag.cloner();
    this.jokersAvance = this.jokersEnReserve;
    // PARTIE JOKER : le double decide ce que devient chaque joker de CE coup,
    // comme il le fera pour les suivants. `commit` rejouera la decision sur le
    // vrai sac -- il ne peut plus la prendre lui-meme, puisque ce qui se pose
    // sur la grille du solveur doit deja etre la vraie lettre.
    const jokers = this.cfg.joker
      ? Game.deciderLesJokers(top.placements, this.sacAvance)
      : { sorties: [], restes: 0 };
    this.jokersAvance -= jokers.restes;
    this.pretCourant = {
      n: this.moveNumber + 1, rack: this.rack, notation: this.rackNotation, top,
      bestScore: this.bestScore, isotops: this.isotops, tiers: this.tiers,
      ms: this.msDuTop, reliquatApres,
      jokersSortis: jokers.sorties, jokersRestes: jokers.restes,
    };
    this.worker.postMessage({ t: "place", placements: top.placements });
    this.posesSolveur++;
    this.posePrise = true;
    // LE DOUBLE REPART DE LA VRAIE PIOCHE. On n'arrive ici que la file vide :
    // il n'a donc rien devine au-dela de ce coup-ci, et le recopier vaut mieux
    // que de tenir a jour un etat qui pourrait deriver.
    this.reliquatAvance = reliquatApres;
  }

  /**
   * Un coup d'avance : un tirage, un top, une entree dans la file.
   *
   * Rend faux quand il n'y a plus rien a preparer -- sac epuise, tirage
   * injouable a repetition, ou desaccord.
   */
  private async unCoupDAvance(): Promise<boolean> {
    const sac = this.sacAvance!;
    if (sac.estFinie(this.reliquatAvance)) return false;
    // L'INVARIANT DE L'AVANCE, en une ligne : la grille du solveur porte les
    // coups joues, plus le coup en cours, plus ceux qui attendent dans la file.
    // Tout le reste en decoule -- le numero du prochain calcul, et le fait que
    // `commit` ne doit pas reposer un coup deja pose.
    const attendu = this.moveNumber + (this.posePrise ? 1 : 0) + this.avance.length;
    if (this.posesSolveur !== attendu) {
      this.renoncerALAvance(
        `la grille du solveur porte ${this.posesSolveur} coups, ` +
        `l'avance en comptait ${attendu}`,
      );
      return false;
    }
    const n = this.posesSolveur + 1;

    // Le meme cycle qu'en direct : on tire, et si rien n'est jouable on rend
    // les caramels au sac et on recommence. Le plafond est celui de la partie.
    const plafond = tiragesInjouables(this.cfg.bornes);
    for (let essai = 0; essai < plafond; essai++) {
      // Le joker ne repasse pas par le sac, chez le double comme en direct.
      const gardeJoker = this.cfg.joker && this.jokersAvance > 0;
      const sansJoker = gardeJoker
        ? this.reliquatAvance.filter((c) => c !== BLANK)
        : this.reliquatAvance;
      const draw = sac.draw(sansJoker);
      const rack = rangerLeTirage(gardeJoker ? [...draw.rack, BLANK] : draw.rack);
      const notation = gardeJoker ? `${draw.notation}+${BLANK}` : draw.notation;
      const id = this.nextId++;
      const reply: any = await new Promise((res) => {
        this.pending.set(id, res);
        this.worker.postMessage({
          t: "avance", id, rack, moveNumber: n, tiers: this.paliersGardes,
        });
      });
      // Le solveur dit combien de coups sa grille porte. Un ecart voudrait dire
      // qu'on a calcule sur une autre position que celle qu'on croit : mieux
      // vaut le savoir bruyamment que servir un faux top.
      if (typeof reply.coupsPoses === "number" && reply.coupsPoses !== this.posesSolveur) {
        this.renoncerALAvance(
          `le solveur porte ${reply.coupsPoses} coups, ` +
          `la partie en attendait ${this.posesSolveur}`,
        );
        return false;
      }
      // Une partie qu'on arrete denoue ses demandes en attente : ce qui revient
      // ici n'est pas une reponse du solveur, et il n'y a plus rien a preparer.
      if (this.arretee) return false;
      if (reply.result === null) {
        sac.rendre([...draw.rack]);
        this.reliquatAvance = [];
        continue;
      }
      const top = reply.result.top as Move;
      // LE RELIQUAT SE PREND AVANT LA SUBSTITUTION, comme en direct : c'est
      // bien un joker qui a quitte le tirage, meme si c'est un R qui s'est
      // pose. L'ordre compte, et l'inverser jetterait une exception.
      const reliquatApres = Bag.remainder(rack, top.placements);
      // PARTIE JOKER : le double decide ici ce que devient chaque joker, sur SA
      // copie du sac. La vraie partie rejouera la meme decision au moment de
      // poser le coup, sans redemander au sac ce qu'il contient.
      const jokers = this.cfg.joker
        ? Game.deciderLesJokers(top.placements, sac)
        : { sorties: [], restes: 0 };
      this.jokersAvance -= jokers.restes;
      // La pose vient APRES la substitution : ce qui va sur la grille du
      // solveur doit etre ce qui ira sur celle de la partie -- un vrai R, et
      // non un joker qui vaudra zero pour toujours.
      this.worker.postMessage({ t: "place", placements: top.placements });
      this.posesSolveur++;
      this.avance.push({
        n, rack, notation, top,
        bestScore: reply.result.bestScore,
        isotops: reply.result.isotops,
        tiers: reply.result.tiers,
        ms: reply.ms,
        reliquatApres,
        jokersSortis: jokers.sorties,
        jokersRestes: jokers.restes,
      });
      this.reliquatAvance = reliquatApres;
      return true;
    }
    return false;
  }

  /**
   * On renonce a l'avance, et on remet le solveur d'aplomb.
   *
   * Ne devrait jamais arriver : le double suit la meme suite aleatoire que la
   * partie, et le coup pose est toujours le top. Mais si les deux divergeaient,
   * la grille du solveur porterait des coups qui ne seront jamais joues, et
   * TOUS les tops suivants seraient faux. On la refait donc a partir des coups
   * reellement joues -- c'est long sur une grande grille, et c'est le prix a
   * payer une fois plutot que de fausser une partie.
   */
  private renoncerALAvance(raison: string): void {
    console.error(`[avance] ${raison} -- on refait la grille du solveur`);
    this.avance = [];
    this.sacAvance = null;
    this.avanceRenoncee = true;
    this.posePrise = false;
    for (const [, done] of this.pending) done({ result: null, ms: 0 });
    this.pending.clear();
    void this.worker.terminate();
    this.demarrerLeSolveur();
    for (const m of this.moves) {
      this.worker.postMessage({ t: "place", placements: m.placements });
    }
    this.posesSolveur = this.moves.length;
  }

  /** Range la file : ses coups ne seront jamais servis. */
  private viderLAvance(): void {
    this.avance = [];
    this.sacAvance = null;
  }

  get moveNumber(): number { return this.moves.length; }
  get cumul(): number { return this.moves.reduce((a, m) => a + m.score, 0); }
  /**
   * Temps de jeu accumule : la somme des coups joues.
   *
   * Ce que le serveur passe a CHERCHER le top n'y entre pas. Ce temps-la
   * n'appartient a personne : ni au coup qui vient de tomber, ni a celui qui
   * n'a pas encore commence. L'ecran fige donc son compteur pendant le calcul
   * et le reprend quand le coup part -- et le total vaut exactement la somme
   * des coups plus le coup en cours.
   */
  get tempsJoue(): number { return this.moves.reduce((a, m) => a + Math.max(0, m.ms), 0); }

  /**
   * Ce qui reste dans le sac, lettres triees. Information PUBLIQUE et attendue :
   * au duplicate on suit les lettres restantes pour deviner les tirages a venir.
   * Vide sur une pioche ponderee, ou rien ne s'epuise.
   */
  restantDuSac(): string {
    const r = this.bag.restant();
    let out = "";
    // Les jokers a la FIN : ils ne sont pas des lettres, les voir en tete de
    // ligne brouille la lecture du reliquat.
    for (const lettre of Object.keys(r).sort()) {
      if (lettre !== BLANK) out += lettre.repeat(r[lettre]!);
    }
    if (r[BLANK] !== undefined) out += BLANK.repeat(r[BLANK]);
    return out;
  }

  tiles(): { x: number; y: number; l: string; b: 0 | 1; n: number }[] {
    const out: { x: number; y: number; l: string; b: 0 | 1; n: number }[] = [];
    for (const m of this.moves) {
      for (const p of m.placements) out.push({ x: p.x, y: p.y, l: p.letter, b: p.blank ? 1 : 0, n: m.n });
    }
    return out;
  }

  /** Un joueur propose un mot. Le serveur fait autorite. */
  async attempt(player: string, dir: Dir, x: number, y: number, typed: string): Promise<TryResult> {
    if (this.solving || this.canonicalTop === null) {
      return { ok: false, message: "le coup n'est pas encore prêt" };
    }
    const r = resolveTypedWord(this.board, this.dawg, dir, x, y, typed.toUpperCase(), this.rack);
    if (!r.ok) {
      // Le rappel de la variante vaut mieux qu'un « trop de caramels » sec :
      // le joueur ne sait pas forcement combien il a le droit d'en poser.
      const message = r.error === "TROP_DE_CARAMELS"
        ? `C'est une partie ${this.cfg.jouables} sur ${this.cfg.tirage}`
        : PLAY_MESSAGE[r.error as PlayError];
      return { ok: false, message, word: r.word };
    }
    // EN DUPLICATE, rien ne filtre. On enregistre la meilleure solution du
    // joueur et on lui rend son score, sans jamais dire s'il a trouve le top :
    // le savoir lui apprendrait que sa solution est la bonne, et l'apprendrait
    // aux autres par ricochet. Le coup dure le temps plein (SPEC.md §16).
    if (this.cfg.mode === "duplicate") {
      const avant = this.propositions.get(player);
      if (avant === undefined || r.move.score > avant.score) {
        this.propositions.set(player, {
          score: r.move.score, word: r.move.word,
          dir: r.move.dir, x: r.move.x, y: r.move.y, at: Date.now(),
        });
      }
      const garde = this.propositions.get(player)!;
      return {
        ok: true, message: "", word: r.move.word, score: r.move.score,
        top: false, retenu: garde.score,
      };
    }

    // On retient la meilleure proposition de chacun, meme en topping : c'est
    // elle qui decide du demi-point si personne n'atteint le top.
    const avant = this.propositions.get(player);
    if (avant === undefined || r.move.score > avant.score) {
      this.propositions.set(player, {
        score: r.move.score, word: r.move.word,
        dir: r.move.dir, x: r.move.x, y: r.move.y, at: Date.now(),
      });
    }

    if (r.move.score < this.bestScore) {
      return { ok: true, message: "", word: r.move.word, score: r.move.score, top: false };
    }
    // Score du top atteint : ce joueur remporte le coup. C'est le premier
    // message ARRIVE AU SERVEUR qui gagne -- ici, l'ordre de traitement.
    await this.commit(player, Date.now() - this.servedAt, r.move);
    return { ok: true, message: "top !", word: r.move.word, score: r.move.score, top: true };
  }

  /**
   * Duree d'un coup clos par l'ECHEANCE, et non par un joueur.
   *
   * `setTimeout` promet de ne pas se declencher AVANT le delai, jamais de se
   * declencher exactement dessus : la boucle d'evenements finit ce qu'elle
   * faisait, et rend la main quelques millisecondes plus tard. Mesurer
   * `Date.now() - servedAt` donnait donc 5,00 s le plus souvent, mais 5,01 s
   * quand le reveil avait tarde -- alors que la regle du jeu, elle, dit cinq
   * secondes tout rond.
   *
   * On note donc le temps IMPARTI, qui est la verite du coup.
   */
  private dureeDuCoup(): number {
    return this.cfg.chrono !== null ? this.cfg.chrono * 1000 : Date.now() - this.servedAt;
  }

  /**
   * TOPPING chronometre : l'echeance tombe sans que personne ait trouve.
   *
   * Le top se pose quand meme, et un DEMI-POINT va au joueur qui avait propose
   * la solution la plus rentable — a egalite de score, le plus rapide a l'avoir
   * soumise. Personne n'a « trouve le coup », mais chercher a rapporte.
   */
  private async cloreParDefaut(): Promise<void> {
    if (this.canonicalTop === null) return;
    // Le coup a dure le temps IMPARTI, pas le temps que la minuterie a mis a
    // se reveiller. Voir dureeDuCoup().
    let meilleur: { joueur: string; word: string; score: number; at: number } | null = null;
    for (const [joueur, p] of this.propositions) {
      if (meilleur === null || p.score > meilleur.score
          || (p.score === meilleur.score && p.at < meilleur.at)) {
        meilleur = { joueur, word: p.word, score: p.score, at: p.at };
      }
    }
    await this.commit(null, this.dureeDuCoup(), undefined, undefined,
      meilleur === null ? undefined
        : { joueur: meilleur.joueur, word: meilleur.word, score: meilleur.score });
  }

  /**
   * DUPLICATE : l'echeance tombe, on clot le coup.
   *
   * Le top se pose, chacun marque sa meilleure solution, et ceux qui l'ont
   * trouve sont annonces dans le chat. Personne ne « remporte » le coup : au
   * duplicate on compte des points, pas des coups.
   *
   * Seuls sont notes les joueurs presents AU MOMENT DU TIRAGE. Qui arrive en
   * cours de coup joue, figure dans la liste des trouveurs s'il trouve, mais
   * n'entre au classement qu'au coup suivant.
   */
  private async clore(): Promise<void> {
    if (this.canonicalTop === null) return;
    const scores: Record<string, number> = {};
    const trouveurs: string[] = [];
    for (const [nom, p] of this.propositions) {
      if (p.score >= this.bestScore) trouveurs.push(nom);
      if (this.participants.has(nom)) scores[nom] = p.score;
    }
    // Present au tirage mais rien propose : zero, et le negatif du top entier.
    for (const nom of this.participants) if (scores[nom] === undefined) scores[nom] = 0;
    // Les plus rapides d'abord, c'est ainsi qu'on lit la liste.
    trouveurs.sort((a, b) =>
      (this.propositions.get(a)?.at ?? 0) - (this.propositions.get(b)?.at ?? 0));

    const n = this.moveNumber + 1;
    await this.commit(null, this.dureeDuCoup(), undefined, { scores, trouveurs });
    // Pas de points dans le chat : ils figurent deja au tableau, au journal des
    // coups et sur la grille. Les repeter ici n'ajoute que du bruit.
    this.say("", trouveurs.length === 0
      ? `Coup ${n} : non trouvé`
      : `Coup ${n} : trouvé par ${trouveurs.join(", ")}`);
  }

  /** Pose le top canonique et passe au coup suivant. */
  private async commit(
    player: string | null, ms: number, played?: Move,
    duplicate?: { scores: Record<string, number>; trouveurs: string[] },
    demiPoint?: { joueur: string; word: string; score: number },
  ): Promise<void> {
    const propositions: PlayedMove["propositions"] = {};
    for (const [nom, p] of this.propositions) {
      propositions[nom] = { word: p.word, dir: p.dir, x: p.x, y: p.y, score: p.score };
    }
    // Celui qui remporte le coup en topping n'est pas toujours passe par une
    // proposition enregistree : on l'ajoute depuis le mot qu'il a tape.
    if (player !== null && played !== undefined) {
      propositions[player] = {
        word: played.word, dir: played.dir, x: played.x, y: played.y, score: played.score,
      };
    }
    const top = this.canonicalTop!;
    const move: PlayedMove = {
      n: this.moveNumber + 1,
      rack: this.rack,
      notation: this.rackNotation,
      word: top.word,
      dir: top.dir,
      x: top.x,
      y: top.y,
      score: top.score,
      placements: top.placements,
      player,
      // Ce que le joueur a tape peut differer du mot retenu : le logiciel choisit
      // son isotop canonique, pas celui du joueur (SPEC.md §5).
      playerWord: played?.word,
      playerDir: played?.dir,
      playerX: played?.x,
      playerY: played?.y,
      ms,
      isotops: this.isotops,
      // LE JOURNAL NE PORTE QUE LE PALIER DU TOP -- le top et ses isotops.
      //
      // Soixante et un octets, la ou les quarante paliers en pesaient 2 694 :
      // ils faisaient 86 % du poids du fichier. Et ce sont les seuls qu'on ne
      // saurait pas refaire a bon compte -- dix-sept secondes au
      // vingt-sept-millieme coup d'une grille sans fin, en supposant que le
      // lexique n'ait pas bouge depuis, ce qui n'est vrai que jusqu'au jour ou
      // il bouge. Sur un plateau borne, meme cela ne s'ecrit pas : la position
      // s'y refait en dix-neuf millisecondes.
      //
      // Les sous-tops vont dans l'annexe, juste apres, quand la partie en garde.
      ...(this.cfg.bornes === null && this.tiers.length > 0
        ? { tiers: [this.tiers[0]!] } : {}),
      ...(Object.keys(propositions).length > 0 ? { propositions } : {}),
      ...(duplicate ?? {}),
      ...(demiPoint ? { demiPoint } : {}),
    };
    // La trace des jokers est posee APRES la substitution, plus bas : c'est
    // elle qui la produit. L'objet `move` n'est ecrit au journal qu'ensuite.

    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    this.moves.push(move);
    if (player !== null) this.players[player] = (this.players[player] ?? 0) + 1;
    // Un demi-point vaut la moitie d'un coup trouve : chercher sans atteindre
    // le top rapporte quand meme quelque chose.
    if (demiPoint !== undefined) {
      this.players[demiPoint.joueur] = (this.players[demiPoint.joueur] ?? 0) + 0.5;
    }
    // Le reliquat se calcule sur le tirage TEL QU'IL A ETE DISTRIBUE, avant
    // toute substitution de joker : c'est bien un joker qui a quitte le tirage.
    //
    // Quand le coup vient de l'avance, tout cela est DEJA FAIT : le double a
    // pris le reliquat et decide des jokers avant de poser le coup sur la
    // grille du solveur. On ne refait donc pas le calcul -- les placements sont
    // deja resolus, et `Bag.remainder` y chercherait un R la ou le tirage
    // n'avait qu'un joker -- on rejoue seulement la decision sur le vrai sac.
    const prepare = this.pretCourant;
    if (prepare !== null) {
      this.reliquat = prepare.reliquatApres;
      if (this.cfg.joker) {
        this.rejouerLesJokers(prepare);
        move.jokers = { sortis: prepare.jokersSortis, restes: prepare.jokersRestes };
      }
    } else {
      this.reliquat = Bag.remainder(this.rack, top.placements);
      if (this.cfg.joker) move.jokers = this.substituerJokers(top.placements);
    }
    this.board.place(top.placements);
    // Un coup pris dans la file d'avance est DEJA pose chez le solveur : c'est
    // en le posant qu'il a pu chercher le suivant. Le reposer le compterait
    // deux fois, et la grille du solveur ne serait plus celle de la partie.
    if (!this.posePrise) {
      this.worker.postMessage({ t: "place", placements: top.placements });
      this.posesSolveur++;
    }
    // Le journal d'abord, force sur le disque : a partir d'ici le coup existe,
    // meme si la machine s'eteint dans la seconde.
    // Le journal recoit le coup ENTIER, paliers compris : c'est lui qui fait foi
    // et qui les conservera. La copie qu'on garde en memoire s'en defait
    // aussitot -- elle n'en a pas l'usage, et on sait ou les retrouver.
    const ou = this.append({ t: "coup", move: Game.pourLeJournal(move) });
    this.ouEstLeCoup.set(move.n, ou);
    // Les sous-tops vont a part : un fichier qu'on peut effacer, une fois la
    // partie finie et analysee, sans toucher au journal ni a ses adresses.
    //
    // ET PAS AU-DELA DE MILLE COUPS. Une partie bornee a cinq mille minutes en
    // joue trois cent mille si le chrono est d'une seconde : la borne du
    // reglage ne borne pas le volume, celle-ci si.
    if (this.paliersGardes > 0 && this.tiers.length > 1
        && move.n <= PALIERS_JUSQU_A_COUPS) {
      this.ouEstLePalier.set(move.n, this.appendPaliers(move.n, this.tiers));
    }
    delete move.tiers;
    this.save();
    for (const f of this.surCoup) f(move);
    // Ici le coup est joue : tout est devenu public, on peut l'ecrire.
    console.log(
      `[partie] coup ${move.n} remporte par ${player ?? "personne"} : ` +
      `${move.word} ${noteCoup(move.dir, move.x, move.y, this.cfg.bornes)} ${move.score} pts ` +
      `en ${(ms / 1000).toFixed(1)} s` +
      (move.isotops > 1 ? ` (${move.isotops} isotops)` : ""),
    );
    await this.deal();
  }

  /**
   * Le « 3, 2, 1, partez » d'avant-partie, s'il est demande.
   *
   * Il n'arrive qu'UNE fois, au tout premier tirage -- ce n'est pas une pause
   * avant chaque coup. C'est pourquoi il part d'ici, du premier tirage servi,
   * et non de l'armement du chrono : demander a chaque coup « faut-il
   * decompter ? » pour repondre non quatre-vingt-dix-neuf fois sur cent etait
   * une facon detournee de dire une chose qui ne se produit qu'au debut.
   *
   * IL COURT PENDANT LE CALCUL DU PREMIER TOP, et c'est tout son interet. Le
   * tirage est deja tire, mais `rackPublic` le tait tant que le decompte n'est
   * pas fini : les joueurs voient « 3, 2, 1 » exactement pendant que le serveur
   * cherche. Lance apres le calcul, comme il l'etait, il ajoutait trois
   * secondes d'attente a une attente.
   *
   * Rend vrai s'il court -- qu'il vienne d'etre ouvert ou qu'il coure deja,
   * ce qui arrive quand un tirage injouable fait repiocher.
   */
  private ouvrirLeDecompte(): boolean {
    if (this.decompteJusqua > Date.now()) return true;
    if (!this.cfg.decompte || this.moves.length > 0 || !this.actif || this.finie) return false;
    this.decompteJusqua = Date.now() + DECOMPTE_MS;
    return true;
  }

  /**
   * Lance la minuterie du coup courant. Sans personne dans le salon, il n'y a
   * rien a chronometrer : le coup attend.
   */
  private armerLeChrono(): void {
    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    if (!this.actif || this.finie) return;

    if (this.cfg.chrono === null) return;
    this.servedAt = Date.now();
    this.echeance = setTimeout(() => {
      this.echeance = null;
      void (this.cfg.mode === "duplicate" ? this.clore() : this.cloreParDefaut());
    }, this.cfg.chrono * 1000);
  }

  /**
   * Quelqu'un entre. On pioche si ce n'est pas encore fait, et le chrono part.
   *
   * Le premier arrivant recoit le temps PLEIN : reprendre un decompte entame
   * pendant que la salle etait vide n'aurait aucun sens.
   */
  async reveiller(): Promise<void> {
    if (this.actif) return;
    this.actif = true;
    if (this.finie || !this.demarree) { this.emit(); return; }
    if (this.canonicalTop === null && !this.solving) {
      await this.deal();
      return;
    }
    this.armerLeChrono();
    this.emit();
    // Le salon s'etait vide au milieu d'une avance : elle a pu s'arreter avant
    // d'avoir ses cinq coups. On la reprend la ou elle en etait.
    void this.precalculer();
  }

  /**
   * Ouvre le compte a rebours du lancement.
   *
   * Rend faux si la partie est deja lancee, deja partie, ou finie -- il n'y a
   * alors rien a lancer.
   */
  lancer(secondes: number): boolean {
    if (this.demarree || this.finie) return false;
    if (this.lancementA > Date.now()) return false;
    this.lancementA = Date.now() + Math.max(1, Math.round(secondes)) * 1000;
    this.emit();
    setTimeout(() => {
      this.lancementA = 0;
      void this.demarrer();
    }, Math.max(1, Math.round(secondes)) * 1000);
    return true;
  }

  /** Lance la partie : premier tirage, et le chrono si la variante en a un. */
  async demarrer(): Promise<void> {
    if (this.demarree) return;
    this.demarree = true;
    if (this.actif && !this.finie && this.canonicalTop === null && !this.solving) {
      await this.deal();
    } else this.emit();
  }

  /** La salle s'est vidée : le coup en cours gele, rien ne se calcule plus. */
  endormir(): void {
    this.actif = false;
    if (this.echeance !== null) { clearTimeout(this.echeance); this.echeance = null; }
    this.emit();
  }

  /** Ajoute un message au chat et le persiste. */
  say(who: string, text: string, cell?: { x: number; y: number }): ChatMessage {
    const msg: ChatMessage = { at: Date.now(), who, text: text.slice(0, 400), ...(cell ? { cell } : {}) };
    this.chat.push(msg);
    this.append({ t: "chat", msg });
    this.save();
    for (const f of this.surChat) f(msg);
    return msg;
  }

/**
   * Partie joker : la lettre jouee par le joker devient une VRAIE lettre.
   *
   * Le joker a compte zero pour le coup qui vient d'etre joue -- c'est deja
   * fait, le score est calcule. Mais ce qui se pose sur la grille est un vrai R
   * sorti du sac, qui vaudra un point pour tous les coups suivants, et le joker
   * revient au tirage.
   *
   * Si le sac n'a plus de R, le joker se pose lui-meme, a zero pour toujours,
   * et la reserve perd une unite. Les deux jokers poses, la partie continue
   * sans (SPEC.md §16).
   */
  private substituerJokers(
    placements: Placement[],
  ): { sortis: string[]; restes: number } {
    const d = Game.deciderLesJokers(placements, this.bag);
    this.appliquerLesJokers(d, Game.preleveLesLettres(this.bag));
    return { sortis: d.sorties, restes: d.restes };
  }

  /**
   * QUI DECIDE, ET SUR QUEL SAC. Le coeur de la substitution, isole pour
   * pouvoir etre joue sur le double comme sur la vraie pioche.
   *
   * Les placements sont modifies sur place : un joker devenu vraie lettre perd
   * son drapeau. Ce qui est rendu suffit a REJOUER la meme decision ailleurs --
   * c'est ce qui permet au double de choisir a l'avance et a la partie de le
   * suivre exactement, sans redemander au sac ce qu'il contient.
   */
  private static deciderLesJokers(
    placements: Placement[], pioche: Pioche,
  ): { sorties: string[]; restes: number } {
    const sac = pioche as SacFini;
    const sorties: string[] = [];
    let restes = 0;
    for (const p of placements) {
      if (!p.blank) continue;
      // SUR UNE PIOCHE QUI NE S'EPUISE PAS, LA LETTRE NAIT.
      //
      // Un sac qui se recharge et des probabilites ponderees n'ont pas de stock
      // a defendre. Prelever le R du joker n'y avancait que la date du prochain
      // rechargement ; pire, sur des probabilites il n'y avait rien a prelever
      // et le joker restait joker a tous les coups. Il devient donc la lettre
      // sans rien prendre a personne, et revient au tirage suivant.
      if (!Game.preleveLesLettres(pioche)) {
        p.blank = false;
        sorties.push(p.letter);
        continue;
      }
      // Sac fini : la lettre jouee par le joker en sort pour de vrai. Elle
      // vaudra ses points pour la suite, et le joker revient au tirage.
      if (sac.retirer(p.letter)) {
        p.blank = false;
        sorties.push(p.letter);
        continue;
      }
      // Plus de lettre disponible : le joker se pose lui-meme, a zero pour
      // toujours, et la reserve perd une unite (SPEC.md §16).
      restes++;
    }
    return { sorties, restes };
  }

  /**
   * Cette pioche a-t-elle un stock a defendre ?
   *
   * Un sac fini seul en a un : ce qui en sort n'y revient plus, et le jeu n'a
   * qu'un W. Un sac qui boucle retrouve sa composition d'origine des qu'il
   * s'appauvrit, et des probabilites ponderees n'ont jamais rien eu a retirer.
   */
  private static preleveLesLettres(pioche: Pioche): boolean {
    const sac = pioche as SacFini;
    return typeof sac.retirer === "function" && sac.recharge !== true;
  }

  /**
   * Le coup tel qu'il part au journal : SANS SES PLACEMENTS.
   *
   * Ils ne disent rien que le mot, son sens et sa case ne disent deja. On
   * parcourt les cases du mot, celles qui etaient vides sont celles qu'il a
   * posees -- verifie sur les 31 196 coups des parties enregistrees, sans un
   * ecart. Ils pesaient 232 octets par coup, soit pres de la moitie de ce qui
   * reste une fois les sous-tops partis a l'annexe.
   *
   * Seuls les jokers ne se devinent pas : leur rang est ecrit a part.
   */
  private static pourLeJournal(move: PlayedMove): Record<string, unknown> {
    const { placements, ...reste } = move;
    const blancs: number[] = [];
    placements.forEach((p, i) => { if (p.blank) blancs.push(i); });
    return blancs.length > 0 ? { ...reste, blancs } : reste;
  }

  /**
   * Les placements d'un coup, refaits a partir du mot et de la grille.
   *
   * LA GRILLE DOIT ETRE DANS L'ETAT D'AVANT CE COUP : c'est elle qui dit
   * quelles cases du mot etaient vides, donc lesquelles il a posees. On
   * l'appelle donc au fil du rejeu, coup apres coup, jamais apres coup.
   */
  private refairePlacements(m: PlayedMove): Placement[] {
    const dx = m.dir === "H" ? 1 : 0;
    const dy = m.dir === "H" ? 0 : 1;
    const blancs = m.blancs ?? [];
    const out: Placement[] = [];
    for (let k = 0; k < m.word.length; k++) {
      const x = m.x + dx * k, y = m.y + dy * k;
      if (this.board.occupied(x, y)) continue;
      out.push({ x, y, letter: m.word[k]!, blank: blancs.includes(out.length) });
    }
    return out;
  }

  /** Rejoue une decision de joker sur la VRAIE partie : reserve et journal. */
  private appliquerLesJokers(
    d: { sorties: string[]; restes: number }, avecSac: boolean,
  ): void {
    for (const l of d.sorties) {
      console.log(`[partie] le joker joue ${l} : un vrai ${l} sort du sac`);
    }
    for (let i = 0; i < d.restes; i++) {
      this.jokersEnReserve--;
      const reste = this.jokersEnReserve === Infinity ? "on en reprend un"
        : `${this.jokersEnReserve} joker${this.jokersEnReserve > 1 ? "s" : ""} en reserve`;
      console.log(
        `[partie] ${avecSac ? "plus de lettre libre dans le sac : " : ""}` +
        `le joker reste sur la grille (${reste})`,
      );
    }
  }

  /**
   * La meme substitution, mais rejouee sur le VRAI sac a partir d'une decision
   * deja prise par le double. Les placements sont deja resolus ; il ne reste
   * qu'a faire sortir du sac les lettres qui en sont sorties chez le double.
   */
  private rejouerLesJokers(pret: CoupPret): void {
    const sac = this.bag as SacFini;
    const preleve = Game.preleveLesLettres(this.bag);
    for (const l of pret.jokersSortis) {
      if (preleve && !sac.retirer(l)) {
        this.renoncerALAvance(`le sac n'avait plus le ${l} promis par l'avance`);
        return;
      }
    }
    this.appliquerLesJokers(
      { sorties: pret.jokersSortis, restes: pret.jokersRestes }, preleve,
    );
  }

  /** Revele le top sans vainqueur. Commodite de test en solo. */
  /**
   * Les paliers d'un coup deja joue, recalcules si le journal ne les a pas.
   *
   * C'est le cas des plateaux bornes, ou on ne les enregistre plus. La grille
   * se reconstruit a partir des coups qui precedent, ce qui est immediat sur un
   * plateau de quinze cases de cote.
   */
  async paliersDuCoup(n: number): Promise<Tier[]> {
    const m = this.moves.find((q) => q.n === n);
    if (m === undefined) return [];
    if (m.tiers !== undefined && m.tiers.length > 0) return m.tiers;

    // ON NE RECALCULE PAS DEUX FOIS LE MEME COUP.
    //
    // Sur un plateau borne, les paliers ne sont pas enregistres -- on les
    // refait a la demande, et un coup a deux jokers demande plusieurs secondes.
    // Or on navigue dans le rejeu : coup 7, coup 8, retour au 7. Sans memoire,
    // le retour coutait aussi cher que la premiere visite, pour un resultat
    // identique au caramel pres -- la position d'avant le coup et le tirage ne
    // changent plus, la partie est jouee.
    //
    // La reponse repasse en queue a chaque visite : c'est le plus ANCIENNEMENT
    // CONSULTE qu'on jette, pas le plus anciennement calcule. Qui fait des
    // allers-retours entre deux coups ne doit pas voir l'un des deux s'effacer
    // a chaque passage.
    const garde = this.paliersRefaits.get(n);
    if (garde !== undefined) {
      this.paliersRefaits.delete(n);
      this.paliersRefaits.set(n, garde);
      return garde;
    }

    // L'ANNEXE D'ABORD : c'est elle qui porte les sous-tops, a l'octet ou ils
    // ont ete ecrits. Une lecture d'un millieme de seconde.
    const ouAnnexe = this.ouEstLePalier.get(n);
    if (ouAnnexe !== undefined) {
      const paliers = (this.ligneDuJournal(ouAnnexe, this.annexe)?.["tiers"] ?? []) as Tier[];
      if (paliers.length > 0) return this.retenir(n, paliers);
    }

    // PUIS LE JOURNAL. Il porte le palier du top, et les quarante paliers des
    // parties d'avant le reglage.
    //
    // Quand il n'a que le palier du top, les sous-tops manquent -- et les
    // refaire demande des secondes sur une grille sans fin, SUR LE FIL QUI
    // CHERCHE LE TOP DU COUP EN COURS. Tant que la partie se joue, on rend donc
    // ce qu'on a plutot que de faire attendre la table entiere. Une partie
    // finie, elle, ne fait plus attendre personne : l'analyse peut s'y refaire.
    const ou = this.ouEstLeCoup.get(n);
    if (ou !== undefined) {
      const paliers = (this.ligneDuJournal(ou)?.["move"]?.tiers ?? []) as Tier[];
      if (paliers.length > 1 || (paliers.length > 0 && !this.finie)) {
        return this.retenir(n, paliers);
      }
    }
    const avant: Placement[] = [];
    for (const q of this.moves) {
      if (q.n >= n) break;
      avant.push(...q.placements);
    }
    const id = this.nextId++;
    const reply: any = await new Promise((res) => {
      this.pending.set(id, res);
      this.worker.postMessage({ t: "paliers", id, rack: m.rack, avant });
    });
    return this.retenir(n, (reply.tiers ?? []) as Tier[]);
  }

  /** Garde une reponse pour la prochaine visite, et fait la place qu'il faut. */
  private retenir(n: number, paliers: Tier[]): Tier[] {
    this.paliersRefaits.set(n, paliers);
    this.oublierLesPlusVieux(n);
    return paliers;
  }

  /**
   * On jette les paliers les plus anciennement CONSULTES jusqu'a repasser sous
   * le plafond. Jamais le dernier arrive : sans quoi un seul coup enorme
   * viderait la memoire et ne s'y garderait meme pas.
   */
  private oublierLesPlusVieux(garder: number): void {
    let total = 0;
    for (const v of this.paliersRefaits.values()) for (const p of v) total += p.moves.length;
    for (const [cle, v] of this.paliersRefaits) {
      if (total <= PALIERS_EN_MEMOIRE || cle === garder) break;
      for (const p of v) total -= p.moves.length;
      this.paliersRefaits.delete(cle);
    }
  }

  async reveal(): Promise<void> {
    if (this.solving || this.canonicalTop === null) return;
    await this.commit(null, Date.now() - this.servedAt);
  }

  private save(force = false): void {
    // L'INSTANTANE EST UNE VUE DERIVEE, PAS LA SAUVEGARDE.
    //
    // Le journal vient d'etre ecrit et force sur le disque : le coup existe
    // deja, meme si la machine s'eteint dans la seconde. Reecrire par-dessus
    // onze megaoctets a chaque coup ne le rendait pas plus sur -- cela gelait
    // le fil principal pres d'une seconde par coup sur une grande partie, et
    // ecrivait cent cinquante-cinq gigaoctets au fil d'une partie qui n'en
    // conserve quatre-vingts. Il est donc reecrit tous les vingt coups, et une
    // derniere fois a l'arret.
    //
    // Sans journal -- parties d'avant son existence -- il reste la seule
    // source : on l'ecrit alors a chaque fois, comme avant.
    const avecJournal = existsSync(this.journal);
    if (!force && avecJournal && this.moves.length % INSTANTANE_TOUS_LES !== 0) return;
    mkdirSync(DATA_DIR, { recursive: true });
    // Filet de secours DES PARTIES SANS JOURNAL. Pour elles l'instantane est
    // tout ce qu'il y a, et une copie a cote a un sens. Partout ailleurs elle
    // sauvegardait un fichier jetable -- l'instantane se refait a partir du
    // journal -- pendant que le seul fichier irremplacable, lui, n'etait copie
    // nulle part. Ce qu'il faut copier, c'est le journal, et hors de la machine.
    if (!avecJournal && this.moves.length > 0
        && this.moves.length % 20 === 0 && existsSync(this.file)) {
      try {
        copyFileSync(this.file, this.file.replace(/\.json$/, ".secours.json"));
      } catch {
        // Un secours qui echoue ne doit pas empecher la sauvegarde principale.
      }
    }
    const data: Saved = {
      gameId: this.gameId, layout: this.layout, seed: this.seed,
      config: serialiser(this.cfg),
      createdAt: this.createdAt,
      moves: this.moves, players: this.players, chat: this.chat,
    };
    // Ecriture atomique : une coupure de courant ne doit pas laisser un fichier
    // a moitie ecrit, qui rendrait la partie irrecuperable.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, this.file);
  }
}
