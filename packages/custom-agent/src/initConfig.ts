/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Config Initialization for Custom Agent
 *
 * Creates and initializes the gemini-cli-core Config object required for
 * GeminiChat to make real LLM calls. Based on the pattern from a2a-server.
 */

import {
  AuthType,
  Config,
  type ConfigParameters,
  FileDiscoveryService,
  ApprovalMode,
  loadServerHierarchicalMemory,
  DEFAULT_GEMINI_MODEL,
  SimpleExtensionLoader,
  debugLogger,
} from '@google/gemini-cli-core';

/**
 * Initialize a Config object for the custom agent
 *
 * @param sessionId - Unique session identifier
 * @param workingDirectory - Directory to operate in
 * @returns Initialized Config object
 */
export async function initConfig(
  sessionId: string,
  workingDirectory: string,
): Promise<Config> {
  debugLogger.log(`[initConfig] Initializing config for session ${sessionId}`);

  const toolsEnabled = process.env['CUSTOM_AGENT_ENABLE_TOOLS'] !== 'false';

  const configParams: ConfigParameters = {
    sessionId,
    model: DEFAULT_GEMINI_MODEL,
    targetDir: workingDirectory,
    debugMode: process.env['DEBUG'] === 'true',
    cwd: workingDirectory,
    approvalMode:
      process.env['GEMINI_YOLO_MODE'] === 'true'
        ? ApprovalMode.YOLO
        : ApprovalMode.DEFAULT,
    fileFiltering: {
      respectGitIgnore: true,
      enableRecursiveFileSearch: true,
    },
    interactive: toolsEnabled, // Enable confirmations when tools are active
    checkpointing: true, // Enable checkpointing for save/resume
  };

  if (!toolsEnabled) {
    // Avoid tool-call-only responses in non-interactive ACP mode.
    configParams.coreTools = [];
    configParams.enabledExtensions = [];
  }

  // Load memory files (GEMINI.md etc)
  const extensionLoader = new SimpleExtensionLoader([]);
  const fileService = new FileDiscoveryService(workingDirectory);

  try {
    const { memoryContent, fileCount } = await loadServerHierarchicalMemory(
      workingDirectory,
      [workingDirectory],
      false,
      fileService,
      extensionLoader,
      false, // folderTrust
    );
    configParams.userMemory = memoryContent;
    configParams.geminiMdFileCount = fileCount;
    configParams.extensionLoader = extensionLoader;
  } catch (error) {
    debugLogger.warn(`[initConfig] Failed to load memory: ${error}`);
    configParams.userMemory = '';
    configParams.geminiMdFileCount = 0;
    configParams.extensionLoader = extensionLoader;
  }

  // Create Config
  const config = new Config(configParams);

  // Initialize tools and services
  await config.initialize();

  // Set up authentication
  // Priority: API key > OAuth
  if (process.env['GEMINI_API_KEY']) {
    debugLogger.log('[initConfig] Using Gemini API Key');
    await config.refreshAuth(AuthType.USE_GEMINI);
  } else {
    debugLogger.log('[initConfig] Using OAuth');
    await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
  }

  debugLogger.log('[initConfig] Config initialized successfully');
  return config;
}
