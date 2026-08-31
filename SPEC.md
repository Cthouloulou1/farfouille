# Topping Infini — spécification

Document de référence du projet. Il consigne les décisions prises, pas les
intentions : ce qui est ici est arbitré. Ce qui reste ouvert est rassemblé en
fin de document, section « Reporté ».

---

## 1. Le principe

Un jeu de lettres **en duplicate topping collectif**, sur une **grille qui
s'étend à l'infini**.

Tous les joueurs connectés voient la même grille et le même tirage de 7 lettres.
Chacun cherche le **top** — le mot qui rapporte le plus de points sur la
position. Le premier joueur dont la réponse au score du top parvient au serveur
remporte le coup ; le mot est immédiatement posé pour tout le monde et on
enchaîne sur le coup suivant.

Ce n'est donc pas une partie que l'on gagne, c'est une grille que l'on construit
ensemble. Le classement compte les coups trouvés, la grille cumule les points.

**Le jeu ne s'appelle jamais « Scrabble »**, ni dans le code, ni dans
l'interface, ni dans la documentation.

---

## 2. Le déroulement d'un coup

1. Le serveur calcule le **top** et la liste complète des **isotops** pour le
   tirage courant.
2. Le tirage est diffusé aux clients. **C'est seulement à cet instant que
   démarre le chrono du coup** — le temps de calcul du serveur ne doit jamais
   être compté dans le temps de recherche des joueurs.
3. Les joueurs tapent des mots sur la grille, autant qu'ils veulent.
4. Le premier mot atteignant le score du top **dans l'ordre d'arrivée au
   serveur** remporte le coup. L'horodatage fait foi côté serveur, jamais côté
   client.
5. Le logiciel pose **son** top canonique (voir §5), qui n'est pas
   nécessairement le mot tapé par le joueur.
6. Les lettres posées quittent le tirage, le reliquat est conservé, on complète
   à 7, et on repart au point 1.

**Il n'y a pas de chrono.** Un coup dure jusqu'à ce que quelqu'un trouve le top,
que ce soit trois secondes ou trois jours. Le jeu est asynchrone au long cours.
Conséquence : l'état doit être intégralement persisté à chaque coup, le serveur
doit pouvoir redémarrer sans perdre le coup en cours.

Un chrono par coup n'existe que dans le mode **battle** (voir §8), réservé aux
salons.

### Précalcul

La suite de la partie est **entièrement déterministe** : le mot posé est le top
canonique du logiciel, donc le reliquat est déterminé, donc la pioche l'est
aussi (RNG seedée). Rien de ce que font les joueurs n'influence la suite — ils
ne font que courir pour réclamer des coups déjà écrits.

Le serveur calcule donc **5 coups d'avance** dans un worker de fond. La latence
cesse d'être un problème, y compris sur le pire cas (tirage à deux jokers sur
une grille très ouverte).

> ⚠️ **Pas encore construit.** Le prototype de phase 1 résout le coup courant et
> attend sa réponse (6 à 20 ms aujourd'hui, invisible). Le précalcul est un
> chantier de la phase 2 ; c'est le nombre de coups d'avance qui est arrêté ici,
> pas le fait que le code existe.

> ⚠️ Ces coups précalculés restent **en mémoire, jamais en base**. Une partie
> entièrement précalculée et persistée serait un spoiler intégral à la moindre
> fuite.

> ⚠️ Ce précalcul est une conséquence directe du choix « le logiciel pose son
> top canonique ». Le jour où l'on poserait le mot du joueur, les joueurs
> sculpteraient la grille et le précalcul deviendrait impossible.

---

## 3. La grille

- Infinie dans les **quatre** directions.
- Origine `(0, 0)`. Axe `x` vers la droite, axe `y` **vers le bas**.
- Le **premier coup est toujours horizontal** et doit **couvrir** `(0, 0)`, sans
  nécessairement y commencer.
- Représentation : grille creuse (`Map` sur clé entière dérivée de `x, y`).
  Jamais de tableau 2D, jamais de balayage global.
- Index d'ancrages maintenu **incrémentalement** à chaque coup.

### Notation d'un coup

Le sens est noté **devant**, puis la coordonnée **constante en premier** — c'est
l'usage du duplicate, celui de la notation `A5` / `5A` : un mot horizontal tient
sur une seule **ligne**, donc la ligne vient en tête ; un mot vertical tient sur
une seule **colonne**, donc la colonne vient en tête.

**Grille infinie** — le sens devant, puis toujours **ligne puis colonne**, quel
que soit le sens. Une paire dont la signification change selon la lettre qui la
précède se lit mal.

```
H 0,-4      horizontal, ligne 0, à partir de la colonne -4
V 3,12      vertical, à partir de la ligne 3, colonne 12
```

**La ligne monte quand son numéro grandit**, comme une ordonnée en géométrie —
les colonnes se lisaient déjà comme des abscisses.

À l'intérieur, `y` descend : c'est la convention des écrans, et tous les
journaux déjà écrits la suivent. Le signe se retourne **à la frontière de
l'affichage**, dans `formatMove`, et nulle part ailleurs. Rien de ce qui est
enregistré ne change, et une partie ancienne se relit sans rien perdre.

**Grille bornée** — la notation du jeu de société. Les lignes portent des
lettres à partir de A, les colonnes des numéros à partir de 1 ; sur un plateau
de 15, A à O et 1 à 15. Un mot horizontal tient sur une ligne, donc sa **lettre**
vient en tête ; un mot vertical tient sur une colonne, donc son **numéro** vient
en tête.

```
B13    horizontal, ligne B, à partir de la colonne 13
13B    vertical, colonne 13, à partir de la ligne B
H8     le centre, horizontalement        8H    le centre, verticalement
```

L'ordre de la paire dépend donc du sens. C'est voulu : c'est ce que lit un
joueur de duplicate, et l'inverser rendrait la notation étrangère à l'usage.

### Cases bonus

`bonus(x, y)` **doit être une fonction pure, sans aucun stockage**. C'est ce qui
rend le motif remplaçable à volonté : changer de design = réécrire une fonction.

**Provisoire** : pavage à l'infini du plateau 15x15 classique, l'origine `(0,0)`
coïncidant avec l'étoile centrale.

**La période est 14, pas 15.** Les bords du plateau officiel sont déjà
identiques — la ligne 14 est la copie exacte de la ligne 0, la colonne 14 celle
de la colonne 0. On fait donc **coïncider** ces bords au lieu de les juxtaposer :
les pavés se recouvrent d'une ligne et l'indice 14 n'est jamais atteint.

> Avec une période de 15, les colonnes 14 et 0 de deux pavés voisins portaient
> chacune un mot compte triple et devenaient adjacentes : un x9 sur un mot de
> deux lettres, et **20 % des coups concernés**. Après passage à 14 : plus
> aucune paire de MCT adjacentes sur 81x81 cases, distance minimale entre deux
> MCT ramenée à **7 cases, exactement celle du plateau officiel**, et le taux de
> x9 retombe à **4,6 %** (§15).

Le motif définitif reste à concevoir — un **réseau pensé pour l'infini**, sans
centre ni bord. Trois pistes chiffrables : réseau oblique engendré par `(4,3)` et
`(-3,4)` (une MCT pour 25 cases, jamais deux alignées à courte portée) ;
périodes premières entre elles par type de bonus (13, 8, 5, 3 — motif combiné se
répétant tous les 1 560 cases, donc imprévisible à l'échelle d'une partie) ;
ou période 7 calée sur la taille du tirage.

---

## 4. Le tirage

7 lettres, appelées **caramels**.

### Renouvellement

Le **reliquat est conservé** : seules les lettres effectivement posées quittent
le tirage, on pioche de quoi revenir à 7.

### Règle de rejet

- Voyelles : `A E I O U`
- Consonnes : toutes les autres **sauf** `Y` et le joker
- `Y` et joker sont **neutres** — ils ne comptent d'aucun côté

Un tirage est **rejeté s'il contient moins de 2 voyelles ou moins de 2
consonnes**. Le rejet emporte **tout le tirage, reliquat compris** : on repart
sur 7 lettres neuves.

Un tirage ne permettant **aucun coup légal** est également rejeté.

> Un tirage rejeté **ne consomme pas** les probabilités : les poids de
> compensation sont restaurés, il n'a jamais existé.

> La règle de rejet est implémentée comme une **fonction de politique
> remplaçable** (`shouldReject(rack) -> bool`), pas comme un `if` en dur, pour
> permettre plus tard une variante probabiliste.

### Notation

| Contexte | Rendu | Exemple |
|---|---|---|
| Caramels affichés au joueur | ordre alphabétique, sans séparateur, toujours 7 | `BBNOORS` |
| Colonne « tirage » de la feuille de route | reliquat `+` pioche | `AA+BLRNT` |
| Idem, après un rejet | préfixe `-` | `-BBNOORS` |

### Pioche pondérée

Il n'y a **pas de sac** : chaque lettre est tirée indépendamment selon un poids,
corrigé par un mécanisme anti-sécheresse.

```
poids courant  c(L) = w(L) x min(1 + alpha*k(L), plafond)
    k(L)     = nombre de tirages depuis la dernière sortie de L
    alpha    = 0.08
    plafond  = 4
tirage proportionnel à c(L) ; la lettre sortie repart à k = 0
```

Le **plafond est indispensable** : sans lui, une lettre jamais tirée voit son
poids grimper indéfiniment et finit par dépasser le `E`.

### Table des poids

Les poids sont **relatifs** — leur somme n'a pas d'importance, le tirage
normalise. Ils sont **calibrés par simulation** : volontairement plus bas que la
fréquence visée, pour que la fréquence *observée après compensation* tombe
juste. Sans cette calibration, la mécanique anti-sécheresse quadruple les
lettres rares et ressuscite le `W`.

Fréquences visées : celles des lettres dans les mots de **2 à 9 lettres de
l'ODS9**, avec trois corrections délibérées (voir plus bas).

| | poids | visé % | obtenu % | au moins 1 par tirage |
|---|---|---|---|---|
| E | 22.300 | 15.46 | 15.10 | 1 tirage sur 1 |
| A | 13.748 | 10.82 | 10.52 | 1 sur 2 |
| R | 10.212 | 7.73 | 7.59 | 1 sur 2 |
| I | 10.104 | 8.66 | 8.46 | 1 sur 2 |
| S | 9.215 | 7.22 | 7.08 | 1 sur 2 |
| T | 8.480 | 6.80 | 6.67 | 1 sur 2 |
| N | 7.379 | 6.19 | 6.07 | 1 sur 3 |
| O | 5.746 | 5.88 | 5.72 | 1 sur 3 |
| L | 4.450 | 4.33 | 4.25 | 1 sur 4 |
| U | 4.014 | 4.54 | 4.46 | 1 sur 3 |
| C | 3.454 | 3.61 | 3.56 | 1 sur 4 |
| M | 2.284 | 2.68 | 2.66 | 1 sur 6 |
| P | 2.163 | 2.58 | 2.56 | 1 sur 6 |
| D | 2.041 | 2.47 | 2.45 | 1 sur 6 |
| G | 1.588 | 2.06 | 2.02 | 1 sur 7 |
| ? (joker) | 1.598 | 1.96 | 1.93 | 1 sur 7.6 |
| B | 1.494 | 1.96 | 1.93 | 1 sur 8 |
| F | 1.168 | 1.55 | 1.57 | 1 sur 9 |
| H | 0.927 | 1.34 | 1.31 | 1 sur 11 |
| V | 0.840 | 1.24 | 1.22 | 1 sur 12 |
| Z | 0.530 | 0.82 | 0.80 | 1 sur 18 |
| Y | 0.353 | 0.52 | 0.53 | 1 sur 27 |
| Q | 0.325 | 0.52 | 0.51 | 1 sur 28 |
| X | 0.243 | 0.41 | 0.39 | 1 sur 36 |
| J | 0.187 | 0.31 | 0.31 | 1 sur 47 |
| K | 0.156 | 0.26 | 0.26 | 1 sur 56 |
| **W** | **0.030** | **0.05** | **0.05** | **1 sur 270** |

Taux de rejet mesuré : **13,8 %**.

**Les trois corrections délibérées**, seuls écarts à la fidélité au dictionnaire :

- **`W` écrasé.** Le dictionnaire lui donne déjà 0,07 % contre 1 % dans le sac
  classique : il y est 14 fois trop fréquent. Poussé à 0,05 %, soit une
  apparition tous les 270 tirages.
- **`S` ramené de 9,03 % à 7,22 %.** Sa fréquence dans le dictionnaire est
  gonflée par les pluriels, et c'est la lettre la plus puissante du jeu : sur une
  grille infinie pleine d'ancrages, chaque `S` de plus est un collage de plus, et
  donc des isotops en plus.
- **`Z` ramené de 1,21 % à 0,82 %.** Le dictionnaire en veut *plus* que le sac
  classique, à cause des terminaisons `-EZ`. Le suivre donnerait une lettre à 10
  points plus souvent qu'au jeu d'origine.

Le `R` a par ailleurs été légèrement amorti (8,12 -> 7,73), gonflé par les
infinitifs en `-ER`.

### Jokers

- **0 à 2 par tirage**, plafond dur à 2. Fréquence de base environ 2/102.
- Valent **0 point**.
- Notés en **minuscule** dans les comptes rendus, selon la convention duplicate.

---

## 5. Les isotops

Un **isotop** est un coup qui réalise le même score que le top, à un autre
emplacement ou avec un autre mot. Tous les coups au score maximum sont des tops
valables : le joueur qui en trouve un remporte le coup.

**Mais c'est le top canonique du logiciel qui est posé sur la grille**, pas le
mot tapé par le joueur.

Le départage est pour l'instant un **tirage au sort**, qui doit impérativement
être **déterministe** : graine dérivée de `(id_partie, numéro_de_coup)`. Sans
cela l'historique n'est pas rejouable et deux serveurs divergent. Même exigence
pour la pioche — jamais de `Math.random()`.

> ⚠️ **Le déterminisme ne s'arrête pas à l'aléatoire.** Aucune décision du moteur
> ne doit dépendre de l'horloge, de la vitesse de la machine ou de la mémoire
> disponible. Une version de l'élagage décidait de calculer ses majorants en se
> chronométrant avec `performance.now()` : selon la charge machine, le moteur
> élaguait ou non, et **deux exécutions du même programme jouaient des parties
> différentes** — divergence constatée au coup 498. Toute décision adaptative
> doit se prendre sur une grandeur **comptée** (coups produits, nœuds visités),
> jamais mesurée en temps. `check_determinism.ts` verrouille ce point.

Pour chaque isotop, le moteur calcule et conserve ses **rallonges** possibles
(`{ avant: [...], arrière: [...] }`). C'est une information affichée dans
l'historique, et la matière première du futur critère de départage : préférer
les mots ouvrant des rallonges, par exemple `SCIENT` plutôt que `CEINTS` pour
laisser venir `E-SCIENT`. C'est une opération que le GADDAG rend gratuite.

La liste complète des isotops est **énumérée dans l'historique** de chaque coup.

---

## 6. Le score

- Valeurs classiques des lettres françaises.
- Prime de **50 points** pour les 7 caramels posés en un coup.
- Joker : 0 point.
- Tous les mots perpendiculaires formés doivent être valides.
- Longueur maximale d'un mot : **15 lettres** (limite de l'ODS, voir §7).

