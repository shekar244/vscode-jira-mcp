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
exports.AtlassianOAuth = void 0;
/**
 * Atlassian OAuth 2.0 (3LO) with PKCE — VS Code URI handler flow.
 *
 * The org's OAuth app is configured with redirect URI:
 *   vscode://your-org.vscode-jira-mcp/auth-callback
 *
 * This means authentication can ONLY happen inside VS Code —
 * the browser redirect is caught by VS Code's URI handler, not an HTTP server.
 *
 * Flow:
 *  1. Generate PKCE pair (verifier + S256 challenge)
 *  2. Open browser → Atlassian auth page
 *  3. User logs in → Atlassian redirects to vscode://...?code=xxx
 *  4. VS Code fires the registered UriHandler with the callback URI
 *  5. Exchange code + verifier for tokens via HTTPS POST
 *  6. Store tokens in SecretStorage
 */
const vscode = __importStar(require("vscode"));
const crypto = __importStar(require("crypto"));
const https = __importStar(require("https"));
const AUTH_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const SCOPES = 'read:jira-work read:jira-user write:jira-work offline_access';
class AtlassianOAuth {
    constructor(tokenStore, extensionId // e.g. "your-org.vscode-jira-mcp"
    ) {
        this.tokenStore = tokenStore;
        this.extensionId = extensionId;
    }
    // ── vscode.UriHandler implementation ───────────────────────────────────────
    handleUri(uri) {
        if (!uri.path.includes('auth-callback')) {
            return;
        }
        const params = new URLSearchParams(uri.query);
        const code = params.get('code');
        const error = params.get('error');
        if (error || !code) {
            this.pendingReject?.(new Error(error ?? 'OAuth callback missing code'));
            return;
        }
        this.pendingResolve?.(code);
    }
    // ── Public API ─────────────────────────────────────────────────────────────
    async login() {
        const cfg = vscode.workspace.getConfiguration('jiraMcp');
        const clientId = cfg.get('clientId');
        if (!clientId) {
            throw new Error('jiraMcp.clientId is not configured. Set it in VS Code settings.');
        }
        const { verifier, challenge } = this._pkce();
        const state = crypto.randomBytes(16).toString('hex');
        const redirectUri = `vscode://${this.extensionId}/auth-callback`;
        const authUrl = new URL(AUTH_URL);
        authUrl.searchParams.set('audience', 'api.atlassian.com');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('scope', SCOPES);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('prompt', 'consent');
        authUrl.searchParams.set('code_challenge', challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        // Wait for the callback URI before opening the browser
        const code = await new Promise((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingReject = reject;
            vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
            // 5-minute window for the user to complete login
            setTimeout(() => {
                reject(new Error('OAuth login timed out after 5 minutes'));
            }, 5 * 60000);
        });
        await this._exchangeCode(code, verifier, clientId, redirectUri);
    }
    async refreshIfNeeded() {
        if (!(await this.tokenStore.isExpired())) {
            return;
        }
        const refreshToken = await this.tokenStore.getRefreshToken();
        if (!refreshToken) {
            throw new Error('No refresh token — please log in again');
        }
        const cfg = vscode.workspace.getConfiguration('jiraMcp');
        const clientId = cfg.get('clientId');
        if (!clientId) {
            throw new Error('jiraMcp.clientId is not configured');
        }
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
        });
        const data = await this._postForm(TOKEN_URL, body.toString());
        await this.tokenStore.saveTokens(data.access_token, data.refresh_token ?? refreshToken, Number(data.expires_in ?? 3600));
    }
    // ── Private helpers ────────────────────────────────────────────────────────
    async _exchangeCode(code, verifier, clientId, redirectUri) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        });
        const data = await this._postForm(TOKEN_URL, body.toString());
        await this.tokenStore.saveTokens(data.access_token, data.refresh_token, Number(data.expires_in ?? 3600));
    }
    _postForm(url, body) {
        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const req = https.request({
                hostname: parsed.hostname,
                path: parsed.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => {
                    try {
                        const json = JSON.parse(raw);
                        if (json.error) {
                            reject(new Error(`Token error: ${json.error_description ?? json.error}`));
                        }
                        else {
                            resolve(json);
                        }
                    }
                    catch {
                        reject(new Error(`Invalid token response: ${raw}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    _pkce() {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        return { verifier, challenge };
    }
}
exports.AtlassianOAuth = AtlassianOAuth;
//# sourceMappingURL=AtlassianOAuth.js.map