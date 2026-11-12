// System Checks (3.3): one menu of the system checks, and five new report pages — backup freshness, sign-on
// problems, job descriptions that name a user, user objects in IBM libraries and environment variables. Every page only reads; the fixes open the CL prompter (F4) so nothing runs without a look.
import * as vscode from 'vscode';
import { backupFreshness, envNote, jobdUsers, Level, signonProblems, Text, userObjectsInIbmLibraries } from '../core/systemChecks';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row, k: string) => String(r[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.backupFreshness', 'vanthrex.signonProblems', 'vanthrex.jobdUsers', 'vanthrex.ibmLibraryObjects',
  'vanthrex.environmentVariables', 'vanthrex.promptCl', 'vanthrex.jobLog', 'vanthrex.objectInfo', 'vanthrex.checkAuthority', 'vanthrex.wrkUserProfiles']);
const tr = (t: Text) => vscode.l10n.t(t.text, ...t.args);
const cls = (l: Level) => (l === 'high' ? 'bad' : l === 'medium' ? 'different' : undefined);
const levelName = (l: Level) => (l === 'high' ? vscode.l10n.t('High') : l === 'medium' ? vscode.l10n.t('Medium') : vscode.l10n.t('Info'));
const count = (xs: { level: Level }[], l: Level) => xs.filter(x => x.level === l).length;

async function backups(manager: ConnectionManager): Promise<void> {
  const days = vscode.workspace.getConfiguration('vanthrex').get<number>('backupDays', 7);
  const rows = await reportProgress('backupFreshness', vscode.l10n.t('Reading when each library was last saved…'), () => manager.require().rows<Row>(
    "SELECT OBJNAME, SAVE_TIMESTAMP, CHANGE_TIMESTAMP, OBJCREATED, COALESCE(OBJTEXT, '') AS OBJTEXT FROM TABLE(QSYS2.OBJECT_STATISTICS('*ALLUSR', '*LIB')) L WHERE OBJNAME NOT IN ('QTEMP')", 20000));
  const list = backupFreshness(rows, new Date(), days);
  const text = new Map(rows.map(r => [s(r, 'OBJNAME'), s(r, 'OBJTEXT')]));
  showReport('backupFreshness', {
    title: vscode.l10n.t('Backup freshness'),
    subtitle: vscode.l10n.t('{0} user librar(ies): {1} never saved, {2} not saved for more than {3} days.', list.length, list.filter(x => x.days === null).length, list.filter(x => x.days !== null && x.days > days).length, days),
    facts: [[vscode.l10n.t('Never saved'), list.filter(x => x.days === null).length], [vscode.l10n.t('Older than {0} days', days), list.filter(x => x.days !== null && x.days > days).length], [vscode.l10n.t('Saved recently'), count(list, 'info')]],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.backupFreshness' }],
    tables: [{ title: vscode.l10n.t('Libraries'), filter: true, columns: ['Level', 'Library', 'Last saved', 'Days', 'Changed', 'Finding', 'Text'],
      rows: list.map(x => [levelName(x.level), x.library, x.saved || '—', x.days, x.changed, tr(x.text), text.get(x.library) ?? '']),
      rowActions: list.map(x => ({ label: vscode.l10n.t('Info'), command: 'vanthrex.objectInfo', args: [{ library: 'QSYS', name: x.library, type: '*LIB' }] })),
      rowClass: list.map(x => cls(x.level)), empty: vscode.l10n.t('No user library.') }],
    note: vscode.l10n.t('The date of the last SAVLIB or SAVCHGOBJ of each library (QSYS2.OBJECT_STATISTICS). A library saved by a backup product that does not record the save date shows as never saved. The limit is the setting vanthrex.backupDays.'),
  }, ALLOWED);
}

