/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Slash Command Processor
 *
 * Parses and routes slash commands like /chat save, /chat resume, /copy, etc.
 * Uses FileCommandLoader from CLI for extension commands (conductor, etc.)
 */

import type { SessionManager } from './sessionManager.js';
import { debugLogger, type Config } from '@google/gemini-cli-core';
import {
  FileCommandLoader,
  type SlashCommand,
  type CommandContext,
} from '@google/gemini-cli/services';

/**
 * Result of a slash command execution
 */
export interface SlashCommandResult {
  /** Whether the input was recognized as a slash command */
  handled: boolean;
  /** Response message to display to the user */
  message?: string;
  /** Type of response for UI styling */
  type?: 'info' | 'error' | 'success' | 'confirm';
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
  /** Raw input */
  raw: string;
}

/**
 * Cache for loaded file commands
 */
let fileCommandCache: SlashCommand[] | null = null;
let cacheConfig: Config | null = null;

/**
 * Load file commands using FileCommandLoader from CLI
 */
async function loadFileCommands(
  config: Config | null,
): Promise<SlashCommand[]> {
  // Return cached if same config
  if (fileCommandCache && cacheConfig === config) {
    return fileCommandCache;
  }

  const loader = new FileCommandLoader(config);
  const controller = new AbortController();

  try {
    fileCommandCache = await loader.loadCommands(controller.signal);
    cacheConfig = config;
    debugLogger.log(
      `[SlashCommand] Loaded ${fileCommandCache.length} file commands`,
    );
    return fileCommandCache;
  } catch (error) {
    debugLogger.warn(`[SlashCommand] Failed to load file commands: ${error}`);
    return [];
  }
}

/**
 * Clear the command cache (call when config changes)
 */
export function clearCommandCache(): void {
  fileCommandCache = null;
  cacheConfig = null;
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
      raw: trimmed,
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
    raw: trimmed,
  };
}

/**
 * Process a slash command
 */
export async function processSlashCommand(
  input: string,
  sessionId: string,
  sessionManager: SessionManager,
  config?: Config | null,
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
      return processHelpCommand(config ?? null);

    case 'auth':
      return processAuthCommand(parsed.subcommand, sessionManager);

    default:
      // Fall through to file command check below
      break;
  }

  // Check for file-based commands (extensions, user commands)
  const commandName = parsed.subcommand
    ? `${parsed.command}:${parsed.subcommand}`
    : parsed.command;

  const fileCommands = await loadFileCommands(config ?? null);
  const fileCommand = fileCommands.find((c) => c.name === commandName);

  if (fileCommand && fileCommand.action) {
    return processFileCommand(fileCommand, parsed);
  }

  return {
    handled: true,
    type: 'error',
    message: `Unknown command: /${parsed.command}. Type /help for available commands.`,
  };
}

/**
 * Process a file-based command (extension command)
 */
