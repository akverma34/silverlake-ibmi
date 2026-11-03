// Suggestions while you type (shown as grey "ghost text", accepted with Tab), for RPG and CL. They come from the code
// you write, not from a model: the next statement an IBM i developer nearly always writes (IF %FOUND after CHAIN, an
// SQLCODE test after embedded SQL, OPEN / FETCH after DECLARE CURSOR, MONMSG after CHKOBJ…), the type of a new
// variable from its name and from the variables already declared, the file of %FOUND / %EOF, and the parameters of a
// call. Pure (no vscode import), unit tested, instant and offline.
import { isFixedLine, isFullyFreeSource, maskLine } from './parser';

export interface SuggestContext {
  lines: string[];
  line: number;
  /** Cursor column on `line`. */
  column: number;
  language: 'rpgle' | 'cl';
  /** Parameter names of the procedures known in the source (upper-case name → names). */
  signatures?: Map<string, string[]>;
}

/** The text to insert at the cursor, or undefined. It may hold several lines (already indented). */
export function suggest(ctx: SuggestContext): string | undefined {
  const raw = ctx.lines[ctx.line] ?? '';
  const before = raw.slice(0, ctx.column);
  if (raw.slice(ctx.column).trim()) { return undefined; } // only at the end of a line
  try {
    return ctx.language === 'cl' ? suggestCl(ctx, before) : suggestRpg(ctx, before);
  } catch { return undefined; }
}

// ---------------------------------------------------------------- RPG

const id = '[A-Za-z_$#@][\\w$#@]*';

/** The type of a new variable from its name: the type of a declared variable with the same last word, else a convention. */
export function typeForName(name: string, lines: string[] = []): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean);
  const last = (words[words.length - 1] ?? name).toLowerCase();
  // Learn from the source: dcl-s shipName varchar(40) → custName varchar(40).
  if (last.length >= 3) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = new RegExp(`^\\s*dcl-s\\s+(${id})\\s+([^;]+);`, 'i').exec(lines[i]);
      if (!m || m[1].toLowerCase() === name.toLowerCase()) { continue; }
      const w = m[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean);
      if ((w[w.length - 1] ?? '').toLowerCase() === last) { return m[2].replace(/\binz\([^)]*\)\s*/i, '').trim(); }
    }
  }
  const n = name.toLowerCase();
  if (/^(is|has|can|should)[A-Z_]/.test(name) || /(found|flag|ok|error|err|eof|valid|exists|done|first|last)$/.test(n)) { return 'ind'; }
  if (/(timestamp|tmstmp|^ts|ts)$/.test(n)) { return 'timestamp'; }
  if (/(date|dte|dat)$/.test(n)) { return 'date'; }
  if (/(time|tim)$/.test(n)) { return 'time'; }
  if (/(ptr|pointer)$/.test(n) || /^p_/.test(n)) { return 'pointer'; }
  if (/^(i|j|k|n|x|y)$/.test(n) || /(count|cnt|idx|index|num|nbr|no|qty|quantity|len|length|pos|size|rrn|line|row|rows|step|year|month|day|days)$/.test(n)) { return 'int(10)'; }
  if (/(amount|amt|price|total|tot|sum|balance|bal|rate|cost|value|val|percent|pct|tax|vat|discount)$/.test(n)) { return 'packed(11:2)'; }
  if (/(json|xml|html|body|payload|buffer|buf|clob)$/.test(n)) { return 'varchar(32000)'; }
  if (/(sql|stmt|statement|cmd|command|query|where|url|path)$/.test(n)) { return 'varchar(3000)'; }
  if (/(name|nam|desc|description|text|txt|msg|message|comment|email|mail|address|addr|city|title|label|reason)$/.test(n)) { return 'varchar(50)'; }
  if (/(id|code|cd|key|lib|library|file|member|mbr|pgm|program|user|usr|job|object|obj|type|status|sts|flag)$/.test(n)) { return 'char(10)'; }
  return 'char(10)';
}

const CTL_OPT = "dftactgrp(*no) actgrp(*new) option(*srcstmt: *nodebugio);";

function codeOf(lines: string[], fullyFree: boolean): string[] {
  return lines.map(l => (isFixedLine(l, fullyFree) ? '' : maskLine(l, fullyFree)));
}

