(() => {
  const lab = window.lab;
  const $ = (id) => document.getElementById(id);
  const railEl = $('rail'), ticketEl = $('ticket'), scrollEl = $('scroll'), bannerEl = $('banner');
  const form = $('composer'), input = $('input'), sendBtn = $('send'), stopBtn = $('stop'), queuedEl = $('queued');

  const requests = [];
  const loose = [];
  let link = { state: 'online' };
  let status = { working: false, since: null };
  let outbox = [];
  let selected = null; // null follows the newest ticket
  const open = new Set();
  let lastLive = null;
  let booted = false;
  const fresh = new Set();

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const icon = {
    chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5M12 17.2v.1"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5L14 3Z"/><path d="M14 3v4.5h4.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
  };

  // Small, safe markdown: everything is escaped first, then a few marks are
  // turned back into tags.
  function md(src) {
    const blocks = [];
    let text = esc(src).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    const inline = (s) => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
    return text.split(/\n{2,}/).map((para) => {
      const b = /^\u0000(\d+)\u0000$/.exec(para.trim());
      if (b) return blocks[Number(b[1])];
      const lines = para.split('\n');
      if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
      if (lines.every((l) => /^\s*\d+\. /.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\. /, ''))}</li>`).join('')}</ol>`;
      return `<p>${inline(lines.join('<br>'))}</p>`;
    }).join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  function take(e) {
    const last = requests.at(-1);
    switch (e.kind) {
      case 'link': link = e; break;
      case 'status': status = e; break;
      case 'outbox': outbox = e.items; break;
      case 'you':
        if (last && !last.done) last.orders.push(e.text);
        else requests.push({ n: requests.length + 1, at: e.at, orders: [e.text], items: [], out: [], done: null });
        break;
      case 'step': last?.items.push({ type: 'step', ...e }); break;
      case 'failed': { const s = last?.items.find((i) => i.ref === e.ref); if (s) s.failed = e.text; break; }
      case 'ask': last?.items.push({ type: 'ask', ...e, answer: null }); break;
      case 'answered': { for (const r of requests) for (const i of r.items) if (i.type === 'ask' && i.ref === e.ref) i.answer = e; break; }
      case 'reply': last?.out.push({ type: 'reply', text: e.text }); break;
      case 'file': last?.out.push({ type: 'file', ...e }); break;
      case 'notice': (last ? last.out : loose).push({ type: 'note', ...e }); break;
      case 'done':
        if (last && !last.done) { last.done = e; if (booted) fresh.add(last.n); }
        break;
    }
    schedule();
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  }

  const needsYou = (r) => r.items.some((i) => i.type === 'ask' && !i.answer);
  const current = () => (selected === null ? requests.at(-1) : requests.find((r) => r.n === selected));

  function stubState(r, isLast) {
    if (needsYou(r)) return ['needs', 'Needs You'];
    if (!r.done) return isLast && status.working ? ['live', 'Working'] : ['', 'Open'];
    if (r.done.stopped) return ['', 'Stopped'];
    return r.done.ok ? ['', 'Up'] : ['needs', 'Not Done'];
  }

  function renderRail(cur) {
    railEl.innerHTML = [...requests].reverse().map((r, i) => {
      const [cls, word] = stubState(r, i === 0);
      return `<button class="stub ${cls === 'needs' ? 'needs' : ''}" role="listitem" data-n="${r.n}" aria-current="${r === cur}">
        <span class="stub-top"><span>#${r.n}</span><time>${clock(r.at)}</time></span>
        <span class="stub-text">${esc(r.orders[0])}</span>
        <span class="stub-state ${cls}">${cls ? '<span class="dot"></span>' : ''}${word}</span>
      </button>`;
    }).join('');
  }

  function renderTicket(r) {
    if (!r) {
      ticketEl.innerHTML = `<div class="empty"><b>No Orders Yet</b>Send one below and it prints here, with every step the Mac takes.</div>${loose.map(note).join('')}`;
      return;
    }
    const isLast = r === requests.at(-1);
    const live = isLast && !r.done && status.working;
    const steps = r.items.filter((i) => i.type === 'step');
    const liveRef = live ? steps.filter((s) => !s.failed).at(-1)?.ref : null;
    const elapsed = r.done ? dur(r.done.ms) : live && status.since ? dur(Date.now() - Date.parse(status.since)) : '';

    const items = r.items.map((i) => {
      if (i.type === 'ask') {
        if (i.answer) return `<li class="item"><div class="answered">${i.answer.allow ? icon.check : icon.x}<b>${i.answer.allow ? 'Allowed' : 'Denied'}</b><span>${esc(i.title)}</span></div></li>`;
        return `<li class="ask" role="group" aria-label="Needs your go-ahead">
          <h3>Needs Your Go-Ahead</h3>
          <p>${esc(i.title)}</p>
          ${i.detail ? `<pre>${esc(i.detail)}</pre>` : ''}
          <div class="actions">
            <button class="btn" data-answer="${esc(i.ref)}" data-allow="1">${icon.check}Allow</button>
            <button class="btn ghost" data-answer="${esc(i.ref)}" data-allow="0">${icon.x}Deny</button>
          </div>
        </li>`;
      }
      const state = i.failed ? 'failed' : i.ref === liveRef ? 'live' : 'done';
      // A step that was live on the last render gets its strike drawn in.
      const startState = state === 'done' && i.ref === lastLive ? 'strike-next' : state;
      const isOpen = open.has(i.ref);
      return `<li class="item ${startState === 'strike-next' ? '' : state} ${i.sub ? 'sub' : ''}" data-ref="${esc(i.ref)}">
        <button class="item-head" aria-expanded="${isOpen}" data-toggle="${esc(i.ref)}">
          <span class="mark" aria-hidden="true"></span>
          <span class="what">${esc(i.title)}</span>
          <span class="item-side">${i.failed ? 'Failed' : ''}${icon.chev}</span>
        </button>
        <div class="item-detail" ${isOpen ? '' : 'hidden'}>
          <div class="tool">${esc(i.tool)}</div>
          <pre>${esc(i.detail)}</pre>
          ${i.failed ? `<div class="err">${esc(i.failed)}</div>` : ''}
        </div>
      </li>`;
    }).join('');

    const d = r.done;
    const up = d ? `<div class="perf" role="presentation"></div>
      <div class="up ${d.stopped ? 'stopped' : d.ok ? '' : 'error'} ${fresh.has(r.n) ? 'fresh' : ''}">
        <strong>${d.stopped ? 'Stopped' : d.ok ? 'Order Up' : 'Not Done'}</strong><span>in ${dur(d.ms)}</span>
      </div>${d.error ? `<p class="error-text">${esc(d.error)}</p>` : ''}` : '';
    const out = r.out.map((o) => (o.type === 'reply' ? `<div class="reply">${md(o.text)}</div>` : o.type === 'file' ? file(o) : note(o))).join('');

    ticketEl.innerHTML = `
      <header class="ticket-head">
        <span class="num">#${r.n}</span>
        <span class="meta"><span>${clock(r.at)}</span>${elapsed ? `<span class="clock" id="elapsed">${elapsed}</span>` : ''}</span>
      </header>
      <div class="label">Order</div>
      ${r.orders.map((o) => `<p class="order">${esc(o)}</p>`).join('')}
      ${r.items.length ? `<div class="perf" role="presentation"></div><div class="label">Steps &middot; ${steps.length}</div><ol class="items">${items}</ol>` : ''}
      ${up}
      ${!d && r.out.length ? '<div class="perf" role="presentation"></div>' : ''}
      ${out}`;

    const struck = ticketEl.querySelector(`.item[data-ref="${CSS.escape(lastLive ?? '')}"]:not(.done):not(.live):not(.failed)`);
    if (struck) requestAnimationFrame(() => requestAnimationFrame(() => struck.classList.add('done')));
    lastLive = liveRef ?? null;
    fresh.clear();
  }

  function file(o) {
    return `<button class="file" data-open="${esc(o.url)}">
      <span class="icon">${icon.file}</span>
      <span><b>${esc(o.name)}</b>${o.caption ? `<small>${esc(o.caption)}</small>` : ''}</span>
      <span class="size">${size(o.size)}</span>
    </button>`;
  }
  function note(o) {
    return `<div class="note"><p>${esc(o.text)}</p>${o.action ? `<button class="btn ghost" data-send="${esc(o.action.send)}">${esc(o.action.label)}</button>` : ''}</div>`;
  }

  function renderBanner() {
    if (link.state === 'online') { bannerEl.hidden = true; return; }
    bannerEl.hidden = false;
    const btn = link.state === 'connecting' ? ''
      : link.fix === 'tailscale' ? '<button class="btn ghost" data-fix="tailscale">Open Tailscale</button>'
      : link.state === 'offline' ? '<button class="btn ghost" data-retry>Retry</button>' : '';
    bannerEl.innerHTML = `${icon.warn}<p>${esc(link.detail || 'Reaching the Mac')}</p>${btn}`;
  }

  function renderComposer() {
    stopBtn.hidden = !status.working;
    queuedEl.hidden = outbox.length === 0;
    const verb = link.state === 'online' ? 'Sending' : 'Waiting to send';
    queuedEl.innerHTML = outbox.map((m) => `<div>${icon.clock}<span><b>${verb}:</b> ${esc(m.text)}</span></div>`).join('');
  }

  function render() {
    const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
    const cur = current();
    const prevTop = scrollEl.scrollTop;
    renderRail(cur);
    renderTicket(cur);
    renderBanner();
    renderComposer();
    if (selected === null && atBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
    else scrollEl.scrollTop = prevTop;
    lab.onBack(open.size || selected !== null ? back : null);
    if (!booted) { booted = true; scrollEl.scrollTop = scrollEl.scrollHeight; lab.ready(); }
  }

  function back() {
    if (open.size) open.clear();
    else selected = null;
    render();
  }

  setInterval(() => {
    const el = $('elapsed');
    const r = current();
    if (el && status.working && r === requests.at(-1) && !r.done && status.since) el.textContent = dur(Date.now() - Date.parse(status.since));
  }, 1000);

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button, a');
    if (!t) return;
    if (t.matches('a[href]')) { ev.preventDefault(); lab.open(t.href); return; }
    if (t.dataset.n) {
      const n = Number(t.dataset.n);
      selected = n === requests.at(-1)?.n ? null : n;
      open.clear();
      render();
      scrollEl.scrollTop = selected === null ? scrollEl.scrollHeight : 0;
    } else if (t.dataset.toggle) {
      open.has(t.dataset.toggle) ? open.delete(t.dataset.toggle) : open.add(t.dataset.toggle);
      render();
    } else if (t.dataset.answer) {
      lab.answer(t.dataset.answer, t.dataset.allow === '1');
    } else if (t.dataset.open) {
      lab.open(t.dataset.open);
    } else if (t.dataset.send) {
      lab.send(t.dataset.send);
    } else if (t.dataset.fix) {
      lab.fix(t.dataset.fix);
    } else if ('retry' in t.dataset) {
      lab.retry();
    }
  });

  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 3}px`;
    sendBtn.disabled = !input.value.trim();
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    lab.send(text);
    input.value = '';
    grow();
    selected = null;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });
  stopBtn.addEventListener('click', () => lab.stop());

  lab.subscribe(take);
  schedule();
})();
