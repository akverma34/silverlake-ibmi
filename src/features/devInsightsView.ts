// Index Advisor, IFS Space Map and Source Change Calendar: three visual pages for developers. Data and layout come
// from core/devInsights.ts (and the treemap from core/visuals.ts); clicks only open SQL text, files and members —
// nothing is created or changed on the IBM i from these pages.
import * as vscode from 'vscode';
import { Advice, adviceKeys, breadcrumb, calendarCells, condenseAdvice, createIndexSql, ifsChildren, ifsSizesSql, indexAdviceSql, memberChangesSql, normalizePath, streaks } from '../core/devInsights';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { formatBytes } from '../core/storage';
import { isValidSystemName } from '../core/util';
import { squarify } from '../core/visuals';
import { ifsUri } from './fileSystems';
import { page } from './visualsView';
import { escapeHtml } from './webviewUtil';

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => String(r[k] ?? '').trim();
const num = (r: Row, k: string) => { const v = Number(r[k]); return isFinite(v) ? v : 0; };
const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);
const opts = { enableScripts: true, retainContextWhenHidden: true };
const fail = (e: unknown) => { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); };

async function askLibrary(manager: ConnectionManager, title: string, a: unknown): Promise<string | undefined> {
  const given = typeof a === 'string' ? a : (a as { library?: string } | undefined)?.library;
  const conn = manager.require();
  const v = (given ?? await vscode.window.showInputBox({
    title, value: conn.profile.currentLibrary?.toUpperCase() ?? '',
    validateInput: x => isValidSystemName(x.trim().toUpperCase()) ? undefined : t('Not a valid library name.'),
  }))?.trim().toUpperCase();
  return v || undefined;
}

// ---------------------------------------------------------------- Index Advisor

