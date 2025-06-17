#!/usr/bin/env -S deno run --allow-all
/**
 * Advanced coverage analysis and reporting
 */

import { parseArgs } from "@std/cli";
import { exists } from "@std/fs";
import { ensureDir } from "@std/fs";
import { walk } from "@std/fs";

interface CoverageData {
  url: string;
  ranges: Array<{
    start: { line: number; col: number };
    end: { line: number; col: number };
  }>;
}

interface FileCoverage {
  path: string;
  totalLines: number;
  coveredLines: number;
  uncoveredLines: number[];
  coverage: number;
  functions: FunctionCoverage[];
}

interface FunctionCoverage {
  name: string;
  line: number;
  covered: boolean;
}

interface CoverageReport {
  timestamp: string;
  summary: {
    totalFiles: number;
    totalLines: number;
    coveredLines: number;
    coverage: number;
    thresholds: {
      statements: number;
      branches: number;
      functions: number;
      lines: number;
    };
    passed: boolean;
  };
  files: FileCoverage[];
  uncoveredFiles: string[];
}

class CoverageAnalyzer {
  private sourceDir: string;
  private coverageDir: string;
  private outputDir: string;
  private thresholds: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };

  constructor(options: {
    sourceDir: string;
    coverageDir: string;
    outputDir: string;
    thresholds: {
      statements: number;
      branches: number;
      functions: number;
      lines: number;
    };
  }) {
    this.sourceDir = options.sourceDir;
    this.coverageDir = options.coverageDir;
    this.outputDir = options.outputDir;
    this.thresholds = options.thresholds;
  }

  async generateReport(): Promise<CoverageReport> {
    console.log("📊 Analyzing coverage data...");

    await ensureDir(this.outputDir);

    // Load coverage data
    const coverageData = await this.loadCoverageData();
    
    // Get all source files
    const sourceFiles = await this.getSourceFiles();
    
    // Analyze each file
    const fileAnalysis = await this.analyzeFiles(sourceFiles, coverageData);
    
    // Find uncovered files
    const coveredFiles = new Set(coverageData.map(d => this.normalizePath(d.url)));
    const uncoveredFiles = sourceFiles.filter(file => !coveredFiles.has(file));

    // Calculate summary
    const summary = this.calculateSummary(fileAnalysis, uncoveredFiles.length);

    const report: CoverageReport = {
      timestamp: new Date().toISOString(),
      summary,
      files: fileAnalysis,
      uncoveredFiles,
    };

    // Generate various report formats
    await this.generateHTMLReport(report);
    await this.generateJSONReport(report);
    await this.generateTextReport(report);
    await this.generateBadges(report);

    return report;
  }

  private async loadCoverageData(): Promise<CoverageData[]> {
    const coverageFiles: CoverageData[] = [];

    if (!await exists(this.coverageDir)) {
      throw new Error(`Coverage directory not found: ${this.coverageDir}`);
    }

    for await (const entry of walk(this.coverageDir, { 
      exts: [".json"],
      includeDirs: false 
    })) {
      const content = await Deno.readTextFile(entry.path);
      const data = JSON.parse(content);
      
      if (data.url && data.ranges) {
        coverageFiles.push(data);
      }
    }

    return coverageFiles;
  }

  private async getSourceFiles(): Promise<string[]> {
    const files: string[] = [];

    for await (const entry of walk(this.sourceDir, {
      exts: [".ts"],
      includeDirs: false,
      skip: [/\.test\.ts$/, /test\.ts$/, /tests?\//]
    })) {
      // Normalize path
      const relativePath = entry.path.replace(Deno.cwd() + "/", "");
      files.push(relativePath);
    }

    return files;
  }

  private normalizePath(url: string): string {
    // Convert file:// URLs to relative paths
    if (url.startsWith("file://")) {
      url = url.replace("file://", "");
    }
    
    // Remove leading slash and make relative to cwd
    const cwd = Deno.cwd();
    if (url.startsWith(cwd)) {
      url = url.replace(cwd + "/", "");
    }
    
    return url;
  }

  private async analyzeFiles(sourceFiles: string[], coverageData: CoverageData[]): Promise<FileCoverage[]> {
    const analysis: FileCoverage[] = [];

    for (const file of sourceFiles) {
      const coverage = coverageData.find(d => this.normalizePath(d.url) === file);
      const fileAnalysis = await this.analyzeFile(file, coverage);
      analysis.push(fileAnalysis);
    }

    return analysis;
  }

  private async analyzeFile(filePath: string, coverage?: CoverageData): Promise<FileCoverage> {
    const content = await Deno.readTextFile(filePath);
    const lines = content.split('\n');
    const totalLines = lines.filter(line => line.trim() && !line.trim().startsWith('//')).length;

    if (!coverage) {
      return {
        path: filePath,
        totalLines,
        coveredLines: 0,
        uncoveredLines: Array.from({ length: totalLines }, (_, i) => i + 1),
        coverage: 0,
        functions: this.extractFunctions(content, false),
      };
    }

    // Analyze covered lines
    const coveredLines = new Set<number>();
    
    for (const range of coverage.ranges) {
      for (let line = range.start.line; line <= range.end.line; line++) {
        coveredLines.add(line);
      }
    }

    const uncoveredLines: number[] = [];
    for (let i = 1; i <= lines.length; i++) {
      const line = lines[i - 1].trim();
      if (line && !line.startsWith('//') && !coveredLines.has(i)) {
        uncoveredLines.push(i);
      }
    }

    const coveragePercent = totalLines > 0 ? ((totalLines - uncoveredLines.length) / totalLines) * 100 : 100;

    return {
      path: filePath,
      totalLines,
      coveredLines: totalLines - uncoveredLines.length,
      uncoveredLines,
      coverage: coveragePercent,
      functions: this.extractFunctions(content, true, coveredLines),
    };
  }

  private extractFunctions(content: string, checkCoverage: boolean, coveredLines?: Set<number>): FunctionCoverage[] {
    const functions: FunctionCoverage[] = [];
    const lines = content.split('\n');

    // Simple regex patterns for TypeScript functions
    const patterns = [
      /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
      /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
      /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\(/,
      /^\s*(\w+)\s*:\s*\([^)]*\)\s*=>/,
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const functionName = match[1];
          const lineNumber = i + 1;
          const covered = checkCoverage ? (coveredLines?.has(lineNumber) ?? false) : false;
          
          functions.push({
            name: functionName,
            line: lineNumber,
            covered,
          });
          break;
        }
      }
    }

    return functions;
  }

  private calculateSummary(files: FileCoverage[], uncoveredFileCount: number): CoverageReport['summary'] {
    const totalFiles = files.length + uncoveredFileCount;
    const totalLines = files.reduce((sum, file) => sum + file.totalLines, 0);
    const coveredLines = files.reduce((sum, file) => sum + file.coveredLines, 0);
    const coverage = totalLines > 0 ? (coveredLines / totalLines) * 100 : 100;

    const passed = coverage >= this.thresholds.lines;

    return {
      totalFiles,
      totalLines,
      coveredLines,
      coverage,
      thresholds: this.thresholds,
      passed,
    };
  }

  private async generateHTMLReport(report: CoverageReport): Promise<void> {
    const fileRows = report.files
      .sort((a, b) => a.coverage - b.coverage)
      .map(file => {
        const coverageClass = file.coverage >= 80 ? 'high' : file.coverage >= 60 ? 'medium' : 'low';
        const coverageBar = `<div class="coverage-bar"><div class="coverage-fill ${coverageClass}" style="width: ${file.coverage}%"></div></div>`;
        
        return `
          <tr class="${coverageClass}">
            <td><a href="#file-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}">${file.path}</a></td>
            <td>${file.coverage.toFixed(2)}%</td>
            <td>${coverageBar}</td>
            <td>${file.coveredLines}/${file.totalLines}</td>
            <td>${file.uncoveredLines.length}</td>
            <td>${file.functions.filter(f => f.covered).length}/${file.functions.length}</td>
          </tr>`;
      }).join('');

    const uncoveredRows = report.uncoveredFiles.map(file => `
      <tr class="uncovered">
        <td>${file}</td>
        <td>0%</td>
        <td><div class="coverage-bar"><div class="coverage-fill low" style="width: 0%"></div></div></td>
        <td>0/0</td>
        <td>-</td>
        <td>0/0</td>
      </tr>
    `).join('');

    const fileDetails = report.files.map(file => {
      const uncoveredLinesStr = file.uncoveredLines.length > 0
        ? file.uncoveredLines.slice(0, 20).join(', ') + (file.uncoveredLines.length > 20 ? '...' : '')
        : 'All lines covered';

      const functionRows = file.functions.map(func => `
        <tr class="${func.covered ? 'covered' : 'uncovered'}">
          <td>${func.name}</td>
          <td>${func.line}</td>
          <td>${func.covered ? '✅' : '❌'}</td>
        </tr>
      `).join('');

      return `
        <div class="file-detail" id="file-${file.path.replace(/[^a-zA-Z0-9]/g, '-')}">
          <h3>📄 ${file.path}</h3>
          <div class="file-summary">
            <div class="metric">
              <span class="label">Coverage:</span>
              <span class="value ${file.coverage >= 80 ? 'high' : file.coverage >= 60 ? 'medium' : 'low'}">${file.coverage.toFixed(2)}%</span>
            </div>
            <div class="metric">
              <span class="label">Lines:</span>
              <span class="value">${file.coveredLines}/${file.totalLines}</span>
            </div>
            <div class="metric">
              <span class="label">Functions:</span>
              <span class="value">${file.functions.filter(f => f.covered).length}/${file.functions.length}</span>
            </div>
          </div>
          
          ${file.uncoveredLines.length > 0 ? `
            <div class="uncovered-lines">
              <h4>Uncovered Lines:</h4>
              <p>${uncoveredLinesStr}</p>
            </div>
          ` : ''}
          
          ${file.functions.length > 0 ? `
            <div class="functions">
              <h4>Functions:</h4>
              <table>
                <thead>
                  <tr>
                    <th>Function</th>
                    <th>Line</th>
                    <th>Covered</th>
                  </tr>
                </thead>
                <tbody>
                  ${functionRows}
                </tbody>
              </table>
            </div>
          ` : ''}
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Claude-Flow Coverage Report</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f8f9fa; }
        .header { background: white; padding: 30px; border-radius: 8px; margin-bottom: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .header h1 { margin: 0; color: #2c3e50; }
        .header .timestamp { color: #7f8c8d; margin-top: 5px; }
        
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .summary-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
        .summary-card h3 { margin: 0 0 10px 0; color: #2c3e50; font-size: 14px; text-transform: uppercase; }
        .summary-card .value { font-size: 32px; font-weight: bold; margin: 10px 0; }
        .summary-card .value.high { color: #27ae60; }
        .summary-card .value.medium { color: #f39c12; }
        .summary-card .value.low { color: #e74c3c; }
        .summary-card .threshold { font-size: 12px; color: #7f8c8d; }
        
        .coverage-status { padding: 15px; border-radius: 8px; margin-bottom: 30px; text-align: center; font-weight: bold; }
        .coverage-status.passed { background: #d4edda; color: #155724; }
        .coverage-status.failed { background: #f8d7da; color: #721c24; }
        
        .files-table { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 30px; }
        .files-table h2 { margin: 0; padding: 20px; background: #2c3e50; color: white; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ecf0f1; }
        th { background: #f8f9fa; font-weight: 600; }
        
        .coverage-bar { width: 100px; height: 20px; background: #ecf0f1; border-radius: 10px; overflow: hidden; }
        .coverage-fill { height: 100%; transition: width 0.3s ease; }
        .coverage-fill.high { background: linear-gradient(90deg, #27ae60, #2ecc71); }
        .coverage-fill.medium { background: linear-gradient(90deg, #f39c12, #e67e22); }
        .coverage-fill.low { background: linear-gradient(90deg, #e74c3c, #c0392b); }
        
        .high { background-color: rgba(39, 174, 96, 0.1); }
        .medium { background-color: rgba(243, 156, 18, 0.1); }
        .low { background-color: rgba(231, 76, 60, 0.1); }
        .uncovered { background-color: rgba(231, 76, 60, 0.2); }
        
        .file-detail { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .file-detail h3 { margin: 0 0 15px 0; color: #2c3e50; }
        .file-summary { display: flex; gap: 20px; margin-bottom: 20px; }
        .metric { display: flex; flex-direction: column; }
        .metric .label { font-size: 12px; color: #7f8c8d; text-transform: uppercase; }
        .metric .value { font-size: 18px; font-weight: bold; margin-top: 5px; }
        
        .uncovered-lines { margin: 15px 0; }
        .uncovered-lines h4 { margin: 0 0 10px 0; color: #e74c3c; }
        .functions { margin: 15px 0; }
        .functions h4 { margin: 0 0 10px 0; color: #2c3e50; }
        .functions table { margin-top: 10px; }
        .covered { background-color: rgba(39, 174, 96, 0.1); }
        
        .footer { text-align: center; margin-top: 40px; color: #7f8c8d; }
    </style>
</head>
<body>
    <div class="header">
        <h1>📊 Claude-Flow Coverage Report</h1>
        <div class="timestamp">Generated: ${report.timestamp}</div>
    </div>
    
    <div class="coverage-status ${report.summary.passed ? 'passed' : 'failed'}">
        ${report.summary.passed ? '✅ Coverage thresholds passed' : '❌ Coverage thresholds not met'}
    </div>
    
    <div class="summary">
        <div class="summary-card">
            <h3>Overall Coverage</h3>
            <div class="value ${report.summary.coverage >= 80 ? 'high' : report.summary.coverage >= 60 ? 'medium' : 'low'}">${report.summary.coverage.toFixed(2)}%</div>
            <div class="threshold">Threshold: ${this.thresholds.lines}%</div>
        </div>
        <div class="summary-card">
            <h3>Total Files</h3>
            <div class="value">${report.summary.totalFiles}</div>
        </div>
        <div class="summary-card">
            <h3>Covered Lines</h3>
            <div class="value">${report.summary.coveredLines}</div>
            <div class="threshold">of ${report.summary.totalLines}</div>
        </div>
        <div class="summary-card">
            <h3>Uncovered Files</h3>
            <div class="value ${report.uncoveredFiles.length === 0 ? 'high' : 'low'}">${report.uncoveredFiles.length}</div>
        </div>
    </div>
    
    <div class="files-table">
        <h2>📁 File Coverage</h2>
        <table>
            <thead>
                <tr>
                    <th>File</th>
                    <th>Coverage</th>
                    <th>Progress</th>
                    <th>Lines</th>
                    <th>Uncovered</th>
                    <th>Functions</th>
                </tr>
            </thead>
            <tbody>
                ${fileRows}
                ${uncoveredRows}
            </tbody>
        </table>
    </div>
    
    <div class="file-details">
        <h2>📄 File Details</h2>
        ${fileDetails}
    </div>
    
    <div class="footer">
        <p>Claude-Flow Coverage Report - Advanced AI Agent Orchestration System</p>
    </div>
</body>
</html>`;

    await Deno.writeTextFile(`${this.outputDir}/coverage-detailed.html`, html);
    console.log("  ✅ Detailed HTML coverage report generated");
  }

  private async generateJSONReport(report: CoverageReport): Promise<void> {
    await Deno.writeTextFile(
      `${this.outputDir}/coverage-report.json`,
      JSON.stringify(report, null, 2)
    );
    console.log("  ✅ JSON coverage report generated");
  }

  private async generateTextReport(report: CoverageReport): Promise<void> {
    const lines: string[] = [];
    
    lines.push("📊 CLAUDE-FLOW COVERAGE REPORT");
    lines.push("=".repeat(50));
    lines.push(`Generated: ${report.timestamp}`);
    lines.push("");
    
    lines.push("📈 SUMMARY");
    lines.push("-".repeat(20));
    lines.push(`Overall Coverage: ${report.summary.coverage.toFixed(2)}%`);
    lines.push(`Total Files: ${report.summary.totalFiles}`);
    lines.push(`Covered Lines: ${report.summary.coveredLines}/${report.summary.totalLines}`);
    lines.push(`Uncovered Files: ${report.uncoveredFiles.length}`);
    lines.push("");
    
    lines.push("🎯 THRESHOLDS");
    lines.push("-".repeat(20));
    lines.push(`Lines: ${report.summary.coverage.toFixed(2)}% (threshold: ${report.summary.thresholds.lines}%)`);
    lines.push(`Status: ${report.summary.passed ? '✅ PASSED' : '❌ FAILED'}`);
    lines.push("");
    
    if (report.files.length > 0) {
      lines.push("📁 FILES BY COVERAGE");
      lines.push("-".repeat(20));
      
      const sortedFiles = [...report.files].sort((a, b) => a.coverage - b.coverage);
      
      for (const file of sortedFiles) {
        const status = file.coverage >= 80 ? '✅' : file.coverage >= 60 ? '⚠️' : '❌';
        lines.push(`${status} ${file.path}: ${file.coverage.toFixed(2)}% (${file.coveredLines}/${file.totalLines} lines)`);
        
        if (file.uncoveredLines.length > 0 && file.uncoveredLines.length <= 10) {
          lines.push(`   Uncovered lines: ${file.uncoveredLines.join(', ')}`);
        } else if (file.uncoveredLines.length > 10) {
          lines.push(`   Uncovered lines: ${file.uncoveredLines.slice(0, 10).join(', ')}... (+${file.uncoveredLines.length - 10} more)`);
        }
      }
      lines.push("");
    }
    
    if (report.uncoveredFiles.length > 0) {
      lines.push("🚫 UNCOVERED FILES");
      lines.push("-".repeat(20));
      for (const file of report.uncoveredFiles) {
        lines.push(`❌ ${file}`);
      }
      lines.push("");
    }
    
    lines.push("💡 RECOMMENDATIONS");
    lines.push("-".repeat(20));
    
    const lowCoverageFiles = report.files.filter(f => f.coverage < 60);
    if (lowCoverageFiles.length > 0) {
      lines.push("• Focus on improving coverage for these files:");
      for (const file of lowCoverageFiles.slice(0, 5)) {
        lines.push(`  - ${file.path} (${file.coverage.toFixed(2)}%)`);
      }
    }
    
    if (report.uncoveredFiles.length > 0) {
      lines.push("• Add tests for uncovered files:");
      for (const file of report.uncoveredFiles.slice(0, 5)) {
        lines.push(`  - ${file}`);
      }
    }
    
    if (report.summary.coverage >= 90) {
      lines.push("• Excellent coverage! Consider adding edge case tests.");
    } else if (report.summary.coverage >= 80) {
      lines.push("• Good coverage! Focus on critical paths and error handling.");
    } else {
      lines.push("• Coverage needs improvement. Add tests for core functionality first.");
    }

    await Deno.writeTextFile(`${this.outputDir}/coverage-report.txt`, lines.join('\n'));
    console.log("  ✅ Text coverage report generated");
  }

  private async generateBadges(report: CoverageReport): Promise<void> {
    const coverage = report.summary.coverage;
    const color = coverage >= 90 ? 'brightgreen' :
                 coverage >= 80 ? 'green' :
                 coverage >= 70 ? 'yellow' :
                 coverage >= 60 ? 'orange' : 'red';
    
    const badgeUrl = `https://img.shields.io/badge/coverage-${coverage.toFixed(1)}%25-${color}`;
    
    const badgeMarkdown = `![Coverage](${badgeUrl})`;
    const badgeHTML = `<img src="${badgeUrl}" alt="Coverage ${coverage.toFixed(1)}%">`;
    
    const badges = {
      url: badgeUrl,
      markdown: badgeMarkdown,
      html: badgeHTML,
      coverage: coverage.toFixed(1),
      color,
      status: report.summary.passed ? 'passed' : 'failed',
    };
    
    await Deno.writeTextFile(
      `${this.outputDir}/coverage-badges.json`,
      JSON.stringify(badges, null, 2)
    );
    
    console.log("  ✅ Coverage badges generated");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["source-dir", "coverage-dir", "output-dir"],
    boolean: ["help"],
    default: {
      "source-dir": "./src",
      "coverage-dir": "./test-results/coverage",
      "output-dir": "./test-results",
    },
    alias: {
      h: "help",
      s: "source-dir",
      c: "coverage-dir",
      o: "output-dir",
    },
  });

  if (args.help) {
    console.log(`
📊 Claude-Flow Coverage Analysis Tool

USAGE:
  coverage-report.ts [OPTIONS]

OPTIONS:
  --source-dir, -s     Source code directory (default: ./src)
  --coverage-dir, -c   Coverage data directory (default: ./test-results/coverage)
  --output-dir, -o     Output directory for reports (default: ./test-results)
  --help, -h           Show this help

EXAMPLES:
  # Generate coverage report with defaults
  ./scripts/coverage-report.ts

  # Custom directories
  ./scripts/coverage-report.ts --source-dir ./lib --coverage-dir ./coverage --output-dir ./reports
`);
    return;
  }

  const thresholds = {
    statements: 80,
    branches: 75,
    functions: 80,
    lines: 80,
  };

  const analyzer = new CoverageAnalyzer({
    sourceDir: args["source-dir"],
    coverageDir: args["coverage-dir"],
    outputDir: args["output-dir"],
    thresholds,
  });

  try {
    const report = await analyzer.generateReport();
    
    console.log("\n📊 COVERAGE SUMMARY");
    console.log("=".repeat(40));
    console.log(`Overall Coverage: ${report.summary.coverage.toFixed(2)}%`);
    console.log(`Total Files: ${report.summary.totalFiles}`);
    console.log(`Covered Lines: ${report.summary.coveredLines}/${report.summary.totalLines}`);
    console.log(`Uncovered Files: ${report.uncoveredFiles.length}`);
    
    const status = report.summary.passed ? "✅ PASSED" : "❌ FAILED";
    console.log(`Status: ${status}`);
    
    console.log(`\n📄 Reports generated in: ${args["output-dir"]}`);
    console.log(`  - Detailed HTML: coverage-detailed.html`);
    console.log(`  - JSON Data: coverage-report.json`);
    console.log(`  - Text Summary: coverage-report.txt`);
    console.log(`  - Badges: coverage-badges.json`);
    
    Deno.exit(report.summary.passed ? 0 : 1);
    
  } catch (error) {
    console.error("❌ Coverage analysis failed:", error.message);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}