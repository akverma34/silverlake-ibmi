const test = require('node:test');
const assert = require('node:assert');
const t = require('../out/core/devTools2');

test('text tools', () => {
  assert.strictEqual(t.sortLines('b\nA\nc10\nc9\n'), 'A\nb\nc9\nc10\n');
  assert.strictEqual(t.sortLines('a\nb', true), 'b\na');
  assert.strictEqual(t.uniqueLines('a\nb\na \nc'), 'a\nb\nc');
  assert.strictEqual(t.reverseLines('1\n2\n3\n'), '3\n2\n1\n');
  assert.strictEqual(t.trimLines('  a  \n b'), 'a\nb');
  assert.strictEqual(t.changeCase("if name = 'Abc';", 'upper'), "IF NAME = 'Abc';");
  assert.strictEqual(t.changeCase('SELECT "MyCol" FROM T', 'lower'), 'select "MyCol" from t');
  assert.strictEqual(t.joinComma('A\n\nB\n C '), 'A, B, C');
  assert.strictEqual(t.splitComma('A, B;C'), 'A\nB\nC');
  assert.strictEqual(t.quoteLines("it's\nB", ','), "'it''s',\n'B'");
  assert.strictEqual(t.numberLines('a\nb', 10, 10), '10 a\n20 b');
  assert.deepStrictEqual(t.countText('ab cd\nefg\n'), { lines: 2, words: 3, chars: 9, longest: 5 });
  assert.strictEqual(t.toEbcdicHex('AB 1'), "x'C1C24040F1'".replace('4040', '40'));
  assert.strictEqual(t.fromEbcdicHex("x'C1C240F1'"), 'AB 1');
  assert.strictEqual(t.fromEbcdicHex(t.toEbcdicHex("Hello, it's #1!")), "Hello, it's #1!");
  assert.throws(() => t.toEbcdicHex('é'), /CCSID 37/);
  assert.throws(() => t.fromEbcdicHex('C1C'), /even number/);
  assert.match(t.boxComment('Title', 'rpgle'), /^\/\/ =+\n\/\/ Title\n\/\/ =+$/);
  assert.match(t.boxComment('Title', 'cl'), /^\/\* =+ \*\/\n\/\* Title\s+\*\/\n/);
  assert.strictEqual(t.toCamelCase('customer_name ORDER-DATE'), 'customerName orderDate');
  assert.strictEqual(t.toUpperSnake('customerName orderDate'), 'CUSTOMER_NAME ORDER_DATE');
  assert.strictEqual(t.alignColumns('A  1\nlonger  22'), 'A       1\nlonger  22');
});

const CREATE = `CREATE TABLE APP.ORDERS (
  ORDER_NO DECIMAL(9, 0) NOT NULL,
  CUSTNO DECIMAL(7, 0) NOT NULL WITH DEFAULT,
  STATUS CHAR(1) DEFAULT 'O',
  AMOUNT DECIMAL(11, 2),
  PRIMARY KEY (ORDER_NO)
);`;

