// CL recipes of the Developer Toolbox (3.3, third batch): a loop over the objects of a library, a loop over the
// members of a file, a QShell command whose failure stops the program, and a library list changed for a while and
// put back. Pure functions (no vscode import), unit tested.

const name = (v: string, what: string, generic = false) => {
  const u = v.trim().toUpperCase();
  const re = generic ? /^(\*ALL|[A-Z$#@][A-Z0-9$#@_.]{0,8}\*?|[A-Z$#@][A-Z0-9$#@_.]{0,9})$/ : /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;
  if (!re.test(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const qualified = (v: string, what: string) => { const p = v.trim().toUpperCase().split('/'); const n = name(p.pop()!, what); return { lib: p.length ? name(p[0], 'library') : '*LIBL', name: n }; };

/** A loop over the objects of a library (DSPOBJD to an outfile, then RCVF). */
export function clObjectLoop(library: string, type = '*ALL'): string {
  const l = name(library, 'library'); const t = '*' + (type.trim().toUpperCase().replace(/^\*/, '') || 'ALL');
  return [
    'DCLF FILE(QSYS/QADSPOBJ) /* with the other declarations; one DCLF per program unless OPNID is used */', '',
    `DSPOBJD OBJ(${l}/*ALL) OBJTYPE(${t}) OUTPUT(*OUTFILE) OUTFILE(QTEMP/OBJLIST)`,
    'MONMSG MSGID(CPF2123) EXEC(RETURN) /* no object of that type */',
    'OVRDBF FILE(QADSPOBJ) TOFILE(QTEMP/OBJLIST)',
    'OBJLOOP: RCVF', 'MONMSG MSGID(CPF0864) EXEC(GOTO CMDLBL(OBJDONE))',
    '  /* &ODLBNM library, &ODOBNM object, &ODOBTP type, &ODOBAT attribute, &ODOBTX text */',
    'GOTO CMDLBL(OBJLOOP)', 'OBJDONE: DLTOVR FILE(QADSPOBJ)',
  ].join('\n');
}

/** A loop over the members of a (source) file (DSPFD *MBRLIST to an outfile, then RCVF). */
export function clMemberLoop(file: string): string {
  const f = qualified(file, 'file');
  return [
    'DCLF FILE(QSYS/QAFDMBRL) /* with the other declarations; one DCLF per program unless OPNID is used */', '',
    `DSPFD FILE(${f.lib}/${f.name}) TYPE(*MBRLIST) OUTPUT(*OUTFILE) OUTFILE(QTEMP/MBRLIST)`,
    'OVRDBF FILE(QAFDMBRL) TOFILE(QTEMP/MBRLIST)',
    'MBRLOOP: RCVF', 'MONMSG MSGID(CPF0864) EXEC(GOTO CMDLBL(MBRDONE))',
    "IF COND(&MLNAME *EQ ' ') THEN(GOTO CMDLBL(MBRLOOP)) /* a file without members */",
    '  /* &MLNAME member, &MLSEU2 source type, &MLMTXT text */',
    'GOTO CMDLBL(MBRLOOP)', 'MBRDONE: DLTOVR FILE(QAFDMBRL)',
  ].join('\n');
}

/** A QShell command whose non-zero exit status sends an escape message (QSH0005) the program can monitor. */
export function clQshCommand(command: string): string {
  const c = (command.trim() || 'ls /tmp').replace(/'/g, "''");
  return [
    'ADDENVVAR ENVVAR(QIBM_QSH_CMD_ESCAPE_MSG) VALUE(Y) REPLACE(*YES)',
    'ADDENVVAR ENVVAR(QIBM_QSH_CMD_OUTPUT) VALUE(NONE) REPLACE(*YES) /* or FILE=/tmp/qsh.log */',
    `QSH CMD('${c}')`,
    'MONMSG MSGID(QSH0005 QSH0006 QSH0007) EXEC(DO)',
    "  SNDPGMMSG MSGID(CPF9898) MSGF(QCPFMSG) MSGDTA('The QShell command failed') MSGTYPE(*ESCAPE)",
    'ENDDO',
  ].join('\n');
}

/** The user part of the library list replaced for a while, then put back — even when the work fails. */
export function clLibraryListSwap(libraries: string): string {
  const libs = libraries.split(/[\s,]+/).filter(Boolean).map(l => name(l, 'library'));
  if (!libs.length) { throw new Error('Give the libraries of the new library list.'); }
  return [
    'DCL VAR(&SAVLIBL) TYPE(*CHAR) LEN(2750) /* with the other declarations */', 'DCL VAR(&CMD) TYPE(*CHAR) LEN(2800)', '',
    'RTVJOBA USRLIBL(&SAVLIBL)',
    `CHGLIBL LIBL(${libs.join(' ')})`,
    '  /* the work: follow its commands with MONMSG MSGID(CPF0000) so the library list is always put back */',
    "IF COND(&SAVLIBL *EQ ' ') THEN(CHGVAR VAR(&SAVLIBL) VALUE('*NONE'))",
    "CHGVAR VAR(&CMD) VALUE('CHGLIBL LIBL(' *CAT &SAVLIBL *TCAT ')')",
    'CALL PGM(QCMDEXC) PARM(&CMD 2800)',
  ].join('\n');
}
