import { query, tool, createSdkMcpServer, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { closeSync, copyFileSync, existsSync, fdatasyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clip, detail, title } from './steps.ts';

export type Ev = { id: number; at: string; kind: string; [k: string]: unknown };
type Listener = (e: Ev | Live) => void;
// Live events go to whoever is connected and are never stored or replayed.
export type Live = { kind: 'status' | 'design' | 'mac' | 'shortcuts'; [k: string]: unknown };
export type Attached = { name: string; url: string; size: number; type: string };

const KEEP = 5000;

export class Store {
  events: Ev[] = [];
  private next = 1;
  private fd: number;
  private listeners = new Set<Listener>();

  constructor(file: string) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { this.events.push(JSON.parse(line)); } catch { /* a torn last line from a power cut */ }
      }
      // The file only ever grows, so it gets cut back to the window that is
      // served on start, which keeps it under a couple of MB.
      if (lines.length > KEEP * 2) {
        this.events = this.events.slice(-KEEP);
        writeFileSync(file + '.tmp', this.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        renameSync(file + '.tmp', file);
      }
      this.events = this.events.slice(-KEEP);
      this.next = (this.events.at(-1)?.id ?? 0) + 1;
    }
    this.fd = openSync(file, 'a');
  }

  add(e: { kind: string; [k: string]: unknown }, durable = false): Ev {
    const ev = { id: this.next++, at: new Date().toISOString(), ...e } as Ev;
    writeSync(this.fd, JSON.stringify(ev) + '\n');
    if (durable) fdatasyncSync(this.fd);
    this.events.push(ev);
    if (this.events.length > KEEP * 1.2) this.events = this.events.slice(-KEEP);
    for (const l of this.listeners) l(ev);
    return ev;
  }

  live(e: Live) { for (const l of this.listeners) l(e); }

  // With no cursor the phone gets the last 300 events, which covers a fresh
  // install without shipping months of history over the first connection.
  since(after: number | null): Ev[] {
    if (after === null) return this.events.slice(-300);
    return this.events.filter((e) => e.id > after);
  }

  listen(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  close() { closeSync(this.fd); }
}

type State = { sessionId?: string; open?: { text: string; at: string } | null };

