/*
 * Content script AliExpress : détecte le champ "code promo" sur la page de commande,
 * essaie chaque code, mesure la baisse réelle du total, puis réapplique le meilleur.
 *
 * AliExpress change souvent son HTML : tout repose sur des heuristiques (textes,
 * placeholders, attributs) et peut être forcé via des sélecteurs CSS dans les réglages.
 */
(function () {
  'use strict';
  if (window.__aliPromoLoaded) return;
  window.__aliPromoLoaded = true;
  const Core = window.AliPromoCore;

  const RE = {
    input: /code|coupon|promo|voucher|r[ée]duction|gutschein|cup[oó]n|купон|промокод/i,
    inputExclude: /postal|zip|post ?code|search|recherche|phone|t[ée]l[ée]phone|sms|verif|captcha|password|mail/i,
    opener: /(code promo|promo ?code|coupon code|code coupon|saisir un code|entrer un code|enter (a )?code|add (a )?code|ajouter un code|code de r[ée]duction|use (a )?code|utiliser un code|aliexpress code|code aliexpress|промокод|gutscheincode|c[oó]digo)/i,
    apply: /^(appliquer|apply|utiliser|use|valider|ok|redeem|confirmer|confirm|применить|anwenden|aplicar|applica|use code)$/i,
    remove: /^(supprimer|remove|retirer|annuler|delete|effacer|clear|удалить|entfernen|eliminar|rimuovi|×|✕|x)$/i,
    totalLabel: /^(total|total à payer|total a payer|montant total|total de la commande|order total|grand total|total \(.*\)|summe|gesamtsumme|итого|totale|total del pedido)\s*:?$/i,
    error: /invalid|invalide|expir|not (valid|applicable|available|eligible)|n'est pas|ne peut|introuvable|incorrect|non valable|pas valable|unable|cannot|can't|does not|doesn't|minimum|déjà utilisé|already used|limit|недейств|ungültig|no válido|non valido|not found|failed|échec|erreur|error/i
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (type, extra) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res && res.ok ? res.data : null);
      });
    } catch (e) { resolve(null); }
  });

  let settings = { selectors: {}, delayMs: 1200, autoApplyBest: true };

  // ---------- Utilitaires DOM ----------

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Tous les éléments visibles hors de notre propre panneau. */
  function queryVisible(selector, scope) {
    return Array.from((scope || document).querySelectorAll(selector))
      .filter((el) => !el.closest('#alipromo-host') && isVisible(el));
  }

  function clickable(scope) {
    return queryVisible('button, a, [role="button"], span, div, label', scope)
      .filter((el) => { const t = textOf(el); return t.length > 0 && t.length <= 40; });
  }

  /** Clique comme un utilisateur (React écoute souvent mousedown/pointerdown). */
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, opts));
    }
    el.click();
  }

  /** Saisie compatible React/Vue : passe par le setter natif puis déclenche input/change. */
  function setNativeValue(input, value) {
    input.focus();
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    setter.set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- Détection des éléments de la page ----------

  function findCodeInput() {
    const sel = settings.selectors.input;
    if (sel) { const el = document.querySelector(sel); return el && isVisible(el) ? el : null; }
    const inputs = queryVisible('input:not([type]), input[type="text"], input[type="search"], input[type="tel"]');
    let best = null;
    for (const inp of inputs) {
      const attrs = [inp.placeholder, inp.name, inp.id, inp.className, inp.getAttribute('aria-label')].join(' ');
      if (RE.inputExclude.test(attrs)) continue;
      if (RE.input.test(attrs)) { best = inp; break; }
      // Libellé à proximité ?
      const label = inp.closest('label') || (inp.id && document.querySelector(`label[for="${CSS.escape(inp.id)}"]`));
      if (label && RE.input.test(textOf(label)) && !RE.inputExclude.test(textOf(label))) best = best || inp;
    }
    return best;
  }

  /** Si le champ est caché derrière un lien "Code promo", on clique dessus. */
  async function revealCodeInput() {
    let input = findCodeInput();
    if (input) return input;
    // On prend l'élément le plus profond qui porte le texte (le lien, pas son conteneur)
    const matches = clickable().filter((el) => RE.opener.test(textOf(el)));
    const deepest = matches.filter((el) => !matches.some((o) => o !== el && el.contains(o)));
    const opener = deepest.find((el) => el.matches('a, button, [role="button"]')) || deepest[0];
    if (!opener) return null;
    realClick(opener);
    for (let i = 0; i < 15 && !input; i++) { await sleep(200); input = findCodeInput(); }
    return input;
  }

  function findApplyButton(input) {
    const sel = settings.selectors.apply;
    if (sel) return document.querySelector(sel);
    let scope = input.parentElement;
    for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
      if (textOf(scope).length > 600) break;
      const btn = clickable(scope).find((el) => RE.apply.test(textOf(el)) && !el.contains(input));
      if (btn) return btn.closest('button, [role="button"], a') || btn;
    }
    return null;
  }

  function findRemoveButton(input) {
    const sel = settings.selectors.remove;
    if (sel) return document.querySelector(sel);
    if (!input) return null;
    // Recherche limitée à un petit bloc autour du champ, pour ne JAMAIS cliquer
    // sur le "Supprimer" d'un article du panier.
    let scope = input.parentElement;
    for (let depth = 0; scope && depth < 4; depth++, scope = scope.parentElement) {
      if (textOf(scope).length > 300) break;
      const btn = clickable(scope).find((el) => RE.remove.test(textOf(el)) ||
        /remove|delete|close|clear/i.test(el.getAttribute('aria-label') || ''));
      if (btn) return btn;
    }
    return null;
  }

  /** Lit le total de la commande (le dernier "Total" trouvé = récapitulatif). */
  function readTotal() {
    const sel = settings.selectors.total;
    if (sel) {
      const el = document.querySelector(sel);
      return el ? Core.parsePrice(textOf(el)) : null;
    }
    const candidates = [];
    const all = queryVisible('div, span, p, td, th, dt, strong, b, label');
    for (const el of all) {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
      const t = own || (el.children.length === 0 ? textOf(el) : '');
      if (!RE.totalLabel.test(t)) continue;
      // Le prix est dans le conteneur proche, hors libellé
      let container = el.parentElement;
      for (let d = 0; container && d < 3; d++, container = container.parentElement) {
        const txt = textOf(container).replace(t, '');
        if (/\d/.test(txt) && txt.length < 80) {
          const v = Core.parsePrice(txt);
          if (v != null) { candidates.push(v); break; }
        }
      }
    }
    if (candidates.length) return candidates[candidates.length - 1];
    // Repli : élément dont la classe contient "total" et qui ressemble à un prix
    const byClass = queryVisible('[class*="total" i], [class*="Total"]')
      .map((el) => textOf(el)).filter((t) => /\d/.test(t) && t.length < 40 && /[$€£₽¥]|eur|usd/i.test(t));
    return byClass.length ? Core.parsePrice(byClass[byClass.length - 1]) : null;
  }

  function readErrorNear(input) {
    let scope = input ? input.parentElement : null;
    for (let d = 0; scope && d < 5; d++, scope = scope.parentElement) {
      const err = queryVisible('*', scope).find((el) => el.children.length === 0 && RE.error.test(textOf(el)) && textOf(el).length < 200);
      if (err) return textOf(err);
    }
    const toast = queryVisible('[class*="toast" i], [class*="message" i], [class*="error" i], [role="alert"]')
      .map(textOf).find((t) => t && RE.error.test(t) && t.length < 200);
    return toast || '';
  }

  /** Attend un changement de total ou un message d'erreur. */
  async function waitForOutcome(input, before, timeoutMs) {
    const start = Date.now();
    let lastTotal = before;
    let stableSince = 0;
    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      const err = readErrorNear(input);
      const total = readTotal();
      if (total != null && before != null && Math.abs(total - before) > 0.0049) {
        // attendre que le total se stabilise (recalculs successifs)
        if (total === lastTotal) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > 500) return { total, error: '' };
        } else { stableSince = 0; lastTotal = total; }
        continue;
      }
      if (err && Date.now() - start > 600) return { total, error: err };
    }
    return { total: readTotal(), error: readErrorNear(input) || 'Aucun effet sur le total' };
  }

  // ---------- Essai d'un code ----------

  async function clearAppliedCode(input, baseTotal) {
    const rm = findRemoveButton(input);
    if (rm) {
      realClick(rm);
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        const t = readTotal();
        if (t != null && baseTotal != null && Math.abs(t - baseTotal) < 0.005) break;
      }
    }
  }

  async function tryCode(code, baseTotal) {
    const input = await revealCodeInput();
    if (!input) return { code, ok: false, error: 'Champ code promo introuvable', fatal: true };
    const current = readTotal();
    if (current != null && baseTotal != null && Math.abs(current - baseTotal) > 0.0049) {
      await clearAppliedCode(input, baseTotal);
    }
    const inp = findCodeInput() || input;
    setNativeValue(inp, '');
    await sleep(50);
    setNativeValue(inp, code);
    await sleep(150);
    const btn = findApplyButton(inp);
    if (btn) realClick(btn);
    else inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

    const before = readTotal();
    const outcome = await waitForOutcome(inp, before != null ? before : baseTotal, 7000);
    const newTotal = outcome.total;
    const saving = baseTotal != null && newTotal != null ? Math.round((baseTotal - newTotal) * 100) / 100 : 0;
    if (saving > 0.0049) return { code, ok: true, saving, total: newTotal };
    return { code, ok: false, saving: 0, error: outcome.error || 'Pas de réduction' };
  }

  // ---------- Session complète ----------

  let running = false;
  let stopRequested = false;

  async function runAll() {
    if (running) return;
    running = true; stopRequested = false;
    const plan = await send('planForPage');
    if (!plan) { ui.log('Extension indisponible, rechargez la page.', 'err'); running = false; return; }
    settings = Object.assign(settings, plan.settings || {});
    settings.selectors = settings.selectors || {};
    ui.setRunning(true);

    const input = await revealCodeInput();
    if (!input) {
      ui.result('Champ « code promo » introuvable sur cette page. Allez sur la page de paiement (Passer commande), ou définissez les sélecteurs dans les réglages.');
      ui.setRunning(false); running = false; return;
    }
    // Retire un code déjà appliqué pour mesurer le vrai prix de base
    if (findRemoveButton(input)) await clearAppliedCode(input, null);
    const baseTotal = readTotal();
    if (baseTotal == null) {
      ui.result('Total de la commande illisible : impossible de mesurer les économies (réglez le sélecteur « Total »).');
      ui.setRunning(false); running = false; return;
    }
    ui.log(`Total de départ : ${baseTotal.toFixed(2)} — ${plan.toTest.length} codes à tester` +
      (plan.skipped.length ? `, ${plan.skipped.length} ignorés (échecs répétés)` : ''));
    if (!plan.toTest.length) ui.log('Aucun code à tester. Ajoutez des codes ou des sources dans l\'extension.', 'err');

    const results = [];
    for (let i = 0; i < plan.toTest.length && !stopRequested; i++) {
      const code = plan.toTest[i];
      ui.progress(i, plan.toTest.length, code);
      let r;
      try { r = await tryCode(code, baseTotal); }
      catch (e) { r = { code, ok: false, error: String(e.message || e) }; }
      results.push(r);
      if (r.fatal) { ui.log(r.error, 'err'); break; }
      await send('recordResult', { code, result: r });
      ui.log(r.ok ? `✅ ${code} : −${r.saving.toFixed(2)}` : `❌ ${code} : ${r.error}`, r.ok ? 'ok' : 'ko');
      await sleep(settings.delayMs || 1200); // éviter d'être bloqué pour trop de requêtes
    }
    ui.progress(results.length, plan.toTest.length, '');

    const best = Core.pickBest(results);
    if (best) {
      const last = results[results.length - 1];
      if (settings.autoApplyBest && last.code !== best.code) {
        ui.log(`Application du meilleur code ${best.code}…`);
        await tryCode(best.code, baseTotal);
      } else if (settings.autoApplyBest && !last.ok) {
        await tryCode(best.code, baseTotal);
      }
      ui.result(`🎉 Meilleur code : ${best.code} — économie ${best.saving.toFixed(2)} (nouveau total ${(baseTotal - best.saving).toFixed(2)})`, best.code);
    } else if (results.length) {
      const input2 = findCodeInput();
      if (input2) { await clearAppliedCode(input2, baseTotal); setNativeValue(input2, ''); }
      ui.result('Aucun code valide pour ce panier. Les codes sont souvent liés à un montant minimum ou à des produits précis.');
    }
    await send('recordSession', { summary: { tested: results.length, best: best ? best.code : null, saving: best ? best.saving : 0, base: baseTotal } });
    ui.setRunning(false);
    running = false;
  }

  // ---------- Panneau flottant (Shadow DOM pour ne pas casser le style du site) ----------

  const ui = (() => {
    let root, els = {};
    function mount() {
      if (root) return;
      const host = document.createElement('div');
      host.id = 'alipromo-host';
      host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      document.documentElement.appendChild(host);
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .box { font: 13px/1.4 system-ui, sans-serif; width: 320px; background: #fff; color: #222;
                 border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.25); overflow: hidden; }
          .hd { background: linear-gradient(90deg,#ff4747,#ff7a00); color: #fff; padding: 10px 12px;
                display: flex; align-items: center; gap: 8px; font-weight: 600; }
          .hd .x { margin-left: auto; cursor: pointer; opacity: .8; background: none; border: 0; color: #fff; font-size: 16px; }
          .bd { padding: 10px 12px; }
          button.main { width: 100%; padding: 9px; border: 0; border-radius: 8px; background: #ff4747;
                        color: #fff; font-weight: 600; cursor: pointer; font-size: 14px; }
          button.main.stop { background: #555; }
          .bar { height: 6px; background: #eee; border-radius: 3px; margin: 8px 0; overflow: hidden; }
          .bar i { display: block; height: 100%; width: 0; background: #ff7a00; transition: width .2s; }
          .st { color: #666; font-size: 12px; min-height: 16px; }
          .log { max-height: 180px; overflow: auto; font-size: 12px; margin-top: 6px; }
          .log div { padding: 2px 0; border-bottom: 1px dashed #eee; word-break: break-word; }
          .ok { color: #0a7d32; } .ko { color: #999; } .err { color: #c00; }
          .res { margin-top: 8px; padding: 8px; background: #fff6e5; border-radius: 8px; font-weight: 600; }
          .res button { margin-left: 6px; font-size: 11px; cursor: pointer; }
          .min .bd { display: none; }
        </style>
        <div class="box">
          <div class="hd">🎟️ AliPromo <span class="cnt"></span><button class="x" title="Réduire">–</button></div>
          <div class="bd">
            <button class="main">Tester tous les codes</button>
            <div class="bar"><i></i></div>
            <div class="st"></div>
            <div class="res" hidden></div>
            <div class="log"></div>
          </div>
        </div>`;
      els = {
        box: root.querySelector('.box'), main: root.querySelector('.main'), bar: root.querySelector('.bar i'),
        st: root.querySelector('.st'), log: root.querySelector('.log'), res: root.querySelector('.res'),
        cnt: root.querySelector('.cnt'), x: root.querySelector('.x')
      };
      els.main.addEventListener('click', () => { if (running) { stopRequested = true; els.st.textContent = 'Arrêt après ce code…'; } else runAll(); });
      els.x.addEventListener('click', () => els.box.classList.toggle('min'));
      send('planForPage').then((p) => { if (p) els.cnt.textContent = `· ${p.toTest.length} codes`; });
    }
    return {
      mount,
      log(msg, cls) { mount(); const d = document.createElement('div'); d.textContent = msg; if (cls) d.className = cls; els.log.prepend(d); },
      progress(i, n, code) { mount(); els.bar.style.width = n ? `${Math.round((i / n) * 100)}%` : '0'; els.st.textContent = code ? `Test ${i + 1}/${n} : ${code}` : `Terminé (${i}/${n})`; },
      setRunning(on) { mount(); els.main.textContent = on ? 'Arrêter' : 'Tester tous les codes'; els.main.classList.toggle('stop', on); if (on) { els.res.hidden = true; els.log.textContent = ''; } },
      result(msg, code) {
        mount(); els.res.hidden = false; els.res.textContent = msg;
        if (code) {
          const b = document.createElement('button'); b.textContent = 'Copier';
          b.onclick = () => navigator.clipboard.writeText(code).then(() => { b.textContent = 'Copié ✓'; });
          els.res.appendChild(b);
        }
      }
    };
  })();

  // ---------- Démarrage ----------

  function looksLikeCheckout() {
    return /\/(trade|checkout|order|confirm|p\/trade|cart)/i.test(location.pathname + location.hash) || !!findCodeInput();
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === 'showPanel') { ui.mount(); sendResponse({ ok: true }); }
    if (msg && msg.type === 'startTest') { ui.mount(); runAll(); sendResponse({ ok: true }); }
  });

  // Les pages AliExpress sont des SPA : on surveille l'arrivée du formulaire de commande
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (looksLikeCheckout()) { ui.mount(); clearInterval(timer); }
    else if (tries > 40) clearInterval(timer);
  }, 750);

  // Exposé pour les tests automatisés
  window.__aliPromo = { runAll, readTotal, findCodeInput, findApplyButton, tryCode };
})();
