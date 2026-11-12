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
import {
  addPaging, addRowNumber, alignColumns, boxComment, changeCase, clCheckObject, clearVars, clOverride, clReadLoop, clRtvjoba, clSendMessage, clSystemValue,
  commentOnFromCreate, commentOut, countText, createOrReplace, cursorLoop, fromEbcdicHex, indexForSelect, infds, initVars, insertFromCreate, joinComma,
  labelOnFromCreate, mergeFromCreate, numberLines, parmsToVars, psds, quoteLines, readLoop, readUncommitted, resetVars, reverseLines, selectFromCreate,
  selectToCount, sortLines, splitComma, toCamelCase, toEbcdicHex, toUpperSnake, traceVars, trimLines, uniqueLines, updateFromCreate, valuesToArray, valuesToSelect,
  varsToParms, wrapInCte,
} from '../core/devTools2';
import { clAllocate, clAskUser, clConvertDate, clCopyFile, clObjectInfo, clProgram, clRetry, clRunSql, clSaveToSavf, clSubmit } from '../core/clSnippets';
import { ccsidName, dateFormats, duration, hexDecimal, messageCommand, numericInfo, parseIbmiDate, rpgToSqlType, sqlToRpgType, systemName } from '../core/ibmiConverters';
import {
  addAuditColumns, addIdentityColumn, auditTrigger, createTableAs, createView, deleteToSelect, dropForCreate, findDuplicates, functionSkeleton, lastDays,
  procedureSkeleton, selectToJson, tableSize, updateToSelect, whoLocksTable,
} from '../core/sqlBuilders';
import {
  arrayLookup, clFromRpg, commitBlock, csvLine, dataArea, jsonObject, dataQueue, dateConversion, elapsedTime, gettersSetters, ifsRead, ifsWrite, jobLogMessage, retryLoop, sendEmail,
} from '../rpg/rpgSnippets';
import { addSqlStateChecks, dateDifference, forEachLoop, getDiagnostics, monthBounds, multiRowFetch, objectExists, sendMessage, sortDsArray, splitText } from '../rpg/rpgRecipes';
import { compareTables, deleteDuplicates, hierarchy, numberGaps, percentOfTotal, pivot, previousRow, runningTotal, topPerGroup, valueList } from '../core/sqlRecipes';
import { clLibraryListSwap, clMemberLoop, clObjectLoop, clQshCommand } from '../core/clRecipes';
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

/** Thrown when an input box is closed: the tool stops quietly. */
class CancelError extends Error {}

// ---------------------------------------------------------------- the tools

