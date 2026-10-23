/**
 * Type-checks against the senpi engine installed on this machine. senpi aliases its imports to the
 * host at runtime, so the package ships no dependency; this script finds the engine, writes
 * tsconfig.gen.json with paths into it, and runs tsc.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findSenpi(): string | undefined {
	const candidates: string[] = [];
	const bin = process.env.SENPI_BIN;
	if (bin) candidates.push(join(dirname(dirname(bin)), "@code-yeongyu", "senpi"));
	try {
		candidates.push(dirname(createRequire(join(homedir(), "noop.js")).resolve("@code-yeongyu/senpi/package.json")));
	} catch {}
	candidates.push(join(homedir(), "node_modules", "@code-yeongyu", "senpi"));
	candidates.push(join(homedir(), ".bun", "install", "global", "node_modules", "@code-yeongyu", "senpi"));
	return candidates.find((dir) => existsSync(join(dir, "dist", "index.d.ts")));
}

const senpi = findSenpi();
if (!senpi) {
	console.error("typecheck: cannot find @code-yeongyu/senpi; set SENPI_BIN or install omo");
	process.exit(1);
}
/** npm and bun may nest the engine's dependencies or hoist them next to it. */
const hoisted = dirname(dirname(senpi));
const dependency = (name: string, file: string) =>
	[join(senpi, "node_modules", name), join(hoisted, name)].map((dir) => join(dir, file)).find((path) => existsSync(path));
const typeRoots = [join(senpi, "node_modules", "@types"), join(hoisted, "@types")].filter((dir) => existsSync(join(dir, "node")));
const piAi = dependency("@earendil-works/pi-ai", join("dist", "index.d.ts"));
if (!piAi || typeRoots.length === 0) {
	console.error(`typecheck: ${!piAi ? "@earendil-works/pi-ai" : "@types/node"} not found next to ${senpi}`);
	process.exit(1);
}
const config = {
	extends: "./tsconfig.json",
	compilerOptions: {
		typeRoots,
		paths: {
			"@code-yeongyu/senpi": [join(senpi, "dist", "index.d.ts")],
			"@earendil-works/pi-ai": [piAi],
		},
	},
};
writeFileSync(join(root, "tsconfig.gen.json"), `${JSON.stringify(config, null, 2)}\n`);
const result = spawnSync("bunx", ["--bun", "tsc", "-p", "tsconfig.gen.json"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
