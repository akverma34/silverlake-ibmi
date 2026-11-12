const test = require('node:test');
const assert = require('node:assert');
const v = require('../out/core/ifsTools');

test('IFS lock SQL for a file and a folder', () => {
  assert.strictEqual(v.ifsLocksSql("/home/o'b/a.txt", false, 50),
    "SELECT '/home/o''b/a.txt' AS P, L.* FROM TABLE(QSYS2.IFS_OBJECT_LOCK_INFO(PATH_NAME => '/home/o''b/a.txt')) L FETCH FIRST 50 ROWS ONLY");
  const f = v.ifsLocksSql('/home/app/', true);
  assert.match(f, /IFS_OBJECT_STATISTICS\(START_PATH_NAME => '\/home\/app', SUBTREE_DIRECTORIES => 'NO', OBJECT_TYPE_LIST => '\*ALLSTMF'\)\) X, LATERAL/);
  assert.match(f, /IFS_OBJECT_LOCK_INFO\(PATH_NAME => X\.PATH_NAME\)/);
  assert.throws(() => v.ifsLocksSql('home/x', false));
  assert.throws(() => v.ifsLocksSql('/home/../etc', false));
});

test('IFS lock rows: uses, user and blocking first', () => {
  const rows = v.ifsLockRows([
    { P: '/a/x.txt', JOB_NAME: '123456/BOB/QZDASOINIT', REFERENCE_COUNT: 2, READ_ONLY: 'YES', WRITE_ONLY: 'NO', SHARE_WITH_READERS_AND_WRITERS: 'YES' },
    { P: '/a/x.txt', JOB_NAME: '654321/ANN/NIGHTLY', REFERENCE_COUNT: 1, READ_WRITE: 'YES', READ_WRITE_NO_SHARE: 'YES' },
    { P: '/a/y.txt', JOB_NAME: '' },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], { path: '/a/x.txt', job: '654321/ANN/NIGHTLY', user: 'ANN', refs: 1, uses: ['read write', 'read write no share'], blocking: true });
  assert.strictEqual(rows[1].blocking, false);
  assert.deepStrictEqual(rows[1].uses, ['read only', 'share with readers and writers']);
  assert.strictEqual(v.jobShortName('123456/BOB/QZDASOINIT'), 'QZDASOINIT');
});

test('IFS lock SQL with subfolders', () => {
  assert.match(v.ifsLocksSql('/home/app', true, 10, true), /SUBTREE_DIRECTORIES => 'YES'/);
  assert.match(v.ifsLocksSql('/home/app', true, 10, false), /SUBTREE_DIRECTORIES => 'NO'/);
  assert.throws(() => v.ifsLocksSql('/', true, 10, true), /below \//);
});

test('busy file message after a failed save', () => {
  const locks = v.ifsLockRows([
    { P: '/a/x.txt', JOB_NAME: '1/A/J1', READ_WRITE_NO_SHARE: 'YES' },
    { P: '/a/x.txt', JOB_NAME: '2/B/J2', READ_ONLY: 'YES' },
    { P: '/a/x.txt', JOB_NAME: '2/B/J2', READ_ONLY: 'YES' },
  ]);
  assert.deepStrictEqual(v.busyFileMessage('/a/x.txt', locks), { jobs: 2, blocking: 1 });
  assert.strictEqual(v.busyFileMessage('/a/x.txt', []), undefined);
  assert.strictEqual(v.busyFileMessage('/a/other.txt', locks), undefined);
});

test('job info SQL for the lock page', () => {
  const one = v.lockJobsInfoSql(['123456/BOB/QZDASOINIT', '123457/ANN/QZDASOINIT', 'junk', "1/x'/y"]);
  assert.match(one, /JOB_NAME_FILTER => 'QZDASOINIT'/);
  assert.match(one, /WHERE JOB_NAME IN \('123456\/BOB\/QZDASOINIT', '123457\/ANN\/QZDASOINIT'\)$/);
  const two = v.lockJobsInfoSql(['123456/BOB/J1', '123457/ANN/J2', '123456/bob/j1']);
  assert.doesNotMatch(two, /JOB_NAME_FILTER/);
  assert.match(two, /IN \('123456\/BOB\/J1', '123457\/ANN\/J2'\)$/);
  assert.strictEqual(v.lockJobsInfoSql(['nope', '']), undefined);
});

test('job status in plain words', () => {
  assert.strictEqual(v.jobStatusText('msgw'), 'waiting for a reply (MSGW)');
  assert.strictEqual(v.jobStatusText('XYZW'), 'XYZW');
  assert.strictEqual(v.jobStatusText(' '), '');
});

test('when a watched file counts as free', () => {
  const blocking = { path: '/a', job: '1/A/B', user: 'A', refs: 1, uses: [], blocking: true };
  const reader = { ...blocking, blocking: false };
  assert.strictEqual(v.ifsLockFree([reader], true), true);
  assert.strictEqual(v.ifsLockFree([reader, blocking], true), false);
  assert.strictEqual(v.ifsLockFree([reader], false), false);
  assert.strictEqual(v.ifsLockFree([], false), true);
});
