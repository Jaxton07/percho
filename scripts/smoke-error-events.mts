// 阶段 0 冒烟：真实 SDK 驱动 PiBackend，验证「LLM 错误事件序列」四断言（spec §9 待验证项）。
// 用本地 HTTP 服务器伪造 provider 端点（401 / 429 两种响应）——确定性、离线、零凭证。
//
//   V1a  恒 401           → turn_end.message.stopReason === "error" 且 errorMessage 非空含 401 信息
//   V1b  恒 429           → 同上（stopReason error 到达）
//   V2   恒 429（触发重试）→ auto_retry_start（attempt/maxAttempts/delayMs/errorMessage 四字段齐）
//                           先于最终 turn_end error 到达；auto_retry_end {success:false} 存在
//   V3   V1a 跑完后读 jsonl → assistant 条目含持久化 stopReason:"error" + errorMessage（回放产卡数据源）
//
// 临时 agent 目录（mktemp），跑完删除；末尾 process.exit(0)（LLM 连接池句柄不归 dispose）。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Mode = "401" | "429";

const results: Record<string, { ok: boolean; detail: string }> = {};

function check(name: string, ok: boolean, detail: string): void {
	results[name] = { ok, detail };
	console.log(`${ok ? "  ✓" : "  ✗"} ${name} — ${detail}`);
}

function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (cond()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`timeout waiting for ${label}`));
			}
		}, 50);
	});
}

