// Active Jobs Map and Journal Activity Heat Map. Layout and grouping come from core/systemVisuals.ts and the
// treemap from core/visuals.ts; clicks open the job log, Work with Active Jobs or the journal explorer — nothing is
// changed on the IBM i from these pages.
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { ActiveJob, activeJobsMapSql, heatLevel, hourBuckets, JOB_STATES, JobMetric, jobState, JobState, jobsBySubsystem, jobValue, journalActivitySql, journalHeat } from '../core/systemVisuals';
import { isValidSystemName } from '../core/util';
import { squarify } from '../core/visuals';
import { page } from './visualsView';
import { escapeHtml } from './webviewUtil';

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => String(r[k] ?? '').trim();
const num = (r: Row, k: string) => { const v = Number(r[k]); return isFinite(v) ? v : 0; };
const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);
const opts = { enableScripts: true, retainContextWhenHidden: true };
const fail = (e: unknown) => { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); };

// ---------------------------------------------------------------- Active Jobs Map

const STATE_COLOR: Record<JobState, string> = { reply: '#e15759', lock: '#f28e2b', running: '#59a14f', waiting: '#4e79a7', held: '#b07aa1', other: '#79706e' };
const stateLabel = (s: JobState) => ({ reply: t('Waiting for a reply (MSGW)'), lock: t('Lock wait'), running: t('Running'), waiting: t('Waiting'), held: t('Held'), other: t('Other') })[s];
const metricLabel = (m: JobMetric) => ({ cpu: t('CPU time'), temp: t('Temporary storage'), threads: t('Threads'), io: t('Disk I/O') })[m];
const fmtMetric = (m: JobMetric, v: number) => m === 'cpu' ? `${(v / 1000).toFixed(1)} s` : m === 'temp' ? `${v} MB` : String(v);

class JobsMap {
  private static current: JobsMap | undefined;
  private jobs: ActiveJob[] = []; private metric: JobMetric = 'cpu'; private timer: NodeJS.Timeout | undefined; private busy = false; private auto = false;
  private readonly panel: vscode.WebviewPanel;

  static open(manager: ConnectionManager): void {
    if (JobsMap.current) { JobsMap.current.panel.reveal(); return; }
    JobsMap.current = new JobsMap(manager);
  }

  private constructor(private readonly manager: ConnectionManager) {
    this.panel = vscode.window.createWebviewPanel('vanthrex.jobsMap', t('Active Jobs Map'), vscode.ViewColumn.Active, opts);
    this.panel.onDidDispose(() => { if (this.timer) { clearInterval(this.timer); } JobsMap.current = undefined; });
    this.panel.webview.onDidReceiveMessage(m => void this.message(m));
    void this.load();
  }

  private async message(m: { type?: string; job?: string; metric?: string; auto?: boolean }): Promise<void> {
    try {
      if (m?.type === 'refresh') { await this.load(); }
      else if (m?.type === 'metric' && ['cpu', 'temp', 'threads', 'io'].includes(String(m.metric))) { this.metric = m.metric as JobMetric; this.render(); }
      else if (m?.type === 'auto') {
        this.auto = !!m.auto; if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
        if (this.auto) { this.timer = setInterval(() => void this.load(), 15000); }
      } else if (m?.type === 'job' && typeof m.job === 'string') { await vscode.commands.executeCommand('vanthrex.jobLog', { job: m.job }); }
      else if (m?.type === 'work' && typeof m.job === 'string') {
        const [, user, job] = m.job.split('/');
        await vscode.commands.executeCommand('vanthrex.wrkactjob', { user, job });
      }
    } catch (e) { fail(e); }
  }

  private async load(): Promise<void> {
    if (this.busy) { return; }
    this.busy = true;
    if (!this.jobs.length) { this.panel.webview.html = page(t('Active Jobs Map'), `<div class="empty">${escapeHtml(t('Reading the active jobs…'))}</div>`); }
    try {
      const rows = await this.manager.require().rows<Row>(activeJobsMapSql(), 5000);
      this.jobs = rows.map(r => ({ job: str(r, 'JOB'), subsystem: str(r, 'SBS'), user: str(r, 'USR'), type: str(r, 'TYPE'), status: str(r, 'STATUS'), fn: str(r, 'FN'),
        cpuMs: num(r, 'CPU'), tempMb: num(r, 'TMP'), threads: num(r, 'THREADS'), io: num(r, 'IO') }));
      this.render();
    } catch (e) {
      logError(e);
      this.panel.webview.html = page(t('Active Jobs Map'), `<div class="err">${escapeHtml(errorMessage(e))}</div><div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>`);
    } finally { this.busy = false; }
  }

