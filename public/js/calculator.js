/**
 * Calculator — FeedbackLoop AI Demo
 *
 * INTENTIONAL BUGS (for demo purposes):
 * 1. Division by zero shows "NaN" instead of an error message
 * 2. "C" button does NOT clear the history
 * 3. Floating-point imprecision (0.1 + 0.2 = 0.30000000000000004)
 *
 * MISSING FEATURES (for feature requests):
 * - No keyboard shortcuts
 * - No dark/light theme toggle (always dark)
 * - No percentage (%) button
 */

const display = document.getElementById('result');
const expression = document.getElementById('expression');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistory');

let currentInput = '0';
let currentExpression = '';
let history = [];
let lastResult = null;

function updateDisplay() {
  display.textContent = currentInput;
  expression.textContent = currentExpression;
}

function addToHistory(expr, result) {
  history.unshift({ expression: expr, result: result });
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

  // Click history item to reuse result
  historyList.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index);
      currentInput = String(history[idx].result);
      currentExpression = '';
      updateDisplay();
    });
  });
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
    // BUG #1: Division by zero — eval returns Infinity, we just show it as-is (NaN/Infinity)
    // The "correct" behavior would be to show "Cannot divide by zero"
    const result = eval(fullExpr);

    // BUG #3: Floating-point imprecision — we do NOT round the result
    // 0.1 + 0.2 will show 0.30000000000000004 instead of 0.3
    const displayResult = String(result);

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

// Clear history button
// BUG #2 related: the clear history button works, but the "C" calculator button doesn't clear history
clearHistoryBtn.addEventListener('click', () => {
  history = [];
  renderHistory();
});

updateDisplay();
