// Quick fixes for the checks on how variables are used (declare an SQL host variable with a type guessed from its
// name, create a missing subroutine, compare numbers with 0, convert text with %DEC) and Toggle Value
// (*ON ↔ *OFF, AND ↔ OR, = ↔ <>, SETLL ↔ SETGT…).
import * as vscode from 'vscode';
import { logError } from '../core/log';
import { declarationLine, subroutineLine } from '../rpg/rpgModuleTools';
import { toggleWord } from '../rpg/rpgProductivity';
import { typeForName } from '../rpg/rpgSuggestions';
import { fieldType } from '../rpg/rpgDataChecks';
import { parseRpg } from '../rpg/parser';

class DataFixes implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _r: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    try {
      const out: vscode.CodeAction[] = [];
      const add = (title: string, d: vscode.Diagnostic, build: (e: vscode.WorkspaceEdit) => void, preferred = true) => {
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit(); build(a.edit); a.diagnostics = [d]; a.isPreferred = preferred; out.push(a);
      };
      for (const d of ctx.diagnostics.filter(x => x.source === 'Vanthrex')) {
        const text = doc.getText(d.range);
        switch (String(d.code)) {
          case 'undeclared-host-variable': {
            const name = text.replace(/^:/, '');
            const all = doc.getText();
            const at = declarationLine(all, d.range.start.line);
            const type = typeForName(name, all.split(/\r?\n/));
            add(vscode.l10n.t('Declare {0} as {1}', name, type), d, e => e.insert(doc.uri, new vscode.Position(Math.min(at.line, doc.lineCount), 0), `${at.indent}dcl-s ${name} ${type};\n`));
            break;
          }
          case 'undefined-subroutine': {
            const at = subroutineLine(doc.getText());
            const pos = at >= doc.lineCount ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(at, 0);
            const body = `${at >= doc.lineCount ? '\n' : ''}\nbegsr ${text};\n  // TODO\nendsr;\n${at >= doc.lineCount ? '' : '\n'}`;
            add(vscode.l10n.t('Create subroutine {0}', text), d, e => e.insert(doc.uri, pos, body));
            break;
          }
          case 'blank-compare-numeric': add(vscode.l10n.t('Compare with 0'), d, e => e.replace(doc.uri, d.range, '0')); break;
          case 'char-to-numeric': {
            const line = doc.lineAt(d.range.start.line).text;
            const m = /=\s*('(?:[^']|'')*')\s*;/.exec(line);
            const def = parseRpg(doc.getText()).definitions.find(x => x.upper === text.toUpperCase());
            const t = def ? fieldType(def.detail) : undefined;
            if (m && t) {
              const conv = /int|uns/.test(t.kind) ? `%int(${m[1]})` : t.kind === 'float' ? `%float(${m[1]})` : `%dec(${m[1]}: ${t.length ?? 15}: ${t.scale ?? 0})`;
              const s = line.indexOf(m[1], line.indexOf('='));
              add(vscode.l10n.t('Convert with {0}', conv.replace(/\(.*$/, '')), d, e => e.replace(doc.uri, new vscode.Range(d.range.start.line, s, d.range.start.line, s + m[1].length), conv));
            }
            break;
          }
          default: break;
        }
      }
      return out;
    } catch (e) { logError(e); return []; }
  }
}

async function toggleValue(): Promise<void> {
  const ed = vscode.window.activeTextEditor; if (!ed) { return; }
  const edits: { range: vscode.Range; text: string }[] = [];
  for (const sel of ed.selections) {
    const r = sel.isEmpty ? ed.document.getWordRangeAtPosition(sel.active, /\*?[A-Za-z][\w-]*|<>|<=|>=|=|<|>/) : sel;
    if (!r) { continue; }
    const to = toggleWord(ed.document.getText(r));
    if (to !== undefined) { edits.push({ range: r, text: to }); }
  }
  if (!edits.length) { vscode.window.setStatusBarMessage(vscode.l10n.t('Nothing to toggle here (*ON / *OFF, AND / OR, = / <>, SETLL / SETGT…).'), 3000); return; }
  await ed.edit(b => edits.forEach(x => b.replace(x.range, x.text)));
}

export function registerRpgDataFixes(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ language: 'rpgle' }, new DataFixes(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('vanthrex.rpg.toggleValue', async () => { try { await toggleValue(); } catch (e) { logError(e); } }),
  );
}
