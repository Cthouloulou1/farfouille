/**
 * Resolution des fichiers de donnees.
 *
 * Passer par fileURLToPath et non par URL.pathname : le chemin du projet
 * contient des espaces, que pathname laisse encodes en %20.
 */
import { fileURLToPath } from "node:url";

export function dataPath(name: string): string {
  return fileURLToPath(new URL(`../data/${name}`, import.meta.url));
}

export const DAWG_PATH = dataPath("dawg.bin");
export const GADDAG_PATH = dataPath("gaddag.bin");
