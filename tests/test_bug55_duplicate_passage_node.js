/**
 * test_bug55_duplicate_passage_node.js — BUG#55 (23/09/2026)
 * Game đọc hiểu True/False dựng HAI node cùng tên `content_scroll` — một chứa
 * ĐOẠN VĂN (320 ký tự), một chứa CÂU KHẲNG ĐỊNH (107 ký tự). getPassageText()
 * trả về node ĐẦU TIÊN khớp tên, nên khi node câu hỏi đứng trước trong thứ tự
 * duyệt thì nó CHE MẤT đoạn văn thật.
 *
 * Bối cảnh (live, giabao10a1 — Vòng 7 Bài 2 "chinh-phuc-fansipan", 10 câu × 10 điểm):
 *   Solver log "⚠️ Không đọc được đoạn văn — AI phải suy luận từ các câu khẳng
 *   định." rồi hỏi AI từng câu KHÔNG ngữ cảnh. Điểm qua ba lượt: 30, 40, 70.
 *   Đo trên live: node `content_scroll` chứa đoạn văn dài 320 ký tự
 *   ("Whether you are looking for a conference venue or a place to have your
 *   meetings…"), còn node cùng tên kia chỉ 107 ký tự (chính là CÂU KHẲNG ĐỊNH
 *   "If you go to a conference at the International Centre…").
 *   `looksLikePassage()` đòi >= 180 ký tự ⇒ đoạn văn 107 ký tự bị loại ⇒ AI mù.
 *
 * Khoá lại các bất biến của getPassageText():
 *   1. CÙNG một tên node → chọn text DÀI NHẤT (đây là điều BUG#55 sửa).
 *   2. Thứ tự ưu tiên theo TÊN giữ nguyên: conv_content_scroll > content_scroll >
 *      conv_content > scrollRtext. Tên đứng trước thắng kể cả khi ngắn hơn —
 *      nếu không, `scrollRtext` (màn hướng dẫn = gameDesc) sẽ nuốt mất đoạn văn
 *      thật (BUG#41/#43).
 *   3. Ngưỡng tối thiểu 40 ký tự giữ nguyên.
 *   4. Node inactiveInHierarchy bị bỏ qua.
 *   5. Chỉ có node câu hỏi (ngắn) ⇒ vẫn trả nó như TRƯỚC (không hồi quy) —
 *      looksLikePassage() ở tầng content mới là chỗ loại nó.
 *
 * Chạy: node tests/test_bug55_duplicate_passage_node.js
 * (không cần mạng, không cần key, không cần Playwright)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BRIDGE_PATH = path.join(ROOT, "content", "ioe", "game-api-bridge.js");
const bridgeSrc = fs.readFileSync(BRIDGE_PATH, "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "  → " + extra : "")); }
}

// ---- trích thân hàm getPassageText (cùng kỹ thuật test_bug50/51/52/54) ----
function skipParams(src, from) {
  let i = src.indexOf("(", from);
  let depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error("không tìm thấy hết tham số");
}

function fnBody(src, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
  const m = re.exec(src);
  if (!m) throw new Error("không tìm thấy hàm: " + name);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  let i = src.indexOf("{", skipParams(src, m.index));
  let depth = 0, inStr = null, inLine = false, inBlock = false, inRe = false, reCls = false, prevSig = "";
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "*" && nx === "/") { inBlock = false; i++; } continue; }
    if (inRe) {
      if (ch === "\\") { i++; continue; }
      if (ch === "[") { reCls = true; continue; }
      if (ch === "]") { reCls = false; continue; }
      if (ch === "/" && !reCls) inRe = false;
      continue;
    }
    if (inStr) { if (ch === "\\") { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === "/" && nx === "/") { inLine = true; continue; }
    if (ch === "/" && nx === "*") { inBlock = true; i++; continue; }
    if (ch === "/" && !/[A-Za-z0-9_$)\]]$/.test(prevSig)) { inRe = true; reCls = false; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  throw new Error("hàm không đóng ngoặc: " + name);
}

const body = fnBody(bridgeSrc, "getPassageText");

// Chạy thuật toán CHỌN NODE thật của getPassageText trên cây giả. Không chạy cả
// hàm (nó cần cc/director thật); chỉ tái hiện vòng lặp chọn — đúng chỗ đã sai.
// Trích PASSAGE_NODES từ chính source để test bám theo code, không chép tay.
const namesMatch = body.match(/const\s+PASSAGE_NODES\s*=\s*(\[[^\]]*\])/);
ok(!!namesMatch, "trích được PASSAGE_NODES từ getPassageText");
const PASSAGE_NODES = namesMatch ? eval(namesMatch[1]) : [];
ok(Array.isArray(PASSAGE_NODES) && PASSAGE_NODES.length === 4,
  "PASSAGE_NODES có đủ 4 tên", JSON.stringify(PASSAGE_NODES));
ok(PASSAGE_NODES[0] === "conv_content_scroll" && PASSAGE_NODES[1] === "content_scroll",
  "thứ tự ưu tiên tên giữ nguyên (conv_content_scroll trước content_scroll)");

// Tái hiện vòng lặp chọn của bản ĐÃ SỬA: trong cùng tên lấy text dài nhất,
// theo tên thì tên đứng trước thắng, ngưỡng 40.
function pick(nodes) {
  for (const name of PASSAGE_NODES) {
    let best = "";
    for (const n of nodes) {
      if (n.active === false) continue;
      if (n.name !== name) continue;
      const s = String(n.text || "").trim();
      if (s.length > best.length) best = s;
    }
    if (best.length >= 40) return best;
  }
  return "";
}
// Bản CŨ (để chứng minh test bắt được lỗi): trả node đầu tiên đủ 40 ký tự.
function pickOld(nodes) {
  for (const name of PASSAGE_NODES) {
    for (const n of nodes) {
      if (n.active === false) continue;
      if (n.name !== name) continue;
      const s = String(n.text || "").trim();
      if (s.length >= 40) return s;
    }
  }
  return "";
}

// Dữ liệu THẬT lấy từ live (Vòng 7 Bài 2)
const CAU = "If you go to a conference at the International Centre, you can have food and drink any time during the day.";
const DOAN = "Whether you are looking for a conference venue or a place to have your meetings and your training days, the International Centre is the perfect place for you. We have a wide range of rooms available for hire, from small meeting rooms to a large conference hall that can accommodate up to 500 people. Our experienced staff will help you organise your event and make sure everything runs smoothly.";

console.log("\nA. SỬA ĐƯỢC LỖI — cùng tên thì lấy text DÀI NHẤT");
{
  const nodes = [{ name: "content_scroll", text: CAU }, { name: "content_scroll", text: DOAN }];
  const got = pick(nodes), old = pickOld(nodes);
  ok(got === DOAN, "câu hỏi đứng TRƯỚC đoạn văn → vẫn lấy được ĐOẠN VĂN");
  ok(old === CAU, "bản CŨ lấy nhầm câu hỏi (chứng minh đây là lỗi thật)", "old=" + old.slice(0, 40));
  ok(got.length >= 180, "kết quả qua được ngưỡng looksLikePassage() (>= 180)", "len=" + got.length);
  ok(pickOld(nodes).length < 180, "kết quả bản CŨ KHÔNG qua được ngưỡng 180 (⇒ AI mù)");
}

console.log("\nB. KHÔNG HỒI QUY — hành vi cũ giữ nguyên");
{
  const cases = [
    ["đoạn văn đứng trước", [{ name: "content_scroll", text: DOAN }, { name: "content_scroll", text: CAU }], DOAN],
    ["chỉ có đoạn văn", [{ name: "content_scroll", text: DOAN }], DOAN],
    ["chỉ có câu hỏi 107 ký tự", [{ name: "content_scroll", text: CAU }], CAU],
    ["node inactive bị bỏ", [{ name: "content_scroll", text: DOAN, active: false }, { name: "content_scroll", text: CAU }], CAU],
    ["text < 40 ký tự → không nhận", [{ name: "content_scroll", text: "Quá ngắn." }], ""],
    ["không có node nào", [], ""],
  ];
  for (const [ten, nodes, want] of cases) {
    const got = pick(nodes), old = pickOld(nodes);
    ok(got === want, ten + " → đúng");
    ok(got === old, ten + " → GIỐNG bản cũ (không hồi quy)");
  }
}

console.log("\nC. Thứ tự ưu tiên theo TÊN không bị đảo");
{
  const uu = "Đoạn văn ngắn hơn nhưng đúng tên ưu tiên và đủ 40 ký tự trở lên.";
  ok(pick([{ name: "content_scroll", text: DOAN }, { name: "conv_content_scroll", text: uu }]) === uu,
    "conv_content_scroll thắng content_scroll dài hơn");
  ok(pick([{ name: "scrollRtext", text: DOAN }, { name: "content_scroll", text: uu }]) === uu,
    "scrollRtext (màn hướng dẫn) KHÔNG nuốt mất content_scroll");
  ok(pick([{ name: "scrollRtext", text: DOAN }]) === DOAN,
    "chỉ có scrollRtext → vẫn dùng (fallback cũ)");
}

console.log("\nD. Hình dạng code — không quay lại lối 'trả node đầu tiên'");
{
  ok(/let\s+best\s*=\s*""/.test(body), "có biến `best` để so độ dài");
  ok(/s\.length\s*>\s*best\.length/.test(body), "so sánh `s.length > best.length` (lấy dài nhất)");
  ok(!/if\s*\(\s*t\s*&&\s*String\(t\)\.trim\(\)\.length\s*>=\s*40\s*\)\s*return/.test(body),
    "KHÔNG còn lối `if (t.length >= 40) return` (trả node đầu tiên)");
  ok(/best\.length\s*>=\s*40/.test(body), "ngưỡng 40 ký tự vẫn được áp cho `best`");
  ok(/BUG#55/.test(bridgeSrc), "có dấu vết BUG#55 trong bridge");
}

console.log("\n" + (fail === 0 ? "✅" : "❌") + " " + pass + " PASS / " + fail + " FAIL\n");
process.exit(fail ? 1 : 0);
