# 🎟️ AliPromo – testeur automatique de codes promo AliExpress

Extension pour **Chrome, Edge, Brave, Opera** (Manifest V3) qui, sur la page de paiement AliExpress :

1. **essaie automatiquement chaque code promo** de votre liste dans le champ « Code promo » ;
2. **mesure la vraie baisse du total** (pas seulement « code accepté ») ;
3. **réapplique le code qui fait économiser le plus** ;
4. **retient quels codes sont morts** (expirés, invalides) et arrête de les tester, puis les retente
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
npm run zip       # crée alipromo.zip (pour publication sur le Chrome Web Store)
```

Structure :

| Fichier | Rôle |
|---|---|
| `extension/content.js` | Détection des champs sur la page, essai des codes, panneau flottant |
| `extension/background.js` | Stockage des codes et statistiques, collecte des sources |
| `extension/lib/core.js` | Logique pure (prix, extraction, tri, mémoire des échecs) |
| `extension/popup/` | Interface de gestion (codes, sources, réglages, import/export) |
