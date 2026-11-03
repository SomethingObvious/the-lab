import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Design } from './design.ts';
import { title } from './steps.ts';
import { parseBattery } from './mac.ts';
import { cleanSchedules, due } from './schedule.ts';

test('undo steps back through saved designs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-test-'));
  const app = join(root, 'app');
  const page = join(app, 'index.html');
  const seen: string[] = [];
  mkdirSync(app);
  writeFileSync(page, 'one');
  const design = new Design(app, join(root, 'history'), (v) => seen.push(v));
  const first = design.version;

  writeFileSync(page, 'two');
  await wait(1000);
  assert.equal(seen.length, 1);
  writeFileSync(join(app, 'extra.css'), 'b {}');
  await wait(1000);

  assert.equal(design.undo(), true);
  assert.equal(readFileSync(page, 'utf8'), 'two');
  assert.equal(existsSync(join(app, 'extra.css')), false);
  assert.equal(design.undo(), true);
  assert.equal(readFileSync(page, 'utf8'), 'one');
  assert.equal(design.version, first);
  assert.equal(design.undo(), false);
});

test('battery from pmset', () => {
  const laptop = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t82%; charging; 1:02 remaining present: true\n";
  assert.deepEqual(parseBattery(laptop), { percent: 82, charging: true });
  assert.deepEqual(parseBattery(laptop.replace('AC Power', 'Battery Power').replace('charging', 'discharging')), { percent: 82, charging: false });
  assert.equal(parseBattery("Now drawing from 'AC Power'\n"), null);
});

test('step titles', () => {
  assert.equal(title('Bash', { command: 'du -sh ~/Downloads', description: 'Measure Downloads' }), 'Measure Downloads');
  assert.equal(title('Read', { file_path: '/Users/me/notes.md' }), 'Reading notes.md');
  assert.equal(title('mcp__claude-in-chrome__navigate', { url: 'https://mail.google.com/x' }), 'Opening mail.google.com in Chrome');
  assert.equal(title('mcp__my_server__do_thing', {}), 'my server: do thing');
  assert.equal(title('mcp__claude_ai_Google_Calendar__list_events', {}), 'Google Calendar: list events');
  assert.equal(title('Read', { file_path: '/Users/me/TheLab/.lab/files/56a55ced-19.png' }), 'Reading 19.png');
  assert.equal(title('Read', { file_path: '/Users/me/56a55ced-19.png' }), 'Reading 56a55ced-19.png');
});

test('schedules run once, on their days, within the grace window', () => {
  const items = cleanSchedules([
    { id: 'daily', label: 'Morning', text: 'Weather', time: '08:00' },
    { id: 'weekdays', label: 'Inbox', text: 'Check mail', time: '08:00', days: ['Mon', 'tue', 'wed', 'thu', 'fri'] },
    { id: 'once', label: 'Dentist', text: 'Remind me', time: '23:50', date: '2026-11-07' },
    { label: 'Bad', text: 'x', time: '8am' },
    { label: 'Bad days', text: 'x', time: '08:00', days: ['weekdays'] },
    { label: 'Bad date', text: 'x', time: '17:00', date: 'Friday' },
  ])!;
  assert.deepEqual(items.map((s) => s.id), ['daily', 'weekdays', 'once']);
  const noId = [{ label: 'Lunch', text: 'Remind me to eat', time: '12:00' }];
  assert.equal(cleanSchedules(noId)![0].id, cleanSchedules(noId)![0].id);
  // 2026-11-07 is a Saturday.
  const sat = (h: number, m: number) => new Date(2026, 10, 7, h, m);
  assert.deepEqual(due(items, sat(7, 59), new Set()), []);
  assert.deepEqual(due(items, sat(8, 10), new Set()).map((r) => r.key), ['daily@2026-11-07T08:00']);
  assert.deepEqual(due(items, sat(8, 10), new Set(['daily@2026-11-07T08:00'])), []);
  assert.deepEqual(due(items, sat(8, 40), new Set()), []);
  assert.deepEqual(due(items, new Date(2026, 10, 8, 0, 5), new Set()).map((r) => r.key), ['once@2026-11-07T23:50']);
  assert.deepEqual(due(items, new Date(2026, 10, 9, 8, 0), new Set()).map((r) => r.key), ['daily@2026-11-09T08:00', 'weekdays@2026-11-09T08:00']);
});

