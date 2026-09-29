/**
 * kev-think — 让 Kev-4B 接管「思考强度」的最小扩展
 *
 * 两件事。第二件会真改思考强度，第一件只判不改（影子，见下）：
 *
 *  1) 影子判档：每轮开口前问 Kev-4B 一个三档问题（这活要不要深想），
 *     把分数/置信/判出的档写进日志和状态栏，但**不动你的档位**。
 *     - 为什么不动：2026-09-29 实测，每轮按判档结果 setThinkingLevel 会让
 *       档位在 low/medium/high 之间随机游走（近 8 会话 705 条消息里切了 53 次）。
 *       pi 把 cache_control 挂在 system prompt 上，改档位本身不打中它，但历史回复里
 *       assistant 的 thinking block 是按旧预算写的，下一轮换了预算就无法复用前缀缓存
 *       —— 每切一次就把之前的输入全价重算一遍。抖动是无收益的，cache 是实打实的钱。
 *     - 想真用它定档：把 KEV_THINK_APPLY=1 打开（默认关），行为回到 2026-09-29 之前。
 *     - 低置信 / 超时 / 无 key / 任何异常：只记日志，什么都不做。
 *
 *  2) 轮内失败升档（规则来自 jev-pilot 的 escalate，纯规则、不花钱）：
 *     - 同一轮里**连续真失败 N 次**才触发（默认 2，防抖）
 *     - 「真失败」= 工具结果报错；**超时和后端忙（429/502/503/529）不算**——
 *       那是它自己的问题，不该你付更深思考的钱（照抄 jev-pilot 的 missOf）
 *     - 升幅：**至少升一档**；已高于终档则不动；**永不降档**
 *     - 终档默认 high（你的兜底档）；KEV_THINK_CEILING 可改
 *
 * 成本：第 1 件每次约 100–160 tokens（Kev-4B 免费期至 2026-10-08，当前 ¥0）。
 *       第 2 件零 token。
 *
 * 环境变量开关（都要重启/新会话生效）：
 *   KEV_THINK=off            全关
 *   KEV_THINK_ESCALATE=off   只关失败升档
 *   KEV_THINK_AFTER=3        连续失败几次才升（默认 2）
 *   KEV_THINK_CEILING=high   升档终点（默认 high）
 *
 * 日志：~/.logs/kev-think/<日期>.jsonl — 每次定档/升档一行。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SF_BASE = "https://api.siliconflow.cn";
const SF_MODEL = "Kev-4B";
const TIMEOUT_MS = 3000;
const CONFIDENCE_FLOOR = 0.5; // 低于此不信它，且往上升一档
const MAX_CALLS_PER_SESSION = 200; // 防呆：单会话提问上限
const STATE_CHARS = 4000; // 只送 prompt 前 4000 字，够判档、省 token
/** key 文件：优先环境变量 SILICONFLOW_KEY，读不到再落到这个文件。
 *  用 $HOME 拼，别写死绝对路径 —— 写死的话别人装上必然静默失效。 */
const ENV_FILE = (process.env.HOME || "/root") + "/.secrets/siliconflow.env";

/** 可用的档位阶梯。
 *
 * 刻意**不含 `minimal`**：pi 自己的七档里有它，但上游渠道不认——
 * newapi/step-5-preview 实测返回 400：
 *   "reasoning_effort 只支持 low、medium、high、xhigh、max、none、no_think、
 *    disabled、disable、off、false、auto、provider"
 * 所以这里只用 pi 与上游的**交集**，而且**连 off 也去掉**（2026-09-28）：
 *   new-provider-1/stealth/space-bunny-alpha 返 400：
 *   "Reasoning is mandatory for this endpoint and cannot be disabled."
 *   （同类：MiniMax-M3.1-Flash-Preview，见下方 skip 名单）
 * pi 没有"该模型接受哪些等级"的字段，设之前无法预知。
 * 地板设在 low 就能避开整类问题：非推理模型被 pi 自动夹成 off；
 * 强制推理模型则接受 low 作为最低档。
 * ⚠ 不要把 minimal / off 加回来。 */
