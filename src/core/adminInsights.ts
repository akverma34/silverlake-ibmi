// Admin pages: Function Usage Map (who may use which IBM i function, QSYS2.FUNCTION_INFO and FUNCTION_USAGE),
// User Storage Map (storage owned per user against its MAXSTG, QSYS2.USER_STORAGE) and Reply List Check (the system
// reply list, QSYS2.REPLY_LIST_INFO, with entries that answer everything or are never reached).
// Pure functions (no vscode import), unit tested.

type Row = Record<string, unknown>;

/** First non-blank value among column names (some columns are named differently by release). */
const col = (r: Row, names: string[]): string => { for (const n of names) { const v = r[n]; if (v !== undefined && v !== null && String(v).trim() !== '') { return String(v).trim(); } } return ''; };

// ---------------------------------------------------------------- Function usage

/** Functions that give powers worth knowing about. */
export const SENSITIVE_FUNCTIONS = ['QIBM_DB_SECADM', 'QIBM_DB_SQLADM', 'QIBM_DB_SYSMON', 'QIBM_DB_ZDA', 'QIBM_DB_DDMDRDA',
  'QIBM_ACCESS_ALLOBJ_JOBLOG', 'QIBM_ALLOBJ_TRACE_ANY_USER', 'QIBM_SERVICE_TRACE', 'QIBM_SERVICE_DUMP', 'QIBM_SERVICE_JOB_WATCH'];

export const functionInfoSql = (): string => `SELECT * FROM QSYS2.FUNCTION_INFO`;
export const functionUsageSql = (): string => `SELECT FUNCTION_ID, USER_NAME, USAGE, COALESCE(USER_TYPE, '') AS USER_TYPE FROM QSYS2.FUNCTION_USAGE`;

export type Usage = 'ALLOWED' | 'DENIED';
export interface FunctionEntry { id: string; name: string; defaultUsage: Usage; allObj: boolean; sensitive: boolean; entries: number }
export interface FunctionMatrix {
  functions: FunctionEntry[];
  users: Array<{ name: string; group: boolean; allowed: number }>;
  /** `${user}|${functionId}` → explicit usage */
  cells: Map<string, Usage>;
  /** sensitive functions everyone may use: by default, or through *PUBLIC */
  openToAll: string[];
}

const usage = (v: string): Usage => /DENIED/i.test(v) ? 'DENIED' : 'ALLOWED';

/**
 * The functions that have explicit entries or are sensitive (sensitive first), the users and groups with entries
 * (most allowed functions first), and which sensitive functions are open to everyone.
 */
export function functionMatrix(info: Row[], uses: Row[]): FunctionMatrix {
  const fns = new Map<string, FunctionEntry>();
  for (const r of info) {
    const id = col(r, ['FUNCTION_ID']); if (!id) { continue; }
    fns.set(id, { id, name: col(r, ['FUNCTION_NAME', 'FUNCTION_DESCRIPTION']), defaultUsage: usage(col(r, ['DEFAULT_USAGE'])), allObj: /^(YES|USED|Y)$/i.test(col(r, ['ALLOBJ_INDICATOR', 'ALLOBJ_ALLOWED'])), sensitive: SENSITIVE_FUNCTIONS.includes(id), entries: 0 });
  }
  const cells = new Map<string, Usage>(); const users = new Map<string, { name: string; group: boolean; allowed: number }>();
  for (const r of uses) {
    const id = col(r, ['FUNCTION_ID']); const user = col(r, ['USER_NAME']); if (!id || !user) { continue; }
    const f = fns.get(id) ?? { id, name: '', defaultUsage: 'DENIED' as Usage, allObj: false, sensitive: SENSITIVE_FUNCTIONS.includes(id), entries: 0 };
    f.entries++; fns.set(id, f);
    const u = usage(col(r, ['USAGE'])); cells.set(`${user}|${id}`, u);
    const e = users.get(user) ?? { name: user, group: /GROUP/i.test(col(r, ['USER_TYPE'])), allowed: 0 };
    if (u === 'ALLOWED') { e.allowed++; }
    users.set(user, e);
  }
  const functions = [...fns.values()].filter(f => f.entries || f.sensitive)
    .sort((a, b) => Number(b.sensitive) - Number(a.sensitive) || b.entries - a.entries || a.id.localeCompare(b.id));
  const openToAll = functions.filter(f => f.sensitive && (cells.get(`*PUBLIC|${f.id}`) ?? f.defaultUsage) === 'ALLOWED').map(f => f.id);
  return { functions, users: [...users.values()].sort((a, b) => Number(b.name === '*PUBLIC') - Number(a.name === '*PUBLIC') || b.allowed - a.allowed || a.name.localeCompare(b.name)), cells, openToAll };
}

/** What a user or group gets for a function: its own entry, else *PUBLIC's, else the default. */
export function effectiveUsage(m: FunctionMatrix, user: string, f: FunctionEntry): { usage: Usage; explicit: boolean } {
  const own = m.cells.get(`${user}|${f.id}`);
  if (own) { return { usage: own, explicit: true }; }
  return { usage: m.cells.get(`*PUBLIC|${f.id}`) ?? f.defaultUsage, explicit: false };
}

