// utils.js - Shared CLI utility functions

// Color formatting functions
export function printSuccess(message) {
  console.log(`✅ ${message}`);
}

export function printError(message) {
  console.log(`❌ ${message}`);
}

export function printWarning(message) {
  console.log(`⚠️  ${message}`);
}

export function printInfo(message) {
  console.log(`ℹ️  ${message}`);
}

// Command validation helpers
export function validateArgs(args, minLength, usage) {
  if (args.length < minLength) {
    printError(`Usage: ${usage}`);
    return false;
  }
  return true;
}

// File system helpers
export async function ensureDirectory(path) {
  try {
    await Deno.mkdir(path, { recursive: true });
    return true;
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) {
      throw err;
    }
    return true;
  }
}

export async function fileExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// JSON helpers
export async function readJsonFile(path, defaultValue = {}) {
  try {
    const content = await Deno.readTextFile(path);
    return JSON.parse(content);
  } catch {
    return defaultValue;
  }
}

export async function writeJsonFile(path, data) {
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
}

// String helpers
export function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString();
}

export function truncateString(str, length = 100) {
  return str.length > length ? str.substring(0, length) + '...' : str;
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// Command execution helpers
export function parseFlags(args) {
  const flags = {};
  const filteredArgs = [];
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      let flagName = arg.substring(2);
      let value = true;
      const nextArg = args[i + 1];

      // Handle flags with values (e.g., --config myconfig.json)
      // and boolean flags (e.g., --force, --merge)
      if (nextArg && !nextArg.startsWith('--')) {
        // Specific flags that take values
        if (flagName === "config" || flagName === "name" || flagName === "namespace" ||
            flagName === "mode" || flagName === "shell" || flagName === "working-directory" ||
            flagName === "env" || flagName === "output" || flagName === "services" ||
            flagName === "regions" || flagName === "tools" || flagName === "coverage" ||
            flagName === "commit" || flagName === "nodes" ||
            flagName === "replication-factor" || flagName === "access-level" ||
            flagName === "isolation" || flagName === "resource-quota" ||
            flagName === "security-profile" || flagName === "template") {
          value = nextArg;
          i++; // Skip next arg since we consumed it
        }
      }

      // Handle potential kebab-case to camelCase conversion if desired, though current structure keeps them kebab-case
      // Example: if (flagName === "some-flag") flagName = "someFlag";

      flags[flagName] = value;

    } else if (arg.startsWith('-') && arg.length > 1) {
      // Short flags
      const shortFlags = arg.substring(1);
      for (const flag of shortFlags) {
        flags[flag] = true;
      }
    } else {
      filteredArgs.push(arg);
    }
  }
  
  return { flags, args: filteredArgs };
}

// Process execution helpers
export async function runCommand(command, args = [], options = {}) {
  try {
    const cmd = new Deno.Command(command, {
      args,
      ...options
    });
    
    const result = await cmd.output();
    
    return {
      success: result.code === 0,
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr)
    };
  } catch (err) {
    return {
      success: false,
      code: -1,
      stdout: '',
      stderr: err.message
    };
  }
}

// Configuration helpers
export async function loadConfig(path = 'claude-flow.config.json') {
  const defaultConfig = {
    terminal: {
      poolSize: 10,
      recycleAfter: 20,
      healthCheckInterval: 30000,
      type: "auto"
    },
    orchestrator: {
      maxConcurrentTasks: 10,
      taskTimeout: 300000
    },
    memory: {
      backend: "json",
      path: "./memory/claude-flow-data.json"
    }
  };
  
  try {
    const content = await Deno.readTextFile(path);
    return { ...defaultConfig, ...JSON.parse(content) };
  } catch {
    return defaultConfig;
  }
}

export async function saveConfig(config, path = 'claude-flow.config.json') {
  await writeJsonFile(path, config);
}

// ID generation
export function generateId(prefix = '') {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
}

// Array helpers
export function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Environment helpers
export function getEnvVar(name, defaultValue = null) {
  return Deno.env.get(name) ?? defaultValue;
}

export function setEnvVar(name, value) {
  Deno.env.set(name, value);
}

// Validation helpers
export function isValidJson(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

export function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// Progress and status helpers
export function showProgress(current, total, message = '') {
  const percentage = Math.round((current / total) * 100);
  const bar = '█'.repeat(Math.round(percentage / 5)) + '░'.repeat(20 - Math.round(percentage / 5));
  console.log(`\r${bar} ${percentage}% ${message}`);
}

export function clearLine() {
  console.log('\r\x1b[K');
}

// Async helpers
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retry(fn, maxAttempts = 3, delay = 1000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }
      await sleep(delay * attempt);
    }
  }
}