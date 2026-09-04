/**
 * La version anglaise des textes du site.
 *
 * LA CLE EST LE TEXTE FRANCAIS, mot pour mot, accents et ponctuation compris.
 * Un texte absent de cette table s'affiche en francais : rien ne casse, il
 * manque seulement une traduction. Voir `langue.ts` pour le pourquoi.
 *
 * POUR TROUVER CE QUI RESTE A TRADUIRE :
 *
 *     node tools/extraire-textes.mjs
 *
 * L'outil releve les textes du balisage et ceux que le code passe a `t()`, et
 * n'affiche que ceux qui manquent ici. Sa sortie se colle telle quelle.
 *
 * LES TRADUCTIONS CI-DESSOUS SONT DES PROPOSITIONS. Elles sont la pour amorcer,
 * pas pour faire autorite : le vocabulaire du jeu se decide a l'oreille de qui
 * y joue. Les endroits qui demandent un arbitrage portent un commentaire.
 */
export const EN: Readonly<Record<string, string>> = {

  // ---------------------------------------------------------------- accueil
  // « Farfouille » est le nom du site : il ne se traduit pas.
  // « Topping infini » est le nom du jeu -- a decider. Proposition ci-dessous.
  "Topping infini": "Infinite topping",
  "infini": "infinite",
  "Revenir à l'accueil": "Back to home",
  "Revenir aux salons": "Back to the rooms",
  "Records": "Records",
  "Paramètres": "Preferences",
  "chargement…": "loading…",
  "connexion…": "connecting…",

  // ------------------------------------------------------------- le compte
  "Connexion": "Sign in",
  "Inscription": "Sign up",
  "Se connecter": "Sign in",
  "Se déconnecter": "Sign out",
  "Jouer sans compte": "Play as a guest",
  "Pseudo d'invité": "Guest name",
  "Votre pseudo": "Your user name",
  "Pseudo": "Username",
  "Mot de passe": "Password",
  "Mot de passe actuel": "Current password",
  "Nouveau mot de passe": "New password",
  "Changer le mot de passe": "Change password",
  "Mot de passe changé.": "Password changed.",
  "Adresse mail": "Email address",
  "Email": "Email",
  "L'email restera privé.": "Your email stays private.",
  "Afficher mon nom publiquement": "Show my name publicly",
  "Nom": "Last name",
  "Prénom": "First name",
  "Renseignez votre nom si vous voulez": "Add your name if you like",
  "Il vous suit d'un salon à l'autre.": "It follows you from room to room.",
  "Changer d'avatar": "Change avatar",
  "Voir mon profil, tel que les autres le voient": "See my profile as others see it",
  "joueur vérifié": "verified player",
  "Demandes de vérification": "Verification requests",
  "La vérification se fait ailleurs — vous demandez au joueur, sur une autre plateforme, si c'est bien lui. Ici, vous ne faites qu'inscrire le verdict.":
    "Verification happens elsewhere — you ask the player, on another platform, whether it is really them. Here you only record the verdict.",
  "Enregistrer": "Save",
  "Fermer": "Close",
  "Continuer": "Continue",
  "Plus tard": "Later",

  // ------------------------------------------------- reglages d'un salon
  "Réglages": "Settings",
  "Dictionnaire": "Dictionary",
  "Grille": "Board",
  "Normale": "Standard",
  "Infinie": "Infinite",
  "Mode de jeu": "Game mode",
  "Topping": "Topping",
  "Duplicate": "Duplicate",
  "Réglages avancés": "Advanced settings",
  "Format": "Format",
  "7 sur 7": "7 of 7",
  "7 sur 8": "7 of 8",
  "7 posables sur 8": "7 playable of 8",
  "7 et 8": "7 and 8",
  "8 posables sur 8": "8 playable of 8",
  "Nombre de lettres": "Tiles drawn",
  "Nombre de lettres jouables": "Tiles playable",
  "Partie joker": "Blank game",
  "Long": "Long",
  "Temps par coup": "Time per move",
  // « Frades » est un mot de joueurs, sans equivalent anglais : a trancher.
  "Frades": "Nigel",
  "Super blitz": "Super blitz",
  "Blitz": "Blitz",
  "Semi-rapide": "Rapid",
  // Un seul mot pour deux endroits -- le temps par coup et la duree totale --
  // parce que le francais n'en emploie qu'un.
  "Infini": "Unlimited",
  "Personnalisé": "Custom",
  "Limite de temps": "Time limit",
  "Nombre de coups joués": "Number of moves",
  "50 coups": "50 moves",
  "100 coups": "100 moves",
  "150 coups": "150 moves",
  "Tirage des lettres": "Tile draw",
  "Probabilités pondérées": "Weighted probabilities",
  // Le nombre suit le lexique : 102 en francais, 100 en anglais.
  "Sac de {n} lettres": "{n}-tile bag",
  "Sac de {n} sans fin": "Endless {n}-tile bag",
  // Les infobulles des lexiques.
  "Le lexique officiel du jeu francophone. 407 128 mots.":
    "The official francophone word list. 407,128 words.",
  "Les mots anglais courants, et eux seuls. 68 135 mots.":
    "Everyday English words, and nothing else. 68,135 words.",
  "Le lexique Collins, l'international anglophone. 280 887 mots.":
    "The Collins list, used everywhere but North America. 280,887 words.",
  "Le lexique nord-americain. 196 601 mots.":
    "The North American list. 196,601 words.",
  "Décompte": "Countdown",
  "Joker": "Blank",
  "Prime selon le nombre de lettres posées": "Bonus by number of tiles placed",
  // « Farfouille » designe ici le coup qui pose tout son chevalet. L'anglais
  // dit « bingo », qui n'appartient a personne.
  "Primes de farfouilles": "Bingo bonuses",
  "Primes standards": "Standard bonuses",
  "Masquer les primes": "Hide bonuses",
  "Go": "Go",

  // --------------------------------------------------------- preferences
  "Langue": "Language",
  "Thème": "Theme",
  "Clair": "Light",
  "Sombre": "Dark",
  "Automatique": "Auto",
  "Sons": "Sound",
  "Activés": "On",
  "Muets": "Muted",
  "Caméra": "Camera",
  "Réduire les mouvements de caméra": "Reduce camera motion",
  "Captures d'écran": "Screenshots",
  "Enregistrer les grilles en haute définition": "Save boards in high definition",
  "Saisie": "Input",
  "Curseur à quatre directions": "Four-way cursor",
  "Repères du plateau 15×15": "15×15 board coordinates",
  "Française": "French",
  "lignes A–O": "rows A–O",
  "Anglaise": "English",
  "colonnes A–O": "columns A–O",
  "agrandir le texte": "larger text",
  "réduire le texte": "smaller text",
  "agrandir le texte du panneau": "larger text in the panel",
  "réduire le texte du panneau": "smaller text in the panel",
  "Tirer pour redimensionner — double-clic pour rétablir":
    "Drag to resize — double-click to reset",

  // ------------------------------------------------------------- la partie
  "Quitter": "Leave",
  "Partie": "Game",
  "Partie terminée": "Game over",
  "Rejouer": "Play again",
  "Revoir la partie": "Review the game",
  "Révéler le top": "Reveal the top",
  "Lancer la partie": "Start the game",
  "Coup": "Move",
  "Coup 1": "Move 1",
  "Coups joués": "Moves played",
  "Premier coup": "First move",
  "Coup précédent": "Previous move",
  "Coup suivant": "Next move",
  "Dernier coup": "Last move",
  "Ordre des coups": "Move order",
  "Par score, du plus cher": "By score, highest first",
  "Par score, du moins cher": "By score, lowest first",
  "Par temps, du plus rapide": "By time, fastest first",
  "Par temps, du moins rapide": "By time, slowest first",
  "Par longueur, du plus long": "By length, longest first",
  "Feuille de route": "Score sheet",
  "enregistrer la feuille de route": "save the score sheet",
  "enregistrer la feuille de route sur votre ordinateur":
    "save the score sheet to your computer",
  "enregistrer la grille en image": "save the board as an image",
  "masquer le mot sur la grille": "hide the word on the board",
  "rechercher": "search",
  "Filtre les solutions à mesure. Entrée cherche le mot sur toute la grille.":
    "Filters solutions as you type. Enter searches the word across the whole board.",

  // ------------------------------------------------------ tableau de bord
  "Classement": "Standings",
  "Joueurs connectés": "Players online",
  "Score": "Score",
  "Top": "Tops",
  // L'ecart au top, au duplicate. « Negative » ne se dit pas en anglais.
  "Négatif": "Gap",
  "Temps": "Time",
  "Cumul": "Total",
  "Reste": "Left",

  // ---------------------------------------------------------------- chat
  "Chat": "Chat",
  "Message…": "Message…",
  "Envoyer": "Send",
  "Case": "Square",
  "Partager la case du curseur": "Share the cursor square",

  // ------------------------------------------------------------- alertes
  "Le serveur tourne une version plus ancienne que cette page — arrêtez-le et relancez":
    "The server is running an older version than this page — stop it and restart",
  ", sinon les réglages n'auront aucun effet.":
    ", otherwise the settings will have no effect.",

  // =====================================================================
  //  CE QUE LE CODE ECRIT
  //
  //  Au-dessus, le balisage, qui se traduit tout seul. Ici, ce que main.ts
  //  compose : l'accueil, le journal des coups, les messages d'erreur.
  //
  //  Un texte a trous s'ecrit `t2("...", { n: 3 })` : les trous portent un NOM,
  //  parce que l'ordre des mots change d'une langue a l'autre.
  // =====================================================================

  // ------------------------------------------------------------- accueil
  "Tous": "All",
  "En attente": "Waiting",
  "Toutes les langues": "All languages",
  "Montrer aussi les salons des autres langues": "Also show rooms in other languages",
  "Créer un salon": "Create a room",
  "Salon star": "Featured room",
  "Jouer": "Play",
  "Supprimer": "Delete",
  "permanent": "permanent",
  "Coup {n}": "Move {n}",
  "Coup {n} · {p} points": "Move {n} · {p} points",
  "{n} joueur{s}": "{n} player{s}",
  "Créer un compte": "Create an account",
  "Entrez un pseudo pour continuer": "Enter a name to continue",
  "Grille infinie, sans limite de temps, sans fin.":
    "An infinite board, no time limit, endless.",
  "Jusqu'où pourrons-nous aller ?": "How far can we go?",
  "Rejoignez la plus grande partie de topping jamais créée.":
    "Join the largest game of topping ever created.",
  "aucun salon ouvert": "no open room",
  "aucun salon comme ça": "no room like that",
  "création impossible": "could not be created",
  "en attente": "waiting",
  "en pause": "paused",
  "terminée": "finished",
  "sans chrono": "no time limit",
  "Normal": "Normal",
  "{n} joueur{s} en ligne": "{n} player{s} online",
  "{n} en ligne": "{n} online",
  "Retire le salon. La partie terminée est conservée.":
    "Removes the room. The finished game is kept.",
  "Retire le salon ET efface la partie. Sans retour.":
    "Removes the room AND deletes the game. No way back.",

  // -------------------------------------------------------------- compte
  "Changer de pseudo": "Change username",
  "Voir le profil": "See profile",
  "Ce joueur n'a pas de compte.": "This player has no account.",
  "Vérification": "Verification",
  "Vérifier": "Verify",
  "vérifié": "verified",
  "Demander la vérification": "Ask for verification",
  "Demande déposée.": "Request sent.",
  "Votre vérification a été actée": "Your verification has been approved",
  "Renseignez votre prénom et votre nom": "Enter your first and last name",
  "aucune demande, aucun joueur vérifié": "no request, no verified player",
  "Adresse vérifiée.": "Address verified.",
  "Adresse non vérifiée.": "Address not verified.",
  "Votre mail est confirmé.": "Your mail is confirmed.",
  "Envoyer le lien": "Send the link",
  "Lien demandé.": "Link requested.",

  // ----------------------------------------------------- pendant la partie
  // (« Partie terminée » est deja plus haut : le balisage l'affiche aussi.)
  "la partie est terminée": "game over",
  "le coup n'est pas encore prêt": "the move is not ready yet",
  "pas encore connecté au salon": "not connected to the room yet",
  "déconnecté — reconnexion…": "disconnected — reconnecting…",
  "cliquez d'abord une case": "click a square first",
  "mot inconnu": "word not found",
  "Mot non valide :": "Invalid word:",
  "Mots non valides :": "Invalid words:",
  "C'est une partie {x} sur {y}": "This game is {x} of {y}",
  "non trouvé": "not found",
  "Non trouvé": "Not found",
  "Trouvé": "Found",
  "votre coup": "your move",
  "coup révélé, personne à féliciter": "move revealed, no one to congratulate",
  "bravo à {qui}": "well played, {qui}",
  "coup": "move",
  "coup {n}": "move {n}",
  "coups": "moves",
  "{n} joueurs": "{n} players",
  "grille": "board",
  "partie": "game",
  "salon": "room",
  "écart": "gap",
  "case {ou} partagée": "square {ou} shared",
  "« sans nom »": "“unnamed”",
  "montrer le mot sur la grille": "show the word on the board",
  "un quart d'heure": "a quarter of an hour",
  "une demi-heure": "half an hour",
  "un jour": "a day",

  // ------------------------------------------------------ feuille de route
  "aucun coup joué": "no move played",
  "aucun coup enregistré": "no move recorded",
  "aucun coup à enregistrer": "no move to save",
  "aucun coup ne correspond": "no move matches",
  "chargement des solutions…": "loading solutions…",
  "solutions non enregistrées pour ce coup": "solutions not recorded for this move",
  "mot entier — ou terminez votre recherche par une espace":
    "whole word — or end your search with a space",
  "Entrée pour le chercher sur toute la grille":
    "Enter to search the whole board",
  "feuille enregistrée — {n} coup{s}": "score sheet saved — {n} move{s}",
  "image enregistrée — {l} × {h} px — {mo} Mo":
    "image saved — {l} × {h} px — {mo} MB",
  "image trop grande pour ce navigateur — {l} × {h} px":
    "image too large for this browser — {l} × {h} px",
  "l'image n'a pas pu être produite": "the image could not be produced",
  "revoir le coup {n}": "replay move {n}",
  "Coup {n} : {mot} pour {pts} pts.": "Move {n}: {mot} for {pts} pts.",
  "Le top {top} valait {pts} pts": "The top {top} was worth {pts} pts",
  "— trouvé.": "— found.",
  ", manqué de {ecart} pts.": ", missed by {ecart} pts.",
  "voir {mot} en {ou}": "see {mot} at {ou}",
  "trouvé par {qui}": "found by {qui}",
  "joué par {qui}": "played by {qui}",
  "image de la grille au coup {n}, avec son tirage":
    "picture of the board at move {n}, with its rack",

  // ------------------------------------------------------ avertissements
  "Le temps de calcul du top grandit avec la grille et le tirage.":
    "The top's calculation time grows with the board and the rack.",
  "ça risque de lagger au bout d'un moment.": "it will start to lag after a while.",
  "Attention : sac sans fin sur une grille {c}×{c}.":
    "Warning: endless bag on a {c}×{c} board.",
  "Le sac se recharge indéfiniment : la partie ne s'arrête que lorsque":
    "The bag refills forever: the game only ends when no move",
  "aucun coup n'est jouable, et elle sera très longue.":
    "can be played at all, and it will be very long.",

  // -------------------------------------------- messages venus du serveur
  "Ce salon a été supprimé": "This room has been deleted",
  "Ce salon n'existe plus": "This room no longer exists",
  "Ce nom d'utilisateur n'est pas disponible": "That username is not available",
  "Nom d'utilisateur": "Username",
  "Ce nom est déjà utilisé : connectez-vous, ou prenez-en un autre":
    "That name is already taken: sign in, or pick another",
  "cette grille est permanente": "this board is permanent",
  "seul le propriétaire règle le salon": "only the owner sets the room up",
  "seul le créateur du salon peut le supprimer": "only the creator can delete the room",
  "trop de mots d'un coup": "too many words at once",
  "réservé à l'administration": "reserved for the administration",
  "ce salon se règle, il ne se lance pas": "this room is set up, not started",
  "la partie est déjà lancée": "the game is already starting",
};
