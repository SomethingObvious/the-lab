// Reads a tool call, never the agent's words about it, and says what it would
// do in plain terms: what it touches, whether it can be undone, whether
// anything leaves the computer, and whether it is never allowed at all. Every Allow
// card on the phone and every rule the server enforces is built from this, so
// an agent talked round by a web page or an email can't explain its way past it.
import { realpathSync } from "node:fs";
import { basename, dirname, posix, win32 } from "node:path";

export type Effect = "read" | "change" | "delete" | "send" | "system" | "run";

export interface Judgement {
	effect: Effect;
	// A sentence in plain words, like "Move 3 items in Downloads to the Trash".
	plain: string;
	// Paths or hosts it acts on.
	touches: string[];
	// 'trash' and 'yes' can be put back by him, 'no' can't, null isn't known.
	undo: "yes" | "trash" | "no" | null;
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
	// A shell command runs a program or code whose effect can't be read from the line.
	runs?: boolean;
	// Everyday work that only needs his OK once a web page or an email could be behind it.
	routine?: boolean;
}

// `user` is the home folder, `home` the agent's Lab folder and `lab` the
// server's own folder.
export interface Where {
	user: string;
	home: string;
	lab: string;
	cwd?: string | undefined;
	// Shell variables set earlier on the same line, like D=~/.thelab.
	vars?: Record<string, string> | undefined;
}

