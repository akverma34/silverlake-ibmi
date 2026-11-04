// The Developer Toolbox: one menu (Ctrl+Alt+A, or the "IBM i Tools" button in the status bar) that shows only the
// tools that fit where you are — the language of the file, a selection or not — so nobody has to remember command
// names. Also the commands behind it (rewrites, generators, copies, bulk fixes) and two hovers: the length of a
// literal and the storage size of a declaration.
import * as path from 'path';
import * as vscode from 'vscode';
import { blockGroups } from '../core/flow';
import { clDeclaration, clDeclarationLine, clLint } from '../core/clChecks';
import {
  alignAssignments, alignComments, literalAt, cleanSource, clErrorHandler, clUppercase, compileCommand, countFirst, csvToValues, embeddedToSql, limitSelect, markdownBlock,
  removeBlankLines, sqlKeywordCase, sqlToEmbedded, toLiteral, toQcmdexc, toSqlInList, wrapClCommand,
} from '../core/developerText';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { parseMemberPath, splitSqlStatements } from '../core/util';
import { dataLint } from '../rpg/rpgDataChecks';
import { declarationLine } from '../rpg/rpgModuleTools';
import { isFullyFreeSource, parseRpg } from '../rpg/parser';
import { callSnippet, dailyLint, embeddedSqlAt, prototypeFrom } from '../rpg/rpgProductivity';
import { typeForName } from '../rpg/rpgSuggestions';
import {
  compoundAssignments, createTableFromDs, declarationBytes, dsFromCreateTable, dsSql, groupInDs, keepAsComment, linesToConstants, negateCondition, programHeader,
  removeEvalCallp, separator, simplifyIndicators, subroutineToProcedure, timeLiterals, WRAP_BIFS, wrapWithBif,
} from '../rpg/rpgTransforms';

type Lang = 'rpgle' | 'cl' | 'sql' | 'dds' | 'any';
interface Tool { id: string; label: string; detail: string; group: string; langs: Lang[]; selection?: boolean; run: (ed: vscode.TextEditor) => Promise<void> }

const cfg = () => vscode.workspace.getConfiguration('vanthrex');
const userName = (manager: ConnectionManager) => cfg().get<string>('editor.changeLogUser', '') || manager.connection?.user || require('os').userInfo().username;

// ---------------------------------------------------------------- helpers

