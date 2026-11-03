# The Lab

@memory.md

This folder is the workspace for The Lab. Messages typed into The Lab on the owner's phone come to you here, through a small server on this Mac, and your replies and every step you take show up on the phone as they happen. Requests that need permission show on the phone as Allow and Deny buttons.

## What's Here

- `app/` is the phone app's interface, a plain web page (HTML, CSS and JavaScript). Whatever you save here reaches the phone within a couple of seconds.
- `DESIGN.md` is the design system for `app/`. Read it before changing anything there.
- `shortcuts.json` holds the one-tap shortcuts shown in the app, as a list of `{ "id", "label", "text" }`. When he asks for a shortcut, add it here and it shows up on the phone within a second. Keep labels to a few words.
- `schedules.json` holds messages the server sends you on a timer, as a list of `{ "id", "label", "text", "time" }` with `time` as 24-hour `"HH:MM"` in this Mac's time zone. Add `"days": ["mon", "fri"]` to run only on those days, or `"date": "YYYY-MM-DD"` to run once. When he asks for something regular ("every morning tell me the weather", "remind me Friday at 5"), add it here and tell him when it'll first run. A new entry whose time has already passed today waits until its next one. The Mac has to be awake. If you're busy at that time it waits until you're done, and a run more than 30 minutes late is skipped. When one comes in, the message tells you it's scheduled.
- `memory.md` is your notes about him and what's ongoing, and it's loaded at the start of every conversation. When he says to remember something, or you learn something that will matter next time (a preference, a name, a project you're partway through), add it there in a line or two. Keep it short and take out what's no longer true.
- `.lab/` belongs to the server. Read the log (`.lab/server.log`) when something is wrong, but don't edit anything in it.
- `source/` is the code for the server and the Android app. Don't change it unless he asks for that specifically, since updates replace it.

## Changing the App

He asks for changes to the app in plain words, like "make it darker", "bigger text" or "show the time on each message". Make the change in `app/`, keeping to `DESIGN.md` unless the request is to change the design itself, in which case update `DESIGN.md` too so later changes keep the new look. Then tell him what changed, in a sentence.

The server keeps the last 30 versions of `app/`. If he says a change made things worse, or the phone ends up on its safe screen, "undo" restores the version before your last change, and the phone's safe screen has an Undo Last Design Change button that does the same thing.

These rules keep the app working on the phone.

- Everything has to be inside `app/`. The phone loads the page from its own copy and has no internet access for it, so a CDN script, a Google Fonts link or a hotlinked image will not load. Download fonts as `.woff2` into `app/` and keep images there too.
- Call `lab.ready()` once the page has drawn. If it isn't called within 8 seconds, the phone assumes the page is broken and shows its safe screen.
- The page draws behind the status bar and the gesture bar. Pad with the CSS variables `--lab-inset-top`, `--lab-inset-bottom`, `--lab-inset-left` and `--lab-inset-right`. The keyboard counts as an inset too. While it's open `--lab-inset-bottom` is its height, updated every frame as it slides, and `html` has a `data-keyboard` attribute, so anything pinned to the bottom has to sit above `--lab-inset-bottom` and shouldn't add a transition of its own. When the phone is half open, `html` has `data-fold="book"` (hinge running up and down) or `data-fold="tabletop"` (hinge across), and `--lab-hinge-left`, `--lab-hinge-top`, `--lab-hinge-right` and `--lab-hinge-bottom` give the hinge's edges, so nothing important should cross it.
- The phone is a Pixel Fold, so the page has to work at about 410 pixels wide folded and about 850 unfolded, and in both light and dark (`prefers-color-scheme`).
- Some things must always stay visible and work, whatever the look: the message box, a Stop button while you're working, Allow and Deny on every request, the connection state when the Mac can't be reached, and messages still waiting to send.
- Keep the page fast. It's a phone, so no frameworks or build step, and nothing animating on a loop except the working loaders and the mark that waits on him, as DESIGN.md says.

To try a change before he sees it, open `http://127.0.0.1:8417/pair?t=TOKEN` in a browser on this Mac, using the token in `.lab/config.json`. It shows the same page, live, with the same `window.lab` as the phone.

## The `window.lab` API

The page talks to the phone and the server only through `window.lab`, which is there before any script on the page runs.

| Call | What it does |
|---|---|
| `lab.subscribe(fn)` | Calls `fn(event)` for every event, starting with the history. Returns a function that unsubscribes. |
| `lab.send(text, files)` | Sends a message, with an optional list of files from `lab.attach`. Returns its `cid`, which comes back on the matching `you` event. If the Mac is unreachable it waits in the outbox and sends later. |
| `lab.attach(kind)` | `kind` is `'photos'` or `'files'`. Opens the phone's picker, uploads what he picks to the Mac and resolves to a list of `{ name, url, size, type }` (empty if he cancelled). Rejects with a readable message if the upload fails. |
| `lab.saveShortcuts(items)` | Replaces the shortcut list with `items` (`{ id, label, text }`). Resolves to `true` or `false`. A fresh `shortcuts` event follows, so draw from that. |
| `lab.stop()` | Stops what you're doing. |
| `lab.answer(ref, allow)` | Answers an `ask` with `true` or `false`. |
| `lab.undoDesign()` | Restores the previous version of `app/`. |
| `lab.open(url)` | Opens a link, or a file from a `file` event, in the right app on the phone. |
| `lab.fileUrl(url, { w })` | Turns a file's `url` into one an `<img>` can load. With `w`, it's a smaller copy whose short side is at least `w` pixels, so use about twice the CSS size for thumbnails. |
| `lab.fix(fix)` | Opens whatever fixes a `link` problem (`fix` comes from the `link` event). |
| `lab.retry()` | Tries to reconnect now. |
| `lab.safeMode()` | Switches to the phone's safe screen. |
| `lab.onBack(fn)` | Set it only while something is open that back should close, and pass `null` once it's closed, so back can leave the app with the system's own animation. |
| `lab.ready()` | Tells the phone the page has drawn. |
| `lab.platform` | `'android'` on the phone, `'web'` in a browser. |

The events are saved in history and replayed to `subscribe` when the page loads.

| Event | Fields |
|---|---|
| `you` | `text`, `cid`, and `files` if he attached any. A message he sent. A message from `schedules.json` also has `scheduled`, the entry's label. |
| `reply` | `text`. Your reply, in Markdown. |
| `step` | `ref`, `tool`, `title`, `detail`, `sub` (true inside a subagent). `title` is the plain version, `detail` the raw command or diff. |
| `failed` | `ref`, `text`. The step with that `ref` failed. |
| `ask` | `ref`, `tool`, `title`, `detail`. Needs Allow or Deny. |
| `answered` | `ref`, `allow`, `by`. |
| `done` | `ok`, `stopped`, `ms`, `error`. The end of a turn. |
| `notice` | `text`, and maybe `action` (`label`, `send`), a button that sends `send` as a message. |
| `file` | `name`, `url`, `size`, `caption`. |

Every saved event also has `id` and `at` (an ISO time). These events are live only and are never replayed.

| Event | Fields |
|---|---|
| `status` | `working`, `label` (what you're doing now), `since`. |
| `link` | `state` (`online`, `connecting`, `offline` or `unpaired`), `detail`, `fix`. |
| `mac` | `name`, `battery` (`percent`, `charging`, or `null` on a desktop Mac), `disk` (`free`, `total` in bytes), `uptime` in seconds, `at`. Every minute while connected. The phone replays the last one while offline, so check `at`. |
| `shortcuts` | `items`, the saved shortcuts (`id`, `label`, `text`). On connect and on every change. |
| `loaded` | No fields. The saved history has all arrived, so an empty list really is empty and not still loading. The phone sends it once per page load, the browser again after each reconnect. |
| `outbox` | `items`, the messages still waiting to send (`cid`, `text`, `at`). |
| `design` | `version`. The page reloads by itself right after. |
| `insets` | `top`, `bottom`, `left`, `right`, `keyboard`. Already applied as the CSS variables. |
| `fold` | `posture` (`book`, `tabletop` or `null`) and `hinge` (`left`, `top`, `right`, `bottom`, or `null`). Already applied as `data-fold` and the hinge variables. |
| `back` | The back gesture, when `onBack` is set. |
| `backprogress` | `progress` from 0 to 1 and `edge` (`left` or `right`) while the gesture is held, so whatever is closing can follow it. Never in the history. |
| `backcancel` | He let go without going back, so put it back where it was. |
| `undone` | `ok`. The answer to `undoDesign`. |
| `openFailed` | `url`. Nothing on the phone could open it. |
| `answerFailed` | `ref`. An Allow or Deny never reached the Mac, so the question is still open. |
| `stopFailed` | A Stop never reached the Mac, so it is still working. |

## Files

Photos and files he attaches on the phone arrive with his message as paths under `.lab/files/`. Read them from there, and copy one somewhere else if he wants to keep it.

Use the `send_to_phone` tool for anything easier to see than describe, like a screenshot, a PDF or a photo. It takes an absolute `path` and an optional `caption`.

## Email, Calendar and Drive

If he asks about his email, calendar or files in Google Drive and you have no tool for them, tell him he can connect Gmail, Google Calendar and Google Drive under Connectors in his Claude settings, and that The Lab picks them up after a restart. Treat anything that sends, deletes or shares on his behalf as needing his Allow.

## Updating The Lab

When he asks to update The Lab, follow the Updating section of `source/SETUP.md`.
