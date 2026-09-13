/**
 * Auto-install utility for optional MCP tool dependencies
 *
 * When an MCP tool requires an optional package that isn't installed,
 * this utility attempts to install it automatically on first use.
 */

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

// Track which packages we've attempted to install this session
const installAttempts = new Set<string>();
const validPackageName = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._~]+)?$/i;

export interface AutoInstallOptions {
  /**
   * Timeout in milliseconds for npm install (default: 60000)
   */
  timeout?: number;

  /**
   * Whether to save to package.json (default: false)
   */
  save?: boolean;

  /**
   * Silent install (no console output)
   */
  silent?: boolean;
}

/**
 * Auto-install a package if not available
 *
 * @param packageName - npm package name to install
 * @param options - Installation options
 * @returns true if installed successfully or already attempted
 */
export async function autoInstallPackage(
  packageName: string,
  options: AutoInstallOptions = {}
): Promise<boolean> {
  const { timeout = 60000, save = false, silent = false } = options;

  // Validate package name to prevent command injection (CVE fix)
  // Valid npm package names: @scope/name or name, alphanumeric with - . _ ~
  if (!validPackageName.test(packageName)) {
    if (!silent) {
      console.error(`[claude-flow] Invalid package name: ${packageName}`);
    }
    return false;
  }

  // Only attempt once per session
  if (installAttempts.has(packageName)) {
    return false;
  }
  installAttempts.add(packageName);

  try {
    if (!silent) {
      console.error(`[claude-flow] Auto-installing ${packageName}...`);
    }

    // Use spawn with array args to prevent shell injection
    const args = ['install', packageName, save ? '--save' : '--no-save'];
    const result = spawnSync('npm', args, {
      stdio: silent ? 'pipe' : ['pipe', 'pipe', 'pipe'],
      timeout,
      shell: false, // Explicitly disable shell
    });

    if (result.status !== 0) {
      throw new Error(result.stderr?.toString() || 'Installation failed');
    }

    if (!silent) {
      console.error(`[claude-flow] Successfully installed ${packageName}`);
    }
    return true;
  } catch (error) {
    if (!silent) {
      console.error(`[claude-flow] Failed to auto-install ${packageName}: ${error}`);
    }
    return false;
  }
}

/**
 * Import an optional package from the MCP process working directory.
 *
 * Bare imports inside an npx-launched Ruflo resolve from npx's isolated cache,
 * not from the user's project. Anchoring createRequire at the project makes an
 * explicit, persistent project-local install discoverable without mutating the
 * disposable npx cache.
 */
export async function importProjectLocalPackage<T = unknown>(packageName: string): Promise<T | null> {
  if (!validPackageName.test(packageName)) {
    return null;
  }

  // MCP clients do not all launch the server with the project as cwd. Prefer
  // explicit project signals used by Claude Code/Ruflo, while retaining cwd
  // (whose Node resolver also walks parent directories) as the final fallback.
  const projectRoots = [...new Set([
    process.env.CLAUDE_PROJECT_DIR,
    process.env.CLAUDE_FLOW_CWD,
    process.env.INIT_CWD,
    process.cwd(),
  ].filter((root): root is string => Boolean(root)))];

  for (const projectRoot of projectRoots) {
    try {
      const projectRequire = createRequire(resolve(projectRoot, 'package.json'));
      const modulePath = projectRequire.resolve(packageName);
      const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}`;
      return await import(moduleUrl) as T;
    } catch {
      // Try the next explicit project signal.
    }
  }
  return null;
}

/**
 * Try to import a package, auto-install if not found, and retry
 *
 * @param packageName - npm package name
 * @param options - Installation options
 * @returns The imported module or null if failed
 */
export async function tryImportOrInstall<T = unknown>(
  packageName: string,
  options: AutoInstallOptions = {}
): Promise<T | null> {
  try {
    // First try to import
    return await import(packageName) as T;
  } catch {
    const projectLocal = await importProjectLocalPackage<T>(packageName);
    if (projectLocal) {
      return projectLocal;
    }

    // Package not found, try to install
    const installed = await autoInstallPackage(packageName, options);
    if (installed) {
      const installedProjectLocal = await importProjectLocalPackage<T>(packageName);
      if (installedProjectLocal) {
        return installedProjectLocal;
      }

      try {
        // ESM caches failed imports, so we need to bust the cache
        // Add a timestamp query parameter to force a fresh import
        const cacheBuster = `?t=${Date.now()}`;
        return await import(`${packageName}${cacheBuster}`) as T;
      } catch {
        console.error(`[claude-flow] ${packageName} installed but failed to load. Restart MCP server.`);
        return null;
      }
    }
    return null;
  }
}

/**
 * Check if a package is available without installing
 */
export async function isPackageAvailable(packageName: string): Promise<boolean> {
  try {
    await import(packageName);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset install attempts (useful for testing)
 */
export function resetInstallAttempts(): void {
  installAttempts.clear();
}

/**
 * Optional package dependencies and their purposes
 */
export const OPTIONAL_PACKAGES = {
  '@claude-flow/aidefence': {
    description: 'AI manipulation defense (prompt injection, PII detection)',
    tools: ['aidefence_scan', 'aidefence_analyze', 'aidefence_stats', 'aidefence_learn'],
  },
  '@claude-flow/embeddings': {
    description: 'Vector embeddings with ONNX support',
    tools: ['embeddings_generate', 'embeddings_search', 'embeddings_batch'],
  },
  'onnxruntime-node': {
    description: 'ONNX runtime for neural network inference',
    tools: ['neural_*'],
  },
} as const;

export default {
  autoInstallPackage,
  importProjectLocalPackage,
  tryImportOrInstall,
  isPackageAvailable,
  resetInstallAttempts,
  OPTIONAL_PACKAGES,
};
