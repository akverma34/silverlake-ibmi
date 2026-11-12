// System Checks (3.3): five quick checks an administrator or a developer on duty runs when something feels wrong —
// libraries not saved lately, users who cannot sign on, job descriptions that run as a named user, user objects in
// IBM libraries, and the environment variables. Findings are English
// templates with {0}, {1}… (the page translates them). Pure functions (no vscode import), unit tested.

export type Level = 'high' | 'medium' | 'info';
export interface Text { text: string; args: (string | number)[] }
const T = (text: string, ...args: (string | number)[]): Text => ({ text, args });
type Row = Record<string, unknown>;
const s = (r: Row, k: string) => String(r[k] ?? '').trim();
const n = (r: Row, k: string) => { const v = Number(r[k]); return isNaN(v) ? 0 : v; };
const DAY = 86_400_000;
const asDate = (v: unknown): Date | undefined => {
  if (v === null || v === undefined || v === '') { return undefined; }
  if (v instanceof Date) { return isNaN(v.getTime()) ? undefined : v; }
  const t = String(v).trim().replace(/^(\d{4}-\d\d-\d\d)[-\s](\d\d)[.:](\d\d)[.:](\d\d).*$/, '$1T$2:$3:$4');
  const d = new Date(t); return isNaN(d.getTime()) ? undefined : d;
};
const ymd = (d?: Date) => d ? d.toISOString().slice(0, 10) : '';
const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY);

// ---------------------------------------------------------------- 1. Backup freshness

export interface BackupRow { library: string; saved: string; days: number | null; level: Level; text: Text; changed: string }
/** Libraries never saved, or not saved for more than `maxDays` days (OBJECT_STATISTICS of *ALLUSR *LIB). */
export function backupFreshness(rows: Row[], now: Date, maxDays = 7): BackupRow[] {
  const out = rows.map(r => {
    const lib = s(r, 'OBJNAME'); const saved = asDate(r.SAVE_TIMESTAMP); const changed = asDate(r.CHANGE_TIMESTAMP ?? r.OBJCREATED);
    if (!saved) { return { library: lib, saved: '', days: null, level: 'high' as Level, text: T('Never saved.'), changed: ymd(changed) }; }
    const d = daysBetween(saved, now);
    const level: Level = d > maxDays * 4 ? 'high' : d > maxDays ? 'medium' : 'info';
    return { library: lib, saved: ymd(saved), days: d, level, text: level === 'info' ? T('Saved {0} day(s) ago.', d) : T('Not saved for {0} days.', d), changed: ymd(changed) };
  });
  const rank: Record<Level, number> = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || (b.days ?? 1e9) - (a.days ?? 1e9) || a.library.localeCompare(b.library));
}

// ---------------------------------------------------------------- 2. Sign-on problems

export interface SignonRow { user: string; level: Level; text: Text; fix: string; lastSignon: string; text2: string }
/** Users who cannot sign on or soon will not: locked out, invalid attempts, password or profile expired or expiring. */
export function signonProblems(rows: Row[], maxSign: number, now: Date): SignonRow[] {
  const out: SignonRow[] = [];
  const max = maxSign > 0 ? maxSign : 3;
  for (const r of rows) {
    const u = s(r, 'AUTHORIZATION_NAME'); const enabled = s(r, 'STATUS') === '*ENABLED'; const bad = n(r, 'SIGN_ON_ATTEMPTS_NOT_VALID');
    const noPwd = s(r, 'NO_PASSWORD_INDICATOR') === 'YES'; const last = ymd(asDate(r.PREVIOUS_SIGNON)); const desc = s(r, 'TEXT_DESCRIPTION');
    const add = (level: Level, text: Text, fix: string) => out.push({ user: u, level, text, fix, lastSignon: last, text2: desc });
    if (!enabled && bad >= max) { add('high', T('Disabled after {0} invalid sign-on attempts.', bad), `CHGUSRPRF USRPRF(${u}) STATUS(*ENABLED)`); continue; }
    if (!enabled) { continue; }
    if (bad > 0) { add(bad >= max - 1 ? 'high' : 'medium', T('{0} invalid sign-on attempt(s): the profile is disabled at {1}.', bad, max), ''); }
    const exp = asDate(r.DATE_PASSWORD_EXPIRES);
    if (exp && !noPwd) {
      const d = daysBetween(now, exp);
      if (d < 0) { add('high', T('Password expired on {0}.', ymd(exp)), `CHGUSRPRF USRPRF(${u}) PWDEXP(*YES)`); }
      else if (d <= 7) { add('medium', T('Password expires in {0} day(s).', d), ''); }
    }
    const uexp = asDate(r.USER_EXPIRATION_DATE);
    if (uexp) {
      const d = daysBetween(now, uexp);
      if (d < 0) { add('high', T('Profile expired on {0}.', ymd(uexp)), `CHGUSRPRF USRPRF(${u}) USREXPDATE(*NONE)`); }
      else if (d <= 14) { add('medium', T('Profile expires in {0} day(s).', d), `CHGUSRPRF USRPRF(${u}) USREXPDATE(*NONE)`); }
    }
  }
  const rank: Record<Level, number> = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.user.localeCompare(b.user));
}

