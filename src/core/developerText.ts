// Everyday text tools for IBM i sources (pure, unit tested, in addition to textTools): lines to an SQL IN list, text to an RPG or SQL literal, a
// CL command for QSYS2.QCMDEXC, SQL between scripts and embedded SQL, SQL keyword case, aligned assignments and
// comments, blank lines removed, sources cleaned (tabs, trailing blanks, odd spaces), long CL commands wrapped with +,
// code as a Markdown block, and the compile command of a member.

/** Text as a literal: quotes doubled. */
export function toLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** One value per line → ('a', 'b', 'c'); numbers stay numbers unless `quoteAll`. Blank lines and duplicates dropped. */
export function toSqlInList(text: string, quoteAll = false): string {
  const vals = [...new Set(text.split(/\r?\n|,|\t/).map(v => v.trim()).filter(Boolean).map(v => v.replace(/^'(.*)'$/, '$1')))];
  if (!vals.length) { throw new Error('Select one value per line.'); }
  return `(${vals.map(v => (!quoteAll && /^[-+]?\d+(\.\d+)?$/.test(v) ? v : toLiteral(v))).join(', ')})`;
}

/** A CL command as an SQL call of QSYS2.QCMDEXC (runs from Run SQL, ACS or any SQL client). */
export function toQcmdexc(cl: string): string {
  const one = cl.split(/\r?\n/).map(l => l.replace(/\/\*.*?\*\//g, '').trimEnd()).map(l => l.replace(/[+-]$/, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!one) { throw new Error('Select a CL command.'); }
  return `CALL QSYS2.QCMDEXC(${toLiteral(one)});`;
}

/** An SQL statement from a script as embedded SQL: ? parameter markers become :host variables, ; ends it. */
export function sqlToEmbedded(sql: string, indent = ''): string {
  let n = 0;
  const body = sql.trim().replace(/;\s*$/, '').replace(/'(?:[^']|'')*'|\?/g, m => (m === '?' ? `:p${++n}` : m));
  if (!body) { throw new Error('Select an SQL statement.'); }
  const lines = body.split(/\r?\n/).map(l => l.trimEnd());
  const base = Math.min(...lines.slice(1).filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length), 999);
  return `${indent}exec sql ${lines[0].trim()}` + lines.slice(1).map(l => `\n${indent}  ${l.slice(base === 999 ? 0 : base)}`).join('') + ';';
}

/** Embedded SQL (EXEC SQL … ;) as a script statement you can run: :host variables become ? markers (or a value). */
export function embeddedToSql(text: string, value?: (host: string) => string | undefined): string {
  const body = text.replace(/\/\/.*$/gm, '').replace(/^\s*exec\s+sql\s+/i, '').replace(/;\s*$/, '').trim();
  if (!body) { throw new Error('Put the cursor in an EXEC SQL statement.'); }
  // INTO :a, :b of a SELECT goes away (a script shows the rows).
  const noInto = body.replace(/\binto\s+:[\w$#@.]+(\s*:\s*[\w$#@]+)?(\s*,\s*:[\w$#@.]+(\s*:\s*[\w$#@]+)?)*\s+(?=from\b)/i, '');
  const lines = noInto.split(/\r?\n/);
  const base = Math.min(...lines.slice(1).filter(l => l.trim()).map(l => /^\s*/.exec(l)![0].length), 999);
  const joined = [lines[0].trim(), ...lines.slice(1).map(l => l.slice(base === 999 ? 0 : base).trimEnd())].join('\n');
  return joined.replace(/'(?:[^']|'')*'|:([A-Za-z_$#@][\w$#@]*(?:\.[\w$#@]+)*)/g, (m, h) => (h ? value?.(h) ?? '?' : m)) + ';';
}

const SQL_WORDS = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'UNION', 'ALL', 'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'MERGE', 'MATCHED',
  'CREATE', 'OR', 'REPLACE', 'TABLE', 'VIEW', 'INDEX', 'ALTER', 'DROP', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT', 'WITH', 'FETCH', 'FIRST',
  'NEXT', 'ROWS', 'ROW', 'ONLY', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'CAST', 'COALESCE', 'COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'CALL', 'DECLARE', 'CURSOR', 'FOR', 'OPEN', 'CLOSE', 'COMMIT', 'ROLLBACK',
  'TRUNCATE', 'LABEL', 'COMMENT', 'GRANT', 'REVOKE', 'CHAR', 'VARCHAR', 'DECIMAL', 'NUMERIC', 'INTEGER', 'INT', 'SMALLINT', 'BIGINT', 'DATE', 'TIME', 'TIMESTAMP', 'CURRENT', 'TRUE', 'FALSE', 'LATERAL', 'TABLE'];
