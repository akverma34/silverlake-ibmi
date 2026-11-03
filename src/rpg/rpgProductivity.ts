// Everyday RPG helpers (pure, unit tested): more code checks, block tools (close a block, IF → SELECT, surround with),
// declaration tools (sort, align), comment and case tools, long-line wrapping, SEU ruler, change markers, procedure
// headers, call snippets and inlay-hint positions.
import { isFixedLine, isFullyFreeSource, maskLine, parseRpg, findOccurrences } from './parser';
import type { LintFinding, LintSeverity } from './lint';
import { BIFS, OPCODES } from './docs';

export type DailyRule =
  | 'deprecated-opcode' | 'missing-ctl-opt' | 'chain-without-found' | 'unchecked-sql' | 'dsply' | 'deep-nesting'
  | 'literal-too-long' | 'unreachable-code' | 'duplicate-declaration' | 'empty-block' | 'select-without-other'
  | 'missing-const' | 'unused-parameter' | 'code-past-column-80' | 'missing-return' | 'unused-procedure'
  | 'long-parameter-list' | 'cursor-not-closed' | 'commented-out-code';

export const DAILY_RULES: Record<DailyRule, string> = {
  'deprecated-opcode': 'Old fixed-format operation codes (MOVE, Z-ADD, ADD, CAT, SCAN…) that have a free-form equivalent',
  'missing-ctl-opt': 'Free-form program without CTL-OPT (activation group, options)',
  'chain-without-found': 'CHAIN not followed by a %FOUND test',
  'unchecked-sql': 'Embedded SQL whose SQLCODE / SQLSTATE is never tested',
  'dsply': 'DSPLY left in the code',
  'deep-nesting': 'Blocks nested deeper than the configured level',
  'literal-too-long': 'A literal longer than the character field it is assigned to (it is cut)',
  'unreachable-code': 'Statements after RETURN, LEAVE or ITER that never run',
  'duplicate-declaration': 'A name declared twice in the same scope',
  'empty-block': 'IF / DOW / FOR / MONITOR blocks with nothing inside',
  'select-without-other': 'SELECT without OTHER',
  'missing-const': 'Input parameters that could be CONST',
  'unused-parameter': 'Procedure parameters that are never used',
  'code-past-column-80': 'Code after column 80 in a column-limited source (ignored by the compiler)',
  'missing-return': 'Procedures that return a value but have no RETURN with a value',
  'unused-procedure': 'Procedures that are neither exported nor called',
  'long-parameter-list': 'Procedures with more than 8 parameters',
  'cursor-not-closed': 'SQL cursors that are opened but never closed',
  'commented-out-code': 'Large blocks of commented-out code',
};

export interface DailyOptions { enabled?: (rule: DailyRule) => boolean; maxNesting?: number; isInclude?: boolean }

const DEPRECATED: Record<string, string> = {
  MOVE: 'an assignment or %SUBST / %CHAR / %DEC', MOVEL: 'an assignment or %SUBST', MOVEA: '%SUBARR or a loop', 'Z-ADD': 'x = value', 'Z-SUB': 'x = -value',
  ADD: 'x += value', SUB: 'x -= value', MULT: 'x *= value', DIV: 'x = a / b (and %REM)', MVR: '%REM', CAT: 'the + operator with %TRIM', SCAN: '%SCAN', CHECK: '%CHECK',
  CHECKR: '%CHECKR', XLATE: '%XLATE', SUBST: '%SUBST', XFOOT: '%XFOOT', SETON: '*INxx = *ON', SETOFF: '*INxx = *OFF', COMP: 'IF', TIME: '%TIMESTAMP()',
  CASEQ: 'SELECT / WHEN', CASNE: 'SELECT / WHEN', CASGT: 'SELECT / WHEN', CASLT: 'SELECT / WHEN', CASGE: 'SELECT / WHEN', CASLE: 'SELECT / WHEN', CAS: 'SELECT / WHEN',
  DO: 'FOR', GOTO: 'LEAVE / ITER', CABEQ: 'IF … LEAVE', CABNE: 'IF … LEAVE', CABGT: 'IF … LEAVE', CABLT: 'IF … LEAVE', CABGE: 'IF … LEAVE', CABLE: 'IF … LEAVE',
  EXTRCT: '%SUBDT', ADDDUR: 'date + %DAYS()', SUBDUR: '%DIFF', DEFINE: 'DCL-S LIKE', KLIST: 'a key list in parentheses: CHAIN (k1: k2)', PLIST: 'DCL-PI / DCL-PR', PARM: 'DCL-PI / DCL-PR',
};

const FOR_OPEN: Record<string, string> = { IF: 'endif', DOW: 'enddo', DOU: 'enddo', FOR: 'endfor', 'FOR-EACH': 'endfor', SELECT: 'endsl', MONITOR: 'endmon', BEGSR: 'endsr', 'DCL-PROC': 'end-proc', 'DCL-DS': 'end-ds', 'DCL-PI': 'end-pi', 'DCL-PR': 'end-pr' };

