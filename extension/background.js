/* Service worker : base de codes, statistiques de validité et collecte depuis des sources web. */
importScripts('lib/core.js');
const Core = self.AliPromoCore;

const DEFAULTS = {
  codes: [],            // codes saisis/importés par l'utilisateur
  sourceCodes: {},      // { code: [urlSource, ...] } codes trouvés automatiquement
  sources: [],          // URLs de pages de coupons à analyser
  webCodes: {},         // { code: {urls: [...], firstSeen, lastSeen} } trouvés via les dorks
  lastWebSearch: 0,
  stats: {},            // { code: stats }
  history: [],          // derniers essais [{date, best, saving, tested}]
  settings: {
    maxFailures: 3, retryAfterDays: 7, delayMs: 1200, autoApplyBest: true, selectors: {},
    dorks: null,          // null = requêtes par défaut (Core.DEFAULT_DORKS)
    webMaxPages: 10,      // pages de résultats à ouvrir et analyser par recherche
    autoWebSearch: false  // relancer la recherche web toutes les 6 h
  },
  lastRefresh: 0
};

async function getState() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const state = {};
  for (const k of Object.keys(DEFAULTS)) {
    state[k] = data[k] !== undefined ? data[k] : structuredClone(DEFAULTS[k]);
  }
  state.settings = Object.assign({}, DEFAULTS.settings, state.settings);
  return state;
}

function allCodes(state) {
  return Array.from(new Set([...state.codes, ...Object.keys(state.sourceCodes), ...Object.keys(state.webCodes)]));
}

/** Nombre de sites différents sur lesquels chaque code a été vu. */
function popularity(state) {
  const pop = {};
  const add = (c, urls) => { pop[c] = (pop[c] || 0) + new Set((urls || []).map((u) => { try { return new URL(u).hostname; } catch (e) { return u; } })).size; };
  for (const [c, urls] of Object.entries(state.sourceCodes)) add(c, urls);
  for (const [c, w] of Object.entries(state.webCodes)) add(c, w.urls);
  return pop;
}

async function addCodes(list) {
  const state = await getState();
  const added = [];
  for (const raw of list) {
    const c = Core.normalizeCode(raw);
    if (Core.isPlausibleCode(c) && !state.codes.includes(c)) {
      state.codes.push(c);
      added.push(c);
    }
  }
  await chrome.storage.local.set({ codes: state.codes });
  return added;
}

async function removeCode(code) {
  const state = await getState();
  state.codes = state.codes.filter((c) => c !== code);
  delete state.sourceCodes[code];
  delete state.webCodes[code];
  delete state.stats[code];
  await chrome.storage.local.set({ codes: state.codes, sourceCodes: state.sourceCodes, webCodes: state.webCodes, stats: state.stats });
}

/** Télécharge chaque source et en extrait les codes candidats. */
async function refreshSources() {
  const state = await getState();
  const sourceCodes = {};
  const report = [];
  for (const url of state.sources) {
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      let codes;
      const trimmed = text.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        // Flux JSON : ["CODE1", ...] ou [{code: "..."}] ou {codes: [...]}
        const json = JSON.parse(trimmed);
        const arr = Array.isArray(json) ? json : (json.codes || []);
        codes = arr.map((x) => (typeof x === 'string' ? x : x && x.code)).filter(Boolean)
          .map(Core.normalizeCode).filter(Core.isPlausibleCode);
      } else {
        codes = Core.extractCodes(text);
      }
      for (const c of codes) (sourceCodes[c] = sourceCodes[c] || []).push(url);
      report.push({ url, count: codes.length });
    } catch (e) {
      report.push({ url, error: String(e.message || e) });
    }
  }
  await chrome.storage.local.set({ sourceCodes, lastRefresh: Date.now() });
  return report;
}

async function planForPage() {
  const state = await getState();
  const plan = Core.planCodes(allCodes(state), state.stats, Date.now(), state.settings, popularity(state));
  return { ...plan, settings: state.settings };
}

