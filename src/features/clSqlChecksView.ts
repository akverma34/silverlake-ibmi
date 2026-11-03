// Checks while you type in CL sources and SQL scripts (the same Problems view and the same on/off switches as the RPG
// checks), with quick fixes: declare a CL variable, remove an unused DCL, add WHERE 1 = 1 on purpose, and turn a
// check off.
import * as vscode from 'vscode';
import { clDeclaration, clDeclarationLine, clLint, ClRule, CL_RULES } from '../core/clChecks';
import { logError } from '../core/log';
import { checkSqlScript, SqlRule, SQL_RULES } from '../core/sqlChecks';

const SEVERITY = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information, hint: vscode.DiagnosticSeverity.Hint };
const config = () => vscode.workspace.getConfiguration('vanthrex');

export function registerClSqlChecks(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('Vanthrex CL and SQL checks');
  const timers = new Map<string, NodeJS.Timeout>();
  const visible = (doc: vscode.TextDocument) => vscode.window.visibleTextEditors.some(e => e.document === doc);
  const run = (doc: vscode.TextDocument) => {
    try {
      if (!['cl', 'sql'].includes(doc.languageId) || !visible(doc)) { return; }
      const rules = config().get<Record<string, boolean>>('lint.rules', {});
      const on = (r: string) => rules[r] !== false;
      if (!config().get<boolean>('lint.enabled', true) || !config().get<boolean>(doc.languageId === 'cl' ? 'lint.cl' : 'lint.sql', true) || doc.getText().length > 2_000_000) { collection.delete(doc.uri); return; }
      const diags: vscode.Diagnostic[] = [];
      if (doc.languageId === 'cl') {
        for (const f of clLint(doc.getText(), on)) {
          const line = Math.min(f.line, doc.lineCount - 1);
          const d = new vscode.Diagnostic(new vscode.Range(line, f.start, line, f.end), f.message, SEVERITY[f.severity]);
          d.source = 'Vanthrex'; d.code = f.rule;
          if (f.rule === 'cl-unused-variable') { d.tags = [vscode.DiagnosticTag.Unnecessary]; }
          diags.push(d);
        }
      } else {
        for (const f of checkSqlScript(doc.getText(), on)) {
          const d = new vscode.Diagnostic(new vscode.Range(doc.positionAt(f.offset), doc.positionAt(f.offset + f.length)), f.message, SEVERITY[f.severity]);
          d.source = 'Vanthrex'; d.code = f.rule;
          diags.push(d);
        }
      }
      collection.set(doc.uri, diags);
    } catch (e) { logError(e); }
  };
  const schedule = (doc: vscode.TextDocument) => {
    if (!['cl', 'sql'].includes(doc.languageId)) { return; }
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); run(doc); }, 400));
  };

  context.subscriptions.push(
    collection,
    vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(e => { if (!collection.has(e.document.uri)) { run(e.document); } })),
    vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => { collection.delete(d.uri); clearTimeout(timers.get(d.uri.toString())); timers.delete(d.uri.toString()); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vanthrex.lint')) { vscode.window.visibleTextEditors.forEach(ed => run(ed.document)); } }),
    vscode.languages.registerCodeActionsProvider([{ language: 'cl' }, { language: 'sql' }], {
      provideCodeActions(doc, _r, ctx) {
        const out: vscode.CodeAction[] = [];
        try {
          for (const d of ctx.diagnostics.filter(x => x.source === 'Vanthrex' && (String(x.code) in CL_RULES || String(x.code) in SQL_RULES))) {
            const rule = String(d.code) as ClRule | SqlRule;
            const fix = (title: string, build: (e: vscode.WorkspaceEdit) => void, preferred = true) => {
              const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix); a.edit = new vscode.WorkspaceEdit(); build(a.edit); a.diagnostics = [d]; a.isPreferred = preferred; out.push(a);
            };
            if (rule === 'cl-undeclared-variable') {
              const name = doc.getText(d.range);
              const at = Math.min(clDeclarationLine(doc.getText()), doc.lineCount);
              fix(vscode.l10n.t('Declare {0}', name), e => e.insert(doc.uri, new vscode.Position(at, 0), clDeclaration(name) + '\n'));
            }
            if (rule === 'cl-unused-variable') {
              const line = doc.lineAt(d.range.start.line);
              if (!/[+-]\s*$/.test(line.text) && !/[+-]\s*$/.test(d.range.start.line > 0 ? doc.lineAt(d.range.start.line - 1).text : '')) {
                fix(vscode.l10n.t('Remove the unused DCL'), e => e.delete(doc.uri, line.rangeIncludingLineBreak));
              }
            }
            if (rule === 'sql-without-where') {
              // The end of the statement: the next ";" after the verb, else the end of the text.
              const text = doc.getText(); const from = doc.offsetAt(d.range.start);
              const semi = text.indexOf(';', from); const end = semi < 0 ? text.trimEnd().length : semi;
              fix(vscode.l10n.t('Add WHERE 1 = 1 (every row on purpose)'), e => e.insert(doc.uri, doc.positionAt(end), ' WHERE 1 = 1'), false);
            }
            const off = new vscode.CodeAction(vscode.l10n.t('Turn off the "{0}" check', rule), vscode.CodeActionKind.QuickFix);
            off.command = { command: 'vanthrex.disableLintRule', title: vscode.l10n.t('Turn off'), arguments: [rule] };
            off.diagnostics = [d]; out.push(off);
          }
        } catch (e) { logError(e); }
        return out;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
  );
  vscode.window.visibleTextEditors.forEach(ed => run(ed.document));
}
