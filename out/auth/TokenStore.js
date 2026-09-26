"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenStore = void 0;
const KEY_ACCESS = 'jiraMcp.accessToken';
const KEY_REFRESH = 'jiraMcp.refreshToken';
const KEY_EXPIRY = 'jiraMcp.tokenExpiry';
class TokenStore {
    constructor(secrets) {
        this.secrets = secrets;
    }
    async saveTokens(accessToken, refreshToken, expiresInSeconds) {
        const expiry = Date.now() + expiresInSeconds * 1000;
        await this.secrets.store(KEY_ACCESS, accessToken);
        await this.secrets.store(KEY_REFRESH, refreshToken);
        await this.secrets.store(KEY_EXPIRY, String(expiry));
    }
    async getAccessToken() {
        return this.secrets.get(KEY_ACCESS);
    }
    async getRefreshToken() {
        return this.secrets.get(KEY_REFRESH);
    }
    async isExpired() {
        const expiry = await this.secrets.get(KEY_EXPIRY);
        if (!expiry) {
            return true;
        }
        // Consider expired 60s early to avoid edge cases
        return Date.now() >= Number(expiry) - 60000;
    }
    async clear() {
        await this.secrets.delete(KEY_ACCESS);
        await this.secrets.delete(KEY_REFRESH);
        await this.secrets.delete(KEY_EXPIRY);
    }
}
exports.TokenStore = TokenStore;
//# sourceMappingURL=TokenStore.js.map