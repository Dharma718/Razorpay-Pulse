const loadingState = document.getElementById('loadingState');
const setupForm = document.getElementById('setupForm');
const signinForm = document.getElementById('signinForm');
const demoSection = document.getElementById('demoSection');

const EYE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function showError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.hidden = false;
}
function clearError(elId) {
  document.getElementById(elId).hidden = true;
}

// ---- password visibility toggles (works for any .eye-btn on the page) ----
document.querySelectorAll('.eye-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.classList.toggle('revealed', !showing);
    btn.title = showing ? 'Show password' : 'Hide password';
    btn.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
  });
});

// ---- decide which form to show: first-run setup, or normal sign-in ----
// The demo option is shown in BOTH cases — an evaluator should never need to
// set up a real account just to try the product.
(async function init() {
  try {
    const res = await fetch('/api/auth/status');
    const { ownerConfigured } = await res.json();
    loadingState.hidden = true;
    demoSection.hidden = false;
    if (ownerConfigured) {
      signinForm.hidden = false;
      document.getElementById('signinEmail').focus();
    } else {
      setupForm.hidden = false;
      document.getElementById('setupName').focus();
    }
  } catch (e) {
    loadingState.textContent = 'Could not reach the server. Make sure it\'s running, then reload this page.';
  }
})();

// ---- first-run setup ----
setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('setupError');
  const name = document.getElementById('setupName').value.trim();
  const email = document.getElementById('setupEmail').value.trim();
  const password = document.getElementById('setupPassword').value;
  const confirmPassword = document.getElementById('setupConfirmPassword').value;

  if (password !== confirmPassword) {
    showError('setupError', 'Passwords do not match.');
    return;
  }
  if (password.length < 8) {
    showError('setupError', 'Password must be at least 8 characters.');
    return;
  }

  const btn = document.getElementById('setupSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Creating account…';
  try {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, email, password, confirmPassword }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not create account.');
    window.location.href = '/';
  } catch (err) {
    showError('setupError', err.message);
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
});

// ---- normal sign-in ----
signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError('signinError');
  const email = document.getElementById('signinEmail').value.trim();
  const password = document.getElementById('signinPassword').value;

  const btn = document.getElementById('signinSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not sign in.');
    window.location.href = '/';
  } catch (err) {
    showError('signinError', err.message);
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

// ---- demo account ----
document.getElementById('demoBtn').addEventListener('click', async () => {
  clearError('demoError');
  const btn = document.getElementById('demoBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/auth/demo-login', { method: 'POST', credentials: 'include' });
    if (!res.ok) throw new Error('Could not start a demo session.');
    window.location.href = '/';
  } catch (err) {
    showError('demoError', err.message);
    btn.disabled = false;
    btn.textContent = 'Continue with Demo Account';
  }
});
