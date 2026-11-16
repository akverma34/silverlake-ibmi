// Compile actions as Code for IBM i runs them: the variables it offers (&HOST, &HOME, &BRANCH, &RELATIVEPATH,
// &LIBLS…), custom variables per connection, actions that run in PASE or QShell instead of ILE, actions on objects,
// and the workspace .vscode/actions.json read as it is. Pure functions (no vscode import), unit tested.

export type ActionEnvironment = 'ile' | 'pase' | 'qsh';
/** What an action compiles: members, IFS files, both, objects, or local files (deployed to the IFS first, run from the deploy folder). */
export type ActionSource = 'member' | 'ifs' | 'both' | 'object' | 'local';

export interface CompileAction {
  name: string;
  command: string;
  extensions: string[];
  source?: ActionSource;
  /** Where the command runs: ILE (a CL command, the default), PASE (a shell command) or QShell. */
  environment?: ActionEnvironment;
}

export function actionEnvironment(a: { environment?: string }): ActionEnvironment {
  const e = String(a.environment ?? '').trim().toLowerCase();
  return e === 'pase' || e === 'qsh' ? e : 'ile';
}

/** The branch named in a .git/HEAD file ("ref: refs/heads/feature/x" → "feature/x"); undefined on a detached HEAD. */
export function gitBranch(head: string | undefined): string | undefined {
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(String(head ?? '').trim());
  return m ? m[1].trim() : undefined;
}

const VAR_NAME = /^[A-Z][A-Z0-9_]{0,29}$/;

/** A custom variable name as used in commands (without &, upper case); throws when it cannot be one. */
export function checkVariableName(name: string): string {
  const n = name.trim().replace(/^&/, '').toUpperCase();
  if (!VAR_NAME.test(n)) { throw new Error('Use letters, digits and _ (up to 30, starting with a letter).'); }
  if (BUILT_IN.includes(n)) { throw new Error(`&${n} is a built-in variable.`); }
  return n;
}

/** Variables every action gets, whatever it runs on. */
export const BUILT_IN = ['LIB', 'LIBRARY', 'OBJLIB', 'BUILDLIB', 'SRCFILE', 'NAME', 'EXT', 'TYPE', 'FULLPATH', 'RELATIVEPATH', 'BASENAME', 'PARENT',
  'CURLIB', 'USER', 'USERNAME', 'HOST', 'HOME', 'WORKDIR', 'BRANCH', 'LIBLS', 'LIBLC'];

export interface ContextVars {
  host: string; user: string; home?: string; libraries: string[]; currentLibrary?: string; branch?: string; workDir?: string;
  custom?: Record<string, string>;
}

/** The variables of the connection (and custom ones), shared by members, IFS files and objects. */
export function contextVariables(c: ContextVars): Record<string, string> {
  const libs = c.libraries.map(l => l.trim().toUpperCase()).filter(Boolean);
  const home = c.home || `/home/${c.user.toLowerCase()}`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.custom ?? {})) { try { out[checkVariableName(k)] = String(v); } catch { /* skipped */ } }
  return Object.assign(out, {
    HOST: c.host, USER: c.user, USERNAME: c.user, HOME: home, WORKDIR: c.workDir || home,
    CURLIB: c.currentLibrary || 'QGPL', LIBLS: libs.join(' '), LIBLC: libs.join(','),
    ...(c.branch ? { BRANCH: c.branch } : {}),
  });
}

/** Variables of an IFS stream file: name, extension, base name, parent folder, full and relative path. */
export function ifsVariables(path: string, relative?: string): Record<string, string> {
  const base = path.split('/').pop() ?? '';
  const dot = base.indexOf('.');
  const parts = path.split('/').filter(Boolean);
  return {
    NAME: (dot > 0 ? base.slice(0, dot) : base).toUpperCase().replace(/[^A-Z0-9$#@_]/g, '').slice(0, 10),
    EXT: (base.split('.').pop() ?? '').toLowerCase(), BASENAME: base, PARENT: parts.length > 1 ? parts[parts.length - 2] : '',
    FULLPATH: path, RELATIVEPATH: relative ?? path,
  };
}

/** Variables of a member. */
export function memberVariables(lib: string, file: string, member: string, ext: string): Record<string, string> {
  return { LIB: lib, LIBRARY: lib, SRCFILE: file, NAME: member, EXT: ext, BASENAME: `${member}.${ext.toLowerCase()}`, PARENT: file,
    FULLPATH: `/QSYS.LIB/${lib}.LIB/${file}.FILE/${member}.MBR`, RELATIVEPATH: `${lib}/${file}/${member}.${ext.toLowerCase()}` };
}

/** Variables of an object: library, name, type (without *) and attribute as the extension, as in Code for IBM i. */
export function objectVariables(lib: string, name: string, type: string, attribute: string): Record<string, string> {
  return { LIB: lib, LIBRARY: lib, NAME: name, TYPE: type.replace(/^\*/, ''), EXT: attribute, BASENAME: `${name}.${type.replace(/^\*/, '').toLowerCase()}`,
    FULLPATH: `/QSYS.LIB/${lib}.LIB/${name}.${type.replace(/^\*/, '')}` };
}

/**
 * The actions offered for a source file: members get member (and both) actions; IFS files get ifs (and both) actions;
 * a local file (compiled from its copy in the deploy folder) gets its own local actions first, then the IFS ones.
 */
export function sourceActionsFor(actions: CompileAction[], ext: string, source: 'member' | 'ifs' | 'local'): CompileAction[] {
  const e = ext.toLowerCase();
  const fits = (a: CompileAction) => a.extensions.some(x => x.toLowerCase() === e || x === '*');
  const of = (s: ActionSource) => actions.filter(a => fits(a) && ((a.source ?? 'member') === s || (s !== 'local' && a.source === 'both')));
  if (source === 'local') { return [...of('local'), ...of('ifs')]; }
  return of(source);
}

/** Object actions that apply to an object: by type (PGM, *PGM), attribute (RPGLE) or * for all. */
export function objectActionsFor(actions: CompileAction[], type: string, attribute: string): CompileAction[] {
  const keys = new Set([type.replace(/^\*/, '').toLowerCase(), attribute.toLowerCase(), '*'].filter(Boolean));
  return actions.filter(a => a.source === 'object' && a.extensions.some(e => keys.has(e.replace(/^\*/, '').toLowerCase()) || e === '*'));
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell command that runs a PASE or QShell action in a folder (ILE actions run as CL commands). */
export function shellCommand(env: 'pase' | 'qsh', command: string, workDir: string): string {
  return env === 'qsh'
    ? `cd ${shq(workDir)} && /QOpenSys/usr/bin/qsh -c ${shq(command)}`
    : `cd ${shq(workDir)} && ${command}`;
}

/** The &VARIABLES still in a command after substitution (unknown, or with no value here). */
export function unresolvedVariables(command: string): string[] {
  return [...new Set((command.match(/&[A-Z][A-Z0-9_]*/gi) ?? []).map(v => v.toUpperCase()))].filter(v => BUILT_IN.includes(v.slice(1)));
}
