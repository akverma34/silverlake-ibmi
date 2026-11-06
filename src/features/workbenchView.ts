// Commands Code for IBM i users expect and Vanthrex did not have yet: rename a member, change a member or object
// description, move libraries in the list and clean it up, download members to this PC and replace a member from a
// local file, compare with an IFS or local file, shared snippets on the IFS, find IFS files by name and copy a path.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { clString } from '../core/util';
import {
  existingLibrariesSql, findByNameSql, folderFilesSql, isSystemName, localMemberPath, memberFromFileName, missingLibraries,
  moveItem, snippetFileName, snippetFolder, snippetLabel, sourceMembersSql,
} from '../core/workbench';
import { IfsNode, IfsTreeProvider } from '../views/ifsTree';
import { LibNode, LibraryTreeProvider } from '../views/libraryTree';
import { ifsUri, memberUri } from './fileSystems';

type Member = Extract<LibNode, { kind: 'member' }>;
type SrcFile = Extract<LibNode, { kind: 'srcfile' }>;
type Library = Extract<LibNode, { kind: 'library' }>;
type ObjectNode = Extract<LibNode, { kind: 'object' }>;
type Row = Record<string, unknown>;

const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);
const s = (r: Row, k: string) => String(r[k] ?? '').trim();
const nameCheck = (v: string) => isSystemName(v) ? undefined : t('Use a valid IBM i name (up to 10 characters, starting with a letter, $, # or @).');

