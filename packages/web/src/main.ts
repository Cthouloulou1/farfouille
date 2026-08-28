/**
 * Le client. Voir SPEC.md §9.
 *
 * Il partage le moteur avec le serveur -- meme dictionnaire, meme scoring, meme
 * resolution d'un mot tape. La validation est donc INSTANTANEE et locale, et un
 * mot accepte a l'ecran ne peut pas etre refuse ensuite.
 *
 * Le serveur reste seul juge de qui remporte le coup, sur l'ordre d'arrivee.
 */
import { Dict } from "../../engine/src/dictionary.ts";
import { Board, type Placement } from "../../engine/src/board.ts";
import { configParDefaut, deserialiser, type ConfigPartie } from "../../engine/src/config.ts";
import { bonusChar, setLayout, type LayoutName } from "../../engine/src/bonus.ts";
import { valueOf, BLANK } from "../../engine/src/alphabet.ts";
import { step, formatMove, type Dir } from "../../engine/src/coords.ts";
import { resolveTypedWord, PLAY_MESSAGE } from "../../engine/src/play.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>("cv");
const ctx = cv.getContext("2d")!;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

interface Tile { x: number; y: number; l: string; b: 0 | 1; n: number }
interface MoveInfo {
  n: number; word: string; dir: Dir; x: number; y: number; score: number;
  player: string | null; ms: number; notation: string; rack: string;
  playerWord?: string; playerDir?: Dir; playerX?: number; playerY?: number;
  /** Nombre de "j'aime" recus, et qui les a donnes. */
  likes?: number; likers?: string[];
}
interface Chat { at: number; who: string; text: string; cell?: { x: number; y: number } }

let dict: Dict;
/** Le dictionnaire n'est telecharge qu'une fois, au premier salon rejoint. */
let dictCharge = false;
let board: Board;
/** La variante jouee, envoyee par le serveur a la connexion. */
let cfg: ConfigPartie = configParDefaut();
/** La partie est terminee : plus de tirage, plus de chrono, plus de saisie. */
let finie = false;
let tiles: Tile[] = [];
let history: MoveInfo[] = [];
let me = "";
let ws: WebSocket | null = null;
let canReveal = false;

let rack = "";
let moveNumber = 0;
let cumul = 0;
let solving = true;
let players: Record<string, number> = {};
/** "J'aime" recus par joueur sur toute la partie. */
let likes: Record<string, number> = {};
let online: string[] = [];
let last: MoveInfo | null = null;
let createdAt = Date.now();
let servedAt = Date.now();
/** Ecart entre l'horloge du serveur et la notre. */
let clockSkew = 0;

let cursor: { x: number; y: number; dir: Dir } | null = null;
let typed = "";
let best: { word: string; score: number; dir: Dir; x: number; y: number } | null = null;
let openPlayer: string | null = null;
let marks: { x: number; y: number }[] = [];

/** Coup examine : la grille est rembobinee et une solution posee par-dessus. */
/** Le coup mis en evidence sur la grille, quand on en clique un. */
let ghost: [string, Dir, number, number] | null = null;

let cell = 30, ox = 0, oy = 0, W = 0, H = 0;

// ---------------------------------------------------------------- rendu

