// SQL builders of the Developer Toolbox (3.3, second batch): views, copies, safe previews of an UPDATE or DELETE,
// audit and identity columns, procedures, functions, triggers, duplicates, and IBM i Services queries about the
// table of the statement. Pure functions (no vscode import), unit tested.
import { parseCreateTable } from './devTools2';

const clean = (sql: string) => sql.trim().replace(/;\s*$/, '');
const ident = (v: string, what: string) => { const u = v.trim(); if (!/^("[^"]+"|[A-Za-z_$#@][\w$#@]*)(\.("[^"]+"|[A-Za-z_$#@][\w$#@]*))?$/.test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); } return u.toUpperCase(); };

/** The columns of a SELECT list (expressions get their AS name, or are left out when they have none). */
export function selectColumns(sql: string): string[] {
  const s = clean(sql); const m = /^\s*SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\s+FROM\b/i.exec(s);
  if (!m) { throw new Error('Put the cursor in a SELECT … FROM statement.'); }
  const parts: string[] = []; let depth = 0; let cur = '';
  for (const c of m[1]) { if (c === '(') { depth++; } if (c === ')') { depth--; } if (c === ',' && !depth) { parts.push(cur); cur = ''; } else { cur += c; } }
  parts.push(cur);
  return parts.map(p => p.trim()).map(p => /\bAS\s+("?[\w$#@]+"?)\s*$/i.exec(p)?.[1] ?? (/^(?:\w+\.)?("?[\w$#@]+"?)$/.exec(p)?.[1] ?? '')).filter(x => x && x !== '*').map(x => x.toUpperCase());
}

/** A SELECT turned into one JSON array of objects (JSON_ARRAYAGG of JSON_OBJECT). */
export function selectToJson(sql: string): string {
  const cols = selectColumns(sql);
  if (!cols.length) { throw new Error('Name the columns (or give them an AS name): SELECT * cannot be turned into JSON objects.'); }
  return `SELECT JSON_ARRAYAGG(\n         JSON_OBJECT(${cols.map(c => `'${c.replace(/"/g, '').toLowerCase()}' VALUE ${c}`).join(', ')})\n       ) AS JSON\n  FROM (\n${clean(sql).split('\n').map(l => '    ' + l).join('\n')}\n  ) X`;
}
export const createView = (sql: string, view: string): string => `CREATE OR REPLACE VIEW ${ident(view, 'view')} AS\n${clean(sql)}`;
export const createTableAs = (sql: string, table: string, withData = true): string => `CREATE TABLE ${ident(table, 'table')} AS (\n${clean(sql)}\n) WITH ${withData ? '' : 'NO '}DATA`;

/** DELETE FROM t WHERE … → SELECT * FROM t WHERE … (see the rows before deleting them). */
export function deleteToSelect(sql: string): string {
  const m = /^\s*DELETE\s+FROM\s+([\w$#@."]+)(\s+\w+)?([\s\S]*)$/i.exec(clean(sql));
  if (!m) { throw new Error('Put the cursor in a DELETE FROM statement.'); }
  return `SELECT *\n  FROM ${m[1]}${m[2] ?? ''}${m[3]}`;
}
/** UPDATE t SET … WHERE … → SELECT * FROM t WHERE … (see the rows before changing them). */
export function updateToSelect(sql: string): string {
  const s = clean(sql); const m = /^\s*UPDATE\s+([\w$#@."]+)(\s+(?!SET\b)\w+)?\s+SET\b/i.exec(s);
  if (!m) { throw new Error('Put the cursor in an UPDATE … SET statement.'); }
  const where = /\bWHERE\b[\s\S]*$/i.exec(s.slice(m[0].length));
  return `SELECT *\n  FROM ${m[1]}${m[2] ?? ''}${where ? '\n ' + where[0] : ''}`;
}

const addColumns = (sql: string, cols: string[]): string => {
  const s = clean(sql); const t = parseCreateTable(s);
  const at = s.lastIndexOf(')'); if (at < 0) { throw new Error('Put the cursor in a CREATE TABLE statement.'); }
  const have = new Set(t.columns.map(c => c.name.toUpperCase()));
  const add = cols.filter(c => !have.has(c.split(/\s/)[0].toUpperCase()));
  return add.length ? `${s.slice(0, at).trimEnd()},\n${add.map(c => '  ' + c).join(',\n')}\n${s.slice(at)}` : s;
};
/** Who created and changed each row, and when — filled by Db2. */
export const addAuditColumns = (sql: string): string => addColumns(sql, [
  'CREATED_AT TIMESTAMP NOT NULL DEFAULT CURRENT TIMESTAMP', 'CREATED_BY VARCHAR(18) NOT NULL DEFAULT USER',
  'CHANGED_AT TIMESTAMP NOT NULL GENERATED ALWAYS FOR EACH ROW ON UPDATE AS ROW CHANGE TIMESTAMP',
]);
/** An identity column numbered by Db2. */
export const addIdentityColumn = (sql: string, column = 'ID'): string => addColumns(sql, [`${ident(column, 'column')} BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1)`]);
/** DROP TABLE … IF EXISTS for a CREATE TABLE (IBM i 7.4 and later). */
export const dropForCreate = (sql: string): string => `DROP TABLE ${parseCreateTable(sql).table} IF EXISTS`;

export function procedureSkeleton(nameIn: string): string {
  const n = ident(nameIn, 'procedure');
  return `CREATE OR REPLACE PROCEDURE ${n} (\n  IN  P_ID     INTEGER,\n  OUT P_STATUS VARCHAR(100)\n)\nLANGUAGE SQL\nMODIFIES SQL DATA\nSET OPTION COMMIT = *NONE, DBGVIEW = *SOURCE\nBEGIN\n  DECLARE EXIT HANDLER FOR SQLEXCEPTION\n  BEGIN\n    GET DIAGNOSTICS CONDITION 1 P_STATUS = MESSAGE_TEXT;\n  END;\n\n  -- the work\n  SET P_STATUS = 'OK';\nEND`;
}
export function functionSkeleton(nameIn: string): string {
  const n = ident(nameIn, 'function');
  return `CREATE OR REPLACE FUNCTION ${n} (\n  P_VALUE VARCHAR(100)\n)\nRETURNS VARCHAR(100)\nLANGUAGE SQL\nDETERMINISTIC\nNO EXTERNAL ACTION\nRETURN UPPER(TRIM(P_VALUE))`;
}
/** An audit trigger: every insert, update and delete of the table written to TABLE_AUDIT. */
export function auditTrigger(sql: string): string {
  const t = parseCreateTable(sql); const base = t.table.split('.').pop()!.replace(/"/g, ''); const schema = t.table.includes('.') ? t.table.split('.')[0] + '.' : '';
  const key = (t.columns.find(c => c.key) ?? t.columns[0]).name;
  return `CREATE TABLE ${schema}${base}_AUDIT (\n  ACTION CHAR(1) NOT NULL,\n  KEY_VALUE VARCHAR(100),\n  CHANGED_AT TIMESTAMP NOT NULL DEFAULT CURRENT TIMESTAMP,\n  CHANGED_BY VARCHAR(18) NOT NULL DEFAULT USER\n);\n\n` +
    `CREATE OR REPLACE TRIGGER ${schema}${base}_AUDIT_TRG\n  AFTER INSERT OR UPDATE OR DELETE ON ${t.table}\n  REFERENCING NEW AS N OLD AS O\n  FOR EACH ROW MODE DB2ROW\nBEGIN\n` +
    `  IF INSERTING THEN INSERT INTO ${schema}${base}_AUDIT (ACTION, KEY_VALUE) VALUES ('I', VARCHAR(N.${key}));\n` +
    `  ELSEIF UPDATING THEN INSERT INTO ${schema}${base}_AUDIT (ACTION, KEY_VALUE) VALUES ('U', VARCHAR(N.${key}));\n` +
    `  ELSE INSERT INTO ${schema}${base}_AUDIT (ACTION, KEY_VALUE) VALUES ('D', VARCHAR(O.${key}));\n  END IF;\nEND`;
}

/** The table of a statement (after FROM, INTO, UPDATE, TABLE or ON). */
export function statementTable(sql: string): { schema?: string; table: string } {
  const m = /\b(?:FROM|INTO|UPDATE|TABLE|ON)\s+(?:("?[\w$#@]+"?)\.)?("?[\w$#@]+"?)/i.exec(clean(sql));
  if (!m || /^(SELECT|TABLE)$/i.test(m[2])) { throw new Error('No table found in the statement.'); }
  return { schema: m[1]?.toUpperCase().replace(/"/g, ''), table: m[2].toUpperCase().replace(/"/g, '') };
}
/** Rows that have the same values in the given columns. */
export function findDuplicates(sql: string, columns: string): string {
  const { schema, table } = statementTable(sql); const cols = columns.split(',').map(c => c.trim()).filter(Boolean).map(c => ident(c, 'column'));
  if (!cols.length) { throw new Error('Give the columns that should be unique.'); }
  return `SELECT ${cols.join(', ')}, COUNT(*) AS ROWS\n  FROM ${schema ? schema + '.' : ''}${table}\n GROUP BY ${cols.join(', ')}\nHAVING COUNT(*) > 1\n ORDER BY ROWS DESC`;
}
/** A filter on the last n days added to a SELECT (AND when it has a WHERE). */
export function lastDays(sql: string, column: string, days: number): string {
  const s = clean(sql); const col = ident(column, 'column'); const d = Math.max(1, Math.floor(days || 7));
  const cond = `${col} >= CURRENT TIMESTAMP - ${d} DAYS`;
  const tail = /\s+(GROUP\s+BY|ORDER\s+BY|FETCH\s+FIRST|OFFSET|LIMIT)\b[\s\S]*$/i.exec(s);
  const head = tail ? s.slice(0, tail.index) : s; const rest = tail ? tail[0] : '';
  return /\bWHERE\b/i.test(head) ? `${head}\n   AND ${cond}${rest}` : `${head}\n WHERE ${cond}${rest}`;
}
/** Who has the table locked right now (QSYS2.OBJECT_LOCK_INFO). */
export function whoLocksTable(sql: string): string {
  const { schema, table } = statementTable(sql);
  return `SELECT JOB_NAME, LOCK_STATE, LOCK_STATUS, LOCK_SCOPE\n  FROM QSYS2.OBJECT_LOCK_INFO\n WHERE ${schema ? `SYSTEM_OBJECT_SCHEMA = '${schema}'` : `SYSTEM_OBJECT_SCHEMA IN (SELECT SCHEMA_NAME FROM QSYS2.LIBRARY_LIST_INFO)`}\n   AND SYSTEM_OBJECT_NAME = '${table}'`;
}
/** Size, rows and deleted rows of the table (QSYS2.SYSTABLESTAT). */
export function tableSize(sql: string): string {
  const { schema, table } = statementTable(sql);
  return `SELECT TABLE_SCHEMA, TABLE_NAME, NUMBER_ROWS, NUMBER_DELETED_ROWS, DATA_SIZE, LAST_CHANGE_TIMESTAMP\n  FROM QSYS2.SYSTABLESTAT\n WHERE ${schema ? `TABLE_SCHEMA = '${schema}'` : `TABLE_SCHEMA IN (SELECT SCHEMA_NAME FROM QSYS2.LIBRARY_LIST_INFO)`}\n   AND (TABLE_NAME = '${table}' OR SYSTEM_TABLE_NAME = '${table}')`;
}
