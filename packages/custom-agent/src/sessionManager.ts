/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session Manager
 *
 * Manages chat sessions with direct history manipulation capabilities.
 * Wraps gemini-cli-core's GeminiChat for the underlying LLM interaction.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Content } from '@google/genai';
import type {
  EditMessageResult,
  SaveFromPointResult,
  ListSavesResult,
  SessionUpdate,
} from './types.js';

// Import from gemini-cli-core (workspace dependency)
// TODO: Import and use actual GeminiChat when ready
// import { GeminiChat } from '@google/gemini-cli-core';

interface SessionState {
  id: string;
  // chat: GeminiChat | null; // Will use actual GeminiChat when integrated
  workingDirectory: string;
  history: Content[];
}

interface SavedSession {
  name: string;
  createdAt: number;
  workingDirectory: string;
  history: Content[];
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private savesDir: string;

  // Event callbacks (wired by server.ts)
  onStreamEvent:
    | ((sessionId: string, event: SessionUpdate['update']) => void)
    | null = null;
  onTurnComplete: ((sessionId: string) => void) | null = null;

  constructor() {
    // Store saves in ~/.gemini/custom-agent/saves/
    this.savesDir = path.join(os.homedir(), '.gemini', 'custom-agent', 'saves');
  }

  /**
   * Create a new chat session
   */
  async createSession(workingDirectory?: string): Promise<string> {
    const sessionId = this.generateSessionId();
    const cwd = workingDirectory ?? process.cwd();

    // TODO: Initialize actual GeminiChat when integrating with gemini-cli-core
    // For now, we manage history directly
    const session: SessionState = {
      id: sessionId,
      workingDirectory: cwd,
      history: [],
    };

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  /**
   * Send a prompt to the session
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.getSession(sessionId);

    // Add user message to history
    const userContent: Content = {
      role: 'user',
      parts: [{ text: prompt }],
    };
    session.history.push(userContent);

    // Emit user message
    this.emitStreamEvent(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      role: 'user',
      content: prompt,
    });

    // TODO: Integrate with GeminiChat.sendMessageStream()
    // For now, simulate a response
    const modelContent: Content = {
      role: 'model',
      parts: [{ text: `[Placeholder response for: ${prompt}]` }],
    };
    session.history.push(modelContent);

    // Emit model response
    const responseText = modelContent.parts?.[0]?.text ?? '';
    this.emitStreamEvent(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      role: 'model',
      content: responseText,
    });

    // Signal turn complete
    if (this.onTurnComplete) {
      this.onTurnComplete(sessionId);
    }
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

    if (messageIndex < 0 || messageIndex >= session.history.length) {
      throw new Error(`Invalid message index: ${messageIndex}`);
    }

    const originalMessage = session.history[messageIndex];

    if (mode === 'inPlace') {
      // Edit in place: just modify this message, keep everything after
      session.history[messageIndex] = {
        ...originalMessage,
        parts: [{ text: newContent }],
      };
      return { success: true };
    } else {
      // Fork mode: truncate history and regenerate
      // Truncate history to include only up to (but not including) the edited message
      const newHistory = session.history.slice(0, messageIndex);

      // Add the edited message
      newHistory.push({
        ...originalMessage,
        parts: [{ text: newContent }],
      });

      // Create a new session with the truncated + edited history
      const newSessionId = await this.createSession(session.workingDirectory);
      const newSession = this.getSession(newSessionId);
      newSession.history = newHistory;

      // Emit history snapshot for the new session
      this.emitHistorySnapshot(newSessionId, newHistory);

      // TODO: Trigger regeneration by calling sendPrompt with empty or continuation

      return { success: true, newSessionId };
    }
  }

  /**
   * Delete a message from conversation history
   */
  async deleteMessage(sessionId: string, messageIndex: number): Promise<void> {
    const session = this.getSession(sessionId);

    if (messageIndex < 0 || messageIndex >= session.history.length) {
      throw new Error(`Invalid message index: ${messageIndex}`);
    }

    // Remove the message
    session.history.splice(messageIndex, 1);
  }

  /**
   * Save conversation from a specific point
   */
  async saveFromPoint(
    sessionId: string,
    messageIndex: number,
    saveName: string,
  ): Promise<SaveFromPointResult> {
    const session = this.getSession(sessionId);

    if (messageIndex < 0 || messageIndex > session.history.length) {
      throw new Error(`Invalid message index: ${messageIndex}`);
    }

    // Get history up to this point
    const historyToSave = session.history.slice(0, messageIndex + 1);

    const savedSession: SavedSession = {
      name: saveName,
      createdAt: Date.now(),
      workingDirectory: session.workingDirectory,
      history: historyToSave,
    };

    // Ensure saves directory exists
    await fs.mkdir(this.savesDir, { recursive: true });

    const savePath = path.join(this.savesDir, `${saveName}.json`);
    await fs.writeFile(
      savePath,
      JSON.stringify(savedSession, null, 2),
      'utf-8',
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
    const savePath = path.join(this.savesDir, `${saveName}.json`);

    let savedSession: SavedSession;
    try {
      const data = await fs.readFile(savePath, 'utf-8');
      savedSession = JSON.parse(data) as SavedSession;
    } catch {
      throw new Error(`Save not found: ${saveName}`);
    }

    // Create new session with restored history
    const cwd = workingDirectory ?? savedSession.workingDirectory;
    const sessionId = await this.createSession(cwd);
    const session = this.getSession(sessionId);
    session.history = savedSession.history;

    // Convert history to simplified message format for UI
    const messages = savedSession.history.map((content) => ({
      role: content.role as 'user' | 'model',
      content: content.parts?.map((p) => p.text ?? '').join('') ?? '',
    }));

    return { sessionId, messages };
  }

  /**
   * List all saved conversations
   */
  async listSaves(): Promise<ListSavesResult> {
    try {
      await fs.mkdir(this.savesDir, { recursive: true });
      const files = await fs.readdir(this.savesDir);

      const saves: ListSavesResult['saves'] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const data = await fs.readFile(
            path.join(this.savesDir, file),
            'utf-8',
          );
          const saved = JSON.parse(data) as SavedSession;
          saves.push({
            name: saved.name,
            createdAt: saved.createdAt,
            messageCount: saved.history.length,
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
   * Cleanup on shutdown
   */
  shutdown(): void {
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

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private emitStreamEvent(
    sessionId: string,
    event: SessionUpdate['update'],
  ): void {
    if (this.onStreamEvent) {
      this.onStreamEvent(sessionId, event);
    }
  }

  private emitHistorySnapshot(sessionId: string, history: Content[]): void {
    const messages = history.map((content) => ({
      role: content.role as 'user' | 'model',
      content: content.parts?.map((p) => p.text ?? '').join('') ?? '',
    }));

    this.emitStreamEvent(sessionId, {
      sessionUpdate: 'history_snapshot',
      messages,
    });
  }
}
