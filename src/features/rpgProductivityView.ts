// Everyday RPG editing: quick fixes for the code checks, block tools (close a block, auto-close on Enter, IF → SELECT,
// Surround With…), comments, keyword case, sorted and aligned declarations, wrapped lines, SEU ruler, change markers,
// procedure navigation and headers, smart selection, parameter-name inlay hints, reference counts, call hierarchy,
// workspace symbols from the source index, local completion with call snippets, /COPY peek, embedded SQL formatting,
// the current procedure in the status bar and fixed-format column highlights.
import * as vscode from 'vscode';
import { blockGroups } from '../core/flow';
import { formatSql } from '../core/sqlFormat';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { convertFixedToFree } from '../rpg/fixedToFree';
import { rpgSignatures } from '../rpg/editing';
import { CopyResolver } from '../rpg/navigation';
import { findOccurrences, isFullyFreeSource, maskLine, parseRpg, RpgParse } from '../rpg/parser';
import { layoutFor } from '../rpg/specLayout';
import {
  alignDeclarations, autoCloseFor, callArgumentHints, callSnippet, clearChangeMarkers, closeBlock, embeddedSqlAt, ifToSelect, keywordCase,
  procedureHeader, procedureStarts, prototypeFrom, RULER_MARK, rulerLine, sortDeclarations, surround, SurroundKind, toggleComments, wrapLine,
} from '../rpg/rpgProductivity';
import { procedureDefinitions } from '../core/speed';
import { docsArray } from './sourceIndexView';
import { memberUri } from './fileSystems';

const RPG: vscode.DocumentSelector = [{ language: 'rpgle' }];
const cfg = () => vscode.workspace.getConfiguration('vanthrex.editor');

/** Facts about a document, computed once per version (the providers below run on every keystroke and cursor move). */
interface DocFacts { v: number; text: string; p?: RpgParse; sigs?: ReturnType<typeof rpgSignatures>; fullyFree?: boolean; units?: Unit[] }
const facts = new Map<string, DocFacts>();
function factsOf(doc: vscode.TextDocument): DocFacts {
  const k = doc.uri.toString(); const c = facts.get(k);
  if (c && c.v === doc.version) { return c; }
  const f: DocFacts = { v: doc.version, text: doc.getText() };
  facts.set(k, f);
  return f;
}
function parsed(doc: vscode.TextDocument): RpgParse { const f = factsOf(doc); return (f.p ??= parseRpg(f.text)); }
function signatures(doc: vscode.TextDocument) { const f = factsOf(doc); return (f.sigs ??= rpgSignatures(f.text)); }
function fullyFreeOf(doc: vscode.TextDocument): boolean { const f = factsOf(doc); return (f.fullyFree ??= isFullyFreeSource(f.text)); }
/** Sources this big skip the per-line decorations (hints, lenses, column shading) to stay responsive. */
const BIG = 40000;
/** A provider never throws into VS Code: an unexpected source gives no result, and the error is logged once. */
function guard<A extends unknown[], R>(empty: R, fn: (...a: A) => R): (...a: A) => R {
  return (...a: A) => { try { return fn(...a); } catch (e) { logError(e); return empty; } };
}

const fullLines = (ed: vscode.TextEditor) => {
  const s = ed.selection;
  const end = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
  return new vscode.Range(s.start.line, 0, end, ed.document.lineAt(end).text.length);
};

async function replaceLines(ed: vscode.TextEditor, range: vscode.Range, lines: string[]): Promise<void> {
  await ed.edit(e => e.replace(range, lines.join('\n')));
}

function requireRpg(): vscode.TextEditor | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'rpgle') { vscode.window.showInformationMessage(vscode.l10n.t('Open an RPG source first.')); return undefined; }
  return ed;
}

// ---------------------------------------------------------------- commands

async function closeBlockCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const line = ed.selection.active.line;
  const c = closeBlock(ed.document.getText(), line);
  if (!c) { vscode.window.setStatusBarMessage(vscode.l10n.t('No open block before the cursor.'), 3000); return; }
  const cur = ed.document.lineAt(line);
  await ed.edit(e => {
    if (cur.text.trim()) { e.insert(cur.range.end, `\n${c.indent}${c.close}`); } else { e.replace(cur.range, `${c.indent}${c.close}`); }
  });
}

async function ifToSelectCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const r = fullLines(ed);
  await replaceLines(ed, r, ifToSelect(ed.document.getText(r)).split('\n'));
}

async function surroundCommand(kind?: SurroundKind): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const k = kind ?? (await vscode.window.showQuickPick([
    { label: 'IF … ENDIF', k: 'if' as SurroundKind }, { label: 'MONITOR … ON-ERROR … ENDMON', k: 'monitor' as SurroundKind }, { label: 'DOW … ENDDO', k: 'dow' as SurroundKind },
    { label: 'FOR … ENDFOR', k: 'for' as SurroundKind }, { label: 'SELECT … WHEN … ENDSL', k: 'select' as SurroundKind }, { label: 'BEGSR … ENDSR', k: 'begsr' as SurroundKind },
    { label: vscode.l10n.t('// comment'), k: 'comment' as SurroundKind },
  ], { title: vscode.l10n.t('Surround the selected lines with') }))?.k;
  if (!k) { return; }
  const r = fullLines(ed);
  const step = cfg().get<number>('rpgIndent', 2);
  await ed.insertSnippet(new vscode.SnippetString(surround(ed.document.getText(r), k, step).replace(/\n$/, '')), r);
}