> ⚠️ Quand le tirage contient à la fois un `E` réel et un joker et que le mot
> emploie deux `E`, **l'affectation joker / lettre réelle doit être optimisée
> pour le score**, jamais faite de gauche à droite : si l'un des deux tombe sur
> une lettre compte triple, il faut y placer le vrai. Cela vaut pour le
> générateur (sinon il sous-évalue des coups et rate le top) comme pour le mot
> tapé par le joueur, qui doit être scoré au mieux. Le même optimiseur sert aux
> deux.

Corollaire : **le joueur n'a aucun choix à faire sur les jokers**. Seul le score
du coup compte, le reliquat lui échappe puisque c'est le logiciel qui pose —
utiliser la vraie lettre est donc toujours au moins aussi bon. L'interface n'a
besoin d'aucune touche spéciale.

> ⚠️ **Quand deux affectations donnent le MÊME score, il faut quand même
> trancher, et de façon canonique.** Maximiser le score ne suffit pas : sur le
> tirage `?ADEFSZ`, le mot `DESAMEZ` vaut 148 points que le joker soit sur l'un
> ou l'autre de ses deux `E`. Mais le caramel posé diffère — un joker à 0 point
> au lieu d'un vrai `E` — la grille évolue autrement, et deux moteurs qui
> exploreraient dans un ordre différent joueraient des parties différentes. La
> divergence n'éclate que 110 coups plus loin.
>
> Règle retenue : **le moins de jokers possible, puis les jokers le plus tôt
> dans le mot.** Arbitraire, mais fixe.

---

## 7. Le dictionnaire

Source : `dictionnaire.txt` à la racine — **ODS9** (2024).

```
407 128 mots · ASCII A-Z pur · trié · zéro doublon · longueurs 2 à 15
```

Aucun nettoyage nécessaire. 81 mots de deux lettres, 62 341 contenant K/W/Y/Z.

### Deux structures, deux usages

| | où | rôle | taille |
|---|---|---|---|
| **DAWG** | client | validation d'un mot, calcul de score | **0,45 Mo** |
| **GADDAG** | serveur | génération exhaustive des coups, top, isotops | **4,04 Mo** |

Le **GADDAG** (Gordon, 1994) stocke chaque mot dans toutes ses rotations autour
de chaque lettre pivot, ce qui permet de partir d'une case d'ancrage et
d'étendre à gauche *et* à droite en une seule passe. Sur une grille 15x15 le
choix serait cosmétique ; sur une grille infinie, le nombre d'ancrages croît
linéairement avec le nombre de coups joués et le facteur 2x devient décisif.

**Le dictionnaire est livré au client.** Il est public, les anagrammeurs en
ligne existent, et le client affiche déjà la grille et le tirage : le retenir ne
protégerait de rien. La distinction qui compte est ailleurs :

| Le client peut avoir | Le client ne reçoit **jamais** |
|---|---|
| le dictionnaire | **le top** |
| la grille, le tirage, les scores | **la liste des coups jouables** |
| l'historique des coups joués | **les coups précalculés** |

À 4 Mo, le GADDAG serait lui aussi livrable au navigateur. On n'en a pas besoin,
mais un mode entraînement solo hors ligne resterait possible sans rien
réécrire.

### Levier de performance principal

Ce n'est pas le GADDAG, ce sont ces deux points :

1. **Cache des cross-checks.** Les cross-checks — quelles lettres sont légales
   sur une case donnée compte tenu du mot perpendiculaire — sont **indépendants
   du tirage**. On les calcule une fois et on n'invalide que le voisinage du mot
   qui vient d'être posé. C'est le gain n°1 sur grille infinie.
2. **Grille creuse et index d'ancrages incrémental.** Jamais de balayage global.

### Format binaire

Commun aux deux structures. Une arête = un `uint32` :

```
bits 0-24   index de la première arête du nœud cible
bit    25   le nœud cible termine un mot
bit    26   dernière arête de ce nœud
bits 27-31  lettre (1-26 = A-Z, 27 = séparateur GADDAG)
```

Les arêtes d'un nœud sont contiguës : un nœud n'est donc qu'un entier, `0`
signifiant « aucune arête ». Côté TypeScript, chargement direct en
`Uint32Array`, sans parsing.

Construction par **minimisation incrémentale** (Daciuk, Mihov, Watson & Watson,
2000), qui exige une entrée triée — ce que `dictionnaire.txt` est déjà, et ce
que le tri externe fournit pour les rotations du GADDAG.

---

## 8. Comptes et grilles

### Comptes

Email + mot de passe, haché en **argon2id**, session par cookie `httpOnly`.

La colonne `email_verified` existe **dès le départ**, à `false`. La confirmation
par mail sera activée plus tard sans migration douloureuse.

> Risque assumé tant qu'elle est inactive : un email mal tapé rend le compte
> irrécupérable, faute de pouvoir envoyer une réinitialisation.

### Le modèle `Board`

Les grilles mondiale, vérifiée, les salons et les saisons ne sont **pas des
systèmes différents** : c'est un seul objet paramétré.

```
Board {
  visibilité   : publique | vérifiée | privée
  accès        : compte simple | compte vérifié | sur invitation
  fin          : jamais | après N coups | après une durée      <- « saison »
  chrono/coup  : aucun | N secondes                            <- mode « battle »
  bonus, table de poids, règles de tirage : par grille
}
```

Deux `Board` sont instanciés au lancement : la **grille mondiale** et la
**grille vérifiée**. Les salons deviennent alors gratuits.

Le mode **battle** (chrono par coup, on compte les tops trouvés à la fin) est
réservé aux salons.

### Anti-triche

> ⚠️ **La vérification ne garantit pas l'absence de triche**, elle la rend
> coûteuse. L'ODS est public et un solveur se code en un week-end. Ce que la
> grille vérifiée achète réellement : une identité nominative, donc un
> bannissement pénible à reconstituer.

Mesures : plafond de **5 soumissions par seconde**, plancher de temps de
réaction, détection statistique, comptes nominatifs sur la grille vérifiée.

> ⚠️ Le joueur au meilleur ping l'emporte structurellement sur les coups trouvés
> à quelques dixièmes de seconde près. Non résolu — voir « Reporté ».

---

## 9. L'interface

Grille rendue en **Canvas 2D**, jamais en DOM : quelques milliers d'éléments DOM
avec pan et zoom ne tiendraient pas les 60 fps. Culling du viewport.

**L'exigence de fluidité est primordiale** : au clic comme à la frappe, la
réponse de la grille doit être instantanée. C'est ce qui justifie le DAWG côté
client — la validation ne fait aucun aller-retour.

### Les caramels

Les 7 caramels sont affichés **au-dessus de la grille**.

> Ils doivent être dessinés comme de **vrais caramels de jeu** : bordure
> marquée, léger relief, et **séparés les uns des autres par la limite du
> caramel**, de façon qu'on distingue nettement chaque pièce. Pas de lettres
> posées à plat sur un fond uni. La valeur en points figure en petit dans le
> coin.

Un caramel joué par un joker a un **rendu distinct** du caramel normal.

### Pendant la frappe on compte, à la validation on juge

**Le score s'affiche à chaque lettre, quoi qu'on ait tapé.** Un mot en cours de
frappe n'est presque jamais un mot : `ARBOUSE` posé sur un A passe par `AR`, et
le détour est plus long encore quand on enjambe des caramels déjà posés —
`BIOSOURCE` sur un O posé donne `BIOSO` avant de redevenir un mot.

Répondre « mot non valide » à chacune de ces étapes, **à la place du score**,
revient à taire la seule chose qu'on regardait pour en donner une dont on n'a
que faire : on sait qu'on n'a pas fini de taper.

Sont donc **différés jusqu'à `Entrée`** : le mot inconnu, le collage inconnu, et
le contact avec la grille — un mot flotte dans le vide avant d'atteindre un
caramel. Le score, lui, est calculable pour n'importe quelle suite de lettres,
et c'est **le vrai score**, pas un chiffre de complaisance.

Ce qui reste refusé sur-le-champ est ce qui empêche de *poser* les caramels :
une lettre absente du tirage, un mot hors de la grille, plus de caramels que la
variante n'en autorise. Là, il n'y a pas de score à montrer.

Les collages fautifs restent signalés **en dessous du score**, à voix basse.

### Saisie

| Geste | Effet |
|---|---|
| Clic **gauche** sur la grille | écrit **horizontalement vers la droite** |
| Clic **droit** sur la grille | écrit **verticalement vers le bas** |
| Clic sur la **même case** | fait **pivoter le sens**, tant que rien n'est tapé |
| `Espace` | fait pivoter le sens, tant que rien n'est tapé |
| Frappe d'une lettre | la lettre **quitte** le tirage et se pose sur la grille |
| `Retour arrière` | reprend la dernière lettre posée |
| `Entrée` | valide le mot |
| `Échap` | efface la saisie, **le curseur reste en place** |
| **Glisser** | déplace la grille, même en pleine saisie |
| **Clic du milieu** | déplace la grille sans jamais toucher au curseur |

Le **sens du curseur ne compte pas quand on ne pose qu'une lettre**. Poser un
A derrière `LASSER` forme `LASSERA` que le curseur soit horizontal ou vertical :
avec une seule case, l'orientation ne veut rien dire. Le moteur bascule tout
seul dans l'autre sens quand le mot obtenu n'a qu'une lettre.

**« Le mot ne touche rien » n'apparaît qu'à la validation.** Un mot commence
presque toujours par flotter dans le vide avant d'atteindre un caramel déjà
posé ; refuser à la deuxième lettre n'apprend rien et empêche d'afficher le
score en cours. Pendant la frappe, le score s'affiche quand même ; le contact
n'est exigé qu'à l'appui sur Entrée.

**Au premier coup, on tape où on veut.** Le sens et l'endroit sont ignorés : le
logiciel replace le mot à l'horizontale, à travers l'origine, **à l'emplacement
qui rapporte le plus**. À score égal, le plus à gauche, pour que le choix soit
reproductible. Viser une case centrale sur une grille vide, où rien ne sert de
repère, n'aurait aucun intérêt.

Une lettre absente du tirage est **ignorée à la frappe** — sauf si un joker
reste, qui la prend. Aucun message : il ne se passe simplement rien.

**Le score du mot en cours s'affiche à chaque lettre.** En tapant `RUILERA` on
lit 2, 4, … 14, puis 66 à la dernière lettre avec la prime de scrabble. Il est
calculé par le moteur lui-même, donc il tient compte des bonus, des collages et
de l'affectation des jokers.

**Le joker s'affiche `?` dans le tirage**, sans valeur. La lettre qu'il porte
sur la grille prend une couleur distincte et **affiche `0`** : le zéro dit ce
qu'elle rapporte, il ne laisse pas deviner. Quelle lettre est portée par le joker est décidé par le moteur à chaque
frappe, pas devinée par l'interface.

Quand un mot perpendiculaire est faux, **c'est ce mot qui est nommé**, pas un
« collage non valide » qui n'apprend rien.

> Le pivotement est **inerte dès qu'une lettre est posée** : retourner le sens
> en cours de mot ferait basculer tout ce qui est déjà écrit.

Le curseur **survit à une validation** : on retape au même endroit sans avoir à
recliquer. Les caramels utilisés **disparaissent** du tirage : ni grisés, ni
remplacés par un vide.

**Le curseur enjambe les caramels déjà posés.** On ne tape que les lettres qu'on
pose : prolonger `BONJOUR` en `BONJOURS` ne demande que le `S`. Le mot est aussi
**prolongé automatiquement** par les caramels qui le touchent, pour qu'on ne
valide jamais `CAT` là où la grille lit `CATS`.

Taper une lettre absente du tirage alors qu'on possède un joker **consomme
automatiquement le joker**, avec le rendu graphique distinct.

Un mot invalide affiche **« mot non valide »**.

### Ce qui se passe à la validation

| Cas | Effet |
|---|---|
| Mot invalide | message d'erreur, **tout s'efface**, le tirage revient complet |
| Mot valide sous le top | **tout s'efface**, le tirage revient complet, la meilleure solution du joueur est mise à jour |
| Mot au score du top | le joueur **remporte le coup** : le logiciel pose son top canonique, et on ne voit plus que le nouveau tirage |

> Si le mot du joueur **est** le top canonique, ses lettres restent en place. Si
> le logiciel a retenu un autre isotop, c'est celui-là qui s'affiche.

Le tirage est **toujours en ordre alphabétique**, dans tous les cas.

### L'échelle s'efface devant la case désignée

Cliquer une case allume sa colonne et sa ligne dans les règles graduées. Loin de
l'origine, « -186 » tombait sur le « -180 » de la graduation : deux nombres
imprimés l'un sur l'autre, et plus moyen de lire ni la coordonnée demandée, ni
l'échelle.

Celle qu'on demande gagne. La graduation qui la gênerait n'est pas tracée — elle
se retrouve deux crans plus loin, et l'échelle garde son pas.

### Les colonnes prennent la place qu'il leur faut

Passé dix mille coups, « 10059 » mordait sur le mot dans les coups joués. La
colonne était fixée à la largeur de quatre chiffres, ce qui suffisait à toutes
les parties du monde — jusqu'à celle-là.

Elle se calcule maintenant sur le **nombre de coups joués** : elle ne prend que
ce qu'il lui faut, et les colonnes restent alignées d'une ligne à l'autre
puisque toutes lisent la même valeur. Vaut pour le journal comme pour la feuille
de route.

### Une partie close montre où elle s'est arrêtée

Un duplicate qui se termine au onzième coup affiche **11**, pas un tiret. Le
tiret effaçait le compte au moment précis où toute la table le regardait.

### Le classement montre ceux qui sont là

Y compris **à zéro**. Disparaître du tableau parce qu'on n'a rien marqué, c'est
ne pas savoir si l'on joue.

### Les séparations du panneau s'attrapent

Chacun ne suit pas la partie de la même façon : l'un veut voir tous les coups
joués, l'autre le chat, un troisième rien que le classement et la grille. Plutôt
que de choisir à leur place, **on laisse tirer les lignes** — jusqu'à effacer une
section, si c'est ce qu'on veut d'elle. Un **double-clic** lui rend sa taille
d'origine.

Deux lignes suffisent : celle qui sépare le tableau de bord des coups joués, et
celle qui sépare les coups joués du chat. Le chat prend ce qui reste — il n'a pas
de taille propre à défendre, et c'est lui qu'on veut voir grandir quand on
rapetisse le reste. Quatre-vingt-dix pixels lui sont réservés quoi qu'on tire :
une section qu'on ne peut plus rattraper n'est pas un réglage, c'est un piège.

La poignée déborde de trois pixels de chaque côté de la ligne qu'elle commande :
viser une ligne d'un pixel à la souris est un exercice, pas une interface.

Les hauteurs sont gardées avec les autres préférences : on ne réarrange pas son
écran à chaque visite.

**La liste des joueurs connectés ne pousse pas le reste.** Vingt pseudos
chassaient le classement hors de l'écran ; elle défile maintenant dans sa boîte.

### Affichages permanents

- **À droite** : la meilleure solution que *le joueur* a tapée sur ce coup.
- **En haut à droite** : le dernier top joué.
- Le **score cumulé de la partie** (collectif).
- Le **classement** : nombre de tops trouvés, uniquement. Pas de cumul de points
  par joueur.

