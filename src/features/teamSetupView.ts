// Everything in Vanthrex, for one person or a whole team: import the Code for IBM i setup (connections, library
// lists, profiles and compile actions) in one step, share a team setup file, choose the team coding standards (or
// import an rpglint.json), and a code health report over every indexed member of a library.
import * as vscode from 'vscode';
import { checkSqlScript } from '../core/sqlChecks';
import { clLint } from '../core/clChecks';
import { ddsKind, ddsLint } from '../core/ddsChecks';
import { summarize, MemberFindings } from '../core/codeHealth';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { fromCodeForIbmi, readTeamSetup, teamSetup, TEAM_SETTINGS, ImportedProfile, ImportedSet } from '../core/migration';
import { newProfile } from '../core/profiles';
import { LintRule, lintRpg } from '../rpg/lint';
import { fromRpglint, Standards, STANDARD_RULES } from '../rpg/rpgStandards';
import { showReport } from './reportPanel';
import { docsArray, indexedLibraries } from './sourceIndexView';
import { memberUri } from './fileSystems';

const cfg = () => vscode.workspace.getConfiguration('vanthrex');
const target = () => (vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
const setsKey = (id: string) => `vanthrex.librarySets.${id}`;

async function readWorkspaceJson(rel: string): Promise<unknown> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try { return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(f.uri, rel)))); } catch { /* not there */ }
  }
  return undefined;
}

/** Saves imported connections (new ones only) and their library list sets; returns what was created. */
async function saveProfiles(manager: ConnectionManager, state: vscode.Memento, profiles: ImportedProfile[], sets: ImportedSet[], user?: string): Promise<{ created: string[]; skipped: string[] }> {
  const existing = manager.profiles.list();
  const created: string[] = []; const skipped: string[] = [];
  for (const p of profiles) {
    if (existing.some(e => e.name.toUpperCase() === p.name.toUpperCase() || (e.host === p.host && e.user.toUpperCase() === (p.user || user || '').toUpperCase()))) { skipped.push(p.name); continue; }
    const prof = { ...newProfile(), name: p.name, host: p.host, port: p.port, user: (p.user || user || '').toUpperCase(), authType: p.authType, privateKeyPath: p.privateKeyPath, libraries: p.libraries, currentLibrary: p.currentLibrary, ifsHome: p.ifsHome };
    await manager.profiles.save(prof);
    const mine = sets.filter(s => s.connection === p.name).map(s => ({ name: s.name, libraries: s.libraries, currentLibrary: s.currentLibrary }));
    if (mine.length) { await state.update(setsKey(prof.id), mine); }
    created.push(p.name);
  }
  return { created, skipped };
}

