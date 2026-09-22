#!/usr/bin/env node
/**
 * BUG#33 regression test — máy trạng thái ghép cặp (ghep-cap).
 *
 * Chạy:  node tests/test_bug33_match_state.js
 * Không cần Playwright / Xvfb / mạng.
 *
 * Test này NẠP THẲNG các hàm thật từ content/ioe/game-api-bridge.js rồi chạy
 * trên một bản MÔ PHỎNG LẠI đúng logic game lấy từ mã nguồn đã tải về
 * (assets/resources/index.*.js → class `Game12` + `GamePlay`):
 *
 *   Game12.onHandlerChooseAnswerCross(e):
 *     - chưa có selectCross1        → CHỌN e.target
 *     - e.target === selectCross1   → BỎ CHỌN (toggle)
 *     - khác                        → NỘP CẶP: rootGame.submit(sel1, sel2, count===2)
 *                                     và bật mask.active (chặn click) tới khi
 *                                     server trả lời
 *
 *   GamePlay.submit(a, b, isEnd):
 *     ăn khi  findQuestModel(a.content).answearArr[0].content === b.ans
 *     ⇒ THỨ TỰ [prompt, answer] mới đúng
 *
 *   GamePlay.failAnswer():
 *     sai KHÔNG kết thúc ngay; chỉ endGame khi
 *       wrongPick * (totalPoint / totalCards) > 0.3 * totalPoint
 *     (12 thẻ / 60 điểm → 4 lần sai)
 *
 *   Game12.continue(e):
 *     chỉ khi e === true mới đặt Button.interactable = false cho 2 thẻ vừa ghép
 *     → đó là dấu hiệu "đã ghép" mà autoMatch dựa vào.
 *
 * Khoá lại 4 hành vi đã sửa:
 *   1. Nộp ĐÚNG THỨ TỰ [prompt, answer]
 *   2. Bỏ qua cặp đã ghép khi chạy lại (không đốt lượt sai)
 *   3. DỪNG trước khi chạm ngân sách sai (không để game tự kết thúc)
 *   4. Chờ mask tắt trước khi click (submit đang bay thì click bị nuốt)
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
  "findGame12Controller", "readMatchCard", "matchState", "cardByTextAny", "cardMatchesKey", "occluderAt",
  "findMatchCard", "waitMaskClear", "waitForSelection", "waitPairResolved",
  "waitForNodeByText", "pickTextNode", "clickNode", "autoMatch",
  "findAllNodesByText",
];
const parts = NEEDED.map(extractFn);
for (const re of [/const CUSTOM_BTN_RE = .*;/m, /const normMatchText = .*;/m, /const sleep = .*;/m]) {
  const m = re.exec(src);
  if (m) parts.push(m[0]);
}

// ------------------------------------------------- Cocos + game giả lập (theo mã nguồn)
class Label { constructor(s) { this.string = s; } }
class RichText { constructor(s) { this.string = s; } }
class Button { constructor() { this.interactable = true; } }
class Sprite {}
class Toggle {}
class Component {}

const isImageRef = (s) => typeof s === "string" && /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(s);

class Node {
  constructor(name, comps = [], children = []) {
    this.name = name; this.children = children;
    // `active` (cờ thật của Cocos) và `activeInHierarchy` (đã tính cả tổ tiên).
    // Mock phải giữ ĐỒNG BỘ hai giá trị này: bridge chỉ đọc activeInHierarchy,
    // còn code game (chép từ bundle) chỉ ghi `active`.
    this._aih = true;
    this._components = comps; this.isValid = true;
    for (const c of children) c.parent = this;
  }
  // `active` (cờ thật của Cocos) và `activeInHierarchy` (đã tính cả tổ tiên).
  // Mock phải giữ ĐỒNG BỘ hai giá trị này: bridge chỉ đọc activeInHierarchy,
  // còn code game (chép từ bundle) chỉ ghi `active`.
  get active() { return this._aih; }
  set active(v) { this._aih = !!v; }
  get activeInHierarchy() {
    if (this.parent && this.parent.activeInHierarchy === false) return false;
    return this._aih;
  }
  set activeInHierarchy(v) { this._aih = !!v; }
  setActive(v) { this._aih = !!v; }
  getComponent(Cls) { return this._components.find((c) => c instanceof Cls) || null; }
  getComponents(Cls) { return this._components.filter((c) => c instanceof Cls); }
  getChildByName(n) { return this.children.find((c) => c.name === n) || null; }
  addChild(c) { c.parent = this; this.children.push(c); }
}

/** Bản mô phỏng Game12 + GamePlay — chép từ bundle đã tải. */
class FakeGame extends Component {
  constructor(pairs, totalPoint) {
    super();
    this.mask = new Node("mask", [new Sprite()]);
    this.mask.active = false;
    this.ctnCross = new Node("ctnCross", [new Sprite()]);
    this.selectCross1 = undefined;
    this.selectCross2 = undefined;
    this.count = pairs.length * 2;
    this.wrongPick = 0;
    this.totalPoint = totalPoint;
    this.resultQuest = [];
    this.isEndGame = false;
    this._pairs = pairs;
    this._clicks = [];       // log mọi lần clickNode chạm vào đây
    // Hình dạng dataAnswer CHÉP ĐÚNG dữ liệu live (xem verify-matchstate.mjs):
    //   thẻ PROMPT: { content: { content: "<khoá>" }, ans: [ {…} ] }  ← ans là MẢNG
    //   thẻ ANSWER: { ans: "<khoá>" }                                 ← ans là STRING
    // Sự bất đối xứng này chính là thứ làm GamePlay.submit chạy được:
    //   content = a.content.content  (chỉ thẻ prompt có)
    //   ans     = a.ans nếu là string, ngược lại b.ans  (chỉ thẻ answer có)
    // Thẻ answer ảnh thì TẮT node "txt", bật "image" (Game12.setupctnCross).
    for (const [p, a] of pairs) {
      const mkCard = (val, isPrompt) => {
        const isImg = !isPrompt && isImageRef(val);
        const btn = new Button();
        const txtNode = new Node("txt", [new Label(isImg ? "" : val)]);
        const imgNode = new Node("image", [new Sprite()]);
        if (isImg) txtNode.active = false; else imgNode.active = false;
        const card = new Node("crossBig", [new Sprite(), btn], [
          txtNode, imgNode, new Node("active", [new Sprite()]),
        ]);
        card.dataAnswer = isPrompt
          ? { content: { content: val }, ans: [{ content: val, type: 1 }] }
          : { ans: val };
        card.getComponent = (Cls) => (Cls === Button ? btn : null);
        return card;
      };
      this.ctnCross.addChild(mkCard(p, true));
      this.ctnCross.addChild(mkCard(a, false));
    }
    this.ctnCross.children.forEach((c) => (c.children.find((x) => x.name === "active").active = false));
  }

