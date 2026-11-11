# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Stack

Delegated, with the brief "easiest to maintain, highest quality and performance, even if it takes extra work". Chosen:

- Phone: a native Android app in Kotlin. The native layer owns everything that has to stay up (connection, notifications, outbox, pairing, rescue screen). The screen itself is a web page in a WebView, because the owner's agent edits it on request and a native screen would need a rebuild over the cable for every change.
- Computer: one Node 24 server in TypeScript, run directly with no build step, on the Agent SDK (`@anthropic-ai/claude-agent-sdk`) and signed in with the owner's own plan.
- Link: an end-to-end encrypted tunnel (computer/tunnel.ts, phone Tunnel.kt), straight over the local network or through a Cloudflare Worker relay (relay/). The phone keeps one link per paired computer (Hub.kt), races both routes when dialling and moves back to direct as soon as it answers. The window on a computer only ever shows that computer. Tailscale still works as one more direct route.

## Users

The owner runs a Pixel Fold and a Mac or Windows computer and is at home with AI tools. Setup is done end to end by his agent following this repo, and he only taps where Android or Tailscale insist on a human.

He wants to text his computer from his phone, from anywhere, have it do real work (files, web, apps, email, whatever the agent can reach) and watch exactly what it is doing as it does it.

## Product Purpose

The Lab is his computer's agent in his pocket. He sends a request, the agent on his computer works on it, and the phone shows the reply along with a live log of every step that opens to the exact command, file or URL. It works if it becomes the way he uses his computer when he isn't at it, and he never loses a message or wonders whether it is running.

## Positioning

Dispatch and Remote Control already reach a desktop from the phone. The Lab differs in three ways a neighbour could not truthfully copy.

- It is his own app, and its look is his to change by asking ("make it darker", "put the stop button bottom left"). His agent edits the app's interface and it updates live.
- It survives the computer restarting, sleeping or losing its sign-in. Messages queue on the phone, the server on the computer comes back by itself, and an interrupted task gets reported rather than silently repeated.
- It shows what the agent is doing as it happens, with a readable title per step and the raw detail one tap away.

## Operating Context

- He uses it anywhere, one-handed on the folded outer screen or with both hands on the unfolded inner one.
- The computer sits at home, plugged in, and the server keeps it awake while it's on power.
- Requests range from quick questions to tasks that run for many minutes with the phone in his pocket, so notifications carry replies and approval requests.
- Auto mode decides most actions. When it can't, the phone asks him using the agent's own sentence ("wants to delete 40 files in Downloads") with Allow and Deny.

## Capabilities and Constraints

- He can keep several conversations, each with its own thread on the computer, compacted automatically and named by a cheap model as it goes.
- Each step arrives as a title (shell steps carry their own description) with the tool name and its exact input behind it.
- A running task can be stopped at any moment and the conversation carries on.
- The agent can send files and images, which open on the phone.
- The in-app interface is plain HTML, CSS and JS in a folder on his computer that his agent edits. A rescue screen built into the APK can't be edited, so a broken design can always be undone from the phone.
- The app opens instantly with the last history it saw when the computer is off, and holds outgoing messages until it is back.
- It is still undecided whether streaming reply text as it's written is worth the extra traffic.

## Brand Commitments

The name is The Lab. It shows under the launcher icon and in notifications.

## Evidence on Hand

None. There is no logo, no photos and no testimonials. Any demonstration content in the app (an example conversation, example steps) is synthetic and has to read as an example.

## Product Principles

1. Never lose a word. Anything he sends either arrives or visibly waits to.
2. Always show what is happening, with the plain title first and the raw detail one tap away.
3. He can always get back to a working state from the phone alone.
4. The look belongs to him. The defaults are a starting point with a point of view, not a fixed brand.
5. Nothing sits on the open internet, only his own devices.
