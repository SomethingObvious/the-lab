# Setting Up The Lab

These are instructions for the agent on the owner's Mac. Read the whole file first, then work through it top to bottom. Do every step yourself. The owner only needs to act where a step says so, and when that happens tell him exactly what to tap or click, one thing at a time, and wait for him to say it's done.

Every command in `computer/setup.ts` can be run again safely, so if something fails, fix the cause and rerun that step. `node setup.ts check` prints what is done and what is left at any point.

## What Gets Installed

- `~/TheLab/`, the workspace and the only folder the agent on the phone can change. It holds `app/` (the phone app's interface, which you can edit later when he asks), `CLAUDE.md` (also linked as `AGENTS.md`), `DESIGN.md`, `memory.md`, `shortcuts.json` and `schedules.json`.
- `~/.thelab/`, the server's own state: its token, history, log, the files he sends and the tools setup downloads. It sits outside the workspace so the agent can't loosen its own limits.
- `~/.thelab/source/`, this repository.
- A login item that keeps the server running (`~/Library/LaunchAgents/com.somethingobvious.thelab.plist`).
- Tailscale on the Mac and on the phone.
- The Lab on the phone, built on this Mac and installed over a USB cable.

Nothing is exposed to the internet. The phone reaches the Mac only through his own Tailscale network.

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

The first sets up `~/TheLab`, installs the login item and starts the server, which also keeps the Mac awake while it's plugged in (it uses `caffeinate -s`, so on battery it sleeps as usual). The second sends a real message through the server and waits for the agent's reply. Don't continue until it prints "Round trip works".

## 4. Tailscale on the Mac

If `node setup.ts check` says Tailscale is not installed, download the Mac app from https://tailscale.com/download/mac and open the installer. **He clicks through the installer**, allows the VPN configuration when macOS asks, and signs in. Any account works (Google, Apple, GitHub), but it has to be the same one on the phone later.

```sh
node setup.ts tailscale
```

This turns on `tailscale serve`, which gives the server an HTTPS address that only his own devices can reach. The first time, Tailscale may print a link to enable HTTPS for his network. If the step prints one, open it in the browser, have **him click Enable**, then run the step again. It prints the address when it's done.

## 5. The Phone

The phone is a Pixel Fold. Developer mode has to be on before a cable install works, so walk him through it:

1. Settings, About phone, then tap Build number seven times. The phone asks for his PIN and then says he's a developer.
2. Settings, System, Developer options, then turn on USB debugging.
3. Plug the phone into the Mac with a USB-C cable that carries data (the one from the box does).
4. Unlock the phone. A prompt asks "Allow USB debugging?". Tick Always allow from this computer and tap Allow.

Then:

```sh
node setup.ts phone
```

The first run downloads Java and the Android build tools into `~/.thelab/tools` (about 1 GB, 5 to 15 minutes), builds the app with a signing key that stays on this Mac, installs it, grants notifications, keeps it running through battery saving, pairs it with this Mac and opens it.

If Tailscale isn't on the phone yet, the step opens its Play Store page. **He taps Install, opens Tailscale, signs in with the same account as the Mac and accepts the VPN prompt.** Then:

```sh
node setup.ts phone-vpn
```

That makes Tailscale the phone's always-on VPN, so The Lab can reach the Mac from anywhere. He can turn USB debugging back off afterwards if he likes, though leaving it on makes updates easier.

If the phone ever loses its pairing (a new phone, or the app was reinstalled), run `node setup.ts pair`. It opens a QR code on the Mac that works once for 10 minutes. He points the phone's camera at it with Tailscale on, taps the link, then taps Pair, and no cable is needed.

## 6. Check It

Have him send a message from The Lab on the phone, something like "What's my Mac's battery at?". The reply should arrive within a few seconds, with each step shown as it happens. Then tell him four things.

- He can ask for changes to how the app looks, in plain words, and they show up on the phone right away.
- If a design change ever breaks the app, holding the app icon shows Safe Mode, which has Undo Last Design Change.
- The Mac has to be on and plugged in. Closing a MacBook's lid puts it to sleep unless it's connected to a display.
- More, in the app's header, has Check My Setup, which says what isn't working and how to fix it.

On Android he can also make The Lab the phone's assistant (Settings, Apps, Default apps, Digital assistant app), so holding the power button opens it ready to type. The Lab also adds an Ask the Mac tile to Quick Settings and a home screen widget, which he can add from the usual places.

## Updating

Updates run from the Claude or Codex app on the Mac, because the agent on the phone can't write to `~/.thelab`. Fetch the newer tag into `~/.thelab/source` the same way as step 1 (his `~/TheLab/app` is never touched), run `npm ci` in `source/computer`, then `node setup.ts computer` to restart the server. Then compare `source/computer/template/CLAUDE.md` with `~/TheLab/CLAUDE.md` and add any sections his copy is missing, keeping his own changes. Setup already adds any other template file he doesn't have. If anything under `source/phone` changed, plug the phone in and run `node setup.ts phone` again. The app keeps its history and pairing across updates.

## When Something's Wrong

- `node setup.ts check` shows what isn't working.
- The server log is `~/.thelab/server.log`.
- "Signed out" notices on the phone mean `node setup.ts auth` needs running again.
- To switch between Claude and ChatGPT later, run `node setup.ts auth --engine codex` (or `claude`), then `node setup.ts computer`. It picks up the last conversation it had on that engine, or starts a fresh one, and the history on the phone stays.
- If the phone says it can't reach the Mac, check that the Mac is awake and on Tailscale, then that Tailscale is connected on the phone.

## Installing Through Google Play (Optional)

Installing over a cable works without any accounts. If the owner would rather get updates from the Play Store, the app can go out through a Play Console internal testing track, which needs a Google Play developer account ($25 once) and is his call to make. `node setup.ts bundle` builds a signed `.aab`. Upload it to an internal testing release, add his Google account as a tester and open the opt-in link on the phone. Play signs what it hands out with its own key, so the Play copy can't install over a cable install. Uninstall the cable copy first, then pair again with `node setup.ts pair`. The history comes back from the Mac.
