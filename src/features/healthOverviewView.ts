// System Health Overview: disk, limits, lock waits, jobs waiting for a reply and the security score on one page,
// each card with a traffic light and a button to the detail page. Every card is read on its own, so one that fails
// (no authority, older release) shows why and the others still work. Nothing is changed on the IBM i.
import * as vscode from 'vscode';
import { lockChains, LockRow, limitsSql, limitUses, objectLockWaitsSql, profileFindings, ProfileRow, profilesSql, rowLockWaitsSql, securityChecks, securityScore, securityValuesSql } from '../core/healthInsights';
import { diskCard, HealthArea, HealthCard, HealthLevel, limitsCard, locksCard, msgwJobsSql, overallLevel, repliesCard, securityCard } from '../core/healthOverview';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { aspSummary, DiskUnit, diskUnitsSql } from '../core/platformInsights';
import { page } from './visualsView';
import { escapeHtml } from './webviewUtil';

type Row = Record<string, unknown>;
const str = (r: Row, k: string) => String(r[k] ?? '').trim();
const num = (r: Row, k: string) => { const v = Number(r[k]); return isFinite(v) ? v : 0; };
const COLOR: Record<HealthLevel, string> = { ok: '#59a14f', warn: '#f28e2b', bad: '#e15759', unknown: '#79706e' };

const areaTitle = (a: HealthArea): string => ({
  disk: vscode.l10n.t('Disk space'), limits: vscode.l10n.t('Limits close to the maximum'), locks: vscode.l10n.t('Jobs waiting for a lock'),
  replies: vscode.l10n.t('Jobs waiting for a reply (MSGW)'), security: vscode.l10n.t('Security score'),
})[a];
const levelText = (l: HealthLevel): string => ({ ok: vscode.l10n.t('OK'), warn: vscode.l10n.t('Look at it'), bad: vscode.l10n.t('Act now'), unknown: vscode.l10n.t('Not available') })[l];
const openText = (a: HealthArea): string => ({
  disk: vscode.l10n.t('Disk Units Map'), limits: vscode.l10n.t('Limits Watch'), locks: vscode.l10n.t('Lock Wait Chains'),
  replies: vscode.l10n.t('Active Jobs Map'), security: vscode.l10n.t('Security Scorecard'),
})[a];

/** Reads one card; a failure becomes a grey card that says why. */
async function card(area: HealthArea, command: string, read: () => Promise<HealthCard>): Promise<HealthCard> {
  try { return await read(); } catch (e) {
    logError(e);
    return { area, level: 'unknown', value: '-', detail: [{ text: '{0}', args: [errorMessage(e).split('\n')[0].slice(0, 200)] }], command };
  }
}

let current: vscode.WebviewPanel | undefined;

