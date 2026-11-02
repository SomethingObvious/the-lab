(() => {
  const lab = window.lab;
  const $ = (id) => document.getElementById(id);
  const bug = $('bug'), bugState = $('bug-state'), bugClock = $('bug-clock'), bugPlay = $('bug-play');
  const bugLink = $('bug-link'), bugLinkText = $('bug-link-text');
  const banner = $('banner'), bannerText = $('banner-text'), bannerFix = $('banner-fix');
  const feed = $('feed'), railList = $('rail-list'), game = $('game');
  const form = $('composer'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop');
  const wide = matchMedia('(min-width: 700px)');
  const calm = matchMedia('(prefers-reduced-motion: reduce)');

  const drives = [];
  const lead = [];         // notices before the first request
  let status = { working: false, label: '', since: new Date().toISOString() };
  let link = { state: 'connecting', detail: '' };
  let outbox = [];
  let booting = true;
  let picked = null;       // a drive picked from the rail, null means follow the latest
  const open = new Set();  // expanded plays, by ref
  const shown = new Set(); // older drives whose plays are shown on the narrow layout
  const backStack = [];

  // Formatting
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const span = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : clock(ms));
  const tod = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const ext = (name) => (name.includes('.') ? name.split('.').pop().slice(0, 4) : 'file');

  function inline(s) {
    return s.split(/(`[^`\n]+`)/).map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-open>$1</a>');
    }).join('');
  }

  // Escapes everything first, then adds back the little markdown replies use.
  function md(src) {
    const out = [];
    const parts = String(src ?? '').split(/^```[^\n]*\n?/m);
    parts.forEach((part, i) => {
      if (i % 2 === 1) { out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`); return; }
      let list = null, para = [];
      const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
      const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; };
      for (const line of part.split('\n')) {
        const li = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
        if (li) {
          flushPara();
          const tag = li[1] ? 'ul' : 'ol';
          if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
          list.items.push(li[3]);
        } else if (!line.trim()) { flushPara(); flushList(); }
        else if (/^#{1,6}\s/.test(line)) { flushPara(); flushList(); out.push(`<p><strong>${inline(line.replace(/^#+\s*/, ''))}</strong></p>`); }
        else { flushList(); para.push(line); }
      }
      flushPara(); flushList();
    });
    return out.join('');
  }

  const icon = {
    chev: '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
    note: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6.2v.1"/></svg>',
  };

  // Events
  const current = () => { for (let i = drives.length - 1; i >= 0; i--) if (!drives[i].done) return drives[i]; return drives.at(-1); };

  function take(e) {
    switch (e.kind) {
      case 'you':
        drives.push({ you: e, items: [], after: [], done: null, n: drives.length + 1 });
        picked = null;
        break;
      case 'step': case 'reply': case 'file': case 'ask': {
        const d = current(); if (!d) return;
        d.items.push({ ...e, fresh: !booting });
        break;
      }
      case 'failed': {
        const d = current(); if (!d) return;
        const step = d.items.find((x) => x.kind === 'step' && x.ref === e.ref);
        if (step) step.failed = e.text;
        d.items.push({ ...e, title: step?.title, fresh: !booting });
        break;
      }
      case 'answered': {
        for (const d of drives) for (const x of d.items) if (x.kind === 'ask' && x.ref === e.ref) x.answered = e;
        break;
      }
      case 'done': { const d = current(); if (d) d.done = e; break; }
      case 'notice': {
        const d = current();
        const item = { ...e, fresh: !booting };
        if (d && !d.done) d.items.push(item);
        else if (d) d.after.push(item);
        else lead.push(item);
        break;
      }
      case 'status': status = e; break;
      case 'link': link = e; break;
      case 'outbox': outbox = e.items; break;
      default: return;
    }
    if (!booting) render(e);
  }

  // Rendering
  function driveState(d) {
    if (d.done) return d.done.stopped ? 'stopped' : d.done.ok ? 'final' : 'error';
    if (d.items.some((x) => x.kind === 'ask' && !x.answered)) return 'call';
    return 'live';
  }
  const chipFor = (st) => ({
    live: '<span class="chip chip-live">Live</span>',
    call: '<span class="chip chip-call">Your Call</span>',
    final: '<span class="chip">Final</span>',
    stopped: '<span class="chip">Stopped</span>',
    error: '<span class="chip chip-flag">Error</span>',
  })[st];

  function playHTML(x, d, isLast) {
    const t0 = Date.parse(d.you.at);
    const at = `<span class="play-clock">${clock(Date.parse(x.at) - t0)}</span>`;
    const fresh = x.fresh ? ' in' : '';
    if (x.kind === 'step') {
      const exp = open.has(x.ref);
      const cls = ['play', x.sub ? 'play-sub' : '', x.failed ? 'play-flag' : isLast && !d.done ? 'play-last' : ''].join(' ');
      return `<li class="${cls}${fresh}">
        <button type="button" class="play-row" data-play="${esc(x.ref)}" aria-expanded="${exp}">
          ${at}<span class="mark"></span><span class="play-title">${esc(x.title)}</span>${icon.chev}
        </button>
        ${exp ? `<div class="detail"><div class="detail-tool">${esc(x.tool)}</div><pre>${esc(x.detail)}</pre>${x.failed ? `<div class="detail-error">${esc(x.failed)}</div>` : ''}</div>` : ''}
      </li>`;
    }
    if (x.kind === 'failed') {
      return `<li class="flag${fresh}">${at}<div class="flag-body"><span class="flag-title">Flag on the play</span><span class="flag-text">${esc(x.text)}</span></div></li>`;
    }
    if (x.kind === 'ask') {
      if (x.answered) {
        return `<li class="call-done${fresh}">${x.answered.allow ? '<span class="chip">Allowed</span>' : '<span class="chip chip-flag">Denied</span>'}<span>${esc(x.title)}</span></li>`;
      }
      return `<li class="big${fresh}"><div class="call" role="group" aria-label="Needs your go-ahead">
        <div class="call-head"><span class="chip chip-call">Your Call</span><span class="play-clock">${clock(Date.parse(x.at) - t0)}</span></div>
        <p class="call-title">${esc(x.title)}</p>
        ${x.detail ? `<pre>${esc(x.detail)}</pre>` : ''}
        <div class="call-actions">
          <button type="button" class="btn btn-quiet" data-answer="${esc(x.ref)}" data-allow="0">Deny</button>
          <button type="button" class="btn btn-go" data-answer="${esc(x.ref)}" data-allow="1">Allow</button>
        </div></div></li>`;
    }
    if (x.kind === 'file') {
      return `<li class="big${fresh}"><div class="file">
        <span class="file-icon">${esc(ext(x.name))}</span>
        <div><div class="file-name">${esc(x.name)}</div><div class="file-meta">${esc([x.caption, size(x.size ?? 0)].filter(Boolean).join(' · '))}</div></div>
        <button type="button" class="btn" data-file="${esc(x.url)}">Open</button>
      </div></li>`;
    }
    if (x.kind === 'reply') {
      return `<li class="${fresh.trim()}"><div class="recap"><div class="recap-label">Recap</div><div class="recap-body">${md(x.text)}</div></div></li>`;
    }
    if (x.kind === 'notice') return noteHTML(x, fresh);
    return '';
  }

  function noteHTML(x, fresh = '') {
    const act = x.action ? `<button type="button" class="btn" data-send="${esc(x.action.send)}">${esc(x.action.label)}</button>` : '';
    return `<li class="note${fresh}">${icon.note}<div><p>${esc(x.text)}</p>${act}</div></li>`;
  }

  function finalHTML(d) {
    if (!d.done) return '';
    const e = d.done;
    if (e.stopped) return `<div class="final"><span class="chip">Stopped</span>after ${clock(e.ms)}</div>`;
    if (!e.ok) return `<div class="final"><span class="chip chip-flag">Error</span><span class="final-error">${esc(e.error || 'The task ended with an error.')}</span></div>`;
    return `<div class="final"><span class="chip">Final</span>${span(e.ms)}</div>`;
  }

  function driveHTML(d, full) {
    const st = driveState(d);
    const meta = `${tod(d.you.at)} ${d.done ? '' : chipFor(st)}`;
    const items = full ? d.items : d.items.filter((x) => x.kind === 'reply' || x.kind === 'file' || (x.kind === 'ask' && !x.answered));
    const hidden = d.items.length - items.length;
    const lastStep = d.items.findLast((x) => x.kind === 'step');
    return `<section class="drive" aria-label="Request at ${esc(tod(d.you.at))}">
      <div class="drive-head"><h2 class="drive-ask">${esc(d.you.text)}</h2><div class="drive-meta">${meta}</div></div>
      ${!full && hidden ? `<button type="button" class="btn btn-quiet more" data-show="${d.n}">Show ${hidden} ${hidden === 1 ? 'Play' : 'Plays'}</button>` : ''}
      <ol class="plays">${items.map((x) => playHTML(x, d, x === lastStep)).join('')}</ol>
      ${finalHTML(d)}
    </section>${d.after.length ? `<ol class="plays">${d.after.map((x) => noteHTML(x, x.fresh ? ' in' : '')).join('')}</ol>` : ''}`;
  }

  function queuedHTML() {
    return outbox.map((m) => `<section class="drive drive-queued"><div class="drive-head"><h2 class="drive-ask">${esc(m.text)}</h2>
      <div class="drive-meta"><span class="chip">${link.state === 'online' ? 'Sending' : 'Waiting to Send'}</span></div></div></section>`).join('');
  }

  function renderFeed() {
    const latest = drives.at(-1);
    let html;
    if (!drives.length && !outbox.length) {
      html = `${lead.length ? `<ol class="plays">${lead.map((x) => noteHTML(x)).join('')}</ol>` : ''}<div class="empty"><strong>No Requests Yet</strong>Ask the Mac for something below. Each step shows up here as it happens.</div>`;
    } else if (wide.matches) {
      const d = picked ?? latest;
      html = (d ? driveHTML(d, true) : '') + (d === latest ? queuedHTML() : '');
    } else {
      html = (lead.length ? `<ol class="plays">${lead.map((x) => noteHTML(x)).join('')}</ol>` : '')
        + drives.map((d) => driveHTML(d, d === latest || shown.has(d.n))).join('') + queuedHTML();
    }
    feed.innerHTML = html;
    for (const d of drives) for (const x of d.items) x.fresh = false;
    for (const d of drives) for (const x of d.after) x.fresh = false;
  }

  function renderRail() {
    if (!wide.matches) return;
    const sel = picked ?? drives.at(-1);
    railList.innerHTML = [...drives].reverse().map((d) => {
      const st = driveState(d);
      return `<li><button type="button" class="rail-item" data-pick="${d.n}" aria-current="${d === sel}">
        <span class="rail-text">${esc(d.you.text)}</span>
        <span class="rail-meta">${chipFor(st)}<span>${tod(d.you.at)}</span>${d.done && !d.done.stopped && d.done.ok ? `<span>${span(d.done.ms)}</span>` : ''}</span>
      </button></li>`;
    }).join('');
  }

  let lastLabel = '';
  function renderBug() {
    const d = drives.at(-1);
    const needs = d && !d.done && d.items.some((x) => x.kind === 'ask' && !x.answered);
    const state = needs ? 'call' : status.working ? 'live' : 'final';
    bug.dataset.state = state;
    bugState.textContent = { call: 'Your Call', live: 'Live', final: d ? 'Final' : 'Ready' }[state];
    tick();
    const label = needs ? 'Waiting for you' : status.working ? (status.label || 'Working') : d ? 'Ready for the next one' : 'Ready';
    if (label !== lastLabel) {
      bugPlay.textContent = label;
      if (lastLabel && !calm.matches) { bugPlay.classList.remove('wipe'); void bugPlay.offsetWidth; bugPlay.classList.add('wipe'); }
      lastLabel = label;
    }
    bugLink.dataset.state = link.state;
    bugLinkText.textContent = { online: 'Mac', connecting: 'Linking', offline: 'Offline', unpaired: 'Unpaired' }[link.state] ?? link.state;
    bugLink.title = link.detail || 'Connection to the Mac';

    const down = link.state === 'offline' || link.state === 'unpaired';
    banner.hidden = !down;
    bannerText.textContent = link.detail || "Can't reach the Mac.";
    bannerFix.hidden = link.fix !== 'tailscale';

    stopBtn.hidden = !status.working;
    syncSend();
  }

  function tick() {
    const d = drives.at(-1);
    if (status.working) bugClock.textContent = clock(Date.now() - Date.parse(d && !d.done ? d.you.at : status.since));
    else bugClock.textContent = d?.done ? clock(d.done.ms) : '0:00';
  }
  setInterval(() => { if (status.working) tick(); }, 1000);

  function render(e) {
    const nearBottom = scrollY + innerHeight > document.documentElement.scrollHeight - 160;
    if (!e || !['status', 'link'].includes(e.kind) || e.kind === 'link') renderFeed();
    renderRail();
    renderBug();
    syncBack();
    if (e && ['you', 'step', 'reply', 'file', 'ask', 'failed', 'done', 'notice', 'outbox'].includes(e.kind) && (nearBottom || e.kind === 'you') && !picked) {
      requestAnimationFrame(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: calm.matches ? 'auto' : 'smooth' }));
    }
  }

  // Back closes the newest thing opened, then returns to the live request.
  function syncBack() {
    lab.onBack(open.size || shown.size || picked ? goBack : null);
  }
  function goBack() {
    const last = backStack.pop();
    if (last?.type === 'play' && open.has(last.ref)) open.delete(last.ref);
    else if (last?.type === 'drive' && shown.has(last.n)) shown.delete(last.n);
    else if (open.size) open.clear();
    else if (shown.size) shown.clear();
    else picked = null;
    renderFeed(); renderRail(); syncBack();
  }

  // Interaction
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-play],[data-answer],[data-file],[data-send],[data-show],[data-pick],a[data-open]');
    if (!t) return;
    if (t.dataset.play) {
      const ref = t.dataset.play;
      if (open.has(ref)) open.delete(ref); else { open.add(ref); backStack.push({ type: 'play', ref }); }
      renderFeed(); syncBack();
      document.querySelector(`[data-play="${CSS.escape(ref)}"]`)?.focus({ preventScroll: true });
    } else if (t.dataset.answer) {
      for (const b of document.querySelectorAll(`[data-answer="${CSS.escape(t.dataset.answer)}"]`)) b.disabled = true;
      lab.answer(t.dataset.answer, t.dataset.allow === '1');
    } else if (t.dataset.file) lab.open(t.dataset.file);
    else if (t.dataset.send) lab.send(t.dataset.send);
    else if (t.dataset.show) { const n = Number(t.dataset.show); shown.add(n); backStack.push({ type: 'drive', n }); renderFeed(); syncBack(); }
    else if (t.dataset.pick) {
      const d = drives.find((x) => x.n === Number(t.dataset.pick));
      picked = d === drives.at(-1) ? null : d;
      open.clear();
      renderFeed(); renderRail(); syncBack();
      game.scrollTop = 0; scrollTo({ top: 0 });
    } else if (t.matches('a[data-open]')) { ev.preventDefault(); lab.open(t.href); }
  });

  function syncSend() { sendBtn.disabled = !input.value.trim(); }
  function grow() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`; syncSend(); }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    lab.send(text);
    input.value = '';
    grow();
  });
  stopBtn.addEventListener('click', () => lab.stop());
  $('banner-retry').addEventListener('click', () => lab.retry());
  bannerFix.addEventListener('click', () => lab.fix('tailscale'));
  wide.addEventListener('change', () => { picked = null; renderFeed(); renderRail(); });
  new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', `${form.offsetHeight}px`)).observe(form);

  lab.subscribe(take);
  booting = false;
  render();
  scrollTo({ top: document.documentElement.scrollHeight });
  grow();
  lab.ready();
})();
