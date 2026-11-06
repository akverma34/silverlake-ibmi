const test = require('node:test');
const assert = require('node:assert');
const w = require('../out/core/workbench');

test('library list: move, missing libraries, existence SQL', () => {
  assert.deepStrictEqual(w.moveItem(['A', 'B', 'C'], 'C', -1), ['A', 'C', 'B']);
  assert.deepStrictEqual(w.moveItem(['A', 'B', 'C'], 'A', -1), ['A', 'B', 'C'], 'already first');
  assert.deepStrictEqual(w.moveItem(['A', 'B', 'C'], 'A', 1), ['B', 'A', 'C']);
  assert.deepStrictEqual(w.moveItem(['A', 'B'], 'Z', 1), ['A', 'B']);
  assert.deepStrictEqual(w.missingLibraries(['APPLIB', 'oldlib', 'OLDLIB', 'QGPL'], ['APPLIB', 'QGPL']), ['OLDLIB']);
  assert.strictEqual(w.existingLibrariesSql(["X'; DROP--"]), undefined);
  assert.match(w.existingLibrariesSql(['applib', 'QGPL', 'bad name']), /SYSTEM_SCHEMA_NAME IN \('APPLIB', 'QGPL'\)$/);
});

test('members to and from local files', () => {
  assert.strictEqual(w.memberFileName('pgm1', 'RPGLE'), 'PGM1.rpgle');
  assert.strictEqual(w.memberFileName('X', ''), 'X.mbr');
  assert.strictEqual(w.localMemberPath('C:\\dl\\', 'structured', 'applib', 'qrpglesrc', 'pgm1', 'RPGLE'), 'C:\\dl/APPLIB/QRPGLESRC/PGM1.rpgle');
  assert.strictEqual(w.localMemberPath('/tmp', 'file', 'L', 'QCLSRC', 'M', 'CLLE'), '/tmp/QCLSRC/M.clle');
  assert.strictEqual(w.localMemberPath('/tmp', 'flat', 'L', 'F', 'M', 'TXT'), '/tmp/M.txt');
  assert.deepStrictEqual(w.memberFromFileName('C:\\src\\ordent.sqlrpgle'), { member: 'ORDENT', type: 'SQLRPGLE' });
  assert.deepStrictEqual(w.memberFromFileName('/a/README'), { member: 'README', type: '' });
  assert.strictEqual(w.memberFromFileName('way-too-long-name.rpgle'), undefined);
  assert.strictEqual(w.memberFromFileName('a.b.c'), undefined);
  assert.match(w.sourceMembersSql('applib', 'qrpglesrc'), /SYSTEM_TABLE_SCHEMA = 'APPLIB' AND SYSTEM_TABLE_NAME = 'QRPGLESRC' AND SOURCE_TYPE IS NOT NULL/);
  assert.doesNotMatch(w.sourceMembersSql('APPLIB'), /SYSTEM_TABLE_NAME =/);
  assert.throws(() => w.sourceMembersSql("A'--"));
  assert.ok(w.isSystemName('$ABC') && !w.isSystemName('1ABC') && !w.isSystemName('ABCDEFGHIJK'));
});

test('shared snippets and finding IFS files by name', () => {
  assert.strictEqual(w.snippetFolder(undefined, 'me'), '/home/ME/.vanthrex/snippets');
  assert.strictEqual(w.snippetFolder('/shared/snippets/', 'me'), '/shared/snippets');
  assert.strictEqual(w.snippetFolder('/home/{user}/snip', 'jo'), '/home/JO/snip');
  assert.strictEqual(w.snippetFileName(' Read customer, by id! ', 'RPGLE'), 'Read_customer_by_id.rpgle');
  assert.strictEqual(w.snippetFileName('../../etc', 'x'), 'etc.x');
  assert.strictEqual(w.snippetFileName('???', ''), 'snippet');
  assert.deepStrictEqual(w.snippetLabel('/home/ME/.vanthrex/snippets/Read_customer_by_id.rpgle'), { label: 'Read customer by id', ext: 'rpgle' });
  assert.match(w.folderFilesSql("/home/O'NEIL"), /START_PATH_NAME => '\/home\/O''NEIL', SUBTREE_DIRECTORIES => 'NO'/);
  assert.strictEqual(w.globToLike('*.rpgle'), '%.rpgle');
  assert.strictEqual(w.globToLike('a_b%?'), 'a!_b!%_');
  assert.match(w.findByNameSql('/home/', '*.rpgle'), /START_PATH_NAME => '\/home'[\s\S]*LIKE '%.RPGLE' ESCAPE '!'/);
  assert.match(w.findByNameSql('/', 'order'), /LIKE '%ORDER%'/);
});

test('changed blocks: starts and jumping with wrap-around', () => {
  const s = w.blockStarts([true, true, false, false, true, false, true, true]);
  assert.deepStrictEqual(s, [0, 4, 6]);
  assert.strictEqual(w.nextBlock(s, 0, 1), 4);
  assert.strictEqual(w.nextBlock(s, 6, 1), 0, 'wraps to the first');
  assert.strictEqual(w.nextBlock(s, 5, -1), 4);
  assert.strictEqual(w.nextBlock(s, 0, -1), 6, 'wraps to the last');
  assert.strictEqual(w.nextBlock([], 3, 1), undefined);
});

