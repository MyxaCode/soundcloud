# SoundCloud ServerSide

A desktop SoundCloud client for Windows. It runs SoundCloud in its own window and adds the parts the web player is missing: a working equalizer, Discord "Listening to" status, color themes, custom images on the page, and a live visualizer.

Most SoundCloud desktop wrappers just open soundcloud.com in an Electron window and stop there. This one hooks into the player itself.

## What it does

The equalizer is real. SoundCloud plays audio through its own Web Audio graph, so grabbing the audio element and EQ-ing it does nothing. ServerSide hooks `AudioContext.createMediaElementSource` and inserts a 10-band EQ, a bass shelf and a limiter into SoundCloud's own audio chain. It actually changes the sound, and the limiter keeps heavy bass from clipping.

Discord Rich Presence works with no setup. Your profile shows the track, artist, artwork and a live progress bar the second you press play.

You can recolor it. Pick an accent and the whole app plus SoundCloud's player take that color. There are presets, a custom color picker, a rainbow seek bar, custom cursors, and you can drop your own images onto the page straight from the settings, no CSS required.

## Features

- 10-band equalizer you shape by dragging the curve, with presets
- Bass Boost up to +24 dB with a safety limiter
- Volume boost past 100 percent
- Discord Rich Presence: track, artist, artwork, progress, profile button
- Color themes: 8 presets plus a custom picker, recolors the app and SoundCloud
- Rainbow seek bar and a live audio spectrum visualizer
- Custom cursors and on-page image decorations, no code needed
- Custom CSS box for anything else
- Ad and tracker blocking, minimize to tray
- One hotkey opens everything: F1

## Run it

Download the latest build from Releases and run `SoundCloud-ServerSide-Portable.exe`. Nothing to install.

Build from source:

```bash
npm install
npm start
npm run dist
```

Needs Node.js 18 or newer. Output goes to `dist/`.

## Settings

Press F1 for the panel. Settings are saved to:

```
%APPDATA%\soundcloud-serverside\config.json
```

Discord works out of the box with a shared application id. To use your own, create an app at the Discord Developer Portal and set `discordClientId` in the config file.

## How it's built

Electron, with the settings UI injected into the page, audio through the Web Audio API, and a Discord IPC bridge for presence. No accounts, no telemetry.

```
src/main.js            window, tray, ad-block, session, Discord, image picker
src/preload.js         reads now-playing, injects the UI
src/ui.js              settings, equalizer, themes, cursors, decorations, visualizer
src/discordPresence.js Rich Presence
```

## Disclaimer

Unofficial third-party client, not affiliated with SoundCloud. You sign in with your own account and the app keeps nothing about you.

## License

MIT. See [LICENSE](LICENSE).
