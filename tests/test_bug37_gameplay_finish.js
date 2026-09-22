#!/usr/bin/env node
/**
 * BUG#37 regression test — tìm GamePlay và nộp bài bằng endGame().
 *
 * Chạy:  node tests/test_bug37_gameplay_finish.js
 * Không cần Playwright / Xvfb / mạng. Test này NẠP THẲNG hai hàm thật
 * `findGamePlay` và `finishGameDirect` từ content/ioe/game-api-bridge.js rồi
 * chạy trên cây Cocos GIẢ lập.
 *
 * BỐI CẢNH (live 22/09/2026, hanh-tinh-tim Vòng 4 Bài 2):
 *   Solver làm xong 10/10 câu, HUD hiện "Score: 100", nhưng bảng tu-luyen vẫn
 *   ghi 0 điểm. Nguyên nhân: scene KHÔNG có node "btnSubmit"/"nameSubmit" —
 *   dump toàn bộ tên node active chỉ có btnA/btnClose/btn_container/btn_home/
 *   audioBtn. Đường nộp thật nằm trong GamePlay.onClimbNextCheckPoint:
 *       currentQuestionId >= questionArr.length  →  this.endGame()
 *   và endGame() POST FINISH_GAME rồi bật isEndGame = true + dựng PopupEndGame.
 *
 * Hai cái bẫy mà test này khoá lại:
 *   1. KHÔNG so tên class để tìm GamePlay — `constructor.name` bị minify thành
 *      "t"/"CCClass" (xem BUG#32). Phải nhận diện bằng BỘ ĐÔI field mà chính
 *      onClimbNextCheckPoint đọc: questComs (array) + currentQuestionId (number)
 *      + endGame (function).
 *   2. finishGameDirect phải CHỜ bất đồng bộ cho tới khi isEndGame === true
 *      (endGame là POST), chứ không trả về ngay sau khi gọi.
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

const NEEDED = ["getCC", "findGamePlay", "finishGameDirect"];
const parts = NEEDED.map(extractFn);

// `finishGameDirect` gọi `dismissSystemPopups()` — stub vô hại cho test.
parts.push("function dismissSystemPopups() { return 0; }");

// ---------------------------------------------------------------- Cocos giả lập
class Sprite {}

class Node {
  constructor(name, comps = [], children = []) {
    this.name = name; this.children = children; this.activeInHierarchy = true;
    this._components = comps;
    for (const c of children) c.parent = this;
  }
  getComponent(Cls) { return this._components.find((c) => c instanceof Cls) || null; }
}

/**
 * Component GamePlay giả lập — bắt chước ĐÚNG hành vi thật:
 *   endGame() POST bất đồng bộ rồi mới bật isEndGame (giống l.default.postApi
 *   với callback). `delayMs` mô phỏng độ trễ mạng.
 *
 * Tên class cố tình là "t" (minified) để chứng minh code KHÔNG dựa vào tên.
 */
function makeGamePlay({ endDelayMs = 300, failPost = false } = {}) {
  const t = {
    questComs: [new Node("nTrueFalse"), new Node("nTracNghiem")],
    currentQuestionId: 10,
    isEndGame: false,
    endGameCalls: 0,
    endGame() {
      t.endGameCalls++;
      setTimeout(() => { if (!failPost) t.isEndGame = true; }, endDelayMs);
    },
  };
  Object.defineProperty(t, "constructor", { value: { name: "t" } });
  return t;
}

/** Node khác có currentQuestionNumber + onButtonClick — controller đọc hiểu. */
function makeQuestController() {
  const c = {
    currentQuestionNumber: 3,
    onButtonClick() {},
    askStrContent: "Which country will the president visit first?",
    desStrContent: "The president will visit Colombia next month.",
  };
  Object.defineProperty(c, "constructor", { value: { name: "t" } });
  return c;
}

