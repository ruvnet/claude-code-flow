#!/usr/bin/env -S deno run --allow-read --allow-write

/**
 * Script to automatically fix HTTPS imports in the codebase
 * Converts direct HTTPS URLs to import map aliases
 */

import { walk } from '@std/fs';
import { colors } from '@cliffy/ansi/colors';

// Mapping of HTTPS URLs to import aliases
const importMappings = {
  // Standard library - multiple versions to handle
  '@std/assert': '@std/assert',
  '@std/assert': '@std/assert',
  '@std/assert': '@std/assert',
  
  '@std/async': '@std/async',
  '@std/async': '@std/async',
  '@std/async': '@std/async',
  
  '@std/cli': '@std/cli',
  '@std/cli': '@std/cli',
  '@std/cli': '@std/cli',
  '@std/cli': '@std/cli',
  
  '@std/flags': '@std/flags',
  
  '@std/fmt': '@std/fmt',
  '@std/fmt': '@std/fmt',
  
  '@std/fs': '@std/fs',
  '@std/fs': '@std/fs',
  '@std/fs': '@std/fs',
  '@std/fs': '@std/fs',
  '@std/fs': '@std/fs',
  '@std/fs': '@std/fs',
  
  '@std/path': '@std/path',
  '@std/path': '@std/path',
  '@std/path': '@std/path',
  
  '@std/testing/bdd': '@std/testing/bdd',
  '@std/testing/bdd': '@std/testing/bdd',
  '@std/testing/bdd': '@std/testing/bdd',
  
  '@std/testing/mock': '@std/testing/mock',
  '@std/testing/mock': '@std/testing/mock',
  
  '@std/testing/time': '@std/testing/time',
  '@std/testing/time': '@std/testing/time',
  
  // SQLite
  '@sqlite': '@sqlite',
  
  // Cliffy - special case handling
  '@cliffy/ansi/colors': '@cliffy/ansi/colors',
};

// Additional mappings for named imports that need to be extracted
const namedImportMappings: Record<string, Record<string, string>> = {
  '@std/fs': {
    ensureDir: 'ensureDir',
    exists: 'exists',
    walk: 'walk',
  },
  '@std/path': {
    join: 'join',
    dirname: 'dirname',
  },
  '@std/cli': {
    parseArgs: 'parseArgs',
  },
  '@std/fmt': {
    colors: 'colors',
  },
  '@std/async': {
    delay: 'delay',
  },
};

interface ImportFix {
  file: string;
  line: number;
  original: string;
  fixed: string;
}

async function processFile(filePath: string): Promise<ImportFix[]> {
  const content = await Deno.readTextFile(filePath);
  const lines = content.split('\n');
  const fixes: ImportFix[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    // Skip if not an import statement
    if (!line.includes('import') || !line.includes('from')) {
      continue;
    }
    
    // Check each mapping
    for (const [httpsUrl, alias] of Object.entries(importMappings)) {
      if (line.includes(httpsUrl)) {
        let fixedLine = line;
        
        // Handle special cases where we need to adjust imports
        if (httpsUrl.includes('/fs/') && !httpsUrl.endsWith('/mod.ts')) {
          // Extract specific fs imports
          fixedLine = fixedLine.replace(httpsUrl, alias);
          // Add specific named import if needed
          const match = line.match(/import\s*{\s*([^}]+)\s*}\s*from/);
          if (match) {
            const importedItems = match[1].split(',').map(s => s.trim());
            // Check if we need to add the import from the main module
            fixedLine = fixedLine.replace(
              /from\s*['"]@std\/fs['"]/,
              `from '@std/fs'`
            );
          }
        } else if (httpsUrl.includes('/path/') && !httpsUrl.endsWith('/mod.ts')) {
          fixedLine = fixedLine.replace(httpsUrl, alias);
        } else if (httpsUrl.includes('/cli/') && !httpsUrl.endsWith('/mod.ts')) {
          fixedLine = fixedLine.replace(httpsUrl, alias);
        } else if (httpsUrl.includes('/fmt/') && !httpsUrl.endsWith('/mod.ts')) {
          fixedLine = fixedLine.replace(httpsUrl, alias);
        } else if (httpsUrl.includes('/async/') && !httpsUrl.endsWith('/mod.ts')) {
          fixedLine = fixedLine.replace(httpsUrl, alias);
        } else {
          // Simple replacement
          fixedLine = fixedLine.replace(httpsUrl, alias);
        }
        
        if (fixedLine !== line) {
          fixes.push({
            file: filePath,
            line: lineNumber,
            original: line,
            fixed: fixedLine,
          });
          lines[i] = fixedLine;
        }
      }
    }
  }
  
  // Write back if there were changes
  if (fixes.length > 0) {
    await Deno.writeTextFile(filePath, lines.join('\n'));
  }
  
  return fixes;
}

async function main() {
  console.log(colors.cyan.bold('🔧 Fixing HTTPS imports in TypeScript files...'));
  console.log();
  
  const allFixes: ImportFix[] = [];
  let filesProcessed = 0;
  let filesFixed = 0;
  
  // Walk through all TypeScript files
  for await (const entry of walk('.', {
    exts: ['.ts'],
    skip: [/node_modules/, /dist/, /bin/, /coverage/, /test-results/],
  })) {
    if (entry.isFile) {
      filesProcessed++;
      const fixes = await processFile(entry.path);
      if (fixes.length > 0) {
        filesFixed++;
        allFixes.push(...fixes);
      }
    }
  }
  
  // Display summary
  console.log(colors.green(`✅ Processed ${filesProcessed} files`));
  console.log(colors.green(`📝 Fixed imports in ${filesFixed} files`));
  console.log(colors.green(`🔄 Total fixes: ${allFixes.length}`));
  console.log();
  
  // Display detailed fixes
  if (allFixes.length > 0) {
    console.log(colors.yellow('📋 Import fixes applied:'));
    console.log();
    
    // Group by file
    const fixesByFile = new Map<string, ImportFix[]>();
    for (const fix of allFixes) {
      const fixes = fixesByFile.get(fix.file) || [];
      fixes.push(fix);
      fixesByFile.set(fix.file, fixes);
    }
    
    // Display fixes
    for (const [file, fixes] of fixesByFile) {
      console.log(colors.blue(`📁 ${file}:`));
      for (const fix of fixes) {
        console.log(colors.gray(`  Line ${fix.line}:`));
        console.log(colors.red(`    - ${fix.original.trim()}`));
        console.log(colors.green(`    + ${fix.fixed.trim()}`));
      }
      console.log();
    }
  }
  
  console.log(colors.cyan('💡 Next steps:'));
  console.log(colors.gray('  1. Run "deno fmt" to ensure consistent formatting'));
  console.log(colors.gray('  2. Run "deno check src/**/*.ts" to verify type checking'));
  console.log(colors.gray('  3. Run "deno test" to ensure all tests pass'));
  console.log();
  
  // Additional checks
  console.log(colors.yellow('⚠️  Note: Some imports may need manual adjustment:'));
  console.log(colors.gray('  - Imports using different std versions have been normalized to 0.224.0'));
  console.log(colors.gray('  - Named imports from submodules may need adjustment'));
  console.log(colors.gray('  - Check that all @std/ imports resolve correctly'));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(colors.red(`❌ Error: ${error.message}`));
    Deno.exit(1);
  });
}