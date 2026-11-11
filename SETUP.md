# Setting Up The Lab

These are instructions for the agent on the owner's computer. Read the whole file first, then work through it top to bottom. Do every step yourself. The owner only needs to act where a step says so, and when that happens tell him exactly what to tap or click, one thing at a time, and wait for him to say it's done.

On a Windows PC the steps are the same with three differences. Node comes from the Windows download below instead of the Mac one, `curl.exe` and `tar` (both come with Windows 10 and 11) fetch the source into `%USERPROFILE%\.thelab\source`, and `~` means `%USERPROFILE%` throughout. Git Bash is optional. Setup and the server use PowerShell and cmd where they need a shell, and the agent's commands run in whichever shell it already has.

Each command may run in a fresh shell, so call Node by its full path (or set `PATH` in the same command) rather than relying on an earlier `export`. Two steps take long: `auth` waits while he signs in, and `phone` can take 15 minutes the first time. Run those in the background or with the longest timeout you have, and check back on them.

Every command in `computer/setup.ts` can be run again safely, so if something fails, fix the cause and rerun that step. `node setup.ts check` prints what is done and what is left at any point.

## What Gets Installed

- `~/TheLab/`, the workspace and the only folder the agent on the phone can change. It holds `app/` (the phone app's interface, which you can edit later when he asks), `CLAUDE.md` (also linked as `AGENTS.md`), `DESIGN.md`, `memory.md`, `shortcuts.json` and `schedules.json`.
- `~/.thelab/`, the server's own state: its token, history, log, the files he sends and the tools setup downloads. It sits outside the workspace so the agent can't loosen its own limits.
- `~/.thelab/source/`, this repository.
- A login item that keeps the server running. On a Mac it's `~/Library/LaunchAgents/com.somethingobvious.thelab.plist`, which starts `~/.thelab/The Lab.app`, a small app holding Node so macOS names The Lab in its prompts and settings. On Windows it's a `TheLab` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which starts it hidden when he signs in.
- A relay on Cloudflare's free plan, unless he was given the address of one that's already up.
- The Lab on the phone, built on this computer and installed over a USB cable.
- The Lab's window on the computer, built here too. It's `~/.thelab/desktop/TheLab.exe` with shortcuts in the Start menu and on the desktop on Windows, and `~/Applications/The Lab.app` on a Mac. That's a different app from the one in `~/.thelab` that the server runs in, and only the server's one needs Full Disk Access.

Nothing is exposed to the internet. The server itself listens only on the computer, and the phone reaches it through an encrypted tunnel. The tunnel listens on the home Wi-Fi so the phone can come straight in when they share one, and goes through the relay otherwise. It also answers a phone on the Wi-Fi that asks where the computer went, with nothing but its port, so a new address from the router doesn't break the link. The keys come from pairing and never leave the two devices, so neither the Wi-Fi nor the relay can read or change anything that passes.

## 1. Node and the Source

Check for Node 24 or later with `node --version`. If it's missing or older, install it into `~/.thelab/tools` so no admin password is needed. On a Mac:

```sh
mkdir -p ~/.thelab/tools && cd ~/.thelab/tools
ARCH=$(uname -m | sed 's/x86_64/x64/')
FILE=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep "darwin-$ARCH.tar.gz" | awk '{print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$FILE" && tar -xzf "$FILE" && rm "$FILE"
ln -sfn "$PWD/${FILE%.tar.gz}" node
export PATH="$HOME/.thelab/tools/node/bin:$PATH"
```

On Windows, in PowerShell:

```powershell
$dir = "$env:USERPROFILE\.thelab\tools"; New-Item -ItemType Directory -Force $dir | Out-Null; cd $dir
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$file = ((curl.exe -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt) -match "win-$arch.zip").Split(' ')[-1]
curl.exe -fsSLO "https://nodejs.org/dist/latest-v24.x/$file"; tar -xf $file; Remove-Item $file
```

Node is then `node.exe` in the `node-v24...` folder it unpacked. Use that Node for every command below. Then fetch the source at the release tag and install its packages:

```sh
cd ~/.thelab && curl -fsSL https://github.com/SomethingObvious/the-lab/archive/refs/tags/v1.4.0.tar.gz | tar -xz
rm -rf source && mv the-lab-1.4.0 source
cd source/computer && npm ci
```

## 2. Sign the Agent In

The server runs his messages through the same kind of agent you are. If you're Claude, use `--engine claude`. If you're Codex, use `--engine codex`.

```sh
node setup.ts auth --engine claude   # if you're Claude
node setup.ts auth --engine codex    # if you're Codex
```

The choice is saved, so later steps don't need it again. The Claude engine keeps its own sign-in, so this opens a browser page unless it's already signed in. **He signs in** with the account that has his paid plan and clicks Authorize. The Codex engine shares the Codex app's sign-in, so if he's signed into the app it's already done. Otherwise **he signs in with ChatGPT** on the page that opens.

## 3. Start the Server

```sh
node setup.ts computer
node setup.ts selftest
```

The first sets up `~/TheLab`, installs the login item and starts the server, which also keeps the computer awake while it's plugged in (it uses `caffeinate -s` on a Mac and `SetThreadExecutionState` on Windows, so on battery it sleeps as usual, except while a task is running). Tell him that, since it's a change he'd otherwise notice. The second sends a real message through the server and waits for the agent's reply. Don't continue until it prints "Round trip works".

Then build The Lab's window for the computer:

```sh
node setup.ts desktop
```

It builds a small native window around the system's own web view, opens it off screen to check it signs in and draws the app, then opens it for him. On Windows it downloads Microsoft's WebView2 SDK from nuget.org (about 10 MB, checked against a fixed hash) and compiles with the C# compiler Windows already has, which takes a few seconds. On a Mac it compiles with Swift, which needs Apple's command line tools. If they're missing, the step opens Apple's installer and stops. **He clicks Install**, it takes 5 to 10 minutes, and then run the step again. Tell him the window is there for when he's at the computer, that it's the same app as the phone, and that closing it doesn't stop anything.

The computer asks for permission once or twice as the server starts, so he should be at the screen for it.

- On Windows, a Windows Security window asks whether Node.js may communicate on private networks. **He clicks Allow.** That's the encrypted tunnel that lets the phone come straight in over the Wi-Fi. Without it the phone still works through the relay, and if he clicks Cancel by mistake, step 5 notices and fixes it with one Yes. In Task Manager's Startup apps the server shows up as Console Window Host, from Microsoft, because that's what starts it without a window. Tell him it's The Lab so he doesn't turn it off.
- On a Mac, it asks whether The Lab Agent (the part of The Lab that runs the agent, listed apart from the window in the Mac's privacy lists) may access the Desktop, Documents and Downloads folders. **He clicks Allow on each**, or the agent can't see the files he asks about. The step waits for his answers. If he clicks Don't Allow, it opens System Settings at Files and Folders and waits while he switches them on under The Lab. Then it opens System Settings at Full Disk Access, with a Finder window showing The Lab. **He drags The Lab into the list and confirms with his password or Touch ID.** That lets the agent put deleted files back from the Trash and from Time Machine snapshots. In System Settings, General, Login Items, the server shows up as The Lab under Allow in the Background.

## 4. The Relay

If the message that started setup gave a relay address, use it:

```sh
node setup.ts relay --url https://the-lab-relay.example.workers.dev
```

The relay only passes sealed messages and can't read or change them, so any relay that's up will do.

Otherwise put up his own. It's a Cloudflare Worker on the free plan, which is far more than one person uses:

```sh
node setup.ts relay
```

The first time, a Cloudflare page opens in the browser. **He signs in, or makes a free account, and clicks Allow.** On a brand new account Cloudflare wants a name for the workers.dev address first. The step opens that page itself and waits while he types any name and clicks Set Up. The step checks the relay answers, saves its address and restarts the server.

If the relay can't go up at all, carry on without it. Pairing still works, and the phone reaches the computer whenever they're on the same Wi-Fi. Running this step later gives the phone the relay without pairing again.

## 5. The Phone

The phone is a Pixel Fold. Developer mode has to be on before a cable install works, so walk him through it:

1. Settings, About phone, then tap Build number seven times. The phone asks for his PIN and then says he's a developer.
2. Settings, System, Developer options, then turn on USB debugging.
3. Plug the phone into the computer with a USB-C cable that carries data (the one from the box does).
4. Unlock the phone. A prompt asks "Allow USB debugging?". Tick Always allow from this computer and tap Allow.

Then:

```sh
node setup.ts phone
```

It's fine to start this before he's done with developer mode. It downloads and builds first, then waits up to 10 minutes for the phone and says what it's waiting on, so tell him each thing it prints.

The first run downloads Java and the Android build tools into `~/.thelab/tools` (about 1 GB, 5 to 15 minutes), builds the app with a signing key that stays on this computer, installs it, grants notifications, keeps it running through battery saving, pairs it with this computer and opens it. Then it checks the phone came straight in over the Wi-Fi. If a firewall turned it away, it says so, and on Windows a prompt asks whether The Lab may make changes. **He clicks Yes**, and that opens the tunnel's port to the home Wi-Fi only.

He can turn USB debugging back off afterwards if he likes, though leaving it on makes updates easier.

If the phone ever loses its pairing (a new phone, or the app was reinstalled), run `node setup.ts pair`. It opens a QR code on the computer that works once for 10 minutes. He points the phone's camera at it, taps the link it finds and then Pair, and no cable is needed. The link opens The Lab directly, so nothing in it goes through the relay. It only works once The Lab is on the phone, so a new phone still needs `node setup.ts phone` over the cable first.

One phone can hold several computers. Run this setup on the other computer as well, and the phone asks whether to add it, with the first computer left as it was. Both stay connected at once, each with its own design and history, and he switches between them by tapping the computer's name under the title, under Your Computers in the menu, or by long-pressing the app icon. When the phone asks to pair, it shows a short check like `4F52 9C69` that the pairing page shows too, and he only says yes if they match. A computer can have up to 8 phones.

If a phone is lost, or a pairing turns up that he didn't make (the server says so in a notice), run `node setup.ts pair --reset` in `~/.thelab/source/computer`. It gives the computer a new key and unpairs every phone, so each one he still has needs `node setup.ts pair` again.

### The iPhone Code (Not Recommended)

**Do not set this up and do not offer it. If the owner only has an iPhone, tell them The Lab needs an Android phone.** The code has never run on a real iPhone, only in Apple's simulator. An install on a free Apple account stops opening after 7 days, and without the paid developer account nothing can tell them the agent is waiting for an OK while The Lab is in the background. Only carry on if the owner has heard all of that and still asks for it, and treat it as an unsupported experiment.

The iPhone app has to be built on a Mac with Xcode, so on a Windows PC it needs a Mac to build on. He needs an Apple account signed in under Xcode's Settings, Accounts. Plug the iPhone in, unlock it, tap Trust, and turn on Developer Mode under Settings, Privacy & Security if the phone asks. Then:

```sh
node setup.ts iphone --team HIS_TEAM_ID
```

It installs the app and opens the pairing code. He points the iPhone's camera at it and taps the link. A free Apple account has to reinstall this way every 7 days. The phone reaches the computer the same ways as Android, except that it can't look for the computer on the Wi-Fi when the computer's address changes, so it relies on the address the computer last told it and on the relay.

An iPhone freezes apps in the background, so notifications while The Lab is shut need Apple's push service, which takes the paid developer account. If he has one and wants that, have him create an APNs key on the developer site (Certificates, Identifiers & Profiles, Keys). Put the `.p8` file he downloads in `~/.thelab` and write `~/.thelab/apple-push.json`, then restart the server and run `node setup.ts iphone` again:

```json
{ "keyId": "ABC123DEFG", "teamId": "HIS_TEAM_ID", "topic": "com.somethingobvious.thelab", "keyFile": "AuthKey_ABC123DEFG.p8" }
```

If `--bundle` gave the app a different ID, `topic` has to match it. A push only ever says what kind of thing happened and never carries his words, because it passes through Apple.

### Tailscale (Optional)

If he already uses Tailscale, the phone can reach the computer over it as well, with no change on the phone. `node setup.ts tailscale` also gives the server an HTTPS address through `tailscale serve`, which an older pairing used. Neither is needed with the relay.

## 6. Check It

Have him send a message from The Lab on the phone, something like "What's my computer's battery at?". The reply should arrive within a few seconds, with each step shown as it happens. Then tell him four things.

- He can ask for changes to how the app looks, in plain words, and they show up on the phone right away.
- If a design change ever breaks the app, holding the app icon shows Safe Mode, which has Undo Last Design Change.
- The computer has to be on, and plugged in for anything scheduled. Closing a laptop's lid puts it to sleep unless it's connected to a display.
- Settings, in More, changes the look, the top bar's widgets and the model, and holding a widget goes straight to Edit the Top Bar.
- More, in the app's header, has Check My Setup, which says what isn't working and how to fix it.

On Android he can also make The Lab the phone's assistant (Settings, Apps, Default apps, Digital assistant app), so holding the power button opens it ready to type. The Lab also adds an Ask the computer tile to Quick Settings and a home screen widget, which he can add from the usual places.

## Updating

The server updates itself, with no agent involved. After an update it also builds the Android app again at low priority (`node setup.ts apk`), and a phone set up from this computer offers to install it over the tunnel. He taps Update and then Install, and the first time Android asks him to allow installs from The Lab. A phone set up from another computer only takes updates from that one, since each computer signs the app with its own key. Twice a day it asks GitHub for the newest release tag. A newer one gets merged with whatever was changed in `~/.thelab/source` since the last release, three ways and line by line, so a fix made here survives the update. Then it runs the tests on the merged copy at low priority, swaps it in while the agent is idle and restarts. If the new version stops three times before it settles, whenever that happens, the supervisor puts the old one back and won't try that version again. A restart he asked for, or another program holding the port, doesn't count. The same merge runs over `~/TheLab`, so new template sections reach his `CLAUDE.md` and his app without losing his changes. Anything that can't merge cleanly stays as he had it, with the new version beside it in `~/TheLab/.lab-update/` for the agent to bring together.

He can check or install from Settings, Updates on the phone, and turn off installing by itself there too. The one thing an update can't do alone is the phone app. If anything under `phone/` changed, plug the phone in and run `node setup.ts phone` again. It keeps its history and pairing.

## When The Lab's Own Code Is Wrong

If a step fails because of a bug in The Lab rather than something on this computer, fix it in `~/.thelab/source` and send the fix up. These rules are the same ones every change to The Lab is held to, and setup enforces them.

- Fix the cause, in the smallest change that does it. Don't add a retry, a timeout, a try/catch or a special case that makes the symptom go away while the cause stays.
- Match the file you're in, its names, its layout and the way it handles errors. Search for an existing helper before writing one.
- Never switch a lint rule off, add a suppression comment, loosen a type to `any`, skip or weaken a test, or leave a `TODO`.
- Once the code changes, every setup step except `check`, `lint`, `stop` and `remove` refuses to run until `node setup.ts lint` passes. It runs the lint rules with warnings counted, the type check and the tests, which takes 20 or so seconds. Fix what it lists the way the code around it is written, then run it again.
- Then send the fix with `report "What's wrong, in a few words" "What happened and what you changed"` from `source/computer`. It opens a pull request on SomethingObvious/the-lab, and an issue with the change written out when it can't. Without `gh` signed in it saves the report in `~/.thelab/reports` instead. Ask him before sending it, since it goes out under his GitHub account.

## When Something's Wrong

- `node setup.ts check` shows what isn't working.
- The server log is `~/.thelab/server.log`.
- "Signed out" notices on the phone have a Sign In button that fixes it from there. Running `node setup.ts auth` on the computer does the same job.
- To switch between Claude and ChatGPT later, run `node setup.ts auth --engine codex` (or `claude`), then `node setup.ts computer`. It picks up the last conversation it had on that engine, or starts a fresh one, and the history on the phone stays.
- If the phone says it can't reach the computer, check that the computer is awake and online. Check My Setup on the phone says whether the computer is connected to the relay and listening on the local network.
- To take The Lab off the computer, run `node setup.ts remove`. The server stops and no longer starts at sign-in. His workspace, his history and the app on the phone stay until he deletes them, and `node setup.ts computer` brings it all back.

## Installing Through Google Play (Optional)

Installing over a cable works without any accounts. If the owner would rather get updates from the Play Store, the app can go out through a Play Console internal testing track, which needs a Google Play developer account ($25 once) and is his call to make. `node setup.ts bundle` builds a signed `.aab`. Upload it to an internal testing release, add his Google account as a tester and open the opt-in link on the phone. Play signs what it hands out with its own key, so the Play copy can't install over a cable install. Uninstall the cable copy first, then pair again with `node setup.ts pair`. The history comes back from the computer.
