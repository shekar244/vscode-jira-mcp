/**
 * Jira MCP Runner — VS Code Extension
 *
 * Connects to a Jira MCP server via SSE transport using Atlassian OAuth 2.0
 * (PKCE). Authentication happens exclusively inside VS Code via the
 * vscode://publisher.vscode-jira-mcp/auth-callback URI — no external MCP
 * client or Copilot Chat required.
 */
import * as vscode from 'vscode';
import { AtlassianOAuth } from './auth/AtlassianOAuth';
import { TokenStore }     from './auth/TokenStore';
import { McpSseClient }   from './mcp/McpSseClient';
import { JiraService }    from './jira/JiraService';
import { JiraPanel }      from './ui/JiraPanel';

let mcpClient:   McpSseClient   | null = null;
let jiraService: JiraService    | null = null;
let oauth:       AtlassianOAuth | null = null;
let tokenStore:  TokenStore     | null = null;
let statusItem:  vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  tokenStore = new TokenStore(context.secrets);
  oauth      = new AtlassianOAuth(tokenStore, context.extension.id);

  // ── Register the OAuth callback URI handler ───────────────────────────────
  // Catches: vscode://<extensionId>/auth-callback?code=xxx
  // This is the ONLY allowed redirect URI in the org's OAuth app — meaning
  // authentication can only complete inside VS Code.
  context.subscriptions.push(
    vscode.window.registerUriHandler(oauth)
  );

  // ── Status bar item ───────────────────────────────────────────────────────
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'jiraMcp.openPanel';
  setStatusDisconnected();
  statusItem.show();
  context.subscriptions.push(statusItem);

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(

    vscode.commands.registerCommand('jiraMcp.connect', async () => {
      await cmdConnect(context);
    }),

    vscode.commands.registerCommand('jiraMcp.disconnect', () => {
      cmdDisconnect();
    }),

    vscode.commands.registerCommand('jiraMcp.openPanel', async () => {
      await cmdOpenPanel(context);
    }),

    vscode.commands.registerCommand('jiraMcp.refreshIssues', async () => {
      if (!jiraService) {
        vscode.window.showWarningMessage('Not connected — run "Jira MCP: Connect" first.');
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (JiraPanel.getCurrent() as any)?.['_loadDefaultIssues']?.();
    }),

    vscode.commands.registerCommand('jiraMcp.summarizeSprint', async () => {
      if (!jiraService) {
        vscode.window.showWarningMessage('Not connected — run "Jira MCP: Connect" first.');
        return;
      }
      const panel = JiraPanel.getCurrent() ?? JiraPanel.open(jiraService, context.extensionUri);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (panel as any)['_sendSummary']?.();
    })
  );

  // ── Auto-connect if tokens exist ──────────────────────────────────────────
  void autoConnect(context);
}

export function deactivate(): void {
  mcpClient?.disconnect();
}

// ── Command implementations ───────────────────────────────────────────────

async function cmdConnect(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('jiraMcp');
  const serverUrl = cfg.get<string>('serverUrl');

  if (!serverUrl) {
    const entered = await vscode.window.showInputBox({
      prompt:      'Enter your Jira MCP server URL',
      placeHolder: 'https://jira-mcp.internal.company.com',
      ignoreFocusOut: true,
    });
    if (!entered) { return; }
    await cfg.update('serverUrl', entered, vscode.ConfigurationTarget.Global);
  }

  // Step 1: OAuth login (opens browser → Atlassian → redirects to vscode://)
  setStatusConnecting('Authenticating…');
  try {
    const hasToken = !!(await tokenStore!.getAccessToken());
    const isExpired = await tokenStore!.isExpired();

    if (!hasToken || isExpired) {
      await oauth!.login();
      vscode.window.showInformationMessage('Atlassian login successful');
    }
  } catch (err) {
    vscode.window.showErrorMessage(`OAuth failed: ${err}`);
    setStatusDisconnected();
    return;
  }

  // Step 2: Connect to MCP server via SSE
  await connectMcp(context);
}

async function connectMcp(context: vscode.ExtensionContext): Promise<void> {
  const cfg       = vscode.workspace.getConfiguration('jiraMcp');
  const serverUrl = cfg.get<string>('serverUrl') ?? '';

  try {
    await oauth!.refreshIfNeeded();
    const token = await tokenStore!.getAccessToken();
    if (!token) { throw new Error('No access token after refresh'); }

    setStatusConnecting('Connecting to MCP server…');
    mcpClient?.disconnect();
    mcpClient = new McpSseClient(serverUrl, token);

    mcpClient.on('disconnected', () => {
      setStatusDisconnected();
      vscode.window.showWarningMessage('Jira MCP server disconnected');
    });

    await mcpClient.connect();
    await mcpClient.initialize();

    jiraService = new JiraService(mcpClient);
    await jiraService.loadTools();

    setStatusConnected();
    vscode.window.showInformationMessage('Connected to Jira MCP server');

  } catch (err) {
    mcpClient?.disconnect();
    mcpClient   = null;
    jiraService = null;
    setStatusDisconnected();
    vscode.window.showErrorMessage(`MCP connection failed: ${err}`);
  }
}

function cmdDisconnect(): void {
  mcpClient?.disconnect();
  mcpClient   = null;
  jiraService = null;
  setStatusDisconnected();
  vscode.window.showInformationMessage('Disconnected from Jira MCP');
}

async function cmdOpenPanel(context: vscode.ExtensionContext): Promise<void> {
  if (!jiraService) {
    const connect = 'Connect Now';
    const choice  = await vscode.window.showInformationMessage(
      'Not connected to Jira MCP server.',
      connect
    );
    if (choice === connect) { await cmdConnect(context); }
    if (!jiraService) { return; }
  }
  JiraPanel.open(jiraService, context.extensionUri);
}

// ── Auto-connect on startup if tokens are stored ──────────────────────────

async function autoConnect(context: vscode.ExtensionContext): Promise<void> {
  const cfg       = vscode.workspace.getConfiguration('jiraMcp');
  const serverUrl = cfg.get<string>('serverUrl');
  if (!serverUrl) { return; }

  const hasToken = !!(await tokenStore!.getAccessToken());
  if (!hasToken)  { return; }

  await connectMcp(context);
}

// ── Status bar helpers ────────────────────────────────────────────────────

function setStatusDisconnected(): void {
  statusItem.text        = '$(plug) Jira MCP';
  statusItem.tooltip     = 'Click to open panel | Run "Jira MCP: Connect" to connect';
  statusItem.color       = undefined;
  statusItem.backgroundColor = undefined;
}

function setStatusConnecting(label: string): void {
  statusItem.text    = `$(loading~spin) ${label}`;
  statusItem.color   = new vscode.ThemeColor('statusBarItem.warningForeground');
}

function setStatusConnected(): void {
  statusItem.text        = '$(pass-filled) Jira MCP';
  statusItem.tooltip     = 'Connected — click to open panel';
  statusItem.color       = new vscode.ThemeColor('terminal.ansiGreen');
  statusItem.backgroundColor = undefined;
}
