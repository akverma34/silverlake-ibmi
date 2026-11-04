// Checks for DDS sources while you type (physical, logical, display and printer files): names too long, fields or
// record formats declared twice, fields without a length, decimals larger than the length, lengths beyond the limits,
// key fields that are not in the record, display fields outside the screen and display fields that overlap. Pure, unit
// tested; a check that cannot be sure (reference fields, logical files, conditioned fields) says nothing.

export type DdsRule = 'dds-name-too-long' | 'dds-duplicate-name' | 'dds-missing-length' | 'dds-decimals' | 'dds-length-limit' | 'dds-key-not-in-record' | 'dds-off-screen' | 'dds-overlap';

export const DDS_RULES: Record<DdsRule, string> = {
  'dds-name-too-long': 'Record format and field names longer than 10 characters',
  'dds-duplicate-name': 'A field declared twice in a record format, or a record format declared twice',
  'dds-missing-length': 'A field with no length, no reference (R) and no REF / REFFLD',
  'dds-decimals': 'More decimal positions than the length of the field',
  'dds-length-limit': 'A length beyond what the data type allows',
  'dds-key-not-in-record': 'A key field (K) that is not a field of the record format',
  'dds-off-screen': 'A display field or constant outside the screen size (DSPSIZ)',
  'dds-overlap': 'Two display fields or constants of a record format on top of each other',
};

export interface DdsFinding { rule: DdsRule; severity: 'error' | 'warning' | 'info'; line: number; start: number; end: number; message: string }

export interface DdsLine {
  line: number; nameType: string; name: string; longName?: string; ref: boolean; length?: number; dataType: string; decimals?: number; usage: string;
  row?: number; col?: number; keywords: string; conditioned: boolean; comment: boolean;
}

const num = (s: string) => { const t = s.trim(); return /^[+-]?\d+$/.test(t) ? Number(t) : undefined; };

