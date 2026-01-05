/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom Agent Server
 *
 * Implements ACP protocol methods plus custom extensions for message editing.
 * Uses gemini-cli-core's GeminiChat for the underlying conversation management.
 */

import type {
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  SendPromptParams,
  EditMessageParams,
  EditMessageResult,
  DeleteMessageParams,
  SaveFromPointParams,
  SaveFromPointResult,
  ResumeParams,
  ResumeResult,
  ListSavesResult,
  SessionUpdate,
  HistorySnapshotUpdate,
} from './types.js';
import { SessionManager } from './sessionManager.js';

export class CustomAgentServer {
  private sessionManager: SessionManager;
  private initialized = false;

  // Event callbacks (wired by cli.ts)
  onSessionUpdate: ((update: SessionUpdate) => void) | null = null;
  onEndTurn: (() => void) | null = null;

  constructor() {
    this.sessionManager = new SessionManager();

    // Wire session manager events
    this.sessionManager.onStreamEvent = (sessionId, event) => {
      if (this.onSessionUpdate) {
        this.onSessionUpdate({
          sessionId,
          update: event,
        });
      }
    };

    this.sessionManager.onTurnComplete = (_sessionId) => {
      if (this.onEndTurn) {
        this.onEndTurn();
      }
    };
  }

  /**
   * Route JSON-RPC method to appropriate handler
   */
  async handleMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      // Standard ACP methods
      case 'initialize':
        return this.initialize(params as InitializeParams);
      case 'session/new':
        return this.newSession(params as NewSessionParams);
      case 'session/sendPrompt':
        return this.sendPrompt(params as SendPromptParams);

      // Custom extension methods
      case 'session/editMessage':
        return this.editMessage(params as EditMessageParams);
      case 'session/deleteMessage':
        return this.deleteMessage(params as DeleteMessageParams);
      case 'session/saveFromPoint':
        return this.saveFromPoint(params as SaveFromPointParams);
      case 'session/resume':
        return this.resume(params as ResumeParams);
      case 'session/listSaves':
        return this.listSaves();

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * ACP: Initialize handshake
   */
  private initialize(_params: InitializeParams): InitializeResult {
    this.initialized = true;
    return {
      serverInfo: {
        name: 'custom-gemini-agent',
        version: '0.1.0',
      },
      capabilities: {
        streaming: true,
        tools: true,
        customMethods: [
          'session/editMessage',
          'session/deleteMessage',
          'session/saveFromPoint',
          'session/resume',
          'session/listSaves',
        ],
      },
    };
  }

  /**
   * ACP: Create new session
   */
  private async newSession(
    params: NewSessionParams,
  ): Promise<NewSessionResult> {
    if (!this.initialized) {
      throw new Error('Server not initialized. Call initialize first.');
    }
    const sessionId = await this.sessionManager.createSession(
      params.workingDirectory,
    );
    return { sessionId };
  }

  /**
   * ACP: Send prompt to active session
   * Intercepts slash commands before sending to LLM
   */
  private async sendPrompt(params: SendPromptParams): Promise<void> {
    const { processSlashCommand } = await import('./slashCommandProcessor.js');

    // Check for slash command
    const slashResult = await processSlashCommand(
      params.prompt,
      params.sessionId,
      this.sessionManager,
    );

    if (slashResult.handled) {
      // Emit the command result as a model message
      if (slashResult.message && this.onSessionUpdate) {
        this.onSessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            role: 'model',
            content: slashResult.message,
          },
        });
      }

      // If the command has a prompt to send (e.g., conductor commands)
      // send it to the LLM
      if (slashResult.promptToSend) {
        await this.sessionManager.sendPrompt(
          params.sessionId,
          slashResult.promptToSend,
        );
        return;
      }

      // Signal turn complete for non-prompt commands
      if (this.onEndTurn) {
        this.onEndTurn();
      }
      return;
    }

    // Not a slash command, proceed with normal message
    await this.sessionManager.sendPrompt(params.sessionId, params.prompt);
  }

  /**
   * Custom: Edit a message in conversation history
   */
  private async editMessage(
    params: EditMessageParams,
  ): Promise<EditMessageResult> {
    return this.sessionManager.editMessage(
      params.sessionId,
      params.messageIndex,
      params.newContent,
      params.mode,
    );
  }

  /**
   * Custom: Delete a message from conversation history
   */
  private async deleteMessage(params: DeleteMessageParams): Promise<void> {
    await this.sessionManager.deleteMessage(
      params.sessionId,
      params.messageIndex,
    );
  }

  /**
   * Custom: Save conversation from a specific point
   */
  private async saveFromPoint(
    params: SaveFromPointParams,
  ): Promise<SaveFromPointResult> {
    return this.sessionManager.saveFromPoint(
      params.sessionId,
      params.messageIndex,
      params.saveName,
    );
  }

  /**
   * Custom: Resume a saved conversation
   */
  private async resume(params: ResumeParams): Promise<ResumeResult> {
    const result = await this.sessionManager.resumeSession(
      params.saveName,
      params.workingDirectory,
    );

    // Send history snapshot to UI
    if (this.onSessionUpdate) {
      const snapshot: HistorySnapshotUpdate = {
        sessionId: result.sessionId,
        update: {
          sessionUpdate: 'history_snapshot',
          messages: result.messages,
        },
      };
      this.onSessionUpdate(snapshot);
    }

    return {
      sessionId: result.sessionId,
      messageCount: result.messages.length,
    };
  }

  /**
   * Custom: List all saved conversations
   */
  private async listSaves(): Promise<ListSavesResult> {
    return this.sessionManager.listSaves();
  }

  /**
   * Cleanup on shutdown
   */
  shutdown(): void {
    this.sessionManager.shutdown();
  }
}
