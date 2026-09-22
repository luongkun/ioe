#!/usr/bin/env node
/**
 * BUG#47 regression test — đề NGHE True/False: không bỏ bài khi AI lỗi một lượt,
 * và không bao giờ lấp đáp án thiếu bằng `true`.
 *
 * Chạy:  node tests/test_bug47_listening_tf_retry.js
 * Không cần Playwright / Xvfb / mạng.
 *
 * Bối cảnh (live 22/09/2026, chim-hai-tao — Vòng 7 Bài 4, lớp 11):
 *   Log thật của lượt chạy hỏng:
 *     🎮 Phân loại đề từ dữ liệu API: reading_tf
 *     ⚠️ Không đọc được đoạn văn — AI phải suy luận từ các câu khẳng định.
 *     🎧 Đề NGHE TF: bài nghe = tl-k11-v7.mp3        ← đường nghe CHẠY ĐÚNG
 *     📖 Extracted Full Passage (1929 chars)         ← rồi RƠI xuống đường ảnh
 *   Tức là phần "đọc được file nghe" đã xong; bài chết ở lời gọi AI (quota 429).
 *   `solveReadingTfExam` return false ⇒ autoSolveCocosGame() tưởng chưa xử lý
 *   được, chạy tiếp executeScreenAndAudioSolve() — đường chụp ảnh chung, chắc
 *   chắn sai với đề nghe (không có passage) và tốn thêm một lượt AI.
 *
 * Khoá lại 3 hành vi:
 *   1. parseTfAnswersTag(..., requireAll=true) trả null khi AI trả THIẾU câu
 *      (thay vì lấp bằng `true` — hỏng âm thầm).
 *   2. parseTfAnswersTag(..., requireAll=false) giữ nguyên hành vi cũ (đường đọc
 *      hiểu hỏi từng câu vẫn phải nhận được đáp án).
 *   3. Vòng thử lại 3 lượt trong nhánh nghe: lượt 1 hỏng → lượt 2 được gọi, và
 *      lượt 1 hỏng KHÔNG làm mất đáp án của lượt 2.
 *   4. Hết 3 lượt vẫn hỏng → DỪNG HẲN (không rơi xuống đường chụp ảnh).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "content", "ioe", "ioe.js");
const src = fs.readFileSync(FILE, "utf8");

/** Trích `function NAME(...) { ... }` bằng cách đếm ngoặc (bỏ qua chuỗi/comment). */
function extractFn(name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) throw new Error("không tìm thấy hàm: " + name);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  let i = src.indexOf("{", m.index);
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === "/" && next === "/") { inLine = true; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("hàm không đóng ngoặc: " + name);
}

// --------------------------------------------------------------- assert
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "  → " + extra : "")); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label,
  `nhận ${JSON.stringify(a)}, mong ${JSON.stringify(b)}`);

// ------------------------------------------------- nạp parseTfAnswersTag thật
const sandbox = {};
const ctx = require("vm").createContext(sandbox);
require("vm").runInContext(extractFn("parseTfAnswersTag"), ctx, { filename: "ioe.js" });
const parseTfAnswersTag = sandbox.parseTfAnswersTag;

console.log("\nT1 — parse: AI trả ĐỦ 5 câu → nhận đúng từng câu");
{
  const r = parseTfAnswersTag(
    "[TF_ANSWERS: 1. True, 2. False, 3. False, 4. True, 5. False]\nGiải thích...", 5, true);
  eq(r, [true, false, false, true, false], "đọc đúng 5/5 theo thứ tự");
}

console.log("\nT2 — parse: AI trả THIẾU câu + requireAll=true → null (KHÔNG lấp bằng True)");
{
  // Đây chính là lỗi hỏng âm thầm: bản cũ lấp câu 4,5 bằng `true` và không ai biết.
  const r = parseTfAnswersTag("[TF_ANSWERS: 1. True, 2. False, 3. False]", 5, true);
  ok(r === null, "trả null để caller thử lại", "nhận " + JSON.stringify(r));
}

console.log("\nT3 — parse: cùng dữ liệu nhưng requireAll=false (đường đọc hiểu) → giữ hành vi cũ");
{
  const r = parseTfAnswersTag("[TF_ANSWERS: 1. True, 2. False, 3. False]", 5, false);
  eq(r, [true, false, false, true, true], "câu thiếu mặc định True như trước (tương thích ngược)");
}

