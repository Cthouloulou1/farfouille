/**
 * Une partie enregistree ne se perd pas. Voir SPEC.md §11.
 *
 *     node packages/server/test/check_sauvegarde.ts
 *
 * C'est le test qui compte le plus. Une grille infinie porte des milliers de
 * coups joues a plusieurs pendant des semaines : elle ne doit pas tenir a un
 * fichier qu'on reecrit, ni a un champ qu'on a cesse d'ecrire.
 *
 * Le journal fait foi, et lui seul. Tout le reste -- l'instantane, sa copie de
 * secours, l'annexe des sous-tops -- est une commodite qu'on doit pouvoir
 * effacer sans rien perdre de la partie.
 *
 * Ce test enleve donc les fichiers un a un, et verifie a chaque fois que la
 * partie revient ENTIERE : les memes caramels aux memes cases, les memes coups,
 * les memes joueurs, le meme sac, le meme tirage en cours. Puis il coupe la
 * derniere ligne du journal, comme une panne de courant l'aurait fait, et
 * verifie que la partie s'ouvre quand meme, amputee du seul coup interrompu.
 */
import { rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";
import { configParDefaut, avec } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "sauvegarde-test";
const SUFFIXES = [".json", ".journal.jsonl", ".paliers.jsonl", ".verrou", ".secours.json"];
const f = (suffixe: string): string => join(D, `${ID}${suffixe}`);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(52)} ${detail}`);
  if (!ok) echecs++;
}

function nettoyer(): void {
  for (const s of SUFFIXES) if (existsSync(f(s))) rmSync(f(s));
}

/**
 * TOUT ce qui fait une partie, en une chaine.
 *
 * Les caramels avec leur case, leur lettre et leur drapeau de joker ; les coups
 * avec qui les a trouves ; le classement ; le chat ; le sac ; le tirage en
 * cours. Un octet de travers quelque part se voit ici.
 */
function empreinte(g: Game): string {
  return [
    g.tiles().map((t) => `${t.x},${t.y}${t.l}${t.b}#${t.n}`).join(" "),
    g.moves.map((m) => `${m.n}:${m.word}${m.dir}${m.x},${m.y}=${m.score}/${m.player ?? "-"}`).join(" "),
    Object.entries(g.players).sort().map(([k, v]) => `${k}=${v}`).join(","),
    g.chat.map((c) => `${c.who}:${c.text}`).join("|"),
    `sac=${g.restantDuSac()}`,
    `main=${g.rack}`,
    `jokers=${g.jokersEnReserve}`,
  ].join("\n");
}

/** Rouvre la partie, sert son tirage, et rend son empreinte. */
async function rouvrir(): Promise<{ jeu: Game; vue: string }> {
  setLayout("pave1");
  const cfg = avec(configParDefaut(), {
    bornes: null, pioche: "sac102boucle", chrono: null, mode: "topping",
    coupsMax: 60, joker: true,
  });
  const g = new Game(ID, "pave1", cfg);
  await g.start();
  // Le tirage en cours au moment de l'arret n'est resservi qu'au reveil : sans
  // lui, le sac et la main seraient compares a un autre instant de la partie.
  g.presents.add("essai");
  await g.reveiller();
  return { jeu: g, vue: empreinte(g) };
}

console.log("\nUne partie enregistree ne se perd pas\n");
nettoyer();

// ------------------------------------------------------------ on joue
const depart = await rouvrir();
const g = depart.jeu;
await g.demarrer();
for (let i = 0; i < 12 && !g.finie; i++) {
  await g.reveal();
  await new Promise((r) => setTimeout(r, 20));
}
g.say("essai", "un mot dans le chat, qui doit survivre aussi");
const trouve = g.moves.find((m) => m.player !== null);
if (trouve !== undefined) g.like("quelquun", trouve.n);

verifie("la partie a avance", g.moves.length >= 10, `${g.moves.length} coups`);
const posees = g.tiles().length;
verifie("des caramels sont sur la grille", posees > 30, `${posees} caramels`);
const avecJoker = g.moves.flatMap((m) => m.jokers?.sortis ?? []).length;
verifie("des jokers ont joue", avecJoker > 0, `${avecJoker} lettres nees d'un joker`);

const attendu = empreinte(g);
const paliersAvant = await g.paliersDuCoup(g.moves[2]!.n);
await g.stop();

// ------------------------------------------- 1. la reprise ordinaire
console.log("\n  --- on referme, on rouvre ---\n");
{
  const r = await rouvrir();
  verifie("la partie revient entiere", r.vue === attendu,
    `${r.jeu.moves.length} coups, ${r.jeu.tiles().length} caramels`);
  await r.jeu.stop();
}

