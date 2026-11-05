// Visual insights, drawn in webviews: the Library Space Map (every object of a library as a tile sized by its disk
// space, coloured by kind or by when it was last used) and the Batch Job Timeline (batch jobs of the last hours as
// bars on a time axis). The layout comes from core/visuals.ts; clicks open the existing object and job-log tools.
import * as vscode from 'vscode';
import { formatSeconds, jobRuns } from '../core/jobHistory';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { formatBytes } from '../core/storage';
import { isValidSystemName } from '../core/util';
import { ageBand, SPACE_GROUPS, SpaceGroup, spaceGroup, spaceMapSql, SpaceObject, spaceSummary, squarify, timelineLayout, timelineSql, timeTicks, tsMillis } from '../core/visuals';
import { escapeHtml, nonce } from './webviewUtil';

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => String(r[k] ?? '').trim();
const CSP = (n: string) => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">`;

const GROUP_COLOR: Record<SpaceGroup, string> = {
  Programs: '#4e79a7', Files: '#59a14f', 'Source files': '#9c755f', 'Save files': '#e15759', Journals: '#b07aa1', Data: '#f28e2b', Other: '#79706e',
};
const AGE_COLOR = ['#59a14f', '#c9a227', '#f28e2b', '#e15759'];
const groupLabel = (g: SpaceGroup): string => ({
  Programs: vscode.l10n.t('Programs'), Files: vscode.l10n.t('Files'), 'Source files': vscode.l10n.t('Source files'), 'Save files': vscode.l10n.t('Save files'),
  Journals: vscode.l10n.t('Journals'), Data: vscode.l10n.t('Data objects'), Other: vscode.l10n.t('Other'),
})[g];
const ageLabels = () => [vscode.l10n.t('Used in the last 30 days'), vscode.l10n.t('31–180 days'), vscode.l10n.t('181–365 days'), vscode.l10n.t('Over a year or never')];

const STYLE = `
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 8px 16px 24px; }
  h2 { margin: 4px 0 2px; font-weight: 600; } .sub { color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
  button, select, input { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 8px; border-radius: 2px; }
  button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; }
  button.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; }
  .tile { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 12px; min-width: 110px; }
  .tile b { display: block; font-size: 1.4em; } .tile span { color: var(--vscode-descriptionForeground); font-size: .9em; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0; }
  .legend .k { cursor: pointer; display: inline-flex; align-items: center; gap: 5px; padding: 1px 4px; border-radius: 3px; }
  .legend[hidden] { display: none; } .legend .k.off { opacity: .35; } .legend .k:hover { background: var(--vscode-list-hoverBackground); }
  .sw { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
  table { border-collapse: collapse; margin-top: 12px; } td, th { text-align: left; padding: 2px 10px 2px 0; } th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.n { text-align: right; } tr.click { cursor: pointer; } tr.click:hover td { background: var(--vscode-list-hoverBackground); }
  .err { color: var(--vscode-errorForeground); } .empty { color: var(--vscode-descriptionForeground); padding: 20px 0; }
`;

// ---------------------------------------------------------------- Library Space Map

const MAP_W = 1000; const MAP_H = 560;

class SpaceMap {
  private static panels = new Map<string, SpaceMap>();
  private objects: SpaceObject[] = [];
  private hidden = new Set<SpaceGroup>();

