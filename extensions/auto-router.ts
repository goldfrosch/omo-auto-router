import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { LEVELS, THINKING, loadConfig, resolveAgentDir, splitRef, type Level, type Profile, type RouteSpec, type RouterConfig } from "../src/config.ts";
import {
	ceilingFor,
	decide,
	isOverflowError,
	isTransientError,
	levelOfModel,
	minThinking,
	pickModel,
	routeOfState,
	type RouterState,
} from "../src/core.ts";
import { appendLog, readLog, summarize } from "../src/log.ts";

const STATUS_KEY = "auto-router";
const LEGACY_FILE = join(resolveAgentDir(), "extensions", "auto-router.ts");

interface Previous {
	user: string;
	assistant: string;
}

interface Resolved {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
}

/** Latest typed input per session: route() runs before the user message joins the branch. */
const typedInput = new Map<string, { text: string; at: number }>();

const refOf = (model: Model<Api>) => `${model.provider}/${model.id}`;
const keyOf = (profile: Pick<Profile, "provider" | "id">) => `${profile.provider}/${profile.id}`;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join("\n");
}

/** Reads the session branch so omo's injected custom messages stay out of the classifier context. */
function readPrevious(ctx: ExtensionContext): Previous {
	const branch = ctx.sessionManager.getBranch();
	let assistant = "";
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const { role, content } = entry.message as { role: string; content?: unknown };
		if (!assistant) {
			if (role === "assistant") assistant = textOf(content);
		} else if (role === "user") {
			return { user: textOf(content), assistant };
		}
	}
	return { user: "", assistant };
}

function fallbackPrompt(messages: readonly { role: string; content?: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		return textOf(message.content)
			.replace(/<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, "")
			.trim();
	}
	return "";
}

function findModel(ctx: ExtensionContext, ref: string): Model<Api> | undefined {
	const parts = splitRef(ref);
	return parts ? ctx.modelRegistry.find(parts.provider, parts.id) : undefined;
}

function usable(ctx: ExtensionContext, ref: string): boolean {
	const model = findModel(ctx, ref);
	return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
}

