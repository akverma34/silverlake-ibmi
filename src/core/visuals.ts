// Visual insights: the Library Space Map (a treemap of every object in a library, sized by disk space) and the Batch
// Job Timeline (each batch job as a bar on a time axis, one lane per overlapping run). Pure functions (no vscode
// import), unit tested; the webviews only draw what these return.
import { JobRun } from './jobHistory';
import { isValidSystemName } from './util';

// ---------------------------------------------------------------- Library Space Map

export interface SpaceObject { name: string; type: string; attribute: string; size: number; text: string; lastUsedDays?: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** One row per object of a library: name, type, attribute, size, text and days since last used (null = never). */
export function spaceMapSql(library: string): string {
  const l = library.trim().toUpperCase();
  if (!isValidSystemName(l)) { throw new Error(`"${library}" is not a valid library name.`); }
  // Source physical files have attribute PF like data files; SYSTABLES (FILE_TYPE 'S') tells them apart.
  return `SELECT O.OBJNAME AS NAME, O.OBJTYPE AS TYPE, CASE WHEN T.FILE_TYPE = 'S' THEN 'PF-SRC' ELSE COALESCE(O.OBJATTRIBUTE, '') END AS ATTR, ` +
    `COALESCE(O.OBJSIZE, 0) AS SIZE, COALESCE(O.OBJTEXT, '') AS TEXT, DAYS(CURRENT DATE) - DAYS(O.LAST_USED_TIMESTAMP) AS UNUSED ` +
    `FROM TABLE(QSYS2.OBJECT_STATISTICS('${l}', '*ALL')) O LEFT JOIN QSYS2.SYSTABLES T ` +
    `ON O.OBJTYPE = '*FILE' AND T.SYSTEM_TABLE_SCHEMA = '${l}' AND T.SYSTEM_TABLE_NAME = O.OBJNAME ` +
    `ORDER BY O.OBJSIZE DESC FETCH FIRST 5000 ROWS ONLY`;
}

export type SpaceGroup = 'Programs' | 'Files' | 'Source files' | 'Save files' | 'Journals' | 'Data' | 'Other';
export const SPACE_GROUPS: SpaceGroup[] = ['Programs', 'Files', 'Source files', 'Save files', 'Journals', 'Data', 'Other'];

/** The colour group of an object: programs, physical/logical files, source files, save files, journals, data objects. */
export function spaceGroup(type: string, attribute: string): SpaceGroup {
  const t = type.trim().toUpperCase(); const a = attribute.trim().toUpperCase();
  if (['*PGM', '*SRVPGM', '*MODULE', '*CMD', '*BNDDIR', '*SQLPKG'].includes(t)) { return 'Programs'; }
  if (t === '*FILE') { return a === 'SAVF' ? 'Save files' : a.startsWith('PF-SRC') || a === 'SRC' ? 'Source files' : 'Files'; }
  if (t === '*JRN' || t === '*JRNRCV') { return 'Journals'; }
  if (['*DTAARA', '*DTAQ', '*USRSPC', '*USRIDX', '*USRQ', '*MSGF', '*MSGQ'].includes(t)) { return 'Data'; }
  return 'Other';
}

/** Age band for the "last used" colouring: 0 used this month … 3 not used for over a year or never. */
export function ageBand(days: number | undefined): 0 | 1 | 2 | 3 {
  if (days === undefined || days === null || !isFinite(days)) { return 3; }
  return days <= 30 ? 0 : days <= 180 ? 1 : days <= 365 ? 2 : 3;
}

/** Totals per group, biggest first (empty groups left out). */
export function spaceSummary(objects: SpaceObject[]): { group: SpaceGroup; size: number; count: number }[] {
  const m = new Map<SpaceGroup, { size: number; count: number }>();
  for (const o of objects) {
    const g = spaceGroup(o.type, o.attribute); const v = m.get(g) ?? { size: 0, count: 0 };
    v.size += Math.max(0, o.size); v.count++; m.set(g, v);
  }
  return [...m.entries()].map(([group, v]) => ({ group, ...v })).sort((a, b) => b.size - a.size);
}

const worst = (row: number[], side: number): number => {
  const s = row.reduce((a, b) => a + b, 0);
  if (s <= 0) { return Infinity; }
  const max = Math.max(...row); const min = Math.min(...row);
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
};

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): one rectangle per value, in the same order, filling x/y/w/h with
 * tiles as close to square as possible. Values of 0 or less get an empty rectangle.
 */
