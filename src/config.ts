import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const LEVELS = ["trivial", "standard", "complex", "hard"] as const;
export type Level = (typeof LEVELS)[number];

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];

/** One candidate model. `thinking` overrides the route's level for this model only. */
export interface ModelChoice {
	ref: string;
	thinking?: Thinking;
}

/** Candidates are tried in order; the first one with credentials wins. */
export interface RouteSpec {
	models: ModelChoice[];
	thinking: Thinking;
	/** At or above this many context tokens the route is skipped for the next higher level. */
	maxContext?: number;
}

/** What the selected virtual thinking level allows. */
export interface Ceiling {
	maxLevel: Level;
	maxThinking: Thinking;
}

export interface Profile {
	provider: string;
	id: string;
	name: string;
	/** Shown before the first response; afterwards senpi uses the answering model's limits. */
	contextWindow: number;
	levels: Record<Level, RouteSpec>;
	tags: Record<string, RouteSpec>;
	ceilings: Record<string, Ceiling>;
}

export interface RouterConfig {
	classifier: { models: ModelChoice[]; timeoutMs: number; prompt: string };
	downgradeMaxContext: number;
	hardKeywords: string[];
	/** When the classifier fails, a prompt containing one of these is treated as at least complex. */
	complexKeywords: string[];
	ackWords: string[];
	ackMaxChars: number;
	profiles: Profile[];
}

export interface LoadedConfig {
	config: RouterConfig;
	errors: string[];
	path: string;
	exists: boolean;
}

export const DEFAULT_CLASSIFIER_PROMPT = `You route requests for a coding agent to the cheapest model that will handle them well. Read the user's latest request and reply with exactly one word: trivial, standard, complex, or hard.

trivial - small talk, thanks, a quick factual or conceptual question answerable without looking at any files, rewording or translating short text. Anything that needs reading, searching, or locating files or code is at least standard.
standard - ordinary development work: finding where something lives in a codebase, a focused bug fix with a known location, a small feature, edits to one or a few files, writing tests, explaining or reviewing a modest amount of code, routine configuration.
complex - multi-file or cross-cutting changes, a bug whose cause is unknown, performance work, migrations, broad refactors, building a new tool or integration, choices with real trade-offs.
hard - architecture or system design, subtle correctness, concurrency or security reasoning, large or ambiguous goals, plans spanning a whole codebase, or work where a mistake is expensive.

<previous> is only there to make sense of short follow-ups such as "do that" or "fix it". If torn between two levels, choose the higher one.`;

export const DEFAULT_ACK_WORDS = [
	"응", "어", "웅", "ㅇㅇ", "ㅇㅋ", "ㄱㄱ", "ㄱ", "네", "넵", "예", "좋아", "좋습니다", "그래", "그렇게", "오케이",
	"ok", "okay", "yes", "yep", "sure", "go", "진행", "진행해", "진행해줘", "계속", "계속해", "계속해줘", "고고",
	"해줘", "부탁해", "부탁합니다",
	"구현으로 넘어가자", "구현 시작", "넘어가자", "구현해줘", "구현해",
];

export const DEFAULT_COMPLEX_KEYWORDS = ["설계", "아키텍처", "구조", "원인", "마이그레이션", "design", "architecture", "root cause", "migration"];

export const DEFAULT_CEILINGS: Record<string, Ceiling> = {
	low: { maxLevel: "standard", maxThinking: "low" },
	medium: { maxLevel: "standard", maxThinking: "high" },
	high: { maxLevel: "hard", maxThinking: "high" },
	max: { maxLevel: "hard", maxThinking: "max" },
};

const HAIKU = "anthropic-subscription/claude-haiku-4-5";
const SONNET = "anthropic-subscription/claude-sonnet-5-5";
const OPUS = "anthropic-subscription/claude-opus-5-5";

