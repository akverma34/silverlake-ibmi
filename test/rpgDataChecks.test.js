const test = require('node:test');
const assert = require('node:assert');
const d = require('../out/rpg/rpgDataChecks');
const { lintRpg } = require('../out/rpg/lint');
const { toggleWord } = require('../out/rpg/rpgProductivity');
const mt = require('../out/rpg/rpgModuleTools');
const { suggest } = require('../out/rpg/rpgSuggestions');

const SRC = ['**free', 'ctl-opt;', 'dcl-s name char(10);', 'dcl-s total packed(5:2);', 'dcl-s cnt int(5);', 'dcl-s arr char(3) dim(5);',
  'dcl-ds rec qualified;', '  code char(2);', 'end-ds;', 'dcl-s v varchar(20);',
  "total = 'abc';", 'total = 1234.5;', 'total = 999.99;', 'cnt = 40000;', 'if total = *blanks;', 'endif;', 'if name = *blanks;', 'endif;',
  'x = %subst(name: 8: 5);', 'y = %subst(v: 1: 20);', "arr(6) = 'a';", "arr(5) = 'b';",
  'exec sql select a into :total, :missing from t where c = :rec.code;', 'exsr nosub;', 'exsr calc;', 'begsr calc;', 'endsr;',
  'dcl-proc p;', '  dcl-pi *n;', '    q packed(3:0);', '  end-pi;', '  q = 1000;', 'end-proc;'].join('\n');
const found = (src, rule) => d.dataLint(src).filter(f => f.rule === rule).map(f => f.line + 1);

test('field types, free and fixed', () => {
  assert.deepStrictEqual(d.fieldType('char(10)'), { kind: 'char', length: 10 });
  assert.deepStrictEqual(d.fieldType('packed(7:2) inz(0)'), { kind: 'packed', length: 7, scale: 2 });
  assert.deepStrictEqual(d.fieldType('int(10) dim(5)'), { kind: 'int', length: 10, dim: 5 });
  assert.deepStrictEqual(d.fieldType('10A'), { kind: 'char', length: 10 });
  assert.deepStrictEqual(d.fieldType('7P 2'), { kind: 'packed', length: 7, scale: 2 });
  assert.deepStrictEqual(d.fieldType('5  0 DIM(10)'), { kind: 'packed', length: 5, scale: 0, dim: 10 });
  assert.strictEqual(d.fieldType('likeds(x)'), undefined);
});

test('literals, blanks and text in numeric fields', () => {
  assert.deepStrictEqual(found(SRC, 'char-to-numeric'), [11]);
  assert.deepStrictEqual(found(SRC, 'literal-overflow'), [12, 14, 32]);
  assert.deepStrictEqual(found(SRC, 'blank-compare-numeric'), [15]);
});

test('%SUBST and array indexes beyond the declaration', () => {
  assert.deepStrictEqual(found(SRC, 'substring-out-of-range'), [19]);
  assert.deepStrictEqual(found(SRC, 'index-out-of-range'), [21]);
});

test('SQL host variables and subroutines, silent with /COPY or external structures', () => {
  assert.deepStrictEqual(found(SRC, 'undeclared-host-variable'), [23]);
  assert.deepStrictEqual(found(SRC, 'undefined-subroutine'), [24]);
  const withCopy = SRC.replace('ctl-opt;', 'ctl-opt;\n/copy qcpysrc,defs');
  assert.deepStrictEqual(found(withCopy, 'undeclared-host-variable'), []);
  assert.deepStrictEqual(found(withCopy, 'undefined-subroutine'), []);
  assert.deepStrictEqual(found(SRC.replace('ctl-opt;', "ctl-opt;\ndcl-ds cust extname('CUSTMAST') end-ds;"), 'undeclared-host-variable'), []);
});

test('wired into lintRpg, switchable, includes spared', () => {
  const rules = new Set(lintRpg(SRC).map(f => f.rule));
  for (const r of Object.keys(d.DATA_RULES)) { assert.ok(rules.has(r), r); }
  assert.ok(!lintRpg(SRC, { rules: { 'literal-overflow': false } }).some(f => f.rule === 'literal-overflow'));
  assert.ok(!lintRpg(SRC, { isInclude: true }).some(f => f.rule === 'undefined-subroutine'));
});

test('tolerant on odd input', () => {
  for (const t of ['', '**free', 'x = %subst(', '**free\nexec sql select :', '     C                   EXSR      SUB1']) { assert.doesNotThrow(() => d.dataLint(t)); }
  assert.deepStrictEqual(found('     C                   EXSR      SUB1\n     C     SUB1          BEGSR\n     C                   ENDSR\n', 'undefined-subroutine'), []);
});

test('toggle value, declaration and subroutine positions', () => {
  assert.strictEqual(toggleWord('*ON'), '*OFF');
  assert.strictEqual(toggleWord('and'), 'or');
  assert.strictEqual(toggleWord('<>'), '=');
  assert.strictEqual(toggleWord('SETLL'), 'SETGT');
  assert.strictEqual(toggleWord('x'), undefined);
  const src = '**free\nctl-opt;\ndcl-s a int(10);\ndcl-ds d;\n  x int(10);\nend-ds;\nx = 1;\ndcl-proc p;\n  dcl-pi *n;\n    z int(10);\n  end-pi;\n  dcl-s y int(10);\n  y = 1;\nend-proc;\n';
  assert.deepStrictEqual(mt.declarationLine(src, 6), { line: 6, indent: '' });
  assert.deepStrictEqual(mt.declarationLine(src, 12), { line: 12, indent: '  ' });
  assert.strictEqual(mt.subroutineLine(src), 7);
});

test('more suggestions: DCL-PI parameters from the DCL-PR, WHEN after SELECT, RCVF', () => {
  const at = (src, language = 'rpgle') => { const lines = src.split('\n'); const line = lines.findIndex(l => l.includes('|')); const column = lines[line].indexOf('|'); lines[line] = lines[line].replace('|', ''); return suggest({ lines, line, column, language }); };
  const pr = '**free\ndcl-pr calc int(10);\n  a int(10) const;\n  b char(5) const;\nend-pr;\ndcl-proc calc;\n  dcl-pi *n int(10);\n';
  assert.strictEqual(at(pr + '    |\n  end-pi;\nend-proc;'), 'a int(10) const;\n    b char(5) const;');
  assert.strictEqual(at(pr + '    |\nend-proc;'), 'a int(10) const;\n    b char(5) const;\n  end-pi;');
  assert.strictEqual(at('**free\nselect;\n  |'), 'when ');
  assert.strictEqual(at('PGM\nRCVF\n|', 'cl'), 'MONMSG     MSGID(CPF0864) /* end of file */');
});
