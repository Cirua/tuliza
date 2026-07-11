// Shared account page logic (login + signup)

(function () {
  // Utils
  function isStrongPassword(password) {
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{7,}$/.test(password || '');
  }

  function getRoleRedirect(role) {
    if (role === 'mentor') return '/mentor.html';
    if (role === 'psychiatrist') return '/psychologist.html';
    if (role === 'admin') return '/admin.html';
    return '/student.html';
  }

  // Elements
  const tabLogin = document.getElementById('tab-login');
  const tabSignup = document.getElementById('tab-signup');
  const paneLogin = document.getElementById('pane-login');
  const paneSignup = document.getElementById('pane-signup');

  const loginForm = document.getElementById('login-form');
  const signupForm = document.getElementById('signup-form');
  const loginMessage = document.getElementById('login-message');
  const signupMessage = document.getElementById('signup-message');

  const loginPasswordInput = document.getElementById('login-password');
  const toggleLoginPasswordButton = document.getElementById('toggle-login-password');

  const signupPasswordInput = document.getElementById('signup-password');
  const toggleSignupPasswordButton = document.getElementById('toggle-signup-password');

  function enforceRoleChipAccess() {
    const chips = Array.from(document.querySelectorAll('.auth-role-preview .role-chip'));
    chips.forEach((chip) => {
      chip.addEventListener('click', (event) => {
        const href = chip.getAttribute('href') || '';
        if (!href || href === '/student.html') return;

        let sessionUser = null;
        try {
          sessionUser = JSON.parse(sessionStorage.getItem('tuliza_session_user') || '{}');
        } catch (_) {
          sessionUser = null;
        }

        const role = String(sessionUser?.role || '').toLowerCase();
        const expectedRole = href.includes('mentor')
          ? 'mentor'
          : href.includes('psychologist')
            ? 'psychiatrist'
            : href.includes('admin')
              ? 'admin'
              : 'student';

        if (role !== expectedRole) {
          event.preventDefault();
          loginMessage.textContent = `Please login as ${expectedRole} to access that dashboard.`;
        }
      });
    });
  }

  function activateTab(mode) {
    const isLogin = mode === 'login';

    tabLogin?.classList.toggle('active', isLogin);
    tabSignup?.classList.toggle('active', !isLogin);
    tabLogin?.setAttribute('aria-selected', String(isLogin));
    tabSignup?.setAttribute('aria-selected', String(!isLogin));

    if (paneLogin) paneLogin.style.display = isLogin ? '' : 'none';
    if (paneSignup) paneSignup.style.display = isLogin ? 'none' : '';
  }

  tabLogin?.addEventListener('click', () => activateTab('login'));
  tabSignup?.addEventListener('click', () => activateTab('signup'));

  if (toggleLoginPasswordButton && loginPasswordInput) {
    toggleLoginPasswordButton.addEventListener('click', () => {
      const isHidden = loginPasswordInput.type === 'password';
      loginPasswordInput.type = isHidden ? 'text' : 'password';
      toggleLoginPasswordButton.textContent = isHidden ? 'Hide' : 'Show';
      toggleLoginPasswordButton.setAttribute('aria-pressed', String(!isHidden));
      toggleLoginPasswordButton.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
  }

  if (toggleSignupPasswordButton && signupPasswordInput) {
    toggleSignupPasswordButton.addEventListener('click', () => {
      const isHidden = signupPasswordInput.type === 'password';
      signupPasswordInput.type = isHidden ? 'text' : 'password';
      toggleSignupPasswordButton.textContent = isHidden ? 'Hide' : 'Show';
      toggleSignupPasswordButton.setAttribute('aria-pressed', String(!isHidden));
      toggleSignupPasswordButton.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
  }

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loginMessage) loginMessage.textContent = '';

    const email = document.getElementById('login-alias')?.value?.trim();
    const password = document.getElementById('login-password')?.value;

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (loginMessage) loginMessage.textContent = payload.error || 'Login failed.';
        return;
      }

      if (payload.sessionToken) {
        sessionStorage.setItem('tuliza_session_token', payload.sessionToken);
      }

      sessionStorage.setItem(
        'tuliza_session_user',
        JSON.stringify({
          email,
          role: payload.role || 'student',
          userId: payload.userId || null,
          signupId: payload.signupId,
        })
      );

      if (loginMessage) loginMessage.textContent = 'Login successful. Redirecting...';
      window.location.href = payload.redirectTo || getRoleRedirect(payload.role);
    } catch (_) {
      if (loginMessage) loginMessage.textContent = 'Could not reach server.';
    }
  });

  signupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (signupMessage) signupMessage.textContent = '';

    const email = document.getElementById('signup-alias')?.value?.trim();
    const password = document.getElementById('signup-password')?.value;

    if (!isStrongPassword(password)) {
      if (signupMessage)
        signupMessage.textContent =
          'Password must be more than 6 characters and include uppercase, lowercase, and a special character.';
      return;
    }

    try {
      const response = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (signupMessage) signupMessage.textContent = payload.error || 'Signup failed.';
        return;
      }

      if (signupMessage) signupMessage.textContent = payload.message || 'Signup successful.';
      activateTab('login');
      const loginAlias = document.getElementById('login-alias');
      if (loginAlias) loginAlias.value = email;
    } catch (_) {
      if (signupMessage) signupMessage.textContent = 'Could not reach server.';
    }
  });

  activateTab('login');
  enforceRoleChipAccess();
})();

