import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';
import { generateDocs } from './docs-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read env at call time (not module load time) because .env is parsed in server.js after imports
function getEnv(key) { return process.env[key] || ''; }

const CALCULATOR_JS_PATH = join(__dirname, 'public', 'js', 'calculator.js');
const CALCULATOR_JS_BACKUP = join(__dirname, 'public', 'js', 'calculator.js.bak');

// Max lengths for user-controlled webhook fields interpolated into AI prompts.
// Truncation limits prompt injection surface and prevents excessively large payloads.
const MAX_FIELD_LENGTH = 500;
const MAX_TRANSCRIPT_ENTRIES = 20;

/**
 * Sanitize a user-controlled string before interpolating into an AI prompt.
 * Truncates to maxLength and strips non-printable characters (except common whitespace).
 */
function sanitizeField(value, maxLength = MAX_FIELD_LENGTH) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLength).replace(/[^\x20-\x7E\n\r\t]/g, '');
}

/**
 * Scan AI-generated code for dangerous patterns that a calculator app should never contain.
 * Guards against prompt injection attacks that trick the AI into generating malicious code
 * (e.g. data exfiltration via fetch, XSS via innerHTML, or arbitrary code execution via eval).
 * Returns an array of violation descriptions; empty array means the code is safe.
 */
