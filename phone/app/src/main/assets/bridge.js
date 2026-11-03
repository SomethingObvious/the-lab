// window.lab, injected by the Android shell before any page script runs.
// The design talks to the computer only through this, so a design can't break the
// connection, the outbox or notifications.
(() => {
  if (window.lab || typeof labNative === 'undefined') return;
  const listeners = new Set();
  const backlog = [];
  let backFn = null;
  const root = document.documentElement;

  const deliver = (e) => {
    if (e.kind === 'insets') {
      for (const side of ['top', 'right', 'bottom', 'left']) root.style.setProperty(`--lab-inset-${side}`, `${e[side] || 0}px`);
      root.toggleAttribute('data-keyboard', !!e.keyboard);
    }
    if (e.kind === 'fold') {
      if (e.posture) root.dataset.fold = e.posture;
      else delete root.dataset.fold;
      for (const side of ['left', 'top', 'right', 'bottom']) {
        if (e.hinge) root.style.setProperty(`--lab-hinge-${side}`, `${e.hinge[side]}px`);
        else root.style.removeProperty(`--lab-hinge-${side}`);
      }
    }
    if (e.kind === 'back') { if (backFn) backFn(); return; }
    retheme();
    // A gesture in progress goes to live listeners only, never the replay.
    if (e.kind === 'backprogress' || e.kind === 'backcancel') {
      if (backFn) for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } }
      return;
    }
    backlog.push(e);
    if (backlog.length > 4000) backlog.splice(0, backlog.length - 3000);
    for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } }
  };

  const waiting = new Map();
  let nextId = 1;
  labNative.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.reply) {
      const p = waiting.get(data.reply);
      waiting.delete(data.reply);
      if (p) data.error ? p.fail(new Error(data.error)) : p.done(data.value);
    } else if (data.batch) data.batch.forEach(deliver);
    else deliver(data);
  };
  const call = (op, args) => labNative.postMessage(JSON.stringify({ op, ...args }));
  const ask = (op, args) => new Promise((done, fail) => {
    const id = String(nextId++);
    waiting.set(id, { done, fail });
    call(op, { ...args, id });
  });

  const rgb = (css) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(css || '');
    return m && (m[4] === undefined || Number(m[4]) > 0.3) ? m.slice(1, 4).map(Number) : null;
  };
  const isDark = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b < 140;
  // The first painted background at a point, so the status bar and the
  // gesture bar each get icons that read on whatever is under them.
  const under = (y) => {
    for (let el = document.elementFromPoint(innerWidth / 2, y); el; el = el.parentElement) {
      const s = getComputedStyle(el);
      const c = rgb(s.backgroundColor);
      if (c) return { c, el, s };
    }
    return null;
  };
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  function themeOf() {
    const c = rgb(getComputedStyle(document.body || root).backgroundColor) || rgb(getComputedStyle(root).backgroundColor) || [0, 0, 0];
    const top = under(1);
    const bottom = under(innerHeight - 2);
    // The shell paints the next cold start from this, header band and all.
    const head = top && top.el !== document.body && top.el !== root ? top : null;
    return {
      bg: hex(c), dark: isDark(c),
      topDark: isDark(top ? top.c : c), bottomDark: isDark(bottom ? bottom.c : c),
      ...(head ? { head: hex(head.c), headHeight: Math.round(head.el.getBoundingClientRect().bottom), headRadius: parseFloat(head.s.borderBottomLeftRadius) || 0 } : {}),
    };
  }
  let isReady = false;
  let lastTheme = '';
  let themeTimer = 0;
  function retheme(delay = 120) {
    if (!isReady) return;
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => {
      const t = themeOf();
      const key = JSON.stringify(t);
      if (key !== lastTheme) { lastTheme = key; call('theme', t); }
    }, delay);
  }
  // Whatever the design throws goes to the computer for the agent to fix, even
  // when its own script never got as far as running.
  const reported = new Set();
  const report = (message, where) => {
    message = String(message || '').slice(0, 500);
    if (!message || reported.has(message) || reported.size >= 20) return;
    reported.add(message);
    call('pageError', { message, where: String(where || 'the page').slice(0, 80) });
  };
  addEventListener('error', (e) => report(e.error?.message || e.message, e.filename ? `${e.filename.split('/').pop()} line ${e.lineno}` : 'the page'));
  addEventListener('unhandledrejection', (e) => report(e.reason?.message || e.reason, 'a promise'));
  addEventListener('scroll', () => retheme(), { capture: true, passive: true });
  addEventListener('transitionend', () => retheme(30), true);
  addEventListener('animationend', () => retheme(30), true);
  addEventListener('click', () => retheme(450), true);

  window.lab = {
    platform: 'android',
    // fn gets every event in order: the history first, then live ones.
    subscribe(fn) {
      listeners.add(fn);
      for (const e of backlog) { try { fn(e); } catch (err) { console.error(err); } }
      return () => listeners.delete(fn);
    },
    send(text, files) {
      const cid = crypto.randomUUID();
      call('send', { text, cid, ...(files?.length ? { files } : {}) });
      return cid;
    },
    attach: (kind) => ask('attach', { kind }),
    saveShortcuts: (items) => ask('saveShortcuts', { items }),
    stop: () => call('stop'),
    answer: (ref, allow, always) => call('answer', { ref, allow: !!allow, always: !!always }),
    // Memory, schedules and always-allowed commands on the computer. Resolves with
    // the JSON the computer sent, or rejects with its error in plain words.
    call: (method, path, body) => ask('call', { method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((t) => JSON.parse(t)),
    // The computer's setup check with this phone's own checks added.
    check: () => ask('check', {}).then((t) => JSON.parse(t)),
    undoDesign: () => call('undo'),
    open: (url) => call('open', { url }),
    // { w } asks for a copy whose short side is at least w pixels.
    fileUrl: (url, opts) => {
      const w = Math.round(opts?.w || 0);
      return w > 0 && url.startsWith('/files/') ? `/files/w${Math.min(Math.max(w, 48), 2048)}/${url.slice(7)}` : url;
    },
    fix: (fix) => call('fix', { fix }),
    retry: () => call('retry'),
    safeMode: (reason) => call('rescue', { reason }),
    // For an error the page caught itself, so one broken part can be skipped
    // and still get fixed.
    reportError: (message, where) => report(message, where),
    leaveSafeMode: () => call('leaveRescue'),
    // Back goes to fn while one is set, and closes the app otherwise.
    onBack(fn) { backFn = fn || null; call('back', { on: !!fn }); },
    // The page calls this once it has drawn. Without it the shell assumes the
    // design is broken and opens the safe screen after 8 seconds.
    ready() {
      if (isReady) return;
      isReady = true;
      const t = themeOf();
      lastTheme = JSON.stringify(t);
      call('ready', t);
      // Entrance animations can still be moving the header at this point, and
      // the next cold start is painted from what gets sampled, so look again
      // once they've settled.
      setTimeout(() => retheme(0), 1200);
    },
  };
  call('subscribe');
})();