async function toggleCommentCommand(): Promise<void> {
  const ed = vscode.window.activeTextEditor; if (!ed) { return; }
  const r = fullLines(ed);
  await replaceLines(ed, r, toggleComments(ed.document.getText(r).split('\n'), fullyFreeOf(ed.document)));
}

async function keywordCaseCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const mode = await vscode.window.showQuickPick([{ label: vscode.l10n.t('lower case (dcl-s, if, %trim)'), m: 'lower' as const }, { label: vscode.l10n.t('UPPER CASE (DCL-S, IF, %TRIM)'), m: 'upper' as const }], { title: vscode.l10n.t('Operation codes, built-in functions and keywords in') });
  if (!mode) { return; }
  const r = ed.selection.isEmpty ? new vscode.Range(0, 0, ed.document.lineCount, 0) : fullLines(ed);
  const before = ed.document.getText(r); const after = keywordCase(before, mode.m);
  if (before !== after) { await ed.edit(e => e.replace(r, after)); }
}

async function sortCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const r = fullLines(ed);
  await replaceLines(ed, r, sortDeclarations(ed.document.getText(r).split('\n')));
}

async function alignCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const r = fullLines(ed);
  await replaceLines(ed, r, alignDeclarations(ed.document.getText(r).split('\n')));
}

async function wrapCommand(uri?: vscode.Uri, line?: number): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!uri && !ed) { return; }
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : ed!.document;
  const free = fullyFreeOf(doc);
  const width = free ? Math.max(40, cfg().get<number>('wrapColumn', 100)) : 80;
  const from = Math.max(0, line ?? ed?.selection.start.line ?? 0); const to = Math.min(doc.lineCount - 1, line ?? ed?.selection.end.line ?? from);
  const edit = new vscode.WorkspaceEdit();
  for (let i = from; i <= to; i++) {
    const t = doc.lineAt(i).text;
    const w = wrapLine(free ? t : t.slice(0, 80) + t.slice(80), width);
    if (w.length > 1) { edit.replace(doc.uri, doc.lineAt(i).range, w.join('\n')); }
  }
  if (edit.size) { await vscode.workspace.applyEdit(edit); } else { vscode.window.setStatusBarMessage(vscode.l10n.t('Nothing to wrap (no space outside a literal before column {0}).', width), 3000); }
}

async function rulerCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const doc = ed.document;
  const existing: number[] = [];
  for (let i = 0; i < doc.lineCount; i++) { if (doc.lineAt(i).text.includes(RULER_MARK)) { existing.push(i); } }
  if (existing.length) { await ed.edit(e => existing.reverse().forEach(i => e.delete(doc.lineAt(i).rangeIncludingLineBreak))); return; }
  const line = ed.selection.active.line;
  await ed.edit(e => e.insert(new vscode.Position(line, 0), rulerLine(!isFullyFreeSource(doc.getText())) + '\n'));
}

async function clearMarkersCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const r = ed.selection.isEmpty ? new vscode.Range(0, 0, ed.document.lineCount - 1, ed.document.lineAt(ed.document.lineCount - 1).text.length) : fullLines(ed);
  const res = clearChangeMarkers(ed.document.getText(r).split('\n'), isFullyFreeSource(ed.document.getText()));
  if (!res.changed) { vscode.window.setStatusBarMessage(vscode.l10n.t('No change markers in columns 1-5.'), 3000); return; }
  await replaceLines(ed, r, res.lines);
  vscode.window.setStatusBarMessage(vscode.l10n.t('Columns 1-5 cleared on {0} line(s).', res.changed), 4000);
}

async function goProcedure(dir: 1 | -1): Promise<void> {
  const ed = vscode.window.activeTextEditor; if (!ed || ed.document.languageId !== 'rpgle') { return; }
  const starts = procedureStarts(ed.document.getText());
  const cur = ed.selection.active.line;
  const to = dir > 0 ? starts.find(s => s > cur) : [...starts].reverse().find(s => s < cur);
  if (to === undefined) { vscode.window.setStatusBarMessage(dir > 0 ? vscode.l10n.t('No procedure below.') : vscode.l10n.t('No procedure above.'), 2000); return; }
  const pos = new vscode.Position(to, ed.document.lineAt(to).firstNonWhitespaceCharacterIndex);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
}

