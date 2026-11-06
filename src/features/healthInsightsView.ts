// Lock Wait Chains, Limits Watch and Security Scorecard pages. Logic in core/healthInsights.ts; the pages only
// read — clicks open the job log or Work with Active Jobs, nothing is changed on the IBM i from here.
import * as vscode from 'vscode';
import {
  CheckState, lockChains, lockJobsSql, LockRow, Level, limitLevel, limitsSql, limitUses, objectLockWaitsSql, profileFindings, ProfileRow,
  profilesSql, rowLockWaitsSql, scoreGrade, securityChecks, securityScore, securityValuesSql,
} from '../core/healthInsights';
import { scorecardMarkdown } from '../core/healthOverview';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { page } from './visualsView';
import { escapeHtml } from './webviewUtil';

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => String(r[k] ?? '').trim();
const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);
const opts = { enableScripts: true, retainContextWhenHidden: true };
const fail = (e: unknown) => { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); };
const JOB = /^\d{6}\/[^/\s]{1,10}\/[^/\s]{1,10}$/;
const LEVEL_COLOR: Record<Level, string> = { ok: '#59a14f', warn: '#f28e2b', bad: '#e15759' };
const CSS = `.dim { color: var(--vscode-descriptionForeground); } .bad { color: #e15759; } .warn { color: #f28e2b; } .good { color: #59a14f; }`;

/** Clicks on [data-job]: left opens the job log, right opens Work with Active Jobs. */
const jobScript = `document.addEventListener('click', e => { const c = e.target.closest('[data-job]'); if (c) vscode.postMessage({ type: 'job', job: c.dataset.job }); });
document.addEventListener('contextmenu', e => { const c = e.target.closest('[data-job]'); if (c) { e.preventDefault(); vscode.postMessage({ type: 'work', job: c.dataset.job }); } });`;

async function jobMessage(m: { type?: string; job?: string }): Promise<boolean> {
  if (typeof m?.job !== 'string' || !JOB.test(m.job)) { return false; }
  if (m.type === 'job') { await vscode.commands.executeCommand('vanthrex.jobLog', { job: m.job }); return true; }
  if (m.type === 'work') { const [, user, job] = m.job.split('/'); await vscode.commands.executeCommand('vanthrex.wrkactjob', { user, job }); return true; }
  return false;
}

// ---------------------------------------------------------------- Lock Wait Chains

