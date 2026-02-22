/**
 * Calculator — FeedbackLoop AI Demo
 *
 * INTENTIONAL BUGS (for demo purposes):
 * (none — all fixed, see CHANGELOG)
 *
 * MISSING FEATURES (for feature requests):
 * - No dark/light theme toggle (always dark)
 * - No percentage (%) button
 *
 * CHANGELOG:
 * - Fixed floating-point imprecision: results rounded to 12 significant figures
 * - Fixed division by zero: shows "Cannot divide by zero" instead of Infinity/NaN
 * - Implemented Global Reset (AC) vs Current Clear (C): C clears current input; pressing C again when already at default state clears history too
 * - Fixed history click-to-reuse: typing a digit after selecting a history item now replaces the value instead of appending
 * - Added keyboard support: digits, operators, Enter/=, Backspace, Escape
 * - Used event delegation for history list clicks (single listener instead of one per item)
 * - Added MAX_HISTORY cap (50 entries) to prevent unbounded memory growth
 */

const display = document.getElementById('result');
const expression = document.getElementById('expression');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistory');

let currentInput = '0';
let currentExpression = '';
let history = [];
let lastResult = null;

const MAX_HISTORY = 50;

function updateDisplay() {
  display.textContent = currentInput;
  expression.textContent = currentExpression;
  updateClearButton();
}

function updateClearButton() {
  const clearBtn = document.querySelector('[data-action="clear"]');
  const isDefaultState = currentInput === '0' && currentExpression === '' && lastResult === null;
  clearBtn.textContent = isDefaultState ? 'AC' : 'C';
}

function addToHistory(expr, result) {
  history.unshift({ expression: expr, result: result });
  if (history.length > MAX_HISTORY) history.pop();
  renderHistory();
}

function renderHistory() {
  if (history.length === 0) {
    historyList.innerHTML = '<p class="history-empty">No calculations yet</p>';
    return;
  }
  historyList.innerHTML = history.map((item, i) => `
    <div class="history-item" data-index="${i}">
      <div class="expr">${item.expression}</div>
      <div class="res">= ${item.result}</div>
    </div>
  `).join('');
}

// Event delegation for history clicks — single listener instead of one per item
historyList.addEventListener('click', (e) => {
  const item = e.target.closest('.history-item');
  if (!item) return;
  const idx = parseInt(item.dataset.index);
  currentInput = String(history[idx].result);
  currentExpression = '';
  lastResult = history[idx].result; // Ensures next digit typed starts a fresh number
  updateDisplay();
});

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
    const result = eval(fullExpr);

    if (!isFinite(result)) {
      currentInput = 'Cannot divide by zero';
      currentExpression = '';
      lastResult = NaN; // Sentinel so next digit starts fresh
      updateDisplay();
      return;
    }

    // Round to 12 significant figures to eliminate floating-point display artifacts
    const rounded = parseFloat(result.toPrecision(12));
    const displayResult = String(rounded);

    currentInput = displayResult;
    currentExpression = '';
    lastResult = rounded;
    addToHistory(displayExpr, displayResult);
  } catch (e) {
    currentInput = 'Error';
    currentExpression = '';
    lastResult = NaN; // Sentinel so next digit starts fresh
  }
  updateDisplay();
}

function handleClear() {
  // Global Reset (AC): if already at default state, also clear history
  const isDefaultState = currentInput === '0' && currentExpression === '' && lastResult === null;
  currentInput = '0';
  currentExpression = '';
  lastResult = null;
  if (isDefaultState) {
    history = [];
    renderHistory();
  }
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

// Button click handlers
document.querySelectorAll('.btn').forEach(btn => {
  btn.addEventListener('click', () => {
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
});

// Keyboard support
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key >= '0' && e.key <= '9') { e.preventDefault(); handleNumber(e.key); return; }
  if (e.key === '.') { e.preventDefault(); handleDecimal(); return; }
  if (['+', '-', '*', '/'].includes(e.key)) { e.preventDefault(); handleOperator(e.key); return; }
  if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); handleEquals(); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); handleBackspace(); return; }
  if (e.key === 'Escape') { e.preventDefault(); handleClear(); return; }
  if (e.key === '(' || e.key === ')') { e.preventDefault(); handleOperator(e.key); return; }
});

// Clear history button
clearHistoryBtn.addEventListener('click', () => {
  history = [];
  renderHistory();
});

updateDisplay();
