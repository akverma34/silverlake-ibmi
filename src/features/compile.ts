import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError, showLog } from '../core/log';
import { parseEvfEvent, parseQsysPath, EvfError } from '../core/evfevent';
import { objectNameFromFile, parseMemberPath, substituteVariables, CompileVariables } from '../core/util';
import { IFS_SCHEME, MEMBER_SCHEME, ifsUri, memberUri } from './fileSystems';
import { localRelFor } from '../core/localDev';
import {
  actionEnvironment, CompileAction, contextVariables, gitBranch, ifsVariables, memberVariables, objectActionsFor, objectVariables, shellCommand,
  sourceActionsFor, unresolvedVariables,
} from '../core/actions';
import { convertActions } from '../core/migration';
import type { IbmiConnection } from '../core/connection';

export type { CompileAction } from '../core/actions';

/** Result of an action, whatever environment it ran in. */
interface ActionResult { ok: boolean; messages: string[]; stdout: string; stderr: string }

/** The branch of the Git repository a file is in (or of the first workspace folder), read from .git/HEAD. */
async function currentBranch(uri?: vscode.Uri): Promise<string | undefined> {
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) { return undefined; }
  try { return gitBranch(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.git', 'HEAD')))); }
  catch { return undefined; }
}

/** Actions of the workspace's .vscode/actions.json (Code for IBM i format), used as they are. */
async function workspaceActions(customNames: string[]): Promise<CompileAction[]> {
  const out: CompileAction[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try {
      const json = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(f.uri, '.vscode', 'actions.json'))));
      for (const a of convertActions(json, customNames)) {
        if (!a.skipped) { out.push({ name: a.name, command: a.command, extensions: a.extensions, source: a.source, environment: a.environment }); }
      }
    } catch { /* no actions.json, or not JSON */ }
  }
  return out;
}

/** All compile actions: the vanthrex.compileActions setting, then the workspace actions.json (same names are not repeated). */
export async function allActions(conn: IbmiConnection): Promise<CompileAction[]> {
  const mine = vscode.workspace.getConfiguration('vanthrex').get<CompileAction[]>('compileActions', []);
  const ws = await workspaceActions(Object.keys(conn.profile.variables ?? {}));
  return [...mine, ...ws.filter(w => !mine.some(m => m.name === w.name))];
}

/** Connection variables (host, home, library list, branch, custom variables) for an action. */
export async function connectionVariables(conn: IbmiConnection, uri?: vscode.Uri, workDir?: string): Promise<Record<string, string>> {
  return contextVariables({
    host: conn.profile.host, user: conn.user, home: conn.profile.ifsHome || conn.homeDirectory, libraries: conn.profile.libraries,
    currentLibrary: conn.profile.currentLibrary, branch: await currentBranch(uri), workDir, custom: conn.profile.variables,
  });
}

/** Runs an action in its environment: a CL command, or a shell command (PASE / QShell) in a folder. */
export async function runAction(conn: IbmiConnection, action: CompileAction, command: string, workDir: string): Promise<ActionResult> {
  const env = actionEnvironment(action);
  if (env === 'ile') { const r = await conn.runCL(command); return { ok: r.ok, messages: r.messages, stdout: r.stdout, stderr: r.stderr }; }
  const r = await conn.exec(shellCommand(env, command, workDir));
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.stdout.trim() || r.stderr.trim()) { log(`${action.name} (${env.toUpperCase()}):\n${out.trim()}`); }
  return { ok: r.code === 0, messages: [...new Set(out.match(/\b[A-Z]{3}[0-9A-F]{4}\b/g) ?? [])], stdout: r.stdout, stderr: r.stderr };
}

const LAST_ACTION_KEY = 'vanthrex.lastCompileAction';

/** A local file compiled from its copy in the IFS deploy folder: errors are shown on the local files. */
export interface LocalTarget { uri: vscode.Uri; root: vscode.Uri; dir: string }

export class Compiler {
  readonly diagnostics = vscode.languages.createDiagnosticCollection('IBM i');

  constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {}