function resize() {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function typedCells(): { x: number; y: number; letter: string }[] {
  if (cursor === null) return [];
  const { dx, dy } = step(cursor.dir);
  const out: { x: number; y: number; letter: string }[] = [];
  let i = 0, px = cursor.x, py = cursor.y, guard = 0;
  while (i < typed.length && guard++ < 40) {
    if (board.at(px, py) === undefined) { out.push({ x: px, y: py, letter: typed[i]! }); i++; }
    px += dx; py += dy;
  }
  return out;
}

function nextFree(): { x: number; y: number } | null {
  if (cursor === null) return null;
  const { dx, dy } = step(cursor.dir);
  const busy = new Set(typedCells().map((c) => `${c.x},${c.y}`));
  let px = cursor.x, py = cursor.y, guard = 0;
  while (guard++ < 40) {
    if (board.at(px, py) === undefined && !busy.has(`${px},${py}`)) return { x: px, y: py };
    px += dx; py += dy;
  }
  return null;
}

/** Quelles lettres tapees sont posees par un joker, d'apres le moteur lui-meme. */
function blankPositions(): Set<string> {
  const out = new Set<string>();
  if (cursor === null || typed.length === 0) return out;
  const r = resolveTypedWord(board, dict, cursor.dir, cursor.x, cursor.y, typed, rack, false, true);
  if (!r.ok) return out;
  for (const p of r.move.placements) if (p.blank) out.add(`${p.x},${p.y}`);
  return out;
}

function draw() {
  const C = {
    field: css("--field"), line: css("--field-line"), face: css("--tile-face"),
    edge: css("--tile-edge"), ink: css("--tile-ink"), accent: css("--accent"),
    cursor: css("--cursor"), mark: css("--mark"), faint: css("--ink-faint"),
    panel: css("--panel"), rule: css("--rule"), abg: css("--accent-bg"), dark: css("--ink"),
    jface: css("--joker-face"), jedge: css("--joker-edge"),
    T: css("--mct"), D: css("--mcd"), t: css("--lct"), d: css("--lcd"),
  };
  ctx.fillStyle = C.field;
  ctx.fillRect(0, 0, W, H);

  const gx0 = Math.floor(-ox / cell) - 1, gx1 = Math.ceil((W - ox) / cell) + 1;
  const gy0 = Math.floor(-oy / cell) - 1, gy1 = Math.ceil((H - oy) / cell) + 1;
  // Bords arrondis au pixel : sinon deux cases voisines tombent sur des
  // fractions differentes et laissent des lisieres irregulieres.
  const eX = (x: number) => Math.round(ox + x * cell);
  const eY = (y: number) => Math.round(oy + y * cell);

  for (let y = gy0; y <= gy1; y++) {
    for (let x = gx0; x <= gx1; x++) {
      const ch = bonusChar(x, y);
      if (ch === ".") continue;
      ctx.fillStyle = (C as Record<string, string>)[ch === "*" ? "D" : ch] ?? C.D;
      ctx.fillRect(eX(x), eY(y), eX(x + 1) - eX(x), eY(y + 1) - eY(y));
    }
  }

  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = gx0; x <= gx1; x++) { const p = eX(x) + .5; ctx.moveTo(p, 0); ctx.lineTo(p, H); }
  for (let y = gy0; y <= gy1; y++) { const p = eY(y) + .5; ctx.moveTo(0, p); ctx.lineTo(W, p); }
  ctx.stroke();

  if (tiles.length === 0) {
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
    ctx.strokeRect(eX(0) + 1, eY(0) + 1, eX(1) - eX(0) - 2, eY(1) - eY(0) - 2);
  }

  const gap = cell >= 22 ? 1 : 0;
  const rad = Math.max(.8, cell * .05);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const caramel = (x: number, y: number, letter: string, blank: boolean, face: string, edge: string) => {
    const px = eX(x) + gap, py = eY(y) + gap;
    const w = eX(x + 1) - eX(x) - gap * 2, h = eY(y + 1) - eY(y) - gap * 2;
    roundRect(px, py, w, h, rad);
    ctx.fillStyle = face; ctx.fill();
    roundRect(px + .5, py + .5, w - 1, h - 1, rad);
    ctx.lineWidth = 1; ctx.strokeStyle = edge; ctx.stroke();
    ctx.fillStyle = blank ? C.jedge : C.ink;
    ctx.font = `700 ${Math.round(h * .62)}px Archivo, system-ui, sans-serif`;
    ctx.fillText(letter, px + w / 2, py + h * .53);
    // Un joker vaut zero, et il l'affiche : le 0 dit ce qu'il rapporte.
    const v = blank ? 0 : valueOf(letter);
    if (h >= 18) {
      ctx.fillStyle = blank ? C.jedge : C.ink; ctx.globalAlpha = blank ? .8 : .6;
      ctx.font = `500 ${Math.round(h * .27)}px "IBM Plex Mono", monospace`;
      ctx.textAlign = "right";
      ctx.fillText(String(v), px + w - w * .1, py + h * .84);
      ctx.textAlign = "center"; ctx.globalAlpha = 1;
    }
  };

  // Le dernier coup joue reste souligne sur la grille.
  const hl = new Set(
    last === null ? [] : tiles.filter((t) => t.n === last!.n).map((t) => `${t.x},${t.y}`),
  );
  for (const t of tiles) {
    if (t.x < gx0 || t.x > gx1 || t.y < gy0 || t.y > gy1) continue;
    caramel(t.x, t.y, t.l, t.b === 1,
      t.b === 1 ? C.jface : C.face,
      hl.has(`${t.x},${t.y}`) ? C.accent : t.b === 1 ? C.jedge : C.edge);
  }

  const blanks = blankPositions();
  for (const c of typedCells()) {
    const isBlank = blanks.has(`${c.x},${c.y}`);
    caramel(c.x, c.y, c.letter, isBlank, isBlank ? C.jface : C.face, isBlank ? C.jedge : C.cursor);
  }

  if (ghost !== null && cell >= 6) {
    const [word, dir, gx, gy] = ghost;
    for (let i = 0; i < word.length; i++) {
      const x = dir === "H" ? gx + i : gx;
      const y = dir === "V" ? gy + i : gy;
      if (x < gx0 || x > gx1 || y < gy0 || y > gy1) continue;
      caramel(x, y, word[i]!, false, C.abg, C.mark);
    }
  }

  // Cases partagees dans le chat.
  for (const m of marks) {
    if (m.x < gx0 || m.x > gx1 || m.y < gy0 || m.y > gy1) continue;
    ctx.strokeStyle = C.mark; ctx.lineWidth = 2;
    ctx.strokeRect(eX(m.x) + 1, eY(m.y) + 1, eX(m.x + 1) - eX(m.x) - 2, eY(m.y + 1) - eY(m.y) - 2);
  }

  const nf = nextFree();
  if (cursor !== null && nf !== null) {
    const px = eX(nf.x), py = eY(nf.y);
    const w = eX(nf.x + 1) - px, h = eY(nf.y + 1) - py;
    ctx.strokeStyle = C.cursor; ctx.lineWidth = 1;
    ctx.strokeRect(px + 1.5, py + 1.5, w - 3, h - 3);
    ctx.fillStyle = C.cursor;
    ctx.beginPath();
    const m = w * .22;
    if (cursor.dir === "H") {
      ctx.moveTo(px + w - 3, py + h / 2);
      ctx.lineTo(px + w - 3 - m, py + h / 2 - m / 1.6);
      ctx.lineTo(px + w - 3 - m, py + h / 2 + m / 1.6);
    } else {
      ctx.moveTo(px + w / 2, py + h - 3);
      ctx.lineTo(px + w / 2 - m / 1.6, py + h - 3 - m);
      ctx.lineTo(px + w / 2 + m / 1.6, py + h - 3 - m);
    }
    ctx.closePath(); ctx.fill();
  }

  drawRulers(C, gx0, gx1, gy0, gy1);
}

/**
 * Regle graduee sur les deux bords, facon tableur. On lit la position d'un mot
 * sans compter les cases -- indispensable pour se reperer a l'oral ou dans le
 * chat, sur une grille qui n'a ni centre ni bord.
 */