/** One DDS line by its columns (1-based: type 17, name 19-28, ref 29, length 30-34, data type 35, decimals 36-37, usage 38, line 39-41, position 42-44, keywords 45-80). */
export function parseDdsLine(raw: string, line: number): DdsLine {
  const s = raw.padEnd(80);
  const comment = s[6] === '*' || !raw.trim();
  // A name typed past column 28 runs into the reference and length columns.
  const over = /^[A-Za-z0-9$#@_]{1,}/.exec(s.slice(28, 34));
  const longName = s.slice(18, 28).trim().length === 10 && over && !(over[0] === 'R' && s[29] === ' ') ? (s.slice(18, 28) + over[0]).trim() : undefined;
  return {
    line, comment, longName, nameType: s[16].toUpperCase().trim(), name: s.slice(18, 28).trim(), ref: s[28].toUpperCase() === 'R',
    length: num(s.slice(29, 34)), dataType: s[34].toUpperCase().trim(), decimals: num(s.slice(35, 37)), usage: s[37].toUpperCase().trim(),
    row: num(s.slice(38, 41)), col: num(s.slice(41, 44)), keywords: raw.slice(44, 80), conditioned: !!s.slice(7, 16).trim(),
  };
}

/** Display length of a field (packed shows its digits, signed numbers one more). */
function shownLength(l: DdsLine): number {
  const n = l.length ?? 0;
  if (/^[YSP]$/.test(l.dataType) && (l.decimals ?? 0) > 0) { return n + 1; }
  if (l.dataType === 'L') { return 10; } if (l.dataType === 'T') { return 8; } if (l.dataType === 'Z') { return 26; }
  return n;
}

export function ddsLint(text: string, kind: 'pf' | 'lf' | 'dspf' | 'prtf' | 'other', enabled: (r: DdsRule) => boolean = () => true): DdsFinding[] {
  const out: DdsFinding[] = [];
  const push = (rule: DdsRule, severity: DdsFinding['severity'], l: DdsLine, from: number, to: number, message: string) => { if (enabled(rule)) { out.push({ rule, severity, line: l.line, start: from, end: Math.max(to, from + 1), message }); } };
  const safe = (fn: () => void) => { try { fn(); } catch { /* one check never stops the others */ } };
  const lines = text.split(/\r?\n/).map(parseDdsLine).filter(l => !l.comment);
  const fileRef = lines.some(l => !l.nameType && !l.name && /\bREF\s*\(/i.test(l.keywords) && l.line < (lines.find(x => x.nameType === 'R')?.line ?? Infinity));
  // DSPSIZ(24 80 *DS3 27 132 *DS4): the largest size the file is meant for.
  let rows = 24; let cols = 80;
  const dspsiz = text.match(/DSPSIZ\s*\(([^)]*)\)/i)?.[1];
  if (dspsiz) { const nums = (dspsiz.replace(/\*DS\d/gi, '').match(/\d+/g) ?? []).map(Number); if (nums.length >= 2) { rows = Math.max(nums[0], nums[2] ?? 0); cols = Math.max(nums[1], nums[3] ?? 0); } else if (/\*DS4/i.test(dspsiz)) { rows = 27; cols = 132; } }
  if (kind === 'prtf') { rows = 255; cols = 378; }

  const formats = new Map<string, number>();
  let current: { name: string; fields: Map<string, DdsLine>; keys: DdsLine[]; placed: { l: DdsLine; from: number; to: number }[] } | undefined;
  const records: NonNullable<typeof current>[] = [];
  for (const l of lines) {
    if (l.nameType === 'R') {
      safe(() => {
        if (l.longName) { push('dds-name-too-long', 'error', l, 18, 18 + l.longName.length, `Record format name ${l.longName} is longer than 10 characters (columns 19-28).`); }
        if (formats.has(l.name.toUpperCase())) { push('dds-duplicate-name', 'error', l, 18, 18 + l.name.length, `Record format ${l.name} is already declared on line ${formats.get(l.name.toUpperCase())! + 1}.`); }
        formats.set(l.name.toUpperCase(), l.line);
      });
      current = { name: l.name, fields: new Map(), keys: [], placed: [] }; records.push(current);
      continue;
    }
    if (!current) { continue; }
    if (l.nameType === 'K') { current.keys.push(l); continue; }
    if (l.nameType === 'S' || l.nameType === 'O' || l.nameType === 'J') { continue; }
    if (l.name) {
      safe(() => {
        if (l.longName) { push('dds-name-too-long', 'error', l, 18, 18 + l.longName.length, `Field name ${l.longName} is longer than 10 characters (columns 19-28).`); return; }
        const prev = current!.fields.get(l.name.toUpperCase());
        if (prev && !l.conditioned && !prev.conditioned) { push('dds-duplicate-name', 'error', l, 18, 18 + l.name.length, `Field ${l.name} is already in record format ${current!.name} (line ${prev.line + 1}).`); }
        current!.fields.set(l.name.toUpperCase(), l);
        const refd = l.ref || /\bREFFLD\s*\(/i.test(l.keywords) || fileRef;
        if (l.length === undefined && !refd && kind !== 'lf' && l.usage !== 'H' && !/^[LTZ]$/.test(l.dataType)) { push('dds-missing-length', 'warning', l, 29, 34, `${l.name} has no length: give one in columns 30-34, or R in column 29 with REF / REFFLD.`); }
        if (l.length !== undefined && l.decimals !== undefined && l.decimals > l.length) { push('dds-decimals', 'error', l, 35, 37, `${l.name} has ${l.decimals} decimal positions but a length of ${l.length}.`); }
        const max = /^[PSYB]$/.test(l.dataType) || (l.decimals !== undefined && !l.dataType) ? (l.dataType === 'B' ? 18 : 63) : /^[AO]$/.test(l.dataType) || !l.dataType ? 32766 : /^[GJE]$/.test(l.dataType) ? 16383 : undefined;
        if (l.length !== undefined && max !== undefined && l.length > max) { push('dds-length-limit', 'error', l, 29, 34, `${l.name}: a length of ${l.length} is more than the ${max} this data type allows.`); }
      });
    }
    // Display and printer positions (fields and constants).
    if ((kind === 'dspf' || kind === 'prtf') && l.row !== undefined && l.col !== undefined && !l.conditioned) {
      const row = l.row; const col = l.col;
      safe(() => {
        const constant = !l.name && /^'/.test(l.keywords.trim());
        const len = constant ? (l.keywords.trim().match(/^'((?:[^']|'')*)'/)?.[1].replace(/''/g, "'").length ?? 0) : shownLength(l);
        if (!len) { return; }
        if (row > rows || col + len - 1 > cols || col < 1) { push('dds-off-screen', 'error', l, 38, 44, `${constant ? 'This constant' : l.name} at line ${row} position ${col} (length ${len}) does not fit on a ${rows} × ${cols} ${kind === 'dspf' ? 'screen' : 'page'}.`); }
        if (kind === 'dspf' && row > 0) {
          const from = col; const to = col + len - 1;
          // The attribute byte before each field also takes a position.
          const hit = current!.placed.find(p => p.l.row === l.row && from - 1 <= p.to && to >= p.from - 1);
          if (hit) { push('dds-overlap', 'warning', l, 38, 44, `${constant ? 'This constant' : l.name} overlaps ${hit.l.name || 'a constant'} (line ${hit.l.line + 1}) on screen line ${row}.`); }
          current!.placed.push({ l, from, to });
        }
      });
    }
  }
  if (kind === 'pf' || kind === 'other') {
    for (const r of records) {
      for (const k of r.keys) { safe(() => { if (k.name && !/^\*/.test(k.name) && !r.fields.has(k.name.toUpperCase()) && !fileRef && r.fields.size) { push('dds-key-not-in-record', 'error', k, 18, 18 + k.name.length, `Key field ${k.name} is not a field of record format ${r.name}.`); } }); }
    }
  }
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** The kind of DDS file from the member type or extension. */
export function ddsKind(typeOrPath: string): 'pf' | 'lf' | 'dspf' | 'prtf' | 'other' {
  const t = typeOrPath.toLowerCase().replace(/^.*\./, '');
  return t === 'pf' ? 'pf' : t === 'lf' ? 'lf' : t === 'dspf' ? 'dspf' : t === 'prtf' ? 'prtf' : 'other';
}
