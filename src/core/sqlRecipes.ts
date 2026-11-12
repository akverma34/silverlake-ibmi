// SQL recipes of the Developer Toolbox (3.3, third batch): the analytic queries people search the web for — top rows per
// group, running totals, the previous row, percent of total, pivots, value lists, comparing two tables, deleting
// duplicates, gaps in a numbering and a hierarchy. Pure functions (no vscode import), unit tested.
import { statementTable } from './sqlBuilders';

const clean = (sql: string) => sql.trim().replace(/;\s*$/, '');
const ID = '("[^"]+"|[A-Za-z_$#@][\\w$#@]*)';
const ident = (v: string, what: string) => { const u = v.trim(); if (!new RegExp(`^${ID}(\\.${ID})?$`).test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); } return u.toUpperCase(); };
const list = (v: string, what: string) => { const l = v.split(',').map(x => x.trim()).filter(Boolean).map(x => ident(x, what)); if (!l.length) { throw new Error(`Give the ${what} name(s).`); } return l; };
const orderList = (v: string) => {
  const l = v.split(',').map(x => x.trim()).filter(Boolean).map(x => { const m = /^(.+?)(\s+(ASC|DESC))?$/i.exec(x)!; return ident(m[1], 'column') + (m[3] ? ' ' + m[3].toUpperCase() : ''); });
  if (!l.length) { throw new Error('Give the column(s) to order by.'); } return l;
};
const select = (sql: string) => { const s = clean(sql); if (!/^\s*(WITH|SELECT|VALUES)\b/i.test(s)) { throw new Error('Put the cursor in a SELECT statement.'); } return s; };
const nest = (s: string, pad: string) => s.split('\n').map(l => pad + l).join('\n');
const table = (sql: string) => { const t = statementTable(sql); return (t.schema ? t.schema + '.' : '') + t.table; };

