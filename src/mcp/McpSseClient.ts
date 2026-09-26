/**
 * MCP client over SSE transport.
 *
 * Protocol:
 *  1. GET  {serverUrl}/sse  → server streams SSE events
 *  2. Server sends:  event: endpoint\ndata: /messages?sessionId=xxx
 *  3. Client POSTs JSON-RPC to {serverUrl}/messages?sessionId=xxx
 *  4. Server sends responses back via the SSE stream as event: message
 */
import * as https from 'https';
import * as http from 'http';
import { EventEmitter } from 'events';
import { URL } from 'url';
import type { McpTool, McpToolResult, McpInitializeResult } from './McpTypes';

type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class McpSseClient extends EventEmitter {
  private messageEndpoint: string | null = null;
  private pending = new Map<number, Resolver>();
  private nextId = 1;
  private sseReq: http.ClientRequest | null = null;
  private sseBuffer = '';
  private _connected = false;

  constructor(
    private readonly serverUrl: string,
    private readonly accessToken: string
  ) {
    super();
  }

  get connected(): boolean { return this._connected; }

  // ── Connect ────────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sseUrl = `${this.serverUrl.replace(/\/$/, '')}/sse`;
      const url = new URL(sseUrl);
      const lib = url.protocol === 'https:' ? https : http;

      const options: http.RequestOptions = {
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
        res.on('data', (chunk: string) => this._onData(chunk));
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
      }, 10_000);
    });
  }

  // ── SSE stream parser ──────────────────────────────────────────────────────

  private _onData(chunk: string): void {
    this.sseBuffer += chunk;

    // SSE events are separated by double newlines
    const parts = this.sseBuffer.split(/\n\n/);
    // Last part may be incomplete — keep it in the buffer
    this.sseBuffer = parts.pop() ?? '';

    for (const block of parts) {
      this._processSSEBlock(block);
    }
  }

  private _processSSEBlock(block: string): void {
    let eventType = 'message';
    let data = '';

    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data = line.slice(5).trim();
      }
    }

    if (!data) { return; }

    if (eventType === 'endpoint') {
      // data = relative path like /messages?sessionId=abc
      const base = new URL(this.serverUrl.replace(/\/$/, ''));
      this.messageEndpoint = `${base.protocol}//${base.host}${data}`;
      this._connected = true;
      this.emit('_endpoint');
    } else if (eventType === 'message') {
      try {
        const msg = JSON.parse(data) as { id: number; result?: unknown; error?: { message: string } };
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // ignore malformed frames
      }
    }
  }

  // ── JSON-RPC send ──────────────────────────────────────────────────────────

  send(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.messageEndpoint) {
      return Promise.reject(new Error('MCP client not connected'));
    }

    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const url = new URL(this.messageEndpoint);
    const lib = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method} (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      const options: http.RequestOptions = {
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

  async initialize(): Promise<McpInitializeResult> {
    const result = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'vscode-jira-mcp', version: '1.0.0' },
    }) as McpInitializeResult;

    // Fire-and-forget notification — no response expected
    this.send('notifications/initialized').catch(() => undefined);
    return result;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.send('tools/list') as { tools: McpTool[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return await this.send('tools/call', { name, arguments: args }, 60_000) as McpToolResult;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  disconnect(): void {
    this._connected = false;
    this.sseReq?.destroy();
    this.sseReq = null;
    this.messageEndpoint = null;
    this.sseBuffer = '';
    this.pending.forEach(({ reject }) => reject(new Error('Client disconnected')));
    this.pending.clear();
  }
}
