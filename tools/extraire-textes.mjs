/**
 * Releve les textes francais a traduire.
 *
 *     node tools/extraire-textes.mjs           # ce qui manque a la traduction
 *     node tools/extraire-textes.mjs --tout    # tout, traduit ou non
 *
 * Deux sources :
 *   - le BALISAGE de packages/web/index.html : textes ecrits en dur, plus les
 *     attributs qui se lisent (placeholder, title, aria-label) ;
 *   - le CODE de packages/web/src/main.ts : les litteraux passes a `t(...)` ou
 *     `t2(...)`, c'est-a-dire ceux qui ont deja ete branches.
 *
 * La sortie est la liste des cles qui n'ont pas encore d'anglais dans
 * packages/web/src/textes-en.ts, prete a y etre collee.
 *
 * ON NE DEVINE PAS CE QUI EST TRADUISIBLE DANS LE CODE. Un litteral peut etre
 * un nom de classe CSS, un identifiant, un caractere de dessin : seul l'appel a
 * `t()` dit « ceci se lit ». Brancher un texte, c'est l'entourer de `t()`, et
 * cet outil le voit aussitot.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..");
const tout = process.argv.includes("--tout");

const html = readFileSync(join(racine, "packages/web/index.html"), "utf8");
const code = readFileSync(join(racine, "packages/web/src/main.ts"), "utf8");
const table = readFileSync(join(racine, "packages/web/src/textes-en.ts"), "utf8");

/** Ce que la table connait deja. */
const connus = new Set();
for (const m of table.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)) {
  connus.add(JSON.parse(`"${m[1]}"`));
}

const vus = new Map();          // texte -> d'ou il vient
const ajouter = (texte, ou) => {
  const net = texte.replace(/\s+/g, " ").trim();
  if (net === "") return;
  // Rien a traduire dans un texte sans lettre : un chiffre, une fleche, un tiret.
  if (!/\p{L}{2}/u.test(net)) return;
  if (!vus.has(net)) vus.set(net, ou);
};

// --- le balisage ---------------------------------------------------------
// On retire d'abord tout ce qui n'est pas du texte lu : styles et scripts.
const corps = html
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<!--[\s\S]*?-->/g, "");

for (const m of corps.matchAll(/\b(placeholder|title|aria-label)="([^"]*)"/g)) {
  ajouter(m[2], `html:${m[1]}`);
}
// Le texte entre les balises : on decoupe sur les chevrons.
for (const morceau of corps.split(/<[^>]*>/)) ajouter(morceau, "html");

// --- le code -------------------------------------------------------------
for (const m of code.matchAll(/\bt2?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
  ajouter(JSON.parse(`"${m[1]}"`), "code");
}
for (const m of code.matchAll(/\bt2?\(\s*`([^`$\\]*)`/g)) {
  ajouter(m[1], "code");
}

const manquants = [...vus.entries()].filter(([texte]) => tout || !connus.has(texte));
manquants.sort((a, b) => a[0].localeCompare(b[0], "fr"));

for (const [texte, ou] of manquants) {
  console.log(`  ${JSON.stringify(texte)}: "",${" ".repeat(Math.max(1, 60 - texte.length))}// ${ou}`);
}
console.error(`\n${manquants.length} texte(s) ${tout ? "au total" : "sans traduction"}, ` +
  `sur ${vus.size} releve(s) ; ${connus.size} deja dans la table.`);
