const test = require('node:test');
const assert = require('node:assert');
const x = require('../out/core/developerText');
const t = require('../out/rpg/rpgTransforms');

test('RPG rewrites', () => {
  assert.deepStrictEqual(t.compoundAssignments(['  x = x + 1;', '  total = total - a + b;', '  cnt = cnt * 2;', '  y = z + 1;', '  arr(i) = arr(i) + 5; // add', "  eval s = s + 'x';"]),
    { lines: ['  x += 1;', '  total = total - a + b;', '  cnt *= 2;', '  y = z + 1;', '  arr(i) += 5; // add', "  s += 'x';"], changed: 4 });
  assert.deepStrictEqual(t.removeEvalCallp(['  eval x = 1;', '  callp proc(a);', '  eval(h) y = 1;']), { lines: ['  x = 1;', '  proc(a);', '  eval(h) y = 1;'], changed: 2 });
  assert.strictEqual(t.negateCondition('  if a = b;'), '  if a <> b;');
  assert.strictEqual(t.negateCondition('  if not (a = b and c);'), '  if a = b and c;');
  assert.strictEqual(t.negateCondition('  dow not %eof(f);'), '  dow %eof(f);');
  assert.strictEqual(t.negateCondition('  if a = 1 or b = 2; // x'), '  if not (a = 1 or b = 2); // x');
  assert.throws(() => t.negateCondition('x = 1;'));
  assert.strictEqual(t.simplifyIndicators('  if found = *on and not done = *off or x <> *on;'), '  if found and not done = *off or not x;');
  assert.strictEqual(t.wrapWithBif('name', '%TRIM'), '%trim(name)');
  assert.strictEqual(t.wrapWithBif('amt', '%DEC'), '%dec(amt: 15: 2)');
  assert.deepStrictEqual(t.groupInDs(['dcl-s a char(10);', 'dcl-s b int(10); // n'], 'vars'), ['dcl-ds vars qualified;', '  a char(10);', '  b int(10); // n', 'end-ds;']);
  assert.throws(() => t.groupInDs(['x = 1;'], 'v'));
  assert.deepStrictEqual(t.linesToConstants(['max 100', 'title Hello', "q = 'x'"]), ['dcl-c MAX   100;', "dcl-c TITLE 'Hello';", "dcl-c Q     'x';"]);
});

test('subroutine to procedure', () => {
  const src = '**free\nexsr calc;\n*inlr = *on;\nbegsr calc;\n  if x;\n    leavesr;\n  endif;\nendsr;';
  const r = t.subroutineToProcedure(src, 'CALC');
  assert.strictEqual(r.calls, 1);
  assert.strictEqual(r.text, '**free\ncalc();\n*inlr = *on;\ndcl-proc calc;\n  if x;\n    return;\n  endif;\nend-proc;');
  assert.throws(() => t.subroutineToProcedure(src, 'nope'));
});

