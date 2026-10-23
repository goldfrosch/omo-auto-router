import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveAgentDir } from "./config.ts";

export const logPath = (agentDir = resolveAgentDir()) => join(agentDir, "logs", "auto-router.jsonl");

export interface LogEntry {
	ts: string;
	session?: string;
	profile?: string;
	reason?: string;
	source?: string;
	size?: string;
	to?: string;
	model?: string;
	ms?: number;
	error?: string;
}

export async function appendLog(entry: Record<string, unknown>, path = logPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

export async function readLog(days: number, path = logPath()): Promise<LogEntry[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	const since = Date.now() - days * 86_400_000;
	return text.split("\n").flatMap((line) => {
		if (!line.trim()) return [];
		try {
			const entry = JSON.parse(line) as LogEntry;
			return Date.parse(entry.ts) >= since ? [entry] : [];
		} catch {
			return [];
		}
	});
}

const count = (values: (string | undefined)[]) => {
	const totals = new Map<string, number>();
	for (const value of values) totals.set(value ?? "-", (totals.get(value ?? "-") ?? 0) + 1);
	return [...totals.entries()].sort((a, b) => b[1] - a[1]);
};

const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

export function summarize(entries: LogEntry[], days: number): string {
	if (entries.length === 0) return `auto-router: no routing decisions in the last ${days} day(s)`;
	const total = entries.length;
	const lines = [`auto-router: ${total} decisions in the last ${days} day(s)`];
	const section = (title: string, values: (string | undefined)[]) => {
		lines.push(`${title}:`);
		for (const [key, n] of count(values)) lines.push(`  ${key.padEnd(44)} ${String(n).padStart(4)}  ${percent(n, total)}`);
	};
	section("model", entries.map((entry) => entry.model ?? entry.to));
	section("decided by", entries.map((entry) => entry.source));
	section("classifier size", entries.filter((entry) => entry.size).map((entry) => entry.size));
	const failures = entries.filter((entry) => entry.error);
	const timed = entries.filter((entry) => entry.source === "classifier" || entry.source === "fallback");
	const avg = timed.length ? Math.round(timed.reduce((sum, entry) => sum + (entry.ms ?? 0), 0) / timed.length) : 0;
	lines.push(`classifier: ${timed.length} calls, avg ${avg} ms, ${failures.length} failed`);
	for (const [message, n] of count(failures.map((entry) => entry.error)).slice(0, 3)) lines.push(`  ${n}x ${message.slice(0, 90)}`);
	return lines.join("\n");
}
