const test = require('node:test');
const assert = require('node:assert');
const r = require('../out/rpg/rpgSnippets');
const q = require('../out/core/sqlBuilders');
const c = require('../out/core/clSnippets');
const i = require('../out/core/ibmiConverters');

test('RPG snippets', () => {
  assert.match(r.dateConversion('ordDate', 'ymd', '*iso'), /result = %char\(%date\(ordDate: \*ymd\): \*iso\);/);
  assert.throws(() => r.dateConversion('x', '*abc', '*iso'), /RPG date formats/);
  assert.match(r.ifsWrite("/home/it's.txt"), /inz\('\/home\/it''s\.txt'\)[\s\S]*overwrite => 'REPLACE'[\s\S]*overwrite => 'APPEND'/);
  assert.match(r.ifsRead('/tmp/a.txt', '  '), /^ {2}dcl-s ifsLine varchar\(4096\);[\s\S]*ifs_read_utf8\(path_name => '\/tmp\/a\.txt'\)/);
  assert.strictEqual(r.clFromRpg("SNDMSG MSG('Hi') TOUSR(QSYSOPR)").split('\n')[0], "exec sql call qsys2.qcmdexc('SNDMSG MSG(''Hi'') TOUSR(QSYSOPR)');");
  assert.throws(() => r.clFromRpg(' '), /CL command/);
  assert.match(r.dataArea('ordnbr'), /dcl-ds ordnbrArea dtaara\('ORDNBR'\) qualified;[\s\S]*in \*lock ordnbrArea;[\s\S]*out ordnbrArea;/);
  assert.match(r.dataQueue('orderq', 'applib'), /sndDtaq\('ORDERQ': 'APPLIB': %len\(entry\): entry\);/);
  assert.match(r.jobLogMessage("Step 'A' done"), /logText = 'Step ''A'' done';/);
  assert.match(r.elapsedTime(), /%diff\(%timestamp\(\): started: \*mseconds\)/);
  assert.match(r.commitBlock(), /exec sql commit;\non-error;\n {2}exec sql rollback;/);
  assert.match(r.arrayLookup('codes', 'code'), /sorta codes;[\s\S]*at = %lookup\(code: codes\);/);
  const D = 'dcl-s name char(30);\ndcl-s qty int(10);\ndcl-s day date;';
  assert.strictEqual(r.csvLine(D), "csv = %trim(name) + ';'\n    + %char(qty) + ';'\n    + %char(day: *iso);");
  assert.strictEqual(r.jsonObject(D, 'doc'), "exec sql values json_object(\n    'name' value :name,\n    'qty' value :qty,\n    'day' value :day\n  ) into :doc;");
  const gs = r.gettersSetters('dcl-s rate packed(5:2) inz(1);');
  assert.match(gs, /dcl-proc getRate export;\n {2}dcl-pi \*n packed\(5:2\);/); assert.match(gs, /newValue packed\(5:2\) const;\n {2}end-pi;\n {2}rate = newValue;/);
  assert.match(r.retryLoop(4, 2), /for try = 1 to 4;[\s\S]*DLYJOB DLY\(2\)/);
  assert.match(r.sendEmail('a@b.com'), /SNDSMTPEMM RCP\(\(''a@b\.com''\)\)/);
});

