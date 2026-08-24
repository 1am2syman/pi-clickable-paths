/**
 * Clickable file paths in the pi TUI.
 *
 * Wraps file paths in tool call headings (read, edit, write, bash) AND in
 * assistant text messages with OSC 8 hyperlinks so you can Ctrl+Click
 * (or Cmd+Click) to open them with your default system viewer/editor.
 *
 * Terminal support: Kitty, iTerm2, Windows Terminal, WezTerm, Ghostty,
 * GNOME Terminal. Alacritty does NOT support OSC 8.
 *
 * Adapts to tools other extensions already provide: pi lets an extension
 * replace a built-in tool by registering the same name (pi-fff replaces `read`,
 * pi-bash-image replaces `bash`). Before wrapping read/edit/write/bash this
 * extension asks pi who currently owns the name (getAllTools().sourceInfo) and
 * backs off for tools that are already owned by another extension/sdk, so the
 * enhanced implementation is preserved instead of being clobbered. OSC 8 stays
 * active on the tools it does wrap and everywhere in assistant text.
 *
 * Usage:
 *   Drop in ~/.pi/agent/extensions/clickable-paths.ts (auto-loaded).
 *   Or: pi -e ./clickable-paths.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createReadTool,
  createEditTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir, release } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// ── OSC 8 hyperlink helpers ──────────────────────────────────────────────────

const OSC_OPEN = "\x1b]8;";
const OSC_CLOSE = "\x1b]8;;\x07";
const BEL = "\x07";

// ── WSL detection (resolved once at load) ────────────────────────────────────
//
// Under WSL2, plain Linux file:// URIs (file://localhost/home/...) make Windows
// Terminal look for C:\home\... and fail. We rewrite paths to Windows-resolvable
// URIs using pure string conversion (no subprocess) on the render hot path.

const IS_WSL = release().toLowerCase().includes("microsoft");
const WSL_DISTRO = process.env.WSL_DISTRO_NAME; // e.g. "Ubuntu"
const MNT_DRIVE_RE = /^\/mnt\/([a-z])(\/.*)?$/i; // /mnt/c[/...] -> C:
const WIN_PATH_RE = /^([A-Za-z]):[\\/]/; // C:\... or C:/...

/**
 * Single-letter Windows drives actually mounted (drvfs/9p) under /mnt, read once
 * from /proc/mounts. Only these map to `file:///X:/...`; an unmounted /mnt/<letter>
 * is a normal Linux dir and must route via wsl.localhost instead.
 */
const WSL_DRIVES: Set<string> = (() => {
  const drives = new Set<string>();
  if (!IS_WSL) return drives;
  try {
    for (const line of readFileSync("/proc/mounts", "utf-8").split("\n")) {
      const [, mountpoint, fstype] = line.split(" ");
      const m = mountpoint?.match(/^\/mnt\/([a-z])$/);
      if (m && (fstype === "9p" || fstype === "drvfs")) drives.add(m[1].toLowerCase());
    }
  } catch {
    // Can't read mounts — leave empty; /mnt paths then route via wsl.localhost (safe).
  }
  return drives;
})();

/** Wrap text in an OSC 8 hyperlink. */
function oscLink(text: string, uri: string): string {
  return `${OSC_OPEN};${uri}${BEL}${text}${OSC_CLOSE}`;
}

/** Convert a local path to a file:// URI. Handles Windows drive letters. */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return `${homedir()}${p.slice(1)}`;
  return p;
}

function toFileUri(p: string): string {
  const expanded = expandTilde(p);

  // WSL: convert to a Windows-resolvable URI (pure string work, no subprocess).
  if (IS_WSL) {
    // 1. Windows-style input (C:\..., C:/...) — handle BEFORE resolve(), which
    //    would otherwise mangle it into /home/.../C:/...
    if (WIN_PATH_RE.test(expanded)) {
      return `file://${encodeURI(`/${expanded.replace(/\\/g, "/")}`)}`;
    }

    let absolute: string;
    try {
      absolute = resolve(expanded);
    } catch {
      absolute = expanded;
    }

    // 2. /mnt/<drive>/... -> file:///C:/... (only if that drive is really mounted)
    const mnt = absolute.match(MNT_DRIVE_RE);
    if (mnt && WSL_DRIVES.has(mnt[1].toLowerCase())) {
      return `file://${encodeURI(`/${mnt[1].toUpperCase()}:${mnt[2] ?? "/"}`)}`;
    }

    // 3. Any other Linux-native path -> file://wsl.localhost/<distro>/...
    if (WSL_DISTRO && absolute.startsWith("/")) {
      return `file://wsl.localhost${encodeURI(`/${WSL_DISTRO}${absolute}`)}`;
    }
    // else fall through to default (e.g. WSL_DISTRO unset — no worse than today)
  }

  // Non-WSL (and WSL fallback): plain localhost file:// URI.
  let absolute: string;
  try {
    absolute = resolve(expanded);
  } catch {
    absolute = expanded;
  }
  const forward = absolute.replace(/\\/g, "/");
  const pathPart = forward.match(/^[A-Za-z]:/) ? `/${forward}` : forward;
  return `file://localhost${encodeURI(pathPart)}`;
}

