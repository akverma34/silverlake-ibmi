const test = require('node:test');
const assert = require('node:assert');
const l = require('../out/core/localDev');

test('POSIX cksum, as printed by the cksum command', () => {
  assert.strictEqual(l.posixCksum(new Uint8Array()), 4294967295);
  assert.strictEqual(l.posixCksum(Buffer.from('hello\n')), 3015617425);
  // A file longer than 255 bytes (the length is fed in several bytes) differs from the same file one byte shorter.
  const big = Buffer.alloc(300, 65);
  assert.notStrictEqual(l.posixCksum(big), l.posixCksum(big.subarray(0, 299)));
});

test('remote checksums: command and parsing', () => {
  assert.strictEqual(l.remoteChecksumCommand("/home/o'b/app"),
    "if [ -d '/home/o'\\''b/app' ]; then cd '/home/o'\\''b/app' && /QOpenSys/usr/bin/find . -type f -exec /QOpenSys/usr/bin/cksum {} + 2>/dev/null; fi");
  const m = l.parseCksum('3015617425 6 ./src/a b.rpgle\r\n4294967295 0 ./empty\nnoise\n');
  assert.deepStrictEqual([...m.entries()], [['src/a b.rpgle', { crc: 3015617425, size: 6 }], ['empty', { crc: 4294967295, size: 0 }]]);
});

test('compare plan: only real differences, remote-only files reported', () => {
  const remote = new Map([['a.rpgle', { crc: 1, size: 10 }], ['b.rpgle', { crc: 2, size: 10 }], ['old.rpgle', { crc: 3, size: 1 }], ['x.log', { crc: 4, size: 1 }]]);
  const plan = l.planCompare([
    { rel: 'a.rpgle', crc: 1, size: 10 }, { rel: 'b.rpgle', crc: 9, size: 10 }, { rel: 'new.rpgle', crc: 5, size: 3 }, { rel: 'node_modules/x.js', crc: 1, size: 1 },
  ], remote, ['node_modules/', '*.log']);
  assert.deepStrictEqual(plan, { upload: ['b.rpgle', 'new.rpgle'], unchanged: 1, remoteOnly: ['old.rpgle'] });
});

test('git status: changed files of the folder, renames and deletes handled', () => {
  const z = [' M app/src/a.rpgle', 'M  app/src/b.rpgle', 'R  app/src/new.rpgle', 'app/src/old.rpgle', ' D app/src/gone.rpgle', 'D  app/src/gone2.rpgle',
    '?? app/src/added.clle', '?? app/build.log', 'A  other/x.rpgle', '?? app/dir/', ''].join('\0');
  assert.deepStrictEqual(l.parseGitStatus(z, 'app/', ['*.log']), ['src/a.rpgle', 'src/added.clle', 'src/b.rpgle', 'src/new.rpgle']);
  assert.deepStrictEqual(l.parseGitStatus('?? a.rpgle\0 M b\\c.rpgle\0', ''), ['a.rpgle', 'b/c.rpgle']);
  assert.deepStrictEqual(l.parseGitStatus('', ''), []);
});

test('remove commands in batches of 100', () => {
  const rels = Array.from({ length: 150 }, (_, i) => `f${i}.rpgle`);
  const cmds = l.removeCommands('/home/me/app', rels);
  assert.strictEqual(cmds.length, 2);
  assert.ok(cmds[0].startsWith("rm -f '/home/me/app/f0.rpgle' '/home/me/app/f1.rpgle'"));
  assert.throws(() => l.removeCommands('/home/me/app', ['../etc/passwd']), /Invalid path/);
});