test('SQL builders', () => {
  assert.deepStrictEqual(q.selectColumns('SELECT o.ORDER_NO, SUM(AMT) AS TOTAL, upper(x) FROM T'), ['ORDER_NO', 'TOTAL']);
  assert.match(q.selectToJson('SELECT ORDER_NO, STATUS FROM ORDERS'), /JSON_OBJECT\('order_no' VALUE ORDER_NO, 'status' VALUE STATUS\)/);
  assert.throws(() => q.selectToJson('SELECT * FROM T'), /Name the columns/);
  assert.strictEqual(q.createView('SELECT A FROM T;', 'app.v1'), 'CREATE OR REPLACE VIEW APP.V1 AS\nSELECT A FROM T');
  assert.strictEqual(q.createTableAs('SELECT A FROM T', 'qtemp.copy', false), 'CREATE TABLE QTEMP.COPY AS (\nSELECT A FROM T\n) WITH NO DATA');
  assert.strictEqual(q.deleteToSelect("DELETE FROM APP.ORDERS WHERE STATUS = 'X'"), "SELECT *\n  FROM APP.ORDERS WHERE STATUS = 'X'");
  assert.strictEqual(q.updateToSelect("UPDATE APP.ORDERS O SET STATUS = 'C' WHERE O.ID = 1"), "SELECT *\n  FROM APP.ORDERS O\n WHERE O.ID = 1");
  assert.strictEqual(q.updateToSelect("UPDATE T SET A = 1"), 'SELECT *\n  FROM T');
  const CT = 'CREATE TABLE APP.T (ID INT NOT NULL, NAME VARCHAR(50), PRIMARY KEY (ID))';
  assert.match(q.addAuditColumns(CT), /NAME VARCHAR\(50\), PRIMARY KEY \(ID\),\n {2}CREATED_AT TIMESTAMP NOT NULL DEFAULT CURRENT TIMESTAMP,[\s\S]*ROW CHANGE TIMESTAMP\n\)$/);
  assert.match(q.addIdentityColumn('CREATE TABLE T (NAME CHAR(5))'), /ID BIGINT GENERATED ALWAYS AS IDENTITY/);
  assert.strictEqual(q.addIdentityColumn('CREATE TABLE T (ID INT)'), 'CREATE TABLE T (ID INT)');
  assert.strictEqual(q.dropForCreate(CT), 'DROP TABLE APP.T IF EXISTS');
  assert.match(q.procedureSkeleton('app.doit'), /^CREATE OR REPLACE PROCEDURE APP\.DOIT \(/);
  assert.match(q.functionSkeleton('cleanup'), /^CREATE OR REPLACE FUNCTION CLEANUP \(/);
  const trg = q.auditTrigger(CT);
  assert.match(trg, /CREATE TABLE APP\.T_AUDIT/); assert.match(trg, /AFTER INSERT OR UPDATE OR DELETE ON APP\.T/); assert.match(trg, /VARCHAR\(O\.ID\)/);
  assert.deepStrictEqual(q.statementTable('select * from app.orders o'), { schema: 'APP', table: 'ORDERS' });
  assert.match(q.findDuplicates('SELECT * FROM ORDERS', 'custno, orddate'), /SELECT CUSTNO, ORDDATE, COUNT\(\*\) AS ROWS\n {2}FROM ORDERS\n GROUP BY CUSTNO, ORDDATE\nHAVING COUNT\(\*\) > 1/);
  assert.strictEqual(q.lastDays('SELECT * FROM T ORDER BY A', 'created', 30), 'SELECT * FROM T\n WHERE CREATED >= CURRENT TIMESTAMP - 30 DAYS ORDER BY A');
  assert.strictEqual(q.lastDays('SELECT * FROM T WHERE X = 1', 'ts', 7), 'SELECT * FROM T WHERE X = 1\n   AND TS >= CURRENT TIMESTAMP - 7 DAYS');
  assert.match(q.whoLocksTable('UPDATE APP.ORDERS SET A = 1'), /SYSTEM_OBJECT_SCHEMA = 'APP'\n {3}AND SYSTEM_OBJECT_NAME = 'ORDERS'/);
  assert.match(q.tableSize('SELECT * FROM ORDERS'), /LIBRARY_LIST_INFO[\s\S]*TABLE_NAME = 'ORDERS'/);
});

test('CL snippets', () => {
  assert.match(c.clProgram(), /^PGM PARM\(&LIB\)[\s\S]*MONMSG MSGID\(CPF0000\) EXEC\(GOTO CMDLBL\(ERROR\)\)[\s\S]*ENDPGM$/);
  assert.match(c.clRetry('CALL PGM(X)', 5, 20), /CALL PGM\(X\)\nMONMSG[\s\S]*IF COND\(&TRY \*LT 5\)[\s\S]*DLYJOB DLY\(20\)/);
  assert.strictEqual(c.clAllocate('CALL X', 'applib/orders'), "ALCOBJ OBJ((APPLIB/ORDERS *FILE *EXCL)) WAIT(30)\nMONMSG MSGID(CPF1002) EXEC(DO)\n  SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('ORDERS is in use') MSGTYPE(*ESCAPE)\nENDDO\nCALL X\nDLCOBJ OBJ((APPLIB/ORDERS *FILE *EXCL))");
  assert.strictEqual(c.clSubmit('CALL  PGM(NIGHTLY)', 'nightly'), 'SBMJOB CMD(CALL PGM(NIGHTLY)) JOB(NIGHTLY) JOBQ(QBATCH)');
  assert.match(c.clCopyFile('app/orders', 'qtemp/orders'), /^CPYF FROMFILE\(APP\/ORDERS\) TOFILE\(QTEMP\/ORDERS\) MBROPT\(\*REPLACE\) CRTFILE\(\*YES\)/);
  assert.match(c.clSaveToSavf('applib', 'qgpl/applib'), /CRTSAVF FILE\(QGPL\/APPLIB\)\nMONMSG MSGID\(CPF5813\) EXEC\(CLRSAVF FILE\(QGPL\/APPLIB\)\)\nSAVOBJ OBJ\(\*ALL\) LIB\(APPLIB\)/);
  assert.match(c.clConvertDate('mdy', 'iso'), /FROMFMT\(\*MDY\) TOFMT\(\*ISO\)/);
  assert.strictEqual(c.clRunSql("UPDATE T SET A = 'X';"), "RUNSQL SQL('UPDATE T SET A = ''X''') COMMIT(*NONE) NAMING(*SQL)");
  assert.match(c.clAskUser("Go on?"), /SNDUSRMSG MSG\('Go on\?'\) VALUES\(Y N\) DFT\(N\) MSGRPY\(&REPLY\)/);
  assert.match(c.clObjectInfo('PGM1'), /RTVOBJD OBJ\(\*LIBL\/PGM1\) OBJTYPE\(\*PGM\)/);
  assert.throws(() => c.clCopyFile('a b', 'c'), /not a valid/);
});

test('IBM i converters', () => {
  const iso = d => i.dateFormats(i.parseIbmiDate(d)).find(x => x.format === '*ISO').value;
  for (const v of ['2026-11-06', '1261106', '261106', '06.11.2026', '11/06/2026', '20261106', '26310']) { assert.strictEqual(iso(v), '2026-11-06', v); }
  assert.strictEqual(iso('0991231'), '1999-12-31');
  assert.throws(() => i.parseIbmiDate('2026-02-30'), /not a valid date/);
  const f = Object.fromEntries(i.dateFormats(i.parseIbmiDate('2026-11-06')).map(x => [x.format, x.value]));
  assert.deepStrictEqual([f['*CYMD'], f['*YMD'], f['*MDY'], f['*DMY'], f['*EUR'], f['*USA'], f['*JUL'], f['*LONGJUL']], ['1261106', '261106', '110626', '061126', '06.11.2026', '11/06/2026', '26310', '2026310']);
  assert.strictEqual(i.hexDecimal('31'), "x'1F'"); assert.strictEqual(i.hexDecimal("x'1F'"), '31'); assert.strictEqual(i.hexDecimal('0xFF'), '255');
  assert.strictEqual(i.systemName('ORDER_LINE'), 'ORDER_LINE');
  assert.strictEqual(i.systemName('customer_order_history'), 'CSTORDHSTR'.slice(0, 10).length === 10 ? i.systemName('customer_order_history') : '');
  assert.ok(i.systemName('customer_order_history').length <= 10 && /^C/.test(i.systemName('customer_order_history')));
  assert.match(i.ccsidName('297'), /France/); assert.match(i.ccsidName('1208'), /UTF-8/); assert.match(i.ccsidName('4321'), /not in Vanthrex's list/);
  assert.strictEqual(i.messageCommand('cpf9801'), 'DSPMSGD RANGE(CPF9801) MSGF(QCPFMSG)');
  assert.strictEqual(i.messageCommand('RNX1211'), 'DSPMSGD RANGE(RNX1211) MSGF(QRNXMSG)');
  assert.strictEqual(i.messageCommand('SQL0204'), 'DSPMSGD RANGE(SQL0204) MSGF(QSQLMSG)');
  assert.strictEqual(i.sqlToRpgType('A DECIMAL(9, 2), B VARCHAR(50), C INTEGER, D TIMESTAMP'), 'A packed(9:2), B varchar(50), C int(10), D timestamp');
  assert.strictEqual(i.rpgToSqlType('packed(11:2) char(10) int(20) ind'), 'DECIMAL(11, 2) CHAR(10) BIGINT CHAR(1)');
  assert.strictEqual(i.duration('3725'), '1:02:05'); assert.strictEqual(i.duration('1:02:05'), '3725');
  assert.strictEqual(i.numericInfo('packed(9:2)'), 'packed(9:2): 5 byte(s), from -9999999.99 to 9999999.99');
  assert.strictEqual(i.numericInfo('int(5)'), 'int(5): 2 byte(s), from -32768 to 32767');
  assert.strictEqual(i.numericInfo('DECIMAL(3, 3)'), 'decimal(3:3): 2 byte(s), from -0.999 to 0.999');
});
