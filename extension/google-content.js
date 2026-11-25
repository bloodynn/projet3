/*
 * Sur une page de résultats Google ouverte par AliPromo (paramètre alipromo=1),
 * récupère les résultats (lien + extrait) et les transmet à l'extension, qui en
 * extrait les codes et analyse les pages trouvées.
 * Google interdit l'interrogation automatique : la recherche est donc faite par
 * vous, dans un vrai onglet ; l'extension ne fait que lire ce qui s'affiche.
 */
(function () {
  'use strict';
  if (!/[?&]alipromo=1\b/.test(location.search) || window.__aliPromoGoogle) return;
  window.__aliPromoGoogle = true;

  function collect() {
    const results = [];
    const seen = new Set();
    for (const h3 of document.querySelectorAll('#search a h3, #rso a h3')) {
      const a = h3.closest('a');
      if (!a || !a.href || seen.has(a.href)) continue;
      seen.add(a.href);
      // Bloc du résultat : on remonte jusqu'au conteneur qui contient aussi l'extrait
      let box = a;
      for (let i = 0; i < 6 && box.parentElement && box.parentElement.id !== 'rso'; i++) box = box.parentElement;
      results.push({ url: a.href, text: (box.innerText || '').slice(0, 2000) });
    }
    return results;
  }

  function banner(text) {
    let el = document.getElementById('alipromo-google');
    if (!el) {
      el = document.createElement('div');
      el.id = 'alipromo-google';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:320px;' +
        'background:linear-gradient(90deg,#ff4747,#ff7a00);color:#fff;padding:12px 14px;border-radius:12px;' +
        'font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25)';
      document.documentElement.appendChild(el);
    }
    el.textContent = '🎟️ AliPromo — ' + text;
  }

  setTimeout(() => {
    const results = collect();
    if (!results.length) {
      banner(/sorry|captcha|unusual/i.test(document.body.innerText) ? 'Google demande une vérification : validez-la puis rechargez la page.' : 'Aucun résultat lisible sur cette page.');
      return;
    }
    banner(`Analyse de ${results.length} résultats et des pages trouvées…`);
    chrome.runtime.sendMessage({ type: 'googleResults', results }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) { banner('Erreur : ' + ((res && res.error) || 'extension indisponible')); return; }
      const d = res.data;
      banner(`${d.found} code(s) repéré(s) dont ${d.newCodes.length} nouveau(x)` +
        (d.newCodes.length ? ` : ${d.newCodes.slice(0, 8).join(', ')}` : '') +
        `. ${d.pages} page(s) analysée(s). Ils seront testés au paiement.`);
    });
  }, 1200);
})();
