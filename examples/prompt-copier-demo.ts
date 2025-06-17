#!/usr/bin/env -S deno run --allow-all

/**
 * Prompt Copier Demo
 * 
 * This demo showcases the robust prompt copying mechanism capabilities:
 * - Basic copying functionality
 * - Enhanced parallel processing
 * - Configuration management
 * - Validation and reporting
 * - Error handling and recovery
 */

import { copyPrompts, copyPromptsEnhanced } from '../src/swarm/prompt-copier-enhanced.ts';
import { PromptManager } from '../src/swarm/prompt-manager.ts';
import { PromptConfigManager, PromptValidator, createProgressBar } from '../src/swarm/prompt-utils.ts';
import * as path from '@std/path';
import { ensureDir } from '@std/fs';

async function createDemoData() {
  console.log('🔧 Setting up demo data...');
  
  const demoDir = './demo-prompt-copying';
  const sourceDir = path.join(demoDir, 'source');
  const destDir = path.join(demoDir, 'destination');
  
  await ensureDir(sourceDir);
  await ensureDir(destDir);
  
  // Create sample prompt files
  const prompts = [
    {
      path: 'sparc/architect.md',
      content: `# SPARC Architect Mode

You are an expert system architect focused on designing robust, scalable systems.

## Your Role
- Design system architecture and component relationships
- Create clear architectural documentation
- Consider scalability, performance, and maintainability
- Define interfaces and data flows

## Guidelines
- Think modularly and maintain separation of concerns
- Consider both current and future requirements
- Document architectural decisions and trade-offs
- Plan for testing and deployment strategies
`
    },
    {
      path: 'sparc/tdd.md',
      content: `# SPARC Test-Driven Development Mode

You are a TDD expert focused on writing tests first and implementing clean, testable code.

## Your Process
1. **Red**: Write failing tests first
2. **Green**: Implement minimal code to pass tests  
3. **Refactor**: Clean up and optimize code
4. **Repeat**: Continue until feature is complete

## Best Practices
- Write descriptive test names
- Test edge cases and error conditions
- Keep tests isolated and independent
- Maintain high test coverage
`
    },
    {
      path: 'sparc/code.md',
      content: `# SPARC Code Implementation Mode

You are a senior developer focused on writing clean, maintainable, and efficient code.

## Coding Standards
- Follow established patterns and conventions
- Write self-documenting code with clear names
- Handle errors gracefully
- Optimize for readability first, performance second

## Implementation Guidelines
- Break complex problems into smaller functions
- Use appropriate data structures and algorithms
- Add comments for complex logic
- Consider security implications
`
    },
    {
      path: 'templates/api-template.md',
      content: `# API Template

## Endpoint: {{endpoint}}
**Method**: {{method}}
**Description**: {{description}}

### Request
\`\`\`json
{{request_example}}
\`\`\`

### Response
\`\`\`json
{{response_example}}
\`\`\`

### Error Handling
- 400: Bad Request
- 401: Unauthorized
- 404: Not Found
- 500: Internal Server Error
`
    },
    {
      path: 'rules/general-rules.md',
      content: `# General Development Rules

## Code Quality
- Always write tests before implementation
- Follow DRY (Don't Repeat Yourself) principle
- Use meaningful variable and function names
- Keep functions small and focused

## Security
- Never hardcode secrets or credentials
- Validate all user inputs
- Use secure communication protocols
- Implement proper authentication and authorization

## Performance
- Profile before optimizing
- Cache expensive operations
- Use appropriate data structures
- Monitor resource usage
`
    },
    {
      path: 'large-prompt.md',
      content: '# Large Prompt\n' + 'This is a large prompt file.\n'.repeat(1000)
    },
    {
      path: 'empty.md',
      content: ''
    }
  ];
  
  for (const prompt of prompts) {
    const filePath = path.join(sourceDir, prompt.path);
    const dir = path.dirname(filePath);
    
    await ensureDir(dir);
    await Deno.writeTextFile(filePath, prompt.content);
  }
  
  console.log('✅ Demo data created');
  return { sourceDir, destDir, demoDir };
}

