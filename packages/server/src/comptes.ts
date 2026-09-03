/**
 * Les comptes. Voir SPEC.md §8.
 *
 * UN COMPTE EST OPTIONNEL. On joue sans, comme depuis toujours : le pseudo
 * suffit. Ce que le compte ajoute, c'est que le serveur cesse de croire le
 * client sur parole. Sans compte, `join` annonce un nom et le serveur le prend
 * tel quel ; avec un compte, l'identite se lit dans un cookie que le serveur a
 * signe lui-meme, et le nom annonce par le client est ignore.
 *
 * LE JOURNAL FAIT FOI, comme pour les parties et les salons. Les comptes vivent
 * dans `comptes.journal.jsonl`, en ajout seul, `fsync` a chaque ligne, jamais
 * reecrit : un compte cree est un compte qui survit a tout, y compris a une
 * coupure au mauvais moment. La memoire n'en est qu'un index, reconstruit au
 * demarrage. C'est aussi ce qui rend une sauvegarde triviale -- un fichier
 * texte a copier -- et une migration lisible : chaque ligne se relit a l'oeil.
 */
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes, scrypt as scryptBrut, timingSafeEqual, createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(scryptBrut) as (
  mdp: string, sel: Buffer, taille: number, opts: Record<string, number>
) => Promise<Buffer>;

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const JOURNAL = join(DATA_DIR, "comptes.journal.jsonl");
const CLE_SESSION = join(DATA_DIR, "session.cle");

/**
 * LE COUT DU HACHAGE, ET POURQUOI CELUI-LA.
 *
 * `scrypt` est livre avec Node : aucune dependance a compiler sur la machine
 * d'hebergement, donc rien qui puisse manquer le jour du deploiement. Il est
 * couteux en MEMOIRE autant qu'en temps, ce qui est justement ce qui met en
 * echec les cartes graphiques d'un attaquant.
 *
 * N = 2^15 demande 32 Mo et une centaine de millisecondes par essai. C'est
 * insensible pour qui se connecte une fois, et c'est ruineux pour qui essaie un
 * dictionnaire -- d'autant que `debit.ts` limite deja les tentatives.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const TAILLE_HASH = 64;

/** Deux mois : assez pour ne pas redemander sans cesse, assez court pour peser. */
const DUREE_SESSION = 60 * 24 * 3600 * 1000;

/** Le plus court mot de passe qu'on accepte. En dessous, ce n'est pas un secret. */
export const MDP_MINIMUM = 8;

export interface Compte {
  /** Le pseudo tel qu'il s'ecrit, avec ses majuscules et ses accents. */
  pseudo: string;
  hash: string;
  sel: string;
  cree: number;
  /**
   * Quand le mot de passe a change pour la derniere fois.
   *
   * Les jetons de session sont signes, pas stockes : on ne peut donc pas en
   * effacer un. Mais on peut refuser tous ceux qui ont ete emis AVANT ce
   * moment-la, ce qui deconnecte partout des qu'on change son mot de passe.
   */
  mdpChangeLe: number;
  /**
   * L'ADRESSE, ET RIEN QU'ELLE.
   *
   * Tant qu'on ne sait pas envoyer de courriel, elle ne sert a rien
   * automatiquement : elle sert a RETROUVER quelqu'un. Un compte dont le mot de
   * passe est oublie et dont on ne connait pas le porteur est un compte perdu,
   * et son pseudo avec lui. C'est pour cela qu'elle est demandee des
   * maintenant, avant meme qu'il y ait de quoi s'en servir.
   *
   * Elle ne sort jamais vers les autres joueurs : son porteur et
   * l'administration, personne d'autre.
   */
  email: string;
  admin: boolean;
  /**
   * LE NOM EN DEUX CHAMPS, ET NON UN SEUL.
   *
   * Un « Jean-Baptiste de La Tour » ne se coupe pas a la premiere espace, et
   * personne ne sait dire, d'un nom compose ecrit d'un trait, ou finit le
   * prenom. On demande donc les deux, et l'on ne devine rien.
   *
   * Prive par defaut : on peut etre verifie sans que son nom paraisse. La
   * verification dit « cette personne est bien qui elle pretend etre », elle
   * n'oblige personne a s'afficher.
   */
  prenom: string;
  nom: string;
  nomPublic: boolean;
  /** Une demande de verification deposee, et pas encore tranchee. */
  demande: boolean;
  demandeLe: number;
  verifie: boolean;
  /** La graine de l'avatar : un pave de la grille, propre a chacun. */
  avatar: number;
  /**
   * L'avatar est-il peint aux couleurs du theme sombre ?
   *
   * IL NE SUIT PAS LE THEME DU LECTEUR. Un avatar est une image qu'on s'est
   * choisie : il changeait de couleurs des qu'on rouvrait son profil dans
   * l'autre theme, comme s'il ne nous appartenait pas. Il garde donc celles du
   * jour ou on l'a tire, et n'en change que si on le redemande.
   */
  avatarSombre: boolean;
}

