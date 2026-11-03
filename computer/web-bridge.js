// window.lab for the app opened in a browser on the Mac itself. The phone
// gets the same API from the Android shell, so a design works in both.
(() => {
  const listeners = new Set();
  const outbox = [];
  let link = { kind: 'link', state: 'connecting' };
  let status = null;
  let mac = null;
  let shortcuts = null;
  let lastId = null;

  const emit = (e) => { for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } } };
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  function connect() {
    const es = new EventSource(lastId === null ? '/events' : `/events?after=${lastId}`);
    es.addEventListener('hello', (m) => {
      const hello = JSON.parse(m.data);
      link = { kind: 'link', state: 'online' };
      emit(link);
      status = { kind: 'status', ...hello.status };
      emit(status);
      if (hello.mac) emit(mac = hello.mac);
      emit(shortcuts = { kind: 'shortcuts', items: hello.shortcuts ?? [] });
      flush();
    });
    es.addEventListener('loaded', () => emit({ kind: 'loaded' }));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.id) lastId = e.id;
      if (e.kind === 'status') status = e;
      if (e.kind === 'mac') mac = e;
      if (e.kind === 'shortcuts') shortcuts = e;
      if (e.kind === 'design') return location.reload();
      emit(e);
    };
    es.onerror = () => {
      es.close();
      link = { kind: 'link', state: 'offline', detail: 'The server on this Mac is not answering.' };
      emit(link);
      setTimeout(connect, 3000);
    };
  }

  async function flush() {
    while (outbox.length) {
      const m = outbox[0];
      try {
        const r = await post('/send', { text: m.text, cid: m.cid, files: m.files });
        if (!r.ok && r.status !== 400) throw new Error(String(r.status));
      } catch { return setTimeout(flush, 3000); }
      outbox.shift();
      emit({ kind: 'outbox', items: [...outbox] });
    }
  }

  window.lab = {
    platform: 'web',
    subscribe(fn) {
      listeners.add(fn);
      fn(link);
      if (status) fn(status);
      if (mac) fn(mac);
      if (shortcuts) fn(shortcuts);
      fn({ kind: 'outbox', items: [...outbox] });
      return () => listeners.delete(fn);
    },
    send(text, files) {
      const cid = crypto.randomUUID();
      outbox.push({ cid, text, at: new Date().toISOString(), ...(files?.length ? { files } : {}) });
      emit({ kind: 'outbox', items: [...outbox] });
      flush();
      return cid;
    },
    stop: () => post('/stop').then((r) => { if (!r.ok) throw r; }).catch(() => emit({ kind: 'stopFailed' })),
    answer: (ref, allow, always) => post('/answer', { ref, allow, always: !!always }).then((r) => { if (!r.ok && r.status !== 404) throw r; }).catch(() => emit({ kind: 'answerFailed', ref })),
    // Memory, schedules, always-allowed commands and the setup check.
    async call(method, path, body) {
      const r = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `The Mac answered ${r.status}.`);
      return out;
    },
    check() { return this.call('GET', '/check'); },
    undoDesign: () => post('/design/undo'),
    saveShortcuts: (items) => post('/shortcuts', { items }).then((r) => r.ok, () => false),
    attach(kind) {
      return new Promise((done, fail) => {
        const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: kind === 'photos' ? 'image/*' : '' });
        input.onchange = async () => {
          try {
            const out = [];
            for (const f of input.files) {
              const r = await fetch(`/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: f });
              if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Couldn't upload ${f.name}.`);
              out.push(await r.json());
            }
            done(out);
          } catch (e) { fail(e instanceof Error && e.message !== 'Failed to fetch' ? e : new Error("Couldn't reach the server, so nothing was attached.")); }
        };
        input.oncancel = () => done([]);
        input.click();
      });
    },
    fileUrl: (url) => url,
    open: (url) => window.open(url, '_blank', 'noopener'),
    fix() {},
    retry() { location.reload(); },
    safeMode() {},
    leaveSafeMode() {},
    onBack() {},
    ready() {},
  };
  // While someone is at this Mac with The Lab in front, the phone stays quiet.
  const here = () => { if (document.visibilityState === 'visible' && document.hasFocus()) post('/presence').catch(() => {}); };
  setInterval(here, 30_000);
  addEventListener('focus', here);
  connect();
})();