async function main(): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "percho-smoke-errors-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_LOG_LEVEL = "warn";
	console.log(`[setup] temp agent dir: ${agentDir}`);
	const workDir = join(agentDir, "work");

	// ---- 本地伪造 provider 端点 ----
	let mode: Mode = "401";
	let requestCount = 0;
	const server: Server = createServer((req, res) => {
		req.resume();
		requestCount++;
		if (mode === "401") {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Invalid API key provided", type: "invalid_request_error" } }));
			return;
		}
		res.writeHead(429, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Rate limit reached: too many requests", type: "rate_limit_error" } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	console.log(`[setup] mock provider listening: http://127.0.0.1:${port}/v1`);

	// ---- models.json / auth.json / settings.json（快速重试预算）----
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					errmock: {
						name: "errmock",
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						models: [{ id: "m1" }],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ errmock: { type: "api_key", key: "sk-fake" } }));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 150 } }),
	);

	// ---- 驱动 PiBackend（env 先行；动态 import 保模块求值顺序）----
	const { PiBackend } = await import("../packages/backend/src/index.ts");
	const backend = new PiBackend({
		defaultCwd: workDir,
		projectTrust: false,
		permissionGates: false,
		permissionExtension: false,
	});
	await backend.init();

	type Recorded = { seq: number; event: unknown & { type: string } };
	const events: Recorded[] = [];
	backend.onEvent((sessionId, event) => events.push({ seq: events.length, event }));

	const listSessionFiles = (): string[] =>
		readdirSync(join(agentDir, "sessions"))
			.flatMap((dir) => {
				const p = join(agentDir, "sessions", dir);
				try {
					return readdirSync(p)
						.filter((f) => f.endsWith(".jsonl"))
						.map((f) => join(p, f));
				} catch {
					return [];
				}
			})
			.filter((f) => !f.includes("traces"));

	async function runScenario(scenario: string, m: Mode): Promise<Recorded[]> {
		mode = m;
		events.length = 0;
		const meta = await backend.createSession({ cwd: workDir, provider: "errmock", modelId: "m1" });
		console.log(`\n[${scenario}] session ${meta.sessionId}`);
		await backend.prompt(meta.sessionId, "回复一个词：你好");
		await waitFor(
			() => events.some((e) => e.event.type === "agent_settled"),
			45_000,
			`${scenario} agent_settled`,
		);
		await backend.closeSession(meta.sessionId);
		console.log(`  event types: ${[...new Set(events.map((e) => e.event.type))].join(" → ")}`);
		return events;
	}

	const findTurnEnd = (es: Recorded[]) => es.filter((e) => e.event.type === "turn_end");
	const lastErrorTurnEnd = (es: Recorded[]) => {
		const ends = findTurnEnd(es);
		for (let i = ends.length - 1; i >= 0; i--) {
			const msg = (ends[i].event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
			if (msg?.role === "assistant" && msg.stopReason === "error") return ends[i];
		}
		return undefined;
	};

	// ================= V1a：401（非可重试，快速失败） =================
	console.log("\n=== V1a: 401 ===");
	const ev401 = await runScenario("V1a", "401");
	{
		const end = lastErrorTurnEnd(ev401);
		const msg = (end?.event as { message?: { stopReason?: string; errorMessage?: string } })?.message;
		check(
			"V1a turn_end.stopReason==error",
			end !== undefined,
			end ? `seq=${end.seq} stopReason=${msg?.stopReason}` : "no error turn_end",
		);
		check(
			"V1a errorMessage 非空含 401 信息",
			typeof msg?.errorMessage === "string" && msg.errorMessage.length > 0 && /401|unauthorized|invalid ?api ?key/i.test(msg.errorMessage),
			`errorMessage=${JSON.stringify(msg?.errorMessage)?.slice(0, 220)}`,
		);
		check(
			"V1a agent_settled 收尾",
			ev401.some((e) => e.event.type === "agent_settled"),
			`settled seq=${ev401.find((e) => e.event.type === "agent_settled")?.seq}`,
		);
		check(
			"V1a 无 auto_retry（401 不可重试）",
			!ev401.some((e) => e.event.type === "auto_retry_start"),
			`auto_retry_start count=${ev401.filter((e) => e.event.type === "auto_retry_start").length}`,
		);
	}

	// ================= V3：jsonl 已持久化 stopReason/errorMessage =================
	console.log("\n=== V3: jsonl 持久化（基于 V1a 会话文件） ===");
	{
		const files = listSessionFiles();
		check("V3 会话 jsonl 存在", files.length > 0, files.join(", "));
		let found: { stopReason?: string; errorMessage?: string } | undefined;
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as { type?: string; message?: { role?: string; stopReason?: string; errorMessage?: string } };
					if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason === "error") {
						found = entry.message;
					}
				} catch {
					// 忽略不可解析行（trace 目录已排除）
				}
			}
		}
		check(
			"V3 assistant 条目含 stopReason:error + errorMessage",
			found !== undefined && typeof found.errorMessage === "string" && found.errorMessage.length > 0,
			found ? `stopReason=${found.stopReason} errorMessage=${JSON.stringify(found.errorMessage).slice(0, 160)}` : "not found",
		);
	}

	// ================= V1b + V2：429（可重试） =================
	console.log("\n=== V1b + V2: 429（含自动重试） ===");
	const ev429 = await runScenario("V1b/V2", "429");
	{
		const end = lastErrorTurnEnd(ev429);
		const msg = (end?.event as { message?: { stopReason?: string; errorMessage?: string } })?.message;
		check(
			"V1b turn_end.stopReason==error",
			end !== undefined,
			end ? `seq=${end.seq} stopReason=${msg?.stopReason}` : "no error turn_end",
		);
		check(
			"V1b errorMessage 非空含 429 信息",
			typeof msg?.errorMessage === "string" && msg.errorMessage.length > 0 && /429|rate ?limit/i.test(msg.errorMessage),
			`errorMessage=${JSON.stringify(msg?.errorMessage)?.slice(0, 220)}`,
		);
		const retries = ev429.filter((e) => e.event.type === "auto_retry_start");
		check(
			"V2 auto_retry_start 先于最终 turn_end error 到达",
			retries.length > 0 && end !== undefined && retries[0].seq < end.seq,
			retries[0] && end ? `first retry seq=${retries[0].seq} < final turn_end seq=${end.seq}` : `retries=${retries.length} end=${end?.seq}`,
		);
		if (retries[0]) {
			const r = retries[0].event as { attempt?: unknown; maxAttempts?: unknown; delayMs?: unknown; errorMessage?: unknown };
			check(
				"V2 auto_retry_start 四字段齐（attempt/maxAttempts/delayMs/errorMessage）",
				typeof r.attempt === "number" &&
					typeof r.maxAttempts === "number" &&
					typeof r.delayMs === "number" &&
					typeof r.errorMessage === "string" &&
					r.errorMessage.length > 0,
				JSON.stringify(r).slice(0, 240),
			);
		}
		const endEvent = ev429.find((e) => e.event.type === "auto_retry_end");
		check(
			"V2 auto_retry_end {success:false} 存在（重试耗尽）",
			endEvent !== undefined && (endEvent.event as { success?: boolean }).success === false,
			endEvent ? JSON.stringify(endEvent.event).slice(0, 200) : "not found",
		);
	}

	backend.dispose();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await import("node:fs/promises").then(({ rm }) => rm(agentDir, { recursive: true, force: true }));
	console.log(`\n[cleanup] temp dir removed（请求数 ${requestCount}）`);

	const failed = Object.entries(results).filter(([, r]) => !r.ok);
	console.log("\n===== 冒烟结果 =====");
	for (const [name, r] of Object.entries(results)) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${name}`);
	console.log(failed.length === 0 ? "\nALL PASS" : `\n${failed.length} FAILED`);

	// 冒烟是短生命周期 CLI：LLM 连接池（undici keep-alive）等进程级共享句柄不随 dispose 释放
	// （桌面端主进程常驻，同一连接池本就一直持有，非每 run 泄漏）；脚本到此显式退出。
	process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((err) => {
	console.error("[smoke-error-events] fatal:", err);
	process.exit(1);
});
