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

/**
 * Combien de tirages on refuse avant de prendre ce qu'il y a.
 *
 * Assez pour que le hasard ait toutes ses chances -- un tirage acceptable qui
 * existe sort bien avant -- et fini, pour qu'un sac qui n'en contient aucun ne
 * fasse pas tourner la pioche sans fin.
 */
const MAX_REJETS = 500;

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
  /**
   * Remet des caramels dans le sac.
   *
   * Un tirage abandonne -- parce qu'il ne permet aucun coup -- doit rendre ses
   * lettres, sinon elles disparaissent du jeu et le sac de 102 n'en compte plus
   * que 99. Sans effet sur une pioche a probabilites, qui n'a pas de stock.
   */
  rendre(lettres: readonly string[]): void;
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
    // trop pauvre d'un cote ou de l'autre -- OU TROP PETIT.
    //
    // UN TIRAGE INCOMPLET EST INTERDIT. On joue sept sur sept : c'est sept
    // caramels en main, pas « ce qu'il reste ». Le rechargement ne regardait
    // que l'equilibre voyelles / consonnes, si bien qu'un fond de sac de six
    // lettres bien reparties passait le controle -- et servait un tirage de
    // six. Il faut donc aussi recharger des que le sac et le reliquat reunis ne
    // suffisent plus a remplir un chevalet.
    if (this.recharge) {
      const { v, c } = this.compte(reliquat);
      const disponibles = this.caramels.length + reliquat.length;
      if (v <= 2 || c <= 2 || disponibles < this.tirage) {
        this.remplir(reliquat);
        this.rechargements++;
      }
    }
    const avant = [...this.caramels];
    // LE Y DEVIENT OBLIGATOIRE quand il tient seul un role.
    //
    // S'il ne reste plus de voyelle en dehors du Y, aucun tirage ne peut en
    // contenir une : exiger une voyelle serait exiger l'impossible. Mais le Y
    // en tient lieu, et la partie n'est pas finie tant qu'il est la -- alors on
    // le TIRE, pour qu'il soit joue et que la partie s'acheve pour de bon.
    // Symetriquement quand il est la derniere consonne.
    //
    // C'est ce qui reconcilie les deux regles du sac : la convention d'arret
    // dit que le Y remplace la lettre manquante, la regle de tirage l'exige.
    const { v, c } = this.compte(reliquat);
    const yEnReserve = [...this.caramels, ...reliquat].filter((l) => l === "Y").length;
    const yObligatoire = yEnReserve > 0 && (v === 0 || c === 0);
    const convient = (rack: readonly string[]): boolean =>
      yObligatoire ? rack.includes("Y") : !this.reject(rack);

    const premier = this.completer(reliquat);
    if (convient(premier) || this.caramels.length === 0) {
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
      // ON PREND CE QU'IL Y A quand le sac ne peut plus faire mieux.
      //
      // La regle de rejet est une PREFERENCE, pas une loi physique : elle
      // suppose qu'un tirage acceptable existe. En fin de partie il n'en existe
      // parfois aucun -- ainsi d'un reste fait d'un Y et de consonnes, que la
      // convention d'arret tient pour jouable (le Y y remplace la voyelle)
      // alors que la regle de rejet le refuse (le Y n'y compte d'aucun cote).
      // Les deux regles se contredisent, et la pioche tournait alors mille fois
      // avant de LEVER UNE ERREUR : le serveur tombait, partie comprise.
      //
      // Une preference qu'on ne peut pas satisfaire n'est plus une preference.
      if (convient(frais) || this.caramels.length === 0 || rejets >= MAX_REJETS) {
        const trie = [...frais].sort().join("");
        return { rack: trie, notation: `-${trie}`, rejected: true, rejections: rejets };
      }
      rejets++;
    }
  }

  rendre(lettres: readonly string[]): void {
    for (const l of lettres) this.caramels.push(l);
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
   * LE Y BASCULE DES DEUX COTES. Il peut tenir le role de la voyelle qui manque
   * comme celui de la consonne : tant qu'il est la, la partie continue, et la
   * pioche l'exige dans le tirage pour qu'il soit joue (voir `draw`). Il ne
   * tenait ce role que d'un cote, si bien qu'un reste de voyelles et d'un Y
   * finissait la partie quand le meme reste en consonnes la poursuivait.
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
    // Rien que des Y : ils ne font pas un mot a eux seuls.
    if (consonnes === 0 && voyelles === 0) return true;
    // D'un cote comme de l'autre, on continue tant que le Y est la.
    if (consonnes === 0 || voyelles === 0) return y === 0;
    return false;
  }
}
