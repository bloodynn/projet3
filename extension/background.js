/* Service worker : base de codes, statistiques de validité et collecte depuis des sources web. */
importScripts('lib/core.js');
const Core = self.AliPromoCore;

const DEFAULTS = {
  codes: [],            // codes saisis/importés par l'utilisateur
  sourceCodes: {},      // { code: [urlSource, ...] } codes trouvés automatiquement
  sources: [],          // URLs de pages de coupons à analyser
  stats: {},            // { code: stats }
  history: [],          // derniers essais [{date, best, saving, tested}]
  settings: { maxFailures: 3, retryAfterDays: 7, delayMs: 1200, autoApplyBest: true, selectors: {} },
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
  return Array.from(new Set([...state.codes, ...Object.keys(state.sourceCodes)]));
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
  delete state.stats[code];
  await chrome.storage.local.set({ codes: state.codes, sourceCodes: state.sourceCodes, stats: state.stats });
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
  const plan = Core.planCodes(allCodes(state), state.stats, Date.now(), state.settings);
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

const handlers = {
  getState: () => getState().then((s) => ({ ...s, all: allCodes(s) })),
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
  importAll: (m) => chrome.storage.local.set(m.data).then(() => true)
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
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'refresh') refreshSources(); });
