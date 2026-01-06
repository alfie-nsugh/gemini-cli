/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exports for use by other packages (e.g., custom-agent)
 *
 * This module exposes select services and types from the CLI package
 * for reuse without duplicating code.
 */

// Services
export { FileCommandLoader } from './services/FileCommandLoader.js';
export { CommandService } from './services/CommandService.js';
export type { ICommandLoader } from './services/types.js';

// Command types
export type {
  SlashCommand,
  CommandContext,
  SlashCommandActionReturn,
} from './ui/commands/types.js';
export { CommandKind } from './ui/commands/types.js';
