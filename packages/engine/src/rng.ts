/**
 * Aleatoire DETERMINISTE. Voir SPEC.md §5.
 *
 * Rien dans le moteur ne doit appeler Math.random() : sans graine reproductible
 * l'historique n'est pas rejouable et deux serveurs divergent. La graine est
 * derivee de (idPartie, numeroDeCoup).
 */

/**
 * Un tirage aleatoire qu'on peut DUPLIQUER en cours de route.
 *
 * `cloner` rend une pioche copiable, et donc ce qui permet de simuler les
 * coups a venir sans toucher a la vraie partie (SPEC.md §17). Chaque
 * implementation porte sa propre facon de se copier -- mulberry32 tient tout
 * dans un entier 32 bits, le generateur cryptographique de
 * `server/src/rngSecurise.ts` a besoin de davantage -- si bien que rien ici
 * n'expose la nature de cet etat.
 */
export interface Alea {
  (): number;
  /** Une copie independante, qui tirera exactement la meme suite a partir d'ici. */
  cloner(): Alea;
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
  suivant.cloner = () => mulberry32(a);
  return suivant;
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