async function importCodeForIbmi(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const c4i = vscode.workspace.getConfiguration('code-for-ibmi');
  const imp = fromCodeForIbmi(c4i.get('connections'), c4i.get('connectionSettings'), c4i.get('actions'), await readWorkspaceJson('.vscode/actions.json'));
  if (!imp.profiles.length && !imp.actions.length) {
    vscode.window.showInformationMessage(vscode.l10n.t('No Code for IBM i connections or actions were found in your VS Code settings.'));
    return;
  }
  const picks = await vscode.window.showQuickPick([
    ...imp.profiles.map(p => ({ label: `$(plug) ${p.name}`, description: `${p.user}@${p.host}:${p.port}`, detail: p.libraries.length ? vscode.l10n.t('Library list: {0}', p.libraries.join(' ')) : undefined, picked: true, p })),
    ...imp.actions.filter(a => !a.skipped).map(a => ({ label: `$(tools) ${a.name}`, description: a.extensions.join(', '), detail: a.command, picked: true, a })),
  ], { canPickMany: true, title: vscode.l10n.t('Import from Code for IBM i'), placeHolder: vscode.l10n.t('Passwords are not imported: you type each one once, at the first connection.') });
  if (!picks) { return; }
  const profiles = picks.filter(x => 'p' in x).map(x => (x as { p: ImportedProfile }).p);
  const actions = picks.filter(x => 'a' in x).map(x => (x as { a: typeof imp.actions[number] }).a);
  const res = await saveProfiles(manager, state, profiles, imp.sets);
  let added = 0;
  if (actions.length) {
    const current = cfg().get<{ name: string; command: string; extensions: string[]; source?: string }[]>('compileActions', []);
    const fresh = actions.filter(a => !current.some(c => c.name === a.name)).map(a => ({ name: a.name, command: a.command, extensions: a.extensions, source: a.source }));
    if (fresh.length) { await cfg().update('compileActions', [...current, ...fresh], vscode.ConfigurationTarget.Global); added = fresh.length; }
  }
  showReport('import-code-for-ibmi', {
    title: vscode.l10n.t('Imported from Code for IBM i'),
    facts: [[vscode.l10n.t('Connections created'), res.created.length], [vscode.l10n.t('Already in Vanthrex'), res.skipped.length], [vscode.l10n.t('Library list sets'), imp.sets.filter(s => res.created.includes(s.connection)).length], [vscode.l10n.t('Compile actions added'), added]],
    tables: [
      { title: vscode.l10n.t('Connections'), columns: [vscode.l10n.t('Name'), vscode.l10n.t('Result')], rows: [...res.created.map(n => [n, vscode.l10n.t('created — type the password at the first connection')]), ...res.skipped.map(n => [n, vscode.l10n.t('skipped: a connection with this name or host and user exists')])] },
      { title: vscode.l10n.t('Compile actions'), columns: [vscode.l10n.t('Name'), vscode.l10n.t('Command'), vscode.l10n.t('Result')], rows: imp.actions.map(a => [a.name, a.command, a.skipped ? vscode.l10n.t('not imported: {0}', a.skipped) : actions.includes(a) ? vscode.l10n.t('added to vanthrex.compileActions') : vscode.l10n.t('not selected')]) },
      { title: vscode.l10n.t('Notes'), columns: [vscode.l10n.t('Note')], rows: imp.notes.map(n => [n]), empty: vscode.l10n.t('Nothing else to do.') },
    ],
    note: vscode.l10n.t('Code for IBM i keeps its own settings: both extensions can stay installed while you try Vanthrex.'),
  }, new Set());
}

async function exportTeam(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const profiles = manager.profiles.list();
  const pick = await vscode.window.showQuickPick(profiles.map(p => ({ label: p.name, description: `${p.host}:${p.port}`, picked: true, p })), { canPickMany: true, title: vscode.l10n.t('Connections to share (never passwords or user names)') });
  if (!pick) { return; }
  const sets: ImportedSet[] = [];
  for (const x of pick) { for (const s of state.get<{ name: string; libraries: string[]; currentLibrary?: string }[]>(setsKey(x.p.id), [])) { sets.push({ connection: x.p.name, ...s }); } }
  const settings: Record<string, unknown> = {};
  for (const k of TEAM_SETTINGS) { const i = vscode.workspace.getConfiguration().inspect(k); const v = i?.workspaceValue ?? i?.globalValue; if (v !== undefined) { settings[k] = v; } }
  const file = teamSetup(pick.map(x => ({ name: x.p.name, host: x.p.host, port: x.p.port, user: '', authType: x.p.authType, libraries: x.p.libraries, currentLibrary: x.p.currentLibrary })), sets, settings);
  const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('vanthrex-team-setup.json'), filters: { JSON: ['json'] }, title: vscode.l10n.t('Save the team setup') });
  if (!uri) { return; }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(file, null, 2) + '\n'));
  vscode.window.showInformationMessage(vscode.l10n.t('Team setup saved: {0} connection(s), {1} setting(s). Colleagues open it with "Import a Team Setup".', file.connections.length, Object.keys(file.settings).length));
}

