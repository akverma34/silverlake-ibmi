// Checks on how variables are used, from their declared type: %SUBST beyond the length of a field, array indexes
// beyond DIM, numeric literals too big for the field, numbers compared with *BLANKS, text assigned to a number, SQL
// host variables never declared and EXSR of a subroutine that does not exist. Pure (no vscode import), unit tested.
// Every check stays silent when it cannot be sure (a /COPY, an externally described structure, an unknown type).
import { isFixedLine, isFullyFreeSource, maskLine, parseRpg, RpgDefinition } from './parser';
import type { LintFinding, LintSeverity } from './lint';

export type DataRule = 'substring-out-of-range' | 'index-out-of-range' | 'literal-overflow' | 'blank-compare-numeric' | 'char-to-numeric' | 'undeclared-host-variable' | 'undefined-subroutine';

export const DATA_RULES: Record<DataRule, string> = {
  'substring-out-of-range': '%SUBST with a start or length beyond the declared length of the field',
  'index-out-of-range': 'An array index (a number) lower than 1 or higher than DIM',
  'literal-overflow': 'A numeric literal with more integer digits than the field can hold',
  'blank-compare-numeric': 'A numeric field compared with *BLANKS or a blank literal',
  'char-to-numeric': 'A text literal assigned to a numeric field',
  'undeclared-host-variable': 'An SQL host variable (:name) that is not declared in the source',
  'undefined-subroutine': 'EXSR of a subroutine that is not in the source',
};

export interface DataOptions { enabled?: (rule: DataRule) => boolean }

export interface FieldType { kind: 'char' | 'varchar' | 'graph' | 'packed' | 'zoned' | 'binary' | 'int' | 'uns' | 'float' | 'ind' | 'date' | 'time' | 'timestamp' | 'pointer' | 'other'; length?: number; scale?: number; dim?: number }

