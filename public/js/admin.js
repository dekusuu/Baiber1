/**
 * Admin area behaviour (no inline scripts are allowed by the Content-Security-Policy, so it all lives here):
 *   - "Record payment" dialog: pre-selects the user, shows what they owe, "Pay full balance"
 *   - "Void payment" dialog
 *   - Dashboard chart: hover / keyboard tooltip and the "View as table" switch
 *   - double-submit protection on every form, receipt printing
 */
(function () {
  'use strict';

  function money(cents) {
    var abs = Math.abs(cents);
    var text = '$' + Math.floor(abs / 100).toLocaleString('en-US') + (abs % 100 ? '.' + String(abs % 100).padStart(2, '0') : '');
    return cents < 0 ? '-' + text : text;
  }

  /** "1,250.50" or "$40" -> cents, or null when it is not a valid amount. */
  function parseCents(text) {
    var cleaned = String(text || '').trim().replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
    var parts = cleaned.split('.');
    return Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
  }

  function modalFor(element) {
    return element && window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(element) : null;
  }

  /* ---------------- Record payment ---------------- */
  var paymentEl = document.getElementById('paymentModal');
  if (paymentEl) {
    var paymentModal = modalFor(paymentEl);
    var form = document.getElementById('paymentForm');
    var userSelect = document.getElementById('paymentUser');
    var owes = document.getElementById('paymentOwes');
    var amountInput = document.getElementById('paymentAmount');
    var fullButton = document.getElementById('payFull');

    var balanceOfSelected = function () {
      var option = userSelect.selectedOptions[0];
      return option && option.value ? Number(option.getAttribute('data-balance')) || 0 : null;
    };

    var refresh = function () {
      var balance = balanceOfSelected();
      var cents = parseCents(amountInput.value);
      owes.classList.remove('is-owed');
      fullButton.hidden = !(balance && balance > 0);
      if (balance === null) { owes.textContent = ''; return; }
      if (balance > 0) {
        owes.textContent = 'Currently owes ' + money(balance) + '.';
        owes.classList.add('is-owed');
        if (cents !== null && cents > balance) owes.textContent += ' That is ' + money(cents - balance) + ' more than they owe; the extra stays as credit.';
      } else if (balance < 0) {
        owes.textContent = 'Has ' + money(-balance) + ' in credit already.';
      } else {
        owes.textContent = 'Nothing owed right now; the payment will be kept as credit.';
      }
    };

    document.querySelectorAll('[data-pay-user]').forEach(function (button) {
      button.addEventListener('click', function () {
        userSelect.value = button.getAttribute('data-pay-user') || '';
        amountInput.value = '';
        form.classList.remove('was-validated');
        userSelect.classList.remove('is-invalid');
        amountInput.classList.remove('is-invalid');
        refresh();
        if (paymentModal) paymentModal.show();
      });
    });

    paymentEl.addEventListener('shown.bs.modal', function () { (userSelect.value ? amountInput : userSelect).focus(); });
    userSelect.addEventListener('change', function () { userSelect.classList.remove('is-invalid'); refresh(); });
    amountInput.addEventListener('input', function () { amountInput.classList.remove('is-invalid'); refresh(); });
    fullButton.addEventListener('click', function () {
      var balance = balanceOfSelected();
      if (!balance || balance <= 0) return;
      amountInput.value = balance % 100 ? (balance / 100).toFixed(2) : String(balance / 100);
      refresh();
      amountInput.focus();
    });

    // The server checks everything again; this only gives quicker feedback.
    form.addEventListener('submit', function (event) {
      var bad = false;
      if (!userSelect.value) { userSelect.classList.add('is-invalid'); bad = true; }
      var cents = parseCents(amountInput.value);
      if (cents === null || cents <= 0) { amountInput.classList.add('is-invalid'); bad = true; }
      if (bad) {
        event.preventDefault();
        event.stopImmediatePropagation(); // keep the double-submit guard below from locking the form
        (userSelect.classList.contains('is-invalid') ? userSelect : amountInput).focus();
        if (window.BaiBer) window.BaiBer.toast('Choose who paid and enter an amount such as 150 or 150.50.', 'error');
      }
    });
  }

  /* ---------------- Void payment ---------------- */
  var voidEl = document.getElementById('voidModal');
  if (voidEl) {
    var voidModal = modalFor(voidEl);
    var voidForm = document.getElementById('voidForm');
    var voidReason = document.getElementById('voidReason');
    document.querySelectorAll('[data-void-payment]').forEach(function (button) {
      button.addEventListener('click', function () {
        voidForm.setAttribute('action', '/admin/payments/' + encodeURIComponent(button.getAttribute('data-void-payment')) + '/void');
        document.getElementById('voidSummary').textContent =
          'Void ' + button.getAttribute('data-receipt') + ': ' + button.getAttribute('data-amount') +
          ' received from ' + button.getAttribute('data-username') + '?';
        voidReason.value = '';
        voidReason.classList.remove('is-invalid');
        if (voidModal) voidModal.show();
      });
    });
    voidEl.addEventListener('shown.bs.modal', function () { voidReason.focus(); });
    voidForm.addEventListener('submit', function (event) {
      if (voidReason.value.trim().length < 3) {
        event.preventDefault();
        event.stopImmediatePropagation();
        voidReason.classList.add('is-invalid');
        voidReason.focus();
      }
    });
  }

  /* ---------------- Dashboard chart ---------------- */
  var chart = document.getElementById('chartPlot');
  if (chart) {
    var tip = document.getElementById('chartTip');
    var columns = chart.querySelectorAll('.col');

    var line = function (tag, text) {
      var el = document.createElement(tag);
      el.textContent = text; // textContent only: never HTML
      return el;
    };

    var showTip = function (column) {
      var chars = Number(column.getAttribute('data-chars')) || 0;
      var messages = Number(column.getAttribute('data-messages')) || 0;
      tip.replaceChildren(
        line('strong', chars.toLocaleString('en-US') + (chars === 1 ? ' character' : ' characters')),
        line('span', column.getAttribute('data-label')),
        line('span', messages.toLocaleString('en-US') + (messages === 1 ? ' message' : ' messages') + ' · billed ' + money(Number(column.getAttribute('data-cents')) || 0))
      );
      tip.hidden = false;
      var host = chart.getBoundingClientRect();
      var hit = column.querySelector('.col-hit').getBoundingClientRect();
      var width = tip.offsetWidth;
      var left = hit.left - host.left + hit.width / 2 - width / 2;
      left = Math.max(0, Math.min(left, host.width - width));
      var bar = column.querySelector('.col-bar');
      var top = (bar ? bar.getBoundingClientRect().top : hit.bottom) - host.top - tip.offsetHeight - 8;
      tip.style.left = left + 'px';
      tip.style.top = Math.max(0, top) + 'px';
    };
    var hideTip = function () { tip.hidden = true; };

    columns.forEach(function (column) {
      column.addEventListener('pointerenter', function () { showTip(column); });
      column.addEventListener('pointerleave', hideTip);
      column.addEventListener('focus', function () { showTip(column); });
      column.addEventListener('blur', hideTip);
    });

    var toggle = document.getElementById('chartToggle');
    var table = document.getElementById('chartTable');
    toggle.addEventListener('click', function () {
      var showTable = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(showTable));
      toggle.querySelector('span').textContent = showTable ? 'View as chart' : 'View as table';
      toggle.querySelector('i').className = showTable ? 'bi bi-bar-chart-fill me-1' : 'bi bi-table me-1';
      table.hidden = !showTable;
      chart.hidden = showTable;
      hideTip();
    });
  }

  /* ---------------- Receipt ---------------- */
  document.querySelectorAll('[data-print]').forEach(function (button) {
    button.addEventListener('click', function () { window.print(); });
  });

  /* ---------------- One click, one submit ---------------- */
  document.querySelectorAll('form[method="post"]').forEach(function (formEl) {
    formEl.addEventListener('submit', function (event) {
      if (formEl.getAttribute('data-sent') === 'true') { event.preventDefault(); return; }
      formEl.setAttribute('data-sent', 'true');
      setTimeout(function () {
        formEl.querySelectorAll('button[type="submit"]').forEach(function (button) { button.disabled = true; });
      }, 0);
    });
  });
  // Coming back with the Back button must not leave a form locked.
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    document.querySelectorAll('form[data-sent]').forEach(function (formEl) {
      formEl.removeAttribute('data-sent');
      formEl.querySelectorAll('button[type="submit"]').forEach(function (button) { button.disabled = false; });
    });
  });
})();