/** Make a path string clickable in the terminal. */
function clickablePath(displayPath: string, uri?: string): string {
  return oscLink(displayPath, uri ?? toFileUri(displayPath));
}

// ── Path detection in assistant text ────────────────────────────────────────

const FILE_EXTENSIONS = new Set([
  "md", "ts", "js", "tsx", "jsx", "mjs", "cjs",
  "py", "json", "yaml", "yml", "toml", "xml",
  "txt", "pdf", "docx", "doc", "rtf",
  "csv", "html", "css", "scss", "sass", "less",
  "sql", "sh", "bash", "zsh", "fish",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp",
  "mp3", "mp4", "wav", "avi", "mkv", "mov", "flac",
  "zip", "tar", "gz", "rar", "7z",
  "exe", "dll", "so", "dylib", "wasm",
  "rs", "go", "java", "kt", "swift", "scala",
  "c", "cpp", "h", "hpp", "cc", "cxx",
  "cs", "rb", "php", "pl", "pm", "r", "lua",
  "vim", "el", "org", "rst", "adoc", "tex", "bib", "aux",
  "cfg", "ini", "env", "lock", "log",
  "njk", "hbs", "pug", "ejs", "mustache",
  "ipynb", "dockerfile", "makefile",
]);

/**
 * Find path-like tokens ending in a known extension.
 *
 * This intentionally uses a broad token regex plus validation rather than one
 * giant path regex. It handles:
 *   - ./file.md, ../dir/file.md, file.md
 *   - /tmp/file.ts, ~/.pi/agent/extensions/file.ts
 *   - C:/Users/me/file.ts, C:\Users\me\file.ts
 *
 * It rejects URLs such as https://example.com/file.md before wrapping.
 */
