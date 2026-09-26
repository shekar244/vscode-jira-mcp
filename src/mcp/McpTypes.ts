// MCP JSON-RPC 2.0 protocol types

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolResultContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
}

export interface McpToolResult {
  content: McpToolResultContent[];
  isError?: boolean;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: { name: string; version: string };
}
