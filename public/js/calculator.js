/**
 * Calculator — FeedbackLoop AI Demo
 *
 * INTENTIONAL BUGS (for demo purposes):
 * 1. (FIXED) Division by zero now shows "Cannot divide by zero" instead of "NaN"/"Infinity"
 * 2. "C" button does NOT clear the history
 * 3. (FIXED) Floating-point imprecision — results now rounded to DISPLAY_PRECISION significant digits
 *
 * MISSING FEATURES (for feature requests):
 * - No dark/light theme toggle (always dark)
 */

const display = document.getElementById('result');
const expression = document.getElementById('expression');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistory');
const a11yStatus = document.getElementById('a11yStatus');

// Announce a message to screen readers via the aria-live status region
function announce(message) {
  if (!a11yStatus) return;
  a11yStatus.textContent = '';
  // Force a DOM mutation so the live region re-announces even if the text is the same
  requestAnimationFrame(() => { a11yStatus.textContent = message; });
}

// Announce an error assertively via role="alert" so it interrupts the current speech
const a11yAlert = document.getElementById('a11yAlert');
function announceError(message) {
  if (!a11yAlert) return;
  a11yAlert.textContent = '';
  requestAnimationFrame(() => { a11yAlert.textContent = message; });
}

// Build a screen-reader-friendly version of a math expression
// e.g. "5 * 3" → "5 times 3", "10 / 2" → "10 divided by 2"
function spokenExpression(expr) {
  return expr.replace(/[+\-*/]/g, function(op) {
    return ' ' + (spokenOperators[op] || op) + ' ';
  }).replace(/\s+/g, ' ').trim();
}

/**
 * Safe math expression evaluator — replaces eval() to prevent arbitrary code execution.
 * Supports: numbers, +, -, *, /, parentheses, and unary minus.
 * Preserves standard JS math behavior (Infinity for div-by-zero, IEEE 754 floats).
 */
function safeEval(expr) {
  const tokens = [];
  const re = /(\d+\.?\d*(?:e[+\-]?\d+)?|\.\d+(?:e[+\-]?\d+)?|[+\-*/()])/g;
  let m;
  while ((m = re.exec(expr)) !== null) tokens.push(m[1]);

  let pos = 0;
  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }

  // Round intermediate results to 14 significant digits to prevent
  // IEEE 754 error accumulation across chained operations (e.g. 0.1+0.2-0.3).
  // Final display rounding uses 12 digits, so the 2-digit margin absorbs residual noise.
  function roundIntermediate(val) {
    return isFinite(val) ? parseFloat(val.toPrecision(14)) : val;
  }

  // expression = term (('+' | '-') term)*
  function parseExpr() {
    let val = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseTerm();
      val = roundIntermediate(op === '+' ? val + right : val - right);
    }
    return val;
  }

  // term = factor (('*' | '/') factor)*
  function parseTerm() {
    let val = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const right = parseFactor();
      val = roundIntermediate(op === '*' ? val * right : val / right);
    }
    return val;
  }

  // factor = ['-'] (NUMBER | '(' expression ')')
  function parseFactor() {
    if (peek() === '-') {
      consume();
      return -parseFactor();
    }
    if (peek() === '(') {
      consume();
      const val = parseExpr();
      if (peek() === ')') consume();
      return val;
    }
    const token = consume();
    if (token === undefined) throw new Error('Unexpected end');
    const num = Number(token);
    if (isNaN(num)) throw new Error('Invalid token: ' + token);
    return num;
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error('Unexpected token: ' + tokens[pos]);
  return result;
}

// Format a number string with thousand separators for display (e.g. "1234567" → "1,234,567")
function formatNumber(str) {
  if (!str || str.includes('e') || str.includes('E')) return str;
  if (isNaN(Number(str))) return str;
  const parts = str.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

// Format all bare numbers within an expression string
function formatExprNumbers(expr) {
  return expr.replace(/\d+\.?\d*(?:e[+\-]?\d+)?/g, (m) => formatNumber(m));
}

// Replace raw math operators with user-friendly Unicode symbols for display
function friendlyOperators(str) {
  return str.replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−');
}

// Spoken names for operators — used by screen reader announcements
const spokenOperators = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'divided by' };