class Channel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) { this.queue.push(m); this.wake?.(); }
  close() { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const m = this.queue.shift();
      if (m) { yield m; continue; }
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

const NOTICE: Record<string, string> = {
  authentication_failed: 'The Mac is signed out of Claude. Open Claude on the Mac and sign in, then send your message again.',
  billing_error: 'The Claude plan on the Mac has a billing problem. Check the account, then send your message again.',
  rate_limit: 'The Claude plan hit its usage limit for now. It will carry on once the limit resets.',
  account_on_hold: 'The Claude account on the Mac is on hold.',
  verification_required: 'The Claude account on the Mac needs to be verified. Open Claude on the Mac to finish it.',
};

const PROMPT = `You are talking to the owner of this Mac through The Lab, an app on his phone. He reads your replies on the phone, often away from the computer, so lead with the answer and keep formatting light. Your steps show up on his phone live, so you don't need to narrate them. Use the send_to_phone tool when he asks for a file, a screenshot or anything easier to look at than describe. Read CLAUDE.md in the working directory before changing the app.`;

export type LabOptions = { home: string; model?: string };

export class Lab {
  store: Store;
  private q: Query | null = null;
  private input: Channel | null = null;
  private state: State;
  private opts: LabOptions;
  private stateFile: string;
  private filesDir: string;
  private asks = new Map<string, (allow: boolean, by: string) => void>();
  private unanswered: SDKUserMessage[] = [];
  private seen = new Set<string>();
  private stopping = false;
  private initSeen = false;
  status: { working: boolean; label: string; since: string; mode?: string } = { working: false, label: '', since: new Date().toISOString() };

  constructor(opts: LabOptions) {
    this.opts = opts;
    const dir = join(opts.home, '.lab');
    mkdirSync(dir, { recursive: true });
    this.filesDir = join(dir, 'files');
    mkdirSync(this.filesDir, { recursive: true });
    this.stateFile = join(dir, 'state.json');
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {};
    this.store = new Store(join(dir, 'events.jsonl'));
    for (const e of this.store.events) if (e.kind === 'you') this.seen.add(String(e.cid));

    if (this.state.open) {
      // Without a done the cut-off turn's approvals would stay live.
      this.store.add({ kind: 'done', ok: false, stopped: false, ms: 0 });
      this.store.add({
        kind: 'notice',
        text: `The server on the Mac restarted partway through "${clip(this.state.open.text, 120)}". Nothing was redone.`,
        action: { label: 'Carry On', send: 'Carry on with what you were doing before the restart. Check what already got done first.' },
      });
      this.state.open = null;
      this.save();
    }
  }

  private save() {
    writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state));
    renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  private setStatus(working: boolean, label = '') {
    if (working === this.status.working && label === this.status.label) return;
    const since = working === this.status.working ? this.status.since : new Date().toISOString();
    this.status = { ...this.status, working, label, since };
    this.store.live({ kind: 'status', ...this.status });
  }

  // `scheduled` is the label of the schedules.json entry that sent it.
  send(text: string, cid: string, files: Attached[] = [], scheduled?: string): boolean {
    if (this.seen.has(cid)) return false;
    this.seen.add(cid);
    this.store.add({ kind: 'you', text, cid, ...(files.length ? { files } : {}), ...(scheduled ? { scheduled } : {}) }, true);
    this.state.open = { text: text || files.map((f) => f.name).join(', '), at: new Date().toISOString() };
    this.save();
    const list = files.map((f) => `- ${join(this.filesDir, basename(decodeURIComponent(f.url)))} (${f.name}, ${f.type})`).join('\n');
    let content = files.length ? `${text}\n\nHe attached ${files.length === 1 ? 'a file' : `${files.length} files`} from his phone:\n${list}`.trim() : text;
    if (scheduled) content = `This is "${scheduled}", a scheduled message from schedules.json, not something he just typed. He may not be looking at the phone, so finish it and reply with the result.\n\n${content}`;
    const m: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: cid as any, session_id: this.state.sessionId ?? '' };
    this.unanswered.push(m);
    this.ensureRunning();
    this.input!.push(m);
    this.setStatus(true, 'Reading your message');
    return true;
  }

  async stop() {
    if (!this.q || !this.status.working) return;
    this.stopping = true;
    for (const finish of this.asks.values()) finish(false, 'stop');
    await this.q.interrupt().catch(() => {});
  }

  answer(ref: string, allow: boolean): boolean {
    const finish = this.asks.get(ref);
    if (!finish) return false;
    finish(allow, 'phone');
    return true;
  }

  private ensureRunning() {
    if (this.q) return;
    this.input = new Channel();
    this.initSeen = false;
    const lab = createSdkMcpServer({
      name: 'lab',
      version: '1.0.0',
      tools: [
        tool(
          'send_to_phone',
          'Send a file from this computer to the owner\'s phone, where it shows in the conversation. Images show inline, other files open in the phone\'s viewer. Max 100 MB.',
          { path: z.string().describe('Absolute path of the file'), caption: z.string().optional().describe('One line shown under the file') },
          async ({ path, caption }) => this.sendFile(path, caption),
        ),
      ],
    });
    const q = query({
      prompt: this.input,
      options: {
        cwd: this.opts.home,
        additionalDirectories: [homedir()],
        permissionMode: 'auto',
        resume: this.state.sessionId,
        model: this.opts.model,
        mcpServers: { lab },
        // The phone has no surface for multiple-choice prompts or plan
        // approval, so the agent asks in plain text instead.
        disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT },
        canUseTool: (name, input, o) => this.ask(name, input, o),
        stderr: (d) => process.stderr.write(d),
      },
    });
    this.q = q;
    this.pump(q);
  }

  private async pump(q: Query) {
    let failure = '';
    try {
      for await (const m of q) this.handle(m);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
      console.error('agent stopped:', failure);
    }
    if (this.q !== q) return;
    this.q = null;
    this.input?.close();
    this.input = null;
    for (const finish of this.asks.values()) finish(false, 'stop');

    // A resume that never got as far as init means the saved conversation
    // is gone (deleted, or from another machine), so start a fresh one with
    // whatever was waiting.
    if (!this.initSeen && this.state.sessionId) {
      this.state.sessionId = undefined;
      this.save();
      this.store.add({ kind: 'notice', text: 'The last conversation could not be reopened, so this is a fresh one.' });
      const waiting = this.unanswered;
      this.unanswered = [];
      if (waiting.length) {
        this.ensureRunning();
        for (const m of waiting) { this.unanswered.push(m); this.input!.push(m); }
        return;
      }
    }
    if (this.status.working) {
      this.store.add({ kind: 'notice', text: `The agent stopped partway through${failure ? ` (${clip(failure, 160)})` : ''}. Send your message again, or ask it to carry on.` });
      this.state.open = null;
      this.save();
    }
    this.setStatus(false);
  }

  private handle(m: SDKMessage) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.initSeen = true;
          this.state.sessionId = m.session_id;
          this.save();
          this.status.mode = m.permissionMode;
          console.log(`session ${m.session_id} model=${m.model} mode=${m.permissionMode}`);
        } else if (m.subtype === 'api_retry') {
          this.setStatus(true, `Waiting on the API (try ${m.attempt} of ${m.max_retries})`);
        } else if (m.subtype === 'status' && (m as any).status === 'compacting') {
          this.setStatus(true, 'Compacting the conversation');
        }
        return;
      case 'assistant': {
        const sub = m.parent_tool_use_id !== null;
        if (m.error && NOTICE[m.error]) {
          this.store.add({ kind: 'notice', text: NOTICE[m.error] });
          return;
        }
        for (const b of m.message.content) {
          if (b.type === 'text' && !sub && b.text.trim()) {
            this.store.add({ kind: 'reply', text: b.text });
          } else if (b.type === 'tool_use') {
            const input = (b.input ?? {}) as Record<string, any>;
            const t = title(b.name, input);
            this.store.add({ kind: 'step', ref: b.id, tool: b.name, title: t, detail: detail(b.name, input), ...(sub ? { sub: true } : {}) });
            this.setStatus(true, t);
          } else if (b.type === 'thinking' && !sub) {
            this.setStatus(true, 'Thinking');
          }
        }
        return;
      }
      case 'user': {
        const content = m.message.content;
        // A stop rejects the running step, which isn't a failure worth showing.
        if (!Array.isArray(content) || this.stopping) return;
        for (const b of content as any[]) {
          if (b.type === 'tool_result' && b.is_error) {
            const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c.text ?? '').join('\n');
            this.store.add({ kind: 'failed', ref: b.tool_use_id, text: clip(text.replace(/<\/?tool_use_error>/g, ''), 600) });
          }
        }
        return;
      }
      case 'auth_status':
        if (m.error) this.store.add({ kind: 'notice', text: NOTICE.authentication_failed });
        return;
      case 'result': {
        const stopped = this.stopping;
        this.stopping = false;
        this.unanswered = [];
        const ok = m.subtype === 'success' && !m.is_error;
        this.store.add({ kind: 'done', ok, stopped, ms: m.duration_ms, ...(ok || stopped ? {} : { error: clip(('errors' in m ? m.errors : []).join('; ') || m.subtype, 300) }) });
        this.state.open = null;
        this.save();
        this.setStatus(false);
        return;
      }
    }
  }

  private ask(name: string, input: Record<string, unknown>, o: { signal: AbortSignal; toolUseID: string; title?: string; description?: string }): Promise<PermissionResult> {
    if (name === 'mcp__lab__send_to_phone') return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const ref = o.toolUseID;
    this.store.add({ kind: 'ask', ref, tool: name, title: o.title ?? `Allow: ${title(name, input as any)}?`, detail: o.description ?? detail(name, input as any) }, true);
    const was = this.status.label;
    this.setStatus(true, 'Waiting for you');
    return new Promise((done) => {
      const timer = setTimeout(() => finish(false, 'timeout'), 60 * 60 * 1000);
      const finish = (allow: boolean, by: string) => {
        if (!this.asks.delete(ref)) return;
        clearTimeout(timer);
        this.store.add({ kind: 'answered', ref, allow, by });
        if (this.status.working) this.setStatus(true, allow ? was : 'Carrying on without it');
        done(allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: by === 'phone' ? 'He said no from his phone. Do not try another way around it, ask him what he wants instead.' : by === 'timeout' ? 'Nobody answered for an hour, so it was not allowed. Mention it in your reply.' : 'He stopped the task.' });
      };
      this.asks.set(ref, finish);
      o.signal.addEventListener('abort', () => finish(false, 'stop'), { once: true });
    });
  }

  private async sendFile(path: string, caption?: string) {
    const src = resolve(path);
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
    if (!existsSync(src) || !statSync(src).isFile()) return fail(`There is no file at ${src}.`);
    const size = statSync(src).size;
    if (size > 100 * 1024 * 1024) return fail(`${src} is ${Math.round(size / 1048576)} MB and the limit is 100 MB.`);
    const name = `${randomUUID().slice(0, 8)}-${basename(src).replace(/[^\w.\- ]+/g, '_')}`;
    copyFileSync(src, join(this.filesDir, name));
    this.store.add({ kind: 'file', name: basename(src), url: `/files/${encodeURIComponent(name)}`, size, ...(caption ? { caption } : {}) });
    return { content: [{ type: 'text' as const, text: `Sent ${basename(src)} to his phone.` }] };
  }

  // A file from his phone, saved next to the ones the agent sends him so the
  // phone can show both the same way.
  async upload(name: string, type: string, body: AsyncIterable<Buffer>): Promise<Attached> {
    const clean = basename(name).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
    const stored = `${randomUUID().slice(0, 8)}-${clean}`;
    const out = join(this.filesDir, stored);
    let size = 0;
    const fd = openSync(out + '.part', 'w');
    try {
      for await (const chunk of body) {
        size += chunk.length;
        if (size > 100 * 1024 * 1024) throw new Error(`${clean} is over the 100 MB limit.`);
        writeSync(fd, chunk);
      }
    } catch (e) {
      closeSync(fd);
      rmSync(out + '.part', { force: true });
      throw e;
    }
    closeSync(fd);
    renameSync(out + '.part', out);
    return { name: clean, url: `/files/${encodeURIComponent(stored)}`, size, type };
  }

  // Checks attachments named in a /send against what was actually uploaded.
  attached(files: unknown): Attached[] {
    if (!Array.isArray(files) || files.length > 20) throw new Error('A message can carry up to 20 files.');
    return files.map((f: any) => {
      const p = typeof f?.url === 'string' && f.url.startsWith('/files/') ? this.fileFor(decodeURIComponent(f.url.slice(7))) : null;
      if (!p) throw new Error(`${JSON.stringify(f?.url)} isn't a file uploaded to this Mac.`);
      return { name: clip(String(f.name ?? basename(p)), 120), url: f.url, size: statSync(p).size, type: clip(String(f.type ?? 'application/octet-stream'), 100) };
    });
  }

  fileFor(name: string): string | null {
    const p = join(this.filesDir, basename(name));
    return existsSync(p) ? p : null;
  }
}
