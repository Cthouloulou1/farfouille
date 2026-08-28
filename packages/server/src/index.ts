/**
 * Le serveur. Un processus, PLUSIEURS salons, l'etat en memoire et sur disque,
 * les joueurs relies en WebSocket.
 *
 *     node packages/server/src/index.ts [--port 3000] [--partie mondiale]
 *
 * La grille mondiale est un salon comme un autre, mais permanent et sans
 * proprietaire : personne ne peut la reregler ni la relancer (SPEC.md §16).
 *
 * Pour ouvrir aux autres sans toucher a la box :
 *     cloudflared tunnel --url http://localhost:3000
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Game, type PlayedMove } from "./game.ts";
import {
  ouvrirSalon, relancer, archiver, salon, tousLesSalons, resume,
  salonsEnregistres, fermerSalon, slug, MAX_SALONS, type Salon,
} from "./salons.ts";
import { LAYOUTS } from "../../engine/src/bonus.ts";
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

setLayout(LAYOUT);

// --nouvelle : la grille mondiale repart a zero. Rien n'est efface, les trois
// fichiers sont mis de cote sous un meme horodatage.
if (process.argv.includes("--nouvelle")) {
  const faits = archiver(GAME_ID);
  if (faits.length > 0) {
    console.log(`  partie precedente archivee : ${faits.join(", ")}`);
    console.log(`  (rien n'est efface -- pour la rouvrir : --partie ${faits[0]!.split(".")[1]})`);
  } else {
    console.log(`  aucune partie "${GAME_ID}" a archiver, on part de zero`);
  }
}

/** Variante de la grille mondiale, demandee en ligne de commande (SPEC.md §16). */
const CFG_MONDIALE = (() => {
  const enregistree = Game.configEnregistree(GAME_ID);
  const demande = process.argv.some((a) =>
    a === "--tirage" || a === "--jouables" || a === "--sac102");
  if (enregistree !== null && demande) {
    console.error(
      `\n  La partie "${GAME_ID}" a deja une variante : ` +
      `${enregistree.jouables} sur ${enregistree.tirage}, pioche ${enregistree.pioche}.` +
      `\n  En changer fausserait tous les scores deja joues.` +
      `\n  Lancez --nouvelle pour repartir a zero, ou --partie <autre-nom>.\n`,
    );
    process.exit(1);
  }
  if (enregistree !== null) return deserialiser(enregistree);

  const base = configParDefaut();
  const tirage = Number(arg("tirage", String(base.tirage)));
  const jouables = Number(arg("jouables", String(tirage)));
  if (!Number.isInteger(tirage) || tirage < 2 || tirage > 15) {
    console.error(`\n  --tirage doit etre un entier de 2 a 15 (recu ${arg("tirage", "?")})\n`);
    process.exit(1);
  }
  if (!Number.isInteger(jouables) || jouables < 2 || jouables > tirage) {
    console.error(`\n  --jouables doit etre un entier de 2 a ${tirage} (recu ${arg("jouables", "?")})\n`);
    process.exit(1);
  }
  return avec(base, {
    tirage, jouables,
    pioche: process.argv.includes("--sac102") ? "sac102" : base.pioche,
  });
})();

// ---------------------------------------------------------------- transport

/** Qui est connecte, sous quel pseudo, et dans quel salon. */
interface Client { nom: string; salon: string }
const clients = new Map<WebSocket, Client>();

const send = (ws: WebSocket, msg: unknown): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

/** Diffuse a ceux qui sont DANS ce salon, et a eux seuls. */
const broadcast = (salonId: string, msg: unknown): void => {
  const s = JSON.stringify(msg);
  for (const [ws, c] of clients) {
    if (c.salon === salonId && ws.readyState === ws.OPEN) ws.send(s);
  }
};

const occupants = (salonId: string): string[] =>
  [...new Set([...clients.values()].filter((c) => c.salon === salonId).map((c) => c.nom))]
    .filter((n) => n !== "");

