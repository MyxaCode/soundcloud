# SoundCloud

A dedicated SoundCloud desktop app for Windows the web player, minus the browser tab, plus the things it never gave you: a real equalizer, Discord "Listening to" status, themes, and a live visualizer.

Most "SoundCloud desktop" apps just point an Electron window at `soundcloud.com` and stop there. This one actually reaches into the player.

---

## What makes it good

**A real equalizer not a placebo.**
SoundCloud routes its audio through its own Web Audio graph, so the usual trick of grabbing the `<audio>` element and EQ-ing it doesn't work (the element is already taken). ServerSide hooks `AudioContext.createMediaElementSource` and splices a 10-band parametric EQ — plus a dedicated bass shelf and a brick-wall limiter straight into SoundCloud's own signal chain. It changes the sound, and it never clips into mush no matter how hard you push the bass.

**Discord Rich Presence that just works.**
Your profile shows the track, artist, artwork and a live progress bar the moment you press play. No developer portal, no API keys, no config it ships ready.

**Yours to recolor.**
Pick any accent color and it themes the whole UI *and* SoundCloud's seek bar. Flip on the rainbow bar if you want it loud. Drop in your own CSS if you want to go further.

---

## Features

- **10-band equalizer** you shape by dragging the curve, with presets (Flat, Bass Boost, Extreme Bass, Vocal, Treble, Loudness, Electronic, Rock, Pop)
- **Bass Boost** up to +24 dB on a dedicated low shelf, with a limiter so it stays clean
- **Volume boost** past 100%
- **Discord Rich Presence** "Listening to SoundCloud", artwork, progress bar, and a profile button
- **Themes** 8 accent presets + a custom color picker; recolors the app and SoundCloud's player
- **Rainbow seek bar** and a real-time **audio spectrum visualizer** that reacts to whatever's playing
- **Custom CSS** box to restyle SoundCloud however you like
- **Ad & tracker blocking**, **minimize to tray**, and a drop-in folder for unpacked browser extensions
- One hotkey for everything: **F1**

---

## Run it

Download the latest build from the [Releases](../../releases) page and run `SoundCloud-ServerSide-Portable.exe` — nothing to install.

Or build it from source:

```bash
npm install
npm start        # run in dev
npm run dist     # package installer + portable .exe into dist/
```

Requires [Node.js](https://nodejs.org) 18+. Output lands in `dist/`.

---

## Configuration

Everything is in the **F1** panel. Settings persist to:

```
%APPDATA%\soundcloud-serverside\config.json
```

Discord works out of the box with a shared application id. If you'd rather run your own, create an app at the [Discord Developer Portal](https://discord.com/developers/applications) and set `discordClientId` in the config file.

---

## How it's built

Electron shell, settings UI injected into the page's own world, audio handled through the Web Audio API, and a Discord IPC bridge for presence. No accounts, no telemetry, no background phone-home.

```
src/main.js            Electron main window, tray, ad-block, session, Discord
src/preload.js         scrapes now-playing, injects the UI
src/ui.js              settings panel, equalizer, themes, visualizer
src/discordPresence.js Rich Presence over @xhayper/discord-rpc
```

---

## Disclaimer

This is an unofficial third-party client and is not affiliated with or endorsed by SoundCloud. You sign in with your own account; the app stores nothing about you.

## License

MIT see [LICENSE](LICENSE).
