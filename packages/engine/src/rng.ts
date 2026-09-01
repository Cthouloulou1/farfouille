/**
 * Aleatoire DETERMINISTE. Voir SPEC.md §5.
 *
 * Rien dans le moteur ne doit appeler Math.random() : sans graine reproductible
 * l'historique n'est pas rejouable et deux serveurs divergent. La graine est
 * derivee de (idPartie, numeroDeCoup).
 */

/**
 * Un tirage aleatoire qu'on peut ARRETER ET REPRENDRE.
 *
 * Toute la memoire de mulberry32 tient dans un entier de 32 bits. L'exposer
 * permet de dupliquer une suite en cours : c'est ce qui rend une pioche
 * copiable, et donc ce qui permet de simuler les coups a venir sans toucher
 * a la vraie partie (SPEC.md §17).
 */
export interface Alea {
  (): number;
  /** L'etat courant du generateur. */
  etat(): number;
  /** Le repose la ou il etait. */
  poser(a: number): void;
}

/** mulberry32 : petit, rapide, sequence identique partout. */
export function mulberry32(seed: number): Alea {
  let a = seed >>> 0;
  const suivant = function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  } as Alea;
  suivant.etat = () => a;
  suivant.poser = (v: number) => { a = v | 0; };
  return suivant;
}

/** Un second generateur, pose exactement la ou en est le premier. */
export function mulberryDepuis(source: Alea): Alea {
  const jumeau = mulberry32(0);
  jumeau.poser(source.etat());
  return jumeau;
}

/** cyrb53, replie sur 32 bits : hache une chaine en graine. */
export function hashSeed(s: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

/** La graine d'un coup donne. Deux serveurs qui l'appellent obtiennent la meme. */
export function moveSeed(gameId: string, moveNumber: number): number {
  return hashSeed(`${gameId}:${moveNumber}`);
}