// ---------------------------------------------------------------- User storage

export const userStorageSql = (): string => `SELECT * FROM QSYS2.USER_STORAGE`;

export interface StorageUse { user: string; usedKb: number; maxKb: number | null; pctOfMax: number | null; share: number }

/**
 * Storage owned per user (all ASPs together), largest first, with the % of its MAXSTG and its share of all user storage.
 * USER_STORAGE gives kilobytes; a missing or negative maximum means *NOMAX.
 */
export function storageUses(rows: Row[]): { users: StorageUse[]; totalKb: number } {
  const m = new Map<string, { used: number; max: number | null }>();
  for (const r of rows) {
    const user = col(r, ['AUTHORIZATION_NAME', 'USER_NAME']); if (!user) { continue; }
    const used = Number(col(r, ['STORAGE_USED', 'STORAGE_USED_KB'])) || 0;
    const rawMax = col(r, ['MAXIMUM_STORAGE_ALLOWED', 'MAXIMUM_STORAGE']); const max = rawMax === '' || /NOMAX/i.test(rawMax) || Number(rawMax) < 0 || !isFinite(Number(rawMax)) ? null : Number(rawMax);
    const e = m.get(user) ?? { used: 0, max };
    e.used += used; if (max !== null) { e.max = max; }
    m.set(user, e);
  }
  const totalKb = [...m.values()].reduce((s, e) => s + e.used, 0);
  const users = [...m.entries()].map(([user, e]) => ({
    user, usedKb: e.used, maxKb: e.max,
    pctOfMax: e.max ? Math.round(e.used / e.max * 1000) / 10 : null,
    share: totalKb ? Math.round(e.used / totalKb * 1000) / 10 : 0,
  })).sort((a, b) => b.usedKb - a.usedKb || a.user.localeCompare(b.user));
  return { users, totalKb };
}

/** 1 536 KB → "1.5 MB". */
export function kbLabel(kb: number): string {
  const u = ['KB', 'MB', 'GB', 'TB', 'PB']; let v = kb; let i = 0;
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ---------------------------------------------------------------- Reply list

export const replyListSql = (): string => `SELECT * FROM QSYS2.REPLY_LIST_INFO ORDER BY SEQUENCE_NUMBER`;

/** First-level text of the message IDs (IDs are checked before they go in the SQL). */
export function messageTextSql(ids: string[]): string | undefined {
  const ok = [...new Set(ids.map(x => x.toUpperCase()))].filter(x => /^[A-Z][A-Z0-9]{2}[0-9A-F]{4}$/.test(x));
  if (!ok.length) { return undefined; }
  return `SELECT MESSAGE_ID AS ID, MESSAGE_TEXT AS TXT FROM QSYS2.MESSAGE_FILE_DATA WHERE MESSAGE_FILE_LIBRARY = 'QSYS' AND MESSAGE_FILE = 'QCPFMSG' AND MESSAGE_ID IN (${ok.map(x => `'${x}'`).join(', ')})`;
}

export type ReplyIssue = 'any' | 'shadowed' | 'dump';
export interface ReplyEntry { seq: number; msgId: string; reply: string; compare: string; start: number; dump: boolean; issues: ReplyIssue[]; shadowedBy?: number }

/**
 * Whether a reply list message ID matches a message: *ANY matches all; a generic ID ending in zeros
 * (CPA0000, CPA5300) matches every message with the same leading characters.
 */
export function replyIdMatches(entryId: string, msgId: string): boolean {
  const e = entryId.toUpperCase(); const m = msgId.toUpperCase();
  if (e === '*ANY') { return true; }
  if (e.length !== 7 || m.length !== 7) { return e === m; }
  const prefix = e.slice(0, 3) + e.slice(3).replace(/0+$/, '');
  return m.startsWith(prefix);
}

/**
 * The entries in sequence order with what to look at: *ANY answers every inquiry message of the jobs that use the
 * list; an entry is never reached when an earlier one without compare data already matches all its messages;
 * DUMP(*YES) dumps the job each time.
 */
export function replyEntries(rows: Row[]): ReplyEntry[] {
  const list: ReplyEntry[] = rows.map(r => ({
    seq: Number(col(r, ['SEQUENCE_NUMBER'])) || 0, msgId: col(r, ['MESSAGE_ID']).toUpperCase(), reply: col(r, ['MESSAGE_REPLY', 'REPLY']),
    compare: col(r, ['COMPARE_DATA']), start: Number(col(r, ['COMPARE_START_POSITION'])) || 1, dump: /^\*?YES$/i.test(col(r, ['DUMP', 'DUMP_OPTION'])), issues: [] as ReplyIssue[],
  })).filter(e => e.msgId).sort((a, b) => a.seq - b.seq);
  list.forEach((e, i) => {
    if (e.msgId === '*ANY') { e.issues.push('any'); }
    if (e.dump) { e.issues.push('dump'); }
    const by = list.slice(0, i).find(p => !p.compare && replyIdMatches(p.msgId, e.msgId) && (p.msgId === '*ANY' || e.msgId !== '*ANY'));
    if (by) { e.issues.push('shadowed'); e.shadowedBy = by.seq; }
  });
  return list;
}