> Les joueurs ne voient **rien** de ce que les autres tapent.

> ⚠️ **Le score du top ne doit apparaître nulle part avant d'être joué** — ni
> dans l'état diffusé, ni dans le journal du serveur. Il n'a jamais été envoyé
> aux clients, mais le terminal de l'hôte l'affichait : quelqu'un qui regarde
> cet écran connaîtrait le score à battre. Le journal ne mentionne désormais que
> le tirage et le temps de calcul, et ne dit ce qu'était le top qu'une fois le
> coup joué.

Les soumissions sont **illimitées** — le principe du topping est de taper
beaucoup de mots jusqu'à trouver le top. Le joueur ne voit que son meilleur mot
du coup.

---

## 10. La feuille de route

L'historique de la partie, sous forme de tableau :

```
coup │ tirage │ temps mis │ temps cumulé │ mot tapé │ joueur │ mot retenu
```

Les deux dernières colonnes sont bien distinctes : « mot tapé » est ce qu'a joué
le joueur, « mot retenu » est le top canonique effectivement posé. C'est la
conséquence directe de la règle des isotops.

Les temps sont exprimés en **années, jours, heures, minutes, secondes,
centièmes**, comptés depuis le début de la partie.

### Un résumé en tête, et ce qu'il compte

Une ligne au-dessus du tableau : nombre de coups, points posés, tops trouvés et
non trouvés, et — en topping seulement — le temps total. C'est ce qu'on regarde
en premier, et il fallait le reconstituer soi-même en parcourant les lignes.

Un demi-point **n'est pas un top**, et **ne rachète pas le coup**. Le compter
parmi les tops annonçait « 5 trouvés » là où il y en avait un seul et quatre
sous-tops ; le compter à part des perdus donnait un total qui ne tombait plus sur
le nombre de coups. Le coup reste perdu, et le demi-point se lit entre
parenthèses : « 1 trouvé, 55 non trouvés (dont 4 demi-points) ».

Pas de classement ici. La feuille de route sert à **jeter un coup d'œil à la
partie** ; le classement a sa place ailleurs.

### L'ordre suit la grille

Un **plateau borné** se lit du **premier coup au dernier**, comme une feuille de
match : la partie a une fin, on la parcourt. Une **grille infinie** se lit à
**l'envers**, du plus récent au plus ancien : elle n'a pas de fin, et ce qu'on
vient de jouer est ce qui intéresse.

### Seules les lignes visibles sont posées

Comme le journal des coups et la liste des solutions. Une partie de 5 302 coups
en a 5 302, et le tableau en montre vingt : les poser toutes demandait **1,7
seconde à l'ouverture** — dont un tiers rien qu'à analyser l'icône d'appareil
photo, cinq mille fois. Mesuré après : **5 ms**.

Les clics sont recueillis par **un seul écouteur** posé sur le tableau, qui lit
l'attribut de la ligne ou du bouton touché.

Le tableau est **découvert avant d'être peint** : le nombre de lignes à poser se
déduit de sa hauteur, et un tableau caché n'en a pas — on n'en posait que cinq,
et les autres n'arrivaient qu'au premier défilement.

**Un champ de recherche** remplace le Ctrl+F du navigateur, qui ne trouvait plus
rien puisque les lignes ne sont plus toutes là. Il cherche mieux : dans tous les
coups de la partie et non dans les vingt affichés, et sur le mot comme sur le
tirage, la place, le trouveur ou le numéro du coup.

**Une espace finale ferme le mot.** Chercher « QI » ramène QIS, QIN, QING et
TAQIYA avec les QI — ce qui est juste quand on cherche une racine, et faux quand
on veut compter ses QI. L'espace est le signe naturel de la fin d'un mot :
« QI  » ne garde que ce qui vaut **exactement** QI. Rien à apprendre, rien à
cocher, et le geste est déjà dans les doigts.

Un bouton **`ab`**, souligné comme dans un éditeur de texte, demande la même
chose et **tient sans y penser**. Les deux façons cohabitent parce que les deux
se rencontrent : l'espace pour une recherche, le bouton pour une série.

La règle vaut aussi dans le **rejeu**, sur les sous-tops d'un coup : chercher
« MA » y ramenait MAS, MAT, AMAS, MADRE et deux cents autres, et il fallait
trouver à la main le mot de deux lettres qu'on cherchait.

**Le champ s'efface en fermant la feuille, et l'ordre revient à celui de la
partie.** Un filtre ou un tri qu'on retrouve en rouvrant est un tableau amputé
ou rebattu sans qu'on sache pourquoi : on a cherché « QI » il y a un quart
d'heure, et la partie de neuf mille coups n'en montre plus douze.

**Un filtre qui ne ramène rien le dit.** Un grand blanc ne distingue pas la
recherche infructueuse du tableau cassé.

**La liste ne glisse pas sous les yeux.** Sur une grille infinie, un coup neuf
s'insère en tête et pousse tout le reste d'une ligne : qui lisait le milieu
voyait le texte se décaler et un clic tomber à côté. Le décalage est rattrapé —
sauf en haut de liste, où l'on veut justement voir arriver le coup.

### Les colonnes sont alignées

Chaque ligne est sa propre grille CSS. Une largeur `auto` ou `fr` s'y recalcule
donc **ligne par ligne**, et le tirage d'une ligne ne tombe pas sous le tirage de
la précédente. Les colonnes de la feuille de route sont **fixes**, à la seule
exception du nom du joueur, qui prend ce qui reste.

**Une ligne par coup, jamais deux.** La colonne de place était trop étroite pour
`H -142,-138` : la notation passait à la ligne, la ligne débordait sur la
suivante, et la lecture se cassait là où la grille est justement la plus
intéressante. Aucune cellule ne se replie, la ligne ne dépasse pas sa hauteur, et
ce qui ne tient pas se termine en points de suspension. La colonne de place tient
maintenant des coordonnées à quatre chiffres.

**La fenêtre ne change pas de taille.** Elle est fixée à `88vh` — filtrer sur un
mot qui ne sort qu'une fois la réduisait à presque rien, et une fenêtre qui se
rétracte à chaque lettre tapée donne l'impression que quelque chose casse.

Cette hauteur fixe est **celle de la feuille de route seule**. Le panneau des
réglages, qui partageait la même classe, s'était retrouvé figé à `88vh` alors
qu'il doit garder la hauteur de son contenu : il grandit et rétrécit selon la
grille choisie.

### La police est celle du système

La feuille de route se lit dans la **monospace du système** — Consolas sur
Windows, SF Mono sur Mac : celle que le lecteur voit tous les jours dans ses
tableaux, et qu'il n'a pas à télécharger pour ouvrir la feuille.

### Trier les coups

Un menu dans l'en-tête, à côté de la recherche. L'**ordre de la partie** reste
celui par défaut — une feuille de match se lit dans l'ordre où elle a été écrite.
Les autres tris répondent à des questions qu'on se pose après coup : quel a été
le plus gros coup, le plus long mot, celui qu'on a trouvé le plus vite.

Chaque critère se donne dans les **deux sens, écrits en toutes lettres** :
« points, du plus cher » ne se lit pas de travers, une flèche dans un coin si. À
égalité, l'ordre de la partie tranche — sans quoi deux coups de même valeur
changeraient de place d'un affichage à l'autre. Un coup que personne n'a trouvé
n'a pas de temps de recherche : il part au bout, dans les deux sens.

### La feuille s'enregistre en un document

Un bouton au bout de la ligne de résumé écrit **une page HTML autonome** sur
l'ordinateur du lecteur. Elle s'ouvre d'un double-clic dans n'importe quel
navigateur, s'imprime, et garde ses colonnes. Un tableur demanderait de choisir
un séparateur et perdrait la mise en page ; une image ne se chercherait pas.

**Un document n'est pas une copie d'écran de l'application.** Ce qu'on enregistre
se relira ailleurs, hors du jeu, peut-être dans des années : rejouer un coup,
tirer une image, aimer un coup sont des gestes qui demandent un serveur et un
salon. Ces boutons ne partent donc pas dans le fichier — il ne reste que le
tableau.

On enregistre **ce qui est affiché**, filtre et ordre compris : chercher « QI »
puis enregistrer, c'est vouloir la liste de ses QI, pas la partie entière. Le
document le dit en tête, pour que personne ne le prenne plus tard pour la feuille
complète.

### La colonne du temps n'existe qu'en topping

En topping, le temps est une performance : c'est ce qu'a mis le joueur pour
trouver. Un coup que **personne n'a trouvé** porte une **croix**, pas une durée —
celle de l'échéance ne dirait rien de personne.

Elle est suivie d'un **cumul**, le temps écoulé depuis le premier coup. Il se
compte dans l'ordre de la partie, quel que soit l'ordre d'affichage.

En duplicate, ces deux colonnes **disparaissent** : le coup dure toujours le
chrono entier, la même valeur sur toutes les lignes. Deux autres les remplacent :

| colonne | contenu |
|---|---|
| **négatif** | l'écart au top du lecteur sur ce coup, `top` s'il l'a trouvé, `—` s'il n'était pas là |
| **n/N** | combien de joueurs ont trouvé, sur combien étaient présents au tirage |

Un coup trouvé par 1 joueur sur 6 n'a pas le même sens qu'un coup trouvé par 6
sur 6 : c'est ce que dit cette colonne, et rien d'autre ne le disait.

### Qui a trouvé

En topping, c'est celui qui a posé le top. En duplicate, **personne ne le pose**
— le coup se clôt à l'échéance — et les trouveurs sont une **liste**, qui peut
être vide.

**Au-delà de deux noms, on compte au lieu d'énumérer** : « 6 joueurs ». Six
pseudos bout à bout débordaient de leur colonne, et une ligne qui se chevauche ne
se lit plus du tout — alors que le nombre se lit d'un coup d'œil. La liste
complète reste dans l'infobulle de la ligne, et la recherche continue de porter
sur les noms. Lire le poseur en duplicate écrivait « non trouvé » sur toutes les
lignes d'une partie où le top avait pourtant été trouvé.

### Affichage et interaction

La feuille de route **n'est pas affichée par défaut** : elle s'ouvre à la
demande.

Une fois ouverte, elle a **deux niveaux d'interaction**, et il ne faut pas les
confondre :

1. **Cliquer un mot le met simplement en valeur** — sur la grille et dans la
   liste. Rien d'autre ne bouge : pas de rembobinage, pas de changement de vue.
   C'est une consultation, pas une navigation.
2. **Un bouton `R`, à droite du top**, ouvre le rejeu sur ce coup-là. Il
   n'apparaît que sur une **partie close** : avant, le serveur refuse les
   paliers et le rejeu n'aurait rien à montrer. Une fois dedans, on navigue
   normalement d'un coup à l'autre.

### On ne recalcule pas deux fois le même coup

Sur un plateau borné, les paliers ne sont pas au journal : on les refait à la
demande. Or dans le rejeu **on navigue** — coup 7, coup 8, retour au 7 — et le
retour coûtait aussi cher que la première visite, quelques secondes sur un coup
à deux jokers, pour un résultat identique au caramel près : la position d'avant
le coup et le tirage ne changent plus, la partie est jouée.

La partie garde donc ce qu'elle a refait. La mémoire se compte en **solutions**
et non en coups — un coup ordinaire en a quelques centaines, un coup à deux
jokers sur une position ouverte en a compté 18 655 : compter les coups laisserait
la mémoire varier d'un facteur cent selon la partie, alors qu'ici on cherche à la
borner. Soixante mille solutions tiennent dans quelques mégaoctets et couvrent
une 15×15 entière dans presque tous les cas.

Ce qu'on jette est le plus anciennement **consulté**, pas le plus anciennement
calculé : qui fait des allers-retours entre deux coups ne doit pas voir l'un des
deux s'effacer à chaque passage.

> Une grille infinie ne passe jamais par là : ses paliers sont au journal.

### Les paliers restent en réserve

Un **palier** est un score, avec **tous** les coups qui le réalisent :

| palier | contenu |
|---|---|
| 0 | le top et ses **isotops** |
| 1 | **le sous-top** au sens strict du jargon — la deuxième solution la plus lucrative |
| 2, 3, … | les paliers suivants |

> ⚠️ **Les paliers ne sont PAS montrés pendant la partie, ni même envoyés au
> client.** Ils sont calculés, écrits dans le fichier de partie, et gardés là
> pour l'analyse d'après-partie. Montrer les isotops et les sous-tops en direct
> transforme la recherche du top en lecture de liste.

Le nombre d'isotops n'est pas diffusé non plus : c'est une indication sur la
forme du coup, donc sur le coup.

**Un palier n'est jamais coupé par le milieu.** Montrer trois coups à 34 points
sur les neuf qui existent, sans le dire, donne une liste qui a l'air complète et
ne l'est pas. Le plafond, quand il y en a un, tombe donc entre deux paliers.

**Sur un plateau borné, les paliers ne sont pas enregistrés du tout.** Ils
faisaient **86 % du poids d'un journal** — 3 028 octets par coup contre 415 sans
eux — et une position de 15×15 se résout en quelques millisecondes. Le rejeu les
**refait à la demande**, complets, en remontant la grille au coup demandé.

Mesuré : un journal de 15×15 passe de ~11 500 à **378 octets par coup**, et le
recalcul coûte **19 ms par coup**, jusqu'à 6 000 solutions.

C'est l'équilibre habituel des logiciels de ce genre : on garde le paramétrage,
les tirages et le coup joué, et on recalcule le reste.

**Sur une grille infinie, on les garde** : au trois-millième coup, refaire une
position demanderait près d'une seconde — la question ne se pose pas. Et il en
faut un plafond : la grille grandit sans fin, donc le nombre d'ancrages aussi. Même mesure : **15 333 solutions par position en
moyenne, 166 659 au pire, 35 Mo pour cent vingt coups**. On s'y arrête à quarante
paliers ou cent vingt solutions, le premier atteint.

C'est la seule différence de fond entre les deux grilles sur ce point, et elle
vient d'un rapport de trente entre les deux.

**Un clic sur un coup passé amène la caméra dessus** et le met en évidence,
avec dézoom puis zoom s'il est hors champ. Rien de plus.

**Un clic pendant un vol pose d'abord la caméra.** Sinon la case lue est celle
qu'on visait à cet instant, pas celle qu'on avait sous les yeux quand le résultat
s'affichait : en rejeu, où l'on clique une solution puis la grille, une autre
case se trouvait sélectionnée.

### Rien n'annonce le top en bas de l'écran

Le coup joué s'affiche au tableau « Top », au journal des coups et sur la
grille. Un bandeau flottant qui répétait la même chose une seconde n'apprenait
rien à personne.

Au **duplicate**, ce tableau porte en plus **l'écart au top du lecteur sur ce
coup**, s'il y en a un. Il reste affiché tant que le coup suivant ne l'a pas
remplacé — c'est le temps qu'on a de le lire.

### Ce qui ne bouge pas n'est peint qu'une fois

Se déplacer ne change ni la grille ni l'échelle : seule la caméra bouge. Primes,
quadrillage et caramels sont donc peints **une fois** dans une image de côté un
peu plus grande que l'écran, et le déplacement n'est plus qu'une recopie. Quand
la caméra sort de la marge, l'image **glisse** — on la décale et on ne repeint
que la bande découverte.

