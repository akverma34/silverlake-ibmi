// Checks for SQL scripts and embedded SQL: UPDATE or DELETE with no WHERE (every row changes), DROP / TRUNCATE (cannot
// be undone), SELECT INTO with no FETCH FIRST that may return several rows, and comparisons with NULL that are never
// true (= NULL instead of IS NULL). Pure, unit tested.
import { splitSqlStatements, stripSqlComments } from './util';

export type SqlRule = 'sql-without-where' | 'sql-irreversible' | 'sql-equals-null' | 'sql-select-into-many';

export const SQL_RULES: Record<SqlRule, string> = {
  'sql-without-where': 'UPDATE or DELETE without WHERE (every row of the table is changed)',
  'sql-irreversible': 'DROP or TRUNCATE (cannot be undone)',
  'sql-equals-null': '= NULL or <> NULL, which is never true (use IS NULL / IS NOT NULL)',
  'sql-select-into-many': 'SELECT INTO without a key condition or FETCH FIRST 1 ROW ONLY (SQLCODE -811 when several rows match)',
};

export interface SqlFinding { rule: SqlRule; severity: 'error' | 'warning' | 'info'; offset: number; length: number; message: string }

/** Text with literals and comments blanked (same length). */
function blank(sql: string): string {
  return sql.replace(/--[^\n]*/g, m => ' '.repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^']|'')*'/g, m => `'${' '.repeat(Math.max(0, m.length - 2))}'`);
}

/** Findings for one statement; offsets are inside `sql`. */
export function checkSqlStatement(sql: string, enabled: (r: SqlRule) => boolean = () => true): SqlFinding[] {
  const out: SqlFinding[] = [];
  const b = blank(sql); const u = b.toUpperCase();
  const push = (rule: SqlRule, severity: SqlFinding['severity'], re: RegExp, message: string) => {
    if (!enabled(rule)) { return; }
    const m = re.exec(u); const at = m ? m.index : Math.max(0, u.search(/\S/));
    out.push({ rule, severity, offset: at, length: m ? m[0].length : 6, message });
  };
  const head = u.trimStart();
  // Statements inside a routine body (CREATE PROCEDURE … BEGIN … END) are not checked one by one.
  if (/^CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|TRIGGER)\b/.test(head)) { return out; }
  if (/^(UPDATE|DELETE)\b/.test(head) && !/\bWHERE\b/.test(u) && !/\bWHERE\s+CURRENT\s+OF\b/.test(u)) {
    const verb = /^(UPDATE|DELETE)/.exec(head)![1];
    push('sql-without-where', 'warning', new RegExp(`\\b${verb}\\b`), `${verb} without WHERE changes every row of the table. Add a WHERE (or WHERE 1 = 1 if that is really what you want).`);
  }
  if (/^(DROP\s+(TABLE|VIEW|INDEX|SCHEMA|COLLECTION|PROCEDURE|FUNCTION|TRIGGER|ALIAS|SEQUENCE)|TRUNCATE)\b/.test(head)) {
    push('sql-irreversible', 'info', /\b(DROP|TRUNCATE)\b/, 'This statement cannot be undone: check the system and the library first (and keep a copy of the data).');
  }
  for (const m of u.matchAll(/(?:=|<>|!=)\s*NULL\b/g)) {
    if (!enabled('sql-equals-null')) { break; }
    // SET col = NULL in UPDATE … SET and VALUES / DEFAULT are assignments, not comparisons.
    const before = u.slice(0, m.index);
    const inSet = /\bSET\b(?![\s\S]*\bWHERE\b)/.test(before) && /^\s*UPDATE\b/.test(u) || /\bSET\s+[\w$#@.:]+\s*$/.test(before);
    if (inSet) { continue; }
    out.push({ rule: 'sql-equals-null', severity: 'warning', offset: m.index!, length: m[0].length, message: `${m[0].replace(/\s+/g, ' ')} is never true: use IS ${/^=/.test(m[0]) ? '' : 'NOT '}NULL.` });
  }
  if (/^SELECT\b[\s\S]*\bINTO\s+:/.test(head) && !/\bFETCH\s+FIRST\b|\bLIMIT\s+1\b/.test(u) && !/\b(COUNT|SUM|MAX|MIN|AVG)\s*\(/.test(u.slice(0, u.search(/\bINTO\b/))) && !/\bWHERE\b/.test(u)) {
    push('sql-select-into-many', 'info', /\bINTO\b/, 'SELECT INTO without WHERE fails with SQLCODE -811 when the table has more than one row: add a WHERE on the key or FETCH FIRST 1 ROW ONLY.');
  }
  return out;
}

/** Findings for an SQL script, with offsets in the whole text. */
export function checkSqlScript(text: string, enabled?: (r: SqlRule) => boolean): SqlFinding[] {
  const out: SqlFinding[] = [];
  for (const s of splitSqlStatements(text)) {
    if (!stripSqlComments(s.sql).trim()) { continue; }
    for (const f of checkSqlStatement(s.sql, enabled)) { out.push({ ...f, offset: f.offset + s.start }); }
  }
  return out;
}
