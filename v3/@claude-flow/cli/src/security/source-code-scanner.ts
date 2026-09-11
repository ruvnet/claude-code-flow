export type SourceFinding = {
  severity: 'high' | 'medium';
  type: string;
  location: string;
  description: string;
};

type MaskMode = 'comments-and-regex' | 'non-code';

/**
 * Lightweight JS/TS lexical masking. It is intentionally not a parser, but it
 * understands comments, quoted/template strings and regex literals so scanner
 * signatures are applied to executable code rather than examples or the
 * scanner's own regex declarations.
 */
function maskSource(source: string, mode: MaskMode): string {
  let out = '';
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' | 'regex' = 'code';
  let escaped = false;
  let previousSignificant = '';

  const keepString = mode === 'comments-and-regex';
  const append = (char: string, keep: boolean) => { out += keep || char === '\n' ? char : ' '; };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1] ?? '';

    if (state === 'line-comment') {
      append(char, false);
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        append(char, false); append(next, false); i++; state = 'code';
      } else append(char, false);
      continue;
    }
    if (state !== 'code') {
      const preserve = keepString && state !== 'regex';
      append(char, preserve);
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((state === 'single' && char === "'") ||
          (state === 'double' && char === '"') ||
          (state === 'template' && char === '`')) state = 'code';
      else if (state === 'regex' && char === '/') state = 'code';
      continue;
    }

    if (char === '/' && next === '/') {
      append(char, false); append(next, false); i++; state = 'line-comment'; continue;
    }
    if (char === '/' && next === '*') {
      append(char, false); append(next, false); i++; state = 'block-comment'; continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      state = char === "'" ? 'single' : char === '"' ? 'double' : 'template';
      append(char, keepString);
      previousSignificant = char;
      continue;
    }
    // A slash after an operator/delimiter begins a regex literal; division
    // after an identifier or closing delimiter remains executable code.
    if (char === '/' && (!previousSignificant || /[=(:,!&|?{};\[]/.test(previousSignificant))) {
      state = 'regex'; append(char, false); continue;
    }

    append(char, true);
    if (!/\s/.test(char)) previousSignificant = char;
  }
  return out;
}

const SECRET_PATTERNS = [
  { pattern: /(?<![a-zA-Z0-9_])(?:sk-|sk_live_|sk_test_)[a-zA-Z0-9]{10,}(?![a-zA-Z0-9_])/g, description: 'API Key (Stripe/OpenAI)' },
  { pattern: /['"]AKIA[A-Z0-9]{16}['"]/g, description: 'AWS Access Key' },
  { pattern: /['"]ghp_[a-zA-Z0-9]{36}['"]/g, description: 'GitHub Token' },
  { pattern: /['"]xox[baprs]-[a-zA-Z0-9-]+['"]/g, description: 'Slack Token' },
  { pattern: /password\s*[:=]\s*['"][^'"]{8,}['"]/gi, description: 'Hardcoded Password' },
] as const;

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function collectMatches(
  source: string,
  relativePath: string,
  patterns: ReadonlyArray<{ pattern: RegExp; severity: 'high' | 'medium'; type: string; description: string }>,
): SourceFinding[] {
  const findings: SourceFinding[] = [];
  for (const item of patterns) {
    item.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = item.pattern.exec(source)) !== null) {
      findings.push({
        severity: item.severity,
        type: item.type,
        location: `${relativePath}:${lineNumber(source, match.index)}`,
        description: item.description,
      });
      if (match[0].length === 0) item.pattern.lastIndex++;
    }
  }
  return findings;
}

export function scanSourceText(source: string, relativePath: string): SourceFinding[] {
  const commentsMasked = maskSource(source, 'comments-and-regex');
  const codeOnly = maskSource(source, 'non-code');
  const findings: SourceFinding[] = [];

  for (const { pattern, description } of SECRET_PATTERNS) {
    findings.push(...collectMatches(commentsMasked, relativePath, [{
      pattern, severity: 'high', type: 'Hardcoded Secret', description,
    }]));
  }

  findings.push(...collectMatches(codeOnly, relativePath, [
    { pattern: /\beval\s*\(/g, severity: 'medium', type: 'Eval Usage', description: 'eval() can execute arbitrary code' },
    { pattern: /\.innerHTML\s*=/g, severity: 'medium', type: 'innerHTML', description: 'XSS risk with innerHTML' },
    { pattern: /\bdangerouslySetInnerHTML\s*=/g, severity: 'medium', type: 'React XSS', description: 'React XSS risk' },
  ]));

  // Dynamic input is only suspicious at an execution sink. This avoids
  // matching diagnostic strings merely because "sql" and `${...}` coexist.
  const processSinks = new Set<string>();
  const importPattern = /(?:import|const)\s*\{([^}]+)\}\s*(?:from|=\s*require\s*\()\s*['"](?:node:)?child_process['"]/g;
  let processImport: RegExpExecArray | null;
  while ((processImport = importPattern.exec(commentsMasked)) !== null) {
    for (const specifier of processImport[1].split(',')) {
      const match = /^\s*(exec|execSync|spawn)(?:\s+as\s+|\s*:\s*)?([A-Za-z_$][\w$]*)?\s*$/.exec(specifier);
      if (match) processSinks.add(match[2] || match[1]);
    }
  }
  const escapedSinks = [...processSinks].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const bareProcessSinks = escapedSinks.length > 0
    ? `(?<![\\w$.])(?:${escapedSinks.join('|')})|`
    : '';
  const processPattern = new RegExp(
    `(?:${bareProcessSinks}(?:child_process|childProcess)\\.(?:exec|execSync|spawn))\\s*\\(\\s*(?:\`[^\`\\n]*\\$\\{|[^,\\n]*(?:\\+\\s*[A-Za-z_$]|[A-Za-z_$][\\w$]*\\s*\\+))`,
    'g',
  );
  findings.push(...collectMatches(commentsMasked, relativePath, [
    { pattern: processPattern, severity: 'high', type: 'Command Injection', description: 'Dynamic value passed to a process execution sink' },
    { pattern: /\b(?:(?:db|database|sql|client|connection|conn|stmt|statement|tx|trx|pool)[\w$]*|this\.[\w$]*(?:db|database|sql|client|connection|pool))\s*\.\s*(?:query|execute|exec|prepare|run|all|get)\s*\(\s*`[^`\n]*\$\{/gi, severity: 'high', type: 'SQL Injection', description: 'Interpolated value passed directly to a database execution sink' },
  ]));

  return findings;
}
