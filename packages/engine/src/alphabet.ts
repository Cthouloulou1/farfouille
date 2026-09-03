/** Alphabet, valeurs des lettres, voyelles/consonnes. Voir SPEC.md §4 et §6. */

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Le joker, dans un tirage. Ne sort jamais du sac comme une lettre normale. */
export const BLANK = "?";

/**
 * Range un tirage : les lettres dans l'ordre, LES JOKERS A LA FIN.
 *
 * C'est la convention partout ailleurs -- sur une feuille de match comme dans
 * les logiciels. Un tri brut mettait le joker EN TETE, parce que `?` precede
 * `A` dans la table des caracteres : une raison de machine, que personne ne
 * lit comme telle en regardant son chevalet.
 */
export function rangerLeTirage(lettres: Iterable<string>): string {
  const tout = [...lettres];
  const jokers = tout.filter((c) => c === BLANK);
  return tout.filter((c) => c !== BLANK).sort().join("") + jokers.join("");
}

/** Separateur GADDAG. Code 27, hors A-Z. */
export const SEP = "#";

/** A..Z -> 1..26, separateur -> 27. Le code 0 n'est jamais une lettre. */
export function code(ch: string): number {
  if (ch === SEP) return 27;
  return ch.charCodeAt(0) - 64;
}

export function letterOf(c: number): string {
  return c === 27 ? SEP : String.fromCharCode(c + 64);
}

/** Valeurs francaises classiques. Le joker vaut 0. */
export const VALUES: Readonly<Record<string, number>> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1,
  J: 8, K: 10, L: 1, M: 2, N: 1, O: 1, P: 3, Q: 8, R: 1,
  S: 1, T: 1, U: 1, V: 4, W: 10, X: 10, Y: 10, Z: 10,
};

export function valueOf(ch: string): number {
  return VALUES[ch] ?? 0;
}

export const VOWELS = new Set("AEIOU");

/**
 * Y et le joker sont NEUTRES : ils ne comptent ni comme voyelle ni comme
 * consonne pour la regle de rejet du tirage (SPEC.md §4).
 */
export function isVowel(ch: string): boolean {
  return VOWELS.has(ch);
}

export function isConsonant(ch: string): boolean {
  return ch !== BLANK && ch !== "Y" && !VOWELS.has(ch) && ch >= "A" && ch <= "Z";
}
