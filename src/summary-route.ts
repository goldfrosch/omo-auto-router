/**
 * senpi routes a virtual model in the agent loop and in ModelRuntime.streamSimple() (reason
 * "direct"), but its builtin compaction summarizer calls ModelRuntime.stream() with the session
 * model. For a router profile that request reaches the provider unrouted and fails with "Virtual
 * model ... must be routed before streaming", so every compaction fell back to the deterministic
 * summary. routeSummaryStreams() closes that gap on one runtime.
 */

/** senpi's VIRTUAL_MODEL_API: the api id of virtual catalog entries. */
export const VIRTUAL_API = "pi-virtual";

export interface StreamModel {
	api: string;
	provider: string;
	id: string;
	maxTokens: number;
}

/** The options read or rewritten here; every other option passes through. */
export interface StreamOptions {
	maxTokens?: number;
	apiKey?: unknown;
	headers?: unknown;
	env?: unknown;
	extraBody?: unknown;
}

/** The part of senpi's ModelRuntime that is wrapped. */
export interface SummaryRuntime {
	stream(model: StreamModel, context: unknown, options?: StreamOptions): unknown;
}

/** Physical model for a virtual one, or undefined to leave the request alone. */
export type SummaryTarget = (model: StreamModel) => StreamModel | undefined;

/** A global symbol: a reloaded extension is a fresh module instance and must find the same slot. */
const TARGET: unique symbol = Symbol.for("omo-auto-router.summary-target");

/**
 * The rules ModelRuntime.streamSimple() applies to a routed virtual request: the output budget is
 * capped to the routed model, and request auth (key, headers, env, extra body) resolved for the
 * virtual model's provider only goes to that provider; another provider resolves its own.
 */
export function routedOptions(from: StreamModel, to: StreamModel, options: StreamOptions | undefined): StreamOptions | undefined {
	if (!options) return options;
	const { apiKey, headers, env, extraBody, ...rest } = options;
	const auth = to.provider === from.provider ? { apiKey, headers, env, extraBody } : {};
	const maxTokens = options.maxTokens && to.maxTokens > 0 ? Math.min(options.maxTokens, to.maxTokens) : options.maxTokens;
	return { ...rest, ...auth, maxTokens };
}

/**
 * Wraps `runtime.stream` so a virtual model streams on the physical model `target` picks. Physical
 * models, and virtual models `target` does not know, pass through untouched. A runtime is wrapped
 * once; calling this again (after /reload) only swaps the target.
 */
export function routeSummaryStreams(runtime: SummaryRuntime, target: SummaryTarget): void {
	const slot = runtime as SummaryRuntime & { [TARGET]?: SummaryTarget };
	const wrapped = slot[TARGET] !== undefined;
	slot[TARGET] = target;
	if (wrapped) return;
	const stream = runtime.stream;
	runtime.stream = (model, context, options) => {
		const physical = model.api === VIRTUAL_API ? slot[TARGET]?.(model) : undefined;
		return physical
			? stream.call(runtime, physical, context, routedOptions(model, physical, options))
			: stream.call(runtime, model, context, options);
	};
}
