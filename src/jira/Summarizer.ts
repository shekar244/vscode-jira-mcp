/**
 * Compiles Jira issues into a structured status summary.
 * No LLM needed — pure structured aggregation.
 */
import type { JiraIssue } from './JiraService';

export interface StatusGroup {
  label:  string;
  count:  number;
  issues: JiraIssue[];
}

export interface SprintSummary {
  title:        string;
  total:        number;
  byStatus:     StatusGroup[];
  byAssignee:   { name: string; total: number; done: number; inProgress: number }[];
  blockers:     JiraIssue[];   // Priority = Highest or Blocker
  unassigned:   JiraIssue[];
  completion:   number;        // 0-100 %
  storyPoints:  { total: number; done: number; inProgress: number };
  markdown:     string;
}

export class Summarizer {
  compile(issues: JiraIssue[], title = 'Sprint Status'): SprintSummary {
    const total = issues.length;
    if (total === 0) {
      return this._empty(title);
    }

    // ── Group by status category ────────────────────────────────────────────
    const groups: Record<string, JiraIssue[]> = {
      'Done':        [],
      'In Progress': [],
      'To Do':       [],
      'Other':       [],
    };
    for (const issue of issues) {
      const cat = issue.statusCat;
      if (cat === 'Done')        { groups['Done'].push(issue); }
      else if (cat === 'In Progress') { groups['In Progress'].push(issue); }
      else if (cat === 'To Do')  { groups['To Do'].push(issue); }
      else                       { groups['Other'].push(issue); }
    }

    const byStatus: StatusGroup[] = Object.entries(groups)
      .filter(([, arr]) => arr.length > 0)
      .map(([label, arr]) => ({ label, count: arr.length, issues: arr }));

    // ── By assignee ─────────────────────────────────────────────────────────
    const assigneeMap = new Map<string, { total: number; done: number; inProgress: number }>();
    for (const issue of issues) {
      const name = issue.assignee;
      if (!assigneeMap.has(name)) {
        assigneeMap.set(name, { total: 0, done: 0, inProgress: 0 });
      }
      const entry = assigneeMap.get(name)!;
      entry.total++;
      if (issue.statusCat === 'Done')        { entry.done++; }
      if (issue.statusCat === 'In Progress') { entry.inProgress++; }
    }
    const byAssignee = Array.from(assigneeMap.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.total - a.total);

    // ── Blockers ────────────────────────────────────────────────────────────
    const blockers = issues.filter(
      (i) => /blocker|highest/i.test(i.priority) && i.statusCat !== 'Done'
    );

    // ── Unassigned ──────────────────────────────────────────────────────────
    const unassigned = issues.filter(
      (i) => i.assignee === 'Unassigned' && i.statusCat !== 'Done'
    );

    // ── Story points ────────────────────────────────────────────────────────
    const spTotal = issues.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
    const spDone  = groups['Done'].reduce((s, i) => s + (i.storyPoints ?? 0), 0);
    const spInProg = groups['In Progress'].reduce((s, i) => s + (i.storyPoints ?? 0), 0);

    const completion = total > 0 ? Math.round((groups['Done'].length / total) * 100) : 0;

    const markdown = this._toMarkdown({
      title, total, byStatus, byAssignee, blockers,
      unassigned, completion,
      storyPoints: { total: spTotal, done: spDone, inProgress: spInProg },
    });

    return {
      title, total, byStatus, byAssignee, blockers, unassigned,
      completion, storyPoints: { total: spTotal, done: spDone, inProgress: spInProg },
      markdown,
    };
  }

  private _toMarkdown(s: Omit<SprintSummary, 'markdown'>): string {
    const lines: string[] = [];
    lines.push(`# ${s.title}`);
    lines.push('');
    lines.push(`**Total issues:** ${s.total}  |  **Completion:** ${s.completion}%`);
    if (s.storyPoints.total > 0) {
      lines.push(`**Story Points:** ${s.storyPoints.done}/${s.storyPoints.total} done  (${s.storyPoints.inProgress} in progress)`);
    }
    lines.push('');

    lines.push('## Status Breakdown');
    for (const g of s.byStatus) {
      const pct = Math.round((g.count / s.total) * 100);
      lines.push(`- **${g.label}**: ${g.count} issues (${pct}%)`);
    }
    lines.push('');

    lines.push('## By Assignee');
    for (const a of s.byAssignee) {
      lines.push(`- **${a.name}**: ${a.total} total — ${a.done} done, ${a.inProgress} in progress`);
    }
    lines.push('');

    if (s.blockers.length > 0) {
      lines.push('## 🚨 Blockers / Highest Priority');
      for (const b of s.blockers) {
        lines.push(`- [${b.key}] ${b.summary} (${b.status}, ${b.assignee})`);
      }
      lines.push('');
    }

    if (s.unassigned.length > 0) {
      lines.push('## ⚠️ Unassigned Issues');
      for (const u of s.unassigned) {
        lines.push(`- [${u.key}] ${u.summary} (${u.status})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private _empty(title: string): SprintSummary {
    return {
      title, total: 0, byStatus: [], byAssignee: [],
      blockers: [], unassigned: [], completion: 0,
      storyPoints: { total: 0, done: 0, inProgress: 0 },
      markdown: `# ${title}\n\nNo issues found.`,
    };
  }
}