// Temporarily flash a CSS class on an element for visual feedback.
// Clears any pending flash timer to handle rapid successive triggers.
function flashClass(element, className, durationMs) {
  if (!element) return;
  clearTimeout(element._flashTimer);
  element.classList.add(className);
  element._flashTimer = setTimeout(() => element.classList.remove(className), durationMs);
}

const MAX_HISTORY = 50;
const MAX_INPUT_LENGTH = 15; // Cap manual input to stay within JS Number precision
const DISPLAY_PRECISION = 12; // Significant digits for displayed results (see also safeEval's 14-digit intermediate rounding)

// Round a numeric result to display precision, stripping IEEE 754 floating-point artifacts.
// e.g. 0.30000000000000004 → 0.3
function roundResult(n) {
  return parseFloat(n.toPrecision(DISPLAY_PRECISION));
}

let currentInput = '0';
let currentExpression = '';
let history = loadHistory();
let lastResult = null;
let lastExprDisplay = null; // Completed expression shown after pressing equals

// Reset calculator to initial state (does NOT clear history — see BUG #2)
function resetCalculatorState() {
  currentInput = '0';
  currentExpression = '';
  lastResult = null;
  lastExprDisplay = null;
}

// Set error display state — calculator rejects operators until user clears or types a new number
function setErrorState(message) {
  currentInput = message;
  currentExpression = '';
  lastResult = 'error';
  lastExprDisplay = null;
}

// Begin a new expression, discarding any pending result.
// Called when the user starts typing after "=" was pressed.
function startNewEntry(newInput, newExpression) {
  currentInput = newInput;
  currentExpression = newExpression || '';
  lastResult = null;
  lastExprDisplay = null;
}

// Track previous display state to skip redundant DOM writes
let prevDisplayText = null;
let prevExprText = null;
let prevFontSize = null;

// Allowed characters in calculator expressions/results: digits, operators,
// decimal points, parentheses, whitespace, minus sign, 'e' for scientific
// notation, and common display tokens (Infinity, NaN, Error messages).
// Anything outside this set is stripped to prevent injected content from
// reaching DOM attributes (dataset, aria-label) or confusing display logic.
const SAFE_CALC_RE = /[^0-9a-zA-Z .+\-*/()=,:!]/g;
const MAX_FIELD_LENGTH = 100;

function isValidHistoryItem(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.expression === 'string' &&
    typeof item.result === 'string' &&
    item.expression.length > 0 &&
    item.expression.length <= MAX_FIELD_LENGTH &&
    item.result.length > 0 &&
    item.result.length <= MAX_FIELD_LENGTH
  );
}

function sanitizeHistoryField(value) {
  return value.replace(SAFE_CALC_RE, '').slice(0, MAX_FIELD_LENGTH);
}

function loadHistory() {
  try {
    const saved = localStorage.getItem('calcHistory');
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidHistoryItem)
      .slice(0, MAX_HISTORY)
      .map(item => ({
        expression: sanitizeHistoryField(item.expression),
        result: sanitizeHistoryField(item.result),
      }));
  } catch (e) {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem('calcHistory', JSON.stringify(history));
  } catch (e) {
    // localStorage full or unavailable — silently continue
  }
}