  static open(manager: ConnectionManager, library: string): void {
    const open = SpaceMap.panels.get(library);
    if (open) { open.panel.reveal(); return; }
    SpaceMap.panels.set(library, new SpaceMap(manager, library));
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly manager: ConnectionManager, private readonly library: string) {
    this.panel = vscode.window.createWebviewPanel('vanthrex.spaceMap', vscode.l10n.t('Space Map: {0}', library), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.onDidDispose(() => SpaceMap.panels.delete(library));
    this.panel.webview.onDidReceiveMessage(m => void this.message(m));
    void this.load();
  }

  private async message(m: { type?: string; name?: string; objType?: string; group?: string }): Promise<void> {
    try {
      if (m?.type === 'refresh') { await this.load(); }
      else if (m?.type === 'toggle' && SPACE_GROUPS.includes(m.group as SpaceGroup)) {
        const g = m.group as SpaceGroup;
        if (this.hidden.has(g)) { this.hidden.delete(g); } else { this.hidden.add(g); }
        this.render();
      } else if (m?.type === 'all') { this.hidden.clear(); this.render(); }
      else if (m?.type === 'object' && typeof m.name === 'string' && typeof m.objType === 'string') {
        await vscode.commands.executeCommand('vanthrex.objectInfo', { library: this.library, name: m.name, type: m.objType });
      }
    } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  }

  private async load(): Promise<void> {
    this.panel.webview.html = page(vscode.l10n.t('Space Map: {0}', this.library), `<div class="empty">${escapeHtml(vscode.l10n.t('Reading the objects of {0}…', this.library))}</div>`);
    try {
      const conn = this.manager.require();
      const rows = await conn.rows<Row>(spaceMapSql(this.library), 5000);
      this.objects = rows.map(r => {
        const unused = r.UNUSED === null || r.UNUSED === undefined ? undefined : Number(r.UNUSED);
        return { name: str(r, 'NAME'), type: str(r, 'TYPE'), attribute: str(r, 'ATTR'), size: Number(r.SIZE) || 0, text: str(r, 'TEXT'), lastUsedDays: unused };
      });
      this.render();
    } catch (e) {
      logError(e);
      this.panel.webview.html = page(vscode.l10n.t('Space Map: {0}', this.library), `<div class="err">${escapeHtml(errorMessage(e))}</div><div class="bar"><button id="refresh">${escapeHtml(vscode.l10n.t('Refresh'))}</button></div>`);
    }
  }

  private render(): void {
    const t = vscode.l10n.t;
    const all = this.objects;
    const total = all.reduce((a, o) => a + o.size, 0);
    const summary = spaceSummary(all);
    const shown = all.filter(o => !this.hidden.has(spaceGroup(o.type, o.attribute)) && o.size > 0);
    const old = all.filter(o => ageBand(o.lastUsedDays) === 3);
    const oldSize = old.reduce((a, o) => a + o.size, 0);
    // Two levels: one block per group, then the objects inside it, so each colour forms one area.
    const groups = summary.filter(s => !this.hidden.has(s.group));
    const outer = squarify(groups.map(g => g.size), 0, 0, MAP_W, MAP_H);
    let tiles = '';
    groups.forEach((g, gi) => {
      const box = outer[gi];
      const members = shown.filter(o => spaceGroup(o.type, o.attribute) === g.group);
      const inner = squarify(members.map(o => o.size), box.x + 1, box.y + 1, Math.max(0, box.w - 2), Math.max(0, box.h - 2));
      members.forEach((o, i) => {
        const r = inner[i];
        if (r.w < 0.4 || r.h < 0.4) { return; }
        const pct = (n: number, of: number) => `${(n / of * 100).toFixed(3)}%`;
        const tip = `${this.library}/${o.name} ${o.type} ${o.attribute}\n${formatBytes(o.size)} (${(o.size / Math.max(1, total) * 100).toFixed(1)}%)` +
          `${o.text ? `\n${o.text}` : ''}\n${o.lastUsedDays === undefined ? t('Never used') : t('Last used {0} days ago', o.lastUsedDays)}`;
        const label = r.w > 46 && r.h > 16 ? `<span>${escapeHtml(o.name)}${r.h > 30 ? `<small>${escapeHtml(formatBytes(o.size))}</small>` : ''}</span>` : '';
        tiles += `<div class="t" data-name="${escapeHtml(o.name)}" data-type="${escapeHtml(o.type)}" data-find="${escapeHtml(`${o.name} ${o.type} ${o.attribute} ${o.text}`.toUpperCase())}" ` +
          `style="left:${pct(r.x, MAP_W)};top:${pct(r.y, MAP_H)};width:${pct(r.w, MAP_W)};height:${pct(r.h, MAP_H)};--g:${GROUP_COLOR[g.group]};--a:${AGE_COLOR[ageBand(o.lastUsedDays)]}" title="${escapeHtml(tip)}">${label}</div>`;
      });
    });
    const legend = SPACE_GROUPS.filter(g => summary.some(s => s.group === g)).map(g => {
      const s = summary.find(x => x.group === g)!;
      return `<span class="k ${this.hidden.has(g) ? 'off' : ''}" data-group="${g}" title="${escapeHtml(t('Click to hide or show'))}"><i class="sw" style="background:${GROUP_COLOR[g]}"></i>${escapeHtml(groupLabel(g))} · ${escapeHtml(formatBytes(s.size))} (${s.count})</span>`;
    }).join('');
    const ageLegend = ageLabels().map((l, i) => `<span class="k"><i class="sw" style="background:${AGE_COLOR[i]}"></i>${escapeHtml(l)}</span>`).join('');
    const top = [...all].sort((a, b) => b.size - a.size).slice(0, 15).map(o =>
      `<tr class="click" data-name="${escapeHtml(o.name)}" data-type="${escapeHtml(o.type)}"><td>${escapeHtml(o.name)}</td><td>${escapeHtml(o.type)}</td><td>${escapeHtml(o.attribute)}</td>` +
      `<td class="n">${escapeHtml(formatBytes(o.size))}</td><td class="n">${(o.size / Math.max(1, total) * 100).toFixed(1)}%</td>` +
      `<td>${escapeHtml(o.lastUsedDays === undefined ? t('never') : String(o.lastUsedDays))}</td><td>${escapeHtml(o.text)}</td></tr>`).join('');
    const body = `
<div class="tiles">
  <div class="tile"><b>${escapeHtml(formatBytes(total))}</b><span>${escapeHtml(t('Total size'))}</span></div>
  <div class="tile"><b>${all.length}</b><span>${escapeHtml(t('Objects'))}</span></div>
  <div class="tile"><b>${escapeHtml(summary[0] ? groupLabel(summary[0].group) : '-')}</b><span>${escapeHtml(t('Biggest kind'))}</span></div>
  <div class="tile"><b>${escapeHtml(formatBytes(oldSize))}</b><span>${escapeHtml(t('Not used for a year ({0} objects)', old.length))}</span></div>
</div>
<div class="bar">
  <button id="byType" class="on">${escapeHtml(t('Colour by kind'))}</button><button id="byAge">${escapeHtml(t('Colour by last used'))}</button>
  <input id="find" placeholder="${escapeHtml(t('Highlight objects…'))}" size="22">
  <button id="all">${escapeHtml(t('Show all kinds'))}</button><button id="refresh">${escapeHtml(t('Refresh'))}</button>
</div>
<div class="legend" id="lg">${legend}</div><div class="legend" id="la" hidden>${ageLegend}</div>
${tiles ? `<div class="map" id="map">${tiles}</div>` : `<div class="empty">${escapeHtml(t('Nothing to show: the library is empty or every kind is hidden.'))}</div>`}
<h3>${escapeHtml(t('Largest objects'))}</h3>
<table><tr><th>${escapeHtml(t('Object'))}</th><th>${escapeHtml(t('Type'))}</th><th>${escapeHtml(t('Attribute'))}</th><th>${escapeHtml(t('Size'))}</th><th>%</th><th>${escapeHtml(t('Days unused'))}</th><th>${escapeHtml(t('Text'))}</th></tr>${top}</table>`;
    this.panel.webview.html = page(vscode.l10n.t('Space Map: {0}', this.library), body, `
  .map { position: relative; width: 100%; aspect-ratio: ${MAP_W} / ${MAP_H}; max-height: 72vh; background: var(--vscode-editorWidget-background); border-radius: 4px; overflow: hidden; }
  .t { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background); background: var(--g); overflow: hidden; cursor: pointer; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.55); font-size: 11px; transition: opacity .15s; }
  body.age .t { background: var(--a); }
  .t span { display: block; padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .t small { display: block; opacity: .85; }
  .t:hover { filter: brightness(1.18); outline: 2px solid var(--vscode-focusBorder); z-index: 2; }
  .map.finding .t { opacity: .18; } .map.finding .t.hit { opacity: 1; }`, `
document.getElementById('byType').onclick = () => { document.body.classList.remove('age'); byType.classList.add('on'); byAge.classList.remove('on'); lg.hidden = false; la.hidden = true; };
document.getElementById('byAge').onclick = () => { document.body.classList.add('age'); byAge.classList.add('on'); byType.classList.remove('on'); lg.hidden = true; la.hidden = false; };
document.getElementById('all').onclick = () => vscode.postMessage({ type: 'all' });
const find = document.getElementById('find');
find.oninput = () => {
  const q = find.value.trim().toUpperCase(); const map = document.getElementById('map'); if (!map) return;
  map.classList.toggle('finding', !!q);
  for (const t of map.children) t.classList.toggle('hit', !!q && t.dataset.find.includes(q));
};
document.addEventListener('click', e => {
  const k = e.target.closest('[data-group]'); if (k) { vscode.postMessage({ type: 'toggle', group: k.dataset.group }); return; }
  const o = e.target.closest('[data-name]'); if (o) vscode.postMessage({ type: 'object', name: o.dataset.name, objType: o.dataset.type });
});`);
  }
}

// ---------------------------------------------------------------- Batch Job Timeline

const TL_W = 1200; const LANE = 20; const AXIS = 22;
const STATE_COLOR = { ok: '#59a14f', failed: '#e15759', running: '#4e79a7', unknown: '#79706e' } as const;

class JobTimeline {
  private static current: JobTimeline | undefined;
  private hours = 24; private jobName = ''; private user = '';

