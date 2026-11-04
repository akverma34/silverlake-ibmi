// Team coding standards for RPG (pure, unit tested): rules a team chooses — upper-case constants, names written as
// declared, QUALIFIED data structures, no globals in procedures, no global subroutines, no OCCURS / CTDATA, no SQL
// joins, no EXECUTE IMMEDIATE, a description above each procedure, parentheses around conditions, indentation,
// prototypes with EXTPGM / EXTPROC, /COPY written one way — all off until the team turns them on, from the
// `vanthrex.standards` setting, a .vscode/vanthrex-standards.json file, or an imported rpglint.json.
import { findOccurrences, isFixedLine, isFullyFreeSource, maskLine, parseRpg } from './parser';
import type { LintFinding } from './lint';

export interface Standards {
  uppercaseConstants?: boolean;
  variableCase?: boolean;
  qualifiedDs?: boolean;
  noGlobalsInProcedures?: boolean;
  noGlobalSubroutines?: boolean;
  noLocalSubroutines?: boolean;
  noOccurs?: boolean;
  noCtdata?: boolean;
  noSqlJoins?: boolean;
  noExecuteImmediate?: boolean;
  procedureDescription?: boolean;
  conditionParens?: boolean;
  /** Spaces per block level in free form, e.g. 2. */
  indent?: number;
  prototypeExt?: boolean;
  /** "upper" or "lower" for /COPY, /INCLUDE, /IF, /DEFINE… */
  directiveCase?: 'upper' | 'lower';
  /** Names must match this regular expression (variables, constants, procedures). */
  namePattern?: string;
  /** Procedures longer than this many lines. */
  maxProcedureLines?: number;
}

export const STANDARD_RULES: Record<keyof Standards, string> = {
  uppercaseConstants: 'Named constants in upper case',
  variableCase: 'Names written with the same case as their declaration',
  qualifiedDs: 'Data structures declared QUALIFIED',
  noGlobalsInProcedures: 'Procedures do not use global variables (pass them as parameters)',
  noGlobalSubroutines: 'No subroutines in the main part',
  noLocalSubroutines: 'No subroutines inside procedures',
  noOccurs: 'No OCCURS (use DIM)',
  noCtdata: 'No compile-time data (CTDATA)',
  noSqlJoins: 'No SQL joins in embedded SQL (use views)',
  noExecuteImmediate: 'No EXECUTE IMMEDIATE (use PREPARE with parameter markers)',
  procedureDescription: 'A comment above every procedure',
  conditionParens: 'Conditions of IF / DOW / DOU / WHEN in parentheses',
  indent: 'Indentation of free-form blocks',
  prototypeExt: 'Prototypes with EXTPGM or EXTPROC',
  directiveCase: 'Compiler directives (/COPY, /IF…) in one case',
  namePattern: 'Names that follow the team pattern',
  maxProcedureLines: 'Procedures not longer than the team limit',
};

/** rpglint.json (vscode-rpgle / Code for IBM i) → Vanthrex standards; unknown rules are listed. */
export function fromRpglint(json: unknown): { standards: Standards; ignored: string[] } {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const s: Standards = {}; const ignored: string[] = [];
  const on = (v: unknown) => v === true || (typeof v === 'number' && v > 0) || (typeof v === 'string' && v.length > 0);
  for (const [k, v] of Object.entries(j)) {
    switch (k) {
      case 'UppercaseConstants': if (on(v)) { s.uppercaseConstants = true; } break;
      case 'IncorrectVariableCase': if (on(v)) { s.variableCase = true; } break;
      case 'QualifiedCheck': if (on(v)) { s.qualifiedDs = true; } break;
      case 'NoGlobalsInProcedures': if (on(v)) { s.noGlobalsInProcedures = true; } break;
      case 'NoGlobalSubroutines': if (on(v)) { s.noGlobalSubroutines = true; } break;
      case 'NoLocalSubroutines': if (on(v)) { s.noLocalSubroutines = true; } break;
      case 'NoOCCURS': if (on(v)) { s.noOccurs = true; } break;
      case 'NoCTDATA': if (on(v)) { s.noCtdata = true; } break;
      case 'NoSQLJoins': if (on(v)) { s.noSqlJoins = true; } break;
      case 'NoExecuteImmediate': if (on(v)) { s.noExecuteImmediate = true; } break;
      case 'RequiresProcedureDescription': if (on(v)) { s.procedureDescription = true; } break;
      case 'ForceOptionalParens': if (on(v)) { s.conditionParens = true; } break;
      case 'indent': if (typeof v === 'number' && v > 0) { s.indent = v; } break;
      case 'PrototypeCheck': if (on(v)) { s.prototypeExt = true; } break;
      case 'DirectiveCase': if (v === 'upper' || v === 'lower') { s.directiveCase = v; } else if (on(v)) { s.directiveCase = 'upper'; } break;
      default: ignored.push(k);
    }
  }
  return { standards: s, ignored };
}

