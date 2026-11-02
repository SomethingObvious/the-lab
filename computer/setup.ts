// Setup steps for the agent on the owner's Mac. SETUP.md says when to run
// each one. Every step can be run again safely.
//
//   node setup.ts check        what is done and what is left, as JSON
//   node setup.ts auth         sign the agent in with the owner's plan, if it isn't
//   node setup.ts computer     workspace, server, start at login
//   node setup.ts selftest     send a real message through the server and wait for the reply
//   node setup.ts tailscale    HTTPS address for the phone through tailscale serve
//   node setup.ts phone        build the app, install it over USB and pair it
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config, home } from './config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const HOME = home();
const LAB = join(HOME, '.lab');
const TOOLS = join(LAB, 'tools');
const PKG = 'com.somethingobvious.thelab';
const LABEL = 'com.somethingobvious.thelab';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const args = process.argv.slice(3);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const say = (s: string) => console.log(s);
const fail = (s: string): never => { console.error(s); process.exit(1); };
const run = (cmd: string, a: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
  const r = spawnSync(cmd, a, { encoding: 'utf8', input: opts.input, env: opts.env ?? process.env, cwd: opts.cwd, shell: WIN && /\.(bat|cmd)$/i.test(cmd) });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), code: r.status };
};

async function health(timeoutMs = 0): Promise<boolean> {
  const { port } = config();
  const until = Date.now() + timeoutMs;
  do {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true; } catch { /* not up yet */ }
    if (timeoutMs) await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < until);
  return false;
}

// ---------- auth ----------

// The SDK runs its own copy of the agent, which keeps its own sign-in.
function agentBin(): string {
  const req = createRequire(import.meta.url);
  const dir = dirname(req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
  return join(dir, WIN ? 'claude.exe' : 'claude');
}

function signedIn(): { loggedIn: boolean; email?: string; authMethod?: string } {
  const r = run(agentBin(), ['auth', 'status', '--json']);
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return { loggedIn: false }; }
}

async function auth() {
  let s = signedIn();
  if (!s.loggedIn) {
    say('Opening the sign-in page in the browser. Sign in with the account that has the paid plan, then come back here.');
    spawnSync(agentBin(), ['auth', 'login'], { stdio: 'inherit' });
    s = signedIn();
  }
  if (!s.loggedIn) fail('Still not signed in. Run `node setup.ts auth` again.');
  if (s.authMethod !== 'claude.ai') say(`Signed in with ${s.authMethod}, not a plan sign-in, so usage is billed to that account's API credit.`);
  say(`Signed in as ${s.email ?? 'unknown'}.`);
}

async function selftest() {
  const { port, token } = config();
  if (!(await health())) fail('The server is not running. Run `node setup.ts computer` first.');
  const cid = crypto.randomUUID();
  const res = await fetch(`http://127.0.0.1:${port}/events`, { headers: { authorization: `Bearer ${token}`, 'last-event-id': '999999999' } });
  const reader = res.body!.getReader();
  await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'This is a setup check from The Lab. Reply with exactly: lab ok', cid }) });
  const until = Date.now() + 180_000;
  let buf = '';
  let reply = '';
  const dec = new TextDecoder();
  while (Date.now() < until) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const e = JSON.parse(line.slice(6));
      if (e.kind === 'reply') reply = e.text;
      if (e.kind === 'notice') fail(`The agent couldn't run: ${e.text}`);
      if (e.kind === 'done') {
        await reader.cancel();
        if (!e.ok) fail(`The test message failed: ${e.error ?? 'no reason given'}`);
        say(`Round trip works. The agent replied: ${reply}`);
        return;
      }
    }
  }
  fail('No reply within 3 minutes. Check the server log at ' + join(LAB, 'server.log'));
}

// ---------- computer ----------

function workspace() {
  mkdirSync(HOME, { recursive: true });
  const template = join(HERE, 'template');
  for (const name of readdirSync(template)) {
    const dest = join(HOME, name);
    // His app folder and notes are his after the first copy, so they're never overwritten.
    if (!existsSync(dest)) cpSync(join(template, name), dest, { recursive: true });
  }
  config();
}