async function indexAdvisor(manager: ConnectionManager, a: unknown): Promise<void> {
  const library = await askLibrary(manager, t('Index advice for which library?'), a);
  if (!library) { return; }
  const conn = manager.require();
  const title = t('Index Advice Chart: {0}', library);
  const panel = vscode.window.createWebviewPanel('vanthrex.indexAdviceChart', title, vscode.ViewColumn.Active, opts);
  let advice: ReturnType<typeof condenseAdvice> = [];
  const load = async () => {
    panel.webview.html = page(title, `<div class="empty">${escapeHtml(t('Reading the index advice…'))}</div>`);
    try {
      const rows = await conn.rows<Row>(indexAdviceSql(library), 500);
      const list: Advice[] = rows.map(r => ({
        schema: str(r, 'SCHEMA'), table: str(r, 'TAB'), keys: adviceKeys(str(r, 'KEYS')), type: str(r, 'ITYPE').toUpperCase().startsWith('E') ? 'EVI' : 'RADIX',
        times: num(r, 'TIMES'), last: str(r, 'LAST'), mti: num(r, 'MTI'), estSeconds: num(r, 'EST'), avgQuerySeconds: num(r, 'AVGQ'), reason: str(r, 'REASON'),
      }));
      advice = condenseAdvice(list).filter(x => x.keys.length);
      render();
    } catch (e) { logError(e); panel.webview.html = page(title, `<div class="err">${escapeHtml(errorMessage(e))}</div><div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>`); }
  };
  const render = () => {
    const top = advice.slice(0, 40); const maxScore = Math.max(1e-9, ...top.map(x => x.score));
    const tables = new Set(advice.map(x => x.table)).size; const times = advice.reduce((s, x) => s + x.times, 0); const mti = advice.reduce((s, x) => s + x.mti, 0);
    const rows = top.map((x, i) => `<tr><td class="n">${i + 1}</td><td><b>${escapeHtml(x.table)}</b></td><td><code>${escapeHtml(x.keys.join(', '))}</code>${x.covers > 1 ? ` <span class="dim">${escapeHtml(t('(covers {0} pieces of advice)', x.covers))}</span>` : ''}</td>` +
      `<td>${x.type}</td><td class="barcell"><div class="hb ${x.type}" style="width:${Math.max(2, x.score / maxScore * 100).toFixed(1)}%"></div></td>` +
      `<td class="n">${x.times}</td><td class="n">${x.avgQuerySeconds.toFixed(2)}</td><td class="n">${x.mti}</td><td>${escapeHtml(x.last)}</td>` +
      `<td><button data-i="${i}">${escapeHtml(t('CREATE INDEX…'))}</button></td></tr>`).join('');
    const body = `
<div class="sub">${escapeHtml(t('Indexes the Db2 optimizer asked for while running queries over {0}. Advice for the same table whose keys start the same way is merged. Longer bar = asked more often by slower queries.', library))}</div>
<div class="tiles">
  <div class="tile"><b>${advice.length}</b><span>${escapeHtml(t('Indexes advised'))}</span></div>
  <div class="tile"><b>${tables}</b><span>${escapeHtml(t('Tables'))}</span></div>
  <div class="tile"><b>${times}</b><span>${escapeHtml(t('Times advised'))}</span></div>
  <div class="tile"><b>${mti}</b><span>${escapeHtml(t('Temporary indexes built (MTI)'))}</span></div>
</div>
<div class="bar"><button id="all" class="on" ${top.length ? '' : 'disabled'}>${escapeHtml(t('All as one SQL script…'))}</button><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>
${top.length ? `<table class="adv"><tr><th>#</th><th>${escapeHtml(t('Table'))}</th><th>${escapeHtml(t('Key columns'))}</th><th>${escapeHtml(t('Type'))}</th><th>${escapeHtml(t('Value'))}</th><th>${escapeHtml(t('Times'))}</th><th>${escapeHtml(t('Avg query s'))}</th><th>MTI</th><th>${escapeHtml(t('Last advised'))}</th><th></th></tr>${rows}</table>`
    : `<div class="empty">${escapeHtml(t('No index advice for this library. Run the application\'s queries first; the optimizer records advice as they run.'))}</div>`}
<p class="dim">${escapeHtml(t('The SQL opens in an editor; nothing is created until you run it. An index speeds up reads and slows down writes: check large, busy tables first.'))}</p>`;
    panel.webview.html = page(title, body, `
  .adv td { vertical-align: middle; padding: 3px 10px 3px 0; } .barcell { width: 22%; min-width: 120px; }
  .hb { height: 12px; border-radius: 2px; background: #4e79a7; } .hb.EVI { background: #b07aa1; }
  .dim { color: var(--vscode-descriptionForeground); } code { font-family: var(--vscode-editor-font-family); }`, `
document.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) vscode.postMessage({ type: 'sql', i: Number(b.dataset.i) }); });
const all = document.getElementById('all'); if (all) all.onclick = () => vscode.postMessage({ type: 'all' });`);
  };
  const openSql = async (text: string) => { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content: text })); };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; i?: number }) => {
    try {
      if (m?.type === 'refresh') { await load(); }
      else if (m?.type === 'sql' && typeof m.i === 'number' && advice[m.i]) {
        const x = advice[m.i];
        await openSql(`-- ${t('Index advised {0} times for {1} (last {2}). Check, then run with Ctrl+Enter.', x.times, x.table, x.last)}\n${createIndexSql(x, m.i + 1)};\n`);
      } else if (m?.type === 'all') {
        const lines = advice.slice(0, 40).map((x, i) => `-- ${x.table} (${x.keys.join(', ')}): ${t('advised {0} times', x.times)}\n${createIndexSql(x, i + 1)};`);
        await openSql(`-- ${t('Index advice for {0}. Keep only the indexes you want, then run.', library)}\n\n${lines.join('\n\n')}\n`);
      }
    } catch (e) { fail(e); }
  });
  await load();
}

// ---------------------------------------------------------------- IFS Space Map

const EXT_GROUPS: [string, string, RegExp][] = [
  ['Folders', '#4e79a7', /^$/], // only for folders with no file below them
  ['Source', '#59a14f', /\.(rpgle|sqlrpgle|rpg|clle|clp|cl|sql|cmd|dds|pf|lf|dspf|prtf|java|js|ts|py|php|c|cpp|h|sh|bnd|binder)$/i],
  ['Logs and text', '#79706e', /\.(log|txt|out|trc|err|lst)$/i],
  ['Archives and save files', '#e15759', /\.(zip|tar|gz|tgz|7z|jar|war|savf|bak)$/i],
  ['Data', '#f28e2b', /\.(csv|json|xml|xls|xlsx|dat|db|tsv|yaml|yml)$/i],
  ['Documents and images', '#b07aa1', /\.(pdf|doc|docx|png|jpg|jpeg|gif|svg|html|htm|md)$/i],
  ['Other files', '#9c755f', /./],
];
const extGroup = (name: string, dir: boolean): number => dir ? 0 : Math.max(1, EXT_GROUPS.findIndex((g, i) => i > 0 && g[2].test(name)));
const extLabel = (i: number) => [t('Folders'), t('Source'), t('Logs and text'), t('Archives and save files'), t('Data'), t('Documents and images'), t('Other files')][i];

async function ifsSpaceMap(manager: ConnectionManager, a: unknown): Promise<void> {
  const conn = manager.require();
  const given = typeof a === 'string' ? a : (a as { path?: string } | undefined)?.path;
  const start = given ?? await vscode.window.showInputBox({ title: t('IFS Space Map of which folder?'), value: conn.profile.ifsHome || conn.homeDirectory || '/home', prompt: t('Every folder and file below it, sized by disk space. Click a folder to go in.') });
  if (!start) { return; }
  let base = normalizePath(start); let cur = base;
  let files: { path: string; size: number }[] = []; let truncated = false;
  const MAX = 50000; const W = 1000; const H = 560;
  const panel = vscode.window.createWebviewPanel('vanthrex.ifsSpaceMap', t('IFS Space Map: {0}', base), vscode.ViewColumn.Active, opts);
  const load = async (path: string) => {
    base = normalizePath(path); cur = base;
    panel.title = t('IFS Space Map: {0}', base);
    panel.webview.html = page(t('IFS Space Map: {0}', base), `<div class="empty">${escapeHtml(t('Adding up the sizes below {0}… (large folders take a while)', base))}</div>`);
    try {
      // Some releases refuse the list of file systems to leave out (SQL0443 on OMIT_LIST): read without it then.
      const rows = await conn.rows<Row>(ifsSizesSql(base, MAX), MAX).catch(e => /OMIT_LIST|SQL0443/i.test(errorMessage(e)) ? conn.rows<Row>(ifsSizesSql(base, MAX, false), MAX) : Promise.reject(e));
      files = rows.map(r => ({ path: str(r, 'P'), size: num(r, 'SZ') })); truncated = rows.length >= MAX;
      render();
    } catch (e) { logError(e); panel.webview.html = page(t('IFS Space Map: {0}', base), `<div class="err">${escapeHtml(errorMessage(e))}</div><div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>`); }
  };
  const render = () => {
    const kids = ifsChildren(cur, files); const total = kids.reduce((s, k) => s + k.size, 0); const count = kids.reduce((s, k) => s + k.files, 0);
    // A folder takes the colour of the kind of file that fills most of it, so a folder full of logs looks like logs.
    const prefix = cur === '/' ? '/' : cur + '/'; const mix = new Map<string, number[]>();
    for (const f of files) {
      if (!f.path.startsWith(prefix)) { continue; }
      const rest = f.path.slice(prefix.length); const slash = rest.indexOf('/'); if (slash < 0) { continue; }
      const sizes = mix.get(rest.slice(0, slash)) ?? EXT_GROUPS.map(() => 0); sizes[extGroup(rest.slice(rest.lastIndexOf('/') + 1), false)] += f.size; mix.set(rest.slice(0, slash), sizes);
    }
    const colourOf = (k: { name: string; dir: boolean }): number => { const m = k.dir ? mix.get(k.name) : undefined; return m ? m.indexOf(Math.max(...m)) : extGroup(k.name, k.dir); };
    const rects = squarify(kids.map(k => k.size), 0, 0, W, H);
    const pct = (n: number, of: number) => `${(n / of * 100).toFixed(3)}%`;
    const tiles = kids.map((k, i) => {
      const r = rects[i]; if (r.w < 0.4 || r.h < 0.4) { return ''; }
      const g = colourOf(k);
      const tip = `${k.path}\n${formatBytes(k.size)} (${(k.size / Math.max(1, total) * 100).toFixed(1)}%)${k.dir ? `\n${t('{0} files', k.files)} · ${t('Click to go in')}` : `\n${t('Click to open')}`}`;
      const label = r.w > 46 && r.h > 16 ? `<span>${k.dir ? '📁 ' : ''}${escapeHtml(k.name)}${r.h > 30 ? `<small>${escapeHtml(formatBytes(k.size))}</small>` : ''}</span>` : '';
      return `<div class="t" data-path="${escapeHtml(k.path)}" data-dir="${k.dir ? 1 : 0}" style="left:${pct(r.x, W)};top:${pct(r.y, H)};width:${pct(r.w, W)};height:${pct(r.h, H)};background:${EXT_GROUPS[g][1]}" title="${escapeHtml(tip)}">${label}</div>`;
    }).join('');
    const sums = EXT_GROUPS.map((g, i) => ({ i, size: kids.filter(k => colourOf(k) === i).reduce((s, k) => s + k.size, 0) })).filter(x => x.size > 0);
    const legend = sums.map(x => `<span class="k"><i class="sw" style="background:${EXT_GROUPS[x.i][1]}"></i>${escapeHtml(extLabel(x.i))} · ${escapeHtml(formatBytes(x.size))}</span>`).join('');
    const crumbs = breadcrumb(cur).map(b => `<a href="#" data-crumb="${escapeHtml(b.path)}">${escapeHtml(b.name)}</a>`).join(' <span class="dim">›</span> ');
    const biggest = [...files].filter(f => f.path.startsWith(cur === '/' ? '/' : cur + '/')).sort((x, y) => y.size - x.size).slice(0, 15)
      .map(f => `<tr class="click" data-path="${escapeHtml(f.path)}" data-dir="0"><td>${escapeHtml(f.path)}</td><td class="n">${escapeHtml(formatBytes(f.size))}</td></tr>`).join('');
    const body = `<div class="crumbs">${crumbs}</div>
