/**
 * Ce que le serveur et le client savent tous deux des epreuves. Voir SPEC.md §29.
 *
 * Trois choses, et aucune ne depend de l'un ou de l'autre : le jour d'une
 * partie du jour, le nom d'une partie, et les parties que chaque lexique joue.
 */
import { LAYOUTS } from "./bonus.ts";
import { avec, avecDictionnaire, configParDefaut, primesParDefaut, type ConfigPartie } from "./config.ts";

/**
 * LES LEXIQUES DES PARTIES DU JOUR, dans l'ordre des boutons : ODS, CSW, NWL.
 *
 * Chacun a ses parties, ses graines et ses classements : un tirage anglais n'a
 * rien a faire dans un classement francais.
 */
export const LEXIQUES_DU_JOUR = ["ods9", "csw24", "nwl23"] as const;

/** Une partie telle qu'une regle du jour la decrit. */
export interface ModeleDePartie {
  /** 7 pour la grille normale, 10 pour la super grille. */
  bornes: 7 | 10;
  tirage: number;
  jouables: number;
  joker: boolean;
  /** Un joker par tirage, ou deux. Un quand le champ manque. */
  jokersParCoup?: 1 | 2;
  /** Secondes par coup. */
  chrono: number;
}

const normale = (chrono: number): ModeleDePartie =>
  ({ bornes: 7, tirage: 7, jouables: 7, joker: false, chrono });

/**
 * CE QUE CHAQUE LEXIQUE JOUE POUR COMMENCER.
 *
 * Un seul modele par partie, fixe. La structure est celle des regles du jour a
 * venir -- des modeles ponderes, des plages -- dont on ne met rien maintenant.
 */
export const PARTIES_DU_JOUR: Readonly<Record<string, readonly ModeleDePartie[]>> = {
  ods9: [normale(30), { ...normale(60), bornes: 10 }],
  csw24: [normale(120), normale(120), { ...normale(120), joker: true }],
  nwl23: [normale(120), normale(120), { ...normale(120), joker: true }],
};

/**
 * La configuration d'une partie d'epreuve.
 *
 * Tout ce qui ne se lit pas dans le modele prend la valeur d'une partie
 * normale : sac du commerce, primes d'usage, topping, sans terme ni decompte.
 * Le pavage et le nombre de sacs decoulent de la grille, comme dans un salon.
 */
export function configDuModele(m: ModeleDePartie, lexique: string): ConfigPartie {
  const superGrille = m.bornes === 10;
  return avec(avecDictionnaire(configParDefaut(), lexique), {
    tirage: m.tirage, jouables: m.jouables,
    joker: m.joker, jokersParCoup: m.joker ? (m.jokersParCoup ?? 1) : 1,
    primes: primesParDefaut(),
    pioche: "sac102", sacs: superGrille ? 2 : 1,
    mode: "topping", coupsMax: null, dureeMax: null,
    decompte: false, toppingCollaboratif: false,
    chrono: m.chrono,
    bornes: m.bornes,
    pavage: superGrille ? LAYOUTS.super21 : LAYOUTS.classique15,
    pavageNom: superGrille ? "super21" : "classique15",
  });
}

/**
 * LA POOL DES RETIRAGES (SPEC.md §29).
 *
 * Les parties tirees d'office suivent les modeles fixes ci-dessus. « Tout
 * retirer », ou une partie ajoutee au-dela de ces modeles, tire ici. La meme
 * pool pour les trois lexiques, en attendant les regles du jour.
 */
export const POOL_DU_JOUR: readonly { poids: number; modele: ModeleDePartie }[] = [
  { poids: 3, modele: normale(30) },
  { poids: 3, modele: normale(60) },
  { poids: 2, modele: normale(120) },
  { poids: 2, modele: { ...normale(60), bornes: 10 } },
  { poids: 1, modele: { ...normale(120), bornes: 10 } },
  { poids: 2, modele: { ...normale(120), joker: true } },
  { poids: 1, modele: { ...normale(120), tirage: 8 } },
];

/** Un modele tire dans la pool, selon les poids. */
export function tirerUnModele(alea: () => number = Math.random): ModeleDePartie {
  const total = POOL_DU_JOUR.reduce((a, x) => a + x.poids, 0);
  let r = alea() * total;
  for (const x of POOL_DU_JOUR) {
    r -= x.poids;
    if (r < 0) return { ...x.modele };
  }
  return { ...POOL_DU_JOUR[0]!.modele };
}

/** Le modele d'une configuration d'epreuve : ce que l'editeur de partie regle. */
export function modeleDeLaConfig(
  c: { tirage: number; jouables: number; joker: boolean; jokersParCoup: number; bornes: number | null; chrono: number | null },
): ModeleDePartie {
  return {
    bornes: c.bornes === 10 ? 10 : 7, tirage: c.tirage, jouables: c.jouables,
    joker: c.joker, ...(c.joker && c.jokersParCoup === 2 ? { jokersParCoup: 2 as const } : {}),
    chrono: c.chrono ?? 60,
  };
}

/**
 * Un modele recu du dehors, verifie champ par champ. Rend le modele propre, ou
 * le message qui dit ce qui ne va pas.
 */
