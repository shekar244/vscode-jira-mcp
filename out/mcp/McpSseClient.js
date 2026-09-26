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
exports.McpSseClient = void 0;
/**
 * MCP client over SSE transport.
 *
 * Protocol:
 *  1. GET  {serverUrl}/sse  → server streams SSE events
 *  2. Server sends:  event: endpoint\ndata: /messages?sessionId=xxx
 *  3. Client POSTs JSON-RPC to {serverUrl}/messages?sessionId=xxx
 *  4. Server sends responses back via the SSE stream as event: message
 */
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const events_1 = require("events");
const url_1 = require("url");
class McpSseClient extends events_1.EventEmitter {
    constructor(serverUrl, accessToken) {
        super();
        this.serverUrl = serverUrl;
        this.accessToken = accessToken;
        this.messageEndpoint = null;
        this.pending = new Map();
        this.nextId = 1;
        this.sseReq = null;
        this.sseBuffer = '';
        this._connected = false;
    }
    get connected() { return this._connected; }
    // ── Connect ────────────────────────────────────────────────────────────────
    connect() {
        return new Promise((resolve, reject) => {
            const sseUrl = `${this.serverUrl.replace(/\/$/, '')}/sse`;
            const url = new url_1.URL(sseUrl);
            const lib = url.protocol === 'https:' ? https : http;
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    Accept: 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                },
            };
            this.sseReq = lib.request(options, (res) => {
                if (res.statusCode === 401) {
                    reject(new Error('MCP server returned 401 — token may be expired'));
                    return;
                }
                if ((res.statusCode ?? 0) >= 400) {
                    reject(new Error(`MCP server returned HTTP ${res.statusCode}`));
                    return;
                }
                res.setEncoding('utf8');
                res.on('data', (chunk) => this._onData(chunk));
                res.on('end', () => {
                    this._connected = false;
                    this.emit('disconnected');
                });
                res.on('error', (err) => this.emit('error', err));
            });
            this.sseReq.on('error', reject);
            this.sseReq.end();
            // Resolve once the server sends the message endpoint
            const onEndpoint = () => resolve();
            this.once('_endpoint', onEndpoint);
            // Timeout if server never sends endpoint event
            setTimeout(() => {
                if (!this.messageEndpoint) {
                    this.off('_endpoint', onEndpoint);
                    reject(new Error('MCP server did not send endpoint event within 10s'));
                }
            }, 10000);
        });
    }
    // ── SSE stream parser ──────────────────────────────────────────────────────
    _onData(chunk) {
        this.sseBuffer += chunk;
        // SSE events are separated by double newlines
        const parts = this.sseBuffer.split(/\n\n/);
        // Last part may be incomplete — keep it in the buffer
        this.sseBuffer = parts.pop() ?? '';
        for (const block of parts) {
            this._processSSEBlock(block);
        }
    }
    _processSSEBlock(block) {
        let eventType = 'message';
        let data = '';
        for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
            }
            else if (line.startsWith('data:')) {
                data = line.slice(5).trim();
            }
        }
        if (!data) {
            return;
        }
        if (eventType === 'endpoint') {
            // data = relative path like /messages?sessionId=abc
            const base = new url_1.URL(this.serverUrl.replace(/\/$/, ''));
            this.messageEndpoint = `${base.protocol}//${base.host}${data}`;
            this._connected = true;
            this.emit('_endpoint');
        }
        else if (eventType === 'message') {
            try {
                const msg = JSON.parse(data);
                const pending = this.pending.get(msg.id);
                if (pending) {
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error(msg.error.message));
                    }
                    else {
                        pending.resolve(msg.result);
                    }
                }
            }
            catch {
                // ignore malformed frames
            }
        }
    }
    // ── JSON-RPC send ──────────────────────────────────────────────────────────
    send(method, params, timeoutMs = 30000) {
        if (!this.messageEndpoint) {
            return Promise.reject(new Error('MCP client not connected'));
        }
        const id = this.nextId++;
        const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        const url = new url_1.URL(this.messageEndpoint);
        const lib = url.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP timeout: ${method} (${timeoutMs}ms)`));
                }
            }, timeoutMs);
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = lib.request(options, (res) => {
                // MCP responses arrive via SSE, not the HTTP response body
                res.resume();
                if ((res.statusCode ?? 0) >= 400) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new Error(`POST /messages returned HTTP ${res.statusCode}`));
                }
            });
            req.on('error', (err) => {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err);
            });
            req.write(body);
            req.end();
        });
    }
    // ── MCP lifecycle ──────────────────────────────────────────────────────────
    async initialize() {
        const result = await this.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'vscode-jira-mcp', version: '1.0.0' },
        });
        // Fire-and-forget notification — no response expected
        this.send('notifications/initialized').catch(() => undefined);
        return result;
    }
    async listTools() {
        const result = await this.send('tools/list');
        return result?.tools ?? [];
    }
    async callTool(name, args) {
        return await this.send('tools/call', { name, arguments: args }, 60000);
    }
    // ── Cleanup ────────────────────────────────────────────────────────────────
    disconnect() {
        this._connected = false;
        this.sseReq?.destroy();
        this.sseReq = null;
        this.messageEndpoint = null;
        this.sseBuffer = '';
        this.pending.forEach(({ reject }) => reject(new Error('Client disconnected')));
        this.pending.clear();
    }
}
exports.McpSseClient = McpSseClient;
//# sourceMappingURL=McpSseClient.js.map