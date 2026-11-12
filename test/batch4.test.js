const test = require('node:test');
const assert = require('node:assert');
const r = require('../out/rpg/rpgRecipes');
const q = require('../out/core/sqlRecipes');
const c = require('../out/core/clRecipes');
const sc = require('../out/core/systemChecks');

test('RPG recipes', () => {
  const src = [
    'exec sql set option commit = *none;',
    'exec sql declare c1 cursor for select * from t;',
    '  exec sql update orders',
    '    set status = :st where ordno = :n;',
    '  exec sql delete from t where k = :k;',
    '  if sqlcode < 0;',
    '  endif;',
  ].join('\n');
  const res = r.addSqlStateChecks(src);
  assert.strictEqual(res.added, 1);
  assert.match(res.text, /set status = :st where ordno = :n;\n {2}if %subst\(sqlstate: 1: 2\) > '02';\n[^\n]*\n {2}endif;\n {2}exec sql delete/);
  assert.strictEqual(r.addSqlStateChecks(res.text).added, 0);
  assert.match(r.getDiagnostics(), /get diagnostics condition 1 :sqlMessage = message_text/);
  const sp = r.splitText('line', ',');
  assert.match(sp, /at = %scan\(',': rest: startAt\);/);
  assert.match(sp, /startAt = at \+ 1;/);
  assert.throws(() => r.splitText('1bad'), /variable/);
  assert.match(r.forEachLoop('codes'), /dcl-s codesItem like\(codes\);[\s\S]*for-each codesItem in codes;/);
  assert.match(r.sortDsArray('orders', 'total'), /^sorta orders\(\*\)\.total;/);
  assert.match(r.monthBounds('d'), /firstDay = d - %days\(%subdt\(d: \*days\) - 1\);\nlastDay = firstDay \+ %months\(1\) - %days\(1\);/);
  assert.match(r.dateDifference('a', 'b'), /yearsBetween = %diff\(b: a: \*years\);/);
  assert.match(r.sendMessage("It's done"), /^snd-msg 'It''s done';/);
  assert.match(r.multiRowFetch('select a, b from t;'), /declare rowsCur cursor for\n {2}select a, b from t\n {2}for read only;[\s\S]*for 100 rows into :rows;/);
  assert.match(r.objectExists('applib', 'pgm1', 'pgm'), /object_statistics\('APPLIB', '\*PGM'\)\) o\n {2}where o\.objname = 'PGM1';/);
  assert.throws(() => r.objectExists('*LIBL', 'X', '1'), /object type/);
});

test('SQL recipes', () => {
  const sel = 'SELECT CUSTNO, ORDDATE, AMOUNT FROM APPLIB.ORDERS;';
  assert.match(q.topPerGroup(sel, 'custno', 'orddate desc', 2), /ROW_NUMBER\(\) OVER \(PARTITION BY CUSTNO ORDER BY ORDDATE DESC\) AS RN[\s\S]*WHERE RN <= 2/);
  assert.throws(() => q.topPerGroup('DELETE FROM T', 'A', 'B'), /SELECT/);
  assert.match(q.runningTotal(sel, 'amount', 'orddate', 'custno'), /SUM\(AMOUNT\) OVER \(PARTITION BY CUSTNO ORDER BY ORDDATE ROWS UNBOUNDED PRECEDING\) AS RUNNING_TOTAL[\s\S]*ORDER BY CUSTNO, ORDDATE$/);
  assert.match(q.previousRow(sel, 'amount', 'orddate'), /LAG\(AMOUNT\) OVER \(ORDER BY ORDDATE\) AS PREVIOUS_AMOUNT,\n\s+AMOUNT - LAG/);
  assert.match(q.percentOfTotal(sel, 'amount'), /NULLIF\(SUM\(AMOUNT\) OVER \(\), 0\)/);
  const pv = q.pivot(sel, 'custno', 'status', "O, it's, 3", 'amount');
  assert.match(pv, /SUM\(CASE WHEN STATUS = 'O' THEN AMOUNT ELSE 0 END\) AS "O"/);
  assert.match(pv, /STATUS = 'it''s' THEN AMOUNT ELSE 0 END\) AS "IT'S"/);
  assert.match(pv, /STATUS = 3 THEN/);
  assert.match(q.valueList(sel, 'custno', 'orddate'), /LISTAGG\(CAST\(ORDDATE AS VARCHAR\(1000\)\), ', '\) WITHIN GROUP \(ORDER BY ORDDATE\) AS ORDDATE_LIST/);
  assert.match(q.compareTables(sel, 'testlib.orders'), /SELECT \* FROM APPLIB\.ORDERS EXCEPT SELECT \* FROM TESTLIB\.ORDERS/);
  const dd = q.deleteDuplicates(sel, 'custno, orddate');
  assert.match(dd, /B\.CUSTNO = A\.CUSTNO AND B\.ORDDATE = A\.ORDDATE/);
  assert.match(dd, /^-- 1\.[\s\S]*;\n\n-- 2\.[\s\S]*DELETE FROM APPLIB\.ORDERS A/);
  assert.match(q.numberGaps('SELECT * FROM INV', 'invno'), /LEAD\(INVNO\) OVER \(ORDER BY INVNO\) AS NEXT_N\n\s+FROM INV/);
  assert.match(q.hierarchy('applib.emp', 'empno', 'mgr'), /JOIN APPLIB\.EMP C ON C\.MGR = TREE\.ID/);
  assert.throws(() => q.hierarchy('x', 'a b', 'c'), /column/);
});

