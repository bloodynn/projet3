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
    'USERS', 'USER', 'ORDER', 'ORDERS', 'MIN', 'MAX', 'JSON', 'UTF', 'TODAY', 'REVEAL',
    'BLACK', 'FRIDAY', 'CYBER', 'MONDAY', 'SOLDES', 'NOEL', 'CHOICE', 'SUPER', 'MEGA', 'FLASH', 'TOP', 'BEST',
    'JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE',
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
    'AVEC', 'SANS', 'POUR', 'WITH', 'EXTRA', 'BONUS', 'OFFERT', 'OFFERTS', 'GRATUIT', 'COINS', 'PIECES'
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
      // Codes courts (ex. F13, F23) acceptés seulement s'ils mêlent lettres et chiffres
      if (c.length < 4 && !/^[A-Z]{1,2}\d{1,2}$/.test(c)) return;
      found.add(c);
    };
    const attrRe = /data-(?:code|coupon|coupon-code|clipboard-text|promo)\s*=\s*["']([^"']{3,30})["']/gi;
    let m;
    while ((m = attrRe.exec(s))) add(m[1]);

    const plain = s.replace(/<[^>]+>/g, ' ');
    // Mot-clé, puis jusqu'à 40 caractères de texte en minuscules/ponctuation
    // ("code promo du mois : "), puis un jeton écrit EN MAJUSCULES.
    const kwRe = /(?:[Cc]ode|CODE|[Cc]oupon|COUPON|[Pp]romo|PROMO|[Cc]oupon[- ]?[Cc]ode)[^A-Z0-9<>\n]{0,40}?\b([A-Z0-9][A-Z0-9_-]{2,29})\b/g;
    while ((m = kwRe.exec(plain))) add(m[1]);
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
  function planCodes(codes, statsMap, now, opts, popularity) {
    const unique = Array.from(new Set(codes.map(normalizeCode).filter(isPlausibleCode)));
    const kept = [];
    const skipped = [];
    for (const c of unique) {
      if (shouldSkip(statsMap[c], now, opts)) skipped.push(c);
      else kept.push(c);
    }
    // À stats égales, un code vu sur plusieurs sites passe avant
    const pop = popularity || {};
    const sc = (c) => scoreCode(statsMap[c], now) + Math.min(pop[c] || 0, 10) * 0.5;
    kept.sort((a, b) => sc(b) - sc(a));
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

  // ---------- Recherche web (Google dorks) ----------

  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Requêtes "dork" par défaut. Variables : {mois} {annee} {month} {year}. */
  const DEFAULT_DORKS = [
    '"code promo" aliexpress "{mois} {annee}"',
    'intitle:"code promo" aliexpress {annee} "dès"',
    'aliexpress "code promo" "valable jusqu\'au" {annee}',
    'site:dealabs.com aliexpress "code promo"',
    'inurl:code-promo-aliexpress OR inurl:codes-promo/aliexpress',
    'aliexpress "promo code" "{month} {year}"',
    'aliexpress coupon codes "{month} {year}" site:budgetlightforum.com',
    'aliexpress promo code {year} site:reddit.com'
  ];

  /** Pages connues qui publient des codes AliExpress (utilisées comme sources). */
  const KNOWN_SITES = [
    'https://www.dealabs.com/codes-promo/aliexpress',
    'https://www.ebuyclub.com/reduction-aliexpress-6325',
    'https://fr.igraal.com/codes-promo/aliexpress',
    'https://www.savoo.fr/marques/codes-promo-aliexpress',
    'https://www.groupon.fr/code-promo/aliexpress',
    'https://www.widilo.fr/code-promo/aliexpress',
    'https://www.discoup.com/fr/offre-code-promo-aliexpress.html',
    'https://promossale.com/aliexpress-coupons-promo-codes-and-deals/',
    'https://www.hotdeals.com/coupons/aliexpress-promo-codes',
    'https://www.dealnews.com/features/aliexpress/promo-codes/'
  ];

  function buildQueries(templates, date) {
    const d = date || new Date();
    const vars = {
      mois: MOIS[d.getMonth()], annee: String(d.getFullYear()),
      month: MONTHS[d.getMonth()], year: String(d.getFullYear())
    };
    return templates.map((t) => t.replace(/\{(mois|annee|month|year)\}/g, (_, k) => vars[k])).filter((q) => q.trim());
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  }
  const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  /** Liens de redirection des moteurs -> vraie URL. */
  function unwrapUrl(href) {
    let h = decodeEntities(href);
    if (h.startsWith('//')) h = 'https:' + h;
    try {
      const u = new URL(h, 'https://duckduckgo.com');
      if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get('uddg')) return u.searchParams.get('uddg');
      if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/') && u.searchParams.get('u')) {
        const b = u.searchParams.get('u').replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/');
        return atob(b + '==='.slice((b.length + 3) % 4));
      }
      if (/google\./.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url');
      return u.href;
    } catch (e) { return null; }
  }

  /** Résultat pertinent ? (on exclut AliExpress lui-même, les moteurs et les vidéos) */
  function isUsefulResultUrl(url) {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return false;
      return !/(^|\.)(aliexpress\.[a-z.]+|google\.[a-z.]+|bing\.com|duckduckgo\.com|youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|microsoft\.com)$/.test(u.hostname);
    } catch (e) { return false; }
  }

  /**
   * Analyse une page de résultats (HTML brut) de DuckDuckGo (version html) ou Bing.
   * Retourne [{url, title, snippet}] dédoublonnés.
   */
  function parseSearchResults(html, engine) {
    const out = [];
    const seen = new Set();
    const push = (href, title, snippet) => {
      const url = unwrapUrl(href);
      if (!url || !isUsefulResultUrl(url) || seen.has(url)) return;
      seen.add(url);
      out.push({ url, title: stripTags(title), snippet: stripTags(snippet) });
    };
    const s = String(html || '');
    if (engine === 'duckduckgo') {
      const blocks = s.split(/class="[^"]*\bresult\b[^"]*"/).slice(1);
      for (const b of blocks) {
        const a = b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
                  b.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
        if (!a) continue;
        const sn = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
        push(a[1], a[2], sn ? sn[1] : '');
      }
    } else if (engine === 'bing') {
      const blocks = s.split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"/).slice(1);
      for (const b of blocks) {
        const a = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!a) continue;
        const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        push(a[1], a[2], sn ? sn[1] : '');
      }
    }
    return out;
  }

  const api = {
    normalizeCode, isPlausibleCode, parsePrice, extractCodes, emptyStats,
    shouldSkip, scoreCode, planCodes, recordResult, pickBest,
    DEFAULT_DORKS, KNOWN_SITES, buildQueries, parseSearchResults, unwrapUrl, isUsefulResultUrl, stripTags
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AliPromoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
