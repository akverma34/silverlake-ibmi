const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const placeholders = s => [...new Set([...String(s).matchAll(/\{(\d+)\}/g)].map(m => m[1]))].sort().join(',');

test('every translation has exactly the English strings, with the same placeholders', () => {
  const en = read('l10n/bundle.l10n.json');
  for (const f of fs.readdirSync(path.join(root, 'l10n')).filter(f => f !== 'bundle.l10n.json')) {
    const t = read(`l10n/${f}`);
    assert.deepStrictEqual(Object.keys(en).filter(k => !(k in t)), [], `${f}: missing`);
    assert.deepStrictEqual(Object.keys(t).filter(k => !(k in en)), [], `${f}: not in the English bundle (stale)`);
    assert.deepStrictEqual(Object.keys(t).filter(k => placeholders(k) !== placeholders(t[k])), [], `${f}: placeholders differ`);
  }
});

test('package.json %keys% exist, and every package.nls translation has the same keys', () => {
  const pkg = read('package.json');
  const nls = read('package.nls.json');
  const used = new Set();
  JSON.stringify(pkg, (_k, v) => { if (typeof v === 'string' && /^%[^%]+%$/.test(v)) { used.add(v.slice(1, -1)); } return v; });
  assert.deepStrictEqual([...used].filter(k => !(k in nls)), [], 'used in package.json, missing from package.nls.json');
  for (const f of fs.readdirSync(root).filter(f => /^package\.nls\..+\.json$/.test(f))) {
    const t = read(f);
    assert.deepStrictEqual(Object.keys(nls).filter(k => !(k in t)), [], `${f}: missing`);
    assert.deepStrictEqual(Object.keys(t).filter(k => !(k in nls)), [], `${f}: extra`);
  }
});
