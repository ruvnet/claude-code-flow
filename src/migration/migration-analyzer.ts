/**
 * Migration Analyzer - Analyzes existing projects for migration readiness
 */

import fs from "npm:fs-extra@^11.0.0";
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { MigrationAnalysis, MigrationRisk } from './types.ts';
import { logger } from './logger.ts';
import chalk from "npm:chalk@^4.1.2";
import { glob } from "npm:glob@^10.0.0";

export class MigrationAnalyzer {
  private optimizedCommands = [
    'sparc', 'sparc-architect', 'sparc-code', 'sparc-tdd',
    'claude-flow-help', 'claude-flow-memory', 'claude-flow-swarm'
  ];

  async analyze(projectPath: string): Promise<MigrationAnalysis> {
    logger.info(`Analyzing project at ${projectPath}...`);

    const analysis: MigrationAnalysis = {
      projectPath,
      hasClaudeFolder: false,
      hasOptimizedPrompts: false,
      customCommands: [],
      customConfigurations: {},
      conflictingFiles: [],
      migrationRisks: [],
      recommendations: [],
      timestamp: new Date()
    };

    // Check for .claude folder
    const claudePath = path.join(projectPath, '.claude');
    if (await fs.pathExists(claudePath)) {
      analysis.hasClaudeFolder = true;
      
      // Analyze existing commands
      await this.analyzeCommands(claudePath, analysis);
      
      // Check for optimized prompts
      await this.checkOptimizedPrompts(claudePath, analysis);
      
      // Analyze configurations
      await this.analyzeConfigurations(projectPath, analysis);
      
      // Detect conflicts
      await this.detectConflicts(projectPath, analysis);
    }

    // Generate risks and recommendations
    this.assessRisks(analysis);
    this.generateRecommendations(analysis);

    return analysis;
  }

  private async analyzeCommands(claudePath: string, analysis: MigrationAnalysis): Promise<void> {
    const commandsPath = path.join(claudePath, 'commands');
    
    if (await fs.pathExists(commandsPath)) {
      const files = await glob('**/*.md', { cwd: commandsPath });
      
      for (const file of files) {
        const commandName = path.basename(file, '.md');
        
        if (!this.optimizedCommands.includes(commandName)) {
          analysis.customCommands.push(commandName);
        }
      }
    }
  }

  private async checkOptimizedPrompts(claudePath: string, analysis: MigrationAnalysis): Promise<void> {
    // Check for key optimized prompt files
    const optimizedFiles = [
      'BATCHTOOLS_GUIDE.md',
      'BATCHTOOLS_BEST_PRACTICES.md',
      'MIGRATION_GUIDE.md',
      'PERFORMANCE_BENCHMARKS.md'
    ];

    let hasOptimized = 0;
    for (const file of optimizedFiles) {
      if (await fs.pathExists(path.join(claudePath, file))) {
        hasOptimized++;
      }
    }

    analysis.hasOptimizedPrompts = hasOptimized >= 2;
  }

  private async analyzeConfigurations(projectPath: string, analysis: MigrationAnalysis): Promise<void> {
    // Check for CLAUDE.md
    const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
    if (await fs.pathExists(claudeMdPath)) {
      const content = await fs.readFile(claudeMdPath, 'utf-8');
      analysis.customConfigurations['CLAUDE.md'] = {
        exists: true,
        size: content.length,
        hasCustomContent: !content.includes('SPARC Development Environment')
      };
    }

    // Check for .roomodes
    const roomodesPath = path.join(projectPath, '.roomodes');
    if (await fs.pathExists(roomodesPath)) {
      try {
        const roomodes = await fs.readJson(roomodesPath);
        analysis.customConfigurations['.roomodes'] = {
          exists: true,
          modeCount: Object.keys(roomodes).length,
          customModes: Object.keys(roomodes).filter(mode => 
            !['architect', 'code', 'tdd', 'debug', 'docs-writer'].includes(mode)
          )
        };
      } catch (error) {
        analysis.migrationRisks.push({
          level: 'medium',
          description: 'Invalid .roomodes file',
          file: roomodesPath,
          mitigation: 'File will be backed up and replaced'
        });
      }
    }
  }

  private async detectConflicts(projectPath: string, analysis: MigrationAnalysis): Promise<void> {
    // Check for files that might conflict with migration
    const potentialConflicts = [
      '.claude/commands/sparc.md',
      '.claude/BATCHTOOLS_GUIDE.md',
      'memory/memory-store.json',
      'coordination/config.json'
    ];

    for (const file of potentialConflicts) {
      const filePath = path.join(projectPath, file);
      if (await fs.pathExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        const checksum = crypto.createHash('md5').update(content).digest('hex');
        
        // Check if it's a custom version
        if (!this.isStandardFile(file, checksum)) {
          analysis.conflictingFiles.push(file);
        }
      }
    }
  }

  private isStandardFile(file: string, checksum: string): boolean {
    // This would contain checksums of standard files
    // For now, we'll assume all existing files are potentially custom
    return false;
  }

