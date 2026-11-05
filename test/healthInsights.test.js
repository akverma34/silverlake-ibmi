const test = require('node:test');
const assert = require('node:assert');
const h = require('../out/core/healthInsights');

const lock = (OBJ, STATUS, JOB, STATE = '*EXCL', RRN = null, MBR = '') => ({ LIB: 'APP', OBJ, TYPE: '*FILE', MBR, RRN, STATE, STATUS, SCOPE: 'JOB', JOB });

test('lock waits: SQL only reads contended objects and rows', () => {
  assert.match(h.objectLockWaitsSql(), /OBJECT_LOCK_INFO[\s\S]*LOCK_STATUS = 'WAITING'/);
  assert.match(h.rowLockWaitsSql(), /RECORD_LOCK_INFO[\s\S]*RELATIVE_RECORD_NUMBER/);
  assert.strictEqual(h.lockJobsSql([]), undefined);
  assert.strictEqual(h.lockJobsSql(["1'; DROP TABLE X--"]), undefined);
  assert.match(h.lockJobsSql(['123456/ME/QPADEV0001', '123456/ME/QPADEV0001', 'bad']), /JOB_NAME IN \('123456\/ME\/QPADEV0001'\)$/);
});

test('lock waits: contention, chains and head blockers', () => {
  assert.strictEqual(h.lockResource(lock('ORDERS', 'HELD', 'J', '*SHRRD', 42, 'ORDERS')), 'APP/ORDERS *FILE (ORDERS) row 42');
  // A holds ORDERS; B waits for ORDERS and holds STOCK; C and D wait for STOCK. E holds ITEMS, nobody waits.
  const r = h.lockChains([
    lock('ORDERS', 'HELD', '000001/U/A'), lock('ORDERS', 'WAITING', '000002/U/B'),
    lock('STOCK', 'HELD', '000002/U/B'), lock('STOCK', 'WAITING', '000003/U/C'), lock('STOCK', 'WAITING', '000004/U/D'),
    lock('ITEMS', 'HELD', '000005/U/E'), lock('STOCK', 'WAITING', '000003/U/C'),
  ]);
  assert.deepStrictEqual(r.contention.map(c => c.resource), ['APP/STOCK *FILE', 'APP/ORDERS *FILE']);
  assert.strictEqual(r.contention[0].waiters.length, 2, 'duplicate rows are merged');
  assert.strictEqual(r.waiting, 3);
  assert.deepStrictEqual(r.heads, [{ job: '000001/U/A', blocks: 3, resources: ['APP/ORDERS *FILE'] }]);
});

test('lock waits: a deadlock has no head blocker, nothing waiting gives nothing', () => {
  const d = h.lockChains([lock('X', 'HELD', '000001/U/A'), lock('X', 'WAITING', '000002/U/B'), lock('Y', 'HELD', '000002/U/B'), lock('Y', 'WAITING', '000001/U/A')]);
  assert.strictEqual(d.waiting, 2);
  assert.deepStrictEqual(d.heads, []);
  assert.deepStrictEqual(h.lockChains([lock('X', 'HELD', '000001/U/A')]), { contention: [], heads: [], waiting: 0 });
});

