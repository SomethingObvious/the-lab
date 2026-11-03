// How the phone reaches the server without Tailscale. Each phone connection
// is carried, sealed, either straight over the local network or through a
// relay that both ends dial out to, so the relay and anyone on the Wi-Fi only
// ever see ciphertext. The server itself still listens on 127.0.0.1 alone.
//
// The handshake is Noise NK with a pre-shared key, done by hand: the phone
// knows this computer's static key and a pass from pairing, sends a fresh
// ephemeral key, and both sides derive two AES-256-GCM keys from both
// Diffie-Hellman results and the pass. Frames are numbered implicitly, so a
// replayed, dropped or reordered frame fails to open.
//
// phone/.../Tunnel.kt is the other end and has to stay in step with this file.
import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { duplexPair, type Duplex } from 'node:stream';

const LABEL = Buffer.from('the lab tunnel 1');
const HELLO = 1, WELCOME = 2;
const OPEN = 1, DATA = 2, END = 3, ACK = 4;
// What the relay puts in front of each frame for the computer.
const R_DATA = 0, R_LEAVE = 2;
const CHUNK = 32 * 1024;
// Bytes a stream may have in flight before it waits for an ack, which keeps
// the relay and both ends from buffering a whole 100 MB upload.
const WINDOW = 1024 * 1024;
const ACK_EVERY = 64 * 1024;
const MAX_PACKET = 256 * 1024;

export type Keys = { secret: string; priv: string; pass: string };
export type Spec = { relay?: string; room: string; key: string; pass: string; lan: string[] };
export type TunnelState = { relay: string; lan: string; peers: number };

const b64 = (b: Buffer) => b.toString('base64url');
const raw = (s: string) => Buffer.from(s, 'base64url');
export const roomOf = (secret: string) => b64(createHash('sha256').update(secret).digest());

export function keys(dir: string): Keys {
  const file = join(dir, 'tunnel.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  const k = { secret: b64(randomBytes(32)), priv: b64(ec.getPrivateKey()), pass: b64(randomBytes(32)) };
  writeFileSync(file, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 });
  return k;
}

const staticKey = (k: Keys) => {
  const ec = createECDH('prime256v1');
  ec.setPrivateKey(raw(k.priv));
  return ec;
};

export function lanAddresses(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(`${a.address}:${port}`);
  }
  return out.slice(0, 6);
}

export const specOf = (k: Keys, relay: string | undefined, lan: string[]): Spec =>
  ({ ...(relay ? { relay } : {}), room: roomOf(k.secret), key: b64(staticKey(k).getPublicKey()), pass: k.pass, lan });

class Box {
  private n = 0n;
  private key: Buffer;
  constructor(key: Buffer) { this.key = key; }
  private iv() {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.n++, 4);
    return iv;
  }
  seal(pt: Buffer) {
    const c = createCipheriv('aes-256-gcm', this.key, this.iv());
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  }
  open(ct: Buffer) {
    if (ct.length < 16) throw new Error('short frame');
    const d = createDecipheriv('aes-256-gcm', this.key, this.iv());
    d.setAuthTag(ct.subarray(-16));
    return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  }
}

function derive(mine: ECDH, ours: ECDH, theirs: Buffer, pass: Buffer, ep: Buffer, ec: Buffer, s: Buffer) {
  const ikm = Buffer.concat([mine.computeSecret(theirs), ours.computeSecret(theirs)]);
  const okm = Buffer.from(hkdfSync('sha256', ikm, pass, Buffer.concat([LABEL, ep, ec, s]), 64));
  return { p2c: okm.subarray(0, 32), c2p: okm.subarray(32) };
}

type Stream = { sock: Duplex; unacked: number; pending: number; ended: boolean };

// Streams over one session. Either end can be handed a local Duplex: the
// computer's are sockets to the server, the test's are one half of a pair.
class Mux {
  streams = new Map<number, Stream>();
  private out: (pt: Buffer) => void;
  constructor(out: (pt: Buffer) => void) { this.out = out; }

  frame(id: number, type: number, data: Buffer = Buffer.alloc(0)) {
    const h = Buffer.alloc(5);
    h.writeUInt32BE(id);
    h[4] = type;
    this.out(Buffer.concat([h, data]));
  }