function drawRulers(C: Record<string, string>, gx0: number, gx1: number, gy0: number, gy1: number) {
  const TOP = 17, LEFT = 30;
  ctx.fillStyle = C.panel!;
  ctx.fillRect(0, 0, W, TOP);
  ctx.fillRect(0, 0, LEFT, H);

  const mark = ghost !== null
    ? extentOf(ghost[0], ghost[1], ghost[2], ghost[3])
    : cursor !== null ? { x0: cursor.x, y0: cursor.y, x1: cursor.x, y1: cursor.y } : null;
  if (mark !== null) {
    ctx.fillStyle = C.abg!;
    const sx = ox + mark.x0 * cell, sw = (mark.x1 - mark.x0 + 1) * cell;
    const sy = oy + mark.y0 * cell, sh = (mark.y1 - mark.y0 + 1) * cell;
    if (sx + sw > LEFT) ctx.fillRect(Math.max(LEFT, sx), 0, Math.min(sw, W - Math.max(LEFT, sx)), TOP);
    if (sy + sh > TOP) ctx.fillRect(0, Math.max(TOP, sy), LEFT, Math.min(sh, H - Math.max(TOP, sy)));
  }

  ctx.strokeStyle = C.rule!;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, TOP + .5); ctx.lineTo(W, TOP + .5);
  ctx.moveTo(LEFT + .5, 0); ctx.lineTo(LEFT + .5, H);
  ctx.stroke();

  const stepBy = Math.max(1, Math.ceil(30 / cell));
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let x = gx0; x <= gx1; x++) {
    const on = mark !== null && x >= mark.x0 && x <= mark.x1;
    if (!on && x % stepBy !== 0) continue;
    const px = ox + x * cell + cell / 2;
    if (px < LEFT + 9 || px > W - 4) continue;
    ctx.fillStyle = on ? C.dark! : C.faint!;
    ctx.fillText(String(x), px, TOP / 2);
  }
  for (let y = gy0; y <= gy1; y++) {
    const on = mark !== null && y >= mark.y0 && y <= mark.y1;
    if (!on && y % stepBy !== 0) continue;
    const py = oy + y * cell + cell / 2;
    if (py < TOP + 7 || py > H - 4) continue;
    ctx.fillStyle = on ? C.dark! : C.faint!;
    ctx.fillText(String(y), LEFT / 2, py);
  }
}

function extentOf(word: string, dir: Dir, x: number, y: number) {
  return { x0: x, y0: y, x1: dir === "H" ? x + word.length - 1 : x, y1: dir === "V" ? y + word.length - 1 : y };
}

// ------------------------------------------------------------- camera

function readableCell() { return Math.max(14, Math.min(36, Math.min(W, H) / 16)); }

function alreadyVisible(word: string, dir: Dir, x: number, y: number) {
  if (cell < 11) return false;
  const e = extentOf(word, dir, x, y);
  const m = 1.5;
  return ox + (e.x0 - m) * cell >= 0 && ox + (e.x1 + 1 + m) * cell <= W
      && oy + (e.y0 - m) * cell >= 0 && oy + (e.y1 + 1 + m) * cell <= H;
}

let anim = 0;
function flyTo(word: string, dir: Dir, x: number, y: number) {
  const t = readableCell();
  const e = extentOf(word, dir, x, y);
  const to = { cell: t, ox: W / 2 - ((e.x0 + e.x1 + 1) / 2) * t, oy: H / 2 - ((e.y0 + e.y1 + 1) / 2) * t };
  if (anim) cancelAnimationFrame(anim);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cell = to.cell; ox = to.ox; oy = to.oy; draw(); return;
  }
  const from = { cell, ox, oy };
  const cx = (W / 2 - to.ox) / to.cell, cy = (H / 2 - to.oy) / to.cell;
  const nx = (W / 2 - from.ox) / from.cell, ny = (H / 2 - from.oy) / from.cell;
  const dist = Math.hypot(cx - nx, cy - ny);
  const far = dist > 30;
  const out = Math.max(4, Math.min(from.cell, to.cell) / Math.max(1, dist / 22));
  const dur = far ? 700 : 360;
  const t0 = performance.now();
  const ease = (p: number) => (p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const stepFn = (now: number) => {
    const p = Math.min(1, (now - t0) / dur), q = ease(p);
    const arc = far ? Math.sin(Math.PI * q) : 0;
    cell = from.cell + (to.cell - from.cell) * q - (Math.min(from.cell, to.cell) - out) * arc;
    const gx = nx + (cx - nx) * q, gy = ny + (cy - ny) * q;
    ox = W / 2 - gx * cell; oy = H / 2 - gy * cell;
    draw();
    anim = p < 1 ? requestAnimationFrame(stepFn) : 0;
  };
  anim = requestAnimationFrame(stepFn);
}

/** Ne bouge la camera QUE si la cible est hors champ : sinon on a le mal de mer. */
function reveal(word: string, dir: Dir, x: number, y: number) {
  if (!alreadyVisible(word, dir, x, y)) flyTo(word, dir, x, y);
  else draw();
}

// ---------------------------------------------------------------- panneaux

function remaining(): string[] {
  const left = [...rack];
  const blanks = blankPositions();
  for (const c of typedCells()) {
    const useBlank = blanks.has(`${c.x},${c.y}`);
    let i = useBlank ? left.indexOf(BLANK) : left.indexOf(c.letter);
    if (i === -1) i = left.indexOf(c.letter);
    if (i === -1) i = left.indexOf(BLANK);
    if (i !== -1) left.splice(i, 1);
  }
  return left;
}

function paintRack() {
  const box = $("rb-tiles");
  box.replaceChildren();
  for (const ch of remaining()) {
    const el = document.createElement("div");
    const joker = ch === BLANK;
    el.className = "caramel" + (joker ? " joker" : "");
    el.textContent = joker ? "?" : ch;
    if (!joker) {
      const v = valueOf(ch);
      if (v) { const s = document.createElement("i"); s.textContent = String(v); el.appendChild(s); }
    }
    box.appendChild(el);
  }
}

function fmtTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")}`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} j ${String(Math.floor((s % 86400) / 3600)).padStart(2, "0")} h`;
}

