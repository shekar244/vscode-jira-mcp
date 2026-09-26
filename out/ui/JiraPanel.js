"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiraPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const Summarizer_1 = require("../jira/Summarizer");
class JiraPanel {
    constructor(jiraService, extensionUri) {
        this.jiraService = jiraService;
        this.summarizer = new Summarizer_1.Summarizer();
        this.currentIssues = [];
        this.panel = vscode.window.createWebviewPanel('jiraMcpPanel', 'Jira MCP', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'webview')],
        });
        this.panel.webview.html = this._buildHtml(extensionUri);
        this.panel.webview.onDidReceiveMessage((msg) => this._onMessage(msg));
        this.panel.onDidDispose(() => { JiraPanel.instance = undefined; });
    }
    static open(jiraService, extensionUri) {
        if (JiraPanel.instance) {
            JiraPanel.instance.panel.reveal();
            return JiraPanel.instance;
        }
        JiraPanel.instance = new JiraPanel(jiraService, extensionUri);
        return JiraPanel.instance;
    }
    static getCurrent() {
        return JiraPanel.instance;
    }
    // ── Inbound messages from the webview ─────────────────────────────────────
    async _onMessage(msg) {
        switch (msg.type) {
            case 'ready':
                await this._loadDefaultIssues();
                break;
            case 'search':
                await this._search(msg.jql);
                break;
            case 'summarize':
                this._sendSummary();
                break;
            case 'openIssue':
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
                break;
            case 'copyMarkdown':
                vscode.env.clipboard.writeText(msg.markdown);
                vscode.window.showInformationMessage('Markdown copied to clipboard');
                break;
        }
    }
    // ── Jira data loading ──────────────────────────────────────────────────────
    async _loadDefaultIssues() {
        const jql = vscode.workspace
            .getConfiguration('jiraMcp')
            .get('defaultJql', 'assignee = currentUser() ORDER BY updated DESC');
        await this._search(jql);
    }
    async _search(jql) {
        this._post({ type: 'loading', message: `Searching: ${jql}` });
        try {
            this.currentIssues = await this.jiraService.searchIssues(jql, 100);
            this._post({ type: 'issues', issues: this.currentIssues, jql });
        }
        catch (err) {
            this._post({ type: 'error', message: String(err) });
        }
    }
    _sendSummary() {
        const summary = this.summarizer.compile(this.currentIssues);
        this._post({ type: 'summary', summary });
    }
    // ── Outbound messages to the webview ──────────────────────────────────────
    _post(data) {
        this.panel.webview.postMessage(data);
    }
    // ── HTML ──────────────────────────────────────────────────────────────────
    _buildHtml(extensionUri) {
        const htmlFile = path.join(extensionUri.fsPath, 'src', 'ui', 'webview', 'panel.html');
        if (fs.existsSync(htmlFile)) {
            return fs.readFileSync(htmlFile, 'utf8');
        }
        // Inline fallback — same content as panel.html but embedded
        return this._inlineFallbackHtml();
    }
    _inlineFallbackHtml() {
        return `<!DOCTYPE html><html><body>
      <p style="color:red">panel.html not found — run the build first.</p>
    </body></html>`;
    }
}
exports.JiraPanel = JiraPanel;
//# sourceMappingURL=JiraPanel.js.map