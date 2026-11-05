// Platform insights that Code for IBM i and Db2 for i users reach for elsewhere: the security audit journal (QAUDJRN)
// hour by hour, the disk units of each ASP, the run statistics of the embedded SQL statements in programs
// (SYSPROGRAMSTMTSTAT), and VS Code tasks that run CL or PASE commands on the IBM i.
// Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

const hoursIn = (hours: number) => Math.max(1, Math.min(168, Math.floor(hours) || 24));

// ---------------------------------------------------------------- Security audit journal

export type AuditSeverity = 'alert' | 'change' | 'info';

/** QAUDJRN entry types (journal code T) with a short description and how much a security officer cares. */
export const AUDIT_TYPES: Record<string, [string, AuditSeverity]> = {
  AF: ['Authority failure', 'alert'], PW: ['Sign-on or password failure', 'alert'], VP: ['Network password error', 'alert'],
  DS: ['DST password reset', 'alert'], IM: ['Intrusion detected', 'alert'],
  CA: ['Authority change', 'change'], CP: ['User profile changed', 'change'], OW: ['Ownership change', 'change'],
  PG: ['Primary group change', 'change'], SV: ['System value changed', 'change'], AD: ['Auditing changed', 'change'],
  DO: ['Object deleted', 'change'], OM: ['Object moved or renamed', 'change'], OR: ['Object restored', 'change'],
  RA: ['Authority change on restore', 'change'], RO: ['Ownership change on restore', 'change'], RP: ['Adopting program restored', 'change'],
  RU: ['User authority restored', 'change'], PA: ['Program changed to adopt', 'change'], SE: ['Subsystem routing changed', 'change'],
  NA: ['Network attribute changed', 'change'], JD: ['Job description user changed', 'change'], EV: ['Environment variable changed', 'change'],
  SO: ['Server security data changed', 'change'], ST: ['Service tool used', 'change'], PF: ['PTF operation', 'change'],
  AX: ['Row or column access control changed', 'change'], SM: ['Systems management change', 'change'],
  CO: ['Object created', 'info'], ZC: ['Object changed', 'info'], ZR: ['Object read', 'info'], CD: ['Command run', 'info'],
  PS: ['Profile swap', 'info'], JS: ['Job start, end or change', 'info'], SF: ['Spooled file action', 'info'],
  GR: ['Function registration or exit point', 'info'], LD: ['Directory link or unlink', 'info'], SK: ['Socket connection', 'info'],
  X0: ['Network authentication', 'info'], VS: ['Server session', 'info'], PO: ['Printed output', 'info'],
  YC: ['Document changed', 'info'], YR: ['Document read', 'info'], DI: ['Directory server', 'info'],
};

const SEVERITY_ORDER: Record<AuditSeverity, number> = { alert: 0, change: 1, info: 2 };
export const auditType = (code: string): [string, AuditSeverity] => AUDIT_TYPES[code.trim().toUpperCase()] ?? ['Other entry', 'info'];

const auditJournal = (hours: number, types?: string) =>
  `TABLE(QSYS2.DISPLAY_JOURNAL('QSYS', 'QAUDJRN', STARTING_RECEIVER_NAME => '*CURCHAIN', ` +
  `STARTING_TIMESTAMP => CURRENT TIMESTAMP - ${hoursIn(hours)} HOURS, JOURNAL_CODES => 'T'${types ? `, JOURNAL_ENTRY_TYPES => '${types}'` : ''})) J`;

/** Audit entries counted per entry type and hour (the server does the counting). */
export function auditActivitySql(hours: number): string {
  const hr = `VARCHAR_FORMAT(ENTRY_TIMESTAMP, 'YYYY-MM-DD HH24')`;
  return `SELECT JOURNAL_ENTRY_TYPE AS TYPE, ${hr} AS HR, COUNT(*) AS N, MAX(VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYYY-MM-DD HH24')) AS NOW ` +
    `FROM ${auditJournal(hours)} GROUP BY JOURNAL_ENTRY_TYPE, ${hr} ORDER BY 1, 2`;
}

