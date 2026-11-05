const test = require('node:test');
const assert = require('node:assert');
const d = require('../out/core/devInsights');

test('index advisor: SQL, keys, condensing and CREATE INDEX', () => {
  assert.match(d.indexAdviceSql('mylib'), /FROM QSYS2\.SYSIXADV WHERE SYSTEM_TABLE_SCHEMA = 'MYLIB' ORDER BY/);
  assert.match(d.indexAdviceSql('mylib', 'orders'), /SYSTEM_TABLE_NAME = 'ORDERS'/);
  assert.throws(() => d.indexAdviceSql("A'B"), /not a valid library/);
  assert.deepStrictEqual(d.adviceKeys('custno, orddate'), ['CUSTNO', 'ORDDATE']);
  assert.deepStrictEqual(d.adviceKeys('A B "Mixed Col"'), ['A', 'B', '"Mixed Col"']);
  const base = { schema: 'APP', table: 'ORDERS', type: 'RADIX', last: '2026-11-01 10:00', mti: 0, estSeconds: 1, reason: '' };
  const c = d.condenseAdvice([
    { ...base, keys: ['CUSTNO'], times: 10, avgQuerySeconds: 2 },
    { ...base, keys: ['CUSTNO', 'ORDDATE'], times: 5, avgQuerySeconds: 4, last: '2026-11-03 09:00' },
    { ...base, keys: ['STATUS'], times: 1, avgQuerySeconds: 1 },
    { ...base, keys: ['CUSTNO'], type: 'EVI', times: 2, avgQuerySeconds: 1 },
  ]);
  assert.strictEqual(c.length, 3);
  const top = c[0];
  assert.deepStrictEqual(top.keys, ['CUSTNO', 'ORDDATE']);
  assert.strictEqual(top.times, 15); assert.strictEqual(top.covers, 2);
  assert.ok(Math.abs(top.avgQuerySeconds - (4 * 5 + 2 * 10) / 15) < 1e-9);
  assert.strictEqual(top.last, '2026-11-03 09:00');
  assert.strictEqual(d.createIndexSql(top, 1), 'CREATE INDEX APP.ORDERS_IX1 ON APP.ORDERS (CUSTNO, ORDDATE)');
  assert.strictEqual(d.createIndexSql({ schema: 'APP', table: 'ORDERS', type: 'EVI', keys: ['STATUS'] }, 2), 'CREATE ENCODED VECTOR INDEX APP.ORDERS_EVI2 ON APP.ORDERS (STATUS)');
  assert.throws(() => d.createIndexSql({ schema: 'APP', table: 'T', type: 'RADIX', keys: ['A); DROP TABLE X; --'] }, 1), /Unexpected key/);
});

test('IFS space map: SQL, children and breadcrumb', () => {
  const sql = d.ifsSizesSql('/');
  assert.match(sql, /START_PATH_NAME => '\/'/);
  assert.match(sql, /OMIT_LIST => '\/QSYS\.LIB \/QNTC/);
  assert.doesNotMatch(d.ifsSizesSql('/QSYS.LIB/MYLIB.LIB'), /OMIT_LIST/);
  // Paths outside the start folder are refused by IBM i (SQL0443), so none are passed for a home folder.
  assert.doesNotMatch(d.ifsSizesSql('/home/GGUPTA'), /OMIT_LIST/);
  assert.match(d.ifsSizesSql('/home/me/'), /START_PATH_NAME => '\/home\/me'/);
  assert.match(d.ifsSizesSql("/it's"), /'\/it''s'/);
  assert.doesNotMatch(d.ifsSizesSql('/', 100, false), /OMIT_LIST/);
  assert.throws(() => d.normalizePath('/a/../etc'), /not a valid path/);
  assert.strictEqual(d.normalizePath('home//me/'), '/home/me');
  const files = [
    { path: '/home/me/a.txt', size: 10 }, { path: '/home/me/logs/x.log', size: 500 }, { path: '/home/me/logs/old/y.log', size: 300 },
    { path: '/home/me/src/p.rpgle', size: 50 }, { path: '/home/other/z', size: 999 },
  ];
  assert.deepStrictEqual(d.ifsChildren('/home/me', files), [
    { name: 'logs', path: '/home/me/logs', dir: true, size: 800, files: 2 },
    { name: 'src', path: '/home/me/src', dir: true, size: 50, files: 1 },
    { name: 'a.txt', path: '/home/me/a.txt', dir: false, size: 10, files: 1 },
  ]);
  assert.deepStrictEqual(d.ifsChildren('/', files).map(c => [c.name, c.size]), [['home', 1859]]);
  assert.deepStrictEqual(d.breadcrumb('/home/me').map(b => b.path), ['/', '/home', '/home/me']);
});

test('source change calendar: SQL, cells, levels and streaks', () => {
  const sql = d.memberChangesSql('applib', 'qrpglesrc');
  assert.match(sql, /SYSTEM_TABLE_SCHEMA = 'APPLIB' AND SYSTEM_TABLE_NAME = 'QRPGLESRC'/);
  assert.match(sql, /CURRENT TIMESTAMP - 371 DAYS/);
  const counts = new Map([['2026-11-05', 8], ['2026-11-04', 2], ['2026-11-03', 1], ['2026-10-01', 4], ['2024-01-01', 99]]);
  const { cells, months, max } = d.calendarCells(counts, '2026-11-05');
  assert.strictEqual(max, 8, 'old days outside the year are ignored');
  const last = cells[cells.length - 1];
  assert.strictEqual(last.day, '2026-11-05'); assert.strictEqual(last.col, 52); assert.strictEqual(last.row, 4, 'Thursday');
  assert.strictEqual(cells[0].row, 0, 'starts on a Sunday');
  assert.strictEqual(cells.length, 52 * 7 + 5);
  const lv = Object.fromEntries(cells.filter(c => c.count).map(c => [c.day, c.level]));
  assert.deepStrictEqual(lv, { '2026-11-05': 4, '2026-11-04': 1, '2026-11-03': 1, '2026-10-01': 2 });
  assert.ok(months.length >= 11 && months.length <= 13);
  assert.deepStrictEqual(d.streaks(counts, '2026-11-05'), { longest: 3, current: 3 });
  assert.deepStrictEqual(d.streaks(counts, '2026-11-07'), { longest: 3, current: 0 });
});
