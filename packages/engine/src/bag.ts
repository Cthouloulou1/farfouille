/**
 * Pioche pondereee. Voir SPEC.md §4.
 *
 * Il n'y a PAS de sac : chaque lettre est tiree independamment selon un poids,
 * corrige par un mecanisme anti-secheresse.
 *
 *     c(L) = w(L) x min(1 + alpha * k(L), plafond)
 *
 * ou k(L) est le nombre de tirages depuis la derniere sortie de L. Le plafond
 * est indispensable : sans lui une lettre jamais tiree finit par depasser le E.
 *
 * Les poids sont CALIBRES : volontairement plus bas que la frequence visee,
 * parce que la compensation reevalue les lettres rares. Sans cette calibration
 * le W ressuscite (1 tirage sur 158 au lieu de 1 sur 270).
 */
import { BLANK, isConsonant, isVowel } from "./alphabet.ts";
import { mulberryDepuis, type Alea } from "./rng.ts";

export const RACK_SIZE = 7;

/** Poids calibres, cible = frequences ODS9 sur les mots de 2 a 9 lettres. */
export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = {
  E: 22.300, A: 13.748, R: 10.212, I: 10.104, S: 9.215, T: 8.480, N: 7.379,
  O: 5.746, L: 4.450, U: 4.014, C: 3.454, M: 2.284, P: 2.163, D: 2.041,
  G: 1.588, B: 1.494, F: 1.168, H: 0.927, V: 0.840, Z: 0.530, Y: 0.353,
  Q: 0.325, X: 0.243, J: 0.187, K: 0.156, W: 0.030,
};

export const DEFAULT_BLANK_WEIGHT = 1.598;

export interface BagConfig {
  weights: Readonly<Record<string, number>>;
  blankWeight: number;
  alpha: number;
  cap: number;
  /** Plafond dur de jokers par tirage. */
  maxBlanks: number;
}

export const DEFAULT_BAG: BagConfig = {
  weights: DEFAULT_WEIGHTS,
  blankWeight: DEFAULT_BLANK_WEIGHT,
  alpha: 0.08,
  cap: 4,
  maxBlanks: 2,
};

export interface DrawResult {
  /** Les 7 caramels, tries alphabetiquement : ce que voit le joueur. */
  rack: string;
  /** Notation pour la feuille de route : "AA+BLRNT", ou "-BBNOORS" apres rejet. */
  notation: string;
  /** Le tirage a-t-il ete rejete au moins une fois ? */
  rejected: boolean;
  /** Nombre de rejets, pour les statistiques. */
  rejections: number;
}

/**
 * Regle de rejet (SPEC.md §4) : au moins 2 voyelles ET au moins 2 consonnes.
 * Y et joker sont NEUTRES, ils ne comptent d'aucun cote.
 *
 * L'exigence S'ADAPTE A LA TAILLE DU TIRAGE. Telle quelle, la regle est
 * insatisfiable en dessous de quatre caramels -- un tirage de deux ne peut pas
 * contenir deux voyelles ET deux consonnes -- et la pioche bouclerait sans fin
 * a chercher un tirage acceptable. La convention retenue : deux de chaque cote
 * A PARTIR DE SEPT caramels, une seule de chaque en dessous.
 *
 * Fonction de politique remplacable, pas un `if` en dur : une variante
 * probabiliste doit pouvoir se substituer sans toucher au reste.
 */
export type RejectPolicy = (rack: readonly string[]) => boolean;

export const strictRejectPolicy: RejectPolicy = (rack) => {
  const exige = rack.length >= 7 ? 2 : 1;
  if (rack.length < 2) return false;
  let v = 0, c = 0;
  for (const ch of rack) {
    if (isVowel(ch)) v++;
    else if (isConsonant(ch)) c++;
  }
  return v < exige || c < exige;
};

