const test = require('node:test');
const assert = require('node:assert');
const h = require('../out/core/healthOverview');
const s = require('../out/core/healthInsights');
const p = require('../out/core/platformInsights');

const unit = (asp, n, pct) => ({ asp, unit: n, resource: 'DMP' + n, type: '59E0', model: '060', ssd: false, capacity: 100e9, available: (100 - pct) * 1e9, pctUsed: pct, pctBusy: 5 });

test('overall level: the worst known card wins, unknown cards are left out', () => {
  assert.strictEqual(h.overallLevel([{ level: 'ok' }, { level: 'warn' }, { level: 'unknown' }]), 'warn');
  assert.strictEqual(h.overallLevel([{ level: 'ok' }, { level: 'bad' }, { level: 'warn' }]), 'bad');
  assert.strictEqual(h.overallLevel([{ level: 'unknown' }]), 'unknown');
  assert.strictEqual(h.overallLevel([{ level: 'ok' }, { level: 'unknown' }]), 'ok');
});

test('disk card: the fullest ASP decides, uneven units are worth a look', () => {
  assert.strictEqual(h.diskCard(p.aspSummary([unit(1, 1, 50), unit(1, 2, 52)])).level, 'ok');
  assert.strictEqual(h.diskCard(p.aspSummary([unit(1, 1, 85), unit(1, 2, 85)])).level, 'warn');
  const bad = h.diskCard(p.aspSummary([unit(1, 1, 50), unit(2, 2, 95)]));
  assert.strictEqual(bad.level, 'bad'); assert.strictEqual(bad.value, '95 %');
  const uneven = h.diskCard(p.aspSummary([unit(1, 1, 40), unit(1, 2, 70)]));
  assert.strictEqual(uneven.level, 'warn');
  assert.ok(uneven.detail.some(d => /STRASPBAL/.test(d.text)));
  assert.strictEqual(h.diskCard([]).level, 'unknown');
});

test('limits, locks, replies and security cards', () => {
  const lim = (pct) => ({ category: 'DB', limit: 'Rows in a table', current: pct, maximum: 100, pct, where: 'APP/ORDERS', job: '', user: '', changed: '' });
  assert.strictEqual(h.limitsCard([lim(10)]).level, 'ok');
  assert.strictEqual(h.limitsCard([lim(80), lim(10)]).value, '1');
  assert.strictEqual(h.limitsCard([lim(95)]).level, 'bad');
  assert.deepStrictEqual(h.limitsCard([lim(80)]).detail[0], { text: '{0}: {1} %', args: ['Rows in a table (APP/ORDERS)', 80] });

  const row = (job, status, rrn = null) => ({ LIB: 'APP', OBJ: 'ORDERS', TYPE: '*FILE', MBR: 'ORDERS', RRN: rrn, STATE: '*SHRUPD', STATUS: status, SCOPE: 'JOB', JOB: job });
  assert.strictEqual(h.locksCard(s.lockChains([])).level, 'ok');
  const one = h.locksCard(s.lockChains([row('100001/A/HOLD', 'HELD', 7), row('100002/B/WAIT', 'WAITING', 7)]));
  assert.strictEqual(one.level, 'warn'); assert.strictEqual(one.value, '1');
  assert.deepStrictEqual(one.detail[1], { text: 'Head blocker {0} blocks {1} job(s).', args: ['100001/A/HOLD', 1] });
  const many = h.locksCard(s.lockChains([row('100001/A/HOLD', 'HELD', 7), ...[2, 3, 4].map(i => row(`10000${i}/B/W${i}`, 'WAITING', 7))]));
  assert.strictEqual(many.level, 'bad');

  assert.strictEqual(h.repliesCard([]).level, 'ok');
  const r = h.repliesCard(['1/A/X', '2/A/Y', '3/A/Z', '4/A/W']);
  assert.strictEqual(r.level, 'bad'); assert.strictEqual(r.detail.length, 4); assert.deepStrictEqual(r.detail[3], { text: 'and {0} more', args: [1] });
  assert.match(h.msgwJobsSql(), /JOB_STATUS = 'MSGW'/);

  const checks = s.securityChecks({ QSECURITY: '30', QPWDLVL: '0', QPWDEXPITV: '*NOMAX', QPWDMINLEN: '6' });
  const sec = h.securityCard(s.securityScore(checks), checks);
  assert.strictEqual(sec.level, 'bad'); assert.ok(sec.detail.some(d => d.args[0] === 'QSECURITY'));
  assert.strictEqual(h.securityCard(0, []).level, 'unknown');
  const good = s.securityChecks({ QSECURITY: '50', QPWDLVL: '3', QPWDEXPITV: '60', QPWDMINLEN: '12' });
  assert.strictEqual(h.securityCard(s.securityScore(good), good).level, 'ok');
});

test('security scorecard as Markdown', () => {
  const checks = s.securityChecks({ QSECURITY: '30', QPWDLVL: '3' });
  const md = h.scorecardMarkdown('DEV|400', '2026-11-06 10:00', 55, checks, { enabled: 12, allObj: ['ADMIN'], oldPasswords: [], idle: ['OLDUSER'] });
  assert.match(md, /^# Security scorecard — DEV\\\|400/);
  assert.match(md, /score \*\*55 \/ 100\*\* \(grade D\)/);
  assert.ok(md.indexOf('| Risk |') < md.indexOf('| OK |'), 'risks first');
  assert.match(md, /Enabled with \*ALLOBJ \(1\):\*\* `ADMIN`/);
  assert.match(md, /Password older than a year \(0\):\*\* none/);
  assert.doesNotMatch(h.scorecardMarkdown('X', 'now', 90, checks), /User profiles/);
});
