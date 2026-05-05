/**
 * Site bootstrap — page fade-in + auto-hiding nav.
 *
 * Two responsibilities:
 *
 * 1) Page fade-in (RUNS ON EVERY PAGE, INCLUDING HOMEPAGE):
 *    Adds `page-ready` class on <body> after DOMContentLoaded. CSS
 *    in styles.css starts body at opacity 0 and transitions to 1
 *    when this class is added. Eliminates the "blank flash → pop-in
 *    of content" feel during navigation.
 *
 * 2) Auto-hiding top nav (SKIPS HOMEPAGE):
 *    Reveals the nav when the cursor is near the top of the viewport
 *    or any user activity occurs; collapses after sustained inactivity.
 *    Adds `nav-autohide` class to <body> for CSS targeting.
 *
 * Drop into <head>:
 *   <script src="/nav-autohide.js" defer></script>
 */
(function () {
  if (typeof document === 'undefined') return;

  // ---- Page fade-in (always on) ----
  // Adds `page-ready` to <body> once the DOM is parsed AND any
  // auth-gate visibility lock has been released. Workspace pages
  // commonly do `body.style.visibility = 'hidden'` while running an
  // auth check, then clear it on success. To make THOSE pages also
  // fade in, we delay adding `page-ready` until the visibility lock
  // is gone — observed via MutationObserver on body's style attr.
  function markPageReady() {
    const hidden = document.body.style.visibility === 'hidden';
    if (!hidden) {
      document.body.classList.add('page-ready');
      return;
    }
    // Visibility-hidden gate is active. Wait for it to clear.
    const obs = new MutationObserver(() => {
      if (document.body.style.visibility !== 'hidden') {
        obs.disconnect();
        // requestAnimationFrame so the browser commits the
        // visibility change before we trigger the opacity transition;
        // otherwise the transition is skipped and the body just
        // appears at opacity 1 immediately.
        requestAnimationFrame(() => {
          document.body.classList.add('page-ready');
        });
      }
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ['style'] });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(markPageReady), { once: true });
  } else {
    requestAnimationFrame(markPageReady);
  }

  // ---- Auto-hiding nav (skipped on homepage) ----
  if (location.pathname === '/' || location.pathname === '/index.html') return;

  // Defensive: don't double-init if loaded twice.
  if (document.body.dataset.navAutohideLoaded === '1') return;
  document.body.dataset.navAutohideLoaded = '1';

  // Mark the body so CSS rules know to apply the slide-out.
  document.body.classList.add('nav-autohide');

  const TOP_ZONE = 110;
  const INACTIVITY_HIDE_MS = 4500;
  const FIRST_HIDE_DELAY = 2500;

  let lastActivityAt = Date.now();
  let inactivityTimer = null;
  let initialHideTimer = null;
  let cursorOverNav = false;
  let navHasFocus = false;

  function isNavVisible() {
    return !document.body.classList.contains('nav-collapsed');
  }
  function showNav() {
    if (initialHideTimer) { clearTimeout(initialHideTimer); initialHideTimer = null; }
    document.body.classList.remove('nav-collapsed');
    bumpActivity();
  }
  function hideNavNow() {
    if (cursorOverNav || navHasFocus) return;
    document.body.classList.add('nav-collapsed');
  }
  function bumpActivity() {
    lastActivityAt = Date.now();
  }
  function startInactivityWatch() {
    if (inactivityTimer) clearInterval(inactivityTimer);
    inactivityTimer = setInterval(() => {
      if (!isNavVisible()) return;
      if (Date.now() - lastActivityAt >= INACTIVITY_HIDE_MS) hideNavNow();
    }, 1000);
  }
  startInactivityWatch();

  // Initial collapse — show on load, then hide after a moment so the
  // user notices the nav exists before it slides away.
  initialHideTimer = setTimeout(() => {
    if (isNavVisible() && !cursorOverNav && !navHasFocus) {
      document.body.classList.add('nav-collapsed');
    }
    initialHideTimer = null;
  }, FIRST_HIDE_DELAY);

  // Activity sources — every one resets the inactivity clock. Mouse
  // near the top zone *also* reveals the nav.
  window.addEventListener('mousemove', (e) => {
    bumpActivity();
    if (e.clientY <= TOP_ZONE) showNav();
  });
  window.addEventListener('keydown', bumpActivity);
  window.addEventListener('scroll', bumpActivity, { passive: true });
  window.addEventListener('click', bumpActivity);
  window.addEventListener('touchstart', (e) => {
    bumpActivity();
    const y = e.touches?.[0]?.clientY ?? Infinity;
    if (y <= TOP_ZONE) showNav();
  }, { passive: true });

  // Cursor leaves the window → grace period before hiding.
  document.addEventListener('mouseleave', () => {
    setTimeout(() => {
      if (!cursorOverNav && !navHasFocus && Date.now() - lastActivityAt >= 1500) {
        hideNavNow();
      }
    }, 1500);
  });

  // Keep nav visible while cursor over it OR focus inside it.
  function bindNav() {
    const navEl = document.querySelector('.nav');
    if (!navEl) {
      // Nav not yet in DOM (script loaded before HTML parsed) — try
      // again on DOMContentLoaded.
      document.addEventListener('DOMContentLoaded', bindNav, { once: true });
      return;
    }
    navEl.addEventListener('mouseenter', () => { cursorOverNav = true; showNav(); });
    navEl.addEventListener('mouseleave', () => { cursorOverNav = false; bumpActivity(); });
    navEl.addEventListener('focusin',   () => { navHasFocus = true; showNav(); });
    navEl.addEventListener('focusout',  () => { navHasFocus = false; bumpActivity(); });
  }
  bindNav();
})();