Le glissement se compte en **pixels d'écran**. Sur un écran à 125 %, un pixel de
mise en page en vaut 1,25 : glisser d'un nombre entier de pixels de mise en page
tombait entre deux pixels réels, le navigateur rééchantillonnait, et comme
l'image se recopie dans elle-même, le flou **s'ajoutait** à chaque glissement.

**Le tracé se cale sur les mêmes pixels d'écran.** C'est la contrepartie
obligée : un glissement en pixels d'écran entiers fait un nombre *fractionnaire*
de pixels de mise en page — 141 pixels d'écran valent 112,8 pixels de mise en
page à 125 %. Tant que les cases se calaient sur des pixels de mise en page
entiers, celles de la bande fraîchement repeinte tombaient à côté de celles qui
avaient simplement glissé, et la jonction laissait une **couture claire** :

| écran | décalage d'une case entre bande repeinte et contenu glissé |
|---|---|
| 100 % | aucun |
| 125 % | un demi-pixel |
| 150 % | un pixel entier |

D'où un défaut invisible sur un écran à 100 % et bien réel ailleurs. La couture
ne partait qu'à la reconstruction complète, c'est-à-dire au premier changement
de zoom.

**La marge suit l'échelle.** Elle se compte en pixels, mais ce qu'elle coûte se
compte en cases : à douze pixels par case, 320 pixels font vingt-six cases de
rab ; à deux pixels, cent soixante — et l'image couvre alors trois fois la
surface de l'écran, donc trois fois les caramels à peindre.

**Changer d'échelle n'invalide pas l'image : on sait l'étirer.** Pendant un
geste de molette, chaque cran ne coûte qu'une recopie ; l'image se repeint une
seule fois, quand la molette s'arrête. La vue est un peu molle le temps du
geste, nette dès qu'il cesse.

Mesuré sur une partie de 5 500 coups, au dézoom maximum :

| | |
|---|---|
| avant, par cran de molette | 995 ms |
| après, pour un geste de dix crans | **1 ms** |
| remise au net, une fois | 130 ms |
| déplacement | 0,3 ms médian |

### Les caramels posés suivent l'ordre de la frappe

L'écran compte le tirage restant en appariant les caramels posés aux lettres
tapées. Il ne peut pas le faire **par coordonnées** : au premier coup, le moteur
*déplace* le mot pour lui faire couvrir l'origine au meilleur endroit. Il le fait
donc **dans l'ordre**, qui lui ne change pas.

Sans cela, un premier coup à deux jokers partait en morceaux : une lettre posée
revenait en main, un joker disparaissait, et la lettre suivante était refusée
sans qu'on comprenne pourquoi.

### Un joker mis en évidence vaut toujours zéro

Le mot qu'on clique se repose sur la grille en vert. Il n'est qu'une **suite de
lettres** : rien n'y dit qu'un joker en tient une. Le O de T(O)M s'affichait donc
à 1 point alors qu'il n'en rapporte aucun, et le compte ne tombait plus juste
sous les yeux de celui qui relisait le coup.

La vérité est **sur la grille** : chaque caramel posé garde sa marque de joker.
Encore faut-il ne lire que les caramels **de ce coup ou d'avant** — un caramel
posé plus tard occupe la case sans rien dire du mot qu'on regarde.

Reste le mot qui n'est nulle part sur la grille : l'isotop d'un joueur que le
logiciel n'a pas retenu, une solution qu'on parcourt dans le rejeu. Celui-là
vient de la main, et **les lettres que le tirage ne contient pas sont des
jokers**. Un tirage qui a à la fois la lettre et le joker laisse un doute ; on
prend la lettre, qui rapporte davantage et que le solveur préfère pour la même
raison.

### Le coup du joueur a sa propre place

Le logiciel retient **un** isotop parmi les coups à score égal, et ce n'est pas
toujours celui qu'on a trouvé. Dans la liste dépliée d'un joueur, cliquer sur
son propre coup emmenait donc la caméra ailleurs, sans rien qui l'explique.

Chaque ligne porte maintenant **la place du coup du joueur**, à droite du mot,
cliquable — elle mène à *sa* solution. La ligne, elle, continue de mener au top
retenu : les deux sont utiles, ils ne se confondent plus.

C'est encore plus vrai d'un **demi-point** : sa solution n'est nulle part sur la
grille, et cette place était le seul moyen de savoir où il l'avait vue.

La cellule existe toujours, **vide quand les deux places coïncident** — une
colonne qui apparaît et disparaît décalerait tout le reste de la ligne.

### Rien de ce qui entoure la grille n'en change la taille

Un plateau borné se recadre à chaque changement de taille du canevas : la taille
des cases et le centrage se recalculent, et **tout le plateau se déplace**. Ce
qui l'entoure ne doit donc jamais grandir ni rétrécir sous lui.

La **bande du reliquat** vit juste au-dessus, dans le flux. Sa présence ne dépend
plus de son contenu — qui change à chaque coup et finit vide — mais de la
variante, qui ne change pas de la partie. Elle tient sur **une ligne fixe** et
défile plutôt que de passer à deux.

Le cadrage lui-même se cale sur des **pixels d'écran** : la moitié d'un écart
impair de largeur donnait un demi-pixel, et le plateau se décalait d'un cheveu à
la moindre variation de mise en page.

### Un plateau borné ne bouge pas

Il tient tout entier à l'écran et son cadrage est calculé une fois pour toutes.
Rien ne doit l'en déloger : ni les flèches du clavier, ni un vol de caméra, ni le
partage d'une case dans le chat — qui appelait pourtant un vol, dézoomait la
grille et l'y laissait, le zoom étant désactivé sur ce format.

**On n'y écrit pas non plus hors des bornes.** La lettre qui tomberait dehors ne
part pas : mieux vaut qu'une touche ne fasse rien que d'écrire dans le vide et de
l'annoncer après coup. « Le mot sort de la grille » ne se lisait qu'une fois le
mal fait, et les lettres flottaient dehors en attendant.

### La caméra n'est jamais déplacée d'office

Quand un joueur trouve le top, **l'écran des autres ne bouge pas**. Se faire
déplacer sans l'avoir demandé, en pleine recherche, donne le mal de mer. Le
coup joué s'affiche dans le bandeau ; qui veut le voir clique dessus.

### « J'aime »

Un beau coup se salue. Un bouton ♡ accompagne le dernier top, chaque ligne de
la feuille de route et chaque coup de la liste dépliée d'un joueur.

- le « j'aime » va au **joueur qui a trouvé le top**, pas au mot ;
- on ne s'aime pas soi-même, et un coup révélé sans vainqueur n'a personne à
  féliciter — le bouton est alors inerte ;
- un clic ajoute, un second retire ;
- le total reçu s'affiche **en vert à côté du nombre de coups trouvés** dans le
  classement.

### Un palier ne se tronque jamais

C'est la règle qui gouverne tout le reste. Le nombre de coups par palier varie
d'un facteur 300 d'un tirage à l'autre :

```
AEQVWXZ   paliers de 1 à 5 coups        → il en faut 25 pour atteindre 100 coups
?AEILRT   palier à 78 points : 254 coups → un plafond à 100 en montrerait 74
??AEILR   palier du top      : 163 coups → un plafond à 100 tronquerait les isotops
```

Un plafond exprimé en nombre de coups couperait donc **au milieu d'un palier** :
on afficherait 74 coups à 78 points sans dire que 180 autres existent. La
rétention se compte en **paliers entiers**, jamais en coups.

Deux réglages, tous deux respectés à la frontière d'un palier :

- **`tiers`** — combien de paliers sous le top.
- **`maxMoves`** — garde-fou : on abandonne les paliers du bas jusqu'à passer
  sous le plafond. **Le palier du top n'est jamais sacrifié** : tronquer des
  isotops n'aurait aucun sens puisqu'ils sont tous des tops valables.

Un tirage explosif calcule donc naturellement moins : à 10 paliers demandés et
400 coups de plafond, `?AEILRT` en rend 9 et `??AEILR` seulement 6.

> Coût mesuré : **×0,99 à ×1,16** par rapport au top seul. Les paliers sont
> quasi gratuits, parce que la descente est la même — seul le seuil de rétention
> descend, et un coup n'est matérialisé que s'il peut entrer au classement.

C'est gratuit à construire : la base est événementielle.

---

## 11. Architecture

| | |
|---|---|
| Langage | TypeScript, partout |
| Structure | monorepo, 3 paquets : `engine/` · `server/` · `web/` |
| Front | React + Vite |
| Rendu grille | **Canvas 2D** |
| Serveur | Node + Fastify + WebSocket |
| Base | PostgreSQL, event-sourcé sur une table `moves` |
| Auth | email + argon2id + cookie `httpOnly` |
| Moteur | GADDAG serveur / DAWG client, `Uint32Array` |
| Hébergement | **un VPS Docker — pas de serverless** |

Le serverless est exclu : WebSocket persistant et état de jeu en mémoire exigent
un processus qui vit.

`engine/` ne connaît **ni le réseau ni la base**. C'est du TypeScript pur,
testable seul, et le seul module qu'on pourrait avoir à réécrire en Rust/WASM si
la performance coinçait un jour. Son interface reste étroite pour que ce
remplacement soit indolore.

### Event sourcing

Chaque coup est une ligne immuable :

```
tirage · mot · coordonnées · score · joueur · timestamp_ms · paliers[]
```

Toutes les statistiques, le classement et le rejeu se dérivent de cette table.
Il n'y a rien d'autre à stocker.

### Deux fichiers, et c'est voulu

| fichier | rôle |
|---|---|
| `<partie>.journal.jsonl` | **ajout seul**, une ligne par événement, `fsync` à chaque ligne, jamais réécrit. **C'est lui qui fait foi.** |
| `<partie>.json` | instantané complet, réécrit à chaque coup. Commodité de lecture pour les outils. |
| `<partie>.secours.json` | copie de l'instantané, prise tous les 20 coups. |

Une partie qui dure des mois ne doit pas tenir à un fichier qu'on réécrit sans
cesse : il suffit d'une coupure au mauvais moment, d'un disque qui tousse ou
d'une fausse manœuvre pour tout perdre. Le journal ne se réécrit jamais.

**On peut effacer l'instantané sans rien perdre** : au démarrage, s'il y a un
journal, la partie se reconstruit intégralement à partir de lui — graine,
coups, chat, « j'aime ». Une partie ancienne qui n'a qu'un instantané se voit
doter d'un journal rétroactivement, au premier démarrage.

Les lignes tronquées par une coupure sont ignorées à la relecture, avec un
avertissement : une ligne perdue ne condamne pas les précédentes.

### Recommencer ne veut pas dire changer de jeu

`--nouvelle` **garde la variante** de la partie qu'il remplace : tirage, lettres
jouables, pioche. La ligne de commande peut en demander une autre, mais rien ne
se perd par défaut, et le démarrage annonce ce qui a été repris.

Elle se lit **avant** l'archivage, faute de quoi elle disparaîtrait avec les
fichiers. C'est arrivé : une grille permanente réglée sur le sac de 102 bouclant
est repartie en probabilités pondérées sans que rien ne le dise — et sans
reliquat à l'écran, puisque des probabilités n'ont pas de stock. Le symptôme
était à trois écrans de la cause.

### Commencer une nouvelle grille

Deux façons, aucune ne détruit quoi que ce soit :

```
--partie <autre-nom>      grille neuve sous un autre nom, l'ancienne intacte
--nouvelle                met la grille courante de côté et repart à zéro
```

### Un seul serveur par partie

Un fichier `<partie>.verrou` porte le PID du serveur qui l'a ouverte. Un second
serveur sur la même partie **refuse de démarrer**, même sur un autre port : deux
processus écrivant dans le même journal en feraient une bouillie, les coups
s'entrelaçant sans numérotation cohérente.

**Le verrou bat** toutes les dix secondes, et on le tient pour mort au-delà de
quarante. Le numéro de processus seul ne suffit pas : le système les **recycle**.
Un verrou laissé par un serveur tué a ainsi bloqué un démarrage parce que son
numéro avait été repris par un processus Windows sans aucun rapport — « ce
processus existe-t-il ? » répondait oui. Le battement tranche : celui qui ne bat
plus n'est tenu par personne.

C'est le cas courant sous Windows, où fermer la fenêtre tue le serveur sans lui
laisser rendre son verrou.

Un échec sur la grille principale s'affiche **en clair**, pas en trace d'appels :
c'est presque toujours un verrou, et le message dit quoi faire.

### Retrouver une partie

```
npm run parties
```

Liste tout ce qui est sur le disque : nom exact, nombre de coups, date de
création, date du dernier coup, joueurs, et si un serveur la tient ouverte.

`--nouvelle` **renomme les trois fichiers** sous un même horodatage —
`mondiale.1787875916154.json`, `.journal.jsonl`, `.secours.json` — et annonce
comment rouvrir l'archive : `--partie mondiale.1787875916154`. Le journal doit
partir avec les autres : c'est lui qui fait foi, l'oublier ferait revenir
l'ancienne partie au démarrage suivant.

---

## 12. Les fichiers

```
topping infini/
├── SPEC.md                    ce document
├── dictionnaire.txt           ODS9, 407 128 mots (source, non modifié)
└── packages/
    └── engine/
        ├── data/
        │   ├── dawg.bin       0,45 Mo — généré, non versionné
        │   └── gaddag.bin     4,04 Mo — généré, non versionné
        └── tools/
            ├── build_dawg.py      compile dictionnaire.txt -> dawg.bin
            ├── build_gaddag.py    compile dictionnaire.txt -> gaddag.bin
            ├── verify_dawg.py     réénumère et compare à la source
            └── verify_gaddag.py   compte les rotations et les vérifie
```

Les compilateurs de dictionnaire sont en **Python** et le resteront : ce sont des
outils **hors ligne**, exécutés une fois, dont la sortie est un binaire que le
TypeScript se contente de charger. Leur langage n'a aucune importance.

### État de vérification

- **DAWG** : réénumération complète -> exactement les 407 128 mots source, à
  l'identique.
- **GADDAG** : exactement 4 080 472 chaînes acceptées, soit précisément la somme
  des longueurs des mots (ni manque ni excédent), et les rotations des 407 128
  mots toutes présentes, une par une.

### Pièges Windows rencontrés

- `sort` se résout vers `System32\sort.exe`, qui ne connaît ni `-u` ni `-o`. Il
  faut viser explicitement le `sort` GNU de Git for Windows. Corrigé et commenté
  dans `build_gaddag.py`.