console.log("\nT4 — parse: hỏi TỪNG CÂU (total=1) không bị cờ requireAll ảnh hưởng");
{
  eq(parseTfAnswersTag("[TF_ANSWERS: 7/10. False]", 1, true), [false], "nhận token đầu khi total=1");
  eq(parseTfAnswersTag("[ANSWER: True]", 1, true), [true], "nhận cả tag [ANSWER: ...] (BUG#44c)");
  ok(parseTfAnswersTag("AI trả lời suông không có tag", 1, true) === null,
     "không có tag → null (không đoán bừa)");
}

// ------------------------------------------- mô phỏng nhánh nghe (vòng thử lại)
// Mô phỏng ĐÚNG khối code trong solveReadingTfExam: 3 lượt, chỉ nhận khi đủ câu.
async function runListeningBranch(aiResponses) {
  const qs = [1, 2, 3, 4, 5].map(i => ({ prompt: "statement " + i }));
  const answers = new Array(qs.length).fill(null);
  let aiCalls = 0, parsed = null, lastErr = null;
  for (let aiTry = 0; aiTry < 3 && !parsed; aiTry++) {
    const lresp = aiResponses[Math.min(aiCalls, aiResponses.length - 1)];
    aiCalls++;
    parsed = (lresp && lresp.success) ? parseTfAnswersTag(lresp.data, qs.length, true) : null;
    if (!parsed) lastErr = (lresp && lresp.error) || "AI trả lời không đúng định dạng [TF_ANSWERS: ...]";
  }
  const stoppedHard = !parsed;               // BUG#47: hết lượt → return true (dừng hẳn)
  if (parsed) parsed.forEach((v, i) => { answers[i] = v; });
  return { aiCalls, parsed, answers, lastErr, stoppedHard };
}

(async () => {
  console.log("\nT5 — lượt 1 lỗi (quota 429), lượt 2 OK → PHẢI dùng được đáp án của lượt 2");
  {
    const r = await runListeningBranch([
      { success: false, error: "429 quota exceeded" },
      { success: true, data: "[TF_ANSWERS: 1. False, 2. False, 3. True, 4. True, 5. False]" }
    ]);
    eq(r.aiCalls, 2, "gọi AI đúng 2 lượt (không bỏ cuộc sau lượt 1)");
    eq(r.answers, [false, false, true, true, false], "đáp án lấy từ lượt 2, đúng thứ tự");
    ok(r.stoppedHard === false, "đánh dấu đã xử lý xong (không rơi xuống đường chụp ảnh)");
  }

  console.log("\nT6 — lượt 1 trả THIẾU câu, lượt 2 trả đủ → không nộp đáp án bịa");
  {
    const r = await runListeningBranch([
      { success: true, data: "[TF_ANSWERS: 1. True, 2. True]" },                  // thiếu 3 câu
      { success: true, data: "[TF_ANSWERS: 1. True, 2. False, 3. False, 4. True, 5. True]" }
    ]);
    eq(r.aiCalls, 2, "lượt thiếu câu bị coi là hỏng → thử lại");
    eq(r.answers, [true, false, false, true, true], "dùng bộ đủ 5 câu của lượt 2");
  }

  console.log("\nT7 — cả 3 lượt đều lỗi → DỪNG HẲN, không chạy đường chụp ảnh chung");
  {
    const r = await runListeningBranch([{ success: false, error: "429 quota exceeded" }]);
    eq(r.aiCalls, 3, "thử đủ 3 lượt rồi mới bỏ");
    ok(r.stoppedHard === true, "báo ĐÃ XỬ LÝ (return true) để không tốn thêm lượt AI sai");
    ok(r.answers.every(v => v === null), "không câu nào bị gán đáp án bịa");
    ok(/429/.test(r.lastErr), "giữ lại lỗi thật để hiện trong panel hướng dẫn");
  }

  console.log("\n" + "=".repeat(56));
  console.log(`KẾT QUẢ: ${pass}/${pass + fail} PASS` + (fail ? `  (${fail} FAIL)` : "  ✅"));
  console.log("=".repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n❌ Test crash:", (e && e.stack) || e);
  process.exit(1);
});
