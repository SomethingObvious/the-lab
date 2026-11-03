# The Lab

The Lab lets you message the agent on your Mac from an Android phone. You see each step it takes as it happens, approve anything risky from the phone, and change how the app looks by asking for it in plain words.

It runs on whichever plan you already pay for, Claude (Pro or Max) or ChatGPT (Plus or Pro, through Codex). It has two parts. A small server on the Mac runs the agent, keeps the conversation and history, and restarts itself after a crash or a reboot. The Android app (built for the Pixel Fold, and fine on any phone running Android 12 or later) holds a live connection to that server, keeps an ongoing notification showing what the agent is doing, and queues messages while the Mac is out of reach. The two talk over Tailscale, so nothing is open to the internet.

The app's interface is a web page kept on the Mac in `~/TheLab/app`. When you ask the agent for a change, it edits that page and the phone picks it up within a couple of seconds. If a change ever breaks things, the app falls back to a built-in safe screen with an undo button.

Ask for something regular ("every weekday at 8, tell me what's on my calendar") and the agent adds it to `~/TheLab/schedules.json`, and the server sends it that message on time while the Mac is awake. The agent also keeps notes about you and anything ongoing in `~/TheLab/memory.md`, which it reads at the start of every conversation.

## Setting It Up

You need a Mac, an Android phone, a USB-C cable and one of those paid plans. You don't need to type any commands, since the agent does all of that and stops when it needs you to click or tap something.

1. Install the agent app for your plan and sign in with that account.
   - Claude: download the Claude app from https://claude.ai/download, open it and switch to Code.
   - ChatGPT: download the Codex app from https://chatgpt.com/codex (it needs an Apple Silicon Mac).
2. Start a new conversation, choose your home folder if it asks for one, and paste this message:

   ```
   Set up The Lab on this Mac and my Android phone, following
   https://github.com/SomethingObvious/the-lab/blob/v1.0.0/SETUP.md
   ```

3. Allow it to run commands when it asks. Setup takes about half an hour, most of it downloads.

## Limits

- The Mac has to be awake. The server keeps it awake while it's plugged in, but a closed MacBook lid still puts it to sleep.
- Messages draw from the same plan limits as the rest of your use of Claude or ChatGPT.
- There is no iPhone app.
- The app is built on your own Mac and installed over USB, so it isn't on the Play Store.
