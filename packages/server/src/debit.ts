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
  private readonly capacite: number;

  /**
   * `capacite` separe la RAFALE de la MOYENNE, et vient EN DERNIER : le second
   * argument est l'instant depuis toujours, et l'echanger aurait fausse en
   * silence tous les seaux du jeu -- ainsi que leur test, qui ecrit
   * `new Seau(5, 0)` pour partir de l'instant zero.
   *
   * Par defaut la capacite vaut le debit : le comportement d'origine, mot pour
   * mot. Voir `seauDeRafale` pour l'autre usage.
   */
  constructor(debit: number, maintenant = Date.now(), capacite = debit) {
    this.debit = debit;
    this.capacite = capacite;
    this.jetons = capacite;
    this.vu = maintenant;
  }

  /** Prend un jeton s'il en reste. Rend faux quand le seau est vide. */
  prendre(maintenant = Date.now()): boolean {
    // Le remplissage est CONTINU, pas par paliers : on ne remet pas le compteur
    // a zero toutes les secondes. Sinon deux rafales de part et d'autre d'une
    // frontiere de seconde passeraient ensemble, soit le double du debit.
    const ecoule = Math.max(0, maintenant - this.vu);
    this.jetons = Math.min(this.capacite, this.jetons + ecoule * this.debit / 1000);
    this.vu = maintenant;
    if (this.jetons < 1) return false;
    this.jetons--;
    return true;
  }
}

/**
 * Un seau dont la rafale depasse la moyenne.
 *
 * Pour les mots de passe : quelques essais coup sur coup -- un humain qui
 * retape -- puis un rythme lent, qui ne mene nulle part quand on essaie un
 * dictionnaire.
 */
export function seauDeRafale(debit: number, capacite: number): Seau {
  return new Seau(debit, Date.now(), capacite);
}
