// Security Audit Journal (QAUDJRN hour by hour), Disk Units Map (SYSDISKSTAT), Embedded SQL Statement Statistics
// (SYSPROGRAMSTMTSTAT) and the "vanthrex" VS Code task type. Layout and parsing come from core/platformInsights.ts;
// the pages only read — nothing is changed on the IBM i from them.
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import {
  aspSummary, auditActivitySql, auditEventsSql, auditHeat, AuditSeverity, auditType, auditUsersSql, busyLevel, checkTask, DiskUnit, diskUnitsSql,
  expandTaskVariables, fileVariables, fillLevel, Level, programStatementsSql, sizeLabel, statementHint, statementStats, terminalText,
} from '../core/platformInsights';
import { heatLevel, hourBuckets } from '../core/systemVisuals';
import { isValidSystemName } from '../core/util';
import { showReport } from './reportPanel';
import { page } from './visualsView';
import { escapeHtml } from './webviewUtil';

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => String(r[k] ?? '').trim();
const num = (r: Row, k: string) => { const v = Number(r[k]); return isFinite(v) ? v : 0; };
const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);
const opts = { enableScripts: true, retainContextWhenHidden: true };
const fail = (e: unknown) => { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); };

// ---------------------------------------------------------------- Security Audit Journal

const SEV_COLOR: Record<AuditSeverity, string> = { alert: '225,87,89', change: '242,142,43', info: '78,121,167' };
const sevLabel = (s: AuditSeverity) => ({ alert: t('Failures and alerts'), change: t('Security changes'), info: t('Other activity') })[s];