  /** Game12.onHandlerChooseAnswerCross */
  onHandlerChooseAnswerCross(e) {
    this._clicks.push(e.target);
    if (this.selectCross1) {
      if (this.selectCross1 === e.target) {
        this.selectCross1.getChildByName("active").active = false;
        this.selectCross1 = undefined;
      } else {
        this.selectCross2 = e.target;
        this.selectCross1.getChildByName("active").active = true;
        this.mask.active = true;
        this.submit(this.selectCross1.dataAnswer, this.selectCross2.dataAnswer, this.count === 2);
      }
    } else {
      this.selectCross1 = e.target;
      this.selectCross1.getChildByName("active").active = true;
    }
  }

  /** GamePlay.submit — chép nguyên văn từ bundle:
   *    var i = e.content ? e.content.content : t.content.content;
   *    n     = e.ans && "string"==typeof e.ans ? e.ans : t.ans;
   *  ⇒ `content` lấy từ thẻ NÀO CÓ content; `ans` ưu tiên thẻ A. */
  submit(a, b) {
    const i = a.content ? a.content.content : (b.content ? b.content.content : undefined);
    const n = (a.ans && typeof a.ans === "string") ? a.ans : b.ans;
    const pair = this._pairs.find(([p]) => p === i);
    const ok = !!(pair && pair[1] === n);
    if (ok) this.continue(true); else this.failAnswer();
  }

