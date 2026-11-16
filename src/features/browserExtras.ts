// What Code for IBM i users have in its Object Browser and connection settings that Vanthrex lacked: object filters
// (libraries, objects and members by name and type, also outside the library list), custom variables for actions,
// change a member's source type and copy a member's path.
import * as vscode from 'vscode';
import { BUILT_IN, checkVariableName } from '../core/actions';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { checkFilter, describeFilter, ObjectFilter } from '../core/objectFilters';
import { isValidSystemName, parseMemberPath } from '../core/util';
import { LibNode, LibraryTreeProvider } from '../views/libraryTree';

type FilterNode = Extract<LibNode, { kind: 'filter' }>;
type Member = Extract<LibNode, { kind: 'member' }>;
const t = (msg: string, ...args: Array<string | number | boolean>): string => vscode.l10n.t(msg, ...args);

// ---------------------------------------------------------------- object filters

const COMMON_TYPES = ['*ALL', '*SRCPF', '*PGM', '*SRVPGM', '*MODULE', '*FILE', '*CMD', '*DTAARA', '*DTAQ', '*MSGF', '*BNDDIR', '*JOBD', '*OUTQ', '*USRSPC'];

/** Asks for every part of a filter, starting from `start`; undefined when cancelled. */
async function askFilter(start: ObjectFilter, taken: string[]): Promise<ObjectFilter | undefined> {
  const step = (n: number) => `${t('Object filter')} (${n}/6)`;
  const check = (part: Partial<ObjectFilter>) => { try { checkFilter({ ...start, ...part }); return undefined; } catch (e) { return errorMessage(e); } };
  const name = await vscode.window.showInputBox({ title: step(1), prompt: t('Name of the filter'), value: start.name, ignoreFocusOut: true,
    validateInput: v => (!v.trim() ? t('Give the filter a name.') : taken.includes(v.trim().toUpperCase()) ? t('A filter with this name exists.') : undefined) });
  if (name === undefined) { return undefined; }
  const library = await vscode.window.showInputBox({ title: step(2), prompt: t('Libraries: names or generic names, comma separated (ORD*, APPLIB)'), value: start.library, ignoreFocusOut: true, validateInput: v => check({ name, library: v }) });
  if (library === undefined) { return undefined; }
  const object = await vscode.window.showInputBox({ title: step(3), prompt: t('Objects and source files: names or generic names, * for all'), value: start.object, ignoreFocusOut: true, validateInput: v => check({ name, library, object: v }) });
  if (object === undefined) { return undefined; }
  const picked = await vscode.window.showQuickPick(COMMON_TYPES.map(x => ({ label: x, picked: start.types.includes(x) })), { title: step(4), placeHolder: t('Object types (*SRCPF = source files only; none or *ALL = all)'), canPickMany: true, ignoreFocusOut: true });
  if (!picked) { return undefined; }
  const member = await vscode.window.showInputBox({ title: step(5), prompt: t('Members: names or generic names, * for all'), value: start.member, ignoreFocusOut: true, validateInput: v => check({ name, library, object, member: v }) });
  if (member === undefined) { return undefined; }
  const memberType = await vscode.window.showInputBox({ title: step(6), prompt: t('Member types: RPGLE, CLLE, SQL*…, * for all'), value: start.memberType, ignoreFocusOut: true, validateInput: v => check({ name, library, object, member, memberType: v }) });
  if (memberType === undefined) { return undefined; }
  return checkFilter({ name, library, object, types: picked.map(p => p.label), member, memberType });
}

async function newFilter(manager: ConnectionManager, from?: LibNode): Promise<void> {
  const conn = manager.require();
  const lib = from && 'library' in from ? from.library : '';
  const srcOnly = from?.kind === 'srcfile';
  const taken = (conn.profile.filters ?? []).map(f => f.name.toUpperCase());
  const f = await askFilter({ name: lib ? (srcOnly ? `${lib}/${(from as { file: string }).file}` : lib) : '', library: lib, object: srcOnly ? (from as { file: string }).file : '*', types: srcOnly ? ['*SRCPF'] : ['*ALL'], member: '*', memberType: '*' }, taken);
  if (!f) { return; }
  await manager.updateActiveProfile(p => { p.filters = [...(p.filters ?? []), f]; });
  vscode.window.setStatusBarMessage(t('Filter {0} added: {1}', f.name, describeFilter(f)), 5000);
}