  private render(): void {
    const W = 1000; const H = 560; const metric = this.metric;
    // A job with 0 of the metric still gets a sliver, so every job can be seen and clicked.
    const val = (j: ActiveJob) => jobValue(j, metric) + 1e-6;
    const groups = jobsBySubsystem(this.jobs, metric);
    const outer = squarify(groups.map(g => g.jobs.reduce((s, j) => s + val(j), 0)), 0, 0, W, H);
    const pct = (n: number, of: number) => `${(n / of * 100).toFixed(3)}%`;
    let tiles = '';
    groups.forEach((g, gi) => {
      const b = outer[gi]; if (b.w < 1 || b.h < 1) { return; }
      // The subsystem name floats over the top-left of its area (drawn after its jobs), so it never takes space from them.
      const groupBox = `<div class="g" style="left:${pct(b.x, W)};top:${pct(b.y, H)};width:${pct(b.w, W)};height:${pct(b.h, H)}">` +
        `${b.w > 50 && b.h > 25 ? `<em>${escapeHtml(g.subsystem)} · ${g.jobs.length}${g.replies ? ` · ⚠ ${g.replies}` : ''}</em>` : ''}</div>`;
      const inner = squarify(g.jobs.map(val), b.x + 1, b.y + 1, Math.max(0, b.w - 2), Math.max(0, b.h - 2));
      g.jobs.forEach((j, i) => {
        const r = inner[i]; if (r.w < 0.3 || r.h < 0.3) { return; }
        const st = jobState(j.status);
        const tip = `${j.job}\n${j.subsystem || '-'} · ${j.type} · ${j.status}${j.fn ? ` · ${j.fn}` : ''}\n${t('CPU time')}: ${fmtMetric('cpu', j.cpuMs)} · ${t('Temporary storage')}: ${j.tempMb} MB · ${t('Threads')}: ${j.threads} · ${t('Disk I/O')}: ${j.io}\n${t('Click: job log · Right-click: Work with Active Jobs')}`;
        const label = r.w > 50 && r.h > 16 ? `<span>${escapeHtml(j.job.split('/')[2] ?? j.job)}${r.h > 30 ? `<small>${escapeHtml(j.status)} · ${escapeHtml(fmtMetric(metric, jobValue(j, metric)))}</small>` : ''}</span>` : '';
        tiles += `<div class="t${st === 'reply' ? ' pulse' : ''}" data-job="${escapeHtml(j.job)}" data-find="${escapeHtml(`${j.job} ${j.subsystem} ${j.status} ${j.fn}`.toUpperCase())}" style="left:${pct(r.x, W)};top:${pct(r.y, H)};width:${pct(r.w, W)};height:${pct(r.h, H)};background:${STATE_COLOR[st]}" title="${escapeHtml(tip)}">${label}</div>`;
      });
      tiles += groupBox;
    });
    const counts = new Map<JobState, number>(); for (const j of this.jobs) { const s = jobState(j.status); counts.set(s, (counts.get(s) ?? 0) + 1); }
    const legend = JOB_STATES.filter(s => counts.get(s)).map(s => `<span class="k"><i class="sw" style="background:${STATE_COLOR[s]}"></i>${escapeHtml(stateLabel(s))} · ${counts.get(s)}</span>`).join('');
    const replies = this.jobs.filter(j => jobState(j.status) === 'reply');
    const top = [...this.jobs].sort((a, b) => jobValue(b, metric) - jobValue(a, metric)).slice(0, 10);
    const row = (j: ActiveJob) => `<tr class="click" data-job="${escapeHtml(j.job)}"><td><i class="sw" style="background:${STATE_COLOR[jobState(j.status)]}"></i> ${escapeHtml(j.job)}</td><td>${escapeHtml(j.subsystem)}</td><td>${escapeHtml(j.status)}</td><td>${escapeHtml(j.fn)}</td><td class="n">${escapeHtml(fmtMetric(metric, jobValue(j, metric)))}</td></tr>`;
    const metrics = (['cpu', 'temp', 'threads', 'io'] as JobMetric[]).map(m => `<button data-metric="${m}" class="${m === metric ? 'on' : ''}">${escapeHtml(metricLabel(m))}</button>`).join('');
    const body = `
<div class="tiles">
  <div class="tile"><b>${this.jobs.length}</b><span>${escapeHtml(t('Active jobs'))}</span></div>
  <div class="tile"><b>${groups.length}</b><span>${escapeHtml(t('Subsystems'))}</span></div>
  <div class="tile"><b class="${replies.length ? 'err' : ''}">${replies.length}</b><span>${escapeHtml(t('Waiting for a reply'))}</span></div>
  <div class="tile"><b>${counts.get('lock') ?? 0}</b><span>${escapeHtml(t('Lock wait'))}</span></div>
  <div class="tile"><b>${this.jobs.reduce((s, j) => s + j.tempMb, 0)} MB</b><span>${escapeHtml(t('Temporary storage'))}</span></div>
</div>
<div class="bar"><span class="dim">${escapeHtml(t('Size by'))}</span>${metrics}<input id="find" placeholder="${escapeHtml(t('Highlight jobs…'))}" size="18">
<label><input type="checkbox" id="auto" ${this.auto ? 'checked' : ''}> ${escapeHtml(t('Refresh every 15 seconds'))}</label><button id="refresh">${escapeHtml(t('Refresh'))}</button>
<span class="dim">${escapeHtml(t('Updated {0}', new Date().toLocaleTimeString()))}</span></div>
<div class="legend">${legend}</div>
${tiles ? `<div class="map" id="map">${tiles}</div>` : `<div class="empty">${escapeHtml(t('No active job.'))}</div>`}
${replies.length ? `<h3 class="err">${escapeHtml(t('Waiting for a reply'))}</h3><p class="dim">${escapeHtml(t('Right-click a job to open Work with Active Jobs, where option 7 answers the message.'))}</p><table>${replies.map(row).join('')}</table>` : ''}
<h3>${escapeHtml(t('Top 10 by {0}', metricLabel(metric)))}</h3><table>${top.map(row).join('')}</table>`;
    this.panel.webview.html = page(t('Active Jobs Map'), body, `
  .dim { color: var(--vscode-descriptionForeground); } h3.err, b.err { color: var(--vscode-errorForeground); } label { display: inline-flex; gap: 4px; align-items: center; }
  .map { position: relative; width: 100%; aspect-ratio: 1000 / 560; max-height: 72vh; background: var(--vscode-editorWidget-background); border-radius: 4px; overflow: hidden; }
  .g { position: absolute; box-sizing: border-box; border: 2px solid var(--vscode-editor-background); pointer-events: none; z-index: 3; }
  .g em { position: absolute; left: 0; top: 0; max-width: calc(100% - 4px); font-style: normal; font-size: 11px; font-weight: 600; padding: 1px 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; background: rgba(0,0,0,.6); border-bottom-right-radius: 4px; }
  .t { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background); overflow: hidden; cursor: pointer; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.55); font-size: 11px; }
  .t span { display: block; padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .t small { display: block; opacity: .85; }
  .t:hover { filter: brightness(1.18); outline: 2px solid var(--vscode-focusBorder); z-index: 2; }
  .pulse { animation: pulse 1.6s ease-in-out infinite; } @keyframes pulse { 50% { filter: brightness(1.35); } } @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  .map.finding .t { opacity: .18; } .map.finding .t.hit { opacity: 1; }`, `
document.querySelectorAll('[data-metric]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'metric', metric: b.dataset.metric }));
document.getElementById('auto').onchange = e => vscode.postMessage({ type: 'auto', auto: e.target.checked });
const find = document.getElementById('find');
find.oninput = () => { const q = find.value.trim().toUpperCase(); const map = document.getElementById('map'); if (!map) return; map.classList.toggle('finding', !!q); for (const t of map.querySelectorAll('.t')) t.classList.toggle('hit', !!q && t.dataset.find.includes(q)); };
document.addEventListener('click', e => { const j = e.target.closest('[data-job]'); if (j) vscode.postMessage({ type: 'job', job: j.dataset.job }); });
document.addEventListener('contextmenu', e => { const j = e.target.closest('[data-job]'); if (j) { e.preventDefault(); vscode.postMessage({ type: 'work', job: j.dataset.job }); } });`);
  }
}

