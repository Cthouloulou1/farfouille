/**
 * Le sac fini de 102 caramels. Voir SPEC.md §16.
 *
 * C'est l'autre pioche possible, a cote des probabilites ponderees de `bag.ts`.
 * Elle est indispensable a deux choses que les probabilites ne savent pas
 * faire : la **partie joker**, qui demande de savoir s'il reste un R quelque
 * part, et la **fin de partie**, qui demande que quelque chose s'epuise.
 */
import { BLANK, isConsonant, isVowel } from "./alphabet.ts";
import { type DrawResult, type RejectPolicy } from "./bag.ts";

/**
 * Le tirage se relache passe un certain nombre de coups. Voir SPEC.md §16.
 *
 * Au debut il faut 2 voyelles ET 2 consonnes ; a partir du COUP 16 une seule de
 * chaque suffit, mais il en faut toujours au moins une.
 *
 * LE RELACHEMENT NE VAUT QUE POUR UN SAC QUI S'EPUISE. C'est la seule raison
 * d'etre de la regle : en fin de sac fini, il ne reste plus assez de chaque
 * sorte pour composer un tirage acceptable, et sans relachement la partie
 * serait injouable avant sa fin conventionnelle.
 *
 * Un sac QUI SE RECHARGE n'a pas ce probleme -- il se remet a neuf des qu'il
 * devient pauvre d'un cote -- et des probabilites ponderees encore moins :
 * elles ne s'epuisent jamais. Sur une grille infinie tiree d'un sac bouclant,
 * le relachement s'appliquait quand meme et laissait passer, au coup 37, un
 * tirage a une seule voyelle. La regle stricte y vaut du premier coup au
 * dernier.
 */
export const COUP_RELACHEMENT = 16;

export function politiqueSacFini(
  coup: () => number,
  /** Le sac s'epuise-t-il ? Seul un sac fini a droit au relachement. */
  sEpuise: () => boolean = () => true,
): RejectPolicy {
  return (rack) => {
    const relache = sEpuise() && coup() >= COUP_RELACHEMENT;
    const exige = relache ? 1 : (rack.length >= 7 ? 2 : 1);
    if (rack.length < 2) return false;
    let v = 0, c = 0;
    for (const ch of rack) {
      if (isVowel(ch)) v++;
      else if (isConsonant(ch)) c++;
    }
    return v < exige || c < exige;
  };
}

/** Distribution francaise classique : 100 lettres et 2 jokers. */
export const SAC_FRANCAIS: Readonly<Record<string, number>> = {
  A: 9, B: 2, C: 2, D: 3, E: 15, F: 2, G: 2, H: 2, I: 8, J: 1, K: 1, L: 5, M: 3,
  N: 6, O: 6, P: 2, Q: 1, R: 6, S: 6, T: 6, U: 6, V: 2, W: 1, X: 1, Y: 1, Z: 1,
  [BLANK]: 2,
};

/** Une pioche, quelle que soit sa nature. */
export interface Pioche {
  draw(reliquat: readonly string[]): DrawResult;
  /** La partie est-elle terminee ? Toujours faux pour une pioche infinie. */
  estFinie(reliquat: readonly string[]): boolean;
  /** Ce qui reste, par lettre. Vide pour une pioche infinie. */
  restant(): Readonly<Record<string, number>>;
}

export class SacFini implements Pioche {
  private readonly random: () => number;
  private readonly tirage: number;
  private readonly reject: RejectPolicy;
  private readonly distribution: Readonly<Record<string, number>>;
  /**
   * Le sac se recharge-t-il ? Voir SPEC.md §16.
   *
   * Des qu'il ne reste plus que deux voyelles ou deux consonnes dans le sac et
   * le reliquat reunis, il retrouve sa composition d'origine. La partie ne
   * s'arrete alors jamais : c'est la pioche des grilles infinies qui veulent la
   * distribution du jeu classique plutot que des probabilites.
   */
  recharge = false;
  /** Nombre de rechargements, pour les statistiques et les tests. */
  rechargements = 0;
  /** Caramels restants, une entree par exemplaire. */
  private caramels: string[] = [];
  /** Numero du tirage en cours, pour le relachement de la regle de rejet. */
  private coup = 0;

  constructor(
    distribution: Readonly<Record<string, number>> = SAC_FRANCAIS,
    random: () => number = Math.random,
    tirage = 7,
    reject?: RejectPolicy,
  ) {
    this.random = random;
    this.tirage = tirage;
    // `recharge` est pose APRES la construction : la politique le lit donc a
    // chaque tirage plutot qu'une fois pour toutes.
    this.reject = reject ?? politiqueSacFini(() => this.coup, () => !this.recharge);
    this.distribution = distribution;
    this.remplir();
  }

/**
   * Remet le sac a sa composition d'origine, EN TENANT COMPTE DU RELIQUAT.
   *
   * L'invariant est : `sac + reliquat = la distribution de depart`. Un W garde
   * en main est un W qui ne doit PAS revenir dans le sac -- le jeu n'en a
   * qu'un, et le rechargement ne doit pas en inventer un second.
   *
   * La regle ne vaut que pour les pioches A SAC. Les probabilites ponderees
   * n'ont pas de stock : deux W y sont possibles dans un meme tirage, et c'est
   * normal -- environ un tirage sur 400 000 a sept caramels.
   *
   * `deja` liste les caramels qui sont ailleurs que dans le sac et qui doivent
   * donc en etre deduits.
   */
  private remplir(deja: readonly string[] = []): void {
    const reste = new Map<string, number>();
    for (const c of deja) reste.set(c, (reste.get(c) ?? 0) + 1);
    this.caramels = [];
    for (const [lettre, n] of Object.entries(this.distribution)) {
      const enMain = Math.min(n, reste.get(lettre) ?? 0);
      for (let i = 0; i < n - enMain; i++) this.caramels.push(lettre);
    }
  }