function updateDisplay() {
  // Format result with thousand separators for readability (display only, not state)
  const formattedInput = formatNumber(currentInput);

  // Only write to DOM when the display text actually changed
  if (prevDisplayText !== formattedInput) {
    display.textContent = formattedInput;
    prevDisplayText = formattedInput;
  }

  // Show live preview of expression result while typing
  let exprText = currentExpression;
  if (currentExpression && currentInput) {
    try {
      const result = safeEval(currentExpression + currentInput);
      if (isFinite(result)) {
        exprText = currentExpression + currentInput + ' = ' + roundResult(result);
      }
    } catch (e) { /* expression not yet complete, skip preview */ }
  } else if (lastExprDisplay) {
    // After pressing equals, keep showing the completed expression (e.g. "5 * 3 = 15")
    exprText = lastExprDisplay;
  }
  // Format numbers and replace raw operators with friendly symbols (× ÷ −)
  const friendlyExpr = friendlyOperators(formatExprNumbers(exprText));
  if (prevExprText !== friendlyExpr) {
    expression.textContent = friendlyExpr;
    prevExprText = friendlyExpr;
  }

  // Keep the display button's aria-label in sync so screen reader users can
  // discover the current result by navigating to the display element.
  // (The #a11yStatus live region handles real-time announcements separately.)
  if (displayContainer) {
    var ariaLabel;
    if (currentInput === 'Error' || currentInput === 'Cannot divide by zero') {
      ariaLabel = 'Error: ' + currentInput;
    } else if (lastExprDisplay) {
      // After equals: full expression context, e.g. "5 times 3 equals 15"
      ariaLabel = spokenExpression(lastExprDisplay.replace(' = ', ' equals ')) + '. Activate to copy to clipboard';
    } else if (currentExpression && currentInput) {
      // Mid-expression: show partial context, e.g. "Expression: 5 plus 3"
      ariaLabel = 'Expression: ' + spokenExpression(currentExpression + currentInput) + '. Activate to copy to clipboard';
    } else {
      ariaLabel = 'Result: ' + formattedInput + '. Activate to copy to clipboard';
    }
    displayContainer.setAttribute('aria-label', ariaLabel);
  }

  // Auto-scale result font size to fit long numbers (use formatted length for accurate sizing)
  const len = formattedInput.length;
  const maxChars = 9;
  const baseFontSize = 2;
  const minFontSize = 0.9;
  const fontSize = len <= maxChars
    ? baseFontSize
    : Math.max(minFontSize, baseFontSize * maxChars / len);
  const fontSizeStr = fontSize + 'rem';
  if (prevFontSize !== fontSizeStr) {
    display.style.fontSize = fontSizeStr;
    prevFontSize = fontSizeStr;
  }
}

function addToHistory(expr, result) {
  history.unshift({ expression: expr, result: result });
  // Evict oldest entries to keep history bounded and localStorage lean
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
    // Remove excess DOM nodes to stay in sync
    while (historyList.children.length > MAX_HISTORY) {
      historyList.lastElementChild.remove();
    }
  }
  saveHistory();
  // Remove "No calculations yet" placeholder if present
  const empty = historyList.querySelector('.history-empty');
  if (empty) empty.remove();
  // Prepend new item directly instead of rebuilding entire list
  historyList.prepend(createHistoryItem({ expression: expr, result: result }));
}

function createHistoryItem(item) {
  const div = document.createElement('div');
  div.className = 'history-item';
  div.dataset.result = item.result;
  div.dataset.expression = item.expression;
  div.setAttribute('role', 'button');
  div.setAttribute('tabindex', '0');
  div.setAttribute('aria-label', formatExprNumbers(item.expression) + ' equals ' + formatNumber(item.result) + '. Activate to reuse.');

  const expr = document.createElement('div');
  expr.className = 'expr';
  expr.textContent = formatExprNumbers(item.expression);

  const res = document.createElement('div');
  res.className = 'res';
  res.textContent = '= ' + formatNumber(item.result);

  div.appendChild(expr);
  div.appendChild(res);
  return div;
}

function renderHistory() {
  historyList.replaceChildren();
  if (history.length === 0) {
    const p = document.createElement('p');
    p.className = 'history-empty';
    p.textContent = 'No calculations yet';
    historyList.appendChild(p);
    return;
  }
  // Batch all DOM insertions into a single append to avoid per-item reflows
  const fragment = document.createDocumentFragment();
  history.forEach((item) => {
    fragment.appendChild(createHistoryItem(item));
  });
  historyList.appendChild(fragment);
}

function handleNumber(value) {
  lastExprDisplay = null;
  if (lastResult !== null) {
    startNewEntry(value);
  } else if (currentInput === '' && currentExpression.trimEnd().endsWith(')')) {
    // Implicit multiplication after close paren: (3)5 → (3) × 5
    currentExpression += '* ';
    currentInput = value;
  } else if (currentInput === '0' && value !== '0') {
    currentInput = value;
  } else if (currentInput === '0' && value === '0') {
    // keep as 0
  } else if (currentInput.replace('.', '').length >= MAX_INPUT_LENGTH) {
    // Cap digit count to prevent display overflow and precision loss
    return;
  } else {
    currentInput += value;
  }
  announce(currentInput);
  updateDisplay();
}

