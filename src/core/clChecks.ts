// Checks for CL sources while you type: variables used but not declared or declared but never used, GOTO to a label
// that does not exist, DO / SELECT / SUBR blocks that are not closed, DCL after the first command, literals longer than
// the variable, text that cannot go into a *DEC variable and hard-coded library names. Pure, unit tested; a check that
// cannot be sure says nothing (a DCLF brings variables the source does not show).
import { clParam, clStatements, ClStatement } from './clLanguage';

export type ClRule = 'cl-undeclared-variable' | 'cl-unused-variable' | 'cl-undefined-label' | 'cl-unbalanced-block' | 'cl-dcl-after-command' | 'cl-value-too-long' | 'cl-text-in-decimal' | 'cl-hardcoded-library';

export const CL_RULES: Record<ClRule, string> = {
  'cl-undeclared-variable': 'CL variables used but not declared (DCL)',
  'cl-unused-variable': 'CL variables declared but never used',
  'cl-undefined-label': 'GOTO to a label that is not in the program',
  'cl-unbalanced-block': 'DO / DOWHILE / DOUNTIL / DOFOR / SELECT / SUBR without its END (or an END too many)',
  'cl-dcl-after-command': 'DCL, DCLF or COPYRIGHT after the first command (they must come first)',
  'cl-value-too-long': 'A literal longer than the *CHAR variable it is put in (it is cut)',
  'cl-text-in-decimal': 'Text that is not a number put in a *DEC or *INT variable',
  'cl-hardcoded-library': 'A library name written in a command (use the library list)',
};

export interface ClFinding { rule: ClRule; severity: 'error' | 'warning' | 'info' | 'hint'; line: number; start: number; end: number; message: string }
export interface ClVar { name: string; type: string; len: number; line: number }

const SYSTEM_LIBS = /^(QSYS|QSYS2|QTEMP|QGPL|QUSRSYS|SYSIBM|SYSTOOLS|\*LIBL|\*CURLIB|\*ALL|\*ALLUSR|\*USRLIBL)$/;
const DECLARATIONS = /^(PGM|DCL|DCLF|COPYRIGHT|DCLPRCOPT|INCLUDE)$/;

/** Text with quoted literals blanked (same length), so names inside strings are not seen as variables. */
function unquote(s: string): string { return s.replace(/'(?:[^']|'')*'/g, m => `'${' '.repeat(Math.max(0, m.length - 2))}'`); }

