// Developer Toolbox, 3.3 batch: 50 small tools that work on the selection or the statement at the cursor — text
// helpers, SQL generators from a CREATE TABLE, RPG declarations and skeletons, CL templates. Pure functions (no
// vscode import), unit tested; the toolbox only asks for names and replaces text.

// ---------------------------------------------------------------- text (any language)

const lines = (s: string) => s.replace(/\r\n/g, '\n').split('\n');
const keepEnd = (src: string, out: string[]) => out.join('\n') + (/\n$/.test(src) ? '\n' : '');
const body = (src: string) => lines(src.replace(/\n$/, ''));

export const sortLines = (s: string, desc = false): string =>
  keepEnd(s, [...body(s)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) * (desc ? -1 : 1)));
export const uniqueLines = (s: string): string => { const seen = new Set<string>(); return keepEnd(s, body(s).filter(l => { const k = l.trimEnd(); if (seen.has(k)) { return false; } seen.add(k); return true; })); };
export const reverseLines = (s: string): string => keepEnd(s, [...body(s)].reverse());
export const trimLines = (s: string): string => keepEnd(s, body(s).map(l => l.trim()));

/** Upper or lower case outside quoted literals (so 'Abc' and "Abc" keep their case). */
export function changeCase(s: string, mode: 'upper' | 'lower'): string {
  return s.replace(/('(?:[^']|'')*'|"(?:[^"]|"")*")|([^'"]+)/g, (m, q: string) => q ? q : mode === 'upper' ? m.toUpperCase() : m.toLowerCase());
}

/** Lines to one comma-separated line (blank lines dropped). */
export const joinComma = (s: string): string => body(s).map(l => l.trim()).filter(Boolean).join(', ');
/** One comma- (or semicolon-) separated line to one value per line. */
export const splitComma = (s: string): string => s.split(/[,;]/).map(x => x.trim()).filter(Boolean).join('\n');
/** Each line as a quoted literal ('it''s'), with an optional separator at the end of each line but the last. */
export const quoteLines = (s: string, sep = ''): string => { const v = body(s).map(l => l.trim()).filter(Boolean); return v.map((l, i) => `'${l.replace(/'/g, "''")}'${i < v.length - 1 ? sep : ''}`).join('\n'); };
/** Lines numbered 1, 2, 3… (or with a step such as 10 for sequence numbers). */
export const numberLines = (s: string, start = 1, step = 1): string => { const b = body(s); const w = String(start + (b.length - 1) * step).length; return keepEnd(s, b.map((l, i) => `${String(start + i * step).padStart(w)} ${l}`)); };

/** Lines, words, characters and the longest line of a text. */
export function countText(s: string): { lines: number; words: number; chars: number; longest: number } {
  const b = body(s);
  return { lines: b.length, words: (s.match(/\S+/g) ?? []).length, chars: s.replace(/\r?\n$/, '').length, longest: Math.max(0, ...b.map(l => l.length)) };
}

// EBCDIC CCSID 37 for the printable ASCII characters.
const E37: Record<string, number> = { ' ': 0x40, '.': 0x4B, '<': 0x4C, '(': 0x4D, '+': 0x4E, '|': 0x4F, '&': 0x50, '!': 0x5A, '$': 0x5B, '*': 0x5C, ')': 0x5D, ';': 0x5E, '-': 0x60, '/': 0x61, ',': 0x6B, '%': 0x6C, '_': 0x6D, '>': 0x6E, '?': 0x6F, '`': 0x79, ':': 0x7A, '#': 0x7B, '@': 0x7C, "'": 0x7D, '=': 0x7E, '"': 0x7F, '~': 0xA1, '^': 0xB0, '[': 0xBA, ']': 0xBB, '{': 0xC0, '}': 0xD0, '\\': 0xE0 };
const ranges: [string, number][] = [['ABCDEFGHI', 0xC1], ['JKLMNOPQR', 0xD1], ['STUVWXYZ', 0xE2], ['abcdefghi', 0x81], ['jklmnopqr', 0x91], ['stuvwxyz', 0xA2], ['0123456789', 0xF0]];
for (const [chars, base] of ranges) { [...chars].forEach((c, i) => { E37[c] = base + i; }); }
const FROM37 = new Map(Object.entries(E37).map(([c, v]) => [v, c]));