/** Le nom complet, quand il y en a un. */
export function nomComplet(c: Compte): string {
  return `${c.prenom} ${c.nom}`.trim();
}

/** L'index en memoire, par cle de pseudo. Le journal reste la verite. */
const comptes = new Map<string, Compte>();

/** Une adresse par compte : sans cela, depanner un oubli devient un devinette. */
const cleDuMail = (email: string): string => email.trim().toLowerCase();

/**
 * Une adresse plausible, sans plus.
 *
 * On ne cherche pas a valider une adresse par sa forme -- la vraie regle est
 * illisible, et une adresse valide peut tres bien n'exister nulle part. On
 * ecarte seulement ce qui ne peut PAS en etre une : la vraie verification
 * viendra du courriel de confirmation, le jour ou l'on saura en envoyer.
 */
function adressePlausible(email: string): boolean {
  const e = email.trim();
  if (e.length < 6 || e.length > 254 || /\s/.test(e)) return false;
  const at = e.indexOf("@");
  return at > 0 && at === e.lastIndexOf("@") && e.indexOf(".", at) > at + 1
    && !e.endsWith(".");
}

export function mailPris(email: string): boolean {
  const cle = cleDuMail(email);
  return cle !== "" && [...comptes.values()].some((c) => cleDuMail(c.email) === cle);
}

/**
 * LA CLE D'UNICITE IGNORE LA CASSE ET LES ACCENTS.
 *
 * « Margot », « margot » et « MARGOT » sont la meme personne pour qui lit un
 * classement. Deux comptes qui ne different que par la casse seraient une
 * usurpation offerte, et un classement illisible.
 */
