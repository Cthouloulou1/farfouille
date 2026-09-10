/**
 * La montante d'un salon : ses six etapes, et le prix d'une reprise.
 * Voir SPEC.md §23.
 *
 *     node packages/server/test/check_montante.ts
 *
 * DEUX COMPTES QUI NE SE COMPTENT PAS PAREIL, et c'est tout ce que ce test
 * surveille :
 *
 * - **le temps compte tout**, essais abandonnes compris ;
 * - **le negatif ne compte que ce qui reste.**
 *
 * Si l'un des deux glissait, le bouton de reprise deviendrait gratuit, et le
 * tableau ne classerait plus que la patience.
 *
 * Il eprouve aussi LA FENETRE DU BOUTON, qui est la regle la plus subtile de la
 * montante : elle ne vit QUE l'etape en cours, meme un rate au dernier coup --
 * celui-la coche la pause toute seule plutot que de laisser l'enchainement
 * filer sans donner le choix, et le bouton ne quitte donc jamais l'etape qu'on
 * a sous les yeux.
 *
 * Rien n'est ecrit sur le disque : la montante est un etat en memoire, et ce
 * test ne fait que le faire avancer. Seule la derniere partie ouvre le journal
 * des records, mis de cote puis rendu.
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloreLEtape, etapeReprenable, ilResteUneEtape, mancheDeLaMontante,
  montanteAchevable, montanteFinieDElleMeme, montantePerdue, montantePublique,
  nouvelleMontante, passerALEtapeSuivante, reprendreLEtape, totaux,
  type Montante,
} from "../src/montante.ts";
import { ouvrirLesRecords, type EtapeObservee } from "../src/records.ts";
import { configDeLEtape, ETAPES_MONTANTE, etapeMontante } from "../../engine/src/montante.ts";
import { BORNES_NORMALE } from "../../engine/src/categories.ts";
import { avec, configParDefaut, primesParDefaut } from "../../engine/src/config.ts";
import { setLayout, LAYOUTS } from "../../engine/src/bonus.ts";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const JOURNAL = join(D, "records.journal.jsonl");
const DE_COTE = join(D, "records.essai-montante.jsonl");

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(56)} ${detail}`);
  if (!ok) echecs++;
}

setLayout("classique15");

const CFG = configDeLEtape(avec(configParDefaut(), {
  bornes: BORNES_NORMALE, pavage: LAYOUTS.classique15, pavageNom: "classique15",
  pioche: "sac102", sacs: 1, mode: "topping", chrono: 60,
  coupsMax: null, dureeMax: null, primes: primesParDefaut(),
}), 1);

/**
 * Une etape observee, telle que le journal des records la rend.
 *
 * `rates` compte les coups que personne n'a trouves ; `negatif` est l'ecart au
 * top cumule sur ces coups-la.
 */
let compteur = 0;
function vue(opts: {
  temps: number; rates?: number; negatif?: number; coups?: number;
  dernier?: boolean; valide?: boolean; tops?: Record<string, number>;
  categorie?: string | null;
}): EtapeObservee {
  compteur++;
  const rates = opts.rates ?? 0;
  const coups = opts.coups ?? 20;
  return {
    partie: "essai-montante",
    graine: `graine-${compteur}`,
    ref: `ref-${compteur}`,
    categorie: opts.categorie === undefined ? "normale" : opts.categorie,
    coups,
    temps: opts.temps,
    cumul: 700,
    farfouilles: 1,
    negatif: opts.negatif ?? (rates > 0 ? 30 * rates : 0),
    rates,
    rateAuDernierCoup: opts.dernier ?? false,
    tops: opts.tops ?? { alice: coups - rates },
    joue: true,
    valide: opts.valide ?? true,
    coupCher: { mot: "TOP", score: 90, par: "alice" },
    coupPasCher: { mot: "PEU", score: 12, par: "alice" },
  };
}

/** Joue une etape jusqu'a sa fin, puis passe a la suivante s'il en reste. */
function etapeEntiere(m: Montante, v: EtapeObservee, enchaine = true): void {
  cloreLEtape(m, v);
  if (enchaine && ilResteUneEtape(m)) passerALEtapeSuivante(m);
}