const READ = new Set([
	"recall",
	"ls",
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"du",
	"df",
	"wc",
	"stat",
	"file",
	"mdls",
	"mdfind",
	"pwd",
	"echo",
	"printf",
	"which",
	"whereis",
	"type",
	"date",
	"cal",
	"sw_vers",
	"system_profiler",
	"uname",
	"whoami",
	"id",
	"hostname",
	"uptime",
	"ps",
	"pgrep",
	"lsof",
	"jq",
	"sort",
	"uniq",
	"cut",
	"tr",
	"awk",
	"sed",
	"tree",
	"diff",
	"cmp",
	"md5",
	"shasum",
	"sha256sum",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"test",
	"[",
	"true",
	"false",
	"sleep",
	"ioreg",
	"pbpaste",
	"say",
	"afplay",
	"cd",
	"exit",
	"wait",
	"strings",
	"xxd",
	"od",
	"hexdump",
	"column",
	"nl",
	"fold",
	"base64",
	"bc",
	"expr",
	"seq",
	"locale",
	"sysctl",
	"vm_stat",
	"top",
	"w",
	"last",
	"getconf",
	"sips",
	"plutil",
	"pdftotext",
	"exiftool",
	"ffprobe",
	"identify",
	"printenv",
	"set",
	"export",
	"source",
	".",
	"read",
	"local",
	"shift",
	"return",
]);
const CHANGE = new Set([
	"mv",
	"cp",
	"ditto",
	"mkdir",
	"touch",
	"ln",
	"chmod",
	"chown",
	"chflags",
	"tee",
	"install",
	"zip",
	"unzip",
	"tar",
	"gzip",
	"gunzip",
	"bzip2",
	"xz",
	"7z",
	"xattr",
	"screencapture",
	"convert",
	"magick",
	"ffmpeg",
	"pandoc",
	"textutil",
	"qlmanage",
	"iconutil",
	"pbcopy",
	"open",
	"mkfifo",
	"split",
	"patch",
	"rename",
	"sqlite3",
	"osascript",
	"shortcuts",
]);
const DELETE = new Set(["rm", "rmdir", "unlink", "shred", "srm", "truncate"]);
const SYSTEM = new Set([
	"reg",
	"schtasks",
	"sc",
	"netsh",
	"wmic",
	"powercfg",
	"setx",
	"takeown",
	"icacls",
	"runas",
	"rundll32",
	"mshta",
	"regsvr32",
	"certutil",
	"dism",
	"sfc",
	"net",
	"cmdkey",
	"su",
	"launchctl",
	"systemsetup",
	"networksetup",
	"softwareupdate",
	"installer",
	"killall",
	"kill",
	"pkill",
	"shutdown",
	"reboot",
	"halt",
	"nvram",
	"dscl",
	"chsh",
	"crontab",
	"tccutil",
	"profiles",
	"kextload",
	"kextunload",
	"fdesetup",
	"diskutil",
	"dd",
	"mount",
	"mount_apfs",
	"umount",
	"hdiutil",
	"pmset",
	"scutil",
	"csrutil",
	"spctl",
	"tmutil",
	"mas",
	"port",
	"systemextensionsctl",
	"kmutil",
	"bless",
	"passwd",
	"sysadminctl",
	"dseditgroup",
	"pfctl",
	"mkfs",
	"newfs",
	"fsck",
	"mdutil",
]);
const SEND = new Set([
	"scp",
	"sftp",
	"ssh",
	"mail",
	"sendmail",
	"mutt",
	"nc",
	"ncat",
	"netcat",
	"telnet",
	"ftp",
	"socat",
]);
// Wrappers whose real command is the rest of the line, with the options of
// each that take a value, so the word after one isn't mistaken for the command.
const TIMEOUT = ["-k", "--kill-after", "-s", "--signal"];
const WRAP: Record<string, string[]> = {
	env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
	command: [],
	builtin: [],
	nohup: [],
	time: ["-f", "--format", "-o", "--output"],
	nice: ["-n", "--adjustment"],
	exec: ["-a"],
	caffeinate: ["-t", "-w"],
	stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
	timeout: TIMEOUT,
	gtimeout: TIMEOUT,
	xcrun: ["--sdk", "--toolchain", "--log"],
	sudo: [
		"-u",
		"-g",
		"-h",
		"-p",
		"-C",
		"-D",
		"-r",
		"-t",
		"-T",
		"-U",
		"--user",
		"--group",
		"--host",
		"--prompt",
		"--close-from",
		"--chdir",
		"--role",
		"--type",
		"--command-timeout",
		"--other-user",
	],
	doas: ["-u", "-C"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
// PowerShell and cmd names for things the lists above already cover, so a
// Remove-Item is judged exactly like an rm.
const ALIAS: Record<string, string> = {
	"remove-item": "rm",
	ri: "rm",
	del: "rm",
	erase: "rm",
	rd: "rm",
	"copy-item": "cp",
	copy: "cp",
	cpi: "cp",
	xcopy: "cp",
	"move-item": "mv",
	move: "mv",
	mi: "mv",
	"rename-item": "mv",
	ren: "mv",
	rni: "mv",
	"new-item": "touch",
	ni: "touch",
	md: "mkdir",
	"set-content": "tee",
	"add-content": "tee",
	"out-file": "tee",
	"tee-object": "tee",
	"clear-content": "tee",
	"expand-archive": "unzip",
	"compress-archive": "zip",
	"set-clipboard": "pbcopy",
	clip: "pbcopy",
	"get-childitem": "ls",
	gci: "ls",
	dir: "ls",
	"get-content": "cat",
	gc: "cat",
	"select-string": "grep",
	sls: "grep",
	findstr: "grep",
	"write-output": "echo",
	"write-host": "echo",
	"set-location": "cd",
	sl: "cd",
	chdir: "cd",
	"push-location": "cd",
	pushd: "cd",
	"pop-location": "popd",
	"get-process": "ps",
	gps: "ps",
	tasklist: "ps",
	where: "which",
	"stop-process": "kill",
	spps: "kill",
	taskkill: "kill",
	"start-process": "open",
	saps: "open",
	start: "open",
	"invoke-item": "open",
	ii: "open",
	"invoke-expression": "eval",
	iex: "eval",
	iwr: "invoke-webrequest",
	irm: "invoke-restmethod",
	"stop-computer": "shutdown",
	"restart-computer": "reboot",
};
// The rest of PowerShell goes by its verb. Reading verbs pass, file verbs
// change files, and anything else that sets, stops or installs asks first.
const PS_READ =
	/^(get|test|select|measure|format|write|resolve|convertto|convertfrom|compare|sort|where|foreach|group|join|split|find|search|show|read|wait|import|out|add-type|new-object|new-variable|set-variable|clear-variable|remove-variable|set-strictmode|set-alias|clear-host|start-sleep|receive|trace|debug|use)(-|$)/;
const PS_SYSTEM =
	/^(set|enable|disable|install|uninstall|register|unregister|stop|restart|start|remove|clear|reset|update|add|grant|revoke|suspend|resume|publish|initialize|format|mount|dismount|repair|lock|unlock|block|unblock|protect|unprotect|invoke|new|rename|move|copy|export|send)-/;
// Names a command is known by, whatever folder or extension it was run from.
export const nameOf = (argv0: string) => {
	const raw = (argv0.split(/[\\/]/).pop() ?? "")
		.toLowerCase()
		.replace(/\.(exe|cmd|bat|com)$/, "");
	return ALIAS[raw] ?? raw;
};
// Folders whose whole contents going would wreck the computer or his files.
const BIG = [
	"Desktop",
	"Documents",
	"Downloads",
	"Pictures",
	"Movies",
	"Music",
	"Library",
	"Applications",
	"Public",
	"Sites",
	"Videos",
	"AppData",
	"OneDrive",
];
const SYSTEM_DIRS = [
	"/",
	"/System",
	"/Library",
	"/Applications",
	"/Users",
	"/usr",
	"/bin",
	"/sbin",
	"/private",
	"/etc",
	"/var",
	"/opt",
	"/cores",
	"/Volumes",
	"/tmp",
	"C:",
	"C:/Windows",
	"C:/Program Files",
	"C:/Program Files (x86)",
	"C:/ProgramData",
	"C:/Users",
];
const SECRET =
	/(\/\.ssh(\/|$)|\/\.aws(\/|$)|\/\.netrc$|\/\.gnupg(\/|$)|\/\.codex(\/|$)|\/\.git-credentials$|\/\.claude\/\.credentials\.json$|\/Keychains\/|\/\.config\/gh\/hosts|\/\.docker\/config\.json|\/Cookies(\.binarycookies)?$|\/Login Data$|\/(Google\/Chrome|Microsoft\/Edge|Microsoft Edge|BraveSoftware|Chromium)(\/.*)?\/(History|Web Data|Local State)$|\/(Firefox|Mozilla)\/.*\/(places\.sqlite|cookies\.sqlite|key4\.db|logins\.json)$|\/\.npmrc$|\/\.pypirc$|\.pem$|\.p12$|\/\.env(\.\w+)?$|\/Microsoft\/(Credentials|Protect|Vault)\/)/i;
// Folders and files in the home folder that hold passwords, keys or browser
// sign-ins, so a search or copy of anything above one reads them too.
const HOLDERS = [
	".ssh",
	".aws",
	".gnupg",
	".codex",
	".netrc",
	".git-credentials",
	".claude/.credentials.json",
	".config/gh",
	".docker/config.json",
	".npmrc",
	".pypirc",
	"Library/Keychains",
	"Library/Cookies",
	"Library/Application Support/Google/Chrome",
	"Library/Application Support/Microsoft Edge",
	"Library/Application Support/BraveSoftware",
	"Library/Application Support/Firefox",
	"AppData/Local/Google/Chrome/User Data",
	"AppData/Local/Microsoft/Edge/User Data",
	"AppData/Local/BraveSoftware",
	"AppData/Roaming/Mozilla/Firefox",
	"AppData/Local/Microsoft/Credentials",
	"AppData/Roaming/Microsoft/Credentials",
	"AppData/Roaming/Microsoft/Protect",
	"AppData/Local/Microsoft/Vault",
];
// What the agent is told it may read in The Lab's own folder. The rest of it
// holds his chats, keys and settings.
const OPEN = [
	"source",
	"files",
	"bin",
	"design-history",
	"server.log",
	"app-errors.log",
	"preview-link",
	"desktop/window.txt",
];
// Both NTFS and the computer's APFS ignore case, so every match here does too.
// tunnel.json holds the keys that would let it pose as this computer to the
// phone, which then hands over the token.
const TOKEN =
	/config\.json$|tunnel\.json$|password$|\.jks$|[\\/]desktop[\\/]data([\\/]|$)/i;

interface Seg {
	argv: string[];
	out: string[];
	// Files read through <.
	inp: string[];
	pipedIn: boolean;
	ps: boolean;
}

// PowerShell takes the curly quotes as quotes too.
const SINGLE = "'\u2018\u2019\u201a\u201b";
const DOUBLE = '"\u201c\u201d\u201e';
const ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	v: "\v",
};

// Each step reads the character at i and returns the index of the last
// character it used, so the loop carries on after it.
class Splitter {
	readonly segs: Seg[] = [];
	readonly line: string;
	readonly ps: boolean;
	argv: string[] = [];
	out: string[] = [];
	inp: string[] = [];
	word: string | null = null;
	// Where the next word goes after a redirect, or "drop" for a here-string.
	into: "out" | "in" | "drop" | null = null;
	piped = false;
	// Commands inside $( ), backticks and <( ), which follow the one they're in.
	later: Seg[] = [];
	// Here-documents whose lines start after the next newline.
	docs: { delim: string; raw: boolean; tabs: boolean }[] = [];

	constructor(line: string, ps: boolean) {
		this.line = line;
		this.ps = ps;
	}

	// A lone brace opens or closes a group, but find's {} is just a word.
	push(word: string) {
		const into = this.into;
		this.into = null;
		this.word = null;
		if (into === "out") {
			if (word !== "/dev/null" && word.toLowerCase() !== "$null") this.out.push(word);
		} else if (into === "in") {
			if (word !== "/dev/null") this.inp.push(word);
		} else if (into === null) {
			if (word === "{" || word === "}") this.end();
			else this.argv.push(word);
		}
	}

	flush() {
		if (this.word !== null) this.push(this.word);
	}

	end(pipe = false) {
		this.flush();
		if (this.argv.length > 0)
			this.segs.push({
				argv: this.argv,
				out: this.out,
				inp: this.inp,
				pipedIn: this.piped,
				ps: this.ps,
			});
		this.segs.push(...this.later);
		this.later = [];
		this.argv = [];
		this.out = [];
		this.inp = [];
		this.piped = pipe;
		this.into = null;
	}

	add(text: string) {
		this.word = (this.word ?? "") + text;
	}

	// Where a $( ) or backtick span ends, past any quotes inside it.
	close(from: number, close: string): number {
		const { line, ps } = this;
		let depth = 1;
		for (let j = from; j < line.length; j++) {
			const c = line.charAt(j);
			if (c === (ps ? "`" : "\\")) j++;
			else if (close === ")" && c === "'") {
				const k = line.indexOf("'", j + 1);
				if (k < 0) return line.length;
				j = k;
			} else if (close === ")" && c === '"') j = this.skipQuoted(j + 1);
			else if (close === ")" && c === "(") depth++;
			else if (c === close && --depth === 0) return j;
		}
		return line.length;
	}

	skipQuoted(from: number): number {
		const { line, ps } = this;
		let j = from;
		for (; j < line.length && line[j] !== '"'; j++) {
			if (line[j] === (ps ? "`" : "\\")) j++;
			else if (line[j] === "$" && line[j + 1] === "(") j = this.close(j + 2, ")");
		}
		return j;
	}

	// A command substitution runs as its own line. The word keeps its text, so
	// a path or address built from one is known to be unknown.
	sub(start: number, from: number, close: string) {
		const j = this.close(from, close);
		this.later.push(...segments(this.line.slice(from, j), this.ps));
		this.add(this.line.slice(start, j + 1));
		return j;
	}

	step(i: number): number {
		const { line, ps } = this;
		const c = line.charAt(i);
		if (
			c === "#" &&
			this.word === null &&
			(i === 0 || /[\s;|&(]/.test(line.charAt(i - 1)))
		)
			return this.comment(i);
		if (ps && c === "<" && line[i + 1] === "#") {
			this.flush();
			const stop = line.indexOf("#>", i);
			return stop < 0 ? line.length : stop + 1;
		}
		if (ps && (c === "{" || c === "}")) {
			this.end();
			return i;
		}
		const quoted = this.quote(i);
		if (quoted !== undefined) return quoted;
		if (c === "$") {
			const end = this.dollar(i);
			if (end !== undefined) return end;
		}
		if (!ps && c === "`") return this.sub(i, i + 1, "`");
		if (c === "\n" && this.docs.length > 0) {
			this.cut(c);
			return this.heredocs(i);
		}
		if (";\n()".includes(c)) {
			this.cut(c);
			return i;
		}
		if (c === "&") return this.ampersand(i);
		if (c === "|") return this.bar(i);
		if (c === ">" || c === "<") return this.redirection(i, c);
		if (/\s/.test(c)) this.flush();
		else this.add(c);
		return i;
	}

	// A quoted string or an escaped character, wherever it starts at i.
	quote(i: number): number | undefined {
		const { line, ps } = this;
		const c = line.charAt(i);
		if (c === "'" || (ps && SINGLE.includes(c))) {
			let j = i + 1;
			while (j < line.length && !(ps ? SINGLE : "'").includes(line.charAt(j))) j++;
			this.add(line.slice(i + 1, j));
			return j;
		}
		if (c === '"' || (ps && DOUBLE.includes(c))) return this.quoted(i);
		if (c === (ps ? "`" : "\\")) {
			this.add(line[i + 1] ?? "");
			return i + 1;
		}
		return undefined;
	}

	// $'...', $"...", $(( )) and $( ) at i.
	dollar(i: number): number | undefined {
		const { line, ps } = this;
		const next = line[i + 1];
		if (!ps && next === "'") return this.ansi(i);
		if (!ps && next === '"') return i;
		// $(( )) is arithmetic, which only runs the substitutions inside it.
		if (!ps && next === "(" && line[i + 2] === "(") {
			const j = this.close(i + 2, ")");
			this.subsIn(i + 3, j);
			this.add(line.slice(i, j + 1));
			return j;
		}
		if (next === "(") return this.sub(i, i + 2, ")");
		return undefined;
	}

	// The commands inside $( ) and backticks between from and to, without the
	// text around them, which is data.
	subsIn(from: number, to: number) {
		const { line } = this;
		for (let k = from; k < to; k++) {
			const c = line.charAt(k);
			if (c === "\\") k++;
			else if (c === "`" || (c === "$" && line[k + 1] === "(")) {
				const start = c === "`" ? k + 1 : k + 2;
				const j = this.close(start, c === "`" ? "`" : ")");
				this.later.push(...segments(line.slice(start, j), this.ps));
				k = j;
			}
		}
	}

	// A here-document's lines are its input, not commands, though bash still
	// runs the substitutions in them unless the delimiter was quoted.
	heredocs(i: number): number {
		const { line } = this;
		let at = i + 1;
		for (const d of this.docs) {
			for (let from = at; ; ) {
				const nl = line.indexOf("\n", from);
				const text = line.slice(from, nl < 0 ? undefined : nl);
				if ((d.tabs ? text.replace(/^\t+/, "") : text) === d.delim || nl < 0) {
					if (!d.raw) this.subsIn(at, from);
					at = nl < 0 ? line.length : nl + 1;
					break;
				}
				from = nl + 1;
			}
		}
		this.docs = [];
		return at - 1;
	}

	// bash's $'...' spells characters with backslash codes, so $'\x72m' is rm.
	ansi(start: number) {
		const { line } = this;
		let s = "";
		let i = start + 2;
		for (; i < line.length && line[i] !== "'"; i++) {
			if (line[i] !== "\\") {
				s += line.charAt(i);
				continue;
			}
			const e =
				/^(x[0-9a-f]{1,2}|u[0-9a-f]{1,4}|U[0-9a-f]{1,8}|[0-7]{1,3}|c.|.)/is.exec(
					line.slice(i + 1),
				)?.[0] ?? "";
			i += e.length;
			if (/^[xuU]./.test(e)) s += String.fromCodePoint(Number.parseInt(e.slice(1), 16));
			else if (/^[0-7]/.test(e)) s += String.fromCharCode(Number.parseInt(e, 8));
			else if (/^c./s.test(e)) s += String.fromCharCode(e.charCodeAt(1) % 32);
			else s += ESCAPES[e] ?? e;
		}
		this.add(s);
		return i;
	}

	// Inside a word, zsh and extglob read ( as a group like ~/.lab/@(config).json,
	// so the word stands for anything that starts with it.
	cut(c: string) {
		if (c === "(" && !this.ps && this.word !== null)
			this.word = `${this.word.replace(/[?*+@!]$/, "")}**`;
		this.end();
	}

	comment(i: number) {
		const { line } = this;
		const stop = this.ps && line[i - 1] === "<" ? line.indexOf("#>", i) : -1;
		if (stop >= 0) return stop + 1;
		const nl = line.indexOf("\n", i);
		return nl < 0 ? line.length : nl - 1;
	}

	quoted(start: number) {
		const { line, ps } = this;
		const quote = ps ? DOUBLE : '"';
		let s = "";
		let i = start + 1;
		for (; i < line.length && !quote.includes(line.charAt(i)); i++) {
			// Inside bash double quotes a backslash only escapes these, so C:\Windows keeps its own.
			if (
				ps
					? line[i] === "`" && i + 1 < line.length
					: line[i] === "\\" && '$`"\\\n'.includes(line[i + 1] ?? "x")
			) {
				i++;
				s += line.charAt(i);
			} else if ((!ps && line[i] === "`") || (line[i] === "$" && line[i + 1] === "(")) {
				this.add(s);
				s = "";
				i = line[i] === "`" ? this.sub(i, i + 1, "`") : this.sub(i, i + 2, ")");
			} else s += line.charAt(i);
		}
		this.add(s);
		return i;
	}

	bar(i: number) {
		if (this.line[i + 1] === "|") {
			this.end();
			return i + 1;
		}
		this.end(true);
		return i;
	}

	ampersand(i: number) {
		const { line } = this;
		if (line[i + 1] === "&") {
			this.end();
			return i + 1;
		}
		if (line[i + 1] !== ">") this.end();
		return i;
	}

	redirection(start: number, c: string) {
		const { line } = this;
		let i = start;
		if (
			this.word !== null &&
			(/^\d+$/.test(this.word) || (this.ps && this.word === "*"))
		)
			this.word = null;
		else this.flush();
		// <( ) and >( ) run a command whose output or input stands in for a file.
		if (!this.ps && line[i + 1] === "(") return this.sub(i, i + 2, ")");
		if (c === "<" && line[i + 1] === "<") {
			i++;
			if (line[i + 1] === "<") {
				this.into = "drop";
				return i + 1;
			}
			// A here-document's delimiter is only a marker.
			const tabs = line[i + 1] === "-";
			if (tabs) i++;
			while (line[i + 1] === " ") i++;
			const from = i + 1;
			while (i + 1 < line.length && !/[\s;|&<>()]/.test(line.charAt(i + 1))) i++;
			const word = line.slice(from, i + 1);
			if (!this.ps && word)
				this.docs.push({
					delim: word.replace(/['"\\]/g, ""),
					raw: /['"\\]/.test(word),
					tabs,
				});
			return i;
		}
		let into: "out" | "in" = c === ">" ? "out" : "in";
		if (c === "<" && line[i + 1] === ">") {
			into = "out";
			i++;
		} else if (c === ">" && (line[i + 1] === ">" || line[i + 1] === "|")) i++;
		if (line[i + 1] === "&") {
			// N>&M and >&- copy or close a descriptor, while >&name writes to a file.
			const dup = /^&(\d+|-)(?=$|[\s;|&)<>])/.exec(line.slice(i + 1));
			if (dup) return i + dup[0].length;
			i++;
		}
		this.into = into;
		return i;
	}
}

// Splits a shell line into simple commands. Quotes are honoured, and the
// commands inside $(...), backticks and <(...) are split out after the one
// they're in, so a delete hidden inside one is still seen.
export function segments(line: string, ps = false): Seg[] {
	const s = new Splitter(line, ps);
	for (let i = 0; i < line.length; i++) i = s.step(i);
	s.end();
	return s.segs;
}

// PowerShell's -Path:C:\x carries its value in the same word.
const args = (argv: string[]) =>
	argv
		.slice(1)
		.flatMap((a) =>
			/^-[a-z][\w-]*:./i.test(a)
				? [a.slice(a.indexOf(":") + 1)]
				: a.startsWith("-")
					? []
					: [a],
		);
// Values glued to a flag, like -o/tmp/x, -T~/a.pdf or --output=x, which args() leaves out.
const glued = (argv: string[]) =>
	argv.slice(1).flatMap((a) => {
		const v =
			/^--[\w-]+=(.+)$/s.exec(a)?.[1] ?? /^-[a-zA-Z]+([~/\\@].*)$/s.exec(a)?.[1];
		return v ? [v.replace(/^@/, "")] : [];
	});
// Whether a word is a PowerShell parameter, which it binds by any unique prefix.
const param = (a: string, name: string, min = 1) => {
	const given = a.slice(1).split(":")[0] ?? "";
	return (
		/^-[a-z]/i.test(a) && given.length >= min && name.startsWith(given.toLowerCase())
	);
};
// A flag, whether on its own or bundled like -rf.
const has = (argv: string[], ...f: string[]) =>
	argv.some(
		(a) =>
			f.includes(a) ||
			(/^-[a-zA-Z]+$/.test(a) &&
				f.some((x) => /^-[a-zA-Z]$/.test(x) && a.includes(x.charAt(1)))),
	);
// Windows paths compare without case, the way NTFS treats them.
const fold = (p: string) => p.toLowerCase();
const same = (a: string, b: string) => fold(a) === fold(b);
const within = (p: string, dir: string) => {
	const a = fold(p);
	const d = fold(dir).replace(/\/$/, "");
	return a === d || a.startsWith(`${d}/`);
};
const hostOf = (u: string) => {
	try {
		return new URL(/^\w+:/.test(u) ? u : `https://${u}`).host;
	} catch {
		return "";
	}
};
// An address carrying a long query or path, which is how data gets smuggled
// out in a plain page load.
const smuggles = (u: string) => /[?#][^\s]{40,}|\/[A-Za-z0-9+/=_-]{60,}/.test(u);
const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);
const count = (k: number, one: string) => `${k} ${k === 1 ? one : `${one}s`}`;

// A folder that holds The Lab's own folder somewhere inside it.
const above = (p: string, w: Where) => within(w.lab, p) && !same(p, w.lab);
// Anything a shell could expand becomes a wildcard, so a glob we can't read
// counts as reaching the token rather than missing it. Braces, zsh and extglob
// groups match anything, a bracket matches one character and a lone [ is itself.
const globRe = (p: string) => {
	let s = fold(p);
	for (let was = ""; was !== s; ) {
		was = s;
		s = s.replace(/[?*+@!]?[{(][^{}()]*[})]/g, "**");
	}
	const re = s.replace(
		/\*\*|\*|\?|\[!?\]?(?:\[:\w+:\]|[^\]])*\]|[.+^${}()|[\]\\]/g,
		(m) => {
			if (m === "**") return ".*";
			if (m === "*") return "[^/]*";
			if (m === "?" || m.length > 1) return "[^/]";
			return `\\${m}`;
		},
	);
	return new RegExp(`^${re}$`);
};
const globReaches = (p: string, w: Where) =>
	/[*?[{(]/.test(p) &&
	["config.json", "tunnel.json"].some((f) => globRe(p).test(fold(`${w.lab}/${f}`)));
const SEARCH_BLOCK =
	"That search would reach into The Lab's own folder, where the token that pairs your phone is kept. Search a narrower folder instead.";
// Reads the files under the folders it's given, hidden ones included.
// The name as typed, since nameOf folds findstr and Select-String into grep.
const typed = (argv0: string) =>
	(argv0.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
const searchesInside = (cmd: string, argv: string[]) =>
	(typed(argv[0] ?? "") === "findstr" &&
		argv.some((a) => /^\/[a-z]*s[a-z]*$/i.test(a))) ||
	(["grep", "egrep", "fgrep"].includes(cmd) &&
		(has(argv, "-r", "-R") ||
			argv.some((a) =>
				/^--(dereference-)?recursive$|^(-d|--directories)=?recurse$/.test(a),
			))) ||
	(["rg", "ag"].includes(cmd) &&
		argv.some((a) => /^--hidden$|^--unrestricted$|^-u{2,}$|^-\.$/.test(a))) ||
	(cmd === "find" && argv.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)));
// Lists every file under a folder, which a reader after a pipe then opens.
const listsDeep = (s: Seg) => {
	const cmd = nameOf(s.argv[0] ?? "");
	return (
		cmd === "find" ||
		(["get-childitem", "gci", "dir", "ls"].includes(cmd) &&
			s.argv.some((a) => param(a, "recurse", 1) || a === "-R" || /^\/s$/i.test(a)))
	);
};
// In bash a reader after the pipe only sees the names unless xargs opens
// them. PowerShell hands over the files themselves.
const opensPiped = (s: Seg) => {
	const cmd = typed(s.argv[0] ?? "");
	return (
		cmd === "xargs" ||
		(s.ps && /^(select-string|sls|get-content|gc|cat|type)$/.test(cmd))
	);
};

const TOKEN_BLOCK = "The token that pairs your phone is never read by the agent.";
const hasGlob = (p: string) => /[*?[{(]/.test(p);
// Braces, zsh and extglob groups can match anything, slashes included.
const groups = (p: string) => {
	let s = fold(p);
	for (let was = ""; was !== s; ) {
		was = s;
		s = s.replace(/[?*+@!]?[{(][^{}()]*[})]/g, "**");
	}
	return s;
};
// Whether a path, which may be a glob, can name something in dir or dir
// itself (inside), or a folder that holds dir (above).
function reach(p: string, dir: string): { inside: boolean; above: boolean } {
	if (!hasGlob(p)) return { inside: within(p, dir), above: within(dir, p) };
	const ps = groups(p)
		.replace(/(.)\/+$/, "$1")
		.split("/");
	const ds = fold(dir)
		.replace(/(.)\/+$/, "$1")
		.split("/");
	for (let i = 0; i < Math.min(ps.length, ds.length); i++) {
		const part = ps[i] ?? "";
		// A group can match slashes too, so what's before it decides.
		if (part.includes("**")) {
			const hit = globRe(`${part.slice(0, part.indexOf("**"))}**`).test(
				ds.slice(i).join("/"),
			);
			return { inside: hit, above: hit };
		}
		if (!globRe(part).test(ds[i] ?? "")) return { inside: false, above: false };
	}
	return { inside: ps.length >= ds.length, above: ps.length <= ds.length };
}
const holders = (w: Where) => [...HOLDERS.map((h) => `${w.user}/${h}`), w.lab];
// Whether reading a path reads The Lab's token, or another password, key or
// private file. A glob counts if it could match one.
function secretKind(p: string, w: Where): "token" | "secret" | undefined {
	if (hasGlob(p)) {
		if (globReaches(p, w)) return "token";
		// The part before the first wildcard says which of The Lab's folders it stays in.
		const lit = p.slice(0, p.search(/[*?[{(]/)).replace(/[^/]*$/, "");
		const open = OPEN.some((o) => within(lit, `${w.lab}/${o}`));
		if (!open && reach(p, w.lab).inside) return "secret";
		if (HOLDERS.some((h) => reach(p, `${w.user}/${h}`).inside) || SECRET.test(p))
			return "secret";
		return undefined;
	}
	if (within(p, w.lab)) {
		if (TOKEN.test(p) || same(p, w.lab)) return "token";
		if (!OPEN.some((o) => within(p, `${w.lab}/${o}`))) return "secret";
	}
	return SECRET.test(p) ? "secret" : undefined;
}
// Whether a search or copy of everything under a path takes in a secret too.
const holds = (p: string, w: Where) => holders(w).some((h) => reach(p, h).above);
// Commands that read every file under the folders they're given. du only adds up sizes.
const recursive = (cmd: string, argv: string[]) =>
	searchesInside(cmd, argv) ||
	["rg", "ag", "find", "tar", "bsdtar", "7z", "ditto", "robocopy"].includes(cmd) ||
	["compress-archive", "robocopy"].includes(typed(argv[0] ?? "")) ||
	(typed(argv[0] ?? "") === "xcopy" && argv.some((a) => /^\/[se]$/i.test(a))) ||
	(["ls", "zip", "cp", "scp", "rsync"].includes(cmd) &&
		(has(argv, "-R") ||
			(cmd !== "ls" && has(argv, "-r")) ||
			(["cp", "rsync"].includes(cmd) && has(argv, "-a")) ||
			argv.some(
				(a) => /^--(recursive|archive)$|^\/s$/i.test(a) || param(a, "recurse", 2),
			)));

// The same file however it's spelled: another user's ~, the Data volume on a
// Mac, a variable set earlier, and on Windows the \?\ and FileSystem::
// prefixes, an NTFS stream, trailing dots and spaces, and 8.3 short names.
function expand(p: string, w: Where): { path: string; unsure: boolean } {
	const win = /^[a-z]:\//i.test(w.user);
	const cwd = w.cwd ?? w.home;
	const known = (name: string) => {
		const n = name.toLowerCase();
		if (n === "home" || n === "userprofile") return w.user;
		if (n === "user" || n === "username" || n === "logname") return basename(w.user);
		if (n === "pwd") return cwd;
		return w.vars?.[name] ?? w.vars?.[n];
	};
	let s = p.replace(
		/\$\{env:(\w+)\}|\$env:(\w+)|\$\{(\w+)\}|\$(\w+)|%(\w+)%/gi,
		(m, ...names: (string | undefined)[]) =>
			known(names.slice(0, 5).find(Boolean) ?? "") ?? m,
	);
	s = s.replace(/^~\+(?=$|[/\\])/, cwd).replace(/^~(?!-)[^/\\]*/, w.user);
	if (win) {
		s = s
			.replace(/\\/g, "/")
			.replace(/^(microsoft\.powershell\.core\/)?filesystem::/i, "")
			.replace(/^\/\/[?.]\/(unc\/)?/i, (_, unc) => (unc ? "//" : ""))
			.replace(/^\/\/(localhost|127\.0\.0\.1)\/([a-z])\$(?=\/|$)/i, "$2:")
			// Git Bash writes C:\Users as /c/Users.
			.replace(/^\/([a-z])(?=\/|$)/i, (_, d) => `${d.toUpperCase()}:`);
		const drive = /^[a-z]:/i.exec(s)?.[0] ?? "";
		s =
			drive +
			s
				.slice(drive.length)
				.replace(/:[^/]*$/, "")
				.split("/")
				.map((x) => (/^\.+$/.test(x) ? x : x.replace(/[. ]+$/, "")))
				.join("/");
	} else s = s.replace(/^\/System\/Volumes\/Data(?=\/)/i, "");
	const unsure = /\$[\w{(]|`|%\w+%|^~|^[<>]\(/.test(s);
	const path = win ? win32 : posix;
	// resolve() also folds a .. in an absolute path, which the disk opens the same way.
	if (!unsure) s = path.resolve(cwd, s).replace(/\\/g, "/");
	if (win && !unsure && /~\d/.test(s)) s = long(s);
	return { path: s.replace(/(.)\/+$/, "$1"), unsure };
}

// Windows' own long name for a path with an 8.3 part like THELAB~1, from the
// deepest folder of it that exists.
function long(p: string): string {
	let head = p;
	let tail = "";
	for (;;) {
		try {
			return `${realpathSync.native(head)}${tail}`.replace(/\\/g, "/");
		} catch {
			const up = win32.dirname(head);
			if (up === head) return p;
			tail = `/${win32.basename(head)}${tail}`;
			head = up;
		}
	}
}

// The folder a path is in, in the words he'd use: "Downloads", or "your home folder".
export function place(p: string, w: Where): string {
	const big = (name: string) => BIG.find((b) => same(b, name));
	if (same(p, w.user)) return "your home folder";
	if (same(dirname(p), w.user)) return big(basename(p)) ?? "your home folder";
	const top = big(p.slice(w.user.length + 1).split("/")[0] ?? "");
	if (top !== undefined && within(p, w.user)) return top;
	return basename(dirname(p));
}

function protectedPath(p: string, w: Where): string | null {
	if (reach(p, w.lab).inside)
		return "The Lab keeps its own code, token and history there, and the agent may never change them.";
	const configs = [
		`${w.user}/.claude`,
		`${w.home}/.claude`,
		`${w.user}/.codex`,
		`${w.home}/.codex`,
	];
	if (
		configs.some((d) => within(p, d)) &&
		/settings(\.local)?\.json$|config\.toml$|\/rules(\/|$)|\/hooks(\/|$)|\.claude$|\.codex$/i.test(
			p,
		)
	)
		return "That's the agent's own permission settings, which it may never change.";
	if (/com\.somethingobvious\.thelab\.plist$/i.test(p))
		return "That's what starts The Lab with the computer, and the agent may never change it.";
	return null;
}

// What a delete of this path would take out, when that's more than a
// cleanup should ever reach. The Codex home-folder wipe in July 2026 was a
// cleanup like this.
function wipes(p: string, w: Where): string | null {
	const system = (d: string) => SYSTEM_DIRS.some((x) => same(x, d));
	if (same(p, w.user)) return "your whole home folder";
	if (within(w.user, p) || system(p)) return `${p}, which macOS needs`;
	if (same(dirname(p), w.user) && BIG.some((b) => same(b, basename(p))))
		return `your whole ${basename(p)} folder`;
	if (p.endsWith("/*") && (same(dirname(p), w.user) || system(dirname(p))))
		return `everything in ${same(dirname(p), w.user) ? "your home folder" : dirname(p)}`;
	return null;
}

const blank = (): Judgement => ({
	effect: "read",
	plain: "",
	touches: [],
	undo: null,
	leaves: false,
});

const restore = (rest: string[], w: Where): Judgement => {
	const back = rest.map((a) => expand(a, w).path);
	const [only] = back;
	return {
		...blank(),
		effect: "change",
		undo: "trash",
		touches: back,
		plain:
			back.length === 1 && only !== undefined
				? `Put ${basename(only)} back from the Trash`
				: `Put ${count(back.length, "item")} back from the Trash`,
	};
};

// The paths a delete takes out, wherever each command expects them.
const deleteTargets = (cmd: string, rest: string[]) => {
	if (cmd === "find") return [rest[0] ?? "."];
	if (cmd === "mv") return rest.slice(0, -1);
	if (cmd === "git" || cmd === "rsync") return [rest.at(-1) ?? "."];
	if (cmd === "robocopy") return [rest[1] ?? "."];
	return rest;
};

interface Target {
	path: string;
	unsure: boolean;
}

function deletionPlain(
	cmd: string,
	sub: string,
	trashing: boolean,
	ps: Target[],
	known: Target[],
	w: Where,
): string {
	if (cmd === "find") {
		const from = place(ps[0]?.path ?? "", w);
		return trashing
			? `Move matching files in ${from} to the Trash`
			: `Delete matching files in ${from}`;
	}
	if (cmd === "git")
		return sub === "clean"
			? "Delete files git isn't tracking"
			: "Throw away changes git hasn't saved";
	const [first] = known;
	if (first === undefined)
		return trashing ? "Move something to the Trash" : "Permanently delete something";
	const where = [...new Set(known.map((p) => place(p.path, w)))];
	const what = known.length === 1 ? basename(first.path) : count(known.length, "item");
	const inPlace = where.length === 1 && known.length > 1 ? ` in ${where[0]}` : "";
	return trashing
		? `Move ${what}${inPlace} to the Trash`
		: `Permanently delete ${what}${inPlace}`;
}

function deletion(
	cmd: string,
	sub: string,
	argv: string[],
	rest: string[],
	w: Where,
): Judgement {
	if (cmd === "trash" && argv.includes("--restore")) return restore(rest, w);
	// A find that also deletes for good takes the files before trash sees them.
	const trashing =
		cmd === "trash" ||
		cmd === "mv" ||
		(cmd === "find" &&
			/-(exec|execdir|ok|okdir)\s+(\S*[\\/])?trash(\.cmd)?\s/i.test(argv.join(" ")) &&
			!argv.includes("-delete") &&
			!FIND_RM.test(argv.join(" ")));
	const ps = deleteTargets(cmd, rest).map((a) => expand(a, w));
	const known = ps.filter((p) => !p.unsure);
	const j: Judgement = {
		...blank(),
		effect: "delete",
		touches: ps.map((p) => p.path),
		undo: trashing ? "trash" : "no",
		rm: !trashing,
		unsure: known.length < ps.length || cmd === "find" || cmd === "git",
	};
	// A find that picks files by name, age or size only takes those.
	const picks =
		cmd === "find" &&
		argv.some((a) =>
			/^-(i?name|i?path|i?regex|mtime|mmin|atime|ctime|newer|size|type|empty|user)$/.test(
				a,
			),
		);
	for (const p of known) {
		const lost = picks ? null : wipes(p.path, w);
		if (lost !== null && j.block === undefined) {
			j.block = `That would delete ${lost}. That's never allowed.`;
			j.plain = `Delete ${lost}`;
			return j;
		}
		if (
			j.block === undefined &&
			!trashing &&
			/\/(\.Trash|\$Recycle\.Bin)(\/|$)/i.test(p.path)
		)
			j.block = "Emptying the Trash takes away your undo, so only you do that.";
		if (j.block === undefined) {
			const owned = protectedPath(p.path, w);
			if (owned !== null) j.block = owned;
		}
	}
	j.plain = deletionPlain(cmd, sub, trashing, ps, known, w);
	return j;
}

// One simple command once its wrappers are peeled off, with the parts the
// checks below keep asking for.
interface Call {
	seg: Seg;
	w: Where;
	argv: string[];
	// The first word as typed, folder and all.
	head: string;
	cmd: string;
	sub: string;
	rest: string[];
	line: string;
	sudo: boolean;
	j: Judgement;
}

function unwrap(seg: Seg): { argv: string[]; sudo: boolean } {
	let argv = seg.argv;
	let sudo = false;
	const first = argv[0] ?? "";
	// $x = Get-ChildItem runs what's on the right.
	if (seg.ps && /^\$[\w:]+$/.test(first) && argv[1] === "=") argv = argv.slice(2);
	else if (seg.ps && /^\$[\w:]+=./.test(first))
		argv = [first.replace(/^\$[\w:]+=/, ""), ...argv.slice(1)];
	for (let head = argv[0]; head !== undefined; head = argv[0]) {
		// The command after a keyword like do or then is the one that runs.
		if (!seg.ps && /^(if|then|else|elif|do|while|until|!)$/.test(head)) {
			argv = argv.slice(1);
			continue;
		}
		// A loop or case header only names words, though a redirect on done still reads.
		if (!seg.ps && /^(for|select|case|done|fi|esac)$/.test(head))
			return { argv: ["true", ...argv.slice(1)], sudo };
		const name = basename(head);
		const takes = Object.hasOwn(WRAP, name) ? WRAP[name] : undefined;
		if (takes === undefined && !/^\w+=/.test(head)) break;
		if (name === "sudo" || name === "doas") sudo = true;
		argv = argv.slice(1);
		if (takes === undefined) continue;
		// command -v only says where a command is.
		if (name === "command" && /^-[vV]$/.test(argv[0] ?? ""))
			return { argv: ["which", ...argv.slice(1)], sudo };
		argv = options(name, takes, argv);
	}
	return { argv, sudo };
}

// What's left once a wrapper's own options, and their values, are skipped.
function options(name: string, takes: string[], words: string[]): string[] {
	let argv = words;
	for (let a = argv[0]; a?.startsWith("-"); a = argv[0]) {
		if (a === "--") {
			argv = argv.slice(1);
			break;
		}
		// env -S splits its value into the command line.
		const split = name === "env" && /^(-S|--split-string)$/.test(a);
		const value =
			!a.includes("=") &&
			(takes.includes(a) ||
				(/^-[a-zA-Z]{2,}$/.test(a) && takes.includes(`-${a.at(-1)}`)));
		if (split)
			argv = [...(argv[1] ?? "").split(/\s+/).filter(Boolean), ...argv.slice(2)];
		else argv = argv.slice(value ? 2 : 1);
	}
	if (name.endsWith("timeout") && /^\d/.test(argv[0] ?? "")) argv = argv.slice(1);
	return argv;
}

const never = (
	j: Judgement,
	plain: string,
	block: string,
	effect: Effect = "system",
): Judgement => ({ ...j, effect, plain, block });
const look = (j: Judgement, plain: string): Judgement => ({
	...j,
	effect: "read",
	plain,
});

// Anything after PowerShell's startup switches is the command, named or not.
function powershell(argv: string[], w: Where): Judgement | undefined {
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (
			(param(a, "encodedcommand") || /^-ec$/i.test(a)) &&
			!param(a, "executionpolicy", 2)
		)
			return judgeShell(
				Buffer.from(argv[i + 1] ?? "", "base64").toString("utf16le"),
				w,
				true,
			);
		if (param(a, "command")) return judgeShell(argv.slice(i + 1).join(" "), w, true);
		if (
			/^-(executionpolicy|ex|ep|windowstyle|w|inputformat|outputformat|of|if|version|v|workingdirectory|wd|configurationname|settingsfile|file|f)$/i.test(
				a,
			)
		) {
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		return judgeShell(argv.slice(i).join(" "), w, true);
	}
	return undefined;
}

// Start-Process and cmd's start run whatever program they're given.
function launch({ cmd, argv, head, seg, w }: Call): Judgement | undefined {
	if (
		cmd !== "open" ||
		!/^(start-process|saps|start)$/i.test(head.split(/[\\/]/).pop() ?? "")
	)
		return undefined;
	const words = argv.slice(1);
	const named = (n: string, min: number) => {
		const i = words.findIndex((a) => param(a, n, min));
		return i < 0 ? undefined : words.splice(i, 2)[1];
	};
	const listed = named("argumentlist", 1) ?? named("args", 2);
	named("verb", 2);
	named("workingdirectory", 2);
	named("windowstyle", 2);
	const file =
		named("filepath", 1) ??
		words.find((a) => !(a.startsWith("-") || a.startsWith("/")) && a !== "");
	if (
		file &&
		!/^[a-z][\w+.-]*:\/\//i.test(file) &&
		(!/\.\w+$/.test(file) || /\.(exe|cmd|bat|com|ps1)$/i.test(file))
	) {
		const inner = judgeShell(
			[
				file,
				...(listed === undefined
					? words.slice(words.indexOf(file) + 1)
					: [listed.replace(/,(?=\S)/g, " ")]),
			].join(" "),
			w,
			seg.ps,
		);
		return RANK.indexOf(inner.effect) < RANK.indexOf("run")
			? { ...inner, effect: "run" }
			: inner;
	}
	return undefined;
}

// sh -c and its kind. The command is the first word after the options, so
// -ce, -xc and -c -- all count.
function shell({ argv, seg, w, j }: Call): Judgement | undefined {
	const flag = argv.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
	if (flag > 0) {
		let k = flag + 1;
		for (let a = argv[k]; a !== undefined && /^[-+]/.test(a); a = argv[k]) {
			k += /^[-+][oO]$/.test(a) ? 2 : 1;
			if (a === "--") break;
		}
		return judgeShell(argv[k] ?? "", w);
	}
	if (seg.pipedIn || argv.slice(1).some((a) => /^[<>]\(|^\/dev\/fd\//.test(a)))
		return { ...j, effect: "system", plain: "Run a script it just downloaded" };
	return undefined;
}

// Commands that run another command line, judged by what that line does.
function nested(c: Call): Judgement | undefined {
	const { cmd, argv, seg, w, j } = c;
	if (SHELLS.has(cmd)) {
		const inner = shell(c);
		if (inner) return inner;
	}
	if (cmd === "powershell" || cmd === "pwsh") {
		const inner = powershell(argv, w);
		if (inner) return inner;
	}
	if (cmd === "cmd") {
		// Git Bash turns cmd's /c into //c.
		const at = argv.findIndex((a) => /^\/\/?[ckr]/i.test(a));
		// A caret only escapes the next character, so r^d is rd. cmd has no
		// backslash escapes, which PowerShell's rules match best, and only " quotes,
		// so a ' or # is escaped to stay an ordinary character.
		if (at > 0)
			return judgeShell(
				[(argv[at] ?? "").replace(/^\/\/?[ckr]/i, ""), ...argv.slice(at + 1)]
					.join(" ")
					.replace(/\^(.)/g, "$1")
					.replace(/[`'#\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/g, "`$&"),
				w,
				true,
			);
	}
	const launched = launch(c);
	if (launched) return launched;
	if (cmd === "eval") return judgeShell(argv.slice(1).join(" "), w, seg.ps);
	// .NET calls delete for good, the same as rm.
	if (
		/^\[(system\.)?io\.(file|directory)(info)?\]::delete$|^\.delete$|::delete(file|directory)$/.test(
			cmd,
		)
	)
		return {
			...j,
			effect: "delete",
			undo: "no",
			rm: true,
			unsure: true,
			plain: "Permanently delete something",
		};
	if (cmd === "xargs") {
		const inner = command(
			{
				argv: argv.slice(1).filter((a) => !a.startsWith("-")),
				out: [],
				inp: [],
				pipedIn: false,
				ps: seg.ps,
			},
			w,
		);
		return { ...inner, unsure: true };
	}
	return undefined;
}

const FIND_RM = /-(exec|execdir|ok|okdir)\s+(\S*[\\/])?(rm|unlink|shred)(\.exe)?\s/i;

function removal({ cmd, sub, argv, rest, w }: Call): Judgement | undefined {
	const deleting =
		DELETE.has(cmd) ||
		(cmd === "find" &&
			(argv.includes("-delete") ||
				FIND_RM.test(argv.join(" ")) ||
				/-(exec|execdir|ok|okdir)\s+(\S*[\\/])?trash(\.cmd)?\s/i.test(
					argv.join(" "),
				))) ||
		(cmd === "git" &&
			(sub === "clean" || (sub === "reset" && argv.includes("--hard")))) ||
		(cmd === "rsync" && argv.some((a) => a.startsWith("--delete"))) ||
		(cmd === "robocopy" && argv.some((a) => /^\/(mir|purge)$/i.test(a)));
	if (
		deleting ||
		cmd === "trash" ||
		(cmd === "mv" && rest.length >= 2 && /\.Trash\/?$/.test(rest.at(-1) ?? ""))
	)
		return deletion(cmd, sub, argv, rest, w);
	return undefined;
}

// Never allowed, whatever it's for. These are the macOS and Unix ones.
function forbiddenMac({ cmd, sub, argv, line, j }: Call): Judgement | undefined {
	if (
		cmd === "diskutil" &&
		/^(erase|zero|secureErase|partition|reformat|resize)/i.test(sub)
	)
		return never(
			j,
			"Erase a disk",
			"Erasing or repartitioning a disk is never allowed.",
		);
	if (cmd === "diskutil" && sub === "apfs" && /delete|erase/i.test(argv[2] ?? ""))
		return never(
			j,
			"Erase a disk",
			"Erasing or repartitioning a disk is never allowed.",
		);
	if (/^(mkfs|newfs)/.test(cmd) || (cmd === "dd" && /\bof=\/dev\//.test(line)))
		return never(
			j,
			"Write straight to a disk",
			"Writing straight to a disk is never allowed.",
		);
	if (cmd === "csrutil" && /disable/.test(line))
		return never(
			j,
			"Turn off System Integrity Protection",
			"Turning off macOS security is never allowed.",
		);
	if (cmd === "spctl" && /--(master|global)-disable|--disable/.test(line))
		return never(
			j,
			"Turn off Gatekeeper",
			"Turning off macOS security is never allowed.",
		);
	if (
		cmd === "tmutil" &&
		/^(delete|deletelocalsnapshots|thinlocalsnapshots|disable|disablelocal|removedestination)/.test(
			sub,
		)
	)
		return never(
			j,
			"Delete Time Machine snapshots",
			"Time Machine snapshots are how you undo a mistake, so they are never deleted or turned off.",
		);
	if (cmd === "osascript" && /empty\s+(the\s+)?trash/i.test(line))
		return never(
			j,
			"Empty the Trash",
			"Emptying the Trash takes away your undo, so only you do that.",
			"delete",
		);
	if (
		["launchctl", "pkill", "killall", "kill"].includes(cmd) &&
		/thelab|server\.ts|\bnode(\.exe)?\b/i.test(line)
	)
		return never(
			j,
			"Stop The Lab",
			"The agent may never stop or change The Lab itself.",
		);
	return undefined;
}

// Never allowed either, the Windows ones and a permissions change on everything.
function forbiddenWindows({
	cmd,
	argv,
	rest,
	line,
	w,
	j,
}: Call): Judgement | undefined {
	if (
		/thelab/i.test(line) &&
		(/\\run\b|currentversion/i.test(line) ||
			["reg", "schtasks", "sc"].includes(cmd) ||
			/-(itemproperty|scheduledtask)$/.test(cmd))
	)
		return never(
			j,
			"Stop The Lab",
			"The agent may never stop or change The Lab itself.",
		);
	if (
		(cmd === "vssadmin" && /delete|resize/i.test(line)) ||
		(cmd === "wmic" && /shadowcopy.*delete/i.test(line)) ||
		(cmd === "wbadmin" && /delete/i.test(line)) ||
		cmd === "remove-computerrestorepoint"
	)
		return never(
			j,
			"Delete restore points",
			"Restore points and backups are how you undo a mistake, so they are never deleted.",
		);
	if (
		[
			"format",
			"diskpart",
			"clear-disk",
			"format-volume",
			"initialize-disk",
			"remove-partition",
		].includes(cmd) ||
		(cmd === "cipher" && /\/w/i.test(line))
	)
		return never(
			j,
			"Erase a disk",
			"Erasing or repartitioning a disk is never allowed.",
		);
	if (
		cmd === "bcdedit" ||
		(/^(set|add)-mppreference$/.test(cmd) && /-(disable|exclusion)/i.test(line)) ||
		(cmd === "set-executionpolicy" && /unrestricted|bypass/i.test(line))
	)
		return never(
			j,
			"Turn off Windows security",
			"Turning off Windows security is never allowed.",
		);
	if (cmd === "clear-recyclebin")
		return never(
			j,
			"Empty the Recycle Bin",
			"Emptying the Trash takes away your undo, so only you do that.",
			"delete",
		);
	if (
		cmd === "chmod" &&
		has(argv, "-R") &&
		rest.some((a) => wipes(expand(a, w).path, w))
	)
		return never(
			j,
			"Change permissions on everything",
			"Changing permissions across the whole computer is never allowed.",
		);
	return undefined;
}

// Anything naming The Lab's own folder or the agent's settings, other
// than reading the log.
function touchesLab(c: Call, named: Target[]): Judgement | undefined {
	const { cmd, argv, head, seg, w, j } = c;
	const readOnly =
		(((READ.has(cmd) || cmd === "find") && readMode(cmd, argv, c.rest) === "read") ||
			(seg.ps && PS_READ.test(cmd))) &&
		seg.out.length === 0;
	// awk and sed name the files they write inside their program.
	const program =
		cmd === "awk" || cmd === "sed" ? codePaths(argv.slice(1).join(" "), w) : [];
	if (!readOnly)
		for (const p of [...named, ...program]) {
			const why = protectedPath(p.path, w);
			if (why !== null)
				return {
					...never(j, `Change ${basename(p.path)}`, why, "change"),
					touches: [p.path],
				};
		}
	// Searching the whole folder reads the token as surely as naming it does,
	// and so does a glob like ~/.the*/config.json.
	// A link to a folder that holds The Lab's lets anything read the token through it.
	const links =
		cmd === "ln" ||
		typed(head) === "mklink" ||
		(cmd === "touch" &&
			argv.some((a) => /^(symboliclink|junction|hardlink)$/i.test(a)));
	if (links && named.some((p) => above(p.path, w) || same(p.path, w.lab)))
		return never(
			j,
			"Link to The Lab's folder",
			"A link there would let anything reach The Lab's token through it. Link to a narrower folder instead.",
			"change",
		);
	if (named.some((p) => secretKind(p.path, w) === "token"))
		return { ...never(j, "Read The Lab's token", TOKEN_BLOCK, "read"), secret: true };
	// findstr /s takes a file pattern and searches every folder under it.
	if (
		named.some(
			(p) =>
				above(p.path, w) ||
				(hasGlob(p.path) && reach(p.path, w.lab).above) ||
				(typed(head) === "findstr" && above(dirname(p.path), w)),
		) &&
		searchesInside(cmd, argv)
	)
		return {
			...never(j, "Search The Lab's folder", SEARCH_BLOCK, "read"),
			secret: true,
		};
	return undefined;
}

// The program sed runs, read far enough to find its commands that write a
// file (w, W, the s///w flag) or run one (e, the s///e flag, and r, which
// reads a file it names).
function sedMode(script: string): "read" | "change" | "run" {
	let mode: "read" | "change" | "run" = "read";
	const worse = (m: "change" | "run") => {
		if (m === "run" || mode === "read") mode = m;
	};
	// The index of the delimiter that ends the part starting after i.
	const part = (i: number) => {
		const d = script.charAt(i);
		let k = i + 1;
		for (; k < script.length && script[k] !== d && script[k] !== "\n"; k++)
			if (script[k] === "\\") k++;
		return k;
	};
	const toEnd = (i: number, stop: string) => {
		let k = i;
		while (k < script.length && !stop.includes(script.charAt(k))) k++;
		return k;
	};
	for (let i = 0; i < script.length; i++) {
		const c = script.charAt(i);
		if (c === "/") i = part(i);
		else if (c === "\\") i = part(i + 1);
		else if (c === "s" || c === "y") {
			i = part(part(i + 1));
			const flags = /^[gpiImMew\d]*/.exec(script.slice(i + 1))?.[0] ?? "";
			if (c === "s" && flags.includes("e")) worse("run");
			if (c === "s" && flags.includes("w")) {
				worse("change");
				i = toEnd(i, "\n");
			} else i += flags.length;
		} else if ("aic#".includes(c)) i = toEnd(i, "\n");
		else if ("btT:".includes(c)) i = toEnd(i, ";\n");
		else if (c === "w" || c === "W") {
			worse("change");
			i = toEnd(i, "\n");
		} else if (c === "e" || c === "r" || c === "R") {
			worse("run");
			i = toEnd(i, "\n");
		}
	}
	return mode;
}

type Mode = "read" | "change" | "run";
const any = (flags: string[], re: RegExp) => flags.some((a) => re.test(a));
const when = (yes: boolean, mode: Mode): Mode => (yes ? mode : "read");

function awkMode(flags: string[]): Mode {
	if (any(flags, /^(-f|--file|-i|--include|-E|--exec|-l|--load)/)) return "run";
	let prog = "";
	for (let i = 0; i < flags.length; i++) {
		const a = flags[i] ?? "";
		if (/^(-v|-F|--assign|--field-separator)$/.test(a)) i++;
		else if (!a.startsWith("-")) {
			prog = a;
			break;
		}
	}
	if (/system\s*\(|getline|\|&|\bprintf?\b[^;}]*\|/.test(prog)) return "run";
	return when(/\bprintf?\b[^;}]*>/.test(prog), "change");
}

function sedFlags(flags: string[]): Mode {
	if (has(flags, "-i") || any(flags, /^--in-place/)) return "change";
	if (any(flags, /^(-f|--file)/)) return "run";
	const scripts: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const a = flags[i] ?? "";
		if (a === "-e" || a === "--expression" || /^-[a-zA-Z]+e$/.test(a))
			scripts.push(flags[++i] ?? "");
		else if (/^(-e|--expression=)./.test(a))
			scripts.push(a.replace(/^(-e|--expression=)/, ""));
	}
	if (scripts.length === 0) scripts.push(flags.find((a) => !a.startsWith("-")) ?? "");
	const modes = new Set(scripts.map(sedMode));
	if (modes.has("run")) return "run";
	return when(modes.has("change"), "change");
}

const outputs = (flags: string[]) =>
	when(any(flags, /^(-o|--output|--output-file)/), "change");
const only = (re: RegExp) => (flags: string[]) =>
	when(!flags.filter((a) => a.startsWith("-")).every((a) => re.test(a)), "change");

// How each command that normally only looks at things can still write a file
// or run something, given the options it has. When in doubt it doesn't only read.
const MODES: Record<string, (flags: string[], rest: string[]) => Mode> = {
	source: () => "run",
	".": () => "run",
	awk: awkMode,
	sed: sedFlags,
	find: (f) =>
		any(f, /^-(exec|execdir|ok|okdir)$/)
			? "run"
			: when(any(f, /^-(delete|fprint0?|fprintf|fls)$/), "change"),
	sort: (f) =>
		any(f, /^--compress-program/)
			? "run"
			: when(any(f, /^(-[a-zA-Z]*o|--output)/), "change"),
	uniq: (_, rest) => when(rest.length >= 2, "change"),
	xxd: (f) => when(has(f, "-r") || any(f, /^--?revert$/), "change"),
	tree: (f) => when(any(f, /^(-o|--output)/), "change"),
	rg: (f) => when(any(f, /^--pre(-glob)?(=|$)/), "run"),
	plutil: only(/^-(p|lint|help|s)$/),
	sips: only(/^(-g|--getProperty|-1|--oneLine|-h|--help)$/),
	exiftool: (f) =>
		when(
			any(f, /[=<]|^-(o|w|overwrite_original.*|delete_original.*|tagsfromfile|@)$/i),
			"change",
		),
	pdftotext: (_, rest) => when(rest.at(-1) !== "-", "change"),
	say: outputs,
	base64: outputs,
	ffprobe: outputs,
	sysctl: (f, rest) =>
		when(any(f, /^-w$/) || rest.some((a) => a.includes("=")), "change"),
	less: (f) => when(any(f, /^\+/), "run"),
	more: (f) => when(any(f, /^\+/), "run"),
};

function readMode(cmd: string, argv: string[], rest: string[]): Mode {
	const mode = Object.hasOwn(MODES, cmd) ? MODES[cmd] : undefined;
	return mode ? mode(argv.slice(1), rest) : "read";
}

// curl's and wget's options that carry what they send, by what each carries.
const CURL_SENDS: Record<string, string> = {
	d: "data@",
	data: "data@",
	"data-binary": "data@",
	"data-ascii": "data@",
	json: "data@",
	"data-raw": "data",
	"form-string": "data",
	"data-urlencode": "urlencode",
	F: "form",
	form: "form",
	T: "file",
	"upload-file": "file",
	H: "header",
	header: "header",
	X: "method",
	request: "method",
	K: "config",
	config: "config",
};
const WGET_SENDS: Record<string, string> = {
	"post-file": "file",
	"body-file": "file",
	"post-data": "data",
	"body-data": "data",
	header: "header",
	method: "method",
	config: "config",
	e: "wgetrc",
	execute: "wgetrc",
};

interface Web {
	data: string[];
	files: string[];
	headers: string[];
	method: string;
	config: boolean;
}

function webPut(r: Web, kind: string, v: string) {
	const file = (m: string | undefined) => {
		if (m) r.files.push(m);
	};
	if (kind === "header") r.headers.push(v);
	else if (kind === "method") r.method = v;
	else if (kind === "config") r.config = true;
	else if (kind === "wgetrc") {
		// wgetrc commands like post_file=x.
		if (/^\s*(post|body)_(file|data)\s*=/i.test(v)) r.data.push(v);
		file(/^\s*(post|body)_file\s*=\s*(.+)$/is.exec(v)?.[2]);
	} else {
		r.data.push(v);
		if (kind === "data@" && v.startsWith("@")) file(v.slice(1));
		if (kind === "urlencode") file(/^[^=@]*@(.+)$/s.exec(v)?.[1]);
		if (kind === "form") file(/^[^=]*=[@<]([^;]*)/s.exec(v)?.[1]);
		if (kind === "file") file(v);
	}
}

// What a curl or wget call sends: data, headers, the files it uploads and the method.
function webArgs(cmd: string, argv: string[]): Web {
	const r: Web = { data: [], files: [], headers: [], method: "", config: false };
	const sends = cmd === "curl" ? CURL_SENDS : WGET_SENDS;
	const kind = (flag: string) => {
		const f = flag.replace(/^--?/, "");
		return Object.hasOwn(sends, f) ? sends[f] : undefined;
	};
	// The short flags that take a value, one letter each.
	const short =
		cmd === "curl"
			? "A b c C d D e E F H K m o P Q r t T u U w x X y Y z"
			: "O o a i P U e T t w Q l A R D I X B";
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--") break;
		const opt = /^(--[\w-]+)(?:=(.*))?$/s.exec(a);
		const k = opt ? kind(opt[1] ?? "") : undefined;
		if (opt) {
			if (k !== undefined) webPut(r, k, opt[2] ?? argv[++i] ?? "");
			continue;
		}
		if (!/^-[^-]/.test(a)) continue;
		// Short flags bundle, like -sSd, and the last one's value may be glued on, like -d@x.
		const at =
			a
				.slice(1)
				.split("")
				.findIndex((ch) => ch !== " " && short.includes(ch)) + 1;
		if (at === 0) continue;
		const value = a.slice(at + 1) || (argv[++i] ?? "");
		const sk = kind(`-${a.charAt(at)}`);
		if (sk !== undefined) webPut(r, sk, value);
	}
	return r;
}

// Something worked out by a command as it runs, which can be any file's contents.
const made = (s: string) => /\$\(|`/.test(s);

function curl({ cmd, argv, rest, line, j }: Call): Judgement | undefined {
	if (cmd !== "curl" && cmd !== "wget") return undefined;
	const url =
		rest.find((a) => /^https?:\/\//.test(a)) ??
		rest.find(
			(a) =>
				/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(a) &&
				!/\.(json|txt|html?|zip|png|jpe?g|csv|md|pdf|gz)$/.test(a),
		) ??
		"";
	const host = hostOf(url);
	const web = webArgs(cmd, argv);
	const upload =
		web.data.length > 0 ||
		web.config ||
		/^(POST|PUT|PATCH|DELETE)$/i.test(web.method) ||
		web.headers.some(made) ||
		/-method\s+(post|put|patch|delete)|-(body|infile|form)\b/i.test(line);
	if (upload) {
		const [file] = web.files;
		return {
			...j,
			effect: "send",
			leaves: true,
			touches: [host],
			undo: "no",
			plain: file ? `Send ${basename(file)} to ${host}` : `Send data to ${host}`,
		};
	}
	const saves =
		cmd === "wget" || argv.some((a) => /^(-o|-O|--output|--remote-name)$/.test(a));
	return {
		...j,
		effect: saves ? "change" : "read",
		touches: [host],
		source: `a web page on ${host}`,
		leaves: smuggles(url) || rest.some(made),
		plain:
			smuggles(url) || rest.some(made)
				? `Open ${host} with data in the address`
				: `Download from ${host}`,
	};
}

function webRequest({ cmd, argv, line, j }: Call): Judgement | undefined {
	if (
		cmd !== "invoke-webrequest" &&
		cmd !== "invoke-restmethod" &&
		cmd !== "start-bitstransfer"
	)
		return undefined;
	const url = argv.find((a) => /^https?:\/\//i.test(a)) ?? "";
	const host = hostOf(url);
	const m = argv.findIndex((a) => param(a, "method", 2));
	const posts =
		(m > 0 && !/^(get|head|options)$/i.test(argv[m + 1] ?? "")) ||
		argv.some(
			(a) =>
				param(a, "body") ||
				param(a, "infile", 3) ||
				param(a, "form", 2) ||
				param(a, "headers", 2),
		) ||
		(cmd === "start-bitstransfer" && /-transfertype\s+upload/i.test(line));
	if (posts)
		return {
			...j,
			effect: "send",
			leaves: true,
			touches: [host],
			undo: "no",
			plain: `Send data to ${host}`,
		};
	const saves = cmd === "start-bitstransfer" || /-outfile\b/i.test(line);
	return {
		...j,
		effect: saves ? "change" : "read",
		touches: [host],
		source: `a web page on ${host}`,
		leaves: smuggles(url),
		plain: smuggles(url)
			? `Open ${host} with data in the address`
			: `Download from ${host}`,
	};
}

// The Lab's own report command, which posts to its GitHub repository.
// report.ts takes the word after --copy as a folder to copy its code into, and
// only sends when that word is missing or empty.
function reporting({ cmd, argv, j }: Call): Judgement | undefined {
	const copy = argv.indexOf("--copy");
	if (cmd !== "report" || (copy > 0 && argv[copy + 1])) return undefined;
	return {
		...j,
		effect: "send",
		leaves: true,
		undo: "no",
		touches: ["github.com"],
		plain: "Send a problem report or a fix to The Lab on GitHub",
	};
}

// A remote named as an address could be anywhere, one already set up isn't.
const setUpRemote = (remote?: string) => !remote || /^[\w.-]+$/.test(remote);

function gitPush(argv: string[], rest: string[], j: Judgement): Judgement {
	const force =
		argv.some((a) => /^(-f|--force.*)$/.test(a)) || rest.some((a) => a.startsWith("+"));
	return {
		...j,
		effect: "send",
		leaves: true,
		routine: !force && setUpRemote(rest[1]),
		undo: force ? "no" : "yes",
		touches: [rest[1] ?? "origin"],
		plain: force
			? "Force-push code, replacing what's online"
			: `Push code to ${rest[1] ?? "origin"}`,
	};
}

function sending({ cmd, sub, argv, rest, line, j }: Call): Judgement | undefined {
	if (cmd === "send-mailmessage")
		return { ...j, effect: "send", leaves: true, undo: "no", plain: "Send an email" };
	if (cmd === "git" && sub === "push") return gitPush(argv, rest, j);
	if (
		cmd === "gh" &&
		/^(pr|issue|release|gist|repo|api)$/.test(sub) &&
		/\b(create|comment|edit|upload|delete|merge|close)\b|-X|--method/.test(line)
	)
		return {
			...j,
			effect: "send",
			leaves: true,
			undo: "no",
			touches: ["github.com"],
			plain: `Post to GitHub (${argv.slice(1, 3).join(" ")})`,
		};
	if (cmd === "rsync" && rest.some((a) => /^[\w.-]+(@[\w.-]+)?:/.test(a)))
		return {
			...j,
			effect: "send",
			leaves: true,
			undo: "no",
			touches: rest.filter((a) => a.includes(":")),
			plain: "Copy files to another computer",
		};
	if (SEND.has(cmd)) {
		const host =
			(rest.find((a) => /[@:]/.test(a)) ?? rest[0] ?? "").split(":")[0] ?? "";
		let plain = `Send files to ${host}`;
		if (cmd === "ssh") plain = `Run a command on ${host}`;
		else if (/mail|mutt/.test(cmd)) plain = "Send an email";
		return { ...j, effect: "send", leaves: true, undo: "no", touches: [host], plain };
	}
	if (
		(cmd === "aws" && /\bs3:\/\//.test(line) && /\b(cp|sync|mv)\b/.test(line)) ||
		(cmd === "rclone" && /^(copy|sync|move)$/.test(sub)) ||
		(cmd === "docker" && sub === "push") ||
		(cmd === "npm" && sub === "publish") ||
		(cmd === "twine" && sub === "upload")
	)
		return {
			...j,
			effect: "send",
			leaves: true,
			undo: "no",
			plain: `Upload with ${cmd} ${sub}`,
		};
	if (cmd === "open" && rest.some((a) => a.startsWith("mailto:")))
		return { ...j, effect: "send", leaves: true, plain: "Start an email" };
	return undefined;
}

function appleScript({ cmd, line, j }: Call): Judgement | undefined {
	if (cmd !== "osascript") return undefined;
	if (/\bsend\b/i.test(line) && /mail|messages|outlook/i.test(line))
		return {
			...j,
			effect: "send",
			leaves: true,
			undo: "no",
			plain: "Send a message from the computer",
		};
	if (/\b(delete|move\b.*\btrash)\b/i.test(line))
		return { ...j, effect: "delete", plain: "Delete something with AppleScript" };
	if (/do shell script|keystroke|administrator privileges/i.test(line))
		return { ...j, effect: "system", plain: "Control the computer with AppleScript" };
	return undefined;
}

// Installing and settings.
function installing({ cmd, sub, argv, rest, sudo, j }: Call): Judgement | undefined {
	const everyday =
		!sudo &&
		/^(i|install|add)$/.test(sub) &&
		/^(brew|npm|pip3?|pipx|gem|winget|choco|scoop)$/.test(cmd);
	const installs =
		(cmd === "brew" &&
			/^(install|uninstall|reinstall|upgrade|remove|rm|tap|untap|services)$/.test(
				sub,
			)) ||
		(cmd === "npm" &&
			/^(i|install|add|uninstall|remove|rm|update)$/.test(sub) &&
			has(argv, "-g", "--global")) ||
		(/^pip3?$|^pipx$/.test(cmd) && /^(install|uninstall)$/.test(sub)) ||
		(cmd === "gem" && sub === "install") ||
		["mas", "port", "installer", "softwareupdate", "msiexec"].includes(cmd) ||
		(/^(winget|choco|scoop)$/.test(cmd) &&
			/^(install|uninstall|upgrade|remove|add)$/.test(sub)) ||
		/^(install|uninstall|update)-(module|package|script|psresource)$|^(add|remove)-appxpackage$/.test(
			cmd,
		);
	if (installs) {
		const what = clip(rest.slice(1).join(" ") || sub);
		return {
			...j,
			effect: "system",
			undo: "yes",
			routine: everyday,
			plain: /^(uninstall|remove|rm)$/.test(sub)
				? `Uninstall ${what}`
				: `Install ${what}${cmd === "brew" ? " with Homebrew" : ""}`,
		};
	}
	if (cmd === "defaults" && /^(write|delete|import|rename)$/.test(sub))
		return {
			...j,
			effect: "system",
			undo: "yes",
			plain: `Change a setting (${argv[2] ?? ""})`,
		};
	return undefined;
}

// Commands that only look at a setting, even though the same command can change one.
function checking({ cmd, sub, line, j }: Call): Judgement | undefined {
	if (cmd === "defaults") return look(j, "Check a setting");
	if (
		cmd === "tmutil" &&
		/^(localsnapshot|listlocalsnapshots|listlocalsnapshotdates|status|latestbackup|listbackups|destinationinfo|isexcluded|machinedirectory)$/.test(
			sub,
		)
	)
		return look(j, "Check Time Machine");
	if (cmd === "pmset" && sub.startsWith("-g")) return look(j, "Check power settings");
	if (cmd === "launchctl" && /^(list|print|blame|version)$/.test(sub))
		return look(j, "Check what's running");
	if (cmd === "diskutil" && /^(list|info|apfs)$/.test(sub))
		return look(j, "Check the disks");
	if (cmd === "scutil" && sub === "--get") return look(j, "Check a computer setting");
	if (cmd === "networksetup" && /^-(get|list)/.test(sub))
		return look(j, "Check network settings");
	if (cmd === "mdutil" && sub === "-s") return look(j, "Check Spotlight");
	if (cmd === "security" && /^(find-.*-password|dump-keychain|export)$/.test(sub))
		return { ...look(j, "Read a saved password from the keychain"), secret: true };
	if (cmd === "security" && sub.startsWith("delete-"))
		return { ...j, effect: "delete", undo: "no", plain: "Delete a saved password" };
	if (cmd === "security") return look(j, "Check the keychain");
	if (
		(cmd === "reg" && /^query$/i.test(sub)) ||
		(cmd === "schtasks" && /^\/query$/i.test(sub)) ||
		(cmd === "sc" && /^(query|qc)/i.test(sub)) ||
		(cmd === "powercfg" && /^\/(l|list|q|query|a|availablesleepstates)$/i.test(sub)) ||
		(cmd === "netsh" && /\bshow\b/i.test(line))
	)
		return look(j, "Check a Windows setting");
	if (cmd === "cmdkey") return { ...look(j, "Read saved passwords"), secret: true };
	return undefined;
}

const SYSTEM_PLAIN = new Map([
	["kill", "Stop a running program"],
	["launchctl", "Change what starts with the computer"],
	["crontab", "Schedule something to run by itself"],
	["pmset", "Change power settings"],
	["powercfg", "Change power settings"],
	["shutdown", "Restart or shut down the computer"],
	["reboot", "Restart or shut down the computer"],
	["halt", "Restart or shut down the computer"],
	["schtasks", "Schedule something to run by itself"],
	["reg", "Change a Windows setting"],
]);

function systemChange({ cmd, rest, line, sudo, j }: Call): Judgement | undefined {
	if (cmd === "open" && /-verb\s+runas/i.test(line))
		return { ...j, effect: "system", plain: `Run as administrator: ${clip(line)}` };
	if (sudo)
		return { ...j, effect: "system", plain: `Run as administrator: ${clip(line)}` };
	if (!SYSTEM.has(cmd)) return undefined;
	const plain =
		cmd === "killall" || cmd === "pkill"
			? `Quit ${rest.join(", ")}`
			: (SYSTEM_PLAIN.get(cmd) ?? `Change a system setting (${cmd})`);
	return { ...j, effect: "system", routine: /^(kill|taskkill)$/.test(cmd), plain };
}

// find and the commands that only read, unless their options write or run something.
// What find runs on each file is judged on its own.
function looking(c: Call, named: Target[]): Judgement | undefined {
	const { cmd, argv, rest, seg, w, j } = c;
	if (cmd !== "find" && !READ.has(cmd)) return undefined;
	const mode = readMode(cmd, argv, rest);
	if (mode === "change" || (mode === "run" && cmd !== "find"))
		return { ...j, effect: mode, touches: named.map((p) => p.path) };
	if (cmd === "find")
		return look(j, `Look through ${place(expand(rest[0] ?? ".", w).path, w)}`);
	const o = seg.out.map((a) => expand(a, w).path);
	const [first] = o;
	if (first === undefined) return j;
	return { ...j, effect: "change", touches: o, plain: `Write ${basename(first)}` };
}

// What is left reads, edits or runs something ordinary.
function ordinary(c: Call, named: Target[]): Judgement {
	const { cmd, sub, argv, rest, seg, w, j } = c;
	const secret = NAMES.has(cmd)
		? undefined
		: named.find((p) => secretKind(p.path, w) === "secret");
	if (secret)
		return {
			...look(j, `Read ${basename(secret.path)}, which holds a password or key`),
			secret: true,
			touches: [secret.path],
		};
	if (cmd === "sed" && has(argv, "-i"))
		return {
			...j,
			effect: "change",
			touches: named.map((p) => p.path),
			plain: `Edit ${basename(rest.at(-1) ?? "")}`,
		};
	const looked = looking(c, named);
	if (looked) return looked;
	if (
		cmd === "git" &&
		/^(status|log|diff|show|branch|remote|rev-parse|ls-files|blame|config|fetch)$/.test(
			sub,
		)
	)
		return look(j, "Check git");
	if (cmd === "git")
		return { ...j, effect: "change", undo: "yes", plain: `Run git ${sub}` };
	if (CHANGE.has(cmd)) {
		const last = rest.at(-1);
		const to =
			last !== undefined && rest.length > 1 && ["mv", "cp", "ditto", "ln"].includes(cmd)
				? [last]
				: rest;
		const o = [...to, ...seg.out].map((a) => expand(a, w).path);
		return {
			...j,
			effect: "change",
			touches: o,
			plain:
				cmd === "mv" && rest.length >= 2 && last !== undefined
					? `Move ${rest.length > 2 ? count(rest.length - 1, "item") : basename(rest[0] ?? "")} to ${basename(last)}`
					: "",
		};
	}
	if (seg.ps && PS_READ.test(cmd)) {
		const [first] = seg.out;
		if (first === undefined) return j;
		return {
			...j,
			effect: "change",
			touches: seg.out.map((a) => expand(a, w).path),
			plain: `Write ${basename(first)}`,
		};
	}
	if (seg.ps && PS_SYSTEM.test(cmd))
		return {
			...j,
			effect: "system",
			routine: cmd === "stop-process",
			plain: `Change a system setting (${c.head})`,
		};
	return {
		...j,
		effect: seg.out.length > 0 ? "change" : "run",
		touches: seg.out.map((a) => expand(a, w).path),
	};
}

// The code an interpreter is handed on its command line, like node -e or python -c.
function inlineCode(cmd: string, argv: string[]): string | undefined {
	if (cmd === "deno" && argv[1] === "eval") return argv.slice(2).join(" ");
	let flag: RegExp | undefined;
	if (/^(node|bun)$/.test(cmd)) flag = /^(-e|-p|-pe|--eval|--print)$/;
	else if (/^(python[\d.]*|py|pypy[\d.]*)$/.test(cmd)) flag = /^-[a-zA-Z]*c$/;
	else if (cmd === "ruby" || cmd === "perl") flag = /^-[a-zA-Z]*[eE]$/;
	else if (cmd === "php") flag = /^-r$/;
	else if (cmd === "osascript") flag = /^-e$/;
	if (flag === undefined) return undefined;
	const re = flag;
	const code = argv.flatMap((a, i) => (re.test(a) ? [argv[i + 1] ?? ""] : []));
	return code.length > 0 ? code.join("\n") : undefined;
}

// The paths written out in a piece of code, like the file in awk's print > "x".
const codePaths = (code: string, w: Where) =>
	(
		code.match(
			/(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|[A-Za-z]:[\\/]|\/)[^\s'"`,;()<>]*/gi,
		) ?? []
	)
		.map((p) => expand(p, w))
		.filter((p) => !p.unsure);

// What a piece of code can reach, from the paths and words in it: The Lab's
// token, another secret, or the network.
function codeReach(code: string, w: Where) {
	const paths = codePaths(code, w);
	const lab = basename(w.lab);
	const token =
		paths.some((p) => secretKind(p.path, w) === "token") ||
		(fold(code).includes(fold(lab)) &&
			/config\.json|tunnel\.json|\.jks|password/i.test(code));
	const secret =
		token ||
		paths.some((p) => secretKind(p.path, w) !== undefined || within(p.path, w.lab)) ||
		/\.ssh|\.aws|\.codex|\.netrc|\.git-credentials|credentials\.json|Login Data|Cookies|key4\.db|logins\.json|Keychains/i.test(
			code,
		);
	const net =
		/https?:\/\/|socket|fetch|http|upload|urlopen|requests|curl|wget|smtp|ftp|dgram|\bnet\b|WebClient|WebRequest|RestMethod/i.test(
			code,
		);
	return { token, secret, net };
}

// Interpreters run whatever their inline code says, which carries something
// off the computer when it talks to the network or names a secret.
function interpreter(c: Call): Judgement | undefined {
	const code = inlineCode(c.cmd, c.argv);
	if (code === undefined) return undefined;
	const k = codeReach(code, c.w);
	if (k.token)
		return { ...never(c.j, "Read The Lab's token", TOKEN_BLOCK, "read"), secret: true };
	const base = (c.cmd === "osascript" ? appleScript(c) : undefined) ?? {
		...c.j,
		effect: "run" as const,
		plain: `Run ${c.cmd} code`,
	};
	return {
		...base,
		leaves: base.leaves || k.net || k.secret,
		...(k.secret ? { secret: true } : {}),
	};
}

// The commands find runs on each file it finds.
const execs = (argv: string[]) => {
	const out: string[][] = [];
	for (let i = 0; i < argv.length; i++)
		if (/^-(exec|execdir|ok|okdir)$/.test(argv[i] ?? "")) {
			const stop = argv.findIndex((a, k) => k > i && (a === ";" || a === "+"));
			out.push(argv.slice(i + 1, stop < 0 ? undefined : stop));
			if (stop < 0) break;
			i = stop;
		}
	return out;
};

// Commands that never open a file their arguments name.
const NOFILE = new Set([
	"echo",
	"printf",
	"pwd",
	"which",
	"whereis",
	"type",
	"date",
	"cal",
	"uname",
	"whoami",
	"id",
	"hostname",
	"uptime",
	"ps",
	"pgrep",
	"test",
	"[",
	"true",
	"false",
	"sleep",
	"cd",
	"exit",
	"wait",
	"bc",
	"expr",
	"seq",
	"locale",
	"sysctl",
	"top",
	"getconf",
	"printenv",
	"set",
	"export",
	"read",
	"local",
	"shift",
	"return",
	"say",
	"basename",
	"dirname",
]);

// Commands that only look at names, sizes and dates, never what's in a file.
const NAMES = new Set([
	"ls",
	"du",
	"df",
	"stat",
	"file",
	"mdls",
	"tree",
	"realpath",
	"readlink",
]);

// A command whose name only shows a value, or is worked out as it runs.
function unknown({ seg, argv, head, cmd, j }: Call): Judgement | undefined {
	// In PowerShell a variable or its property on its own just shows a value.
	if (
		seg.ps &&
		argv.length === 1 &&
		/^\$[\w:]+(\.\w+)*$/.test(head) &&
		!/\.(delete|remove|move|copy|write|upload|send|kill|start|stop|invoke|create|set|save|open|run|exec|close|clear)\w*$/i.test(
			head,
		)
	)
		return j;
	// A name worked out as it runs, like {rm,-rf,~} or $cmd, can't be judged.
	if (!seg.ps && /[{$`]/.test(cmd))
		return {
			...j,
			effect: "system",
			unsure: true,
			plain: "Run a command whose name isn't known until it runs",
		};
	return undefined;
}

// cmd reads a .cmd or .bat file's arguments again, bare trash included, so
// one of these characters in a name would start a second command.
function batch({ w, argv, head, cmd, j }: Call): Judgement | undefined {
	const windows = /^[a-z]:\//i.test(w.user);
	if (
		!(
			(/\.(cmd|bat)$/i.test(head) || (windows && cmd === "trash")) &&
			argv.slice(1).some((a) => /[&|<>^%!"\n]/.test(a))
		)
	)
		return undefined;
	return {
		...j,
		effect: cmd === "trash" ? "delete" : "run",
		plain: cmd === "trash" ? "Move something to the Trash" : `Run ${basename(head)}`,
		block:
			"cmd would read a & | < > ^ % ! or quote in that name as part of a command. Rename it without that character first.",
	};
}

// Judges one simple command.
function boxing({ argv, j }: Call): Judgement {
	const at = argv.indexOf("--ssh");
	const host = at === -1 ? "" : (argv[at + 1] ?? "");
	if (host)
		return {
			...j,
			effect: "send",
			leaves: true,
			touches: [host],
			plain: `Run a command on ${clip(host)}`,
		};
	return { ...j, effect: "run", plain: "Run something in the box" };
}

function command(seg: Seg, w: Where): Judgement {
	const { argv, sudo } = unwrap(seg);
	const head = argv[0] ?? "";
	const cmd = nameOf(head);
	const j = blank();
	if (!cmd) return j;
	const c: Call = {
		seg,
		w,
		argv,
		head,
		cmd,
		sub: argv[1] ?? "",
		rest: args(argv),
		line: argv.join(" "),
		sudo,
		j,
	};
	if (cmd === "box" && !sudo) return boxing(c);
	const odd = unknown(c) ?? batch(c);
	if (odd) return odd;
	const nest = nested(c);
	if (nest) return nest;
	const words = [
		...c.rest,
		...glued(argv),
		...(cmd === "curl" || cmd === "wget" ? webArgs(cmd, argv).files : []),
		...seg.out,
		...seg.inp,
	].filter((a) => !(/^[<>]\(/.test(a) || /^\$(null|true|false)$/i.test(a)));
	const all = words.map((a) => expand(a, w));
	const named = all.filter((p) => !p.unsure);
	let r =
		removal(c) ??
		forbiddenMac(c) ??
		forbiddenWindows(c) ??
		touchesLab(c, named) ??
		interpreter(c) ??
		curl(c) ??
		webRequest(c) ??
		reporting(c) ??
		sending(c) ??
		appleScript(c) ??
		installing(c) ??
		checking(c) ??
		systemChange(c) ??
		ordinary(c, named);
	if (cmd === "find")
		r = combine([
			r,
			...execs(argv).map((x) =>
				Object.assign(
					command({ argv: x, out: [], inp: [], pipedIn: false, ps: seg.ps }, w),
					{
						unsure: true,
					},
				),
			),
		]);
	if (r.block || inlineCode(cmd, argv) !== undefined) return r;
	// Reading or uploading a secret is the same whichever command does it, and
	// so is reading everything under a folder that holds one. A path that can't
	// be known until it runs might be one, though a word with spaces in it is an
	// awk program or a pattern rather than a path.
	const opens =
		!(NOFILE.has(cmd) || NAMES.has(cmd)) &&
		(READ.has(cmd) ||
			CHANGE.has(cmd) ||
			SEND.has(cmd) ||
			["find", "curl", "wget"].includes(cmd));
	const secret =
		(!NAMES.has(cmd) && named.some((p) => secretKind(p.path, w) !== undefined)) ||
		(recursive(cmd, argv) && named.some((p) => holds(p.path, w))) ||
		(opens && words.some((a) => !/\s/.test(a) && expand(a, w).unsure));
	const unsure = [...seg.out, ...seg.inp].some((a) => expand(a, w).unsure);
	return {
		...r,
		...(secret ? { secret: true } : {}),
		...(unsure ? { unsure: true } : {}),
	};
}

// The worst part speaks for the whole, and a block anywhere blocks it.
function combine(parts: Judgement[]): Judgement {
	const worst = parts.reduce((a, b) =>
		RANK.indexOf(b.effect) > RANK.indexOf(a.effect) ? b : a,
	);
	const out: Judgement = {
		...worst,
		touches: [...new Set(parts.flatMap((p) => p.touches))],
	};
	const block = parts.find((p) => p.block)?.block;
	if (block !== undefined) out.block = block;
	out.rm = parts.some((p) => p.rm);
	out.secret = parts.some((p) => p.secret);
	out.leaves = parts.some((p) => p.leaves);
	out.unsure = parts.some((p) => p.unsure);
	out.routine = parts.every((p) => p.routine || !["send", "system"].includes(p.effect));
	const source = parts.find((p) => p.source)?.source;
	if (source !== undefined) out.source = source;
	return out;
}

// NAME=value words, and PowerShell's $name = value, which later words on the line use.
function assigns(s: Seg): [string, string][] {
	const a = s.argv;
	if (s.ps) {
		const name = /^\$(?:env:)?(\w+)$/i.exec(a[0] ?? "")?.[1];
		if (name && a[1] === "=" && a.length === 3) return [[name, a[2] ?? ""]];
		const glue = /^\$(?:env:)?(\w+)=(.+)$/is.exec(a[0] ?? "");
		return glue && a.length === 1 ? [[glue[1] ?? "", glue[2] ?? ""]] : [];
	}
	// for f in *.md gives f each name the one glob matches.
	if (a[0] === "for" && a[2] === "in" && a.length === 4)
		return [[a[1] ?? "", a[3] ?? ""]];
	const words = /^(export|local|declare|readonly|typeset)$/.test(a[0] ?? "")
		? a.slice(1)
		: a;
	return words.flatMap((x) => {
		const m = /^(\w+)=(.*)$/s.exec(x);
		return m ? [[m[1] ?? "", m[2] ?? ""] as [string, string]] : [];
	});
}

// Fork bombs don't parse as anything useful, so they're matched as text.
const BOMB = /(\w+|:)\s*\(\)\s*\{[^}]*\1\s*\|\s*\1\s*&/;
const RANK: Effect[] = ["read", "run", "change", "system", "delete", "send"];

// .NET calls in PowerShell read files and reach the network as code does.
function dotnet(line: string, w: Where): Judgement[] {
	if (!/\]::|new-object/i.test(line)) return [];
	const k = codeReach(line, w);
	if (k.token)
		return [
			{ ...never(blank(), "Read The Lab's token", TOKEN_BLOCK, "read"), secret: true },
		];
	if (!(k.net || k.secret)) return [];
	return [
		{
			...blank(),
			effect: /\.upload\w*\s*\(/i.test(line) ? "send" : "run",
			leaves: true,
			secret: k.secret,
			plain: "Run .NET code that reaches the network or a secret",
		},
	];
}

export function judgeShell(line: string, w: Where, ps = false): Judgement {
	if (BOMB.test(line))
		return {
			...blank(),
			effect: "system",
			plain: "Start a fork bomb",
			block: "That would lock the computer up, so it is never allowed.",
		};
	// A cd carries to the commands after it, so relative paths land where they will.
	let cwd = w.cwd;
	const vars: Record<string, string> = { ...w.vars };
	const stack: (string | undefined)[] = [];
	const segs = segments(line, ps);
	const deep: boolean[] = [];
	const parts: Judgement[] = [];
	for (const [i, s] of segs.entries()) {
		const here: Where = { ...w, cwd, vars: { ...vars } };
		const prev = segs[i - 1];
		// A recursive listing of a folder above The Lab's, piped into a reader.
		if (
			prev !== undefined &&
			s.pipedIn &&
			opensPiped(s) &&
			listsDeep(prev) &&
			deep[i - 1] === true
		) {
			parts.push({
				...blank(),
				effect: "read",
				plain: "Search The Lab's folder",
				block: SEARCH_BLOCK,
				secret: true,
			});
			continue;
		}
		if (listsDeep(s)) {
			const at = args(s.argv);
			deep[i] = (at.length > 0 ? at : [cwd ?? w.home]).some((a) =>
				above(expand(a, here).path, w),
			);
		}
		parts.push(command(s, here));
		Object.assign(
			vars,
			Object.fromEntries(
				assigns(s).flatMap(([k, v]) => [
					[k, v],
					[k.toLowerCase(), v],
				]),
			),
		);
		const head = s.argv[0] ?? "";
		const name = nameOf(head);
		if (name === "cd") {
			if (/^pushd$|^push-location$/i.test(head.split(/[\\/]/).pop() ?? ""))
				stack.push(cwd);
			const to = args(s.argv.filter((a) => !/^\/d$/i.test(a)))[0];
			cwd = to ? expand(to, here).path : w.user;
		} else if (name === "popd") cwd = stack.pop() ?? cwd;
	}
	if (ps) parts.push(...dotnet(line, w));
	if (parts.length === 0) return blank();
	const out = combine(parts);
	out.runs = parts.some((p) => p.effect === "run");
	const fetched = parts.find((p) => p.source && p.touches[0]);
	if (
		fetched &&
		(/\|\s*(sudo\s+)?(bash|zsh|dash|ksh|sh)\b/.test(line) ||
			/\b(iex|invoke-expression)\b/i.test(line))
	) {
		out.effect = "system";
		out.routine = false;
		out.plain = `Download a script from ${fetched.touches[0]} and run it`;
	}
	return out;
}

const OUTSIDE =
	/gmail|mail|outlook|inbox|calendar|drive|docs|slack|notion|teams|discord/i;
const SENDS =
	/^(send|reply|forward|post|publish|share|upload|invite|tweet|comment|submit|respond)$/i;
const DELETES = /^(delete|remove|trash|destroy|purge|archive|unsubscribe|cancel)$/i;
const CHANGES =
	/^(create|update|modify|edit|move|rename|add|set|write|label|mark|accept|decline|rsvp|patch|batch)$/i;
const READS =
	/^(get|list|search|read|find|fetch|query|lookup|view|show|download|navigate|open|load|describe|check|count)$/i;

// A browser tool reads the page it opens, unless it uploads a file to one.
function browser(
	name: string,
	input: Record<string, unknown>,
	j: Judgement,
	reads: boolean,
): Judgement {
	const url = String(input["url"] ?? "");
	if (/upload/i.test(name))
		return {
			...j,
			effect: "send",
			leaves: true,
			undo: "no",
			plain: "Upload a file from the computer to a web page",
		};
	if (url)
		return {
			...j,
			effect: "read",
			touches: [hostOf(url)],
			source: `a web page on ${hostOf(url)}`,
			leaves: smuggles(url),
			plain: smuggles(url)
				? `Open ${hostOf(url)} with data in the address`
				: `Open ${hostOf(url)}`,
		};
	return {
		...j,
		effect:
			reads || /page|text|screenshot|tabs|console|network/i.test(name) ? "read" : "run",
		...(reads ? { source: "a web page" } : {}),
		plain: "",
	};
}

// A recipient is either an address or an object that carries one.
const emailOf = (t: unknown): unknown =>
	typeof t === "object" && t !== null && "email" in t ? (t.email ?? t) : t;

// Where a read from another app's tool gets its content, when that's outside.
const outsideSource = (server: string, app: string) => {
	if (!OUTSIDE.test(server)) return;
	return /mail|inbox|outlook/i.test(server) ? "your email" : app;
};

// A file an MCP tool is handed is read as surely as by Read. Sending a secret
// to the phone is refused outright, as the copy lands where the agent can read it.
function mcpFiles(
	tool: string,
	input: Record<string, unknown>,
	w: Where,
): Judgement | undefined {
	const files = ["path", "file_path", "filePath", "file", "paths", "files"]
		.flatMap((k) => [input[k]].flat())
		.filter((f): f is string => typeof f === "string" && f !== "");
	for (const f of files) {
		const r = reading("Read", expand(f, w).path, w);
		if (r.block) return r;
		if (r.secret && tool === "mcp__lab__send_to_phone")
			return {
				...r,
				effect: "send",
				plain: `Send ${basename(f)} to the phone`,
				block: "A file that holds a password, key or token never goes to the phone.",
			};
		if (r.secret) return { ...mcp(tool, input), secret: true };
	}
	return undefined;
}

// MCP tools are judged by their names, which are verb first almost
// everywhere (send_message, list_events, create_draft).
function mcp(tool: string, input: Record<string, unknown>): Judgement {
	const [, server = "", name = ""] = /^mcp__(.+?)__(.+)$/.exec(tool) ?? [];
	const app = server.replace(/^claude_ai_/, "").replace(/_/g, " ");
	const words = name.replace(/_/g, " ");
	const j: Judgement = {
		...blank(),
		effect: "run",
		plain: `${app}: ${words}`,
		touches: [app],
	};
	if (server === "lab") return blank();
	const tokens = name.split(/[_-]/);
	const first = tokens[0] ?? "";
	const verb = (re: RegExp) =>
		re.test(first) || (!READS.test(first) && tokens.some((t) => re.test(t)));
	const subject = input["subject"] ?? input["title"] ?? input["summary"];
	const about = subject ? ` "${clip(String(subject))}"` : "";
	if (/chrome|browser|playwright|puppeteer/i.test(server))
		return browser(name, input, j, verb(READS));
	const to = input["to"] ?? input["recipient"] ?? input["recipients"] ?? input["email"];
	const invited = input["attendees"];
	const attendees = Array.isArray(invited) && invited.length > 0;
	if (verb(SENDS) || (verb(CHANGES) && attendees)) {
		if (/draft/i.test(name))
			return { ...j, effect: "change", plain: `${app}: ${words}${about}` };
		const who = [to, attendees ? invited : null]
			.flat()
			.filter(Boolean)
			.map((t) => emailOf(t))
			.join(", ");
		let lead = `${app}: ${words}`;
		if (/mail/i.test(app)) lead = "Send an email";
		else if (attendees) lead = `${app}: invite people`;
		return {
			...j,
			effect: "send",
			leaves: true,
			undo: "no",
			touches: who ? [who] : [app],
			plain: `${lead}${who ? ` to ${clip(who)}` : ""}${about}`,
		};
	}
	if (verb(DELETES))
		return {
			...j,
			effect: "delete",
			undo: /archive|trash/i.test(name) ? "yes" : "no",
			plain: `${app}: ${words}${about}`,
		};
	if (verb(CHANGES))
		return { ...j, effect: "change", plain: `${app}: ${words}${about}` };
	if (verb(READS)) {
		const source = outsideSource(server, app);
		return {
			...j,
			effect: "read",
			...(source === undefined ? {} : { source }),
			plain: "",
		};
	}
	return j;
}

// Reading tools only matter when they reach a secret or The Lab's token.
// Glob only lists names, so it asks rather than being refused.
function reading(tool: string, p: string, w: Where): Judgement {
	const deep = tool === "Grep" || tool === "Glob";
	const kind = p ? secretKind(p, w) : undefined;
	if (tool === "Glob" && (kind !== undefined || holds(p, w)))
		return {
			...blank(),
			secret: true,
			touches: [p],
			plain: "List files that hold a password or key",
		};
	if (tool === "Grep" && p && (above(p, w) || (hasGlob(p) && reach(p, w.lab).above)))
		return {
			...blank(),
			secret: true,
			touches: [p],
			plain: "Search The Lab's folder",
			block: SEARCH_BLOCK,
		};
	if (kind === "token")
		return {
			...blank(),
			secret: true,
			touches: [p],
			plain: "Read The Lab's token",
			block: TOKEN_BLOCK,
		};
	if (kind === "secret" || (deep && p && holds(p, w)))
		return {
			...blank(),
			secret: true,
			touches: [p],
			plain: `Read ${basename(p)}, which holds a password or key`,
		};
	return blank();
}

// The one entry point for a tool call from either engine.
export function judge(
	tool: string,
	input: Record<string, unknown>,
	w: Where,
): Judgement {
	if (tool === "Bash" || tool === "PowerShell")
		return judgeShell(String(input["command"] ?? ""), w, tool === "PowerShell");
	if (tool.startsWith("mcp__")) return mcpFiles(tool, input, w) ?? mcp(tool, input);
	const file = input["file_path"] ?? input["notebook_path"] ?? input["path"];
	let p = file ? expand(String(file), w).path : "";
	// Glob's pattern says how far below its folder it looks.
	const pattern = input["pattern"];
	if (tool === "Glob" && typeof pattern === "string")
		p = expand(
			/^([a-z]:)?[\\/]|^~/i.test(pattern) ? pattern : `${p || "."}/${pattern}`,
			w,
		).path;
	if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
		const block = protectedPath(p, w);
		return {
			...blank(),
			effect: "change",
			touches: [p],
			plain: `${tool === "Write" ? "Write" : "Edit"} ${basename(p)}${within(p, w.home) ? "" : ` in ${place(p, w)}`}`,
			...(block === null ? {} : { block }),
		};
	}
	if (["Read", "Glob", "Grep", "LS", "NotebookRead"].includes(tool))
		return reading(tool, p, w);
	if (tool === "WebFetch") {
		const url = String(input["url"] ?? "");
		return {
			...blank(),
			touches: [hostOf(url)],
			source: `a web page on ${hostOf(url)}`,
			leaves: smuggles(url),
			plain: smuggles(url) ? `Open ${hostOf(url)} with data in the address` : "",
		};
	}
	if (tool === "WebSearch") return { ...blank(), source: "a web search" };
	return {
		...blank(),
		effect: ["Agent", "Task", "Skill"].includes(tool) ? "run" : "read",
	};
}

// Whether a call waits for his Allow before it runs. Reading, ordinary edits
// and work inside his Lab folder go ahead, because a prompt for every step
// teaches him to tap Allow without reading.
export function needsOk(j: Judgement, w: Where, tainted: boolean): boolean {
	if (j.block) return false;
	if (j.secret) return true;
	if (j.effect === "send" || j.effect === "system") return !j.routine || tainted;
	// Moving named files to the Trash goes ahead, as he can drag them back.
	if (j.effect === "delete")
		return (
			j.unsure === true ||
			j.touches.length === 0 ||
			(j.undo !== "trash" && j.touches.some((p) => !within(p, w.home)))
		);
	// After an email or a web page has been read, anything carrying data out,
	// and any program or code the guard can't see into, asks first.
	return tainted && (j.leaves || j.runs === true);
}

// How much it asks, which he picks on the phone. Plan changes nothing, Manual
// asks before anything but reading, Auto asks before what matters (needsOk)
// and Bypass asks before nothing. The never-allow list and the Trash rule hold
// in all four, as they're checked before the mode is.
export const ASK_MODES = ["plan", "manual", "auto", "bypass"] as const;
export type AskMode = (typeof ASK_MODES)[number];

// Subagents and skills change nothing themselves, and their own calls come
// through the same checks.
const inert = (tool: string, j: Judgement) =>
	(j.effect === "read" && !j.leaves) || ["Agent", "Task", "Skill"].includes(tool);

export function inMode(
	mode: AskMode,
	tool: string,
	j: Judgement,
	w: Where,
	tainted: boolean,
): "go" | "ask" | "plan" {
	if (mode === "bypass") return "go";
	if (mode === "manual") return inert(tool, j) && !j.secret ? "go" : "ask";
	if (mode === "plan" && !inert(tool, j)) return "plan";
	return needsOk(j, w, tainted) ? "ask" : "go";
}
