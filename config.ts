// /opt/open-xiaoai-migpt/config.ts

type OpenAICompatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

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

// ===== 播放模式：默认非阻塞（关键：让 barge-in 生效）=====
const playMode =
  (globalThis as any).__open_xiaoai_play_mode ||
  {
    blocking: false, // ✅ 默认 false：提高“说话时仍能接收新输入”的概率
  };
(globalThis as any).__open_xiaoai_play_mode = playMode;

// ===== 控制台输出：日常默认开启 A，关闭 Q（避免重复）=====
const logState =
  (globalThis as any).__open_xiaoai_log_state ||
  {
    enabled: true,
    verbose: false,
    showMeta: true,
    showQ: false,
  };
(globalThis as any).__open_xiaoai_log_state = logState;

function logLine(s: string) {
  if (!logState.enabled) return;
  try {
    process.stdout.write(s + "\n");
  } catch {
    try {
      console.log(s);
    } catch {}
  }
}
function logQ(text: string) {
  if (!logState.enabled || !logState.showQ) return;
  logLine(`Q: ${text}`);
}
function logA(text: string, meta?: string) {
  if (!logState.enabled) return;
  if (meta && logState.showMeta) logLine(`A: ${text}  ${meta}`);
  else logLine(`A: ${text}`);
}
function logE(text: string) {
  if (!logState.enabled) return;
  logLine(`E: ${text}`);
}
function dbg(...args: any[]) {
  if (!logState.enabled || !logState.verbose) return;
  try {
    console.log("[dbg]", ...args);
  } catch {}
}

// ===== 前缀模式状态 =====
const prefixState =
  (globalThis as any).__open_xiaoai_prefix_state ||
  { enabled: false, prefix: "主人：" };
(globalThis as any).__open_xiaoai_prefix_state = prefixState;

// ===== 模式开关状态：AI / 原生小爱 =====
const modeState =
  (globalThis as any).__open_xiaoai_mode_state ||
  { mode: "ai" as "ai" | "native" };
(globalThis as any).__open_xiaoai_mode_state = modeState;

// ===== 模型/厂商状态 =====
const llmState =
  (globalThis as any).__open_xiaoai_llm_state ||
  { provider: "deepseek" as Provider, modelOverride: "" as string };
(globalThis as any).__open_xiaoai_llm_state = llmState;

// ===== 诊断状态 =====
const diag =
  (globalThis as any).__open_xiaoai_diag_state ||
  {
    last: null as null | {
      provider: Provider;
      model: string;
      ok: boolean;
      ms: number;
      at: number;
      err?: string;
    },
  };
(globalThis as any).__open_xiaoai_diag_state = diag;

// --------- 会话状态：用于取消旧请求/旧播报 ----------
const state =
  (globalThis as any).__open_xiaoai_bargein_state ||
  { seq: 0, controller: null as AbortController | null };
(globalThis as any).__open_xiaoai_bargein_state = state;

// ✅ 播报状态（用于打断 TTS 循环）
const speakState =
  (globalThis as any).__open_xiaoai_speak_state ||
  { controller: null as AbortController | null, speakingSeq: 0 };
(globalThis as any).__open_xiaoai_speak_state = speakState;

// ✅ 原生小爱“静音/重启”状态
const nativeSilenceState =
  (globalThis as any).__open_xiaoai_native_silence_state ||
  { lastHardAbortAt: 0, lastTryAt: 0 };
(globalThis as any).__open_xiaoai_native_silence_state = nativeSilenceState;

// ===== mergeAddon =====
const ctx = (globalThis as any).__xiaoai_ctx || { lastMain: "", lastAt: 0 };
(globalThis as any).__xiaoai_ctx = ctx;

