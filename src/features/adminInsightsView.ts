// Function Usage Map, User Storage Map and Reply List Check pages. Logic in core/adminInsights.ts; the pages only
// read — nothing is changed on the IBM i from here.
import * as vscode from 'vscode';
import {
  effectiveUsage, functionInfoSql, functionMatrix, functionUsageSql, kbLabel, messageTextSql, ReplyIssue, replyEntries, replyListSql,
  storageUses, userStorageSql,
} from '../core/adminInsights';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { page } from './visualsView';
import { escapeHtml } from './webviewUtil';

type Row = Record<string, unknown>;
const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);
const opts = { enableScripts: true, retainContextWhenHidden: true };
const fail = (e: unknown) => { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); };
const CSS = `.dim { color: var(--vscode-descriptionForeground); } .bad { color: #e15759; } .warn { color: #f28e2b; } .good { color: #59a14f; }`;
const filterBar = () => `<div class="bar"><button id="refresh">${escapeHtml(t('Refresh'))}</button><input id="q" placeholder="${escapeHtml(t('Filter…'))}"></div>`;
const filterScript = (sel: string) => `const q = document.getElementById('q'); q.oninput = () => { const f = q.value.toLowerCase(); document.querySelectorAll('${sel}').forEach(r => { r.hidden = !!f && !r.textContent.toLowerCase().includes(f); }); };`;

/** A page that loads with `render`, shows a wait text first and the error if loading fails; Refresh reloads. */
async function simplePage(id: string, title: string, waitText: string, script: string, render: () => Promise<{ body: string; css: string }>): Promise<void> {
  const panel = vscode.window.createWebviewPanel(id, title, vscode.ViewColumn.Active, opts);
  const load = async () => {
    panel.webview.html = page(title, filterBar() + `<div class="empty">${escapeHtml(waitText)}</div>`, '', script);
    try { const r = await render(); panel.webview.html = page(title, filterBar() + r.body, CSS + r.css, script); }
    catch (e) { logError(e); panel.webview.html = page(title, filterBar() + `<div class="err">${escapeHtml(errorMessage(e))}</div>`, '', script); }
  };
  panel.webview.onDidReceiveMessage(async (m: { type?: string }) => { try { if (m?.type === 'refresh') { await load(); } } catch (e) { fail(e); } });
  await load();
}

// ---------------------------------------------------------------- Function Usage Map

async function functionUsageMap(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  await simplePage('vanthrex.functionUsageMap', t('Function Usage Map'), t('Reading QSYS2.FUNCTION_INFO and QSYS2.FUNCTION_USAGE…'), filterScript('tr.fu'), async () => {
    const [info, uses] = await Promise.all([conn.rows<Row>(functionInfoSql(), 5000), conn.rows<Row>(functionUsageSql(), 50000)]);
    const m = functionMatrix(info, uses);
    const users = m.users.slice(0, 80);
    const head = `<tr><th class="fn">${escapeHtml(t('Function'))}</th><th>${escapeHtml(t('Default'))}</th>${users.map(u => `<th class="u"><div title="${escapeHtml(u.group ? t('Group profile') : u.name)}">${escapeHtml(u.name)}${u.group ? ' ⧉' : ''}</div></th>`).join('')}</tr>`;
    const cell = (user: string, f: typeof m.functions[number]) => {
      const e = effectiveUsage(m, user, f);
      const tip = `${user} · ${f.id}\n${e.usage === 'ALLOWED' ? t('Allowed') : t('Denied')} ${e.explicit ? t('(own entry)') : t('(from *PUBLIC or the default)')}`;
      return `<td class="c ${e.usage === 'ALLOWED' ? 'al' : 'de'} ${e.explicit ? 'ex' : ''}" title="${escapeHtml(tip)}">${e.explicit ? (e.usage === 'ALLOWED' ? '✔' : '✖') : ''}</td>`;
    };
    const rows = m.functions.map(f => `<tr class="fu"><td class="fn"><code>${escapeHtml(f.id)}</code>${f.sensitive ? ` <span class="pill" title="${escapeHtml(t('Gives powers worth knowing about'))}">${escapeHtml(t('sensitive'))}</span>` : ''}${f.allObj ? ` <span class="dim" title="${escapeHtml(t('Users with *ALLOBJ may use it whatever the entries say'))}">*ALLOBJ</span>` : ''}<br><small class="dim">${escapeHtml(f.name)}</small></td>
<td class="${f.defaultUsage === 'ALLOWED' ? 'warn' : 'dim'}">${escapeHtml(f.defaultUsage === 'ALLOWED' ? t('Allowed') : t('Denied'))}</td>${users.map(u => cell(u.name, f)).join('')}</tr>`).join('');
    const body = `
<div class="tiles">
  <div class="tile"><b>${m.functions.filter(f => f.entries).length}</b><span>${escapeHtml(t('Functions with entries'))}</span></div>
  <div class="tile"><b>${m.users.length}</b><span>${escapeHtml(t('Users and groups with entries'))}</span></div>
  <div class="tile"><b class="${m.openToAll.length ? 'warn' : 'good'}">${m.openToAll.length}</b><span>${escapeHtml(t('Sensitive functions open to everyone'))}</span></div>
</div>
${m.openToAll.length ? `<p class="warn">⚠ ${escapeHtml(t('Every user may use: {0}. Deny *PUBLIC (CHGFCNUSG) if not everyone needs it.', m.openToAll.join(', ')))}</p>` : ''}
<div class="legend"><span class="k"><i class="sw" style="background:#59a14f"></i>${escapeHtml(t('Allowed'))}</span><span class="k"><i class="sw" style="background:#e15759"></i>${escapeHtml(t('Denied'))}</span><span class="k">✔ ✖ ${escapeHtml(t('own entry; empty: from *PUBLIC or the default'))}</span></div>
<div class="wrap"><table class="grid">${head}${rows}</table></div>
${m.users.length > 80 ? `<p class="dim">${escapeHtml(t('{0} more not shown.', m.users.length - 80))}</p>` : ''}
<p class="dim">${escapeHtml(t('Shows the functions that have entries and the sensitive ones. A user without an entry gets the group or *PUBLIC entry, else the default; group entries are applied by the system, not shown per user here.'))}</p>`;
    return { body, css: `
  .wrap { overflow-x: auto; } table.grid { border-collapse: collapse; } .grid td, .grid th { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
  th.u { vertical-align: bottom; height: 110px; padding: 2px; } th.u div { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-weight: 500; }
  td.fn { min-width: 240px; } td.c { text-align: center; width: 22px; color: #fff; font-size: .85em; }
  td.al { background: rgba(89,161,79,.35); } td.de { background: rgba(225,87,89,.25); } td.ex.al { background: #59a14f; } td.ex.de { background: #e15759; }
  tr.fu[hidden] { display: none; } .pill { background: #f28e2b; color: #fff; border-radius: 9px; padding: 0 6px; font-size: .8em; }` };
  });
}