async function signon(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const data = await reportProgress('signonProblems', vscode.l10n.t('Reading the user profiles…'), async () => {
    const [users, sv] = await Promise.all([
      conn.rows<Row>('SELECT * FROM QSYS2.USER_INFO WHERE SIGN_ON_ATTEMPTS_NOT_VALID > 0 OR STATUS = \'*DISABLED\' OR DATE_PASSWORD_EXPIRES < CURRENT TIMESTAMP + 8 DAYS ' +
        'OR USER_EXPIRATION_DATE < CURRENT TIMESTAMP + 15 DAYS', 20000)
        .catch(() => conn.rows<Row>("SELECT * FROM QSYS2.USER_INFO WHERE SIGN_ON_ATTEMPTS_NOT_VALID > 0 OR STATUS = '*DISABLED' OR DATE_PASSWORD_EXPIRES < CURRENT TIMESTAMP + 8 DAYS", 20000)),
      conn.rows<Row>("SELECT CURRENT_NUMERIC_VALUE AS N FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME = 'QMAXSIGN'", 1).catch(() => [] as Row[]),
    ]);
    return { users, max: Number(sv[0]?.N ?? 0) };
  });
  const list = signonProblems(data.users, data.max, new Date());
  showReport('signonProblems', {
    title: vscode.l10n.t('Sign-on problems'),
    subtitle: vscode.l10n.t('{0} problem(s): {1} user(s) cannot sign on now, {2} soon may not.', list.length, count(list, 'high'), count(list, 'medium')),
    facts: [[vscode.l10n.t('Invalid attempts allowed (QMAXSIGN)'), data.max || '*NOMAX']],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.signonProblems' }, { label: vscode.l10n.t('Work with User Profiles'), command: 'vanthrex.wrkUserProfiles' }],
    tables: [{ title: vscode.l10n.t('Users'), filter: true, columns: ['Level', 'User', 'Problem', 'Last sign-on', 'Text', 'Fix'],
      rows: list.map(x => [levelName(x.level), x.user, tr(x.text), x.lastSignon, x.text2, x.fix]),
      rowActions: list.map(x => (x.fix ? { label: vscode.l10n.t('Fix (F4)…'), command: 'vanthrex.promptCl', args: [x.fix] } : undefined)),
      rowClass: list.map(x => cls(x.level)), empty: vscode.l10n.t('Every user can sign on.') }],
    note: vscode.l10n.t('From QSYS2.USER_INFO (needs *SECADM or *ALLOBJ to see every profile). A fix opens the command prompt first: nothing changes until you press Enter there.'),
  }, ALLOWED);
}

async function jobds(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const data = await reportProgress('jobdUsers', vscode.l10n.t('Reading job descriptions…'), async () => {
    const rows = await conn.rows<Row>("SELECT JOB_DESCRIPTION_LIBRARY, JOB_DESCRIPTION, USER_PROFILE FROM QSYS2.JOB_DESCRIPTION_INFO WHERE USER_PROFILE <> '*RQD'", 5000);
    const libs = [...new Set(rows.map(r => s(r, 'JOB_DESCRIPTION_LIBRARY')))];
    const pub = new Map<string, string>();
    for (let i = 0; i < libs.length; i += 50) {
      const part = libs.slice(i, i + 50);
      const p = await conn.rows<Row>(`SELECT SYSTEM_OBJECT_SCHEMA AS L, SYSTEM_OBJECT_NAME AS N, OBJECT_AUTHORITY AS A FROM QSYS2.OBJECT_PRIVILEGES WHERE SYSTEM_OBJECT_SCHEMA IN (${part.map(sqlString).join(', ')}) ` +
        "AND OBJECT_TYPE = '*JOBD' AND AUTHORIZATION_NAME = '*PUBLIC'", 20000).catch(() => [] as Row[]);
      p.forEach(r => pub.set(`${s(r, 'L')}/${s(r, 'N')}`, s(r, 'A')));
    }
    const powerful = await conn.rows<Row>("SELECT AUTHORIZATION_NAME AS U FROM QSYS2.USER_INFO WHERE SPECIAL_AUTHORITIES LIKE '%*ALLOBJ%' OR SPECIAL_AUTHORITIES LIKE '%*SECADM%'", 5000).catch(() => [] as Row[]);
    return { rows, pub, powerful: new Set(powerful.map(r => s(r, 'U'))) };
  });
  const list = jobdUsers(data.rows, data.pub, data.powerful);
  showReport('jobdUsers', {
    title: vscode.l10n.t('Job descriptions that name a user'),
    subtitle: vscode.l10n.t('{0} job description(s) run as a named user instead of USER(*RQD): {1} high, {2} medium.', list.length, count(list, 'high'), count(list, 'medium')),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.jobdUsers' }],
    tables: [{ title: vscode.l10n.t('Job descriptions'), filter: true, columns: ['Level', 'Library', 'Job description', 'User', '*PUBLIC', 'Finding'],
      rows: list.map(x => [levelName(x.level), x.library, x.jobd, x.user, x.publicAut, tr(x.text)]),
      rowActions: list.map(x => ({ label: vscode.l10n.t('Authority'), command: 'vanthrex.checkAuthority', args: [{ library: x.library, name: x.jobd, type: '*JOBD' }] })),
      rowClass: list.map(x => cls(x.level)), empty: vscode.l10n.t('Every job description asks for the user (*RQD).') }],
    note: vscode.l10n.t('A job submitted with such a job description (SBMJOB … JOBD(x) USER(*JOBD)) runs as its user. Give *PUBLIC *EXCLUDE, or use USER(*RQD), unless that is intended.'),
  }, ALLOWED);
}

