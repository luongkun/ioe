/**
 * test_bug49_project_quota.js — BUG#49 (22/09/2026): 429 quota theo PROJECT không được
 * thử tiếp các model Gemini khác
 *
 * Số liệu thật lấy từ log service worker khi chạy Vòng 7 Bài 4 (chim-hai-tao),
 * log đầy đủ trong message của từng test:
 *
 *   Trying model: gemini-3.6-flash...  → 429  "limit: 20 ... Please retry in 14.7s"
 *   Trying model: gemini-3.7-flash...  → 429  "limit: 20 ... Please retry in 12.8s"
 *   Trying model: gemini-flash-latest  → 429  "limit: 20 ... Please retry in 11.1s"
 *   Trying model: gemini-3.5-flash...  → 429  "limit: 20 ... Please retry in 45.5s"
 *
 * Google tính quota free tier theo PROJECT, và MỌI model dùng CHUNG một rổ
 * (`generate_content_free_tier_requests`) → chuyển model không cứu được gì, mà mỗi
 * lần thử còn ăn thêm 1 request vào đúng cái rổ đang cạn. Đó là lý do retry-after
 * TĂNG dần qua từng model. Test này khoá lại: gặp loại 429 đó phải dừng NGAY.
 *
 * Đồng thời phải giữ hành vi cũ cho các lỗi KHÁC (429 theo riêng model, 503
 * high-demand) — chuyển model ở đó là ĐÚNG, cấm dừng sớm.
 *
 * Chạy: node tests/test_bug49_project_quota.js
 * (nạp thẳng service_worker.js thật với chrome API giả — không cần mạng, không cần key)
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SW_PATH = path.join(__dirname, "..", "background", "service_worker.js");
const src = fs.readFileSync(SW_PATH, "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "  → " + extra : "")); }
}

// Thông điệp 429 THẬT của Google, metric free tier theo PROJECT.
const PROJECT_QUOTA_MSG = "You exceeded your current quota, please check your plan and billing details. "
  + "For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. "
  + "To monitor your current usage, head to: https://ai.dev/rate-limit. "
  + "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, "
  + "limit: 20, model: gemini-3.6-flash Please retry in 14.751975244s.";

// 429 theo RIÊNG model (không có metric free tier) — chuyển model ở đây là ĐÚNG.
const PER_MODEL_429_MSG = "Quota exceeded for metric: "
  + "generativelanguage.googleapis.com/generate_requests_per_model_per_minute, limit: 10, "
  + "model: gemini-3.6-flash Please retry in 3s.";

function makeEnv(storageOverrides, fetchImpl) {
  const storage = Object.assign({
    geminiApiKey: "AIza_test", model: "gemini-3.6-flash", autoShowToolbar: true,
    groqApiKey: "", preferProvider: "gemini",
    groqModel: "openai/gpt-oss-120b", groqWhisperModel: "whisper-large-v3-turbo",
    cfApiKey: "", cfAccountId: "", cfModel: "@cf/openai/gpt-oss-120b",
    cfWhisperModel: "@cf/openai/whisper-large-v3-turbo"
  }, storageOverrides || {});

  const calls = [];
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortSignal, Blob, FormData, TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, body: opts && opts.body, method: (opts && opts.method) || "GET" });
      return fetchImpl(u, opts, calls.length);
    },
    chrome: {
      storage: { local: {
        get: async (defaults) => Object.assign({}, defaults, storage),
        set: async (o) => Object.assign(storage, o)
      } },
      runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} },
                 onStartup: { addListener: () => {} }, lastError: null },
      contextMenus: { create: () => {}, removeAll: (cb) => cb && cb(), onClicked: { addListener: () => {} } },
      tabs: { captureVisibleTab: () => {}, sendMessage: () => {} },
      debugger: { attach: async () => {}, sendCommand: async () => {} }
    }
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "service_worker.js" });
  return { ctx, calls, storage, run: (e) => vm.runInContext(e, ctx) };
}

// Mọi model Gemini đều trả cùng một lỗi.
const alwaysFail = (status, message) => async (url) => {
  if (/generativelanguage\.googleapis\.com/.test(String(url))) {
    return { ok: false, status, json: async () => ({ error: { message } }), text: async () => "" };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};

const geminiCalls = (calls) => calls.filter(c => /generativelanguage/.test(c.url));
const modelsTried = (calls) => geminiCalls(calls).map(c => {
  const m = String(c.url).match(/models\/([^:]+):/);
  return m ? decodeURIComponent(m[1]) : "?";
});

async function catchError(run, expr) {
  try { await run(expr); return ""; }
  catch (e) { return String((e && e.message) || e); }
}

(async () => {
  // ------------------------------------------------------------------
  console.log("\nT1 — 429 quota THEO PROJECT: chỉ được gọi ĐÚNG 1 lần, không thử model kế");
  {
    const { calls, run } = makeEnv({}, alwaysFail(429, PROJECT_QUOTA_MSG));
    const msg = await catchError(run, `solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(geminiCalls(calls).length === 1, "chỉ 1 request Gemini (bản cũ: 5)", "nhận " + geminiCalls(calls).length);
    ok(modelsTried(calls).length === 1, "không chuyển model nào khác", modelsTried(calls).join(", "));
    ok(msg.length > 0, "vẫn ném lỗi ra ngoài (không im lặng thành công)");
  }

  // ------------------------------------------------------------------
  console.log("\nT2 — 429 theo RIÊNG model: VẪN phải thử hết các model (hành vi cũ đúng)");
  {
    const { calls, run } = makeEnv({}, alwaysFail(429, PER_MODEL_429_MSG));
    const msg = await catchError(run, `solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(geminiCalls(calls).length === 5, "thử hết 5 model", "nhận " + geminiCalls(calls).length);
    ok(new Set(modelsTried(calls)).size === 5, "5 model KHÁC nhau (không lặp)", modelsTried(calls).join(", "));
    ok(msg.length > 0, "vẫn ném lỗi ra ngoài");
  }

  // ------------------------------------------------------------------
  console.log("\nT3 — thông báo phải hiện THỜI GIAN CHỜ THẬT của Google");
  {
    const { run } = makeEnv({}, alwaysFail(429, PROJECT_QUOTA_MSG));
    const msg = await catchError(run, `solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    // 14.751975244s → làm tròn LÊN 15
    ok(/15 giây/.test(msg), "hiện đúng số giây làm tròn lên từ retry-after", msg.slice(0, 300));
  }

  // ------------------------------------------------------------------
  console.log("\nT4 — thông báo phải giải thích VÌ SAO không thử tiếp model khác");
  {
    const { run } = makeEnv({}, alwaysFail(429, PROJECT_QUOTA_MSG));
    const msg = await catchError(run, `solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(/PROJECT/.test(msg), "nói rõ hạn mức tính theo PROJECT", msg.slice(0, 200));
    ok(/DỪNG ngay/.test(msg), "nói rõ extension đã dừng chứ không phải bỏ sót model");
    ok(/Không thử|không thử/.test(msg) || /không thử/.test(msg), "giải thích lý do không thử tiếp");
    ok(/Groq/.test(msg) && /Cloudflare/.test(msg), "gợi ý đúng 2 provider có hạn mức riêng");
  }

  // ------------------------------------------------------------------
  console.log("\nT5 — lỗi 503 high-demand KHÔNG phải quota: vẫn phải chuyển model");
  {
    const { calls, run } = makeEnv({}, alwaysFail(503, "This model is currently experiencing high demand."));
    await catchError(run, `solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(geminiCalls(calls).length === 5, "thử hết 5 model khi model quá tải", "nhận " + geminiCalls(calls).length);
  }

  // ------------------------------------------------------------------
  console.log("\nT6 — hàm nhận diện: chỉ đúng metric free tier mới bị coi là quota project");
  {
    const { run } = makeEnv({}, alwaysFail(429, PROJECT_QUOTA_MSG));
    ok(run(`isProjectQuotaError({ status: 429, message: ${JSON.stringify(PROJECT_QUOTA_MSG)} })`) === true,
       "429 có metric free_tier → true");
    ok(run(`isProjectQuotaError({ status: 429, message: ${JSON.stringify(PER_MODEL_429_MSG)} })`) === false,
       "429 không có metric free_tier → false");
    ok(run(`isProjectQuotaError({ status: 503, message: ${JSON.stringify(PROJECT_QUOTA_MSG)} })`) === false,
       "503 dù message giống → false (theo status)");
    ok(run(`isProjectQuotaError({ status: 429, message: "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000" })`) === true,
       "metric free_tier dạng token cũng nhận ra");
  }

  // ------------------------------------------------------------------
  console.log("\nT7 — trích retry-after: hiểu cả 2 dạng Google trả về, thiếu thì trả null");
  {
    const { run } = makeEnv({}, alwaysFail(429, PROJECT_QUOTA_MSG));
    ok(run(`parseRetryAfterSeconds({ message: "Please retry in 14.751975244s." })`) === 15,
       "'Please retry in 14.75s' → 15 (làm tròn lên)");
    ok(run(`parseRetryAfterSeconds({ message: 'retryDelay: "45s"' })`) === 45,
       "'retryDelay: 45s' (JSON) → 45");
    ok(run(`parseRetryAfterSeconds({ message: "Quota exceeded, no hint here" })`) === null,
       "không có gợi ý → null");
    ok(run(`parseRetryAfterSeconds({ message: "" })`) === null, "message rỗng → null");
  }

  // ------------------------------------------------------------------
  console.log("\nT8 — chuỗi provider: Gemini hết project quota → nhường cho Cloudflare");
  {
    // Gemini 429 project-quota, Cloudflare chạy được.
    const impl = async (url) => {
      const u = String(url);
      if (/generativelanguage\.googleapis\.com/.test(u)) {
        return { ok: false, status: 429, json: async () => ({ error: { message: PROJECT_QUOTA_MSG } }), text: async () => "" };
      }
      if (/api\.cloudflare\.com.*chat\/completions/.test(u)) {
        return { ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: "[TF_ANSWERS: 1. True, 2. False]" } }] }),
          text: async () => "" };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    };
    const { calls, run } = makeEnv({ cfApiKey: "cf_test", cfAccountId: "acc123" }, impl);
    const out = await run(`solveWithAi("đề chữ", "ioe_auto", { examKind: "reading_tf" })`);
    ok(/TF_ANSWERS/.test(String(out)), "vẫn có đáp án nhờ provider có hạn mức riêng");
    ok(geminiCalls(calls).length === 1, "Gemini chỉ bị gọi 1 lần dù hết quota", "nhận " + geminiCalls(calls).length);
    ok(calls.filter(c => /api\.cloudflare\.com.*chat\/completions/.test(c.url)).length === 1,
       "Cloudflare tiếp quản đúng 1 lần");
  }

  console.log("\n" + "=".repeat(56));
  console.log(`KẾT QUẢ: ${pass}/${pass + fail} PASS` + (fail ? `  (${fail} FAIL)` : "  ✅"));
  console.log("=".repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n❌ Test crash:", (e && e.stack) || e);
  process.exit(1);
});