/** Declared variables with their type and length (default lengths as the CL compiler uses them). */
export function clVariables(stmts: ClStatement[]): ClVar[] {
  const out: ClVar[] = [];
  for (const s of stmts.filter(x => x.command === 'DCL')) {
    const words = unquote(s.text).replace(/^DCL\s+/i, '').split(/\s+/);
    const name = (clParam(s.text, 'VAR') ?? words[0] ?? '').toUpperCase();
    if (!name.startsWith('&')) { continue; }
    const type = (clParam(s.text, 'TYPE') ?? words.find(w => /^\*(CHAR|DEC|LGL|INT|UINT|PTR)$/i.test(w)) ?? '*CHAR').toUpperCase();
    const lenTxt = clParam(s.text, 'LEN') ?? /^\(?(\d+)/.exec(words[2] ?? '')?.[1];
    const len = lenTxt ? parseInt(lenTxt, 10) : type === '*CHAR' ? 32 : type === '*DEC' ? 15 : type === '*LGL' ? 1 : 4;
    out.push({ name, type, len, line: s.line });
  }
  return out;
}

/** Where a word starts on the source lines of a statement (for the squiggle), else the statement start. */
function locate(lines: string[], s: ClStatement, word: string): { line: number; start: number; end: number } {
  for (let l = s.line; l <= s.endLine; l++) {
    const c = (lines[l] ?? '').toUpperCase().indexOf(word.toUpperCase());
    if (c >= 0) { return { line: l, start: c, end: c + word.length }; }
  }
  const t = lines[s.line] ?? '';
  return { line: s.line, start: Math.max(0, t.search(/\S/)), end: Math.max(1, t.trimEnd().length) };
}

export function clLint(source: string, enabled: (r: ClRule) => boolean = () => true): ClFinding[] {
  const out: ClFinding[] = [];
  const lines = source.split(/\r?\n/);
  const stmts = clStatements(source);
  const push = (rule: ClRule, severity: ClFinding['severity'], s: ClStatement, word: string, message: string) => {
    if (enabled(rule)) { out.push({ rule, severity, ...locate(lines, s, word), message }); }
  };
  const safe = (fn: () => void) => { try { fn(); } catch { /* one check never stops the others */ } };
  const vars = clVariables(stmts);
  const declared = new Map(vars.map(v => [v.name, v]));
  const hasDclf = stmts.some(s => s.command === 'DCLF');
  const hasInclude = stmts.some(s => s.command === 'INCLUDE');

  // ---- variables
  safe(() => {
    const used = new Set<string>();
    for (const s of stmts) {
      const names = [...unquote(s.text).toUpperCase().matchAll(/&[A-Z$#@][\w$#@]*/g)].map(m => m[0]);
      const own = s.command === 'DCL' ? (clParam(s.text, 'VAR') ?? unquote(s.text).replace(/^DCL\s+/i, '').split(/\s+/)[0] ?? '').toUpperCase() : '';
      for (const n of names) {
        if (n !== own) { used.add(n); }
        if (!declared.has(n) && !hasDclf && !hasInclude && s.command !== 'DCL') { push('cl-undeclared-variable', 'error', s, n, `${n} is not declared: add DCL VAR(${n}) TYPE(…) at the start of the program.`); }
      }
    }
    for (const v of vars) {
      if (!used.has(v.name)) { const s = stmts.find(x => x.line === v.line)!; push('cl-unused-variable', 'hint', s, v.name, `${v.name} is declared but never used.`); }
    }
  });

  // ---- labels
  safe(() => {
    const labels = new Set(stmts.filter(s => s.label).map(s => s.label!));
    for (const s of stmts.filter(x => x.command === 'GOTO' || /\bGOTO\b/i.test(x.text))) {
      for (const m of unquote(s.text).matchAll(/\bGOTO\s+(?:CMDLBL\()?\s*([A-Z$#@][\w$#@]*)\s*\)?/gi)) {
        const l = m[1].toUpperCase();
        if (l === 'CMDLBL') { continue; }
        if (!labels.has(l)) { push('cl-undefined-label', 'error', s, m[1], `There is no label ${l}: in this program.`); }
      }
    }
  });

  // ---- blocks
  safe(() => {
    const stack: { kind: 'DO' | 'SELECT' | 'SUBR'; s: ClStatement; word: string }[] = [];
    for (const s of stmts) {
      const t = unquote(s.text).toUpperCase();
      const opens: { kind: 'DO' | 'SELECT' | 'SUBR'; word: string }[] = [];
      if (/^(DO|DOWHILE|DOUNTIL|DOFOR)$/.test(s.command)) { opens.push({ kind: 'DO', word: s.command }); }
      else if (s.command === 'SELECT') { opens.push({ kind: 'SELECT', word: 'SELECT' }); }
      else if (s.command === 'SUBR') { opens.push({ kind: 'SUBR', word: 'SUBR' }); }
      else if (/\b(THEN|ELSE|EXEC)\s*\(\s*(DO|DOWHILE|DOUNTIL|DOFOR)\b/.test(t) || (s.command === 'ELSE' && /^ELSE\s+(CMD\(\s*)?DO\b/.test(t))) { opens.push({ kind: 'DO', word: 'DO' }); }
      for (const o of opens) { stack.push({ ...o, s }); }
      const close = s.command === 'ENDDO' ? 'DO' : s.command === 'ENDSELECT' ? 'SELECT' : s.command === 'ENDSUBR' ? 'SUBR' : undefined;
      if (close) {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== close) { push('cl-unbalanced-block', 'error', s, s.command, `${s.command} has no matching ${close === 'DO' ? 'DO' : close}.`); }
        else { stack.pop(); }
      }
    }
    for (const o of stack) { push('cl-unbalanced-block', 'error', o.s, o.word, `This ${o.word} is not closed (END${o.kind === 'DO' ? 'DO' : o.kind}).`); }
  });

  // ---- declarations after the first command
  safe(() => {
    let firstCommand = false;
    for (const s of stmts) {
      if (DECLARATIONS.test(s.command)) {
        if (firstCommand && s.command !== 'PGM') { push('cl-dcl-after-command', 'error', s, s.command, `${s.command} must come before the first command of the program.`); }
        continue;
      }
      if (s.command && s.command !== 'MONMSG') { firstCommand = true; }
    }
  });

  // ---- literals that do not fit
  safe(() => {
    for (const s of stmts) {
      let target: string | undefined; let value: string | undefined;
      if (s.command === 'CHGVAR') {
        const words = s.text.replace(/^CHGVAR\s+/i, '');
        target = (clParam(s.text, 'VAR') ?? /^(&[\w$#@]+)/.exec(words)?.[1])?.toUpperCase();
        value = clParam(s.text, 'VALUE') ?? /^&[\w$#@]+\s+(.+)$/.exec(words)?.[1]?.trim();
      } else if (s.command === 'DCL') {
        target = (clParam(s.text, 'VAR') ?? '').toUpperCase() || undefined;
        value = clParam(s.text, 'VALUE');
      }
      const v = target ? declared.get(target) : undefined;
      if (!v || value === undefined) { continue; }
      const lit = /^'((?:[^']|'')*)'$/.exec(value.trim());
      if (!lit) { continue; }
      const text = lit[1].replace(/''/g, "'");
      if (v.type === '*CHAR' && text.length > v.len) { push('cl-value-too-long', 'warning', s, `'`, `${text.length} characters do not fit in ${v.name} (LEN ${v.len}): the end is cut.`); }
      if ((v.type === '*DEC' || v.type === '*INT' || v.type === '*UINT') && !/^\s*[-+]?\d*([.,]\d+)?\s*$/.test(text)) { push('cl-text-in-decimal', 'error', s, `'`, `'${text}' is not a number: putting it in ${v.name} (${v.type}) ends the program with MCH1202.`); }
    }
  });

  // ---- hard-coded libraries
  safe(() => {
    for (const s of stmts) {
      if (/^(CRTLIB|DLTLIB|CHGCURLIB|ADDLIBLE|RMVLIBLE|CHGLIBL|SAVLIB|RSTLIB|CLRLIB|DSPLIB|WRKLIB|CPYLIB)$/.test(s.command)) { continue; }
      for (const m of unquote(s.text).matchAll(/\(\s*([A-Z$#@][\w$#@]{0,9})\/([A-Z$#@*][\w$#@]*)/gi)) {
        if (SYSTEM_LIBS.test(m[1].toUpperCase())) { continue; }
        push('cl-hardcoded-library', 'info', s, `${m[1]}/`, `Library ${m[1].toUpperCase()} is written in the command: use *LIBL (or a variable) so the program runs in test and production.`);
      }
    }
  });

  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** The DCL to add for an undeclared variable, with a type from its name. */
export function clDeclaration(name: string): string {
  const n = name.toUpperCase();
  const type = /(COUNT|CNT|NBR|NUM|QTY|LEN|POS|RTN|RC)$/.test(n) ? 'TYPE(*DEC) LEN(5 0)' : /(FLAG|FOUND|OK|ERR|ERROR|EOF)$/.test(n) ? 'TYPE(*LGL)'
    : /(MSG|MSGDTA|TEXT|CMD|COMMAND)$/.test(n) ? 'TYPE(*CHAR) LEN(256)' : /(DATE)$/.test(n) ? 'TYPE(*CHAR) LEN(8)' : 'TYPE(*CHAR) LEN(10)';
  return `             DCL        VAR(${n}) ${type}`;
}

/** The line after the last declaration (where a new DCL goes). */
export function clDeclarationLine(source: string): number {
  let at = 0;
  for (const s of clStatements(source)) {
    if (DECLARATIONS.test(s.command)) { at = s.endLine + 1; continue; }
    if (s.command && s.command !== 'MONMSG') { break; }
  }
  return at;
}