console.log("\nLa montante d'un salon\n");

// ------------------------------------------------------------- le depart
console.log("  --- le depart ---\n");
{
  const m = nouvelleMontante();
  verifie("elle commence a l'etape 1, premier essai",
    m.rang === 1 && m.essai === 1 && !m.close && !m.finie);
  // ETEINTE PAR DEFAUT : une montante s'enchaine sans reprendre son souffle.
  verifie("la pause entre les parties est eteinte", !m.pause);
  verifie("son identifiant est un vrai identifiant", m.id.length >= 16);
  const p = montantePublique(m);
  verifie("l'etat public annonce six etapes", p.etapes === ETAPES_MONTANTE);
  verifie("et le format de la premiere", p.nom === etapeMontante(1).nom, p.nom);
  verifie("et celui de la suivante", p.suivante === etapeMontante(2).nom,
    p.suivante ?? "aucune");
  verifie("rien a reprendre au depart", etapeReprenable(m) === null);
}

// -------------------------------------------------------- l'enchainement
console.log("\n  --- l'enchainement ---\n");
{
  const m = nouvelleMontante();
  cloreLEtape(m, vue({ temps: 10_000 }));
  verifie("l'etape close ne passe pas d'elle-meme a la suivante",
    m.close && m.rang === 1);
  verifie("l'hote la fait passer", passerALEtapeSuivante(m) === 2);
  verifie("et la suivante n'est pas close", !m.close && m.essai === 1);
  verifie("une etape non close ne passe pas", passerALEtapeSuivante(m) === null);

  // L'ETAPE CLOSE NE SE COMPTE QU'UNE FOIS. Elle a laisse son essai : ajouter
  // en plus l'observation de la partie qui vient de finir la doublerait.
  const m2 = nouvelleMontante();
  const v = vue({ temps: 8_000 });
  cloreLEtape(m2, v);
  verifie("une etape close ne compte pas deux fois",
    totaux(m2, v).temps === 8_000, `${totaux(m2, v).temps} ms`);
  cloreLEtape(m2, vue({ temps: 5_000 }));
  verifie("et elle ne se clot pas deux fois",
    m2.essais.length === 1 && totaux(m2).temps === 8_000);
}

// ---------------------------------------------------- six etapes propres
console.log("\n  --- six etapes topees ---\n");
{
  const m = nouvelleMontante();
  for (let rang = 1; rang <= ETAPES_MONTANTE; rang++) {
    verifie(`etape ${rang} : c'est bien son rang`, m.rang === rang);
    etapeEntiere(m, vue({ temps: 10_000 + rang * 1_000, coups: 20 }));
  }
  verifie("la sixieme close, il n'en reste plus", !ilResteUneEtape(m) && m.close);
  verifie("la montante se termine d'elle-meme", montanteFinieDElleMeme(m));
  const t = totaux(m);
  verifie("le temps est celui des six etapes", t.temps === 6 * 10_000 + 21_000,
    `${t.temps} ms`);
  verifie("le negatif est nul", t.negatif === 0 && t.rates === 0);
  verifie("les coups s'additionnent", t.coups === 120, String(t.coups));
  verifie("elle pretend encore au tableau", !montantePerdue(m));

  const ligne = mancheDeLaMontante(m, CFG);
  verifie("elle donne une ligne", ligne !== null);
  verifie("de categorie montante", ligne?.categorie === "montante");
  verifie("topee", ligne?.topee === true);
  verifie("son temps est le total", ligne?.temps === t.temps);
  verifie("elle porte ses six etapes", ligne?.etapes?.length === ETAPES_MONTANTE,
    `${ligne?.etapes?.length ?? 0}`);
  verifie("chacune avec son rang et son format",
    ligne?.etapes?.every((e, i) => e.rang === i + 1 && e.categorie !== "") === true,
    (ligne?.etapes ?? []).map((e) => `${e.rang}:${e.categorie}`).join(" "));
  verifie("alice a tout trouve, donc solo", ligne?.solo === "alice", ligne?.solo ?? "personne");
  verifie("sa reference n'est pas celle d'une etape",
    ligne !== null && !ligne.etapes!.some((e) => e.ref === ligne.ref));
}

