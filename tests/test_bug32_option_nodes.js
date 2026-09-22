#!/usr/bin/env node
/**
 * BUG#32 regression test — MCQ option node lookup.
 *
 * Chạy:  node tests/test_bug32_option_nodes.js
 * Không cần Playwright / Xvfb / mạng. Test này NẠP THẲNG các hàm thật từ
 * content/ioe/game-api-bridge.js rồi chạy trên một cây Cocos GIẢ lập lại đúng
 * cấu trúc đã chụp được live từ game `an-khe-tra-vang` (22/09/2026):
 *
 *   nConversationQuest/
 *     answer_a/ [ aScrollView/ [ a_content_no_scroll-001  (RichText: text đáp án),
 *                                btnA  (cc.Sprite + AnswerButton, KHÔNG có Label) ],
 *                 icon_A/ ]
 *     answer_B/ [ ... btnB ... ]
 *     answer_c/ [ ... btnC ... ]
 *     answer_D/ [ ... btnd ... ]     <-- chữ d THƯỜNG, không phải btnD
 *
 * Ba lỗi mà test này khoá lại:
 *   1. nodeText(btnA) === null  → text đáp án nằm ở node ANH EM, không phải con
 *   2. isButton(btnA) === false → component tuỳ biến `AnswerButton`, không cc.Button
 *   3. `btnd` viết thường       → thang "btn"+letter của solver trượt ở D
 */
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "content", "ioe", "game-api-bridge.js");
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

const NEEDED = [
  "getCC", "allNodes", "isButton", "stripRichText", "labelOf", "nodeText", "normText",
  "findNodeByText", "findNodeByName", "findNodeByNameCI", "findClickableInSubtree",
  "resolveClickableInCard", "findClickTargetByText",
];
const parts = NEEDED.map(extractFn);
const reM = /const CUSTOM_BTN_RE = .*;/m.exec(src);
if (reM) parts.push(reM[0]);

// ---------------------------------------------------------------- Cocos giả lập
class Label { constructor(s) { this.string = s; } }
class RichText { constructor(s) { this.string = s; } }
class AnswerButton {}   // component tuỳ biến — KHÔNG phải cc.Button
class Button {}
class Sprite {}
class Toggle {}

class Node {
  constructor(name, comps = [], children = []) {
    this.name = name; this.children = children; this.activeInHierarchy = true;
    this._components = comps;
    for (const c of children) c.parent = this;
  }
  getComponent(Cls) { return this._components.find((c) => c instanceof Cls) || null; }
}

/** Một thẻ đáp án đúng như live: text và nút là ANH EM trong aScrollView. */
function card(letter, text, btnName) {
  return new Node("answer_" + letter, [new Sprite()], [
    new Node("aScrollView", [new Sprite()], [
      new Node("a_content_no_scroll-001", [new RichText(`<color=#000000>${text}</color>`)]),
      new Node(btnName, [new Sprite(), new AnswerButton()]),
    ]),
    new Node("icon_" + letter.toUpperCase(), [new Sprite()]),
  ]);
}

const OPTIONS = [
  ["a", "The reasons why some people refuse vaccination.", "btnA"],
  ["B", "The history of smallpox from ancient times to today.", "btnB"],
  ["c", "The methods scientists use to develop a new vaccine.", "btnC"],
  ["D", "The achievements of vaccines.", "btnd"],   // chữ d thường!
];

// Bố cục CỔ ĐIỂN (nhãn nằm TRONG nút) — dùng cho test hồi quy
const classic = new Node("nClassic", [new Sprite()], [
  new Node("btnA", [new Sprite(), new Button()], [new Node("Label", [new Label("Classic option A")])]),
  new Node("btnB", [new Sprite(), new Button()], [new Node("Label", [new Label("Classic option B")])]),
]);

const scene = new Node("StartScene", [new Sprite()], [
  new Node("Canvas", [new Sprite()], [
    new Node("nConversationQuest", [new Sprite()], OPTIONS.map(([l, t, b]) => card(l, t, b))),
    classic,
  ]),
]);

global.window = {
  cc: { Label, RichText, Button, Sprite, Toggle, director: { getScene: () => scene } },
};

const api = new Function("window", `
  const cc = window.cc;
  ${parts.join("\n")}
  return { findClickTargetByText, findNodeByNameCI, findNodeByName, isButton, nodeText, stripRichText };
`)(global.window);

// ---------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`);
};

console.log("=== BUG#32: text và nút là anh em trong thẻ đáp án ===");
for (const [letter, text, btnName] of OPTIONS) {
  const n = api.findClickTargetByText(text, { contains: true });
  check(`đáp án ${letter.toUpperCase()} → nút bấm`, n && n.name, btnName);
}

console.log("\n=== BUG#32: component tuỳ biến được nhận là nút ===");
const findNode = (name) => {
  let hit = null;
  (function walk(n) { if (!n || hit) return; if (n.name === name) { hit = n; return; }
    for (const c of n.children) walk(c); })(scene);
  return hit;
};
check("isButton(btnd) với AnswerButton", api.isButton(findNode("btnd")), true);
check("isButton(btnA) với AnswerButton", api.isButton(findNode("btnA")), true);
check("isButton(answer_a) — thẻ không phải nút", api.isButton(findNode("answer_a")), false);

console.log("\n=== BUG#32: tra tên không phân biệt hoa/thường ===");
check('findNodeByNameCI("btnD") → btnd', api.findNodeByNameCI("btnD")?.name, "btnd");
check('findNodeByNameCI("btnd") → btnd', api.findNodeByNameCI("btnd")?.name, "btnd");
check('findNodeByName("btnD") → null (giữ nguyên hành vi cũ)', api.findNodeByName("btnD"), null);

console.log("\n=== BUG#32: bóc markup RichText ===");
check("stripRichText", api.stripRichText("<color=#000000>The achievements of vaccines.</color>"),
  "The achievements of vaccines.");

console.log("\n=== Hồi quy: bố cục cổ điển (nhãn trong nút) ===");
const c = api.findClickTargetByText("Classic option A", { contains: true });
check("đáp án cổ điển → btnA", c && c.name, "btnA");

console.log("\n=== Hồi quy: không khớp thì trả null ===");
check("văn bản lạ → null", api.findClickTargetByText("Totally unrelated sentence here", { contains: true }), null);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
