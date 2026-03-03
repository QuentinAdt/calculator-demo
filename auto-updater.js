import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';
import { generateDocs } from './docs-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read env at call time (not module load time) because .env is parsed in server.js after imports
function getEnv(key) { return process.env[key] || ''; }

const CALCULATOR_JS_PATH = join(__dirname, 'public', 'js', 'calculator.js');

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
  const currentCode = readFileSync(CALCULATOR_JS_PATH, 'utf-8');

  // Build prompt based on category
  const prompt = buildPatchPrompt(category, request, currentCode);

  // Call AI to generate patch
  const patchedCode = await generatePatch(prompt, currentCode, apiKey);
  if (!patchedCode) {
    console.log('[auto-updater] AI did not generate a valid patch');
    return;
  }

  // Apply patch
  writeFileSync(CALCULATOR_JS_PATH, patchedCode, 'utf-8');
  console.log('[auto-updater] Patch applied to calculator.js');

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

function buildPatchPrompt(category, request, currentCode) {
  const analysisStr = request.aiAnalysis
    ? JSON.stringify(request.aiAnalysis, null, 2)
    : 'No analysis available';

  const transcriptStr = Array.isArray(request.transcript)
    ? request.transcript.map(m => `${m.role}: ${m.content}`).join('\n')
    : '';

  if (category === 'BUG') {
    return `You are a senior JavaScript developer. A user reported a bug in a calculator app.

## Bug Report
Title: ${request.title || 'N/A'}
Summary: ${request.aiSummary || 'N/A'}

## AI Analysis
${analysisStr}

## User Conversation
${transcriptStr}

## Current Code
\`\`\`javascript
${currentCode}
\`\`\`

## Instructions
- Fix the specific bug described in the report
- Keep all existing functionality intact
- Keep the code structure and style consistent
- Update the comment at the top of the file to reflect the fix (remove the bug from the INTENTIONAL BUGS list and add a CHANGELOG entry)
- Return ONLY the complete updated JavaScript file, no explanations
- Do NOT add any markdown fencing or code blocks — return raw JavaScript only`;
  }

  if (category === 'FEATURE') {
    return `You are a senior JavaScript developer. A user requested a feature for a calculator app.

## Feature Request
Title: ${request.title || 'N/A'}
Summary: ${request.aiSummary || 'N/A'}

## AI Analysis
${analysisStr}

## User Conversation
${transcriptStr}

## Current Code
\`\`\`javascript
${currentCode}
\`\`\`

## Instructions
- Implement the requested feature
- Keep all existing functionality intact
- Keep the code structure and style consistent
- Update the comment at the top (remove from MISSING FEATURES if applicable, add CHANGELOG entry)
- Return ONLY the complete updated JavaScript file, no explanations
- Do NOT add any markdown fencing or code blocks — return raw JavaScript only`;
  }

  // QUESTION — no code change needed
  return null;
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