async function auditJournalMap(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const title = t('Security Audit Journal');
  const panel = vscode.window.createWebviewPanel('vanthrex.auditJournalMap', title, vscode.ViewColumn.Active, opts);
  let hours = 24;
  const toolbar = () => `<div class="bar"><select id="hours">${[[6, t('Last 6 hours')], [24, t('Last 24 hours')], [72, t('Last 3 days')], [168, t('Last 7 days')]]
    .map(([h, l]) => `<option value="${h}" ${h === hours ? 'selected' : ''}>${escapeHtml(String(l))}</option>`).join('')}</select><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>`;
  const script = `document.getElementById('hours').onchange = e => vscode.postMessage({ type: 'hours', hours: Number(e.target.value) });
document.addEventListener('click', e => { const c = e.target.closest('[data-job]'); if (c) vscode.postMessage({ type: 'job', job: c.dataset.job }); });`;
  const load = async () => {
    panel.webview.html = page(title, toolbar() + `<div class="empty">${escapeHtml(t('Reading the audit journal QAUDJRN…'))}</div>`, '', script);
    try {
      const [rows, users, events] = await Promise.all([
        conn.rows<{ TYPE: string; HR: string; N: number; NOW: string }>(auditActivitySql(hours), 50000),
        conn.rows<Row>(auditUsersSql(hours)),
        conn.rows<Row>(auditEventsSql(hours)),
      ]);
      const now = rows[0]?.NOW ?? (await conn.rows<{ N: string }>(`VALUES VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYYY-MM-DD HH24')`, 1))[0]?.N ?? new Date().toISOString().slice(0, 13).replace('T', ' ');
      const buckets = hourBuckets(String(now), hours);
      const heat = auditHeat(rows, buckets);
      const CW = Math.max(8, Math.min(22, Math.floor(860 / hours))); const RH = 18; const LBL = 260; const TOP = 30;
      const Wd = LBL + hours * CW + 70; const Hd = TOP + heat.rows.length * RH + 4;
      const step = hours <= 24 ? 3 : hours <= 72 ? 12 : 24;
      const ticks = buckets.map((b, i) => (Number(b.slice(11, 13)) % step === 0) ? `<text x="${LBL + i * CW}" y="12" class="ax">${escapeHtml(b.slice(11, 13) === '00' ? b.slice(5, 10) : b.slice(11, 13) + ':00')}</text><line x1="${LBL + i * CW}" y1="16" x2="${LBL + i * CW}" y2="${Hd}" class="gl"/>` : '').join('');
      const svg = `<svg viewBox="0 0 ${Wd} ${Hd}" width="${Wd}" role="img" aria-label="${escapeHtml(title)}">${ticks}` + heat.rows.map((r, ri) => {
        const y = TOP + ri * RH; const rgb = SEV_COLOR[r.severity];
        const cells = r.cells.map((v, i) => {
          const lv = heatLevel(v, heat.max);
          return `<rect x="${LBL + i * CW + 1}" y="${y}" width="${CW - 2}" height="${RH - 3}" rx="2" fill="${lv ? `rgba(${rgb},${(0.15 + lv * 0.17).toFixed(2)})` : 'var(--vscode-editorWidget-background)'}"><title>${escapeHtml(`${r.type} ${t(r.label)} · ${buckets[i]}:00 · ${t('{0} entries', v)}`)}</title></rect>`;
        }).join('');
        return `<g><circle cx="5" cy="${y + 8}" r="4" fill="rgb(${rgb})"/><text x="14" y="${y + 12}" class="lb"><tspan class="code">${escapeHtml(r.type)}</tspan> ${escapeHtml(t(r.label))}</text>${cells}` +
          `<text x="${LBL + hours * CW + 8}" y="${y + 12}" class="ax">${r.total}</text></g>`;
      }).join('') + `</svg>`;
      const userRows = users.map(u => `<tr><td>${escapeHtml(str(u, 'USR'))}</td><td class="n">${num(u, 'N')}</td><td class="n ${num(u, 'AF') ? 'bad' : ''}">${num(u, 'AF')}</td><td class="n ${num(u, 'PW') ? 'bad' : ''}">${num(u, 'PW')}</td><td class="n">${num(u, 'CHG')}</td></tr>`).join('');
      const eventRows = events.map(e => {
        const [label, sev] = auditType(str(e, 'TYPE'));
        return `<tr class="click" data-job="${escapeHtml(str(e, 'JOB'))}" title="${escapeHtml(t('Click for the job log'))}"><td>${escapeHtml(str(e, 'TS'))}</td><td><i class="sw" style="background:rgb(${SEV_COLOR[sev]})"></i> ${escapeHtml(str(e, 'TYPE'))} ${escapeHtml(t(label))}</td><td>${escapeHtml(str(e, 'USR'))}</td><td>${escapeHtml(str(e, 'JOB'))}</td><td>${escapeHtml(str(e, 'PGM'))}</td></tr>`;
      }).join('');
      const body = toolbar() + `
<div class="tiles">
  <div class="tile"><b>${heat.rows.reduce((s, r) => s + r.total, 0)}</b><span>${escapeHtml(t('Audit entries'))}</span></div>
  <div class="tile"><b class="${heat.bySeverity.alert ? 'bad' : ''}">${heat.bySeverity.alert}</b><span>${escapeHtml(sevLabel('alert'))}</span></div>
  <div class="tile"><b>${heat.bySeverity.change}</b><span>${escapeHtml(sevLabel('change'))}</span></div>
  <div class="tile"><b>${heat.bySeverity.info}</b><span>${escapeHtml(sevLabel('info'))}</span></div>
  <div class="tile"><b>${heat.rows.length}</b><span>${escapeHtml(t('Entry types'))}</span></div>
</div>
<div class="legend">${(['alert', 'change', 'info'] as AuditSeverity[]).map(s => `<span class="k"><i class="sw" style="background:rgb(${SEV_COLOR[s]})"></i>${escapeHtml(sevLabel(s))}</span>`).join('')}<span class="dim">${escapeHtml(t('The darker the square, the more entries in that hour.'))}</span></div>
${heat.rows.length ? `<div class="chart">${svg}</div>` : `<div class="empty">${escapeHtml(t('No audit entry in this period. Is auditing on (system value QAUDCTL) with the receivers still attached?'))}</div>`}
<div class="cols">
<div><h3>${escapeHtml(t('Users with the most entries'))}</h3><table><tr><th>${escapeHtml(t('User'))}</th><th>${escapeHtml(t('Entries'))}</th><th>AF</th><th>PW</th><th>${escapeHtml(t('Changes'))}</th></tr>${userRows}</table></div>
<div><h3>${escapeHtml(t('Latest failures and security changes'))}</h3>${events.length ? `<table><tr><th>${escapeHtml(t('Time'))}</th><th>${escapeHtml(t('Entry'))}</th><th>${escapeHtml(t('User'))}</th><th>${escapeHtml(t('Job'))}</th><th>${escapeHtml(t('Program'))}</th></tr>${eventRows}</table>` : `<div class="empty">${escapeHtml(t('None in this period.'))}</div>`}</div>
</div>
<p class="dim">${escapeHtml(t('Reading QAUDJRN needs *AUDIT or *ALLOBJ special authority. Click an entry for the job log of its job.'))}</p>`;
      panel.webview.html = page(title, body, `
  .dim { color: var(--vscode-descriptionForeground); } .bad { color: var(--vscode-errorForeground); }
  .chart { overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px; }
  .ax { fill: var(--vscode-descriptionForeground); font-size: 10px; } .lb { fill: var(--vscode-foreground); font-size: 11px; } .code { font-weight: 700; }
  .gl { stroke: var(--vscode-panel-border); } .cols { display: flex; flex-wrap: wrap; gap: 8px 36px; } .cols > div { min-width: 0; max-width: 100%; overflow-x: auto; }`, script);
    } catch (e) {
      logError(e);
      panel.webview.html = page(title, toolbar() + `<div class="err">${escapeHtml(errorMessage(e))}</div><p class="empty">${escapeHtml(t('Reading QAUDJRN needs *AUDIT or *ALLOBJ special authority. Click an entry for the job log of its job.'))}</p>`, '', script);
    }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; hours?: number; job?: string }) => {
    try {
      if (m?.type === 'refresh') { await load(); }
      else if (m?.type === 'hours') { hours = [6, 24, 72, 168].includes(Number(m.hours)) ? Number(m.hours) : 24; await load(); }
      else if (m?.type === 'job' && typeof m.job === 'string' && /^\d{6}\/[^/]+\/[^/]+$/.test(m.job)) { await vscode.commands.executeCommand('vanthrex.jobLog', { job: m.job }); }
    } catch (e) { fail(e); }
  });
  await load();
}

