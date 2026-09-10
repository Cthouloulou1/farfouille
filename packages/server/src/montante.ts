/**
 * La montante d'un salon : six parties en topping, a la suite. Voir SPEC.md §23.
 *
 * ELLE VIT DANS LE SALON, EN MEMOIRE, ET RIEN DU MODELE DE PARTIE NE CHANGE.
 * Chaque etape est une partie ordinaire, avec son journal, sa graine et sa
 * variante ; toutes portent le meme identifiant de suite dans leur en-tete. Ce
 * qui est nouveau est ici : la suite, l'etape courante, les essais et les
 * cumuls.
 *
 * DEUX COMPTES QUI NE SE COMPTENT PAS PAREIL, et c'est tout l'interet de ce
 * fichier :
 *
 * - **le temps compte tout**, y compris les essais abandonnes. Recommencer une
 *   etape est un choix qui a un prix ;
 * - **le negatif ne compte que ce qui reste.** L'essai abandonne est oublie, et
 *   le rouge s'eteint avec lui.
 *
 * Sans ce prix, on recommencerait jusqu'a tomber sur une grille facile, et le
 * tableau ne classerait plus que la patience.
 *
 * UNE MONTANTE QUE LE SERVEUR PERD EST PERDUE. Elle se nourrit de
 * l'observation, qui vit en memoire elle aussi : un serveur qui redemarre en
 * cours de partie rend deja cette partie inelegible, et ce qu'il faudrait
 * ecrire pour sauver la montante est exactement ce que le journal d'une partie
 * ne dit pas.
 */
import { randomUUID } from "node:crypto";
import { compte } from "./comptes.ts";
import {
  refDeLaGraine, type CoupNote, type EtapeDeMontante, type EtapeObservee,
  type Manche, empreinteDuLexique,
} from "./records.ts";
import {
  ETAPES_MONTANTE, etapeMontante, montantePossible,
} from "../../engine/src/montante.ts";
import { grilleDeBornes } from "../../engine/src/categories.ts";
import type { ConfigPartie } from "../../engine/src/config.ts";

/** Un essai d'une etape : une partie jouee, retenue ou abandonnee. */
export interface EssaiDEtape {
  /** Le rang de l'etape, de 1 a 6. */
  rang: number;
  /** Le numero de l'essai sur cette etape, a partir de 1. */
  essai: number;
  partie: string;
  graine: string;
  ref: string;
  categorie: string | null;
  coups: number;
  temps: number;
  cumul: number;
  farfouilles: number;
  negatif: number;
  rates: number;
  rateAuDernierCoup: boolean;
  tops: Record<string, number>;
  /** L'etape comptait pour un record. Voir `EtapeObservee.valide`. */
  valide: boolean;
  /**
   * Retenu, ou abandonne au profit d'un essai suivant.
   *
   * UN ESSAI ABANDONNE NE DISPARAIT PAS : son temps reste au compteur. C'est
   * pour cela qu'on le garde ici plutot que de le retirer de la liste.
   */
  retenu: boolean;
  coupCher: CoupNote | null;
  coupPasCher: CoupNote | null;
}

export interface Montante {
  /** L'identifiant de la suite, celui que porte l'en-tete de chaque etape. */
  id: string;
  /** Le rang de l'etape en cours, de 1 a 6. */
  rang: number;
  /** Le numero de l'essai en cours sur cette etape. */
  essai: number;
  /** Les essais clos, dans l'ordre ou ils se sont joues. */
  essais: EssaiDEtape[];
  /**
   * L'etape en cours est-elle close ?
   *
   * Elle l'est des que sa partie se termine, et le reste jusqu'a ce que l'hote
   * lance la suivante. C'est ce qui evite de compter deux fois : une fois dans
   * la partie qui vient de finir, une fois dans l'essai qu'elle a laisse.
   */
  close: boolean;
  /** Les six etapes sont derriere, et la ligne est ecrite. */
  finie: boolean;
  /**
   * PAUSE ENTRE LES PARTIES, decidee par l'hote et eteinte par defaut.
   *
   * Eteinte, l'etape suivante part d'elle-meme des que la precedente se termine
   * : c'est une montante, on ne reprend pas son souffle. Allumee, la montante
   * attend l'hote -- c'est le seul moyen de regarder la feuille de route ou de
   * revoir les coups d'une etape qu'on vient de finir.
   *
   * La sixieme ne s'enchaine jamais : il n'y a rien apres, et la derniere grille
   * reste a l'ecran.
   */
  pause: boolean;
  /**
   * LA PAUSE EN COURS EST-ELLE CELLE DU RATE, OU CELLE DE L'HOTE ?
   *
   * Vrai tant que la pause allumee n'est due qu'a un rate au dernier coup, et
   * a rien d'autre. Recommencer l'etape l'eteint alors avec elle -- sans quoi
   * un rate imposerait une pause a toutes les tentatives suivantes, ce que
   * l'hote n'a jamais demande. Un geste manuel sur l'interrupteur, dans un sens
   * comme dans l'autre, l'efface aussitot : la pause devient alors un choix, et
   * un choix survit a la reprise.
   */
  pauseAuto: boolean;
  creeLe: number;
}

