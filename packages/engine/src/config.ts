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
import { activeLayout, currentLayout, LAYOUTS, type LayoutFn, type LayoutName } from "./bonus.ts";
import { DICO_PAR_DEFAUT, dictionnaire } from "./dictionnaires.ts";

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
  /**
   * Le lexique de la partie : quels mots existent.
   *
   * Il ne dit pas que les mots. Il emmene avec lui la valeur des lettres, la
   * composition du sac et les poids de la pioche ponderee -- voir
   * `dictionnaires.ts`. En changer sans changer le reste ferait jouer un
   * lexique anglais avec un W a dix points dont il n'existe qu'un exemplaire.
   */
  dictionnaire: string;
  /**
   * D'ou viennent les caramels. Les probabilites ponderees ne s'epuisent
   * jamais ; le sac de 102 est ce que reclament la partie joker et la fin de
   * partie.
   */
  pioche: "probabilites" | "sac102" | "sac102boucle";
  /**
   * Partie joker : le tirage contient toujours un joker, et la lettre qu'il
   * joue est remplacee par une vraie sortie du sac. Voir SPEC.md §16.
   */
  joker: boolean;
  /**
   * Comment un coup se termine. Voir SPEC.md §16.
   *
   * `topping`    — le premier qui trouve le top le pose et remporte le coup.
   * `duplicate`  — le coup dure TOUJOURS le temps plein ; chacun marque le
   *                score de sa meilleure solution, et son ecart au top est son
   *                negatif. Rien ne filtre avant l'echeance.
   */
  mode: "topping" | "duplicate";
  /**
   * Nombre de coups a jouer, ou `null` pour sans fin.
   *
   * Une grille infinie ne s'epuise jamais : sans cette borne, un duplicate n'y
   * aurait pas de terme, donc pas de classement final. Sur un plateau borne, le
   * sac s'epuise avant et cette limite ne sert qu'a raccourcir.
   */
  coupsMax: number | null;
  /**
   * Duree totale de la partie, en secondes, ou `null`.
   *
   * L'autre facon de borner une partie sans fin naturelle : au lieu de compter
   * les coups, on compte le temps. Les deux s'excluent -- une partie a deux
   * termes concurrents ne sait pas lequel respecter.
   */
  dureeMax: number | null;
  /**
   * Decompte de deux secondes avant que le coup commence : 2, 1, partez.
   * Personne ne perd de temps -- le chrono ne part qu'apres.
   */
  decompte: boolean;
  /**
   * Duree d'un coup en secondes. `null` = pas de chrono : il faut trouver le
   * top pour avancer, comme sur le topping infini (SPEC.md §16).
   */
  chrono: number | null;
  /**
   * Demi-cote de la grille, en cases. 7 donne un plateau de 15x15 centre sur
   * l'origine ; `null` laisse la grille infinie.
   */
  bornes: number | null;
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
    valeurs: dictionnaire(DICO_PAR_DEFAUT).valeurs,
    dictionnaire: DICO_PAR_DEFAUT,
    pioche: "probabilites",
    joker: false,
    mode: "topping",
    coupsMax: null,
    dureeMax: null,
    decompte: false,
    chrono: null,
    bornes: null,
    pavage: activeLayout(),
    pavageNom: currentLayout(),
  };
}

/**
 * La configuration sans sa fonction de pavage, donc transportable : sauvegarde
 * sur disque, envoi a un fil de calcul, diffusion a un client.
 */
export interface ConfigSerialisee {
  tirage: number;
  jouables: number;
  primes: Record<number, number>;
  valeurs: Record<string, number>;
  dictionnaire: string;
  pioche: "probabilites" | "sac102" | "sac102boucle";
  joker: boolean;
  mode: "topping" | "duplicate";
  coupsMax: number | null;
  dureeMax: number | null;
  decompte: boolean;
  chrono: number | null;
  bornes: number | null;
  pavageNom: LayoutName | "custom";
}

export function serialiser(cfg: ConfigPartie): ConfigSerialisee {
  return {
    tirage: cfg.tirage, jouables: cfg.jouables,
    primes: { ...cfg.primes }, valeurs: { ...cfg.valeurs },
    dictionnaire: cfg.dictionnaire,
    pioche: cfg.pioche, joker: cfg.joker, mode: cfg.mode,
    coupsMax: cfg.coupsMax, dureeMax: cfg.dureeMax,
    decompte: cfg.decompte, chrono: cfg.chrono,
    bornes: cfg.bornes, pavageNom: cfg.pavageNom,
  };
}

/**
 * Reconstruit une configuration. Le pavage est retrouve par son nom ; un pavage
 * « custom » n'etant pas nommable, on retombe sur le pavage actif du module.
 */
export function deserialiser(plat: ConfigSerialisee): ConfigPartie {
  const nomme = plat.pavageNom !== "custom" ? LAYOUTS[plat.pavageNom] : undefined;
  return {
    tirage: plat.tirage, jouables: plat.jouables,
    primes: plat.primes, valeurs: plat.valeurs, pioche: plat.pioche,
    // Les parties d'avant les dictionnaires multiples n'ont pas ce champ :
    // elles ont toutes ete jouees en francais.
    dictionnaire: plat.dictionnaire ?? DICO_PAR_DEFAUT,
    joker: plat.joker === true,
    mode: plat.mode === "duplicate" ? "duplicate" : "topping",
    coupsMax: plat.coupsMax ?? null,
    dureeMax: plat.dureeMax ?? null,
    decompte: plat.decompte === true,
    chrono: plat.chrono ?? null,
    bornes: plat.bornes ?? null,
    pavage: nomme ?? activeLayout(),
    pavageNom: plat.pavageNom,
  };
}

/**
 * Change le dictionnaire d'une configuration -- ET CE QUI VIENT AVEC.
 *
 * La valeur des lettres suit le lexique : c'est le meme reglage vu de deux
 * cotes, et les separer donnerait un plateau ou le Q vaut huit points dans un
 * lexique qui n'a pas de mot en Q sans U.
 */
export function avecDictionnaire(base: ConfigPartie, id: string): ConfigPartie {
  const d = dictionnaire(id);
  return { ...base, dictionnaire: d.id, valeurs: d.valeurs };
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
