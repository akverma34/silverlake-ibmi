// CL snippets of the Developer Toolbox (3.3, second batch): a program skeleton, retries, object locks, submitting a
// command, copying a file, saving to a save file, date conversion, SQL from CL, an inquiry message and RTVOBJD.
// Pure functions (no vscode import), unit tested.

const name = (v: string, what: string) => { const u = v.trim().toUpperCase(); if (!/^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); } return u; };
const qualified = (v: string, what: string) => { const p = v.trim().toUpperCase().split('/'); const n = name(p.pop()!, what); return { lib: p.length ? name(p[0], 'library') : '*LIBL', name: n }; };
const quote = (s: string) => s.replace(/'/g, "''");

/** A CL program: parameters, declarations, a global MONMSG that sends the error on, and the end. */
export const clProgram = (): string => [
  'PGM PARM(&LIB)', '  DCL VAR(&LIB) TYPE(*CHAR) LEN(10)', '  DCL VAR(&MSGID) TYPE(*CHAR) LEN(7)', '  DCL VAR(&MSGDTA) TYPE(*CHAR) LEN(256)', '  DCL VAR(&MSGF) TYPE(*CHAR) LEN(10)', '  DCL VAR(&MSGFLIB) TYPE(*CHAR) LEN(10)',
  '  MONMSG MSGID(CPF0000) EXEC(GOTO CMDLBL(ERROR))', '', '  /* the work */', '', '  RETURN', '',
  'ERROR:', '  RCVMSG MSGTYPE(*EXCP) MSGDTA(&MSGDTA) MSGID(&MSGID) MSGF(&MSGF) SNDMSGFLIB(&MSGFLIB)', '  MONMSG MSGID(CPF0000)',
  '  SNDPGMMSG MSGID(&MSGID) MSGF(&MSGFLIB/&MSGF) MSGDTA(&MSGDTA) MSGTYPE(*ESCAPE)', '  MONMSG MSGID(CPF0000)', 'ENDPGM',
].join('\n');

/** A command retried a few times with a delay (for an object that is in use). */
export function clRetry(command: string, times = 3, seconds = 10): string {
  const c = command.trim() || 'ALCOBJ OBJ((MYLIB/MYFILE *FILE *EXCL)) WAIT(0)';
  return ['DCL VAR(&TRY) TYPE(*DEC) LEN(3 0) VALUE(0) /* put it with the other DCLs */', '', 'RETRY: CHGVAR VAR(&TRY) VALUE(&TRY + 1)', c,
    `MONMSG MSGID(CPF0000) EXEC(DO)`, `  IF COND(&TRY *LT ${times}) THEN(DO)`, `    DLYJOB DLY(${seconds})`, '    GOTO CMDLBL(RETRY)', '  ENDDO', "  SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('Still failing after the retries') MSGTYPE(*ESCAPE)", 'ENDDO'].join('\n');
}
/** The selection between ALCOBJ and DLCOBJ, so nobody else uses the object meanwhile. */
export function clAllocate(selection: string, object: string, type = '*FILE', state = '*EXCL', wait = 30): string {
  const o = qualified(object, 'object'); const t = type.trim().toUpperCase().replace(/^\*?/, '*'); const s = state.trim().toUpperCase().replace(/^\*?/, '*');
  return [`ALCOBJ OBJ((${o.lib}/${o.name} ${t} ${s})) WAIT(${wait})`, `MONMSG MSGID(CPF1002) EXEC(DO)`, `  SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('${o.name} is in use') MSGTYPE(*ESCAPE)`, 'ENDDO',
    selection.replace(/\n$/, ''), `DLCOBJ OBJ((${o.lib}/${o.name} ${t} ${s}))`].join('\n');
}
/** The selected command submitted to batch. */
export function clSubmit(command: string, job = 'BATCH', jobq = 'QBATCH'): string {
  const c = command.trim().replace(/\s+/g, ' ');
  if (!c) { throw new Error('Select the command to submit first.'); }
  return `SBMJOB CMD(${c}) JOB(${name(job, 'job')}) JOBQ(${qualified(jobq, 'job queue').name})`;
}
/** A copy of a file, created when it does not exist. */
export function clCopyFile(from: string, to: string): string {
  const f = qualified(from, 'file'); const t = qualified(to, 'file');
  return `CPYF FROMFILE(${f.lib}/${f.name}) TOFILE(${t.lib}/${t.name}) MBROPT(*REPLACE) CRTFILE(*YES) FMTOPT(*NOCHK)\nMONMSG MSGID(CPF2817) /* no record copied: an empty file is fine */`;
}
/** Objects saved to a save file (created or cleared first). */
export function clSaveToSavf(library: string, savf: string): string {
  const l = name(library, 'library'); const s = qualified(savf, 'save file');
  return [`CRTSAVF FILE(${s.lib}/${s.name})`, 'MONMSG MSGID(CPF5813) EXEC(CLRSAVF FILE(' + `${s.lib}/${s.name}))`, `SAVOBJ OBJ(*ALL) LIB(${l}) DEV(*SAVF) SAVF(${s.lib}/${s.name}) DTACPR(*HIGH)`].join('\n');
}
/** A date converted between formats with CVTDAT. */
export function clConvertDate(from = '*YMD', to = '*ISO'): string {
  const f = from.trim().toUpperCase().replace(/^\*?/, '*'); const t = to.trim().toUpperCase().replace(/^\*?/, '*');
  return ['DCL VAR(&INDATE) TYPE(*CHAR) LEN(8)', 'DCL VAR(&OUTDATE) TYPE(*CHAR) LEN(10)', `CVTDAT DATE(&INDATE) TOVAR(&OUTDATE) FROMFMT(${f}) TOFMT(${t}) TOSEP(*NONE)`,
    "MONMSG MSGID(CPF0555) EXEC(SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('Not a valid date') MSGTYPE(*ESCAPE))"].join('\n');
}
/** An SQL statement run from CL with RUNSQL (quotes doubled). */
export function clRunSql(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ');
  if (!s) { throw new Error('Select the SQL statement first.'); }
  return `RUNSQL SQL('${quote(s)}') COMMIT(*NONE) NAMING(*SQL)`;
}
/** An inquiry message to the user, and the reply read back. */
export function clAskUser(question: string): string {
  const q = question.trim() || 'Continue? (Y/N)';
  return ['DCL VAR(&REPLY) TYPE(*CHAR) LEN(1)', `SNDUSRMSG MSG('${quote(q)}') VALUES(Y N) DFT(N) MSGRPY(&REPLY)`, "IF COND(&REPLY *NE 'Y') THEN(RETURN)"].join('\n');
}
/** RTVOBJD: does the object exist, and when was it last used and changed? */
export function clObjectInfo(object: string, type = '*PGM'): string {
  const o = qualified(object, 'object'); const t = type.trim().toUpperCase().replace(/^\*?/, '*');
  return ['DCL VAR(&RTNLIB) TYPE(*CHAR) LEN(10)', 'DCL VAR(&CHGDATE) TYPE(*CHAR) LEN(13)', 'DCL VAR(&USEDATE) TYPE(*CHAR) LEN(13)', 'DCL VAR(&TEXT) TYPE(*CHAR) LEN(50)',
    `RTVOBJD OBJ(${o.lib}/${o.name}) OBJTYPE(${t}) RTNLIB(&RTNLIB) CHGDATE(&CHGDATE) USEDATE(&USEDATE) TEXT(&TEXT)`,
    `MONMSG MSGID(CPF9801) EXEC(DO) /* ${o.name} does not exist */`, 'ENDDO'].join('\n');
}