/** Text as an EBCDIC (CCSID 37) hex literal: AB → x'C1C2'. Characters outside printable ASCII are refused. */
export function toEbcdicHex(s: string): string {
  const bad = [...s].find(c => E37[c] === undefined);
  if (bad !== undefined) { throw new Error(`"${bad}" has no CCSID 37 value in this converter.`); }
  return `x'${[...s].map(c => E37[c].toString(16).toUpperCase().padStart(2, '0')).join('')}'`;
}
/** An EBCDIC (CCSID 37) hex literal or hex digits back to text: x'C1C2' → AB. */
export function fromEbcdicHex(s: string): string {
  const hex = s.trim().replace(/^x'(.*)'$/i, '$1').replace(/\s/g, '');
  if (!/^([0-9A-F]{2})+$/i.test(hex)) { throw new Error('Select an even number of hex digits, for example x\'C1C2\'.'); }
  return hex.match(/../g)!.map(h => FROM37.get(parseInt(h, 16)) ?? '.').join('');
}

/** The lines in a comment box (// in RPG, -- in SQL, a slash-star box in CL). */
export function boxComment(s: string, lang: 'rpgle' | 'sql' | 'cl' | string): string {
  const b = body(s).map(l => l.trimEnd()); const w = Math.max(20, ...b.map(l => l.length));
  if (lang === 'cl') { return [`/* ${'='.repeat(w)} */`, ...b.map(l => `/* ${l.padEnd(w)} */`), `/* ${'='.repeat(w)} */`].join('\n'); }
  const c = lang === 'sql' ? '--' : '//';
  return [`${c} ${'='.repeat(w)}`, ...b.map(l => `${c} ${l}`), `${c} ${'='.repeat(w)}`].join('\n');
}

const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-]+/).filter(Boolean);
/** customer_name / CUSTOMER-NAME → customerName. */
export const toCamelCase = (s: string): string => s.replace(/[A-Za-z0-9_\-]+/g, n => { const w = words(n).map(x => x.toLowerCase()); return w.map((x, i) => i ? x[0].toUpperCase() + x.slice(1) : x).join(''); });
/** customerName → CUSTOMER_NAME (SQL column style). */
export const toUpperSnake = (s: string): string => s.replace(/[A-Za-z0-9_\-]+/g, n => words(n).map(x => x.toUpperCase()).join('_'));

/** Columns separated by two or more spaces or tabs, aligned like a table. */
export function alignColumns(s: string): string {
  const rows = body(s).map(l => { const ind = /^\s*/.exec(l)![0]; return { ind, cells: l.trim() ? l.trim().split(/\t+| {2,}/) : [] }; });
  const width: number[] = [];
  for (const r of rows) { r.cells.forEach((c, i) => { width[i] = Math.max(width[i] ?? 0, c.length); }); }
  return keepEnd(s, rows.map(r => r.ind + r.cells.map((c, i) => i < r.cells.length - 1 ? c.padEnd(width[i]) : c).join('  ')));
}

// ---------------------------------------------------------------- SQL

const stripEnd = (sql: string) => sql.trim().replace(/;\s*$/, '');

