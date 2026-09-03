/**
 * Resolution des fichiers de donnees.
 *
 * Passer par fileURLToPath et non par URL.pathname : le chemin du projet
 * contient des espaces, que pathname laisse encodes en %20.
 */
import { fileURLToPath } from "node:url";
import { DICO_PAR_DEFAUT, dictionnaire } from "./dictionnaires.ts";

export function dataPath(name: string): string {
  return fileURLToPath(new URL(`../data/${name}`, import.meta.url));
}

/** Les deux structures d'un dictionnaire nomme. */
export function dawgPath(id: string | undefined): string {
  return dataPath(dictionnaire(id).dawg);
}

export function gaddagPath(id: string | undefined): string {
  return dataPath(dictionnaire(id).gaddag);
}

/**
 * Le dictionnaire par defaut, pour les outils et les tests qui n'en visent
 * aucun en particulier. Une partie, elle, lit celui de sa configuration.
 */
export const DAWG_PATH = dawgPath(DICO_PAR_DEFAUT);
export const GADDAG_PATH = gaddagPath(DICO_PAR_DEFAUT);
