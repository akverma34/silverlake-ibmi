// System Health Overview: one page that answers "is the system OK right now?" from the pages that already exist —
// disk use per ASP, limits close to their maximum, jobs waiting for a lock or for a reply, and the security score —
// each as a card with a traffic light and a link to the detail page. Also the Markdown report of the Security
// Scorecard. Pure functions (no vscode import), unit tested.
import { Contention, HeadBlocker, LimitUse, ProfileFindings, SecurityCheck, scoreGrade } from './healthInsights';
import { AspSummary, sizeLabel } from './platformInsights';

export type HealthLevel = 'ok' | 'warn' | 'bad' | 'unknown';
export type HealthArea = 'disk' | 'limits' | 'locks' | 'replies' | 'security';

/** A line of a card: an English template with {0}, {1}… (the page translates it) and its values. */
export interface Line { text: string; args: (string | number)[] }
const L = (text: string, ...args: (string | number)[]): Line => ({ text, args });

/** One card: the area, its level, the headline number and the detail lines. */
export interface HealthCard { area: HealthArea; level: HealthLevel; value: string; detail: Line[]; command: string }

const RANK: Record<HealthLevel, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 };

/** The worst level of the cards (a card that could not be read does not make the system look healthy or sick). */
export function overallLevel(cards: Pick<HealthCard, 'level'>[]): HealthLevel {
  const known = cards.filter(c => c.level !== 'unknown');
  if (!known.length) { return 'unknown'; }
  return known.reduce<HealthLevel>((w, c) => RANK[c.level] < RANK[w] ? c.level : w, 'ok');
}

/** Disk: the fullest ASP decides (90 % and more is critical, 80 % worth a look), plus uneven units. */
export function diskCard(asps: AspSummary[]): HealthCard {
  if (!asps.length) { return { area: 'disk', level: 'unknown', value: '-', detail: [L('No disk unit returned.')], command: 'vanthrex.diskUnitsMap' }; }
  const fullest = [...asps].sort((a, b) => b.pctUsed - a.pctUsed)[0];
  const level: HealthLevel = fullest.pctUsed >= 90 ? 'bad' : fullest.pctUsed >= 80 ? 'warn' : 'ok';
  const detail = asps.map(a => L('ASP {0}: {1} % used of {2}', a.asp, a.pctUsed, sizeLabel(a.capacity)));
  const uneven = asps.filter(a => a.units.length > 1 && a.spread > 10);
  if (uneven.length) { detail.push(L('Units filled unevenly in ASP {0} (STRASPBAL balances them).', uneven.map(a => a.asp).join(', '))); }
  return { area: 'disk', level: uneven.length && level === 'ok' ? 'warn' : level, value: `${fullest.pctUsed} %`, detail, command: 'vanthrex.diskUnitsMap' };
}

/** Limits: how many are at 75 % of their maximum or more; any at 90 % is critical. */
export function limitsCard(uses: LimitUse[]): HealthCard {
  const close = uses.filter(u => u.pct >= 75);
  const level: HealthLevel = close.some(u => u.pct >= 90) ? 'bad' : close.length ? 'warn' : 'ok';
  const detail = close.slice(0, 3).map(u => L('{0}: {1} %', u.where ? `${u.limit} (${u.where})` : u.limit, u.pct));
  if (!close.length) { detail.push(L('No limit at 75 % or more.')); }
  return { area: 'limits', level, value: String(close.length), detail, command: 'vanthrex.limitsWatch' };
}

/** Locks: jobs waiting for a lock now; five or more, or one job blocking three or more, is critical. */
export function locksCard(chains: { contention: Contention[]; heads: HeadBlocker[]; waiting: number }): HealthCard {
  const top = chains.heads[0];
  const level: HealthLevel = chains.waiting >= 5 || (top?.blocks ?? 0) >= 3 ? 'bad' : chains.waiting ? 'warn' : 'ok';
  const detail = chains.waiting ? [
    L('{0} object(s) or row(s) contended.', chains.contention.length),
    ...(top ? [L('Head blocker {0} blocks {1} job(s).', top.job, top.blocks)] : []),
  ] : [L('No job waits for a lock.')];
  return { area: 'locks', level, value: String(chains.waiting), detail, command: 'vanthrex.lockWaitChains' };
}

/** Jobs waiting for a reply (MSGW): every one of them is stopped until someone answers. */
export function repliesCard(jobs: string[]): HealthCard {
  return {
    area: 'replies', level: jobs.length ? 'bad' : 'ok', value: String(jobs.length),
    detail: jobs.length ? [...jobs.slice(0, 3).map(j => L('{0}', j)), ...(jobs.length > 3 ? [L('and {0} more', jobs.length - 3)] : [])] : [L('No job waits for a reply.')],
    command: 'vanthrex.jobsMap',
  };
}

/** Security: the scorecard's score; grade A or B is fine, C to review, D or E a risk. */
export function securityCard(score: number, checks: SecurityCheck[]): HealthCard {
  if (!checks.length) { return { area: 'security', level: 'unknown', value: '-', detail: [L('The security system values could not be read.')], command: 'vanthrex.securityScorecard' }; }
  const grade = scoreGrade(score);
  const risks = checks.filter(c => c.state === 'fail');
  return {
    area: 'security', level: score >= 75 ? 'ok' : score >= 60 ? 'warn' : 'bad', value: `${score} (${grade})`,
    detail: risks.length ? risks.slice(0, 3).map(c => L('{0} = {1} (recommended: {2})', c.id, c.value, c.recommended)) : [L('No security system value at risk.')],
    command: 'vanthrex.securityScorecard',
  };
}

/** SQL: the jobs waiting for a reply right now. */
export function msgwJobsSql(): string {
  return `SELECT JOB_NAME AS JOB FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) A WHERE JOB_STATUS = 'MSGW' FETCH FIRST 500 ROWS ONLY`;
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The Security Scorecard as Markdown, for an audit report, a ticket or an e-mail. */
export function scorecardMarkdown(system: string, when: string, score: number, checks: SecurityCheck[], p?: ProfileFindings): string {
  const state = { fail: 'Risk', warn: 'Review', pass: 'OK' } as const;
  const order = { fail: 0, warn: 1, pass: 2 } as const;
  const lines = [
    `# Security scorecard — ${md(system)}`, '',
    `${when} · score **${score} / 100** (grade ${scoreGrade(score)}) · ${checks.filter(c => c.state === 'fail').length} risk(s), ${checks.filter(c => c.state === 'warn').length} to review`, '',
    '| State | Check | System value | Current | Recommended |', '|---|---|---|---|---|',
    ...[...checks].sort((a, b) => order[a.state] - order[b.state] || b.weight - a.weight)
      .map(c => `| ${state[c.state]} | ${md(c.title)} | ${c.id} | \`${md(c.value)}\` | ${md(c.recommended)} |`),
  ];
  if (p) {
    const list = (names: string[]) => names.length ? names.map(n => `\`${n}\``).join(', ') : 'none';
    lines.push('', `## User profiles (${p.enabled} enabled)`, '',
      `- **Enabled with *ALLOBJ (${p.allObj.length}):** ${list(p.allObj)}`,
      `- **Password older than a year (${p.oldPasswords.length}):** ${list(p.oldPasswords)}`,
      `- **Not used for 180 days (${p.idle.length}):** ${list(p.idle)}`);
  }
  lines.push('', '_Made with Vanthrex for IBM i. Recommendations follow common IBM i security guidance._', '');
  return lines.join('\n');
}