test('limits watch: latest value per limit, closest first', () => {
  assert.match(h.limitsSql(10), /QSYS2\.SYSLIMITS ORDER BY LAST_CHANGE_TIMESTAMP DESC FETCH FIRST 10 ROWS/);
  const u = h.limitUses([
    { LIMIT_CATEGORY: 'DATABASE', LIMIT_DESCRIPTION: 'Maximum number of all rows in a partition', CURRENT_VALUE: 3000000000, MAXIMUM_VALUE: 4294967288, SYSTEM_SCHEMA_NAME: 'APP', SYSTEM_OBJECT_NAME: 'HIST', SYSTEM_TABLE_MEMBER: 'HIST', OBJECT_TYPE: '*FILE', LAST_CHANGE_TIMESTAMP: '2026-11-01-10.00.00' },
    { LIMIT_CATEGORY: 'DATABASE', LIMIT_DESCRIPTION: 'Maximum number of all rows in a partition', CURRENT_VALUE: 4000000000, MAXIMUM_VALUE: 4294967288, SYSTEM_SCHEMA_NAME: 'APP', SYSTEM_OBJECT_NAME: 'HIST', SYSTEM_TABLE_MEMBER: 'HIST', OBJECT_TYPE: '*FILE', LAST_CHANGE_TIMESTAMP: '2026-11-04-10.00.00' },
    { LIMIT_CATEGORY: 'WORK MANAGEMENT', LIMIT_DESCRIPTION: 'Maximum number of locks per job', CURRENT_VALUE: 100000, MAXIMUM_VALUE: 400000, JOB_NAME: '123456/U/BIGJOB', USER_NAME: 'U', LAST_CHANGE_TIMESTAMP: '2026-11-05-09.00.00' },
    { LIMIT_CATEGORY: 'FILE SYSTEM', LIMIT_DESCRIPTION: 'Maximum number of objects in a directory', CURRENT_VALUE: 900000, MAXIMUM_VALUE: 1000000, IFS_PATH_NAME: '/logs', LAST_CHANGE_TIMESTAMP: '2026-11-05-08.00.00' },
    { LIMIT_CATEGORY: 'X', LIMIT_DESCRIPTION: 'No maximum', CURRENT_VALUE: 5, MAXIMUM_VALUE: 0 },
  ]);
  assert.deepStrictEqual(u.map(x => x.pct), [93.1, 90, 25]);
  assert.strictEqual(u[0].where, 'APP/HIST (HIST) *FILE');
  assert.strictEqual(u[1].where, '/logs');
  assert.strictEqual(u[2].job, '123456/U/BIGJOB');
  assert.deepStrictEqual([50, 75, 90].map(h.limitLevel), ['ok', 'warn', 'bad']);
});

test('security scorecard: checks, profiles and score', () => {
  assert.match(h.securityValuesSql(), /SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME IN \('QSECURITY'/);
  const strong = h.securityChecks({ QSECURITY: '50', QPWDLVL: '3', QPWDEXPITV: '60', QPWDMINLEN: '10', QMAXSIGN: '3', QMAXSGNACN: '3', QINACTITV: '30', QAUDCTL: '*AUDLVL *OBJAUD', QLMTSECOFR: '1', QCRTAUT: '*USE', QALWOBJRST: '*NONE', QVFYOBJRST: '3', QDSPSGNINF: '1', QAUTOVRT: '0' });
  assert.strictEqual(strong.length, 14);
  assert.ok(strong.every(c => c.state === 'pass'));
  assert.strictEqual(h.securityScore(strong), 100);
  const weak = h.securityChecks({ QSECURITY: '30', QPWDEXPITV: '*NOMAX', QMAXSIGN: '*NOMAX', QAUDCTL: '*NONE', QCRTAUT: '*CHANGE' });
  assert.deepStrictEqual(weak.map(c => [c.id, c.state]), [['QSECURITY', 'fail'], ['QPWDEXPITV', 'fail'], ['QMAXSIGN', 'fail'], ['QAUDCTL', 'fail'], ['QCRTAUT', 'warn']]);
  assert.strictEqual(h.securityScore(weak), 7);
  assert.strictEqual(h.securityScore([]), 0);
  const p = h.profileFindings([
    { USR: 'ADMIN', SPC: '*ALLOBJ *SECADM', NOPWD: 'NO', PWDAGE: 10, IDLE: 1, CLS: '*SECOFR' },
    { USR: 'QSECOFR', SPC: '*ALLOBJ', NOPWD: 'NO', PWDAGE: 900, IDLE: 900, CLS: '*SECOFR' },
    { USR: 'OLDGUY', SPC: '', NOPWD: 'NO', PWDAGE: 400, IDLE: 200, CLS: '*USER' },
    { USR: 'GRPPROF', SPC: '', NOPWD: 'YES', PWDAGE: -1, IDLE: -1, CLS: '*USER' },
  ]);
  assert.deepStrictEqual(p, { enabled: 4, allObj: ['ADMIN'], oldPasswords: ['OLDGUY'], idle: ['OLDGUY'] });
  assert.strictEqual(h.securityScore(strong, p), 88);
  assert.deepStrictEqual([95, 80, 60, 45, 10].map(h.scoreGrade), ['A', 'B', 'C', 'D', 'E']);
});