export function nouvelleMontante(): Montante {
  return {
    id: randomUUID(), rang: 1, essai: 1, essais: [],
    close: false, finie: false, pause: false, pauseAuto: false, creeLe: Date.now(),
  };
}

/** Ce que l'en-tete du journal de l'etape en cours porte. */
export function marqueDeLaMontante(
  m: Montante,
): { id: string; etape: number; essai: number } {
  return { id: m.id, etape: m.rang, essai: m.essai };
}

/** Les essais qui comptent : ceux qu'aucune reprise n'a remplaces. */
function retenus(m: Montante): EssaiDEtape[] {
  return m.essais.filter((e) => e.retenu);
}

/**
 * La montante a-t-elle cesse de pretendre a un record ?
 *
 * SE DEDUIT, NE SE GARDE PAS. Un essai qui a mal fini peut etre abandonne par
 * une reprise : la montante retrouve alors son droit au tableau, et une
 * variable gardee aurait continue de dire le contraire.
 */
export function montantePerdue(m: Montante): boolean {
  return retenus(m).some((e) => !e.valide);
}

/** Les cumuls de la montante, tels qu'ils s'affichent. */
export interface TotauxDeMontante {
  /** Somme des coups de TOUS les essais, abandons compris. */
  temps: number;
  /** Sur les seuls essais retenus. */
  negatif: number;
  rates: number;
  coups: number;
  cumul: number;
  farfouilles: number;
  tops: Record<string, number>;
}

/**
 * Les cumuls, en cet instant.
 *
 * `enCours` est l'observation de la partie qui tourne. Elle ne s'ajoute que si
 * l'etape n'est pas close : une fois close, elle a laisse son essai, et
 * l'ajouter la compterait deux fois.
 */
export function totaux(m: Montante, enCours?: EtapeObservee): TotauxDeMontante {
  const vivant = m.close ? undefined : enCours;
  const t: TotauxDeMontante = {
    // LE TEMPS COMPTE TOUT. C'est ce qui rend le bouton de reprise honnete.
    temps: m.essais.reduce((a, e) => a + e.temps, 0) + (vivant?.temps ?? 0),
    negatif: 0, rates: 0, coups: 0, cumul: 0, farfouilles: 0, tops: {},
  };
  for (const e of [...retenus(m), ...(vivant === undefined ? [] : [vivant])]) {
    t.negatif += e.negatif;
    t.rates += e.rates;
    t.coups += e.coups;
    t.cumul += e.cumul;
    t.farfouilles += e.farfouilles;
    for (const [nom, n] of Object.entries(e.tops)) t.tops[nom] = (t.tops[nom] ?? 0) + n;
  }
  return t;
}

