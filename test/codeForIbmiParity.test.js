const test = require('node:test');
const assert = require('node:assert');
const f = require('../out/core/objectFilters');
const a = require('../out/core/actions');
const m = require('../out/core/migration');
const { substituteVariables } = require('../out/core/util');

test('object filter: checked and normalised', () => {
  assert.deepStrictEqual(f.checkFilter({ name: ' Orders ', library: 'ord*, applib', object: '', types: [], member: 'a*', memberType: 'rpgle,sqlrpgle' }),
    { name: 'Orders', library: 'ORD*, APPLIB', object: '*', types: ['*ALL'], member: 'A*', memberType: 'RPGLE, SQLRPGLE' });
  assert.throws(() => f.checkFilter({ name: '', library: 'X' }), /name/);
  assert.throws(() => f.checkFilter({ name: 'x', library: '' }), /library/);
  assert.throws(() => f.checkFilter({ name: 'x', library: '*' }), /every library/);
  assert.throws(() => f.checkFilter({ name: 'x', library: "A'B" }), /not a valid library/);
  assert.throws(() => f.checkFilter({ name: 'x', library: 'A', types: ['PGM'] }), /object type/);
});

test('object filter: SQL pieces', () => {
  const flt = f.checkFilter({ name: 'x', library: 'ORD*, APPLIB', object: 'ORD_*', types: ['*PGM', '*SRCPF'], member: '*', memberType: 'RPG*' });
  assert.strictEqual(f.likePattern('A_B*%'), 'A!_B%!%');
  assert.strictEqual(f.nameCondition('OBJNAME', '*'), undefined);
  assert.strictEqual(f.nameCondition('OBJNAME', 'ORD_*, APPLIB'), "(OBJNAME LIKE 'ORD!_%' ESCAPE '!' OR OBJNAME = 'APPLIB')");
  assert.strictEqual(f.exactLibraries(flt), undefined);
  assert.deepStrictEqual(f.exactLibraries(f.checkFilter({ name: 'x', library: 'A, B' })), ['A', 'B']);
  assert.match(f.filterLibrariesSql(flt), /OBJECT_STATISTICS\('QSYS', '\*LIB'\)\) X WHERE \(OBJNAME LIKE 'ORD%' ESCAPE '!' OR OBJNAME = 'APPLIB'\)/);
  assert.deepStrictEqual(f.filterShows(flt), { source: true, objects: true });
  assert.deepStrictEqual(f.filterShows(f.checkFilter({ name: 'x', library: 'A', types: ['*SRCPF'] })), { source: true, objects: false });
  assert.deepStrictEqual(f.objectArgs(flt), { types: '*PGM', where: " WHERE OBJNAME LIKE 'ORD!_%' ESCAPE '!'" });
  assert.strictEqual(f.sourceFileCondition(flt), " AND SYSTEM_TABLE_NAME LIKE 'ORD!_%' ESCAPE '!'");
  assert.strictEqual(f.memberCondition(flt), " AND SOURCE_TYPE LIKE 'RPG%' ESCAPE '!'");
  assert.strictEqual(f.describeFilter(flt), 'ORD*, APPLIB/ORD_* *PGM *SRCPF · types RPG*');
});

test('Code for IBM i filters imported, regex ones too', () => {
  assert.deepStrictEqual(f.fromCodeForIbmiFilters([
    { name: 'Dev', library: 'DEVLIB', object: '*', types: ['*ALL'], member: '*', memberType: '*' },
    { name: 'Re', library: 'APPLIB', object: '^ORD[0-9]+$', filterType: 'regex' },
    { name: 'Bad regex', library: 'APPLIB', object: '([', filterType: 'regex' },
    { name: 'Bad', library: '' },
  ]).map(x => [x.name, !!x.regex]), [['Dev', false], ['Re', true]]);
});