  private assessRisks(analysis: MigrationAnalysis): void {
    // High risk: Custom commands that might be overwritten
    if (analysis.customCommands.length > 0) {
      analysis.migrationRisks.push({
        level: 'high',
        description: `Found ${analysis.customCommands.length} custom commands that may be affected`,
        mitigation: 'Use --preserve-custom flag or selective migration'
      });
    }

    // Medium risk: Existing optimized prompts
    if (analysis.hasOptimizedPrompts) {
      analysis.migrationRisks.push({
        level: 'medium',
        description: 'Project already has some optimized prompts',
        mitigation: 'Consider using merge strategy to preserve customizations'
      });
    }

    // Low risk: No .claude folder
    if (!analysis.hasClaudeFolder) {
      analysis.migrationRisks.push({
        level: 'low',
        description: 'No existing .claude folder found',
        mitigation: 'Fresh installation will be performed'
      });
    }

    // High risk: Conflicting files
    if (analysis.conflictingFiles.length > 0) {
      analysis.migrationRisks.push({
        level: 'high',
        description: `${analysis.conflictingFiles.length} files may have custom modifications`,
        mitigation: 'Files will be backed up before migration'
      });
    }
  }

  private generateRecommendations(analysis: MigrationAnalysis): void {
    // Strategy recommendations
    if (analysis.customCommands.length > 0 || analysis.conflictingFiles.length > 0) {
      analysis.recommendations.push(
        'Use "selective" or "merge" strategy to preserve customizations'
      );
    } else if (!analysis.hasClaudeFolder) {
      analysis.recommendations.push(
        'Use "full" strategy for clean installation'
      );
    }

    // Backup recommendations
    if (analysis.hasClaudeFolder) {
      analysis.recommendations.push(
        'Create a backup before migration (automatic with default settings)'
      );
    }

    // Custom command recommendations
    if (analysis.customCommands.length > 0) {
      analysis.recommendations.push(
        `Review custom commands: ${analysis.customCommands.join(', ')}`
      );
    }

    // Validation recommendations
    if (analysis.migrationRisks.some(r => r.level === 'high')) {
      analysis.recommendations.push(
        'Run with --dry-run first to preview changes'
      );
    }
  }

  printAnalysis(analysis: MigrationAnalysis, detailed: boolean = false): void {
    console.log(chalk.bold('\n📊 Migration Analysis Report'));
    console.log(chalk.gray('─'.repeat(50)));
    
    console.log(`\n${chalk.bold('Project:')} ${analysis.projectPath}`);
    console.log(`${chalk.bold('Timestamp:')} ${analysis.timestamp.toISOString()}`);
    
    // Status
    console.log(chalk.bold('\n📋 Current Status:'));
    console.log(`  • .claude folder: ${analysis.hasClaudeFolder ? chalk.green('✓') : chalk.red('✗')}`);
    console.log(`  • Optimized prompts: ${analysis.hasOptimizedPrompts ? chalk.green('✓') : chalk.red('✗')}`);
    console.log(`  • Custom commands: ${analysis.customCommands.length > 0 ? chalk.yellow(analysis.customCommands.length) : chalk.green('0')}`);
    console.log(`  • Conflicts: ${analysis.conflictingFiles.length > 0 ? chalk.yellow(analysis.conflictingFiles.length) : chalk.green('0')}`);
    
    // Risks
    if (analysis.migrationRisks.length > 0) {
      console.log(chalk.bold('\n⚠️  Migration Risks:'));
      analysis.migrationRisks.forEach(risk => {
        const icon = risk.level === 'high' ? '🔴' : risk.level === 'medium' ? '🟡' : '🟢';
        console.log(`  ${icon} ${chalk.bold(risk.level.toUpperCase())}: ${risk.description}`);
        if (risk.mitigation) {
          console.log(`     ${chalk.gray('→')} ${chalk.italic(risk.mitigation)}`);
        }
      });
    }
    
    // Recommendations
    if (analysis.recommendations.length > 0) {
      console.log(chalk.bold('\n💡 Recommendations:'));
      analysis.recommendations.forEach(rec => {
        console.log(`  • ${rec}`);
      });
    }
    
    // Detailed information
    if (detailed) {
      if (analysis.customCommands.length > 0) {
        console.log(chalk.bold('\n🔧 Custom Commands:'));
        analysis.customCommands.forEach(cmd => {
          console.log(`  • ${cmd}`);
        });
      }
      
      if (analysis.conflictingFiles.length > 0) {
        console.log(chalk.bold('\n📁 Conflicting Files:'));
        analysis.conflictingFiles.forEach(file => {
          console.log(`  • ${file}`);
        });
      }
      
      if (Object.keys(analysis.customConfigurations).length > 0) {
        console.log(chalk.bold('\n⚙️  Configurations:'));
        Object.entries(analysis.customConfigurations).forEach(([file, config]) => {
          console.log(`  • ${file}: ${JSON.stringify(config, null, 2)}`);
        });
      }
    }
    
    console.log(chalk.gray('\n' + '─'.repeat(50)));
  }

  async saveAnalysis(analysis: MigrationAnalysis, outputPath: string): Promise<void> {
    await fs.writeJson(outputPath, analysis, { spaces: 2 });
  }
}