const test = require('node:test');
const assert = require('node:assert');
const d = require('../out/rpg/rpgProductivity');

const rules = (src, o) => d.dailyLint(src, o).map(f => f.rule);

test('every daily rule has a description', () => {
  assert.strictEqual(Object.keys(d.DAILY_RULES).length, 19);
  for (const v of Object.values(d.DAILY_RULES)) { assert.ok(v.length > 10); }
});

test('daily checks on free-form code', () => {
  const src = [
    '**free',
    'dcl-f custmast keyed;',
    'dcl-s name char(3);',
    'dcl-s name char(5);',
    'exec sql declare c1 cursor for select * from t;',
    'exec sql open c1;',
    'exec sql fetch c1 into :name;',
    "name = 'TOO LONG';",
    'chain 1 custmast;',
    "dsply 'debug';",
    'if name = *blanks;',
    'endif;',
    'select;',
    '  when name = \'A\';',
    '    name = \'B\';',
    'endsl;',
    'dow 1 = 1;',
    '  leave;',
    '  name = \'C\';',
    'enddo;',
    'dcl-proc calc;',
    '  dcl-pi *n int(10);',
    '    unused char(10);',
    '  end-pi;',
    'end-proc;',
  ].join('\n');
  const r = rules(src);
  for (const want of ['missing-ctl-opt', 'duplicate-declaration', 'cursor-not-closed', 'literal-too-long', 'chain-without-found', 'dsply', 'empty-block', 'select-without-other', 'unreachable-code', 'missing-return', 'unused-procedure', 'unused-parameter', 'unchecked-sql']) {
    assert.ok(r.includes(want), `${want} expected in ${r.join(', ')}`);
  }
});

test('input parameters that could be CONST', () => {
  const src = '**free\nctl-opt;\ndcl-proc p export;\n  dcl-pi *n;\n    a char(10);\n  end-pi;\n  dsply a;\nend-proc;\n';
  assert.ok(rules(src).includes('missing-const'));
  assert.ok(!rules(src.replace('char(10);', 'char(10) const;')).includes('missing-const'));
});

test('daily checks can be turned off and respect includes', () => {
  const src = "**free\ndsply 'x';\n";
  assert.ok(rules(src).includes('dsply'));
  assert.ok(!rules(src, { enabled: r => r !== 'dsply' }).includes('dsply'));
  assert.ok(!rules(src, { isInclude: true }).includes('missing-ctl-opt'));
});

test('deep nesting uses the configured level', () => {
  const src = '**free\nctl-opt;\nif a;\n if b;\n  if c;\n  endif;\n endif;\nendif;\n';
  assert.ok(rules(src, { maxNesting: 2 }).includes('deep-nesting'));
  assert.ok(!rules(src, { maxNesting: 6 }).includes('deep-nesting'));
});

test('fixed-format deprecated operation codes', () => {
  const src = '     C                   Z-ADD     0             X                 5 0\n     C                   MOVE      A             B\n';
  assert.ok(rules(src).includes('deprecated-opcode'));
});

test('closing blocks', () => {
  assert.deepStrictEqual(d.closeBlock('**free\nif x;\n  y = 1;\n', 2), { close: 'endif;', indent: '' });
  assert.deepStrictEqual(d.autoCloseFor('**free\n  dow x;\n', 1), { close: 'enddo;', indent: '  ' });
  assert.strictEqual(d.closeBlock('**free\nx = 1;\n', 1), undefined);
});

test('IF / ELSEIF to SELECT', () => {
  const out = d.ifToSelect('if a = 1;\n  x = 1;\nelseif a = 2;\n  x = 2;\nelse;\n  x = 3;\nendif;');
  assert.match(out, /^select;\n  when a = 1;\n    x = 1;\n  when a = 2;[\s\S]*other;\n    x = 3;\nendsl;$/);
  assert.throws(() => d.ifToSelect('x = 1;'));
});

