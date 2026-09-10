/**
 * Les classements de records : l'ordre, les ex aequo, les filtres, les mots.
 * Voir SPEC.md §23.
 *
 *     node packages/server/test/check_classements.ts
 *
 * Jouer cinquante parties pour eprouver un tri prendrait un quart d'heure et
 * n'apprendrait rien de plus : ce qui se verifie ici, c'est le classement, pas
 * le moteur. Les manches sont donc ECRITES AU JOURNAL puis relues par le vrai
 * chemin de lecture -- ce n'est pas un faux, c'est le format d'echange du
 * module, et une ligne mal formee se verrait ici comme en production.
 *
 * LE JOURNAL DES RECORDS EXISTANT EST MIS DE COTE puis rendu.
 */
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annexe, classementAuNegatif, classementDeVitesse, compteurWuQi, coupsExtremes,
  invaliderLaManche, motsRates, motsTrouves, ouvrirLesRecords, refDeLaGraine, tableau,
  type CoupObserve, type Manche,
} from "../src/records.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const JOURNAL = join(D, "records.journal.jsonl");
const DE_COTE = join(D, "records.essai-classements.jsonl");

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(54)} ${detail}`);
  if (!ok) echecs++;
}

/** Un coup vu, avec ce qu'il faut et rien de plus. */
function coup(
  n: number, mots: string[], par: string | null,
  opts: { actif?: boolean; score?: number; poses?: number; negatif?: number } = {},
): CoupObserve {
  return {
    n, mots, score: opts.score ?? 30, ms: 1000, par,
    actif: opts.actif ?? true, poses: opts.poses ?? 4,
    negatif: par === null ? (opts.negatif ?? 30) : 0,
  };
}

interface Esquisse {
  partie: string;
  temps: number;
  categorie?: string;
  grille?: "normale" | "super";
  lexique?: string;
  chrono?: number | null;
  cumul?: number;
  farfouilles?: number;
  joueurs?: string[];
  vus?: CoupObserve[];
  at?: number;
}

let horloge = 1_800_000_000_000;

function manche(e: Esquisse): Manche {
  const vus = e.vus ?? [coup(1, ["MOT"], e.joueurs?.[0] ?? "alice")];
  const tops = new Map<string, number>();
  for (const c of vus) if (c.par !== null) tops.set(c.par, (tops.get(c.par) ?? 0) + 1);
  const topee = vus.every((c) => c.par !== null);
  const chers = [...vus].sort((a, b) => b.score - a.score);
  const graine = `graine-de-${e.partie}`;
  return {
    // La reference est celle que la relecture recalculerait : ces manches
    // passent par le journal, comme les vraies.
    ref: refDeLaGraine(graine),
    partie: e.partie,
    graine,
    at: e.at ?? horloge++,
    categorie: e.categorie ?? "normale",
    grille: e.grille ?? "normale",
    lexique: e.lexique ?? "ods9",
    empreinte: "aaaaaaaa",
    chrono: e.chrono === undefined ? 60 : e.chrono,
    coups: vus.length,
    temps: e.temps,
    cumul: e.cumul ?? 800,
    farfouilles: e.farfouilles ?? 1,
    topee,
    negatif: vus.reduce((a, c) => a + c.negatif, 0),
    joueurs: [...tops].sort((a, b) => b[1] - a[1])
      .map(([nom, t]) => ({ nom, tops: t, invite: true })),
    solo: topee && tops.size === 1 ? [...tops.keys()][0]! : null,
    coupCher: note(chers[0]),
    coupPasCher: note(chers[chers.length - 1]),
  };
}

const note = (c: CoupObserve | undefined): { mot: string; score: number; par: string | null } | null =>
  c === undefined ? null : { mot: c.mots[0] ?? "", score: c.score, par: c.par };

/** Ecrit ces manches au journal et les relit par le vrai chemin. */
function poser(...m: Manche[]): void {
  writeFileSync(JOURNAL,
    m.map((x) => JSON.stringify({ t: "manche", ...x })).join("\n") + "\n", "utf8");
  ouvrirLesRecords();
}

/**
 * Ecrit des lots de mots au journal, et les relit.
 *
 * C'EST CE QUE LE JOURNAL PORTE DESORMAIS pour les mots : un lot par partie,
 * et non plus le detail de ses coups. Une partie abandonnee n'ecrit que cela.
 */
function poserDesMots(...lots: { lexique?: string; trouves?: string[]; rates?: string[] }[]): void {
  writeFileSync(JOURNAL, lots.map((l) => JSON.stringify({
    t: "mots", lexique: l.lexique ?? "ods9", at: horloge++,
    trouves: l.trouves ?? [], rates: l.rates ?? [],
  })).join("\n") + "\n", "utf8");
  ouvrirLesRecords();
}

// ------------------------------------ le journal existant est mis de cote
if (existsSync(JOURNAL)) renameSync(JOURNAL, DE_COTE);
function rendreLeJournal(): void {
  if (existsSync(JOURNAL)) rmSync(JOURNAL);
  if (existsSync(DE_COTE)) renameSync(DE_COTE, JOURNAL);
}
process.on("exit", rendreLeJournal);

console.log("\nLes classements de records\n");

// ------------------------------------------------------- l'ordre et les rangs
console.log("  --- l'ordre et les ex aequo ---\n");
{
  poser(
    manche({ partie: "b", temps: 12_340 }),
    manche({ partie: "c", temps: 13_500 }),
    // 12 344 ms et 12 340 ms tombent sur le meme centieme : ex aequo.
    manche({ partie: "a", temps: 12_344 }),
    manche({ partie: "d", temps: 9_000 }),
  );
  const cl = classementDeVitesse({ categorie: "normale" });
  verifie("les quatre manches sont classees", cl.length === 4, `${cl.length}`);
  verifie("la plus rapide est en tete", cl[0]?.partie === "d", cl[0]?.partie ?? "aucune");
  verifie("les rangs suivent 1, 2, 2, 4",
    cl.map((l) => l.rang).join(",") === "1,2,2,4", cl.map((l) => l.rang).join(","));
  verifie("les deux temps au meme centieme sont ex aequo",
    cl[1]?.rang === cl[2]?.rang, `${cl[1]?.partie} et ${cl[2]?.partie}`);
  verifie("a temps egal, la plus ancienne passe devant",
    cl[1]?.partie === "b" && cl[2]?.partie === "a",
    `${cl[1]?.partie} puis ${cl[2]?.partie}`);
  verifie("un centieme d'ecart separe", cl[3]?.rang === 4, `rang ${cl[3]?.rang}`);
}

// -------------------------------------------------- ce qui ne sort pas
console.log("\n  --- ce qui ne sort pas vers les clients ---\n");
{
  const l = classementDeVitesse({ categorie: "normale" })[0] as unknown as Record<string, unknown>;
  verifie("la graine ne sort pas", !("graine" in l));
  verifie("le detail des coups ne sort pas", !("vus" in l));
  verifie("mais le nom de la partie sort, pour le rejeu", typeof l["partie"] === "string");
}

// ------------------------------------------- topees, negatifs, et le partage
console.log("\n  --- topees et negatifs ---\n");
{
  poser(
    manche({ partie: "topee", temps: 20_000, vus: [coup(1, ["UN"], "alice")] }),
    manche({ partie: "ratee", temps: 10_000,
      vus: [coup(1, ["UN"], "alice"), coup(2, ["DEUX"], null, { negatif: 40 })] }),
    manche({ partie: "pire", temps: 5_000,
      vus: [coup(1, ["UN"], null, { negatif: 90 })] }),
  );
  const vitesse = classementDeVitesse({ categorie: "normale" });
  verifie("seule la partie topee est au classement de vitesse",
    vitesse.length === 1 && vitesse[0]?.partie === "topee",
    vitesse.map((l) => l.partie).join(","));
  const negatifs = classementAuNegatif({ categorie: "normale" });
  verifie("les deux autres sont au negatif", negatifs.length === 2, `${negatifs.length}`);
  verifie("le plus petit negatif en tete",
    negatifs[0]?.partie === "ratee", `${negatifs[0]?.partie} (${negatifs[0]?.negatif})`);
  // LE BLOC DES NEGATIFS NE COMPLETE QUE LES GRANDS FORMATS. A dix caramels et
  // plus, une partie topee est rare et un tableau de trois lignes n'apprend
  // rien ; en dessous, il s'en trouve, et melanger les deux ferait passer pour
  // un record une partie ou l'on a rate un top.
  const normal = tableau({ categorie: "normale" });
  verifie("un format normal ne montre pas les negatifs",
    normal.topees.length === 1 && normal.negatifs.length === 0,
    `${normal.negatifs.length} négatif(s)`);
}

// ------------------------------------- le grand format complete au negatif
console.log("\n  --- les grands formats ---\n");
{
  poser(
    manche({ partie: "grande-topee", categorie: "12-12", temps: 800_000,
      vus: [coup(1, ["UN"], "alice")] }),
    manche({ partie: "grande-ratee", categorie: "12-12", temps: 700_000,
      vus: [coup(1, ["UN"], null, { negatif: 95 })] }),
    manche({ partie: "petite-ratee", categorie: "3-3", temps: 90_000,
      vus: [coup(1, ["UN"], null, { negatif: 12 })] }),
  );
  const grand = tableau({ categorie: "12-12" });
  verifie("un grand format porte les deux blocs",
    grand.topees.length === 1 && grand.negatifs.length === 1,
    `${grand.topees.length} topée(s), ${grand.negatifs.length} négatif(s)`);
  const petit = tableau({ categorie: "3-3" });
  verifie("un petit format n'en porte qu'un",
    petit.topees.length === 0 && petit.negatifs.length === 0);
}

// ------------------------------------------------ le temps par coup
console.log("\n  --- classer par temps par coup ---\n");
{
  poser(
    // Vingt coups en cent secondes : cinq secondes par coup, et la plus lente
    // des deux au total.
    manche({ partie: "lente-mais-reguliere", temps: 100_000,
      vus: Array.from({ length: 20 }, (_, i) => coup(i + 1, [`M${i}`], "alice")) }),
    // Cinq coups en cinquante secondes : dix secondes par coup, et la plus
    // rapide des deux au total.
    manche({ partie: "courte-mais-lente", temps: 50_000,
      vus: Array.from({ length: 5 }, (_, i) => coup(i + 1, [`N${i}`], "alice")) }),
  );
  const parTemps = classementDeVitesse({ categorie: "normale" });
  verifie("au temps total, la partie courte mene",
    parTemps[0]?.partie === "courte-mais-lente", parTemps[0]?.partie ?? "aucune");
  // « Temps par coup » est une CATEGORIE, pas un tri : elle a son propre onglet
  // et son propre podium, et lit les manches de la partie normale autrement.
  const parCoup = classementDeVitesse({ categorie: "temps-par-coup" });
  verifie("la categorie du temps par coup renverse l'ordre",
    parCoup[0]?.partie === "lente-mais-reguliere", parCoup[0]?.partie ?? "aucune");
  verifie("et elle lit bien les memes manches", parCoup.length === 2, `${parCoup.length}`);
}

// ------------------------------------------------------------- les filtres
console.log("\n  --- les filtres ---\n");
{
  poser(
    manche({ partie: "solo", temps: 10_000,
      vus: [coup(1, ["UN"], "alice"), coup(2, ["DEUX"], "alice")] }),
    manche({ partie: "duo", temps: 8_000,
      vus: [coup(1, ["UN"], "alice"), coup(2, ["DEUX"], "bob")] }),
    manche({ partie: "super", temps: 9_000, grille: "super" }),
    manche({ partie: "anglaise", temps: 7_000, lexique: "csw24" }),
    manche({ partie: "joker", temps: 6_000, categorie: "joker" }),
  );
  verifie("la categorie filtre",
    classementDeVitesse({ categorie: "joker" }).length === 1);
  verifie("la grille filtre",
    classementDeVitesse({ categorie: "normale", grille: "normale" })
      .every((l) => l.partie !== "super"));
  verifie("le lexique filtre",
    classementDeVitesse({ categorie: "normale", lexique: "ods9" })
      .every((l) => l.partie !== "anglaise"));
  const solos = classementDeVitesse({ categorie: "normale", solo: true });
  verifie("la case solo ne garde que les manches d'un seul trouveur",
    solos.every((l) => l.solo !== null) && solos.some((l) => l.partie === "solo")
    && solos.every((l) => l.partie !== "duo"),
    solos.map((l) => l.partie).join(","));
  const onglet = classementDeVitesse({ categorie: "normale-solo" });
  verifie("l'onglet « Partie normale solo » donne la meme chose",
    onglet.map((l) => l.partie).join(",") === solos.map((l) => l.partie).join(","),
    onglet.map((l) => l.partie).join(","));
}

// -------------------------------------------------------- les annexes
console.log("\n  --- les tableaux annexes ---\n");
{
  poser(
    manche({ partie: "serree", temps: 30_000, chrono: 15, cumul: 700, farfouilles: 0,
      vus: [coup(1, ["UN"], "alice")] }),
    manche({ partie: "large", temps: 20_000, chrono: 180, cumul: 980, farfouilles: 3,
      vus: [coup(1, ["UN"], "alice"), coup(2, ["DEUX"], "alice")] }),
    manche({ partie: "infinie", temps: 10_000, chrono: null, cumul: 900, farfouilles: 1,
      vus: [coup(1, ["UN"], "alice")] }),
    manche({ partie: "ratee", temps: 1_000, chrono: 15, cumul: 9_999, farfouilles: 9,
      vus: [coup(1, ["UN"], null)] }),
  );
  const chrono = annexe("chrono", { categorie: "normale" });
  verifie("le chrono le plus serre en tete",
    chrono[0]?.partie === "serree", chrono[0]?.partie ?? "aucune");
  verifie("un chrono infini ne concourt pas",
    chrono.every((l) => l.partie !== "infinie"), chrono.map((l) => l.partie).join(","));
  verifie("une partie non topee ne concourt a aucun annexe",
    annexe("chere", { categorie: "normale" }).every((l) => l.partie !== "ratee"));
  verifie("la plus chere est la plus chere",
    annexe("chere", { categorie: "normale" })[0]?.partie === "large");
  verifie("la moins chere aussi",
    annexe("pasChere", { categorie: "normale" })[0]?.partie === "serree");
  verifie("la plus longue en coups",
    annexe("longue", { categorie: "normale" })[0]?.partie === "large");
  verifie("le plus de farfouilles",
    annexe("farfouilles", { categorie: "normale" })[0]?.partie === "large");

  const chers = coupsExtremes({ categorie: "normale" }, "cher");
  verifie("les coups extremes ignorent les parties non topees",
    chers.every((c) => c.partie !== "ratee"), `${chers.length} coup(s)`);
}

// ------------------------------------------------------------- les mots
console.log("\n  --- les mots rates ---\n");
{
  poserDesMots(
    // Un coup rate a deux isotops : les deux sont rates, a egalite.
    { rates: ["PLUTOT", "POULET"] },
    { rates: ["PLUTOT", "POULET"], trouves: ["AUNERA"] },
    // AUNERA rate une fois : il sort des trouves, meme trouve par ailleurs.
    { rates: ["AUNERA"] },
    // CONNU trouve deux fois et jamais rate.
    { trouves: ["CONNU", "CONNU"] },
    { lexique: "csw24", rates: ["PLUTOT"] },
  );
  const rates = motsRates("ods9");
  const par = new Map(rates.map((l) => [l.mot, l]));
  verifie("le mot le plus rate est en tete",
    rates[0]?.rates === 2, `${rates[0]?.mot} raté ${rates[0]?.rates} fois`);
  verifie("les deux isotops sont rates a egalite",
    par.get("PLUTOT")?.rates === 2 && par.get("POULET")?.rates === 2
    && par.get("PLUTOT")?.rang === par.get("POULET")?.rang,
    `PLUTOT rang ${par.get("PLUTOT")?.rang}, POULET rang ${par.get("POULET")?.rang}`);
  verifie("un mot trouve une fois sur deux affiche 50 %",
    par.get("AUNERA")?.fois === 2 && par.get("AUNERA")?.trouves === 1
    && par.get("AUNERA")?.part === 50, `${par.get("AUNERA")?.part} %`);
  verifie("un mot jamais rate ne figure pas dans les rates",
    !par.has("CONNU"), par.has("CONNU") ? "CONNU y est" : "CONNU n'y est pas");
  verifie("le lexique anglais ne se melange pas au francais",
    par.get("PLUTOT")?.fois === 2, `${par.get("PLUTOT")?.fois} fois en ods9`);
  verifie("et il a son propre tableau",
    motsRates("csw24").find((l) => l.mot === "PLUTOT")?.fois === 1);
  verifie("les mots par longueur se filtrent",
    motsRates("ods9", 6).every((l) => l.mot.length === 6)
    && motsRates("ods9", 6).length === 3,
    motsRates("ods9", 6).map((l) => l.mot).join(","));
  // LES DEUX TABLEAUX S'EXCLUENT.
  const trouves = motsTrouves("ods9");
  const nomsTrouves = trouves.map((l) => l.mot);
  verifie("les mots jamais rates sont les seuls a figurer dans les trouves",
    trouves.every((l) => l.rates === 0), nomsTrouves.join(","));
  verifie("un mot rate une fois sort des trouves",
    !nomsTrouves.includes("AUNERA") && !nomsTrouves.includes("PLUTOT"),
    nomsTrouves.join(","));
  verifie("et le mot jamais rate y est, lui",
    nomsTrouves.includes("CONNU"), nomsTrouves.join(","));
  verifie("et les rates ne portent que des mots vraiment rates",
    motsRates("ods9").every((l) => l.rates > 0));
}

// ------------------------------------- la partie abandonnee laisse ses mots
console.log("\n  --- une partie abandonnee ---\n");
{
  // Une table qui rate un top relance aussitot : sans ce lot, le mot rate --
  // celui-la meme qui fait abandonner -- ne serait compte nulle part. Elle ne
  // laisse RIEN d'autre : pas de quoi reconstituer la partie.
  poserDesMots({ rates: ["QUARTZEUX"] });
  verifie("elle n'entre dans aucun classement",
    classementDeVitesse({ categorie: "normale" }).length === 0);
  const rates = motsRates("ods9");
  verifie("mais son coup rate compte dans les mots",
    rates.length === 1 && rates[0]?.mot === "QUARTZEUX" && rates[0]?.rates === 1,
    rates.map((l) => l.mot).join(","));
}

// --------------------------------------------------------- WU et QI
console.log("\n  --- WU et QI ---\n");
{
  poserDesMots(
    { trouves: ["QI"], rates: ["QI"] },
    // Ni WUS ni QIS : ce sont d'autres mots, et le compteur ne les connait pas.
    { trouves: ["WU", "QIS"] },
  );
  const compte = new Map(compteurWuQi("ods9").map((l) => [l.mot, l]));
  verifie("QI est sorti deux fois et trouve une",
    compte.get("QI")?.sorti === 2 && compte.get("QI")?.trouve === 1,
    `sorti ${compte.get("QI")?.sorti}, trouvé ${compte.get("QI")?.trouve}`);
  verifie("WU une fois, trouve une fois",
    compte.get("WU")?.sorti === 1 && compte.get("WU")?.trouve === 1,
    `sorti ${compte.get("WU")?.sorti}, trouvé ${compte.get("WU")?.trouve}`);
  verifie("QIS ne compte pas pour QI", compte.get("QI")?.sorti === 2);
}

// ------------------------------------------------------- l'invalidation
console.log("\n  --- une manche invalidee ---\n");
{
  poser(
    manche({ partie: "propre", temps: 20_000, vus: [coup(1, ["UN"], "alice")] }),
    manche({ partie: "suspecte", temps: 1_000, vus: [coup(1, ["DEUX"], "alice")] }),
  );
  verifie("la suspecte mene le classement",
    classementDeVitesse({ categorie: "normale" })[0]?.partie === "suspecte");
  // ON INVALIDE PAR LA REFERENCE, pas par le nom du salon : deux parties du
  // meme salon en portent une chacune.
  invaliderLaManche(refDeLaGraine("graine-de-suspecte"), "zulu", "temps invraisemblables");
  const apres = classementDeVitesse({ categorie: "normale" });
  verifie("une fois invalidee, elle disparait du tableau",
    apres.length === 1 && apres[0]?.partie === "propre",
    apres.map((l) => l.partie).join(","));
  // LES MOTS NE SUIVENT PAS L'INVALIDATION. Ils ne viennent plus des manches
  // mais d'un compteur tenu a part, et un mot rate l'a ete quoi qu'on pense de
  // la partie ou il est sorti.
  verifie("les compteurs de mots, eux, ne bougent pas",
    motsRates("ods9").length === 0, "aucun lot de mots dans ce bloc");
}

rendreLeJournal();
console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
