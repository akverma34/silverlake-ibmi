// Code checks that catch errors the compiler would report late, or runtime traps it never reports: prototypes that no
// longer match their procedure interface, calls with the wrong number of arguments, CONST parameters that are changed,
// loops that never end, LEAVE / ITER outside a loop and hard-coded library names. Pure (no vscode import), unit tested,
// and tolerant: a check that cannot understand a statement says nothing rather than guessing.
import { isFixedLine, isFullyFreeSource, maskLine, parseRpg } from './parser';
import type { LintFinding, LintSeverity } from './lint';

export type SafetyRule = 'prototype-mismatch' | 'call-argument-count' | 'assign-to-const' | 'infinite-loop' | 'leave-outside-loop' | 'hardcoded-library';

export const SAFETY_RULES: Record<SafetyRule, string> = {
  'prototype-mismatch': 'A DCL-PR whose parameters or return value do not match the DCL-PI of the same procedure',
  'call-argument-count': 'A call with fewer arguments than the required parameters, or more than the procedure has',
  'assign-to-const': 'A CONST parameter that is changed (the compile fails with RNF5346)',
  'infinite-loop': 'DOW / DOU loops on a constant condition with no LEAVE or RETURN inside',
  'leave-outside-loop': 'LEAVE or ITER outside a DOW, DOU or FOR loop',
  'hardcoded-library': 'A library name written in EXTFILE / EXTDESC / EXTNAME or in embedded SQL (use the library list)',
};

export interface SafetyOptions { enabled?: (rule: SafetyRule) => boolean }

/** System libraries that are fine to name (catalogs, services, QTEMP). */
const SYSTEM_LIBS = /^(QSYS2?|SYSIBM\w*|SYSTOOLS|SYSPROC|SYSFUN|QTEMP|QGPL|QUSRSYS|QSYS2|\*LIBL|\*CURLIB)$/;

export interface Parm { name: string; detail: string; line: number }
export interface Interface { name: string; kind: 'PR' | 'PI'; line: number; end: number; returns: string; parms: Parm[]; keywords: string }

