import { Game } from "./packages/server/src/game.ts";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
const D = "packages/server/data/";
const nettoyer = () => { for (const s of [".json", ".journal.jsonl", ".verrou"]) { try { rmSync(D + "vr" + s); } catch {} } };
nettoyer();

// 1. Un verrou dont le NUMERO est recycle par un autre programme, et qui ne bat plus.
writeFileSync(D + "vr.verrou", JSON.stringify({ pid: process.pid, since: Date.now() - 600000, vu: Date.now() - 600000 }));
const g1 = new Game("vr", "pave1");
await g1.start();
console.log("verrou vieux de 10 min, numero d'un processus BIEN VIVANT (le mien) :");
console.log("   -> repris :", g1.moves.length === 0 ? "oui, la partie s'ouvre" : "?");
const v = JSON.parse(readFileSync(D + "vr.verrou", "utf8"));
console.log(`   -> le verrou porte maintenant pid ${v.pid} et un battement`);
await g1.stop();

// 2. Un verrou FRAIS tenu par un processus vivant : refus.
writeFileSync(D + "vr.verrou", JSON.stringify({ pid: process.pid, since: Date.now(), vu: Date.now() }));
const g2 = new Game("vr", "pave1");
try {
  await g2.start();
  console.log("\nverrou frais d'un processus vivant : ACCEPTE (anormal)");
} catch (e) {
  console.log("\nverrou frais d'un processus vivant : refuse, comme il faut");
  console.log("   " + String(e.message).split("\n")[0]);
}
nettoyer();
