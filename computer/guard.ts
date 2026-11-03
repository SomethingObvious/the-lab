// Reads a tool call, never the agent's words about it, and says what it would
// do in plain terms: what it touches, whether it can be undone, whether
// anything leaves the computer, and whether it is never allowed at all. Every Allow
// card on the phone and every rule the server enforces is built from this, so
// an agent talked round by a web page or an email can't explain its way past it.
import { basename, dirname, posix, win32 } from 'node:path';

export type Effect = 'read' | 'change' | 'delete' | 'send' | 'system' | 'run';

export type Judgement = {
  effect: Effect;
  // A sentence in plain words, like "Move 3 items in Downloads to the Trash".
  plain: string;
  // Paths or hosts it acts on.
  touches: string[];
  // 'trash' and 'yes' can be put back by him, 'no' can't, null isn't known.
  undo: 'yes' | 'trash' | 'no' | null;
  // Something goes off this computer.
  leaves: boolean;
  // Set when the call is never allowed, whatever anyone says, with why.
  block?: string;
  // It deletes with rm or the like instead of the Trash.
  rm?: boolean;
  // It reads a password, key or token.
  secret?: boolean;
  // Where outside content it reads comes from.
  source?: string;
  // A path in it can't be known until it runs, like "$DIR/old".
  unsure?: boolean;
};

// `user` is the home folder, `home` the agent's Lab folder and `lab` the
// server's own folder.
export type Where = { user: string; home: string; lab: string; cwd?: string };