  attach(id: number, sock: Duplex) {
    const s: Stream = { sock, unacked: 0, pending: 0, ended: false };
    this.streams.set(id, s);
    sock.on('data', (b: Buffer) => {
      for (let i = 0; i < b.length; i += CHUNK) this.frame(id, DATA, b.subarray(i, i + CHUNK));
      s.unacked += b.length;
      if (s.unacked > WINDOW) sock.pause();
    });
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      if (this.streams.get(id) !== s) return;
      this.streams.delete(id);
      if (!s.ended) this.frame(id, END);
    });
  }

  take(pt: Buffer, opener?: () => Duplex) {
    if (pt.length < 5) throw new Error('short frame');
    const id = pt.readUInt32BE(0), type = pt[4], data = pt.subarray(5);
    const s = this.streams.get(id);
    if (type === OPEN && opener && !s) return this.attach(id, opener());
    if (!s) return;
    if (type === DATA) {
      s.sock.write(data, () => {
        s.pending += data.length;
        if (s.pending >= ACK_EVERY && this.streams.get(id) === s) {
          const n = Buffer.alloc(4);
          n.writeUInt32BE(s.pending);
          s.pending = 0;
          this.frame(id, ACK, n);
        }
      });
    } else if (type === ACK && data.length === 4) {
      s.unacked -= data.readUInt32BE(0);
      if (s.unacked <= WINDOW && s.sock.isPaused()) s.sock.resume();
    } else if (type === END) {
      s.ended = true;
      s.sock.end();
    }
  }

  closeAll() {
    for (const s of this.streams.values()) { s.ended = true; s.sock.destroy(); }
    this.streams.clear();
  }
}

// The computer's end of one phone's session.
export class Responder {
  private mux?: Mux;
  private inBox?: Box;
  private outBox?: Box;
  private k: Keys;
  private port: number;
  private send: (b: Buffer) => void;
  private drop: () => void;
  constructor(k: Keys, port: number, send: (b: Buffer) => void, drop: () => void) {
    this.k = k;
    this.port = port;
    this.send = send;
    this.drop = drop;
  }

  packet(b: Buffer) {
    try {
      if (!this.mux) return this.hello(b);
      this.mux.take(this.inBox!.open(b), () => connect(this.port, '127.0.0.1'));
    } catch {
      this.close();
      this.drop();
    }
  }

  private hello(b: Buffer) {
    if (b.length !== 66 || b[0] !== HELLO) throw new Error('bad hello');
    const ep = b.subarray(1);
    const s = staticKey(this.k);
    const e = createECDH('prime256v1');
    e.generateKeys();
    const { p2c, c2p } = derive(s, e, ep, raw(this.k.pass), ep, e.getPublicKey(), s.getPublicKey());
    this.inBox = new Box(p2c);
    this.outBox = new Box(c2p);
    this.send(Buffer.concat([Buffer.from([WELCOME]), e.getPublicKey(), this.outBox.seal(Buffer.from('lab'))]));
    this.mux = new Mux((pt) => this.send(this.outBox!.seal(pt)));
  }

  close() { this.mux?.closeAll(); }
}

// One packet per length-prefixed frame, for the direct link.
function framed(sock: Socket, onPacket: (b: Buffer) => void) {
  let buf: Buffer = Buffer.alloc(0);
  sock.on('data', (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (n > MAX_PACKET) { sock.destroy(); return; }
      if (buf.length < 4 + n) break;
      onPacket(buf.subarray(4, 4 + n));
      buf = buf.subarray(4 + n);
    }
  });
  return (b: Buffer) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length);
    if (!sock.destroyed) sock.write(Buffer.concat([h, b]));
  };
}

const relayUrl = (relay: string, room: string) => `${relay.replace(/\/+$/, '').replace(/^http/, 'ws')}/r/${room}`;

export type TunnelOptions = { dir: string; port: number; relay?: string; lanPort: number; lanHost?: string };

