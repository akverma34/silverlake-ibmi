// Report pages on IBM i services the extension did not use yet. Each section reads one service; a service that is
// missing on the release or not allowed with the user's authority shows "Not available" and the others still show.
// Read only: nothing is changed on the IBM i from these pages.
import * as vscode from 'vscode';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import {
  attributes, bySubsystem, endedJobFlag, Flag, FLAGS, isJobName, jobServiceSql, Row, SERVICE_SQL, ServiceId, tableFrom, tempStorageTop, mtiTop,
} from '../core/serviceInsights';
import { Report, ReportTable, reportProgress, showReport } from './reportPanel';

const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);
const COMMANDS = ['networkConfig', 'fixCurrency', 'hardwareStatus', 'subsystemSetup', 'saveMedia', 'systemDiagnostics', 'securityConfig', 'jobInternals', 'temporaryIndexes'];
const ALLOWED = new Set(COMMANDS.map(c => `vanthrex.${c}`));

/** One section of a page: a service read as a table, or a one-row service read as attribute/value pairs. */
interface Section {
  id: ServiceId | string; title: string; sql?: string; kind?: 'table' | 'attrs';
  prefer?: string[]; flag?: (r: Row) => Flag; shape?: (rows: Row[]) => Row[];
}
interface Loaded { section: Section; rows: Row[]; error?: string }

async function read(manager: ConnectionManager, sections: Section[]): Promise<Loaded[]> {
  const conn = manager.require();
  return Promise.all(sections.map(async section => {
    try {
      const rows = await conn.rows<Row>(section.sql ?? SERVICE_SQL[section.id as ServiceId], 5000);
      return { section, rows: section.shape ? section.shape(rows) : rows };
    } catch (e) { log(`${section.title}: ${errorMessage(e)}`); return { section, rows: [], error: errorMessage(e) }; }
  }));
}

function toTable(l: Loaded): ReportTable {
  const { section: s, rows } = l;
  const empty = l.error ? t('Not available: {0}', l.error.split('\n')[0].slice(0, 200)) : t('Nothing to show.');
  if (s.kind === 'attrs') {
    const a = attributes(rows);
    return { title: s.title, columns: [t('Attribute'), t('Value')], rows: a, empty };
  }
  const tb = tableFrom(rows, s.prefer);
  return { title: `${s.title} (${rows.length})`, columns: tb.columns, rows: tb.rows, filter: rows.length > 10, rowClass: s.flag ? rows.map(s.flag) : undefined, empty };
}

async function showPage(manager: ConnectionManager, id: string, title: string, sections: Section[], note: string, subtitle?: (l: Loaded[]) => string, refreshArgs?: unknown[]): Promise<void> {
  const loaded = await reportProgress(id, title, () => read(manager, sections));
  const flagged = loaded.reduce((n, l) => n + (l.section.flag ? l.rows.filter(r => l.section.flag!(r) === 'bad').length : 0), 0);
  const report: Report = {
    title: `${title} — ${manager.require().profile.name}`,
    subtitle: subtitle ? subtitle(loaded) : flagged ? t('{0} row(s) need attention (shown in red).', flagged) : t('Nothing needs attention.'),
    actions: [{ label: t('Refresh'), command: `vanthrex.${id}`, args: refreshArgs }],
    tables: loaded.map(toTable),
    note,
  };
  showReport(id, report, ALLOWED);
}

// ---------------------------------------------------------------- pages