/** The last file used by a file operation before `line` (for %FOUND, %EOF, %EQUAL). */
function lastFile(code: string[], line: number, ops: string[]): string | undefined {
  const keyed = ops.filter(o => /^(chain|setll|setgt|reade|readpe|delete)$/.test(o));
  const plain = ops.filter(o => !keyed.includes(o));
  // CHAIN key FILE / CHAIN (k1: k2) FILE [ds];   READ FILE [ds];
  const withKey = keyed.length ? new RegExp(`^\\s*(?:${keyed.join('|')})(?:\\(\\w+\\))?\\s+(?:\\([^)]*\\)|${id}|\\*\\w+)\\s+(${id})\\s*(?:${id}\\s*)?;`, 'i') : undefined;
  const noKey = plain.length ? new RegExp(`^\\s*(?:${plain.join('|')})(?:\\(\\w+\\))?\\s+(${id})\\s*(?:${id}\\s*)?;`, 'i') : undefined;
  for (let i = line; i >= Math.max(0, line - 200); i--) {
    const c = code[i] ?? '';
    const m = withKey?.exec(c) ?? noKey?.exec(c);
    if (m) { return m[1]; }
    if (/^\s*(dcl-proc|end-proc)\b/i.test(c)) { break; }
  }
  return undefined;
}

/** The statement that ends on the line before the cursor, joined from its first line (free form). */
function previousStatement(code: string[], line: number): { start: number; end: number; text: string } | undefined {
  let end = line - 1;
  while (end >= 0 && !code[end].trim()) { end--; }
  if (end < 0 || !code[end].includes(';')) { return undefined; }
  let start = end;
  while (start > 0 && code[start - 1].trim() && !code[start - 1].includes(';') && !/^\s*(\*\*|\/)/.test(code[start - 1]) && end - start < 30) { start--; }
  return { start, end, text: code.slice(start, end + 1).join(' ').replace(/\s+/g, ' ').trim() };
}

function nextCode(code: string[], line: number): string {
  for (let i = line + 1; i < code.length; i++) { if (code[i].trim()) { return code[i].trim(); } }
  return '';
}

function suggestRpg(ctx: SuggestContext, before: string): string | undefined {
  const { lines, line } = ctx;
  const fullyFree = isFullyFreeSource(lines.join('\n'));
  if (isFixedLine(lines[line] ?? '', fullyFree) && (lines[line] ?? '').trim()) { return undefined; }
  if (/\/\//.test(before.replace(/'[^']*'/g, '')) || (before.match(/'/g) ?? []).length % 2) { return undefined; } // in a comment or a literal
  const code = codeOf(lines, fullyFree);
  const sp = (s: string) => (/\s$/.test(before) || !before.trim() ? s : ` ${s}`);

  // ---- on an empty line: the statement that usually comes next
  if (!before.trim()) {
    const prev = previousStatement(code, line);
    const next = nextCode(code, line).toUpperCase();
    if (!prev) {
      // Right after **FREE, in a program with no CTL-OPT yet.
      if (line > 0 && /^\s*\*\*free\s*$/i.test(lines[line - 1]) && !code.some(c => /^\s*ctl-opt\b/i.test(c))) { return `ctl-opt ${CTL_OPT}`; }
      return undefined;
    }
    const p = prev.text; const P = p.toUpperCase();
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^CHAIN(?:\\(\\w+\\))?\\s+(?:\\([^)]*\\)|${id})\\s+(${id})\\s*(?:${id}\\s*)?;`, 'i').exec(p)) && !/%FOUND/.test(next)) { return `if %found(${m[1]});`; }
    if ((m = new RegExp(`^SETLL\\s+(\\([^)]*\\)|${id}|\\*START|\\*LOVAL)\\s+(${id})\\s*;`, 'i').exec(p)) && !/^READ/.test(next)) {
      return /^\*(START|LOVAL)$/i.test(m[1]) ? `read ${m[2]};` : `reade ${m[1]} ${m[2]};`;
    }
    if ((m = new RegExp(`^EXEC SQL DECLARE (${id}) (?:\\w+ )*?CURSOR\\b`, 'i').exec(P)) && !/^EXEC SQL OPEN/.test(next)) { return `exec sql open ${m[1].toLowerCase()};`; }
    if ((m = new RegExp(`^EXEC SQL OPEN (${id})\\s*;`, 'i').exec(P)) && !/FETCH/.test(next)) { return `exec sql fetch next from ${m[1].toLowerCase()} into :`; }
    if (/^EXEC SQL FETCH\b/.test(P) && !/SQLCODE|SQLSTATE|SQLSTT|SQLCOD/.test(next)) { return 'if sqlcode <> 0;'; }
    if (/^EXEC SQL (SELECT\b.*\bINTO\b|INSERT|UPDATE|DELETE|MERGE|CALL|VALUES\b.*\bINTO\b)/.test(P) && !/SQLCODE|SQLSTATE|SQLSTT|SQLCOD/.test(next)) { return 'if sqlcode < 0;'; }
    if ((m = new RegExp(`^DCL-PROC (${id})\\b`, 'i').exec(P)) && !/^DCL-PI\b/.test(next)) { return 'dcl-pi *n;'; }
    if (/^MONITOR\s*;/.test(P) || /^ON-ERROR\b/.test(P)) { return undefined; }
    return undefined;
  }

  // ---- completing the current line
  const t = before;
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^\\s*dcl-s\\s+(${id})\\s+$`, 'i').exec(t))) { return `${typeForName(m[1], lines.slice(0, line))};`; }
  if ((m = new RegExp(`^\\s*dcl-c\\s+(${id})\\s+$`, 'i').exec(t))) { return /^(max|min)/i.test(m[1]) || /(size|len|count|max|min)$/i.test(m[1]) ? '100;' : "'';"; }
  if (/^\s*ctl-opt\s*$/i.test(t)) { return sp(CTL_OPT); }
  if (new RegExp(`^\\s*dcl-f\\s+${id}\\s+$`, 'i').test(t)) { return 'usage(*input) keyed;'; }
  if (new RegExp(`^\\s*dcl-ds\\s+${id}\\s+$`, 'i').test(t)) { return 'qualified;'; }
  if (/^\s*\*inlr\s*$/i.test(t)) { return sp('= *on;'); }
  if (/^\s*snd-msg\s+$/i.test(t)) { return "*info 'text';"; }
  if (/^\s*on-error\s*$/i.test(t)) { return ';'; }
  if ((m = /%(found|eof|equal)(\(?)$/i.exec(t))) {
    const ops = m[1].toLowerCase() === 'eof' ? ['read', 'readp', 'reade', 'readpe', 'readc'] : m[1].toLowerCase() === 'equal' ? ['setll'] : ['chain', 'setll', 'delete', 'reade', 'readpe'];
    const f = lastFile(code, line - 1, ops) ?? lastFile(code, line, ops);
    if (f) { return `${m[2] ? '' : '('}${f})`; }
    return undefined;
  }
  // The parameters of a known procedure: calc( → custNo: amount)
  if ((m = new RegExp(`(?:^|[^\\w$#@%.-])(${id})\\($`).exec(t)) && ctx.signatures) {
    const ps = ctx.signatures.get(m[1].toUpperCase());
    if (ps) { return `${ps.join(': ')})${/^\s*(callp\s+)?[\w$#@]+\($/i.test(t) ? ';' : ''}`; }
  }
  return undefined;
}

