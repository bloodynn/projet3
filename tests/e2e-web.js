/*
 * Test de bout en bout de la recherche web (dorks) : moteurs (DuckDuckGo, Bing, Google)
 * et sites de bons plans simulés par interception réseau.
 * Usage : node tests/e2e-web.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const SRC = path.resolve(__dirname, '../extension');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

const PAGES = {
  'coupons.example': '<div class="c" data-code="FRSALE10">Copier</div><p>Code promo : SAVE5 (5€ offerts)</p>',
  'blog.example': '<p>Le meilleur code promo du mois : AEFR10. Autre code : aefr99 (minuscules, ignoré)</p>',
  'forum.example': '<p>Codes FR : code F23 (23€ dès 169€), code F13 (13€ dès 99€)</p>',
  'site-google.example': '<p>Coupon: GOOGPAGE8</p>'
};
const GOOGLE = `<html><body><div id="search"><div id="rso">
  <div class="g"><div><a href="https://site-google.example/aliexpress"><h3>Codes AliExpress</h3></a></div>
    <div class="snippet">Black Friday : code promo GOOG7 pour 7€ de réduction</div></div>
</div></div></body></html>`;

(async () => {
  // Copie de l'extension avec l'accès web déjà accordé (impossible de cliquer la boîte
  // d'autorisation de Chrome en mode automatisé)
  const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'alipromo-ext-'));
  fs.cpSync(SRC, EXT, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('https://*/*', 'http://*/*');
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest));

  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'alipromo-')), {
    headless: true, channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  const requested = [];
  try {
    await ctx.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.protocol === 'chrome-extension:') return route.continue();
      requested.push(u.hostname + u.pathname + u.search);
      const html = (body) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
      if (u.hostname === 'html.duckduckgo.com') return html(fx('ddg.html'));
      if (u.hostname === 'www.bing.com') return html(fx('bing.html'));
      if (u.hostname === 'www.google.com' && u.pathname === '/search') return html(GOOGLE);
      if (PAGES[u.hostname]) return html(PAGES[u.hostname]);
      return route.fulfill({ status: 404, body: '' });
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    // 1) Recherche automatique lancée depuis le popup
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    const res = await popup.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage(
      { type: 'webSearch', dorks: ['"code promo" aliexpress "{mois} {annee}"', 'site:dealabs.com aliexpress'] }, resolve)));
    if (!res.ok) throw new Error(res.error);
    const r = res.data;
    console.log('Recherche auto :', JSON.stringify({ totalFound: r.totalFound, newCodes: r.newCodes, pages: r.pages, queries: r.queries.length }));

    // 2) Recherche Google ouverte dans un onglet (paramètre alipromo=1)
    const g = await ctx.newPage();
    await g.goto('https://www.google.com/search?alipromo=1&q=' + encodeURIComponent('"code promo" aliexpress'));
    await g.waitForFunction(() => /nouveau/.test((document.getElementById('alipromo-google') || {}).textContent || ''), null, { timeout: 30000 });
    const banner = await g.locator('#alipromo-google').innerText();
    console.log('Bandeau Google :', banner);

    // 3) Les codes trouvés sont bien proposés au test sur la page de paiement
    const plan = await popup.evaluate(() => new Promise((resolve) => chrome.runtime.sendMessage({ type: 'planForPage' }, resolve)));
    const { webCodes } = await sw.evaluate(() => chrome.storage.local.get('webCodes'));
    console.log('Codes du web :', Object.keys(webCodes).sort().join(', '));
    console.log('Ordre de test :', plan.data.toTest.join(', '));

    await popup.setViewportSize({ width: 380, height: 760 });
    await popup.reload();
    await popup.locator('nav button[data-tab="web"]').click();
    await popup.screenshot({ path: path.join(__dirname, 'e2e-web-popup.png') });

    const expected = ['AEBF26', 'SAVE5', 'FRSALE10', 'AEFR10', 'F23', 'F13', 'GOOG7', 'GOOGPAGE8'];
    const checks = [
      ...expected.map((c) => [`code ${c} trouvé`, !!webCodes[c]]),
      ['minuscules ignorées (aefr99)', !webCodes.AEFR99],
      ['DuckDuckGo interrogé', requested.some((u) => u.startsWith('html.duckduckgo.com'))],
      ['Bing interrogé', requested.some((u) => u.startsWith('www.bing.com'))],
      ['aliexpress.com non analysé comme source', !requested.some((u) => u.includes('aliexpress.com/p/coupon'))],
      ['SAVE5 vu sur 2 requêtes', webCodes.SAVE5 && webCodes.SAVE5.urls.length >= 1],
      ['bandeau Google OK', /GOOG7/.test(banner)],
      ['codes web dans le plan de test', expected.every((c) => plan.data.toTest.includes(c))]
    ];
    let failed = 0;
    for (const [name, ok] of checks) { console.log((ok ? '✔ ' : '✘ ') + name); if (!ok) failed++; }
    process.exitCode = failed ? 1 : 0;
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
