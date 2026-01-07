/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lintStaged from 'lint-staged';

const execFileAsync = promisify(execFile);

try {
  // Get repository root
  const { stdout } = await execFileAsync('git', [
    'rev-parse',
    '--show-toplevel',
  ]);
  const root = stdout.trim();

  // Run lint-staged with API directly
  const passed = await lintStaged({ cwd: root });

  // Exit with appropriate code
  process.exit(passed ? 0 : 1);
} catch {
  // Exit with error code
  process.exit(1);
}
