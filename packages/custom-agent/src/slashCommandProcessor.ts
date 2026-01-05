/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Slash Command Processor
 *
 * Parses and routes slash commands like /chat save, /chat resume, /copy, etc.
 * Also dynamically loads and routes extension commands (e.g., /conductor:status).
 */

import type { SessionManager } from './sessionManager.js';
import { debugLogger } from '@google/gemini-cli-core';
import {
  getExtensionCommand,
  loadAllCommands,
  type ExtensionCommand,
} from './extensionCommandLoader.js';

/**
 * Result of a slash command execution
 */
export interface SlashCommandResult {
  /** Whether the input was recognized as a slash command */
  handled: boolean;
  /** Response message to display to the user */
  message?: string;
  /** Type of response for UI styling */
  type?: 'info' | 'error' | 'success';
  /** For list commands, structured data */
  data?: unknown;
  /** For extension commands, the prompt to send to the LLM */
  promptToSend?: string;
}

/**
 * Parsed slash command
 */
interface ParsedCommand {
  /** Main command (e.g., 'chat', 'copy') */
  command: string;
  /** Subcommand if any (e.g., 'save', 'resume') */
  subcommand?: string;
  /** Arguments after the command */
  args: string;
}

/**
 * Parse a potential slash command from input
 */
export function parseSlashCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Match /command or /command:subcommand or /command subcommand args
  const match = trimmed.match(/^\/(\w+)(?::(\w+))?\s*(.*)/);
  if (!match) {
    return null;
  }

  const [, command, colonSubcommand, rest] = match;

  // Handle /command:subcommand format (e.g., /conductor:status)
  if (colonSubcommand) {
    return {
      command,
      subcommand: colonSubcommand,
      args: rest,
    };
  }

  // Handle /command subcommand args format (e.g., /chat save myname)
  const parts = rest.split(/\s+/);
  const subcommand = parts[0] || undefined;
  const args = parts.slice(1).join(' ');

  return {
    command,
    subcommand,
    args,
  };
}

/**
 * Process a slash command
 */
export async function processSlashCommand(
  input: string,
  sessionId: string,
  sessionManager: SessionManager,
): Promise<SlashCommandResult> {
  const parsed = parseSlashCommand(input);

  if (!parsed) {
    return { handled: false };
  }

  debugLogger.log(
    `[SlashCommand] Processing: ${parsed.command}${parsed.subcommand ? ':' + parsed.subcommand : ''} ${parsed.args}`,
  );

  // Handle built-in commands first
  switch (parsed.command) {
    case 'chat':
      return processChatCommand(
        parsed.subcommand,
        parsed.args,
        sessionId,
        sessionManager,
      );

    case 'copy':
      return processCopyCommand(sessionId, sessionManager);

    case 'help':
      return processHelpCommand();

    default:
      // Fall through to extension command check below
      break;
  }

  // Check for extension commands (e.g., /conductor:status → "conductor:status")
  const extensionCommandName = parsed.subcommand
    ? `${parsed.command}:${parsed.subcommand}`
    : parsed.command;

  const extensionCommand = await getExtensionCommand(extensionCommandName);

  if (extensionCommand) {
    return processExtensionCommand(extensionCommand, parsed.args);
  }

  return {
    handled: true,
    type: 'error',
    message: `Unknown command: /${parsed.command}. Type /help for available commands.`,
  };
}

/**
 * Process an extension command
 */
async function processExtensionCommand(
  command: ExtensionCommand,
  args: string,
): Promise<SlashCommandResult> {
  // Replace {{args}} placeholder if present
  let prompt = command.prompt;
  if (prompt.includes('{{args}}')) {
    prompt = prompt.replace(/\{\{args\}\}/g, args);
  } else if (args) {
    // Append args if no placeholder
    prompt = `${prompt}\n\nUser input: ${args}`;
  }

  return {
    handled: true,
    type: 'info',
    message: `Running ${command.name}...`,
    promptToSend: prompt,
  };
}

/**
 * Process /chat subcommands
 */
