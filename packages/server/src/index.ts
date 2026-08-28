/**
 * Le serveur de la grille. Un processus, une partie, l'etat en memoire et sur
 * disque, les joueurs relies en WebSocket.
 *
 *     node packages/server/src/index.ts [--port 3000] [--partie mondiale]
 *
 * Pour ouvrir aux autres sans toucher a la box :
 *     cloudflared tunnel --url http://localhost:3000
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync as fileExists, renameSync } from "node:fs";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Game, type PlayedMove } from "./game.ts";
import { avec, configParDefaut, deserialiser, serialiser } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";
import type { Dir } from "../../engine/src/coords.ts";
import { DAWG_PATH } from "../../engine/src/paths.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..", "..", "web");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const PORT = Number(arg("port", "3000"));
const GAME_ID = arg("partie", "mondiale");
const LAYOUT = arg("pavage", "pave1") as LayoutName;
/** Bouton "reveler le top" : commodite de test, absente pour les joueurs. */
const REVEAL = process.argv.includes("--reveler");

// --nouvelle : on met l'ancienne partie de cote plutot que de l'effacer, et on
// repart sur une grille vierge avec une graine tiree au hasard.
//
// LES TROIS FICHIERS partent ensemble, sous le meme horodatage. Oublier le
// journal ne donnerait pas une partie neuve : c'est lui qui fait foi, il serait
// relu au demarrage et l'ancienne partie reviendrait.
if (process.argv.includes("--nouvelle")) {
  const dir = join(here, "..", "data");
  const stamp = Date.now();
  const archived: string[] = [];
  for (const suffix of [".json", ".journal.jsonl", ".secours.json"]) {
    const f = join(dir, `${GAME_ID}${suffix}`);
    if (!fileExists(f)) continue;
    renameSync(f, join(dir, `${GAME_ID}.${stamp}${suffix}`));
    archived.push(`${GAME_ID}.${stamp}${suffix}`);
  }
  if (archived.length > 0) {
    console.log(`  partie precedente archivee : ${archived.join(", ")}`);
    console.log(`  (rien n'est efface -- pour la rouvrir : --partie ${GAME_ID}.${stamp})`);
  } else {
    console.log(`  aucune partie "${GAME_ID}" a archiver, on part de zero`);
  }
}

// Variante demandee en ligne de commande. Voir SPEC.md §16.
//
//   --tirage 8      caramels piochés par coup   (le Y de « X sur Y »)
//   --jouables 7    caramels posables par coup  (le X)
//   --sac102        sac fini de 102 caramels au lieu des probabilités
//
setLayout(LAYOUT);
const demande = process.argv.some((a) =>
  a === "--tirage" || a === "--jouables" || a === "--sac102");
const enregistree = Game.configEnregistree(GAME_ID);

if (enregistree !== null && demande) {
  console.error(
    `
  La partie "${GAME_ID}" a deja une variante : ` +
    `${enregistree.jouables} sur ${enregistree.tirage}, pioche ${enregistree.pioche}.` +
    `
  En changer fausserait tous les scores deja joues.` +
    `
  Lancez --nouvelle pour repartir a zero, ou --partie <autre-nom>.
`,
  );
  process.exit(1);
}

const CFG = enregistree !== null ? deserialiser(enregistree) : (() => {
  const base = configParDefaut();
  const tirage = Number(arg("tirage", String(base.tirage)));
  const jouables = Number(arg("jouables", String(tirage)));
  if (!Number.isInteger(tirage) || tirage < 2 || tirage > 15) {
    console.error(`
  --tirage doit etre un entier de 2 a 15 (recu ${arg("tirage", "?")})
`);
    process.exit(1);
  }
  if (!Number.isInteger(jouables) || jouables < 2 || jouables > tirage) {
    console.error(`
  --jouables doit etre un entier de 2 a ${tirage} (recu ${arg("jouables", "?")})
`);
    process.exit(1);
  }
  return avec(base, {
    tirage, jouables,
    pioche: process.argv.includes("--sac102") ? "sac102" : base.pioche,
  });
})();

const game = new Game(GAME_ID, LAYOUT, CFG);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".bin": "application/octet-stream",
};

const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url ?? "/").split("?")[0]!;

  if (url === "/dawg.bin") {
    const buf = readFileSync(DAWG_PATH);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(buf.length),
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(buf);
    return;
  }

  // Aucun chemin ne doit pouvoir sortir du dossier web.
  const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
  const file = join(WEB, rel);
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("introuvable");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server: http });
const clients = new Map<WebSocket, string>();

const send = (ws: WebSocket, msg: unknown) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};
const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(s);
};

/** Etat public : jamais le top, jamais la liste des coups jouables (SPEC.md §7). */
function publicState() {
  return {
    moveNumber: game.moveNumber,
    rack: game.rack,
    notation: game.rackNotation,
    cumul: game.cumul,
    solving: game.solving,
    servedAt: game.servedAt,
    players: game.players,
    likes: Object.fromEntries(Object.keys(game.players).map((p) => [p, game.likesOf(p)])),
    last: game.moves.length > 0 ? publicMove(game.moves[game.moves.length - 1]!) : null,
    online: [...new Set(clients.values())],
    createdAt: game.createdAt,
    now: Date.now(),
  };
}

