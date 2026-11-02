(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const tile = (k, ic = k) => `<span class="tile t-${k}">${icon(ic)}</span>`;

  // Every step gets the colour of what it touched.
  function kind(tool = '') {
    if (/^(Bash|PowerShell|Monitor|KillShell|BashOutput)$/.test(tool)) return 'term';
    if (/^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return 'file';
    if (/^(Grep|Glob|WebSearch|ToolSearch)$/.test(tool)) return 'find';
    if (tool === 'WebFetch') return 'web';
    if (tool.startsWith('mcp__claude-in-chrome__')) return 'browser';
    if (tool === 'mcp__lab__send_to_phone') return 'phone';
    return 'agent';
  }
  const CMD_KINDS = ['brand', 'term', 'web', 'file', 'find', 'phone', 'browser'];

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
      if (i % 2) { out.push(`<pre class="raw"><code>${part.replace(/\n$/, '')}</code></pre>`); return; }
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
  const guideStamp = (iso) => { const l = dayLabel(iso); return `${l === 'Today' || l === 'Yesterday' ? l : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(iso)}`; };
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const took = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
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
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  const isImage = (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp|heic)$/i.test(f.name || '');

  // State built from events.
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
  const queue = document.createElement('div');
  queue.className = 'queue';

  function newTurn(you, at) {
    const t = { type: 'turn', id: you ? `y${you.id}` : `t${Math.random()}`, you, at, steps: [], failed: {}, asks: [], answers: {}, out: [], done: null, open: undefined, raw: new Set() };
    items.push(t);
    const prev = cur;
    cur = t;
    if (prev && prev !== t) draw(prev);
    return t;
  }

  function take(e) {
    switch (e.kind) {
      case 'link': link = e; drawLink(); drawReadout(); return;
      case 'status': status = e; drawCapsule(); if (cur) draw(cur); drawSide(); return;
      case 'mac': mac = e; drawReadout(); return;
      case 'shortcuts': shortcuts = e.items || []; drawCmds(); if (sheetKind === 'manage') openManage(); return;
      case 'outbox': outbox = e.items || []; drawQueue(); return;
      case 'insets': case 'design': case 'undone': return;
      case 'openFailed': toast('Nothing on this phone can open that file.'); return;
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
    if (e.kind === 'ask' || e.kind === 'answered' || e.kind === 'done') { drawCapsule(); drawSide(); }
    if (e.kind === 'file' && !$('files-view').hidden) drawFiles();
  }

  // The conversation

  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
  const toBottom = () => { thread.scrollTop = thread.scrollHeight; guide(); };

  function draw(item) {
    if (!booted && item.type === 'turn' && item !== cur) { pendingDraw.add(item); return; }
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
    el.dataset.at = item.at;
    if (stick && booted) toBottom();
  }
  const pendingDraw = new Set();

  function noticeEl(e) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.dataset.eid = e.id;
    div.innerHTML = `${tile('agent', 'note')}<div>${esc(e.text)}${e.action ? `<br><button type="button" class="pill" data-send="${esc(e.action.send)}">${esc(e.action.label)}</button>` : ''}</div>`;
    return div;
  }

  const active = (t) => !t.done && t === cur && status.working;
  const waitingAsk = (t) => t.asks.find((a) => !t.answers[a.ref]);

  function youEl(e, queued) {
    const files = (e.files || []).map((f) => isImage(f)
      ? `<button type="button" class="thumb" data-open="${esc(f.url)}" aria-label="Open ${esc(f.name)}"><img src="${esc(lab.fileUrl(f.url))}" alt="${esc(f.name)}" loading="lazy"></button>`
      : `<button type="button" class="mini-file" data-open="${esc(f.url)}">${tile('file')}<span>${esc(f.name)}</span></button>`).join('');
    const saved = shortcuts.some((s) => s.text.trim() === (e.text || '').trim());
    const actions = !queued && selected === e.cid && e.text ? `<div class="q-actions">
        <button type="button" class="pill" data-save="${esc(e.cid)}" ${saved ? 'disabled' : ''}>${icon('star')}${saved ? 'Saved as Shortcut' : 'Save as Shortcut'}</button>
        <button type="button" class="pill" data-again="${esc(e.cid)}">${icon('redo')}Send Again</button>
        <button type="button" class="pill" data-copy="${esc(e.cid)}" aria-label="Copy">${icon('copy')}Copy</button>
      </div>` : '';
    const meta = queued ? `${icon('wifi')}Waiting` : clock(e.at);
    const text = e.text || (e.files?.length ? `Sent ${e.files.length === 1 ? 'a file' : `${e.files.length} files`}` : '');
    return `<button type="button" class="q" data-cid="${esc(e.cid)}" data-eid="${esc(e.id ?? '')}" aria-expanded="${selected === e.cid}"><span class="q-text">${esc(text)}</span><span class="q-time">${meta}</span></button>
      ${files ? `<div class="you-files">${files}</div>` : ''}${actions}`;
  }

  function stepRow(t, s, i, live, ask) {
    const bad = t.failed[s.ref];
    const k = kind(s.tool);
    const isLive = live && !ask && i === t.steps.length - 1 && !bad;
    const raw = t.raw.has(s.ref);
    // Redraws replace the row, so only the first draw of a newly live step plays the flood.
    const fresh = isLive && t.flooded !== s.ref;
    if (fresh) t.flooded = s.ref;
    return `<li class="row t-${k}${bad ? ' bad' : ''}${isLive ? ' live' : ''}${fresh ? ' fresh' : ''}${s.sub ? ' sub' : ''}">
      <button type="button" class="row-btn" data-raw="${esc(s.ref)}" aria-expanded="${raw}">${bad ? `<span class="tile">${icon('x')}</span>` : tile(k)}<span class="row-title">${esc(s.title)}</span><span class="row-time">${mmss(Date.parse(s.at) - Date.parse(t.at))}</span></button>
      ${bad ? `<p class="err">${esc(bad)}</p>` : ''}
      ${raw ? `<pre class="raw">${esc(s.detail || '')}</pre><div class="raw-tools"><button type="button" class="link-btn" data-copyraw="${esc(s.ref)}">${icon('copy')}Copy</button></div>` : ''}
    </li>`;
  }

  function runEl(t) {
    const live = active(t);
    const n = t.steps.length;
    if (!n && !live) return '';
    const ask = waitingAsk(t);
    const open = t.open ?? live;
    if (open) return `<ol class="rows">${t.steps.map((s, i) => stepRow(t, s, i, live, ask)).join('')}
      ${live && !ask && !n ? `<li class="row t-brand live"><div class="row-btn">${tile('brand', 'agent')}<span class="row-title">${esc(status.label || 'Working')}</span></div></li>` : ''}</ol>
      ${!live ? `<button type="button" class="sum-btn" data-run="${esc(t.id)}" aria-expanded="true"><span class="sum-text">Hide steps</span>${icon('chev', 'chev')}</button>` : ''}`;
    const stack = t.steps.slice(0, 6).map((s) => t.failed[s.ref] ? `<span class="tile t-ask">${icon('x')}</span>` : tile(kind(s.tool))).join('');
    const label = t.done?.stopped ? '<b>Stopped</b>' : t.done && !t.done.ok ? "<b>Didn't finish</b>" : `${n} step${n === 1 ? '' : 's'}`;
    return `<button type="button" class="sum-btn" data-run="${esc(t.id)}" aria-expanded="false"><span class="stack">${stack}</span><span class="sum-text">${label}</span>${t.done ? `<span class="num">${took(t.done.ms)}</span>` : ''}${icon('chev', 'chev')}</button>`;
  }

  function askEl(t, a) {
    const ans = t.answers[a.ref];
    if (ans) return `<div class="answered">${ans.allow ? `<span class="tile t-ok">${icon('check')}</span>` : `<span class="tile t-agent">${icon('x')}</span>`}<span>${ans.allow ? 'Allowed' : 'Denied'}: ${esc(a.title)}</span></div>`;
    if (t.done) return `<div class="answered"><span class="tile t-agent">${icon('x')}</span><span>Not answered: ${esc(a.title)}</span></div>`;
    return `<div class="ask" data-ask="${esc(a.ref)}" data-eid="${esc(a.id)}">
      <div class="ask-top"><span class="tile">${icon('ask')}</span><div><p class="ask-k">Needs your OK</p><h3>${esc(a.title)}</h3></div></div>
      ${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}
      <div class="ask-row"><button type="button" class="deny" data-answer="${esc(a.ref)}" data-allow="0">Deny</button><button type="button" class="allow" data-answer="${esc(a.ref)}" data-allow="1">Allow</button></div>
    </div>`;
  }

  function outEl(e) {
    if (e.kind === 'reply') return `<div class="reply-wrap" data-eid="${esc(e.id)}">${tile('brand', 'agent')}<div class="reply">${md(e.text)}</div></div>`;
    if (isImage(e)) return `<button type="button" class="photo" data-open="${esc(e.url)}" data-eid="${esc(e.id)}"><img src="${esc(lab.fileUrl(e.url))}" alt="${esc(e.name)}" loading="lazy"><span>${esc(e.caption || e.name)}</span></button>`;
    return `<button type="button" class="file" data-open="${esc(e.url)}" data-eid="${esc(e.id)}">${tile('phone', 'file')}<span><span class="fn">${esc(e.name)}</span><br><span class="fs">${esc(e.caption ? `${e.caption} · ` : '')}${bytes(e.size || 0)}</span></span></button>`;
  }

  function turnEl(t) {
    const div = document.createElement('section');
    const live = active(t) || (t === cur && !t.done && status.working);
    div.className = `req${live ? ' live' : ''}${t !== cur && t.done ? ' settled' : ''}`;
    let end = '';
    if (t.done?.stopped) end = `<p class="end">Stopped after ${took(t.done.ms)}</p>`;
    else if (t.done && !t.done.ok) end = `<p class="end">${esc(t.done.error || "This one didn't finish.")}</p>`;
    div.innerHTML = (t.you ? youEl(t.you) : '') + runEl(t) + t.asks.map((a) => askEl(t, a)).join('') + t.out.map(outEl).join('') + end;
    return div;
  }

  function drawQueue() {
    queue.innerHTML = outbox.map((m) => `<section class="req">${youEl({ ...m, id: '' }, true)}</section>`).join('');
    if (booted) toBottom();
  }

  // Guide words: the first and last request in view.
  function guide() {
    const top = thread.scrollTop, bottom = top + thread.clientHeight;
    const seen = [...thread.querySelectorAll('.req[data-at], .notice[data-at]')].filter((el) => el.offsetTop + el.offsetHeight > top && el.offsetTop < bottom);
    if (!seen.length) { $('guide').textContent = ''; return; }
    const first = seen[0].dataset.at, last = seen.at(-1).dataset.at;
    const a = guideStamp(first), b = dayKey(first) === dayKey(last) ? clock(last) : guideStamp(last);
    $('guide').textContent = a.endsWith(b) ? a : `${a} to ${b}`;
  }

  // Mac readout

  let readoutOpen = false;
  function drawReadout() {
    const r = $('readout');
    const off = link.state === 'offline' || link.state === 'unpaired';
    r.classList.toggle('off', off);
    r.classList.toggle('connecting', link.state === 'connecting');
    $('mac-name').textContent = mac?.name || 'The Lab';
    const v = [];
    if (link.state === 'unpaired') v.push('<span class="v seen">Not paired</span>');
    if (mac) {
      if (mac.battery) v.push(`<span class="v">${mac.battery.percent}%${mac.battery.charging ? icon('bolt') : ''}</span>`);
      v.push(`<span class="v">${bytes(mac.disk.free)} free</span>`);
      v.push(off ? `<span class="v seen">seen ${ago(mac.at)}</span>` : `<span class="v">up ${uptime(mac.uptime)}</span>`);
    } else if (off) v.push('<span class="v seen">offline</span>');
    $('mac-vals').innerHTML = v.join('');
    const more = $('readout-more');
    more.hidden = !readoutOpen || !mac;
    if (mac) {
      more.innerHTML = `<dt>Mac</dt><dd>${esc(mac.name)}</dd>
        <dt>Link</dt><dd>${esc(link.detail || link.state)}</dd>
        <dt>Battery</dt><dd>${mac.battery ? `${mac.battery.percent}%, ${mac.battery.charging ? 'charging' : 'on battery'}` : 'no battery'}</dd>
        <dt>Disk</dt><dd>${bytes(mac.disk.free)} free of ${bytes(mac.disk.total)}</dd>
        <dt>Up for</dt><dd>${uptime(mac.uptime)}</dd>
        <dt>Updated</dt><dd>${ago(mac.at)}</dd>`;
    }
    r.setAttribute('aria-expanded', String(readoutOpen && !!mac));
  }

  // The live capsule

  let tick = null, wasWorking = false;
  function drawCapsule() {
    const c = $('capsule');
    clearInterval(tick);
    tick = null;
    if (!status.working) { c.hidden = true; wasWorking = false; return; }
    const ask = cur && waitingAsk(cur);
    c.hidden = false;
    c.classList.toggle('asking', !!ask);
    if (!wasWorking) {
      c.style.setProperty('--travel', `${c.offsetWidth - 50}px`);
      c.classList.remove('enter');
      void c.offsetWidth;
      c.classList.add('enter');
    }
    wasWorking = true;
    $('cap-label').textContent = ask ? 'Needs your OK' : status.label || 'Working';
    $('cap-review').hidden = !ask;
    const since = Date.parse(cur?.at || status.since);
    const upd = () => { $('cap-time').textContent = mmss(Date.now() - since); };
    upd();
    tick = setInterval(upd, 1000);
  }

  function drawLink() {
    const show = link.state === 'offline' || link.state === 'unpaired';
    $('banner').hidden = !show;
    $('banner-text').textContent = link.detail || "Can't reach the Mac.";
    $('banner-fix').hidden = link.fix !== 'tailscale';
    $('banner-retry').hidden = link.state === 'unpaired';
  }

  // Shortcut tiles

  function drawCmds() {
    const c = $('cmds');
    c.hidden = !shortcuts.length;
    c.innerHTML = shortcuts.map((s, i) => `<button type="button" class="cmd t-${CMD_KINDS[i % CMD_KINDS.length]}" data-sc="${esc(s.id)}" title="${esc(s.text)}">${icon('return')}<span>${esc(s.label)}</span></button>`).join('')
      + (shortcuts.length ? `<button type="button" class="cmd edit" id="manage">${icon('edit')}<span>Edit</span></button>` : '');
    for (const t of items) if (t.type === 'turn' && t.you && t.you.cid === selected) draw(t);
  }

  // Bottom sheet

  let sheetKind = null;
  let draft = [];
  function openSheet(kindName, title, body, actions) {
    sheetKind = kindName;
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
      ? `<ul class="sc-list">${draft.map((s, i) => `<li><span class="tile t-${CMD_KINDS[i % CMD_KINDS.length]}">${icon('return')}</span><div class="sc-fields"><input value="${esc(s.label)}" data-label="${i}" aria-label="Name for ${esc(s.label)}" maxlength="40"><span class="sc-text">${esc(s.text)}</span></div><button type="button" class="tool" data-remove="${i}" aria-label="Remove ${esc(s.label)}">${icon('trash')}</button></li>`).join('')}</ul>`
      : `<p class="hint">No shortcuts left. Tap one of your requests and choose Save as Shortcut to add one.</p>`;
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
      if (t.you?.text?.toLowerCase().includes(needle)) out.push({ who: 'You', k: 'agent', ic: 'return', e: t.you, text: t.you.text });
      for (const f of t.you?.files || []) if (f.name.toLowerCase().includes(needle)) out.push({ who: 'You', k: 'file', ic: 'image', e: t.you, text: f.name });
      for (const o of t.out) {
        const text = o.kind === 'reply' ? o.text.replace(/\*\*|`/g, '') : `${o.name}${o.caption ? `, ${o.caption}` : ''}`;
        if (text.toLowerCase().includes(needle)) out.push({ who: 'Mac', k: o.kind === 'reply' ? 'brand' : 'phone', ic: o.kind === 'reply' ? 'agent' : 'file', e: o, text });
      }
    }
    return out.reverse();
  }
  function snippet(text, q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    let start = Math.max(0, i - 40);
    if (start) start = text.indexOf(' ', start) + 1 || start;
    const s = (start ? '…' : '') + text.slice(start);
    const j = s.toLowerCase().indexOf(q.toLowerCase());
    return esc(s.slice(0, j)) + `<mark>${esc(s.slice(j, j + q.length))}</mark>` + esc(s.slice(j + q.length));
  }
  function drawResults() {
    const q = $('search').value;
    const list = hits(q);
    $('results').innerHTML = !q.trim() ? `<p class="empty-state">Search your requests, the Mac's replies and file names.</p>`
      : !list.length ? `<p class="empty-state">Nothing matches "${esc(q)}".</p>`
      : `<p class="count">${list.length} result${list.length === 1 ? '' : 's'}</p><ol>${list.map((h) => `<li><button type="button" class="hit" data-jump="${esc(h.e.id)}">${tile(h.k, h.ic)}<span class="hit-body"><span class="hit-top"><span>${h.who}</span><span class="num">${shortDay(h.e.at)}</span></span><span class="hit-text">${snippet(h.text, q.trim())}</span></span></button></li>`).join('')}</ol>`;
  }
  function openSearch() {
    $('top-main').hidden = true;
    $('readout-more').hidden = true;
    $('search-row').hidden = false;
    $('results').hidden = false;
    drawResults();
    $('search').focus();
    backing();
  }
  function closeSearch() {
    $('top-main').hidden = false;
    $('search-row').hidden = true;
    $('results').hidden = true;
    $('search').value = '';
    drawReadout();
    backing();
  }
  function jump(id) {
    const el = thread.querySelector(`[data-eid="${CSS.escape(String(id))}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  // Requests pane, unfolded

  let currentReq = null;
  function drawSide() {
    const q = $('side-search').value.trim().toLowerCase();
    const turns = items.filter((t) => t.type === 'turn' && t.you).reverse();
    const shown = q ? turns.filter((t) => (t.you.text || '').toLowerCase().includes(q) || t.out.some((o) => (o.text || o.name || '').toLowerCase().includes(q))) : turns;
    $('side-list').innerHTML = shown.length ? shown.map((t) => {
      const ask = active(t) && waitingAsk(t);
      const st = ask ? ['ask', 'pause'] : active(t) ? ['brand', 'agent'] : t.done?.stopped ? ['agent', 'stop'] : t.done && !t.done.ok ? ['ask', 'x'] : t.done ? ['ok', 'check'] : ['agent', 'agent'];
      const meta = ask ? '<span class="sreq-meta hot">Needs your OK</span>' : active(t) ? '<span class="sreq-meta">working now</span>' : `<span class="sreq-meta">${shortDay(t.at)}${t.done ? ` · ${took(t.done.ms)}` : ''}</span>`;
      return `<li><button type="button" class="sreq${t.id === (currentReq ?? cur?.id) ? ' current' : ''}" data-req="${esc(t.id)}"><span class="tile t-${st[0]}">${icon(st[1])}</span><span class="sreq-body"><span class="sreq-text">${esc(t.you.text || 'Sent files')}</span>${meta}</span></button></li>`;
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
      (photos.length ? `<h3>Photos · ${photos.length}</h3><div class="grid">${photos.map((f) => `<button type="button" class="gtile" data-open="${esc(f.url)}" aria-label="${esc(f.name)}, from ${f.who === 'You' ? 'you' : 'the Mac'}"><img src="${esc(lab.fileUrl(f.url))}" alt="" loading="lazy"><span class="t-${f.who === 'You' ? 'brand' : 'phone'}">${f.who === 'You' ? 'You' : 'Mac'}</span></button>`).join('')}</div>` : '')
      + (files.length ? `<h3>Files · ${files.length}</h3><ul class="flist">${files.map((f) => `<li><button type="button" class="file" data-open="${esc(f.url)}">${tile(f.who === 'You' ? 'brand' : 'phone', 'file')}<span><span class="fn">${esc(f.name)}</span><br><span class="fs">${f.who === 'You' ? 'from you' : 'from the Mac'} · ${bytes(f.size || 0)} · ${shortDay(f.at)}</span></span></button></li>`).join('')}</ul>` : '');
  }
  function openFiles() { drawFiles(); $('files-view').hidden = false; backing(); }
  function closeFiles() { $('files-view').hidden = true; backing(); }

  // Ask bar

  const text = $('text');
  const fit = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 160)}px`; };
  const canSend = () => { $('send').disabled = !(text.value.trim() || pending.length) || uploading > 0; };
  function drawPending() {
    const p = $('pending');
    p.hidden = !pending.length && !uploading;
    p.innerHTML = pending.map((f, i) => `<div class="att">${isImage(f) ? `<img src="${esc(lab.fileUrl(f.url))}" alt="">` : tile('file')}<span>${esc(f.name)}</span><button type="button" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">${icon('close')}</button></div>`).join('')
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
  async function attach(k) {
    menu(false);
    uploading++;
    drawPending();
    try { pending.push(...await lab.attach(k)); }
    catch (err) { toast(err.message || "Couldn't send that to the Mac."); }
    finally { uploading--; drawPending(); }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function topLayer() {
    if (sheetKind) return closeSheet;
    if (!$('attach-menu').hidden) return () => menu(false);
    if (!$('files-view').hidden) return closeFiles;
    if (!$('search-row').hidden) return closeSearch;
    if (readoutOpen) return () => { readoutOpen = false; drawReadout(); backing(); };
    if (selected) return () => { const was = selected; selected = null; const t = findYou(was); if (t) draw(t); backing(); };
    return null;
  }
  function backing() {
    const fn = topLayer();
    lab.onBack(fn ? () => { topLayer()?.(); } : null);
  }
  function findYou(cid) {
    for (const t of items) if (t.type === 'turn' && t.you?.cid === cid) return t;
    return null;
  }

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
    if (b.classList.contains('q') && d.cid) {
      const was = selected;
      selected = selected === d.cid ? null : d.cid;
      for (const cid of [was, selected]) { const t = cid && findYou(cid); if (t) draw(t); }
      backing();
      return;
    }
    if (d.save) { const t = findYou(d.save); if (t) openNewShortcut(t.you.text); return; }
    if (d.again) { const t = findYou(d.again); if (t) send(t.you.text, t.you.files); return; }
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
      if (await saveList([...shortcuts, { id: '', label, text: body }])) { closeSheet(); const t = findYou(selected); selected = null; if (t) draw(t); toast(`Saved "${label}" as a shortcut.`); }
      return;
    }
    switch (b.id) {
      case 'open-search': return openSearch();
      case 'close-search': return closeSearch();
      case 'open-files': return openFiles();
      case 'close-files': return closeFiles();
      case 'readout': readoutOpen = !readoutOpen; drawReadout(); return backing();
      case 'cap-stop': return lab.stop();
      case 'cap-review': { const a = cur && waitingAsk(cur); if (a) jump(a.id); return; }
      case 'banner-fix': return lab.fix(link.fix);
      case 'banner-retry': return lab.retry();
      case 'attach': return menu($('attach-menu').hidden);
      case 'manage': return openManage();
    }
  });

  // Long-press a shortcut to manage them.
  let press = null, longFired = false;
  $('cmds').addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('[data-sc]')) return;
    longFired = false;
    press = setTimeout(() => { longFired = true; openManage(); }, 500);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) $('cmds').addEventListener(t, () => clearTimeout(press));
  $('cmds').addEventListener('contextmenu', (ev) => { if (ev.target.closest('[data-sc]')) ev.preventDefault(); });

  $('scrim').addEventListener('click', closeSheet);
  document.addEventListener('pointerdown', (ev) => { if (!$('attach-menu').hidden && !ev.target.closest('.attach-wrap')) menu(false); });
  $('search').addEventListener('input', drawResults);
  $('search-row').addEventListener('submit', (ev) => { ev.preventDefault(); $('search').blur(); });
  $('side-search').addEventListener('input', drawSide);
  thread.addEventListener('scroll', () => requestAnimationFrame(guide), { passive: true });
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
  setInterval(() => { if (link.state !== 'online' || readoutOpen) drawReadout(); }, 30000);

  thread.append(queue);
  lab.subscribe(take);
  booted = true;
  for (const t of items) if (t.type === 'turn' && !t.el) pendingDraw.add(t);
  for (const t of items) if (pendingDraw.has(t) || !t.el) draw(t);
  pendingDraw.clear();
  drawCmds();
  drawReadout();
  drawCapsule();
  drawLink();
  drawSide();
  drawPending();
  toBottom();
  requestAnimationFrame(() => { guide(); lab.ready(); });
})();
