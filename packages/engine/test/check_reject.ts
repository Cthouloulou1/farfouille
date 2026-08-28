/**
 * Un tirage rejete ne doit PAS consommer les probabilites.
 *
 * Le mecanisme de compensation remonte le poids d'une lettre a mesure qu'elle ne
 * sort pas, et le remet a zero quand elle sort. Si un rejet comptait comme une
 * sortie, une lettre rare piochee puis rejetee verrait son compteur repartir de
 * zero : on ne la reverrait plus avant tres longtemps. C'est exactement le cas
 * du W, dont le poids de base est 0,03.
 *
 * On verifie ici que le compteur d'une lettre apparue UNIQUEMENT dans un tirage
 * rejete continue de monter, comme si elle n'etait jamais sortie.
 */
import { Bag, DEFAULT_BAG, type RejectPolicy } from "../src/bag.ts";
import { mulberry32 } from "../src/rng.ts";

let failures = 0;
const fail = (m: string) => { failures++; console.log("  ECHEC :", m); };

// Politique qui rejette les N premieres tentatives, puis accepte tout.
function rejectFirst(n: number): RejectPolicy {
  let seen = 0;
  return () => seen++ < n;
}

const LETTERS = [...Object.keys(DEFAULT_BAG.weights), "?"];

/** Compteurs de compensation, apres un enchainement de tirages. */
function countersAfter(policy: RejectPolicy, draws: number): number[] {
  const bag = new Bag(DEFAULT_BAG, mulberry32(12345), policy);
  let rel: string[] = [];
  for (let i = 0; i < draws; i++) {
    const d = bag.draw(rel);
    rel = [...d.rack].slice(0, 2);   // on garde un reliquat stable
  }
  return bag.counters();
}

// 1. Un tirage rejete ne doit rien changer aux compteurs par rapport au cas ou
//    la tentative n'aurait jamais eu lieu.
const sansRejet = countersAfter(() => false, 1);
const avecRejets = countersAfter(rejectFirst(3), 1);

// Les deux partent de la meme graine. Avec trois rejets, l'aleatoire a avance,
// donc les lettres finalement tirees different -- mais AUCUNE lettre ne doit
// avoir un compteur incoherent : toute lettre non presente dans le tirage
// finalement retenu doit avoir un compteur strictement positif.
const bag = new Bag(DEFAULT_BAG, mulberry32(999), rejectFirst(4));
const draw = bag.draw([]);
const k = bag.counters();
const kept = new Set([...draw.rack]);

console.log(`tirage retenu apres 4 rejets : ${draw.rack} (${draw.rejections} rejets)`);
if (draw.rejections !== 4) fail(`4 rejets attendus, ${draw.rejections} observes`);

let resetHorsTirage = 0;
LETTERS.forEach((L, i) => {
  const compteur = k[i]!;
  if (!kept.has(L) && compteur === 0) {
    resetHorsTirage++;
    fail(`compteur de ${L} remis a zero alors que la lettre n'est PAS dans le tirage retenu`);
  }
});

// 2. Verification de bout en bout : sur beaucoup de tirages, la frequence des
//    lettres cheres doit rester celle qu'on vise, meme avec des rejets.
const N = 60_000;
const bag2 = new Bag(DEFAULT_BAG, mulberry32(4242));
const seen = new Map<string, number>();
let total = 0;
let rejets = 0;
for (let i = 0; i < N; i++) {
  // Sans reliquat : chaque tirage est fait de sept caramels NEUFS. Compter les
  // sept d'un tirage a reliquat recompterait les memes lettres d'un coup a
  // l'autre et fausserait completement les frequences.
  const d = bag2.draw([]);
  rejets += d.rejections;
  for (const ch of d.rack) { seen.set(ch, (seen.get(ch) ?? 0) + 1); total++; }
}
const pct = (L: string) => (100 * (seen.get(L) ?? 0) / total);
console.log(`\n${N.toLocaleString("fr")} tirages, ${(100 * rejets / (rejets + N)).toFixed(1)} % de rejets`);
console.log("lettre   observe   vise");
const CIBLES: [string, number][] = [["W", 0.05], ["K", 0.26], ["J", 0.31], ["X", 0.41], ["Z", 0.82], ["E", 15.46]];
for (const [L, cible] of CIBLES) {
  const obs = pct(L);
  const ecart = Math.abs(obs - cible) / cible;
  const ok = ecart < 0.30;
  if (!ok) fail(`${L} : ${obs.toFixed(2)} % observe contre ${cible} % vise (${(100 * ecart).toFixed(0)} % d'ecart)`);
  console.log(`   ${L}     ${obs.toFixed(2)}%    ${cible}%   ${ok ? "" : "  <-- ECART"}`);
}

console.log();
console.log(failures === 0
  ? "OK : un tirage rejete ne consomme pas les probabilites, les lettres rares gardent leur frequence"
  : `${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
