import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, normalizeConfig, parseJsonc, type Level, type RouterConfig } from "../src/config.ts";
import { decide, findTag, fitContext, isAck, outgrown, pickModel, type Classify, type DecideInput, type RoomOf } from "../src/core.ts";

/** Haiku: 100k window minus a 32k answer. */
const haikuRoom: RoomOf = (route) => (route.models[0]?.ref.includes("haiku") ? 68_000 : undefined);

const classifyAs = (size: Level): Classify => async () => ({ size });
const failClassify: Classify = async () => ({ error: "boom" });
const neverClassify: Classify = async () => {
	throw new Error("classifier must not run");
};

function input(overrides: Partial<DecideInput> = {}, config: RouterConfig = defaultConfig()): DecideInput {
	return { config, profile: config.profiles[0]!, prompt: "", ctxTokens: 0, selectedThinking: "max", ...overrides };
}

const mixed = normalizeConfig(
	parseJsonc(`{
  "classifier": { "models": ["zai/glm-4.5-air", "anthropic-subscription/claude-haiku-4-5"] },
  "profiles": {
    "auto/mixed": {
      "levels": {
        "trivial": "zai/glm-4.5-air",
        "standard": ["zai/glm-4.6", { "model": "openai/gpt-5", "thinking": "low" }],
        "complex": { "models": "anthropic-subscription/claude-sonnet-5-5", "thinking": "high", },
        "hard": { "model": "anthropic-subscription/claude-opus-5-5" }
      },
      // comment with "quotes" and a // inside
      "tags": { "glm": "zai/glm-4.6" },
      "ceilings": { "low": null, "high": { "maxLevel": "complex", "maxThinking": "high" } }
    }
  }
}`),
);

const chores = normalizeConfig({ choreKeywords: ["커밋", "푸시", "push", "deploy"], choreBlockKeywords: ["리팩터", "refactor"] }).config;

describe("config", () => {
	test("example file parses to the built-in defaults", () => {
		const text = readFileSync(join(import.meta.dir, "..", "config.example.jsonc"), "utf8");
		const { config, errors } = normalizeConfig(parseJsonc(text));
		expect(errors).toEqual([]);
		expect(config).toEqual(defaultConfig());
	});

	test("mixed-provider profile with shorthand routes", () => {
		expect(mixed.errors).toEqual([]);
		const profile = mixed.config.profiles[0]!;
		expect(`${profile.provider}/${profile.id}`).toBe("auto/mixed");
		expect(profile.levels.trivial).toEqual({ models: [{ ref: "zai/glm-4.5-air" }], thinking: "low" });
		expect(profile.levels.standard.models).toEqual([{ ref: "zai/glm-4.6" }, { ref: "openai/gpt-5", thinking: "low" }]);
		expect(profile.levels.hard.thinking).toBe("max");
		expect(profile.tags.glm?.models).toEqual([{ ref: "zai/glm-4.6" }]);
		expect(Object.keys(profile.ceilings).sort()).toEqual(["high", "max", "medium"]);
		expect(mixed.config.classifier.models.map((c) => c.ref)).toEqual(["zai/glm-4.5-air", "anthropic-subscription/claude-haiku-4-5"]);
	});

	test("invalid parts are reported and fall back to defaults", () => {
		const { config, errors } = normalizeConfig({
			classifier: { timeoutMs: 5 },
			profiles: { "no-slash": { levels: {} }, "auto/x": { levels: { trivial: "a/b", standard: "a/b", complex: "a/b" } } },
		});
		expect(errors.some((e) => e.startsWith("classifier.timeoutMs"))).toBe(true);
		expect(errors.some((e) => e.includes('profiles["no-slash"]'))).toBe(true);
		expect(errors.some((e) => e.includes("levels.hard: is missing"))).toBe(true);
		expect(config.profiles[0]?.id).toBe("claude-auto");
		expect(config.classifier.timeoutMs).toBe(15_000);
	});

	test("chore and compaction keys parse, and invalid values keep the defaults", () => {
		const ok = normalizeConfig({
			choreKeywords: [" 커밋", "Push"],
			choreBlockKeywords: ["리팩터"],
			choreMaxChars: 60,
			choreLevel: "trivial",
			compactionModel: ["zai/glm-4.6", "anthropic-subscription/claude-sonnet-5-5"],
		});
		expect(ok.errors).toEqual([]);
		expect(ok.config).toMatchObject({
			choreKeywords: ["커밋", "Push"],
			choreBlockKeywords: ["리팩터"],
			choreMaxChars: 60,
			choreLevel: "trivial",
			compactionModel: ["zai/glm-4.6", "anthropic-subscription/claude-sonnet-5-5"],
		});
		expect(normalizeConfig({ compactionModel: "openai/gpt-5" }).config.compactionModel).toEqual(["openai/gpt-5"]);
		const bad = normalizeConfig({ choreKeywords: "git", choreBlockKeywords: [""], choreMaxChars: -1, choreLevel: "huge", compactionModel: "sonnet" });
		expect(bad.errors.map((e) => e.slice(0, e.indexOf(":"))).sort()).toEqual(["choreBlockKeywords", "choreKeywords", "choreLevel", "choreMaxChars", "compactionModel"]);
		expect(bad.config).toMatchObject({
			choreKeywords: [],
			choreBlockKeywords: [],
			choreMaxChars: 120,
			choreLevel: "standard",
			compactionModel: ["anthropic-subscription/claude-sonnet-5-5"],
		});
	});
});

