'use strict';
const Core = window.AliPromoCore;
const $ = (id) => document.getElementById(id);
const send = (type, extra) => new Promise((resolve) =>
  chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (res) => resolve(res && res.ok ? res.data : null)));

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

function fmtDate(ts) { return ts ? new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '—'; }

function statusOf(code, stats, settings) {
  const now = Date.now();
  if (!stats || !stats.lastTested) return { cls: 'new', label: 'jamais testé' };
  if (Core.shouldSkip(stats, now, settings)) return { cls: 'dead', label: 'mort / expiré' };
  if (stats.lastSuccess && stats.lastSuccess >= stats.lastTested - 1000) return { cls: 'ok', label: 'valide' };
  if (stats.successes > 0) return { cls: 'meh', label: 'a déjà marché' };
  return { cls: 'meh', label: `${stats.failures} échec(s)` };
}

let state;

async function load() {
  state = await send('getState');
  if (!state) return;
  const now = Date.now();
  const plan = Core.planCodes(state.all, state.stats, now, state.settings);
  const valid = state.all.filter((c) => statusOf(c, state.stats[c], state.settings).cls === 'ok').length;
  $('summary').textContent = `${state.all.length} codes · ${valid} valides · ${plan.skipped.length} morts`;
  renderCodes();
  $('sources').value = state.sources.join('\n');
  const s = state.settings;
  $('delayMs').value = s.delayMs; $('maxFailures').value = s.maxFailures;
  $('retryAfterDays').value = s.retryAfterDays; $('autoApplyBest').checked = !!s.autoApplyBest;
  for (const k of ['input', 'apply', 'remove', 'total']) $('sel-' + k).value = (s.selectors || {})[k] || '';
  $('dorks').value = (s.dorks || Core.DEFAULT_DORKS).join('\n');
  $('autoWebSearch').checked = !!s.autoWebSearch;
  $('webMaxPages').value = s.webMaxPages || 10;
  chrome.permissions.contains({ origins: ['https://*/*'] }, (ok) => { $('webPerm').hidden = ok; });
  if (state.lastWebSearch && !$('webStatus').textContent) {
    $('webStatus').textContent = 'Dernière recherche : ' + new Date(state.lastWebSearch).toLocaleString('fr-FR') +
      ` · ${Object.keys(state.webCodes).length} codes issus du web`;
  }
  $('history').innerHTML = '';
  for (const h of state.history.slice(0, 15)) {
    const li = document.createElement('li');
    li.textContent = `${new Date(h.date).toLocaleString('fr-FR')} — ${h.tested} testés — ` +
      (h.best ? `meilleur ${h.best} (−${Number(h.saving).toFixed(2)})` : 'aucun valide');
    $('history').appendChild(li);
  }
}

function renderCodes() {
  const list = $('codeList');
  list.innerHTML = '';
  const now = Date.now();
  const sorted = [...state.all].sort((a, b) => Core.scoreCode(state.stats[b], now) - Core.scoreCode(state.stats[a], now));
  for (const code of sorted) {
    const st = state.stats[code];
    const status = statusOf(code, st, state.settings);
    if ($('hideDead').checked && status.cls === 'dead') continue;
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.style.flex = '1';
    const name = document.createElement('div'); name.className = 'code'; name.textContent = code;
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = st
      ? `✔ ${st.successes} · ✘ ${st.failures} · testé ${fmtDate(st.lastTested)}` + (st.bestSaving ? ` · max −${st.bestSaving}` : '')
      : '';
    if (st && st.lastError) meta.title = st.lastError;
    info.append(name, meta);
    const origin = (state.sourceCodes[code] || []).concat(state.webCodes[code] ? state.webCodes[code].urls : []);
    if (origin.length) {
      const src = document.createElement('div'); src.className = 'src';
      const hosts = Array.from(new Set(origin.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return '?'; } })));
      src.textContent = (state.webCodes[code] ? '🔎 web : ' : 'source : ') + hosts.slice(0, 3).join(', ') + (hosts.length > 3 ? ` +${hosts.length - 3}` : '');
      src.title = origin.join('\n');
      info.appendChild(src);
    }
    const badge = document.createElement('span'); badge.className = 'badge ' + status.cls; badge.textContent = status.label;
    const copy = document.createElement('button'); copy.textContent = '📋'; copy.title = 'Copier';
    copy.onclick = () => navigator.clipboard.writeText(code).then(() => toast(code + ' copié'));
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Supprimer';
    del.onclick = async () => { await send('removeCode', { code }); load(); };
    li.append(info, badge, copy, del);
    list.appendChild(li);
  }
  if (!list.children.length) list.innerHTML = '<li class="hint">Aucun code. Collez-en ci-dessus ou ajoutez des sources.</li>';
}