// A stand-in for `codex app-server` that plays one turn: a command, an
// approval for a second one, then a reply.
const FAKE = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let turn = 0;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'account/read') return out({ id: m.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: 'thr_1' }, model: 'fake' } });
  if (m.method === 'turn/start') {
    turn++;
    out({ id: m.id, result: { turn: { id: 't' + turn, status: 'inProgress' } } });
    out({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'cat notes.md'", commandActions: [{ type: 'read', command: 'cat notes.md', name: 'notes.md', path: '/Users/me/notes.md' }] } } });
    out({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', status: 'failed', exitCode: 1, aggregatedOutput: 'No such file' } } });
    out({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c2', command: "/bin/zsh -lc 'rm -rf ~/Downloads/old'", commandActions: [{ type: 'unknown', command: 'rm -rf ~/Downloads/old' }] } } });
    return out({ id: 900, method: 'item/commandExecution/requestApproval', params: { itemId: 'c2', command: "/bin/zsh -lc 'rm -rf ~/Downloads/old'", reason: 'Deletes files' } });
  }
  if (m.id === 900) {
    out({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'Decision was ' + m.result.decision } } });
    return out({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed', durationMs: 1234, error: null } } });
  }
});
`;

test('codex turns map onto the phone events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-codex-'));
  const fake = join(root, 'fake.cjs');
  writeFileSync(fake, FAKE);
  process.env.LAB_CODEX_BIN = fake;
  const { Lab } = await import('./lab.ts');
  const lab = new Lab({ home: root, engine: 'codex' });
  const seen: any[] = [];
  lab.store.listen((e) => {
    seen.push(e);
    if (e.kind === 'ask') setTimeout(() => lab.answer(String(e.ref), true), 10);
  });
  lab.send('Tidy my Downloads', crypto.randomUUID());
  for (let i = 0; i < 100 && !seen.some((e) => e.kind === 'done'); i++) await wait(50);
  const pick = (kind: string) => seen.filter((e) => e.kind === kind);
  assert.deepEqual(pick('step').map((e) => [e.ref, e.title, e.detail]), [['c1', 'Reading notes.md', 'cat notes.md'], ['c2', 'rm -rf ~/Downloads/old', 'rm -rf ~/Downloads/old']]);
  assert.deepEqual(pick('failed').map((e) => e.text), ['No such file']);
  assert.equal(pick('ask')[0].title, 'Allow: Deletes files?');
  assert.equal(pick('ask')[0].detail, 'rm -rf ~/Downloads/old');
  assert.deepEqual(pick('reply').map((e) => e.text), ['Decision was accept']);
  assert.deepEqual(pick('done').map((e) => [e.ok, e.stopped, e.ms]), [[true, false, 1234]]);
  assert.equal(lab.state.threadId, 'thr_1');
  assert.equal(lab.status.working, false);
  lab.close();
});

// Answers turn/start late, accepts a steer into t1, and talks to itself
// once before the answer.
const SLOW = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let n = 0;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'account/read') return out({ id: m.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: 'thr_2' }, model: 'fake' } });
  if (m.method === 'turn/interrupt') return out({ id: m.id, result: {} });
  if (m.method === 'turn/start') {
    const id = 't' + ++n;
    return setTimeout(() => out({ id: m.id, result: { turn: { id, status: 'inProgress' } } }), 150);
  }
  if (m.method === 'turn/steer') {
    if (m.params.expectedTurnId !== 't' + n) return out({ id: m.id, error: { code: -32600, message: 'no such turn' } });
    out({ id: m.id, result: { turnId: 't' + n } });
    out({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a0', phase: 'commentary', text: 'Checking both folders' } } });
    out({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', phase: 'final_answer', text: 'Both done' } } });
    return out({ method: 'turn/completed', params: { turn: { id: 't' + n, status: 'completed', durationMs: 50, error: null } } });
  }
});
`;

async function codexLab(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'lab-codex-'));
  writeFileSync(join(root, 'fake.cjs'), script);
  process.env.LAB_CODEX_BIN = join(root, 'fake.cjs');
  const { Lab } = await import('./lab.ts');
  const lab = new Lab({ home: root, engine: 'codex' });
  const seen: any[] = [];
  lab.store.listen((e) => seen.push(e));
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await wait(50); };
  return { lab, seen, until, pick: (kind: string) => seen.filter((e) => e.kind === kind) };
}

test('codex folds a message sent while the turn starts into it', async () => {
  const { lab, seen, until, pick } = await codexLab(SLOW);
  lab.send('Tidy Downloads', crypto.randomUUID());
  lab.send('And the Desktop', crypto.randomUUID());
  await until(() => pick('done').length > 0);
  const yous = pick('you');
  assert.deepEqual(pick('done').map((e) => [e.ok, e.upto]), [[true, yous[1].id]]);
  assert.deepEqual(pick('reply').map((e) => e.text), ['Both done']);
  assert.ok(seen.some((e) => e.kind === 'status' && e.label === 'Checking both folders'));
  lab.close();
});

test('codex stop before a turn begins leaves it usable', async () => {
  const { lab, until, pick } = await codexLab(SLOW);
  lab.send('Tidy Downloads', crypto.randomUUID());
  await lab.stop();
  await until(() => pick('done').length > 0);
  await wait(400);
  assert.equal(pick('notice').length, 0);
  assert.equal(lab.status.working, false);
  lab.send('Tidy Downloads', crypto.randomUUID());
  lab.send('And the Desktop', crypto.randomUUID());
  await until(() => pick('reply').length > 0);
  assert.deepEqual(pick('reply').map((e) => e.text), ['Both done']);
  lab.close();
});

test('codex titles', async () => {
  const { commandTitle } = await import('./codex.ts');
  assert.equal(commandTitle({ command: "/bin/zsh -lc 'cp ~/Desktop/shot.png ~/TheLab/to-phone/'" }), 'Sending shot.png to your phone');
  assert.equal(commandTitle({ command: "/bin/zsh -lc 'du -sh ~/Downloads'" }), 'du -sh ~/Downloads');
});
