// Editor helpers for IBM i sources (pure, unit tested): CL formatted the SEU / prompter way, links that open a member
// at a line from a ticket or a chat, IBM i references found in terminal output, the indentation of an END line typed
// in free-form RPG, and the names that change together (DCL-PROC / END-PROC, DCL-DS / END-DS).
import { clStatements } from './clLanguage';

// ---------------------------------------------------------------- CL formatting

/** One CL statement laid out like the prompter: label in column 1, command in column 14, parameters from column 25, + continuations before column 80. */
export function formatClStatement(label: string | undefined, text: string, width = 80): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(\S+)\s*(.*)$/.exec(t);
  if (!m) { return [t]; }
  const cmd = m[1]; const rest = m[2];
  const head = (label ? `${label}:`.padEnd(13) : ' '.repeat(13)) + (cmd.length < 10 ? cmd.padEnd(10) : cmd) + ' ';
  // Parameters split at the top level (outside quotes and parentheses).
  const parms: string[] = []; let cur = ''; let depth = 0; let inS = false;
  for (const c of rest) {
    if (c === "'") { inS = !inS; }
    if (!inS) { if (c === '(') { depth++; } else if (c === ')') { depth--; } else if (c === ' ' && depth === 0) { if (cur) { parms.push(cur); cur = ''; } continue; } }
    cur += c;
  }
  if (cur) { parms.push(cur); }
  const lines: string[] = []; let line = head.trimEnd().length >= 23 ? head : head.padEnd(24);
  let first = true;
  for (const p of parms) {
    const sep = first ? '' : ' ';
    if (!first && line.length + sep.length + p.length + 2 > width) { lines.push(line + ' +'); line = ' '.repeat(24) + p; }
    else { line += sep + p; }
    first = false;
  }
  lines.push(line.trimEnd());
  return lines;
}

