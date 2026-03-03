/**
 * Calculator — FeedbackLoop AI Demo
 *
 * INTENTIONAL BUGS (for demo purposes):
 * 1. (FIXED) Division by zero now shows "Cannot divide by zero" instead of "NaN"/"Infinity"
 * 2. "C" button does NOT clear the history
 * 3. (FIXED) Floating-point imprecision — results now rounded to 12 significant digits
 *
 * MISSING FEATURES (for feature requests):
 * - No dark/light theme toggle (always dark)
 */

const display = document.getElementById('result');
const expression = document.getElementById('expression');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistory');

/**
 * Safe math expression evaluator — replaces eval() to prevent arbitrary code execution.
 * Supports: numbers, +, -, *, /, parentheses, and unary minus.
 * Preserves standard JS math behavior (Infinity for div-by-zero, IEEE 754 floats).
 */
function safeEval(expr) {
  const tokens = [];
  const re = /(\d+\.?\d*|\.\d+|[+\-*/()])/g;
  let m;
  while ((m = re.exec(expr)) !== null) tokens.push(m[1]);

  let pos = 0;
  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }

  // expression = term (('+' | '-') term)*
  function parseExpr() {
    let val = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseTerm();
      val = op === '+' ? val + right : val - right;
    }
    return val;
  }

  // term = factor (('*' | '/') factor)*
  function parseTerm() {
    let val = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const right = parseFactor();
      val = op === '*' ? val * right : val / right;
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

const MAX_HISTORY = 50;

let currentInput = '0';
let currentExpression = '';
let history = loadHistory();
let lastResult = null;

// Track previous display state to skip redundant DOM writes
let prevDisplayText = null;
let prevExprText = null;
let prevFontSize = null;

function loadHistory() {
  try {
    const saved = localStorage.getItem('calcHistory');
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return parsed.slice(0, MAX_HISTORY);
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
  // Only write to DOM when the display text actually changed
  if (prevDisplayText !== currentInput) {
    display.textContent = currentInput;
    prevDisplayText = currentInput;
  }

  // Show live preview of expression result while typing
  let exprText = currentExpression;
  if (currentExpression && currentInput) {
    try {
      const result = safeEval(currentExpression + currentInput);
      if (isFinite(result)) {
        exprText = currentExpression + currentInput + ' = ' + parseFloat(result.toPrecision(12));
      }
    } catch (e) { /* expression not yet complete, skip preview */ }
  }
  // Replace raw operators with friendly symbols to match the button labels (× ÷ −)
  const friendlyExpr = exprText
    .replace(/\*/g, '×')
    .replace(/\//g, '÷')
    .replace(/-/g, '−');
  if (prevExprText !== friendlyExpr) {
    expression.textContent = friendlyExpr;
    prevExprText = friendlyExpr;
  }

  // Auto-scale result font size to fit long numbers
  const len = currentInput.length;
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

  const expr = document.createElement('div');
  expr.className = 'expr';
  expr.textContent = item.expression;

  const res = document.createElement('div');
  res.className = 'res';
  res.textContent = '= ' + item.result;

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
  if (lastResult !== null) {
    currentInput = value;
    currentExpression = '';
    lastResult = null;
  } else if (currentInput === '0' && value !== '0') {
    currentInput = value;
  } else if (currentInput === '0' && value === '0') {
    // keep as 0
  } else {
    currentInput += value;
  }
  updateDisplay();
}

function handleDecimal() {
  if (lastResult !== null) {
    currentInput = '0.';
    currentExpression = '';
    lastResult = null;
    updateDisplay();
    return;
  }
  if (!currentInput.includes('.')) {
    currentInput += '.';
  }
  updateDisplay();
}

function handleOpenParen() {
  if (lastResult !== null) {
    currentInput = '';
    currentExpression = '( ';
    lastResult = null;
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
  }
  currentExpression += '( ';
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
  updateDisplay();
}

function handleOperator(op) {
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
  updateDisplay();
}

function handleEquals() {
  if (!currentExpression && currentInput) return;

  const fullExpr = currentExpression + currentInput;
  const displayExpr = fullExpr
    .replace(/\*/g, '×')
    .replace(/\//g, '÷')
    .replace(/-/g, '−');

  try {
    const result = safeEval(fullExpr);

    // Catch division by zero (Infinity) and invalid operations (NaN)
    if (!isFinite(result)) {
      currentInput = result !== result ? 'Error' : 'Cannot divide by zero';
      currentExpression = '';
      lastResult = 'error';
      updateDisplay();
      return;
    }

    // Round to 12 significant digits to eliminate IEEE 754 floating-point artifacts
    // e.g. 0.1 + 0.2 now correctly displays 0.3 instead of 0.30000000000000004
    const cleaned = parseFloat(result.toPrecision(12));
    const displayResult = String(cleaned);

    currentInput = displayResult;
    currentExpression = '';
    lastResult = result;
    addToHistory(displayExpr, displayResult);
  } catch (e) {
    currentInput = 'Error';
    currentExpression = '';
    lastResult = 'error';
  }
  updateDisplay();
}

function handleClear() {
  currentInput = '0';
  currentExpression = '';
  lastResult = null;
  // BUG #2: "C" button does NOT clear the history
  // It should also call: history = []; renderHistory();
  updateDisplay();
}

function handleBackspace() {
  if (lastResult !== null) {
    handleClear();
    return;
  }
  if (currentInput.length > 1) {
    currentInput = currentInput.slice(0, -1);
  } else {
    currentInput = '0';
  }
  updateDisplay();
}

function handlePercent() {
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
          currentInput = String(parseFloat((base * num / 100).toPrecision(12)));
          lastResult = null;
          updateDisplay();
          return;
        }
      } catch (e) { /* fall through to simple percentage */ }
    }
  }

  currentInput = String(parseFloat((num / 100).toPrecision(12)));
  lastResult = null;
  updateDisplay();
}

