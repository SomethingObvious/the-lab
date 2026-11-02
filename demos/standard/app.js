(() => {
  const lab = window.lab;
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const list = $('list');
  const thread = $('thread');
  const input = $('input');
  const sendBtn = $('send');
  const wide = matchMedia('(min-width: 700px)');

  // Conversation model, rebuilt from the event stream.
  const timeline = [];   // { type: 'req', req } | { type: 'notice', ev }
  const asks = new Map();
  const stepsByRef = new Map();
  let current = null;
  let link = { state: 'connecting', detail: 'Reaching the Mac' };
  let status = { working: false, label: '', since: null };
  let outbox = [];
  let lastId = 0;
  const openReqs = new Set();
  const openSteps = new Set();
  let selected = null;
  let picked = false;
  let readyCalled = false;

  function newReq(ev) {
    const req = { id: ev ? ev.id : 'pre', you: ev, items: [], steps: [], done: null };
    timeline.push({ type: 'req', req });
    current = req;
    return req;
  }

  function apply(e) {
    switch (e.kind) {
      case 'link': link = e; return 'chrome';
      case 'status': status = e; return 'chrome';
      case 'outbox': outbox = e.items || []; return 'list';
      case 'insets': return null;
    }
    if (typeof e.id === 'number') {
      if (e.id <= lastId) return null;
      lastId = e.id;
    }
    switch (e.kind) {
      case 'you': newReq(e); break;
      case 'step': {
        const req = current || newReq(null);
        const step = { ...e, failed: null };
        req.steps.push(step);
        stepsByRef.set(e.ref, step);
        break;
      }
      case 'failed': {
        const step = stepsByRef.get(e.ref);
        if (step) step.failed = e.text;
        break;
      }
      case 'ask': {
        const a = { ev: e, answer: null };
        asks.set(e.ref, a);
        (current || newReq(null)).items.push({ kind: 'ask', a });
        break;
      }
      case 'answered': {
        const a = asks.get(e.ref);
        if (a) a.answer = e;
        break;
      }
      case 'reply':
      case 'file':
        (current || newReq(null)).items.push(e);
        break;
      case 'done':
        if (current) { current.done = e; current = null; }
        break;
      case 'notice':
        timeline.push({ type: 'notice', ev: e });
        break;
      default:
        return null;
    }
    return 'list';
  }

  // Safe markdown: everything is escaped first, then a small set of marks is
  // turned back into elements.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext>$1</a>');
  }
  function md(src) {
    const out = [];
    const parts = esc(src).split(/```[^\n]*\n?/);
    parts.forEach((part, i) => {
      if (i % 2) { out.push(`<pre><code>${part.replace(/\n$/, '')}</code></pre>`); return; }
      for (const block of part.split(/\n{2,}/)) {
        const b = block.trim();
        if (!b) continue;
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*] /.test(l))) out.push(`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`);
        else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) out.push(`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ''))}</li>`).join('')}</ol>`);
        else out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
      }
    });
    return out.join('');
  }

  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const size = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const icon = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  function toolIcon(tool) {
    if (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor') return 'term';
    if (tool === 'Read') return 'file';
    if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return 'edit';
    if (/^(Glob|Grep|WebSearch)$/.test(tool)) return 'search';
    if (tool === 'WebFetch' || tool.startsWith('mcp__claude-in-chrome__')) return 'globe';
    if (tool === 'mcp__lab__send_to_phone') return 'phone';
    if (tool === 'TodoWrite') return 'plan';
    return 'tool';
  }
  const toolLabel = (tool) => tool.replace(/^mcp__claude-in-chrome__/, 'Chrome ').replace(/^mcp__lab__/, 'The Lab ').replace(/^mcp__/, '').replace(/__/g, ' ');

  function stepsHtml(req) {
    return req.steps.map((s) => `
      <li class="step${s.sub ? ' sub' : ''}${s.failed ? ' failed' : ''}${openSteps.has(s.ref) ? ' open' : ''}">
        <button type="button" class="step-head" data-step="${esc(s.ref)}" aria-expanded="${openSteps.has(s.ref)}">
          ${icon(s.failed ? 'alert' : toolIcon(s.tool))}
          <span class="step-title">${esc(s.title)}</span>
          <span class="step-time">${clock(s.at)}</span>
        </button>
        <div class="step-body">
          <p class="tool-name">${esc(toolLabel(s.tool))}</p>
          ${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}
          ${s.failed ? `<p class="step-fail">${esc(s.failed)}</p>` : ''}
        </div>
      </li>`).join('');
  }

  const isLive = (req) => !req.done && req === current && status.working;

  function stepsRow(req) {
    const n = req.steps.length;
    const live = isLive(req);
    if (!n && !live) return '';
    const expanded = wide.matches ? selected === req.id : openReqs.has(req.id);
    const attr = wide.matches ? `aria-pressed="${expanded}"` : `aria-expanded="${expanded}"`;
    const label = live
      ? `<span class="spin" aria-hidden="true"></span><span class="live-label">${esc(status.label || 'Working')}</span><span class="elapsed" data-since="${esc(status.since || '')}">${status.since ? dur(Date.now() - Date.parse(status.since)) : ''}</span>`
      : `${n} ${n === 1 ? 'step' : 'steps'}${req.done ? ` <span class="elapsed">${dur(req.done.ms)}</span>` : ''}`;
    return `<button type="button" class="steps-row${live ? ' live' : ''}" data-req="${req.id}" ${attr}>${label}${n ? icon('chev', 'chev') : ''}</button>
      <ol class="steps${!wide.matches && expanded ? ' open' : ''}">${stepsHtml(req)}</ol>`;
  }

  function reqHtml(req, prevAt) {
    const parts = [];
    if (req.you) {
      const at = Date.parse(req.you.at);
      if (!prevAt || at - prevAt > 30 * 60000) parts.push(`<p class="when">${new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</p>`);
      parts.push(`<div class="you">${esc(req.you.text)}</div>`);
    }
    const resp = [];
    for (const it of req.items) {
      if (it.kind === 'reply') resp.push(`<div class="md">${md(it.text)}</div>`);
      else if (it.kind === 'file') resp.push(`
        <button type="button" class="file" data-open="${esc(it.url)}">
          <span class="badge">${icon('file')}</span>
          <span><span class="file-name">${esc(it.name)}</span><br><span class="file-meta">${esc(it.caption || size(it.size || 0))}</span></span>
        </button>`);
      else if (it.kind === 'ask') {
        const { ev, answer } = it.a;
        if (answer) resp.push(`<p class="answered ${answer.allow ? 'yes' : 'no'}">${icon(answer.allow ? 'check' : 'x')}${answer.allow ? 'Allowed' : 'Denied'}: ${esc(ev.title.replace(/\?$/, ''))}</p>`);
        else resp.push(`
          <section class="ask" aria-label="Needs your go-ahead">
            <div class="ask-head">${icon('shield')}<div><h3>${esc(ev.title)}</h3>${ev.detail ? `<pre>${esc(ev.detail)}</pre>` : ''}</div></div>
            <div class="ask-actions">
              <button type="button" class="btn text" data-answer="${esc(ev.ref)}" data-allow="0">Deny</button>
              <button type="button" class="btn filled" data-answer="${esc(ev.ref)}" data-allow="1">Allow</button>
            </div>
          </section>`);
      }
    }
    // Steps sit under the reply once there is one, and lead while it's still working.
    const row = stepsRow(req);
    const hasReply = req.items.some((i) => i.kind === 'reply');
    if (hasReply) resp.push(row); else resp.unshift(row);
    if (req.done && req.done.stopped) resp.push(`<p class="result">${icon('stop', 'sm')}Stopped after ${dur(req.done.ms)}</p>`);
    else if (req.done && !req.done.ok) resp.push(`<p class="result err">${icon('alert', 'sm')}${esc(req.done.error || 'It ended with an error.')}</p>`);
    const body = resp.filter(Boolean).join('');
    if (body) parts.push(`<div class="resp">${body}</div>`);
    return `<article class="req">${parts.join('')}</article>`;
  }

  function renderList() {
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    const html = [];
    let prevAt = 0;
    for (const t of timeline) {
      if (t.type === 'req') {
        html.push(reqHtml(t.req, prevAt));
        if (t.req.you) prevAt = Date.parse(t.req.you.at);
      } else {
        const a = t.ev.action;
        html.push(`<div class="notice">${icon('info')}<p>${esc(t.ev.text)}</p>${a ? `<button type="button" class="btn tonal" data-send="${esc(a.send)}">${esc(a.label)}</button>` : ''}</div>`);
      }
    }
    for (const m of outbox) {
      html.push(`<article class="req"><div class="you pending">${esc(m.text)}</div><p class="you-meta">${icon('clock', 'sm')}${link.state === 'online' ? 'Sending' : 'Waiting for the Mac'}</p></article>`);
    }
    if (!html.length) html.push(`<div class="empty"><h2>Nothing Here Yet</h2><p>Send a message and your Mac gets to work. Each step shows up here as it happens.</p></div>`);
    list.innerHTML = html.join('');
    renderSide();
    if (near) thread.scrollTop = thread.scrollHeight;
  }

  function renderSide() {
    if (!wide.matches) return;
    const reqs = timeline.filter((t) => t.type === 'req').map((t) => t.req);
    // The pane follows the newest request until a steps row is tapped.
    let req = picked ? reqs.find((r) => r.id === selected) : null;
    if (!req) { req = reqs.filter((r) => r.steps.length || isLive(r) || r === current).at(-1); selected = req ? req.id : null; }
    const sub = $('side-sub');
    const ol = $('side-steps');
    if (!req) { sub.textContent = ''; ol.innerHTML = '<li class="side-empty">Steps show up here while your Mac works.</li>'; return; }
    sub.textContent = req.you ? req.you.text : 'Earlier';
    ol.innerHTML = stepsHtml(req) || '<li class="side-empty">No steps yet.</li>';
    for (const b of list.querySelectorAll('.steps-row')) b.setAttribute('aria-pressed', String(b.dataset.req === String(selected)));
  }

  function renderChrome() {
    const working = link.state === 'online' && status.working;
    app.dataset.link = link.state;
    app.dataset.working = String(working);
    $('sub-text').textContent = working ? status.label || 'Working' : link.state === 'online' ? 'Connected to the Mac' : link.state === 'connecting' ? 'Reaching the Mac' : link.state === 'unpaired' ? 'Not paired' : 'Offline';
    const banner = $('banner');
    banner.hidden = link.state === 'online' || link.state === 'connecting';
    $('banner-text').textContent = link.detail || "Can't reach the Mac.";
    const action = $('banner-action');
    action.hidden = link.state === 'unpaired';
    action.textContent = link.fix === 'tailscale' ? 'Open Tailscale' : 'Retry';
    updateSend();
  }

  function updateSend() {
    const stopMode = status.working && !input.value.trim();
    sendBtn.classList.toggle('stop', stopMode);
    sendBtn.setAttribute('aria-label', stopMode ? 'Stop' : 'Send');
    sendBtn.querySelector('use').setAttribute('href', stopMode ? '#i-stop' : '#i-send');
    sendBtn.disabled = !stopMode && !input.value.trim();
  }

  let pending = null;
  function schedule(what) {
    if (!what) return;
    pending = pending === 'list' || what === 'list' ? 'list' : 'chrome';
    if (schedule.raf) return;
    schedule.raf = requestAnimationFrame(() => {
      schedule.raf = 0;
      const w = pending;
      pending = null;
      renderChrome();
      if (w === 'list') renderList();
      else refreshLive();
      if (!readyCalled) { readyCalled = true; lab.ready(); }
    });
  }

  // Status changes re-render only the live row, so an open step keeps its place.
  function refreshLive() {
    const live = list.querySelector('.steps-row.live');
    const req = current;
    if (!req || !!live !== isLive(req)) return renderList();
    if (live) {
      const l = live.querySelector('.live-label');
      if (l) l.textContent = status.label || 'Working';
    }
  }

  setInterval(() => {
    for (const el of document.querySelectorAll('.elapsed[data-since]')) {
      if (el.dataset.since) el.textContent = dur(Date.now() - Date.parse(el.dataset.since));
    }
  }, 1000);

  function syncBack() {
    lab.onBack(!wide.matches && (openReqs.size || openSteps.size) ? () => { openReqs.clear(); openSteps.clear(); renderList(); syncBack(); } : null);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.matches('a[data-ext]')) { e.preventDefault(); lab.open(t.href); return; }
    if (t.dataset.req) {
      const id = t.dataset.req === 'pre' ? 'pre' : Number(t.dataset.req);
      if (wide.matches) { selected = id; picked = id !== timeline.filter((x) => x.type === 'req').at(-1)?.req.id; renderSide(); }
      else { openReqs.has(id) ? openReqs.delete(id) : openReqs.add(id); renderList(); syncBack(); }
    } else if (t.dataset.step) {
      const ref = t.dataset.step;
      openSteps.has(ref) ? openSteps.delete(ref) : openSteps.add(ref);
      for (const li of document.querySelectorAll(`[data-step="${CSS.escape(ref)}"]`)) {
        li.parentElement.classList.toggle('open', openSteps.has(ref));
        li.setAttribute('aria-expanded', String(openSteps.has(ref)));
      }
      syncBack();
    } else if (t.dataset.answer) {
      lab.answer(t.dataset.answer, t.dataset.allow === '1');
    } else if (t.dataset.send) {
      lab.send(t.dataset.send);
    } else if (t.dataset.open) {
      lab.open(t.dataset.open);
    } else if (t.id === 'banner-action') {
      link.fix ? lab.fix(link.fix) : lab.retry();
    }
  });

  function grow() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
    updateSend();
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { if (status.working) lab.stop(); return; }
    lab.send(text);
    input.value = '';
    grow();
    thread.scrollTop = thread.scrollHeight;
  });
  thread.addEventListener('scroll', () => app.classList.toggle('scrolled', thread.scrollTop > 4), { passive: true });
  wide.addEventListener('change', () => { syncBack(); renderList(); });

  lab.subscribe((e) => schedule(apply(e)));
  schedule('list');
})();
