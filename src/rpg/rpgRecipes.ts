// RPG recipes of the Developer Toolbox (3.3, third batch): SQL error checks after every EXEC SQL, GET DIAGNOSTICS,
// splitting a text, FOR-EACH, sorting a data structure array, month and date arithmetic, SND-MSG, a multi-row FETCH
// and a check that an object exists. Pure functions (no vscode import), unit tested.

const name = (v: string, what: string): string => {
  const u = v.trim();
  if (!/^[A-Za-z_$#@][\w$#@]*$/.test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const sysName = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!/^(\*LIBL|\*CURLIB|\*ALL|[A-Z$#@][A-Z0-9$#@_.]{0,9})$/.test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const block = (indent: string, ls: string[]) => ls.map(l => l ? indent + l : '').join('\n');
const quote = (s: string) => s.replace(/'/g, "''");

/** Statements that do not need an SQLSTATE check after them. */
const NO_CHECK = /^\s*exec\s+sql\s+(declare|set\s+option|include|whenever|begin\s+declare|end\s+declare)\b/i;

/**
 * An SQLSTATE check added after every EXEC SQL statement of the text (free format) that has none yet: errors are the
 * SQLSTATE classes after '02' (00 is success, 01 a warning, 02 no row).
 */
export function addSqlStateChecks(text: string): { text: string; added: number } {
  const ls = text.split('\n'); const out: string[] = []; let added = 0;
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (!/^\s*exec\s+sql\b/i.test(line) || NO_CHECK.test(line)) { out.push(line); continue; }
    const indent = /^\s*/.exec(line)![0];
    let j = i;
    while (j < ls.length && !/;\s*(\/\/.*)?\r?$/.test(ls[j])) { j++; }
    if (j >= ls.length) { out.push(line); continue; }
    for (let k = i; k <= j; k++) { out.push(ls[k]); }
    let n = j + 1; while (n < ls.length && !ls[n].trim()) { n++; }
    const checked = n < ls.length && /\b(sqlstate|sqlstt|sqlcode|sqlcod|sqler)/i.test(ls[n]);
    if (!checked) {
      const cr = ls[j].endsWith('\r') ? '\r' : '';
      out.push(`${indent}if %subst(sqlstate: 1: 2) > '02';${cr}`, `${indent}  // SQL error: the message is in the job log (or use GET DIAGNOSTICS)${cr}`, `${indent}endif;${cr}`);
      added++;
    }
    i = j;
  }
  return { text: out.join('\n'), added };
}

/** The message text and SQLSTATE of the last SQL statement (GET DIAGNOSTICS). */
export const getDiagnostics = (indent = ''): string => block(indent, [
  `dcl-s sqlMessage varchar(1000);`, `dcl-s sqlState2 char(5);`, ``,
  `exec sql get diagnostics condition 1 :sqlMessage = message_text, :sqlState2 = returned_sqlstate;`,
  `// sqlMessage: the text of the error or warning of the last SQL statement`,
]);

/** A text split into an array at each separator (a %SCAN loop that works on every release). */
export function splitText(variable: string, separator = ';', indent = ''): string {
  const v = name(variable, 'variable'); const sep = quote(separator || ';');
  return block(indent, [
    `dcl-s parts varchar(256) dim(100);`, `dcl-s partCount int(10);`, `dcl-s rest varchar(32000);`, `dcl-s startAt int(10);`, `dcl-s at int(10);`, ``,
    `// 7.4 TR and later also: for-each part in %split(${v}: '${sep}');`,
    `rest = %trimr(${v});`, `startAt = 1;`, `partCount = 0;`,
    `dow partCount < %elem(parts);`,
    `  partCount += 1;`,
    `  at = %scan('${sep}': rest: startAt);`,
    `  if at = 0;`, `    if startAt <= %len(rest);`, `      parts(partCount) = %subst(rest: startAt);`, `    endif;`, `    leave;`, `  endif;`,
    `  parts(partCount) = %subst(rest: startAt: at - startAt);`,
    `  startAt = at + ${(separator || ';').length};`,
    `enddo;`,
  ]);
}

/** A FOR-EACH loop over an array (7.4 TR and later). */
export function forEachLoop(array: string, indent = ''): string {
  const a = name(array, 'array'); const item = `${a}Item`;
  return block(indent, [`dcl-s ${item} like(${a});   // one element of ${a}`, ``, `for-each ${item} in ${a};`, `  // process ${item}`, `endfor;`]);
}

/** A data structure array sorted by one of its subfields. */
export function sortDsArray(array: string, subfield: string, indent = ''): string {
  const a = name(array, 'data structure array'); const f = name(subfield, 'subfield');
  return block(indent, [
    `sorta ${a}(*).${f};                       // ascending by ${f}`,
    `// sorta(d) ${a}(*).${f};                 // descending`,
    `// sorta %subarr(${a}(*).${f}: 1: count); // only the elements in use`,
  ]);
}

/** The first and last day of the month of a date. */
export function monthBounds(date: string, indent = ''): string {
  const d = name(date, 'date variable');
  return block(indent, [
    `dcl-s firstDay date;`, `dcl-s lastDay date;`, ``,
    `firstDay = ${d} - %days(%subdt(${d}: *days) - 1);`,
    `lastDay = firstDay + %months(1) - %days(1);`,
  ]);
}

/** Days, months and years between two dates. */
export function dateDifference(from: string, to: string, indent = ''): string {
  const f = name(from, 'date variable'); const t = name(to, 'date variable');
  return block(indent, [
    `dcl-s daysBetween int(10);`, `dcl-s monthsBetween int(10);`, `dcl-s yearsBetween int(10);`, ``,
    `daysBetween = %diff(${t}: ${f}: *days);`,
    `monthsBetween = %diff(${t}: ${f}: *months);   // whole months`,
    `yearsBetween = %diff(${t}: ${f}: *years);     // whole years (an age)`,
  ]);
}

/** SND-MSG: a message to the job log, or an escape message that ends the program (7.4 TR and later). */
export function sendMessage(text: string, indent = ''): string {
  const t = quote(text.trim() || 'Step done');
  return block(indent, [
    `snd-msg '${t}';                                          // *INFO in the job log`,
    `// snd-msg *escape %msg('CPF9898': 'QCPFMSG': '${t}');   // end with an error for the caller`,
  ]);
}

/** A cursor read 100 rows at a time into a data structure array (multi-row FETCH). */
export function multiRowFetch(select: string, indent = ''): string {
  const s = select.trim().replace(/;\s*$/, '') || 'select * from mytable';
  return block(indent, [
    `dcl-ds rows qualified dim(100);`, `  // the columns of the SELECT, in the same order`, `end-ds;`, `dcl-s fetched int(10);`, `dcl-s r int(10);`, ``,
    `exec sql declare rowsCur cursor for`, ...s.split('\n').map(l => '  ' + l.trim()), `  for read only;`,
    `exec sql open rowsCur;`,
    `dou fetched < %elem(rows);`,
    `  exec sql fetch next from rowsCur for 100 rows into :rows;`,
    `  if sqlcode < 0;`, `    leave;`, `  endif;`,
    `  exec sql get diagnostics :fetched = row_count;`,
    `  for r = 1 to fetched;`, `    // process rows(r)`, `  endfor;`,
    `enddo;`,
    `exec sql close rowsCur;`,
  ]);
}

/** Does an object exist? (SQL OBJECT_STATISTICS, no API to declare). */
export function objectExists(library: string, object: string, type = '*PGM', indent = ''): string {
  const l = sysName(library || '*LIBL', 'library'); const o = sysName(object, 'object'); const t = '*' + type.trim().toUpperCase().replace(/^\*/, '');
  if (!/^\*[A-Z]{2,10}$/.test(t)) { throw new Error(`"${type}" is not an object type such as *PGM or *FILE.`); }
  return block(indent, [
    `dcl-s objFound int(10);`, ``,
    `exec sql select count(*) into :objFound`,
    `  from table(qsys2.object_statistics('${l}', '${t}')) o`,
    `  where o.objname = '${o}';`,
    `if objFound = 0;`, `  // ${o} ${t} is not in ${l}`, `endif;`,
  ]);
}
