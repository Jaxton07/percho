import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { summarize } from "../report-conversation-minimap.mjs";
import { validRawEvidence } from "./raw-evidence.mjs";

const escapeHtml = (value) =>
	String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
const canonical = (value) =>
	value && typeof value === "object"
		? Array.isArray(value)
			? value.map(canonical)
			: Object.fromEntries(
					Object.keys(value)
						.sort()
						.map((key) => [key, canonical(value[key])]),
				)
		: value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const envKeys = ["platform", "arch", "osRelease", "cpuModel", "machineHash", "node", "electron"];
const contractKeys = ["version", "mode", "fixtureHash", "parameters"];
const statuses = new Set(["running", "passed", "failed", "interrupted", "partial", "skipped", "pending"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const known = (value) => typeof value === "string" && value.trim().length > 0;
const viewportValid = (viewport) =>
	object(viewport) &&
	[viewport.width, viewport.height, viewport.dpr].every((value) => Number.isFinite(value) && value > 0);
function validateRun(run) {
	if (
		!object(run) ||
		run.schemaVersion !== 1 ||
		!["run", "legacy"].includes(run.kind) ||
		!statuses.has(run.status) ||
		typeof run.id !== "string" ||
		!/^[a-zA-Z0-9_-]+$/.test(run.id) ||
		typeof run.startedAt !== "string" ||
		!Number.isFinite(Date.parse(run.startedAt)) ||
		!object(run.suites)
	)
		throw new Error("Invalid run manifest");
	for (const [name, suite] of Object.entries(run.suites)) {
		if (
			!/^[a-zA-Z0-9_-]+$/.test(name) ||
			!object(suite) ||
			!statuses.has(suite.status) ||
			!Array.isArray(suite.metrics) ||
			!Array.isArray(suite.rawFiles) ||
			!suite.rawFiles.every((file) => typeof file === "string") ||
			(suite.contract != null && !object(suite.contract))
		)
			throw new Error("Invalid suite");
		const seen = new Set();
		for (const metric of suite.metrics) {
			if (
				!object(metric) ||
				typeof metric.name !== "string" ||
				!metric.name ||
				typeof metric.unit !== "string" ||
				!Number.isFinite(metric.value) ||
				typeof metric.lowerIsBetter !== "boolean" ||
				seen.has(metric.name)
			)
				throw new Error("Invalid metric");
			seen.add(metric.name);
		}
	}
}

async function safeRead(path) {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

export function renderReport(run) {
	const safe = (value) =>
		escapeHtml(value ?? "")
			.replaceAll("\n", " ")
			.replace(/[\\`*_[\]()!#]/g, "\\$&");
	const lines = [
		`# Performance run ${safe(run.id)}`,
		"",
		`- Label: ${safe(run.label)}`,
		`- Status: ${safe(run.status)}`,
		`- Kind: ${safe(run.kind)}`,
	];
	for (const [name, suite] of Object.entries(run.suites ?? {})) {
		lines.push("", `## ${safe(name)}`, `Status: ${safe(suite.status)}`);
		for (const metric of suite.metrics ?? [])
			if (Number.isFinite(metric.value))
				lines.push(`- ${safe(metric.name)}: ${metric.value} ${safe(metric.unit)}`);
	}
	return `${lines.join("\n")}\n`;
}

export class RunStore {
	constructor({ root }) {
		this.root = resolve(root);
	}

	async create(metadata) {
		await this.ensureRoot(this.root);
		const id = randomUUID();
		const directory = join(this.root, id);
		await mkdir(directory, { mode: 0o700 });
		for (const name of ["raw", "logs", "work"]) await mkdir(join(directory, name), { mode: 0o700 });
		const run = {
			...metadata,
			schemaVersion: 1,
			id,
			kind: "run",
			status: "running",
			startedAt: new Date().toISOString(),
			finishedAt: null,
			suites: metadata.suites ?? {},
			notes: metadata.notes ?? [],
			cleanup: metadata.cleanup ?? null,
		};
		await this.save(run);
		return run;
	}

	async read(id) {
		const run = JSON.parse(await safeRead(join(await this.runDir(id), "manifest.json")));
		validateRun(run);
		if (run.id !== id) throw new Error("Manifest id mismatch");
		return run;
	}

	async save(run) {
		validateRun(run);
		const dir = await this.runDir(run.id);
		await this.atomic(join(dir, "manifest.json"), `${JSON.stringify(run, null, 2)}\n`);
		await this.atomic(join(dir, "report.md"), renderReport(run));
	}

	async list({ onError = ({ id }) => console.warn(`Invalid performance run: ${id}`) } = {}) {
		let entries;
		try {
			entries = await readdir(this.root, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
		await this.checkRoot();
		const runs = [];
		for (const entry of entries)
			if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) {
				try {
					runs.push(await this.read(entry.name));
				} catch (error) {
					onError?.({ id: entry.name, error });
				}
			}
		return runs;
	}

	async eligibility(run, name, suite) {
		const reasons = [];
		if (run.kind !== "run") reasons.push("legacy metadata is unknown");
		if (run.status !== "passed") reasons.push("run not passed");
		if (
			typeof run.finishedAt !== "string" ||
			!Number.isFinite(Date.parse(run.finishedAt)) ||
			Date.parse(run.finishedAt) < Date.parse(run.startedAt)
		)
			reasons.push("finishedAt is invalid or unknown");
		if (!known(run.profile)) reasons.push("profile is unknown");
		for (const key of envKeys.filter((key) => key !== "electron"))
			if (!known(run.environment?.[key])) reasons.push(`environment.${key} is unknown`);
		if (!suite) return [...reasons, "suite missing"];
		if (suite.status !== "passed") reasons.push("suite not passed");
		if (
			!(
				(Number.isInteger(suite.contract?.version) && suite.contract.version > 0) ||
				known(suite.contract?.version)
			)
		)
			reasons.push("contract.version is invalid or unknown");
		for (const key of ["mode", "fixtureHash"])
			if (!known(suite.contract?.[key])) reasons.push(`contract.${key} is unknown`);
		if (!object(suite.contract?.parameters)) reasons.push("contract.parameters is invalid");
		if (suite.contract?.measurementVersion !== 2)
			reasons.push("contract.measurementVersion is invalid or unknown");
		if (
			!known(suite.contract?.measurementHash) ||
			suite.contract.measurementHash.trim().toLowerCase() === "unknown"
		)
			reasons.push("contract.measurementHash is unknown");
		const mode = suite.contract?.mode;
		if (mode !== "node" && mode !== "node-worker") {
			if (!known(run.environment?.electron)) reasons.push("environment.electron is unknown");
			const viewport = suite.contract?.viewport;
			const valid =
				name === "rendering"
					? viewportValid(viewport?.initial) &&
						object(viewport?.stages) &&
						Object.keys(viewport.stages).length > 0 &&
						Object.values(viewport.stages).every(viewportValid)
					: viewportValid(viewport);
			if (!valid) reasons.push("contract.viewport is invalid or unknown");
		}
		if (!suite.metrics.length && name !== "images") reasons.push("metrics missing");
		if (!suite.rawFiles.length) reasons.push("rawFiles missing");
		let completedReports = 0;
		for (const file of suite.rawFiles) {
			const parts = file.split("/");
			if (
				parts.length < 2 ||
				parts[0] !== "raw" ||
				parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))
			) {
				reasons.push(`invalid raw file: ${file}`);
				continue;
			}
			try {
				let path = await this.runDir(run.id);
				for (let i = 0; i < parts.length; i++) {
					path = join(path, parts[i]);
					const stat = await lstat(path);
					if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
						throw new Error("Invalid raw path");
				}
				const data = JSON.parse(await safeRead(path));
				// Checkpoints are auxiliary forensic data, not completed measurement evidence.
				if (!/checkpoint/i.test(parts.at(-1))) {
					if (!validRawEvidence(name, data)) throw new Error("Invalid raw evidence");
					completedReports++;
				}
			} catch {
				reasons.push(`invalid raw file: ${file}`);
			}
		}
		if (completedReports === 0) reasons.push("no completed raw report");
		return reasons;
	}

	async setBaseline(id) {
		const run = await this.read(id);
		const suites = Object.entries(run.suites);
		const eligibility = await Promise.all(suites.map(([name, suite]) => this.eligibility(run, name, suite)));
		if (!suites.some(([, suite]) => suite.metrics.length) || eligibility.some((reasons) => reasons.length))
			throw new Error(`Baseline requires a passed measured run: ${eligibility.flat().join(", ")}`);
		await this.atomic(join(this.root, "baseline.json"), `${JSON.stringify({ id }, null, 2)}\n`);
	}

	async getBaseline() {
		try {
			await this.checkRoot();
			const { id } = JSON.parse(await safeRead(join(this.root, "baseline.json")));
			await this.runDir(id);
			return id;
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}

	async compare(id, { baselineId, suiteNames } = {}) {
		const current = await this.read(id);
		baselineId ??= await this.getBaseline();
		if (!baselineId) throw new Error("No baseline specified");
		const baseline = await this.read(baselineId);
		const legacy = current.kind === "legacy" || baseline.kind === "legacy";
		const common = [];
		if (current.schemaVersion !== baseline.schemaVersion || current.schemaVersion !== 1)
			common.push("schemaVersion differs or is unknown");
		if (current.status !== "passed" || baseline.status !== "passed") common.push("run not passed");
		if (!current.profile || current.profile !== baseline.profile)
			common.push("profile differs or is unknown");
		for (const key of envKeys) {
			const a = current.environment?.[key],
				b = baseline.environment?.[key];
			if (key === "electron") continue;
			if (a == null || b == null || a !== b) common.push(`environment.${key} differs or is unknown`);
		}
		const available = [
			...new Set([...Object.keys(baseline.suites ?? {}), ...Object.keys(current.suites ?? {})]),
		];
		if (
			suiteNames &&
			(!suiteNames.length ||
				suiteNames.some((name) => !available.includes(name)) ||
				new Set(suiteNames).size !== suiteNames.length)
		)
			throw new Error("Unknown or duplicated comparison suite");
		const names = (suiteNames ?? available).slice().sort();
		const suites = await Promise.all(
			names.map(async (name) => {
				const before = baseline.suites?.[name],
					after = current.suites?.[name];
				const reasons = [
					...new Set([
						...common,
						...(await this.eligibility(baseline, name, before)),
						...(await this.eligibility(current, name, after)),
					]),
				];
				if (
					before &&
					after &&
					before.contract?.mode !== "node" &&
					before.contract?.mode !== "node-worker" &&
					current.environment?.electron !== baseline.environment?.electron
				)
					reasons.push("environment.electron differs");
				if (!before || !after) reasons.push("suite missing");
				else {
					if (before.status !== "passed" || after.status !== "passed") reasons.push("suite not passed");
					for (const key of contractKeys)
						if (
							before.contract?.[key] == null ||
							after.contract?.[key] == null ||
							!equal(before.contract[key], after.contract[key])
						)
							reasons.push(`contract.${key} differs or is unknown`);
					const optional = new Set([
						...Object.keys(before.contract ?? {}),
						...Object.keys(after.contract ?? {}),
					]);
					for (const key of optional)
						if (!contractKeys.includes(key) && !equal(before.contract?.[key], after.contract?.[key]))
							reasons.push(`contract.${key} differs`);
				}
				if (legacy) reasons.push("legacy metadata is unknown");
				let status = legacy ? "reference-only" : reasons.length ? "incompatible" : "comparable";
				const metrics = [];
				if (status === "comparable")
					for (const metric of after.metrics ?? []) {
						const previous = (before.metrics ?? []).find(
							(item) =>
								item.name === metric.name &&
								item.unit === metric.unit &&
								item.lowerIsBetter === metric.lowerIsBetter,
						);
						if (previous && Number.isFinite(previous.value) && Number.isFinite(metric.value)) {
							const delta = metric.value - previous.value;
							metrics.push({
								name: metric.name,
								unit: metric.unit,
								before: previous.value,
								after: metric.value,
								delta,
								percent: previous.value === 0 ? null : (delta / previous.value) * 100,
							});
						}
					}
				if (
					status === "comparable" &&
					(metrics.length !== (after.metrics ?? []).length ||
						metrics.length !== (before.metrics ?? []).length)
				) {
					reasons.push("metrics missing or incompatible");
					status = "incompatible";
					metrics.length = 0;
				}
				return { name, status, reasons, metrics };
			}),
		);
		const reasons = [...common];
		if (!names.length) reasons.push("no suites");
		if (legacy) reasons.push("legacy metadata is unknown");
		for (const suite of suites) {
			for (const reason of suite.reasons)
				if (!common.includes(reason) && reason !== "legacy metadata is unknown")
					reasons.push(`${suite.name}: ${reason}`);
		}
		return {
			status: legacy
				? "reference-only"
				: reasons.length || suites.some((suite) => suite.status !== "comparable")
					? "incompatible"
					: "comparable",
			currentId: id,
			baselineId,
			suites,
			reasons,
		};
	}

	async importLegacy({ file, suite, label }) {
		if (typeof suite !== "string" || !/^[a-zA-Z0-9_-]+$/.test(suite)) throw new Error("Invalid suite");
		const raw = await readFile(file, "utf8");
		const data = JSON.parse(raw);
		let summary = null;
		if (
			suite === "minimap" &&
			Array.isArray(data) &&
			data.length &&
			data.every(
				(item) =>
					object(item) &&
					typeof item.name === "string" &&
					["medianMs", "p95Ms", "frameP95Ms", "inputP95Ms"].some((key) => Number.isFinite(item[key])),
			)
		)
			summary = data;
		else if (
			suite === "minimap" &&
			object(data) &&
			typeof data.mode === "string" &&
			object(data.window) &&
			Array.isArray(data.samples) &&
			data.samples.length &&
			data.samples.every(
				(sample) =>
					object(sample) &&
					typeof sample.name === "string" &&
					Number.isFinite(sample.elapsedMs) &&
					Array.isArray(sample.frames) &&
					sample.frames.every(Number.isFinite) &&
					Array.isArray(sample.longTasks) &&
					Number.isFinite(sample.rows) &&
					Number.isFinite(sample.railMounted) &&
					(sample.inputs == null ||
						(Array.isArray(sample.inputs) &&
							sample.inputs.every(
								(input) =>
									object(input) && Number.isFinite(input.ms) && typeof input.duringStream === "boolean",
							))),
			)
		)
			summary = summarize([data]);
		else if (
			!(
				object(data) &&
				Array.isArray(data.metrics) &&
				data.metrics.length &&
				data.metrics.every(
					(m) =>
						object(m) &&
						typeof m.name === "string" &&
						typeof m.unit === "string" &&
						Number.isFinite(m.value) &&
						typeof m.lowerIsBetter === "boolean",
				)
			)
		)
			throw new Error("Unsupported legacy report");
		const metrics = Array.isArray(data.metrics)
			? data.metrics
					.filter(
						(m) =>
							typeof m.name === "string" &&
							typeof m.unit === "string" &&
							Number.isFinite(m.value) &&
							typeof m.lowerIsBetter === "boolean",
					)
					.map(({ name, unit, value, lowerIsBetter }) => ({ name, unit, value, lowerIsBetter }))
			: [];
		if (summary) {
			for (const item of summary) {
				if (typeof item.name !== "string") continue;
				for (const key of ["medianMs", "p95Ms", "frameP95Ms", "inputP95Ms"]) {
					if (Number.isFinite(item[key]))
						metrics.push({ name: `${item.name}:${key}`, unit: "ms", value: item[key], lowerIsBetter: true });
				}
			}
		}
		const run = await this.create({
			label,
			suites: {
				[suite]: {
					status: "partial",
					metrics,
					rawFiles: ["raw/imported.json"],
					notes: ["Legacy reference only"],
				},
			},
		});
		const rawDir = join(await this.runDir(run.id), "raw");
		if (!(await lstat(rawDir)).isDirectory() || (await realpath(rawDir)) !== rawDir)
			throw new Error("Invalid raw directory");
		await this.atomic(join(rawDir, "imported.json"), raw);
		run.kind = "legacy";
		run.status = "partial";
		await this.save(run);
		return run;
	}

	async writeHistory() {
		const errors = [];
		const runs = await this.list({ onError: ({ id }) => errors.push(id) });
		const rows = [];
		for (const run of runs)
			for (const [name, suite] of Object.entries(run.suites ?? {})) {
				const invalid = await this.eligibility(run, name, suite);
				const eligible = invalid.length === 0;
				if (!eligible && run.kind === "run") errors.push(`${run.id} (${name}): ${invalid.join(", ")}`);
				const key = eligible
					? JSON.stringify(
							canonical({
								profile: run.profile,
								environment: Object.fromEntries(
									envKeys
										.filter(
											(key) => key !== "electron" || !["node", "node-worker"].includes(suite.contract.mode),
										)
										.map((key) => [key, run.environment?.[key] ?? null]),
								),
								contract: suite.contract,
								suite: name,
								metrics: (suite.metrics ?? [])
									.map(({ name, unit, lowerIsBetter }) => ({ name, unit, lowerIsBetter }))
									.sort((a, b) => a.name.localeCompare(b.name)),
							}),
						)
					: null;
				for (const metric of suite.metrics ?? [])
					if (Number.isFinite(metric.value)) rows.push({ run, name, metric, key });
				if (!suite.metrics?.length) rows.push({ run, name, metric: null, key });
			}
		rows.sort(
			(a, b) =>
				(a.key ?? "").localeCompare(b.key ?? "") ||
				String(a.run.startedAt).localeCompare(String(b.run.startedAt)),
		);
		const groups = new Map();
		for (const row of rows) if (row.key && !groups.has(row.key)) groups.set(row.key, groups.size + 1);
		const fields = (row) => [
			row.key ? `Group ${groups.get(row.key)}` : "Reference only",
			row.run.id,
			row.run.label ?? "",
			row.run.status,
			row.name,
			row.metric?.name ?? "",
			row.metric?.value ?? "",
			row.metric?.unit ?? "",
		];
		const header = ["Group", "ID", "Label", "Status", "Suite", "Metric", "Value", "Unit"];
		const markdown = (s) =>
			escapeHtml(s)
				.replaceAll("|", "\\|")
				.replaceAll("\n", " ")
				.replace(/[\\`*_[\]()!#]/g, "\\$&");
		const errorText = errors.map((id) => `- Invalid run: ${markdown(id)}`).join("\n");
		const md = `# Performance history\n\n${errorText}\n\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |\n${rows.map((row) => `| ${fields(row).map(markdown).join(" | ")} |`).join("\n")}\n`;
		const series = new Map();
		for (const row of rows) {
			if (!row.key || !row.metric) continue;
			const key = JSON.stringify([row.key, row.metric.name, row.metric.unit, row.metric.lowerIsBetter]);
			if (!series.has(key)) series.set(key, []);
			series.get(key).push(row);
		}
		const charts = [...series.values()]
			.map((items) => {
				items.sort((a, b) => Date.parse(a.run.startedAt) - Date.parse(b.run.startedAt));
				const times = items.map((row) => Date.parse(row.run.startedAt));
				const values = items.map((row) => row.metric.value);
				const minX = Math.min(...times),
					maxX = Math.max(...times);
				const minY = Math.min(...values),
					maxY = Math.max(...values);
				const points = items.map((row, i) => ({
					row,
					x: maxX === minX ? 300 : 30 + (540 * (times[i] - minX)) / (maxX - minX),
					y: maxY === minY ? 100 : 180 - (160 * (values[i] - minY)) / (maxY - minY),
				}));
				const circles = points
					.map(({ row, x, y }) => {
						const commit = /^[a-fA-F0-9]{7,64}$/.test(row.run.source?.commit ?? "")
							? row.run.source.commit.slice(0, 8)
							: "";
						const label = `${row.run.id}${commit ? ` ${commit}` : ""} ${row.run.startedAt}: ${row.metric.value} ${row.metric.unit}`;
						return `<circle cx="${x}" cy="${y}" r="4"><title>${escapeHtml(label)}</title></circle><text x="${x}" y="${Math.max(12, y - 7)}" font-size="9">${escapeHtml(`${row.run.id}${commit ? ` ${commit}` : ""}`)}</text>`;
					})
					.join("");
				return `<section><h2>${escapeHtml(items[0].name)} — ${escapeHtml(items[0].metric.name)} (${escapeHtml(items[0].metric.unit)}) — group ${groups.get(items[0].key)}</h2><svg viewBox="0 0 600 200" width="600" role="img" aria-label="${escapeHtml(items[0].metric.name)} trend"><polyline fill="none" stroke="currentColor" points="${points.map(({ x, y }) => `${x},${y}`).join(" ")}"/>${circles}</svg></section>`;
			})
			.join("");
		const html = `<!doctype html><html><head><meta charset="utf-8"><title>Performance history</title></head><body><h1>Performance history</h1>${errors.map((id) => `<p>Invalid run: ${escapeHtml(id)}</p>`).join("")}${charts}<table><thead><tr>${header.map((item) => `<th>${item}</th>`).join("")}</tr></thead><tbody>${rows
			.map(
				(row) =>
					`<tr>${fields(row)
						.map((item) => `<td>${escapeHtml(item)}</td>`)
						.join("")}</tr>`,
			)
			.join("")}</tbody></table></body></html>\n`;
		await this.checkRoot();
		await this.atomic(join(this.root, "history.md"), md);
		await this.atomic(join(this.root, "history.html"), html);
	}

	async ensureRoot(path) {
		try {
			if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
				throw new Error("Symlink root is not allowed");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await this.ensureRoot(dirname(path));
			try {
				await mkdir(path, { mode: 0o700 });
			} catch (mkdirError) {
				if (mkdirError.code !== "EEXIST") throw mkdirError;
			}
			if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
				throw new Error("Symlink root is not allowed");
		}
	}

	async checkRoot() {
		if ((await realpath(this.root)) !== this.root) throw new Error("Symlink root is not allowed");
	}

	async runDir(id) {
		if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid run id");
		await this.checkRoot();
		const dir = join(this.root, id);
		if (!(await lstat(dir)).isDirectory() || (await realpath(dir)) !== dir)
			throw new Error("Invalid run directory");
		return dir;
	}

	async atomic(path, content) {
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, content, { mode: 0o600, flag: "wx" });
			await rename(temp, path);
		} finally {
			await unlink(temp).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}
}