const READ = new Set(['ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'du', 'df', 'wc', 'stat', 'file', 'mdls', 'mdfind', 'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'date', 'cal', 'sw_vers', 'system_profiler', 'uname', 'whoami', 'id', 'hostname', 'uptime', 'ps', 'pgrep', 'lsof', 'jq', 'sort', 'uniq', 'cut', 'tr', 'awk', 'sed', 'tree', 'diff', 'cmp', 'md5', 'shasum', 'sha256sum', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'sleep', 'ioreg', 'pbpaste', 'say', 'afplay', 'cd', 'exit', 'wait', 'strings', 'xxd', 'od', 'hexdump', 'column', 'nl', 'fold', 'base64', 'bc', 'expr', 'seq', 'locale', 'sysctl', 'vm_stat', 'top', 'w', 'last', 'getconf', 'sips', 'plutil', 'pdftotext', 'exiftool', 'ffprobe', 'identify', 'printenv', 'set', 'export', 'source', '.', 'read', 'local', 'shift', 'return']);
const CHANGE = new Set(['mv', 'cp', 'ditto', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chflags', 'tee', 'install', 'zip', 'unzip', 'tar', 'gzip', 'gunzip', 'bzip2', 'xz', '7z', 'xattr', 'screencapture', 'convert', 'magick', 'ffmpeg', 'pandoc', 'textutil', 'qlmanage', 'iconutil', 'pbcopy', 'open', 'mkfifo', 'split', 'patch', 'rename', 'sqlite3', 'osascript', 'shortcuts']);
const DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'truncate']);
const SYSTEM = new Set(['reg', 'schtasks', 'sc', 'netsh', 'wmic', 'powercfg', 'setx', 'takeown', 'icacls', 'runas', 'rundll32', 'mshta', 'regsvr32', 'certutil', 'dism', 'sfc', 'net', 'cmdkey', 'su', 'launchctl', 'systemsetup', 'networksetup', 'softwareupdate', 'installer', 'killall', 'kill', 'pkill', 'shutdown', 'reboot', 'halt', 'nvram', 'dscl', 'chsh', 'crontab', 'tccutil', 'profiles', 'kextload', 'kextunload', 'fdesetup', 'diskutil', 'dd', 'mount', 'mount_apfs', 'umount', 'hdiutil', 'pmset', 'scutil', 'csrutil', 'spctl', 'tmutil', 'mas', 'port', 'systemextensionsctl', 'kmutil', 'bless', 'passwd', 'sysadminctl', 'dseditgroup', 'pfctl', 'mkfs', 'newfs', 'fsck', 'mdutil']);
const SEND = new Set(['scp', 'sftp', 'ssh', 'mail', 'sendmail', 'mutt', 'nc', 'ncat', 'netcat', 'telnet', 'ftp', 'socat']);
// Wrappers whose real command is the rest of the line.
const WRAP = new Set(['env', 'command', 'builtin', 'nohup', 'time', 'nice', 'exec', 'caffeinate', 'stdbuf', 'timeout', 'gtimeout', 'xcrun', 'sudo', 'doas']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh']);
// PowerShell and cmd names for things the lists above already cover, so a
// Remove-Item is judged exactly like an rm.
const ALIAS: Record<string, string> = {
  'remove-item': 'rm', ri: 'rm', del: 'rm', erase: 'rm', rd: 'rm',
  'copy-item': 'cp', copy: 'cp', cpi: 'cp', xcopy: 'cp', 'move-item': 'mv', move: 'mv', mi: 'mv', 'rename-item': 'mv', ren: 'mv', rni: 'mv',
  'new-item': 'touch', ni: 'touch', md: 'mkdir', 'set-content': 'tee', 'add-content': 'tee', 'out-file': 'tee', 'tee-object': 'tee', 'clear-content': 'tee',
  'expand-archive': 'unzip', 'compress-archive': 'zip', 'set-clipboard': 'pbcopy', clip: 'pbcopy',
  'get-childitem': 'ls', gci: 'ls', dir: 'ls', 'get-content': 'cat', gc: 'cat', 'select-string': 'grep', sls: 'grep', findstr: 'grep',
  'write-output': 'echo', 'write-host': 'echo', 'set-location': 'cd', sl: 'cd', chdir: 'cd', 'push-location': 'cd', pushd: 'cd', 'pop-location': 'popd', 'get-process': 'ps', gps: 'ps', tasklist: 'ps', where: 'which',
  'stop-process': 'kill', spps: 'kill', taskkill: 'kill', 'start-process': 'open', saps: 'open', start: 'open', 'invoke-item': 'open', ii: 'open',
  'invoke-expression': 'eval', iex: 'eval', iwr: 'invoke-webrequest', irm: 'invoke-restmethod', 'stop-computer': 'shutdown', 'restart-computer': 'reboot',
};
// The rest of PowerShell goes by its verb. Reading verbs pass, file verbs
// change files, and anything else that sets, stops or installs asks first.
const PS_READ = /^(get|test|select|measure|format|write|resolve|convertto|convertfrom|compare|sort|where|foreach|group|join|split|find|search|show|read|wait|import|out|add-type|new-object|new-variable|set-variable|clear-variable|remove-variable|set-strictmode|set-alias|clear-host|start-sleep|receive|trace|debug|use)(-|$)/;
const PS_SYSTEM = /^(set|enable|disable|install|uninstall|register|unregister|stop|restart|start|remove|clear|reset|update|add|grant|revoke|suspend|resume|publish|initialize|format|mount|dismount|repair|lock|unlock|block|unblock|protect|unprotect|invoke|new|rename|move|copy|export|send)-/;
// Names a command is known by, whatever folder or extension it was run from.
export const nameOf = (argv0: string) => { const raw = (argv0.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, ''); return ALIAS[raw] ?? raw; };
// Folders whose whole contents going would wreck the computer or his files.
const BIG = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Library', 'Applications', 'Public', 'Sites', 'Videos', 'AppData', 'OneDrive'];
const SYSTEM_DIRS = ['/', '/System', '/Library', '/Applications', '/Users', '/usr', '/bin', '/sbin', '/private', '/etc', '/var', '/opt', '/cores', '/Volumes', '/tmp', 'C:', 'C:/Windows', 'C:/Program Files', 'C:/Program Files (x86)', 'C:/ProgramData', 'C:/Users'];
const SECRET = /(\/\.ssh\/(id_|.*key)|\/\.aws\/credentials|\/\.netrc|\/\.gnupg\/|\/Keychains\/|\/\.config\/gh\/hosts|\/\.docker\/config\.json|\/Cookies(\.binarycookies)?$|\/Login Data$|\/\.npmrc$|\/\.pypirc$|\.pem$|\.p12$|\/\.env(\.\w+)?$|\/Microsoft\/(Credentials|Protect|Vault)\/)/i;
// Both NTFS and the computer's APFS ignore case, so every match here does too.
// tunnel.json holds the keys that would let it pose as this computer to the
// phone, which then hands over the token.
const TOKEN = /config\.json$|tunnel\.json$|password$|\.jks$/i;

type Seg = { argv: string[]; out: string[]; pipedIn: boolean; ps?: boolean };

// Splits a shell line into simple commands. Quotes are honoured, and
// $(...) and backticks count as command breaks, so a delete hidden inside
// one is still seen.
export function segments(line: string, ps = false): Seg[] {
  const segs: Seg[] = [];
  let argv: string[] = [], out: string[] = [], word: string | null = null, redirect = false, piped = false;
  // A lone brace opens or closes a group, but find's {} is just a word.
  const push = () => {
    if (!redirect && (word === '{' || word === '}')) { word = null; end(); return; }
    if (redirect) { if (word !== '/dev/null' && word!.toLowerCase() !== '$null') out.push(word!); redirect = false; }
    else argv.push(word!);
    word = null;
  };
  const end = (pipe = false) => {
    if (word !== null) push();
    if (argv.length) segs.push({ argv, out, pipedIn: piped, ps });
    argv = []; out = []; piped = pipe; redirect = false;
  };
  // The text of a $( ) or backtick span, which runs as its own line.
  const inner = (from: number, close: string) => {
    let depth = 1, j = from;
    for (; j < line.length; j++) {
      if (close === ')' && line[j] === '(') depth++;
      else if (line[j] === close && --depth === 0) break;
    }
    segs.push(...segments(line.slice(from, j), ps));
    return j;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '#' && word === null && (i === 0 || /[\s;|&(]/.test(line[i - 1]))) {
      const stop = ps && line[i - 1] === '<' ? line.indexOf('#>', i) : -1;
      i = stop >= 0 ? stop + 1 : (line.indexOf('\n', i) < 0 ? line.length : line.indexOf('\n', i) - 1);
      continue;
    }
    if (ps && c === '<' && line[i + 1] === '#') {
      if (word !== null) push();
      const stop = line.indexOf('#>', i);
      i = stop < 0 ? line.length : stop + 1;
      continue;
    }
    if (ps && (c === '{' || c === '}')) { end(); continue; }
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, j < 0 ? undefined : j);
      i = j < 0 ? line.length : j;
    } else if (c === '"') {
      let s = '';
      for (i++; i < line.length && line[i] !== '"'; i++) {
        // Inside bash double quotes a backslash only escapes these, so C:\Windows keeps its own.
        if (ps ? line[i] === '`' && i + 1 < line.length : line[i] === '\\' && '$`"\\\n'.includes(line[i + 1] ?? 'x')) s += line[++i];
        else if (!ps && line[i] === '`') i = inner(i + 1, '`');
        else if (line[i] === '$' && line[i + 1] === '(') i = inner(i + 2, ')');
        else s += line[i];
      }
      word = (word ?? '') + s;
    } else if (c === (ps ? '`' : '\\')) { word = (word ?? '') + (line[i + 1] ?? ''); i++; }
    else if (c === '$' && line[i + 1] === '(') { end(); i++; }
    else if ('`;\n()'.includes(c)) end();
    else if (c === '&') {
      if (line[i + 1] === '&') i++;
      else if (line[i - 1] === '>' || line[i + 1] === '>') continue;
      end();
    } else if (c === '|') { if (line[i + 1] === '|') { i++; end(); } else end(true); }
    else if (c === '>' || c === '<') {
      if (word !== null && /^\d$/.test(word)) word = null;
      else if (word !== null) push();
      if (line[i + 1] === '>') i++;
      if (line[i + 1] === '&') { i++; while (/\d|-/.test(line[i + 1] ?? '')) i++; continue; }
      if (c === '>') redirect = true;
      else { while (line[i + 1] === ' ') i++; while (i + 1 < line.length && !/[\s;|&]/.test(line[i + 1])) i++; }
    } else if (/\s/.test(c)) { if (word !== null) push(); }
    else word = (word ?? '') + c;
  }
  end();
  return segs;
}

