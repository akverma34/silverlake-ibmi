// Pages built on IBM i services the extension did not use yet: network configuration, fix currency, hardware and
// devices, subsystem setup, save files and tapes, system diagnostics, security configuration and job internals.
// Column names differ a little between releases, so the queries read whole rows and these helpers pick the columns
// that are there. Pure functions (no vscode import), unit tested.

export type Row = Record<string, unknown>;
export type Flag = 'bad' | 'different' | undefined;

/** The SQL of every service the pages read (most are views read whole; their columns differ by release). */
export const SERVICE_SQL = {
  tcpip: `SELECT * FROM QSYS2.TCPIP_INFO`,
  networkAttributes: `SELECT * FROM QSYS2.NETWORK_ATTRIBUTE_INFO`,
  telnet: `SELECT * FROM QSYS2.TELNET_SERVER_ATTRIBUTES`,
  smtp: `SELECT * FROM QSYS2.SMTP_ATTRIBUTES`,
  timeProtocol: `SELECT * FROM QSYS2.TIME_PROTOCOL_INFO`,
  httpServers: `SELECT * FROM QSYS2.HTTP_SERVER_INFO`,
  rdbEntries: `SELECT * FROM QSYS2.RDB_ENTRY_INFO`,
  serverRouting: `SELECT * FROM QSYS2.SERVER_SBS_ROUTING`,
  firmware: `SELECT * FROM QSYS2.FIRMWARE_CURRENCY`,
  defectivePtfs: `SELECT * FROM QSYS2.DEFECTIVE_PTF_CURRENCY`,
  cves: `SELECT * FROM QSYS2.CVE_CURRENCY`,
  serviceAgent: `SELECT * FROM QSYS2.ELECTRONIC_SERVICE_AGENT_INFO`,
  configStatus: `SELECT * FROM QSYS2.CONFIGURATION_STATUS`,
  hardware: `SELECT * FROM QSYS2.HARDWARE_RESOURCE_INFO`,
  nvme: `SELECT * FROM QSYS2.NVME_INFO`,
  autostart: `SELECT * FROM QSYS2.AUTOSTART_JOB_INFO`,
  routing: `SELECT * FROM QSYS2.ROUTING_ENTRY_INFO`,
  prestart: `SELECT * FROM QSYS2.PRESTART_JOB_INFO`,
  commEntries: `SELECT * FROM QSYS2.COMMUNICATIONS_ENTRY_INFO`,
  workstations: `SELECT * FROM QSYS2.WORKSTATION_INFO`,
  jobQueueEntries: `SELECT * FROM QSYS2.JOB_QUEUE_ENTRIES`,
  subsystemPools: `SELECT * FROM QSYS2.SUBSYSTEM_POOL_INFO`,
  saveFiles: `SELECT * FROM QSYS2.SAVE_FILE_INFO FETCH FIRST 2000 ROWS ONLY`,
  tapes: `SELECT * FROM QSYS2.TAPE_CARTRIDGE_INFO`,
  mediaLibraries: `SELECT * FROM QSYS2.MEDIA_LIBRARY_INFO`,
  problems: `SELECT * FROM QSYS2.PROBLEM_INFO`,
  endedJobs: `SELECT * FROM TABLE(QSYS2.ENDED_JOB_INFO()) X FETCH FIRST 1000 ROWS ONLY`,
  tempStorage: `SELECT * FROM QSYS2.SYSTMPSTG`,
  watches: `SELECT * FROM QSYS2.WATCH_INFO`,
  collectionServices: `SELECT * FROM QSYS2.COLLECTION_SERVICES_INFO`,
  jvms: `SELECT * FROM QSYS2.JVM_INFO`,
  security: `SELECT * FROM QSYS2.SECURITY_INFO`,
  certificateUsage: `SELECT * FROM QSYS2.CERTIFICATE_USAGE_INFO`,
  exitPoints: `SELECT * FROM QSYS2.EXIT_POINT_INFO`,
} as const;
export type ServiceId = keyof typeof SERVICE_SQL;

const JOB = /^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i;
export const isJobName = (j: string): boolean => JOB.test(j.trim());

/** Open files, IFS objects in use and database connections of one job (the job name is checked first). */
export function jobServiceSql(kind: 'openFiles' | 'ifsObjects' | 'dbConnections', job: string): string | undefined {
  const j = job.trim().toUpperCase(); if (!JOB.test(j)) { return undefined; }
  const fn = { openFiles: 'OPEN_FILES', ifsObjects: 'IFS_JOB_INFO', dbConnections: 'ACTIVE_DB_CONNECTIONS' }[kind];
  return `SELECT * FROM TABLE(QSYS2.${fn}(JOB_NAME => '${j}')) X`;
}