// ---------------------------------------------------------------- Journal Activity Heat Map

const HEAT = ['var(--empty)', 'rgba(242,142,43,.25)', 'rgba(242,142,43,.45)', 'rgba(242,142,43,.65)', 'rgba(242,142,43,.85)', 'rgba(225,87,89,1)'];

async function journalHeatMap(manager: ConnectionManager, a: unknown): Promise<void> {
  const node = a as { library?: string; name?: string; type?: string } | undefined;
  let jlib: string | undefined; let jrn: string | undefined;
  if (node?.library && node?.name && String(node.type ?? '').toUpperCase() === '*JRN') { jlib = node.library; jrn = node.name; }
  else {
    const v = await vscode.window.showInputBox({
      title: t('Journal Activity Heat Map of which journal?'), placeHolder: 'APPLIB/APPJRN', prompt: t('Library/journal: shows which tables changed, hour by hour.'),
      validateInput: x => { const [l, j] = x.trim().toUpperCase().split('/'); return l && j && isValidSystemName(l) && isValidSystemName(j) ? undefined : t('Type it as LIBRARY/JOURNAL.'); },
    });
    if (!v) { return; }
    [jlib, jrn] = v.trim().toUpperCase().split('/');
  }
  const library = jlib!.toUpperCase(); const journal = jrn!.toUpperCase();
  const conn = manager.require();
  const title = t('Journal Activity: {0}/{1}', library, journal);
  const panel = vscode.window.createWebviewPanel('vanthrex.journalHeatMap', title, vscode.ViewColumn.Active, opts);
  let hours = 24;
  const toolbar = () => `<div class="bar"><select id="hours">${[[6, t('Last 6 hours')], [24, t('Last 24 hours')], [72, t('Last 3 days')], [168, t('Last 7 days')]]
    .map(([h, l]) => `<option value="${h}" ${h === hours ? 'selected' : ''}>${escapeHtml(String(l))}</option>`).join('')}</select><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>`;
  const script = `document.getElementById('hours').onchange = e => vscode.postMessage({ type: 'hours', hours: Number(e.target.value) });
document.addEventListener('click', e => { const c = e.target.closest('[data-table]'); if (c) vscode.postMessage({ type: 'table', table: c.dataset.table }); });`;
  const load = async () => {
    panel.webview.html = page(title, toolbar() + `<div class="empty">${escapeHtml(t('Reading the journal… (a busy journal over several days takes a while)'))}</div>`, '', script);
    try {
      const rows = await conn.rows<{ OBJ: string; HR: string; INS: number; UPD: number; DEL: number; NOW: string }>(journalActivitySql(library, journal, hours), 50000);
      const now = rows[0]?.NOW ?? (await conn.rows<{ N: string }>(`VALUES VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYYY-MM-DD HH24')`, 1))[0]?.N ?? new Date().toISOString().slice(0, 13).replace('T', ' ');
      const buckets = hourBuckets(String(now), hours);
      const heat = journalHeat(rows, buckets);
      const totals = heat.rows.reduce((s, r) => ({ ins: s.ins + r.ins, upd: s.upd + r.upd, del: s.del + r.del }), { ins: 0, upd: 0, del: 0 });
      const perHour = buckets.map((_, i) => heat.rows.reduce((s, r) => s + r.cells[i], 0));
      const peak = perHour.indexOf(Math.max(...perHour));
      const CW = Math.max(8, Math.min(22, Math.floor(860 / hours))); const RH = 18; const LBL = 190; const TOP = 30;
      const Wd = LBL + hours * CW + 170; const Hd = TOP + heat.rows.length * RH + 4;
      const step = hours <= 24 ? 3 : hours <= 72 ? 12 : 24;
      const ticks = buckets.map((b, i) => (Number(b.slice(11, 13)) % step === 0) ? `<text x="${LBL + i * CW}" y="12" class="ax">${escapeHtml(b.slice(11, 13) === '00' ? b.slice(5, 10) : b.slice(11, 13) + ':00')}</text><line x1="${LBL + i * CW}" y1="16" x2="${LBL + i * CW}" y2="${Hd}" class="gl"/>` : '').join('');
      const maxTotal = Math.max(1, ...heat.rows.map(r => r.total));
      const svg = `<svg viewBox="0 0 ${Wd} ${Hd}" width="${Wd}" role="img" aria-label="${escapeHtml(title)}">${ticks}` + heat.rows.map((r, ri) => {
        const y = TOP + ri * RH;
        const cells = r.cells.map((v, i) => `<rect x="${LBL + i * CW + 1}" y="${y}" width="${CW - 2}" height="${RH - 3}" rx="2" fill="${HEAT[heatLevel(v, heat.max)]}"><title>${escapeHtml(`${r.table} · ${buckets[i]}:00 · ${t('{0} changes', v)}`)}</title></rect>`).join('');
        const bx = LBL + hours * CW + 8; const bw = 110;
        const seg = (n: number, off: number, c: string) => n ? `<rect x="${bx + off}" y="${y + 2}" width="${(n / maxTotal * bw).toFixed(1)}" height="${RH - 7}" fill="${c}"/>` : '';
        const wi = r.ins / maxTotal * bw; const wu = r.upd / maxTotal * bw;
        return `<g class="row" data-table="${escapeHtml(r.table)}"><text x="0" y="${y + 12}" class="lb">${escapeHtml(r.table)}</text>${cells}` +
          seg(r.ins, 0, '#59a14f') + seg(r.upd, wi, '#4e79a7') + seg(r.del, wi + wu, '#e15759') +
          `<text x="${bx + bw + 6}" y="${y + 12}" class="ax">${r.total}</text><title>${escapeHtml(`${r.table}: ${t('{0} inserts, {1} updates, {2} deletes', r.ins, r.upd, r.del)} · ${t('Click for the journal entries')}`)}</title></g>`;
      }).join('') + `</svg>`;
      const body = toolbar() + `
<div class="tiles">
  <div class="tile"><b>${heat.rows.length + heat.others}</b><span>${escapeHtml(t('Tables changed'))}</span></div>
  <div class="tile"><b>${totals.ins}</b><span>${escapeHtml(t('Inserts'))}</span></div>
  <div class="tile"><b>${totals.upd}</b><span>${escapeHtml(t('Updates'))}</span></div>
  <div class="tile"><b>${totals.del}</b><span>${escapeHtml(t('Deletes'))}</span></div>
  <div class="tile"><b>${perHour[peak] ? escapeHtml(buckets[peak].slice(5) + ':00') : '-'}</b><span>${escapeHtml(t('Busiest hour ({0} changes)', perHour[peak] ?? 0))}</span></div>
</div>
<div class="legend"><span class="dim">${escapeHtml(t('Changes per hour'))}</span>${HEAT.map(c => `<i class="sw" style="background:${c}"></i>`).join('')}
<span class="k"><i class="sw" style="background:#59a14f"></i>${escapeHtml(t('Inserts'))}</span><span class="k"><i class="sw" style="background:#4e79a7"></i>${escapeHtml(t('Updates'))}</span><span class="k"><i class="sw" style="background:#e15759"></i>${escapeHtml(t('Deletes'))}</span></div>
${heat.rows.length ? `<div class="chart">${svg}</div>` : `<div class="empty">${escapeHtml(t('No row change in this period. Is the table journaled to this journal, with the receivers still attached?'))}</div>`}
${heat.others ? `<p class="dim">${escapeHtml(t('{0} quieter tables are not shown.', heat.others))}</p>` : ''}
<p class="dim">${escapeHtml(t('Click a table for its journal entries (who changed which row, from which program).'))}</p>`;
      panel.webview.html = page(title, body, `
  :root { --empty: var(--vscode-editorWidget-background); } .dim { color: var(--vscode-descriptionForeground); }
  .chart { overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px; }
  .ax { fill: var(--vscode-descriptionForeground); font-size: 10px; } .lb { fill: var(--vscode-foreground); font-size: 11px; } .gl { stroke: var(--vscode-panel-border); }
  .row { cursor: pointer; } .row:hover .lb { fill: var(--vscode-textLink-foreground); text-decoration: underline; }`, script);
    } catch (e) { logError(e); panel.webview.html = page(title, toolbar() + `<div class="err">${escapeHtml(errorMessage(e))}</div>`, '', script); }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; hours?: number; table?: string }) => {
    try {
      if (m?.type === 'refresh') { await load(); }
      else if (m?.type === 'hours') { hours = [6, 24, 72, 168].includes(Number(m.hours)) ? Number(m.hours) : 24; await load(); }
      else if (m?.type === 'table' && typeof m.table === 'string') {
        const [l, n] = m.table.split('/');
        if (l && n && isValidSystemName(l) && isValidSystemName(n)) { await vscode.commands.executeCommand('vanthrex.journalExplorer', { library: l, name: n, type: '*FILE' }); }
      }
    } catch (e) { fail(e); }
  });
  await load();
}

export function registerSystemVisuals(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (a?: unknown) => Promise<void> | void) => async (a?: unknown) => { try { await fn(a); } catch (e) { fail(e); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.jobsMap', wrap(() => { manager.require(); JobsMap.open(manager); })),
    vscode.commands.registerCommand('vanthrex.journalHeatMap', wrap(a => journalHeatMap(manager, a))),
  );
}
