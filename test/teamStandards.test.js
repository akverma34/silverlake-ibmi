const test = require('node:test');
const assert = require('node:assert');
const s = require('../out/rpg/rpgStandards');
const m = require('../out/core/migration');
const h = require('../out/core/codeHealth');
const { lintRpg } = require('../out/rpg/lint');

const SRC = ['**free', 'ctl-opt;', 'dcl-c max_len 10;', 'dcl-s Total int(10);', 'dcl-ds rec;', '  a int(10);', 'end-ds;', 'dcl-pr ext1;', 'end-pr;', '/COPY qcpysrc,x',
  'total = 1;', 'if total > 1;', '   total = 2;', 'endif;', 'exsr sub1;', 'begsr sub1;', 'endsr;', 'exec sql select * from a join b on a.k = b.k;', 'exec sql execute immediate :stmt;',
  'dcl-proc p;', '  dcl-pi *n;', '  end-pi;', '  Total = 3;', 'end-proc;'].join('\n');
const rulesOf = (st) => [...new Set(s.standardsLint(SRC, st).map(f => f.rule))];

test('standards are off unless set', () => {
  assert.deepStrictEqual(s.standardsLint(SRC, {}), []);
  assert.ok(!lintRpg(SRC).some(f => f.rule.startsWith('std-')));
});

test('each standard', () => {
  const at = (st) => s.standardsLint(SRC, st).map(f => f.line + 1);
  assert.deepStrictEqual(at({ uppercaseConstants: true }), [3]);
  assert.deepStrictEqual(at({ qualifiedDs: true }), [5]);
  assert.deepStrictEqual(at({ prototypeExt: true }), [8]);
  assert.deepStrictEqual(at({ directiveCase: 'lower' }), [10]);
  assert.deepStrictEqual(at({ directiveCase: 'upper' }), []);
  assert.deepStrictEqual(at({ variableCase: true }), [11, 12, 13]);
  assert.deepStrictEqual(at({ conditionParens: true }), [12]);
  assert.deepStrictEqual(at({ indent: 2 }), [13]);
  assert.deepStrictEqual(at({ noGlobalSubroutines: true }), [16]);
  assert.deepStrictEqual(at({ noLocalSubroutines: true }), []);
  assert.deepStrictEqual(at({ noSqlJoins: true }), [18]);
  assert.deepStrictEqual(at({ noExecuteImmediate: true }), [19]);
  assert.deepStrictEqual(at({ procedureDescription: true }), [20]);
  assert.deepStrictEqual(at({ noGlobalsInProcedures: true }), [23]);
  assert.deepStrictEqual(at({ maxProcedureLines: 3 }), [20]);
  assert.deepStrictEqual(at({ namePattern: '^[a-z][A-Za-z0-9]*$' }), [3, 4]);
  assert.deepStrictEqual(rulesOf({ noOccurs: true, noCtdata: true }), []);
  assert.deepStrictEqual(s.standardsLint('**free\ndcl-ds d occurs(5);\nend-ds;\ndcl-s t char(3) dim(2) ctdata;\n', { noOccurs: true, noCtdata: true }).map(f => f.rule), ['std-no-occurs', 'std-no-ctdata']);
});

test('standards through lintRpg, switchable per rule', () => {
  assert.ok(lintRpg(SRC, { standards: { qualifiedDs: true } }).some(f => f.rule === 'std-qualified-ds'));
  assert.ok(!lintRpg(SRC, { standards: { qualifiedDs: true }, rules: { 'std-qualified-ds': false } }).some(f => f.rule === 'std-qualified-ds'));
});

test('rpglint.json import', () => {
  assert.deepStrictEqual(s.fromRpglint({ indent: 2, UppercaseConstants: true, NoSQLJoins: true, IncorrectVariableCase: false, DirectiveCase: 'lower', Foo: true }),
    { standards: { indent: 2, uppercaseConstants: true, noSqlJoins: true, directiveCase: 'lower' }, ignored: ['Foo'] });
  assert.deepStrictEqual(s.fromRpglint(null), { standards: {}, ignored: [] });
});

