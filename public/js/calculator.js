/**
 * Calculator — FeedbackLoop AI Demo
 *
 * INTENTIONAL BUGS (for demo purposes):
 * 1. Division by zero shows "NaN" instead of an error message
 * 2. "C" button does NOT clear the history
 * 3. (FIXED) Floating-point imprecision — results now rounded to 12 significant digits
 *
 * MISSING FEATURES (for feature requests):
 * - No dark/light theme toggle (always dark)
 * - No percentage (%) button
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
  display.textContent = currentInput;
  expression.textContent = currentExpression;

  // Auto-scale result font size to fit long numbers
  const len = currentInput.length;
  const maxChars = 9;
  const baseFontSize = 2;
  const minFontSize = 0.9;
  const fontSize = len <= maxChars
    ? baseFontSize
    : Math.max(minFontSize, baseFontSize * maxChars / len);
  display.style.fontSize = fontSize + 'rem';
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

function handleOperator(op) {
  lastResult = null;
  if (currentExpression && currentInput === '') {
    // Replace last operator
    currentExpression = currentExpression.slice(0, -3) + ` ${op} `;
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
    // BUG #1: Division by zero — safeEval returns Infinity, we just show it as-is (NaN/Infinity)
    // The "correct" behavior would be to show "Cannot divide by zero"
    const result = safeEval(fullExpr);

    // Round to 12 significant digits to eliminate IEEE 754 floating-point artifacts
    // e.g. 0.1 + 0.2 now correctly displays 0.3 instead of 0.30000000000000004
    const cleaned = isFinite(result) ? parseFloat(result.toPrecision(12)) : result;
    const displayResult = String(cleaned);

    currentInput = displayResult;
    currentExpression = '';
    lastResult = result;
    addToHistory(displayExpr, displayResult);
  } catch (e) {
    currentInput = 'Error';
    currentExpression = '';
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
  }
});

// Click history item to reuse result (event delegation — single listener for all items)
historyList.addEventListener('click', (e) => {
  const item = e.target.closest('.history-item');
  if (!item) return;
  currentInput = item.dataset.result;
  currentExpression = '';
  updateDisplay();
});

// Clear history button
// BUG #2 related: the clear history button works, but the "C" calculator button doesn't clear history
clearHistoryBtn.addEventListener('click', () => {
  history = [];
  saveHistory();
  renderHistory();
});

// Keyboard support
document.addEventListener('keydown', (e) => {
  if (e.key >= '0' && e.key <= '9') {
    handleNumber(e.key);
  } else if (e.key === '.') {
    handleDecimal();
  } else if (e.key === '+') {
    handleOperator('+');
  } else if (e.key === '-') {
    handleOperator('-');
  } else if (e.key === '*') {
    handleOperator('*');
  } else if (e.key === '/') {
    e.preventDefault(); // prevent browser quick-find
    handleOperator('/');
  } else if (e.key === 'Enter' || e.key === '=') {
    handleEquals();
  } else if (e.key === 'Backspace') {
    handleBackspace();
  } else if (e.key === 'Escape' || e.key === 'c' || e.key === 'C') {
    handleClear();
  } else if (e.key === '(' || e.key === ')') {
    handleOperator(e.key);
  }
});

renderHistory();
updateDisplay();
