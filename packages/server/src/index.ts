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
  salonsEnregistres, fermerSalon, identifiantPris, slug, nomAuHasard,
  confierLesReglages, MAX_SALONS, type Salon,
} from "./salons.ts";
import { LAYOUTS } from "../../engine/src/bonus.ts";
import { avec, configParDefaut, deserialiser, serialiser } from "../../engine/src/config.ts";
import { setLayout } from "../../engine/src/bonus.ts";
import type { LayoutName } from "../../engine/src/bonus.ts";
import type { Dir } from "../../engine/src/coords.ts";
import { DAWG_PATH } from "../../engine/src/paths.ts";
import { Seau, seauDeRafale, SOUMISSIONS_PAR_SECONDE, MESSAGES_PAR_SECONDE } from "./debit.ts";
import {
  lireLesComptes, creerCompte, compte, motDePasseJuste, changerLeMotDePasse,
  ecrireLeProfil, demanderLaVerification, trancherLaVerification, tousLesComptes,
  emettreUnJeton, compteDuJeton, jetonDesEntetes, cookieDeSession, cookieEfface,
  publicDuCompte, priveDuCompte, pseudoEnregistre, assurerLesAdmins, cleDuPseudo,
  nomComplet, type Compte,
} from "./comptes.ts";

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
    sac: g.restantDuSac(),
    finie: g.finie,
    solving: g.solving,
    actif: g.actif,
    demarree: g.demarree,
    coupsMax: g.cfg.coupsMax,
    dureeMax: g.cfg.dureeMax,
    debutDeLaPartie: g.debutDeLaPartie,
    decompteJusqua: g.decompteJusqua,
    servedAt: g.servedAt,
    chrono: g.cfg.chrono,
    mode: g.cfg.mode,
    players: g.players,
    nonTrouves: g.nonTrouves,
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
  // La grille permanente n'a pas de proprietaire pour la regler : elle demarre
  // d'office, elle est le jeu par defaut du site.
  salonMondial.partie.demarree = true;

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

const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url ?? "/").split("?")[0]!;

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
        layout: LAYOUT, cfg: configDeDepart(false), nouveau: true,
      });
      surveiller(s);
      console.log(`[salon] "${s.nom}" (${s.id}) ouvert par ${proprietaire} : ` +
        `${s.partie.cfg.bornes === null ? "grille infinie" : "15x15"}`);
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
      json(res, 403, {
        erreur: s.proprietaire === null
          ? "le salon Topping infini est permanent"
          : `le salon « ${s.nom} » est permanent`,
      });
      return;
    }
    // Le cookie fait foi quand il y en a un ; l'en-tete ne sert plus qu'aux
    // joueurs sans compte, pour qui il n'a jamais ete qu'un garde-fou.
    const par = quiParle(req)?.pseudo ?? String(req.headers["x-pseudo"] ?? "");
    if (par !== s.proprietaire) {
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
          t: "refus",
          message: "Ce pseudo appartient à un compte : connectez-vous, ou prenez-en un autre",
        });
        return;
      }
      const cible = salon(String(msg.salon ?? GAME_ID));
      if (cible === undefined) {
        send(ws, {
          t: "refus",
          message: pret ? "Ce salon n'existe plus"
            : "Le serveur prépare les parties, réessayez dans un instant",
        });
        return;
      }
      // Deux joueurs du meme nom rendent le classement faux et les statistiques
      // inexploitables : on ne saurait plus a qui attribuer un coup. L'unicite
      // vaut parmi les connectes, ET parmi les pseudos inscrits -- un compte
      // reserve son nom meme quand son porteur n'est pas la.
      const pris = [...clients.entries()].some(([c, v]) => c !== ws && v.nom === nom);
      if (pris) {
        send(ws, { t: "refus", message: "Ce nom d'utilisateur n'est pas disponible" });
        return;
      }
      clients.set(ws, { nom, salon: cible.id, compte: inscrit });
      // Le moteur n'a pas de WebSocket : c'est le transport qui lui dit qui est
      // la. Le duplicate en a besoin pour savoir qui compter sur un coup.
      cible.partie.presents.add(nom);
      majDuGerant(cible);
      void cible.partie.reveiller();
      send(ws, {
        t: "hello",
        you: nom,
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

    if (msg.t === "try") {
      const r = await s.partie.attempt(
        moi.nom, msg.dir as Dir, Number(msg.x), Number(msg.y), String(msg.typed ?? ""),
      );
      send(ws, { t: "result", ...r });
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
      // Une seconde au moins : le chrono ne part qu'APRES le calcul du top, donc
      // rien n'oblige a laisser du temps au serveur.
      const mode = msg.mode === "duplicate" ? "duplicate" as const : "topping" as const;
      const decompte = msg.decompte === true;
      // Les deux bornes s'excluent : une partie a deux termes concurrents ne
      // saurait pas lequel respecter.
      const coupsMax = msg.coupsMax === null || msg.coupsMax === undefined ? null
        : Math.max(1, Math.min(9999, Math.round(Number(msg.coupsMax))));
      const dureeMax = msg.dureeMax === null || msg.dureeMax === undefined ? null
        : Math.max(10, Math.min(86400, Math.round(Number(msg.dureeMax))));
      let chrono = msg.chrono === null || msg.chrono === undefined ? null
        : Math.max(1, Math.min(3600, Math.round(Number(msg.chrono))));
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
      const pavage = bornes === null ? LAYOUTS[s.layout] : LAYOUTS.classique15;
      const pavageNom = bornes === null ? s.layout : "classique15" as const;
      // Le sac sans fin ne vaut que sur une grille infinie.
      const pioch = bornes !== null && pioche === "sac102boucle" ? "sac102" : pioche;
      // Un plateau borne s'arrete quand le sac se vide, et le sac de 102 aussi :
      // leur poser un terme en donnerait DEUX, et la partie s'arreterait au
      // premier atteint sans qu'on sache lequel. Ces deux-la n'en ont pas.
      const sansTerme = bornes !== null || pioch === "sac102";
      const archives = await relancer(s, avec(base, {
        tirage, jouables, joker,
        pioche: pioch,
        bornes, pavage, pavageNom, mode, decompte,
        coupsMax: !sansTerme && Number.isFinite(coupsMax as number) ? coupsMax : null,
        dureeMax: !sansTerme && Number.isFinite(dureeMax as number) ? dureeMax : null,
        chrono: Number.isFinite(chrono as number) ? chrono : null,
        primes: Object.keys(primes).length > 0 ? primes : base.primes,
      }));
      surveiller(s);
      // La partie neuve nait endormie ET ignorante de qui est la : on lui rend
      // les deux, sinon le duplicate ne compterait personne sur son premier coup.
      for (const nom of occupants(s.id)) s.partie.presents.add(nom);
      if (occupants(s.id).length > 0) await s.partie.reveiller();
      // Valider les reglages, c'est lancer la partie.
      await s.partie.demarrer();
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
  for (const s of tousLesSalons()) s.partie.releaseLock();
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
  void assurerLesAdmins(ADMINS, ADMIN_MDP);

  console.log(`
  preparation des parties...`);
  // On sert la page tout de suite ; les parties se preparent ensuite. Calculer
  // le top d'un gros tirage sur une grande grille prend des minutes, et faire
  // attendre le site pendant ce temps donnait un serveur injoignable.
  void ouvrirLesSalons();
});
