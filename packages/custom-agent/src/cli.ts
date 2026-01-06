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
let nextRequestId = 0;
const pendingRequests = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

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

function sendRequest(method: string, params?: unknown): Promise<unknown> {
  const id = nextRequestId++;
  const request = {
    jsonrpc: '2.0',
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };

  process.stdout.write(JSON.stringify(request) + '\n');

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
}

server.setRpcRequestSender(sendRequest);

// Wire up server events to notifications
server.onSessionUpdate = (update) => {
  sendNotification({
    jsonrpc: '2.0',
    method: 'session/update',
    params: update,
  });
};

server.onEndTurn = () => {
  // End-turn is reported in the sendPrompt response (stopReason)
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

async function handleNotification(
  notification: JsonRpcNotification,
): Promise<void> {
  try {
    await server.handleMethod(notification.method, notification.params);
  } catch {
    // Ignore notification errors
  }
}

function handleResponse(message: JsonRpcResponse): void {
  if (typeof message.id !== 'number') {
    return;
  }
  const pending = pendingRequests.get(message.id);
  if (!pending) {
    return;
  }
  pendingRequests.delete(message.id);
  if (message.error) {
    pending.reject(new Error(message.error.message));
  } else {
    pending.resolve(message.result);
  }
}

// Process each line as a JSON-RPC message
rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const message = JSON.parse(line) as JsonRpcRequest | JsonRpcResponse;

    if (message.jsonrpc !== '2.0') {
      sendResponse({
        jsonrpc: '2.0',
        id: 'id' in message ? (message.id ?? null) : null,
        error: { code: -32600, message: 'Invalid Request: not JSON-RPC 2.0' },
      });
      return;
    }

    if ('method' in message) {
      if ('id' in message && message.id !== undefined) {
        void handleRequest(message);
      } else {
        void handleNotification(message as JsonRpcNotification);
      }
      return;
    }

    if ('id' in message) {
      handleResponse(message);
      return;
    }
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