const FILE_PATH_RE = /(^|[\s([{\"'`<])([^\s([{\}"'`<>|]+?\.(\w{1,10}))(?=$|[\s)\]}\"'`>,;:!?.])/g;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function shouldWrapPath(candidate: string, ext: string): boolean {
  if (!FILE_EXTENSIONS.has(ext.toLowerCase())) return false;
  if (URL_RE.test(candidate) || candidate.startsWith("//")) return false;
  if (candidate.includes("@") && !/[\\/]/.test(candidate)) return false;
  return true;
}

/** Replace file paths in text with OSC 8 clickable hyperlinks. */
function wrapPathsInText(text: string): string {
  return text.replace(FILE_PATH_RE, (full, prefix, candidate, ext) => {
    if (!shouldWrapPath(candidate, ext)) return full;
    return `${prefix}${clickablePath(candidate)}`;
  });
}

const OSC8_LINK_RE = /\x1b\]8;[^\x07]*\x07([\s\S]*?)\x1b\]8;;\x07/g;

/** Remove OSC 8 wrappers while preserving visible text. Used before LLM calls. */
function stripOsc8(text: string): string {
  return text.replace(OSC8_LINK_RE, "$1");
}

function stripOsc8FromContent(content: unknown): unknown {
  if (typeof content === "string") return stripOsc8(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string") {
      return { ...(part as any), text: stripOsc8((part as any).text) };
    }
    return part;
  });
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // ── Adapt to tools this session already provides ─────────────────────────
  //
  // pi lets any extension replace a built-in tool by registering a tool under
  // the same name. Other extensions do exactly that for tools we'd otherwise
  // wrap:
  //   - pi-fff        provides its own FFF-enhanced `read` (fuzzy resolution)
  //   - pi-bash-image provides its own `bash` (__PI_IMAGE__ inline images)
  //
  // If we blindly re-register `read`/`bash` (via createReadTool/createBashTool)
  // we clobber those enhanced implementations, and pi refuses to load the later
  // conflicting extension ("Tool \"read\" conflicts with …"). So we ask pi who
  // currently owns each tool name via getAllTools().sourceInfo and only wrap
  // tools that are still the plain built-in. For extension/sdk-owned tools we
  // back off and keep the enhanced implementation intact — OSC 8 stays active
  // on the tools we do wrap and everywhere in assistant text messages.

  const toolSource = (name: string): string | undefined => {
    try {
      return pi.getAllTools().find((t) => t.name === name)?.sourceInfo?.source;
    } catch {
      return undefined;
    }
  };

  /** True when `name` is still owned by the plain built-in and safe to wrap. */
  const isBuiltinTool = (name: string): boolean => {
    const source = toolSource(name);
    if (source === undefined) return true; // can't inspect — keep legacy behavior
    return source === "builtin";
  };

  /** Wrap a tool's registration; backs off (false) when an extension owns it. */
  const wrapTool = (name: string): boolean => {
    if (isBuiltinTool(name)) return true;
    console.error(
      `[clickable-paths] Not wrapping "${name}" — it is already provided by ${toolSource(name)} ` +
        "(extension/sdk tool). Its enhanced behavior is preserved; OSC 8 heading " +
        "styling is skipped for this tool.",
    );
    return false;
  };

  // --- Strip OSC 8 links from LLM context so escapes are display-only ---
  pi.on("context", async (event) => {
    return {
      messages: event.messages.map((message) => ({
        ...message,
        content: stripOsc8FromContent((message as any).content),
      })) as typeof event.messages,
    };
  });

  // --- Wrap file paths in assistant text messages with OSC 8 hyperlinks ---
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const content = event.message.content;
    if (!Array.isArray(content)) return;

    const modified = content.map((part) => {
      if (part.type !== "text" || typeof part.text !== "string") return part;
      return { ...part, text: wrapPathsInText(part.text) };
    });

    return { message: { ...event.message, content: modified } };
  });

  // --- Wrap built-in tools with OSC 8 headings ---
  //
  // Deferred to session_start so the ownership check sees the final tool
  // registry. Extension load order is not fixed: `-e` flags can load before
  // npm-installed extensions, so a check at factory time could still see
  // `read`/`bash` as builtin and then clobber pi-fff / pi-bash-image that load
  // afterwards (pi drops the later conflicting extension with a hard
  // "Failed to load extension" error). By session_start every extension has
  // loaded and getAllTools() reflects who actually owns each name.
  const registerWrappedTools = () => {
    // --- Read ---
    if (wrapTool("read")) {
      const origRead = createReadTool(cwd);
      pi.registerTool({
        name: "read",
        label: "read",
        description: origRead.description,
        parameters: origRead.parameters,

        async execute(toolCallId, params, signal, onUpdate) {
          return origRead.execute(toolCallId, params, signal, onUpdate);
        },

        renderCall(args, theme, _context) {
          let text = theme.fg("toolTitle", theme.bold("read "));
          text += theme.fg("accent", clickablePath(args.path));
          if (args.offset || args.limit) {
            const parts: string[] = [];
            if (args.offset) parts.push(`offset=${args.offset}`);
            if (args.limit) parts.push(`limit=${args.limit}`);
            text += theme.fg("dim", ` (${parts.join(", ")})`);
          }
          return new Text(text, 0, 0);
        },
      });
    }

    // --- Edit ---
    if (wrapTool("edit")) {
      const origEdit = createEditTool(cwd);
      pi.registerTool({
        name: "edit",
        label: "edit",
        description: origEdit.description,
        parameters: origEdit.parameters,

        async execute(toolCallId, params, signal, onUpdate) {
          return origEdit.execute(toolCallId, params, signal, onUpdate);
        },

        renderCall(args, theme, _context) {
          let text = theme.fg("toolTitle", theme.bold("edit "));
          text += theme.fg("accent", clickablePath(args.path));
          return new Text(text, 0, 0);
        },
      });
    }

    // --- Write ---
    if (wrapTool("write")) {
      const origWrite = createWriteTool(cwd);
      pi.registerTool({
        name: "write",
        label: "write",
        description: origWrite.description,
        parameters: origWrite.parameters,

        async execute(toolCallId, params, signal, onUpdate) {
          return origWrite.execute(toolCallId, params, signal, onUpdate);
        },

        renderCall(args, theme, _context) {
          let text = theme.fg("toolTitle", theme.bold("write "));
          text += theme.fg("accent", clickablePath(args.path));
          const lineCount = args.content.split("\n").length;
          text += theme.fg("dim", ` (${lineCount} lines)`);
          return new Text(text, 0, 0);
        },
      });
    }

    // --- Bash (passthrough, keeps default rendering) ---
    if (wrapTool("bash")) {
      const origBash = createBashTool(cwd);
      pi.registerTool({
        name: "bash",
        label: "bash",
        description: origBash.description,
        parameters: origBash.parameters,

        async execute(toolCallId, params, signal, onUpdate) {
          return origBash.execute(toolCallId, params, signal, onUpdate);
        },
      });
    }
  };

  // Defer wrapping until session_start — see comment above.
  pi.on("session_start", () => {
    registerWrappedTools();
  });
}
