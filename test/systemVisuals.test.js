const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/systemVisuals');

test('active jobs map: SQL, states and grouping', () => {
  const sql = v.activeJobsMapSql(100);
  assert.match(sql, /ACTIVE_JOB_INFO\(DETAILED_INFO => 'NONE'\)/);
  assert.doesNotMatch(sql, /RESET_STATISTICS/);
  assert.match(sql, /FETCH FIRST 100 ROWS/);
  assert.deepStrictEqual(['MSGW', 'RUN', 'LCKW', 'DEQW', 'TIMW', 'HLD', 'xyz', ' msgw '].map(v.jobState), ['reply', 'running', 'lock', 'waiting', 'waiting', 'held', 'other', 'reply']);
  const j = (job, subsystem, status, cpuMs, tempMb) => ({ job, subsystem, user: 'U', type: 'BCH', status, fn: '', cpuMs, tempMb, threads: 1, io: 0 });
  const g = v.jobsBySubsystem([j('1/U/A', 'QBATCH', 'RUN', 500, 10), j('2/U/B', 'QBATCH', 'MSGW', 900, 5), j('3/U/C', 'QINTER', 'DSPW', 100, 50), j('4/QSYS/D', '', 'EVTW', 50, 1)], 'cpu');
  assert.deepStrictEqual(g.map(x => [x.subsystem, x.value, x.replies, x.jobs.map(y => y.job.split('/')[2]).join('')]), [['QBATCH', 1400, 1, 'BA'], ['QINTER', 100, 0, 'C'], ['(none)', 50, 0, 'D']]);
  assert.strictEqual(v.jobsBySubsystem([j('3/U/C', 'QINTER', 'DSPW', 100, 50), j('1/U/A', 'QBATCH', 'RUN', 500, 10)], 'temp')[0].subsystem, 'QINTER');
});

test('journal heat map: SQL, buckets, rows and levels', () => {
  const sql = v.journalActivitySql('applib', 'appjrn', 999);
  assert.match(sql, /DISPLAY_JOURNAL\('APPLIB', 'APPJRN'/);
  assert.match(sql, /CURRENT TIMESTAMP - 168 HOURS/);
  assert.match(sql, /JOURNAL_ENTRY_TYPES => 'PT PX UP DL DR'/);
  assert.throws(() => v.journalActivitySql("A'", 'J', 1), /not a valid library/);
  const b = v.hourBuckets('2026-11-05 02', 4);
  assert.deepStrictEqual(b, ['2026-11-04 23', '2026-11-05 00', '2026-11-05 01', '2026-11-05 02']);
  const h = v.journalHeat([
    { OBJ: 'APP/ORDERS', HR: '2026-11-05 00', INS: 10, UPD: 5, DEL: 0 },
    { OBJ: 'APP/ORDERS', HR: '2026-11-05 02', INS: 1, UPD: 0, DEL: 1 },
    { OBJ: 'APP/ITEMS', HR: '2026-11-04 23', INS: 0, UPD: 3, DEL: 0 },
    { OBJ: 'APP/OLD', HR: '2026-11-01 10', INS: 99, UPD: 0, DEL: 0 },
    { OBJ: 'APP/LOG', HR: '2026-11-05 01', INS: 1, UPD: 0, DEL: 0 },
  ], b, 2);
  assert.deepStrictEqual(h.rows.map(r => [r.table, r.total, r.ins, r.upd, r.del, r.cells.join(' ')]), [['APP/ORDERS', 17, 11, 5, 1, '0 15 0 2'], ['APP/ITEMS', 3, 0, 3, 0, '3 0 0 0']]);
  assert.strictEqual(h.max, 15); assert.strictEqual(h.others, 1);
  assert.deepStrictEqual([0, 1, 4, 15, 30].map(x => v.heatLevel(x, 15)), [0, 2, 3, 5, 5]);
  assert.strictEqual(v.heatLevel(5, 0), 0);
});
