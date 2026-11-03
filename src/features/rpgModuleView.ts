// Module and service-program commands: binder source and a prototype copybook from the exported procedures, a
// documentation header for every procedure, Join Lines, Remove Unused Declarations, and the quick fix that puts a
// DCL-PR back in line with its procedure interface.
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { lintRpg } from '../rpg/lint';
import { binderSource, documentationHeaders, joinStatement, prototypeCopybook, removableDeclarations, syncPrototype } from '../rpg/rpgModuleTools';
import { interfaces } from '../rpg/rpgSafetyChecks';

function rpgEditor(): vscode.TextEditor | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'rpgle') { vscode.window.showInformationMessage(vscode.l10n.t('Open an RPG source first.')); return undefined; }
  return ed;
}

/** The member (or file) name of a document, without library, source file or extension. */
export function memberName(uri: vscode.Uri): string {
  return path.posix.basename(uri.path).replace(/\.[^.]*$/, '').toUpperCase() || 'MODULE';
}

async function showNew(content: string, language: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

async function binderSourceCommand(): Promise<void> {
  const ed = rpgEditor(); if (!ed) { return; }
  const member = memberName(ed.document.uri);
  // An open binder source can be updated in place: its export order is kept, new exports go at the end.
  const open = vscode.workspace.textDocuments.filter(d => d !== ed.document && /\bSTRPGMEXP\b/i.test(d.getText()));
  let target: vscode.TextDocument | undefined;
  if (open.length) {
    const pick = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('$(new-file) New binder source'), doc: undefined as vscode.TextDocument | undefined },
      ...open.map(d => ({ label: `$(sync) ${vscode.l10n.t('Update {0}', memberName(d.uri))}`, description: d.uri.path, doc: d as vscode.TextDocument | undefined })),
    ], { title: vscode.l10n.t('Binder source of {0}', member) });
    if (!pick) { return; }
    target = pick.doc;
  }
  const text = binderSource(ed.document.getText(), member, target?.getText());
  if (!target) { await showNew(text, 'cl'); return; }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(target.uri, new vscode.Range(0, 0, target.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
  await vscode.window.showTextDocument(target, { preview: false });
  vscode.window.setStatusBarMessage(vscode.l10n.t('Binder source updated: check it, then save.'), 4000);
}

async function copybookCommand(): Promise<void> {
  const ed = rpgEditor(); if (!ed) { return; }
  await showNew(prototypeCopybook(ed.document.getText(), memberName(ed.document.uri)), 'rpgle');
}

async function documentAllCommand(): Promise<void> {
  const ed = rpgEditor(); if (!ed) { return; }
  const doc = ed.document;
  const headers = documentationHeaders(doc.getText(), l => doc.lineAt(l).text.slice(0, doc.lineAt(l).firstNonWhitespaceCharacterIndex));
  if (!headers.length) { vscode.window.showInformationMessage(vscode.l10n.t('Every procedure already has a comment above it.')); return; }
  await ed.edit(b => headers.forEach(h => b.insert(new vscode.Position(h.line, 0), h.text)));
  vscode.window.setStatusBarMessage(vscode.l10n.t('Header added to {0} procedure(s): replace the TODO lines.', headers.length), 5000);
}

async function joinLinesCommand(): Promise<void> {
  const ed = rpgEditor(); if (!ed) { return; }
  const s = ed.selection;
  const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
  let last = end;
  // With no selection, join the statement that starts on the cursor line, up to its ";".
  if (last === s.start.line) { while (last < Math.min(ed.document.lineCount - 1, s.start.line + 30) && !ed.document.lineAt(last).text.replace(/'[^']*'/g, '').includes(';')) { last++; } }
  const range = new vscode.Range(s.start.line, 0, last, ed.document.lineAt(last).text.length);
  const lines = ed.document.getText(range).split(/\r?\n/);
  await ed.edit(b => b.replace(range, joinStatement(lines)));
}

async function removeUnusedCommand(): Promise<void> {
  const ed = rpgEditor(); if (!ed) { return; }
  const doc = ed.document;
  const text = doc.getText();
  const findings = lintRpg(text).filter(f => f.rule === 'unused-definition');
  const lines = removableDeclarations(text, findings.map(f => ({ line: f.line, name: doc.lineAt(f.line).text.slice(f.start, f.end) })));
  if (!lines.length) { vscode.window.showInformationMessage(vscode.l10n.t('No unused one-line DCL-S or DCL-C to remove.')); return; }
  const names = lines.map(l => /dcl-[sc]\s+([\w$#@]+)/i.exec(doc.lineAt(l).text)?.[1] ?? '').filter(Boolean);
  const yes = vscode.l10n.t('Remove');
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Remove {0} unused declaration(s)?', lines.length), { modal: true, detail: names.slice(0, 30).join(', ') + (names.length > 30 ? ', …' : '') }, yes);
  if (ok !== yes) { return; }
  await ed.edit(b => [...lines].reverse().forEach(l => b.delete(doc.lineAt(l).rangeIncludingLineBreak)));
  vscode.window.setStatusBarMessage(vscode.l10n.t('{0} declaration(s) removed (Ctrl+Z to undo).', lines.length), 5000);
}

class PrototypeFix implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _r: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    try {
      const diags = ctx.diagnostics.filter(d => d.source === 'Vanthrex' && String(d.code) === 'prototype-mismatch');
      if (!diags.length) { return []; }
      const text = doc.getText();
      const out: vscode.CodeAction[] = [];
      for (const d of diags) {
        const pr = interfaces(text).find(x => x.kind === 'PR' && d.range.start.line >= x.line && d.range.start.line <= x.end + 1);
        const fix = pr && syncPrototype(text, pr.name);
        if (!fix) { continue; }
        const a = new vscode.CodeAction(vscode.l10n.t('Update the prototype of {0} from its procedure interface', pr.name), vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, new vscode.Range(fix.start, 0, fix.end, doc.lineAt(fix.end).text.length), fix.lines.join('\n'));
        a.diagnostics = [d]; a.isPreferred = true;
        out.push(a);
      }
      return out;
    } catch (e) { logError(e); return []; }
  }
}

export function registerRpgModuleTools(context: vscode.ExtensionContext): void {
  const wrap = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.rpg.binderSource', wrap(binderSourceCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.prototypeCopybook', wrap(copybookCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.documentAll', wrap(documentAllCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.joinLines', wrap(joinLinesCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.removeUnusedDeclarations', wrap(removeUnusedCommand)),
    vscode.languages.registerCodeActionsProvider({ language: 'rpgle' }, new PrototypeFix(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );
}