/** Used when auto-router.jsonc does not exist; matches the original single-file router. */
export function defaultConfig(): RouterConfig {
	return {
		classifier: { models: [{ ref: HAIKU }], timeoutMs: 15_000, prompt: DEFAULT_CLASSIFIER_PROMPT },
		downgradeMaxContext: 80_000,
		hardKeywords: ["ulw", "ultrawork", "hyperplan"],
		complexKeywords: [...DEFAULT_COMPLEX_KEYWORDS],
		ackWords: [...DEFAULT_ACK_WORDS],
		ackMaxChars: 20,
		profiles: [
			{
				provider: "anthropic-subscription",
				id: "claude-auto",
				name: "Claude Auto",
				contextWindow: 300_000,
				levels: {
					trivial: { models: [{ ref: HAIKU }], thinking: "low", maxContext: 80_000 },
					standard: { models: [{ ref: SONNET }], thinking: "medium" },
					complex: { models: [{ ref: OPUS }], thinking: "high" },
					hard: { models: [{ ref: OPUS }], thinking: "max" },
				},
				tags: {
					haiku: { models: [{ ref: HAIKU }], thinking: "low", maxContext: 80_000 },
					sonnet: { models: [{ ref: SONNET }], thinking: "high" },
					opus: { models: [{ ref: OPUS }], thinking: "max" },
				},
				ceilings: structuredClone(DEFAULT_CEILINGS),
			},
		],
	};
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
		const configured = env[name]?.trim();
		if (configured) return resolve(configured);
	}
	return join(env.HOME || env.USERPROFILE || homedir(), ".omo", "agent");
}

export const configPath = (agentDir = resolveAgentDir()) =>
	process.env.AUTO_ROUTER_CONFIG?.trim() ? resolve(process.env.AUTO_ROUTER_CONFIG.trim()) : join(agentDir, "auto-router.jsonc");

/** JSON with // and /* comments and trailing commas, the same dialect as omo.jsonc. */
export function parseJsonc(text: string): unknown {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			const start = i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			out += text.slice(start, ++i);
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	return JSON.parse(out.replace(/^\uFEFF/, "").replace(/,(\s*[}\]])/g, "$1"));
}

/** "provider/model"; the model part may itself contain slashes (e.g. openrouter ids). */
export function splitRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const isThinking = (value: unknown): value is Thinking => THINKING.includes(value as Thinking);
const isLevel = (value: unknown): value is Level => LEVELS.includes(value as Level);

class Issues {
	readonly list: string[] = [];
	add(where: string, message: string): void {
		this.list.push(`${where}: ${message}`);
	}
}

function parseChoice(raw: unknown, where: string, issues: Issues): ModelChoice | undefined {
	const object = typeof raw === "string" ? { model: raw } : raw;
	if (!isObject(object) || typeof object.model !== "string") {
		issues.add(where, 'expected "provider/model" or { "model": "provider/model", "thinking"?: ... }');
		return undefined;
	}
	if (!splitRef(object.model)) {
		issues.add(where, `"${object.model}" is not in provider/model form`);
		return undefined;
	}
	if (object.thinking !== undefined && !isThinking(object.thinking)) {
		issues.add(where, `thinking must be one of ${THINKING.join(", ")}`);
		return undefined;
	}
	return object.thinking === undefined ? { ref: object.model } : { ref: object.model, thinking: object.thinking };
}

function parseChoices(raw: unknown, where: string, issues: Issues): ModelChoice[] {
	const list = Array.isArray(raw) ? raw : [raw];
	const choices = list.flatMap((item, index) => parseChoice(item, `${where}[${index}]`, issues) ?? []);
	if (list.length === 0) issues.add(where, "needs at least one model");
	return choices;
}

/**
 * A route is a model string, a list of candidates, or { models | model, thinking, maxContext }.
 * `fallbackThinking` fills in a missing thinking level.
 */