  /** GamePlay.failAnswer — chỉ endGame khi vượt 30% tổng điểm */
  failAnswer() {
    this.wrongPick++;
    const perCard = this.totalPoint / (this._pairs.length * 2);
    if (this.wrongPick * perCard > 0.3 * this.totalPoint) this.endGame();
    else this.continue(false);
  }

  /** Game12.continue */
  continue(e) {
    if (e) {
      this.selectCross1.getComponent(Button).interactable = false;
      this.selectCross2.getComponent(Button).interactable = false;
      this.count -= 2;
      if (this.count === 0) this.endGame();
    }
    this.selectCross1.getChildByName("active").active = false;
    if (this.selectCross2) this.selectCross2.getChildByName("active").active = false;
    this.selectCross1 = undefined;
    this.selectCross2 = undefined;
    this.mask.active = false;
  }

  endGame() { this.isEndGame = true; this.mask.active = false; }
}

const PAIRS = [
  ["Sympathetic", "Thông cảm, đồng cảm"],
  ["Argument", "Cuộc tranh luận"],
  ["Achievement", "Thành tựu"],
  ["Vaccine", "Vắc-xin"],
  ["Evidence", "Bằng chứng"],
  ["Debate", "Tranh luận"],
];

let game = new FakeGame(PAIRS, 60);
const scene = new Node("StartScene", [new Sprite()], [new Node("Canvas", [new Sprite()], [game.ctnCross, game.mask])]);
scene.addChild(new Node("quest_game12", [new Sprite(), game]));

global.window = {
  cc: { Label, RichText, Button, Sprite, Toggle, Component, director: { getScene: () => scene } },
  location: { origin: "https://ioe.vn" },
  postMessage: () => {},
};
// clickNode thật dùng DOM/trusted-click — thay bằng cách gọi thẳng handler của game
// đúng như engine sẽ làm khi nhận input thật.
const api = new Function("window", `
  const cc = window.cc;
  ${parts.join("\n")}
  function clickNode(node) {
    if (!node) return false;
    const g = findGame12Controller();
    if (!g) return false;
    g.onHandlerChooseAnswerCross({ target: node });
    return true;
  }
  function dismissSystemPopups() { return 0; }
  function getRandom(a, b) { return a; }
  return { autoMatch, matchState, cardByTextAny, findMatchCard };
`)(global.window);