// Onglets
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  for (const t of ['codes', 'web', 'sources', 'settings']) $('tab-' + t).hidden = t !== b.dataset.tab;
}));

$('hideDead').addEventListener('change', renderCodes);

$('addCodes').addEventListener('click', async () => {
  const raw = $('newCodes').value.split(/[\s,;]+/).filter(Boolean);
  const added = await send('addCodes', { codes: raw });
  $('newCodes').value = '';
  toast(`${(added || []).length} code(s) ajouté(s)`);
  load();
});

$('saveSources').addEventListener('click', async () => {
  const urls = $('sources').value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
  // Demande l'autorisation d'accéder à ces sites (nécessaire pour les télécharger)
  const origins = Array.from(new Set(urls.map((u) => new URL(u).origin + '/*')));
  if (origins.length) {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) { toast('Autorisation refusée : les sources ne pourront pas être lues'); return; }
  }
  await send('setSources', { sources: urls });
  toast('Sources enregistrées');
});

$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true; $('refresh').textContent = 'Analyse…';
  const report = await send('refreshSources');
  $('refresh').disabled = false; $('refresh').textContent = 'Rafraîchir maintenant';
  $('sourceReport').innerHTML = '';
  for (const r of report || []) {
    const li = document.createElement('li');
    li.textContent = r.error ? `⚠️ ${r.url} : ${r.error}` : `✔ ${r.url} : ${r.count} code(s)`;
    $('sourceReport').appendChild(li);
  }
  load();
});

$('saveSettings').addEventListener('click', async () => {
  const selectors = {};
  for (const k of ['input', 'apply', 'remove', 'total']) { const v = $('sel-' + k).value.trim(); if (v) selectors[k] = v; }
  await send('setSettings', { settings: {
    delayMs: Math.max(300, +$('delayMs').value || 1200),
    maxFailures: Math.max(1, +$('maxFailures').value || 3),
    retryAfterDays: Math.max(1, +$('retryAfterDays').value || 7),
    autoApplyBest: $('autoApplyBest').checked,
    selectors
  } });
  toast('Réglages enregistrés');
  load();
});

$('export').addEventListener('click', () => {
  const data = { codes: state.codes, sources: state.sources, stats: state.stats, settings: state.settings };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'alipromo-export.json';
  a.click();
});

$('import').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const allowed = {};
    for (const k of ['codes', 'sources', 'stats', 'settings']) if (data[k] !== undefined) allowed[k] = data[k];
    await send('importAll', { data: allowed });
    toast('Import réussi'); load();
  } catch (err) { toast('Fichier invalide'); }
});

$('resetStats').addEventListener('click', async () => {
  if (!confirm('Effacer toutes les statistiques de validité ?')) return;
  await send('resetStats', {}); load();
});

$('run').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/aliexpress\.(com|us|ru)/.test(tab.url || '')) { toast('Ouvrez d\'abord la page de paiement AliExpress'); return; }
  chrome.tabs.sendMessage(tab.id, { type: 'startTest' }, () => {
    if (chrome.runtime.lastError) toast('Rechargez la page AliExpress puis réessayez');
    else window.close();
  });
});

