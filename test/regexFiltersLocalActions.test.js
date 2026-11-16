const test = require('node:test');
const assert = require('node:assert');
const f = require('../out/core/objectFilters');
const a = require('../out/core/actions');

test('regex filter: checked, "all" forms, libraries still generic names', () => {
  const flt = f.checkFilter({ name: 'Orders', regex: true, library: 'app*', object: ' ^ORD[0-9]+$ ', types: ['*PGM'], member: '.*', memberType: '' });
  assert.deepStrictEqual(flt, { name: 'Orders', library: 'APP*', object: '^ORD[0-9]+$', types: ['*PGM'], member: '*', memberType: '*', regex: true });
  // The case of an expression is kept (it is matched ignoring case anyway).
  assert.strictEqual(f.checkFilter({ name: 'x', regex: true, library: 'A', object: '^[a-z]+_old$' }).object, '^[a-z]+_old$');
  assert.throws(() => f.checkFilter({ name: 'x', regex: true, library: 'A', object: '([' }), /object expression is not valid/);
  assert.throws(() => f.checkFilter({ name: 'x', regex: true, library: 'A', member: '(?=X)' }), /look-around/);
  assert.throws(() => f.checkFilter({ name: 'x', regex: true, library: 'A', member: '(A)\\1' }), /back-references/);
  assert.throws(() => f.checkFilter({ name: 'x', regex: true, library: 'A', object: 'x'.repeat(257) }), /longer than 256/);
  assert.throws(() => f.checkFilter({ name: 'x', regex: true, library: '^A' }), /not a valid library/);
  // Without regex, an expression is not a generic name.
  assert.throws(() => f.checkFilter({ name: 'x', library: 'A', object: '^ORD[0-9]+$' }), /not a valid object/);
});

test('regex filter: SQL with REGEXP_LIKE, quotes doubled', () => {
  const flt = f.checkFilter({ name: 'x', regex: true, library: 'APP*', object: "^O'R", types: ['*ALL'], member: 'A|B', memberType: '^(SQL)?RPGLE$' });
  assert.strictEqual(f.regexCondition('OBJNAME', '*'), undefined);
  assert.deepStrictEqual(f.objectArgs(flt), { types: '*ALL', where: " WHERE REGEXP_LIKE(OBJNAME, '^O''R', 'i')" });
  assert.strictEqual(f.sourceFileCondition(flt), " AND REGEXP_LIKE(SYSTEM_TABLE_NAME, '^O''R', 'i')");
  assert.strictEqual(f.memberCondition(flt), " AND REGEXP_LIKE(SYSTEM_TABLE_MEMBER, 'A|B', 'i') AND REGEXP_LIKE(SOURCE_TYPE, '^(SQL)?RPGLE$', 'i')");
  // Libraries are still generic names (LIKE).
  assert.match(f.filterLibrariesSql(flt), /OBJNAME LIKE 'APP%' ESCAPE '!'/);
  assert.strictEqual(f.describeFilter(flt), "APP*//^O'R/ · members /A|B/ · types /^(SQL)?RPGLE$/ · regex");
});

test('actions offered for members, IFS files and local files', () => {
  const acts = [
    { name: 'Member', command: 'M', extensions: ['rpgle'] },
    { name: 'Both', command: 'B', extensions: ['*'], source: 'both' },
    { name: 'Ifs', command: 'I', extensions: ['RPGLE'], source: 'ifs' },
    { name: 'Local make', command: 'makei c -f &RELATIVEPATH', extensions: ['rpgle'], source: 'local', environment: 'pase' },
    { name: 'Local CL only', command: 'X', extensions: ['clle'], source: 'local' },
    { name: 'Object', command: 'O', extensions: ['*'], source: 'object' },
  ];
  const names = (ext, src) => a.sourceActionsFor(acts, ext, src).map(x => x.name);
  assert.deepStrictEqual(names('rpgle', 'member'), ['Member', 'Both']);
  assert.deepStrictEqual(names('rpgle', 'ifs'), ['Both', 'Ifs']);
  // Local files: their own actions first, then the IFS ones (they are compiled from the deploy folder).
  assert.deepStrictEqual(names('RPGLE', 'local'), ['Local make', 'Both', 'Ifs']);
  assert.deepStrictEqual(names('clle', 'local'), ['Local CL only', 'Both']);
  assert.deepStrictEqual(names('sql', 'member'), ['Both']);
});