test('action variables', () => {
  const ctx = a.contextVariables({ host: 'dev.example.com', user: 'GG', libraries: ['APPLIB', 'qgpl'], branch: 'feature/x', custom: { tgtrls: 'V7R4M0', 'bad name': 'x', LIB: 'nope' } });
  assert.deepStrictEqual(ctx, { TGTRLS: 'V7R4M0', HOST: 'dev.example.com', USER: 'GG', USERNAME: 'GG', HOME: '/home/gg', WORKDIR: '/home/gg', CURLIB: 'QGPL', LIBLS: 'APPLIB QGPL', LIBLC: 'APPLIB,QGPL', BRANCH: 'feature/x' });
  assert.deepStrictEqual(a.ifsVariables('/home/gg/src/my_pgm.pgm.rpgle', 'src/my_pgm.pgm.rpgle'),
    { NAME: 'MY_PGM', EXT: 'rpgle', BASENAME: 'my_pgm.pgm.rpgle', PARENT: 'src', FULLPATH: '/home/gg/src/my_pgm.pgm.rpgle', RELATIVEPATH: 'src/my_pgm.pgm.rpgle' });
  assert.strictEqual(a.memberVariables('LIB', 'QRPGLESRC', 'PGM1', 'RPGLE').BASENAME, 'PGM1.rpgle');
  assert.deepStrictEqual(a.objectVariables('LIB', 'PGM1', '*PGM', 'RPGLE'), { LIB: 'LIB', LIBRARY: 'LIB', NAME: 'PGM1', TYPE: 'PGM', EXT: 'RPGLE', BASENAME: 'PGM1.pgm', FULLPATH: '/QSYS.LIB/LIB.LIB/PGM1.PGM' });
  assert.strictEqual(substituteVariables('CRTBNDRPG PGM(&LIBRARY/&NAME) TGTRLS(&TGTRLS) &LIBLS', { LIB: 'L', LIBRARY: 'LIBX', NAME: 'N', TGTRLS: 'V7', LIBLS: 'A B' }), 'CRTBNDRPG PGM(LIBX/N) TGTRLS(V7) A B');
  assert.deepStrictEqual(a.unresolvedVariables('X &BRANCH &MYVAR &branch'), ['&BRANCH']);
  assert.strictEqual(a.checkVariableName('&tgtrls'), 'TGTRLS');
  assert.throws(() => a.checkVariableName('HOME'), /built-in/);
  assert.throws(() => a.checkVariableName('1X'), /letters/);
});

test('git branch, environments and shell commands', () => {
  assert.strictEqual(a.gitBranch('ref: refs/heads/feature/abc\n'), 'feature/abc');
  assert.strictEqual(a.gitBranch('3f2a9c1d'), undefined);
  assert.strictEqual(a.actionEnvironment({ environment: 'PASE' }), 'pase');
  assert.strictEqual(a.actionEnvironment({}), 'ile');
  assert.strictEqual(a.shellCommand('pase', 'make all', "/home/o'b"), "cd '/home/o'\\''b' && make all");
  assert.strictEqual(a.shellCommand('qsh', "echo 'hi'", '/x'), "cd '/x' && /QOpenSys/usr/bin/qsh -c 'echo '\\''hi'\\'''");
});

test('object actions picked by type or attribute', () => {
  const acts = [
    { name: 'Run', command: 'CALL &LIBRARY/&NAME', extensions: ['PGM'], source: 'object' },
    { name: 'RPG only', command: 'X', extensions: ['rpgle'], source: 'object' },
    { name: 'Any', command: 'DSPOBJD', extensions: ['*'], source: 'object' },
    { name: 'Member', command: 'Y', extensions: ['pgm'], source: 'member' },
  ];
  assert.deepStrictEqual(a.objectActionsFor(acts, '*PGM', 'CLLE').map(x => x.name), ['Run', 'Any']);
  assert.deepStrictEqual(a.objectActionsFor(acts, '*FILE', 'RPGLE').map(x => x.name), ['RPG only', 'Any']);
});

test('Code for IBM i actions converted with custom variables and environments', () => {
  const acts = m.convertActions([
    { name: 'Make', command: 'make &BASENAME BRANCH=&BRANCH', environment: 'pase', type: 'streamfile', extensions: ['GLOBAL'] },
    { name: 'Own', command: 'CRTBNDRPG TGTRLS(&TGTRLS)', type: 'member', extensions: ['RPGLE'] },
    { name: 'Local', command: 'x', type: 'file' },
  ], ['tgtrls']);
  assert.deepStrictEqual(acts.map(x => [x.name, x.source, x.environment, x.extensions, !!x.skipped]),
    [['Make', 'ifs', 'pase', ['*'], false], ['Own', 'member', undefined, ['rpgle'], false], ['Local', 'local', undefined, ['*'], false]]);
  assert.match(m.convertActions([{ name: 'Own', command: 'X &TGTRLS' }])[0].skipped, /TGTRLS/);
});
