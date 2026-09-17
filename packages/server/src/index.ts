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
import { Game, type PlayedMove, type RaisonDeFin } from "./game.ts";
import {
  ouvrirSalon, relancer, archiver, salon, tousLesSalons, resume,
  salonsEnregistres, fermerSalon, identifiantPris, slug, nomAuHasard,
  confierLesReglages, comptedesInfinies, meriteDEtreGardee, peutEntrerDans,
  MAX_SALONS, MAX_INFINIES, type Salon,
} from "./salons.ts";
import { LAYOUTS } from "../../engine/src/bonus.ts";
import {
  avec, avecDictionnaire, configParDefaut, deserialiser, serialiser,
  type ConfigPartie,
} from "../../engine/src/config.ts";
import { categorie, estPartieNormale } from "../../engine/src/categories.ts";
import {
  ajouterUneManche, annexe, compteurWuQi, coupsExtremes, mancheDe, manchesValides, motsRates,
  motsTrouves, observer, ouvrirLesRecords, tableau,
  type Annexe, type EtapeObservee,
} from "./records.ts";
import {
  cloreLEtape, etapeReprenable, ilResteUneEtape, mancheDeLaMontante,
  montanteAchevable, montanteFinieDElleMeme, montantePublique, nouvelleMontante,
  passerALEtapeSuivante, reprendreLEtape,
} from "./montante.ts";
import { configDeLEtape, etapeMontante, montantePossible } from "../../engine/src/montante.ts";
import {
  journalDeLaPartie, journalDuSalon, paliersDuCoup, relire, relireEtGarder,
} from "./lecteur.ts";
import {
  apercuDeDemain, apercusDe, assurerLesPartiesDuJour, assurerLesTournoisDeLaSemaine,
  changerLesPartiesDeDemain, ecrireUnModeleHebdo, laSemaineDe, modeleHebdo, reglerLaSemaine,
  supprimerUnModeleHebdo, tousLesModelesHebdo,
  creerUnTournoiDeBattle, creerUnTournoiDeTopping, cumulDeLEpreuve, epreuveDuJour,
  classementDesMedailles, listeDesSolos, modifierUnTournoiDeBattle, modifierUnTournoiDeTopping,
  partiesFiniesDe, supprimerUnTournoi, tournoiModifiable, JOUEURS_POUR_UN_SOLO,
  annulerLaMancheDeRencontre, arbitrerLaRencontre, campDuCompte, classementDeLaPoule,
  classementFinalDuBattle, finaleDuTournoi, lancerLeTableau, planifierLeTableau,
  poulesFinies, tableauDuTournoi,
  butoirDeLaRencontre, dateImposeeDe, datesImposeesDe, limiteDeLaRencontre, reglerLaDateDeLaPhase,
  rencontreOuvrable,
  declarerUnForfait, desinscrireDuTournoi, disposDe, ecrireUnMessageDeRencontre,
  enteteDuTournoi, finirUneMancheDeRencontre, joueursDuCamp, lancerLesPoules,
  messagesDeLaRencontre, ouvrirUneMancheDeRencontre, phaseDuBattle, poulesDuTournoi,
  reglerLEntete, reglerLesDispos, rencontreDuSalon, rencontreParId, rencontresDuTournoi,
  tirerDesPoules,
  type Rencontre,
  epreuveDuTournoi, finirLaManche, finisseursDuTournoi, inscriptionDe, inscrireAuTournoi,
  joursConnus, bilanDeLaManche, ceuxQuiOntFini, creerUnDefi, defi, defiDeLaPartie,
  defiDeLEpreuve, epreuveDuDefi, manchesDe,
  type Defi, type FinDeManche,
  lexiqueDeLEpreuve, lireLEpreuve, mancheDuCompte, mancheDuSalon, mancheParId,
  ouvrirLeCompetitif, ouvrirUneManche, partieFigee, partiesDeLEpreuve, partiesDuJour,
  resultatsDeLaPartie, salonDeLaPartie, tournoi, tournoiDeLEpreuve, tournoiPublic,
  tousLesTournois,
  type ChangementDuJour, type Jeu, type Manche, type ReglagesBattle, type Tournoi,
} from "./competitif.ts";
import {
  marquerLues, notificationsDe, notifier, ouvrirLesNotifications,
} from "./notifications.ts";
import {
  ecrireUnePartie, lignesDesJoueurs, ouvrirLHistorique, partieDeLHistorique, partiesDe,
} from "./historique.ts";
import {
  LEXIQUES_DU_JOUR, configDuModele, consigneRecevable, decalerLeJour, instantDeParis, jourDe, jourValide,
  tirerUneConsigne, type ConsigneDePartie,
  nomDeLaPartie, type ModeleDePartie,
} from "../../engine/src/epreuves.ts";

/** Les tableaux annexes qui classent des PARTIES. Voir SPEC.md §23. */
const ANNEXES: readonly Annexe[] = [
  "chrono", "chere", "pasChere", "courte", "longue", "farfouilles", "peuDeFarfouilles",
];

/**
 * Le temps qu'une etape de montante reste a l'ecran avant que la suivante
 * commence, en millisecondes.
 *
 * ZERO SERAIT TROP COURT. Le dernier top de l'etape vient d'etre diffuse ; sans
 * ce delai, le message de relance arrive dans la meme foulee et le caramel ne
 * s'est pas encore pose a l'ecran. Deux secondes suffisent pour le lire.
 *
 * ELLES NE COUTENT RIEN : le temps de la montante est la somme des temps de ses
 * coups (§16), et ce qui se passe entre deux etapes n'est compte par personne.
 * Qui veut vraiment regarder la grille allume la pause.
 */
const DELAI_ENTRE_ETAPES_MS = 2000;
import { setLayout } from "../../engine/src/bonus.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";
import type { Dir } from "../../engine/src/coords.ts";
import { dawgPath } from "../../engine/src/paths.ts";
import {
  DICO_PAR_DEFAUT, DICO_PAR_LANGUE, LEXIQUE_TOUS, dictionnaireConnu, type Langue,
} from "../../engine/src/dictionnaires.ts";
import { Seau, seauDeRafale, SOUMISSIONS_PAR_SECONDE, MESSAGES_PAR_SECONDE } from "./debit.ts";
import { lireLeRapport, enregistrerLeRapport } from "./bugs.ts";
import {
  lireLesComptes, creerCompte, compte, motDePasseJuste, changerLeMotDePasse,
  ecrireLeProfil, ecrireLaLangue, demanderLaVerification, trancherLaVerification,
  tousLesComptes,
  emettreUnJeton, compteDuJeton, jetonDesEntetes, cookieDeSession, cookieEfface,
  publicDuCompte, priveDuCompte, pseudoEnregistre, assurerLesAdmins, cleDuPseudo,
  nomComplet, envoyerLeLienDeVerification, confirmerLAdresse, type Compte,
} from "./comptes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..", "..", "web");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const PORT = Number(arg("port", "3000"));
const GAME_ID = arg("partie", "mondiale");
/** La grille permanente anglaise, jumelle de la francaise. */
const GAME_ID_EN = arg("partie-en", "mondiale-en");
const NOM_MONDIALE_EN = "The Infinite Grid";
/**
 * Secondes de compte a rebours quand l'administration lance une grille.
 *
 * Dix : le temps de prevenir la salle, de reposer les mains sur le clavier, et
 * de regarder les chiffres descendre ensemble.
 */
const DECOMPTE_LANCEMENT = 10;
const LAYOUT = arg("pavage", "pave1") as LayoutName;
/** Bouton "reveler le top" : commodite de test, absente pour les joueurs. */
const REVEAL = process.argv.includes("--reveler");
/**
 * Les comptes qui tranchent les demandes de verification.
 *
 * Plusieurs noms separes par des virgules. Le premier est le compte
 * d'administration proprement dit -- cree s'il manque, et seul concerne par
 * `--admin-mdp`. Les suivants sont des comptes de joueurs a qui l'on donne les
 * droits sans toucher a leur mot de passe.
 */
const ADMINS = arg("admin", "admin").split(",").map((n) => n.trim()).filter((n) => n !== "");
const ADMIN_MDP = arg("admin-mdp", process.env["FARFOUILLE_ADMIN_MDP"] ?? "");

/**
 * Le demi-cote de la SUPER GRILLE : dix cases, donc un plateau de 21x21.
 *
 * C'est lui qui choisit le pavage : sept donne le plateau du commerce, dix
 * donne la super grille et ses quadruples.
 */
const SUPER_BORNES = 10;

/** Le nom d'une grille, pour la console. */
function nomDeLaGrille(bornes: number | null): string {
  if (bornes === null) return "grille infinie";
  if (bornes === SUPER_BORNES) return "super grille 21x21";
  return `${bornes * 2 + 1}x${bornes * 2 + 1}`;
}

/** Le temps par coup le plus court qu'un joueur puisse demander, en secondes. */
const CHRONO_MINIMUM = 15;

/**
 * LE PLANCHER S'ABAISSE LA OU SE JOUE UN RECORD. Voir SPEC.md §23.
 *
 * Un chrono court coute au SERVEUR, pas au joueur : chaque coup demande un
 * calcul de top complet, et quinze secondes par coup font deja quatre calculs
 * par minute et par salon. D'ou le plancher.
 *
 * Sur la configuration exacte de la partie normale -- 15x15, 7 sur 7, sans
 * joker, sac du commerce, primes intactes, sans borne -- il descend a une
 * seconde. C'est la, et seulement la, qu'un record de chrono se joue ; le
 * refuser reviendrait a ouvrir un tableau que personne ne peut remplir.
 *
 * Ce que ca coute, mesure : le premier top d'une 15x15 vide demande 17 ms, et
 * les coups suivants, sur une grille plus contrainte, ne coutent pas
 * davantage. Un coup par seconde tient largement.
 */
const CHRONO_MINIMUM_RECORD = 1;

/**
 * Parties du disque a rouvrir DANS UN SALON, separees par des virgules.
 *
 * A ne pas confondre avec `--partie`, qui met une partie a la place de la
 * grille permanente. Ici, elle devient un salon de plus : la grille permanente
 * garde sa place, et l'ancienne partie se consulte a cote.
 */
const ROUVRIR = arg("rouvrir", "").split(",").map((s) => s.trim()).filter((s) => s !== "");
/** A qui appartiennent les salons ainsi rouverts -- pour pouvoir les refermer. */
const PROPRIETAIRE = arg("proprietaire", "") || null;
/**
 * Les parties dont on peut REVOIR LES COUPS SANS ATTENDRE LA FIN.
 *
 * Le rejeu est normalement reserve aux parties closes : avant, montrer les
 * paliers d'un coup, c'est donner les reponses. Une grille infinie, elle, n'a
 * pas de fin -- ses isotops et ses sous-tops resteraient a jamais invisibles.
 *
 * L'ouverture ne porte donc que sur les COUPS DEJA JOUES, ou le top est de
 * toute facon public : `paliersDuCoup` ne connait pas le coup en cours et rend
 * une liste vide, et le rejeu ne propose que des numeros deja au journal.
 *
 * `--rejeu ""` la referme, `--rejeu a,b` la donne a d'autres.
 */
const REJEU_OUVERT = new Set(
  arg("rejeu", "top-leger").split(",").map((s) => s.trim()).filter((s) => s !== ""),
);
/**
 * Les salons qu'on ne peut pas supprimer, en plus de la grille mondiale.
 *
 * Un salon ordinaire appartient a qui l'a cree et disparait avec lui. Une
 * grille d'etude, elle, porte des milliers de coups joues a plusieurs pendant
 * des semaines : elle ne doit pas tenir a un clic, meme celui de son
 * proprietaire -- qui continue par ailleurs a la regler.
 *
 * `--permanentes ""` la rend supprimable de nouveau.
 */
const PERMANENTS = new Set(
  arg("permanentes", "top-leger").split(",").map((s) => s.trim()).filter((s) => s !== ""),
);
const estPermanent = (s: Salon): boolean =>
  s.proprietaire === null || PERMANENTS.has(s.id);

/** « top-leger » se lit mieux « Top leger ». */
const joliNom = (id: string): string =>
  id.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

setLayout(LAYOUT);

/** Instant du demarrage : sert a reperer un serveur plus vieux que la page. */
const DEMARRE_A = Date.now();

/**
 * La variante de la partie qu'on s'apprete a archiver.
 *
 * Lue AVANT de mettre les fichiers de cote, faute de quoi elle disparaitrait
 * avec eux : `--nouvelle` repartait alors sur la variante par defaut. Une
 * grille permanente reglee sur le sac de 102 bouclant s'est ainsi retrouvee en
 * probabilites ponderees, sans que rien ne le dise -- et sans reliquat a
 * l'ecran, puisque des probabilites n'ont pas de stock.
 *
 * « Recommencer la partie » ne veut pas dire « changer de jeu ».
 */
const VARIANTE_PRECEDENTE = Game.configEnregistree(GAME_ID);

// --nouvelle : la grille mondiale repart a zero. Rien n'est efface, les trois
// fichiers sont mis de cote sous un meme horodatage.
if (process.argv.includes("--nouvelle")) {
  const faits = archiver(GAME_ID);
  if (faits.length > 0) {
    // Le nom de la partie est ce qui precede le suffixe, HORODATAGE COMPRIS.
    // Decoupe sur les points, `[1]` ne rendait que l'horodatage nu : le nom
    // annonce n'existait pas, et l'ouvrir aurait cree une partie vide.
    const nom = faits[0]!.replace(/\.(secours\.json|journal\.jsonl|json)$/, "");
    console.log(`  partie precedente archivee : ${faits.join(", ")}`);
    console.log(`  (rien n'est efface -- pour la rouvrir : --partie ${nom})`);
  } else {
    console.log(`  aucune partie "${GAME_ID}" a archiver, on part de zero`);
  }
}

/** Variante de la grille mondiale, demandee en ligne de commande (SPEC.md §16). */
const CFG_MONDIALE = (() => {
  const enregistree = Game.configEnregistree(GAME_ID);
  // `--pioche` compte comme les autres : sans cela, la demander sur une partie
  // deja commencee ne faisait RIEN, en silence -- exactement le genre de
  // reglage qu'on croit passe et qui ne l'est pas.
  const demande = process.argv.some((a) =>
    a === "--tirage" || a === "--jouables" || a === "--sac102" || a === "--pioche");
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

  // La partie neuve reprend la variante de celle qu'elle remplace, sauf si la
  // ligne de commande en demande une autre.
  const base = VARIANTE_PRECEDENTE !== null
    ? deserialiser(VARIANTE_PRECEDENTE) : configParDefaut();
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
  // La pioche de la grille principale. `--sac102` reste accepte : c'est le nom
  // qu'avait l'option quand il n'y en avait qu'une.
  const pioches = ["probabilites", "sac102", "sac102boucle"] as const;
  const demandee = arg("pioche", process.argv.includes("--sac102") ? "sac102" : base.pioche);
  if (VARIANTE_PRECEDENTE !== null) {
    console.log(`  variante reprise de la partie precedente : ` +
      `${base.jouables} sur ${base.tirage}, pioche ${demandee}`);
  }
  if (!pioches.includes(demandee as typeof pioches[number])) {
    console.error(`
  --pioche doit valoir ${pioches.join(", ")} (recu ${demandee})
`);
    process.exit(1);
  }
  return avec(base, { tirage, jouables, pioche: demandee as typeof pioches[number] });
})();

// ---------------------------------------------------------------- transport

/** Qui est connecte, sous quel pseudo, et dans quel salon. */
interface Client {
  nom: string;
  salon: string;
  /**
   * Le compte lu dans le cookie a l'ouverture de la liaison, s'il y en a un.
   *
   * C'est LUI qui nomme le joueur, pas le message `join` : un client peut
   * ecrire ce qu'il veut dans son message, il ne peut pas fabriquer un cookie
   * que nous avons signe.
   */
  compte: string | null;
}
const clients = new Map<WebSocket, Client>();

/** Les pseudos verifies parmi les presents : le client y met une pastille. */
const verifiesPresents = (salonId: string): string[] =>
  occupants(salonId).filter((n) => compte(n)?.verifie === true);

/**
 * Les vrais noms des presents QUI ONT VOULU LES MONTRER.
 *
 * Le client les pose en infobulle sur les pseudos. Un nom que son porteur n'a
 * pas rendu public ne sort pas d'ici : c'est le seul endroit du transport ou la
 * question se pose, et la reponse tient dans `publicDuCompte`.
 */
function nomsPublics(salonId: string): Record<string, string> {
  const noms: Record<string, string> = {};
  for (const n of occupants(salonId)) {
    const c = compte(n);
    if (c !== undefined && c.nomPublic && nomComplet(c) !== "") noms[n] = nomComplet(c);
  }
  return noms;
}

interface Debit { mots: Seau; tout: Seau; averti: number }
const debits = new Map<WebSocket, Debit>();

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

/**
 * Qui est connecte, TOUS SALONS CONFONDUS (SPEC.md §26) : la liste que la
 * fenetre d'invitation propose. Un onglet non encore nomme (`nom === ""`) n'y
 * figure pas -- inviter quelqu'un qui n'a pas encore choisi de pseudo n'aurait
 * pas de destinataire.
 */
const tousLesConnectes = (): string[] =>
  [...new Set([...clients.values()].map((c) => c.nom))].filter((n) => n !== "");

/** Les sockets d'un pseudo, quel que soit son salon -- pour le prevenir directement. */
const socketsDe = (nom: string): WebSocket[] =>
  [...clients.entries()].filter(([, v]) => v.nom === nom).map(([c]) => c);

/**
 * Remet les manettes du salon dans les mains de quelqu'un qui est la.
 *
 * A appeler des que la liste des presents change -- une arrivee, un depart. On
 * n'annonce que le sens qui a besoin d'etre annonce : celui ou les reglages
 * echoient a quelqu'un d'autre que le createur. Des manettes qu'on recoit sans
 * le savoir ne servent a rien. Dans l'autre sens, le createur qui revient
 * retrouve simplement son bouton, et n'a rien a apprendre.
 */
function majDuGerant(s: Salon): void {
  const neuf = confierLesReglages(s, occupants(s.id));
  if (neuf === null) return;
  // UNE SEULE PHRASE, DANS LES DEUX SENS. « X regle le salon en l'absence de
  // Y » ne valait que dans un sens, ne disait rien au retour de Y, et nommait
  // un absent dont personne n'avait besoin. Qui tient les manettes MAINTENANT :
  // c'est tout ce que la ligne doit apprendre.
  //
  // Un salon permanent ne l'annonce pas : ses reglages ne changent pas de
  // mains, et la ligne n'y serait qu'un bruit de plus dans un chat qui dure.
  if (!estPermanent(s)) s.partie.say("", `${neuf} devient l'hôte.`);
  console.log(`[salon] "${s.nom}" : les reglages passent a ${neuf}`);
}

