const test = require('node:test');
const assert = require('node:assert');
const d = require('../out/core/ddsChecks');
const e = require('../out/core/editorExtras');
const s = require('../out/rpg/rpgSemantics');

/** A DDS line from its columns. */
const A = (t17, name, ref, len, typ, dec, use, row, col, kw) => ('     A' + ' '.repeat(10) + (t17 || ' ') + ' ' + (name || '').padEnd(10) + (ref || ' ') + String(len ?? '').padStart(5) + (typ || ' ') + String(dec ?? '').padStart(2) + (use || ' ') + String(row ?? '').padStart(3) + String(col ?? '').padStart(3) + (kw || '')).replace(/\s+$/, '');

test('DDS physical file checks', () => {
  const pf = [A('R', 'CUSTREC'), A('', 'CUSTNO', '', 7, 'P', 0), A('', 'CUSTNAMELONG', '', 30, 'A'), A('', 'CUSTNO', '', 7, 'P', 0), A('', 'AMT', '', 5, 'P', 7), A('', 'NOLEN'), A('', 'BIG', '', 40000, 'A'), A('', 'REFD', 'R'), A('K', 'CUSTNO'), A('K', 'MISSING')].join('\n');
  assert.deepStrictEqual(d.ddsLint(pf, 'pf').map(f => [f.line + 1, f.rule]), [[3, 'dds-name-too-long'], [4, 'dds-duplicate-name'], [5, 'dds-decimals'], [6, 'dds-missing-length'], [7, 'dds-length-limit'], [10, 'dds-key-not-in-record']]);
  assert.strictEqual(d.ddsLint(pf, 'pf', r => r !== 'dds-decimals').some(f => f.rule === 'dds-decimals'), false);
  assert.deepStrictEqual(d.ddsLint(pf.replace(/^.*NOLEN.*$/m, ''), 'lf').filter(f => f.rule === 'dds-missing-length' || f.rule === 'dds-key-not-in-record'), []);
  assert.deepStrictEqual(d.ddsLint('     A                                      REF(FLDREF)\n' + A('R', 'R1') + '\n' + A('', 'X'), 'pf'), []);
});

test('DDS display file positions', () => {
  const dspf = ['     A                                      DSPSIZ(24 80 *DS3)', A('R', 'SCR1'), A('', 'FLD1', '', 10, 'A', '', 'B', 1, 2), A('', 'FLD2', '', 5, 'A', '', 'B', 1, 8), A('', '', '', '', '', '', '', 2, 75, "'Very long constant'"), A('', 'FLD3', '', 10, 'A', '', 'O', 25, 1), A('', 'OK', '', 5, 'A', '', 'O', 3, 1)].join('\n');
  assert.deepStrictEqual(d.ddsLint(dspf, 'dspf').map(f => [f.line + 1, f.rule]), [[4, 'dds-overlap'], [5, 'dds-off-screen'], [6, 'dds-off-screen']]);
  assert.deepStrictEqual(d.ddsLint(dspf.replace('DSPSIZ(24 80 *DS3)', 'DSPSIZ(24 80 *DS3 27 132 *DS4)'), 'dspf').map(f => f.rule), ['dds-overlap']);
  assert.strictEqual(d.ddsKind('/LIB/QDDSSRC/SCR.dspf'), 'dspf');
  for (const t of ['', '     A', '     A*comment', 'garbage']) { assert.doesNotThrow(() => d.ddsLint(t, 'dspf')); }
});

test('CL formatting', () => {
  const out = e.formatCl("PGM PARM(&A)\nLOOP: chgvar var(&A) value('x')\nSNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('This is a long message text for the user') MSGTYPE(*ESCAPE)\n/* comment */\nENDPGM").split('\n');
  assert.strictEqual(out[0], '             PGM        PARM(&A)');
  assert.strictEqual(out[1], "LOOP:        chgvar     var(&A) value('x')");
  assert.strictEqual(out[2], '             SNDPGMMSG  MSGID(CPF9898) MSGF(QCPFMSG) +');
  assert.strictEqual(out[3], "                        MSGDTA('This is a long message text for the user') +");
  assert.strictEqual(out[5], '/* comment */');
  assert.ok(out.every(l => l.length <= 80));
  assert.strictEqual(e.formatCl(e.formatCl(out.join('\n'))), e.formatCl(out.join('\n')));
});