- Node est installé dans `C:\Program Files\nodejs\` (v24.19.0) ; un shell ouvert
  avant l'installation garde un `PATH` périmé.

---

## 13. Reporté

Décisions volontairement non prises, à trancher sur des données réelles plutôt
qu'à l'intuition.

| Sujet | État |
|---|---|
| **Passage à l'échelle du générateur** | **Arbitré : on l'assume.** Le coût croît linéairement avec le nombre de coups joués (§15) et ne se corrige pas vraiment. Le précalcul de quelques coups d'avance le masque ; dans le cas improbable où les joueurs vont plus vite que la machine, ils attendent. Optimisations déjà faites : ×1,7. |
| **Taux de scrabbles à 64 %** | Mesuré, pas décidé. Conséquence directe de la table de tirage : le sac classique donnerait 30 % (§15). À arbitrer. |
| **Motif des cases bonus** | Couture corrigée (période 14, §3) : le taux de ×9 passe de 20 % à 4,6 %. Le motif définitif, conçu pour l'infini, reste à choisir parmi les trois pistes de §3. |
| **Critère de départage des isotops** | Aléatoire déterministe. Mesure : 74 % des coups ont un top unique, médiane 1 isotop (§15) — l'enjeu est donc mineur, contrairement à ce qu'on craignait. |
| **Mots de plus de 15 lettres** | L'ODS s'arrête à 15, la grille non. Les étendre supposerait de dériver pluriels et conjugaisons — ce ne sont plus des formes officielles. |
| **Réglage fin de alpha et du plafond** | 0.08 et x4, à valider par simulation. |
| **Rejet probabiliste du tirage** | La politique de rejet est déjà une fonction remplaçable. |
| **Notifications** | Rien pour l'instant : on revient quand on veut. |
| **Avantage de ping** | Non résolu. Pistes : mesurer le temps client depuis l'affichage du tirage, avec un plafond anti-triche. |
| **Mode battle** | Prévu dans le modèle `Board`, non implémenté. |
| **Nom du jeu** | À trouver. |

---

## 14. Ordre de construction

- **Phase 0 — le moteur seul, sans réseau ni interface. ✅ TERMINÉE**
  Compilation DAWG + GADDAG · grille creuse · scoring et `bonus(x,y)` ·
  générateur exhaustif, top, isotops · pioche pondérée · simulateur headless.
  Mesures en §15.

  Validation : un **second générateur indépendant** (DFS contraint par motif,
  DAWG seul, aucun GADDAG) a été écrit exprès pour contredire le premier.
  Accord exact sur **2 662 887 coups** répartis sur 434 positions, jusqu'à des
  grilles de **80 coups** (1 000 caramels, 1 200 ancrages) : tous les coups
  légaux, scores recalculés à l'identique, cache des cross-checks confirmé sain
  après chaque coup.

  ```bash
  node packages/engine/test/check_movegen.ts 15 14
  node packages/engine/tools/report.ts 500 mondiale
  ```

- **Phase 1 — jouable, en réseau. ✅ PROTOTYPE EN PLACE**
  Canvas, caramels, saisie clavier, validation locale par le DAWG, serveur
  autoritaire en WebSocket, solveur dans un fil dédié, sauvegarde sur disque.

  ```bash
  npm run build     # compile le client
  npm run serve     # démarre la grille sur http://localhost:3000
  ```

  Le client **partage le moteur** avec le serveur : même dictionnaire, même
  scoring, même résolution d'un mot tapé. Un mot accepté à l'écran ne peut donc
  pas être refusé ensuite. Vérifié sur 19 893 coups (`check_play.ts`).

  **Sauvegarde** : seul le journal des coups est écrit. La partie étant
  déterministe, on rejoue les placements au démarrage et le sac retrouve son état
  de compensation. Écriture atomique, pour qu'une coupure ne laisse pas un
  fichier à moitié écrit.

  **La graine est tirée au hasard à la création** et rangée dans la sauvegarde.
  Elle ne dérive surtout pas du nom de la grille : deux grilles nommées pareil
  rejoueraient sinon exactement la même partie, tirages compris. `--nouvelle`
  archive la partie en cours et repart sur une grille vierge.

  **Ouvrir aux autres** sans toucher à la box :
  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```
  Le serveur tourne sur la machine de l'hôte ; le tunnel lui donne une adresse
  publique. Aucune inscription : chacun tape un pseudo en arrivant.

  > ⚠️ Tous les joueurs pingent la machine de l'hôte. Comme la course se joue à
  > l'ordre d'arrivée, les joueurs géographiquement proches ont un avantage réel.
  > Sans importance pour un test, à revoir le jour où le classement comptera.

- **Phase 2 — parties paramétrables, comptes, statistiques.** Dans cet ordre :
  le modèle de partie réglable (§16) — il débloque les variantes ET sert la
  phase 3 —, puis le précalcul de 5 coups et le rate-limit, puis les comptes
  optionnels et les statistiques, puis le domaine, la vérification par mail et
  la mise en ligne.

- **Phase 3 — les grilles multiples.** Modèle `Board`, grille mondiale et
  vérifiée, salons, mode battle.

---

## 15. Mesures de la phase 0

Partie simulée de 500 coups, graine `mondiale`, moteur jouant son propre top à
chaque coup. Ce sont des mesures, pas des décisions : elles alimentent §13.

### Le générateur ne passe pas l'échelle d'une grille permanente

| coups | tuiles | ancrages | médiane | pic |
|---|---|---|---|---|
| 1-50 | 311 | 199 | 22 ms | 551 ms |
| 101-150 | 951 | 1 040 | 123 ms | 1 508 ms |
| 251-300 | 1 893 | 2 183 | 191 ms | 3 896 ms |
| 401-450 | 2 846 | 3 262 | 329 ms | 5 512 ms |
| 451-500 | 3 169 | 3 636 | 297 ms | 4 272 ms |

Le coût est proportionnel au nombre d'ancrages, lui-même proportionnel au
nombre de coups joués : environ **0,6 ms par coup déjà joué**. Extrapolation au
coup 5 000 : ~3 s de médiane ; au coup 20 000 : ~12 s, avec des pics de
plusieurs minutes.

### Les jokers expliquent tous les pics

| jokers | part des coups | médiane | pic |
|---|---|---|---|
| 0 | 92 % | 107 ms | 545 ms |
| 1 | 8 % | **1 158 ms** | 4 410 ms |

Un seul joker multiplie le temps par **11**, et les coups les plus lents en ont
tous au moins un. La cause est mécanique : sur une case vide sans joker, le
moteur essaie les ~6 lettres distinctes du tirage ; avec un joker il doit
essayer toutes les lettres autorisées par le cross-check, à chaque case, et ça
se compose sur la longueur du mot.

**Optimisation appliquée** : parcourir en une passe les arêtes réellement
présentes sur le nœud du GADDAG, au lieu de sonder les 26 lettres une par une.
Résultats strictement identiques, revérifiés par le générateur de référence.

| tirage | avant | après | |
|---|---|---|---|
| `BCDFGHJ` | 16 ms | 11 ms | -31 % |
| `AEILRST` | 431 ms | 359 ms | -17 % |
| `?ADIORS` | 2 538 ms | 1 873 ms | -26 % |
| `?AEILRT` | 3 612 ms | 2 804 ms | -22 % |
| `??AEILR` | 16 011 ms | **10 376 ms** | -35 % |

Un tirage à deux jokers coûte donc encore **10 secondes**, et il sort environ une
fois sur cent. L'élagage des ancrages reste nécessaire.

> ⚠️ **Une grille mondiale qui ne se réinitialise jamais devient donc de plus en
> plus lente, sans borne.** Le précalcul de 3 coups d'avance masque les pics
> ponctuels, pas cette dérive de fond.

Correctif prévu : **élagage des ancrages par borne supérieure**. Pour chaque
ancrage on calcule à bas coût un majorant du score atteignable (meilleures
lettres du tirage × meilleurs multiplicateurs à portée) ; on traite les ancrages
par majorant décroissant et on abandonne dès que le majorant passe sous le
meilleur score déjà trouvé. La plupart des ancrages sont dans des zones mortes,
loin de toute case bonus. Comme il faut aussi énumérer les isotops, l'élagage se
fait en deux passes : trouver le maximum, puis collecter les ex æquo.

### Les isotops sont un non-problème

```
médiane 1   moyenne 1,4   90e centile 2   maximum 24
tops uniques : 386 / 500 (77 %)
```

Le maximum de 24 est tombé dans les **50 premiers coups**, pas à la fin : sur une
grille encore petite et régulière, les placements équivalents abondent. Ensuite
la grille devient irrégulière et les égalités exactes se raréfient. Le nombre
d'isotops **décroît** avec la taille de la grille, à l'inverse de ce qu'on
craignait.

### Le pavage : avant et après correction de la couture

| | période 15 | période 14 |
|---|---|---|
| coups à multiplicateur de mot ≥ ×9 | 101 / 500 (**20 %**) | 23 / 500 (**4,6 %**) |
| paires de MCT adjacentes sur 81x81 | présentes | **aucune** |
| distance minimale entre deux MCT | 1 case | **7 cases** (plateau officiel : 7) |

Les 4,6 % restants sont normaux et voulus : sur le plateau officiel aussi, deux
MCT distantes de 7 cases peuvent être couvertes par un mot de 8 lettres. C'est
simplement plus fréquent ici, avec 69 % de scrabbles.

### Le jeu est dominé par les scrabbles

```
sac classique 102 caramels   scrabbles 30,0 %   score moyen 75,8   rejets 26,4 %
table calibrée (dico 2-9)    scrabbles 52-69 %  score moyen 83,3   rejets 13,2 %
```

Décomposition : le Scrabble 15x15 classique tourne autour de 10-15 % de
scrabbles ; **la grille infinie double ce taux** (30 %, il y a toujours de la
place pour poser 7 caramels) ; **la table calibrée le redouble encore** (64 %).

C'est mécanique : une table calibrée sur la fréquence des lettres *dans les
mots* produit des tirages qui forment des mots. Le sac classique est
délibérément plus dur — trop de `U`, `V`, `H`, `F`, pas assez de `S`, `R`, `C`
par rapport à ce dont les mots ont besoin.

Conséquence sur le jeu : la prime de 50 points devient quasi constante et
l'exercice se réduit à placer son scrabble au mieux plutôt qu'à le trouver.

### Forme de la grille

Après 500 coups : emprise **113 × 135 cases**, 3 176 caramels, **densité 20,8 %**.
La grille pousse en tentacules, pas en tache : les mots partent en branches et
se recroisent peu. D'où la croissance linéaire des ancrages, au lieu d'une
croissance en périmètre qu'aurait donnée une forme compacte.

### Divers

- Score cumulé de la grille sur 500 coups : 41 647 (moyenne 83,3 par coup).
- Meilleur coup de la partie : `ENDEVIEZ` en `H 35,35`, 212 points.
- Taux de rejet des tirages : 13,2 %, très proche des 13,8 % prédits par la
  calibration hors moteur.
- La règle de rejet ne dit rien des **doublons** : elle laisse passer `AELRRRR`
  (quatre R) et `AAEEMOQ` (cinq voyelles et un Q). Un plafond de lettres
  identiques serait une ligne dans la politique de rejet.
- Feuille de route complète de la partie : `feuille-de-route.txt`, produite par
  `node packages/engine/tools/roadmap.ts 500 mondiale`.

---

## 16. Les parties paramétrables

Le topping infini est un cas particulier : grille sans bord, probabilités
pondérées, 7 lettres, pas de chrono, et le coup avance dès que le top est
trouvé. Tout cela devient réglable.

### La configuration voyage avec la grille

Elle n'est **pas** un réglage global. Un serveur héberge plusieurs salons à la
fois, et deux salons voisins peuvent jouer des variantes différentes — un
duplicate français 15×15 et une battle anglaise sur grille infinie. Une variable
de module les mélangerait.

Chaque `Board` porte donc sa `ConfigPartie`, et le score, le générateur et la
résolution d'un mot tapé la lisent là. Le fil de calcul d'un salon travaille sur
sa propre grille, donc sur sa propre configuration, sans rien partager.

> Le majorant d'élagage doit rester valide quelle que soit la table des primes,
> y compris réglée de travers — plus généreuse à deux caramels qu'à trois. Il
> majore donc par la **plus forte prime atteignable avec au plus n caramels**,
> jamais par la prime de n exactement.

### Créer un salon, puis le régler

**Créer un salon ne demande que son nom.** On obtient **toujours** une partie
normale : plateau du commerce **15×15**, sac de 102, 7 sur 7. C'est tout ce que
l'accueil demande — le **type de grille se choisit à l'intérieur**, comme le
reste.

> Un salon supprimé laisse sa partie sur le disque : on ne détruit jamais une
> partie jouée. L'identifiant d'un salon neuf évite donc les fichiers existants
> autant que les salons ouverts — sans quoi recréer un salon du même nom
> rouvrait l'ancienne partie, avec sa variante et ses coups.

**Tout le reste se règle à l'intérieur du salon**, par son propriétaire : la
grille (plateau 15×15 ou infinie), le nombre de caramels piochés et posables
(2 à 15, en petits boutons carrés), le temps par coup, le tirage des lettres,
la partie joker et les primes.

Changer de grille change aussi le pavage : le plateau du commerce n'a de sens
que borné, le pavage infini que sans bord. Appliquer relance une partie neuve dans le
salon — l'ancienne est archivée, jamais effacée.

Le **tirage des lettres** offre trois choix : probabilités pondérées, sac de 102
lettres, et sac de 102 sans fin. Le troisième est réservé aux grilles infinies :
sur un plateau fermé la partie s'arrête avant qu'il ait à se recharger.

### La grille 15×15

Le **plateau du commerce**, non pavé : ses quinze colonnes sont distinctes,
contrairement au pavage `classique` qui les répète avec une période de 14 en
faisant coïncider les bords. Les quatre coins sont des mots comptent triple,
le centre porte l'étoile.

Hors du plateau, on ne pose rien — mais le bord **reste une fin de mot valide** :
un mot a le droit de s'appuyer contre lui. Ce n'est pas la même chose qu'une
case occupée, et le générateur distingue les deux.

**Les règles ne signalent que la case de départ du mot**, jamais toute son
étendue : c'est elle que la notation nomme, et allumer tous les numéros que le
mot traverse les faisait empiéter les uns sur les autres. Sur la grille infinie,
l'espacement des numéros se calcule d'ailleurs sur leur **largeur** — « -1204 »
prend le double de place que « 4 ».

**Le curseur se pose sur la case de l'APPUI, pas sur celle du relâchement.**
Une souris qui frémit entre les deux ne doit pas décaler le repère d'une case.
Et sur un plateau fermé, où il n'y a rien à faire glisser, un léger mouvement
ne transforme jamais un clic en déplacement : le clic reste un clic.

**Une grille bornée ne se déplace pas et ne se zoome pas.** Le plateau tient
tout entier à l'écran, centré, avec ses règles fixes. Il n'y a rien à explorer :
pouvoir le déplacer n'apporterait que des réglages à refaire et des repères qui
bougent sous les yeux du joueur.

**L'affichage peint le pavage de LA PARTIE, pas le réglage global.** Sans quoi
un salon 15×15 montrait le pavage infini répété au-delà de ses bornes — la
partie était bien bornée, mais elle avait l'air infinie. Le damier s'arrête aux
bornes, le dehors prend un fond mat, et un trait franc marque le bord.

Les règles portent alors **les repères du jeu de société** : les lignes de A à O,
les colonnes de 1 à 15, chacune numérotée puisqu'elles ne sont que quinze.

### X sur Y

On pioche Y lettres, on en pose au plus X. La prime dépend du **nombre de
lettres posées**, pas du fait de vider le tirage.

| lettres posées | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|
| prime par défaut | 50 | 75 | 100 | 125 | 150 | 175 | 200 | 225 | 250 |

En dessous de 7 lettres, la prime par défaut est **nulle**. Le pas est de 25.
La prime s'ajoute **après** les multiplicateurs de mot, comme au jeu classique.