/** SUBSYSTEM_DESCRIPTION → "Subsystem description". */
export const prettyColumn = (c: string): string => { const s = c.toLowerCase().replace(/_/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

/** A value as text: dates as ISO, IBM timestamps without the microseconds, blanks trimmed. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) { return ''; }
  if (v instanceof Date) { return isNaN(v.getTime()) ? '' : v.toISOString().replace('T', ' ').slice(0, 19); }
  const s = String(v).trim();
  const ts = /^(\d{4}-\d{2}-\d{2})[-T ](\d{2})[.:](\d{2})[.:](\d{2})(?:\.\d+)?Z?$/.exec(s);
  return ts ? `${ts[1]} ${ts[2]}:${ts[3]}:${ts[4]}` : s;
}

/** First non-blank value among column names. */
export const pick = (r: Row | undefined, ...keys: string[]): string => { for (const k of keys) { const v = cellText(r?.[k]); if (v !== '') { return v; } } return ''; };

/**
 * A table from whole rows: the preferred columns that exist, in that order, else the first `max` columns that have a
 * value somewhere. Columns empty in every row are left out.
 */
export function tableFrom(rows: Row[], prefer: string[] = [], max = 10): { keys: string[]; columns: string[]; rows: string[][] } {
  const all: string[] = []; for (const r of rows) { for (const k of Object.keys(r)) { if (!all.includes(k)) { all.push(k); } } }
  const used = all.filter(k => rows.some(r => cellText(r[k]) !== ''));
  const pref = prefer.filter(k => used.includes(k));
  const keys = pref.length ? pref : used.slice(0, max);
  return { keys, columns: keys.map(prettyColumn), rows: rows.map(r => keys.map(k => cellText(r[k]))) };
}

/** A one-row view as attribute/value pairs, blanks left out. */
export function attributes(rows: Row[]): [string, string][] {
  const r = rows[0]; if (!r) { return []; }
  return Object.keys(r).map(k => [prettyColumn(k), cellText(r[k])] as [string, string]).filter(([, v]) => v !== '');
}

/** 'bad' when any text value matches `bad`, else 'different' when one matches `warn`. */
export function textFlag(r: Row, bad?: RegExp, warn?: RegExp): Flag {
  const vals = Object.values(r).map(cellText);
  if (bad && vals.some(v => bad.test(v))) { return 'bad'; }
  if (warn && vals.some(v => warn.test(v))) { return 'different'; }
  return undefined;
}

/** Rows that belong to a subsystem: any column naming a subsystem (description) holds that name. */
export function bySubsystem(rows: Row[], sbs: string): Row[] {
  const s = sbs.trim().toUpperCase(); if (!s) { return rows; }
  return rows.filter(r => Object.entries(r).some(([k, v]) => /SUBSYSTEM/i.test(k) && !/LIBRARY|SCHEMA/i.test(k) && cellText(v).toUpperCase() === s));
}

/** Ended jobs: end code 30 and more (abnormal end) is bad, 10–29 (ended by a command or a limit) to look at. */
export function endedJobFlag(r: Row): Flag {
  const c = Number(pick(r, 'JOB_END_CODE', 'END_CODE'));
  return !isFinite(c) || pick(r, 'JOB_END_CODE', 'END_CODE') === '' ? textFlag(r, /ABNORMAL/i) : c >= 30 ? 'bad' : c >= 10 ? 'different' : undefined;
}

/** The temporary storage buckets, largest first (current size in bytes). */
export function tempStorageTop(rows: Row[], max = 50): Row[] {
  const size = (r: Row) => Number(pick(r, 'BUCKET_CURRENT_SIZE', 'CURRENT_SIZE')) || 0;
  return [...rows].sort((a, b) => size(b) - size(a)).slice(0, max);
}

export const FLAGS = {
  configStatus: (r: Row): Flag => textFlag(r, /\b(FAILED|DAMAGED|RCYPND|RCYCNL|DIAGNOSTIC MODE|NOT OPERATIONAL)\b/i, /\b(VARY ON PENDING|CONNECT PENDING|SIGNON DISPLAY)\b/i),
  hardware: (r: Row): Flag => textFlag(r, /\b(FAILED|NOT DETECTED)\b/i, /\bUNKNOWN\b/i),
  cves: (r: Row): Flag => textFlag(r, /\b(NOT INSTALLED|NOT APPLIED|MISSING|VULNERABLE|EXPOSED)\b/i),
  problems: (r: Row): Flag => textFlag(r, undefined, /\b(OPENED|READY|PREPARED|SENT)\b/i),
  tapes: (r: Row): Flag => textFlag(r, /\b(ERROR|DAMAGED)\b/i, /\bEXPIRED\b/i),
  nvme: (r: Row): Flag => textFlag(r, /\b(FAILED|CRITICAL)\b/i, /\b(WARNING|DEGRADED)\b/i),
};