// ====== Key / BaseURL / 默认模型 ======
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
  if (!/[：:，,。.!?？\s]$/.test(x)) x += "：";
  return x;
}
function applyPrefixToText(text: string) {
  const s = (text || "").trim();
  if (!s) return "";
  if (!prefixState.enabled) return s;

  const raw = (prefixState.prefix || "").trim();
  const p = normalizePrefix(raw);

  if (raw && s.startsWith(raw)) return s;
  if (s.startsWith(p)) return s;

  return p + s;
}
function splitForSpeaker(text: string, maxLen = SPEAK_CHUNK_LEN) {
  const clean = compactText(text);
  const parts = clean.split(/(?<=[。！？；…\n])/).map((x) => x.trim()).filter(Boolean);

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

// ===== 强力停播（关键）=====
async function callIfFn(obj: any, name: string, ...args: any[]) {
  const fn = obj?.[name];
  if (typeof fn === "function") {
    try {
      return await fn.apply(obj, args);
    } catch {}
  }
}

async function stopAISpeaking(engine: any) {
  const speaker = engine?.speaker;
  if (!speaker) return;

  const names = [
    "setPlaying",
    "stop",
    "abort",
    "stopPlaying",
    "stopPlay",
    "stopSpeak",
    "stopSpeaking",
    "stopTTS",
    "abortTTS",
    "abortSpeak",
    "cancel",
    "cancelSpeak",
    "cancelTTS",
  ];

  // 多轮尝试，提高命中率
  for (let round = 0; round < 3; round++) {
    for (const n of names) {
      if (n === "setPlaying") await callIfFn(speaker, n, false);
      else await callIfFn(speaker, n);
    }
    await sleep(60);
  }
}

async function abortNative(engine: any) {
  const sp = engine?.speaker;
  await callIfFn(sp, "abort_xiaoai");
  await callIfFn(sp, "abortXiaoAI");
  await callIfFn(sp, "abortXiaoAi");
}

function waitAbort(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelSpeaking(
  engine: any,
  opts?: { abortNativeToo?: boolean }
) {
  const abortNativeToo = !!opts?.abortNativeToo;

  try {
    speakState.controller?.abort();
  } catch {}
  speakState.speakingSeq = -1;

  await stopAISpeaking(engine);

  if (abortNativeToo) {
    await abortNative(engine);
    // 再补一轮（某些固件第一次停不干净）
    await sleep(80);
    await stopAISpeaking(engine);
  }
}

async function waitIfHardAborted(signal: AbortSignal) {
  const t = nativeSilenceState.lastHardAbortAt || 0;
  if (!t) return;
  const gap = nowMs() - t;
  const left = HARD_ABORT_RECOVERY_MS - gap;
  if (left > 0) await Promise.race([sleep(left), waitAbort(signal)]).catch(() => {});
}

// 估算非阻塞播放时每段需要等待多久（用于串行播放且可打断）
function estimateSpeakMs(text: string) {
  const t = (text || "").replace(/\s+/g, "");
  const len = t.length;

  // 大约 6~7 字/秒：150~170ms/字
  let ms = len * 160;

  // 标点停顿
  ms += (t.match(/[。！？!?]/g) || []).length * 260;
  ms += (t.match(/[，,；;]/g) || []).length * 140;

  // 限幅
  if (ms < 500) ms = 500;
  if (ms > 8000) ms = 8000;
  return ms;
}

async function playOneChunk(speaker: any, text: string, blocking: boolean) {
  // 有些固件不认识 blocking:false，会报错；这里兜底回退 blocking:true
  try {
    return await speaker.play({ text, blocking });
  } catch {
    return await speaker.play({ text, blocking: true });
  }
}

/** ✅ 播报：不阻塞 onMessage，可打断（默认非阻塞播放 + 自己等待估时） */
function startSpeak(engine: any, seq: number, text: string, meta?: string) {
  const finalText = applyPrefixToText(text);
  logA(finalText, meta);

  try {
    speakState.controller?.abort();
  } catch {}
  speakState.controller = new AbortController();
  speakState.speakingSeq = seq;

  const signal = speakState.controller.signal;

  // Abort 时立刻停声（关键）
  signal.addEventListener(
    "abort",
    () => {
      stopAISpeaking(engine);
      abortNative(engine);
    },
    { once: true }
  );

  const chunks = splitForSpeaker(finalText, SPEAK_CHUNK_LEN);

  (async () => {
    const speaker = engine?.speaker;
    if (!speaker?.play) return;

    await waitIfHardAborted(signal);

    for (const c of chunks) {
      if (signal.aborted) return;
      if (speakState.speakingSeq !== seq) return;

      const blocking = !!playMode.blocking;

      if (blocking) {
        const playP = Promise.resolve(playOneChunk(speaker, c, true)).catch(() => {});
        await Promise.race([playP, waitAbort(signal)]).catch(async () => {
          await stopAISpeaking(engine);
        });
      } else {
        // ✅ 非阻塞：先触发播放（快速返回），再等待估算时长（期间可被 abort 打断）
        const playP = Promise.resolve(playOneChunk(speaker, c, false)).catch(() => {});
        await Promise.race([playP, waitAbort(signal)]).catch(async () => {
          await stopAISpeaking(engine);
        });
        await Promise.race([sleep(estimateSpeakMs(c)), waitAbort(signal)]).catch(async () => {
          await stopAISpeaking(engine);
        });
      }
    }
  })().catch(() => {});
}

// ===== 原生小爱 =====
async function askNativeXiaoAI(engine: any, text: string) {
  const sp = engine?.speaker;
  const fn = sp?.askXiaoAI || sp?.askXiaoAi || sp?.ask_xiaoai;
  if (typeof fn === "function") {
    try {
      await fn.call(sp, text, { silent: false });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 抑制原生抢答（减少“抱歉不支持…”叠音） */
async function silenceNativeXiaoAI(engine: any): Promise<boolean> {
  const sp = engine?.speaker;
  const now = nowMs();
  if (now - (nativeSilenceState.lastTryAt || 0) < 250) return false;
  nativeSilenceState.lastTryAt = now;

  const softNames = [
    "abortXiaoAITTS",
    "abortXiaoAiTTS",
    "abort_xiaoai_tts",
    "stopXiaoAITTS",
    "stopXiaoAiTTS",
    "stop_xiaoai_tts",
    "stopXiaoAI",
    "stopXiaoAi",
    "stop_xiaoai",
  ];

  for (const n of softNames) {
    const fn = (sp as any)?.[n];
    if (typeof fn === "function") {
      try {
        await fn.call(sp);
        return false;
      } catch {}
    }
  }

  // 不频繁 hard abort，避免影响拾音窗口
  if (nowMs() - (nativeSilenceState.lastHardAbortAt || 0) < 8000) return false;

  const hardNames = ["abortXiaoAI", "abortXiaoAi", "abort_xiaoai"];
  for (const n of hardNames) {
    const fn = (sp as any)?.[n];
    if (typeof fn === "function") {
      try {
        await fn.call(sp);
        nativeSilenceState.lastHardAbortAt = nowMs();
        return true;
      } catch {}
    }
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(
    opts.apiKey
  )}`;
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
async function chatOpenAICompat(opts: {
  baseURL: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}) {
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

async function openaiResponses(opts: {
  baseURL: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}) {
  const base = opts.baseURL.replace(/\/+$/, "");
  const url = `${base}/responses`;

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
    (m.includes("model") &&
      (m.includes("not found") || m.includes("does not exist") || m.includes("unsupported") || m.includes("不存在")))
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
      lastErr = e;
      if (!isModelErr(msg)) throw e;
    }
  }
  throw lastErr || new Error("openai model failed");
}

async function callGeminiWithFallback(opts: { model: string; system: string; user: string; signal: AbortSignal }) {
  const models = llmState.modelOverride ? [opts.model] : [opts.model, ...(DEFAULT_MODELS.gemini.fallbacks || [])].filter(Boolean);
  let lastErr: any = null;

  for (const m of models) {
    try {
      const text = await chatGemini({ apiKey: KEYS.GEMINI, model: m, system: opts.system, user: opts.user, signal: opts.signal });
      return { text, usedModel: m };
    } catch (e: any) {
      const msg = String(e?.message || "");
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

function syncOpenAIModelIfFallback(usedModel: string) {
  if (llmState.provider !== "openai") return;
  if (llmState.modelOverride) return;
  if (usedModel && usedModel !== DEFAULT_MODELS.openai.model) {
    DEFAULT_MODELS.openai.model = usedModel;
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

    const cmd = normCmd(raw);
    logQ(raw);

    // ✅ 提前识别脚本命令
    const isScriptCommand =
      cmd === "开启ai" || cmd === "切换ai" || cmd === "ai模式" ||
      cmd === "开启小爱" || cmd === "切换小爱" || cmd === "原生模式" || cmd === "原生小爱" ||
      cmd === "开启前缀" || cmd === "关闭前缀" || cmd === "查看前缀" ||
      raw.startsWith("设置前缀") ||
      cmd.startsWith("切换") || raw.startsWith("设置模型") ||
      cmd === "测试模型" || cmd === "测试当前模型" ||
      cmd === "停止" || cmd === "闭嘴" ||
      cmd === "开启输出" || cmd === "关闭输出" ||
      cmd === "开启详细输出" || cmd === "关闭详细输出" ||
      cmd === "开启问题显示" || cmd === "开启q" ||
      cmd === "关闭问题显示" || cmd === "关闭q" ||
      cmd === "播放非阻塞" || cmd === "非阻塞播放" ||
      cmd === "播放阻塞" || cmd === "阻塞播放";

    // ✅ 关键最小修复：
    // 当前已经在原生模式下，并且这句不是脚本命令 -> 直接交给系统原生小爱
    // 不做任何 abort / cancel / silence，避免把原生语音通道提前打断
    if (modeState.mode === "native" && !isScriptCommand) {
      return { handled: false };
    }

    // ✅ 新消息先打断：取消播报 + 取消上一轮 LLM
    state.seq += 1;
    const mySeq = state.seq;

    try { state.controller?.abort(); } catch {}
    state.controller = null;

    await cancelSpeaking(engine, {
      abortNativeToo: modeState.mode === "ai",
    });

    // ===== 输出开关 =====
    if (cmd === "开启输出") {
      logState.enabled = true;
      startSpeak(engine, mySeq, "已开启控制台输出（只显示A）。");
      return { handled: true };
    }
    if (cmd === "关闭输出") {
      startSpeak(engine, mySeq, "即将关闭控制台输出。");
      logState.enabled = false;
      return { handled: true };
    }
    if (cmd === "开启详细输出") {
      logState.enabled = true;
      logState.verbose = true;
      startSpeak(engine, mySeq, "已开启详细输出。");
      return { handled: true };
    }
    if (cmd === "关闭详细输出") {
      logState.verbose = false;
      startSpeak(engine, mySeq, "已关闭详细输出。");
      return { handled: true };
    }
    if (cmd === "开启问题显示" || cmd === "开启q") {
      logState.showQ = true;
      startSpeak(engine, mySeq, "已开启：显示Q。");
      return { handled: true };
    }
    if (cmd === "关闭问题显示" || cmd === "关闭q") {
      logState.showQ = false;
      startSpeak(engine, mySeq, "已关闭：不显示Q。");
      return { handled: true };
    }

    // ===== 播放模式切换（可选）=====
    if (cmd === "播放非阻塞" || cmd === "非阻塞播放") {
      playMode.blocking = false;
      startSpeak(engine, mySeq, "已切换为：非阻塞播放（更容易打断）。");
      return { handled: true };
    }
    if (cmd === "播放阻塞" || cmd === "阻塞播放") {
      playMode.blocking = true;
      startSpeak(engine, mySeq, "已切换为：阻塞播放（更稳但可能不易打断）。");
      return { handled: true };
    }

    // 抢答抑制
    if (modeState.mode === "ai" || isScriptCommand) {
      await silenceNativeXiaoAI(engine);
    }

    if (cmd === "停止" || cmd === "闭嘴") {
      await cancelSpeaking(engine, { abortNativeToo: true });
      startSpeak(engine, mySeq, "好的。");
      return { handled: true };
    }

    // ===== 前缀 =====
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
        try {
          const sys = buildSystem(cur.provider, cur.model);
          const r = await callLLM(cur.provider, cur.model, sys, "请只回答：OK", ctrl.signal);
          clearTimeout(timer);

          if (cur.provider === "openai") syncOpenAIModelIfFallback(r.usedModel);

          const ms = nowMs() - t0;
          diag.last = { provider: cur.provider, model: r.usedModel, ok: true, ms, at: nowMs() };
          startSpeak(engine, mySeq, `连通正常：${cur.provider}/${r.usedModel}，${ms}ms，返回：OK`, `[${cur.provider}/${r.usedModel} ${ms}ms]`);
        } catch (e: any) {
          clearTimeout(timer);
          const msg = String(e?.message || "unknown_error");
          diag.last = { provider: cur.provider, model: cur.model, ok: false, ms: nowMs() - t0, at: nowMs(), err: msg };
          logE(msg);
          startSpeak(engine, mySeq, `连通失败：${cur.provider}/${cur.model}，原因：${msg}`);
        }
      })();

      return { handled: true };
    }

    // ===== 原生模式 =====
    if (modeState.mode === "native") {
      const ok = await askNativeXiaoAI(engine, raw);
      if (!ok) return { handled: false };
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
      try {
        const r = await callLLM(cur.provider, cur.model, sys, userText, controller.signal);
        clearTimeout(timer);
        if (mySeq !== state.seq) return;

        if (cur.provider === "openai") syncOpenAIModelIfFallback(r.usedModel);

        const ms = nowMs() - t0;
        const answer = compactText(r.text) || "我没听清，你能再说一次吗？";
        startSpeak(engine, mySeq, answer, `[${cur.provider}/${r.usedModel} ${ms}ms]`);
      } catch (e: any) {
        clearTimeout(timer);
        if (mySeq !== state.seq) return;

        const msg = String(e?.message || "");
        if (msg.includes("aborted") || msg.includes("Abort") || msg.includes("The operation was aborted")) return;

        logE(msg);
        startSpeak(engine, mySeq, `调用失败（${cur.provider}/${cur.model}）：${msg}`);
      }
    })();

    return { handled: true };
  },
};
