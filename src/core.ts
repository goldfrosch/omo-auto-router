import { LEVELS, THINKING, type Ceiling, type Level, type ModelChoice, type Profile, type RouteSpec, type RouterConfig, type Thinking } from "./config.ts";

/** Stored on the session branch. A tag route has no level, so the next turn never counts it as a downgrade. */
export interface RouterState {
	level?: Level;
	tag?: string;
	size?: Level;
}

export type Source = "tag" | "rule" | "ack" | "locked" | "classifier" | "fallback";

export interface DecideInput {
	config: RouterConfig;
	profile: Profile;
	prompt: string;
	current?: RouterState;
	ctxTokens: number;
	selectedThinking: string;
}

export interface Decision {
	source: Source;
	state: RouterState;
	route: RouteSpec;
	thinking: Thinking;
	classifierError?: string;
}

export type Classify = () => Promise<{ size?: Level; error?: string }>;

const rank = (level: Level) => LEVELS.indexOf(level);
const thinkingRank = (thinking: Thinking) => THINKING.indexOf(thinking);
export const minThinking = (a: Thinking, b: Thinking): Thinking => (thinkingRank(a) <= thinkingRank(b) ? a : b);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Unknown virtual levels get the most permissive ceiling the profile defines. */
export function ceilingFor(profile: Profile, selected: string): Ceiling {
	const exact = profile.ceilings[selected];
	if (exact) return exact;
	const all = Object.values(profile.ceilings);
	return all.reduce((best, next) => (rank(next.maxLevel) > rank(best.maxLevel) ? next : best), all[0] ?? { maxLevel: "hard", maxThinking: "max" });
}

export function findTag(profile: Profile, prompt: string): string | undefined {
	const names = Object.keys(profile.tags);
	if (names.length === 0) return undefined;
	const pattern = names.sort((a, b) => b.length - a.length).map(escape).join("|");
	return new RegExp(`(?:^|\\s)#(${pattern})(?![\\w.-])`, "i").exec(prompt)?.[1]?.toLowerCase();
}

export function hasHardKeyword(config: RouterConfig, prompt: string): boolean {
	if (config.hardKeywords.length === 0) return false;
	const pattern = config.hardKeywords.map(escape).join("|");
	return new RegExp(`\\b(?:${pattern})(?:-[a-z]+)?\\b`, "i").test(prompt);
}

export function isAck(config: RouterConfig, prompt: string): boolean {
	const trimmed = prompt.trim();
	if (!trimmed || trimmed.length > config.ackMaxChars || /[?？]/.test(trimmed) || config.ackWords.length === 0) return false;
	const words = [...config.ackWords].sort((a, b) => b.length - a.length).map(escape).join("|");
	return new RegExp(`^(?:${words})(?=$|[\\s.,!~…ㅋㅎ])`, "i").test(trimmed);
}

/** Context too large for a route: climb to the first higher level that has room, ending at hard. */
export function fitContext(profile: Profile, level: Level, ctxTokens: number): Level {
	let at = level;
	while (rank(at) < LEVELS.length - 1) {
		const limit = profile.levels[at].maxContext;
		if (limit === undefined || ctxTokens < limit) break;
		at = LEVELS[rank(at) + 1] as Level;
	}
	return at;
}

/**
 * Picks the route for a user turn. Order: #tag, hard keyword, short acknowledgement, locked at the
 * ceiling, then the classifier. Downgrades are refused once the context reaches
 * `downgradeMaxContext` because switching models drops the prompt cache.
 */
export async function decide(input: DecideInput, classify: Classify): Promise<Decision> {
	const { config, profile, prompt, current, ctxTokens } = input;
	const ceiling = ceilingFor(profile, input.selectedThinking);

	const tag = findTag(profile, prompt);
	if (tag) {
		const route = profile.tags[tag] as RouteSpec;
		if (route.maxContext !== undefined && ctxTokens >= route.maxContext) {
			const level = fitContext(profile, "standard", ctxTokens);
			return { source: "tag", state: { level }, route: profile.levels[level], thinking: profile.levels[level].thinking };
		}
		return { source: "tag", state: { tag }, route, thinking: route.thinking };
	}

	let source: Source;
	let size: Level | undefined;
	let classifierError: string | undefined;
	if (hasHardKeyword(config, prompt)) {
		source = "rule";
		size = "hard";
	} else if (current && isAck(config, prompt)) {
		source = "ack";
		if (current.tag && profile.tags[current.tag]) {
			const route = profile.tags[current.tag] as RouteSpec;
			return { source, state: current, route, thinking: route.thinking };
		}
	} else if (current?.level && ctxTokens >= config.downgradeMaxContext && rank(current.level) >= rank(ceiling.maxLevel)) {
		source = "locked";
	} else {
		const result = await classify();
		size = result.size;
		classifierError = result.error;
		source = size ? "classifier" : "fallback";
	}

	let level: Level = size ?? current?.level ?? "standard";
	if (current?.level && ctxTokens >= config.downgradeMaxContext && rank(level) < rank(current.level)) level = current.level;
	if (rank(level) > rank(ceiling.maxLevel)) level = ceiling.maxLevel;
	level = fitContext(profile, level, ctxTokens);

	const route = profile.levels[level];
	const state: RouterState = size ? { level, size } : { level };
	return {
		source,
		state,
		route,
		thinking: minThinking(route.thinking, ceiling.maxThinking),
		...(classifierError ? { classifierError } : {}),
	};
}

export function routeOfState(profile: Profile, state: RouterState | undefined): RouteSpec | undefined {
	if (state?.tag) return profile.tags[state.tag];
	return state?.level ? profile.levels[state.level] : undefined;
}

/** The level whose candidates list `ref`, so a turn after a manual switch still compares correctly. */
export function levelOfModel(profile: Profile, ref: string): Level | undefined {
	for (let i = LEVELS.length - 1; i >= 0; i--) {
		const level = LEVELS[i] as Level;
		if (profile.levels[level].models.some((choice) => choice.ref === ref)) return level;
	}
	return undefined;
}

export function pickModel(route: RouteSpec, usable: (ref: string) => boolean, after?: string): ModelChoice | undefined {
	const start = after === undefined ? 0 : route.models.findIndex((choice) => choice.ref === after) + 1;
	if (after !== undefined && start === 0) return undefined;
	return route.models.slice(start).find((choice) => usable(choice.ref));
}

export const isOverflowError = (message: string) => /context|too long|too large|overflow|maximum.*tokens/i.test(message);
export const isTransientError = (message: string) =>
	/overload|rate.?limit|\b429\b|\b5\d\d\b|unavailable|timed? ?out|capacity|quota/i.test(message);