async function lockWaitChains(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const title = t('Lock Wait Chains');
  const panel = vscode.window.createWebviewPanel('vanthrex.lockWaitChains', title, vscode.ViewColumn.Active, opts);
  let timer: NodeJS.Timeout | undefined; let auto = false; let busy = false;
  panel.onDidDispose(() => { if (timer) { clearInterval(timer); } });
  const toolbar = () => `<div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button><label><input type="checkbox" id="auto" ${auto ? 'checked' : ''}> ${escapeHtml(t('Refresh every 10 seconds'))}</label></div>`;
  const script = `document.getElementById('auto').onchange = e => vscode.postMessage({ type: 'auto', auto: e.target.checked });` + jobScript;
  const load = async (quiet = false) => {
    if (busy) { return; } busy = true;
    if (!quiet) { panel.webview.html = page(title, toolbar() + `<div class="empty">${escapeHtml(t('Looking for jobs that wait for a lock…'))}</div>`, '', script); }
    try {
      const [objs, rows] = await Promise.all([conn.rows<LockRow>(objectLockWaitsSql(), 5000), conn.rows<LockRow>(rowLockWaitsSql(), 5000).catch(() => [] as LockRow[])]);
      const chains = lockChains([...objs, ...rows]);
      const jobs = [...new Set(chains.contention.flatMap(c => [...c.holders, ...c.waiters].map(x => x.job)))];
      const infoSql = lockJobsSql(jobs);
      const info = new Map((infoSql ? await conn.rows<Row>(infoSql, 1000).catch(() => [] as Row[]) : []).map(r => [str(r, 'JOB'), r]));
      const chip = (job: string, state: string, kind: 'hold' | 'wait') => {
        const i = info.get(job); const tip = `${job}${i ? `\n${str(i, 'SBS')} · ${str(i, 'STATUS')} · ${str(i, 'FN')}` : ''}\n${state}\n${t('Click: job log · Right-click: Work with Active Jobs')}`;
        return `<span class="chip ${kind}" data-job="${escapeHtml(job)}" title="${escapeHtml(tip)}">${escapeHtml(job)}<small>${escapeHtml(state)}${i ? ` · ${escapeHtml(str(i, 'STATUS'))}` : ''}</small></span>`;
      };
      const head = new Set(chains.heads.map(h => h.job));
      const cards = chains.contention.map(c => `<div class="card">
<div class="side">${c.holders.length ? c.holders.map(h => chip(h.job, h.state, 'hold') + (head.has(h.job) ? `<b class="crown" title="${escapeHtml(t('Head blocker: holds the lock and waits for nothing'))}">●</b>` : '')).join('') : `<span class="dim">${escapeHtml(t('(holder not visible)'))}</span>`}</div>
<div class="res"><span class="arrow">→</span><code>${escapeHtml(c.resource)}</code><span class="arrow">←</span></div>
<div class="side">${c.waiters.map(w => chip(w.job, w.state, 'wait')).join('')}</div></div>`).join('');
      const heads = chains.heads.map(h => `<tr class="click" data-job="${escapeHtml(h.job)}"><td>${escapeHtml(h.job)}</td><td class="n bad">${h.blocks}</td><td>${escapeHtml(h.resources.join(', '))}</td><td>${escapeHtml(info.get(h.job) ? `${str(info.get(h.job)!, 'STATUS')} ${str(info.get(h.job)!, 'FN')}` : '')}</td></tr>`).join('');
      const body = toolbar() + `
<div class="tiles">
  <div class="tile"><b class="${chains.waiting ? 'bad' : 'good'}">${chains.waiting}</b><span>${escapeHtml(t('Jobs waiting for a lock'))}</span></div>
  <div class="tile"><b>${chains.contention.length}</b><span>${escapeHtml(t('Contended objects and rows'))}</span></div>
  <div class="tile"><b class="${chains.heads.length ? 'bad' : ''}">${chains.heads.length}</b><span>${escapeHtml(t('Head blockers'))}</span></div>
  <div class="tile"><b>${escapeHtml(new Date().toLocaleTimeString())}</b><span>${escapeHtml(t('Read at'))}</span></div>
</div>
${chains.contention.length ? `
${heads ? `<h3>${escapeHtml(t('Head blockers'))}</h3><p class="dim">${escapeHtml(t('These jobs hold a lock others wait for and wait for nothing themselves: ending or answering them frees the chain.'))}</p>
<table><tr><th>${escapeHtml(t('Job'))}</th><th>${escapeHtml(t('Jobs blocked'))}</th><th>${escapeHtml(t('Holds'))}</th><th>${escapeHtml(t('Status'))}</th></tr>${heads}</table>` : ''}
<h3>${escapeHtml(t('Who waits for whom'))}</h3>
<div class="legend"><span class="k"><i class="sw" style="background:#e15759"></i>${escapeHtml(t('Holds the lock'))}</span><span class="k"><i class="sw" style="background:#f28e2b"></i>${escapeHtml(t('Waits for it'))}</span></div>
${cards}` : `<div class="empty good">✔ ${escapeHtml(t('No job is waiting for a lock right now.'))}</div>`}
<p class="dim">${escapeHtml(t('From QSYS2.OBJECT_LOCK_INFO and QSYS2.RECORD_LOCK_INFO. Every job holding a lock on the object is shown; a shared lock may not be the one in the way.'))}</p>`;
      panel.webview.html = page(title, body, CSS + `
  .card { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin: 8px 0; }
  .side { display: flex; flex-wrap: wrap; gap: 6px; } .side:last-child { justify-content: flex-start; }
  .res { display: flex; align-items: center; gap: 6px; } .res code { padding: 3px 8px; border-radius: 3px; background: var(--vscode-editorWidget-background); }
  .arrow { color: var(--vscode-descriptionForeground); font-size: 1.3em; }
  .chip { cursor: pointer; display: inline-flex; flex-direction: column; padding: 3px 8px; border-radius: 4px; border-left: 4px solid; background: var(--vscode-editorWidget-background); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .chip small { color: var(--vscode-descriptionForeground); } .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip.hold { border-color: #e15759; } .chip.wait { border-color: #f28e2b; } .crown { color: #e15759; margin-left: -4px; }
  @media (max-width: 600px) { .card { grid-template-columns: 1fr; } .arrow { display: none; } }`, script);
    } catch (e) { logError(e); panel.webview.html = page(title, toolbar() + `<div class="err">${escapeHtml(errorMessage(e))}</div>`, '', script); }
    finally { busy = false; }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; job?: string; auto?: boolean }) => {
    try {
      if (m?.type === 'refresh') { await load(); }
      else if (m?.type === 'auto') { auto = !!m.auto; if (timer) { clearInterval(timer); timer = undefined; } if (auto) { timer = setInterval(() => void load(true), 10000); } }
      else { await jobMessage(m); }
    } catch (e) { fail(e); }
  });
  await load();
}