async function classify(
	ctx: ExtensionContext,
	config: RouterConfig,
	previous: Previous,
	prompt: string,
	signal: AbortSignal | undefined,
): Promise<{ size?: Level; error?: string; model?: string }> {
	const candidates = config.classifier.models.filter((candidate) => usable(ctx, candidate.ref));
	if (candidates.length === 0) return { error: `no classifier model has credentials (${config.classifier.models.map((c) => c.ref).join(", ")})` };
	const sections: string[] = [];
	if (previous.user || previous.assistant) {
		sections.push(`<previous>\nUser: ${previous.user.slice(0, 600)}\nAssistant: ${previous.assistant.slice(-1200)}\n</previous>`);
	}
	sections.push(`<request>\n${prompt.slice(0, 6000)}\n</request>`);
	const errors: string[] = [];
	let lastRef: string | undefined;
	for (const choice of candidates) {
		if (signal?.aborted) break;
		lastRef = choice.ref;
		const model = findModel(ctx, choice.ref) as Model<Api>;
		const timeout = AbortSignal.timeout(config.classifier.timeoutMs);
		const reasoning = choice.thinking && choice.thinking !== "off" ? (choice.thinking as Exclude<ModelThinkingLevel, "off">) : undefined;
		try {
			const stream = ctx.modelRegistry.streamSimple(
				model,
				{
					systemPrompt: config.classifier.prompt,
					messages: [{ role: "user", content: sections.join("\n\n"), timestamp: Date.now() }],
				},
				{
					// Reasoning models spend output tokens on thinking first; a 16-token cap leaves no answer.
					maxTokens: model.reasoning ? 2048 : 16,
					...(reasoning ? { reasoning } : {}),
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				},
			);
			const result = await stream.result();
			if (result.stopReason === "error" || result.stopReason === "aborted") {
				const timedOut = timeout.aborted && !signal?.aborted;
				errors.push(`${choice.ref}: ${timedOut ? `timed out after ${config.classifier.timeoutMs} ms` : (result.errorMessage ?? result.stopReason)}`);
				continue;
			}
			const answer = textOf(result.content).toLowerCase();
			const size = LEVELS.find((level) => new RegExp(`\\b${level}\\b`).test(answer));
			if (size) return errors.length ? { size, model: choice.ref, error: errors.join("; ") } : { size, model: choice.ref };
			const blocks = Array.isArray(result.content) ? result.content.map((block) => block.type).join(",") : typeof result.content;
			errors.push(`${choice.ref}: unparsed answer "${answer.slice(0, 60)}" (stop ${result.stopReason}, blocks ${blocks || "none"})`);
		} catch (error) {
			errors.push(`${choice.ref}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { error: errors.join("; ") || "aborted", ...(lastRef ? { model: lastRef } : {}) };
}

function describeRoute(ctx: ExtensionContext, route: RouteSpec): string {
	return route.models
		.map((choice) => `${choice.ref}${usable(ctx, choice.ref) ? "" : " (unavailable)"}${choice.thinking ? `:${choice.thinking}` : ""}`)
		.join(" > ");
}

function doctorReport(ctx: ExtensionContext): string {
	const { config, errors, path, exists } = loadConfig();
	const lines = [`auto-router config: ${path}${exists ? "" : " (not found, using built-in claude-auto)"}`];
	for (const error of errors) lines.push(`  error: ${error}`);
	if (existsSync(LEGACY_FILE)) lines.push(`  warning: ${LEGACY_FILE} also registers a router; run the setup script to retire it`);
	lines.push(`classifier: ${config.classifier.models.map((c) => `${c.ref}${usable(ctx, c.ref) ? "" : " (unavailable)"}`).join(" > ")}, timeout ${config.classifier.timeoutMs} ms`);
	for (const profile of config.profiles) {
		lines.push(`${keyOf(profile)} "${profile.name}"`);
		for (const level of LEVELS) {
			const route = profile.levels[level];
			lines.push(`  ${level.padEnd(9)} ${route.thinking.padEnd(7)} ${describeRoute(ctx, route)}${route.maxContext ? ` (< ${route.maxContext} tokens)` : ""}`);
		}
		for (const [tag, route] of Object.entries(profile.tags)) lines.push(`  #${tag.padEnd(8)} ${route.thinking.padEnd(7)} ${describeRoute(ctx, route)}`);
	}
	return lines.join("\n");
}

export default function autoRouter(pi: ExtensionAPI): void {
	const registered = new Map<string, Profile>();
	let logFailureShown = false;

	function currentProfile(provider: string, id: string): Profile | undefined {
		const key = `${provider}/${id}`;
		return loadConfig().config.profiles.find((profile) => keyOf(profile) === key) ?? registered.get(key);
	}

	async function log(ctx: ExtensionContext, entry: Record<string, unknown>): Promise<void> {
		try {
			await appendLog(entry);
		} catch (error) {
			if (logFailureShown || !ctx.hasUI) return;
			logFailureShown = true;
			ctx.ui.notify(`auto-router: cannot write the decision log (${error instanceof Error ? error.message : String(error)})`, "warning");
		}
	}

	function resolve(ctx: ExtensionContext, profile: Profile, route: RouteSpec, selected: string, after?: string): Resolved | undefined {
		const choice = pickModel(route, (ref) => usable(ctx, ref), after);
		if (!choice) return undefined;
		const thinking = minThinking(choice.thinking ?? route.thinking, ceilingFor(profile, selected).maxThinking);
		return { model: findModel(ctx, choice.ref) as Model<Api>, thinkingLevel: thinking as ModelThinkingLevel };
	}

	function showRoute(ctx: ExtensionContext, resolved: Resolved): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `→ ${resolved.model.name || resolved.model.id} · ${resolved.thinkingLevel}`);
	}

	function register(profile: Profile): void {
		const thinkingLevels = THINKING.filter((level) => level in profile.ceilings);
		registered.set(keyOf(profile), profile);
		pi.registerVirtualModel<RouterState>({
			provider: profile.provider,
			id: profile.id,
			name: profile.name,
			thinkingLevels,
			contextWindow: profile.contextWindow,
			async route(request, ctx) {
				const active = currentProfile(profile.provider, profile.id) ?? profile;
				const previous = request.previous;
				const selected = request.thinkingLevel;

				if ((request.reason === "direct" || request.reason === "continuation") && previous) {
					return { model: previous.model, thinkingLevel: previous.thinkingLevel ?? "medium" };
				}
				if (request.reason === "direct") {
					const resolved = resolve(ctx, active, active.levels.standard, selected);
					if (!resolved) throw new Error(`auto-router: no model with credentials for ${keyOf(active)} standard`);
					return resolved;
				}
				if (request.reason === "retry" && request.failed) {
					const { failed } = request;
					const message = failed.message.errorMessage ?? "";
					const failedRef = refOf(failed.model);
					const state = request.state;
					const route = routeOfState(active, state);
					let next: Resolved | undefined;
					let to: RouterState | undefined;
					if (isOverflowError(message) && route?.maxContext !== undefined) {
						const from = state?.level ?? "standard";
						const level = (LEVELS[LEVELS.indexOf(from) + 1] ?? "hard") as Level;
						next = resolve(ctx, active, active.levels[level], selected);
						to = { level, ...(state?.size ? { size: state.size } : {}) };
					} else if (isTransientError(message) && route) {
						next = resolve(ctx, active, route, selected, failedRef);
					}
					if (next) {
						await log(ctx, { session: ctx.sessionManager.getSessionId(), profile: keyOf(active), reason: "retry", source: "failover", model: refOf(next.model), error: message.slice(0, 160) });
						showRoute(ctx, next);
						return to ? { ...next, state: to } : next;
					}
					return { model: failed.model, thinkingLevel: failed.thinkingLevel ?? "medium" };
				}

				const started = Date.now();
				const { config, errors } = loadConfig();
				const previousLevel = previous ? levelOfModel(active, refOf(previous.model)) : undefined;
				const current: RouterState | undefined = request.state ?? (previousLevel ? { level: previousLevel } : undefined);
				const ctxTokens = ctx.getContextUsage()?.tokens ?? 0;
				const sessionId = ctx.sessionManager.getSessionId();
				const typed = typedInput.get(sessionId);
				typedInput.delete(sessionId);
				const prompt = typed?.text ?? fallbackPrompt(request.messages);
				let classifierModel: string | undefined;

				const decision = await decide(
					{ config, profile: active, prompt, ctxTokens, selectedThinking: selected, ...(current ? { current } : {}) },
					async () => {
						const result = await classify(ctx, config, readPrevious(ctx), prompt, request.signal);
						classifierModel = result.model;
						return result;
					},
				);

				let resolved = resolve(ctx, active, decision.route, selected);
				let resolveError: string | undefined;
				if (!resolved) {
					resolveError = `no model with credentials in ${decision.route.models.map((c) => c.ref).join(", ")}`;
					if (!previous) throw new Error(`auto-router: ${resolveError}`);
					resolved = { model: previous.model, thinkingLevel: previous.thinkingLevel ?? "medium" };
				}

				const state = decision.state;
				const unchanged = request.state?.level === state.level && request.state?.tag === state.tag && request.state?.size === state.size;
				const error = [decision.classifierError, resolveError, errors.length ? `config: ${errors[0]}` : undefined].filter(Boolean).join("; ");
				await log(ctx, {
					session: sessionId,
					profile: keyOf(active),
					reason: request.reason,
					ceiling: selected,
					ctxTokens,
					source: decision.source,
					size: state.size,
					from: current?.tag ? `#${current.tag}` : (current?.level ?? null),
					to: state.tag ? `#${state.tag}` : state.level,
					model: refOf(resolved.model),
					thinking: resolved.thinkingLevel,
					classifier: classifierModel,
					ms: Date.now() - started,
					sinceInputMs: typed ? started - typed.at : null,
					prompt: prompt.trim().slice(0, 80),
					...(error ? { error } : {}),
				});
				showRoute(ctx, resolved);
				return { ...resolved, state: unchanged ? request.state : state };
			},
		});
	}

	function syncRegistrations(): string[] {
		const { config } = loadConfig();
		const wanted = new Set(config.profiles.map(keyOf));
		const removed: string[] = [];
		for (const key of [...registered.keys()]) {
			if (wanted.has(key)) continue;
			const profile = registered.get(key) as Profile;
			pi.unregisterVirtualModel(profile.provider, profile.id);
			registered.delete(key);
			removed.push(key);
		}
		for (const profile of config.profiles) register(profile);
		return removed;
	}

	syncRegistrations();

	pi.on("input", (event, ctx) => {
		typedInput.set(ctx.sessionManager.getSessionId(), { text: event.text, at: Date.now() });
	});

	pi.on("model_select", (event, ctx) => {
		if (!registered.has(refOf(event.model))) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const { errors } = loadConfig();
		if (errors.length > 0) ctx.ui.notify(`auto-router: ${errors.length} config problem(s); /auto-router shows them`, "warning");
		if (existsSync(LEGACY_FILE)) ctx.ui.notify(`auto-router: ${LEGACY_FILE} also registers a router; run the setup script to retire it`, "warning");
	});

	pi.registerCommand("auto-router", {
		description: "auto-router: `/auto-router` checks config and models, `stats [days]` summarizes decisions, `reload` re-registers profiles",
		getArgumentCompletions: (prefix) =>
			["doctor", "stats", "reload"].filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const [command = "doctor", value] = args.trim().split(/\s+/);
			if (command === "stats") {
				const days = Math.max(1, Number(value) || 7);
				ctx.ui.notify(summarize(await readLog(days), days), "info");
				return;
			}
			if (command === "reload") {
				const removed = syncRegistrations();
				const keys = [...registered.keys()].join(", ");
				ctx.ui.notify(`auto-router: registered ${keys}${removed.length ? `; removed ${removed.join(", ")}` : ""}`, "info");
				return;
			}
			ctx.ui.notify(doctorReport(ctx), loadConfig().errors.length ? "warning" : "info");
		},
	});
}