function tools(manager: ConnectionManager): Tool[] {
  const lines = (ed: vscode.TextEditor) => { const r = selectedLines(ed); return { r, l: ed.document.getText(r).split(/\r?\n/) }; };
  const bulk = async (ed: vscode.TextEditor, n: number, what: string, apply: () => Thenable<boolean>) => {
    if (!n) { vscode.window.showInformationMessage(vscode.l10n.t('Nothing to do: no {0} in this source.', what)); return; }
    await apply(); vscode.window.setStatusBarMessage(vscode.l10n.t('{0} change(s) made (Ctrl+Z undoes them all).', n), 5000);
  };
  // ---- 3.3 helpers
  const sel = (ed: vscode.TextEditor) => { const r = ed.selection.isEmpty ? new vscode.Range(0, 0, ed.document.lineCount, 0) : selectedLines(ed); return { r, text: ed.document.getText(r) }; };
  const onSel = (fn: (t: string) => string) => async (ed: vscode.TextEditor) => { const { r, text } = sel(ed); await replaceRange(ed, r, fn(text)); };
  const onSelection = (fn: (t: string) => string) => async (ed: vscode.TextEditor) => { const { range, text } = selectionOrWord(ed); await replaceRange(ed, range, fn(text)); };
  const onStatement = (fn: (sql: string) => string) => async (ed: vscode.TextEditor) => { const { range, sql } = sqlStatementAt(ed); await replaceRange(ed, range, fn(sql)); };
  const below = (fn: (sql: string) => string) => async (ed: vscode.TextEditor) => {
    const { range, sql } = sqlStatementAt(ed); const out = fn(sql);
    // After the statement's own ";" (added when it has none), on new lines.
    const line = ed.document.lineAt(range.end.line); const rest = line.text.slice(range.end.character);
    const at = /^\s*;/.test(rest) ? line.range.end : range.end;
    await ed.edit(b => b.insert(at, `${/^\s*;/.test(rest) ? '' : ';'}\n\n${out};`));
  };
  const indentOf = (ed: vscode.TextEditor) => /^\s*/.exec(ed.document.lineAt(ed.selection.active.line).text)![0];
  const insertHere = async (ed: vscode.TextEditor, text: string) => { const line = ed.selection.active.line; const empty = !ed.document.lineAt(line).text.trim(); await ed.edit(b => empty ? b.replace(ed.document.lineAt(line).range, text) : b.insert(new vscode.Position(line + 1, 0), text + '\n')); };
  const ask = async (prompt: string, value = '', placeHolder = '') => { const v = await vscode.window.showInputBox({ prompt, value, placeHolder }); if (v === undefined) { throw new CancelError(); } return v.trim(); };
  const insertBelowSel = async (ed: vscode.TextEditor, fn: (t: string) => string) => { const { r, text } = sel(ed); const out = fn(text); await ed.edit(b => b.insert(new vscode.Position(r.end.line + 1, 0), out + '\n')); };
  const I = 'IBM i';
  const T = vscode.l10n.t('Text'); const S3 = 'SQL'; const G = vscode.l10n.t('Generate'); const R = vscode.l10n.t('Rewrite'); const C = vscode.l10n.t('Copy');
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
    // ---- 3.3: text
    { id: 'sortLines', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Sort the lines (A → Z)'), detail: 'B, A, C10, C9 → A, B, C9, C10', run: onSel(x => sortLines(x)) },
    { id: 'sortLinesDesc', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Sort the lines (Z → A)'), detail: 'C, B, A', run: onSel(x => sortLines(x, true)) },
    { id: 'uniqueLines', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Remove duplicate lines'), detail: 'A, B, A → A, B', run: onSel(uniqueLines) },
    { id: 'reverseLines', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Reverse the lines'), detail: '1, 2, 3 → 3, 2, 1', run: onSel(reverseLines) },
    { id: 'trimLines', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Trim the lines'), detail: "'  a  ' → 'a'", run: onSel(trimLines) },
    { id: 'upperCase', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Upper case (literals untouched)'), detail: "if name = 'Abc' → IF NAME = 'Abc'", run: onSelection(x => changeCase(x, 'upper')) },
    { id: 'lowerCase', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Lower case (literals untouched)'), detail: "IF NAME = 'Abc' → if name = 'Abc'", run: onSelection(x => changeCase(x, 'lower')) },
    { id: 'joinComma', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Join the lines with commas'), detail: 'A\\nB\\nC → A, B, C', run: onSel(joinComma) },
    { id: 'splitComma', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Split a comma list into lines'), detail: 'A, B; C → A\\nB\\nC', run: onSelection(splitComma) },
    { id: 'quoteLines', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Quote each line'), detail: "it's → 'it''s',", run: onSel(x => quoteLines(x, ',')) },
    { id: 'numberLines', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Number the lines'), detail: '1 a, 2 b…', run: onSel(x => numberLines(x)) },
    { id: 'countText', group: T, langs: ['any'], label: vscode.l10n.t('Count lines, words and characters'), detail: vscode.l10n.t('Of the selection, or of the whole source'),
      run: async ed => { const c = countText(sel(ed).text); vscode.window.showInformationMessage(vscode.l10n.t('{0} line(s), {1} word(s), {2} character(s); the longest line has {3}.', c.lines, c.words, c.chars, c.longest)); } },
    { id: 'toEbcdicHex', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Text to an EBCDIC hex literal'), detail: "AB → x'C1C2' (CCSID 37)", run: onSelection(toEbcdicHex) },
    { id: 'fromEbcdicHex', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('EBCDIC hex literal to text'), detail: "x'C1C2' → AB (CCSID 37)", run: onSelection(fromEbcdicHex) },
    { id: 'boxComment', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Put the lines in a comment box'), detail: '// ====\\n// Title\\n// ====', run: async ed => { const { r, text } = sel(ed); await replaceRange(ed, r, boxComment(text, ed.document.languageId)); } },
    { id: 'camelCase', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Names to camelCase'), detail: 'CUSTOMER_NAME → customerName', run: onSelection(toCamelCase) },
    { id: 'upperSnake', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Names to UPPER_SNAKE (SQL style)'), detail: 'customerName → CUSTOMER_NAME', run: onSelection(toUpperSnake) },
    { id: 'alignColumns', group: T, langs: ['any'], selection: true, label: vscode.l10n.t('Align the selection as a table'), detail: vscode.l10n.t('Columns separated by two spaces or a tab'), run: onSel(alignColumns) },
    // ---- 3.3: SQL
    { id: 'selectToCount', group: S3, langs: ['sql'], label: vscode.l10n.t('SELECT → SELECT COUNT(*)'), detail: 'SELECT a, b FROM t WHERE … → SELECT COUNT(*) FROM t WHERE …', run: below(selectToCount) },
    { id: 'wrapInCte', group: S3, langs: ['sql'], label: vscode.l10n.t('Wrap in a common table expression (WITH)'), detail: 'WITH X AS (…) SELECT * FROM X', run: onStatement(x => wrapInCte(x)) },
    { id: 'addRowNumber', group: S3, langs: ['sql'], label: vscode.l10n.t('Add a row number column'), detail: 'ROW_NUMBER() OVER (…) AS RN', run: async ed => { const order = await ask(vscode.l10n.t('Number the rows in the order of (columns, or empty)'), '', 'ORDDATE DESC'); await onStatement(x => addRowNumber(x, order))(ed); } },
    { id: 'addPaging', group: S3, langs: ['sql'], label: vscode.l10n.t('Add paging (OFFSET … FETCH NEXT)'), detail: 'OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY', run: onStatement(x => addPaging(x)) },
    { id: 'readUncommitted', group: S3, langs: ['sql'], label: vscode.l10n.t('Read without waiting for locks (WITH UR)'), detail: 'SELECT … WITH UR', run: onStatement(readUncommitted) },
    { id: 'createOrReplace', group: S3, langs: ['sql'], label: vscode.l10n.t('CREATE TABLE → CREATE OR REPLACE TABLE'), detail: 'ON REPLACE PRESERVE ROWS', run: onStatement(createOrReplace) },
    { id: 'labelOn', group: S3, langs: ['sql'], label: vscode.l10n.t('LABEL ON for every column of this CREATE TABLE'), detail: "LABEL ON COLUMN T (A TEXT IS '…')", run: below(labelOnFromCreate) },
    { id: 'commentOn', group: S3, langs: ['sql'], label: vscode.l10n.t('COMMENT ON for every column of this CREATE TABLE'), detail: "COMMENT ON COLUMN T (A IS '…')", run: below(commentOnFromCreate) },
    { id: 'insertFromCreate', group: S3, langs: ['sql'], label: vscode.l10n.t('INSERT from this CREATE TABLE'), detail: 'INSERT INTO T (A, B) VALUES (?, ?)', run: below(insertFromCreate) },
    { id: 'selectFromCreate', group: S3, langs: ['sql'], label: vscode.l10n.t('SELECT by key from this CREATE TABLE'), detail: 'SELECT A, B FROM T WHERE KEY = ?', run: below(selectFromCreate) },
    { id: 'updateFromCreate', group: S3, langs: ['sql'], label: vscode.l10n.t('UPDATE by key from this CREATE TABLE'), detail: 'UPDATE T SET B = ? WHERE KEY = ?', run: below(updateFromCreate) },
    { id: 'mergeFromCreate', group: S3, langs: ['sql'], label: vscode.l10n.t('MERGE (insert or update) from this CREATE TABLE'), detail: 'MERGE INTO T USING (VALUES …) ON KEY …', run: below(mergeFromCreate) },
    { id: 'indexForSelect', group: S3, langs: ['sql'], label: vscode.l10n.t('CREATE INDEX for this SELECT'), detail: vscode.l10n.t('Columns compared with = in the WHERE, then the ORDER BY'), run: below(indexForSelect) },
    // ---- 3.3: RPG
    { id: 'clearVars', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('CLEAR the selected variables'), detail: 'dcl-s a … → clear a;', run: async ed => { await insertBelowSel(ed, clearVars); } },
    { id: 'resetVars', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('RESET the selected variables'), detail: 'dcl-s a … → reset a;', run: async ed => { await insertBelowSel(ed, resetVars); } },
    { id: 'initVars', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('Set the selected variables to empty'), detail: "a = 0; b = *blanks; c = ''; d = *off;", run: async ed => { await insertBelowSel(ed, initVars); } },
    { id: 'traceVars', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('DSPLY the selected variables (for testing)'), detail: "dsply ('a=' + %char(a));", run: async ed => { await insertBelowSel(ed, traceVars); } },
    { id: 'varsToParms', group: R, langs: ['rpgle'], selection: true, label: vscode.l10n.t('DCL-S lines → a parameter list (DCL-PI)'), detail: 'dcl-s a char(10); → dcl-pi … a char(10) const;', run: async ed => { const n = await ask(vscode.l10n.t('Procedure name (*n inside the procedure)'), '*n'); await onSel(x => varsToParms(x, n || '*n'))(ed); } },
    { id: 'parmsToVars', group: R, langs: ['rpgle'], selection: true, label: vscode.l10n.t('Parameter lines → DCL-S'), detail: 'a char(10) const; → dcl-s a char(10);', run: onSel(parmsToVars) },
    { id: 'valuesToSelect', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('Values → a SELECT / WHEN'), detail: "A\\nB → select; when x = 'A'; … endsl;", run: async ed => { const v = await ask(vscode.l10n.t('Compare which variable?'), '', 'status'); const { r, text } = sel(ed); await replaceRange(ed, r, valuesToSelect(text, v || 'x', /^\s*/.exec(text)![0])); } },
    { id: 'valuesToArray', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('Values → an array initialised with them'), detail: "dcl-ds …; *n char(5) inz('A'); … dim(n) pos(1);", run: async ed => { const v = await ask(vscode.l10n.t('Name of the array'), 'values'); const { r, text } = sel(ed); await replaceRange(ed, r, valuesToArray(text, v || 'values', /^\s*/.exec(text)![0])); } },
    { id: 'readLoop', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a READ loop over a file'), detail: 'setll / read / dow not %eof / enddo', run: async ed => { const f = await ask(vscode.l10n.t('File name'), '', 'CUSTMAST'); const k = await ask(vscode.l10n.t('Key to read equal (empty for the whole file)'), '', 'custNo'); await insertHere(ed, readLoop(f, indentOf(ed), k)); } },
    { id: 'cursorLoop', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert an SQL cursor loop'), detail: 'declare / open / fetch until SQLCODE 100 / close', run: async ed => { const q = await ask(vscode.l10n.t('SELECT statement of the cursor'), 'SELECT * FROM '); await insertHere(ed, cursorLoop(q, 'C1', indentOf(ed))); } },
    { id: 'psds', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert the program status data structure (PSDS)'), detail: 'program, status, message ID, job, user', run: async ed => { await insertHere(ed, psds(indentOf(ed))); } },
    { id: 'infds', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a file information data structure (INFDS)'), detail: 'file, status, opcode, record, RRN', run: async ed => { const f = await ask(vscode.l10n.t('File name'), '', 'ORDERS'); await insertHere(ed, infds(f, indentOf(ed))); } },
    { id: 'commentOut', group: vscode.l10n.t('Edit'), langs: ['rpgle', 'cl', 'sql'], selection: true, label: vscode.l10n.t('Comment out with a date, author and reason'), detail: '// 2026-11-06 GG: reason', run: async ed => { const why = await ask(vscode.l10n.t('Why is it commented out?'), '', 'replaced by …'); await onSel(x => commentOut(x, ed.document.languageId, userName(manager), new Date().toISOString().slice(0, 10), why))(ed); } },
    // ---- 3.3: CL
    { id: 'clRtvjoba', group: G, langs: ['cl'], label: vscode.l10n.t('Insert RTVJOBA with its variables'), detail: 'JOB, USER, NBR, TYPE, CURLIB', run: async ed => { await insertHere(ed, clRtvjoba()); } },
    { id: 'clCheckObject', group: G, langs: ['cl'], label: vscode.l10n.t('Insert CHKOBJ with MONMSG'), detail: "CHKOBJ … MONMSG CPF9801 EXEC(DO) SNDPGMMSG … *ESCAPE", run: async ed => { const o = await ask(vscode.l10n.t('Object (LIB/NAME or NAME)'), '', 'APPLIB/ORDERS'); const ty = await ask(vscode.l10n.t('Object type'), '*FILE'); await insertHere(ed, clCheckObject(o, ty)); } },
    { id: 'clReadLoop', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a RCVF loop over a file'), detail: 'DCLF, RCVF, MONMSG CPF0864', run: async ed => { const f = await ask(vscode.l10n.t('File name'), '', 'CUSTMAST'); await insertHere(ed, clReadLoop(f)); } },
    { id: 'clSendMessage', group: G, langs: ['cl'], label: vscode.l10n.t('Insert SNDPGMMSG (escape, completion…)'), detail: 'SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) …', run: async ed => {
      const kind = await vscode.window.showQuickPick(['*ESCAPE', '*COMP', '*INFO', '*DIAG'], { placeHolder: vscode.l10n.t('Message type') }); if (!kind) { return; }
      const txt = await ask(vscode.l10n.t('Text of the message')); await insertHere(ed, clSendMessage(txt, kind as '*ESCAPE')); } },
    { id: 'clOverride', group: R, langs: ['cl'], selection: true, label: vscode.l10n.t('Put the selection between OVRDBF and DLTOVR'), detail: 'OVRDBF FILE(…) TOFILE(…) … DLTOVR', run: async ed => { const f = await ask(vscode.l10n.t('File to override'), '', 'ORDERS'); const to = await ask(vscode.l10n.t('Override to (LIB/FILE)'), '', 'TESTLIB/ORDERS'); await onSel(x => clOverride(x, f, to))(ed); } },
    { id: 'clSystemValue', group: G, langs: ['cl'], label: vscode.l10n.t('Insert RTVSYSVAL with its variable'), detail: 'DCL … RTVSYSVAL SYSVAL(…) RTNVAR(…)', run: async ed => { const v = await ask(vscode.l10n.t('System value'), 'QDATE'); await insertHere(ed, clSystemValue(v)); } },
    // ---- 3.3 batch 2: RPG snippets
    { id: 'rpgDateConv', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a date conversion between formats'), detail: '%char(%date(x: *ymd): *iso) in MONITOR', run: async ed => { const v = await ask(vscode.l10n.t('Date variable or value'), '', 'ordDate'); const f = await ask(vscode.l10n.t('From format'), '*YMD'); const t2 = await ask(vscode.l10n.t('To format'), '*ISO'); await insertHere(ed, dateConversion(v || 'dateIn', f, t2, indentOf(ed))); } },
    { id: 'rpgIfsWrite', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert writing lines to an IFS file (SQL)'), detail: 'QSYS2.IFS_WRITE_UTF8 REPLACE / APPEND', run: async ed => { const f = await ask(vscode.l10n.t('IFS file'), '/home/USER/out.txt'); await insertHere(ed, ifsWrite(f, indentOf(ed))); } },
    { id: 'rpgIfsRead', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert reading an IFS file line by line (SQL)'), detail: 'QSYS2.IFS_READ_UTF8 in a cursor', run: async ed => { const f = await ask(vscode.l10n.t('IFS file'), '/home/USER/in.txt'); await insertHere(ed, ifsRead(f, indentOf(ed))); } },
    { id: 'rpgCl', group: R, langs: ['rpgle'], selection: true, label: vscode.l10n.t('CL command → RPG call (QSYS2.QCMDEXC)'), detail: "exec sql call qsys2.qcmdexc('…');", run: onSelection(x => clFromRpg(x)) },
    { id: 'rpgDataArea', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert reading and writing a data area'), detail: 'DTAARA data structure, IN *LOCK / OUT', run: async ed => { const a = await ask(vscode.l10n.t('Data area'), '', 'ORDNBR'); await insertHere(ed, dataArea(a, indentOf(ed))); } },
    { id: 'rpgDataQueue', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert sending and receiving a data queue entry'), detail: 'QSNDDTAQ / QRCVDTAQ prototypes and calls', run: async ed => { const q2 = await ask(vscode.l10n.t('Data queue'), '', 'ORDERQ'); const l = await ask(vscode.l10n.t('Library'), '*LIBL'); await insertHere(ed, dataQueue(q2, l, indentOf(ed))); } },
    { id: 'rpgJobLog', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a job log message (QMHSNDPM)'), detail: 'CPF9898 *INFO in the job log', run: async ed => { const m = await ask(vscode.l10n.t('Text of the message'), 'Step done'); await insertHere(ed, jobLogMessage(m, indentOf(ed))); } },
    { id: 'rpgElapsed', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a time measurement (milliseconds)'), detail: '%diff(%timestamp(): started: *mseconds)', run: async ed => { await insertHere(ed, elapsedTime(indentOf(ed))); } },
    { id: 'rpgCommit', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a commit / rollback block'), detail: 'MONITOR … COMMIT … ON-ERROR … ROLLBACK', run: async ed => { await insertHere(ed, commitBlock(indentOf(ed))); } },
    { id: 'rpgLookup', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a %LOOKUP in a sorted array'), detail: 'SORTA + %LOOKUP (binary search)', run: async ed => { const a = await ask(vscode.l10n.t('Name of the array'), '', 'codes'); const v = await ask(vscode.l10n.t('Value to look for'), '', 'code'); await insertHere(ed, arrayLookup(a, v, indentOf(ed))); } },
    { id: 'rpgCsvLine', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('A CSV line from the selected variables'), detail: "csv = %trim(a) + ';' + %char(b)…", run: async ed => { const sep = await ask(vscode.l10n.t('Separator'), ';'); await insertBelowSel(ed, x => csvLine(x, sep || ';')); } },
    { id: 'rpgJsonObject', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('A JSON object from the selected variables (SQL)'), detail: "exec sql values json_object('a' value :a, …) into :json;", run: async ed => { await insertBelowSel(ed, x => jsonObject(x)); } },
    { id: 'rpgGetSet', group: G, langs: ['rpgle'], selection: true, label: vscode.l10n.t('Getter and setter procedures for the selected variables'), detail: 'getName() / setName(value)', run: async ed => { const { text } = sel(ed); await newDocument(gettersSetters(text), 'rpgle'); } },
    { id: 'rpgRetry', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a retry loop with a delay'), detail: 'FOR … MONITOR … DLYJOB', run: async ed => { await insertHere(ed, retryLoop(3, 5, indentOf(ed))); } },
    { id: 'rpgEmail', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert sending an e-mail (SNDSMTPEMM)'), detail: 'QSYS2.QCMDEXC with SNDSMTPEMM', run: async ed => { const to = await ask(vscode.l10n.t('E-mail address'), '', 'someone@example.com'); await insertHere(ed, sendEmail(to, indentOf(ed))); } },
    // ---- 3.3 batch 2: SQL builders
    { id: 'sqlToJson', group: S3, langs: ['sql'], label: vscode.l10n.t('SELECT → one JSON array (JSON_ARRAYAGG)'), detail: 'JSON_ARRAYAGG(JSON_OBJECT(…))', run: below(selectToJson) },
    { id: 'sqlCreateView', group: S3, langs: ['sql'], label: vscode.l10n.t('CREATE VIEW from this SELECT'), detail: 'CREATE OR REPLACE VIEW … AS SELECT …', run: async ed => { const v = await ask(vscode.l10n.t('Name of the view'), '', 'APPLIB.ORDERS_OPEN'); await below(x => createView(x, v))(ed); } },
    { id: 'sqlCreateTableAs', group: S3, langs: ['sql'], label: vscode.l10n.t('A table from this SELECT (CREATE TABLE AS … WITH DATA)'), detail: 'CREATE TABLE … AS (SELECT …) WITH DATA', run: async ed => { const v = await ask(vscode.l10n.t('Name of the new table'), 'QTEMP.COPY'); await below(x => createTableAs(x, v))(ed); } },
    { id: 'sqlDeleteToSelect', group: S3, langs: ['sql'], label: vscode.l10n.t('DELETE → SELECT (see the rows first)'), detail: 'DELETE FROM t WHERE … → SELECT * FROM t WHERE …', run: below(deleteToSelect) },
    { id: 'sqlUpdateToSelect', group: S3, langs: ['sql'], label: vscode.l10n.t('UPDATE → SELECT (see the rows first)'), detail: 'UPDATE t SET … WHERE … → SELECT * FROM t WHERE …', run: below(updateToSelect) },
    { id: 'sqlAuditColumns', group: S3, langs: ['sql'], label: vscode.l10n.t('Add audit columns to this CREATE TABLE'), detail: 'CREATED_AT, CREATED_BY, CHANGED_AT (ROW CHANGE TIMESTAMP)', run: onStatement(addAuditColumns) },
    { id: 'sqlIdentity', group: S3, langs: ['sql'], label: vscode.l10n.t('Add an identity column to this CREATE TABLE'), detail: 'ID BIGINT GENERATED ALWAYS AS IDENTITY', run: onStatement(x => addIdentityColumn(x)) },
    { id: 'sqlDrop', group: S3, langs: ['sql'], label: vscode.l10n.t('DROP TABLE IF EXISTS for this CREATE TABLE'), detail: 'DROP TABLE … IF EXISTS', run: below(dropForCreate) },
    { id: 'sqlProcedure', group: S3, langs: ['sql'], label: vscode.l10n.t('Insert an SQL procedure skeleton'), detail: 'CREATE OR REPLACE PROCEDURE … with an error handler', run: async ed => { const n = await ask(vscode.l10n.t('Name of the procedure'), '', 'APPLIB.CLOSE_ORDER'); await insertHere(ed, procedureSkeleton(n) + ';'); } },
    { id: 'sqlFunction', group: S3, langs: ['sql'], label: vscode.l10n.t('Insert an SQL function skeleton'), detail: 'CREATE OR REPLACE FUNCTION … RETURNS …', run: async ed => { const n = await ask(vscode.l10n.t('Name of the function'), '', 'APPLIB.CLEAN_NAME'); await insertHere(ed, functionSkeleton(n) + ';'); } },
    { id: 'sqlAuditTrigger', group: S3, langs: ['sql'], label: vscode.l10n.t('Audit trigger for this CREATE TABLE'), detail: 'AFTER INSERT OR UPDATE OR DELETE → T_AUDIT', run: below(auditTrigger) },
    { id: 'sqlDuplicates', group: S3, langs: ['sql'], label: vscode.l10n.t('Find duplicate rows in this table'), detail: 'GROUP BY … HAVING COUNT(*) > 1', run: async ed => { const c2 = await ask(vscode.l10n.t('Columns that should be unique (comma-separated)'), '', 'CUSTNO, ORDDATE'); await below(x => findDuplicates(x, c2))(ed); } },
    { id: 'sqlLastDays', group: S3, langs: ['sql'], label: vscode.l10n.t('Only the last days (date filter)'), detail: 'WHERE col >= CURRENT TIMESTAMP - n DAYS', run: async ed => { const c2 = await ask(vscode.l10n.t('Date or timestamp column'), '', 'CREATED_AT'); const d = await ask(vscode.l10n.t('How many days?'), '7'); await onStatement(x => lastDays(x, c2, Number(d)))(ed); } },
    { id: 'sqlWhoLocks', group: S3, langs: ['sql'], label: vscode.l10n.t('Who has this table locked? (IBM i Services)'), detail: 'QSYS2.OBJECT_LOCK_INFO', run: below(whoLocksTable) },
    { id: 'sqlTableSize', group: S3, langs: ['sql'], label: vscode.l10n.t('Size and rows of this table (IBM i Services)'), detail: 'QSYS2.SYSTABLESTAT', run: below(tableSize) },
    // ---- 3.3 batch 2: CL snippets
    { id: 'clProgram', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a CL program skeleton with error handling'), detail: 'PGM … MONMSG CPF0000 … RCVMSG … SNDPGMMSG … ENDPGM', run: async ed => { await insertHere(ed, clProgram()); } },
    { id: 'clRetry', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a retry loop with DLYJOB'), detail: 'RETRY: … MONMSG … DLYJOB … GOTO RETRY', run: async ed => { const c2 = await ask(vscode.l10n.t('Command to retry'), '', 'ALCOBJ OBJ((MYLIB/MYFILE *FILE *EXCL)) WAIT(0)'); await insertHere(ed, clRetry(c2)); } },
    { id: 'clAllocate', group: R, langs: ['cl'], selection: true, label: vscode.l10n.t('Put the selection between ALCOBJ and DLCOBJ'), detail: 'ALCOBJ … *EXCL … DLCOBJ', run: async ed => { const o = await ask(vscode.l10n.t('Object (LIB/NAME or NAME)'), '', 'APPLIB/ORDERS'); await onSel(x => clAllocate(x, o))(ed); } },
    { id: 'clSubmit', group: R, langs: ['cl'], selection: true, label: vscode.l10n.t('Submit the selected command to batch (SBMJOB)'), detail: 'SBMJOB CMD(…) JOB(…) JOBQ(QBATCH)', run: async ed => { const j = await ask(vscode.l10n.t('Job name'), 'BATCH'); await onSelection(x => clSubmit(x, j || 'BATCH'))(ed); } },
    { id: 'clCopyFile', group: G, langs: ['cl'], label: vscode.l10n.t('Insert CPYF (created when missing)'), detail: 'CPYF … MBROPT(*REPLACE) CRTFILE(*YES)', run: async ed => { const f = await ask(vscode.l10n.t('From file (LIB/FILE)'), '', 'APPLIB/ORDERS'); const t2 = await ask(vscode.l10n.t('To file (LIB/FILE)'), '', 'QTEMP/ORDERS'); await insertHere(ed, clCopyFile(f, t2)); } },
    { id: 'clSaveSavf', group: G, langs: ['cl'], label: vscode.l10n.t('Insert saving a library to a save file'), detail: 'CRTSAVF / CLRSAVF / SAVOBJ', run: async ed => { const l = await ask(vscode.l10n.t('Library'), '', 'APPLIB'); const f = await ask(vscode.l10n.t('Save file (LIB/NAME)'), '', 'QGPL/APPLIB'); await insertHere(ed, clSaveToSavf(l, f)); } },
    { id: 'clConvertDate', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a date conversion (CVTDAT)'), detail: 'CVTDAT … FROMFMT(*YMD) TOFMT(*ISO)', run: async ed => { const f = await ask(vscode.l10n.t('From format'), '*YMD'); const t2 = await ask(vscode.l10n.t('To format'), '*ISO'); await insertHere(ed, clConvertDate(f, t2)); } },
    { id: 'clRunSql', group: R, langs: ['cl', 'sql'], selection: true, label: vscode.l10n.t('SQL statement → RUNSQL for CL'), detail: "RUNSQL SQL('…') COMMIT(*NONE)", run: async ed => { const { text } = selectionOrWord(ed); await copied(clRunSql(text), 'RUNSQL'); } },
    { id: 'clAskUser', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a question to the user (SNDUSRMSG)'), detail: 'SNDUSRMSG … VALUES(Y N) MSGRPY(&REPLY)', run: async ed => { const q2 = await ask(vscode.l10n.t('Question'), 'Continue? (Y/N)'); await insertHere(ed, clAskUser(q2)); } },
    { id: 'clObjectInfo', group: G, langs: ['cl'], label: vscode.l10n.t('Insert RTVOBJD (exists, last used, changed)'), detail: 'RTVOBJD … CHGDATE USEDATE TEXT', run: async ed => { const o = await ask(vscode.l10n.t('Object (LIB/NAME or NAME)'), '', 'PGM1'); const ty = await ask(vscode.l10n.t('Object type'), '*PGM'); await insertHere(ed, clObjectInfo(o, ty)); } },
    // ---- 3.3 batch 2: IBM i converters
    { id: 'ibmiDate', group: I, langs: ['any'], selection: true, label: vscode.l10n.t('Convert a date between IBM i formats'), detail: '1261106 → 2026-11-06, 06.11.2026, 26310…', run: async ed => {
      const { range, text } = selectionOrWord(ed); const all = dateFormats(parseIbmiDate(text));
      const pick = await vscode.window.showQuickPick(all.map(x => ({ label: x.value, description: x.format })), { placeHolder: vscode.l10n.t('Replace with which format?') }); if (pick) { await replaceRange(ed, range, pick.label); } } },
    { id: 'ibmiToday', group: I, langs: ['any'], label: vscode.l10n.t("Insert today's date in an IBM i format"), detail: '*ISO, *CYMD, *YMD, *JUL…', run: async ed => {
      const all = dateFormats(new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())));
      const pick = await vscode.window.showQuickPick(all.map(x => ({ label: x.value, description: x.format })), { placeHolder: vscode.l10n.t('Which format?') }); if (pick) { await ed.edit(b => b.replace(ed.selection, pick.label)); } } },
    { id: 'ibmiHex', group: I, langs: ['any'], selection: true, label: vscode.l10n.t('Hex ↔ decimal'), detail: "31 ↔ x'1F'", run: onSelection(hexDecimal) },
    { id: 'ibmiSystemName', group: I, langs: ['any'], selection: true, label: vscode.l10n.t('Short system name for a long SQL name'), detail: 'CUSTOMER_ORDER_HISTORY → CSTORDHSTR (FOR SYSTEM NAME)', run: onSelection(systemName) },
    { id: 'ibmiCcsid', group: I, langs: ['any'], label: vscode.l10n.t('What is this CCSID?'), detail: '37, 297, 1208, 65535…', run: async ed => { vscode.window.showInformationMessage(ccsidName(selectionOrWord(ed).text)); } },
    { id: 'ibmiMessage', group: I, langs: ['any'], label: vscode.l10n.t('Copy DSPMSGD for the message ID'), detail: 'CPF9801 → DSPMSGD RANGE(CPF9801) MSGF(QCPFMSG)', run: async ed => { await copied(messageCommand(selectionOrWord(ed).text), 'DSPMSGD'); } },
    { id: 'ibmiSqlToRpg', group: I, langs: ['any'], selection: true, label: vscode.l10n.t('SQL types → RPG types'), detail: 'DECIMAL(9, 2) → packed(9:2)', run: onSelection(sqlToRpgType) },
    { id: 'ibmiRpgToSql', group: I, langs: ['any'], selection: true, label: vscode.l10n.t('RPG types → SQL types'), detail: 'packed(9:2) → DECIMAL(9, 2)', run: onSelection(rpgToSqlType) },
    { id: 'ibmiDuration', group: I, langs: ['any'], selection: true, label: vscode.l10n.t('Seconds ↔ h:mm:ss'), detail: '3725 ↔ 1:02:05', run: onSelection(duration) },
    { id: 'ibmiNumericInfo', group: I, langs: ['any'], label: vscode.l10n.t('Size and range of a numeric type'), detail: 'packed(9:2) → 5 bytes, ±9999999.99', run: async ed => { const line = ed.document.lineAt(ed.selection.active.line).text; vscode.window.showInformationMessage(numericInfo(ed.selection.isEmpty ? line : ed.document.getText(ed.selection))); } },
    // ---- 3.3 batch 3: RPG recipes
    { id: 'rpgSqlChecks', group: R, langs: ['rpgle'], label: vscode.l10n.t('Add an SQLSTATE check after every EXEC SQL'), detail: "if %subst(sqlstate: 1: 2) > '02'; … endif;", run: async ed => { const { r, text } = sel(ed); const res = addSqlStateChecks(text); if (!res.added) { vscode.window.showInformationMessage(vscode.l10n.t('Every EXEC SQL already has a check.')); return; } await replaceRange(ed, r, res.text); vscode.window.showInformationMessage(vscode.l10n.t('{0} check(s) added.', res.added)); } },
    { id: 'rpgDiagnostics', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert GET DIAGNOSTICS (message of the last SQL error)'), detail: 'get diagnostics condition 1 :msg = message_text', run: async ed => { await insertHere(ed, getDiagnostics(indentOf(ed))); } },
    { id: 'rpgSplit', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert splitting a text into an array'), detail: "%scan loop (and %split on 7.4 TR)", run: async ed => { const v = await ask(vscode.l10n.t('Variable holding the text'), '', 'csvLine'); const sep = await ask(vscode.l10n.t('Separator'), ';'); await insertHere(ed, splitText(v, sep, indentOf(ed))); } },
    { id: 'rpgForEach', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a FOR-EACH loop over an array'), detail: 'for-each item in array; … endfor; (7.4 TR)', run: async ed => { const a = await ask(vscode.l10n.t('Name of the array'), '', 'codes'); await insertHere(ed, forEachLoop(a, indentOf(ed))); } },
    { id: 'rpgSortDs', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert sorting a data structure array by a subfield'), detail: 'sorta orders(*).total;', run: async ed => { const a = await ask(vscode.l10n.t('Name of the data structure array'), '', 'orders'); const f = await ask(vscode.l10n.t('Subfield to sort by'), '', 'total'); await insertHere(ed, sortDsArray(a, f, indentOf(ed))); } },
    { id: 'rpgMonthBounds', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert the first and last day of the month'), detail: 'firstDay / lastDay of a date', run: async ed => { const d = await ask(vscode.l10n.t('Date variable'), '', 'orderDate'); await insertHere(ed, monthBounds(d, indentOf(ed))); } },
    { id: 'rpgDateDiff', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert days, months and years between two dates'), detail: '%diff(to: from: *days / *months / *years)', run: async ed => { const f = await ask(vscode.l10n.t('From date variable'), '', 'birthDate'); const t = await ask(vscode.l10n.t('To date variable'), '', 'today'); await insertHere(ed, dateDifference(f, t, indentOf(ed))); } },
    { id: 'rpgSndMsg', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert SND-MSG (job log or escape message)'), detail: "snd-msg 'text'; (7.4 TR)", run: async ed => { const m = await ask(vscode.l10n.t('Text of the message'), 'Step done'); await insertHere(ed, sendMessage(m, indentOf(ed))); } },
    { id: 'rpgMultiFetch', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a multi-row FETCH (100 rows at a time)'), detail: 'fetch next from c for 100 rows into :rows', run: async ed => { const q2 = await ask(vscode.l10n.t('SELECT statement'), '', 'select custno, name from customers'); await insertHere(ed, multiRowFetch(q2, indentOf(ed))); } },
    { id: 'rpgObjectExists', group: G, langs: ['rpgle'], label: vscode.l10n.t('Insert a check that an object exists (SQL)'), detail: 'qsys2.object_statistics(lib, type) where objname = …', run: async ed => { const o = await ask(vscode.l10n.t('Object (LIB/NAME or NAME)'), '', 'PGM1'); const t = await ask(vscode.l10n.t('Object type'), '*PGM'); const p = o.split('/'); await insertHere(ed, objectExists(p.length > 1 ? p[0] : '*LIBL', p[p.length - 1], t, indentOf(ed))); } },
    // ---- 3.3 batch 3: SQL recipes
    { id: 'sqlTopPerGroup', group: S3, langs: ['sql'], label: vscode.l10n.t('Top rows per group (ROW_NUMBER)'), detail: 'ROW_NUMBER() OVER (PARTITION BY … ORDER BY …) <= n', run: async ed => { const g = await ask(vscode.l10n.t('Group by column(s)'), '', 'CUSTNO'); const o = await ask(vscode.l10n.t('Order by column(s) (add DESC if needed)'), '', 'ORDDATE DESC'); const k = await ask(vscode.l10n.t('Rows per group'), '1'); await below(x => topPerGroup(x, g, o, Number(k)))(ed); } },
    { id: 'sqlRunningTotal', group: S3, langs: ['sql'], label: vscode.l10n.t('Add a running total column'), detail: 'SUM(x) OVER (ORDER BY … ROWS UNBOUNDED PRECEDING)', run: async ed => { const v = await ask(vscode.l10n.t('Column to add up'), '', 'AMOUNT'); const o = await ask(vscode.l10n.t('Order by column(s)'), '', 'ORDDATE'); const g = await ask(vscode.l10n.t('Restart for each (optional)'), '', 'CUSTNO'); await below(x => runningTotal(x, v, o, g))(ed); } },
    { id: 'sqlPrevious', group: S3, langs: ['sql'], label: vscode.l10n.t('Add the previous row\'s value and the change (LAG)'), detail: 'LAG(x) OVER (ORDER BY …), x - LAG(x)', run: async ed => { const v = await ask(vscode.l10n.t('Column'), '', 'TOTAL'); const o = await ask(vscode.l10n.t('Order by column(s)'), '', 'MONTH'); await below(x => previousRow(x, v, o))(ed); } },
    { id: 'sqlPercent', group: S3, langs: ['sql'], label: vscode.l10n.t('Add each row\'s percent of the total'), detail: 'x * 100.0 / SUM(x) OVER ()', run: async ed => { const v = await ask(vscode.l10n.t('Column'), '', 'AMOUNT'); await below(x => percentOfTotal(x, v))(ed); } },
    { id: 'sqlPivot', group: S3, langs: ['sql'], label: vscode.l10n.t('Pivot: one column per value'), detail: "SUM(CASE WHEN col = 'A' THEN x ELSE 0 END) AS A, …", run: async ed => { const g = await ask(vscode.l10n.t('Row column(s)'), '', 'CUSTNO'); const c = await ask(vscode.l10n.t('Column whose values become columns'), '', 'STATUS'); const vs = await ask(vscode.l10n.t('Values (comma-separated)'), '', 'O, C, X'); const m = await ask(vscode.l10n.t('Column to add up'), '', 'AMOUNT'); await below(x => pivot(x, g, c, vs, m))(ed); } },
    { id: 'sqlValueList', group: S3, langs: ['sql'], label: vscode.l10n.t('Values of a column as one list per group (LISTAGG)'), detail: "LISTAGG(x, ', ') WITHIN GROUP (ORDER BY x)", run: async ed => { const g = await ask(vscode.l10n.t('Group by column(s)'), '', 'CUSTNO'); const c = await ask(vscode.l10n.t('Column to list'), '', 'ORDNO'); await below(x => valueList(x, g, c))(ed); } },
    { id: 'sqlCompare', group: S3, langs: ['sql'], label: vscode.l10n.t('Rows that differ from another table (EXCEPT)'), detail: 'ONLY IN A / ONLY IN B', run: async ed => { const t2 = await ask(vscode.l10n.t('The other table (SCHEMA.TABLE)'), '', 'TESTLIB.ORDERS'); await below(x => compareTables(x, t2))(ed); } },
    { id: 'sqlDeleteDups', group: S3, langs: ['sql'], label: vscode.l10n.t('Delete duplicate rows, keep the first (preview first)'), detail: 'RRN(A) > (SELECT MIN(RRN(B)) …)', run: async ed => { const k = await ask(vscode.l10n.t('Columns that should be unique (comma-separated)'), '', 'EMAIL'); await below(x => deleteDuplicates(x, k))(ed); } },
    { id: 'sqlGaps', group: S3, langs: ['sql'], label: vscode.l10n.t('Missing numbers in a numbered column (gaps)'), detail: 'LEAD(x) OVER (ORDER BY x) > x + 1', run: async ed => { const c = await ask(vscode.l10n.t('Numbered column'), '', 'INVNO'); await below(x => numberGaps(x, c))(ed); } },
    { id: 'sqlHierarchy', group: S3, langs: ['sql'], label: vscode.l10n.t('Insert a recursive query (parent / child tree)'), detail: 'WITH TREE … UNION ALL … JOIN TREE', run: async ed => { const t2 = await ask(vscode.l10n.t('Table (SCHEMA.TABLE)'), '', 'APPLIB.EMPLOYEES'); const i = await ask(vscode.l10n.t('ID column'), '', 'EMPNO'); const p = await ask(vscode.l10n.t('Parent column'), '', 'MANAGER'); await insertHere(ed, hierarchy(t2, i, p) + ';'); } },
    // ---- 3.3 batch 3: CL recipes
    { id: 'clObjectLoop', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a loop over the objects of a library'), detail: 'DSPOBJD … OUTFILE + RCVF (QADSPOBJ)', run: async ed => { const l = await ask(vscode.l10n.t('Library'), '', 'APPLIB'); const t = await ask(vscode.l10n.t('Object type'), '*PGM'); await insertHere(ed, clObjectLoop(l, t)); } },
    { id: 'clMemberLoop', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a loop over the members of a file'), detail: 'DSPFD *MBRLIST … OUTFILE + RCVF (QAFDMBRL)', run: async ed => { const f = await ask(vscode.l10n.t('File (LIB/FILE)'), '', 'APPLIB/QRPGLESRC'); await insertHere(ed, clMemberLoop(f)); } },
    { id: 'clQsh', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a QShell command that stops on failure'), detail: 'QIBM_QSH_CMD_ESCAPE_MSG + QSH + MONMSG QSH0005', run: async ed => { const c2 = await ask(vscode.l10n.t('QShell command'), '', 'cp /home/app/in.csv /home/app/archive/'); await insertHere(ed, clQshCommand(c2)); } },
    { id: 'clLibl', group: G, langs: ['cl'], label: vscode.l10n.t('Insert a library list change that is put back'), detail: 'RTVJOBA USRLIBL … CHGLIBL … QCMDEXC', run: async ed => { const l = await ask(vscode.l10n.t('Libraries of the new library list'), '', 'APPLIB APPDTA QGPL QTEMP'); await insertHere(ed, clLibraryListSwap(l)); } },
    { id: 'whatsNew', group: vscode.l10n.t('Help'), langs: ['any'], label: vscode.l10n.t('What is new in 3.3'), detail: vscode.l10n.t('Every new feature, with its shortcut'),
      run: async () => { await vscode.env.openExternal(vscode.Uri.parse('https://gauravgupta0612.github.io/vanthrex-ibmi-docs/features-3-3.html')); } },
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
  if (pick?.run) { try { await pick.run(); } catch (e) { if (!(e instanceof CancelError)) { throw e; } } }
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
  const run = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { if (e instanceof CancelError) { return; } logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
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
