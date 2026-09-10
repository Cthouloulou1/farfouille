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

/**
 * UN LEXIQUE DEJA LU NE SE RELIT PAS.
 *
 * `loadDict` relit le fichier a chaque appel : 0,45 Mo pour le DAWG francais,
 * 4 Mo pour son GADDAG. Or un lexique compile NE CHANGE JAMAIS en cours
 * d'execution -- il faudrait recompiler et redemarrer -- et `Dict` ne se lit
 * qu'en lecture. Un cache par chemin de fichier suffit donc, et il est sur.
 *
 * Ce qu'il epargne : chaque relance de partie relisait le DAWG SUR LE FIL
 * PRINCIPAL, dans le constructeur de `Game`, pendant que plus rien d'autre ne
 * pouvait se servir -- ni un WebSocket, ni une page. Une table qui relance dix
 * parties de suite dans le meme lexique le lit maintenant une fois.
 *
 * CE N'EST PAS CE QUI COUTE LE PLUS CHER, et il faut le dire : les 145 ms d'une
 * relance sont lues DANS LE FIL DE CALCUL (SPEC.md §23), et un fil neuf part
 * toujours d'un cache vide. Les epargner demande de recycler le fil, ce qui
 * n'est pas fait.
 */
const gardes = new Map<string, Dict>();

export function lexiqueGarde(path: string): Dict {
  let d = gardes.get(path);
  if (d === undefined) { d = loadDict(path); gardes.set(path, d); }
  return d;
}