test('links that open a member at a line', () => {
  const link = e.memberLink({ system: 'DEV', library: 'applib', file: 'qrpglesrc', member: 'pgm1', type: 'rpgle', line: 42 });
  assert.strictEqual(link, 'vscode://gauravgupta0612.vanthrex-ibmi/open?system=DEV&member=APPLIB%2FQRPGLESRC%2FPGM1&type=rpgle&line=42');
  assert.deepStrictEqual(e.parseLink(link.split('?')[1]), { system: 'DEV', library: 'APPLIB', file: 'QRPGLESRC', member: 'PGM1', type: 'rpgle', line: 42 });
  assert.deepStrictEqual(e.parseLink('ifs=%2Fhome%2Fgg%2Fa.sql&line=3'), { system: undefined, path: '/home/gg/a.sql', line: 3 });
  assert.throws(() => e.parseLink('member=../x'));
  assert.throws(() => e.parseLink('ifs=..%2Fetc'));
  assert.throws(() => e.parseLink('member=A/B/C&type=rpg le'));
});

test('IBM i references in terminal output', () => {
  assert.deepStrictEqual(e.terminalRefs('Error CPF9801 in APPLIB/QRPGLESRC(PGM1) see /home/gg/log.txt, and MCH1210.').map(r => [r.kind, r.text]),
    [['message', 'CPF9801'], ['member', 'APPLIB/QRPGLESRC(PGM1)'], ['ifs', '/home/gg/log.txt'], ['message', 'MCH1210']]);
  assert.deepStrictEqual(e.terminalRefs('nothing here 12345'), []);
});

test('END lines indented to their opener', () => {
  assert.strictEqual(e.indentForCloser(['**free', 'dcl-proc p;', '  if a;', '    x = 1;', '  else;'], 4), '  ');
  assert.strictEqual(e.indentForCloser(['if a;', '  dow b;', '  enddo;', '    endif;'], 3), '');
  assert.strictEqual(e.indentForCloser(['select;', '  when x;', '    a=1;', '    when y;'], 3), '  ');
  assert.strictEqual(e.indentForCloser(['dcl-ds d likeds(x);', 'end-proc;'], 1), undefined);
  assert.strictEqual(e.indentForCloser(['x = 1;'], 0), undefined);
});

test('names edited together', () => {
  assert.deepStrictEqual(e.linkedNames(['dcl-proc calc;', '  dcl-ds x;', '  end-ds x;', 'end-proc calc;'], 0, 11), [{ line: 0, start: 9, end: 13 }, { line: 3, start: 9, end: 13 }]);
  assert.deepStrictEqual(e.linkedNames(['dcl-proc calc;', 'end-proc calc;'], 1, 10), [{ line: 0, start: 9, end: 13 }, { line: 1, start: 9, end: 13 }]);
  assert.strictEqual(e.linkedNames(['dcl-proc calc;', 'end-proc;'], 0, 10), undefined);
});

test('semantic tokens', () => {
  const t = s.semanticTokens("**free\ndcl-c MAX 10;\ndcl-s total int(10);\ndcl-ds cust qualified;\n  name char(10);\nend-ds;\ndcl-proc p;\n  dcl-pi *n;\n    q int(10) const;\n  end-pi;\n  total = q + MAX;\n  cust.name = 'x';\nend-proc;");
  const at = (line, start) => t.find(x => x.line === line && x.start === start);
  const ty = x => s.TOKEN_TYPES[x.type];
  assert.strictEqual(ty(at(1, 6)), 'variable'); assert.strictEqual(at(1, 6).modifiers, 3); // declaration + readonly
  assert.strictEqual(ty(at(10, 10)), 'parameter'); assert.strictEqual(at(10, 10).modifiers, 2); // CONST → readonly
  assert.strictEqual(at(10, 2).modifiers, 4); // global used in a procedure
  assert.strictEqual(ty(at(11, 7)), 'property');
  assert.deepStrictEqual(s.semanticTokens('x'.repeat(10) + '\n'.repeat(50), 10), []);
});
