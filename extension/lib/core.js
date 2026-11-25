/*
 * Logique pure (sans DOM ni API Chrome) partagée par le content script,
 * le service worker et les tests Node.
 */
(function (root) {
  'use strict';

  /** Normalise un code : majuscules, sans espaces. */
  function normalizeCode(code) {
    return String(code || '').trim().replace(/\s+/g, '').toUpperCase();
  }

  /** Un code "plausible" : 3 à 30 caractères alphanumériques (tirets/underscores tolérés). */
  function isPlausibleCode(code) {
    return /^[A-Z0-9][A-Z0-9_-]{2,29}$/.test(code);
  }

  /**
   * Extrait un montant numérique d'un texte de prix, quel que soit le format :
   * "US $12.34", "12,34 €", "1 234,56 €", "€1.234,56", "1,234.56", "₽ 1 234".
   * Retourne null si aucun nombre n'est trouvé.
   */
  function parsePrice(text) {
    if (text == null) return null;
    const s = String(text).replace(/[   ]/g, ' ');
    const m = s.match(/-?\d[\d\s.,']*/);
    if (!m) return null;
    let num = m[0].replace(/[\s']/g, '');
    num = num.replace(/[.,]+$/, '');
    const lastDot = num.lastIndexOf('.');
    const lastComma = num.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
      // Le dernier séparateur est le séparateur décimal
      if (lastComma > lastDot) num = num.replace(/\./g, '').replace(',', '.');
      else num = num.replace(/,/g, '');
    } else if (lastComma !== -1) {
      const decimals = num.length - lastComma - 1;
      const count = (num.match(/,/g) || []).length;
      // "1,234" (3 chiffres, un seul séparateur) = milliers ; "12,34" = décimales
      if (count > 1 || decimals === 3) num = num.replace(/,/g, '');
      else num = num.replace(',', '.');
    } else if (lastDot !== -1) {
      // Plusieurs points = milliers ("1.234.567") ; un seul point = décimal ("12.34")
      if ((num.match(/\./g) || []).length > 1) num = num.replace(/\./g, '');
    }
    const v = parseFloat(num);
    return Number.isFinite(v) ? v : null;
  }

  const STOPWORDS = new Set([
    'CODE', 'CODES', 'COUPON', 'COUPONS', 'PROMO', 'PROMOS', 'COPY', 'COPIER', 'COPIE',
    'HTTP', 'HTTPS', 'HTML', 'WWW', 'COM', 'ALIEXPRESS', 'ALIBABA', 'SHOW', 'GET', 'VOIR',
    'DEAL', 'DEALS', 'OFF', 'SALE', 'FREE', 'USD', 'EUR', 'EURO', 'EUROS', 'DOLLAR', 'EXPIRE',
    'EXPIRED', 'VALID', 'VALIDE', 'NONE', 'NULL', 'TRUE', 'FALSE', 'CLICK', 'HERE', 'NEW',
    'USERS', 'USER', 'ORDER', 'ORDERS', 'MIN', 'MAX', 'JSON', 'UTF', 'TODAY', 'REVEAL'
  ]);

  /**
   * Repère les codes promo candidats dans du texte/HTML provenant d'un site de coupons.
   * Heuristique : attributs data-code / data-clipboard-text, et jetons en MAJUSCULES
   * situés juste après les mots "code", "coupon" ou "promo".
   */
  function extractCodes(text) {
    const found = new Set();
    const s = String(text || '');
    const add = (raw) => {
      const c = normalizeCode(raw);
      if (!isPlausibleCode(c) || STOPWORDS.has(c)) return;
      if (!/[A-Z]/.test(c)) return; // que des chiffres : probablement un prix/ID
      if (c.length < 4) return;
      found.add(c);
    };
    const attrRe = /data-(?:code|coupon|coupon-code|clipboard-text|promo)\s*=\s*["']([^"']{3,30})["']/gi;
    let m;
    while ((m = attrRe.exec(s))) add(m[1]);

    const plain = s.replace(/<[^>]+>/g, ' ');
    const kwRe = /(?:code|coupon|promo)(?:\s*(?:promo|de\s+r[ée]duction|code))?\s*[:：=\-–]?\s*["'«“]?\s*([A-Z0-9][A-Z0-9_-]{3,29})\b/gi;
    while ((m = kwRe.exec(plain))) {
      // Le jeton doit être écrit en majuscules dans la source pour éviter les mots courants
      if (m[1] === m[1].toUpperCase()) add(m[1]);
    }
    return Array.from(found);
  }

  /** Statistiques vierges d'un code. */
  function emptyStats() {
    return { successes: 0, failures: 0, lastTested: 0, lastSuccess: 0, bestSaving: 0, lastError: '' };
  }

  const DAY = 24 * 3600 * 1000;

  /**
   * Faut-il sauter ce code ? Oui s'il a échoué plusieurs fois récemment sans jamais
   * (ou plus depuis longtemps) fonctionner. On le retente après un délai, car certains
   * codes ne sont valables que pour certains produits / montants minimum.
   */
  function shouldSkip(stats, now, opts) {
    const o = Object.assign({ maxFailures: 3, retryAfterDays: 7 }, opts || {});
    if (!stats) return false;
    if (stats.lastSuccess && now - stats.lastSuccess < 14 * DAY) return false;
    const recentFailures = stats.failures - stats.successes;
    if (recentFailures >= o.maxFailures && now - stats.lastTested < o.retryAfterDays * DAY) return true;
    return false;
  }

  /** Score pour trier : codes qui ont marché récemment et rapporté le plus en premier. */
  function scoreCode(stats, now) {
    if (!stats) return 0;
    let score = stats.successes * 10 - stats.failures * 3 + (stats.bestSaving || 0);
    if (stats.lastSuccess) {
      const ageDays = (now - stats.lastSuccess) / DAY;
      score += Math.max(0, 30 - ageDays) * 2;
    }
    return score;
  }

  /** Ordonne les codes à tester et retire ceux à sauter. */
  function planCodes(codes, statsMap, now, opts) {
    const unique = Array.from(new Set(codes.map(normalizeCode).filter(isPlausibleCode)));
    const kept = [];
    const skipped = [];
    for (const c of unique) {
      if (shouldSkip(statsMap[c], now, opts)) skipped.push(c);
      else kept.push(c);
    }
    kept.sort((a, b) => scoreCode(statsMap[b], now) - scoreCode(statsMap[a], now));
    return { toTest: kept, skipped };
  }

  /** Met à jour les stats d'un code après un essai. */
  function recordResult(stats, result, now) {
    const s = Object.assign(emptyStats(), stats || {});
    s.lastTested = now;
    if (result.ok) {
      s.successes += 1;
      s.lastSuccess = now;
      s.bestSaving = Math.max(s.bestSaving || 0, Math.round((result.saving || 0) * 100) / 100);
      s.lastError = '';
    } else {
      s.failures += 1;
      s.lastError = String(result.error || '').slice(0, 200);
    }
    return s;
  }

  /** Choisit le meilleur résultat (plus grosse économie). */
  function pickBest(results) {
    let best = null;
    for (const r of results) {
      if (r.ok && r.saving > 0.0049 && (!best || r.saving > best.saving)) best = r;
    }
    return best;
  }

  const api = {
    normalizeCode, isPlausibleCode, parsePrice, extractCodes, emptyStats,
    shouldSkip, scoreCode, planCodes, recordResult, pickBest
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AliPromoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
