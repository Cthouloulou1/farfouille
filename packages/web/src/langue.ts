/**
 * La langue du site.
 *
 * LA CLE D'UN TEXTE EST LE TEXTE FRANCAIS LUI-MEME. Pas de `accueil.titre` ni
 * de `btn_join_label` : on ecrit `t("Rejoindre")`, et la table dit ce que cela
 * devient en anglais. Trois raisons, dans l'ordre :
 *
 *   - le code reste LISIBLE. Une cle inventee oblige a ouvrir la table pour
 *     savoir ce qui s'affiche ;
 *   - un texte non traduit s'affiche EN FRANCAIS plutot qu'en `btn_join_label`.
 *     Une traduction qui manque est un desagrement, pas une panne ;
 *   - la liste a traduire, c'est exactement la liste des textes francais. Rien
 *     a tenir a jour de part et d'autre.
 *
 * Le prix a payer : deux textes francais identiques se traduisent pareil, et
 * corriger une faute de frappe cote francais casse la traduction. On vit tres
 * bien avec.
 *
 * LE HTML N'A RIEN A DECLARER. `releverLeBalisage` note, au demarrage, chaque
 * texte ecrit dans la page -- contenus, `placeholder`, `title`, `aria-label` --
 * et `appliquerLaLangue` les remplace. Aucun attribut a semer dans le balisage,
 * aucune cle a inventer.
 *
 * ON NE TOUCHE QU'A CE QUI A ETE RELEVE AU DEMARRAGE. Repasser sur la page
 * entiere apres coup traduirait aussi ce que le jeu y a ecrit depuis : un
 * pseudo, un mot pose, un message de chat ou l'on aurait tape « Chat ». Le
 * dynamique, lui, passe par `t()` a l'endroit ou il se compose.
 */
import { EN } from "./textes-en.ts";

export type Langue = "fr" | "en";

const CLE = "langue";

/**
 * La langue que le navigateur annonce.
 *
 * `navigator.languages` est la liste ORDONNEE des langues reglees dans le
 * navigateur ou le systeme -- ["fr-BE", "fr", "en"] pour un Belge francophone.
 * On prend la premiere qu'on sait parler ; si l'on n'en connait aucune, le
 * francais, qui est la langue d'origine du site.
 */
export function langueDuNavigateur(): Langue {
  const dites = navigator.languages ?? [navigator.language ?? "fr"];
  for (const brute of dites) {
    const code = String(brute).toLowerCase().split("-")[0];
    if (code === "fr") return "fr";
    if (code === "en") return "en";
  }
  return "fr";
}

/**
 * La langue en cours.
 *
 * Trois sources, de la plus forte a la plus faible :
 *   1. `?lang=en` dans l'adresse -- un lien peut ainsi imposer sa langue ;
 *   2. le choix enregistre, s'il y en a un. UN CHOIX EXPLICITE GAGNE TOUJOURS :
 *      qui a mis le site en francais depuis un navigateur anglais ne veut pas
 *      le retrouver en anglais a la visite suivante ;
 *   3. ce qu'annonce le navigateur.
 */
function decider(): Langue {
  const demandee = new URLSearchParams(location.search).get("lang");
  if (demandee === "fr" || demandee === "en") return demandee;
  try {
    const garde = localStorage.getItem(CLE);
    if (garde === "fr" || garde === "en") return garde;
  } catch { /* navigation privee : on se rabat sur le navigateur */ }
  return langueDuNavigateur();
}

let courante: Langue = decider();

export function langue(): Langue {
  return courante;
}

/** Ce que le reste du programme repeint quand la langue change. */
let repeindre: (() => void) | null = null;

export function surChangementDeLangue(quoi: () => void): void {
  repeindre = quoi;
}

/**
 * Change la langue, SANS RECHARGER LA PAGE.
 *
 * Un rechargement ferait le travail en une ligne, mais il blanchit l'ecran une
 * demi-seconde et fait repartir la connexion au salon. On remet donc le
 * balisage dans la nouvelle langue et l'on redemande au jeu de se repeindre :
 * l'ecran change sous les yeux, sans a-coup.
 */