function handleDecimal() {
  lastExprDisplay = null;
  if (lastResult !== null) {
    startNewEntry('0.');
    announce('0 point');
    updateDisplay();
    return;
  }
  if (!currentInput.includes('.') && currentInput.length < MAX_INPUT_LENGTH) {
    currentInput += '.';
  }
  announce(currentInput.replace('.', ' point '));
  updateDisplay();
}

function handleOpenParen() {
  if (lastResult !== null) {
    startNewEntry('', '( ');
    announce('open parenthesis');
    updateDisplay();
    return;
  }
  if (currentInput === '0' && currentExpression === '') {
    // Initial state — discard the default '0'
    currentInput = '';
  } else if (currentInput !== '') {
    // Implicit multiplication: 5( → 5 × (
    currentExpression += `${currentInput} * `;
    currentInput = '';
  } else if (currentExpression.trimEnd().endsWith(')')) {
    // Implicit multiplication after close paren: (3)(4) → (3) × (4)
    currentExpression += '* ';
  }
  currentExpression += '( ';
  announce('open parenthesis');
  updateDisplay();
}

function handleCloseParen() {
  if (lastResult === 'error') return;
  lastResult = null;
  if (currentInput !== '') {
    currentExpression += `${currentInput} ) `;
    currentInput = '';
  } else {
    currentExpression += ') ';
  }
  announce('close parenthesis');
  updateDisplay();
}

function handleOperator(op) {
  lastExprDisplay = null;
  if (op === '(') return handleOpenParen();
  if (op === ')') return handleCloseParen();

  // After an error, ignore operators — there's no valid operand to chain from
  if (lastResult === 'error') return;
  lastResult = null;
  if (currentExpression && currentInput === '') {
    if (currentExpression.trimEnd().endsWith(')')) {
      // After close paren, append operator (don't replace the paren)
      currentExpression += `${op} `;
    } else {
      // Replace last operator (e.g., user changed mind: 3 + → 3 -)
      currentExpression = currentExpression.slice(0, -3) + ` ${op} `;
    }
  } else {
    currentExpression += `${currentInput} ${op} `;
    currentInput = '';
  }
  announce(spokenOperators[op] || op);
  updateDisplay();
}

function handleEquals() {
  if (!currentExpression && currentInput) return;

  const fullExpr = currentExpression + currentInput;
  const displayExpr = friendlyOperators(fullExpr);

  try {
    const result = safeEval(fullExpr);

    // Catch division by zero (Infinity) and invalid operations (NaN)
    if (!isFinite(result)) {
      const msg = result !== result ? 'Error' : 'Cannot divide by zero';
      setErrorState(msg);
      announceError(msg);
      updateDisplay();
      return;
    }

    const cleaned = roundResult(result);
    const displayResult = String(cleaned);

    currentInput = displayResult;
    currentExpression = '';
    lastResult = result;
    addToHistory(displayExpr, displayResult);
    lastExprDisplay = fullExpr + ' = ' + displayResult;
    announce(spokenExpression(fullExpr) + ' equals ' + formatNumber(displayResult));
  } catch (e) {
    setErrorState('Error');
    announceError('Error: invalid expression');
  }
  updateDisplay();
}

function handleClear() {
  resetCalculatorState();
  // BUG #2: "C" button does NOT clear the history
  // It should also call: history = []; renderHistory();
  announce('Cleared');
  updateDisplay();
}

function handleBackspace() {
  lastExprDisplay = null;
  if (lastResult !== null) {
    handleClear();
    return;
  }
  if (currentInput.length > 1) {
    currentInput = currentInput.slice(0, -1);
  } else {
    currentInput = '0';
  }
  announce(currentInput);
  updateDisplay();
}