> ⚠️ **La limite vaut aussi à la saisie.** Le générateur la respectait depuis
> toujours, mais un mot tapé ne la vérifiait pas : en posant plus de caramels
> que permis, un joueur dépassait le score du top et remportait le coup sans
> l'avoir trouvé. Le refus rappelle la variante — « C'est une partie 5 sur 7 »
> — parce que le joueur ne sait pas forcément combien il a le droit d'en poser.

**7 sur 8** est le format classique : on pioche 8, on pose au plus 7, prime à 50.
**8 sur 8** autorise 8 lettres posées, donc un sextuple dès le premier coup ;
poser 8 vaut 75, poser 7 vaut toujours 50.

La fenêtre de paramétrage des primes permet d'attribuer **un nombre de points
libre à chaque nombre de lettres posées**. Sur une partie 3 sur 6 sans prime par
défaut, on peut décider que poser 2 lettres vaut 15 et poser 3 lettres vaut 25.

### La partie joker

Le tirage contient **toujours un joker** : à 7 lettres, c'est 6 vraies lettres
plus le joker.

Quand le top emploie le joker comme un R, il compte **0 point** — mais ce qui se
pose sur la grille est un **vrai R sorti du sac**, et le joker reste au tirage.
Le R posé est un R ordinaire : il **vaut 1 point pour tous les coups suivants**.
C'est tout l'intérêt de la variante, la grille ne se couvre pas de cases mortes.

S'il ne reste **aucun R dans le sac**, le joker lui-même se pose (à zéro, pour
toujours) et on prend le **second joker**. Les deux jokers posés, la partie
continue sans.

**La variante s'accommode des trois pioches**, chacune à sa façon :

| pioche | ce qui se passe quand le joker est joué |
|---|---|
| sac de 102 | une vraie lettre en sort et se pose ; le joker revient au tirage. Faute de lettre, le joker se pose et la réserve — **deux** — perd une unité |
| sac de 102 sans fin | pareil, mais les jokers **ne s'épuisent jamais** : on en reprend un |
| probabilités pondérées | **rien ne remplace** le joker : il se pose à zéro et on en reprend un aussitôt. Rien ne s'épuisant, « il ne reste plus de R » n'aurait aucun sens |

Mesuré sur 25 coups : aux probabilités, le tirage porte un joker à chaque coup
et 28 se posent à zéro ; au sac sans fin, 5 seulement — les autres sont
remplacés par de vraies lettres ; au sac de 102, les deux jokers s'épuisent et
la partie continue sans.

> ⚠️ **Règle d'isotop propre à cette variante.** Entre deux coups de même score
> dont l'un emploie le joker et l'autre non, on retient **systématiquement celui
> qui ne l'emploie pas**. Ce n'est plus un départage arbitraire : garder le
> joker a des conséquences sur toute la suite.
>
> Le solveur ignore ce qu'il reste dans le sac — il ne peut donc pas savoir si
> l'emploi du joker le **consommera** vraiment. Il préfère donc, plus largement,
> les isotops qui ne l'emploient pas du tout : jamais pire, et cela couvre le
> cas visé. Les isotops employant le joker restent listés, ils sont simplement
> moins bons à jouer.

### La règle de rejet s'adapte au tirage

Telle qu'elle est écrite — au moins 2 voyelles **et** 2 consonnes — la règle est
**insatisfiable en dessous de quatre caramels** : un tirage de deux ne peut pas
contenir quatre lettres, et la pioche boucle sans fin.

La convention retenue : **2 voyelles et 2 consonnes à partir de 7 caramels, une
seule de chaque en dessous.** Rien ne change pour le tirage classique.

**Sur un sac qui s'épuise, la règle se relâche à partir du coup 16** : les quinze
premiers tirages exigent 2 et 2, ensuite une seule voyelle et une seule consonne
suffisent, mais il en faut toujours au moins une de chaque.

Le relâchement existe pour **une seule raison** : en fin de sac fini, il ne reste
plus assez de chaque sorte pour composer un tirage acceptable, et la partie
serait injouable avant sa fin conventionnelle.

**Il ne vaut donc que là.** Un sac **qui se recharge** se remet à neuf dès qu'il
devient pauvre d'un côté, et des **probabilités pondérées** ne s'épuisent jamais.
Sur ces deux pioches, la règle stricte vaut **du premier coup au dernier**.

C'est le défaut qui laissait passer, au coup 37 d'une grille infinie tirée d'un
sac bouclant, un tirage à **une seule voyelle** : le relâchement s'y appliquait
alors que rien ne s'y épuisait.

### Le Y devient obligatoire quand il tient seul un rôle

S'il ne reste **plus de voyelle en dehors du Y**, aucun tirage ne peut en
contenir une : exiger une voyelle serait exiger l'impossible. Mais le Y en tient
lieu, et la partie n'est pas finie tant qu'il est là — alors **on le tire**, pour
qu'il soit joué et que la partie s'achève pour de bon. Symétriquement quand il
est la dernière consonne.

**Le Y bascule des deux côtés**, dans la règle de tirage comme dans la
convention d'arrêt. Il ne tenait ce rôle que d'un seul : un reste de voyelles et
d'un Y finissait la partie, quand le même reste en consonnes la poursuivait — et
la pioche cherchait alors sans fin un tirage qui n'existait pas, avant de lever
une erreur qui emportait le serveur.

C'est ce qui réconcilie les deux règles. À défaut, après cinq cents tentatives,
la pioche prend ce qu'il y a : une préférence qu'on ne peut pas satisfaire n'est
plus une préférence.

### Un tirage dont rien ne se joue est refait

Il arrive qu'aucun coup ne soit possible avec le tirage servi — grille très
fermée, malchance rare. Le tirage est alors **rendu au sac**, reliquat compris,
et refait. Rendre est le point important : les lettres abandonnées restaient
dehors, et un sac de 102 n'en comptait plus que 99.

Au bout d'un certain nombre de tirages de suite **sans un seul coup jouable**, la
partie est **terminée**. Ce n'est plus de la malchance : le sac ne contient plus
de quoi jouer. Le compte est borné parce que la reprise était récursive et sans
fin — un serveur tournait jusqu'à épuiser sa pile.

Le nombre suit **le prix d'un essai**, qui n'est pas le même des deux côtés :

| grille | essais | prix d'un essai |
|---|---|---|
| **15×15** | 40 | quelques millisecondes |
| **infinie** | 8 | jusqu'à une seconde sur une grille de trois mille coups |

On peut se montrer large là où c'est gratuit, et rester sobre là où chaque essai
se paie.

### Le Y tout seul

Cent une lettres sur la grille, le Y en main ou dans le sac : **la partie
s'arrête**. Il ne fait pas un mot à lui seul, et il n'a plus rien à quoi
s'accrocher. C'est le seul cas où le Y ne prolonge pas la partie.

### Les lettres restantes s'affichent

Sur une pioche à sac fini, ce qui reste est **public** — au duplicate on suit
les lettres restantes pour anticiper les tirages. Elles occupent une **ligne
mince au-dessus des numéros de colonnes**, entre la barre du coup et la grille :
autour du plateau, jamais par-dessus.

Rien que les lettres, sans compte ni décoration, et **les jokers à la fin** :
ce ne sont pas des lettres, les voir en tête brouille la lecture.

### Ce qui se passe quand la partie s'arrête

Le tirage **disparaît**. Les caramels qui restent dans le sac ne sont pas
piochés, le chrono de la grille se fige sur le dernier coup, il n'y a plus de
chrono de coup en cours, et un bandeau dit « Partie terminée ». Rien ne se tape
plus.

> Laisser le tirage en place après le dernier coup permettait de taper des mots
> sur une partie close, sans que rien n'indique qu'elle était finie.

Rien ne s'affiche sur les probabilités pondérées : elles ne s'épuisent pas, il
n'y a pas de reste à montrer.

### Essayer une variante en ligne de commande

En attendant l'interface, une variante se lance directement :

```
npm run serve -- --partie essai --tirage 8 --jouables 8 --sac102
```

Une partie déjà commencée **garde sa variante** : elle est écrite dans l'en-tête
de son journal et relue au démarrage. Vouloir la changer en cours de route est
refusé, avec le message qui dit quoi faire — changer de variante fausserait tous
les scores déjà joués.

### Le sac qui se recharge

Troisième pioche. On tire au hasard parmi les 102 caramels, et dès qu'il ne
reste plus que **2 voyelles ou 2 consonnes dans le sac et les reliquats
réunis**, le sac est **complété** pour que l'invariant tienne :

> **sac + reliquat = la distribution de départ.**

Complété, pas remis à neuf : un W gardé en main est un W qui ne revient **pas**
dans le sac. Le remettre en ferait exister deux, alors que le jeu n'en a qu'un.
Vérifié sur 600 tirages en conservant les lettres chères — jamais deux W, et le
total ne dépasse jamais 102.

> La règle ne vaut que pour les **pioches à sac**. Les probabilités pondérées,
> elles, n'ont pas de stock : deux W dans un même tirage y sont possibles, et
> c'est normal. Mesuré : 1 tirage sur 400 000 à sept caramels, 1 sur 67 000 à
> quinze. Rare, pas interdit.

Elle donne une grille infinie avec la distribution du jeu classique, au lieu des
probabilités pondérées. Une partie ainsi tirée **ne se termine jamais** : il n'y
a plus rien qui s'épuise.

> Le seuil est celui de la fin de partie, mais l'effet est inverse : au lieu de
> s'arrêter, la partie recharge et continue. Mesuré : un rechargement tous les
> vingt coups environ.

**Un tirage incomplet est interdit.** On joue sept sur sept : c'est sept
caramels en main, pas « ce qu'il reste ». Le rechargement ne regardait que
l'équilibre voyelles / consonnes, si bien qu'un fond de sac de **six lettres
bien réparties** passait le contrôle — et servait un chevalet de six. Vu en
partie sur la grille permanente. Le sac se recharge donc aussi **dès que le sac
et le reliquat réunis ne suffisent plus à remplir un chevalet**.

### Un salon vide dort

Une partie ne pioche et ne chronomètre que **s'il y a quelqu'un**.

- Au démarrage du serveur, les salons rejouent leur historique mais **ne
  calculent rien** : le top du coup courant n'est cherché qu'à l'arrivée du
  premier joueur. Sinon chaque salon enregistré coûtait un calcul complet, y
  compris ceux que personne n'ouvrira.
- Le dernier joueur parti, **le chrono s'arrête** et le coup en cours gèle. Un
  salon vide dévorait sinon un coup toutes les N secondes, pour personne — des
  minutes de calcul chacun sur une grande grille.
- Celui qui arrive reçoit le **temps plein** : reprendre un décompte entamé
  pendant que la salle était vide n'aurait aucun sens.

Le coup en cours affiche « en pause » tant que la salle est vide.

**La grille permanente, elle, ne dort pas.** Elle n'appartient à personne et son
temps **se compte** : un coup y dure ce qu'il dure, la nuit comprise, même quand
plus personne ne regarde. C'est une grille universelle à effort commun — « ce
coup a résisté trois jours » n'aurait aucun sens si l'horloge s'arrêtait dès que
la salle se vide, et c'est pourtant ce que sa sonnerie annonce.

Elle n'a pas de chrono : ne pas l'endormir ne dévore donc aucun coup. Un salon
ordinaire s'endort, lui, pour cette raison exacte.

> Reste un cas : le **redémarrage du serveur**. Le top du coup courant n'est pas
> conservé, il faut le recalculer, et l'horloge du coup repart de zéro. Le
> tirage, lui, est identique — la graine le rejoue. C'est la seule remise à zéro
> qui subsiste.

### La sonnerie dit depuis combien de temps le coup résistait

Sur la grille permanente, **un coup peut durer des heures** — ou des jours.
Personne ne reste devant : on la laisse ouverte dans un onglet et on fait autre
chose. Quand le coup finit par tomber, le son dit **combien de temps il a
résisté**. C'est la seule chose qu'on veut savoir de loin, et un signal unique ne
la disait pas.

| le coup a duré | ce qu'on entend |
|---|---|
| **5 min** | deux notes graves qui descendent, filtrées — on signale, on ne félicite pas |
| **10 min** | deux notes, mais ça monte, et un harmonique passe |
| **15 min** | un accord parfait égrené : trois notes suffisent à faire une phrase gaie |
| **30 min** | la même montée, poussée jusqu'à l'octave, sommet tenu |
| **1 jour** | une petite fanfare : levée, montée, accord tenu |
| **10 jours** | un petit orchestre — quatre accords, une basse qui marche dessous, une volée pour finir |

En dessous de cinq minutes, **rien**. La partie se suit à l'œil, et une sonnerie
toutes les deux minutes serait une nuisance, pas un service.

**Celui qui trouve l'entend aussi.** Il sait déjà ce qu'il a fait — mais un
signal qui vous félicite fait plaisir, et se le refuser n'économise rien.

Tout est **synthétisé sur place**, sans fichier à charger. Un filtre passe-bas
commun à toutes les voix fait la différence entre le sourd et l'éclatant, bien
plus que la hauteur des notes ; chaque note monte en vingt millisecondes et
s'éteint en courbe, car une attaque franche fait sursauter.

### Le coût du calcul, mesuré

Le temps de recherche du top croît avec le **nombre d'ancrages** — donc sans fin
sur une grille infinie — **et** avec la **taille du tirage**, qui multiplie les
combinaisons. Chaque joker multiplie encore par vingt-six.

Les deux ensemble sont explosifs. Mesuré sur une grille infinie en 15 sur 15,
à **40 coups seulement** (710 ancrages) :

| tirage | temps |
|---|---|
| sans joker | 7,4 s |
| un joker | 57 s |
| deux jokers | **171 s** |

La mémoire reste à 115 Mo : ce n'est pas un problème de place, c'est du calcul.

La même variante sur un **plateau 15×15 borné** joue la partie **entière en une
seconde**, pire coup 0,47 s — parce que la grille cesse de grandir et plafonne
à une centaine d'ancrages.

> ⚠️ Un gros tirage sur une grille sans bord est la combinaison à éviter. Les
> réglages du salon l'annoncent avec ces chiffres quand on la choisit.

À 7 caramels, la grille infinie reste confortable : 50 à 115 ms par coup jusqu'à
200 coups, pire cas observé 2,5 s sur un tirage à joker.

### Le chrono

**Super blitz 30 s · blitz 60 s · semi-rapide 2 min**, plus une option
**personnalisé** en secondes et **sans chrono** : il faut alors trouver le top
pour avancer, comme sur le topping infini.

Le temps restant s'affiche en **compte à rebours**, et passe en couleur d'alerte
dans les six dernières secondes.

> Un coup posé par l'échéance part aux clients **comme n'importe quel autre**.
> Diffuser depuis le point d'entrée du message laissait les coups du chrono
> invisibles : la grille avançait sans que personne ne reçoive les caramels.

### Ce qui se passe à l'échéance

Deux régimes, et ils ne se ressemblent pas.

**En duplicate**, on attend **toujours** la fin du temps avant d'afficher le top,
même si quelqu'un l'a trouvé plus tôt. Chaque joueur marque **le score de sa
meilleure solution**, et son écart au top est son **négatif**. Le score de chaque
joueur est noté **à chaque coup**.

