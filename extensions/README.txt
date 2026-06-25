Drop unpacked Chrome extensions here (one folder per extension, each containing a manifest.json).
They load automatically on startup.

Example:
  extensions/
    ublock-origin/
      manifest.json
      ...
    soundcloud-dark/
      manifest.json
      ...

Notes:
- Use the UNPACKED extension folder (not the .crx file).
- Electron supports Manifest V2 fully and a subset of Manifest V3.
- Good picks for SoundCloud: uBlock Origin (ad/track blocking), a dark-theme
  extension, or a media-keys helper.