/** A whole CL source laid out the prompter way; comments and blank lines are kept where they are. */
export function formatCl(text: string, width = 80): string {
  const src = text.split(/\r?\n/);
  const stmts = clStatements(text);
  const out: string[] = []; let i = 0;
  for (const s of stmts) {
    while (i < s.line) { out.push(src[i].trimEnd()); i++; }
    const raw = src.slice(s.line, s.endLine + 1).join('\n');
    // Statements with a comment inside are left as they are (moving it could change its meaning for the reader).
    if (/\/\*/.test(raw.replace(/'(?:[^']|'')*'/g, '')) || !s.command) { out.push(...src.slice(s.line, s.endLine + 1).map(l => l.trimEnd())); }
    else { out.push(...formatClStatement(s.label, s.text, width)); }
    i = s.endLine + 1;
  }
  while (i < src.length) { out.push(src[i].trimEnd()); i++; }
  return out.join('\n');
}

// ---------------------------------------------------------------- deep links

export const LINK_BASE = 'vscode://gauravgupta0612.vanthrex-ibmi/open';

/** A link that opens a member (or an IFS file) at a line in Vanthrex, for tickets, chats and e-mails. */
export function memberLink(p: { system?: string; library?: string; file?: string; member?: string; type?: string; path?: string; line?: number }): string {
  const q = new URLSearchParams();
  if (p.system) { q.set('system', p.system); }
  if (p.path) { q.set('ifs', p.path); } else { q.set('member', `${p.library}/${p.file}/${p.member}`.toUpperCase()); if (p.type) { q.set('type', p.type.toLowerCase()); } }
  if (p.line) { q.set('line', String(p.line)); }
  return `${LINK_BASE}?${q.toString()}`;
}

export interface LinkTarget { system?: string; library?: string; file?: string; member?: string; type?: string; path?: string; line?: number }

/** Reads the query of a link (open?member=LIB/FILE/MBR&type=rpgle&line=42); throws on anything else. */
export function parseLink(query: string): LinkTarget {
  const q = new URLSearchParams(query);
  const line = Number(q.get('line') ?? '') || undefined;
  const system = q.get('system') ?? undefined;
  const ifs = q.get('ifs');
  if (ifs) {
    if (!ifs.startsWith('/') || /\.\.|[\0]/.test(ifs)) { throw new Error('Not a valid IFS path in the link.'); }
    return { system, path: ifs, line };
  }
  const m = /^([A-Z$#@][\w$#@.]{0,9})\/([A-Z$#@][\w$#@.]{0,9})\/([A-Z$#@][\w$#@.]{0,9})$/i.exec(q.get('member') ?? '');
  if (!m) { throw new Error('The link does not name a member as LIBRARY/FILE/MEMBER.'); }
  const type = (q.get('type') ?? '').toLowerCase();
  if (type && !/^[a-z0-9]{1,10}$/.test(type)) { throw new Error('Not a valid member type in the link.'); }
  return { system, library: m[1].toUpperCase(), file: m[2].toUpperCase(), member: m[3].toUpperCase(), type: type || undefined, line };
}

// ---------------------------------------------------------------- terminal references

export interface TerminalRef { start: number; length: number; kind: 'member' | 'object' | 'message' | 'ifs'; text: string; library?: string; file?: string; member?: string }

/** IBM i references in a line of terminal or log output: LIB/FILE(MEMBER), LIB/OBJECT, message IDs and IFS paths. */
export function terminalRefs(line: string): TerminalRef[] {
  const out: TerminalRef[] = [];
  const taken = (s: number, e: number) => out.some(r => s < r.start + r.length && e > r.start);
  for (const m of line.matchAll(/\b([A-Z$#@][A-Z0-9_$#@.]{0,9})\/([A-Z$#@][A-Z0-9_$#@.]{0,9})\(([A-Z$#@][A-Z0-9_$#@.]{0,9})\)/g)) {
    out.push({ start: m.index!, length: m[0].length, kind: 'member', text: m[0], library: m[1], file: m[2], member: m[3] });
  }
  for (const m of line.matchAll(/\b(CPF|CPD|CPA|CPI|CPC|MCH|RNQ|RNX|RNF|SQL|CEE|TCP|LNC|CZM|PWS|CAE|KBD|SEU)[0-9A-F]{4}\b/g)) {
    if (!taken(m.index!, m.index! + m[0].length)) { out.push({ start: m.index!, length: m[0].length, kind: 'message', text: m[0] }); }
  }
  for (const m of line.matchAll(/(^|[\s'"(=])(\/(?:home|QOpenSys|QSYS\.LIB|tmp|www|QIBM|QDLS|QNTC)\/[^\s'"()]+)/g)) {
    const s = m.index! + m[1].length;
    if (!taken(s, s + m[2].length)) { out.push({ start: s, length: m[2].length, kind: 'ifs', text: m[2].replace(/[.,;:]+$/, '') }); }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- RPG indentation while typing

const OPENERS = /^(IF|DOW|DOU|FOR|FOR-EACH|SELECT|MONITOR|BEGSR|DCL-PROC|DCL-DS|DCL-PI|DCL-PR|DCL-ENUM)$/;
const CLOSERS: Record<string, RegExp> = {
  ENDIF: /^IF$/, ELSE: /^IF$/, ELSEIF: /^IF$/, ENDDO: /^(DOW|DOU)$/, ENDFOR: /^(FOR|FOR-EACH)$/, ENDSL: /^SELECT$/, WHEN: /^SELECT$/, 'WHEN-IS': /^SELECT$/, 'WHEN-IN': /^SELECT$/, OTHER: /^SELECT$/,
  ENDMON: /^MONITOR$/, 'ON-ERROR': /^MONITOR$/, 'ON-EXIT': /^DCL-PROC$/, ENDSR: /^BEGSR$/, 'END-PROC': /^DCL-PROC$/, 'END-DS': /^DCL-DS$/, 'END-PI': /^DCL-PI$/, 'END-PR': /^DCL-PR$/, 'END-ENUM': /^DCL-ENUM$/,
};

/** The indentation an END / ELSE / WHEN line should have: the indentation of its opener (WHEN one step in). Undefined when unsure. */
export function indentForCloser(lines: string[], line: number, step = 2): string | undefined {
  const kw = (/^\s*([A-Za-z][A-Za-z-]*)/.exec(lines[line] ?? '')?.[1] ?? '').toUpperCase();
  const want = CLOSERS[kw]; if (!want) { return undefined; }
  const isEnd = (k: string) => /^(ENDIF|ENDDO|ENDFOR|ENDSL|ENDMON|ENDSR|END-PROC|END-DS|END-PI|END-PR|END-ENUM)$/.test(k);
  let depth = 0;
  for (let i = line - 1; i >= 0; i--) {
    const code = (lines[i] ?? '').replace(/'(?:[^']|'')*'/g, "''").replace(/\/\/.*$/, '');
    const k = (/^\s*([A-Za-z][A-Za-z-]*)/.exec(code)?.[1] ?? '').toUpperCase();
    if (!k) { continue; }
    if (isEnd(k)) { depth++; continue; }
    if (!OPENERS.test(k)) { continue; }
    // DCL-DS … LIKEDS and one-line DCL-PR … END-PR open no block.
    if (/^DCL-(DS|PI|PR|ENUM)$/.test(k) && /\bEND-(DS|PI|PR|ENUM)\b|\bLIKE(DS|REC)\s*\(/i.test(code)) { continue; }
    if (depth > 0) { depth--; continue; }
    if (!want.test(k)) { return undefined; }
    const base = /^\s*/.exec(lines[i])![0];
    return /^(WHEN|WHEN-IS|WHEN-IN|OTHER)$/.test(kw) ? base + ' '.repeat(step) : base;
  }
  return undefined;
}

// ---------------------------------------------------------------- linked editing

/** DCL-PROC name ↔ END-PROC name and DCL-DS name ↔ END-DS name: the two ranges to edit together, or undefined. */
export function linkedNames(lines: string[], line: number, character: number): { line: number; start: number; end: number }[] | undefined {
  const open = /^(\s*dcl-(proc|ds)\s+)([A-Za-z_$#@][\w$#@]*)/i; const close = /^(\s*end-(proc|ds)\s+)([A-Za-z_$#@][\w$#@]*)/i;
  const nameOf = (i: number, re: RegExp) => { const m = re.exec(lines[i] ?? ''); return m ? { kind: m[2].toLowerCase(), start: m[1].length, end: m[1].length + m[3].length } : undefined; };
  const o = nameOf(line, open); const c = nameOf(line, close);
  if (o && character >= o.start && character <= o.end) {
    let depth = 0;
    for (let i = line + 1; i < lines.length; i++) {
      if (new RegExp(`^\\s*dcl-${o.kind}\\b`, 'i').test(lines[i]) && !(o.kind === 'ds' && /\b(likeds|likerec|end-ds)\b/i.test(lines[i]))) { depth++; continue; }
      const e = nameOf(i, close); const bare = new RegExp(`^\\s*end-${o.kind}\\b`, 'i').test(lines[i]);
      if (bare) { if (depth > 0) { depth--; continue; } return e && e.kind === o.kind ? [{ line, start: o.start, end: o.end }, { line: i, start: e.start, end: e.end }] : undefined; }
    }
    return undefined;
  }
  if (c && character >= c.start && character <= c.end) {
    let depth = 0;
    for (let i = line - 1; i >= 0; i--) {
      if (new RegExp(`^\\s*end-${c.kind}\\b`, 'i').test(lines[i])) { depth++; continue; }
      const s = nameOf(i, open);
      if (s && s.kind === c.kind && !(c.kind === 'ds' && /\b(likeds|likerec|end-ds)\b/i.test(lines[i]))) { if (depth > 0) { depth--; continue; } return [{ line: i, start: s.start, end: s.end }, { line, start: c.start, end: c.end }]; }
    }
  }
  return undefined;
}
