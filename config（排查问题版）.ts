// /opt/open-xiaoai-migpt/config.ts
// ✅ 修复：统一在 startSpeak() 内加前缀，避免任何分支漏掉
// ✅ 保留：打断/切换模型/诊断/输出/debug/openai fallback 等功能

type OpenAICompatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

// OpenAI Responses API
type OpenAIResponsesError = { message?: string; code?: string };
type OpenAIResponsesResponse = {
  model?: string;
  output_text?: string;
  output?: Array<any>;
  error?: OpenAIResponsesError | null;
};

type Provider = "deepseek" | "openai" | "gemini";

// ====== 可调参数 ======
const LLM_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 6000;
const SPEAK_CHUNK_LEN = 45;
const HARD_ABORT_RECOVERY_MS = 1400;

// ===== Debug 开关 =====
const debugState = (globalThis as any).__open_xiaoai_debug_state || { enabled: true };
(globalThis as any).__open_xiaoai_debug_state = debugState;

function dbg(...args: any[]) {
  if (!debugState.enabled) return;
  try {
    console.log("[migpt]", ...args);
  } catch {}
}

// ===== 状态 =====
const prefixState =
  (globalThis as any).__open_xiaoai_prefix_state ||
  { enabled: false, prefix: "主人：" };
(globalThis as any).__open_xiaoai_prefix_state = prefixState;

const modeState =
  (globalThis as any).__open_xiaoai_mode_state ||
  { mode: "ai" as "ai" | "native" };
(globalThis as any).__open_xiaoai_mode_state = modeState;

const llmState =
  (globalThis as any).__open_xiaoai_llm_state ||
  { provider: "deepseek" as Provider, modelOverride: "" as string };
(globalThis as any).__open_xiaoai_llm_state = llmState;

const diag =
  (globalThis as any).__open_xiaoai_diag_state ||
  {
    announceModel: false,
    last: null as null | { provider: Provider; model: string; ok: boolean; ms: number; at: number; err?: string },
  };
(globalThis as any).__open_xiaoai_diag_state = diag;

const state =
  (globalThis as any).__open_xiaoai_bargein_state ||
  { seq: 0, controller: null as AbortController | null };
(globalThis as any).__open_xiaoai_bargein_state = state;

const speakState =
  (globalThis as any).__open_xiaoai_speak_state ||
  { controller: null as AbortController | null, speakingSeq: 0 };
(globalThis as any).__open_xiaoai_speak_state = speakState;

const nativeSilenceState =
  (globalThis as any).__open_xiaoai_native_silence_state ||
  { lastHardAbortAt: 0, lastTryAt: 0 };
(globalThis as any).__open_xiaoai_native_silence_state = nativeSilenceState;

const ctx = (globalThis as any).__xiaoai_ctx || { lastMain: "", lastAt: 0 };
(globalThis as any).__xiaoai_ctx = ctx;

// ===== Keys / 模型 =====
const KEYS = {
  DEEPSEEK: process.env.DEEPSEEK_API_KEY || "",
  OPENAI: process.env.OPENAI_API_KEY || "",
  GEMINI: process.env.GEMINI_API_KEY || "",
};

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const DEFAULT_MODELS: Record<Provider, { model: string; baseURL?: string; fallbacks?: string[] }> = {
  deepseek: { model: "deepseek-chat", baseURL: "https://api.deepseek.com/v1" },
  openai: { model: "gpt-4o-mini", baseURL: OPENAI_BASE_URL, fallbacks: ["gpt-5-nano", "gpt-4o-mini"] },
  gemini: { model: "gemini-3.1-flash-lite-preview", fallbacks: ["gemini-2.0-flash"] },
};

