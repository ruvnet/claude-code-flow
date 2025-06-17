#!/usr/bin/env deno run --allow-net --allow-read

/**
 * Documentation Link Checker
 * Scans documentation files for broken links
 */

import { walk } from "@std/fs";

interface LinkCheckResult {
  file: string;
  url: string;
  status: 'ok' | 'broken' | 'timeout' | 'error';
  statusCode?: number;
  error?: string;
}

interface ScanResult {
  totalFiles: number;
  totalLinks: number;
  brokenLinks: LinkCheckResult[];
  timeouts: LinkCheckResult[];
  errors: LinkCheckResult[];
}

const TIMEOUT_MS = 10000; // 10 seconds
const USER_AGENT = 'Claude-Flow Link Checker';
const MAX_CONCURRENT = 10;

// Links to skip (known to have issues with automated checking)
const SKIP_URLS = new Set([
  'mailto:',
  'tel:',
  'javascript:',
  '#',
  'localhost',
  '127.0.0.1',
  'example.com',
  'example.org',
]);

function extractLinks(content: string): string[] {
  const links: string[] = [];
  
  // Markdown links: [text](url)
  const markdownLinkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    links.push(match[2]);
  }
  
  // HTML links: <a href="url">
  const htmlLinkRegex = /<a[^>]+href\s*=\s*['""]([^'""]+)['""][^>]*>/gi;
  while ((match = htmlLinkRegex.exec(content)) !== null) {
    links.push(match[1]);
  }
  
  // URL references: [ref]: url
  const refLinkRegex = /^\s*\[([^\]]+)\]:\s*(.+)$/gm;
  while ((match = refLinkRegex.exec(content)) !== null) {
    links.push(match[2]);
  }
  
  return links;
}

function shouldSkipUrl(url: string): boolean {
  // Skip relative links
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return true;
  }
  
  // Skip specific patterns
  for (const skipPattern of SKIP_URLS) {
    if (url.includes(skipPattern)) {
      return true;
    }
  }
  
  return false;
}

async function checkLink(url: string): Promise<{ status: number | null; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    const response = await fetch(url, {
      method: 'HEAD', // Use HEAD to avoid downloading content
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
      },
    });
    
    clearTimeout(timeoutId);
    
    return {
      status: response.status,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { status: null, error: 'timeout' };
    }
    
    return {
      status: null,
      error: error.message,
    };
  }
}

async function scanFile(filePath: string): Promise<LinkCheckResult[]> {
  const results: LinkCheckResult[] = [];
  
  try {
    const content = await Deno.readTextFile(filePath);
    const links = extractLinks(content);
    
    // Remove duplicates and filter
    const uniqueLinks = [...new Set(links)].filter(url => !shouldSkipUrl(url));
    
    // Check links with concurrency control
    const semaphore = new Array(MAX_CONCURRENT).fill(0);
    const promises = uniqueLinks.map(async (url) => {
      // Wait for available slot
      await new Promise<void>((resolve) => {
        const checkSlot = () => {
          const index = semaphore.findIndex(slot => slot === 0);
          if (index !== -1) {
            semaphore[index] = 1;
            resolve();
          } else {
            setTimeout(checkSlot, 100);
          }
        };
        checkSlot();
      });
      
      try {
        const { status, error } = await checkLink(url);
        
        let resultStatus: LinkCheckResult['status'];
        if (error === 'timeout') {
          resultStatus = 'timeout';
        } else if (error) {
          resultStatus = 'error';
        } else if (status && status >= 200 && status < 400) {
          resultStatus = 'ok';
        } else {
          resultStatus = 'broken';
        }
        
        return {
          file: filePath,
          url,
          status: resultStatus,
          statusCode: status || undefined,
          error,
        };
      } finally {
        // Release slot
        const index = semaphore.findIndex(slot => slot === 1);
        if (index !== -1) {
          semaphore[index] = 0;
        }
      }
    });
    
    results.push(...await Promise.all(promises));
  } catch (error) {
    console.warn(`Failed to scan ${filePath}: ${error.message}`);
  }
  
  return results;
}

async function main(): Promise<void> {
  console.log('Checking documentation links...\n');
  
  const results: LinkCheckResult[] = [];
  let fileCount = 0;
  
  // Scan markdown and HTML files
  const extensions = ['.md', '.html', '.htm'];
  const directories = ['./docs', './README.md', './examples'];
  
  for (const dir of directories) {
    try {
      const stat = await Deno.stat(dir);
      if (stat.isFile) {
        // Single file
        const fileResults = await scanFile(dir);
        results.push(...fileResults);
        fileCount++;
      } else if (stat.isDirectory) {
        // Directory
        for await (const entry of walk(dir, { exts: extensions })) {
          if (entry.isFile) {
            const fileResults = await scanFile(entry.path);
            results.push(...fileResults);
            fileCount++;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn(`Failed to process ${dir}: ${error.message}`);
      }
    }
  }
  
  // Analyze results
  const scanResult: ScanResult = {
    totalFiles: fileCount,
    totalLinks: results.length,
    brokenLinks: results.filter(r => r.status === 'broken'),
    timeouts: results.filter(r => r.status === 'timeout'),
    errors: results.filter(r => r.status === 'error'),
  };
  
  // Report results
  console.log(`📊 Scan Summary:`);
  console.log(`   Files scanned: ${scanResult.totalFiles}`);
  console.log(`   Links checked: ${scanResult.totalLinks}`);
  console.log(`   Broken links: ${scanResult.brokenLinks.length}`);
  console.log(`   Timeouts: ${scanResult.timeouts.length}`);
  console.log(`   Errors: ${scanResult.errors.length}\n`);
  
  // Report broken links
  if (scanResult.brokenLinks.length > 0) {
    console.log('❌ Broken Links:');
    for (const result of scanResult.brokenLinks) {
      console.log(`   ${result.file}: ${result.url} (${result.statusCode})`);
    }
    console.log('');
  }
  
  // Report timeouts
  if (scanResult.timeouts.length > 0) {
    console.log('⏱️  Timeouts:');
    for (const result of scanResult.timeouts) {
      console.log(`   ${result.file}: ${result.url}`);
    }
    console.log('');
  }
  
  // Report other errors
  if (scanResult.errors.length > 0) {
    console.log('⚠️  Errors:');
    for (const result of scanResult.errors) {
      console.log(`   ${result.file}: ${result.url} (${result.error})`);
    }
    console.log('');
  }
  
  // Summary
  const totalIssues = scanResult.brokenLinks.length + scanResult.timeouts.length + scanResult.errors.length;
  
  if (totalIssues === 0) {
    console.log('✅ All links are working!');
  } else {
    console.error(`❌ Found ${totalIssues} link issues!`);
    
    // Don't fail CI for timeouts or minor errors, only broken links
    if (scanResult.brokenLinks.length > 0) {
      Deno.exit(1);
    }
  }
}

if (import.meta.main) {
  await main();
}