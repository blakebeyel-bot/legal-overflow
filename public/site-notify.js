/**
 * site-notify — tiny browser-notification helper used across the
 * site so long-running async work (agent reviews, redline runs) can
 * ping the user when it finishes. Lets them upload a contract, walk
 * away to another tab, and come back when the work is done.
 *
 * Public API:
 *   window.siteNotify.permission()        // 'default' | 'granted' | 'denied' | 'unsupported'
 *   window.siteNotify.requestPermission() // → Promise<boolean granted>
 *   window.siteNotify.fire(title, opts)   // opts: { body, icon, tag, onClick, urgency }
 *   window.siteNotify.canFire()           // true if permission === 'granted'
 *
 * Notification clicks focus the existing tab and run an optional
 * onClick callback (typically a scroll-to-results or route change).
 *
 * Calling fire() without permission is a no-op — never throws. Use
 * requestPermission() at a USER-INITIATED moment (e.g. a click on
 * "Run review") so the browser actually shows the prompt.
 */
(function () {
  'use strict';

  const isSupported = typeof window !== 'undefined' && 'Notification' in window;

  function permission() {
    if (!isSupported) return 'unsupported';
    return Notification.permission;
  }

  function canFire() {
    return isSupported && Notification.permission === 'granted';
  }

  async function requestPermission() {
    if (!isSupported) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const result = await Notification.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  /**
   * Fire a notification. Returns the Notification instance (or null
   * if not supported / not permitted).
   *
   * @param {string} title — short imperative ("Review complete")
   * @param {object} opts
   * @param {string} [opts.body]   — second line, brief detail
   * @param {string} [opts.icon]   — icon URL (defaults to favicon)
   * @param {string} [opts.tag]    — same tag replaces previous notification
   * @param {Function} [opts.onClick] — runs on click after focusing window
   * @param {boolean}  [opts.urgency] — if true, requireInteraction so user must dismiss
   */
  function fire(title, opts = {}) {
    if (!canFire()) return null;
    const icon = opts.icon || (location.origin + '/favicon.svg');
    let n;
    try {
      n = new Notification(title, {
        body: opts.body || '',
        icon,
        tag: opts.tag || 'site-notify',
        requireInteraction: !!opts.urgency,
        silent: false,
      });
    } catch (err) {
      console.warn('siteNotify.fire failed:', err);
      return null;
    }
    n.onclick = (e) => {
      e.preventDefault();
      try { window.focus(); } catch {}
      try { if (typeof opts.onClick === 'function') opts.onClick(); } catch {}
      try { n.close(); } catch {}
    };
    // Auto-close after 12s unless urgency requested
    if (!opts.urgency) {
      setTimeout(() => { try { n.close(); } catch {} }, 12000);
    }
    return n;
  }

  window.siteNotify = { permission, canFire, requestPermission, fire };
})();
