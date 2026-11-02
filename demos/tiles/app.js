(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const wide = matchMedia('(min-width: 700px)');

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext>$1</a>');
  }
  function md(src) {
    const out = [];
    esc(src).split(/```[^\n]*\n?/).forEach((part, i) => {
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
  const plain = (s) => String(s || '').replace(/\*\*|`|\[|\]\([^)]*\)/g, '').replace(/\n+/g, ' ');

  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayKey = (iso) => new Date(iso).toDateString();
  function dayLabel(iso) {
    const d = new Date(iso), today = new Date();
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'today';
    if (d.toDateString() === y.toDateString()) return 'yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }).toLowerCase();
  }
  const shortDay = (iso) => {
    const l = dayLabel(iso);
    return l === 'today' ? clock(iso) : l === 'yesterday' ? 'Yesterday' : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const took = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const bytes = (n) => n < 1024 ? `${n} B` : n < 1e6 ? `${Math.round(n / 1e3)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${n >= 1e11 ? Math.round(n / 1e9) : (n / 1e9).toFixed(1)} GB`;
  function ago(iso) {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }
  function uptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d} day${d > 1 ? 's' : ''}, ${h} hour${h === 1 ? '' : 's'}`;
    return h ? `${h} h ${m} min` : `${m} min`;
  }
  const isImage = (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|heic)$/i.test(f.name || '');

  // State built from events
  const items = [];
  const byRef = new Map();
  let cur = null;
  let link = { state: 'connecting' };
  let status = { working: false, label: '' };
  let mac = null;
  let shortcuts = [];
  let outbox = [];
  let pending = [];
  let uploading = 0;
  let selected = null;
  let booted = false;

  const thread = $('thread');
  const chat = $('p-chat');
  const queue = document.createElement('div');
  queue.className = 'turn';

  function newTurn(you, at) {
    const t = { type: 'turn', id: you ? `y${you.id}` : `t${Math.random()}`, you, at, steps: [], failed: {}, asks: [], answers: {}, out: [], done: null, open: undefined, raw: new Set() };
    items.push(t);
    cur = t;
    return t;
  }

  function take(e) {
    switch (e.kind) {
      case 'link': link = e; drawLink(); drawMachine(); drawTiles(); return;
      case 'status': status = e; drawNow(); if (cur) draw(cur); drawHistory(); drawPip(); return;
      case 'mac': mac = e; drawMachine(); drawTiles(); if (pageKind === 'mac') openMac(); return;
      case 'shortcuts': shortcuts = e.items || []; drawShortcuts(); if (pageKind === 'manage') openManage(); return;
      case 'outbox': outbox = e.items || []; drawQueue(); return;
      case 'insets': document.documentElement.toggleAttribute('data-keyboard', !!e.keyboard); return;
      case 'design': case 'undone': return;
      case 'openFailed': toast('Nothing on this phone can open that file.'); return;
      case 'you': { const t = newTurn(e, e.at); draw(t); drawHistory(); drawNow(); return; }
      case 'notice': { const n = { type: 'notice', id: `n${e.id}`, e, at: e.at }; items.push(n); draw(n); return; }
    }
    const t = (e.kind === 'failed' || e.kind === 'answered') ? (byRef.get(e.ref) || cur) : cur || newTurn(null, e.at);
    if (!t) return;
    if (e.kind === 'step') { t.steps.push(e); byRef.set(e.ref, t); t.fresh = e.ref; }
    else if (e.kind === 'failed') t.failed[e.ref] = e.text;
    else if (e.kind === 'ask') { t.asks.push(e); byRef.set(e.ref, t); }
    else if (e.kind === 'answered') t.answers[e.ref] = e;
    else if (e.kind === 'reply' || e.kind === 'file') t.out.push(e);
    else if (e.kind === 'done') t.done = e;
    else return;
    draw(t);
    t.fresh = null;
    if (e.kind === 'ask' || e.kind === 'answered' || e.kind === 'done' || e.kind === 'reply') { drawNow(); drawHistory(); drawPip(); }
    if (e.kind === 'file') { drawFiles(); drawFileTile(); }
  }

  // The conversation

  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  const toBottom = () => { chat.scrollTop = chat.scrollHeight; };

  function draw(item) {
    const stick = !booted || nearBottom();
    const el = item.type === 'turn' ? turnEl(item) : noticeEl(item.e);
    if (item.el) item.el.replaceWith(el);
    else {
      const i = items.indexOf(item);
      const prev = items[i - 1];
      if (!prev || dayKey(prev.at) !== dayKey(item.at)) {
        const d = document.createElement('h2');
        d.className = 'day';
        d.textContent = dayLabel(item.at);
        thread.insertBefore(d, queue);
      }
      thread.insertBefore(el, queue);
    }
    item.el = el;
    if (stick && booted) toBottom();
  }

  function noticeEl(e) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.dataset.eid = e.id;
    div.innerHTML = `<div>${esc(e.text)}</div>${e.action ? `<button type="button" class="flat-btn" data-send="${esc(e.action.send)}">${esc(e.action.label)}</button>` : ''}`;
    return div;
  }

  const active = (t) => !t.done && t === cur && status.working;
  const waitingAsk = (t) => t && t.asks.find((a) => !t.answers[a.ref] && !t.done);

  function youEl(e, queued) {
    const files = (e.files || []).map((f) => isImage(f)
      ? `<button type="button" class="thumb" data-open="${esc(f.url)}" aria-label="Open ${esc(f.name)}"><img src="${esc(lab.fileUrl(f.url))}" alt="${esc(f.name)}" loading="lazy"></button>`
      : `<button type="button" class="mini-file" data-open="${esc(f.url)}">${icon('doc')}<span>${esc(f.name)}</span></button>`).join('');
    const saved = shortcuts.some((s) => s.text.trim() === (e.text || '').trim());
    const menuOpen = !queued && selected === e.cid && e.text;
    const actions = menuOpen ? `<div class="menu-list" role="menu">
        <button type="button" role="menuitem" data-save="${esc(e.cid)}" ${saved ? 'disabled' : ''}>${saved ? 'Saved as Shortcut' : 'Save as Shortcut'}</button>
        <button type="button" role="menuitem" data-again="${esc(e.cid)}">Send Again</button>
        <button type="button" role="menuitem" data-copy="${esc(e.cid)}">Copy</button>
      </div>` : '';
    const meta = queued ? `${icon('clock')}Waiting to send` : clock(e.at);
    return `<div class="you${queued ? ' queued' : ''}" data-eid="${esc(e.id ?? '')}">
      ${files ? `<div class="you-files">${files}</div>` : ''}
      ${e.text ? `<button type="button" class="bubble" data-cid="${esc(e.cid)}" aria-expanded="${!!menuOpen}" aria-haspopup="menu">${esc(e.text)}</button>` : ''}
      <span class="meta">${meta}</span>${actions}</div>`;
  }

  function runEl(t) {
    const live = active(t);
    if (!t.steps.length && !live) return '';
    const ask = waitingAsk(t);
    const open = t.open ?? live;
    const n = t.steps.length;
    const count = `${n} step${n === 1 ? '' : 's'}`;
    let state, sum;
    if (live && ask) { state = 'wait'; sum = `<b>Waiting for you</b> · ${count}`; }
    else if (live) { state = 'go'; sum = `<b>${esc(status.label || 'Working')}</b>${n ? ` · ${count}` : ''}`; }
    else if (t.done?.stopped) { state = ''; sum = `<b>Stopped</b> · ${count}`; }
    else if (t.done && !t.done.ok) { state = 'bad'; sum = `<b>Didn't finish</b> · ${count}`; }
    else if (t.done) { state = 'ok'; sum = `${count} · ${took(t.done.ms)}`; }
    else { state = ''; sum = count; }
    const start = Date.parse(t.at);
    const steps = open ? `<ol class="steps">${t.steps.map((s, i) => {
      const bad = t.failed[s.ref];
      const isLive = live && !ask && i === n - 1 && !bad;
      const raw = t.raw.has(s.ref);
      return `<li class="step${bad ? ' bad' : ''}${isLive ? ' live' : ''}${s.sub ? ' sub' : ''}${t.fresh === s.ref ? ' in' : ''}">
        <button type="button" data-raw="${esc(s.ref)}" aria-expanded="${raw}" aria-label="${esc(s.title)}. ${raw ? 'Hide' : 'Show'} the command."><span class="sq"></span><span class="label">${esc(s.title)}</span><span class="when">${mmss(Date.parse(s.at) - start)}</span></button>
        ${bad ? `<div class="err">${esc(bad)}</div>` : ''}
        ${raw ? `<pre class="raw">${esc(s.detail || '')}</pre><div class="raw-tools"><button type="button" class="link-btn" data-copyraw="${esc(s.ref)}">${icon('copy')}Copy</button></div>` : ''}
      </li>`;
    }).join('')}</ol>` : '';
    return `<div class="run${open ? ' open' : ''}">
      <button type="button" class="run-head" data-run="${esc(t.id)}" aria-expanded="${open}"><span class="sq ${state}"></span><span class="sum">${sum}</span>${n ? icon('down') : ''}</button>
      ${live && !ask ? '<div class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' : ''}
      ${steps}</div>`;
  }

  function askEl(t, a) {
    const ans = t.answers[a.ref];
    if (ans) return `<div class="answered"><span class="sq ${ans.allow ? 'ok' : ''}"></span><span>${ans.allow ? 'Allowed' : 'Denied'}: ${esc(a.title)}</span></div>`;
    if (t.done) return `<div class="answered"><span class="sq"></span>Not answered: ${esc(a.title)}</div>`;
    return `<div class="ask" data-ask="${esc(a.ref)}" data-eid="${esc(a.id)}">
      <div class="ask-top">${icon('shield')}<h3>${esc(a.title)}</h3></div>
      ${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}
      <div class="ask-row"><button type="button" class="deny" data-answer="${esc(a.ref)}" data-allow="0">Deny</button><button type="button" class="allow" data-answer="${esc(a.ref)}" data-allow="1">Allow</button></div>
    </div>`;
  }

  function fileRow(f, sub) {
    return `<button type="button" class="out-file" data-open="${esc(f.url)}" data-eid="${esc(f.id ?? '')}"><span class="fi">${icon('doc')}</span><span><span class="fn">${esc(f.name)}</span><br><span class="fs">${esc(sub)}</span></span></button>`;
  }
  function outEl(e) {
    if (e.kind === 'reply') return `<div class="reply" data-eid="${esc(e.id)}">${md(e.text)}</div>`;
    if (isImage(e)) return `<button type="button" class="out-photo" data-open="${esc(e.url)}" data-eid="${esc(e.id)}"><img src="${esc(lab.fileUrl(e.url))}" alt="${esc(e.name)}" loading="lazy"><span>${esc(e.caption || e.name)} · ${bytes(e.size || 0)}</span></button>`;
    return fileRow(e, `${e.caption ? `${e.caption} · ` : ''}${bytes(e.size || 0)}`);
  }

  function turnEl(t) {
    const div = document.createElement('div');
    div.className = 'turn';
    let end = '';
    if (t.done?.stopped) end = `<div class="end">Stopped after ${took(t.done.ms)}</div>`;
    else if (t.done && !t.done.ok) end = `<div class="end">${esc(t.done.error || "This one didn't finish.")}</div>`;
    div.innerHTML = (t.you ? youEl(t.you) : '') + runEl(t) + t.asks.map((a) => askEl(t, a)).join('') + t.out.map(outEl).join('') + end;
    return div;
  }

  function drawQueue() {
    queue.innerHTML = outbox.map((m) => youEl({ ...m, id: '' }, true)).join('');
    if (booted) toBottom();
  }

  // Start: the machine line and the live tiles

  function drawMachine() {
    const m = $('machine');
    const off = link.state !== 'online';
    m.classList.toggle('off', off);
    const name = mac?.name || 'Your Mac';
    const where = link.state === 'unpaired' ? 'Not paired' : link.state === 'connecting' ? 'Connecting' : off ? (mac ? `Seen ${ago(mac.at)}` : "Can't reach it") : 'Online';
    m.innerHTML = `<span class="sq"></span><b>${esc(name)}</b><span>${where}</span>`;
  }

  const lastTurn = () => [...items].reverse().find((t) => t.type === 'turn' && t.you);
  const lastReply = () => {
    for (let i = items.length - 1; i >= 0; i--) {
      const r = items[i].type === 'turn' && [...items[i].out].reverse().find((o) => o.kind === 'reply');
      if (r) return r;
    }
    return null;
  };

  let tick = null;
  function drawNow() {
    const el = $('t-now');
    clearInterval(tick);
    tick = null;
    const ask = status.working && waitingAsk(cur);
    el.classList.toggle('live', status.working && !ask);
    el.classList.toggle('asking', !!ask);
    el.dataset.flip = status.working ? '' : '1';
    if (status.working) el.classList.remove('flipped');
    if (ask) {
      el.setAttribute('aria-label', `The Mac is waiting for you: ${ask.title}. Open the conversation.`);
      el.innerHTML = `<div class="flip"><div class="face">
        <div class="row-top">${icon('shield')}<span>Waiting for you</span></div>
        <div class="say two">${esc(ask.title)}</div>
        <div class="actions"><button type="button" class="tbtn" data-answer="${esc(ask.ref)}" data-allow="0">Deny</button><button type="button" class="tbtn solid" data-answer="${esc(ask.ref)}" data-allow="1">Allow</button></div>
      </div></div>`;
      return;
    }
    if (status.working) {
      const since = Date.parse(cur?.at || status.since || new Date().toISOString());
      el.setAttribute('aria-label', `The Mac is working: ${status.label || 'Working'}. Open the conversation.`);
      el.innerHTML = `<div class="flip"><div class="face">
        <div class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="say two">${esc(status.label || 'Working')}</div>
        <div class="actions"><span class="clock" id="now-clock"></span><button type="button" class="tbtn" data-stop>Stop</button></div>
      </div></div>`;
      const upd = () => { const c = $('now-clock'); if (c) c.textContent = `Working ${mmss(Date.now() - since)}`; };
      upd();
      tick = setInterval(upd, 1000);
      return;
    }
    const r = lastReply(), t = lastTurn();
    el.setAttribute('aria-label', 'Open the conversation');
    el.innerHTML = r ? `<div class="flip">
        <div class="face"><div class="say">${esc(plain(r.text))}</div><div class="tlabel"><span>Mac replied</span><span>${shortDay(r.at)}</span></div></div>
        <div class="face back"><div class="say">${esc(t?.you?.text || '')}</div><div class="tlabel"><span>You asked</span><span>${t ? shortDay(t.at) : ''}</span></div></div>
      </div>`
      : `<div class="flip"><div class="face"><div class="say">Ask the Mac anything. Replies land here.</div><div class="tlabel"><span>Chat</span></div></div></div>`;
    if (!r) el.dataset.flip = '';
  }

  function drawTiles() {
    const b = $('t-batt'), d = $('t-disk');
    const off = link.state !== 'online';
    if (!mac) {
      b.innerHTML = `<div class="flip"><div class="face"><div class="tlabel"><span>Battery</span></div></div></div>`;
      d.innerHTML = `<div class="flip"><div class="face"><div class="tlabel"><span>Disk</span></div></div></div>`;
      return;
    }
    const seen = off ? `Seen ${ago(mac.at)}` : '';
    if (mac.battery) {
      const p = mac.battery.percent;
      b.classList.toggle('low', p <= 20 && !mac.battery.charging);
      b.setAttribute('aria-label', `Battery ${p}%, ${mac.battery.charging ? 'charging' : 'on battery'}. Show Mac details.`);
      b.innerHTML = `<div class="flip">
        <div class="face"><div class="big">${p}<small>%</small></div><div class="tlabel"><span>${seen || 'Battery'}</span>${mac.battery.charging ? icon('bolt') : ''}</div></div>
        <div class="face back"><div class="say">${mac.battery.charging ? 'Charging' : 'On battery'}</div><div class="tlabel"><span>Up ${uptime(mac.uptime).replace(/, .*/, '')}</span></div></div>
      </div>`;
    } else {
      b.innerHTML = `<div class="flip"><div class="face"><div class="sub">Plugged in, no battery</div><div class="tlabel"><span>Power</span></div></div></div>`;
    }
    const free = mac.disk.free / 1e9, used = Math.round((1 - mac.disk.free / mac.disk.total) * 100);
    d.setAttribute('aria-label', `${bytes(mac.disk.free)} free of ${bytes(mac.disk.total)}. Show Mac details.`);
    d.innerHTML = `<div class="flip">
      <div class="face"><div class="big">${Math.round(free)}<small>GB</small></div><div class="tlabel"><span>${seen || 'Free on disk'}</span></div></div>
      <div class="face back"><div class="big">${used}<small>%</small></div><div class="tlabel"><span>Used of ${bytes(mac.disk.total)}</span></div></div>
    </div>`;
    b.dataset.flip = d.dataset.flip = '1';
  }

  function allFiles() {
    const all = [];
    for (const t of items) {
      if (t.type !== 'turn') continue;
      for (const f of t.you?.files || []) all.push({ ...f, at: t.you.at, who: 'you' });
      for (const o of t.out) if (o.kind === 'file') all.push({ ...o, who: 'mac' });
    }
    return all.reverse();
  }
  function drawFileTile() {
    const el = $('t-file');
    const all = allFiles();
    const photo = all.find(isImage), doc = all.find((f) => !isImage(f));
    const from = (f) => `${f.who === 'you' ? 'From you' : 'From the Mac'} · ${shortDay(f.at)}`;
    const docFace = (f, back) => `<div class="face${back ? ' back' : ''}">${icon('doc')}<div class="say two">${esc(f.caption || f.name)}</div><div class="tlabel"><span>${from(f)}</span><span>${bytes(f.size || 0)}</span></div></div>`;
    if (!all.length) { el.innerHTML = `<div class="flip"><div class="face"><div class="sub">Photos and files you trade with the Mac show up here.</div><div class="tlabel"><span>Files</span></div></div></div>`; el.dataset.flip = ''; return; }
    el.setAttribute('aria-label', `Files. Latest: ${(photo || doc).name}. Show all files.`);
    const front = photo ? `<div class="face photo-face"><img src="${esc(lab.fileUrl(photo.url))}" alt=""><span class="tag">${esc(photo.name)}</span></div>` : docFace(doc);
    el.innerHTML = `<div class="flip">${front}${photo && doc ? docFace(doc, true) : ''}</div>`;
    el.dataset.flip = photo && doc ? '1' : '';
  }

  function drawShortcuts() {
    const c = $('sc-tiles');
    c.innerHTML = shortcuts.map((s, i) => `<button type="button" class="tile half sc" data-sc="${esc(s.id)}" style="--i:${4 + i}" aria-label="${esc(s.label)}. Sends: ${esc(s.text)}"><span class="flip"><span class="face">${icon('bolt')}<span class="tlabel"><span>${esc(s.label)}</span></span></span></span></button>`).join('')
      + `<button type="button" class="tile half sc edit" data-manage style="--i:${4 + shortcuts.length}"><span class="flip"><span class="face">${icon('go')}<span class="tlabel"><span>${shortcuts.length ? 'Edit Shortcuts' : 'Add a Shortcut'}</span></span></span></span></button>`;
    for (const t of items) if (t.type === 'turn' && t.you && t.you.cid === selected) draw(t);
  }

  function drawTilesAll() { drawNow(); drawTiles(); drawFileTile(); }

  // One live tile turns over at a time, round the grid, like the phone did.
  const flippers = ['t-now', 't-batt', 't-disk', 't-file'];
  let flipAt = 0;
  setInterval(() => {
    if (still.matches || document.hidden) return;
    for (let k = 0; k < flippers.length; k++) {
      const el = $(flippers[(flipAt + k) % flippers.length]);
      if (el.dataset.flip === '1') { el.classList.toggle('flipped'); flipAt = (flipAt + k + 1) % flippers.length; return; }
    }
  }, 2600);

  // Tiles lean toward the finger.
  document.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('.tile');
    if (!t || still.matches || ev.target.closest('.tbtn')) return;
    const r = t.getBoundingClientRect();
    const dx = (ev.clientX - r.left) / r.width - 0.5, dy = (ev.clientY - r.top) / r.height - 0.5;
    const deg = 22 * 80 / Math.max(r.width, r.height);
    t.style.transform = `perspective(600px) rotateY(${(dx * deg).toFixed(1)}deg) rotateX(${(-dy * deg).toFixed(1)}deg) scale(.97)`;
    const up = () => { t.style.transform = ''; removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });

  function drawLink() {
    const show = link.state === 'offline' || link.state === 'unpaired';
    $('banner').hidden = !show;
    $('banner-text').textContent = link.detail || "Can't reach the Mac.";
    $('banner-fix').hidden = link.fix !== 'tailscale';
    $('banner-retry').hidden = link.state === 'unpaired';
  }

  // The panorama

  const pano = $('pano'), track = $('track');
  const panes = () => [...document.querySelectorAll('.pane')].filter((p) => !(wide.matches && p.dataset.pane === 'start'));
  const scroller = () => wide.matches ? track : pano;
  let pane = 'start';

  function go(name, smooth = true) {
    if (wide.matches && name === 'start') name = 'chat';
    const p = document.querySelector(`.pane[data-pane="${name}"]`);
    scroller().scrollTo({ left: p.offsetLeft, behavior: smooth && !still.matches ? 'smooth' : 'auto' });
    if (!smooth) sync();
  }

  function sync() {
    const s = scroller(), list = panes();
    const x = s.scrollLeft;
    let f = 0;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i].offsetLeft, b = list[i + 1].offsetLeft;
      if (x >= b) { f = i + 1; continue; }
      f = i + Math.max(0, (x - a) / (b - a));
      break;
    }
    const piv = list.map((p) => document.querySelector(`.pivot[data-go="${p.dataset.pane}"]`));
    const i = Math.min(Math.floor(f), piv.length - 1), j = Math.min(i + 1, piv.length - 1), k = f - i;
    const off = (n) => piv[n].offsetLeft - piv[0].offsetLeft;
    $('pivot-row').style.transform = `translateX(${-(off(i) + (off(j) - off(i)) * k)}px)`;
    const fold = wide.matches ? 0 : Math.min(1, x / list[1].offsetLeft);
    $('band').style.setProperty('--fold', fold.toFixed(3));
    $('title').style.transform = wide.matches ? '' : `translate(${-x * 0.3}px, ${-fold * 60}%)`;
    const now = list[Math.round(f)].dataset.pane;
    piv.forEach((p, n) => p.classList.toggle('on', n === Math.round(f)));
    if (now !== pane) {
      pane = now;
      if (pane === 'files') drawFiles();
      drawPip();
      backing();
    }
  }
  pano.addEventListener('scroll', sync, { passive: true });
  track.addEventListener('scroll', sync, { passive: true });
  addEventListener('resize', () => go(pane, false));
  wide.addEventListener('change', () => { pane = wide.matches ? 'chat' : 'start'; go(pane, false); toBottom(); });

  function drawPip() {
    const ask = status.working && waitingAsk(cur);
    $('chat-pip').hidden = !(status.working || ask) || pane === 'chat';
  }

  // Files

  function drawFiles() {
    const all = allFiles();
    const photos = all.filter(isImage), files = all.filter((f) => !isImage(f));
    $('files-body').innerHTML = !all.length ? `<p class="empty">Nothing yet. Photos and files you send to the Mac, and ones it sends you, show up here.</p>` :
      (photos.length ? `<h2 class="sec">photos</h2><div class="pgrid">${photos.map((f) => `<button type="button" class="ptile" data-open="${esc(f.url)}" aria-label="${esc(f.name)}, from ${f.who === 'you' ? 'you' : 'the Mac'}"><img src="${esc(lab.fileUrl(f.url))}" alt="" loading="lazy"><span class="${f.who}">${f.who === 'you' ? 'You' : 'Mac'}</span></button>`).join('')}</div>` : '')
      + (files.length ? `<h2 class="sec">documents</h2><ul class="flist">${files.map((f) => `<li>${fileRow(f, `${f.who === 'you' ? 'From you' : 'From the Mac'} · ${bytes(f.size || 0)} · ${shortDay(f.at)}`)}</li>`).join('')}</ul>` : '');
  }

  // History and search

  function hits(q) {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const t of items) {
      if (t.type !== 'turn') continue;
      if (t.you?.text?.toLowerCase().includes(needle)) out.push({ who: 'You', e: t.you, text: t.you.text, t });
      for (const f of t.you?.files || []) if (f.name.toLowerCase().includes(needle)) out.push({ who: 'You', e: t.you, text: f.name, t });
      for (const o of t.out) {
        const text = o.kind === 'reply' ? plain(o.text) : `${o.name}${o.caption ? `, ${o.caption}` : ''}`;
        if (text.toLowerCase().includes(needle)) out.push({ who: 'Mac', e: o, text, t });
      }
    }
    return out.reverse();
  }
  function snippet(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, i - 40);
    const s = (start ? '…' : '') + text.slice(start);
    const j = s.toLowerCase().indexOf(q.toLowerCase());
    return esc(s.slice(0, j)) + `<mark>${esc(s.slice(j, j + q.length))}</mark>` + esc(s.slice(j + q.length));
  }
  const turnState = (t) => (active(t) && waitingAsk(t)) || active(t) ? 'go' : t.done?.stopped ? '' : t.done && !t.done.ok ? 'bad' : t.done ? 'ok' : '';
  function drawHistory() {
    const q = $('search').value.trim();
    const r = $('results');
    if (!q) {
      const turns = items.filter((t) => t.type === 'turn' && t.you).reverse();
      r.innerHTML = turns.length ? `<ol class="reqs">${turns.map((t) => {
        const meta = active(t) && waitingAsk(t) ? 'Waiting for you' : active(t) ? 'Working now' : t.done && !t.done.ok && !t.done.stopped ? `Didn't finish · ${shortDay(t.at)}` : shortDay(t.at);
        return `<li><button type="button" class="req" data-jump="${esc(t.you.id)}"><span class="sq ${turnState(t)}"></span><span class="req-text">${esc(t.you.text)}</span><span class="req-meta">${meta}</span></button></li>`;
      }).join('')}</ol>` : `<p class="empty">Your requests show up here.</p>`;
      return;
    }
    const list = hits(q);
    r.innerHTML = !list.length ? `<p class="empty">Nothing matches "${esc(q)}".</p>`
      : `<p class="count">${list.length} result${list.length === 1 ? '' : 's'}</p><ol class="reqs">${list.map((h) => `<li><button type="button" class="req" data-jump="${esc(h.e.id)}"><span class="sq ${turnState(h.t)}"></span><span class="req-text">${snippet(h.text, q)}</span><span class="req-meta">${h.who === 'You' ? 'You' : 'The Mac'} · ${shortDay(h.e.at)}</span></button></li>`).join('')}</ol>`;
  }

  function jump(id) {
    go('chat');
    const el = thread.querySelector(`[data-eid="${CSS.escape(String(id))}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    const target = el.querySelector('.bubble') || el;
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // Full-screen pages: shortcuts and the Mac

  let pageKind = null;
  let draft = [];
  const barBtn = (attr, ic, label) => `<button type="button" ${attr}><span class="circ">${icon(ic)}</span>${label}</button>`;
  function openPage(kind, title, body, bar) {
    pageKind = kind;
    $('page-title').textContent = title;
    $('page-body').innerHTML = body;
    $('page-bar').innerHTML = bar;
    $('page').hidden = false;
    backing();
  }
  function closePage() {
    pageKind = null;
    $('page').hidden = true;
    backing();
  }
  function openManage() {
    if (pageKind !== 'manage') draft = shortcuts.map((s) => ({ ...s }));
    const list = draft.length
      ? `<ul class="sc-edit">${draft.map((s, i) => `<li><input class="field" value="${esc(s.label)}" data-label="${i}" aria-label="Name for ${esc(s.label)}" maxlength="40"><button type="button" class="circ" data-remove="${i}" aria-label="Remove ${esc(s.label)}">${icon('trash')}</button><span class="sends">Sends: ${esc(s.text)}</span></li>`).join('')}</ul>`
      : `<p class="empty">No shortcuts left. Tap one of your messages in chat and choose Save as Shortcut to add one.</p>`;
    openPage('manage', 'shortcuts', list, barBtn('data-savelist', 'check', 'Save') + barBtn('data-close', 'x', 'Cancel'));
  }
  function openNewShortcut(text) {
    const label = text.split(/\s+/).slice(0, 4).join(' ').replace(/[.,?!]+$/, '').slice(0, 28);
    openPage('new', 'new shortcut', `<label for="sc-label">Name</label><input id="sc-label" class="field" value="${esc(label)}" maxlength="40"><label for="sc-text">Sends</label><textarea id="sc-text" class="field" rows="4" maxlength="2000">${esc(text)}</textarea>`,
      barBtn('data-savenew', 'check', 'Save') + barBtn('data-close', 'x', 'Cancel'));
    $('sc-label').focus();
  }
  function openMac() {
    if (!mac) return;
    const rows = [
      ['Name', mac.name],
      ['Battery', mac.battery ? `${mac.battery.percent}%, ${mac.battery.charging ? 'charging' : 'on battery'}` : 'Plugged in, no battery'],
      ['Disk', `${bytes(mac.disk.free)} free of ${bytes(mac.disk.total)}`],
      ['Up for', uptime(mac.uptime)],
      ['Connection', link.state === 'online' ? 'Online' : link.detail || "Can't reach the Mac"],
      ['Updated', ago(mac.at)],
    ];
    openPage('mac', 'mac', `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`, barBtn('data-close', 'x', 'Close'));
  }
  async function saveList(list) {
    const ok = await lab.saveShortcuts(list);
    if (!ok) { toast("Couldn't save the shortcuts because the Mac can't be reached. Try again once it's back."); return false; }
    return true;
  }

  // The ask bar

  const text = $('text');
  const fit = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight + 4, 140)}px`; };
  const canSend = () => { $('send').disabled = !(text.value.trim() || pending.length) || uploading > 0; };
  function drawPending() {
    const p = $('pending');
    p.hidden = !pending.length && !uploading;
    p.innerHTML = pending.map((f, i) => `<div class="att">${isImage(f) ? `<img src="${esc(lab.fileUrl(f.url))}" alt="${esc(f.name)}">` : icon('doc')}<button type="button" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></div>`).join('')
      + (uploading ? `<div class="att loading">Sending to the Mac</div>` : '');
    canSend();
  }
  function drawStop() {
    $('stop').hidden = !status.working;
  }
  function send(t, files) {
    if (!t && !files?.length) return;
    lab.send(t, files?.length ? files : undefined);
    go('chat');
    requestAnimationFrame(toBottom);
  }
  function menu(open) {
    $('attach-menu').hidden = !open;
    $('attach').setAttribute('aria-expanded', String(open));
    backing();
  }
  async function attach(kind) {
    menu(false);
    uploading++;
    drawPending();
    try {
      pending.push(...await lab.attach(kind));
    } catch (err) {
      toast(err.message || "Couldn't send that to the Mac.");
    } finally {
      uploading--;
      drawPending();
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  // Back closes whatever is on top, then walks back to start.
  function top() {
    if (pageKind) return closePage;
    if (!$('attach-menu').hidden) return () => menu(false);
    if (selected) return () => { const t = findYou(selected); selected = null; if (t) draw(t); backing(); };
    if (wide.matches ? pane !== 'chat' : pane !== 'start') return () => go(wide.matches ? 'chat' : 'start');
    return null;
  }
  function backing() {
    lab.onBack(top() ? () => { top()?.(); } : null);
  }
  function findYou(cid) {
    for (const t of items) if (t.type === 'turn' && t.you?.cid === cid) return t;
    return null;
  }

  // Events

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button, a, [role=button]');
    if (!b) return;
    const d = b.dataset;
    if (b.matches('a[data-ext]')) { ev.preventDefault(); lab.open(b.href); return; }
    if (d.go) return go(d.go);
    if (d.open) return lab.open(d.open);
    if (d.answer) return lab.answer(d.answer, d.allow === '1');
    if (d.stop !== undefined) return lab.stop();
    if (d.send) return send(d.send);
    if (d.sc) { if (longFired) { longFired = false; return; } const s = shortcuts.find((x) => x.id === d.sc); if (s) send(s.text); return; }
    if (d.manage !== undefined) return openManage();
    if (d.run) { const t = items.find((x) => x.id === d.run); if (t) { t.open = !(t.open ?? active(t)); draw(t); } return; }
    if (d.raw) { const t = byRef.get(d.raw); if (t) { t.raw.has(d.raw) ? t.raw.delete(d.raw) : t.raw.add(d.raw); draw(t); } return; }
    if (d.copyraw) { const t = byRef.get(d.copyraw); const s = t?.steps.find((x) => x.ref === d.copyraw); if (s) { navigator.clipboard?.writeText(s.detail || '').catch(() => {}); toast('Copied the command.'); } return; }
    if (d.cid !== undefined && b.classList.contains('bubble')) {
      const was = selected;
      selected = selected === d.cid ? null : d.cid;
      for (const cid of [was, selected]) { const t = cid && findYou(cid); if (t) draw(t); }
      backing();
      return;
    }
    if (d.save) { const t = findYou(d.save); if (t) openNewShortcut(t.you.text); return; }
    if (d.again) { const t = findYou(d.again); selected = null; if (t) { draw(t); send(t.you.text); } return; }
    if (d.copy) { const t = findYou(d.copy); if (t) { navigator.clipboard?.writeText(t.you.text).catch(() => {}); toast('Copied.'); } return; }
    if (d.jump) return jump(d.jump);
    if (d.attach) return attach(d.attach);
    if (d.unattach) { pending.splice(Number(d.unattach), 1); drawPending(); return; }
    if (d.remove) { draft.splice(Number(d.remove), 1); openManage(); return; }
    if (d.close !== undefined) return closePage();
    if (d.savelist !== undefined) {
      document.querySelectorAll('[data-label]').forEach((i) => { draft[Number(i.dataset.label)].label = i.value.trim() || draft[Number(i.dataset.label)].label; });
      if (await saveList(draft)) closePage();
      return;
    }
    if (d.savenew !== undefined) {
      const label = $('sc-label').value.trim(), body = $('sc-text').value.trim();
      if (!label || !body) return toast('A shortcut needs a name and a message.');
      if (await saveList([...shortcuts, { id: '', label, text: body }])) { closePage(); const t = findYou(selected); selected = null; if (t) draw(t); toast(`Saved "${label}" as a shortcut.`); }
      return;
    }
    switch (b.id) {
      case 't-now': { const a = status.working && waitingAsk(cur); if (a) return jump(a.id); go('chat'); return requestAnimationFrame(toBottom); }
      case 't-batt': case 't-disk': return openMac();
      case 't-file': return go('files');
      case 'banner-fix': return lab.fix(link.fix);
      case 'banner-retry': return lab.retry();
      case 'attach': return menu($('attach-menu').hidden);
      case 'stop': return lab.stop();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role=button]')) { ev.preventDefault(); ev.target.click(); }
  });

  // Long-press a shortcut tile to manage them.
  let press = null, longFired = false;
  const grid = $('grid');
  grid.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('[data-sc]')) return;
    longFired = false;
    press = setTimeout(() => { longFired = true; openManage(); }, 500);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) grid.addEventListener(t, () => clearTimeout(press));
  grid.addEventListener('contextmenu', (ev) => { if (ev.target.closest('[data-sc]')) ev.preventDefault(); });

  document.addEventListener('pointerdown', (ev) => { if (!$('attach-menu').hidden && !ev.target.closest('#attach-menu, #attach')) menu(false); });
  $('search').addEventListener('input', drawHistory);
  $('search-form').addEventListener('submit', (ev) => { ev.preventDefault(); $('search').blur(); });
  text.addEventListener('input', () => { fit(); canSend(); });
  text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && lab.platform !== 'android') { ev.preventDefault(); $('form').requestSubmit(); }
  });
  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if ($('send').disabled) return;
    send(text.value.trim(), pending);
    text.value = '';
    pending = [];
    fit();
    drawPending();
  });
  thread.append(queue);
  lab.subscribe((e) => { take(e); if (e.kind === 'status') drawStop(); });
  setInterval(() => { if (link.state !== 'online') { drawMachine(); drawTiles(); } }, 30000);

  booted = true;
  drawMachine();
  drawTilesAll();
  drawShortcuts();
  drawLink();
  drawHistory();
  drawFiles();
  drawPending();
  drawStop();
  document.querySelectorAll('.grid > .tile').forEach((t, i) => { t.style.setProperty('--i', i); if (!t.hasAttribute('role')) { t.setAttribute('role', 'button'); t.tabIndex = 0; } });
  go(wide.matches ? 'chat' : 'start', false);
  toBottom();
  setTimeout(() => document.body.classList.remove('enter'), 1400);
  requestAnimationFrame(() => lab.ready());
})();
