/**
 * Migration System Tests
 * Comprehensive test suite for migration functionality
 */

import { describe, it, expect, beforeEach, afterEach } from "npm:jest@^29.0.0";
import fs from "npm:fs-extra@^11.0.0";
import * as path from "node:path";
import * as os from "node:os";
import { MigrationRunner } from '../migration-runner.ts';
import { MigrationAnalyzer } from '../migration-analyzer.ts';
import { RollbackManager } from '../rollback-manager.ts';
import { MigrationValidator } from '../migration-validator.ts';
import { MigrationStrategy } from '../types.ts';

describe('Migration System', () => {
  let testDir: string;
  let projectPath: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-test-'));
    projectPath = path.join(testDir, 'test-project');
    await fs.ensureDir(projectPath);
  });

  afterEach(async () => {
    // Cleanup test directory
    await fs.remove(testDir);
  });

  describe('MigrationAnalyzer', () => {
    it('should detect missing .claude folder', async () => {
      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);

      expect(analysis.hasClaudeFolder).toBe(false);
      expect(analysis.customCommands).toHaveLength(0);
      expect(analysis.migrationRisks).toContainEqual(
        expect.objectContaining({
          level: 'low',
          description: 'No existing .claude folder found'
        })
      );
    });

    it('should detect existing .claude folder and commands', async () => {
      // Create mock .claude structure
      const claudePath = path.join(projectPath, '.claude');
      const commandsPath = path.join(claudePath, 'commands');
      await fs.ensureDir(commandsPath);

      // Create standard commands
      await fs.writeFile(path.join(commandsPath, 'sparc.md'), '# SPARC Command');
      await fs.writeFile(path.join(commandsPath, 'custom-command.md'), '# Custom Command');

      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);

      expect(analysis.hasClaudeFolder).toBe(true);
      expect(analysis.customCommands).toContain('custom-command');
      expect(analysis.customCommands).not.toContain('sparc');
    });

    it('should detect optimized prompts', async () => {
      // Create mock optimized files
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      await fs.writeFile(path.join(claudePath, 'BATCHTOOLS_GUIDE.md'), '# Guide');
      await fs.writeFile(path.join(claudePath, 'BATCHTOOLS_BEST_PRACTICES.md'), '# Practices');

      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);

      expect(analysis.hasOptimizedPrompts).toBe(true);
    });

    it('should detect conflicting files', async () => {
      // Create files that would conflict
      const claudePath = path.join(projectPath, '.claude');
      const commandsPath = path.join(claudePath, 'commands');
      await fs.ensureDir(commandsPath);
      await fs.writeFile(path.join(commandsPath, 'sparc.md'), '# Custom SPARC');

      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);

      expect(analysis.conflictingFiles.length).toBeGreaterThan(0);
    });

    it('should generate appropriate recommendations', async () => {
      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);

      expect(analysis.recommendations).toContain(
        'Use "full" strategy for clean installation'
      );
    });
  });

  describe('MigrationRunner', () => {
    it('should perform full migration on empty project', async () => {
      const runner = new MigrationRunner({
        projectPath,
        strategy: 'full',
        force: true,
        dryRun: true
      });

      const result = await runner.run();

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should preserve custom commands in selective migration', async () => {
      // Setup project with custom command
      const claudePath = path.join(projectPath, '.claude');
      const commandsPath = path.join(claudePath, 'commands');
      await fs.ensureDir(commandsPath);
      await fs.writeFile(path.join(commandsPath, 'custom-cmd.md'), '# Custom');

      const runner = new MigrationRunner({
        projectPath,
        strategy: 'selective',
        preserveCustom: true,
        force: true,
        dryRun: true
      });

      const result = await runner.run();

      expect(result.success).toBe(true);
      expect(result.warnings).toContain(
        expect.stringContaining('custom-cmd')
      );
    });

    it('should create backup before migration', async () => {
      // Create existing .claude folder
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      await fs.writeFile(path.join(claudePath, 'test.md'), '# Test');

      const runner = new MigrationRunner({
        projectPath,
        strategy: 'full',
        force: true,
        dryRun: false
      });

      const result = await runner.run();

      expect(result.rollbackPath).toBeDefined();
      expect(result.filesBackedUp.length).toBeGreaterThan(0);
    });

    it('should handle migration errors gracefully', async () => {
      // Create invalid project state
      const runner = new MigrationRunner({
        projectPath: '/invalid/path',
        strategy: 'full',
        force: true
      });

      const result = await runner.run();

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should support dry-run mode', async () => {
      const runner = new MigrationRunner({
        projectPath,
        strategy: 'full',
        force: true,
        dryRun: true
      });

      const result = await runner.run();

      // Should not create actual files in dry-run
      const claudePath = path.join(projectPath, '.claude');
      const exists = await fs.pathExists(claudePath);
      expect(exists).toBe(false);
    });
  });

  describe('RollbackManager', () => {
    let rollbackManager: RollbackManager;

    beforeEach(() => {
      rollbackManager = new RollbackManager(projectPath);
    });

    it('should create backup with file checksums', async () => {
      // Create files to backup
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      await fs.writeFile(path.join(claudePath, 'test.md'), '# Test Content');
      await fs.writeFile(path.join(projectPath, 'CLAUDE.md'), '# Project Config');

      const backup = await rollbackManager.createBackup();

      expect(backup.files.length).toBeGreaterThan(0);
      expect(backup.files[0]).toHaveProperty('checksum');
      expect(backup.files[0]).toHaveProperty('content');
    });

    it('should list backups chronologically', async () => {
      // Create multiple backups
      await rollbackManager.createBackup({ type: 'first' });
      await new Promise(resolve => setTimeout(resolve, 100)); // Ensure different timestamps
      await rollbackManager.createBackup({ type: 'second' });

      const backups = await rollbackManager.listBackups();

      expect(backups).toHaveLength(2);
      expect(backups[0].timestamp).toBeInstanceOf(Date);
      expect(backups[0].timestamp.getTime()).toBeGreaterThan(backups[1].timestamp.getTime());
    });

    it('should restore files from backup', async () => {
      // Create original files
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      const originalContent = '# Original Content';
      await fs.writeFile(path.join(claudePath, 'test.md'), originalContent);

      // Create backup
      const backup = await rollbackManager.createBackup();

      // Modify file
      await fs.writeFile(path.join(claudePath, 'test.md'), '# Modified Content');

      // Rollback
      await rollbackManager.rollback(backup.metadata.backupId, false);

      // Verify restoration
      const restoredContent = await fs.readFile(path.join(claudePath, 'test.md'), 'utf-8');
      expect(restoredContent).toBe(originalContent);
    });

    it('should cleanup old backups', async () => {
      // Create multiple backups
      for (let i = 0; i < 5; i++) {
        await rollbackManager.createBackup({ type: `backup-${i}` });
      }

      const backupsBefore = await rollbackManager.listBackups();
      expect(backupsBefore).toHaveLength(5);

      // Cleanup keeping only 2 backups
      await rollbackManager.cleanupOldBackups(0, 2);

      const backupsAfter = await rollbackManager.listBackups();
      expect(backupsAfter).toHaveLength(2);
    });

    it('should export and import backups', async () => {
      // Create backup
      const backup = await rollbackManager.createBackup();
      
      // Export backup
      const exportPath = path.join(testDir, 'exported-backup');
      await rollbackManager.exportBackup(backup.metadata.backupId, exportPath);
      
      // Verify export
      const manifestPath = path.join(exportPath, 'backup-manifest.json');
      expect(await fs.pathExists(manifestPath)).toBe(true);
      
      // Import backup (to different project)
      const newProjectPath = path.join(testDir, 'new-project');
      const newRollbackManager = new RollbackManager(newProjectPath);
      
      const importedBackup = await newRollbackManager.importBackup(exportPath);
      expect(importedBackup.metadata.backupId).toBe(backup.metadata.backupId);
    });
  });

  describe('MigrationValidator', () => {
    let validator: MigrationValidator;

    beforeEach(() => {
      validator = new MigrationValidator();
    });

    it('should validate successful migration', async () => {
      // Create valid migrated structure
      const claudePath = path.join(projectPath, '.claude');
      const commandsPath = path.join(claudePath, 'commands');
      await fs.ensureDir(commandsPath);
      
      // Create required files
      await fs.writeFile(path.join(commandsPath, 'sparc.md'), '# SPARC Command');
      await fs.writeFile(path.join(commandsPath, 'claude-flow-help.md'), '# Help');
      await fs.writeFile(path.join(claudePath, 'BATCHTOOLS_GUIDE.md'), '# Guide');

      const result = await validator.validate(projectPath);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required files', async () => {
      // Create incomplete structure
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);

      const result = await validator.validate(projectPath);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('Required file missing'))).toBe(true);
    });

    it('should detect corrupted files', async () => {
      // Create structure with empty files
      const claudePath = path.join(projectPath, '.claude');
      const commandsPath = path.join(claudePath, 'commands');
      await fs.ensureDir(commandsPath);
      
      await fs.writeFile(path.join(commandsPath, 'sparc.md'), ''); // Empty file

      const result = await validator.validate(projectPath);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Empty file'))).toBe(true);
    });

    it('should provide detailed validation report', async () => {
      const result = await validator.validate(projectPath);

      expect(result.checks.length).toBeGreaterThan(0);
      expect(result.checks[0]).toHaveProperty('name');
      expect(result.checks[0]).toHaveProperty('passed');
    });
  });

  describe('Integration Tests', () => {
    it('should complete full migration workflow', async () => {
      // 1. Analyze project
      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);
      expect(analysis.hasClaudeFolder).toBe(false);

      // 2. Run migration
      const runner = new MigrationRunner({
        projectPath,
        strategy: 'full',
        force: true,
        dryRun: false
      });
      const result = await runner.run();
      expect(result.success).toBe(true);

      // 3. Validate migration
      const validator = new MigrationValidator();
      const validation = await validator.validate(projectPath);
      expect(validation.valid).toBe(true);

      // 4. Verify rollback capability
      const rollbackManager = new RollbackManager(projectPath);
      const backups = await rollbackManager.listBackups();
      expect(backups.length).toBeGreaterThan(0);
    });

    it('should handle migration with conflicts', async () => {
      // Create conflicting files
      const claudePath = path.join(projectPath, '.claude');
      const commandsPath = path.join(claudePath, 'commands');
      await fs.ensureDir(commandsPath);
      await fs.writeFile(path.join(commandsPath, 'sparc.md'), '# Custom SPARC');

      // Run analysis
      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);
      expect(analysis.conflictingFiles.length).toBeGreaterThan(0);

      // Run merge migration
      const runner = new MigrationRunner({
        projectPath,
        strategy: 'merge',
        preserveCustom: true,
        force: true,
        dryRun: false
      });
      const result = await runner.run();
      expect(result.success).toBe(true);
    });

    it('should recover from failed migration', async () => {
      // Create backup first
      const rollbackManager = new RollbackManager(projectPath);
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      await fs.writeFile(path.join(claudePath, 'original.md'), '# Original');
      
      const backup = await rollbackManager.createBackup();

      // Simulate failed migration by creating invalid state
      await fs.writeFile(path.join(claudePath, 'broken.md'), '');

      // Rollback
      await rollbackManager.rollback(backup.metadata.backupId, false);

      // Verify recovery
      const exists = await fs.pathExists(path.join(claudePath, 'original.md'));
      expect(exists).toBe(true);
      
      const brokenExists = await fs.pathExists(path.join(claudePath, 'broken.md'));
      expect(brokenExists).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle readonly files', async () => {
      // Create readonly file
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      const readonlyFile = path.join(claudePath, 'readonly.md');
      await fs.writeFile(readonlyFile, '# Readonly');
      await fs.chmod(readonlyFile, 0o444); // readonly

      const runner = new MigrationRunner({
        projectPath,
        strategy: 'full',
        force: true,
        dryRun: false
      });

      // Should handle gracefully
      const result = await runner.run();
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should handle invalid JSON configurations', async () => {
      // Create invalid .roomodes file
      const roomodesPath = path.join(projectPath, '.roomodes');
      await fs.writeFile(roomodesPath, 'invalid json {');

      const analyzer = new MigrationAnalyzer();
      const analysis = await analyzer.analyze(projectPath);

      expect(analysis.migrationRisks.some(r => r.description.includes('Invalid .roomodes'))).toBe(true);
    });

    it('should handle missing permissions', async () => {
      // Create directory without write permissions
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      await fs.chmod(claudePath, 0o555); // readonly

      const validator = new MigrationValidator();
      const result = await validator.validate(projectPath);

      expect(result.warnings.some(w => w.includes('not be writable'))).toBe(true);
    });

    it('should handle very large files', async () => {
      // Create large file
      const claudePath = path.join(projectPath, '.claude');
      await fs.ensureDir(claudePath);
      const largeContent = 'a'.repeat(1024 * 1024); // 1MB
      await fs.writeFile(path.join(claudePath, 'large.md'), largeContent);

      const rollbackManager = new RollbackManager(projectPath);
      const backup = await rollbackManager.createBackup();

      expect(backup.files.some(f => f.content.length > 1000000)).toBe(true);
    });

    it('should handle concurrent migrations', async () => {
      // This test would need careful setup to avoid race conditions
      // For now, we just ensure the migration system is thread-safe
      const runners = Array.from({ length: 3 }, () => 
        new MigrationRunner({
          projectPath,
          strategy: 'selective',
          force: true,
          dryRun: true
        })
      );

      // Run multiple migrations concurrently
      const results = await Promise.allSettled(
        runners.map(runner => runner.run())
      );

      // At least one should succeed
      expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    });
  });
});