function parseRoute(raw: unknown, where: string, fallbackThinking: Thinking, issues: Issues): RouteSpec | undefined {
	if (typeof raw === "string" || Array.isArray(raw)) {
		const models = parseChoices(raw, `${where}.models`, issues);
		return models.length > 0 ? { models, thinking: fallbackThinking } : undefined;
	}
	if (!isObject(raw)) {
		issues.add(where, "expected a model string, a list, or an object");
		return undefined;
	}
	const source = raw.models ?? raw.model;
	if (source === undefined) {
		issues.add(where, 'needs "models" (or "model")');
		return undefined;
	}
	const models = parseChoices(source, `${where}.models`, issues);
	if (raw.thinking !== undefined && !isThinking(raw.thinking)) issues.add(`${where}.thinking`, `must be one of ${THINKING.join(", ")}`);
	const thinking = isThinking(raw.thinking) ? raw.thinking : fallbackThinking;
	let maxContext: number | undefined;
	if (raw.maxContext !== undefined) {
		if (typeof raw.maxContext === "number" && raw.maxContext > 0) maxContext = raw.maxContext;
		else issues.add(`${where}.maxContext`, "must be a positive number");
	}
	if (models.length === 0) return undefined;
	return maxContext === undefined ? { models, thinking } : { models, thinking, maxContext };
}

const LEVEL_THINKING: Record<Level, Thinking> = { trivial: "low", standard: "medium", complex: "high", hard: "max" };

function parseProfile(key: string, raw: unknown, issues: Issues): Profile | undefined {
	const where = `profiles["${key}"]`;
	const target = splitRef(key);
	if (!target) {
		issues.add(where, "key must be the virtual model as provider/id, e.g. auto/mixed");
		return undefined;
	}
	if (!isObject(raw)) {
		issues.add(where, "expected an object");
		return undefined;
	}
	const levelsRaw = isObject(raw.levels) ? raw.levels : {};
	if (!isObject(raw.levels)) issues.add(`${where}.levels`, `needs ${LEVELS.join(", ")}`);
	const levels: Partial<Record<Level, RouteSpec>> = {};
	for (const level of LEVELS) {
		if (levelsRaw[level] === undefined) {
			issues.add(`${where}.levels.${level}`, "is missing");
			continue;
		}
		const route = parseRoute(levelsRaw[level], `${where}.levels.${level}`, LEVEL_THINKING[level], issues);
		if (route) levels[level] = route;
	}
	for (const extra of Object.keys(levelsRaw).filter((name) => !isLevel(name))) {
		issues.add(`${where}.levels.${extra}`, `unknown level; use ${LEVELS.join(", ")}`);
	}
	if (LEVELS.some((level) => !levels[level])) return undefined;

	const tags: Record<string, RouteSpec> = {};
	if (raw.tags !== undefined) {
		if (!isObject(raw.tags)) issues.add(`${where}.tags`, "expected an object of tag name to route");
		else {
			for (const [name, value] of Object.entries(raw.tags)) {
				if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
					issues.add(`${where}.tags.${name}`, "tag names use letters, digits, '.', '_' or '-'");
					continue;
				}
				const route = parseRoute(value, `${where}.tags.${name}`, "high", issues);
				if (route) tags[name.toLowerCase()] = route;
			}
		}
	}

	const ceilings: Record<string, Ceiling> = structuredClone(DEFAULT_CEILINGS);
	if (raw.ceilings !== undefined) {
		if (!isObject(raw.ceilings)) issues.add(`${where}.ceilings`, "expected an object of thinking level to { maxLevel, maxThinking }");
		else {
			for (const [name, value] of Object.entries(raw.ceilings)) {
				const at = `${where}.ceilings.${name}`;
				if (!isThinking(name)) {
					issues.add(at, `key must be a thinking level (${THINKING.join(", ")})`);
					continue;
				}
				if (value === null) {
					delete ceilings[name];
					continue;
				}
				if (!isObject(value) || !isLevel(value.maxLevel) || !isThinking(value.maxThinking)) {
					issues.add(at, `expected { "maxLevel": ${LEVELS.join("|")}, "maxThinking": <thinking level> } or null`);
					continue;
				}
				ceilings[name] = { maxLevel: value.maxLevel, maxThinking: value.maxThinking };
			}
		}
	}
	if (Object.keys(ceilings).length === 0) {
		issues.add(`${where}.ceilings`, "removes every thinking level; keeping the defaults");
		Object.assign(ceilings, structuredClone(DEFAULT_CEILINGS));
	}

	let contextWindow = 200_000;
	if (raw.contextWindow !== undefined) {
		if (typeof raw.contextWindow === "number" && raw.contextWindow > 0) contextWindow = raw.contextWindow;
		else issues.add(`${where}.contextWindow`, "must be a positive number");
	}
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : target.id;
	return { provider: target.provider, id: target.id, name, contextWindow, levels: levels as Record<Level, RouteSpec>, tags, ceilings };
}