// PowerShell's -Path:C:\x carries its value in the same word.
const args = (argv: string[]) => argv.slice(1).flatMap((a) => (/^-[a-z][\w-]*:./i.test(a) ? [a.slice(a.indexOf(':') + 1)] : a.startsWith('-') ? [] : [a]));
// Whether a word is a PowerShell parameter, which it binds by any unique prefix.
const param = (a: string, name: string, min = 1) => /^-[a-z]/i.test(a) && a.slice(1).split(':')[0].length >= min && name.startsWith(a.slice(1).split(':')[0].toLowerCase());
// A flag, whether on its own or bundled like -rf.
const has = (argv: string[], ...f: string[]) => argv.some((a) => f.includes(a) || (/^-[a-zA-Z]+$/.test(a) && f.some((x) => /^-[a-zA-Z]$/.test(x) && a.includes(x[1]))));
// Windows paths compare without case, the way NTFS treats them.
const fold = (p: string) => p.toLowerCase();
const same = (a: string, b: string) => fold(a) === fold(b);
const within = (p: string, dir: string) => { const a = fold(p), d = fold(dir).replace(/\/$/, ''); return a === d || a.startsWith(d + '/'); };
const hostOf = (u: string) => { try { return new URL(/^\w+:/.test(u) ? u : `https://${u}`).host; } catch { return ''; } };
// An address carrying a long query or path, which is how data gets smuggled
// out in a plain page load.
const smuggles = (u: string) => /[?#][^\s]{40,}|\/[A-Za-z0-9+/=_-]{60,}/.test(u);
const clip = (s: string) => (s.length > 60 ? s.slice(0, 59) + '…' : s);
const count = (k: number, one: string) => `${k} ${k === 1 ? one : one + 's'}`;

function expand(p: string, w: Where): { path: string; unsure: boolean } {
  const win = /^[a-z]:\//i.test(w.user);
  let s = p.replace(/^~(?=$|[\/\\])/, w.user).replace(/\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%/gi, w.user);
  // Git Bash writes C:\Users as /c/Users.
  if (win) s = s.replace(/\\/g, '/').replace(/^\/([a-z])(?=\/|$)/i, (_, d) => `${d.toUpperCase()}:`);
  const unsure = /\$|`|%\w+%/.test(s);
  const path = win ? win32 : posix;
  // resolve() also folds a .. in an absolute path, which the disk opens the same way.
  if (!unsure) s = path.resolve(w.cwd ?? w.home, s).replace(/\\/g, '/');
  return { path: s.replace(/(.)\/+$/, '$1'), unsure };
}

// The folder a path is in, in the words he'd use: "Downloads", or "your home folder".
export function place(p: string, w: Where): string {
  const big = (name: string) => BIG.find((b) => same(b, name));
  if (same(p, w.user) || same(dirname(p), w.user) && !big(basename(p))) return 'your home folder';
  if (same(dirname(p), w.user)) return big(basename(p))!;
  const top = p.slice(w.user.length + 1).split('/')[0];
  if (within(p, w.user) && big(top)) return big(top)!;
  return basename(dirname(p));
}

function protectedPath(p: string, w: Where): string | null {
  if (within(p, w.lab)) return 'The Lab keeps its own code, token and history there, and the agent may never change them.';
  const configs = [`${w.user}/.claude`, `${w.home}/.claude`, `${w.user}/.codex`, `${w.home}/.codex`];
  if (configs.some((d) => within(p, d)) && /settings(\.local)?\.json$|config\.toml$|\/rules(\/|$)|\/hooks(\/|$)|\.claude$|\.codex$/i.test(p)) return "That's the agent's own permission settings, which it may never change.";
  if (/com\.somethingobvious\.thelab\.plist$/i.test(p)) return "That's what starts The Lab with the computer, and the agent may never change it.";
  return null;
}

// What a delete of this path would take out, when that's more than a
// cleanup should ever reach. The Codex home-folder wipe in July 2026 was a
// cleanup like this.
function wipes(p: string, w: Where): string | null {
  const system = (d: string) => SYSTEM_DIRS.some((x) => same(x, d));
  if (same(p, w.user)) return 'your whole home folder';
  if (within(w.user, p) || system(p)) return `${p}, which macOS needs`;
  if (same(dirname(p), w.user) && BIG.some((b) => same(b, basename(p)))) return `your whole ${basename(p)} folder`;
  if (p.endsWith('/*') && (same(dirname(p), w.user) || system(dirname(p)))) return `everything in ${same(dirname(p), w.user) ? 'your home folder' : dirname(p)}`;
  return null;
}

const blank = (): Judgement => ({ effect: 'read', plain: '', touches: [], undo: null, leaves: false });

function deletion(cmd: string, sub: string, argv: string[], rest: string[], w: Where): Judgement {
  if (cmd === 'trash' && argv.includes('--restore')) {
    const back = rest.map((a) => expand(a, w).path);
    return { ...blank(), effect: 'change', undo: 'trash', touches: back, plain: back.length === 1 ? `Put ${basename(back[0])} back from the Trash` : `Put ${count(back.length, 'item')} back from the Trash` };
  }
  // cmd.exe parses trash.cmd's arguments again, and PowerShell hands a name
  // without spaces over unquoted, so a & in it would start a second command.
  if (cmd === 'trash' && /\.(cmd|bat)$/i.test(argv[0]) && rest.some((a) => /[&|^<>%!]/.test(a)))
    return { ...blank(), effect: 'delete', plain: 'Move something to the Trash', block: 'trash.cmd would misread a name with & | ^ < > % or ! in it. Rename it without that character first, then move it to the Trash.' };
  const trashing = cmd === 'trash' || cmd === 'mv' || (cmd === 'find' && /-exec(dir)?\s+(\S*\/)?trash\s/.test(argv.join(' ')));
  const targets = cmd === 'find' ? [rest[0] ?? '.'] : cmd === 'mv' ? rest.slice(0, -1) : cmd === 'git' || cmd === 'rsync' ? [rest.at(-1) ?? '.'] : cmd === 'robocopy' ? [rest[1] ?? '.'] : rest;
  const ps = targets.map((a) => expand(a, w));
  const known = ps.filter((p) => !p.unsure);
  const j: Judgement = { ...blank(), effect: 'delete', touches: ps.map((p) => p.path), undo: trashing ? 'trash' : 'no', rm: !trashing, unsure: known.length < ps.length || cmd === 'find' || cmd === 'git' };
  // A find that picks files by name, age or size only takes those.
  const picks = cmd === 'find' && argv.some((a) => /^-(i?name|i?path|i?regex|mtime|mmin|atime|ctime|newer|size|type|empty|user)$/.test(a));
  for (const p of known) {
    const lost = picks ? null : wipes(p.path, w);
    if (lost && !j.block) { j.block = `That would delete ${lost}. That's never allowed.`; j.plain = `Delete ${lost}`; return j; }
    j.block ??= /\/(\.Trash|\$Recycle\.Bin)(\/|$)/i.test(p.path) && !trashing ? 'Emptying the Trash takes away your undo, so only you do that.' : undefined;
    j.block ??= protectedPath(p.path, w) ?? undefined;
  }
  const where = [...new Set(known.map((p) => place(p.path, w)))];
  const what = known.length === 1 ? basename(known[0].path) : count(known.length || targets.length, 'item');
  const inPlace = where.length === 1 && known.length > 1 ? ` in ${where[0]}` : '';
  if (cmd === 'find') j.plain = trashing ? `Move matching files in ${place(ps[0].path, w)} to the Trash` : `Delete matching files in ${place(ps[0].path, w)}`;
  else if (cmd === 'git') j.plain = sub === 'clean' ? "Delete files git isn't tracking" : "Throw away changes git hasn't saved";
  else if (!known.length) j.plain = trashing ? 'Move something to the Trash' : 'Permanently delete something';
  else j.plain = trashing ? `Move ${what}${inPlace} to the Trash` : `Permanently delete ${what}${inPlace}`;
  return j;
}