<div class="tiles">
  <div class="tile"><b>${escapeHtml(formatBytes(total))}</b><span>${escapeHtml(t('Total size'))}</span></div>
  <div class="tile"><b>${count}</b><span>${escapeHtml(t('Files'))}</span></div>
  <div class="tile"><b>${kids.filter(k => k.dir).length}</b><span>${escapeHtml(t('Folders'))}</span></div>
  <div class="tile"><b>${escapeHtml(kids[0]?.name ?? '-')}</b><span>${escapeHtml(t('Biggest item'))}</span></div>
</div>
${truncated ? `<div class="err">${escapeHtml(t('Only the first {0} files were read: open a smaller folder for exact sizes.', MAX))}</div>` : ''}
<div class="bar">${cur !== '/' ? `<button id="up">${escapeHtml(t('Up one level'))}</button>` : ''}<button id="refresh">${escapeHtml(t('Refresh'))}</button></div>
<div class="legend">${legend}</div>
${tiles ? `<div class="map">${tiles}</div>` : `<div class="empty">${escapeHtml(t('No files below this folder.'))}</div>`}
${biggest ? `<h3>${escapeHtml(t('Largest files'))}</h3><table>${biggest}</table>` : ''}`;
    panel.webview.html = page(t('IFS Space Map: {0}', base), body, `
  .crumbs { margin: 4px 0 8px; } .crumbs a { color: var(--vscode-textLink-foreground); text-decoration: none; } .dim { color: var(--vscode-descriptionForeground); }
  .map { position: relative; width: 100%; aspect-ratio: ${W} / ${H}; max-height: 72vh; background: var(--vscode-editorWidget-background); border-radius: 4px; overflow: hidden; }
  .t { position: absolute; box-sizing: border-box; border: 1px solid var(--vscode-editor-background); overflow: hidden; cursor: pointer; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.55); font-size: 11px; }
  .t span { display: block; padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .t small { display: block; opacity: .85; }
  .t:hover { filter: brightness(1.18); outline: 2px solid var(--vscode-focusBorder); z-index: 2; }`, `
const up = document.getElementById('up'); if (up) up.onclick = () => vscode.postMessage({ type: 'up' });
document.addEventListener('click', e => {
  const c = e.target.closest('[data-crumb]'); if (c) { e.preventDefault(); vscode.postMessage({ type: 'go', path: c.dataset.crumb }); return; }
  const o = e.target.closest('[data-path]'); if (o) vscode.postMessage({ type: o.dataset.dir === '1' ? 'go' : 'open', path: o.dataset.path });
});`);
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; path?: string }) => {
    try {
      if (m?.type === 'refresh') { await load(cur); }
      else if (m?.type === 'up') { const parent = cur.replace(/\/[^/]+$/, '') || '/'; if (parent.length < base.length) { await load(parent); } else { cur = parent; render(); } }
      else if (m?.type === 'go' && typeof m.path === 'string') {
        const p = normalizePath(m.path);
        if (p === base || p.startsWith(base === '/' ? '/' : base + '/')) { cur = p; render(); } else { await load(p); }
      } else if (m?.type === 'open' && typeof m.path === 'string') { await vscode.window.showTextDocument(ifsUri(normalizePath(m.path))); }
    } catch (e) { fail(e); }
  });
  await load(base);
}

// ---------------------------------------------------------------- Source Change Calendar

const LEVEL = ['var(--empty)', 'rgba(89,161,79,.35)', 'rgba(89,161,79,.6)', 'rgba(89,161,79,.82)', 'rgba(89,161,79,1)'];

async function changeCalendar(manager: ConnectionManager, a: unknown): Promise<void> {
  const node = a as { library?: string; file?: string } | undefined;
  const library = await askLibrary(manager, t('Source Change Calendar of which library?'), typeof a === 'string' ? a : node?.library);
  if (!library) { return; }
  const file = typeof node?.file === 'string' ? node.file.toUpperCase() : undefined;
  const conn = manager.require();
  const what = file ? `${library}/${file}` : library;
  const title = t('Source Change Calendar: {0}', what);
  const panel = vscode.window.createWebviewPanel('vanthrex.changeCalendar', title, vscode.ViewColumn.Active, opts);
  const load = async () => {
    panel.webview.html = page(title, `<div class="empty">${escapeHtml(t('Reading member change dates…'))}</div>`);
    try {
      const rows = await conn.rows<Row>(memberChangesSql(library, file), 20000);
      const today = rows[0] ? str(rows[0], 'TODAY') : new Date().toISOString().slice(0, 10);
      const members = rows.map(r => ({ f: str(r, 'F'), m: str(r, 'M'), t: str(r, 'T'), x: str(r, 'X'), d: str(r, 'D'), h: str(r, 'H') }));
      const counts = new Map<string, number>(); for (const m of members) { counts.set(m.d, (counts.get(m.d) ?? 0) + 1); }
      const { cells, months, max } = calendarCells(counts, today);
      const st = streaks(counts, today);
      const busiest = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
      const byType = new Map<string, number>(); for (const m of members) { byType.set(m.t || '?', (byType.get(m.t || '?') ?? 0) + 1); }
      const types = [...byType.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10); const tmax = Math.max(1, ...types.map(x => x[1]));
      const S = 13; const G = 3; const L = 30; const TOP = 18;
      const svg = `<svg viewBox="0 0 ${L + 53 * (S + G)} ${TOP + 7 * (S + G)}" width="100%" style="max-width:${L + 53 * (S + G) + 200}px" role="img" aria-label="${escapeHtml(title)}">` +
        months.map(m => `<text x="${L + m.col * (S + G)}" y="12" class="ml">${escapeHtml(t(m.label))}</text>`).join('') +
        [[1, t('Mon')], [3, t('Wed')], [5, t('Fri')]].map(([r, l]) => `<text x="0" y="${TOP + Number(r) * (S + G) + 10}" class="ml">${escapeHtml(String(l))}</text>`).join('') +
        cells.map(c => `<rect x="${L + c.col * (S + G)}" y="${TOP + c.row * (S + G)}" width="${S}" height="${S}" rx="2" fill="${LEVEL[c.level]}" data-day="${c.day}" class="d${c.count ? ' has' : ''}"><title>${escapeHtml(c.count ? t('{0}: {1} members changed', c.day, c.count) : t('{0}: no change', c.day))}</title></rect>`).join('') + `</svg>`;
      const byDay: Record<string, typeof members> = {}; for (const m of members) { (byDay[m.d] ??= []).push(m); }
      const typeBars = types.map(([k, v]) => `<div class="tb"><span>${escapeHtml(k)}</span><div><i style="width:${(v / tmax * 100).toFixed(1)}%"></i></div><b>${v}</b></div>`).join('');
      const recent = members.slice(0, 15).map(m => `<tr class="click" data-f="${escapeHtml(m.f)}" data-m="${escapeHtml(m.m)}"><td>${escapeHtml(m.d)} ${escapeHtml(m.h)}</td><td>${escapeHtml(m.f)}/${escapeHtml(m.m)}</td><td>${escapeHtml(m.t)}</td><td>${escapeHtml(m.x)}</td></tr>`).join('');
      const body = `
<div class="tiles">
  <div class="tile"><b>${members.length}</b><span>${escapeHtml(t('Members changed this year'))}</span></div>
  <div class="tile"><b>${counts.size}</b><span>${escapeHtml(t('Days with changes'))}</span></div>
  <div class="tile"><b>${busiest ? busiest[1] : 0}</b><span>${escapeHtml(busiest ? t('Busiest day: {0}', busiest[0]) : t('Busiest day'))}</span></div>
  <div class="tile"><b>${st.longest}</b><span>${escapeHtml(t('Longest run of days'))}</span></div>
  <div class="tile"><b>${st.current}</b><span>${escapeHtml(t('Current run of days'))}</span></div>
</div>
<div class="sub">${escapeHtml(t('Each square is a day; the darker, the more members were last changed that day. Click a day to list them.'))}</div>
<div class="cal">${svg}</div>
<div class="legend"><span class="dim">${escapeHtml(t('Less'))}</span>${LEVEL.map(c => `<i class="sw" style="background:${c}"></i>`).join('')}<span class="dim">${escapeHtml(t('More'))} (max ${max})</span></div>
<div class="cols"><div><h3 id="dayTitle">${escapeHtml(t('Most recent changes'))}</h3><table id="list">${recent || `<tr><td class="empty">${escapeHtml(t('No member changed in the last year.'))}</td></tr>`}</table></div>
<div><h3>${escapeHtml(t('By source type'))}</h3>${typeBars}</div></div>
<p class="dim">${escapeHtml(t('Only the last change of each member is known (the member statistics): a member changed again later shows on its latest day.'))}</p>`;
      panel.webview.html = page(title, body, `
  :root { --empty: var(--vscode-editorWidget-background); } .dim { color: var(--vscode-descriptionForeground); }
  .cal { overflow-x: auto; padding: 6px 0; } .ml { fill: var(--vscode-descriptionForeground); font-size: 10px; }
  rect.d { stroke: var(--vscode-panel-border); stroke-width: .5; } rect.has { cursor: pointer; } rect.has:hover, rect.sel { stroke: var(--vscode-focusBorder); stroke-width: 2; }
  .legend .sw { margin: 0 1px; }
  .cols { display: flex; flex-wrap: wrap; gap: 32px; } .cols > div:first-child { flex: 2 1 420px; } .cols > div:last-child { flex: 1 1 220px; }
  .tb { display: grid; grid-template-columns: 90px 1fr 40px; gap: 6px; align-items: center; margin: 3px 0; } .tb div { background: var(--vscode-editorWidget-background); height: 12px; border-radius: 2px; }
  .tb i { display: block; height: 12px; background: #59a14f; border-radius: 2px; } .tb b { text-align: right; font-weight: normal; }`, `
const byDay = ${JSON.stringify(byDay).replace(/</g, '\\u003c')};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
document.addEventListener('click', e => {
  const d = e.target.closest('rect.has');
  if (d) {
    document.querySelectorAll('rect.sel').forEach(x => x.classList.remove('sel')); d.classList.add('sel');
    const list = byDay[d.dataset.day] || [];
    document.getElementById('dayTitle').textContent = d.dataset.day + ' — ' + list.length;
    document.getElementById('list').innerHTML = list.map(m => '<tr class="click" data-f="' + esc(m.f) + '" data-m="' + esc(m.m) + '"><td>' + esc(m.h) + '</td><td>' + esc(m.f) + '/' + esc(m.m) + '</td><td>' + esc(m.t) + '</td><td>' + esc(m.x) + '</td></tr>').join('');
    return;
  }
  const r = e.target.closest('tr[data-m]'); if (r) vscode.postMessage({ type: 'open', f: r.dataset.f, m: r.dataset.m });
});`);
    } catch (e) { logError(e); panel.webview.html = page(title, `<div class="err">${escapeHtml(errorMessage(e))}</div><div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button></div>`); }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; f?: string; m?: string }) => {
    try {
      if (m?.type === 'refresh') { await load(); }
      else if (m?.type === 'open' && typeof m.f === 'string' && typeof m.m === 'string' && isValidSystemName(m.f) && isValidSystemName(m.m)) {
        await vscode.commands.executeCommand('vanthrex.openMemberSource', library, m.f, m.m);
      }
    } catch (e) { fail(e); }
  });
  await load();
}

export function registerDevInsights(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (a?: unknown) => Promise<void>) => async (a?: unknown) => { try { await fn(a); } catch (e) { fail(e); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.indexAdviceChart', wrap(a => indexAdvisor(manager, a))),
    vscode.commands.registerCommand('vanthrex.ifsSpaceMap', wrap(a => ifsSpaceMap(manager, a))),
    vscode.commands.registerCommand('vanthrex.changeCalendar', wrap(a => changeCalendar(manager, a))),
  );
}