async function recordResult(code, result) {
  const state = await getState();
  state.stats[code] = Core.recordResult(state.stats[code], result, Date.now());
  await chrome.storage.local.set({ stats: state.stats });
}

async function recordSession(summary) {
  const state = await getState();
  state.history.unshift({ date: Date.now(), ...summary });
  state.history = state.history.slice(0, 50);
  await chrome.storage.local.set({ history: state.history });
}

// ---------- Recherche web par "Google dorks" ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENGINES = {
  duckduckgo: (q) => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=fr-fr',
  bing: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=fr&count=20'
};
let webSearchRunning = false;

function progress(text) {
  chrome.runtime.sendMessage({ type: 'webProgress', text }).catch(() => {});
}

async function hasWebAccess() {
  return chrome.permissions.contains({ origins: ['https://*/*'] });
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal, headers: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

/** Ajoute des codes trouvés sur le web (avec la page d'origine) et purge les vieux. */
async function mergeWebCodes(found) {
  const state = await getState();
  const now = Date.now();
  const fresh = [];
  for (const [code, urls] of Object.entries(found)) {
    const w = state.webCodes[code] || { urls: [], firstSeen: now };
    if (!state.webCodes[code] && !allCodes(state).includes(code)) fresh.push(code);
    w.urls = Array.from(new Set([...w.urls, ...urls])).slice(0, 20);
    w.lastSeen = now;
    state.webCodes[code] = w;
  }
  // Les codes plus revus depuis 30 jours et jamais validés sont oubliés
  for (const [code, w] of Object.entries(state.webCodes)) {
    const st = state.stats[code];
    if (now - w.lastSeen > 30 * 864e5 && !(st && st.successes)) delete state.webCodes[code];
  }
  await chrome.storage.local.set({ webCodes: state.webCodes });
  return fresh;
}

/** Ouvre les pages trouvées et y extrait les codes. */
async function scanPages(urls, found, report) {
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    progress(`Analyse des pages ${i + 1}/${urls.length} : ${new URL(url).hostname}`);
    try {
      const codes = Core.extractCodes(await fetchText(url));
      for (const c of codes) (found[c] = found[c] || []).push(url);
      report.pages.push({ url, count: codes.length });
    } catch (e) {
      report.pages.push({ url, error: String(e.message || e) });
    }
    await sleep(400);
  }
}

/**
 * Lance les requêtes dork sur DuckDuckGo et Bing (Google bloque les requêtes
 * automatiques : pour lui on ouvre des onglets, voir google-content.js),
 * lit les extraits de résultats, puis ouvre les meilleures pages trouvées.
 */
