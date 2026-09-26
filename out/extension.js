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
exports.activate = activate;
exports.deactivate = deactivate;
/**
 * Jira MCP Runner — VS Code Extension
 *
 * Connects to a Jira MCP server via SSE transport using Atlassian OAuth 2.0
 * (PKCE). Authentication happens exclusively inside VS Code via the
 * vscode://publisher.vscode-jira-mcp/auth-callback URI — no external MCP
 * client or Copilot Chat required.
 */
const vscode = __importStar(require("vscode"));
const AtlassianOAuth_1 = require("./auth/AtlassianOAuth");
const TokenStore_1 = require("./auth/TokenStore");
const McpSseClient_1 = require("./mcp/McpSseClient");
const JiraService_1 = require("./jira/JiraService");
const JiraPanel_1 = require("./ui/JiraPanel");
let mcpClient = null;
let jiraService = null;
let oauth = null;
let tokenStore = null;
let statusItem;
function activate(context) {
    tokenStore = new TokenStore_1.TokenStore(context.secrets);
    oauth = new AtlassianOAuth_1.AtlassianOAuth(tokenStore, context.extension.id);
    // ── Register the OAuth callback URI handler ───────────────────────────────
    // Catches: vscode://<extensionId>/auth-callback?code=xxx
    // This is the ONLY allowed redirect URI in the org's OAuth app — meaning
    // authentication can only complete inside VS Code.
    context.subscriptions.push(vscode.window.registerUriHandler(oauth));
    // ── Status bar item ───────────────────────────────────────────────────────
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem.command = 'jiraMcp.openPanel';
    setStatusDisconnected();
    statusItem.show();
    context.subscriptions.push(statusItem);
    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('jiraMcp.connect', async () => {
        await cmdConnect(context);
    }), vscode.commands.registerCommand('jiraMcp.disconnect', () => {
        cmdDisconnect();
    }), vscode.commands.registerCommand('jiraMcp.openPanel', async () => {
        await cmdOpenPanel(context);
    }), vscode.commands.registerCommand('jiraMcp.refreshIssues', async () => {
        if (!jiraService) {
            vscode.window.showWarningMessage('Not connected — run "Jira MCP: Connect" first.');
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        JiraPanel_1.JiraPanel.getCurrent()?.['_loadDefaultIssues']?.();
    }), vscode.commands.registerCommand('jiraMcp.summarizeSprint', async () => {
        if (!jiraService) {
            vscode.window.showWarningMessage('Not connected — run "Jira MCP: Connect" first.');
            return;
        }
        const panel = JiraPanel_1.JiraPanel.getCurrent() ?? JiraPanel_1.JiraPanel.open(jiraService, context.extensionUri);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        panel['_sendSummary']?.();
    }));
    // ── Auto-connect if tokens exist ──────────────────────────────────────────
    void autoConnect(context);
}
function deactivate() {
    mcpClient?.disconnect();
}
// ── Command implementations ───────────────────────────────────────────────
async function cmdConnect(context) {
    const cfg = vscode.workspace.getConfiguration('jiraMcp');
    const serverUrl = cfg.get('serverUrl');
    if (!serverUrl) {
        const entered = await vscode.window.showInputBox({
            prompt: 'Enter your Jira MCP server URL',
            placeHolder: 'https://jira-mcp.internal.company.com',
            ignoreFocusOut: true,
        });
        if (!entered) {
            return;
        }
        await cfg.update('serverUrl', entered, vscode.ConfigurationTarget.Global);
    }
    // Step 1: OAuth login (opens browser → Atlassian → redirects to vscode://)
    setStatusConnecting('Authenticating…');
    try {
        const hasToken = !!(await tokenStore.getAccessToken());
        const isExpired = await tokenStore.isExpired();
        if (!hasToken || isExpired) {
            await oauth.login();
            vscode.window.showInformationMessage('Atlassian login successful');
        }
    }
    catch (err) {
        vscode.window.showErrorMessage(`OAuth failed: ${err}`);
        setStatusDisconnected();
        return;
    }
    // Step 2: Connect to MCP server via SSE
    await connectMcp(context);
}
async function connectMcp(context) {
    const cfg = vscode.workspace.getConfiguration('jiraMcp');
    const serverUrl = cfg.get('serverUrl') ?? '';
    try {
        await oauth.refreshIfNeeded();
        const token = await tokenStore.getAccessToken();
        if (!token) {
            throw new Error('No access token after refresh');
        }
        setStatusConnecting('Connecting to MCP server…');
        mcpClient?.disconnect();
        mcpClient = new McpSseClient_1.McpSseClient(serverUrl, token);
        mcpClient.on('disconnected', () => {
            setStatusDisconnected();
            vscode.window.showWarningMessage('Jira MCP server disconnected');
        });
        await mcpClient.connect();
        await mcpClient.initialize();
        jiraService = new JiraService_1.JiraService(mcpClient);
        await jiraService.loadTools();
        setStatusConnected();
        vscode.window.showInformationMessage('Connected to Jira MCP server');
    }
    catch (err) {
        mcpClient?.disconnect();
        mcpClient = null;
        jiraService = null;
        setStatusDisconnected();
        vscode.window.showErrorMessage(`MCP connection failed: ${err}`);
    }
}
function cmdDisconnect() {
    mcpClient?.disconnect();
    mcpClient = null;
    jiraService = null;
    setStatusDisconnected();
    vscode.window.showInformationMessage('Disconnected from Jira MCP');
}
async function cmdOpenPanel(context) {
    if (!jiraService) {
        const connect = 'Connect Now';
        const choice = await vscode.window.showInformationMessage('Not connected to Jira MCP server.', connect);
        if (choice === connect) {
            await cmdConnect(context);
        }
        if (!jiraService) {
            return;
        }
    }
    JiraPanel_1.JiraPanel.open(jiraService, context.extensionUri);
}
// ── Auto-connect on startup if tokens are stored ──────────────────────────
async function autoConnect(context) {
    const cfg = vscode.workspace.getConfiguration('jiraMcp');
    const serverUrl = cfg.get('serverUrl');
    if (!serverUrl) {
        return;
    }
    const hasToken = !!(await tokenStore.getAccessToken());
    if (!hasToken) {
        return;
    }
    await connectMcp(context);
}
// ── Status bar helpers ────────────────────────────────────────────────────
function setStatusDisconnected() {
    statusItem.text = '$(plug) Jira MCP';
    statusItem.tooltip = 'Click to open panel | Run "Jira MCP: Connect" to connect';
    statusItem.color = undefined;
    statusItem.backgroundColor = undefined;
}
function setStatusConnecting(label) {
    statusItem.text = `$(loading~spin) ${label}`;
    statusItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
}
function setStatusConnected() {
    statusItem.text = '$(pass-filled) Jira MCP';
    statusItem.tooltip = 'Connected — click to open panel';
    statusItem.color = new vscode.ThemeColor('terminal.ansiGreen');
    statusItem.backgroundColor = undefined;
}
//# sourceMappingURL=extension.js.map