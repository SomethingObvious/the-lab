// A stand-in for window.lab that plays a scripted session, so a design can be
// judged without a Mac or a phone. Same contract as the Android bridge.
(() => {
  const listeners = new Set();
  const backlog = [];
  let id = 0;
  let backFn = null;
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const t0 = Date.now();
  const ago = (min) => new Date(t0 - min * 60000).toISOString();
  const now = () => new Date().toISOString();
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  let online = true;
  let insets = {};
  // history=delay holds the history back like a slow disk does on the phone,
  // so everything else arrives first.
  let held = params.get('history') === 'delay' ? [] : null;
  const deliver = (e) => {
    if (held && e.id) { held.push(e); return; }
    if (e.kind === 'link') online = e.state === 'online';
    if (e.kind === 'insets') {
      insets = e;
      for (const side of ['top', 'right', 'bottom', 'left']) root.style.setProperty(`--lab-inset-${side}`, `${e[side] || 0}px`);
      root.toggleAttribute('data-keyboard', !!e.keyboard);
    }
    if (e.kind === 'fold') {
      for (const side of ['left', 'top', 'right', 'bottom']) {
        if (e.hinge) root.style.setProperty(`--lab-hinge-${side}`, `${e.hinge[side]}px`);
        else root.style.removeProperty(`--lab-hinge-${side}`);
      }
      if (e.posture) root.dataset.fold = e.posture;
      else delete root.dataset.fold;
    }
    // Like the shell, gesture progress only reaches a page that handles Back.
    if ((e.kind === 'backprogress' || e.kind === 'backcancel') && !backFn) return;
    if (e.kind === 'back') { if (backFn) backFn(); return; }
    backlog.push(e);
    for (const fn of listeners) { try { fn(e); } catch (err) { console.error(err); } }
  };
  const ev = (kind, fields, at) => deliver({ id: ++id, at: at ?? now(), kind, ...fields });
  let status = { kind: 'status', working: false, label: '', since: ago(30) };
  const setStatus = (working, label = '') => {
    status = { kind: 'status', working, label, since: working && status.working ? status.since : now() };
    deliver(status);
  };
  let outbox = [];
  const setOutbox = (items) => { outbox = items; deliver({ kind: 'outbox', items: [...items] }); };

  // Earlier in the day.
  deliver({ kind: 'insets', top: Number(params.get('top') ?? 28), right: Number(params.get('right') ?? 0), bottom: Number(params.get('bottom') ?? 18), left: Number(params.get('left') ?? 0), keyboard: params.has('keyboard') });
  deliver({ kind: 'link', state: 'online', detail: 'Connected to the Mac' });
  deliver(status);
  deliver({ kind: 'outbox', items: [] });

  // Battery, disk and uptime arrive on connect and then every minute.
  const GB = 1e9;
  let mac = { kind: 'mac', name: "Sam's MacBook Pro", battery: { percent: 82, charging: true }, disk: { free: 214.3 * GB, total: 994.7 * GB }, uptime: 3 * 86400 + 5 * 3600 + 12 * 60, at: now() };
  const sendMac = () => {
    if (!online) return;
    const b = mac.battery;
    mac = { ...mac, battery: b && { percent: Math.min(100, b.percent + (b.charging ? 1 : -1)), charging: b.charging }, disk: { ...mac.disk, free: mac.disk.free - Math.round(Math.random() * 0.2 * GB) }, uptime: mac.uptime + Math.round((Date.now() - Date.parse(mac.at)) / 1000), at: now() };
    deliver(mac);
  };
  // battery=none is a Mac mini or an iMac.
  if (params.get('battery') === 'none') mac.battery = null;
  deliver(mac);
  setInterval(sendMac, 60000);

  let shortcuts = [
    { id: 's1', label: 'Battery and Disk', text: "How's the battery and disk space doing?" },
    { id: 's2', label: 'Screenshot', text: 'Send me a screenshot of the screen right now.' },
    { id: 's3', label: 'Empty the Trash', text: 'Empty the Trash.' },
    { id: 's4', label: "Today's Changes", text: 'What files in Documents changed today?' },
  ];
  deliver({ kind: 'shortcuts', items: shortcuts });

  // Demo uploads point at the files in demos/media.
  const media = { '7c1e0a9b-IMG_2041.jpg': 'IMG_2041.jpg', 'e04d77a2-Screenshot 2026-11-01 at 09.12.png': 'Screenshot-0912.png', '3f9a21c0-IMG_2077.jpg': 'IMG_2041.jpg' };
  const mediaBase = new URL('media/', document.currentScript.src).href;

  ev('you', { text: "Can you put the Mac on this Wi-Fi network? The password's on the label.", cid: 'y1', files: [{ name: 'IMG_2041.jpg', url: '/files/7c1e0a9b-IMG_2041.jpg', size: 2318004, type: 'image/jpeg' }] }, ago(1530));
  ev('step', { ref: 'y1a', tool: 'Read', title: 'Reading IMG_2041.jpg', detail: '/Users/sam/TheLab/.lab/files/7c1e0a9b-IMG_2041.jpg' }, ago(1530));
  ev('step', { ref: 'y1b', tool: 'Bash', title: 'Join the Halloran-5G network', detail: 'networksetup -setairportnetwork en0 "Halloran-5G" "$WIFI_PASSWORD"' }, ago(1529));
  ev('reply', { text: "The Mac is on **Halloran-5G** now. It'll rejoin it by itself from here on." }, ago(1529));
  ev('done', { ok: true, stopped: false, ms: 17300 }, ago(1529));
  ev('you', { text: 'Send me a screenshot of the screen right now.', cid: 'y2' }, ago(1442));
  ev('step', { ref: 'y2a', tool: 'Bash', title: 'Take a screenshot', detail: 'screencapture -x ~/Desktop/"Screenshot 2026-11-01 at 09.12.png"' }, ago(1442));
  ev('step', { ref: 'y2b', tool: 'mcp__lab__send_to_phone', title: 'Sending Screenshot 2026-11-01 at 09.12.png to your phone', detail: '/Users/sam/Desktop/Screenshot 2026-11-01 at 09.12.png' }, ago(1442));
  ev('file', { name: 'Screenshot 2026-11-01 at 09.12.png', url: '/files/e04d77a2-Screenshot 2026-11-01 at 09.12.png', size: 391204, type: 'image/png' }, ago(1442));
  ev('reply', { text: "Here it is. Finder's open on Downloads and nothing else is running." }, ago(1442));
  ev('done', { ok: true, stopped: false, ms: 9100 }, ago(1442));
  ev('you', { text: "What's taking up the most space on my Mac? Top 5 folders.", cid: 'h1' }, ago(184));
  ev('step', { ref: 'a1', tool: 'Bash', title: 'Measure the folders in your home folder', detail: 'du -sh ~/* 2>/dev/null | sort -rh | head -5' }, ago(184));
  ev('reply', { text: "Your home folder is 412 GB. The big five:\n\n1. **Movies** 168 GB (mostly Final Cut libraries)\n2. **Library** 96 GB, of which Xcode caches are 41 GB\n3. **Downloads** 58 GB\n4. **Pictures** 44 GB\n5. **Documents** 21 GB\n\nThe Xcode caches are safe to clear if you want 41 GB back." }, ago(183));
  ev('done', { ok: true, stopped: false, ms: 21400 }, ago(183));
  ev('you', { text: 'Find the Apple receipt from last week in my Gmail and save the PDF to Documents/Receipts. Send it to me too.', cid: 'h2' }, ago(52));
  ev('step', { ref: 'b1', tool: 'mcp__claude-in-chrome__navigate', title: 'Opening mail.google.com in Chrome', detail: 'https://mail.google.com/mail/u/0/#search/from%3Aapple+receipt+newer_than%3A10d' }, ago(52));
  ev('step', { ref: 'b2', tool: 'mcp__claude-in-chrome__find', title: 'Chrome: find', detail: '{\n  "query": "Your receipt from Apple, Oct 27"\n}' }, ago(52));
  ev('step', { ref: 'b3', tool: 'Bash', title: 'Move the downloaded receipt into Documents/Receipts', detail: 'mkdir -p ~/Documents/Receipts && mv ~/Downloads/Receipt-MKTN4Q7.pdf ~/Documents/Receipts/2026-10-27-apple.pdf' }, ago(51));
  ev('step', { ref: 'b4', tool: 'mcp__lab__send_to_phone', title: 'Sending 2026-10-27-apple.pdf to your phone', detail: '/Users/sam/Documents/Receipts/2026-10-27-apple.pdf' }, ago(51));
  ev('file', { name: '2026-10-27-apple.pdf', url: '/files/demo-receipt.pdf', size: 48211, caption: 'Apple receipt, Oct 27, $14.68' }, ago(51));
  ev('reply', { text: 'Saved it as Documents/Receipts/2026-10-27-apple.pdf and sent you a copy. It was iCloud+ 2 TB, $14.68 with tax.' }, ago(51));
  ev('done', { ok: true, stopped: false, ms: 48900 }, ago(51));

  function cleanup() {
    ev('you', { text: 'Clean up my Downloads. Move installers older than a month to the Trash.', cid: crypto.randomUUID() });
    setStatus(true, 'Reading your message');
    later(1200, () => setStatus(true, 'Thinking'));
    later(2600, () => { ev('step', { ref: 'c1', tool: 'Bash', title: 'List installers in Downloads older than 30 days', detail: 'find ~/Downloads -maxdepth 1 \\( -name "*.dmg" -o -name "*.pkg" -o -name "*.zip" \\) -mtime +30 -print0 | xargs -0 du -ch' }); setStatus(true, 'List installers in Downloads older than 30 days'); });
    later(4400, () => { ev('step', { ref: 'c2', tool: 'Bash', title: 'Check none of them are still mounted', detail: 'hdiutil info | grep -E "image-path" ' }); setStatus(true, 'Check none of them are still mounted'); });
    later(5600, () => { ev('failed', { ref: 'c2', text: 'hdiutil: info failed: Resource busy' }); });
    later(6400, () => { ev('step', { ref: 'c3', tool: 'Bash', title: 'Check mounted disk images another way', detail: 'mount | grep -i "/Volumes/"' }); setStatus(true, 'Check mounted disk images another way'); });
    later(8200, () => {
      ev('ask', { ref: 'c4', tool: 'Bash', title: 'Move 14 files (3.2 GB) from Downloads to the Trash?', detail: 'Docker.dmg, Figma-124.4.dmg, zoomusInstaller.pkg, Steam.dmg, OBS-Studio-31.1.dmg, Blender-4.5.dmg, and 8 more.\n\nosascript -e \'tell application "Finder" to delete (POSIX file ...)\'' });
      setStatus(true, 'Waiting for you');
      later(20000, () => api.answer('c4', true));
    });
  }
  let asked = new Set();
  function afterAnswer(ref, allow) {
    if (ref !== 'c4' || asked.has(ref)) return;
    asked.add(ref);
    ev('answered', { ref, allow, by: 'phone' });
    if (!allow) {
      later(900, () => { ev('reply', { text: "OK, I left them alone. I can list them with sizes instead if you'd like to pick." }); ev('done', { ok: true, stopped: false, ms: 14000 }); setStatus(false); });
      return;
    }
    later(700, () => { ev('step', { ref: 'c5', tool: 'Bash', title: 'Move 14 old installers to the Trash', detail: 'osascript -e \'tell application "Finder" to delete (every file of folder "Downloads" of home whose name is in {"Docker.dmg", ...})\'' }); setStatus(true, 'Move 14 old installers to the Trash'); });
    later(3200, () => {
      ev('reply', { text: 'Moved 14 installers to the Trash, 3.2 GB in all. I skipped **Blender-4.5.dmg** because it is still mounted. Eject it and I can take it too.\n\nThe Trash isn\'t emptied, so anything is still recoverable.' });
      ev('done', { ok: true, stopped: false, ms: 29800 });
      setStatus(false);
      later(3500, () => deliver({ kind: 'link', state: 'offline', detail: "Can't reach the Mac. It may be asleep, switched off or offline." }));
      later(9000, () => { deliver({ kind: 'link', state: 'online', detail: 'Connected to the Mac' }); sendMac(); deliver({ kind: 'shortcuts', items: shortcuts }); ev('notice', { text: 'The server on the Mac restarted while the Mac was asleep. Nothing was running.' }); });
    });
  }

  function reply(text, files) {
    ev('you', { text, cid: crypto.randomUUID(), ...(files?.length ? { files } : {}) });
    setStatus(true, 'Thinking');
    later(1500, () => { ev('step', { ref: 'd' + id, tool: 'Read', title: 'Reading notes.md', detail: '/Users/sam/TheLab/notes.md' }); setStatus(true, 'Reading notes.md'); });
    later(3200, () => { ev('reply', { text: "This is a demo, so nothing ran on a Mac. On the real thing you'd see each step here as it happens." }); ev('done', { ok: true, stopped: false, ms: 3200 }); setStatus(false); });
  }

  const api = {
    platform: 'demo',
    subscribe(fn) {
      listeners.add(fn);
      for (const e of backlog) { try { fn(e); } catch (err) { console.error(err); } }
      return () => listeners.delete(fn);
    },
    send(text, files) {
      const cid = crypto.randomUUID();
      const item = { cid, text, at: now(), ...(files?.length ? { files } : {}) };
      setOutbox([...outbox, item]);
      const flush = () => {
        if (!online) return later(1000, flush);
        setOutbox(outbox.filter((m) => m.cid !== cid));
        reply(text, files);
      };
      later(700, flush);
      return cid;
    },
    attach(kind) {
      return new Promise((resolve, reject) => setTimeout(() => {
        if (!online || params.get('attach') === 'fail') return reject(new Error("Couldn't send that to the Mac because it can't be reached right now. Try again once it's back."));
        if (params.get('attach') === 'cancel') return resolve([]);
        resolve(kind === 'photos'
          ? [{ name: 'IMG_2077.jpg', url: '/files/3f9a21c0-IMG_2077.jpg', size: 2471880, type: 'image/jpeg' }]
          : [{ name: 'tax-notes.txt', url: '/files/b81f0c3e-tax-notes.txt', size: 1832, type: 'text/plain' }]);
      }, 900));
    },
    saveShortcuts(items) {
      return new Promise((resolve) => setTimeout(() => {
        if (!online) return resolve(false);
        shortcuts = items.map((s, i) => ({ id: s.id || `s${Date.now()}${i}`, label: String(s.label).slice(0, 40), text: String(s.text).slice(0, 2000) }));
        deliver({ kind: 'shortcuts', items: shortcuts });
        resolve(true);
      }, 250));
    },
    stop() {
      for (const t of timers.splice(0)) clearTimeout(t);
      if (!status.working) return;
      ev('done', { ok: false, stopped: true, ms: Date.now() - Date.parse(status.since) });
      setStatus(false);
    },
    answer(ref, allow) { afterAnswer(ref, !!allow); },
    undoDesign() {},
    open(url) { console.log('open', url); },
    // The shell and the Mac resize for { w }, the demo just serves the file.
    fileUrl: (url, opts) => { const m = media[decodeURIComponent(url).replace(/^\/files\//, '')]; return m ? mediaBase + m : url; },
    fix() {},
    retry() {},
    safeMode() {},
    leaveSafeMode() {},
    onBack(fn) { backFn = fn || null; },
    ready() { parent.postMessage({ demoReady: true }, '*'); },
  };
  window.lab = api;
  window.addEventListener('message', (m) => {
    if (m.data === 'back') deliver({ kind: 'back' });
    else if (m.data === 'backcancel') deliver({ kind: 'backcancel' });
    else if (typeof m.data?.backprogress === 'number') deliver({ kind: 'backprogress', progress: m.data.backprogress, edge: m.data.edge || 'left' });
  });

  // The keyboard slides over a full-height page, and the shell sends its
  // height as the bottom inset on every frame. kb=sim opens it on focus.
  const navBottom = Number(params.get('bottom') ?? 18);
  let kbFrame = 0, kbDone = null;
  window.__kb = (open, ms = 250) => new Promise((done) => {
    cancelAnimationFrame(kbFrame);
    kbDone?.();
    kbDone = done;
    const from = insets.keyboard ? insets.bottom : 0;
    const to = open ? Math.round(innerHeight * 0.36) : 0;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const h = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
      deliver({ ...insets, kind: 'insets', bottom: Math.max(navBottom, h), keyboard: h > 0 });
      if (k < 1) kbFrame = requestAnimationFrame(step); else { kbDone = null; done(); }
    };
    kbFrame = requestAnimationFrame(step);
  });
  if (params.get('kb') === 'sim') {
    const typing = (el) => el?.matches?.('textarea, input:not([type=button])');
    addEventListener('focusin', (e) => { if (typing(e.target)) __kb(true); });
    addEventListener('focusout', () => setTimeout(() => { if (!typing(document.activeElement)) __kb(false); }, 50));
  }

  // fold=book or fold=tabletop puts a hinge across the middle, hinge=24 gives
  // it a width. __fold(posture) switches it live.
  window.__fold = (posture, w = Number(params.get('hinge') ?? 0)) => {
    const hinge = posture === 'book' ? { left: Math.round(innerWidth / 2 - w / 2), top: 0, right: Math.round(innerWidth / 2 + w / 2), bottom: innerHeight }
      : posture === 'tabletop' ? { left: 0, top: Math.round(innerHeight / 2 - w / 2), right: innerWidth, bottom: Math.round(innerHeight / 2 + w / 2) } : null;
    deliver({ kind: 'fold', posture: hinge ? posture : null, hinge });
  };
  // Sizes only settle once the viewport meta has been read.
  if (params.get('fold')) addEventListener('DOMContentLoaded', () => __fold(params.get('fold')));

  if (held) later(Number(params.get('hold') ?? 600), () => { const h = held; held = null; h.forEach(deliver); deliver({ kind: 'loaded' }); });
  else deliver({ kind: 'loaded' });
  if (params.get('script') !== 'off') setTimeout(cleanup, Number(params.get('delay') ?? 2500));
})();