// ---------------------------------------------------------------- Limits Watch

async function limitsWatch(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const title = t('Limits Watch');
  const panel = vscode.window.createWebviewPanel('vanthrex.limitsWatch', title, vscode.ViewColumn.Active, opts);
  const toolbar = `<div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button><input id="q" placeholder="${escapeHtml(t('Filter…'))}"></div>`;
  const script = `const q = document.getElementById('q'); let cat = '';
const apply = () => { const f = q.value.toLowerCase(); document.querySelectorAll('.lim').forEach(r => { r.hidden = (cat && r.dataset.cat !== cat) || (f && !r.textContent.toLowerCase().includes(f)); }); };
q.oninput = apply;
document.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { cat = cat === b.dataset.c ? '' : b.dataset.c; document.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x.dataset.c === cat)); apply(); });` + jobScript;
  const load = async () => {
    panel.webview.html = page(title, toolbar + `<div class="empty">${escapeHtml(t('Reading QSYS2.SYSLIMITS…'))}</div>`, '', script);
    try {
      const uses = limitUses(await conn.rows<Row>(limitsSql(), 5000));
      const cats = [...new Set(uses.map(u => u.category))].sort();
      const fmt = (v: number) => v.toLocaleString();
      const rows = uses.slice(0, 300).map(u => {
        const lv = limitLevel(u.pct);
        return `<div class="lim" data-cat="${escapeHtml(u.category)}" title="${escapeHtml(`${u.limit}\n${u.where || u.job}\n${fmt(u.current)} / ${fmt(u.maximum)}\n${t('Last grew {0}', u.changed)}${u.user ? ` · ${u.user}` : ''}`)}">
<div class="what"><b>${escapeHtml(u.limit)}</b><span class="dim">${escapeHtml(u.where)}${u.job ? `${u.where ? ' · ' : ''}${JOB.test(u.job) ? `<a class="jl" data-job="${escapeHtml(u.job)}">${escapeHtml(u.job)}</a>` : escapeHtml(u.job)}` : ''}</span></div>
<div class="gauge"><div style="width:${Math.min(100, u.pct)}%;background:${LEVEL_COLOR[lv]}"></div></div>
<div class="pct" style="color:${LEVEL_COLOR[lv]}">${u.pct.toFixed(1)} %</div><div class="dim num">${escapeHtml(fmt(u.current))} / ${escapeHtml(fmt(u.maximum))}</div></div>`;
      }).join('');
      const body = toolbar + `
<div class="tiles">
  <div class="tile"><b>${uses.length}</b><span>${escapeHtml(t('Limits tracked'))}</span></div>
  <div class="tile"><b class="${uses.some(u => limitLevel(u.pct) === 'bad') ? 'bad' : ''}">${uses.filter(u => limitLevel(u.pct) === 'bad').length}</b><span>${escapeHtml(t('At 90 % or more'))}</span></div>
  <div class="tile"><b class="${uses.some(u => limitLevel(u.pct) === 'warn') ? 'warn' : ''}">${uses.filter(u => limitLevel(u.pct) === 'warn').length}</b><span>${escapeHtml(t('At 75 % or more'))}</span></div>
  <div class="tile"><b>${uses[0] ? `${uses[0].pct.toFixed(1)} %` : '-'}</b><span>${escapeHtml(t('Closest to its limit'))}</span></div>
</div>
<div class="bar">${cats.map(c => `<button data-c="${escapeHtml(c)}">${escapeHtml(c)} (${uses.filter(u => u.category === c).length})</button>`).join('')}</div>
${uses.length ? rows : `<div class="empty good">✔ ${escapeHtml(t('Nothing has come near an IBM i limit yet.'))}</div>`}
${uses.length > 300 ? `<p class="dim">${escapeHtml(t('{0} more not shown.', uses.length - 300))}</p>` : ''}
<p class="dim">${escapeHtml(t('From QSYS2.SYSLIMITS: the system records a limit once it grows past a tracking point (for example a table with many rows, a job with many locks, a large IFS directory). Only the latest value of each is shown.'))}</p>`;
      panel.webview.html = page(title, body, CSS + `
  .lim { display: grid; grid-template-columns: minmax(200px, 2fr) minmax(120px, 3fr) 70px auto; gap: 4px 12px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .lim[hidden] { display: none; } .what { display: flex; flex-direction: column; min-width: 0; } .what span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gauge { height: 10px; border-radius: 5px; background: var(--vscode-editorWidget-background); overflow: hidden; } .gauge > div { height: 100%; }
  .pct { text-align: right; font-weight: 600; } .num { font-size: .9em; white-space: nowrap; } a.jl { cursor: pointer; color: var(--vscode-textLink-foreground); }
  @media (max-width: 600px) { .lim { grid-template-columns: 1fr 60px; } .lim .num { display: none; } .what { grid-column: 1 / -1; } }`, script);
    } catch (e) { logError(e); panel.webview.html = page(title, toolbar + `<div class="err">${escapeHtml(errorMessage(e))}</div>`, '', script); }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; job?: string }) => { try { if (m?.type === 'refresh') { await load(); } else { await jobMessage(m); } } catch (e) { fail(e); } });
  await load();
}

