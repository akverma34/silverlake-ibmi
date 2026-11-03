const test = require('node:test');
const assert = require('node:assert');
const s = require('../out/rpg/rpgSafetyChecks');
const { lintRpg } = require('../out/rpg/lint');

const SRC = [
  '**free', 'ctl-opt nomain;',
  "dcl-f cust disk extfile('PRODLIB/CUSTMAST');",
  "dcl-f tmp disk extfile('QTEMP/WORK');",
  'dcl-pr calc int(10);', '  a int(10) const;', '  b char(5) const;', 'end-pr;',
  'dcl-pr opt;', '  a int(10);', '  b int(10) options(*nopass);', 'end-pr;',
  'dcl-proc calc export;', '  dcl-pi *n int(10);', '    a int(10) const;', '  end-pi;', '  a = 5;', '  return a;', 'end-proc;',
  'dcl-proc main;', '  dcl-s x int(10);', '  x = calc(1);', "  x = calc(1: 'a:b': 3);", '  opt(1);', '  opt(1: 2);', '  opt();', '  leave;',
  '  dow 1 = 1;', '    x += 1;', '  enddo;',
  '  dow 1 = 1;', '    if x > 3;', '      leave;', '    endif;', '  enddo;',
  '  exec sql select * into :x from prodlib.t1 join qsys2.systables s on 1 = 1;', 'end-proc;',
  'dcl-proc opt;', '  dcl-pi *n;', '    a int(10);', '    b int(10) options(*nopass);', '  end-pi;', 'end-proc;',
].join('\n');

const found = (src, rule) => s.safetyLint(src).filter(f => f.rule === rule).map(f => f.line + 1);

test('all six rules are described and wired into lintRpg', () => {
  assert.strictEqual(Object.keys(s.SAFETY_RULES).length, 6);
  const rules = new Set(lintRpg(SRC).map(f => f.rule));
  for (const r of Object.keys(s.SAFETY_RULES)) { assert.ok(rules.has(r), r); }
  assert.ok(!lintRpg(SRC, { rules: { 'infinite-loop': false } }).some(f => f.rule === 'infinite-loop'));
});

test('prototype against procedure interface', () => {
  assert.deepStrictEqual(found(SRC, 'prototype-mismatch'), [5]);
  const ok = '**free\ndcl-pr p char(5);\n  a int(10) const;\nend-pr;\ndcl-proc p;\n  dcl-pi *n char(5);\n    a  int(10)  CONST;\n  end-pi;\n  return a;\nend-proc;\n';
  assert.deepStrictEqual(found(ok, 'prototype-mismatch'), []);
  assert.deepStrictEqual(found(ok.replace('char(5);\n  a', 'char(6);\n  a'), 'prototype-mismatch'), [2]);
  assert.deepStrictEqual(found(ok.replace('    a  int(10)  CONST;', '    a  int(10);'), 'prototype-mismatch'), [3]);
});

test('calls with the wrong number of arguments, literals and *NOPASS understood', () => {
  assert.deepStrictEqual(found(SRC, 'call-argument-count'), [22, 23, 26]);
  assert.deepStrictEqual(s.callArguments("f(a: g(b: c): 'x')", 1), { args: ['a', 'g(b: c)', "'x'"], end: 17 });
  assert.deepStrictEqual(s.callArguments('f()', 1).args, []);
  assert.strictEqual(s.callArguments('f(a', 1), undefined);
});

test('CONST parameters changed, loops and LEAVE', () => {
  assert.deepStrictEqual(found(SRC, 'assign-to-const'), [17]);
  assert.deepStrictEqual(found(SRC, 'infinite-loop'), [28]);
  assert.deepStrictEqual(found(SRC, 'leave-outside-loop'), [27]);
  assert.deepStrictEqual(found('**free\ndow *on;\n  for i = 1 to 3;\n    leave;\n  endfor;\nenddo;\n', 'infinite-loop'), [2]);
  assert.deepStrictEqual(found('**free\ndou 0 = 1;\n  return;\nenddo;\n', 'infinite-loop'), []);
});

test('hard-coded libraries, system libraries allowed', () => {
  assert.deepStrictEqual(found(SRC, 'hardcoded-library'), [3, 36]);
  assert.deepStrictEqual(found('**free\nexec sql select a.x into :v from t1 a;\n', 'hardcoded-library'), []);
});

test('tolerant on odd input', () => {
  for (const t of ['', '**free', 'dcl-pr', '**free\ndcl-pi *n;\n', '**free\nx = f(;\n', '     C                   LEAVE']) {
    assert.doesNotThrow(() => s.safetyLint(t));
  }
  assert.deepStrictEqual(found('     C     1             DOWEQ     1\n     C                   LEAVE\n     C                   ENDDO\n', 'leave-outside-loop'), []);
});