// ---------------------------------------------------------------- 3. Job descriptions that name a user

export interface JobdRow { library: string; jobd: string; user: string; publicAut: string; level: Level; text: Text }
/**
 * Job descriptions with USER(name) instead of *RQD: anyone who may use the job description can submit work that runs
 * as that user. High when *PUBLIC may use it and the user is powerful (*ALLOBJ, *SECADM) or QSECOFR.
 */
export function jobdUsers(rows: Row[], publicAut: Map<string, string>, powerful: Set<string>): JobdRow[] {
  const out = rows.filter(r => s(r, 'USER_PROFILE') && s(r, 'USER_PROFILE') !== '*RQD').map(r => {
    const lib = s(r, 'JOB_DESCRIPTION_LIBRARY'); const jd = s(r, 'JOB_DESCRIPTION'); const u = s(r, 'USER_PROFILE');
    const pub = publicAut.get(`${lib}/${jd}`) ?? '';
    const open = !!pub && pub !== '*EXCLUDE';
    const strong = powerful.has(u) || u === 'QSECOFR';
    const level: Level = open && strong ? 'high' : open || strong ? 'medium' : 'info';
    const text = open && strong ? T('*PUBLIC {0}: anyone can submit jobs that run as {1}, a powerful profile.', pub, u)
      : open ? T('*PUBLIC {0}: anyone can submit jobs that run as {1}.', pub, u)
      : strong ? T('Runs as {0}, a powerful profile: check who is authorized to it.', u)
      : T('Runs as {0}.', u);
    return { library: lib, jobd: jd, user: u, publicAut: pub || '?', level, text };
  });
  const rank: Record<Level, number> = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.library.localeCompare(b.library) || a.jobd.localeCompare(b.jobd));
}

// ---------------------------------------------------------------- 4. User objects in IBM libraries

export interface IbmLibRow { library: string; object: string; type: string; owner: string; creator: string; created: string; text: string; level: Level; why: Text }
const ibmProfile = (u: string) => !u || /^Q/.test(u) || u === '*IBM';
/** Objects created or owned by non-IBM profiles in QSYS, QSYS2 or QGPL. */
export function userObjectsInIbmLibraries(rows: Row[]): IbmLibRow[] {
  return rows.filter(r => !ibmProfile(s(r, 'OBJOWNER')) || !ibmProfile(s(r, 'OBJDEFINER'))).map(r => {
    const lib = s(r, 'LIB') || s(r, 'OBJLIB');
    const sys = lib === 'QSYS' || lib === 'QSYS2';
    return {
      library: lib, object: s(r, 'OBJNAME'), type: s(r, 'OBJTYPE'), owner: s(r, 'OBJOWNER'), creator: s(r, 'OBJDEFINER'), created: ymd(asDate(r.OBJCREATED)), text: s(r, 'OBJTEXT'),
      level: (sys ? 'high' : 'info') as Level,
      why: sys ? T('In {0}: an IBM library that a release upgrade may replace, and that is not saved with your libraries.', lib)
        : T('In QGPL: shared by everyone and easy to lose track of; your own library is a better home.'),
    };
  }).sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1) || a.library.localeCompare(b.library) || a.object.localeCompare(b.object));
}

// ---------------------------------------------------------------- 5. Environment variables

const ENV_NOTES: [RegExp, string][] = [
  [/^JAVA_HOME$/, 'The Java (JDK) used by Java programs and QShell; it must exist under /QOpenSys/QIBM/ProdData/JavaVM.'],
  [/^QIBM_QSH_CMD_OUTPUT$/, 'Where QSH CMD(…) writes its output: STDOUT, NONE, FILE=path or FILEAPPEND=path.'],
  [/^QIBM_QSH_CMD_ESCAPE_MSG$/, 'Y: a QSH command that fails sends escape message QSH0005 that CL can monitor.'],
  [/^QIBM_MULTI_THREADED$/, 'Y lets QShell and PASE start threads (needed by Java and many open-source tools).'],
  [/^QIBM_PASE_CCSID$/, 'The CCSID PASE programs use for text (1208 is UTF-8).'],
  [/^QIBM_USE_DESCRIPTOR_STDIO$/, 'Y makes the standard input and output of ILE programs work like in PASE.'],
  [/^PASE_PATH$|^PATH$/, 'Folders searched for commands: a missing /QOpenSys/pkgs/bin hides the open-source tools.'],
  [/^LANG$|^LC_ALL$/, 'The locale (language and character set) of PASE and Java programs.'],
  [/^TZ$/, 'The time zone of PASE programs; if it differs from QTIMZON, times in logs disagree.'],
  [/^QIBM_JAVA_PROPERTIES_FILE$/, 'An extra SystemDefault.properties for every Java program.'],
];
/** What a well-known environment variable is for (empty for the others). */
export const envNote = (variable: string): string => ENV_NOTES.find(([re]) => re.test(variable.toUpperCase()))?.[1] ?? '';