const SQL_SET = new Set(SQL_WORDS);

/** SQL keywords in upper or lower case; names, literals, comments and :host variables untouched. */
export function sqlKeywordCase(sql: string, mode: 'upper' | 'lower'): string {
  return sql.replace(/'(?:[^']|'')*'|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\/|:[\w$#@]+|[A-Za-z_]\w*/g, m => {
    if (/^['"-/:]/.test(m) || !SQL_SET.has(m.toUpperCase())) { return m; }
    return mode === 'upper' ? m.toUpperCase() : m.toLowerCase();
  });
}

/** Lines of `x = …;` with their = signs (or += -= …) in one column. */
export function alignAssignments(lines: string[]): string[] {
  const re = /^(\s*(?:eval\s+)?[^=;'"]*?[^\s=<>!+\-*/])\s*([-+*/]?=)(?!=)\s*(.*)$/i;
  const parts = lines.map(l => (/^\s*(\/\/|if\b|when\b|dow\b|dou\b|for\b|elseif\b)/i.test(l) ? null : re.exec(l)));
  const w = Math.max(0, ...parts.map(p => (p ? p[1].length : 0)));
  if (!parts.some(Boolean)) { throw new Error('Select lines with assignments (x = …).'); }
  return lines.map((l, i) => { const p = parts[i]; return p ? `${p[1].padEnd(w)} ${p[2].padStart(2)} ${p[3]}`.replace(/\s+$/, '') : l; });
}

/** End-of-line // comments in one column (after the longest code). */
export function alignComments(lines: string[], marker = '//'): string[] {
  const split = lines.map(l => {
    let inS = false;
    for (let i = 0; i < l.length; i++) { if (l[i] === "'") { inS = !inS; } else if (!inS && l.startsWith(marker, i) && l.slice(0, i).trim()) { return [l.slice(0, i).trimEnd(), l.slice(i)]; } }
    return null;
  });
  if (!split.some(Boolean)) { throw new Error('Select lines that end with a // comment.'); }
  const w = Math.max(...split.map(s => (s ? s[0].length : 0)));
  return lines.map((l, i) => (split[i] ? `${split[i]![0].padEnd(w)}  ${split[i]![1]}` : l));
}

export function removeBlankLines(lines: string[]): string[] { return lines.filter(l => l.trim()); }

/** Tabs to spaces, trailing blanks removed, non-breaking and zero-width spaces replaced: what breaks members and diffs. */
export function cleanSource(text: string, tab = 2): { text: string; changes: number } {
  let changes = 0;
  const out = text.split(/\r?\n/).map(l => {
    const n = l.replace(/\t/g, ' '.repeat(tab)).replace(/[   ]/g, ' ').replace(/[​‌‍﻿]/g, '').replace(/[ ]+$/, '');
    if (n !== l) { changes++; }
    return n;
  }).join('\n');
  return { text: out, changes };
}

/** A long CL command split before column `width` with + continuations (never inside a quoted string). */
export function wrapClCommand(line: string, width = 80, indent = 25): string[] {
  if (line.length <= width) { return [line]; }
  const out: string[] = []; let rest = line.trimEnd(); let first = true;
  while (rest.length > width) {
    let cut = -1; let inS = false; let depth = 0;
    for (let i = 0; i < width - 2; i++) {
      const c = rest[i];
      if (c === "'") { inS = !inS; } else if (!inS && c === '(') { depth++; } else if (!inS && c === ')') { depth--; }
      if (!inS && c === ' ' && i > (first ? 10 : indent)) { cut = i; }
    }
    if (cut < 0) { break; }
    out.push(rest.slice(0, cut).trimEnd() + ' +');
    rest = ' '.repeat(indent) + rest.slice(cut).trimStart();
    first = false;
  }
  out.push(rest);
  return out;
}

/** Code as a Markdown block with where it comes from (for chat, tickets, e-mails). */
export function markdownBlock(code: string, language: string, where?: string): string {
  const lang = { rpgle: 'rpgle', sqlrpgle: 'rpgle', cl: 'cl', clle: 'cl', sql: 'sql', dds: 'dds' }[language.toLowerCase()] ?? language.toLowerCase();
  return `${where ? `\`${where}\`\n\n` : ''}\`\`\`${lang}\n${code.replace(/\s+$/, '')}\n\`\`\`\n`;
}

/** The command that compiles a member, from its type. */
export function compileCommand(lib: string, file: string, member: string, type: string, objLib = lib): string | undefined {
  const L = lib.toUpperCase(); const F = file.toUpperCase(); const M = member.toUpperCase(); const O = objLib.toUpperCase();
  const src = `SRCFILE(${L}/${F}) SRCMBR(${M})`;
  switch (type.toUpperCase()) {
    case 'RPGLE': return `CRTBNDRPG PGM(${O}/${M}) ${src} DBGVIEW(*SOURCE) REPLACE(*YES)`;
    case 'SQLRPGLE': return `CRTSQLRPGI OBJ(${O}/${M}) ${src} OBJTYPE(*PGM) DBGVIEW(*SOURCE) REPLACE(*YES)`;
    case 'RPGLEMOD': return `CRTRPGMOD MODULE(${O}/${M}) ${src} DBGVIEW(*SOURCE) REPLACE(*YES)`;
    case 'CLLE': return `CRTBNDCL PGM(${O}/${M}) ${src} DBGVIEW(*SOURCE) REPLACE(*YES)`;
    case 'CLP': return `CRTCLPGM PGM(${O}/${M}) ${src} REPLACE(*YES)`;
    case 'RPG': return `CRTRPGPGM PGM(${O}/${M}) ${src} REPLACE(*YES)`;
    case 'PF': return `CRTPF FILE(${O}/${M}) ${src}`;
    case 'LF': return `CRTLF FILE(${O}/${M}) ${src}`;
    case 'DSPF': return `CRTDSPF FILE(${O}/${M}) ${src} REPLACE(*YES)`;
    case 'PRTF': return `CRTPRTF FILE(${O}/${M}) ${src} REPLACE(*YES)`;
    case 'CMD': return `CRTCMD CMD(${O}/${M}) PGM(*LIBL/${M}) ${src} REPLACE(*YES)`;
    case 'SQL': return `RUNSQLSTM ${src} COMMIT(*NONE) NAMING(*SYS)`;
    case 'BND': return `CRTSRVPGM SRVPGM(${O}/${M}) MODULE(${O}/${M}) EXPORT(*SRCFILE) ${src}`;
    case 'CBLLE': return `CRTBNDCBL PGM(${O}/${M}) ${src} DBGVIEW(*SOURCE) REPLACE(*YES)`;
    default: return undefined;
  }
}

/** Comma or tab separated lines as SQL VALUES rows (numbers unquoted, empty cells NULL). */
export function csvToValues(text: string, table?: string): string {
  const rows = text.split(/\r?\n/).filter(l => l.trim());
  if (!rows.length) { throw new Error('Select comma or tab separated lines.'); }
  const sep = rows[0].includes('\t') ? '\t' : rows[0].includes(';') && !rows[0].includes(',') ? ';' : ',';
  const cell = (v: string) => { const t = v.trim().replace(/^"(.*)"$/, '$1'); return !t ? 'NULL' : /^[-+]?\d+(\.\d+)?$/.test(t) ? t : toLiteral(t); };
  const body = rows.map(r => `  (${r.split(sep).map(cell).join(', ')})`).join(',\n');
  return table ? `INSERT INTO ${table}\n VALUES\n${body};` : `VALUES\n${body};`;
}

/** SELECT COUNT(*) with the same table and WHERE as an UPDATE or DELETE: how many rows will change. */
export function countFirst(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, '');
  let m = /^delete\s+from\s+([\w$#@."/]+)(?:\s+(?:as\s+)?(\w+))?\s*(where\b[\s\S]*)?$/i.exec(s);
  if (m) { return `SELECT COUNT(*) FROM ${m[1]}${m[2] && !/^where$/i.test(m[2]) ? ' ' + m[2] : ''}${m[3] ? ' ' + m[3].trim() : ''};`; }
  m = /^update\s+([\w$#@."/]+)(?:\s+(?:as\s+)?(\w+))?\s+set\b[\s\S]*?(\bwhere\b[\s\S]*)?$/i.exec(s);
  if (m) { return `SELECT COUNT(*) FROM ${m[1]}${m[2] && !/^set$/i.test(m[2]) ? ' ' + m[2] : ''}${m[3] ? ' ' + m[3].trim() : ''};`; }
  throw new Error('Put the cursor in an UPDATE or DELETE statement.');
}

/** A SELECT limited to n rows (FETCH FIRST n ROWS ONLY), replacing an existing limit. */
export function limitSelect(sql: string, n = 100): string {
  const s = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with|values)\b/i.test(s)) { throw new Error('Put the cursor in a SELECT statement.'); }
  return `${s.replace(/\s+(fetch\s+first\s+\d*\s*rows?\s+only|limit\s+\d+)\s*$/i, '')}\n  FETCH FIRST ${n} ROWS ONLY;`;
}

/** CL in upper case, except quoted strings and comments. */
export function clUppercase(text: string): string {
  return text.replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|[^'/]+|\//g, m => (m.startsWith("'") || m.startsWith('/*') ? m : m.toUpperCase()));
}

/** A CL program with a global MONMSG and an ERROR: block that sends the error back to the caller. */
export function clErrorHandler(source: string): string {
  const lines = source.split(/\r?\n/);
  const up = source.toUpperCase();
  if (/^\s*ERROR\s*:/m.test(up)) { throw new Error('This program already has an ERROR: label.'); }
  if (/MONMSG\s+(MSGID\()?CPF0000\)?\s+EXEC\(\s*GOTO/.test(up)) { throw new Error('This program already has a global MONMSG.'); }
  const endpgm = lines.findIndex(l => /^\s*(\w+:\s*)?ENDPGM\b/i.test(l));
  if (endpgm < 0) { throw new Error('No ENDPGM in this program.'); }
  // After PGM and the declarations.
  let at = 0; let cont = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/\/\*.*?\*\//g, '').trim();
    if (cont) { cont = /[+-]$/.test(t); at = i + 1; continue; }
    if (!t) { continue; }
    if (/^(\w+:\s*)?(PGM|DCL|DCLF|COPYRIGHT|DCLPRCOPT)\b/i.test(t)) { at = i + 1; cont = /[+-]$/.test(t); continue; }
    break;
  }
  const need = [['&MSGID', 7], ['&MSGF', 10], ['&MSGFLIB', 10], ['&MSGDTA', 256]].filter(([n]) => !new RegExp(`DCL\\s+(VAR\\()?\\${n}\\b`).test(up));
  const pad = (s: string) => `             ${s}`;
  const dcls = need.map(([n, l]) => pad(`DCL        VAR(${n}) TYPE(*CHAR) LEN(${l})`));
  const monmsg = pad('MONMSG     MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))');
  const handler = [
    pad('RETURN'),
    '',
    'ERROR:      /* An unexpected error: send it back to the caller */',
    pad('RCVMSG     MSGTYPE(*EXCP) MSGDTA(&MSGDTA) MSGID(&MSGID) +'),
    pad('             MSGF(&MSGF) SNDMSGFLIB(&MSGFLIB)'),
    pad('MONMSG     MSGID(CPF0000)'),
    pad('SNDPGMMSG  MSGID(&MSGID) MSGF(&MSGFLIB/&MSGF) MSGDTA(&MSGDTA) +'),
    pad('             MSGTYPE(*ESCAPE)'),
    pad('MONMSG     MSGID(CPF0000)'),
  ];
  const out = [...lines];
  out.splice(endpgm, 0, ...handler);
  out.splice(at, 0, ...dcls, monmsg);
  return out.join('\n');
}

/** Offline suggestions in SQL scripts: WHERE after UPDATE … SET or DELETE FROM when the statement has none yet. */
export function sqlSuggest(lines: string[], line: number, column: number): string | undefined {
  const cur = lines[line] ?? '';
  if (cur.slice(column).trim()) { return undefined; }
  // The statement so far: back to the previous ";".
  let s = cur.slice(0, column);
  for (let i = line - 1; i >= 0 && !/;\s*(--.*)?$/.test(lines[i]); i--) { s = lines[i] + '\n' + s; }
  const u = s.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '').toUpperCase();
  if (/\bWHERE\b|;/.test(u)) { return undefined; }
  const before = cur.slice(0, column);
  if (/^\s*DELETE\s+FROM\s+[\w$#@."/]+\s+$/.test(u) || (/^\s*UPDATE\s+[\w$#@."/]+\s+SET\s+[\s\S]*\S/.test(u) && !before.trim() && !/,\s*$/.test(u.trimEnd()))) {
    return 'WHERE ';
  }
  return undefined;
}

/** The literal around a column of a line: its text and range. */
export function literalAt(line: string, col: number): { start: number; end: number; text: string; hex: boolean } | undefined {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "'") { continue; }
    const hex = i > 0 && /[xX]/.test(line[i - 1]) && !/[\w$#@]/.test(line[i - 2] ?? '');
    let j = i + 1;
    while (j < line.length) { if (line[j] === "'") { if (line[j + 1] === "'") { j += 2; continue; } break; } j++; }
    if (col >= i && col <= j) { return { start: hex ? i - 1 : i, end: j + 1, text: line.slice(i + 1, j).replace(/''/g, "'"), hex }; }
    i = j;
  }
  return undefined;
}