  static open(manager: ConnectionManager): void {
    if (JobTimeline.current) { JobTimeline.current.panel.reveal(); return; }
    JobTimeline.current = new JobTimeline(manager);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly manager: ConnectionManager) {
    this.panel = vscode.window.createWebviewPanel('vanthrex.jobTimeline', vscode.l10n.t('Batch Job Timeline'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.onDidDispose(() => { JobTimeline.current = undefined; });
    this.panel.webview.onDidReceiveMessage(m => void this.message(m));
    void this.load();
  }

  private async message(m: { type?: string; job?: string; hours?: number; jobName?: string; user?: string }): Promise<void> {
    try {
      if (m?.type === 'job' && typeof m.job === 'string') { await vscode.commands.executeCommand('vanthrex.jobLog', { job: m.job }); }
      else if (m?.type === 'history' && typeof m.job === 'string') { await vscode.commands.executeCommand('vanthrex.jobRunHistory', m.job.split('/').pop()); }
      else if (m?.type === 'load') {
        this.hours = Number(m.hours) || 24;
        this.jobName = String(m.jobName ?? '').trim().toUpperCase(); this.user = String(m.user ?? '').trim().toUpperCase();
        await this.load();
      }
    } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  }

  private toolbar(): string {
    const t = vscode.l10n.t;
    const opts = [[6, t('Last 6 hours')], [24, t('Last 24 hours')], [72, t('Last 3 days')], [168, t('Last 7 days')]] as const;
    return `<div class="bar"><select id="hours">${opts.map(([h, l]) => `<option value="${h}" ${h === this.hours ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>` +
      `<input id="jobName" placeholder="${escapeHtml(t('Job name (ORD* allowed)'))}" value="${escapeHtml(this.jobName)}" size="18">` +
      `<input id="user" placeholder="${escapeHtml(t('User'))}" value="${escapeHtml(this.user)}" size="12">` +
      `<button id="go" class="on">${escapeHtml(t('Show'))}</button></div>`;
  }

  private async load(): Promise<void> {
    const t = vscode.l10n.t;
    const title = t('Batch Job Timeline');
    const script = `
const go = () => vscode.postMessage({ type: 'load', hours: Number(document.getElementById('hours').value), jobName: document.getElementById('jobName').value, user: document.getElementById('user').value });
document.getElementById('go').onclick = go;
document.getElementById('hours').onchange = go;
for (const id of ['jobName', 'user']) document.getElementById(id).onkeydown = e => { if (e.key === 'Enter') go(); };
document.addEventListener('click', e => { const b = e.target.closest('[data-job]'); if (b) vscode.postMessage({ type: e.altKey ? 'history' : 'job', job: b.dataset.job }); });
document.addEventListener('contextmenu', e => { const b = e.target.closest('[data-job]'); if (b) { e.preventDefault(); vscode.postMessage({ type: 'history', job: b.dataset.job }); } });`;
    this.panel.webview.html = page(title, this.toolbar() + `<div class="empty">${escapeHtml(t('Reading the history log…'))}</div>`, '', script);
    try {
      if (this.jobName && !/^[A-Z$#@*][A-Z0-9$#@_.*]{0,9}$/.test(this.jobName)) { throw new Error(t('"{0}" is not a valid job name.', this.jobName)); }
      if (this.user && !isValidSystemName(this.user)) { throw new Error(t('"{0}" is not a valid user name.', this.user)); }
      const conn = this.manager.require();
      const rows = await conn.rows<{ ID: string; TS: string; JOB: string; TEXT: string; NOW: string }>(timelineSql(this.hours, { jobName: this.jobName || undefined, user: this.user || undefined }), 20000);
      const nowRow = rows.length ? rows[0].NOW : (await conn.rows<{ NOW: string }>(`VALUES VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')`, 1).catch(() => []))[0]?.NOW;
      const end = nowRow ? tsMillis(String(nowRow)) : Date.now();
      const start = end - this.hours * 3600000;
      const runs = jobRuns(rows);
      const { bars, lanes } = timelineLayout(runs, start, end, TL_W);
      const ticks = timeTicks(start, end, TL_W);
      const H = AXIS + Math.max(1, lanes) * LANE + 4;
      const failed = bars.filter(b => b.state === 'failed'); const running = bars.filter(b => b.state === 'running');
      const finished = bars.filter(b => b.seconds !== undefined);
      const longest = [...finished].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0));
      const cpu = bars.reduce((a, b) => a + (b.cpuSeconds ?? 0), 0);
      const stateText = { ok: t('Ended normally'), failed: t('Ended abnormally'), running: t('Still running'), unknown: t('Ended') };
      const svg = `<svg viewBox="0 0 ${TL_W} ${H}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="${escapeHtml(title)}">` +
        ticks.map(k => `<line x1="${k.x.toFixed(1)}" y1="${AXIS - 4}" x2="${k.x.toFixed(1)}" y2="${H}" class="${k.day ? 'grid day' : 'grid'}"/><text x="${(k.x + 3).toFixed(1)}" y="13" class="tick">${escapeHtml(k.label)}</text>`).join('') +
        bars.map(b => {
          const y = AXIS + b.lane * LANE;
          const tip = `${b.job}\n${stateText[b.state]}${b.endCode !== undefined ? ` (${t('end code {0}', b.endCode)})` : ''}\n${b.started ?? t('started before the window')} → ${b.ended ?? t('still running')}` +
            `${b.seconds !== undefined ? `\n${t('Elapsed: {0}', formatSeconds(b.seconds))}` : ''}${b.cpuSeconds !== undefined ? `\n${t('CPU: {0} s', b.cpuSeconds)}` : ''}\n${t('Click: job log · Right-click: run history')}`;
          return `<g data-job="${escapeHtml(b.job)}" class="b"><rect x="${b.x.toFixed(1)}" y="${y}" width="${b.w.toFixed(1)}" height="${LANE - 4}" rx="3" fill="${STATE_COLOR[b.state]}"/>` +
            (b.w > 60 ? `<text x="${(b.x + 4).toFixed(1)}" y="${y + 12}" class="lbl">${escapeHtml(b.name)}</text>` : '') + `<title>${escapeHtml(tip)}</title></g>`;
        }).join('') + `</svg>`;
      const row = (b: typeof bars[number]) => `<tr class="click" data-job="${escapeHtml(b.job)}"><td><i class="sw" style="background:${STATE_COLOR[b.state]}"></i> ${escapeHtml(b.job)}</td>` +
        `<td>${escapeHtml(b.started ?? '')}</td><td>${escapeHtml(b.ended ?? '')}</td><td class="n">${escapeHtml(formatSeconds(b.seconds))}</td><td class="n">${b.cpuSeconds ?? ''}</td><td>${b.endCode ?? ''}</td></tr>`;
      const head = `<tr><th>${escapeHtml(t('Job'))}</th><th>${escapeHtml(t('Started'))}</th><th>${escapeHtml(t('Ended'))}</th><th>${escapeHtml(t('Elapsed'))}</th><th>${escapeHtml(t('CPU s'))}</th><th>${escapeHtml(t('End code'))}</th></tr>`;
      const body = this.toolbar() + `
<div class="tiles">
  <div class="tile"><b>${bars.length}</b><span>${escapeHtml(t('Job runs'))}</span></div>
  <div class="tile"><b class="${failed.length ? 'err' : ''}">${failed.length}</b><span>${escapeHtml(t('Ended abnormally'))}</span></div>
  <div class="tile"><b>${running.length}</b><span>${escapeHtml(t('Still running'))}</span></div>
  <div class="tile"><b>${escapeHtml(longest[0] ? formatSeconds(longest[0].seconds) : '-')}</b><span>${escapeHtml(longest[0] ? t('Longest: {0}', longest[0].name) : t('Longest run'))}</span></div>
  <div class="tile"><b>${Math.round(cpu)}</b><span>${escapeHtml(t('CPU seconds in total'))}</span></div>
</div>
<div class="legend">${(['ok', 'failed', 'running'] as const).map(s => `<span class="k"><i class="sw" style="background:${STATE_COLOR[s]}"></i>${escapeHtml(stateText[s])}</span>`).join('')}
<span class="k">${escapeHtml(t('Times are the system\'s ({0}).', nowRow ? t('now {0}', String(nowRow)) : '-'))}</span></div>
${bars.length ? `<div class="chart">${svg}</div>` : `<div class="empty">${escapeHtml(t('No batch job started or ended in this period (history log messages CPF1124 / CPF1164).'))}</div>`}
${failed.length ? `<h3>${escapeHtml(t('Ended abnormally'))}</h3><table>${head}${failed.map(row).join('')}</table>` : ''}
${longest.length ? `<h3>${escapeHtml(t('Longest runs'))}</h3><table>${head}${longest.slice(0, 10).map(row).join('')}</table>` : ''}`;
      this.panel.webview.html = page(title, body, `
  .chart { overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px; background: var(--vscode-editorWidget-background); }
  .chart svg { min-width: 1100px; display: block; }
  .grid { stroke: var(--vscode-panel-border); stroke-width: 1; } .grid.day { stroke: var(--vscode-descriptionForeground); stroke-dasharray: 4 3; }
  .tick { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .lbl { fill: #fff; font-size: 11px; pointer-events: none; }
  .b { cursor: pointer; } .b:hover rect { filter: brightness(1.2); stroke: var(--vscode-focusBorder); stroke-width: 2; }
  b.err { color: var(--vscode-errorForeground); }`, script);
    } catch (e) {
      logError(e);
      this.panel.webview.html = page(title, this.toolbar() + `<div class="err">${escapeHtml(errorMessage(e))}</div>`, '', script);
    }
  }
}

function page(title: string, body: string, css = '', script = ''): string {
  const n = nonce();
  const refresh = `const r = document.getElementById('refresh'); if (r) r.onclick = () => vscode.postMessage({ type: 'refresh' });`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">${CSP(n)}<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<style>${STYLE}${css}</style><title>${escapeHtml(title)}</title></head><body><h2>${escapeHtml(title)}</h2>${body}` +
    `<script nonce="${n}">const vscode = acquireVsCodeApi();${refresh}${script}</script></body></html>`;
}

/** The library of a tree node, a "LIB" string, or asked (the current library first). */
async function libraryArg(manager: ConnectionManager, a: unknown): Promise<string | undefined> {
  const given = typeof a === 'string' ? a : (a as { library?: string } | undefined)?.library;
  const conn = manager.require();
  const lib = (given ?? await vscode.window.showInputBox({
    title: vscode.l10n.t('Space Map of which library?'), value: conn.profile.currentLibrary?.toUpperCase() ?? '',
    prompt: vscode.l10n.t('Shows every object as a tile sized by its disk space.'),
    validateInput: v => isValidSystemName(v.trim().toUpperCase()) ? undefined : vscode.l10n.t('Not a valid library name.'),
  }))?.trim().toUpperCase();
  return lib || undefined;
}

export function registerVisuals(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void> | void) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.spaceMap', wrap(async (a?: unknown) => { const lib = await libraryArg(manager, a); if (lib) { SpaceMap.open(manager, lib); } })),
    vscode.commands.registerCommand('vanthrex.jobTimeline', wrap(() => { manager.require(); JobTimeline.open(manager); })),
  );
}