function buildScene(gp) {
  return new Node("StartScene", [new Sprite()], [
    new Node("Canvas", [new Sprite()], [
      new Node("GAME_PLAY", [new Sprite()], [
        new Node("nProfile", [new Sprite()]),
        // Controller đọc hiểu — KHÔNG được nhầm thành GamePlay.
        new Node("nConversationQuest", [makeQuestController()]),
        gp ? new Node("GamePlay", [gp]) : new Node("Nothing", [new Sprite()]),
      ]),
      // Node INACTIVE có đủ field — phải bị bỏ qua (game đã ẩn).
      new Node("OldGamePlay", [new Sprite()]),
    ]),
  ]);
}

function loadApi(scene) {
  const win = { cc: { Sprite, director: { getScene: () => scene } } };
  return new Function("window", `
    const cc = window.cc;
    ${parts.join("\n")}
    return { findGamePlay, finishGameDirect };
  `)(win);
}

// ---------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const check = (label, ok, extra) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok && extra !== undefined) console.log(`        ${extra}`);
};

(async () => {
  console.log("=== BUG#37: nhận diện GamePlay bằng field, KHÔNG bằng tên class ===");
  {
    const gp = makeGamePlay();
    const api = loadApi(buildScene(gp));
    const found = api.findGamePlay();
    check("tìm thấy GamePlay (class name minified 't')", found === gp,
      `got=${found && found.constructor.name} want=GamePlay instance`);
    check("không nhầm với quest controller đọc hiểu", found !== null && found.questComs !== undefined);
  }

  console.log("\n=== BUG#37: node INACTIVE bị bỏ qua ===");
  {
    const hidden = makeGamePlay();
    const node = new Node("GamePlayHidden", [hidden]);
    node.activeInHierarchy = false;
    const scene = new Node("StartScene", [new Sprite()], [new Node("Canvas", [new Sprite()], [node])]);
    const api = loadApi(scene);
    check("GamePlay trong node inactive → null", api.findGamePlay() === null);
  }

  console.log("\n=== BUG#37: không có GamePlay → báo lỗi rõ ràng ===");
  {
    const api = loadApi(buildScene(null));
    const r = await api.finishGameDirect();
    check("finishGameDirect trả ok=false", r.ok === false);
    check("reason = no_gameplay", r.reason === "no_gameplay", `got=${r.reason}`);
  }

  console.log("\n=== BUG#37: nộp bài THÀNH CÔNG (chờ isEndGame bật) ===");
  {
    const gp = makeGamePlay({ endDelayMs: 400 });
    const api = loadApi(buildScene(gp));
    const r = await api.finishGameDirect();
    check("gọi đúng endGame() 1 lần", gp.endGameCalls === 1, `got=${gp.endGameCalls}`);
    check("trả ok=true", r.ok === true, `got=${JSON.stringify(r)}`);
    check("isEndGame đã bật", gp.isEndGame === true);
    check("alreadyEnded=false (chưa nộp trước đó)", r.alreadyEnded === false);
  }

  console.log("\n=== BUG#37: POST thất bại → KHÔNG báo thành công giả ===");
  {
    const gp = makeGamePlay({ endDelayMs: 200, failPost: true });
    const api = loadApi(buildScene(gp));
    const r = await api.finishGameDirect();
    check("endGame() vẫn được gọi", gp.endGameCalls === 1);
    check("trả ok=false khi server không xác nhận", r.ok === false, `got=${JSON.stringify(r)}`);
    check("reason = no_endgame_ack", r.reason === "no_endgame_ack", `got=${r.reason}`);
  }

  console.log("\n=== BUG#37: gọi lại khi đã nộp → alreadyEnded=true, không nộp đôi ===");
  {
    const gp = makeGamePlay({ endDelayMs: 100 });
    gp.isEndGame = true;
    const api = loadApi(buildScene(gp));
    const r = await api.finishGameDirect();
    check("trả ok=true ngay", r.ok === true);
    check("alreadyEnded=true", r.alreadyEnded === true, `got=${r.alreadyEnded}`);
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
