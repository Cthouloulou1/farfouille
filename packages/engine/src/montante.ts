/**
 * La montante : six parties en topping, a la suite. Voir SPEC.md §23.
 *
 * CE MODULE NE CONNAIT QUE LES SIX FORMATS, et rien de la suite elle-meme. La
 * suite -- l'etape courante, les essais, les cumuls, le droit de recommencer --
 * vit dans le salon, cote serveur (`server/src/montante.ts`). Ici il n'y a que
 * la table des etapes et la facon d'en tirer une configuration.
 *
 * VIT DANS LE MOTEUR pour la meme raison que les categories : trois endroits en
 * ont besoin. Le serveur pour enchainer les etapes, le client pour ecrire
 * « etape 3 sur 6, 7 sur 8 » sans redire la table a sa facon, et le reglage du
 * chrono pour savoir quel plancher s'applique.
 */
import { avec, primesParDefaut, type ConfigPartie } from "./config.ts";
import { grilleDeBornes } from "./categories.ts";

/** Combien d'etapes compte une montante. */
export const ETAPES_MONTANTE = 6;

export interface EtapeMontante {
  /** Le rang de l'etape, de 1 a 6. */
  rang: number;
  /** Le X de « X sur Y » : combien de caramels on peut poser. */
  jouables: number;
  /** Le Y : combien on en tire. */
  tirage: number;
  joker: boolean;
  /**
   * Le nom du format, TEL QUE LE SITE L'APPELLE AILLEURS.
   *
   * Le tableau du §23 ecrit « 8 sur 8 » pour les deux dernieres ; les
   * categories et le panneau de reglages les appellent « 7 et 8 ». C'est le
   * meme format, et un joueur qui lit « 7 et 8 » dans les reglages ne doit pas
   * decouvrir un autre nom au milieu d'une montante.
   */
  nom: string;
}

/**
 * Les six etapes, dans l'ordre. Chacune ajoute une contrainte a la precedente :
 * le joker, puis la huitieme lettre, puis le droit de la poser.
 */
export const ETAPES: readonly EtapeMontante[] = [
  { rang: 1, jouables: 7, tirage: 7, joker: false, nom: "Partie normale" },
  { rang: 2, jouables: 7, tirage: 7, joker: true, nom: "Joker" },
  { rang: 3, jouables: 7, tirage: 8, joker: false, nom: "7 sur 8" },
  { rang: 4, jouables: 7, tirage: 8, joker: true, nom: "7 sur 8 joker" },
  { rang: 5, jouables: 8, tirage: 8, joker: false, nom: "7 et 8" },
  { rang: 6, jouables: 8, tirage: 8, joker: true, nom: "7 et 8 joker" },
];

/** L'etape de ce rang. Un rang hors bornes est ramene dans les bornes. */
export function etapeMontante(rang: number): EtapeMontante {
  const i = Math.min(ETAPES_MONTANTE, Math.max(1, Math.round(rang))) - 1;
  return ETAPES[i]!;
}

/**
 * La configuration de cette etape, batie sur celle de la partie en cours.
 *
 * ELLE N'IMPOSE QUE LE FORMAT ET LE JOKER, ce que la suite decide. Le chrono,
 * le lexique et la grille sont au joueur : ils traversent la montante sans
 * changer, et c'est pour cela qu'une montante se compare a une autre.
 *
 * LE DECOMPTE, LUI, NE VAUT QUE POUR LA PREMIERE. Il donne le depart -- utile
 * une fois, au tout debut de la montante ; repete a chaque etape, il ferait
 * attendre trois secondes avant chaque partie d'une suite qui ne s'arrete deja
 * plus. Seule l'etape 1 le recoit si l'hote l'a coche ; les cinq suivantes
 * demarrent sans lui, quel que soit le reglage.
 *
 * Le reste -- le sac du commerce, un joker par tirage, le mode topping, pas de
 * terme ajoute, les primes du jeu -- n'est pas un choix : c'est ce que
 * `reglagesRecevables` exige d'une partie qui veut porter un record, et chaque
 * etape d'une montante en porte un (SPEC.md §23). Les poser ici plutot que de
 * les supposer evite une montante entiere qui n'entre au tableau qu'a moitie.
 */
export function configDeLEtape(base: ConfigPartie, rang: number): ConfigPartie {
  const e = etapeMontante(rang);
  return avec(base, {
    tirage: e.tirage, jouables: e.jouables, joker: e.joker, jokersParCoup: 1,
    pioche: "sac102", mode: "topping", coupsMax: null, dureeMax: null,
    primes: primesParDefaut(), decompte: rang === 1 ? base.decompte : false,
  });
}

/**
 * Cette grille peut-elle porter une montante ?
 *
 * Les deux grilles bornees, jamais la grille sans fin : six formats jusqu'au
 * bout du sac demandent un bout de sac. Une grille sans fin n'en a pas, donc
 * pas d'etape suivante.
 */
export function montantePossible(bornes: number | null): boolean {
  return grilleDeBornes(bornes) !== null;
}
