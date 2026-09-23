/**
 * test_bug54_cloze_multiword_bank.js — BUG#54 (23/09/2026)
 * Cloze điền-từ-đoạn-văn có kho từ là CỤM NHIỀU TỪ bị phân loại nhầm thành
 * "transform_typing" ⇒ solver đi GÕ từng câu vào EditBox (màn hình không có
 * EditBox nào) ⇒ bài đứng im 0 điểm dù AI trả lời đúng.
 *
 * Bối cảnh (live, giabao10a1 — Vòng 6 Bài 2 "cuon-giay-bi-an", 10 ô trống):
 *   API trả 1 câu duy nhất, type 3, format 21, prompt là kho từ nối bằng "|":
 *     "follow in their footsteps|common characteristics|experiences|shared values|
 *      memories|extended family|generational differences|open to|traditional views|
 *      disagreements"
 *   Màn hình: đoạn văn 10 ô trống (node SELECT_RICH_TEXT_CHILD_NAME) + 10 chip
 *   đáp án. Solver log "Phân loại đề từ dữ liệu API: transform_typing" rồi không
 *   làm gì cả — game không hề bị chạm tới.
 *
 *   Truy ra: nhánh `pipeBank` (BUG#42) nhận diện cloze bằng regex
 *     /^\s*[\w'-]+(\|[\w'-]+)+\s*$/
 *   trong đó MỖI mục phải là MỘT từ đơn (`[\w'-]+`). Kho từ ở đây toàn cụm 2–3
 *   từ ("follow in their footsteps") ⇒ regex trượt ⇒ rơi xuống nhánh
 *   `looksTransform` (type === 3, đúng bằng 100% số câu) ⇒ "transform_typing".
 *   BUG#42 đã cố ý đặt pipeBank TRƯỚC transform, nhưng cổng vào của nó quá hẹp
 *   nên đề này vẫn lọt.
 *
 *   Lượt đó đã CỨU được (100/100) bằng cách gọi thẳng bridge từ CDP:
 *   readGameScreen() → hỏi AI qua chrome.runtime → submitCloze(). Nhưng phải sửa
 *   gốc, nếu không mọi đề cloze nhiều-từ sau này đều chết.
 *
 * Khoá lại các bất biến:
 *   1. cloze nhiều từ ⇒ "cloze_chip" (đúng ca BUG#54).
 *   2. cloze một từ (BUG#42, "happen|opened|ambition|…") KHÔNG bị hồi quy.
 *   3. transform thật (câu tiếng Anh trọn vẹn, KHÔNG có "|") vẫn là
 *      "transform_typing" — nhánh pipeBank không được nới tới mức nuốt nó.
 *   4. pipeBank vẫn phải xét TRƯỚC transform (thứ tự dòng trong hàm).
 *   5. định danh bằng "|" là bắt buộc: prompt nhiều từ mà không có "|" ⇒ KHÔNG cloze.
 *   6. dấu nháy cong U+2019 ("children’s") phải lọt được vào lớp ký tự.
 *
 * Chạy: node tests/test_bug54_cloze_multiword_bank.js
 * (không cần mạng, không cần key, không cần Playwright)
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IOE_PATH = path.join(ROOT, "content", "ioe", "ioe.js");
const ioeSrc = fs.readFileSync(IOE_PATH, "utf8");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "  → " + extra : "")); }
}

// ---- trích thân hàm (cùng kỹ thuật đã dùng ở test_bug50/51/52) ----
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

// ============================================ A. cloze nhiều từ ⇒ cloze_chip
console.log("\nA. kho từ là CỤM NHIỀU TỪ ⇒ phải là cloze_chip (đúng ca BUG#54)");

// Dựng lại ĐÚNG nhánh pipeBank của classifyExam rồi chạy trên ca thật.
// Không chạy cả classifyExam (nó gọi deriveMatchPairsFromGameApi → cần scene
// thật); chỉ chạy biểu thức nhận diện, đúng thứ đã sai.
function extractPipeBank() {
  const body = fnBody(ioeSrc, "classifyExam");
  const m = body.match(/const\s+ITEM\s*=\s*("[^"]*")\s*;/);
  const p = body.match(/const\s+p0\s*=\s*String\(qs\[0\]\.prompt\s*\|\|\s*""\)\s*;/);
  const re = body.match(/const\s+pipeBank\s*=\s*qs\.length\s*===\s*1\s*&&\s*new\s+RegExp\(([^;]*?)\)\.test\(p0\)\s*;/s);
  if (!m || !p || !re) return null;
  return { itemLit: m[1], reExpr: re[1], body };
}

const ex = extractPipeBank();
ok(!!ex, "trích được nhánh pipeBank (ITEM + p0 + new RegExp(...).test(p0))");

let RE = null;
if (ex) {
  // eslint-disable-next-line no-eval
  RE = eval("(function(ITEM){ return new RegExp(" + ex.reExpr + ") })(" + ex.itemLit + ")");
  ok(RE instanceof RegExp, "dựng lại được regex pipeBank");
}

// prompt THẬT của Vòng 6 Bài 2 (live-caught)
const BUG54_BANK = "follow in their footsteps|common characteristics|experiences|shared values|memories|extended family|generational differences|open to|traditional views|disagreements";

if (RE) {
  ok(RE.test(BUG54_BANK), "kho từ Vòng 6 Bài 2 (cụm nhiều từ) KHỚP pipeBank ⇒ cloze_chip");
  ok(RE.test("  " + BUG54_BANK + "  "), "bản có khoảng trắng thừa ở hai đầu vẫn khớp");

  // ============================================ B. không hồi quy cloze 1 từ
  console.log("\nB. cloze MỘT từ (BUG#42) không bị hồi quy");
  ok(RE.test("happen|opened|ambition|Success|nearly|so"), "kho từ 1 từ (cuon-giay-bi-an, BUG#42)");
  ok(RE.test("every|all|by|called|took|scored"), "kho từ 1 từ (live 16/09/2026)");
  ok(RE.test("a|b|c"), "kho từ 3 mục, mỗi mục 1 ký tự");

  // ============================================ C. transform KHÔNG bị nuốt
  console.log("\nC. transform thật KHÔNG bị nhánh pipeBank nuốt");
  ok(!RE.test("It is important that we must be careful."),
    "câu tiếng Anh trọn vẹn (transform) KHÔNG khớp pipeBank");
  ok(!RE.test("It is important that we are careful and we should try harder."),
    "câu dài nhiều khoảng trắng KHÔNG khớp pipeBank");
  ok(!RE.test("extended family"),
    "cụm nhiều từ KHÔNG có '|' KHÔNG khớp — '|' là định danh bắt buộc");

  // ============================================ D. lớp ký tự
  console.log("\nD. lớp ký tự của mỗi mục");
  ok(RE.test("children’s|parents’"), "nháy cong U+2019 (children’s) lọt được");
  ok(RE.test("well-known|self-esteem"), "gạch nối (well-known) lọt được");
  ok(RE.test(" spaced  out | bank "), "nhiều khoảng trắng trong một mục lọt được");
  ok(!RE.test("has|a,comma"), "dấu phẩy KHÔNG lọt (giữ được ranh giới kho từ)");
  ok(!RE.test("câu có dấu chấm.|và mục hai"), "dấu chấm KHÔNG lọt");
}

// ============================================ E. thứ tự nhánh trong classifyExam
console.log("\nE. pipeBank phải xét TRƯỚC nhánh transform");
{
  const body = fnBody(ioeSrc, "classifyExam");
  // Neo vào CÂU LỆNH return, không phải chuỗi "transform_typing" trần: chuỗi đó
  // còn xuất hiện trong khối comment BUG#42 phía trên (comment nào cũng nằm
  // trước pipeBank) nên indexOf("transform_typing") luôn nhỏ hơn ⇒ test báo sai.
  const iPad = body.search(/if\s*\(\s*pipeBank\s*\)\s*return/);
  const iTransform = body.search(/return\s+"transform_typing"\s*;/);
  ok(iPad >= 0 && iTransform >= 0, "thấy cả nhánh pipeBank và return \"transform_typing\" trong classifyExam");
  ok(iPad >= 0 && iTransform >= 0 && iPad < iTransform,
    "pipeBank đứng TRƯỚC transform (BUG#42 giữ nguyên)",
    "pipeBank@" + iPad + " transform@" + iTransform);
  // và phải là `return` ngay, không rơi tiếp
  ok(/if\s*\(\s*pipeBank\s*\)\s*return\s+"cloze_chip"\s*;/.test(body),
    'có `if (pipeBank) return "cloze_chip";`');
}

console.log("\n" + (fail === 0 ? "✅" : "❌") + " " + pass + " PASS / " + fail + " FAIL\n");
process.exit(fail ? 1 : 0);