export function modeleRecevable(x: unknown): ModeleDePartie | string {
  if (x === null || typeof x !== "object") return "réglages de partie illisibles";
  const o = x as Record<string, unknown>;
  const bornes = o["bornes"] === 10 ? 10 : o["bornes"] === 7 ? 7 : null;
  if (bornes === null) return "grille inconnue";
  const tirage = Number(o["tirage"]), jouables = Number(o["jouables"]);
  if (!Number.isInteger(tirage) || tirage < 2 || tirage > 15) return "le tirage va de 2 à 15 lettres";
  if (!Number.isInteger(jouables) || jouables < 2 || jouables > tirage) {
    return "on pose de 2 lettres au plus à tout le tirage";
  }
  const chrono = Number(o["chrono"]);
  if (!Number.isInteger(chrono) || chrono < 5 || chrono > 3600) {
    return "le temps par coup va de 5 secondes à une heure";
  }
  const joker = o["joker"] === true;
  const jokersParCoup = joker && o["jokersParCoup"] === 2 ? 2 : 1;
  if (joker && jokersParCoup >= tirage) return "il faut au moins une vraie lettre au tirage";
  return { bornes, tirage, jouables, joker, ...(jokersParCoup === 2 ? { jokersParCoup: 2 as const } : {}), chrono };
}

/**
 * UNE HEURE DE PARIS, en instant : `2026-09-20T18:00` -> millisecondes.
 *
 * Les dates d'un tournoi se saisissent a l'heure du site, quel que soit le
 * fuseau du navigateur. On part de l'heure lue comme si elle etait universelle,
 * puis on corrige du decalage de Paris a cet instant-la -- deux passes suffisent,
 * y compris la nuit du changement d'heure.
 */
export function instantDeParis(texte: unknown): number | null {
  if (typeof texte !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(texte);
  if (m === null) return null;
  const voulu = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let instant = voulu;
  for (let i = 0; i < 2; i++) instant = voulu - (murDeParis(instant) - instant);
  return Number.isFinite(instant) ? instant : null;
}

/** L'heure qu'affiche une horloge de Paris a cet instant, lue comme universelle. */
function murDeParis(instant: number): number {
  const p: Record<string, string> = {};
  for (const x of HEURE_DE_PARIS.formatToParts(new Date(instant))) p[x.type] = x.value;
  return Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]),
    Number(p["hour"]), Number(p["minute"]));
}

/** Un instant, a l'heure de Paris : `2026-09-20T18:00`, pour un champ de saisie. */
export function heureDeParis(instant: number): string {
  return new Date(murDeParis(instant)).toISOString().slice(0, 16);
}

/**
 * LE CHRONO D'UN NOM DE PARTIE : `30s`, `60s`, `1min30`, `2min`.
 *
 * En secondes jusqu'a la minute, en minutes au-dela, les secondes restantes
 * accolees. C'est l'ecriture de Zulu (SPEC.md §29).
 */
export function chronoDuNom(secondes: number): string {
  if (secondes <= 60) return `${secondes}s`;
  const min = Math.floor(secondes / 60), s = secondes % 60;
  return s === 0 ? `${min}min` : `${min}min${String(s).padStart(2, "0")}`;
}

/**
 * LE NOM D'UNE PARTIE SE LIT DANS SES REGLAGES, il ne se choisit pas.
 *
 * On ne precise que ce qui s'ecarte de la partie normale : le format, le joker,
 * la super grille. Chaque morceau se separe du suivant par une virgule :
 * `Normale, 60s`, `5/9, 1min30`, `Normale, super grille, 60s`,
 * `11/11, super grille, 3min`.
 * `t` traduit les mots ; le serveur, qui n'affiche rien, s'en passe.
 */
export function nomDeLaPartie(
  c: { tirage: number; jouables: number; joker: boolean; jokersParCoup?: number;
       bornes: number | null; chrono: number | null },
  t: (s: string) => string = (s) => s,
): string {
  const joker = !c.joker ? "" : c.jokersParCoup === 2 ? t("double joker") : t("joker");
  const format = c.tirage === 7 && c.jouables === 7
    ? (joker === "" ? t("Normale") : joker.charAt(0).toUpperCase() + joker.slice(1))
    : `${c.jouables}/${c.tirage}${joker === "" ? "" : ` ${joker}`}`;
  return [format, ...(c.bornes === 10 ? [t("super grille")] : []),
    ...(c.chrono === null ? [] : [chronoDuNom(c.chrono)])].join(", ");
}

/** Ce qu'il faut de minutes apres minuit pour que le jour change : 5 h 30. */
const BASCULE_MINUTES = 5 * 60 + 30;

const HEURE_DE_PARIS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/**
 * LE JOUR DES PARTIES DU JOUR, a un instant donne : `2026-09-15`.
 *
 * Il change a 5 h 30, HEURE DE PARIS, changement d'heure compris. L'heure se lit
 * dans le fuseau `Europe/Paris` et jamais par un decalage fixe, qui se
 * tromperait d'une heure la moitie de l'annee. Avant 5 h 30, on est encore dans
 * les parties de la veille.
 */
export function jourDe(instant: number): string {
  const p: Record<string, string> = {};
  for (const x of HEURE_DE_PARIS.formatToParts(new Date(instant))) p[x.type] = x.value;
  const minutes = Number(p["hour"]) * 60 + Number(p["minute"]);
  const date = Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]));
  const jour = minutes < BASCULE_MINUTES ? date - 86_400_000 : date;
  return new Date(jour).toISOString().slice(0, 10);
}

/** Le jour suivant, ou precedent : `decalerLeJour("2026-09-15", 1)`. */
export function decalerLeJour(jour: string, n: number): string {
  const [a, m, j] = jour.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, j) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Un jour bien forme, et rien d'autre : il finit dans des noms de fichiers. */
export function jourValide(jour: unknown): jour is string {
  return typeof jour === "string" && /^\d{4}-\d{2}-\d{2}$/.test(jour);
}