// ---------------------------------------------------------------- Disk Units Map

const LEVEL_COLOR: Record<Level, string> = { ok: '#59a14f', warn: '#f28e2b', bad: '#e15759' };

async function diskUnitsMap(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const title = t('Disk Units Map');
  const panel = vscode.window.createWebviewPanel('vanthrex.diskUnitsMap', title, vscode.ViewColumn.Active, opts);
  const toolbar = `<div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>`;
  const load = async () => {
    panel.webview.html = page(title, toolbar + `<div class="empty">${escapeHtml(t('Reading the disk units…'))}</div>`);
    try {
      const units: DiskUnit[] = (await conn.rows<Row>(diskUnitsSql())).map(r => ({
        asp: num(r, 'ASP'), unit: num(r, 'UNIT'), resource: str(r, 'RES'), type: str(r, 'DTYPE'), model: str(r, 'MODEL'), ssd: num(r, 'SSD') === 1,
        capacity: num(r, 'CAP'), available: num(r, 'AVAIL'), pctUsed: num(r, 'PCT'), pctBusy: num(r, 'BUSY'),
      }));
      const asps = aspSummary(units);
      const total = asps.reduce((s, a) => ({ cap: s.cap + a.capacity, used: s.used + a.used }), { cap: 0, used: 0 });
      const unit = (u: DiskUnit) => {
        const fl = fillLevel(u.pctUsed); const bl = busyLevel(u.pctBusy);
        const tip = `${t('Unit {0}', u.unit)} ${u.resource} · ${u.type}-${u.model}${u.ssd ? ' SSD' : ''}\n${t('{0} % used of {1}, {2} free', u.pctUsed.toFixed(1), sizeLabel(u.capacity), sizeLabel(u.available))}\n${t('{0} % busy', u.pctBusy.toFixed(1))}`;
        return `<div class="unit" title="${escapeHtml(tip)}"><div class="can"><div class="fill" style="height:${Math.min(100, u.pctUsed)}%;background:${LEVEL_COLOR[fl]}"></div><span>${u.pctUsed.toFixed(0)}%</span></div>` +
          `<div class="busy"><div style="width:${Math.min(100, u.pctBusy)}%;background:${LEVEL_COLOR[bl]}"></div></div><small>${u.unit}${u.ssd ? ' ⚡' : ''}</small><small class="dim">${escapeHtml(u.resource)}</small></div>`;
      };
      const aspBlock = asps.map(a => `<section><h3>${escapeHtml(a.asp === 1 ? t('System ASP (1)') : t('ASP {0}', a.asp))}
 <span class="dim">· ${escapeHtml(t('{0} units, {1} of {2} used ({3} %)', a.units.length, sizeLabel(a.used), sizeLabel(a.capacity), a.pctUsed))}</span></h3>
<div class="meter"><div style="width:${Math.min(100, a.pctUsed)}%;background:${LEVEL_COLOR[fillLevel(a.pctUsed)]}"></div></div>
${a.spread > 10 ? `<p class="warn">${escapeHtml(t('The units are filled unevenly ({0} points apart): STRASPBAL TYPE(*CAPACITY) balances them.', a.spread))}</p>` : ''}
${a.busiest >= 40 ? `<p class="warn">${escapeHtml(t('A disk arm is {0} % busy: jobs wait for the disk. Look at the jobs with the most I/O in the Active Jobs Map.', a.busiest.toFixed(0)))}</p>` : ''}
<div class="units">${a.units.map(unit).join('')}</div></section>`).join('');
      const body = toolbar + `
<div class="tiles">
  <div class="tile"><b>${units.length}</b><span>${escapeHtml(t('Disk units'))}</span></div>
  <div class="tile"><b>${asps.length}</b><span>${escapeHtml(t('ASPs'))}</span></div>
  <div class="tile"><b>${escapeHtml(sizeLabel(total.cap))}</b><span>${escapeHtml(t('Capacity'))}</span></div>
  <div class="tile"><b style="color:${LEVEL_COLOR[fillLevel(total.cap ? total.used / total.cap * 100 : 0)]}">${total.cap ? (total.used / total.cap * 100).toFixed(1) : 0} %</b><span>${escapeHtml(t('Used'))}</span></div>
  <div class="tile"><b>${units.filter(u => u.ssd).length}</b><span>${escapeHtml(t('Solid-state units'))}</span></div>
</div>
<div class="legend"><span class="k"><i class="sw" style="background:${LEVEL_COLOR.ok}"></i>${escapeHtml(t('OK'))}</span><span class="k"><i class="sw" style="background:${LEVEL_COLOR.warn}"></i>${escapeHtml(t('80 % used or 40 % busy'))}</span><span class="k"><i class="sw" style="background:${LEVEL_COLOR.bad}"></i>${escapeHtml(t('90 % used or 60 % busy'))}</span>
<span class="dim">${escapeHtml(t('Each can shows how full the unit is; the bar under it, how busy its disk arm is.'))}</span></div>
${units.length ? aspBlock : `<div class="empty">${escapeHtml(t('No disk unit found.'))}</div>`}`;
      panel.webview.html = page(title, body, `
  .dim { color: var(--vscode-descriptionForeground); } .warn { color: #f28e2b; margin: 4px 0; }
  section { margin: 14px 0 6px; } h3 { margin: 4px 0; font-weight: 600; } h3 .dim { font-weight: 400; }
  .meter, .busy { height: 6px; background: var(--vscode-editorWidget-background); border-radius: 3px; overflow: hidden; } .meter { max-width: 600px; margin: 4px 0 8px; }
  .meter > div, .busy > div { height: 100%; }
  .units { display: flex; flex-wrap: wrap; gap: 10px; } .unit { width: 54px; text-align: center; font-size: 11px; }
  .can { position: relative; height: 70px; border: 1px solid var(--vscode-panel-border); border-radius: 6px 6px 3px 3px; overflow: hidden; background: var(--vscode-editorWidget-background); margin-bottom: 4px; }
  .can .fill { position: absolute; left: 0; right: 0; bottom: 0; opacity: .85; } .can span { position: absolute; left: 0; right: 0; top: 26px; font-weight: 600; }
  .unit small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`);
    } catch (e) { logError(e); panel.webview.html = page(title, toolbar + `<div class="err">${escapeHtml(errorMessage(e))}</div>`); }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string }) => { try { if (m?.type === 'refresh') { await load(); } } catch (e) { fail(e); } });
  await load();
}