async function processFileCommand(
  command: SlashCommand,
  parsed: ParsedCommand,
): Promise<SlashCommandResult> {
  // Create minimal CommandContext for the action
  const minimalContext: CommandContext = {
    invocation: {
      raw: parsed.raw,
      name: command.name,
      args: parsed.args,
    },
    // These are required but not used for simple file commands
    services: {
      config: null,
      settings: {} as never,
      git: undefined,
      logger: {} as never,
    },
    ui: {} as never,
    session: {
      stats: {} as never,
      sessionShellAllowlist: new Set(),
    },
  };

  try {
    const result = await command.action!(minimalContext, parsed.args);

    // Handle submit_prompt result (most common for file commands)
    if (result && typeof result === 'object' && 'type' in result) {
      if (result.type === 'submit_prompt' && 'content' in result) {
        // Extract text from content array
        const content = result.content as Array<{ text?: string }>;
        const prompt = content
          .filter((p) => p.text)
          .map((p) => p.text)
          .join('\n');

        return {
          handled: true,
          type: 'info',
          message: `Running /${command.name}...`,
          promptToSend: prompt,
        };
      }

      if (result.type === 'confirm_shell_commands') {
        // Shell confirmation required - not fully supported yet
        return {
          handled: true,
          type: 'error',
          message: `Command /${command.name} requires shell confirmation, which is not yet supported.`,
        };
      }
    }

    return {
      handled: true,
      type: 'info',
      message: `Executed /${command.name}`,
    };
  } catch (error) {
    return {
      handled: true,
      type: 'error',
      message: `Failed to execute /${command.name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Process /auth command
 * Handles authentication status and login flow
 */
async function processAuthCommand(
  subcommand: string | undefined,
  _sessionManager: SessionManager,
): Promise<SlashCommandResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const credentialsPath = path.join(
    os.homedir(),
    '.gemini',
    'oauth_creds.json',
  );
  const apiKeySet = !!process.env['GEMINI_API_KEY'];

  // Check current auth status
  let hasOAuthCreds = false;
  try {
    await fs.access(credentialsPath);
    hasOAuthCreds = true;
  } catch {
    hasOAuthCreds = false;
  }

  switch (subcommand) {
    case 'status':
    case undefined: {
      // Show auth status
      const statusParts: string[] = [];

      if (apiKeySet) {
        statusParts.push('✅ GEMINI_API_KEY is set');
      } else {
        statusParts.push('❌ GEMINI_API_KEY is not set');
      }

      if (hasOAuthCreds) {
        statusParts.push(
          '✅ OAuth credentials found at ~/.gemini/oauth_creds.json',
        );
      } else {
        statusParts.push('❌ No OAuth credentials found');
      }

      if (!apiKeySet && !hasOAuthCreds) {
        statusParts.push('');
        statusParts.push('To authenticate, either:');
        statusParts.push(
          '1. Set GEMINI_API_KEY in your .env file or environment',
        );
        statusParts.push('2. Run `/auth login` to authenticate via OAuth');
      }

      return {
        handled: true,
        type: apiKeySet || hasOAuthCreds ? 'success' : 'info',
        message: statusParts.join('\n'),
      };
    }

    case 'login': {
      // The OAuth flow needs to be handled by the CLI
      // Return a special result that tells the frontend to open the auth URL
      const authUrl = 'https://aistudio.google.com/apikey';

      return {
        handled: true,
        type: 'info',
        message: `To authenticate with Gemini:\n\n1. Get an API key from: ${authUrl}\n2. Add it to your AionUi/.env file:\n   GEMINI_API_KEY=your_key_here\n3. Restart the backend\n\nAlternatively, run 'gemini auth login' in your terminal.`,
        data: {
          action: 'open_url',
          url: authUrl,
        },
      };
    }

    case 'logout': {
      // Remove credentials
      if (hasOAuthCreds) {
        try {
          await fs.unlink(credentialsPath);
          return {
            handled: true,
            type: 'success',
            message:
              'OAuth credentials removed. Note: GEMINI_API_KEY environment variable is still set if configured.',
          };
        } catch (error) {
          return {
            handled: true,
            type: 'error',
            message: `Failed to remove credentials: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      } else {
        return {
          handled: true,
          type: 'info',
          message: 'No OAuth credentials to remove.',
        };
      }
    }

    default:
      return {
        handled: true,
        type: 'error',
        message: 'Usage: /auth [status|login|logout]',
      };
  }
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
      // Parse args - support --force or -f flag to skip confirmation
      const parts = args.trim().split(/\s+/);
      const forceFlag = parts.some((p) => p === '--force' || p === '-f');
      const saveName = parts
        .filter((p) => p !== '--force' && p !== '-f')
        .join(' ')
        .trim();

      if (!saveName) {
        return {
          handled: true,
          type: 'error',
          message: 'Usage: /chat save <name> [--force]',
        };
      }

      try {
        // Check if save already exists (unless force flag is set)
        if (!forceFlag) {
          const exists = await sessionManager.saveExists(saveName);
          if (exists) {
            return {
              handled: true,
              type: 'confirm',
              message: `A checkpoint named "${saveName}" already exists. Overwrite?`,
              data: {
                confirmAction: 'save_overwrite',
                saveName,
              },
            };
          }
        }

        const historyLength = sessionManager.getHistoryLength(sessionId);
        const lastMessageIndex = historyLength > 0 ? historyLength - 1 : 0;
        const result = await sessionManager.saveFromPoint(
          sessionId,
          lastMessageIndex,
          saveName,
        );

        return {
          handled: true,
          type: 'success',
          message: `Checkpoint saved: ${saveName}`,
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
        const workingDirectory = sessionManager.getWorkingDirectory(sessionId);
        const result = await sessionManager.resumeSession(
          args.trim(),
          workingDirectory,
        );
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
async function processHelpCommand(
  config: Config | null,
): Promise<SlashCommandResult> {
  // Load file commands dynamically
  const fileCommands = await loadFileCommands(config);

  const builtInHelp = `
Available commands:
  /chat save <name>    - Save the current conversation
  /chat resume <name>  - Resume a saved conversation
  /chat list           - List saved checkpoints
  /chat delete <name>  - Delete a saved checkpoint
  /copy                - Copy last response to clipboard
  /help                - Show this help message
`.trim();

  // Group file commands by extension name
  const extensionsByName = new Map<string, SlashCommand[]>();
  for (const cmd of fileCommands) {
    if (cmd.hidden) continue;
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
export async function getAvailableCommands(
  config: Config | null,
): Promise<SlashCommand[]> {
  const builtIn: SlashCommand[] = [
    {
      name: 'chat save',
      description: 'Save the current conversation',
      kind: 0 as never,
    },
    {
      name: 'chat resume',
      description: 'Resume a saved conversation',
      kind: 0 as never,
    },
    {
      name: 'chat list',
      description: 'List saved checkpoints',
      kind: 0 as never,
    },
    {
      name: 'chat delete',
      description: 'Delete a saved checkpoint',
      kind: 0 as never,
    },
    {
      name: 'copy',
      description: 'Copy last response to clipboard',
      kind: 0 as never,
    },
    { name: 'help', description: 'Show available commands', kind: 0 as never },
  ];

  const fileCommands = await loadFileCommands(config);
  return [...builtIn, ...fileCommands];
}

/**
 * Completion item for autocomplete
 */
export interface CompletionItem {
  /** Text to insert (e.g., "/chat save" or "my-checkpoint") */
  text: string;
  /** Display name in the dropdown */
  displayName: string;
  /** Description for the item */
  description: string;
  /** Category (command, argument, extension) */
  category: string;
  /** Whether this is an argument completion (vs command completion) */
  isArgument?: boolean;
}

/**
 * Get completions for the given input
 * Supports both command name completion and argument completion
 */
export async function getCompletions(
  input: string,
  sessionManager: SessionManager,
  config: Config | null,
): Promise<CompletionItem[]> {
  const trimmed = input.trim();

  // Must start with /
  if (!trimmed.startsWith('/')) {
    return [];
  }

  // Check if we're completing arguments (command is complete, now typing args)
  const argCompletions = await getArgumentCompletions(
    trimmed,
    sessionManager,
    config,
  );
  if (argCompletions.length > 0) {
    return argCompletions;
  }

  // Otherwise, return command name completions
  const commands = await getAvailableCommands(config);
  const lowerInput = trimmed.toLowerCase();

  return commands
    .filter((cmd) => `/${cmd.name}`.toLowerCase().startsWith(lowerInput))
    .map((cmd) => ({
      text: `/${cmd.name}`,
      displayName: `/${cmd.name}`,
      description: cmd.description,
      category: cmd.extensionName || 'built-in',
      isArgument: false,
    }));
}

/**
 * Get argument completions for commands that support them
 */
async function getArgumentCompletions(
  input: string,
  sessionManager: SessionManager,
  _config: Config | null,
): Promise<CompletionItem[]> {
  // Check for /chat resume completion
  const chatResumeMatch = input.match(/^\/chat\s+resume\s+(.*)/i);
  if (chatResumeMatch) {
    const argPrefix = chatResumeMatch[1].toLowerCase();
    try {
      const { saves } = await sessionManager.listSaves();
      return saves
        .filter((s) => s.name.toLowerCase().startsWith(argPrefix))
        .map((s) => ({
          text: `/chat resume ${s.name}`,
          displayName: s.name,
          description: `${s.messageCount} messages`,
          category: 'save',
          isArgument: true,
        }));
    } catch {
      return [];
    }
  }

  // Check for /chat delete completion (same as resume)
  const chatDeleteMatch = input.match(/^\/chat\s+delete\s+(.*)/i);
  if (chatDeleteMatch) {
    const argPrefix = chatDeleteMatch[1].toLowerCase();
    try {
      const { saves } = await sessionManager.listSaves();
      return saves
        .filter((s) => s.name.toLowerCase().startsWith(argPrefix))
        .map((s) => ({
          text: `/chat delete ${s.name}`,
          displayName: s.name,
          description: `${s.messageCount} messages`,
          category: 'save',
          isArgument: true,
        }));
    } catch {
      return [];
    }
  }

  // No argument completion for this command
  return [];
}
