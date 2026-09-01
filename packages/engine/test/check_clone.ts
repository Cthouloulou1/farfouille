/**
 * Une pioche copiee tire exactement la meme suite. Voir SPEC.md §17.
 *
 *     node packages/engine/test/check_clone.ts
 *
 * C'est la pierre sur laquelle repose le calcul des coups d'avance : le serveur
 * fait pioche un DOUBLE de son sac, plusieurs coups devant, pendant que la
 * vraie pioche reste ou elle en est. Les deux doivent tomber sur les memes
 * tirages, sans quoi le coup prepare ne serait pas celui qui sera servi.
 *
 * On verifie les deux pioches -- le sac de 102 et les probabilites ponderees --
 * a partir d'un etat DEJA ENTAME : c'est la seule situation qui compte, la
 * copie ne se prend jamais sur un sac neuf.
 */
import { SacFini, SAC_FRANCAIS, type Pioche } from "../src/sac.ts";
import { Bag, DEFAULT_BAG } from "../src/bag.ts";
import { mulberry32, moveSeed } from "../src/rng.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(52)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nUne pioche copiee tire la meme suite\n");

/** Avance une pioche de quelques tirages, en gardant deux lettres a chaque fois. */
function entamer(p: Pioche, tours: number): string[] {
  let reliquat: string[] = [];
  for (let i = 0; i < tours; i++) {
    const d = p.draw(reliquat);
    reliquat = [...d.rack].slice(0, 2);
  }
  return reliquat;
}

for (const nom of ["sac de 102", "sac qui boucle", "probabilites ponderees"]) {
  const neuve = (): Pioche => {
    if (nom === "probabilites ponderees") {
      return new Bag(DEFAULT_BAG, mulberry32(moveSeed("clone", 0)), undefined, 7);
    }
    const s = new SacFini(SAC_FRANCAIS, mulberry32(moveSeed("clone", 0)), 7);
    s.recharge = nom === "sac qui boucle";
    return s;
  };

  const vraie = neuve();
  let reliquat = entamer(vraie, 9);
  const double = vraie.cloner();

  // Le double prend de l'avance, la vraie ne bouge pas encore.
  let devant = [...reliquat];
  const prevus: string[] = [];
  for (let i = 0; i < 40; i++) {
    const d = double.draw(devant);
    prevus.push(d.rack);
    devant = [...d.rack].slice(0, 2);
  }

  // Puis la vraie rattrape, un tirage a la fois.
  let ecart = -1;
  for (let i = 0; i < prevus.length; i++) {
    const d = vraie.draw(reliquat);
    if (d.rack !== prevus[i]) { ecart = i; break; }
    reliquat = [...d.rack].slice(0, 2);
  }
  verifie(`${nom} : quarante tirages devinés d'avance`, ecart === -1,
    ecart === -1 ? prevus[0]! + " … " + prevus[39]! : `divergence au ${ecart + 1}e`);

  // Le reste du sac doit lui aussi etre le meme, sinon la fin de partie
  // tomberait a un moment different d'un cote et de l'autre.
  const a = JSON.stringify(vraie.restant()), b = JSON.stringify(double.restant());
  verifie(`${nom} : et le meme reste de sac`, a === b);
}

// LA COPIE NE TOUCHE PAS A L'ORIGINAL. Piocher dans le double ne doit rien
// changer au sac de la partie : c'est ce qui garantit que le reliquat affiche
// aux joueurs ne laisse pas deviner les tirages a venir.
{
  const vraie = new SacFini(SAC_FRANCAIS, mulberry32(7), 7);
  entamer(vraie, 5);
  const avant = JSON.stringify(vraie.restant());
  const double = vraie.cloner();
  entamer(double, 8);
  verifie("piocher dans le double ne vide pas le vrai sac",
    JSON.stringify(vraie.restant()) === avant);
  verifie("le double, lui, s'est bien vide",
    JSON.stringify(double.restant()) !== avant);
}

console.log(echecs === 0
  ? "\nOK : le double pioche exactement comme la partie, sans y toucher\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