/** The first n rows of each group (ROW_NUMBER … PARTITION BY). */
export function topPerGroup(sql: string, group: string, order: string, n = 1): string {
  const g = list(group, 'column').join(', '); const o = orderList(order).join(', '); const k = Math.max(1, Math.floor(n || 1));
  return `SELECT *\n  FROM (\n    SELECT X.*, ROW_NUMBER() OVER (PARTITION BY ${g} ORDER BY ${o}) AS RN\n      FROM (\n${nest(select(sql), '        ')}\n      ) X\n  ) Y\n WHERE RN <= ${k}\n ORDER BY ${g}, RN`;
}
/** A running total of a column (SUM … OVER … ROWS UNBOUNDED PRECEDING), optionally restarted for each group. */
export function runningTotal(sql: string, value: string, order: string, group = ''): string {
  const v = ident(value, 'column'); const o = orderList(order).join(', '); const g = group.trim() ? `PARTITION BY ${list(group, 'column').join(', ')} ` : '';
  return `SELECT X.*,\n       SUM(${v}) OVER (${g}ORDER BY ${o} ROWS UNBOUNDED PRECEDING) AS RUNNING_TOTAL\n  FROM (\n${nest(select(sql), '    ')}\n  ) X\n ORDER BY ${g ? list(group, 'column').join(', ') + ', ' : ''}${o}`;
}
/** The value of the previous row and the change since it (LAG). */
export function previousRow(sql: string, value: string, order: string): string {
  const v = ident(value, 'column'); const o = orderList(order).join(', '); const base = v.replace(/"/g, '').split('.').pop();
  return `SELECT X.*,\n       LAG(${v}) OVER (ORDER BY ${o}) AS PREVIOUS_${base},\n       ${v} - LAG(${v}) OVER (ORDER BY ${o}) AS CHANGE_${base}\n  FROM (\n${nest(select(sql), '    ')}\n  ) X\n ORDER BY ${o}`;
}
/** Each row's share of the total of a column, in percent. */
export function percentOfTotal(sql: string, value: string): string {
  const v = ident(value, 'column');
  return `SELECT X.*,\n       DECIMAL(${v} * 100.0 / NULLIF(SUM(${v}) OVER (), 0), 7, 2) AS PERCENT_OF_TOTAL\n  FROM (\n${nest(select(sql), '    ')}\n  ) X\n ORDER BY PERCENT_OF_TOTAL DESC`;
}
/** One column per value (SUM(CASE WHEN …)), one row per group. */
export function pivot(sql: string, group: string, column: string, values: string, measure: string): string {
  const g = list(group, 'column'); const c = ident(column, 'column'); const m = ident(measure, 'column');
  const vs = values.split(',').map(x => x.trim()).filter(Boolean);
  if (!vs.length) { throw new Error('Give the values that become columns (comma-separated).'); }
  const lit = (x: string) => /^-?\d+(\.\d+)?$/.test(x) ? x : `'${x.replace(/^'|'$/g, '').replace(/'/g, "''")}'`;
  const alias = (x: string) => `"${x.replace(/^'|'$/g, '').replace(/"/g, '').toUpperCase()}"`;
  return `SELECT ${g.join(', ')},\n${vs.map(x => `       SUM(CASE WHEN ${c} = ${lit(x)} THEN ${m} ELSE 0 END) AS ${alias(x)}`).join(',\n')},\n       SUM(${m}) AS TOTAL\n  FROM (\n${nest(select(sql), '    ')}\n  ) X\n GROUP BY ${g.join(', ')}\n ORDER BY ${g.join(', ')}`;
}
/** The values of a column as one comma-separated list per group (LISTAGG). */
export function valueList(sql: string, group: string, column: string): string {
  const g = list(group, 'column').join(', '); const c = ident(column, 'column'); const base = c.replace(/"/g, '').split('.').pop();
  return `SELECT ${g},\n       COUNT(*) AS ROWS,\n       LISTAGG(CAST(${c} AS VARCHAR(1000)), ', ') WITHIN GROUP (ORDER BY ${c}) AS ${base}_LIST\n  FROM (\n${nest(select(sql), '    ')}\n  ) X\n GROUP BY ${g}\n ORDER BY ${g}`;
}
/** The rows found in only one of two tables of the same layout (EXCEPT both ways). */
export function compareTables(sql: string, other: string): string {
  const a = table(sql); const b = ident(other, 'table');
  return `SELECT 'ONLY IN ${a}' AS FOUND, A.*\n  FROM (SELECT * FROM ${a} EXCEPT SELECT * FROM ${b}) A\nUNION ALL\nSELECT 'ONLY IN ${b}' AS FOUND, B.*\n  FROM (SELECT * FROM ${b} EXCEPT SELECT * FROM ${a}) B`;
}
/** Duplicates deleted, keeping the first row (lowest RRN) of each key — with the preview SELECT first. */
export function deleteDuplicates(sql: string, key: string): string {
  const t = table(sql); const k = list(key, 'column');
  const cond = `RRN(A) > (SELECT MIN(RRN(B)) FROM ${t} B WHERE ${k.map(c => `B.${c} = A.${c}`).join(' AND ')})`;
  return `-- 1. The rows that would be deleted (all but the first of each ${k.join(', ')}):\nSELECT RRN(A) AS RRN, A.*\n  FROM ${t} A\n WHERE ${cond};\n\n-- 2. Delete them (rows with a null key are kept):\nDELETE FROM ${t} A\n WHERE ${cond}`;
}
/** The ranges of numbers missing in a numbered column (gaps). */
export function numberGaps(sql: string, column: string): string {
  const t = table(sql); const c = ident(column, 'column');
  return `SELECT N + 1 AS FIRST_MISSING, NEXT_N - 1 AS LAST_MISSING, NEXT_N - N - 1 AS HOW_MANY\n  FROM (\n    SELECT ${c} AS N, LEAD(${c}) OVER (ORDER BY ${c}) AS NEXT_N\n      FROM ${t}\n  ) X\n WHERE NEXT_N > N + 1\n ORDER BY N`;
}
/** A parent / child table read as a tree (recursive common table expression). */
export function hierarchy(tableName: string, id: string, parent: string): string {
  const t = ident(tableName, 'table'); const i = ident(id, 'column'); const p = ident(parent, 'column');
  return `WITH TREE (LVL, ID, PARENT, PATH) AS (\n  SELECT 1, ${i}, ${p}, CAST(VARCHAR(${i}) AS VARCHAR(2000))\n    FROM ${t}\n   WHERE ${p} IS NULL\n  UNION ALL\n  SELECT TREE.LVL + 1, C.${i}, C.${p}, TREE.PATH || ' > ' || VARCHAR(C.${i})\n    FROM TREE\n    JOIN ${t} C ON C.${p} = TREE.ID\n   WHERE TREE.LVL < 50\n)\nSELECT LVL, REPEAT('  ', LVL - 1) || VARCHAR(ID) AS NODE, PATH\n  FROM TREE\n ORDER BY PATH`;
}