async function ibmLibs(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await reportProgress('ibmLibraryObjects', vscode.l10n.t('Reading QSYS, QSYS2 and QGPL…'), async () => {
    const out: Row[] = [];
    for (const lib of ['QSYS', 'QSYS2', 'QGPL']) {
      out.push(...await conn.rows<Row>(`SELECT '${lib}' AS LIB, OBJNAME, OBJTYPE, OBJOWNER, COALESCE(OBJDEFINER, '') AS OBJDEFINER, OBJCREATED, COALESCE(OBJTEXT, '') AS OBJTEXT ` +
        `FROM TABLE(QSYS2.OBJECT_STATISTICS('${lib}', '*PGM *SRVPGM *CMD *FILE *DTAARA *DTAQ *MSGF *JOBD *MODULE *USRSPC')) O ` +
        "WHERE OBJOWNER NOT LIKE 'Q%' OR (OBJDEFINER IS NOT NULL AND OBJDEFINER NOT LIKE 'Q%' AND OBJDEFINER <> '*IBM')", 20000).catch(() => [] as Row[]));
    }
    return out;
  });
  const list = userObjectsInIbmLibraries(rows);
  showReport('ibmLibraryObjects', {
    title: vscode.l10n.t('User objects in IBM libraries'),
    subtitle: vscode.l10n.t('{0} object(s) created or owned by your profiles in QSYS, QSYS2 or QGPL; {1} in QSYS or QSYS2.', list.length, count(list, 'high')),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.ibmLibraryObjects' }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Library', 'Object', 'Type', 'Owner', 'Created by', 'Created', 'Why it matters', 'Text'],
      rows: list.map(x => [x.library, x.object, x.type, x.owner, x.creator, x.created, tr(x.why), x.text]),
      rowActions: list.map(x => ({ label: vscode.l10n.t('Info'), command: 'vanthrex.objectInfo', args: [{ library: x.library, name: x.object, type: x.type }] })),
      rowClass: list.map(x => cls(x.level)), empty: vscode.l10n.t('No user object in the IBM libraries.') }],
    note: vscode.l10n.t('Move them to a library of your own (and put it on the library list) before the next release upgrade.'),
  }, ALLOWED);
}

async function envVars(manager: ConnectionManager): Promise<void> {
  const rows = await reportProgress('environmentVariables', vscode.l10n.t('Reading environment variables…'), () => manager.require().rows<Row>(
    'SELECT ENVIRONMENT_VARIABLE_TYPE AS T, ENVIRONMENT_VARIABLE_NAME AS N, ENVIRONMENT_VARIABLE_VALUE AS V FROM QSYS2.ENVIRONMENT_VARIABLE_INFO ORDER BY ENVIRONMENT_VARIABLE_TYPE DESC, ENVIRONMENT_VARIABLE_NAME', 2000));
  const note = (v: string) => { const x = envNote(v); return x ? vscode.l10n.t(x) : ''; };
  showReport('environmentVariables', {
    title: vscode.l10n.t('Environment variables'),
    subtitle: vscode.l10n.t('{0} variable(s): the system-level ones (ADDENVVAR LEVEL(*SYS)) are given to every new job; the job-level ones are those of the SQL job of this connection.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.environmentVariables' }, { label: vscode.l10n.t('Add a system-level variable (F4)…'), command: 'vanthrex.promptCl', args: ['ADDENVVAR LEVEL(*SYS)'] }],
    tables: [{ title: vscode.l10n.t('Variables'), filter: true, columns: ['Level', 'Name', 'Value', 'What it is for'],
      rows: rows.map(r => [s(r, 'T'), s(r, 'N'), s(r, 'V'), note(s(r, 'N'))]),
      rowActions: rows.map(r => (s(r, 'T') === 'SYSTEM' ? { label: vscode.l10n.t('Change (F4)…'), command: 'vanthrex.promptCl', args: [`CHGENVVAR ENVVAR(${s(r, 'N')}) LEVEL(*SYS)`] } : undefined)),
      rowClass: rows.map(r => (envNote(s(r, 'N')) ? 'different' : undefined)), empty: vscode.l10n.t('No environment variable.') }],
    note: vscode.l10n.t('The well-known variables are marked and explained. A change at the system level applies to jobs started afterwards.'),
  }, ALLOWED);
}