/**
 * LE COUP OU LES REGLES DE TIRAGE SE RELACHENT. Voir SPEC.md §16.
 *
 * Deux regles s'en servent, pour deux raisons differentes :
 *
 *   sac fini        au debut il faut 2 voyelles ET 2 consonnes ; a partir d'ici
 *                   une seule de chaque suffit, mais il en faut toujours au
 *                   moins une. LE RELACHEMENT NE VAUT QUE POUR UN SAC QUI
 *                   S'EPUISE : en fin de sac il ne reste plus assez de chaque
 *                   sorte pour composer un tirage acceptable, et sans lui la
 *                   partie serait injouable avant sa fin conventionnelle. Un
 *                   sac qui se recharge n'a pas ce probleme, et des
 *                   probabilites ponderees encore moins.
 *   double joker    a partir d'ici, plus aucune regle du tout.
 *
 * Il vit ici, avec les politiques de rejet, plutot qu'avec le sac fini qui l'a
 * fait naitre : les deux pioches le lisent desormais.
 */
export const COUP_RELACHEMENT = 16;

/**
 * LA REGLE DE REJET DU DOUBLE JOKER. Voir SPEC.md §16.
 *
 * Deux jokers changent ce qu'est un tirage jouable. Cinq consonnes et deux
 * jokers se jouent tres bien -- les jokers fournissent les voyelles -- alors
 * qu'a sept vraies lettres cela ne se joue pas. Exiger deux voyelles et deux
 * consonnes reviendrait a servir un tirage confortable a qui tient deja les
 * deux caramels les plus utiles du jeu.
 *
 *   coups 1 a 15    au moins UNE voyelle et UNE consonne, le temps que la
 *                   grille se garnisse et qu'il y ait ou s'appuyer.
 *   coup 16 et apres   plus aucune regle. Cinq voyelles et deux jokers, cinq
 *                   consonnes et deux jokers : c'est jouable, et c'est
 *                   justement l'interet de la variante.
 *
 * LA REGLE EST ECRITE PLUTOT QUE DEDUITE DE LA TAILLE DU TIRAGE. En sept sur
 * sept le sac ne distribue que cinq lettres, si bien que la regle ordinaire
 * tombait deja d'elle-meme a une voyelle et une consonne -- mais en « 7 sur 9 »
 * il en distribue sept, et le deux-et-deux revenait sans qu'on l'ait voulu.
 */
export function regleDuDoubleJoker(rack: readonly string[], coup: number): boolean {
  if (coup >= COUP_RELACHEMENT) return false;
  if (rack.length < 2) return false;
  let v = 0, c = 0;
  for (const ch of rack) {
    if (isVowel(ch)) v++;
    else if (isConsonant(ch)) c++;
  }
  return v < 1 || c < 1;
}

export class Bag {
  private readonly cfg: BagConfig;
  private readonly random: Alea;
  private readonly letters: string[];
  private readonly base: number[];
  /** Tirages ecoules depuis la derniere sortie de chaque lettre. */
  private k: number[];
  private reject: RejectPolicy;
  /** La politique vient-elle du dehors ? Voir `cloner`. */
  private readonly rejetFourni: boolean;
  /** Nombre de caramels par tirage -- le Y de « X sur Y ». */
  private readonly tirage: number;
  /** Numero du tirage en cours, pour la regle du double joker. */
  private coup = 0;
  /**
   * Deux jokers accompagnent chaque tirage ? La regle de rejet change alors du
   * tout au tout (voir `regleDuDoubleJoker`).
   *
   * Pose APRES la construction : la politique par defaut le lit a chaque
   * tirage plutot qu'une fois pour toutes.
   */
  doubleJoker = false;

  constructor(
    cfg: BagConfig, random: Alea,
    reject?: RejectPolicy, tirage = RACK_SIZE,
  ) {
    this.cfg = cfg;
    this.random = random;
    this.rejetFourni = reject !== undefined;
    this.reject = reject ?? ((rack) => this.doubleJoker
      ? regleDuDoubleJoker(rack, this.coup)
      : strictRejectPolicy(rack));
    this.tirage = tirage;
    this.letters = [...Object.keys(cfg.weights), BLANK];
    this.base = [...Object.values(cfg.weights), cfg.blankWeight];
    this.k = new Array(this.letters.length).fill(0);
  }

