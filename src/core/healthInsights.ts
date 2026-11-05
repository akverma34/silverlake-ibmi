// System health pages: Lock Wait Chains (which job blocks which, on which object or row), Limits Watch (what is
// close to an IBM i limit, from QSYS2.SYSLIMITS) and the Security Scorecard (security system values and profiles
// against common recommendations). Pure functions (no vscode import), unit tested.

// ---------------------------------------------------------------- Lock wait chains

/** Object locks on every object that a job is waiting for, holders included. */
export function objectLockWaitsSql(): string {
  return `SELECT L.SYSTEM_OBJECT_SCHEMA AS LIB, L.SYSTEM_OBJECT_NAME AS OBJ, L.OBJECT_TYPE AS TYPE, COALESCE(L.SYSTEM_TABLE_MEMBER, '') AS MBR, ` +
    `CAST(NULL AS BIGINT) AS RRN, L.LOCK_STATE AS STATE, L.LOCK_STATUS AS STATUS, COALESCE(L.LOCK_SCOPE, '') AS SCOPE, L.JOB_NAME AS JOB ` +
    `FROM QSYS2.OBJECT_LOCK_INFO L WHERE (L.SYSTEM_OBJECT_SCHEMA, L.SYSTEM_OBJECT_NAME, L.OBJECT_TYPE) IN ` +
    `(SELECT W.SYSTEM_OBJECT_SCHEMA, W.SYSTEM_OBJECT_NAME, W.OBJECT_TYPE FROM QSYS2.OBJECT_LOCK_INFO W WHERE W.LOCK_STATUS = 'WAITING')`;
}

/** Row locks on every row that a job is waiting for, holders included. */
export function rowLockWaitsSql(): string {
  return `SELECT R.SYSTEM_TABLE_SCHEMA AS LIB, R.SYSTEM_TABLE_NAME AS OBJ, '*FILE' AS TYPE, COALESCE(R.SYSTEM_TABLE_MEMBER, '') AS MBR, ` +
    `R.RELATIVE_RECORD_NUMBER AS RRN, R.LOCK_STATE AS STATE, R.LOCK_STATUS AS STATUS, COALESCE(R.LOCK_SCOPE, '') AS SCOPE, R.JOB_NAME AS JOB ` +
    `FROM QSYS2.RECORD_LOCK_INFO R WHERE (R.SYSTEM_TABLE_SCHEMA, R.SYSTEM_TABLE_NAME, R.RELATIVE_RECORD_NUMBER) IN ` +
    `(SELECT W.SYSTEM_TABLE_SCHEMA, W.SYSTEM_TABLE_NAME, W.RELATIVE_RECORD_NUMBER FROM QSYS2.RECORD_LOCK_INFO W WHERE W.LOCK_STATUS = 'WAITING')`;
}

/** Status, user and current function of the jobs in the chains (job names are checked before they go in the SQL). */
export function lockJobsSql(jobs: string[]): string | undefined {
  const ok = [...new Set(jobs)].filter(j => /^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i.test(j));
  if (!ok.length) { return undefined; }
  return `SELECT JOB_NAME AS JOB, COALESCE(JOB_STATUS, '') AS STATUS, COALESCE(FUNCTION, '') AS FN, COALESCE(SUBSYSTEM, '') AS SBS ` +
    `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) A WHERE JOB_NAME IN (${ok.map(j => `'${j.toUpperCase()}'`).join(', ')})`;
}

export interface LockRow { LIB: string; OBJ: string; TYPE: string; MBR: string; RRN: number | null; STATE: string; STATUS: string; SCOPE: string; JOB: string }
export interface LockEntry { job: string; state: string; scope: string }
export interface Contention { resource: string; library: string; object: string; type: string; member: string; rrn: number | null; holders: LockEntry[]; waiters: LockEntry[] }
export interface HeadBlocker { job: string; blocks: number; resources: string[] }

/** The resource a lock is on: LIB/OBJ TYPE, plus the member and the row when there are. */
export const lockResource = (r: Pick<LockRow, 'LIB' | 'OBJ' | 'TYPE' | 'MBR' | 'RRN'>): string =>
  `${String(r.LIB).trim()}/${String(r.OBJ).trim()} ${String(r.TYPE).trim()}${String(r.MBR ?? '').trim() ? ` (${String(r.MBR).trim()})` : ''}${r.RRN !== null && r.RRN !== undefined && String(r.RRN) !== '' ? ` row ${Number(r.RRN)}` : ''}`;

