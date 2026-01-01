#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as readline from 'node:readline';
import { debugLogger } from '@google/gemini-cli-core';
import { CustomAgentServer } from './server.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from './types.js';

const server = new CustomAgentServer();

// JSON-RPC over stdin/stdout
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

/**
 * Send a JSON-RPC response to stdout
 */
function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

/**
 * Send a JSON-RPC notification to stdout
 */
function sendNotification(notification: JsonRpcNotification): void {
  process.stdout.write(JSON.stringify(notification) + '\n');
}

// Wire up server events to notifications
server.onSessionUpdate = (update) => {
  sendNotification({
    jsonrpc: '2.0',
    method: 'notifications/sessionUpdate',
    params: update,
  });
};

server.onEndTurn = () => {
  sendNotification({
    jsonrpc: '2.0',
    method: 'notifications/endTurn',
    params: {},
  });
};

/**
 * Handle incoming JSON-RPC request
 */
async function handleRequest(request: JsonRpcRequest): Promise<void> {
  try {
    const result = await server.handleMethod(request.method, request.params);
    sendResponse({
      jsonrpc: '2.0',
      id: request.id,
      result,
    });
  } catch (error) {
    sendResponse({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

// Process each line as a JSON-RPC message
rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line) as JsonRpcRequest;

    if (message.jsonrpc !== '2.0') {
      sendResponse({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32600, message: 'Invalid Request: not JSON-RPC 2.0' },
      });
      return;
    }

    void handleRequest(message);
  } catch {
    sendResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
});

rl.on('close', () => {
  server.shutdown();
  process.exit(0);
});

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  debugLogger.error('[custom-agent] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  debugLogger.error('[custom-agent] Unhandled rejection:', reason);
});
