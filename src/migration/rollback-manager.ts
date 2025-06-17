/**
 * Rollback Manager - Handles rollback operations and backup management
 */

import fs from "npm:fs-extra@^11.0.0";
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { MigrationBackup, BackupFile } from './types.ts';
import { logger } from './logger.ts';
import chalk from "npm:chalk@^4.1.2";
import inquirer from "npm:inquirer@^9.0.0";

export class RollbackManager {
  private projectPath: string;
  private backupDir: string;

  constructor(projectPath: string, backupDir: string = '.claude-backup') {
    this.projectPath = projectPath;
    this.backupDir = path.join(projectPath, backupDir);
  }

  async createBackup(metadata: Record<string, any> = {}): Promise<MigrationBackup> {
    const timestamp = new Date();
    const backupId = timestamp.toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, backupId);

    logger.info(`Creating backup at ${backupPath}...`);

    await fs.ensureDir(backupPath);

    const backup: MigrationBackup = {
      timestamp,
      version: '1.0.0',
      files: [],
      metadata: {
        projectPath: this.projectPath,
        backupId,
        ...metadata
      }
    };

    // Backup critical files and directories
    const backupTargets = [
      '.claude',
      'CLAUDE.md',
      '.roomodes',
      'package.json',
      'memory/memory-store.json',
      'coordination/config.json'
    ];

    for (const target of backupTargets) {
      const sourcePath = path.join(this.projectPath, target);
      const targetPath = path.join(backupPath, target);

      if (await fs.pathExists(sourcePath)) {
        const stats = await fs.stat(sourcePath);

        if (stats.isDirectory()) {
          await this.backupDirectory(sourcePath, targetPath, backup);
        } else {
          await this.backupFile(sourcePath, targetPath, backup, target);
        }
      }
    }

    // Save backup manifest
    const manifestPath = path.join(backupPath, 'backup-manifest.json');
    await fs.writeJson(manifestPath, backup, { spaces: 2 });

    // Update backup index
    await this.updateBackupIndex(backup);