async function webSearch(opts) {
  if (webSearchRunning) throw new Error('Une recherche est déjà en cours');
  if (!(await hasWebAccess())) throw new Error("Autorisez l'accès au web depuis l'onglet « Web » du popup");
  webSearchRunning = true;
  try {
    const state = await getState();
    const queries = Core.buildQueries((opts && opts.dorks) || state.settings.dorks || Core.DEFAULT_DORKS);
    const engines = (opts && opts.engines) || Object.keys(ENGINES);
    const found = {};
    const urlScore = new Map();
    const report = { queries: [], pages: [], newCodes: [], blocked: [] };
    let step = 0;
    for (const q of queries) {
      for (const engine of engines) {
        step++;
        progress(`Recherche ${step}/${queries.length * engines.length} (${engine}) : ${q}`);
        try {
          const html = await fetchText(ENGINES[engine](q));
          const results = Core.parseSearchResults(html, engine);
          if (!results.length && /captcha|anomaly|unusual traffic|robot/i.test(html)) {
            report.blocked.push(engine);
            report.queries.push({ q, engine, error: 'bloqué (captcha)' });
            continue;
          }
          let n = 0;
          results.forEach((r, rank) => {
            urlScore.set(r.url, (urlScore.get(r.url) || 0) + (20 - Math.min(rank, 19)));
            for (const c of Core.extractCodes(r.title + ' ' + r.snippet)) {
              (found[c] = found[c] || []).push(r.url); n++;
            }
          });
          report.queries.push({ q, engine, results: results.length, codes: n });
        } catch (e) {
          report.queries.push({ q, engine, error: String(e.message || e) });
        }
        await sleep(1500 + Math.random() * 1000); // rester discret auprès des moteurs
      }
    }
    // Pages les mieux classées / trouvées par plusieurs requêtes
    const top = Array.from(urlScore.entries()).sort((a, b) => b[1] - a[1])
      .map(([u]) => u).slice(0, state.settings.webMaxPages || 10);
    await scanPages(top, found, report);
    report.newCodes = await mergeWebCodes(found);
    report.totalFound = Object.keys(found).length;
    await chrome.storage.local.set({ lastWebSearch: Date.now() });
    progress(`Terminé : ${report.totalFound} codes trouvés, dont ${report.newCodes.length} nouveaux`);
    return report;
  } finally { webSearchRunning = false; }
}

/** Résultats Google envoyés par google-content.js (recherche lancée par l'utilisateur). */
async function onGoogleResults(msg) {
  const found = {};
  for (const r of msg.results || []) {
    for (const c of Core.extractCodes(r.text || '')) (found[c] = found[c] || []).push(r.url);
  }
  const report = { pages: [] };
  if (await hasWebAccess()) {
    const state = await getState();
    const urls = (msg.results || []).map((r) => r.url).filter(Core.isUsefulResultUrl).slice(0, state.settings.webMaxPages || 10);
    await scanPages(urls, found, report);
  }
  const fresh = await mergeWebCodes(found);
  return { found: Object.keys(found).length, newCodes: fresh, pages: report.pages.length };
}

const handlers = {
  getState: () => getState().then((s) => ({ ...s, all: allCodes(s), popularity: popularity(s) })),
  webSearch: (m) => webSearch(m),
  googleResults: (m) => onGoogleResults(m),
  addKnownSites: async () => {
    const s = await getState();
    const sources = Array.from(new Set([...s.sources, ...Core.KNOWN_SITES]));
    await chrome.storage.local.set({ sources });
    return sources;
  },
  getDorks: async () => {
    const s = await getState();
    return { templates: s.settings.dorks || Core.DEFAULT_DORKS, queries: Core.buildQueries(s.settings.dorks || Core.DEFAULT_DORKS) };
  },
  addCodes: (m) => addCodes(m.codes || []),
  removeCode: (m) => removeCode(m.code),
  setSources: (m) => chrome.storage.local.set({ sources: m.sources }).then(() => true),
  setSettings: async (m) => {
    const s = await getState();
    await chrome.storage.local.set({ settings: Object.assign(s.settings, m.settings) });
    return true;
  },
  refreshSources: () => refreshSources(),
  planForPage: () => planForPage(),
  recordResult: (m) => recordResult(m.code, m.result).then(() => true),
  recordSession: (m) => recordSession(m.summary).then(() => true),
  resetStats: (m) => (async () => {
    const s = await getState();
    if (m.code) delete s.stats[m.code]; else s.stats = {};
    await chrome.storage.local.set({ stats: s.stats });
    return true;
  })(),
  importAll: (m) => chrome.storage.local.set(m.data).then(() => true),
  clearWebCodes: () => chrome.storage.local.set({ webCodes: {} }).then(() => true)
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) return false;
  Promise.resolve(h(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // réponse asynchrone
});

// Rafraîchit les sources automatiquement toutes les 6 h
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: 360 });
});
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'refresh') return;
  await refreshSources();
  const s = await getState();
  if (s.settings.autoWebSearch) webSearch().catch(() => {});
});