const LADDER = ["low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof LADDER)[number];

/** 等级中文名（仅用于显示；保留 minimal 以防别处上报它） */
const LEVEL_CN: Record<string, string> = {
	off: "关",
	minimal: "极低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "特高",
	max: "最高",
};
const cn = (level: string): string => LEVEL_CN[level] ?? level;

/** 「后端自己的问题」——不该为它升档（照抄 jev-pilot 的 missOf） */
const BUSY_CODES = [429, 502, 503, 529];

const SCORE_BANDS: { max: number; level: Level }[] = [
	{ max: 0.75, level: "low" },   // 机械活：最低档（不能发 off，见阶梯注释）
	{ max: 1.5, level: "medium" },
	{ max: 99, level: "high" },
];

/** kev 不接管的模型（per-model 绕过）。
 *
 * 某些模型强制 adaptive thinking，判到 off 就把请求打挂：
 *   minimax-cn/MiniMax-M3.1-Flash-Preview 实测 400
 *   "requires adaptive thinking; thinking.type=\"disabled\" ... is not allowed (2013)"
 * 已在配置层解决：models.json 给该模型 `thinkingLevelMap: {off: null}`（off 不可选）
 * + `compat.forceAdaptiveThinking: true`（一律发 adaptive + output_config.effort）。
 * ⚠ 两条都不能省：
 *   - 只加 forceAdaptiveThinking **无效**（实测）：档位选 off 时 pi 照样发 disabled，
 *     去掉 off:null 后 `--model '...:off'` 直接 400。
 *   - 只加 off:null 就够用（pi 把 off 夹走），forceAdaptive 只是让 payload 走原生形态。
 * 所以 kev 这边只需别去动这些模型的档位；覆盖：KEV_SKIP_MODELS="IdA,IdB"。 */
const DEFAULT_SKIP_MODELS = ["MiniMax-M3.1-Flash-Preview"];

function isSkipped(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const list = (process.env.KEV_SKIP_MODELS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return DEFAULT_SKIP_MODELS.includes(modelId) || list.includes(modelId);
}

/** 三档定义（与 effort-gate 的 jev 后端一致，便于两边对照） */
const QUESTION = {
	reasoning_needed: {
		type: "score",
		instructions:
			"这个任务需要多深的推理？按 0-2 判：0=照话执行、机械操作；" +
			"1=要读懂多个文件/日志/报错才能定位；2=要做设计取舍或跨系统根因分析。",
		criteria: [
			"Mechanical: follow an explicit instruction, no inference required.",
			"Requires understanding several files, a stack trace, or an unfamiliar API.",
			"Requires design decisions, tradeoffs, or root-cause analysis.",
		],
	},
};

function envFlag(name: string): boolean | null {
	const v = process.env[name];
	if (v === undefined || v === "") return null;
	return /^(1|true|on|yes)$/i.test(v);
}

function envInt(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envLevel(name: string, fallback: Level): Level {
	const v = process.env[name];
	return v && (LADDER as readonly string[]).includes(v) ? (v as Level) : fallback;
}

function levelForScore(score: number): Level {
	for (const band of SCORE_BANDS) {
		if (score <= band.max) return band.level;
	}
	return "high";
}

function rank(level: string | undefined): number {
	// off/minimal 不在阶梯里但真实存在：当成"比 low 还低一档"，
	// 从那里升档会到 low，不会跳到 medium。
	if (level === "off" || level === "minimal") return -1;
	const i = LADDER.indexOf(level as Level);
	return i < 0 ? LADDER.indexOf("medium") : i; // 读不到就当中间档（照抄 jev-pilot）
}

/** 失败升档：至少升一档，不降、不过顶 */
function escalate(current: string | undefined, ceiling: Level): Level | null {
	const from = rank(current);
	const to = Math.min(from + 1, LADDER.indexOf(ceiling));
	if (to <= from) return null;
	return LADDER[to];
}

/** jev-pilot 的 missOf：只有「真错误」值得为它升档。
 *  后端忙（429/502/503/529）与超时都不算——那是它自己的问题。
 *  判定：HTTP 状态码 ≥400 即失败（忙码除外）；无状态码时看有没有错误字样。 */
function statusCodes(blob: string): number[] {
	return blob.split(/[^0-9]+/).flatMap((s) => (s.length > 0 ? [Number(s)] : []));
}

function isRealFailure(event: { isError?: unknown; details?: unknown; content?: unknown }): boolean {
	if (event.isError === true) return true;
	try {
		// details 常是 {} （空对象也"有值"），所以 details 和 content 都要看，
		// 不能用一个 ?? 挑后者——那会漏掉只在 content 里报错的情况（实测踩过）。
		const parts: string[] = [];
		for (const v of [event.details, event.content]) {
			if (v === undefined || v === null) continue;
			parts.push(typeof v === "string" ? v : JSON.stringify(v));
		}
		const blob = parts.join(" ");
		const codes = statusCodes(blob);
		const http = codes.filter((c) => c >= 400 && c < 600);
		if (http.length > 0) return !http.every((c) => BUSY_CODES.includes(c));
		return /error|fail|exception|traceback|non-zero|not found|denied/i.test(blob);
	} catch {
		return false;
	}
}

function readKey(): string {
	const fromEnv = process.env.SILICONFLOW_KEY;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const text = fs.readFileSync(ENV_FILE, "utf8");
		const line = text.split("\n").find((l) => l.startsWith("SILICONFLOW_KEY="));
		return line ? line.slice("SILICONFLOW_KEY=".length).trim() : "";
	} catch {
		return "";
	}
}

function log(record: Record<string, unknown>): void {
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const dir = path.join(process.env.HOME || "/home/duanz", "logs", "kev-think");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(
			path.join(dir, new Date().toISOString().slice(0, 10) + ".jsonl"),
			JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
		);
	} catch {
		/* 日志失败绝不影响主流程 */
	}
}

/** 最近一次判档的摘要，供状态栏与 /kev status 用 */
interface LastVerdict {
	score: number;
	confidence: number;
	level: Level;
	bumped: boolean;
	from: string;
	source: "route" | "escalate";
	ts: string;
}
let last: LastVerdict | null = null;
let on = true; // /kev off 会把这里置 false（会话内生效，不写配置）

function statusText(): string {
	if (!on) return "kev:关";
	if (!last) return "kev:开";
	const tag = last.source === "escalate" ? "已抬" : "影";
	const bump = last.bumped ? "·低置信抬一档" : "";
	return `kev:${tag}(${cn(last.level)}) ${last.score.toFixed(2)}/${last.confidence.toFixed(2)}${bump}`;
}

function paint(ctx: unknown): void {
	try {
		const ui = (ctx as { ui?: { setStatus?: (k: string, v: string) => void } })?.ui;
		ui?.setStatus?.("kev-think", statusText());
	} catch {
		/* ctx 在会话重载后会 stale：静默跳过，下个事件再画 */
	}
}

export default function (pi: ExtensionAPI) {
	let calls = 0;
	let failures = 0; // 本轮连续真失败计数
	let escalations = 0; // 本轮已升档次数（留痕，不设上限：终档本身就是上限）

	const allOff = envFlag("KEV_THINK") === false;
	const escalateOn = envFlag("KEV_THINK_ESCALATE") !== false;
	const after = envInt("KEV_THINK_AFTER", 2);
	const ceiling = envLevel("KEV_THINK_CEILING", "high");

	// ── /kev on|off|status ──
	pi.registerCommand("kev", {
		description: "Kev 思考强度判档：on 交给 Kev｜off 自己控制｜status 看本次判档",
		handler: async (args, ctx) => {
			const sub = (args || "").trim().toLowerCase();
			if (sub === "off") {
				on = false;
				paint(ctx);
				ctx.ui.notify("kev:已关闭——思考强度回到你手动控制", "info");
				return;
			}
			if (sub === "on") {
				on = true;
				paint(ctx);
				ctx.ui.notify("kev:已开启——每轮由 Kev 判档", "info");
				return;
			}
			const cur = pi.getThinkingLevel();
			const lines = [
				`状态：${on ? "开（每轮由 Kev 判）" : "关（你手动控制）"}`,
				`当前档位：${cur}（${cn(cur)}）`,
				`判档生效：${envFlag("KEV_THINK_APPLY") === true ? "是（按判档结果改档位）" : "否（影子，只判不改）"}`,
				`本轮提问：${calls} 次（上限 ${MAX_CALLS_PER_SESSION}）`,
			];
			if (last) {
				lines.push(
					`最近判档：${last.source === "escalate" ? "失败升档" : "开口定档"}`,
					`  分数 ${last.score.toFixed(2)} · 置信 ${last.confidence.toFixed(2)}` +
					`${last.bumped ? " · 低置信已抬一档" : ""}`,
					`  从 ${cn(last.from)} → ${cn(last.level)}`,
					`  时间 ${last.ts.slice(11, 19)}`,
				);
			} else {
				lines.push("最近判档：本会话还没有");
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (ctx) => paint(ctx));

	// ── 每轮开口前：问 Kev 定档 ──
	pi.on("before_agent_start", async (event, ctx) => {
		failures = 0; // 新一轮，失败计数归零
		escalations = 0;
		if (allOff || !on) return;
		if (calls >= MAX_CALLS_PER_SESSION) return;
		const prompt = typeof event?.prompt === "string" ? event.prompt : "";
		if (!prompt.trim()) return;
		if (isSkipped((ctx as { model?: { id?: string } })?.model?.id)) {
			// 该模型强制 adaptive thinking，档位由配置层管（models.json），kev 不碰
			log({ skipped: "model forces adaptive" });
			return;
		}

		const key = readKey();
		if (!key) {
			log({ skipped: "no key" });
			return;
		}

		calls += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		let answers: Record<string, unknown> = {};
		try {
			const res = await fetch(SF_BASE + "/v1/systemone", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
				body: JSON.stringify({
					model: SF_MODEL,
					state: prompt.slice(0, STATE_CHARS),
					questions: QUESTION,
				}),
				signal: controller.signal,
			});
			if (!res.ok) {
				log({ error: `http ${res.status}` });
				return;
			}
			const data = (await res.json()) as { answers?: Record<string, unknown> };
			answers = data.answers ?? {};
		} catch (err) {
			log({ error: err instanceof Error ? err.name : "unknown" });
			return; // 超时/断网：保持当前档位，不动
		} finally {
			clearTimeout(timer);
		}

		const a = (answers.reasoning_needed ?? {}) as Record<string, unknown>;
		const score = typeof a.score === "number" ? (a.score as number) : null;
		const conf = typeof a.confidence === "number" ? (a.confidence as number) : null;
		if (score === null || conf === null) {
			log({ error: "bad answer" });
			return;
		}

		let level = levelForScore(score);
		const bumped = conf < CONFIDENCE_FLOOR;
		if (bumped) level = escalate(level, "max") ?? level; // 低置信：影子判出来的档也抬一档

		const before = pi.getThinkingLevel();
		// 影子模式：只判不设。KEV_THINK_APPLY=1 才回到「按判档结果改档位」。
		const apply = envFlag("KEV_THINK_APPLY") === true;
		if (apply) pi.setThinkingLevel(level);
		last = { score, confidence: conf, level, bumped, from: before, source: "route", ts: new Date().toISOString() };
		paint(ctx);
		log({
			kind: "route",
			applied: apply, // false = 只判没设（影子）。看这行就知道档位有没有被动过
			score: Math.round(score * 1000) / 1000,
			confidence: Math.round(conf * 1000) / 1000,
			level,
			bumped,
			from: before,
			promptLen: prompt.length,
			...(apply ? {} : { diff: before === level }), // 影子下记「判的和当前是否一致」
		});
	});

	// ── 轮内：连续真失败 → 升档（每轮最多一次，不反复抽动）──
	pi.on("tool_result", (event: { isError?: unknown; details?: unknown; content?: unknown; toolName?: string }, ctx: unknown) => {
		if (allOff || !escalateOn) return;
		if (!isRealFailure(event)) {
			failures = 0; // 一次成功就重新数（jev-pilot 的"连续"语义）
			return;
		}
		failures += 1;
		if (failures < after) return;

		const before = pi.getThinkingLevel();
		const next = escalate(before, ceiling);
		if (!next) {
			log({ kind: "escalate-skip", failures, from: before, reason: "已在终档或读不到档位" });
			return;
		}
		if (escalations >= 1) {
			// jev-pilot 的规矩：一轮内最多升一次。再失败也等下一轮重新判。
			log({ kind: "escalate-skip", failures, from: before, reason: "本轮已升过一次" });
			return;
		}
	pi.setThinkingLevel(next);
		escalations += 1;
		last = { score: 0, confidence: 0, level: next, bumped: false, from: before, source: "escalate", ts: new Date().toISOString() };
		paint(ctx);
		log({
			kind: "escalate",
			failures,
			from: before,
			to: next,
			escalationIndex: escalations,
			tool: (event as { toolName?: string }).toolName,
		});
	});
}
