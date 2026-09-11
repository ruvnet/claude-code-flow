import { describe, expect, it } from 'vitest';
import { scanSourceText } from '../src/security/source-code-scanner.js';

describe('security source scanner precision', () => {
  it('ignores comments, detector regex literals, and diagnostic templates', () => {
    const source = [
      '// Example only: sk-1234567890abcdef',
      'const evalDetector = /\\beval\\s*\\(/g;',
      'const reactDetector = /dangerouslySetInnerHTML/g;',
      'const message = `${dbPath} — better-sqlite3 failed to open: ${error}`;',
    ].join('\n');

    expect(scanSourceText(source, 'scanner.ts')).toEqual([]);
  });

  it('detects real secrets and executable injection sinks', () => {
    const source = [
      "import { exec } from 'node:child_process';",
      "const key = 'sk-1234567890abcdef';",
      'const value = eval(userInput);',
      'node.innerHTML = userHtml;',
      'exec(`tool ${userInput}`);',
      'db.query(`SELECT * FROM users WHERE id = ${id}`);',
    ].join('\n');
    const findings = scanSourceText(source, 'unsafe.ts');

    expect(findings.map((finding) => finding.type)).toEqual(expect.arrayContaining([
      'Hardcoded Secret', 'Eval Usage', 'innerHTML', 'Command Injection', 'SQL Injection',
    ]));
  });

  it('does not confuse database exec calls, parameterized SQL, or static process commands', () => {
    const source = [
      "import { exec } from 'node:child_process';",
      "db.query('SELECT * FROM users WHERE id = ?', [id]);",
      "execSync('npm audit --json');",
      'db.exec(`SELECT count(*) FROM ${trustedTable}`);',
    ].join('\n');
    const findings = scanSourceText(source, 'safe.ts');
    expect(findings.filter((finding) => finding.type === 'Command Injection')).toEqual([]);
    expect(findings.filter((finding) => finding.type === 'SQL Injection')).toHaveLength(1);
  });
});