  /**
   * Compte ce qui reste, voyelles et consonnes. Le Y et le joker sont neutres,
   * comme partout ailleurs.
   */
  private compte(reliquat: readonly string[]): { v: number; c: number } {
    let v = 0, c = 0;
    for (const ch of [...this.caramels, ...reliquat]) {
      if (ch === "Y" || ch === BLANK) continue;
      if (isVowel(ch)) v++;
      else if (isConsonant(ch)) c++;
    }
    return { v, c };
  }

  get reste(): number { return this.caramels.length; }

  /** Y a-t-il encore un exemplaire de cette lettre dans le sac ? */
  contient(lettre: string): boolean {
    return this.caramels.includes(lettre);
  }

  /**
   * Retire un exemplaire de cette lettre. Sert a la partie joker : quand le
   * joker joue un R, c'est un vrai R qui quitte le sac pour la grille.
   */
  retirer(lettre: string): boolean {
    const i = this.caramels.indexOf(lettre);
    if (i === -1) return false;
    this.caramels.splice(i, 1);
    return true;
  }

  private piocher(): string {
    const i = Math.floor(this.random() * this.caramels.length);
    return this.caramels.splice(i, 1)[0]!;
  }

  private completer(depuis: readonly string[]): string[] {
    const rack = [...depuis];
    while (rack.length < this.tirage && this.caramels.length > 0) rack.push(this.piocher());
    return rack;
  }

  /**
   * Complete le reliquat. Un tirage refuse retourne DANS LE SAC -- les caramels
   * sont physiques, ils ne s'evaporent pas -- reliquat compris, conformement a
   * la regle de rejet (SPEC.md §4).
   */
  draw(reliquat: readonly string[]): DrawResult {
    this.coup++;
    // Sac rechargeable : on le remet a neuf AVANT de piocher, des qu'il devient
    // trop pauvre d'un cote ou de l'autre.
    if (this.recharge) {
      const { v, c } = this.compte(reliquat);
      if (v <= 2 || c <= 2) { this.remplir(reliquat); this.rechargements++; }
    }
    const avant = [...this.caramels];
    const premier = this.completer(reliquat);
    if (!this.reject(premier) || this.caramels.length === 0) {
      const pioches = premier.slice(reliquat.length).sort().join("");
      const garde = [...reliquat].sort().join("");
      return {
        rack: [...premier].sort().join(""),
        notation: garde === "" ? pioches : `${garde}+${pioches}`,
        rejected: false,
        rejections: 0,
      };
    }

    let rejets = 1;
    for (;;) {
      // Tout revient dans le sac, reliquat inclus, et on repart a neuf.
      this.caramels = [...avant, ...reliquat];
      const frais = this.completer([]);
      if (!this.reject(frais) || this.caramels.length === 0) {
        const trie = [...frais].sort().join("");
        return { rack: trie, notation: `-${trie}`, rejected: true, rejections: rejets };
      }
      rejets++;
      if (rejets > 1000) throw new Error("politique de rejet insatisfiable");
    }
  }

  restant(): Record<string, number> {
    const r: Record<string, number> = {};
    for (const c of this.caramels) r[c] = (r[c] ?? 0) + 1;
    return r;
  }

  /**
   * La partie est-elle finie ? Voir SPEC.md §16.
   *
   * C'est une CONVENTION : on s'arrete quand il ne reste plus que des voyelles
   * ou que des consonnes, meme si des coups restent techniquement jouables. Les
   * fins de partie ou l'on colle des voyelles isolees n'interessent personne.
   *
   * Le Y est la lettre qui bascule, parce qu'il peut tenir le role de la
   * voyelle : avec des consonnes et lui, on joue encore.
   */
  estFinie(reliquat: readonly string[]): boolean {
    // Un sac qui se recharge ne s'epuise jamais : la partie ne finit pas.
    if (this.recharge) return false;
    const restes = [...this.caramels, ...reliquat];
    // Un joker peut fournir la lettre manquante : tant qu'il en reste un, on joue.
    if (restes.includes(BLANK)) return false;
    if (restes.length === 0) return true;

    let voyelles = 0, consonnes = 0, y = 0;
    for (const c of restes) {
      if (c === "Y") y++;
      else if (isVowel(c)) voyelles++;
      else if (isConsonant(c)) consonnes++;
    }
    if (consonnes === 0) return true;      // que des voyelles, avec ou sans Y
    if (voyelles === 0) return y === 0;    // consonnes seules : on continue tant qu'il y a le Y
    return false;
  }
}