async function demonstrateBasicCopying(sourceDir: string, destDir: string) {
  console.log('\n📋 Demo 1: Basic Copying');
  console.log('========================');
  
  const basicDestDir = path.join(destDir, 'basic');
  await ensureDir(basicDestDir);
  
  try {
    const result = await copyPrompts({
      source: sourceDir,
      destination: basicDestDir,
      backup: true,
      verify: true,
      conflictResolution: 'backup'
    });
    
    console.log(`✅ Basic copy completed`);
    console.log(`   Files copied: ${result.copiedFiles}`);
    console.log(`   Duration: ${result.duration}ms`);
    console.log(`   Success: ${result.success}`);
    
    if (result.errors.length > 0) {
      console.log('   Errors:');
      result.errors.forEach(error => {
        console.log(`     - ${error.file}: ${error.error}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Basic copying failed:', error.message);
  }
}

async function demonstrateEnhancedCopying(sourceDir: string, destDir: string) {
  console.log('\n⚡ Demo 2: Enhanced Parallel Copying');
  console.log('==================================');
  
  const enhancedDestDir = path.join(destDir, 'enhanced');
  await ensureDir(enhancedDestDir);
  
  try {
    let progress: any = null;
    
    const result = await copyPromptsEnhanced({
      source: sourceDir,
      destination: enhancedDestDir,
      parallel: true,
      maxWorkers: 4,
      verify: true,
      progressCallback: (prog) => {
        if (!progress) {
          progress = createProgressBar(prog.total);
          console.log('Progress:');
        }
        progress.update(prog.completed);
        
        if (prog.completed === prog.total) {
          progress.complete();
        }
      }
    });
    
    console.log(`✅ Enhanced copy completed`);
    console.log(`   Files copied: ${result.copiedFiles}`);
    console.log(`   Duration: ${result.duration}ms`);
    console.log(`   Workers used: 4`);
    console.log(`   Success: ${result.success}`);
    
  } catch (error) {
    console.error('❌ Enhanced copying failed:', error.message);
  }
}

async function demonstrateValidation(sourceDir: string) {
  console.log('\n🔍 Demo 3: File Validation');
  console.log('========================');
  
  try {
    // Find all prompt files
    const files: string[] = [];
    
    async function scanDir(dir: string) {
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isFile && (entry.name.endsWith('.md') || entry.name.endsWith('.txt'))) {
          files.push(fullPath);
        } else if (entry.isDirectory) {
          await scanDir(fullPath);
        }
      }
    }
    
    await scanDir(sourceDir);
    
    console.log(`Found ${files.length} prompt files to validate`);
    
    let validFiles = 0;
    let invalidFiles = 0;
    
    for (const file of files) {
      const result = await PromptValidator.validatePromptFile(file);
      
      if (result.valid) {
        validFiles++;
        console.log(`✅ ${path.basename(file)}`);
      } else {
        invalidFiles++;
        console.log(`❌ ${path.basename(file)}`);
        result.issues.forEach(issue => {
          console.log(`   - ${issue}`);
        });
      }
      
      if (result.metadata && Object.keys(result.metadata).length > 0) {
        console.log(`   Metadata: ${JSON.stringify(result.metadata)}`);
      }
    }
    
    console.log(`\nValidation Summary:`);
    console.log(`   Valid: ${validFiles}`);
    console.log(`   Invalid: ${invalidFiles}`);
    console.log(`   Total: ${files.length}`);
    
  } catch (error) {
    console.error('❌ Validation failed:', error.message);
  }
}

async function demonstrateConfigManagement(demoDir: string) {
  console.log('\n⚙️  Demo 4: Configuration Management');
  console.log('==================================');
  
  try {
    const configPath = path.join(demoDir, '.prompt-config.json');
    const manager = new PromptConfigManager(configPath);
    
    // Initialize with custom config
    await manager.saveConfig({
      destinationDirectory: './custom-prompts',
      defaultOptions: {
        backup: true,
        verify: true,
        parallel: true,
        maxWorkers: 6,
        conflictResolution: 'backup'
      },
      profiles: {
        demo: {
          includePatterns: ['*.md'],
          excludePatterns: ['**/temp/**'],
          maxWorkers: 2
        }
      }
    });
    
    console.log('✅ Configuration saved');
    
    // Load and display config
    const config = await manager.loadConfig();
    console.log('Current configuration:');
    console.log(JSON.stringify(config, null, 2));
    
    // Show available profiles
    const profiles = manager.listProfiles();
    console.log(`\nAvailable profiles: ${profiles.join(', ')}`);
    
    // Get specific profile
    const demoProfile = manager.getProfile('demo');
    console.log('\nDemo profile settings:');
    console.log(JSON.stringify(demoProfile, null, 2));
    
  } catch (error) {
    console.error('❌ Configuration management failed:', error.message);
  }
}

async function demonstratePromptManager(sourceDir: string, destDir: string, demoDir: string) {
  console.log('\n🎯 Demo 5: Prompt Manager');
  console.log('========================');
  
  try {
    const managerDestDir = path.join(destDir, 'manager');
    await ensureDir(managerDestDir);
    
    const manager = new PromptManager({
      basePath: demoDir,
      defaultProfile: 'sparc',
      autoDiscovery: true
    });
    
    // Initialize manager
    await manager.initialize();
    console.log('✅ Manager initialized');
    
    // Update config to use our demo directories
    await manager.updateConfig({
      sourceDirectories: [path.relative(demoDir, sourceDir)],
      destinationDirectory: path.relative(demoDir, managerDestDir)
    });
    
    // Copy prompts using manager
    const result = await manager.copyPrompts({
      verify: true,
      progressCallback: (progress) => {
        if (progress.percentage % 25 === 0 || progress.completed === progress.total) {
          console.log(`   Progress: ${progress.percentage}% (${progress.completed}/${progress.total})`);
        }
      }
    });
    
    console.log('✅ Manager copy completed');
    console.log(`   Files copied: ${result.copiedFiles}`);
    console.log(`   Duration: ${result.duration}ms`);
    
    // Validate prompts
    const validation = await manager.validatePrompts();
    console.log('\nValidation Results:');
    console.log(`   Total files: ${validation.totalFiles}`);
    console.log(`   Valid files: ${validation.validFiles}`);
    console.log(`   Invalid files: ${validation.invalidFiles}`);
    
    // Generate report
    const report = await manager.generateReport();
    console.log('\nSystem Report:');
    console.log(`   Source directories: ${report.sources.length}`);
    report.sources.forEach(source => {
      console.log(`     - ${source.path}: ${source.exists ? 'exists' : 'missing'}`);
      if (source.fileCount !== undefined) {
        console.log(`       Files: ${source.fileCount}, Size: ${Math.round(source.totalSize! / 1024)}KB`);
      }
    });
    
  } catch (error) {
    console.error('❌ Prompt manager demo failed:', error.message);
  }
}

async function demonstrateConflictResolution(sourceDir: string, destDir: string) {
  console.log('\n🔄 Demo 6: Conflict Resolution');
  console.log('=============================');
  
  const conflictDestDir = path.join(destDir, 'conflicts');
  await ensureDir(conflictDestDir);
  
  try {
    // First copy to establish baseline
    await copyPrompts({
      source: sourceDir,
      destination: conflictDestDir,
      conflictResolution: 'overwrite'
    });
    
    // Modify a file to create conflict
    const testFile = path.join(conflictDestDir, 'sparc', 'architect.md');
    await Deno.writeTextFile(testFile, '# Modified Content\nThis file was modified.');
    
    console.log('Created conflict by modifying architect.md');
    
    // Test different conflict resolution strategies
    const strategies = ['skip', 'backup', 'merge', 'overwrite'] as const;
    
    for (const strategy of strategies) {
      console.log(`\nTesting ${strategy} strategy:`);
      
      const strategyDestDir = path.join(conflictDestDir, strategy);
      await ensureDir(strategyDestDir);
      
      // Copy existing file to create conflict
      await Deno.copyFile(testFile, path.join(strategyDestDir, 'architect.md'));
      
      const result = await copyPrompts({
        source: path.join(sourceDir, 'sparc'),
        destination: strategyDestDir,
        conflictResolution: strategy
      });
      
      console.log(`   Result: ${result.success ? 'Success' : 'Failed'}`);
      console.log(`   Copied: ${result.copiedFiles}, Skipped: ${result.skippedFiles}`);
      
      if (result.backupLocation) {
        console.log(`   Backup created: ${path.basename(result.backupLocation)}`);
      }
      
      // Check final content
      try {
        const finalContent = await Deno.readTextFile(path.join(strategyDestDir, 'architect.md'));
        const isOriginal = finalContent.includes('expert system architect');
        const isModified = finalContent.includes('Modified Content');
        
        if (strategy === 'skip') {
          console.log(`   Content: ${isModified ? 'Modified (skipped)' : 'Original'}`);
        } else if (strategy === 'merge') {
          console.log(`   Content: ${isOriginal && isModified ? 'Merged' : 'Single version'}`);
        } else {
          console.log(`   Content: ${isOriginal ? 'Original (overwritten)' : 'Modified'}`);
        }
      } catch {
        console.log('   Content: File not found');
      }
    }
    
  } catch (error) {
    console.error('❌ Conflict resolution demo failed:', error.message);
  }
}

async function cleanup(demoDir: string) {
  console.log('\n🧹 Cleaning up demo data...');
  
  try {
    await Deno.remove(demoDir, { recursive: true });
    console.log('✅ Cleanup completed');
  } catch (error) {
    console.warn('⚠️  Cleanup failed:', error.message);
  }
}

async function main() {
  console.log('🚀 Prompt Copier Demo');
  console.log('====================');
  console.log('This demo showcases the robust prompt copying mechanism capabilities.\n');
  
  try {
    // Setup demo data
    const { sourceDir, destDir, demoDir } = await createDemoData();
    
    // Run all demonstrations
    await demonstrateBasicCopying(sourceDir, destDir);
    await demonstrateEnhancedCopying(sourceDir, destDir);
    await demonstrateValidation(sourceDir);
    await demonstrateConfigManagement(demoDir);
    await demonstratePromptManager(sourceDir, destDir, demoDir);
    await demonstrateConflictResolution(sourceDir, destDir);
    
    console.log('\n🎉 All demos completed successfully!');
    console.log('\nDemo Features Showcased:');
    console.log('✅ Basic file copying with verification');
    console.log('✅ Enhanced parallel processing with worker threads');
    console.log('✅ File validation and quality checking');
    console.log('✅ Configuration management with profiles');
    console.log('✅ High-level prompt manager interface');
    console.log('✅ Intelligent conflict resolution strategies');
    
    // Cleanup
    const shouldCleanup = confirm('\nClean up demo files?');
    if (shouldCleanup) {
      await cleanup(demoDir);
    } else {
      console.log(`Demo files preserved in: ${demoDir}`);
    }
    
  } catch (error) {
    console.error('\n❌ Demo failed:', error.message);
    console.error(error.stack);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}