test('surround with a block', () => {
  assert.match(d.surround('x = 1;', 'monitor'), /^monitor;\n  x = 1;\non-error/);
  assert.match(d.surround('x = 1;', 'if'), /^if .*;\n  x = 1;\nendif;/);
});

test('comments, keyword case and declarations', () => {
  assert.deepStrictEqual(d.toggleComments(['  x = 1;', '  y = 2;'], true), ['  // x = 1;', '  // y = 2;']);
  assert.deepStrictEqual(d.toggleComments(['  // x = 1;'], true), ['  x = 1;']);
  assert.strictEqual(d.keywordCase("IF X = 1;\n  DSPLY 'IF';\nENDIF;", 'lower'), "if X = 1;\n  dsply 'IF';\nendif;");
  assert.deepStrictEqual(d.sortDeclarations(['dcl-s zeta int(10);', 'dcl-s alpha char(1);']), ['dcl-s alpha char(1);', 'dcl-s zeta int(10);']);
  assert.throws(() => d.sortDeclarations(['dcl-s a int(10);', 'x = 1;']));
  assert.deepStrictEqual(d.alignDeclarations(['dcl-s a int(10);', 'dcl-s longname char(1);']), ['dcl-s a        int(10);', 'dcl-s longname char(1);']);
});

test('wrapping, ruler and change markers', () => {
  const long = '  x = ' + 'aaaa + '.repeat(20) + 'b;';
  const w = d.wrapLine(long, 40);
  assert.ok(w.length > 1 && w.every(l => l.length <= 40));
  assert.strictEqual(w.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
  assert.ok(d.rulerLine(true).includes('....+....2'));
  assert.ok(d.rulerLine(false).startsWith('//'));
  assert.deepStrictEqual(d.clearChangeMarkers(['ABCDE C   x', '     C  y'], false), { lines: ['      C   x', '     C  y'], changed: 1 });
});

test('procedures: skeleton, calls, hints, navigation and prototypes', () => {
  const src = "**free\ndcl-proc foo export;\n  dcl-pi *n int(10);\n    a char(10);\n    b int(10) const;\n  end-pi;\n  if a = 'X';\n    return b;\n  endif;\n  return 0;\nend-proc;\n";
  assert.match(d.procedureHeader('calc', [{ name: 'a', definition: 'int(10) const' }], 'int(10)'), /@param a {2}int\(10\) const/);
  assert.strictEqual(d.callSnippet('calc', [{ name: 'a' }, { name: 'b' }]), 'calc(${1:a}: ${2:b})');
  assert.deepStrictEqual(d.callArgumentHints('  r = calc(1: x);', new Map([['CALC', ['a', 'b']]])), [{ at: 11, name: 'a' }, { at: 14, name: 'b' }]);
  assert.strictEqual(d.procedureAt(src, 7), 'foo');
  assert.deepStrictEqual(d.procedureStarts(src), [1]);
  assert.strictEqual(d.prototypeFrom(src, 'foo'), "dcl-pr foo int(10) extproc('FOO');\n  a char(10);\n  b int(10) const;\nend-pr;\n");
  assert.strictEqual(d.prototypeFrom(src, 'nope'), undefined);
});

test('embedded SQL under the cursor', () => {
  const s = d.embeddedSqlAt('**free\n  exec sql select a into :b\n    from t where c = 1;\nx=1;', 2);
  assert.deepStrictEqual(s, { start: 1, end: 2, sql: 'select a into :b\n    from t where c = 1', indent: '  ' });
  assert.strictEqual(d.embeddedSqlAt('**free\nx = 1;\n', 1), undefined);
});

test('tolerant on empty and odd input', () => {
  for (const t of ['', '**free', '     H', '\n\n\n']) {
    assert.doesNotThrow(() => d.dailyLint(t));
    assert.doesNotThrow(() => d.procedureStarts(t));
    assert.doesNotThrow(() => d.closeBlock(t, 0));
  }
});
