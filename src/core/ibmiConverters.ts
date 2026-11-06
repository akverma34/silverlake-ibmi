// IBM i converters of the Developer Toolbox (3.3, second batch): dates between *CYMD, *YMD, *ISO and the others,
// hex ↔ decimal, short system names for long SQL names, what a CCSID is, the message file of a message ID, SQL
// types ↔ RPG types, today's date in IBM i formats and durations. Pure functions (no vscode import), unit tested.

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** A date read from the text in any common IBM i form: *ISO, *CYMD (1261106), *YMD (261106), *MDY, *DMY, *EUR, *USA, *JUL (26310). */
export function parseIbmiDate(text: string): Date {
  const t = text.trim().replace(/^'|'$/g, '');
  let m: RegExpExecArray | null;
  const mk = (y: number, mo: number, d: number) => { const dt = new Date(Date.UTC(y, mo - 1, d)); if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) { throw new Error(`"${text}" is not a valid date.`); } return dt; };
  const yy = (y: number) => y >= 40 ? 1900 + y : 2000 + y;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) { return mk(+m[1], +m[2], +m[3]); }
  if ((m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(t))) { return mk(+m[3], +m[2], +m[1]); }
  if ((m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t))) { return mk(+m[3], +m[1], +m[2]); }
  if ((m = /^([01])(\d{2})(\d{2})(\d{2})$/.exec(t))) { return mk(1900 + Number(m[1]) * 100 + Number(m[2]), +m[3], +m[4]); }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) { return mk(+m[1], +m[2], +m[3]); }
  if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(t))) { return mk(yy(+m[1]), +m[2], +m[3]); }
  if ((m = /^(\d{2})(\d{3})$/.exec(t))) { const d = new Date(Date.UTC(yy(+m[1]), 0, 1)); d.setUTCDate(+m[2]); return d; }
  throw new Error(`"${text}" is not a date in a known IBM i format (2026-11-06, 1261106, 261106, 06.11.2026, 11/06/2026, 26310).`);
}

/** The same date in every IBM i format. */
export function dateFormats(d: Date): { format: string; value: string }[] {
  const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1; const da = d.getUTCDate(); const yy = pad(y % 100);
  const jul = Math.round((Date.UTC(y, mo - 1, da) - Date.UTC(y, 0, 1)) / 86400000) + 1;
  return [
    { format: '*ISO', value: `${y}-${pad(mo)}-${pad(da)}` }, { format: '*ISO0', value: `${y}${pad(mo)}${pad(da)}` },
    { format: '*CYMD', value: `${y >= 2000 ? 1 : 0}${yy}${pad(mo)}${pad(da)}` }, { format: '*YMD', value: `${yy}${pad(mo)}${pad(da)}` },
    { format: '*MDY', value: `${pad(mo)}${pad(da)}${yy}` }, { format: '*DMY', value: `${pad(da)}${pad(mo)}${yy}` },
    { format: '*EUR', value: `${pad(da)}.${pad(mo)}.${y}` }, { format: '*USA', value: `${pad(mo)}/${pad(da)}/${y}` },
    { format: '*JUL', value: `${yy}${pad(jul, 3)}` }, { format: '*LONGJUL', value: `${y}${pad(jul, 3)}` },
  ];
}