function handlePercent() {
  lastExprDisplay = null;
  const num = parseFloat(currentInput);
  if (isNaN(num)) return;

  // Contextual percentage for + and - operators:
  // "100 + 5%" → 100 + (5% of 100) = 105
  // "200 - 10%" → 200 - (10% of 200) = 180
  // For * and / (or no operator), just divide by 100 as usual.
  if (currentExpression) {
    const trimmed = currentExpression.trimEnd();
    const lastChar = trimmed.charAt(trimmed.length - 1);
    if (lastChar === '+' || lastChar === '-') {
      try {
        const base = safeEval(trimmed.slice(0, -1).trim());
        if (isFinite(base)) {
          currentInput = String(roundResult(base * num / 100));
          lastResult = null;
          announce(formatNumber(currentInput));
          updateDisplay();
          return;
        }
      } catch (e) { /* fall through to simple percentage */ }
    }
  }

  currentInput = String(roundResult(num / 100));
  lastResult = null;
  announce(formatNumber(currentInput));
  updateDisplay();
}

// Button click handlers (event delegation — single listener for all buttons)
var buttonsContainer = document.querySelector('.buttons');
if (buttonsContainer) buttonsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  const action = btn.dataset.action;
  const value = btn.dataset.value;

  try {
    switch (action) {
      case 'number': handleNumber(value); break;
      case 'decimal': handleDecimal(); break;
      case 'operator': handleOperator(value); break;
      case 'equals': handleEquals(); break;
      case 'clear': handleClear(); break;
      case 'backspace': handleBackspace(); break;
      case 'percent': handlePercent(); break;
    }
  } catch (err) {
    console.warn('[calculator] Button handler error:', err.message);
    setErrorState('Error');
    announceError('Error');
    updateDisplay();
  }
});

// Click history item to reuse result (event delegation — single listener for all items)
// When an expression is in progress (e.g. "5 + "), the history result is inserted as the
// next operand so users can compose calculations from past results without losing context.
historyList.addEventListener('click', (e) => {
  const item = e.target.closest('.history-item');
  if (!item) return;
  const result = item.dataset.result;

  if (currentExpression && currentInput === '') {
    // Mid-expression: insert history result as the next operand
    currentInput = result;
    lastResult = null;
    lastExprDisplay = null;
  } else {
    // No active expression: load the history result and show its original expression
    currentInput = result;
    currentExpression = '';
    lastResult = parseFloat(result);
    lastExprDisplay = item.dataset.expression
      ? item.dataset.expression + ' = ' + result
      : null;
  }
  // Flash the clicked item to confirm the reuse action
  flashClass(item, 'history-item-used', 400);
  announce('Reused result ' + formatNumber(result));
  updateDisplay();
});

// Keyboard activation for history items (Enter / Space trigger click)
historyList.addEventListener('keydown', (e) => {
  const item = e.target.closest('.history-item');
  if (!item) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    item.click();
  }
});

// Clear history button
// BUG #2 related: the clear history button works, but the "C" calculator button doesn't clear history
if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', () => {
  history = [];
  saveHistory();
  renderHistory();
  announce('History cleared');
});

// Pre-cache button elements for O(1) lookup — avoids querySelector on every keypress
const buttonCache = new Map();
document.querySelectorAll('.btn').forEach(btn => {
  const action = btn.dataset.action;
  const value = btn.dataset.value;
  buttonCache.set(value != null ? action + ':' + value : action, btn);
});

// Visual feedback when a key maps to a calculator button
function flashButton(action, value) {
  const btn = buttonCache.get(value != null ? action + ':' + value : action);
  if (!btn) return;
  flashClass(btn, 'btn-flash', 150);
}

// Keyboard-to-calculator mapping — declarative table replaces verbose if-else chain.
// Each entry: { action, value?, handler, noPrevent? }
const keyBindings = new Map();
for (let d = 0; d <= 9; d++) {
  keyBindings.set(String(d), { action: 'number', value: String(d), handler: handleNumber });
}
['+', '-', '*', '/', '(', ')'].forEach(op => {
  keyBindings.set(op, { action: 'operator', value: op, handler: handleOperator });
});
keyBindings.set('.', { action: 'decimal', handler: handleDecimal });
keyBindings.set('Enter', { action: 'equals', handler: handleEquals });
keyBindings.set('=', { action: 'equals', handler: handleEquals });
keyBindings.set('Backspace', { action: 'backspace', handler: handleBackspace });
keyBindings.set('%', { action: 'percent', handler: handlePercent });
['Escape', 'c', 'C'].forEach(k => {
  keyBindings.set(k, { action: 'clear', handler: handleClear, noPrevent: true });
});