// ---------------------------------------------------------------- CL

/** The MONMSG usually written after a command, with the message it ignores. */
export const CL_MONMSG: Record<string, [string, string]> = {
  CHKOBJ: ['CPF9801', 'object not found'], DLTF: ['CPF2105', 'file not found'], DLTPGM: ['CPF2105', 'program not found'], DLTOBJ: ['CPF2105', 'object not found'],
  DLTDTAARA: ['CPF2105', 'data area not found'], DLTDTAQ: ['CPF2105', 'data queue not found'], DLTSPLF: ['CPF3303', 'spooled file not found'],
  CRTLIB: ['CPF2111', 'library already exists'], CRTDTAARA: ['CPF1023', 'data area already exists'], CRTDUPOBJ: ['CPF2130', 'object not copied'],
  ADDLIBLE: ['CPF2103', 'library already in the list'], RMVLIBLE: ['CPF2104', 'library not in the list'], DLTOVR: ['CPF9841', 'no override'],
  CLRPFM: ['CPF3142', 'file not found'], CPYF: ['CPF2817', 'copy failed'], ALCOBJ: ['CPF1002', 'object not allocated'], DLCOBJ: ['CPF1005', 'object not deallocated'],
  RMVM: ['CPF3220', 'member not found'], ADDPFM: ['CPF5812', 'member already exists'], CRTPF: ['CPF5813', 'file already exists'], RNMOBJ: ['CPF2105', 'object not found'],
  ENDJOB: ['CPF1321', 'job not found'], SBMJOB: ['CPF1338', 'job not submitted'], RTVMBRD: ['CPF9815', 'member not found'], RTVOBJD: ['CPF9811', 'object not found'],
  OVRDBF: ['CPF0000', 'override failed'], STRCMTCTL: ['CPF8351', 'commitment control already started'], ENDCMTCTL: ['CPF8356', 'commitment control not started'],
};

