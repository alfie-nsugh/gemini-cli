/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extension Command Loader
 *
 * Dynamically loads slash commands from extension .toml files.
 * Supports any extension, not just conductor.
 *
 * Command discovery:
 * 1. Scans ~/.gemini/extensions/{ext}/commands/{path}.toml
 * 2. Derives command names from file paths (e.g., conductor/status.toml → conductor:status)
 * 3. Parses TOML files for prompt and description
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import toml from '@iarna/toml';
import { glob } from 'glob';
import { z } from 'zod';
import { debugLogger, Storage } from '@google/gemini-cli-core';

/**
 * Schema for a command definition file
 */
const TomlCommandDefSchema = z.object({
  prompt: z.string({
    required_error: "The 'prompt' field is required.",
    invalid_type_error: "The 'prompt' field must be a string.",
  }),
  description: z.string().optional(),
});

/**
 * Represents a loaded extension command
 */
export interface ExtensionCommand {
  /** Full command name (e.g., "conductor:status") */
  name: string;
  /** Human-readable description */
  description: string;
  /** The extension this command belongs to */
  extensionName: string;
  /** Path to the source .toml file */
  filePath: string;
  /** The prompt template to send to the LLM */
  prompt: string;
}

/**
 * Cache for loaded extension commands
 */
let commandCache: ExtensionCommand[] | null = null;
let cacheLoadTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Get the extensions directory
 */
function getExtensionsDir(): string {
  return path.join(os.homedir(), '.gemini', 'extensions');
}

/**
 * Load all extension commands from ~/.gemini/extensions
 */
export async function loadExtensionCommands(): Promise<ExtensionCommand[]> {
  // Return cached if still valid
  const now = Date.now();
  if (commandCache && now - cacheLoadTime < CACHE_TTL_MS) {
    return commandCache;
  }

  const extensionsDir = getExtensionsDir();
  const commands: ExtensionCommand[] = [];

  try {
    // Check if extensions directory exists
    await fs.access(extensionsDir);
  } catch {
    debugLogger.log('[ExtensionLoader] No extensions directory found');
    commandCache = [];
    cacheLoadTime = now;
    return [];
  }

  try {
    // List all extension directories
    const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
    const extensionDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);

    debugLogger.log(
      `[ExtensionLoader] Found extensions: ${extensionDirs.join(', ')}`,
    );

    // Load commands from each extension
    for (const extensionName of extensionDirs) {
      const commandsDir = path.join(extensionsDir, extensionName, 'commands');

      try {
        await fs.access(commandsDir);
      } catch {
        // Extension has no commands directory
        continue;
      }

      // Find all .toml files
      const tomlFiles = await glob('**/*.toml', {
        cwd: commandsDir,
        nodir: true,
        dot: true,
      });

      for (const tomlFile of tomlFiles) {
        const filePath = path.join(commandsDir, tomlFile);
        const command = await parseCommandFile(
          filePath,
          commandsDir,
          extensionName,
        );
        if (command) {
          commands.push(command);
        }
      }
    }

    debugLogger.log(
      `[ExtensionLoader] Loaded ${commands.length} extension commands`,
    );

    commandCache = commands;
    cacheLoadTime = now;
    return commands;
  } catch (error) {
    debugLogger.error(`[ExtensionLoader] Error loading extensions: ${error}`);
    commandCache = [];
    cacheLoadTime = now;
    return [];
  }
}

/**
 * Parse a single .toml command file
 */
async function parseCommandFile(
  filePath: string,
  baseDir: string,
  extensionName: string,
): Promise<ExtensionCommand | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = toml.parse(content);
    const validation = TomlCommandDefSchema.safeParse(parsed);

    if (!validation.success) {
      debugLogger.warn(
        `[ExtensionLoader] Invalid command file ${filePath}: ${validation.error.message}`,
      );
      return null;
    }

    const def = validation.data;

    // Derive command name from file path
    // e.g., conductor/status.toml -> conductor:status
    const relativePath = path.relative(baseDir, filePath);
    const withoutExt = relativePath.slice(0, -5); // Remove .toml
    const commandName = withoutExt
      .split(path.sep)
      .map((seg) => seg.replaceAll(':', '_'))
      .join(':');

    const description = def.description
      ? `[${extensionName}] ${def.description}`
      : `[${extensionName}] Custom command`;

    return {
      name: commandName,
      description,
      extensionName,
      filePath,
      prompt: def.prompt,
    };
  } catch (error) {
    debugLogger.warn(`[ExtensionLoader] Failed to parse ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Get a specific extension command by name
 */
export async function getExtensionCommand(
  commandName: string,
): Promise<ExtensionCommand | null> {
  const commands = await loadExtensionCommands();
  return commands.find((c) => c.name === commandName) ?? null;
}

/**
 * Get all available extension command names
 */
export async function getExtensionCommandNames(): Promise<string[]> {
  const commands = await loadExtensionCommands();
  return commands.map((c) => c.name);
}

/**
 * Clear the command cache (useful for reloading)
 */
export function clearCommandCache(): void {
  commandCache = null;
  cacheLoadTime = 0;
}

/**
 * Load user-level commands from ~/.gemini/commands
 */
export async function loadUserCommands(): Promise<ExtensionCommand[]> {
  const userCommandsDir = Storage.getUserCommandsDir();
  const commands: ExtensionCommand[] = [];

  try {
    await fs.access(userCommandsDir);
  } catch {
    return [];
  }

  try {
    const tomlFiles = await glob('**/*.toml', {
      cwd: userCommandsDir,
      nodir: true,
      dot: true,
    });

    for (const tomlFile of tomlFiles) {
      const filePath = path.join(userCommandsDir, tomlFile);
      const command = await parseCommandFile(filePath, userCommandsDir, 'user');
      if (command) {
        // User commands don't have extension prefix
        const relativePath = path.relative(userCommandsDir, filePath);
        const withoutExt = relativePath.slice(0, -5);
        command.name = withoutExt
          .split(path.sep)
          .map((seg) => seg.replaceAll(':', '_'))
          .join(':');
        command.extensionName = '';
        command.description = command.description.replace('[user] ', '');
        commands.push(command);
      }
    }

    return commands;
  } catch (error) {
    debugLogger.warn(`[ExtensionLoader] Error loading user commands: ${error}`);
    return [];
  }
}

/**
 * Load all commands (user + extension)
 */
export async function loadAllCommands(): Promise<ExtensionCommand[]> {
  const [userCommands, extensionCommands] = await Promise.all([
    loadUserCommands(),
    loadExtensionCommands(),
  ]);
  return [...userCommands, ...extensionCommands];
}