/** Le mot en cours de frappe et son score, mis a jour a chaque lettre. */
function paintCurrent() {
  const w = $("cur-word"), meta = $("cur-meta"), bad = $("cur-bad");
  bad.hidden = true;

  if (cursor !== null && typed.length > 0) {
    const r = resolveTypedWord(board, dict, cursor.dir, cursor.x, cursor.y, typed, rack, false, true);
    if (r.ok) {
      w.className = "word";
      w.innerHTML = `<span>${r.move.word}</span><span class="pts">${r.move.score}</span>`;
      meta.textContent = formatMove(r.move.dir, r.move.x, r.move.y);
      return;
    }
    w.className = "word";
    w.innerHTML = `<span>${r.word ?? typed}</span><span class="pts">—</span>`;
    meta.textContent = PLAY_MESSAGE[r.error];
    if (r.bad && r.bad.length > 0) {
      bad.hidden = false;
      bad.textContent = r.bad.length > 1 ? `collages faux : ${r.bad.join(", ")}` : `collage faux : ${r.bad[0]}`;
    }
    return;
  }

  if (best !== null) {
    w.className = "word";
    w.innerHTML = `<span>${best.word}</span><span class="pts">${best.score}</span>`;
    meta.textContent = `${formatMove(best.dir, best.x, best.y)} · votre meilleure solution`;
    return;
  }
  w.className = "word none";
  w.textContent = "—";
  meta.textContent = "";
}

function paintSide() {
  $("rb-move").textContent = finie ? "—" : solving ? "…" : String(moveNumber + 1);
  $("fin").hidden = !finie;
  $("rb-cumul").textContent = cumul.toLocaleString("fr");
  paintCurrent();

  const lw = $("last-word"), lm = $("last-meta"), ll = $("last-like");
  ll.replaceChildren();
  if (last === null) { lw.className = "word none"; lw.textContent = "—"; lm.textContent = ""; }
  else {
    lw.className = "word";
    lw.innerHTML = `<span>${last.word}</span><span class="pts">${last.score}</span>`;
    lm.textContent = `${formatMove(last.dir, last.x, last.y)} · ${last.player ?? "révélé"} · ${fmtTime(last.ms)}`;
    ll.appendChild(likeButton(last));
  }

  const rank = $("rank");
  rank.replaceChildren();
  const rows = Object.entries(players).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    const s = document.createElement("div");
    s.className = "none"; s.textContent = "personne encore";
    rank.appendChild(s);
  }
  for (const [name, n] of rows) {
    const row = document.createElement("button");
    row.className = "prow" + (name === me ? " me" : "");
    const got = likes[name] ?? 0;
    row.innerHTML = `<span class="tri">${openPlayer === name ? "▾" : "▸"}</span><span>${name}</span>` +
                    (got > 0 ? `<span class="likes">♥ ${got}</span>` : "") +
                    `<span class="num">${n}</span>`;
    row.addEventListener("click", () => { openPlayer = openPlayer === name ? null : name; paintSide(); });
    rank.appendChild(row);

    if (openPlayer === name) {
      const list = document.createElement("div");
      list.className = "plist";
      const mine = history.filter((m) => m.player === name).reverse();
      if (mine.length === 0) {
        const e = document.createElement("div");
        e.className = "none"; e.textContent = "aucun coup enregistré";
        list.appendChild(e);
      }
      for (const m of mine) {
        const r = document.createElement("button");
        r.className = "pmove";
        // Ce que le JOUEUR a tape, qui peut differer du mot retenu par le logiciel.
        const shown = m.playerWord ?? m.word;
        r.innerHTML = `<span class="n">${m.n}</span><span class="w">${shown}</span>` +
                      `<span class="s">${m.score}</span><span class="t">${fmtTime(m.ms)}</span>`;
        r.title = m.playerWord && m.playerWord !== m.word
          ? `${shown} — le logiciel a retenu ${m.word}` : shown;
        r.addEventListener("click", () => focusMove(m));
        r.appendChild(likeButton(m));
        list.appendChild(r);
      }
      rank.appendChild(list);
    }
  }

  $("online").textContent = online.length > 0 ? online.join(", ") : "—";
  $("reveal-wrap").hidden = !canReveal;
  ($("reveal") as HTMLButtonElement).disabled = solving;
}

// ---------------------------------------------------------------- coups passes

/**
 * Amene la camera sur un coup et le met en evidence. Rien de plus.
 *
 * Les isotops et les sous-tops NE SONT PAS montres : ils restent dans le
 * fichier de partie, en reserve, pour l'analyse d'apres-partie. Le serveur ne
 * les envoie meme pas.
 */
function focusMove(m: MoveInfo) {
  ghost = [m.word, m.dir, m.x, m.y];
  $("roadmap").hidden = true;
  reveal(m.word, m.dir, m.x, m.y);
}

/**
 * Le bouton "j'aime". Le like va au joueur qui a trouve le top ; on ne s'aime
 * pas soi-meme, et un coup revele sans vainqueur n'a personne a feliciter.
 */
function likeButton(m: MoveInfo): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "like";
  b.type = "button";
  const mine = (m.likers ?? []).includes(me);
  b.setAttribute("aria-pressed", String(mine));
  b.title = m.player === null ? "coup révélé, personne à féliciter"
    : m.player === me ? "votre coup" : `bravo à ${m.player}`;
  b.disabled = m.player === null || m.player === me;
  b.innerHTML = `<span aria-hidden="true">${mine ? "♥" : "♡"}</span>` +
                `<span class="n">${m.likes ?? 0}</span>`;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    ws?.send(JSON.stringify({ t: "like", n: m.n }));
  });
  return b;
}

$("last-word").addEventListener("click", () => {
  if (last !== null) focusMove(last);
});

// ---------------------------------------------------------------- feuille de route