  private drawOne(blanksSoFar: number): string {
    const { alpha, cap, maxBlanks } = this.cfg;
    let total = 0;
    const cur = new Array<number>(this.letters.length);
    for (let i = 0; i < this.letters.length; i++) {
      const isBlank = this.letters[i] === BLANK;
      const w = isBlank && blanksSoFar >= maxBlanks
        ? 0
        : this.base[i]! * Math.min(1 + alpha * this.k[i]!, cap);
      cur[i] = w;
      total += w;
    }
    let r = this.random() * total;
    let pick = this.letters.length - 1;
    for (let i = 0; i < cur.length; i++) {
      r -= cur[i]!;
      if (r <= 0) { pick = i; break; }
    }
    for (let i = 0; i < this.k.length; i++) this.k[i]!++;
    this.k[pick] = 0;
    return this.letters[pick]!;
  }

  private fill(from: readonly string[]): string[] {
    const rack = [...from];
    let blanks = rack.filter((c) => c === BLANK).length;
    while (rack.length < this.tirage) {
      const ch = this.drawOne(blanks);
      if (ch === BLANK) blanks++;
      rack.push(ch);
    }
    return rack;
  }

  /**
   * Complete le reliquat a 7. Si le tirage est rejete, TOUT part, reliquat
   * compris, et on repart sur 7 lettres neuves.
   *
   * Un tirage rejete ne consomme pas les probabilites : les compteurs de
   * compensation sont restaures, il n'a jamais existe.
   */
  draw(reliquat: readonly string[]): DrawResult {
    this.coup++;
    const snapshot = [...this.k];

    const first = this.fill(reliquat);
    if (!this.reject(first)) {
      const drawn = first.slice(reliquat.length);
      const left = [...reliquat].sort().join("");
      return {
        rack: [...first].sort().join(""),
        notation: left === "" ? drawn.slice().sort().join("") : `${left}+${drawn.slice().sort().join("")}`,
        rejected: false,
        rejections: 0,
      };
    }

    let rejections = 1;
    for (;;) {
      this.k = [...snapshot];
      const fresh = this.fill([]);
      if (!this.reject(fresh)) {
        const sorted = [...fresh].sort().join("");
        return { rack: sorted, notation: `-${sorted}`, rejected: true, rejections };
      }
      rejections++;
      if (rejections > 1000) throw new Error("politique de rejet insatisfiable");
    }
  }

  /** Compteurs de compensation, pour les tests. Un zero signifie "vient de sortir". */
  counters(): number[] {
    return [...this.k];
  }

  /**
   * Une copie exacte, qui tirera EXACTEMENT la meme suite.
   *
   * Sert a simuler les coups a venir sans toucher a la partie (SPEC.md §17) :
   * le double pioche en avance, la vraie pioche reste ou elle en est, et on
   * verifie a chaque coup que les deux tombent d'accord.
   */
  cloner(): Bag {
    // LA POLITIQUE PAR DEFAUT NE SE RECOPIE PAS : elle lit le numero de coup de
    // la pioche a laquelle elle appartient, et la copier telle quelle lierait
    // le double a l'original. Une politique venue du dehors, si.
    const copie = new Bag(
      this.cfg, mulberryDepuis(this.random),
      this.rejetFourni ? this.reject : undefined, this.tirage,
    );
    copie.k = [...this.k];
    copie.coup = this.coup;
    copie.doubleJoker = this.doubleJoker;
    return copie;
  }

  /** Rien ne s'epuise : une partie sur probabilites ponderees ne finit jamais. */
  estFinie(): boolean {
    return false;
  }

  /** Aucun reste a declarer : le sac est virtuel. */
  restant(): Record<string, number> {
    return {};
  }

  /**
   * Sans effet : des probabilites ponderees n'ont pas de stock a reapprovisionner.
   * La methode existe pour que les deux pioches se remplacent l'une l'autre.
   */
  rendre(_lettres: readonly string[]): void { /* rien a rendre */ }

  /** Le reliquat apres un coup : le tirage moins les caramels effectivement poses. */
  static remainder(rack: string, used: readonly { letter: string; blank: boolean }[]): string[] {
    const left = [...rack];
    for (const u of used) {
      const ch = u.blank ? BLANK : u.letter;
      const i = left.indexOf(ch);
      if (i === -1) throw new Error(`caramel ${ch} absent du tirage ${rack}`);
      left.splice(i, 1);
    }
    return left;
  }
}
