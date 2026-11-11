import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loads the real extension against a stand-in for senpi whose ModelRuntime.stream() cannot send an
 * unrouted virtual model. That stream() call is the one senpi's builtin compaction summarizer makes.
 */
type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const dir = mkdtempSync(join(tmpdir(), "auto-router-"));
const saved = { AUTO_ROUTER_CONFIG: process.env.AUTO_ROUTER_CONFIG, OMO_CODING_AGENT_DIR: process.env.OMO_CODING_AGENT_DIR };

beforeAll(async () => {
	// No config file means the built-in claude-auto profile, and nothing reads the real agent dir.
	process.env.AUTO_ROUTER_CONFIG = join(dir, "auto-router.jsonc");
	process.env.OMO_CODING_AGENT_DIR = dir;
	const { default: autoRouter } = await import("../extensions/auto-router.ts");
	const pi = {
		registerVirtualModel() {},
		unregisterVirtualModel() {},
		registerCommand() {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	};
	autoRouter(pi as unknown as Parameters<typeof autoRouter>[0]);
});

afterAll(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

test("after session_start, a summary request on claude-auto streams on compactionModel", async () => {
	const catalog = new Map(
		["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((id) => [id, { api: "claude-sdk-oauth", provider: "anthropic-subscription", id, maxTokens: 64_000 }]),
	);
	const sent: { model: string; options: unknown }[] = [];
	const modelRuntime = {
		stream(model: { api: string; provider: string; id: string }, _context: unknown, options?: unknown): unknown {
			if (model.api === "pi-virtual") throw new Error(`Virtual model ${model.provider}/${model.id} must be routed before streaming`);
			sent.push({ model: `${model.provider}/${model.id}`, options });
			return "stream";
		},
	};
	const ctx = {
		hasUI: false,
		modelRegistry: {
			modelRuntime,
			find: (provider: string, id: string) => (provider === "anthropic-subscription" ? catalog.get(id) : undefined),
			hasConfiguredAuth: () => true,
		},
	};
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);

	const claudeAuto = { api: "pi-virtual", provider: "anthropic-subscription", id: "claude-auto", maxTokens: 0 };
	expect(modelRuntime.stream(claudeAuto, { messages: [] }, { maxTokens: 32_768, apiKey: "oauth" })).toBe("stream");
	expect(sent).toEqual([{ model: "anthropic-subscription/claude-sonnet-5-5", options: { maxTokens: 32_768, apiKey: "oauth" } }]);
});
