import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The agent's folder. Everything in it is the agent's to change.
export const home = () => process.env.LAB_HOME ?? join(homedir(), 'TheLab');
// The server's code, token, history and tools. It sits outside the agent's
// folder, so nothing the agent is let write can lower its own guard rails.
export const labDir = () => process.env.LAB_DIR ?? join(homedir(), '.thelab');

// `name` is what he renamed the computer to on his phone.
export type Config = { token: string; port: number; engine?: 'claude' | 'codex'; name?: string };

// Created once on first start. The token is what the phone was paired with,
// so it is never regenerated on its own.
export function config(): Config {
  const dir = labDir();
  const file = join(dir, 'config.json');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ token: randomBytes(32).toString('base64url'), port: 8417 }, null, 2), { mode: 0o600 });
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function setConfig(patch: Partial<Config>) {
  writeFileSync(join(labDir(), 'config.json'), JSON.stringify({ ...config(), ...patch }, null, 2), { mode: 0o600 });
}

export const WIN = process.platform === 'win32';
// Every sentence the server writes for him names a Mac. On Windows the same
// sentences name the PC and its Recycle Bin instead.
export const words = (s: string, win = WIN) => !win ? s : s
  .replace(/\bmacOS\b/g, 'Windows').replace(/\bMac\b/g, 'PC')
  .replace(/\bthe Trash\b/g, 'the Recycle Bin').replace(/\bTrash\b/g, 'Recycle Bin');