async function editFilter(manager: ConnectionManager, n: FilterNode): Promise<void> {
  const conn = manager.require();
  const taken = (conn.profile.filters ?? []).map(f => f.name.toUpperCase()).filter(x => x !== n.filter.name.toUpperCase());
  const f = await askFilter(n.filter, taken);
  if (!f) { return; }
  await manager.updateActiveProfile(p => { p.filters = (p.filters ?? []).map(x => (x.name === n.filter.name ? f : x)); });
}

async function copyFilter(manager: ConnectionManager, n: FilterNode): Promise<void> {
  const conn = manager.require();
  const taken = (conn.profile.filters ?? []).map(f => f.name.toUpperCase());
  const f = await askFilter({ ...n.filter, name: `${n.filter.name} (2)` }, taken);
  if (f) { await manager.updateActiveProfile(p => { p.filters = [...(p.filters ?? []), f]; }); }
}

async function deleteFilter(manager: ConnectionManager, n: FilterNode): Promise<void> {
  const yes = t('Delete');
  if (await vscode.window.showWarningMessage(t('Delete the filter {0}? Only the filter is deleted, nothing on the IBM i.', n.filter.name), { modal: true }, yes) !== yes) { return; }
  await manager.updateActiveProfile(p => { p.filters = (p.filters ?? []).filter(x => x.name !== n.filter.name); });
}

async function moveFilter(manager: ConnectionManager, n: FilterNode, delta: number): Promise<void> {
  await manager.updateActiveProfile(p => {
    const list = [...(p.filters ?? [])];
    const i = list.findIndex(x => x.name === n.filter.name); const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) { return; }
    [list[i], list[j]] = [list[j], list[i]];
    p.filters = list;
  });
}

// ---------------------------------------------------------------- custom variables

async function customVariables(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  for (;;) {
    const vars = conn.profile.variables ?? {};
    const pick = await vscode.window.showQuickPick([
      { label: t('$(add) New variable…'), key: '' },
      ...Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ label: `&${k}`, description: v, detail: t('Change or delete'), key: k })),
    ], { title: t('Custom variables of {0}', conn.profile.name), placeHolder: t('Used in compile actions like the built-in ones (&{0}…)', BUILT_IN.slice(0, 3).join(', &')) });
    if (!pick) { return; }
    let key = pick.key;
    if (!key) {
      const n = await vscode.window.showInputBox({ title: t('Variable name'), placeHolder: 'TGTRLS', ignoreFocusOut: true,
        validateInput: v => { try { const k = checkVariableName(v); return vars[k] !== undefined ? t('&{0} exists.', k) : undefined; } catch (e) { return errorMessage(e); } } });
      if (!n) { continue; }
      key = checkVariableName(n);
    } else {
      const what = await vscode.window.showQuickPick([{ label: t('$(edit) Change the value'), v: 'edit' }, { label: t('$(trash) Delete'), v: 'delete' }], { title: `&${key}` });
      if (!what) { continue; }
      if (what.v === 'delete') { await manager.updateActiveProfile(p => { const c = { ...(p.variables ?? {}) }; delete c[key]; p.variables = c; }); continue; }
    }
    const value = await vscode.window.showInputBox({ title: t('Value of &{0}', key), value: vars[key] ?? '', ignoreFocusOut: true });
    if (value === undefined) { continue; }
    await manager.updateActiveProfile(p => { p.variables = { ...(p.variables ?? {}), [key]: value }; });
  }
}

// ---------------------------------------------------------------- members

const SOURCE_TYPES = ['RPGLE', 'SQLRPGLE', 'RPGLEINC', 'CLLE', 'CLP', 'CMD', 'SQL', 'PF', 'LF', 'DSPF', 'PRTF', 'C', 'CPP', 'CBLLE', 'SQLCBLLE', 'BND', 'TXT'];

async function changeMemberType(manager: ConnectionManager, libraries: LibraryTreeProvider, n: Member): Promise<void> {
  const conn = manager.require();
  const pick = await vscode.window.showQuickPick([...SOURCE_TYPES.map(x => ({ label: x, picked: x === n.type })), { label: t('Other…') }], { title: t('Source type of {0}/{1}({2}) — now {3}', n.library, n.file, n.member, n.type || '—') });
  if (!pick) { return; }
  const type = (pick.label === t('Other…')
    ? await vscode.window.showInputBox({ title: t('Source type'), value: n.type, validateInput: v => (/^[A-Za-z0-9]{1,10}$/.test(v.trim()) ? undefined : t('Up to 10 letters or digits.')) })
    : pick.label)?.trim().toUpperCase();
  if (!type || type === n.type.toUpperCase()) { return; }
  if (![n.library, n.file, n.member].every(isValidSystemName)) { throw new Error(t('Not a valid member name.')); }
  const cmd = `CHGPFM FILE(${n.library}/${n.file}) MBR(${n.member}) SRCTYPE(${type})`;
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error(`CHGPFM: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`); }
  libraries.refresh();
  vscode.window.setStatusBarMessage(t('{0} is now of type {1}. Close and open it again for the new language.', n.member, type), 6000);
}