// --------------------------- 2. sans instantane ni copie de secours
//
// L'instantane est une vue derivee : il se refait a partir du journal. C'est
// ce qui permet de ne plus le reecrire a chaque coup, et de ne plus en garder
// de copie a cote.
console.log("\n  --- instantane et secours effaces ---\n");
{
  for (const s of [".json", ".secours.json"]) if (existsSync(f(s))) rmSync(f(s));
  verifie("l'instantane n'est plus la", !existsSync(f(".json")));
  const r = await rouvrir();
  verifie("le journal seul suffit a tout retrouver", r.vue === attendu,
    `${r.jeu.moves.length} coups, ${r.jeu.tiles().length} caramels`);
  await r.jeu.stop();
}

// ------------------------------------------------- 3. sans l'annexe
//
// Les sous-tops se recalculent : c'est pour cela qu'ils vivent a part. Les
// effacer ne doit rien coûter d'autre qu'un recalcul.
console.log("\n  --- annexe des sous-tops effacee ---\n");
{
  verifie("l'annexe existait", existsSync(f(".paliers.jsonl")),
    existsSync(f(".paliers.jsonl")) ? `${statSync(f(".paliers.jsonl")).size} octets` : "");
  verifie("elle portait plusieurs paliers", paliersAvant.length > 1,
    `${paliersAvant.length} paliers sur le coup 3`);
  rmSync(f(".paliers.jsonl"));
  const r = await rouvrir();
  verifie("la partie est intacte sans elle", r.vue === attendu,
    `${r.jeu.moves.length} coups, ${r.jeu.tiles().length} caramels`);
  const restant = await r.jeu.paliersDuCoup(r.jeu.moves[2]!.n);
  verifie("le palier du top reste au journal",
    restant.length >= 1 && restant[0]!.score === r.jeu.moves[2]!.score,
    `${restant.length} palier(s), ${restant[0]?.moves.length ?? 0} solution(s)`);
  await r.jeu.stop();
}

// ------------------------------- 4. un journal qui mele les deux formats
//
// LE CAS DE TOUTE PARTIE EN COURS. Une partie commencee avant ce changement a
// deja des centaines de lignes qui portent leurs placements ; celles qui
// s'ajoutent apres n'en ont plus. Le meme journal porte donc les deux formats,
// et doit se relire comme si de rien n'etait -- chaque ligne est autonome, et
// les placements ne se refont que la ou ils manquent.
console.log("\n  --- journal mele : anciennes lignes et nouvelles ---\n");
{
  const lignes = readFileSync(f(".journal.jsonl"), "utf8").split("\n");
  let remises = 0;
  const melees = lignes.map((l) => {
    if (l.indexOf('"t":"coup"') < 0 || remises >= 3) return l;
    const ev = JSON.parse(l) as { move: { n: number } };
    // On remet les placements que la partie avait en memoire : c'est trait pour
    // trait ce qu'une ligne d'avant le changement contient.
    const m = g.moves.find((q) => q.n === ev.move.n);
    if (m === undefined) return l;
    remises++;
    return JSON.stringify({ t: "coup", move: { ...ev.move, placements: m.placements } });
  });
  writeFileSync(f(".journal.jsonl"), melees.join("\n"));
  if (existsSync(f(".json"))) rmSync(f(".json"));
  verifie("trois lignes remises a l'ancien format", remises === 3);

  const r = await rouvrir();
  verifie("la partie revient entiere malgre le melange", r.vue === attendu,
    `${r.jeu.moves.length} coups, ${r.jeu.tiles().length} caramels`);
  await r.jeu.stop();
}

// ------------------------------------ 5. une ligne coupee par une panne
//
// Le journal est force sur le disque a chaque ligne, mais une coupure peut
// toujours tomber PENDANT une ecriture. La ligne a moitie ecrite doit etre
// ignoree, et tout ce qui la precede revenir intact : c'est le seul coup perdu,
// celui qui n'avait pas fini d'etre enregistre.
console.log("\n  --- derniere ligne coupee net, comme une panne ---\n");
{
  const brut = readFileSync(f(".journal.jsonl"));
  // On coupe au milieu de la derniere ligne, la ou l'ecriture se serait arretee.
  const derniere = brut.lastIndexOf(10, brut.length - 2);
  const coupee = brut.subarray(0, derniere + 1 + Math.floor((brut.length - derniere) / 2));
  writeFileSync(f(".journal.jsonl"), coupee);
  if (existsSync(f(".json"))) rmSync(f(".json"));

  const r = await rouvrir();
  const coups = r.jeu.moves.length;
  verifie("la partie s'ouvre quand meme", coups > 0, `${coups} coups`);
  verifie("elle n'a perdu que la ligne coupee", coups >= g.moves.length - 1,
    `${coups} coups contre ${g.moves.length} avant la panne`);
  // Et elle repart : le tirage suivant est servi, la partie continue.
  verifie("et elle repart", r.jeu.rack !== "", `tirage ${r.jeu.rack}`);
  await r.jeu.stop();
}

nettoyer();
console.log(echecs === 0
  ? "\nOK : le journal fait foi, et tout le reste peut disparaitre\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