function detectDangerousPatterns(code) {
  const violations = [];
  const patterns = [
    // Network access — calculator has no reason to make HTTP requests
    [/\bfetch\s*\(/, 'network access (fetch)'],
    [/\bXMLHttpRequest\b/, 'network access (XMLHttpRequest)'],
    [/\bWebSocket\b/, 'network access (WebSocket)'],
    [/\bnavigator\.sendBeacon\b/, 'network access (sendBeacon)'],
    [/\bnew\s+EventSource\b/, 'network access (EventSource)'],

    // Dynamic code execution
    [/\beval\s*\(/, 'dynamic code execution (eval)'],
    [/\bnew\s+Function\s*\(/, 'dynamic code execution (new Function)'],
    [/\bsetTimeout\s*\(\s*['"`]/, 'dynamic code execution (setTimeout with string)'],
    [/\bsetInterval\s*\(\s*['"`]/, 'dynamic code execution (setInterval with string)'],

    // Unsafe DOM mutation — calculator uses textContent exclusively
    [/\.innerHTML\b/, 'unsafe DOM mutation (innerHTML)'],
    [/\.outerHTML\s*=/, 'unsafe DOM mutation (outerHTML)'],
    [/\bdocument\.write\s*\(/, 'unsafe DOM mutation (document.write)'],
    [/\bcreateElement\s*\(\s*['"`]script['"`]\s*\)/, 'script element creation'],

    // Cookie access — calculator does not use cookies
    [/\bdocument\.cookie\b/, 'cookie access'],

    // Dynamic imports
    [/\bimport\s*\(/, 'dynamic import'],

    // Navigation/redirects
    [/(?:window|document)\.location\s*=/, 'page redirect'],
    [/\blocation\.(?:href|replace|assign)\s*[=(]/, 'page redirect'],
  ];

  for (const [regex, label] of patterns) {
    if (regex.test(code)) {
      violations.push(label);
    }
  }

  return violations;
}

/**
 * Handle incoming webhook from FeedbackLoop AI.
 * Generates a code patch via AI, applies it, regenerates docs.
 */
export async function handleWebhook(payload) {
  const { event, request } = payload;
  if (event !== 'feedback.qualified') {
    console.log(`[auto-updater] Ignoring event: ${event}`);
    return;
  }

  const { category, title, aiAnalysis, aiSummary, transcript } = request;
  console.log(`[auto-updater] Processing ${category}: ${title || aiSummary?.slice(0, 80)}`);

  const apiKey = getEnv('OPENROUTER_API_KEY');
  if (!apiKey) {
    console.log('[auto-updater] No OPENROUTER_API_KEY configured, skipping auto-fix');
    return;
  }

  // Read current calculator code
  let currentCode;
  try {
    currentCode = readFileSync(CALCULATOR_JS_PATH, 'utf-8');
  } catch (err) {
    console.error(`[auto-updater] Failed to read calculator.js: ${err.message}`);
    return;
  }

  // Build prompt based on category
  const prompt = buildPatchPrompt(category, request, currentCode);

  // Call AI to generate patch
  const patchedCode = await generatePatch(prompt, currentCode, apiKey);
  if (!patchedCode) {
    console.log('[auto-updater] AI did not generate a valid patch');
    return;
  }

  // Create backup before applying patch so we can roll back on write failure
  try {
    copyFileSync(CALCULATOR_JS_PATH, CALCULATOR_JS_BACKUP);
  } catch (err) {
    console.error(`[auto-updater] Failed to create backup, aborting patch: ${err.message}`);
    return;
  }

  // Apply patch with rollback on failure
  try {
    writeFileSync(CALCULATOR_JS_PATH, patchedCode, 'utf-8');
    console.log('[auto-updater] Patch applied to calculator.js');
  } catch (err) {
    console.error(`[auto-updater] Failed to write patched code: ${err.message}`);
    try {
      copyFileSync(CALCULATOR_JS_BACKUP, CALCULATOR_JS_PATH);
      console.log('[auto-updater] Rolled back to backup');
    } catch (rollbackErr) {
      console.error(`[auto-updater] CRITICAL: Rollback also failed: ${rollbackErr.message}`);
    }
    return;
  }

  // Regenerate docs
  try {
    generateDocs();
    console.log('[auto-updater] Documentation regenerated');
  } catch (err) {
    console.error('[auto-updater] Failed to regenerate docs:', err.message);
  }

  // Update feedback status via FeedbackLoop API
  const feedbackUrl = getEnv('FEEDBACKLOOP_API_URL');
  const adminToken = getEnv('FEEDBACKLOOP_ADMIN_TOKEN');
  if (feedbackUrl && adminToken) {
    await updateFeedbackStatus(request.id, 'TEST_READY', feedbackUrl, adminToken);
  }

  console.log(`[auto-updater] Done processing ${category}: ${title || 'untitled'}`);
}

// Per-category prompt config — keeps the template DRY while allowing each
// category to customise the intro, section header, and action instruction.
const PROMPT_CONFIG = {
  BUG: {
    intro: 'A user reported a bug in a calculator app',
    section: 'Bug Report',
    action: 'Fix the specific bug described in the report',
    commentUpdate: 'Update the comment at the top of the file to reflect the fix (remove the bug from the INTENTIONAL BUGS list and add a CHANGELOG entry)',
  },
  FEATURE: {
    intro: 'A user requested a feature for a calculator app',
    section: 'Feature Request',
    action: 'Implement the requested feature',
    commentUpdate: 'Update the comment at the top (remove from MISSING FEATURES if applicable, add CHANGELOG entry)',
  },
};

function buildPatchPrompt(category, request, currentCode) {
  const config = PROMPT_CONFIG[category];
  if (!config) return null; // QUESTION or unknown — no code change needed

  const analysisStr = request.aiAnalysis
    ? sanitizeField(JSON.stringify(request.aiAnalysis, null, 2), 1000)
    : 'No analysis available';

  const transcriptStr = Array.isArray(request.transcript)
    ? request.transcript
        .slice(0, MAX_TRANSCRIPT_ENTRIES)
        .map(m => `${sanitizeField(String(m.role || ''), 20)}: ${sanitizeField(String(m.content || ''))}`)
        .join('\n')
    : '';

  return `You are a senior JavaScript developer. ${config.intro}.

## ${config.section}
Title: ${sanitizeField(request.title) || 'N/A'}
Summary: ${sanitizeField(request.aiSummary) || 'N/A'}

## AI Analysis
${analysisStr}

## User Conversation
${transcriptStr}

## Current Code
\`\`\`javascript
${currentCode}
\`\`\`

## Instructions
- ${config.action}
- Keep all existing functionality intact
- Keep the code structure and style consistent
- ${config.commentUpdate}
- Return ONLY the complete updated JavaScript file, no explanations
- Do NOT add any markdown fencing or code blocks — return raw JavaScript only`;
}

async function generatePatch(prompt, currentCode, apiKey) {
  if (!prompt) return null;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://demo.feedbackloopai.ovh',
        'X-Title': 'Calculator Demo Auto-Updater'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a code generator. Return ONLY valid JavaScript code. No markdown, no explanations, no code fences.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 4096,
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      console.error(`[auto-updater] AI API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    let code = data.choices?.[0]?.message?.content || '';

    // Strip markdown fencing if AI added it despite instructions
    code = code.replace(/^```(?:javascript|js)?\n?/gm, '').replace(/\n?```$/gm, '').trim();

    // Sanity check: must contain key functions
    if (!code.includes('handleEquals') || !code.includes('handleClear') || !code.includes('updateDisplay')) {
      console.error('[auto-updater] Generated code missing key functions, rejecting patch');
      return null;
    }

    // Must be at least 50% the size of original (prevent truncation)
    if (code.length < currentCode.length * 0.5) {
      console.error('[auto-updater] Generated code too short, rejecting patch');
      return null;
    }

    // Verify the generated code is syntactically valid JavaScript
    try {
      new vm.Script(code);
    } catch (syntaxErr) {
      console.error('[auto-updater] Generated code has syntax errors, rejecting patch:', syntaxErr.message);
      return null;
    }

    // Reject code containing dangerous patterns that could result from prompt injection
    const violations = detectDangerousPatterns(code);
    if (violations.length > 0) {
      console.error(`[auto-updater] Generated code contains dangerous patterns, rejecting patch: ${violations.join(', ')}`);
      return null;
    }

    return code;
  } catch (err) {
    console.error(`[auto-updater] AI generation failed: ${err.message}`);
    return null;
  }
}

async function updateFeedbackStatus(requestId, status, feedbackUrl, adminToken) {
  try {
    const response = await fetch(`${feedbackUrl}/api/v1/admin/requests/${requestId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(10000)
    });

    if (response.ok) {
      console.log(`[auto-updater] Feedback ${requestId} status updated to ${status}`);
    } else {
      console.log(`[auto-updater] Failed to update feedback status: ${response.status}`);
    }
  } catch (err) {
    console.error(`[auto-updater] Status update failed: ${err.message}`);
  }
}