/** SELECT … FROM … → SELECT COUNT(*) FROM … (ORDER BY and FETCH FIRST removed). */
export function selectToCount(sql: string): string {
  const s = stripEnd(sql); const from = /\bFROM\b/i.exec(s);
  if (!/^\s*(WITH\b[\s\S]*?\)\s*)?SELECT\b/i.test(s) || !from) { throw new Error('Put the cursor in a SELECT … FROM statement.'); }
  if (/^\s*WITH\b/i.test(s)) { return `SELECT COUNT(*) FROM (\n${s.replace(/\s+ORDER\s+BY[\s\S]*$/i, '')}\n) X`; }
  return `SELECT COUNT(*) ${s.slice(from.index).replace(/\s+(ORDER\s+BY|FETCH\s+FIRST|OFFSET|LIMIT)\b[\s\S]*$/i, '')}`;
}
/** A statement as a common table expression: WITH name AS (…) SELECT * FROM name. */
export const wrapInCte = (sql: string, name = 'X'): string => `WITH ${name} AS (\n${stripEnd(sql).split('\n').map(l => '  ' + l).join('\n')}\n)\nSELECT *\n  FROM ${name}`;
/** SELECT a, b → SELECT ROW_NUMBER() OVER () AS RN, a, b. */
export function addRowNumber(sql: string, order = ''): string {
  const s = stripEnd(sql); const m = /^(\s*SELECT\s+(?:DISTINCT\s+)?)/i.exec(s);
  if (!m) { throw new Error('Put the cursor in a SELECT statement.'); }
  return `${m[1]}ROW_NUMBER() OVER (${order ? `ORDER BY ${order}` : ''}) AS RN, ${s.slice(m[1].length)}`;
}
/** Paging: FETCH FIRST n ROWS ONLY replaced by OFFSET … FETCH NEXT. */
export function addPaging(sql: string, size = 100): string {
  const s = stripEnd(sql).replace(/\s+(FETCH\s+FIRST\s+\d+\s+ROWS?\s+ONLY|LIMIT\s+\d+)\s*$/i, '');
  return `${s}\n OFFSET 0 ROWS FETCH NEXT ${size} ROWS ONLY`;
}
/** A read without row locks: WITH UR (uncommitted read) at the end of a SELECT. */
export function readUncommitted(sql: string): string {
  const s = stripEnd(sql); if (/\bWITH\s+(UR|NC|CS|RS|RR)\s*$/i.test(s)) { return s.replace(/\bWITH\s+(UR|NC|CS|RS|RR)\s*$/i, 'WITH UR'); }
  return `${s}\n WITH UR`;
}
/** CREATE TABLE → CREATE OR REPLACE TABLE (keeps the rows when the columns allow it). */
export function createOrReplace(sql: string): string {
  const s = stripEnd(sql); if (!/^\s*CREATE\s+TABLE\b/i.test(s)) { throw new Error('Put the cursor in a CREATE TABLE statement.'); }
  return s.replace(/^\s*CREATE\s+TABLE\b/i, 'CREATE OR REPLACE TABLE') + (/\bON\s+REPLACE\b/i.test(s) ? '' : '\n  ON REPLACE PRESERVE ROWS');
}

