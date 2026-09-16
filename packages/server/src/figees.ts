/**
 * Les parties figees. Voir SPEC.md §29.
 *
 * UNE PARTIE FIGEE EST UNE PARTIE ENTIERE, JOUEE D'AVANCE. On la joue une fois,
 * pour de vrai -- un `Game` ordinaire, sa pioche, son solveur, ses coups
 * d'avance -- en revelant chaque top des qu'il est connu. Ce qui en sort est
 * ecrit une fois pour toutes, et chaque salon qui la sert lit le coup suivant
 * au lieu de le chercher.
 *
 * POURQUOI PAS SIMPLEMENT LA GRAINE. Tout ce que le serveur tire -- lettres,
 * isotop retenu, case d'un joker -- decoule bien de la graine. Mais la graine ne
 * fait qu'alimenter LE CODE DU MOMENT : une regle de tirage retouchee, un
 * departage d'isotops change, et deux manches jouees avant et apres la mise a
 * jour ne jouent plus la meme partie. Un tournoi dure des semaines ; une partie
 * du jour, vingt-quatre heures. Le code, lui, change plusieurs fois par jour.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Game, type CoupFige, type PartieFigee } from "./game.ts";
import { avec, serialiser, type ConfigPartie } from "../../engine/src/config.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Le dossier des parties : c'est la que `Game` ecrit, sans qu'on puisse le lui changer. */
const DATA_DIR = join(here, "..", "data");

/**
 * Joue une partie entiere, en revelant chaque top, et la rend figee.
 *
 * LA PARTIE QUI SERT A FIGER EST MUETTE. Elle ecrirait sinon chaque tirage et
 * chaque top dans le terminal de l'hote, qui ne doit pas connaitre les parties
 * du lendemain. Ses fichiers de travail sont retires par leur nom une fois la
 * partie ecrite -- et seulement ceux-la.
 *
 * Le chrono et le decompte ne changent rien a la suite des coups : on les
 * coupe, pour que rien ne se declenche pendant qu'on revele.
 */
export async function figerUnePartie(
  cfg: ConfigPartie, layout: LayoutName, graine: string = randomUUID(),
  coupsMax: number | null = null,
): Promise<PartieFigee> {
  const id = randomUUID();
  const travail = `figee-${id}`;
  const g = new Game(travail, layout, avec(cfg, { chrono: null, decompte: false }), null,
    { graine, muet: true });
  try {
    await g.start();
    g.presents.add("");
    await g.reveiller();
    await g.demarrer();
    const coups: CoupFige[] = [];
    let immobile = 0;
    // UN DEFI S'ARRETE OU LA PARTIE D'ORIGINE S'EST ARRETEE (SPEC.md §29) : les
    // lignes des joueurs d'origine doivent rester comparables aux autres. C'est
    // aussi ce qui permet de figer une grille sans fin, qui n'en aurait pas.
    while (!g.finie && (coupsMax === null || coups.length < coupsMax)) {
      const avant = g.moves.length;
      // Ce que le sac montre UNE FOIS LE TIRAGE FAIT : c'est ce que le joueur
      // lira au-dessus de la grille pendant ce coup.
      const sac = g.restantDuSac();
      await g.reveal();
      if (g.moves.length === avant) {
        // Le coup n'etait pas pret -- un calcul qui court encore. On attend
        // un peu, et l'on renonce plutot que de tourner sans fin.
        if (++immobile > 400) throw new Error("la partie a figer n'avance plus");
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      immobile = 0;
      const m = g.moves[g.moves.length - 1]!;
      const blancs: number[] = [];
      m.placements.forEach((p, i) => { if (p.blank) blancs.push(i); });
      coups.push({
        n: m.n, rack: m.rack, notation: m.notation,
        word: m.word, dir: m.dir, x: m.x, y: m.y, score: m.score,
        ...(blancs.length > 0 ? { blancs } : {}),
        ...(m.jokers !== undefined ? { jokers: m.jokers } : {}),
        isotops: m.isotops, sac,
      });
    }
    return {
      version: 1, id, layout, config: serialiser(cfg), graine, coups,
      fin: { raison: g.finie ? (g.raisonDeLaFin ?? "sac") : "abandon", sac: g.restantDuSac() },
      creeLe: Date.now(),
    };
  } finally {
    await g.stop();
    for (const suffixe of [".journal.jsonl", ".json", ".secours.json", ".paliers.jsonl", ".verrou"]) {
      const f = join(DATA_DIR, `${travail}${suffixe}`);
      if (existsSync(f)) rmSync(f);
    }
  }
}

/** Le dossier ou elles vivent, sous le dossier de donnees choisi. */
const dossier = (base: string): string => join(base, "figees");

/**
 * Ecrit une partie figee. UNE FOIS : elle ne se reecrit jamais, une epreuve la
 * cite. L'ecriture passe par un fichier temporaire, pour qu'une coupure ne
 * laisse pas une partie a moitie ecrite.
 */
export function ecrireLaPartieFigee(base: string, p: PartieFigee): void {
  mkdirSync(dossier(base), { recursive: true });
  const f = join(dossier(base), `${p.id}.json`);
  if (existsSync(f)) throw new Error(`la partie figee ${p.id} existe deja`);
  writeFileSync(`${f}.tmp`, JSON.stringify(p), "utf8");
  renameSync(`${f}.tmp`, f);
}

const lues = new Map<string, PartieFigee>();

/** Relit une partie figee, ou `null` si elle n'est pas sur le disque. */
export function lireLaPartieFigee(base: string, id: string): PartieFigee | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const deja = lues.get(id);
  if (deja !== undefined) return deja;
  const f = join(dossier(base), `${id}.json`);
  if (!existsSync(f)) return null;
  try {
    const p = JSON.parse(readFileSync(f, "utf8")) as PartieFigee;
    lues.set(id, p);
    return p;
  } catch { return null; }
}
