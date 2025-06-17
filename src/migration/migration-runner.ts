/**
 * Migration Runner - Executes migration strategies
 */

import fs from "npm:fs-extra@^11.0.0";
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { 
  MigrationOptions, 
  MigrationResult, 
  MigrationBackup,
  BackupFile,
  ValidationResult,
  MigrationProgress,
  MigrationManifest
} from './types.ts';
import { MigrationAnalyzer } from './migration-analyzer.ts';
import { logger } from './logger.ts';
import { ProgressReporter } from './progress-reporter.ts';
import { MigrationValidator } from './migration-validator.ts';
import { glob } from "npm:glob@^10.0.0";
import inquirer from "npm:inquirer@^9.0.0";
import chalk from "npm:chalk@^4.1.2";

export class MigrationRunner {
  private options: MigrationOptions;
  private progress: ProgressReporter;
  private analyzer: MigrationAnalyzer;
  private validator: MigrationValidator;
  private manifest: MigrationManifest;

  constructor(options: MigrationOptions) {
    this.options = options;
    this.progress = new ProgressReporter();
    this.analyzer = new MigrationAnalyzer();
    this.validator = new MigrationValidator();
    this.manifest = this.loadManifest();
  }

  async run(): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      filesModified: [],
      filesCreated: [],
      filesBackedUp: [],
      errors: [],
      warnings: []
    };

    try {
      // Analyze project
      this.progress.start('analyzing', 'Analyzing project...');
      const analysis = await this.analyzer.analyze(this.options.projectPath);
      
      // Show analysis and confirm
      if (!this.options.force && !this.options.dryRun) {
        this.analyzer.printAnalysis(analysis);
        const confirm = await this.confirmMigration(analysis);
        if (!confirm) {
          logger.info('Migration cancelled');
          return result;
        }
      }

      // Create backup
      if (!this.options.dryRun && analysis.hasClaudeFolder) {
        this.progress.update('backing-up', 'Creating backup...');
        const backup = await this.createBackup();
        result.rollbackPath = backup.timestamp.toISOString();
        result.filesBackedUp = backup.files.map(f => f.path);
      }

      // Execute migration based on strategy
      this.progress.update('migrating', 'Migrating files...');
      
      switch (this.options.strategy) {
        case 'full':
          await this.fullMigration(result);
          break;
        case 'selective':
          await this.selectiveMigration(result, analysis);
          break;
        case 'merge':
          await this.mergeMigration(result, analysis);
          break;
      }

      // Validate migration
      if (!this.options.skipValidation && !this.options.dryRun) {
        this.progress.update('validating', 'Validating migration...');
        const validation = await this.validator.validate(this.options.projectPath);
        
        if (!validation.valid) {
          result.errors.push(...validation.errors.map(e => ({ error: e })));
          result.warnings.push(...validation.warnings);
        }
      }

      result.success = result.errors.length === 0;
      this.progress.complete(result.success ? 'Migration completed successfully!' : 'Migration completed with errors');

      // Print summary
      this.printSummary(result);

    } catch (error) {
      result.errors.push({ error: error.message, stack: error.stack });
      this.progress.error('Migration failed');
      
      // Attempt rollback on failure
      if (result.rollbackPath && !this.options.dryRun) {
        logger.warn('Attempting automatic rollback...');
        try {
          await this.rollback(result.rollbackPath);
          logger.success('Rollback completed');
        } catch (rollbackError) {
          logger.error('Rollback failed:', rollbackError);
        }
      }
    }

    return result;
  }

  private async fullMigration(result: MigrationResult): Promise<void> {
    const sourcePath = path.join(__dirname, '../../.claude');
    const targetPath = path.join(this.options.projectPath, '.claude');

    if (this.options.dryRun) {
      logger.info('[DRY RUN] Would replace entire .claude folder');
      return;
    }

    // Remove existing .claude folder
    if (await fs.pathExists(targetPath)) {
      await fs.remove(targetPath);
    }

    // Copy new .claude folder
    await fs.copy(sourcePath, targetPath);
    result.filesCreated.push('.claude');

    // Copy other required files
    await this.copyRequiredFiles(result);
  }

  private async selectiveMigration(result: MigrationResult, analysis: any): Promise<void> {
    const sourcePath = path.join(__dirname, '../../.claude');
    const targetPath = path.join(this.options.projectPath, '.claude');

    // Ensure target directory exists
    await fs.ensureDir(targetPath);

    // Migrate commands selectively
    const commandsSource = path.join(sourcePath, 'commands');
    const commandsTarget = path.join(targetPath, 'commands');
    await fs.ensureDir(commandsTarget);

    // Copy optimized commands
    for (const command of this.manifest.files.commands) {
      const sourceFile = path.join(commandsSource, command.source);
      const targetFile = path.join(commandsTarget, command.target);

      if (this.options.preserveCustom && analysis.customCommands.includes(path.basename(command.target, '.md'))) {
        result.warnings.push(`Skipped ${command.target} (custom command preserved)`);
        continue;
      }

      if (this.options.dryRun) {
        logger.info(`[DRY RUN] Would copy ${command.source} to ${command.target}`);
      } else {
        await fs.copy(sourceFile, targetFile, { overwrite: true });
        result.filesCreated.push(command.target);
      }
    }

    // Copy optimization guides
    const guides = [
      'BATCHTOOLS_GUIDE.md',
      'BATCHTOOLS_BEST_PRACTICES.md',
      'MIGRATION_GUIDE.md',
      'PERFORMANCE_BENCHMARKS.md'
    ];

    for (const guide of guides) {
      const sourceFile = path.join(sourcePath, guide);
      const targetFile = path.join(targetPath, guide);

      if (await fs.pathExists(sourceFile)) {
        if (this.options.dryRun) {
          logger.info(`[DRY RUN] Would copy ${guide}`);
        } else {
          await fs.copy(sourceFile, targetFile, { overwrite: true });
          result.filesCreated.push(guide);
        }
      }
    }

    // Update configurations
    await this.updateConfigurations(result);
  }

  private async mergeMigration(result: MigrationResult, analysis: any): Promise<void> {
    // Similar to selective but merges configurations
    await this.selectiveMigration(result, analysis);

    // Merge configurations
    if (!this.options.dryRun) {
      await this.mergeConfigurations(result, analysis);
    }
  }

  private async mergeConfigurations(result: MigrationResult, analysis: any): Promise<void> {
    // Merge CLAUDE.md
    const claudeMdPath = path.join(this.options.projectPath, 'CLAUDE.md');
    if (await fs.pathExists(claudeMdPath)) {
      const existingContent = await fs.readFile(claudeMdPath, 'utf-8');
      const newContent = await this.getMergedClaudeMd(existingContent);
      
      await fs.writeFile(claudeMdPath, newContent);
      result.filesModified.push('CLAUDE.md');
    }

    // Merge .roomodes
    const roomodesPath = path.join(this.options.projectPath, '.roomodes');
    if (await fs.pathExists(roomodesPath)) {
      const existing = await fs.readJson(roomodesPath);
      const updated = await this.getMergedRoomodes(existing);
      
      await fs.writeJson(roomodesPath, updated, { spaces: 2 });
      result.filesModified.push('.roomodes');
    }
  }

  private async copyRequiredFiles(result: MigrationResult): Promise<void> {
    const files = [
      { source: 'CLAUDE.md', target: 'CLAUDE.md' },
      { source: '.roomodes', target: '.roomodes' }
    ];

    for (const file of files) {
      const sourcePath = path.join(__dirname, '../../', file.source);
      const targetPath = path.join(this.options.projectPath, file.target);

      if (await fs.pathExists(sourcePath)) {
        if (this.options.dryRun) {
          logger.info(`[DRY RUN] Would copy ${file.source}`);
        } else {
          await fs.copy(sourcePath, targetPath, { overwrite: true });
          result.filesCreated.push(file.target);
        }
      }
    }
  }

  private async updateConfigurations(result: MigrationResult): Promise<void> {
    // Update package.json scripts if needed
    const packageJsonPath = path.join(this.options.projectPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = await fs.readJson(packageJsonPath);
      
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }

      const scripts = {
        'migrate': 'claude-flow migrate',
        'migrate:analyze': 'claude-flow migrate analyze',
        'migrate:rollback': 'claude-flow migrate rollback'
      };

      let modified = false;
      for (const [name, command] of Object.entries(scripts)) {
        if (!packageJson.scripts[name]) {
          packageJson.scripts[name] = command;
          modified = true;
        }
      }

      if (modified && !this.options.dryRun) {
        await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
        result.filesModified.push('package.json');
      }
    }
  }

  private async createBackup(): Promise<MigrationBackup> {
    const backupDir = path.join(this.options.projectPath, this.options.backupDir || '.claude-backup');
    const timestamp = new Date();
    const backupPath = path.join(backupDir, timestamp.toISOString().replace(/:/g, '-'));

    await fs.ensureDir(backupPath);

    const backup: MigrationBackup = {
      timestamp,
      version: '1.0.0',
      files: [],
      metadata: {
        strategy: this.options.strategy,
        projectPath: this.options.projectPath
      }
    };

    // Backup .claude folder
    const claudePath = path.join(this.options.projectPath, '.claude');
    if (await fs.pathExists(claudePath)) {
      await fs.copy(claudePath, path.join(backupPath, '.claude'));
      
      // Record backed up files
      const files = await glob('**/*', { cwd: claudePath, nodir: true });
      for (const file of files) {
        const content = await fs.readFile(path.join(claudePath, file), 'utf-8');
        backup.files.push({
          path: `.claude/${file}`,
          content,
          checksum: crypto.createHash('md5').update(content).digest('hex')
        });
      }
    }

    // Backup other important files
    const importantFiles = ['CLAUDE.md', '.roomodes', 'package.json'];
    for (const file of importantFiles) {
      const filePath = path.join(this.options.projectPath, file);
      if (await fs.pathExists(filePath)) {
        await fs.copy(filePath, path.join(backupPath, file));
        const content = await fs.readFile(filePath, 'utf-8');
        backup.files.push({
          path: file,
          content,
          checksum: crypto.createHash('md5').update(content).digest('hex')
        });
      }
    }

    // Save backup manifest
    await fs.writeJson(path.join(backupPath, 'backup.json'), backup, { spaces: 2 });

    logger.success(`Backup created at ${backupPath}`);
    return backup;
  }

  async rollback(timestamp?: string): Promise<void> {
    const backupDir = path.join(this.options.projectPath, this.options.backupDir || '.claude-backup');
    
    if (!await fs.pathExists(backupDir)) {
      throw new Error('No backups found');
    }

    let backupPath: string;
    
    if (timestamp) {
      backupPath = path.join(backupDir, timestamp);
    } else {
      // Use most recent backup
      const backups = await fs.readdir(backupDir);
      if (backups.length === 0) {
        throw new Error('No backups found');
      }
      backups.sort().reverse();
      backupPath = path.join(backupDir, backups[0]);
    }

    if (!await fs.pathExists(backupPath)) {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    logger.info(`Rolling back from ${backupPath}...`);

    // Confirm rollback
    if (!this.options.force) {
      const confirm = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: 'Are you sure you want to rollback? This will overwrite current files.',
        default: false
      }]);

      if (!confirm.proceed) {
        logger.info('Rollback cancelled');
        return;
      }
    }

    // Restore files
    const backup = await fs.readJson(path.join(backupPath, 'backup.json'));
    
    for (const file of backup.files) {
      const targetPath = path.join(this.options.projectPath, file.path);
      await fs.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, file.content);
    }

    logger.success('Rollback completed successfully');
  }

  async validate(verbose: boolean = false): Promise<boolean> {
    const validation = await this.validator.validate(this.options.projectPath);
    
    if (verbose) {
      this.validator.printValidation(validation);
    }

    return validation.valid;
  }

  async listBackups(): Promise<void> {
    const backupDir = path.join(this.options.projectPath, this.options.backupDir || '.claude-backup');
    
    if (!await fs.pathExists(backupDir)) {
      logger.info('No backups found');
      return;
    }

    const backups = await fs.readdir(backupDir);
    if (backups.length === 0) {
      logger.info('No backups found');
      return;
    }

    console.log(chalk.bold('\n📦 Available Backups'));
    console.log(chalk.gray('─'.repeat(50)));

    for (const backup of backups.sort().reverse()) {
      const backupPath = path.join(backupDir, backup);
      const stats = await fs.stat(backupPath);
      const manifest = await fs.readJson(path.join(backupPath, 'backup.json')).catch(() => null);

      console.log(`\n${chalk.bold(backup)}`);
      console.log(`  Created: ${stats.mtime.toLocaleString()}`);
      console.log(`  Size: ${(stats.size / 1024).toFixed(2)} KB`);
      
      if (manifest) {
        console.log(`  Version: ${manifest.version}`);
        console.log(`  Strategy: ${manifest.metadata.strategy}`);
        console.log(`  Files: ${manifest.files.length}`);
      }
    }

    console.log(chalk.gray('\n' + '─'.repeat(50)));
  }

  private async confirmMigration(analysis: any): Promise<boolean> {
    const questions = [
      {
        type: 'confirm',
        name: 'proceed',
        message: `Proceed with ${this.options.strategy} migration?`,
        default: true
      }
    ];

    if (analysis.customCommands.length > 0 && !this.options.preserveCustom) {
      questions.unshift({
        type: 'confirm',
        name: 'preserveCustom',
        message: `Found ${analysis.customCommands.length} custom commands. Preserve them?`,
        default: true
      });
    }

    const answers = await inquirer.prompt(questions);
    
    if (answers.preserveCustom) {
      this.options.preserveCustom = true;
    }

    return answers.proceed;
  }

  private loadManifest(): MigrationManifest {
    // This would normally load from a manifest file
    return {
      version: '1.0.0',
      files: {
        commands: [
          { source: 'sparc.md', target: 'sparc.md' },
          { source: 'sparc/architect.md', target: 'sparc-architect.md' },
          { source: 'sparc/code.md', target: 'sparc-code.md' },
          { source: 'sparc/tdd.md', target: 'sparc-tdd.md' },
          { source: 'claude-flow-help.md', target: 'claude-flow-help.md' },
          { source: 'claude-flow-memory.md', target: 'claude-flow-memory.md' },
          { source: 'claude-flow-swarm.md', target: 'claude-flow-swarm.md' }
        ],
        configurations: {},
        templates: {}
      }
    };
  }

  private async getMergedClaudeMd(existingContent: string): Promise<string> {
    // Merge logic for CLAUDE.md
    const templatePath = path.join(__dirname, '../../CLAUDE.md');
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    // Simple merge: append custom content to template
    if (!existingContent.includes('SPARC Development Environment')) {
      return templateContent + '\n\n## Previous Configuration\n\n' + existingContent;
    }

    return templateContent;
  }

  private async getMergedRoomodes(existing: any): Promise<any> {
    const templatePath = path.join(__dirname, '../../.roomodes');
    const template = await fs.readJson(templatePath);

    // Merge custom modes with template
    const merged = { ...template };
    
    for (const [mode, config] of Object.entries(existing)) {
      if (!merged[mode]) {
        merged[mode] = config;
      }
    }

    return merged;
  }

  private printSummary(result: MigrationResult): void {
    console.log(chalk.bold('\n📋 Migration Summary'));
    console.log(chalk.gray('─'.repeat(50)));

    console.log(`\n${chalk.bold('Status:')} ${result.success ? chalk.green('Success') : chalk.red('Failed')}`);
    
    if (result.filesCreated.length > 0) {
      console.log(`\n${chalk.bold('Files Created:')} ${chalk.green(result.filesCreated.length)}`);
      if (result.filesCreated.length <= 10) {
        result.filesCreated.forEach(file => console.log(`  • ${file}`));
      }
    }

    if (result.filesModified.length > 0) {
      console.log(`\n${chalk.bold('Files Modified:')} ${chalk.yellow(result.filesModified.length)}`);
      result.filesModified.forEach(file => console.log(`  • ${file}`));
    }

    if (result.filesBackedUp.length > 0) {
      console.log(`\n${chalk.bold('Files Backed Up:')} ${chalk.blue(result.filesBackedUp.length)}`);
    }

    if (result.warnings.length > 0) {
      console.log(`\n${chalk.bold('Warnings:')}`);
      result.warnings.forEach(warning => console.log(`  ⚠️  ${warning}`));
    }

    if (result.errors.length > 0) {
      console.log(`\n${chalk.bold('Errors:')}`);
      result.errors.forEach(error => console.log(`  ❌ ${error.error}`));
    }

    if (result.rollbackPath) {
      console.log(`\n${chalk.bold('Rollback Available:')} ${result.rollbackPath}`);
      console.log(chalk.gray(`  Run "claude-flow migrate rollback -t ${result.rollbackPath}" to revert`));
    }

    console.log(chalk.gray('\n' + '─'.repeat(50)));
  }
}