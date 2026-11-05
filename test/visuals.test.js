const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/visuals');

test('space map: SQL, groups, age bands and summary', () => {
  const sql = v.spaceMapSql(' mylib ');
  assert.match(sql, /OBJECT_STATISTICS\('MYLIB', '\*ALL'\)/);
  assert.match(sql, /FILE_TYPE = 'S'/);
  assert.throws(() => v.spaceMapSql("x'; DROP"), /not a valid library/);
  assert.strictEqual(v.spaceGroup('*PGM', 'RPGLE'), 'Programs');
  assert.strictEqual(v.spaceGroup('*FILE', 'SAVF'), 'Save files');
  assert.strictEqual(v.spaceGroup('*FILE', 'PF-SRC'), 'Source files');
  assert.strictEqual(v.spaceGroup('*FILE', 'LF'), 'Files');
  assert.strictEqual(v.spaceGroup('*JRNRCV', ''), 'Journals');
  assert.strictEqual(v.spaceGroup('*DTAQ', ''), 'Data');
  assert.strictEqual(v.spaceGroup('*OUTQ', ''), 'Other');
  assert.deepStrictEqual([5, 100, 300, 400, undefined].map(v.ageBand), [0, 1, 2, 3, 3]);
  const s = v.spaceSummary([
    { name: 'A', type: '*PGM', attribute: '', size: 10, text: '' },
    { name: 'B', type: '*FILE', attribute: 'PF', size: 50, text: '' },
    { name: 'C', type: '*SRVPGM', attribute: '', size: 15, text: '' },
  ]);
  assert.deepStrictEqual(s, [{ group: 'Files', size: 50, count: 1 }, { group: 'Programs', size: 25, count: 2 }]);
});

test('space map: squarified treemap fills the area exactly, in input order', () => {
  const vals = [6, 6, 4, 3, 2, 2, 1, 0];
  const r = v.squarify(vals, 0, 0, 600, 400);
  assert.strictEqual(r.length, vals.length);
  const total = vals.reduce((a, b) => a + b, 0);
  vals.forEach((val, i) => assert.ok(Math.abs(r[i].w * r[i].h - (val / total) * 600 * 400) < 1e-6, `area ${i}`));
  assert.deepStrictEqual([r[7].w, r[7].h], [0, 0]);
  for (const x of r) { assert.ok(x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= 600 + 1e-6 && x.y + x.h <= 400 + 1e-6); }
  for (let i = 0; i < 7; i++) { for (let j = i + 1; j < 7; j++) {
    const a = r[i]; const b = r[j];
    const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    assert.ok(overlap < 1e-6, `${i}/${j} overlap`);
  } }
  assert.deepStrictEqual(v.squarify([], 0, 0, 10, 10), []);
  assert.deepStrictEqual(v.squarify([5], 0, 0, 0, 10), [{ x: 0, y: 0, w: 0, h: 0 }]);
});

test('job timeline: SQL, lanes, states and ticks', () => {
  const sql = v.timelineSql(24, { user: 'qsecofr', jobName: 'ORD*' });
  assert.match(sql, /CURRENT TIMESTAMP - 24 HOURS/);
  assert.match(sql, /LIKE '%\/QSECOFR\/ORD%'/);
  assert.match(v.timelineSql(99999), /- 744 HOURS/);
  assert.throws(() => v.timelineSql(1, { jobName: "A'B" }), /not a valid job/);
  const start = v.tsMillis('2026-11-04 00:00:00'); const end = v.tsMillis('2026-11-04 10:00:00');
  const runs = [
    { job: '1/U/A', started: '2026-11-04 01:00:00', ended: '2026-11-04 03:00:00', ok: true },
    { job: '2/U/B', started: '2026-11-04 02:00:00', ended: '2026-11-04 04:00:00', ok: false },
    { job: '3/U/C', started: '2026-11-04 05:00:00', ended: '2026-11-04 05:00:00', ok: true },
    { job: '4/U/D', started: '2026-11-04 09:00:00' },
    { job: '5/U/E', ended: '2026-11-04 00:30:00', ok: true },
    { job: '6/U/F', started: '2026-11-03 01:00:00', ended: '2026-11-03 02:00:00', ok: true },
  ];
  const { bars, lanes } = v.timelineLayout(runs, start, end, 1000);
  assert.deepStrictEqual(bars.map(b => b.name), ['E', 'A', 'B', 'C', 'D']);
  assert.strictEqual(lanes, 2);
  const by = Object.fromEntries(bars.map(b => [b.name, b]));
  assert.strictEqual(by.A.lane, 0); assert.strictEqual(by.B.lane, 1); assert.strictEqual(by.C.lane, 0);
  assert.strictEqual(by.A.x, 100); assert.strictEqual(by.A.w, 200);
  assert.strictEqual(by.C.w, 3, 'min width');
  assert.strictEqual(by.D.state, 'running'); assert.strictEqual(by.D.x + by.D.w, 1000);
  assert.strictEqual(by.B.state, 'failed'); assert.strictEqual(by.E.x, 0);
  const t = v.timeTicks(start, end, 1000);
  assert.strictEqual(t[0].label, '2026-11-04'); assert.ok(t[0].day);
  assert.ok(t.length <= 12 && t.length >= 5);
  assert.strictEqual(v.timeTicks(start, start + 7 * 86400000, 700).every(x => x.day), true);
});

test('timeline: _ in a job name is matched literally, * is the wildcard', () => {
  const sql = v.timelineSql(24, { jobName: 'ORD_EXT*', user: 'BATCH_1' });
  assert.match(sql, /LIKE '%\/BATCH\\_1\/ORD\\_EXT%' ESCAPE '\\'/);
  assert.match(v.timelineSql(24), /LIKE '%\/%\/%' ESCAPE/);
});

test('space map: an object never used counts from its creation date', () => {
  assert.strictEqual(v.idleDays({ lastUsedDays: 400, createdDays: 900 }), 400);
  assert.strictEqual(v.idleDays({ lastUsedDays: undefined, createdDays: 5 }), 5);
  assert.strictEqual(v.ageBand(v.idleDays({ createdDays: 5 })), 0);
  assert.strictEqual(v.ageBand(v.idleDays({})), 3);
  assert.match(v.spaceMapSql('LIB'), /OBJCREATED/);
});