// ===== Utils =====
function nowMs() {
  return Date.now();
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function compactText(s: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function normalizePrefix(p: string) {
  let x = (p || "").trim();
  if (!x) x = "主人";
  // 如果没结尾标点，自动补一个中文冒号
  if (!/[：:，,。.!?？\s]$/.test(x)) x += "：";
  // 冒号后不加空格，避免 TTS 读得怪；你想要空格可以改成 "： "
  return x;
}

/** ✅ 全局兜底：所有播报都走这里加前缀，避免任何分支漏掉 */
function applyPrefixToText(text: string) {
  const s = (text || "").trim();
  if (!s) return "";
  if (!prefixState.enabled) return s;

  const raw = (prefixState.prefix || "").trim();
  const p = normalizePrefix(raw);

  // 如果已经带前缀（允许 raw 或规范化后的 p），就不重复加
  if (raw && s.startsWith(raw)) return s;
  if (s.startsWith(p)) return s;

  return p + s;
}

function splitForSpeaker(text: string, maxLen = SPEAK_CHUNK_LEN) {
  const clean = compactText(text);
  const parts = clean
    .split(/(?<=[。！？；…\n])/)
    .map((x) => x.trim())
    .filter(Boolean);

  const out: string[] = [];
  const src = parts.length ? parts : [clean];
  for (const p of src) {
    if (p.length <= maxLen) out.push(p);
    else for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen));
  }
  return out;
}

