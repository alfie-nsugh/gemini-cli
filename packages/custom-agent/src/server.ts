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

import { debugLogger } from '@google/gemini-cli-core';
import type {
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  SendPromptParams,
  EditMessageParams,
  EditMessageResult,
  RegenerateMessageParams,
  RegenerateMessageResult,
  GetMessageForEditParams,
  GetMessageForEditResult,
  DeleteMessageParams,
  SaveFromPointParams,
  SaveFromPointResult,
  ResumeParams,
  ResumeResult,
  ListSavesResult,
  SessionUpdate,
  ListCommandsResult,
  CompleteCommandParams,
  CompleteCommandResult,
} from './types.js';
import { SessionManager } from './sessionManager.js';

type RpcRequestSender = (method: string, params?: unknown) => Promise<unknown>;

export class CustomAgentServer {
  private sessionManager: SessionManager;
  private initialized = false;
  private readonly toolsEnabled =
    process.env['CUSTOM_AGENT_ENABLE_TOOLS'] !== 'false';

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
      void this.handleTurnComplete(_sessionId);
    };
  }

  setRpcRequestSender(sender: RpcRequestSender): void {
    this.sessionManager.setRpcRequestSender(sender);
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
      case 'session/prompt':
        return this.sendPrompt(
          this.normalizeSendPromptParams(params as SendPromptParams),
        );

      // Custom extension methods
      case 'session/editMessage':
        return this.editMessage(params as EditMessageParams);
      case 'session/regenerate':
        return this.regenerateMessage(params as RegenerateMessageParams);
      case 'session/getMessageForEdit':
        return this.getMessageForEdit(params as GetMessageForEditParams);
      case 'session/deleteMessage':
        return this.deleteMessage(params as DeleteMessageParams);
      case 'session/saveFromPoint':
        return this.saveFromPoint(params as SaveFromPointParams);
      case 'session/resume':
        return this.resume(params as ResumeParams);
      case 'session/listSaves':
        return this.listSaves();

      // Command completion methods
      case 'commands/list':
        return this.listCommands();
      case 'commands/complete':
        return this.completeCommand(params as CompleteCommandParams);

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
        tools: this.toolsEnabled,
        customMethods: [
          'session/editMessage',
          'session/regenerate',
          'session/getMessageForEdit',
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
    const workingDirectory = params.workingDirectory ?? params.cwd;
    const sessionId = await this.sessionManager.createSession(
      workingDirectory,
      params.conversationId,
    );

    const autosaveTag = this.sessionManager.getAutosaveTagForConversation(
      params.conversationId,
    );
    if (autosaveTag && (await this.sessionManager.saveExists(autosaveTag))) {
      try {
        await this.sessionManager.resumeSession(
          autosaveTag,
          workingDirectory,
          sessionId,
          params.conversationId,
        );
      } catch (error) {
        debugLogger.warn(
          `[CustomAgentServer] Autosave resume failed: ${String(error)}`,
        );
      }
    }
    return { sessionId };
  }

  /**
   * ACP: Send prompt to active session
   * Intercepts slash commands before sending to LLM
   */
  private async sendPrompt(params: {
    sessionId: string;
    prompt: string;
  }): Promise<{ stopReason: 'end_turn' }> {
    const { processSlashCommand } = await import('./slashCommandProcessor.js');

    // Check for slash command
    const config = this.sessionManager.getConfig(params.sessionId);
    const slashResult = await processSlashCommand(
      params.prompt,
      params.sessionId,
      this.sessionManager,
      config,
    );

    if (slashResult.handled) {
      if (slashResult.type === 'confirm') {
        const data = slashResult.data as
          | { confirmAction?: string; saveName?: string }
          | undefined;
        if (data?.confirmAction === 'save_overwrite' && data.saveName) {
          const confirmed = await this.sessionManager.requestUserConfirmation(
            params.sessionId,
            {
              title: 'Overwrite checkpoint?',
              message: `A checkpoint named "${data.saveName}" already exists. Overwrite?`,
              command: `/chat save ${data.saveName}`,
              confirmLabel: 'Overwrite',
              cancelLabel: 'Cancel',
            },
          );

          if (confirmed) {
            const historyLength = this.sessionManager.getHistoryLength(
              params.sessionId,
            );
            const lastMessageIndex = historyLength > 0 ? historyLength - 1 : 0;
            await this.sessionManager.saveFromPoint(
              params.sessionId,
              lastMessageIndex,
              data.saveName,
            );
            this.emitUiNotice(
              params.sessionId,
              `Checkpoint saved: ${data.saveName}`,
              'success',
            );
          } else {
            this.emitUiNotice(
              params.sessionId,
              'Checkpoint overwrite cancelled.',
              'info',
            );
          }
        } else {
          this.emitUiNotice(
            params.sessionId,
            slashResult.message ?? 'Confirmation required.',
            'warning',
          );
        }

        if (this.onEndTurn) {
          this.onEndTurn();
        }
        return { stopReason: 'end_turn' };
      }

      if (slashResult.message) {
        const level = this.mapNoticeLevel(slashResult.type);
        this.emitUiNotice(params.sessionId, slashResult.message, level);
      }

      // If the command has a prompt to send (e.g., conductor commands)
      // send it to the LLM
      if (slashResult.promptToSend) {
        await this.sessionManager.sendPrompt(
          params.sessionId,
          slashResult.promptToSend,
        );
        return { stopReason: 'end_turn' };
      }

      // Signal turn complete for non-prompt commands
      if (this.onEndTurn) {
        this.onEndTurn();
      }
      return { stopReason: 'end_turn' };
    }

    // Not a slash command, proceed with normal message
    await this.sessionManager.sendPrompt(params.sessionId, params.prompt);
    return { stopReason: 'end_turn' };
  }

  private emitUiNotice(
    sessionId: string,
    message: string,
    level: 'info' | 'success' | 'warning' | 'error',
  ): void {
    if (!this.onSessionUpdate) {
      return;
    }

    this.onSessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'ui_notice',
        message,
        level,
        dismissible: true,
      },
    });
  }

  private mapNoticeLevel(
    type?: 'info' | 'error' | 'success' | 'confirm',
  ): 'info' | 'success' | 'warning' | 'error' {
    switch (type) {
      case 'error':
        return 'error';
      case 'success':
        return 'success';
      case 'confirm':
        return 'warning';
      default:
        return 'info';
    }
  }

  private normalizeSendPromptParams(params: SendPromptParams): {
    sessionId: string;
    prompt: string;
  } {
    const prompt = params.prompt;
    if (typeof prompt === 'string') {
      return { sessionId: params.sessionId, prompt };
    }

    const parts = Array.isArray(prompt) ? prompt : [];
    const combined = parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    return { sessionId: params.sessionId, prompt: combined };
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
      params.format,
      params.tokenSetId,
      params.partOverrides,
    );
  }

  /**
   * Custom: Regenerate a message from the previous user prompt
   */
  private async regenerateMessage(
    params: RegenerateMessageParams,
  ): Promise<RegenerateMessageResult> {
    return this.sessionManager.regenerateMessage(
      params.sessionId,
      params.messageIndex,
      params.mode,
    );
  }

  /**
   * Custom: Get a message formatted for editing (preserves non-text parts)
   */
  private async getMessageForEdit(
    params: GetMessageForEditParams,
  ): Promise<GetMessageForEditResult> {
    return this.sessionManager.getMessageForEdit(
      params.sessionId,
      params.messageIndex,
      params.exactIndex ?? false,
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
      params.sessionId,
      params.conversationId,
    );

    return {
      sessionId: result.sessionId,
      messageCount: result.messages.length,
    };
  }

  private async handleTurnComplete(sessionId: string): Promise<void> {
    try {
      await this.sessionManager.autoSaveSession(sessionId);
    } catch (error) {
      debugLogger.warn(`[CustomAgentServer] Autosave failed: ${String(error)}`);
    }

    if (this.onEndTurn) {
      this.onEndTurn();
    }
  }

  /**
   * Custom: List all saved conversations
   */
  private async listSaves(): Promise<ListSavesResult> {
    return this.sessionManager.listSaves();
  }

  /**
   * List all available slash commands
   */
  private async listCommands(): Promise<ListCommandsResult> {
    const { getAvailableCommands } = await import('./slashCommandProcessor.js');
    // Use null config since we don't have session context in this RPC yet
    // This will load user commands from ~/.gemini/commands and global extensions
    const commands = await getAvailableCommands(null);

    return {
      commands: commands.map((c) => ({
        name: `/${c.name}`,
        description: c.description,
        category:
          c.extensionName || (c.kind === 'built-in' ? 'built-in' : 'user'),
      })),
    };
  }

  /**
   * Complete partial slash command input
   * Supports both command name completion and argument completion
   */
  private async completeCommand(
    params: CompleteCommandParams,
  ): Promise<CompleteCommandResult> {
    const { getCompletions } = await import('./slashCommandProcessor.js');
    // Use session config if available
    const config = params.sessionId
      ? (this.sessionManager.getConfig(params.sessionId) ?? null)
      : null;

    const completions = await getCompletions(
      params.partial,
      this.sessionManager,
      config,
    );

    // Map to SlashCommandInfo format for frontend compatibility
    const suggestions = completions.map((c) => ({
      name: c.isArgument ? c.displayName : c.text,
      description: c.description,
      category: c.category,
      text: c.text, // Full text to insert
      isArgument: c.isArgument ?? false,
    }));

    return { suggestions };
  }

  /**
   * Cleanup on shutdown
   */
  shutdown(): void {
    this.sessionManager.shutdown();
  }
}
