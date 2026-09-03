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
 * LE HTML N'A RIEN A DECLARER. `traduireLeDocument` parcourt la page et
 * remplace ce qu'il reconnait -- textes, `placeholder`, `title`, `aria-label`.
 * Aucun attribut a semer dans le balisage, aucune cle a inventer.
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

/**
 * Change la langue, et RECHARGE LA PAGE.
 *
 * Retraduire a chaud demanderait que chaque texte deja peint sache se repeindre
 * -- le journal des coups, le chat, le classement, les bandeaux. Un rechargement
 * fait le meme travail en une ligne et sans rien oublier. On ne change pas de
 * langue vingt fois par partie.
 */
export function choisirLaLangue(l: Langue): void {
  try { localStorage.setItem(CLE, l); } catch { /* navigation privee */ }
  // L'adresse peut porter `?lang=`, qui l'emporterait sur le choix qu'on vient
  // d'enregistrer : on la nettoie avant de recharger.
  const u = new URL(location.href);
  u.searchParams.delete("lang");
  location.replace(u.toString());
}

/** Le texte, dans la langue en cours. Un texte inconnu reste en francais. */
export function t(fr: string): string {
  if (courante === "fr") return fr;
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

/**
 * Traduit ce qui est ecrit dans le balisage.
 *
 * On ne touche qu'aux textes qu'on RECONNAIT : ce qui n'est pas dans la table
 * reste tel quel. Un pseudo, un score ou un mot pose ne risquent donc rien --
 * et de toute facon ceux-la sont poses par le code, pas par le balisage.
 */
export function traduireLeDocument(racine: ParentNode = document.body): void {
  if (courante === "fr") return;
  const marche = document.createTreeWalker(racine as Node, NodeFilter.SHOW_TEXT);
  const aChanger: [Text, string][] = [];
  for (let n = marche.nextNode(); n !== null; n = marche.nextNode()) {
    const noeud = n as Text;
    const parent = noeud.parentElement;
    if (parent === null) continue;
    const balise = parent.tagName;
    if (balise === "SCRIPT" || balise === "STYLE") continue;
    const brut = noeud.data;
    const net = brut.trim();
    if (net === "") continue;
    const trad = EN[net];
    if (trad === undefined) continue;
    // On garde les espaces d'origine : ils separent le texte de ses voisins.
    aChanger.push([noeud, brut.replace(net, trad)]);
  }
  for (const [noeud, texte] of aChanger) noeud.data = texte;

  for (const el of (racine as Element).querySelectorAll("*")) {
    for (const a of ATTRIBUTS) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      const trad = EN[v.trim()];
      if (trad !== undefined) el.setAttribute(a, trad);
    }
  }
  document.documentElement.lang = courante;
}
