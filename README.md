# The Lab

The Lab lets you message the agent on your Mac or Windows PC from an Android phone. You see each step it takes as it happens, approve anything risky from the phone, and change how the app looks by asking for it in plain words.

It runs on whichever plan you already pay for, Claude (Pro or Max) or ChatGPT (Plus or Pro, through Codex). It has two parts. A small server on the Mac runs the agent, keeps the conversation and history, and restarts itself after a crash or a reboot. The Android app (built for the Pixel Fold, and fine on any phone running Android 13 or later) holds a live connection to that server, keeps an ongoing notification showing what the agent is doing, and queues messages while the Mac is out of reach. The two talk through an end-to-end encrypted tunnel, straight over the Wi-Fi at home and through a small relay everywhere else. The relay only ever sees sealed bytes, and the server itself is never open to the internet or the local network. Tailscale works too, for anyone who already uses it.

The app's interface is a web page kept on the Mac in `~/TheLab/app`. When you ask the agent for a change, it edits that page and the phone picks it up within a couple of seconds. A change that doesn't parse never reaches the phone, and if one still fails to open there, the server puts the version before it back by itself and the phone shows a built-in safe screen with an undo button in the meantime.

Ask for something regular ("every weekday at 8, tell me what's on my calendar") and the agent adds it to `~/TheLab/schedules.json`, and the server sends it that message on time while the Mac is awake. The agent also keeps notes about you and anything ongoing in `~/TheLab/memory.md`, which it reads at the start of every conversation. You can see and edit both from the app's More menu.

Settings, also in More, covers the look (theme, text size, motion), how steps show, and the model, picked from whatever the provider offers right now. The top bar is a row of widgets you choose and size the way you would on a home screen, such as battery, storage, memory, uptime, the current task or the next schedule, and it folds away with one tap. The agent can add a widget or a setting when you ask for one.

The agent can read and change files freely, but it asks on the phone before it sends anything off the Mac, installs software, changes settings or deletes something it can't put in the Trash. Each request says in plain words what it does and whether it can be undone, worked out from the command itself rather than from what the agent says about it. Deleted files go to the Trash (the Recycle Bin on Windows), and on a Mac the server takes a Time Machine local snapshot before each task, so a task that went wrong can be put back from the phone.

## Setting It Up

You need a Mac or a Windows 10 or 11 PC, an Android phone, a USB-C cable and one of those paid plans. You don't need to type any commands, since the agent does all of that and stops when it needs you to click or tap something.

1. Install the agent app for your plan and sign in with that account.
   - Claude: download the Claude app from https://claude.ai/download, open it and switch to Code.
   - ChatGPT: download the Codex app from https://chatgpt.com/codex (it needs an Apple Silicon Mac).
2. Start a new conversation, choose your home folder if it asks for one, and paste this message:

   ```
   Set up The Lab on this computer and my Android phone, following
   https://github.com/SomethingObvious/the-lab/blob/v1.0.0/SETUP.md
   ```

3. Allow it to run commands when it asks. Setup takes about half an hour, most of it downloads.

## Limits

- The computer has to be awake. The server keeps it awake while it's plugged in and for as long as a task runs on battery, but closing a laptop's lid (a MacBook Air included) still puts it to sleep.
- Messages draw from the same plan limits as the rest of your use of Claude or ChatGPT.
- There is no iPhone app.
- The app is built on your own Mac and installed over USB, so it isn't on the Play Store.
- Away from home it needs the relay, a free Cloudflare Worker in `relay/`. One relay can serve any number of computers, and setup can point a new install at one that's already up.
- The agent can still get things wrong, and an action it isn't asked about (editing a document, say) happens straight away. Put Things Back depends on local snapshots, which may need Time Machine turned on, and on Windows there are none, so the Recycle Bin is the only undo.
- It's for one person. Whoever holds the paired phone can do anything the agent can.
