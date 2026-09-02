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
  admin: boolean;
  /**
   * Le vrai nom, pour la verification. PRIVE PAR DEFAUT.
   *
   * On peut etre un joueur verifie sans que son nom paraisse : la verification
   * dit « cette personne est bien qui elle pretend etre », elle n'oblige
   * personne a s'afficher.
   */
  nomReel: string;
  nomPublic: boolean;
  /** Une demande de verification deposee, et pas encore tranchee. */
  demande: boolean;
  demandeLe: number;
  verifie: boolean;
  /** La graine de l'avatar : un pave de la grille, propre a chacun. */
  avatar: number;
}

/** L'index en memoire, par cle de pseudo. Le journal reste la verite. */
const comptes = new Map<string, Compte>();

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
        nomReel: "", nomPublic: false, demande: false, demandeLe: 0, verifie: false,
        avatar: Number(e["avatar"] ?? 0),
      });
      continue;
    }
    const c = comptes.get(cle);
    if (c === undefined) continue;
    if (e["t"] === "mdp") {
      c.hash = String(e["hash"]); c.sel = String(e["sel"]);
      c.mdpChangeLe = Number(e["quand"] ?? Date.now());
    } else if (e["t"] === "profil") {
      c.nomReel = String(e["nomReel"] ?? "");
      c.nomPublic = e["nomPublic"] === true;
      if (e["avatar"] !== undefined) c.avatar = Number(e["avatar"]);
    } else if (e["t"] === "demande") {
      c.demande = true; c.demandeLe = Number(e["quand"] ?? Date.now());
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
  pseudo: string, mdp: string, admin = false,
): Promise<string | null> {
  const nom = pseudo.trim();
  if (nom.length < 2 || nom.length > 24) return "Le pseudo fait entre 2 et 24 caractères";
  if (cleDuPseudo(nom) === "") return "Ce pseudo ne contient rien de lisible";
  if (comptes.has(cleDuPseudo(nom))) return "Ce pseudo est déjà pris";
  if (mdp.length < MDP_MINIMUM) return `Le mot de passe fait au moins ${MDP_MINIMUM} caractères`;
  const sel = randomBytes(16);
  const hash = await hacher(mdp, sel);
  const cree = Date.now();
  const avatar = randomBytes(2).readUInt16BE(0);
  const ev = {
    t: "cree", pseudo: nom, hash, sel: sel.toString("base64"), cree, avatar,
    ...(admin ? { admin: true } : {}),
  };
  inscrire(ev);
  comptes.set(cleDuPseudo(nom), {
    pseudo: nom, hash, sel: sel.toString("base64"), cree, mdpChangeLe: cree,
    admin, nomReel: "", nomPublic: false, demande: false, demandeLe: 0,
    verifie: false, avatar,
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

export function ecrireLeProfil(c: Compte, nomReel: string, nomPublic: boolean, avatar: number): void {
  c.nomReel = nomReel.trim().slice(0, 64);
  c.nomPublic = nomPublic;
  c.avatar = avatar & 0xffff;
  inscrire({ t: "profil", pseudo: c.pseudo, nomReel: c.nomReel, nomPublic: c.nomPublic, avatar: c.avatar });
}

export function demanderLaVerification(c: Compte): string | null {
  if (c.verifie) return "Vous êtes déjà vérifié";
  if (c.nomReel === "") return "Donnez d'abord votre nom : c'est lui qui se vérifie";
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
    ...(c.nomPublic && c.nomReel !== "" ? { nom: c.nomReel } : {}),
  };
}

/** Ce que SON porteur a le droit de savoir, en plus. */
export function priveDuCompte(c: Compte): Record<string, unknown> {
  return {
    ...publicDuCompte(c),
    nomReel: c.nomReel,
    nomPublic: c.nomPublic,
    demande: c.demande,
    admin: c.admin,
    cree: c.cree,
  };
}

/**
 * Le compte d'administration, cree au premier demarrage.
 *
 * Le mot de passe vient de `--admin-mdp` ou de la variable d'environnement
 * `FARFOUILLE_ADMIN_MDP`. A defaut, on en tire un au hasard et on l'ecrit une
 * SEULE fois dans la console : un mot de passe d'administration en dur dans le
 * code serait le meme chez tout le monde.
 */
export async function assurerLAdmin(pseudo: string, mdpDemande: string): Promise<void> {
  if (comptes.has(cleDuPseudo(pseudo))) return;
  const mdp = mdpDemande !== "" ? mdpDemande : randomBytes(12).toString("base64url");
  const erreur = await creerCompte(pseudo, mdp, true);
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
