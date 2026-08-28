/**
 * Construit le client, en y gravant l'instant de la compilation.
 *
 *     npm run build
 *
 * L'horodatage sert a detecter une panne qui revient sans cesse : le client est
 * recompile mais le SERVEUR tourne encore l'ancien code. Les reglages partent
 * alors dans le vide, sans que rien ne le signale -- on croit a un bug du jeu
 * alors qu'il suffit de relancer `npm run serve`.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..");
const compileA = Date.now();

await build({
  entryPoints: [join(racine, "packages/web/src/main.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(racine, "packages/web/app.js"),
  define: { __COMPILE_A__: String(compileA) },
  logLevel: "info",
});

console.log(`  client compile a ${new Date(compileA).toLocaleTimeString("fr")}`);