/** The code of each line: comments and literals masked, fixed-format calc lines reduced to their operation. */
function codeLines(text: string): { lines: string[]; masked: string[]; fixed: boolean[]; fullyFree: boolean } {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const fixed = lines.map(l => isFixedLine(l, fullyFree));
  const masked = lines.map((l, i) => {
    if (fixed[i]) { return ''; }
    const m = maskLine(l, fullyFree);
    return fullyFree ? m : m.slice(0, 80);
  });
  return { lines, masked, fixed, fullyFree };
}

/** A free-form statement starting on a line, joined up to its ";" (at most 12 lines). */
function statementAt(masked: string[], i: number): string {
  let s = '';
  for (let j = i; j < Math.min(masked.length, i + 12); j++) { s += ' ' + masked[j]; if (masked[j].includes(';')) { break; } }
  return s.trim();
}

const isCode = (s: string) => !!s.trim() && !/^\s*(\/\/|\*)/.test(s);

export function dailyLint(text: string, opts: DailyOptions = {}): LintFinding[] {
  const on = (r: DailyRule) => opts.enabled?.(r) ?? true;
  const out: LintFinding[] = [];
  const push = (rule: DailyRule, severity: LintSeverity, line: number, start: number, end: number, message: string) => {
    if (on(rule)) { out.push({ rule, severity, line, start, end: Math.max(end, start + 1), message }); }
  };
  const { lines, masked, fixed, fullyFree } = codeLines(text);
  const parse = parseRpg(text);
  const U = (i: number) => masked[i].toUpperCase();

  // ---- fixed-format calculation specs
  for (let i = 0; i < lines.length; i++) {
    if (!fixed[i] || (lines[i][5] ?? '').toUpperCase() !== 'C' || lines[i][6] === '*') { continue; }
    const op = lines[i].substring(25, 35).trim().toUpperCase().replace(/\(.*$/, '');
    if (DEPRECATED[op]) { push('deprecated-opcode', 'info', i, 25, 35, `${op} is an old operation code; in free form use ${DEPRECATED[op]}.`); }
    if (op === 'DSPLY') { push('dsply', 'info', i, 25, 35, 'DSPLY left in the code: remove it, or use a message or a log, before going to production.'); }
    if (op === 'CHAIN' && !lines[i].substring(70, 76).trim()) {
      const next = lines.slice(i + 1, i + 5).join(' ').toUpperCase();
      if (!/%FOUND|%ERROR|%EOF/.test(next)) { push('chain-without-found', 'warning', i, 25, 35, 'CHAIN without a %FOUND test (or a resulting indicator): the code goes on as if the record was found.'); }
    }
  }

  // ---- free-form statements
  let depth = 0; let reported = false;
  const stack: { kw: string; line: number; hasOther: boolean; body: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const u = U(i);
    if (!u.trim()) { continue; }
    const kw = (/^\s*([A-Z][A-Z0-9-]*)/.exec(u)?.[1] ?? '');
    const top = stack[stack.length - 1];
    if (top && !/^(ENDIF|ENDDO|ENDFOR|ENDSL|ENDMON|ENDSR|END-PROC|END)$/.test(kw)) { top.body++; }
    if (/^(IF|DOW|DOU|FOR|FOR-EACH|SELECT|MONITOR)$/.test(kw)) {
      stack.push({ kw, line: i, hasOther: false, body: 0 });
      depth++;
      const max = opts.maxNesting ?? 6;
      if (depth > max && !reported) { reported = true; push('deep-nesting', 'info', i, u.search(/\S/), u.search(/\S/) + kw.length, `Blocks nested ${depth} deep (more than ${max}): move the inner part into a procedure.`); }
    } else if (/^(ELSE|ELSEIF|WHEN|WHEN-IS|WHEN-IN|ON-ERROR|ON-EXIT)$/.test(kw)) {
      if (top && top.body === 0 && kw !== 'WHEN' && !/^(SELECT)$/.test(top.kw)) { push('empty-block', 'info', top.line, U(top.line).search(/\S/), U(top.line).search(/\S/) + top.kw.length, `Empty ${top.kw} block.`); }
      if (top) { top.body = 0; if (/^(ELSE|ELSEIF)$/.test(kw)) { top.body = 1; } }
    } else if (kw === 'OTHER') { if (top) { top.hasOther = true; } }
    else if (/^(ENDIF|ENDDO|ENDFOR|ENDSL|ENDMON|END)$/.test(kw) && top) {
      stack.pop(); depth = Math.max(0, depth - 1); if (depth < (opts.maxNesting ?? 6)) { reported = false; }
      if (top.kw === 'SELECT' && !top.hasOther) { push('select-without-other', 'info', top.line, U(top.line).search(/\S/), U(top.line).search(/\S/) + 6, 'SELECT without OTHER: a value no WHEN expects goes through silently.'); }
      else if (top.body === 0 && top.kw !== 'SELECT') { push('empty-block', 'info', top.line, U(top.line).search(/\S/), U(top.line).search(/\S/) + top.kw.length, `Empty ${top.kw} block.`); }
    }

    if (kw === 'DSPLY') { push('dsply', 'info', i, u.search(/DSPLY/), u.search(/DSPLY/) + 5, 'DSPLY left in the code: remove it, or use a message or a log, before going to production.'); }

    // CHAIN without %FOUND in the next statements.
    if (/^CHAIN(\(\w*\))?$/.test(kw)) {
      let seen = false; let n = 0;
      for (let j = i + 1; j < lines.length && n < 4; j++) { if (!masked[j].trim()) { continue; } n++; if (/%FOUND|%ERROR|%EOF/.test(U(j))) { seen = true; break; } }
      if (!seen) { const at = u.search(/CHAIN/); push('chain-without-found', 'warning', i, at, at + 5, 'CHAIN without a %FOUND test: the code goes on as if the record was found.'); }
    }

    // Unreachable code after RETURN / LEAVE / ITER.
    if (/^(RETURN|LEAVE|ITER|LEAVESR)$/.test(kw) && u.includes(';')) {
      let j = i + 1;
      while (j < lines.length && !masked[j].trim()) { j++; }
      if (j < lines.length) {
        const nk = (/^\s*([A-Z][A-Z0-9-]*)/.exec(U(j))?.[1] ?? '');
        if (nk && !/^(END\w*|END-PROC|ELSE|ELSEIF|WHEN|OTHER|ON-ERROR|ON-EXIT|BEGSR|DCL-PROC|ENDSR|WHEN-IS|WHEN-IN)$/.test(nk) && !/^\s*\//.test(lines[j]) && !/^\s*[A-Z0-9_$#@]+\s*:/.test(U(j))) {
          push('unreachable-code', 'warning', j, U(j).search(/\S/), U(j).trimEnd().length, `This statement never runs: it comes after ${kw}.`);
        }
      }
    }

    // Embedded SQL without a SQLCODE / SQLSTATE test.
    if (/^\s*EXEC\s+SQL\b/.test(u)) {
      const st = statementAt(masked, i).toUpperCase();
      if (/\b(SELECT\b[\s\S]*\bINTO|INSERT|UPDATE|DELETE|MERGE|FETCH|CALL)\b/.test(st) && !/\bDECLARE\b/.test(st)) {
        let end = i; while (end < lines.length && !masked[end].includes(';')) { end++; }
        let tested = false; let n = 0;
        for (let j = end + 1; j < lines.length && n < 4; j++) { if (!masked[j].trim()) { continue; } n++; if (/SQLCODE|SQLSTATE|SQLSTT|SQLCOD|SQLER|%ERROR|GET\s+DIAGNOSTICS/.test(U(j))) { tested = true; break; } }
        if (!tested && !/WHENEVER/.test(text.toUpperCase())) { const at = u.search(/EXEC/); push('unchecked-sql', 'info', i, at, at + 8, 'The result of this SQL statement is not tested: check SQLCODE (or SQLSTATE) after it.'); }
      }
    }

    // Literal longer than the field.
    const as = /^\s*([A-Za-z$#@_][\w$#@]*)\s*=\s*'((?:[^']|'')*)'\s*;/.exec(lines[i]);
    if (as) {
      const d = parse.definitions.find(x => x.upper === as[1].toUpperCase() && (x.kind === 'variable' || x.kind === 'subfield'));
      const len = d ? /^(?:var)?char\(\s*(\d+)\s*\)/i.exec(d.detail)?.[1] : undefined;
      const lit = as[2].replace(/''/g, "'");
      if (len && lit.length > Number(len)) { const at = lines[i].indexOf("'"); push('literal-too-long', 'warning', i, at, at + as[2].length + 2, `This literal has ${lit.length} characters but ${d!.name} holds ${len}: it is cut.`); }
    }

    // Column-limited source: code after column 80 is ignored.
    if (!fullyFree && !fixed[i] && lines[i].length > 80 && lines[i].slice(80).trim() && !/^\s*\/\//.test(lines[i].slice(7)) && !lines[i].slice(7, 80).includes('//')) {
      push('code-past-column-80', 'error', i, 80, lines[i].length, 'Text after column 80 is ignored by the compiler in a column-limited source: wrap the line, or add **FREE.');
    }
  }

  // ---- program-level checks
  const all = masked.join('\n').toUpperCase();
  if (fullyFree && !opts.isInclude && !/CTL-OPT/.test(all) && /^\s*(DCL-|[A-Z])/m.test(all) && parse.definitions.length) {
    push('missing-ctl-opt', 'info', 0, 0, Math.max(1, lines[0].length), 'No CTL-OPT: add one (for example DFTACTGRP(*NO) ACTGRP(*NEW) OPTION(*SRCSTMT: *NODEBUGIO)) so the program behaves the same everywhere.');
  }

  // Duplicate declarations in the same scope.
  const seen = new Map<string, number>();
  for (const d of parse.definitions) {
    if (!['variable', 'constant', 'ds', 'file', 'prototype', 'procedure', 'subroutine'].includes(d.kind)) { continue; }
    const k = `${d.procedure ?? ''}|${d.kind === 'procedure' || d.kind === 'prototype' ? 'P' : d.kind === 'subroutine' ? 'S' : 'V'}|${d.upper}`;
    if (seen.has(k)) { push('duplicate-declaration', 'error', d.line, d.column, d.column + d.name.length, `${d.name} is already declared on line ${seen.get(k)! + 1}.`); }
    else { seen.set(k, d.line); }
  }

  // Procedures: parameters, returns, calls.
  for (const p of parse.procedures) {
    const body = lines.slice(p.start, p.end + 1);
    const bodyText = body.join('\n');
    const params = parse.definitions.filter(d => d.kind === 'parameter' && d.procedure === p.name);
    if (params.length > 8) { const c = lines[p.start].toUpperCase().indexOf(p.name.toUpperCase()); push('long-parameter-list', 'info', p.start, Math.max(0, c), Math.max(0, c) + p.name.length, `${p.name} has ${params.length} parameters: group them in a data structure.`); }
    for (const prm of params) {
      const uses = findOccurrences(bodyText, prm.name).filter(o => o.line + p.start !== prm.line);
      if (!uses.length) { push('unused-parameter', 'hint', prm.line, prm.column, prm.column + prm.name.length, `Parameter ${prm.name} is never used.`); continue; }
      if (!/\b(const|value)\b/i.test(prm.detail) && !/\b(likeds|likerec|dim|pointer|options\(\s*\*varsize)/i.test(prm.detail)) {
        const N = prm.name.replace(/[$#@]/g, '\\$&');
        const written = new RegExp(`(^|;|\\b(?:eval|eval-corr)\\s+)\\s*${N}(\\(|\\.|\\s*[-+*/]?=)|\\b(read\\w*|chain|fetch|into|exfmt|callp|clear|reset)\\b[^;]*\\b${N}\\b|[(:]\\s*${N}\\s*[:)]`, 'im');
        const rest = body.filter((_, k) => k + p.start !== prm.line).join('\n');
        if (!written.test(rest)) { push('missing-const', 'info', prm.line, prm.column, prm.column + prm.name.length, `Parameter ${prm.name} is only read: add CONST so callers can pass expressions and literals.`); }
      }
    }
    const pi = body.map(l => maskLine(l, fullyFree)).join('\n');
    const ret = /dcl-pi\s+[\w$#@*]+\s+([a-z][\w-]*(\([^)]*\))?)/i.exec(pi);
    if (ret && !/^(end-pi|extpgm|extproc|opdesc)$/i.test(ret[1])) {
      if (!/\breturn\s+[^;\s]/i.test(pi)) { const c = lines[p.start].toUpperCase().indexOf(p.name.toUpperCase()); push('missing-return', 'warning', p.start, Math.max(0, c), Math.max(0, c) + p.name.length, `${p.name} returns ${ret[1]} but no RETURN gives a value.`); }
    }
    if (!/\bexport\b/i.test(maskLine(lines[p.start], fullyFree)) && !opts.isInclude && !/CTL-OPT[^;]*\bMAIN\s*\(\s*/.test(all.replace(new RegExp(`MAIN\\s*\\(\\s*${p.name.toUpperCase()}`), ''))) {
      const calls = findOccurrences(text, p.name).filter(o => o.line < p.start || o.line > p.end || o.line !== p.start).filter(o => !(o.line >= p.start && o.line <= p.start));
      const prototypes = parse.definitions.filter(d => d.kind === 'prototype' && d.upper === p.name.toUpperCase()).map(d => d.line);
      const real = calls.filter(o => !prototypes.includes(o.line) && !/^\s*end-proc\b/i.test(lines[o.line]));
      if (!real.length && !new RegExp(`main\\s*\\(\\s*${p.name}\\s*\\)`, 'i').test(text)) { const c = lines[p.start].toUpperCase().indexOf(p.name.toUpperCase()); push('unused-procedure', 'hint', p.start, Math.max(0, c), Math.max(0, c) + p.name.length, `Procedure ${p.name} is not exported and never called.`); }
    }
  }

  // Cursors opened but never closed.
  for (const m of all.matchAll(/\bDECLARE\s+([A-Z$#@_][\w$#@]*)\s+(?:\w+\s+)*?CURSOR\b/g)) {
    const c = m[1];
    if (new RegExp(`\\bOPEN\\s+${c}\\b`).test(all) && !new RegExp(`\\bCLOSE\\s+${c}\\b`).test(all)) {
      const line = all.slice(0, m.index).split('\n').length - 1;
      push('cursor-not-closed', 'warning', line, Math.max(0, U(line).indexOf(c)), Math.max(0, U(line).indexOf(c)) + c.length, `Cursor ${c} is opened but never closed: the next OPEN fails with SQLCODE -502.`);
    }
  }

  // Commented-out code blocks.
  let run = 0; let start = -1;
  const looksLikeCode = (l: string) => {
    const t = fixed.length && /^.{5}[Cc]\*/.test(l) ? l.slice(7) : l.replace(/^\s*(\/\/|.{5}.\*|\*)/, '');
    return /;\s*$/.test(t) || /^\s*(if|endif|dow|enddo|eval|chain|read\w*|write|update|delete|exsr|callp|return|dcl-\w+|for|select|when|monitor)\b/i.test(t) || /^.{19}\s*(EVAL|CHAIN|READ|WRITE|IF|ENDIF|MOVE|Z-ADD|EXSR|DO\w*)\b/i.test(t);
  };
  for (let i = 0; i <= lines.length; i++) {
    const l = lines[i];
    const comment = l !== undefined && (/^\s*\/\//.test(fullyFree ? l : l.slice(7)) || /^.{6}\*/.test(l));
    if (comment && looksLikeCode(l)) { if (start < 0) { start = i; } run++; continue; }
    if (run >= 5) { push('commented-out-code', 'info', start, 0, lines[start].length, `${run} lines of commented-out code: Git or the local history keep the old version; remove them.`); }
    run = 0; start = -1;
  }
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}

// ---------------------------------------------------------------- blocks

/** The END statement that closes the innermost block still open before `line` (free form), or undefined. */
export function closeBlock(text: string, line: number): { close: string; indent: string } | undefined {
  const lines = text.split(/\r?\n/).slice(0, line + 1);
  const fullyFree = isFullyFreeSource(text);
  const stack: { kw: string; indent: string }[] = [];
  for (const raw of lines) {
    if (isFixedLine(raw, fullyFree)) { continue; }
    const l = maskLine(raw, fullyFree);
    const kw = (/^\s*([A-Za-z][A-Za-z0-9-]*)/.exec(l)?.[1] ?? '').toUpperCase();
    const indent = /^\s*/.exec(raw)?.[0] ?? '';
    if (/^(IF|DOW|DOU|FOR|FOR-EACH|SELECT|MONITOR|BEGSR|DCL-PROC)$/.test(kw)) { stack.push({ kw, indent }); }
    else if (kw === 'DCL-DS' || kw === 'DCL-PI' || kw === 'DCL-PR') {
      const u = l.toUpperCase();
      if (!/\bEND-(DS|PI|PR)\b/.test(u) && !/\b(LIKEDS|LIKEREC)\s*\(/.test(u)) { stack.push({ kw, indent }); }
    } else if (/^(ENDIF|ENDDO|ENDFOR|ENDSL|ENDMON|ENDSR|END-PROC|END-DS|END-PI|END-PR|END)$/.test(kw)) { stack.pop(); }
  }
  const top = stack.pop();
  return top ? { close: `${FOR_OPEN[top.kw]};`, indent: top.indent } : undefined;
}

/** After Enter on a block opener, the END to insert when that kind of block is not closed anywhere below. */
export function autoCloseFor(text: string, line: number): { close: string; indent: string } | undefined {
  const lines = text.split(/\r?\n/);
  const raw = lines[line] ?? '';
  const fullyFree = isFullyFreeSource(text);
  if (isFixedLine(raw, fullyFree)) { return undefined; }
  const l = maskLine(raw, fullyFree);
  const kw = (/^\s*([A-Za-z][A-Za-z0-9-]*)/.exec(l)?.[1] ?? '').toUpperCase();
  if (!/^(IF|DOW|DOU|FOR|FOR-EACH|SELECT|MONITOR|BEGSR|DCL-PROC|DCL-PI|DCL-PR)$/.test(kw) || !l.trim().endsWith(';')) { return undefined; }
  const close = FOR_OPEN[kw];
  const opener = new RegExp(`^\\s*${kw.replace('-', '\\-')}\\b`, 'i'); const closer = new RegExp(`^\\s*${close.replace('-', '\\-')}\\b`, 'i');
  let open = 0; let closed = 0;
  for (const r of lines) { const m = maskLine(r, fullyFree); if (opener.test(m)) { open++; } if (closer.test(m)) { closed++; } }
  return open > closed ? { close: `${close};`, indent: /^\s*/.exec(raw)?.[0] ?? '' } : undefined;
}

/** IF … ELSEIF … ELSE … ENDIF (top level of the selection) rewritten as SELECT / WHEN / OTHER / ENDSL. */
export function ifToSelect(text: string): string {
  const lines = text.split(/\r?\n/);
  let depth = 0; let seenIf = false;
  const out = lines.map(raw => {
    const l = maskLine(raw, true);
    const kw = (/^\s*([A-Za-z][A-Za-z0-9-]*)/.exec(l)?.[1] ?? '').toUpperCase();
    const ind = /^\s*/.exec(raw)![0];
    if (kw === 'IF') {
      depth++;
      if (depth === 1) {
        if (seenIf) { throw new Error('Select one IF … ENDIF block.'); }
        seenIf = true;
        const cond = raw.trim().replace(/^if\s+/i, '');
        return `${ind}select;\n${ind}  when ${cond}`;
      }
    } else if (depth === 1 && kw === 'ELSEIF') { return `${ind}  when ${raw.trim().replace(/^elseif\s+/i, '')}`; }
    else if (depth === 1 && kw === 'ELSE') { return `${ind}  other;`; }
    else if (/^(DOW|DOU|FOR|FOR-EACH|SELECT|MONITOR)$/.test(kw)) { depth++; }
    else if (kw === 'ENDIF' || kw === 'END') { depth--; if (depth === 0) { return `${ind}endsl;`; } }
    else if (/^(ENDDO|ENDFOR|ENDSL|ENDMON)$/.test(kw)) { depth--; }
    return depth >= 1 && raw.trim() ? `  ${raw}` : raw;
  });
  if (!seenIf || depth !== 0) { throw new Error('Select a complete IF … ENDIF block.'); }
  return out.join('\n');
}

export type SurroundKind = 'if' | 'monitor' | 'dow' | 'for' | 'select' | 'begsr' | 'comment';

/** The selected lines inside a new block, as a snippet ($1, $2 placeholders). */
export function surround(text: string, kind: SurroundKind, step = 2): string {
  const lines = text.replace(/\n$/, '').split(/\r?\n/);
  const ind = lines.filter(l => l.trim()).reduce((m, l) => Math.min(m, /^\s*/.exec(l)![0].length), 999);
  const pad = ' '.repeat(ind === 999 ? 0 : ind);
  const inner = lines.map(l => (l.trim() ? ' '.repeat(step) + l : l)).join('\n').replace(/\$/g, '\\$');
  switch (kind) {
    case 'if': return `${pad}if \${1:condition};\n${inner}\n${pad}endif;\n`;
    case 'monitor': return `${pad}monitor;\n${inner}\n${pad}on-error \${1:*all};\n${pad}${' '.repeat(step)}\${2:// handle the error};\n${pad}endmon;\n`;
    case 'dow': return `${pad}dow \${1:not %eof(file)};\n${inner}\n${pad}enddo;\n`;
    case 'for': return `${pad}for \${1:i} = 1 to \${2:n};\n${inner}\n${pad}endfor;\n`;
    case 'select': return `${pad}select;\n${pad}${' '.repeat(step)}when \${1:condition};\n${lines.map(l => (l.trim() ? ' '.repeat(step * 2) + l : l)).join('\n').replace(/\$/g, '\\$')}\n${pad}${' '.repeat(step)}other;\n${pad}endsl;\n`;
    case 'begsr': return `${pad}begsr \${1:name};\n${inner}\n${pad}endsr;\n`;
    default: return lines.map(l => `${pad}// ${l.slice(Math.min(pad.length, /^\s*/.exec(l)![0].length))}`).join('\n').replace(/\$/g, '\\$') + '\n';
  }
}

// ---------------------------------------------------------------- comments, case, declarations

/** Comment / uncomment lines: '*' in column 7 for fixed-format and column-limited lines, '// ' for free form. */
export function toggleComments(lines: string[], fullyFree: boolean): string[] {
  const isComment = (l: string) => (fullyFree ? /^\s*\/\//.test(l) : /^.{6}\*/.test(l) || /^\s{7,}\/\//.test(l) || /^.{5}\s*\/\//.test(l));
  const commenting = !lines.filter(l => l.trim()).every(isComment);
  return lines.map(l => {
    if (!l.trim()) { return l; }
    if (fullyFree) {
      const ind = /^\s*/.exec(l)![0];
      return commenting ? `${ind}// ${l.slice(ind.length)}` : l.replace(/^(\s*)\/\/ ?/, '$1');
    }
    const p = l.padEnd(7);
    if (commenting) { return (p.slice(0, 6) + '*' + p.slice(7)).replace(/\s+$/, ''); }
    if (/^.{6}\*/.test(p)) { return (p.slice(0, 6) + ' ' + p.slice(7)).replace(/\s+$/, ''); }
    return l.replace(/^(\s*)\/\/ ?/, '$1');
  });
}

const KEYWORDS = new Set([...Object.keys(OPCODES), ...Object.keys(BIFS), 'DCL-S', 'DCL-C', 'DCL-DS', 'END-DS', 'DCL-PR', 'END-PR', 'DCL-PI', 'END-PI', 'DCL-PROC', 'END-PROC', 'DCL-F', 'DCL-SUBF', 'DCL-PARM', 'CTL-OPT',
  'CHAR', 'VARCHAR', 'PACKED', 'ZONED', 'INT', 'UNS', 'IND', 'DATE', 'TIME', 'TIMESTAMP', 'POINTER', 'LIKE', 'LIKEDS', 'LIKEREC', 'DIM', 'INZ', 'CONST', 'VALUE', 'QUALIFIED', 'TEMPLATE', 'EXPORT', 'EXTPGM', 'EXTPROC',
  'KEYED', 'USAGE', 'EXTFILE', 'EXTDESC', 'PREFIX', 'RENAME', 'OPTIONS', 'NOT', 'AND', 'OR', 'TO', 'BY', 'DOWNTO', 'ELSEIF', 'WHEN', 'OTHER', 'ON-ERROR', 'ENDMON', 'ENDSL', 'ENDIF', 'ENDDO', 'ENDFOR', 'ENDSR', 'EXEC', 'SQL', 'DFTACTGRP', 'ACTGRP', 'OPTION', 'MAIN', 'NOMAIN', 'BNDDIR', 'POS', 'OVERLAY', 'STATIC', 'BASED']);

/** Operation codes, BIFs and keywords in one case (outside literals and comments). Names are not changed. */
export function keywordCase(text: string, mode: 'lower' | 'upper'): string {
  const fullyFree = isFullyFreeSource(text);
  return text.split('\n').map(line => {
    if (isFixedLine(line, fullyFree) || /^\s*\*\*free/i.test(line)) { return line; }
    let out = ''; let i = 0; let q = false;
    while (i < line.length) {
      const c = line[i];
      if (!q && c === '/' && line[i + 1] === '/') { out += line.slice(i); break; }
      if (c === "'") { q = !q; out += c; i++; continue; }
      if (!q && /[%A-Za-z*]/.test(c) && !/[\w$#@]/.test(line[i - 1] ?? '')) {
        const m = /^[%*]?[A-Za-z][\w$#@-]*/.exec(line.slice(i))![0];
        const word = m.replace(/-$/, '');
        const up = word.toUpperCase();
        if (KEYWORDS.has(up) || /^\*(ON|OFF|BLANKS?|ZEROS?|HIVAL|LOVAL|NULL|INLR|IN\d\d|NO|YES|NEW|CALLER|ALL|OMIT|NOPASS|VARSIZE|STRING|TRIM|SRCSTMT|NODEBUGIO|N|ISO|USA|EUR|CHAR|DCLCASE|INPUT|OUTPUT|UPDATE|DELETE|INOUT|LIBL|CURLIB)$/.test(up)) { out += mode === 'upper' ? up : up.toLowerCase(); }
        else { out += word; }
        i += word.length; continue;
      }
      out += c; i++;
    }
    return out;
  }).join('\n');
}

const DECL = /^(\s*)(dcl-[sc])\s+([A-Za-z$#@_][\w$#@]*)\s+(.*)$/i;

/** One-line DCL-S / DCL-C declarations sorted by name (comments and blank lines stay where they are not allowed). */
export function sortDeclarations(lines: string[]): string[] {
  if (lines.some(l => l.trim() && !DECL.test(l))) { throw new Error('Select only one-line DCL-S and DCL-C declarations.'); }
  const decl = lines.filter(l => l.trim());
  return decl.sort((a, b) => DECL.exec(a)![3].localeCompare(DECL.exec(b)![3], 'en', { sensitivity: 'base' }));
}

/** DCL-S / DCL-C / subfield declarations with their types lined up. */
export function alignDeclarations(lines: string[]): string[] {
  const rx = /^(\s*)((?:dcl-[sc]|dcl-subf)\s+)?([A-Za-z$#@_][\w$#@]*)\s+(\S.*)$/i;
  const rows = lines.map(l => (l.trim() && !/^\s*(\/\/|dcl-ds|end-ds|dcl-pi|end-pi|dcl-pr|end-pr)\b/i.test(l) ? rx.exec(l) : null));
  const w = Math.max(0, ...rows.filter(Boolean).map(m => (m![2] ? m![2].replace(/\s+$/, ' ').length : 0) + m![3].length));
  return lines.map((l, i) => {
    const m = rows[i];
    if (!m) { return l; }
    const head = (m[2] ? m[2].replace(/\s+$/, ' ') : '') + m[3];
    return `${m[1]}${head.padEnd(w)} ${m[4].trim()}`;
  });
}

// ---------------------------------------------------------------- lines and columns

/** A long free-form statement wrapped at spaces outside literals, the next lines indented under the first. */
export function wrapLine(line: string, width = 80, extra = 2): string[] {
  if (line.length <= width) { return [line]; }
  const ind = /^\s*/.exec(line)![0];
  const cont = ind + ' '.repeat(extra);
  const out: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > width) {
    const pre = first ? '' : cont;
    let q = false; let cut = -1;
    for (let i = 0; i < Math.min(rest.length, width); i++) {
      if (rest[i] === "'") { q = !q; }
      if (!q && rest[i] === ' ' && i > (first ? ind.length : cont.length) + 4) { cut = i; }
    }
    if (cut < 0) { break; }
    out.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = pre ? cont + rest.slice(cut).trim() : cont + rest.slice(cut).trim();
    first = false;
  }
  out.push(rest);
  return out;
}

export const RULER_MARK = '....+....1....+....2';

/** An SEU column ruler for the line, as a comment (fixed: * in column 7; free: //). */
export function rulerLine(fixed: boolean): string {
  const r = '....+....1....+....2....+....3....+....4....+....5....+....6....+....7....+....8';
  return fixed ? `     *${r.slice(6)}` : `// ${r}`;
}

/** Columns 1-5 (change markers, old sequence numbers) cleared on fixed and column-limited lines. */
export function clearChangeMarkers(lines: string[], fullyFree: boolean): { lines: string[]; changed: number } {
  if (fullyFree) { return { lines, changed: 0 }; }
  let changed = 0;
  const out = lines.map(l => {
    if (l.length < 6 || !l.slice(0, 5).trim() || /^\s*\*\*free/i.test(l) || /^\s*\//.test(l)) { return l; }
    changed++;
    return '     ' + l.slice(5);
  });
  return { lines: out, changed };
}

// ---------------------------------------------------------------- procedures

/** A comment header for a procedure: purpose, each parameter and what it returns. */
export function procedureHeader(name: string, params: { name: string; definition: string }[], returns: string, indent = ''): string {
  const w = Math.max(0, ...params.map(p => p.name.length));
  const lines = [
    `${indent}// ------------------------------------------------------------------`,
    `${indent}// ${name}: \${1:what it does}`,
    `${indent}//`,
    ...params.map((p, i) => `${indent}// @param ${p.name.padEnd(w)}  ${p.definition.replace(/\s+/g, ' ').replace(/\$/g, '\\$')} — \${${i + 2}:meaning}`),
    ...(returns ? [`${indent}// @return ${returns.replace(/\$/g, '\\$')} — \${${params.length + 2}:meaning}`] : []),
    `${indent}// ------------------------------------------------------------------`,
  ];
  return lines.join('\n') + '\n';
}

/** A call of a procedure as a snippet: name(${1:p1}: ${2:p2}). */
export function callSnippet(name: string, params: { name: string }[]): string {
  return `${name}(${params.map((p, i) => `\${${i + 1}:${p.name.replace(/[$}]/g, '')}}`).join(': ')})`;
}

/** Where to show parameter names in calls of known procedures: one hint before each argument. */
export function callArgumentHints(line: string, sigs: Map<string, string[]>): { at: number; name: string }[] {
  const out: { at: number; name: string }[] = [];
  const masked = maskLine(line, true);
  const re = /\b([A-Za-z$#@_][\w$#@]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const params = sigs.get(m[1].toUpperCase());
    if (!params?.length) { continue; }
    let depth = 0; let arg = 0; let i = m.index + m[0].length;
    let argStart = i;
    const starts: number[] = [];
    for (; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(') { depth++; } else if (c === ')') { if (depth === 0) { break; } depth--; }
      else if (c === ':' && depth === 0) { starts.push(argStart); argStart = i + 1; arg++; }
    }
    if (masked.slice(m.index + m[0].length, i).trim()) { starts.push(argStart); }
    starts.forEach((s, k) => {
      if (k >= params.length) { return; }
      let at = s; while (at < masked.length && masked[at] === ' ') { at++; }
      const argText = masked.slice(at, starts[k + 1] !== undefined ? starts[k + 1] - 1 : i).trim();
      if (argText.toUpperCase() !== params[k].toUpperCase()) { out.push({ at, name: params[k] }); }
    });
  }
  return out;
}

/** The procedure (or subroutine) a line belongs to. */
export function procedureAt(text: string, line: number): string | undefined {
  const p = parseRpg(text).procedures.find(x => line >= x.start && line <= x.end);
  if (p) { return p.name; }
  const lines = text.split(/\r?\n/);
  for (let i = line; i >= 0; i--) {
    const l = lines[i] ?? '';
    if (/^\s*endsr\b/i.test(l) || (/^.{5}[Cc]/.test(l) && l.substring(25, 35).trim().toUpperCase() === 'ENDSR')) { return undefined; }
    const b = /^\s*begsr\s+([\w$#@]+)/i.exec(l)?.[1] ?? (/^.{5}[Cc]/.test(l) && l.substring(25, 35).trim().toUpperCase() === 'BEGSR' ? l.substring(11, 25).trim() : undefined);
    if (b) { return `${b} (subroutine)`; }
  }
  return undefined;
}

/** Start lines of procedures and subroutines, for next / previous procedure. */
export function procedureStarts(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*(dcl-proc|begsr)\s+[\w$#@]+/i.test(l) || (/^.{5}[Pp]/.test(l) && l.slice(23, 24).toUpperCase() === 'B') || (/^.{5}[Cc]/.test(l) && l.substring(25, 35).trim().toUpperCase() === 'BEGSR')) { out.push(i); }
  });
  return out;
}

/** The DCL-PR for a procedure, from its DCL-PROC / DCL-PI in another source. */
export function prototypeFrom(source: string, name: string): string | undefined {
  const N = name.replace(/[$#@]/g, '\\$&');
  const m = new RegExp(`^\\s*dcl-proc\\s+${N}\\b[^;]*;([\\s\\S]*?)^\\s*end-proc\\b`, 'im').exec(source);
  if (!m) { return undefined; }
  const pi = /^\s*dcl-pi\s+(\S+)([^;]*);([\s\S]*?)^\s*end-pi\s*;/im.exec(m[1]);
  const exported = new RegExp(`^\\s*dcl-proc\\s+${N}\\b[^;]*\\bexport\\b`, 'im').test(source);
  const extproc = exported ? ` extproc('${name.toUpperCase()}')` : '';
  if (!pi) { return `dcl-pr ${name}${extproc};\nend-pr;\n`; }
  const ret = pi[2].replace(/\s+/g, ' ').trim();
  const parms = pi[3].split('\n').map(l => l.replace(/\/\/.*$/, '').trimEnd()).filter(l => l.trim()).map(l => `  ${l.trim()}`);
  return `dcl-pr ${name}${ret ? ' ' + ret : ''}${extproc};\n${parms.join('\n')}${parms.length ? '\n' : ''}end-pr;\n`;
}

/** The SQL text of the EXEC SQL statement around a line, with its range. */
export function embeddedSqlAt(text: string, line: number): { start: number; end: number; sql: string; indent: string } | undefined {
  const lines = text.split(/\r?\n/);
  let s = line;
  while (s >= 0 && !/\bexec\s+sql\b/i.test(lines[s] ?? '')) { if (s < line && (lines[s] ?? '').includes(';')) { return undefined; } s--; }
  if (s < 0) { return undefined; }
  let e = s;
  while (e < lines.length && !maskLine(lines[e], true).includes(';')) { e++; }
  if (e >= lines.length || e < line) { return undefined; }
  const body = lines.slice(s, e + 1).join('\n');
  const at = body.search(/\bexec\s+sql\b/i);
  const sql = body.slice(at).replace(/^exec\s+sql\s*/i, '').replace(/;\s*(\/\/.*)?$/, '').trim();
  return { start: s, end: e, sql, indent: /^\s*/.exec(lines[s])![0] };
}
