# Passation — page d'accueil de Farfouille (nom provisoire)

## Ce que c'est

La refonte de la page d'accueil : le bandeau d'identité, la mise en avant du
**salon star** (la grille mondiale « Topping infini »), la liste des salons
ouverts, et l'accès au compte. Deux écrans sont livrés — **la même page dans
deux états de session**.

Le jeu ne porte jamais le nom du jeu de société dont il descend — ni dans le
code, ni dans l'interface. Le mot du jeu est **farfouille** (SPEC.md §1).

## À propos des fichiers de design

Les fichiers HTML de ce paquet sont des **références de design** : des maquettes
qui montrent l'aspect et le comportement voulus, **pas du code de production à
recopier tel quel**. Le travail consiste à **refaire ces écrans dans le
codebase existant** — ici `packages/web/`, en TypeScript + Vite, avec le
`index.html` et le `main.ts` qui portent déjà tout le CSS et le DOM du jeu —
en suivant ses conventions : variables CSS dans `:root`, classes courtes en
français (`.salon`, `.caramel`, `.bar`), DOM construit à la main dans
`main.ts`, aucun framework.

Concrètement : l'écran d'accueil actuel est le bloc `.join > .lobby` de
`packages/web/index.html`, peuplé par `peuplerSalons()` dans
`packages/web/src/main.ts`. C'est ce bloc que ces maquettes remplacent.

## Fidélité

**Haute fidélité.** Couleurs, typographies, tailles et espacements sont
définitifs et donnés en valeurs exactes ci-dessous. Les jetons de couleur sont
ceux qui existent déjà dans `:root` (`packages/web/index.html`) : réutiliser les
variables CSS, ne pas réintroduire les hex en dur là où une variable existe.

Une seule police est nouvelle : **Baloo 2**, pour le nom du site.

---

## Les deux écrans

### 2a — visiteur non connecté

**But** : parcourir les salons ouverts et comprendre en trois secondes qu'il y a
une grande grille commune où l'on peut jouer tout de suite.

Différences avec 2b, et elles sont importantes :

- le bandeau porte **un seul bouton d'accès au compte**, « Connexion /
  Inscription » ;
- **aucun bouton « Créer un salon » n'est rendu** — ni dans la barre de filtres,
  ni comme tuile dans la grille. Ce n'est pas un masquage CSS : le bouton ne doit
  pas exister dans le DOM d'un visiteur sans session ;
- « Jouer » et le clic sur une carte de salon mènent à la connexion /
  inscription, puis reviennent sur la destination demandée.

### 2b — joueur connecté

Même page, avec :

- à droite du bandeau : l'avatar (cercle de 24 px, initiale) et le pseudo, à la
  place du bouton de connexion ;
- **« Créer un salon »** en haut à droite de la barre de filtres (bouton plein
  vert, **sans le `+`**) ;
- **une tuile pointillée « Créer un salon »** en fin de grille, après le dernier
  salon.

---

## Mise en page

Largeur de référence : **1280 px**. Tout est en flex/grid avec `gap` ; aucune
marge de compensation.

### Bandeau (identique dans les deux états)

- Fond `#121916`, bordure basse `1px solid #23312B`, padding `11px 24px`,
  `display:flex; align-items:center; gap:16px`.
- **Nom du site**, à gauche, cliquable, ramène à l'accueil : Baloo 2 600,
  `25px/1.1`, `letter-spacing:-.005em`, couleur `#E6EDE9`. Pas de logo, pas de
  tuile-lettre.
- À droite, groupe `gap:16px` :
  - « Records » — Archivo `12.5px`, `#90A099` ;
  - **2a** : « Connexion / Inscription » — padding `7px 15px`, fond `#44B27A`,
    texte `#121916`, `12.5px/500`, rayon `4px` ;
  - **2b** : avatar `24px` cercle `#23312B`, initiale `11px/600` `#90A099`,
    puis le pseudo `12.5px` `#E6EDE9`.

### Corps

Fond `#F3F5F4`, padding `18px 24px 20px`.

**Barre de filtres** — `gap:8px`, `margin-bottom:14px`. Puce active : fond
`#121916`, texte `#FFFFFF`. Puces inactives : fond `#FFFFFF`, bordure `1px solid
#DEE4E1`, texte `#56615C`. Toutes : padding `5px 12px`, rayon `20px`, `11.5px`.
Filtres : **Tous · 15×15 · Infinie · En attente**.
En 2b seulement, poussé à droite (`margin-left:auto`) : « Créer un salon »,
padding `8px 15px`, fond `#1E7A4D`, texte `#FFFFFF`, `12.5px/500`, rayon `4px`.

