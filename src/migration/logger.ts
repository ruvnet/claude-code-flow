/**
 * Migration Logger - Structured logging for migration operations
 */

import fs from "npm:fs-extra@^11.0.0";
import * as path from 'node:path';
import chalk from "npm:chalk@^4.1.2";

export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'success' | 'debug';
  message: string;
  context?: any;
  stack?: string;
}

export class MigrationLogger {
  private logFile?: string;
  private entries: LogEntry[] = [];

  constructor(logFile?: string) {
    this.logFile = logFile;
  }

  info(message: string, context?: any): void {
    this.log('info', message, context);
    console.log(chalk.blue(`ℹ️  ${message}`));
  }

  warn(message: string, context?: any): void {
    this.log('warn', message, context);
    console.log(chalk.yellow(`⚠️  ${message}`));
  }

  error(message: string, error?: Error | any, context?: any): void {
    this.log('error', message, context, error?.stack);
    console.log(chalk.red(`❌ ${message}`));
    if (error && error.message !== message) {
      console.log(chalk.red(`   ${error.message}`));
    }
  }

  success(message: string, context?: any): void {
    this.log('success', message, context);
    console.log(chalk.green(`✅ ${message}`));
  }

  debug(message: string, context?: any): void {
    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
      this.log('debug', message, context);
      console.log(chalk.gray(`🔍 ${message}`));
    }
  }

  private log(level: LogEntry['level'], message: string, context?: any, stack?: string): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      context,
      stack
    };

    this.entries.push(entry);

    if (this.logFile) {
      this.writeToFile(entry);
    }
  }

  private async writeToFile(entry: LogEntry): Promise<void> {
    if (!this.logFile) return;

    try {
      const logDir = path.dirname(this.logFile);
      await fs.ensureDir(logDir);

      const logLine = JSON.stringify(entry) + '\n';
      await fs.appendFile(this.logFile, logLine);
    } catch (error) {
      // Prevent recursive logging
      console.error('Failed to write to log file:', error.message);
    }
  }

  async saveToFile(filePath: string): Promise<void> {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeJson(filePath, this.entries, { spaces: 2 });
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  getEntriesByLevel(level: LogEntry['level']): LogEntry[] {
    return this.entries.filter(entry => entry.level === level);
  }

  clear(): void {
    this.entries = [];
  }

  printSummary(): void {
    const summary = {
      total: this.entries.length,
      info: this.getEntriesByLevel('info').length,
      warn: this.getEntriesByLevel('warn').length,
      error: this.getEntriesByLevel('error').length,
      success: this.getEntriesByLevel('success').length,
      debug: this.getEntriesByLevel('debug').length
    };

    console.log(chalk.bold('\n📊 Migration Log Summary'));
    console.log(chalk.gray('─'.repeat(30)));
    console.log(`Total entries: ${summary.total}`);
    console.log(`${chalk.blue('Info:')} ${summary.info}`);
    console.log(`${chalk.green('Success:')} ${summary.success}`);
    console.log(`${chalk.yellow('Warnings:')} ${summary.warn}`);
    console.log(`${chalk.red('Errors:')} ${summary.error}`);
    if (summary.debug > 0) {
      console.log(`${chalk.gray('Debug:')} ${summary.debug}`);
    }
    console.log(chalk.gray('─'.repeat(30)));
  }
}

// Global logger instance
export const logger = new MigrationLogger();

// Set log file if in production
if (process.env.NODE_ENV === 'production') {
  const logFile = path.join(process.cwd(), 'logs', 'migration.log');
  logger['logFile'] = logFile;
}