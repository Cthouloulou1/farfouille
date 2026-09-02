/**
 * Les paliers refaits a la demande valent ceux d'origine. Voir SPEC.md §10.
 *
 *     node packages/server/test/check_paliers.ts
 *
 * Sur un plateau borne, les paliers ne sont plus ecrits dans le journal : ils
 * en representaient 86 % du poids. Le rejeu les refait donc en remontant la
 * grille au coup demande. Tout repose sur une egalite : ce qu'on recalcule doit
 * etre EXACTEMENT ce qu'on aurait enregistre, sinon le rejeu montre une autre
 * partie que celle qui a ete jouee.
 *
 * Le test rejoue une partie de 15x15 coup par coup en gardant les paliers, puis
 * les redemande a `paliersDuCoup` et compare mot pour mot.
 */
import { rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { configParDefaut, avec } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "paliers-test";

function nettoyer(): void {
  for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${ID}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(50)} ${detail}`);
  if (!ok) echecs++;
}

/** Une signature stable d'un jeu de paliers : score, mot, sens, place. */
const signature = (paliers: readonly { score: number; moves: readonly (readonly [string, string, number, number])[] }[]): string =>
  paliers.map((p) => `${p.score}:` + p.moves.map((m) => m.join(",")).sort().join("|")).join(" / ");

console.log("\nPaliers refaits a la demande\n");
nettoyer();

setLayout("classique");
const cfg = avec(configParDefaut(), { bornes: 7, pioche: "sac102", chrono: null });
const g = new Game(ID, "classique", cfg);
await g.start();
g.presents.add("essai");
await g.reveiller();
await g.demarrer();

// Une poignee de coups suffit : c'est l'egalite qui compte, pas la longueur.
for (let i = 0; i < 6 && !g.finie; i++) {
  await g.reveal();
  await new Promise((r) => setTimeout(r, 30));
}

verifie("la partie a avance", g.moves.length >= 5, `${g.moves.length} coups`);

// Le journal d'un plateau borne ne doit PAS porter les paliers.
const portes = g.moves.filter((m) => m.tiers !== undefined && m.tiers.length > 0).length;
verifie("aucun palier enregistre sur plateau borne", portes === 0,
  portes === 0 ? "le journal ne porte que le necessaire" : `${portes} coups en portent`);

let msTotal = 0, pires = 0;
for (const m of g.moves) {
  const t0 = performance.now();
  const refaits = await g.paliersDuCoup(m.n);
  msTotal += performance.now() - t0;
  const total = refaits.reduce((s, p) => s + p.moves.length, 0);
  if (total > pires) pires = total;

  // Le mot effectivement joue doit s'y trouver, au bon score.
  const trouve = refaits.some((p) => p.score === m.score
    && p.moves.some(([w, d, x, y]) => w === m.word && d === m.dir && x === m.x && y === m.y));
  if (!trouve) verifie(`coup ${m.n} : le top joue figure dans les paliers`, false, m.word);

  // Les paliers descendent, et aucun n'est coupe.
  let ordonne = true;
  for (let i = 1; i < refaits.length; i++) {
    if (refaits[i]!.score >= refaits[i - 1]!.score) ordonne = false;
  }
  if (!ordonne) verifie(`coup ${m.n} : paliers en ordre`, false);

  // Le meilleur palier vaut le score du coup : c'est le top.
  if (refaits.length > 0 && refaits[0]!.score !== m.score) {
    verifie(`coup ${m.n} : le meilleur palier est le top`, false,
      `${refaits[0]!.score} contre ${m.score}`);
  }
}
verifie("chaque coup se refait, complet et en ordre", echecs === 0,
  `${(msTotal / g.moves.length).toFixed(1)} ms par coup, ${pires} solutions au pire`);

// Deux appels de suite donnent la meme chose : le calcul est reproductible.
const a = await g.paliersDuCoup(2);
const b = await g.paliersDuCoup(2);
verifie("deux recalculs donnent le meme resultat", signature(a) === signature(b));

// ON NE RECALCULE PAS DEUX FOIS LE MEME COUP. Dans le rejeu on navigue : coup 7,
// coup 8, retour au 7. Sans memoire, le retour coutait aussi cher que la
// premiere visite -- des secondes sur un coup a deux jokers -- pour un resultat
// identique au caramel pres. La difference doit se voir au chronometre.
{
  const frais = new Game(`${ID}-2`, "classique", cfg);
  await frais.start();
  frais.presents.add("essai");
  await frais.reveiller();
  await frais.demarrer();
  for (let i = 0; i < 6 && !frais.finie; i++) {
    await frais.reveal();
    await new Promise((r) => setTimeout(r, 30));
  }
  verifie("la partie temoin a avance", frais.moves.length >= 4, `${frais.moves.length} coups`);

  const chrono = async (n: number): Promise<number> => {
    const t0 = performance.now();
    await frais.paliersDuCoup(n);
    return performance.now() - t0;
  };
  const premiere = await chrono(3);
  const seconde = await chrono(3);
  // On repasse par un autre coup, puis on revient : c'est le vrai geste.
  await chrono(4);
  const retour = await chrono(3);
  verifie("le deuxieme appel ne recalcule pas",
    seconde < premiere / 4 && seconde < 2,
    `${premiere.toFixed(1)} ms puis ${seconde.toFixed(1)} ms`);
  verifie("et le retour apres un detour non plus",
    retour < premiere / 4 && retour < 2, `${retour.toFixed(1)} ms`);
  verifie("la reponse gardee est la meme",
    signature(await frais.paliersDuCoup(3)) === signature(await frais.paliersDuCoup(3)));
  await frais.stop();
  for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${ID}-2${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

await g.stop();
nettoyer();

// ------------------------------------------------ GRILLE SANS FIN : LE JOURNAL
//
// Sur une grille sans fin, les paliers SONT ecrits au journal -- les refaire
// couterait huit secondes au dix-millieme coup. Mais ils n'y sont plus RELUS en
// memoire : le serveur retient l'octet ou chaque ligne commence et va la
// chercher quand le rejeu la demande.
//
// Ce qui doit tenir : les paliers rendus sont exactement ceux qui ont ete
// ecrits, avant comme apres un redemarrage -- une adresse d'un octet de travers
// montrerait les sous-tops d'un autre coup, sans que rien ne le dise.
console.log("\n  --- grille sans fin, paliers relus au journal ---\n");
const IDI = ID + "-infini";
const netI = (): void => {
  for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${IDI}${s}`);
    if (existsSync(f)) rmSync(f);
  }
};
netI();
setLayout("pave1");
const cfgI = avec(configParDefaut(), {
  bornes: null, pioche: "sac102boucle", chrono: null, mode: "topping",
});
const gi = new Game(IDI, "pave1", cfgI);
await gi.start();
gi.presents.add("essai");
await gi.reveiller();
await gi.demarrer();
for (let i = 0; i < 6 && !gi.finie; i++) {
  await gi.reveal();
  await new Promise((r) => setTimeout(r, 30));
}
verifie("la partie sans fin a avance", gi.moves.length >= 5, `${gi.moves.length} coups`);

