/**
 * Behavioral tests for the tool-adaptation logic.
 *
 * The extension is a pure factory `(pi: ExtensionAPI) => void`, so these tests
 * drive it with a fake ExtensionAPI and assert:
 *   - it wraps a tool only when that name is still owned by the built-in
 *   - it backs off (with a notice) when another extension/sdk owns the name
 *   - the message hooks are wired up and OSC 8 wrapping/stripping work
 *
 * Run: node --experimental-strip-types --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import factory from "../extensions/clickable-paths.ts";

type ToolSource = string;
const BUILTIN = "builtin";

function makePi(allTools: { name: string; sourceInfo: { source: ToolSource } }[]) {
	const registered: any[] = [];
	const hooks: Record<string, Function[]> = {};
	const notices: string[] = [];
	const realError = console.error;
	console.error = (...args: any[]) => {
		notices.push(args.join(" "));
	};
	return {
		pi: {
			getAllTools: () => allTools,
			registerTool: (def: any) => registered.push(def),
			on: (event: string, handler: Function) => {
				(hooks[event] ??= []).push(handler);
			},
		} as any,
		registered,
		hooks,
		notices,
		restore: () => {
			console.error = realError;
		},
	};
}

const fffOwned = {
	name: "read",
	sourceInfo: { source: "/pi/agent/npm/node_modules/pi-fff/index.ts" },
};
const bashImageOwned = {
	name: "bash",
	sourceInfo: { source: "/pi/agent/npm/node_modules/pi-bash-image/index.ts" },
};
const builtin = (name: string) => ({ name, sourceInfo: { source: BUILTIN } });

/** Run the factory, then fire its session_start hook to trigger wrapping. */
function boot(allTools: { name: string; sourceInfo: { source: ToolSource } }[]) {
	const env = makePi(allTools);
	factory(env.pi);
	env.hooks["session_start"]?.forEach((h: Function) => h({}));
	env.restore();
	return env;
}

test("backs off read/bash when another extension owns them", () => {
	const { registered, notices } = boot([
		fffOwned,
		bashImageOwned,
		builtin("edit"),
		builtin("write"),
	]);

	const names = registered.map((t: any) => t.name).sort();
	assert.deepEqual(names, ["edit", "write"], "only builtin-owned tools get wrapped");

	// Backing off must be silent — no console noise in the TUI.
	assert.equal(notices.length, 0, "must not print any back-off notice");
});

test("wraps all four tools when everything is builtin (vanilla pi)", () => {
	const { registered } = boot([
		builtin("read"),
		builtin("edit"),
		builtin("write"),
		builtin("bash"),
	]);

	const names = registered.map((t: any) => t.name).sort();
	assert.deepEqual(names, ["bash", "edit", "read", "write"]);
});

test("backing off is silent and does not register the skipped tool", () => {
	const { registered, notices } = boot([
		fffOwned,
		builtin("edit"),
		builtin("write"),
		builtin("bash"),
	]);

	const names = registered.map((t: any) => t.name).sort();
	assert.deepEqual(names, ["bash", "edit", "write"]);
	assert.equal(notices.length, 0, "must not print any back-off notice");
});

test("registers the context, message_end and session_start hooks", () => {
	const { pi, hooks, restore } = makePi([
		fffOwned,
		bashImageOwned,
		builtin("edit"),
		builtin("write"),
	]);
	factory(pi as any);
	restore();
	assert.ok(hooks["context"]?.length, "context hook registered");
	assert.ok(hooks["message_end"]?.length, "message_end hook registered");
	assert.ok(hooks["session_start"]?.length, "session_start hook registered");
});

test("message_end wraps file paths in assistant text with an OSC 8 link", async () => {
	const { pi, hooks, restore } = makePi([
		fffOwned,
		bashImageOwned,
		builtin("edit"),
		builtin("write"),
	]);
	factory(pi as any);
	restore();

	const hook = hooks["message_end"][0];
	const result = await hook({
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "see src/foo.md now" },
				{ type: "thinking", thinking: "keep me" },
			],
		},
	});

	const text = result.message.content[0].text as string;
	assert.ok(text.includes("\x1b]8;;file://"), "should contain an OSC 8 open sequence");
	assert.ok(text.includes("src/foo.md"), "should keep the visible path");
	assert.ok(text.includes("\x1b]8;;\x07"), "should close with the OSC 8 close sequence");

	// non-text parts pass through untouched
	assert.equal(result.message.content[1].thinking, "keep me");
});

test("message_end skips user messages", async () => {
	const { pi, hooks, restore } = makePi([
		fffOwned,
		bashImageOwned,
		builtin("edit"),
		builtin("write"),
	]);
	factory(pi as any);
	restore();
	const hook = hooks["message_end"][0];
	const result = await hook({ message: { role: "user", content: [{ type: "text", text: "hello" }] } });
	assert.equal(result, undefined, "user messages are left untouched");
});

test("context strips OSC 8 escapes so they never reach the model", async () => {
	const { pi, hooks, restore } = makePi([
		fffOwned,
		bashImageOwned,
		builtin("edit"),
		builtin("write"),
	]);
	factory(pi as any);
	restore();
	const hook = hooks["context"][0];
	const wicked = `see \x1b]8;;file://localhost/tmp/a.md\x07a.md\x1b]8;;\x07 now`;

	const result = await hook({
		messages: [{ role: "user", content: [{ type: "text", text: wicked }] }],
	});
	const text = (result.messages[0].content as any)[0].text as string;
	assert.ok(!text.includes("\x1b]8;"), "no OSC 8 escapes should remain");
	assert.ok(text.includes("a.md"), "visible path text is preserved");
});

test("deferred wrapping decides at session_start, not factory load", () => {
	// Tools are NOT registered when the factory runs — only after session_start.
	const env = makePi([
		fffOwned,
		bashImageOwned,
		builtin("edit"),
		builtin("write"),
	]);
	factory(env.pi);
	assert.equal(env.registered.length, 0, "nothing registered before session_start");
	env.hooks["session_start"][0]({});
	assert.deepEqual(
		env.registered.map((t: any) => t.name).sort(),
		["edit", "write"],
	);
	env.restore();
});

test("edit renderCall produces an OSC 8 clickable heading", async () => {
	const { registered } = boot([
		fffOwned,
		bashImageOwned,
		builtin("edit"),
		builtin("write"),
	]);
	const edit = registered.find((t: any) => t.name === "edit");
	assert.ok(edit, "edit tool registered");

	const theme = { fg: (_k: string, s: string) => s, bold: (s: string) => s } as any;
	const rendered = edit.renderCall({ path: "/tmp/odds.ts" }, theme, undefined);
	const text = (rendered as any)?.text ?? rendered?.render?.(200)?.join("\n") ?? String(rendered);
	assert.ok(text.includes("\x1b]8;;file://"), "heading contains an OSC 8 link");
	assert.ok(text.includes("/tmp/odds.ts"), "heading shows the path");
});