test('SQL from a CREATE TABLE', () => {
  const p = t.parseCreateTable(CREATE);
  assert.strictEqual(p.table, 'APP.ORDERS');
  assert.deepStrictEqual(p.columns.map(c => [c.name, c.type, c.key]), [['ORDER_NO', 'DECIMAL(9, 0)', true], ['CUSTNO', 'DECIMAL(7, 0)', false], ['STATUS', 'CHAR(1)', false], ['AMOUNT', 'DECIMAL(11, 2)', false]]);
  assert.match(t.labelOnFromCreate(CREATE), /LABEL ON COLUMN APP\.ORDERS \(\n {2}ORDER_NO {5}TEXT IS 'Order No',/);
  assert.match(t.commentOnFromCreate(CREATE), /CUSTNO {7}IS 'Custno'/);
  assert.match(t.insertFromCreate(CREATE), /\(\n {2}ORDER_NO, CUSTNO, STATUS, AMOUNT\n\) VALUES \(\n {2}\?, \?, \?, \?\n\)/);
  assert.match(t.selectFromCreate(CREATE), /WHERE ORDER_NO = \?$/);
  assert.match(t.updateFromCreate(CREATE), /SET CUSTNO = \?,[\s\S]*WHERE ORDER_NO = \?$/);
  const m = t.mergeFromCreate(CREATE);
  assert.match(m, /ON T\.ORDER_NO = S\.ORDER_NO/); assert.match(m, /WHEN MATCHED THEN UPDATE SET CUSTNO = S\.CUSTNO/); assert.match(m, /WHEN NOT MATCHED THEN INSERT/);
  assert.match(t.createOrReplace(CREATE), /^CREATE OR REPLACE TABLE APP\.ORDERS[\s\S]*ON REPLACE PRESERVE ROWS$/);
  assert.throws(() => t.parseCreateTable('SELECT 1'), /CREATE TABLE/);
  assert.strictEqual(t.parseCreateTable('CREATE TABLE T (A INT)').columns[0].key, false);
});

test('SQL rewrites', () => {
  assert.strictEqual(t.selectToCount('SELECT A, B FROM ORDERS WHERE X = 1 ORDER BY A FETCH FIRST 10 ROWS ONLY;'), 'SELECT COUNT(*) FROM ORDERS WHERE X = 1');
  assert.match(t.selectToCount('WITH X AS (SELECT 1 FROM T) SELECT * FROM X ORDER BY 1'), /^SELECT COUNT\(\*\) FROM \(\nWITH X AS/);
  assert.throws(() => t.selectToCount('DELETE FROM T'), /SELECT/);
  assert.strictEqual(t.wrapInCte('SELECT 1 FROM T;'), 'WITH X AS (\n  SELECT 1 FROM T\n)\nSELECT *\n  FROM X');
  assert.strictEqual(t.addRowNumber('SELECT A FROM T', 'A'), 'SELECT ROW_NUMBER() OVER (ORDER BY A) AS RN, A FROM T');
  assert.strictEqual(t.addPaging('SELECT A FROM T FETCH FIRST 5 ROWS ONLY', 50), 'SELECT A FROM T\n OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY');
  assert.strictEqual(t.readUncommitted('SELECT A FROM T WITH CS'), 'SELECT A FROM T WITH UR');
  assert.strictEqual(t.readUncommitted('SELECT A FROM T'), 'SELECT A FROM T\n WITH UR');
  assert.strictEqual(t.indexForSelect("SELECT * FROM APP.ORDERS O WHERE O.CUSTNO = ? AND STATUS IN ('O','C') ORDER BY ORDDATE DESC"), 'CREATE INDEX APP.ORDERS_IX_CUSTNO\n  ON APP.ORDERS (CUSTNO, STATUS, ORDDATE)');
  assert.throws(() => t.indexForSelect('SELECT 1 FROM T'), /No column/);
});

const DCL = "  dcl-s custName char(30);\n  dcl-s total packed(11:2) inz(0);\n  dcl-s found ind;\n  dcl-s note varchar(100);\n  dcl-s order likeds(order_t);";

test('RPG declarations', () => {
  assert.deepStrictEqual(t.parseDecls(DCL).map(d => d.name), ['custName', 'total', 'found', 'note', 'order']);
  assert.throws(() => t.parseDecls('x = 1;'), /DCL-S/);
  assert.strictEqual(t.clearVars("dcl-s a int(10);"), 'clear a;');
  assert.strictEqual(t.resetVars("  dcl-s a int(10);"), '  reset a;');
  assert.strictEqual(t.initVars(DCL), "  custName = *blanks;\n  total = 0;\n  found = *off;\n  note = '';\n  clear order;");
  assert.match(t.traceVars(DCL), /dsply \('custName=' \+ %trimr\(custName\)\);\n {2}dsply \('total=' \+ %char\(total\)\);/);
  assert.strictEqual(t.varsToParms("dcl-s a char(10);\ndcl-s b likeds(x);", 'calc'), 'dcl-pi calc;\n  a char(10) const;\n  b likeds(x);\nend-pi;');
  assert.strictEqual(t.parmsToVars('    a char(10) const;\n    b int(10) value options(*nopass);'), '    dcl-s a char(10);\n    dcl-s b int(10);');
  assert.strictEqual(t.valuesToSelect("O\n10\n*BLANKS", 'status', '  '), "  select;\n    when status = 'O';\n      // O\n    when status = 10;\n      // 10\n    when status = *BLANKS;\n      // *BLANKS\n    other;\n      // none of them\n  endsl;");
  assert.strictEqual(t.valuesToArray("NY\nPARIS", 'cities'), "dcl-ds cities_values;\n  *n char(5) inz('NY');\n  *n char(5) inz('PARIS');\n  cities char(5) dim(2) pos(1);\nend-ds;");
  assert.match(t.readLoop('CUSTMAST'), /^setll \*loval custmast;\nread custmast;\ndow not %eof\(custmast\);/);
  assert.match(t.readLoop('ORDERS', '', 'custNo'), /^setll \(custNo\) orders;\nreade \(custNo\) orders;/);
  assert.throws(() => t.readLoop('x y'), /not a valid file/);
  const c = t.cursorLoop('SELECT * FROM T;', 'C2');
  assert.match(c, /declare C2 cursor for\n {2}SELECT \* FROM T;/); assert.match(c, /fetch next from C2 into :row/); assert.match(c, /close C2;$/);
  assert.match(t.psds(), /dcl-ds pgmStatus psds qualified;[\s\S]*messageId char\(7\) pos\(40\)/);
  assert.match(t.infds('ORDERS'), /infds\(ordersInfo\)[\s\S]*dcl-ds ordersInfo qualified;/);
  assert.strictEqual(t.commentOut('  x = 1;\n  y = 2;', 'rpgle', 'GG', '2026-11-06', 'not needed'), '  // 2026-11-06 GG: not needed\n  // x = 1;\n  // y = 2;');
  assert.strictEqual(t.commentOut('A /* x */', 'cl', 'GG', 'd', ''), '/* d GG: removed */\n/* A /* x * / */');
});

test('CL templates', () => {
  assert.match(t.clRtvjoba(), /RTVJOBA JOB\(&JOB\) USER\(&USER\)/);
  assert.strictEqual(t.clCheckObject('applib/orders', 'file'), "CHKOBJ OBJ(APPLIB/ORDERS) OBJTYPE(*FILE)\nMONMSG MSGID(CPF9801) EXEC(DO)\n  SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('ORDERS *FILE not found in APPLIB') MSGTYPE(*ESCAPE)\nENDDO");
  assert.match(t.clCheckObject('PGM1', '*PGM'), /OBJ\(\*LIBL\/PGM1\) OBJTYPE\(\*PGM\)/);
  assert.match(t.clReadLoop('custmast'), /^DCLF FILE\(CUSTMAST\)[\s\S]*LOOP: RCVF\nMONMSG MSGID\(CPF0864\)/);
  assert.strictEqual(t.clSendMessage("It's done", '*COMP'), "SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('It''s done') MSGTYPE(*COMP)");
  assert.strictEqual(t.clOverride('CALL PGM(X)\n', 'orders', 'test/orders'), 'OVRDBF FILE(ORDERS) TOFILE(TEST/ORDERS) OVRSCOPE(*CALLLVL)\nCALL PGM(X)\nDLTOVR FILE(ORDERS)');
  assert.strictEqual(t.clSystemValue('qdate'), 'DCL VAR(&QDATE) TYPE(*CHAR) LEN(6)\nRTVSYSVAL SYSVAL(QDATE) RTNVAR(&QDATE)');
  assert.throws(() => t.clCheckObject('a b', '*FILE'), /not a valid/);
});