    logger.success(`Backup created with ${backup.files.length} files`);
    return backup;
  }

  private async backupDirectory(sourcePath: string, targetPath: string, backup: MigrationBackup): Promise<void> {
    await fs.ensureDir(targetPath);
    
    const entries = await fs.readdir(sourcePath);
    
    for (const entry of entries) {
      const entrySource = path.join(sourcePath, entry);
      const entryTarget = path.join(targetPath, entry);
      const stats = await fs.stat(entrySource);

      if (stats.isDirectory()) {
        await this.backupDirectory(entrySource, entryTarget, backup);
      } else {
        const relativePath = path.relative(this.projectPath, entrySource);
        await this.backupFile(entrySource, entryTarget, backup, relativePath);
      }
    }
  }

  private async backupFile(sourcePath: string, targetPath: string, backup: MigrationBackup, relativePath: string): Promise<void> {
    const content = await fs.readFile(sourcePath, 'utf-8');
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content);

    const backupFile: BackupFile = {
      path: relativePath,
      content,
      checksum,
      permissions: (await fs.stat(sourcePath)).mode.toString(8)
    };

    backup.files.push(backupFile);
  }

  async listBackups(): Promise<MigrationBackup[]> {
    if (!await fs.pathExists(this.backupDir)) {
      return [];
    }

    const backupFolders = await fs.readdir(this.backupDir);
    const backups: MigrationBackup[] = [];

    for (const folder of backupFolders.sort().reverse()) {
      const manifestPath = path.join(this.backupDir, folder, 'backup-manifest.json');
      
      if (await fs.pathExists(manifestPath)) {
        try {
          const backup = await fs.readJson(manifestPath);
          backups.push(backup);
        } catch (error) {
          logger.warn(`Invalid backup manifest in ${folder}: ${error.message}`);
        }
      }
    }

    return backups;
  }

  async rollback(backupId?: string, interactive: boolean = true): Promise<void> {
    const backups = await this.listBackups();
    
    if (backups.length === 0) {
      throw new Error('No backups found');
    }

    let selectedBackup: MigrationBackup;

    if (backupId) {
      selectedBackup = backups.find(b => b.metadata.backupId === backupId);
      if (!selectedBackup) {
        throw new Error(`Backup not found: ${backupId}`);
      }
    } else if (interactive) {
      selectedBackup = await this.selectBackupInteractively(backups);
    } else {
      selectedBackup = backups[0]; // Most recent
    }

    logger.info(`Rolling back to backup from ${selectedBackup.timestamp.toISOString()}...`);

    // Confirm rollback
    if (interactive) {
      const confirm = await inquirer.prompt([{
        type: 'confirm',
        name: 'proceed',
        message: `Are you sure you want to rollback? This will overwrite current files.`,
        default: false
      }]);

      if (!confirm.proceed) {
        logger.info('Rollback cancelled');
        return;
      }
    }

    // Create pre-rollback backup
    const preRollbackBackup = await this.createBackup({
      type: 'pre-rollback',
      rollingBackTo: selectedBackup.metadata.backupId
    });

    try {
      // Restore files
      await this.restoreFiles(selectedBackup);
      
      // Validate restoration
      await this.validateRestore(selectedBackup);
      
      logger.success('Rollback completed successfully');
      
    } catch (error) {
      logger.error('Rollback failed, attempting to restore pre-rollback state...');
      
      try {
        await this.restoreFiles(preRollbackBackup);
        logger.success('Pre-rollback state restored');
      } catch (restoreError) {
        logger.error('Failed to restore pre-rollback state:', restoreError);
        throw new Error('Rollback failed and unable to restore previous state');
      }
      
      throw error;
    }
  }

  private async selectBackupInteractively(backups: MigrationBackup[]): Promise<MigrationBackup> {
    const choices = backups.map(backup => ({
      name: `${backup.timestamp.toLocaleString()} - ${backup.files.length} files (${backup.metadata.type || 'migration'})`,
      value: backup,
      short: backup.metadata.backupId
    }));

    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'backup',
      message: 'Select backup to rollback to:',
      choices,
      pageSize: 10
    }]);

    return answer.backup;
  }

  private async restoreFiles(backup: MigrationBackup): Promise<void> {
    logger.info(`Restoring ${backup.files.length} files...`);

    for (const file of backup.files) {
      const targetPath = path.join(this.projectPath, file.path);
      
      logger.debug(`Restoring ${file.path}`);
      
      await fs.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, file.content);
      
      // Restore permissions if available
      if (file.permissions) {
        try {
          await fs.chmod(targetPath, parseInt(file.permissions, 8));
        } catch (error) {
          logger.warn(`Could not restore permissions for ${file.path}: ${error.message}`);
        }
      }
    }
  }

  private async validateRestore(backup: MigrationBackup): Promise<void> {
    logger.info('Validating restored files...');

    const errors: string[] = [];

    for (const file of backup.files) {
      const filePath = path.join(this.projectPath, file.path);
      
      if (!await fs.pathExists(filePath)) {
        errors.push(`Missing file: ${file.path}`);
        continue;
      }

      const content = await fs.readFile(filePath, 'utf-8');
      const checksum = crypto.createHash('sha256').update(content).digest('hex');

      if (checksum !== file.checksum) {
        errors.push(`Checksum mismatch: ${file.path}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed:\n${errors.join('\n')}`);
    }

    logger.success('Validation passed');
  }

  async cleanupOldBackups(retentionDays: number = 30, maxBackups: number = 10): Promise<void> {
    const backups = await this.listBackups();
    
    if (backups.length <= maxBackups) {
      return; // No cleanup needed
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const backupsToDelete = backups
      .filter((backup, index) => {
        // Keep the most recent maxBackups
        if (index < maxBackups) {
          return false;
        }
        
        // Delete old backups
        return backup.timestamp < cutoffDate;
      });

    if (backupsToDelete.length === 0) {
      return;
    }

    logger.info(`Cleaning up ${backupsToDelete.length} old backups...`);

    for (const backup of backupsToDelete) {
      const backupPath = path.join(this.backupDir, backup.metadata.backupId);
      await fs.remove(backupPath);
      logger.debug(`Removed backup: ${backup.metadata.backupId}`);
    }

    logger.success(`Cleanup completed, removed ${backupsToDelete.length} backups`);
  }

  async getBackupInfo(backupId: string): Promise<MigrationBackup | null> {
    const backups = await this.listBackups();
    return backups.find(b => b.metadata.backupId === backupId) || null;
  }

  async exportBackup(backupId: string, exportPath: string): Promise<void> {
    const backup = await this.getBackupInfo(backupId);
    if (!backup) {
      throw new Error(`Backup not found: ${backupId}`);
    }

    const backupPath = path.join(this.backupDir, backup.metadata.backupId);
    await fs.copy(backupPath, exportPath);
    
    logger.success(`Backup exported to ${exportPath}`);
  }

  async importBackup(importPath: string): Promise<MigrationBackup> {
    const manifestPath = path.join(importPath, 'backup-manifest.json');
    
    if (!await fs.pathExists(manifestPath)) {
      throw new Error('Invalid backup: missing manifest');
    }

    const backup = await fs.readJson(manifestPath);
    const backupPath = path.join(this.backupDir, backup.metadata.backupId);

    await fs.copy(importPath, backupPath);
    await this.updateBackupIndex(backup);

    logger.success(`Backup imported: ${backup.metadata.backupId}`);
    return backup;
  }

  private async updateBackupIndex(backup: MigrationBackup): Promise<void> {
    const indexPath = path.join(this.backupDir, 'backup-index.json');
    
    let index: Record<string, any> = {};
    if (await fs.pathExists(indexPath)) {
      index = await fs.readJson(indexPath);
    }

    index[backup.metadata.backupId] = {
      timestamp: backup.timestamp,
      version: backup.version,
      fileCount: backup.files.length,
      metadata: backup.metadata
    };

    await fs.writeJson(indexPath, index, { spaces: 2 });
  }

  printBackupSummary(backups: MigrationBackup[]): void {
    if (backups.length === 0) {
      console.log(chalk.yellow('No backups found'));
      return;
    }

    console.log(chalk.bold('\n💾 Available Backups'));
    console.log(chalk.gray('─'.repeat(70)));

    backups.forEach((backup, index) => {
      const isRecent = index === 0;
      const date = backup.timestamp.toLocaleString();
      const type = backup.metadata.type || 'migration';
      const fileCount = backup.files.length;
      
      console.log(`\n${isRecent ? chalk.green('●') : chalk.gray('○')} ${chalk.bold(backup.metadata.backupId)}`);
      console.log(`  ${chalk.gray('Date:')} ${date}`);
      console.log(`  ${chalk.gray('Type:')} ${type}`);
      console.log(`  ${chalk.gray('Files:')} ${fileCount}`);
      
      if (backup.metadata.strategy) {
        console.log(`  ${chalk.gray('Strategy:')} ${backup.metadata.strategy}`);
      }
    });

    console.log(chalk.gray('\n' + '─'.repeat(70)));
  }
}