"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiraService = void 0;
class JiraService {
    constructor(client) {
        this.client = client;
        this.tools = [];
    }
    async loadTools() {
        const list = await this.client.listTools();
        this.tools = list.map((t) => t.name);
    }
    hasTool(name) {
        return this.tools.includes(name);
    }
    // ── Projects ───────────────────────────────────────────────────────────────
    async listProjects() {
        const result = await this._call('list_projects', {});
        return this._parseJson(result, []);
    }
    // ── Issues ─────────────────────────────────────────────────────────────────
    async searchIssues(jql, maxResults = 50) {
        const result = await this._call('search_issues', { jql, maxResults });
        const raw = this._parseJson(result, {});
        const issues = raw.issues ?? (Array.isArray(raw) ? raw : []);
        return issues.map(this._mapIssue);
    }
    async getIssue(key) {
        const result = await this._call('get_issue', { issueKey: key });
        return this._mapIssue(this._parseJson(result, {}));
    }
    async getActiveSprint(boardId) {
        try {
            const result = await this._call('get_sprint', { boardId, state: 'active' });
            return this._parseJson(result, null);
        }
        catch {
            return null;
        }
    }
    async getBoards(projectKey) {
        const result = await this._call('get_board', { projectKey });
        const raw = this._parseJson(result, {});
        return (raw.values ?? []);
    }
    // ── Helpers ────────────────────────────────────────────────────────────────
    async _call(tool, args) {
        return this.client.callTool(tool, args);
    }
    _parseJson(result, fallback) {
        for (const item of result.content ?? []) {
            if (item.type === 'text' && item.text) {
                try {
                    return JSON.parse(item.text);
                }
                catch {
                    // text might be the raw JSON string or an error description
                }
            }
        }
        return fallback;
    }
    _mapIssue(raw) {
        const fields = (raw.fields ?? raw);
        const status = fields.status ?? {};
        const statusCat = (status.statusCategory ?? {});
        const priority = fields.priority ?? {};
        const assignee = fields.assignee ?? {};
        const reporter = fields.reporter ?? {};
        const issuetype = fields.issuetype ?? {};
        const sprint = fields.sprint ?? null;
        const epic = fields.epic ?? null;
        const sp = fields.story_points ?? fields.storyPoints ?? fields.customfield_10016;
        return {
            key: String(raw.key ?? fields.key ?? ''),
            summary: String(fields.summary ?? ''),
            status: String(status.name ?? ''),
            statusCat: String(statusCat.name ?? ''),
            priority: String(priority.name ?? 'None'),
            assignee: String(assignee.displayName ?? 'Unassigned'),
            reporter: String(reporter.displayName ?? ''),
            type: String(issuetype.name ?? ''),
            updated: String(fields.updated ?? ''),
            created: String(fields.created ?? ''),
            labels: fields.labels ?? [],
            storyPoints: sp != null ? Number(sp) : null,
            sprint: sprint ? String(sprint.name ?? '') : null,
            epic: epic ? String(epic.name ?? epic.key ?? '') : null,
            url: String(raw.url ?? raw.self ?? '').replace('/rest/api/latest/issue/', '/browse/'),
        };
    }
}
exports.JiraService = JiraService;
//# sourceMappingURL=JiraService.js.map