export function cleDuPseudo(pseudo: string): string {
  return pseudo.trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inscrire(ev: Record<string, unknown>): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const fd = openSync(JOURNAL, "a");
  try {
    writeSync(fd, JSON.stringify(ev) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Relit le journal et reconstruit l'index. A appeler une fois, au demarrage. */
export function lireLesComptes(): void {
  comptes.clear();
  if (!existsSync(JOURNAL)) return;
  for (const ligne of readFileSync(JOURNAL, "utf8").split("\n")) {
    if (ligne.trim() === "") continue;
    let e: Record<string, any>;
    try { e = JSON.parse(ligne) as Record<string, any>; } catch { continue; }
    const cle = cleDuPseudo(String(e["pseudo"] ?? ""));
    if (cle === "") continue;
    if (e["t"] === "cree") {
      comptes.set(cle, {
        pseudo: String(e["pseudo"]), hash: String(e["hash"]), sel: String(e["sel"]),
        cree: Number(e["cree"] ?? Date.now()), mdpChangeLe: Number(e["cree"] ?? 0),
        admin: e["admin"] === true,
        email: String(e["email"] ?? ""),
        prenom: "", nom: "", nomPublic: false, demande: false, demandeLe: 0, verifie: false,
        avatar: Number(e["avatar"] ?? 0), avatarSombre: e["avatarSombre"] === true,
      });
      continue;
    }
    const c = comptes.get(cle);
    if (c === undefined) continue;
    if (e["t"] === "mdp") {
      c.hash = String(e["hash"]); c.sel = String(e["sel"]);
      c.mdpChangeLe = Number(e["quand"] ?? Date.now());
    } else if (e["t"] === "profil") {
      // Les lignes d'avant la separation portaient un seul champ : on le range
      // dans le nom, faute de savoir ou passait la coupure.
      if (e["nomReel"] !== undefined) { c.prenom = ""; c.nom = String(e["nomReel"]); }
      if (e["prenom"] !== undefined) c.prenom = String(e["prenom"]);
      if (e["nom"] !== undefined) c.nom = String(e["nom"]);
      c.nomPublic = e["nomPublic"] === true;
      if (e["email"] !== undefined) c.email = String(e["email"]);
      if (e["avatar"] !== undefined) c.avatar = Number(e["avatar"]);
      if (e["avatarSombre"] !== undefined) c.avatarSombre = e["avatarSombre"] === true;
    } else if (e["t"] === "demande") {
      c.demande = true; c.demandeLe = Number(e["quand"] ?? Date.now());
    } else if (e["t"] === "admin") {
      c.admin = e["admin"] === true;
    } else if (e["t"] === "verdict") {
      c.verifie = e["verifie"] === true;
      c.demande = false;
    }
  }
}

export function compte(pseudo: string): Compte | undefined {
  return comptes.get(cleDuPseudo(pseudo));
}

/** Ce pseudo appartient-il a un compte ? Un anonyme ne peut pas le porter. */
export function pseudoEnregistre(pseudo: string): boolean {
  return comptes.has(cleDuPseudo(pseudo));
}

export function tousLesComptes(): Compte[] {
  return [...comptes.values()];
}

async function hacher(mdp: string, sel: Buffer): Promise<string> {
  return (await scrypt(mdp, sel, TAILLE_HASH, SCRYPT)).toString("base64");
}

/**
 * Cree un compte. Rend l'erreur a montrer, ou null si tout va bien.
 *
 * Le pseudo n'est pas normalise a l'ecriture : il s'affiche comme il a ete
 * tape. Seule sa CLE est normalisee, pour l'unicite.
 */
export async function creerCompte(
  pseudo: string, mdp: string, email: string, sombre = false, admin = false,
): Promise<string | null> {
  const nom = pseudo.trim();
  const mail = email.trim();
  if (nom.length < 2 || nom.length > 24) return "Le pseudo fait entre 2 et 24 caractères";
  if (cleDuPseudo(nom) === "") return "Ce pseudo ne contient rien de lisible";
  if (comptes.has(cleDuPseudo(nom))) return "Ce pseudo est déjà utilisé.";
  if (mdp.length < MDP_MINIMUM) return `Le mot de passe fait au moins ${MDP_MINIMUM} caractères`;
  // Le compte d'administration est cree par la console, pas par un formulaire :
  // il n'a personne a qui ecrire.
  if (!admin) {
    if (!adressePlausible(mail)) return "Cette adresse ne ressemble pas à une adresse";
    if (mailPris(mail)) return "Un compte existe déjà avec cette adresse";
  }
  const sel = randomBytes(16);
  const hash = await hacher(mdp, sel);
  const cree = Date.now();
  const avatar = randomBytes(2).readUInt16BE(0);
  const ev = {
    t: "cree", pseudo: nom, hash, sel: sel.toString("base64"), cree, avatar,
    avatarSombre: sombre, email: mail,
    ...(admin ? { admin: true } : {}),
  };
  inscrire(ev);
  comptes.set(cleDuPseudo(nom), {
    pseudo: nom, hash, sel: sel.toString("base64"), cree, mdpChangeLe: cree,
    email: mail,
    admin, prenom: "", nom: "", nomPublic: false, demande: false, demandeLe: 0,
    verifie: false, avatar, avatarSombre: sombre,
  });
  return null;
}

/**
 * Le mot de passe est-il le bon ?
 *
 * La comparaison passe par `timingSafeEqual` : comparer deux chaines avec `===`
 * s'arrete au premier caractere different, et le temps que ca prend renseigne
 * l'attaquant sur ce qu'il a devine juste.
 */
export async function motDePasseJuste(c: Compte, mdp: string): Promise<boolean> {
  const attendu = Buffer.from(c.hash, "base64");
  const donne = await hacher(mdp, Buffer.from(c.sel, "base64"));
  const recu = Buffer.from(donne, "base64");
  return attendu.length === recu.length && timingSafeEqual(attendu, recu);
}

export async function changerLeMotDePasse(c: Compte, mdp: string): Promise<string | null> {
  if (mdp.length < MDP_MINIMUM) return `Le mot de passe fait au moins ${MDP_MINIMUM} caractères`;
  const sel = randomBytes(16);
  const hash = await hacher(mdp, sel);
  const quand = Date.now();
  inscrire({ t: "mdp", pseudo: c.pseudo, hash, sel: sel.toString("base64"), quand });
  c.hash = hash; c.sel = sel.toString("base64"); c.mdpChangeLe = quand;
  return null;
}

/**
 * Enregistre le profil. Rend l'erreur a montrer, ou null.
 *
 * L'adresse se corrige : une faute de frappe le jour de l'inscription ne doit
 * pas condamner le compte, puisque c'est justement elle qui le rattrapera.
 */
export function ecrireLeProfil(c: Compte, p: {
  prenom: string; nom: string; nomPublic: boolean; email: string;
  avatar: number; avatarSombre: boolean;
}): string | null {
  const mail = p.email.trim();
  if (mail !== c.email) {
    if (!adressePlausible(mail)) return "Cette adresse ne ressemble pas à une adresse";
    if (mailPris(mail)) return "Un compte existe déjà avec cette adresse";
    c.email = mail;
  }
  c.prenom = p.prenom.trim().slice(0, 40);
  c.nom = p.nom.trim().slice(0, 40);
  c.nomPublic = p.nomPublic;
  c.avatar = p.avatar & 0xffff;
  c.avatarSombre = p.avatarSombre;
  inscrire({
    t: "profil", pseudo: c.pseudo, prenom: c.prenom, nom: c.nom,
    nomPublic: c.nomPublic, email: c.email,
    avatar: c.avatar, avatarSombre: c.avatarSombre,
  });
  return null;
}

export function demanderLaVerification(c: Compte): string | null {
  if (c.verifie) return "Vous êtes déjà vérifié";
  if (c.prenom === "" || c.nom === "") {
    return "Renseignez votre prénom et votre nom : c'est votre identité qui se vérifie.";
  }
  const quand = Date.now();
  c.demande = true; c.demandeLe = quand;
  inscrire({ t: "demande", pseudo: c.pseudo, quand });
  return null;
}

export function trancherLaVerification(c: Compte, verifie: boolean, par: string): void {
  c.verifie = verifie;
  c.demande = false;
  inscrire({ t: "verdict", pseudo: c.pseudo, verifie, par, quand: Date.now() });
}

// ------------------------------------------------------------------ sessions

/**
 * LE JETON EST SIGNE, PAS STOCKE.
 *
 * Une table de sessions en memoire se viderait a chaque redemarrage du serveur
 * -- et tout le monde se retrouverait deconnecte pour une mise a jour de trois
 * lignes. Un jeton signe survit au redemarrage sans que le serveur ait rien a
 * retenir : il porte le pseudo et son heure d'emission, et la signature prouve
 * que c'est bien nous qui l'avons emis.
 *
 * La cle vit dans un fichier a part, engendree une fois. La perdre ne coute
 * qu'une reconnexion generale.
 */
function cleDeSignature(): Buffer {
  mkdirSync(DATA_DIR, { recursive: true });
  if (existsSync(CLE_SESSION)) return Buffer.from(readFileSync(CLE_SESSION, "utf8").trim(), "base64");
  const cle = randomBytes(32);
  const fd = openSync(CLE_SESSION, "w", 0o600);
  try {
    writeSync(fd, cle.toString("base64") + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { chmodSync(CLE_SESSION, 0o600); } catch { /* systeme sans droits POSIX */ }
  return cle;
}

let CLE: Buffer | null = null;
const signature = (corps: string): string => {
  CLE ??= cleDeSignature();
  return createHmac("sha256", CLE).update(corps).digest("base64url");
};

export function emettreUnJeton(c: Compte): string {
  const corps = `${Buffer.from(c.pseudo, "utf8").toString("base64url")}.${Date.now()}`;
  return `${corps}.${signature(corps)}`;
}

/** Le compte que ce jeton designe, ou undefined s'il ne vaut rien. */
export function compteDuJeton(jeton: string | undefined): Compte | undefined {
  if (jeton === undefined) return undefined;
  const bouts = jeton.split(".");
  if (bouts.length !== 3) return undefined;
  const corps = `${bouts[0]}.${bouts[1]}`;
  const attendue = Buffer.from(signature(corps), "utf8");
  const recue = Buffer.from(bouts[2]!, "utf8");
  if (attendue.length !== recue.length || !timingSafeEqual(attendue, recue)) return undefined;
  const emis = Number(bouts[1]);
  if (!Number.isFinite(emis) || Date.now() - emis > DUREE_SESSION) return undefined;
  const pseudo = Buffer.from(bouts[0]!, "base64url").toString("utf8");
  const c = compte(pseudo);
  // Un jeton emis AVANT le dernier changement de mot de passe ne vaut plus rien.
  if (c === undefined || emis < c.mdpChangeLe) return undefined;
  return c;
}

export const NOM_DU_COOKIE = "farfouille";

/** Lit notre cookie parmi les autres. */
export function jetonDesEntetes(cookies: string | undefined): string | undefined {
  if (cookies === undefined) return undefined;
  for (const morceau of cookies.split(";")) {
    const i = morceau.indexOf("=");
    if (i < 0) continue;
    if (morceau.slice(0, i).trim() === NOM_DU_COOKIE) return morceau.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * L'en-tete qui pose le cookie de session.
 *
 * `Secure` ne se met QUE derriere https, sinon le navigateur refuse le cookie
 * et l'on se retrouve deconnecte a chaque page en developpement. Cloudflare
 * termine le TLS et annonce `x-forwarded-proto: https` : en ligne, le cookie
 * sera donc bien protege.
 */
export function cookieDeSession(jeton: string, https: boolean): string {
  const age = Math.floor(DUREE_SESSION / 1000);
  return `${NOM_DU_COOKIE}=${jeton}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax`
    + (https ? "; Secure" : "");
}

export function cookieEfface(https: boolean): string {
  return `${NOM_DU_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
    + (https ? "; Secure" : "");
}

/**
 * Ce que les AUTRES ont le droit de savoir d'un compte.
 *
 * Le vrai nom n'en fait partie que si son porteur l'a voulu. Le reste -- le
 * hash, le sel, la demande en cours -- ne sort jamais.
 */
export function publicDuCompte(c: Compte): Record<string, unknown> {
  return {
    pseudo: c.pseudo,
    verifie: c.verifie,
    avatar: c.avatar,
    avatarSombre: c.avatarSombre,
    ...(c.nomPublic && nomComplet(c) !== "" ? { nom: nomComplet(c) } : {}),
  };
}

/** Ce que SON porteur a le droit de savoir, en plus. */
export function priveDuCompte(c: Compte): Record<string, unknown> {
  return {
    ...publicDuCompte(c),
    email: c.email,
    prenom: c.prenom,
    nom: c.nom,
    nomPublic: c.nomPublic,
    demande: c.demande,
    admin: c.admin,
    cree: c.cree,
  };
}

/** Donne -- ou retire -- les droits d'administration a un compte. */
export function reglerLAdmin(c: Compte, admin: boolean): void {
  if (c.admin === admin) return;
  c.admin = admin;
  inscrire({ t: "admin", pseudo: c.pseudo, admin, quand: Date.now() });
}

/**
 * Les comptes d'administration, assures au demarrage.
 *
 * Le mot de passe vient de `--admin-mdp` ou de la variable d'environnement
 * `FARFOUILLE_ADMIN_MDP`. A defaut, on en tire un au hasard et on l'ecrit une
 * SEULE fois dans la console : un mot de passe d'administration en dur dans le
 * code serait le meme chez tout le monde.
 */
export async function assurerLesAdmins(pseudos: string[], mdpDemande: string): Promise<void> {
  for (const [i, pseudo] of pseudos.entries()) {
    // LE MOT DE PASSE NE VAUT QUE POUR LE PREMIER NOM. Les autres sont des
    // comptes de joueurs a qui l'on donne des droits : on ne touche pas a leur
    // mot de passe, ce serait les mettre dehors de chez eux.
    await assurerUnAdmin(pseudo, i === 0 ? mdpDemande : "");
  }
}

async function assurerUnAdmin(pseudo: string, mdpDemande: string): Promise<void> {
  const deja = comptes.get(cleDuPseudo(pseudo));
  if (deja !== undefined) {
    // Un compte qui existe deja recoit les droits, et rien d'autre.
    if (!deja.admin) {
      reglerLAdmin(deja, true);
      console.log(`
  ADMINISTRATION -- "${deja.pseudo}" est desormais administrateur.
`);
    }
    // DONNER `--admin-mdp` A UN COMPTE QUI EXISTE LE REMET A CE MOT DE PASSE.
    //
    // Sans cela, un mot de passe tire au hasard et manque au demarrage
    // enfermait dehors pour de bon : le compte existait, donc on ne le recreait
    // pas, et rien ne permettait d'y rentrer. Qui peut lancer le serveur tient
    // deja la machine et le journal : il ne gagne aucun pouvoir ici.
    if (mdpDemande !== "") {
      const erreur = await changerLeMotDePasse(deja, mdpDemande);
      console.log(erreur === null
        ? `
  ADMINISTRATION -- mot de passe de "${deja.pseudo}" remis a celui du demarrage.
`
        : `  [comptes] mot de passe d'administration refuse : ${erreur}`);
    }
    return;
  }
  const mdp = mdpDemande !== "" ? mdpDemande : randomBytes(12).toString("base64url");
  const erreur = await creerCompte(pseudo, mdp, "", false, true);
  if (erreur !== null) {
    console.log(`  [comptes] compte d'administration impossible : ${erreur}`);
    return;
  }
  console.log(`
  ADMINISTRATION -- compte "${pseudo}" cree.`);
  if (mdpDemande === "") {
    console.log(`  Mot de passe (note-le, il ne sera plus affiche) :  ${mdp}`);
  } else {
    console.log("  Mot de passe : celui que tu as donne au demarrage.");
  }
  console.log("");
}
