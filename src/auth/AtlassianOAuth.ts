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
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as https from 'https';
import type { TokenStore } from './TokenStore';

const AUTH_URL  = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const SCOPES    = 'read:jira-work read:jira-user write:jira-work offline_access';

export class AtlassianOAuth implements vscode.UriHandler {
  // Holds the pending promise resolvers while waiting for the callback URI
  private pendingResolve?: (code: string) => void;
  private pendingReject?:  (err: Error)   => void;

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly extensionId: string   // e.g. "your-org.vscode-jira-mcp"
  ) {}

  // ── vscode.UriHandler implementation ───────────────────────────────────────

  handleUri(uri: vscode.Uri): void {
    if (!uri.path.includes('auth-callback')) { return; }

    const params = new URLSearchParams(uri.query);
    const code  = params.get('code');
    const error = params.get('error');

    if (error || !code) {
      this.pendingReject?.(new Error(error ?? 'OAuth callback missing code'));
      return;
    }

    this.pendingResolve?.(code);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async login(): Promise<void> {
    const cfg      = vscode.workspace.getConfiguration('jiraMcp');
    const clientId = cfg.get<string>('clientId');
    if (!clientId) {
      throw new Error('jiraMcp.clientId is not configured. Set it in VS Code settings.');
    }

    const { verifier, challenge } = this._pkce();
    const state       = crypto.randomBytes(16).toString('hex');
    const redirectUri = `vscode://${this.extensionId}/auth-callback`;

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set('audience',              'api.atlassian.com');
    authUrl.searchParams.set('client_id',             clientId);
    authUrl.searchParams.set('scope',                 SCOPES);
    authUrl.searchParams.set('redirect_uri',          redirectUri);
    authUrl.searchParams.set('state',                 state);
    authUrl.searchParams.set('response_type',         'code');
    authUrl.searchParams.set('prompt',                'consent');
    authUrl.searchParams.set('code_challenge',        challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    // Wait for the callback URI before opening the browser
    const code = await new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject  = reject;

      vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

      // 5-minute window for the user to complete login
      setTimeout(() => {
        reject(new Error('OAuth login timed out after 5 minutes'));
      }, 5 * 60_000);
    });

    await this._exchangeCode(code, verifier, clientId, redirectUri);
  }

  async refreshIfNeeded(): Promise<void> {
    if (!(await this.tokenStore.isExpired())) { return; }

    const refreshToken = await this.tokenStore.getRefreshToken();
    if (!refreshToken) { throw new Error('No refresh token — please log in again'); }

    const cfg      = vscode.workspace.getConfiguration('jiraMcp');
    const clientId = cfg.get<string>('clientId');
    if (!clientId) { throw new Error('jiraMcp.clientId is not configured'); }

    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     clientId,
      refresh_token: refreshToken,
    });

    const data = await this._postForm(TOKEN_URL, body.toString());
    await this.tokenStore.saveTokens(data.access_token, data.refresh_token ?? refreshToken, Number(data.expires_in ?? 3600));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _exchangeCode(code: string, verifier: string, clientId: string, redirectUri: string): Promise<void> {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     clientId,
      code,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    });

    const data = await this._postForm(TOKEN_URL, body.toString());
    await this.tokenStore.saveTokens(data.access_token, data.refresh_token, Number(data.expires_in ?? 3600));
  }

  private _postForm(url: string, body: string): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(
        {
          hostname: parsed.hostname,
          path:     parsed.pathname,
          method:   'POST',
          headers:  {
            'Content-Type':   'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c: string) => (raw += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(raw);
              if (json.error) { reject(new Error(`Token error: ${json.error_description ?? json.error}`)); }
              else            { resolve(json); }
            } catch {
              reject(new Error(`Invalid token response: ${raw}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private _pkce(): { verifier: string; challenge: string } {
    const verifier  = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }
}