// ---------------------------------------------------------------- Embedded SQL statement statistics

async function sqlStatementStats(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const node = a as { library?: string; name?: string; type?: string } | undefined;
  let library = typeof a === 'string' ? a : node?.library;
  let program = node?.name && /^\*(PGM|SRVPGM)$/i.test(node.type ?? '') ? node.name : undefined;
  if (!library) {
    const v = await vscode.window.showInputBox({
      title: t('Embedded SQL statistics of which library or program?'), value: conn.profile.currentLibrary?.toUpperCase() ?? '',
      prompt: t('LIBRARY, or LIBRARY/PROGRAM for one program.'),
      validateInput: s => s.trim().toUpperCase().split('/').every(x => isValidSystemName(x)) && s.split('/').length <= 2 ? undefined : t('Type LIBRARY or LIBRARY/PROGRAM.'),
    });
    if (!v) { return; }
    [library, program] = v.trim().toUpperCase().split('/');
  }
  library = library.toUpperCase(); program = program?.toUpperCase();
  const { stats, hasTimes } = statementStats(await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Reading the SQL statement statistics…') },
    () => conn.rows<Row>(programStatementsSql(library!, program), 20000)));
  const ms = (v: number | null) => v === null ? '' : v.toFixed(v < 10 ? 2 : 0);
  const totalRuns = stats.reduce((s, x) => s + x.executions, 0);
  const programs = new Set(stats.map(s => s.program)).size;
  showReport('sqlStatementStats', {
    title: t('Embedded SQL — {0}', program ? `${library}/${program}` : library),
    subtitle: hasTimes ? t('Every SQL statement in the programs, slowest in total first.') : t('Every SQL statement in the programs, most run first (this release keeps no times).'),
    facts: [
      [t('Programs with SQL'), programs], [t('Statements'), stats.length], [t('Runs'), totalRuns],
      [t('Never run'), stats.filter(s => !s.executions).length],
    ],
    tables: [{
      title: t('Statements'), filter: true,
      columns: [t('Program'), t('Type'), t('Module'), t('Statement'), t('Runs'), ...(hasTimes ? [t('Total ms'), t('Average ms'), t('Longest ms')] : []), t('Rebuilds'), t('Hint'), t('SQL')],
      rows: stats.map(s => [s.program, s.type, s.module, s.statement, s.executions, ...(hasTimes ? [ms(s.totalMs), ms(s.avgMs), ms(s.maxMs)] : []), s.rebuilds ?? '', statementHint(s) ? t(statementHint(s)) : '', s.text]),
      rowClass: stats.map(s => statementHint(s) ? 'bad' : undefined),
      empty: t('No statement statistics. The library has no program with embedded SQL, or none has run since the statistics were last collected.'),
    }],
    note: t('From QSYS2.SYSPROGRAMSTMTSTAT. Statement numbers are those of the compile listing; use Explain SQL on a slow statement to see its access plan.'),
  }, new Set());
}