/**
 * Each contended resource with the jobs that hold it and those that wait for it, and the head blockers: jobs that
 * hold something others wait for without waiting themselves, with how many jobs they block directly or through others.
 */
export function lockChains(rows: LockRow[]): { contention: Contention[]; heads: HeadBlocker[]; waiting: number } {
  const m = new Map<string, Contention>();
  for (const r of rows) {
    const resource = lockResource(r); const job = String(r.JOB ?? '').trim(); if (!job) { continue; }
    const c = m.get(resource) ?? { resource, library: String(r.LIB).trim(), object: String(r.OBJ).trim(), type: String(r.TYPE).trim(), member: String(r.MBR ?? '').trim(), rrn: r.RRN === null || r.RRN === undefined || String(r.RRN) === '' ? null : Number(r.RRN), holders: [], waiters: [] };
    const e = { job, state: String(r.STATE ?? '').trim(), scope: String(r.SCOPE ?? '').trim() };
    const list = String(r.STATUS).trim().toUpperCase() === 'WAITING' ? c.waiters : String(r.STATUS).trim().toUpperCase() === 'HELD' ? c.holders : undefined;
    if (list && !list.some(x => x.job === e.job && x.state === e.state)) { list.push(e); }
    m.set(resource, c);
  }
  const contention = [...m.values()].filter(c => c.waiters.length).sort((a, b) => b.waiters.length - a.waiters.length || a.resource.localeCompare(b.resource));
  // waiter → holders it waits for
  const waitsFor = new Map<string, Set<string>>();
  for (const c of contention) { for (const w of c.waiters) { const s = waitsFor.get(w.job) ?? new Set(); c.holders.filter(h => h.job !== w.job).forEach(h => s.add(h.job)); waitsFor.set(w.job, s); } }
  const blockedBy = new Map<string, Set<string>>(); // holder → waiters directly blocked
  for (const [w, hs] of waitsFor) { for (const h of hs) { blockedBy.set(h, (blockedBy.get(h) ?? new Set()).add(w)); } }
  const reach = (job: string): number => {
    const seen = new Set<string>(); const stack = [...(blockedBy.get(job) ?? [])];
    while (stack.length) { const j = stack.pop()!; if (seen.has(j) || j === job) { continue; } seen.add(j); stack.push(...(blockedBy.get(j) ?? [])); }
    return seen.size;
  };
  const heads = [...blockedBy.keys()].filter(h => !waitsFor.has(h))
    .map(job => ({ job, blocks: reach(job), resources: contention.filter(c => c.holders.some(x => x.job === job)).map(c => c.resource) }))
    .sort((a, b) => b.blocks - a.blocks || a.job.localeCompare(b.job));
  return { contention, heads, waiting: waitsFor.size };
}

// ---------------------------------------------------------------- Limits watch