// ---------------------------------------------------------------- User Storage Map

async function userStorageMap(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  await simplePage('vanthrex.userStorageMap', t('User Storage Map'), t('Reading QSYS2.USER_STORAGE…'), filterScript('.su'), async () => {
    const s = storageUses(await conn.rows<Row>(userStorageSql(), 50000));
    const top = s.users[0]?.usedKb || 1;
    const near = s.users.filter(u => (u.pctOfMax ?? 0) >= 90);
    const rows = s.users.slice(0, 400).map(u => {
      const color = (u.pctOfMax ?? 0) >= 90 ? '#e15759' : (u.pctOfMax ?? 0) >= 75 ? '#f28e2b' : '#4e79a7';
      return `<div class="su" title="${escapeHtml(`${u.user}\n${kbLabel(u.usedKb)}${u.maxKb !== null ? ` / ${kbLabel(u.maxKb)} (MAXSTG)` : ' · MAXSTG *NOMAX'}\n${t('{0} % of all user storage', u.share)}`)}">
<b>${escapeHtml(u.user)}</b><div class="bar2"><div style="width:${Math.max(0.5, u.usedKb / top * 100).toFixed(1)}%;background:${color}"></div></div>
<span class="num">${escapeHtml(kbLabel(u.usedKb))}</span><span class="num dim">${u.share.toFixed(1)} %</span>
<span class="num" style="color:${u.pctOfMax !== null ? color : 'inherit'}">${u.pctOfMax !== null ? `${u.pctOfMax.toFixed(1)} % ${escapeHtml(t('of MAXSTG'))}` : `<span class="dim">*NOMAX</span>`}</span></div>`;
    }).join('');
    const body = `
<div class="tiles">
  <div class="tile"><b>${escapeHtml(kbLabel(s.totalKb))}</b><span>${escapeHtml(t('Owned by user profiles'))}</span></div>
  <div class="tile"><b>${s.users.length}</b><span>${escapeHtml(t('Profiles'))}</span></div>
  <div class="tile"><b>${s.users[0] ? `${s.users.slice(0, 10).reduce((x, u) => x + u.share, 0).toFixed(1)} %` : '-'}</b><span>${escapeHtml(t('Owned by the 10 largest'))}</span></div>
  <div class="tile"><b class="${near.length ? 'bad' : 'good'}">${near.length}</b><span>${escapeHtml(t('At 90 % of MAXSTG or more'))}</span></div>
</div>
${near.length ? `<p class="bad">⚠ ${escapeHtml(t('These profiles can soon no longer create objects (MAXSTG reached): {0}', near.map(u => u.user).join(', ')))}</p>` : ''}
<div class="su head dim"><span>${escapeHtml(t('Profile'))}</span><span></span><span class="num">${escapeHtml(t('Owned'))}</span><span class="num">${escapeHtml(t('Share'))}</span><span class="num">MAXSTG</span></div>
${s.users.length ? rows : `<div class="empty">${escapeHtml(t('No user storage is visible with your authority.'))}</div>`}
${s.users.length > 400 ? `<p class="dim">${escapeHtml(t('{0} more not shown.', s.users.length - 400))}</p>` : ''}
<p class="dim">${escapeHtml(t('From QSYS2.USER_STORAGE: the storage of the objects each profile owns, all ASPs together. Only the profiles you are authorized to see are listed.'))}</p>`;
    return { body, css: `
  .su { display: grid; grid-template-columns: 110px minmax(120px, 1fr) 80px 60px 140px; gap: 10px; align-items: center; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .su[hidden] { display: none; } .su.head { border-bottom-width: 2px; } .num { text-align: right; white-space: nowrap; }
  .bar2 { height: 12px; background: var(--vscode-editorWidget-background); border-radius: 3px; overflow: hidden; } .bar2 > div { height: 100%; }
  @media (max-width: 600px) { .su { grid-template-columns: 90px 1fr 70px; } .su > :nth-child(4), .su > :nth-child(5) { display: none; } }` };
  });
}

