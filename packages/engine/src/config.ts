/**
 * La configuration d'une partie. Voir SPEC.md §16.
 *
 * Tout ce qui distingue une variante d'une autre vit ici : combien de lettres on
 * pioche, combien on peut en poser, ce que vaut chaque lettre, quelles primes
 * recompensent quel nombre de caramels poses, et sur quel pavage on joue.
 *
 * POURQUOI UN OBJET ET PAS DES CONSTANTES. Un serveur heberge plusieurs salons
 * a la fois, et deux salons voisins peuvent jouer des variantes differentes --
 * un duplicate francais 15x15 et une battle anglaise sur grille infinie. Des
 * constantes de module, ou un reglage global comme `setLayout`, melangeraient
 * les deux. La configuration voyage donc avec la grille : chaque `Board` porte
 * la sienne, et le score, le generateur et la resolution d'un mot tape la
 * lisent la plutot que dans une variable partagee.
 */
import { VALUES } from "./alphabet.ts";
import { activeLayout, currentLayout, type LayoutFn, type LayoutName } from "./bonus.ts";

/**
 * Primes par nombre de caramels poses en un coup.
 *
 * La table par defaut est celle du jeu classique prolongee : 50 a sept
 * caramels, puis 25 de plus par caramel supplementaire, jusqu'a 250 pour
 * quinze. En dessous de sept, rien.
 */
export function primesParDefaut(): Record<number, number> {
  const t: Record<number, number> = {};
  for (let n = 7; n <= 15; n++) t[n] = 50 + (n - 7) * 25;
  return t;
}

export interface ConfigPartie {
  /** Nombre de caramels piochés par coup -- le Y de « X sur Y ». */
  tirage: number;
  /** Nombre maximum de caramels posables en un coup -- le X. */
  jouables: number;
  /** Prime par nombre de caramels poses. Une entree absente vaut zero. */
  primes: Readonly<Record<number, number>>;
  /** Valeur de chaque lettre. Change avec le dictionnaire. */
  valeurs: Readonly<Record<string, number>>;
  /** Le pavage des cases bonus. */
  pavage: LayoutFn;
  /** Nom du pavage, pour la sauvegarde et l'affichage. */
  pavageNom: LayoutName | "custom";
}

/**
 * La configuration du topping infini : celle qui tourne aujourd'hui.
 *
 * Le pavage est celui qui est actif AU MOMENT DE L'APPEL. Tant que le reglage
 * global de `bonus.ts` existe, une grille creee apres `setLayout("classique")`
 * doit jouer sur ce pavage-la, sans quoi le score et la resolution d'un mot
 * tape ne parleraient pas du meme plateau.
 */
export function configParDefaut(): ConfigPartie {
  return {
    tirage: 7,
    jouables: 7,
    primes: primesParDefaut(),
    valeurs: VALUES,
    pavage: activeLayout(),
    pavageNom: currentLayout(),
  };
}

/** Une configuration derivee, pour ne pas repeter les champs inchanges. */
export function avec(base: ConfigPartie, modifs: Partial<ConfigPartie>): ConfigPartie {
  return { ...base, ...modifs };
}

/** Valeur d'une lettre selon cette partie. Le joker vaut toujours zero. */
export function valeurDe(cfg: ConfigPartie, ch: string): number {
  return cfg.valeurs[ch] ?? 0;
}

/** Prime pour ce nombre de caramels poses. */
export function primeDe(cfg: ConfigPartie, poses: number): number {
  return cfg.primes[poses] ?? 0;
}
