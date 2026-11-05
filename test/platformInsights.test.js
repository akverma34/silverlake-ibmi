const test = require('node:test');
const assert = require('node:assert');
const p = require('../out/core/platformInsights');

test('audit journal: SQL reads QAUDJRN, limits the hours', () => {
  const sql = p.auditActivitySql(24);
  assert.match(sql, /DISPLAY_JOURNAL\('QSYS', 'QAUDJRN'/);
  assert.match(sql, /JOURNAL_CODES => 'T'/);
  assert.match(sql, /CURRENT TIMESTAMP - 24 HOURS/);
  assert.match(p.auditActivitySql(9999), /- 168 HOURS/);
  assert.match(p.auditActivitySql(0), /- 24 HOURS/);
  assert.match(p.auditUsersSql(6, 10), /FETCH FIRST 10 ROWS/);
  const ev = p.auditEventsSql(24);
  assert.match(ev, /JOURNAL_ENTRY_TYPES => '[A-Z0-9 ]+'/);
  assert.match(ev, /\bAF\b/); assert.match(ev, /\bPW\b/); assert.match(ev, /\bSV\b/);
  assert.doesNotMatch(ev.match(/JOURNAL_ENTRY_TYPES => '([^']+)'/)[1], /\bZR\b|\bCO\b/, 'info entries are not listed as events');
});

test('audit journal: types and heat rows, alerts first', () => {
  assert.deepStrictEqual(p.auditType('af'), ['Authority failure', 'alert']);
  assert.deepStrictEqual(p.auditType('QQ'), ['Other entry', 'info']);
  const buckets = ['2026-11-05 12', '2026-11-05 13', '2026-11-05 14'];
  const h = p.auditHeat([
    { TYPE: 'ZR', HR: '2026-11-05 12', N: 500 }, { TYPE: 'AF', HR: '2026-11-05 13', N: 3 }, { TYPE: 'AF', HR: '2026-11-05 14', N: 2 },
    { TYPE: 'CA', HR: '2026-11-05 14', N: 7 }, { TYPE: 'PW', HR: '2026-11-05 14', N: 9 }, { TYPE: 'CO', HR: '2026-11-04 01', N: 99 },
  ], buckets);
  assert.deepStrictEqual(h.rows.map(r => r.type), ['PW', 'AF', 'CA', 'ZR']);
  assert.deepStrictEqual(h.rows[1].cells, [0, 3, 2]);
  assert.strictEqual(h.max, 500);
  assert.deepStrictEqual(h.bySeverity, { alert: 14, change: 7, info: 500 });
});

test('disk units: SQL, levels and ASP summary', () => {
  assert.match(p.diskUnitsSql(), /QSYS2\.SYSDISKSTAT/);
  assert.deepStrictEqual([50, 80, 89.9, 90, 99].map(p.fillLevel), ['ok', 'warn', 'warn', 'bad', 'bad']);
  assert.deepStrictEqual([10, 40, 60].map(p.busyLevel), ['ok', 'warn', 'bad']);
  const G = 1024 ** 3;
  const u = (asp, unit, cap, avail, pct, busy, ssd = false) => ({ asp, unit, resource: 'DMP00' + unit, type: '6B22', model: '050', ssd, capacity: cap * G, available: avail * G, pctUsed: pct, pctBusy: busy });
  const s = p.aspSummary([u(2, 5, 100, 50, 50, 5), u(1, 2, 100, 10, 90, 45, true), u(1, 1, 100, 40, 60, 10)]);
  assert.deepStrictEqual(s.map(a => a.asp), [1, 2]);
  assert.deepStrictEqual(s[0].units.map(x => x.unit), [1, 2]);
  assert.strictEqual(s[0].pctUsed, 75);
  assert.strictEqual(s[0].spread, 30);
  assert.strictEqual(s[0].busiest, 45);
  assert.strictEqual(s[0].ssd, 1);
  assert.strictEqual(p.sizeLabel(50 * G), '50.0 GB');
  assert.strictEqual(p.sizeLabel(250 * G), '250 GB');
  assert.strictEqual(p.sizeLabel(2048 * G), '2.00 TB');
});

test('embedded SQL statistics: names checked, columns whatever the release', () => {
  assert.match(p.programStatementsSql('mylib'), /PROGRAM_SCHEMA = 'MYLIB'$/);
  assert.match(p.programStatementsSql('MYLIB', 'pgm1'), /PROGRAM_NAME = 'PGM1'/);
  assert.throws(() => p.programStatementsSql("X'; DROP"), /not a valid library/);
  assert.throws(() => p.programStatementsSql('LIB', 'A B'), /not a valid program/);
  const r = p.statementStats([
    { PROGRAM_NAME: 'A', STATEMENT_NUMBER: 10, NUMBER_TIMES_EXECUTED: 100, TOTAL_ELAPSED_TIME: 50, STATEMENT_TEXT: 'SELECT *  FROM T' },
    { PROGRAM_NAME: 'B', STATEMENT_NUMBER: 20, NUMBER_TIMES_EXECUTED: 4, TOTAL_ELAPSED_TIME: 900, NUMBER_REBUILDS: 3, STATEMENT_TEXT: 'UPDATE T SET X = 1' },
    { PROGRAM_NAME: 'C', STATEMENT_NUMBER: 30, NUMBER_TIMES_EXECUTED: 0, STATEMENT_TEXT: 'DELETE FROM T' },
  ]);
  assert.ok(r.hasTimes);
  assert.deepStrictEqual(r.stats.map(s => s.program), ['B', 'A', 'C']);
  assert.strictEqual(r.stats[0].avgMs, 225);
  assert.strictEqual(r.stats[1].text, 'SELECT * FROM T');
  assert.deepStrictEqual(r.stats.map(p.statementHint), ['Access plan rebuilt on most runs', 'SELECT * reads every column', 'Never run since the statistics were collected']);
  const noTimes = p.statementStats([{ PROGRAM_NAME: 'X', NUMBER_TIMES_EXECUTED: 1 }, { PROGRAM_NAME: 'Y', NUMBER_TIMES_EXECUTED: 9 }]);
  assert.ok(!noTimes.hasTimes);
  assert.deepStrictEqual(noTimes.stats.map(s => s.program), ['Y', 'X']);
});

test('tasks: definition checked, variables expanded', () => {
  assert.deepStrictEqual(p.checkTask({ type: 'vanthrex', command: ' DSPLIBL ' }), { ok: true, task: { type: 'vanthrex', command: 'DSPLIBL', kind: 'cl', libraries: [] } });
  const ok = p.checkTask({ command: 'makei build', kind: 'pase', libraries: ['mylib'], cwd: '/home/me/proj' });
  assert.ok(ok.ok); assert.deepStrictEqual(ok.task.libraries, ['MYLIB']); assert.strictEqual(ok.task.cwd, '/home/me/proj');
  assert.strictEqual(p.checkTask({}).ok, false);
  assert.match(p.checkTask({ command: 'X', kind: 'sh' }).error, /kind/);
  assert.match(p.checkTask({ command: 'X', libraries: ['NOT VALID'] }).error, /libraries/);
  assert.match(p.checkTask({ command: 'X', cwd: 'relative' }).error, /cwd/);
  const vars = { CURLIB: 'DEV', USER: 'ME', ...p.fileVariables('src\\qrpglesrc\\ordentry.pgm.rpgle') };
  assert.deepStrictEqual(p.fileVariables('src/hello.rpgle'), { NAME: 'HELLO', EXT: 'RPGLE', FILENAME: 'hello.rpgle', RELATIVEPATH: 'src/hello.rpgle' });
  assert.strictEqual(vars.NAME, 'ORDENTRY'); assert.strictEqual(vars.EXT, 'PGM.RPGLE');
  assert.strictEqual(p.expandTaskVariables(`CRTBNDRPG PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') &UNKNOWN`, vars),
    `CRTBNDRPG PGM(DEV/ORDENTRY) SRCSTMF('src/qrpglesrc/ordentry.pgm.rpgle') &UNKNOWN`);
  assert.strictEqual(p.expandTaskVariables('&FILENAME', { NAME: 'X', FILENAME: 'x.rpgle' }), 'x.rpgle');
  assert.strictEqual(p.expandTaskVariables('&USERX', { USER: 'ME' }), '&USERX');
  assert.strictEqual(p.terminalText('a\nb\r\nc'), 'a\r\nb\r\nc');
});