export function standardsLint(text: string, st: Standards): LintFinding[] {
  const out: LintFinding[] = [];
  if (!st || !Object.values(st).some(v => v !== undefined && v !== false)) { return out; }
  const push = (rule: keyof Standards, line: number, start: number, end: number, message: string) => { out.push({ rule: `std-${rule.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`, severity: 'info', line, start: Math.max(0, start), end: Math.max(end, start + 1), message }); };
  const safe = (fn: () => void) => { try { fn(); } catch { /* one standard never stops the others */ } };
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const fixed = lines.map(l => isFixedLine(l, fullyFree));
  const masked = lines.map((l, i) => (fixed[i] ? '' : maskLine(l, fullyFree)));
  const parse = parseRpg(text);
  const U = (i: number) => masked[i].toUpperCase();

  if (st.uppercaseConstants) safe(() => {
    for (const d of parse.definitions.filter(x => x.kind === 'constant')) { if (d.name !== d.name.toUpperCase()) { push('uppercaseConstants', d.line, d.column, d.column + d.name.length, `Constant ${d.name} should be in upper case (${d.name.toUpperCase()}).`); } }
  });
  if (st.variableCase) safe(() => {
    const declared = new Map<string, string>();
    for (const d of parse.definitions) { if (!declared.has(d.upper)) { declared.set(d.upper, d.name); } }
    for (let i = 0; i < lines.length; i++) {
      if (!masked[i].trim() || /^\s*dcl-/i.test(masked[i])) { continue; }
      for (const m of masked[i].matchAll(/(?<![%\w$#@.*])([A-Za-z_$#@][\w$#@]*)/g)) {
        const want = declared.get(m[1].toUpperCase());
        if (want && want !== m[1] && parse.definitions.some(d => d.upper === m[1].toUpperCase() && d.line !== i)) { push('variableCase', i, m.index!, m.index! + m[1].length, `Write ${want} as declared (not ${m[1]}).`); }
      }
    }
  });
  if (st.qualifiedDs) safe(() => {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*dcl-ds\s+([\w$#@]+)\b([^;]*)/i.exec(masked[i]);
      if (m && !/\b(qualified|likerec|likeds|template)\b/i.test(m[2]) && m[1].toUpperCase() !== '*N') { const c = masked[i].indexOf(m[1]); push('qualifiedDs', i, c, c + m[1].length, `Data structure ${m[1]} is not QUALIFIED: its subfields can clash with other names.`); }
    }
  });
  if (st.noGlobalsInProcedures) safe(() => {
    const globals = parse.definitions.filter(d => !d.procedure && (d.kind === 'variable' || d.kind === 'ds'));
    for (const p of parse.procedures) {
      // The body alone would be read as fixed form: keep **FREE in front of it.
      const lead = fullyFree ? 1 : 0;
      const body = (fullyFree ? '**free\n' : '') + lines.slice(p.start, p.end + 1).join('\n');
      for (const g of globals) {
        const uses = findOccurrences(body, g.name).map(o => ({ ...o, line: o.line - lead })).filter(o => o.line >= 0 && !/^\s*dcl-/i.test(lines[p.start + o.line] ?? ''));
        if (uses.length && !parse.definitions.some(d => d.procedure === p.name && d.upper === g.upper)) { const o = uses[0]; push('noGlobalsInProcedures', p.start + o.line, o.start, o.end, `Procedure ${p.name} uses the global ${g.name}: pass it as a parameter.`); }
      }
    }
  });
  safe(() => {
    for (const d of parse.definitions.filter(x => x.kind === 'subroutine')) {
      const inProc = parse.procedures.some(p => d.line > p.start && d.line < p.end);
      if (st.noGlobalSubroutines && !inProc) { push('noGlobalSubroutines', d.line, d.column, d.column + d.name.length, `Subroutine ${d.name}: the team uses procedures instead.`); }
      if (st.noLocalSubroutines && inProc) { push('noLocalSubroutines', d.line, d.column, d.column + d.name.length, `Subroutine ${d.name} inside a procedure: make it a procedure.`); }
    }
  });
  for (let i = 0; i < lines.length; i++) {
    const u = U(i); const raw = lines[i];
    if (st.noOccurs && /\bOCCURS\s*\(/.test(u)) { const c = u.search(/OCCURS/); push('noOccurs', i, c, c + 6, 'OCCURS: use a data structure array with DIM.'); }
    if (st.noOccurs && fixed[i] && /^.{5}[Dd]/.test(raw) && /\bOCCURS\(/i.test(raw.slice(43))) { push('noOccurs', i, 43, raw.length, 'OCCURS: use a data structure array with DIM.'); }
    if (st.noCtdata && (/\bCTDATA\b/.test(u) || (fixed[i] && /^.{5}[Dd]/.test(raw) && /\bCTDATA\b/i.test(raw.slice(43))) || /^\*\*\s*CTDATA\b/i.test(raw))) { push('noCtdata', i, 0, raw.length, 'Compile-time data: use a table, a data area or a JSON file instead.'); }
    if (st.noSqlJoins && /^\s*EXEC\s+SQL\b/.test(u)) {
      let s = ''; for (let j = i; j < lines.length && j < i + 40; j++) { s += ' ' + U(j); if (masked[j].includes(';')) { break; } }
      if (/\bJOIN\b/.test(s)) { const c = u.search(/EXEC/); push('noSqlJoins', i, c, c + 8, 'SQL join in the program: the team puts joins in views.'); }
    }
    if (st.noExecuteImmediate && /\bEXECUTE\s+IMMEDIATE\b/.test(u)) { const c = u.search(/EXECUTE/); push('noExecuteImmediate', i, c, c + 17, 'EXECUTE IMMEDIATE: use PREPARE and EXECUTE … USING with parameter markers (no SQL injection, plans reused).'); }
    if (st.conditionParens) {
      const m = /^(\s*)(IF|ELSEIF|DOW|DOU|WHEN)\s+(.+?)\s*;/.exec(u);
      if (m && !/^\(.*\)$/.test(m[3].trim()) && !/^NOT\s*\(.*\)$/.test(m[3].trim())) { push('conditionParens', i, m[1].length, m[1].length + m[2].length, `Put the condition of ${m[2]} in parentheses.`); }
    }
    if (st.directiveCase) {
      const m = /^\s*(\/(?:copy|include|if|elseif|else|endif|define|undefine|eof|free|end-free|set|restore|title|eject|space))\b/i.exec(raw.slice(fixed[i] ? 6 : 0));
      if (m) { const want = st.directiveCase === 'upper' ? m[1].toUpperCase() : m[1].toLowerCase(); if (m[1] !== want) { const c = raw.indexOf(m[1]); push('directiveCase', i, c, c + m[1].length, `Write ${want}.`); } }
    }
  }
  if (st.procedureDescription) safe(() => {
    for (const p of parse.procedures) {
      let j = p.start - 1; while (j >= 0 && !lines[j].trim()) { j--; }
      if (j < 0 || !/^\s*(\/\/|\*|.{5}.\*)/.test(lines[j])) { const c = lines[p.start].toUpperCase().indexOf(p.name.toUpperCase()); push('procedureDescription', p.start, c, c + p.name.length, `Procedure ${p.name} has no description: add a comment above it (Developer Toolbox → Add a Header to Every Procedure).`); }
    }
  });
  if (st.maxProcedureLines) safe(() => {
    for (const p of parse.procedures) { const n = p.end - p.start + 1; if (n > st.maxProcedureLines!) { const c = lines[p.start].toUpperCase().indexOf(p.name.toUpperCase()); push('maxProcedureLines', p.start, c, c + p.name.length, `${p.name} has ${n} lines (team limit ${st.maxProcedureLines}): split it.`); } }
  });
  if (st.prototypeExt) safe(() => {
    for (const d of parse.definitions.filter(x => x.kind === 'prototype')) {
      if (!/\bext(pgm|proc)\b/i.test(lines.slice(d.line, d.line + 2).join(' '))) { push('prototypeExt', d.line, d.column, d.column + d.name.length, `Prototype ${d.name} has no EXTPGM or EXTPROC: say which program or procedure it calls.`); }
    }
  });
  if (st.namePattern) safe(() => {
    const re = new RegExp(st.namePattern!);
    for (const d of parse.definitions.filter(x => ['variable', 'constant', 'procedure', 'ds', 'parameter'].includes(x.kind))) { if (!re.test(d.name)) { push('namePattern', d.line, d.column, d.column + d.name.length, `${d.name} does not follow the team pattern ${st.namePattern}.`); } }
  });
  if (st.indent && fullyFree) safe(() => {
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const u = U(i).trim(); if (!u || /^\*\*FREE/.test(u) || /^\//.test(u)) { continue; }
      const kw = /^([A-Z][A-Z0-9-]*)/.exec(u)?.[1] ?? '';
      const closes = /^(ENDIF|ENDDO|ENDFOR|ENDSL|ENDMON|ENDSR|END-PROC|END-DS|END-PI|END-PR|END-ENUM|ELSE|ELSEIF|WHEN|WHEN-IS|WHEN-IN|OTHER|ON-ERROR|ON-EXIT)$/.test(kw);
      if (closes && !/^(ELSE|ELSEIF|WHEN|WHEN-IS|WHEN-IN|OTHER|ON-ERROR|ON-EXIT)$/.test(kw)) { depth = Math.max(0, depth - 1); }
      const want = (/^(ELSE|ELSEIF|WHEN|WHEN-IS|WHEN-IN|OTHER|ON-ERROR|ON-EXIT)$/.test(kw) ? Math.max(0, depth - 1) : depth) * st.indent!;
      const has = /^\s*/.exec(lines[i])![0].length;
      if (has !== want && !/^\s*\/\//.test(lines[i])) { push('indent', i, 0, Math.max(1, has), `Indent ${want} spaces here (found ${has}).`); }
      const opens = /^(IF|DOW|DOU|FOR|FOR-EACH|SELECT|MONITOR|BEGSR|DCL-PROC)$/.test(kw) || (/^(DCL-DS|DCL-PI|DCL-PR|DCL-ENUM)$/.test(kw) && !/\bEND-(DS|PI|PR|ENUM)\b|\bLIKE(DS|REC)\s*\(/.test(u));
      if (opens) { depth++; }
    }
  });
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}
