import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Design } from './design.ts';
import { title } from './steps.ts';
import { parseBattery } from './mac.ts';

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
  assert.equal(title('mcp__my_server__do_thing', {}), 'my_server: do thing');
});