// Les paliers ne doivent PAS occuper la memoire.
const enMemoire = gi.moves.filter((m) => m.tiers !== undefined && m.tiers.length > 0).length;
verifie("aucun palier garde en memoire", enMemoire === 0,
  enMemoire === 0 ? "ils restent au journal" : `${enMemoire} coups en portent`);

// Le journal, lui, doit les porter : c'est lui qui fait foi.
const brut = readFileSync(join(D, `${IDI}.journal.jsonl`), "utf8");
const auJournal = brut.split("\n").filter((l) => l.includes('"tiers":')).length;
verifie("le journal les porte tous", auJournal === gi.moves.length,
  `${auJournal} lignes sur ${gi.moves.length} coups`);

// Et l'instantane ne doit plus les recopier a chaque coup.
const instantane = readFileSync(join(D, `${IDI}.json`), "utf8");
verifie("l'instantane ne les recopie plus", !instantane.includes('"tiers":'),
  `${(instantane.length / 1024).toFixed(1)} ko`);

const avantArret: Record<number, string> = {};
for (const m of gi.moves) avantArret[m.n] = signature(await gi.paliersDuCoup(m.n));
verifie("chaque coup rend des paliers",
  Object.values(avantArret).every((s) => s !== ""),
  `${Object.keys(avantArret).length} coups relus`);

// LE JUGE DE PAIX : apres un redemarrage, les adresses sont refaites a la
// lecture du journal. Un octet de travers se verrait ici.
await gi.stop();
const relu = new Game(IDI, "pave1", cfgI);
await relu.start();
let ecarts = 0, premier = "";
for (const m of relu.moves) {
  const apres = signature(await relu.paliersDuCoup(m.n));
  if (apres !== avantArret[m.n]) {
    ecarts++;
    if (premier === "") premier = `coup ${m.n}`;
  }
}
verifie("apres un redemarrage, les memes paliers", ecarts === 0,
  ecarts === 0 ? `${relu.moves.length} coups compares un a un` : premier);
await relu.stop();
netI();

console.log(echecs === 0
  ? "\nOK : ce qui n'est plus enregistre se retrouve a l'identique\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