// Button click handlers (event delegation — single listener for all buttons)
document.querySelector('.buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn');
  if (!btn) return;
  const action = btn.dataset.action;
  const value = btn.dataset.value;

  switch (action) {
    case 'number': handleNumber(value); break;
    case 'decimal': handleDecimal(); break;
    case 'operator': handleOperator(value); break;
    case 'equals': handleEquals(); break;
    case 'clear': handleClear(); break;
    case 'backspace': handleBackspace(); break;
    case 'percent': handlePercent(); break;
  }
});

// Click history item to reuse result (event delegation — single listener for all items)
historyList.addEventListener('click', (e) => {
  const item = e.target.closest('.history-item');
  if (!item) return;
  currentInput = item.dataset.result;
  currentExpression = '';
  lastResult = parseFloat(item.dataset.result);
  updateDisplay();
});

// Clear history button
// BUG #2 related: the clear history button works, but the "C" calculator button doesn't clear history
clearHistoryBtn.addEventListener('click', () => {
  history = [];
  saveHistory();
  renderHistory();
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
  clearTimeout(btn._flashTimer);
  btn.classList.add('btn-flash');
  btn._flashTimer = setTimeout(() => btn.classList.remove('btn-flash'), 150);
}

// Keyboard support
document.addEventListener('keydown', (e) => {
  // Don't intercept keypresses when the user is typing in form fields (e.g. feedback widget)
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

  // Let browser shortcuts through (Ctrl+C, Cmd+R, Alt+Tab, etc.)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key >= '0' && e.key <= '9') {
    e.preventDefault();
    flashButton('number', e.key);
    handleNumber(e.key);
  } else if (e.key === '.') {
    e.preventDefault();
    flashButton('decimal');
    handleDecimal();
  } else if (e.key === '+') {
    e.preventDefault();
    flashButton('operator', '+');
    handleOperator('+');
  } else if (e.key === '-') {
    e.preventDefault();
    flashButton('operator', '-');
    handleOperator('-');
  } else if (e.key === '*') {
    e.preventDefault();
    flashButton('operator', '*');
    handleOperator('*');
  } else if (e.key === '/') {
    e.preventDefault();
    flashButton('operator', '/');
    handleOperator('/');
  } else if (e.key === 'Enter' || e.key === '=') {
    e.preventDefault();
    flashButton('equals');
    handleEquals();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    flashButton('backspace');
    handleBackspace();
  } else if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') {
    flashButton('clear');
    handleClear();
  } else if (e.key === '%') {
    e.preventDefault();
    flashButton('percent');
    handlePercent();
  } else if (e.key === '(' || e.key === ')') {
    e.preventDefault();
    flashButton('operator', e.key);
    handleOperator(e.key);
  }
});

// Copy result to clipboard when display is clicked/tapped
const displayContainer = document.querySelector('.display');
displayContainer.addEventListener('click', () => {
  const text = currentInput;
  if (!text || text === '0' || text === 'Error' || text === 'Cannot divide by zero') return;
  navigator.clipboard.writeText(text).then(() => {
    displayContainer.classList.add('display-copied');
    setTimeout(() => displayContainer.classList.remove('display-copied'), 1200);
  }).catch(() => {});
});

renderHistory();
updateDisplay();
