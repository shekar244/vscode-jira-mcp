import * as vscode from 'vscode';

const KEY_ACCESS  = 'jiraMcp.accessToken';
const KEY_REFRESH = 'jiraMcp.refreshToken';
const KEY_EXPIRY  = 'jiraMcp.tokenExpiry';

export class TokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async saveTokens(accessToken: string, refreshToken: string, expiresInSeconds: number): Promise<void> {
    const expiry = Date.now() + expiresInSeconds * 1000;
    await this.secrets.store(KEY_ACCESS,  accessToken);
    await this.secrets.store(KEY_REFRESH, refreshToken);
    await this.secrets.store(KEY_EXPIRY,  String(expiry));
  }

  async getAccessToken(): Promise<string | undefined> {
    return this.secrets.get(KEY_ACCESS);
  }

  async getRefreshToken(): Promise<string | undefined> {
    return this.secrets.get(KEY_REFRESH);
  }

  async isExpired(): Promise<boolean> {
    const expiry = await this.secrets.get(KEY_EXPIRY);
    if (!expiry) { return true; }
    // Consider expired 60s early to avoid edge cases
    return Date.now() >= Number(expiry) - 60_000;
  }

  async clear(): Promise<void> {
    await this.secrets.delete(KEY_ACCESS);
    await this.secrets.delete(KEY_REFRESH);
    await this.secrets.delete(KEY_EXPIRY);
  }
}
