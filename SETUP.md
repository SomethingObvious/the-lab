# Setting Up The Lab

These are instructions for the agent on the owner's computer. Read the whole file first, then work through it top to bottom. Do every step yourself. The owner only needs to act where a step says so, and when that happens tell him exactly what to tap or click, one thing at a time, and wait for him to say it's done.

On a Windows PC the steps are the same with three differences. Install Node 24 or later with `winget install OpenJS.NodeJS` instead of the download below (he clicks Yes when Windows asks), use `curl.exe` and `tar` (both come with Windows 10 and 11) to fetch the source into `%USERPROFILE%\.thelab\source`, and read `~` as `%USERPROFILE%` throughout. Git Bash is optional. Setup and the server use PowerShell and cmd where they need a shell, and the agent's commands run in whichever shell it already has.

Every command in `computer/setup.ts` can be run again safely, so if something fails, fix the cause and rerun that step. `node setup.ts check` prints what is done and what is left at any point.

## What Gets Installed

- `~/TheLab/`, the workspace and the only folder the agent on the phone can change. It holds `app/` (the phone app's interface, which you can edit later when he asks), `CLAUDE.md` (also linked as `AGENTS.md`), `DESIGN.md`, `memory.md`, `shortcuts.json` and `schedules.json`.
- `~/.thelab/`, the server's own state: its token, history, log, the files he sends and the tools setup downloads. It sits outside the workspace so the agent can't loosen its own limits.
- `~/.thelab/source/`, this repository.
- A login item that keeps the server running (`~/Library/LaunchAgents/com.somethingobvious.thelab.plist` on a Mac, a `TheLab` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` on Windows, which starts it hidden when he signs in).
- A relay on Cloudflare's free plan, unless he was given the address of one that's already up.
- The Lab on the phone, built on this computer and installed over a USB cable.

Nothing is exposed to the internet. The server listens only on the computer itself, and the phone reaches it through an encrypted tunnel, straight over the Wi-Fi when they share one and through the relay otherwise. The keys come from pairing and never leave the two devices, so the relay can't read or change anything it passes.

## 1. Node and the Source

Check for Node 24 or later with `node --version`. If it's missing or older, install it into the workspace so no admin password is needed:

```sh
mkdir -p ~/.thelab/tools && cd ~/.thelab/tools
ARCH=$(uname -m | sed 's/x86_64/x64/')
FILE=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep "darwin-$ARCH.tar.gz" | awk '{print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$FILE" && tar -xzf "$FILE" && rm "$FILE"
ln -sfn "$PWD/${FILE%.tar.gz}" node
export PATH="$HOME/.thelab/tools/node/bin:$PATH"
```

Use that `PATH` for every command below. Then fetch the source at the release tag and install its packages:

```sh
cd ~/.thelab && curl -fsSL https://github.com/SomethingObvious/the-lab/archive/refs/tags/v1.0.0.tar.gz | tar -xz
rm -rf source && mv the-lab-1.0.0 source
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

The first sets up `~/TheLab`, installs the login item and starts the server, which also keeps the computer awake while it's plugged in (it uses `caffeinate -s` on a Mac and `SetThreadExecutionState` on Windows, so on battery it sleeps as usual, except while a task is running). The second sends a real message through the server and waits for the agent's reply. Don't continue until it prints "Round trip works".

## 4. The Relay

If the message that started setup gave a relay address, use it:

```sh
node setup.ts relay --url https://the-lab-relay.example.workers.dev
```

Only use a relay run by someone he trusts with his computer. It can't read the messages it passes, but it serves the page a pairing QR code opens, so it could read that code. Pairing over the USB cable never goes near it.

Otherwise put up his own. It's a Cloudflare Worker on the free plan, which is far more than one person uses:

```sh
node setup.ts relay
```

The first time, a Cloudflare page opens in the browser. **He signs in, or makes a free account, and clicks Allow.** If Cloudflare asks him to pick a workers.dev subdomain, any name works. The step checks the relay answers, saves its address and restarts the server.

On Windows, the first time the server starts listening for the phone on the local network, Windows asks whether Node.js may use private networks. **He clicks Allow.** Without it the phone still works through the relay, just never straight over the Wi-Fi.

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

The first run downloads Java and the Android build tools into `~/.thelab/tools` (about 1 GB, 5 to 15 minutes), builds the app with a signing key that stays on this computer, installs it, grants notifications, keeps it running through battery saving, pairs it with this computer and opens it.

He can turn USB debugging back off afterwards if he likes, though leaving it on makes updates easier.

If the phone ever loses its pairing (a new phone, or the app was reinstalled), run `node setup.ts pair`. It opens a QR code on the computer that works once for 10 minutes. He points the phone's camera at it, opens the link, taps Open The Lab and then Pair, and no cable is needed. The link opens a page on the relay, but everything after the `#` stays on the phone.

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

Updates run from the Claude or Codex app on the computer, because the agent on the phone can't write to `~/.thelab`. Fetch the newer tag into `~/.thelab/source` the same way as step 1 (his `~/TheLab/app` is never touched), run `npm ci` in `source/computer`, then `node setup.ts computer` to restart the server. Then compare `source/computer/template/CLAUDE.md` with `~/TheLab/CLAUDE.md` and add any sections his copy is missing, keeping his own changes. Setup already adds any other template file he doesn't have. If anything under `source/phone` changed, plug the phone in and run `node setup.ts phone` again. The app keeps its history and pairing across updates.

## When Something's Wrong

- `node setup.ts check` shows what isn't working.
- The server log is `~/.thelab/server.log`.
- "Signed out" notices on the phone mean `node setup.ts auth` needs running again.
- To switch between Claude and ChatGPT later, run `node setup.ts auth --engine codex` (or `claude`), then `node setup.ts computer`. It picks up the last conversation it had on that engine, or starts a fresh one, and the history on the phone stays.
- If the phone says it can't reach the computer, check that the computer is awake and online. Check My Setup on the phone says whether the computer is connected to the relay and listening on the local network.

## Installing Through Google Play (Optional)

Installing over a cable works without any accounts. If the owner would rather get updates from the Play Store, the app can go out through a Play Console internal testing track, which needs a Google Play developer account ($25 once) and is his call to make. `node setup.ts bundle` builds a signed `.aab`. Upload it to an internal testing release, add his Google account as a tester and open the opt-in link on the phone. Play signs what it hands out with its own key, so the Play copy can't install over a cable install. Uninstall the cable copy first, then pair again with `node setup.ts pair`. The history comes back from the computer.