// ---------------------------------------------------------------- Reply List Check

async function replyListCheck(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  await simplePage('vanthrex.replyListCheck', t('Reply List Check'), t('Reading the system reply list…'), filterScript('tr.rl'), async () => {
    const list = replyEntries(await conn.rows<Row>(replyListSql(), 5000));
    const textSql = messageTextSql(list.map(e => e.msgId));
    const texts = new Map((textSql ? await conn.rows<Row>(textSql, 5000).catch(() => [] as Row[]) : []).map(r => [String(r.ID ?? '').trim(), String(r.TXT ?? '').trim()]));
    const label: Record<ReplyIssue, string> = { any: t('Answers every inquiry message'), shadowed: t('Never reached'), dump: t('Dumps the job each time') };
    const color: Record<ReplyIssue, string> = { any: '#e15759', shadowed: '#f28e2b', dump: '#f28e2b' };
    const rows = list.map(e => `<tr class="rl"><td class="n">${e.seq}</td><td><code>${escapeHtml(e.msgId)}</code><br><small class="dim">${escapeHtml(texts.get(e.msgId) ?? (e.msgId.endsWith('00') && e.msgId.length === 7 ? t('All messages starting with {0}', e.msgId.slice(0, 3) + e.msgId.slice(3).replace(/0+$/, '')) : ''))}</small></td>
<td>${e.compare ? `<code>${escapeHtml(e.compare)}</code>${e.start > 1 ? ` <span class="dim">${escapeHtml(t('at position {0}', e.start))}</span>` : ''}` : `<span class="dim">-</span>`}</td><td><code>${escapeHtml(e.reply)}</code></td><td>${e.dump ? '*YES' : '*NO'}</td>
<td>${e.issues.map(i => `<span class="pill" style="background:${color[i]}" title="${escapeHtml(i === 'shadowed' ? t('Entry {0} already answers all these messages', e.shadowedBy ?? '') : label[i])}">${escapeHtml(label[i])}${i === 'shadowed' ? ` (${e.shadowedBy})` : ''}</span>`).join(' ')}</td></tr>`).join('');
    const n = (i: ReplyIssue) => list.filter(e => e.issues.includes(i)).length;
    const body = `
<div class="tiles">
  <div class="tile"><b>${list.length}</b><span>${escapeHtml(t('Entries'))}</span></div>
  <div class="tile"><b class="${n('any') ? 'bad' : 'good'}">${n('any')}</b><span>${escapeHtml(t('Answer every message (*ANY)'))}</span></div>
  <div class="tile"><b class="${n('shadowed') ? 'warn' : 'good'}">${n('shadowed')}</b><span>${escapeHtml(t('Never reached'))}</span></div>
  <div class="tile"><b class="${n('dump') ? 'warn' : ''}">${n('dump')}</b><span>${escapeHtml(t('Dump the job'))}</span></div>
</div>
${list.length ? `<table><tr><th>${escapeHtml(t('Seq'))}</th><th>${escapeHtml(t('Message'))}</th><th>${escapeHtml(t('Compare data'))}</th><th>${escapeHtml(t('Reply'))}</th><th>${escapeHtml(t('Dump'))}</th><th>${escapeHtml(t('To look at'))}</th></tr>${rows}</table>` : `<div class="empty">${escapeHtml(t('The system reply list is empty.'))}</div>`}
<p class="dim">${escapeHtml(t('The reply list answers inquiry messages of jobs that run with INQMSGRPY(*SYSRPYL); the first matching entry wins. A generic ID such as CPA5300 matches every CPA53xx message. Change it with WRKRPYLE; nothing is changed from this page.'))}</p>`;
    return { body, css: `tr.rl[hidden] { display: none; } td { vertical-align: top; } .pill { color: #fff; border-radius: 9px; padding: 1px 8px; font-size: .85em; white-space: nowrap; }` };
  });
}

export function registerAdminInsights(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { fail(e); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.functionUsageMap', wrap(() => functionUsageMap(manager))),
    vscode.commands.registerCommand('vanthrex.userStorageMap', wrap(() => userStorageMap(manager))),
    vscode.commands.registerCommand('vanthrex.replyListCheck', wrap(() => replyListCheck(manager))),
  );
}