// --------------------------------------------- le bouton vit une etape
console.log("\n  --- la fenetre du bouton de reprise ---\n");
{
  // Un rate au MILIEU d'une etape : le bouton vit jusqu'a la fin de cette
  // etape, close comprise, puis disparait.
  const m = nouvelleMontante();
  etapeEntiere(m, vue({ temps: 10_000 }));
  const enCours = vue({ temps: 4_000, rates: 1 });
  verifie("un rate en cours d'etape ouvre la reprise",
    etapeReprenable(m, enCours) === 2, String(etapeReprenable(m, enCours)));
  cloreLEtape(m, vue({ temps: 9_000, rates: 1, dernier: false }));
  verifie("l'etape close, la reprise est encore la",
    etapeReprenable(m) === 2, String(etapeReprenable(m)));
  passerALEtapeSuivante(m);
  verifie("l'etape suivante commencee, elle a disparu",
    etapeReprenable(m) === null, String(etapeReprenable(m)));

  // UN RATE AU DERNIER COUP COCHE LA PAUSE TOUTE SEULE, et le bouton reste sur
  // CETTE etape (la deuxieme, ici) -- jamais sur la precedente, jamais sur la
  // suivante.
  const b = nouvelleMontante();
  etapeEntiere(b, vue({ temps: 10_000 }));                        // etape 1, propre
  verifie("la pause est encore eteinte avant le rate", !b.pause);
  cloreLEtape(b, vue({ temps: 9_000, rates: 1, dernier: true }));  // etape 2, ratee
  verifie("le rate au dernier coup coche la pause toute seule", b.pause);
  verifie("le bouton propose l'etape EN COURS, pas une autre",
    etapeReprenable(b) === 2, String(etapeReprenable(b)));
  verifie("et le format propose est celui de l'etape 2",
    montantePublique(b).nomReprenable === etapeMontante(2).nom,
    montantePublique(b).nomReprenable ?? "aucun");

  // L'hote peut choisir de continuer quand meme : la fenetre se ferme alors
  // pour de bon, sans laisser de trace dans l'etape suivante.
  verifie("l'hote passe outre", passerALEtapeSuivante(b) === 3);
  verifie("rien ne reste a reprendre dans l'etape suivante",
    etapeReprenable(b) === null, String(etapeReprenable(b)));
  verifie("et son negatif reste au compteur, assume",
    totaux(b).negatif > 0, String(totaux(b).negatif));
}

// ------------------- la pause automatique ne survit pas a la reprise, l'autre si
console.log("\n  --- la pause automatique s'eteint a la reprise, celle de l'hote non ---\n");
{
  // Un rate au dernier coup coche la pause toute seule ; la reprendre efface
  // cette pause avec elle -- elle a fait son office, et ne doit pas peser sur
  // la tentative suivante.
  const auto = nouvelleMontante();
  etapeEntiere(auto, vue({ temps: 10_000 }));                        // 1, propre
  cloreLEtape(auto, vue({ temps: 9_000, rates: 1, dernier: true }));  // 2, ratee
  verifie("la pause s'est cochee toute seule", auto.pause);
  verifie("... et elle est marquee automatique", auto.pauseAuto);
  verifie("l'etape se reprend", reprendreLEtape(auto, 2) === 2);
  verifie("la pause automatique s'est eteinte a la reprise", !auto.pause);
  verifie("... et elle n'est plus marquee automatique", !auto.pauseAuto);

  // Une pause que l'hote a allumee LUI-MEME, avant meme le rate, n'est pas
  // automatique -- et elle survit donc a la reprise qui suit.
  const hote = nouvelleMontante();
  hote.pause = true;   // le geste du message "montante-pause", hors auto
  etapeEntiere(hote, vue({ temps: 10_000 }));                        // 1, propre
  cloreLEtape(hote, vue({ temps: 9_000, rates: 1, dernier: true }));  // 2, ratee
  verifie("le rate ne s'approprie pas la pause de l'hote", !hote.pauseAuto);
  verifie("l'etape se reprend", reprendreLEtape(hote, 2) === 2);
  verifie("la pause de l'hote survit a la reprise", hote.pause);

  // Le rate coche la pause automatique ; l'hote la CONFIRME ensuite d'un geste
  // manuel (il recoche la case, comme le fait le message "montante-pause") --
  // elle cesse alors d'etre automatique, et survivra desormais a une reprise.
  const confirmee = nouvelleMontante();
  etapeEntiere(confirmee, vue({ temps: 10_000 }));                        // 1, propre
  cloreLEtape(confirmee, vue({ temps: 9_000, rates: 1, dernier: true }));  // 2, ratee
  verifie("la pause s'est cochee toute seule", confirmee.pauseAuto);
  confirmee.pause = true; confirmee.pauseAuto = false;   // le geste manuel de l'hote
  verifie("l'etape se reprend", reprendreLEtape(confirmee, 2) === 2);
  verifie("la pause confirmee par l'hote survit a la reprise", confirmee.pause);
}

