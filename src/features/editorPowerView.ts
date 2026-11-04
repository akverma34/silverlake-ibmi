// More power in the editor: Format Document for CL (prompter layout), RPG semantic highlighting, DCL-PROC / END-PROC
// names edited together, END lines indented to their opener as you type, links that open a member at a line
// (vscode://… from tickets and chats), and clickable members, message IDs and IFS paths in every terminal.
import * as vscode from 'vscode';
import { formatCl, indentForCloser, linkedNames, memberLink, parseLink, terminalRefs, TerminalRef } from '../core/editorExtras';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { parseMemberPath, sqlString } from '../core/util';
import { semanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from '../rpg/rpgSemantics';
import { ifsUri, memberUri } from './fileSystems';

const cfg = () => vscode.workspace.getConfiguration('vanthrex.editor');
const legend = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

/** The source type of a member, to open it with the right language (falls back to MBR). */
async function memberType(manager: ConnectionManager, lib: string, file: string, member: string): Promise<string> {
  try {
    const rows = await manager.require().rows<{ T: string }>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(member)}`, 1);
    return String(rows[0]?.T ?? '').trim().toLowerCase() || 'mbr';
  } catch { return 'mbr'; }
}

async function openAt(uri: vscode.Uri, line?: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  if (line && line > 0) { const p = new vscode.Position(Math.min(line - 1, doc.lineCount - 1), 0); ed.selection = new vscode.Selection(p, p); ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter); }
}

async function handleUri(manager: ConnectionManager, uri: vscode.Uri): Promise<void> {
  if (uri.path !== '/open') { return; }
  const target = parseLink(uri.query);
  // The link may name a system: use that connection (connect first when it is not open).
  if (target.system && manager.connection?.profile.name.toUpperCase() !== target.system.toUpperCase()) {
    const p = manager.profiles.list().find(x => x.name.toUpperCase() === target.system!.toUpperCase());
    if (!p) { throw new Error(vscode.l10n.t('The link is for the system {0}, which is not one of your connections.', target.system)); }
    const yes = vscode.l10n.t('Connect');
    if ((await vscode.window.showInformationMessage(vscode.l10n.t('Open this link on {0}?', p.name), { modal: true, detail: target.path ?? `${target.library}/${target.file}(${target.member})` }, yes)) !== yes) { return; }
    await manager.connect(p);
  }
  if (!manager.connection) { await vscode.commands.executeCommand('vanthrex.connect'); }
  manager.require();
  if (target.path) { await openAt(ifsUri(target.path), target.line); return; }
  const type = target.type ?? await memberType(manager, target.library!, target.file!, target.member!);
  await openAt(memberUri(target.library!, target.file!, target.member!, type), target.line);
}

async function copyLink(manager: ConnectionManager): Promise<void> {
  const ed = vscode.window.activeTextEditor; if (!ed) { return; }
  const uri = ed.document.uri; const line = ed.selection.active.line + 1;
  let link: string;
  if (/^vanthrex-member/.test(uri.scheme)) { const p = parseMemberPath(uri.path); link = memberLink({ system: manager.connection?.profile.name, library: p.library, file: p.file, member: p.member, type: p.extension, line }); }
  else if (/^vanthrex-ifs/.test(uri.scheme)) { link = memberLink({ system: manager.connection?.profile.name, path: uri.path, line }); }
  else { throw new Error(vscode.l10n.t('Links can be made for members and IFS files of the IBM i.')); }
  await vscode.env.clipboard.writeText(link);
  vscode.window.setStatusBarMessage(vscode.l10n.t('Link copied: anyone with Vanthrex opens this line by clicking it.'), 5000);
}

interface IbmiTerminalLink extends vscode.TerminalLink { ref: TerminalRef }

export function registerEditorPower(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const semCache = new Map<string, { v: number; t: vscode.SemanticTokens }>();
  const run = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'cl' }, {
      provideDocumentFormattingEdits(doc) {
        try {
          const text = doc.getText(); const next = formatCl(text, 80);
          return next === text ? [] : [vscode.TextEdit.replace(new vscode.Range(0, 0, doc.lineCount, 0), next.endsWith('\n') || !text.endsWith('\n') ? next : next + '\n')];
        } catch (e) { logError(e); return []; }
      },
    }),
    vscode.languages.registerDocumentSemanticTokensProvider({ language: 'rpgle' }, {
      provideDocumentSemanticTokens(doc) {
        if (!cfg().get<boolean>('semanticHighlighting', true)) { return new vscode.SemanticTokensBuilder(legend).build(); }
        const k = doc.uri.toString(); const c = semCache.get(k);
        if (c && c.v === doc.version) { return c.t; }
        const b = new vscode.SemanticTokensBuilder(legend);
        try { for (const t of semanticTokens(doc.getText())) { b.push(t.line, t.start, t.length, t.type, t.modifiers); } } catch (e) { logError(e); }
        const t = b.build(); semCache.set(k, { v: doc.version, t });
        return t;
      },
    }, legend),
    vscode.workspace.onDidCloseTextDocument(d => semCache.delete(d.uri.toString())),
    vscode.languages.registerLinkedEditingRangeProvider({ language: 'rpgle' }, {
      provideLinkedEditingRanges(doc, pos) {
        try {
          const lines: string[] = []; for (let i = 0; i < doc.lineCount; i++) { lines.push(doc.lineAt(i).text); }
          const r = linkedNames(lines, pos.line, pos.character);
          return r ? new vscode.LinkedEditingRanges(r.map(x => new vscode.Range(x.line, x.start, x.line, x.end)), /[A-Za-z_$#@][\w$#@]*/) : undefined;
        } catch (e) { logError(e); return undefined; }
      },
    }),
    vscode.languages.registerOnTypeFormattingEditProvider({ language: 'rpgle' }, {
      provideOnTypeFormattingEdits(doc, pos) {
        try {
          if (!cfg().get<boolean>('indentOnType', true)) { return []; }
          const from = Math.max(0, pos.line - 400);
          const lines: string[] = []; for (let i = from; i <= pos.line; i++) { lines.push(doc.lineAt(i).text); }
          const want = indentForCloser(lines, lines.length - 1, cfg().get<number>('rpgIndent', 2));
          const cur = doc.lineAt(pos.line); const has = cur.text.slice(0, cur.firstNonWhitespaceCharacterIndex);
          return want === undefined || want === has ? [] : [vscode.TextEdit.replace(new vscode.Range(pos.line, 0, pos.line, has.length), want)];
        } catch (e) { logError(e); return []; }
      },
    }, ';'),
    vscode.window.registerUriHandler({ handleUri: uri => run(() => handleUri(manager, uri))() }),
    vscode.commands.registerCommand('vanthrex.copyLink', run(() => copyLink(manager))),
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks(ctx): IbmiTerminalLink[] {
        if (!cfg().get<boolean>('terminalLinks', true)) { return []; }
        try {
          return terminalRefs(ctx.line).map(ref => ({ startIndex: ref.start, length: ref.length, ref,
            tooltip: ref.kind === 'message' ? vscode.l10n.t('Explain {0}', ref.text) : ref.kind === 'member' ? vscode.l10n.t('Open {0}', ref.text) : vscode.l10n.t('Open {0} from the IFS', ref.text) }));
        } catch { return []; }
      },
      async handleTerminalLink(link: IbmiTerminalLink) {
        try {
          const r = link.ref;
          if (r.kind === 'message') { await vscode.commands.executeCommand('vanthrex.explainMessage', r.text); return; }
          manager.require();
          if (r.kind === 'ifs') { await openAt(ifsUri(r.text)); return; }
          if (r.kind === 'member') { await openAt(memberUri(r.library!, r.file!, r.member!, await memberType(manager, r.library!, r.file!, r.member!))); }
        } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
      },
    }),
  );
}