export function choisirLaLangue(l: Langue): void {
  if (l === courante) return;
  courante = l;
  try { localStorage.setItem(CLE, l); } catch { /* navigation privee */ }
  // L'adresse peut porter `?lang=`, qui l'emporterait a la prochaine visite sur
  // le choix qu'on vient d'enregistrer : on la nettoie.
  const u = new URL(location.href);
  if (u.searchParams.has("lang")) {
    u.searchParams.delete("lang");
    history.replaceState({}, "", u.toString());
  }
  appliquerLaLangue();
  repeindre?.();
}

/** Le texte, dans la langue en cours. Un texte inconnu reste en francais. */
export function t(fr: string): string {
  return tDans(courante, fr);
}

/**
 * Le texte dans UNE LANGUE DONNEE, qui n'est pas forcement celle du site.
 *
 * Sert a ce qui appartient a autre chose qu'a la page : l'accroche d'un salon
 * anglais reste en anglais, meme lue depuis la version francaise. C'est la
 * promesse de CE salon, pas un element de l'interface.
 */
export function tDans(l: Langue, fr: string): string {
  if (l === "fr") return fr;
  return EN[fr] ?? fr;
}

/**
 * Un texte a trous : `t2("{n} coups", { n: 12 })`.
 *
 * Les trous portent un NOM et non un numero : l'ordre des mots change d'une
 * langue a l'autre, et une traduction doit pouvoir les remettre ou il faut.
 */
export function t2(fr: string, trous: Record<string, string | number>): string {
  let out = t(fr);
  for (const [cle, val] of Object.entries(trous)) out = out.split(`{${cle}}`).join(String(val));
  return out;
}

/** Les attributs qui portent du texte lu par quelqu'un. */
const ATTRIBUTS = ["placeholder", "title", "aria-label", "aria-placeholder"];

/** Un texte du balisage, avec son francais d'origine. */
const textes: { noeud: Text; brut: string }[] = [];
const attributs: { el: Element; nom: string; brut: string }[] = [];
let releve = false;

/**
 * Note tout ce que le balisage ecrit. A appeler UNE FOIS, avant le premier
 * peignage : ce qui arrive apres n'est plus du balisage, c'est du jeu.
 */
export function releverLeBalisage(racine: ParentNode = document.body): void {
  if (releve) return;
  releve = true;
  const marche = document.createTreeWalker(racine as Node, NodeFilter.SHOW_TEXT);
  for (let n = marche.nextNode(); n !== null; n = marche.nextNode()) {
    const noeud = n as Text;
    const balise = noeud.parentElement?.tagName;
    if (balise === undefined || balise === "SCRIPT" || balise === "STYLE") continue;
    if (noeud.data.trim() === "") continue;
    textes.push({ noeud, brut: noeud.data });
  }
  for (const el of (racine as Element).querySelectorAll("*")) {
    for (const nom of ATTRIBUTS) {
      const v = el.getAttribute(nom);
      if (v !== null && v.trim() !== "") attributs.push({ el, nom, brut: v });
    }
  }
}

/**
 * Remet le balisage dans la langue en cours.
 *
 * On repart TOUJOURS du francais d'origine, jamais du texte affiche : c'est ce
 * qui permet de revenir en arriere, et ce qui empeche une traduction de se
 * traduire une seconde fois.
 */
export function appliquerLaLangue(): void {
  for (const { noeud, brut } of textes) {
    const net = brut.trim();
    const trad = courante === "fr" ? undefined : EN[net];
    // Les espaces d'origine se gardent : ils separent le texte de ses voisins.
    noeud.data = trad === undefined ? brut : brut.replace(net, trad);
  }
  for (const { el, nom, brut } of attributs) {
    const trad = courante === "fr" ? undefined : EN[brut.trim()];
    el.setAttribute(nom, trad ?? brut);
  }
  document.documentElement.lang = courante;
}

/** Le relevé puis la pose, en un geste : ce qu'on appelle au demarrage. */
export function traduireLeDocument(): void {
  releverLeBalisage();
  appliquerLaLangue();
}