**Grille des salons** — `display:grid; grid-template-columns:repeat(4,1fr);
gap:14px`. Le salon star occupe **2 colonnes × 2 rangées** et vient en premier ;
les autres salons suivent dans l'ordre du serveur.

### La tuile du salon star

`grid-column:span 2; grid-row:span 2`, `min-height:366px`, rayon `6px`,
padding `24px`, texte clair, contenu aligné en bas
(`flex-direction:column; justify-content:flex-end`), `overflow:hidden`.

Deux couches de fond, dans cet ordre :

```css
background-image:
  linear-gradient(to top, rgba(14,20,18,.97) 24%, rgba(14,20,18,.74) 52%, rgba(14,20,18,.34) 100%),
  url(grille-infinie-sombre.svg);
background-size: auto, 392px 392px;   /* 14 cases de 28 px */
background-repeat: no-repeat, repeat;
background-position: center, center;
```

Le motif doit **se répéter et sortir du cadre de tous les côtés** : c'est ce qui
raconte la grille sans fin. **Aucun mot posé dessus** — c'est délibéré.

Contenu, de haut en bas :

| Élément | Style | Texte |
|---|---|---|
| Pastille, absolue à `16px` du haut et de la droite | padding `4px 11px`, rayon `20px`, fond `rgba(14,20,18,.66)`, mono `11px`, `#44B27A`, point de `6px` `#44B27A` | `12 en ligne` — **rien d'autre**, pas de « permanent » |
| Sur-titre | mono `10.5px`, `letter-spacing:.13em`, majuscules, `#44B27A` | `Salon star` |
| Titre | Instrument Serif 400, `40px/1.02`, `#FFFFFF`, `margin-top:5px` | `Topping infini` |
| Accroche | Archivo `13.5px/1.5`, `#B4C2BB`, `max-width:44ch`, `margin-top:9px` | `Grille infinie, sans limite de temps, sans fin. Jusqu'où pourrons-nous aller ?` |
| Ligne d'action, `gap:16px`, `margin-top:20px` | bouton : padding `11px 30px`, fond `#44B27A`, texte `#0E1412`, `14.5px/600`, rayon `4px` — puis mono `11.5px` `#90A099`, chiffres tabulaires | `Jouer` · `Coup 5 302 · 441 647 points` |

Pas d'emprise (`113 × 135`), pas de dernier top, pas de tirage sur l'accueil.

### Une carte de salon

Fond `#FFFFFF`, bordure `1px solid #DEE4E1`, rayon `6px`, `overflow:hidden`,
en colonne.

**Vignette** — hauteur `112px`, bordure basse `1px solid #DEE4E1`, fond
`#E3E8E5`. C'est la **vraie grille du salon**, et elle dit d'abord de quel type
de grille il s'agit :

- **grille bornée 15×15** : `url(grille-15.svg)`, `background-size:auto 96px`,
  `center`, `no-repeat` — le plateau entier, centré, avec de l'air autour. On
  voit ses bords : il est fini.
- **grille infinie** : `url(grille-infinie.svg)`, `background-size:196px 196px`
  (14 cases de 14 px), `repeat`, `center` — le motif remplit la vignette bord à
  bord. Aucun bord visible : elle ne finit pas.

Badge en bas à droite (`7px` / `6px`) : padding `1px 5px`, rayon `3px`, fond
`rgba(243,245,244,.86)`, mono `10px`, `#56615C`, contenu `15×15` ou `∞`.

**Corps** — padding `11px 13px 12px`, `gap:6px` :

1. nom du salon — Archivo `13.5px/500`, `#121916` ;
2. spécification — mono `10.5px`, `#8B948F` (voir la règle de composition
   ci-dessous) ;
3. ligne d'état — mono `10.5px`, `#56615C`, `margin-top:2px` : point de `6px`
   (`#1E7A4D` si une partie est en cours, `#B5762A` si le salon attend), puis
   qui joue, puis à droite (`margin-left:auto`, `#8B948F`) le numéro du coup ou
   « en attente ».

**Tuile « Créer un salon » (2b uniquement)** — dernière cellule de la grille :
bordure `1px dashed #B6AC98`, rayon `6px`, fond `#ECF1EE`,
`min-height:180px`, centrée : « Créer un salon » (`13.5px/500`, `#1E7A4D`) et,
dessous, mono `10.5px` `#8B948F` : « un nom, c'est tout ».

### Pied de page

`margin-top:16px`, `padding-top:11px`, bordure haute `1px solid #DEE4E1`, mono
`10.5px`, `#A8B0AC`, aligné à droite : `31 joueurs en ligne`.

