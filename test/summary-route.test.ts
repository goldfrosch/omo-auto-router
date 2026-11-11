import { describe, expect, test } from "bun:test";
import { defaultConfig, normalizeConfig } from "../src/config.ts";
import { compactionTarget } from "../src/core.ts";
import { routeSummaryStreams, VIRTUAL_API, type StreamModel, type StreamOptions } from "../src/summary-route.ts";

const virtual: StreamModel = { api: VIRTUAL_API, provider: "anthropic-subscription", id: "claude-auto", maxTokens: 0 };
const sonnet: StreamModel = { api: "claude-sdk-oauth", provider: "anthropic-subscription", id: "claude-sonnet-5-5", maxTokens: 64_000 };
const gpt: StreamModel = { api: "openai-responses", provider: "openai", id: "gpt-5", maxTokens: 16_000 };

/** Stands in for senpi's ModelRuntime.stream(), which cannot send an unrouted virtual model. */
function fakeRuntime() {
	const calls: { model: StreamModel; options?: StreamOptions }[] = [];
	const runtime = {
		stream(model: StreamModel, _context: unknown, options?: StreamOptions): unknown {
			if (model.api === VIRTUAL_API) throw new Error(`Virtual model ${model.provider}/${model.id} must be routed before streaming`);
			calls.push({ model, options });
			return "stream";
		},
	};
	return { runtime, calls };
}

/** What the compaction summarizer sends: auth resolved for the virtual model's provider. */
const summaryOptions = () => ({ maxTokens: 100_000, apiKey: "key", headers: { "x-h": "1" }, env: { E: "1" }, extraBody: { b: 1 }, cwd: "/work" });

describe("routeSummaryStreams", () => {
	test("a virtual model streams on the target, output capped to it", () => {
		const { runtime, calls } = fakeRuntime();
		expect(() => runtime.stream(virtual, {}, summaryOptions())).toThrow("must be routed before streaming");
		routeSummaryStreams(runtime, () => sonnet);
		expect(runtime.stream(virtual, {}, summaryOptions())).toBe("stream");
		expect(calls).toEqual([{ model: sonnet, options: { ...summaryOptions(), maxTokens: 64_000 } }]);
	});

	test("request auth stays with its provider", () => {
		const { runtime, calls } = fakeRuntime();
		routeSummaryStreams(runtime, () => gpt);
		runtime.stream(virtual, {}, summaryOptions());
		expect(calls[0]?.options).toStrictEqual({ maxTokens: 16_000, cwd: "/work" });
	});

	test("physical models and unknown virtual models pass through", () => {
		const { runtime, calls } = fakeRuntime();
		routeSummaryStreams(runtime, (model) => (model.id === "claude-auto" ? sonnet : undefined));
		const options = { maxTokens: 5 };
		runtime.stream(gpt, {}, options);
		expect(calls[0]?.model).toBe(gpt);
		expect(calls[0]?.options).toBe(options);
		expect(() => runtime.stream({ ...virtual, id: "other-router" }, {}, options)).toThrow("must be routed before streaming");
	});

	test("installing again swaps the target without stacking wrappers", () => {
		const { runtime, calls } = fakeRuntime();
		routeSummaryStreams(runtime, () => sonnet);
		const wrapped = runtime.stream;
		routeSummaryStreams(runtime, () => gpt);
		expect(runtime.stream).toBe(wrapped);
		runtime.stream(virtual, {}, {});
		expect(calls.map((call) => call.model.id)).toEqual(["gpt-5"]);
	});
});

describe("compactionTarget", () => {
	test("first usable compactionModel, else the profile's standard route", () => {
		const config = defaultConfig();
		expect(compactionTarget(config, config.profiles[0]!, () => true)).toBe("anthropic-subscription/claude-sonnet-5-5");
		const mixed = normalizeConfig({
			profiles: { "auto/mixed": { levels: { trivial: "zai/glm-4.5-air", standard: ["zai/glm-4.6", "openai/gpt-5"], complex: "zai/glm-4.6", hard: "zai/glm-4.6" } } },
		}).config;
		const profile = mixed.profiles[0]!;
		expect(compactionTarget(mixed, profile, (ref) => ref.startsWith("openai/"))).toBe("openai/gpt-5");
		expect(compactionTarget(mixed, profile, () => false)).toBeUndefined();
	});
});
