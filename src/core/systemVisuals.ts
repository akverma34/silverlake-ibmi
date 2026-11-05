// Visual system pages for developers: the Active Jobs Map (every active job as a tile inside its subsystem, sized by
// CPU, temporary storage or threads, red when it waits for a reply) and the Journal Activity Heat Map (which tables
// a journal saw change, hour by hour, split in inserts, updates and deletes). Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

const name = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

// ---------------------------------------------------------------- Active Jobs Map

/** Every active job with what the map needs (no statistics reset, so it is cheap and does not disturb WRKACTJOB). */
export function activeJobsMapSql(max = 5000): string {
  return `SELECT JOB_NAME AS JOB, COALESCE(SUBSYSTEM, '') AS SBS, COALESCE(AUTHORIZATION_NAME, '') AS USR, COALESCE(JOB_TYPE, '') AS TYPE, ` +
    `COALESCE(JOB_STATUS, '') AS STATUS, COALESCE(FUNCTION, '') AS FN, COALESCE(CPU_TIME, 0) AS CPU, COALESCE(TEMPORARY_STORAGE, 0) AS TMP, ` +
    `COALESCE(THREAD_COUNT, 1) AS THREADS, COALESCE(TOTAL_DISK_IO_COUNT, 0) AS IO ` +
    `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) A FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

export type JobState = 'reply' | 'running' | 'lock' | 'waiting' | 'held' | 'other';
export const JOB_STATES: JobState[] = ['reply', 'lock', 'running', 'waiting', 'held', 'other'];

/** Status group of a WRKACTJOB status: MSGW → waiting for a reply, RUN → running, LCKW… → lock wait. */
export function jobState(status: string): JobState {
  const s = status.trim().toUpperCase();
  if (s === 'MSGW') { return 'reply'; }
  if (s === 'RUN' || s === 'CMTW' || s === 'TRNS') { return 'running'; }
  if (/^(LCKW|LSPW|JVAW|MTXW|SEMW|MLTW)$/.test(s)) { return 'lock'; }
  if (/^(HLD|HLDT|SRQ|SRQT|SIGS)$/.test(s)) { return 'held'; }
  if (/W$|^(EVTW|DEQW|TIMW|SELW|ICFW|CNDW|OSIW|DSPW|THDW)$/.test(s)) { return 'waiting'; }
  return 'other';
}

export interface ActiveJob { job: string; subsystem: string; user: string; type: string; status: string; fn: string; cpuMs: number; tempMb: number; threads: number; io: number }
export type JobMetric = 'cpu' | 'temp' | 'threads' | 'io';

export const jobValue = (j: ActiveJob, m: JobMetric): number => Math.max(0, m === 'cpu' ? j.cpuMs : m === 'temp' ? j.tempMb : m === 'threads' ? j.threads : j.io);

/** Jobs grouped by subsystem (system jobs without one under "(none)"), biggest group first; jobs biggest first in each. */
export function jobsBySubsystem(jobs: ActiveJob[], metric: JobMetric): { subsystem: string; value: number; jobs: ActiveJob[]; replies: number }[] {
  const m = new Map<string, ActiveJob[]>();
  for (const j of jobs) { const k = j.subsystem || '(none)'; m.set(k, [...(m.get(k) ?? []), j]); }
  return [...m.entries()].map(([subsystem, js]) => ({
    subsystem, jobs: [...js].sort((a, b) => jobValue(b, metric) - jobValue(a, metric)),
    value: js.reduce((s, j) => s + jobValue(j, metric), 0), replies: js.filter(j => jobState(j.status) === 'reply').length,
  })).sort((a, b) => b.value - a.value || b.jobs.length - a.jobs.length);
}

// ---------------------------------------------------------------- Journal Activity Heat Map

/**
 * Row changes recorded by a journal in the last hours, counted per table and hour: inserts (PT, PX), updates (UP —
 * the after image, so each update counts once) and deletes (DL, DR).
 */
export function journalActivitySql(journalLibrary: string, journal: string, hours: number): string {
  const l = name(journalLibrary, 'library'); const j = name(journal, 'journal');
  const h = Math.max(1, Math.min(168, Math.floor(hours)));
  const obj = `TRIM(SUBSTR(OBJECT, 11, 10)) || '/' || TRIM(SUBSTR(OBJECT, 1, 10))`;
  const hr = `VARCHAR_FORMAT(ENTRY_TIMESTAMP, 'YYYY-MM-DD HH24')`;
  return `SELECT ${obj} AS OBJ, ${hr} AS HR, ` +
    `SUM(CASE WHEN JOURNAL_ENTRY_TYPE IN ('PT', 'PX') THEN 1 ELSE 0 END) AS INS, ` +
    `SUM(CASE WHEN JOURNAL_ENTRY_TYPE = 'UP' THEN 1 ELSE 0 END) AS UPD, ` +
    `SUM(CASE WHEN JOURNAL_ENTRY_TYPE IN ('DL', 'DR') THEN 1 ELSE 0 END) AS DEL, ` +
    `MAX(VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYYY-MM-DD HH24')) AS NOW ` +
    `FROM TABLE(QSYS2.DISPLAY_JOURNAL('${l}', '${j}', STARTING_RECEIVER_NAME => '*CURCHAIN', STARTING_TIMESTAMP => CURRENT TIMESTAMP - ${h} HOURS, ` +
    `JOURNAL_CODES => 'R', JOURNAL_ENTRY_TYPES => 'PT PX UP DL DR')) J WHERE OBJECT IS NOT NULL ` +
    `GROUP BY ${obj}, ${hr} ORDER BY 1, 2`;
}

export interface HeatRow { table: string; total: number; ins: number; upd: number; del: number; cells: number[] }

/** "YYYY-MM-DD HH" labels of the `hours` hours that end with `now` (oldest first). */
export function hourBuckets(now: string, hours: number): string[] {
  const t = Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1, Number(now.slice(8, 10)), Number(now.slice(11, 13)));
  return Array.from({ length: hours }, (_, i) => new Date(t - (hours - 1 - i) * 3600000).toISOString().slice(0, 13).replace('T', ' '));
}

/** One row per table (busiest first, at most `top`), one cell per hour bucket, with the busiest cell for the colour scale. */
export function journalHeat(rows: { OBJ: string; HR: string; INS: number; UPD: number; DEL: number }[], buckets: string[], top = 30): { rows: HeatRow[]; max: number; others: number } {
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const m = new Map<string, HeatRow>();
  for (const r of rows) {
    const k = String(r.OBJ).trim(); const i = idx.get(String(r.HR).trim()); if (!k || i === undefined) { continue; }
    const v = m.get(k) ?? { table: k, total: 0, ins: 0, upd: 0, del: 0, cells: buckets.map(() => 0) };
    const ins = Number(r.INS) || 0; const upd = Number(r.UPD) || 0; const del = Number(r.DEL) || 0;
    v.ins += ins; v.upd += upd; v.del += del; v.total += ins + upd + del; v.cells[i] += ins + upd + del;
    m.set(k, v);
  }
  const all = [...m.values()].sort((a, b) => b.total - a.total || a.table.localeCompare(b.table));
  const shown = all.slice(0, top);
  return { rows: shown, max: Math.max(0, ...shown.flatMap(r => r.cells)), others: all.length - shown.length };
}

/** Colour level 0–5 of a cell on a square-root scale, so quiet hours stay visible next to a busy batch run. */
export function heatLevel(v: number, max: number): number {
  if (v <= 0 || max <= 0) { return 0; }
  return Math.max(1, Math.min(5, Math.ceil(Math.sqrt(v / max) * 5)));
}