C'est le **seul** endroit où figure le nombre total de joueurs connectés. Il a
été retiré du bandeau à côté du nom : sur un site qui démarre, un compteur bas
placé en évidence est décourageant. Discret en pied de page, il informe sans
peser.

---

## Ce qui a été retiré, et pourquoi

À vérifier en relecture, ce sont des décisions, pas des oublis :

- **la pioche** dans les spécifications de salon (« probabilités pondérées »,
  « sac de 102 », « sac de 102 sans fin ») : illisible pour qui arrive, et sans
  effet sur le choix d'un salon ;
- **le mot « blitz »** : on affiche la durée seule (`30 s`, `60 s`, `2 min`) ;
- **l'emprise de la grille** (`113 × 135`) partout ;
- **« permanent »** dans la pastille du salon star ;
- **le compteur global** à côté du nom (descendu en pied de page) ;
- **le `+`** devant « Créer un salon » ;
- **les mots posés** sur les vignettes : elles montrent le motif, pas une partie.

---

## Le contrat de données

`GET /api/salons` renvoie déjà (`ResumeSalon`, `packages/web/src/main.ts`) :
`id`, `nom`, `mondiale`, `proprietaire`, `coups`, `finie`, `connectes`, et
`config { grille, tirage, jouables, chrono, pioche, joker }`. **Rien à ajouter
côté serveur.** Ce qui change est la composition côté client :

| Affichage | Dérivation |
|---|---|
| type de grille (badge, choix de la vignette) | `config.grille === '15'` → `15×15`, sinon `∞` |
| spécification | `` `${config.jouables} sur ${config.tirage}` ``, puis la durée du chrono (`30 s` / `60 s` / `2 min` / `sans chrono`), puis `joker` si `config.joker`. **Jamais `config.pioche`.** Séparateur : ` · ` |
| qui joue | `mondiale` → `permanent` ; sinon `` `${connectes} joueurs` `` |
| état | `coups === 0` → `en attente` ; sinon `` `coup ${coups}` `` |
| point de couleur | `coups > 0` → `#1E7A4D` ; `coups === 0` → `#B5762A` |
| pastille du salon star | `` `${connectes} en ligne` `` |
| pied de page | somme des `connectes` de tous les salons, ou un compteur global de sessions |

Les salons **privés** restent absents de la liste, comme aujourd'hui.

---

## Comportement

- **Clic sur le nom du site** : retour à l'accueil (comportement actuel de
  `#accueil`, qui appelle `quitterSalon()` quand on est dans une partie).
- **« Jouer »** : entre dans la grille mondiale si la session existe, sinon
  ouvre la connexion / inscription et **revient sur la grille** une fois la
  session ouverte. Même règle pour le clic sur une carte de salon.
- **Session par cookie `httpOnly`** (SPEC.md §8) : la page est rendue dans l'état
  connecté sans que l'utilisateur ait à se reconnecter. C'est l'état de session
  qui décide de rendre ou non les boutons de création — pas une classe CSS.
- **Filtres** : filtrage local sur la liste déjà reçue (grille, chrono, `coups
  === 0`). Aucun aller-retour serveur.
- **Survol** : les cartes reprennent l'effet existant de `.salon:hover` —
  `border-color: var(--accent)`, fond `var(--hover)`. Les maquettes ne le
  montrent pas ; il est attendu.
- **Rafraîchissement** : la liste est déjà repeuplée par `peuplerSalons()` ;
  garder ce rythme, les vignettes ne coûtent rien (deux SVG en cache).
- **Responsive** : non traité dans ces maquettes. La grille passe
  naturellement de 4 à 2 puis 1 colonne ; la tuile du salon star garde
  `span 2` tant qu'il y a deux colonnes, sinon `span 1`.

---

## Les visuels de grille

Trois SVG sont fournis. Ils ne sont pas décoratifs : ils sont **générés depuis le
vrai pavage du moteur**, `packages/engine/src/bonus.ts`.

| Fichier | Source | Emploi |
|---|---|---|
| `grille-infinie.svg` | `LAYOUTS.classique` = `tiled(CLASSIQUE)`, période **14**, centre 7 | vignettes des salons à grille infinie ; se répète sans couture |
| `grille-infinie-sombre.svg` | idem, jetons du thème sombre | fond de la tuile du salon star |
| `grille-15.svg` | `CLASSIQUE_15`, les quinze colonnes distinctes, étoile centrale, bord franc | vignettes des salons 15×15 |

Chaque tuile fait 14 × 14 cases de 20 unités (280 × 280), donc **elle se répète
en `background-repeat` sans décalage** : la période du pavage est 14, pas 15 —
les bords du plateau officiel coïncident au lieu de se juxtaposer (SPEC.md §3).
`grille-15.svg` fait 15 × 15 cases (301 × 301 avec son bord).

