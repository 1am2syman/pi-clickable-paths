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
	let markdownTransformer: Function | undefined;
	let markdownTransformerOptions: unknown;
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
			registerMarkdownTransformer: (transformer: Function, options?: unknown) => {
				markdownTransformer = transformer;
				markdownTransformerOptions = options;
			},
		} as any,
		registered,
		hooks,
		notices,
		get transformer() {
			return markdownTransformer;
		},
		get transformerOptions() {
			return markdownTransformerOptions;
		},
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

interface TransformContext {
	messageType: string;
	isStreaming?: boolean;
	availableWidth?: number;
}

function transform(env: ReturnType<typeof makePi>, markdown: string, ctx: TransformContext = { messageType: "assistant" }): string {
	assert.ok(env.transformer, "markdown transformer registered");
	return (env.transformer as Function)(markdown, { isStreaming: false, availableWidth: 120, ...ctx });
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

test("registers the context hook, markdown transformer and session_start hook — no message_end", () => {
	const env = makePi([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	factory(env.pi);
	env.restore();
	assert.ok(env.hooks["context"]?.length, "context hook registered");
	assert.ok(env.hooks["session_start"]?.length, "session_start hook registered");
	assert.ok(env.hooks["message_end"]?.length === undefined, "message_end must NOT be registered (it pollutes the transcript)");
	assert.ok(env.transformer, "markdown transformer registered");
});

 test("transformer restricts itself to assistant surfaces via messageTypes", () => {
	const env = makePi([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	factory(env.pi);
	env.restore();
	assert.deepEqual(env.transformerOptions, { messageTypes: ["assistant"] });
});

test("transformer wraps file paths in assistant text with an OSC 8 link", () => {
	const env = boot([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	const text = transform(env, "see src/foo.md now");
	assert.ok(text.includes("\x1b]8;;file://"), "should contain an OSC 8 open sequence");
	assert.ok(text.includes("src/foo.md"), "should keep the visible path");
	assert.ok(text.includes("\x1b]8;;\x07"), "should close with the OSC 8 close sequence");
});

test("transformer skips non-assistant surfaces", () => {
	const env = boot([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	for (const messageType of ["user", "assistant-thinking", "custom", "summary", "changelog"]) {
		const text = transform(env, "see /tmp/notes.md now", { messageType });
		assert.ok(!text.includes("\x1b]8;"), `${messageType} surface must stay untouched`);
	}
});

test("transformer preserves Moshi visual directives while linking nearby paths", () => {
	const env = boot([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	for (const newline of ["\n", "\r\n"]) {
		const directive = '::moshi-visual{file="/home/user/.moshi/visuals/waterfall.html" title="Project finish waterfall"}';
		const text = transform(env, `See /tmp/notes.md${newline}${directive}${newline}Then /tmp/after.md`);
		assert.equal(text.split(newline)[1], directive, "directive must stay byte-for-byte");
		assert.equal((text.match(/\x1b\]8;;file:\/\//g) ?? []).length, 2, "ordinary paths remain clickable");
	}
});

test("transformer leaves fenced code blocks untouched", () => {
	const env = boot([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	const md = [
		"Edit /tmp/before.md like this:",
		"```ts",
		'import x from "./inside-code-fence.md";',
		"~~~",
		"keeps /tmp/inside-tilde.md raw too",
		"~~~",
		"```",
		"And /tmp/after.md here.",
	].join("\n");
	const text = transform(env, md);
	const insideFence = text.split("```ts\n")[1].split("\n```")[0];
	assert.ok(!insideFence.includes("\x1b]8;"), "no OSC 8 inside the backtick fence (tilde lines are fence content)");
	assert.equal((text.match(/\x1b\]8;;file:\/\//g) ?? []).length, 2, "only the two prose paths are wrapped");

	// A real tilde fence behaves the same way.
	const md2 = ["~~~js", 'const p = "/tmp/inside-tilde.md";', "~~~", "And /tmp/after.md here."].join("\n");
	const text2 = transform(env, md2);
	assert.ok(!text2.split("~~~")[1].includes("\x1b]8;"), "no OSC 8 inside the tilde fence");
	assert.equal((text2.match(/\x1b\]8;;file:\/\//g) ?? []).length, 1, "prose after the fence is wrapped");
});

test("transformer leaves inline code spans untouched", () => {
	const env = boot([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	const text = transform(env, "run `bash scripts/setup.sh` then see /tmp/notes.md");
	assert.ok(text.includes("`bash scripts/setup.sh`"), "code span verbatim");
	assert.ok(!text.split("`bash scripts/setup.sh`")[0].includes("\x1b]8;"), "no OSC 8 inside the span");
	assert.equal((text.match(/\x1b\]8;;file:\/\//g) ?? []).length, 1, "prose path is wrapped");
});

test("transformer leaves markdown link targets alone", () => {
	const env = boot([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	const text = transform(env, "see [the guide](docs/guide.md) and also docs/plain.md");
	assert.ok(text.includes("](docs/guide.md)"), "link target untouched");
	assert.equal((text.match(/\x1b\]8;;file:\/\//g) ?? []).length, 1, "plain path is wrapped");
});

test("transformer unwraps legacy OSC 8 instead of double-wrapping", () => {
	const env = boot([fffOwned, bashImageOwned, builtin("edit"), builtin("write")]);
	const legacy = "see \x1b]8;;file://localhost/tmp/a.md\x07/tmp/a.md\x1b]8;;\x07 now";
	const text = transform(env, legacy);
	assert.equal((text.match(/\x1b\]8;/g) ?? []).length, 2, "exactly one open+close pair (single wrap)");
	assert.ok(text.includes("\x1b]8;;file://localhost/tmp/a.md\x07/tmp/a.md\x1b]8;;\x07"), "re-wrapped once around the path");
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