// ------------------------------------------------------ le prix d'une reprise
console.log("\n  --- le prix d'une reprise ---\n");
{
  const m = nouvelleMontante();
  etapeEntiere(m, vue({ temps: 30_000 }));                       // etape 1, propre
  // Etape 2 ratee, reprise en pleine partie : c'est le serveur qui clot
  // l'essai abandonne pour que son temps reste au compteur.
  const abandon = vue({ temps: 12_000, rates: 2, negatif: 47 });
  verifie("avant la reprise, le rouge est allume",
    totaux(m, abandon).rates === 2 && totaux(m, abandon).negatif === 47);
  cloreLEtape(m, abandon);
  verifie("l'etape 2 se reprend", reprendreLEtape(m, 2) === 2);
  verifie("et c'est un deuxieme essai", m.rang === 2 && m.essai === 2 && !m.close);

  const t = totaux(m);
  // LE TEMPS COMPTE TOUT.
  // ET CE N'EST PAS L'ETAPE 1 : le temps de l'essai abandonne reste. Seule
  // l'etape 1 remet le chrono a zero, parce qu'il n'y a rien avant elle.
  verifie("le temps de l'essai abandonne reste au compteur",
    t.temps === 42_000, `${t.temps} ms`);
  // LE NEGATIF NE COMPTE QUE CE QUI RESTE.
  verifie("son negatif est oublie", t.negatif === 0, String(t.negatif));
  verifie("et le rouge s'eteint", t.rates === 0 && !montantePerdue(m));
  verifie("ses coups aussi sont oublies", t.coups === 20, String(t.coups));

  // Le deuxieme essai va au bout.
  etapeEntiere(m, vue({ temps: 11_000 }));
  verifie("le deuxieme essai compte, lui", totaux(m).temps === 53_000
    && totaux(m).negatif === 0, `${totaux(m).temps} ms`);
  verifie("un troisieme essai porterait le numero 3",
    m.essais.filter((e) => e.rang === 2).length === 2);
}

// -------------------------- reprendre une etape en abandonne les suivantes
console.log("\n  --- une etape depassee ne se reprend plus ---\n");
{
  // AVANT LA PAUSE AUTOMATIQUE, un rate au dernier coup de l'etape 2 aurait
  // laisse le bouton suivre jusque dans l'etape 3, et remonter y reprendre
  // l'etape 2 y restait possible. Ce n'est plus le cas : la pause se coche
  // toute seule, et si l'hote choisit malgre tout de continuer, la fenetre de
  // l'etape 2 se ferme pour de bon des qu'on la quitte.
  const m = nouvelleMontante();
  etapeEntiere(m, vue({ temps: 20_000 }));                        // 1, propre
  cloreLEtape(m, vue({ temps: 15_000, rates: 1, negatif: 40, dernier: true })); // 2, ratee
  verifie("la pause s'est cochee toute seule", m.pause);
  verifie("le bouton propose l'etape en cours", etapeReprenable(m) === 2);

  verifie("l'hote passe outre malgre le rate", passerALEtapeSuivante(m) === 3);
  verifie("l'etape 2 ne se reprend plus, a peine quittee",
    reprendreLEtape(m, 2) === null);

  // L'etape 3 rate a son tour : c'est ELLE que le bouton designe desormais,
  // jamais l'etape 2 -- dont le rate reste au compteur, assume.
  const trois = vue({ temps: 9_000, rates: 1, negatif: 25 });
  verifie("le rate de l'etape 3 n'ouvre que l'etape 3",
    etapeReprenable(m, trois) === 3, String(etapeReprenable(m, trois)));
  cloreLEtape(m, trois);
  verifie("l'etape 2 reste hors d'atteinte", reprendreLEtape(m, 2) === null);
  verifie("mais l'etape 3, elle, se reprend", reprendreLEtape(m, 3) === 3);
  verifie("et c'est son deuxieme essai", m.rang === 3 && m.essai === 2);

  const t = totaux(m);
  verifie("le temps garde tout, etape 2 comprise",
    t.temps === 44_000, `${t.temps} ms`);
  verifie("le negatif de l'etape 2 assumee reste au compteur",
    t.negatif === 40, String(t.negatif));
}