Correspondance des symboles :

| Symbole | Sens | Clair | Sombre |
|---|---|---|---|
| `T` | mot compte triple | `#C2493D` | `#99392F` |
| `D`, `*` | mot compte double | `#E08D7E` | `#B2665A` |
| `t` | lettre compte triple | `#3B7DA4` | `#2E5D7C` |
| `d` | lettre compte double | `#90BCD4` | `#4C84A2` |
| `.` | case nue | fond `#E3E8E5` | fond `#17211D` |
| quadrillage | | `#D2D9D5` | `#26332D` |

Les cases bonus sont des carrés de `16` unités centrés dans leur case de `20`
(marge de 2 de chaque côté), le quadrillage est tracé **par-dessus** en barres
de 1 unité.

> **Mieux, si vous voulez aller plus loin** : ces SVG sont une doublure fidèle du
> motif, pas de l'état réel d'un salon. Le vrai gain serait de peindre la
> vignette avec la **même fonction pure `bonusAt(x, y, pavage)`** que le canvas
> du jeu, sur un petit canvas hors écran, en centrant sur l'emprise réelle de la
> grille. Le pavage voyage déjà avec la partie (`ConfigPartie`), donc un salon
> réglé sur un autre motif afficherait le sien. À faire seulement si le motif
> définitif change (SPEC.md §3, « le motif définitif reste à concevoir ») — d'ici
> là les SVG suffisent, et ils coûtent deux requêtes en cache.

---

## Jetons

Tous existent déjà dans `:root` de `packages/web/index.html`, sauf mention.

**Couleurs, thème clair** — `--ground #F3F5F4` · `--panel #FFFFFF` ·
`--field #E3E8E5` · `--field-line #D2D9D5` · `--ink #121916` ·
`--ink-soft #56615C` · `--ink-faint #8B948F` · `--rule #DEE4E1` ·
`--hover #ECF1EE` · `--accent #1E7A4D` · `--accent-bg #DBEFE4` ·
`--mark #B5762A` · `--tile-face #FCFAF5` · `--tile-edge #B6AC98`.

**Couleurs, bandeau et tuile star** (jetons du thème sombre) — fond `#121916`,
bordure `#23312B`, texte `#E6EDE9`, texte faible `#90A099`, accent `#44B27A`,
noir de fond du dégradé `rgba(14,20,18,…)`. Deux valeurs ne sont dans aucun
jeton et peuvent être ajoutées : `#B4C2BB` (accroche du salon star) et
`#A8B0AC` (pied de page).

**Typographies** — Archivo 400/500/600 (interface) · IBM Plex Mono 400/500
(toute donnée chiffrée, avec `font-variant-numeric: tabular-nums`) ·
Instrument Serif 400 (titre du salon star) · **Baloo 2 600 — nouveau**, pour le
nom du site uniquement.

À ajouter au `<link>` Google Fonts existant :

```
family=Baloo+2:wght@500;600;700
```

**Échelle de texte** — `40` titre star · `25` nom du site · `14.5` bouton
principal · `13.5` nom de salon, accroche · `12.5` liens et boutons du bandeau ·
`11.5` puces de filtre, données du star · `10.5` mono des cartes et du pied ·
`10` badge de vignette.

**Espacements** — `4 · 5 · 6 · 8 · 9 · 11 · 14 · 16 · 18 · 20 · 24`.
**Rayons** — `3` badge · `4` boutons · `6` cartes et tuiles · `20` puces et
pastilles · `50%` avatar.
**Bordures** — `1px solid var(--rule)` partout ; `1px dashed #B6AC98` pour la
tuile de création. Aucune ombre.

---

## Les fichiers de ce paquet

| Fichier | Ce que c'est |
|---|---|
| `Accueil.dc.html` | la maquette, à ouvrir dans un navigateur. **Le tour 2, en haut de la page, porte 2a et 2b** — ce sont les écrans à implémenter. Le tour 1, en dessous, garde les trois directions explorées (`1a`, `1b`, `1c`) : contexte seulement, ne pas implémenter |
| `support.js` | le moteur de rendu de la maquette. Doit rester à côté du HTML pour qu'il s'ouvre |
| `grille-infinie.svg` | pavage infini, thème clair |
| `grille-infinie-sombre.svg` | pavage infini, thème sombre |
| `grille-15.svg` | plateau 15×15 borné |
| `README.md` | ce document |

Les identifiants `2a` et `2b` sont écrits dans la maquette au-dessus de chaque
écran : c'est le vocabulaire à employer pour en parler.
