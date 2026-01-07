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
import { promises as fs } from 'node:fs';
import type { Content, Part } from '@google/genai';
import {
  type Config,
  type GeminiClient,
  Storage,
  Logger,
  type Checkpoint,
  type ConversationRecord,
  type ResumedSessionData,
  type ToolCallRecord,
  debugLogger,
  GeminiEventType,
  CoreToolScheduler,
  type ToolCallRequestInfo,
  type ToolCall,
  type WaitingToolCall,
  type CompletedToolCall,
  ToolConfirmationOutcome,
  Kind,
  SHELL_TOOL_NAME,
  INITIAL_HISTORY_LENGTH,
  partListUnionToString,
  encodeTagName,
} from '@google/gemini-cli-core';
import { initConfig } from './initConfig.js';
import type {
  EditMessageResult,
  HistorySnapshotToolCall,
  SaveFromPointResult,
  ListSavesResult,
  SessionUpdate,
} from './types.js';

type RpcRequestSender = (method: string, params?: unknown) => Promise<unknown>;

type PermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

type PermissionRequest = {
  sessionId: string;
  options: PermissionOption[];
  toolCall: {
    toolCallId: string;
    rawInput?: Record<string, unknown>;
    status?: string;
    title?: string;
    kind?: string;
    content?: ToolCallContent[];
    locations?: Array<{ path: string }>;
  };
};

type PermissionResponse = {
  outcome?: {
    optionId?: string;
  };
  optionId?: string;
};

type ToolCallContent = {
  type: 'content' | 'diff';
  content?: {
    type: 'text';
    text: string;
  };
  path?: string;
  oldText?: string | null;
  newText?: string;
};

type CheckpointMetadata = {
  version: 1;
  savedAt: string;
  conversationId?: string;
  messageCount?: number;
  recording?: ResumedSessionData;
};

interface SessionState {
  id: string;
  workingDirectory: string;
  conversationId?: string;
  config: Config;
  geminiClient: GeminiClient;
  storage: Storage;
  logger: Logger;
  abortController: AbortController;
  toolScheduler: CoreToolScheduler;
  pendingPermissionRequests: Set<string>;
  toolCallCompletion: {
    resolve: (responseParts: Part[]) => void;
    reject: (error: Error) => void;
  } | null;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private rpcRequestSender: RpcRequestSender | null = null;

  // Event callbacks (wired by server.ts)
  onStreamEvent:
    | ((sessionId: string, event: SessionUpdate['update']) => void)
    | null = null;
  onTurnComplete: ((sessionId: string) => void) | null = null;

  setRpcRequestSender(sender: RpcRequestSender): void {
    this.rpcRequestSender = sender;
  }

  /**
   * Create a new chat session with real LLM capabilities
   */
  async createSession(
    workingDirectory?: string,
    conversationId?: string,
  ): Promise<string> {
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

    const toolScheduler = new CoreToolScheduler({
      config,
      getPreferredEditor: () => undefined,
      onToolCallsUpdate: (toolCalls) => {
        this.handleToolCallsUpdate(sessionId, toolCalls);
      },
      onAllToolCallsComplete: async (completedToolCalls) => {
        await this.handleToolCallsComplete(sessionId, completedToolCalls);
      },
    });

    const session: SessionState = {
      id: sessionId,
      workingDirectory: cwd,
      conversationId,
      config,
      geminiClient,
      storage,
      logger,
      abortController: new AbortController(),
      toolScheduler,
      pendingPermissionRequests: new Set(),
      toolCallCompletion: null,
    };

    this.sessions.set(sessionId, session);
    debugLogger.log(`[SessionManager] Created session ${sessionId} in ${cwd}`);
    return sessionId;
  }

  /**
   * Get the Config object for a session
   */
  getConfig(sessionId: string): Config | undefined {
    return this.sessions.get(sessionId)?.config;
  }

  /**
   * Get the working directory for a session
   */
  getWorkingDirectory(sessionId: string): string {
    return this.getSession(sessionId).workingDirectory;
  }

  /**
   * Get the conversation ID for a session
   */
  getConversationId(sessionId: string): string | undefined {
    return this.getSession(sessionId).conversationId;
  }

  getAutosaveTagForConversation(conversationId?: string): string | null {
    return this.getAutosaveTag(conversationId);
  }