/** Etat public : jamais le top, jamais la liste des coups jouables (SPEC.md §7). */
function publicState(s: Salon) {
  const g = s.partie;
  return {
    salon: s.id,
    nomSalon: s.nom,
    proprietaire: s.proprietaire,
    moveNumber: g.moveNumber,
    rack: g.rack,
    notation: g.rackNotation,
    cumul: g.cumul,
    sac: g.restantDuSac(),
    finie: g.finie,
    solving: g.solving,
    servedAt: g.servedAt,
    chrono: g.cfg.chrono,
    players: g.players,
    likes: Object.fromEntries(Object.keys(g.players).map((p) => [p, g.likesOf(p)])),
    last: g.moves.length > 0 ? publicMove(g.moves[g.moves.length - 1]!) : null,
    online: occupants(s.id),
    createdAt: g.createdAt,
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

/** Branche la diffusion d'etat d'un salon. A refaire apres chaque relance. */
function surveiller(s: Salon): void {
  s.partie.onChange(() => broadcast(s.id, { t: "state", state: publicState(s) }));
  // Tout coup pose part aux clients du salon, qu'il vienne d'un joueur, d'une
  // revelation ou de l'echeance du chrono.
  s.partie.onMove((m) => broadcast(s.id, {
    t: "placed", move: publicMove(m), placements: m.placements, state: publicState(s),
  }));
}

// ---------------------------------------------------------------- ouverture

const salonMondial = await ouvrirSalon({
  id: GAME_ID, nom: "Topping infini", proprietaire: null, prive: false,
  layout: LAYOUT, cfg: CFG_MONDIALE, nouveau: false,
});
surveiller(salonMondial);

// Les salons crees lors des sessions precedentes reprennent ou ils en etaient.
for (const e of salonsEnregistres()) {
  if (e["id"] === GAME_ID) continue;
  try {
    const s = await ouvrirSalon({
      id: e["id"], nom: e["nom"] ?? e["id"], proprietaire: e["proprietaire"] ?? null,
      prive: e["prive"] === true, layout: (e["layout"] ?? LAYOUT) as LayoutName,
      cfg: e["config"] ? deserialiser(e["config"]) : configParDefaut(),
      nouveau: false, creeLe: e["creeLe"],
    });
    surveiller(s);
  } catch (err) {
    console.warn(`[salon] "${e["id"]}" non rouvert : ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- http

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".bin": "application/octet-stream",
};

/**
 * La partie qu'on trouve en entrant dans un salon neuf.
 *
 * Grille bornee : le plateau du commerce et son sac de 102, c'est-a-dire une
 * partie que tout le monde reconnait. Grille infinie : les probabilites
 * ponderees, qui ne s'epuisent jamais.
 */
function configDeDepart(infinie: boolean) {
  const base = configParDefaut();
  return infinie
    ? avec(base, { bornes: null, pioche: "probabilites" })
    : avec(base, {
        bornes: 7, pioche: "sac102",
        pavage: LAYOUTS.classique15, pavageNom: "classique15",
      });
}

/** Un identifiant de salon libre : on suffixe tant que le nom est pris. */
function identifiantLibre(nom: string): string {
  let id = slug(nom);
  let n = 2;
  while (salon(id) !== undefined) id = `${slug(nom)}-${n++}`;
  return id;
}

function json(res: ServerResponse, code: number, corps: unknown): void {
  const s = JSON.stringify(corps);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

async function corpsJson(req: IncomingMessage): Promise<any> {
  const morceaux: Buffer[] = [];
  let taille = 0;
  for await (const c of req) {
    taille += (c as Buffer).length;
    if (taille > 8192) throw new Error("corps trop gros");
    morceaux.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(morceaux).toString("utf8"));
}

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url ?? "/").split("?")[0]!;

  if (url === "/api/salons" && req.method === "GET") {
    json(res, 200, {
      salons: tousLesSalons()
        .filter((s) => !s.prive)
        .map((s) => resume(s, occupants(s.id).length)),
      max: MAX_SALONS,
    });
    return;
  }

  // Un salon prive ne figure pas dans la liste, mais s'ouvre par son adresse.
  if (url.startsWith("/api/salon/") && req.method === "GET") {
    const s = salon(decodeURIComponent(url.slice("/api/salon/".length)));
    if (s === undefined) { json(res, 404, { erreur: "salon introuvable" }); return; }
    json(res, 200, resume(s, occupants(s.id).length));
    return;
  }

  if (url === "/api/salons" && req.method === "POST") {
    try {
      const c = await corpsJson(req);
      const nom = String(c.nom ?? "").trim().slice(0, 40) || "Salon";
      const proprietaire = String(c.proprietaire ?? "").trim().slice(0, 24) || "anonyme";
      // Creer un salon ouvre une partie NORMALE : 15x15, plateau du commerce,
      // 7 sur 7, sac de 102. Tout le reste se regle a l'interieur du salon.
      const s = await ouvrirSalon({
        id: identifiantLibre(nom), nom, proprietaire, prive: c.prive === true,
        layout: LAYOUT, cfg: configDeDepart(c.infinie === true), nouveau: true,
      });
      surveiller(s);
      console.log(`[salon] "${s.nom}" (${s.id}) ouvert par ${proprietaire} : ` +
        `${s.partie.cfg.bornes === null ? "grille infinie" : "15x15"}`);
      json(res, 200, resume(s, 0));
    } catch (e) {
      json(res, 400, { erreur: (e as Error).message });
    }
    return;
  }

  if (url.startsWith("/api/salon/") && req.method === "DELETE") {
    const id = decodeURIComponent(url.slice("/api/salon/".length));
    const s = salon(id);
    if (s === undefined) { json(res, 404, { erreur: "salon introuvable" }); return; }
    if (s.proprietaire === null) {
      json(res, 403, { erreur: "le salon Topping infini est permanent" });
      return;
    }
    const par = String(req.headers["x-pseudo"] ?? "");
    if (par !== s.proprietaire) {
      json(res, 403, { erreur: "seul le créateur du salon peut le supprimer" });
      return;
    }
    // Le salon disparait de la liste ; ses FICHIERS RESTENT. On ne detruit
    // jamais une partie jouee, meme close.
    for (const [ws, v] of clients) {
      if (v.salon === id) send(ws, { t: "refus", message: "Ce salon a été supprimé" });
    }
    await fermerSalon(id);
    console.log(`[salon] "${s.nom}" (${id}) supprime par ${par} -- fichiers conserves`);
    json(res, 200, { ok: true });
    return;
  }

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

// ---------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server: http });

wss.on("connection", (ws) => {
  clients.set(ws, { nom: "", salon: "" });

  ws.on("message", async (raw) => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const moi = clients.get(ws);
    if (moi === undefined) return;
    const s = salon(moi.salon);

    if (msg.t === "join") {
      const nom = String(msg.name ?? "").trim().slice(0, 24) || "anonyme";
      const cible = salon(String(msg.salon ?? GAME_ID));
      if (cible === undefined) {
        send(ws, { t: "refus", message: "Ce salon n'existe plus" });
        return;
      }
      // Deux joueurs du meme nom rendent le classement faux et les statistiques
      // inexploitables : on ne saurait plus a qui attribuer un coup. Tant qu'il
      // n'y a pas de comptes, l'unicite ne vaut que parmi les connectes ; elle
      // s'etendra aux pseudos enregistres quand ils existeront.
      const pris = [...clients.entries()].some(([c, v]) => c !== ws && v.nom === nom);
      if (pris) {
        send(ws, { t: "refus", message: "Ce nom d'utilisateur n'est pas disponible" });
        return;
      }
      clients.set(ws, { nom, salon: cible.id });
      send(ws, {
        t: "hello",
        you: nom,
        gameId: cible.partie.gameId,
        salon: cible.id,
        nomSalon: cible.nom,
        proprietaire: cible.proprietaire,
        layout: cible.partie.layout,
        // Le client rejoue le calcul du score a chaque frappe : sans la
        // variante, il afficherait la prime d'une autre partie.
        config: serialiser(cible.partie.cfg),
        reveal: REVEAL,
        tiles: cible.partie.tiles(),
        moves: cible.partie.moves.map(publicMove),
        chat: cible.partie.chat,
        state: publicState(cible),
      });
      broadcast(cible.id, { t: "state", state: publicState(cible) });
      return;
    }

    if (s === undefined) return;

    // "j'aime" sur un coup : le like va au joueur qui a trouve le top. On ne
    // peut ni s'aimer soi-meme, ni aimer un coup revele sans vainqueur.
    if (msg.t === "like") {
      const n = Number(msg.n);
      if (s.partie.like(moi.nom, n)) {
        broadcast(s.id, {
          t: "likes", n, likers: s.partie.moves.find((q) => q.n === n)?.likes ?? [],
        });
      }
      return;
    }

    if (msg.t === "say") {
      const text = String(msg.text ?? "").trim();
      const cell = msg.cell && Number.isFinite(msg.cell.x) && Number.isFinite(msg.cell.y)
        ? { x: Math.round(msg.cell.x), y: Math.round(msg.cell.y) }
        : undefined;
      if (text.length === 0 && cell === undefined) return;
      broadcast(s.id, { t: "said", msg: s.partie.say(moi.nom, text, cell) });
      return;
    }

    if (msg.t === "try") {
      const r = await s.partie.attempt(
        moi.nom, msg.dir as Dir, Number(msg.x), Number(msg.y), String(msg.typed ?? ""),
      );
      send(ws, { t: "result", ...r });
      return;
    }

    // Relance : reservee au proprietaire du salon. La grille mondiale n'en a
    // pas, donc personne ne peut la relancer.
    if (msg.t === "relancer") {
      if (s.proprietaire === null || s.proprietaire !== moi.nom) {
        send(ws, { t: "result", ok: false, message: "seul le propriétaire relance le salon" });
        return;
      }
      const base = s.partie.cfg;
      const tirage = Math.max(2, Math.min(15, Number(msg.tirage ?? base.tirage)));
      const jouables = Math.max(2, Math.min(tirage, Number(msg.jouables ?? tirage)));
      const pioche = msg.pioche === "sac102" ? "sac102"
        : msg.pioche === "sac102boucle" ? "sac102boucle"
        : msg.pioche === "probabilites" ? "probabilites" : base.pioche;
      // La partie joker a besoin d'un sac : « il ne reste plus de R » n'a aucun
      // sens avec des probabilites qui ne s'epuisent pas.
      const joker = msg.joker === true && pioche !== "probabilites";
      // Primes personnalisees : un nombre de caramels poses, des points. On
      // ne garde que des entiers positifs sur un nombre de caramels plausible.
      const primes: Record<number, number> = {};
      if (msg.primes !== null && typeof msg.primes === "object") {
        for (const [k, v] of Object.entries(msg.primes as Record<string, unknown>)) {
          const n = Number(k), pts = Math.round(Number(v));
          if (!Number.isInteger(n) || n < 1 || n > 15) continue;
          if (!Number.isFinite(pts) || pts < 0 || pts > 9999) continue;
          if (pts > 0) primes[n] = pts;
        }
      }
      const chrono = msg.chrono === null || msg.chrono === undefined ? null
        : Math.max(5, Math.min(3600, Math.round(Number(msg.chrono))));
      const archives = await relancer(s, avec(base, {
        tirage, jouables, pioche, joker,
        chrono: Number.isFinite(chrono as number) ? chrono : null,
        primes: Object.keys(primes).length > 0 ? primes : base.primes,
      }));
      surveiller(s);
      console.log(`[salon] "${s.nom}" relance par ${moi.nom} : ${jouables} sur ${tirage}, ` +
        `pioche ${pioche}${archives.length > 0 ? ` (ancienne partie archivee)` : ""}`);
      for (const [c, v] of clients) {
        if (v.salon !== s.id) continue;
        send(c, {
          t: "relance",
          tiles: s.partie.tiles(),
          moves: [],
          chat: s.partie.chat,
          config: serialiser(s.partie.cfg),
          state: publicState(s),
        });
      }
      return;
    }

    if (msg.t === "reveal") {
      if (!REVEAL) return;   // inerte sauf si le serveur tourne avec --reveler
      await s.partie.reveal();
    }
  });

  ws.on("close", () => {
    const moi = clients.get(ws);
    clients.delete(ws);
    const s = moi ? salon(moi.salon) : undefined;
    if (s !== undefined) broadcast(s.id, { t: "state", state: publicState(s) });
  });
});

// ---------------------------------------------------------------- arret

// Les verrous doivent partir quand le serveur s'arrete, quelle qu'en soit la
// raison. Un SIGKILL ne laisse rien passer : ils restent, et le prochain
// demarrage les reconnait comme perimes puisque leur processus n'existe plus.
const rendreLesVerrous = (): void => {
  for (const s of tousLesSalons()) s.partie.releaseLock();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => { rendreLesVerrous(); process.exit(0); });
}
process.on("exit", rendreLesVerrous);
process.on("uncaughtException", (e) => { rendreLesVerrous(); throw e; });

http.listen(PORT, () => {
  const n = tousLesSalons().length;
  console.log(`\n  Grille "${GAME_ID}" sur le pavage "${LAYOUT}"`);
  console.log(`  ${n} salon${n > 1 ? "s" : ""} ouvert${n > 1 ? "s" : ""}`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Pour ouvrir aux autres :  cloudflared tunnel --url http://localhost:${PORT}`);
  if (REVEAL) console.log('  mode --reveler : le bouton "révéler le top" est visible');
  console.log();
});