function selectedLines(ed: vscode.TextEditor): vscode.Range {
  const s = ed.selection;
  const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
  return new vscode.Range(s.start.line, 0, end, ed.document.lineAt(end).text.length);
}
async function replaceRange(ed: vscode.TextEditor, r: vscode.Range, text: string): Promise<void> {
  if (ed.document.getText(r) === text) { vscode.window.setStatusBarMessage(vscode.l10n.t('Nothing to change.'), 2500); return; }
  await ed.edit(b => b.replace(r, text));
}
async function newDocument(content: string, language: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}
async function copied(text: string, what: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  vscode.window.setStatusBarMessage(vscode.l10n.t('{0} copied to the clipboard.', what), 4000);
}
const fullyFree = (doc: vscode.TextDocument) => isFullyFreeSource(doc.getText());
function selectionOrWord(ed: vscode.TextEditor): { range: vscode.Range; text: string } {
  if (!ed.selection.isEmpty) { return { range: ed.selection, text: ed.document.getText(ed.selection) }; }
  const r = ed.document.getWordRangeAtPosition(ed.selection.active, /[%*]?[\w$#@.]+(\([^()]*\))?/);
  if (!r) { throw new Error(vscode.l10n.t('Select the text first.')); }
  return { range: r, text: ed.document.getText(r) };
}
/** The SQL statement around the cursor of an SQL script. */
function sqlStatementAt(ed: vscode.TextEditor): { range: vscode.Range; sql: string } {
  const doc = ed.document;
  if (!ed.selection.isEmpty) { return { range: ed.selection, sql: doc.getText(ed.selection) }; }
  const off = doc.offsetAt(ed.selection.active);
  const st = splitSqlStatements(doc.getText()).find(s => off >= s.start && off <= s.end + 1);
  if (!st) { throw new Error(vscode.l10n.t('Put the cursor in an SQL statement.')); }
  return { range: new vscode.Range(doc.positionAt(st.start), doc.positionAt(st.start + st.sql.length)), sql: st.sql };
}
/** Member parts of a document (member scheme), else a local file name. */
function memberOf(doc: vscode.TextDocument): { lib: string; file: string; member: string; type: string } | undefined {
  if (/^vanthrex-member/.test(doc.uri.scheme)) { const p = parseMemberPath(doc.uri.path); return { lib: p.library, file: p.file, member: p.member, type: p.extension }; }
  return undefined;
}
function blockAt(doc: vscode.TextDocument, line: number): vscode.Range | undefined {
  const lang = doc.languageId === 'cl' ? 'cl' : 'rpgle';
  const g = blockGroups(doc.getText(), lang).map(x => ({ s: x.lines[0], e: x.lines[x.lines.length - 1] })).filter(x => line >= x.s && line <= x.e && x.e > x.s).sort((a, b) => (a.e - a.s) - (b.e - b.s))[0];
  return g ? new vscode.Range(g.s, 0, g.e, doc.lineAt(g.e).text.length) : undefined;
}

// ---------------------------------------------------------------- the tools

function tools(manager: ConnectionManager): Tool[] {
  const lines = (ed: vscode.TextEditor) => { const r = selectedLines(ed); return { r, l: ed.document.getText(r).split(/\r?\n/) }; };
  const bulk = async (ed: vscode.TextEditor, n: number, what: string, apply: () => Thenable<boolean>) => {
    if (!n) { vscode.window.showInformationMessage(vscode.l10n.t('Nothing to do: no {0} in this source.', what)); return; }
    await apply(); vscode.window.setStatusBarMessage(vscode.l10n.t('{0} change(s) made (Ctrl+Z undoes them all).', n), 5000);
  };
  return [
    // ---- RPG: rewrite
    { id: 'compoundAssign', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], label: vscode.l10n.t('Use compound assignments (x += 1)'), detail: vscode.l10n.t('x = x + 1 → x += 1 in the selection or the whole source'),
      run: async ed => { const r = ed.selection.isEmpty ? new vscode.Range(0, 0, ed.document.lineCount, 0) : selectedLines(ed); const res = compoundAssignments(ed.document.getText(r).split('\n')); await bulk(ed, res.changed, 'x = x + …', () => ed.edit(b => b.replace(r, res.lines.join('\n')))); } },
    { id: 'removeEval', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], label: vscode.l10n.t('Remove EVAL and CALLP'), detail: vscode.l10n.t('Free form does not need them'),
      run: async ed => { const r = ed.selection.isEmpty ? new vscode.Range(0, 0, ed.document.lineCount, 0) : selectedLines(ed); const res = removeEvalCallp(ed.document.getText(r).split('\n')); await bulk(ed, res.changed, 'EVAL / CALLP', () => ed.edit(b => b.replace(r, res.lines.join('\n')))); } },
    { id: 'negateCondition', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], label: vscode.l10n.t('Negate the condition'), detail: vscode.l10n.t('IF / DOW / WHEN: = ↔ <>, NOT added or removed'),
      run: async ed => { const l = ed.document.lineAt(ed.selection.active.line); await replaceRange(ed, l.range, negateCondition(l.text)); } },
    { id: 'simplifyIndicators', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], label: vscode.l10n.t('Simplify "= *ON" / "= *OFF"'), detail: vscode.l10n.t('if found = *on → if found'),
      run: async ed => { const { r, l } = lines(ed); await replaceRange(ed, r, l.map(simplifyIndicators).join('\n')); } },
    { id: 'wrapWithBif', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], label: vscode.l10n.t('Wrap with a built-in function…'), detail: '%TRIM, %CHAR, %DEC, %UPPER, %SCANRPL…',
      run: async ed => { const { range, text } = selectionOrWord(ed); const b = await vscode.window.showQuickPick(WRAP_BIFS, { title: vscode.l10n.t('Wrap {0} with', text) }); if (b) { await replaceRange(ed, range, wrapWithBif(text, b)); } } },
    { id: 'groupInDs', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], selection: true, label: vscode.l10n.t('Group the variables in a data structure'), detail: vscode.l10n.t('Selected DCL-S lines → DCL-DS … QUALIFIED'),
      run: async ed => { const { r, l } = lines(ed); const n = await vscode.window.showInputBox({ title: vscode.l10n.t('Name of the data structure'), value: 'vars', validateInput: v => (/^[A-Za-z_$#@][\w$#@]*$/.test(v) ? undefined : vscode.l10n.t('Not a valid name')) }); if (n) { await replaceRange(ed, r, groupInDs(l, n).join('\n')); } } },
    { id: 'subrToProc', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], label: vscode.l10n.t('Convert a subroutine to a procedure'), detail: vscode.l10n.t('BEGSR → DCL-PROC, EXSR x → x(), LEAVESR → RETURN'),
      run: async ed => {
        const subs = parseRpg(ed.document.getText()).definitions.filter(d => d.kind === 'subroutine').map(d => d.name);
        const at = /^\s*(?:begsr|exsr)\s+([\w$#@]+)/i.exec(ed.document.lineAt(ed.selection.active.line).text)?.[1];
        const name = at ?? await vscode.window.showQuickPick(subs, { title: vscode.l10n.t('Subroutine to convert') });
        if (!name) { return; }
        const res = subroutineToProcedure(ed.document.getText(), name);
        await replaceRange(ed, new vscode.Range(0, 0, ed.document.lineCount, 0), res.text);
        vscode.window.showInformationMessage(vscode.l10n.t('{0} is now a procedure ({1} call(s) changed). Procedures need CTL-OPT DFTACTGRP(*NO).', name, res.calls));
      } },
    { id: 'linesToConstants', group: vscode.l10n.t('Rewrite'), langs: ['rpgle'], selection: true, label: vscode.l10n.t('Lines to named constants'), detail: vscode.l10n.t('NAME value → DCL-C NAME value;'),
      run: async ed => { const { r, l } = lines(ed); await replaceRange(ed, r, linesToConstants(l).join('\n')); } },
    // ---- RPG: generate
    { id: 'dsSql', group: vscode.l10n.t('Generate'), langs: ['rpgle'], label: vscode.l10n.t('SQL INSERT / SELECT / UPDATE from this data structure'), detail: vscode.l10n.t('Host variables from the subfields, same column names'),
      run: async ed => {
        const doc = ed.document; const line = ed.selection.active.line;
        let s = line; while (s > 0 && !/^\s*dcl-ds\b/i.test(doc.lineAt(s).text)) { s--; }
        const table = await vscode.window.showInputBox({ title: vscode.l10n.t('Table name'), value: (/dcl-ds\s+([\w$#@]+)/i.exec(doc.lineAt(s).text)?.[1] ?? 'TABLE').replace(/_t$/i, '').toUpperCase() });
        if (!table) { return; }
        const q = dsSql(doc.getText(new vscode.Range(s, 0, doc.lineCount, 0)), table);
        await newDocument(`**free\n// ${vscode.l10n.t('Generated from the data structure: check the WHERE clauses.')}\n${q.insert}\n\n${q.select}\n\n${q.update}\n`, 'rpgle');
      } },
    { id: 'dsFromTable', group: vscode.l10n.t('Generate'), langs: ['any'], selection: true, label: vscode.l10n.t('Data structure from CREATE TABLE'), detail: vscode.l10n.t('Selected CREATE TABLE → DCL-DS … QUALIFIED TEMPLATE'),
      run: async ed => { await newDocument(`**free\n${dsFromCreateTable(ed.document.getText(ed.selection))}\n`, 'rpgle'); } },
    { id: 'tableFromDs', group: vscode.l10n.t('Generate'), langs: ['rpgle'], label: vscode.l10n.t('CREATE TABLE from this data structure'), detail: vscode.l10n.t('Subfields → columns with SQL types'),
      run: async ed => { const doc = ed.document; let s = ed.selection.active.line; while (s > 0 && !/^\s*dcl-ds\b/i.test(doc.lineAt(s).text)) { s--; } await newDocument(createTableFromDs(doc.getText(new vscode.Range(s, 0, doc.lineCount, 0))) + '\n', 'sql'); } },
    { id: 'programHeader', group: vscode.l10n.t('Generate'), langs: ['rpgle'], label: vscode.l10n.t('Insert a program header'), detail: vscode.l10n.t('Name, purpose, author, date and change history'),
      run: async ed => { const doc = ed.document; const at = /^\s*\*\*free/i.test(doc.lineAt(0).text) ? 1 : 0; const name = memberOf(doc)?.member ?? path.basename(doc.uri.path).replace(/\.[^.]*$/, '').toUpperCase(); await ed.edit(b => b.insert(new vscode.Position(at, 0), programHeader(name, userName(manager), new Date(), fullyFree(doc)))); } },
    { id: 'separator', group: vscode.l10n.t('Generate'), langs: ['rpgle'], label: vscode.l10n.t('Insert a section separator'), detail: '// ---- Name -------------',
      run: async ed => { const title = await vscode.window.showInputBox({ title: vscode.l10n.t('Section title (optional)') }); if (title === undefined) { return; } await ed.edit(b => b.insert(new vscode.Position(ed.selection.active.line, 0), separator(title, fullyFree(ed.document)))); } },
    { id: 'dateLiteral', group: vscode.l10n.t('Generate'), langs: ['rpgle', 'sql', 'cl'], label: vscode.l10n.t('Insert a date / time literal'), detail: "d'…', t'…', z'…' for now",
      run: async ed => { const p = await vscode.window.showQuickPick(timeLiterals(new Date()), { title: vscode.l10n.t('Insert') }); if (p) { await ed.edit(b => b.replace(ed.selection, p.text)); } } },
    { id: 'keepAsComment', group: vscode.l10n.t('Edit'), langs: ['rpgle', 'cl'], label: vscode.l10n.t('Keep the line as a comment before changing it'), detail: vscode.l10n.t('The old version stays above, with your name and the date'),
      run: async ed => { const l = ed.document.lineAt(ed.selection.active.line); await ed.edit(b => b.replace(l.range, keepAsComment(l.text, userName(manager), new Date(), fullyFree(ed.document), ed.document.languageId === 'cl' ? 'cl' : 'rpgle'))); } },
    { id: 'copyPrototype', group: vscode.l10n.t('Copy'), langs: ['rpgle'], label: vscode.l10n.t('Copy the prototype of this procedure'), detail: vscode.l10n.t('DCL-PR from its DCL-PI, to paste in a copybook'),
      run: async ed => { const p = parseRpg(ed.document.getText()).procedures.find(x => ed.selection.active.line >= x.start && ed.selection.active.line <= x.end); if (!p) { throw new Error(vscode.l10n.t('Put the cursor in a procedure.')); } await copied(prototypeFrom(ed.document.getText(), p.name) ?? '', 'DCL-PR'); } },
    { id: 'copyCall', group: vscode.l10n.t('Copy'), langs: ['rpgle'], label: vscode.l10n.t('Copy a call of this procedure'), detail: 'name(param1: param2)',
      run: async ed => { const p = parseRpg(ed.document.getText()).procedures.find(x => ed.selection.active.line >= x.start && ed.selection.active.line <= x.end); if (!p) { throw new Error(vscode.l10n.t('Put the cursor in a procedure.')); } const parms = parseRpg(ed.document.getText()).definitions.filter(d => d.kind === 'parameter' && d.procedure === p.name); await copied(callSnippet(p.name, parms).replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\\(.)/g, '$1') + ';', vscode.l10n.t('The call')); } },
    { id: 'embeddedToSql', group: vscode.l10n.t('SQL'), langs: ['rpgle'], label: vscode.l10n.t('Open this embedded SQL as a script'), detail: vscode.l10n.t('EXEC SQL → a statement you can run (host variables → ?)'),
      run: async ed => { const at = embeddedSqlAt(ed.document.getText(), ed.selection.active.line); if (!at) { throw new Error(vscode.l10n.t('Put the cursor in an EXEC SQL statement.')); } await newDocument(embeddedToSql(ed.document.getText(new vscode.Range(at.start, 0, at.end, ed.document.lineAt(at.end).text.length))) + '\n', 'sql'); } },
    // ---- RPG: bulk fixes
    { id: 'declareHostVars', group: vscode.l10n.t('Fix all'), langs: ['rpgle'], label: vscode.l10n.t('Declare all undeclared SQL host variables'), detail: vscode.l10n.t('DCL-S with a type guessed from each name'),
      run: async ed => {
        const doc = ed.document; const text = doc.getText();
        const found = dataLint(text, { enabled: r => r === 'undeclared-host-variable' });
        const seen = new Set<string>(); const adds: { line: number; text: string }[] = [];
        for (const f of found) {
          const name = doc.lineAt(f.line).text.slice(f.start, f.end).replace(/^:/, '');
          const at = declarationLine(text, f.line); const key = `${at.line}|${name.toUpperCase()}`;
          if (seen.has(key)) { continue; } seen.add(key);
          adds.push({ line: Math.min(at.line, doc.lineCount), text: `${at.indent}dcl-s ${name} ${typeForName(name, text.split(/\r?\n/))};\n` });
        }
        await bulk(ed, adds.length, vscode.l10n.t('undeclared host variable'), () => ed.edit(b => adds.forEach(a => b.insert(new vscode.Position(a.line, 0), a.text))));
      } },
    { id: 'constEverywhere', group: vscode.l10n.t('Fix all'), langs: ['rpgle'], label: vscode.l10n.t('Add CONST to every read-only parameter'), detail: vscode.l10n.t('Callers can then pass expressions and literals'),
      run: async ed => {
        const doc = ed.document; const found = dailyLint(doc.getText(), { enabled: r => r === 'missing-const' });
        const edits = found.map(f => { const l = doc.lineAt(f.line).text; const code = l.replace(/\s*;\s*(\/\/.*)?$/, ''); return new vscode.Position(f.line, code.length); }).filter((p, i, a) => a.findIndex(x => x.line === p.line) === i);
        await bulk(ed, edits.length, vscode.l10n.t('read-only parameter without CONST'), () => ed.edit(b => edits.forEach(p => b.insert(p, ' const'))));
      } },
    { id: 'removeDsply', group: vscode.l10n.t('Fix all'), langs: ['rpgle'], label: vscode.l10n.t('Remove all DSPLY'), detail: vscode.l10n.t('One-line DSPLY statements left from debugging'),
      run: async ed => {
        const doc = ed.document; const ls: number[] = [];
        for (let i = 0; i < doc.lineCount; i++) { if (/^\s*dsply\b[^;]*;\s*(\/\/.*)?$/i.test(doc.lineAt(i).text)) { ls.push(i); } }
        if (ls.length && (await vscode.window.showWarningMessage(vscode.l10n.t('Remove {0} DSPLY line(s)?', ls.length), { modal: true }, vscode.l10n.t('Remove'))) !== vscode.l10n.t('Remove')) { return; }
        await bulk(ed, ls.length, 'DSPLY', () => ed.edit(b => ls.reverse().forEach(i => b.delete(doc.lineAt(i).rangeIncludingLineBreak))));
      } },
    // ---- navigation
    { id: 'selectBlock', group: vscode.l10n.t('Select'), langs: ['rpgle', 'cl'], label: vscode.l10n.t('Select the current block'), detail: 'IF … ENDIF, DOW … ENDDO, SELECT … ENDSL, DO … ENDDO',
      run: async ed => { const r = blockAt(ed.document, ed.selection.active.line); if (!r) { throw new Error(vscode.l10n.t('The cursor is not in a block.')); } ed.selection = new vscode.Selection(r.start, r.end); ed.revealRange(r); } },
    { id: 'selectProcedure', group: vscode.l10n.t('Select'), langs: ['rpgle'], label: vscode.l10n.t('Select the current procedure'), detail: 'DCL-PROC … END-PROC',
      run: async ed => { const p = parseRpg(ed.document.getText()).procedures.find(x => ed.selection.active.line >= x.start && ed.selection.active.line <= x.end); if (!p) { throw new Error(vscode.l10n.t('Put the cursor in a procedure.')); } ed.selection = new vscode.Selection(p.start, 0, p.end, ed.document.lineAt(p.end).text.length); ed.revealRange(ed.selection); } },
    // ---- CL
    { id: 'declareClVars', group: vscode.l10n.t('Fix all'), langs: ['cl'], label: vscode.l10n.t('Declare all undeclared CL variables'), detail: vscode.l10n.t('DCL with a type guessed from each name'),
      run: async ed => { const text = ed.document.getText(); const names = [...new Set(clLint(text, r => r === 'cl-undeclared-variable').map(f => ed.document.lineAt(f.line).text.slice(f.start, f.end).toUpperCase()))]; const at = Math.min(clDeclarationLine(text), ed.document.lineCount); await bulk(ed, names.length, vscode.l10n.t('undeclared variable'), () => ed.edit(b => b.insert(new vscode.Position(at, 0), names.map(clDeclaration).join('\n') + '\n'))); } },
    { id: 'clErrorHandler', group: vscode.l10n.t('Generate'), langs: ['cl'], label: vscode.l10n.t('Add a global error handler'), detail: vscode.l10n.t('MONMSG CPF0000 → ERROR: that sends the message back to the caller'),
      run: async ed => { await replaceRange(ed, new vscode.Range(0, 0, ed.document.lineCount, 0), clErrorHandler(ed.document.getText())); } },
    { id: 'clUppercase', group: vscode.l10n.t('Rewrite'), langs: ['cl'], label: vscode.l10n.t('CL in upper case'), detail: vscode.l10n.t('Strings and comments untouched'),
      run: async ed => { const r = ed.selection.isEmpty ? new vscode.Range(0, 0, ed.document.lineCount, 0) : selectedLines(ed); await replaceRange(ed, r, clUppercase(ed.document.getText(r))); } },
    { id: 'clWrap', group: vscode.l10n.t('Rewrite'), langs: ['cl'], label: vscode.l10n.t('Wrap the long CL command (+)'), detail: vscode.l10n.t('Split before column 80 with + continuations'),
      run: async ed => { const l = ed.document.lineAt(ed.selection.active.line); await replaceRange(ed, l.range, wrapClCommand(l.text).join('\n')); } },
    { id: 'toQcmdexc', group: vscode.l10n.t('Copy'), langs: ['cl'], label: vscode.l10n.t('Copy as an SQL call (QSYS2.QCMDEXC)'), detail: vscode.l10n.t('Run the command from Run SQL or ACS'),
      run: async ed => { const r = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).range : ed.selection; await copied(toQcmdexc(ed.document.getText(r)), 'CALL QSYS2.QCMDEXC'); } },
    // ---- SQL scripts
    { id: 'countFirst', group: vscode.l10n.t('SQL'), langs: ['sql'], label: vscode.l10n.t('How many rows will change? (COUNT first)'), detail: vscode.l10n.t('Adds SELECT COUNT(*) above the UPDATE or DELETE'),
      run: async ed => { const { range, sql } = sqlStatementAt(ed); await ed.edit(b => b.insert(new vscode.Position(range.start.line, 0), countFirst(sql) + '\n')); } },
    { id: 'limitSelect', group: vscode.l10n.t('SQL'), langs: ['sql'], label: vscode.l10n.t('Limit to 100 rows'), detail: 'FETCH FIRST 100 ROWS ONLY',
      run: async ed => { const { range, sql } = sqlStatementAt(ed); await replaceRange(ed, range, limitSelect(sql)); } },
    { id: 'sqlToEmbedded', group: vscode.l10n.t('SQL'), langs: ['sql'], label: vscode.l10n.t('Copy as embedded SQL for RPG'), detail: vscode.l10n.t('EXEC SQL …; with ? markers as :host variables'),
      run: async ed => { await copied(sqlToEmbedded(sqlStatementAt(ed).sql), 'EXEC SQL'); } },
    { id: 'sqlCase', group: vscode.l10n.t('SQL'), langs: ['sql', 'rpgle'], label: vscode.l10n.t('SQL keywords in upper / lower case'), detail: vscode.l10n.t('Names, literals and :host variables untouched'),
      run: async ed => { const m = await vscode.window.showQuickPick([{ label: 'SELECT … FROM … WHERE', v: 'upper' as const }, { label: 'select … from … where', v: 'lower' as const }]); if (!m) { return; } const r = ed.selection.isEmpty ? new vscode.Range(0, 0, ed.document.lineCount, 0) : ed.selection; await replaceRange(ed, r, sqlKeywordCase(ed.document.getText(r), m.v)); } },
    { id: 'inList', group: vscode.l10n.t('SQL'), langs: ['any'], selection: true, label: vscode.l10n.t('Lines to an SQL IN list'), detail: "A\\nB\\n12 → ('A', 'B', 12)",
      run: async ed => { await replaceRange(ed, ed.selection, toSqlInList(ed.document.getText(ed.selection))); } },
    { id: 'csvToValues', group: vscode.l10n.t('SQL'), langs: ['any'], selection: true, label: vscode.l10n.t('CSV lines to SQL VALUES / INSERT'), detail: vscode.l10n.t('Comma, semicolon or tab separated; numbers stay numbers'),
      run: async ed => { const table = await vscode.window.showInputBox({ title: vscode.l10n.t('INSERT INTO table (empty for VALUES only)') }); if (table === undefined) { return; } await newDocument(csvToValues(ed.document.getText(ed.selection), table.trim() || undefined) + '\n', 'sql'); } },
    // ---- any language
    { id: 'toLiteral', group: vscode.l10n.t('Edit'), langs: ['any'], selection: true, label: vscode.l10n.t('Selection to a literal'), detail: vscode.l10n.t("Quotes doubled: it's → 'it''s'"),
      run: async ed => { await replaceRange(ed, ed.selection, toLiteral(ed.document.getText(ed.selection))); } },
    { id: 'alignAssignments', group: vscode.l10n.t('Edit'), langs: ['rpgle', 'any'], selection: true, label: vscode.l10n.t('Align the = signs'), detail: vscode.l10n.t('Assignments of the selection in one column'),
      run: async ed => { const { r, l } = lines(ed); await replaceRange(ed, r, alignAssignments(l).join('\n')); } },
    { id: 'alignComments', group: vscode.l10n.t('Edit'), langs: ['rpgle', 'any'], selection: true, label: vscode.l10n.t('Align end-of-line comments'), detail: vscode.l10n.t('// comments of the selection in one column'),
      run: async ed => { const { r, l } = lines(ed); await replaceRange(ed, r, alignComments(l, ed.document.languageId === 'sql' ? '--' : '//').join('\n')); } },
    { id: 'removeBlank', group: vscode.l10n.t('Edit'), langs: ['any'], selection: true, label: vscode.l10n.t('Remove blank lines'), detail: vscode.l10n.t('In the selection'),
      run: async ed => { const { r, l } = lines(ed); await replaceRange(ed, r, removeBlankLines(l).join('\n')); } },
    { id: 'cleanSource', group: vscode.l10n.t('Edit'), langs: ['any'], label: vscode.l10n.t('Clean up the source'), detail: vscode.l10n.t('Tabs, trailing blanks, non-breaking and invisible spaces'),
      run: async ed => { const res = cleanSource(ed.document.getText()); await bulk(ed, res.changes, vscode.l10n.t('line to clean'), () => ed.edit(b => b.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), res.text))); } },
    { id: 'copyMarkdown', group: vscode.l10n.t('Copy'), langs: ['any'], label: vscode.l10n.t('Copy as Markdown'), detail: vscode.l10n.t('Code block with where it comes from, for tickets and chats'),
      run: async ed => { const doc = ed.document; const r = ed.selection.isEmpty ? new vscode.Range(0, 0, doc.lineCount, 0) : selectedLines(ed); const m = memberOf(doc); const where = (m ? `${m.lib}/${m.file}(${m.member})` : vscode.workspace.asRelativePath(doc.uri)) + (ed.selection.isEmpty ? '' : ` ${vscode.l10n.t('lines {0}-{1}', r.start.line + 1, r.end.line + 1)}`); await copied(markdownBlock(doc.getText(r), doc.languageId, where), 'Markdown'); } },
    { id: 'copyLineRef', group: vscode.l10n.t('Copy'), langs: ['any'], label: vscode.l10n.t('Copy a reference to this line'), detail: 'LIB/FILE(MEMBER) line 42',
      run: async ed => { const doc = ed.document; const m = memberOf(doc); const line = ed.selection.active.line + 1; await copied(m ? `${m.lib}/${m.file}(${m.member}) ${vscode.l10n.t('line {0}', line)}` : `${vscode.workspace.asRelativePath(doc.uri)}:${line}`, vscode.l10n.t('The reference')); } },
    { id: 'copyCompile', group: vscode.l10n.t('Copy'), langs: ['rpgle', 'cl', 'sql', 'dds'], label: vscode.l10n.t('Copy the compile command'), detail: 'CRTBNDRPG, CRTSQLRPGI, CRTBNDCL, CRTPF, CRTDSPF…',
      run: async ed => { const m = memberOf(ed.document); const base = path.basename(ed.document.uri.path); const parts = m ?? { lib: 'LIB', file: 'QSRC', member: base.replace(/\.[^.]*$/, ''), type: base.split('.').pop() ?? '' }; const cmd = compileCommand(parts.lib, parts.file, parts.member, parts.type); if (!cmd) { throw new Error(vscode.l10n.t('No compile command is known for type {0}.', parts.type)); } await copied(cmd, cmd.split(' ')[0]); } },
    { id: 'whatsNew', group: vscode.l10n.t('Help'), langs: ['any'], label: vscode.l10n.t('What is new in 3.0'), detail: vscode.l10n.t('Every new feature, with its shortcut'),
      run: async () => { await vscode.env.openExternal(vscode.Uri.parse('https://gauravgupta0612.github.io/vanthrex-ibmi-docs/features-3-0.html')); } },
  ];
}

/** Commands from the earlier 2.6 batches, shown in the same menu. */
const EXISTING: { id: string; label: string; group: string; langs: Lang[]; selection?: boolean }[] = [
  { id: 'vanthrex.rpg.closeBlock', label: vscode.l10n.t('Close the Open Block (ENDIF, ENDDO…)'), group: 'Edit', langs: ['rpgle'] }, { id: 'vanthrex.rpg.surround', label: vscode.l10n.t('Surround With (IF, MONITOR, DOW, FOR…)…'), group: 'Edit', langs: ['rpgle'], selection: true },
  { id: 'vanthrex.rpg.ifToSelect', label: vscode.l10n.t('Convert IF / ELSEIF to SELECT / WHEN'), group: 'Rewrite', langs: ['rpgle'], selection: true }, { id: 'vanthrex.rpg.toggleValue', label: vscode.l10n.t('Toggle Value (*ON / *OFF, AND / OR, = / <>…)'), group: 'Edit', langs: ['rpgle'] },
  { id: 'vanthrex.rpg.toggleComment', label: vscode.l10n.t('Toggle RPG Comment'), group: 'Edit', langs: ['rpgle'] }, { id: 'vanthrex.rpg.keywordCase', label: vscode.l10n.t('Change Keyword Case…'), group: 'Rewrite', langs: ['rpgle'] },
  { id: 'vanthrex.rpg.alignDeclarations', label: vscode.l10n.t('Align Declarations'), group: 'Rewrite', langs: ['rpgle'], selection: true }, { id: 'vanthrex.rpg.sortDeclarations', label: vscode.l10n.t('Sort Declarations by Name'), group: 'Rewrite', langs: ['rpgle'], selection: true },
  { id: 'vanthrex.rpg.wrapLine', label: vscode.l10n.t('Wrap Long Line'), group: 'Edit', langs: ['rpgle'] }, { id: 'vanthrex.rpg.joinLines', label: vscode.l10n.t('Join the Lines of a Statement'), group: 'Edit', langs: ['rpgle'] },
  { id: 'vanthrex.rpg.formatEmbeddedSql', label: vscode.l10n.t('Format Embedded SQL'), group: 'SQL', langs: ['rpgle'] }, { id: 'vanthrex.rpg.procedureHeader', label: vscode.l10n.t('Insert Procedure Skeleton…'), group: 'Generate', langs: ['rpgle'] },
  { id: 'vanthrex.rpg.documentAll', label: vscode.l10n.t('Add a Header to Every Procedure'), group: 'Generate', langs: ['rpgle'] }, { id: 'vanthrex.rpg.binderSource', label: vscode.l10n.t('Generate Binder Source From the Exports'), group: 'Generate', langs: ['rpgle'] },
  { id: 'vanthrex.rpg.prototypeCopybook', label: vscode.l10n.t('Generate a Prototype Copybook From the Exports'), group: 'Generate', langs: ['rpgle'] }, { id: 'vanthrex.rpg.removeUnusedDeclarations', label: vscode.l10n.t('Remove Unused Declarations…'), group: 'Fix all', langs: ['rpgle'] },
  { id: 'vanthrex.rpg.clearChangeMarkers', label: vscode.l10n.t('Clear Change Markers (Columns 1-5)'), group: 'Edit', langs: ['rpgle'] }, { id: 'vanthrex.rpg.ruler', label: vscode.l10n.t('Insert Column Ruler'), group: 'Edit', langs: ['rpgle'] },
  { id: 'vanthrex.rpg.ibmDocs', label: vscode.l10n.t('Open IBM Documentation for the Word'), group: 'Help', langs: ['rpgle', 'cl', 'sql', 'dds'] }, { id: 'vanthrex.toggleInlineSuggestions', label: vscode.l10n.t('Turn IBM i Suggestions On or Off'), group: 'Help', langs: ['any'] },
  { id: 'vanthrex.copyLink', label: vscode.l10n.t('Copy a Link That Opens This Line'), group: 'Copy', langs: ['rpgle', 'cl', 'sql', 'dds'] },
  { id: 'vanthrex.codeHealth', label: vscode.l10n.t('Code Health Report of a Library…'), group: 'Check', langs: ['any'] },
  { id: 'vanthrex.standards.edit', label: vscode.l10n.t('Team Coding Standards…'), group: 'Check', langs: ['any'] },
  { id: 'vanthrex.standards.importRpglint', label: vscode.l10n.t('Import Coding Standards from rpglint.json…'), group: 'Check', langs: ['any'] },
  { id: 'vanthrex.importCodeForIbmi', label: vscode.l10n.t('Import My Code for IBM i Setup (Connections, Library Lists, Actions)…'), group: 'Setup', langs: ['any'] },
  { id: 'vanthrex.team.export', label: vscode.l10n.t('Export a Team Setup File…'), group: 'Setup', langs: ['any'] },
  { id: 'vanthrex.team.import', label: vscode.l10n.t('Import a Team Setup File…'), group: 'Setup', langs: ['any'] },
  { id: 'vanthrex.formatSql', label: vscode.l10n.t('Format SQL'), group: 'SQL', langs: ['sql'] },
];

async function showToolbox(manager: ConnectionManager): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { vscode.window.showInformationMessage(vscode.l10n.t('Open a source to see the tools for it.')); return; }
  const lang = ed.document.languageId; const sel = !ed.selection.isEmpty;
  const fits = (langs: Lang[], needsSel?: boolean) => (langs.includes(lang as Lang) || langs.includes('any')) && (!needsSel || sel);
  const all = await vscode.commands.getCommands(true);
  type Item = vscode.QuickPickItem & { run?: () => Promise<void> };
  const groups = new Map<string, Item[]>();
  const add = (g: string, it: Item) => { groups.set(g, [...(groups.get(g) ?? []), it]); };
  for (const tool of tools(manager)) { if (fits(tool.langs, tool.selection)) { add(tool.group, { label: tool.label, detail: tool.detail, run: () => tool.run(ed) }); } }
  for (const e of EXISTING) {
    if (!fits(e.langs, e.selection) || !all.includes(e.id)) { continue; }
    add(vscode.l10n.t(e.group), { label: e.label, run: async () => { await vscode.commands.executeCommand(e.id); } });
  }
  const items: Item[] = [];
  for (const [g, its] of groups) { items.push({ label: g, kind: vscode.QuickPickItemKind.Separator }, ...its); }
  const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('IBM i tools for this {0} source{1}', lang.toUpperCase(), sel ? vscode.l10n.t(' (selection)') : ''), placeHolder: vscode.l10n.t('Type to search: convert, SQL, copy, declare, align…'), matchOnDetail: true });
  if (pick?.run) { await pick.run(); }
}

// ---------------------------------------------------------------- hovers

function hover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
  if (!cfg().get<boolean>('editor.sizeHovers', true)) { return undefined; }
  const text = doc.lineAt(pos.line).text;
  if (doc.languageId === 'rpgle' && /\/\//.test(text.slice(0, pos.character).replace(/'[^']*'/g, ''))) { return undefined; }
  const lit = literalAt(text, pos.character);
  if (lit && lit.text.length >= 2) {
    const n = lit.hex ? lit.text.replace(/\s/g, '').length / 2 : lit.text.length;
    return new vscode.Hover(lit.hex ? vscode.l10n.t('{0} byte(s)', n) : vscode.l10n.t('{0} character(s)', n), new vscode.Range(pos.line, lit.start, pos.line, lit.end));
  }
  if (doc.languageId !== 'rpgle') { return undefined; }
  const w = doc.getWordRangeAtPosition(pos, /[A-Za-z_$#@][\w$#@]*/);
  if (!w || !/^\s*(dcl-s|dcl-subf|dcl-parm)?\s*[A-Za-z_$#@]/i.test(text)) { return undefined; }
  const name = doc.getText(w).toUpperCase();
  const d = parseRpg(doc.getText()).definitions.find(x => x.line === pos.line && x.upper === name && ['variable', 'subfield', 'parameter'].includes(x.kind));
  const bytes = d ? declarationBytes(d.detail) : undefined;
  return bytes ? new vscode.Hover(vscode.l10n.t('{0}: {1} byte(s) of storage', d!.name, bytes), w) : undefined;
}

export function registerDeveloperToolbox(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
  status.text = '$(tools) IBM i'; status.command = 'vanthrex.dev.toolbox';
  status.tooltip = vscode.l10n.t('IBM i tools for this source (Ctrl+Alt+A)');
  const showStatus = (ed?: vscode.TextEditor) => { if (ed && ['rpgle', 'cl', 'sql', 'dds'].includes(ed.document.languageId) && cfg().get<boolean>('editor.toolboxButton', true)) { status.show(); } else { status.hide(); } };
  const run = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('vanthrex.dev.toolbox', run(() => showToolbox(manager))),
    ...tools(manager).map(tool => vscode.commands.registerCommand(`vanthrex.dev.${tool.id}`, run(async () => {
      const ed = vscode.window.activeTextEditor; if (!ed) { vscode.window.showInformationMessage(vscode.l10n.t('Open a source first.')); return; }
      await tool.run(ed);
    }))),
    vscode.languages.registerHoverProvider([{ language: 'rpgle' }, { language: 'cl' }, { language: 'sql' }], { provideHover: (d, p) => { try { return hover(d, p); } catch (e) { logError(e); return undefined; } } }),
    vscode.window.onDidChangeActiveTextEditor(showStatus),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vanthrex.editor.toolboxButton')) { showStatus(vscode.window.activeTextEditor); } }),
  );
  showStatus(vscode.window.activeTextEditor);
}

/** Tool ids and labels, for package.json and the docs. */
export function toolList(): { id: string; label: string; langs: string[] }[] {
  return tools({} as ConnectionManager).map(x => ({ id: `vanthrex.dev.${x.id}`, label: x.label, langs: x.langs }));
}
