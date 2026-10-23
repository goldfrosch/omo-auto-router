/**
 * Installs omo-auto-router into omo's agent dir.
 *
 *   bun scripts/setup.ts              apply (idempotent)
 *   bun scripts/setup.ts --check      report problems only; exits 1 when something is off
 *   bun scripts/setup.ts --uninstall  undo what apply changed; your auto-router.jsonc is kept
 *
 * apply: writes auto-router.jsonc from config.example.jsonc when missing, renames a legacy
 * extensions/auto-router.ts (it registers the same virtual model) to *.retired, and lists this
 * checkout in settings.json packages unless an `omo install git:...` entry already loads it.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath, loadConfig, resolveAgentDir } from "../src/config.ts";

type JsonObject = Record<string, unknown>;

interface SetupState {
	version: 1;
	createdConfig: boolean;
	retiredLegacy?: string;
	addedPackage: boolean;
	hadPackagesKey: boolean;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = resolveAgentDir();
const paths = {
	settings: join(agentDir, "settings.json"),
	state: join(agentDir, "omo-auto-router.state.json"),
	config: configPath(agentDir),
	example: join(packageRoot, "config.example.jsonc"),
	legacy: join(agentDir, "extensions", "auto-router.ts"),
};

function readObject(path: string): JsonObject | undefined {
	if (!existsSync(path)) return undefined;
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
	return parsed as JsonObject;
}

function writeObject(path: string, value: JsonObject): void {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	if (existsSync(path)) {
		if (readFileSync(path, "utf8") === text) return;
		copyFileSync(path, `${path}.auto-router-backup-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`);
	}
	const temp = `${path}.auto-router-tmp`;
	writeFileSync(temp, text, "utf8");
	renameSync(temp, path);
}

function samePath(a: string, b: string): boolean {
	const fold = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
	return fold(a) === fold(b);
}

const sourceOf = (entry: unknown) => (typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source);

function isThisPackage(entry: unknown): boolean {
	const source = sourceOf(entry);
	if (typeof source !== "string" || /^(npm|git):|^[a-z][a-z0-9+.-]+:\/\//i.test(source)) return false;
	const expanded = source.startsWith("~") ? join(homedir(), source.slice(1)) : source;
	return samePath(resolve(agentDir, expanded), packageRoot);
}

/** senpi clones git sources to <agentDir>/git/<host>/<path> without the @ref and ".git". */
function gitCloneDir(source: string): string | undefined {
	const url = source.startsWith("git:") ? source.slice(4).trim() : source;
	let hostPath: string | undefined;
	if (/^(https?|ssh|git):\/\//i.test(url)) {
		try {
			const parsed = new URL(url);
			hostPath = parsed.hostname + parsed.pathname;
		} catch {
			return undefined;
		}
	} else if (source.startsWith("git:")) hostPath = url.replace(/^git@([^:/]+):/, "$1/");
	if (!hostPath) return undefined;
	return join(agentDir, "git", hostPath.replace(/@[^/]*$/, "").replace(/\.git$/, ""));
}

function loadsThisPackage(entry: unknown): boolean {
	if (isThisPackage(entry)) return true;
	const source = sourceOf(entry);
	const cloneDir = typeof source === "string" ? gitCloneDir(source) : undefined;
	return cloneDir !== undefined && samePath(cloneDir, packageRoot);
}

function readState(): SetupState | undefined {
	const state = readObject(paths.state);
	if (state === undefined) return undefined;
	if (state.version !== 1) throw new Error(`${paths.state} has an unknown format`);
	return state as unknown as SetupState;
}

function apply(): string[] {
	if (!existsSync(agentDir)) throw new Error(`agent dir ${agentDir} does not exist; start omo once first`);
	const settings = readObject(paths.settings) ?? {};
	const state: SetupState = readState() ?? { version: 1, createdConfig: false, addedPackage: false, hadPackagesKey: "packages" in settings };
	const changes: string[] = [];

	if (!existsSync(paths.config)) {
		copyFileSync(paths.example, paths.config);
		state.createdConfig = true;
		changes.push(`created ${paths.config}`);
	}
	if (existsSync(paths.legacy)) {
		const retired = `${paths.legacy}.retired-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
		renameSync(paths.legacy, retired);
		state.retiredLegacy = retired;
		changes.push(`retired ${paths.legacy} -> ${retired}`);
	}
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	if (!packages.some(loadsThisPackage)) {
		writeObject(paths.state, state as unknown as JsonObject);
		writeObject(paths.settings, { ...settings, packages: [...packages, packageRoot] });
		state.addedPackage = true;
		changes.push(`settings packages: + ${packageRoot}`);
	}
	if (changes.length > 0) writeObject(paths.state, state as unknown as JsonObject);
	return changes;
}

function uninstall(): string[] {
	const state = readState();
	if (!state) throw new Error(`nothing to undo: ${paths.state} not found`);
	const changes: string[] = [];
	if (state.addedPackage) {
		const settings = readObject(paths.settings) ?? {};
		if (Array.isArray(settings.packages)) {
			const remaining = settings.packages.filter((entry) => !isThisPackage(entry));
			if (remaining.length === 0 && !state.hadPackagesKey) delete settings.packages;
			else settings.packages = remaining;
			writeObject(paths.settings, settings);
			changes.push(`settings packages: - ${packageRoot}`);
		}
	}
	if (state.retiredLegacy && existsSync(state.retiredLegacy) && !existsSync(paths.legacy)) {
		renameSync(state.retiredLegacy, paths.legacy);
		changes.push(`restored ${paths.legacy}`);
	}
	if (state.createdConfig) changes.push(`kept ${paths.config} (delete it yourself if you no longer want it)`);
	rmSync(paths.state, { force: true });
	return changes;
}

function problems(): string[] {
	const found: string[] = [];
	const settings = readObject(paths.settings) ?? {};
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	if (!packages.some(loadsThisPackage)) found.push(`settings packages does not list ${packageRoot}`);
	if (existsSync(paths.legacy)) found.push(`${paths.legacy} still registers its own router`);
	const { errors, exists } = loadConfig(paths.config);
	if (!exists) found.push(`${paths.config} is missing (the built-in claude-auto profile is used)`);
	for (const error of errors) found.push(`config ${error}`);
	return found;
}

const mode = process.argv.includes("--uninstall") ? "uninstall" : process.argv.includes("--check") ? "check" : "apply";
try {
	console.log(`omo-auto-router ${mode} (agent dir: ${agentDir})`);
	if (mode !== "check") {
		const changes = mode === "apply" ? apply() : uninstall();
		for (const change of changes) console.log(`  ${change}`);
		if (changes.length === 0) console.log("  nothing to change");
	}
	if (mode !== "uninstall") {
		const found = problems();
		for (const problem of found) console.log(`  problem: ${problem}`);
		if (found.length > 0) process.exitCode = 1;
		else console.log("  ready; restart omo, then run /auto-router to see the resolved models");
	}
} catch (error) {
	console.error(`omo-auto-router ${mode} failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