test('data structures and SQL', () => {
  const ds = 'dcl-ds cust qualified;\n  id int(10);\n  name varchar(40);\n  total packed(9:2);\nend-ds;';
  const q = t.dsSql(ds, 'CUSTMAST');
  assert.strictEqual(q.insert, 'exec sql insert into CUSTMAST\n  (id, name, total)\n  values (:cust.id, :cust.name, :cust.total);');
  assert.match(q.select, /into :cust\.id, :cust\.name, :cust\.total\n {2}from CUSTMAST\n {2}where id = :cust\.id;/);
  assert.match(q.update, /set name = :cust\.name,\n {6}total = :cust\.total\n {2}where id = :cust\.id;/);
  assert.strictEqual(t.dsFromCreateTable('CREATE TABLE APP.CUSTOMER (ID INTEGER NOT NULL, NAME VARCHAR(40), AMT DECIMAL(9, 2) DEFAULT 0, CREATED TIMESTAMP, PRIMARY KEY (ID))'),
    'dcl-ds customer_t qualified template;\n  id int(10);\n  name varchar(40);\n  amt packed(9:2);\n  created timestamp;\nend-ds;');
  assert.match(t.createTableFromDs(ds), /CREATE TABLE CUST \(\n {2}ID {4}INTEGER NOT NULL DEFAULT,\n {2}NAME {2}VARCHAR\(40\)/);
  assert.strictEqual(t.declarationBytes('packed(9:2) dim(10)'), 50);
  assert.strictEqual(t.declarationBytes('varchar(40)'), 42);
  assert.strictEqual(t.declarationBytes('likeds(x)'), undefined);
});

test('headers, comments and literals', () => {
  const d = new Date('2026-11-03T09:05:07');
  assert.match(t.programHeader('PGM1', 'GG', d, true), /^\/\/ =+\n\/\/ Program {2}: PGM1\n/);
  assert.strictEqual(t.keepAsComment('  x = 1;', 'GG', d, true), '  // 2026-11-03 GG: x = 1;\n  x = 1;');
  assert.strictEqual(t.keepAsComment('     C                   EVAL      X = 1', 'GG', d, false), '     C*                  EVAL      X = 1\n     C                   EVAL      X = 1');
  assert.strictEqual(t.keepAsComment('  CHGVAR &A 1', 'GG', d, true, 'cl'), '/* 2026-11-03 GG: CHGVAR &A 1 */\n  CHGVAR &A 1');
  assert.deepStrictEqual(t.timeLiterals(new Date(2026, 10, 3, 9, 5, 7)).map(l => l.text).slice(0, 3), ["d'2026-11-03'", "t'09.05.07'", "z'2026-11-03-09.05.07.000000'"]);
  assert.match(t.separator('Main', true), /^\/\/ ---- Main -+\n$/);
});

test('text tools', () => {
  assert.strictEqual(x.toLiteral("it's"), "'it''s'");
  assert.strictEqual(x.toSqlInList('A\nB\n12\nA\n'), "('A', 'B', 12)");
  assert.strictEqual(x.toSqlInList('1\n2', true), "('1', '2')");
  assert.strictEqual(x.toQcmdexc("CRTLIB LIB(X) +\n  TEXT('it''s')"), "CALL QSYS2.QCMDEXC('CRTLIB LIB(X) TEXT(''it''''s'')');");
  assert.strictEqual(x.sqlToEmbedded("select a from t where b = ? and c = '?';"), "exec sql select a from t where b = :p1 and c = '?';");
  assert.strictEqual(x.embeddedToSql("exec sql select a, b into :x, :y from t\n    where c = :cust.id and d = 'x:y';"), "select a, b from t\nwhere c = ? and d = 'x:y';");
  assert.strictEqual(x.sqlKeywordCase("select a from t where b = :select and c = 'from'", 'upper'), "SELECT a FROM t WHERE b = :select AND c = 'from'");
  assert.deepStrictEqual(x.alignAssignments(['  a = 1;', '  longname += 2;', '  // c = 3']), ['  a         = 1;', '  longname += 2;', '  // c = 3']);
  assert.deepStrictEqual(x.alignComments(['x = 1; // one', 'longer = 2; // two', "y = 'a//b';"]), ['x = 1;       // one', 'longer = 2;  // two', "y = 'a//b';"]);
  assert.deepStrictEqual(x.removeBlankLines(['a', ' ', 'b']), ['a', 'b']);
  assert.deepStrictEqual(x.cleanSource('a\t= 1;   \nb = 2;​\n'), { text: 'a  = 1;\nb = 2;\n', changes: 2 });
  const w = x.wrapClCommand("             SNDPGMMSG  MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('This is a long message text for the user') MSGTYPE(*ESCAPE)");
  assert.ok(w.length === 3 && w.slice(0, -1).every(l => l.endsWith(' +')) && w.every(l => l.length <= 80));
  assert.strictEqual(x.markdownBlock('x = 1;', 'rpgle', 'LIB/QRPGLESRC(PGM)'), '`LIB/QRPGLESRC(PGM)`\n\n```rpgle\nx = 1;\n```\n');
  assert.strictEqual(x.compileCommand('dev', 'qrpglesrc', 'pgm1', 'sqlrpgle', 'obj'), 'CRTSQLRPGI OBJ(OBJ/PGM1) SRCFILE(DEV/QRPGLESRC) SRCMBR(PGM1) OBJTYPE(*PGM) DBGVIEW(*SOURCE) REPLACE(*YES)');
  assert.strictEqual(x.compileCommand('a', 'b', 'c', 'xyz'), undefined);
});

test('SQL helpers', () => {
  assert.strictEqual(x.csvToValues('a,1\n"b",\n', 'T'), "INSERT INTO T\n VALUES\n  ('a', 1),\n  ('b', NULL);");
  assert.strictEqual(x.csvToValues('x\t2'), "VALUES\n  ('x', 2);");
  assert.strictEqual(x.countFirst('DELETE FROM lib.t WHERE a = 1;'), 'SELECT COUNT(*) FROM lib.t WHERE a = 1;');
  assert.strictEqual(x.countFirst('update t x set a = 1 where b = 2'), 'SELECT COUNT(*) FROM t x where b = 2;');
  assert.strictEqual(x.countFirst('update t set a = 1'), 'SELECT COUNT(*) FROM t;');
  assert.throws(() => x.countFirst('select 1'));
  assert.strictEqual(x.limitSelect('select * from t fetch first 5 rows only;'), 'select * from t\n  FETCH FIRST 100 ROWS ONLY;');
  assert.strictEqual(x.clUppercase("chgvar &a 'abc' /* note */"), "CHGVAR &A 'abc' /* note */");
  assert.strictEqual(x.sqlSuggest(['delete from t '], 0, 14), 'WHERE ');
  assert.strictEqual(x.sqlSuggest(['update t set a = 1', ''], 1, 0), 'WHERE ');
  assert.strictEqual(x.sqlSuggest(['update t set a = 1', 'where b = 2', ''], 2, 0), undefined);
  assert.strictEqual(x.sqlSuggest(['select 1 from t;', ''], 1, 0), undefined);
  assert.deepStrictEqual(x.literalAt("x = 'it''s';", 6), { start: 4, end: 11, text: "it's", hex: false });
  assert.deepStrictEqual(x.literalAt("y = X'C1C2';", 7), { start: 4, end: 11, text: 'C1C2', hex: true });
  assert.strictEqual(x.literalAt('z = 1;', 3), undefined);
});

test('CL error handler', () => {
  const src = 'PGM\n             DCL        VAR(&A) TYPE(*CHAR) LEN(10)\n             CHGVAR     VAR(&A) VALUE(X)\nENDPGM';
  const out = x.clErrorHandler(src).split('\n');
  assert.strictEqual(out[2], '             DCL        VAR(&MSGID) TYPE(*CHAR) LEN(7)');
  assert.ok(out.includes('             MONMSG     MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))'));
  assert.ok(out.indexOf('             MONMSG     MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))') < out.findIndex(l => /CHGVAR/.test(l)));
  assert.ok(out.some(l => /^ERROR:/.test(l)) && out[out.length - 1] === 'ENDPGM');
  assert.throws(() => x.clErrorHandler(x.clErrorHandler(src)));
  assert.throws(() => x.clErrorHandler('PGM'));
});