/** Hex ↔ decimal: 0x1F, x'1F' or 1Fh → 31; 31 → x'1F'. */
export function hexDecimal(text: string): string {
  const t = text.trim();
  const h = /^(?:0x|x')?([0-9A-F]+)'?h?$/i.exec(t);
  if (/^\d+$/.test(t)) { return `x'${BigInt(t).toString(16).toUpperCase().padStart(2, '0')}'`; }
  if (h) { return BigInt('0x' + h[1]).toString(); }
  throw new Error('Select a decimal number or a hex value such as x\'1F\'.');
}

/** A system name (10 characters) for a long SQL name: words shortened, vowels dropped after the first letter. */
export function systemName(longName: string): string {
  const words = longName.trim().toUpperCase().replace(/"/g, '').split(/[_\s\-]+/).filter(Boolean);
  if (!words.length) { throw new Error('Select a name first.'); }
  if (words.join('_').length <= 10 && /^[A-Z$#@][A-Z0-9$#@_]*$/.test(words.join('_'))) { return words.join('_'); }
  const short = (w: string, n: number) => (w[0] + w.slice(1).replace(/[AEIOU]/g, '')).slice(0, n);
  const each = Math.max(2, Math.floor(10 / words.length));
  let out = words.map((w, i) => short(w, i === words.length - 1 ? 10 : each)).join('').slice(0, 10);
  if (!/^[A-Z$#@]/.test(out)) { out = ('X' + out).slice(0, 10); }
  return out;
}

const CCSIDS: Record<number, string> = {
  37: 'EBCDIC US, Canada, Netherlands, Portugal, Brazil, Australia, NZ', 273: 'EBCDIC Germany, Austria', 277: 'EBCDIC Denmark, Norway', 278: 'EBCDIC Finland, Sweden',
  280: 'EBCDIC Italy', 284: 'EBCDIC Spain, Latin America', 285: 'EBCDIC United Kingdom', 290: 'EBCDIC Japanese Katakana (SBCS)', 297: 'EBCDIC France',
  500: 'EBCDIC International (Belgium, Switzerland)', 871: 'EBCDIC Iceland', 875: 'EBCDIC Greek', 935: 'EBCDIC Simplified Chinese (mixed)', 937: 'EBCDIC Traditional Chinese (mixed)',
  1140: 'EBCDIC US with euro (37 + €)', 1141: 'EBCDIC Germany with euro', 1147: 'EBCDIC France with euro', 1148: 'EBCDIC International with euro', 1399: 'EBCDIC Japanese (mixed, with euro)',
  5026: 'EBCDIC Japanese Katakana (mixed)', 5035: 'EBCDIC Japanese Latin (mixed)', 819: 'ASCII ISO 8859-1 (Latin-1)', 1252: 'Windows Latin-1', 1208: 'UTF-8', 1200: 'UTF-16', 13488: 'UCS-2',
  65535: '*HEX: no conversion (binary)',
};
export function ccsidName(text: string): string {
  const n = Number(text.trim().replace(/^ccsid\s*/i, ''));
  if (!Number.isInteger(n)) { throw new Error('Select a CCSID number such as 37 or 1208.'); }
  return CCSIDS[n] ? `CCSID ${n}: ${CCSIDS[n]}` : `CCSID ${n}: not in Vanthrex's list of common CCSIDs — see IBM's CCSID table in the IBM i documentation.`;
}

const MSGF: [RegExp, string][] = [[/^CP[ADFI]/, 'QCPFMSG'], [/^MCH/, 'QCPFMSG'], [/^CEE/, 'QCEEMSG'], [/^RN[FQX]/, 'QRNXMSG'], [/^RNS/, 'QRNSMSG'], [/^SQL/, 'QSQLMSG'], [/^SQ[0-9]/, 'QSQLMSG'],
  [/^TCP/, 'QTCPMSGF'], [/^CZ[MS]/, 'QCPFMSG'], [/^LNC/, 'QCBLLEMSG'], [/^CAE/, 'QCAEMSG'], [/^PWS/, 'QIWSMSG'], [/^KBD/, 'QCPFMSG'], [/^CPC/, 'QCPFMSG']];
/** The command that shows a message description: DSPMSGD RANGE(CPF9801) MSGF(QCPFMSG). */
export function messageCommand(text: string): string {
  const id = text.trim().toUpperCase();
  if (!/^[A-Z]{2,3}[0-9A-F]{4,5}$/.test(id)) { throw new Error('Put the cursor on a message ID such as CPF9801, RNX1211 or SQL0204.'); }
  const f = MSGF.find(([r]) => r.test(id))?.[1] ?? 'QCPFMSG';
  return `DSPMSGD RANGE(${id}) MSGF(${f})`;
}

/** SQL type → RPG free-form type: DECIMAL(9,2) → packed(9:2), VARCHAR(50) → varchar(50)… */
export function sqlToRpgType(text: string): string {
  return text.replace(/\b(DECIMAL|DEC|NUMERIC|CHAR|CHARACTER|VARCHAR|CHARACTER\s+VARYING|INTEGER|INT|SMALLINT|BIGINT|DATE|TIME|TIMESTAMP|DOUBLE|REAL|FLOAT|GRAPHIC|VARGRAPHIC|BLOB|CLOB)\b\s*(\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\))?/gi,
    (_m, t: string, _p, a?: string, b?: string) => {
      const u = t.toUpperCase().replace(/\s+/g, ' ');
      if (/^(DECIMAL|DEC)$/.test(u)) { return `packed(${a ?? 5}:${b ?? 0})`; }
      if (u === 'NUMERIC') { return `zoned(${a ?? 5}:${b ?? 0})`; }
      if (/^(CHAR|CHARACTER)$/.test(u)) { return `char(${a ?? 1})`; }
      if (/^(VARCHAR|CHARACTER VARYING)$/.test(u)) { return `varchar(${a ?? 1})`; }
      if (/^(INTEGER|INT)$/.test(u)) { return 'int(10)'; } if (u === 'SMALLINT') { return 'int(5)'; } if (u === 'BIGINT') { return 'int(20)'; }
      if (u === 'DATE') { return 'date'; } if (u === 'TIME') { return 'time'; } if (u === 'TIMESTAMP') { return 'timestamp'; }
      if (/^(DOUBLE|FLOAT)$/.test(u)) { return 'float(8)'; } if (u === 'REAL') { return 'float(4)'; }
      if (u === 'GRAPHIC') { return `graph(${a ?? 1})`; } if (u === 'VARGRAPHIC') { return `vargraph(${a ?? 1})`; }
      return `sqltype(${u.toLowerCase()}${a ? ': ' + a : ''})`;
    });
}
/** RPG free-form type → SQL type: packed(9:2) → DECIMAL(9, 2), int(10) → INTEGER… */
export function rpgToSqlType(text: string): string {
  return text.replace(/\b(packed|zoned|char|varchar|int|uns|date|time|timestamp|ind|float|graph|vargraph)\b\s*(\(\s*(\d+)\s*(?::\s*(\d+))?[^)]*\))?/gi,
    (_m, t: string, _p, a?: string, b?: string) => {
      const u = t.toLowerCase();
      if (u === 'packed') { return `DECIMAL(${a ?? 5}, ${b ?? 0})`; } if (u === 'zoned') { return `NUMERIC(${a ?? 5}, ${b ?? 0})`; }
      if (u === 'char') { return `CHAR(${a ?? 1})`; } if (u === 'varchar') { return `VARCHAR(${a ?? 1})`; }
      if (u === 'int' || u === 'uns') { return ({ '3': 'SMALLINT', '5': 'SMALLINT', '10': 'INTEGER', '20': 'BIGINT' } as Record<string, string>)[a ?? '10'] ?? 'INTEGER'; }
      if (u === 'date') { return 'DATE'; } if (u === 'time') { return 'TIME'; } if (u === 'timestamp') { return 'TIMESTAMP'; } if (u === 'ind') { return 'CHAR(1)'; }
      if (u === 'float') { return a === '4' ? 'REAL' : 'DOUBLE'; } if (u === 'graph') { return `GRAPHIC(${a ?? 1})`; } return `VARGRAPHIC(${a ?? 1})`;
    });
}

/** Seconds as h:mm:ss (and the other way round): 3725 → 1:02:05, 1:02:05 → 3725. */
export function duration(text: string): string {
  const t = text.trim();
  if (/^\d+(\.\d+)?$/.test(t)) { const s = Math.round(Number(t)); return `${Math.floor(s / 3600)}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`; }
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (m) { return String(Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])); }
  throw new Error('Select a number of seconds or a duration such as 1:02:05.');
}

/** Storage and range of a numeric type: packed(9:2) → 5 bytes, from -9999999.99 to 9999999.99. */
export function numericInfo(text: string): string {
  const m = /\b(packed|zoned|int|uns|bindec|decimal|numeric|dec)\s*\(\s*(\d+)\s*(?:[:,]\s*(\d+))?\s*\)/i.exec(text);
  if (!m) { throw new Error('Select a numeric type such as packed(9:2), zoned(7:0), int(10) or DECIMAL(11, 2).'); }
  const t = m[1].toLowerCase(); const n = Number(m[2]); const d = Number(m[3] ?? 0);
  if (t === 'int' || t === 'uns') {
    const bytes = ({ 3: 1, 5: 2, 10: 4, 20: 8 } as Record<number, number>)[n]; if (!bytes) { throw new Error('int and uns take 3, 5, 10 or 20 digits.'); }
    const max = t === 'uns' ? (2n ** BigInt(bytes * 8)) - 1n : (2n ** BigInt(bytes * 8 - 1)) - 1n; const min = t === 'uns' ? 0n : -(max + 1n);
    return `${t}(${n}): ${bytes} byte(s), from ${min} to ${max}`;
  }
  if (d > n) { throw new Error('More decimal positions than digits.'); }
  const bytes = /^(packed|decimal|dec)$/.test(t) ? Math.floor(n / 2) + 1 : t === 'bindec' ? (n <= 4 ? 2 : n <= 9 ? 4 : 8) : n;
  const max = (n - d ? '9'.repeat(n - d) : '0') + (d ? '.' + '9'.repeat(d) : '');
  return `${t}(${n}:${d}): ${bytes} byte(s), from -${max} to ${max}`;
}
