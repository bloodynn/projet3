const test = require('node:test');
const assert = require('node:assert');
const Core = require('../extension/lib/core.js');

test('parsePrice gère les formats de prix courants', () => {
  const cases = {
    'US $12.34': 12.34, '12,34 €': 12.34, '1 234,56 €': 1234.56, '€1.234,56': 1234.56,
    '1,234.56': 1234.56, '₽ 1 234': 1234, 'Total : 9,99€': 9.99, '1.234.567': 1234567,
    '1,234': 1234, '0,50 €': 0.5, 'CA $ 45.00': 45, 'rien': null
  };
  for (const [txt, expected] of Object.entries(cases)) assert.strictEqual(Core.parsePrice(txt), expected, txt);
  assert.strictEqual(Core.parsePrice('12 345,00 €'), 12345);
});

test('normalizeCode / isPlausibleCode', () => {
  assert.strictEqual(Core.normalizeCode('  af ef3 '), 'AFEF3');
  assert.ok(Core.isPlausibleCode('AEFR05'));
  assert.ok(!Core.isPlausibleCode('A'));
  assert.ok(!Core.isPlausibleCode('CODE!'));
});

test('extractCodes trouve les codes dans du HTML de site de coupons', () => {
  const html = `
    <div class="coupon" data-code="FRSALE10">Copier</div>
    <p>Utilisez le code promo : AENOV25 pour 25€ de réduction</p>
    <p>Coupon: SUPER5 dès 30€ d'achat. Le code est valable aujourd'hui.</p>
    <button data-clipboard-text="ali-bf-8">copy</button>
    <p>Code 2024 et code promo valable</p>`;
  const codes = Core.extractCodes(html).sort();
  assert.deepStrictEqual(codes, ['AENOV25', 'ALI-BF-8', 'FRSALE10', 'SUPER5']);
});

test('shouldSkip met de côté les codes qui échouent en boucle, puis les retente', () => {
  const now = Date.now();
  const DAY = 864e5;
  assert.ok(!Core.shouldSkip(undefined, now));
  const dead = { successes: 0, failures: 3, lastTested: now - DAY, lastSuccess: 0 };
  assert.ok(Core.shouldSkip(dead, now));
  assert.ok(!Core.shouldSkip({ ...dead, lastTested: now - 8 * DAY }, now), 'retenté après 7 jours');
  assert.ok(!Core.shouldSkip({ ...dead, successes: 1, lastSuccess: now - DAY, failures: 5 }, now), 'a marché récemment');
});

test('planCodes trie par efficacité et retire doublons + codes morts', () => {
  const now = Date.now();
  const stats = {
    GOOD: { successes: 3, failures: 0, lastTested: now, lastSuccess: now, bestSaving: 5 },
    DEAD: { successes: 0, failures: 4, lastTested: now, lastSuccess: 0 },
    MEH: { successes: 0, failures: 1, lastTested: now, lastSuccess: 0 }
  };
  const plan = Core.planCodes(['meh', 'NEWONE', 'DEAD', 'GOOD', 'good'], stats, now);
  assert.deepStrictEqual(plan.skipped, ['DEAD']);
  assert.deepStrictEqual(plan.toTest, ['GOOD', 'NEWONE', 'MEH']);
});

test('recordResult et pickBest', () => {
  const now = Date.now();
  let s = Core.recordResult(undefined, { ok: false, error: 'expiré' }, now);
  assert.strictEqual(s.failures, 1);
  s = Core.recordResult(s, { ok: true, saving: 3.456 }, now);
  assert.strictEqual(s.successes, 1);
  assert.strictEqual(s.bestSaving, 3.46);
  assert.strictEqual(s.lastError, '');
  const best = Core.pickBest([{ code: 'A', ok: true, saving: 2 }, { code: 'B', ok: false }, { code: 'C', ok: true, saving: 4 }]);
  assert.strictEqual(best.code, 'C');
  assert.strictEqual(Core.pickBest([{ code: 'A', ok: false }]), null);
});