/**
 * L'etape en cours vient de se terminer : elle laisse son essai.
 *
 * L'etape ne passe PAS a la suivante ici. C'est l'hote qui lance la suite, et
 * c'est ce qui lui laisse le temps de regarder la grille, de compter ce qu'il a
 * laisse, et de cliquer sur la reprise s'il le veut (SPEC.md §23).
 *
 * UN RATE AU DERNIER COUP COCHE LA PAUSE TOUTE SEULE -- SI ELLE NE L'ETAIT PAS
 * DEJA.
 *
 * Sans elle, l'enchainement automatique filerait vers l'etape suivante deux
 * secondes plus tard, sans laisser le temps de choisir -- et une montante doit
 * se toper normalement : recommencer cette etape est le seul moyen d'y
 * pretendre encore. La pause se coche donc d'elle-meme, comme si l'hote venait
 * de l'allumer : les deux boutons paraissent alors cote a cote, reprendre ou
 * continuer quand meme.
 *
 * MAIS SI L'HOTE L'AVAIT DEJA ALLUMEE LUI-MEME, ce rate ne doit pas se
 * l'approprier : `pauseAuto` reste tel quel, et la reprise qui suivra la
 * laissera allumee (voir `reprendreLEtape`). Se l'approprier quand meme
 * effacerait, a la prochaine reprise, un choix que l'hote avait fait avant
 * meme que le rate n'arrive.
 */
export function cloreLEtape(m: Montante, e: EtapeObservee): void {
  if (m.close) return;
  m.close = true;
  m.essais.push({
    rang: m.rang, essai: m.essai,
    partie: e.partie, graine: e.graine, ref: e.ref, categorie: e.categorie,
    coups: e.coups, temps: e.temps, cumul: e.cumul, farfouilles: e.farfouilles,
    negatif: e.negatif, rates: e.rates, rateAuDernierCoup: e.rateAuDernierCoup,
    tops: e.tops, valide: e.valide, retenu: true,
    coupCher: e.coupCher, coupPasCher: e.coupPasCher,
  });
  if (e.rateAuDernierCoup && !m.pause) { m.pause = true; m.pauseAuto = true; }
}

/** Reste-t-il une etape apres celle-ci ? */
export function ilResteUneEtape(m: Montante): boolean {
  return m.rang < ETAPES_MONTANTE;
}

/**
 * Combien de fois ce rang a deja ete tente, retenu ou non.
 *
 * ON NE REDONNE PAS UN NUMERO DEJA PORTE. Reprendre l'etape 3 abandonne l'etape
 * 4 deja jouee ; y revenir plus tard en ferait un deuxieme essai, et lui rendre
 * le numero 1 laisserait deux parties de la meme suite marquees « etape 4,
 * essai 1 » dans leur en-tete -- sans rien pour les distinguer.
 */
function essaisDuRang(m: Montante, rang: number): number {
  return m.essais.reduce((a, e) => e.rang === rang ? Math.max(a, e.essai) : a, 0);
}

/** L'etape suivante commence. Rend son rang, ou `null` s'il n'y en a plus. */
export function passerALEtapeSuivante(m: Montante): number | null {
  if (!m.close || !ilResteUneEtape(m)) return null;
  m.rang++;
  m.essai = essaisDuRang(m, m.rang) + 1;
  m.close = false;
  return m.rang;
}

/**
 * QUELLE ETAPE LE BOUTON DE REPRISE PROPOSE, ou `null` s'il ne parait pas.
 *
 * C'EST TOUJOURS L'ETAPE EN COURS -- celle qu'on regarde -- des qu'un coup y
 * est rate, et jamais une etape d'avant. Elle vit jusqu'a la fin de cette
 * etape, close comprise : on rate au milieu d'une 7 sur 8, on a toute la
 * 7 sur 8 pour se decider.
 *
 * UN RATE AU DERNIER COUP NE FAIT PLUS EXCEPTION. Il fermait autrefois
 * l'etape et laissait le bouton se deplacer dans l'etape suivante -- mais
 * l'enchainement automatique s'arrete desormais de lui-meme des qu'un dernier
 * coup est rate (`cloreLEtape` coche la pause), si bien qu'on ne quitte
 * jamais une etape ratee sans qu'on ait pu le voir. Le bouton reste donc
 * toujours sur l'etape qu'on a sous les yeux : rien a chercher ailleurs.
 *
 * Passer a l'etape suivante -- de son plein gre, une fois qu'on a decide de
 * continuer -- clot definitivement la fenetre : le rate reste au compteur, et
 * ne se reprend plus.
 */
