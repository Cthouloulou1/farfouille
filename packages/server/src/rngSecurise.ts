/**
 * Generateur cryptographique, pour les parties reelles. Voir SPEC.md §5.
 *
 * mulberry32 (engine/src/rng.ts) tient tout son etat dans un entier de 32
 * bits : assez petit pour qu'on le reconstitue a partir de quelques tirages
 * observes -- une recherche de quelques secondes, algorithme public a
 * l'appui. Correct pour des tests reproductibles, pas pour un tirage qu'un
 * joueur en competition pourrait chercher a percer en observant son propre
 * chevalet et la facon dont le sac se vide.
 *
 * ChaCha20 y substitue un flux issu d'une cle de 256 bits, derivee par
 * SHA-256 de la graine de la partie -- une graine elle-meme tiree par
 * `randomUUID()` a la creation (voir Game.demarrer) et jamais envoyee au
 * client. Recuperer l'etat a partir des tirages observes n'est plus une
 * recherche de quelques secondes : c'est infaisable avec les moyens de calcul
 * actuels.
 *
 * Vit cote serveur, pas dans le moteur : le client web importe le moteur pour
 * l'affichage et la recherche de mots, et `node:crypto` n'existe pas dans un
 * navigateur.
 */
import { createCipheriv, createHash } from "node:crypto";
import type { Alea } from "../../engine/src/rng.ts";

/**
 * Nonce fixe : ce qui garantit qu'un flux ne se repete jamais, c'est l'unicite
 * de la cle -- derivee d'une graine elle-meme unique par partie et par coup --
 * pas celle du nonce.
 */
const NONCE = Buffer.alloc(12);

function deriverCle(graine: string): Buffer {
  return createHash("sha256").update(graine, "utf8").digest();
}

/** Le bloc keystream numero `compteur` : 64 octets, purs du flux. */
function bloc(cle: Buffer, compteur: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(compteur >>> 0, 0);
  NONCE.copy(iv, 4);
  return createCipheriv("chacha20", cle, iv).update(Buffer.alloc(64));
}

/** Reprend un flux exactement ou `tampon`/`curseur` l'avaient laisse. */
function depuis(cle: Buffer, prochainBloc: number, tampon: Buffer, curseur: number): Alea {
  let compteur = prochainBloc, t = tampon, p = curseur;
  const suivant = (function () {
    if (p + 4 > t.length) { t = bloc(cle, compteur); compteur++; p = 0; }
    const v = t.readUInt32LE(p);
    p += 4;
    return v / 4294967296;
  }) as Alea;
  suivant.cloner = () => depuis(cle, compteur, Buffer.from(t), p);
  return suivant;
}

/** Un flux ChaCha20 derive de `graine`. Deux graines differentes, deux flux independants. */
export function chacha20(graine: string): Alea {
  const cle = deriverCle(graine);
  return depuis(cle, 1, bloc(cle, 0), 0);
}