/** The ways to write a member's name, for the clipboard. */
export function memberPaths(lib: string, file: string, member: string, type: string): { label: string; value: string }[] {
  const ext = type ? `.${type.toLowerCase()}` : '';
  return [
    { label: 'LIB/FILE(MEMBER)', value: `${lib}/${file}(${member})` },
    { label: 'LIB/FILE/MEMBER.type', value: `${lib}/${file}/${member}${ext}` },
    { label: '/QSYS.LIB/…', value: `/QSYS.LIB/${lib}.LIB/${file}.FILE/${member}.MBR` },
    { label: 'SRCFILE(LIB/FILE) SRCMBR(MEMBER)', value: `SRCFILE(${lib}/${file}) SRCMBR(${member})` },
  ];
}

async function copyMemberPath(n?: Member | vscode.Uri): Promise<void> {
  let m: { library: string; file: string; member: string; type: string } | undefined;
  if (n && !(n instanceof vscode.Uri) && n.kind === 'member') { m = n; }
  else {
    const uri = n instanceof vscode.Uri ? n : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === 'vanthrex-member') {
      const p = parseMemberPath(uri.path);
      m = { library: p.library, file: p.file, member: p.member, type: /^mbr$/i.test(p.extension) ? '' : p.extension.toUpperCase() };
    }
  }
  if (!m) { vscode.window.showInformationMessage(t('Open a member or right-click one in the Libraries view.')); return; }
  const pick = await vscode.window.showQuickPick(memberPaths(m.library, m.file, m.member, m.type).map(x => ({ label: x.value, description: x.label })), { title: t('Copy the path of {0}', m.member) });
  if (!pick) { return; }
  await vscode.env.clipboard.writeText(pick.label);
  vscode.window.setStatusBarMessage(t('Copied {0}', pick.label), 3000);
}

// ---------------------------------------------------------------- registration

export function registerBrowserExtras(context: vscode.ExtensionContext, manager: ConnectionManager, libraries: LibraryTreeProvider): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => { try { await fn(...a); } catch (e) { logError(e); void vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.filter.new', guard((n?: LibNode) => newFilter(manager, n))),
    vscode.commands.registerCommand('vanthrex.filter.edit', guard((n: FilterNode) => editFilter(manager, n))),
    vscode.commands.registerCommand('vanthrex.filter.copy', guard((n: FilterNode) => copyFilter(manager, n))),
    vscode.commands.registerCommand('vanthrex.filter.delete', guard((n: FilterNode) => deleteFilter(manager, n))),
    vscode.commands.registerCommand('vanthrex.filter.moveUp', guard((n: FilterNode) => moveFilter(manager, n, -1))),
    vscode.commands.registerCommand('vanthrex.filter.moveDown', guard((n: FilterNode) => moveFilter(manager, n, 1))),
    vscode.commands.registerCommand('vanthrex.customVariables', guard(() => customVariables(manager))),
    vscode.commands.registerCommand('vanthrex.changeMemberType', guard((n: Member) => changeMemberType(manager, libraries, n))),
    vscode.commands.registerCommand('vanthrex.copyMemberPath', guard((n?: Member | vscode.Uri) => copyMemberPath(n))),
    vscode.commands.registerCommand('vanthrex.ifsToggleHidden', guard(async () => {
      const cfg = vscode.workspace.getConfiguration('vanthrex.ifs');
      await cfg.update('showHiddenFiles', !cfg.get<boolean>('showHiddenFiles', true), vscode.ConfigurationTarget.Global);
    })),
    vscode.commands.registerCommand('vanthrex.ifsSort', guard(async () => {
      const cfg = vscode.workspace.getConfiguration('vanthrex.ifs');
      const next = cfg.get<string>('sortBy', 'name') === 'date' ? 'name' : 'date';
      await cfg.update('sortBy', next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(next === 'date' ? t('IFS: newest first') : t('IFS: by name'), 3000);
    })),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vanthrex.ifs.showHiddenFiles') || e.affectsConfiguration('vanthrex.ifs.sortBy')) { void vscode.commands.executeCommand('vanthrex.refreshIfs'); }
    }),
  );
}