describe("decide", () => {
	test("tag pins the route without classifying", async () => {
		const d = await decide(input({ prompt: "fix this #opus please" }), neverClassify);
		expect(d.source).toBe("tag");
		expect(d.state).toEqual({ tag: "opus" });
		expect(d.thinking).toBe("max");
	});

	test("custom tag on a mixed profile", async () => {
		const d = await decide(input({ prompt: "#glm 정리해줘" }, mixed.config), neverClassify);
		expect(d.route.models[0]?.ref).toBe("zai/glm-4.6");
	});

	test("tag over its maxContext falls back to a level with room", async () => {
		const d = await decide(input({ prompt: "#haiku hi", ctxTokens: 90_000 }), neverClassify);
		expect(d.state).toEqual({ level: "standard" });
	});

	test("hard keyword skips the classifier", async () => {
		const d = await decide(input({ prompt: "ulw 리팩터링" }), neverClassify);
		expect(d.source).toBe("rule");
		expect(d.state.level).toBe("hard");
	});

	test("ack keeps the current level", async () => {
		const d = await decide(input({ prompt: "응 진행해", current: { level: "complex" } }), neverClassify);
		expect(d.source).toBe("ack");
		expect(d.state.level).toBe("complex");
	});

	test("questions are not acks", () => {
		expect(isAck(defaultConfig(), "응?")).toBe(false);
		expect(isAck(defaultConfig(), "ㅇㅋ")).toBe(true);
	});

	test("classifier result drives the level", async () => {
		const d = await decide(input({ prompt: "write a migration" }), classifyAs("complex"));
		expect(d).toMatchObject({ source: "classifier", state: { level: "complex", size: "complex" }, thinking: "high" });
	});

	test("classifier failure keeps the current level", async () => {
		const d = await decide(input({ prompt: "x", current: { level: "complex" } }), failClassify);
		expect(d).toMatchObject({ source: "fallback", state: { level: "complex" }, classifierError: "boom" });
	});

	test("classifier failure on a design prompt raises the floor to complex", async () => {
		const d = await decide(input({ prompt: "일괄 적용 구조 확정해줘" }), failClassify);
		expect(d).toMatchObject({ source: "fallback", state: { level: "complex" } });
		const held = await decide(input({ prompt: "design it", current: { level: "hard" } }), failClassify);
		expect(held.state.level).toBe("hard");
		const plain = await decide(input({ prompt: "커밋 푸시해줘" }), failClassify);
		expect(plain.state.level).toBe("standard");
	});

	test("short go-ahead phrases are acks", () => {
		expect(isAck(defaultConfig(), "구현으로 넘어가자")).toBe(true);
	});

	test("no downgrade once the context is large", async () => {
		const d = await decide(input({ prompt: "thanks", ctxTokens: 100_000, current: { level: "complex" } }), classifyAs("trivial"));
		expect(d.state.level).toBe("complex");
	});

	test("downgrade allowed while the context is small", async () => {
		const d = await decide(input({ prompt: "thanks", ctxTokens: 1_000, current: { level: "complex" } }), classifyAs("trivial"));
		expect(d.state.level).toBe("trivial");
	});

	test("locked at the ceiling skips the classifier", async () => {
		const d = await decide(input({ prompt: "next", ctxTokens: 100_000, current: { level: "hard" } }), neverClassify);
		expect(d.source).toBe("locked");
		expect(d.state.level).toBe("hard");
	});

	test("selected thinking caps level and thinking", async () => {
		const d = await decide(input({ prompt: "design it", selectedThinking: "medium" }), classifyAs("hard"));
		expect(d.state.level).toBe("standard");
		expect(d.thinking).toBe("medium");
		const low = await decide(input({ prompt: "x", selectedThinking: "low" }), classifyAs("standard"));
		expect(low.thinking).toBe("low");
	});

	test("trivial route over maxContext climbs a level", async () => {
		const d = await decide(input({ prompt: "hi", ctxTokens: 85_000 }), classifyAs("trivial"));
		expect(d.state.level).toBe("standard");
	});

	test("model room below maxContext also climbs", async () => {
		const d = await decide(input({ prompt: "hi", ctxTokens: 72_000, roomOf: haikuRoom }), classifyAs("trivial"));
		expect(d.state.level).toBe("standard");
		const tag = await decide(input({ prompt: "#haiku hi", ctxTokens: 72_000, roomOf: haikuRoom }), neverClassify);
		expect(tag.state).toEqual({ level: "standard" });
	});

	test("chore at a large context drops to choreLevel", async () => {
		const d = await decide(input({ prompt: "커밋하고 푸시해줘", ctxTokens: 160_000, current: { level: "hard" } }, chores), neverClassify);
		expect(d).toMatchObject({ source: "rule", rule: "chore", state: { level: "standard", size: "standard" } });
	});

	test("a chore must fit in choreMaxChars", async () => {
		const prompt = `커밋하고 푸시해줘. ${"변경 내용도 자세히 정리해줘. ".repeat(8)}`;
		expect(prompt.trim().length).toBeGreaterThan(chores.choreMaxChars);
		const d = await decide(input({ prompt, ctxTokens: 160_000, current: { level: "hard" } }, chores), neverClassify);
		expect(d).toMatchObject({ source: "locked", state: { level: "hard" } });
	});

	test("a block keyword cancels the chore", async () => {
		const d = await decide(input({ prompt: "리팩터링하고 push해줘", ctxTokens: 160_000, current: { level: "hard" } }, chores), neverClassify);
		expect(d).toMatchObject({ source: "locked", state: { level: "hard" } });
	});

	test("empty choreKeywords leave routing unchanged", async () => {
		const d = await decide(input({ prompt: "커밋하고 푸시해줘", ctxTokens: 160_000, current: { level: "hard" } }), neverClassify);
		expect(d).toMatchObject({ source: "locked", state: { level: "hard" } });
		expect(d.rule).toBeUndefined();
	});

	test("hard keywords win over chores", async () => {
		const d = await decide(input({ prompt: "ulw push", ctxTokens: 160_000, current: { level: "hard" } }, chores), neverClassify);
		expect(d).toMatchObject({ source: "rule", state: { level: "hard", size: "hard" } });
		expect(d.rule).toBeUndefined();
	});

	test("a chore level without room still climbs", async () => {
		const d = await decide(input({ prompt: "deploy", ctxTokens: 160_000, current: { level: "hard" } }, { ...chores, choreLevel: "trivial" }), neverClassify);
		expect(d.state.level).toBe("standard");
	});
});

