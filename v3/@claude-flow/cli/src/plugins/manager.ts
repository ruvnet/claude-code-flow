/**
 * Plugin Manager
 * Handles actual plugin installation, persistence, and lifecycle
 * Bridges discovery service with file system persistence
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// On Windows, `npm` is a shell script (no `.exe`) and `npm.cmd` is a batch
// wrapper. Since Node 18.20.2 / 20.12.2 (CVE-2024-27980) the runtime refuses
// to spawn `.cmd`/`.bat` files directly and throws `spawn EINVAL` — the only
// supported invocation is via a real `.exe` shell. We wrap every npm call
// through `cmd.exe /d /s /c npm <args>`, which keeps Node's safe array-form
// argument escaping intact and avoids both ENOENT and EINVAL.
const isWindows = process.platform === 'win32';

function runNpm(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  if (isWindows) {
    return execFileAsync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { timeout: timeoutMs });
  }
  return execFileAsync('npm', args, { timeout: timeoutMs });
}

/**
 * Validate npm package name to prevent shell injection (S-3)
 */
const VALID_PACKAGE_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9._\-^~>=<]+)?$/;
function validatePackageName(spec: string): void {
  if (!VALID_PACKAGE_RE.test(spec)) {
    throw new Error(`Invalid package name: ${spec}`);
  }
}

// ============================================================================
// Types
// ============================================================================

export interface InstalledPlugin {
  name: string;
  version: string;
  installedAt: string;
  enabled: boolean;
  source: 'npm' | 'local' | 'ipfs';
  path?: string;
  commands?: string[];
  hooks?: string[];
  config?: Record<string, unknown>;
}

// ============================================================================
// Built-in plugin registry
// ============================================================================

/**
 * Descriptor for a plugin shipped in-tree under `plugins/<name>/`. Mirrors the
 * shape of the `plugins` array in `.claude-plugin/marketplace.json`, with the
 * IPFS `cid` pinned so installs without network access can still resolve.
 *
 * TODO(publish): the canonical built-in list lives at
 * `.claude-plugin/marketplace.json`. Today this constant is hand-maintained;
 * once ADR-XXX wires marketplace discovery into the plugin store, drop this
 * mirror and read from there.
 */
export interface BuiltInPluginDescriptor {
  name: string;
  source: string;
  description: string;
  /** IPFS CID once published; empty string until then. */
  cid: string;
}

export const BUILT_IN_PLUGINS: readonly BuiltInPluginDescriptor[] = [
  // Sibling market-data / neural-trader entries already live in
  // `.claude-plugin/marketplace.json`; aperture is registered here so the
  // runtime manager can lazily install it as a local plugin pre-publish.
  {
    name: 'ruflo-aperture',
    source: './plugins/ruflo-aperture',
    description:
      'Polymorphic, vendor-neutral market workspace — multi-pane SYMBOL VERB GO terminal where each pane is a swarm agent. Native ratatui + WASM (ratzilla) targets.',
    // TODO(publish): set the IPFS CID after the first Pinata pin (see
    // CLAUDE.md "Plugin Registry Maintenance"). Empty string keeps `local`
    // installs working in the meantime.
    cid: '',
  },
];

/**
 * Look up a built-in plugin descriptor by name.
 */
export function getBuiltInPlugin(
  name: string,
): BuiltInPluginDescriptor | undefined {
  return BUILT_IN_PLUGINS.find((p) => p.name === name);
}

export interface InstalledPluginsManifest {
  version: '1.0.0';
  lastUpdated: string;
  plugins: Record<string, InstalledPlugin>;
}

export interface PluginManagerConfig {
  pluginsDir: string;
  manifestPath: string;
}

// ============================================================================
// Plugin Manager
// ============================================================================

/**
 * Manages plugin installation, persistence, and lifecycle.
 *
 * Unlike the simulated version, this actually:
 * - Persists plugins to disk
 * - Downloads from npm
 * - Tracks enabled/disabled state
 * - Loads plugin modules
 */
export class PluginManager {
  private config: PluginManagerConfig;
  private manifest: InstalledPluginsManifest | null = null;