// ---------------------------------------------------------------- VS Code tasks ("type": "vanthrex")

class IbmiTaskTerminal implements vscode.Pseudoterminal {
  private readonly write = new vscode.EventEmitter<string>();
  private readonly done = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.write.event;
  readonly onDidClose = this.done.event;
  constructor(private readonly manager: ConnectionManager, private readonly def: Record<string, unknown>) {}

  open(): void { void this.run(); }
  close(): void { /* the command keeps running on the IBM i until it ends */ }

  private out(s: string) { this.write.fire(terminalText(s.endsWith('\n') ? s : s + '\n')); }

  private async run(): Promise<void> {
    const c = checkTask(this.def);
    if (!c.ok) { this.out(`\x1b[31m${t(c.error)}\x1b[0m`); this.done.fire(1); return; }
    try {
      const conn = this.manager.require();
      const editor = vscode.window.activeTextEditor?.document.uri;
      const folder = editor ? vscode.workspace.getWorkspaceFolder(editor) : undefined;
      const rel = editor && folder ? path.relative(folder.uri.fsPath, editor.fsPath) : editor ? path.basename(editor.fsPath) : '';
      const command = expandTaskVariables(c.task.command, {
        CURLIB: conn.profile.currentLibrary?.toUpperCase() ?? '', USER: conn.profile.user.toUpperCase(), HOST: conn.profile.host, ...(rel ? fileVariables(rel) : {}),
      });
      this.out(`\x1b[2m${conn.profile.name} · ${c.task.kind.toUpperCase()}\x1b[0m\n> ${command}`);
      const started = Date.now();
      let code: number;
      if (c.task.kind === 'pase') {
        const r = await conn.exec(c.task.cwd ? `cd ${JSON.stringify(c.task.cwd)} && ${command}` : command);
        if (r.stdout) { this.out(r.stdout); } if (r.stderr) { this.out(`\x1b[33m${r.stderr}\x1b[0m`); }
        code = r.code;
      } else {
        const r = await conn.runCL(command, c.task.libraries);
        if (r.stdout.trim()) { this.out(r.stdout); } if (r.stderr.trim()) { this.out(`\x1b[33m${r.stderr}\x1b[0m`); }
        code = r.ok ? 0 : (r.code || 1);
        if (r.messages.length) { this.out(t('Messages: {0}', r.messages.join(', '))); }
      }
      this.out(code === 0 ? `\x1b[32m${t('Ended normally in {0} s.', ((Date.now() - started) / 1000).toFixed(1))}\x1b[0m` : `\x1b[31m${t('Ended with exit code {0}.', code)}\x1b[0m`);
      this.done.fire(code);
    } catch (e) { logError(e); this.out(`\x1b[31m${errorMessage(e)}\x1b[0m`); this.done.fire(1); }
  }
}

