/**
 * Le verrou d'exclusion d'une partie. Voir SPEC.md §11.
 *
 *     node packages/server/test/check_verrou.ts
 *
 * Un seul serveur a la fois sur une partie -- mais pas un de moins. Le numero
 * de processus ne suffit pas a le savoir : le systeme les RECYCLE. Un serveur
 * tue a ainsi bloque un demarrage parce que son numero avait ete repris par un
 * processus Windows sans rapport. Le battement du verrou tranche : celui qui
 * ne bat plus n'est tenu par personne.
 */
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ID = "verrou-test";
const VERROU = join(D, `${ID}.verrou`);

/** Le processus System de Windows, ou l'init d'un Unix : vivant, et pas nous. */
const ETRANGER = 4;
const vivant = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

function nettoyer(): void {
  for (const s of [".json", ".journal.jsonl", ".verrou", ".secours.json"]) {
    const f = join(D, `${ID}${s}`);
    if (existsSync(f)) rmSync(f);
  }
}

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(52)} ${detail}`);
  if (!ok) echecs++;
}

async function repris(verrou: Record<string, unknown>): Promise<boolean> {
  nettoyer();
  writeFileSync(VERROU, JSON.stringify(verrou), "utf8");
  const g = new Game(ID, "pave1");
  try { await g.start(); await g.stop(); return true; }
  catch { return false; }
}

console.log("\nVerrou d'une partie\n");

if (!vivant(ETRANGER)) {
  console.log(`  (processus temoin ${ETRANGER} absent : test ignore sur ce systeme)`);
  process.exit(0);
}

const t = Date.now();
verifie("verrou frais d'un processus vivant : refuse",
  !(await repris({ pid: ETRANGER, since: t, vu: t })));
verifie("verrou qui ne bat plus, meme processus vivant : repris",
  await repris({ pid: ETRANGER, since: t - 600_000, vu: t - 600_000 }),
  "c'est le cas du numero recycle");
verifie("verrou frais d'un processus mort : repris",
  await repris({ pid: 999_999, since: t, vu: t }));
verifie("verrou d'avant le battement : repris s'il est vieux",
  await repris({ pid: ETRANGER, since: t - 600_000 }));
verifie("verrou illisible : repris",
  await (async () => { nettoyer(); writeFileSync(VERROU, "pas du json", "utf8");
    const g = new Game(ID, "pave1");
    try { await g.start(); await g.stop(); return true; } catch { return false; } })());

nettoyer();
console.log(echecs === 0
  ? "\nOK : un serveur vivant garde sa partie, un verrou mort ne bloque personne\n"
  : `\n${echecs} ECHEC(S)\n`);
process.exit(echecs === 0 ? 0 : 1);
