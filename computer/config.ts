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
// `relay` is the tunnel relay's address, set by `node setup.ts relay`.
export type Config = { token: string; port: number; engine?: 'claude' | 'codex'; name?: string; relay?: string };

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
// sentences name the PC and its Recycle Bin instead. Only whole phrases are
// swapped, as the agent's text goes through here too and a file called
// Mac Notes.txt or a folder called Trash has to keep its name.
const END = String.raw`(?![\w/\\-]|\.\w)`;
const MAC = new RegExp(String.raw`\b(the|this|your|his|my|a|owner's|rebuilt) Mac(?=('s)?${END})`, 'gi');
const TRASH = new RegExp(String.raw`\bthe Trash${END}`, 'g');
const MACOS = new RegExp(String.raw`(?<![\w/\\.-])macOS${END}`, 'g');
export const words = (s: string, win = WIN) => !win ? s : s
  .replace(MACOS, 'Windows').replace(MAC, '$1 PC').replace(TRASH, 'the Recycle Bin');