async function importTeam(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, title: vscode.l10n.t('Open a Vanthrex team setup file') });
  if (!files?.[0]) { return; }
  const setup = readTeamSetup(new TextDecoder().decode(await vscode.workspace.fs.readFile(files[0])));
  const user = await vscode.window.showInputBox({ title: vscode.l10n.t('Your IBM i user profile for these {0} connection(s)', setup.connections.length), validateInput: v => (/^[A-Za-z$#@][\w$#@]{0,9}$/.test(v.trim()) ? undefined : vscode.l10n.t('Not a valid user profile name')) });
  if (!user) { return; }
  const keys = Object.keys(setup.settings);
  const yes = vscode.l10n.t('Import');
  if ((await vscode.window.showInformationMessage(vscode.l10n.t('Import {0} connection(s) and {1} team setting(s)?', setup.connections.length, keys.length), { modal: true, detail: keys.join('\n') }, yes)) !== yes) { return; }
  const res = await saveProfiles(manager, state, setup.connections, setup.librarySets ?? [], user.trim());
  for (const k of keys) { await vscode.workspace.getConfiguration().update(k, setup.settings[k], target()); }
  vscode.window.showInformationMessage(vscode.l10n.t('{0} connection(s) created, {1} already there, {2} setting(s) applied. Type each password at the first connection.', res.created.length, res.skipped.length, keys.length));
}

async function editStandards(): Promise<void> {
  const cur = cfg().get<Standards>('standards', {});
  const bools = (Object.keys(STANDARD_RULES) as (keyof Standards)[]).filter(k => !['indent', 'directiveCase', 'namePattern', 'maxProcedureLines'].includes(k));
  const pick = await vscode.window.showQuickPick(bools.map(k => ({ label: vscode.l10n.t(STANDARD_RULES[k]), k, picked: !!cur[k] })), { canPickMany: true, title: vscode.l10n.t('Team coding standards (checked while you type)') });
  if (!pick) { return; }
  const next: Standards = { ...cur };
  for (const k of bools) { (next as Record<string, unknown>)[k] = pick.some(p => p.k === k) ? true : undefined; }
  const indent = await vscode.window.showInputBox({ title: vscode.l10n.t('Spaces per block level in free form (empty: not checked)'), value: cur.indent ? String(cur.indent) : '', validateInput: v => (!v.trim() || /^[1-8]$/.test(v.trim()) ? undefined : vscode.l10n.t('A number from 1 to 8')) });
  if (indent === undefined) { return; }
  next.indent = indent.trim() ? Number(indent) : undefined;
  const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
  await cfg().update('standards', clean, target());
  vscode.window.showInformationMessage(vscode.l10n.t('{0} standard(s) on. They are saved in the {1} settings, so the whole team gets them with the project.', Object.keys(clean).length, target() === vscode.ConfigurationTarget.Workspace ? vscode.l10n.t('workspace') : vscode.l10n.t('user')));
}

async function importRpglint(): Promise<void> {
  const found = await readWorkspaceJson('.vscode/rpglint.json');
  let json = found;
  if (!json) {
    const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, title: vscode.l10n.t('Open an rpglint.json file') });
    if (!f?.[0]) { return; }
    json = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(f[0])));
  }
  const { standards, ignored } = fromRpglint(json);
  await cfg().update('standards', { ...cfg().get<Standards>('standards', {}), ...standards }, target());
  vscode.window.showInformationMessage(vscode.l10n.t('{0} rule(s) of rpglint.json are now Vanthrex team standards.', Object.keys(standards).length) + (ignored.length ? ' ' + vscode.l10n.t('Not used: {0}.', ignored.join(', ')) : ''));
}

