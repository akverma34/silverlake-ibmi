// Everyday workbench helpers that Code for IBM i users expect: library list order and clean-up, members to and from
// local files, shared snippets on the IFS, finding IFS files by name and jumping between changed blocks of a member.
// Pure functions (no vscode import), unit tested.
import { sqlString } from './util';

// ---------------------------------------------------------------- library list

/** The list with `item` moved `delta` places (clamped); unchanged when it is not in the list. */
export function moveItem<T>(list: T[], item: T, delta: number): T[] {
  const i = list.indexOf(item); if (i < 0) { return list; }
  const j = Math.max(0, Math.min(list.length - 1, i + delta)); if (i === j) { return list; }
  const out = [...list]; out.splice(i, 1); out.splice(j, 0, item);
  return out;
}

/** The libraries of the list that do not exist (any more), keeping the list order; duplicates count once. */
export function missingLibraries(list: string[], existing: string[]): string[] {
  const have = new Set(existing.map(l => l.trim().toUpperCase()));
  return [...new Set(list.map(l => l.trim().toUpperCase()))].filter(l => l && !have.has(l));
}

/** Which of these libraries exist (names are checked before they go in the SQL). */
export function existingLibrariesSql(list: string[]): string | undefined {
  const ok = [...new Set(list.map(l => l.trim().toUpperCase()))].filter(l => NAME.test(l));
  if (!ok.length) { return undefined; }
  return `SELECT SYSTEM_SCHEMA_NAME AS LIB FROM QSYS2.SYSSCHEMAS WHERE SYSTEM_SCHEMA_NAME IN (${ok.map(sqlString).join(', ')})`;
}

/** Source members of a source file, or of every source file of a library. */
export function sourceMembersSql(lib: string, file?: string): string {
  const L = lib.trim().toUpperCase(); const F = file?.trim().toUpperCase();
  if (!NAME.test(L) || (F !== undefined && !NAME.test(F))) { throw new Error(`Not a valid name: ${F && !NAME.test(F) ? F : L}`); }
  return `SELECT SYSTEM_TABLE_NAME AS FILE, SYSTEM_TABLE_MEMBER AS MBR, COALESCE(SOURCE_TYPE, '') AS TYPE FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(L)}${F ? ` AND SYSTEM_TABLE_NAME = ${sqlString(F)}` : ''} AND SOURCE_TYPE IS NOT NULL ORDER BY SYSTEM_TABLE_NAME, SYSTEM_TABLE_MEMBER`;
}

export const isSystemName = (n: string): boolean => NAME.test(n.trim().toUpperCase());

// ---------------------------------------------------------------- members ↔ local files

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

/** RPGLE member PGM1 → "PGM1.rpgle" (no type: ".mbr"). */
export const memberFileName = (member: string, type: string): string => `${member.toUpperCase()}.${(type || 'mbr').trim().toLowerCase()}`;

/** Where a downloaded member goes: <base>/LIB/FILE/MBR.type ("structured"), <base>/FILE/MBR.type ("file") or <base>/MBR.type ("flat"). */
export function localMemberPath(base: string, layout: 'structured' | 'file' | 'flat', lib: string, file: string, member: string, type: string): string {
  const b = base.replace(/[\\/]+$/, '');
  const parts = layout === 'structured' ? [lib.toUpperCase(), file.toUpperCase()] : layout === 'file' ? [file.toUpperCase()] : [];
  return [b, ...parts, memberFileName(member, type)].join('/');
}

/** "pgm1.rpgle" → { member: 'PGM1', type: 'RPGLE' }; undefined when the name is not a valid member name. */
export function memberFromFileName(fileName: string): { member: string; type: string } | undefined {
  const base = fileName.replace(/^.*[\\/]/, '');
  const m = /^([^.]+)(?:\.([^.]+))?$/.exec(base); if (!m) { return undefined; }
  const member = m[1].toUpperCase(); if (!NAME.test(member)) { return undefined; }
  return { member, type: (m[2] ?? '').toUpperCase() };
}

// ---------------------------------------------------------------- shared snippets

/** The snippet folder for a user: the setting, with {user} replaced; ~/.vanthrex/snippets when not set. */
export function snippetFolder(setting: string | undefined, user: string): string {
  const raw = (setting ?? '').trim() || '/home/{user}/.vanthrex/snippets';
  return raw.replace(/\{user\}/gi, user.toUpperCase()).replace(/\/+$/, '');
}

/** "Read customer, by id!" + "rpgle" → "Read_customer_by_id.rpgle". */
export function snippetFileName(name: string, ext: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9 _.-]+/g, '').replace(/\s+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80) || 'snippet';
  const e = ext.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return e ? `${base}.${e}` : base;
}

