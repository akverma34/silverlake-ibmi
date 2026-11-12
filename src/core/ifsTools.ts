// IFS helpers: search (grep), authorities, CCSID tagging and path checks. Pure functions (no vscode import), unit
// tested.
import { isValidSystemName } from './util';

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** find + grep over an IFS folder (PASE grep has no -r --include, so find picks the files). */
export function ifsGrepCommand(folder: string, text: string, opts: { regex?: boolean; matchCase?: boolean; include?: string; max?: number } = {}): string {
  if (!text) { throw new Error('Enter the text to find.'); }
  if (!folder.startsWith('/')) { throw new Error('The folder must be an absolute IFS path.'); }
  const flags = `-n${opts.regex ? 'E' : 'F'}${opts.matchCase ? '' : 'i'}`;
  const name = opts.include?.trim() ? ` -name ${shq(opts.include.trim())}` : '';
  return `/QOpenSys/usr/bin/find ${shq(folder)} -type f${name} -exec /QOpenSys/usr/bin/grep ${flags} -e ${shq(text)} /dev/null {} + 2>/dev/null | /QOpenSys/usr/bin/head -n ${Math.max(1, opts.max ?? 1000)}`;
}

export function parseGrep(out: string): { file: string; line: number; text: string }[] {
  return out.split('\n').map(l => /^(.+?):(\d+):(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => ({ file: m[1], line: Number(m[2]), text: m[3] }));
}

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const DATA_AUTHORITIES = ['*RWX', '*RX', '*RW', '*WX', '*R', '*W', '*X', '*EXCLUDE', '*NONE'];

export function chgautCommand(path: string, user: string, dtaaut: string, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  const u = user.trim().toUpperCase() === '*PUBLIC' ? '*PUBLIC' : NAME(user, 'user profile');
  if (!DATA_AUTHORITIES.includes(dtaaut.toUpperCase())) { throw new Error('Unknown data authority.'); }
  return `CHGAUT OBJ(${q(path)}) USER(${u}) DTAAUT(${dtaaut.toUpperCase()}) OBJAUT(*NONE)${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export function chgownCommand(path: string, owner: string, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  return `CHGOWN OBJ(${q(path)}) NEWOWN(${NAME(owner, 'user profile')}) RVKOLDAUT(*YES)${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export const COMMON_CCSIDS: Record<number, string> = { 1208: 'UTF-8', 819: 'ISO 8859-1 (Latin-1)', 1252: 'Windows Latin-1', 37: 'EBCDIC US', 297: 'EBCDIC France', 273: 'EBCDIC Germany', 284: 'EBCDIC Spain', 280: 'EBCDIC Italy', 500: 'EBCDIC International', 1200: 'UTF-16' };

export function tagCcsidCommand(path: string, ccsid: number, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  if (!Number.isInteger(ccsid) || ccsid < 1 || ccsid > 65535) { throw new Error('Enter a CCSID between 1 and 65535.'); }
  return `CHGATR OBJ('${path.replace(/'/g, "''")}') ATR(*CCSID) VALUE(${ccsid})${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export function convertCcsidCommand(path: string, ccsid: number): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  const p = path.replace(/'/g, "''");
  return `CPY OBJ('${p}') TOOBJ('${p}') TOCCSID(${ccsid}) DTAFMT(*TEXT) REPLACE(*YES)`;
}

/** An absolute IFS path without empty or relative parts. */
export function checkIfsPath(path: string): string {
  const p = path.trim().replace(/\/+$/, '') || '/';
  if (!p.startsWith('/')) { throw new Error('Start the path with / (for example /home/me/app).'); }
  if (/(^|\/)\.\.?(\/|$)/.test(p) || /\/\//.test(p) || /[\0\n]/.test(p)) { throw new Error('The path cannot contain //, . or .. parts.'); }
  return p;
}

/** chmod mode like 755 or 640. */
export function checkMode(mode: string): string {
  const m = mode.trim();
  if (!/^[0-7]{3,4}$/.test(m)) { throw new Error('Use an octal mode such as 755 or 640.'); }
  return m;
}

// ---------------------------------------------------------------- who uses an IFS file (QSYS2.IFS_OBJECT_LOCK_INFO)

const sqlQ = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Jobs using an IFS object; for a folder, the stream files in it (and below it with subtree) — IBM i 7.3 TR11 / 7.4 TR5 and later. */
export function ifsLocksSql(path: string, folder: boolean, max = 2000, subtree = false): string {
  const p = checkIfsPath(path);
  if (subtree && p === '/') { throw new Error('Pick a folder below / to include its subfolders.'); }
  const lim = Math.max(1, Math.min(10000, Math.trunc(max)));
  if (!folder) { return `SELECT ${sqlQ(p)} AS P, L.* FROM TABLE(QSYS2.IFS_OBJECT_LOCK_INFO(PATH_NAME => ${sqlQ(p)})) L FETCH FIRST ${lim} ROWS ONLY`; }
  return `SELECT X.PATH_NAME AS P, L.* FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlQ(p)}, SUBTREE_DIRECTORIES => '${subtree ? 'YES' : 'NO'}', OBJECT_TYPE_LIST => '*ALLSTMF')) X, ` +
    `LATERAL (SELECT * FROM TABLE(QSYS2.IFS_OBJECT_LOCK_INFO(PATH_NAME => X.PATH_NAME))) L ORDER BY X.PATH_NAME FETCH FIRST ${lim} ROWS ONLY`;
}

export interface IfsLock { path: string; job: string; user: string; refs: number; uses: string[]; blocking: boolean }

const LOCK_META = new Set(['P', 'PATH_NAME', 'JOB_NAME', 'REFERENCE_COUNT']);
/** Uses that keep other jobs from writing (or from reading): share modes that share nothing, save locks, check-outs. */
const BLOCKING = /NO_SHARE|SHARE_NONE|SHARE_WITH_(READERS|WRITERS)(_ONLY)?$|SAVE_LOCK|CHECKED_OUT$/;

/** One entry per file and job: which uses are on (every YES column, named in plain words), blocking ones flagged. */
export function ifsLockRows(rows: Record<string, unknown>[]): IfsLock[] {
  const out: IfsLock[] = [];
  for (const r of rows) {
    const job = String(r.JOB_NAME ?? '').trim();
    if (!job) { continue; }
    const on = Object.keys(r).filter(k => !LOCK_META.has(k) && String(r[k] ?? '').trim().toUpperCase() === 'YES');
    out.push({
      path: String(r.P ?? r.PATH_NAME ?? '').trim(), job, user: job.split('/')[1] ?? '',
      refs: Number(r.REFERENCE_COUNT ?? 0) || 0,
      uses: on.map(k => k.toLowerCase().replace(/_/g, ' ')),
      blocking: on.some(k => BLOCKING.test(k)),
    });
  }
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.path.localeCompare(b.path) || a.job.localeCompare(b.job));
}

/** The short job name (the last part of 123456/USER/NAME). */
export function jobShortName(job: string): string {
  return job.trim().split('/').pop() ?? '';
}

/** The warning shown when saving a stream file failed while other jobs have it open (undefined when none has). */
export function busyFileMessage(path: string, locks: IfsLock[]): { jobs: number; blocking: number } | undefined {
  const mine = locks.filter(l => l.path === path || !l.path);
  if (!mine.length) { return undefined; }
  return { jobs: new Set(mine.map(l => l.job)).size, blocking: new Set(mine.filter(l => l.blocking).map(l => l.job)).size };
}