async function cl(manager: ConnectionManager, command: string): Promise<void> {
  const r = await manager.require().runCL(command);
  if (!r.ok) { throw new Error(`${command.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
}

// ---------------------------------------------------------------- members and objects

async function renameMember(manager: ConnectionManager, libraries: LibraryTreeProvider, n: Member): Promise<void> {
  const v = await vscode.window.showInputBox({ title: t('Rename member {0}/{1}({2})', n.library, n.file, n.member), value: n.member, validateInput: nameCheck, ignoreFocusOut: true });
  if (!v || v.trim().toUpperCase() === n.member.toUpperCase()) { return; }
  const to = v.trim().toUpperCase();
  await cl(manager, `RNMM FILE(${n.library}/${n.file}) MBR(${n.member}) NEWMBR(${to})`);
  libraries.refresh();
  vscode.window.setStatusBarMessage(t('Renamed {0} to {1}.', n.member, to), 4000);
}

async function changeMemberText(manager: ConnectionManager, libraries: LibraryTreeProvider, n: Member): Promise<void> {
  const v = await vscode.window.showInputBox({ title: t('Description of {0}/{1}({2})', n.library, n.file, n.member), value: n.text, validateInput: x => x.length > 50 ? t('At most 50 characters.') : undefined, ignoreFocusOut: true });
  if (v === undefined) { return; }
  await cl(manager, `CHGPFM FILE(${n.library}/${n.file}) MBR(${n.member}) TEXT(${clString(v || ' ')})`);
  libraries.refresh();
}

async function changeObjectText(manager: ConnectionManager, libraries: LibraryTreeProvider, n: ObjectNode): Promise<void> {
  const v = await vscode.window.showInputBox({ title: t('Description of {0}/{1} {2}', n.library, n.name, n.type), value: n.text, validateInput: x => x.length > 50 ? t('At most 50 characters.') : undefined, ignoreFocusOut: true });
  if (v === undefined) { return; }
  await cl(manager, `CHGOBJD OBJ(${n.library}/${n.name}) OBJTYPE(${n.type}) TEXT(${clString(v || ' ')})`);
  libraries.refresh();
}

// ---------------------------------------------------------------- library list

async function cleanupLibraryList(manager: ConnectionManager): Promise<void> {
  const conn = manager.require(); const list = conn.profile.libraries;
  const sql = existingLibrariesSql(list);
  const existing = sql ? (await conn.rows<Row>(sql, 1000)).map(r => s(r, 'LIB')) : [];
  const gone = missingLibraries(list, existing);
  if (!gone.length) { vscode.window.showInformationMessage(t('Every library in your list exists.')); return; }
  const ok = await vscode.window.showWarningMessage(t('These libraries do not exist: {0}. Remove them from your library list?', gone.join(', ')), { modal: true }, t('Remove'));
  if (ok !== t('Remove')) { return; }
  await manager.updateActiveProfile(p => {
    p.libraries = p.libraries.filter(l => !gone.includes(l.trim().toUpperCase()));
    if (p.currentLibrary && gone.includes(p.currentLibrary.toUpperCase())) { p.currentLibrary = undefined; }
  });
}

// ---------------------------------------------------------------- members ↔ this PC

async function downloadMembers(manager: ConnectionManager, n: Member | SrcFile | Library): Promise<void> {
  const conn = manager.require();
  const target = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: t('Download here'), title: t('Folder on this PC') });
  if (!target?.[0]) { return; }
  let members: Array<{ file: string; member: string; type: string }>;
  if (n.kind === 'member') { members = [{ file: n.file, member: n.member, type: n.type }]; }
  else {
    const rows = await conn.rows<Row>(sourceMembersSql(n.library, n.kind === 'srcfile' ? n.file : undefined), 50000);
    members = rows.map(r => ({ file: s(r, 'FILE'), member: s(r, 'MBR'), type: s(r, 'TYPE') }));
  }
  if (!members.length) { vscode.window.showInformationMessage(t('No source members to download.')); return; }
  const layout = n.kind === 'member' ? 'flat' : (await vscode.window.showQuickPick([
    { label: t('Library → File → Member'), detail: `${n.library}/QRPGLESRC/PGM1.rpgle`, layout: 'structured' as const },
    { label: t('File → Member'), detail: 'QRPGLESRC/PGM1.rpgle', layout: 'file' as const },
    { label: t('All in one folder'), detail: 'PGM1.rpgle', layout: 'flat' as const },
  ], { title: t('Download {0} member(s) — folder layout', members.length) }))?.layout;
  if (!layout) { return; }
  const base = target[0].fsPath;
  const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Downloading members'), cancellable: true }, async (progress, token) => {
    let count = 0;
    for (const m of members) {
      if (token.isCancellationRequested) { break; }
      progress.report({ message: `${m.file}/${m.member}`, increment: 100 / members.length });
      const to = localMemberPath(base, layout, n.library, m.file, m.member, m.type);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.writeFile(to, await conn.readMember(n.library, m.file, m.member), 'utf8');
      count++;
    }
    return count;
  });
  const open = await vscode.window.showInformationMessage(t('Downloaded {0} member(s) to {1}.', done, base), t('Open Folder'));
  if (open) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(n.kind === 'member' ? localMemberPath(base, 'flat', n.library, n.file, n.member, n.type) : base)); }
}

async function uploadMember(manager: ConnectionManager, libraries: LibraryTreeProvider, n: Member | SrcFile): Promise<void> {
  const conn = manager.require();
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: t('Upload'), title: n.kind === 'member' ? t('Replace {0}/{1}({2}) with a file from this PC', n.library, n.file, n.member) : t('Upload a file from this PC into {0}/{1}', n.library, n.file) });
  if (!pick?.[0]) { return; }
  const text = (await fs.promises.readFile(pick[0].fsPath, 'utf8')).replace(/^﻿/, '');
  let member: string; let type: string;
  if (n.kind === 'member') { member = n.member; type = n.type; }
  else {
    const guess = memberFromFileName(pick[0].fsPath);
    const v = await vscode.window.showInputBox({ title: t('Member name'), value: guess?.member ?? '', validateInput: nameCheck, ignoreFocusOut: true });
    if (!v) { return; }
    member = v.trim().toUpperCase(); type = guess?.type || 'TXT';
    const exists = (await conn.rows<Row>(sourceMembersSql(n.library, n.file), 50000)).some(r => s(r, 'MBR') === member);
    if (!exists) { await cl(manager, `ADDPFM FILE(${n.library}/${n.file}) MBR(${member}) SRCTYPE(${type}) TEXT(${clString(path.basename(pick[0].fsPath).slice(0, 50))})`); }
    else if (await vscode.window.showWarningMessage(t('Member {0} already exists in {1}/{2}. Replace its source?', member, n.library, n.file), { modal: true }, t('Replace')) !== t('Replace')) { return; }
  }
  if (n.kind === 'member' && await vscode.window.showWarningMessage(t('Replace the source of {0}/{1}({2}) with {3}?', n.library, n.file, n.member, path.basename(pick[0].fsPath)), { modal: true }, t('Replace')) !== t('Replace')) { return; }
  await conn.writeMember(n.library, n.file, member, text);
  libraries.refresh();
  const open = await vscode.window.showInformationMessage(t('Uploaded to {0}/{1}({2}).', n.library, n.file, member), t('Open'));
  if (open) { await vscode.window.showTextDocument(memberUri(n.library, n.file, member, type)); }
}

// ---------------------------------------------------------------- compare

async function compareWith(kind: 'ifs' | 'local', manager: ConnectionManager, arg?: vscode.Uri): Promise<void> {
  const current = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (!current) { vscode.window.showInformationMessage(t('Open a file or member first.')); return; }
  let other: vscode.Uri | undefined;
  if (kind === 'local') { other = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: t('Compare'), title: t('File on this PC to compare with') }))?.[0]; }
  else {
    manager.require();
    const p = await vscode.window.showInputBox({ title: t('IFS file to compare with'), placeHolder: '/home/ME/src/pgm1.rpgle', ignoreFocusOut: true, validateInput: x => x.trim().startsWith('/') ? undefined : t('Use a full path starting with /') });
    if (p) { other = ifsUri(p.trim()); }
  }
  if (!other) { return; }
  await vscode.commands.executeCommand('vscode.diff', other, current, `${path.posix.basename(other.path)} ↔ ${path.posix.basename(current.path)}`);
}

// ---------------------------------------------------------------- shared snippets

const folderOf = (manager: ConnectionManager) => snippetFolder(vscode.workspace.getConfiguration('vanthrex').get<string>('sharedSnippets.folder'), manager.require().user);

async function saveSnippet(manager: ConnectionManager): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage(t('Open a file or member first.')); return; }
  const text = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
  if (!text.trim()) { vscode.window.showInformationMessage(t('Nothing to save: the selection is empty.')); return; }
  const name = await vscode.window.showInputBox({ title: t('Shared snippet name'), placeHolder: t('e.g. Read customer by id'), ignoreFocusOut: true, validateInput: x => x.trim() ? undefined : t('Give the snippet a name.') });
  if (!name) { return; }
  const ext = path.extname(editor.document.uri.path).slice(1) || editor.document.languageId;
  const conn = manager.require(); const folder = folderOf(manager);
  const file = `${folder}/${snippetFileName(name, ext)}`;
  await conn.mkdir(folder);
  await conn.writeStreamFile(file, Buffer.from(text, 'utf8'));
  vscode.window.showInformationMessage(t('Saved the snippet to {0}.', file));
}

async function insertSnippet(manager: ConnectionManager): Promise<void> {
  const conn = manager.require(); const folder = folderOf(manager);
  const rows = await conn.rows<Row>(folderFilesSql(folder), 2000).catch(() => [] as Row[]);
  if (!rows.length) { vscode.window.showInformationMessage(t('No shared snippets in {0} yet. Select some code and run "Save as Shared Snippet".', folder)); return; }
  const editor = vscode.window.activeTextEditor;
  const ext = editor ? path.extname(editor.document.uri.path).slice(1).toLowerCase() : '';
  const items = rows.map(r => { const p = s(r, 'PATH'); const l = snippetLabel(p); return { label: l.label, description: l.ext, detail: `${s(r, 'CHANGED')} · ${p}`, path: p, same: l.ext === ext }; })
    .sort((a, b) => Number(b.same) - Number(a.same));
  const pick = await vscode.window.showQuickPick(items, { title: t('Shared snippets — {0}', folder), matchOnDetail: true });
  if (!pick) { return; }
  const text = (await conn.readStreamFile(pick.path)).toString('utf8');
  if (editor) { await editor.edit(e => editor.selections.forEach(sel => e.replace(sel, text))); }
  else { await vscode.window.showTextDocument(ifsUri(pick.path)); }
}

// ---------------------------------------------------------------- IFS

async function findByName(manager: ConnectionManager, node?: IfsNode): Promise<void> {
  const conn = manager.require();
  const start = node?.isDirectory ? node.path : await vscode.window.showInputBox({ title: t('Find IFS files by name — where?'), value: `/home/${conn.user.toUpperCase()}`, ignoreFocusOut: true, validateInput: x => x.trim().startsWith('/') ? undefined : t('Use a full path starting with /') });
  if (!start) { return; }
  const pattern = await vscode.window.showInputBox({ title: t('Find IFS files by name in {0}', start), placeHolder: t('Name or pattern, e.g. *.rpgle or order'), ignoreFocusOut: true });
  if (!pattern?.trim()) { return; }
  const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Searching {0}…', start) }, () => conn.rows<Row>(findByNameSql(start, pattern), 500));
  if (!rows.length) { vscode.window.showInformationMessage(t('No file named like "{0}" under {1}.', pattern, start)); return; }
  const pick = await vscode.window.showQuickPick(rows.map(r => ({ label: path.posix.basename(s(r, 'PATH')), description: path.posix.dirname(s(r, 'PATH')), detail: `${s(r, 'CHANGED')} · ${Number(s(r, 'SIZE')).toLocaleString()} bytes`, path: s(r, 'PATH') })),
    { title: t('{0} file(s) found', rows.length) + (rows.length >= 500 ? ` ${t('(first 500)')}` : ''), matchOnDescription: true });
  if (pick) { await vscode.window.showTextDocument(ifsUri(pick.path)); }
}

export function registerWorkbench(context: vscode.ExtensionContext, manager: ConnectionManager, libraries: LibraryTreeProvider, _ifs: IfsTreeProvider): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => { try { await fn(...a); } catch (e) { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); } };
  const move = (delta: number) => guard(async (n: Library) => { if (n?.library) { await manager.updateActiveProfile(p => { p.libraries = moveItem(p.libraries, n.library, delta); }); } });
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.renameMember', guard((n: Member) => renameMember(manager, libraries, n))),
    vscode.commands.registerCommand('vanthrex.changeMemberText', guard((n: Member) => changeMemberText(manager, libraries, n))),
    vscode.commands.registerCommand('vanthrex.changeObjectText', guard((n: ObjectNode) => changeObjectText(manager, libraries, n))),
    vscode.commands.registerCommand('vanthrex.moveLibraryUp', move(-1)),
    vscode.commands.registerCommand('vanthrex.moveLibraryDown', move(1)),
    vscode.commands.registerCommand('vanthrex.cleanupLibraryList', guard(() => cleanupLibraryList(manager))),
    vscode.commands.registerCommand('vanthrex.downloadMembers', guard((n: Member | SrcFile | Library) => downloadMembers(manager, n))),
    vscode.commands.registerCommand('vanthrex.uploadMember', guard((n: Member | SrcFile) => uploadMember(manager, libraries, n))),
    vscode.commands.registerCommand('vanthrex.compareWithIfsFile', guard((u?: vscode.Uri) => compareWith('ifs', manager, u))),
    vscode.commands.registerCommand('vanthrex.compareWithLocalFile', guard((u?: vscode.Uri) => compareWith('local', manager, u))),
    vscode.commands.registerCommand('vanthrex.saveSharedSnippet', guard(() => saveSnippet(manager))),
    vscode.commands.registerCommand('vanthrex.insertSharedSnippet', guard(() => insertSnippet(manager))),
    vscode.commands.registerCommand('vanthrex.ifsFindByName', guard((n?: IfsNode) => findByName(manager, n))),
    vscode.commands.registerCommand('vanthrex.ifsCopyPath', guard(async (n?: IfsNode) => { if (n?.path) { await vscode.env.clipboard.writeText(n.path); vscode.window.setStatusBarMessage(t('Copied {0}', n.path), 3000); } })),
  );
}