function paintRoadmap() {
  const body = $("rm-body");
  body.replaceChildren();
  if (history.length === 0) {
    const e = document.createElement("div");
    e.className = "none"; e.style.padding = "14px 18px"; e.textContent = "aucun coup joué";
    body.appendChild(e);
    return;
  }
  for (const m of [...history].reverse()) {
    const r = document.createElement("button");
    r.className = "rmrow";
    r.innerHTML =
      `<span class="n">${m.n}</span><span class="q">${m.notation}</span>` +
      `<span class="w">${m.word}</span><span class="p">${formatMove(m.dir, m.x, m.y)}</span>` +
      `<span class="s">${m.score}</span><span class="who">${m.player ?? "—"}</span>` +
      `<span class="t">${fmtTime(m.ms)}</span>`;
    r.addEventListener("click", () => focusMove(m));
    r.appendChild(likeButton(m));
    body.appendChild(r);
  }
}
$("rm-open").addEventListener("click", () => { paintRoadmap(); $("roadmap").hidden = false; });
$("rm-close").addEventListener("click", () => { $("roadmap").hidden = true; });

// ---------------------------------------------------------------- chat

function paintChat(msgs: Chat[]) {
  const log = $("chat-log");
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren();
  for (const m of msgs) {
    const el = document.createElement("div");
    el.className = "msg";
    const who = document.createElement("span");
    who.className = "who"; who.textContent = m.who;
    el.appendChild(who);
    if (m.text) el.appendChild(document.createTextNode(m.text));
    if (m.cell) {
      const b = document.createElement("button");
      b.className = "cellref";
      b.textContent = `${m.cell.x},${m.cell.y}`;
      b.addEventListener("click", () => {
        marks = [m.cell!];
        flyTo("A", "H", m.cell!.x, m.cell!.y);
      });
      el.appendChild(b);
    }
    const at = document.createElement("span");
    at.className = "at";
    at.textContent = new Date(m.at).toLocaleTimeString("fr", { hour: "2-digit", minute: "2-digit" });
    el.appendChild(at);
    log.appendChild(el);
  }
  if (atBottom) log.scrollTop = log.scrollHeight;
}

let chat: Chat[] = [];
function sendChat(withCell: boolean) {
  const input = $("chat-text") as HTMLInputElement;
  const text = input.value.trim();
  const cell = withCell && cursor !== null ? { x: cursor.x, y: cursor.y } : undefined;
  if (!text && !cell) return;
  ws?.send(JSON.stringify({ t: "say", text, cell }));
  input.value = "";
}
$("chat-send").addEventListener("click", () => sendChat(false));
$("chat-cell").addEventListener("click", () => {
  if (cursor === null) { flash("cliquez d'abord une case", "bad"); return; }
  sendChat(true);
});
$("chat-text").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e as KeyboardEvent).key === "Enter") sendChat(false);
});

// ---------------------------------------------------------------- saisie

let flashTimer = 0;
function flash(text: string, kind: "bad" | "ok" | "top") {
  const el = $("flash");
  el.textContent = text;
  el.className = `flash ${kind}`;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { el.hidden = true; }, kind === "top" ? 2600 : 1900);
}

cv.addEventListener("contextmenu", (e) => e.preventDefault());

let press: { x: number; y: number; button: number; moved: boolean; at: number } | null = null;
let holdTimer = 0;

cv.addEventListener("pointerdown", (e) => {
  press = { x: e.clientX, y: e.clientY, button: e.button, moved: false, at: Date.now() };
  cv.setPointerCapture(e.pointerId);
  if (e.button === 1) e.preventDefault();
  // Clic droit MAINTENU : proposition de partager la case dans le chat.
  if (e.button === 2) {
    const r = cv.getBoundingClientRect();
    const gx = Math.floor((e.clientX - r.left - ox) / cell);
    const gy = Math.floor((e.clientY - r.top - oy) / cell);
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      if (press === null || press.moved) return;
      press = null;
      ws?.send(JSON.stringify({ t: "say", text: "", cell: { x: gx, y: gy } }));
      flash(`case ${gx},${gy} partagée`, "ok");
    }, 550);
  }
});

cv.addEventListener("pointermove", (e) => {
  if (press === null) return;
  const dx = e.clientX - press.x, dy = e.clientY - press.y;
  if (!press.moved && Math.hypot(dx, dy) < 4) return;
  press.moved = true;
  clearTimeout(holdTimer);
  if (anim) { cancelAnimationFrame(anim); anim = 0; }
  ox += dx; oy += dy;
  press.x = e.clientX; press.y = e.clientY;
  cv.style.cursor = "grabbing";
  draw();
});

cv.addEventListener("pointerup", (e) => {
  clearTimeout(holdTimer);
  const p = press;
  press = null;
  cv.style.cursor = "";
  try { cv.releasePointerCapture(e.pointerId); } catch { /* deja relache */ }
  if (p === null || p.moved || p.button === 1) return;

  const r = cv.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left - ox) / cell);
  const y = Math.floor((e.clientY - r.top - oy) / cell);
  marks = [];
  if (cursor !== null && cursor.x === x && cursor.y === y) {
    // Recliquer la meme case fait pivoter le sens -- mais pas au milieu d'un mot.
    if (typed.length === 0) cursor = { x, y, dir: cursor.dir === "H" ? "V" : "H" };
  } else {
    cursor = { x, y, dir: p.button === 2 ? "V" : "H" };
    typed = "";
  }
  paintRack(); paintCurrent(); draw();
});
cv.addEventListener("pointercancel", () => { press = null; clearTimeout(holdTimer); cv.style.cursor = ""; });

