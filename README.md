# pi-clickable-paths

Makes file paths clickable in the Pi TUI using OSC 8 hyperlinks.

## What it does

- Wraps file paths in **read**, **edit**, and **write** tool headings with clickable links
- Detects file paths in assistant text messages and makes them clickable too
- Strips OSC 8 escapes before sending context to the LLM (display-only)

## Terminal support

Kitty, iTerm2, Windows Terminal, WezTerm, Ghostty, GNOME Terminal.  
Alacritty does **not** support OSC 8.

## Install

```bash
pi install git:github.com/1am2syman/pi-clickable-paths@v1.0.0
```

## License

MIT
