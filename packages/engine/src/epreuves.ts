/**
 * Ce que le serveur et le client savent tous deux des epreuves. Voir SPEC.md §29.
 *
 * Quatre choses, et aucune ne depend de l'un ou de l'autre : le jour d'une
 * partie du jour, le nom d'une partie, les parties que chaque lexique joue, et
 * les consignes dont on tire une partie.
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

/** Une prime par nombre de caramels poses. Une entree absente vaut zero. */
export type Primes = Record<number, number>;

/** Une partie telle qu'une consigne l'a tiree : plus rien n'y est au hasard. */
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
  /** Les primes, quand elles ne sont pas celles d'usage. */
  primes?: Primes;
}

const normale = (chrono: number): ModeleDePartie =>
  ({ bornes: 7, tirage: 7, jouables: 7, joker: false, chrono });

/**
 * CE QUE CHAQUE LEXIQUE JOUE FAUTE DE CONSIGNES.
 *
 * Les modeles de la semaine (SPEC.md §29) decident des parties du jour des
 * qu'ils existent. Un lexique dont le jour de la semaine n'a pas de consignes
 * joue ceci.
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
 * normale : sac du commerce, topping, sans terme ni decompte. Le pavage et le
 * nombre de sacs decoulent de la grille, comme dans un salon.
 */
