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
  encodeTagName,
  isFunctionResponse,
  isFunctionCall,
} from '@google/gemini-cli-core';
import { initConfig } from './initConfig.js';
import type {
  EditMessageFormat,
  EditMessagePartOverride,
  EditMessageResult,
  RegenerateMessageResult,
  GetMessageForEditResult,
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

type SaveLookupOptions = {
  sessionId?: string;
  workingDirectory?: string;
  conversationId?: string;
  filterAutosavesToConversation?: boolean;
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

const EDIT_MESSAGE_FORMAT: EditMessageFormat = 'aionui-part-v1';
const EDIT_TOKEN_PREFIX = '[[AIONUI_PART:';
const EDIT_TOKEN_SUFFIX = ']]';
const EDIT_TOKEN_PATTERN = /\[\[AIONUI_PART:([a-f0-9-]+)\]\]/g;

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
  editTokenSets: Map<string, Map<string, Part>>;
  editTokenTargets: Map<string, number>;
  toolCallCompletion: {
    resolve: (responseParts: Part[]) => void;
    reject: (error: Error) => void;
  } | null;
  toolCallOrderByName: Map<string, string[]>;
  toolCallNameById: Map<string, string>;
  pendingToolCallIndexUpdates: Map<string, 'completed' | 'failed'>;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private rpcRequestSender: RpcRequestSender | null = null;

  private logAutosave(event: string, details: Record<string, unknown>): void {
    debugLogger.warn(`[AutosaveDebug] ${event} ${JSON.stringify(details)}`);
  }

  private getStorageForLookup(options?: SaveLookupOptions): Storage {
    if (options?.sessionId && this.sessions.has(options.sessionId)) {
      return this.getSession(options.sessionId).storage;
    }

    if (options?.workingDirectory) {
      return new Storage(path.resolve(options.workingDirectory));
    }

    if (this.sessions.size > 0) {
      return Array.from(this.sessions.values())[0].storage;
    }

    return new Storage(process.cwd());
  }

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
    const rawWorkingDirectory = workingDirectory;
    const cwd = path.resolve(rawWorkingDirectory ?? process.cwd());

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
      editTokenSets: new Map(),
      editTokenTargets: new Map(),
      toolCallCompletion: null,
      toolCallOrderByName: new Map(),
      toolCallNameById: new Map(),
      pendingToolCallIndexUpdates: new Map(),
    };

    this.sessions.set(sessionId, session);
    this.logAutosave('session_created', {
      sessionId,
      conversationId,
      workingDirectory: cwd,
      rawWorkingDirectory,
      projectTempDir: storage.getProjectTempDir(),
    });
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
    await this.sendPromptWithParts(sessionId, [{ text: prompt }]);
  }

  private async sendPromptWithParts(
    sessionId: string,
    initialParts: Part[],
  ): Promise<void> {
    const session = this.getSession(sessionId);
    const promptId = `${sessionId}-${Date.now()}`;
    let requestParts: Part[] = initialParts;
    let isToolResponseTurn = false;

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

        if (isToolResponseTurn) {
          this.flushToolCallIndexUpdates(sessionId);
          isToolResponseTurn = false;
        }

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
        isToolResponseTurn = true;
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
      this.registerToolCall(session, call);
      const { callHistoryIndex, responseHistoryIndex } =
        this.resolveToolCallHistoryIndices(session, call.request.callId);
      this.emitStreamEvent(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: call.request.callId,
        status: this.mapToolStatus(call.status),
        title: this.getToolTitle(call),
        kind: this.mapToolKind(call.tool?.kind),
        rawInput: this.buildRawInput(call),
        content: this.buildToolCallContent(call),
        locations: this.buildLocations(call.request.args),
        callHistoryIndex,
        responseHistoryIndex,
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
      this.registerToolCall(session, call);
      const { callHistoryIndex, responseHistoryIndex } =
        this.resolveToolCallHistoryIndices(session, call.request.callId);
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
        callHistoryIndex,
        responseHistoryIndex,
      });

      session.pendingPermissionRequests.delete(call.request.callId);
      session.pendingToolCallIndexUpdates.set(call.request.callId, status);
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

  async requestUserConfirmation(
    sessionId: string,
    details: {
      title: string;
      message?: string;
      command?: string;
      confirmLabel?: string;
      cancelLabel?: string;
    },
  ): Promise<boolean> {
    if (!this.rpcRequestSender) {
      return false;
    }

    const title = details.message ?? details.title;
    const permissionRequest: PermissionRequest = {
      sessionId,
      options: [
        {
          optionId: 'allow_once',
          name: details.confirmLabel ?? 'Confirm',
          kind: 'allow_once',
        },
        {
          optionId: 'reject_once',
          name: details.cancelLabel ?? 'Cancel',
          kind: 'reject_once',
        },
      ],
      toolCall: {
        toolCallId: crypto.randomUUID(),
        rawInput: {
          ...(details.command ? { command: details.command } : {}),
          ...(details.message ? { description: details.message } : {}),
        },
        status: 'pending',
        title,
        kind: 'execute',
        ...(details.message
          ? {
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: details.message },
                },
              ],
            }
          : {}),
      },
    };

    try {
      const response = (await this.rpcRequestSender(
        'session/request_permission',
        permissionRequest,
      )) as PermissionResponse;
      const optionId = response?.outcome?.optionId ?? response?.optionId;
      return optionId?.startsWith('allow') ?? false;
    } catch (error) {
      debugLogger.warn(
        `[SessionManager] Confirmation request failed: ${String(error)}`,
      );
      return false;
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

  private registerToolCall(
    session: SessionState,
    call: ToolCall | WaitingToolCall | CompletedToolCall,
  ): void {
    const toolCallId = call.request.callId;
    if (session.toolCallNameById.has(toolCallId)) {
      return;
    }
    const name = call.request.name ?? 'unknown';
    session.toolCallNameById.set(toolCallId, name);
    const order = session.toolCallOrderByName.get(name) ?? [];
    order.push(toolCallId);
    session.toolCallOrderByName.set(name, order);
  }

  private resolveToolCallHistoryIndices(
    session: SessionState,
    toolCallId: string,
  ): { callHistoryIndex?: number; responseHistoryIndex?: number } {
    const name = session.toolCallNameById.get(toolCallId);
    if (!name) {
      return {};
    }
    const order = session.toolCallOrderByName.get(name) ?? [];
    const ordinal = order.indexOf(toolCallId);
    if (ordinal < 0) {
      return {};
    }

    const history = session.geminiClient.getHistory();
    let callHistoryIndex: number | undefined;
    let responseHistoryIndex: number | undefined;
    let callCount = 0;
    let responseCount = 0;

    for (let index = INITIAL_HISTORY_LENGTH; index < history.length; index++) {
      const entry = history[index];
      for (const part of entry.parts ?? []) {
        if (part.functionCall?.name === name) {
          if (callCount === ordinal && callHistoryIndex === undefined) {
            callHistoryIndex = index;
          }
          callCount += 1;
        }
        if (part.functionResponse?.name === name) {
          if (responseCount === ordinal && responseHistoryIndex === undefined) {
            responseHistoryIndex = index;
          }
          responseCount += 1;
        }
      }
      if (
        callHistoryIndex !== undefined &&
        responseHistoryIndex !== undefined
      ) {
        break;
      }
    }

    return { callHistoryIndex, responseHistoryIndex };
  }

  private flushToolCallIndexUpdates(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.pendingToolCallIndexUpdates.size === 0) {
      return;
    }

    const pending = new Map(session.pendingToolCallIndexUpdates);
    session.pendingToolCallIndexUpdates.clear();

    for (const [toolCallId, status] of pending.entries()) {
      const { callHistoryIndex, responseHistoryIndex } =
        this.resolveToolCallHistoryIndices(session, toolCallId);
      if (
        callHistoryIndex === undefined &&
        responseHistoryIndex === undefined
      ) {
        continue;
      }
      this.emitStreamEvent(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status,
        callHistoryIndex,
        responseHistoryIndex,
      });
    }
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
    format?: EditMessageFormat,
    tokenSetId?: string,
    partOverrides?: EditMessagePartOverride[],
  ): Promise<EditMessageResult> {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();

    const resolvedIndex = tokenSetId
      ? session.editTokenTargets.get(tokenSetId)
      : undefined;
    const targetIndex =
      typeof resolvedIndex === 'number' ? resolvedIndex : messageIndex;

    if (targetIndex < 0 || targetIndex >= history.length) {
      throw new Error(`Invalid message index: ${targetIndex}`);
    }

    const originalMessage = history[targetIndex];
    const updatedParts =
      format === EDIT_MESSAGE_FORMAT
        ? this.parseEditableContent(
            session,
            newContent,
            tokenSetId,
            partOverrides,
          )
        : [{ text: newContent }];

    if (mode === 'inPlace') {
      // Edit in place: modify history directly
      history[targetIndex] = {
        ...originalMessage,
        parts: updatedParts,
      };
      session.geminiClient.setHistory(history);
      this.emitHistorySnapshot(sessionId);
      return { success: true };
    } else {
      // Fork mode: create new session with truncated history
      const newHistory = history.slice(0, targetIndex);
      newHistory.push({
        ...originalMessage,
        parts: updatedParts,
      });

      const newSessionId = await this.createSession(
        session.workingDirectory,
        session.conversationId,
      );
      const newSession = this.getSession(newSessionId);
      newSession.geminiClient.setHistory(newHistory);
      this.emitHistorySnapshot(newSessionId);

      return { success: true, newSessionId };
    }
  }

  /**
   * Regenerate a model response from the previous user prompt.
   * - inPlace: Replace only the target model response, keep subsequent messages
   * - fork: Truncate at the prompt and create a new session
   */
  async regenerateMessage(
    sessionId: string,
    messageIndex: number,
    mode: 'fork' | 'inPlace',
  ): Promise<RegenerateMessageResult> {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();

    if (messageIndex < 0 || messageIndex >= history.length) {
      throw new Error(`Invalid message index: ${messageIndex}`);
    }

    const targetMessage = history[messageIndex];
    if (targetMessage.role !== 'model') {
      throw new Error('Regenerate is only supported for model messages.');
    }
    if (isFunctionCall(targetMessage)) {
      throw new Error(
        'Cannot regenerate a tool-call message. Regenerate the final model response instead.',
      );
    }

    const promptIndex = this.findRegenerationPromptIndex(history, messageIndex);
    if (promptIndex === null) {
      throw new Error('No user prompt found to regenerate from.');
    }

    const promptParts = history[promptIndex].parts ?? [];
    if (promptParts.length === 0) {
      throw new Error('User prompt is empty.');
    }

    // History before the user prompt (kept in both modes)
    const baseHistory = history.slice(0, promptIndex);

    if (mode === 'inPlace') {
      // Save everything AFTER the target model message to restore later
      const tailHistory = history.slice(messageIndex + 1);

      // Truncate to just before the user prompt
      session.geminiClient.setHistory(baseHistory);
      this.emitHistorySnapshot(sessionId);

      // Regenerate the response
      await this.sendPromptWithParts(sessionId, promptParts);

      // Restore the tail (subsequent messages) after regeneration
      if (tailHistory.length > 0) {
        const currentHistory = session.geminiClient.getHistory();
        session.geminiClient.setHistory([...currentHistory, ...tailHistory]);
      }

      this.emitHistorySnapshot(sessionId);

      return { success: true };
    }

    // Fork mode: truncate and create new session
    const newSessionId = await this.createSession(
      session.workingDirectory,
      session.conversationId,
    );
    const newSession = this.getSession(newSessionId);
    newSession.geminiClient.setHistory(baseHistory);
    this.emitHistorySnapshot(newSessionId);
    await this.sendPromptWithParts(newSessionId, promptParts);

    return { success: true, newSessionId };
  }

  /**
   * Get a message in a lossless editable format.
   * If the target message has no text content (e.g., tool-call-only), we search
   * forward for the next model message with actual text content.
   */
  async getMessageForEdit(
    sessionId: string,
    messageIndex: number,
    exactIndex = false,
  ): Promise<GetMessageForEditResult> {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();

    if (messageIndex < 0 || messageIndex >= history.length) {
      throw new Error(`Invalid message index: ${messageIndex}`);
    }

    let targetIndex = messageIndex;
    let message = history[targetIndex];

    // If target message has no text, search forward for next model message with text
    const hasTextContent = (msg: Content): boolean =>
      (msg.parts ?? []).some((p) => typeof p.text === 'string');

    if (!hasTextContent(message) && !exactIndex) {
      debugLogger.log(
        `[getMessageForEdit] Index ${targetIndex} has no text, searching forward...`,
      );
      for (let i = targetIndex + 1; i < history.length; i++) {
        const candidate = history[i];
        if (candidate.role === message.role && hasTextContent(candidate)) {
          debugLogger.log(`[getMessageForEdit] Found text at index ${i}`);
          targetIndex = i;
          message = candidate;
          break;
        }
        // Stop if we hit a different role (user after model, etc.)
        if (candidate.role !== message.role && !isFunctionResponse(candidate)) {
          break;
        }
      }
    }

    const parts = message.parts ?? [];

    const tokenSetId = crypto.randomUUID();
    const tokenMap = new Map<string, Part>();
    session.editTokenSets.set(tokenSetId, tokenMap);
    session.editTokenTargets.set(tokenSetId, targetIndex);

    const partEntries: EditMessagePartOverride[] = [];
    let content = '';
    for (const part of parts) {
      debugLogger.log(
        `[getMessageForEdit] Part keys: ${Object.keys(part).join(', ')} | text type: ${typeof part.text}`,
      );
      if (typeof part.text === 'string') {
        content += part.text;
        continue;
      }

      const tokenId = crypto.randomUUID();
      tokenMap.set(tokenId, part);
      partEntries.push({ tokenId, part });
      content += `${EDIT_TOKEN_PREFIX}${tokenId}${EDIT_TOKEN_SUFFIX}`;
    }

    return {
      content,
      format: EDIT_MESSAGE_FORMAT,
      tokenSetId,
      parts: partEntries,
      resolvedIndex: targetIndex,
    };
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
    this.emitHistorySnapshot(sessionId);
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
    if (saveName.startsWith('aionui-autosave-')) {
      this.logAutosave('autosave_saved', {
        sessionId,
        saveName,
        savePath,
        projectTempDir: session.storage.getProjectTempDir(),
      });
    }
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
      historyIndex?: number;
    }>;
  }> {
    const rawWorkingDirectory = workingDirectory;
    const cwd = path.resolve(rawWorkingDirectory ?? process.cwd());
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
    this.logAutosave('resume_requested', {
      sessionId,
      saveName,
      providedSessionId,
      conversationId,
      rawWorkingDirectory,
      resolvedWorkingDirectory: cwd,
      reusedSession: Boolean(
        providedSessionId && this.sessions.has(providedSessionId),
      ),
    });

    // Load checkpoint
    const checkpoint = await session.logger.loadCheckpoint(saveName);

    if (checkpoint.history.length === 0) {
      throw new Error(`Save not found: ${saveName}`);
    }

    this.logAutosave('resume_loaded', {
      sessionId,
      saveName,
      conversationId: session.conversationId,
      workingDirectory: session.workingDirectory,
      projectTempDir: session.storage.getProjectTempDir(),
      historyLength: checkpoint.history.length,
    });

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

    // Prefer raw history for UI snapshots so tool calls reconstructed from
    // functionCall/functionResponse parts stay visible after resume/edit.
    const historyForSnapshot =
      typeof messageLimit === 'number'
        ? checkpoint.history.slice(
            0,
            Math.min(
              checkpoint.history.length,
              INITIAL_HISTORY_LENGTH + messageLimit,
            ),
          )
        : checkpoint.history;
    const messages = this.buildHistorySnapshotFromContents(historyForSnapshot);

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
  async listSaves(options?: SaveLookupOptions): Promise<ListSavesResult> {
    const storage = this.getStorageForLookup(options);

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

      if (options?.filterAutosavesToConversation) {
        const autosaveTag = options.conversationId
          ? this.getAutosaveTag(options.conversationId)
          : null;
        const autosavePrefix = 'aionui-autosave-';
        const filtered = saves.filter(
          (save) =>
            !save.name.startsWith(autosavePrefix) ||
            (autosaveTag !== null && save.name === autosaveTag),
        );
        return { saves: filtered };
      }

      return { saves };
    } catch {
      return { saves: [] };
    }
  }

  /**
   * Check if a checkpoint with the given name already exists
   */
  async saveExists(
    saveName: string,
    options?: SaveLookupOptions,
  ): Promise<boolean> {
    const storage = this.getStorageForLookup(options);

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

  private findRegenerationPromptIndex(
    history: Content[],
    messageIndex: number,
  ): number | null {
    for (let i = messageIndex - 1; i >= INITIAL_HISTORY_LENGTH; i--) {
      const entry = history[i];
      if (entry.role !== 'user') {
        continue;
      }
      if (isFunctionResponse(entry)) {
        continue;
      }
      return i;
    }
    return null;
  }

  private buildHistoryPlaceholder(
    parts?: Part[],
    toolCalls?: HistorySnapshotToolCall[],
  ): string {
    if (!parts || parts.length === 0) {
      return toolCalls && toolCalls.length > 0 ? '[Tool call]' : '';
    }

    let hasInlineData = false;
    let inlineIsImage = false;
    let hasFileData = false;
    let hasFunctionCall = false;
    let hasExecutableCode = false;
    let hasCodeExecutionResult = false;
    let hasThought = false;

    for (const part of parts) {
      if (part.inlineData) {
        hasInlineData = true;
        const mimeType = part.inlineData.mimeType ?? '';
        if (mimeType.startsWith('image/')) {
          inlineIsImage = true;
        }
      }
      if (part.fileData) {
        hasFileData = true;
      }
      if (part.functionCall) {
        hasFunctionCall = true;
      }
      if ((part as { executableCode?: unknown }).executableCode !== undefined) {
        hasExecutableCode = true;
      }
      if (
        (part as { codeExecutionResult?: unknown }).codeExecutionResult !==
        undefined
      ) {
        hasCodeExecutionResult = true;
      }
      if ((part as { thought?: unknown }).thought !== undefined) {
        hasThought = true;
      }
    }

    const labels: string[] = [];
    if (hasInlineData) {
      labels.push(inlineIsImage ? 'Image' : 'Inline data');
    }
    if (hasFileData) {
      labels.push('File');
    }
    if (hasFunctionCall || (toolCalls && toolCalls.length > 0)) {
      labels.push('Tool call');
    }
    if (hasExecutableCode) {
      labels.push('Executable code');
    }
    if (hasCodeExecutionResult) {
      labels.push('Code execution result');
    }
    if (hasThought) {
      labels.push('Thought');
    }

    if (labels.length === 0) {
      return '';
    }

    return `[${labels.join(', ')}]`;
  }

  private stringifyToolResult(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  /**
   * Reconstruct tool calls from Gemini history for UI display.
   *
   * Gemini stores tool calls as separate messages:
   *   [Model] functionCall: { name, args }
   *   [User]  functionResponse: { name, response }
   *
   * This function combines them into a single HistorySnapshotToolCall with
   * both the input args and the result, keyed by the MODEL message index.
   *
   * Uses simple FIFO name-based matching since Gemini doesn't persist IDs in history.
   */
  private collectToolCallsFromHistory(
    history: Content[],
  ): Map<number, HistorySnapshotToolCall[]> {
    const toolCallsByIndex = new Map<number, HistorySnapshotToolCall[]>();

    // Track pending calls by name (FIFO queue for each name)
    const pendingByName = new Map<
      string,
      Array<{
        index: number;
        toolCall: HistorySnapshotToolCall;
      }>
    >();

    let idCounter = 0;

    for (let index = INITIAL_HISTORY_LENGTH; index < history.length; index++) {
      const entry = history[index];

      for (const part of entry.parts ?? []) {
        // Handle functionCall - create pending tool call at this model message index
        if (part.functionCall) {
          const name = part.functionCall.name ?? 'unknown';
          const args =
            (part.functionCall.args as Record<string, unknown>) ?? {};

          const toolCall: HistorySnapshotToolCall = {
            id: `${name}-${index}-${idCounter++}`,
            name,
            args,
            callHistoryIndex: index,
            status: 'scheduled',
          };

          // Add to result map at this index
          const existing = toolCallsByIndex.get(index) ?? [];
          existing.push(toolCall);
          toolCallsByIndex.set(index, existing);

          // Queue for matching with later functionResponse
          const queue = pendingByName.get(name) ?? [];
          queue.push({ index, toolCall });
          pendingByName.set(name, queue);
        }

        // Handle functionResponse - update the matching pending call
        if (part.functionResponse) {
          const name = part.functionResponse.name ?? 'unknown';
          const responsePayload = (
            part.functionResponse as { response?: unknown }
          ).response;

          // Check for error in response
          const errorValue =
            responsePayload && typeof responsePayload === 'object'
              ? (responsePayload as { error?: unknown }).error
              : undefined;
          const status = errorValue !== undefined ? 'error' : 'success';
          const resultDisplay = this.stringifyToolResult(
            errorValue ?? responsePayload,
          );

          // Find matching pending call (FIFO by name)
          const queue = pendingByName.get(name);
          if (queue && queue.length > 0) {
            const pending = queue.shift()!;
            if (queue.length === 0) pendingByName.delete(name);

            // Update the existing toolCall with result
            pending.toolCall.status = status;
            pending.toolCall.responseHistoryIndex = index;
            if (resultDisplay) pending.toolCall.resultDisplay = resultDisplay;
          }
          // If no matching call found, skip (orphaned response)
        }
      }
    }

    return toolCallsByIndex;
  }

  private parseEditableContent(
    session: SessionState,
    content: string,
    tokenSetId?: string,
    partOverrides?: EditMessagePartOverride[],
  ): Part[] {
    if (!tokenSetId) {
      throw new Error('Missing token set for edit content.');
    }

    const tokenMap = session.editTokenSets.get(tokenSetId);
    if (!tokenMap) {
      throw new Error(
        'Edit token set expired. Reopen the editor and try again.',
      );
    }

    if (partOverrides?.length) {
      for (const override of partOverrides) {
        if (!tokenMap.has(override.tokenId)) {
          throw new Error(`Unknown edit token: ${override.tokenId}`);
        }
        tokenMap.set(override.tokenId, override.part);
      }
    }

    const parts: Part[] = [];
    const tokenPattern = new RegExp(EDIT_TOKEN_PATTERN.source, 'g');
    let cursor = 0;

    for (const match of content.matchAll(tokenPattern)) {
      const matchIndex = match.index ?? 0;
      const textSegment = content.slice(cursor, matchIndex);
      if (textSegment) {
        parts.push({ text: textSegment });
      }

      const tokenId = match[1];
      const tokenPart = tokenMap.get(tokenId);
      if (!tokenPart) {
        throw new Error(`Unknown edit token: ${tokenId}`);
      }
      parts.push(tokenPart);

      cursor = matchIndex + match[0].length;
    }

    const tail = content.slice(cursor);
    if (tail) {
      parts.push({ text: tail });
    }

    session.editTokenSets.delete(tokenSetId);
    session.editTokenTargets.delete(tokenSetId);
    return parts;
  }

  private emitHistorySnapshot(sessionId: string): void {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();
    const messages = this.buildHistorySnapshotFromContents(history);

    this.emitStreamEvent(sessionId, {
      sessionUpdate: 'history_snapshot',
      messages,
    });
  }

  emitHistoryIndexUpdate(sessionId: string): void {
    const session = this.getSession(sessionId);
    const history = session.geminiClient.getHistory();

    let lastUserIndex: number | undefined;
    let lastModelIndex: number | undefined;

    for (let i = history.length - 1; i >= INITIAL_HISTORY_LENGTH; i--) {
      const entry = history[i];
      if (entry.role === 'user' && !isFunctionResponse(entry)) {
        lastUserIndex = i;
        break;
      }
    }

    for (let i = history.length - 1; i >= INITIAL_HISTORY_LENGTH; i--) {
      const entry = history[i];
      if (entry.role === 'model' && !isFunctionCall(entry)) {
        lastModelIndex = i;
        break;
      }
    }

    if (lastUserIndex === undefined && lastModelIndex === undefined) {
      return;
    }

    this.emitStreamEvent(sessionId, {
      sessionUpdate: 'history_index_update',
      lastUserIndex,
      lastModelIndex,
    });
  }

  private buildHistorySnapshotFromContents(history: Content[]): Array<{
    role: 'user' | 'model';
    content: string;
    toolCalls?: HistorySnapshotToolCall[];
    historyIndex?: number;
  }> {
    const toolCallsByHistoryIndex = this.collectToolCallsFromHistory(history);

    const messages: Array<{
      role: 'user' | 'model';
      content: string;
      toolCalls?: HistorySnapshotToolCall[];
      historyIndex?: number;
    }> = [];

    for (let index = INITIAL_HISTORY_LENGTH; index < history.length; index++) {
      const entry = history[index];

      const role = entry.role === 'user' ? 'user' : 'model';
      const text = this.formatHistoryParts(entry.parts).trim();

      // Only attach toolCalls to MODEL messages (where the functionCall originated)
      // User messages contain functionResponse which is already captured in toolCall.resultDisplay
      const toolCalls =
        role === 'model' ? toolCallsByHistoryIndex.get(index) : undefined;
      const hasToolCallsToDisplay = toolCalls && toolCalls.length > 0;

      // Skip user messages that only contain functionResponse (no real user content)
      if (role === 'user' && isFunctionResponse(entry)) {
        continue;
      }

      // If we have toolCalls, we don't need a [Tool call] placeholder - the frontend
      // will render the toolCalls array as a tool_group.
      const content =
        text.length > 0
          ? text
          : hasToolCallsToDisplay
            ? ''
            : this.buildHistoryPlaceholder(entry.parts, undefined);

      if (!content && !hasToolCallsToDisplay) {
        continue;
      }

      messages.push({
        role,
        content,
        toolCalls,
        historyIndex: index,
      });
    }

    return messages;
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

  async autoSaveSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const autosaveTag = this.getAutosaveTag(session.conversationId);
    if (!autosaveTag) {
      this.logAutosave('autosave_skipped', {
        sessionId,
        reason: 'missing_conversation_id',
      });
      return;
    }

    const historyLength = session.geminiClient.getHistory().length;
    if (historyLength <= INITIAL_HISTORY_LENGTH) {
      this.logAutosave('autosave_skipped', {
        sessionId,
        autosaveTag,
        reason: 'no_history',
        historyLength,
      });
      return;
    }

    const lastMessageIndex = historyLength - 1;
    try {
      await this.saveFromPoint(sessionId, lastMessageIndex, autosaveTag);
    } catch (error) {
      debugLogger.warn(
        `[SessionManager] Autosave failed for ${autosaveTag}: ${String(error)}`,
      );
      this.logAutosave('autosave_failed', {
        sessionId,
        autosaveTag,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
