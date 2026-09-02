/**
 * Le plafond de messages par seconde. Voir SPEC.md §18.
 *
 *     node packages/server/test/check_debit.ts
 *
 * Le serveur repond a chaque mot propose « valide, 94 points ». Sans plafond,
 * un script qui en soumet mille par seconde trouve le top par force brute :
 * il suffit de garder le meilleur. Cinq par seconde, c'est le rythme d'un
 * joueur rapide qui tape, et c'est trop peu pour balayer un dictionnaire.
 *
 * Le seau doit tenir les deux bouts : laisser passer une rafale courte -- deux
 * mots coup sur coup, ce qui arrive -- sans jamais laisser la moyenne depasser
 * le debit sur la duree.
 */
import { Seau, seauDeRafale, SOUMISSIONS_PAR_SECONDE } from "../src/debit.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(52)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nLe plafond de messages par seconde\n");

// Le temps est donne, pas mesure : un test qui dort une seconde pour verifier
// un debit est un test qui rend la suite penible a lancer.
{
  const s = new Seau(5, 0);
  let passes = 0;
  for (let i = 0; i < 20; i++) if (s.prendre(0)) passes++;
  verifie("une rafale immediate passe, mais pas plus que le debit", passes === 5,
    `${passes} messages sur 20 dans la meme milliseconde`);
}

{
  // Mille messages par seconde pendant dix secondes : c'est l'attaque.
  const s = new Seau(SOUMISSIONS_PAR_SECONDE, 0);
  let passes = 0;
  for (let ms = 0; ms < 10_000; ms++) for (let k = 0; k < 1; k++) {
    if (s.prendre(ms)) passes++;
  }
  // Cinq par seconde pendant dix secondes, plus le seau plein du depart.
  verifie("mille par seconde n'en font passer que cinq", passes <= 5 * 10 + 5,
    `${passes} passes sur 10 000 tentatives en 10 s`);
  verifie("et le debit annonce passe bien en entier", passes >= 5 * 10,
    `${(passes / 10).toFixed(1)} par seconde`);
}

{
  // Un joueur normal ne doit JAMAIS rencontrer le plafond. Deux mots coup sur
  // coup, puis une pause : c'est la frappe d'un joueur rapide.
  const s = new Seau(SOUMISSIONS_PAR_SECONDE, 0);
  let refuses = 0;
  let t = 0;
  for (let coup = 0; coup < 40; coup++) {
    if (!s.prendre(t)) refuses++;
    if (!s.prendre(t + 120)) refuses++;   // le deuxieme mot, tout de suite apres
    t += 3000;                            // puis on cherche trois secondes
  }
  verifie("un joueur rapide n'est jamais retenu", refuses === 0,
    `80 mots en deux minutes, ${refuses} refus`);
}

{
  // LE REMPLISSAGE EST CONTINU. Un compteur remis a zero chaque seconde
  // laisserait passer deux rafales pleines de part et d'autre d'une frontiere,
  // soit le double du debit sur un court instant.
  const s = new Seau(5, 0);
  let passes = 0;
  for (let i = 0; i < 5; i++) if (s.prendre(999)) passes++;
  for (let i = 0; i < 5; i++) if (s.prendre(1001)) passes++;
  verifie("pas de double rafale a la frontiere d'une seconde", passes <= 6,
    `${passes} messages a cheval sur deux secondes`);
}

{
  // LE SEAU DES MOTS DE PASSE tient deux exigences contraires : l'humain qui
  // retape trois fois ne doit jamais etre bloque, le script qui essaie un
  // dictionnaire ne doit jamais avancer.
  const s = new Seau(0.5, 0, 6);
  let rafale = 0;
  for (let i = 0; i < 10; i++) if (s.prendre(0)) rafale++;
  verifie("six essais coup sur coup passent", rafale === 6,
    `${rafale} essais sur 10 dans la meme milliseconde`);
  verifie("le septieme attend", !s.prendre(0), "seau vide");
  verifie("une seconde ne suffit pas", !s.prendre(1000), "il en faut deux");
  verifie("deux secondes rendent un essai", s.prendre(2000), "");

  // Une heure d'acharnement : la moyenne doit tenir, quoi qu'il arrive.
  const t = new Seau(0.5, 0, 6);
  let passes = 0;
  for (let ms = 0; ms < 3_600_000; ms += 100) if (t.prendre(ms)) passes++;
  verifie("une heure d'acharnement ne donne que ~1800 essais", passes <= 1810,
    `${passes} essais en une heure, 36 000 tentatives`);
}

{
  // La capacite par defaut vaut le debit : les seaux du jeu n'ont pas bouge.
  const s = new Seau(5, 0);
  let passes = 0;
  for (let i = 0; i < 20; i++) if (s.prendre(0)) passes++;
  verifie("sans capacite donnee, rien ne change", passes === 5,
    `${passes} messages, comme avant`);
}

console.log(echecs === 0
  ? "\nOK : le plafond arrete la force brute sans gener personne\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
