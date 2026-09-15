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
    joker: m.joker, jokersParCoup: 1,
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