/** DCL-PR and DCL-PI blocks of a free-form source, with their parameters. */
export function interfaces(text: string): Interface[] {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const out: Interface[] = [];
  let proc: string | undefined;
  let cur: Interface | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (isFixedLine(lines[i], fullyFree)) { cur = undefined; continue; }
    const code = maskLine(lines[i], fullyFree).trim();
    if (!code) { continue; }
    let m: RegExpExecArray | null;
    if ((m = /^dcl-proc\s+([A-Za-z_$#@][\w$#@]*)/i.exec(code))) { proc = m[1]; continue; }
    if (/^end-proc\b/i.test(code)) { proc = undefined; continue; }
    if ((m = /^dcl-(pr|pi)\s+(\*n|[A-Za-z_$#@][\w$#@]*)\s*([^;]*);?/i.exec(code))) {
      const name = m[2].toUpperCase() === '*N' ? proc : m[2];
      if (!name) { cur = undefined; continue; }
      const rest = m[3].replace(/\bend-p[ri]\b/i, '').trim();
      // The return type is what comes before the keywords (EXTPGM, EXTPROC, OPDESC, RTNPARM…).
      const kwAt = rest.search(/\b(extpgm|extproc|opdesc|rtnparm|overload|pgminfo)\b/i);
      const returns = (kwAt < 0 ? rest : rest.slice(0, kwAt)).trim();
      const it: Interface = { name, kind: m[1].toUpperCase() as 'PR' | 'PI', line: i, end: i, returns, parms: [], keywords: kwAt < 0 ? '' : rest.slice(kwAt) };
      out.push(it);
      cur = /\bend-p[ri]\b/i.test(code) ? undefined : it;
      continue;
    }
    if (cur) {
      if (/^end-p[ri]\b/i.test(code)) { cur.end = i; cur = undefined; continue; }
      const p = /^(?:dcl-parm\s+)?([A-Za-z_$#@][\w$#@]*)\s*([^;]*)/i.exec(code);
      if (p) { cur.parms.push({ name: p[1], detail: p[2].trim(), line: i }); cur.end = i; }
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/options\([^)]*\)/g, (o) => o.split(':').sort().join(':'));
const requiredCount = (ps: Parm[]) => { let n = 0; for (const p of ps) { if (/\*nopass\b/i.test(p.detail)) { break; } n++; } return n; };

/** The arguments of a call: s[open] is "(". Splits on ":" at the top level; undefined when the parentheses do not close. */
export function callArguments(s: string, open: number): { args: string[]; end: number } | undefined {
  let depth = 0; let cur = ''; const args: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '(') { depth++; if (depth === 1) { continue; } }
    else if (c === ')') { depth--; if (depth === 0) { if (cur.trim() || args.length) { args.push(cur.trim()); } return { args, end: i }; } }
    else if (c === ':' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
    if (depth >= 1) { cur += c; }
  }
  return undefined;
}

export function safetyLint(text: string, opts: SafetyOptions = {}): LintFinding[] {
  const on = (r: SafetyRule) => opts.enabled?.(r) ?? true;
  const out: LintFinding[] = [];
  const push = (rule: SafetyRule, severity: LintSeverity, line: number, start: number, end: number, message: string) => {
    if (on(rule)) { out.push({ rule, severity, line, start: Math.max(0, start), end: Math.max(end, start + 1), message }); }
  };
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const fixed = lines.map(l => isFixedLine(l, fullyFree));
  const masked = lines.map((l, i) => (fixed[i] ? '' : maskLine(l, fullyFree)));
  const U = (i: number) => masked[i].toUpperCase();
  const kwOf = (i: number) => /^\s*([A-Z][A-Z0-9-]*)/.exec(U(i))?.[1] ?? '';
  const col = (i: number, word: string) => Math.max(0, U(i).indexOf(word.toUpperCase()));
  const safe = (fn: () => void) => { try { fn(); } catch { /* one check never stops the others */ } };
  const ifs = interfaces(text);

  // ---- prototype against procedure interface
  if (on('prototype-mismatch')) safe(() => {
    for (const pr of ifs.filter(x => x.kind === 'PR')) {
      const pi = ifs.find(x => x.kind === 'PI' && x.name.toUpperCase() === pr.name.toUpperCase());
      if (!pi || /\bextpgm\b/i.test(pr.keywords)) { continue; }
      const c = col(pr.line, pr.name);
      if (pr.parms.length !== pi.parms.length) {
        push('prototype-mismatch', 'error', pr.line, c, c + pr.name.length, `The prototype of ${pr.name} has ${pr.parms.length} parameter(s) but the procedure interface (line ${pi.line + 1}) has ${pi.parms.length}.`);
        continue;
      }
      if (norm(pr.returns) !== norm(pi.returns)) {
        push('prototype-mismatch', 'error', pr.line, c, c + pr.name.length, `The prototype of ${pr.name} returns "${pr.returns || 'nothing'}" but the procedure interface returns "${pi.returns || 'nothing'}".`);
        continue;
      }
      pr.parms.forEach((p, k) => {
        if (norm(p.detail) !== norm(pi.parms[k].detail)) {
          const pc = col(p.line, p.name);
          push('prototype-mismatch', 'error', p.line, pc, pc + p.name.length, `Parameter ${k + 1} is "${p.detail}" here but "${pi.parms[k].detail}" in the procedure interface (line ${pi.parms[k].line + 1}).`);
        }
      });
    }
  });

  // ---- statements (free form), joined up to their ";"
  const statements: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!masked[i].trim()) { continue; }
    let s = masked[i]; const start = i;
    while (!s.includes(';') && i + 1 < lines.length && i - start < 30 && masked[i + 1] !== undefined && !fixed[i + 1]) { i++; s += ' ' + masked[i]; }
    statements.push({ line: start, text: s });
  }

  // ---- calls with the wrong number of arguments
  if (on('call-argument-count')) safe(() => {
    const sigs = new Map<string, Interface>();
    for (const x of ifs) { if (!sigs.has(x.name.toUpperCase()) || x.kind === 'PR') { sigs.set(x.name.toUpperCase(), x); } }
    if (!sigs.size) { return; }
    const re = /(^|[^\w$#@%.-])([A-Za-z_$#@][\w$#@]*)\s*\(/g;
    for (const st of statements) {
      if (/^\s*(dcl-[\w-]+|end-[\w-]+|begsr|exec\s+sql)\b/i.test(st.text)) { continue; }
      for (const m of st.text.matchAll(re)) {
        const sig = sigs.get(m[2].toUpperCase());
        if (!sig || /\boptions\(\s*\*varsize/i.test(sig.keywords)) { continue; }
        const open = m.index! + m[0].length - 1;
        const call = callArguments(st.text, open);
        if (!call) { continue; }
        const n = call.args.length; const req = requiredCount(sig.parms); const max = sig.parms.length;
        if (n < req || n > max) {
          const c = col(st.line, m[2]);
          const want = req === max ? `${max}` : `${req} to ${max}`;
          push('call-argument-count', 'error', st.line, c, c + m[2].length, `${sig.name} expects ${want} argument(s) but gets ${n}.`);
        }
      }
    }
  });

  // ---- CONST parameters that are changed
  if (on('assign-to-const')) safe(() => {
    const parse = parseRpg(text);
    for (const p of parse.procedures) {
      const pi = ifs.find(x => x.kind === 'PI' && x.line >= p.start && x.line <= p.end);
      if (!pi) { continue; }
      for (const prm of pi.parms.filter(x => /\bconst\b/i.test(x.detail))) {
        const N = prm.name.toUpperCase().replace(/[$#@]/g, '\\$&');
        const re = new RegExp(`^\\s*(?:EVAL(?:R|-CORR)?\\s+)?${N}\\s*(\\([^;]*\\)|\\.[\\w$#@.]+)?\\s*[-+*/]?=(?!=)|^\\s*(CLEAR|RESET)\\s+${N}\\b`);
        for (let i = pi.end + 1; i <= p.end && i < lines.length; i++) {
          if (re.test(U(i))) { const c = col(i, prm.name); push('assign-to-const', 'error', i, c, c + prm.name.length, `${prm.name} is a CONST parameter: it cannot be changed (copy it into a local variable first).`); }
        }
      }
    }
  });

  // ---- loops: constant conditions and LEAVE / ITER outside a loop
  const anyFixedCalc = lines.some((l, i) => fixed[i] && /^.{5}[Cc]/.test(l) && l[6] !== '*');
  safe(() => {
    let loops = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!masked[i].trim()) { continue; }
      const kw = kwOf(i);
      if (kw === 'DCL-PROC' || kw === 'BEGSR' || kw === 'END-PROC' || kw === 'ENDSR') { loops = 0; continue; }
      if (/^(DOW|DOU|FOR|FOR-EACH)$/.test(kw)) {
        loops++;
        const cond = U(i).replace(/^\s*DO[UW]\s*/, '').replace(/;.*$/, '').trim();
        const always = kw === 'DOW' ? /^(1\s*=\s*1|\*ON|'1'|\*ON\s*=\s*\*ON|NOT\s+\*OFF|\*TRUE)$/ : /^(1\s*=\s*0|0\s*=\s*1|\*OFF|'0'|NOT\s+\*ON)$/;
        if ((kw === 'DOW' || kw === 'DOU') && always.test(cond) && on('infinite-loop')) {
          // Find the matching ENDDO; the loop ends only with a LEAVE at its own level, a RETURN, LEAVESR or *INLR + RETURN.
          let depth = 0; let exits = false;
          for (let j = i; j < lines.length; j++) {
            const k = kwOf(j);
            if (/^(DOW|DOU|FOR|FOR-EACH)$/.test(k)) { depth++; }
            else if (/^(ENDDO|ENDFOR)$/.test(k)) { depth--; if (depth === 0) { break; } }
            else if (/^(RETURN|LEAVESR)$/.test(k) || (k === 'LEAVE' && depth === 1) || /\bEXSR\s+\*PSSR\b/.test(U(j)) || /^(SND-MSG)\b/.test(k) && /\*ESCAPE/.test(U(j))) { exits = true; break; }
          }
          if (!exits) { const c = U(i).search(/\S/); push('infinite-loop', 'warning', i, c, c + kw.length, `This ${kw} never ends: its condition is always ${kw === 'DOW' ? 'true' : 'false'} and nothing inside leaves the loop.`); }
        }
        continue;
      }
      if (/^(ENDDO|ENDFOR)$/.test(kw)) { loops = Math.max(0, loops - 1); continue; }
      if ((kw === 'LEAVE' || kw === 'ITER') && loops === 0 && !anyFixedCalc) {
        const c = U(i).search(/\S/); push('leave-outside-loop', 'error', i, c, c + kw.length, `${kw} is not inside a DOW, DOU or FOR loop.`);
      }
    }
  });

  // ---- hard-coded library names
  if (on('hardcoded-library')) safe(() => {
    for (let i = 0; i < lines.length; i++) {
      if (!masked[i].trim()) { continue; }
      const u = U(i);
      if (/\bEXT(FILE|DESC|NAME)\s*\(/.test(u)) {
        for (const m of lines[i].matchAll(/\bext(?:file|desc|name)\s*\(\s*'([^'/]+)\/[^']*'/gi)) {
          if (!SYSTEM_LIBS.test(m[1].toUpperCase())) { const c = m.index!; push('hardcoded-library', 'info', i, c, c + m[0].length, `Library ${m[1].toUpperCase()} is written in the source: the program then ignores the library list (test and production use the same file).`); }
        }
      }
    }
    for (const st of statements.filter(s => /^\s*EXEC\s+SQL\b/i.test(s.text))) {
      const u = st.text.toUpperCase();
      for (const m of u.matchAll(/\b(FROM|JOIN|INTO|UPDATE|TABLE|USING)\s+([A-Z_$#@][\w$#@]*)\s*[./]\s*([A-Z_$#@][\w$#@]*)/g)) {
        if (SYSTEM_LIBS.test(m[2])) { continue; }
        const c = col(st.line, 'EXEC');
        push('hardcoded-library', 'info', st.line, c, c + 8, `Library ${m[2]} is written in the SQL statement (${m[2]}.${m[3]}): use the library list (SQL naming *SYS, or SET SCHEMA) so the same program runs in test and production.`);
        break;
      }
    }
  });

  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}
