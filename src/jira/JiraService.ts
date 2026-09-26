/**
 * High-level Jira operations via MCP tool calls.
 * Wraps McpSseClient with typed methods for the UI and summarizer.
 */
import type { McpSseClient } from '../mcp/McpSseClient';
import type { McpToolResult } from '../mcp/McpTypes';

export interface JiraIssue {
  key:         string;
  summary:     string;
  status:      string;
  statusCat:   string;   // 'To Do' | 'In Progress' | 'Done'
  priority:    string;
  assignee:    string;
  reporter:    string;
  type:        string;
  updated:     string;
  created:     string;
  labels:      string[];
  storyPoints: number | null;
  sprint:      string | null;
  epic:        string | null;
  url:         string;
}

export interface JiraSprint {
  id:    number;
  name:  string;
  state: string;
  start: string;
  end:   string;
}

export interface JiraProject {
  key:  string;
  name: string;
  type: string;
}

export class JiraService {
  private tools: string[] = [];

  constructor(private readonly client: McpSseClient) {}

  async loadTools(): Promise<void> {
    const list = await this.client.listTools();
    this.tools = list.map((t) => t.name);
  }

  hasTool(name: string): boolean {
    return this.tools.includes(name);
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  async listProjects(): Promise<JiraProject[]> {
    const result = await this._call('list_projects', {});
    return this._parseJson(result, []);
  }

  // ── Issues ─────────────────────────────────────────────────────────────────

  async searchIssues(jql: string, maxResults = 50): Promise<JiraIssue[]> {
    const result = await this._call('search_issues', { jql, maxResults });
    const raw    = this._parseJson<{ issues?: unknown[] }>(result, {});
    const issues = raw.issues ?? (Array.isArray(raw) ? raw : []);
    return (issues as Record<string, unknown>[]).map(this._mapIssue);
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const result = await this._call('get_issue', { issueKey: key });
    return this._mapIssue(this._parseJson(result, {}));
  }

  async getActiveSprint(boardId: string): Promise<JiraSprint | null> {
    try {
      const result = await this._call('get_sprint', { boardId, state: 'active' });
      return this._parseJson<JiraSprint>(result, null as unknown as JiraSprint);
    } catch {
      return null;
    }
  }

  async getBoards(projectKey: string): Promise<{ id: string; name: string }[]> {
    const result = await this._call('get_board', { projectKey });
    const raw    = this._parseJson<{ values?: unknown[] }>(result, {});
    return (raw.values ?? []) as { id: string; name: string }[];
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async _call(tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.client.callTool(tool, args);
  }

  private _parseJson<T>(result: McpToolResult, fallback: T): T {
    for (const item of result.content ?? []) {
      if (item.type === 'text' && item.text) {
        try {
          return JSON.parse(item.text) as T;
        } catch {
          // text might be the raw JSON string or an error description
        }
      }
    }
    return fallback;
  }

  private _mapIssue(raw: Record<string, unknown>): JiraIssue {
    const fields = (raw.fields ?? raw) as Record<string, unknown>;

    const status    = (fields.status as Record<string, unknown> | undefined) ?? {};
    const statusCat = ((status.statusCategory as Record<string, unknown> | undefined) ?? {}) as Record<string, string>;
    const priority  = (fields.priority as Record<string, unknown> | undefined) ?? {};
    const assignee  = (fields.assignee as Record<string, unknown> | undefined) ?? {};
    const reporter  = (fields.reporter as Record<string, unknown> | undefined) ?? {};
    const issuetype = (fields.issuetype as Record<string, unknown> | undefined) ?? {};
    const sprint    = (fields.sprint as Record<string, unknown> | undefined) ?? null;
    const epic      = (fields.epic as Record<string, unknown> | undefined) ?? null;

    const sp = fields.story_points ?? fields.storyPoints ?? fields.customfield_10016;

    return {
      key:         String(raw.key ?? fields.key ?? ''),
      summary:     String(fields.summary ?? ''),
      status:      String((status as Record<string, string>).name ?? ''),
      statusCat:   String(statusCat.name ?? ''),
      priority:    String((priority as Record<string, string>).name ?? 'None'),
      assignee:    String((assignee as Record<string, string>).displayName ?? 'Unassigned'),
      reporter:    String((reporter as Record<string, string>).displayName ?? ''),
      type:        String((issuetype as Record<string, string>).name ?? ''),
      updated:     String(fields.updated ?? ''),
      created:     String(fields.created ?? ''),
      labels:      (fields.labels as string[] | undefined) ?? [],
      storyPoints: sp != null ? Number(sp) : null,
      sprint:      sprint ? String((sprint as Record<string, string>).name ?? '') : null,
      epic:        epic   ? String((epic   as Record<string, string>).name ?? (epic as Record<string, string>).key ?? '') : null,
      url:         String(raw.url ?? raw.self ?? '').replace('/rest/api/latest/issue/', '/browse/'),
    };
  }
}