export function startTunnel(o: TunnelOptions) {
  const k = keys(o.dir);
  const state: TunnelState = { relay: o.relay ? 'connecting' : 'off', lan: 'starting', peers: 0 };
  let stopped = false;

  const lan = createServer((sock) => {
    sock.setNoDelay(true);
    let r: Responder | null = null;
    const send = framed(sock, (p) => r?.packet(p));
    r = new Responder(k, o.port, send, () => sock.destroy());
    state.peers++;
    sock.on('error', () => {});
    sock.on('close', () => { state.peers--; r?.close(); });
  });
  lan.on('error', (e) => { state.lan = `off: ${e.message}`; });
  lan.listen(o.lanPort, o.lanHost ?? '0.0.0.0', () => { state.lan = 'on'; });

  let ws: WebSocket | null = null;
  let wait = 1000;
  let seen = 0;
  const sessions = new Map<number, Responder>();
  const endSessions = () => { for (const r of sessions.values()) r.close(); state.peers -= sessions.size; sessions.clear(); };
  const dial = () => {
    if (stopped || !o.relay) return;
    const sock = new WebSocket(relayUrl(o.relay, roomOf(k.secret)), ['lab', k.secret]);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    const to = (peer: number, type: number, body: Buffer = Buffer.alloc(0)) => {
      if (sock.readyState !== WebSocket.OPEN) return;
      const h = Buffer.alloc(5);
      h.writeUInt32BE(peer);
      h[4] = type;
      sock.send(Buffer.concat([h, body]));
    };
    sock.onopen = () => { state.relay = 'connected'; wait = 1000; seen = Date.now(); };
    sock.onmessage = (ev) => {
      seen = Date.now();
      if (typeof ev.data === 'string') return;
      const b = Buffer.from(ev.data as ArrayBuffer);
      if (b.length < 5) return;
      const peer = b.readUInt32BE(0), type = b[4];
      if (type === R_LEAVE) {
        if (sessions.has(peer)) state.peers--;
        sessions.get(peer)?.close();
        sessions.delete(peer);
        return;
      }
      if (type !== R_DATA) return;
      let r = sessions.get(peer);
      if (!r) {
        const fresh: Responder = new Responder(k, o.port, (p) => to(peer, R_DATA, p), () => {
          if (sessions.get(peer) === fresh) { sessions.delete(peer); state.peers--; }
          to(peer, R_LEAVE);
        });
        r = fresh;
        sessions.set(peer, r);
        state.peers++;
      }
      r.packet(b.subarray(5));
    };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      endSessions();
      state.relay = ev.code === 1008 || ev.code === 4003 ? 'refused: this computer is not the room owner' : `reconnecting (${ev.code || 'no answer'})`;
      if (!stopped) setTimeout(dial, wait);
      wait = Math.min(wait * 2, 30_000);
    };
  };
  dial();

  // The relay answers "ping" without waking up, so silence for this long
  // means the link died without a close.
  const beat = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - seen > 75_000) {
      const dead = ws;
      ws = null;
      endSessions();
      state.relay = 'reconnecting (timed out)';
      dead.close();
      dial();
      return;
    }
    ws.send('ping');
  }, 30_000);

  return {
    state,
    spec: () => specOf(k, o.relay, lanAddresses(o.lanPort)),
    close() {
      stopped = true;
      clearInterval(beat);
      lan.close();
      ws?.close();
      endSessions();
    },
  };
}

// The phone's side, for the tests and for checking a route from this
// computer. Resolves once the handshake is done.
export async function dial(sp: Spec, how: { host: string; port: number } | { relay: string }, timeout = 8000) {
  const e = createECDH('prime256v1');
  e.generateKeys();
  const ep = e.getPublicKey();
  let send: (b: Buffer) => void;
  let close: () => void;
  let onPacket: (b: Buffer) => void = () => {};
  let onLost: (why: string) => void = () => {};

  if ('host' in how) {
    const sock = connect(how.port, how.host);
    sock.setNoDelay(true);
    send = framed(sock, (b) => onPacket(b));
    close = () => sock.destroy();
    sock.on('error', () => {});
    sock.on('close', () => onLost('closed'));
  } else {
    const ws = new WebSocket(relayUrl(how.relay, sp.room));
    ws.binaryType = 'arraybuffer';
    const queued: Buffer[] = [];
    send = (b) => (ws.readyState === WebSocket.OPEN ? ws.send(b as Uint8Array<ArrayBuffer>) : queued.push(b));
    ws.onopen = () => { for (const b of queued.splice(0)) ws.send(b as Uint8Array<ArrayBuffer>); };
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? onLost(ev.data) : onPacket(Buffer.from(ev.data as ArrayBuffer)));
    ws.onclose = () => onLost('closed');
    close = () => ws.close();
  }

  const welcome = await new Promise<Buffer>((ok, fail) => {
    const t = setTimeout(() => fail(new Error('no answer')), timeout);
    onPacket = (b) => { clearTimeout(t); ok(b); };
    onLost = (why) => { clearTimeout(t); fail(new Error(why)); };
    send(Buffer.concat([Buffer.from([HELLO]), ep]));
  }).catch((err) => { close(); throw err; });

  const s = raw(sp.key);
  if (welcome.length !== 1 + 65 + 3 + 16 || welcome[0] !== WELCOME) { close(); throw new Error('bad welcome'); }
  const ec = welcome.subarray(1, 66);
  const ikm = Buffer.concat([e.computeSecret(s), e.computeSecret(ec)]);
  const okm = Buffer.from(hkdfSync('sha256', ikm, raw(sp.pass), Buffer.concat([LABEL, ep, ec, s]), 64));
  const outBox = new Box(okm.subarray(0, 32)), inBox = new Box(okm.subarray(32));
  try {
    if (inBox.open(welcome.subarray(66)).toString() !== 'lab') throw new Error();
  } catch {
    close();
    throw new Error('wrong key');
  }
  const mux = new Mux((pt) => send(outBox.seal(pt)));
  let lost = false;
  onPacket = (b) => {
    try { mux.take(inBox.open(b)); } catch { lost = true; mux.closeAll(); close(); }
  };
  onLost = () => { lost = true; mux.closeAll(); };
  let next = 1;
  return {
    get lost() { return lost; },
    // A socket-like stream to the server, for http.request's createConnection.
    connection(): Duplex {
      const [mine, theirs] = duplexPair();
      const id = next;
      next += 2;
      mux.frame(id, OPEN);
      mux.attach(id, theirs);
      return mine;
    },
    close() { mux.closeAll(); close(); },
  };
}
