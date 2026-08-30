/**
 * Liste les parties presentes sur le disque.
 *
 *     npm run parties
 *
 * Une partie ancienne ne se retrouve pas en fouillant un dossier a la main :
 * les archives portent un horodatage en millisecondes, illisible tel quel.
 * Cet outil le traduit et donne le nom exact a passer a --partie.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

if (!existsSync(DATA_DIR)) {
  console.log("aucune partie : le dossier de donnees n'existe pas encore");
  process.exit(0);
}

interface Ligne {
  nom: string; coups: number; joueurs: string[]; cree: number | null;
  dernier: number; ouverte: "non" | "oui" | "perime"; source: string;
}

/**
 * Un verrou ne prouve rien a lui seul : sous Windows, une fenetre fermee tue
 * le serveur sans lui laisser le temps de le rendre. On regarde donc si le
 * processus qu'il nomme existe encore.
 */
function verrou(nom: string): "non" | "oui" | "perime" {
  const f = join(DATA_DIR, `${nom}.verrou`);
  if (!existsSync(f)) return "non";
  try {
    const { pid } = JSON.parse(readFileSync(f, "utf8")) as { pid?: number };
    if (pid === undefined) return "perime";
    try { process.kill(pid, 0); return "oui"; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" ? "oui" : "perime"; }
  } catch { return "perime"; }
}

/** Le journal fait foi ; on ne lit l'instantane que faute de mieux. */
function lire(nom: string): Ligne | null {
  const journal = join(DATA_DIR, `${nom}.journal.jsonl`);
  const instantane = join(DATA_DIR, `${nom}.json`);
  const ouverte = verrou(nom);

  if (existsSync(journal)) {
    let coups = 0, cree: number | null = null;
    const joueurs = new Set<string>();
    for (const l of readFileSync(journal, "utf8").split("\n")) {
      if (l.trim() === "") continue;
      let e: any;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.t === "grille") cree = e.createdAt ?? null;
      if (e.t === "coup") { coups++; if (e.move?.player) joueurs.add(e.move.player); }
    }
    return { nom, coups, joueurs: [...joueurs], cree,
             dernier: statSync(journal).mtimeMs, ouverte, source: "journal" };
  }

  if (existsSync(instantane)) {
    try {
      const d = JSON.parse(readFileSync(instantane, "utf8"));
      return { nom, coups: d.moves?.length ?? 0, joueurs: Object.keys(d.players ?? {}),
               cree: d.createdAt ?? null, dernier: statSync(instantane).mtimeMs,
               ouverte, source: "instantane seul" };
    } catch { return null; }
  }
  return null;
}

// Un nom de partie est ce qui precede .json / .journal.jsonl -- horodatage inclus.
const noms = new Set<string>();
for (const f of readdirSync(DATA_DIR)) {
  if (f.endsWith(".journal.jsonl")) noms.add(f.slice(0, -".journal.jsonl".length));
  else if (f.endsWith(".secours.json")) noms.add(f.slice(0, -".secours.json".length));
  else if (f.endsWith(".json")) noms.add(f.slice(0, -".json".length));
}
// `salons` n'est pas une partie mais le registre des salons : le lister ici le
// ferait passer pour une partie vide qu'on pourrait ouvrir.
noms.delete("salons");

const lignes = [...noms].map(lire).filter((l): l is Ligne => l !== null)
  .sort((a, b) => b.dernier - a.dernier);

if (lignes.length === 0) { console.log("aucune partie enregistree"); process.exit(0); }

const date = (t: number | null) => t === null ? "?" : new Date(t).toLocaleString("fr");
const large = Math.max(...lignes.map((l) => l.nom.length), 6);

console.log(`\n  ${lignes.length} partie(s) dans ${DATA_DIR}\n`);
console.log(`  ${"partie".padEnd(large)}  coups  creee le            dernier coup`);
console.log(`  ${"-".repeat(large)}  -----  -------------------  -------------------`);
for (const l of lignes) {
  console.log(
    `  ${l.nom.padEnd(large)}  ${String(l.coups).padStart(5)}  ` +
    `${date(l.cree).padEnd(19)}  ${date(l.dernier)}` +
    (l.ouverte === "oui" ? "   << ouverte par un serveur"
      : l.ouverte === "perime" ? "   (verrou perime, reprise automatique)" : "") +
    (l.source !== "journal" ? `   (${l.source})` : ""),
  );
  if (l.joueurs.length > 0) console.log(`  ${" ".repeat(large)}  joueurs : ${l.joueurs.join(", ")}`);
}
console.log(`\n  Pour en ouvrir une :  npm run serve -- --partie <nom>\n`);