async function computer() {
  workspace();
  if (MAC) {
    const nodeDir = dirname(process.execPath);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(join(HERE, 'server.ts'))}</string></array>
  <key>WorkingDirectory</key><string>${esc(HERE)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(nodeDir)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LAB_HOME</key><string>${esc(HOME)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(join(LAB, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(LAB, 'server.log'))}</string>
</dict>
</plist>
`;
    mkdirSync(dirname(PLIST), { recursive: true });
    writeFileSync(PLIST, plist);
    const uid = process.getuid!();
    run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    const boot = run('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
    if (!boot.ok && !/already/i.test(boot.out)) fail(`launchctl bootstrap failed: ${boot.out}`);
    run('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`]);
  } else {
    say(`Start at login is only set up on a Mac. Run the server by hand with: node ${join(HERE, 'server.ts')}`);
  }
  if (!(await health(30_000))) fail(`The server didn't come up within 30 seconds. Its log is ${join(LAB, 'server.log')}.`);
  say(`The server is running and starts at login. Workspace: ${HOME}`);
}

// ---------- tailscale ----------

function tailscaleBin(): string | null {
  const candidates = MAC
    ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
    : WIN ? ['C:\\Program Files\\Tailscale\\tailscale.exe'] : ['/usr/bin/tailscale'];
  return candidates.find((c) => existsSync(c)) ?? (run('tailscale', ['version']).ok ? 'tailscale' : null);
}

function tailscaleState() {
  const bin = tailscaleBin();
  if (!bin) return { installed: false } as const;
  const r = run(bin, ['status', '--json']);
  if (!r.ok) return { installed: true, running: false, detail: r.out } as const;
  const s = JSON.parse(r.out.slice(r.out.indexOf('{')));
  const dns = String(s.Self?.DNSName ?? '').replace(/\.$/, '');
  return { installed: true, running: s.BackendState === 'Running', state: s.BackendState as string, dns, bin } as const;
}

async function tailscale() {
  const ts = tailscaleState();
  if (!ts.installed) fail(MAC ? 'Tailscale is not installed. Install it from https://tailscale.com/download/mac, open it, and sign in.' : 'Tailscale is not installed.');
  if (!ts.running || !('dns' in ts) || !ts.dns) fail(`Tailscale is installed but not signed in (state: ${'state' in ts ? ts.state : 'unknown'}). Open Tailscale and sign in, then run this again.`);
  const { port } = config();
  const r = run(ts.bin!, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(r.out)?.[0];
  if (link) fail(`Tailscale needs HTTPS turned on for this network first. Open this link, approve it, then run this again:\n${link}`);
  if (!r.ok) fail(`tailscale serve failed: ${r.out}`);
  const url = `https://${ts.dns}`;
  writeFileSync(join(LAB, 'url'), url);
  say(url);
}

// ---------- phone ----------

async function download(url: string, to: string) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) fail(`Download failed (${res.status}): ${url}`);
  mkdirSync(dirname(to), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(to));
}

function extract(archive: string, into: string) {
  mkdirSync(into, { recursive: true });
  const r = run('tar', ['-xf', archive, '-C', into]);
  if (!r.ok) fail(`Couldn't unpack ${archive}: ${r.out}`);
  rmSync(archive, { force: true });
}

async function jdk(): Promise<string> {
  const given = process.env.JAVA_HOME;
  if (given && existsSync(join(given, 'bin', WIN ? 'javac.exe' : 'javac'))) return given;
  const dir = join(TOOLS, 'jdk');
  const find = () => {
    if (!existsSync(dir)) return null;
    for (const d of readdirSync(dir)) {
      const homeDir = MAC ? join(dir, d, 'Contents', 'Home') : join(dir, d);
      if (existsSync(join(homeDir, 'bin', WIN ? 'javac.exe' : 'javac'))) return homeDir;
    }
    return null;
  };
  const found = find();
  if (found) return found;
  const os = MAC ? 'mac' : WIN ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  say('Downloading a Java 21 build kit (about 200 MB)');
  const archive = join(TOOLS, WIN ? 'jdk.zip' : 'jdk.tar.gz');
  await download(`https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`, archive);
  extract(archive, dir);
  return find() ?? fail('The Java download unpacked into an unexpected layout.');
}