export function etapeReprenable(m: Montante, enCours?: EtapeObservee): number | null {
  if (m.finie) return null;
  // L'etape en cours, vivante ou close. Close, c'est son essai qui la dit ;
  // vivante, c'est l'observation de la partie qui tourne.
  const ici = m.close
    ? [...m.essais].reverse().find((e) => e.rang === m.rang && e.retenu)
    : enCours;
  return ici !== undefined && ici.rates > 0 ? m.rang : null;
}

/**
 * On recommence cette etape.
 *
 * TOUT CE QUI A ETE JOUE DEPUIS EST ABANDONNE : son temps reste au compteur,
 * son negatif s'efface avec le reste. Rend le rang repris, ou `null` si l'etape
 * n'est plus reprenable.
 */
export function reprendreLEtape(
  m: Montante, rang: number, enCours?: EtapeObservee,
): number | null {
  if (etapeReprenable(m, enCours) !== rang) return null;
  // LA PAUSE QUE LE RATE AVAIT COCHEE NE SURVIT PAS A LA REPRISE. Elle a fait
  // son office -- laisser le temps de choisir -- et la tentative qui repart
  // n'a pas a en heriter. Celle que l'hote a allumee lui-meme, en revanche,
  // reste : ce n'est plus le rate qui parle, mais son choix.
  if (m.pauseAuto) { m.pause = false; m.pauseAuto = false; }
  // RECOMMENCER L'ETAPE 1, C'EST RECOMMENCER LA MONTANTE. Rien n'a encore ete
  // accompli : le chrono repart de zero, et non pas « tout sauf le negatif ».
  // C'est la seule exception a « le temps compte tout » -- et elle n'en est pas
  // vraiment une, puisqu'il n'y a rien avant l'etape 1 a garder au compteur.
  if (rang === 1) {
    const essais = Math.max(essaisDuRang(m, 1), m.close ? 0 : m.essai);
    m.essais = [];
    m.rang = 1;
    m.essai = essais + 1;
    m.close = false;
    return 1;
  }
  for (const e of m.essais) {
    if (e.rang >= rang) e.retenu = false;
  }
  let essais = essaisDuRang(m, rang);
  // L'essai en cours, s'il tourne encore, compte lui aussi comme un essai de
  // son rang : on ne redonne pas le numero 2 a une troisieme tentative.
  if (!m.close && m.rang === rang) essais = Math.max(essais, m.essai);
  m.rang = rang;
  m.essai = essais + 1;
  m.close = false;
  return rang;
}

/**
 * La montante est-elle achevee ?
 *
 * PAS SEULEMENT « LA SIXIEME ETAPE EST CLOSE ». Tant qu'une reprise est
 * proposee, la montante n'est pas finie : l'hote a un choix a faire, et c'est
 * precisement le moment ou ce choix compte le plus -- recommencer la derniere
 * etape pour effacer son negatif, au prix du temps deja passe.
 */
export function montanteAchevable(m: Montante): boolean {
  return !m.finie && m.close && !ilResteUneEtape(m);
}

/** La montante se termine d'elle-meme : rien a reprendre, rien a jouer. */
export function montanteFinieDElleMeme(m: Montante, enCours?: EtapeObservee): boolean {
  return montanteAchevable(m) && etapeReprenable(m, enCours) === null;
}

/**
 * La ligne de la montante, ou `null` si elle n'en merite pas.
 *
 * IL FAUT LES SIX ETAPES, chacune valide et retenue une seule fois. Une
 * montante dont une etape n'a pas ete au bout de son sac, ou que le serveur a
 * observee a moitie, se joue jusqu'a la fin mais n'entre pas au tableau.
 */
