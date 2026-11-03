// Small RPG rewrites (pure, unit tested): compound assignments (x = x + 1 → x += 1), EVAL / CALLP removed in free form,
// a condition negated, "= *ON" simplified, a value wrapped in a built-in function, standalone variables grouped in a
// data structure, SQL INSERT / SELECT INTO / UPDATE from a data structure, a DS from CREATE TABLE and back, a program
// header, a line kept as a comment before changing it, and date / time / timestamp literals.
import { freeTypeBytes } from '../core/dataStructures';

/** x = x + 1; → x += 1;  (also -, *, /), for each line. */
export function compoundAssignments(lines: string[]): { lines: string[]; changed: number } {
  let changed = 0;
  const out = lines.map(l => {
    const m = /^(\s*)(?:eval\s+)?([A-Za-z_$#@][\w$#@.]*(?:\([^()]*\))?)\s*=\s*(.+?)\s*;(\s*\/\/.*)?$/i.exec(l);
    if (!m) { return l; }
    const target = m[2].replace(/\s+/g, ''); const rhs = m[3];
    const r = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*([-+*/])\\s*(.+)$`, 'i').exec(rhs.replace(/\s+(?=\()/g, ''));
    // x = x - a + b would change meaning as x -= a + b: only a single term (no other + - at the top level) is safe.
    if (!r || (/[-+]/.test(r[1]) && /[-+]/.test(r[2].replace(/'(?:[^']|'')*'|\([^()]*\)/g, '').replace(/^[-+]/, '')))) { return l; }
    if ((r[1] === '*' || r[1] === '/') && /[-+*/]/.test(r[2].replace(/'(?:[^']|'')*'|\([^()]*\)/g, '').replace(/^[-+]/, ''))) { return l; }
    changed++;
    return `${m[1]}${m[2]} ${r[1]}= ${r[2]};${m[4] ?? ''}`;
  });
  return { lines: out, changed };
}

/** EVAL and CALLP removed at the start of free-form statements (EVAL(H) / EVALR / CALLP(E) are kept). */
export function removeEvalCallp(lines: string[]): { lines: string[]; changed: number } {
  let changed = 0;
  const out = lines.map(l => { const n = l.replace(/^(\s*)(eval|callp)\s+(?![(])/i, '$1'); if (n !== l) { changed++; } return n; });
  return { lines: out, changed };
}

/** The condition of IF / ELSEIF / DOW / DOU / WHEN negated: NOT added, or removed when already there. */
export function negateCondition(line: string): string {
  const m = /^(\s*(?:if|elseif|dow|dou|when)\s+)(.*?)(\s*;\s*(\/\/.*)?)$/i.exec(line);
  if (!m) { throw new Error('Put the cursor on an IF, ELSEIF, DOW, DOU or WHEN line.'); }
  const cond = m[2].trim();
  const not = /^not\s*\((.*)\)$/i.exec(cond);
  if (not && balanced(not[1])) { return `${m[1]}${not[1]}${m[3]}`; }
  if (/^not\s+[\w%*$#@.]+(\([^()]*\))?$/i.test(cond)) { return `${m[1]}${cond.replace(/^not\s+/i, '')}${m[3]}`; }
  const simple: Record<string, string> = { '=': '<>', '<>': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
  const c = /^([^<>=]+?)\s*(<>|<=|>=|=|<|>)\s*([^<>=]+)$/.exec(cond);
  if (c && !/\b(and|or)\b/i.test(cond)) { return `${m[1]}${c[1]} ${simple[c[2]]} ${c[3]}${m[3]}`; }
  return `${m[1]}not (${cond})${m[3]}`;
}
function balanced(s: string): boolean { let d = 0; for (const c of s) { if (c === '(') { d++; } else if (c === ')' && --d < 0) { return false; } } return d === 0; }

/** "x = *ON" → "x", "x = *OFF" → "not x" in conditions (IF, DOW, WHEN …). */
export function simplifyIndicators(line: string): string {
  // "not x = *on" is left alone: NOT binds before the comparison and the rewrite would be easy to misread.
  return line.replace(/(\bnot\s+)?\b([A-Za-z_$#@][\w$#@.]*(?:\([^()]*\))?)\s*(=|<>)\s*\*(on|off)\b/gi, (all: string, n: string | undefined, v: string, op: string, val: string) => {
    if (n || /^\*in$/i.test(v)) { return all; }
    return (op === '=') === (val.toLowerCase() === 'on') ? v : `not ${v}`;
  });
}

/** The selection wrapped in a built-in function, e.g. %trim(x), %dec(x: 7: 2). */
export function wrapWithBif(text: string, bif: string): string {
  const t = text.trim(); if (!t) { throw new Error('Select an expression.'); }
  const extra: Record<string, string> = { '%DEC': ': 15: 2', '%EDITC': ": 'J'", '%SCANRPL': ": 'old': 'new'", '%XLATE': '', '%SUBST': ': 1: 10', '%REPLACE': ': 1', '%DIFF': ': *days' };
  const B = bif.toUpperCase();
  if (B === '%XLATE') { return `%xlate('abcdefghijklmnopqrstuvwxyz': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ': ${t})`; }
  if (B === '%SCANRPL') { return `%scanrpl('old': 'new': ${t})`; }
  if (B === '%REPLACE') { return `%replace('new': ${t}: 1)`; }
  return `${bif.toLowerCase()}(${t}${extra[B] ?? ''})`;
}

export const WRAP_BIFS = ['%TRIM', '%TRIMR', '%TRIML', '%CHAR', '%DEC', '%INT', '%UPPER', '%LOWER', '%LEN', '%ABS', '%EDITC', '%SCANRPL', '%XLATE', '%SUBST', '%ELEM', '%ADDR', '%SIZE', '%DATE', '%TIMESTAMP', '%DIFF', '%REPLACE', '%CHECK', '%PARMS'];

/** One-line DCL-S statements grouped in a qualified data structure. */
export function groupInDs(lines: string[], name: string): string[] {
  const subs: string[] = []; let indent: string | undefined;
  for (const l of lines) {
    if (!l.trim()) { continue; }
    const m = /^(\s*)dcl-s\s+(.+?);\s*(\/\/.*)?$/i.exec(l);
    if (!m) { throw new Error('Select one-line DCL-S statements only.'); }
    indent ??= m[1];
    subs.push(`${m[1]}  ${m[2].trim()};${m[3] ? ' ' + m[3] : ''}`);
  }
  if (!subs.length) { throw new Error('Select DCL-S lines.'); }
  return [`${indent}dcl-ds ${name} qualified;`, ...subs, `${indent}end-ds;`];
}

export interface DsField { name: string; type: string }

/** Subfields of a free-form DCL-DS … END-DS (the first one in the text). */
export function dsFields(text: string): { name: string; fields: DsField[]; qualified: boolean } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*dcl-ds\s+/i.test(l));
  if (start < 0) { throw new Error('Put the cursor in a DCL-DS … END-DS.'); }
  const head = /^\s*dcl-ds\s+([\w$#@]+)([^;]*)/i.exec(lines[start])!;
  const fields: DsField[] = [];
  for (let i = start + 1; i < lines.length && !/^\s*end-ds\b/i.test(lines[i]); i++) {
    const m = /^\s*(?:dcl-subf\s+)?([A-Za-z_$#@][\w$#@]*)\s+([^;]+);/i.exec(lines[i].replace(/\/\/.*$/, ''));
    if (m && !/^(\*n)$/i.test(m[1])) { fields.push({ name: m[1], type: m[2].trim() }); }
  }
  if (!fields.length) { throw new Error('This data structure has no subfields written in the source (EXTNAME / LIKEREC are read from the file).'); }
  return { name: head[1], fields, qualified: /\bqualified\b/i.test(head[2]) };
}

/** INSERT, SELECT INTO and UPDATE between a data structure and a table with the same column names. */
export function dsSql(text: string, table: string, key?: string): { insert: string; select: string; update: string } {
  const ds = dsFields(text);
  const host = (f: DsField) => `:${ds.qualified ? `${ds.name}.` : ''}${f.name}`;
  const cols = ds.fields.map(f => f.name);
  const k = key ? ds.fields.find(f => f.name.toUpperCase() === key.toUpperCase()) ?? ds.fields[0] : ds.fields[0];
  const where = `where ${k.name} = ${host(k)}`;
  return {
    insert: `exec sql insert into ${table}\n  (${cols.join(', ')})\n  values (${ds.fields.map(host).join(', ')});`,
    select: `exec sql select ${cols.join(', ')}\n  into ${ds.fields.map(host).join(', ')}\n  from ${table}\n  ${where};`,
    update: `exec sql update ${table}\n  set ${ds.fields.filter(f => f !== k).map(f => `${f.name} = ${host(f)}`).join(',\n      ')}\n  ${where};`,
  };
}

const SQL_TO_RPG: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(?:var)?char(?:acter)?\s+varying\s*\(\s*(\d+)\s*\)/i, m => `varchar(${m[1]})`],
  [/^varchar\s*\(\s*(\d+)\s*\)/i, m => `varchar(${m[1]})`],
  [/^char(?:acter)?\s*\(\s*(\d+)\s*\)/i, m => `char(${m[1]})`],
  [/^char(?:acter)?\b/i, () => 'char(1)'],
  [/^(?:decimal|dec)\s*\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\)/i, m => `packed(${m[1]}:${m[2] ?? 0})`],
  [/^numeric\s*\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\)/i, m => `zoned(${m[1]}:${m[2] ?? 0})`],
  [/^(?:integer|int)\b/i, () => 'int(10)'], [/^smallint\b/i, () => 'int(5)'], [/^bigint\b/i, () => 'int(20)'],
  [/^timestamp\b/i, () => 'timestamp'], [/^date\b/i, () => 'date'], [/^time\b/i, () => 'time'],
  [/^(?:double|float)\b/i, () => 'float(8)'], [/^real\b/i, () => 'float(4)'],
  [/^clob\s*\(\s*(\d+)\s*([KM])?\s*\)/i, m => `varchar(${Math.min(16773100, +m[1] * (m[2] === 'M' ? 1048576 : m[2] === 'K' ? 1024 : 1))})`],
  [/^boolean\b/i, () => 'ind'],
];

/** A qualified template DS from a CREATE TABLE statement. */
export function dsFromCreateTable(sql: string): string {
  const head = /create\s+(?:or\s+replace\s+)?table\s+([\w$#@."]+)\s*(?:for\s+system\s+name\s+\w+\s*)?\(/i.exec(sql);
  if (!head) { throw new Error('Select a CREATE TABLE statement.'); }
  const name = head[1].replace(/"/g, '').split(/[./]/).pop()!;
  let depth = 1; let i = head.index + head[0].length; let body = '';
  for (; i < sql.length && depth; i++) { const c = sql[i]; if (c === '(') { depth++; } else if (c === ')') { depth--; if (!depth) { break; } } body += c; }
  const parts: string[] = []; let cur = ''; depth = 0;
  for (const c of body) { if (c === '(') { depth++; } if (c === ')') { depth--; } if (c === ',' && !depth) { parts.push(cur); cur = ''; } else { cur += c; } }
  parts.push(cur);
  const out: string[] = [];
  for (const p of parts.map(x => x.trim().replace(/--.*$/gm, '').trim())) {
    if (!p || /^(primary|foreign|unique|constraint|check|period)\b/i.test(p)) { continue; }
    const m = /^"?([\w$#@]+)"?\s+(?:for\s+(?:column\s+)?[\w$#@]+\s+)?(.*)$/is.exec(p);
    if (!m) { continue; }
    const conv = SQL_TO_RPG.map(([re, f]) => { const r = re.exec(m[2].trim()); return r ? f(r) : undefined; }).find(Boolean);
    out.push(`  ${m[1].toLowerCase()} ${conv ?? `char(10) // ${m[2].trim().split(/\s+/)[0]}: check the type`};`);
  }
  return `dcl-ds ${name.toLowerCase()}_t qualified template;\n${out.join('\n')}\nend-ds;`;
}

/** A CREATE TABLE statement from a free-form data structure. */
export function createTableFromDs(text: string, table?: string): string {
  const ds = dsFields(text);
  const col = (f: DsField) => {
    const t = f.type.toLowerCase(); let m: RegExpExecArray | null;
    if ((m = /^varchar\((\d+)\)/.exec(t))) { return `VARCHAR(${m[1]})`; }
    if ((m = /^char\((\d+)\)/.exec(t))) { return `CHAR(${m[1]})`; }
    if ((m = /^packed\((\d+)(?::(\d+))?\)/.exec(t))) { return `DECIMAL(${m[1]}, ${m[2] ?? 0})`; }
    if ((m = /^zoned\((\d+)(?::(\d+))?\)/.exec(t))) { return `NUMERIC(${m[1]}, ${m[2] ?? 0})`; }
    if ((m = /^int\((\d+)\)/.exec(t))) { return { 3: 'SMALLINT', 5: 'SMALLINT', 10: 'INTEGER', 20: 'BIGINT' }[m[1]] ?? 'INTEGER'; }
    if (/^date\b/.test(t)) { return 'DATE'; } if (/^time\b/.test(t)) { return 'TIME'; } if (/^timestamp\b/.test(t)) { return 'TIMESTAMP'; }
    if (/^ind\b/.test(t)) { return 'CHAR(1)'; }
    if ((m = /^float\((\d+)\)/.exec(t))) { return m[1] === '4' ? 'REAL' : 'DOUBLE'; }
    return `CHAR(10) /* ${f.type}: check the type */`;
  };
  const name = (table ?? ds.name.replace(/_t$/i, '')).toUpperCase();
  return `CREATE TABLE ${name} (\n${ds.fields.map(f => `  ${f.name.toUpperCase().padEnd(Math.max(...ds.fields.map(x => x.name.length)))} ${col(f)} NOT NULL DEFAULT`).join(',\n')}\n);`;
}

/** Storage size of a declaration (free form), for hovers. */
export function declarationBytes(detail: string): number | undefined {
  const m = /^([a-z]+)\s*(?:\(([^)]*)\))?/i.exec(detail.trim());
  if (!m) { return undefined; }
  const one = freeTypeBytes(m[1], m[2] ?? '');
  const dim = /\bdim\(\s*(\d+)\s*\)/i.exec(detail)?.[1];
  return one === undefined ? undefined : one * (dim ? +dim : 1);
}

/** A header comment for a program or module. */
export function programHeader(name: string, user: string, date: Date, fullyFree: boolean): string {
  const d = date.toISOString().slice(0, 10);
  const c = fullyFree ? '//' : '      //';
  return [
    `${c} ==================================================================`,
    `${c} Program  : ${name}`,
    `${c} Purpose  : `,
    `${c} Author   : ${user}`,
    `${c} Created  : ${d}`,
    `${c} ------------------------------------------------------------------`,
    `${c} Changes  :`,
    `${c} ${d} ${user.padEnd(10)} Created`,
    `${c} ==================================================================`,
  ].join('\n') + '\n';
}

/** The line kept as a comment above itself, before changing it (with who and when). */
export function keepAsComment(line: string, user: string, date: Date, fullyFree: boolean, language: 'rpgle' | 'cl' = 'rpgle'): string {
  const d = date.toISOString().slice(0, 10);
  if (language === 'cl') { return `/* ${d} ${user}: ${line.trim().replace(/\*\//g, '* /')} */\n${line}`; }
  if (!fullyFree && /^.{5}[A-Za-z]/.test(line)) { return `${line.slice(0, 6)}*${line.slice(7)}\n${line}`; }
  const ind = /^\s*/.exec(line)![0];
  return `${ind}// ${d} ${user}: ${line.trim()}\n${line}`;
}

/** Date, time and timestamp literals for now. */
export function timeLiterals(now: Date): { label: string; text: string }[] {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const d = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const t = `${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
  return [
    { label: `d'${d}'`, text: `d'${d}'` }, { label: `t'${t}'`, text: `t'${t}'` }, { label: `z'${d}-${t}.000000'`, text: `z'${d}-${t}.000000'` },
    { label: `${d.replace(/-/g, '')} (number)`, text: d.replace(/-/g, '') }, { label: `'${d}' (SQL)`, text: `'${d}'` },
  ];
}

/** A section separator comment. */
export function separator(title: string, fullyFree: boolean, width = 70): string {
  const c = fullyFree ? '//' : '      //';
  const t = title.trim() ? ` ${title.trim()} ` : '';
  return `${c} ${'-'.repeat(4)}${t}${'-'.repeat(Math.max(4, width - 4 - t.length))}\n`;
}

/** A subroutine rewritten as a procedure: BEGSR → DCL-PROC, ENDSR → END-PROC, LEAVESR → RETURN, EXSR x → x(). */
export function subroutineToProcedure(text: string, name: string): { text: string; calls: number } {
  const N = name.replace(/[$#@]/g, '\\$&');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^\\s*begsr\\s+${N}\\s*;`, 'i').test(l));
  if (start < 0) { throw new Error(`No free-form BEGSR ${name} in this source.`); }
  let end = start + 1; while (end < lines.length && !/^\s*endsr\b/i.test(lines[end])) { end++; }
  if (end >= lines.length) { throw new Error(`BEGSR ${name} has no ENDSR.`); }
  for (let i = start + 1; i < end; i++) { if (/^\s*begsr\b/i.test(lines[i])) { throw new Error('A subroutine inside another one cannot be converted.'); } }
  const real = /begsr\s+([\w$#@]+)/i.exec(lines[start])![1];
  let calls = 0;
  const out = lines.map((l, i) => {
    if (i === start) { return l.replace(/begsr\s+([\w$#@]+)\s*;/i, 'dcl-proc $1;'); }
    if (i === end) { return l.replace(/endsr\b[^;]*;/i, 'end-proc;'); }
    if (i > start && i < end) { return l.replace(/^(\s*)leavesr\s*;/i, '$1return;'); }
    const n = l.replace(new RegExp(`^(\\s*)exsr\\s+${N}\\s*;`, 'i'), `$1${real}();`);
    if (n !== l) { calls++; }
    return n;
  });
  return { text: out.join('\n'), calls };
}

/** "NAME value" lines (or NAME = value) as aligned DCL-C statements. */
export function linesToConstants(lines: string[]): string[] {
  const parts = lines.filter(l => l.trim()).map(l => /^\s*([A-Za-z_$#@][\w$#@]*)\s*(?:=|\s)\s*(.+?)\s*;?\s*$/.exec(l));
  if (!parts.length || parts.some(p => !p)) { throw new Error('Select lines like: NAME value'); }
  const w = Math.max(...parts.map(p => p![1].length));
  return parts.map(p => { const v = p![2]; const val = /^[-+]?\d+(\.\d+)?$/.test(v) || /^['*%]/.test(v) ? v : `'${v.replace(/'/g, "''")}'`; return `dcl-c ${p![1].toUpperCase().padEnd(w)} ${val};`; });
}
