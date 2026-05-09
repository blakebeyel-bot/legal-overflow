/**
 * Site dialog — toast + confirm system that replaces native
 * browser alerts with site-styled equivalents.
 *
 * Exposes:
 *   window.siteToast(message, opts?)
 *     Slides a toast in from the bottom-right. Auto-dismisses
 *     after `opts.duration` (default 4000ms). `opts.kind` =
 *     'info' (default) | 'success' | 'warn' | 'error'.
 *
 *   window.siteConfirm(message, opts?) → Promise<boolean>
 *     Site-styled modal confirm. Async — callers that use it must
 *     `await`. Native window.confirm() is left alone for callers
 *     that haven't migrated yet (synchronous; OS-styled).
 *
 * Side effects:
 *   - Overrides window.alert globally so legacy alert() calls
 *     render as site toasts. Callers don't need to change.
 *
 * Drop into <head>:
 *   <script src="/site-dialog.js" defer></script>
 */
(function () {
  if (typeof document === 'undefined') return;
  if (window.__siteDialogLoaded) return;
  window.__siteDialogLoaded = true;

  // ---- Toast container (lazy-created) ----
  function getToastContainer() {
    let c = document.getElementById('site-toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'site-toast-container';
      c.className = 'site-toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  /**
   * Show a site-styled toast.
   * @param {string} message
   * @param {object} [opts]
   * @param {'info'|'success'|'warn'|'error'} [opts.kind='info']
   * @param {number} [opts.duration=4000]  ms before auto-dismiss; 0 = sticky
   */
  function siteToast(message, opts = {}) {
    const kind = opts.kind || 'info';
    const duration = opts.duration === 0 ? 0 : (opts.duration || 4000);
    const container = getToastContainer();
    const el = document.createElement('div');
    el.className = 'site-toast site-toast-' + kind;
    el.setAttribute('role', kind === 'error' || kind === 'warn' ? 'alert' : 'status');
    el.innerHTML = `
      <span class="site-toast-icon" aria-hidden="true">${
        kind === 'success' ? '✓' :
        kind === 'warn'    ? '⚠' :
        kind === 'error'   ? '⚠' : 'ⓘ'
      }</span>
      <span class="site-toast-msg"></span>
      <button type="button" class="site-toast-close" aria-label="Dismiss">×</button>
    `;
    el.querySelector('.site-toast-msg').textContent = String(message);
    container.appendChild(el);
    // Trigger enter animation on next frame
    requestAnimationFrame(() => el.classList.add('is-visible'));
    function dismiss() {
      el.classList.remove('is-visible');
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 220);
    }
    el.querySelector('.site-toast-close').addEventListener('click', dismiss);
    if (duration > 0) {
      setTimeout(dismiss, duration);
    }
    return { dismiss };
  }
  window.siteToast = siteToast;

  // ---- Site-styled confirm (async) ----
  /**
   * Site-styled confirm modal. Returns a Promise<boolean>.
   * Callers must await. Native window.confirm() remains available
   * for synchronous legacy code that hasn't migrated.
   */
  function siteConfirm(message, opts = {}) {
    const okLabel = opts.okLabel || 'Confirm';
    const cancelLabel = opts.cancelLabel || 'Cancel';
    const danger = !!opts.danger;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'site-confirm-overlay';
      overlay.innerHTML = `
        <div class="site-confirm-modal" role="dialog" aria-modal="true">
          <div class="site-confirm-msg"></div>
          <div class="site-confirm-actions">
            <button type="button" class="site-confirm-cancel">${cancelLabel}</button>
            <button type="button" class="site-confirm-ok${danger ? ' is-danger' : ''}">${okLabel}</button>
          </div>
        </div>
      `;
      overlay.querySelector('.site-confirm-msg').textContent = String(message);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('is-visible'));
      // Keyboard handler — declared up here so close() (defined below)
      // can detach it from EVERY close path. Previous version only
      // detached on Esc / Enter, which leaked one stale listener for
      // every overlay-click and every button-click dismiss.
      function keyHandler(e) {
        if (e.key === 'Escape') {
          close(false);
        } else if (e.key === 'Enter' && document.activeElement === overlay.querySelector('.site-confirm-ok')) {
          close(true);
        }
      }
      function close(result) {
        // Always detach the keydown listener — covers cancel-button,
        // ok-button, overlay-click, and Esc paths. Closing the dialog
        // any way must leave the document with zero stale listeners.
        document.removeEventListener('keydown', keyHandler);
        overlay.classList.remove('is-visible');
        setTimeout(() => overlay.remove(), 180);
        resolve(result);
      }
      overlay.querySelector('.site-confirm-cancel').addEventListener('click', () => close(false));
      overlay.querySelector('.site-confirm-ok').addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      // Focus the OK button so Enter confirms
      requestAnimationFrame(() => overlay.querySelector('.site-confirm-ok').focus());
      document.addEventListener('keydown', keyHandler);
    });
  }
  window.siteConfirm = siteConfirm;

  // ---- Override native alert ----
  // Legacy alert() calls become site toasts automatically.
  // We don't override confirm() because it's synchronous and
  // changing return semantics would break existing callers.
  const _nativeAlert = window.alert;
  window.alert = function (msg) {
    try {
      siteToast(String(msg ?? ''), { kind: 'warn', duration: 5500 });
    } catch (err) {
      // Fall back to native if our toast system errored
      _nativeAlert.call(window, msg);
    }
  };
})();