test('CL recipes', () => {
  assert.match(c.clObjectLoop('applib', 'pgm'), /DSPOBJD OBJ\(APPLIB\/\*ALL\) OBJTYPE\(\*PGM\) OUTPUT\(\*OUTFILE\) OUTFILE\(QTEMP\/OBJLIST\)/);
  assert.match(c.clMemberLoop('applib/qrpglesrc'), /DSPFD FILE\(APPLIB\/QRPGLESRC\) TYPE\(\*MBRLIST\)/);
  assert.match(c.clMemberLoop('qclsrc'), /FILE\(\*LIBL\/QCLSRC\)/);
  assert.match(c.clQshCommand("echo 'hi'"), /QSH CMD\('echo ''hi'''\)/);
  const sw = c.clLibraryListSwap('applib, appdta qgpl');
  assert.match(sw, /CHGLIBL LIBL\(APPLIB APPDTA QGPL\)/);
  assert.match(sw, /CALL PGM\(QCMDEXC\) PARM\(&CMD 2800\)$/);
  assert.throws(() => c.clLibraryListSwap(' '), /libraries/);
});

test('System checks', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const b = sc.backupFreshness([
    { OBJNAME: 'NEVER', SAVE_TIMESTAMP: null },
    { OBJNAME: 'OLD', SAVE_TIMESTAMP: '2026-09-01-10.00.00.000000' },
    { OBJNAME: 'WEEK', SAVE_TIMESTAMP: '2026-11-01 10:00:00' },
    { OBJNAME: 'FRESH', SAVE_TIMESTAMP: new Date('2026-11-11T22:00:00Z') },
  ], now, 7);
  assert.deepStrictEqual(b.map(x => [x.library, x.level, x.days]), [['NEVER', 'high', null], ['OLD', 'high', 72], ['WEEK', 'medium', 11], ['FRESH', 'info', 0]]);

  const so = sc.signonProblems([
    { AUTHORIZATION_NAME: 'LOCKED', STATUS: '*DISABLED', SIGN_ON_ATTEMPTS_NOT_VALID: 3 },
    { AUTHORIZATION_NAME: 'OFF', STATUS: '*DISABLED', SIGN_ON_ATTEMPTS_NOT_VALID: 0 },
    { AUTHORIZATION_NAME: 'TRIES', STATUS: '*ENABLED', SIGN_ON_ATTEMPTS_NOT_VALID: 1 },
    { AUTHORIZATION_NAME: 'EXPIRED', STATUS: '*ENABLED', DATE_PASSWORD_EXPIRES: '2026-11-01 00:00:00' },
    { AUTHORIZATION_NAME: 'SOON', STATUS: '*ENABLED', DATE_PASSWORD_EXPIRES: '2026-11-15 13:00:00', USER_EXPIRATION_DATE: '2026-11-20 00:00:00' },
    { AUTHORIZATION_NAME: 'NOPWD', STATUS: '*ENABLED', NO_PASSWORD_INDICATOR: 'YES', DATE_PASSWORD_EXPIRES: '2026-01-01 00:00:00' },
  ], 3, now);
  assert.deepStrictEqual(so.map(x => [x.user, x.level]), [['EXPIRED', 'high'], ['LOCKED', 'high'], ['SOON', 'medium'], ['SOON', 'medium'], ['TRIES', 'medium']]);
  assert.strictEqual(so.find(x => x.user === 'LOCKED').fix, 'CHGUSRPRF USRPRF(LOCKED) STATUS(*ENABLED)');
  assert.deepStrictEqual(so.find(x => x.user === 'LOCKED').text, { text: 'Disabled after {0} invalid sign-on attempts.', args: [3] });

  const j = sc.jobdUsers([
    { JOB_DESCRIPTION_LIBRARY: 'APP', JOB_DESCRIPTION: 'NIGHT', USER_PROFILE: 'ADMIN' },
    { JOB_DESCRIPTION_LIBRARY: 'APP', JOB_DESCRIPTION: 'BATCH', USER_PROFILE: 'APPUSR' },
    { JOB_DESCRIPTION_LIBRARY: 'APP', JOB_DESCRIPTION: 'SAFE', USER_PROFILE: 'APPUSR' },
    { JOB_DESCRIPTION_LIBRARY: 'APP', JOB_DESCRIPTION: 'ASK', USER_PROFILE: '*RQD' },
  ], new Map([['APP/NIGHT', '*USE'], ['APP/BATCH', '*CHANGE'], ['APP/SAFE', '*EXCLUDE']]), new Set(['ADMIN']));
  assert.deepStrictEqual(j.map(x => [x.jobd, x.level]), [['NIGHT', 'high'], ['BATCH', 'medium'], ['SAFE', 'info']]);

  const o = sc.userObjectsInIbmLibraries([
    { LIB: 'QGPL', OBJNAME: 'MYPGM', OBJTYPE: '*PGM', OBJOWNER: 'DEV1', OBJDEFINER: 'DEV1' },
    { LIB: 'QSYS', OBJNAME: 'MYCMD', OBJTYPE: '*CMD', OBJOWNER: 'QSECOFR', OBJDEFINER: 'ADMIN' },
    { LIB: 'QSYS', OBJNAME: 'QCMD', OBJTYPE: '*PGM', OBJOWNER: 'QSYS', OBJDEFINER: '*IBM' },
  ]);
  assert.deepStrictEqual(o.map(x => [x.library, x.object, x.level]), [['QSYS', 'MYCMD', 'high'], ['QGPL', 'MYPGM', 'info']]);
  assert.match(sc.envNote('java_home'), /Java/);
  assert.strictEqual(sc.envNote('MYVAR'), '');
});