addEventListener("keydown", (e) => {
  if (!$("join").hidden) return;
  if (document.activeElement === $("chat-text")) return;
  if (!$("roadmap").hidden && e.key === "Escape") { $("roadmap").hidden = true; return; }
  if (ghost !== null && e.key === "Escape") { ghost = null; draw(); return; }

  if (e.key === "Escape") { typed = ""; paintRack(); paintCurrent(); draw(); return; }
  if (e.key === " " || e.code === "Space") {
    // Pivoter en cours de mot retournerait tout ce qui est deja pose.
    if (cursor !== null && typed.length === 0) {
      cursor = { ...cursor, dir: cursor.dir === "H" ? "V" : "H" };
      draw();
    }
    e.preventDefault();
    return;
  }
  if (e.key === "Backspace") { typed = typed.slice(0, -1); paintRack(); paintCurrent(); draw(); e.preventDefault(); return; }
  if (e.key === "Enter") { submit(); e.preventDefault(); return; }
  if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
    if (cursor === null || finie) return;
    if (typed.length >= 15) return;
    const ch = e.key.toUpperCase();
    const left = remaining();
    // Lettre absente du tirage : il ne se passe simplement rien.
    if (!left.includes(ch) && !left.includes(BLANK)) return;
    typed += ch;
    paintRack(); paintCurrent(); draw();
    return;
  }
  const d = 60;
  if (e.key === "ArrowLeft") { ox += d; draw(); }
  if (e.key === "ArrowRight") { ox -= d; draw(); }
  if (e.key === "ArrowUp") { oy += d; draw(); }
  if (e.key === "ArrowDown") { oy -= d; draw(); }
});

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (anim) { cancelAnimationFrame(anim); anim = 0; }
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const next = Math.max(12, Math.min(56, cell * Math.exp(-e.deltaY * .0016)));
  ox = mx - (mx - ox) * (next / cell);
  oy = my - (my - oy) * (next / cell);
  cell = next;
  draw();
}, { passive: false });

function submit() {
  if (cursor === null || typed.length === 0) return;
  if (finie) { flash("la partie est terminée", "bad"); return; }
  if (solving) { flash("le coup n'est pas encore prêt", "bad"); return; }
  const r = resolveTypedWord(board, dict, cursor.dir, cursor.x, cursor.y, typed, rack);
  if (!r.ok) {
    flash(PLAY_MESSAGE[r.error], "bad");
    typed = ""; paintRack(); paintCurrent(); draw();
    return;
  }
  if (best === null || r.move.score > best.score) {
    best = { word: r.move.word, score: r.move.score, dir: r.move.dir, x: r.move.x, y: r.move.y };
  }
  ws?.send(JSON.stringify({ t: "try", dir: cursor.dir, x: cursor.x, y: cursor.y, typed }));
  typed = ""; paintRack(); paintSide(); draw();
}

$("reveal").addEventListener("click", () => ws?.send(JSON.stringify({ t: "reveal" })));

// ---------------------------------------------------------------- chronos

/** Instant du dernier coup d'une partie terminee : l'age se fige dessus. */
let finieA = 0;

setInterval(() => {
  const now = Date.now() + clockSkew;
  if (finie) {
    // Partie close : l'age s'arrete au dernier coup, et il n'y a plus de coup
    // en cours dont on pourrait chronometrer la recherche.
    $("age").textContent = fmtTime((finieA || servedAt) - createdAt);
    $("elapsed").textContent = "—";
    return;
  }
  $("age").textContent = fmtTime(now - createdAt);
  $("elapsed").textContent = solving ? "…" : fmtTime(now - servedAt);
}, 200);

// ---------------------------------------------------------------- reseau

function applyState(s: {
  rack?: string; moveNumber: number; cumul: number; solving: boolean;
  players?: Record<string, number>; online?: string[]; last?: MoveInfo | null;
  likes?: Record<string, number>; sac?: string; finie?: boolean;
  createdAt: number; now: number; servedAt: number;
}) {
  rack = s.rack ?? "";
  moveNumber = s.moveNumber;
  cumul = s.cumul;
  solving = s.solving;
  players = s.players ?? {};
  likes = s.likes ?? {};
  // Les lettres qui restent dans le sac. Rien a montrer sur une pioche
  // ponderee : elle ne s'epuise pas, il n'y a pas de reste.
  const sac = s.sac ?? "";
  $("sac").hidden = sac === "";
  if (sac !== "") $("sac").textContent = sac;
  if (s.finie === true && !finie) finieA = s.servedAt;
  finie = s.finie === true;
  online = s.online ?? [];
  last = s.last ?? null;
  createdAt = s.createdAt;
  servedAt = s.servedAt;
  clockSkew = s.now - Date.now();
  paintRack();
  paintSide();
  draw();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener("open", () => {
    $("dot").classList.add("on");
    $("conn").textContent = me;
    ws!.send(JSON.stringify({ t: "join", name: me, salon: salonChoisi }));
  });
  ws.addEventListener("close", () => {
    $("dot").classList.remove("on");
    $("conn").textContent = "déconnecté — reconnexion…";
    setTimeout(connect, 1500);
  });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data as string);

    if (m.t === "hello") {
      setLayout(m.layout as LayoutName);
      canReveal = m.reveal === true;
      tiles = m.tiles;
      history = m.moves;
      chat = m.chat ?? [];
      // La variante vient du serveur : c'est elle qui dit combien de caramels se
      // posent, ce que vaut chaque lettre et quelle prime recompense quoi.
      cfg = m.config ? deserialiser(m.config) : configParDefaut();
      board = new Board(dict, cfg);
      // Seul le proprietaire regle son salon. La grille permanente n'en a pas.
      $("reglages-open").hidden = m.proprietaire !== me;
      $("conn").textContent = `${me} · ${m.nomSalon}`;
      board.place(tiles.map((t: Tile): Placement => ({ x: t.x, y: t.y, letter: t.l, blank: t.b === 1 })));
      paintChat(chat);
      applyState(m.state);
      if (tiles.length > 0 && last !== null) flyTo(last.word, last.dir, last.x, last.y);
      return;
    }
    if (m.t === "refus") {
      ws?.close();
      ws = null;
      $("join").hidden = false;
      void peuplerSalons();
      $("join-error").textContent = m.message;
      $("join-error").hidden = false;
      ($("name") as HTMLInputElement).select();
      return;
    }
    if (m.t === "relance") {
      cfg = m.config ? deserialiser(m.config) : cfg;
      tiles = m.tiles ?? [];
      history = [];
      chat = m.chat ?? [];
      board = new Board(dict, cfg);
      board.place(tiles.map((t: Tile): Placement => ({ x: t.x, y: t.y, letter: t.l, blank: t.b === 1 })));
      typed = ""; ghost = null; best = null; finie = false; finieA = 0;
      paintChat(chat);
      applyState(m.state);
      ox = W / 2 - cell / 2;
      oy = H / 2 - cell / 2;
      flash("nouvelle partie dans ce salon", "ok");
      draw();
      return;
    }
    if (m.t === "state") { applyState(m.state); return; }
    // Un "j'aime" est arrive : on met a jour le coup concerne, partout.
    if (m.t === "likes") {
      const upd = (q: MoveInfo | null) => {
        if (q === null || q.n !== m.n) return;
        q.likers = m.likers; q.likes = m.likers.length;
      };
      for (const q of history) upd(q);
      upd(last);
      paintSide();
      if (!$("roadmap").hidden) paintRoadmap();
      return;
    }
    if (m.t === "said") { chat.push(m.msg); paintChat(chat); return; }

    if (m.t === "placed") {
      const mv = m.move as MoveInfo;
      board.place(m.placements as Placement[]);
      for (const p of m.placements as Placement[]) {
        tiles.push({ x: p.x, y: p.y, l: p.letter, b: p.blank ? 1 : 0, n: mv.n });
      }
      history.push(mv);
      best = null;
      typed = "";
      ghost = null;
      applyState(m.state);
      if (!$("roadmap").hidden) paintRoadmap();

      // La camera NE BOUGE PAS. Se faire deplacer sans l'avoir demande, en
      // pleine recherche, donne le mal de mer : c'est au joueur de cliquer le
      // coup s'il veut aller le voir.
      draw();
      flash(
        mv.player === me ? `Top ! ${mv.word} — ${mv.score} pts`
        : `${mv.player ?? "Révélé"} : ${mv.word} — ${mv.score} pts`,
        mv.player === me ? "top" : "ok",
      );
      return;
    }

    if (m.t === "result" && !m.ok) flash(m.message, "bad");
  });
}