**Construit.** Le mode se choisit dans les réglages du salon. Un duplicate exige
un chrono — c'est l'échéance qui clôt le coup, pas la découverte du top ; sans
chrono, on en impose un de 60 s.

Rien ne filtre pendant le coup : aucune annonce, aucun décompte de trouveurs.
La réponse faite à celui qui vient de soumettre ne dit **jamais** s'il a trouvé
le top — le lui dire le lui apprendrait, et l'apprendrait aux autres par
ricochet. Il reçoit son score, et la meilleure de ses propres solutions.

Seuls sont notés les joueurs **présents au moment du tirage**. Qui arrive en
cours de coup joue et figure dans la liste des trouveurs s'il trouve, mais
n'entre au classement qu'au coup suivant.
Savoir que le top est atteint apprendrait aux autres que leur solution ne l'est
pas. À l'échéance, **la liste de ceux qui ont trouvé le top s'affiche dans le
chat**, et on enchaîne aussitôt — pas de temps mort entre l'affichage et le coup
suivant. Le message ne porte **pas les points** : ils figurent déjà au tableau,
au journal des coups et sur la grille.

```
Coup 12 : trouvé par alice, bob
Coup 13 : non trouvé
```

**Le nombre de coups se règle** quand le mode est duplicate — 10, 20, 30, une
valeur libre, ou sans fin. Une grille infinie ne s'épuise jamais : sans cette
borne, un duplicate n'y aurait pas de terme, donc pas de classement final. Le
compteur affiche alors `7 / 20`.

Le classement se fait sur le **total de points**, avec une colonne **négatif
total**. Un joueur dont le négatif est nul s'affiche **TOP**.

**En topping collaboratif / battle**, le premier qui trouve le top le fait
afficher immédiatement et marque **1 point**, comme sur le topping infini. Si
personne ne le trouve avant l'échéance, le top s'affiche quand même, et le
joueur qui a soumis **la solution la plus rentable, le plus vite**, marque
**un demi-point**.

Ce coup n'a pas été trouvé : il s'affiche **« non trouvé »**, jamais « révélé ».
Dans la liste dépliée du gagnant du demi-point, c'est **son mot** qui figure,
suivi de **(0.5)** : c'était sa meilleure solution, pas le top.

**Un top que personne n'a trouvé se voit.** Il ne se lisait que dans la ligne
sous le mot, en petit, entre la notation et le chrono — au milieu de ce qui ne
change pas d'un coup à l'autre. Or c'est la seule chose que la table veut
savoir : la grille vient de gagner un coup. C'est aussi ce qui décide une
tablée à recommencer la partie, ce qu'on ne fait jamais à sa place.

Le mot reste lisible — c'est lui qu'on veut voir — mais il porte un jeton
**NON TROUVÉ** et ses points passent au rouge. Cela suffit : un bandeau flottant
qui répétait la même chose une seconde plus bas n'apprenait rien, et masquait le
bas de la grille au moment où l'on y cherche le mot.

**Ce que personne n'a trouvé concourt avec les joueurs.** La ligne « Non
trouvé » — au pluriel dès deux — était épinglée en tête du tableau, hors
classement, quel que soit son compte : on ne voyait plus si la grille menait
devant la table ou derrière elle. Elle se range maintenant à sa place, en
points, comme un joueur.

**Un demi-point ne rachète pas le coup.** Le top a échappé à tout le monde : le
coup reste entièrement perdu et compte pour un plein point à « Non trouvés »,
tandis que le joueur qui s'en est le plus approché reçoit son demi-point à côté.
Un coup à demi-point distribue donc **1,5** — un point à la grille, un demi au
joueur — et c'est voulu : ce sont deux comptes distincts, pas un partage.

### Le décompte de départ

Option, décochée par défaut : **3, 2, 1** en grand sur la grille, **une seule
fois, avant le premier coup**. C'est un signal de départ, pas une pause avant
chaque coup. Le chrono ne part qu'après — personne ne perd de temps sur le
décompte, et la saisie est gelée pendant.

Il se lit **d'un bout à l'autre de la pièce** : caractères droits, sans
empattements, et un **cerne noir** qui les détache de ce qu'il y a dessous —
sans lui, un 3 vert posé sur une case verte disparaît à moitié. Le trait se
peint **derrière** la lettre, pour la border sans la manger.

**Le tirage n'est pas envoyé pendant le décompte.** « 3, 2, 1 » est un départ, et
partir en ayant déjà lu ses lettres n'en est pas un. Le cacher à l'écran ne
suffirait pas : il serait lisible dans la console.

Le décompte part donc **du premier tirage servi**, pas de l'armement du chrono.
La nuance n'est pas que d'écriture : demander à chaque coup « faut-il
décompter ? » pour répondre non quatre-vingt-dix-neuf fois sur cent revient à
traiter comme une condition permanente une chose qui n'arrive qu'au début.

### Créer un salon, y entrer, le régler

**Le bouton crée le salon et y entre**, sans rien demander. Le nom est tiré au
hasard — deux mots accolés, « Caramel calme », « Tirage franc », tirés du
vocabulaire de la farfouille — assez pour
distinguer les salons et plus mémorable qu'un numéro. On le renommera plus tard.

**Un salon neuf n'a pas de partie en cours** : ni tirage, ni chrono, ni coup.
Il s'ouvre sur ses réglages, et la partie commence quand son propriétaire les
valide. Entrer quelque part ne doit pas lancer une partie qu'on n'a pas choisie.

Une partie qui a déjà des coups derrière elle a évidemment commencé : on ne
redemande pas ses réglages à qui la reprend. La grille permanente, elle, démarre
d'office — elle est le jeu par défaut du site.

### Le temps d'un coup clos par l'échéance

`setTimeout` promet de ne pas se déclencher **avant** le délai, jamais de se
déclencher **dessus** : la boucle d'événements finit ce qu'elle faisait avant de
rendre la main. Mesurer l'écart réel donnait donc 5,00 s le plus souvent, mais
5,01 s quand le réveil avait tardé.

On note donc le **temps imparti**, qui est la vérité du coup : cinq secondes
tout rond. Et un compte rond s'écrit rond — « 5 s », pas « 5.00 s ».

### En réserve : entrer directement dans la partie

**À ne pas construire maintenant.** Un lien qui mène **droit à la grille
infinie** et demande l'inscription sur place, sans passer par l'accueil : le
joueur joue d'abord, découvre les salons ensuite.

### En réserve : les records du site

**À ne pas construire maintenant.** Noté pour ne pas être oublié.

Une **partie topée** est une partie dont *tous* les coups ont été trouvés par des
joueurs. On voudra classer :

- les parties normales (7 sur 7) topées **le plus vite** — et les dix premières ;
- la partie topée avec le **moins de secondes par coup**, annoncée comme
  « partie topée en 5 secondes par coup par xxx, xxx, xxx ».

### Changer de salon efface tout

Entrer dans un salon **vide d'abord l'état du précédent** : caramels, historique,
chat, curseur, classement, tirage, compteurs. Sans cela la grille de l'ancien
salon restait affichée jusqu'à l'arrivée de `hello` — on y voyait ses mots,
parfois **hors des bornes** du nouveau plateau, comme si des coups avaient déjà
été joués.

**La table rase doit se voir, pas seulement se faire.** Remettre les variables à
zéro ne suffit pas : l'écran garde ce qu'on y a peint jusqu'au prochain
rafraîchissement. Le ménage repeint donc aussi.

Et il se fait **avant le premier `await`**, pas après. Entre découvrir la grille
et se débrancher de l'ancien salon, il s'écoule le temps de fermer une liaison —
et c'est précisément pendant ce temps-là qu'on voyait le tirage d'à côté. Seul le
plateau attend, parce qu'il lui faut le dictionnaire.

Le **cadrage** se refait quand la configuration arrive, pas avant : c'est elle
qui dit si la grille est bornée. Le calculer trop tôt le faisait avec la
variante du salon quitté.

### Les temps

Le chrono qui défile s'affiche en **secondes entières** : les dixièmes qui
tournent sont une source d'angoisse, pas d'information. Le temps **enregistré**
d'un coup trouvé, lui, se note au **centième** — une performance se mesure.

Cela vaut pour **les deux compteurs du bandeau**, « Temps » et « Coup en cours ».
Sur une grille sans chrono, ils affichaient des centièmes : deux chiffres qui
défilent trop vite pour être lus, et qui font clignoter toute la ligne. La partie
enregistre toujours les centièmes ; c'est l'affichage qui les laisse.

### Le temps d'une partie est la somme de ses coups

**« Temps » n'est pas l'horloge du mur.** Entre deux coups, le serveur cherche le
top — une seconde et demie sur une grande grille. Ce temps-là n'appartient à
personne : ni au coup qui vient de tomber, ni à celui qui n'a pas encore
commencé. Le compteur **se fige** pendant le calcul et reprend quand le coup part.

> À terme, le serveur calculera plusieurs coups à l'avance sur la grille
> permanente : le top s'affichera en même temps que le tirage suivant, dont le
> top sera déjà connu, et il n'y aura plus de latence à figer.

Ce qui se lit tombe alors juste, et c'est tout l'intérêt :

> **Temps = cumul des coups joués + coup en cours.**

Le compteur se fige aussi quand la partie n'a pas commencé, pendant le décompte
de départ, et dans un salon endormi — personne n'y cherche, et le chrono repart
à plein au premier arrivant : le total reculerait.

Le champ s'appelait « Grille » et donnait l'âge du salon, ce qui n'est pas la
même chose et ne s'additionnait à rien.

### Rejouer une partie terminée

Le bouton **Rejouer** n'apparaît **qu'une fois la partie close** — avant, ce
serait donner les réponses d'une partie en cours. Le serveur refuse d'ailleurs
les paliers d'une partie qui se joue, quoi que demande le client.

**Sauf sur une grille qu'on étudie.** Une grille infinie n'a pas de fin : ses
isotops et ses sous-tops resteraient à jamais invisibles, alors que c'est
justement ce qu'on veut regarder pour connaître les limites du jeu. `--rejeu`
nomme les parties qui ouvrent leur rejeu sans attendre — `top-leger` par défaut,
`--rejeu ""` referme tout.

L'ouverture ne porte que sur les **coups déjà joués**, où le top est de toute
façon public. Le serveur refuse tout numéro au-delà du journal, avec un message
qui le dit : le coup en cours est celui que tout le monde cherche, et rien ne
doit en sortir. Vérifié en interrogeant le protocole directement — le coup 2
rend ses 22 paliers, le coup 19 en cours rend `null`.

Le rejeu remonte la partie coup par coup. Pour chaque coup il montre le tirage,
le mot posé et qui l'a trouvé, puis **les paliers** : le top et ses isotops
d'abord, les sous-tops ensuite — **toutes les solutions** sur un plateau borné,
les mieux classées sur une grille infinie. Le coup réellement joué y est
surligné.

### Chercher un mot sur toute la grille

Sur une grille infinie, seuls les **cent premiers paliers** sont enregistrés :
l'immense majorité des coups jouables n'existe nulle part. Chercher `MA` dans la
liste ne rendait donc rien — alors qu'il se posait à cinq cent soixante-neuf
endroits.

**Le champ fait deux choses, et c'est ce qui le rend utile.** En tapant, il
filtre instantanément les paliers déjà là. Sur **Entrée**, il va chercher le mot
partout ailleurs. Rien ne part tant qu'on tape : un balayage par frappe ferait
cinq recherches pour un mot de cinq lettres, dont quatre sur des mots incomplets.

**Chercher un mot donné n'est pas le même problème que trouver tous les coups.**
Le solveur explore le dictionnaire depuis chaque ancrage avec toutes les
combinaisons du tirage ; ici le mot est connu, et il ne reste qu'à essayer, pour
chaque ancrage et chaque décalage, s'il tient. On ne touche plus au GADDAG.

Mesuré sur la grille permanente réelle — 11 647 coups, 66 800 caramels, 71 411
ancrages :

| | |
|---|---|
| génération complète des 960 816 coups | 8,3 s |
| le calcul que fait le serveur à chaque coup | 1,6 s |
| **balayage d'un mot** | **0,15 à 0,5 s** |
| reconstruire la position d'un coup passé | 187 ms |

Le coût monte avec la **longueur du mot** — L décalages par ancrage — pas avec le
nombre de résultats.

**Le balayage tourne dans le navigateur.** Le client a déjà la grille et le
DAWG : le contrôle des mots croisés n'a besoin que du DAWG, pas du GADDAG. Aucun
aller-retour, et surtout aucune concurrence avec le solveur — qui, sur la grille
permanente, met 1,6 s à calculer un coup dont le chrono dure une seconde.

Quatre règles :

- la recherche ne porte que sur un **coup déjà joué**. Le rejeu ne s'ouvre pas
  ailleurs, et le plateau reconstruit s'arrête au coup d'avant : le top du coup
  en cours reste hors d'atteinte, comme il doit l'être ;
- un mot **absent du dictionnaire** est refusé tout de suite, sans balayer
  soixante-dix mille ancrages pour rien ;
- on n'affiche que les **cent meilleurs** placements, avec le compte complet à
  côté : « 100 sur 9 074 » ;
- avec un **joker**, un même mot au même endroit vaut plusieurs scores selon la
  lettre qu'il porte. On prend le meilleur, comme le solveur : le joker va sur la
  case qui rapporte le moins.

Le balayage ne vaut que s'il rend **exactement** ce que le solveur aurait rendu.
C'est ce qu'un test établit : on génère tous les coups d'une position, et pour
vingt mots on vérifie que le balayage retrouve les mêmes placements aux mêmes
scores, ni un de plus ni un de moins — sur un plateau borné comme sur une grille
infinie.

**Une ligne par solution, jamais deux.** La colonne de place faisait
soixante-deux pixels ; `V -91,-196` en demande soixante-trois, et la notation
passait à la ligne au beau milieu de la liste. Aucune cellule ne se replie, et la
colonne tient maintenant des coordonnées à quatre chiffres.

Chaque ligne porte son **écart au top** : `MUCRONE 74 −2` quand le top fait 76.
C'est l'écart qui dit ce qu'a coûté une solution, pas son score nu. Le top et
ses isotops portent `top` plutôt que `0`.

Un **champ de recherche**, à droite du tirage, filtre sur les lettres du mot et
affiche « 43 sur 100 ». C'est ce qui rend une liste de plusieurs milliers de
lignes utilisable.

Seules les lignes **visibles** sont posées dans la page. Les poser toutes coûtait
2,4 secondes de mise en page pour un coup à 18 655 solutions — l'essentiel pour
des lignes que personne ne regarde.

Le **bandeau du haut reprend le tirage du coup examiné**, en caramels, comme
pendant la partie : on revoit un coup avec ce qu'on avait en main pour le
chercher.

Le mot montré sur la grille a ses **propres couleurs** — un vert clair, encre
foncée. Il empruntait celles de l'accent : terne en clair, et en sombre un fond
`#11301F` sous une encre `#1C221F`, deux noirs l'un sur l'autre.

La grille se **rembobine** : on ne voit que les caramels posés *avant* le coup
examiné, c'est-à-dire ce que voyaient les joueurs au moment de chercher. Un clic
sur une solution la montre sur la grille.

