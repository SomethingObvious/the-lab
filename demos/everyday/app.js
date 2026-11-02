(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;

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

  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayKey = (iso) => new Date(iso).toDateString();
  function dayLabel(iso) {
    const d = new Date(iso), today = new Date();
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  const shortDay = (iso) => {
    const l = dayLabel(iso);
    return l === 'Today' ? clock(iso) : l === 'Yesterday' ? 'Yesterday' : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
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

  // State built from events.
  const items = [];       // turns and notices, in order
  const byRef = new Map(); // the turn each step or ask belongs to
  let cur = null;
  let link = { state: 'connecting' };
  let status = { working: false, label: '' };
  let mac = null;
  let shortcuts = [];
  let outbox = [];
  let pending = [];
  let uploading = 0;
  let selected = null;     // cid of the bubble showing its actions
  let booted = false;

  const thread = $('thread');
  const queue = document.createElement('div');
  queue.className = 'queue';

  function newTurn(you, at) {
    const t = { type: 'turn', id: you ? `y${you.id}` : `t${Math.random()}`, you, at, steps: [], failed: {}, asks: [], answers: {}, out: [], done: null, open: undefined, raw: new Set() };
    items.push(t);
    cur = t;
    return t;
  }

  function take(e) {
    switch (e.kind) {
      case 'link': link = e; drawLink(); drawGlance(); return;
      case 'status': status = e; drawNow(); if (cur) draw(cur); drawSide(); return;
      case 'mac': mac = e; drawGlance(); return;
      case 'shortcuts': shortcuts = e.items || []; drawChips(); if (sheetKind === 'manage') openManage(); return;
      case 'outbox': outbox = e.items || []; drawQueue(); return;
      case 'insets': return;
      case 'design': return;
      case 'undone': return;
      case 'openFailed': toast("Nothing on this phone can open that file."); return;
      case 'you': { const t = newTurn(e, e.at); draw(t); drawSide(); return; }
      case 'notice': { const n = { type: 'notice', id: `n${e.id}`, e, at: e.at }; items.push(n); draw(n); return; }
    }
    const t = (e.kind === 'failed' || e.kind === 'answered') ? (byRef.get(e.ref) || cur) : cur || newTurn(null, e.at);
    if (!t) return;
    if (e.kind === 'step') { t.steps.push(e); byRef.set(e.ref, t); }
    else if (e.kind === 'failed') t.failed[e.ref] = e.text;
    else if (e.kind === 'ask') { t.asks.push(e); byRef.set(e.ref, t); }
    else if (e.kind === 'answered') t.answers[e.ref] = e;
    else if (e.kind === 'reply' || e.kind === 'file') t.out.push(e);
    else if (e.kind === 'done') t.done = e;
    else return;
    draw(t);
    if (e.kind === 'ask' || e.kind === 'answered' || e.kind === 'done') { drawNow(); drawSide(); }
    if (e.kind === 'file' && !$('files-view').hidden) drawFiles();
  }

  // Drawing the conversation

  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  const toBottom = () => { thread.scrollTop = thread.scrollHeight; };

  function draw(item) {
    const stick = !booted || nearBottom();
    const el = item.type === 'turn' ? turnEl(item) : noticeEl(item.e);
    if (item.el) item.el.replaceWith(el);
    else {
      const i = items.indexOf(item);
      const prev = items[i - 1];
      if (!prev || dayKey(prev.at) !== dayKey(item.at)) {
        const d = document.createElement('div');
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
    div.innerHTML = `<div>${esc(e.text)}</div>${e.action ? `<button type="button" class="pill" data-send="${esc(e.action.send)}">${esc(e.action.label)}</button>` : ''}`;
    return div;
  }

  const active = (t) => !t.done && t === cur && status.working;
  const waitingAsk = (t) => t.asks.find((a) => !t.answers[a.ref]);

  function youEl(e, queued) {
    const files = (e.files || []).map((f) => isImage(f)
      ? `<button type="button" class="thumb" data-open="${esc(f.url)}" aria-label="Open ${esc(f.name)}"><img src="${esc(lab.fileUrl(f.url))}" alt="${esc(f.name)}" loading="lazy"></button>`
      : `<button type="button" class="mini-file" data-open="${esc(f.url)}">${icon('doc')}<span>${esc(f.name)}</span></button>`).join('');
    const saved = shortcuts.some((s) => s.text.trim() === (e.text || '').trim());
    const actions = !queued && selected === e.cid && e.text ? `<div class="you-actions">
        <button type="button" class="pill" data-save="${esc(e.cid)}" ${saved ? 'disabled' : ''}>${icon('star')}${saved ? 'Saved as Shortcut' : 'Save as Shortcut'}</button>
        <button type="button" class="pill" data-again="${esc(e.cid)}">${icon('redo')}Send Again</button>
        <button type="button" class="pill icon-only" data-copy="${esc(e.cid)}" aria-label="Copy">${icon('copy')}</button>
      </div>` : '';
    const meta = queued ? `${icon('clock')}Waiting to send` : clock(e.at);
    return `<div class="you${queued ? ' queued' : ''}" data-eid="${esc(e.id ?? '')}">
      ${files ? `<div class="you-files">${files}</div>` : ''}
      ${e.text ? `<button type="button" class="bubble" data-cid="${esc(e.cid)}" aria-expanded="${selected === e.cid}">${esc(e.text)}</button>` : ''}
      <span class="meta">${meta}</span>${actions}</div>`;
  }

  function runEl(t) {
    const live = active(t);
    if (!t.steps.length && !live) return '';
    const ask = waitingAsk(t);
    const open = t.open ?? live;
    let state, sum;
    const n = t.steps.length;
    const count = `${n} step${n === 1 ? '' : 's'}`;
    if (live && ask) { state = 'wait'; sum = `<b>Paused</b> · ${count}`; }
    else if (live) { state = 'go'; sum = `<b>${esc(status.label || 'Working')}</b>${n ? ` · ${count}` : ''}`; }
    else if (t.done?.stopped) { state = 'stopped'; sum = `<b>Stopped</b> · ${count}`; }
    else if (t.done && !t.done.ok) { state = 'bad'; sum = `<b>Didn't finish</b> · ${count}`; }
    else if (t.done) { state = 'ok'; sum = `${count} · ${took(t.done.ms)}`; }
    else { state = 'stopped'; sum = count; }
    const mark = state === 'ok' ? icon('check') : state === 'bad' ? icon('x') : state === 'wait' ? icon('pause') : '';
    const start = Date.parse(t.at);
    const steps = open ? `<ol class="steps">${t.steps.map((s, i) => {
      const bad = t.failed[s.ref];
      const isLive = live && !ask && i === n - 1 && !bad;
      const raw = t.raw.has(s.ref);
      return `<li class="step${bad ? ' bad' : ''}${isLive ? ' live' : ''}${s.sub ? ' sub' : ''}">
        <button type="button" data-raw="${esc(s.ref)}" aria-expanded="${raw}"><span class="dotk"></span><span class="label">${esc(s.title)}</span><span class="when">${mmss(Date.parse(s.at) - start)}</span></button>
        ${bad ? `<div class="err">${esc(bad)}</div>` : ''}
        ${raw ? `<pre class="raw">${esc(s.detail || '')}</pre><div class="raw-tools"><button type="button" class="link-btn" data-copyraw="${esc(s.ref)}">${icon('copy')}Copy</button></div>` : ''}
      </li>`;
    }).join('')}</ol>` : '';
    return `<div class="run${open ? ' open' : ''}${live ? ' live' : ''}">
      <button type="button" class="run-head" data-run="${esc(t.id)}" aria-expanded="${open}"><span class="state ${state}">${mark}</span><span class="sum">${sum}</span>${n ? icon('chev') : ''}</button>
      ${steps}</div>`;
  }

  function askEl(t, a) {
    const ans = t.answers[a.ref];
    if (ans) return `<div class="answered"><span class="state ${ans.allow ? 'ok' : 'stopped'}">${ans.allow ? icon('check') : icon('x')}</span><span>${ans.allow ? 'Allowed' : 'Denied'}: ${esc(a.title)}</span></div>`;
    if (t.done) return `<div class="answered"><span class="state stopped"></span>Not answered: ${esc(a.title)}</div>`;
    return `<div class="ask" data-ask="${esc(a.ref)}" data-eid="${esc(a.id)}">
      <div class="ask-top">${icon('shield')}<div><p class="ask-kicker">Needs your OK</p><h3>${esc(a.title)}</h3></div></div>
      ${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}
      <div class="ask-row"><button type="button" class="deny" data-answer="${esc(a.ref)}" data-allow="0">Deny</button><button type="button" class="allow" data-answer="${esc(a.ref)}" data-allow="1">Allow</button></div>
    </div>`;
  }

  function outEl(e) {
    if (e.kind === 'reply') return `<div class="reply" data-eid="${esc(e.id)}">${md(e.text)}</div>`;
    if (isImage(e)) return `<button type="button" class="photo" data-open="${esc(e.url)}" data-eid="${esc(e.id)}"><img src="${esc(lab.fileUrl(e.url))}" alt="${esc(e.name)}" loading="lazy"><span>${esc(e.caption || e.name)}</span></button>`;
    return `<button type="button" class="file" data-open="${esc(e.url)}" data-eid="${esc(e.id)}"><span class="fi">${icon('doc')}</span><span><span class="fn">${esc(e.name)}</span><br><span class="fs">${esc(e.caption ? `${e.caption} · ` : '')}${bytes(e.size || 0)}</span></span></button>`;
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
    queue.innerHTML = outbox.map((m) => `<div class="turn">${youEl({ ...m, id: '' }, true)}</div>`).join('');
    if (booted) toBottom();
  }

  // Top bar, Mac at a glance, the now bar and the link banner

  let glanceOpen = false;
  function drawGlance() {
    const g = $('glance');
    const off = link.state !== 'online';
    g.classList.toggle('off', off);
    const parts = [];
    if (link.state === 'unpaired') parts.push(`<span class="glance-item"><span class="dot"></span><span class="who">Not paired</span></span>`);
    else if (off) parts.push(`<span class="glance-item"><span class="dot"></span><span class="who">${link.state === 'connecting' ? 'Connecting' : "Can't reach the Mac"}</span></span>`);
    else parts.push(`<span class="glance-item"><span class="dot"></span><span class="who">Online</span></span>`);
    if (mac) {
      if (mac.battery) {
        const p = mac.battery.percent;
        parts.push(`<span class="glance-item v"><span class="batt${p <= 20 ? ' low' : ''}"><i style="width:${Math.max(6, p)}%"></i></span>${p}%${mac.battery.charging ? icon('bolt') : ''}</span>`);
      }
      parts.push(`<span class="glance-item v">${icon('disk')}${bytes(mac.disk.free)} free</span>`);
      if (off) parts.push(`<span class="glance-item">Seen ${ago(mac.at)}</span>`);
    }
    $('glance-line').innerHTML = parts.join('');
    const more = $('glance-more');
    more.hidden = !glanceOpen || !mac;
    if (mac) {
      more.innerHTML = `<span>Mac</span><b>${esc(mac.name)}</b>
        <span>Battery</span><b>${mac.battery ? `${mac.battery.percent}%, ${mac.battery.charging ? 'charging' : 'on battery'}` : 'Plugged in, no battery'}</b>
        <span>Disk</span><b>${bytes(mac.disk.free)} free of ${bytes(mac.disk.total)}</b>
        <span>Up for</span><b>${uptime(mac.uptime)}</b>
        <span>Updated</span><b>${ago(mac.at)}</b>`;
    }
    g.setAttribute('aria-expanded', String(glanceOpen && !!mac));
    g.setAttribute('aria-label', `${g.textContent.replace(/\s+/g, ' ').trim()}. ${glanceOpen ? 'Hide' : 'Show'} details.`);
  }

  let tick = null;
  function drawNow() {
    const bar = $('now');
    bar.hidden = !status.working;
    clearInterval(tick);
    tick = null;
    if (!status.working) { drawGlance(); return; }
    const ask = cur && waitingAsk(cur);
    bar.classList.toggle('asking', !!ask);
    $('now-label').textContent = ask ? 'Needs your OK' : status.label || 'Working';
    $('now-jump').hidden = !ask;
    const since = Date.parse(cur?.at || status.since);
    const upd = () => { $('now-time').textContent = `Working for ${mmss(Date.now() - since)}`; };
    upd();
    tick = setInterval(upd, 1000);
    drawGlance();
  }

  function drawLink() {
    const show = link.state === 'offline' || link.state === 'unpaired';
    $('banner').hidden = !show;
    $('banner-text').textContent = link.detail || "Can't reach the Mac.";
    $('banner-fix').hidden = link.fix !== 'tailscale';
    $('banner-retry').hidden = link.state === 'unpaired';
  }

  // Shortcuts

  function drawChips() {
    const c = $('chips');
    c.hidden = !shortcuts.length;
    c.innerHTML = shortcuts.map((s) => `<button type="button" class="chip" data-sc="${esc(s.id)}" title="${esc(s.text)}">${esc(s.label)}</button>`).join('')
      + (shortcuts.length ? `<button type="button" class="chip edit" id="manage">${icon('edit')}Edit</button>` : '');
    for (const t of items) if (t.type === 'turn' && t.you && t.you.cid === selected) draw(t);
  }

  // Bottom sheet

  let sheetKind = null;
  let draft = [];
  function openSheet(kind, title, body, actions) {
    sheetKind = kind;
    $('sheet-title').textContent = title;
    $('sheet-body').innerHTML = body;
    $('sheet-actions').innerHTML = actions;
    $('sheet').hidden = false;
    $('scrim').hidden = false;
    backing();
  }
  function closeSheet() {
    sheetKind = null;
    $('sheet').hidden = true;
    $('scrim').hidden = true;
    backing();
  }
  function openManage() {
    if (sheetKind !== 'manage') draft = shortcuts.map((s) => ({ ...s }));
    const list = draft.length
      ? `<ul class="sc-list">${draft.map((s, i) => `<li><div class="sc-fields"><input value="${esc(s.label)}" data-label="${i}" aria-label="Name for ${esc(s.label)}" maxlength="40"><span class="sc-text">${esc(s.text)}</span></div><button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(s.label)}">${icon('trash')}</button></li>`).join('')}</ul>`
      : `<p class="hint">No shortcuts left. Tap one of your messages and choose Save as Shortcut to add one.</p>`;
    openSheet('manage', 'Shortcuts', list, `<button type="button" data-close>Cancel</button><button type="button" class="primary" data-savelist>Save</button>`);
  }
  function openNewShortcut(text) {
    const label = text.split(/\s+/).slice(0, 4).join(' ').replace(/[.,?!]+$/, '').slice(0, 28);
    openSheet('new', 'New Shortcut', `<label for="sc-label">Name</label><input id="sc-label" value="${esc(label)}" maxlength="40"><label for="sc-text">Sends</label><textarea id="sc-text" rows="3" maxlength="2000">${esc(text)}</textarea>`,
      `<button type="button" data-close>Cancel</button><button type="button" class="primary" data-savenew>Save</button>`);
    $('sc-label').focus();
  }
  async function saveList(list) {
    const ok = await lab.saveShortcuts(list);
    if (!ok) { toast("Couldn't save the shortcuts because the Mac can't be reached. Try again once it's back."); return false; }
    return true;
  }

  // Search

  function hits(q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    for (const t of items) {
      if (t.type !== 'turn') continue;
      if (t.you?.text?.toLowerCase().includes(needle)) out.push({ who: 'You', e: t.you, text: t.you.text });
      for (const f of t.you?.files || []) if (f.name.toLowerCase().includes(needle)) out.push({ who: 'You', e: t.you, text: f.name });
      for (const o of t.out) {
        const text = o.kind === 'reply' ? o.text.replace(/\*\*|`/g, '') : `${o.name}${o.caption ? `, ${o.caption}` : ''}`;
        if (text.toLowerCase().includes(needle)) out.push({ who: 'Mac', e: o, text });
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
  function drawResults() {
    const q = $('search').value;
    const r = $('results');
    const list = hits(q);
    r.innerHTML = !q.trim() ? `<p class="empty-state">Search your requests, the Mac's replies and file names.</p>`
      : !list.length ? `<p class="empty-state">Nothing matches "${esc(q)}".</p>`
      : `<p class="count">${list.length} result${list.length === 1 ? '' : 's'}</p><ol>${list.map((h) => `<li><button type="button" class="hit" data-jump="${esc(h.e.id)}"><span class="hit-top"><b>${h.who}</b><span>${shortDay(h.e.at)}</span></span><span class="hit-text">${snippet(h.text, q.trim())}</span></button></li>`).join('')}</ol>`;
  }
  function openSearch() {
    $('bar-main').hidden = true;
    $('search-row').hidden = false;
    $('results').hidden = false;
    drawResults();
    $('search').focus();
    backing();
  }
  function closeSearch() {
    $('bar-main').hidden = false;
    $('search-row').hidden = true;
    $('results').hidden = true;
    $('search').value = '';
    backing();
  }
  function jump(id) {
    const el = thread.querySelector(`[data-eid="${CSS.escape(String(id))}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    const target = el.querySelector('.bubble') || el;
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // Requests pane, unfolded

  let currentReq = null;
  function drawSide() {
    const q = $('side-search').value.trim().toLowerCase();
    const turns = items.filter((t) => t.type === 'turn' && t.you).reverse();
    const shown = q ? turns.filter((t) => t.you.text.toLowerCase().includes(q) || t.out.some((o) => (o.text || o.name || '').toLowerCase().includes(q))) : turns;
    $('side-list').innerHTML = shown.length ? shown.map((t) => {
      const ask = active(t) && waitingAsk(t);
      const state = ask ? 'wait' : active(t) ? 'go' : t.done?.stopped ? 'stopped' : t.done && !t.done.ok ? 'bad' : t.done ? 'ok' : 'stopped';
      const mark = state === 'ok' ? icon('check') : state === 'bad' ? icon('x') : state === 'wait' ? icon('pause') : '';
      const meta = ask ? 'Needs your OK' : active(t) ? 'Working now' : shortDay(t.at);
      return `<li><button type="button" class="req${t.id === (currentReq ?? cur?.id) ? ' current' : ''}" data-req="${esc(t.id)}"><span class="state ${state}">${mark}</span><span class="req-body"><span class="req-text">${esc(t.you.text)}</span><span class="req-meta">${meta}</span></span></button></li>`;
    }).join('') : `<li class="side-empty">${q ? `Nothing matches "${esc(q)}".` : 'Your requests show up here.'}</li>`;
  }

  // Files view

  function drawFiles() {
    const all = [];
    for (const t of items) {
      if (t.type !== 'turn') continue;
      for (const f of t.you?.files || []) all.push({ ...f, at: t.you.at, who: 'You' });
      for (const o of t.out) if (o.kind === 'file') all.push({ ...o, who: 'Mac' });
    }
    all.reverse();
    const photos = all.filter(isImage), files = all.filter((f) => !isImage(f));
    $('files-body').innerHTML = !all.length ? `<p class="empty-state">Nothing yet. Photos and files you send to the Mac, and ones it sends you, show up here.</p>` :
      (photos.length ? `<h3>Photos</h3><div class="grid">${photos.map((f) => `<button type="button" class="tile" data-open="${esc(f.url)}" aria-label="${esc(f.name)}, from ${f.who === 'You' ? 'you' : 'the Mac'}"><img src="${esc(lab.fileUrl(f.url))}" alt="" loading="lazy"><span>${f.who}</span></button>`).join('')}</div>` : '')
      + (files.length ? `<h3>Files</h3><ul class="flist">${files.map((f) => `<li><button type="button" class="file" data-open="${esc(f.url)}"><span class="fi">${icon('doc')}</span><span><span class="fn">${esc(f.name)}</span><br><span class="fs"><span class="who-tag">${f.who === 'You' ? 'From you' : 'From the Mac'}</span> · ${bytes(f.size || 0)} · ${shortDay(f.at)}</span></span></button></li>`).join('')}</ul>` : '');
  }
  function openFiles() { drawFiles(); $('files-view').hidden = false; backing(); }
  function closeFiles() { $('files-view').hidden = true; backing(); }

  // Composer

  const text = $('text');
  const fit = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 160)}px`; };
  const canSend = () => { $('send').disabled = !(text.value.trim() || pending.length) || uploading > 0; };
  function drawPending() {
    const p = $('pending');
    p.hidden = !pending.length && !uploading;
    p.innerHTML = pending.map((f, i) => `<div class="att">${isImage(f) ? `<img src="${esc(lab.fileUrl(f.url))}" alt="">` : `<span class="fi">${icon('doc')}</span>`}<span>${esc(f.name)}</span><button type="button" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">${icon('close')}</button></div>`).join('')
      + (uploading ? `<div class="att loading">Sending to the Mac</div>` : '');
    canSend();
  }
  function send(t, files) {
    if (!t && !files?.length) return;
    lab.send(t, files?.length ? files : undefined);
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
      const got = await lab.attach(kind);
      pending.push(...got);
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

  // Back closes whatever is on top.
  function top() {
    if (sheetKind) return closeSheet;
    if (!$('attach-menu').hidden) return () => menu(false);
    if (!$('files-view').hidden) return closeFiles;
    if (!$('search-row').hidden) return closeSearch;
    if (selected) return () => { const was = selected; selected = null; for (const t of items) if (t.type === 'turn' && t.you?.cid === was) draw(t); backing(); };
    return null;
  }
  function backing() {
    const fn = top();
    lab.onBack(fn ? () => { top()?.(); } : null);
  }

  function findYou(cid) {
    for (const t of items) if (t.type === 'turn' && t.you?.cid === cid) return t;
    return null;
  }

  // Events

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button, a');
    if (!b) return;
    const d = b.dataset;
    if (b.matches('a[data-ext]')) { ev.preventDefault(); lab.open(b.href); return; }
    if (d.open) return lab.open(d.open);
    if (d.answer) return lab.answer(d.answer, d.allow === '1');
    if (d.send) return send(d.send);
    if (d.sc) { if (longFired) { longFired = false; return; } const s = shortcuts.find((x) => x.id === d.sc); if (s) send(s.text); return; }
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
    if (d.again) { const t = findYou(d.again); if (t) send(t.you.text); return; }
    if (d.copy) { const t = findYou(d.copy); if (t) { navigator.clipboard?.writeText(t.you.text).catch(() => {}); toast('Copied.'); } return; }
    if (d.jump) { closeSearch(); jump(d.jump); return; }
    if (d.req) { currentReq = d.req; const t = items.find((x) => x.id === d.req); if (t) { closeFiles(); jump(t.you.id); } drawSide(); return; }
    if (d.attach) return attach(d.attach);
    if (d.unattach) { pending.splice(Number(d.unattach), 1); drawPending(); return; }
    if (d.remove) { draft.splice(Number(d.remove), 1); openManage(); return; }
    if (d.close !== undefined) return closeSheet();
    if (d.savelist !== undefined) {
      document.querySelectorAll('[data-label]').forEach((i) => { draft[Number(i.dataset.label)].label = i.value.trim() || draft[Number(i.dataset.label)].label; });
      if (await saveList(draft)) closeSheet();
      return;
    }
    if (d.savenew !== undefined) {
      const label = $('sc-label').value.trim(), body = $('sc-text').value.trim();
      if (!label || !body) return toast('A shortcut needs a name and a message.');
      if (await saveList([...shortcuts, { id: '', label, text: body }])) { closeSheet(); selected = null; const t = items.find((x) => x.type === 'turn' && x.you?.text === body); if (t) draw(t); toast(`Saved "${label}" as a shortcut.`); }
      return;
    }
    switch (b.id) {
      case 'open-search': return openSearch();
      case 'close-search': return closeSearch();
      case 'open-files': return openFiles();
      case 'close-files': return closeFiles();
      case 'glance': glanceOpen = !glanceOpen; return drawGlance();
      case 'now-stop': return lab.stop();
      case 'now-jump': { const a = cur && waitingAsk(cur); if (a) jump(a.id); return; }
      case 'banner-fix': return lab.fix(link.fix);
      case 'banner-retry': return lab.retry();
      case 'attach': return menu($('attach-menu').hidden);
      case 'manage': return openManage();
    }
  });

  // Long-press a shortcut to manage them.
  let press = null, longFired = false;
  $('chips').addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('[data-sc]')) return;
    longFired = false;
    press = setTimeout(() => { longFired = true; openManage(); }, 500);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) $('chips').addEventListener(t, () => clearTimeout(press));
  $('chips').addEventListener('contextmenu', (ev) => { if (ev.target.closest('[data-sc]')) ev.preventDefault(); });

  $('scrim').addEventListener('click', closeSheet);
  document.addEventListener('pointerdown', (ev) => { if (!$('attach-menu').hidden && !ev.target.closest('.attach-wrap')) menu(false); });
  $('search').addEventListener('input', drawResults);
  $('search-row').addEventListener('submit', (ev) => { ev.preventDefault(); $('search').blur(); });
  $('side-search').addEventListener('input', drawSide);
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
    toBottom();
  });
  // Ages in the glance strip go stale while the Mac is away.
  setInterval(() => { if (link.state !== 'online' || glanceOpen) drawGlance(); }, 30000);

  thread.append(queue);
  lab.subscribe(take);
  booted = true;
  drawChips();
  drawGlance();
  drawNow();
  drawLink();
  drawSide();
  drawPending();
  toBottom();
  requestAnimationFrame(() => lab.ready());
})();
