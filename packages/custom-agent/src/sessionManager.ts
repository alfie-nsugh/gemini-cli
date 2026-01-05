/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session Manager
 *
 * Manages chat sessions with real GeminiChat LLM calls.
 * Uses gemini-cli-core's Config, GeminiClient, and Logger.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Content } from '@google/genai';
import {
  type Config,
  type GeminiClient,
  Storage,
  Logger,
  type Checkpoint,
  debugLogger,
  GeminiEventType,
} from '@google/gemini-cli-core';
import { initConfig } from './initConfig.js';
import type {
  EditMessageResult,
  SaveFromPointResult,
  ListSavesResult,
  SessionUpdate,
} from './types.js';

interface SessionState {
  id: string;
  workingDirectory: string;
  config: Config;
  geminiClient: GeminiClient;
  storage: Storage;
  logger: Logger;
  abortController: AbortController;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  // Event callbacks (wired by server.ts)
  onStreamEvent:
    | ((sessionId: string, event: SessionUpdate['update']) => void)
    | null = null;
  onTurnComplete: ((sessionId: string) => void) | null = null;

  /**
   * Create a new chat session with real LLM capabilities
   */
  async createSession(workingDirectory?: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const cwd = workingDirectory ?? process.cwd();

    // Initialize full Config with GeminiClient
    const config = await initConfig(sessionId, cwd);
    const geminiClient = config.getGeminiClient();

    // Use gemini-cli-core's Storage for proper path handling
    const storage = new Storage(cwd);

    // Create Logger for checkpoint management (shares checkpoints with gemini-cli)
    const logger = new Logger(sessionId, storage);
    await logger.initialize();

    const session: SessionState = {
      id: sessionId,
      workingDirectory: cwd,
      config,
      geminiClient,
      storage,
      logger,
      abortController: new AbortController(),
    };

    this.sessions.set(sessionId, session);
    debugLogger.log(`[SessionManager] Created session ${sessionId} in ${cwd}`);
    return sessionId;
  }