test('Code for IBM i import', () => {
  const imp = m.fromCodeForIbmi(
    [{ name: 'DEV', host: 'dev.example.com', port: 22, username: 'gg' }, { name: 'PROD', host: 'p', username: 'x', privateKeyPath: '/k' }, { host: 'nameless' }],
    [{ name: 'DEV', libraryList: ['APPLIB', 'qgpl', 'bad name!'], currentLibrary: 'applib', homeDirectory: '/home/GG', objectFilters: [{}], customVariables: [{ name: 'X' }], connectionProfiles: [{ name: 'Test', libraryList: ['TSTLIB'] }] }],
    [{ name: 'Compile', command: 'CRTBNDRPG PGM(&BUILDLIB/&OPENMBR) SRCFILE(&OPENLIB/&OPENSPF)', extensions: ['RPGLE'], type: 'member', environment: 'ile' },
      { name: 'Shell', command: 'make', environment: 'pase', type: 'streamfile' }, { name: 'Odd', command: 'X &FOO', type: 'member' }, { name: 'Obj', command: 'DSPOBJD', type: 'object' }],
    [{ name: 'Compile', command: 'duplicate' }]);
  assert.deepStrictEqual(imp.profiles.map(p => [p.name, p.user, p.authType, p.libraries.join(' '), p.currentLibrary, p.ifsHome]),
    [['DEV', 'GG', 'password', 'APPLIB QGPL', 'APPLIB', '/home/GG'], ['PROD', 'X', 'key', '', undefined, undefined]]);
  assert.deepStrictEqual(imp.sets, [{ connection: 'DEV', name: 'Test', libraries: ['TSTLIB'], currentLibrary: undefined }]);
  assert.deepStrictEqual(imp.actions.map(a => [a.name, a.command, !!a.skipped]), [['Compile', 'CRTBNDRPG PGM(&OBJLIB/&NAME) SRCFILE(&LIB/&SRCFILE)', false], ['Shell', 'make', true], ['Odd', 'X &FOO', true], ['Obj', 'DSPOBJD', true]]);
  assert.strictEqual(imp.notes.length, 2);
  assert.deepStrictEqual(m.fromCodeForIbmi(undefined, undefined, undefined), { profiles: [], sets: [], actions: [], notes: [] });
});

test('team setup file: no user names, key paths or unknown settings', () => {
  const file = m.teamSetup([{ name: 'DEV', host: 'h', port: 22, user: 'GG', authType: 'key', privateKeyPath: '/home/gg/.ssh/id', libraries: ['A'] }], [], { 'vanthrex.macros': [1], 'vanthrex.other': 2 }, new Date('2026-11-04'));
  assert.strictEqual(file.connections[0].user, '');
  assert.strictEqual(file.connections[0].privateKeyPath, undefined);
  assert.deepStrictEqual(Object.keys(file.settings), ['vanthrex.macros']);
  const back = m.readTeamSetup(JSON.stringify({ ...file, settings: { ...file.settings, 'evil.setting': 1 } }));
  assert.deepStrictEqual(Object.keys(back.settings), ['vanthrex.macros']);
  assert.throws(() => m.readTeamSetup('{"format":"other"}'));
  assert.throws(() => m.readTeamSetup('not json'));
});

test('code health summary', () => {
  const r = h.summarize([{ key: 'A/B/C', type: 'RPGLE', lines: 200, findings: [{ rule: 'x', severity: 'error' }, { rule: 'y', severity: 'warning' }, { rule: 'z', severity: 'hint' }] }, { key: 'A/B/D', type: 'RPGLE', lines: 50, findings: [] }]);
  assert.strictEqual(r.findings, 2);
  assert.deepStrictEqual(r.worst.map(w => [w.key, w.score]), [['A/B/C', 74], ['A/B/D', 100]]);
  assert.strictEqual(r.grade, 'B');
  assert.deepStrictEqual(h.summarize([]), { members: 0, lines: 0, findings: 0, errors: 0, warnings: 0, byRule: [], worst: [], score: 100, grade: 'A' });
});
