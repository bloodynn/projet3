# 🎟️ AliPromo – testeur automatique de codes promo AliExpress

Extension pour **Chrome, Edge, Brave, Opera** (Manifest V3) qui, sur la page de paiement AliExpress :

1. **essaie automatiquement chaque code promo** de votre liste dans le champ « Code promo » ;
2. **mesure la vraie baisse du total** (pas seulement « code accepté ») ;
3. **réapplique le code qui fait économiser le plus** ;
4. **cherche des codes sur le web tout seul** avec des requêtes « Google dorks » et sur les sites de bons plans connus ;
5. **retient quels codes sont morts** (expirés, invalides) et arrête de les tester, puis les retente
   automatiquement après quelques jours (un code refusé peut être valable sur un autre panier :
   minimum d'achat, produits éligibles…).

## Installation (2 minutes)

1. Téléchargez ce dépôt (bouton *Code → Download ZIP*) et décompressez-le.
2. Ouvrez `chrome://extensions` (ou `edge://extensions`).
3. Activez le **Mode développeur** (en haut à droite).
4. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier `extension/`.
5. Épinglez l'icône 🎟️ dans la barre d'outils.

## Utilisation

1. Cliquez sur l'icône → onglet **Codes** → collez vos codes (un par ligne, ou séparés par des espaces/virgules).
2. *(Optionnel)* onglet **Sources** : collez les adresses de pages qui publient des codes AliExpress
   (sites de bons plans, forums, ou un flux JSON `["CODE1","CODE2"]`). L'extension y récupère les
   codes automatiquement toutes les 6 h. Le navigateur vous demande l'autorisation d'accéder à ces sites.
3. Sur AliExpress, allez jusqu'à la page **Passer commande**. Un panneau AliPromo apparaît en bas à droite :
   cliquez **Tester tous les codes** (ou bouton du popup *Tester les codes sur cet onglet*).
4. À la fin, le meilleur code est appliqué et affiché avec son économie.

Dans l'onglet **Codes**, chaque code porte un badge : `valide`, `a déjà marché`, `jamais testé`, `mort / expiré`.

## Recherche de codes sur le web (Google dorks) 🔎

Onglet **Web** du popup. Les requêtes sont modifiables, une par ligne. Les variables `{mois}`, `{annee}`,
`{month}` et `{year}` sont remplacées par la date du jour. Requêtes par défaut :

```
"code promo" aliexpress "{mois} {annee}"
intitle:"code promo" aliexpress {annee} "dès"
aliexpress "code promo" "valable jusqu'au" {annee}
site:dealabs.com aliexpress "code promo"
inurl:code-promo-aliexpress OR inurl:codes-promo/aliexpress
aliexpress "promo code" "{month} {year}"
aliexpress coupon codes "{month} {year}" site:budgetlightforum.com
aliexpress promo code {year} site:reddit.com
```

Trois façons de chercher :

| Bouton | Ce qui se passe |
|---|---|
| **Recherche automatique (DuckDuckGo + Bing)** | L'extension lance chaque requête sur DuckDuckGo et Bing (ils comprennent `site:`, `intitle:`, `inurl:`), lit les extraits des résultats, puis ouvre les 10 pages les mieux classées pour y chercher des codes. Possible aussi toutes les 6 h en automatique. |
| **Ouvrir les recherches dans Google** | Google bloque les robots (captcha) et l'interdit dans ses conditions d'utilisation. Les requêtes s'ouvrent donc dans de vrais onglets ; l'extension lit les résultats affichés puis analyse les pages trouvées. Un bandeau indique les codes trouvés. |
| **Ajouter les sites de bons plans connus** | Ajoute Dealabs, eBuyClub, iGraal, Savoo, Groupon, Widilo, Discoup, Promossale, HotDeals et DealNews aux sources, analysées toutes les 6 h. |

Les codes trouvés apparaissent dans l'onglet **Codes** avec le site d'origine (🔎 web : …). Ils passent
ensuite dans le test automatique au paiement. Un code vu sur plusieurs sites est testé en premier. Un code
qui n'a pas été revu depuis 30 jours et n'a jamais marché est oublié.

Limites : beaucoup de sites cachent les codes derrière un bouton « Voir le code » (le code n'est pas dans la
page). L'extension trouve donc surtout les codes écrits en clair (forums, blogs, Dealabs, Reddit…). Les
moteurs peuvent afficher un captcha si on lance trop de recherches d'affilée.

## Si AliExpress change sa page

La détection est automatique (textes « Code promo », « Appliquer », « Total »… en FR/EN/ES/DE/IT/RU).
Si elle échoue un jour, ouvrez **Réglages → Sélecteurs CSS** et indiquez (clic droit → *Inspecter* sur
l'élément) le sélecteur du champ code, du bouton Appliquer et du total.

Par sécurité, l'extension ne cherche le bouton « Supprimer » que dans le petit bloc du code promo,
pour ne jamais retirer un article de votre panier. Elle ne valide **jamais** la commande.

## Limites à connaître

- **Aucun code n'est fourni d'office** : il n'existe pas d'API publique AliExpress listant les codes
  valides. L'extension les *teste* ; à vous de les fournir (copier-coller ou sources).
- Les codes AliExpress sont souvent liés à un **montant minimum**, un pays, une période d'événement
  (11.11, Black Friday…) ou un **nouveau compte**. Un code « invalide » pour vous peut marcher pour un autre panier.
- Les **coupons vendeurs** et **pièces** (coins) sont gérés directement par AliExpress, pas par ce champ.
- Une pause est faite entre deux essais (réglable) pour ne pas déclencher les protections anti-robot.

## Développement

```bash
npm test          # tests unitaires (analyse des prix, extraction de codes, tri, mémoire des échecs)
npm run test:e2e  # test de bout en bout : charge l'extension dans Chromium sur une maquette de paiement
npm run test:web  # test de bout en bout de la recherche web (moteurs et sites simulés)
npm run zip       # crée alipromo.zip (pour publication sur le Chrome Web Store)
```

Structure :

| Fichier | Rôle |
|---|---|
| `extension/content.js` | Détection des champs sur la page, essai des codes, panneau flottant |
| `extension/background.js` | Stockage des codes et statistiques, collecte des sources, recherche web |
| `extension/google-content.js` | Lecture des résultats Google pour les recherches lancées par l'extension |
| `extension/lib/core.js` | Logique pure (prix, extraction de codes, dorks, lecture des résultats, tri) |
| `extension/popup/` | Interface de gestion (codes, sources, réglages, import/export) |