async function headerCommand(): Promise<void> {
  const ed = requireRpg(); if (!ed) { return; }
  const text = ed.document.getText();
  const p = parsed(ed.document).procedures.find(x => ed.selection.active.line >= x.start && ed.selection.active.line <= x.end)
    ?? parsed(ed.document).procedures.find(x => x.start > ed.selection.active.line);
  if (!p) { vscode.window.showInformationMessage(vscode.l10n.t('Put the cursor in a procedure.')); return; }
  const sig = signatures(ed.document).find(s => s.name.toUpperCase() === p.name.toUpperCase());
  const indent = /^\s*/.exec(ed.document.lineAt(p.start).text)![0];
  await ed.insertSnippet(new vscode.SnippetString(procedureHeader(p.name, sig?.params ?? [], sig?.returns ?? '', indent)), new vscode.Position(p.start, 0));
}

async function formatSqlCommand(uri?: vscode.Uri, line?: number): Promise<void> {
  const ed = vscode.window.activeTextEditor; if (!ed) { return; }
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : ed.document;
  const at = embeddedSqlAt(doc.getText(), line ?? ed.selection.active.line);
  if (!at) { vscode.window.setStatusBarMessage(vscode.l10n.t('The cursor is not in an EXEC SQL statement.'), 3000); return; }
  const step = ' '.repeat(cfg().get<number>('rpgIndent', 2));
  const body = formatSql(at.sql, step).split('\n').map(l => `${at.indent}${step}${l}`).join('\n');
  // Text after the ";" on the last line (a // comment, another statement) is kept.
  const last = doc.lineAt(at.end).text; const semi = maskLine(last, true).lastIndexOf(';');
  const rest = semi >= 0 ? last.slice(semi + 1).trimEnd() : '';
  const range = new vscode.Range(at.start, 0, at.end, last.length);
  const next = `${at.indent}exec sql\n${body};${rest}`;
  if (doc.getText(range) === next) { vscode.window.setStatusBarMessage(vscode.l10n.t('The SQL is already formatted.'), 2000); return; }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, range, next);
  await vscode.workspace.applyEdit(edit);
}

async function ibmDocs(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const w = ed ? ed.document.getText(ed.document.getWordRangeAtPosition(ed.selection.active, /%?[A-Za-z][\w-]*/)) : '';
  const q = (await vscode.window.showInputBox({ title: vscode.l10n.t('IBM documentation for'), value: w, prompt: vscode.l10n.t('An operation code, a built-in function, a keyword or a message ID') }))?.trim();
  if (!q) { return; }
  const release = cfg().get<string>('docsRelease', '7.5');
  await vscode.env.openExternal(vscode.Uri.parse(`https://www.ibm.com/docs/en/i/${encodeURIComponent(release)}?topic=&q=${encodeURIComponent(`RPG ${q}`)}`));
}

async function addPrototype(manager: ConnectionManager, uri: vscode.Uri, name: string): Promise<void> {
  const conn = manager.require();
  const doc = await vscode.workspace.openTextDocument(uri);
  if (parsed(doc).definitions.some(d => d.kind === 'prototype' && d.upper === name.toUpperCase())) { vscode.window.showInformationMessage(vscode.l10n.t('{0} already has a prototype in this source.', name)); return; }
  const { docs, types } = await docsArray(conn.profile.id);
  const defs = procedureDefinitions(docs, name);
  if (!defs.length) { vscode.window.showWarningMessage(vscode.l10n.t('{0} is not defined in the indexed sources. Index the library of its service program first.', name)); return; }
  const src = docs.find(d => d[0] === defs[0].key)![1];
  const pr = prototypeFrom(src, name);
  if (!pr) { return; }
  // After the last DCL-PR / DCL-C / DCL-S of the main part, else after CTL-OPT.
  const parse = parsed(doc);
  const firstProc = parse.procedures[0]?.start ?? doc.lineCount;
  let at = 0;
  for (let i = 0; i < firstProc; i++) { if (/^\s*(ctl-opt|dcl-[scf]\b|end-pr|end-ds|\/copy|\/include)/i.test(doc.lineAt(i).text) || /^\s*\*\*free/i.test(doc.lineAt(i).text)) { at = i + 1; } }
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(at, 0), `\n// From ${defs[0].key} (${types.get(defs[0].key) ?? ''})\n${pr}`);
  await vscode.workspace.applyEdit(edit);
}

// ---------------------------------------------------------------- quick fixes for the checks