async function androidSdk(javaHome: string): Promise<string> {
  const given = process.env.ANDROID_HOME;
  const sdk = given && existsSync(given) ? given : join(TOOLS, 'android');
  const bin = (name: string) => join(sdk, 'cmdline-tools', 'latest', 'bin', WIN ? `${name}.bat` : name);
  if (!existsSync(bin('sdkmanager'))) {
    say('Downloading the Android command line tools (about 150 MB)');
    const xml = await (await fetch('https://dl.google.com/android/repository/repository2-3.xml')).text();
    const os = MAC ? 'mac' : WIN ? 'win' : 'linux';
    const names = [...xml.matchAll(new RegExp(`commandlinetools-${os}-(\\d+)_latest\\.zip`, 'g'))];
    const best = names.sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ?? fail('Could not find the Android command line tools in Google\'s list.');
    const archive = join(TOOLS, 'cmdline-tools.zip');
    await download(`https://dl.google.com/android/repository/${best}`, archive);
    const tmp = join(TOOLS, 'cmdline-tmp');
    rmSync(tmp, { recursive: true, force: true });
    extract(archive, tmp);
    mkdirSync(join(sdk, 'cmdline-tools'), { recursive: true });
    rmSync(join(sdk, 'cmdline-tools', 'latest'), { recursive: true, force: true });
    renameSync(join(tmp, 'cmdline-tools'), join(sdk, 'cmdline-tools', 'latest'));
    rmSync(tmp, { recursive: true, force: true });
    if (!WIN) for (const f of readdirSync(join(sdk, 'cmdline-tools', 'latest', 'bin'))) chmodSync(join(sdk, 'cmdline-tools', 'latest', 'bin', f), 0o755);
  }
  const env = { ...process.env, JAVA_HOME: javaHome };
  mkdirSync(TOOLS, { recursive: true });
  // The package names have semicolons, which cmd.exe would split, so they go in a file.
  const list = join(TOOLS, 'packages.txt');
  writeFileSync(list, ['platform-tools', 'platforms;android-37.2', 'build-tools;36.0.0'].join('\n'));
  run(bin('sdkmanager'), [`--sdk_root=${sdk}`, '--licenses'], { input: 'y\n'.repeat(30), env });
  say('Installing Android SDK parts (about 400 MB the first time)');
  const r = run(bin('sdkmanager'), [`--sdk_root=${sdk}`, `--package_file=${list}`], { input: 'y\n'.repeat(30), env });
  if (!r.ok) fail(`sdkmanager failed: ${r.out.slice(-2000)}`);
  return sdk;
}

function keystore(javaHome: string) {
  const file = join(LAB, 'phone.jks');
  const pwFile = join(LAB, 'phone.jks.password');
  if (!existsSync(file)) {
    const pw = randomBytes(18).toString('base64url');
    const r = run(join(javaHome, 'bin', WIN ? 'keytool.exe' : 'keytool'), ['-genkeypair', '-keystore', file, '-alias', 'lab', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '36500', '-storepass', pw, '-keypass', pw, '-dname', 'CN=The Lab']);
    if (!r.ok) fail(`keytool failed: ${r.out}`);
    writeFileSync(pwFile, pw, { mode: 0o600 });
  }
  return { file, password: readFileSync(pwFile, 'utf8').trim() };
}

function adbDevice(adb: string): string {
  const out = run(adb, ['devices']).out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2);
  const wanted = flag('serial');
  const ready = out.filter(([s, state]) => state === 'device' && (!wanted || s === wanted));
  if (out.some(([, state]) => state === 'unauthorized')) fail('The phone is plugged in but hasn\'t allowed this Mac yet. Unlock it and tap Allow on the "Allow USB debugging?" prompt (tick Always allow), then run this again.');
  if (ready.length === 0) fail('No phone found over USB. Plug it in with a data cable, unlock it, and check Developer options > USB debugging is on.');
  if (ready.length > 1) fail(`More than one device is connected (${ready.map((r) => r[0]).join(', ')}). Pass --serial to pick one.`);
  return ready[0][0];
}

