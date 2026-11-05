// More visual insights for developers: the Index Advisor (indexes the Db2 optimizer asked for, with the CREATE INDEX
// for each), the IFS Space Map (folder sizes as a treemap, drill down by click) and the Source Change Calendar (a year
// of member changes as a heat map, one square per day). Pure functions (no vscode import), unit tested.
import { isValidSystemName, sqlString } from './util';

const lib = (v: string, what = 'library'): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

// ---------------------------------------------------------------- Index Advisor

/** The optimizer's index advice for the tables of a library (QSYS2.SYSIXADV), most advised first. */
export function indexAdviceSql(library: string, table?: string): string {
  const l = lib(library);
  const t = table ? lib(table, 'table') : undefined;
  return `SELECT TABLE_SCHEMA AS SCHEMA, TABLE_NAME AS TAB, SYSTEM_TABLE_NAME AS SYSTAB, KEY_COLUMNS_ADVISED AS KEYS, ` +
    `COALESCE(LEADING_COLUMN_KEYS, 0) AS LEAD, INDEX_TYPE AS ITYPE, COALESCE(TIMES_ADVISED, 0) AS TIMES, ` +
    `VARCHAR_FORMAT(LAST_ADVISED, 'YYYY-MM-DD HH24:MI') AS LAST, COALESCE(MTI_USED, 0) AS MTI, ` +
    `COALESCE(ESTIMATED_CREATION_TIME, 0) AS EST, COALESCE(AVERAGE_QUERY_ESTIMATE, 0) AS AVGQ, COALESCE(REASON_ADVISED, '') AS REASON ` +
    `FROM QSYS2.SYSIXADV WHERE SYSTEM_TABLE_SCHEMA = '${l}'${t ? ` AND SYSTEM_TABLE_NAME = '${t}'` : ''} ` +
    `ORDER BY TIMES_ADVISED DESC, AVERAGE_QUERY_ESTIMATE DESC FETCH FIRST 500 ROWS ONLY`;
}

export interface Advice { schema: string; table: string; keys: string[]; type: 'RADIX' | 'EVI'; times: number; last: string; mti: number; estSeconds: number; avgQuerySeconds: number; reason: string }

const COL = /^("[^"]+"|[A-Z_$#@][A-Z0-9_$#@]*)$/i;

/** "A, B" or "A B" → ['A', 'B']; quoted names keep their case and spaces. */
export function adviceKeys(s: string): string[] {
  const out: string[] = []; const re = /"[^"]+"|[^\s,"]+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s ?? ''))) { out.push(m[0].startsWith('"') ? m[0] : m[0].toUpperCase()); }
  return out;
}

/**
 * Advice for the same table where one key list starts with another is merged into the longer one (an index on
 * (A, B) also serves queries that asked for (A)): times and query estimates are added up. Most valuable first —
 * times advised × average query estimate.
 */
export function condenseAdvice(list: Advice[]): (Advice & { covers: number; score: number })[] {
  const sorted = [...list].sort((a, b) => b.keys.length - a.keys.length);
  const out: (Advice & { covers: number; score: number })[] = [];
  for (const a of sorted) {
    const into = out.find(o => o.schema === a.schema && o.table === a.table && o.type === a.type && a.keys.every((k, i) => o.keys[i] === k));
    if (into) {
      into.avgQuerySeconds = (into.avgQuerySeconds * into.times + a.avgQuerySeconds * a.times) / Math.max(1, into.times + a.times);
      into.times += a.times; into.mti += a.mti; into.covers++;
      if (a.last > into.last) { into.last = a.last; }
    } else { out.push({ ...a, keys: [...a.keys], covers: 1, score: 0 }); }
  }
  for (const o of out) { o.score = o.times * Math.max(0.01, o.avgQuerySeconds); }
  return out.sort((a, b) => b.score - a.score || b.times - a.times);
}

