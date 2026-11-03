// Runs the conversation through Codex instead of Claude, for someone whose
// plan is ChatGPT. It talks to `codex app-server` over stdio, which is the
// one Codex interface with approval requests, and maps its items onto the
// same events the phone already draws.
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { clip, title } from './steps.ts';
import type { Lab } from './lab.ts';

type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string; code?: number } };

const NOTICE: Record<string, string> = {
  unauthorized: 'The Mac is signed out of ChatGPT. Open the Codex app on the Mac and sign in, then send your message again.',
  usageLimitExceeded: 'The ChatGPT plan hit its usage limit for now. It will carry on once the limit resets.',
};

// The npm package's launcher picks the right native binary for this Mac.
export const codexBin = () => process.env.LAB_CODEX_BIN ?? createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');

// `bash -lc '...'` is how every command arrives, which is noise on a phone.
export function unwrap(command: string): string {
  const m = /^(?:\S*\/)?(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(command.trim());
  return m ? m[2].replace(/'\\''/g, "'") : command;
}

// One line for a command item, from Codex's own parse of it where it has one.
export function commandTitle(item: { command: string; commandActions?: any[] }): string {
  const acts = item.commandActions ?? [];
  if (acts.length === 1) {
    const a = acts[0];
    if (a.type === 'read') return title('Read', { file_path: a.path ?? a.name });
    if (a.type === 'listFiles') return `Looking in ${a.path ? title('Read', { file_path: a.path }).slice(8) : 'the folder'}`;
    if (a.type === 'search' && a.query) return title('Grep', { pattern: a.query });
  }
  const cmd = unwrap(item.command);
  const send = /^(?:cp|mv)\s+(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)\s+\S*to-phone\/?\S*$/.exec(cmd);
  if (send) return title('mcp__lab__send_to_phone', { path: send[1].replace(/^["']|["']$/g, '') });
  return clip(cmd, 80);
}

export class Codex {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private next = 1;
  private pending = new Map<number, { ok: (r: any) => void; fail: (e: Error) => void }>();
  private turn: string | null = null;
  private started = 0;
  private queue: { text: string; images: string[]; you: number }[] = [];
  private starting: Promise<void> | null = null;
  private taken = 0;
  private lastError: Error | null = null;
  private seen = new Map<string, { tool: string; title: string; detail: string }>();

  private lab: Lab;
  private home: string;
  private prompt: string;
  private model?: string;

  constructor(lab: Lab, home: string, prompt: string, model?: string) {
    this.lab = lab;
    this.home = home;
    this.prompt = prompt;
    this.model = model;
  }

  // `you` is the id of his message's event, so the turn's done can say which
  // messages it answered.
  send(text: string, images: string[], you: number) {
    this.queue.push({ text, images, you });
    this.pump().catch((e) => this.broke(e));
  }

  close() {
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }

  async stop() {
    this.queue = [];
    await this.starting?.catch(() => {});
    if (this.turn && this.lab.state.threadId) {
      await this.call('turn/interrupt', { threadId: this.lab.state.threadId, turnId: this.turn }).catch(() => {});
      return;
    }
    // Stopped before a turn began, so nothing else will end it.
    this.lab.store.add({ kind: 'done', ok: false, stopped: true, ms: 0 });
    this.lab.state.open = null;
    this.lab.save();
    this.lab.setStatus(false);
  }

  private input({ text, images }: { text: string; images: string[] }) {
    return [{ type: 'text', text, text_elements: [] }, ...images.map((path) => ({ type: 'localImage', path }))];
  }

  private async pump() {
    if (!this.queue.length) return;
    await this.start();
    // A turn still being started has no id to steer into yet. This must not
    // await when nothing is starting, or a second message slips in between.
    while (this.starting) await this.starting.catch(() => {});
    const threadId = this.lab.state.threadId!;
    // A message sent mid-task joins the running turn, the same as with
    // Claude. If it can't, it waits for the turn to end.
    if (this.turn) {
      const m = this.queue[0];
      if (!m) return;
      const steered = await this.call('turn/steer', { threadId, input: this.input(m), expectedTurnId: this.turn }).then(() => true, () => false);
      if (steered) { this.queue.shift(); this.taken = m.you; }
      return;
    }
    const m = this.queue.shift();
    if (!m) return;
    this.turn = 'starting';
    this.started = Date.now();
    this.starting = this.call('turn/start', {
      threadId,
      input: this.input(m),
      cwd: this.home,
      approvalPolicy: 'on-request',
      // He uses it to do things across his home folder, the way the Claude
      // side works. The instructions send anything destructive through an
      // escalation, which comes to the phone as an Allow and Deny.
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [homedir()], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      ...(this.model ? { model: this.model } : {}),
    }).then((r) => {
      if (this.turn === 'starting') this.turn = r.turn.id;
      this.taken = m.you;
    }, (e) => { this.turn = null; throw e; }).finally(() => { this.starting = null; });
    await this.starting;
  }

  private start(): Promise<void> {
    this.ready ??= (async () => {
      const proc = spawn(process.execPath, [codexBin(), 'app-server'], { cwd: this.home, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      proc.stderr!.on('data', (d) => process.stderr.write(d));
      createInterface({ input: proc.stdout! }).on('line', (line) => {
        let m: Msg;
        try { m = JSON.parse(line); } catch { return; }
        this.take(m);
      });
      proc.on('exit', (code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = null;
        for (const p of this.pending.values()) p.fail(new Error(`codex app-server exited (${code})`));
        this.pending.clear();
        if (this.turn) this.finish({ status: 'failed', error: { message: `Codex quit partway through (exit ${code}).` } });
      });
      await this.call('initialize', { clientInfo: { name: 'the_lab', title: 'The Lab', version: '1.0.0' }, capabilities: null });
      this.write({ method: 'initialized', params: {} });
      const acct = await this.call('account/read', { refreshToken: false });
      if (!acct.account && acct.requiresOpenaiAuth) throw new Error(NOTICE.unauthorized);
      const instructions = `${this.prompt} Your notes about him are in memory.md in the working directory, so read it at the start of a conversation and keep it up to date. Before any command that deletes or overwrites his files, sends or shares anything outside this Mac, or changes system settings, run it with sandbox_permissions set to require_escalated and a justification he'll understand in one short sentence, so he gets Allow and Deny on his phone first.`;
      const opts = { cwd: this.home, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: instructions, ...(this.model ? { model: this.model } : {}) };
      const saved = this.lab.state.threadId;
      const r = saved
        ? await this.call('thread/resume', { threadId: saved, excludeTurns: true, ...opts }).catch(() => null)
        : null;
      if (saved && !r) this.lab.store.add({ kind: 'notice', text: 'The last conversation could not be reopened, so this is a fresh one.' });
      const thread = r ?? await this.call('thread/start', { ...opts, serviceName: 'the_lab' });
      this.lab.state.threadId = thread.thread.id;
      this.lab.save();
      console.log(`codex thread ${thread.thread.id} model=${thread.model}`);
    })().catch((e) => { this.ready = null; this.proc?.kill(); throw e; });
    return this.ready;
  }

  private write(m: Msg) { this.proc?.stdin!.write(JSON.stringify(m) + '\n'); }

  private call(method: string, params: unknown): Promise<any> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.write({ id, method, params });
    });
  }

  // Something failed before a turn could even start, like a sign-in.
  private broke(e: Error) {
    // Every message waiting on a failed start rejects with the same error.
    if (e === this.lastError) return;
    this.lastError = e;
    console.error('codex:', e.message);
    this.lab.store.add({ kind: 'notice', text: Object.values(NOTICE).includes(e.message) ? e.message : `Codex couldn't start (${clip(e.message, 160)}). Send your message again in a minute.` });
    this.queue = [];
    this.lab.store.add({ kind: 'done', ok: false, stopped: false, ms: 0, error: clip(e.message, 300) });
    this.lab.state.open = null;
    this.lab.save();
    this.lab.setStatus(false);
  }

  private take(m: Msg) {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(Number(m.id));
      this.pending.delete(Number(m.id));
      if (m.error) p?.fail(new Error(m.error.message));
      else p?.ok(m.result);
      return;
    }
    if (m.id !== undefined) { this.request(m.id, m.method!, m.params ?? {}); return; }
    const p = m.params ?? {};
    switch (m.method) {
      case 'turn/started': if (this.turn === 'starting') this.turn = p.turn.id; return;
      case 'item/started': return this.begin(p.item);
      case 'item/completed': return this.completed(p.item);
      case 'turn/completed': return this.finish(p.turn);
      case 'error':
        if (p.willRetry) this.lab.setStatus(true, 'Waiting on the API');
        return;
    }
  }

  private step(ref: string, tool: string, t: string, detail: string) {
    this.seen.set(ref, { tool, title: t, detail });
    this.lab.store.add({ kind: 'step', ref, tool, title: t, detail });
    this.lab.setStatus(true, t);
  }

  private begin(item: any) {
    switch (item.type) {
      case 'commandExecution': return this.step(item.id, 'Bash', commandTitle(item), unwrap(item.command));
      case 'fileChange': {
        const paths: string[] = item.changes.map((c: any) => c.path);
        const t = paths.length === 1 ? title('Edit', { file_path: paths[0] }) : `Editing ${paths.length} files`;
        return this.step(item.id, 'Edit', t, clip(item.changes.map((c: any) => `${c.path}\n${c.diff}`).join('\n\n'), 4000));
      }
      case 'mcpToolCall': {
        const tool = `mcp__${item.server}__${item.tool}`;
        return this.step(item.id, tool, title(tool, item.arguments ?? {}), clip(JSON.stringify(item.arguments ?? {}, null, 2), 4000));
      }
      case 'reasoning': return this.lab.setStatus(true, 'Thinking');
      case 'contextCompaction': return this.lab.setStatus(true, 'Compacting the conversation');
    }
  }

  private completed(item: any) {
    switch (item.type) {
      case 'agentMessage':
        // Commentary is Codex talking to itself between steps, so it goes in
        // the toolbar rather than becoming a reply he gets notified about.
        if (item.phase === 'commentary') { if (item.text?.trim()) this.lab.setStatus(true, clip(item.text.trim(), 80)); }
        else if (item.text?.trim()) this.lab.store.add({ kind: 'reply', text: item.text });
        return;
      // The query is only filled in once the search has run.
      case 'webSearch': {
        const q = item.query || item.action?.query || item.action?.url || '';
        if (q) this.step(item.id, 'WebSearch', title('WebSearch', { query: q }), q);
        return;
      }
      case 'commandExecution':
        if (item.status === 'failed') this.lab.store.add({ kind: 'failed', ref: item.id, text: clip(item.aggregatedOutput?.trim() || `It exited with code ${item.exitCode}.`, 600) });
        return;
      case 'fileChange':
        if (item.status === 'failed') this.lab.store.add({ kind: 'failed', ref: item.id, text: "The change couldn't be applied." });
        return;
      case 'mcpToolCall':
        if (item.status === 'failed') this.lab.store.add({ kind: 'failed', ref: item.id, text: clip(item.error?.message ?? 'The tool call failed.', 600) });
        return;
    }
  }

  private finish(turn: { status: string; durationMs?: number | null; error?: { message: string; codexErrorInfo?: unknown } | null }) {
    const stopped = turn.status === 'interrupted';
    const ok = turn.status === 'completed';
    const info = typeof turn.error?.codexErrorInfo === 'string' ? turn.error.codexErrorInfo : '';
    if (NOTICE[info]) this.lab.store.add({ kind: 'notice', text: NOTICE[info] });
    this.lab.store.add({ kind: 'done', ok, stopped, ms: turn.durationMs ?? Date.now() - this.started, ...(this.taken ? { upto: this.taken } : {}), ...(ok || stopped ? {} : { error: clip(turn.error?.message ?? 'It stopped without saying why.', 300) }) });
    this.turn = null;
    this.taken = 0;
    this.seen.clear();
    for (const finish of this.lab.asks.values()) finish(false, 'stop');
    this.lab.state.open = null;
    this.lab.save();
    this.lab.setStatus(false);
    if (this.queue.length) {
      this.lab.setStatus(true, 'Reading your message');
      this.pump().catch((e) => this.broke(e));
    }
  }

  // Approval requests from Codex, answered with his Allow or Deny.
  private async request(id: number | string, method: string, p: any) {
    const reply = (result: unknown) => this.write({ id, result });
    const ask = async (ref: string, tool: string, t: string, detail: string) => (await this.lab.waitFor(ref, tool, t, detail)).allow;
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const cmd = unwrap(p.command ?? '');
        // The reason is Codex's own plain-words justification. The command
        // stays in the detail, since a reason can be wrong.
        const t = p.reason ? clip(String(p.reason).replace(/[.?]\s*$/, ''), 100) : cmd ? commandTitle({ command: cmd, commandActions: p.commandActions ?? [] }) : 'Run a command';
        const allow = await ask(p.approvalId ?? p.itemId, 'Bash', `Allow: ${t}?`, cmd || p.reason || '');
        return reply({ decision: allow ? 'accept' : 'decline' });
      }
      case 'item/fileChange/requestApproval': {
        const s = this.seen.get(p.itemId);
        const allow = await ask(p.itemId, 'Edit', `Allow: ${s?.title ?? 'Changing files'}?`, [s?.detail, p.reason].filter(Boolean).join('\n\n'));
        return reply({ decision: allow ? 'accept' : 'decline' });
      }
      case 'item/permissions/requestApproval': {
        const allow = await ask(p.itemId, 'Bash', 'Allow: More access for this task?', [p.reason, JSON.stringify(p.permissions, null, 2)].filter(Boolean).join('\n\n'));
        const { network, fileSystem } = p.permissions ?? {};
        return reply({ permissions: allow ? { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) } : {}, scope: 'turn' });
      }
      case 'mcpServer/elicitation/request': {
        const allow = p.mode !== 'url' && await ask(`el-${id}`, `mcp__${p.serverName}__ask`, `Allow: ${clip(p.message ?? p.serverName, 80)}?`, p.message ?? '');
        return reply({ action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null });
      }
      default:
        // Multiple-choice questions and the rest have no surface on the phone,
        // so the agent falls back to asking in plain text.
        this.write({ id, error: { code: -32601, message: `${method} isn't supported by The Lab. Ask in plain text instead.` } });
    }
  }
}