async function processChatCommand(
  subcommand: string | undefined,
  args: string,
  sessionId: string,
  sessionManager: SessionManager,
): Promise<SlashCommandResult> {
  switch (subcommand) {
    case 'save': {
      if (!args.trim()) {
        return {
          handled: true,
          type: 'error',
          message: 'Usage: /chat save <name>',
        };
      }

      try {
        const historyLength = sessionManager.getHistoryLength(sessionId);
        const lastMessageIndex = historyLength > 0 ? historyLength - 1 : 0;
        const result = await sessionManager.saveFromPoint(
          sessionId,
          lastMessageIndex,
          args.trim(),
        );

        return {
          handled: true,
          type: 'success',
          message: `Checkpoint saved: ${args.trim()}`,
          data: result,
        };
      } catch (error) {
        return {
          handled: true,
          type: 'error',
          message: `Failed to save: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case 'resume':
    case 'load': {
      if (!args.trim()) {
        return {
          handled: true,
          type: 'error',
          message: 'Usage: /chat resume <name>',
        };
      }

      try {
        const result = await sessionManager.resumeSession(args.trim());
        return {
          handled: true,
          type: 'success',
          message: `Resumed checkpoint: ${args.trim()} (${result.messages.length} messages)`,
          data: result,
        };
      } catch (error) {
        return {
          handled: true,
          type: 'error',
          message: `Failed to resume: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case 'list': {
      try {
        const result = await sessionManager.listSaves();
        if (result.saves.length === 0) {
          return {
            handled: true,
            type: 'info',
            message: 'No saved checkpoints found.',
          };
        }

        const listText = result.saves
          .map((s) => `  - ${s.name} (${s.messageCount} messages)`)
          .join('\n');

        return {
          handled: true,
          type: 'info',
          message: `Saved checkpoints:\n${listText}`,
          data: result,
        };
      } catch (error) {
        return {
          handled: true,
          type: 'error',
          message: `Failed to list: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    case 'delete': {
      if (!args.trim()) {
        return {
          handled: true,
          type: 'error',
          message: 'Usage: /chat delete <name>',
        };
      }

      return {
        handled: true,
        type: 'error',
        message: 'Delete not yet implemented.',
      };
    }

    default:
      return {
        handled: true,
        type: 'error',
        message: 'Usage: /chat <save|resume|list|delete> [name]',
      };
  }
}

/**
 * Process /copy command - copies last AI response to clipboard
 */
async function processCopyCommand(
  sessionId: string,
  sessionManager: SessionManager,
): Promise<SlashCommandResult> {
  try {
    const history = sessionManager.getHistory(sessionId);

    // Find last model message
    const lastModelMessage = history
      .filter((item) => item.role === 'model')
      .pop();

    if (!lastModelMessage) {
      return {
        handled: true,
        type: 'info',
        message: 'No output in history to copy.',
      };
    }

    // Extract text from parts
    const textContent = lastModelMessage.parts
      ?.filter((part) => part.text)
      .map((part) => part.text)
      .join('');

    if (!textContent) {
      return {
        handled: true,
        type: 'info',
        message: 'Last AI output contains no text to copy.',
      };
    }

    // Try to copy to clipboard
    try {
      const clipboardy = await import('clipboardy');
      await clipboardy.default.write(textContent);
      return {
        handled: true,
        type: 'success',
        message: 'Last output copied to the clipboard.',
      };
    } catch (clipError) {
      // Fallback - just show the content length
      debugLogger.warn(`Clipboard not available: ${clipError}`);
      return {
        handled: true,
        type: 'info',
        message: `Ready to copy ${textContent.length} characters. (Clipboard not available in this environment)`,
      };
    }
  } catch (error) {
    return {
      handled: true,
      type: 'error',
      message: `Failed to copy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Process /help command
 */
async function processHelpCommand(): Promise<SlashCommandResult> {
  // Load available extension commands dynamically
  const extensionCommands = await loadAllCommands();

  const builtInHelp = `
Available commands:
  /chat save <name>    - Save the current conversation
  /chat resume <name>  - Resume a saved conversation
  /chat list           - List saved checkpoints
  /chat delete <name>  - Delete a saved checkpoint
  /copy                - Copy last response to clipboard
  /help                - Show this help message
`.trim();

  // Group extension commands by extension name
  const extensionsByName = new Map<string, ExtensionCommand[]>();
  for (const cmd of extensionCommands) {
    const ext = cmd.extensionName || 'user';
    if (!extensionsByName.has(ext)) {
      extensionsByName.set(ext, []);
    }
    extensionsByName.get(ext)!.push(cmd);
  }

  let extensionHelp = '';
  if (extensionsByName.size > 0) {
    extensionHelp = '\n\nExtension commands:';
    for (const [extName, commands] of extensionsByName) {
      if (extName && extName !== 'user') {
        extensionHelp += `\n  [${extName}]`;
        for (const cmd of commands) {
          const desc = cmd.description.replace(`[${extName}] `, '');
          extensionHelp += `\n    /${cmd.name} - ${desc}`;
        }
      }
    }
  }

  // User commands
  const userCommands = extensionsByName.get('user') || [];
  let userHelp = '';
  if (userCommands.length > 0) {
    userHelp = '\n\nUser commands:';
    for (const cmd of userCommands) {
      userHelp += `\n  /${cmd.name} - ${cmd.description}`;
    }
  }

  return {
    handled: true,
    type: 'info',
    message: builtInHelp + extensionHelp + userHelp,
  };
}

/**
 * Get available slash commands for autocomplete
 */
export async function getAvailableCommands(): Promise<string[]> {
  const builtIn = [
    '/chat save',
    '/chat resume',
    '/chat list',
    '/chat delete',
    '/copy',
    '/help',
  ];

  const extensionCommands = await loadAllCommands();
  const extensionNames = extensionCommands.map((c) => `/${c.name}`);

  return [...builtIn, ...extensionNames];
}