/** "Read_customer_by_id.rpgle" → "Read customer by id" (the extension shown apart). */
export const snippetLabel = (fileName: string): { label: string; ext: string } => {
  const m = /^(.*?)(?:\.([^.]+))?$/.exec(fileName.replace(/^.*\//, ''))!;
  return { label: m[1].replace(/_/g, ' '), ext: (m[2] ?? '').toLowerCase() };
};

/** Stream files directly in a folder (snippets), newest first. */
export function folderFilesSql(folder: string): string {
  return `SELECT PATH_NAME AS PATH, DATA_SIZE AS SIZE, VARCHAR_FORMAT(DATA_CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS CHANGED ` +
    `FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(folder)}, SUBTREE_DIRECTORIES => 'NO', OBJECT_TYPE_LIST => '*STMF')) X ` +
    `ORDER BY DATA_CHANGE_TIMESTAMP DESC`;
}

// ---------------------------------------------------------------- find IFS files by name

/** A file name pattern with * and ? as an SQL LIKE pattern (with ! as escape) on the last part of the path. */
export function globToLike(glob: string): string {
  return glob.trim().replace(/[!%_]/g, c => `!${c}`).replace(/\*/g, '%').replace(/\?/g, '_');
}

/** Stream files under a folder (all levels) whose name matches the pattern, case-insensitive. */
export function findByNameSql(folder: string, pattern: string, max = 500): string {
  const like = globToLike(pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`).toUpperCase();
  return `SELECT PATH_NAME AS PATH, OBJECT_TYPE AS TYPE, DATA_SIZE AS SIZE, VARCHAR_FORMAT(DATA_CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS CHANGED ` +
    `FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(folder.replace(/\/+$/, '') || '/')}, SUBTREE_DIRECTORIES => 'YES', OBJECT_TYPE_LIST => '*STMF')) X ` +
    `WHERE UPPER(REGEXP_REPLACE(PATH_NAME, '^.*/', '')) LIKE ${sqlString(like)} ESCAPE '!' ORDER BY PATH_NAME FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

// ---------------------------------------------------------------- changed blocks

/** First line of every run of highlighted lines. */
export function blockStarts(highlighted: boolean[]): number[] {
  return highlighted.flatMap((h, i) => (h && (i === 0 || !highlighted[i - 1]) ? [i] : []));
}

/** The next (or previous) block start after (before) the line, wrapping around; undefined when there is none. */
export function nextBlock(starts: number[], line: number, direction: 1 | -1): number | undefined {
  if (!starts.length) { return undefined; }
  if (direction > 0) { return starts.find(s => s > line) ?? starts[0]; }
  return [...starts].reverse().find(s => s < line) ?? starts[starts.length - 1];
}

// ---------------------------------------------------------------- library and table actions

const nm = (v: string, what: string): string => { const u = v.trim().toUpperCase(); if (!NAME.test(u)) { throw new Error(`Not a valid ${what} name: ${v}`); } return u; };

/** CL for the library actions of the Libraries view. */
export const libraryCommand = {
  copy: (lib: string, to: string): string => `CPYLIB FROMLIB(${nm(lib, 'library')}) TOLIB(${nm(to, 'library')}) CRTLIB(*YES)`,
  rename: (lib: string, to: string): string => `RNMOBJ OBJ(${nm(lib, 'library')}) OBJTYPE(*LIB) NEWOBJ(${nm(to, 'library')})`,
  clear: (lib: string): string => `CLRLIB LIB(${nm(lib, 'library')})`,
  remove: (lib: string): string => `DLTLIB LIB(${nm(lib, 'library')})`,
};

/** Libraries that must never be cleared, deleted or renamed from the editor. */
export const isSystemLibrary = (lib: string): boolean => /^(Q|SYS)/i.test(lib.trim()) || /^#/.test(lib.trim());

export type CopyMode = 'replace' | 'add' | 'create';
/** CL to clear the data of a table (its first member). */
export const clearDataCommand = (lib: string, file: string): string => `CLRPFM FILE(${nm(lib, 'library')}/${nm(file, 'file')})`;
/** CL to copy the data of a table: replace or add the rows of an existing table (columns mapped by name), or create the copy. */
export function copyDataCommand(lib: string, file: string, toLib: string, toFile: string, mode: CopyMode): string {
  const from = `${nm(lib, 'library')}/${nm(file, 'file')}`; const to = `${nm(toLib, 'library')}/${nm(toFile, 'file')}`;
  if (from === to) { throw new Error('Copy a table to another table, not to itself.'); }
  return mode === 'create' ? `CPYF FROMFILE(${from}) TOFILE(${to}) MBROPT(*REPLACE) CRTFILE(*YES)`
    : `CPYF FROMFILE(${from}) TOFILE(${to}) MBROPT(${mode === 'add' ? '*ADD' : '*REPLACE'}) FMTOPT(*MAP *DROP)`;
}

// ---------------------------------------------------------------- CALL statements

export interface RoutineParam { position: number; name: string; mode: string; type: string }
export type RoutineKind = 'procedure' | 'scalar' | 'table';

/** Procedures and functions by name (schema.name, or the name alone in every schema). */
export function routinesSql(text: string): string {
  const [a, b] = text.trim().toUpperCase().split('.');
  const where = b ? `ROUTINE_SCHEMA = ${sqlString(nm(a, 'schema'))} AND ROUTINE_NAME = ${sqlString(b.replace(/"/g, ''))}` : `ROUTINE_NAME = ${sqlString(a.replace(/"/g, ''))}`;
  return `SELECT ROUTINE_SCHEMA AS S, ROUTINE_NAME AS N, SPECIFIC_NAME AS SN, ROUTINE_TYPE AS RT, COALESCE(FUNCTION_TYPE, '') AS FT FROM QSYS2.SYSROUTINES WHERE ${where} ORDER BY ROUTINE_SCHEMA FETCH FIRST 50 ROWS ONLY`;
}

/** Input parameters of a routine (not the result of a function nor the columns of a table function). */
export function routineParamsSql(schema: string, specific: string): string {
  return `SELECT ORDINAL_POSITION AS P, COALESCE(PARAMETER_NAME, '') AS N, COALESCE(PARAMETER_MODE, 'IN') AS M, DATA_TYPE AS T FROM QSYS2.SYSPARMS ` +
    `WHERE SPECIFIC_SCHEMA = ${sqlString(nm(schema, 'schema'))} AND SPECIFIC_NAME = ${sqlString(specific.trim().toUpperCase())} AND COALESCE(ROW_TYPE, 'P') = 'P' ORDER BY ORDINAL_POSITION`;
}

export const routineKind = (routineType: string, functionType: string): RoutineKind =>
  /PROC/i.test(routineType) ? 'procedure' : /^T/i.test(functionType.trim()) ? 'table' : 'scalar';

/** A ready-to-fill CALL, VALUES or SELECT … FROM TABLE() with one line per parameter (named when the parameter has a name). */
export function callStatement(schema: string, name: string, kind: RoutineKind, params: RoutineParam[]): string {
  const id = (s: string) => /^[A-Z_$#@][A-Z0-9_$#@]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
  const target = `${id(schema)}.${id(name)}`;
  const list = [...params].sort((a, b) => a.position - b.position);
  const args = list.length ? `\n${list.map((p, i) => `  ${p.name ? `${id(p.name)} => ` : ''}?${i < list.length - 1 ? ',' : ''} -- ${p.mode} ${p.type}`).join('\n')}\n` : '';
  if (kind === 'procedure') { return `CALL ${target}(${args});`; }
  if (kind === 'table') { return `SELECT *\n  FROM TABLE(${target}(${args})) X;`; }
  return `VALUES ${target}(${args});`;
}

// ---------------------------------------------------------------- JSON sample → SQL

/** SQL that returns this JSON, built with JSON_OBJECT and JSON_ARRAY: replace the sample values with your columns. */
export function jsonToSql(json: string): string {
  const value = JSON.parse(json) as unknown;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const pad = (n: number) => '  '.repeat(n);
  const expr = (v: unknown, depth: number): string => {
    if (v === null) { return 'NULL'; }
    if (typeof v === 'string') { return lit(v); }
    if (typeof v === 'number') { return String(v); }
    if (typeof v === 'boolean') { return `${lit(String(v))} FORMAT JSON`; }
    if (Array.isArray(v)) {
      if (!v.length) { return `JSON_ARRAY()`; }
      return `JSON_ARRAY(\n${v.map(x => pad(depth + 1) + expr(x, depth + 1)).join(',\n')}\n${pad(depth)})`;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) { return `JSON_OBJECT()`; }
    const nulls = entries.some(([, x]) => x === null) ? ` NULL ON NULL` : '';
    return `JSON_OBJECT(\n${entries.map(([k, x]) => `${pad(depth + 1)}KEY ${lit(k)} VALUE ${expr(x, depth + 1)}`).join(',\n')}${nulls}\n${pad(depth)})`;
  };
  return `VALUES ${expr(value, 0)};`;
}