const networkConfig = (m: ConnectionManager) => showPage(m, 'networkConfig', t('Network Configuration'), [
  { id: 'tcpip', title: t('TCP/IP of this connection'), kind: 'attrs' },
  { id: 'networkAttributes', title: t('Network attributes'), kind: 'attrs' },
  { id: 'telnet', title: t('Telnet server'), kind: 'attrs' },
  { id: 'smtp', title: t('SMTP server'), kind: 'attrs' },
  { id: 'timeProtocol', title: t('Time protocol (NTP)'), kind: 'attrs' },
  { id: 'httpServers', title: t('HTTP servers'), prefer: ['SERVER_NAME', 'HTTP_FUNCTION', 'SERVER_STATUS', 'STATUS', 'JOB_NAME', 'SERVER_PORT', 'PORT', 'CONFIGURATION_FILE'] },
  { id: 'rdbEntries', title: t('Relational database entries'), prefer: ['RDB_NAME', 'RDB_ALIAS', 'REMOTE_LOCATION', 'REMOTE_LOCATION_TYPE', 'PORT_NUMBER_OR_SERVICE_NAME', 'PORT', 'TEXT_DESCRIPTION'] },
  { id: 'serverRouting', title: t('Server jobs routed to subsystems'), prefer: ['SERVER_NAME', 'AUTHORIZATION_NAME', 'USER_NAME', 'SUBSYSTEM_NAME', 'SUBSYSTEM', 'ALLOW_ROLLOVER'] },
], t('From QSYS2.TCPIP_INFO, NETWORK_ATTRIBUTE_INFO, TELNET_SERVER_ATTRIBUTES, SMTP_ATTRIBUTES, TIME_PROTOCOL_INFO, HTTP_SERVER_INFO, RDB_ENTRY_INFO and SERVER_SBS_ROUTING.'));

const fixCurrency = (m: ConnectionManager) => showPage(m, 'fixCurrency', t('Fix Currency'), [
  { id: 'firmware', title: t('Firmware'), kind: 'attrs' },
  { id: 'defectivePtfs', title: t('Defective PTFs installed'), flag: () => 'bad' },
  { id: 'cves', title: t('Security vulnerabilities (CVEs)'), flag: FLAGS.cves },
  { id: 'serviceAgent', title: t('Electronic Service Agent'), kind: 'attrs' },
], t('Firmware, defective PTFs and CVEs are compared with IBM\'s lists over the internet by the IBM i itself (QSYS2.FIRMWARE_CURRENCY, DEFECTIVE_PTF_CURRENCY, CVE_CURRENCY); without access to IBM they are not available. CVE_CURRENCY needs a recent Technology Refresh.'));

const hardwareStatus = (m: ConnectionManager) => showPage(m, 'hardwareStatus', t('Hardware and Devices'), [
  { id: 'configStatus', title: t('Lines, controllers and devices'), flag: FLAGS.configStatus, prefer: ['OBJECT_NAME', 'OBJECT_TYPE', 'STATUS_DESCRIPTION', 'STATUS', 'CATEGORY', 'RESOURCE_NAME', 'JOB_NAME', 'TEXT_DESCRIPTION'] },
  { id: 'hardware', title: t('Hardware resources'), flag: FLAGS.hardware, prefer: ['RESOURCE_NAME', 'RESOURCE_KIND', 'RESOURCE_CATEGORY', 'RESOURCE_TYPE', 'RESOURCE_MODEL', 'RESOURCE_STATUS', 'STATUS', 'SERIAL_NUMBER', 'LOCATION', 'TEXT_DESCRIPTION'] },
  { id: 'nvme', title: t('NVMe devices'), flag: FLAGS.nvme },
], t('From QSYS2.CONFIGURATION_STATUS, HARDWARE_RESOURCE_INFO and NVME_INFO. Failed, damaged or recovery-pending objects and failed or missing hardware are shown in red.'));

async function subsystemSetup(m: ConnectionManager, arg?: unknown): Promise<void> {
  const given = typeof arg === 'string' ? arg : (arg as { subsystem?: string } | undefined)?.subsystem;
  const sbs = given ?? await vscode.window.showInputBox({ title: t('Subsystem setup'), prompt: t('Subsystem name, e.g. QBATCH — leave empty for all subsystems'), ignoreFocusOut: true });
  if (sbs === undefined) { return; }
  const name = sbs.trim().toUpperCase();
  if (name && !/^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(name)) { throw new Error(t('Not a valid subsystem name: {0}', sbs)); }
  const only = (rows: Row[]) => bySubsystem(rows, name);
  await showPage(m, 'subsystemSetup', name ? t('Subsystem Setup: {0}', name) : t('Subsystem Setup'), [
    { id: 'autostart', title: t('Autostart jobs'), shape: only },
    { id: 'routing', title: t('Routing entries'), shape: only },
    { id: 'prestart', title: t('Prestart jobs'), shape: only },
    { id: 'jobQueueEntries', title: t('Job queue entries'), shape: only },
    { id: 'workstations', title: t('Workstation entries'), shape: only },
    { id: 'commEntries', title: t('Communications entries'), shape: only },
    { id: 'subsystemPools', title: t('Subsystem pools'), shape: only },
  ], t('From QSYS2.AUTOSTART_JOB_INFO, ROUTING_ENTRY_INFO, PRESTART_JOB_INFO, JOB_QUEUE_ENTRIES, WORKSTATION_INFO, COMMUNICATIONS_ENTRY_INFO and SUBSYSTEM_POOL_INFO: what each subsystem starts, which jobs it accepts and where they run.'),
  l => t('{0} entries.', l.reduce((n, x) => n + x.rows.length, 0)), [name]);
}