// ---------------------------------------------------------------- amorçage

// ---------------------------------------------------------------- accueil

/** Le salon qu'on rejoint. Vient de l'adresse, ou du salon clique. */
let salonChoisi = new URLSearchParams(location.search).get("salon") ?? "";

interface ResumeSalon {
  id: string; nom: string; proprietaire: string | null; mondiale: boolean;
  coups: number; finie: boolean; connectes: number;
  config: { tirage: number; jouables: number; pioche: string; bornes: number | null };
}

function nomPioche(p: string): string {
  return p === "sac102" ? "sac de 102" : p === "sac102boucle" ? "sac de 102 sans fin"
    : "probabilités pondérées";
}

function decritVariante(c: ResumeSalon["config"]): string {
  const grille = c.bornes === null ? "grille infinie" : `${c.bornes * 2 + 1}×${c.bornes * 2 + 1}`;
  return `${grille} · ${c.jouables} sur ${c.tirage} · ${nomPioche(c.pioche)}`;
}

/** Deux icones : la grille sans bord, et le plateau ferme. */
function icone(infinie: boolean): string {
  return infinie
    ? `<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2">
         <path d="M1 5.5h14M1 10.5h14M5.5 1v14M10.5 1v14" stroke-dasharray="2 1.6"/>
       </svg>`
    : `<svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2">
         <rect x="1.6" y="1.6" width="12.8" height="12.8" rx="1"/>
         <path d="M1.6 6h12.8M1.6 10h12.8M6 1.6v12.8M10 1.6v12.8"/>
       </svg>`;
}

async function peuplerSalons(): Promise<void> {
  const box = $("salons");
  let data: { salons: ResumeSalon[] };
  try {
    data = await (await fetch("/api/salons")).json();
  } catch {
    box.replaceChildren();
    const e = document.createElement("div");
    e.className = "none"; e.textContent = "serveur injoignable";
    box.appendChild(e);
    return;
  }
  box.replaceChildren();
  const moi = ($("name") as HTMLInputElement).value.trim();
  for (const s of data.salons) {
    const b = document.createElement("div");
    b.className = "salon";
    b.setAttribute("role", "button");
    b.tabIndex = 0;
    const qui = s.mondiale ? '<span class="mondiale">permanent</span>' : `par ${s.proprietaire}`;
    const etat = s.finie ? "terminée" : `${s.coups} coup${s.coups > 1 ? "s" : ""}`;
    b.innerHTML =
      `<span class="icone">${icone(s.config.bornes === null)}</span>` +
      `<span class="nom">${s.nom}</span>` +
      `<span class="qui">${qui}<br>${s.connectes} connecté${s.connectes > 1 ? "s" : ""}</span>` +
      `<span class="quoi">${decritVariante(s.config)} · ${etat}</span>`;
    b.addEventListener("click", () => rejoindre(s.id));
    b.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") rejoindre(s.id);
    });
    // Le createur peut retirer son salon. Ses fichiers restent sur le disque.
    if (!s.mondiale && s.proprietaire === moi && moi !== "") {
      const jeter = document.createElement("button");
      jeter.type = "button";
      jeter.className = "jeter";
      jeter.textContent = "Supprimer";
      jeter.title = "Retire le salon de la liste. La partie jouée reste sur le disque.";
      jeter.addEventListener("click", async (e) => {
        e.stopPropagation();
        const r = await fetch(`/api/salon/${encodeURIComponent(s.id)}`, {
          method: "DELETE", headers: { "x-pseudo": moi },
        });
        if (!r.ok) {
          const d = await r.json();
          $("join-error").textContent = d.erreur ?? "suppression impossible";
          $("join-error").hidden = false;
        }
        void peuplerSalons();
      });
      b.appendChild(jeter);
    }
    box.appendChild(b);
  }
  if (data.salons.length === 0) {
    const e = document.createElement("div");
    e.className = "none"; e.textContent = "aucun salon ouvert";
    box.appendChild(e);
  }
}