// ---------------------------------------------------------------------- runner
let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`);
};

const reset = () => {
  game = new FakeGame(PAIRS, 60);
  scene.children[0].children[0] = game.ctnCross;
  scene.children[0].children[1] = game.mask;
  scene.children[1] = new Node("quest_game12", [new Sprite(), game]);
};

(async () => {
  console.log("=== BUG#33: nộp đúng thứ tự [prompt, answer] ===");
  reset();
  let r = await api.autoMatch(PAIRS, "run1");
  check("ghép đủ 6 cặp", r.done, 6);
  check("không sai lượt nào", game.wrongPick, 0);
  check("count còn 0", game.count, 0);
  // Ván kết thúc ở đây là kết thúc BÌNH THƯỜNG (count về 0 → endGame), không
  // phải do hết ngân sách sai — phân biệt bằng wrongPick.
  check("kết thúc do hết thẻ, không do sai", game.isEndGame && game.wrongPick === 0, true);

  console.log("\n=== BUG#34: API trả ngược [answer, prompt] — guard tự đảo lại ===");
  reset();
  // dataAnswer bất đối xứng (chỉ thẻ prompt có content) nên autoMatch tự phát
  // hiện pairs[i][0] không có content và đảo lại → vẫn phải ghép đủ.
  const reversed = PAIRS.map(([p, a]) => [a, p]);
  const rr = await api.autoMatch(reversed, "rev");
  check("đảo ngược: ghép đủ 6 cặp", rr.done, 6);
  check("đảo ngược: không sai lượt nào", game.wrongPick, 0);

  console.log("\n=== BUG#33: chạy lại thì bỏ qua cặp đã ghép ===");
  reset();
  await api.autoMatch(PAIRS.slice(0, 3), "first");   // ghép 3 cặp đầu
  check("lượt 1: không sai", game.wrongPick, 0);
  const clicksBefore = game._clicks.length;
  const r2 = await api.autoMatch(PAIRS, "second");   // chạy lại TOÀN BỘ
  check("lượt 2: chỉ click 3 cặp còn lại", game._clicks.length - clicksBefore, 6);
  check("lượt 2: vẫn không sai", game.wrongPick, 0);
  // done đếm CẢ cặp bỏ qua (đã ghép) lẫn cặp ghép mới → đủ 6.
  check("lượt 2: tính đủ 6 cặp", r2.done, 6);

  console.log("\n=== BUG#33: DỪNG trước khi chạm ngân sách sai ===");
  reset();
  game.wrongPick = 3;              // ngân sách = floor(0.3*12) = 3 → đã chạm
  const r3 = await api.autoMatch(PAIRS, "budget");
  check("dừng ngay, không click", game._clicks.length, 0);
  check("báo skipped", r3.skipped, PAIRS.length);
  check("ván vẫn sống", game.isEndGame, false);

  console.log("\n=== BUG#33: ngân sách sai = 30% tổng điểm (12 thẻ) ===");
  reset();
  const perCard = 60 / 12;
  check("3 lần sai chưa kết thúc", 3 * perCard > 0.3 * 60, false);
  check("4 lần sai kết thúc", 4 * perCard > 0.3 * 60, true);

  // ------------------------------------------------------------------ BUG#34
  // Vòng ghép CHỮ ↔ ẢNH (live 22/09/2026, Vòng 3 lớp 11): prompt là từ/phiên âm,
  // answer là URL ảnh. deriveMatchPairsFromGameApi cũ lọc sạch mọi cặp có ảnh.
  console.log("\n=== BUG#34: ghép chữ ↔ ảnh ===");
  const IMG_PAIRS = [
    ["detective", "https://cdn.example/detective.jpg"],
    ["carriage", "https://cdn.example/carriage.jpg"],
    ["/ˈɜː.bən ˈsen.tər/", "https://cdn.example/tl-v3-1.jpg"],
    ["alley", "https://cdn.example/alley.jpg"],
    ["butcher", "https://cdn.example/butcher.jpg"],
    ["/ˈruːf ˌɡɑː.dən/", "https://cdn.example/tl-v3-2.jpg"],
  ];
  game = new FakeGame(IMG_PAIRS, 60);
  scene.children[0].children[0] = game.ctnCross;
  scene.children[0].children[1] = game.mask;
  scene.children[1] = new Node("quest_game12", [new Sprite(), game]);
  const ri = await api.autoMatch(IMG_PAIRS, "img");
  check("ảnh: ghép đủ 6 cặp", ri.done, 6);
  check("ảnh: không sai lượt nào", game.wrongPick, 0);

  console.log("\n=== BUG#34: API trả NGƯỢC (ảnh trước, chữ sau) vẫn ghép đúng ===");
  game = new FakeGame(IMG_PAIRS, 60);
  scene.children[0].children[0] = game.ctnCross;
  scene.children[0].children[1] = game.mask;
  scene.children[1] = new Node("quest_game12", [new Sprite(), game]);
  const revImg = IMG_PAIRS.map(([t, u]) => [u, t]);
  const rri = await api.autoMatch(revImg, "imgrev");
  check("ảnh ngược: ghép đủ 6 cặp", rri.done, 6);
  check("ảnh ngược: không sai lượt nào", game.wrongPick, 0);

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
