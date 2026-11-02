(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  // Every shape is the same 96 point polar outline, so CSS can morph any one
  // into any other by transitioning `d`.
  const SHAPES = { circle: [0, 0], cookie: [9, 0.075], burst: [12, 0.085], clover: [4, 0.17], flower: [8, 0.11], triangle: [3, 0.12], pentagon: [5, 0.1] };
  function outline(n, a) {
    const r0 = 48 / (1 + a);
    let d = '';
    for (let k = 0; k < 96; k++) {
      const t = (k / 96) * 2 * Math.PI;
      const r = r0 * (1 + a * Math.cos(n * t));
      d += `${k ? 'L' : 'M'}${(50 + r * Math.sin(t)).toFixed(2)} ${(50 - r * Math.cos(t)).toFixed(2)}`;
    }
    return `path("${d}Z")`;
  }
  const P = Object.fromEntries(Object.entries(SHAPES).map(([k, [n, a]]) => [k, outline(n, a)]));
  const css = document.createElement('style');
  css.textContent = `:root{${Object.entries(P).map(([k, v]) => `--sh-${k}:${v}`).join(';')}}
.shape{d:${P.circle}}
${Object.keys(P).map((k) => `.s-${k}{d:${P[k]}}`).join('\n')}
@keyframes morph{0%,100%{d:${P.burst}}25%{d:${P.cookie}}50%{d:${P.pentagon}}75%{d:${P.clover}}}`;
  document.head.append(css);
  const shape = (name, id) => `<svg viewBox="0 0 100 100" aria-hidden="true"><path class="shape s-${name}"${id ? ` id="${id}"` : ''}/></svg>`;
  const loader = () => `<svg viewBox="0 0 100 100" aria-hidden="true"><path class="shape"/></svg>`;

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
  const plain = (s) => String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim();

  // Made once. Building a formatter per call was most of the first draw.
  const fmt = (o) => new Intl.DateTimeFormat([], o);
  const HM = fmt({ hour: 'numeric', minute: '2-digit' }), LONG = fmt({ weekday: 'long', month: 'long', day: 'numeric' }), SHORT = fmt({ month: 'short', day: 'numeric' });
  const clock = (iso) => HM.format(new Date(iso));
  const dayKey = (iso) => new Date(iso).toDateString();
  function dayLabel(iso) {
    const d = new Date(iso), today = new Date();
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return LONG.format(d);
  }
  const shortDay = (iso) => {
    const l = dayLabel(iso);
    return l === 'Today' ? clock(iso) : l === 'Yesterday' ? 'Yesterday' : SHORT.format(new Date(iso));
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
  // Thumbnails ask for a copy whose short side covers the drawn size in
  // device pixels, so they're sharp without decoding the original.
  const thumb = (url, css) => esc(lab.fileUrl(url, { w: Math.ceil(css * (devicePixelRatio || 1)) }));

  // One mark per state, each its own shape.
  const MARKS = { ok: ['cookie', 'check'], bad: ['clover', 'x'], wait: ['burst', 'pause'], stopped: ['circle', 'stop'], go: [null, null] };
  // Read before a request in the list. Working and asking say so in the meta line.
  const SAID = { ok: 'Done, ', bad: "Didn't finish, ", stopped: 'Stopped, ' };
  function mark(state) {
    const [s, ic] = MARKS[state];
    return `<span class="state ${state}">${s ? shape(s) : loader()}${ic ? icon(ic) : ''}</span>`;
  }

  // Screen reader lines. Polite ones in a burst are read as one.
  const said = [];
  let sayTimer = null;
  function say(msg, urgent) {
    if (urgent) { $('sr-alert').textContent = ''; setTimeout(() => { $('sr-alert').textContent = msg; }, 50); return; }
    said.push(msg);
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { $('sr').textContent = said.splice(0).join(' '); }, 150);
  }

  // Redrawing replaces elements, so the focused control is found again by
  // its data attributes and focused in the new markup.
  const keyOf = (el) => [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
  function refocus(within, change, fallback) {
    const a = document.activeElement;
    if (!a || a === document.body || !within.contains(a)) return change();
    const keys = [keyOf(a)];
    if (a.dataset.answer) keys.push(`[data-answered="${CSS.escape(a.dataset.answer)}"]`);
    const out = change();
    const scope = out instanceof Element ? out : within;
    const next = keys.filter(Boolean).map((k) => scope.matches?.(k) ? scope : scope.querySelector(k)).find(Boolean) || fallback?.();
    if (next) focusSoft(next);
    return out;
  }
  // Elements that aren't controls get tabindex only while they hold focus,
  // so TalkBack doesn't read a whole turn as one item.
  function focusSoft(el) {
    if (!el.matches('button, input, textarea, a[href], [tabindex]')) {
      el.tabIndex = -1;
      el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
    }
    el.focus({ preventScroll: true });
  }

  const items = [];
  const byRef = new Map();
  // Which turn or notice each event landed in, so search can jump to it.
  const byEid = new Map();
  let cur = null;
  let link = { state: 'connecting' };
  let status = { working: false, label: '' };
  let mac = null;
  let shortcuts = [];
  let outbox = [];
  let pending = [];
  let uploading = 0;
  let selected = null;
  let moreOpen = false;
  let booted = false;

  const thread = $('thread');
  const log = document.createElement('div');
  log.className = 'log';
  const queue = document.createElement('div');
  queue.className = 'queue';
  const older = document.createElement('button');
  older.type = 'button';
  older.className = 'pill older';
  older.id = 'older';
  older.hidden = true;
  older.textContent = 'Show Earlier Messages';

  function newTurn(you, at) {
    const t = { type: 'turn', i: items.length, id: you ? `y${you.id}` : `t${Math.random()}`, you, at, steps: [], failed: {}, asks: [], answers: {}, out: [], done: null, open: undefined, raw: new Set() };
    items.push(t);
    cur = t;
    return t;
  }

  // Only the newest turns are in the page. Older ones are drawn in as he
  // scrolls up, and dropped again once he's back at the newest message.
  const WINDOW = 40;
  const FIRST = 10;
  let shownFrom = 0;
  let windowed = false;
  let filling = true;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 16));
  // Opening the app draws the newest turns at once and the rest of the
  // window ten at a time, so no single task holds up the first frame.
  function fill() {
    const floor = floorOf(items.length, WINDOW);
    if (shownFrom > floor) reveal(Math.max(floor, floorOf(shownFrom, FIRST)));
    if (shownFrom > floor) idle(fill);
    else filling = false;
  }
  function floorOf(end, n) {
    let k = 0;
    for (let i = end - 1; i >= 0; i--) if (items[i].type === 'turn' && ++k === n) return i;
    return 0;
  }

  // Events only mark what changed. One frame then draws it all, so loading
  // two thousand events of history draws each turn and the side list once.
  const dirty = new Set();
  const want = { now: false, side: false, files: false };
  let frame = 0;
  function schedule() { if (booted && !frame) frame = requestAnimationFrame(flush); }
  function flushNow() { if (frame) { cancelAnimationFrame(frame); flush(); } }
  function flush() {
    frame = 0;
    const stick = pinned || nearBottom();
    if (!windowed && items.length) { shownFrom = floorOf(items.length, FIRST); windowed = true; idle(fill); }
    for (const item of dirty) draw(item);
    if (stick && !overlay()) trim();
    older.hidden = shownFrom === 0;
    if (want.now) drawNow();
    if (want.side) drawSide();
    if (want.files && shown($('files-view'))) drawFiles();
    want.now = want.side = want.files = false;
    if (stick) toBottom();
  }

  // History is older than this, so only live events are read out.
  const fresh = (e) => booted && Date.now() - Date.parse(e.at) < 30000;
  function announce(e, t) {
    if (e.kind === 'ask') say(`Needs your OK: ${e.title}`);
    else if (e.kind === 'reply') { const p = plain(e.text); say(`The Mac replied: ${p.length > 160 ? `${p.slice(0, 157)}...` : p}`); }
    else if (e.kind === 'file') say(`The Mac sent ${e.name}.`);
    else if (e.kind === 'failed') say(`A step failed: ${t.steps.find((s) => s.ref === e.ref)?.title || e.text}`);
    else if (e.kind === 'done') say(e.stopped ? 'Stopped.' : e.ok ? `Done after ${took(e.ms)}.` : "That one didn't finish.");
  }

  function take(e) {
    switch (e.kind) {
      case 'link': { const was = link.state; link = e; drawLink(was); drawGlance(); return; }
      case 'status': {
        const flip = status.working !== e.working;
        status = e;
        want.now = true;
        if (flip) { want.side = true; if (cur) dirty.add(cur); } else patchRun();
        schedule();
        return;
      }
      case 'mac': mac = e; drawGlance(); return;
      case 'loaded': loaded = true; want.side = want.files = true; schedule(); return;
      case 'shortcuts': shortcuts = e.items || []; drawChips(); return;
      case 'outbox': outbox = e.items || []; drawQueue(); return;
      case 'insets': fold(); return;
      case 'fold': posture(); return;
      case 'backprogress': follow(e.progress, e.edge); return;
      case 'backcancel': follow(0); return;
      case 'openFailed': toast('Nothing on this phone can open that file.', true); return;
      case 'answerFailed': toast("Couldn't reach the Mac, so that answer didn't go through. Try again once it's back.", true); return;
      case 'stopFailed': toast("Couldn't reach the Mac to stop it. Try again once it's back.", true); return;
      case 'you': { const t = newTurn(e, e.at); byEid.set(String(e.id), t); dirty.add(t); want.side = true; if (e.files?.length) want.files = true; schedule(); return; }
      case 'notice': { const n = { type: 'notice', i: items.length, id: `n${e.id}`, e, at: e.at }; items.push(n); byEid.set(String(e.id), n); dirty.add(n); schedule(); if (fresh(e)) say(e.text); return; }
    }
    // Anything else that isn't part of a turn is for some other design.
    if (!['step', 'failed', 'ask', 'answered', 'reply', 'file', 'done'].includes(e.kind)) return;
    const t = (e.kind === 'failed' || e.kind === 'answered') ? (byRef.get(e.ref) || cur) : cur || newTurn(null, e.at);
    if (!t) return;
    if (e.kind === 'step') { t.steps.push(e); byRef.set(e.ref, t); }
    else if (e.kind === 'failed') t.failed[e.ref] = e.text;
    else if (e.kind === 'ask') { t.asks.push(e); byRef.set(e.ref, t); }
    else if (e.kind === 'answered') t.answers[e.ref] = e;
    else if (e.kind === 'reply' || e.kind === 'file') t.out.push(e);
    else if (e.kind === 'done') t.done = e;
    byEid.set(String(e.id), t);
    dirty.add(t);
    if (e.kind === 'ask' || e.kind === 'answered' || e.kind === 'done') want.now = want.side = true;
    if (e.kind === 'file') want.files = true;
    if (fresh(e)) announce(e, t);
    schedule();
  }

  // The conversation

  const fromBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  const nearBottom = () => fromBottom() < 120;
  // Whether he was reading the newest message, kept so a resize can stay there.
  let pinned = true;
  const toBottom = () => { thread.scrollTop = thread.scrollHeight; pinned = true; };

  const elOf = (item) => item.type === 'turn' ? turnEl(item) : noticeEl(item.e);
  // The top of the window always gets its day, even mid-day.
  const needsDay = (i) => i === shownFrom || dayKey(items[i - 1].at) !== dayKey(items[i].at);
  function dayEl(item) {
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = dayLabel(item.at);
    item.dayEl = d;
    return d;
  }

  function draw(item) {
    dirty.delete(item);
    if (item.i < shownFrom) return;
    const el = elOf(item);
    if (item.el) { const old = item.el; refocus(old, () => { old.replaceWith(el); return el; }, () => el.querySelector('.bubble') || el); }
    else {
      if (needsDay(item.i)) log.insertBefore(dayEl(item), queue);
      log.insertBefore(el, queue);
    }
    item.el = el;
  }

  // Draws older items in above the window without moving what he's reading.
  function reveal(to) {
    flushNow();
    if (to >= shownFrom) return;
    const first = items[shownFrom];
    const top0 = first.el.getBoundingClientRect().top;
    const frag = document.createDocumentFragment();
    const from = shownFrom;
    shownFrom = to;
    for (let i = to; i < from; i++) {
      const it = items[i];
      dirty.delete(it);
      if (needsDay(i)) frag.append(dayEl(it));
      it.el = elOf(it);
      frag.append(it.el);
    }
    if (first.dayEl && dayKey(items[from - 1].at) === dayKey(first.at)) { first.dayEl.remove(); first.dayEl = null; }
    log.insertBefore(frag, first.dayEl || first.el);
    thread.scrollTop += first.el.getBoundingClientRect().top - top0;
    older.hidden = shownFrom === 0;
  }
  const more = () => { if (!older.hidden && !filling) reveal(floorOf(shownFrom, WINDOW)); };
  new IntersectionObserver((list) => { if (list.some((x) => x.isIntersecting)) more(); }, { root: thread, rootMargin: '800px 0px 0px 0px' }).observe(older);

  // Back at the newest message, the turns he scrolled up through are dropped.
  function trim() {
    const floor = floorOf(items.length, WINDOW);
    if (floor - shownFrom < WINDOW) return;
    const a = document.activeElement;
    for (let i = shownFrom; i < floor; i++) if (items[i].el?.contains(a)) return;
    for (let i = shownFrom; i < floor; i++) {
      const it = items[i];
      it.el?.remove();
      it.dayEl?.remove();
      it.el = it.dayEl = null;
    }
    shownFrom = floor;
    const top = items[floor];
    if (top.el && !top.dayEl) log.insertBefore(dayEl(top), top.el);
  }

  // A status change while working only renames the live step.
  function patchRun() {
    const b = cur?.el?.querySelector('.run.live:not(.wait) .run-head b');
    if (b) b.textContent = status.label || 'Working';
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
      ? `<button type="button" class="thumb" data-open="${esc(f.url)}" aria-label="Open ${esc(f.name)}"><img src="${thumb(f.url, 176)}" alt="" width="176" height="176" loading="lazy" decoding="async"></button>`
      : `<button type="button" class="mini-file" data-open="${esc(f.url)}">${icon('doc')}<span>${esc(f.name)}</span></button>`).join('');
    const saved = shortcuts.some((s) => s.text.trim() === (e.text || '').trim());
    const actions = !queued && selected === e.cid && e.text ? `<div class="you-actions">
        ${moreOpen ? `<span class="more"><button type="button" class="pill" data-again="${esc(e.cid)}">${icon('redo')}Send Again</button><button type="button" class="pill" data-copy="${esc(e.cid)}">${icon('copy')}Copy</button></span>` : ''}
        <span class="split"><button type="button" data-save="${esc(e.cid)}" ${saved ? 'disabled' : ''}>${icon('star')}${saved ? 'Saved as Shortcut' : 'Save as Shortcut'}</button><button type="button" data-more aria-label="More Actions" aria-expanded="${moreOpen}">${icon('chev')}</button></span>
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
    const count = `<span class="nw">${n} step${n === 1 ? '' : 's'}</span>`;
    if (live && ask) { state = 'wait'; sum = `<b>Waiting for you</b> · ${count}`; }
    else if (live) { state = 'go'; sum = `<b>${esc(status.label || 'Working')}</b>${n ? ` · ${count}` : ''}`; }
    else if (t.done?.stopped) { state = 'stopped'; sum = `<b>Stopped</b> · ${count}`; }
    else if (t.done && !t.done.ok) { state = 'bad'; sum = `<b>Didn't finish</b> · ${count}`; }
    else if (t.done) { state = 'ok'; sum = `<b>Done</b> · ${count} · ${took(t.done.ms)}`; }
    else { state = 'stopped'; sum = count; }
    const start = Date.parse(t.at);
    const steps = open ? `<ol class="steps">${t.steps.map((s, i) => {
      const bad = t.failed[s.ref];
      const isLive = live && !ask && i === n - 1 && !bad;
      const raw = t.raw.has(s.ref);
      return `<li class="step${bad ? ' bad' : ''}${isLive ? ' live' : ''}${s.sub ? ' sub' : ''}">
        <button type="button" data-raw="${esc(s.ref)}" aria-expanded="${raw}"><span class="dotk">${isLive ? loader() : shape(bad ? 'clover' : 'circle')}</span><span class="label">${bad ? '<span class="sr">Failed: </span>' : ''}${esc(s.title)}</span><span class="when">${mmss(Date.parse(s.at) - start)}</span></button>
        ${bad ? `<div class="err">${esc(bad)}</div>` : ''}
        ${raw ? `<pre class="raw">${esc(s.detail || '')}</pre><div class="raw-tools"><button type="button" class="link-btn" data-copyraw="${esc(s.ref)}">${icon('copy')}Copy</button></div>` : ''}
      </li>`;
    }).join('')}</ol>` : '';
    return `<div class="run${open ? ' open' : ''}${live ? ' live' : ''}${live && ask ? ' wait' : ''}">
      <button type="button" class="run-head" data-run="${esc(t.id)}" aria-expanded="${open}">${mark(state)}<span class="sum">${sum}</span>${n ? icon('chev') : ''}</button>
      ${steps}</div>`;
  }

  function askEl(t, a) {
    const ans = t.answers[a.ref];
    if (ans) return `<div class="answered" data-answered="${esc(a.ref)}">${mark(ans.allow ? 'ok' : 'stopped')}<span>${ans.allow ? 'Allowed' : 'Denied'}: ${esc(a.title)}</span></div>`;
    if (t.done) return `<div class="answered">${mark('stopped')}<span>Not answered: ${esc(a.title)}</span></div>`;
    return `<div class="ask" data-ask="${esc(a.ref)}" data-eid="${esc(a.id)}">
      <div class="ask-top"><span class="ask-mark">${shape('burst')}${icon('shield')}</span><h2>${esc(a.title)}</h2></div>
      ${a.detail ? `<pre>${esc(a.detail)}</pre>` : ''}
      <div class="ask-row" role="group" aria-label="Needs your OK"><button type="button" class="deny" data-answer="${esc(a.ref)}" data-allow="0">Deny</button><button type="button" class="allow" data-answer="${esc(a.ref)}" data-allow="1">Allow</button></div>
    </div>`;
  }

  const fileIcon = (name = 'flower') => `<span class="fi">${shape(name)}${icon('doc')}</span>`;
  function outEl(e) {
    if (e.kind === 'reply') return `<div class="reply" data-eid="${esc(e.id)}">${md(e.text)}</div>`;
    if (isImage(e)) return `<button type="button" class="photo" data-open="${esc(e.url)}" data-eid="${esc(e.id)}"><img src="${thumb(e.url, 300)}" alt="" loading="lazy" decoding="async"><span>${esc(e.caption || e.name)}</span></button>`;
    return `<button type="button" class="file" data-open="${esc(e.url)}" data-eid="${esc(e.id)}">${fileIcon()}<span><span class="fn">${esc(e.name)}</span><br><span class="fs">${esc(e.caption ? `${e.caption} · ` : '')}${bytes(e.size || 0)}</span></span></button>`;
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

  // The header block. Built once so the shapes can morph between states.

  const glance = $('glance');
  glance.innerHTML = `<span class="stat batt" id="g-batt">${shape('burst', 'g-batt-shape')}<span class="stat-in"><span class="big" id="g-batt-big"></span><span class="small" id="g-batt-small"></span></span></span>
    <span class="stat disk" id="g-disk"><span class="stat-in"><span class="big" id="g-disk-big"></span><span class="small" id="g-disk-small"></span><span class="bar"><i id="g-disk-bar"></i></span></span></span>
    <span class="stat link" id="g-link">${shape('cookie', 'g-link-shape')}<span class="stat-in"><span class="small" id="g-link-a"></span><span class="sub" id="g-link-b"></span></span></span>`;
  const setShape = (id, name) => { $(id).setAttribute('class', `shape s-${name}`); };

  let glanceOpen = false;
  function drawGlance() {
    const off = link.state !== 'online';
    glance.classList.toggle('off', off);
    const [a, b, s] = link.state === 'unpaired' ? ['Not paired', '', 'clover']
      : link.state === 'connecting' ? ['Connecting', '', 'flower']
      : off ? ['Offline', mac ? ago(mac.at) : '', 'clover']
      : ['Online', mac ? `up ${uptime(mac.uptime).split(',')[0]}` : '', 'cookie'];
    $('g-link-a').textContent = a;
    $('g-link-b').textContent = b;
    setShape('g-link-shape', s);
    $('g-batt').hidden = !mac;
    $('g-disk').hidden = !mac;
    const spoken = [];
    if (mac) {
      const bt = mac.battery;
      $('g-batt').classList.toggle('low', !!bt && bt.percent <= 20);
      $('g-batt').classList.toggle('no-batt', !bt);
      $('g-batt-big').innerHTML = bt ? `${bt.percent}%${bt.charging ? icon('bolt') : ''}` : icon('bolt');
      $('g-batt-small').textContent = !bt ? 'Plugged in' : bt.charging ? 'Charging' : 'Battery';
      setShape('g-batt-shape', bt && !bt.charging ? 'flower' : 'burst');
      $('g-disk-big').textContent = `${bytes(mac.disk.free)} free`;
      $('g-disk-small').textContent = `of ${bytes(mac.disk.total)}`;
      $('g-disk-bar').style.width = `${Math.round((1 - mac.disk.free / mac.disk.total) * 100)}%`;
      spoken.push(bt ? `Battery ${bt.percent}%, ${bt.charging ? 'charging' : 'on battery'}` : 'Plugged in, no battery', `${bytes(mac.disk.free)} free of ${bytes(mac.disk.total)}`);
    }
    spoken.push(b ? `${a}, ${b}` : a);
    const more = $('glance-more');
    more.hidden = !glanceOpen || !mac;
    if (mac) {
      more.innerHTML = `<span>Mac</span><b>${esc(mac.name)}</b>
        <span>Battery</span><b>${mac.battery ? `${mac.battery.percent}%, ${mac.battery.charging ? 'charging' : 'on battery'}` : 'Plugged in, no battery'}</b>
        <span>Disk</span><b>${bytes(mac.disk.free)} free of ${bytes(mac.disk.total)}</b>
        <span>Up for</span><b>${uptime(mac.uptime)}</b>
        <span>Updated</span><b>${ago(mac.at)}</b>`;
    }
    glance.setAttribute('aria-expanded', String(glanceOpen && !!mac));
    glance.setAttribute('aria-label', `${spoken.join('. ')}.${mac ? ` ${glanceOpen ? 'Hide' : 'Show'} details.` : ''}`);
  }
  function toggleGlance(open) { glanceOpen = open; drawGlance(); backing(); }

  // The header gives its height to the conversation while reading history,
  // while search or files are open, with large text, and whenever the screen
  // is short. Short screens also dock the toolbar (the `tight` class).
  const head = $('head');
  const app = $('app');
  // A view that's animating closed is drawn but counts as closed.
  const shown = (el) => !el.hidden && !el.leaving;
  const overlay = () => shown($('files-view')) || !$('search-row').hidden;
  // The probe is "Message your Mac" set at 16 px, which is 133 px wide in
  // Roboto Flex. Drawn wider than that, the phone's font size is turned up.
  let bigText = false;
  function measure() {
    bigText = $('probe').getBoundingClientRect().width > 133 * 1.15 || parseFloat(getComputedStyle($('probe')).fontSize) > 18;
    root.classList.toggle('big-text', bigText);
  }
  function fold() {
    const tight = innerHeight < 560 || root.hasAttribute('data-keyboard');
    app.classList.toggle('tight', tight);
    const d = fromBottom();
    if (tight || bigText || overlay() || d > 300) head.classList.add('compact');
    else if (d < 60) head.classList.remove('compact');
  }
  let threadH = 0;
  // Set once the shell says the whole history is in, so an empty list
  // isn't claimed while it's still on its way.
  let loaded = false;
  thread.addEventListener('scroll', () => {
    if (thread.clientHeight === threadH) pinned = nearBottom();
    threadH = thread.clientHeight;
    fold();
    if (pinned && !frame && !filling && !overlay()) trim();
  }, { passive: true });
  new MutationObserver(() => { posture(); fold(); }).observe(root, { attributes: true, attributeFilter: ['data-keyboard', 'data-fold'] });
  // This waits a frame, so the padding it changes can't feed back into the
  // sizes observed in the same frame.
  new ResizeObserver(() => requestAnimationFrame(() => { app.style.setProperty('--now-h', `${$('now').offsetHeight || 72}px`); if (pinned) toBottom(); })).observe($('now'));
  // Late growth keeps him at the newest message: a photo that only has a size
  // once it loads, or turns that skip layout until they're on screen.
  const stay = new ResizeObserver(() => { if (pinned) toBottom(); });
  stay.observe(thread);
  stay.observe(log);

  // Half open, nothing sits on the hinge. The shell sets data-fold, and
  // viewport segments are the fallback where the WebView reports them.
  const segs = [matchMedia('(horizontal-viewport-segments: 2)'), matchMedia('(vertical-viewport-segments: 2)')];
  function posture() {
    root.classList.toggle('book', root.dataset.fold === 'book' || segs[0].matches);
    root.classList.toggle('table', root.dataset.fold === 'tabletop' || segs[1].matches);
  }
  for (const m of segs) m.addEventListener('change', posture);
  posture();

  let tick = null;
  // While it works the toolbar mark springs to the next shape every other
  // second. Each change is a transition on `d`, so it only lays out while
  // it moves, where a looping morph lays out every frame.
  const CYCLE = ['burst', 'cookie', 'pentagon', 'clover'];
  let beat = 0;
  function drawNow() {
    const bar = $('now');
    if (!status.working && bar.contains(document.activeElement)) focusSoft(text);
    bar.hidden = !status.working;
    thread.classList.toggle('under-now', status.working);
    clearInterval(tick);
    tick = null;
    if (!status.working) { drawGlance(); return; }
    const ask = cur && waitingAsk(cur);
    bar.classList.toggle('asking', !!ask);
    $('now-label').textContent = ask ? 'Needs your OK' : status.label || 'Working';
    $('now-jump').hidden = !ask;
    const since = Date.parse(cur?.at || status.since);
    const upd = () => {
      $('now-time').textContent = ask ? `Asked ${mmss(Date.now() - since)} ago` : `Working for ${mmss(Date.now() - since)}`;
      if (!ask && beat++ % 2 === 0) $('now-mark').querySelector('.shape').setAttribute('class', `shape s-${CYCLE[(beat >> 1) % 4]}`);
    };
    upd();
    tick = setInterval(upd, 1000);
    drawGlance();
  }

  function drawLink(was) {
    const show = link.state === 'offline' || link.state === 'unpaired';
    const stick = nearBottom();
    $('banner').hidden = !show;
    $('banner-text').textContent = link.detail || "Can't reach the Mac.";
    $('banner-fix').hidden = link.fix !== 'tailscale';
    $('banner-retry').hidden = link.state === 'unpaired';
    if (stick && booted) toBottom();
    if (booted && was !== link.state) {
      if (show) say(link.detail || "Can't reach the Mac.");
      else if (link.state === 'online' && (was === 'offline' || was === 'unpaired')) say('Connected to the Mac again.');
    }
  }

  // Shortcuts

  function drawChips() {
    const c = $('chips');
    c.hidden = !shortcuts.length;
    refocus(c, () => {
      c.innerHTML = shortcuts.map((s) => `<button type="button" class="chip" data-sc="${esc(s.id)}" title="${esc(s.text)}">${esc(s.label)}</button>`).join('')
        + (shortcuts.length ? `<button type="button" class="chip edit" id="manage">${icon('edit')}Edit</button>` : '');
    }, () => text);
    for (const t of items) if (t.type === 'turn' && t.you && t.you.cid === selected) draw(t);
  }

  // Bottom sheet

  let sheetKind = null;
  let sheetFrom = null;
  let draft = [];
  const focused = () => (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  const restore = (el, fallback) => { (el?.isConnected && !el.closest('[inert]') ? el : fallback)?.focus({ preventScroll: true }); };
  function openSheet(kind, title, body, actions) {
    const again = !!sheetKind;
    if (!again) sheetFrom = focused();
    sheetKind = kind;
    $('sheet-title').textContent = title;
    $('sheet-body').innerHTML = body;
    $('sheet-actions').innerHTML = actions;
    arrive(sheet);
    arrive($('scrim'));
    backing();
    if (!again) ($('sheet-body').querySelector('input, textarea') || $('sheet-title')).focus();
  }
  function closeSheet() {
    sheetKind = null;
    leave(sheet, 'translateY(100%)');
    leave($('scrim'), '', true);
    backing();
    restore(sheetFrom, text);
  }
  function openManage() {
    if (sheetKind !== 'manage') draft = shortcuts.map((s) => ({ ...s }));
    const list = draft.length
      ? `<ul class="sc-list">${draft.map((s, i) => `<li><div class="sc-fields"><input value="${esc(s.label)}" data-label="${i}" aria-label="Name for ${esc(s.text)}" maxlength="40"><span class="sc-text">${esc(s.text)}</span></div><button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(s.label)}">${icon('trash')}</button></li>`).join('')}</ul>`
      : `<p class="hint">No shortcuts left. Tap one of your messages and choose Save as Shortcut to add one.</p>`;
    openSheet('manage', 'Shortcuts', list, `<button type="button" data-close>Cancel</button><button type="button" class="primary" data-savelist>Save</button>`);
  }
  function openNewShortcut(text) {
    const label = text.split(/\s+/).slice(0, 4).join(' ').replace(/[.,?!]+$/, '').slice(0, 28);
    openSheet('new', 'New Shortcut', `<label for="sc-label">Name</label><input id="sc-label" value="${esc(label)}" maxlength="40"><label for="sc-text">Sends</label><textarea id="sc-text" rows="3" maxlength="2000">${esc(text)}</textarea>`,
      `<button type="button" data-close>Cancel</button><button type="button" class="primary" data-savenew>Save</button>`);
  }
  async function saveList(list) {
    const ok = await lab.saveShortcuts(list);
    if (!ok) { toast("Couldn't save the shortcuts because the Mac can't be reached. Try again once it's back.", true); return false; }
    return true;
  }
  $('sheet-body').addEventListener('input', (ev) => {
    const i = ev.target.dataset?.label;
    if (i !== undefined && draft[i]) draft[i].label = ev.target.value;
  });

  // Drag the sheet down by its handle or title to close it.
  const sheet = $('sheet');
  let drag = null, dragged = false;
  sheet.addEventListener('pointerdown', (ev) => {
    if (!ev.target.closest('.handle, #sheet-title')) return;
    drag = { y: ev.clientY, t: ev.timeStamp, dy: 0 };
    dragged = false;
    ev.target.setPointerCapture(ev.pointerId);
    sheet.style.transition = 'none';
  });
  sheet.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    drag.dy = Math.max(0, ev.clientY - drag.y);
    if (drag.dy > 6) dragged = true;
    sheet.style.transform = `translateY(${drag.dy}px)`;
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const { dy, t } = drag;
    drag = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > sheet.offsetHeight * 0.3 || (dy > 24 && dy / Math.max(1, ev.timeStamp - t) > 0.6)) closeSheet();
  };
  sheet.addEventListener('pointerup', endDrag);
  sheet.addEventListener('pointercancel', endDrag);

  // Closing plays a short exit before hiding. Opening again cancels it.
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  function settle(el) {
    el.leaving = null;
    el.style.transition = el.style.transform = el.style.opacity = el.style.pointerEvents = '';
  }
  function arrive(el) { settle(el); el.hidden = false; }
  function leave(el, transform, fade) {
    if (el.hidden || el.leaving) return;
    if (still.matches) { el.hidden = true; settle(el); return; }
    const me = el.leaving = {};
    el.style.pointerEvents = 'none';
    el.style.transition = 'transform 0.2s var(--ease), opacity 0.2s var(--ease)';
    if (transform) el.style.transform = transform;
    if (fade) el.style.opacity = '0';
    setTimeout(() => { if (el.leaving === me) { el.hidden = true; settle(el); } }, 200);
  }
  let backEdge = 'left';
  const slide = () => `translateX(${backEdge === 'right' ? -48 : 48}px)`;

  // Predictive back: the top surface follows the gesture, and snaps back if
  // he lets go without going back.
  function surface() {
    if (sheetKind) return sheet;
    if (shown($('files-view'))) return $('files-view');
    if (!$('search-row').hidden) return $('results');
    return null;
  }
  function follow(p, edge) {
    const el = surface();
    if (!el) return;
    if (edge) backEdge = edge;
    el.style.transition = p ? 'none' : '';
    el.style.transform = !p ? '' : el === sheet
      ? `translateY(${Math.round(p * 64)}px) scale(${1 - p * 0.05})`
      : `translateX(${(edge === 'right' ? -1 : 1) * Math.round(p * 32)}px) scale(${1 - p * 0.08})`;
  }

  // Search

  // Searches the data rather than the page, so it finds turns that aren't drawn.
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
    let start = Math.max(0, i - 40);
    if (start) { const sp = text.indexOf(' ', start); if (sp > -1 && sp < i) start = sp + 1; }
    const s = (start ? '…' : '') + text.slice(start);
    const j = s.toLowerCase().indexOf(q.toLowerCase());
    return esc(s.slice(0, j)) + `<mark>${esc(s.slice(j, j + q.length))}</mark>` + esc(s.slice(j + q.length));
  }
  const MAX_HITS = 100;
  let countTimer = null, typeTimer = null;
  function drawResults() {
    clearTimeout(typeTimer);
    const q = $('search').value;
    const list = hits(q);
    const none = `Nothing matches "${q.trim()}".`;
    const count = list.length > MAX_HITS ? `The newest ${MAX_HITS} of ${list.length} results` : `${list.length} result${list.length === 1 ? '' : 's'}`;
    $('results').innerHTML = !q.trim() ? `<p class="empty-state">Search your requests, the Mac's replies and file names.</p>`
      : !list.length ? `<p class="empty-state">${esc(none)}</p>`
      : `<p class="count">${count}</p><ol>${list.slice(0, MAX_HITS).map((h) => `<li><button type="button" class="hit" data-jump="${esc(h.e.id)}"><span class="hit-top"><b>${h.who}</b><span>${shortDay(h.e.at)}</span></span><span class="hit-text">${snippet(h.text, q.trim())}</span></button></li>`).join('')}</ol>`;
    clearTimeout(countTimer);
    if (q.trim()) countTimer = setTimeout(() => say(list.length ? count : none), 700);
  }
  let searchFrom = null;
  function openSearch() {
    searchFrom = focused();
    $('head-main').hidden = true;
    $('search-row').hidden = false;
    arrive($('results'));
    drawResults();
    backing();
    $('search').focus();
  }
  function closeSearch() {
    $('head-main').hidden = false;
    $('search-row').hidden = true;
    leave($('results'), slide(), true);
    $('search').value = '';
    document.querySelector('[data-clear="search"]').hidden = true;
    clearTimeout(countTimer);
    clearTimeout(typeTimer);
    backing();
    restore(searchFrom, $('open-search'));
  }
  function jump(id) {
    const item = byEid.get(String(id));
    if (item && item.i < shownFrom) reveal(item.i);
    flushNow();
    const el = thread.querySelector(`[data-eid="${CSS.escape(String(id))}"]`);
    if (!el) return;
    pinned = false;
    el.scrollIntoView({ block: 'center' });
    const target = el.querySelector('.bubble') || el;
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
    focusSoft(el.matches('.ask') ? el.querySelector('.allow') : target);
  }

  // Requests pane, unfolded

  let currentReq = null;
  let sideLimit = 60;
  const sideIO = new IntersectionObserver((list) => { if (list.some((x) => x.isIntersecting)) { sideLimit += 60; drawSide(); } }, { root: $('side-list'), rootMargin: '0px 0px 400px 0px' });
  function drawSide() {
    if (!booted) return;
    const list = $('side-list');
    const q = $('side-search').value.trim().toLowerCase();
    const turns = items.filter((t) => t.type === 'turn' && t.you).reverse();
    const all = q ? turns.filter((t) => (t.you.text || '').toLowerCase().includes(q) || t.out.some((o) => (o.text || o.name || '').toLowerCase().includes(q))) : turns;
    const rows = all.slice(0, sideLimit);
    refocus(list, () => {
      list.innerHTML = rows.length ? rows.map((t) => {
        const ask = active(t) && waitingAsk(t);
        const state = ask ? 'wait' : active(t) ? 'go' : t.done?.stopped ? 'stopped' : t.done && !t.done.ok ? 'bad' : t.done ? 'ok' : 'stopped';
        const meta = ask ? 'Asking you now' : active(t) ? 'Working now' : shortDay(t.at);
        const label = t.you.text || (t.you.files || []).map((f) => f.name).join(', ');
        const here = t.id === (currentReq ?? cur?.id);
        return `<li><button type="button" class="req${here ? ' current' : ''}" data-req="${esc(t.id)}"${here ? ' aria-current="true"' : ''}>${mark(state)}<span class="req-body"><span class="req-text">${SAID[state] ? `<span class="sr">${SAID[state]}</span>` : ''}${esc(label)}</span><span class="req-meta">${meta}</span></span></button></li>`;
      }).join('') + (all.length > rows.length ? `<li class="side-more"><button type="button" class="pill" data-sidemore>Show Older Requests</button></li>` : '')
        : loaded || q ? `<li class="side-empty">${q ? `Nothing matches "${esc(q)}".` : 'Your requests show up here.'}</li>` : '';
    }, () => $('side-search'));
    sideIO.disconnect();
    const m = list.querySelector('[data-sidemore]');
    if (m) sideIO.observe(m);
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
    const body = $('files-body');
    refocus(body, () => {
      body.innerHTML = !all.length && !loaded ? '' : !all.length ? `<p class="empty-state">Nothing yet. Photos and files you send to the Mac, and ones it sends you, show up here.</p>` :
        (photos.length ? `<h3>Photos</h3><div class="grid">${photos.map((f) => `<button type="button" class="tile" data-open="${esc(f.url)}" aria-label="${esc(f.name)}, from ${f.who === 'You' ? 'you' : 'the Mac'}"><img src="${thumb(f.url, 180)}" alt="" loading="lazy" decoding="async"><span aria-hidden="true">${f.who}</span></button>`).join('')}</div>` : '')
        + (files.length ? `<h3>Files</h3><ul class="flist">${files.map((f, i) => `<li><button type="button" class="file" data-open="${esc(f.url)}">${fileIcon(['flower', 'cookie', 'pentagon', 'clover'][i % 4])}<span><span class="fn">${esc(f.name)}</span><br><span class="fs"><span class="who-tag">${f.who === 'You' ? 'From you' : 'From the Mac'}</span> · ${bytes(f.size || 0)} · ${shortDay(f.at)}</span></span></button></li>`).join('')}</ul>` : '');
    }, () => $('close-files'));
  }
  let filesFrom = null;
  function openFiles() { filesFrom = focused(); drawFiles(); arrive($('files-view')); backing(); $('close-files').focus(); }
  function closeFiles() { if (!shown($('files-view'))) return; leave($('files-view'), slide(), true); backing(); restore(filesFrom, $('open-files')); }

  // Composer

  const text = $('text');
  const fit = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight}px`; };
  const canSend = () => { $('send').disabled = !(text.value.trim() || pending.length) || uploading > 0; };
  function drawPending() {
    const p = $('pending');
    p.hidden = !pending.length && !uploading;
    refocus(p, () => {
      p.innerHTML = pending.map((f, i) => `<div class="att">${isImage(f) ? `<img src="${thumb(f.url, 48)}" alt="" width="48" height="48" decoding="async">` : `<span class="fi">${icon('doc')}</span>`}<span>${esc(f.name)}</span><button type="button" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">${icon('close')}</button></div>`).join('')
        + (uploading ? `<div class="att loading"><span class="loader">${loader()}</span>Sending to the Mac</div>` : '');
    }, () => p.querySelector('[data-unattach]') || text);
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
    if (open) $('attach-menu').querySelector('button').focus();
  }
  async function attach(kind) {
    menu(false);
    $('attach').focus();
    uploading++;
    drawPending();
    let failed = null;
    try {
      const got = await lab.attach(kind);
      pending.push(...got);
      if (got.length) say(`Attached ${got.map((f) => f.name).join(', ')}.`);
    } catch (err) {
      failed = err.message || "Couldn't send that to the Mac.";
    }
    uploading--;
    drawPending();
    // After the sending row is gone, so the snackbar sits on the composer.
    if (failed) toast(failed, true);
  }

  // The snackbar sits just above the toolbar, or the composer when nothing
  // is running. Its words reach screen readers through the status lines.
  // Its offset is kept on top of the bottom inset, so it rides up with the
  // keyboard while that slides. Tabletop puts it just above the hinge.
  let toastTimer = null;
  const px = (name) => parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
  function toast(msg, failed) {
    const t = $('toast');
    const kb = root.hasAttribute('data-keyboard');
    if (root.classList.contains('table') && !kb) t.style.bottom = `${Math.round(innerHeight - px('--hinge-t') + 8)}px`;
    else {
      // A sheet in the top half leaves only the strip above the keyboard.
      const over = sheetKind ? (root.classList.contains('table') ? null : $('sheet')) : !$('now').hidden ? $('now') : $('composer');
      t.style.bottom = over ? `calc(var(--lab-inset-bottom, 0px) + ${Math.round(innerHeight - px('--lab-inset-bottom') - over.getBoundingClientRect().top + 8)}px)` : 'calc(var(--lab-inset-bottom, 0px) + 8px)';
    }
    t.textContent = msg;
    t.hidden = false;
    say(msg, failed);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, failed ? 7000 : 4500);
  }

  function deselect() {
    const was = selected;
    selected = null;
    moreOpen = false;
    const t = was && findYou(was);
    if (t) draw(t);
    backing();
  }

  // Back and Escape close whatever is on top.
  function top() {
    if (sheetKind) return closeSheet;
    if (!$('attach-menu').hidden) return () => { menu(false); $('attach').focus(); };
    if (shown($('files-view'))) return closeFiles;
    if (!$('search-row').hidden) return closeSearch;
    if (glanceOpen) return () => toggleGlance(false);
    if (selected) return deselect;
    return null;
  }
  function backing() {
    app.inert = !!sheetKind;
    thread.inert = overlay();
    for (const el of [sheet, $('files-view'), $('results')]) if (el.hidden) settle(el);
    fold();
    const fn = top();
    lab.onBack(fn ? () => { top()?.(); } : null);
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const fn = top();
    if (fn) { ev.preventDefault(); fn(); }
  });

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
      moreOpen = false;
      for (const cid of [was, selected]) { const t = cid && findYou(cid); if (t) draw(t); }
      backing();
      return;
    }
    if (d.more !== undefined) { moreOpen = !moreOpen; const t = findYou(selected); if (t) draw(t); return; }
    if (d.save) { const t = findYou(d.save); if (t) openNewShortcut(t.you.text); return; }
    if (d.again) { const t = findYou(d.again); if (t) { deselect(); send(t.you.text); text.focus(); } return; }
    if (d.copy) { const t = findYou(d.copy); if (t) { navigator.clipboard?.writeText(t.you.text).catch(() => {}); deselect(); t.el?.querySelector('.bubble')?.focus({ preventScroll: true }); toast('Copied.'); } return; }
    if (d.jump) { closeSearch(); jump(d.jump); return; }
    if (d.req) { currentReq = d.req; const t = items.find((x) => x.id === d.req); if (t) { closeFiles(); jump(t.you.id); } drawSide(); return; }
    if (d.sidemore !== undefined) { sideLimit += 60; drawSide(); return; }
    if (d.attach) return attach(d.attach);
    if (d.unattach) { pending.splice(Number(d.unattach), 1); drawPending(); return; }
    if (d.remove) {
      const i = Number(d.remove);
      draft.splice(i, 1);
      openManage();
      (sheet.querySelector(`[data-remove="${Math.min(i, draft.length - 1)}"]`) || $('sheet-title')).focus();
      return;
    }
    if (d.close !== undefined) return closeSheet();
    if (d.savelist !== undefined) {
      for (const s of draft) s.label = s.label.trim() || shortcuts.find((x) => x.id === s.id)?.label || 'Shortcut';
      if (await saveList(draft)) closeSheet();
      return;
    }
    if (d.savenew !== undefined) {
      const label = $('sc-label').value.trim(), body = $('sc-text').value.trim();
      if (!label || !body) {
        const empty = $(label ? 'sc-text' : 'sc-label');
        empty.setAttribute('aria-invalid', 'true');
        empty.addEventListener('input', () => empty.removeAttribute('aria-invalid'), { once: true });
        empty.focus();
        return toast('A shortcut needs a name and a message.', true);
      }
      if (await saveList([...shortcuts, { id: '', label, text: body }])) { closeSheet(); deselect(); toast(`Saved "${label}" as a shortcut.`); }
      return;
    }
    switch (b.id) {
      case 'open-search': return openSearch();
      case 'close-search': return closeSearch();
      case 'open-files': return openFiles();
      case 'close-files': return closeFiles();
      case 'glance': return toggleGlance(!glanceOpen);
      case 'now-stop': return lab.stop();
      case 'now-jump': { const a = cur && waitingAsk(cur); if (a) jump(a.id); return; }
      case 'banner-fix': return lab.fix(link.fix);
      case 'banner-retry': return lab.retry();
      case 'attach': return menu($('attach-menu').hidden);
      case 'manage': return openManage();
      case 'older': return more();
      case 'handle': if (!dragged) closeSheet(); dragged = false; return;
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
  $('search').addEventListener('input', () => { clearTimeout(typeTimer); typeTimer = setTimeout(drawResults, 120); });
  $('search-row').addEventListener('submit', (ev) => { ev.preventDefault(); $('search').blur(); });
  $('side-search').addEventListener('input', () => { sideLimit = 60; drawSide(); });
  for (const b of document.querySelectorAll('[data-clear]')) {
    const field = $(b.dataset.clear);
    field.addEventListener('input', () => { b.hidden = !field.value; });
    b.addEventListener('click', () => {
      field.value = '';
      b.hidden = true;
      field.dispatchEvent(new Event('input'));
      field.focus();
    });
  }
  // Back from the conversation closes the screen, so an unsent message is
  // kept on the phone and put back next time.
  const keep = (v) => { try { v ? localStorage.setItem('lab-draft', v) : localStorage.removeItem('lab-draft'); } catch {} };
  text.addEventListener('input', () => { fit(); canSend(); keep(text.value); });
  if (lab.platform === 'android') text.enterKeyHint = 'enter';
  text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && lab.platform !== 'android') { ev.preventDefault(); $('form').requestSubmit(); }
  });
  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if ($('send').disabled) return;
    send(text.value.trim(), pending);
    text.value = '';
    keep('');
    pending = [];
    fit();
    drawPending();
    toBottom();
  });
  addEventListener('resize', () => { measure(); fold(); fit(); if (pinned) toBottom(); });
  // Ages in the glance go stale while the Mac is away.
  setInterval(() => { if (link.state !== 'online' || glanceOpen) drawGlance(); }, 30000);

  document.fonts?.ready.then(() => { measure(); fold(); });

  try { text.value = localStorage.getItem('lab-draft') || ''; } catch {}
  thread.append(log);
  log.append(older, queue);
  lab.subscribe(take);
  booted = true;
  threadH = thread.clientHeight;
  measure();
  flush();
  drawChips();
  drawGlance();
  drawNow();
  drawLink(link.state);
  drawSide();
  drawPending();
  fit();
  toBottom();
  requestAnimationFrame(() => lab.ready());
})();