export interface Column { name: string; type: string; key: boolean }
/** Table name and columns of a CREATE TABLE (constraints skipped; PRIMARY KEY columns marked). */
export function parseCreateTable(sql: string): { table: string; columns: Column[] } {
  const s = stripEnd(sql); const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+([\w$#@."]+)\s*\(/i.exec(s);
  if (!m) { throw new Error('Put the cursor in a CREATE TABLE statement.'); }
  let depth = 0; let i = m[0].length; let part = ''; const parts: string[] = [];
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '(') { depth++; } else if (c === ')') { if (depth === 0) { break; } depth--; }
    if (c === ',' && depth === 0) { parts.push(part); part = ''; } else { part += c; }
  }
  parts.push(part);
  const keys = new Set<string>(); const columns: Column[] = [];
  for (const raw of parts.map(p => p.trim()).filter(Boolean)) {
    const pk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(raw);
    if (pk) { pk[1].split(',').forEach(k => keys.add(k.trim().toUpperCase())); continue; }
    if (/^(CONSTRAINT|UNIQUE|FOREIGN|CHECK|PRIMARY|PERIOD)\b/i.test(raw)) { continue; }
    const c = /^("[^"]+"|[\w$#@]+)\s+(.*)$/s.exec(raw); if (!c) { continue; }
    const type = c[2].replace(/\s+/g, ' ').replace(/\b(NOT\s+NULL|WITH\s+DEFAULT|DEFAULT\b.*|PRIMARY\s+KEY|GENERATED\b.*|CCSID\s+\d+|FOR\s+(BIT|SBCS|MIXED)\s+DATA)\b.*$/i, '').trim();
    columns.push({ name: c[1], type, key: /\bPRIMARY\s+KEY\b/i.test(c[2]) });
  }
  for (const col of columns) { if (keys.has(col.name.toUpperCase())) { col.key = true; } }
  if (!columns.length) { throw new Error('No column found in the CREATE TABLE.'); }
  return { table: m[1], columns };
}
const keyCols = (t: { columns: Column[] }) => { const k = t.columns.filter(c => c.key); return k.length ? k : [t.columns[0]]; };
const label = (name: string) => words(name.replace(/"/g, '')).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');

/** LABEL ON COLUMN for every column (the text 5250 tools and Query show), from a CREATE TABLE. */
export function labelOnFromCreate(sql: string): string {
  const t = parseCreateTable(sql);
  return `LABEL ON TABLE ${t.table} IS '${label(t.table.split('.').pop()!)}';\n\nLABEL ON COLUMN ${t.table} (\n${t.columns.map((c, i) => `  ${c.name.padEnd(12)} TEXT IS '${label(c.name).slice(0, 50)}'${i < t.columns.length - 1 ? ',' : ''}`).join('\n')}\n);`;
}
/** COMMENT ON COLUMN for every column, from a CREATE TABLE. */
export function commentOnFromCreate(sql: string): string {
  const t = parseCreateTable(sql);
  return `COMMENT ON TABLE ${t.table} IS '…';\n\nCOMMENT ON COLUMN ${t.table} (\n${t.columns.map((c, i) => `  ${c.name.padEnd(12)} IS '${label(c.name)}'${i < t.columns.length - 1 ? ',' : ''}`).join('\n')}\n);`;
}
/** INSERT with every column and ? markers, from a CREATE TABLE. */
export function insertFromCreate(sql: string): string {
  const t = parseCreateTable(sql);
  return `INSERT INTO ${t.table} (\n  ${t.columns.map(c => c.name).join(', ')}\n) VALUES (\n  ${t.columns.map(() => '?').join(', ')}\n)`;
}
/** SELECT with every column, from a CREATE TABLE. */
export function selectFromCreate(sql: string): string {
  const t = parseCreateTable(sql);
  return `SELECT ${t.columns.map(c => c.name).join(',\n       ')}\n  FROM ${t.table}\n WHERE ${keyCols(t).map(c => `${c.name} = ?`).join('\n   AND ')}`;
}
/** UPDATE of every non-key column by key, from a CREATE TABLE. */
export function updateFromCreate(sql: string): string {
  const t = parseCreateTable(sql); const keys = keyCols(t); const rest = t.columns.filter(c => !keys.includes(c));
  return `UPDATE ${t.table}\n   SET ${(rest.length ? rest : t.columns).map(c => `${c.name} = ?`).join(',\n       ')}\n WHERE ${keys.map(c => `${c.name} = ?`).join('\n   AND ')}`;
}
/** MERGE (insert or update) by key, from a CREATE TABLE. */
export function mergeFromCreate(sql: string): string {
  const t = parseCreateTable(sql); const keys = keyCols(t); const rest = t.columns.filter(c => !keys.includes(c));
  const all = t.columns.map(c => c.name);
  return `MERGE INTO ${t.table} T\nUSING (VALUES (${all.map(() => '?').join(', ')})) S (${all.join(', ')})\n   ON ${keys.map(c => `T.${c.name} = S.${c.name}`).join(' AND ')}\n` +
    (rest.length ? ` WHEN MATCHED THEN UPDATE SET ${rest.map(c => `${c.name} = S.${c.name}`).join(', ')}\n` : '') +
    ` WHEN NOT MATCHED THEN INSERT (${all.join(', ')}) VALUES (${all.map(n => `S.${n}`).join(', ')})`;
}
/** An index for a simple SELECT: the columns compared with = (or IN) in the WHERE first, then those of the ORDER BY. */
export function indexForSelect(sql: string): string {
  const s = stripEnd(sql); const from = /\bFROM\s+([\w$#@."]+)/i.exec(s);
  if (!from) { throw new Error('Put the cursor in a SELECT … FROM table WHERE … statement.'); }
  const where = (/\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bFETCH\b|\bOFFSET\b|$)/i.exec(s)?.[1] ?? '');
  const eq = [...where.matchAll(/(?:^|[\s(]|AND\s+)(?:\w+\.)?("?[A-Za-z_$#@][\w$#@]*"?)\s*(=|\bIN\b)/gi)].map(m => m[1].toUpperCase());
  const order = (/\bORDER\s+BY\b([\s\S]*?)(\bFETCH\b|\bOFFSET\b|$)/i.exec(s)?.[1] ?? '').split(',').map(x => x.trim().replace(/^\w+\./, '').split(/\s+/)[0].toUpperCase()).filter(Boolean);
  const cols = [...new Set([...eq.filter(c => !/^(AND|OR|NOT)$/.test(c)), ...order])];
  if (!cols.length) { throw new Error('No column compared with = in the WHERE, and no ORDER BY.'); }
  const table = from[1]; const base = table.split('.').pop()!.replace(/"/g, '');
  return `CREATE INDEX ${table.includes('.') ? table.split('.')[0] + '.' : ''}${base}_IX_${cols[0].replace(/"/g, '')}`.slice(0, 128) + `\n  ON ${table} (${cols.join(', ')})`;
}

// ---------------------------------------------------------------- RPG declarations

export interface Decl { name: string; type: string; indent: string }
/** DCL-S (and parameter / subfield) lines: name, type and indentation. */
export function parseDecls(src: string): Decl[] {
  const out: Decl[] = [];
  for (const l of body(src)) {
    const m = /^(\s*)(?:dcl-s\s+|dcl-subf\s+|dcl-parm\s+)?([A-Za-z_$#@][\w$#@]*)\s+((?:char|varchar|ind|int|uns|packed|zoned|bindec|float|date|time|timestamp|like|likeds|pointer|graph|vargraph|ucs2|varucs2|object)\b[^;/]*)/i.exec(l);
    if (m && !/^(dcl-ds|dcl-pr|dcl-pi|dcl-proc|end-|dcl-c|dcl-f)/i.test(m[2] + ' ')) { out.push({ indent: m[1], name: m[2], type: m[3].trim() }); }
  }
  if (!out.length) { throw new Error('Select DCL-S lines (or parameter lines) first.'); }
  return out;
}
const ind = (d: Decl[]) => d[0].indent;
export const clearVars = (src: string): string => parseDecls(src).map(d => `${d.indent}clear ${d.name};`).join('\n');
export const resetVars = (src: string): string => parseDecls(src).map(d => `${d.indent}reset ${d.name};`).join('\n');
/** The empty value of a type: 0, *blanks, '', *off, *loval… */
export function emptyValue(type: string): string {
  const t = type.toLowerCase();
  if (/^(int|uns|packed|zoned|bindec|float)\b/.test(t)) { return '0'; }
  if (/^ind\b/.test(t)) { return '*off'; }
  if (/^(varchar|vargraph|varucs2)\b/.test(t)) { return "''"; }
  if (/^(date|time|timestamp)\b/.test(t)) { return '*loval'; }
  if (/^pointer\b/.test(t)) { return '*null'; }
  return '*blanks';
}
export const initVars = (src: string): string => parseDecls(src).map(d => /^like(ds)?\b/i.test(d.type) ? `${d.indent}clear ${d.name};` : `${d.indent}${d.name} = ${emptyValue(d.type)};`).join('\n');
/** One DSPLY per variable, for a quick look while testing: dsply ('NAME=' + %char(name)); */
export const traceVars = (src: string): string => parseDecls(src).map(d => {
  const t = d.type.toLowerCase();
  const v = /^(char|varchar)\b/.test(t) ? `%trimr(${d.name})` : /^ind\b/.test(t) ? `%char(${d.name})` : /^like(ds)?\b|^pointer\b/.test(t) ? `'(${d.type.split(/\s/)[0]})'` : `%char(${d.name})`;
  return `${d.indent}dsply ('${d.name}=' + ${v});`;
}).join('\n');
/** DCL-S lines → the lines of a DCL-PI / DCL-PR (CONST added to input-only types). */
export function varsToParms(src: string, procName = '*n'): string {
  const d = parseDecls(src);
  return [`${ind(d)}dcl-pi ${procName};`, ...d.map(x => `${ind(d)}  ${x.name} ${x.type.replace(/\s+const\b/i, '')}${/^like(ds)?\b/i.test(x.type) ? '' : ' const'};`), `${ind(d)}end-pi;`].join('\n');
}
/** Parameter lines → DCL-S (CONST, VALUE and OPTIONS removed). */
export const parmsToVars = (src: string): string => parseDecls(src).map(d => `${d.indent}dcl-s ${d.name} ${d.type.replace(/\s+(const|value)\b/gi, '').replace(/\s+options\([^)]*\)/i, '').trim()};`).join('\n');

/** Values (one per line) → a SELECT / WHEN skeleton on a variable. */
export function valuesToSelect(src: string, variable: string, indent = ''): string {
  const vals = body(src).map(l => l.trim()).filter(Boolean);
  if (!vals.length) { throw new Error('Select the values first, one per line.'); }
  const lit = (v: string) => /^[+-]?\d+(\.\d+)?$/.test(v) || /^\*/.test(v) || /^'.*'$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
  return [`${indent}select;`, ...vals.flatMap(v => [`${indent}  when ${variable} = ${lit(v)};`, `${indent}    // ${v}`]), `${indent}  other;`, `${indent}    // none of them`, `${indent}endsl;`].join('\n');
}
/** Values (one per line) → an array with those values (a data structure that overlays them). */
export function valuesToArray(src: string, name: string, indent = ''): string {
  const vals = body(src).map(l => l.trim()).filter(Boolean);
  if (!vals.length) { throw new Error('Select the values first, one per line.'); }
  const len = Math.max(1, ...vals.map(v => v.replace(/^'(.*)'$/, '$1').length));
  return [`${indent}dcl-ds ${name}_values;`, ...vals.map(v => `${indent}  *n char(${len}) inz('${v.replace(/^'(.*)'$/, '$1').replace(/'/g, "''")}');`),
    `${indent}  ${name} char(${len}) dim(${vals.length}) pos(1);`, `${indent}end-ds;`].join('\n');
}

const fileName = (f: string) => { const u = f.trim(); if (!/^[A-Za-z_$#@][\w$#@]{0,9}$/.test(u)) { throw new Error(`"${f}" is not a valid file name.`); } return u.toLowerCase(); };
/** A READ loop over a keyed or arrival-sequence file. */
export function readLoop(file: string, indent = '', key = ''): string {
  const f = fileName(file);
  return key ? [`${indent}setll (${key}) ${f};`, `${indent}reade (${key}) ${f};`, `${indent}dow not %eof(${f});`, `${indent}  // process the record`, `${indent}  reade (${key}) ${f};`, `${indent}enddo;`].join('\n')
    : [`${indent}setll *loval ${f};`, `${indent}read ${f};`, `${indent}dow not %eof(${f});`, `${indent}  // process the record`, `${indent}  read ${f};`, `${indent}enddo;`].join('\n');
}
/** An SQL cursor loop: declare, open, fetch until SQLCODE 100, close. */
export function cursorLoop(select: string, cursor = 'C1', indent = ''): string {
  const s = stripEnd(select || 'SELECT … FROM … WHERE …').replace(/\s+/g, ' ');
  return [
    `${indent}exec sql declare ${cursor} cursor for`, `${indent}  ${s};`,
    `${indent}exec sql open ${cursor};`, `${indent}dow 1 = 1;`, `${indent}  exec sql fetch next from ${cursor} into :row;`,
    `${indent}  if sqlcode = 100 or sqlcode < 0;`, `${indent}    leave;`, `${indent}  endif;`, `${indent}  // process the row`, `${indent}enddo;`,
    `${indent}if sqlcode < 0;`, `${indent}  // handle the SQL error (SQLSTATE in sqlstate)`, `${indent}endif;`, `${indent}exec sql close ${cursor};`,
  ].join('\n');
}
/** The program status data structure with the fields people look at. */
export const psds = (indent = ''): string => [
  `${indent}dcl-ds pgmStatus psds qualified;`, `${indent}  program *proc;`, `${indent}  status *status;`, `${indent}  routine *routine;`,
  `${indent}  messageId char(7) pos(40);`, `${indent}  library char(10) pos(81);`, `${indent}  messageData char(80) pos(91);`,
  `${indent}  jobName char(10) pos(244);`, `${indent}  jobUser char(10) pos(254);`, `${indent}  jobNumber zoned(6) pos(264);`, `${indent}  currentUser char(10) pos(358);`, `${indent}end-ds;`,
].join('\n');
/** The file information data structure (INFDS) of a file, and the INFDS keyword to add to its DCL-F. */
export function infds(file: string, indent = ''): string {
  const f = fileName(file);
  return [`${indent}// Add infds(${f}Info) to the DCL-F of ${f}.`, `${indent}dcl-ds ${f}Info qualified;`, `${indent}  file *file;`, `${indent}  status *status;`, `${indent}  opcode *opcode;`, `${indent}  record *record;`,
    `${indent}  relativeRecord int(10) pos(397);`, `${indent}  recordsRead int(10) pos(371);`, `${indent}end-ds;`].join('\n');
}
/** The selection commented out with a date, an author and a reason. */
export function commentOut(src: string, lang: string, who: string, date: string, why: string): string {
  const c = lang === 'sql' ? '--' : '//';
  const head = `${c} ${date} ${who}: ${why || 'removed'}`;
  if (lang === 'cl') { return [`/* ${date} ${who}: ${why || 'removed'} */`, ...body(src).map(l => `/* ${l.replace(/\*\//g, '* /')} */`)].join('\n'); }
  const i = /^\s*/.exec(body(src)[0] ?? '')![0];
  return [`${i}${head}`, ...body(src).map(l => `${i}${c} ${l.slice(i.length)}`)].join('\n');
}

// ---------------------------------------------------------------- CL templates

const clName = (v: string, what: string) => { const u = v.trim().toUpperCase(); if (!/^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); } return u; };
/** RTVJOBA with the variables it fills. */
export const clRtvjoba = (): string => [
  'DCL VAR(&JOB) TYPE(*CHAR) LEN(10)', 'DCL VAR(&USER) TYPE(*CHAR) LEN(10)', 'DCL VAR(&NBR) TYPE(*CHAR) LEN(6)', 'DCL VAR(&TYPE) TYPE(*CHAR) LEN(1)', 'DCL VAR(&CURLIB) TYPE(*CHAR) LEN(10)',
  'RTVJOBA JOB(&JOB) USER(&USER) NBR(&NBR) TYPE(&TYPE) CURLIB(&CURLIB) /* TYPE 0 = batch, 1 = interactive */',
].join('\n');
/** CHKOBJ with MONMSG and an escape message when the object is missing. */
export function clCheckObject(obj: string, type: string): string {
  const parts = obj.toUpperCase().split('/'); const name = clName(parts.pop()!, 'object'); const lib = parts.length ? clName(parts[0], 'library') : '*LIBL';
  const t = type.trim().toUpperCase().replace(/^\*?/, '*');
  return [`CHKOBJ OBJ(${lib}/${name}) OBJTYPE(${t})`, `MONMSG MSGID(CPF9801) EXEC(DO)`, `  SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('${name} ${t} not found in ${lib}') MSGTYPE(*ESCAPE)`, `ENDDO`].join('\n');
}
/** DCLF and a RCVF loop over a database file. */
export function clReadLoop(file: string): string {
  const f = clName(file, 'file');
  return [`DCLF FILE(${f}) /* put it with the other DCLs */`, ``, `LOOP: RCVF`, `MONMSG MSGID(CPF0864) EXEC(GOTO CMDLBL(EOF)) /* end of file */`, `/* process the record: its fields are &FIELD variables */`, `GOTO CMDLBL(LOOP)`, `EOF:`].join('\n');
}
/** A message sent as an escape (or a completion, information…) message. */
export function clSendMessage(text: string, type: '*ESCAPE' | '*COMP' | '*INFO' | '*DIAG' = '*ESCAPE'): string {
  return `SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('${(text || 'Text of the message').replace(/'/g, "''")}') MSGTYPE(${type})`;
}
/** The selection between OVRDBF and DLTOVR. */
export function clOverride(src: string, file: string, to: string): string {
  const f = clName(file, 'file'); const parts = to.toUpperCase().split('/'); const n = clName(parts.pop()!, 'file'); const lib = parts.length ? clName(parts[0], 'library') : '*LIBL';
  return [`OVRDBF FILE(${f}) TOFILE(${lib}/${n}) OVRSCOPE(*CALLLVL)`, src.replace(/\n$/, ''), `DLTOVR FILE(${f})`].join('\n');
}
/** RTVSYSVAL into a variable of the right length. */
export function clSystemValue(sysval: string): string {
  const v = clName(sysval, 'system value'); const len = /^(QDATE)$/.test(v) ? 6 : /^(QTIME)$/.test(v) ? 9 : /^(QDATETIME)$/.test(v) ? 20 : 20;
  return [`DCL VAR(&${v.slice(0, 10)}) TYPE(*CHAR) LEN(${len})`, `RTVSYSVAL SYSVAL(${v}) RTNVAR(&${v.slice(0, 10)})`].join('\n');
}
