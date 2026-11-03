// Module and service-program helpers (pure, unit tested): binder source and a prototype copybook from the exported
// procedures, documentation headers for every procedure, joining a statement split over several lines, removing
// unused one-line declarations and putting a DCL-PR back in line with its procedure interface.
import { isFullyFreeSource, maskLine } from './parser';
import { prototypeFrom } from './rpgProductivity';
import { interfaces } from './rpgSafetyChecks';

export interface Export { name: string; kind: 'procedure' | 'data'; line: number }

/** Procedures and data items with EXPORT, in source order (free form). */
export function exportsOf(text: string): Export[] {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const out: Export[] = [];
  let depth = 0; // inside a procedure, DCL-S … EXPORT is not allowed anyway; only module-level items count
  lines.forEach((raw, i) => {
    const code = maskLine(raw, fullyFree);
    if (/^\s*end-proc\b/i.test(code)) { depth = 0; return; }
    let m = /^\s*dcl-proc\s+([A-Za-z_$#@][\w$#@]*)([^;]*)/i.exec(code);
    if (m) { depth = 1; if (/\bexport\b/i.test(m[2])) { out.push({ name: m[1], kind: 'procedure', line: i }); } return; }
    m = /^\s*dcl-(?:s|ds|c)\s+([A-Za-z_$#@][\w$#@]*)([^;]*)/i.exec(code);
    if (m && !depth && /\bexport\b/i.test(m[2])) { out.push({ name: m[1], kind: 'data', line: i }); }
  });
  return out;
}

/** Binder source (STRPGMEXP … ENDPGMEXP) for the exports of a module. Order matters: new exports go at the end. */
export function binderSource(text: string, member: string, existing?: string): string {
  const exp = exportsOf(text);
  if (!exp.length) { throw new Error('No procedure or data item is exported (EXPORT) in this source.'); }
  const sig = `${member.toUpperCase()} V1`.slice(0, 16);
  // Keep the order of an existing binder source and add the new exports at the end, so the signature stays compatible.
  const old = existing ? [...existing.matchAll(/EXPORT\s+SYMBOL\(\s*(?:'([^']+)'|"([^"]+)"|([\w$#@]+))\s*\)/gi)].map(m => (m[1] ?? m[2] ?? m[3]).toUpperCase()) : [];
  const now = exp.map(e => e.name.toUpperCase());
  const removed = old.filter(n => !now.includes(n));
  // A symbol that is not exported any more cannot stay in the list (CRTSRVPGM fails), so it is dropped and flagged.
  const names = [...old.filter(n => now.includes(n)), ...now.filter(n => !old.includes(n))];
  return [
    `/* Binder source of ${member.toUpperCase()} — ${exp.length} export(s). */`,
    '/* Add new exports at the END of the list to keep the signature compatible. */',
    ...(removed.length ? [`/* Not exported any more: ${removed.join(', ')}. The export list changed: re-bind the callers or change the SIGNATURE. */`] : []),
    `STRPGMEXP  PGMLVL(*CURRENT) SIGNATURE('${sig}')`,
    ...names.map(n => `  EXPORT     SYMBOL('${n}')`),
    'ENDPGMEXP',
    '',
  ].join('\n');
}

/** A copybook with the DCL-PR of every exported procedure, guarded against a second /COPY. */
export function prototypeCopybook(text: string, member: string): string {
  const procs = exportsOf(text).filter(e => e.kind === 'procedure');
  if (!procs.length) { throw new Error('No procedure is exported (DCL-PROC … EXPORT) in this source.'); }
  const guard = `${member.toUpperCase().replace(/[^\w$#@]/g, '_')}_P`;
  const body = procs.map(p => prototypeFrom(text, p.name)).filter(Boolean).join('\n');
  return `**free\n// Prototypes of ${member.toUpperCase()} — /COPY this member in the programs that call it.\n/if defined(${guard})\n/eof\n/endif\n/define ${guard}\n\n${body}`;
}

/** A plain (non-snippet) documentation header for each procedure that has no comment just above it. */
export function documentationHeaders(text: string, indentOf: (line: number) => string = () => ''): { line: number; text: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
  const pis = interfaces(text).filter(x => x.kind === 'PI');
  lines.forEach((raw, i) => {
    const m = /^\s*dcl-proc\s+([A-Za-z_$#@][\w$#@]*)/i.exec(raw);
    if (!m) { return; }
    let j = i - 1; while (j >= 0 && !lines[j].trim()) { j--; }
    if (j >= 0 && /^\s*(\/\/|\*)/.test(lines[j].replace(/^.{5}(?=\*)/, ''))) { return; }
    const pi = pis.find(p => p.line > i && p.name.toUpperCase() === m[1].toUpperCase());
    const ind = indentOf(i);
    const w = Math.max(0, ...(pi?.parms ?? []).map(p => p.name.length));
    out.push({ line: i, text: [
      `${ind}// ------------------------------------------------------------------`,
      `${ind}// ${m[1]}: TODO describe what it does`,
      ...(pi?.parms.length ? [`${ind}//`] : []),
      ...(pi?.parms ?? []).map(p => `${ind}// @param ${p.name.padEnd(w)}  ${p.detail.replace(/\s+/g, ' ')}`),
      ...(pi?.returns ? [`${ind}// @return ${pi.returns}`] : []),
      `${ind}// ------------------------------------------------------------------`,
    ].join('\n') + '\n' });
  });
  return out;
}

/** One statement written over several lines, joined on one line (the reverse of Wrap Long Line). */
export function joinStatement(lines: string[]): string {
  if (lines.length < 2) { throw new Error('Select the lines of one statement.'); }
  for (const l of lines) {
    if (l.replace(/'[^']*'/g, '').includes('//')) { throw new Error('A line has a // comment: joining would turn the rest of the statement into a comment.'); }
    if ((l.match(/'/g) ?? []).length % 2) { throw new Error('A literal continues on the next line: join it by hand.'); }
  }
  const semis = lines.map(l => (maskLine(l, true).match(/;/g) ?? []).length);
  if (semis.slice(0, -1).some(n => n > 0)) { throw new Error('The selection holds more than one statement.'); }
  const indent = /^\s*/.exec(lines[0])![0];
  return indent + lines.map(l => l.trim()).filter(Boolean).join(' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
}

/** Lines that can be removed safely for unused names: one-line DCL-S / DCL-C statements that declare only that name. */
export function removableDeclarations(text: string, unused: { line: number; name: string }[]): number[] {
  const lines = text.split(/\r?\n/);
  const out = new Set<number>();
  for (const u of unused) {
    const l = lines[u.line] ?? '';
    const m = /^\s*dcl-[sc]\s+([A-Za-z_$#@][\w$#@]*)\b[^;]*;\s*(\/\/.*)?$/i.exec(l);
    if (m && m[1].toUpperCase() === u.name.toUpperCase() && !/\b(export|import)\b/i.test(maskLine(l, true))) { out.add(u.line); }
  }
  return [...out].sort((a, b) => a - b);
}

/** The parameter lines of a DCL-PR replaced by those of the DCL-PI of the same procedure; the DCL-PR line is kept. */
export function syncPrototype(text: string, name: string): { start: number; end: number; lines: string[] } | undefined {
  const ifs = interfaces(text);
  const pr = ifs.find(x => x.kind === 'PR' && x.name.toUpperCase() === name.toUpperCase());
  const pi = ifs.find(x => x.kind === 'PI' && x.name.toUpperCase() === name.toUpperCase());
  if (!pr || !pi || pr.end === pr.line) { return undefined; }
  const lines = text.split(/\r?\n/);
  if (!/^\s*end-pr\b/i.test(lines[pr.end + 1] ?? '') && !/^\s*end-pr\b/i.test(lines[pr.end] ?? '')) { return undefined; }
  const endPr = /^\s*end-pr\b/i.test(lines[pr.end] ?? '') ? pr.end : pr.end + 1;
  const indent = /^\s*/.exec(lines[pr.line])![0];
  const step = /^\s*/.exec(lines[pr.line + 1] ?? '')![0].length > indent.length ? /^\s*/.exec(lines[pr.line + 1])![0] : indent + '  ';
  let head = lines[pr.line];
  // Same return type as the interface.
  if (pi.returns !== pr.returns) {
    const N = pr.name.replace(/[$#@]/g, '\\$&');
    head = head.replace(new RegExp(`^(\\s*dcl-pr\\s+${N})(\\s+${pr.returns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?`, 'i'), `$1${pi.returns ? ' ' + pi.returns : ''}`);
  }
  const parms = pi.parms.map(p => `${step}${(lines[p.line] ?? '').trim()}`);
  return { start: pr.line, end: endPr, lines: [head, ...parms, lines[endPr]] };
}

/** Where to declare a new variable used on `line`: after the declarations of its procedure, else of the main part. */
export function declarationLine(text: string, line: number): { line: number; indent: string } {
  const lines = text.split(/\r?\n/);
  let procStart = -1;
  for (let i = line; i >= 0; i--) {
    if (/^\s*end-proc\b/i.test(lines[i] ?? '')) { break; }
    if (/^\s*dcl-proc\b/i.test(lines[i] ?? '')) { procStart = i; break; }
  }
  const isDecl = (l: string) => /^\s*(dcl-[scf]\b|end-ds\b|end-pi\b|end-pr\b|ctl-opt\b|\*\*free|\/copy\b|\/include\b|dcl-ds\b[^;]*\b(likeds|likerec|extname)\b)/i.test(l);
  if (procStart >= 0) {
    let at = procStart + 1;
    for (let i = procStart + 1; i < lines.length && i <= line; i++) {
      if (/^\s*(dcl-pi|dcl-ds|dcl-pr)\b/i.test(lines[i]) && !/\bend-(pi|ds|pr)\b/i.test(lines[i]) && !/\b(likeds|likerec)\s*\(/i.test(lines[i])) {
        while (i < lines.length && !/^\s*end-(pi|ds|pr)\b/i.test(lines[i])) { i++; }
        at = i + 1; continue;
      }
      if (isDecl(lines[i])) { at = i + 1; continue; }
      if (lines[i].trim() && !/^\s*\/\//.test(lines[i])) { break; }
    }
    return { line: at, indent: (/^\s*/.exec(lines[procStart])![0]) + '  ' };
  }
  let at = 0;
  const firstProc = lines.findIndex(l => /^\s*dcl-proc\b/i.test(l));
  for (let i = 0; i < (firstProc < 0 ? lines.length : firstProc); i++) {
    if (/^\s*(dcl-ds|dcl-pr|dcl-pi)\b/i.test(lines[i]) && !/\bend-(pi|ds|pr)\b/i.test(lines[i]) && !/\b(likeds|likerec)\s*\(/i.test(lines[i])) {
      while (i < lines.length && !/^\s*end-(pi|ds|pr)\b/i.test(lines[i])) { i++; }
      at = i + 1; continue;
    }
    if (isDecl(lines[i])) { at = i + 1; }
  }
  return { line: at, indent: '' };
}

/** Where a new subroutine goes: before the first procedure, else at the end. */
export function subroutineLine(text: string): number {
  const lines = text.split(/\r?\n/);
  const firstProc = lines.findIndex(l => /^\s*dcl-proc\b/i.test(l));
  if (firstProc >= 0) { let i = firstProc; while (i > 0 && /^\s*(\/\/.*)?$/.test(lines[i - 1])) { i--; } return i; }
  let end = lines.length; while (end > 0 && !lines[end - 1].trim()) { end--; }
  return end;
}