describe("helpers", () => {
	const profile = mixed.config.profiles[0]!;

	test("findTag needs a word boundary", () => {
		expect(findTag(profile, "see #glm")).toBe("glm");
		expect(findTag(profile, "see #glmx")).toBeUndefined();
		expect(findTag(profile, "a#glm")).toBeUndefined();
	});

	test("fitContext leaves levels without a limit alone", () => {
		expect(fitContext(profile, "standard", 1_000_000)).toBe("standard");
	});

	test("outgrown climbs mid-turn once the route runs out of room", () => {
		const claude = defaultConfig().profiles[0]!;
		expect(outgrown(claude, { level: "trivial", size: "trivial" }, 60_000, haikuRoom)).toBeUndefined();
		expect(outgrown(claude, { level: "trivial", size: "trivial" }, 72_000, haikuRoom)).toEqual({ level: "standard", size: "trivial" });
		expect(outgrown(claude, { tag: "haiku" }, 81_000)).toEqual({ level: "standard" });
		expect(outgrown(claude, { level: "standard" }, 900_000, haikuRoom)).toBeUndefined();
		expect(outgrown(claude, undefined, 900_000)).toBeUndefined();
	});

	test("pickModel skips unusable and continues after a failed model", () => {
		const route = profile.levels.standard;
		expect(pickModel(route, (ref) => ref !== "zai/glm-4.6")?.ref).toBe("openai/gpt-5");
		expect(pickModel(route, () => true, "zai/glm-4.6")?.ref).toBe("openai/gpt-5");
		expect(pickModel(route, () => true, "openai/gpt-5")).toBeUndefined();
		expect(pickModel(route, () => true, "unknown/model")).toBeUndefined();
	});
});
