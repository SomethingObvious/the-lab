---
name: change-the-app
description: Use whenever he asks to change how The Lab looks or works on his phone, or to add or remove a widget, setting, button, sheet or screen in it. Says where each kind of thing goes in app/, what has to keep working, and how to check a change before he sees it.
---

# Changing the App

The app on his phone is the web page in `app/`, and The Lab's window on this computer shows the same page, so a change reaches both. He can't fix it if it breaks, and a broken app is also how he would ask you to fix it, so keep every change small and check it before you finish.

## Where Things Go

`app/index.html` has the markup and the icon set (each icon is a `<symbol id="i-name">`, drawn with `icon('name')` in the script). `app/app.css` starts with the design tokens from `DESIGN.md`, then styles each part in the order the page draws it. `app/app.js` is one script, and most additions are one entry in one of its lists.

- A widget in the top bar is an entry in `Widgets`. Give it `name`, `about`, `sizes` (any of `small`, `wide`, `long` and `big`, the first being the default), `tone` (`sun`, `mint`, `pink`, `lilac` or `deep`) and `data()`, which returns `{ value, label, detail, meter, icon }` or `null` to stay hidden. Add `tap()` if a tap should do something other than open the details. It can read `mac` (`name`, `os`, `battery`, `disk`, `memory`, `cpu`, `uptime`, `at`), `status`, `link`, `items` (the conversation), `upcoming` (the schedules) and `settings`. Once it's in `Widgets` he can add it from Edit the Top Bar. To put it in his top bar now, add `{ "id": "...", "size": "..." }` to `topBar` in `settings.json`.
- A setting is a row in `Settings`, with `key`, `type` (`switch`, `choice` with `options`, or `open` with `open()`), `label` and maybe `hint` and `apply()`. Its value is saved in `settings.json` under `key`, read anywhere as `settings.key`, and its default goes in `DefaultSettings`. The server keeps any key it doesn't know as long as the value is a string, number, true, false or null.
- A row in the More menu is a `row(...)` in `openMenu()` plus a line under `if (d.menu)` in the click handler.
- A sheet is `openSheet(kind, title, bodyHtml, actionsHtml)`, and `closeSheet()` closes it.
- A new kind of event gets a `case` in `take(e)`.
- A button is a `<button type="button" data-something="...">`, handled by a line in the one click listener (`if (d.something) ...`). There is no other place clicks are caught.

Escape everything that came from outside with `esc()` before putting it in HTML, since replies, file names and model names can hold anything.

## What Has to Keep Working

These have to stay visible and working whatever the look: the message box, Stop while you're working, Allow and Deny on every request along with where it came from and what it does, the connection state when the computer can't be reached, messages still waiting to send, Put Things Back, and the More menu (Settings, Memory, Schedules, Always Allowed and Check My Setup). The page still calls `lab.ready()` once it has drawn, has no internet (everything it loads is in `app/`), pads with the `--lab-inset-*` variables, and works folded (about 410 pixels wide), unfolded (about 850), in the computer's window (960 wide to begin with, and as wide as his screen), with large text, and in light and dark. Something only for the phone or only for the computer can check `lab.platform`, which is `android` or `desktop`.

## The Safety Nets

They're there so a mistake costs him a minute instead of the app, so leave them in place.

- A change where a script or JSON file doesn't parse, `index.html` is missing, or the lint rules find something new stays on this computer. The phone keeps the last version that worked, and you're told what's wrong right after the edit. Fix it in the same turn.
- Each part of the page is drawn inside `guard(where, fn)`. A part that throws is left out (a message that can't be drawn shows as a short red line) and reported, so one bad widget or setting can't take the rest down. Wrap anything new that could throw the same way, and don't take `guard` out of the drawing code.
- Errors on the phone are logged in `~/.thelab/app-errors.log`, and the server starts a quiet Self-Repair turn for each new one so you can fix it before he notices. If one shows up at the top of his next message instead, fix it first.
- If the page doesn't call `lab.ready()` within 8 seconds, the phone shows its safe screen and the server puts the version before your change back by itself. He'll see a notice saying so, and you'll hear what failed.
- The server keeps the last 30 versions. "Undo" from him means `lab.undoDesign()`, or the Undo button on the safe screen.

## Writing the Code

Code that only works is not enough here, because he can't read it and nobody else will tidy it up later. Every change has to read as if the person who wrote the file around it wrote it too.

- Search the file before adding anything. If a helper, a list or a pattern already does most of it, use that and add one entry rather than a second way of doing the same thing.
- Make the smallest change that does what he asked. No options he didn't ask for, no code kept "in case", and nothing left commented out.
- Fix a problem where it starts. If one part of the page draws wrong, change the code that draws it, not a second rule or check stacked on top to hide it.
- Name things for what they hold, the way the names around them do. Write a comment only to say why something isn't the obvious way, never what the next line does or that you changed it.
- No `TODO`, `FIXME` or `XXX`, no `console.log`, no `var`, no code that's never used, and never a comment that switches a lint rule off. The checks treat all of those as mistakes.

`check-app` runs the same lint rules over `app/` that every change to The Lab passes. A change that adds even one finding stays on this computer, like one that doesn't parse, and the server tells you what it found. `check-app --fix` lays the files out the way the rules want (spacing, quotes and line breaks), so run that first, then `check-app` again and fix what's left by hand. Don't weaken a rule or move code somewhere it isn't checked to get past it.

## Checking a Change

1. Run `check-app --fix`, then `check-app`. It should print nothing.
2. Open the desktop view as CLAUDE.md describes and look at what you changed, folded width first, then at 1280 wide, where the conversations sit down the side.
3. If you touched the header, a sheet or the composer, look with the keyboard open and in dark mode too.

Make one change at a time with Edit, not by rewriting a whole file. If the request is to change the look itself, update `DESIGN.md` too, so the next change keeps it. Then tell him what changed in a sentence.