export function squarify(values: number[], x: number, y: number, w: number, h: number): Rect[] {
  const out: Rect[] = values.map(() => ({ x, y, w: 0, h: 0 }));
  const idx = values.map((v, i) => i).filter(i => values[i] > 0).sort((a, b) => values[b] - values[a]);
  const total = idx.reduce((a, i) => a + values[i], 0);
  if (!idx.length || w <= 0 || h <= 0 || total <= 0) { return out; }
  const scale = (w * h) / total;
  let rx = x; let ry = y; let rw = w; let rh = h; let i = 0;
  while (i < idx.length) {
    const side = Math.min(rw, rh);
    const row: number[] = [idx[i]]; let areas = [values[idx[i]] * scale]; i++;
    while (i < idx.length) {
      const next = [...areas, values[idx[i]] * scale];
      if (worst(next, side) > worst(areas, side)) { break; }
      areas = next; row.push(idx[i]); i++;
    }
    const sum = areas.reduce((a, b) => a + b, 0);
    if (rw >= rh) {
      const cw = sum / rh; let cy = ry;
      row.forEach((k, j) => { const ch = areas[j] / cw; out[k] = { x: rx, y: cy, w: cw, h: ch }; cy += ch; });
      rx += cw; rw -= cw;
    } else {
      const ch = sum / rw; let cx = rx;
      row.forEach((k, j) => { const cw = areas[j] / ch; out[k] = { x: cx, y: ry, w: cw, h: ch }; cx += cw; });
      ry += ch; rh -= ch;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Batch Job Timeline

const NAME = /^[A-Z$#@*][A-Z0-9$#@_.*]{0,9}$/;

/** Job start (CPF1124) and end (CPF1164) messages of the last hours, with the server's current time on every row. */
export function timelineSql(hours: number, opts: { user?: string; jobName?: string } = {}): string {
  const h = Math.max(1, Math.min(24 * 31, Math.floor(hours)));
  const u = opts.user?.trim().toUpperCase(); const j = opts.jobName?.trim().toUpperCase();
  if (u && !NAME.test(u)) { throw new Error(`"${opts.user}" is not a valid user name.`); }
  if (j && !NAME.test(j)) { throw new Error(`"${opts.jobName}" is not a valid job name.`); }
  const like = (v: string | undefined) => v ? v.replace(/\*/g, '%') : '%';
  return `SELECT MESSAGE_ID AS ID, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, FROM_JOB AS JOB, COALESCE(MESSAGE_TEXT, '') AS TEXT, ` +
    `VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS NOW ` +
    `FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => CURRENT TIMESTAMP - ${h} HOURS)) H WHERE MESSAGE_ID IN ('CPF1124', 'CPF1164') ` +
    `AND FROM_JOB LIKE '%/${like(u)}/${like(j)}' ORDER BY MESSAGE_TIMESTAMP FETCH FIRST 20000 ROWS ONLY`;
}

/** "YYYY-MM-DD HH:MM:SS" (server time, no zone) as milliseconds; the same reading is used everywhere, so it stays consistent. */
export const tsMillis = (s: string): number => new Date(s.trim().replace(' ', 'T') + 'Z').getTime();

export interface TimelineBar { job: string; name: string; user: string; lane: number; x: number; w: number; state: 'ok' | 'failed' | 'running' | 'unknown'; started?: string; ended?: string; seconds?: number; cpuSeconds?: number; endCode?: number }
export interface Tick { x: number; label: string; day: boolean }

/**
 * Bars for a timeline of `width` pixels from `start` to `end` (ms). A run with no start began before the window; one
 * with no end is still running. Overlapping runs go on separate lanes (first lane that is free again). Bars are at
 * least `minWidth` wide so short jobs can still be clicked.
 */
export function timelineLayout(runs: JobRun[], start: number, end: number, width: number, minWidth = 3): { bars: TimelineBar[]; lanes: number } {
  const span = Math.max(1, end - start);
  const px = (t: number) => ((Math.min(end, Math.max(start, t)) - start) / span) * width;
  const items = runs
    .map(r => ({ r, s: r.started ? tsMillis(r.started) : start, e: r.ended ? tsMillis(r.ended) : end }))
    .filter(v => isFinite(v.s) && isFinite(v.e) && v.e >= start && v.s <= end)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const laneEnd: number[] = [];
  const bars = items.map(({ r, s, e }) => {
    const x = px(s); const w = Math.max(minWidth, px(e) - x);
    let lane = laneEnd.findIndex(le => le <= x);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
    laneEnd[lane] = x + w + 1;
    const parts = r.job.split('/');
    const state: TimelineBar['state'] = !r.ended ? 'running' : r.ok === false ? 'failed' : r.ok ? 'ok' : 'unknown';
    return { job: r.job, name: parts[2] ?? r.job, user: parts[1] ?? '', lane, x, w, state, started: r.started, ended: r.ended, seconds: r.seconds, cpuSeconds: r.cpuSeconds, endCode: r.endCode };
  });
  return { bars, lanes: laneEnd.length };
}

/** Gridline ticks every 1, 2, 3, 6, 12 or 24 hours so there are at most `maxTicks`; day ticks fall on midnight. */
export function timeTicks(start: number, end: number, width: number, maxTicks = 12): Tick[] {
  const H = 3600000; const span = Math.max(1, end - start);
  const step = [1, 2, 3, 6, 12, 24, 48, 168].find(s => span / (s * H) <= maxTicks) ?? 168;
  const out: Tick[] = [];
  for (let t = Math.ceil(start / (step * H)) * step * H; t <= end; t += step * H) {
    const d = new Date(t); const day = d.getUTCHours() === 0;
    const hh = String(d.getUTCHours()).padStart(2, '0');
    out.push({ x: ((t - start) / span) * width, label: day ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` : `${hh}:00`, day });
  }
  return out;
}
