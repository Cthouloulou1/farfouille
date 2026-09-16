/**
 * Le journal des notifications. Voir SPEC.md §29.
 *
 *     node packages/server/test/check_notifications.ts
 *
 * TOUT SE PASSE DANS UN DOSSIER TEMPORAIRE : `definirDossierDesNotifications`
 * est appele avant quoi que ce soit d'autre, et le vrai journal n'est ni lu ni
 * touche.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  definirDossierDesNotifications, marquerLues, notificationsDe, notifier, ouvrirLesNotifications,
} from "../src/notifications.ts";

const dossier = mkdtempSync(join(tmpdir(), "notifs-"));
definirDossierDesNotifications(dossier);

let echecs = 0;
function verifie(nom: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok   " : "ECHEC"}  ${nom.padEnd(58)} ${detail}`);
  if (!ok) echecs++;
}

console.log("\nLes notifications\n");

notifier("ana", "salon", { salon: "s1", nom: "Le salon", de: "bob" });
notifier("ana", "equipe", { tournoi: "t1", nom: "Coupe", de: "cy" });
notifier("bob", "salon", { salon: "s2", nom: "Autre", de: "ana" });

const a = notificationsDe("ana");
verifie("chacun a sa boite", a.notifications.length === 2 && notificationsDe("bob").notifications.length === 1);
verifie("la plus recente en tete", a.notifications[0]!.genre === "equipe");
verifie("tout est neuf", a.nonLues === 2, String(a.nonLues));
verifie("une boite vide ne se plaint pas", notificationsDe("dan").notifications.length === 0);

marquerLues("ana");
verifie("la lecture eteint la pastille", notificationsDe("ana").nonLues === 0);
verifie("mais la liste reste", notificationsDe("ana").notifications.length === 2
  && notificationsDe("ana").notifications.every((n) => n.lue));
verifie("lire chez l'un ne lit pas chez l'autre", notificationsDe("bob").nonLues === 1);

// UNE CLE NE LAISSE PASSER QU'UNE FOIS : un tournoi ne sonne pas a chaque
// battement de dix minutes.
verifie("la premiere passe", notifier("ana", "tournoi-debut", { tournoi: "t1", nom: "Coupe" }, "debut:t1"));
verifie("la deuxieme, non", !notifier("ana", "tournoi-debut", { tournoi: "t1", nom: "Coupe" }, "debut:t1"));
verifie("mais chez un autre, si", notifier("bob", "tournoi-debut", { tournoi: "t1", nom: "Coupe" }, "debut:t1"));
verifie("la notification neuve rallume", notificationsDe("ana").nonLues === 1);

// LE JOURNAL FAIT FOI : tout se relit a l'identique.
ouvrirLesNotifications();
const relu = notificationsDe("ana");
verifie("le journal se relit a l'identique", relu.notifications.length === 3 && relu.nonLues === 1);
verifie("la cle survit a la relecture",
  !notifier("ana", "tournoi-debut", { tournoi: "t1", nom: "Coupe" }, "debut:t1"));
verifie("le trait de lecture aussi",
  relu.notifications.filter((n) => n.lue).length === 2);

rmSync(dossier, { recursive: true, force: true });
console.log(echecs === 0 ? "\n  tout est bon\n" : `\n  ${echecs} echec(s)\n`);
process.exit(echecs === 0 ? 0 : 1);
