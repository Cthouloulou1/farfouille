/**
 * Chargement d'un dictionnaire compile depuis le disque.
 *
 * Volontairement separe de dictionary.ts : celui-ci doit rester sans la moindre
 * entree-sortie pour pouvoir etre embarque tel quel dans le navigateur.
 */
import { readFileSync } from "node:fs";
import { Dict } from "./dictionary.ts";

export function loadDict(path: string): Dict {
  return Dict.fromBytes(readFileSync(path));
}
