// Semantic highlighting for RPG (pure, unit tested): every use of a declared name is coloured by what it is —
// variable, parameter, constant, data structure, subfield, procedure, prototype, file, subroutine — with
// "declaration" on the line that declares it and "readonly" for constants and CONST parameters, so a parameter,
// a global and a constant look different at a glance. Free form only; fixed-format lines keep the grammar colours.
import { isFixedLine, isFullyFreeSource, maskLine, parseRpg } from './parser';

export const TOKEN_TYPES = ['variable', 'parameter', 'property', 'function', 'struct', 'enumMember', 'namespace', 'event', 'enum'] as const;
export const TOKEN_MODIFIERS = ['declaration', 'readonly', 'static'] as const;
export interface SemanticToken { line: number; start: number; length: number; type: number; modifiers: number }

const KIND_TYPE: Record<string, (typeof TOKEN_TYPES)[number]> = {
  variable: 'variable', parameter: 'parameter', constant: 'variable', ds: 'struct', subfield: 'property', procedure: 'function', prototype: 'function',
  file: 'namespace', subroutine: 'event', enum: 'enum',
};

export function semanticTokens(text: string, maxLines = 40000): SemanticToken[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > maxLines) { return []; }
  const fullyFree = isFullyFreeSource(text);
  const parse = parseRpg(text);
  // Name → declarations (global and per procedure).
  const byName = new Map<string, typeof parse.definitions>();
  for (const d of parse.definitions) { const a = byName.get(d.upper) ?? []; a.push(d); byName.set(d.upper, a); }
  const procAt = (line: number) => parse.procedures.find(p => line >= p.start && line <= p.end)?.name;
  const out: SemanticToken[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isFixedLine(lines[i], fullyFree)) { continue; }
    const code = maskLine(lines[i], fullyFree);
    if (!code.trim()) { continue; }
    const proc = procAt(i);
    for (const m of code.matchAll(/(?<![\w$#@%*])([A-Za-z_$#@][\w$#@]*)/g)) {
      const cands = byName.get(m[1].toUpperCase()); if (!cands) { continue; }
      // A name after "." is a subfield of a qualified data structure.
      const prev = code[m.index! - 1];
      const d = prev === '.' ? cands.find(x => x.kind === 'subfield') : (cands.find(x => x.procedure && x.procedure === proc && x.kind !== 'subfield') ?? cands.find(x => !x.procedure && x.kind !== 'subfield') ?? cands[0]);
      if (!d) { continue; }
      // Keywords that look like names (dcl-s, if, end-proc…) are not declared, so they never match here.
      const type = KIND_TYPE[d.kind]; if (!type) { continue; }
      let mods = 0;
      if (d.line === i && d.column === m.index) { mods |= 1 << TOKEN_MODIFIERS.indexOf('declaration'); }
      if (d.kind === 'constant' || (d.kind === 'parameter' && /\bconst\b/i.test(d.detail))) { mods |= 1 << TOKEN_MODIFIERS.indexOf('readonly'); }
      if (!d.procedure && (d.kind === 'variable' || d.kind === 'ds') && proc) { mods |= 1 << TOKEN_MODIFIERS.indexOf('static'); }
      out.push({ line: i, start: m.index!, length: m[1].length, type: TOKEN_TYPES.indexOf(type), modifiers: mods });
    }
  }
  return out;
}