function suggestCl(ctx: SuggestContext, before: string): string | undefined {
  const { lines, line } = ctx;
  // A CL statement may continue with + or - at the end: take the whole previous command.
  const stmt = (end: number) => {
    let s = end; while (s > 0 && /[+-]\s*$/.test(lines[s - 1].replace(/\/\*.*?\*\//g, ''))) { s--; }
    return lines.slice(s, end + 1).map(l => l.replace(/\/\*.*?\*\//g, '').replace(/[+-]\s*$/, '')).join(' ').replace(/\s+/g, ' ').trim();
  };
  if (!before.trim()) {
    let end = line - 1; while (end >= 0 && !lines[end].trim()) { end--; }
    if (end < 0 || /[+-]\s*$/.test(lines[end])) { return undefined; }
    const prev = stmt(end).replace(/^[A-Z_][A-Z0-9_]*:\s*/i, '');
    const cmd = (/^([A-Z][A-Z0-9]*)/i.exec(prev)?.[1] ?? '').toUpperCase();
    const next = (lines.slice(line + 1).find(l => l.trim()) ?? '').trim().toUpperCase();
    if (CL_MONMSG[cmd] && !/^MONMSG\b/.test(next)) { const [msg, why] = CL_MONMSG[cmd]; return `MONMSG     MSGID(${msg}) /* ${why} */`; }
    // PGM PARM(&A &B): declare the first parameter not declared yet.
    const text = lines.join('\n').toUpperCase();
    const pgm = /^\s*PGM\s+PARM\(([^)]*)\)/im.exec(text);
    if (pgm) {
      const parms = pgm[1].split(/\s+/).filter(p => p.startsWith('&'));
      const missing = parms.find(p => !new RegExp(`DCL\\s+(VAR\\()?${p.replace(/[&$#@]/g, '\\$&')}\\b`).test(text));
      if (missing && (cmd === 'PGM' || cmd === 'DCL')) { return `DCL        VAR(${missing}) TYPE(*CHAR) LEN(10)`; }
    }
    return undefined;
  }
  let m: RegExpExecArray | null;
  if ((m = /^\s*DCL\s+(?:VAR\()?(&[\w$#@]+)\)?\s+$/i.exec(before))) {
    const n = m[1].toUpperCase();
    if (/(COUNT|CNT|NBR|NUM|QTY|LEN|POS|RTN|RC)$/.test(n)) { return 'TYPE(*DEC) LEN(5 0)'; }
    if (/(FLAG|FOUND|OK|ERR|ERROR|EOF)$/.test(n)) { return 'TYPE(*LGL)'; }
    if (/(MSG|MSGDTA|TEXT|CMD|COMMAND)$/.test(n)) { return 'TYPE(*CHAR) LEN(256)'; }
    if (/(DATE)$/.test(n)) { return 'TYPE(*CHAR) LEN(8)'; }
    return 'TYPE(*CHAR) LEN(10)';
  }
  if (/^\s*MONMSG\s+$/i.test(before)) { return 'MSGID(CPF0000)'; }
  return undefined;
}

// ---------------------------------------------------------------- AI suggestions: what the model answered → ghost text

/** The text to show from a model answer: no fences, no prose, no repeat of what is already typed, at most `maxLines`. */
export function cleanCompletion(answer: string, before: string, after: string[] = [], maxLines = 6): string | undefined {
  let t = answer.replace(/\r/g, '');
  const fence = /```[\w-]*[^\n]*\n([\s\S]*?)(```|$)/.exec(t);
  if (fence) { t = fence[1]; }
  t = t.replace(/<\/?CURSOR>|⟨CURSOR⟩/g, '');
  if (/^\s*(here|sure|this|the following|i |i'm|certainly)\b/i.test(t)) { return undefined; }
  // The model often repeats the start of the line.
  const typed = before.trimStart();
  if (typed && t.trimStart().toLowerCase().startsWith(typed.toLowerCase())) { t = t.trimStart().slice(typed.length); }
  else if (typed && !/\s$/.test(before)) { t = t.replace(/^\n+/, ''); }
  let lines = t.split('\n');
  // Stop before lines that already follow the cursor (the model rewrote the rest of the source).
  const next = after.map(l => l.trim()).filter(Boolean)[0];
  if (next) { const k = lines.findIndex((l, i) => i > 0 && l.trim() === next); if (k > 0) { lines = lines.slice(0, k); } }
  lines = lines.slice(0, maxLines);
  while (lines.length && !lines[lines.length - 1].trim()) { lines.pop(); }
  const out = lines.join('\n').replace(/\s+$/, '');
  return out.trim() ? out : undefined;
}
