/**
 * Shared browser helpers used by every page:
 *   BaiBer.api(url, { method, body })  -> fetch() wrapper that sends the CSRF token and parses JSON
 *   BaiBer.toast(message, type)        -> small notification in the corner
 *   plus: flash toasts, password show/hide, client-side form validation, local date formatting
 */
(function () {
  'use strict';

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');

  function csrfToken() {
    return csrfMeta ? csrfMeta.getAttribute('content') : '';
  }

  /** JSON request helper. Throws an Error (with .status and .errors) for any failed request. */
  async function api(url, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json', 'X-CSRF-Token': csrfToken() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    var response;
    try {
      response = await fetch(url, {
        method: opts.method || 'GET',
        headers: headers,
        credentials: 'same-origin',
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (networkError) {
      var offline = new Error('Cannot reach the server. Check your connection and try again.');
      offline.network = true;
      throw offline;
    }

    var data = null;
    try {
      data = await response.json();
    } catch (parseError) {
      data = null;
    }

    if (response.status === 401) {
      window.location.href = '/login'; // session ended: go sign in again
      throw new Error('Please sign in again.');
    }
    if (!response.ok || (data && data.ok === false)) {
      var error = new Error((data && data.error) || 'Something went wrong. Please try again.');
      error.status = response.status;
      error.errors = (data && data.errors) || null;
      throw error;
    }
    return data;
  }

  function toast(message, type) {
    var container = document.getElementById('toastContainer');
    if (!container || !window.bootstrap) return;
    var kind = type === 'error' || type === 'success' ? type : 'info';
    var icon = { error: 'bi-exclamation-circle-fill', success: 'bi-check-circle-fill', info: 'bi-info-circle-fill' }[kind];

    var el = document.createElement('div');
    el.className = 'toast bb-toast ' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    var wrapper = document.createElement('div');
    wrapper.className = 'd-flex';
    var body = document.createElement('div');
    body.className = 'toast-body';
    var iconEl = document.createElement('i');
    iconEl.className = 'bi ' + icon + ' toast-icon';
    var text = document.createElement('span');
    text.textContent = message; // textContent: never interpreted as HTML
    body.append(iconEl, text);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn-close';
    close.setAttribute('data-bs-dismiss', 'toast');
    close.setAttribute('aria-label', 'Close');
    wrapper.append(body, close);
    el.append(wrapper);
    container.append(el);

    el.addEventListener('hidden.bs.toast', function () { el.remove(); });
    window.bootstrap.Toast.getOrCreateInstance(el, { delay: kind === 'error' ? 6000 : 4000 }).show();
  }

  window.BaiBer = { api: api, toast: toast, csrfToken: csrfToken };

  document.addEventListener('DOMContentLoaded', function () {
    // Toasts rendered by the server (flash messages).
    document.querySelectorAll('.toast[data-flash]').forEach(function (el) {
      window.bootstrap.Toast.getOrCreateInstance(el, { delay: 5000 }).show();
    });

    // Show / hide password buttons.
    document.querySelectorAll('[data-toggle-password]').forEach(function (button) {
      button.addEventListener('click', function () {
        var input = document.getElementById(button.getAttribute('data-toggle-password'));
        if (!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        button.querySelector('i').className = show ? 'bi bi-eye-slash' : 'bi bi-eye';
        button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    });

    // Client-side validation (the server validates again: this is only for faster feedback).
    document.querySelectorAll('form.needs-validation').forEach(function (form) {
      var confirmInput = form.querySelector('[data-match]');
      form.addEventListener('submit', function (event) {
        var username = form.querySelector('#username[minlength]');
        if (username) username.value = username.value.trim();
        if (confirmInput) {
          var original = document.getElementById(confirmInput.getAttribute('data-match'));
          confirmInput.setCustomValidity(original && confirmInput.value !== original.value ? 'Passwords do not match.' : '');
        }
        if (!form.checkValidity()) {
          event.preventDefault();
          event.stopPropagation();
        }
        form.classList.add('was-validated');
      });
      if (confirmInput) {
        confirmInput.addEventListener('input', function () { confirmInput.setCustomValidity(''); });
      }
    });

    // Show server timestamps in the visitor's own time zone.
    document.querySelectorAll('time[data-local]').forEach(function (el) {
      var date = new Date(el.getAttribute('datetime'));
      if (isNaN(date)) return;
      var style = el.getAttribute('data-local') === 'date' ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' };
      el.textContent = new Intl.DateTimeFormat(undefined, style).format(date);
    });
  });
})();
