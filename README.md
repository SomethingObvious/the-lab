# The Lab

The Lab is an Android app for messaging the coding agent on your own computer, Claude Code or Codex, from your phone. You send a request to your Mac or Windows PC, watch every step the agent takes as it happens, and approve anything risky with one tap. It works over Wi-Fi at home and through an end-to-end encrypted relay everywhere else, with nothing on the computer open to the internet.

It runs on the plan you already pay for, Claude (Pro or Max) or ChatGPT (Plus or Pro, through Codex), so there is no API key and no extra bill. The agent on the other end is the real one on your computer, with your files, apps and tools, and the phone is a remote for it.

## How It Works

A small Node server on the computer runs the agent through the Claude Agent SDK or Codex. It keeps the conversation and history, restarts itself after a crash and starts again when you sign in after a reboot. The Android app (built for the Pixel Fold, and fine on any phone with Android 13 or later) holds a live connection to that server, shows the current task in a notification and queues messages while the computer is out of reach. It picks the connection back up a few seconds after the Wi-Fi drops or the computer wakes.

The phone and computer talk through an end-to-end encrypted tunnel, straight over the Wi-Fi at home and through a small Cloudflare Worker relay elsewhere. The relay only ever sees sealed bytes. Tailscale works too, for anyone who already uses it.

Each step shows up on the phone with a plain title, and one tap opens the exact command, file or web address behind it. The agent can send you files and screenshots, and a running task can be stopped at any point without losing the conversation.

## What It Asks Before Doing Something

You pick how much the agent asks, and you can switch from the phone at any time.

- Plan looks around and tells you its plan, but doesn't change, run or send anything.
- Manual asks before it changes, runs or sends anything.
- Auto, the default, goes ahead with everyday work, including installs and a plain git push, and asks before it sends something to someone, changes settings or deletes something it can't put in the Trash. Once it has read a web page or an email in a task, installs, pushes and any program it runs ask too.
- Bypass does everything without asking.

Switching to a mode that asks less needs your OK, so the agent can't loosen its own rules. Each request says in plain words what the step does and whether it can be undone, worked out from the command itself rather than from what the agent says about it. Deleted files go to the Trash (the Recycle Bin on Windows), and on a Mac the server takes a Time Machine local snapshot before each task, so Put Things Back on the phone can undo a task that went wrong.

## Talk to It

On the phone, the mic button next to the message box uses Android's own speech screen, so the app never holds the microphone. Replies to something you said get read back, which Read Replies Aloud in Settings can change to always or never. The computer's window can read replies aloud, but it has no mic button.

## Chat Commands

Type /help for the list. /new starts a new conversation, /retry sends your last message again, /usage and /insights show what it has been doing, and /model, /personality, /skills and /bots do what they say. Anything else starting with a slash goes to the agent.

## Bots and the Box

A bot is a file in `~/TheLab/bots` that says who it is, and asking the agent is the easiest way to make one. Write @name in a message and it answers as that bot, with that bot's own notes. Bots share one conversation and one engine for now.

The agent can run commands in a Docker container that only sees the Lab folder, or on another machine over SSH, using the `box` command. Docker or SSH has to be set up on the computer already, and SSH asks you first.

## Use Other Apps

The agent can read and press the controls in other apps on the computer, without screenshots and mostly without taking the mouse. You get asked the first time it uses an app in a task and again before anything that looks final, like Send or Delete. Password managers, security settings and password fields are off limits, and `neverApps` in `~/.thelab/config.json` adds to that list.

## Change the App by Asking

The app's interface is a web page kept on the computer in `~/TheLab/app`. Ask for a change ("make the send button orange") and the agent edits that page, and the phone picks it up within a couple of seconds. A change that doesn't parse never reaches the phone. If one still fails to open there, the server puts the version before it back by itself and the phone shows a built-in safe screen with an undo button.

Settings, in the More menu, covers the theme, text size, motion, the status notification and the model. The top bar is a row of widgets you choose and size the way you would on a home screen, such as battery, storage, the current task or the next schedule.

Ask for something regular ("every weekday at 8, tell me what's on my calendar") and the server sends the agent that message on time while the computer is awake. The agent also keeps notes about you in `~/TheLab/memory.md` and reads them at the start of every conversation.

## A Window on the Computer

The Lab also has its own window, in the Start menu on Windows and in Applications on a Mac. It shows the same app as the phone with the conversations down the side. It is a native window around the system's own web view, built during setup, so it comes to about 125 MB with nothing to download.

The server keeps itself up to date. Twice a day it checks this repository for a newer release, tests it and swaps it in while the agent is idle, and it puts the old version back if the new one won't stay up.

## Setting It Up

You need a Mac or a Windows 10 or 11 PC, an Android phone, a USB-C cable and one of those paid plans. You don't type any commands, since the agent does all of that and stops when it needs you to click or tap something.

1. Install the agent app for your plan and sign in with that account.
   - Claude: download the Claude app from https://claude.ai/download, open it and switch to Code.
   - ChatGPT: download the Codex app from https://chatgpt.com/codex (it needs an Apple Silicon Mac).
2. Start a new conversation, choose your home folder if it asks for one, and paste this message:

   ```
   Set up The Lab on this computer and my Android phone, following
   https://github.com/SomethingObvious/the-lab/blob/v1.2.0/SETUP.md
   ```

3. Allow it to run commands when it asks. Setup takes about half an hour, and most of that is downloads.

## Questions

### Do I Need a Server or VPS?

No. The agent runs on your own Mac or PC, and the phone reaches it directly at home or through the free relay elsewhere.

### Is There an iPhone App?

Not one you should use. **Use an Android phone. We recommend that people and agents do not set up or rely on the iPhone code.** It is unsupported, and it stays in `iphone/` only for anyone who wants to read it or take it further.

- It has never run on a real iPhone, only in Apple's simulator, and its push notifications have only been tried against a stand-in for Apple's service.
- Building it takes a Mac with Xcode, and an install on a free Apple account stops opening after 7 days until it is installed again from that Mac.
- Without the $99 a year developer account you won't hear anything while The Lab is frozen in the background, including when the agent is waiting for your OK.
- Giving it to other people takes that same paid account. TestFlight builds expire after 90 days, and Apple may refuse it for the App Store because the app rewrites its own screen.

### Is It on the Play Store?

No. The app is built on your own computer and installed over USB, so you never install a build someone else made.

### Does It Cost Anything Beyond My Plan?

No. Messages count against the same plan limits as the rest of your use, and the relay runs on Cloudflare's free tier.

## Limits

- The computer has to be awake. The server keeps it awake while it's plugged in and while a task runs on battery, but closing a laptop's lid still puts it to sleep.
- The agent can still get things wrong, and an action it isn't asked about (editing a document, say) happens straight away. Windows has no local snapshots, so the Recycle Bin is the only undo there.
- The server checks the sign-in once an hour, which costs nothing unless that check comes back empty on Claude, and then it's one very short message. If the sign-in stops working, the phone tells you and you can sign back in from there.
- It's for one person. Whoever holds the paired phone can do anything the agent can. One phone can be paired with several computers at once, and each keeps its own design and history.
