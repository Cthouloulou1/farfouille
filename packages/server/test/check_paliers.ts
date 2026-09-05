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
// Sur une grille sans fin, le journal porte LE PALIER DU TOP -- le top et ses
// isotops -- et rien de plus. Les refaire couterait dix-sept secondes au
// vingt-sept-millieme coup, et supposerait que le lexique n'ait pas bouge ;
// mais les sous-tops, eux, ne servent a rien sur une grille qui ne finit
// jamais, et ils pesaient 86 % du fichier.
//
// Ils n'y sont pas RELUS en memoire : le serveur retient l'octet ou chaque
// ligne commence et va la chercher quand le rejeu la demande.
//
// Ce qui doit tenir : les paliers rendus sont exactement ceux qui ont ete
// ecrits, avant comme apres un redemarrage -- une adresse d'un octet de travers
// montrerait les sous-tops d'un autre coup, sans que rien ne le dise.
console.log("\n  --- grille sans fin, paliers relus au journal ---\n");
const IDI = ID + "-infini";
const netI = (): void => {
  for (const s of [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"]) {
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

// Le journal, lui, doit porter le palier du top : c'est lui qui fait foi.
const brut = readFileSync(join(D, `${IDI}.journal.jsonl`), "utf8");
const auJournal = brut.split("\n").filter((l) => l.includes('"tiers":')).length;
verifie("le journal porte le palier du top", auJournal === gi.moves.length,
  `${auJournal} lignes sur ${gi.moves.length} coups`);

// ET RIEN DE PLUS. Un seul palier par coup : celui du top et de ses isotops.
// C'est ce qui fait passer le journal de 3 141 a 509 octets par coup.
let trop = 0;
for (const l of brut.split("\n")) {
  if (!l.includes('"tiers":')) continue;
  const t = (JSON.parse(l) as { move: { tiers: unknown[] } }).move.tiers;
  if (t.length !== 1) trop++;
}
verifie("un seul palier par coup, celui du top", trop === 0,
  trop === 0 ? "les sous-tops ne sont plus ecrits" : `${trop} coups en portent plus`);

// Une grille sans fin ne tient pas d'annexe : personne n'analysera une partie
// qui ne se termine pas.
verifie("pas d'annexe sur une grille sans fin",
  !existsSync(join(D, `${IDI}.paliers.jsonl`)));

const avantArret: Record<number, string> = {};
for (const m of gi.moves) avantArret[m.n] = signature(await gi.paliersDuCoup(m.n));
verifie("chaque coup rend des paliers",
  Object.values(avantArret).every((s) => s !== ""),
  `${Object.keys(avantArret).length} coups relus`);

// LE JUGE DE PAIX : apres un redemarrage, les adresses sont refaites a la
// lecture du journal. Un octet de travers se verrait ici.
await gi.stop();

// L'instantane n'est plus reecrit a chaque coup -- c'est une vue derivee, et
// le journal fait foi. Il l'est a l'arret, et ne recopie pas les paliers.
const instantane = readFileSync(join(D, `${IDI}.json`), "utf8");
verifie("l'instantane est a jour a l'arret",
  (JSON.parse(instantane) as { moves: unknown[] }).moves.length === gi.moves.length,
  `${(instantane.length / 1024).toFixed(1)} ko`);
verifie("et il ne recopie pas les paliers", !instantane.includes('"tiers":'));

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

// ------------------------------------------ GRILLE LIMITEE : L'ANNEXE
//
// Une grille sans fin bornee en coups ou en temps a, elle, une fin -- donc une
// analyse d'apres-partie. Ses sous-tops sont gardes, mais A PART : le journal
// est en ajout seul et adresse a l'octet, on ne peut pas en retirer une ligne
// sans invalider toutes les autres adresses. L'annexe, elle, s'efface d'un
// geste une fois la partie analysee, et le journal ne bouge pas.
console.log("\n  --- grille limitee, sous-tops dans l'annexe ---\n");
const IDA = ID + "-annexe";
const netA = (): void => {
  for (const s of [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${IDA}${s}`);
    if (existsSync(f)) rmSync(f);
  }
};
netA();
setLayout("pave1");
const cfgA = avec(configParDefaut(), {
  bornes: null, pioche: "sac102boucle", chrono: null, mode: "topping", coupsMax: 40,
});
const ga = new Game(IDA, "pave1", cfgA);
await ga.start();
ga.presents.add("essai");
await ga.reveiller();
await ga.demarrer();
for (let i = 0; i < 6 && !ga.finie; i++) {
  await ga.reveal();
  await new Promise((r) => setTimeout(r, 30));
}
verifie("la partie limitee a avance", ga.moves.length >= 5, `${ga.moves.length} coups`);
verifie("l'annexe existe", existsSync(join(D, `${IDA}.paliers.jsonl`)));

const avantA: Record<number, string> = {};
for (const m of ga.moves) avantA[m.n] = signature(await ga.paliersDuCoup(m.n));
const profonds = Object.values(avantA).filter((s) => s.includes(" / ")).length;
verifie("les sous-tops y sont, pas seulement le top", profonds >= 4,
  `${profonds} coups sur ${ga.moves.length} portent plusieurs paliers`);

await ga.stop();
const relueA = new Game(IDA, "pave1", cfgA);
await relueA.start();
let ecartsA = 0;
for (const m of relueA.moves) {
  if (signature(await relueA.paliersDuCoup(m.n)) !== avantA[m.n]) ecartsA++;
}
verifie("apres un redemarrage, les memes sous-tops", ecartsA === 0,
  `${relueA.moves.length} coups compares un a un`);
await relueA.stop();

// ET L'ANNEXE EFFACEE, LA PARTIE TIENT TOUJOURS. C'est tout l'interet de la
// mettre a part : ce qui s'efface est du calcul, jamais la partie.
rmSync(join(D, `${IDA}.paliers.jsonl`));
const sansAnnexe = new Game(IDA, "pave1", cfgA);
await sansAnnexe.start();
verifie("annexe effacee : la partie se relit entiere",
  sansAnnexe.moves.length === relueA.moves.length,
  `${sansAnnexe.moves.length} coups`);
const restant = await sansAnnexe.paliersDuCoup(sansAnnexe.moves[1]!.n);
verifie("et le palier du top reste au journal",
  restant.length >= 1 && restant[0]!.score === sansAnnexe.moves[1]!.score,
  `${restant.length} palier(s)`);
await sansAnnexe.stop();
netA();

console.log(echecs === 0
  ? "\nOK : ce qui n'est plus enregistre se retrouve a l'identique\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
