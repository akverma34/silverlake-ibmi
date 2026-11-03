// Productivity helpers: the files an RPG source declares (for hovers and completion of their fields), CL macros with
// ${variables}, CL commands found in a selection, SQL watch conditions, and report tables as CSV. Pure (no vscode
// import), unit tested.

// ---------------------------------------------------------------- files declared in RPG

export interface DeclaredFile { name: string; library?: string; file: string; line: number; prefix?: string; qualified: boolean }

/** dcl-f (with EXTFILE, EXTDESC, PREFIX, QUALIFIED) and fixed-format F specs. */
export function filesInSource(text: string): DeclaredFile[] {
  const out: DeclaredFile[] = [];
  const lines = text.split(/\r?\n/);
  const clean = (s: string) => s.replace(/\/\/.*$/, '');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Fixed format: F in column 6, file name in 7-16, "E" (externally described) in column 22.
    if (/^.{5}[Ff]/.test(raw) && raw[6] !== '*' && raw.slice(6, 16).trim() && (raw[21] ?? '').toUpperCase() === 'E') {
      const kw = raw.slice(43).toUpperCase();
      const ext = /EXTFILE\(\s*'([^']+)'\s*\)/.exec(kw)?.[1];
      const name = raw.slice(6, 16).trim().toUpperCase();
      const [lib, file] = ext?.includes('/') ? ext.split('/') : [undefined, ext ?? name];
      out.push({ name, library: lib, file, line: i, prefix: /PREFIX\(\s*([A-Z0-9_$#@]+)/.exec(kw)?.[1], qualified: false });
      continue;
    }
    let s = clean(raw);
    const m = /^\s*dcl-f\s+([A-Za-z$#@_][\w$#@]*)\b/i.exec(s);
    if (!m) { continue; }
    // A declaration may continue on the next lines up to the ";".
    let j = i;
    while (!s.includes(';') && j < i + 8 && j + 1 < lines.length) { j++; s += ' ' + clean(lines[j]); }
    const u = s.toUpperCase();
    if (/\bLIKEFILE\(/.test(u)) { continue; }
    const ext = /EXT(?:FILE|DESC)\(\s*'([^']+)'\s*\)/.exec(u)?.[1];
    const name = m[1].toUpperCase();
    const [lib, file] = ext?.includes('/') ? ext.split('/') : [undefined, ext ?? name];
    out.push({ name, library: lib && lib !== '*LIBL' ? lib : undefined, file, line: i, prefix: /PREFIX\(\s*([A-Z0-9_$#@]+)/.exec(u)?.[1], qualified: /\bQUALIFIED\b/.test(u) });
  }
  return out;
}

export interface FileColumn { name: string; type: string; length: number; scale: number; nullable: boolean; text: string; heading: string }

export function columnType(c: Pick<FileColumn, 'type' | 'length' | 'scale'>): string {
  const t = c.type.toUpperCase();
  if (/DECIMAL|NUMERIC/.test(t)) { return `${t === 'DECIMAL' ? 'packed' : 'zoned'}(${c.length}:${c.scale})`; }
  if (/^(CHAR|CHARACTER)$/.test(t)) { return `char(${c.length})`; }
  if (/VARCHAR/.test(t)) { return `varchar(${c.length})`; }
  if (t === 'INTEGER') { return 'int(10)'; }
  if (t === 'SMALLINT') { return 'int(5)'; }
  if (t === 'BIGINT') { return 'int(20)'; }
  return t.toLowerCase();
}

/** Markdown for a file: its columns as a table (at most `max`). */
export function fileMarkdown(f: DeclaredFile, library: string, cols: FileColumn[], text = '', max = 40): string {
  const head = `**${library}/${f.file}**${f.name !== f.file ? ` (as ${f.name})` : ''}${text ? ` — ${text}` : ''}  \n${cols.length} field(s)${f.prefix ? ` · prefix ${f.prefix}` : ''}${f.qualified ? ' · qualified' : ''}\n\n`;
  const rows = cols.slice(0, max).map(c => `| ${c.name} | ${columnType(c)}${c.nullable ? ' null' : ''} | ${(c.text || c.heading).replace(/\|/g, '\\|')} |`);
  return head + '| Field | Type | Text |\n|---|---|---|\n' + rows.join('\n') + (cols.length > max ? `\n\n… ${cols.length - max} more` : '') + '\n';
}

/** The field a name refers to: a column of a declared file, with its PREFIX applied (PREFIX(C_) → C_CUSTNO). */
export function fieldOf(name: string, files: { file: DeclaredFile; cols: FileColumn[] }[]): { file: DeclaredFile; col: FileColumn } | undefined {
  const n = name.toUpperCase();
  for (const f of files) {
    for (const c of f.cols) {
      const as = f.file.prefix ? `${f.file.prefix}${c.name}` : c.name;
      if (f.file.qualified ? `${f.file.name}.${c.name}` === n : as === n) { return { file: f.file, col: c }; }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- CL macros

const VAR = /\$\{([A-Za-z_][\w]*)(?::([^}]*))?\}/g;

/** The variables a macro asks for, with their default (${LIB:MYLIB}), in order of first use. */
export function macroVariables(commands: string[]): { name: string; default: string }[] {
  const out = new Map<string, string>();
  for (const c of commands) { for (const m of c.matchAll(VAR)) { if (!out.has(m[1]) && !BUILTIN.has(m[1])) { out.set(m[1], m[2] ?? ''); } } }
  return [...out.entries()].map(([name, d]) => ({ name, default: d }));
}

const BUILTIN = new Set(['USER', 'CURLIB', 'DATE', 'TIME']);

export function expandMacro(commands: string[], values: Record<string, string>, builtins: { USER: string; CURLIB: string; now?: Date }): string[] {
  const now = builtins.now ?? new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const b: Record<string, string> = { USER: builtins.USER, CURLIB: builtins.CURLIB, DATE: `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`, TIME: `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}` };
  const defaults = Object.fromEntries(macroVariables(commands).map(v => [v.name, v.default]));
  return commands.map(c => c.replace(VAR, (_, n: string, d?: string) => (values[n] || undefined) ?? b[n] ?? (d || defaults[n] || '')).trim()).filter(Boolean);
}

/** CL commands in a selection: continuation lines (+ or - at the end) joined, comments and labels removed. */
export function clCommandsIn(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\/\*.*?\*\//g, '').trimEnd();
    if (!l.trim()) { continue; }
    if (/[+-]$/.test(l)) { buf += l.slice(0, -1) + (l.endsWith('+') ? '' : ' '); continue; }
    out.push((buf + l).replace(/^\s*[A-Z_][A-Z0-9_]*:\s*/i, '').replace(/\s+/g, ' ').trim());
    buf = '';
  }
  if (buf.trim()) { out.push(buf.replace(/\s+/g, ' ').trim()); }
  return out.filter(c => !/^(PGM|ENDPGM|DCL|DCLF|DCLPRCOPT)\b/i.test(c));
}

/** SQL or CL? */
export function looksLikeSql(text: string): boolean {
  return /^\s*(--.*\n\s*)*(SELECT|WITH|VALUES|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|CALL|SET|LABEL|COMMENT|GRANT|REVOKE|DECLARE|TRUNCATE|RENAME|REFRESH)\b/i.test(text);
}

// ---------------------------------------------------------------- SQL watch

export interface Condition { test: (v: string) => boolean; text: string }

/** "changes" (default), "> 100", "<= 5", "= ACTIVE", "!= 0", "contains MSGW", "rows > 0". */
export function parseCondition(input: string): Condition {
  const t = input.trim();
  if (!t || /^changes?$/i.test(t)) { return { test: () => true, text: 'changes' }; }
  const m = /^(>=|<=|!=|<>|>|<|=)\s*(.+)$/.exec(t);
  if (m) {
    const want = m[2].trim().replace(/^'|'$/g, '');
    const num = Number(want);
    const op = m[1] === '<>' ? '!=' : m[1];
    return {
      text: `${op} ${want}`,
      test: v => {
        const x = Number(v); const numeric = want !== '' && !Number.isNaN(num) && v.trim() !== '' && !Number.isNaN(x);
        const [a, b] = numeric ? [x, num] : [v.trim(), want];
        switch (op) { case '>': return a > b; case '<': return a < b; case '>=': return a >= b; case '<=': return a <= b; case '=': return a === b; default: return a !== b; }
      },
    };
  }
  const c = /^contains\s+(.+)$/i.exec(t);
  if (c) { const w = c[1].trim().toUpperCase(); return { text: `contains ${c[1].trim()}`, test: v => v.toUpperCase().includes(w) }; }
  throw new Error(`"${input}" is not a condition: use changes, > 100, = ACTIVE, != 0 or contains TEXT.`);
}

/** A short text for the status bar from the first row: one value, or "N rows". */
export function watchValue(rows: Record<string, unknown>[]): string {
  if (!rows.length) { return '0 rows'; }
  const vals = Object.values(rows[0]);
  if (rows.length === 1 && vals.length === 1) { return String(vals[0] ?? '').trim(); }
  if (rows.length === 1) { return vals.map(v => String(v ?? '').trim()).join(' · ').slice(0, 80); }
  return `${rows.length} rows`;
}

/** True when the watch should alert: the condition holds now and did not hold (or had another value) before. */
export function shouldAlert(cond: Condition, previous: string | undefined, now: string): boolean {
  if (cond.text === 'changes') { return previous !== undefined && previous !== now; }
  return cond.test(now) && (previous === undefined || !cond.test(previous));
}

// ---------------------------------------------------------------- report export

export function tableCsv(columns: string[], rows: (string | number | null)[][], sep = ','): string {
  const q = (v: string | number | null) => { const s = v === null || v === undefined ? '' : String(v); return s.includes(sep) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns, ...rows].map(r => r.map(q).join(sep)).join('\r\n') + '\r\n';
}

export function tableTsv(columns: string[], rows: (string | number | null)[][]): string {
  const c = (v: string | number | null) => (v === null || v === undefined ? '' : String(v)).replace(/[\t\r\n]+/g, ' ');
  return [columns, ...rows].map(r => r.map(c).join('\t')).join('\n') + '\n';
}
