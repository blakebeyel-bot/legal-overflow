// ============ clock ============
(function clock() {
  const el = document.getElementById('nav-clock');
  if (!el) return;
  function tick() {
    const d = new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    el.textContent = `NYC · ${h}:${mm} ${ampm}`;
  }
  tick();
  setInterval(tick, 1000);
})();

// ============ cursor dot ============
(function cursor() {
  const dot = document.getElementById('cursor-dot');
  if (!dot) return;
  let x = window.innerWidth / 2, y = window.innerHeight / 2, tx = x, ty = y;
  window.addEventListener('mousemove', (e) => { tx = e.clientX; ty = e.clientY; });
  function loop() {
    x += (tx - x) * 0.18;
    y += (ty - y) * 0.18;
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    requestAnimationFrame(loop);
  }
  loop();
  document.querySelectorAll('a, button, .card, .series-card, input').forEach(el => {
    el.addEventListener('mouseenter', () => dot.classList.add('grow'));
    el.addEventListener('mouseleave', () => dot.classList.remove('grow'));
  });
})();

// ============ reveal on scroll ============
(function reveal() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
})();

// ============ count-up stats ============
(function count() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target;
      const target = parseInt(el.getAttribute('data-count'), 10);
      if (isNaN(target)) return;
      const dur = 1400;
      const start = performance.now();
      function tick(t) {
        const p = Math.min(1, (t - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      io.unobserve(el);
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('[data-count]').forEach(el => io.observe(el));
})();

// ============ neural graph canvas ============
(function graph() {
  const canvas = document.getElementById('graph');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, DPR = Math.min(window.devicePixelRatio || 1, 2);
  const nodes = [];
  const N = 44;
  let mouseX = -9999, mouseY = -9999;

  function resize() {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  function init() {
    nodes.length = 0;
    for (let i = 0; i < N; i++) {
      nodes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: Math.random() * 1.4 + 0.6,
        hub: Math.random() < 0.12
      });
    }
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    // lines
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      a.x += a.vx; a.y += a.vy;
      if (a.x < 0 || a.x > W) a.vx *= -1;
      if (a.y < 0 || a.y > H) a.vy *= -1;

      // mouse repulsion (very slight)
      const mdx = a.x - mouseX, mdy = a.y - mouseY;
      const md2 = mdx*mdx + mdy*mdy;
      if (md2 < 140*140) {
        const f = 0.4 * (1 - Math.sqrt(md2) / 140);
        a.x += (mdx/Math.sqrt(md2||1)) * f;
        a.y += (mdy/Math.sqrt(md2||1)) * f;
      }

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx*dx + dy*dy;
        const max = 180;
        if (d2 < max*max) {
          const alpha = (1 - Math.sqrt(d2)/max) * 0.22;
          ctx.strokeStyle = `rgba(14,21,18,${alpha})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    // nodes
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.hub ? 'rgba(10,125,87,.85)' : 'rgba(14,21,18,.45)';
      ctx.fill();
      if (n.hub) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(16,185,129,.35)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize', () => { resize(); });
  window.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouseX = e.clientX - r.left; mouseY = e.clientY - r.top;
  });
  window.addEventListener('mouseleave', () => { mouseX = -9999; mouseY = -9999; });
  resize(); init(); draw();
})();

// ============ hero title wrap ============
(function wrap() {
  document.querySelectorAll('.hero-title .line').forEach(line => {
    const inner = line.innerHTML;
    line.innerHTML = `<span>${inner}</span>`;
  });
})();

// ============ "model trace" teletype ============
(function trace() {
  const el = document.getElementById('trace');
  if (!el) return;
  const lines = [
    '> parsing opinion',
    '> extracting holdings',
    '> 3 citations · 0 flags',
    '> drafting memo §1',
    '> confidence 0.94',
    '> tokens 18,204',
    '> awaiting human ✓',
    '> ready.',
  ];
  let i = 0, j = 0, current = '';
  function step() {
    if (j <= lines[i].length) {
      current = lines.slice(0, i).join('\n') + (i > 0 ? '\n' : '') + lines[i].slice(0, j);
      el.textContent = current;
      j++;
      setTimeout(step, 30 + Math.random() * 40);
    } else {
      i++;
      j = 0;
      if (i >= lines.length) {
        setTimeout(() => { i = 0; el.textContent = ''; step(); }, 2400);
      } else {
        setTimeout(step, 220);
      }
    }
  }
  step();
})();