async function codeHealth(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const libs = await indexedLibraries(conn.profile.id);
  if (!libs.length) { vscode.window.showWarningMessage(vscode.l10n.t('No library is indexed yet: index one first (Source Index), then run the health report — it then works offline in seconds.')); return; }
  const pick = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(library) All indexed libraries'), lib: '*' }, ...libs.sort().map(l => ({ label: l, lib: l }))], { title: vscode.l10n.t('Code health of') });
  if (!pick) { return; }
  const rules = cfg().get<Partial<Record<LintRule, boolean>>>('lint.rules', {});
  const standards = cfg().get<Standards>('standards', {});
  const on = (r: string) => (rules as Record<string, boolean>)[r] !== false;
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking the sources…'), cancellable: true }, async (progress, token) => {
    const { docs, types } = await docsArray(conn.profile.id);
    const mine = docs.filter(([k]) => pick.lib === '*' || k.startsWith(`${pick.lib}/`));
    const out: MemberFindings[] = [];
    for (let i = 0; i < mine.length; i++) {
      if (token.isCancellationRequested) { break; }
      const [key, text] = mine[i]; const type = (types.get(key) ?? '').toUpperCase();
      let findings: { rule: string; severity: string }[] = [];
      try {
        if (/^(RPGLE|SQLRPGLE|RPGLEINC|RPGINC)$/.test(type)) { findings = lintRpg(text, { rules: rules, standards, isInclude: /INC$/.test(type) }); }
        else if (/^(CLLE|CLP|CL)$/.test(type)) { findings = clLint(text, on); }
        else if (type === 'SQL') { findings = checkSqlScript(text, on); }
        else if (/^(PF|LF|DSPF|PRTF)$/.test(type)) { findings = ddsLint(text, ddsKind(type), on); }
        else { continue; }
      } catch (e) { logError(e); continue; }
      out.push({ key, type, lines: text.split('\n').length, findings });
      if (i % 25 === 0) { progress.report({ message: `${i + 1} / ${mine.length}`, increment: 25 * 100 / Math.max(1, mine.length) }); await new Promise(r => setTimeout(r, 0)); }
    }
    return out;
  });
  const s = summarize(result, 100);
  const open = (key: string, type: string) => { const [l, f, m] = key.split('/'); return { label: vscode.l10n.t('Open'), command: 'vscode.open', args: [memberUri(l, f, m, type.toLowerCase())] }; };
  showReport('code-health', {
    title: vscode.l10n.t('Code health — {0}', pick.lib === '*' ? vscode.l10n.t('all indexed libraries') : pick.lib),
    subtitle: vscode.l10n.t('Every check of Vanthrex (RPG, CL, SQL, DDS and your team standards) on the indexed copy of each member: run it before a release, compare it after.'),
    facts: [[vscode.l10n.t('Score'), `${s.score} / 100 (${s.grade})`], [vscode.l10n.t('Members checked'), s.members], [vscode.l10n.t('Lines'), s.lines], [vscode.l10n.t('Errors'), s.errors], [vscode.l10n.t('Warnings'), s.warnings], [vscode.l10n.t('Findings'), s.findings]],
    tables: [
      { title: vscode.l10n.t('Members to look at first'), columns: [vscode.l10n.t('Member'), vscode.l10n.t('Type'), vscode.l10n.t('Lines'), vscode.l10n.t('Errors'), vscode.l10n.t('Warnings'), vscode.l10n.t('Other'), vscode.l10n.t('Score')], rows: s.worst.map(w => [w.key, w.type, w.lines, w.errors, w.warnings, w.infos, w.score]), rowActions: s.worst.map(w => open(w.key, w.type)), filter: true },
      { title: vscode.l10n.t('Findings by check'), columns: [vscode.l10n.t('Check'), vscode.l10n.t('Severity'), vscode.l10n.t('Findings'), vscode.l10n.t('Members')], rows: s.byRule.map(r => [r.rule, r.severity, r.count, r.members]), filter: true },
    ],
    note: vscode.l10n.t('The index is refreshed with Refresh Source Index; checks you turned off are not counted. Hints (unused names) are not counted either.'),
  }, new Set(['vscode.open']));
}

export function registerTeamSetup(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const run = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.importCodeForIbmi', run(() => importCodeForIbmi(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.team.export', run(() => exportTeam(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.team.import', run(() => importTeam(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.standards.edit', run(editStandards)),
    vscode.commands.registerCommand('vanthrex.standards.importRpglint', run(importRpglint)),
    vscode.commands.registerCommand('vanthrex.codeHealth', run(() => codeHealth(manager))),
  );
}