const saveMedia = (m: ConnectionManager) => showPage(m, 'saveMedia', t('Save Files and Tapes'), [
  { id: 'saveFiles', title: t('Save files'), prefer: ['SAVE_FILE_LIBRARY', 'SAVE_FILE', 'OBJECTS_SAVED', 'SAVE_TIMESTAMP', 'SAVE_COMMAND', 'TARGET_RELEASE', 'SAVE_FILE_SIZE', 'TEXT_DESCRIPTION'] },
  { id: 'tapes', title: t('Tape cartridges'), flag: FLAGS.tapes },
  { id: 'mediaLibraries', title: t('Media libraries') },
], t('From QSYS2.SAVE_FILE_INFO (the first 2000 save files), TAPE_CARTRIDGE_INFO and MEDIA_LIBRARY_INFO.'));

const systemDiagnostics = (m: ConnectionManager) => showPage(m, 'systemDiagnostics', t('System Diagnostics'), [
  { id: 'problems', title: t('Problems logged'), flag: FLAGS.problems },
  { id: 'endedJobs', title: t('Recently ended jobs'), flag: endedJobFlag, prefer: ['JOB_NAME', 'FROM_JOB', 'JOB_END_CODE', 'END_CODE', 'JOB_END_DETAIL', 'MESSAGE_TIMESTAMP', 'JOB_END_TIMESTAMP', 'PROCESSING_TIME_USED', 'MESSAGE_TEXT'] },
  { id: 'tempStorage', title: t('Largest temporary storage buckets'), shape: rows => tempStorageTop(rows) },
  { id: 'watches', title: t('Active watches (STRWCH)') },
  { id: 'jvms', title: t('Java virtual machines'), prefer: ['JOB_NAME', 'JVM_START_TIME', 'START_TIME', 'CURRENT_HEAP_SIZE', 'IN_USE_HEAP_SIZE', 'MAX_HEAP_SIZE', 'GARBAGE_COLLECTION_POLICY', 'JAVA_HOME'] },
  { id: 'collectionServices', title: t('Collection Services'), kind: 'attrs' },
], t('From QSYS2.PROBLEM_INFO, ENDED_JOB_INFO, SYSTMPSTG, WATCH_INFO, JVM_INFO and COLLECTION_SERVICES_INFO. Jobs that ended abnormally (end code 30 or more) are shown in red.'));

const temporaryIndexes = (m: ConnectionManager) => showPage(m, 'temporaryIndexes', t('Maintained Temporary Indexes'), [
  { id: 'mtis', title: t('Temporary indexes the query engine built'), shape: rows => mtiTop(rows),
    prefer: ['TABLE_SCHEMA', 'TABLE_NAME', 'KEY_DEFINITION', 'QUERY_USE_COUNT', 'QUERY_STATISTICS_COUNT', 'LAST_QUERY_USE', 'MTI_SIZE', 'MTI_CREATE_TIME', 'CREATE_TIME', 'LAST_BUILD_START_TIME', 'REASON_CREATED', 'SPARSE'] },
], t('From QSYS2.MTI_INFO, most used first. The query engine builds these indexes when no permanent index fits and drops them at IPL, so a query that runs often after an IPL pays for the rebuild: create a permanent index on the same keys (Index Advisor shows the CREATE INDEX).'),
  l => t('{0} maintained temporary index(es).', l[0].rows.length));