export function configDuModele(m: ModeleDePartie, lexique: string): ConfigPartie {
  const superGrille = m.bornes === 10;
  return avec(avecDictionnaire(configParDefaut(), lexique), {
    tirage: m.tirage, jouables: m.jouables,
    joker: m.joker, jokersParCoup: m.joker ? (m.jokersParCoup ?? 1) : 1,
    primes: m.primes ?? primesParDefaut(),
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
 * Elle ne sert plus qu'a un lexique sans consignes pour ce jour de la semaine :
 * « Tout retirer » et les parties ajoutees y puisent en dernier recours.
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

// --------------------------------------------------------------- les primes

/** Les primes d'usage, reduites a ce qu'on peut vraiment poser. */
export function primesDUsage(jouables: number): Primes {
  const d = primesParDefaut(), t: Primes = {};
  for (let n = 2; n <= jouables; n++) if ((d[n] ?? 0) !== 0) t[n] = d[n]!;
  return t;
}

/**
 * Ces primes s'ecartent-elles de l'usage ? On ne regarde que les nombres de
 * caramels qu'on peut poser : au-dela, la prime ne servirait jamais.
 */
export function primesLibres(primes: Readonly<Primes> | undefined, jouables: number): boolean {
  if (primes === undefined) return false;
  const d = primesParDefaut();
  for (let n = 2; n <= jouables; n++) if ((primes[n] ?? 0) !== (d[n] ?? 0)) return true;
  return false;
}

/** Les primes reduites aux caramels posables, sans les zeros. */
export function primesReduites(primes: Readonly<Primes>, jouables: number): Primes {
  const t: Primes = {};
  for (let n = 2; n <= jouables; n++) if ((primes[n] ?? 0) > 0) t[n] = primes[n]!;
  return t;
}

// ------------------------------------------------------------ les consignes

/** Le format d'une consigne : exact, une plage, ou tout au hasard. */
export type FormatDeConsigne =
  | { t: "exact"; tirage: number; jouables: number }
  | { t: "plage"; jouablesMin: number; jouablesMax: number; tirageMin: number; tirageMax: number }
  | { t: "alea" };

/**
 * UNE CONSIGNE : un modele dont certaines lignes sont laissees au sort.
 *
 * C'est ce que l'editeur de partie rend. Un modele de la semaine le garde tel
 * quel et le tire chaque nuit ; une partie de demain le tire tout de suite.
 */
export interface ConsigneDePartie {
  bornes: 7 | 10 | "alea";
  format: FormatDeConsigne;
  /** Le tirage et les posables sont le meme nombre : 2 sur 2, 3 sur 3... */
  egal: boolean;
  joker: 0 | 1 | 2 | "alea";
  chrono: number | "alea";
  /** Les primes voulues, le sort, ou celles d'usage. */
  primes: Primes | "alea" | null;
}

/** Les bornes du chrono tire au sort : de 15 secondes a 3 minutes. */
export const CHRONO_ALEA_MIN = 15;
export const CHRONO_ALEA_MAX = 180;
const PAS_DU_CHRONO = 5;

const entier = (alea: () => number, min: number, max: number): number =>
  min + Math.floor(alea() * (max - min + 1));

const borne = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/**
 * DES PRIMES TIREES AU SORT, ET QUI RESTENT DES PRIMES (SPEC.md §29).
 *
 * Un seuil, une base, un pas : chaque caramel au-dela du seuil ajoute le pas.
 * Une table qui decroitrait, ou qui recompenserait deux caramels autant que
 * huit, ne serait pas une variante mais une erreur.
 */
export function tirerLesPrimes(jouables: number, alea: () => number = Math.random): Primes {
  const seuil = entier(alea, Math.max(2, jouables - 2), Math.max(2, jouables));
  const base = 5 * entier(alea, 4, 16);
  const pas = 5 * entier(alea, 2, 8);
  const t: Primes = {};
  for (let n = seuil; n <= jouables; n++) t[n] = base + (n - seuil) * pas;
  return t;
}

/** Le joker tire au sort : sans (3 chances), un (2), deux (1). */
function tirerLeJoker(alea: () => number): 0 | 1 | 2 {
  const r = entier(alea, 1, 6);
  return r <= 3 ? 0 : r <= 5 ? 1 : 2;
}

/** UNE PARTIE TIREE D'UNE CONSIGNE. Le format d'abord : les primes en dependent. */
export function tirerUneConsigne(c: ConsigneDePartie, alea: () => number = Math.random): ModeleDePartie {
  const bornes = c.bornes === "alea" ? (alea() < 0.5 ? 7 : 10) : c.bornes;

  let tirage: number, jouables: number;
  if (c.format.t === "exact") {
    jouables = c.format.jouables;
    tirage = c.format.tirage;
  } else if (c.format.t === "plage") {
    jouables = entier(alea, c.format.jouablesMin, c.format.jouablesMax);
    tirage = entier(alea, c.format.tirageMin, c.format.tirageMax);
  } else if (c.egal) {
    jouables = entier(alea, 2, 15);
    tirage = jouables;
  } else {
    tirage = entier(alea, 2, 15);
    jouables = entier(alea, 2, tirage);
  }
  if (c.egal) tirage = jouables;
  tirage = borne(Math.round(tirage), 2, 15);
  jouables = borne(Math.round(jouables), 2, tirage);

  // LE JOKER NE MANGE PAS TOUT LE TIRAGE : il faut au moins une vraie lettre.
  let joker = c.joker === "alea" ? tirerLeJoker(alea) : c.joker;
  if (joker >= tirage) joker = (tirage - 1) as 0 | 1 | 2;

  const chrono = c.chrono === "alea"
    ? CHRONO_ALEA_MIN + PAS_DU_CHRONO * entier(alea, 0, (CHRONO_ALEA_MAX - CHRONO_ALEA_MIN) / PAS_DU_CHRONO)
    : borne(Math.round(c.chrono), 5, 3600);

  const primes = c.primes === "alea" ? tirerLesPrimes(jouables, alea)
    : c.primes === null ? undefined : primesReduites(c.primes, jouables);

  return {
    bornes, tirage, jouables, joker: joker > 0,
    ...(joker === 2 ? { jokersParCoup: 2 as const } : {}),
    chrono,
    ...(primes === undefined ? {} : { primes }),
  };
}

/** Une consigne qui ne laisse rien au sort : ce modele-la, et pas un autre. */
export function consigneExacte(m: ModeleDePartie): ConsigneDePartie {
  return {
    bornes: m.bornes,
    format: { t: "exact", tirage: m.tirage, jouables: m.jouables },
    egal: false,
    joker: !m.joker ? 0 : m.jokersParCoup === 2 ? 2 : 1,
    chrono: m.chrono,
    primes: m.primes ?? null,
  };
}

/** Le modele d'une configuration d'epreuve : ce que l'editeur de partie regle. */
export function modeleDeLaConfig(
  c: { tirage: number; jouables: number; joker: boolean; jokersParCoup: number;
       bornes: number | null; chrono: number | null; primes?: Readonly<Primes> },
): ModeleDePartie {
  const jouables = c.jouables;
  return {
    bornes: c.bornes === 10 ? 10 : 7, tirage: c.tirage, jouables,
    joker: c.joker, ...(c.joker && c.jokersParCoup === 2 ? { jokersParCoup: 2 as const } : {}),
    chrono: c.chrono ?? 60,
    ...(primesLibres(c.primes, jouables) ? { primes: primesReduites(c.primes!, jouables) } : {}),
  };
}

/** Une table de primes recue du dehors, case par case. */
function primesRecevables(x: unknown): Primes | string {
  if (x === null || typeof x !== "object") return "primes illisibles";
  const t: Primes = {};
  for (const [cle, valeur] of Object.entries(x as Record<string, unknown>)) {
    const n = Number(cle), v = Number(valeur);
    if (!Number.isInteger(n) || n < 2 || n > 15) return "une prime se donne par nombre de caramels, de 2 à 15";
    if (!Number.isInteger(v) || v < 0 || v > 9999) return "une prime va de 0 à 9999 points";
    if (v > 0) t[n] = v;
  }
  return t;
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
  let primes: Primes | undefined;
  if (o["primes"] != null) {
    const p = primesRecevables(o["primes"]);
    if (typeof p === "string") return p;
    if (primesLibres(p, jouables)) primes = primesReduites(p, jouables);
  }
  return {
    bornes, tirage, jouables, joker, ...(jokersParCoup === 2 ? { jokersParCoup: 2 as const } : {}),
    chrono, ...(primes === undefined ? {} : { primes }),
  };
}

/**
 * Une consigne recue du dehors. Elle est plus permissive qu'un modele -- une
 * plage peut donner un format que personne n'a ecrit -- mais ses bornes sont
 * les memes, et `tirerUneConsigne` ne peut plus en sortir.
 */
export function consigneRecevable(x: unknown): ConsigneDePartie | string {
  if (x === null || typeof x !== "object") return "consigne illisible";
  const o = x as Record<string, unknown>;
  const bornes = o["bornes"] === "alea" ? "alea" : o["bornes"] === 10 ? 10 : o["bornes"] === 7 ? 7 : null;
  if (bornes === null) return "grille inconnue";

  const f = o["format"] as Record<string, unknown> | null | undefined;
  if (f === null || typeof f !== "object") return "format illisible";
  const dans = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 2 && n <= 15 ? n : null;
  };
  let format: FormatDeConsigne;
  if (f["t"] === "alea") {
    format = { t: "alea" };
  } else if (f["t"] === "plage") {
    const jm = dans(f["jouablesMin"]), jM = dans(f["jouablesMax"]);
    const tm = dans(f["tirageMin"]), tM = dans(f["tirageMax"]);
    if (jm === null || jM === null || tm === null || tM === null) return "une plage va de 2 à 15 lettres";
    if (jm > jM || tm > tM) return "une plage commence par son plus petit nombre";
    format = { t: "plage", jouablesMin: jm, jouablesMax: jM, tirageMin: tm, tirageMax: tM };
  } else {
    const tirage = dans(f["tirage"]), jouables = dans(f["jouables"]);
    if (tirage === null || jouables === null) return "le tirage va de 2 à 15 lettres";
    if (o["egal"] !== true && jouables > tirage) return "on pose de 2 lettres au plus à tout le tirage";
    format = { t: "exact", tirage, jouables };
  }

  const joker = o["joker"] === "alea" ? "alea"
    : o["joker"] === 2 ? 2 : o["joker"] === 1 ? 1 : o["joker"] === 0 ? 0 : null;
  if (joker === null) return "joker inconnu";

  let chrono: number | "alea";
  if (o["chrono"] === "alea") chrono = "alea";
  else {
    const n = Number(o["chrono"]);
    if (!Number.isInteger(n) || n < 5 || n > 3600) return "le temps par coup va de 5 secondes à une heure";
    chrono = n;
  }

  let primes: Primes | "alea" | null;
  if (o["primes"] === "alea") primes = "alea";
  else if (o["primes"] == null) primes = null;
  else {
    const p = primesRecevables(o["primes"]);
    if (typeof p === "string") return p;
    primes = p;
  }

  return { bornes, format, egal: o["egal"] === true, joker, chrono, primes };
}

// ------------------------------------------------------------- le calendrier

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
 * la super grille, les primes. Chaque morceau se separe du suivant par une
 * virgule : `Normale, 60s`, `5/9, 1min30`, `Normale, super grille, 60s`,
 * `11/11, super grille, 3min`, `Normale, 30s, primes libres`.
 * `t` traduit les mots ; le serveur, qui n'affiche rien, s'en passe.
 */
export function nomDeLaPartie(
  c: { tirage: number; jouables: number; joker: boolean; jokersParCoup?: number;
       bornes: number | null; chrono: number | null; primes?: Readonly<Primes> },
  t: (s: string) => string = (s) => s,
): string {
  const joker = !c.joker ? "" : c.jokersParCoup === 2 ? t("double joker") : t("joker");
  const format = c.tirage === 7 && c.jouables === 7
    ? (joker === "" ? t("Normale") : joker.charAt(0).toUpperCase() + joker.slice(1))
    : `${c.jouables}/${c.tirage}${joker === "" ? "" : ` ${joker}`}`;
  return [format, ...(c.bornes === 10 ? [t("super grille")] : []),
    ...(c.chrono === null ? [] : [chronoDuNom(c.chrono)]),
    ...(primesLibres(c.primes, c.jouables) ? [t("primes libres")] : [])].join(", ");
}

/**
 * LE NOM D'UNE CONSIGNE. Ce qu'elle laisse au sort s'y lit comme le reste : on
 * verifie sous l'editeur ce qu'on vient d'ecrire, et rien d'autre ne le dit.
 */
export function nomDeLaConsigne(
  c: ConsigneDePartie, t: (s: string) => string = (s) => s,
): string {
  if (c.format.t === "exact" && !c.egal && c.bornes !== "alea" && c.joker !== "alea"
      && c.chrono !== "alea" && c.primes !== "alea") {
    return nomDeLaPartie({
      tirage: c.format.tirage, jouables: c.format.jouables,
      joker: c.joker > 0, jokersParCoup: c.joker === 2 ? 2 : 1,
      bornes: c.bornes, chrono: c.chrono,
      ...(c.primes === null ? {} : { primes: c.primes }),
    }, t);
  }
  // LE JOKER AU HASARD EST UN MORCEAU A LUI, la ou un joker choisi se colle au
  // format : « 7/8 double joker » d'un cote, « format au hasard, joker au
  // hasard » de l'autre.
  const joker = c.joker === "alea" ? "" : c.joker === 0 ? "" : c.joker === 2 ? t("double joker") : t("joker");
  let format: string;
  if (c.format.t === "alea") format = c.egal ? t("format égal au hasard") : t("format au hasard");
  else if (c.format.t === "plage") {
    const f = c.format;
    format = c.egal
      ? `${f.jouablesMin} ${t("à")} ${f.jouablesMax} ${t("égales")}`
      : `${f.jouablesMin} ${t("à")} ${f.jouablesMax} ${t("sur")} ${f.tirageMin} ${t("à")} ${f.tirageMax}`;
  } else {
    const j = c.format.jouables;
    format = c.egal ? `${j}/${j}`
      : c.format.tirage === 7 && j === 7 ? t("Normale") : `${j}/${c.format.tirage}`;
  }
  return [
    format + (joker === "" ? "" : ` ${joker}`),
    ...(c.joker === "alea" ? [t("joker au hasard")] : []),
    ...(c.bornes === "alea" ? [t("grille au hasard")] : c.bornes === 10 ? [t("super grille")] : []),
    ...(c.chrono === "alea" ? [t("temps au hasard")] : [chronoDuNom(c.chrono)]),
    ...(c.primes === "alea" ? [t("primes au hasard")]
      : c.primes !== null && Object.keys(c.primes).length > 0 ? [t("primes libres")] : []),
  ].join(", ");
}

/** Ce qu'il faut de minutes apres minuit pour que le jour change : 5 h 30. */
const BASCULE_MINUTES = 5 * 60 + 30;

/** L'heure de bascule, telle qu'elle s'ecrit dans un instant de Paris. */
export const HEURE_DE_BASCULE = "05:30";

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

/** L'instant ou ce jour commence : 5 h 30 a Paris. */
export function debutDuJour(jour: string): number {
  return instantDeParis(`${jour}T${HEURE_DE_BASCULE}`) ?? 0;
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

/** Les jours de la semaine, LUNDI D'ABORD : c'est la semaine d'ici. */
export const JOURS_DE_LA_SEMAINE = [
  "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
] as const;

/** Le jour de la semaine d'une date : 0 pour lundi, 6 pour dimanche. */
export function jourDeLaSemaine(jour: string): number {
  const [a, m, j] = jour.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(a, m - 1, j)).getUTCDay() + 6) % 7;
}

/** Combien de jours separent deux jours de la semaine, en avancant. */
export function joursEntre(debut: number, fin: number): number {
  return ((fin - debut) % 7 + 7) % 7;
}