// ---------- Onglet Web (dorks) ----------

const dorkTemplates = () => $('dorks').value.split('\n').map((l) => l.trim()).filter(Boolean);

async function saveWebSettings() {
  await send('setSettings', { settings: {
    dorks: dorkTemplates(),
    autoWebSearch: $('autoWebSearch').checked,
    webMaxPages: Math.min(40, Math.max(1, +$('webMaxPages').value || 10))
  } });
}

function requestWebAccess() {
  return chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] });
}

$('grantWeb').addEventListener('click', async () => {
  if (await requestWebAccess()) { $('webPerm').hidden = true; toast('Accès au web autorisé'); }
});
$('saveDorks').addEventListener('click', async () => { await saveWebSettings(); toast('Requêtes enregistrées'); });
$('resetDorks').addEventListener('click', async () => {
  $('dorks').value = Core.DEFAULT_DORKS.join('\n');
  await send('setSettings', { settings: { dorks: null } });
  toast('Requêtes par défaut rétablies');
});
$('autoWebSearch').addEventListener('change', saveWebSettings);
$('webMaxPages').addEventListener('change', saveWebSettings);

$('knownSites').addEventListener('click', async () => {
  const origins = Core.KNOWN_SITES.map((u) => new URL(u).origin + '/*');
  if (!(await chrome.permissions.request({ origins }))) { toast('Autorisation refusée'); return; }
  const sources = await send('addKnownSites');
  $('sources').value = (sources || []).join('\n');
  toast(`${Core.KNOWN_SITES.length} sites ajoutés aux sources — analyse en cours…`);
  $('refresh').click();
});

$('webGoogle').addEventListener('click', async () => {
  await saveWebSettings();
  const queries = Core.buildQueries(dorkTemplates());
  // Les pages trouvées via Google seront analysées si l'accès au web est autorisé
  await requestWebAccess();
  for (const q of queries) {
    chrome.tabs.create({ url: 'https://www.google.com/search?num=20&alipromo=1&q=' + encodeURIComponent(q), active: false });
  }
  toast(`${queries.length} recherches Google ouvertes en arrière-plan`);
});

$('webAuto').addEventListener('click', async () => {
  if (!(await requestWebAccess())) { toast("L'accès au web est nécessaire"); return; }
  $('webPerm').hidden = true;
  await saveWebSettings();
  $('webAuto').disabled = true;
  $('webReport').innerHTML = '';
  $('webStatus').textContent = 'Recherche en cours… (vous pouvez fermer ce popup, elle continue)';
  chrome.runtime.sendMessage({ type: 'webSearch' }, (res) => {
    $('webAuto').disabled = false;
    if (chrome.runtime.lastError) return;
    if (!res || !res.ok) { $('webStatus').textContent = '⚠️ ' + ((res && res.error) || 'erreur'); return; }
    const r = res.data;
    $('webStatus').textContent = `✔ ${r.totalFound} codes repérés, ${r.newCodes.length} nouveaux` +
      (r.newCodes.length ? ` : ${r.newCodes.slice(0, 15).join(', ')}` : '') +
      (r.blocked.length ? ` · ⚠️ bloqué par : ${Array.from(new Set(r.blocked)).join(', ')} (essayez « Ouvrir dans Google »)` : '');
    for (const q of r.queries) {
      const li = document.createElement('li');
      li.textContent = q.error ? `⚠️ [${q.engine}] ${q.q} : ${q.error}` : `[${q.engine}] ${q.q} → ${q.results} résultats, ${q.codes} codes`;
      $('webReport').appendChild(li);
    }
    for (const p of r.pages) {
      const li = document.createElement('li');
      li.textContent = p.error ? `⚠️ ${p.url} : ${p.error}` : `📄 ${p.url} → ${p.count} codes`;
      $('webReport').appendChild(li);
    }
    load();
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'webProgress') $('webStatus').textContent = msg.text;
});

load();
