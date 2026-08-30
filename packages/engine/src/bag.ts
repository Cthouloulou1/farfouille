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

export class Bag {
  private readonly cfg: BagConfig;
  private readonly random: () => number;
  private readonly letters: string[];
  private readonly base: number[];
  /** Tirages ecoules depuis la derniere sortie de chaque lettre. */
  private k: number[];
  private reject: RejectPolicy;
  /** Nombre de caramels par tirage -- le Y de « X sur Y ». */
  private readonly tirage: number;

  constructor(
    cfg: BagConfig, random: () => number,
    reject: RejectPolicy = strictRejectPolicy, tirage = RACK_SIZE,
  ) {
    this.cfg = cfg;
    this.random = random;
    this.reject = reject;
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