/** Les reglages en cours d'edition dans le salon. */
let cTirage = 7, cJouables = 7, cPioche = "probabilites";

function peuplerNombres(): void {
  for (const [id, get] of [["r-tirage", () => cTirage], ["r-jouables", () => cJouables]] as const) {
    const box = $(id);
    box.replaceChildren();
    for (let n = 2; n <= 15; n++) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = String(n);
      b.dataset["n"] = String(n);
      b.setAttribute("aria-pressed", String(get() === n));
      // On ne peut pas poser plus de caramels qu'on n'en pioche.
      if (id === "r-jouables") (b as HTMLButtonElement).disabled = n > cTirage;
      b.addEventListener("click", () => {
        if (id === "r-tirage") {
          cTirage = n;
          if (cJouables > n) cJouables = n;
        } else cJouables = n;
        peuplerNombres();
      });
      box.appendChild(b);
    }
  }
}

for (const b of $("r-pioche").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    cPioche = (b as HTMLElement).dataset["v"] ?? "probabilites";
    peuplerPioche();
  });
}

/**
 * Les trois tirages possibles. Le sac sans fin n'a de sens que sur une grille
 * infinie : sur un plateau ferme la partie s'arrete avant qu'il ne se recharge.
 */
function peuplerPioche(): void {
  for (const b of $("r-pioche").querySelectorAll("button")) {
    const v = (b as HTMLElement).dataset["v"]!;
    b.setAttribute("aria-pressed", String(v === cPioche));
    const interdit = v === "sac102boucle" && cfg.bornes !== null;
    (b as HTMLButtonElement).disabled = interdit;
    (b as HTMLButtonElement).title = interdit
      ? "réservé aux grilles infinies" : "";
  }
}

/** Ouvre les reglages sur l'etat courant de la partie. */
function ouvrirReglages(): void {
  cTirage = cfg.tirage;
  cJouables = cfg.jouables;
  cPioche = cfg.pioche;
  peuplerNombres();
  peuplerPioche();
  $("r-error").hidden = true;
  $("reglages").hidden = false;
}

$("reglages-open").addEventListener("click", ouvrirReglages);
$("rg-close").addEventListener("click", () => { $("reglages").hidden = true; });

$("r-appliquer").addEventListener("click", () => {
  ws?.send(JSON.stringify({
    t: "relancer", tirage: cTirage, jouables: cJouables, pioche: cPioche,
  }));
  $("reglages").hidden = true;
});

// Quitter le salon sans le detruire : on revient a l'accueil, la partie continue.
$("quitter").addEventListener("click", () => {
  ws?.close();
  ws = null;
  $("dot").classList.remove("on");
  $("reglages").hidden = true;
  $("roadmap").hidden = true;
  $("join").hidden = false;
  void peuplerSalons();
});

$("creer-open").addEventListener("click", () => {
  const ouvert = $("creer").hidden;
  $("creer").hidden = !ouvert;
  $("creer-open").textContent = ouvert ? "Annuler" : "Créer un salon";
});

// Le pseudo commande l'affichage des boutons Supprimer : on rafraichit la liste
// des qu'il change, sinon le createur ne verrait pas ses propres salons.
$("name").addEventListener("input", () => void peuplerSalons());

$("creer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pseudo = ($("name") as HTMLInputElement).value.trim();
  if (pseudo === "") {
    $("c-error").textContent = "Entrez d'abord votre pseudo";
    $("c-error").hidden = false;
    ($("name") as HTMLInputElement).focus();
    return;
  }
  $("c-error").hidden = true;
  const r = await fetch("/api/salons", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nom: ($("c-nom") as HTMLInputElement).value.trim() || "Salon",
      proprietaire: pseudo,
      infinie: ($("c-infinie") as HTMLInputElement).checked,
      prive: ($("c-prive") as HTMLInputElement).checked,
    }),
  });
  const s = await r.json();
  if (!r.ok) {
    $("c-error").textContent = s.erreur ?? "création impossible";
    $("c-error").hidden = false;
    return;
  }
  rejoindre(s.id);
});

$("joinform").addEventListener("submit", (e) => {
  e.preventDefault();
  rejoindre(salonChoisi || "");
});

/** Quitte l'accueil et entre dans un salon. */
async function rejoindre(id: string): Promise<void> {
  const pseudo = ($("name") as HTMLInputElement).value.trim();
  if (pseudo === "") {
    $("join-error").textContent = "Entrez votre pseudo pour rejoindre";
    $("join-error").hidden = false;
    ($("name") as HTMLInputElement).focus();
    return;
  }
  me = pseudo;
  salonChoisi = id;
  try { localStorage.setItem("pseudo", me); } catch { /* navigation privee */ }
  $("join-error").hidden = true;
  $("join").hidden = true;

  if (!dictCharge) {
    const bytes = await (await fetch("/dawg.bin")).arrayBuffer();
    dict = Dict.fromBytes(bytes);
    dictCharge = true;
    new ResizeObserver(resize).observe(cv);
  }
  board = new Board(dict);
  resize();
  ox = W / 2 - cell / 2;
  oy = H / 2 - cell / 2;
  connect();
}

void peuplerSalons();

try {
  const saved = localStorage.getItem("pseudo");
  if (saved) ($("name") as HTMLInputElement).value = saved;
} catch { /* navigation privee : sans importance */ }

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());
