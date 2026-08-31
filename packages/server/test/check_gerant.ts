/**
 * Qui regle le salon, et quand ca change de mains. Voir SPEC.md §16.
 *
 *     node packages/server/test/check_gerant.ts
 *
 * UN SALON SANS PERSONNE POUR LE REGLER EST UN SALON MORT : le createur ferme
 * sa page, et plus personne ne peut relancer une partie ni changer la variante.
 * Les manettes suivent donc les presents, selon deux regles qui ne doivent
 * jamais se contredire -- le createur les reprend des qu'il revient, et en son
 * absence elles vont a quelqu'un au hasard, qui les garde tant qu'il est la.
 *
 * Le tirage etant au sort, on ne verifie pas SUR QUI il tombe : on verifie
 * qu'il tombe sur quelqu'un de present, qu'il ne bouge plus tant que cette
 * personne est la, et qu'il sait rendre les manettes. Sur cent tirages, on
 * verifie en plus qu'il ne designe pas toujours le meme.
 */
import { confierLesReglages, type Salon } from "../src/salons.ts";

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(54)} ${detail}`);
  if (!ok) echecs++;
}

/** Un salon reduit a ce que la regle regarde : son createur et son gerant. */
const salonFactice = (proprietaire: string | null): Salon =>
  ({ proprietaire, gerant: proprietaire } as unknown as Salon);

console.log("\nQui regle le salon\n");

// --- 1. Le createur est la : rien ne bouge --------------------------------
{
  const s = salonFactice("Zulu");
  const neuf = confierLesReglages(s, ["Zulu", "Ana", "Bo"]);
  verifie("le createur present garde les manettes", s.gerant === "Zulu", s.gerant ?? "—");
  verifie("rien a annoncer", neuf === null);
}

// --- 2. Le createur s'en va -----------------------------------------------
{
  const s = salonFactice("Zulu");
  const neuf = confierLesReglages(s, ["Ana", "Bo"]);
  verifie("les manettes passent a quelqu'un de present",
    s.gerant === "Ana" || s.gerant === "Bo", s.gerant ?? "—");
  verifie("et cela s'annonce", neuf === s.gerant, neuf ?? "—");

  // Tant que le gerant est la, il les garde : une arrivee ne rebat pas les cartes.
  const gardien = s.gerant;
  verifie("une arrivee ne les lui reprend pas",
    confierLesReglages(s, ["Ana", "Bo", "Cy"]) === null && s.gerant === gardien,
    s.gerant ?? "—");
}

// --- 3. Le createur revient -----------------------------------------------
{
  const s = salonFactice("Zulu");
  confierLesReglages(s, ["Ana", "Bo"]);
  const neuf = confierLesReglages(s, ["Zulu", "Ana", "Bo"]);
  verifie("le createur qui revient les reprend", s.gerant === "Zulu", s.gerant ?? "—");
  // Rien a annoncer : son bouton reparait, il n'a rien a apprendre.
  verifie("son retour ne s'annonce pas", neuf === null);
}

// --- 4. Le gerant s'en va a son tour --------------------------------------
{
  const s = salonFactice("Zulu");
  confierLesReglages(s, ["Ana", "Bo"]);
  const parti = s.gerant!;
  const reste = ["Ana", "Bo"].filter((n) => n !== parti);
  confierLesReglages(s, reste);
  verifie("elles passent au suivant", s.gerant === reste[0], s.gerant ?? "—");
}

// --- 5. Salon vide, et grille permanente ----------------------------------
{
  const s = salonFactice("Zulu");
  confierLesReglages(s, []);
  verifie("un salon vide n'a plus de gerant", s.gerant === null, String(s.gerant));

  const monde = salonFactice(null);
  confierLesReglages(monde, ["Ana"]);
  verifie("la grille permanente n'en a jamais", monde.gerant === null, String(monde.gerant));
}

// --- 6. Le sort ne designe pas toujours le meme ----------------------------
{
  const vus = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const s = salonFactice("Zulu");
    confierLesReglages(s, ["Ana", "Bo", "Cy"]);
    vus.add(s.gerant!);
  }
  verifie("sur cent departs, les trois sont tombes", vus.size === 3, [...vus].sort().join(", "));
}

console.log(echecs === 0
  ? "\nOK : les manettes ne restent jamais entre les mains d'un absent\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