// Judges one simple command.
function command(seg: Seg, w: Where): Judgement {
  let argv = seg.argv;
  let sudo = false;
  // $x = Get-ChildItem runs what's on the right.
  if (seg.ps && /^\$[\w:]+$/.test(argv[0] ?? '') && argv[1] === '=') argv = argv.slice(2);
  else if (seg.ps && /^\$[\w:]+=./.test(argv[0] ?? '')) argv = [argv[0].replace(/^\$[\w:]+=/, ''), ...argv.slice(1)];
  while (argv.length && (WRAP.has(basename(argv[0])) || /^\w+=/.test(argv[0]))) {
    if (argv[0] === 'sudo' || argv[0] === 'doas') sudo = true;
    const timed = /timeout$/.test(argv[0]);
    argv = argv.slice(1);
    while (argv[0]?.startsWith('-')) argv = argv.slice(argv[0] === '-u' || argv[0] === '-n' ? 2 : 1);
    if (timed && /^\d/.test(argv[0] ?? '')) argv = argv.slice(1);
  }
  const cmd = nameOf(argv[0] ?? '');
  const sub = argv[1] ?? '';
  const rest = args(argv);
  const line = argv.join(' ');
  const j = blank();
  if (!cmd) return j;

  if (SHELLS.has(cmd)) {
    const flag = argv.findIndex((a) => /^-\w*c$/.test(a));
    if (flag > 0) return judgeShell(argv[flag + 1] ?? '', w);
    if (seg.pipedIn) return { ...j, effect: 'system', plain: 'Run a script it just downloaded' };
  }
  if (cmd === 'powershell' || cmd === 'pwsh') {
    // Anything after the startup switches is the command, named or not.
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if ((param(a, 'encodedcommand') || /^-ec$/i.test(a)) && !param(a, 'executionpolicy', 2)) return judgeShell(Buffer.from(argv[i + 1] ?? '', 'base64').toString('utf16le'), w, true);
      if (param(a, 'command')) return judgeShell(argv.slice(i + 1).join(' '), w, true);
      if (/^-(executionpolicy|ex|ep|windowstyle|w|inputformat|outputformat|of|if|version|v|workingdirectory|wd|configurationname|settingsfile|file|f)$/i.test(a)) { i++; continue; }
      if (a.startsWith('-')) continue;
      return judgeShell(argv.slice(i).join(' '), w, true);
    }
  }
  if (cmd === 'cmd') {
    const at = argv.findIndex((a) => /^\/[ckr]/i.test(a));
    // A caret only escapes the next character, so r^d is rd.
    // cmd has no backslash escapes, which PowerShell's rules match best.
    if (at > 0) return judgeShell([argv[at].slice(2), ...argv.slice(at + 1)].join(' ').replace(/\^(.)/g, '$1'), w, true);
  }
  // Start-Process and cmd's start run whatever program they're given.
  if (cmd === 'open' && /^(start-process|saps|start)$/i.test(nameOf(argv[0]).length ? argv[0].split(/[\\/]/).pop()! : '')) {
    const words = argv.slice(1);
    const named = (n: string, min: number) => { const i = words.findIndex((a) => param(a, n, min)); return i < 0 ? undefined : words.splice(i, 2)[1]; };
    const listed = named('argumentlist', 1) ?? named('args', 2);
    named('verb', 2); named('workingdirectory', 2); named('windowstyle', 2);
    const file = named('filepath', 1) ?? words.find((a) => !a.startsWith('-') && !a.startsWith('/') && a !== '');
    if (file && !/^[a-z][\w+.-]*:\/\//i.test(file) && (!/\.\w+$/.test(file) || /\.(exe|cmd|bat|com|ps1)$/i.test(file))) {
      const inner = judgeShell([file, ...(listed !== undefined ? [listed.replace(/,(?=\S)/g, ' ')] : words.slice(words.indexOf(file) + 1))].join(' '), w, seg.ps);
      return RANK.indexOf(inner.effect) < RANK.indexOf('run') ? { ...inner, effect: 'run' } : inner;
    }
  }
  if (cmd === 'eval') return judgeShell(argv.slice(1).join(' '), w, seg.ps);
  // .NET calls delete for good, the same as rm.
  if (/^\[(system\.)?io\.(file|directory)(info)?\]::delete$|^\.delete$|::delete(file|directory)$/.test(cmd)) return { ...j, effect: 'delete', undo: 'no', rm: true, unsure: true, plain: 'Permanently delete something' };
  if (cmd === 'xargs') {
    const inner = command({ argv: argv.slice(1).filter((a) => !/^-/.test(a)), out: [], pipedIn: false, ps: seg.ps }, w);
    return { ...inner, unsure: true };
  }

  const deleting = DELETE.has(cmd)
    || (cmd === 'find' && (argv.includes('-delete') || /-exec(dir)?\s+(\S*\/)?(rm|unlink|shred|trash)\s/.test(argv.join(' '))))
    || (cmd === 'git' && (sub === 'clean' || (sub === 'reset' && argv.includes('--hard'))))
    || (cmd === 'rsync' && argv.some((a) => a.startsWith('--delete')))
    || (cmd === 'robocopy' && argv.some((a) => /^\/(mir|purge)$/i.test(a)));
  if (deleting || cmd === 'trash' || (cmd === 'mv' && rest.length >= 2 && /\.Trash\/?$/.test(rest.at(-1)!))) return deletion(cmd, sub, argv, rest, w);

  // Never allowed, whatever it's for.
  const never = (plain: string, block: string, effect: Judgement['effect'] = 'system') => ({ ...j, effect, plain, block });
  if (cmd === 'diskutil' && /^(erase|zero|secureErase|partition|reformat|resize)/i.test(sub)) return never('Erase a disk', 'Erasing or repartitioning a disk is never allowed.');
  if (cmd === 'diskutil' && sub === 'apfs' && /delete|erase/i.test(argv[2] ?? '')) return never('Erase a disk', 'Erasing or repartitioning a disk is never allowed.');
  if (/^(mkfs|newfs)/.test(cmd) || (cmd === 'dd' && /\bof=\/dev\//.test(line))) return never('Write straight to a disk', 'Writing straight to a disk is never allowed.');
  if (cmd === 'csrutil' && /disable/.test(line)) return never('Turn off System Integrity Protection', 'Turning off macOS security is never allowed.');
  if (cmd === 'spctl' && /--(master|global)-disable|--disable/.test(line)) return never('Turn off Gatekeeper', 'Turning off macOS security is never allowed.');
  if (cmd === 'tmutil' && /^(delete|deletelocalsnapshots|thinlocalsnapshots|disable|disablelocal|removedestination)/.test(sub)) return never('Delete Time Machine snapshots', 'Time Machine snapshots are how you undo a mistake, so they are never deleted or turned off.');
  if (cmd === 'osascript' && /empty\s+(the\s+)?trash/i.test(line)) return never('Empty the Trash', 'Emptying the Trash takes away your undo, so only you do that.', 'delete');
  if (['launchctl', 'pkill', 'killall', 'kill'].includes(cmd) && /thelab|server\.ts|\bnode(\.exe)?\b/i.test(line)) return never('Stop The Lab', 'The agent may never stop or change The Lab itself.');
  if (/thelab/i.test(line) && (/\\run\b|currentversion/i.test(line) || ['reg', 'schtasks', 'sc'].includes(cmd) || /-(itemproperty|scheduledtask)$/.test(cmd))) return never('Stop The Lab', 'The agent may never stop or change The Lab itself.');
  if ((cmd === 'vssadmin' && /delete|resize/i.test(line)) || (cmd === 'wmic' && /shadowcopy.*delete/i.test(line)) || (cmd === 'wbadmin' && /delete/i.test(line)) || cmd === 'remove-computerrestorepoint') return never('Delete restore points', 'Restore points and backups are how you undo a mistake, so they are never deleted.');
  if (['format', 'diskpart', 'clear-disk', 'format-volume', 'initialize-disk', 'remove-partition'].includes(cmd) || (cmd === 'cipher' && /\/w/i.test(line))) return never('Erase a disk', 'Erasing or repartitioning a disk is never allowed.');
  if (cmd === 'bcdedit' || (/^(set|add)-mppreference$/.test(cmd) && /-(disable|exclusion)/i.test(line)) || (cmd === 'set-executionpolicy' && /unrestricted|bypass/i.test(line))) return never('Turn off Windows security', 'Turning off Windows security is never allowed.');
  if (cmd === 'clear-recyclebin') return never('Empty the Recycle Bin', 'Emptying the Trash takes away your undo, so only you do that.', 'delete');
  if (cmd === 'chmod' && has(argv, '-R') && rest.some((a) => wipes(expand(a, w).path, w))) return never('Change permissions on everything', 'Changing permissions across the whole computer is never allowed.');

  // Anything naming The Lab's own folder or the agent's settings, other
  // than reading the log.
  const named = [...rest, ...seg.out].map((a) => expand(a, w)).filter((p) => !p.unsure);
  const readOnly = (READ.has(cmd) || (!!seg.ps && PS_READ.test(cmd))) && !seg.out.length && !(cmd === 'sed' && has(argv, '-i'));
  const owned = named.find((p) => protectedPath(p.path, w));
  if (owned && !readOnly) return { ...never(`Change ${basename(owned.path)}`, protectedPath(owned.path, w)!, 'change'), touches: [owned.path] };
  // Searching the whole folder reads the token as surely as naming it does.
  if (named.some((p) => within(p.path, w.lab) && (TOKEN.test(p.path) || same(p.path, w.lab)))) return { ...never("Read The Lab's token", 'The token that pairs your phone is never read by the agent.', 'read'), secret: true };
  const secret = named.find((p) => SECRET.test(p.path));

  // Sending.
  if (cmd === 'curl' || cmd === 'wget') {
    const url = rest.find((a) => /^https?:\/\//.test(a)) ?? rest.find((a) => /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(a) && !/\.(json|txt|html?|zip|png|jpe?g|csv|md|pdf|gz)$/.test(a)) ?? '';
    const host = hostOf(url);
    const upload = argv.some((a) => /^(-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(a)) || /(-X|--request)\s*(POST|PUT|PATCH|DELETE)/.test(line) || /-method\s+(post|put|patch|delete)|-(body|infile|form)\b/i.test(line);
    if (upload) {
      const file = argv.includes('-T') ? argv[argv.indexOf('-T') + 1] : argv.map((a) => /(?:^|=)@([^;\s]+)/.exec(a)?.[1]).find(Boolean);
      return { ...j, effect: 'send', leaves: true, touches: [host], undo: 'no', plain: file ? `Send ${basename(file)} to ${host}` : `Send data to ${host}` };
    }
    const saves = cmd === 'wget' || argv.some((a) => /^(-o|-O|--output|--remote-name)$/.test(a));
    return { ...j, effect: saves ? 'change' : 'read', touches: [host], source: `a web page on ${host}`, leaves: smuggles(url), plain: smuggles(url) ? `Open ${host} with data in the address` : `Download from ${host}` };
  }
  if (cmd === 'invoke-webrequest' || cmd === 'invoke-restmethod' || cmd === 'start-bitstransfer') {
    const url = argv.find((a) => /^https?:\/\//i.test(a)) ?? '';
    const host = hostOf(url);
    const m = argv.findIndex((a) => param(a, 'method', 2));
    const posts = (m > 0 && !/^(get|head|options)$/i.test(argv[m + 1] ?? '')) || argv.some((a) => param(a, 'body') || param(a, 'infile', 3) || param(a, 'form', 2) || param(a, 'headers', 2))
      || (cmd === 'start-bitstransfer' && /-transfertype\s+upload/i.test(line));
    if (posts) return { ...j, effect: 'send', leaves: true, touches: [host], undo: 'no', plain: `Send data to ${host}` };
    const saves = cmd === 'start-bitstransfer' || /-outfile\b/i.test(line);
    return { ...j, effect: saves ? 'change' : 'read', touches: [host], source: `a web page on ${host}`, leaves: smuggles(url), plain: smuggles(url) ? `Open ${host} with data in the address` : `Download from ${host}` };
  }
  if (cmd === 'send-mailmessage') return { ...j, effect: 'send', leaves: true, undo: 'no', plain: 'Send an email' };
  if (cmd === 'git' && sub === 'push') {
    const force = argv.some((a) => /^(-f|--force.*)$/.test(a)) || rest.some((a) => a.startsWith('+'));
    return { ...j, effect: 'send', leaves: true, undo: force ? 'no' : 'yes', touches: [rest[1] ?? 'origin'], plain: force ? "Force-push code, replacing what's online" : `Push code to ${rest[1] ?? 'origin'}` };
  }
  if (cmd === 'gh' && /^(pr|issue|release|gist|repo|api)$/.test(sub) && /\b(create|comment|edit|upload|delete|merge|close)\b|-X|--method/.test(line)) return { ...j, effect: 'send', leaves: true, undo: 'no', touches: ['github.com'], plain: `Post to GitHub (${argv.slice(1, 3).join(' ')})` };
  if (cmd === 'rsync' && rest.some((a) => /^[\w.-]+(@[\w.-]+)?:/.test(a))) return { ...j, effect: 'send', leaves: true, undo: 'no', touches: rest.filter((a) => a.includes(':')), plain: 'Copy files to another computer' };
  if (SEND.has(cmd)) {
    const host = (rest.find((a) => /[@:]/.test(a)) ?? rest[0] ?? '').split(':')[0];
    return { ...j, effect: 'send', leaves: true, undo: 'no', touches: [host], plain: cmd === 'ssh' ? `Run a command on ${host}` : /mail|mutt/.test(cmd) ? 'Send an email' : `Send files to ${host}` };
  }
  if ((cmd === 'aws' && /\bs3:\/\//.test(line) && /\b(cp|sync|mv)\b/.test(line)) || (cmd === 'rclone' && /^(copy|sync|move)$/.test(sub)) || (cmd === 'docker' && sub === 'push') || (cmd === 'npm' && sub === 'publish') || (cmd === 'twine' && sub === 'upload'))
    return { ...j, effect: 'send', leaves: true, undo: 'no', plain: `Upload with ${cmd} ${sub}` };
  if (cmd === 'open' && rest.some((a) => /^mailto:/.test(a))) return { ...j, effect: 'send', leaves: true, plain: 'Start an email' };
  if (cmd === 'osascript' && /\bsend\b/i.test(line) && /mail|messages|outlook/i.test(line)) return { ...j, effect: 'send', leaves: true, undo: 'no', plain: 'Send a message from the computer' };
  if (cmd === 'osascript' && /\b(delete|move\b.*\btrash)\b/i.test(line)) return { ...j, effect: 'delete', plain: 'Delete something with AppleScript' };
  if (cmd === 'osascript' && /do shell script|keystroke|administrator privileges/i.test(line)) return { ...j, effect: 'system', plain: 'Control the computer with AppleScript' };

  // Installing and settings.
  const installs = (cmd === 'brew' && /^(install|uninstall|reinstall|upgrade|remove|rm|tap|untap|services)$/.test(sub))
    || (cmd === 'npm' && /^(i|install|add|uninstall|remove|rm|update)$/.test(sub) && has(argv, '-g', '--global'))
    || (/^pip3?$|^pipx$/.test(cmd) && /^(install|uninstall)$/.test(sub)) || (cmd === 'gem' && sub === 'install')
    || ['mas', 'port', 'installer', 'softwareupdate', 'msiexec'].includes(cmd)
    || (/^(winget|choco|scoop)$/.test(cmd) && /^(install|uninstall|upgrade|remove|add)$/.test(sub))
    || /^(install|uninstall|update)-(module|package|script|psresource)$|^(add|remove)-appxpackage$/.test(cmd);
  if (installs) {
    const what = clip(rest.slice(1).join(' ') || sub);
    return { ...j, effect: 'system', undo: 'yes', plain: /^(uninstall|remove|rm)$/.test(sub) ? `Uninstall ${what}` : `Install ${what}${cmd === 'brew' ? ' with Homebrew' : ''}` };
  }
  if (cmd === 'defaults' && /^(write|delete|import|rename)$/.test(sub)) return { ...j, effect: 'system', undo: 'yes', plain: `Change a setting (${argv[2] ?? ''})` };
  const look = (plain: string) => ({ ...j, effect: 'read' as const, plain });
  if (cmd === 'defaults') return look('Check a setting');
  if (cmd === 'tmutil' && /^(localsnapshot|listlocalsnapshots|listlocalsnapshotdates|status|latestbackup|listbackups|destinationinfo|isexcluded|machinedirectory)$/.test(sub)) return look('Check Time Machine');
  if (cmd === 'pmset' && /^-g/.test(sub)) return look('Check power settings');
  if (cmd === 'launchctl' && /^(list|print|blame|version)$/.test(sub)) return look("Check what's running");
  if (cmd === 'diskutil' && /^(list|info|apfs)$/.test(sub)) return look('Check the disks');
  if (cmd === 'scutil' && sub === '--get') return look('Check a computer setting');
  if (cmd === 'networksetup' && /^-(get|list)/.test(sub)) return look('Check network settings');
  if (cmd === 'mdutil' && sub === '-s') return look('Check Spotlight');
  if (cmd === 'security' && /^(find-.*-password|dump-keychain|export)$/.test(sub)) return { ...look('Read a saved password from the keychain'), secret: true };
  if (cmd === 'security' && /^delete-/.test(sub)) return { ...j, effect: 'delete', undo: 'no', plain: 'Delete a saved password' };
  if (cmd === 'security') return look('Check the keychain');
  if ((cmd === 'reg' && /^query$/i.test(sub)) || (cmd === 'schtasks' && /^\/query$/i.test(sub)) || (cmd === 'sc' && /^(query|qc)/i.test(sub)) || (cmd === 'powercfg' && /^\/(l|list|q|query|a|availablesleepstates)$/i.test(sub)) || (cmd === 'netsh' && /\bshow\b/i.test(line))) return look('Check a Windows setting');
  if (cmd === 'cmdkey') return { ...look('Read saved passwords'), secret: true };
  if (cmd === 'open' && /-verb\s+runas/i.test(line)) return { ...j, effect: 'system', plain: `Run as administrator: ${clip(line)}` };
  if (sudo) return { ...j, effect: 'system', plain: `Run as administrator: ${clip(line)}` };
  if (SYSTEM.has(cmd)) {
    const plain = cmd === 'killall' || cmd === 'pkill' ? `Quit ${rest.join(', ')}` : cmd === 'kill' ? 'Stop a running program'
      : cmd === 'launchctl' ? 'Change what starts with the computer' : cmd === 'crontab' ? 'Schedule something to run by itself'
      : cmd === 'pmset' || cmd === 'powercfg' ? 'Change power settings' : /^(shutdown|reboot|halt)$/.test(cmd) ? 'Restart or shut down the computer'
      : cmd === 'schtasks' ? 'Schedule something to run by itself' : cmd === 'reg' ? 'Change a Windows setting'
      : `Change a system setting (${cmd})`;
    return { ...j, effect: 'system', plain };
  }

  if (secret) return { ...look(`Read ${basename(secret.path)}, which holds a password or key`), secret: true, touches: [secret.path] };
  if (cmd === 'sed' && has(argv, '-i')) return { ...j, effect: 'change', touches: named.map((p) => p.path), plain: `Edit ${basename(rest.at(-1) ?? '')}` };
  if (cmd === 'find') return look(`Look through ${place(expand(rest[0] ?? '.', w).path, w)}`);
  if (cmd === 'git' && /^(status|log|diff|show|branch|remote|rev-parse|ls-files|blame|config|fetch)$/.test(sub)) return look('Check git');
  if (READ.has(cmd)) {
    if (!seg.out.length) return j;
    const o = seg.out.map((a) => expand(a, w));
    return { ...j, effect: 'change', touches: o.map((p) => p.path), plain: `Write ${basename(o[0].path)}` };
  }
  if (cmd === 'git') return { ...j, effect: 'change', undo: 'yes', plain: `Run git ${sub}` };
  if (CHANGE.has(cmd)) {
    const to = rest.length > 1 && ['mv', 'cp', 'ditto', 'ln'].includes(cmd) ? [rest.at(-1)!] : rest;
    const o = [...to, ...seg.out].map((a) => expand(a, w).path);
    return { ...j, effect: 'change', touches: o, plain: cmd === 'mv' && rest.length >= 2 ? `Move ${rest.length > 2 ? count(rest.length - 1, 'item') : basename(rest[0])} to ${basename(rest.at(-1)!)}` : '' };
  }
  if (seg.ps && PS_READ.test(cmd)) return seg.out.length ? { ...j, effect: 'change', touches: seg.out.map((a) => expand(a, w).path), plain: `Write ${basename(seg.out[0])}` } : j;
  if (seg.ps && PS_SYSTEM.test(cmd)) return { ...j, effect: 'system', plain: `Change a system setting (${argv[0]})` };
  return { ...j, effect: seg.out.length ? 'change' : 'run', touches: seg.out.map((a) => expand(a, w).path) };
}

// Fork bombs don't parse as anything useful, so they're matched as text.
const BOMB = /(\w+|:)\s*\(\)\s*\{[^}]*\1\s*\|\s*\1\s*&/;
const RANK: Effect[] = ['read', 'run', 'change', 'system', 'delete', 'send'];

export function judgeShell(line: string, w: Where, ps = false): Judgement {
  if (BOMB.test(line)) return { ...blank(), effect: 'system', plain: 'Start a fork bomb', block: 'That would lock the computer up, so it is never allowed.' };
  // A cd carries to the commands after it, so relative paths land where they will.
  let cwd = w.cwd;
  const stack: (string | undefined)[] = [];
  const parts = segments(line, ps).map((s) => {
    const j = command(s, { ...w, cwd });
    const name = nameOf(s.argv[0]);
    if (name === 'cd') {
      if (/^pushd$|^push-location$/i.test(s.argv[0].split(/[\\/]/).pop()!)) stack.push(cwd);
      const to = args(s.argv.filter((a) => !/^\/d$/i.test(a)))[0];
      cwd = to ? expand(to, { ...w, cwd }).path : w.user;
    } else if (name === 'popd') cwd = stack.pop() ?? cwd;
    return j;
  });
  if (!parts.length) return blank();
  // The worst part speaks for the whole line, and a block anywhere blocks it.
  const worst = parts.reduce((a, b) => (RANK.indexOf(b.effect) > RANK.indexOf(a.effect) ? b : a));
  const out: Judgement = { ...worst, touches: [...new Set(parts.flatMap((p) => p.touches))] };
  out.block = parts.find((p) => p.block)?.block;
  out.rm = parts.some((p) => p.rm);
  out.secret = parts.some((p) => p.secret);
  out.leaves = parts.some((p) => p.leaves);
  out.unsure = parts.some((p) => p.unsure);
  out.source = parts.find((p) => p.source)?.source;
  const fetched = parts.find((p) => p.source && p.touches[0]);
  if (fetched && (/\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(line) || /\b(iex|invoke-expression)\b/i.test(line))) {
    out.effect = 'system';
    out.plain = `Download a script from ${fetched.touches[0]} and run it`;
  }
  return out;
}

const OUTSIDE = /gmail|mail|outlook|inbox|calendar|drive|docs|slack|notion|teams|discord/i;
const SENDS = /^(send|reply|forward|post|publish|share|upload|invite|tweet|comment|submit|respond)$/i;
const DELETES = /^(delete|remove|trash|destroy|purge|archive|unsubscribe|cancel)$/i;
const CHANGES = /^(create|update|modify|edit|move|rename|add|set|write|label|mark|accept|decline|rsvp|patch|batch)$/i;
const READS = /^(get|list|search|read|find|fetch|query|lookup|view|show|download|navigate|open|load|describe|check|count)$/i;

// MCP tools are judged by their names, which are verb first almost
// everywhere (send_message, list_events, create_draft).
function mcp(tool: string, input: Record<string, any>): Judgement {
  const [, server = '', name = ''] = /^mcp__(.+?)__(.+)$/.exec(tool) ?? [];
  const app = server.replace(/^claude_ai_/, '').replace(/_/g, ' ');
  const words = name.replace(/_/g, ' ');
  const j: Judgement = { ...blank(), effect: 'run', plain: `${app}: ${words}`, touches: [app] };
  if (server === 'lab') return blank();
  const tokens = name.split(/[_-]/);
  const verb = (re: RegExp) => re.test(tokens[0]) || (!READS.test(tokens[0]) && tokens.some((t) => re.test(t)));
  const subject = input.subject ?? input.title ?? input.summary;
  const about = subject ? ` "${clip(String(subject))}"` : '';
  if (/chrome|browser|playwright|puppeteer/i.test(server)) {
    const url = String(input.url ?? '');
    if (/upload/i.test(name)) return { ...j, effect: 'send', leaves: true, undo: 'no', plain: 'Upload a file from the computer to a web page' };
    if (url) return { ...j, effect: 'read', touches: [hostOf(url)], source: `a web page on ${hostOf(url)}`, leaves: smuggles(url), plain: smuggles(url) ? `Open ${hostOf(url)} with data in the address` : `Open ${hostOf(url)}` };
    return { ...j, effect: verb(READS) || /page|text|screenshot|tabs|console|network/i.test(name) ? 'read' : 'run', source: verb(READS) ? 'a web page' : undefined, plain: '' };
  }
  const to = input.to ?? input.recipient ?? input.recipients ?? input.email;
  const attendees = Array.isArray(input.attendees) && input.attendees.length;
  if (verb(SENDS) || (verb(CHANGES) && attendees)) {
    const who = [to, attendees ? input.attendees : null].flat().filter(Boolean).map((t: any) => t?.email ?? t).join(', ');
    const lead = /mail/i.test(app) && !/draft/i.test(name) ? 'Send an email' : attendees ? `${app}: invite people` : `${app}: ${words}`;
    if (/draft/i.test(name)) return { ...j, effect: 'change', plain: `${app}: ${words}${about}` };
    return { ...j, effect: 'send', leaves: true, undo: 'no', touches: who ? [who] : [app], plain: `${lead}${who ? ` to ${clip(who)}` : ''}${about}` };
  }
  if (verb(DELETES)) return { ...j, effect: 'delete', undo: /archive|trash/i.test(name) ? 'yes' : 'no', plain: `${app}: ${words}${about}` };
  if (verb(CHANGES)) return { ...j, effect: 'change', plain: `${app}: ${words}${about}` };
  if (verb(READS)) return { ...j, effect: 'read', source: OUTSIDE.test(server) ? (/mail|inbox|outlook/i.test(server) ? 'your email' : app) : undefined, plain: '' };
  return j;
}

// The one entry point for a tool call from either engine.
export function judge(tool: string, input: Record<string, any>, w: Where): Judgement {
  if (tool === 'Bash' || tool === 'PowerShell') return judgeShell(String(input.command ?? ''), w, tool === 'PowerShell');
  if (/^mcp__/.test(tool)) return mcp(tool, input);
  const file = input.file_path ?? input.notebook_path ?? input.path;
  const p = file ? expand(String(file), w).path : '';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    return { ...blank(), effect: 'change', touches: [p], plain: `${tool === 'Write' ? 'Write' : 'Edit'} ${basename(p)}${within(p, w.home) ? '' : ` in ${place(p, w)}`}`, block: protectedPath(p, w) ?? undefined };
  }
  if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(tool)) {
    if (p && within(p, w.lab) && (TOKEN.test(p) || (tool === 'Grep' && same(p, w.lab)))) return { ...blank(), secret: true, touches: [p], plain: "Read The Lab's token", block: 'The token that pairs your phone is never read by the agent.' };
    if (p && SECRET.test(p)) return { ...blank(), secret: true, touches: [p], plain: `Read ${basename(p)}, which holds a password or key` };
    return blank();
  }
  if (tool === 'WebFetch') {
    const url = String(input.url ?? '');
    return { ...blank(), touches: [hostOf(url)], source: `a web page on ${hostOf(url)}`, leaves: smuggles(url), plain: smuggles(url) ? `Open ${hostOf(url)} with data in the address` : '' };
  }
  if (tool === 'WebSearch') return { ...blank(), source: 'a web search' };
  return { ...blank(), effect: ['Agent', 'Task', 'Skill'].includes(tool) ? 'run' : 'read' };
}

// Whether a call waits for his Allow before it runs. Reading, ordinary edits
// and work inside his Lab folder go ahead, because a prompt for every step
// teaches him to tap Allow without reading.
export function needsOk(j: Judgement, w: Where, tainted: boolean): boolean {
  if (j.block) return false;
  if (j.secret || j.effect === 'send' || j.effect === 'system') return true;
  // Moving named files to the Trash goes ahead, as he can drag them back.
  if (j.effect === 'delete') return !!j.unsure || !j.touches.length || (j.undo !== 'trash' && j.touches.some((p) => !within(p, w.home)));
  // After an email or a web page has been read, an address carrying data
  // out asks first.
  return tainted && j.leaves;
}
