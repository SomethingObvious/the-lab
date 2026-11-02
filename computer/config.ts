import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const home = () => process.env.LAB_HOME ?? join(homedir(), 'TheLab');

export type Config = { token: string; port: number };

// Created once on first start. The token is what the phone was paired with,
// so it is never regenerated on its own.
export function config(): Config {
  const dir = join(home(), '.lab');
  const file = join(dir, 'config.json');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ token: randomBytes(32).toString('base64url'), port: 8417 }, null, 2), { mode: 0o600 });
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
