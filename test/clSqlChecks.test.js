const test = require('node:test');
const assert = require('node:assert');
const c = require('../out/core/clChecks');
const q = require('../out/core/sqlChecks');
const s = require('../out/rpg/rpgSafetyChecks');
const { lintRpg } = require('../out/rpg/lint');

const CL = ['PGM PARM(&LIB)', '  DCL VAR(&LIB) TYPE(*CHAR) LEN(10)', '  DCL VAR(&N) TYPE(*DEC) LEN(5 0)', '  DCL VAR(&S) TYPE(*CHAR) LEN(3)', '  DCL VAR(&UNUSED) TYPE(*CHAR) LEN(3)',
  "  CHGVAR VAR(&S) VALUE('TOOLONG')", "  CHGVAR &N 'ABC'", "  CHGVAR &N '12'", '  CHKOBJ OBJ(PRODLIB/X) OBJTYPE(*FILE)', '  CHKOBJ OBJ(QTEMP/X) OBJTYPE(*FILE)',
  '  IF COND(&X = 1) THEN(DO)', '    GOTO CMDLBL(NOWHERE)', '    GOTO END', '  ENDDO', '  DCL VAR(&LATE) TYPE(*CHAR)', "  CHGVAR &LATE '1'", "  SNDPGMMSG MSG('&NOTVAR')", '  DO', 'END: ENDPGM'].join('\n');
const cl = (src, rule) => c.clLint(src).filter(f => f.rule === rule).map(f => f.line + 1);

test('CL: variables, labels, blocks, declarations', () => {
  assert.strictEqual(Object.keys(c.CL_RULES).length, 8);
  assert.deepStrictEqual(cl(CL, 'cl-undeclared-variable'), [11]);
  assert.deepStrictEqual(cl(CL, 'cl-unused-variable'), [5]);
  assert.deepStrictEqual(cl(CL, 'cl-undefined-label'), [12]);
  assert.deepStrictEqual(cl(CL, 'cl-unbalanced-block'), [18]);
  assert.deepStrictEqual(cl(CL, 'cl-dcl-after-command'), [15]);
  assert.deepStrictEqual(cl('PGM\nENDDO\nENDPGM', 'cl-unbalanced-block'), [2]);
  assert.deepStrictEqual(cl('PGM\nDCLF FILE(X)\nCHGVAR &FLD 1\nENDPGM', 'cl-undeclared-variable'), []);
  assert.deepStrictEqual(cl('PGM\nMONMSG CPF0000\nDCL &A *CHAR 10\nCHGVAR &A X\nENDPGM', 'cl-dcl-after-command'), []);
});

test('CL: literals, decimals and libraries', () => {
  assert.deepStrictEqual(cl(CL, 'cl-value-too-long'), [6]);
  assert.deepStrictEqual(cl(CL, 'cl-text-in-decimal'), [7]);
  assert.deepStrictEqual(cl(CL, 'cl-hardcoded-library'), [9]);
  assert.deepStrictEqual(c.clVariables(require('../out/core/clLanguage').clStatements('DCL &A *CHAR 5\nDCL VAR(&B) TYPE(*DEC)\nDCL &C *CHAR')).map(v => [v.name, v.type, v.len]), [['&A', '*CHAR', 5], ['&B', '*DEC', 15], ['&C', '*CHAR', 32]]);
});

test('CL: declaration helpers and switches', () => {
  assert.strictEqual(c.clDeclarationLine(CL), 5);
  assert.match(c.clDeclaration('&count'), /DCL {8}VAR\(&COUNT\) TYPE\(\*DEC\) LEN\(5 0\)/);
  assert.deepStrictEqual(c.clLint(CL, r => r !== 'cl-unused-variable').filter(f => f.rule === 'cl-unused-variable'), []);
  for (const t of ['', 'PGM', 'DCL', "CHGVAR &A '", 'GOTO']) { assert.doesNotThrow(() => c.clLint(t)); }
});

test('SQL scripts', () => {
  const f = q.checkSqlScript("select * from t where a <> null;\n-- delete from x;\ndelete from x;\ndrop table y;\ntruncate z;\nupdate t set a = 1 where current of c1;\nupdate t set a = null where b = 1;\nselect a into :x from t;\nselect count(*) into :n from t;\ncreate procedure p() begin delete from t; end;");
  assert.deepStrictEqual(f.map(x => x.rule), ['sql-equals-null', 'sql-without-where', 'sql-irreversible', 'sql-irreversible', 'sql-select-into-many']);
  assert.strictEqual(Object.keys(q.SQL_RULES).length, 4);
  assert.deepStrictEqual(q.checkSqlScript("delete from x where y = 'a;b'"), []);
});

test('embedded SQL in RPG, positions on the right line', () => {
  const src = '**free\nctl-opt;\n  exec sql update cust\n     set name = :n;\n  exec sql delete from t where a = null; // x\n  exec sql select a into :x from t;\n';
  const f = s.embeddedSqlLint(src);
  assert.deepStrictEqual(f.map(x => [x.line + 1, x.rule, src.split('\n')[x.line].slice(x.start, x.end)]), [[3, 'sql-without-where', 'update'], [5, 'sql-equals-null', '= null'], [6, 'sql-select-into-many', 'into']]);
  assert.ok(lintRpg(src).some(x => x.rule === 'sql-without-where'));
  assert.ok(!lintRpg(src, { rules: { 'sql-without-where': false } }).some(x => x.rule === 'sql-without-where'));
});