/** The CREATE INDEX statement for one piece of advice; the name is TABLE_IXn (n from the caller), at most 128 long. */
export function createIndexSql(a: Pick<Advice, 'schema' | 'table' | 'keys' | 'type'>, n: number): string {
  const id = (v: string) => /^[A-Z_$#@][A-Z0-9_$#@]*$/.test(v) ? v : `"${v.replace(/"/g, '""')}"`;
  if (!a.keys.length || a.keys.some(k => !COL.test(k))) { throw new Error(`Unexpected key columns: ${a.keys.join(', ')}`); }
  const base = a.table.replace(/^"|"$/g, '');
  const name = id(`${base}_${a.type === 'EVI' ? 'EVI' : 'IX'}${n}`.slice(0, 128));
  const kind = a.type === 'EVI' ? 'CREATE ENCODED VECTOR INDEX' : 'CREATE INDEX';
  return `${kind} ${id(a.schema)}.${name} ON ${id(a.schema)}.${id(a.table)} (${a.keys.join(', ')})`;
}

// ---------------------------------------------------------------- IFS Space Map

const OMIT = ['/QSYS.LIB', '/QNTC', '/QFileSvr.400', '/QOPT', '/QDLS'];

/** Every stream file under a folder with its size (up to `max`). QSYS.LIB and the network file systems are left out unless asked for. */
export function ifsSizesSql(path: string, max = 50000): string {
  const p = normalizePath(path);
  const omit = OMIT.filter(o => !p.toUpperCase().startsWith(o.toUpperCase()));
  return `SELECT CAST(PATH_NAME AS VARCHAR(4000)) AS P, COALESCE(DATA_SIZE, 0) AS SZ ` +
    `FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(p)}, SUBTREE_DIRECTORIES => 'YES', OBJECT_TYPE_LIST => '*ALLSTMF'` +
    `${omit.length ? `, OMIT_LIST => ${sqlString(omit.join(' '))}` : ''})) X FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

export function normalizePath(path: string): string {
  const p = ('/' + path.trim()).replace(/\/+/g, '/').replace(/\/$/, '');
  if (p.split('/').includes('..')) { throw new Error(`"${path}" is not a valid path.`); }
  return p || '/';
}

export interface IfsChild { name: string; path: string; dir: boolean; size: number; files: number }

/** Sizes of the direct children of `base` (folders add up everything below them), biggest first. */
export function ifsChildren(base: string, files: { path: string; size: number }[]): IfsChild[] {
  const b = normalizePath(base); const prefix = b === '/' ? '/' : b + '/';
  const m = new Map<string, IfsChild>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) { continue; }
    const rest = f.path.slice(prefix.length); if (!rest) { continue; }
    const slash = rest.indexOf('/'); const name = slash < 0 ? rest : rest.slice(0, slash);
    const c = m.get(name) ?? { name, path: prefix + name, dir: slash >= 0, size: 0, files: 0 };
    c.size += Math.max(0, Number(f.size) || 0); c.files++; if (slash >= 0) { c.dir = true; }
    m.set(name, c);
  }
  return [...m.values()].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

/** Breadcrumb of a path: [{name:'/', path:'/'}, {name:'home', path:'/home'}, …]. */
export function breadcrumb(path: string): { name: string; path: string }[] {
  const p = normalizePath(path); const out = [{ name: '/', path: '/' }];
  let cur = '';
  for (const part of p.split('/').filter(Boolean)) { cur += '/' + part; out.push({ name: part, path: cur }); }
  return out;
}

// ---------------------------------------------------------------- Source Change Calendar

/** Source members of a library (or one source file) last changed in the last `days` days. */
export function memberChangesSql(library: string, file?: string, days = 371): string {
  const l = lib(library); const f = file ? lib(file, 'file') : undefined;
  const d = Math.max(1, Math.min(3700, Math.floor(days)));
  return `SELECT SYSTEM_TABLE_NAME AS F, SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, COALESCE(PARTITION_TEXT, '') AS X, ` +
    `VARCHAR_FORMAT(LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD') AS D, VARCHAR_FORMAT(LAST_SOURCE_UPDATE_TIMESTAMP, 'HH24:MI') AS H, ` +
    `VARCHAR_FORMAT(CURRENT DATE, 'YYYY-MM-DD') AS TODAY ` +
    `FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = '${l}'${f ? ` AND SYSTEM_TABLE_NAME = '${f}'` : ''} ` +
    `AND SOURCE_TYPE IS NOT NULL AND LAST_SOURCE_UPDATE_TIMESTAMP >= CURRENT TIMESTAMP - ${d} DAYS ` +
    `ORDER BY LAST_SOURCE_UPDATE_TIMESTAMP DESC FETCH FIRST 20000 ROWS ONLY`;
}

export interface DayCell { day: string; col: number; row: number; count: number; level: 0 | 1 | 2 | 3 | 4 }

const dayMs = 86400000;
const parseDay = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const fmtDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * A GitHub-style year: one column per week (Sunday on top), the last column holds `today`. Levels 1–4 split the
 * busy days into quarters of the busiest day, so one huge day does not hide the rest.
 */
export function calendarCells(counts: Map<string, number>, today: string, weeks = 53): { cells: DayCell[]; months: { col: number; label: string }[]; max: number } {
  const end = parseDay(today); const endDow = new Date(end).getUTCDay();
  const start = end - ((weeks - 1) * 7 + endDow) * dayMs;
  const max = Math.max(0, ...[...counts.entries()].filter(([d]) => { const t = parseDay(d); return t >= start && t <= end; }).map(([, c]) => c));
  const cells: DayCell[] = []; const months: { col: number; label: string }[] = [];
  const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let t = start, i = 0; t <= end; t += dayMs, i++) {
    const day = fmtDay(t); const col = Math.floor(i / 7); const row = i % 7; const count = counts.get(day) ?? 0;
    const level = count === 0 || max === 0 ? 0 : (Math.min(4, Math.ceil((count / max) * 4)) as 1 | 2 | 3 | 4);
    cells.push({ day, col, row, count, level });
    const d = new Date(t);
    if (d.getUTCDate() <= 7 && row === 0) { months.push({ col, label: NAMES[d.getUTCMonth()] }); }
  }
  return { cells, months, max };
}

/** Longest run of consecutive days with at least one change, and the current one (ending today or yesterday). */
export function streaks(counts: Map<string, number>, today: string): { longest: number; current: number } {
  const days = [...counts.entries()].filter(([, c]) => c > 0).map(([d]) => parseDay(d)).sort((a, b) => a - b);
  let longest = 0; let run = 0; let prev = NaN;
  for (const t of days) { run = t - prev === dayMs ? run + 1 : 1; longest = Math.max(longest, run); prev = t; }
  const set = new Set(days); let cur = 0; let t = parseDay(today);
  if (!set.has(t)) { t -= dayMs; }
  while (set.has(t)) { cur++; t -= dayMs; }
  return { longest, current: cur };
}