async function phone() {
  const url = flag('url') ?? (existsSync(join(LAB, 'url')) ? readFileSync(join(LAB, 'url'), 'utf8').trim() : fail('Run `node setup.ts tailscale` first, so the phone knows where to reach this Mac.'));
  const javaHome = await jdk();
  const sdk = await androidSdk(javaHome);
  const adb = join(sdk, 'platform-tools', WIN ? 'adb.exe' : 'adb');
  const serial = adbDevice(adb);
  const sh = (...a: string[]) => run(adb, ['-s', serial, 'shell', ...a]);

  const store = keystore(javaHome);
  const project = join(REPO, 'phone');
  writeFileSync(join(project, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/')}\n`);
  say('Building the app');
  const gradlew = join(project, WIN ? 'gradlew.bat' : 'gradlew');
  if (!WIN) chmodSync(gradlew, 0o755);
  const build = spawnSync(gradlew, ['assembleRelease', '--console=plain', '-q', `-Plab.keystore=${store.file}`, `-Plab.keystorePassword=${store.password}`],
    { cwd: project, env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk }, stdio: 'inherit', shell: WIN });
  if (build.status !== 0) fail('The app build failed. The Gradle output above says why.');
  const apk = join(project, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

  say('Installing on the phone');
  let inst = run(adb, ['-s', serial, 'install', '-r', apk]);
  if (!inst.ok && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(inst.out)) {
    // Signed with a different key (a rebuilt Mac, or a test build), so it has to go and come back.
    run(adb, ['-s', serial, 'uninstall', PKG]);
    inst = run(adb, ['-s', serial, 'install', apk]);
  }
  if (!inst.ok) fail(`adb install failed: ${inst.out}`);

  // A sideloaded app gets no profile from Play, so compile it ahead of time
  // here, or every cold start runs in the interpreter for the first few days.
  sh('cmd', 'package', 'compile', '-m', 'speed', '-f', PKG);
  sh('pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS');
  // Keeps the link to the Mac alive through Doze.
  sh('dumpsys', 'deviceidle', 'whitelist', `+${PKG}`);
  const { token } = config();
  const pair = sh('am', 'broadcast', '-n', `${PKG}/.PairReceiver`, '--es', 'url', url, '--es', 'token', token);
  if (!/result=0/.test(pair.out)) fail(`Pairing didn't take: ${pair.out}`);
  sh('am', 'start', '-n', `${PKG}/.MainActivity`);

  const hasTailscale = sh('pm', 'list', 'packages', 'com.tailscale.ipn').out.includes('com.tailscale.ipn');
  if (!hasTailscale && !url.startsWith('http://localhost')) {
    sh('am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'market://details?id=com.tailscale.ipn');
    say('The app is installed and paired. Tailscale is not on the phone yet, so its Play Store page is open: tap Install, open it, and sign in with the same account as the Mac. Then run `node setup.ts phone-vpn`.');
    return;
  }
  say('The app is installed, paired and open on the phone.');
}

// Keeps Tailscale's VPN on at all times on the phone, so The Lab can always reach the Mac.
async function phoneVpn() {
  const javaHome = await jdk();
  const sdk = await androidSdk(javaHome);
  const adb = join(sdk, 'platform-tools', WIN ? 'adb.exe' : 'adb');
  const serial = adbDevice(adb);
  const r = run(adb, ['-s', serial, 'shell', 'settings', 'put', 'secure', 'always_on_vpn_app', 'com.tailscale.ipn']);
  if (!r.ok) fail(`Couldn't set always-on VPN: ${r.out}`);
  say('Tailscale is now the always-on VPN on the phone.');
}

// ---------- check ----------

async function check() {
  const ts = tailscaleState();
  const status = {
    node: process.version,
    workspace: existsSync(join(HOME, 'app', 'index.html')),
    startsAtLogin: MAC ? existsSync(PLIST) : null,
    serverRunning: await health(),
    agentSignedIn: signedIn().loggedIn,
    tailscale: ts.installed ? ('running' in ts && ts.running ? 'signed in' : 'not signed in') : 'not installed',
    phoneUrl: existsSync(join(LAB, 'url')) ? readFileSync(join(LAB, 'url'), 'utf8').trim() : null,
    phoneKeystore: existsSync(join(LAB, 'phone.jks')),
  };
  say(JSON.stringify(status, null, 2));
}

const steps: Record<string, () => Promise<void>> = { check, auth, computer, selftest, tailscale, phone, 'phone-vpn': phoneVpn };
const step = steps[process.argv[2] ?? ''];
if (!step) fail(`Usage: node setup.ts ${Object.keys(steps).join('|')}`);
await step();
