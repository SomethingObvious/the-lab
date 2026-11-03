// Turns a tool call into the one-line title the phone shows, plus the raw
// detail it opens to.

// Files from his phone are stored as 8 hex characters, a dash and the real name.
const base = (p: unknown) => {
  const b = String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  return /[\\/]\.lab[\\/]files[\\/]/.test(String(p)) ? b.replace(/^[0-9a-f]{8}-/, '') : b;
};
const host = (u: unknown) => {
  try { return new URL(String(u)).host; } catch { return String(u ?? ''); }
};
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

type Input = Record<string, any>;

export function title(tool: string, input: Input): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return input.description || clip(String(input.command ?? ''), 80);
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `Editing ${base(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${base(input.notebook_path)}`;
    case 'Glob': return `Looking for ${input.pattern}`;
    case 'Grep': return `Searching files for "${clip(String(input.pattern ?? ''), 40)}"`;
    case 'WebSearch': return `Searching the web for "${clip(String(input.query ?? ''), 60)}"`;
    case 'WebFetch': return `Reading ${host(input.url)}`;
    case 'Agent':
    case 'Task': return `Handing off: ${input.description ?? 'a side task'}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList': return 'Updating the plan';
    case 'ToolSearch': return 'Finding the right tool';
    case 'Skill': return `Using the ${input.skill ?? input.command ?? ''} skill`.replace('  ', ' ');
    case 'Monitor': return input.description || 'Watching for a change';
    case 'mcp__lab__send_to_phone': return `Sending ${base(input.path)} to your phone`;
  }
  const chrome = tool.match(/^mcp__claude-in-chrome__(.+)$/);
  if (chrome) {
    if (chrome[1] === 'navigate' && input.url) return `Opening ${host(input.url)} in Chrome`;
    return `Chrome: ${chrome[1].replace(/_/g, ' ')}`;
  }
  const mcp = tool.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  // Claude's own connectors arrive as claude_ai_Google_Calendar and so on.
  if (mcp) return `${mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${mcp[2].replace(/_/g, ' ')}`;
  return tool;
}

export function detail(tool: string, input: Input): string {
  if (tool === 'Bash' || tool === 'PowerShell') return String(input.command ?? '');
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos.map((t: any) => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content}`).join('\n');
  }
  if (tool === 'Write') return `${input.file_path}\n\n${clip(String(input.content ?? ''), 2000)}`;
  if (tool === 'Edit') return `${input.file_path}\n\n- ${clip(String(input.old_string ?? ''), 900)}\n+ ${clip(String(input.new_string ?? ''), 900)}`;
  if (typeof input.file_path === 'string' && Object.keys(input).length === 1) return input.file_path;
  if (typeof input.url === 'string' && tool === 'WebFetch') return input.url;
  return clip(JSON.stringify(input, null, 2), 4000);
}
