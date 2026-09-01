/**
 * Combien de messages par seconde. Voir SPEC.md §18.
 *
 * Ce n'est pas d'abord une question de charge, c'est une question de TRICHE.
 * Le serveur repond a chaque mot propose « valide, 94 points » : un script qui
 * en soumet mille par seconde trouve le top par force brute, sans rien y
 * connaitre au jeu. Cinq par seconde, c'est le rythme d'un joueur rapide qui
 * tape ; c'est beaucoup trop peu pour balayer un dictionnaire de 407 128 mots.
 *
 * Le second plafond, plus large, protege le reste : un client bogue qui boucle
 * ne doit pas pouvoir occuper le serveur a lui seul.
 */
export const SOUMISSIONS_PAR_SECONDE = 5;
export const MESSAGES_PAR_SECONDE = 30;

/**
 * Un seau a jetons : il se remplit au fil du temps, chaque message en prend un.
 *
 * LA CAPACITE VAUT LE DEBIT D'UNE SECONDE, et c'est voulu. Un plafond strict --
 * « pas deux messages a moins de 200 ms » -- punirait le joueur qui tape deux
 * mots coup sur coup, ce qui arrive quand on a deux idees d'avance. Le seau
 * autorise cette rafale courte tout en tenant la MOYENNE au debit : on peut
 * depenser cinq jetons d'un coup, mais il faut alors une seconde pleine pour
 * les retrouver.
 */
export class Seau {
  private readonly debit: number;
  private jetons: number;
  private vu: number;

  // Champs poses a la main : Node execute le TypeScript en effacant les types,
  // sans rien engendrer, et ne connait donc pas les proprietes de constructeur.
  constructor(debit: number, maintenant = Date.now()) {
    this.debit = debit;
    this.jetons = debit;
    this.vu = maintenant;
  }

  /** Prend un jeton s'il en reste. Rend faux quand le seau est vide. */
  prendre(maintenant = Date.now()): boolean {
    // Le remplissage est CONTINU, pas par paliers : on ne remet pas le compteur
    // a zero toutes les secondes. Sinon deux rafales de part et d'autre d'une
    // frontiere de seconde passeraient ensemble, soit le double du debit.
    const ecoule = Math.max(0, maintenant - this.vu);
    this.jetons = Math.min(this.debit, this.jetons + ecoule * this.debit / 1000);
    this.vu = maintenant;
    if (this.jetons < 1) return false;
    this.jetons--;
    return true;
  }
}