/** The users with the most audit entries, with their authority and sign-on failures. */
export function auditUsersSql(hours: number, top = 25): string {
  return `SELECT COALESCE("CURRENT_USER", JOB_USER) AS USR, COUNT(*) AS N, ` +
    `SUM(CASE WHEN JOURNAL_ENTRY_TYPE = 'AF' THEN 1 ELSE 0 END) AS AF, SUM(CASE WHEN JOURNAL_ENTRY_TYPE IN ('PW', 'VP') THEN 1 ELSE 0 END) AS PW, ` +
    `SUM(CASE WHEN JOURNAL_ENTRY_TYPE IN ('CA', 'CP', 'OW', 'PG', 'SV', 'AD', 'DO') THEN 1 ELSE 0 END) AS CHG ` +
    `FROM ${auditJournal(hours)} GROUP BY COALESCE("CURRENT_USER", JOB_USER) ORDER BY 2 DESC FETCH FIRST ${Math.max(1, Math.floor(top))} ROWS ONLY`;
}

/** The latest security-relevant entries (failures and changes to authority, profiles and system values). */
export function auditEventsSql(hours: number, max = 200): string {
  const types = Object.entries(AUDIT_TYPES).filter(([, [, s]]) => s !== 'info').map(([k]) => k).join(' ');
  return `SELECT VARCHAR_FORMAT(ENTRY_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, JOURNAL_ENTRY_TYPE AS TYPE, ` +
    `COALESCE("CURRENT_USER", '') AS USR, TRIM(JOB_NUMBER) || '/' || TRIM(JOB_USER) || '/' || TRIM(JOB_NAME) AS JOB, ` +
    `COALESCE(TRIM(PROGRAM_LIBRARY) || '/' || TRIM(PROGRAM_NAME), '') AS PGM ` +
    `FROM ${auditJournal(hours, types)} ORDER BY ENTRY_TIMESTAMP DESC FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

export interface AuditRow { type: string; label: string; severity: AuditSeverity; total: number; cells: number[] }

/** One row per entry type (alerts first, then changes, then the rest; busiest first in each), one cell per hour. */
export function auditHeat(rows: { TYPE: string; HR: string; N: number }[], buckets: string[]): { rows: AuditRow[]; max: number; bySeverity: Record<AuditSeverity, number> } {
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const m = new Map<string, AuditRow>();
  for (const r of rows) {
    const k = String(r.TYPE ?? '').trim().toUpperCase(); const i = idx.get(String(r.HR ?? '').trim());
    if (!k || i === undefined) { continue; }
    const [label, severity] = auditType(k);
    const v = m.get(k) ?? { type: k, label, severity, total: 0, cells: buckets.map(() => 0) };
    const n = Number(r.N) || 0; v.total += n; v.cells[i] += n; m.set(k, v);
  }
  const out = [...m.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.total - a.total || a.type.localeCompare(b.type));
  const bySeverity: Record<AuditSeverity, number> = { alert: 0, change: 0, info: 0 };
  for (const r of out) { bySeverity[r.severity] += r.total; }
  return { rows: out, max: Math.max(0, ...out.flatMap(r => r.cells)), bySeverity };
}

// ---------------------------------------------------------------- Disk units

/** Every disk unit with its ASP, capacity, free space, % used and % busy since the statistics were last reset. */
export function diskUnitsSql(): string {
  return `SELECT ASP_NUMBER AS ASP, UNIT_NUMBER AS UNIT, COALESCE(RESOURCE_NAME, '') AS RES, COALESCE(DISK_TYPE, '') AS DTYPE, ` +
    `COALESCE(DISK_MODEL, '') AS MODEL, COALESCE(UNIT_TYPE, 0) AS SSD, COALESCE(UNIT_STORAGE_CAPACITY, 0) AS CAP, ` +
    `COALESCE(UNIT_SPACE_AVAILABLE, 0) AS AVAIL, COALESCE(PERCENT_USED, 0) AS PCT, COALESCE(ELAPSED_PERCENT_BUSY, 0) AS BUSY ` +
    `FROM QSYS2.SYSDISKSTAT ORDER BY ASP_NUMBER, UNIT_NUMBER`;
}

export interface DiskUnit { asp: number; unit: number; resource: string; type: string; model: string; ssd: boolean; capacity: number; available: number; pctUsed: number; pctBusy: number }
export type Level = 'ok' | 'warn' | 'bad';

/** Fill level of a unit or ASP: 90 % and more is critical (the system slows down and may stop near 100 %). */
export const fillLevel = (pct: number): Level => pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
/** Busy level of a disk arm: above 40 % the waits for disk start to grow. */
export const busyLevel = (pct: number): Level => pct >= 60 ? 'bad' : pct >= 40 ? 'warn' : 'ok';

export interface AspSummary { asp: number; units: DiskUnit[]; capacity: number; used: number; pctUsed: number; spread: number; busiest: number; ssd: number }

/** Per ASP: total capacity and use, and how unevenly the units are filled (a spread over 10 points asks for STRASPBAL). */
export function aspSummary(units: DiskUnit[]): AspSummary[] {
  const m = new Map<number, DiskUnit[]>();
  for (const u of units) { m.set(u.asp, [...(m.get(u.asp) ?? []), u]); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([asp, us]) => {
    const capacity = us.reduce((s, u) => s + u.capacity, 0);
    const used = us.reduce((s, u) => s + Math.max(0, u.capacity - u.available), 0);
    const pcts = us.map(u => u.pctUsed);
    return {
      asp, units: [...us].sort((a, b) => a.unit - b.unit), capacity, used,
      pctUsed: capacity ? Math.round(used / capacity * 1000) / 10 : 0,
      spread: Math.round((Math.max(...pcts) - Math.min(...pcts)) * 10) / 10,
      busiest: Math.max(0, ...us.map(u => u.pctBusy)), ssd: us.filter(u => u.ssd).length,
    };
  });
}

/** Bytes as GB or TB. */
export function sizeLabel(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1024 ? `${(gb / 1024).toFixed(2)} TB` : `${gb >= 100 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
}

// ---------------------------------------------------------------- Embedded SQL statement statistics

/** The statement statistics of the programs and service programs of a library (columns differ by release, so all are read). */
export function programStatementsSql(library: string, program?: string): string {
  const l = library.trim().toUpperCase();
  if (!isValidSystemName(l)) { throw new Error(`"${library}" is not a valid library name.`); }
  const p = program?.trim().toUpperCase();
  if (p && !isValidSystemName(p)) { throw new Error(`"${program}" is not a valid program name.`); }
  return `SELECT * FROM QSYS2.SYSPROGRAMSTMTSTAT WHERE PROGRAM_SCHEMA = '${l}'${p ? ` AND PROGRAM_NAME = '${p}'` : ''}`;
}

export interface StatementStat { program: string; type: string; module: string; statement: number; executions: number; totalMs: number | null; avgMs: number | null; maxMs: number | null; rebuilds: number | null; text: string }

const pick = (r: Record<string, unknown>, names: string[]): unknown => { for (const n of names) { if (r[n] !== undefined && r[n] !== null) { return r[n]; } } return undefined; };
const numOrNull = (v: unknown): number | null => { if (v === undefined || v === null || v === '') { return null; } const n = Number(v); return isFinite(n) ? n : null; };

/**
 * Statements with their numbers whatever the release calls the columns; slowest in total first (most run first when
 * the release has no times). Elapsed times are reported in milliseconds.
 */
export function statementStats(rows: Record<string, unknown>[]): { stats: StatementStat[]; hasTimes: boolean } {
  const stats = rows.map(r => {
    const total = numOrNull(pick(r, ['TOTAL_ELAPSED_TIME', 'ELAPSED_TIME_TOTAL']));
    const executions = numOrNull(pick(r, ['NUMBER_TIMES_EXECUTED', 'NUMBER_EXECUTIONS', 'TIMES_EXECUTED'])) ?? 0;
    const avg = numOrNull(pick(r, ['AVERAGE_ELAPSED_TIME', 'ELAPSED_TIME_AVERAGE'])) ?? (total !== null && executions ? total / executions : null);
    return {
      program: String(pick(r, ['PROGRAM_NAME']) ?? '').trim(), type: String(pick(r, ['PROGRAM_TYPE']) ?? '').trim(),
      module: String(pick(r, ['MODULE_NAME']) ?? '').trim(), statement: numOrNull(pick(r, ['STATEMENT_NUMBER'])) ?? 0,
      executions, totalMs: total, avgMs: avg === null ? null : Math.round(avg * 100) / 100,
      maxMs: numOrNull(pick(r, ['MAXIMUM_ELAPSED_TIME', 'ELAPSED_TIME_MAXIMUM'])),
      rebuilds: numOrNull(pick(r, ['NUMBER_REBUILDS', 'NUMBER_TIMES_REBUILT'])),
      text: String(pick(r, ['STATEMENT_TEXT']) ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
  const hasTimes = stats.some(s => s.totalMs !== null);
  stats.sort((a, b) => (hasTimes ? (b.totalMs ?? 0) - (a.totalMs ?? 0) : 0) || b.executions - a.executions || a.program.localeCompare(b.program) || a.statement - b.statement);
  return { stats, hasTimes };
}

/** A short hint on a statement: never run, rebuilt often, or a SELECT * that reads every column. */
export function statementHint(s: StatementStat): string {
  if (!s.executions) { return 'Never run since the statistics were collected'; }
  if (s.rebuilds !== null && s.rebuilds > 0 && s.rebuilds >= s.executions / 2) { return 'Access plan rebuilt on most runs'; }
  if (/\bSELECT\s+\*/i.test(s.text)) { return 'SELECT * reads every column'; }
  return '';
}

// ---------------------------------------------------------------- VS Code tasks

export interface IbmiTaskDefinition { type: 'vanthrex'; command: string; kind?: 'cl' | 'pase'; libraries?: string[]; cwd?: string }

/** The definition of a "vanthrex" task checked and normalised, or the reason it cannot run. */
export function checkTask(def: Record<string, unknown>): { ok: true; task: Required<Omit<IbmiTaskDefinition, 'cwd'>> & { cwd?: string } } | { ok: false; error: string } {
  const command = typeof def.command === 'string' ? def.command.trim() : '';
  if (!command) { return { ok: false, error: 'The task has no "command".' }; }
  const kind = def.kind === undefined ? 'cl' : def.kind;
  if (kind !== 'cl' && kind !== 'pase') { return { ok: false, error: '"kind" must be "cl" or "pase".' }; }
  const libs = def.libraries === undefined ? [] : def.libraries;
  if (!Array.isArray(libs) || libs.some(l => typeof l !== 'string' || !isValidSystemName(l.trim()))) { return { ok: false, error: '"libraries" must be a list of library names.' }; }
  const cwd = typeof def.cwd === 'string' && def.cwd.trim() ? def.cwd.trim() : undefined;
  if (cwd !== undefined && !cwd.startsWith('/')) { return { ok: false, error: '"cwd" must be an IFS path that starts with /.' }; }
  return { ok: true, task: { type: 'vanthrex', command, kind, libraries: (libs as string[]).map(l => l.trim().toUpperCase()), ...(cwd ? { cwd } : {}) } };
}

export interface TaskVariables { CURLIB?: string; USER?: string; HOST?: string; NAME?: string; EXT?: string; FILENAME?: string; RELATIVEPATH?: string }

/**
 * Replaces the Code for IBM i style variables (&CURLIB, &USER, &HOST, &NAME, &EXT, &FILENAME, &RELATIVEPATH) in a
 * task command; the longest names first, so &NAME does not eat the start of another variable. Unknown ones stay.
 */
export function expandTaskVariables(command: string, vars: TaskVariables): string {
  const keys = (Object.keys(vars) as (keyof TaskVariables)[]).filter(k => vars[k] !== undefined).sort((a, b) => b.length - a.length);
  if (!keys.length) { return command; }
  return command.replace(new RegExp(`&(${keys.join('|')})\\b`, 'g'), (_, k: keyof TaskVariables) => String(vars[k]));
}

/** Variables for the file open in the editor: NAME is the upper-case base name (at most 10 characters), EXT its extension. */
export function fileVariables(relativePath: string): Pick<TaskVariables, 'NAME' | 'EXT' | 'FILENAME' | 'RELATIVEPATH'> {
  const rel = relativePath.replace(/\\/g, '/');
  const file = rel.split('/').pop() ?? '';
  const dot = file.indexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  return { NAME: base.toUpperCase().slice(0, 10), EXT: dot > 0 ? file.slice(dot + 1).toUpperCase() : '', FILENAME: file, RELATIVEPATH: rel };
}

/** A terminal shows "\r\n" line ends only. */
export const terminalText = (s: string): string => s.replace(/\r?\n/g, '\r\n');