  async compile(target?: vscode.Uri | { resourceUri?: vscode.Uri; path?: string; kind?: string }, alwaysAsk = false, local?: LocalTarget): Promise<void> {
    const uri = this.resolveUri(target);
    if (!uri) {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a source member or IFS source file to compile.'));
      return;
    }
    if (uri.scheme === 'file' && !local) {
      // A local (Git) file: deploy it to the IFS and compile it there.
      await vscode.commands.executeCommand('vanthrex.compileLocal', uri, alwaysAsk);
      return;
    }
    if (uri.scheme !== MEMBER_SCHEME && uri.scheme !== IFS_SCHEME) {
      vscode.window.showWarningMessage(vscode.l10n.t('Compile works on members and IFS files opened from the Vanthrex views.'));
      return;
    }
    const conn = this.manager.require();

    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (doc?.isDirty) { await doc.save(); }

    const isMember = uri.scheme === MEMBER_SCHEME;
    // The folder PASE and QShell actions run in: the deploy folder of a local file, the folder of an IFS file, else home.
    const workDir = local?.dir ?? (isMember ? (conn.profile.ifsHome || conn.homeDirectory) : uri.path.replace(/\/[^/]*$/, '') || '/');
    const vars: CompileVariables & Record<string, string | undefined> = { ...(await connectionVariables(conn, local?.uri ?? uri, workDir)) };
    let ext: string;
    if (isMember) {
      const m = parseMemberPath(uri.path);
      ext = m.extension;
      Object.assign(vars, memberVariables(m.library, m.file, m.member, ext), {
        OBJLIB: conn.profile.objectLibrary || m.library,
      });
    } else {
      const fileName = uri.path.split('/').pop() ?? '';
      ext = (fileName.split('.').pop() ?? '').toLowerCase();
      Object.assign(vars, ifsVariables(uri.path, local ? vscode.workspace.asRelativePath(local.uri, false) : undefined), {
        NAME: objectNameFromFile(fileName), EXT: ext,
        OBJLIB: conn.profile.objectLibrary || conn.profile.currentLibrary || 'QGPL',
        LIB: conn.profile.currentLibrary || 'QGPL', LIBRARY: conn.profile.currentLibrary || 'QGPL',
      });
    }
    vars.BUILDLIB = vars.OBJLIB;

    const action = await this.pickAction(conn, ext, isMember ? 'member' : local ? 'local' : 'ifs', alwaysAsk);
    if (!action) { return; }
    const command = substituteVariables(action.command, vars);
    const missing = unresolvedVariables(command);
    if (missing.length) { throw new Error(vscode.l10n.t('{0} has no value here: {1}', missing.join(', '), command)); }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Compiling {0}…', String(vars.NAME)), cancellable: false },
      () => runAction(conn, action, command, workDir));

    // Collect inline errors from the events file when the compiler wrote one.
    let errors: EvfError[] = [];
    if (/\*EVENTF/i.test(command) && vars.OBJLIB && vars.NAME) {
      try {
        const evf = await conn.readMember(vars.OBJLIB, 'EVFEVENT', vars.NAME);
        errors = parseEvfEvent(evf);
      } catch (e) {
        log(`No events file found for ${vars.OBJLIB}/${vars.NAME}: ${errorMessage(e)}`);
      }
    }
    this.publish(local?.uri ?? uri, ext, errors, local);