const securityConfig = (m: ConnectionManager) => showPage(m, 'securityConfig', t('Security Configuration'), [
  { id: 'security', title: t('Security attributes'), kind: 'attrs' },
  { id: 'certificateUsage', title: t('Certificates in use by applications') },
  { id: 'exitPoints', title: t('Exit points'), prefer: ['EXIT_POINT_NAME', 'EXIT_POINT_FORMAT', 'REGISTERED_EXIT_PROGRAMS', 'MAXIMUM_EXIT_PROGRAMS', 'ALLOW_DEREGISTRATION', 'TEXT_DESCRIPTION'] },
], t('From QSYS2.SECURITY_INFO, CERTIFICATE_USAGE_INFO and EXIT_POINT_INFO. Some values need *SECADM or *ALLOBJ.'));

async function jobInternals(m: ConnectionManager, arg?: unknown): Promise<void> {
  const given = typeof arg === 'string' ? arg : (arg as { job?: string } | undefined)?.job;
  const job = given ?? await vscode.window.showInputBox({ title: t('Job internals'), prompt: t('Qualified job name, e.g. 123456/QUSER/QZDASOINIT'), ignoreFocusOut: true, validateInput: v => isJobName(v) ? undefined : t('Use number/user/name, e.g. 123456/QUSER/QZDASOINIT') });
  if (!job) { return; }
  if (!isJobName(job)) { throw new Error(t('Not a valid job name: {0}', job)); }
  await showPage(m, 'jobInternals', t('Job Internals: {0}', job.trim().toUpperCase()), [
    { id: 'openFiles', title: t('Open files'), sql: jobServiceSql('openFiles', job), prefer: ['LIBRARY_NAME', 'FILE_NAME', 'MEMBER_NAME', 'FILE_TYPE', 'OPEN_OPTION', 'OPEN_COUNT', 'RELATIVE_RECORD_NUMBER', 'IO_COUNT', 'WRITE_COUNT', 'READ_COUNT'] },
    { id: 'ifsObjects', title: t('IFS objects in use'), sql: jobServiceSql('ifsObjects', job), prefer: ['PATH_NAME', 'OBJECT_TYPE', 'FILE_ACCESS', 'SHARE_MODE', 'DESCRIPTOR_COUNT', 'IO_COUNT', 'IASP_NAME'] },
    { id: 'dbConnections', title: t('Database connections'), sql: jobServiceSql('dbConnections', job) },
  ], t('From QSYS2.OPEN_FILES, IFS_JOB_INFO and ACTIVE_DB_CONNECTIONS: what the job has open right now. You need *JOBCTL or to own the job.'),
  l => t('{0} open file(s), {1} IFS object(s), {2} database connection(s).', l[0].rows.length, l[1].rows.length, l[2].rows.length), [job.trim().toUpperCase()]);
}

export function registerServiceInsights(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = (fn: (a?: unknown) => Promise<unknown>) => async (a?: unknown) => { try { await fn(a); } catch (e) { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.networkConfig', guard(() => networkConfig(manager))),
    vscode.commands.registerCommand('vanthrex.fixCurrency', guard(() => fixCurrency(manager))),
    vscode.commands.registerCommand('vanthrex.hardwareStatus', guard(() => hardwareStatus(manager))),
    vscode.commands.registerCommand('vanthrex.subsystemSetup', guard(a => subsystemSetup(manager, a))),
    vscode.commands.registerCommand('vanthrex.saveMedia', guard(() => saveMedia(manager))),
    vscode.commands.registerCommand('vanthrex.systemDiagnostics', guard(() => systemDiagnostics(manager))),
    vscode.commands.registerCommand('vanthrex.securityConfig', guard(() => securityConfig(manager))),
    vscode.commands.registerCommand('vanthrex.jobInternals', guard(a => jobInternals(manager, a))),
    vscode.commands.registerCommand('vanthrex.temporaryIndexes', guard(() => temporaryIndexes(manager))),
  );
}
