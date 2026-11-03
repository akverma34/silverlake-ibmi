const test = require('node:test');
const assert = require('node:assert');
const m = require('../out/rpg/rpgModuleTools');
const { snippetEscape, surround, callSnippet } = require('../out/rpg/rpgProductivity');

const MOD = [
  '**free', 'ctl-opt nomain;', 'dcl-s counter int(10) export;',
  'dcl-proc calc export;', '  dcl-pi *n int(10);', '    a int(10) const;', '  end-pi;', '  return a;', 'end-proc;',
  '// Formats a name', 'dcl-proc fmt export;', '  dcl-pi *n varchar(50);', '    n char(20) const;', '  end-pi;', '  return %trim(n);', 'end-proc;',
  'dcl-proc local;', 'end-proc;',
].join('\n');

test('exports and binder source, keeping the order of an existing list', () => {
  assert.deepStrictEqual(m.exportsOf(MOD).map(e => [e.name, e.kind]), [['counter', 'data'], ['calc', 'procedure'], ['fmt', 'procedure']]);
  const b = m.binderSource(MOD, 'utils');
  assert.match(b, /STRPGMEXP {2}PGMLVL\(\*CURRENT\) SIGNATURE\('UTILS V1'\)\n {2}EXPORT {5}SYMBOL\('COUNTER'\)\n {2}EXPORT {5}SYMBOL\('CALC'\)\n {2}EXPORT {5}SYMBOL\('FMT'\)\nENDPGMEXP/);
  const upd = m.binderSource(MOD, 'utils', "STRPGMEXP\n EXPORT SYMBOL('FMT')\n EXPORT SYMBOL(OLD)\nENDPGMEXP");
  assert.match(upd, /SYMBOL\('FMT'\)\n {2}EXPORT {5}SYMBOL\('COUNTER'\)\n {2}EXPORT {5}SYMBOL\('CALC'\)/);
  assert.match(upd, /Not exported any more: OLD/);
  assert.ok(!/SYMBOL\('OLD'\)/.test(upd));
  assert.throws(() => m.binderSource('**free\ndcl-proc x;\nend-proc;', 'X'));
});

test('prototype copybook with a /COPY guard', () => {
  const c = m.prototypeCopybook(MOD, 'utils');
  assert.match(c, /^\*\*free\n/);
  assert.match(c, /\/if defined\(UTILS_P\)\n\/eof\n\/endif\n\/define UTILS_P/);
  assert.match(c, /dcl-pr calc int\(10\) extproc\('CALC'\);\n {2}a int\(10\) const;\nend-pr;/);
  assert.match(c, /dcl-pr fmt varchar\(50\) extproc\('FMT'\);/);
  assert.ok(!/local/.test(c));
});

test('documentation headers only where there is no comment', () => {
  const h = m.documentationHeaders(MOD);
  assert.deepStrictEqual(h.map(x => x.line), [3, 16]);
  assert.match(h[0].text, /\/\/ calc: TODO describe what it does\n\/\/\n\/\/ @param a {2}int\(10\) const\n\/\/ @return int\(10\)/);
});

test('join the lines of a statement', () => {
  assert.strictEqual(m.joinStatement(['  x = calc(', '        1:', '        2);']), '  x = calc(1: 2);');
  assert.throws(() => m.joinStatement(['x = 1; // done', 'y = 2;']), /comment/);
  assert.throws(() => m.joinStatement(['x = 1;', 'y = 2;']), /more than one/);
  assert.throws(() => m.joinStatement(["x = 'abc", "def';"]), /literal/);
  assert.throws(() => m.joinStatement(['x = 1;']));
  assert.strictEqual(m.joinStatement(["msg = 'a // b' +", "  'c';"]), "msg = 'a // b' + 'c';");
});

test('unused declarations that can be removed safely', () => {
  const t = '**free\ndcl-s a int(10);\ndcl-s b int(10) export;\ndcl-ds c;\n  x int(10);\nend-ds;\ndcl-c d 5; // note\n';
  assert.deepStrictEqual(m.removableDeclarations(t, [{ line: 1, name: 'a' }, { line: 2, name: 'b' }, { line: 3, name: 'c' }, { line: 6, name: 'd' }, { line: 1, name: 'zz' }]), [1, 6]);
});

test('prototype brought back in line with the interface', () => {
  const t = "**free\ndcl-pr calc int(5) extproc('CALC');\n  a int(10);\nend-pr;\ndcl-proc calc;\n  dcl-pi *n int(10);\n    a int(10) const;\n    b char(3) const options(*nopass);\n  end-pi;\n  return a;\nend-proc;\n";
  assert.deepStrictEqual(m.syncPrototype(t, 'CALC'), { start: 1, end: 3, lines: ["dcl-pr calc int(10) extproc('CALC');", '  a int(10) const;', '  b char(3) const options(*nopass);', 'end-pr;'] });
  assert.strictEqual(m.syncPrototype(t, 'nope'), undefined);
});

test('snippet text is escaped', () => {
  assert.strictEqual(snippetEscape('a$b}c\\d'), 'a\\$b\\}c\\\\d');
  assert.match(surround("x = '$1 }';", 'if'), /x = '\\\$1 \\\}';/);
  assert.strictEqual(callSnippet('$get', [{ name: 'a' }]), '\\$get(${1:a})');
});