function normCmd(raw: string) {
  return (raw || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，。！？；：、,.!?;:~`"'“”‘’（）()【】[\]{}<>《》]/g, "")
    .toLowerCase();
}

function looksLikeQuestion(t: string) {
  return (
    /[？?]$/.test(t) ||
    /^(请问|为什么|怎么|如何|多少|什么|哪|能不能|可不可以)/.test(t) ||
    /(吗|呢)$/.test(t) ||
    /(多少|什么|怎么|为什么|区别)/.test(t)
  );
}
function isAddonText(t: string) {
  if (/^主题为/.test(t) || /^改成/.test(t) || /^换成/.test(t) || /^再/.test(t) || /^风格/.test(t)) return true;
  if (/^\d{1,3}\s*(秒|分钟)$/.test(t)) return true;
  if (t.length <= 4) return true;
  return false;
}
function mergeAddon(text: string) {
  const t = (text || "").trim();
  const now = Date.now();
  const withinWindow = now - (ctx.lastAt || 0) < 8000;
  const addon = withinWindow && ctx.lastMain && isAddonText(t) && !looksLikeQuestion(t);
  if (addon) return `${ctx.lastMain}（补充要求：${t}）`;
  ctx.lastMain = t;
  ctx.lastAt = now;
  return t;
}

function currentProviderModel() {
  const provider = llmState.provider;
  const model = llmState.modelOverride || DEFAULT_MODELS[provider].model;
  return { provider, model };
}
function hasKeyFor(p: Provider) {
  if (p === "openai") return !!KEYS.OPENAI;
  if (p === "gemini") return !!KEYS.GEMINI;
  return !!KEYS.DEEPSEEK;
}

// ===== Speak / Interrupt =====
function waitAbort(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function stopPlaying(engine: any) {
  const speaker = engine?.speaker;
  try {
    await speaker?.setPlaying?.(false);
  } catch {}
  try {
    await speaker?.stop?.();
  } catch {}
  try {
    await speaker?.abort?.();
  } catch {}
}

async function cancelSpeaking(engine: any) {
  try {
    speakState.controller?.abort();
  } catch {}
  await stopPlaying(engine);
}

async function waitIfHardAborted(signal: AbortSignal) {
  const t = nativeSilenceState.lastHardAbortAt || 0;
  if (!t) return;
  const gap = nowMs() - t;
  const left = HARD_ABORT_RECOVERY_MS - gap;
  if (left > 0) await Promise.race([sleep(left), waitAbort(signal)]).catch(() => {});
}

/** ✅ startSpeak 内统一加前缀，彻底修复“有时不加前缀”的问题 */
function startSpeak(engine: any, seq: number, text: string) {
  const finalText = applyPrefixToText(text);
  dbg("SPEAK <=", { seq, text: finalText });

  try {
    speakState.controller?.abort();
  } catch {}
  speakState.controller = new AbortController();
  speakState.speakingSeq = seq;
  const signal = speakState.controller.signal;

  const chunks = splitForSpeaker(finalText, SPEAK_CHUNK_LEN);

  (async () => {
    const speaker = engine?.speaker;
    if (!speaker?.play) return;

    await waitIfHardAborted(signal);

    for (const c of chunks) {
      if (signal.aborted) return;
      if (speakState.speakingSeq !== seq) return;

      const playP = Promise.resolve(speaker.play({ text: c, blocking: true })).catch((e: any) => {
        dbg("SPEAK play error", String(e?.message || e));
      });

      await Promise.race([playP, waitAbort(signal)]).catch(async () => {
        try {
          await speaker.setPlaying?.(false);
        } catch {}
        try {
          await speaker.stop?.();
        } catch {}
      });
    }
  })().catch((e: any) => dbg("SPEAK task error", String(e?.message || e)));
}

async function askNativeXiaoAI(engine: any, text: string) {
  const fn = engine?.speaker?.askXiaoAI || engine?.speaker?.askXiaoAi || engine?.speaker?.ask_xiaoai;
  if (typeof fn === "function") {
    try {
      await fn.call(engine.speaker, text, { silent: false });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 尽量让原生小爱闭嘴（减少“抱歉不支持…”叠音） */
async function silenceNativeXiaoAI(engine: any): Promise<boolean> {
  const sp = engine?.speaker;
  const now = nowMs();
  if (now - (nativeSilenceState.lastTryAt || 0) < 250) return false;
  nativeSilenceState.lastTryAt = now;

  const softFns = [
    sp?.abortXiaoAITTS, sp?.abortXiaoAiTTS, sp?.abort_xiaoai_tts,
    sp?.stopXiaoAITTS, sp?.stopXiaoAiTTS, sp?.stop_xiaoai_tts,
    sp?.stopXiaoAI, sp?.stopXiaoAi, sp?.stop_xiaoai,
  ].filter((x) => typeof x === "function") as Function[];

  for (const fn of softFns) {
    try {
      await fn.call(sp);
      return false;
    } catch {}
  }

  const hardFns = [sp?.abortXiaoAI, sp?.abortXiaoAi, sp?.abort_xiaoai].filter((x) => typeof x === "function") as Function[];
  for (const fn of hardFns) {
    try {
      await fn.call(sp);
      nativeSilenceState.lastHardAbortAt = nowMs();
      dbg("native hard-abort triggered");
      return true;
    } catch {}
  }

  return false;
}

// ===== HTTP =====
async function httpPostJson(url: string, headers: Record<string, string>, body: any, signal?: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

// ===== Gemini =====
async function chatGemini(opts: { apiKey: string; model: string; system: string; user: string; signal?: AbortSignal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const { ok, status, json } = await httpPostJson(
    url,
    { "Content-Type": "application/json" },
    {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: opts.user }] }],
      generationConfig: { temperature: 0.7 },
    },
    opts.signal
  );
  const data = json as GeminiResponse;
  if (!ok) throw new Error(`HTTP_${status}:${data?.error?.message || "unknown"}`);
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ===== DeepSeek compat =====
async function chatOpenAICompat(opts: { baseURL: string; apiKey: string; model: string; system: string; user: string; signal?: AbortSignal }) {
  const base = opts.baseURL.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const { ok, status, json } = await httpPostJson(
    url,
    { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    {
      model: opts.model,
      stream: false,
      temperature: 0.7,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    },
    opts.signal
  );
  const data = json as OpenAICompatResponse;
  if (!ok) throw new Error(`HTTP_${status}:${data?.error?.message || "unknown"}`);
  return data?.choices?.[0]?.message?.content || "";
}

// ===== OpenAI Responses =====
function extractResponsesText(resp: OpenAIResponsesResponse): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text.trim();
  const out = resp?.output || [];
  for (const item of out) {
    if (item?.type === "message") {
      const content = item?.content || [];
      const parts: string[] = [];
      for (const c of content) if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
      const joined = parts.join("").trim();
      if (joined) return joined;
    }
  }
  return "";
}

async function openaiResponses(opts: { baseURL: string; apiKey: string; model: string; system: string; user: string; signal?: AbortSignal }) {
  const base = opts.baseURL.replace(/\/+$/, "");
  const url = `${base}/responses`;

  dbg("OPENAI_KEY_RUNTIME", {
    len: (opts.apiKey || "").length,
    first: (opts.apiKey || "").slice(0, 1),
    hasNonAscii: /[^\x00-\x7F]/.test(opts.apiKey || ""),
    model: opts.model,
    baseURL: base,
  });

  // 不发送 reasoning.effort（兼容更多模型）
  const body = {
    model: opts.model,
    input: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: 0.7,
  };

  const { ok, status, json } = await httpPostJson(
    url,
    { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body,
    opts.signal
  );

  const data = json as OpenAIResponsesResponse;
  if (!ok) {
    const msg = data?.error?.message || `HTTP_${status}`;
    throw new Error(`HTTP_${status}:${msg}`);
  }

  return extractResponsesText(data) || "";
}

function buildSystem(provider: Provider, model: string) {
  return compactText(`
你是运行在小爱音箱上的语音助手，由大模型驱动。
口播规则：口语化、简短；不要markdown；不要念URL；解释类优先两句话内。
当前外部大模型：${provider}/${model}。
如果用户问“你现在用的是哪个模型/你接入了什么模型”，请直接回答：${provider}/${model}。
`);
}

function isModelErr(msg: string) {
  const m = (msg || "").toLowerCase();
  return (
    m.includes("http_404") ||
    (m.includes("model") && (m.includes("not found") || m.includes("does not exist") || m.includes("unsupported") || m.includes("不存在")))
  );
}

async function callOpenAIWithFallback(opts: { model: string; system: string; user: string; signal: AbortSignal }) {
  const models = [opts.model, ...(DEFAULT_MODELS.openai.fallbacks || [])].filter(Boolean);
  let lastErr: any = null;

  for (const m of models) {
    try {
      const text = await openaiResponses({
        baseURL: DEFAULT_MODELS.openai.baseURL!,
        apiKey: KEYS.OPENAI,
        model: m,
        system: opts.system,
        user: opts.user,
        signal: opts.signal,
      });
      return { text, usedModel: m };
    } catch (e: any) {
      const msg = String(e?.message || "");
      dbg("OPENAI try fail", { model: m, err: msg.slice(0, 180) });
      lastErr = e;
      if (!isModelErr(msg)) throw e;
    }
  }

  throw lastErr || new Error("openai model failed");
}

async function callGeminiWithFallback(opts: { model: string; system: string; user: string; signal: AbortSignal }) {
  const models = llmState.modelOverride
    ? [opts.model]
    : [opts.model, ...(DEFAULT_MODELS.gemini.fallbacks || [])].filter(Boolean);

  let lastErr: any = null;
  for (const m of models) {
    try {
      const text = await chatGemini({ apiKey: KEYS.GEMINI, model: m, system: opts.system, user: opts.user, signal: opts.signal });
      return { text, usedModel: m };
    } catch (e: any) {
      const msg = String(e?.message || "");
      dbg("GEMINI try fail", { model: m, err: msg.slice(0, 180) });
      lastErr = e;
      if (!isModelErr(msg)) throw e;
    }
  }
  throw lastErr || new Error("gemini model failed");
}

async function callLLM(provider: Provider, model: string, system: string, userText: string, signal: AbortSignal) {
  if (provider === "openai") {
    if (!KEYS.OPENAI) throw new Error("OPENAI_API_KEY 未配置");
    if (llmState.modelOverride) {
      const text = await openaiResponses({ baseURL: DEFAULT_MODELS.openai.baseURL!, apiKey: KEYS.OPENAI, model, system, user: userText, signal });
      return { text, usedModel: model };
    }
    return callOpenAIWithFallback({ model, system, user: userText, signal });
  }

  if (provider === "gemini") {
    if (!KEYS.GEMINI) throw new Error("GEMINI_API_KEY 未配置");
    return callGeminiWithFallback({ model, system, user: userText, signal });
  }

  if (!KEYS.DEEPSEEK) throw new Error("DEEPSEEK_API_KEY 未配置");
  const text = await chatOpenAICompat({ baseURL: DEFAULT_MODELS.deepseek.baseURL!, apiKey: KEYS.DEEPSEEK, model, system, user: userText, signal });
  return { text, usedModel: model };
}

function doSwitchProvider(p: Provider) {
  llmState.provider = p;
  llmState.modelOverride = "";
  const dm = DEFAULT_MODELS[p].model;
  const keyHint = hasKeyFor(p) ? "" : "（提示：未配置API Key，调用会失败）";
  return `已切换：${p}（默认模型：${dm}）。${keyHint}`;
}

// fallback 成功后同步默认模型（让“当前模型”对得上）
function syncOpenAIModelIfFallback(usedModel: string) {
  if (llmState.provider !== "openai") return;
  if (llmState.modelOverride) return;
  if (usedModel && usedModel !== DEFAULT_MODELS.openai.model) {
    DEFAULT_MODELS.openai.model = usedModel;
    dbg("OPENAI model synced to", usedModel);
  }
}

// ====== 主配置 ======
export const kOpenXiaoAIConfig = {
  callAIKeywords: ["", "开", "切", "设", "关", "查", "停", "闭", "你", "我", "请", "帮", "问", "前", "模"],

  prompt: {
    system: compactText(`
你是运行在小爱音箱上的语音助手，由大模型驱动。
口播规则：口语化、简短；不要markdown；不要念URL；解释类优先两句话内。
`),
  },

  async onMessage(engine: any, { text }: { text: string }) {
    const raw = (text || "").trim();
    if (!raw) return { handled: true };

    state.seq += 1;
    const mySeq = state.seq;

    try { state.controller?.abort(); } catch {}
    state.controller = null;

    await cancelSpeaking(engine);

    const cmd = normCmd(raw);
    const curNow = currentProviderModel();
    dbg("IN =>", { seq: mySeq, raw, cmd, mode: modeState.mode, provider: curNow.provider, model: curNow.model });

    // 输出开关
    if (cmd === "开启输出") { debugState.enabled = true; startSpeak(engine, mySeq, "已开启控制台输出。"); return { handled: true }; }
    if (cmd === "关闭输出") { startSpeak(engine, mySeq, "即将关闭控制台输出。"); debugState.enabled = false; return { handled: true }; }
    if (cmd === "查看输出") { startSpeak(engine, mySeq, `控制台输出：${debugState.enabled ? "已开启" : "已关闭"}`); return { handled: true }; }

    // 抢答抑制
    const isScriptCommand =
      cmd === "开启ai" || cmd === "切换ai" || cmd === "ai模式" ||
      cmd === "开启小爱" || cmd === "切换小爱" || cmd === "原生模式" || cmd === "原生小爱" ||
      cmd === "开启前缀" || cmd === "关闭前缀" || cmd === "查看前缀" ||
      raw.startsWith("设置前缀") ||
      cmd.startsWith("切换") || raw.startsWith("切换模型") || raw.startsWith("设置模型") ||
      cmd === "查看模型" || cmd === "查看模式" || cmd === "查看状态" ||
      cmd === "查看当前模型" || cmd === "当前模型" ||
      cmd === "查看最近调用" || cmd === "最近调用" ||
      cmd === "测试当前模型" || cmd === "测试模型" ||
      cmd === "开启报模型" || cmd === "关闭报模型" ||
      cmd === "停止" || cmd === "闭嘴";

    if (modeState.mode === "ai" || isScriptCommand) {
      await silenceNativeXiaoAI(engine);
    }

    // 停止
    if (cmd === "停止" || cmd === "闭嘴") {
      startSpeak(engine, mySeq, "好的。");
      return { handled: true };
    }

    // ===== 前缀命令 =====
    if (cmd === "开启前缀") {
      prefixState.enabled = true;
      startSpeak(engine, mySeq, "前缀已开启。");
      return { handled: true };
    }
    if (cmd === "关闭前缀") {
      prefixState.enabled = false;
      startSpeak(engine, mySeq, "前缀已关闭。");
      return { handled: true };
    }
    if (raw.startsWith("设置前缀")) {
      const v = raw.replace(/^设置前缀/, "").trim();
      if (v) prefixState.prefix = v;
      startSpeak(engine, mySeq, `前缀已设置为：${prefixState.prefix}`);
      return { handled: true };
    }
    if (cmd === "查看前缀") {
      startSpeak(engine, mySeq, `前缀状态：${prefixState.enabled ? "已开启" : "已关闭"}；前缀内容：${prefixState.prefix}`);
      return { handled: true };
    }

    // ===== 模式切换 =====
    if (cmd === "开启小爱" || cmd === "切换小爱" || cmd === "原生模式" || cmd === "原生小爱") {
      modeState.mode = "native";
      startSpeak(engine, mySeq, "已切换到原生小爱模式。");
      return { handled: true };
    }
    if (cmd === "开启ai" || cmd === "切换ai" || cmd === "ai模式") {
      modeState.mode = "ai";
      startSpeak(engine, mySeq, "已切换到AI模式。");
      return { handled: true };
    }
    if (cmd === "查看模式") {
      startSpeak(engine, mySeq, `当前模式：${modeState.mode === "ai" ? "AI模式" : "原生小爱模式"}`);
      return { handled: true };
    }

    // ===== 切换模型 =====
    const requireAIMode = () => {
      if (modeState.mode !== "ai") {
        startSpeak(engine, mySeq, "请先说：开启AI。");
        return false;
      }
      return true;
    };

    if (cmd === "切换openai" || cmd === "切换chatgpt" || cmd === "切换gpt") {
      if (!requireAIMode()) return { handled: true };
      startSpeak(engine, mySeq, doSwitchProvider("openai"));
      return { handled: true };
    }
    if (cmd === "切换gemini" || cmd === "切换google" || cmd === "切换谷歌" || cmd === "切换gmini") {
      if (!requireAIMode()) return { handled: true };
      startSpeak(engine, mySeq, doSwitchProvider("gemini"));
      return { handled: true };
    }
    if (cmd === "切换deepseek" || cmd === "切换ds") {
      if (!requireAIMode()) return { handled: true };
      startSpeak(engine, mySeq, doSwitchProvider("deepseek"));
      return { handled: true };
    }

    if (raw.startsWith("设置模型")) {
      const v = raw.replace(/^设置模型/, "").trim();
      if (!v) {
        startSpeak(engine, mySeq, "请说：设置模型 <模型ID>");
        return { handled: true };
      }
      llmState.modelOverride = v;
      startSpeak(engine, mySeq, `已设置当前模型为：${v}`);
      return { handled: true };
    }

    if (cmd === "查看模型") {
      const cur = currentProviderModel();
      startSpeak(engine, mySeq, `当前大模型：${cur.provider}/${cur.model}`);
      return { handled: true };
    }

    // ===== 测试模型 =====
    if (cmd === "测试当前模型" || cmd === "测试模型") {
      if (modeState.mode !== "ai") {
        startSpeak(engine, mySeq, "请先说：开启AI。");
        return { handled: true };
      }
      const cur = currentProviderModel();
      if (!hasKeyFor(cur.provider)) {
        startSpeak(engine, mySeq, `你还没配置 ${cur.provider} 的 API Key。`);
        return { handled: true };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, TEST_TIMEOUT_MS);

      (async () => {
        const t0 = nowMs();
        dbg("TEST start", cur);
        try {
          const sys = buildSystem(cur.provider, cur.model);
          const r = await callLLM(cur.provider, cur.model, sys, "请只回答：OK", ctrl.signal);
          clearTimeout(timer);

          if (cur.provider === "openai") syncOpenAIModelIfFallback(r.usedModel);

          diag.last = { provider: cur.provider, model: r.usedModel, ok: true, ms: nowMs() - t0, at: nowMs() };
          dbg("TEST ok", diag.last);

          startSpeak(engine, mySeq, `连通正常：${cur.provider}/${r.usedModel}，${diag.last.ms}ms，返回：${compactText(r.text) || "OK"}`);
        } catch (e: any) {
          clearTimeout(timer);
          const msg = String(e?.message || "unknown_error");
          diag.last = { provider: cur.provider, model: cur.model, ok: false, ms: nowMs() - t0, at: nowMs(), err: msg };
          dbg("TEST fail", diag.last);
          startSpeak(engine, mySeq, `连通失败：${cur.provider}/${cur.model}，${diag.last.ms}ms，原因：${msg}`);
        }
      })().catch((e: any) => dbg("TEST task error", String(e?.message || e)));

      return { handled: true };
    }

    // ===== 原生模式 =====
    if (modeState.mode === "native") {
      const ok = await askNativeXiaoAI(engine, raw);
      if (!ok) startSpeak(engine, mySeq, "原生小爱执行失败，请稍后再试。");
      return { handled: true };
    }

    // ===== AI 模式问答 =====
    const cur = currentProviderModel();
    if (!hasKeyFor(cur.provider)) {
      startSpeak(engine, mySeq, `你还没配置 ${cur.provider} 的 API Key。`);
      return { handled: true };
    }

    const controller = new AbortController();
    state.controller = controller;

    const timer = setTimeout(() => { try { controller.abort(); } catch {} }, LLM_TIMEOUT_MS);

    const sys = buildSystem(cur.provider, cur.model);
    const userText = mergeAddon(raw);

    (async () => {
      const t0 = nowMs();
      dbg("LLM start", { seq: mySeq, provider: cur.provider, model: cur.model, user: userText.slice(0, 120) });

      try {
        const r = await callLLM(cur.provider, cur.model, sys, userText, controller.signal);
        clearTimeout(timer);

        if (mySeq !== state.seq) return;

        if (cur.provider === "openai") syncOpenAIModelIfFallback(r.usedModel);

        diag.last = { provider: cur.provider, model: r.usedModel, ok: true, ms: nowMs() - t0, at: nowMs() };
        dbg("LLM ok", diag.last);

        let out = compactText(r.text);
        if (!out) out = "我没听清，你能再说一次吗？";

        startSpeak(engine, mySeq, out);
      } catch (e: any) {
        clearTimeout(timer);
        if (mySeq !== state.seq) return;

        const msg = String(e?.message || "");
        diag.last = { provider: cur.provider, model: cur.model, ok: false, ms: nowMs() - t0, at: nowMs(), err: msg };
        dbg("LLM FAIL", diag.last);

        if (msg.includes("aborted") || msg.includes("Abort") || msg.includes("The operation was aborted")) return;

        startSpeak(engine, mySeq, `调用失败（${cur.provider}/${cur.model}）：${msg}`);
      }
    })().catch((e: any) => dbg("LLM task error", String(e?.message || e)));

    return { handled: true };
  },
};