  /**
   * Send a prompt to the session using real GeminiChat
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.getSession(sessionId);
    const promptId = `${sessionId}-${Date.now()}`;

    // Emit user message
    this.emitStreamEvent(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      role: 'user',
      content: prompt,
    });

    try {
      // Use GeminiClient.sendMessageStream for real LLM call
      const responseStream = session.geminiClient.sendMessageStream(
        [{ text: prompt }],
        session.abortController.signal,
        promptId,
      );

      let fullResponse = '';

      for await (const event of responseStream) {
        if (event.type === GeminiEventType.Content) {
          const text = event.value;
          if (text) {
            fullResponse += text;
            // Stream the chunk
            this.emitStreamEvent(sessionId, {
              sessionUpdate: 'agent_message_chunk',
              role: 'model',
              content: text,
            });
          }
        } else if (event.type === GeminiEventType.Error) {
          const errorMessage = event.value?.error?.message ?? 'Unknown error';
          this.emitStreamEvent(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            role: 'model',
            content: `[Error: ${errorMessage}]`,
          });
          break;
        } else if (event.type === GeminiEventType.ToolCallRequest) {
          // Handle tool calls if needed
          debugLogger.log(
            `[SessionManager] Tool call requested: ${event.value?.name}`,
          );
          // For now, we don't auto-execute tools in custom-agent
        }
      }

      debugLogger.log(
        `[SessionManager] Response complete: ${fullResponse.length} chars`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[SessionManager] Error in sendPrompt: ${errorMessage}`,
      );
      this.emitStreamEvent(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        role: 'model',
        content: `[Error: ${errorMessage}]`,
      });
    }

    // Signal turn complete
    if (this.onTurnComplete) {
      this.onTurnComplete(sessionId);
    }
  }

  /**
   * Cancel the current request for a session
   */
  cancelRequest(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.abortController.abort();
      // Create new abort controller for future requests
      session.abortController = new AbortController();
    }
  }

  /**
   * Get conversation history for a session
   */
  getHistory(sessionId: string): Content[] {
    const session = this.getSession(sessionId);
    return session.geminiClient.getHistory();
  }

  /**
   * Edit a message in the conversation history
   */
  async editMessage(
    sessionId: string,
    messageIndex: number,
    newContent: string,
    mode: 'fork' | 'inPlace',
  ): Promise<EditMessageResult> {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();

    if (messageIndex < 0 || messageIndex >= history.length) {
      throw new Error(`Invalid message index: ${messageIndex}`);
    }

    const originalMessage = history[messageIndex];

    if (mode === 'inPlace') {
      // Edit in place: modify history directly
      history[messageIndex] = {
        ...originalMessage,
        parts: [{ text: newContent }],
      };
      session.geminiClient.setHistory(history);
      return { success: true };
    } else {
      // Fork mode: create new session with truncated history
      const newHistory = history.slice(0, messageIndex);
      newHistory.push({
        ...originalMessage,
        parts: [{ text: newContent }],
      });

      const newSessionId = await this.createSession(session.workingDirectory);
      const newSession = this.getSession(newSessionId);
      newSession.geminiClient.setHistory(newHistory);

      return { success: true, newSessionId };
    }
  }

  /**
   * Delete a message from conversation history
   */
  async deleteMessage(sessionId: string, messageIndex: number): Promise<void> {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();

    if (messageIndex < 0 || messageIndex >= history.length) {
      throw new Error(`Invalid message index: ${messageIndex}`);
    }

    history.splice(messageIndex, 1);
    session.geminiClient.setHistory(history);
  }

  /**
   * Save conversation using gemini-cli-core's Logger
   * Compatible with gemini CLI's /chat save command
   */
  async saveFromPoint(
    sessionId: string,
    messageIndex: number,
    saveName: string,
  ): Promise<SaveFromPointResult> {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();

    // Clamp message index to valid range
    const validIndex = Math.min(Math.max(0, messageIndex), history.length);
    const historyToSave = history.slice(0, validIndex + 1);

    const checkpoint: Checkpoint = {
      history: historyToSave,
      authType: session.config.getContentGeneratorConfig()?.authType,
    };

    await session.logger.saveCheckpoint(checkpoint, saveName);

    const savePath = path.join(
      session.storage.getProjectTempDir(),
      `checkpoint-${saveName}.json`,
    );

    debugLogger.log(
      `[SessionManager] Saved checkpoint "${saveName}" at ${savePath}`,
    );
    return { success: true, savePath };
  }

  /**
   * Resume a saved conversation
   */
  async resumeSession(
    saveName: string,
    workingDirectory?: string,
  ): Promise<{
    sessionId: string;
    messages: Array<{ role: 'user' | 'model'; content: string }>;
  }> {
    const cwd = workingDirectory ?? process.cwd();
    const sessionId = await this.createSession(cwd);
    const session = this.getSession(sessionId);

    // Load checkpoint
    const checkpoint = await session.logger.loadCheckpoint(saveName);

    if (checkpoint.history.length === 0) {
      throw new Error(`Save not found: ${saveName}`);
    }

    // Resume the GeminiClient with loaded history
    await session.geminiClient.resumeChat(checkpoint.history);

    const messages = checkpoint.history.map((content) => ({
      role: content.role as 'user' | 'model',
      content: content.parts?.map((p) => p.text ?? '').join('') ?? '',
    }));

    debugLogger.log(
      `[SessionManager] Resumed checkpoint "${saveName}" with ${messages.length} messages`,
    );

    return { sessionId, messages };
  }

  /**
   * List all saved conversations
   */
  async listSaves(): Promise<ListSavesResult> {
    const storage =
      this.sessions.size > 0
        ? Array.from(this.sessions.values())[0].storage
        : new Storage(process.cwd());

    const checkpointsDir = storage.getProjectTempDir();

    try {
      const fs = await import('node:fs/promises');
      await fs.mkdir(checkpointsDir, { recursive: true });
      const files = await fs.readdir(checkpointsDir);

      const saves: ListSavesResult['saves'] = [];

      for (const file of files) {
        if (!file.startsWith('checkpoint-') || !file.endsWith('.json'))
          continue;

        try {
          const filePath = path.join(checkpointsDir, file);
          const stats = await fs.stat(filePath);
          const data = await fs.readFile(filePath, 'utf-8');
          const checkpoint = JSON.parse(data) as Checkpoint;

          const name = file.slice('checkpoint-'.length, -'.json'.length);

          saves.push({
            name,
            createdAt: stats.mtimeMs,
            messageCount: checkpoint.history?.length ?? 0,
          });
        } catch {
          // Skip invalid files
        }
      }

      return { saves };
    } catch {
      return { saves: [] };
    }
  }

  /**
   * Get history length for a session
   */
  getHistoryLength(sessionId: string): number {
    const session = this.getSession(sessionId);
    return session.geminiClient.getHistory().length;
  }

  /**
   * Cleanup on shutdown
   */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
      session.logger.close();
    }
    this.sessions.clear();
  }

  // Helper methods

  private getSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private emitStreamEvent(
    sessionId: string,
    event: SessionUpdate['update'],
  ): void {
    if (this.onStreamEvent) {
      this.onStreamEvent(sessionId, event);
    }
  }
}
