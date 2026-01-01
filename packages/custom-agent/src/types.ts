/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for the Custom Agent JSON-RPC protocol
 */

// JSON-RPC 2.0 types
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ACP Protocol types (subset we implement)
export interface InitializeParams {
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    streaming: boolean;
    tools: boolean;
    customMethods: string[];
  };
  authMethods?: string[];
}

export interface NewSessionParams {
  workingDirectory?: string;
}

export interface NewSessionResult {
  sessionId: string;
}

export interface SendPromptParams {
  sessionId: string;
  prompt: string;
}

// Custom extension types
export interface EditMessageParams {
  sessionId: string;
  messageIndex: number;
  newContent: string;
  mode: 'fork' | 'inPlace';
}

export interface EditMessageResult {
  success: boolean;
  newSessionId?: string; // If mode is 'fork', a new session is created
}

export interface DeleteMessageParams {
  sessionId: string;
  messageIndex: number;
}

export interface SaveFromPointParams {
  sessionId: string;
  messageIndex: number;
  saveName: string;
}

export interface SaveFromPointResult {
  success: boolean;
  savePath: string;
}

export interface ResumeParams {
  saveName: string;
  workingDirectory?: string;
}

export interface ResumeResult {
  sessionId: string;
  messageCount: number;
}

export interface ListSavesResult {
  saves: Array<{
    name: string;
    createdAt: number;
    messageCount: number;
  }>;
}

// Session update types (notifications)
export type SessionUpdateType =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'history_snapshot';

export interface SessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: SessionUpdateType;
    [key: string]: unknown;
  };
}

export interface HistorySnapshotUpdate {
  sessionId: string;
  update: {
    sessionUpdate: 'history_snapshot';
    messages: Array<{
      role: 'user' | 'model';
      content: string;
    }>;
  };
}
