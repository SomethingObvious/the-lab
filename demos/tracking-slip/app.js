(() => {
  const lab = window.lab;
  const $ = (id) => document.getElementById(id);
  const feed = $('feed');
  const slipsEl = $('slips');
  const manifest = $('manifest');
  const msg = $('msg');
  const wide = matchMedia('(min-width: 700px)');

  const items = [];
  let cur = null;
  let count = 0;
  let status = { working: false, label: '', since: new Date().toISOString() };
  let link = { state: 'connecting', detail: '' };
  let outbox = [];
  let selected = null;
  const openRows = new Set();
  const scansSet = new Map();

  const WORDS = { queued: 'Queued', transit: 'In Transit', needs: 'Needs You', delivered: 'Delivered', stopped: 'Stopped', exception: 'Exception' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const hms = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const stamp = (iso) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    const day = today ? 'Today' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}:${pad(s % 60)}` : `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}`;
  };
  const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  // Escapes first, then turns back on the few bits of markdown replies use.
  function inline(s) {
    return String(s).split(/(`[^`\n]+`)/).map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    }).join('');
  }
  function md(src) {
    const lines = String(src).replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara(); flushList();
        const code = [];
        while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        continue;
      }
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push((ul || ol)[1]);
        continue;
      }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList();
      para.push(line.replace(/^#+\s+/, ''));
    }
    flushPara(); flushList();
    return out.join('');
  }

  const icon = {
    chev: '<svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>',
    file: '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><path d="M10 4h14l8 8v24H10z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M24 4v8h8M15 20h12M15 25h12M15 30h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  };

  function stateOf(r) {
    if (r.queued) return 'queued';
    if (r.done) return r.done.stopped ? 'stopped' : r.done.ok ? 'delivered' : 'exception';
    if (r.asks.some((a) => !r.answers[a.ref])) return 'needs';
    return 'transit';
  }

  function scansOpen(r) {
    return scansSet.has(r.no) ? scansSet.get(r.no) : !r.done;
  }

  function track(r, s) {
    const reached = r.queued ? 1 : r.done ? (s === 'delivered' ? 4 : 3) : r.steps.length ? 3 : 2;
    const stations = ['Sent', 'Received', s === 'needs' ? 'Needs You' : 'Working', s === 'exception' ? 'Exception' : s === 'stopped' ? 'Stopped' : 'Delivered'];
    const alertAt = s === 'needs' ? 2 : s === 'exception' ? 3 : -1;
    const fill = s === 'stopped' || s === 'exception' ? 3 : reached - 1;
    return `<div class="track" aria-hidden="true"><span class="fill" style="width:calc((100% - 28px) * ${fill} / 4)"></span>${stations.map((name, i) =>
      `<span class="stn${i < reached || (i === 3 && (s === 'stopped' || s === 'exception')) ? ' on' : ''}${i === alertAt ? ' alert' : ''}"><i></i>${name}</span>`).join('')}</div>`;
  }

  function scanRows(r) {
    const rows = [];
    rows.push(`<li class="scan ms"><button type="button" tabindex="-1" disabled><time>${hms(r.at)}</time><span class="m"></span><span class="t">Received your request</span><span></span></button></li>`);
    for (const x of r.log) {
      if (x.kind === 'step') {
        const failed = r.failed[x.ref];
        const isOpen = openRows.has(x.ref);
        rows.push(`<li class="scan${x.sub ? ' sub' : ''}${failed ? ' failed' : ''}"${isOpen ? ' data-open' : ''}>
          <button type="button" data-row="${esc(x.ref)}" aria-expanded="${isOpen}"><time>${hms(x.at)}</time><span class="m"></span><span class="t">${esc(x.title)}</span>${icon.chev}</button>
          <div class="detail"><div class="tool">${esc(x.tool)}</div><pre>${esc(x.detail)}</pre>${failed ? `<p class="err">${esc(failed)}</p>` : ''}</div></li>`);
      } else if (x.kind === 'answered') {
        const a = r.asks.find((q) => q.ref === x.ref);
        rows.push(`<li class="scan ms"><button type="button" tabindex="-1" disabled><time>${hms(x.at)}</time><span class="m"></span><span class="t">${x.allow ? 'Allowed' : 'Denied'}: ${esc(a?.title ?? '')}</span><span></span></button></li>`);
      } else if (x.kind === 'ask' && !r.answers[x.ref]) {
        rows.push(`<li class="scan ms alert"><button type="button" tabindex="-1" disabled><time>${hms(x.at)}</time><span class="m"></span><span class="t">Waiting for your go-ahead</span><span></span></button></li>`);
      } else if (x.kind === 'reply') {
        rows.push(`<li class="scan ms"><button type="button" tabindex="-1" disabled><time>${hms(x.at)}</time><span class="m"></span><span class="t">Reply ready</span><span></span></button></li>`);
      }
    }
    if (r.done) {
      const s = stateOf(r);
      rows.push(`<li class="scan ms${s === 'exception' ? ' alert' : ''}"><button type="button" tabindex="-1" disabled><time>${hms(r.done.at)}</time><span class="m"></span><span class="t">${WORDS[s]}${r.done.error ? `: ${esc(r.done.error)}` : ''}</span><span></span></button></li>`);
    }
    return rows.join('');
  }

  function slipHtml(r) {
    const s = stateOf(r);
    const live = !r.done && !r.queued && status.working;
    const steps = r.steps.length;
    const clock = r.done ? dur(r.done.ms) : live ? dur(Date.now() - Date.parse(status.since)) : '';
    const doing = r.queued ? (link.state === 'online' ? 'Sending to the Mac' : 'Waits here until the Mac is reachable') : live && s !== 'needs' ? status.label : '';
    const pending = r.asks.filter((a) => !r.answers[a.ref]);
    const replies = r.log.filter((x) => x.kind === 'reply');
    const isOpen = scansOpen(r);
    return `
      <div class="slip-head"><span class="no">No. ${String(r.no).padStart(4, '0')}</span><span>${r.queued ? 'Not Sent Yet' : stamp(r.at)}</span></div>
      <div class="addr"><span class="label">From you</span><p>${esc(r.text)}</p></div>
      <div class="state"><h2 class="word">${WORDS[s]}</h2><span class="clock"${live ? ' data-live' : ''}>${clock}</span>${doing ? `<p class="doing">${esc(doing)}</p>` : ''}</div>
      ${track(r, s)}
      ${pending.map((a) => `<section class="ask" aria-label="Needs your go-ahead"><span class="label">Needs your go-ahead</span><h3>${esc(a.title)}</h3>${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}<div class="row"><button type="button" class="btn" data-answer="${esc(a.ref)}" data-allow="1">Allow</button><button type="button" class="btn line" data-answer="${esc(a.ref)}" data-allow="0">Deny</button></div></section>`).join('')}
      ${r.queued ? '' : `<div class="scans"${isOpen ? ' data-open' : ''}><button type="button" class="scans-toggle" data-scans="${r.no}" aria-expanded="${isOpen}"><span>Scans, ${steps} ${steps === 1 ? 'step' : 'steps'}</span>${icon.down}</button><ol>${scanRows(r)}</ol></div>`}
      ${replies.length || r.files.length ? `<div class="contents"><span class="label">Reply</span><div class="md">${replies.map((x) => md(x.text)).join('')}</div>${r.files.map((f) => `<div class="file">${icon.file}<div><b>${esc(f.name)}</b><small>${esc([f.caption, size(f.size)].filter(Boolean).join(', '))}</small></div><button type="button" class="btn line small" data-open="${esc(f.url)}">Open</button></div>`).join('')}</div>` : ''}`;
  }

  function slipEl(r) {
    let el = r.el;
    if (!el) {
      el = document.createElement('article');
      el.className = 'slip';
      r.el = el;
    }
    el.dataset.s = stateOf(r);
    el.dataset.no = r.no;
    el.innerHTML = slipHtml(r);
    return el;
  }

  function noticeEl(n) {
    const el = document.createElement('div');
    el.className = 'notice';
    el.innerHTML = `<p><span class="label">Note, ${hms(n.at)}</span>${esc(n.text)}</p>${n.action ? `<button type="button" class="btn line small" data-send="${esc(n.action.send)}">${esc(n.action.label)}</button>` : ''}`;
    return el;
  }

  const requests = () => items.filter((x) => x.type === 'req');
  const queuedReqs = () => outbox.map((m, i) => ({ type: 'req', queued: true, no: count + i + 1, text: m.text, at: m.at, steps: [], asks: [], answers: {}, log: [], files: [], failed: {}, cid: m.cid }));
  const selectedNo = () => selected ?? (queuedReqs().at(-1)?.no ?? requests().at(-1)?.no);

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; draw(); });
  }

  function draw() {
    // Unfolded shows one slip from its top, so only the phone sticks to the newest.
    const stick = !wide.matches && feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    const frag = document.createDocumentFragment();
    for (const x of items) frag.append(x.type === 'req' ? slipEl(x) : (x.el ??= noticeEl(x)));
    for (const q of queuedReqs()) frag.append(slipEl(q));
    slipsEl.replaceChildren(frag);
    const sel = selectedNo();
    for (const el of slipsEl.querySelectorAll('.slip')) el.classList.toggle('sel', Number(el.dataset.no) === sel);
    $('empty').hidden = items.length > 0 || outbox.length > 0;
    drawManifest(sel);
    if (stick) feed.scrollTop = feed.scrollHeight;
    $('stop').hidden = !status.working;
    lab.onBack(openRows.size ? closeRows : null);
  }

  function drawManifest(sel) {
    const all = [...items, ...queuedReqs()].reverse();
    manifest.innerHTML = `<div class="mhead"><span class="label">Requests</span></div>` + all.map((r) => {
      if (r.type === 'notice') return `<div class="mnote"><p><span class="label">Note, ${hms(r.at)}</span>${esc(r.text)}</p>${r.action ? `<button type="button" class="btn line small" data-send="${esc(r.action.send)}">${esc(r.action.label)}</button>` : ''}</div>`;
      const s = stateOf(r);
      return `<button type="button" class="mrow" data-pick="${r.no}" aria-current="${r.no === sel}"><span class="mw${s === 'needs' || s === 'exception' ? ' alert' : ''}">${WORDS[s]}</span><span class="mt">${r.queued ? '' : stamp(r.at)}</span><span class="mq">${esc(r.text)}</span></button>`;
    }).join('');
  }

  function closeRows() { openRows.clear(); render(); }

  function setLink(l) {
    link = l;
    const p = $('link');
    p.dataset.state = l.state;
    $('link-text').textContent = { online: 'Mac connected', connecting: 'Reaching the Mac', offline: 'Mac offline', unpaired: 'Not paired' }[l.state] ?? l.state;
    const down = l.state === 'offline' || l.state === 'unpaired';
    $('banner').hidden = !down;
    if (down) {
      $('banner-text').textContent = l.detail || 'The Mac is out of reach.';
      $('banner-btn').textContent = l.fix === 'tailscale' ? 'Open Tailscale' : 'Try Again';
      $('banner-btn').onclick = () => (l.fix === 'tailscale' ? lab.fix('tailscale') : lab.retry());
    }
    render();
  }

  function on(e) {
    switch (e.kind) {
      case 'you':
        cur = { type: 'req', no: ++count, text: e.text, at: e.at, cid: e.cid, steps: [], asks: [], answers: {}, log: [], files: [], failed: {}, done: null };
        items.push(cur);
        break;
      case 'step': if (cur) { cur.steps.push(e); cur.log.push(e); } break;
      case 'failed': if (cur) cur.failed[e.ref] = e.text; break;
      case 'ask': if (cur) { cur.asks.push(e); cur.log.push(e); } break;
      case 'answered': if (cur) { cur.answers[e.ref] = e; cur.log.push(e); } break;
      case 'reply': if (cur) cur.log.push(e); break;
      case 'file': if (cur) cur.files.push(e); break;
      case 'done': if (cur) { cur.done = e; cur = null; } break;
      case 'notice': items.push({ type: 'notice', ...e }); break;
      case 'status': status = e; break;
      case 'link': return setLink(e);
      case 'outbox': outbox = e.items; break;
      default: return;
    }
    render();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button, a');
    if (!t) return;
    if (t.matches('.md a')) { ev.preventDefault(); lab.open(t.href); return; }
    if (t.dataset.row) {
      const ref = t.dataset.row;
      openRows.has(ref) ? openRows.delete(ref) : openRows.add(ref);
      render();
    } else if (t.dataset.scans) {
      const r = requests().find((x) => x.no === Number(t.dataset.scans));
      if (r) scansSet.set(r.no, !scansOpen(r));
      render();
    } else if (t.dataset.answer) {
      lab.answer(t.dataset.answer, t.dataset.allow === '1');
      t.closest('.ask').querySelectorAll('button').forEach((b) => (b.disabled = true));
    } else if (t.dataset.open) {
      lab.open(t.dataset.open);
    } else if (t.dataset.send) {
      lab.send(t.dataset.send);
      selected = null;
    } else if (t.dataset.pick) {
      selected = Number(t.dataset.pick);
      render();
      feed.scrollTop = 0;
    }
  });

  const grow = () => { msg.style.height = 'auto'; msg.style.height = `${Math.min(msg.scrollHeight + 2, 160)}px`; $('send').disabled = !msg.value.trim(); };
  msg.addEventListener('input', grow);
  msg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = msg.value.trim();
    if (!text) return;
    lab.send(text);
    msg.value = '';
    grow();
    selected = null;
    feed.scrollTop = feed.scrollHeight;
  });
  $('stop').addEventListener('click', () => lab.stop());
  wide.addEventListener('change', render);

  setInterval(() => {
    if (!status.working) return;
    for (const c of document.querySelectorAll('.clock[data-live]')) c.textContent = dur(Date.now() - Date.parse(status.since));
  }, 1000);

  lab.subscribe(on);
  draw();
  requestAnimationFrame(() => lab.ready());
})();
