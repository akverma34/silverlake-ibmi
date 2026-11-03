// Productivity: hover a file or a field in RPG to see its columns from Db2 (and complete field names), Ctrl+click a
// file to open its DDS source; SQL watches in the status bar with alerts; CL macros with ${variables}; bookmarks on
// lines of members and IFS files; saved sets of open sources; and running the selected text as CL or SQL.
import * as vscode from 'vscode';
import { clCommandsIn, columnType, expandMacro, fieldOf, fileMarkdown, filesInSource, looksLikeSql, macroVariables, parseCondition, shouldAlert, watchValue, Condition, DeclaredFile, FileColumn } from '../core/productivity';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError, showLog } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { sqlString } from '../core/util';
import { IFS_SCHEME, MEMBER_SCHEME, memberUri } from './fileSystems';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

// ---------------------------------------------------------------- file and field information

interface FileInfo { library: string; text: string; cols: FileColumn[]; source?: { lib: string; file: string; member: string; type: string } }
const fileCache = new Map<string, { at: number; info?: FileInfo }>();

async function fileInfo(conn: IbmiConnection, f: DeclaredFile): Promise<FileInfo | undefined> {
  const key = `${conn.profile.id}|${f.library ?? '*LIBL'}|${f.file}`;
  const c = fileCache.get(key);
  if (c && Date.now() - c.at < 10 * 60000) { return c.info; }
  let info: FileInfo | undefined;
  try {
    const lib = f.library ?? s((await conn.rows<Row>(`SELECT T.SYSTEM_TABLE_SCHEMA AS L FROM QSYS2.SYSTABLES T JOIN QSYS2.LIBRARY_LIST_INFO L ON L.SCHEMA_NAME = T.SYSTEM_TABLE_SCHEMA ` +
      `WHERE T.SYSTEM_TABLE_NAME = ${sqlString(f.file)} ORDER BY L.ORDINAL_POSITION FETCH FIRST 1 ROW ONLY`, 1))[0], 'L');
    if (lib) {
      const cols = (await conn.rows<Row>(`SELECT SYSTEM_COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL, COALESCE(COLUMN_TEXT, '') AS X, COALESCE(COLUMN_HEADING, '') AS H ` +
        `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f.file)} ORDER BY ORDINAL_POSITION`, 2000))
        .map(r => ({ name: s(r, 'N'), type: s(r, 'T'), length: Number(r.L) || 0, scale: Number(r.S) || 0, nullable: s(r, 'NL') === 'Y', text: s(r, 'X'), heading: s(r, 'H').replace(/\s{2,}/g, ' ') }));
      const o = (await conn.rows<Row>(`SELECT COALESCE(OBJTEXT, '') AS X, COALESCE(SOURCE_LIBRARY, '') AS SL, COALESCE(SOURCE_FILE, '') AS SF, COALESCE(SOURCE_MEMBER, '') AS SM ` +
        `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*FILE', ${sqlString(f.file)})) O`, 1).catch(() => [] as Row[]))[0];
      let source: FileInfo['source'];
      if (s(o, 'SM')) {
        const t = (await conn.rows<Row>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(s(o, 'SL'))} AND SYSTEM_TABLE_NAME = ${sqlString(s(o, 'SF'))} AND SYSTEM_TABLE_MEMBER = ${sqlString(s(o, 'SM'))}`, 1).catch(() => [] as Row[]))[0];
        if (t) { source = { lib: s(o, 'SL'), file: s(o, 'SF'), member: s(o, 'SM'), type: s(t, 'T') || 'pf' }; }
      }
      info = { library: lib, text: s(o, 'X'), cols, source };
    }
  } catch (e) { log(`File information for ${f.file}: ${errorMessage(e)}`); }
  fileCache.set(key, { at: Date.now(), info });
  return info;
}

const enabled = () => vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('fileFieldHelp', true);

async function fileHover(manager: ConnectionManager, doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
  const conn = manager.connection;
  if (!conn || !enabled()) { return undefined; }
  const range = doc.getWordRangeAtPosition(pos, /[A-Za-z$#@_][\w$#@]*(\.[A-Za-z$#@_][\w$#@]*)?/);
  if (!range) { return undefined; }
  const word = doc.getText(range).toUpperCase();
  const files = filesInSource(doc.getText());
  if (!files.length) { return undefined; }
  const f = files.find(x => x.name === word);
  if (f) {
    const info = await fileInfo(conn, f);
    return info ? new vscode.Hover(new vscode.MarkdownString(fileMarkdown(f, info.library, info.cols, info.text)), range) : undefined;
  }
  // A field: only when it is not declared in the source itself.
  if (new RegExp(`^\\s*dcl-[sc]\\s+${word.split('.').pop()!.replace(/[$#@]/g, '\\$&')}\\b`, 'im').test(doc.getText())) { return undefined; }
  const withCols: { file: DeclaredFile; cols: FileColumn[]; info: FileInfo }[] = [];
  for (const x of files.slice(0, 12)) { const i = await fileInfo(conn, x); if (i) { withCols.push({ file: x, cols: i.cols, info: i }); } }
  const hit = fieldOf(word, withCols);
  if (!hit) { return undefined; }
  const info = withCols.find(w => w.file === hit.file)!.info;
  const c = hit.col;
  const md = new vscode.MarkdownString(`**${c.name}** \`${columnType(c)}${c.nullable ? ' null' : ''}\`  \nfield of **${info.library}/${hit.file.file}**${c.text ? `  \n${c.text}` : ''}${c.heading && c.heading !== c.text ? `  \n_${c.heading}_` : ''}`);
  return new vscode.Hover(md, range);
}

async function fieldCompletion(manager: ConnectionManager, doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
  const conn = manager.connection;
  if (!conn || !enabled()) { return []; }
  const before = doc.lineAt(pos.line).text.slice(0, pos.character);
  const q = /([A-Za-z$#@_][\w$#@]*)\.([\w$#@]*)$/.exec(before);
  const files = filesInSource(doc.getText());
  const out: vscode.CompletionItem[] = [];
  for (const f of files.slice(0, 12)) {
    if (q && q[1].toUpperCase() !== f.name) { continue; }
    const info = await fileInfo(conn, f);
    for (const c of info?.cols ?? []) {
      const it = new vscode.CompletionItem(q || !f.prefix ? c.name : `${f.prefix}${c.name}`, vscode.CompletionItemKind.Field);
      it.detail = `${columnType(c)} · ${info!.library}/${f.file}`;
      it.documentation = c.text || c.heading;
      it.sortText = `~${it.label}`;
      out.push(it);
    }
  }
  return out;
}

async function fileDefinition(manager: ConnectionManager, doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
  const conn = manager.connection;
  if (!conn) { return undefined; }
  const range = doc.getWordRangeAtPosition(pos, /[A-Za-z$#@_][\w$#@]*/);
  if (!range) { return undefined; }
  const word = doc.getText(range).toUpperCase();
  const f = filesInSource(doc.getText()).find(x => x.name === word);
  if (!f) { return undefined; }
  const info = await fileInfo(conn, f);
  return info?.source ? new vscode.Location(memberUri(info.source.lib, info.source.file, info.source.member, info.source.type), new vscode.Position(0, 0)) : undefined;
}

// ---------------------------------------------------------------- SQL watch

interface Watch { id: number; name: string; sql: string; seconds: number; cond: Condition; condText: string; system: string; last?: string; timer?: NodeJS.Timeout; item: vscode.StatusBarItem; errors: number }
const watches = new Map<number, Watch>();
let nextWatch = 1;
const WATCHES_KEY = 'vanthrex.sqlWatches';

function stopWatch(w: Watch): void { if (w.timer) { clearInterval(w.timer); } w.item.dispose(); watches.delete(w.id); }

function startWatch(manager: ConnectionManager, state: vscode.Memento, def: { name: string; sql: string; seconds: number; cond: string; system: string }, save = true): void {
  const cond = parseCondition(def.cond);
  const w: Watch = { id: nextWatch++, name: def.name, sql: def.sql, seconds: def.seconds, cond, condText: def.cond, system: def.system, item: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50), errors: 0 };
  w.item.command = { command: 'vanthrex.sqlWatch.manage', title: '' };
  w.item.text = `$(eye) ${w.name}: …`;
  w.item.tooltip = `${def.sql}\n${vscode.l10n.t('Every {0} s · alert when {1}', def.seconds, cond.text)}`;
  w.item.show();
  const tick = async () => {
    const conn = manager.openConnections.find(c => c.profile.id === w.system);
    if (!conn) { w.item.text = `$(eye-closed) ${w.name}: ${vscode.l10n.t('not connected')}`; return; }
    try {
      const v = watchValue(await conn.rows<Row>(w.sql, 50));
      const alert = shouldAlert(w.cond, w.last, v);
      w.last = v; w.errors = 0;
      w.item.text = `$(eye) ${w.name}: ${v}`;
      w.item.backgroundColor = w.cond.text !== 'changes' && w.cond.test(v) ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      if (alert) {
        const stop = vscode.l10n.t('Stop Watching');
        void vscode.window.showWarningMessage(vscode.l10n.t('{0} on {1}: {2}', w.name, conn.profile.name, v), stop).then(c => { if (c) { stopWatch(w); void saveWatches(state); } });
      }
    } catch (e) {
      w.errors++;
      w.item.text = `$(warning) ${w.name}`;
      w.item.tooltip = errorMessage(e);
      if (w.errors >= 5) { log(`SQL watch ${w.name} stopped: ${errorMessage(e)}`); stopWatch(w); }
    }
  };
  w.timer = setInterval(() => { void tick(); }, Math.max(5, w.seconds) * 1000);
  watches.set(w.id, w);
  void tick();
  if (save) { void saveWatches(state); }
}

const saveWatches = (state: vscode.Memento) => state.update(WATCHES_KEY, [...watches.values()].map(w => ({ name: w.name, sql: w.sql, seconds: w.seconds, cond: w.condText, system: w.system })));

async function addWatch(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const ed = vscode.window.activeTextEditor;
  const sel = ed && !ed.selection.isEmpty && ed.document.languageId === 'sql' ? ed.document.getText(ed.selection).trim().replace(/;\s*$/, '') : '';
  const examples = [
    { label: vscode.l10n.t('Messages waiting for a reply'), sql: "SELECT COUNT(*) FROM TABLE(QSYS2.MESSAGE_QUEUE_INFO(QUEUE_LIBRARY => 'QSYS', QUEUE_NAME => 'QSYSOPR')) WHERE MESSAGE_TYPE = 'INQUIRY' AND ASSOCIATED_MESSAGE_KEY IS NULL", cond: '> 0' },
    { label: vscode.l10n.t('Jobs in MSGW'), sql: "SELECT COUNT(*) FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) WHERE JOB_STATUS = 'MSGW'", cond: '> 0' },
    { label: vscode.l10n.t('System ASP used %'), sql: 'SELECT DECIMAL(SYSTEM_ASP_USED, 5, 1) FROM QSYS2.SYSTEM_STATUS_INFO', cond: '> 85' },
    { label: vscode.l10n.t('Jobs waiting in a job queue'), sql: "SELECT COUNT(*) FROM QSYS2.JOB_INFO WHERE JOB_STATUS = 'JOBQ'", cond: '> 10' },
  ];
  const pick = sel ? { label: '', sql: sel, cond: 'changes' } : await vscode.window.showQuickPick([...examples, { label: vscode.l10n.t('$(edit) My own query…'), sql: '', cond: 'changes' }], { title: vscode.l10n.t('Watch what?') });
  if (!pick) { return; }
  const sql = pick.sql || (await vscode.window.showInputBox({ title: vscode.l10n.t('SELECT to run (the first value is shown)'), ignoreFocusOut: true }))?.trim();
  if (!sql) { return; }
  if (!/^\s*(select|with|values)\b/i.test(sql)) { throw new Error(vscode.l10n.t('A watch runs a SELECT, WITH or VALUES only.')); }
  const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Name shown in the status bar'), value: pick.label || 'SQL', ignoreFocusOut: true }))?.trim();
  if (!name) { return; }
  const cond = await vscode.window.showInputBox({ title: vscode.l10n.t('Alert when'), value: pick.cond, prompt: vscode.l10n.t('changes, > 100, = ACTIVE, != 0, contains MSGW'), validateInput: v => { try { parseCondition(v); return undefined; } catch (e) { return errorMessage(e); } } });
  if (cond === undefined) { return; }
  const secs = Number(await vscode.window.showInputBox({ title: vscode.l10n.t('Every how many seconds?'), value: '60', validateInput: v => (/^\d+$/.test(v) && +v >= 5 ? undefined : '≥ 5') }) ?? NaN);
  if (!secs) { return; }
  startWatch(manager, state, { name, sql, seconds: secs, cond, system: conn.profile.id });
}

async function manageWatches(state: vscode.Memento): Promise<void> {
  const list = [...watches.values()];
  if (!list.length) { await vscode.commands.executeCommand('vanthrex.sqlWatch.add'); return; }
  const pick = await vscode.window.showQuickPick([...list.map(w => ({ label: `$(eye) ${w.name}: ${w.last ?? '…'}`, description: vscode.l10n.t('every {0} s · alert when {1}', w.seconds, w.cond.text), detail: w.sql, w })),
    { label: vscode.l10n.t('$(add) Add a watch…'), w: undefined }], { title: vscode.l10n.t('SQL watches — pick one to stop it') });
  if (!pick) { return; }
  if (!pick.w) { await vscode.commands.executeCommand('vanthrex.sqlWatch.add'); return; }
  stopWatch(pick.w); await saveWatches(state);
}

// ---------------------------------------------------------------- CL macros

interface Macro { name: string; commands: string[]; description?: string }

async function runCommands(conn: IbmiConnection, cmds: string[], title: string): Promise<void> {
  const done: string[] = [];
  const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (p, token) => {
    for (const [i, c] of cmds.entries()) {
      if (token.isCancellationRequested) { return false; }
      p.report({ message: `${i + 1}/${cmds.length} ${c.split(/[\s(]/)[0]}`, increment: 100 / cmds.length });
      const r = await conn.runCL(c);
      log(`${r.ok ? '✔' : '✖'} ${c}${(r.stdout + r.stderr).trim() ? '\n' + (r.stdout + r.stderr).trim() : ''}`);
      if (!r.ok) {
        const last = (r.stderr || r.stdout).trim().split('\n').pop() ?? '';
        const show = vscode.l10n.t('Show Output');
        void vscode.window.showErrorMessage(vscode.l10n.t('✖ Step {0} of {1} failed: {2} — {3}', i + 1, cmds.length, c, last), show).then(x => { if (x) { showLog(); } });
        return false;
      }
      done.push(c);
    }
    return true;
  });
  if (ok) {
    const show = vscode.l10n.t('Show Output');
    void vscode.window.showInformationMessage(vscode.l10n.t('✔ {0} command(s) ran.', done.length), show).then(x => { if (x) { showLog(); } });
  }
}

async function runMacro(manager: ConnectionManager, state: vscode.Memento, name?: string): Promise<void> {
  const conn = manager.require();
  const macros = vscode.workspace.getConfiguration('vanthrex').get<Macro[]>('macros', []);
  if (!macros.length) {
    const open = vscode.l10n.t('Create a Macro');
    if (await vscode.window.showInformationMessage(vscode.l10n.t('No CL macro yet. A macro is a list of CL commands with ${VARIABLES} you fill in when it runs (setting vanthrex.macros).'), open)) {
      await vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'vanthrex.macros', edit: true } });
    }
    return;
  }
  const m = (name ? macros.find(x => x.name === name) : undefined) ?? (await vscode.window.showQuickPick(macros.map(x => ({ label: `$(play) ${x.name}`, description: x.description, detail: x.commands.join('  ·  '), x })), { title: vscode.l10n.t('Run which CL macro?') }))?.x;
  if (!m) { return; }
  const last = state.get<Record<string, string>>('vanthrex.macroValues', {});
  const values: Record<string, string> = {};
  for (const v of macroVariables(m.commands)) {
    const x = await vscode.window.showInputBox({ title: `${m.name} — ${v.name}`, value: last[v.name] ?? v.default, ignoreFocusOut: true });
    if (x === undefined) { return; }
    values[v.name] = x.trim();
  }
  await state.update('vanthrex.macroValues', { ...last, ...values });
  const cmds = expandMacro(m.commands, values, { USER: conn.user, CURLIB: conn.profile.currentLibrary || '*CRTDFT' });
  const go = vscode.l10n.t('Run');
  if (await vscode.window.showInformationMessage(vscode.l10n.t('Run {0} on {1}?', m.name, conn.profile.name), { modal: true, detail: cmds.join('\n') }, go) !== go) { return; }
  await runCommands(conn, cmds, vscode.l10n.t('Running {0}…', m.name));
}

// ---------------------------------------------------------------- run selection

async function runSelection(manager: ConnectionManager): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const text = (ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).text : ed.document.getText(ed.selection)).replace(/^\s*(\/\/|\*|--)\s?/gm, '').trim();
  if (!text) { return; }
  if (looksLikeSql(text)) {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: text.replace(/;?\s*$/, ';') + '\n' });
    const e = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    e.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand('vanthrex.runSql');
    return;
  }
  const cmds = clCommandsIn(text);
  if (cmds.length === 1) { await vscode.commands.executeCommand('vanthrex.runCl', cmds[0]); return; }
  const conn = manager.require();
  const go = vscode.l10n.t('Run');
  if (await vscode.window.showInformationMessage(vscode.l10n.t('Run these {0} CL commands on {1}?', cmds.length, conn.profile.name), { modal: true, detail: cmds.join('\n') }, go) !== go) { return; }
  await runCommands(conn, cmds, vscode.l10n.t('Running {0} command(s)…', cmds.length));
}

// ---------------------------------------------------------------- bookmarks

interface Bookmark { uri: string; line: number; text: string; label: string; system: string }
const BM_KEY = 'vanthrex.bookmarks';
const bmDecoration = vscode.window.createTextEditorDecorationType({ overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Left, isWholeLine: true, backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'), before: { contentText: '🔖', margin: '0 4px 0 0' } });

function decorate(state: vscode.Memento): void {
  const all = state.get<Bookmark[]>(BM_KEY, []);
  for (const e of vscode.window.visibleTextEditors) {
    e.setDecorations(bmDecoration, all.filter(b => b.uri === e.document.uri.toString()).filter(b => b.line < e.document.lineCount).map(b => new vscode.Range(b.line, 0, b.line, 0)));
  }
}

async function toggleBookmark(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const uri = ed.document.uri.toString(); const line = ed.selection.active.line;
  const all = state.get<Bookmark[]>(BM_KEY, []);
  const i = all.findIndex(b => b.uri === uri && b.line === line);
  if (i >= 0) { all.splice(i, 1); }
  else {
    const name = ed.document.uri.scheme === MEMBER_SCHEME ? ed.document.uri.path.slice(1).replace(/\.[^.]*$/, '') : ed.document.uri.path.split('/').pop() ?? '';
    all.unshift({ uri, line, text: ed.document.lineAt(line).text.trim().slice(0, 120), label: `${name}:${line + 1}`, system: manager.connection?.profile.name ?? '' });
  }
  await state.update(BM_KEY, all.slice(0, 300));
  decorate(state);
  vscode.window.setStatusBarMessage(i >= 0 ? vscode.l10n.t('Bookmark removed.') : vscode.l10n.t('Bookmark added — Ctrl+Alt+Shift+B lists them.'), 3000);
}

async function listBookmarks(state: vscode.Memento): Promise<void> {
  const all = state.get<Bookmark[]>(BM_KEY, []);
  if (!all.length) { vscode.window.showInformationMessage(vscode.l10n.t('No bookmark yet: Ctrl+Alt+B on a line adds one.')); return; }
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { b: Bookmark }>();
  qp.title = vscode.l10n.t('Bookmarks ({0})', all.length);
  qp.matchOnDescription = true; qp.matchOnDetail = true;
  qp.items = all.map(b => ({ label: `$(bookmark) ${b.label}`, description: b.system, detail: b.text, b, buttons: [{ iconPath: new vscode.ThemeIcon('close'), tooltip: vscode.l10n.t('Remove') }] }));
  qp.onDidTriggerItemButton(async e => {
    const left = state.get<Bookmark[]>(BM_KEY, []).filter(b => !(b.uri === e.item.b.uri && b.line === e.item.b.line));
    await state.update(BM_KEY, left); qp.items = qp.items.filter(x => x !== e.item); decorate(state);
  });
  qp.onDidAccept(async () => {
    const b = qp.selectedItems[0]?.b; qp.hide();
    if (!b) { return; }
    const ed = await vscode.window.showTextDocument(vscode.Uri.parse(b.uri), { preview: false });
    const pos = new vscode.Position(Math.min(b.line, ed.document.lineCount - 1), 0);
    ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// ---------------------------------------------------------------- source sets

interface SourceSet { name: string; system: string; uris: string[]; saved: string }
const SETS_KEY = 'vanthrex.sourceSets';

async function saveSet(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const uris = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => (t.input as { uri?: vscode.Uri } | undefined)?.uri).filter((u): u is vscode.Uri => !!u && (u.scheme === MEMBER_SCHEME || u.scheme === IFS_SCHEME));
  if (!uris.length) { vscode.window.showInformationMessage(vscode.l10n.t('No member or IFS file is open.')); return; }
  const sets = state.get<SourceSet[]>(SETS_KEY, []);
  const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Name of this set of {0} open source(s)', uris.length), placeHolder: vscode.l10n.t('Ticket 1234, order entry…'), ignoreFocusOut: true }))?.trim();
  if (!name) { return; }
  const set: SourceSet = { name, system: manager.connection?.profile.name ?? '', uris: [...new Set(uris.map(u => u.toString()))], saved: new Date().toISOString().slice(0, 16).replace('T', ' ') };
  await state.update(SETS_KEY, [set, ...sets.filter(x => x.name !== name)].slice(0, 50));
  vscode.window.setStatusBarMessage(vscode.l10n.t('Set "{0}" saved with {1} source(s).', name, set.uris.length), 4000);
}

async function openSet(state: vscode.Memento): Promise<void> {
  const sets = state.get<SourceSet[]>(SETS_KEY, []);
  if (!sets.length) { vscode.window.showInformationMessage(vscode.l10n.t('No saved set yet: open the sources of a task, then Save the Open Sources as a Set.')); return; }
  const pick = await vscode.window.showQuickPick(sets.map(x => ({ label: `$(files) ${x.name}`, description: `${x.uris.length} · ${x.system} · ${x.saved}`, detail: x.uris.map(u => vscode.Uri.parse(u).path.slice(1)).join(', ').slice(0, 300), x,
    buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Delete this set') }] })), { title: vscode.l10n.t('Open which set of sources?') });
  if (!pick) { return; }
  let n = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Opening {0}…', pick.x.name) }, async () => {
    for (const u of pick.x.uris) {
      try { await vscode.window.showTextDocument(vscode.Uri.parse(u), { preview: false, preserveFocus: true }); n++; } catch (e) { logError(e); }
    }
  });
  vscode.window.setStatusBarMessage(vscode.l10n.t('{0} of {1} source(s) opened.', n, pick.x.uris.length), 4000);
}

async function deleteSet(state: vscode.Memento): Promise<void> {
  const sets = state.get<SourceSet[]>(SETS_KEY, []);
  const pick = await vscode.window.showQuickPick(sets.map(x => ({ label: x.name, description: `${x.uris.length}`, x })), { title: vscode.l10n.t('Delete which set?') });
  if (pick) { await state.update(SETS_KEY, sets.filter(x => x !== pick.x)); }
}

export function registerProductivity(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const st = context.globalState;
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  const RPG = [{ language: 'rpgle' }];
  context.subscriptions.push(
    bmDecoration,
    vscode.languages.registerHoverProvider(RPG, { provideHover: (d, p) => fileHover(manager, d, p) }),
    vscode.languages.registerCompletionItemProvider(RPG, { provideCompletionItems: (d, p) => fieldCompletion(manager, d, p) }, '.'),
    vscode.languages.registerDefinitionProvider(RPG, { provideDefinition: (d, p) => fileDefinition(manager, d, p) }),
    vscode.commands.registerCommand('vanthrex.sqlWatch.add', wrap(() => addWatch(manager, st))),
    vscode.commands.registerCommand('vanthrex.sqlWatch.manage', wrap(() => manageWatches(st))),
    vscode.commands.registerCommand('vanthrex.runMacro', wrap((n?: string) => runMacro(manager, st, typeof n === 'string' ? n : undefined))),
    vscode.commands.registerCommand('vanthrex.runSelection', wrap(() => runSelection(manager))),
    vscode.commands.registerCommand('vanthrex.bookmark.toggle', wrap(() => toggleBookmark(manager, st))),
    vscode.commands.registerCommand('vanthrex.bookmark.list', wrap(() => listBookmarks(st))),
    vscode.commands.registerCommand('vanthrex.sourceSet.save', wrap(() => saveSet(manager, st))),
    vscode.commands.registerCommand('vanthrex.sourceSet.open', wrap(() => openSet(st))),
    vscode.commands.registerCommand('vanthrex.sourceSet.delete', wrap(() => deleteSet(st))),
    vscode.window.onDidChangeVisibleTextEditors(() => decorate(st)),
    manager.onDidChange(() => fileCache.clear()),
    { dispose: () => [...watches.values()].forEach(stopWatch) },
  );
  decorate(st);
  // Watches saved before start again once their system is connected.
  const restore = manager.onDidChange(conn => {
    if (!conn) { return; }
    for (const d of st.get<{ name: string; sql: string; seconds: number; cond: string; system: string }[]>(WATCHES_KEY, [])) {
      if (d.system === conn.profile.id && ![...watches.values()].some(w => w.system === d.system && w.name === d.name)) {
        try { startWatch(manager, st, d, false); } catch (e) { logError(e); }
      }
    }
  });
  context.subscriptions.push(restore);
}