// ------------------------------- recommencer l'etape 1, c'est repartir de zero
console.log("\n  --- recommencer l'etape 1 ---\n");
{
  // RIEN N'A ENCORE ETE ACCOMPLI. Le chrono repart de zero, et non pas « tout
  // sauf le negatif » : c'est comme recommencer la montante.
  const m = nouvelleMontante();
  const abandon = vue({ temps: 24_000, rates: 3, negatif: 140 });
  cloreLEtape(m, abandon);
  verifie("l'etape 1 se reprend", reprendreLEtape(m, 1) === 1);
  const t = totaux(m);
  verifie("le chrono repart de zero", t.temps === 0, `${t.temps} ms`);
  verifie("et tout le reste avec", t.negatif === 0 && t.rates === 0 && t.coups === 0);
  verifie("c'est le deuxieme essai de l'etape 1", m.rang === 1 && m.essai === 2);
  verifie("il ne reste aucun essai derriere", m.essais.length === 0);
  verifie("elle pretend de nouveau au tableau", !montantePerdue(m));

  // Un troisieme essai porte bien le numero 3.
  cloreLEtape(m, vue({ temps: 11_000, rates: 1 }));
  verifie("l'etape 1 se reprend encore", reprendreLEtape(m, 1) === 1);
  verifie("et c'est le troisieme essai", m.essai === 3, `essai ${m.essai}`);
  verifie("le chrono repart de zero une fois de plus", totaux(m).temps === 0);

  // Puis la montante se joue normalement : le temps recompte a partir de la.
  etapeEntiere(m, vue({ temps: 13_000 }));
  verifie("l'etape 1 reussie compte son temps", totaux(m).temps === 13_000,
    `${totaux(m).temps} ms`);
}

// ---------------------------------------------- la montante qui ne se reprend pas
console.log("\n  --- qui ne recommence pas continue ---\n");
{
  const m = nouvelleMontante();
  for (let rang = 1; rang <= ETAPES_MONTANTE; rang++) {
    etapeEntiere(m, vue({ temps: 10_000, rates: rang === 3 ? 1 : 0, negatif: rang === 3 ? 55 : 0 }));
  }
  verifie("la sixieme est close", m.close && !ilResteUneEtape(m));
  verifie("le rate de l'etape 3 est reste", totaux(m).negatif === 55);
  verifie("plus rien a reprendre", etapeReprenable(m) === null);
  verifie("elle se termine d'elle-meme", montanteFinieDElleMeme(m));
  const ligne = mancheDeLaMontante(m, CFG);
  verifie("sa ligne n'est pas topee", ligne?.topee === false);
  verifie("et porte son negatif", ligne?.negatif === 55, String(ligne?.negatif));
}

