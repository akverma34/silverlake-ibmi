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