function ibmiTask(def: vscode.TaskDefinition, name: string, scope: vscode.WorkspaceFolder | vscode.TaskScope, manager: ConnectionManager): vscode.Task {
  const task = new vscode.Task(def, scope, name, 'vanthrex', new vscode.CustomExecution(async resolved => new IbmiTaskTerminal(manager, resolved as unknown as Record<string, unknown>)), []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  return task;
}

/** Ready-made tasks shown by "Run Task" and "Configure Task"; the user copies them to tasks.json and changes them. */
function providedTasks(manager: ConnectionManager): vscode.Task[] {
  const scope = vscode.workspace.workspaceFolders?.[0] ?? vscode.TaskScope.Workspace;
  const make = (name: string, def: Omit<vscode.TaskDefinition, 'type'>) => ibmiTask({ type: 'vanthrex', ...def }, name, scope, manager);
  return [
    make(t('Compile RPG from the IFS into the current library'), { kind: 'cl', command: `CRTBNDRPG PGM(&CURLIB/&NAME) SRCSTMF('&RELATIVEPATH') OPTION(*EVENTF) DBGVIEW(*SOURCE)` }),
    make(t('Build with makei (Bob)'), { kind: 'pase', command: 'makei build' }),
    make(t('Show the library list'), { kind: 'cl', command: 'DSPLIBL OUTPUT(*PRINT)' }),
  ];
}

export function registerPlatformInsights(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (a?: unknown) => Promise<void> | void) => async (a?: unknown) => { try { await fn(a); } catch (e) { fail(e); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.auditJournalMap', wrap(() => auditJournalMap(manager))),
    vscode.commands.registerCommand('vanthrex.diskUnitsMap', wrap(() => diskUnitsMap(manager))),
    vscode.commands.registerCommand('vanthrex.sqlStatementStats', wrap(a => sqlStatementStats(manager, a))),
    vscode.tasks.registerTaskProvider('vanthrex', {
      provideTasks: () => manager.connection ? providedTasks(manager) : [],
      resolveTask: (task: vscode.Task) => ibmiTask(task.definition, task.name, task.scope ?? vscode.TaskScope.Workspace, manager),
    }),
  );
}