// ---------------------------------------------------------------- Security Scorecard

const STATE_COLOR: Record<CheckState, string> = { pass: '#59a14f', warn: '#f28e2b', fail: '#e15759' };

async function securityScorecard(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const title = t('Security Scorecard');
  const panel = vscode.window.createWebviewPanel('vanthrex.securityScorecard', title, vscode.ViewColumn.Active, opts);
  const toolbar = `<div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button><button id="md">${escapeHtml(t('Copy as a Markdown report'))}</button></div>`;
  const mdScript = `document.getElementById('md').onclick = () => vscode.postMessage({ type: 'markdown' });`;
  let report = '';
  const load = async () => {
    panel.webview.html = page(title, toolbar + `<div class="empty">${escapeHtml(t('Reading the security system values and user profiles…'))}</div>`, '', mdScript);
    try {
      const [vals, profiles] = await Promise.all([conn.rows<Row>(securityValuesSql(), 100), conn.rows<ProfileRow>(profilesSql(), 50000).catch(() => undefined)]);
      const checks = securityChecks(Object.fromEntries(vals.map(r => [str(r, 'NAME'), str(r, 'VAL')])));
      const p = profiles ? profileFindings(profiles) : undefined;
      const score = securityScore(checks, p); const grade = scoreGrade(score);
      report = scorecardMarkdown(conn.profile.name, new Date().toISOString().slice(0, 16).replace('T', ' '), score, checks, p);
      const color = score >= 75 ? '#59a14f' : score >= 50 ? '#f28e2b' : '#e15759';
      const R = 54; const C = 2 * Math.PI * R;
      const ring = `<svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="${escapeHtml(t('Score {0} of 100', score))}">
<circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--vscode-editorWidget-background)" stroke-width="14"/>
<circle cx="70" cy="70" r="${R}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${(C * score / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 70 70)"/>
<text x="70" y="68" text-anchor="middle" font-size="34" font-weight="700" fill="${color}">${score}</text><text x="70" y="92" text-anchor="middle" font-size="13" fill="var(--vscode-descriptionForeground)">${escapeHtml(t('Grade {0}', grade))}</text></svg>`;
      const count = (s: CheckState) => checks.filter(c => c.state === s).length;
      const stateLabel = (s: CheckState) => ({ pass: t('OK'), warn: t('Review'), fail: t('Risk') })[s];
      const order: Record<CheckState, number> = { fail: 0, warn: 1, pass: 2 };
      const rows = [...checks].sort((a, b) => order[a.state] - order[b.state] || b.weight - a.weight).map(c => `<tr><td><span class="pill" style="background:${STATE_COLOR[c.state]}">${escapeHtml(stateLabel(c.state))}</span></td>
<td><b>${escapeHtml(t(c.title))}</b><br><small class="dim">${escapeHtml(t(c.why))}</small></td><td><code>${escapeHtml(c.id)}</code></td><td><code>${escapeHtml(c.value)}</code></td><td>${escapeHtml(t(c.recommended))}</td></tr>`).join('');
      const list = (names: string[]) => names.length ? `<div class="names">${names.slice(0, 60).map(x => `<code>${escapeHtml(x)}</code>`).join(' ')}${names.length > 60 ? ` <span class="dim">${escapeHtml(t('{0} more not shown.', names.length - 60))}</span>` : ''}</div>` : `<div class="good">✔ ${escapeHtml(t('None'))}</div>`;
      const body = toolbar + `
<div class="top">${ring}<div class="tiles">
  <div class="tile"><b class="bad">${count('fail')}</b><span>${escapeHtml(t('Risks'))}</span></div>
  <div class="tile"><b class="warn">${count('warn')}</b><span>${escapeHtml(t('To review'))}</span></div>
  <div class="tile"><b class="good">${count('pass')}</b><span>${escapeHtml(t('OK'))}</span></div>
  ${p ? `<div class="tile"><b>${p.enabled}</b><span>${escapeHtml(t('Enabled profiles'))}</span></div>` : ''}
</div></div>
<h3>${escapeHtml(t('Security system values'))}</h3>
<table><tr><th></th><th>${escapeHtml(t('Check'))}</th><th>${escapeHtml(t('System value'))}</th><th>${escapeHtml(t('Current'))}</th><th>${escapeHtml(t('Recommended'))}</th></tr>${rows}</table>
${p ? `<h3>${escapeHtml(t('User profiles'))}</h3>
<h4>${escapeHtml(t('Enabled profiles with *ALLOBJ ({0})', p.allObj.length))}</h4>${list(p.allObj)}
<h4>${escapeHtml(t('Password not changed for more than a year ({0})', p.oldPasswords.length))}</h4>${list(p.oldPasswords)}
<h4>${escapeHtml(t('Not used for more than 180 days ({0})', p.idle.length))}</h4>${list(p.idle)}
<p class="dim">${escapeHtml(t('IBM profiles (Q…) are left out. Only the profiles you are authorized to see are counted; *SECADM or *ALLOBJ shows them all.'))}</p>` : `<p class="dim">${escapeHtml(t('The user profiles could not be read with your authority, so only the system values are scored.'))}</p>`}
<p class="dim">${escapeHtml(t('Recommendations follow common IBM i security guidance; what fits your shop may differ. Nothing is changed from this page.'))}</p>`;
      panel.webview.html = page(title, body, CSS + `
  .top { display: flex; flex-wrap: wrap; align-items: center; gap: 20px; } td { vertical-align: top; padding-bottom: 6px; }
  .pill { color: #fff; border-radius: 9px; padding: 1px 8px; font-size: .85em; white-space: nowrap; } h4 { margin: 12px 0 4px; font-weight: 600; }
  .names { display: flex; flex-wrap: wrap; gap: 4px; } .names code { background: var(--vscode-editorWidget-background); padding: 1px 6px; border-radius: 3px; }`, mdScript);
    } catch (e) { logError(e); panel.webview.html = page(title, toolbar + `<div class="err">${escapeHtml(errorMessage(e))}</div>`, '', mdScript); }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string }) => {
    try {
      if (m?.type === 'refresh') { await load(); }
      else if (m?.type === 'markdown') {
        if (!report) { void vscode.window.showWarningMessage(t('The scorecard is not read yet.')); return; }
        await vscode.env.clipboard.writeText(report);
        const open = t('Open in an editor');
        if (await vscode.window.showInformationMessage(t('The security scorecard is on the clipboard as Markdown.'), open) === open) {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: report }));
        }
      }
    } catch (e) { fail(e); }
  });
  await load();
}

export function registerHealthInsights(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { fail(e); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.lockWaitChains', wrap(() => lockWaitChains(manager))),
    vscode.commands.registerCommand('vanthrex.limitsWatch', wrap(() => limitsWatch(manager))),
    vscode.commands.registerCommand('vanthrex.securityScorecard', wrap(() => securityScorecard(manager))),
  );
}
