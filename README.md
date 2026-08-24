# pi-clickable-paths

Makes file paths clickable in the Pi TUI using OSC 8 hyperlinks.

## What it does

- Wraps file paths in **read**, **edit**, **write** tool headings with clickable links
- Detects file paths in assistant text messages and makes them clickable too
- Strips OSC 8 escapes before sending context to the LLM (display-only)
- Detects **WSL** and rewrites paths to Windows-resolvable `file://` URIs

## Adapts to tools other extensions provide

pi lets any extension replace a built-in tool by registering a tool under the
same name. Popular extensions use that for `read` and `bash`:

- **pi-fff** replaces `read` with an FFF-enhanced version (fuzzy path resolution)
- **pi-bash-image** replaces `bash` with a version that inlines images
  (`__PI_IMAGE__`)

Blindly re-wrapping `read`/`bash` would clobber those implementations, and pi
warns about the name collision. This extension therefore asks pi who currently
owns each tool name (`getAllTools()` → `sourceInfo`) and **only wraps tools that
are still the plain built-in**. For extension-owned tools it backs off and keeps
the enhanced implementation intact:

- With **pi-fff/pi-bash-image loaded**: `read` and `bash` keep their enhanced
  behavior; OSC 8 clickable headings are applied to `edit`/`write`, and paths in
  assistant text messages stay clickable.
- In a **vanilla pi** (no other extension owns the tools): all of
  `read`/`edit`/`write`/`bash` headings are made clickable, as before.

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
pi install git:github.com/1am2syman/pi-clickable-paths@v1.2.1
```

## License

MIT
