// memory.md is loaded into every conversation, so it is kept small, split
// into what the agent knows about him and its own working notes, and checked
// for lines that read like someone planting instructions.

export const CAP = 3500;
export const ABOUT = '## About the Owner';
export const NOTES = '## Notes';

export type Memory = { about: string[]; notes: string[] };

export function parse(text: string): Memory {
  const m: Memory = { about: [], notes: [] };
  let into: string[] = m.notes;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^##\s/.test(line)) { into = /about|owner|him\b|you\b/i.test(line) ? m.about : m.notes; continue; }
    if (!line || /^#\s/.test(line) || /^<!--.*-->$/.test(line)) continue;
    into.push(line.replace(/^[-*]\s+/, ''));
  }
  return m;
}

export function render(m: Memory): string {
  const list = (items: string[]) => items.map((s) => `- ${s.replace(/\n+/g, ' ').trim()}`).join('\n');
  return `# Memory\n\n${ABOUT}\n\n${list(m.about)}${m.about.length ? '\n' : ''}\n${NOTES}\n\n${list(m.notes)}${m.notes.length ? '\n' : ''}`;
}

// Zero-width spaces, direction marks and tag characters, which can hide text from him.
const HIDDEN = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff], [0xad, 0xad], [0xe0000, 0xe007f]];
const hidden = (s: string) => [...s].some((c) => { const n = c.codePointAt(0)!; return HIDDEN.some(([a, b]) => n >= a && n <= b); });
const ADDRESS = /[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/\S+/;
const STANDING = /\b(always|whenever|every time|from now on|each time|automatically)\b/i;
const OUTWARD = /\b(send|forward|email|upload|post|share|transfer|wire|pay|copy)\b/i;
const OVERRIDE = /\b(ignore|disregard|override|forget)\b.{0,40}\b(instructions?|rules?|previous|above|system|claude\.md|agents\.md)\b/i;
const HUSH = /\b(do not|don't|never)\s+(tell|mention|show|ask|notify|let)\b.{0,20}\b(him|the owner|the user|anyone)\b/i;
const KEYS = /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[po]_[A-Za-z0-9]{30,}|xox[abp]-[\w-]+|-----BEGIN [A-Z ]*PRIVATE KEY)/;

// Why a line looks planted, or null if it reads like an ordinary note.
export function suspect(line: string): string | null {
  if (hidden(line)) return 'it has hidden characters in it';
  if (KEYS.test(line)) return 'it looks like a password or key';
  if (OVERRIDE.test(line)) return 'it tells the agent to ignore its instructions';
  if (HUSH.test(line)) return 'it tells the agent to keep something from you';
  if (STANDING.test(line) && OUTWARD.test(line) && ADDRESS.test(line)) return 'it sets up sending things to an address';
  return null;
}

// The lines added and taken out between `before` and `after`.
export function diff(before: Memory, after: Memory) {
  const all = (m: Memory) => [...m.about, ...m.notes];
  const was = new Set(all(before)), now = new Set(all(after));
  return { added: all(after).filter((l) => !was.has(l)), removed: all(before).filter((l) => !now.has(l)) };
}
