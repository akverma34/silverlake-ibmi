// RPG snippets of the Developer Toolbox (3.3, second batch): ready-to-adapt code for the things RPG programs do
// every day — IFS files, data areas and queues, job log messages, timing, commitment control, JSON and CSV from
// variables, getters and setters. Pure functions (no vscode import), unit tested.
import { parseDecls } from '../core/devTools2';

const name = (v: string, what: string): string => {
  const u = v.trim();
  if (!/^[A-Za-z_$#@][\w$#@]{0,9}$/.test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const block = (indent: string, ls: string[]) => ls.map(l => l ? indent + l : '').join('\n');
const quote = (s: string) => s.replace(/'/g, "''");

/** A date converted from one format to another: %char(%date(x: *ymd): *iso). */
export function dateConversion(variable: string, from: string, to: string, indent = ''): string {
  const f = from.trim().toLowerCase().replace(/^\*?/, '*'); const t = to.trim().toLowerCase().replace(/^\*?/, '*');
  const ok = /^\*(iso|usa|eur|jis|ymd|mdy|dmy|cymd|cmdy|cdmy|lonjul|jul|ymd0|mdy0|dmy0|iso0|usa0|eur0|jis0|cymd0|cmdy0|cdmy0)$/;
  if (!ok.test(f) || !ok.test(t)) { throw new Error('Formats are RPG date formats such as *ISO, *YMD, *CYMD, *USA, *EUR.'); }
  return block(indent, [`// ${variable} from ${f.toUpperCase()} to ${t.toUpperCase()}`, `monitor;`, `  result = %char(%date(${variable}: ${f}): ${t});`, `on-error;`, `  // ${variable} is not a valid ${f.toUpperCase()} date`, `endmon;`]);
}

/** Lines written to an IFS file with SQL (QSYS2.IFS_WRITE_UTF8): replace once, then append. */
export function ifsWrite(path: string, indent = ''): string {
  const p = path.trim() || '/home/USER/out.txt';
  return block(indent, [
    `dcl-s ifsPath varchar(256) inz('${quote(p)}');`, `dcl-s ifsLine varchar(4096);`, ``,
    `ifsLine = 'first line';`,
    `exec sql call qsys2.ifs_write_utf8(path_name => :ifsPath, line => :ifsLine, overwrite => 'REPLACE', end_of_line => 'LF');`,
    `ifsLine = 'next line';`,
    `exec sql call qsys2.ifs_write_utf8(path_name => :ifsPath, line => :ifsLine, overwrite => 'APPEND', end_of_line => 'LF');`,
    `if sqlcode < 0;`, `  // the folder does not exist, or no authority (SQLSTATE in sqlstate)`, `endif;`,
  ]);
}

/** The lines of an IFS file read with SQL (QSYS2.IFS_READ_UTF8) in a cursor loop. */
export function ifsRead(path: string, indent = ''): string {
  const p = path.trim() || '/home/USER/in.txt';
  return block(indent, [
    `dcl-s ifsLine varchar(4096);`, ``,
    `exec sql declare ifsLines cursor for`, `  select line from table(qsys2.ifs_read_utf8(path_name => '${quote(p)}'));`,
    `exec sql open ifsLines;`, `dow 1 = 1;`, `  exec sql fetch next from ifsLines into :ifsLine;`, `  if sqlcode <> 0;`, `    leave;`, `  endif;`,
    `  // process ifsLine`, `enddo;`, `exec sql close ifsLines;`,
  ]);
}

/** A CL command run from RPG with QSYS2.QCMDEXC (quotes doubled). */
export function clFromRpg(command: string, indent = ''): string {
  const c = command.trim().replace(/\s+/g, ' ');
  if (!c) { throw new Error('Select the CL command first.'); }
  return block(indent, [`exec sql call qsys2.qcmdexc('${quote(c)}');`, `if sqlcode < 0;`, `  // the command failed: the CPF message is in the job log`, `endif;`]);
}

/** A data area read and written with a data area data structure (IN / OUT). */
export function dataArea(area: string, indent = ''): string {
  const a = name(area, 'data area').toUpperCase();
  return block(indent, [
    `dcl-ds ${a.toLowerCase()}Area dtaara('${a}') qualified;`, `  value char(100);`, `end-ds;`, ``,
    `in *lock ${a.toLowerCase()}Area;   // read and keep it locked`, `// change ${a.toLowerCase()}Area.value`, `out ${a.toLowerCase()}Area;         // write it back and release the lock`,
  ]);
}

/** Prototypes and calls of QSNDDTAQ and QRCVDTAQ for a data queue. */
export function dataQueue(queue: string, library: string, indent = ''): string {
  const q = name(queue, 'data queue').toUpperCase(); const l = (library.trim() || '*LIBL').toUpperCase();
  return block(indent, [
    `dcl-pr sndDtaq extpgm('QSNDDTAQ');`, `  queue char(10) const;`, `  library char(10) const;`, `  length packed(5:0) const;`, `  data char(32767) const options(*varsize);`, `end-pr;`,
    `dcl-pr rcvDtaq extpgm('QRCVDTAQ');`, `  queue char(10) const;`, `  library char(10) const;`, `  length packed(5:0);`, `  data char(32767) options(*varsize);`, `  wait packed(5:0) const;`, `end-pr;`,
    `dcl-s entry char(100);`, `dcl-s entryLen packed(5:0);`, ``,
    `sndDtaq('${q}': '${l}': %len(entry): entry);`,
    `rcvDtaq('${q}': '${l}': entryLen: entry: 30);   // wait up to 30 seconds; entryLen = 0 means nothing came`,
  ]);
}

/** A message sent to the job log (QMHSNDPM, CPF9898 *INFO) from RPG. */
export function jobLogMessage(text: string, indent = ''): string {
  return block(indent, [
    `dcl-pr sndPgmMsg extpgm('QMHSNDPM');`, `  msgId char(7) const;`, `  msgFile char(20) const;`, `  msgData char(512) const options(*varsize);`, `  msgDataLen int(10) const;`,
    `  msgType char(10) const;`, `  callStack char(10) const;`, `  callStackCtr int(10) const;`, `  msgKey char(4);`, `  error char(8);`, `end-pr;`,
    `dcl-s msgKey char(4);`, `dcl-s apiError char(8) inz(*allx'00');`, `dcl-s logText varchar(512);`, ``,
    `logText = '${quote(text.trim() || 'Step done')}';`,
    `sndPgmMsg('CPF9898': 'QCPFMSG   *LIBL': logText: %len(logText): '*INFO': '*': 0: msgKey: apiError);`,
  ]);
}

/** How long a part of the program takes, in milliseconds. */
export const elapsedTime = (indent = ''): string => block(indent, [
  `dcl-s started timestamp;`, `dcl-s elapsedMs int(20);`, ``, `started = %timestamp();`, `// … the code to measure …`,
  `elapsedMs = %diff(%timestamp(): started: *mseconds) / 1000;`, `dsply ('Took ' + %char(elapsedMs) + ' ms');`,
]);

/** Changes under commitment control: commit when all went well, roll back otherwise. */
export const commitBlock = (indent = ''): string => block(indent, [
  `// The files must be journaled and opened with commit (DCL-F … COMMIT) or SQL with COMMIT(*CHG).`,
  `monitor;`, `  // … the changes that belong together …`, `  exec sql commit;`, `on-error;`, `  exec sql rollback;`, `  // tell the caller what failed`, `endmon;`,
]);

/** A value looked up in a sorted array with %LOOKUP (and SORTA first). */
export function arrayLookup(array: string, value: string, indent = ''): string {
  const a = name(array, 'array'); const v = value.trim() || 'searchValue';
  return block(indent, [`dcl-s at int(10);`, ``, `sorta ${a};                       // %lookup with *eq on a sorted array is a binary search`, `at = %lookup(${v}: ${a});`, `if at > 0;`, `  // found: ${a}(at)`, `else;`, `  // not found`, `endif;`]);
}

/** A delimited line (CSV) built from the selected variables. */
export function csvLine(decls: string, separator = ';', target = 'csv'): string {
  const d = parseDecls(decls);
  const part = (x: { name: string; type: string }) => /^(char|varchar)\b/i.test(x.type) ? `%trim(${x.name})` : /^(date|time|timestamp)\b/i.test(x.type) ? `%char(${x.name}: *iso)` : `%char(${x.name})`;
  return `${d[0].indent}${target} = ${d.map(part).join(` + '${quote(separator)}'\n${d[0].indent}    + `)};`;
}

/** A JSON object built by SQL (JSON_OBJECT) from the selected variables. */
export function jsonObject(decls: string, target = 'json'): string {
  const d = parseDecls(decls); const i = d[0].indent;
  return [`${i}exec sql values json_object(`, ...d.map((x, n) => `${i}    '${x.name}' value :${x.name}${n < d.length - 1 ? ',' : ''}`), `${i}  ) into :${target};`].join('\n');
}

/** A getter and a setter procedure for each selected global variable. */
export function gettersSetters(decls: string): string {
  const d = parseDecls(decls);
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  return d.flatMap(x => {
    const t = x.type.replace(/\s+inz(\([^)]*\))?/i, '').trim();
    return [
      `dcl-proc get${cap(x.name)} export;`, `  dcl-pi *n ${t};`, `  end-pi;`, `  return ${x.name};`, `end-proc;`, ``,
      `dcl-proc set${cap(x.name)} export;`, `  dcl-pi *n;`, `    newValue ${t} const;`, `  end-pi;`, `  ${x.name} = newValue;`, `end-proc;`, ``,
    ];
  }).join('\n').trimEnd();
}

/** A retry loop: try up to n times, waiting between tries (DLYJOB). */
export function retryLoop(times = 3, seconds = 5, indent = ''): string {
  return block(indent, [
    `dcl-s try int(10);`, ``, `for try = 1 to ${times};`, `  monitor;`, `    // … the step that can fail (a lock, a busy object) …`, `    leave;`,
    `  on-error;`, `    if try = ${times};`, `      // give up: tell the caller`, `    else;`, `      exec sql call qsys2.qcmdexc('DLYJOB DLY(${seconds})');`, `    endif;`, `  endmon;`, `endfor;`,
  ]);
}

/** An e-mail sent with SNDSMTPEMM (the SMTP server must be set up on the IBM i). */
export function sendEmail(to: string, indent = ''): string {
  const t = to.trim() || 'someone@example.com';
  return block(indent, [
    `dcl-s mailCmd varchar(2000);`, ``,
    `mailCmd = 'SNDSMTPEMM RCP((''${quote(t)}'')) SUBJECT(''Report ready'') NOTE(''The nightly report is ready.'') CONTENT(*PLAIN)';`,
    `exec sql call qsys2.qcmdexc(:mailCmd);`, `if sqlcode < 0;`, `  // SMTP not set up, or the address is refused: see the job log`, `endif;`,
  ]);
}