À l'ouverture d'un coup, le tableau du bas montre **tous ceux qui comptaient sur
ce coup** — y compris ceux qui n'ont rien rendu, qui y valent zéro. Les réduire
aux trouveurs du top faisait disparaître ceux qui ne l'avaient pas trouvé,
c'est-à-dire justement ceux qu'on vient regarder. Cliquer une solution montre
alors qui a joué *ce mot-là*.

Au clavier : **↑ et ↓** parcourent les solutions, **← et →** passent d'un coup à
l'autre. Les deux premières marchent aussi depuis le champ de recherche ; ← et →
y restent au curseur, sinon on ne pourrait plus se corriger.

Pendant le rejeu, **le journal des coups joués disparaît** — il montre l'état
final de la partie, si bien qu'y cliquer depuis le coup 1 posait un mot du coup
40 au milieu de nulle part. Le chat, lui, se replie sans disparaître.

Le rejeu **se ferme tout seul** quand la partie qu'il regarde n'existe plus :
relance du salon, ou départ vers un autre salon.

### Les paramètres du joueur

Une roue crantée au bout du bandeau, **à ne pas confondre avec les réglages du
salon**. Les réglages décident de la partie et valent pour tout le monde ; les
paramètres ne regardent que celui qui est devant l'écran, et rien n'en sort de
son navigateur.

| | |
|---|---|
| **Thème** | automatique, clair, sombre. « Automatique » ne pose aucun attribut : la feuille de style suit le navigateur, et **suivra ses changements** — de quoi passer au sombre à la tombée du jour sans rien rouvrir. |
| **Sons** | activés ou muets, avec **un bouton par palier pour les écouter**. Décrire une sonnerie ne dit rien de ce qu'elle fait dans une pièce : on juge sur pièce, et on règle son volume avant que le coup ne tombe. |
| **Réduire les mouvements de caméra** | un interrupteur, pas deux boutons : la question appelle oui ou non, et le voyant dit lequel sans qu'on ait à lire deux étiquettes pour comparer. Cliquer un coup passé y amène la caméra ; réduits, elle s'y **pose** au lieu d'y voler — sur une grande grille, le trajet traverse des milliers de cases. Le navigateur sait déjà que son propriétaire n'aime pas ce qui bouge : `prefers-reduced-motion` donne la valeur de départ. |

Les valeurs tiennent dans le rangement local du navigateur. Il peut manquer —
navigation privée, site bloqué, un navigateur qui jette tout en fermant : ce
n'est pas une panne, on repart des valeurs par défaut et le jeu tourne pareil.

Le mode sombre choisi et le mode sombre demandé par le navigateur portent les
**mêmes valeurs, écrites deux fois** dans la feuille de style. On aimerait n'en
écrire qu'une avec `light-dark()`, mais la grille lit ces variables au pinceau,
par `getComputedStyle`, et une couleur laissée à calculer lui reviendrait sous
forme de texte qu'elle ne saurait pas peindre.

### Les salons

**Le salon est un lieu, la partie est ce qui tourne dedans.** C'est la
distinction qui porte tout le reste.

| | ce qu'il détient |
|---|---|
| **Salon** | identifiant, membres, propriétaire, chat, configuration courante |
| **Partie** | grille, sac, graine, journal, scores |

Une partie qui se termine — ou un propriétaire qui change les réglages — en
lance une nouvelle **dans le même salon**. Les gens et le chat restent, la partie
change : on passe du duplicate à la battle sans que personne se redonne
rendez-vous. Le paramétrage se fait **depuis l'intérieur** du salon.

**Le propriétaire est celui qui a créé le salon — le gérant est celui qui en
tient les manettes.** Les deux se confondent tant que le créateur est là.

Un salon sans personne pour le régler est un salon mort : le créateur ferme sa
page, et plus personne ne peut relancer une partie ni changer la variante. Il ne
reste qu'à refaire un salon ailleurs. Les manettes suivent donc les présents,
selon deux règles qui ne se contredisent pas :

- **le créateur les reprend dès qu'il revient.** Le salon est le sien, et son
  départ n'est le plus souvent qu'un rechargement de page ;
- **en son absence, elles vont à quelqu'un au hasard** parmi les présents, et y
  restent tant que cette personne est là.

Le tirage au sort vaut mieux que l'ancienneté : personne n'a à comprendre
pourquoi c'est tombé sur lui, et il n'y a pas de file d'attente à expliquer.

Le passage **s'annonce au chat** — « Ana règle le salon en l'absence de Zulu » —
car des manettes qu'on reçoit sans le savoir ne servent à rien. Le retour du
créateur, lui, ne s'annonce pas : son bouton reparaît, il n'a rien à apprendre.

**Supprimer le salon reste au créateur seul.** Régler, c'est relancer une partie
dans le même lieu ; supprimer, c'est jeter ce lieu et ce qui s'y est joué. On ne
confie pas la seconde à qui passe.

**Un salon peut être permanent sans appartenir à personne.** Un salon ordinaire
appartient à qui l'a créé et disparaît avec lui ; une **grille d'étude** porte
des milliers de coups joués à plusieurs pendant des semaines, et ne doit pas
tenir à un clic — pas même celui de son propriétaire, qui continue par ailleurs
à la régler. `--permanentes` les nomme, `--permanentes ""` les rend supprimables.

Le bouton **Supprimer** disparaît, et la ligne du salon porte « permanente » :
sans quoi rien n'expliquerait l'absence du bouton, et l'on croirait à un oubli.

**La grille mondiale est un salon comme un autre** : permanent, public, sans
chrono. Elle n'a pas de propriétaire et sa configuration est **verrouillée** —
aucun visiteur ne doit pouvoir la reparamétrer ou la relancer.

Elle figure **toujours en tête** de la liste des salons. C'est le jeu par défaut
du site ; la laisser prendre son rang parmi les salons du moment lui donnait une
place qui changeait avec eux.

### Ce qu'on garde, et ce qu'on jette

C'est le seul endroit du programme qui **efface volontairement** une partie.
La règle tient en une phrase : **une 15×15 terminée survit à son salon, rien
d'autre.**

| partie | à la fermeture du salon |
|---|---|
| **15×15 terminée** | **conservée** — quelques dizaines de Ko, elle se rejoue entièrement |
| 15×15 abandonnée | effacée — elle ne se rejoue pas et n'intéresse personne |
| grille infinie | effacée — elle n'a pas de fin, et l'une d'elles pesait 9,4 Mo à elle seule |

Chaque effacement est **annoncé au journal du serveur**, avec le nom du salon et
le nombre de coups perdus.

**Un salon 15×15 vide se referme tout seul.** Une partie bornée tient dans une
séance ; personne n'y revient le lendemain, et la laisser au registre encombre
la liste et garde un fil de calcul pour rien. Pas sur-le-champ, cependant :
recharger sa page, c'est se déconnecter une demi-seconde. On attend **quatre-
vingt-dix secondes**, puis on vérifie à nouveau que la salle est vide.

La règle vaut au départ du dernier joueur, **et au démarrage du serveur** : les
salons bornés relus du registre n'ont, eux, jamais eu de départ à observer, et
la séance d'hier laissait sa liste de salles mortes à celle d'aujourd'hui.

La grille permanente ne se referme jamais, et les salons sur grille infinie
restent tant qu'on ne les supprime pas à la main.

### Prendre la grille en image

Un bouton dans le bandeau enregistre la grille en **PNG**. On ne photographie
pas l'écran : la partie est **redessinée à une autre échelle** dans un canevas
hors écran, assez grand pour contenir toute l'emprise des caramels. C'est le
même code de dessin, donc l'image montre exactement ce que montre le jeu — y
compris **le mot du rejeu masqué par l'œil**, ce qui donne une position à
chercher.

L'échelle s'ajuste : jusqu'à 48 pixels par case pour une petite grille, au
minimum 6 pour une grande, sous un plafond de 36 mégapixels. Mesuré sur une
partie de 4 452 coups : **5 916 × 5 903 pixels, 3,6 Mo, en 2,4 secondes**.

L'image porte **le tirage en tête**, en caramels, dans l'ordre alphabétique et
les jokers à la fin, avec le numéro du coup — de quoi rejouer le coup comme si
on y était. Les **numéros de colonnes** restent visibles sous ce bandeau : la
grille est dessinée sur son propre canevas et posée dessous, sinon le bandeau
les aurait recouverts, et on ne pourrait plus nommer la case où l'on joue.

**La marge fait la longueur d'un mot entier**, plus une case d'air. C'est ce qui
rend l'image jouable : un coup peut partir de sept cases au-dessus du dernier
caramel posé et redescendre le toucher. Une marge de deux cases coupait ces
coups-là de l'image, et le top y devenait introuvable.

**Chaque ligne de la feuille de route porte le même bouton**, à droite de son
tirage. Il donne la grille **telle qu'elle était avant ce coup-là**, avec le
tirage de ce coup. L'emprise dessinée est celle du moment : prendre celle de la
partie entière montrerait une zone vide du côté où elle a grandi ensuite.

C'est là que ça compte : le rejeu n'existe que sur une partie close, alors que
la feuille de route est ouverte à tout moment, y compris sur une grille infinie
qui ne se termine jamais. Sans ce bouton, proposer un coup à chercher y était
impossible.

PNG plutôt que JPEG : des lettres nettes sur un fond uni, c'est le cas où le PNG
gagne sur tous les tableaux, poids compris.

### Ce qui décide de la finesse des lettres

La taille d'une case dans l'image se déduit d'un **plafond divisé par le côté de
la grille**, et la lettre fait les deux tiers de la case. Sur une grille de
518 cases de côté — onze mille coups joués — le plafond ordinaire donne des cases
de dix pixels, donc des lettres de six : on les devine, on ne les lit pas.

Le plafond n'est pas une prudence excessive. Un canevas se développe à **quatre
octets le pixel**, et il faut ensuite l'encoder : trente-six millions de pixels
pèsent déjà 144 Mo.

Trois choses l'ont repoussé :

**Un seul canevas au lieu de deux.** La grille se dessinait sur le sien pour être
reportée ensuite sous le bandeau du tirage — deux images de la taille de la page,
donc le double de mémoire. Un décalage du repère suffit : `draw()` peint comme si
le bandeau n'existait pas, et ses numéros de colonnes tombent juste dessous au
lieu d'être recouverts.

**La place que le chiffre ne prend pas revient à la lettre.** En dessous de
dix-huit pixels la valeur du caramel n'est pas tracée : le coin bas est libre, la
lettre peut s'y étendre, centrée. Deux tiers de la case deviennent trois quarts.

**Une haute définition, au choix.** Elle triple le budget mémoire : c'est donc un
choix, pas la valeur par défaut, et le navigateur peut refuser de produire
l'image — ce qu'on lui redemande, plutôt que de rendre une image vide sans dire
pourquoi.

| grille de 518 × 567 cases | case | image | lettre |
|---|---|---|---|
| avant | 10 px | 5 210 × 5 687 | 6 px |
| ordinaire, après | 10 px | 5 210 × 5 687 | **7 px** |
| haute définition | 17 px | 8 806 × 9 639 | **13 px** |

Mesuré dans le navigateur : les deux tailles s'allouent et s'encodent, en 1,4 s
et 2,0 s.

> **Une grille entière ne sera jamais confortable à lire.** Il faudrait des cases
> de trente pixels, soit une image de 15 570 × 17 040 : hors d'atteinte. Pour
> lire les lettres, c'est une **portion** de grille qu'il faut tirer, pas la
> grille entière — et c'est ce qui reste à faire.

### Rouvrir une partie ancienne

Deux options, à ne pas confondre :

| option | effet |
|---|---|
| `--partie <nom>` | la partie nommée **prend la place de la grille permanente**, avec ses propres réglages, chrono compris, et **se remet à jouer** |
| `--rouvrir <nom>` | la partie nommée devient **un salon de plus**, à côté de la grille permanente, qui garde sa place |

`--rouvrir` est ce qu'on veut presque toujours : revoir une partie sans déloger
le jeu du site. Le salon s'inscrit au registre, donc une seule fois suffit ;
`--proprietaire <pseudo>` dit à qui il appartient, faute de quoi personne ne
pourra le refermer.

Une partie rouverte **continue de se jouer** si elle n'est pas close : son
journal n'est pas une copie d'archive, c'est le fichier vivant. Pour la
consulter figée, on en copie le journal et on donne à la copie un `coupsMax`
égal à son nombre de coups : elle se charge close, sans calculer de top.

**Qui arrive en cours de duplicate joue sans être compté.** On ne le refuse pas :
il voit la grille, il cherche, et **s'il trouve le top il figure dans la liste
des trouveurs**. Il entre au classement à la partie suivante. Son statut
hors-classement doit être visible, pour que personne ne s'étonne de son absence
du tableau.

En topping collaboratif et en battle, le score par coup n'est pas noté du tout —
seuls comptent les points et demi-points — et **on rejoint en cours de route sans
que ça pose problème**.

### Un fil de calcul par salon actif

Le solveur garde sa propre copie de la grille pour que son cache de
cross-checks reste chaud ; c'est ce qui rend les coups instantanés. On ne peut
donc pas faire tourner plusieurs parties dans un fil commun sans perdre cet
avantage.

**Un fil par salon actif**, avec un plafond d'une dizaine et libération des fils
restés inactifs. Le coût est d'environ 4 Mo de dictionnaire par fil, plus la
grille. Une vingtaine de salons tiennent sur une machine de maison ; des
milliers, non.

### La fin d'une partie

Une partie s'arrête quand il ne reste plus, dans le **sac et les reliquats**,
que des voyelles ou que des consonnes. **Les jokers doivent être joués** : tant
qu'il en reste un, il peut fournir la lettre manquante et la partie continue.

Le Y est la lettre qui bascule, parce qu'il peut tenir le rôle de la voyelle :

| ce qui reste | on |
|---|---|
| voyelles seules, avec ou sans Y | **arrête** |
| consonnes seules **avec** le Y | continue jusqu'à ce que le Y soit joué ou qu'il n'y ait plus de consonne |
| le Y seul | **arrête** |

> C'est une **convention**, pas une constatation. Sur une grille remplie, une
> voyelle isolée se colle presque toujours quelque part — le dictionnaire compte
> d'ailleurs 11 mots de voyelles seules (EAU, OIE, OUIE…) et 8 de consonnes
> seules (PSST, BRRR…). Attendre que le moteur ne trouve vraiment plus rien
> ferait traîner la fin sur des coups sans intérêt.

### Statistiques

Les moyennes de temps n'ont de sens que **globalement**, jamais par joueur : on
ignore combien de temps quelqu'un a cherché sans trouver, et un coup remporté en
2 minutes peut suivre 4 heures de recherche infructueuse d'un autre.

Pour un joueur, on ne retient donc que ce qu'on sait mesurer : le temps mis sur
les coups **qu'il a remportés** (moyenne, médiane, le plus rapide, le plus lent),
ses séries, et un **indice de difficulté**.

L'indice rapporte la vitesse à la taille de la grille, mesurée par le **nombre
d'ancrages** — la seule grandeur qui dise vraiment combien d'endroits il fallait
examiner. Elle croît d'environ **8 ancrages par coup joué**, soit un facteur
2 300 entre le premier coup et le trois-centième : un rapport linéaire écraserait
tout. La forme retenue est donc `√ancrages / temps`, à calibrer sur de vraies
parties.
