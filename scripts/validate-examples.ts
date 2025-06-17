#!/usr/bin/env deno run --allow-read

/**
 * Example Configuration Validator
 * Validates all example configuration files for correctness
 */

import { walk } from "@std/fs";

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
}

interface ConfigSchema {
  [key: string]: {
    type: string;
    required?: boolean;
    properties?: ConfigSchema;
  };
}

const CLAUDE_FLOW_CONFIG_SCHEMA: ConfigSchema = {
  orchestrator: {
    type: 'object',
    required: true,
    properties: {
      maxConcurrentAgents: { type: 'number' },
      taskQueueSize: { type: 'number' },
      healthCheckInterval: { type: 'number' },
      shutdownTimeout: { type: 'number' },
    },
  },
  terminal: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      poolSize: { type: 'number' },
      recycleAfter: { type: 'number' },
      healthCheckInterval: { type: 'number' },
      commandTimeout: { type: 'number' },
    },
  },
  memory: {
    type: 'object',
    properties: {
      backend: { type: 'string' },
      cacheSizeMB: { type: 'number' },
      syncInterval: { type: 'number' },
      conflictResolution: { type: 'string' },
      retentionDays: { type: 'number' },
    },
  },
  coordination: {
    type: 'object',
    properties: {
      maxRetries: { type: 'number' },
      retryDelay: { type: 'number' },
      deadlockDetection: { type: 'boolean' },
      resourceTimeout: { type: 'number' },
      messageTimeout: { type: 'number' },
    },
  },
  mcp: {
    type: 'object',
    properties: {
      transport: { type: 'string' },
      port: { type: 'number' },
      tlsEnabled: { type: 'boolean' },
    },
  },
  logging: {
    type: 'object',
    properties: {
      level: { type: 'string' },
      format: { type: 'string' },
      destination: { type: 'string' },
    },
  },
};

const WORKFLOW_SCHEMA: ConfigSchema = {
  name: { type: 'string', required: true },
  description: { type: 'string' },
  tasks: {
    type: 'array',
    required: true,
    properties: {
      id: { type: 'string', required: true },
      type: { type: 'string', required: true },
      description: { type: 'string', required: true },
      dependencies: { type: 'array' },
      assignTo: { type: 'string' },
      priority: { type: 'string' },
      timeout: { type: 'number' },
    },
  },
};

function validateType(value: any, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

function validateObject(obj: any, schema: ConfigSchema, path = ''): string[] {
  const errors: string[] = [];
  
  // Check required fields
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.required && !(key in obj)) {
      errors.push(`${path}${key} is required but missing`);
      continue;
    }
    
    if (key in obj) {
      const value = obj[key];
      const currentPath = path ? `${path}${key}.` : `${key}.`;
      
      if (!validateType(value, spec.type)) {
        errors.push(`${path}${key} should be of type ${spec.type}, got ${typeof value}`);
        continue;
      }
      
      // Validate nested objects
      if (spec.type === 'object' && spec.properties) {
        errors.push(...validateObject(value, spec.properties, currentPath));
      }
      
      // Validate array items
      if (spec.type === 'array' && spec.properties && Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object') {
            errors.push(...validateObject(item, spec.properties!, `${currentPath}[${index}].`));
          }
        });
      }
    }
  }
  
  return errors;
}

function validateClaudeFlowConfig(config: any): string[] {
  return validateObject(config, CLAUDE_FLOW_CONFIG_SCHEMA);
}

function validateWorkflow(workflow: any): string[] {
  const errors = validateObject(workflow, WORKFLOW_SCHEMA);
  
  // Additional workflow-specific validations
  if (workflow.tasks && Array.isArray(workflow.tasks)) {
    const taskIds = new Set<string>();
    
    for (const [index, task] of workflow.tasks.entries()) {
      // Check for duplicate task IDs
      if (taskIds.has(task.id)) {
        errors.push(`Duplicate task ID "${task.id}" found at index ${index}`);
      } else {
        taskIds.add(task.id);
      }
      
      // Validate dependencies reference existing tasks
      if (task.dependencies && Array.isArray(task.dependencies)) {
        for (const dep of task.dependencies) {
          if (!taskIds.has(dep) && !workflow.tasks.slice(0, index).some((t: any) => t.id === dep)) {
            errors.push(`Task "${task.id}" depends on non-existent task "${dep}"`);
          }
        }
      }
      
      // Validate priority values
      if (task.priority && !['low', 'medium', 'high', 'critical'].includes(task.priority)) {
        errors.push(`Task "${task.id}" has invalid priority "${task.priority}"`);
      }
      
      // Validate timeout is positive
      if (task.timeout && task.timeout <= 0) {
        errors.push(`Task "${task.id}" has invalid timeout ${task.timeout}`);
      }
    }
  }
  
  return errors;
}

async function validateFile(filePath: string): Promise<ValidationResult> {
  const result: ValidationResult = {
    file: filePath,
    valid: false,
    errors: [],
  };
  
  try {
    const content = await Deno.readTextFile(filePath);
    const config = JSON.parse(content);
    
    // Determine validation type based on file name/content
    if (filePath.includes('workflow') || config.tasks) {
      result.errors = validateWorkflow(config);
    } else if (filePath.includes('config') || config.orchestrator) {
      result.errors = validateClaudeFlowConfig(config);
    } else {
      result.errors.push('Unknown configuration file type');
    }
    
    result.valid = result.errors.length === 0;
  } catch (error) {
    if (error instanceof SyntaxError) {
      result.errors.push(`Invalid JSON: ${error.message}`);
    } else {
      result.errors.push(`Failed to read file: ${error.message}`);
    }
  }
  
  return result;
}

async function main(): Promise<void> {
  console.log('Validating example configurations...\n');
  
  const results: ValidationResult[] = [];
  
  // Find all JSON files in examples directory
  for await (const entry of walk('./examples', { exts: ['.json'] })) {
    if (entry.isFile) {
      const result = await validateFile(entry.path);
      results.push(result);
    }
  }
  
  // Also check any config files in the root
  const rootConfigFiles = ['claude-flow.config.json', 'config.json'];
  for (const filename of rootConfigFiles) {
    try {
      await Deno.stat(filename);
      const result = await validateFile(filename);
      results.push(result);
    } catch {
      // File doesn't exist, skip
    }
  }
  
  if (results.length === 0) {
    console.log('No configuration files found to validate.');
    return;
  }
  
  // Report results
  let hasErrors = false;
  
  for (const result of results) {
    if (result.valid) {
      console.log(`✅ ${result.file}: Valid`);
    } else {
      console.log(`❌ ${result.file}: Invalid`);
      for (const error of result.errors) {
        console.log(`   - ${error}`);
      }
      hasErrors = true;
    }
  }
  
  console.log(`\nValidated ${results.length} configuration files.`);
  
  if (hasErrors) {
    console.error('❌ Some configuration files have errors!');
    Deno.exit(1);
  } else {
    console.log('✅ All configuration files are valid!');
  }
}

if (import.meta.main) {
  await main();
}