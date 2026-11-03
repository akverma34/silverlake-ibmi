const test = require('node:test');
const assert = require('node:assert');
const { suggest, typeForName, cleanCompletion, CL_MONMSG } = require('../out/rpg/rpgSuggestions');

/** "|" marks the cursor. */
function at(src, language = 'rpgle', signatures) {
  const lines = src.split('\n');
  const line = lines.findIndex(l => l.includes('|'));
  const column = lines[line].indexOf('|');
  lines[line] = lines[line].replace('|', '');
  return suggest({ lines, line, column, language, signatures });
}

test('the next RPG statement on an empty line', () => {
  assert.strictEqual(at('**free\n|'), 'ctl-opt dftactgrp(*no) actgrp(*new) option(*srcstmt: *nodebugio);');
  assert.strictEqual(at('**free\nctl-opt;\n|'), undefined);
  assert.strictEqual(at('**free\nchain (k) custmast;\n|'), 'if %found(custmast);');
  assert.strictEqual(at('**free\nchain (k) custmast;\n|\nif %found(custmast);'), undefined);
  assert.strictEqual(at('**free\nsetll (k) orders;\n|'), 'reade (k) orders;');
  assert.strictEqual(at('**free\nsetll *start orders;\n|'), 'read orders;');
  assert.strictEqual(at('**free\nexec sql declare c1 cursor for\n  select * from t;\n|'), 'exec sql open c1;');
  assert.strictEqual(at('**free\nexec sql open c1;\n|'), 'exec sql fetch next from c1 into :');
  assert.strictEqual(at('**free\nexec sql fetch c1 into :x;\n|'), 'if sqlcode <> 0;');
  assert.strictEqual(at("**free\nexec sql update t set a = 'x;y'\n  where b = 1;\n|"), 'if sqlcode < 0;');
  assert.strictEqual(at('**free\nexec sql update t set a = 1;\n|\nif sqlcode < 0;'), undefined);
  assert.strictEqual(at('**free\ndcl-proc calc export;\n|'), 'dcl-pi *n;');
});

test('completing the current RPG line', () => {
  assert.strictEqual(at('**free\ndcl-s shipName varchar(40);\ndcl-s custName |'), 'varchar(40);');
  assert.strictEqual(at('**free\ndcl-s orderTotal |'), 'packed(11:2);');
  assert.strictEqual(at('**free\ndcl-s isValid |'), 'ind;');
  assert.strictEqual(at('**free\ndcl-s i |'), 'int(10);');
  assert.strictEqual(at('**free\nctl-opt|'), ' dftactgrp(*no) actgrp(*new) option(*srcstmt: *nodebugio);');
  assert.strictEqual(at('**free\n*inlr|'), ' = *on;');
  assert.strictEqual(at('**free\nread custmast rec;\nif not %eof|'), '(custmast)');
  assert.strictEqual(at('**free\nchain key custmast;\nif %found(|'), 'custmast)');
  const sigs = new Map([['CALC', ['custNo', 'amount']]]);
  assert.strictEqual(at('**free\nx = calc(|', 'rpgle', sigs), 'custNo: amount)');
  assert.strictEqual(at('**free\ncalc(|', 'rpgle', sigs), 'custNo: amount);');
});

test('nothing inside literals, comments, fixed form or mid-line', () => {
  const sigs = new Map([['CALC', ['a']]]);
  assert.strictEqual(at("**free\nx = 'calc(|", 'rpgle', sigs), undefined);
  assert.strictEqual(at('**free\n// chain k f;\n|'), undefined);
  assert.strictEqual(at('**free\ndcl-s total |x;'), undefined);
  assert.strictEqual(at('     C                   CHAIN     KEY           FILE\n|'), undefined);
});

test('variable types from names', () => {
  assert.strictEqual(typeForName('orderDate'), 'date');
  assert.strictEqual(typeForName('created_ts'), 'timestamp');
  assert.strictEqual(typeForName('custId'), 'char(10)');
  assert.strictEqual(typeForName('sqlStmt'), 'varchar(3000)');
  assert.strictEqual(typeForName('jsonBody'), 'varchar(32000)');
  assert.strictEqual(typeForName('rowCount'), 'int(10)');
  assert.strictEqual(typeForName('hasError'), 'ind');
  assert.strictEqual(typeForName('custName', ['dcl-s shipName varchar(40) inz(\'x\');']), 'varchar(40)');
});

test('CL: MONMSG after commands, parameters declared, DCL types', () => {
  assert.strictEqual(at('PGM\nCHKOBJ OBJ(QTEMP/X) OBJTYPE(*FILE)\n|', 'cl'), 'MONMSG     MSGID(CPF9801) /* object not found */');
  assert.strictEqual(at('PGM\nDLTF FILE(QTEMP/X)\n|\nMONMSG CPF2105', 'cl'), undefined);
  assert.strictEqual(at('PGM\nCRTLIB LIB(X) +\n  TEXT(\'y\')\n|', 'cl'), 'MONMSG     MSGID(CPF2111) /* library already exists */');
  assert.strictEqual(at('PGM PARM(&LIB &COUNT)\nDCL VAR(&LIB) TYPE(*CHAR) LEN(10)\n|', 'cl'), 'DCL        VAR(&COUNT) TYPE(*CHAR) LEN(10)');
  assert.strictEqual(at('PGM\nDCL VAR(&COUNT) |', 'cl'), 'TYPE(*DEC) LEN(5 0)');
  assert.strictEqual(at('PGM\nDCL VAR(&FOUND) |', 'cl'), 'TYPE(*LGL)');
  assert.ok(Object.keys(CL_MONMSG).length >= 25);
});

test('AI answers cleaned into ghost text', () => {
  assert.strictEqual(cleanCompletion('```rpgle\nif %found(f);\n  x = 1;\nendif;\n```', ''), 'if %found(f);\n  x = 1;\nendif;');
  assert.strictEqual(cleanCompletion('dcl-s total packed(11:2);', 'dcl-s total '), 'packed(11:2);');
  assert.strictEqual(cleanCompletion('Here is the code: x = 1;', ''), undefined);
  assert.strictEqual(cleanCompletion('a;\nb;\nreturn;\nend-proc;', '', ['  return;', 'end-proc;']), 'a;\nb;');
  assert.strictEqual(cleanCompletion('1\n2\n3\n4\n5\n6\n7\n8', '', [], 3), '1\n2\n3');
  assert.strictEqual(cleanCompletion('   \n', ''), undefined);
});

test('never throws', () => {
  for (const s of ['|', '**free\n|', 'PGM\n|', "**free\nx = '|", '**free\n%found(|']) {
    assert.doesNotThrow(() => at(s));
    assert.doesNotThrow(() => at(s, 'cl'));
  }
});
