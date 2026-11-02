# The Lab

The Lab lets you message the agent on your Mac from an Android phone. You see each step it takes as it happens, approve anything risky from the phone, and change how the app looks by asking for it in plain words.

It has two parts. A small server on the Mac runs the agent through the Agent SDK, keeps the conversation and history, and restarts itself after a crash or a reboot. The Android app (built for the Pixel Fold, and fine on any phone running Android 12 or later) holds a live connection to that server, keeps an ongoing notification showing what the agent is doing, and queues messages while the Mac is out of reach. The two talk over Tailscale, so nothing is open to the internet.

The app's interface is a web page kept on the Mac in `~/TheLab/app`. When you ask the agent for a change, it edits that page and the phone picks it up within a couple of seconds. If a change ever breaks things, the app falls back to a built-in safe screen with an undo button.

## Setting It Up

Give the agent on your Mac this message and it does the rest, stopping when it needs you to tap something:

```
Set up The Lab on this Mac and my Android phone, following
https://github.com/SomethingObvious/the-lab/blob/v1.0.0/SETUP.md
```

You need a Mac whose agent can run terminal commands, a paid plan for that agent, an Android phone and a USB-C cable. Setup takes about half an hour, most of it downloads.

## Limits

- The Mac has to be awake. The server keeps it awake while it's plugged in, but a closed MacBook lid still puts it to sleep.
- Messages draw from the same plan limits as the rest of your use.
- There is no iPhone app.
- The app is built on your own Mac and installed over USB, so it isn't on the Play Store.