interface Check { label: string; detail: string; command: string }
async function menu(): Promise<void> {
  const checks: Check[] = [
    { label: vscode.l10n.t('$(pulse) System Health Overview'), detail: vscode.l10n.t('Disk, limits, lock waits, messages waiting and the security score on one page'), command: 'vanthrex.healthOverview' },
    { label: vscode.l10n.t('$(archive) Backup freshness'), detail: vscode.l10n.t('User libraries never saved or not saved lately'), command: 'vanthrex.backupFreshness' },
    { label: vscode.l10n.t('$(person) Sign-on problems'), detail: vscode.l10n.t('Users locked out, with invalid attempts, or with a password or profile expired or expiring'), command: 'vanthrex.signonProblems' },
    { label: vscode.l10n.t('$(shield) Job descriptions that name a user'), detail: vscode.l10n.t('Job descriptions anyone may use to run jobs as another user'), command: 'vanthrex.jobdUsers' },
    { label: vscode.l10n.t('$(library) User objects in IBM libraries'), detail: vscode.l10n.t('Your objects in QSYS, QSYS2 or QGPL, at risk on a release upgrade'), command: 'vanthrex.ibmLibraryObjects' },
    { label: vscode.l10n.t('$(symbol-variable) Environment variables'), detail: vscode.l10n.t('System and job environment variables, the well-known ones explained'), command: 'vanthrex.environmentVariables' },
    { label: vscode.l10n.t('$(lock) Lock Wait Chains'), detail: vscode.l10n.t('Which job blocks which, right now'), command: 'vanthrex.lockWaitChains' },
    { label: vscode.l10n.t('$(dashboard) Limits Watch'), detail: vscode.l10n.t('What is close to an IBM i limit'), command: 'vanthrex.limitsWatch' },
    { label: vscode.l10n.t('$(error) Failed jobs'), detail: vscode.l10n.t('Jobs that ended abnormally'), command: 'vanthrex.failedJobs' },
    { label: vscode.l10n.t('$(server) System diagnostics'), detail: vscode.l10n.t('Problems logged, recently ended jobs, temporary storage, watches and Java virtual machines'), command: 'vanthrex.systemDiagnostics' },
    { label: vscode.l10n.t('$(key) Security configuration'), detail: vscode.l10n.t('Security attributes, certificates and exit points'), command: 'vanthrex.securityConfig' },
    { label: vscode.l10n.t('$(package) Fix currency'), detail: vscode.l10n.t('Firmware level, defective PTFs and CVEs not yet fixed'), command: 'vanthrex.fixCurrency' },
    { label: vscode.l10n.t('$(circuit-board) Hardware and devices'), detail: vscode.l10n.t('Lines, controllers, devices and hardware resources, failed ones first'), command: 'vanthrex.hardwareStatus' },
    { label: vscode.l10n.t('$(globe) Network configuration'), detail: vscode.l10n.t('TCP/IP, network attributes and the Telnet, SMTP, NTP and HTTP servers'), command: 'vanthrex.networkConfig' },
    { label: vscode.l10n.t('$(server-process) Subsystem setup'), detail: vscode.l10n.t('Autostart and prestart jobs, routing and job queue entries of a subsystem'), command: 'vanthrex.subsystemSetup' },
    { label: vscode.l10n.t('$(save-all) Save files and tapes'), detail: vscode.l10n.t('Save files with what and when they saved, tape cartridges and media libraries'), command: 'vanthrex.saveMedia' },
  ];
  const all = await vscode.commands.getCommands(true);
  const pick = await vscode.window.showQuickPick(checks.filter(c => all.includes(c.command)), { title: vscode.l10n.t('System Checks'), placeHolder: vscode.l10n.t('What do you want to check?'), matchOnDetail: true });
  if (pick) { await vscode.commands.executeCommand(pick.command); }
}

export function registerSystemChecks(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.systemChecks', wrap(menu)),
    vscode.commands.registerCommand('vanthrex.backupFreshness', wrap(() => backups(manager))),
    vscode.commands.registerCommand('vanthrex.signonProblems', wrap(() => signon(manager))),
    vscode.commands.registerCommand('vanthrex.jobdUsers', wrap(() => jobds(manager))),
    vscode.commands.registerCommand('vanthrex.ibmLibraryObjects', wrap(() => ibmLibs(manager))),
    vscode.commands.registerCommand('vanthrex.environmentVariables', wrap(() => envVars(manager))),
  );
}
