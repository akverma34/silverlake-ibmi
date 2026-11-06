const test = require('node:test');
const assert = require('node:assert');
const s = require('../out/core/serviceInsights');

test('service SQL: only reads, job names are checked', () => {
  for (const [id, sql] of Object.entries(s.SERVICE_SQL)) { assert.match(sql, /^SELECT \* FROM /, id); assert.doesNotMatch(sql, /;|\b(DELETE|UPDATE|INSERT|CALL)\b/, id); }
  assert.strictEqual(s.jobServiceSql('openFiles', "1'; DROP TABLE X--"), undefined);
  assert.strictEqual(s.jobServiceSql('openFiles', 'QPADEV0001'), undefined);
  assert.strictEqual(s.jobServiceSql('openFiles', ' 123456/me/qpadev0001 '), "SELECT * FROM TABLE(QSYS2.OPEN_FILES(JOB_NAME => '123456/ME/QPADEV0001')) X");
  assert.match(s.jobServiceSql('ifsObjects', '123456/ME/J'), /IFS_JOB_INFO/);
  assert.match(s.jobServiceSql('dbConnections', '123456/ME/J'), /ACTIVE_DB_CONNECTIONS/);
  assert.ok(s.isJobName('000001/QUSER/QZDASOINIT') && !s.isJobName('QZDASOINIT'));
});

test('cells, columns, tables and attributes', () => {
  assert.strictEqual(s.prettyColumn('SUBSYSTEM_DESCRIPTION'), 'Subsystem description');
  assert.strictEqual(s.cellText('2026-11-05-10.20.30.123456'), '2026-11-05 10:20:30');
  assert.strictEqual(s.cellText(new Date('2026-11-05T10:20:30Z')), '2026-11-05 10:20:30');
  assert.strictEqual(s.cellText(null), '');
  assert.strictEqual(s.cellText('  ABC  '), 'ABC');
  assert.strictEqual(s.pick({ A: '', B: ' x ' }, 'A', 'B'), 'x');
  const rows = [{ A: 1, B: null, C: 'x', D: '' }, { A: 2, B: '', C: 'y', D: null }];
  assert.deepStrictEqual(s.tableFrom(rows), { keys: ['A', 'C'], columns: ['A', 'C'], rows: [['1', 'x'], ['2', 'y']] });
  assert.deepStrictEqual(s.tableFrom(rows, ['C', 'Z']).keys, ['C']);
  assert.deepStrictEqual(s.tableFrom(rows, ['Z']).keys, ['A', 'C'], 'no preferred column there: the first columns');
  assert.deepStrictEqual(s.tableFrom(rows, [], 1).keys, ['A']);
  assert.deepStrictEqual(s.attributes([{ HOST_NAME: 'MYSYS', DOMAIN_NAME: null, PORT: 23 }]), [['Host name', 'MYSYS'], ['Port', '23']]);
  assert.deepStrictEqual(s.attributes([]), []);
});

test('flags, subsystem filter, ended jobs and temporary storage', () => {
  assert.strictEqual(s.FLAGS.configStatus({ NAME: 'ETHLINE', STATUS: 'FAILED' }), 'bad');
  assert.strictEqual(s.FLAGS.configStatus({ NAME: 'ETHLINE', STATUS: 'ACTIVE' }), undefined);
  assert.strictEqual(s.FLAGS.configStatus({ NAME: 'DSP01', STATUS: 'SIGNON DISPLAY' }), 'different');
  assert.strictEqual(s.FLAGS.cves({ CVE: 'CVE-2026-1', STATUS: 'NOT INSTALLED' }), 'bad');
  assert.strictEqual(s.FLAGS.hardware({ STATUS: 'NOT DETECTED' }), 'bad');
  const rows = [{ SUBSYSTEM_DESCRIPTION_LIBRARY: 'QSYS', SUBSYSTEM_DESCRIPTION: 'QBATCH', SEQ: 10 }, { SUBSYSTEM_DESCRIPTION_LIBRARY: 'QBATCH', SUBSYSTEM_DESCRIPTION: 'QINTER', SEQ: 20 }];
  assert.deepStrictEqual(s.bySubsystem(rows, 'qbatch').map(r => r.SEQ), [10], 'the library column does not count');
  assert.strictEqual(s.bySubsystem(rows, '').length, 2);
  assert.deepStrictEqual([{ JOB_END_CODE: 0 }, { JOB_END_CODE: 20 }, { JOB_END_CODE: 40 }, { X: 'ended ABNORMALLY' }].map(s.endedJobFlag), [undefined, 'different', 'bad', 'bad']);
  assert.deepStrictEqual(s.tempStorageTop([{ N: 'a', BUCKET_CURRENT_SIZE: 5 }, { N: 'b', BUCKET_CURRENT_SIZE: 50 }, { N: 'c' }], 2).map(r => r.N), ['b', 'a']);
});
