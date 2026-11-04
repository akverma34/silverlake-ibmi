// Moving to Vanthrex in one step (pure, unit tested): connections, library lists, current library, home folder,
// library list profiles and compile actions read from the Code for IBM i settings, and a team setup file
// (connections without passwords, library sets, CL macros, compile actions, checks and standards) to share with
// colleagues. Passwords are never read or written: each person types theirs once.

export interface ImportedProfile {
  name: string; host: string; port: number; user: string; authType: 'password' | 'key'; privateKeyPath?: string;
  libraries: string[]; currentLibrary?: string; ifsHome?: string;
}
export interface ImportedSet { connection: string; name: string; libraries: string[]; currentLibrary?: string }
export interface ImportedAction { name: string; command: string; extensions: string[]; source: 'member' | 'ifs' | 'both'; skipped?: string }
export interface Imported { profiles: ImportedProfile[]; sets: ImportedSet[]; actions: ImportedAction[]; notes: string[] }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const libs = (v: unknown) => (Array.isArray(v) ? v.map(x => str(x).toUpperCase()).filter(x => /^[A-Z$#@][\w$#@.]{0,9}$/.test(x)) : []);

/** Variables of Code for IBM i actions that have a Vanthrex equivalent. */
const VARS: Record<string, string> = {
  '&OPENLIB': '&LIB', '&OPENSPF': '&SRCFILE', '&OPENMBR': '&NAME', '&BUILDLIB': '&OBJLIB', '&CURLIB': '&CURLIB', '&LIBRARY': '&LIB',
  '&NAME': '&NAME', '&EXT': '&EXT', '&FULLPATH': '&FULLPATH', '&USERNAME': '&USER', '&USER': '&USER',
};

/** A Code for IBM i action command with Vanthrex variables, or why it cannot be used as is. */
export function convertActionCommand(command: string): { command: string; unknown: string[] } {
  const unknown: string[] = [];
  const out = command.replace(/&[A-Z_]+[A-Z0-9_]*/gi, v => {
    const k = v.toUpperCase();
    if (VARS[k]) { return VARS[k]; }
    // Lower-case &openlib etc. are the same variables in Code for IBM i.
    unknown.push(v);
    return v;
  });
  return { command: out, unknown: [...new Set(unknown)] };
}

/**
 * Reads the Code for IBM i settings: `code-for-ibmi.connections`, `code-for-ibmi.connectionSettings` and
 * `code-for-ibmi.actions` (plus a workspace .vscode/actions.json array when given).
 */
export function fromCodeForIbmi(connections: unknown, settings: unknown, actions: unknown, workspaceActions?: unknown): Imported {
  const res: Imported = { profiles: [], sets: [], actions: [], notes: [] };
  const conns = Array.isArray(connections) ? connections : [];
  const sets = Array.isArray(settings) ? settings : [];
  for (const c of conns) {
    const name = str(c?.name); const host = str(c?.host);
    if (!name || !host) { continue; }
    const s = sets.find(x => str(x?.name) === name) ?? {};
    const key = str(c?.privateKeyPath) || str(c?.privateKey);
    res.profiles.push({
      name, host, port: Number(c?.port) > 0 ? Number(c.port) : 22, user: str(c?.username || c?.user).toUpperCase(),
      authType: key ? 'key' : 'password', privateKeyPath: key || undefined,
      libraries: libs(s.libraryList), currentLibrary: str(s.currentLibrary).toUpperCase() || undefined, ifsHome: str(s.homeDirectory) || undefined,
    });
    for (const p of Array.isArray(s.connectionProfiles) ? s.connectionProfiles : []) {
      const pn = str(p?.name); const l = libs(p?.libraryList);
      if (pn && l.length) { res.sets.push({ connection: name, name: pn, libraries: l, currentLibrary: str(p?.currentLibrary).toUpperCase() || undefined }); }
    }
    if (Array.isArray(s.objectFilters) && s.objectFilters.length) { res.notes.push(`${name}: ${s.objectFilters.length} object filter(s) — in Vanthrex, add their libraries to the library list or use Libraries & Source and Go to Anything (Ctrl+Alt+J).`); }
    if (Array.isArray(s.customVariables) && s.customVariables.length) { res.notes.push(`${name}: custom variables (${s.customVariables.map((v: { name?: string }) => `&${str(v?.name)}`).join(', ')}) are not imported: write their value in the compile command.`); }
  }
  const allActions = [...(Array.isArray(actions) ? actions : []), ...(Array.isArray(workspaceActions) ? workspaceActions : [])];
  const seen = new Set<string>();
  for (const a of allActions) {
    const name = str(a?.name); const cmd = str(a?.command);
    if (!name || !cmd || seen.has(name)) { continue; }
    seen.add(name);
    const type = str(a?.type).toLowerCase();
    const env = str(a?.environment).toLowerCase();
    const exts = (Array.isArray(a?.extensions) ? a.extensions : []).map((e: unknown) => str(e).toLowerCase()).filter((e: string) => e && e !== 'global' && e !== 'globals');
    const conv = convertActionCommand(cmd);
    const act: ImportedAction = { name, command: conv.command, extensions: exts.length ? exts : ['*'], source: type === 'streamfile' ? 'ifs' : 'member' };
    if (type === 'object' || type === 'file') { act.skipped = 'runs on objects or local files: use Run CL or the local build (makei / gmake) instead'; }
    else if (env && env !== 'ile') { act.skipped = `runs in ${env.toUpperCase()}: use the PASE terminal or a CL wrapper (QSH CMD(…))`; }
    else if (conv.unknown.length) { act.skipped = `unknown variable(s) ${conv.unknown.join(', ')}`; }
    res.actions.push(act);
  }
  return res;
}

// ---------------------------------------------------------------- team setup file

export interface TeamSetup {
  format: 'vanthrex-team-setup'; version: 1; exported: string;
  connections: Omit<ImportedProfile, never>[];
  librarySets?: ImportedSet[];
  settings: Record<string, unknown>;
}

/** Settings worth sharing with a team (never passwords, never personal AI audit data). */
export const TEAM_SETTINGS = ['vanthrex.compileActions', 'vanthrex.macros', 'vanthrex.lint.rules', 'vanthrex.lint.maxNesting', 'vanthrex.lint.maxProcedureLines',
  'vanthrex.standards', 'vanthrex.editor.rpgIndent', 'vanthrex.editor.wrapColumn', 'vanthrex.editor.changeLogTemplate', 'vanthrex.ai.deniedLibraries',
  'vanthrex.ai.sensitiveColumns', 'vanthrex.ai.redact.words', 'vanthrex.ai.productionData', 'vanthrex.sql.maxRows', 'vanthrex.sql.confirmDestructive'];

export function teamSetup(profiles: ImportedProfile[], sets: ImportedSet[], settings: Record<string, unknown>, now = new Date()): TeamSetup {
  const clean: Record<string, unknown> = {};
  for (const k of TEAM_SETTINGS) { if (settings[k] !== undefined) { clean[k] = settings[k]; } }
  return {
    format: 'vanthrex-team-setup', version: 1, exported: now.toISOString(),
    connections: profiles.map(p => ({ name: p.name, host: p.host, port: p.port, user: '', authType: p.authType, libraries: p.libraries, currentLibrary: p.currentLibrary, ifsHome: undefined, privateKeyPath: undefined })),
    librarySets: sets, settings: clean,
  };
}

/** Reads a team setup file; throws on anything that is not one. User names, key paths and passwords are never taken from it. */
export function readTeamSetup(text: string): TeamSetup {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error('This file is not JSON.'); }
  const t = j as Partial<TeamSetup>;
  if (t?.format !== 'vanthrex-team-setup' || t.version !== 1) { throw new Error('This is not a Vanthrex team setup file.'); }
  const connections = (Array.isArray(t.connections) ? t.connections : []).filter(c => str(c?.name) && str(c?.host)).map(c => ({
    name: str(c.name), host: str(c.host), port: Number(c.port) > 0 ? Number(c.port) : 22, user: '', authType: (c.authType === 'key' ? 'key' : 'password') as 'key' | 'password',
    libraries: libs(c.libraries), currentLibrary: str(c.currentLibrary).toUpperCase() || undefined,
  }));
  const settings: Record<string, unknown> = {};
  for (const k of TEAM_SETTINGS) { if (t.settings && k in t.settings) { settings[k] = (t.settings as Record<string, unknown>)[k]; } }
  const librarySets = (Array.isArray(t.librarySets) ? t.librarySets : []).filter(s => str(s?.name) && str(s?.connection)).map(s => ({ connection: str(s.connection), name: str(s.name), libraries: libs(s.libraries), currentLibrary: str(s.currentLibrary).toUpperCase() || undefined }));
  return { format: 'vanthrex-team-setup', version: 1, exported: str(t.exported), connections, librarySets, settings };
}
