// Object filters for the Libraries view, as in the Code for IBM i Object Browser: a named filter picks libraries
// (generic names such as ORD*), objects by name and type, and members by name and source type, so libraries that are
// not on the library list can be browsed too. Pure functions (no vscode import), unit tested.

export interface ObjectFilter {
  name: string;
  /** One or more library names, generic allowed (ORD*, *TST), comma separated. */
  library: string;
  /** Object names, generic allowed, comma separated; * = all. */
  object: string;
  /** Object types (*PGM, *FILE, *SRCPF…); *ALL = all. *SRCPF only shows source files. */
  types: string[];
  /** Member names, generic allowed, comma separated; * = all. */
  member: string;
  /** Member source types (RPGLE, CLLE, SQL*…), comma separated; * = all. */
  memberType: string;
  /**
   * Objects, members and member types are regular expressions (as Code for IBM i "regex" filters), matched with
   * Db2 REGEXP_LIKE, case-insensitively; libraries stay names or generic names. * = all.
   */
  regex?: boolean;
}

/** The longest regular expression a filter keeps. */
const MAX_REGEX = 256;

/** Checks one regular expression of a filter; '' and * mean "all". Returns it trimmed, or '*'. */
export function checkRegex(what: string, value: string | undefined): string {
  const v = String(value ?? '').trim();
  if (!v || v === '*' || v === '.*' || v === '^.*$') { return '*'; }
  if (v.length > MAX_REGEX) { throw new Error(`The ${what} expression is longer than ${MAX_REGEX} characters.`); }
  // Back-references and look-around are not in Db2's (ICU) dialect the same way: keep to what both understand.
  if (/\\[1-9]|\(\?<?[=!]/.test(v)) { throw new Error(`The ${what} expression uses look-around or back-references, which the IBM i does not support here.`); }
  try { new RegExp(v, 'i'); } catch (e) { throw new Error(`The ${what} expression is not valid: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`); }
  return v;
}


const PART = /^[A-Z0-9$#@_.*]{1,10}$/;
const TYPE = /^\*[A-Z]{2,9}$/;

/** The parts of a comma (or space) separated list of names, upper case; '*' alone means "all". */
export function filterParts(value: string | undefined): string[] {
  return String(value ?? '').toUpperCase().split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
}

const isAll = (parts: string[]) => !parts.length || parts.includes('*') || parts.includes('*ALL');

/** Checks a filter and returns it normalised (upper case, defaults filled); throws with the reason otherwise. */
export function checkFilter(f: Partial<ObjectFilter>): ObjectFilter {
  const name = String(f.name ?? '').trim();
  if (!name) { throw new Error('Give the filter a name.'); }
  const lib = filterParts(f.library);
  if (!lib.length) { throw new Error('Enter at least one library (generic names such as ORD* are allowed).'); }
  if (lib.some(l => l === '*' || l === '*ALL')) { throw new Error('A filter cannot show every library: use a generic name such as ORD*.'); }
  const regex = f.regex === true;
  const named = regex ? [['library', lib]] as const
    : [['library', lib], ['object', filterParts(f.object)], ['member', filterParts(f.member)], ['member type', filterParts(f.memberType)]] as const;
  for (const [what, parts] of named) {
    const bad = parts.find(p => p !== '*ALL' && !PART.test(p));
    if (bad) { throw new Error(`"${bad}" is not a valid ${what} name or generic name.`); }
  }
  const types = (f.types ?? []).map(t => t.trim().toUpperCase()).filter(Boolean);
  const badType = types.find(t => !TYPE.test(t));
  if (badType) { throw new Error(`"${badType}" is not an object type (use *PGM, *FILE, *SRCPF…).`); }
  const join = (v: string | undefined) => { const p = filterParts(v); return isAll(p) ? '*' : p.join(', '); };
  const out: ObjectFilter = { name, library: lib.join(', '), object: '*', types: types.length && !types.includes('*ALL') ? types : ['*ALL'], member: '*', memberType: '*' };
  if (regex) {
    Object.assign(out, { object: checkRegex('object', f.object), member: checkRegex('member', f.member), memberType: checkRegex('member type', f.memberType), regex: true });
  } else {
    Object.assign(out, { object: join(f.object), member: join(f.member), memberType: join(f.memberType) });
  }
  return out;
}

/** A generic name as SQL LIKE (with ! as the escape character for _ and %). */
export function likePattern(generic: string): string {
  return generic.toUpperCase().replace(/[!%_]/g, c => `!${c}`).replace(/\*/g, '%');
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** WHERE condition for a column against a list of names / generic names; undefined when the list means "all". */
export function nameCondition(column: string, value: string | undefined): string | undefined {
  const parts = filterParts(value);
  if (isAll(parts)) { return undefined; }
  const ors = parts.map(p => (p.includes('*') ? `${column} LIKE ${q(likePattern(p))} ESCAPE '!'` : `${column} = ${q(p)}`));
  return ors.length === 1 ? ors[0] : `(${ors.join(' OR ')})`;
}

/** WHERE condition for a column against a regular expression (case-insensitive); undefined for "all". */
export function regexCondition(column: string, pattern: string | undefined): string | undefined {
  const p = String(pattern ?? '').trim();
  return !p || p === '*' ? undefined : `REGEXP_LIKE(${column}, ${q(p)}, 'i')`;
}

/** The condition of one filter field (object, member, member type): generic names, or a regular expression. */
function fieldCondition(f: ObjectFilter, column: string, value: string): string | undefined {
  return f.regex ? regexCondition(column, value) : nameCondition(column, value);
}

/** The exact library names of a filter, when it has no generic part (then no query is needed to list them). */
export function exactLibraries(f: ObjectFilter): string[] | undefined {
  const parts = filterParts(f.library);
  return parts.some(p => p.includes('*')) ? undefined : parts;
}

/** Libraries matching the filter's library names. */
export function filterLibrariesSql(f: ObjectFilter, max = 500): string {
  return `SELECT OBJNAME AS LIB, COALESCE(OBJTEXT, '') AS TEXT FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB')) X ` +
    `WHERE ${nameCondition('OBJNAME', f.library) ?? '1 = 1'} ORDER BY OBJNAME FETCH FIRST ${Math.max(1, Math.trunc(max))} ROWS ONLY`;
}

/** Whether the filter shows source files, other objects, or both. */
export function filterShows(f: ObjectFilter): { source: boolean; objects: boolean } {
  const all = f.types.includes('*ALL');
  return { source: all || f.types.includes('*SRCPF') || f.types.includes('*FILE'), objects: all || f.types.some(t => t !== '*SRCPF') };
}

/** Extra WHERE condition on source file names (SYSTABLES). */
export function sourceFileCondition(f: ObjectFilter): string {
  const c = fieldCondition(f, 'SYSTEM_TABLE_NAME', f.object);
  return c ? ` AND ${c}` : '';
}

/** Object types argument of OBJECT_STATISTICS and the extra WHERE condition on object names. */
export function objectArgs(f: ObjectFilter): { types: string; where: string } {
  const types = f.types.includes('*ALL') ? '*ALL' : f.types.filter(t => t !== '*SRCPF').join(' ') || '*FILE';
  const c = fieldCondition(f, 'OBJNAME', f.object);
  return { types, where: c ? ` WHERE ${c}` : '' };
}

/** Extra WHERE condition on members (SYSPARTITIONSTAT). */
export function memberCondition(f: ObjectFilter): string {
  return [fieldCondition(f, 'SYSTEM_TABLE_MEMBER', f.member), fieldCondition(f, 'SOURCE_TYPE', f.memberType)].filter(Boolean).map(c => ` AND ${c}`).join('');
}

/** One line describing a filter, for the tree and the pick lists. */
export function describeFilter(f: ObjectFilter): string {
  const re = (v: string) => (f.regex ? `/${v}/` : v);
  const bits = [f.library, f.object !== '*' ? `/${re(f.object)}` : '', !f.types.includes('*ALL') ? ` ${f.types.join(' ')}` : '',
    f.member !== '*' ? ` · members ${re(f.member)}` : '', f.memberType !== '*' ? ` · types ${re(f.memberType)}` : '', f.regex ? ' · regex' : ''];
  return bits.join('');
}

/** Code for IBM i object filters (code-for-ibmi.connectionSettings[].objectFilters) as Vanthrex filters, regex ones included; invalid ones are left out. */
export function fromCodeForIbmiFilters(list: unknown): ObjectFilter[] {
  const out: ObjectFilter[] = [];
  for (const x of Array.isArray(list) ? list : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const regex = String(o.filterType ?? 'simple').toLowerCase() === 'regex';
    try {
      out.push(checkFilter({
        regex,
        name: String(o.name ?? ''), library: String(o.library ?? ''), object: String(o.object ?? '*'),
        types: Array.isArray(o.types) ? o.types.map(String) : ['*ALL'], member: String(o.member ?? '*'), memberType: String(o.memberType ?? '*'),
      }));
    } catch { /* not usable as a simple filter */ }
  }
  return out;
}
