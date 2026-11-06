# The iPhone App (Not Recommended)

**We recommend that people and agents do not use this. Use an Android phone instead.** It is unsupported, and it is here for anyone who wants to read it or take it further.

It has only ever run in Apple's simulator, never on a real iPhone. Signing and installing on a phone, the microphone, the camera, real networks and Apple's real push service have not been tried at all. An install on a free Apple account stops opening after 7 days, and without the $99 a year developer account nothing tells you the agent is waiting for an OK while the app is in the background.

The workflow in `.github/workflows/iphone.yml` builds it on GitHub's Macs for any branch starting with `iphone`, runs `swift test`, and then runs `check.mjs` against two real servers and a local relay in the simulator.