function stringList(raw: unknown, where: string, issues: Issues): string[] | undefined {
	if (Array.isArray(raw) && raw.every((item) => typeof item === "string" && item.trim())) return raw.map((item) => item.trim());
	issues.add(where, "expected a list of non-empty strings");
	return undefined;
}

/** Invalid parts are reported and replaced by defaults, so one typo never disables routing. */
export function normalizeConfig(raw: unknown): { config: RouterConfig; errors: string[] } {
	const issues = new Issues();
	const config = defaultConfig();
	if (!isObject(raw)) {
		issues.add("auto-router.jsonc", "top level must be an object");
		return { config, errors: issues.list };
	}

	if (raw.classifier !== undefined) {
		if (!isObject(raw.classifier)) issues.add("classifier", "expected an object");
		else {
			const { models, model, timeoutMs, prompt } = raw.classifier;
			const source = models ?? model;
			if (source !== undefined) {
				const choices = parseChoices(source, "classifier.models", issues);
				if (choices.length > 0) config.classifier.models = choices;
			}
			if (timeoutMs !== undefined) {
				if (typeof timeoutMs === "number" && timeoutMs >= 1_000) config.classifier.timeoutMs = timeoutMs;
				else issues.add("classifier.timeoutMs", "must be a number of milliseconds, at least 1000");
			}
			if (prompt !== undefined) {
				if (typeof prompt === "string" && prompt.trim()) config.classifier.prompt = prompt;
				else issues.add("classifier.prompt", "must be a non-empty string");
			}
		}
	}

	if (raw.downgradeMaxContext !== undefined) {
		if (typeof raw.downgradeMaxContext === "number" && raw.downgradeMaxContext >= 0) config.downgradeMaxContext = raw.downgradeMaxContext;
		else issues.add("downgradeMaxContext", "must be a number of tokens");
	}
	if (raw.ackMaxChars !== undefined) {
		if (typeof raw.ackMaxChars === "number" && raw.ackMaxChars >= 0) config.ackMaxChars = raw.ackMaxChars;
		else issues.add("ackMaxChars", "must be a number");
	}
	if (raw.hardKeywords !== undefined) config.hardKeywords = stringList(raw.hardKeywords, "hardKeywords", issues) ?? config.hardKeywords;
	if (raw.complexKeywords !== undefined) config.complexKeywords = stringList(raw.complexKeywords, "complexKeywords", issues) ?? config.complexKeywords;
	if (raw.ackWords !== undefined) config.ackWords = stringList(raw.ackWords, "ackWords", issues) ?? config.ackWords;

	if (raw.profiles !== undefined) {
		if (!isObject(raw.profiles)) issues.add("profiles", 'expected an object keyed by virtual model, e.g. { "auto/mixed": { ... } }');
		else {
			const profiles = Object.entries(raw.profiles).flatMap(([key, value]) => parseProfile(key, value, issues) ?? []);
			if (profiles.length > 0) config.profiles = profiles;
			else issues.add("profiles", "no valid profile; using the built-in claude-auto profile");
		}
	}

	return { config, errors: issues.list };
}

let cache: { path: string; mtimeMs: number; loaded: LoadedConfig } | undefined;

/** Re-reads the file only when its mtime changes, so routing picks up edits without a restart. */
export function loadConfig(path = configPath()): LoadedConfig {
	if (!existsSync(path)) {
		cache = undefined;
		return { config: defaultConfig(), errors: [], path, exists: false };
	}
	const mtimeMs = statSync(path).mtimeMs;
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.loaded;
	let loaded: LoadedConfig;
	try {
		const { config, errors } = normalizeConfig(parseJsonc(readFileSync(path, "utf8")));
		loaded = { config, errors, path, exists: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		loaded = { config: defaultConfig(), errors: [`auto-router.jsonc: cannot parse (${message})`], path, exists: true };
	}
	cache = { path, mtimeMs, loaded };
	return loaded;
}