/** The most recent SYSLIMITS rows (all columns: their names differ a little by release). */
export function limitsSql(max = 5000): string {
  return `SELECT * FROM QSYS2.SYSLIMITS ORDER BY LAST_CHANGE_TIMESTAMP DESC FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

export interface LimitUse { category: string; limit: string; current: number; maximum: number; pct: number; where: string; job: string; user: string; changed: string }
export type Level = 'ok' | 'warn' | 'bad';
export const limitLevel = (pct: number): Level => pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok';

const col = (r: Record<string, unknown>, names: string[]): string => { for (const n of names) { const v = r[n]; if (v !== undefined && v !== null && String(v).trim() !== '') { return String(v).trim(); } } return ''; };

/**
 * One line per limit and object (or job, or IFS path), the latest value only, closest to its maximum first.
 * SYSLIMITS writes a row each time a value grows past its tracking point, so older rows of the same limit are dropped.
 */
export function limitUses(rows: Record<string, unknown>[]): LimitUse[] {
  const seen = new Map<string, LimitUse>();
  for (const r of rows) {
    const maximum = Number(col(r, ['MAXIMUM_VALUE'])); const current = Number(col(r, ['CURRENT_VALUE']));
    if (!isFinite(maximum) || maximum <= 0 || !isFinite(current)) { continue; }
    const lib = col(r, ['SYSTEM_SCHEMA_NAME', 'SYSTEM_OBJECT_SCHEMA']); const obj = col(r, ['SYSTEM_OBJECT_NAME']); const mbr = col(r, ['SYSTEM_TABLE_MEMBER']);
    const path = col(r, ['IFS_PATH_NAME', 'PATH_NAME']); const type = col(r, ['OBJECT_TYPE']);
    const where = path || (obj ? `${lib ? lib + '/' : ''}${obj}${mbr ? ` (${mbr})` : ''}${type ? ` ${type}` : ''}` : lib);
    const limit = col(r, ['LIMIT_DESCRIPTION', 'SIZING_NAME', 'LIMIT_ID']) || 'Limit';
    const job = col(r, ['JOB_NAME']); const changed = col(r, ['LAST_CHANGE_TIMESTAMP']).replace('T', ' ').slice(0, 19);
    const key = `${limit}|${where || job}`;
    const prev = seen.get(key);
    if (prev && prev.changed >= changed) { continue; }
    seen.set(key, { category: col(r, ['LIMIT_CATEGORY']) || 'OTHER', limit, current, maximum, pct: Math.round(current / maximum * 1000) / 10, where, job, user: col(r, ['USER_NAME']), changed });
  }
  return [...seen.values()].sort((a, b) => b.pct - a.pct || a.limit.localeCompare(b.limit));
}

// ---------------------------------------------------------------- Security scorecard

export const SECURITY_VALUES = ['QSECURITY', 'QPWDLVL', 'QPWDEXPITV', 'QPWDMINLEN', 'QMAXSIGN', 'QMAXSGNACN', 'QINACTITV', 'QAUDCTL', 'QLMTSECOFR',
  'QCRTAUT', 'QALWOBJRST', 'QVFYOBJRST', 'QDSPSGNINF', 'QAUTOVRT', 'QPWDRULES'];

export function securityValuesSql(): string {
  return `SELECT SYSTEM_VALUE_NAME AS NAME, COALESCE(TRIM(CURRENT_CHARACTER_VALUE), VARCHAR(CURRENT_NUMERIC_VALUE)) AS VAL ` +
    `FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME IN (${SECURITY_VALUES.map(v => `'${v}'`).join(', ')})`;
}

/** Enabled profiles with what the scorecard looks at (only the profiles the user may see are returned). */
export function profilesSql(): string {
  return `SELECT AUTHORIZATION_NAME AS USR, COALESCE(SPECIAL_AUTHORITIES, '') AS SPC, COALESCE(NO_PASSWORD_INDICATOR, 'NO') AS NOPWD, ` +
    `COALESCE(DAYS(CURRENT DATE) - DAYS(DATE(PASSWORD_CHANGE_DATE)), -1) AS PWDAGE, COALESCE(DAYS(CURRENT DATE) - DAYS(DATE(PREVIOUS_SIGNON)), -1) AS IDLE, ` +
    `COALESCE(USER_CLASS_NAME, '') AS CLS FROM QSYS2.USER_INFO WHERE STATUS = '*ENABLED'`;
}

export type CheckState = 'pass' | 'warn' | 'fail';
export interface SecurityCheck { id: string; title: string; value: string; recommended: string; state: CheckState; weight: number; why: string }

const n = (v: string | undefined): number => { const x = Number(String(v ?? '').trim()); return isFinite(x) ? x : NaN; };

/** Each security system value against a common recommendation; values not returned (no authority, older release) are left out. */
export function securityChecks(values: Record<string, string>): SecurityCheck[] {
  const v = (k: string) => values[k]?.trim();
  const out: SecurityCheck[] = [];
  const add = (id: string, title: string, recommended: string, weight: number, why: string, state: (x: string) => CheckState) => {
    const x = v(id); if (x === undefined) { return; }
    out.push({ id, title, value: x === '' ? '(blank)' : x, recommended, weight, why, state: state(x) });
  };
  add('QSECURITY', 'Security level', '40 or 50', 5, 'Below 40, programs can reach system objects directly and every user gets *ALLOBJ at level 20.', x => n(x) >= 40 ? 'pass' : 'fail');
  add('QPWDLVL', 'Password level', '2 or 3', 3, 'Level 0 and 1 allow only 10-character upper-case passwords and keep weak NetServer hashes.', x => n(x) >= 2 ? 'pass' : 'warn');
  add('QPWDEXPITV', 'Password expiration', '90 days or less', 2, 'Passwords that never expire stay valid long after they leak.', x => x.toUpperCase() === '*NOMAX' ? 'fail' : n(x) <= 90 ? 'pass' : 'warn');
  add('QPWDMINLEN', 'Minimum password length', '8 or more', 3, 'Short passwords are guessed quickly (ignored when QPWDRULES does not use *PWDSYSVAL).', x => n(x) >= 8 ? 'pass' : 'warn');
  add('QMAXSIGN', 'Sign-on attempts allowed', '5 or fewer', 3, 'Without a limit, passwords can be guessed forever.', x => x.toUpperCase() === '*NOMAX' ? 'fail' : n(x) <= 5 ? 'pass' : 'warn');
  add('QMAXSGNACN', 'Action after too many sign-on attempts', '2 or 3 (disable the profile)', 2, 'Disabling only the device lets an attacker move on to another device or a server job.', x => n(x) >= 2 ? 'pass' : 'warn');
  add('QINACTITV', 'Inactive job time-out', '60 minutes or less', 1, 'Unattended signed-on sessions can be used by anyone passing by.', x => x.toUpperCase() === '*NONE' ? 'warn' : n(x) <= 60 ? 'pass' : 'warn');
  add('QAUDCTL', 'Security auditing', 'On (*AUDLVL, *OBJAUD)', 3, 'Without auditing there is no trace of authority failures or security changes.', x => /\*NONE/i.test(x) || x === '' ? 'fail' : 'pass');
  add('QLMTSECOFR', 'Limit security officer device access', '1', 2, 'At 0, *ALLOBJ users can sign on at any display.', x => n(x) === 1 ? 'pass' : 'warn');
  add('QCRTAUT', 'Public authority to new objects', '*USE or *EXCLUDE', 2, '*ALL lets every user delete new objects; *CHANGE lets them change the data.', x => /^\*(USE|EXCLUDE)$/i.test(x) ? 'pass' : x.toUpperCase() === '*ALL' ? 'fail' : 'warn');
  add('QALWOBJRST', 'Restore of security-sensitive objects', '*NONE outside install windows', 1, '*ALL allows restoring programs that adopt authority or have system state.', x => /\*ALL\b/i.test(x) ? 'warn' : 'pass');
  add('QVFYOBJRST', 'Verify signatures on restore', '3 or more', 1, 'Lower values restore unsigned or changed programs without a check.', x => n(x) >= 3 ? 'pass' : 'warn');
  add('QDSPSGNINF', 'Show sign-on information', '1', 1, 'Users who see their last sign-on and failed attempts notice misuse of their profile.', x => n(x) === 1 ? 'pass' : 'warn');
  add('QAUTOVRT', 'Automatic virtual devices', '0 or a small number', 1, 'Unlimited virtual devices take away a brake on Telnet password guessing.', x => x.toUpperCase() === '*NOMAX' ? 'warn' : 'pass');
  return out;
}

export interface ProfileRow { USR: string; SPC: string; NOPWD: string; PWDAGE: number; IDLE: number; CLS: string }
export interface ProfileFindings { enabled: number; allObj: string[]; oldPasswords: string[]; idle: string[] }

/** Enabled profiles with *ALLOBJ (IBM Q profiles left out), with a password unchanged for a year, or unused for 180 days. */
export function profileFindings(rows: ProfileRow[]): ProfileFindings {
  const name = (r: ProfileRow) => String(r.USR).trim();
  const ibm = (u: string) => /^Q/.test(u);
  const hasPwd = (r: ProfileRow) => String(r.NOPWD).trim().toUpperCase() !== 'YES';
  return {
    enabled: rows.length,
    allObj: rows.filter(r => /\*ALLOBJ/.test(String(r.SPC)) && !ibm(name(r))).map(name).sort(),
    oldPasswords: rows.filter(r => hasPwd(r) && Number(r.PWDAGE) > 365 && !ibm(name(r))).map(name).sort(),
    idle: rows.filter(r => hasPwd(r) && Number(r.IDLE) > 180 && !ibm(name(r))).map(name).sort(),
  };
}

/** Score 0–100: a passed check earns its weight, a warning half of it; profile findings take off up to 15 points. */
export function securityScore(checks: SecurityCheck[], p?: ProfileFindings): number {
  const total = checks.reduce((s, c) => s + c.weight, 0);
  if (!total) { return 0; }
  const got = checks.reduce((s, c) => s + (c.state === 'pass' ? c.weight : c.state === 'warn' ? c.weight / 2 : 0), 0);
  let score = got / total * 100;
  if (p && p.enabled) {
    const share = (k: number) => Math.min(1, k / Math.max(1, p.enabled));
    score -= Math.min(15, share(p.allObj.length) * 30 + share(p.oldPasswords.length) * 10 + share(p.idle.length) * 10);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export const scoreGrade = (s: number): string => s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'E';
