# pi-clickable-paths

Makes file paths clickable in the Pi TUI using OSC 8 hyperlinks.

## What it does

- Wraps file paths in **read**, **edit**, and **write** tool headings with clickable links
- Detects file paths in assistant text messages and makes them clickable too
- Strips OSC 8 escapes before sending context to the LLM (display-only)
- Detects **WSL** and rewrites paths to Windows-resolvable `file://` URIs

## Terminal support

Kitty, iTerm2, Windows Terminal, WezTerm, Ghostty, GNOME Terminal.  
Alacritty does **not** support OSC 8.

## WSL

Under WSL, plain Linux `file://` URIs make Windows Terminal look for the wrong
path (e.g. `C:\home\…`) and clicking does nothing. The extension detects WSL at
load and emits Windows-resolvable URIs instead — no `wslpath` subprocess on the
render path:

- Linux-native paths → `file://wsl.localhost/<distro>/…`
- Mounted Windows drives (`/mnt/c/…`) → `file:///C:/…`

The distro comes from `WSL_DISTRO_NAME`; mounted drives are read once from
`/proc/mounts`. If either is unavailable it falls back to the plain `file://`
form.

## Install

```bash
pi install git:github.com/1am2syman/pi-clickable-paths@v1.0.0
```

## License

MIT