/**
 * Un coup, tel qu'il part aux clients.
 *
 * Ni les PALIERS ni le nombre d'ISOTOPS n'y figurent : ils restent dans le
 * fichier de partie, pour l'analyse d'apres-coup, et ne sont jamais diffuses.
 * Ce qui n'est pas envoye ne peut pas etre lu dans la console.
 */
function publicMove(m: PlayedMove) {
  return {
    n: m.n, word: m.word, dir: m.dir, x: m.x, y: m.y, score: m.score,
    player: m.player, ms: m.ms, notation: m.notation, rack: m.rack,
    playerWord: m.playerWord, playerDir: m.playerDir, playerX: m.playerX, playerY: m.playerY,
    likes: m.likes?.length ?? 0,
    likers: m.likes ?? [],
  };
}

game.onChange(() => broadcast({ t: "state", state: publicState() }));

wss.on("connection", (ws) => {
  clients.set(ws, "");

  ws.on("message", async (raw) => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.t === "join") {
      const name = String(msg.name ?? "").trim().slice(0, 24) || "anonyme";
      // Deux joueurs du meme nom rendent le classement faux et les statistiques
      // inexploitables : on ne saurait plus a qui attribuer un coup. Tant qu'il
      // n'y a pas de comptes, l'unicite ne vaut que parmi les connectes ; elle
      // s'etendra aux pseudos enregistres quand ils existeront.
      const pris = [...clients.entries()].some(([c, n]) => c !== ws && n === name);
      if (pris) {
        send(ws, { t: "refus", message: "Ce nom d'utilisateur n'est pas disponible" });
        return;
      }
      clients.set(ws, name);
      send(ws, {
        t: "hello",
        you: name,
        gameId: game.gameId,
        layout: game.layout,
        // Le client rejoue le calcul du score a chaque frappe : sans la
        // variante, il afficherait la prime d'une autre partie.
        config: serialiser(game.cfg),
        reveal: REVEAL,
        tiles: game.tiles(),
        moves: game.moves.map(publicMove),
        chat: game.chat,
        state: publicState(),
      });
      broadcast({ t: "state", state: publicState() });
      return;
    }

    // "j'aime" sur un coup : le like va au joueur qui a trouve le top. On ne
    // peut ni s'aimer soi-meme, ni aimer un coup revele sans vainqueur.
    if (msg.t === "like") {
      const n = Number(msg.n);
      const name = clients.get(ws) || "anonyme";
      if (game.like(name, n)) {
        broadcast({ t: "likes", n, likers: game.moves.find((q) => q.n === n)?.likes ?? [] });
      }
      return;
    }

    if (msg.t === "say") {
      const name = clients.get(ws) || "anonyme";
      const text = String(msg.text ?? "").trim();
      const cell = msg.cell && Number.isFinite(msg.cell.x) && Number.isFinite(msg.cell.y)
        ? { x: Math.round(msg.cell.x), y: Math.round(msg.cell.y) }
        : undefined;
      if (text.length === 0 && cell === undefined) return;
      broadcast({ t: "said", msg: game.say(name, text, cell) });
      return;
    }

    if (msg.t === "try") {
      const name = clients.get(ws) || "anonyme";
      const before = game.moveNumber;
      const r = await game.attempt(name, msg.dir as Dir, Number(msg.x), Number(msg.y), String(msg.typed ?? ""));
      send(ws, { t: "result", ...r });
      if (game.moveNumber !== before) {
        const m = game.moves[game.moves.length - 1]!;
        broadcast({
          t: "placed",
          move: publicMove(m),
          placements: m.placements,
          state: publicState(),
        });
      }
      return;
    }

    if (msg.t === "reveal") {
      if (!REVEAL) return;   // inerte sauf si le serveur tourne avec --reveler
      const before = game.moveNumber;
      await game.reveal();
      if (game.moveNumber !== before) {
        const m = game.moves[game.moves.length - 1]!;
        broadcast({
          t: "placed",
          move: publicMove(m),
          placements: m.placements,
          state: publicState(),
        });
      }
    }
  });

  ws.on("close", () => { clients.delete(ws); broadcast({ t: "state", state: publicState() }); });
});

// Le verrou doit partir quand le serveur s'arrete, quelle qu'en soit la raison.
// Un SIGKILL ne laisse rien passer : le verrou reste, et le prochain demarrage
// le reconnaitra comme perime puisque son processus n'existe plus.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => { game.releaseLock(); process.exit(0); });
}
process.on("exit", () => game.releaseLock());
process.on("uncaughtException", (e) => { game.releaseLock(); throw e; });

try {
  await game.start();
} catch (e) {
  console.error(`
  ${(e as Error).message}
`);
  process.exit(1);
}
http.listen(PORT, () => {
  console.log(`\n  Grille "${GAME_ID}" sur le pavage "${LAYOUT}"`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Pour ouvrir aux autres :  cloudflared tunnel --url http://localhost:${PORT}`);
  if (REVEAL) console.log('  mode --reveler : le bouton "révéler le top" est visible');
  console.log();
});