test('library and table actions: CL, IBM libraries refused', () => {
  assert.strictEqual(w.libraryCommand.copy('applib', 'applib2'), 'CPYLIB FROMLIB(APPLIB) TOLIB(APPLIB2) CRTLIB(*YES)');
  assert.strictEqual(w.libraryCommand.rename('APPLIB', 'newlib'), 'RNMOBJ OBJ(APPLIB) OBJTYPE(*LIB) NEWOBJ(NEWLIB)');
  assert.strictEqual(w.libraryCommand.clear('TESTLIB'), 'CLRLIB LIB(TESTLIB)');
  assert.strictEqual(w.libraryCommand.remove('TESTLIB'), 'DLTLIB LIB(TESTLIB)');
  assert.throws(() => w.libraryCommand.clear('X) LIB(QSYS'));
  assert.ok(w.isSystemLibrary('QSYS') && w.isSystemLibrary('qgpl') && w.isSystemLibrary('SYSIBM') && w.isSystemLibrary('#LIBRARY') && !w.isSystemLibrary('APPLIB'));
  assert.strictEqual(w.clearDataCommand('applib', 'orders'), 'CLRPFM FILE(APPLIB/ORDERS)');
  assert.strictEqual(w.copyDataCommand('APPLIB', 'ORDERS', 'testlib', 'orders', 'replace'), 'CPYF FROMFILE(APPLIB/ORDERS) TOFILE(TESTLIB/ORDERS) MBROPT(*REPLACE) FMTOPT(*MAP *DROP)');
  assert.match(w.copyDataCommand('APPLIB', 'ORDERS', 'TESTLIB', 'ORDERS', 'add'), /MBROPT\(\*ADD\) FMTOPT\(\*MAP \*DROP\)$/);
  assert.match(w.copyDataCommand('APPLIB', 'ORDERS', 'TESTLIB', 'ORD2', 'create'), /CRTFILE\(\*YES\)$/);
  assert.throws(() => w.copyDataCommand('APPLIB', 'ORDERS', 'applib', 'orders', 'add'), /not to itself/);
});

test('CALL statements for procedures and functions', () => {
  assert.match(w.routinesSql('mylib.getcust'), /ROUTINE_SCHEMA = 'MYLIB' AND ROUTINE_NAME = 'GETCUST'/);
  assert.match(w.routinesSql("x'y"), /ROUTINE_NAME = 'X''Y'/);
  assert.throws(() => w.routinesSql("A'B.C"));
  assert.match(w.routineParamsSql('MYLIB', 'GETCUST00001'), /ROW_TYPE, 'P'\) = 'P'/);
  assert.deepStrictEqual([['PROCEDURE', ''], ['FUNCTION', 'S'], ['FUNCTION', 'T']].map(([a, b]) => w.routineKind(a, b)), ['procedure', 'scalar', 'table']);
  const p = [{ position: 2, name: 'NAME', mode: 'OUT', type: 'VARCHAR' }, { position: 1, name: 'ID', mode: 'IN', type: 'INTEGER' }];
  assert.strictEqual(w.callStatement('MYLIB', 'GETCUST', 'procedure', p), 'CALL MYLIB.GETCUST(\n  ID => ?, -- IN INTEGER\n  NAME => ? -- OUT VARCHAR\n);');
  assert.strictEqual(w.callStatement('MYLIB', 'NOW', 'scalar', []), 'VALUES MYLIB.NOW();');
  assert.match(w.callStatement('MYLIB', 'orders', 'table', [{ position: 1, name: '', mode: 'IN', type: 'DATE' }]), /^SELECT \*\n  FROM TABLE\(MYLIB\."orders"\(\n  \? -- IN DATE\n\)\) X;$/);
});

test('JSON sample to SQL', () => {
  const sql = w.jsonToSql('{"id": 7, "name": "O\'Neil", "vip": true, "tags": ["a", "b"], "addr": {"city": "Paris"}, "note": null}');
  assert.ok(sql.startsWith('VALUES JSON_OBJECT(\n'));
  assert.match(sql, /KEY 'id' VALUE 7,/);
  assert.match(sql, /KEY 'name' VALUE 'O''Neil',/);
  assert.match(sql, /KEY 'vip' VALUE 'true' FORMAT JSON,/);
  assert.match(sql, /KEY 'tags' VALUE JSON_ARRAY\(\n {4}'a',\n {4}'b'\n {2}\),/);
  assert.match(sql, /KEY 'addr' VALUE JSON_OBJECT\(\n {4}KEY 'city' VALUE 'Paris'\n {2}\),/);
  assert.match(sql, /KEY 'note' VALUE NULL NULL ON NULL\n\);$/);
  assert.strictEqual(w.jsonToSql('[]'), 'VALUES JSON_ARRAY();');
  assert.throws(() => w.jsonToSql('not json'));
});