/** Etat public : jamais le top, jamais la liste des coups jouables (SPEC.md §7). */
function publicState(s: Salon) {
  const g = s.partie;
  return {
    salon: s.id,
    nomSalon: s.nom,
    proprietaire: s.proprietaire,
    // Qui REGLE le salon en ce moment, qui n'est pas toujours qui l'a cree.
    gerant: s.gerant,
    // SALON PRIVE (SPEC.md §26) : la case suit l'etat du salon, pas celui de
    // la partie -- elle survit donc a une relance.
    prive: s.prive,
    moveNumber: g.moveNumber,
    // Muets pendant le decompte : la regle vit dans la partie.
    rack: g.rackPublic,
    notation: g.notationPublique,
    cumul: g.cumul,
    // LE TEMPS DE LA PARTIE EST LA SOMME DE SES COUPS, pas l'horloge du mur.
    // Ce que le serveur passe a chercher le top entre deux coups n'appartient a
    // personne : le compteur se fige pendant ce temps-la et reprend quand le
    // coup part. Le total tombe alors exactement sur « cumul des coups joues +
    // coup en cours ».
    tempsJoue: g.tempsJoue,
    /** Peut-on revoir les coups sans attendre la fin de la partie ? */
    rejeuOuvert: REJEU_OUVERT.has(s.id),
    /** Grille permanente : ni supprimee, ni relancee. */
    permanent: estPermanent(s),
    // LA PARTIE D'EPREUVE QUE CE SALON SERT (SPEC.md §29), ou `null`.
    epreuve: epreuvePublique(s),
    // LA RENCONTRE DE TOURNOI QUE CE SALON SERT (SPEC.md §29), ou `null` :
    // contre qui, quelle manche, ou en est le score, et qui s'est dit pret.
    rencontre: rencontrePublique(s),
    // Une manche en pause montre le temps que son coup avait deja dure.
    enPause: g.enPause,
    ecoulePause: g.ecoulePause,
    sac: g.restantDuSac(),
    finie: g.finie,
    solving: g.solving,
    actif: g.actif,
    demarree: g.demarree,
    lancementA: g.lancementA,
    coupsMax: g.cfg.coupsMax,
    dureeMax: g.cfg.dureeMax,
    // LA MONTANTE DU SALON, ou `null`. Ses cumuls sont ceux de la suite
    // entiere, pas de l'etape en cours : c'est le total qui s'affiche, et c'est
    // le total qui fait le record (SPEC.md §23).
    montante: s.montante === null ? null
      : montantePublique(s.montante, s.vue?.etape()),
    debutDeLaPartie: g.debutDeLaPartie,
    decompteJusqua: g.decompteJusqua,
    servedAt: g.servedAt,
    chrono: g.cfg.chrono,
    mode: g.cfg.mode,
    players: g.players,
    nonTrouves: g.nonTrouves,
    // TOPPING COLLABORATIF SEULEMENT : la meilleure proposition de la table
    // sur le coup en cours (SPEC.md §16). `null` le reste du temps -- rien ne
    // l'ecrit hors de ce mode.
    meilleureCollective: g.meilleureCollective,
    // POINTS, NEGATIF ET TOPS PARTENT DANS LES DEUX MODES.
    //
    // Au duplicate le classement se lit en points et en negatif -- personne ne
    // « remporte » un coup, tout le monde en marque. Au topping il se lit en
    // coups remportes, mais le joueur veut quand meme savoir ce qu'il a laisse
    // au passage : son ecart cumule au top. C'est la meme mesure, et elle se
    // calcule de la meme facon.
    ...g.bilanDesJoueurs(),
    likes: Object.fromEntries(Object.keys(g.players).map((p) => [p, g.likesOf(p)])),
    last: g.moves.length > 0 ? publicMove(g.moves[g.moves.length - 1]!) : null,
    online: occupants(s.id),
    verifies: verifiesPresents(s.id),
    noms: nomsPublics(s.id),
    // Un invite n'a pas de fiche : le client ne rend cliquables que ceux-la.
    inscrits: occupants(s.id).filter((n) => compte(n) !== undefined),
    createdAt: g.createdAt,
    demarreA: DEMARRE_A,
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
    demiPoint: m.demiPoint,
    // DUPLICATE : le score de chacun sur ce coup, pour que le classement
    // puisse se deplier, et QUI a trouve le top -- l'equivalent du `player` du
    // topping, ou le top est pose par celui qui le trouve. Sans cette liste,
    // la feuille de route ne pouvait qu'ecrire « non trouve » a chaque ligne.
    // L'information est publique une fois le coup joue : elle part deja au chat.
    scores: m.scores,
    trouveurs: m.trouveurs,
    propositions: m.propositions,
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
  // Le moteur parle aussi : la liste des trouveurs du duplicate vient de lui.
  s.partie.onChat((m) => broadcast(s.id, { t: "said", msg: m }));
  // UN SALON D'EPREUVE N'ALIMENTE PAS LES RECORDS. Sa partie se met en pause,
  // se referme et se rouvre au fil des retours du joueur : l'observation, qui
  // ne survit pas a une fermeture, y compterait ses mots plusieurs fois. Ce
  // qu'il ecrit, c'est sa manche (SPEC.md §29).
  if (s.epreuve !== null) {
    s.vue = null;
    s.partie.onFin((raison) => cloreLaMancheDuSalon(s, raison));
    return;
  }
  // LE SALON OBSERVE SA PROPRE PARTIE (SPEC.md §23). N'ecrit rien si ses
  // reglages ne peuvent porter aucun record -- une grille sans fin, un
  // duplicate, un sac qui ne s'epuise pas. C'est ici, et nulle part ailleurs,
  // que se decide ce qui entrera au tableau.
  //
  // L'OBSERVATION SE GARDE, maintenant : la montante y lit ses cumuls pendant
  // qu'on joue, et ne peut pas attendre la fin de l'etape pour les connaitre.
  //
  // ELLE NE RECOIT LE RAPPEL QUE S'IL Y A UNE MONTANTE. C'est lui qui fait
  // observer une partie qu'aucun tableau n'accueille : sans montante, la grille
  // mondiale retiendrait ses onze mille coups pour personne.
  s.vue = observer(s.partie,
    s.montante === null ? undefined : (e) => cloreLEtapeDeLaMontante(s, e));
  // ET L'HISTORIQUE DU JOUEUR (SPEC.md §30), qui n'a pas les memes conditions
  // que les records : une grille sans fin et un duplicate y entrent aussi.
  s.partie.onFin((raison) => ecrireLHistoriqueDuSalon(s, raison));
  // ET LA MANCHE D'UNE RENCONTRE DE TOURNOI (SPEC.md §29), quand ce salon en
  // sert une. Il reste un salon ordinaire par ailleurs : ses parties entrent
  // aux records et a l'historique comme les autres.
  if (rencontreDuSalon(s.id) !== undefined) {
    s.partie.onFin(() => cloreLaMancheDeRencontre(s));
    // Le serveur a pu s'arreter entre la fin de la partie et son ecriture.
    if (s.partie.finie) cloreLaMancheDeRencontre(s);
  }
}

/**
 * Ecrit la partie du salon a l'historique de ceux qui l'ont jouee.
 *
 * LA GRILLE PERMANENTE N'EST PAS UNE PARTIE QU'ON JOUE : elle dure depuis des
 * mois et ne finit jamais. Un salon d'epreuve a deja sa manche au journal du
 * competitif.
 */
function ecrireLHistoriqueDuSalon(s: Salon, raison: string): void {
  if (s.epreuve !== null || estPermanent(s)) return;
  ecrireUnePartie({
    salon: s.id, graine: s.partie.seed, nomSalon: s.nom, fin: raison,
    cfg: s.partie.cfg, coups: s.partie.moves,
    estCompte: (nom) => compte(nom) !== undefined,
  });
}

/** Ce que les clients savent de la partie d'epreuve d'un salon. */
function epreuvePublique(s: Salon) {
  const e = s.epreuve;
  if (e === null) return null;
  const quoi = lireLEpreuve(e.epreuve);
  const t = tournoiDeLEpreuve(e.epreuve);
  const p = partiesDeLEpreuve(e.epreuve)?.find((x) => x.n === e.partie);
  const m = e.manche === null ? undefined : mancheParId(e.manche);
  return {
    epreuve: e.epreuve, jour: quoi?.jour ?? null, lexique: lexiqueDeLEpreuve(e.epreuve),
    tournoi: t === undefined ? null : { id: t.id, nom: t.nom },
    partie: e.partie, config: p?.config ?? null, compte: e.compte,
    lancee: m !== undefined, jeu: m?.jeu ?? null, noms: m?.noms ?? "",
    equipe: m?.equipe ?? [], close: m !== undefined && m.fin !== null,
  };
}

/**
 * La partie d'un salon d'epreuve vient de finir : sa manche s'ecrit.
 *
 * UNE PARTIE ABANDONNEE N'EST PAS ENREGISTREE (SPEC.md §29). Le bouton n'existe
 * pas dans une manche ; la regle vaut quand meme ici, pour un message force.
 */
function cloreLaMancheDuSalon(s: Salon, raison: RaisonDeFin): void {
  const id = s.epreuve?.manche ?? null;
  if (id === null || raison === "abandon") return;
  const fin = finirLaManche(id, s.partie.moves, s.partie.cfg.jouables);
  if (fin === null) return;
  prevenirLesRivauxDuDefi(s);
  console.log(`[competitif] manche close dans "${s.id}" : ${fin.coups.length} coups, `
    + `${(fin.temps / 1000).toFixed(2)} s, negatif ${fin.negatif}`);
  broadcast(s.id, { t: "state", state: publicState(s) });
}

/**
 * ON EST PREVENU QUAND QUELQU'UN JOUE UN DEFI QU'ON A JOUE (SPEC.md §29).
 *
 * Pas sur les parties du jour ni les tournois : la pastille ne s'eteindrait
 * jamais. La cle ne laisse passer qu'un avis par manche et par destinataire.
 */
function prevenirLesRivauxDuDefi(s: Salon): void {
  const e = s.epreuve;
  if (e === null || e.manche === null) return;
  const d = defiDeLEpreuve(e.epreuve);
  if (d === undefined) return;
  const m = mancheParId(e.manche);
  if (m === undefined) return;
  for (const qui of ceuxQuiOntFini(e.epreuve, 1)) {
    if (m.equipe.includes(qui) || compte(qui) === undefined) continue;
    notifier(qui, "defi-joue", { defi: d.id, nom: d.nom, de: m.equipe.join(", ") },
      `joue:${m.id}`);
  }
}

/**
 * Ouvre le salon ou se joue une partie d'epreuve -- ou le rend s'il l'est deja.
 *
 * LE SALON EST PROPRE A UN COMPTE ET A UNE PARTIE, et son identifiant ne change
 * pas : un salon referme parce que son joueur est parti se rouvre sur le meme
 * journal, et la manche en pause reprend la ou elle en etait.
 */
async function ouvrirLeSalonDEpreuve(o: {
  epreuve: string; partie: number; compte: string; manche?: Manche;
}): Promise<Salon> {
  const id = o.manche?.salon ?? salonDeLaPartie(o.epreuve, o.partie, o.compte);
  const deja = salon(id);
  if (deja !== undefined) return deja;
  const p = partiesDeLEpreuve(o.epreuve)?.find((x) => x.n === o.partie);
  if (p === undefined) throw new Error("cette partie n'existe pas");
  const figee = partieFigee(p.figee);
  if (figee === null) throw new Error("la partie figée est introuvable");
  const proprietaire = o.manche?.compte ?? o.compte;
  const s = await ouvrirSalon({
    id, nom: `P${p.n} · ${nomDeLaPartie(p.config)}`, proprietaire, prive: true,
    layout: LAYOUT, cfg: deserialiser(p.config), nouveau: true,
    epreuve: {
      epreuve: o.epreuve, partie: o.partie, figee: figee.id, compte: proprietaire,
      manche: o.manche?.id ?? null,
    },
    figee,
  });
  apresOuvertureDEpreuve(s);
  return s;
}

/**
 * QUI S'EST DECLARE PRET dans le salon d'une rencontre : `salon` -> pseudos.
 *
 * Elle ne survit pas a un redemarrage, et c'est bien : une manche qui n'avait
 * pas commence recommence sa mise en place, et deux clics ne coutent rien.
 */
const pretsDeRencontre = new Map<string, Set<string>>();

/** Le nom d'un camp : celui de l'equipe s'il y en a un, le pseudo sinon. */
function nomDuCamp(t: Tournoi, camp: string): string {
  const i = t.inscrits.find((x) => x.compte === camp);
  return i === undefined ? camp : (i.noms.trim() !== "" ? i.noms.trim() : i.compte);
}

/** Les deux camps d'une rencontre entrent dans son salon prive. */
function inviterLesCamps(t: Tournoi, r: Rencontre, s: Salon): void {
  for (const camp of r.camps) for (const qui of joueursDuCamp(t, camp)) s.invites.add(qui);
}

/**
 * LE SALON D'UNE RENCONTRE DE TOURNOI (SPEC.md §29).
 *
 * Le meme geste des deux cotes : le premier arrive l'ouvre, le second l'y
 * rejoint. Une manche entamee se reprend -- une rencontre garde son score entre
 * deux seances, et une coupure de reseau ne doit pas annuler une demi-heure de
 * jeu. Une manche ABANDONNEE, elle, ne se reprend pas : sa partie est close, on
 * en ouvre une neuve, et la rencontre garde ce qu'elle avait.
 */
async function ouvrirLeSalonDeRencontre(t: Tournoi, r: Rencontre): Promise<Salon> {
  const b = t.battle;
  if (b === null) throw new Error("ce tournoi n'est pas un battle");
  const encours = r.manches.find((m) => m.fin === null);
  if (encours !== undefined) {
    const vieux = salon(encours.salon);
    if (vieux !== undefined) {
      if (!vieux.partie.finie) { inviterLesCamps(t, r, vieux); return vieux; }
      // Sa partie est close sans score : c'est un abandon, la manche s'annule.
      annulerLaMancheDeRencontre(r, encours.n);
    } else {
      // LE SALON S'EST REFERME FAUTE DE MONDE, et le rangement le fait au bout
      // de quelques minutes. On le rouvre TEL QUEL, avec sa partie : la manche
      // ne se consomme pas parce que personne n'est venu.
      return await poserLeSalon(t, r, encours.n, encours.salon, false);
    }
  }
  return await poserLeSalon(t, r, r.manches.length + 1, `bat-${r.id.slice(0, 8)}-${r.manches.length + 1}`, true);
}

/** Ouvre (ou rouvre) le salon d'une manche de rencontre, et l'invite. */
async function poserLeSalon(
  t: Tournoi, r: Rencontre, n: number, id: string, neuve: boolean,
): Promise<Salon> {
  const deja = salon(id);
  if (deja !== undefined) { inviterLesCamps(t, r, deja); return deja; }
  const s = await ouvrirSalon({
    id, nom: `${nomDuCamp(t, r.camps[0])} · ${nomDuCamp(t, r.camps[1])} · manche ${n}`,
    proprietaire: r.camps[0], prive: true, layout: LAYOUT,
    cfg: configDuModele(t.battle!.partie, t.lexique), nouveau: true,
  });
  // LA MANCHE S'OUVRE AVANT LA SURVEILLANCE : c'est sa ligne de journal qui
  // rattache le salon a la rencontre, et `surveiller` la lit.
  if (neuve) ouvrirUneMancheDeRencontre(r, id);
  inviterLesCamps(t, r, s);
  surveiller(s);
  rangerPlusTard(s.id);
  return s;
}

/**
 * CE QUE LE SALON D'UNE RENCONTRE DIT DE SA RENCONTRE, ou `null`.
 *
 * On y lit contre qui l'on joue, ou en est le score, et qui s'est declare pret.
 * Un joueur doit savoir ce qu'il joue pendant qu'il le joue (SPEC.md §29).
 */
function rencontrePublique(s: Salon): Record<string, unknown> | null {
  const rc = rencontreDuSalon(s.id);
  if (rc === undefined) return null;
  const t = tournoi(rc.rencontre.tournoi);
  if (t === undefined) return null;
  const r = rc.rencontre;
  const faites = r.manches.filter((m) => m.points !== null);
  const ici = new Set(occupants(s.id));
  const prets = pretsDeRencontre.get(s.id) ?? new Set<string>();
  return {
    tournoi: t.id, nomDuTournoi: t.nom, rencontre: r.id, manche: rc.n, bo: r.bo,
    camps: r.camps,
    noms: [nomDuCamp(t, r.camps[0]), nomDuCamp(t, r.camps[1])],
    // QUI JOUE POUR CHAQUE CAMP : l'ecran ne peut pas savoir autrement s'il
    // regarde ou s'il joue -- l'etat part le meme a tout le monde.
    joueurs: [joueursDuCamp(t, r.camps[0]), joueursDuCamp(t, r.camps[1])],
    score: [0, 1].map((i) => faites.filter((m) => m.gagnant === r.camps[i]).length),
    // PRET ET PRESENT : partir apres avoir clique ne compte plus. Sinon la
    // partie s'ouvrirait sur un siege vide.
    prets: [...prets].filter((n) => ici.has(n)),
  };
}

/**
 * UNE RENCONTRE PART QUAND LES DEUX CAMPS SE DISENT PRETS (SPEC.md §29).
 *
 * Elle n'a pas de bouton « Lancer » -- ses reglages sont ceux du tournoi, et
 * personne n'a a les valider -- mais elle ne part pas non plus a l'arrivee du
 * second : on charge une page, on s'installe, on relit le score. C'est le
 * joueur qui dit quand il est pret, et la partie attend les deux.
 *
 * LE DECOMPTE EST IMPOSE : sans lui, celui qui a clique le premier verrait le
 * tirage pendant que l'autre clique encore.
 */
function lancerLaRencontreSiLesDeuxSontPrets(s: Salon): void {
  const rc = rencontreDuSalon(s.id);
  if (rc === undefined || s.partie.demarree || s.partie.finie) return;
  const t = tournoi(rc.rencontre.tournoi);
  if (t === undefined) return;
  const ici = new Set(occupants(s.id));
  const prets = pretsDeRencontre.get(s.id) ?? new Set<string>();
  const pret = (camp: string): boolean =>
    joueursDuCamp(t, camp).some((n) => ici.has(n) && prets.has(n));
  if (!rc.rencontre.camps.every(pret)) return;
  pretsDeRencontre.delete(s.id);
  s.partie.decompteImpose = true;
  console.log(`[competitif] rencontre "${s.nom}" lancee : les deux camps sont prets`);
  void s.partie.demarrer();
}

/**
 * Ecrit le score d'une manche de rencontre a la fin de sa partie.
 *
 * UNE PARTIE ABANDONNEE NE COMPTE PAS : la manche s'annule et se rejouera.
 * Sans cela, partir en cours de route vaudrait un resultat.
 */
function cloreLaMancheDeRencontre(s: Salon): void {
  const rc = rencontreDuSalon(s.id);
  if (rc === undefined) return;
  const t = tournoi(rc.rencontre.tournoi);
  if (t === undefined) return;
  if (s.partie.raisonDeLaFin === "abandon") {
    annulerLaMancheDeRencontre(rc.rencontre, rc.n);
    return;
  }
  finirUneMancheDeRencontre(t, rc.rencontre, rc.n, s.partie.moves);
}

/**
 * Ce qu'un salon d'epreuve demande une fois ouvert, qu'il soit neuf ou relu du
 * registre : ses invites, sa diffusion, et la manche d'une partie finie pendant
 * que personne ne pouvait l'ecrire.
 */
function apresOuvertureDEpreuve(s: Salon): void {
  const e = s.epreuve!;
  const m = e.manche === null ? undefined : mancheParId(e.manche);
  if (m !== undefined) for (const n of m.equipe) s.invites.add(n);
  surveiller(s);
  if (m !== undefined && m.fin === null && s.partie.finie && s.partie.raisonDeLaFin !== "abandon") {
    finirLaManche(m.id, s.partie.moves, s.partie.cfg.jouables);
  }
  // Une manche lancee dont aucun tirage n'est parti -- le serveur s'est arrete
  // entre les deux -- est lancee quand meme : sa tentative est deja consommee.
  // Son premier coup s'ouvrira a l'arrivee d'un de ses joueurs.
  if (m !== undefined && m.fin === null && !s.partie.demarree) void s.partie.demarrer();
  // Personne n'y entrera peut-etre : il se referme alors comme un autre.
  rangerPlusTard(s.id);
}

/** Le message d'un refus de rejeu. */
function messageDeRefus(raison: string): string {
  if (raison === "inconnue") return "Cette partie n'existe pas";
  if (raison === "fichier") return "Cette partie n'est plus sur le disque";
  return "Cette partie s'ouvre une fois que vous l'avez jouée";
}

/**
 * UNE MANCHE RELUE, telle que la page de rejeu la lit.
 *
 * Elle emprunte la forme d'une partie archivee (SPEC.md §23) : la page de rejeu
 * est la meme, avec sa grille et ses solutions. Ce qui change, c'est d'ou vient
 * le journal, et qui a le droit de le lire.
 */
function mancheRelue(id: string, moi: Compte | undefined): Record<string, unknown> | string {
  const m = mancheParId(id);
  if (m === undefined || m.fin === null) return "inconnue";
  if (resultatsDeLaPartie(m.epreuve, m.partie, moi?.pseudo ?? null).details === null) return "interdit";
  const fichier = journalDuSalon(m.salon);
  const p = fichier === null ? null : relire(fichier);
  if (p === null) return "fichier";
  const t = tournoiDeLEpreuve(m.epreuve);
  const jour = lireLEpreuve(m.epreuve);
  const tops: Record<string, number> = {};
  for (const c of p.coups) if (c.player !== null) tops[c.player] = (tops[c.player] ?? 0) + 1;
  return {
    partie: p.partie, layout: p.layout, createdAt: p.createdAt, config: p.config,
    fin: p.fin, coups: p.coups,
    // Le titre de la page : la partie d'epreuve, et d'ou elle vient.
    titre: `P${m.partie} · ${nomDeLaPartie(p.config)}`,
    dou: t !== undefined ? t.nom : jour?.jour ?? "",
    manche: {
      ref: m.id, categorie: "", grille: p.config.bornes === 10 ? "super" : "normale",
      lexique: p.config.dictionnaire, chrono: p.config.chrono,
      at: m.fin.at, temps: m.fin.temps, cumul: m.fin.coups.reduce((a, c) => a + c.score, 0),
      topee: m.fin.negatif === 0, negatif: m.fin.negatif,
      joueurs: m.equipe.map((nom) => ({ nom, tops: tops[nom] ?? 0, invite: false })),
      solo: null,
    },
  };
}

/**
 * PREVIENT LES INSCRITS D'UN TOURNOI QUI VIENT DE COMMENCER (SPEC.md §29).
 *
 * La cle `debut:<id>` ne laisse passer qu'une notification par tournoi et par
 * compte, meme si le serveur redemarre entre deux battements. Un tournoi
 * commence depuis plus d'un jour ne previent plus personne : au premier
 * demarrage apres cette version, l'ancien n'a pas a sonner.
 */
function prevenirLesTournoisQuiCommencent(maintenant = Date.now()): void {
  for (const t of tousLesTournois()) {
    if (maintenant < t.debut || maintenant - t.debut > 86_400_000) continue;
    if (t.fin !== null && maintenant >= t.fin) continue;
    for (const i of t.inscrits) {
      for (const qui of [i.compte, ...i.partenaires]) {
        notifier(qui, "tournoi-debut", { tournoi: t.id, nom: t.nom }, `debut:${t.id}`);
      }
    }
  }
}

/**
 * RAPPELLE UNE RENCONTRE QUI N'A PAS ETE JOUEE (SPEC.md §29).
 *
 * La veille de la date limite, puis la veille de la date butoir. Sans ces deux
 * rappels, la butoir tombe sur des gens qui avaient seulement oublie, et
 * l'organisateur passe son temps a arbitrer.
 *
 * La cle porte la rencontre ET l'echeance : deux rappels par rencontre, jamais
 * trois, meme si le serveur redemarre dix fois entre les deux.
 */
function rappelerLesRencontres(maintenant = Date.now()): void {
  const VEILLE = 86_400_000;
  for (const t of tousLesTournois()) {
    if (t.type !== "battle") continue;
    for (const r of rencontresDuTournoi(t.id)) {
      if (r.fin !== null) continue;
      const dates = [
        ["limite", limiteDeLaRencontre(r)], ["butoir", butoirDeLaRencontre(r)],
      ] as const;
      for (const [quoi, quand] of dates) {
        if (maintenant < quand - VEILLE || maintenant >= quand) continue;
        for (const camp of r.camps) {
          for (const qui of joueursDuCamp(t, camp)) {
            notifier(qui, "tournoi-rappel", { tournoi: t.id, nom: t.nom, quoi },
              `rappel:${r.id}:${quoi}`);
          }
        }
      }
    }
  }
}

/**
 * QUI PEUT CREER UN TOURNOI (SPEC.md §29). Un seul endroit, a dessein : le jour
 * ou le tournoi de topping s'ouvre a tous, c'est cette ligne qui change.
 */
function peutCreerUnTournoi(c: Compte | undefined, type: "topping" | "battle"): boolean {
  if (c === undefined) return false;
  return type === "topping" ? c.admin : c.admin;
}

/** Un entier dans des bornes, ou `null` si ce n'en est pas un. */
function entierEntre(x: unknown, min: number, max: number): number | null {
  const n = Number(x);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Le nom et le lexique, communs aux deux formulaires. */
function lireLEnteteDuTournoi(c: any): { nom: string; lexique: string; equipe: number } | string {
  const nom = String(c.nom ?? "").trim().replace(/\s+/g, " ");
  if (nom.length < 3 || nom.length > 60) return "Le nom fait de 3 à 60 caractères";
  const lexique = String(c.lexique ?? "");
  if (!(LEXIQUES_DU_JOUR as readonly string[]).includes(lexique)) return "Choisissez un lexique";
  const equipe = entierEntre(c.equipe ?? 1, 1, 4);
  if (equipe === null) return "Une équipe compte de 1 à 4 joueurs";
  return { nom, lexique, equipe };
}

/**
 * Une partie de salon relue, pour le rejeu de l'historique (SPEC.md §30).
 *
 * Elle prend la forme d'une manche de records : c'est ce que la page de rejeu
 * attend, et une partie est une partie.
 */
function partieRelueDeLHistorique(id: string): Record<string, unknown> | string {
  const [salon, graine] = id.split("~");
  if (salon === undefined || graine === undefined) return "Cette partie n'existe pas";
  const h = partieDeLHistorique(salon, graine);
  if (h === undefined) return "Cette partie n'existe pas";
  const fichier = journalDeLaPartie(salon, graine);
  const p = fichier === null ? null : relire(fichier);
  if (p === null) return "Cette partie n'est plus sur le disque";
  return {
    partie: p.partie, layout: p.layout, createdAt: p.createdAt, config: p.config,
    fin: p.fin, coups: p.coups,
    titre: h.nomSalon,
    dou: nomDeLaPartie(p.config),
    manche: {
      ref: id, categorie: "", grille: p.config.bornes === 10 ? "super" : "normale",
      lexique: p.config.dictionnaire, chrono: p.config.chrono,
      at: h.at, temps: 0, cumul: p.coups.reduce((a, c) => a + c.score, 0),
      topee: false, negatif: 0,
      joueurs: h.joueurs.map((j) => ({ nom: j.nom, tops: j.tops, invite: j.invite })),
      solo: null,
    },
  };
}

/** Une liste de pseudos de comptes, verifiee un a un. */
function lireDesPseudos(x: unknown): string[] | string {
  if (!Array.isArray(x) || x.length === 0) return "Choisissez au moins un joueur";
  if (x.length > 40) return "Quarante joueurs au plus à la fois";
  const out: string[] = [];
  for (const brut of x) {
    const c = compte(String(brut ?? "").trim());
    if (c === undefined) return `Aucun compte ne s'appelle ${String(brut ?? "")}`;
    if (!out.includes(c.pseudo)) out.push(c.pseudo);
  }
  return out;
}

/** Ce qu'un defi montre a tout le monde. */
function defiPublic(d: Defi) {
  return { id: d.id, nom: d.nom, config: d.config, par: d.par, at: d.at };
}

/**
 * LES LIGNES DES JOUEURS D'ORIGINE d'un defi (SPEC.md §29).
 *
 * Une partie de topping n'en fait QU'UNE, meme a plusieurs : celui qui tape le
 * premier prend le top et les autres n'ont pas eu le temps d'ecrire, si bien
 * qu'une performance separee ne voudrait rien dire. Le duplicate fait
 * exception -- chacun y marque son propre score sur chaque coup.
 */
function lignesDOrigine(s: Salon): { equipe: string[]; jeu: Jeu; bilan: FinDeManche }[] {
  const noms = lignesDesJoueurs(s.partie.moves, (n) => compte(n) !== undefined).map((l) => l.nom);
  if (noms.length === 0) return [];
  const jouables = s.partie.cfg.jouables;
  if (s.partie.cfg.mode === "duplicate") {
    return noms.map((nom) => ({
      equipe: [nom], jeu: "seul" as Jeu,
      bilan: bilanDeLaManche({ equipe: [nom] }, s.partie.moves, jouables),
    }));
  }
  return [{
    equipe: noms, jeu: (noms.length > 1 ? "equipe" : "seul") as Jeu,
    bilan: bilanDeLaManche({ equipe: noms }, s.partie.moves, jouables),
  }];
}

/** Une liste de consignes de partie, verifiee une a une. */
function lireDesConsignes(x: unknown, max: number): ConsigneDePartie[] | string {
  if (!Array.isArray(x) || x.length < 1 || x.length > max) return `de 1 à ${max} parties`;
  const out: ConsigneDePartie[] = [];
  for (const [i, brut] of x.entries()) {
    const c = consigneRecevable(brut);
    if (typeof c === "string") return `P${i + 1} : ${c}`;
    out.push(c);
  }
  return out;
}

/** Le formulaire d'un tournoi de la semaine, verifie champ par champ. */
function lireUnModeleHebdo(c: any): {
  id?: string; nom: string; lexique: string; equipe: number;
  jourDebut: number; jourFin: number; consignes: ConsigneDePartie[]; actif: boolean;
} | string {
  const entete = lireLEnteteDuTournoi(c);
  if (typeof entete === "string") return entete;
  const jourDebut = entierEntre(c.jourDebut, 0, 6), jourFin = entierEntre(c.jourFin, 0, 6);
  if (jourDebut === null || jourFin === null) return "Donnez le jour de début et le jour de fin";
  const consignes = lireDesConsignes(c.parties, 10);
  if (typeof consignes === "string") return consignes;
  return {
    ...(typeof c.id === "string" && c.id !== "" ? { id: c.id } : {}),
    ...entete, jourDebut, jourFin, consignes, actif: c.actif !== false,
  };
}

/** Le formulaire du tournoi de topping, verifie champ par champ. */
function lireUnTournoiDeTopping(c: any): {
  nom: string; lexique: string; debut: number; fin: number; equipe: number; modeles: ModeleDePartie[];
} | string {
  const entete = lireLEnteteDuTournoi(c);
  if (typeof entete === "string") return entete;
  const debut = instantDeParis(c.debut), fin = instantDeParis(c.fin);
  if (debut === null || fin === null) return "Donnez une date de début et une date de fin";
  if (fin <= debut) return "La fin vient après le début";
  if (fin <= Date.now()) return "La fin est déjà passée";
  // LES PARTIES ARRIVENT EN CONSIGNES (SPEC.md §29) : l'editeur est le meme
  // partout, et ce qu'il laisse au sort se tire ici, une fois pour toutes.
  const consignes = lireDesConsignes(c.parties, 10);
  if (typeof consignes === "string") return consignes;
  return { ...entete, debut, fin, modeles: consignes.map((x) => tirerUneConsigne(x)) };
}

/** Le formulaire du tournoi de battle, verifie champ par champ. */
/**
 * QUI REGLE UN BATTLE, ET JUSQU'A QUAND : son createur ou l'administration,
 * tant que les poules ne sont pas tirees (SPEC.md §29).
 */
function battleReglable(t: Tournoi, moi: Compte): string | null {
  if (t.type !== "battle") return "Ce tournoi n'est pas un tournoi de battle";
  if (t.par !== moi.pseudo && !moi.admin) return "Seul son créateur règle ce tournoi";
  if (phaseDuBattle(t) !== "inscriptions") return "Les poules sont déjà tirées";
  return null;
}

/**
 * LIT UNE COMPOSITION DE POULES venue du client.
 *
 * Tout le monde doit y figurer une fois et une seule : une main qui deplace les
 * joueurs d'une poule a l'autre peut en oublier un, et le tournoi partirait
 * alors sans lui.
 */
function lireDesPoules(brut: unknown, t: Tournoi): string[][] | string {
  if (!Array.isArray(brut) || brut.length === 0) return "Il faut au moins une poule";
  const vus = new Set<string>();
  const lues: string[][] = [];
  for (const p of brut) {
    if (!Array.isArray(p)) return "poule illisible";
    const camps: string[] = [];
    for (const c of p) {
      const camp = String(c);
      if (!t.inscrits.some((i) => i.compte === camp)) return `${camp} n'est pas inscrit`;
      if (vus.has(camp)) return `${camp} figure dans deux poules`;
      vus.add(camp);
      camps.push(camp);
    }
    if (camps.length < 2) return "Une poule compte au moins deux joueurs";
    lues.push(camps);
  }
  if (vus.size !== t.inscrits.length) return "Tous les inscrits ne sont pas placés";
  return lues;
}

/**
 * LES SEULS REGLAGES QUE LA VALIDATION DES POULES CONSOMME.
 *
 * Ceux du tableau (meilleur de X, demi, finale) restent ouverts jusqu'au geste
 * suivant, et la partie d'une manche ne bouge plus du tout.
 */
function lireLesReglagesDePoule(c: any, t: Tournoi): Partial<ReglagesBattle> | string {
  const b = t.battle;
  if (b === null) return "Ce tournoi n'est pas un tournoi de battle";
  const impair = (x: unknown): number | null => {
    const n = entierEntre(x, 1, 9);
    return n !== null && n % 2 === 1 ? n : null;
  };
  const joueursParPoule = entierEntre(c.joueursParPoule ?? b.joueursParPoule, 2, 32);
  if (joueursParPoule === null) return "Une poule compte de 2 à 32 joueurs";
  const manchesParPoule = impair(c.manchesParPoule ?? b.manchesParPoule);
  if (manchesParPoule === null) {
    return "Une rencontre de poule se joue en un nombre impair de manches, de 1 à 9";
  }
  const rencontresParPoule = c.rencontresParPoule === null || c.rencontresParPoule === undefined
    ? null : entierEntre(c.rencontresParPoule, 1, 31);
  if (c.rencontresParPoule != null && rencontresParPoule === null) {
    return "Rencontres par poule : de 1 à 31";
  }
  const qualifies = c.qualifies === null || c.qualifies === undefined
    ? null : entierEntre(c.qualifies, 2, 256);
  if (c.qualifies != null && qualifies === null) return "Il faut au moins 2 qualifiés";
  const tableauHaut = c.tableauHaut === null || c.tableauHaut === undefined
    ? null : entierEntre(c.tableauHaut, 1, 256);
  if (c.tableauHaut != null && (tableauHaut === null || (qualifies !== null && tableauHaut > qualifies))) {
    return "Le tableau haut ne compte pas plus de joueurs que les qualifiés";
  }
  const limite = instantDeParis(c.limitePoules) ?? b.limitePoules;
  if (limite <= Date.now()) return "La date limite des poules est déjà passée";
  const joursParTour = entierEntre(c.joursParTour ?? b.joursParTour, 1, 30);
  if (joursParTour === null) return "Un tour de tableau dure de 1 à 30 jours";
  return {
    joueursParPoule, manchesParPoule, rencontresParPoule, qualifies, tableauHaut,
    limitePoules: limite, joursParTour,
  };
}

/**
 * QUI VALIDE LE TABLEAU : son createur ou l'administration, une fois les poules
 * lancees et tant que le tableau ne l'est pas (SPEC.md §29).
 */
function tableauReglable(t: Tournoi, moi: Compte): string | null {
  if (t.type !== "battle") return "Ce tournoi n'est pas un tournoi de battle";
  if (t.par !== moi.pseudo && !moi.admin) return "Seul son créateur règle ce tournoi";
  const phase = phaseDuBattle(t);
  if (phase === "inscriptions") return "Les poules ne sont pas encore tirées";
  if (phase !== "poules") return "Le tableau est déjà lancé";
  return null;
}

/**
 * LES SEULS REGLAGES QUE LA VALIDATION DU TABLEAU CONSOMME.
 *
 * Les poules sont derriere nous ; ce qui reste ouvert, c'est le meilleur de X
 * par phase et la duree d'un tour.
 */
function lireLesReglagesDeTableau(c: any, t: Tournoi): Partial<ReglagesBattle> | string {
  const b = t.battle;
  if (b === null) return "Ce tournoi n'est pas un tournoi de battle";
  const impair = (x: unknown): number | null => {
    const n = entierEntre(x, 1, 9);
    return n !== null && n % 2 === 1 ? n : null;
  };
  const meilleurDe = impair(c.meilleurDe ?? b.meilleurDe);
  const meilleurDeDemi = impair(c.meilleurDeDemi ?? b.meilleurDeDemi);
  const meilleurDeFinale = impair(c.meilleurDeFinale ?? b.meilleurDeFinale);
  if (meilleurDe === null || meilleurDeDemi === null || meilleurDeFinale === null) {
    return "Une rencontre de tableau se joue au meilleur d'un nombre impair de manches";
  }
  const qualifies = c.qualifies === null || c.qualifies === undefined
    ? b.qualifies : entierEntre(c.qualifies, 2, 256);
  if (c.qualifies != null && qualifies === null) return "Il faut au moins 2 qualifiés";
  const tableauHaut = c.tableauHaut === null || c.tableauHaut === undefined
    ? b.tableauHaut : entierEntre(c.tableauHaut, 1, 256);
  if (c.tableauHaut != null && tableauHaut === null) return "Le tableau haut compte au moins un joueur";
  if (tableauHaut !== null && qualifies !== null && tableauHaut > qualifies) {
    return "Le tableau haut ne compte pas plus de joueurs que les qualifiés";
  }
  const joursParTour = entierEntre(c.joursParTour ?? b.joursParTour, 1, 30);
  if (joursParTour === null) return "Un tour de tableau dure de 1 à 30 jours";
  return { meilleurDe, meilleurDeDemi, meilleurDeFinale, qualifies, tableauHaut, joursParTour };
}

/**
 * CE QUE LA PAGE D'UN TOURNOI DE BATTLE MONTRE (SPEC.md §29).
 *
 * Elle est publique : les poules, leurs classements et les rencontres se lisent
 * sans compte. Ce qui ne l'est pas, ce sont LES MESSAGES : ils n'appartiennent
 * qu'aux deux camps d'une rencontre, et a l'arbitre.
 */
function vueDuBattle(t: Tournoi, moi: Compte | undefined): Record<string, unknown> | null {
  if (t.type !== "battle") return null;
  const lesPoules = poulesDuTournoi(t.id) ?? [];
  const toutes = rencontresDuTournoi(t.id);
  const arbitre = moi !== undefined && (t.par === moi.pseudo || moi.admin);
  const mienne = (r: Rencontre): boolean =>
    moi !== undefined && campDuCompte(t, r, moi.pseudo) >= 0;
  return {
    phase: phaseDuBattle(t),
    entete: enteteDuTournoi(t.id),
    camps: t.inscrits.map((i) => ({
      camp: i.compte, nom: i.noms.trim() !== "" ? i.noms.trim() : i.compte,
      joueurs: [i.compte, ...i.partenaires],
    })),
    poules: lesPoules.map((p, i) => ({
      n: i + 1, camps: p, classement: classementDeLaPoule(t, i),
      tours: toutes.reduce((a, r) => r.phase === `poule:${i}` ? Math.max(a, r.tour) : a, 0),
    })),
    rencontres: toutes.map((r) => ({
      id: r.id, phase: r.phase, tour: r.tour, camps: r.camps, bo: r.bo,
      // LES DATES EFFECTIVES : une heure imposée remplace celle de son tour.
      limite: limiteDeLaRencontre(r), butoir: butoirDeLaRencontre(r),
      imposee: dateImposeeDe(r.tournoi, r.phase) ?? null,
      fin: r.fin,
      manches: r.manches.map((m) => ({
        n: m.n, salon: m.salon, points: m.points, gagnant: m.gagnant, fin: m.fin,
        // UNE MANCHE EN COURS SE REGARDE : la page la montre comme telle, et
        // seul un salon vivant peut s'ouvrir.
        ouverte: m.fin === null && salon(m.salon) !== undefined,
      })),
      messages: arbitre || mienne(r) ? messagesDeLaRencontre(r.id) : [],
      moi: mienne(r),
    })),
    poulesFinies: poulesFinies(t),
    tableau: tableauDuTournoi(t.id) ?? null,
    // LES HEURES IMPOSEES, par phase. Vide tant qu'aucune ne l'est.
    dates: datesImposeesDe(t.id),
    finale: finaleDuTournoi(t)?.id ?? null,
    classement: classementFinalDuBattle(t),
    moi: moi === undefined ? null : {
      camp: inscriptionDe(t, moi.pseudo)?.compte ?? null,
      dispos: disposDe(t.id, moi.pseudo),
      arbitre,
    },
    dispos: Object.fromEntries(t.inscrits.map((i) => [i.compte, disposDe(t.id, i.compte)])),
  };
}

function lireUnTournoiDeBattle(c: any, neuf = true): {
  nom: string; lexique: string; debut: number; equipe: number; battle: ReglagesBattle;
} | string {
  const entete = lireLEnteteDuTournoi(c);
  if (typeof entete === "string") return entete;
  const debut = instantDeParis(c.debut);
  if (debut === null) return "Donnez la date de début des rencontres";
  // UN BATTLE DEJA COMMENCE SE MODIFIE ENCORE (SPEC.md §29) : ce sont les
  // poules qui ferment ses reglages. Sa date de debut est alors derriere nous,
  // et la refuser rendrait le formulaire inutilisable.
  if (neuf && debut <= Date.now()) return "Le début des rencontres est déjà passé";
  const limite = instantDeParis(c.limitePoules);
  if (limite === null || limite <= debut) return "La date limite des poules vient après le début";
  const impair = (x: unknown): number | null => {
    const n = entierEntre(x, 1, 9);
    return n !== null && n % 2 === 1 ? n : null;
  };
  const joueursParPoule = entierEntre(c.joueursParPoule ?? 4, 3, 12);
  const manchesParPoule = impair(c.manchesParPoule ?? 3);
  const rencontresParPoule = c.rencontresParPoule === null || c.rencontresParPoule === undefined
    ? null : entierEntre(c.rencontresParPoule, 1, 11);
  const qualifies = c.qualifies === null || c.qualifies === undefined ? null : entierEntre(c.qualifies, 2, 256);
  const tableauHaut = c.tableauHaut === null || c.tableauHaut === undefined ? null : entierEntre(c.tableauHaut, 1, 256);
  const meilleurDe = impair(c.meilleurDe ?? 3);
  const meilleurDeDemi = impair(c.meilleurDeDemi ?? c.meilleurDe ?? 3);
  const meilleurDeFinale = impair(c.meilleurDeFinale ?? c.meilleurDe ?? 3);
  const joursParTour = entierEntre(c.joursParTour ?? 3, 1, 30);
  if (joueursParPoule === null) return "Une poule compte de 3 à 12 joueurs";
  if (manchesParPoule === null) {
    return "Une rencontre de poule se joue en un nombre impair de manches, de 1 à 9";
  }
  if (c.rencontresParPoule != null && rencontresParPoule === null) return "Rencontres par poule : de 1 à 11";
  if (c.qualifies != null && qualifies === null) return "Il faut au moins 2 qualifiés";
  if (c.tableauHaut != null && (tableauHaut === null || (qualifies !== null && tableauHaut > qualifies))) {
    return "Le tableau haut ne compte pas plus de joueurs que les qualifiés";
  }
  if (meilleurDe === null || meilleurDeDemi === null || meilleurDeFinale === null) {
    return "Une rencontre de tableau se joue au meilleur d'un nombre impair de manches";
  }
  if (joursParTour === null) return "Un tour de tableau dure de 1 à 30 jours";
  const consigne = consigneRecevable(c.partie);
  if (typeof consigne === "string") return `Partie d'une manche : ${consigne}`;
  const partie = tirerUneConsigne(consigne);
  return {
    ...entete, debut,
    battle: {
      joueursParPoule, rencontresParPoule, manchesParPoule, qualifies, tableauHaut,
      meilleurDe, meilleurDeDemi, meilleurDeFinale, partie, limitePoules: limite, joursParTour,
    },
  };
}

/**
 * Relance la partie du salon, et remet tout le monde dedans.
 *
 * Trois chemins y menent maintenant -- les reglages valides, l'etape suivante
 * d'une montante, la reprise d'une etape ratee -- et ils doivent faire
 * exactement la meme chose : rebrancher l'observation, rendre a la partie neuve
 * la liste des presents, la reveiller, la demarrer, et renvoyer a chaque client
 * de quoi tout redessiner.
 */
async function relancerEtDiffuser(s: Salon, cfg: ConfigPartie): Promise<string[]> {
  // UNE PARTIE RELANCEE EN PLEIN MILIEU NE PASSE PAS PAR `onFin` : son
  // historique s'ecrit ici, avant qu'elle ne soit archivee.
  ecrireLHistoriqueDuSalon(s, "relance");
  const archives = await relancer(s, cfg);
  surveiller(s);
  // La partie neuve nait endormie ET ignorante de qui est la : on lui rend les
  // deux, sinon le duplicate ne compterait personne sur son premier coup.
  for (const nom of occupants(s.id)) s.partie.presents.add(nom);
  if (occupants(s.id).length > 0) await s.partie.reveiller();
  await s.partie.demarrer();
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
  return archives;
}

/**
 * L'etape d'une montante vient de se terminer.
 *
 * ELLE NE PASSE PAS A LA SUIVANTE ICI : c'est l'hote qui lance la suite. Ce qui
 * se decide a cet instant, c'est seulement si la montante est finie -- les six
 * etapes derriere elle, et plus rien a reprendre.
 */
function cloreLEtapeDeLaMontante(s: Salon, e: EtapeObservee): void {
  const m = s.montante;
  if (m === null) return;
  // Vue AVANT `cloreLEtape`, qui peut cocher la pause toute seule sur un rate
  // au dernier coup (SPEC.md §23) : c'est ce qui distingue une pause qui vient
  // de s'activer d'une pause que l'hote avait deja allumee.
  const pauseAvant = m.pause;
  cloreLEtape(m, e);
  console.log(`[montante] "${s.nom}" etape ${m.rang} (essai ${m.essai}) : `
    + `${e.coups} coups, ${(e.temps / 1000).toFixed(2)} s, `
    + `${e.rates === 0 ? "topee" : `${e.rates} rate(s), negatif ${e.negatif}`}`
    + `${!pauseAvant && m.pause ? " (pause activee automatiquement)" : ""}`);
  if (montanteFinieDElleMeme(m)) { acheverLaMontante(s); return; }
  // LA SIXIEME NE S'ENCHAINE PAS. Il n'y a rien apres elle : la montante
  // s'arrete, sa derniere grille reste a l'ecran, et l'hote choisit -- reprendre
  // cette etape s'il en a le droit, ou clore la suite.
  if (!ilResteUneEtape(m)) return;
  enchainerLEtapeSuivante(s);
}

/**
 * L'ETAPE SUIVANTE PART D'ELLE-MEME. C'est une montante : on ne reprend pas son
 * souffle entre deux parties.
 *
 * Sauf si l'hote a demande une pause -- c'est alors lui qui lance la suite, et
 * c'est le seul moyen de revoir les coups d'une etape qu'on vient de finir.
 *
 * LE MINUTEUR VERIFIE TOUT A NOUVEAU EN SE DECLENCHANT. Deux secondes suffisent
 * a ce que l'hote allume la pause, reprenne l'etape, valide d'autres reglages ou
 * ferme le salon : la montante qu'il retrouve peut n'etre plus la meme.
 */
function enchainerLEtapeSuivante(s: Salon): void {
  const m = s.montante;
  if (m === null || m.pause || !m.close || !ilResteUneEtape(m)) return;
  setTimeout(() => {
    void (async () => {
      // LE MEME SALON, ET LA MEME MONTANTE DANS LE MEME ETAT : sinon ce
      // minuteur n'a plus rien a lancer. Deux secondes suffisent a fermer le
      // salon, et relancer une partie dans un salon ferme rouvrirait des
      // fichiers qu'on vient de retirer.
      if (salon(s.id) !== s) return;
      if (s.montante !== m || m.pause || !m.close || !ilResteUneEtape(m)) return;
      const rang = passerALEtapeSuivante(m);
      if (rang === null) return;
      await relancerEtDiffuser(s, configDeLEtape(s.partie.cfg, rang));
      console.log(`[montante] "${s.nom}" enchaine l'etape ${rang} `
        + `(${etapeMontante(rang).nom})`);
    })();
  }, DELAI_ENTRE_ETAPES_MS);
}

/**
 * La montante se termine : sa ligne part au journal si elle en merite une.
 *
 * UNE LIGNE POUR LA MONTANTE, ET UNE PAR ETAPE (SPEC.md §23). Les six lignes
 * d'etape sont deja parties, chacune a la fin de sa partie ; celle-ci est la
 * septieme, et porte les cumuls.
 */
function acheverLaMontante(s: Salon): void {
  const m = s.montante;
  if (m === null || !montanteAchevable(m)) return;
  m.finie = true;
  const ligne = mancheDeLaMontante(m, s.partie.cfg);
  if (ligne === null) {
    console.log(`[montante] "${s.nom}" achevee, hors tableau `
      + `(${m.essais.length} essai(s) sur ${m.rang} etape(s))`);
    return;
  }
  ajouterUneManche(ligne);
  const qui = ligne.joueurs.map((j) => j.invite ? `${j.nom} (invité)` : j.nom);
  console.log(
    `[records] montante · ${ligne.coups} coups en ${(ligne.temps / 1000).toFixed(2)} s · `
    + `${ligne.topee ? "topée" : `négatif ${ligne.negatif}`} · ${qui.join(", ") || "personne"}`,
  );
}

// ---------------------------------------------------------------- ouverture

/**
 * Les parties sont-elles pretes ?
 *
 * Ouvrir une partie demande de calculer le top de son coup courant, ce qui peut
 * prendre des MINUTES sur une grande grille a gros tirage. Faire attendre le
 * site pendant ce temps donnait un serveur injoignable, sans rien qui explique
 * pourquoi. On sert donc la page d'abord, et on prepare ensuite.
 */
let pret = false;

async function ouvrirLesSalons(): Promise<void> {
  const t0 = Date.now();
  let salonMondial;
  try {
    salonMondial = await ouvrirSalon({
      id: GAME_ID, nom: "Topping infini", proprietaire: null, prive: false,
      layout: LAYOUT, cfg: CFG_MONDIALE, nouveau: false,
    });
  } catch (e) {
    // Un echec sur la grille principale doit se lire, pas se deverser en trace
    // d'appels. C'est presque toujours un verrou, et le message dit quoi faire.
    console.error(`
  ${(e as Error).message}
`);
    process.exit(1);
  }
  surveiller(salonMondial);
  // UNE GRILLE PERMANENTE DEJA JOUEE REPART D'OFFICE : personne ne la regle, et
  // ses milliers de coups n'attendent l'autorisation de personne. Une grille
  // permanente NEUVE, elle, attend qu'un administrateur la lance -- c'est le
  // jour du lancement, et le premier tirage doit tomber devant du monde.
  if (salonMondial.partie.moves.length > 0) salonMondial.partie.demarree = true;

  // La grille permanente anglaise, jumelle de la francaise. Elle ne se voit
  // qu'en anglais, ou sous « Tout afficher ».
  try {
    const salonAnglais = await ouvrirSalon({
      id: GAME_ID_EN, nom: NOM_MONDIALE_EN, proprietaire: null, prive: false,
      layout: LAYOUT, cfg: cfgMondialeAnglaise(), nouveau: false,
    });
    surveiller(salonAnglais);
    if (salonAnglais.partie.moves.length > 0) salonAnglais.partie.demarree = true;
  } catch (e) {
    // Elle n'est pas vitale : si son verrou traine, le site tourne sans elle.
    console.error(`[salon] grille permanente anglaise indisponible : ${(e as Error).message}`);
  }

  // Les salons crees lors des sessions precedentes reprennent ou ils en etaient.
  for (const e of salonsEnregistres()) {
    if (e["id"] === GAME_ID || e["id"] === GAME_ID_EN) continue;
    // UN SALON D'EPREUVE RETROUVE SA PARTIE FIGEE ET SA MANCHE : le registre ne
    // porte que ce qui ne change pas, la manche vit au journal du competitif.
    if (e["epreuve"] !== undefined) {
      try {
        const ep = e["epreuve"] as { epreuve: string; partie: number; figee: string; compte: string };
        const figee = partieFigee(ep.figee);
        if (figee === null) throw new Error("partie figée introuvable");
        const s = await ouvrirSalon({
          id: e["id"], nom: e["nom"] ?? e["id"], proprietaire: e["proprietaire"] ?? ep.compte,
          prive: true, layout: (e["layout"] ?? LAYOUT) as LayoutName,
          cfg: deserialiser(figee.config), nouveau: false, creeLe: e["creeLe"],
          epreuve: { ...ep, manche: mancheDuSalon(e["id"])?.id ?? null }, figee,
        });
        apresOuvertureDEpreuve(s);
      } catch (err) {
        console.warn(`[salon] "${e["id"]}" non rouvert : ${(err as Error).message}`);
      }
      continue;
    }
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
  // --rouvrir : une partie du disque reprend sa place DANS UN SALON, et non a
  // celle de la grille permanente. C'est ce qu'on veut presque toujours quand on
  // revient sur une ancienne partie : la revoir sans deloger le jeu du site.
  // Elle s'inscrit au registre, donc une seule fois suffit.
  for (const id of ROUVRIR) {
    if (tousLesSalons().some((s) => s.id === id)) {
      console.log(`[salon] "${id}" etait deja au registre, rien a rouvrir`);
      continue;
    }
    if (Game.configEnregistree(id) === null) {
      console.warn(`[salon] "${id}" introuvable sur le disque -- voir npm run parties`);
      continue;
    }
    try {
      const s = await ouvrirSalon({
        id, nom: joliNom(id), proprietaire: PROPRIETAIRE, prive: false,
        layout: LAYOUT, cfg: configParDefaut(), nouveau: true,
      });
      surveiller(s);
      console.log(`[salon] "${s.nom}" (${id}) rouvert : ${s.partie.moves.length} coups`);
    } catch (err) {
      console.warn(`[salon] "${id}" non rouvert : ${(err as Error).message}`);
    }
  }

  // UN 15x15 VIDE NE PASSE PAS LA NUIT. La regle vaut au depart du dernier
  // joueur ; encore faut-il qu'elle s'applique aussi aux salons que le serveur
  // vient de rouvrir du registre, qui n'ont eux jamais eu de depart a observer.
  // Sans cela, la seance d'hier laissait sa liste de salons morts a celle d'
  // aujourd'hui.
  for (const s of tousLesSalons()) {
    if (s.proprietaire !== null && s.partie.cfg.bornes !== null) rangerPlusTard(s.id);
  }

  pret = true;
  const n = tousLesSalons().length;
  console.log(`  ${n} salon${n > 1 ? "s" : ""} pret${n > 1 ? "s" : ""} ` +
    `en ${((Date.now() - t0) / 1000).toFixed(1)} s
`);
}

// ---------------------------------------------------------------- http

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".bin": "application/octet-stream",
  // Sans ce type-la, le navigateur REFUSE de peindre un SVG en fond de page :
  // les vignettes de l'accueil restaient vides sans que rien ne le dise.
  ".svg": "image/svg+xml; charset=utf-8",
};

/**
 * La variante de la grille permanente anglaise.
 *
 * La meme que la francaise -- grille sans bord, sac du jeu classique qui se
 * recharge -- avec son lexique a elle : le CSW 24, l'international
 * anglophone, plutot que l'EEL 22 par defaut d'un salon anglais ordinaire --
 * « The Infinite Grid » vise le meme public que la grille permanente
 * francaise, des joueurs confirmes. Une partie deja commencee garde la
 * sienne : `ouvrirSalon` relit celle du journal avant celle-ci.
 */
function cfgMondialeAnglaise(): ConfigPartie {
  return avec(avecDictionnaire(configParDefaut(), "csw24"), {
    bornes: null, pioche: "sac102boucle", chrono: null,
  });
}

/**
 * La partie qu'on trouve en entrant dans un salon neuf.
 *
 * Grille bornee : le plateau du commerce et son sac de 102, c'est-a-dire une
 * partie que tout le monde reconnait. Grille infinie : les probabilites
 * ponderees, qui ne s'epuisent jamais.
 */
function configDeDepart(infinie: boolean, langue: Langue = "fr") {
  // Le lexique suit la langue de celui qui ouvre le salon : venu de la version
  // anglaise, on n'ouvre pas une partie en francais.
  const base = avecDictionnaire(configParDefaut(), DICO_PAR_LANGUE[langue]);
  return infinie
    ? avec(base, { bornes: null, pioche: "probabilites" })
    // UN SALON NEUF EST UN BLITZ. Sans chrono, un salon ouvert reste sur son
    // premier coup jusqu'a ce que quelqu'un trouve le top -- ce qui peut durer
    // longtemps si personne ne le voit. Soixante secondes, c'est le rythme
    // auquel on joue a plusieurs, et cela se change en deux clics.
    : avec(base, {
        bornes: 7, pioche: "sac102", chrono: 60,
        pavage: LAYOUTS.classique15, pavageNom: "classique15",
      });
}

/**
 * Un identifiant de salon libre : on suffixe tant que le nom est pris, par un
 * salon ouvert OU par une partie deja sur le disque.
 */
function identifiantLibre(nom: string): string {
  let id = slug(nom);
  let n = 2;
  while (identifiantPris(id)) id = `${slug(nom)}-${n++}`;
  return id;
}

function json(res: ServerResponse, code: number, corps: unknown): void {
  const s = JSON.stringify(corps);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

/**
 * DERRIERE CLOUDFLARE, LE SERVEUR NE VOIT QUE DU http.
 *
 * C'est le tunnel qui termine le TLS et qui l'annonce dans `x-forwarded-proto`.
 * Sans lire cet en-tete, le cookie ne porterait jamais `Secure` en ligne.
 */
function sousHttps(req: IncomingMessage): boolean {
  const dit = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim();
  return dit === "https";
}

/** Le compte de celui qui parle, lu dans son cookie. */
function quiParle(req: IncomingMessage): Compte | undefined {
  return compteDuJeton(jetonDesEntetes(req.headers.cookie));
}

/**
 * UN SEAU PAR ADRESSE POUR LES MOTS DE PASSE.
 *
 * Six essais d'affilee, puis un toutes les deux secondes. La rafale est pour
 * l'humain qui retape son mot de passe deux ou trois fois ; la moyenne est
 * contre le script, a qui elle ne laisse que dix-huit cents essais par heure --
 * pour un hachage qui coute deja cent millisecondes au serveur, et un sel
 * different par compte.
 */
const essais = new Map<string, Seau>();
function tropDEssais(req: IncomingMessage): boolean {
  const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
  let seau = essais.get(ip);
  if (seau === undefined) { seau = seauDeRafale(0.5, 6); essais.set(ip, seau); }
  // La table ne peut pas grossir sans fin : au-dela d'un millier d'adresses on
  // la vide, les seaux se reconstituent d'eux-memes.
  if (essais.size > 1000) essais.clear();
  return !seau.prendre();
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

/**
 * Les parametres de la requete. `url` a deja perdu sa partie interrogative,
 * qui est justement ce que les tableaux de records lisent.
 */
function parametres(req: IncomingMessage): URLSearchParams {
  const q = (req.url ?? "").indexOf("?");
  return new URLSearchParams(q === -1 ? "" : (req.url ?? "").slice(q + 1));
}

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url ?? "/").split("?")[0]!;

  // -------------------------------------------------------------- les records
  //
  // TROIS POINTS D'ENTREE, ET AUCUN N'OUVRE UN FICHIER DE PARTIE (SPEC.md §23).
  // Tout se lit dans le journal des records, relu en memoire au demarrage. Ils
  // sont PUBLICS : un tableau de records se consulte sans compte et sans etre
  // dans un salon.
  if (url === "/api/records" && req.method === "GET") {
    const p = parametres(req);
    const cat = p.get("categorie") ?? "normale";
    if (categorie(cat) === undefined) { json(res, 404, { message: "catégorie inconnue" }); return; }
    json(res, 200, tableau({
      categorie: cat,
      grille: p.get("grille") === "super" ? "super"
        : p.get("grille") === "normale" ? "normale" : undefined,
      lexique: dictionnaireConnu(p.get("lexique")) ? p.get("lexique")! : undefined,
      solo: p.get("solo") === "1",
    }));
    return;
  }

  if (url === "/api/records/annexe" && req.method === "GET") {
    const p = parametres(req);
    const cat = p.get("categorie") ?? "normale";
    if (categorie(cat) === undefined) { json(res, 404, { message: "catégorie inconnue" }); return; }
    const filtre = {
      categorie: cat,
      grille: p.get("grille") === "super" ? "super" as const
        : p.get("grille") === "normale" ? "normale" as const : undefined,
      lexique: dictionnaireConnu(p.get("lexique")) ? p.get("lexique")! : undefined,
    };
    const quoi = p.get("quoi") ?? "chrono";
    // Le coup le plus cher et le moins cher classent des COUPS, pas des
    // parties : ils n'ont pas les memes colonnes, et se demandent donc a part.
    if (quoi === "cher" || quoi === "pasCher") {
      json(res, 200, { coups: coupsExtremes(filtre, quoi) });
      return;
    }
    if (!ANNEXES.includes(quoi as Annexe)) {
      json(res, 404, { message: "tableau inconnu" });
      return;
    }
    json(res, 200, { lignes: annexe(quoi as Annexe, filtre) });
    return;
  }

  // UNE PARTIE ARCHIVEE, EN LECTURE SEULE (SPEC.md §23).
  //
  // On ne sert QUE les parties citees au journal des records. Servir un journal
  // quelconque par son nom donnerait le moyen de lire une partie EN COURS,
  // donc le top que tout le monde cherche.
  if (url.startsWith("/api/partie/") && req.method === "GET") {
    const id = decodeURIComponent(url.slice("/api/partie/".length));
    const m = mancheDe(id);
    if (m === undefined) { json(res, 404, { message: "Cette partie n'est pas au tableau" }); return; }
    const fichier = journalDeLaPartie(m.partie, m.graine);
    if (fichier === null) {
      json(res, 404, { message: "Cette partie n'est plus sur le disque" });
      return;
    }
    const p = relire(fichier);
    if (p === null) { json(res, 404, { message: "Journal illisible" }); return; }
    // La graine ne sort pas : elle dirait comment refaire les tirages.
    json(res, 200, {
      partie: p.partie, layout: p.layout, createdAt: p.createdAt, config: p.config,
      fin: p.fin, coups: p.coups,
      manche: {
        // LA REFERENCE SORT, LA GRAINE NON. La premiere designe la manche dans
        // une adresse ; la seconde dirait comment refaire ses tirages.
        ref: m.ref,
        categorie: m.categorie, grille: m.grille, lexique: m.lexique,
        chrono: m.chrono, at: m.at, temps: m.temps, cumul: m.cumul,
        topee: m.topee, negatif: m.negatif, joueurs: m.joueurs, solo: m.solo,
      },
    });
    return;
  }

  // LES PALIERS D'UN COUP D'UNE PARTIE ARCHIVEE. Toutes les solutions du coup,
  // refaites a la demande sur un fil de solveur partage (SPEC.md §23).
  if (url.startsWith("/api/paliers/") && req.method === "GET") {
    const reste = url.slice("/api/paliers/".length).split("/");
    const id = decodeURIComponent(reste[0] ?? "");
    const n = Number(reste[1]);
    const m = mancheDe(id);
    if (m === undefined || !Number.isInteger(n)) {
      json(res, 404, { message: "Cette partie n'est pas au tableau" });
      return;
    }
    const fichier = journalDeLaPartie(m.partie, m.graine);
    if (fichier === null) { json(res, 404, { message: "Partie introuvable" }); return; }
    const p = relireEtGarder(fichier);
    if (p === null) { json(res, 404, { message: "Journal illisible" }); return; }
    json(res, 200, { n, paliers: await paliersDuCoup(p, n) });
    return;
  }

  if (url === "/api/records/mots" && req.method === "GET") {
    const p = parametres(req);
    // « Tous » additionne les compteurs de toutes les listes : le meme mot y
    // vit souvent deux fois, et il n'y a qu'un mot a classer (SPEC.md §23).
    const confondus = p.get("lexique") === LEXIQUE_TOUS;
    const lexique = dictionnaireConnu(p.get("lexique")) ? p.get("lexique")! : DICO_PAR_DEFAUT;
    // WU et QI ne se comptent que dans le lexique officiel du jeu francophone :
    // « WU » n'existe pas en anglais.
    if (p.get("sens") === "wuqi") {
      // WU et QI n'existent qu'en ODS : « tous les lexiques » ne change rien.
      json(res, 200, { lexique, wuqi: compteurWuQi(lexique) });
      return;
    }
    const brute = Number(p.get("longueur"));
    const longueur = Number.isInteger(brute) && brute >= 2 && brute <= 15 ? brute : undefined;
    const quel = confondus ? null : lexique;
    const lignes = p.get("sens") === "trouves"
      ? motsTrouves(quel, longueur)
      : motsRates(quel, longueur);
    json(res, 200, {
      lexique: confondus ? LEXIQUE_TOUS : lexique,
      longueur: longueur ?? null, lignes,
    });
    return;
  }

  // ------------------------------------------------------------ le competitif
  //
  // Les parties du jour d'un lexique, a une date. JAMAIS CELLES DE DEMAIN : elles
  // sont figees d'avance, et ne se montrent pas avant de paraitre (SPEC.md §29).
  if (url === "/api/competitif/jour" && req.method === "GET") {
    const p = parametres(req);
    const moi = quiParle(req);
    const lexique = (LEXIQUES_DU_JOUR as readonly string[]).includes(p.get("lexique") ?? "")
      ? p.get("lexique")! : LEXIQUES_DU_JOUR[0];
    const aujourdhui = jourDe(Date.now());
    const demande = p.get("jour");
    const jour = jourValide(demande) && demande <= aujourdhui ? demande : aujourdhui;
    const j = partiesDuJour(jour, lexique);
    const epreuve = epreuveDuJour(jour, lexique);
    json(res, 200, {
      jour, aujourdhui, lexique, pret: j !== undefined,
      jours: joursConnus(lexique),
      parties: (j?.parties ?? []).map((x) => {
        const m = moi === undefined ? undefined : mancheDuCompte(moi.pseudo, epreuve, x.n);
        return {
          n: x.n, config: x.config,
          etat: m === undefined ? "a-jouer" : m.fin === null ? "en-cours" : "jouee",
          temps: m?.fin?.temps ?? null, negatif: m?.fin?.negatif ?? null,
          manche: m?.fin === null || m === undefined ? null : m.id,
          joueurs: resultatsDeLaPartie(epreuve, x.n, null).lignes.length,
        };
      }),
    });
    return;
  }

  // JOUER UNE PARTIE DU JOUR : on rend le salon ou elle se joue, ouvert au besoin.
  // Rien n'est consomme ici -- la tentative part au lancement, pas a l'entree.
  if (url === "/api/competitif/jouer" && req.method === "POST") {
    const moi = quiParle(req);
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }

    // UN DEFI SE JOUE SANS COMPTE (SPEC.md §29) : le pseudo suffit, et sa
    // ligne portera la mention d'invite comme partout ailleurs.
    if (corps.defi !== undefined) {
      const d = defi(String(corps.defi));
      if (d === undefined) { json(res, 404, { erreur: "Ce défi n'existe pas" }); return; }
      const qui = moi?.pseudo ?? String(corps.pseudo ?? "").trim().slice(0, 24);
      if (qui === "") { json(res, 400, { erreur: "Choisissez un pseudo" }); return; }
      const epreuve = epreuveDuDefi(d.id);
      const m = mancheDuCompte(qui, epreuve, 1);
      if (m !== undefined && m.fin !== null) {
        json(res, 409, { erreur: "Vous avez déjà joué ce défi" });
        return;
      }
      try {
        const s = await ouvrirLeSalonDEpreuve({ epreuve, partie: 1, compte: qui, manche: m });
        json(res, 200, { salon: s.id });
      } catch (e) {
        json(res, 503, { erreur: (e as Error).message });
      }
      return;
    }
    // TOUT LE RESTE DEMANDE UN COMPTE : seul le defi s'ouvre a un pseudo nu.
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous pour jouer" }); return; }
    // UNE PARTIE DE TOURNOI : entre ses deux dates, et pour un inscrit.
    if (corps.tournoi !== undefined) {
      const t = tournoi(String(corps.tournoi));
      const n = Number(corps.partie);
      if (t === undefined || t.type !== "topping" || !t.parties.some((x) => x.n === n)) {
        json(res, 404, { erreur: "cette partie n'existe pas" });
        return;
      }
      const maintenant = Date.now();
      if (maintenant < t.debut) { json(res, 403, { erreur: "Le tournoi n'a pas commencé" }); return; }
      if (t.fin !== null && maintenant >= t.fin) { json(res, 403, { erreur: "Le tournoi est terminé" }); return; }
      // CLIQUER SUR JOUER INSCRIT (SPEC.md §29) : s'inscrire d'abord n'apprenait
      // rien a personne. Le formulaire ne sert plus qu'a nommer une equipe.
      if (inscriptionDe(t, moi.pseudo) === undefined) {
        const erreur = inscrireAuTournoi(t, moi.pseudo, "", [], maintenant);
        if (erreur !== null) { json(res, 403, { erreur }); return; }
        console.log(`[competitif] ${moi.pseudo} s'inscrit au tournoi "${t.nom}" en le jouant`);
      }
      const epreuve = epreuveDuTournoi(t.id);
      const m = mancheDuCompte(moi.pseudo, epreuve, n);
      if (m !== undefined && m.fin !== null) {
        json(res, 409, { erreur: "Vous avez déjà joué cette partie" });
        return;
      }
      try {
        const s = await ouvrirLeSalonDEpreuve({ epreuve, partie: n, compte: moi.pseudo, manche: m });
        json(res, 200, { salon: s.id });
      } catch (e) {
        json(res, 503, { erreur: (e as Error).message });
      }
      return;
    }
    const lexique = String(corps.lexique ?? "");
    const jour = corps.jour;
    const n = Number(corps.partie);
    if (!(LEXIQUES_DU_JOUR as readonly string[]).includes(lexique) || !jourValide(jour)
        || jour > jourDe(Date.now()) || !Number.isInteger(n)) {
      json(res, 400, { erreur: "cette partie n'existe pas" });
      return;
    }
    const j = partiesDuJour(jour, lexique);
    if (j === undefined) {
      json(res, 503, { erreur: "Les parties du jour se préparent, réessayez dans un instant" });
      return;
    }
    if (!j.parties.some((x) => x.n === n)) { json(res, 404, { erreur: "cette partie n'existe pas" }); return; }
    const epreuve = epreuveDuJour(jour, lexique);
    const m = mancheDuCompte(moi.pseudo, epreuve, n);
    if (m !== undefined && m.fin !== null) {
      json(res, 409, { erreur: "Vous avez déjà joué cette partie" });
      return;
    }
    try {
      const s = await ouvrirLeSalonDEpreuve({ epreuve, partie: n, compte: moi.pseudo, manche: m });
      json(res, 200, { salon: s.id });
    } catch (e) {
      json(res, 503, { erreur: (e as Error).message });
    }
    return;
  }

  // LES RESULTATS D'UNE PARTIE, OU LE CUMUL. Les lignes sont publiques ; le
  // detail des coups ne part qu'a qui a fini la partie (voir `competitif.ts`).
  if (url === "/api/competitif/resultats" && req.method === "GET") {
    const p = parametres(req);
    const moi = quiParle(req);
    // UN DEFI : une seule partie, et un pseudo suffit a lire la sienne.
    if (p.get("defi") !== null) {
      const d = defi(p.get("defi")!);
      if (d === undefined) { json(res, 404, { erreur: "Ce défi n'existe pas" }); return; }
      const qui = moi?.pseudo ?? p.get("pseudo") ?? null;
      json(res, 200, {
        jour: null, lexique: d.config.dictionnaire, defi: { id: d.id, nom: d.nom },
        parties: [{ n: 1, config: d.config }], partie: 1,
        ...resultatsDeLaPartie(epreuveDuDefi(d.id), 1, qui),
      });
      return;
    }
    if (p.get("tournoi") !== null) {
      const t = tournoi(p.get("tournoi")!);
      if (t === undefined || t.type !== "topping") { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
      const epreuve = epreuveDuTournoi(t.id);
      const base = {
        jour: null, lexique: t.lexique, tournoi: { id: t.id, nom: t.nom, fin: t.fin },
        parties: t.parties.map((x) => ({ n: x.n, config: x.config })),
      };
      if (p.get("partie") === "cumul") {
        json(res, 200, { ...base, partie: "cumul", ...cumulDeLEpreuve(epreuve, moi?.pseudo ?? null) });
        return;
      }
      const n = Number(p.get("partie") ?? "1");
      if (!t.parties.some((x) => x.n === n)) { json(res, 404, { erreur: "cette partie n'existe pas" }); return; }
      json(res, 200, { ...base, partie: n, ...resultatsDeLaPartie(epreuve, n, moi?.pseudo ?? null) });
      return;
    }
    const lexique = p.get("lexique") ?? "";
    const jour = p.get("jour");
    const j = jourValide(jour) && jour <= jourDe(Date.now()) ? partiesDuJour(jour, lexique) : undefined;
    if (j === undefined) { json(res, 404, { erreur: "Aucune partie ce jour-là" }); return; }
    const epreuve = epreuveDuJour(j.jour, lexique);
    const parties = j.parties.map((x) => ({ n: x.n, config: x.config }));
    if (p.get("partie") === "cumul") {
      json(res, 200, {
        jour: j.jour, lexique, parties, partie: "cumul",
        ...cumulDeLEpreuve(epreuve, moi?.pseudo ?? null),
      });
      return;
    }
    const n = Number(p.get("partie") ?? "1");
    if (!j.parties.some((x) => x.n === n)) { json(res, 404, { erreur: "cette partie n'existe pas" }); return; }
    json(res, 200, {
      jour: j.jour, lexique, parties, partie: n,
      ...resultatsDeLaPartie(epreuve, n, moi?.pseudo ?? null),
    });
    return;
  }

  // LE PALMARES : les medailles des parties du jour, et la liste des solos.
  // Publics tous les deux, comme les records.
  if ((url === "/api/competitif/medailles" || url === "/api/competitif/solos") && req.method === "GET") {
    const p = parametres(req);
    const lexique = (LEXIQUES_DU_JOUR as readonly string[]).includes(p.get("lexique") ?? "")
      ? p.get("lexique")! : undefined;
    // TROIS PERIODES : tout, l'annee en cours, les trente derniers jours.
    const periode = p.get("periode") ?? "tout";
    const aujourdhui = jourDe(Date.now());
    const depuis = periode === "annee" ? `${aujourdhui.slice(0, 4)}-01-01`
      : periode === "30j" ? decalerLeJour(aujourdhui, -30) : null;
    if (url.endsWith("/medailles")) {
      json(res, 200, { lexique: lexique ?? null, periode, lignes: classementDesMedailles({ lexique, depuis }) });
      return;
    }
    json(res, 200, {
      lexique: lexique ?? null, periode, minimum: JOUEURS_POUR_UN_SOLO,
      solos: listeDesSolos({ lexique, depuis }),
    });
    return;
  }

  // LE REJEU D'UNE MANCHE (SPEC.md §29). La partie vit dans le salon ou elle
  // s'est jouee ; on ne la sert qu'a qui a le droit d'en voir le detail --
  // c'est-a-dire a qui a fini cette partie-la.
  if (url.startsWith("/api/competitif/partie/") && req.method === "GET") {
    const id = decodeURIComponent(url.slice("/api/competitif/partie/".length));
    const r = mancheRelue(id, quiParle(req));
    if (typeof r === "string") { json(res, r === "inconnue" ? 404 : 403, { message: messageDeRefus(r) }); return; }
    json(res, 200, r);
    return;
  }

  if (url.startsWith("/api/competitif/paliers/") && req.method === "GET") {
    const reste = url.slice("/api/competitif/paliers/".length).split("/");
    const id = decodeURIComponent(reste[0] ?? "");
    const n = Number(reste[1]);
    const m = mancheParId(id);
    const moi = quiParle(req);
    if (m === undefined || !Number.isInteger(n)) { json(res, 404, { message: "Partie introuvable" }); return; }
    if (resultatsDeLaPartie(m.epreuve, m.partie, moi?.pseudo ?? null).details === null) {
      json(res, 403, { message: "Cette partie s'ouvre une fois que vous l'avez jouée" });
      return;
    }
    const fichier = journalDuSalon(m.salon);
    const p = fichier === null ? null : relireEtGarder(fichier);
    if (p === null) { json(res, 404, { message: "Partie introuvable" }); return; }
    json(res, 200, { n, paliers: await paliersDuCoup(p, n) });
    return;
  }

  // ------------------------------------------------ l'administration du competitif
  //
  // LE SERVEUR REFUSE, et pas seulement l'ecran : un bouton cache est un
  // garde-fou, pas une regle.
  if (url === "/api/admin/pdj" && (req.method === "GET" || req.method === "POST")) {
    const moi = quiParle(req);
    if (moi === undefined || !moi.admin) { json(res, 403, { erreur: "réservé" }); return; }
    let lexique = parametres(req).get("lexique") ?? "";
    if (req.method === "POST") {
      let corps: any;
      try { corps = await corpsJson(req); }
      catch { json(res, 400, { erreur: "requête illisible" }); return; }
      lexique = String(corps.lexique ?? "");
      if (!(LEXIQUES_DU_JOUR as readonly string[]).includes(lexique)) {
        json(res, 400, { erreur: "lexique inconnu" });
        return;
      }
      let changement: ChangementDuJour;
      if (corps.action === "nombre") changement = { action: "nombre", nombre: Number(corps.nombre) };
      else if (corps.action === "retirer") changement = { action: "retirer" };
      else if (corps.action === "graine") changement = { action: "graine", partie: Number(corps.partie) };
      else if (corps.action === "reglages") {
        const consigne = consigneRecevable(corps.consigne);
        if (typeof consigne === "string") { json(res, 400, { erreur: consigne }); return; }
        changement = { action: "reglages", partie: Number(corps.partie), consigne };
      } else { json(res, 400, { erreur: "action inconnue" }); return; }
      const r = await changerLesPartiesDeDemain(lexique, changement, moi.pseudo, LAYOUT);
      if (typeof r === "string") { json(res, 400, { erreur: r }); return; }
    }
    if (!(LEXIQUES_DU_JOUR as readonly string[]).includes(lexique)) lexique = LEXIQUES_DU_JOUR[0];
    const demain = decalerLeJour(jourDe(Date.now()), 1);
    const j = partiesDuJour(demain, lexique);
    json(res, 200, {
      jour: demain, lexique, pret: j !== undefined,
      // LE NOM, ET RIEN D'AUTRE : la partie ne se voit qu'a l'apercu.
      parties: (j?.parties ?? []).map((x) => ({ n: x.n, config: x.config })),
      apercus: apercusDe(moi.pseudo, lexique),
    });
    return;
  }

  if (url === "/api/admin/pdj/apercu" && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined || !moi.admin) { json(res, 403, { erreur: "réservé" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const a = apercuDeDemain(String(corps.lexique ?? ""), Number(corps.partie), moi.pseudo);
    if (a === null) { json(res, 404, { erreur: "cette partie n'existe pas" }); return; }
    console.log(`[competitif] apercu de la P${a.partie} du ${a.jour} par ${moi.pseudo}`);
    json(res, 200, a);
    return;
  }

  // LES MODELES DE LA SEMAINE (SPEC.md §29) : sept listes de consignes par
  // lexique, qui decident des parties du lendemain.
  if (url === "/api/admin/semaine" && (req.method === "GET" || req.method === "POST")) {
    const moi = quiParle(req);
    if (moi === undefined || !moi.admin) { json(res, 403, { erreur: "réservé" }); return; }
    let lexique = parametres(req).get("lexique") ?? "";
    if (req.method === "POST") {
      let corps: any;
      try { corps = await corpsJson(req); }
      catch { json(res, 400, { erreur: "requête illisible" }); return; }
      lexique = String(corps.lexique ?? "");
      if (!(LEXIQUES_DU_JOUR as readonly string[]).includes(lexique)) {
        json(res, 400, { erreur: "lexique inconnu" });
        return;
      }
      const jour = entierEntre(corps.jour, 0, 6);
      if (jour === null) { json(res, 400, { erreur: "jour de la semaine inconnu" }); return; }
      // UNE LISTE VIDE EST UN ORDRE : ce jour n'a plus de consignes, et reprend
      // les parties d'office du lexique.
      const consignes = Array.isArray(corps.consignes) && corps.consignes.length === 0
        ? [] : lireDesConsignes(corps.consignes, 8);
      if (typeof consignes === "string") { json(res, 400, { erreur: consignes }); return; }
      reglerLaSemaine(lexique, jour, consignes, moi.pseudo);
    }
    if (!(LEXIQUES_DU_JOUR as readonly string[]).includes(lexique)) lexique = LEXIQUES_DU_JOUR[0];
    json(res, 200, { lexique, semaine: laSemaineDe(lexique) });
    return;
  }

  // LES TOURNOIS DE LA SEMAINE : les modeles, pas leurs instances.
  if (url === "/api/admin/hebdo" && (req.method === "GET" || req.method === "POST")) {
    const moi = quiParle(req);
    if (moi === undefined || !moi.admin) { json(res, 403, { erreur: "réservé" }); return; }
    if (req.method === "POST") {
      let corps: any;
      try { corps = await corpsJson(req); }
      catch { json(res, 400, { erreur: "requête illisible" }); return; }
      if (corps.supprimer === true) {
        const id = String(corps.id ?? "");
        if (modeleHebdo(id) === undefined) { json(res, 404, { erreur: "ce tournoi n'existe pas" }); return; }
        supprimerUnModeleHebdo(id, moi.pseudo);
      } else {
        const o = lireUnModeleHebdo(corps);
        if (typeof o === "string") { json(res, 400, { erreur: o }); return; }
        ecrireUnModeleHebdo({ ...o, par: moi.pseudo });
        // Une instance peut naitre tout de suite si le tournoi commence demain.
        void assurerLesTournoisDeLaSemaine(LAYOUT).catch(() => undefined);
      }
    }
    json(res, 200, { modeles: tousLesModelesHebdo() });
    return;
  }

  // LES NOTIFICATIONS (SPEC.md §29) : elles vivent hors des salons, et se
  // relisent d'ou qu'on soit.
  if (url === "/api/notifications" && req.method === "GET") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 200, { notifications: [], nonLues: 0 }); return; }
    json(res, 200, notificationsDe(moi.pseudo));
    return;
  }

  if (url === "/api/notifications/lues" && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "connectez-vous" }); return; }
    marquerLues(moi.pseudo);
    json(res, 200, notificationsDe(moi.pseudo));
    return;
  }

  // ------------------------------------------------- l'historique d'un joueur
  //
  // TROIS JOURNAUX (SPEC.md §30) : le competitif pour les epreuves, celui de
  // l'historique pour les parties de salon d'aujourd'hui, et celui des records
  // pour les anciennes. Une partie presente dans deux ne paraît qu'une fois.

  if (url.startsWith("/api/joueur/") && url.endsWith("/historique") && req.method === "GET") {
    const qui = decodeURIComponent(url.slice("/api/joueur/".length, -"/historique".length));
    const lignes: Record<string, unknown>[] = [];
    for (const m of manchesDe(qui)) {
      lignes.push({
        type: m.type, source: "competitif", id: m.manche, at: m.at, config: m.config,
        dou: m.dou, partie: m.partie, temps: m.temps, negatif: m.negatif,
        score: m.score, coups: m.coups,
        equipe: m.equipe.length > 1 ? m.equipe : [],
        ...(m.defi === undefined ? {} : { defi: m.defi }),
        ...(m.tournoi === undefined ? {} : { tournoi: m.tournoi }),
      });
    }
    const vues = new Set<string>();
    for (const p of partiesDe(qui)) {
      const sienne = p.joueurs.find((j) => j.nom === qui);
      if (sienne === undefined) continue;
      vues.add(`${p.salon}|${p.graine}`);
      lignes.push({
        type: "salon", source: "historique", id: `${p.salon}~${p.graine}`, at: p.at,
        config: p.resume, dou: p.nomSalon, partie: 0, temps: null,
        negatif: sienne.negatif, score: sienne.score, coups: p.coups,
        equipe: p.joueurs.length > 1 ? p.joueurs.map((j) => j.nom) : [],
      });
    }
    // LES ANCIENNES PARTIES DE SALON, celles d'avant le journal de l'historique :
    // le tableau des records est le seul endroit ou elles soient nommees.
    for (const m of manchesValides()) {
      if (vues.has(`${m.partie}|${m.graine}`)) continue;
      if (!m.joueurs.some((j: { nom: string }) => j.nom === qui)) continue;
      lignes.push({
        type: "salon", source: "records", id: m.ref, at: m.at, config: null,
        dou: "", partie: 0, temps: m.temps, negatif: m.negatif,
        score: m.cumul, coups: m.coups,
        equipe: m.joueurs.length > 1 ? m.joueurs.map((j: { nom: string }) => j.nom) : [],
        grille: m.grille, lexique: m.lexique, chrono: m.chrono,
      });
    }
    lignes.sort((a, b) => (b["at"] as number) - (a["at"] as number));
    json(res, 200, { joueur: qui, lignes: lignes.slice(0, 400) });
    return;
  }

  // LE REJEU D'UNE PARTIE DE SALON. Comme le lecteur des records, il ne sert
  // QUE des parties citees a un journal : une partie en cours ne se lit pas.
  if (url.startsWith("/api/historique/partie/") && req.method === "GET") {
    const r = partieRelueDeLHistorique(decodeURIComponent(url.slice("/api/historique/partie/".length)));
    if (typeof r === "string") { json(res, 404, { message: r }); return; }
    json(res, 200, r);
    return;
  }

  if (url.startsWith("/api/historique/paliers/") && req.method === "GET") {
    const reste = url.slice("/api/historique/paliers/".length).split("/");
    const id = decodeURIComponent(reste[0] ?? "");
    const n = Number(reste[1]);
    const [salon, graine] = id.split("~");
    if (salon === undefined || graine === undefined || !Number.isInteger(n)
        || partieDeLHistorique(salon, graine) === undefined) {
      json(res, 404, { message: "Partie introuvable" });
      return;
    }
    const fichier = journalDeLaPartie(salon, graine);
    const p = fichier === null ? null : relireEtGarder(fichier);
    if (p === null) { json(res, 404, { message: "Partie introuvable" }); return; }
    json(res, 200, { n, paliers: await paliersDuCoup(p, n) });
    return;
  }

  // ------------------------------------------------------------- les defis
  //
  // UNE PARTIE QU'ON A JOUEE ET QU'ON FAIT CIRCULER (SPEC.md §29). Elle se
  // refige depuis sa graine, et s'arrete ou la partie d'origine s'est arretee.

  if (url === "/api/defi" && req.method === "POST") {
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const s = salon(String(corps.salon ?? ""));
    if (s === undefined) { json(res, 404, { erreur: "Ce salon n'existe pas" }); return; }
    if (s.epreuve !== null) {
      json(res, 403, { erreur: "On ne défie pas sur une partie du jour ni de tournoi" });
      return;
    }
    if (estPermanent(s)) { json(res, 403, { erreur: "Cette grille n'a pas de fin" }); return; }
    if (s.partie.moves.length === 0) { json(res, 400, { erreur: "Cette partie n'a pas de coups" }); return; }
    // ON NE DEFIE QUE SUR UNE PARTIE QUI SE GARDE (SPEC.md §29). Une partie
    // abandonnee, ou dont aucun fichier ne survivra, ne se revoit pas : le defi
    // menerait a un classement sans partie derriere.
    if (!s.partie.finie || s.partie.raisonDeLaFin === "abandon" || !meriteDEtreGardee(s)) {
      json(res, 403, { erreur: "On ne défie que sur une partie terminée et gardée" });
      return;
    }
    const deja = defiDeLaPartie(s.id, s.partie.seed);
    if (deja !== undefined) { json(res, 200, { defi: defiPublic(deja) }); return; }
    const moi = quiParle(req);
    const par = moi?.pseudo ?? (String(corps.pseudo ?? "").trim().slice(0, 24) || "anonyme");
    try {
      const d = await creerUnDefi({
        salon: s.id, graine: s.partie.seed, nom: s.nom, cfg: s.partie.cfg, layout: s.layout,
        coups: s.partie.moves.length, par, lignes: lignesDOrigine(s),
      });
      json(res, 200, { defi: defiPublic(d) });
    } catch (e) {
      json(res, 503, { erreur: (e as Error).message });
    }
    return;
  }

  if (url.startsWith("/api/defi/") && url.endsWith("/inviter") && req.method === "POST") {
    const d = defi(decodeURIComponent(url.slice("/api/defi/".length, -"/inviter".length)));
    if (d === undefined) { json(res, 404, { erreur: "Ce défi n'existe pas" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const moi = quiParle(req);
    const de = moi?.pseudo ?? (String(corps.pseudo ?? "").trim().slice(0, 24) || "quelqu'un");
    const vises = lireDesPseudos(corps.pseudos);
    if (typeof vises === "string") { json(res, 400, { erreur: vises }); return; }
    for (const qui of vises) {
      if (qui === de) continue;
      notifier(qui, "defi", { defi: d.id, nom: d.nom, de }, `defi:${d.id}`);
    }
    console.log(`[competitif] defi "${d.nom}" envoye par ${de} a ${vises.length} joueur(s)`);
    json(res, 200, { invites: vises.length });
    return;
  }

  if (url.startsWith("/api/defi/") && req.method === "GET") {
    const d = defi(decodeURIComponent(url.slice("/api/defi/".length)));
    if (d === undefined) { json(res, 404, { erreur: "Ce défi n'existe pas" }); return; }
    const moi = quiParle(req);
    const qui = moi?.pseudo ?? parametres(req).get("pseudo") ?? "";
    const m = qui === "" ? undefined : mancheDuCompte(qui, epreuveDuDefi(d.id), 1);
    json(res, 200, {
      defi: defiPublic(d),
      moi: { etat: m === undefined ? "a-jouer" : m.fin === null ? "en-cours" : "jouee",
        temps: m?.fin?.temps ?? null, negatif: m?.fin?.negatif ?? null,
        manche: m?.fin == null ? null : m.id },
    });
    return;
  }

  // LA LISTE DES COMPTES, pour la fenetre qui defie et pour celle qui invite a
  // un tournoi. Les pseudos et rien d'autre : c'est deja ce qu'un salon montre.
  if (url === "/api/comptes" && req.method === "GET") {
    json(res, 200, { pseudos: tousLesComptes().map((c) => c.pseudo).sort((a, b) => a.localeCompare(b, "fr")) });
    return;
  }

  if (url.startsWith("/api/tournoi/") && url.endsWith("/inviter") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/inviter".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const vises = lireDesPseudos(corps.pseudos);
    if (typeof vises === "string") { json(res, 400, { erreur: vises }); return; }
    for (const qui of vises) {
      if (qui === moi.pseudo) continue;
      notifier(qui, "tournoi-invite", { tournoi: t.id, nom: t.nom, de: moi.pseudo },
        `invite:${t.id}`);
    }
    console.log(`[competitif] tournoi "${t.nom}" : ${vises.length} invitation(s) par ${moi.pseudo}`);
    json(res, 200, { invites: vises.length });
    return;
  }

  // LES TOURNOIS : la liste et la fiche sont publiques.
  if (url === "/api/tournois" && req.method === "GET") {
    const moi = quiParle(req);
    json(res, 200, {
      maintenant: Date.now(),
      tournois: tousLesTournois().map((t) => ({
        ...tournoiPublic(t),
        // CE QUE J'Y AI FAIT : la tuile d'un tournoi fini se voit d'un regard.
        // COMBIEN ONT FINI : autant que d'inscrits, c'est un tournoi joue.
        resultats: finisseursDuTournoi(t),
        moi: moi === undefined ? null : {
          inscrit: inscriptionDe(t, moi.pseudo) !== undefined,
          finies: partiesFiniesDe(t, moi.pseudo),
          modifiable: tournoiModifiable(t, moi.pseudo, moi.admin) === null,
        },
      })),
    });
    return;
  }

  // MODIFIER OU SUPPRIMER UN TOURNOI : son createur, tant qu'il n'a pas commence.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/modifier") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/modifier".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const refus = tournoiModifiable(t, moi.pseudo, moi.admin);
    if (refus !== null) { json(res, 403, { erreur: refus }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    if (t.type === "topping") {
      const o = lireUnTournoiDeTopping(corps);
      if (typeof o === "string") { json(res, 400, { erreur: o }); return; }
      json(res, 200, { tournoi: tournoiPublic(await modifierUnTournoiDeTopping(t, o, LAYOUT)) });
      return;
    }
    const o = lireUnTournoiDeBattle(corps, false);
    if (typeof o === "string") { json(res, 400, { erreur: o }); return; }
    json(res, 200, { tournoi: tournoiPublic(modifierUnTournoiDeBattle(t, o)) });
    return;
  }

  if (url.startsWith("/api/tournoi/") && url.endsWith("/supprimer") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/supprimer".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (t.par !== moi.pseudo && !moi.admin) {
      json(res, 403, { erreur: "Seul son créateur supprime ce tournoi" });
      return;
    }
    supprimerUnTournoi(t, moi.pseudo);
    json(res, 200, { ok: true });
    return;
  }

  if (url === "/api/tournois" && req.method === "POST") {
    const moi = quiParle(req);
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const type = corps.type === "battle" ? "battle" : "topping";
    if (!peutCreerUnTournoi(moi, type)) { json(res, 403, { erreur: "réservé" }); return; }
    if (type === "topping") {
      const o = lireUnTournoiDeTopping(corps);
      if (typeof o === "string") { json(res, 400, { erreur: o }); return; }
      try {
        const t = await creerUnTournoiDeTopping({ ...o, par: moi!.pseudo }, LAYOUT);
        json(res, 200, { tournoi: tournoiPublic(t) });
      } catch (e) {
        json(res, 500, { erreur: (e as Error).message });
      }
      return;
    }
    const o = lireUnTournoiDeBattle(corps);
    if (typeof o === "string") { json(res, 400, { erreur: o }); return; }
    json(res, 200, { tournoi: tournoiPublic(creerUnTournoiDeBattle({ ...o, par: moi!.pseudo })) });
    return;
  }

  // ---------------------------------------------- LES TOURNOIS DE BATTLE

  // TIRER DES POULES, SANS RIEN ECRIRE. L'organisateur les retouche à la main
  // et peut retirer autant qu'il veut : rien n'est acquis avant la validation.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/poules/tirer") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/poules/tirer".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const refus = battleReglable(t, moi);
    if (refus !== null) { json(res, 403, { erreur: refus }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const parPoule = Math.max(2, Math.min(64, Math.round(Number(corps.joueursParPoule) || 4)));
    json(res, 200, { poules: tirerDesPoules(t.inscrits.map((i) => i.compte), parPoule) });
    return;
  }

  // VALIDER ET LANCER LA PHASE DE POULES : le geste qui ferme les inscriptions
  // pour de bon, crée toutes les rencontres et prévient les inscrits.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/poules") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/poules".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const refus = battleReglable(t, moi);
    if (refus !== null) { json(res, 403, { erreur: refus }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const lues = lireDesPoules(corps.poules, t);
    if (typeof lues === "string") { json(res, 400, { erreur: lues }); return; }
    // ON NE RELIT PAS TOUT LE FORMULAIRE ICI : la partie d'une manche se
    // retirerait au sort, et le tournoi changerait de type sous les inscrits.
    // Seuls les reglages que ce geste consomme sont lus.
    const regles = lireLesReglagesDePoule(corps, t);
    if (typeof regles === "string") { json(res, 400, { erreur: regles }); return; }
    const avec = modifierUnTournoiDeBattle(t, {
      nom: t.nom, lexique: t.lexique, debut: t.debut, equipe: t.equipe,
      battle: { ...t.battle!, ...regles },
    });
    lancerLesPoules(avec, lues, moi.pseudo);
    for (const i of avec.inscrits) {
      for (const qui of [i.compte, ...i.partenaires]) {
        notifier(qui, "tournoi-poules", { tournoi: avec.id, nom: avec.nom }, `poules:${avec.id}`);
      }
    }
    json(res, 200, { ok: true });
    return;
  }

  // SE DESINSCRIRE : tant que le tournoi n'est pas engagé (SPEC.md §29).
  if (url.startsWith("/api/tournoi/") && url.endsWith("/desinscription") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/desinscription".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const erreur = desinscrireDuTournoi(t, moi.pseudo);
    if (erreur !== null) { json(res, 403, { erreur }); return; }
    console.log(`[competitif] ${moi.pseudo} se retire de "${t.nom}"`);
    json(res, 200, { ok: true });
    return;
  }

  // L'EN-TETE DE LA PAGE : au créateur et à l'administration, toujours.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/entete") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/entete".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (t.par !== moi.pseudo && !moi.admin) {
      json(res, 403, { erreur: "Seul son créateur écrit l'en-tête" });
      return;
    }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    reglerLEntete(t.id, String(corps.texte ?? ""), moi.pseudo);
    json(res, 200, { ok: true });
    return;
  }

  // MES DISPONIBILITES : écrites une fois pour tout le tournoi.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/dispos") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/dispos".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (inscriptionDe(t, moi.pseudo) === undefined) {
      json(res, 403, { erreur: "Vous ne jouez pas ce tournoi" });
      return;
    }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    reglerLesDispos(t.id, moi.pseudo, String(corps.texte ?? ""));
    json(res, 200, { ok: true });
    return;
  }

  // DECLARER UN FORFAIT : toutes les rencontres restantes d'un camp, d'un coup.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/forfait") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/forfait".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (t.par !== moi.pseudo && !moi.admin) {
      json(res, 403, { erreur: "Seul son créateur arbitre ce tournoi" });
      return;
    }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const camp = String(corps.camp ?? "");
    if (!t.inscrits.some((i) => i.compte === camp)) {
      json(res, 400, { erreur: "Ce camp ne joue pas ce tournoi" });
      return;
    }
    json(res, 200, { rencontres: declarerUnForfait(t, camp, moi.pseudo) });
    return;
  }

  // L'APERCU DU DOUBLE TABLEAU : le meme calcul que la validation, pour qu'il
  // ne puisse rien y avoir de different entre ce qu'on voit et ce qu'on lance.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/tableau/apercu") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/tableau/apercu".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const refus = tableauReglable(t, moi);
    if (refus !== null) { json(res, 403, { erreur: refus }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const regles = lireLesReglagesDeTableau(corps, t);
    if (typeof regles === "string") { json(res, 400, { erreur: regles }); return; }
    // ON N'ECRIT RIEN : le plan se calcule sur un tournoi de papier.
    const vu = planifierLeTableau({ ...t, battle: { ...t.battle!, ...regles } });
    if (typeof vu === "string") { json(res, 400, { erreur: vu }); return; }
    json(res, 200, { ...vu, poulesFinies: poulesFinies(t) });
    return;
  }

  // VALIDER ET LANCER LE TABLEAU : les qualifiés y sont posés d'après leur
  // classement de poule, et chacun reçoit sa notification.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/tableau") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/tableau".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const refus = tableauReglable(t, moi);
    if (refus !== null) { json(res, 403, { erreur: refus }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const regles = lireLesReglagesDeTableau(corps, t);
    if (typeof regles === "string") { json(res, 400, { erreur: regles }); return; }
    const avec = modifierUnTournoiDeBattle(t, {
      nom: t.nom, lexique: t.lexique, debut: t.debut, equipe: t.equipe,
      battle: { ...t.battle!, ...regles },
    });
    const vu = planifierLeTableau(avec);
    if (typeof vu === "string") { json(res, 400, { erreur: vu }); return; }
    const erreur = lancerLeTableau(avec, moi.pseudo);
    if (erreur !== null) { json(res, 400, { erreur }); return; }
    // QUALIFIE OU NON : les deux se disent, et les deux mènent à la page.
    const dedans = new Set([...vu.haut, ...vu.bas]);
    for (const i of avec.inscrits) {
      const genre = dedans.has(i.compte) ? "tournoi-qualifie" : "tournoi-elimine";
      for (const qui of [i.compte, ...i.partenaires]) {
        notifier(qui, genre, { tournoi: avec.id, nom: avec.nom }, `tableau:${avec.id}`);
      }
    }
    json(res, 200, { ok: true });
    return;
  }

  // IMPOSER UNE HEURE A UNE PHASE, ou la libérer (SPEC.md §29). C'est ce qu'il
  // faut pour une finale retransmise ; le reste du tableau garde ses fenêtres.
  if (url.startsWith("/api/tournoi/") && url.endsWith("/date-phase") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/date-phase".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (t.par !== moi.pseudo && !moi.admin) {
      json(res, 403, { erreur: "Seul son créateur fixe les heures" });
      return;
    }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const phase = String(corps.phase ?? "");
    const quand = corps.quand === null || corps.quand === undefined || corps.quand === ""
      ? null : instantDeParis(corps.quand);
    if (corps.quand != null && corps.quand !== "" && quand === null) {
      json(res, 400, { erreur: "Donnez une date et une heure" });
      return;
    }
    const erreur = reglerLaDateDeLaPhase(t, phase, quand, moi.pseudo);
    if (erreur !== null) { json(res, 400, { erreur }); return; }
    console.log(`[competitif] "${t.nom}" · ${phase} : ${quand === null ? "heure libre" : new Date(quand).toISOString()}`);
    json(res, 200, { ok: true });
    return;
  }

  // ---------------------------------------------------- UNE RENCONTRE

  // OUVRIR LE SALON D'UNE RENCONTRE. Le même geste des deux côtés : le premier
  // arrivé l'ouvre, le second l'y rejoint. La manche en cours se reprend.
  if (url.startsWith("/api/rencontre/") && url.endsWith("/salon") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const r = rencontreParId(decodeURIComponent(url.slice("/api/rencontre/".length, -"/salon".length)));
    if (r === undefined) { json(res, 404, { erreur: "Cette rencontre n'existe pas" }); return; }
    const t = tournoi(r.tournoi);
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (r.fin !== null) { json(res, 403, { erreur: "Cette rencontre est terminée" }); return; }
    if (campDuCompte(t, r, moi.pseudo) < 0 && !moi.admin) {
      json(res, 403, { erreur: "Cette rencontre se joue sans vous" });
      return;
    }
    // UNE PHASE A HEURE FIXEE NE S'OUVRE PAS AVANT (SPEC.md §29).
    const pasEncore = rencontreOuvrable(r);
    if (pasEncore !== null && !moi.admin) { json(res, 403, { erreur: pasEncore }); return; }
    try {
      const s = await ouvrirLeSalonDeRencontre(t, r);
      json(res, 200, { salon: s.id });
    } catch (e) {
      json(res, 503, { erreur: (e as Error).message });
    }
    return;
  }

  // INVITER SON ADVERSAIRE : le salon s'ouvre, et il reçoit la notification qui
  // l'y mène. S'il est connecté ailleurs sur le site, il la voit tout de suite.
  if (url.startsWith("/api/rencontre/") && url.endsWith("/inviter") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const r = rencontreParId(decodeURIComponent(url.slice("/api/rencontre/".length, -"/inviter".length)));
    if (r === undefined) { json(res, 404, { erreur: "Cette rencontre n'existe pas" }); return; }
    const t = tournoi(r.tournoi);
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (r.fin !== null) { json(res, 403, { erreur: "Cette rencontre est terminée" }); return; }
    const mien = campDuCompte(t, r, moi.pseudo);
    if (mien < 0) { json(res, 403, { erreur: "Cette rencontre se joue sans vous" }); return; }
    const pasEncore = rencontreOuvrable(r);
    if (pasEncore !== null) { json(res, 403, { erreur: pasEncore }); return; }
    try {
      const s = await ouvrirLeSalonDeRencontre(t, r);
      const autre = r.camps[mien === 0 ? 1 : 0]!;
      for (const qui of joueursDuCamp(t, autre)) {
        notifier(qui, "salon", { salon: s.id, nom: s.nom, de: moi.pseudo });
      }
      json(res, 200, { salon: s.id });
    } catch (e) {
      json(res, 503, { erreur: (e as Error).message });
    }
    return;
  }

  // UNE DEMANDE DE CRENEAU : le message reste sur la rencontre, lisible des
  // deux côtés et de l'arbitre (SPEC.md §29).
  if (url.startsWith("/api/rencontre/") && url.endsWith("/message") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const r = rencontreParId(decodeURIComponent(url.slice("/api/rencontre/".length, -"/message".length)));
    if (r === undefined) { json(res, 404, { erreur: "Cette rencontre n'existe pas" }); return; }
    const t = tournoi(r.tournoi);
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const mien = campDuCompte(t, r, moi.pseudo);
    if (mien < 0) { json(res, 403, { erreur: "Cette rencontre se joue sans vous" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const texte = String(corps.texte ?? "").trim();
    if (texte === "") { json(res, 400, { erreur: "Le message est vide" }); return; }
    ecrireUnMessageDeRencontre(r, moi.pseudo, texte);
    const autre = r.camps[mien === 0 ? 1 : 0]!;
    for (const qui of joueursDuCamp(t, autre)) {
      notifier(qui, "tournoi-creneau", {
        tournoi: t.id, nom: t.nom, de: moi.pseudo, texte: texte.slice(0, 200),
      });
    }
    json(res, 200, { ok: true });
    return;
  }

  // L'ARBITRAGE d'une rencontre non jouée.
  if (url.startsWith("/api/rencontre/") && url.endsWith("/arbitrer") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Connectez-vous d'abord" }); return; }
    const r = rencontreParId(decodeURIComponent(url.slice("/api/rencontre/".length, -"/arbitrer".length)));
    if (r === undefined) { json(res, 404, { erreur: "Cette rencontre n'existe pas" }); return; }
    const t = tournoi(r.tournoi);
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    if (t.par !== moi.pseudo && !moi.admin) {
      json(res, 403, { erreur: "Seul son créateur arbitre ce tournoi" });
      return;
    }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const quoi = corps.quoi === "victoire" || corps.quoi === "personne" || corps.quoi === "delai"
      ? corps.quoi : null;
    if (quoi === null) { json(res, 400, { erreur: "arbitrage inconnu" }); return; }
    const erreur = arbitrerLaRencontre(r, {
      quoi, qui: corps.qui === undefined ? undefined : String(corps.qui),
      butoir: corps.butoir === undefined ? undefined : Number(corps.butoir),
      par: moi.pseudo,
    });
    if (erreur !== null) { json(res, 400, { erreur }); return; }
    console.log(`[competitif] arbitrage ${quoi} sur "${t.nom}" par ${moi.pseudo}`);
    json(res, 200, { ok: true });
    return;
  }

  if (url.startsWith("/api/tournoi/") && req.method === "GET") {
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    const moi = quiParle(req);
    const epreuve = epreuveDuTournoi(t.id);
    const inscription = moi === undefined ? undefined : inscriptionDe(t, moi.pseudo);
    json(res, 200, {
      maintenant: Date.now(),
      tournoi: tournoiPublic(t),
      resultats: finisseursDuTournoi(t),
      battle: vueDuBattle(t, moi),
      moi: moi === undefined ? null : {
        inscrit: inscription !== undefined,
        // Modifier et supprimer sont a son createur (SPEC.md §29).
        modifiable: tournoiModifiable(t, moi.pseudo, moi.admin) === null,
        proprietaire: t.par === moi.pseudo || moi.admin,
        parties: t.parties.map((x) => {
          const m = mancheDuCompte(moi.pseudo, epreuve, x.n);
          return {
            n: x.n, etat: m === undefined ? "a-jouer" : m.fin === null ? "en-cours" : "jouee",
            temps: m?.fin?.temps ?? null, negatif: m?.fin?.negatif ?? null,
            manche: m?.fin === null || m === undefined ? null : m.id,
          };
        }),
      },
    });
    return;
  }

  if (url.startsWith("/api/tournoi/") && url.endsWith("/inscription") && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined) { json(res, 401, { erreur: "Les tournois se jouent avec un compte" }); return; }
    const t = tournoi(decodeURIComponent(url.slice("/api/tournoi/".length, -"/inscription".length)));
    if (t === undefined) { json(res, 404, { erreur: "Ce tournoi n'existe pas" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    // Les partenaires nommes par pseudo doivent avoir un compte : on garde
    // l'ecriture exacte de leur pseudo, pas celle qu'on a tapee.
    const partenaires: string[] = [];
    for (const brut of (Array.isArray(corps.partenaires) ? corps.partenaires : []).slice(0, 8)) {
      const nom = String(brut ?? "").trim();
      if (nom === "") continue;
      const c = compte(nom);
      if (c === undefined) { json(res, 400, { erreur: `Aucun compte ne s'appelle ${nom}` }); return; }
      partenaires.push(c.pseudo);
    }
    const erreur = inscrireAuTournoi(t, moi.pseudo, String(corps.noms ?? ""), partenaires);
    if (erreur !== null) { json(res, 400, { erreur }); return; }
    // NOMME DANS UNE EQUIPE, ON L'APPREND : c'est une tentative qu'on engage
    // pour quelqu'un d'autre (SPEC.md §29).
    for (const p of partenaires) {
      notifier(p, "equipe", { tournoi: t.id, nom: t.nom, de: moi.pseudo });
    }
    console.log(`[competitif] ${moi.pseudo} s'inscrit au tournoi "${t.nom}"`);
    json(res, 200, { tournoi: tournoiPublic(t) });
    return;
  }

  if (url === "/api/salons" && req.method === "GET") {
    json(res, 200, {
      pret,
      salons: tousLesSalons()
        .filter((s) => !s.prive)
        .map((s) => resume(s, occupants(s.id).length, estPermanent(s))),
      max: MAX_SALONS,
    });
    return;
  }

  // Un salon prive ne figure pas dans la liste, mais s'ouvre par son adresse.
  if (url.startsWith("/api/salon/") && req.method === "GET") {
    const s = salon(decodeURIComponent(url.slice("/api/salon/".length)));
    if (s === undefined) { json(res, 404, { erreur: "salon introuvable" }); return; }
    json(res, 200, resume(s, occupants(s.id).length, estPermanent(s)));
    return;
  }

  if (url === "/api/salons" && req.method === "POST") {
    try {
      const c = await corpsJson(req);
      // Pas de nom demande : on en tire un au hasard, distinct des autres.
      const nom = String(c.nom ?? "").trim().slice(0, 40) || nomAuHasard();
      const proprietaire = String(c.proprietaire ?? "").trim().slice(0, 24) || "anonyme";
      // Creer un salon ouvre une partie NORMALE : 15x15, plateau du commerce,
      // 7 sur 7, sac de 102. Tout le reste se regle a l'interieur du salon.
      const s = await ouvrirSalon({
        id: identifiantLibre(nom), nom, proprietaire, prive: c.prive === true,
        // Un salon neuf est une partie normale : plateau 15x15. La grille
        // infinie se choisit ensuite, dans les reglages du salon.
        layout: LAYOUT, cfg: configDeDepart(false, c.langue === "en" ? "en" : "fr"),
        nouveau: true,
      });
      surveiller(s);
      console.log(`[salon] "${s.nom}" (${s.id}) ouvert par ${proprietaire} : ` +
        `${nomDeLaGrille(s.partie.cfg.bornes)}`);
      json(res, 200, resume(s, 0, estPermanent(s)));
    } catch (e) {
      json(res, 400, { erreur: (e as Error).message });
    }
    return;
  }

  if (url.startsWith("/api/salon/") && req.method === "DELETE") {
    const id = decodeURIComponent(url.slice("/api/salon/".length));
    const s = salon(id);
    if (s === undefined) { json(res, 404, { erreur: "salon introuvable" }); return; }
    if (estPermanent(s)) {
      // Le nom vient du salon : il y a desormais plus d'une grille permanente,
      // et l'une d'elles s'appelait toujours par le nom de l'autre.
      json(res, 403, { erreur: `le salon « ${s.nom} » est permanent` });
      return;
    }
    // Le cookie fait foi quand il y en a un ; l'en-tete ne sert plus qu'aux
    // joueurs sans compte, pour qui il n'a jamais ete qu'un garde-fou.
    const moi = quiParle(req);
    const par = moi?.pseudo ?? String(req.headers["x-pseudo"] ?? "");
    // L'ADMINISTRATION PASSE PARTOUT, sauf sur les grilles permanentes que le
    // controle ci-dessus a deja mises hors d'atteinte. Un salon laisse ouvert
    // par quelqu'un qui ne reviendra pas encombre la liste, et son createur est
    // le seul a pouvoir le fermer -- ce qui n'arrive jamais.
    if (par !== s.proprietaire && moi?.admin !== true) {
      json(res, 403, { erreur: "seul le créateur du salon peut le supprimer" });
      return;
    }
    for (const [ws, v] of clients) {
      if (v.salon === id) send(ws, { t: "refus", message: "Ce salon a été supprimé" });
    }
    // `fermerSalon` dit lui-meme ce qu'il advient de la partie : conservee si
    // c'est une 15x15 terminee, effacee sinon.
    console.log(`[salon] "${s.nom}" (${id}) supprime par ${par}`);
    await fermerSalon(id);
    json(res, 200, { ok: true });
    return;
  }

  // ------------------------------------------------------------- comptes

  // La fiche publique d'un joueur. Ce qu'elle rend est exactement ce que
  // `publicDuCompte` accepte de dire : ni adresse, ni nom garde prive.
  if (url.startsWith("/api/joueur/") && req.method === "GET") {
    const c = compte(decodeURIComponent(url.slice("/api/joueur/".length)));
    if (c === undefined) { json(res, 404, { erreur: "aucun compte à ce nom" }); return; }
    json(res, 200, { joueur: publicDuCompte(c) });
    return;
  }

  if (url === "/api/moi" && req.method === "GET") {
    const c = quiParle(req);
    json(res, 200, { compte: c === undefined ? null : priveDuCompte(c) });
    return;
  }

  if ((url === "/api/inscription" || url === "/api/connexion") && req.method === "POST") {
    if (tropDEssais(req)) {
      json(res, 429, { erreur: "Trop d'essais, attendez un instant" });
      return;
    }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const pseudo = String(corps.pseudo ?? "").trim();
    const mdp = String(corps.motDePasse ?? "");

    if (url === "/api/inscription") {
      const erreur = await creerCompte(
        pseudo, mdp, String(corps.email ?? ""), corps.avatarSombre === true);
      if (erreur !== null) { json(res, 400, { erreur }); return; }
    } else {
      const c = compte(pseudo);
      // UN SEUL MESSAGE POUR LES DEUX ECHECS : dire « ce pseudo n'existe pas »
      // apprendrait a un curieux quels comptes existent.
      if (c === undefined || !(await motDePasseJuste(c, mdp))) {
        json(res, 401, { erreur: "Pseudo ou mot de passe incorrect" });
        return;
      }
    }
    const c = compte(pseudo)!;
    res.setHeader("set-cookie", cookieDeSession(emettreUnJeton(c), sousHttps(req)));
    json(res, 200, { compte: priveDuCompte(c) });
    return;
  }

  if (url === "/api/deconnexion" && req.method === "POST") {
    res.setHeader("set-cookie", cookieEfface(sousHttps(req)));
    json(res, 200, { ok: true });
    return;
  }

  if (url === "/api/moi" && req.method === "POST") {
    const c = quiParle(req);
    if (c === undefined) { json(res, 401, { erreur: "connectez-vous d'abord" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const erreur = ecrireLeProfil(c, {
      prenom: String(corps.prenom ?? c.prenom),
      nom: String(corps.nom ?? c.nom),
      nomPublic: corps.nomPublic === true,
      email: String(corps.email ?? c.email),
      avatar: Number.isFinite(Number(corps.avatar)) ? Number(corps.avatar) : c.avatar,
      avatarSombre: corps.avatarSombre === true,
    });
    if (erreur !== null) { json(res, 400, { erreur }); return; }
    json(res, 200, { compte: priveDuCompte(c) });
    return;
  }

  // La langue suit le compte : la changer ici, c'est la retrouver ailleurs.
  if (url === "/api/langue" && req.method === "POST") {
    const c = quiParle(req);
    if (c === undefined) { json(res, 401, { erreur: "connectez-vous d'abord" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    ecrireLaLangue(c, String(corps.langue ?? ""));
    json(res, 200, { ok: true });
    return;
  }

  // CHANGER SON MOT DE PASSE DEMANDE L'ANCIEN. Un cookie vole suffirait sinon
  // a s'emparer du compte pour de bon, en fermant la porte a son proprietaire.
  if (url === "/api/motdepasse" && req.method === "POST") {
    const c = quiParle(req);
    if (c === undefined) { json(res, 401, { erreur: "connectez-vous d'abord" }); return; }
    if (tropDEssais(req)) {
      json(res, 429, { erreur: "Trop d'essais, attendez un instant" });
      return;
    }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    if (!(await motDePasseJuste(c, String(corps.ancien ?? "")))) {
      json(res, 403, { erreur: "Mot de passe actuel incorrect" });
      return;
    }
    const erreur = await changerLeMotDePasse(c, String(corps.nouveau ?? ""));
    if (erreur !== null) { json(res, 400, { erreur }); return; }
    // Changer de mot de passe invalide TOUS les jetons anterieurs, y compris le
    // notre : on en remet un neuf, sinon on se deconnecterait soi-meme.
    res.setHeader("set-cookie", cookieDeSession(emettreUnJeton(c), sousHttps(req)));
    console.log(`[comptes] ${c.pseudo} a change son mot de passe`);
    json(res, 200, { ok: true });
    return;
  }

  // Demander un lien de confirmation. Rien ne part pour l'instant : le lien
  // s'ecrit dans la console de l'hote (voir `envoyerLeLienDeVerification`).
  if (url === "/api/email/envoyer" && req.method === "POST") {
    const c = quiParle(req);
    if (c === undefined) { json(res, 401, { erreur: "connectez-vous d'abord" }); return; }
    if (c.emailVerifie) { json(res, 400, { erreur: "Cette adresse est déjà vérifiée" }); return; }
    if (c.email === "") { json(res, 400, { erreur: "Renseignez d'abord une adresse" }); return; }
    if (tropDEssais(req)) { json(res, 429, { erreur: "Trop d'essais, attendez un instant" }); return; }
    const hote = String(req.headers["host"] ?? `localhost:${PORT}`);
    envoyerLeLienDeVerification(c, `${sousHttps(req) ? "https" : "http"}://${hote}`);
    json(res, 200, { ok: true });
    return;
  }

  // La porte que le lien ouvre. Elle ne connecte personne : elle confirme.
  if (url === "/api/email/confirmer" && req.method === "GET") {
    const jeton = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("j") ?? "";
    const erreur = confirmerLAdresse(jeton);
    res.writeHead(302, {
      location: erreur === null ? "/?email=ok" : `/?email=${encodeURIComponent(erreur)}`,
    });
    res.end();
    return;
  }

  // SIGNALER UN BUG. Rien ne part par courriel -- il n'y a pas encore d'adresse
  // -- mais le rapport est garde et s'ecrit dans la console (voir `bugs.ts`).
  //
  // Aucun compte n'est demande : un joueur qui bute sur un bug de la connexion
  // est justement celui qui ne peut pas se connecter pour le dire.
  if (url === "/api/bug" && req.method === "POST") {
    if (tropDEssais(req)) { json(res, 429, { erreur: "Trop d'essais, attendez un instant" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const r = lireLeRapport(corps);
    if (r === null) { json(res, 400, { erreur: "Décrivez ce qui ne va pas" }); return; }
    // LE COMPTE VIENT DU COOKIE, PAS DU FORMULAIRE : le pseudo annonce par le
    // client se raconte, le cookie se verifie.
    r.compte = quiParle(req)?.pseudo ?? "";
    enregistrerLeRapport(r);
    json(res, 200, { ok: true });
    return;
  }

  if (url === "/api/verification" && req.method === "POST") {
    const c = quiParle(req);
    if (c === undefined) { json(res, 401, { erreur: "connectez-vous d'abord" }); return; }
    const erreur = demanderLaVerification(c);
    if (erreur !== null) { json(res, 400, { erreur }); return; }
    console.log(`[comptes] ${c.pseudo} demande la verification sous le nom "${nomComplet(c)}"`);
    json(res, 200, { compte: priveDuCompte(c) });
    return;
  }

  // ------------------------------------------------------- administration

  if (url === "/api/admin/demandes" && req.method === "GET") {
    const c = quiParle(req);
    if (c === undefined || !c.admin) { json(res, 403, { erreur: "réservé" }); return; }
    json(res, 200, {
      demandes: tousLesComptes()
        .filter((v) => v.demande || v.verifie)
        .sort((a, b) => Number(b.demande) - Number(a.demande) || a.demandeLe - b.demandeLe)
        .map((v) => ({
          pseudo: v.pseudo, nomReel: nomComplet(v), nomPublic: v.nomPublic, email: v.email,
          demande: v.demande, verifie: v.verifie, demandeLe: v.demandeLe, cree: v.cree,
        })),
    });
    return;
  }

  if (url === "/api/admin/verdict" && req.method === "POST") {
    const moi = quiParle(req);
    if (moi === undefined || !moi.admin) { json(res, 403, { erreur: "réservé" }); return; }
    let corps: any;
    try { corps = await corpsJson(req); }
    catch { json(res, 400, { erreur: "requête illisible" }); return; }
    const c = compte(String(corps.pseudo ?? ""));
    if (c === undefined) { json(res, 404, { erreur: "compte introuvable" }); return; }
    trancherLaVerification(c, corps.verifie === true, moi.pseudo);
    console.log(`[comptes] ${moi.pseudo} ${corps.verifie === true ? "verifie" : "refuse"} ${c.pseudo}`);
    json(res, 200, { ok: true });
    return;
  }

  // `?d=<id>` choisit le lexique. Sans parametre, le francais : c'est ce que
  // demandaient les clients d'avant les dictionnaires multiples.
  if (url === "/dawg.bin") {
    const demande = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("d");
    const quel = dictionnaireConnu(demande) ? demande! : DICO_PAR_DEFAUT;
    const buf = readFileSync(dawgPath(quel));
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
  // `no-cache` ne veut pas dire « ne garde rien » mais « redemande avant de
  // reservir » : sans cela le navigateur gardait un ancien app.js et une
  // recompilation restait sans effet, ce qui fait passer un correctif pour un
  // bug persistant.
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  res.end(readFileSync(file));
});

// ---------------------------------------------------------------- websocket

/**
 * Le port est deja pris.
 *
 * C'est presque toujours un serveur oublie dans une autre fenetre : une
 * situation ordinaire, pas de quoi deverser vingt lignes de trace ou l'on
 * cherche « EADDRINUSE » au milieu. Le message dit quoi faire, comme celui du
 * verrou.
 *
 * Pose AVANT `ws`, et sur les deux emetteurs. `ws` reporte l'erreur du serveur
 * HTTP sur le sien : un gestionnaire pose apres le sien s'executait trop tard,
 * la trace etait deja jetee.
 */
const surErreurReseau = (e: NodeJS.ErrnoException): void => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(
    `
  Le port ${PORT} est deja pris : un serveur tourne dans une autre fenetre.` +
    `

  Fermez-la, ou prenez un autre port :  npm run serve -- --port ${PORT + 1}` +
    `
  Pour voir qui le tient :  netstat -ano | findstr :${PORT}
`,
  );
  process.exit(1);
};
http.on("error", surErreurReseau);

const wss = new WebSocketServer({ server: http });
wss.on("error", surErreurReseau);

wss.on("connection", (ws, req) => {
  // LE COOKIE VOYAGE AVEC LA POIGNEE DE MAIN : meme origine, meme navigateur.
  // On lit l'identite ICI, une fois, plutot que de la redemander a chaque
  // message.
  const identifie = compteDuJeton(jetonDesEntetes(req.headers.cookie));
  clients.set(ws, { nom: "", salon: "", compte: identifie?.pseudo ?? null });
  debits.set(ws, {
    mots: new Seau(SOUMISSIONS_PAR_SECONDE),
    tout: new Seau(MESSAGES_PAR_SECONDE),
    averti: 0,
  });

  ws.on("message", async (raw) => {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const moi = clients.get(ws);
    if (moi === undefined) return;

    // LE PLAFOND SE POSE ICI, avant de rien faire du message.
    //
    // Un message ignore ne recoit PAS de reponse : repondre a un flot, c'est
    // encore le servir, et cela double le travail qu'on cherchait a eviter. Un
    // seul avertissement par seconde suffit a expliquer a un joueur pourquoi
    // ses mots ne partent plus -- au-dela, le silence.
    const debit = debits.get(ws);
    if (debit !== undefined) {
      const seau = msg.t === "try" ? debit.mots : debit.tout;
      if (!seau.prendre()) {
        const now = Date.now();
        if (msg.t === "try" && now - debit.averti > 1000) {
          debit.averti = now;
          send(ws, { t: "result", ok: false, message: "trop de mots d'un coup" });
        }
        return;
      }
    }

    const s = salon(moi.salon);

    if (msg.t === "join") {
      const inscrit = clients.get(ws)?.compte ?? null;
      // Un compte s'impose au nom annonce : c'est tout l'interet d'en avoir un.
      const demande = String(msg.name ?? "").trim().slice(0, 24) || "anonyme";
      const nom = inscrit ?? demande;
      // UN ANONYME NE PORTE PAS LE PSEUDO DE QUELQU'UN D'INSCRIT. Sans cette
      // regle, creer un compte ne protegerait rien : n'importe qui pourrait
      // encore se presenter sous ce nom-la et jouer a sa place.
      if (inscrit === null && pseudoEnregistre(nom)) {
        send(ws, {
          t: "refus", quoi: "pseudo",
          message: "Ce nom est déjà utilisé : connectez-vous, ou prenez-en un autre",
        });
        return;
      }
      const cible = salon(String(msg.salon ?? GAME_ID));
      if (cible === undefined) {
        // LE MOTIF VOYAGE AVEC LE REFUS. Sans lui, le client ouvrait le voile
        // du pseudo pour n'importe quel refus -- et cliquer un salon disparu
        // demandait de se renommer, ce qui n'a aucun rapport.
        send(ws, {
          t: "refus", quoi: "salon",
          message: pret ? "Ce salon n'existe plus"
            : "Le serveur prépare les parties, réessayez dans un instant",
        });
        return;
      }
      // SALON PRIVE (SPEC.md §26) : le lien ne suffit plus, il faut figurer
      // sur la liste d'invites -- ou etre le proprietaire, ou l'administration.
      if (!peutEntrerDans(cible, nom, compte(clients.get(ws)?.compte ?? "")?.admin === true)) {
        send(ws, { t: "refus", quoi: "salon", message: "Ce salon est privé" });
        return;
      }
      // UN SALON D'EPREUVE (SPEC.md §29) : des comptes seulement, et une fois la
      // manche lancee, ses joueurs seulement. Qui entrerait en cours de partie
      // verrait les tirages d'une partie qu'il n'a pas encore jouee.
      if (cible.epreuve !== null) {
        const estAdmin = compte(inscrit ?? "")?.admin === true;
        // UN DEFI SE JOUE SANS COMPTE (SPEC.md §29) : c'est tout son interet,
        // on l'envoie a quelqu'un qui n'en a pas encore. Une partie du jour et
        // un tournoi, non : leur tentative unique ne tient qu'a un compte.
        const estUnDefi = defiDeLEpreuve(cible.epreuve.epreuve) !== undefined;
        if (inscrit === null && !estAdmin && !estUnDefi) {
          send(ws, { t: "refus", quoi: "salon", message: "Les parties du jour se jouent avec un compte" });
          return;
        }
        const m = cible.epreuve.manche === null ? undefined : mancheParId(cible.epreuve.manche);
        if (m !== undefined && m.fin === null && !m.equipe.includes(nom) && !estAdmin) {
          send(ws, { t: "refus", quoi: "salon", message: "Cette partie se joue sans vous" });
          return;
        }
      }
      // Deux joueurs du meme nom rendent le classement faux et les statistiques
      // inexploitables : on ne saurait plus a qui attribuer un coup. L'unicite
      // vaut PAR SALON, pas sur tout le serveur (SPEC.md §27) : deux onglets du
      // meme compte, dans le meme salon, ne se genent pas -- comme sur la
      // plupart des sites, ou etre connecte a son compte dans deux onglets ne
      // pose pas de question.
      // UN SEUL SALON A LA FOIS, PAR PSEUDO -- meme pour un compte inscrit.
      // Deux onglets dans le meme salon ne servent a rien (on y voit deja
      // tout), et un onglet resterait sinon a regarder un etat mort des qu'un
      // autre a pris la main ailleurs. Rejoindre CE salon remplace donc
      // TOUTE autre connexion du meme nom, ici ou ailleurs -- l'onglet
      // remplace est prevenu plutot que de rester bloque, et revient a
      // l'accueil. Ce qui reste libre : consulter une autre partie du site
      // (records, profil) dans un second onglet, qui ne rejoint aucun salon
      // et n'a donc rien a ceder.
      for (const [c, v] of [...clients.entries()].filter(([c, v]) => c !== ws && v.nom === nom)) {
        send(c, {
          t: "refus", quoi: "salon",
          message: v.salon === cible.id ? "Reconnecté depuis un autre onglet" : "Reconnecté dans un autre salon",
        });
        c.close();
      }
      clients.set(ws, { nom, salon: cible.id, compte: inscrit });
      // Le moteur n'a pas de WebSocket : c'est le transport qui lui dit qui est
      // la. Le duplicate en a besoin pour savoir qui compter sur un coup.
      cible.partie.presents.add(nom);
      majDuGerant(cible);
      void cible.partie.reveiller();
      // Un depart a pu retirer un « pret » : la barre de la rencontre le dit.
      if (rencontreDuSalon(cible.id) !== undefined) {
        broadcast(cible.id, { t: "state", state: publicState(cible) });
      }
      send(ws, {
        t: "hello",
        you: nom,
        epreuve: epreuvePublique(cible),
        gameId: cible.partie.gameId,
        salon: cible.id,
        nomSalon: cible.nom,
        proprietaire: cible.proprietaire,
        gerant: cible.gerant,
        // Le message d'accueil se suffit a lui-meme : le client decide d'ouvrir
        // les reglages AVANT d'avoir applique l'etat, et il lui faut savoir des
        // cette ligne-la si la grille se regle ou non.
        permanent: estPermanent(cible),
        layout: cible.partie.layout,
        // Le client rejoue le calcul du score a chaque frappe : sans la
        // variante, il afficherait la prime d'une autre partie.
        config: serialiser(cible.partie.cfg),
        reveal: REVEAL,
        tiles: cible.partie.tiles(),
        moves: cible.partie.moves.map(publicMove),
        chat: cible.partie.chat,
        // CE QU'IL AVAIT TROUVE AVANT DE FERMER SA PAGE. Sur la grille
        // permanente un coup dure des heures : on revient le lendemain, et sa
        // meilleure solution avait disparu avec l'onglet. Elle ne part qu'a
        // celui qui l'a proposee.
        maSolution: cible.partie.propositionDe(nom),
        state: publicState(cible),
      });
      broadcast(cible.id, { t: "state", state: publicState(cible) });
      return;
    }

    if (s === undefined) return;

    /**
     * Les paliers d'un coup : le top, ses isotops, puis les sous-tops.
     *
     * UNIQUEMENT SUR UNE PARTIE TERMINEE. Pendant qu'elle se joue, cette liste
     * est le jeu lui-meme -- la donner reviendrait a donner la reponse. Une
     * fois la partie close, elle devient ce qui permet de la comprendre.
     */
    if (msg.t === "tiers") {
      if (!s.partie.finie && !REJEU_OUVERT.has(s.id)) {
        send(ws, { t: "tiers", n: Number(msg.n), tiers: null, refus: "partie en cours" });
        return;
      }
      // Garde-fou : on ne montre les paliers que d'un coup DEJA JOUE. Le coup
      // en cours n'en a pas -- et c'est le top que tout le monde cherche.
      if (Number(msg.n) > s.partie.moves.length) {
        send(ws, { t: "tiers", n: Number(msg.n), tiers: null, refus: "coup en cours" });
        return;
      }
      const m = s.partie.moves.find((q) => q.n === Number(msg.n));
      // Tout ce qui est enregistre part, sans nouveau plafond ici. Le plafond
      // est pose une fois pour toutes a la generation (worker.ts) : complet sur
      // un plateau borne, plafonne sur une grille infinie. En recouper un
      // second ici cassait des paliers par le milieu -- on affichait trois
      // coups a 34 points sur les neuf qui existaient, sans le dire.
      //
      // Sur un plateau borne, les paliers ne sont pas au journal : on les refait
      // ici, ce qui prend quelques millisecondes.
      const paliers = await s.partie.paliersDuCoup(Number(msg.n));
      send(ws, {
        t: "tiers", n: Number(msg.n), tiers: paliers,
        rack: m?.notation ?? m?.rack ?? "", mot: m?.word, score: m?.score,
      });
      return;
    }

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
      // La diffusion passe par onChat : inutile de la refaire ici.
      s.partie.say(moi.nom, text, cell);
      return;
    }

    // ------------------------------------------------ la partie d'epreuve
    //
    // LANCER : la tentative de chacun part ici, et pas a l'entree du salon. Seul
    // ou a plusieurs sur un compte, une manche d'un joueur ; avec des comptes
    // invites, une manche d'equipe en topping collaboratif (SPEC.md §29).
    if (msg.t === "epreuve-lancer") {
      const e = s.epreuve;
      if (e === null || e.manche !== null) return;
      if (moi.nom !== e.compte) {
        send(ws, { t: "result", ok: false, message: "seul l'hôte lance la partie" });
        return;
      }
      const presents = occupants(s.id).filter((n) => compte(n) !== undefined);
      // DANS UN TOURNOI A PLUSIEURS, L'EQUIPE EST CELLE DE L'INSCRIPTION : elle
      // joue une feuille, et la tentative de chacun part, meme de qui n'est pas la.
      const t = tournoiDeLEpreuve(e.epreuve);
      const inscription = t === undefined ? undefined : inscriptionDe(t, moi.nom);
      const inscrits = inscription === undefined ? [] : [inscription.compte, ...inscription.partenaires];
      const equipe = [...new Set([moi.nom, ...presents, ...inscrits])];
      for (const nom of equipe) {
        if (mancheDuCompte(nom, e.epreuve, e.partie) !== undefined) {
          send(ws, { t: "result", ok: false, message: `${nom} a déjà joué cette partie` });
          return;
        }
      }
      const jeu: Jeu = equipe.length > 1 ? "equipe" : msg.jeu === "compte" ? "compte" : "seul";
      const m = ouvrirUneManche({
        epreuve: e.epreuve, partie: e.partie, salon: s.id, compte: moi.nom, jeu,
        noms: jeu === "compte" ? String(msg.noms ?? "").trim() : "", equipe,
      });
      e.manche = m.id;
      for (const nom of equipe) s.invites.add(nom);
      // Le decompte est coupe seul, et mis quand des comptes partent ensemble.
      s.partie.decompteImpose = presents.length > 1;
      console.log(`[competitif] "${s.id}" lance par ${moi.nom} (${jeu}, ${equipe.length} compte(s))`);
      await s.partie.demarrer();
      broadcast(s.id, { t: "state", state: publicState(s) });
      return;
    }

    if (msg.t === "pause" || msg.t === "reprendre") {
      const e = s.epreuve;
      const m = e === null || e.manche === null ? undefined : mancheParId(e.manche);
      if (m === undefined || !m.equipe.includes(moi.nom)) return;
      if (msg.t === "pause") s.partie.mettreEnPause(); else s.partie.reprendre();
      return;
    }

    if (msg.t === "try") {
      const r = await s.partie.attempt(
        moi.nom, msg.dir as Dir, Number(msg.x), Number(msg.y), String(msg.typed ?? ""),
      );
      send(ws, { t: "result", ...r });
      return;
    }

    /**
     * LANCER UNE GRILLE PERMANENTE NEUVE.
     *
     * Elle n'appartient a personne, donc personne ne la regle -- et sans ce
     * bouton elle ne partirait jamais. C'est le geste du jour du lancement :
     * l'administration ouvre un compte a rebours, la salle le voit descendre,
     * et le premier tirage tombe a zero devant tout le monde.
     */
    if (msg.t === "lancer") {
      const estAdmin = compte(clients.get(ws)?.compte ?? "")?.admin === true;
      if (!estAdmin) {
        send(ws, { t: "result", ok: false, message: "réservé à l'administration" });
        return;
      }
      if (!estPermanent(s)) {
        send(ws, { t: "result", ok: false, message: "ce salon se règle, il ne se lance pas" });
        return;
      }
      if (!s.partie.lancer(DECOMPTE_LANCEMENT)) {
        send(ws, { t: "result", ok: false, message: "la partie est déjà lancée" });
        return;
      }
      console.log(`[salon] "${s.nom}" lance par ${moi.nom} dans ${DECOMPTE_LANCEMENT} s`);
      broadcast(s.id, { t: "state", state: publicState(s) });
      // A l'echeance, la partie s'ouvre : on rediffuse pour que le tirage
      // apparaisse sans attendre qu'autre chose bouge.
      setTimeout(() => broadcast(s.id, { t: "state", state: publicState(s) }),
        DECOMPTE_LANCEMENT * 1000 + 250);
      return;
    }

    // Relance : reservee a qui tient les manettes -- le createur quand il est
    // la, quelqu'un d'autre en son absence. La grille mondiale n'en a pas, donc
    // personne ne peut la relancer.
    if (msg.t === "relancer") {
      // UNE GRILLE PERMANENTE NE SE RELANCE PAS. Relancer archive la partie en
      // cours et en ouvre une neuve : sur une grille d'etude qui porte des
      // milliers de coups, c'est le geste qu'on ne veut pas voir arriver par
      // megarde. L'ecran cache deja le bouton ; ceci est la regle.
      if (estPermanent(s)) {
        send(ws, { t: "result", ok: false, message: "cette grille est permanente" });
        return;
      }
      if (s.epreuve !== null) {
        send(ws, { t: "result", ok: false, message: "les réglages d'une partie du jour ne changent pas" });
        return;
      }
      if (s.proprietaire === null || s.gerant !== moi.nom) {
        send(ws, { t: "result", ok: false, message: "seul le propriétaire règle le salon" });
        return;
      }
      const base = s.partie.cfg;
      const tirage = Math.max(2, Math.min(15, Number(msg.tirage ?? base.tirage)));
      const jouables = Math.max(2, Math.min(tirage, Number(msg.jouables ?? tirage)));
      const pioche = msg.pioche === "sac102" ? "sac102"
        : msg.pioche === "sac102boucle" ? "sac102boucle"
        : msg.pioche === "probabilites" ? "probabilites" : base.pioche;
      // LA PARTIE JOKER N'A PLUS BESOIN D'UN SAC.
      //
      // Elle etait refusee aux probabilites ponderees, parce que « il ne reste
      // plus de R » n'y a aucun sens : rien ne s'y epuise, donc rien ne pouvait
      // en sortir, donc le joker restait joker et la grille se couvrait de
      // cases mortes -- exactement ce que la variante veut eviter.
      //
      // La lettre nait maintenant, sur toute pioche qui ne s'epuise pas
      // (SPEC.md §16). Le refus n'avait plus d'objet, et il n'etait meme pas
      // dit : l'interrupteur restait allume et la partie demarrait sans joker.
      const joker = msg.joker === true;
      // Le lexique, et ce qui vient avec : la valeur des lettres et le sac.
      const dico = dictionnaireConnu(msg.dictionnaire)
        ? String(msg.dictionnaire) : base.dictionnaire;
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
      // Une seconde au moins : le chrono ne part qu'APRES le calcul du top, donc
      // rien n'oblige a laisser du temps au serveur.
      const mode = msg.mode === "duplicate" ? "duplicate" as const : "topping" as const;
      // CE QUE LE MESSAGE NE DIT PAS NE CHANGE PAS. Une relance qui omet un
      // reglage -- « Rejouer », un client plus ancien -- gardait la valeur par
      // defaut plutot que celle de la partie, et l'eteignait donc en silence.
      const decompte = msg.decompte === undefined ? base.decompte : msg.decompte === true;
      // Reserve au topping : le duplicate compte des points, il n'a rien a
      // taire au classement.
      const toppingCollaboratif = mode === "topping"
        && (msg.toppingCollaboratif === undefined ? base.toppingCollaboratif : msg.toppingCollaboratif === true);
      // Les deux bornes s'excluent : une partie a deux termes concurrents ne
      // saurait pas lequel respecter.
      const coupsMax = msg.coupsMax === null || msg.coupsMax === undefined ? null
        : Math.max(1, Math.min(9999, Math.round(Number(msg.coupsMax))));
      const dureeMax = msg.dureeMax === null || msg.dureeMax === undefined ? null
        : Math.max(10, Math.min(86400, Math.round(Number(msg.dureeMax))));
      let chrono = msg.chrono === null || msg.chrono === undefined ? null
        : Math.max(1, Math.min(3600, Math.round(Number(msg.chrono))));
      const estAdmin = compte(clients.get(ws)?.compte ?? "")?.admin === true;
      // Sans chrono, un coup de duplicate ne se terminerait jamais : c'est
      // l'echeance qui le clot, pas la decouverte du top.
      if (mode === "duplicate" && chrono === null) chrono = 60;
      // Changer de grille change aussi le pavage : le plateau du commerce n'a
      // de sens que borne, le pavage infini que sans bord.
      // `null` VEUT DIRE quelque chose ici -- la grille infinie -- et ne peut
      // donc pas signifier « non fourni ». Seule l'absence de la cle laisse le
      // reglage inchange.
      const bornes = msg.bornes === undefined ? base.bornes
        : msg.bornes === null ? null
        : Math.max(3, Math.min(60, Math.round(Number(msg.bornes))));
      // Une grille de plus sans bord ? Seulement s'il reste de la place.
      if (bornes === null && base.bornes !== null
          && comptedesInfinies(s.id) >= MAX_INFINIES) {
        send(ws, {
          t: "result", ok: false,
          message: `Trop de grilles infinies ouvertes (${MAX_INFINIES}). Réessayez plus tard.`,
        });
        return;
      }
      // LE PAVAGE DECOULE DE LA GRILLE, ET DE RIEN D'AUTRE : le plateau du
      // commerce n'a de sens que borne a sept, la super grille qu'a dix, le
      // pavage infini que sans bord. Le client n'a donc pas de pavage a
      // envoyer, et ne peut pas en demander un qui ne va pas avec sa grille.
      const pavage = bornes === null ? LAYOUTS[s.layout]
        : bornes === SUPER_BORNES ? LAYOUTS.super21 : LAYOUTS.classique15;
      const pavageNom = bornes === null ? s.layout
        : bornes === SUPER_BORNES ? "super21" as const : "classique15" as const;
      // LE DOUBLE SAC VA AVEC LA SUPER GRILLE, comme le pavage. 441 cases ne se
      // remplissent pas avec 102 caramels : le plateau resterait au quart plein
      // et la partie s'arreterait avant d'avoir commence. Le client n'a donc
      // rien a envoyer, et ne peut pas demander un sac qui ne va pas avec sa
      // grille.
      const sacs = bornes === SUPER_BORNES ? 2 : 1;
      // DEUX JOKERS PAR COUP, ET SEULEMENT SUR UNE GRILLE BORNEE. Le temps de
      // recherche du top croit vite avec le nombre de jokers, et une grille sans
      // fin le paie deja au prix fort : sur elle, la variante est ramenee a un
      // joker plutot que refusee, pour qu'un client d'une autre version ne
      // puisse pas mettre le serveur a genoux.
      const jokersDemandes = Math.max(1, Math.min(2, Math.round(Number(msg.jokersParCoup ?? 1)) || 1));
      // Et jamais plus de jokers que le tirage n'a de place, moins une lettre :
      // un chevalet fait de jokers seuls ne se joue pas.
      const jokersParCoup = bornes === null ? 1 : Math.min(jokersDemandes, Math.max(1, tirage - 1));
      // Le sac sans fin ne vaut que sur une grille infinie.
      const pioch = bornes !== null && pioche === "sac102boucle" ? "sac102" : pioche;
      // LA MONTANTE : six parties en topping, a la suite (SPEC.md §23). Elle
      // impose le format et le joker de chaque etape, et ne laisse reglables
      // que le chrono, le lexique et la grille.
      const montante = msg.montante === true;
      // Une grille sans fin n'a pas de bout, donc pas d'etape suivante. Le
      // client eteint deja le bouton ; ceci est la regle.
      if (montante && !montantePossible(bornes)) {
        send(ws, {
          t: "result", ok: false,
          message: "La montante demande une grille bornée : elle va jusqu'au bout du sac.",
        });
        return;
      }
      // Un plateau borne s'arrete quand le sac se vide, et le sac de 102 aussi :
      // leur poser un terme en donnerait DEUX, et la partie s'arreterait au
      // premier atteint sans qu'on sache lequel. Ces deux-la n'en ont pas.
      const sansTerme = bornes !== null || pioch === "sac102";
      const voulue = avec(avecDictionnaire(base, dico), {
        tirage, jouables, joker, jokersParCoup,
        pioche: pioch, sacs,
        bornes, pavage, pavageNom, mode, decompte, toppingCollaboratif,
        coupsMax: !sansTerme && Number.isFinite(coupsMax as number) ? coupsMax : null,
        dureeMax: !sansTerme && Number.isFinite(dureeMax as number) ? dureeMax : null,
        chrono: Number.isFinite(chrono as number) ? chrono : null,
        primes: Object.keys(primes).length > 0 ? primes : base.primes,
      });
      // L'ETAPE 1 PAR-DESSUS LE RESTE. Ce que le panneau a envoye comme format,
      // comme joker, comme primes ou comme terme ne survit pas au lancement
      // d'une montante : la suite les impose, et chaque etape doit pouvoir
      // porter un record.
      const cfgVoulue = montante ? configDeLEtape(voulue, 1) : voulue;
      // UN CHRONO TRES COURT COUTE CHER AU SERVEUR, PAS AU JOUEUR : chaque coup
      // demande un calcul de top complet, et quinze secondes par coup, c'est
      // deja quatre calculs par minute et par salon. L'administration garde la
      // main pour ses essais.
      //
      // LE PLANCHER S'ABAISSE SUR LA PARTIE NORMALE, et sur elle seule : c'est
      // la que se joue le record de chrono (SPEC.md §23). Le controle se fait
      // donc ICI, sur la configuration entiere, et non sur le chrono seul --
      // il ne se decide pas sans savoir quelle grille et quel format
      // l'accompagnent.
      //
      // LA MONTANTE PREND LE PLANCHER DE SON ETAPE LA PLUS CHERE, et non celui
      // de la premiere. Son etape 1 EST la partie normale : sans cette ligne,
      // elle ouvrirait a une seconde par coup une 7 et 8 joker qu'aucun reglage
      // ne permet par ailleurs.
      const plancher = !montante && estPartieNormale(cfgVoulue)
        ? CHRONO_MINIMUM_RECORD : CHRONO_MINIMUM;
      if (!estAdmin && cfgVoulue.chrono !== null && cfgVoulue.chrono < plancher) {
        send(ws, {
          t: "result", ok: false,
          message: `Le temps par coup ne descend pas sous ${plancher} seconde`
            + `${plancher > 1 ? "s" : ""}`,
        });
        return;
      }
      // LA MONTANTE SE POSE AVANT LA RELANCE : c'est elle qui met sa marque
      // dans l'en-tete du journal de l'etape qui demarre. Valider des reglages
      // sans montante en termine une : la suite n'a pas de sens si sa variante
      // change en chemin.
      s.montante = montante ? nouvelleMontante() : null;
      const archives = await relancerEtDiffuser(s, cfgVoulue);
      console.log(`[salon] "${s.nom}" relance par ${moi.nom} : `
        + `${montante ? `montante, etape 1 (${etapeMontante(1).nom})`
          : `${cfgVoulue.jouables} sur ${cfgVoulue.tirage}`}, `
        + `pioche ${pioche}, ${dico}`
        + `${archives.length > 0 ? ` (ancienne partie archivee)` : ""}`);
      return;
    }

    // ------------------------------------------- salon prive, et invitations
    //
    // Deux reglages DU SALON, pas de la partie (SPEC.md §26) : ils survivent a
    // une relance, et n'exigent pas d'archiver la partie en cours pour
    // prendre effet -- contrairement au reste des reglages, qui passe par
    // "relancer" plus haut.
    if (msg.t === "salonPrive") {
      if (s.epreuve !== null) return;
      const estAdmin = compte(clients.get(ws)?.compte ?? "")?.admin === true;
      if (!estAdmin && s.gerant !== moi.nom) {
        send(ws, { t: "result", ok: false, message: "seul l'hôte règle la confidentialité du salon" });
        return;
      }
      s.prive = msg.prive === true;
      broadcast(s.id, { t: "state", state: publicState(s) });
      return;
    }

    if (msg.t === "connectes") {
      // TOUS LES SALONS CONFONDUS : c'est la liste que la fenetre d'invitation
      // propose, pas seulement qui est deja ici.
      send(ws, { t: "connectes", noms: tousLesConnectes() });
      return;
    }

    if (msg.t === "inviter") {
      // Une manche lancee ne prend plus personne : ses joueurs sont fixes.
      if (s.epreuve !== null && s.epreuve.manche !== null) return;
      const estAdmin = compte(clients.get(ws)?.compte ?? "")?.admin === true;
      if (!estAdmin && s.gerant !== moi.nom) {
        send(ws, { t: "result", ok: false, message: "seul l'hôte invite dans le salon" });
        return;
      }
      const invite = String(msg.pseudo ?? "").trim().slice(0, 24);
      if (invite === "" || invite === moi.nom) return;
      s.invites.add(invite);
      // PREVENU TOUT DE SUITE s'il est deja connecte quelque part : inutile
      // qu'il pense lui-meme a revenir sur ce salon precis pour le decouvrir.
      for (const c of socketsDe(invite)) send(c, { t: "invite", salon: s.id, nomSalon: s.nom });
      // ET LA NOTIFICATION LE RATTRAPE AILLEURS (SPEC.md §29) : un client n'a de
      // liaison qu'en salon, et l'invitation ne trouvait personne hors d'un.
      const invitee = compte(invite);
      if (invitee !== undefined) {
        notifier(invitee.pseudo, "salon", { salon: s.id, nom: s.nom, de: moi.nom });
      }
      send(ws, { t: "result", ok: true, message: `${invite} peut désormais rejoindre` });
      return;
    }

    // ------------------------------------------- abandonner un coup, ou la partie
    //
    // Reserves au topping sur grille finie (SPEC.md §24-25) : au duplicate, ou
    // sur une grille sans fin, le bouton ne s'affiche pas -- mais un message
    // force reste possible, donc on revalide ici, pas seulement cote client.
    // « JE SUIS PRET » (SPEC.md §29) : la rencontre attend les deux camps.
    if (msg.t === "pret") {
      const rc = rencontreDuSalon(s.id);
      if (rc === undefined || s.partie.demarree || s.partie.finie) return;
      const t = tournoi(rc.rencontre.tournoi);
      if (t === undefined) return;
      if (campDuCompte(t, rc.rencontre, moi.nom) < 0) {
        send(ws, { t: "result", ok: false, message: "cette rencontre se joue sans vous" });
        return;
      }
      const prets = pretsDeRencontre.get(s.id) ?? new Set<string>();
      if (prets.has(moi.nom)) prets.delete(moi.nom); else prets.add(moi.nom);
      pretsDeRencontre.set(s.id, prets);
      lancerLaRencontreSiLesDeuxSontPrets(s);
      broadcast(s.id, { t: "state", state: publicState(s) });
      return;
    }

    if (msg.t === "abandonnerCoup" || msg.t === "abandonnerPartie") {
      // JAMAIS SUR UN SALON PERMANENT (la grille mondiale) : c'est LA partie
      // du site, et ce veto passe avant tout le reste, administration
      // comprise -- voir main.ts, qui cache deja les boutons pour la meme
      // raison.
      if (estPermanent(s)) {
        send(ws, { t: "result", ok: false, message: "cette action n'est pas proposée ici" });
        return;
      }
      const estAdmin = compte(clients.get(ws)?.compte ?? "")?.admin === true;
      const cfg = s.partie.cfg;
      const proposeIci = cfg.mode !== "duplicate" && cfg.bornes !== null;
      if (!estAdmin && !proposeIci) {
        send(ws, { t: "result", ok: false, message: "cette action n'est pas proposée ici" });
        return;
      }
      if (msg.t === "abandonnerCoup") {
        // SEUL : la table entiere, pas seulement celui qui demande.
        if (!estAdmin && occupants(s.id).length > 1) {
          send(ws, { t: "result", ok: false, message: "un autre joueur est présent" });
          return;
        }
        await s.partie.abandonnerLeCoup();
        return;
      }
      // UNE MANCHE NE S'ABANDONNE PAS, meme par l'administration : elle ne
      // serait pas enregistree, et le geste ne servirait qu'a perdre sa
      // tentative (SPEC.md §29).
      if (s.epreuve !== null) {
        send(ws, { t: "result", ok: false, message: "cette action n'est pas proposée ici" });
        return;
      }
      // ABANDONNER LA PARTIE : reserve a l'hote, ou un administrateur -- et
      // seulement une fois un coup manque, sauf pour l'administration.
      if (!estAdmin && s.gerant !== moi.nom) {
        send(ws, { t: "result", ok: false, message: "seul l'hôte abandonne la partie" });
        return;
      }
      if (!estAdmin && !s.partie.moves.some((m) => m.player === null)) {
        send(ws, { t: "result", ok: false, message: "aucun coup manqué pour l'instant" });
        return;
      }
      await s.partie.abandonnerLaPartie();
      return;
    }

    // ------------------------------------------------------------ la montante
    //
    // TROIS GESTES, ET TOUS LES TROIS SONT A L'HOTE. Lancer l'etape suivante,
    // recommencer une etape ratee, terminer la suite. Voir SPEC.md §23.
    if (msg.t === "montante-suivante" || msg.t === "montante-reprendre"
        || msg.t === "montante-terminer" || msg.t === "montante-pause") {
      const m = s.montante;
      if (m === null) {
        send(ws, { t: "result", ok: false, message: "ce salon ne joue pas de montante" });
        return;
      }
      if (estPermanent(s) || s.proprietaire === null || s.gerant !== moi.nom) {
        send(ws, { t: "result", ok: false, message: "seul l'hôte mène la montante" });
        return;
      }

      // LA PAUSE : l'hote decide si la montante s'arrete entre deux parties.
      // L'eteindre alors qu'une etape close attend relance la suite aussitot.
      if (msg.t === "montante-pause") {
        // UN GESTE DE L'HOTE N'EST PLUS UNE PAUSE AUTOMATIQUE, qu'il l'allume
        // ou qu'il l'eteigne : c'est desormais son choix, et une reprise
        // d'etape ne l'effacera plus (voir `reprendreLEtape`, SPEC.md §23).
        m.pause = msg.pause === true;
        m.pauseAuto = false;
        console.log(`[montante] "${s.nom}" pause entre les parties : `
          + `${m.pause ? "oui" : "non"}`);
        broadcast(s.id, { t: "state", state: publicState(s) });
        if (!m.pause) enchainerLEtapeSuivante(s);
        return;
      }

      // TERMINER : la sixieme etape est close, et l'hote renonce a reprendre
      // celle qui lui etait offerte. La ligne part au journal telle quelle.
      if (msg.t === "montante-terminer") {
        if (!montanteAchevable(m)) {
          send(ws, { t: "result", ok: false, message: "la montante n'est pas à son terme" });
          return;
        }
        acheverLaMontante(s);
        broadcast(s.id, { t: "state", state: publicState(s) });
        return;
      }

      // REPRENDRE : l'etape en cours, si elle porte encore un coup rate.
      if (msg.t === "montante-reprendre") {
        const vue = s.vue?.etape();
        const rang = etapeReprenable(m, vue);
        if (rang === null) {
          send(ws, {
            t: "result", ok: false,
            message: "cette étape ne se reprend plus",
          });
          return;
        }
        // LE TEMPS DE LA TENTATIVE ABANDONNEE RESTE AU COMPTEUR (SPEC.md §23).
        // Une etape reprise en pleine partie ne passe pas par `onFin` : son
        // essai n'existerait donc pas, et son temps s'evaporerait -- ce qui
        // rendrait la reprise gratuite, et le tableau ne classerait plus que
        // la patience.
        if (!m.close && vue !== undefined) cloreLEtape(m, vue);
        if (reprendreLEtape(m, rang, vue) === null) {
          send(ws, { t: "result", ok: false, message: "cette étape ne se reprend plus" });
          return;
        }
        await relancerEtDiffuser(s, configDeLEtape(s.partie.cfg, rang));
        console.log(`[montante] "${s.nom}" reprend l'etape ${rang} `
          + `(${etapeMontante(rang).nom}), essai ${m.essai}`);
        return;
      }

      // SUIVANTE : l'etape en cours est close, et il en reste une.
      if (!m.close || !ilResteUneEtape(m)) {
        send(ws, { t: "result", ok: false, message: "l'étape en cours n'est pas terminée" });
        return;
      }
      const rang = passerALEtapeSuivante(m);
      if (rang === null) {
        send(ws, { t: "result", ok: false, message: "la montante est terminée" });
        return;
      }
      await relancerEtDiffuser(s, configDeLEtape(s.partie.cfg, rang));
      console.log(`[montante] "${s.nom}" passe a l'etape ${rang} `
        + `(${etapeMontante(rang).nom})`);
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
    debits.delete(ws);
    const s = moi ? salon(moi.salon) : undefined;
    if (s === undefined) return;
    if (moi !== undefined && !occupants(s.id).includes(moi.nom)) {
      s.partie.presents.delete(moi.nom);
    }
    majDuGerant(s);
    // Le dernier parti, la partie s'endort : plus de chrono, plus de calcul.
    //
    // LA GRILLE PERMANENTE, ELLE, NE DORT PAS. Elle n'appartient a personne et
    // son temps SE COMPTE : un coup y dure ce qu'il dure, la nuit comprise,
    // meme quand plus personne ne regarde. C'est une grille universelle a
    // effort commun -- « ce coup a resiste trois jours » n'aurait aucun sens si
    // l'horloge s'arretait des que la salle se vide, et c'est pourtant ce que
    // sa sonnerie annonce.
    //
    // Elle n'a pas de chrono : ne pas l'endormir ne devore donc aucun coup. Un
    // salon ordinaire s'endort, lui, pour cette raison exacte.
    if (occupants(s.id).length === 0) {
      if (s.proprietaire !== null) {
        s.partie.endormir();
        console.log(`[salon] "${s.nom}" s'endort, plus personne`);
        if (s.partie.cfg.bornes !== null) rangerPlusTard(s.id);
      }
    }
    broadcast(s.id, { t: "state", state: publicState(s) });
  });
});

/**
 * Un salon 15x15 vide se referme tout seul.
 *
 * Une partie bornee tient dans une seance : personne n'y revient le lendemain.
 * La laisser au registre encombre la liste et garde un fil de calcul pour rien.
 *
 * Pas tout de suite, cependant : recharger sa page, c'est se deconnecter une
 * demi-seconde. Fermer sur-le-champ detruirait le salon sous les pieds de celui
 * qui vient d'appuyer sur F5. On attend donc, et on verifie a nouveau.
 */
/**
 * Assez pour un F5, trop court pour qu'on aille se faire un cafe : le salon
 * disparait avant qu'on ait pense a y revenir, et c'est ce qu'on veut.
 */
const DELAI_DE_RANGEMENT = 90_000;
const rangements = new Map<string, ReturnType<typeof setTimeout>>();

function rangerPlusTard(id: string): void {
  const dejaPrevu = rangements.get(id);
  if (dejaPrevu !== undefined) clearTimeout(dejaPrevu);
  rangements.set(id, setTimeout(() => {
    rangements.delete(id);
    const s = salon(id);
    if (s === undefined || s.proprietaire === null) return;
    if (occupants(id).length > 0) return;   // quelqu'un est revenu
    if (s.partie.cfg.bornes === null) return;
    void fermerSalon(id);
  }, DELAI_DE_RANGEMENT));
}

// ---------------------------------------------------------------- arret

// Les verrous doivent partir quand le serveur s'arrete, quelle qu'en soit la
// raison. Un SIGKILL ne laisse rien passer : ils restent, et le prochain
// demarrage les reconnait comme perimes puisque leur processus n'existe plus.
const rendreLesVerrous = (): void => {
  for (const s of tousLesSalons()) {
    // Une manche qui joue s'ecrit en pause : elle reprendra au temps qu'elle avait.
    s.partie.pauseDArret();
    s.partie.releaseLock();
  }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  process.on(signal, () => { rendreLesVerrous(); process.exit(0); });
}
process.on("exit", rendreLesVerrous);
process.on("uncaughtException", (e) => { rendreLesVerrous(); throw e; });

http.listen(PORT, () => {
  console.log(`
  Grille "${GAME_ID}" sur le pavage "${LAYOUT}"`);
  // `--partie` remplace la grille PERMANENTE par celle qu'on nomme : elle en
  // prend la place, le nom, et se remet a jouer avec SES reglages. Sans le
  // dire, on croit consulter une archive alors qu'on l'a mise en service.
  if (GAME_ID !== "mondiale") {
    console.log(`
  ATTENTION : "${GAME_ID}" occupe la place de la grille permanente.
  Elle rejoue avec ses propres reglages, chrono compris.
  Pour rendre la place a la grille permanente :  npm run serve`);
  }
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Pour ouvrir aux autres :  cloudflared tunnel --url http://localhost:${PORT}`);
  if (REVEAL) console.log('  mode --reveler : le bouton "révéler le top" est visible');
  lireLesComptes();
  ouvrirLesRecords();
  ouvrirLeCompetitif();
  ouvrirLesNotifications();
  ouvrirLHistorique();
  void assurerLesAdmins(ADMINS, ADMIN_MDP);

  console.log(`
  preparation des parties...`);
  // On sert la page tout de suite ; les parties se preparent ensuite. Calculer
  // le top d'un gros tirage sur une grande grille prend des minutes, et faire
  // attendre le site pendant ce temps donnait un serveur injoignable.
  void ouvrirLesSalons();
  // LES PARTIES DU JOUR SE FIGENT EN ARRIERE-PLAN : aujourd'hui et demain, puis
  // toutes les dix minutes, pour que le changement de jour les trouve pretes.
  const figer = (): void => {
    void assurerLesPartiesDuJour(LAYOUT)
      .then(() => assurerLesTournoisDeLaSemaine(LAYOUT))
      .then(() => prevenirLesTournoisQuiCommencent())
      .then(() => rappelerLesRencontres())
      .catch((e) =>
        console.error(`[competitif] parties du jour non figees : ${(e as Error).message}`));
  };
  figer();
  setInterval(figer, 10 * 60_000).unref();
});
