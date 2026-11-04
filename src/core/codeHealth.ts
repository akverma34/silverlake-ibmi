// Code health of many sources at once (pure, unit tested): every check run on every indexed member of a library,
// counted by rule and by member, with a score per member so the worst ones come first — a quality gate for a
// whole application, not only the open file.

export interface MemberFindings { key: string; type: string; lines: number; findings: { rule: string; severity: string }[] }
export interface HealthSummary {
  members: number; lines: number; findings: number; errors: number; warnings: number;
  byRule: { rule: string; count: number; members: number; severity: string }[];
  worst: { key: string; type: string; lines: number; errors: number; warnings: number; infos: number; score: number }[];
  score: number; grade: string;
}

/** 100 = no findings; errors weigh 10, warnings 3, the rest 1, per 100 lines (so big members are not punished for size). */
export function memberScore(lines: number, errors: number, warnings: number, infos: number): number {
  const per100 = (errors * 10 + warnings * 3 + infos) / Math.max(1, lines / 100);
  return Math.max(0, Math.round(100 - per100 * 4));
}
export function grade(score: number): string { return score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E'; }

export function summarize(members: MemberFindings[], top = 50): HealthSummary {
  const rule = new Map<string, { count: number; members: Set<string>; severity: string }>();
  let errors = 0; let warnings = 0; let findings = 0; let lines = 0;
  const worst: HealthSummary['worst'] = [];
  for (const m of members) {
    let e = 0; let w = 0; let n = 0;
    for (const f of m.findings) {
      if (f.severity === 'hint') { continue; }
      findings++;
      if (f.severity === 'error') { e++; } else if (f.severity === 'warning') { w++; } else { n++; }
      const r = rule.get(f.rule) ?? { count: 0, members: new Set<string>(), severity: f.severity };
      r.count++; r.members.add(m.key); rule.set(f.rule, r);
    }
    errors += e; warnings += w; lines += m.lines;
    worst.push({ key: m.key, type: m.type, lines: m.lines, errors: e, warnings: w, infos: n, score: memberScore(m.lines, e, w, n) });
  }
  worst.sort((a, b) => a.score - b.score || b.errors - a.errors || b.warnings - a.warnings);
  const score = members.length ? Math.round(worst.reduce((a, x) => a + x.score * Math.max(1, x.lines), 0) / Math.max(1, worst.reduce((a, x) => a + Math.max(1, x.lines), 0))) : 100;
  return {
    members: members.length, lines, findings, errors, warnings,
    byRule: [...rule.entries()].map(([r, v]) => ({ rule: r, count: v.count, members: v.members.size, severity: v.severity })).sort((a, b) => b.count - a.count),
    worst: worst.slice(0, top), score, grade: grade(score),
  };
}