class CheckFixes implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    try { return this.actions(doc, ctx); } catch (e) { logError(e); return []; }
  }
  private actions(doc: vscode.TextDocument, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    const fix = (title: string, d: vscode.Diagnostic, edit?: vscode.WorkspaceEdit, command?: vscode.Command, preferred = false) => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.diagnostics = [d]; if (edit) { a.edit = edit; } if (command) { a.command = command; } a.isPreferred = preferred; out.push(a);
    };
    for (const d of ctx.diagnostics.filter(x => x.source === 'Vanthrex')) {
      const line = doc.lineAt(d.range.start.line);
      const ind = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
      const step = ' '.repeat(cfg().get<number>('rpgIndent', 2));
      const e = new vscode.WorkspaceEdit();
      switch (String(d.code)) {
        case 'missing-const': e.insert(doc.uri, line.range.end.translate(0, -(line.text.length - line.text.replace(/;\s*(\/\/.*)?$/, '').length)), ' const'); fix(vscode.l10n.t('Add CONST'), d, e, undefined, true); break;
        case 'dsply': case 'unreachable-code': e.delete(doc.uri, line.rangeIncludingLineBreak); fix(String(d.code) === 'dsply' ? vscode.l10n.t('Remove the DSPLY') : vscode.l10n.t('Remove the statement that never runs'), d, e); break;
        case 'missing-ctl-opt': {
          const at = /^\s*\*\*free/i.test(doc.lineAt(0).text) ? 1 : 0;
          e.insert(doc.uri, new vscode.Position(at, 0), "ctl-opt dftactgrp(*no) actgrp(*new) option(*srcstmt: *nodebugio) bnddir('QC2LE');\n");
          fix(vscode.l10n.t('Add CTL-OPT DFTACTGRP(*NO) ACTGRP(*NEW) OPTION(*SRCSTMT: *NODEBUGIO)'), d, e, undefined, true); break;
        }
        case 'chain-without-found': {
          const file = /chain\s*(?:\([^)]*\))?\s*(?:\([^)]*\)|[\w$#@]+)\s+([\w$#@]+)/i.exec(line.text)?.[1] ?? '';
          e.insert(doc.uri, line.range.end, `\n${ind}if not %found(${file});\n${ind}${step}// not found\n${ind}endif;`);
          fix(vscode.l10n.t('Add an IF NOT %FOUND test'), d, e, undefined, true); break;
        }
        case 'unchecked-sql': {
          let end = line.lineNumber; while (end < doc.lineCount - 1 && !doc.lineAt(end).text.includes(';')) { end++; }
          e.insert(doc.uri, doc.lineAt(end).range.end, `\n${ind}if sqlcode < 0;\n${ind}${step}// handle the SQL error (SQLSTATE in sqlstate)\n${ind}endif;`);
          fix(vscode.l10n.t('Add an SQLCODE test'), d, e, undefined, true); break;
        }
        case 'select-without-other': {
          let depth = 0;
          for (let i = line.lineNumber; i < doc.lineCount; i++) {
            const t = doc.lineAt(i).text;
            if (/^\s*select\s*;/i.test(t)) { depth++; }
            if (/^\s*endsl\s*;/i.test(t)) { depth--; if (!depth) { e.insert(doc.uri, new vscode.Position(i, 0), `${ind}${step}other;\n${ind}${step}${step}// none of the cases\n`); break; } }
          }
          fix(vscode.l10n.t('Add OTHER'), d, e); break;
        }
        case 'code-past-column-80': fix(vscode.l10n.t('Wrap the line before column 80'), d, undefined, { command: 'vanthrex.rpg.wrapLine', title: '', arguments: [doc.uri, line.lineNumber] }, true); break;
        case 'deprecated-opcode': {
          try {
            const free = convertFixedToFree([line.text]).lines;
            if (free.length && !free.some(l => /\bTODO\b/.test(l)) && free.join('') !== line.text) { e.replace(doc.uri, line.range, free.join('\n')); fix(vscode.l10n.t('Convert this line to free form'), d, e, undefined, true); }
          } catch { /* not convertible alone */ }
          break;
        }
        default: break;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- providers

class RefactorActions implements vscode.CodeActionProvider {
  constructor(private readonly manager: ConnectionManager) {}
  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    try { return this.actions(doc, range); } catch (e) { logError(e); return []; }
  }
  private actions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    const cmd = (title: string, command: string, kind: vscode.CodeActionKind, args: unknown[] = []) => { const a = new vscode.CodeAction(title, kind); a.command = { command, title, arguments: args }; out.push(a); };
    if (!range.isEmpty && range.end.line > range.start.line) {
      cmd(vscode.l10n.t('Surround With…'), 'vanthrex.rpg.surround', vscode.CodeActionKind.RefactorRewrite);
      if (/^\s*if\b/i.test(doc.lineAt(range.start.line).text)) { cmd(vscode.l10n.t('Convert IF / ELSEIF to SELECT / WHEN'), 'vanthrex.rpg.ifToSelect', vscode.CodeActionKind.RefactorRewrite); }
      const sel = doc.getText(range);
      if (/^\s*dcl-[sc]\b/im.test(sel)) { cmd(vscode.l10n.t('Align the declarations'), 'vanthrex.rpg.alignDeclarations', vscode.CodeActionKind.RefactorRewrite); cmd(vscode.l10n.t('Sort the declarations by name'), 'vanthrex.rpg.sortDeclarations', vscode.CodeActionKind.RefactorRewrite); }
    }
    if (embeddedSqlAt(factsOf(doc).text, range.start.line)) { cmd(vscode.l10n.t('Format the embedded SQL'), 'vanthrex.rpg.formatEmbeddedSql', vscode.CodeActionKind.RefactorRewrite, [doc.uri, range.start.line]); }
    if (doc.lineAt(range.start.line).text.length > (fullyFreeOf(doc) ? cfg().get<number>('wrapColumn', 100) : 80)) { cmd(vscode.l10n.t('Wrap the long line'), 'vanthrex.rpg.wrapLine', vscode.CodeActionKind.RefactorRewrite, [doc.uri, range.start.line]); }
    // A call of a procedure that is neither declared nor prototyped here: take its prototype from the source index.
    const w = doc.getWordRangeAtPosition(range.start, /[A-Za-z$#@_][\w$#@]*/);
    if (w && this.manager.connection) {
      const name = doc.getText(w);
      const after = doc.lineAt(w.start.line).text.slice(w.end.character);
      if (/^\s*\(/.test(after) && !parsed(doc).definitions.some(d => d.upper === name.toUpperCase()) && !/^%/.test(doc.lineAt(w.start.line).text[w.start.character - 1] ?? '')) {
        cmd(vscode.l10n.t('Add the prototype (DCL-PR) of {0} from the source index', name), 'vanthrex.rpg.addPrototype', vscode.CodeActionKind.QuickFix, [doc.uri, name]);
      }
    }
    return out;
  }
}

function selectionRanges(doc: vscode.TextDocument, positions: vscode.Position[]): vscode.SelectionRange[] {
  const groups = blockGroups(doc.getText(), doc.languageId === 'cl' ? 'cl' : 'rpgle').map(g => ({ start: g.lines[0], end: g.lines[g.lines.length - 1] })).filter(g => g.end > g.start);
  const procs = doc.languageId === 'rpgle' ? parsed(doc).procedures : [];
  return positions.map(pos => {
    const word = doc.getWordRangeAtPosition(pos, /[%A-Za-z$#@_][\w$#@-]*/);
    const spans = [...groups, ...procs].filter(g => pos.line >= g.start && pos.line <= g.end).sort((a, b) => (a.end - a.start) - (b.end - b.start));
    const full = new vscode.SelectionRange(new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length));
    let parent: vscode.SelectionRange = full;
    for (const g of spans.reverse()) { parent = new vscode.SelectionRange(new vscode.Range(g.start, 0, g.end, doc.lineAt(g.end).text.length), parent); }
    const line = doc.lineAt(pos.line);
    parent = new vscode.SelectionRange(new vscode.Range(pos.line, line.firstNonWhitespaceCharacterIndex, pos.line, line.text.length), parent);
    return word ? new vscode.SelectionRange(word, parent) : parent;
  });
}

function inlayHints(doc: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
  if (!cfg().get<boolean>('parameterNameHints', true) || doc.lineCount > BIG) { return []; }
  const sigs = new Map(signatures(doc).filter(s => s.params.length > 1).map(s => [s.name.toUpperCase(), s.params.map(p => p.name)]));
  if (!sigs.size) { return []; }
  const out: vscode.InlayHint[] = [];
  for (let i = range.start.line; i <= Math.min(range.end.line, doc.lineCount - 1); i++) {
    const t = doc.lineAt(i).text;
    if (/^\s*(dcl-p[ri]|dcl-proc)\b/i.test(t)) { continue; }
    for (const h of callArgumentHints(t, sigs)) {
      const hint = new vscode.InlayHint(new vscode.Position(i, h.at), `${h.name}:`, vscode.InlayHintKind.Parameter);
      hint.paddingRight = true; out.push(hint);
    }
  }
  return out;
}

function referenceLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
  if (!cfg().get<boolean>('referenceCodeLens', false) || doc.lineCount > BIG) { return []; }
  const text = doc.getText();
  const p = parsed(doc);
  const lenses: vscode.CodeLens[] = [];
  const add = (name: string, line: number, col: number, excl: number[]) => {
    const refs = findOccurrences(text, name).filter(o => !excl.includes(o.line));
    const pos = new vscode.Position(line, col);
    lenses.push(new vscode.CodeLens(new vscode.Range(pos, pos), { title: refs.length === 1 ? vscode.l10n.t('1 reference') : vscode.l10n.t('{0} references', refs.length), command: refs.length ? 'editor.action.showReferences' : '',
      arguments: [doc.uri, pos, refs.map(o => new vscode.Location(doc.uri, new vscode.Range(o.line, o.start, o.line, o.end)))] }));
  };
  for (const proc of p.procedures) {
    const ends = [proc.start, ...p.definitions.filter(d => d.kind === 'prototype' && d.upper === proc.name.toUpperCase()).map(d => d.line)];
    const endLine = proc.end;
    add(proc.name, proc.start, 0, [...ends, endLine]);
  }
  for (const d of p.definitions.filter(x => x.kind === 'subroutine')) { add(d.name, d.line, 0, [d.line]); }
  return lenses;
}

// Call hierarchy inside the source: procedures and subroutines.
interface Unit { name: string; start: number; end: number; kind: vscode.SymbolKind }
function units(doc: vscode.TextDocument): Unit[] {
  const f = factsOf(doc); if (f.units) { return f.units; }
  const p = parsed(doc);
  const lines = doc.getText().split(/\r?\n/);
  const subs: Unit[] = [];
  for (const d of p.definitions.filter(x => x.kind === 'subroutine')) {
    let e = d.line; while (e < lines.length - 1 && !/^\s*endsr\b/i.test(lines[e]) && !(/^.{5}[Cc]/.test(lines[e]) && lines[e].substring(25, 35).trim().toUpperCase() === 'ENDSR')) { e++; }
    subs.push({ name: d.name, start: d.line, end: e, kind: vscode.SymbolKind.Event });
  }
  return (f.units = [...p.procedures.map(x => ({ ...x, kind: vscode.SymbolKind.Function })), ...subs]);
}
const item = (doc: vscode.TextDocument, u: Unit) => new vscode.CallHierarchyItem(u.kind, u.name, '', doc.uri, new vscode.Range(u.start, 0, u.end, doc.lineAt(u.end).text.length), new vscode.Range(u.start, 0, u.start, doc.lineAt(u.start).text.length));
const callsIn = (text: string, u: Unit, name: string) => findOccurrences(text, name).filter(o => o.line > u.start && o.line <= u.end && o.line !== u.start);

class CallHierarchy implements vscode.CallHierarchyProvider {
  prepareCallHierarchy(doc: vscode.TextDocument, pos: vscode.Position): vscode.CallHierarchyItem | undefined {
    try { return this.prepare(doc, pos); } catch (e) { logError(e); return undefined; }
  }
  private prepare(doc: vscode.TextDocument, pos: vscode.Position): vscode.CallHierarchyItem | undefined {
    const w = doc.getWordRangeAtPosition(pos, /[A-Za-z$#@_][\w$#@]*/);
    const us = units(doc);
    const byName = w ? us.find(u => u.name.toUpperCase() === doc.getText(w).toUpperCase()) : undefined;
    const u = byName ?? us.find(x => pos.line >= x.start && pos.line <= x.end);
    return u ? item(doc, u) : undefined;
  }
  async provideCallHierarchyIncomingCalls(it: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyIncomingCall[]> {
    const doc = await vscode.workspace.openTextDocument(it.uri);
    const text = doc.getText(); const us = units(doc);
    const out: vscode.CallHierarchyIncomingCall[] = [];
    const main: Unit = { name: vscode.l10n.t('(main)'), start: 0, end: doc.lineCount - 1, kind: vscode.SymbolKind.Module };
    const refs = findOccurrences(text, it.name).filter(o => o.line !== it.selectionRange.start.line && !/^\s*(dcl-pr|end-proc|dcl-proc|begsr)\b/i.test(doc.lineAt(o.line).text));
    const groups = new Map<Unit, vscode.Range[]>();
    for (const r of refs) { const u = us.find(x => r.line > x.start && r.line <= x.end) ?? main; groups.set(u, [...(groups.get(u) ?? []), new vscode.Range(r.line, r.start, r.line, r.end)]); }
    for (const [u, rs] of groups) { out.push(new vscode.CallHierarchyIncomingCall(u === main ? new vscode.CallHierarchyItem(main.kind, main.name, '', doc.uri, new vscode.Range(0, 0, 0, 0), new vscode.Range(0, 0, 0, 0)) : item(doc, u), rs)); }
    return out;
  }
  async provideCallHierarchyOutgoingCalls(it: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyOutgoingCall[]> {
    const doc = await vscode.workspace.openTextDocument(it.uri);
    const text = doc.getText(); const us = units(doc);
    const me: Unit = { name: it.name, start: it.range.start.line, end: it.range.end.line, kind: it.kind };
    return us.filter(u => u.name !== it.name).map(u => ({ u, rs: callsIn(text, me, u.name) })).filter(x => x.rs.length)
      .map(x => new vscode.CallHierarchyOutgoingCall(item(doc, x.u), x.rs.map(o => new vscode.Range(o.line, o.start, o.line, o.end))));
  }
}

async function workspaceSymbols(manager: ConnectionManager, query: string, token?: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
  const conn = manager.connection;
  if (!conn || query.length < 2) { return []; }
  let index: Awaited<ReturnType<typeof docsArray>>;
  try { index = await docsArray(conn.profile.id); } catch (e) { logError(e); return []; }
  if (token?.isCancellationRequested) { return []; }
  const { docs, types } = index;
  const q = query.toUpperCase();
  const out: vscode.SymbolInformation[] = [];
  const re = /^\s*(dcl-proc|dcl-pr|dcl-ds|begsr)\s+([A-Za-z$#@_][\w$#@]*)/i;
  for (const [key, text] of docs) {
    if (token?.isCancellationRequested) { return out; }
    if (!text.toUpperCase().includes(q)) { continue; }
    const [lib, file, member] = key.split('/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m || !m[2].toUpperCase().includes(q)) { continue; }
      const kind = /proc/i.test(m[1]) ? vscode.SymbolKind.Function : /pr$/i.test(m[1]) ? vscode.SymbolKind.Interface : /ds/i.test(m[1]) ? vscode.SymbolKind.Struct : vscode.SymbolKind.Event;
      out.push(new vscode.SymbolInformation(m[2], kind, `${lib}/${file}(${member})`, new vscode.Location(memberUri(lib, file, member, types.get(key) || 'rpgle'), new vscode.Position(i, 0))));
      if (out.length >= 300) { return out; }
    }
  }
  return out;
}

class LocalCompletion implements vscode.CompletionItemProvider {
  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    try { return this.items(doc, pos); } catch (e) { logError(e); return []; }
  }
  private items(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    if (!cfg().get<boolean>('localCompletion', true)) { return []; }
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (/%[A-Za-z]*$/.test(before) || /'[^']*$/.test(before.replace(/'[^']*'/g, '')) || /\/\//.test(before)) { return []; }
    const p = parsed(doc);
    const sigs = new Map(signatures(doc).map(s => [s.name.toUpperCase(), s]));
    const proc = p.procedures.find(x => pos.line >= x.start && pos.line <= x.end)?.name;
    const exsr = /\bexsr\s+[\w$#@]*$/i.test(before);
    const KIND: Record<string, vscode.CompletionItemKind> = { variable: vscode.CompletionItemKind.Variable, constant: vscode.CompletionItemKind.Constant, ds: vscode.CompletionItemKind.Struct, subfield: vscode.CompletionItemKind.Field,
      prototype: vscode.CompletionItemKind.Function, procedure: vscode.CompletionItemKind.Function, file: vscode.CompletionItemKind.File, subroutine: vscode.CompletionItemKind.Event, parameter: vscode.CompletionItemKind.Variable, enum: vscode.CompletionItemKind.Enum };
    const seen = new Set<string>(); const out: vscode.CompletionItem[] = [];
    for (const d of p.definitions) {
      if (d.procedure && d.procedure !== proc) { continue; }
      if (exsr !== (d.kind === 'subroutine')) { continue; }
      const k = `${d.kind}|${d.upper}`; if (seen.has(k)) { continue; } seen.add(k);
      const it = new vscode.CompletionItem(d.name, KIND[d.kind] ?? vscode.CompletionItemKind.Text);
      it.detail = `${d.kind}${d.parent ? ` of ${d.parent}` : ''} · ${d.detail}`.slice(0, 120);
      const sig = sigs.get(d.upper);
      if ((d.kind === 'prototype' || d.kind === 'procedure') && sig) { it.insertText = new vscode.SnippetString(callSnippet(d.name, sig.params)); it.detail = `${d.name}(${sig.params.map(x => `${x.name} ${x.definition}`).join(': ')})${sig.returns ? ' → ' + sig.returns : ''}`.slice(0, 200); }
      it.sortText = `0${d.procedure ? 0 : 1}${d.name}`;
      out.push(it);
    }
    return out;
  }
}

function copyHover(copies: CopyResolver, doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> | undefined {
  const c = parsed(doc).copies.find(x => x.line === pos.line);
  if (!c || pos.character < c.start - 8) { return undefined; }
  return (async () => {
    const uri = await copies.resolve(doc, c);
    if (!uri) { return undefined; }
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const lines = text.split(/\r?\n/);
      const md = new vscode.MarkdownString(`**${uri.path.slice(1)}** · ${lines.length} ${vscode.l10n.t('line(s)')}\n`);
      md.appendCodeblock(lines.slice(0, 30).join('\n') + (lines.length > 30 ? '\n…' : ''), 'rpgle');
      return new vscode.Hover(md, new vscode.Range(pos.line, c.start, pos.line, c.end));
    } catch (e) { logError(e); return undefined; }
  })();
}

// ---------------------------------------------------------------- auto-close, status bar, column highlights

function autoClose(e: vscode.TextDocumentChangeEvent): void {
  if (e.document.languageId !== 'rpgle' || !cfg().get<boolean>('autoCloseBlocks', true) || e.contentChanges.length !== 1) { return; }
  // Undo / redo replay old edits: never add a block end then.
  if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) { return; }
  const ch = e.contentChanges[0];
  if (!/^\r?\n\s*$/.test(ch.text) || !ch.range.isEmpty) { return; }
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document !== e.document || ed.selections.length !== 1 || e.document.lineCount > BIG) { return; }
  const version = e.document.version;
  const line = ch.range.start.line;
  const c = autoCloseFor(e.document.getText(), line);
  if (!c) { return; }
  const next = line + 1;
  const step = ' '.repeat(cfg().get<number>('rpgIndent', 2));
  setTimeout(() => {
    // Only if nothing else changed meanwhile and the new line is still empty.
    if (ed.document.version !== version || next >= ed.document.lineCount || ed.document.lineAt(next).text.trim()) { return; }
    void ed.edit(b => {
      const cur = ed.document.lineAt(next);
      b.replace(cur.range, `${c.indent}${step}\n${c.indent}${c.close}`);
    }, { undoStopBefore: false, undoStopAfter: true }).then(() => {
      const p = new vscode.Position(next, c.indent.length + step.length);
      ed.selection = new vscode.Selection(p, p);
    });
  }, 0);
}

const columnDecoration = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), borderRadius: '2px' });
const columnAlt = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'), borderRadius: '2px' });

function highlightColumns(ed: vscode.TextEditor | undefined): void {
  if (!ed) { return; }
  if (!['rpgle', 'dds'].includes(ed.document.languageId) || !cfg().get<boolean>('fixedColumnHighlight', true)) { ed.setDecorations(columnDecoration, []); ed.setDecorations(columnAlt, []); return; }
  const line = ed.selection.active.line;
  const text = ed.document.lineAt(line).text;
  const layout = text.length > 6 && text[6] !== '*' ? layoutFor(text.padEnd(7), ed.document.languageId as 'rpgle' | 'dds') : undefined;
  if (!layout || ed.document.lineCount > BIG || (ed.document.languageId === 'rpgle' && fullyFreeOf(ed.document))) { ed.setDecorations(columnDecoration, []); ed.setDecorations(columnAlt, []); return; }
  const a: vscode.DecorationOptions[] = []; const b: vscode.DecorationOptions[] = [];
  layout.fields.forEach((f, i) => {
    if (f.from - 1 >= text.length) { return; }
    (i % 2 ? b : a).push({ range: new vscode.Range(line, f.from - 1, line, Math.min(f.to, text.length)), hoverMessage: `${f.label} (${f.from}-${f.to})` });
  });
  ed.setDecorations(columnDecoration, a); ed.setDecorations(columnAlt, b);
}

export function registerRpgProductivity(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  const copies = new CopyResolver(manager);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  status.command = 'workbench.action.gotoSymbol';
  const updateStatus = (ed?: vscode.TextEditor) => {
    if (!ed || ed.document.languageId !== 'rpgle' || !cfg().get<boolean>('procedureInStatusBar', true)) { status.hide(); return; }
    const line = ed.selection.active.line;
    const inner = units(ed.document).filter(u => line >= u.start && line <= u.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    const p = inner ? (inner.kind === vscode.SymbolKind.Event ? `${inner.name} (${vscode.l10n.t('subroutine')})` : inner.name) : undefined;
    status.text = `$(symbol-method) ${p ?? vscode.l10n.t('main')}`; status.tooltip = vscode.l10n.t('Procedure or subroutine at the cursor — click to go to another one'); status.show();
  };
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    status, columnDecoration, columnAlt,
    vscode.commands.registerCommand('vanthrex.rpg.closeBlock', wrap(closeBlockCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.ifToSelect', wrap(ifToSelectCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.surround', wrap((k?: SurroundKind) => surroundCommand(typeof k === 'string' ? k : undefined))),
    vscode.commands.registerCommand('vanthrex.rpg.toggleComment', wrap(toggleCommentCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.keywordCase', wrap(keywordCaseCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.sortDeclarations', wrap(sortCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.alignDeclarations', wrap(alignCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.wrapLine', wrap((u?: vscode.Uri, l?: number) => wrapCommand(u instanceof vscode.Uri ? u : undefined, typeof l === 'number' ? l : undefined))),
    vscode.commands.registerCommand('vanthrex.rpg.ruler', wrap(rulerCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.clearChangeMarkers', wrap(clearMarkersCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.nextProcedure', wrap(() => goProcedure(1))),
    vscode.commands.registerCommand('vanthrex.rpg.previousProcedure', wrap(() => goProcedure(-1))),
    vscode.commands.registerCommand('vanthrex.rpg.procedureHeader', wrap(headerCommand)),
    vscode.commands.registerCommand('vanthrex.rpg.formatEmbeddedSql', wrap((u?: vscode.Uri, l?: number) => formatSqlCommand(u instanceof vscode.Uri ? u : undefined, typeof l === 'number' ? l : undefined))),
    vscode.commands.registerCommand('vanthrex.rpg.ibmDocs', wrap(ibmDocs)),
    vscode.commands.registerCommand('vanthrex.rpg.addPrototype', wrap((u: vscode.Uri, n: string) => addPrototype(manager, u, n))),
    vscode.languages.registerCodeActionsProvider(RPG, new CheckFixes(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCodeActionsProvider(RPG, new RefactorActions(manager), { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerSelectionRangeProvider([{ language: 'rpgle' }, { language: 'cl' }], { provideSelectionRanges: guard([], selectionRanges) }),
    vscode.languages.registerInlayHintsProvider(RPG, { provideInlayHints: guard([], inlayHints) }),
    vscode.languages.registerCodeLensProvider(RPG, { provideCodeLenses: guard([], referenceLenses) }),
    vscode.languages.registerCallHierarchyProvider(RPG, new CallHierarchy()),
    vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: (q, t) => workspaceSymbols(manager, q, t) }),
    vscode.languages.registerCompletionItemProvider(RPG, new LocalCompletion()),
    vscode.languages.registerHoverProvider(RPG, { provideHover: guard(undefined, (d: vscode.TextDocument, p: vscode.Position) => copyHover(copies, d, p)) }),
    vscode.workspace.onDidChangeTextDocument(guard(undefined, autoClose)),
    vscode.workspace.onDidCloseTextDocument(d => facts.delete(d.uri.toString())),
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(guard(undefined, () => { updateStatus(e.textEditor); highlightColumns(e.textEditor); }), 150);
    }),
    vscode.window.onDidChangeActiveTextEditor(guard(undefined, (ed?: vscode.TextEditor) => { updateStatus(ed); highlightColumns(ed); })),
  );
  updateStatus(vscode.window.activeTextEditor);
}