  constructor(baseDir: string = process.cwd()) {
    const pluginsDir = path.join(baseDir, '.claude-flow', 'plugins');
    this.config = {
      pluginsDir,
      manifestPath: path.join(pluginsDir, 'installed.json'),
    };
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  /**
   * Initialize the plugin manager, creating directories and loading manifest
   */
  async initialize(): Promise<void> {
    // Ensure plugins directory exists
    await this.ensureDirectory(this.config.pluginsDir);

    // Load or create manifest
    this.manifest = await this.loadManifest();
  }

  private async ensureDirectory(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async loadManifest(): Promise<InstalledPluginsManifest> {
    try {
      if (fs.existsSync(this.config.manifestPath)) {
        const content = fs.readFileSync(this.config.manifestPath, 'utf-8');
        return JSON.parse(content) as InstalledPluginsManifest;
      }
    } catch (error) {
      console.warn('[PluginManager] Failed to load manifest, creating new one');
    }

    return {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      plugins: {},
    };
  }

  private async saveManifest(): Promise<void> {
    if (!this.manifest) return;

    this.manifest.lastUpdated = new Date().toISOString();

    await this.ensureDirectory(path.dirname(this.config.manifestPath));
    fs.writeFileSync(
      this.config.manifestPath,
      JSON.stringify(this.manifest, null, 2),
      'utf-8'
    );
  }

  // =========================================================================
  // Installation
  // =========================================================================

  /**
   * Install a plugin from npm
   */
  async installFromNpm(
    packageName: string,
    version?: string
  ): Promise<{ success: boolean; error?: string; plugin?: InstalledPlugin }> {
    if (!this.manifest) {
      await this.initialize();
    }

    const versionSpec = version ? `${packageName}@${version}` : packageName;

    try {
      // Check if already installed
      if (this.manifest!.plugins[packageName]) {
        return {
          success: false,
          error: `Plugin ${packageName} is already installed. Use upgrade to update.`,
        };
      }

      // Install to local plugins directory
      const installDir = path.join(this.config.pluginsDir, 'node_modules');
      await this.ensureDirectory(installDir);

      // Validate package name to prevent injection (S-3)
      validatePackageName(versionSpec);

      // Use npm to install (array form prevents shell injection)
      console.log(`[PluginManager] Installing ${versionSpec}...`);

      await runNpm(['install', '--prefix', this.config.pluginsDir, versionSpec], 120000);

      // Get installed version
      const packageJsonPath = path.join(installDir, packageName, 'package.json');
      let installedVersion = version || 'latest';
      let commands: string[] = [];
      let hooks: string[] = [];

      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        installedVersion = pkg.version;

        // Check for claude-flow plugin metadata
        if (pkg['claude-flow']) {
          commands = pkg['claude-flow'].commands || [];
          hooks = pkg['claude-flow'].hooks || [];
        }
      }

      // Create plugin entry
      const plugin: InstalledPlugin = {
        name: packageName,
        version: installedVersion,
        installedAt: new Date().toISOString(),
        enabled: true,
        source: 'npm',
        path: path.join(installDir, packageName),
        commands,
        hooks,
      };

      // Save to manifest
      this.manifest!.plugins[packageName] = plugin;
      await this.saveManifest();

      console.log(`[PluginManager] Installed ${packageName}@${installedVersion}`);

      return { success: true, plugin };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[PluginManager] Failed to install ${packageName}:`, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Install a plugin from a local path
   */
  async installFromLocal(
    sourcePath: string
  ): Promise<{ success: boolean; error?: string; plugin?: InstalledPlugin }> {
    if (!this.manifest) {
      await this.initialize();
    }

    try {
      const absolutePath = path.resolve(sourcePath);

      if (!fs.existsSync(absolutePath)) {
        return { success: false, error: `Path does not exist: ${absolutePath}` };
      }

      // Read package.json
      const packageJsonPath = path.join(absolutePath, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {
        return { success: false, error: 'No package.json found at path' };
      }

      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const packageName = pkg.name;

      // Check if already installed
      if (this.manifest!.plugins[packageName]) {
        return {
          success: false,
          error: `Plugin ${packageName} is already installed`,
        };
      }

      // Create plugin entry (link to local path, don't copy)
      const plugin: InstalledPlugin = {
        name: packageName,
        version: pkg.version,
        installedAt: new Date().toISOString(),
        enabled: true,
        source: 'local',
        path: absolutePath,
        commands: pkg['claude-flow']?.commands || [],
        hooks: pkg['claude-flow']?.hooks || [],
      };

      // Save to manifest
      this.manifest!.plugins[packageName] = plugin;
      await this.saveManifest();

      console.log(`[PluginManager] Installed local plugin ${packageName}@${pkg.version}`);

      return { success: true, plugin };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[PluginManager] Failed to install from local:`, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  // =========================================================================
  // Uninstallation
  // =========================================================================

  /**
   * Uninstall a plugin
   */
  async uninstall(
    packageName: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.manifest) {
      await this.initialize();
    }

    const plugin = this.manifest!.plugins[packageName];
    if (!plugin) {
      return { success: false, error: `Plugin ${packageName} is not installed` };
    }

    try {
      // For npm-installed plugins, remove from node_modules
      if (plugin.source === 'npm') {
        validatePackageName(packageName);
        await runNpm(['uninstall', '--prefix', this.config.pluginsDir, packageName], 60000);
      }

      // Remove from manifest
      delete this.manifest!.plugins[packageName];
      await this.saveManifest();

      console.log(`[PluginManager] Uninstalled ${packageName}`);

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[PluginManager] Failed to uninstall ${packageName}:`, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  // =========================================================================
  // Enable/Disable
  // =========================================================================

  /**
   * Enable a plugin
   */
  async enable(packageName: string): Promise<{ success: boolean; error?: string }> {
    if (!this.manifest) {
      await this.initialize();
    }

    const plugin = this.manifest!.plugins[packageName];
    if (!plugin) {
      return { success: false, error: `Plugin ${packageName} is not installed` };
    }

    // HIGH-04: Warn about unsandboxed plugin execution
    console.warn(`[SECURITY] Plugin loaded without sandboxing: ${packageName}. Plugins run with full process access.`);

    plugin.enabled = true;
    await this.saveManifest();

    return { success: true };
  }

  /**
   * Disable a plugin
   */
  async disable(packageName: string): Promise<{ success: boolean; error?: string }> {
    if (!this.manifest) {
      await this.initialize();
    }

    const plugin = this.manifest!.plugins[packageName];
    if (!plugin) {
      return { success: false, error: `Plugin ${packageName} is not installed` };
    }

    plugin.enabled = false;
    await this.saveManifest();

    return { success: true };
  }

  /**
   * Toggle a plugin's enabled state
   */
  async toggle(packageName: string): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
    if (!this.manifest) {
      await this.initialize();
    }

    const plugin = this.manifest!.plugins[packageName];
    if (!plugin) {
      return { success: false, error: `Plugin ${packageName} is not installed` };
    }

    plugin.enabled = !plugin.enabled;
    await this.saveManifest();

    return { success: true, enabled: plugin.enabled };
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * Get all installed plugins
   */
  async getInstalled(): Promise<InstalledPlugin[]> {
    if (!this.manifest) {
      await this.initialize();
    }

    return Object.values(this.manifest!.plugins);
  }

  /**
   * Get enabled plugins
   */
  async getEnabled(): Promise<InstalledPlugin[]> {
    const all = await this.getInstalled();
    return all.filter(p => p.enabled);
  }

  /**
   * Check if a plugin is installed
   */
  async isInstalled(packageName: string): Promise<boolean> {
    if (!this.manifest) {
      await this.initialize();
    }

    return packageName in this.manifest!.plugins;
  }

  /**
   * Get a specific installed plugin
   */
  async getPlugin(packageName: string): Promise<InstalledPlugin | undefined> {
    if (!this.manifest) {
      await this.initialize();
    }

    return this.manifest!.plugins[packageName];
  }

  // =========================================================================
  // Upgrade
  // =========================================================================

  /**
   * Upgrade a plugin to a new version
   */
  async upgrade(
    packageName: string,
    version?: string
  ): Promise<{ success: boolean; error?: string; plugin?: InstalledPlugin }> {
    if (!this.manifest) {
      await this.initialize();
    }

    const existing = this.manifest!.plugins[packageName];
    if (!existing) {
      return { success: false, error: `Plugin ${packageName} is not installed` };
    }

    if (existing.source !== 'npm') {
      return { success: false, error: 'Can only upgrade npm-installed plugins' };
    }

    try {
      const versionSpec = version ? `${packageName}@${version}` : `${packageName}@latest`;

      // Validate package name to prevent injection (S-3)
      validatePackageName(versionSpec);

      // Reinstall with new version (array form prevents shell injection)
      await runNpm(['install', '--prefix', this.config.pluginsDir, versionSpec], 120000);

      // Update manifest
      const installDir = path.join(this.config.pluginsDir, 'node_modules');
      const packageJsonPath = path.join(installDir, packageName, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        existing.version = pkg.version;
        existing.commands = pkg['claude-flow']?.commands || existing.commands;
        existing.hooks = pkg['claude-flow']?.hooks || existing.hooks;
      }

      await this.saveManifest();

      console.log(`[PluginManager] Upgraded ${packageName} to ${existing.version}`);

      return { success: true, plugin: existing };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  // =========================================================================
  // Config
  // =========================================================================

  /**
   * Update plugin config
   */
  async setConfig(
    packageName: string,
    config: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.manifest) {
      await this.initialize();
    }

    const plugin = this.manifest!.plugins[packageName];
    if (!plugin) {
      return { success: false, error: `Plugin ${packageName} is not installed` };
    }

    plugin.config = { ...plugin.config, ...config };
    await this.saveManifest();

    return { success: true };
  }

  /**
   * Get plugins directory path
   */
  getPluginsDir(): string {
    return this.config.pluginsDir;
  }

  /**
   * Get manifest path
   */
  getManifestPath(): string {
    return this.config.manifestPath;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultManager: PluginManager | null = null;

export function getPluginManager(baseDir?: string): PluginManager {
  if (!defaultManager) {
    defaultManager = new PluginManager(baseDir);
  } else if (baseDir && defaultManager.getPluginsDir() !== path.join(baseDir, '.claude-flow', 'plugins')) {
    console.warn(`[PluginManager] Warning: getPluginManager called with different baseDir. Using existing instance. Call resetPluginManager() first to change.`);
  }
  return defaultManager;
}

export function resetPluginManager(): void {
  defaultManager = null;
}
