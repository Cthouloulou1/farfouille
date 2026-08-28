/**
 * Grille creuse infinie. Voir SPEC.md §3 et §7.
 *
 * Deux structures incrementales, jamais de balayage global :
 *   - l'index des ancrages (cases vides adjacentes a une tuile) ;
 *   - le cache des cross-checks, qui est LE levier de performance principal.
 *
 * Les cross-checks (quelles lettres sont legales sur une case, compte tenu du
 * mot perpendiculaire) sont INDEPENDANTS DU TIRAGE. On les calcule une fois et
 * on n'invalide que le voisinage du mot qui vient d'etre pose.
 */
import { key, keyX, keyY, type Dir } from "./coords.ts";
import { LETTERS, code } from "./alphabet.ts";
import { configParDefaut, valeurDe, type ConfigPartie } from "./config.ts";
import type { Dict } from "./dictionary.ts";

export interface Tile {
  letter: string;
  /** Pose avec un joker : la lettre compte, mais vaut 0 point. */
  blank: boolean;
}

export interface Placement {
  x: number;
  y: number;
  letter: string;
  blank: boolean;
}

export interface CrossCheck {
  /** Bit (code-1) arme => la lettre est legale ici. Bits 0..25 pour A..Z. */
  mask: number;
  /** Somme des valeurs des tuiles du mot perpendiculaire (jokers a 0). */
  score: number;
  /** Existe-t-il un mot perpendiculaire ? Si non, la case ne rapporte que le mot principal. */
  has: boolean;
}

/** Les 26 lettres autorisees : aucune contrainte perpendiculaire. */
export const ALL_LETTERS_MASK = (1 << 26) - 1;

const FREE: CrossCheck = Object.freeze({ mask: ALL_LETTERS_MASK, score: 0, has: false });

/** Longueur maximale d'un mot de l'ODS. Borne les parcours de runs. */
export const MAX_WORD = 15;

export class Board {
  private readonly tiles = new Map<number, Tile>();
  /** Cases vides adjacentes a au moins une tuile. Pour une grille vide : l'origine. */
  readonly anchors = new Set<number>();
  /** Cache par sens du mot PRINCIPAL. crossH concerne les mots verticaux formes. */
  private readonly crossH = new Map<number, CrossCheck>();
  private readonly crossV = new Map<number, CrossCheck>();
  private readonly dict: Dict;
  /**
   * La configuration de la partie jouee sur cette grille. Elle voyage avec elle
   * pour que deux salons voisins puissent jouer des variantes differentes dans
   * le meme processus (SPEC.md §16).
   */
  readonly cfg: ConfigPartie;

  constructor(dict: Dict, cfg: ConfigPartie = configParDefaut()) {
    this.dict = dict;
    this.cfg = cfg;
    this.anchors.add(key(0, 0));
  }

  get size(): number {
    return this.tiles.size;
  }

  get isEmpty(): boolean {
    return this.tiles.size === 0;
  }

  at(x: number, y: number): Tile | undefined {
    return this.tiles.get(key(x, y));
  }

  /**
   * La case est-elle SUR le plateau ? Toujours vrai sur une grille infinie.
   *
   * Hors bornes, on ne peut rien poser -- mais la case reste un bord de mot
   * valide : un mot a le droit de commencer contre le bord. Ce n'est donc pas
   * la meme chose qu'une case occupee.
   */
  dansLesBornes(x: number, y: number): boolean {
    const b = this.cfg.bornes;
    return b === null || (x >= -b && x <= b && y >= -b && y <= b);
  }

  occupied(x: number, y: number): boolean {
    return this.tiles.has(key(x, y));
  }

  /** Bornes du contenu, pour l'affichage et les statistiques. */
  bounds(): { minX: number; maxX: number; minY: number; maxY: number } | null {
    if (this.tiles.size === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const k of this.tiles.keys()) {
      const x = keyX(k), y = keyY(k);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY };
  }