async function healthOverview(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  if (current) { current.reveal(); return; }
  const title = vscode.l10n.t('System Health Overview');
  const panel = current = vscode.window.createWebviewPanel('vanthrex.healthOverview', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  let timer: NodeJS.Timeout | undefined; let auto = false; let busy = false;
  panel.onDidDispose(() => { current = undefined; if (timer) { clearInterval(timer); } });
  const toolbar = () => `<div class="bar"><button id="refresh">${escapeHtml(vscode.l10n.t('Refresh'))}</button>` +
    `<label><input type="checkbox" id="auto" ${auto ? 'checked' : ''}> ${escapeHtml(vscode.l10n.t('Refresh every minute'))}</label></div>`;
  const script = `document.getElementById('auto').onchange = e => vscode.postMessage({ type: 'auto', auto: e.target.checked });
document.addEventListener('click', e => { const b = e.target.closest('[data-cmd]'); if (b) vscode.postMessage({ type: 'open', command: b.dataset.cmd }); });`;
  const load = async (quiet = false) => {
    if (busy) { return; } busy = true;
    if (!quiet) { panel.webview.html = page(title, toolbar() + `<div class="empty">${escapeHtml(vscode.l10n.t('Checking disk, limits, locks, messages and security…'))}</div>`, '', script); }
    try {
      const cards = await Promise.all([
        card('disk', 'vanthrex.diskUnitsMap', async () => diskCard(aspSummary((await conn.rows<Row>(diskUnitsSql(), 5000)).map((r): DiskUnit => ({
          asp: num(r, 'ASP'), unit: num(r, 'UNIT'), resource: str(r, 'RES'), type: str(r, 'DTYPE'), model: str(r, 'MODEL'), ssd: num(r, 'SSD') === 1,
          capacity: num(r, 'CAP'), available: num(r, 'AVAIL'), pctUsed: num(r, 'PCT'), pctBusy: num(r, 'BUSY'),
        }))))),
        card('limits', 'vanthrex.limitsWatch', async () => limitsCard(limitUses(await conn.rows<Row>(limitsSql(), 5000)))),
        card('locks', 'vanthrex.lockWaitChains', async () => {
          const [objs, rows] = await Promise.all([conn.rows<LockRow>(objectLockWaitsSql(), 5000), conn.rows<LockRow>(rowLockWaitsSql(), 5000).catch(() => [] as LockRow[])]);
          return locksCard(lockChains([...objs, ...rows]));
        }),
        card('replies', 'vanthrex.jobsMap', async () => repliesCard((await conn.rows<Row>(msgwJobsSql(), 500)).map(r => str(r, 'JOB')))),
        card('security', 'vanthrex.securityScorecard', async () => {
          const [vals, profiles] = await Promise.all([conn.rows<Row>(securityValuesSql(), 100), conn.rows<ProfileRow>(profilesSql(), 50000).catch(() => undefined)]);
          const checks = securityChecks(Object.fromEntries(vals.map(r => [str(r, 'NAME'), str(r, 'VAL')])));
          return securityCard(securityScore(checks, profiles ? profileFindings(profiles) : undefined), checks);
        }),
      ]);
      const all = overallLevel(cards);
      const headline = { ok: vscode.l10n.t('Everything looks fine.'), warn: vscode.l10n.t('Some things are worth a look.'), bad: vscode.l10n.t('Something needs attention now.'), unknown: vscode.l10n.t('Nothing could be read with your authority.') }[all];
      const html = cards.map(c => `<div class="hc" style="--c:${COLOR[c.level]}">
<div class="hh"><span class="dot"></span><span class="ht">${escapeHtml(areaTitle(c.area))}</span><span class="lv">${escapeHtml(levelText(c.level))}</span></div>
<div class="hv">${escapeHtml(c.value)}</div>
<ul>${c.detail.map(d => `<li>${escapeHtml(vscode.l10n.t(d.text, ...d.args))}</li>`).join('')}</ul>
<button data-cmd="${escapeHtml(c.command)}">${escapeHtml(vscode.l10n.t('Open {0}', openText(c.area)))}</button></div>`).join('');
      const stamp = new Date().toLocaleTimeString();
      panel.webview.html = page(title, toolbar() + `<div class="overall" style="--c:${COLOR[all]}"><span class="dot big"></span>${escapeHtml(headline)}<span class="dim">${escapeHtml(vscode.l10n.t('{0} · read at {1}', conn.profile.name, stamp))}</span></div>
<div class="grid">${html}</div>
<p class="dim">${escapeHtml(vscode.l10n.t('Thresholds: disk 80 % / 90 % used, limits 75 % / 90 % of the maximum, 5 jobs waiting for a lock, any job waiting for a reply, security score below 75 / 60. The page only reads; open a card for the details.'))}</p>`, `
  .overall { display: flex; align-items: center; gap: 10px; font-size: 1.15em; font-weight: 600; margin: 10px 0 14px; padding: 10px 14px; border-radius: 6px; border-left: 5px solid var(--c); background: var(--vscode-editorWidget-background); }
  .overall .dim { margin-left: auto; font-weight: normal; font-size: .85em; } .dim { color: var(--vscode-descriptionForeground); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .hc { border: 1px solid var(--vscode-panel-border); border-top: 4px solid var(--c); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; }
  .hh { display: flex; align-items: center; gap: 6px; } .ht { font-weight: 600; } .lv { margin-left: auto; color: var(--c); font-size: .85em; font-weight: 600; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--c); display: inline-block; } .dot.big { width: 14px; height: 14px; }
  .hv { font-size: 2em; font-weight: 700; color: var(--c); margin: 6px 0; } ul { margin: 0 0 10px; padding-left: 18px; flex: 1; } li { margin: 2px 0; }
  .hc button { align-self: flex-start; }`, script);
    } catch (e) { logError(e); panel.webview.html = page(title, toolbar() + `<div class="err">${escapeHtml(errorMessage(e))}</div>`, '', script); }
    finally { busy = false; }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string; auto?: boolean; command?: string }) => {
    try {
      if (m?.type === 'refresh') { await load(); }
      else if (m?.type === 'auto') { auto = !!m.auto; if (timer) { clearInterval(timer); timer = undefined; } if (auto) { timer = setInterval(() => void load(true), 60000); } }
      else if (m?.type === 'open' && typeof m.command === 'string' && /^vanthrex\.(diskUnitsMap|limitsWatch|lockWaitChains|jobsMap|securityScorecard)$/.test(m.command)) {
        await vscode.commands.executeCommand(m.command);
      }
    } catch (e) { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); }
  });
  await load();
}

export function registerHealthOverview(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(vscode.commands.registerCommand('vanthrex.healthOverview', async () => {
    try { await healthOverview(manager); } catch (e) { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); }
  }));
}