/** The type of a declaration from its detail: free form (char(10), packed(7:2) dim(5)) or fixed form (10A, 7P 2, 5 0). */
export function fieldType(detail: string): FieldType | undefined {
  const d = detail.trim();
  const dim = /\bdim\(\s*(\d+)\s*\)/i.exec(d)?.[1];
  const t: FieldType = { kind: 'other' };
  let m: RegExpExecArray | null;
  if ((m = /^(char|varchar|graph|vargraph|ucs2|varucs2)\(\s*(\d+)/i.exec(d))) { t.kind = /^var/i.test(m[1]) ? 'varchar' : /graph|ucs2/i.test(m[1]) ? 'graph' : 'char'; t.length = +m[2]; }
  else if ((m = /^(packed|zoned|bindec)\(\s*(\d+)\s*(?::\s*(\d+))?\s*\)/i.exec(d))) { t.kind = m[1].toLowerCase() === 'bindec' ? 'binary' : m[1].toLowerCase() as 'packed' | 'zoned'; t.length = +m[2]; t.scale = +(m[3] ?? 0); }
  else if ((m = /^(int|uns)\(\s*(\d+)\s*\)/i.exec(d))) { t.kind = m[1].toLowerCase() as 'int' | 'uns'; t.length = +m[2]; }
  else if (/^float\(/i.test(d)) { t.kind = 'float'; }
  else if (/^ind\b/i.test(d)) { t.kind = 'ind'; }
  else if (/^date\b/i.test(d)) { t.kind = 'date'; }
  else if (/^time\b/i.test(d)) { t.kind = 'time'; }
  else if (/^timestamp\b/i.test(d)) { t.kind = 'timestamp'; }
  else if (/^pointer\b/i.test(d)) { t.kind = 'pointer'; }
  // Fixed form: length, type letter, decimals.
  else if ((m = /^(\d+)\s*([APSBIUFNDTZG*])?\s*(\d+)?(?:\s|$)/i.exec(d))) {
    const len = +m[1]; const letter = (m[2] ?? '').toUpperCase(); const dec = m[3];
    const map: Record<string, FieldType['kind']> = { A: 'char', P: 'packed', S: 'zoned', B: 'binary', I: 'int', U: 'uns', F: 'float', N: 'ind', D: 'date', T: 'time', Z: 'timestamp', G: 'graph', '*': 'pointer' };
    t.kind = letter ? map[letter] : dec !== undefined ? 'packed' : 'char';
    if (/char|packed|zoned|binary|graph/.test(t.kind)) { t.length = len; }
    if (dec !== undefined && /packed|zoned|binary/.test(t.kind)) { t.scale = +dec; }
    if (/int|uns/.test(t.kind)) { t.length = len <= 3 ? 3 : len <= 5 ? 5 : len <= 10 ? 10 : 20; }
  } else { return dim ? { kind: 'other', dim: +dim } : undefined; }
  if (dim) { t.dim = +dim; }
  return t;
}

export const isNumeric = (t: FieldType) => /^(packed|zoned|binary|int|uns|float)$/.test(t.kind);

/** The largest integer part a numeric type holds, or undefined (float). */
function maxInteger(t: FieldType): number | undefined {
  if (t.kind === 'int') { return { 3: 127, 5: 32767, 10: 2147483647, 20: 9223372036854775807 }[t.length ?? 10]; }
  if (t.kind === 'uns') { return { 3: 255, 5: 65535, 10: 4294967295, 20: 18446744073709551615 }[t.length ?? 10]; }
  if (/packed|zoned|binary/.test(t.kind) && t.length !== undefined) { return 10 ** (t.length - (t.scale ?? 0)) - 1; }
  return undefined;
}

const ID = '[A-Za-z_$#@][\\w$#@]*';

export function dataLint(text: string, opts: DataOptions = {}): LintFinding[] {
  const on = (r: DataRule) => opts.enabled?.(r) ?? true;
  const out: LintFinding[] = [];
  const push = (rule: DataRule, severity: LintSeverity, line: number, start: number, end: number, message: string) => {
    if (on(rule)) { out.push({ rule, severity, line, start: Math.max(0, start), end: Math.max(end, start + 1), message }); }
  };
  const safe = (fn: () => void) => { try { fn(); } catch { /* one check never stops the others */ } };
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const fixed = lines.map(l => isFixedLine(l, fullyFree));
  const masked = lines.map((l, i) => (fixed[i] ? '' : maskLine(l, fullyFree)));
  const parse = parseRpg(text);
  const hasCopies = parse.copies.length > 0;
  const external = /\b(extname|likerec)\s*\(/i.test(text) || parse.definitions.some(d => d.kind === 'file');

  // Name → declaration, the procedure's own first, then the global ones (qualified subfields excluded).
  const qualified = new Set(parse.definitions.filter(d => d.kind === 'ds' && /\bqualified\b/i.test(d.detail)).map(d => d.upper));
  const procAt = (line: number) => parse.procedures.find(p => line >= p.start && line <= p.end)?.name;
  const lookup = (name: string, line: number): RpgDefinition | undefined => {
    const u = name.toUpperCase(); const proc = procAt(line);
    const cands = parse.definitions.filter(d => d.upper === u && ['variable', 'subfield', 'parameter', 'constant'].includes(d.kind) && !(d.kind === 'subfield' && d.parent && qualified.has(d.parent.toUpperCase())));
    return cands.find(d => d.procedure && d.procedure === proc) ?? cands.find(d => !d.procedure);
  };
  const typeAt = (name: string, line: number) => { const d = lookup(name, line); return d && d.kind !== 'constant' ? fieldType(d.detail) : undefined; };

  for (let i = 0; i < lines.length; i++) {
    const code = masked[i];
    if (!code.trim() || /^\s*(dcl-|end-|\/)/i.test(code)) { continue; }
    const raw = lines[i];

    safe(() => {
      // Assignments of a literal: NAME = 'text';  NAME = 123.45;
      const a = new RegExp(`^\\s*(?:eval\\s+)?(${ID})\\s*=\\s*(.+?)\\s*;`, 'i').exec(raw.replace(/\/\/.*$/, ''));
      if (!a) { return; }
      const t = typeAt(a[1], i); if (!t || t.dim) { return; }
      const rhs = a[2].trim();
      const at = raw.indexOf(a[1]);
      if (isNumeric(t) && /^'(?:[^']|'')*'$/.test(rhs)) { push('char-to-numeric', 'error', i, at, at + a[1].length, `${a[1]} is numeric (${t.kind}): a text literal cannot be assigned to it (use %DEC or %INT to convert).`); }
      const num = /^[-+]?(\d+)(?:[.,]\d+)?$/.exec(rhs);
      const max = maxInteger(t);
      if (num && max !== undefined && Number(num[1]) > max) { push('literal-overflow', 'warning', i, at, at + a[1].length, `${num[1]} does not fit in ${a[1]} (at most ${max}): the program ends with a numeric overflow.`); }
    });

    safe(() => {
      // Numeric field compared with blanks.
      for (const m of code.matchAll(new RegExp(`\\b(${ID})\\s*(=|<>)\\s*(\\*blanks?\\b)`, 'gi'))) {
        const t = typeAt(m[1], i);
        if (t && isNumeric(t) && !t.dim) { const c = m.index! + m[0].length - m[3].length; push('blank-compare-numeric', 'error', i, c, c + m[3].length, `${m[1]} is numeric: compare it with 0 (or *ZEROS), not *BLANKS.`); }
      }
    });

    safe(() => {
      // %SUBST(field: start: length) beyond the field.
      for (const m of code.matchAll(new RegExp(`%subst\\(\\s*(${ID})\\s*:\\s*(\\d+)\\s*(?::\\s*(\\d+)\\s*)?\\)`, 'gi'))) {
        const t = typeAt(m[1], i);
        if (!t || !/^(char|varchar)$/.test(t.kind) || !t.length) { continue; }
        const start = +m[2]; const len = m[3] !== undefined ? +m[3] : 1;
        if (start < 1 || start > t.length || start + len - 1 > t.length) {
          push('substring-out-of-range', 'error', i, m.index!, m.index! + m[0].length, `${m[1]} holds ${t.length} characters: %SUBST from ${start}${m[3] !== undefined ? ` for ${len}` : ''} goes beyond it (error RNX0100 at run time).`);
        }
      }
    });

    safe(() => {
      // arr(5) with a literal index beyond DIM.
      for (const m of code.matchAll(new RegExp(`(^|[^\\w$#@%.])(${ID})\\(\\s*(-?\\d+)\\s*\\)`, 'g'))) {
        const d = lookup(m[2], i); const t = d ? fieldType(d.detail) : undefined;
        if (!t?.dim) { continue; }
        const n = +m[3];
        if (n < 1 || n > t.dim) { const c = m.index! + m[1].length; push('index-out-of-range', 'error', i, c, c + m[0].length - m[1].length, `${m[2]} has ${t.dim} elements: index ${n} is outside 1-${t.dim} (error RNX0121 at run time).`); }
      }
    });
  }

  // SQL host variables never declared.
  if (on('undeclared-host-variable') && !hasCopies && !external) safe(() => {
    const known = new Set(parse.definitions.map(d => d.upper));
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*exec\s+sql\b/i.test(masked[i])) { continue; }
      let s = ''; let j = i;
      for (; j < lines.length && j < i + 40; j++) { s += masked[j] + '\n'; if (masked[j].includes(';')) { break; } }
      if (/^\s*exec\s+sql\s+(declare\s+\w+\s+(?:\w+\s+)*?cursor\s+for\s+)?(set\s+option|include|whenever)\b/i.test(s)) { i = j; continue; }
      const st = s.split('\n');
      for (let k = 0; k < st.length; k++) {
        for (const m of st[k].matchAll(new RegExp(`(^|[^:\\w])\\s*:\\s*(${ID})`, 'g'))) {
          const name = m[2];
          if (known.has(name.toUpperCase()) || /^(SQLCODE|SQLSTATE|SQLSTT|SQLCOD|SQLCA|SQLERRMC|SQLER\d)$/i.test(name)) { continue; }
          const c = st[k].indexOf(':' + name) >= 0 ? st[k].indexOf(':' + name) : st[k].indexOf(name);
          push('undeclared-host-variable', 'error', i + k, c, c + name.length + 1, `:${name} is not declared in this source (DCL-S, DCL-DS or a parameter).`);
        }
      }
      i = j;
    }
  });

  // EXSR of a subroutine that is not defined.
  if (on('undefined-subroutine') && !hasCopies) safe(() => {
    const subs = new Set(parse.definitions.filter(d => d.kind === 'subroutine').map(d => d.upper));
    for (let i = 0; i < lines.length; i++) {
      let name: string | undefined; let col = 0;
      if (fixed[i]) {
        if (/^.{5}[Cc]/.test(lines[i]) && lines[i][6] !== '*' && lines[i].substring(25, 35).trim().toUpperCase() === 'EXSR') { name = lines[i].substring(35, 49).trim(); col = 35; }
      } else {
        const m = new RegExp(`^(\\s*exsr\\s+)(\\*?${ID})`, 'i').exec(masked[i]);
        if (m) { name = m[2]; col = m[1].length; }
      }
      if (name && !subs.has(name.toUpperCase())) { push('undefined-subroutine', 'error', i, col, col + name.length, `Subroutine ${name} is not in this source (no BEGSR ${name}).`); }
    }
  });

  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}
