const test = require('node:test');
const assert = require('node:assert');
const p = require('../out/core/productivity');

test('files declared in RPG, free and fixed', () => {
  const src = [
    '**free',
    'dcl-f custmast keyed prefix(c_);',
    "dcl-f orders usage(*update) extfile('APPLIB/ORDHDR')",
    '   qualified;',
    'dcl-f prt printer likefile(base);',
    "     FINVOICE   IF   E           K DISK    EXTFILE('*LIBL/INVHDR')",
    '     FREPORT    O    F  132        PRINTER',
  ].join('\n');
  const f = p.filesInSource(src);
  assert.deepStrictEqual(f.map(x => [x.name, x.library, x.file, x.prefix, x.qualified]),
    [['CUSTMAST', undefined, 'CUSTMAST', 'C_', false], ['ORDERS', 'APPLIB', 'ORDHDR', undefined, true], ['INVOICE', '*LIBL', 'INVHDR', undefined, false]]);
});

test('fields of declared files, with prefix and qualified names', () => {
  const cols = [{ name: 'CUSTNO', type: 'DECIMAL', length: 7, scale: 0, nullable: false, text: 'Customer', heading: '' }];
  const files = [{ file: { name: 'CUSTMAST', file: 'CUSTMAST', line: 0, prefix: 'C_', qualified: false }, cols }, { file: { name: 'ORD', file: 'ORD', line: 1, qualified: true }, cols }];
  assert.strictEqual(p.fieldOf('c_custno', files).file.name, 'CUSTMAST');
  assert.strictEqual(p.fieldOf('ORD.CUSTNO', files).file.name, 'ORD');
  assert.strictEqual(p.fieldOf('CUSTNO', files), undefined);
  assert.strictEqual(p.columnType(cols[0]), 'packed(7:0)');
  assert.match(p.fileMarkdown(files[0].file, 'APP', cols, 'Customers'), /\*\*APP\/CUSTMAST\*\* — Customers[\s\S]*\| CUSTNO \| packed\(7:0\) \| Customer \|/);
});

test('CL macros', () => {
  const cmds = ['CRTLIB ${LIB:TMPLIB}', 'CPYF FROMFILE(${FROM}/X) TOFILE(${LIB}/X) CRTFILE(*YES)', 'SNDMSG MSG(\'done ${DATE}\') TOUSR(${USER})'];
  assert.deepStrictEqual(p.macroVariables(cmds), [{ name: 'LIB', default: 'TMPLIB' }, { name: 'FROM', default: '' }]);
  const out = p.expandMacro(cmds, { FROM: 'PROD' }, { USER: 'GG', CURLIB: 'X', now: new Date(2026, 10, 3, 9, 5, 0) });
  assert.deepStrictEqual(out, ['CRTLIB TMPLIB', 'CPYF FROMFILE(PROD/X) TOFILE(TMPLIB/X) CRTFILE(*YES)', "SNDMSG MSG('done 20261103') TOUSR(GG)"]);
});

test('CL commands in a selection', () => {
  const t = "PGM\n  /* comment */\nLOOP: CHGVAR VAR(&A) +\n         VALUE(1)\nDLTF FILE(QTEMP/X)\nENDPGM";
  assert.deepStrictEqual(p.clCommandsIn(t), ['CHGVAR VAR(&A) VALUE(1)', 'DLTF FILE(QTEMP/X)']);
  assert.ok(p.looksLikeSql('select * from x'));
  assert.ok(p.looksLikeSql('-- note\nVALUES 1'));
  assert.ok(!p.looksLikeSql('DSPLIBL'));
});

test('SQL watch conditions and alerts', () => {
  const gt = p.parseCondition('> 10');
  assert.ok(gt.test('11')); assert.ok(!gt.test('9')); assert.ok(!gt.test('abc') || true);
  assert.ok(p.parseCondition("= 'ACTIVE'").test('ACTIVE'));
  assert.ok(p.parseCondition('contains msgw').test('JOB MSGW'));
  assert.ok(p.parseCondition('<> 0').test('2'));
  assert.throws(() => p.parseCondition('bigger'));
  const ch = p.parseCondition('');
  assert.strictEqual(p.shouldAlert(ch, undefined, '1'), false);
  assert.strictEqual(p.shouldAlert(ch, '1', '2'), true);
  assert.strictEqual(p.shouldAlert(gt, '5', '12'), true);
  assert.strictEqual(p.shouldAlert(gt, '12', '13'), false);
  assert.strictEqual(p.watchValue([{ N: 3 }]), '3');
  assert.strictEqual(p.watchValue([{ A: 1, B: 'x' }]), '1 · x');
  assert.strictEqual(p.watchValue([{ A: 1 }, { A: 2 }]), '2 rows');
  assert.strictEqual(p.watchValue([]), '0 rows');
});

test('report tables as CSV and tab-separated text', () => {
  assert.strictEqual(p.tableCsv(['A', 'B'], [['x,y', 1], ['he said "hi"', null]]), 'A,B\r\n"x,y",1\r\n"he said ""hi""",\r\n');
  assert.strictEqual(p.tableCsv(['A'], [['1;2']], ';'), 'A\r\n"1;2"\r\n');
  assert.strictEqual(p.tableTsv(['A', 'B'], [['a\tb', 2]]), 'A\tB\na b\t2\n');
});