  /**
   * Pose des tuiles, met a jour ancrages et cache.
   * Aucune verification de legalite ici : c'est le role du generateur.
   */
  place(placements: readonly Placement[]): void {
    for (const p of placements) {
      this.tiles.set(key(p.x, p.y), { letter: p.letter, blank: p.blank });
    }
    for (const p of placements) {
      const k = key(p.x, p.y);
      this.anchors.delete(k);
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = p.x + dx, ny = p.y + dy;
        if (!this.occupied(nx, ny) && this.dansLesBornes(nx, ny)) this.anchors.add(key(nx, ny));
      }
    }
    for (const p of placements) this.invalidateAround(p.x, p.y);
  }

  /**
   * Invalide exactement les cases dont le cross-check a pu changer.
   *
   * Poser en (x,y) modifie le mot vertical de la colonne x : seules les deux
   * cases vides encadrant le run vertical voient leur cross-check horizontal
   * bouger. Symetriquement pour l'axe horizontal.
   */
  private invalidateAround(x: number, y: number): void {
    const k = key(x, y);
    this.crossH.delete(k);
    this.crossV.delete(k);

    // Extremites du run vertical -> cross-check des mots principaux HORIZONTAUX.
    let up = y;
    while (this.occupied(x, up - 1)) up--;
    let down = y;
    while (this.occupied(x, down + 1)) down++;
    this.crossH.delete(key(x, up - 1));
    this.crossH.delete(key(x, down + 1));

    // Extremites du run horizontal -> cross-check des mots principaux VERTICAUX.
    let left = x;
    while (this.occupied(left - 1, y)) left--;
    let right = x;
    while (this.occupied(right + 1, y)) right++;
    this.crossV.delete(key(left - 1, y));
    this.crossV.delete(key(right + 1, y));
  }

  /** Vide le cache. Sert aux tests, qui comparent cache et recalcul complet. */
  clearCrossCache(): void {
    this.crossH.clear();
    this.crossV.clear();
  }

  /**
   * Cross-check d'une case vide, pour un mot principal de sens `dir`.
   * Le mot perpendiculaire est donc vertical si dir vaut "H".
   */
  crossCheck(dir: Dir, x: number, y: number): CrossCheck {
    const cache = dir === "H" ? this.crossH : this.crossV;
    const k = key(x, y);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const cc = this.computeCrossCheck(dir, x, y);
    cache.set(k, cc);
    return cc;
  }

  /**
   * Somme des valeurs du mot perpendiculaire, SANS calculer le masque des
   * lettres legales. Sert au majorant de l'elagage : le masque coute 26
   * consultations du dictionnaire, la somme ne coute qu'un parcours du run.
   */
  crossScoreQuick(dir: Dir, x: number, y: number): number {
    const cached = (dir === "H" ? this.crossH : this.crossV).get(key(x, y));
    if (cached !== undefined) return cached.has ? cached.score : 0;

    const dx = dir === "H" ? 0 : 1;
    const dy = dir === "H" ? 1 : 0;
    let s = 0;
    for (let i = 1; i <= MAX_WORD; i++) {
      const t = this.at(x - dx * i, y - dy * i);
      if (t === undefined) break;
      if (!t.blank) s += valeurDe(this.cfg, t.letter);
    }
    for (let i = 1; i <= MAX_WORD; i++) {
      const t = this.at(x + dx * i, y + dy * i);
      if (t === undefined) break;
      if (!t.blank) s += valeurDe(this.cfg, t.letter);
    }
    return s;
  }

  private computeCrossCheck(dir: Dir, x: number, y: number): CrossCheck {
    // Sens du mot perpendiculaire : vertical si le mot principal est horizontal.
    const dx = dir === "H" ? 0 : 1;
    const dy = dir === "H" ? 1 : 0;

    let before = "";
    let score = 0;
    for (let i = 1; i <= MAX_WORD; i++) {
      const t = this.at(x - dx * i, y - dy * i);
      if (t === undefined) break;
      before = t.letter + before;
      if (!t.blank) score += valeurDe(this.cfg, t.letter);
    }
    let after = "";
    for (let i = 1; i <= MAX_WORD; i++) {
      const t = this.at(x + dx * i, y + dy * i);
      if (t === undefined) break;
      after += t.letter;
      if (!t.blank) score += valeurDe(this.cfg, t.letter);
    }

    if (before === "" && after === "") return FREE;

    let mask = 0;
    for (const L of LETTERS) {
      if (this.dict.contains(before + L + after)) mask |= 1 << (code(L) - 1);
    }
    return { mask, score, has: true };
  }
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
