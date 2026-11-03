// settings.json in his Lab folder. The phone's Settings sheet writes it and
// the agent can edit it by hand, so a key the server doesn't know is kept as
// long as it holds a plain value. That way a new setting in the app needs no
// change here.
export const SIZES = ['small', 'wide', 'long', 'big'] as const;
export type Size = typeof SIZES[number];
export type Widget = { id: string; size: Size };
export type Settings = { topBar: Widget[]; [k: string]: unknown };

export const DEFAULTS: Settings = {
  topBar: [{ id: 'status', size: 'small' }, { id: 'battery', size: 'small' }, { id: 'storage', size: 'wide' }],
  topBarHidden: false,
  theme: 'system',
  textSize: 100,
  steps: 'live',
  times: true,
  enterSends: false,
  chips: true,
  digest: true,
  motion: 'full',
  model: null,
};

export function cleanSettings(v: unknown): Settings | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Settings = { ...DEFAULTS };
  for (const [k, x] of Object.entries(v).slice(0, 100)) {
    if (k === 'topBar') {
      if (!Array.isArray(x)) continue;
      const seen = new Set<string>();
      out.topBar = x.filter((w) => typeof w?.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(w.id) && !seen.has(w.id) && seen.add(w.id))
        .slice(0, 16)
        .map((w) => ({ id: w.id, size: SIZES.includes(w.size) ? w.size : 'small' }));
      continue;
    }
    if (!/^[a-z][a-z0-9]{0,39}$/i.test(k)) continue;
    if (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= 200)) out[k] = x;
  }
  return out;
}
