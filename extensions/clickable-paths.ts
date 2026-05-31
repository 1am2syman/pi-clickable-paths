/**
 * Clickable file paths in the pi TUI.
 *
 * Wraps file paths in tool call headings (read, edit, write) AND in
 * assistant text messages with OSC 8 hyperlinks so you can Ctrl+Click
 * (or Cmd+Click) to open them with your default system viewer/editor.
 *
 * Terminal support: Kitty, iTerm2, Windows Terminal, WezTerm, Ghostty,
 * GNOME Terminal. Alacritty does NOT support OSC 8.
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
import { homedir } from "node:os";
import { resolve } from "node:path";

// ── OSC 8 hyperlink helpers ──────────────────────────────────────────────────

const OSC_OPEN = "\x1b]8;";
const OSC_CLOSE = "\x1b]8;;\x07";
const BEL = "\x07";

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
  let absolute: string;
  try {
    absolute = resolve(expandTilde(p));
  } catch {
    absolute = p;
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

  // --- Strip OSC 8 links from LLM context so escapes are display-only ---
  pi.on("context", async (event) => {
    return {
      messages: event.messages.map((message) => ({
        ...message,
        content: stripOsc8FromContent((message as any).content),
      })),
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

  // --- Read ---
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

  // --- Edit ---
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

  // --- Write ---
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

  // --- Bash (passthrough, keeps default rendering) ---
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
