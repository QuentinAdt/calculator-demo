import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CALCULATOR_JS = join(__dirname, 'public', 'js', 'calculator.js');
const DOCS_HTML = join(__dirname, 'public', 'docs', 'index.html');

/**
 * Escape HTML special characters to prevent XSS when interpolating
 * dynamic content (parsed from source comments) into generated HTML.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate documentation from the calculator source code.
 * Parses JSDoc-style comments and function signatures.
 */
export function generateDocs() {
  const source = readFileSync(CALCULATOR_JS, 'utf-8');

  // Extract top comment block
  const topCommentMatch = source.match(/^\/\*\*([\s\S]*?)\*\//);
  const topComment = topCommentMatch ? topCommentMatch[1] : '';

  // Parse intentional bugs
  const bugsSection = topComment.match(/INTENTIONAL BUGS.*?:([\s\S]*?)(?=\n \* \n|\n \* [A-Z]|\*\/)/);
  const bugs = bugsSection
    ? bugsSection[1].match(/\d+\..+/g)?.map(b => b.trim()) || []
    : [];

  // Parse missing features
  const featuresSection = topComment.match(/MISSING FEATURES.*?:([\s\S]*?)(?=\n \* \n|\n \*\/|\*\/)/);
  const missingFeatures = featuresSection
    ? featuresSection[1].match(/- .+/g)?.map(f => f.replace(/^- /, '').trim()) || []
    : [];

  // Parse changelog entries
  const changelogSection = topComment.match(/CHANGELOG.*?:([\s\S]*?)(?=\n \* \n|\n \*\/|\*\/)/);
  const changelog = changelogSection
    ? changelogSection[1].match(/- .+/g)?.map(c => c.replace(/^- /, '').trim()) || []
    : [];

  // Extract functions
  const functions = [];
  const funcRegex = /function\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
  let match;
  while ((match = funcRegex.exec(source)) !== null) {
    functions.push({ name: match[1], params: match[2].trim() });
  }

  // Available operations
  const operations = [
    { symbol: '+', name: 'Addition', description: 'Adds two numbers' },
    { symbol: '−', name: 'Subtraction', description: 'Subtracts second number from first' },
    { symbol: '×', name: 'Multiplication', description: 'Multiplies two numbers' },
    { symbol: '÷', name: 'Division', description: 'Divides first number by second' },
    { symbol: '%', name: 'Percent', description: 'Converts number to percentage (divides by 100)' }
  ];

  // Features
  const features = [
    'Basic arithmetic operations (+, −, ×, ÷)',
    'Decimal number support',
    'Expression display showing current calculation',
    'Calculation history with click-to-reuse',
    'Backspace to delete last digit',
    'Clear (C) button to reset current calculation',
    'Parentheses support for grouped expressions',
    'Percentage (%) conversion'
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calculator Documentation — FeedbackLoop AI Demo</title>
  <style>
    :root { --bg: #0a0a0f; --card: #12121a; --border: #1e1e2e; --text: #e4e4ef; --muted: #8888a0; --accent: #6c5ce7; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 40px 24px; max-width: 800px; margin: 0 auto; line-height: 1.6; }
    h1 { font-size: 2rem; margin-bottom: 8px; }
    h2 { font-size: 1.3rem; margin: 32px 0 12px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    h3 { font-size: 1.1rem; margin: 20px 0 8px; }
    p { color: var(--muted); margin-bottom: 12px; }
    a { color: var(--accent); }
    ul, ol { margin: 8px 0 16px 24px; }
    li { color: var(--muted); margin-bottom: 6px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-bug { background: rgba(231,76,60,0.2); color: #e74c3c; }
    .badge-feature { background: rgba(108,92,231,0.2); color: #6c5ce7; }
    .badge-fixed { background: rgba(46,204,113,0.2); color: #2ecc71; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); }
    th { color: var(--text); font-weight: 600; }
    td { color: var(--muted); }
    code { font-family: 'JetBrains Mono', monospace; background: var(--card); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
    .updated { color: var(--muted); font-size: 0.85rem; margin-bottom: 24px; }
    .back { display: inline-block; margin-bottom: 20px; color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <a href="/" class="back">&larr; Back to Calculator</a>
  <h1>Calculator Documentation</h1>
  <p class="updated">Auto-generated on ${new Date().toISOString().split('T')[0]} from source code</p>

  <h2>Features</h2>
  <ul>
    ${features.map(f => `<li>${f}</li>`).join('\n    ')}
  </ul>

  <h2>Operations</h2>
  <table>
    <tr><th>Symbol</th><th>Operation</th><th>Description</th></tr>
    ${operations.map(o => `<tr><td><code>${o.symbol}</code></td><td>${o.name}</td><td>${o.description}</td></tr>`).join('\n    ')}
  </table>

  <h2>Known Issues</h2>
  ${bugs.length > 0
    ? `<ol>${bugs.map(b => `<li><span class="badge badge-bug">Bug</span> ${escapeHtml(b.replace(/^\d+\.\s*/, ''))}</li>`).join('\n')}</ol>`
    : '<p>No known issues.</p>'}

  <h2>Missing Features</h2>
  ${missingFeatures.length > 0
    ? `<ul>${missingFeatures.map(f => `<li><span class="badge badge-feature">Planned</span> ${escapeHtml(f)}</li>`).join('\n')}</ul>`
    : '<p>All planned features have been implemented.</p>'}

  ${changelog.length > 0 ? `
  <h2>Changelog</h2>
  <ul>
    ${changelog.map(c => `<li><span class="badge badge-fixed">Fixed</span> ${escapeHtml(c)}</li>`).join('\n    ')}
  </ul>
  ` : ''}

  <h2>Internal Functions</h2>
  <table>
    <tr><th>Function</th><th>Parameters</th></tr>
    ${functions.map(f => `<tr><td><code>${escapeHtml(f.name)}()</code></td><td>${escapeHtml(f.params || 'none')}</td></tr>`).join('\n    ')}
  </table>

  <h2>Integration</h2>
  <p>This calculator integrates with <a href="https://feedbackloopai.ovh" target="_blank">FeedbackLoop AI</a> for automated bug reporting and feature requests. The feedback widget collects user reports, qualifies them with AI, and triggers an autonomous fix pipeline.</p>

</body>
</html>`;

  writeFileSync(DOCS_HTML, html, 'utf-8');
  console.log('[docs-generator] Documentation generated at', DOCS_HTML);
}

// Run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generateDocs();
}
