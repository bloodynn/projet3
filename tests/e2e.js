/*
 * Test de bout en bout : charge l'extension dans Chromium, sert une maquette de page
 * de paiement à l'adresse aliexpress.com, lance le test des codes et vérifie le résultat.
 * Usage : node tests/e2e.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const EXT = path.resolve(__dirname, '../extension');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/checkout.html'), 'utf8');
const URL = 'https://fr.aliexpress.com/p/trade/confirm.html';

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alipromo-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true,
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  try {
    await ctx.route('**://*.aliexpress.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }));
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');

    // Codes de test : 2 valides (SAVE5 = -5 €, AEFR10 = -10 % = -4,59 €), 1 expiré, 1 sous minimum, 2 invalides
    await sw.evaluate(() => chrome.storage.local.set({
      codes: ['NOPE1', 'SAVE5', 'OLD2023', 'AEFR10', 'BIG30', 'FAKE99'],
      settings: { delayMs: 200, autoApplyBest: true, maxFailures: 3, retryAfterDays: 7, selectors: {} },
      stats: { FAKE99: { successes: 0, failures: 5, lastTested: Date.now(), lastSuccess: 0 } }
    }));

    const page = await ctx.newPage();
    await page.goto(URL);
    await page.waitForSelector('#alipromo-host', { state: 'attached', timeout: 10000 });
    await page.locator('#alipromo-host').locator('button.main').click();
    await page.locator('#alipromo-host .res').waitFor({ state: 'visible', timeout: 40000 }).catch(async (e) => { console.log('LOG:', await page.locator('#alipromo-host .log').innerText(), 'ST:', await page.locator('#alipromo-host .st').innerText()); await page.screenshot({ path: path.join(__dirname, 'e2e-screenshot.png') }); throw e; });

    const result = await page.locator('#alipromo-host .res').innerText();
    const log = await page.locator('#alipromo-host .log').innerText();
    const total = await page.locator('#total').innerText();
    const itemsLeft = await page.locator('.item').count();
    const stats = await sw.evaluate(() => chrome.storage.local.get(['stats', 'history']));
    await page.screenshot({ path: path.join(__dirname, 'e2e-screenshot.png') });

    console.log('--- Journal ---\n' + log + '\n--- Résultat ---\n' + result + '\nTotal page : ' + total);
    const checks = [
      ['meilleur code = SAVE5', /SAVE5/.test(result)],
      ['total final 40,90 €', total.includes('40,90')],
      ['code mort FAKE99 ignoré', !log.includes('FAKE99')],
      ['AEFR10 mesuré à -4.59', log.includes('AEFR10 : −4.59')],
      ['OLD2023 détecté invalide', /❌ OLD2023/.test(log)],
      ['BIG30 refusé (minimum)', /❌ BIG30/.test(log)],
      ['aucun article supprimé', itemsLeft === 2],
      ['stats SAVE5 enregistrées', stats.stats.SAVE5 && stats.stats.SAVE5.successes === 1],
      ['échec NOPE1 enregistré', stats.stats.NOPE1 && stats.stats.NOPE1.failures === 1],
      ['historique enregistré', stats.history.length === 1]
    ];
    let failed = 0;
    for (const [name, ok] of checks) { console.log((ok ? '✔ ' : '✘ ') + name); if (!ok) failed++; }
    process.exitCode = failed ? 1 : 0;
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
