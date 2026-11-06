const test = require('node:test');
const assert = require('node:assert');
const a = require('../out/core/adminInsights');

test('function usage: matrix, effective usage and functions open to everyone', () => {
  assert.match(a.functionUsageSql(), /QSYS2\.FUNCTION_USAGE/);
  const m = a.functionMatrix([
    { FUNCTION_ID: 'QIBM_DB_SQLADM', FUNCTION_NAME: 'Database Administrator', DEFAULT_USAGE: 'DENIED', ALLOBJ_INDICATOR: 'USED' },
    { FUNCTION_ID: 'QIBM_DB_ZDA', FUNCTION_NAME: 'ODBC and OLE DB', DEFAULT_USAGE: 'ALLOWED', ALLOBJ_INDICATOR: 'NOT USED' },
    { FUNCTION_ID: 'QIBM_XE1_OPNAV', FUNCTION_NAME: 'Navigator', DEFAULT_USAGE: 'ALLOWED' },
    { FUNCTION_ID: 'QIBM_QTMF_FTP', FUNCTION_NAME: 'FTP server', DEFAULT_USAGE: 'ALLOWED' },
  ], [
    { FUNCTION_ID: 'QIBM_DB_SQLADM', USER_NAME: 'DBA', USAGE: 'ALLOWED', USER_TYPE: 'USER' },
    { FUNCTION_ID: 'QIBM_DB_SQLADM', USER_NAME: 'DEVGRP', USAGE: 'ALLOWED', USER_TYPE: 'GROUP' },
    { FUNCTION_ID: 'QIBM_QTMF_FTP', USER_NAME: '*PUBLIC', USAGE: 'DENIED', USER_TYPE: 'USER' },
    { FUNCTION_ID: 'QIBM_QTMF_FTP', USER_NAME: 'DBA', USAGE: 'ALLOWED', USER_TYPE: 'USER' },
    { FUNCTION_ID: 'QIBM_UNKNOWN', USER_NAME: 'X', USAGE: 'DENIED' },
  ]);
  const ids = m.functions.map(f => f.id);
  assert.ok(ids.indexOf('QIBM_DB_SQLADM') < ids.indexOf('QIBM_QTMF_FTP'), 'sensitive first');
  assert.ok(!ids.includes('QIBM_XE1_OPNAV'), 'no entry and not sensitive: left out');
  assert.ok(ids.includes('QIBM_UNKNOWN') && ids.includes('QIBM_DB_ZDA'));
  assert.deepStrictEqual(m.users.map(u => u.name), ['*PUBLIC', 'DBA', 'DEVGRP', 'X']);
  assert.strictEqual(m.users.find(u => u.name === 'DEVGRP').group, true);
  assert.deepStrictEqual(m.openToAll, ['QIBM_DB_ZDA']);
  const fn = id => m.functions.find(f => f.id === id);
  assert.strictEqual(fn('QIBM_DB_SQLADM').allObj, true);
  assert.deepStrictEqual(a.effectiveUsage(m, 'X', fn('QIBM_QTMF_FTP')), { usage: 'DENIED', explicit: false });
  assert.deepStrictEqual(a.effectiveUsage(m, 'DBA', fn('QIBM_QTMF_FTP')), { usage: 'ALLOWED', explicit: true });
  assert.deepStrictEqual(a.effectiveUsage(m, 'X', fn('QIBM_DB_ZDA')), { usage: 'ALLOWED', explicit: false });
});

test('user storage: per user over all ASPs, % of MAXSTG and share', () => {
  const s = a.storageUses([
    { AUTHORIZATION_NAME: 'BIG', ASPGRP: '*SYSBAS', MAXIMUM_STORAGE_ALLOWED: 1000, STORAGE_USED: 600 },
    { AUTHORIZATION_NAME: 'BIG', ASPGRP: 'IASP1', MAXIMUM_STORAGE_ALLOWED: 1000, STORAGE_USED: 350 },
    { AUTHORIZATION_NAME: 'FREE', ASPGRP: '*SYSBAS', MAXIMUM_STORAGE_ALLOWED: null, STORAGE_USED: 50 },
    { USER_NAME: 'OLD', MAXIMUM_STORAGE_ALLOWED: -1, STORAGE_USED: 0 },
  ]);
  assert.strictEqual(s.totalKb, 1000);
  assert.deepStrictEqual(s.users.map(u => [u.user, u.usedKb, u.pctOfMax, u.share]), [['BIG', 950, 95, 95], ['FREE', 50, null, 5], ['OLD', 0, null, 0]]);
  assert.deepStrictEqual([500, 1536, 3 * 1024 * 1024].map(a.kbLabel), ['500 KB', '1.5 MB', '3.0 GB']);
});

test('reply list: generic IDs, *ANY, unreachable entries and dumps', () => {
  assert.ok(a.replyIdMatches('CPA0000', 'CPA5335'));
  assert.ok(a.replyIdMatches('CPA5300', 'CPA5335'));
  assert.ok(!a.replyIdMatches('CPA5300', 'CPA4002'));
  assert.ok(a.replyIdMatches('*ANY', 'RNQ1216'));
  assert.ok(a.replyIdMatches('CPA4002', 'CPA4002') && !a.replyIdMatches('CPA4002', 'CPA4003'));
  const e = a.replyEntries([
    { SEQUENCE_NUMBER: 30, MESSAGE_ID: 'CPA5335', MESSAGE_REPLY: 'R', COMPARE_DATA: null, DUMP: 'NO' },
    { SEQUENCE_NUMBER: 10, MESSAGE_ID: 'CPA4002', MESSAGE_REPLY: 'I', COMPARE_DATA: 'QPRINT', COMPARE_START_POSITION: 1, DUMP: 'NO' },
    { SEQUENCE_NUMBER: 20, MESSAGE_ID: 'CPA5300', MESSAGE_REPLY: 'G', COMPARE_DATA: '', DUMP: '*YES' },
    { SEQUENCE_NUMBER: 40, MESSAGE_ID: 'CPA4002', MESSAGE_REPLY: 'G', DUMP: 'NO' },
    { SEQUENCE_NUMBER: 9999, MESSAGE_ID: '*ANY', MESSAGE_REPLY: 'D', DUMP: 'YES' },
  ]);
  assert.deepStrictEqual(e.map(x => [x.seq, x.issues, x.shadowedBy]), [
    [10, [], undefined], [20, ['dump'], undefined], [30, ['shadowed'], 20], [40, [], undefined], [9999, ['any', 'dump'], undefined],
  ]);
  assert.strictEqual(a.messageTextSql(['bad', "X'); --"]), undefined);
  assert.match(a.messageTextSql(['cpa4002', 'CPA4002', 'RNQ1216']), /MESSAGE_ID IN \('CPA4002', 'RNQ1216'\)$/);
});