// ------------------------- une reprise offerte a la fin retient la montante
console.log("\n  --- une reprise offerte a la fin ---\n");
{
  const m = nouvelleMontante();
  for (let rang = 1; rang < ETAPES_MONTANTE; rang++) {
    etapeEntiere(m, vue({ temps: 10_000 }));
  }
  cloreLEtape(m, vue({ temps: 9_000, rates: 1, negatif: 33 }));   // etape 6 ratee
  verifie("la montante est achevable", montanteAchevable(m));
  verifie("mais pas finie d'elle-meme : il reste un choix",
    !montanteFinieDElleMeme(m) && etapeReprenable(m) === 6);
  // L'hote reprend la sixieme : le negatif s'efface, le temps reste.
  verifie("la sixieme se reprend", reprendreLEtape(m, 6) === 6);
  verifie("elle n'est plus achevable", !montanteAchevable(m));
  etapeEntiere(m, vue({ temps: 12_000 }));
  verifie("le deuxieme essai la clot proprement",
    montanteFinieDElleMeme(m) && totaux(m).negatif === 0);
  verifie("et le temps a tout garde", totaux(m).temps === 50_000 + 9_000 + 12_000,
    `${totaux(m).temps} ms`);
}

// -------------------------------------------------- ce qui interdit la ligne
console.log("\n  --- ce qui prive de tableau ---\n");
{
  // Une etape que le serveur n'a pas vue en entier -- il a redemarre -- ou qui
  // n'est pas allee au bout de son sac.
  const m = nouvelleMontante();
  for (let rang = 1; rang <= ETAPES_MONTANTE; rang++) {
    etapeEntiere(m, vue({ temps: 10_000, valide: rang !== 4 }));
  }
  verifie("une etape invalide fait perdre la montante", montantePerdue(m));
  verifie("et prive de ligne", mancheDeLaMontante(m, CFG) === null);
  verifie("l'etat public le dit", montantePublique(m).perdue);

  // Une montante qui n'a pas six etapes n'a pas de ligne.
  const court = nouvelleMontante();
  etapeEntiere(court, vue({ temps: 10_000 }));
  etapeEntiere(court, vue({ temps: 10_000 }));
  verifie("trois etapes ne font pas une montante",
    mancheDeLaMontante(court, CFG) === null);

  // Une grille sans fin n'a pas de bout : pas de montante, donc pas de ligne.
  const sansFin = nouvelleMontante();
  for (let rang = 1; rang <= ETAPES_MONTANTE; rang++) {
    etapeEntiere(sansFin, vue({ temps: 10_000 }));
  }
  verifie("une grille sans bornes n'a pas de ligne",
    mancheDeLaMontante(sansFin, avec(CFG, { bornes: null })) === null);
}

// ------------------------------------------ la ligne part vraiment au journal
console.log("\n  --- la ligne au journal ---\n");
{
  // Le journal reel est mis de cote : ce test ne doit rien couter a la machine
  // sur laquelle il tourne.
  const gardeAPart = existsSync(JOURNAL);
  if (gardeAPart) renameSync(JOURNAL, DE_COTE);
  try {
    ouvrirLesRecords();
    const m = nouvelleMontante();
    for (let rang = 1; rang <= ETAPES_MONTANTE; rang++) {
      etapeEntiere(m, vue({ temps: 10_000 }));
    }
    const ligne = mancheDeLaMontante(m, CFG);
    if (ligne === null) verifie("la ligne existe", false);
    else {
      const { ajouterUneManche, mancheDe, manchesValides, tableau } =
        await import("../src/records.ts");
      ajouterUneManche(ligne);
      verifie("elle se retrouve par sa reference", mancheDe(ligne.ref) !== undefined);
      verifie("elle compte parmi les manches valides",
        manchesValides().some((x) => x.ref === ligne.ref));
      const t = tableau({ categorie: "montante" });
      verifie("et elle mene le tableau de la montante",
        t.topees[0]?.ref === ligne.ref, `${t.topees.length} ligne(s)`);
      // Le journal fait foi : on relit, la ligne et ses etapes sont la.
      ouvrirLesRecords();
      const relue = mancheDe(ligne.ref);
      verifie("relue du journal, elle garde ses six etapes",
        relue?.etapes?.length === ETAPES_MONTANTE, `${relue?.etapes?.length ?? 0}`);
    }
  } finally {
    if (existsSync(JOURNAL)) rmSync(JOURNAL);
    if (gardeAPart && existsSync(DE_COTE)) renameSync(DE_COTE, JOURNAL);
  }
}

console.log(`\n${echecs === 0 ? "Tout est bon." : `${echecs} echec(s).`}\n`);
process.exit(echecs === 0 ? 0 : 1);
