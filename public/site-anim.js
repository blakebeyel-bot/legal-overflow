/* SANDBOX ANIMATION JS
 * Sandbox-only. Wires up the entrance + scroll + cursor effects defined
 * in sandbox-anim.css against existing markup. Vanilla JS, no deps.
 *
 * Everything is feature-detected and wrapped in try/catch so a broken
 * effect can't take the page down. Respects prefers-reduced-motion.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var prefersReduced =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----------------------------------------------------------
  // 1. Page-load curtain — paper sweep that lifts away
  // ----------------------------------------------------------
  function installCurtain() {
    if (prefersReduced) return;
    try {
      var curtain = document.createElement('div');
      curtain.className = 'sx-curtain';
      document.body.appendChild(curtain);
      // requestAnimationFrame x2 to ensure the starting transform is committed
      // before we transition to the lifted state.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          curtain.classList.add('sx-curtain-lift');
        });
      });
      // Remove from DOM after the transition so it doesn't capture clicks
      setTimeout(function () {
        if (curtain && curtain.parentNode) curtain.parentNode.removeChild(curtain);
      }, 800);
    } catch (e) { console.warn('[sandbox-anim] curtain failed:', e); }
  }

  // ----------------------------------------------------------
  // 2. Reading-progress bar
  // ----------------------------------------------------------
  function installProgressBar() {
    try {
      var bar = document.createElement('div');
      bar.className = 'sx-progress';
      document.body.appendChild(bar);

      var rafId = 0;
      var lastY = -1;
      function tick() {
        rafId = 0;
        var doc = document.documentElement;
        var max = doc.scrollHeight - window.innerHeight;
        var y = window.scrollY || doc.scrollTop;
        if (y === lastY) return;
        lastY = y;
        var p = max > 0 ? y / max : 0;
        bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, p)).toFixed(4) + ')';
      }
      function onScroll() {
        if (!rafId) rafId = requestAnimationFrame(tick);
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      tick();
    } catch (e) { console.warn('[sandbox-anim] progress bar failed:', e); }
  }

  // ----------------------------------------------------------
  // 3. Custom cursor accent
  //    Single floating dot that lerps toward the actual cursor.
  //    Grows when hovering interactive elements.
  // ----------------------------------------------------------
  function installCursor() {
    if (prefersReduced) return;
    var hasMouse = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!hasMouse) return;
    try {
      var dot = document.createElement('div');
      dot.className = 'sx-cursor';
      document.body.appendChild(dot);

      var tx = window.innerWidth / 2, ty = window.innerHeight / 2;
      var x = tx, y = ty;
      var raf = 0;

      function loop() {
        // ease-toward target — feels like the dot is following with weight
        x += (tx - x) * 0.22;
        y += (ty - y) * 0.22;
        dot.style.transform =
          'translate(' + x.toFixed(2) + 'px, ' + y.toFixed(2) + 'px) translate(-50%,-50%)';
        raf = requestAnimationFrame(loop);
      }
      raf = requestAnimationFrame(loop);

      window.addEventListener('mousemove', function (e) {
        tx = e.clientX;
        ty = e.clientY;
      }, { passive: true });

      // Grow over interactive elements
      var INTERACTIVE = 'a, button, [role="button"], input, textarea, select, .pillar-card, .skill-card, .article-card, .btn-primary, .btn-ghost, .btn';
      document.addEventListener('mouseover', function (e) {
        var t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest(INTERACTIVE)) dot.classList.add('sx-cursor-hover');
      });
      document.addEventListener('mouseout', function (e) {
        var t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest(INTERACTIVE)) dot.classList.remove('sx-cursor-hover');
      });
      document.addEventListener('mouseleave', function () {
        dot.style.opacity = '0';
      });
      document.addEventListener('mouseenter', function () {
        dot.style.opacity = '';
      });
    } catch (e) { console.warn('[sandbox-anim] cursor failed:', e); }
  }

  // ----------------------------------------------------------
  // 4. Hero title — per-line cascade
  //    The hero markup wraps each line in <span class="line">. We just
  //    add the "in" class right after first paint.
  // ----------------------------------------------------------
  function revealHero() {
    if (prefersReduced) return;
    try {
      // Slight delay to let the curtain start lifting first
      setTimeout(function () {
        var titles = document.querySelectorAll('.hero-title');
        titles.forEach(function (title) {
          title.classList.add('sx-title-in');
          title.querySelectorAll('.line').forEach(function (line) {
            line.classList.add('sx-line-in');
          });
        });
      }, 120);
    } catch (e) { console.warn('[sandbox-anim] hero reveal failed:', e); }
  }

  // ----------------------------------------------------------
  // 5. Scroll-triggered reveals
  //    Auto-tag well-known content sections with .sx-reveal /
  //    .sx-reveal-stagger so they animate in as they scroll into view.
  //    Then run an IntersectionObserver to toggle .sx-in-view.
  // ----------------------------------------------------------
  function installScrollReveals() {
    try {
      // Auto-mark common landmarks
      function mark(selector, opts) {
        opts = opts || {};
        document.querySelectorAll(selector).forEach(function (el) {
          if (opts.stagger) el.classList.add('sx-reveal-stagger');
          else el.classList.add('sx-reveal');
        });
      }
      // Section heads always reveal (single element)
      mark('.section-head');
      mark('.kicker');
      // Pillar/skill/article grids: each item gets staggered via .sx-reveal-stagger
      // applied to the parent container.
      var grids = [
        '.pillars-grid',
        '.skills-grid',
        '.articles-grid',
        '.featured-grid',
        '.tile-grid',
        '.svc-grid',
        '.section-list',
      ];
      grids.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          el.classList.add('sx-reveal-stagger');
        });
      });
      // Standalone cards / paragraphs anywhere on the page
      mark('.intro-text, .pillar-section-intro, .section-intro');

      if (!('IntersectionObserver' in window)) {
        // Fallback: just show everything
        document.querySelectorAll('.sx-reveal, .sx-reveal-stagger').forEach(function (el) {
          el.classList.add('sx-in-view');
        });
        return;
      }

      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('sx-in-view');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

      document.querySelectorAll('.sx-reveal, .sx-reveal-stagger').forEach(function (el) {
        io.observe(el);
      });
    } catch (e) { console.warn('[sandbox-anim] scroll reveals failed:', e); }
  }

  // ----------------------------------------------------------
  // 6. Magnetic CTA
  //    Apply gentle cursor-follow translation on .btn-primary.
  //    Capped magnitude so the button stays clickable.
  // ----------------------------------------------------------
  function installMagneticCTAs() {
    if (prefersReduced) return;
    try {
      var ctas = document.querySelectorAll('.btn-primary');
      ctas.forEach(function (cta) {
        cta.classList.add('sx-magnetic');
        var rafId = 0;
        var targetX = 0, targetY = 0;
        var curX = 0, curY = 0;
        function loop() {
          curX += (targetX - curX) * 0.25;
          curY += (targetY - curY) * 0.25;
          cta.style.transform = 'translate(' + curX.toFixed(2) + 'px,' + curY.toFixed(2) + 'px)';
          if (Math.abs(targetX - curX) > 0.1 || Math.abs(targetY - curY) > 0.1) {
            rafId = requestAnimationFrame(loop);
          } else {
            rafId = 0;
          }
        }
        cta.addEventListener('mousemove', function (e) {
          var r = cta.getBoundingClientRect();
          var dx = e.clientX - (r.left + r.width / 2);
          var dy = e.clientY - (r.top + r.height / 2);
          // Cap the magnetic pull
          targetX = Math.max(-12, Math.min(12, dx * 0.18));
          targetY = Math.max(-8, Math.min(8, dy * 0.22));
          if (!rafId) rafId = requestAnimationFrame(loop);
        });
        cta.addEventListener('mouseleave', function () {
          targetX = 0;
          targetY = 0;
          if (!rafId) rafId = requestAnimationFrame(loop);
        });
      });
    } catch (e) { console.warn('[sandbox-anim] magnetic CTAs failed:', e); }
  }

  // ----------------------------------------------------------
  // 7. Card lift
  //    Apply .sx-lift to existing cards so they get a subtle hover
  //    elevation. We only ADD the class — existing styles untouched.
  // ----------------------------------------------------------
  function installCardLift() {
    if (prefersReduced) return;
    try {
      var sels = '.pillar-card, .skill-card, .article-card, .featured-card, .tile';
      document.querySelectorAll(sels).forEach(function (el) {
        el.classList.add('sx-lift');
      });
    } catch (e) { console.warn('[sandbox-anim] card lift failed:', e); }
  }

  // ----------------------------------------------------------
  // 8. Smooth-scroll anchors
  // ----------------------------------------------------------
  function installSmoothScroll() {
    try {
      document.documentElement.style.scrollBehavior = 'smooth';
    } catch (e) { /* ignore */ }
  }

  // ----------------------------------------------------------
  // 9. Nav-link marquee swap
  //    Wrap each top-nav link's text in <span data-text="...">…</span>
  //    so CSS can roll the original up while a duplicate rolls in
  //    from below. Applied SELECTIVELY — only .nav-links a, not body
  //    text, hero headline, buttons, article cards, etc.
  // ----------------------------------------------------------
  function installNavMarquee() {
    if (prefersReduced) return;
    try {
      var links = document.querySelectorAll('.nav-links a');
      links.forEach(function (link) {
        // Skip if link contains non-text children (e.g., icons) — don't break those
        var hasOnlyText = link.children.length === 0 && link.textContent.trim().length > 0;
        if (!hasOnlyText) return;
        var text = link.textContent.trim();
        link.classList.add('sx-marquee-link');
        link.innerHTML = '';
        var span = document.createElement('span');
        span.className = 'sx-marquee-text';
        span.setAttribute('data-text', text);
        span.textContent = text;
        link.appendChild(span);
      });
    } catch (e) { console.warn('[sandbox-anim] nav marquee failed:', e); }
  }

  // ----------------------------------------------------------
  // 10. Section-title <em> character lift on hover
  //     Split each section-title's italic accent word into per-char
  //     spans so CSS can stagger their lift on hover. Doesn't touch
  //     surrounding non-em text — only the italic emphasis word.
  // ----------------------------------------------------------
  function installSectionTitleHover() {
    if (prefersReduced) return;
    try {
      var titles = document.querySelectorAll('.section-title');
      titles.forEach(function (title) {
        var ems = title.querySelectorAll('em');
        if (!ems.length) return;
        ems.forEach(function (em) {
          // Skip if already split
          if (em.querySelector('.sx-char')) return;
          var text = em.textContent;
          em.innerHTML = '';
          for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            var span = document.createElement('span');
            span.className = 'sx-char';
            span.textContent = ch === ' ' ? '\u00A0' : ch;
            em.appendChild(span);
          }
        });
        title.classList.add('sx-title-hover');
      });
    } catch (e) { console.warn('[sandbox-anim] section-title hover failed:', e); }
  }

  // ----------------------------------------------------------
  // 11. Hero background — layered animated decoration
  //     Injects .sx-hero-bg INSIDE each .hero, beneath .hero-grid.
  //     Layers: mesh, hairline grid, drifting dots, animated ink stroke.
  //     Each layer is purely decorative (pointer-events: none) and uses
  //     existing CSS variables for color so it stays on-palette.
  // ----------------------------------------------------------
  function installHeroBackground() {
    if (prefersReduced) return;
    try {
      var heroes = document.querySelectorAll('.hero');
      heroes.forEach(function (hero) {
        if (hero.querySelector('.sx-hero-bg')) return; // already installed

        var bg = document.createElement('div');
        bg.className = 'sx-hero-bg';
        bg.setAttribute('aria-hidden', 'true');

        // a) Mesh
        var mesh = document.createElement('div');
        mesh.className = 'sx-hero-mesh';
        bg.appendChild(mesh);

        // b) Grid
        var grid = document.createElement('div');
        grid.className = 'sx-hero-grid';
        bg.appendChild(grid);

        // c) Drifting dots
        var dots = document.createElement('div');
        dots.className = 'sx-hero-dots';
        // Stable seeded pattern — 14 dots
        for (var i = 0; i < 14; i++) {
          var dot = document.createElement('span');
          dot.className = 'sx-hd-dot' + (i % 3 === 0 ? ' accent' : '');
          var size = 3 + ((i * 7) % 6);
          dot.style.width = size + 'px';
          dot.style.height = size + 'px';
          dot.style.left = ((i * 73) % 95 + 2) + '%';
          dot.style.top = ((i * 53) % 88 + 6) + '%';
          dot.style.animationDuration = (5 + (i % 5) * 1.4).toFixed(2) + 's';
          dot.style.animationDelay = ((i * 0.7) % 6).toFixed(2) + 's';
          dots.appendChild(dot);
        }
        bg.appendChild(dots);

        // d) Animated ink stroke (SVG)
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'sx-hero-stroke');
        svg.setAttribute('viewBox', '0 0 1000 80');
        svg.setAttribute('preserveAspectRatio', 'none');
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d',
          'M 10 50 Q 130 10, 250 40 T 480 50 T 720 30 T 990 45');
        svg.appendChild(path);
        bg.appendChild(svg);

        // Insert as the FIRST child of .hero so it sits behind everything
        // (.hero-grid is z:2 in styles.css; .sx-hero-bg is z:1)
        hero.insertBefore(bg, hero.firstChild);
      });
    } catch (e) { console.warn('[sandbox-anim] hero background failed:', e); }
  }

  // ----------------------------------------------------------
  // Boot
  // ----------------------------------------------------------
  // ----------------------------------------------------------
  // 11.5 Big-header entrance animations across all pages
  //      Targets every page-level header and triggers the same
  //      cascade-fade pattern the hero already uses.
  //        - .about-title  (about + agents pages): split on <br> into
  //          .sx-line spans, then add .sx-title-in to cascade lines
  //        - .article-title (article reader): single-line fade up,
  //          then sibling .article-dek follows
  //        - .section-title (homepage h2s): adds .sx-title-in on view
  //          to drive the entrance wave on the italic <em> chars
  // ----------------------------------------------------------
  function installBigHeaderAnimations() {
    if (prefersReduced) return;
    try {
      // .about-title — split on <br>
      document.querySelectorAll('.about-title').forEach(function (h1) {
        if (h1.dataset.sxLined) return;
        h1.dataset.sxLined = '1';
        // Split on <br> while preserving inline children (em, strong)
        var html = h1.innerHTML;
        // Normalize <br>, <br/>, <br /> to a single token
        var parts = html.split(/<br\s*\/?>/i).map(function (p) { return p.trim(); });
        if (parts.length <= 1) {
          // No <br> — wrap whole content in one .sx-line so it still cascades
          h1.innerHTML = '<span class="sx-line">' + html + '</span>';
        } else {
          h1.innerHTML = parts
            .map(function (p) { return '<span class="sx-line">' + p + '</span>'; })
            .join('');
        }
        // Trigger soon after first paint (hero h1, in-view at boot)
        setTimeout(function () { h1.classList.add('sx-title-in'); }, 140);
      });

      // .article-title (and its dek sibling)
      document.querySelectorAll('.article-title').forEach(function (h1) {
        // first-paint trigger
        setTimeout(function () {
          h1.classList.add('sx-title-in');
          // also reveal a dek if present in the same hero
          var hero = h1.closest('.article-hero, header, section') || h1.parentElement;
          if (hero) {
            var dek = hero.querySelector('.article-dek');
            if (dek) setTimeout(function () { dek.classList.add('sx-title-in'); }, 480);
          }
        }, 140);
      });

      // .section-title — animate when the title enters the viewport
      var titles = document.querySelectorAll('.section-title');
      if (titles.length && 'IntersectionObserver' in window) {
        var ioT = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) {
              e.target.classList.add('sx-title-in');
              ioT.unobserve(e.target);
            }
          });
        }, { threshold: 0.3, rootMargin: '0px 0px -10% 0px' });
        titles.forEach(function (t) { ioT.observe(t); });
      } else {
        // No IntersectionObserver — show all
        titles.forEach(function (t) { t.classList.add('sx-title-in'); });
      }
    } catch (e) { console.warn('[sandbox-anim] big header animations failed:', e); }
  }

  // ----------------------------------------------------------
  // 12. Page-specific scroll motifs
  //     Each page gets a distinct scroll moment that fits the editorial
  //     aesthetic. Restraint > kitchen sink — one or two motifs per
  //     page max.
  // ----------------------------------------------------------
  function installPageMotif() {
    var path = (location.pathname || '/').toLowerCase().replace(/\/+$/, '') || '/';
    try {
      if (path === '/' || path === '/index') return installHomeMotif();
      if (/^\/about/.test(path)) return installAboutMotif();
      if (/^\/articles\//.test(path)) return installArticleMotif();
      if (path === '/agents') return installAgentsMotif();
      if (/^\/agents\/contract-review/.test(path)) return; // skip — heavy UI page
      if (/^\/login|^\/signup/.test(path)) return installAuthMotif();
    } catch (e) {
      console.warn('[sandbox-anim] page motif failed:', e);
    }
  }

  // ----------- Home: sticky section ticker (top-right corner) ------------
  function installHomeMotif() {
    if (prefersReduced) return;
    var sections = Array.from(document.querySelectorAll('main section, body > section'));
    if (!sections.length) return;

    // Build the ticker
    var ticker = document.createElement('div');
    ticker.className = 'sx-ticker';
    ticker.innerHTML =
      '<span class="sx-ticker-dot" aria-hidden="true"></span>' +
      '<span class="sx-ticker-label">SCROLLING</span>' +
      '<span class="sx-ticker-sep">·</span>' +
      '<span class="sx-ticker-name">Hero</span>';
    document.body.appendChild(ticker);
    var nameEl = ticker.querySelector('.sx-ticker-name');

    // Map each section to a friendly display name
    function sectionName(sec) {
      var byId = sec.id || '';
      var titleEl = sec.querySelector('.section-title, h1, h2');
      var byTitle = titleEl ? (titleEl.textContent || '').trim().split(/\s+/).slice(0, 3).join(' ') : '';
      if (byId === 'articles') return 'Resources';
      if (byId === 'skills')   return 'Skills';
      if (byId === 'services') return 'Services';
      if (byId === 'pillars')  return 'How it works';
      if (byId === 'subscribe')return 'Subscribe';
      if (byTitle) return byTitle;
      if (sec.classList.contains('hero')) return 'Hero';
      return '—';
    }

    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      // Pick the most-intersecting section among visible ones
      var best = null;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
      });
      if (best && nameEl) {
        var name = sectionName(best.target);
        if (nameEl.textContent !== name) {
          nameEl.style.opacity = '0';
          setTimeout(function () {
            nameEl.textContent = name;
            nameEl.style.opacity = '';
          }, 140);
        }
      }
    }, { threshold: [0.15, 0.35, 0.55, 0.75], rootMargin: '-30% 0px -30% 0px' });
    sections.forEach(function (s) { io.observe(s); });

    // Section number subtle bounce on enter
    var nums = document.querySelectorAll('.section-num');
    if ('IntersectionObserver' in window && nums.length) {
      var io2 = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('sx-num-bounce');
            io2.unobserve(e.target);
          }
        });
      }, { threshold: 0.3 });
      nums.forEach(function (n) { io2.observe(n); });
    }
  }

  // ----------- About: portrait Ken Burns + word reveal + count-up --------
  function installAboutMotif() {
    if (prefersReduced) return;

    // Ken Burns on the portrait — subtle scale + drift while in view
    var portrait = document.querySelector('.about-portrait img, .about-portrait');
    if (portrait && 'IntersectionObserver' in window) {
      var ioPortrait = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('sx-kenburns');
          }
        });
      }, { threshold: 0.15 });
      ioPortrait.observe(portrait);
    }

    // Lead-paragraph word reveal (first <p> in .about-bio)
    var leadP = document.querySelector('.about-bio p');
    if (leadP && !leadP.dataset.sxSplit) {
      leadP.dataset.sxSplit = '1';
      var html = leadP.innerHTML;
      // Split text nodes only — preserve inline tags like <em>, <strong>
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      function splitNode(node) {
        if (node.nodeType === 3) {
          var frag = document.createDocumentFragment();
          var words = node.textContent.split(/(\s+)/);
          words.forEach(function (w) {
            if (!w) return;
            if (/^\s+$/.test(w)) {
              frag.appendChild(document.createTextNode(w));
            } else {
              var sp = document.createElement('span');
              sp.className = 'sx-word';
              sp.textContent = w;
              frag.appendChild(sp);
            }
          });
          node.parentNode.replaceChild(frag, node);
        } else if (node.nodeType === 1) {
          Array.from(node.childNodes).forEach(splitNode);
        }
      }
      Array.from(tmp.childNodes).forEach(splitNode);
      leadP.innerHTML = tmp.innerHTML;

      if ('IntersectionObserver' in window) {
        var ioLead = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) {
              e.target.classList.add('sx-words-in');
              ioLead.unobserve(e.target);
            }
          });
        }, { threshold: 0.25 });
        ioLead.observe(leadP);
      }
    }

    // Count-up on .about-fact .f-n numbers
    var nums = document.querySelectorAll('.about-fact .f-n');
    if (nums.length && 'IntersectionObserver' in window) {
      var ioNums = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          ioNums.unobserve(e.target);
          var el = e.target;
          var text = (el.textContent || '').trim();
          // parse "5+", "15M", "1.4K", "12+", etc.
          var m = text.match(/^([0-9]+(?:\.[0-9]+)?)([^\d]*)$/);
          if (!m) return;
          var target = parseFloat(m[1]);
          var suffix = m[2] || '';
          var startTs = performance.now();
          var dur = 1300;
          (function tick(now) {
            var p = Math.min(1, (now - startTs) / dur);
            var eased = 1 - Math.pow(1 - p, 3);
            var v = target * eased;
            el.textContent = (target < 10 && /\./.test(m[1]) ? v.toFixed(1) : Math.round(v)) + suffix;
            if (p < 1) requestAnimationFrame(tick);
          })(performance.now());
        });
      }, { threshold: 0.4 });
      nums.forEach(function (n) { ioNums.observe(n); });
    }
  }

  // ----------- Agents: drop-cap on first letter of each bio paragraph ----
  function installAgentsMotif() {
    if (prefersReduced) return;
    var paragraphs = document.querySelectorAll('.about-bio p');
    if (!paragraphs.length || !('IntersectionObserver' in window)) return;
    paragraphs.forEach(function (p) {
      // Wrap the first character in a drop-cap span (text-only first char)
      if (p.dataset.sxDropcap) return;
      p.dataset.sxDropcap = '1';
      var first = p.firstChild;
      if (!first || first.nodeType !== 3) return;
      var txt = first.textContent;
      if (!txt) return;
      var idx = txt.search(/\S/);
      if (idx < 0) return;
      var ch = txt.charAt(idx);
      var rest = txt.slice(idx + 1);
      var pre = txt.slice(0, idx);
      first.textContent = pre;
      var cap = document.createElement('span');
      cap.className = 'sx-dropcap';
      cap.textContent = ch;
      p.insertBefore(cap, first.nextSibling);
      var tail = document.createTextNode(rest);
      p.insertBefore(tail, cap.nextSibling);
    });
    var ioCap = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          var caps = e.target.querySelectorAll('.sx-dropcap');
          caps.forEach(function (c) { c.classList.add('sx-dropcap-in'); });
          ioCap.unobserve(e.target);
        }
      });
    }, { threshold: 0.3 });
    paragraphs.forEach(function (p) { ioCap.observe(p); });
  }

  // ----------- Article: side-margin section numbers + blockquote tilt ----
  function installArticleMotif() {
    if (prefersReduced) return;
    var prose = document.querySelector('.article-prose');
    if (!prose) return;

    // Side-margin large mono numerals on each h2
    var h2s = prose.querySelectorAll('h2');
    h2s.forEach(function (h, idx) {
      if (h.dataset.sxNumed) return;
      h.dataset.sxNumed = '1';
      var n = document.createElement('span');
      n.className = 'sx-h2-num';
      n.textContent = String(idx + 1).padStart(2, '0');
      h.insertBefore(n, h.firstChild);
    });
    if ('IntersectionObserver' in window) {
      var ioH2 = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('sx-h2-in');
            ioH2.unobserve(e.target);
          }
        });
      }, { threshold: 0.4 });
      h2s.forEach(function (h) { ioH2.observe(h); });
    }

    // Subtle parallax tilt on blockquotes (scroll-driven)
    var quotes = prose.querySelectorAll('blockquote');
    if (quotes.length) {
      var raf = 0;
      function tilt() {
        raf = 0;
        var vh = window.innerHeight;
        quotes.forEach(function (q) {
          var r = q.getBoundingClientRect();
          var center = r.top + r.height / 2;
          var t = (center - vh / 2) / (vh / 2); // -1 (above viewport) → 1 (below)
          var clamped = Math.max(-1, Math.min(1, t));
          q.style.transform = 'rotate(' + (clamped * -0.6).toFixed(2) + 'deg) translateY(' + (clamped * 6).toFixed(2) + 'px)';
        });
      }
      window.addEventListener('scroll', function () {
        if (!raf) raf = requestAnimationFrame(tilt);
      }, { passive: true });
      window.addEventListener('resize', function () {
        if (!raf) raf = requestAnimationFrame(tilt);
      }, { passive: true });
      tilt();
    }
  }

  // ----------- Auth: focus-ring pulse on inputs --------------------------
  function installAuthMotif() {
    try {
      // Inject a soft animated mesh background behind the auth-wrap if any.
      // Falls back to body if the wrap class isn't present.
      var holder = document.querySelector('.auth-wrap, body > main') || document.body;
      if (holder && !holder.querySelector('.sx-auth-mesh')) {
        var mesh = document.createElement('div');
        mesh.className = 'sx-auth-mesh';
        mesh.setAttribute('aria-hidden', 'true');
        holder.insertBefore(mesh, holder.firstChild);
      }
      // Add focus pulse class to text inputs
      document.querySelectorAll('input[type="email"], input[type="password"], input[type="text"]').forEach(function (input) {
        input.classList.add('sx-input-pulse');
      });
    } catch (e) { console.warn('[sandbox-anim] auth motif failed:', e); }
  }

  // ----------------------------------------------------------
  // Mobile nav — hamburger button + slide-in overlay menu.
  //   Injects markup once per page so all 7 .astro files don't
  //   each need to declare their own. Reads the existing
  //   .nav-links to mirror exactly what desktop sees, plus the
  //   Subscribe CTA from .nav-sub.
  // ----------------------------------------------------------
  function installMobileNav() {
    try {
      var nav = document.querySelector('header.nav, .nav');
      if (!nav) return;
      // Idempotent — don't add twice.
      if (nav.querySelector('.nav-toggle')) return;

      // Build hamburger button.
      var btn = document.createElement('button');
      btn.className = 'nav-toggle';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Open menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', 'nav-mobile');
      btn.innerHTML = '<span class="nav-toggle-bars" aria-hidden="true"><span></span></span>';

      var navRight = nav.querySelector('.nav-right');
      if (navRight) {
        navRight.appendChild(btn);
      } else {
        nav.appendChild(btn);
      }

      // Build mobile menu overlay. Mirror the desktop nav-links + a Subscribe CTA.
      var overlay = document.createElement('nav');
      overlay.className = 'nav-mobile';
      overlay.id = 'nav-mobile';
      overlay.setAttribute('aria-label', 'Mobile navigation');
      var sourceLinks = nav.querySelectorAll('.nav-links a');
      sourceLinks.forEach(function (a) {
        var clone = document.createElement('a');
        // Strip marquee wrapping so the mobile menu shows plain text.
        clone.textContent = a.textContent.trim();
        clone.href = a.getAttribute('href') || '#';
        if (a.hasAttribute('aria-current')) clone.setAttribute('aria-current', a.getAttribute('aria-current'));
        overlay.appendChild(clone);
      });
      // Footer block: live dot + clock + Subscribe CTA.
      var liveDot = nav.querySelector('.live-dot');
      var navMeta = nav.querySelector('.nav-meta');
      if (liveDot || navMeta) {
        var meta = document.createElement('div');
        meta.className = 'nav-mobile-meta';
        if (liveDot) {
          var dot = document.createElement('span');
          dot.className = 'live-dot';
          meta.appendChild(dot);
        }
        if (navMeta) {
          var metaText = document.createElement('span');
          metaText.id = 'nav-mobile-clock';
          metaText.textContent = navMeta.textContent;
          meta.appendChild(metaText);
        }
        overlay.appendChild(meta);
      }
      var navSub = nav.querySelector('.nav-sub');
      if (navSub) {
        var cta = document.createElement('a');
        cta.className = 'nav-mobile-cta';
        cta.href = navSub.getAttribute('href') || '#subscribe';
        cta.textContent = navSub.textContent.trim() || 'Subscribe';
        overlay.appendChild(cta);
      }
      document.body.appendChild(overlay);

      function closeMenu() {
        document.body.classList.remove('nav-open');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-label', 'Open menu');
      }
      function openMenu() {
        document.body.classList.add('nav-open');
        btn.setAttribute('aria-expanded', 'true');
        btn.setAttribute('aria-label', 'Close menu');
      }

      btn.addEventListener('click', function () {
        if (document.body.classList.contains('nav-open')) closeMenu();
        else openMenu();
      });

      // Click any link in the overlay → close
      overlay.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.tagName === 'A') closeMenu();
      });

      // Esc key closes
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && document.body.classList.contains('nav-open')) closeMenu();
      });

      // If viewport widens past breakpoint, close the overlay so we don't get
      // stuck with a blocked scroll on desktop.
      var mq = window.matchMedia('(min-width: 961px)');
      var handler = function (e) { if (e.matches) closeMenu(); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else mq.addListener(handler);

      // Mirror the desktop clock into the mobile menu's meta text
      var srcClock = document.getElementById('nav-clock');
      var dstClock = document.getElementById('nav-mobile-clock');
      if (srcClock && dstClock) {
        var observer = new MutationObserver(function () {
          dstClock.textContent = srcClock.textContent;
        });
        observer.observe(srcClock, { characterData: true, childList: true, subtree: true });
      }
    } catch (e) { console.warn('[sandbox-anim] mobile nav failed:', e); }
  }

  function boot() {
    installCurtain();
    installProgressBar();
    installCursor();
    installNavMarquee();
    installMobileNav();
    installSectionTitleHover();
    installHeroBackground();
    revealHero();
    installBigHeaderAnimations();
    installScrollReveals();
    installMagneticCTAs();
    installCardLift();
    installSmoothScroll();
    installPageMotif();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