export function mancheDeLaMontante(m: Montante, cfg: ConfigPartie): Manche | null {
  const grille = grilleDeBornes(cfg.bornes);
  if (grille === null || !montantePossible(cfg.bornes)) return null;
  const gardes = retenus(m);
  const parRang = new Map<number, EssaiDEtape>();
  for (const e of gardes) {
    if (parRang.has(e.rang)) return null;   // deux essais retenus au meme rang
    parRang.set(e.rang, e);
  }
  const suite: EssaiDEtape[] = [];
  for (let rang = 1; rang <= ETAPES_MONTANTE; rang++) {
    const e = parRang.get(rang);
    if (e === undefined || !e.valide || e.categorie === null) return null;
    suite.push(e);
  }
  const t = totaux(m);
  const topee = suite.every((e) => e.rates === 0);
  const classement = Object.entries(t.tops).sort((a, b) => b[1] - a[1]);
  // SOLO VEUT DIRE QU'UN SEUL JOUEUR A TROUVE TOUS LES TOPS, ici comme ailleurs
  // -- ceux des six etapes, sans en laisser un a personne d'autre.
  const solo = topee && classement.length === 1 ? classement[0]![0] : null;
  const chers = suite.map((e) => e.coupCher).filter((c) => c !== null);
  const pasChers = suite.map((e) => e.coupPasCher).filter((c) => c !== null);
  const etapes: EtapeDeMontante[] = suite.map((e) => ({
    rang: e.rang, ref: e.ref, categorie: e.categorie!,
    coups: e.coups, temps: e.temps, negatif: e.negatif,
    topee: e.rates === 0, essai: e.essai,
  }));
  return {
    // LA REFERENCE SORT DE L'IDENTIFIANT DE LA SUITE, comme celle d'une partie
    // sort de sa graine : unique, stable, et sans rapport avec la graine
    // d'aucune des six etapes.
    ref: refDeLaGraine(m.id),
    // La montante n'a pas de fichier a elle. `partie` nomme le salon ou elle
    // s'est jouee, `graine` porte son identifiant de suite : c'est ce qui la
    // distingue au journal, et rien de tout cela ne se rejoue directement --
    // ce sont les six etapes qu'on relit, chacune par sa reference.
    partie: suite[suite.length - 1]!.partie,
    graine: m.id,
    at: Date.now(),
    categorie: "montante",
    grille,
    lexique: cfg.dictionnaire,
    empreinte: empreinteDuLexique(cfg.dictionnaire),
    chrono: cfg.chrono,
    coups: t.coups,
    temps: t.temps,
    cumul: t.cumul,
    farfouilles: t.farfouilles,
    topee,
    negatif: t.negatif,
    joueurs: classement.map(([nom, n]) => ({
      nom, tops: n, invite: compte(nom) === undefined,
    })),
    solo,
    coupCher: chers.sort((a, b) => b.score - a.score)[0] ?? null,
    coupPasCher: pasChers.sort((a, b) => a.score - b.score)[0] ?? null,
    etapes,
  };
}

/** Ce que le client sait de la montante du salon. */
export interface MontantePublique {
  id: string;
  /** Le rang de l'etape en cours, de 1 a 6. */
  rang: number;
  etapes: number;
  essai: number;
  /** Le nom du format de l'etape en cours : « 7 sur 8 », « 7 et 8 joker »... */
  nom: string;
  /** Le nom du format de l'etape suivante, ou `null` s'il n'y en a plus. */
  suivante: string | null;
  /** Somme des coups de tous les essais, en millisecondes. */
  temps: number;
  negatif: number;
  /** Combien de coups personne n'a trouves, sur les essais retenus. */
  rates: number;
  coups: number;
  cumul: number;
  /** L'etape que le bouton de reprise propose, ou `null`. */
  reprenable: number | null;
  /** Le nom du format de cette etape-la. */
  nomReprenable: string | null;
  /** L'etape en cours est close : l'hote peut lancer la suite. */
  close: boolean;
  /** L'hote a demande une pause entre les parties. */
  pause: boolean;
  /** Les six etapes sont derriere. */
  finie: boolean;
  /** La montante ne pretend plus a un record. */
  perdue: boolean;
}

export function montantePublique(m: Montante, enCours?: EtapeObservee): MontantePublique {
  const t = totaux(m, enCours);
  const repris = etapeReprenable(m, enCours);
  return {
    id: m.id,
    rang: m.rang,
    etapes: ETAPES_MONTANTE,
    essai: m.essai,
    nom: etapeMontante(m.rang).nom,
    suivante: ilResteUneEtape(m) ? etapeMontante(m.rang + 1).nom : null,
    temps: t.temps,
    negatif: t.negatif,
    rates: t.rates,
    coups: t.coups,
    cumul: t.cumul,
    reprenable: repris,
    nomReprenable: repris === null ? null : etapeMontante(repris).nom,
    close: m.close,
    pause: m.pause,
    finie: m.finie,
    perdue: montantePerdue(m),
  };
}
