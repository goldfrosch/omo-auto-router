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
	/** Context a route's model can take; caps `maxContext` when known. */
	roomOf?: RoomOf;
}

export interface Decision {
	source: Source;
	state: RouterState;
	route: RouteSpec;
	thinking: Thinking;
	/** Which rule decided a `rule` turn when it was not a hard keyword. */
	rule?: "chore";
	classifierError?: string;
}

export type Classify = () => Promise<{ size?: Level; error?: string }>;

/** Context tokens a route's model can take while leaving room for its largest answer. */
export type RoomOf = (route: RouteSpec) => number | undefined;

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

/** Plain substring match: \b does not work around Hangul. */
export function hasComplexKeyword(config: RouterConfig, prompt: string): boolean {
	const text = prompt.toLowerCase();
	return config.complexKeywords.some((word) => text.includes(word.toLowerCase()));
}

/** A short routine request such as a commit or deploy. Substring match, like hasComplexKeyword. */
export function isChore(config: RouterConfig, prompt: string): boolean {
	const trimmed = prompt.trim();
	if (config.choreKeywords.length === 0 || trimmed.length > config.choreMaxChars) return false;
	const text = trimmed.toLowerCase();
	const has = (word: string) => text.includes(word.toLowerCase());
	return config.choreKeywords.some(has) && !config.choreBlockKeywords.some(has);
}

export function isAck(config: RouterConfig, prompt: string): boolean {
	const trimmed = prompt.trim();
	if (!trimmed || trimmed.length > config.ackMaxChars || /[?？]/.test(trimmed) || config.ackWords.length === 0) return false;
	const words = [...config.ackWords].sort((a, b) => b.length - a.length).map(escape).join("|");
	return new RegExp(`^(?:${words})(?=$|[\\s.,!~…ㅋㅎ])`, "i").test(trimmed);
}

/** The smaller of the route's `maxContext` and what its model can take. */
export function limitOf(route: RouteSpec, roomOf?: RoomOf): number | undefined {
	const room = roomOf?.(route);
	if (room === undefined) return route.maxContext;
	return route.maxContext === undefined ? room : Math.min(room, route.maxContext);
}

/** Context too large for a route: climb to the first higher level that has room, ending at hard. */
export function fitContext(profile: Profile, level: Level, ctxTokens: number, roomOf?: RoomOf): Level {
	let at = level;
	while (rank(at) < LEVELS.length - 1) {
		const limit = limitOf(profile.levels[at], roomOf);
		if (limit === undefined || ctxTokens < limit) break;
		at = LEVELS[rank(at) + 1] as Level;
	}
	return at;
}

/**
 * Picks the route for a user turn. Order: #tag, hard keyword, chore, short acknowledgement, locked
 * at the ceiling, then the classifier. Downgrades are refused once the context reaches
 * `downgradeMaxContext` because switching models drops the prompt cache; a chore is exempt.
 */
export async function decide(input: DecideInput, classify: Classify): Promise<Decision> {
	const { config, profile, prompt, current, ctxTokens } = input;
	const ceiling = ceilingFor(profile, input.selectedThinking);

	const tag = findTag(profile, prompt);
	if (tag) {
		const route = profile.tags[tag] as RouteSpec;
		const limit = limitOf(route, input.roomOf);
		if (limit !== undefined && ctxTokens >= limit) {
			const level = fitContext(profile, "standard", ctxTokens, input.roomOf);
			return { source: "tag", state: { level }, route: profile.levels[level], thinking: profile.levels[level].thinking };
		}
		return { source: "tag", state: { tag }, route, thinking: route.thinking };
	}

	let source: Source;
	let size: Level | undefined;
	let classifierError: string | undefined;
	let floor: Level | undefined;
	let chore = false;
	if (hasHardKeyword(config, prompt)) {
		source = "rule";
		size = "hard";
	} else if (isChore(config, prompt)) {
		source = "rule";
		size = config.choreLevel;
		chore = true;
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
		if (!size && hasComplexKeyword(config, prompt)) floor = "complex";
	}

	const held: Level = current?.level ?? "standard";
	let level: Level = size ?? (floor && rank(floor) > rank(held) ? floor : held);
	if (!chore && current?.level && ctxTokens >= config.downgradeMaxContext && rank(level) < rank(current.level)) level = current.level;
	if (rank(level) > rank(ceiling.maxLevel)) level = ceiling.maxLevel;
	level = fitContext(profile, level, ctxTokens, input.roomOf);

	const route = profile.levels[level];
	const state: RouterState = size ? { level, size } : { level };
	return {
		source,
		state,
		route,
		thinking: minThinking(route.thinking, ceiling.maxThinking),
		...(chore ? { rule: "chore" as const } : {}),
		...(classifierError ? { classifierError } : {}),
	};
}

export function routeOfState(profile: Profile, state: RouterState | undefined): RouteSpec | undefined {
	if (state?.tag) return profile.tags[state.tag];
	return state?.level ? profile.levels[state.level] : undefined;
}

/**
 * Mid-turn check: tool results can grow the context past the route chosen at the start of the
 * turn. Returns the state to climb to, or undefined when the current route still has room.
 */
export function outgrown(profile: Profile, state: RouterState | undefined, ctxTokens: number, roomOf?: RoomOf): RouterState | undefined {
	const route = routeOfState(profile, state);
	if (!state || !route) return undefined;
	const limit = limitOf(route, roomOf);
	if (limit === undefined || ctxTokens < limit) return undefined;
	const level = fitContext(profile, state.tag ? "standard" : (state.level ?? "standard"), ctxTokens, roomOf);
	if (!state.tag && level === state.level) return undefined;
	return state.size ? { level, size: state.size } : { level };
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

/** Summary model for a virtual model's compaction: the first usable `compactionModel`, else the standard route. */
export function compactionTarget(config: RouterConfig, profile: Profile, usable: (ref: string) => boolean): string | undefined {
	return config.compactionModel.find(usable) ?? pickModel(profile.levels.standard, usable)?.ref;
}

export const isOverflowError = (message: string) => /context|too long|too large|overflow|maximum.*tokens/i.test(message);
export const isTransientError = (message: string) =>
	/overload|rate.?limit|\b429\b|\b5\d\d\b|unavailable|timed? ?out|capacity|quota/i.test(message);
