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
});

test('schedules run once, on their days, within the grace window', () => {
  const items = cleanSchedules([
    { id: 'daily', label: 'Morning', text: 'Weather', time: '08:00' },
    { id: 'weekdays', label: 'Inbox', text: 'Check mail', time: '08:00', days: ['Mon', 'tue', 'wed', 'thu', 'fri'] },
    { id: 'once', label: 'Dentist', text: 'Remind me', time: '23:50', date: '2026-11-07' },
    { label: 'Bad', text: 'x', time: '8am' },
    { label: 'Bad days', text: 'x', time: '08:00', days: ['weekdays'] },
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