  /**
   * Send a prompt to the session using real GeminiChat
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.getSession(sessionId);
    const promptId = `${sessionId}-${Date.now()}`;
    let requestParts: Part[] = [{ text: prompt }];

    try {
      while (true) {
        const responseStream = session.geminiClient.sendMessageStream(
          requestParts,
          session.abortController.signal,
          promptId,
        );

        let fullResponse = '';
        const toolCallRequests: ToolCallRequestInfo[] = [];

        for await (const event of responseStream) {
          switch (event.type) {
            case GeminiEventType.Content: {
              const text = event.value;
              if (text) {
                fullResponse += text;
                this.emitStreamEvent(sessionId, {
                  sessionUpdate: 'agent_message_chunk',
                  content: {
                    type: 'text',
                    text,
                  },
                });
              }
              break;
            }
            case GeminiEventType.Thought: {
              const subject = event.value?.subject || '';
              const description = event.value?.description || '';
              const thoughtText = subject
                ? `**${subject}**\n${description}`.trim()
                : description;
              if (thoughtText) {
                this.emitStreamEvent(sessionId, {
                  sessionUpdate: 'agent_thought_chunk',
                  content: {
                    type: 'text',
                    text: thoughtText,
                  },
                });
              }
              break;
            }
            case GeminiEventType.ToolCallRequest: {
              toolCallRequests.push(event.value);
              break;
            }
            case GeminiEventType.Error: {
              const errorMessage =
                event.value?.error?.message ?? 'Unknown error';
              this.emitStreamEvent(sessionId, {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `[Error: ${errorMessage}]`,
                },
              });
              break;
            }
            default:
              break;
          }
        }

        debugLogger.log(
          `[SessionManager] Response complete: ${fullResponse.length} chars`,
        );

        if (toolCallRequests.length === 0) {
          break;
        }

        debugLogger.log(
          `[SessionManager] Executing ${toolCallRequests.length} tool call(s)`,
        );
        const toolResponses = await this.executeToolCalls(
          sessionId,
          toolCallRequests,
          session.abortController.signal,
        );
        if (toolResponses.length === 0) {
          break;
        }

        requestParts = toolResponses;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[SessionManager] Error in sendPrompt: ${errorMessage}`,
      );
      this.emitStreamEvent(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `[Error: ${errorMessage}]`,
        },
      });
    }

    if (this.onTurnComplete) {
      this.onTurnComplete(sessionId);
    }
  }

  private async executeToolCalls(
    sessionId: string,
    toolCallRequests: ToolCallRequestInfo[],
    signal: AbortSignal,
  ): Promise<Part[]> {
    const session = this.getSession(sessionId);
    return new Promise<Part[]>((resolve, reject) => {
      session.toolCallCompletion = { resolve, reject };
      session.toolScheduler
        .schedule(toolCallRequests, signal)
        .catch((error) => {
          session.toolCallCompletion = null;
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private handleToolCallsUpdate(
    sessionId: string,
    toolCalls: ToolCall[],
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    for (const call of toolCalls) {
      this.emitStreamEvent(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: call.request.callId,
        status: this.mapToolStatus(call.status),
        title: this.getToolTitle(call),
        kind: this.mapToolKind(call.tool?.kind),
        rawInput: this.buildRawInput(call),
        content: this.buildToolCallContent(call),
        locations: this.buildLocations(call.request.args),
      });

      if (call.status === 'awaiting_approval') {
        if (!session.pendingPermissionRequests.has(call.request.callId)) {
          session.pendingPermissionRequests.add(call.request.callId);
          void this.requestToolApproval(sessionId, call);
        }
      } else {
        session.pendingPermissionRequests.delete(call.request.callId);
      }
    }
  }

  private async handleToolCallsComplete(
    sessionId: string,
    completedToolCalls: CompletedToolCall[],
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const responseParts: Part[] = [];

    for (const call of completedToolCalls) {
      if (call.response?.responseParts) {
        responseParts.push(...call.response.responseParts);
      }

      const status = call.status === 'success' ? 'completed' : 'failed';
      const resultText = this.formatToolResult(call);
      const content =
        resultText.length > 0
          ? [
              {
                type: 'content',
                content: { type: 'text', text: resultText },
              },
            ]
          : undefined;

      this.emitStreamEvent(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: call.request.callId,
        status,
        content,
      });

      session.pendingPermissionRequests.delete(call.request.callId);
    }

    if (session.toolCallCompletion) {
      session.toolCallCompletion.resolve(responseParts);
      session.toolCallCompletion = null;
    }
  }

  private async requestToolApproval(
    sessionId: string,
    call: WaitingToolCall,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (!this.rpcRequestSender) {
      await call.confirmationDetails.onConfirm(ToolConfirmationOutcome.Cancel);
      return;
    }

    const permissionRequest: PermissionRequest = {
      sessionId,
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        {
          optionId: 'allow_always',
          name: 'Allow always',
          kind: 'allow_always',
        },
        { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        {
          optionId: 'reject_always',
          name: 'Reject always',
          kind: 'reject_always',
        },
      ],
      toolCall: {
        toolCallId: call.request.callId,
        rawInput: this.buildRawInput(call),
        status: this.mapToolStatus(call.status),
        title: this.getToolTitle(call),
        kind: this.mapToolKind(call.tool?.kind),
        content: this.buildToolCallContent(call),
        locations: this.buildLocations(call.request.args),
      },
    };

    try {
      const response = (await this.rpcRequestSender(
        'session/request_permission',
        permissionRequest,
      )) as PermissionResponse;
      const optionId = response?.outcome?.optionId ?? response?.optionId;
      const outcome = this.mapOptionIdToOutcome(optionId);
      await call.confirmationDetails.onConfirm(outcome);
    } catch (error) {
      debugLogger.warn(
        `[SessionManager] Permission request failed: ${String(error)}`,
      );
      await call.confirmationDetails.onConfirm(ToolConfirmationOutcome.Cancel);
    } finally {
      session.pendingPermissionRequests.delete(call.request.callId);
    }
  }

  private mapOptionIdToOutcome(optionId?: string): ToolConfirmationOutcome {
    switch (optionId) {
      case 'allow_always':
        return ToolConfirmationOutcome.ProceedAlways;
      case 'allow_once':
        return ToolConfirmationOutcome.ProceedOnce;
      default:
        return ToolConfirmationOutcome.Cancel;
    }
  }

  private mapToolStatus(
    status: ToolCall['status'],
  ): 'pending' | 'in_progress' | 'completed' | 'failed' {
    switch (status) {
      case 'executing':
        return 'in_progress';
      case 'success':
        return 'completed';
      case 'error':
      case 'cancelled':
        return 'failed';
      default:
        return 'pending';
    }
  }

  private mapToolKind(kind?: Kind): 'read' | 'edit' | 'execute' {
    switch (kind) {
      case Kind.Read:
      case Kind.Search:
      case Kind.Fetch:
        return 'read';
      case Kind.Edit:
      case Kind.Delete:
      case Kind.Move:
        return 'edit';
      default:
        return 'execute';
    }
  }

  private getToolTitle(call: ToolCall): string {
    if (
      call.status === 'awaiting_approval' &&
      'confirmationDetails' in call &&
      call.confirmationDetails?.title
    ) {
      return call.confirmationDetails.title;
    }
    return call.tool?.displayName ?? call.request.name;
  }

  private buildRawInput(call: ToolCall): Record<string, unknown> | undefined {
    const args = call.request.args || {};
    if (
      call.request.name === SHELL_TOOL_NAME &&
      typeof args['command'] === 'string'
    ) {
      const rawInput: Record<string, unknown> = {
        command: args['command'],
      };
      if (typeof args['description'] === 'string') {
        rawInput['description'] = args['description'];
      }
      return rawInput;
    }
    return Object.keys(args).length > 0 ? args : undefined;
  }

  private buildLocations(
    args: Record<string, unknown>,
  ): Array<{ path: string }> | undefined {
    const pathCandidate =
      (typeof args['file_path'] === 'string' && args['file_path']) ||
      (typeof args['path'] === 'string' && args['path']) ||
      (typeof args['dir_path'] === 'string' && args['dir_path']);

    if (!pathCandidate) {
      return undefined;
    }

    return [{ path: pathCandidate }];
  }

  private buildToolCallContent(call: ToolCall): ToolCallContent[] | undefined {
    if (call.status !== 'awaiting_approval') {
      return undefined;
    }

    const waitingCall = call;
    if (waitingCall.confirmationDetails?.type !== 'edit') {
      return undefined;
    }

    const details = waitingCall.confirmationDetails;
    return [
      {
        type: 'diff',
        path: details.filePath || details.fileName || '',
        oldText: details.originalContent ?? '',
        newText: details.newContent ?? '',
      },
    ];
  }

  private formatToolResult(call: CompletedToolCall): string {
    const resultDisplay = call.response?.resultDisplay;
    if (typeof resultDisplay === 'string') {
      return resultDisplay;
    }
    if (resultDisplay !== undefined) {
      try {
        return JSON.stringify(resultDisplay, null, 2);
      } catch {
        return String(resultDisplay);
      }
    }
    if (call.response?.error) {
      return call.response.error.message;
    }
    return '';
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

      const newSessionId = await this.createSession(
        session.workingDirectory,
        session.conversationId,
      );
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
    await this.saveCheckpointMetadata(session, saveName, historyToSave);

    const savePath = path.join(
      session.storage.getProjectTempDir(),
      `checkpoint-${encodeTagName(saveName)}.json`,
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
    providedSessionId?: string,
    conversationId?: string,
  ): Promise<{
    sessionId: string;
    messages: Array<{
      role: 'user' | 'model';
      content: string;
      toolCalls?: HistorySnapshotToolCall[];
    }>;
  }> {
    const cwd = workingDirectory ?? process.cwd();
    let sessionId = providedSessionId;
    let session: SessionState;
    if (sessionId && this.sessions.has(sessionId)) {
      session = this.getSession(sessionId);
      if (conversationId && !session.conversationId) {
        session.conversationId = conversationId;
      }
    } else {
      sessionId = await this.createSession(cwd, conversationId);
      session = this.getSession(sessionId);
    }

    // Load checkpoint
    const checkpoint = await session.logger.loadCheckpoint(saveName);

    if (checkpoint.history.length === 0) {
      throw new Error(`Save not found: ${saveName}`);
    }

    const metadata = await this.loadCheckpointMetadata(
      session.storage,
      saveName,
    );
    const recording = metadata?.recording;
    const messageLimit =
      metadata?.messageCount ??
      Math.max(0, checkpoint.history.length - INITIAL_HISTORY_LENGTH);

    if (recording) {
      const historyWithoutInitial = checkpoint.history.slice(
        INITIAL_HISTORY_LENGTH,
      );
      await session.geminiClient.resumeChat(historyWithoutInitial, recording);
    } else {
      await session.geminiClient.resetChat();
      session.geminiClient.setHistory(checkpoint.history);
    }

    const messages = recording?.conversation
      ? this.buildHistorySnapshotFromConversation(
          recording.conversation,
          messageLimit,
        )
      : checkpoint.history.slice(INITIAL_HISTORY_LENGTH).reduce<
          Array<{
            role: 'user' | 'model';
            content: string;
            toolCalls?: HistorySnapshotToolCall[];
          }>
        >((acc, content) => {
          const role = content.role === 'user' ? 'user' : 'model';
          const text = this.formatHistoryParts(content.parts).trim();
          if (text.length > 0) {
            acc.push({ role, content: text });
          }
          return acc;
        }, []);

    // Emit restored messages to frontend so they appear in the chat window
    this.emitStreamEvent(sessionId, {
      sessionUpdate: 'history_snapshot',
      messages,
    });

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
        if (
          file.endsWith('.aionui.json') ||
          file.endsWith('.aionui-recording.json')
        ) {
          continue;
        }

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
   * Check if a checkpoint with the given name already exists
   */
  async saveExists(saveName: string): Promise<boolean> {
    const storage =
      this.sessions.size > 0
        ? Array.from(this.sessions.values())[0].storage
        : new Storage(process.cwd());

    const checkpointsDir = storage.getProjectTempDir();
    const encodedTag = encodeTagName(saveName);
    const encodedPath = path.join(
      checkpointsDir,
      `checkpoint-${encodedTag}.json`,
    );
    const legacyPath = path.join(checkpointsDir, `checkpoint-${saveName}.json`);

    try {
      const fs = await import('node:fs/promises');
      await fs.access(encodedPath);
      return true;
    } catch {
      try {
        const fs = await import('node:fs/promises');
        await fs.access(legacyPath);
        return true;
      } catch {
        return false;
      }
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

  private formatHistoryParts(parts?: Part[]): string {
    if (!parts || parts.length === 0) {
      return '';
    }

    return parts.map((part) => (part.text ? part.text : '')).join('');
  }

  private getAutosaveTag(conversationId?: string): string | null {
    if (!conversationId) {
      return null;
    }
    return `aionui-autosave-${conversationId}`;
  }

  private getCheckpointMetadataPath(storage: Storage, tag: string): string {
    const encodedTag = encodeTagName(tag);
    return path.join(
      storage.getProjectTempDir(),
      `checkpoint-${encodedTag}.aionui.json`,
    );
  }

  private getCheckpointRecordingPath(storage: Storage, tag: string): string {
    const encodedTag = encodeTagName(tag);
    return path.join(
      storage.getProjectTempDir(),
      `checkpoint-${encodedTag}.aionui-recording.json`,
    );
  }

  private async saveCheckpointMetadata(
    session: SessionState,
    saveName: string,
    historyToSave: Content[],
  ): Promise<void> {
    try {
      const metadataPath = this.getCheckpointMetadataPath(
        session.storage,
        saveName,
      );
      await fs.mkdir(path.dirname(metadataPath), { recursive: true });

      const messageCount = Math.max(
        0,
        historyToSave.length - INITIAL_HISTORY_LENGTH,
      );

      let recording: ResumedSessionData | undefined;
      const recordingService = session.geminiClient.getChatRecordingService();
      const conversation = recordingService?.getConversation();
      if (conversation) {
        const trimmedConversation = this.trimConversationRecord(
          conversation,
          messageCount,
        );
        const recordingPath = this.getCheckpointRecordingPath(
          session.storage,
          saveName,
        );
        await fs.writeFile(
          recordingPath,
          JSON.stringify(trimmedConversation, null, 2),
          'utf-8',
        );
        recording = {
          conversation: trimmedConversation,
          filePath: recordingPath,
        };
      }

      const metadata: CheckpointMetadata = {
        version: 1,
        savedAt: new Date().toISOString(),
        conversationId: session.conversationId,
        messageCount,
        ...(recording ? { recording } : {}),
      };

      await fs.writeFile(
        metadataPath,
        JSON.stringify(metadata, null, 2),
        'utf-8',
      );
    } catch (error) {
      debugLogger.warn(
        `[SessionManager] Failed to write checkpoint metadata: ${String(error)}`,
      );
    }
  }

  private async loadCheckpointMetadata(
    storage: Storage,
    tag: string,
  ): Promise<CheckpointMetadata | null> {
    const primaryPath = this.getCheckpointMetadataPath(storage, tag);
    const legacyPath = path.join(
      storage.getProjectTempDir(),
      `checkpoint-${tag}.aionui.json`,
    );
    const pathsToTry = [primaryPath, legacyPath];

    for (const metadataPath of pathsToTry) {
      try {
        const raw = await fs.readFile(metadataPath, 'utf-8');
        return JSON.parse(raw) as CheckpointMetadata;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        debugLogger.warn(
          `[SessionManager] Failed to read checkpoint metadata: ${String(error)}`,
        );
        return null;
      }
    }

    return null;
  }

  private trimConversationRecord(
    conversation: ConversationRecord,
    maxMessages: number,
  ): ConversationRecord {
    if (maxMessages <= 0) {
      return { ...conversation, messages: [] };
    }

    let count = 0;
    const trimmedMessages: ConversationRecord['messages'] = [];
    for (const message of conversation.messages) {
      if (message.type !== 'user' && message.type !== 'gemini') {
        continue;
      }
      trimmedMessages.push(message);
      count += 1;
      if (count >= maxMessages) {
        break;
      }
    }

    return { ...conversation, messages: trimmedMessages };
  }

  private buildHistorySnapshotFromConversation(
    conversation: ConversationRecord,
    maxMessages?: number,
  ): Array<{
    role: 'user' | 'model';
    content: string;
    toolCalls?: HistorySnapshotToolCall[];
    timestamp?: number;
  }> {
    const messages: Array<{
      role: 'user' | 'model';
      content: string;
      toolCalls?: HistorySnapshotToolCall[];
      timestamp?: number;
    }> = [];

    let count = 0;
    for (const record of conversation.messages) {
      if (record.type !== 'user' && record.type !== 'gemini') {
        continue;
      }
      if (maxMessages !== undefined && count >= maxMessages) {
        break;
      }

      const content = partListUnionToString(record.content ?? []);
      const toolCalls =
        record.type === 'gemini' && record.toolCalls?.length
          ? record.toolCalls.map((call: ToolCallRecord) => ({
              id: call.id,
              name: call.name,
              args: call.args ?? {},
              status: call.status,
              displayName: call.displayName,
              description: call.description,
              resultDisplay:
                call.resultDisplay ??
                (call.result ? partListUnionToString(call.result) : undefined),
              renderOutputAsMarkdown: call.renderOutputAsMarkdown,
            }))
          : undefined;

      const parsedTimestamp = record.timestamp
        ? Date.parse(record.timestamp)
        : NaN;

      messages.push({
        role: record.type === 'user' ? 'user' : 'model',
        content,
        toolCalls,
        ...(Number.isFinite(parsedTimestamp)
          ? { timestamp: parsedTimestamp }
          : {}),
      });
      count += 1;
    }

    return messages;
  }

  async autoSaveSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const autosaveTag = this.getAutosaveTag(session.conversationId);
    if (!autosaveTag) {
      return;
    }

    const historyLength = session.geminiClient.getHistory().length;
    if (historyLength <= INITIAL_HISTORY_LENGTH) {
      return;
    }

    const lastMessageIndex = historyLength - 1;
    try {
      await this.saveFromPoint(sessionId, lastMessageIndex, autosaveTag);
    } catch (error) {
      debugLogger.warn(
        `[SessionManager] Autosave failed for ${autosaveTag}: ${String(error)}`,
      );
    }
  }
}