    const errorCount = errors.filter(e => e.severity >= 30).length;
    const warnCount = errors.filter(e => e.severity >= 20 && e.severity < 30).length;
    compileFinished.fire({
      uri: local?.uri ?? uri, name: isMember ? `${vars.LIB}/${vars.SRCFILE}(${vars.NAME})` : (local ? vscode.workspace.asRelativePath(local.uri) : uri.path), object: `${vars.OBJLIB}/${vars.NAME}`, ok: result.ok,
      errors: errorCount, warnings: warnCount, command, message: result.ok ? undefined : (result.messages.slice(-1)[0] ?? ''), system: conn.profile.name,
    });
    if (result.ok) {
      const extra = warnCount ? ` with ${warnCount} warning(s)` : '';
      vscode.window.showInformationMessage(vscode.l10n.t('✔ {0} compiled into {1}{2}.', String(vars.NAME), String(vars.OBJLIB), extra),
        ...(warnCount ? ['Show Problems'] : []))
        .then(c => { if (c) { vscode.commands.executeCommand('workbench.actions.view.problems'); } });
    } else {
      const summary = errorCount ? `${errorCount} error(s)` : (result.messages.slice(-1)[0] ?? 'see log');
      // Not awaited: a batch (PDM option 14, compile on save) must not stop until someone closes the message.
      const ai = errorCount > 0 && vscode.workspace.getConfiguration('vanthrex').get<boolean>('ai.enabled', true);
      void vscode.window.showErrorMessage(vscode.l10n.t('✖ {0} failed to compile: {1}.', String(vars.NAME), summary),
        vscode.l10n.t('Show Problems'), ...(ai ? [vscode.l10n.t('Explain with AI')] : []), vscode.l10n.t('Show Log')).then(choice => {
        if (choice === vscode.l10n.t('Show Problems')) { vscode.commands.executeCommand('workbench.actions.view.problems'); }
        if (choice === vscode.l10n.t('Explain with AI')) { vscode.commands.executeCommand('vanthrex.ai.errors', local?.uri ?? uri); }
        if (choice === vscode.l10n.t('Show Log')) { showLog(); }
      });
    }
  }

  private resolveUri(target?: vscode.Uri | { resourceUri?: vscode.Uri; path?: string; kind?: string }): vscode.Uri | undefined {
    if (target instanceof vscode.Uri) { return target; }
    if (target && 'resourceUri' in target && target.resourceUri instanceof vscode.Uri) { return target.resourceUri; }
    if (target && 'kind' in target && target.kind === 'member') {
      const m = target as unknown as { library: string; file: string; member: string; type: string };
      return memberUri(m.library, m.file, m.member, m.type);
    }
    if (target && 'path' in target && typeof target.path === 'string' && !('kind' in target)) {
      return ifsUri(target.path);
    }
    return vscode.window.activeTextEditor?.document.uri;
  }

  /** Runs an object action (Code for IBM i "type": "object") on an object of the Libraries view. */
  async runObjectAction(o: { library: string; name: string; type: string; attribute?: string }): Promise<void> {
    const conn = this.manager.require();
    const list = objectActionsFor(await allActions(conn), o.type, o.attribute ?? '');
    if (!list.length) {
      const choice = await vscode.window.showWarningMessage(vscode.l10n.t('No action is defined for {0} objects. Add one to vanthrex.compileActions with "source": "object".', o.type), vscode.l10n.t('Open Settings'));
      if (choice) { void vscode.commands.executeCommand('workbench.action.openSettings', 'vanthrex.compileActions'); }
      return;
    }
    const pick = list.length === 1 ? { action: list[0] } : await vscode.window.showQuickPick(list.map(a => ({ label: a.name, detail: a.command, action: a })), { title: `${o.library}/${o.name} ${o.type}` });
    if (!pick) { return; }
    const workDir = conn.profile.ifsHome || conn.homeDirectory;
    const vars: Record<string, string | undefined> = { ...(await connectionVariables(conn, undefined, workDir)), ...objectVariables(o.library, o.name, o.type, o.attribute ?? '') };
    vars.OBJLIB = o.library; vars.BUILDLIB = o.library;
    const command = substituteVariables(pick.action.command, vars);
    const missing = unresolvedVariables(command);
    if (missing.length) { throw new Error(vscode.l10n.t('{0} has no value here: {1}', missing.join(', '), command)); }
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${pick.action.name}: ${o.library}/${o.name}` }, () => runAction(conn, pick.action, command, workDir));
    if (r.ok) { vscode.window.showInformationMessage(vscode.l10n.t('✔ {0} ran on {1}.', pick.action.name, `${o.library}/${o.name}`)); }
    else {
      void vscode.window.showErrorMessage(vscode.l10n.t('✖ {0} failed on {1}: {2}', pick.action.name, `${o.library}/${o.name}`, r.messages.slice(-1)[0] ?? (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''), vscode.l10n.t('Show Log'))
        .then(c => { if (c) { showLog(); } });
    }
  }

  private async pickAction(conn: IbmiConnection, ext: string, source: 'member' | 'ifs' | 'local', alwaysAsk: boolean): Promise<CompileAction | undefined> {
    const candidates = sourceActionsFor(await allActions(conn), ext, source);
    if (!candidates.length) {
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('No compile action is defined for ".{0}" {1}.', ext, source === 'member' ? 'members' : source === 'local' ? 'local files' : 'IFS files'), vscode.l10n.t('Open Settings'));
      if (choice) { vscode.commands.executeCommand('workbench.action.openSettings', 'vanthrex.compileActions'); }
      return undefined;
    }
    const lastMap = this.state.get<Record<string, string>>(LAST_ACTION_KEY, {});
    const key = `${source === 'local' ? 'ifs' : source}:${ext}`;
    if (!alwaysAsk) {
      if (candidates.length === 1) { return candidates[0]; }
      const last = candidates.find(c => c.name === lastMap[key]);
      if (last) { return last; }
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map(a => ({ label: a.name, description: a.source === 'local' ? vscode.l10n.t('local file') : undefined, detail: a.command, action: a })),
      { title: vscode.l10n.t('Compile .{0}', ext), placeHolder: vscode.l10n.t('Choose how to compile (your choice is remembered)') });
    if (!pick) { return undefined; }
    await this.state.update(LAST_ACTION_KEY, { ...lastMap, [key]: pick.action.name });
    return pick.action;
  }

  private publish(sourceUri: vscode.Uri, ext: string, errors: EvfError[], local?: LocalTarget): void {
    this.diagnostics.delete(sourceUri);
    const byUri = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    const add = (uri: vscode.Uri, d: vscode.Diagnostic) => {
      const k = uri.toString();
      if (!byUri.has(k)) { byUri.set(k, { uri, list: [] }); }
      byUri.get(k)!.list.push(d);
    };

    for (const e of errors) {
      if (e.severity === 0 && /^RNF7066|^RNF7086/.test(e.messageId)) { continue; } // "not referenced" noise
      // Unused declarations (RNF7031) are shown faded, with a quick fix to remove them.
      const unused = e.severity === 0 && e.messageId === 'RNF7031';
      let uri = sourceUri;
      let line = Math.max(0, e.line - 1);
      let message = e.message;
      if (e.generated) {
        line = 0;
        message = `${message} (reported on generated source line ${e.line})`;
      } else if (!e.isMainFile && e.file) {
        const m = parseQsysPath(e.file);
        if (m) { uri = memberUri(m.library, m.file, m.member, ext === 'sqlrpgle' ? 'rpgleinc' : ext); }
        else if (e.file.startsWith('/')) {
          const rel = local ? localRelFor(local.dir, e.file) : undefined;
          uri = rel ? vscode.Uri.joinPath(local!.root, ...rel.split('/')) : ifsUri(e.file);
        }
      }
      const startCol = Math.max(0, e.column - 1);
      const endCol = e.endColumn > 0 && e.endLine === e.line ? Math.max(startCol + 1, e.endColumn) : startCol + 1;
      const range = new vscode.Range(line, startCol, Math.max(line, e.generated ? 0 : e.endLine - 1), endCol);
      const d = new vscode.Diagnostic(range, message, toSeverity(e.severity));
      if (unused) { d.severity = vscode.DiagnosticSeverity.Hint; d.tags = [vscode.DiagnosticTag.Unnecessary]; }
      d.code = e.messageId;
      d.source = `IBM i (sev ${e.severity})`;
      add(uri, d);
    }
    for (const { uri, list } of byUri.values()) {
      this.diagnostics.set(uri, list);
    }
  }

  dispose(): void { this.diagnostics.dispose(); }
}

function toSeverity(sev: number): vscode.DiagnosticSeverity {
  if (sev >= 30) { return vscode.DiagnosticSeverity.Error; }
  if (sev >= 20) { return vscode.DiagnosticSeverity.Warning; }
  if (sev >= 10) { return vscode.DiagnosticSeverity.Information; }
  return vscode.DiagnosticSeverity.Hint;
}

/** Fired after every compile (history, PDM, status bar). */
export interface CompileFinished { uri: vscode.Uri; name: string; object: string; ok: boolean; errors: number; warnings: number; command: string; message?: string; system: string }
export const compileFinished = new vscode.EventEmitter<CompileFinished>();

export function registerCompile(context: vscode.ExtensionContext, manager: ConnectionManager): Compiler {
  const compiler = new Compiler(manager, context.globalState);
  const run = (alwaysAsk: boolean) => async (target?: never) => {
    try { await compiler.compile(target, alwaysAsk); }
    catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    compiler,
    vscode.commands.registerCommand('vanthrex.compile', run(false)),
    vscode.commands.registerCommand('vanthrex.compileWith', run(true)),
    vscode.commands.registerCommand('vanthrex.runObjectAction', async (o?: { library: string; name: string; type: string; attribute?: string }) => {
      try { if (o?.library) { await compiler.runObjectAction(o); } else { vscode.window.showInformationMessage(vscode.l10n.t('Right-click an object in the Libraries view to run an action on it.')); } }
      catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
    }),
  );
  return compiler;
}
