import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { JiraService, JiraIssue } from '../jira/JiraService';
import { Summarizer } from '../jira/Summarizer';

type PanelMessage =
  | { type: 'search';   jql: string }
  | { type: 'summarize' }
  | { type: 'openIssue'; url: string }
  | { type: 'copyMarkdown'; markdown: string }
  | { type: 'ready' };

export class JiraPanel {
  private static instance: JiraPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly summarizer = new Summarizer();
  private currentIssues: JiraIssue[] = [];

  private constructor(
    private readonly jiraService: JiraService,
    extensionUri: vscode.Uri
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'jiraMcpPanel',
      'Jira MCP',
      vscode.ViewColumn.One,
      {
        enableScripts:         true,
        retainContextWhenHidden: true,
        localResourceRoots:    [vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'webview')],
      }
    );

    this.panel.webview.html = this._buildHtml(extensionUri);
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => this._onMessage(msg));
    this.panel.onDidDispose(() => { JiraPanel.instance = undefined; });
  }

  static open(jiraService: JiraService, extensionUri: vscode.Uri): JiraPanel {
    if (JiraPanel.instance) {
      JiraPanel.instance.panel.reveal();
      return JiraPanel.instance;
    }
    JiraPanel.instance = new JiraPanel(jiraService, extensionUri);
    return JiraPanel.instance;
  }

  static getCurrent(): JiraPanel | undefined {
    return JiraPanel.instance;
  }

  // ── Inbound messages from the webview ─────────────────────────────────────

  private async _onMessage(msg: PanelMessage): Promise<void> {
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

  private async _loadDefaultIssues(): Promise<void> {
    const jql = vscode.workspace
      .getConfiguration('jiraMcp')
      .get<string>('defaultJql', 'assignee = currentUser() ORDER BY updated DESC');
    await this._search(jql);
  }

  private async _search(jql: string): Promise<void> {
    this._post({ type: 'loading', message: `Searching: ${jql}` });
    try {
      this.currentIssues = await this.jiraService.searchIssues(jql, 100);
      this._post({ type: 'issues', issues: this.currentIssues, jql });
    } catch (err) {
      this._post({ type: 'error', message: String(err) });
    }
  }

  private _sendSummary(): void {
    const summary = this.summarizer.compile(this.currentIssues);
    this._post({ type: 'summary', summary });
  }

  // ── Outbound messages to the webview ──────────────────────────────────────

  private _post(data: Record<string, unknown>): void {
    this.panel.webview.postMessage(data);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private _buildHtml(extensionUri: vscode.Uri): string {
    const htmlFile = path.join(extensionUri.fsPath, 'src', 'ui', 'webview', 'panel.html');
    if (fs.existsSync(htmlFile)) {
      return fs.readFileSync(htmlFile, 'utf8');
    }
    // Inline fallback — same content as panel.html but embedded
    return this._inlineFallbackHtml();
  }

  private _inlineFallbackHtml(): string {
    return `<!DOCTYPE html><html><body>
      <p style="color:red">panel.html not found — run the build first.</p>
    </body></html>`;
  }
}