// Keyboard support
document.addEventListener('keydown', (e) => {
  // Don't intercept keypresses when the user is typing in form fields (e.g. feedback widget)
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

  // Let browser shortcuts through (Ctrl+C, Cmd+R, Alt+Tab, etc.)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const binding = keyBindings.get(e.key);
  if (!binding) return;
  if (!binding.noPrevent) e.preventDefault();
  flashButton(binding.action, binding.value);
  try {
    binding.handler(binding.value);
  } catch (err) {
    console.warn('[calculator] Keyboard handler error:', err.message);
    setErrorState('Error');
    announceError('Error');
    updateDisplay();
  }
});

// Copy result to clipboard when display is clicked/tapped or activated via keyboard
const displayContainer = document.querySelector('.display');
function copyResult() {
  const text = currentInput;
  if (!displayContainer || !text || text === '0' || text === 'Error' || text === 'Cannot divide by zero') return;
  function onCopySuccess() {
    flashClass(displayContainer, 'display-copied', 1200);
    announce('Copied ' + formatNumber(text) + ' to clipboard');
  }
  function fallbackCopy() {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) { onCopySuccess(); return; }
    } catch (_) { /* fallback also failed */ }
    announce('Could not copy to clipboard');
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onCopySuccess).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}
if (displayContainer) {
  displayContainer.addEventListener('click', copyResult);
  displayContainer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copyResult();
    }
  });
}

renderHistory();
updateDisplay();

// ── Arrow-key grid navigation (roving tabindex) ─────────────────────
// Reduces tab stops from 21 to 1 and lets keyboard users navigate
// buttons with arrow keys matching the visual grid layout.
(function initGridNav() {
  try {
  var btnContainer = document.querySelector('.buttons');
  if (!btnContainer) return;
  var utilRow = btnContainer.querySelector('.btn-row-utils');
  var mainRow = btnContainer.querySelector('.btn-row-main');
  if (!utilRow || !mainRow) return;
  var utilBtns = Array.from(utilRow.children);
  var mainBtns = Array.from(mainRow.children);

  // 2D array matching the visual button layout
  var grid = [
    utilBtns,                // C  ⌫  %  (  )
    mainBtns.slice(0, 4),   // 7  8  9  ÷
    mainBtns.slice(4, 8),   // 4  5  6  ×
    mainBtns.slice(8, 12),  // 1  2  3  −
    mainBtns.slice(12, 16), // 0  .  =  +
  ];

  var row = 0, col = 0;

  // All buttons tabindex=-1 except the initial active one
  grid.forEach(function(r) { r.forEach(function(b) { b.setAttribute('tabindex', '-1'); }); });
  grid[row][col].setAttribute('tabindex', '0');

  function moveTo(r, c) {
    grid[row][col].setAttribute('tabindex', '-1');
    row = r;
    col = c;
    grid[row][col].setAttribute('tabindex', '0');
    grid[row][col].focus();
  }

  btnContainer.addEventListener('keydown', function(e) {
    var r = row, c = col;
    switch (e.key) {
      case 'ArrowRight': c = (col + 1) % grid[row].length; break;
      case 'ArrowLeft':  c = (col - 1 + grid[row].length) % grid[row].length; break;
      case 'ArrowDown':  r = (row + 1) % grid.length; c = Math.min(col, grid[r].length - 1); break;
      case 'ArrowUp':    r = (row - 1 + grid.length) % grid.length; c = Math.min(col, grid[r].length - 1); break;
      case 'Home':       c = 0; break;
      case 'End':        c = grid[row].length - 1; break;
      default: return;
    }
    e.preventDefault();
    if (r !== row || c !== col) moveTo(r, c);
  });

  // Sync active cell when a button receives focus via click or other means
  btnContainer.addEventListener('focusin', function(e) {
    var btn = e.target.closest('.btn');
    if (!btn) return;
    for (var r = 0; r < grid.length; r++) {
      var c = grid[r].indexOf(btn);
      if (c !== -1) {
        if (r !== row || c !== col) {
          grid[row][col].setAttribute('tabindex', '-1');
          row = r; col = c;
          btn.setAttribute('tabindex', '0');
        }
        return;
      }
    }
  });
  } catch (e) {
    console.warn('[calculator] Grid navigation init failed:', e.message);
  }
})();
