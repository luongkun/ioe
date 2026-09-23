/**
 * English Master AI - IOE Game API Bridge v1.0
 * Runs in the page's MAIN world (manifest content_scripts "world": "MAIN").
 *
 * IOE games are Cocos Creator apps that fetch the exam from:
 *   POST https://api-edu.go.vn/ioe-service/v2/game/getinfo
 *   POST https://api-edu.go.vn/ioe-service/v2/game/startgame
 *   POST https://api-edu.go.vn/ioe-service/v2/game/AnswerCheck
 *
 * This bridge hooks fetch/XHR, captures those responses, normalises the exam
 * data (questions, audio URLs and — when provided — answers) and forwards it
 * to the isolated content script via window.postMessage.
 *
 * Exposes nothing else on the page except window.__IOE_GAME_BRIDGE__ (read-only).
 */

(function () {
  if (window.__IOE_GAME_BRIDGE__) return;

  const API_MARK = "/ioe-service/v2/game/";
  const state = {
    examKey: null,
    totalPoint: 0,
    gameDesc: "",
    examTime: 0,
    questions: [],
    answerPool: [],
    lastAnswerCheck: null,
    startTime: 0,
    ready: false,
    updatedAt: 0
  };

  function isAudioUrl(s) {
    return typeof s === "string" && /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(s);
  }

  function clean(s) {
    return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  }

  // Detect masked words in a prompt: "sup***** to eat" → { masked: true, stars: 5 }
  // The star count encodes the number of hidden characters — a strong hint for AI.
  function maskInfo(text) {
    const m = String(text || "").match(/(\w*)\*{3,}/);
    if (m) return { masked: true, prefix: m[1] || "", stars: m[0].replace(/^\w*/, "").length };
    const u = String(text || "").match(/_{3,}/);
    if (u) return { masked: true, prefix: "", stars: u[0].length };
    return { masked: false, prefix: "", stars: 0 };
  }

  function normalizeGetInfo(json) {
    const g = json && json.data && json.data.game;
    if (!g) {
      // Token single-use / hết hạn: API trả lỗi quyền truy cập → báo cho user
      // biết phải tải lại trang thay vì đứng im không có gì (BUG#8).
      const errMsg = (json && (json.message || (json.data && json.data.message))) || "";
      return { error: true, message: String(errMsg) };
    }
    const qs = Array.isArray(g.question) ? g.question : [];
    const questions = qs.map((q, idx) => {
      const desc = q.Description || {};
      const content = q.content || {};
      const descContent = clean(desc.content);
      const prompt = clean(content.content);
      let audio = null;
      if (desc.dataType === 2 || isAudioUrl(descContent)) audio = descContent;
      else if (isAudioUrl(prompt)) audio = prompt;

      const answers = (Array.isArray(q.ans) ? q.ans : [])
        .map(a => clean(a && a.content)).filter(Boolean);
      const tans = (Array.isArray(q.tans) ? q.tans : [])
        .map(a => clean(a && (a.content || a.ans || a))).filter(Boolean);

      const mask = maskInfo(prompt || descContent);
      return {
        index: idx + 1,
        id: q.id,
        point: q.Point,
        type: q.type,
        format: q.exerciseFormat,
        prompt: prompt || descContent || "",
        audio,
        answers,
        tans,
        masked: mask.masked,
        maskPrefix: mask.prefix,
        maskStars: mask.stars,
        isListening: !!audio
      };
    });

    const answerPool = (Array.isArray(g.ans) ? g.ans : [])
      .map(a => clean(a && (a.ans || a.content))).filter(Boolean);

    state.examKey = g.examKey || state.examKey;
    state.totalPoint = g.totalPoint || 0;
    state.gameDesc = clean(json.data.gameDesc || "");
    state.examTime = json.data.examTime || 0;
    state.questions = questions;
    state.answerPool = answerPool;
    state.ready = true;
    state.updatedAt = Date.now();
    return state;
  }

  function emit(type, extra) {
    try {
      window.postMessage({
        __ioeBridge: true,
        type: type,
        payload: {
          examKey: state.examKey,
          totalPoint: state.totalPoint,
          gameDesc: state.gameDesc,
          examTime: state.examTime,
          questions: state.questions,
          answerPool: state.answerPool,
          lastAnswerCheck: state.lastAnswerCheck,
          startTime: state.startTime
        },
        extra: extra || null
      }, window.location.origin);
    } catch (e) {}
  }

  function handleBody(url, text) {
    if (!url || typeof url !== "string") return;
    if (url.indexOf(API_MARK) === -1) return;
    let json;
    try { json = JSON.parse(text); } catch (e) { return; }

    if (/\/getinfo/i.test(url)) {
      const norm = normalizeGetInfo(json);
      if (norm && norm.error) {
        console.warn("[IOE Bridge] getinfo lỗi: " + norm.message);
        emit("GETINFO_ERROR", { message: norm.message });
      } else if (norm) {
        console.log("%c[IOE Bridge] getinfo captured — " + state.questions.length + " questions", "color:#10b981;font-weight:bold");
        emit("GETINFO");
      }
    } else if (/\/startgame/i.test(url)) {
      state.startTime = Date.now();
      emit("STARTGAME", json && json.data);
    } else if (/\/AnswerCheck/i.test(url)) {
      state.lastAnswerCheck = json;
      emit("ANSWERCHECK", json);
    } else if (/\/finishGame/i.test(url)) {
      emit("FINISHGAME", json);
    }
  }

  // ---------- Hook fetch ----------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      const p = origFetch.apply(this, arguments);
      if (url && url.indexOf(API_MARK) !== -1) {
        p.then(res => {
          try { res.clone().text().then(t => handleBody(url, t)).catch(() => {}); } catch (e) {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // ---------- Hook XMLHttpRequest ----------
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ioeUrl = url;
    return OrigOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__ioeUrl || "";
    if (url && url.indexOf(API_MARK) !== -1) {
      this.addEventListener("load", () => {
        try { handleBody(url, this.responseText); } catch (e) {}
      });
    }
    return OrigSend.apply(this, arguments);
  };

  // ---------- Cocos Creator scene inspection ----------
  function getCC() {
    return window.cc || window.CocosEngine || null;
  }

  function getMainCamera() {
    const cc = getCC();
    if (!cc) return null;
    try {
      if (cc.Camera && cc.Camera.main) return cc.Camera.main;
      if (cc.Camera && cc.Camera.cameras && cc.Camera.cameras.length) return cc.Camera.cameras[0];
      if (cc.director && cc.director.getScene) {
        const scene = cc.director.getScene();
        if (scene && scene.getComponentsInChildren) {
          const cams = scene.getComponentsInChildren(cc.Camera);
          if (cams && cams.length) return cams[0];
        }
        if (scene && cc.find) {
          const cam = cc.find("Canvas/Camera", scene) || cc.find("Camera", scene);
          if (cam && cam.getComponent) { const c = cam.getComponent(cc.Camera); if (c) return c; }
        }
      }
    } catch (e) {}
    return null;
  }

  function nodeWorld(node) {
    const cc = getCC();
    if (!node) return { x: 0, y: 0 };
    // Cocos 3.x: getWorldPosition là API chuẩn. PHẢI thử TRƯỚC vì
    // convertToWorldSpaceAR (API 2.x) không tồn tại trên Node 3.x và
    // parent-sum cho toạ độ SAI khi parent có scale/anchor (live-caught:
    // nút OK của thanh-pho-xanh lệch 130px → click trượt hoàn toàn).
    try {
      if (typeof node.getWorldPosition === "function") {
        const wp = node.getWorldPosition();
        if (wp && typeof wp.x === "number" && (wp.x !== 0 || wp.y !== 0)) return { x: wp.x, y: wp.y };
      }
    } catch (e) {}
    // Cocos 2.x: convertToWorldSpaceAR
    try {
      if (node.convertToWorldSpaceAR && cc && cc.v2) {
        const v = node.convertToWorldSpaceAR(cc.v2(0, 0));
        if (v && typeof v.x === "number") return { x: v.x, y: v.y };
      }
    } catch (e) {}
    // Fallback: sum local positions up the chain
    let x = 0, y = 0, p = node, guard = 0;
    while (p && guard < 100) {
      x += p.x || 0; y += p.y || 0; p = p.parent; guard++;
    }
    return { x, y };
  }

  // Click bằng TouchEvent (một số game Cocos 2.x — vd hanh-tinh-tim —
  // CHỈ xử lý touch, mouse event bị bỏ qua hoàn toàn; live-caught 16/09/2026).
  function fireTouch(el, type, x, y) {
    try {
      const opts = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: (window.screenX || 0) + x, screenY: (window.screenY || 0) + y
      };
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, radiusX: 2, radiusY: 2, rotationAngle: 0, force: 1 });
      el.dispatchEvent(new TouchEvent(type, Object.assign(opts, {
        touches: type === "touchend" ? [] : [t],
        targetTouches: type === "touchend" ? [] : [t],
        changedTouches: [t]
      })));
      return true;
    } catch (e) { return false; }
  }

  function getCanvas() {
    return document.getElementById("GameCanvas") || document.querySelector("canvas");
  }

  function designToClient(world) {
    const cc = getCC();
    let visibleW = 1, visibleH = 1;
    try {
      const vs = cc && cc.view && cc.view.getVisibleSize();
      if (vs) { visibleW = vs.width || 1; visibleH = vs.height || 1; }
    } catch (e) {}
    const cv = getCanvas();
    if (!cv) return { x: 0, y: 0, ok: false };
    const rect = cv.getBoundingClientRect();
    const sx = rect.width / visibleW;
    const sy = rect.height / visibleH;
    const cx = rect.left + world.x * sx;
    const cy = rect.top + (rect.height - world.y * sy);
    return { x: cx, y: cy, ok: true };
  }

  function fireMouse(el, type, x, y) {
    const screenX = (window.screenX || 0) + x;
    const screenY = (window.screenY || 0) + y;
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
      clientX: x, clientY: y, screenX: screenX, screenY: screenY,
      button: 0, buttons: type === "mousedown" ? 1 : 0, which: 1
    };
    el.dispatchEvent(new MouseEvent(type, opts));
  }

  function domClickAt(x, y) {
    const cv = getCanvas();
    if (!cv) return false;
    // BUG#31 (engine Cocos 2.0.0 alpha — ghep-cap/an-khe-tra-vang, 17/09/2026):
    // engine cũ bỏ qua HOÀN TOÀN synthetic DOM events (live-verify: 0 event).
    // Với engine < 2.4 → click TRUSTED qua chrome.debugger (CDP Input) —
    // content script chuyển tiếp sang service worker (xem __ioeTrustedClick).
    // FIRE-AND-FORGET: không đợi reply (đợi đồng bộ sẽ đóng băng event loop →
    // reply không bao giờ tới). Synthetic KHÔNG fire cho engine cũ (vô dụng
    // và có thể gây double-click nếu engine bất ngờ nhận cả hai).
    try {
      const cc = getCC();
      const ver = cc && cc.ENGINE_VERSION ? String(cc.ENGINE_VERSION) : "";
      const m = ver.match(/(\d+)\.(\d+)/);
      const old = m && (parseInt(m[1], 10) < 2 || (parseInt(m[1], 10) === 2 && parseInt(m[2], 10) < 4));
      if (old) {
        window.postMessage({ __ioeTrustedClick: true, reqId: "tc_" + Date.now() + "_" + Math.floor(Math.random() * 1e6), x: x, y: y }, window.location.origin);
        return true;
      }
    } catch (e) {}
    try {
      // Touch trước (game Cocos 2.x chỉ nghe touch), mouse sau (game 3.x nghe cả hai;
      // fire kép không hại vì engine tự khử trùng theo pointerId/type).
      fireTouch(cv, "touchstart", x, y);
      fireTouch(cv, "touchend", x, y);
      fireMouse(cv, "mousemove", x, y);
      fireMouse(cv, "mousedown", x, y);
      fireMouse(cv, "mouseup", x, y);
      fireMouse(cv, "click", x, y);
      return true;
    } catch (e) { return false; }
  }



  // Click a Cocos node THE RELIABLE WAY — validated live on ioe.vn games:
  // 1) DOM MouseEvents at the node's screen position: the real Cocos canvas
  //    listens to them (matching-pair clicks scored 40/60 in a live round).
  // 2) Engine-level emit("click") only as a fallback when no canvas/position
  //    is available — avoids double-firing handlers on nodes that listen both ways.
  function clickNode(node) {
    if (!node) return false;
    const world = nodeWorld(node);
    const pt = designToClient(world);
    if (pt.ok) return domClickAt(pt.x, pt.y);
    try { node.emit("click"); return true; } catch (e) { return false; }
  }

  // BUG#35: click CDP là chuột THẬT → bị hit-test. Nếu một phần tử HTML của
  // extension (bảng điều khiển) phủ lên toạ độ thẻ thì click bị nuốt và bot
  // đứng im không lỗi. Trả về tên phần tử đang phủ (null nếu thẻ nằm trên
  // canvas) để autoMatch báo cáo đúng thay vì lặng lẽ hết thời gian chờ.
  function occluderAt(node) {
    try {
      const world = nodeWorld(node);
      const pt = designToClient(world);
      if (!pt.ok) return null;
      const el = document.elementFromPoint(pt.x, pt.y);
      if (!el) return null;
      const cv = getCanvas();
      if (cv && (el === cv || cv.contains(el))) return null;
      const id = el.id ? "#" + el.id : "";
      const cls = el.className ? "." + String(el.className).split(/\s+/)[0] : "";
      return (el.tagName || "?") + id + cls;
    } catch (e) { return null; }
  }

  // Strip Cocos RichText markup: "<color=#000000>The achievements of vaccines.</color>"
  // → "The achievements of vaccines." (BUG#32: option text lives in RichText, so
  // the raw markup never matched the answer text from the game API).
  function stripRichText(s) {
    return String(s || "")
      .replace(/<[^>]*>/g, "")   // <color=...>, </color>, <b>, <br> ...
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }

  function labelOf(node) {
    const cc = getCC();
    if (!node || !node.getComponent) return null;
    // 1. cc.Label (the common case)
    try {
      const l = cc.Label && node.getComponent(cc.Label);
      if (l && typeof l.string === "string" && l.string.trim()) return l.string.replace(/\s+/g, " ").trim();
    } catch (e) {}
    // 2. cc.RichText / RichText — markup must be stripped before comparison
    try {
      const names = ["RichText", "LabelOutline", "LabelShadow"];
      for (const nm of names) {
        const Cls = cc[nm];
        if (!Cls) continue;
        const c = node.getComponent(Cls);
        const raw = c && (typeof c.string === "string" ? c.string : (typeof c.text === "string" ? c.text : ""));
        if (raw && String(raw).trim()) {
          const plain = stripRichText(raw);
          if (plain) return plain;
        }
      }
    } catch (e) {}
    // 3. Any component exposing a non-empty `string`/`text` (custom renderers)
    try {
      for (const c of (node._components || [])) {
        if (!c) continue;
        const raw = (typeof c.string === "string" && c.string) || (typeof c.text === "string" && c.text) || "";
        if (raw && String(raw).trim()) {
          const plain = stripRichText(raw);
          if (plain) return plain;
        }
      }
    } catch (e) {}
    return null;
  }

  // Return the displayed text of a node: own label, else the first descendant
  // that carries text — searched to ANY depth (BUG#32: the answer text sits in
  // aScrollView/<scroll content>/<RichText>, i.e. deeper than the old 2 levels).
  function nodeText(node, maxDepth) {
    if (!node) return null;
    const limit = typeof maxDepth === "number" ? maxDepth : 6;
    const own = labelOf(node);
    if (own) return own;
    let best = null;
    const walk = (n, depth) => {
      if (!n || depth > limit || best) return;
      for (const c of (n.children || [])) {
        const t = labelOf(c);
        if (t) { best = t; return; }
        walk(c, depth + 1);
        if (best) return;
      }
    };
    walk(node, 1);
    return best;
  }

  function allNodes() {
    const cc = getCC();
    const out = [];
    if (!cc || !cc.director || !cc.director.getScene) return out;
    let scene;
    try { scene = cc.director.getScene(); } catch (e) { return out; }
    (function walk(n) {
      if (!n) return;
      out.push(n);
      const kids = n.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(scene);
    return out;
  }

  // BUG#32 (an-khe-tra-vang, 22/09/2026): nhieu game khai bao nut bang COMPONENT
  // TU DINH NGHIA (vd `AnswerButton`) chu khong dung cc.Button — isButton() cu
  // tra false nen findNodeByText bo qua toan bo dap an. Nhan them component co
  // ten/hanh vi giong nut.
  const CUSTOM_BTN_RE = /(button|btn|toggle|clickable|pressable)/i;
  function isButton(node) {
    const cc = getCC();
    try {
      if (cc.Button && node.getComponent && node.getComponent(cc.Button)) return true;
    } catch (e) {}
    // Custom component whose class name looks like a button. Doc TEN CLASS tu
    // constructor (khong dung `__classname__` — minified co the la "CCClass").
    try {
      const comps = node._components || [];
      for (const c of comps) {
        if (!c) continue;
        const n = (c.constructor && c.constructor.name) || c.__classname__ || "";
        if (CUSTOM_BTN_RE.test(n)) return true;
      }
    } catch (e) {}
    return false;
  }

  function normText(s) {
    return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function findNodeByText(text, opts) {
    const target = normText(text);
    if (!target) return null;
    const contains = !!(opts && opts.contains);
    const cands = allNodes().filter(n => n && n.activeInHierarchy !== false);

    // 1. Buttons with exact text (preferred — answer options are usually Buttons)
    for (const n of cands) {
      if (!isButton(n)) continue;
      const t = normText(nodeText(n));
      if (t && t === target) return n;
    }
    // 2. Any active node with exact label text (some options are plain sprites
    //    with a Label child and no Button component — still clickable at that position)
    for (const n of cands) {
      const t = normText(nodeText(n));
      if (t && t === target) return n;
    }
    if (contains) {
      // 3. Buttons containing the text
      for (const n of cands) {
        if (!isButton(n)) continue;
        const t = normText(nodeText(n));
        if (t && target.length >= 3 && (t.includes(target) || target.includes(t))) return n;
      }
      // 4. Any node containing the text (last resort — may match the prompt
      //    label, which is why it runs after every button-based pass above)
      for (const n of cands) {
        const t = normText(nodeText(n));
        if (t && target.length >= 3 && (t.includes(target) || target.includes(t))) return n;
      }
    }
    return null;
  }

  function findNodeByName(name) {
    if (!name) return null;
    for (const n of allNodes()) {
      if (n && n.activeInHierarchy !== false && n.name === name) return n;
    }
    return null;
  }

  // Case-insensitive name lookup (BUG#32: the same game names its option buttons
  // btnA/btnB/btnC but `btnd` — lowercase d — so an exact-match ladder misses D).
  function findNodeByNameCI(name) {
    if (!name) return null;
    const want = String(name).toLowerCase();
    for (const n of allNodes()) {
      if (n && n.activeInHierarchy !== false && String(n.name).toLowerCase() === want) return n;
    }
    return null;
  }

  // BUG#32 (an-khe-tra-vang, Cocos 2.0.0 alpha): in some games the option TEXT and
  // the CLICKABLE button are SIBLINGS inside one card, not ancestor/descendant:
  //
  //   answer_a/                    <- card (cc.Sprite + AnswerButton? no, plain)
  //     aScrollView/
  //       a_content_no_scroll-001  <- RichText "The reasons why…"   (the TEXT)
  //       btnA                     <- cc.Sprite + AnswerButton, NO label  (the CLICK)
  //     icon_A/
  //
  // So findNodeByText found the RichText node but that node is NOT clickable, and
  // nodeText(btnA) was null so the button never matched. Resolve by walking UP
  // from the text node to the card, then searching the card subtree for a
  // clickable node and returning THAT.
  function resolveClickableInCard(textNode) {
    if (!textNode) return null;
    let card = textNode;
    for (let up = 0; up < 3 && card; up++) {
      // Prefer a clickable node inside the card, closest to the card root.
      const found = findClickableInSubtree(card, 4);
      if (found) return found;
      card = card.parent;
    }
    return null;
  }

  function findClickableInSubtree(root, maxDepth) {
    if (!root) return null;
    const queue = [{ n: root, d: 0 }];
    while (queue.length) {
      const { n, d } = queue.shift();
      if (!n) continue;
      if (isButton(n) && n !== root && n.activeInHierarchy !== false) return n;
      if (d >= maxDepth) continue;
      for (const c of (n.children || [])) queue.push({ n: c, d: d + 1 });
    }
    return null;
  }

  // Resolve answer text → the node to CLICK, handling both layouts:
  //   (a) text is inside the clickable node (classic)  → return that node
  //   (b) text and button are siblings in a card       → return the sibling button
  function findClickTargetByText(text, opts) {
    const contains = !!(opts && opts.contains);
    const target = normText(text);
    if (!target) return null;
    const cands = allNodes().filter(n => n && n.activeInHierarchy !== false);

    // (a) classic: a clickable node whose own/descendant text matches
    const direct = findNodeByText(text, opts);
    if (direct) {
      if (isButton(direct)) return direct;
      // the text node itself is not clickable → try its card's button
      const sib = resolveClickableInCard(direct);
      if (sib) return sib;
      return direct; // fall back to clicking the text position (still a valid point)
    }
    // (b) sibling layout: find the text node, then the button in the same card
    for (const n of cands) {
      if (isButton(n)) continue; // buttons rarely carry the text in this layout
      const t = normText(nodeText(n));
      if (!t) continue;
      const hit = contains ? (target.length >= 3 && (t.includes(target) || target.includes(t))) : (t === target);
      if (!hit) continue;
      const btn = resolveClickableInCard(n);
      if (btn) return btn;
    }
    return null;
  }

  // ALL nodes matching a text (duplicates happen: a Q-card and an A-card can
  // carry the SAME text, e.g. "How do you do?" ↔ "How do you do?").
  function findAllNodesByText(text) {
    const target = normText(text);
    if (!target) return [];
    const cands = allNodes().filter(n => n && n.activeInHierarchy !== false);
    const exactButtons = [], exactAny = [], containsAny = [];
    for (const n of cands) {
      const t = normText(nodeText(n));
      if (!t) continue;
      if (t === target) (isButton(n) ? exactButtons : exactAny).push(n);
      else if (target.length >= 3 && (t.includes(target) || target.includes(t))) containsAny.push(n);
    }
    const out = exactButtons.concat(exactAny);
    if (!out.length) return containsAny;
    return out;
  }

  async function startGame() {
    let closed = 0, started = 0;
    // 0. BUG#27 (live 17/09/2026, ang-noi): popup cảnh báo "Checking device"
    //    (nút OK tên lạ) chặn toàn bộ input trên màn hướng dẫn — dismiss theo
    //    dim-layer TRƯỚC (bất kể tên nút), rồi mới đến các bước theo tên.
    try { closed += dismissSystemPopups(); } catch (e) {}
    // 1. Close intro/warning popups — the real games show a system-requirements
    //    dialog whose button is named btnOK (plus btn_close variants).
    //    btn_dongy / btn_OK: biến thể mới gặp ở thanh-pho-xanh & cuon-giay-bi-an
    //    (16/09/2026) — nút "đồng ý/OK" không có cc.Button component nên phải
    //    click bằng toạ độ (clickNode) thay vì chỉ emit("click").
    //    nameOK (17/09/2026, ang-noi): popup action đặt tên kiểu nameContinue/
    //    nameSubmit → biến thể nameOK.
    const closedNames = ["btn_close", "btnClose", "btnOK", "ok_btn", "btn_ok", "btnOkay", "btn_dongy", "btn_OK", "nameOK", "ok"];
    for (const nm of closedNames) {
      let n = null;
      try { n = findNodeByName(nm); } catch (e) {}
      if (n) {
        try { n.emit("click"); closed++; } catch (e) {}
        // emit không đủ cho nút không có Button component → click toạ độ DOM
        await sleep(250);
        try { clickNode(n); closed++; } catch (e) {}
      }
    }
    // Also close any active button whose label is exactly "OK" / "Đồng ý" / "START"
    for (const lbl of ["ok", "đồng ý", "start"]) {
      const okLabel = findNodeByText(lbl, { contains: false });
      if (okLabel) { try { clickNode(okLabel); closed++; } catch (e) {} }
    }
    // Give the scene a beat to settle after closing the popup BEFORE pressing
    // start — pressing both in the same tick loses the start press (the scene
    // is still switching) and the round dies instantly with "Total Time 00:00".
    await sleep(900);
    // 2. Start the game — click toạ độ + emit (một số game cần touch thật).
    //    NEVER touch GAME_PLAY / play / start: those are full-screen containers whose
    //    center overlaps an answer card → would select an option before solving!
    let n = null;
    try { n = findNodeByName("start_btn"); } catch (e) {}
    if (n) {
      try { n.emit("click"); started++; } catch (e) {}
      await sleep(250);
      try { clickNode(n); started++; } catch (e) {}
    }
    // 2b. Một số game (thanh-pho-xanh) TÁI DÙNG node btn_dongy làm nút START —
    //     nếu vẫn chưa start và btn_dongy đang active, click nó lần nữa.
    if (started === 0) {
      let d = null;
      try { d = findNodeByName("btn_dongy"); } catch (e) {}
      if (d) { try { clickNode(d); started++; } catch (e) {} }
    }
    // 2c. BUG#27 (ang-noi): nút start TÊN KHÁC (không phải start_btn/btn_dongy).
    //     Fallback GENERIC: mọi nút button đang active có tên/text giống
    //     start/play/begin/bắt đầu → click cái NHỎ NHẤT trước (tránh container
    //     full-screen — click giữa container có thể trúng thẻ đáp án).
    if (started === 0) {
      try {
        const cands = [];
        for (const n of allNodes()) {
          if (!n || n.activeInHierarchy === false || !isButton(n)) continue;
          const nm = String(n.name || "");
          const txt = String(nodeText(n) || "").trim();
          const startish = /^(start|play|begin|bat dau|bắt đầu)$/i.test(txt) || /^(btn[_-]?)?(start|play|begin)/i.test(nm) || /^name(start|play)$/i.test(nm);
          if (!startish) continue;
          const w = n.width || 0;
          if (w > 0 && w < 700) cands.push(n); // bỏ qua container full-screen
        }
        if (cands.length) {
          const n = cands.sort((a, b) => (a.width || 0) - (b.width || 0))[0];
          try { n.emit("click"); started++; } catch (e) {}
          await sleep(250);
          try { clickNode(n); started++; } catch (e) {}
        }
      } catch (e) {}
    }
    // 3. The Windows-10 upgrade notice pops up a beat AFTER the start press —
    //    dismiss it right away or it swallows the first question's inputs.
    await sleep(1500);
    const dismissed = dismissSystemPopups();
    return { closed, started, dismissed, scene: (getCC() && getCC().director ? (getCC().director.getScene() || {}).name : null) };
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Wait for a node (by text) to actually appear & be clickable — the real
  // games take ~1-2s to make the cards interactive after the start animation.
  async function waitForNodeByText(text, timeoutMs = 8000, excludeNode = null) {
    const t0 = Date.now();
    let node = pickTextNode(text, excludeNode);
    while (!node && Date.now() - t0 < timeoutMs) {
      await sleep(300);
      node = pickTextNode(text, excludeNode);
    }
    return node;
  }

  // Find a text node, preferring one DIFFERENT from excludeNode (duplicate-text
  // cards: clicking the same card twice toggles it off and the pair never matches).
  function pickTextNode(text, excludeNode) {
    const all = findAllNodesByText(text);
    if (!all.length) return null;
    if (excludeNode && all.length > 1) {
      const other = all.find(n => n !== excludeNode);
      if (other) return other;
    }
    return all[0];
  }

  // ---------- BUG#33 (live 22/09/2026, ghep-cap — "Bài thi số 3", 6 cặp / 12 thẻ) ----------
  // Vòng trước chỉ được 10/60 rồi POPUP_ENDGAME giữa chừng. Đọc thẳng mã nguồn
  // game (assets/resources/index.*.js → class Game12 + GamePlay) thay vì dò mù:
  //   * Game12.onHandlerChooseAnswerCross: click 1 = CHỌN (selectCross1);
  //     click 2 vào thẻ KHÁC = NỘP CẶP → rootGame.submit(...) và bật mask.active
  //     (chặn click toàn màn hình) cho tới khi server trả lời.
  //   * GamePlay.submit: ăn khi content(thẻ1) là prompt và answearArr[0] là
  //     content(thẻ2) → cặp phải nộp ĐÚNG THỨ TỰ [prompt, answer].
  //   * GamePlay.failAnswer: SAI KHÔNG kết thúc ngay — chỉ endGame khi
  //     wrongPick * (totalPoint / tổng số thẻ) > 0.3 * totalPoint. Với 12 thẻ
  //     (60 điểm) là 4 lần sai. Các click dò của vòng trước đốt hết ngân sách
  //     sai nên ván tự kết thúc — không phải lỗi cơ chế ghép cặp.
  //   * Game12.continue(e): chỉ khi e=true (server xác nhận ăn) mới đặt
  //     Button.interactable=false cho 2 thẻ vừa ghép → đó là dấu hiệu "đã ghép"
  //     đáng tin để bỏ qua ở lượt chạy lại.
  // ⇒ autoMatch giờ chạy theo STATE của game: chờ mask tắt trước mỗi click,
  //   không click thẻ đã ghép/đang chọn, nộp đúng thứ tự [prompt, answer], đọc
  //   kết quả thật sau mỗi cặp, và DỪNG trước khi chạm ngân sách sai.
  function findGame12Controller() {
    const cc = getCC();
    if (!cc || !cc.Component) return null;
    for (const n of allNodes()) {
      if (!n || n.activeInHierarchy === false) continue;
      try {
        const comps = n.getComponents ? n.getComponents(cc.Component) : [];
        for (const c of comps) {
          if (c && typeof c.onHandlerChooseAnswerCross === "function") return c;
        }
      } catch (e) {}
    }
    return null;
  }

  // Một click qua CDP là fire-and-forget, nên "click có ăn không?" chỉ trả lời
  // được bằng cách đọc lại chính state của game.
  function readMatchCard(card) {
    if (!card || card.isValid === false) return null;
    const cc = getCC();
    let text = null;
    try { text = labelOf(card); } catch (e) {}
    let sel = false;
    try {
      const a = card.getChildByName && card.getChildByName("active");
      sel = !!(a && a.activeInHierarchy !== false);
    } catch (e) {}
    let interactable = true;
    try {
      const b = cc && cc.Button && card.getComponent && card.getComponent(cc.Button);
      if (b) interactable = b.interactable !== false;
    } catch (e) {}
    // BUG#34: thẻ ẢNH (ghép chữ↔ảnh) KHÔNG có cc.Label — Game12 ẩn node "txt"
    // và bật "image", nên chỉ còn `dataAnswer` để nhận diện. Đọc thẳng đúng hai
    // trường mà GamePlay.submit so sánh: content.content và ans.
    let dataAnswer = null;
    try { dataAnswer = card.dataAnswer || null; } catch (e) {}
    let content = null, ans = null;
    try { content = dataAnswer && dataAnswer.content ? (dataAnswer.content.content || null) : null; } catch (e) {}
    try { ans = dataAnswer && dataAnswer.ans ? dataAnswer.ans : null; } catch (e) {}
    // Ảnh: node con "image" đang bật (Game12 tắt "txt" cho thẻ ảnh).
    let isImage = false;
    try {
      const img = card.getChildByName && card.getChildByName("image");
      if (img && img.activeInHierarchy !== false) isImage = true;
      const t = card.getChildByName && card.getChildByName("txt");
      if (t && t.activeInHierarchy === false) isImage = true;
    } catch (e) {}
    if (typeof ans === "string" && /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(ans)) isImage = true;
    return { node: card, text, sel, interactable, dataAnswer, content, ans, isImage };
  }

  function matchState() {
    const g = findGame12Controller();
    if (!g) return null;
    const kids = (g.ctnCross && g.ctnCross.children) || [];
    const cards = [];
    for (const k of kids) { const c = readMatchCard(k); if (c) cards.push(c); }
    return {
      controller: g,
      cards,
      sel1: readMatchCard(g.selectCross1),
      maskOn: !!(g.mask && g.mask.activeInHierarchy !== false),
      remaining: (typeof g.count === "number") ? g.count : null,
      wrongPick: (typeof g.wrongPick === "number") ? g.wrongPick : 0,
      total: cards.length,
    };
  }

  const normMatchText = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // BUG#34: một thẻ khớp "khoá" nào? Thẻ chữ khớp theo Label; thẻ ảnh khớp
  // theo dataAnswer.ans (URL ảnh). Trả về true/false để dùng cho cả find lẫn
  // phát hiện "đã ghép".
  function cardMatchesKey(c, key) {
    if (!c || key == null) return false;
    const k = String(key);
    if (c.text === k) return true;
    if (c.content === k || c.ans === k) return true;
    if (c.text && normMatchText(c.text) === normMatchText(k)) return true;
    return false;
  }

  // Thẻ theo đúng khoá, KHÔNG lọc trạng thái (dùng để phát hiện "đã ghép").
  function cardByTextAny(text) {
    const st = matchState();
    if (!st) return null;
    return st.cards.find(c => cardMatchesKey(c, text)) || null;
  }

  // Thẻ còn dùng được cho khoá này: chưa ghép (interactable), chưa chọn, không
  // nằm trong danh sách loại trừ.
  function findMatchCard(text, excludeNodes) {
    const st = matchState();
    if (st && st.cards.length) {
      const ex = excludeNodes || [];
      const usable = st.cards.filter(c => c.interactable && !c.sel && ex.indexOf(c.node) < 0);
      const hit = usable.find(c => cardMatchesKey(c, text));
      if (hit) return hit.node;
    }
    return pickTextNode(text, (excludeNodes || [])[0]);
  }

  async function waitMaskClear(timeoutMs = 5000) {
    const t0 = Date.now();
    for (;;) {
      const st = matchState();
      if (!st) return null;
      if (!st.maskOn) return st;
      if (Date.now() - t0 > timeoutMs) return st;
      await sleep(150);
    }
  }

  async function waitForSelection(node, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const st = matchState();
      if (st && st.sel1 && st.sel1.node === node) return true;
      if (Date.now() - t0 > timeoutMs) return false;
      await sleep(150);
    }
  }

  // Server phán cặp vừa nộp: count giảm 2 = ăn; wrongPick tăng = trượt.
  async function waitPairResolved(remainBefore, wrongBefore, timeoutMs) {
    const t0 = Date.now();
    for (;;) {
      const st = matchState();
      if (!st) return { ok: null, st: null };
      if (typeof st.remaining === "number" && typeof remainBefore === "number" && st.remaining <= remainBefore - 2) return { ok: true, st };
      if (st.wrongPick > wrongBefore) return { ok: false, st };
      if (Date.now() - t0 > timeoutMs) return { ok: null, st };
      await sleep(200);
    }
  }

  async function autoMatch(pairs, runId) {
    let matched = 0, failed = 0, skipped = 0;
    const emitProgress = (i, extra) => window.postMessage({
      __ioeBridge: true, type: "MATCH_PROGRESS",
      payload: Object.assign({ runId, pair: pairs[i], index: i, total: pairs.length }, extra || {}),
    }, window.location.origin);

    let wrongBudget = null;

    for (let i = 0; i < pairs.length; i++) {
      // BUG#33b: bọc TỪNG cặp trong try/catch — trước đây một lỗi bất ngờ ở giữa
      // (property chết, node bị huỷ khi ván kết thúc...) ném ra ngoài vòng lặp,
      // autoMatch thoát mà KHÔNG gửi MATCH_DONE ⇒ solver ở isolated world chờ
      // tới hết waitMs rồi mới biết (live: kẹt 4/6 cặp, không rõ cặp nào).
      try {
      let prompt = pairs[i][0], answer = pairs[i][1];

      // BUG#25: modal lỗi hệ thống ("Mạng không ổn định") NUỐT mọi click.
      try { dismissSystemPopups(); } catch (e) {}

      // Cặp đã ăn ở lượt trước? Cả 2 thẻ đều interactable=false ⇒ bỏ qua.
      const pa0 = cardByTextAny(prompt), pb0 = cardByTextAny(answer);
      if (pa0 && pb0 && !pa0.interactable && !pb0.interactable) {
        matched++;
        emitProgress(i, { already: true });
        continue;
      }

      // (a) Chờ game sẵn sàng nhận click (mask tắt = không có submit đang bay).
      let st = await waitMaskClear(5000);
      if (st) {
        if (wrongBudget === null) wrongBudget = Math.floor(0.3 * Math.max(1, st.total));
        // (d) Dừng TRƯỚC khi chạm ngân sách sai — thà thiếu cặp còn hơn kết thúc ván.
        if (st.wrongPick >= wrongBudget) { skipped = pairs.length - i; break; }
      }

      // BUG#34: GamePlay.submit lấy `content` từ thẻ NÀO CÓ content, còn `ans`
      // ưu tiên thẻ A. Ở vòng ghép chữ↔ảnh, thẻ CHỮ có content còn thẻ ẢNH chỉ
      // có ans ⇒ bắt buộc click thẻ chữ TRƯỚC. Tự đảo nếu API trả ngược.
      const ca0 = cardByTextAny(prompt), cb0 = cardByTextAny(answer);
      if (ca0 && cb0 && !ca0.content && cb0.content) {
        prompt = pairs[i][1]; answer = pairs[i][0];
      }

      // (b) Chọn thẻ prompt (thẻ mang `content`).
      let ca = findMatchCard(prompt, []);
      if (!ca) { failed++; emitProgress(i, { okA: false, okB: false, reason: "no_card_a" }); continue; }
      // BUG#35: thẻ bị phần tử HTML của extension phủ lên → click sẽ bị nuốt.
      // Báo rõ thay vì đứng chờ vô ích (đã sửa CSS panel thành pointer-events:none;
      // đây là lưới an toàn nếu có overlay khác của trang/extension chèn vào).
      const occA = occluderAt(ca);
      if (occA) { failed++; emitProgress(i, { okA: false, okB: false, reason: "occluded_a", occluder: occA }); continue; }
      clickNode(ca);
      let selOk = await waitForSelection(ca, 3000);
      if (!selOk) {
        // Click không ăn (popup/animation chen ngang) → dọn rồi thử lại 1 lần.
        try { dismissSystemPopups(); } catch (e) {}
        await waitMaskClear(3000);
        ca = findMatchCard(prompt, []);
        if (ca) { clickNode(ca); selOk = await waitForSelection(ca, 3000); }
      }
      if (!selOk) { failed++; emitProgress(i, { okA: false, okB: false, reason: "sel_a_failed" }); continue; }

      await sleep(getRandom(150, 280));

      // (c) Thẻ answer — KHÁC thẻ vừa chọn, nộp đúng thứ tự [prompt, answer].
      const cb = findMatchCard(answer, [ca]);
      if (!cb) {
        // Nhả thẻ prompt ra rồi bỏ qua cặp này (KHÔNG đốt ngân sách sai).
        try { clickNode(ca); } catch (e) {}
        failed++;
        emitProgress(i, { okA: true, okB: false, reason: "no_card_b" });
        continue;
      }

      const before = matchState() || {};
      const wrongBefore = before.wrongPick || 0;
      const remainBefore = before.remaining;
      clickNode(cb);

      // Chờ submit bay + server phán, rồi đọc kết quả thật của cặp này.
      await sleep(250);
      await waitMaskClear(8000);
      const r = await waitPairResolved(remainBefore, wrongBefore, 6000);
      if (r.ok === false) failed++; else matched++;
      emitProgress(i, {
        okA: true, okB: true, matched: r.ok === true,
        wrongPick: (r.st && r.st.wrongPick) || 0,
      });

      if (r.st && typeof r.st.remaining === "number" && r.st.remaining <= 0) break; // hết thẻ
      // BUG#25: nhịp chậm giữa các cặp — AnswerCheck dồn dập khiến IOE trả "Mạng không ổn định".
      await sleep(getRandom(400, 700));
      } catch (e) {
        // Một cặp lỗi KHÔNG được phép giết cả ván ghép — ghi nhận rồi đi tiếp.
        failed++;
        console.warn("[IOE bridge] autoMatch cặp " + (i + 1) + " lỗi:", e && e.message);
        emitProgress(i, { reason: "exception", error: (e && e.message) || String(e) });
      }
    }

    window.postMessage({ __ioeBridge: true, type: "MATCH_DONE", payload: { runId, done: matched, failed, skipped, total: pairs.length } }, window.location.origin);
    return { done: matched, failed, skipped };
  }

  function getRandom(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function clickSequence(items, runId) {
    let done = 0, failed = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};

      // Wait for the node to actually appear on screen (the game reveals each
      // question one by one — clicking before the current question's options
      // render is a silent no-op). Poll up to 20s per item.
      let node = null;
      const waited = it.waitMs || 20000;
      const t0 = Date.now();
      while (!node && (Date.now() - t0) < waited) {
        if (it.name) node = findNodeByName(it.name);
        if (!node && it.text) node = findNodeByText(it.text, { contains: it.contains !== false });
        if (!node) await sleep(400);
      }

      // Small settle beat so the revealed option is fully interactive
      if (node) await sleep(700);

      if (node) { clickNode(node); done++; } else failed++;
      await sleep(it.delay || getRandom(700, 1100));
      window.postMessage({ __ioeBridge: true, type: "SEQ_PROGRESS", payload: { runId, index: i, total: items.length, ok: !!node } }, window.location.origin);
    }
    window.postMessage({ __ioeBridge: true, type: "SEQ_DONE", payload: { runId, done, failed, total: items.length } }, window.location.origin);
    return { done, failed };
  }

  function listNodes() {
    const out = [];
    for (const n of allNodes()) {
      if (!n) continue;
      if (!isButton(n)) continue;
      if (n.activeInHierarchy === false) continue;
      out.push({ name: n.name, text: nodeText(n) });
    }
    return out;
  }

  // ---------- EditBox typing (BUG#2: listening fill-word games need TYPING, not clicking) ----------
  // Cocos Creator EditBox: set `.string` programmatically + sync the hidden DOM
  // input Cocos creates on web, then fire the component's text-changed event so
  // gameplay code that listens for edits stays consistent.
  function findEditBoxes() {
    const cc = getCC();
    const out = [];
    if (!cc || !cc.EditBox) return out;
    for (const n of allNodes()) {
      if (!n || n.activeInHierarchy === false) continue;
      try {
        const eb = n.getComponent && n.getComponent(cc.EditBox);
        if (eb) out.push({ node: n, name: n.name, editBox: eb, string: eb.string || "" });
      } catch (e) {}
    }
    return out;
  }

  function syncCocosDomInputs(text) {
    // Cocos web builds park one hidden <input>/<textarea> per focused EditBox
    // (usually inside the canvas container). Setting their value + firing input
    // events keeps the engine-side and DOM-side state in sync.
    let touched = 0;
    const cv = getCanvas();
    const root = cv ? (cv.parentElement || document.body) : document.body;
    const domInputs = root.querySelectorAll("input, textarea");
    for (const el of domInputs) {
      try {
        if (el.closest("#ioe-master-root")) continue; // never touch OUR OWN hint input (BUG#6)
        const st = window.getComputedStyle(el);
        const hidden = st.display === "none" || st.visibility === "hidden" || (el.type === "hidden");
        if (!hidden && !(el.offsetWidth === 0 && el.offsetHeight === 0) && el.type !== "file") continue; // only invisible engine inputs
        if (el.readOnly || el.disabled) continue;
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        touched++;
      } catch (e) {}
    }
    return touched;
  }

  // Find the real DOM <input>/<textarea> that Cocos parks for the focused
  // EditBox. Live-validated on tai-tao-san-ho: setting eb.string alone does
  // NOT render the text (game showed "Vui lòng nhập đủ số ký tự" and the box
  // stayed empty) — the game reads/renders the DOM input the engine creates
  // on focus. Typing into THAT input, char by char, is what a real user does.
  function findCocosEditDomInput() {
    // 1. The element the engine just focused (eb.focus() focuses it)
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) {
      try { if (!ae.closest("#ioe-master-root")) return ae; } catch (e) { return ae; }
    }
    // 2. Hidden/zero-size engine inputs in the canvas container
    const cv = getCanvas();
    const roots = [cv ? (cv.parentElement || cv) : null, document.body].filter(Boolean);
    for (const root of roots) {
      const els = root.querySelectorAll("input, textarea");
      for (const el of els) {
        try {
          if (el.closest("#ioe-master-root")) continue;
          if (el.type === "file" || el.disabled || el.readOnly) continue;
          const st = window.getComputedStyle(el);
          const tiny = el.offsetWidth < 4 || el.offsetHeight < 4;
          const invisible = st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0;
          if (tiny || invisible) return el;
        } catch (e) {}
      }
    }
    return null;
  }

  // ============ GAME CONTROLLER (validated live on tai-tao-san-ho) ============
  // The listening fill-word game keeps its answer in TWO places:
  //   ctrl.inputTxt            — updated ONLY via the EditBox text-changed event
  //                              (handler onEditTextChange); used for validation
  //                              ("Vui lòng nhập đủ số ký tự") + submit
  //   dienDoanVan.results[].string — what the game shows/scores per slot
  // Setting eb.string alone renders nothing and validates nothing. The
  // RELIABLE path is calling the controller's own methods directly.
  function findQuestionController() {
    const cc = getCC();
    if (!cc || !cc.Component) return null;
    for (const n of allNodes()) {
      if (!n || n.activeInHierarchy === false) continue;
      try {
        const comps = n.getComponents ? n.getComponents(cc.Component) : [];
        for (const comp of comps) {
          if (comp && typeof comp.onKeyEnterPress === "function" && typeof comp.onEditTextChange === "function") {
            return comp;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  async function typeIntoEditBox(text, index) {
    // Late system dialogs block typing too — clear first.
    const dismissed = dismissSystemPopups();
    const cc = getCC();
    const boxes = findEditBoxes();
    if (!boxes.length) return { ok: false, reason: "no_editbox", boxes: 0, dismissed };
    const idx = Math.max(0, Math.min(index || 0, boxes.length - 1));
    const eb = boxes[idx].editBox;
    const word = String(text || "").trim();
    let typedViaDom = 0;
    let viaController = false;
    let ctrl = null;
    try { ctrl = findQuestionController(); } catch (e) {}

    // --- 0. Render the word in the game's own EditBox (dienDoanVan path). ---
    //     NOTE: ctrl.onEditTextChange(word) is NOT called here — it must run
    //     LAST (see step 3) or later sync events overwrite inputTxt with a
    //     truncated value (live-caused: "forests" → "for" via hook logging).
    try {
      if (ctrl && ctrl.dienDoanVan && ctrl.dienDoanVan.getFirstEditBox) {
        const fe = ctrl.dienDoanVan.getFirstEditBox();
        if (fe) fe.string = word;
      }
    } catch (e) {}
    if (ctrl) viaController = true;

    // --- 1. ALSO click the EditBox like a user + type into the engine's DOM
    //     input (keeps engine-side state consistent on OTHER Cocos games where
    //     the controller pattern does not exist). ---
    try { clickNode(boxes[idx].node); } catch (e) {}
    await sleep(180);
    try {
      if (typeof eb.focus === "function") eb.focus();
    } catch (e) {}
    await sleep(80);
    const dom = findCocosEditDomInput();
    if (dom) {
      try {
        dom.focus();
        dom.value = "";
        for (const ch of word) {
          dom.value += ch;
          try {
            dom.dispatchEvent(new KeyboardEvent("keydown", { key: ch, code: "Key" + ch.toUpperCase(), bubbles: true, cancelable: true }));
            dom.dispatchEvent(new KeyboardEvent("keypress", { key: ch, code: "Key" + ch.toUpperCase(), bubbles: true, cancelable: true }));
          } catch (e) {}
          dom.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(getRandom(30, 85));
        }
        dom.dispatchEvent(new Event("input", { bubbles: true }));
        dom.dispatchEvent(new Event("change", { bubbles: true }));
        try { dom.dispatchEvent(new KeyboardEvent("keyup", { key: word.slice(-1) || "", bubbles: true })); } catch (e) {}
        typedViaDom = (dom.value || "").length;
      } catch (e) {}
    }

    // --- 2. Engine-side sync (idempotent; CC2 & CC3 compatible) ---
    try {
      eb.string = word;
      try {
        const evtName = (cc.EditBox && cc.EditBox.EventType && cc.EditBox.EventType.TEXT_CHANGED) || "text-changed";
        if (eb.node && eb.node.emit) eb.node.emit(evtName, word, eb);
      } catch (e) {}
    } catch (e) {
      return { ok: false, reason: e.message, boxes: boxes.length };
    }
    syncCocosDomInputs(word);

    // --- 3. CONTROLLER LAST (the authoritative write): every earlier engine
    //     event can leave inputTxt truncated (hook-verified live: a trailing
    //     input event from syncCocosDomInputs emitted "for" and clobbered
    //     "forests"). The game validates & submits from ctrl.inputTxt, so the
    //     controller call MUST be the final write. ---
    let inputTxtFinal = null;
    try {
      if (ctrl) {
        ctrl.onEditTextChange(word);
        inputTxtFinal = String(ctrl.inputTxt == null ? "" : ctrl.inputTxt);
      }
    } catch (e) {}
    return { ok: true, boxes: boxes.length, typed: word, typedViaDom, viaController, inputTxt: inputTxtFinal, dismissed };
  }

  // Click the game's ANSWER / confirm button ("Click ANSWER or use ENTER key")
  function confirmAnswer() {
    // 0. System dialogs that appear LATE (after start — e.g. the Windows-10
    //    upgrade notice) dim the whole screen and swallow every input. Dismiss
    //    them FIRST or the answer button click is a silent no-op.
    dismissSystemPopups();
    // 0b. THE REAL PATH on fill-word games: the controller's own Enter handler
    //     validates inputTxt and fires the AnswerCheck API directly — the
    //     button click is only a fallback (live-validated: ctrl.onKeyEnterPress
    //     scored 10/10 on a real question).
    try {
      const ctrl = findQuestionController();
      if (ctrl && findEditBoxes().length) {
        ctrl.onKeyEnterPress();
        // Post-check: if the validation failed the game shows a "Vui lòng nhập
        // đủ số ký tự" popup SYNCHRONOUSLY — report it instead of fake success
        // (live-caused: ok:true while 0 AnswerCheck calls, root cause of the
        // "type but never submit" failure mode).
        const popupText = readActivePopupText();
        if (popupText && /nh\u1eadp \u0111\u1ee7|s\u1ed1 k\xfd t\u1ef1/i.test(popupText)) {
          // BUG#30: popup validation phải được DISMISS ngay (nút "OK" — ảnh,
          // không text) — không thì nó nuốt mọi click sau đó và game chết đứng.
          try {
            for (const nm of ["OK", "ok", "btnOK", "ok_btn", "btn_ok"]) {
              const n = findNodeByName(nm);
              if (n) { clickNode(n); break; }
            }
          } catch (e2) {}
          return { ok: false, reason: "validation_popup", popup: popupText, via: "controller.onKeyEnterPress", inputTxt: String(ctrl.inputTxt == null ? "" : ctrl.inputTxt) };
        }
        return { ok: true, via: "controller.onKeyEnterPress", inputTxt: String(ctrl.inputTxt == null ? "" : ctrl.inputTxt) };
      }
    } catch (e) {}
    // 1. Well-known button node names
    const names = ["btn_answer", "btnAnswer", "answer_btn", "btnSubmit", "btn_submit", "submit_btn", "btnOK", "ok_btn", "btn_ok",
      // BUG#30 (nh-tim, 17/09/2026): popup "Vui lòng nhập đủ số ký tự" có nút
      // tên ĐÚNG "OK" — nút ẢNH không có text nên btnOK/ok_btn/text-search đều miss.
      "OK", "ok"];
    for (const nm of names) {
      const n = findNodeByName(nm);
      if (n) { const ok = clickNode(n); if (ok) return { ok: true, via: "name:" + nm }; }
    }
    // 1b. Fill-word games name their ANSWER button "btnA" (validated live on
    //     tai-tao-san-ho). Only trust this name when an EditBox is on screen —
    //     in MCQ games "btnA" would be the option-A button instead.
    if (findEditBoxes().length) {
      const n = findNodeByName("btnA");
      if (n) { const ok = clickNode(n); if (ok) return { ok: true, via: "name:btnA(editbox)" }; }
    }
    // 2. Button whose label reads ANSWER / OK / Trả lời
    for (const label of ["answer", "trả lời", "ok", "confirm", "submit"]) {
      const n = findNodeByText(label, { contains: true });
      if (n) { const ok = clickNode(n); if (ok) return { ok: true, via: "text:" + label }; }
    }
    // 3. Keyboard ENTER on the canvas (gameDesc says ENTER confirms the answer)
    const cv = getCanvas();
    if (cv) {
      try {
        const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, view: window };
        cv.dispatchEvent(new KeyboardEvent("keydown", opts));
        cv.dispatchEvent(new KeyboardEvent("keyup", opts));
        return { ok: true, via: "keyboard-enter" };
      } catch (e) {}
    }
    return { ok: false, reason: "no_confirm_target" };
  }

  // Text of the currently-open system popup (or null) — used by confirmAnswer
  // to detect the synchronous "Vui lòng nhập đủ số ký tự" validation popup.
  function readActivePopupText() {
    try {
      const cc = getCC();
      if (!cc) return null;
      const nodes = allNodes().filter(n => n && n.activeInHierarchy !== false);
      const popupNode = nodes.find(n => /^popup/i.test(n.name || ""));
      if (!popupNode) return null;
      const texts = [];
      for (const n of nodes) {
        let p = n.parent, under = false, guard = 0;
        while (p && guard < 25) { if (p === popupNode) { under = true; break; } p = p.parent; guard++; }
        if (!under) continue;
        try {
          const l = cc.Label && n.getComponent && n.getComponent(cc.Label);
          if (l && l.string) texts.push(String(l.string));
        } catch (e) {}
      }
      return texts.join(" ").trim() || null;
    } catch (e) { return null; }
  }

  // Dismiss late-appearing system dialogs (e.g. the Windows-10 upgrade notice).
  // Live-validated structure on ioe.vn:
  //   Canvas > POPUP_COMMON > actions > (unnamed OK Button 147x71)
  //   Canvas > fadedBackground        (the popup's dim backdrop, a sibling)
  // SAFETY: this no-ops unless a popup is ACTUALLY open — an active node named
  // /^POPUP/ or a visible "Thông báo/Khuyến cáo" title label. It then clicks
  // ONLY buttons inside the POPUP subtree, so gameplay buttons are never touched.
  function dismissSystemPopups() {
    let closed = 0;
    try {
      const cc = getCC();
      if (!cc) return closed;
      const nodes = allNodes().filter(n => n && n.activeInHierarchy !== false);
      const popupNode = nodes.find(n => /^popup/i.test(n.name || ""));
      const hasNoticeLabel = nodes.some(n => {
        try {
          const l = cc.Label && n.getComponent && n.getComponent(cc.Label);
          return !!(l && /th\u00f4ng b\u00e1o|khuy\u1ebfn c\u00e1o|notice|h\u1ec7 th\u1ed1ng/i.test(l.string || ""));
        } catch (e) { return false; }
      });
      if (!popupNode && !hasNoticeLabel) return 0;

      if (popupNode) {
        // Click every active Button inside the POPUP subtree (the OK button).
        for (const n of nodes) {
          if (n === popupNode || !isButton(n) || (n.width || 0) > 800) continue;
          let p = n.parent, under = false, guard = 0;
          while (p && guard < 25) { if (p === popupNode) { under = true; break; } p = p.parent; guard++; }
          if (under) { clickNode(n); closed++; }
        }
      } else {
        // Variant without a named POPUP node: click small centered buttons
        // (the OK of the dialog) — dim-layer fallback.
        let vs = null;
        try { vs = cc.view.getVisibleSize(); } catch (e) {}
        const vw = (vs && vs.width) || 1;
        const dim = nodes.find(n => isButton(n) && (n.width || 0) > vw * 0.6 && /fade|dim|dark|background/i.test(n.name || ""));
        if (dim) {
          const dp = nodeWorld(dim);
          const dw = dim.width || 0, dh = dim.height || 0;
          for (const n of nodes) {
            if (n === dim || !isButton(n) || (n.width || 0) > vw * 0.6) continue;
            const pt = nodeWorld(n);
            if (pt.x >= dp.x - dw / 2 && pt.x <= dp.x + dw / 2 && pt.y >= dp.y - dh / 2 && pt.y <= dp.y + dh / 2) { clickNode(n); closed++; }
          }
        }
      }
    } catch (e) {}
    return closed;
  }

  // Text of the question currently ON SCREEN (active only), plus its number if a
  // "n/10"-style counter label is visible. Used by the solver to wait for the
  // next question's animation to finish before clicking the answer.

  // BUG#26 (live 17/09/2026, chim-hai-tao): component "question controller"
  // (currentQuestionNumber 0-based + askStrContent = câu hiện tại + desStrContent
  // = đoạn văn + canClick) — nguồn đọc chính xác nhất cho game đọc hiểu TF.
  // Cache tham chiếu vì currentQuestionInfo được poll liên tục (~200ms).
  let _questCompCache = null;
  function findQuestControllerComponent() {
    try {
      const c = _questCompCache;
      if (c && c.node && c.node.activeInHierarchy !== false && c.isValid !== false) return c;
      _questCompCache = null;
    } catch (e) { _questCompCache = null; }
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene) return null;
    let found = null;
    (function walk(n) {
      if (!n || found) return;
      try { if (n.activeInHierarchy === false) return; } catch (e) {}
      const comps = n._components || n.components;
      if (comps) for (const c of comps) {
        if (c && c.currentQuestionNumber !== undefined && typeof c.onButtonClick === "function") { found = c; return; }
      }
      const kids = n.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(cc.director.getScene());
    _questCompCache = found;
    return found;
  }

  // BUG#26 (chim-hai-tao): các ô chuyển câu chia sẻ tên node "btn_quest_item",
  // phân biệt bằng label con "1".."N" — CLICK_TEXT "2" có thể trúng nút khác
  // (số câu trùng số thứ tự đáp án MCQ). RPC riêng cho solver đọc hiểu TF.
  // BUG#40: đếm node btn_quest_item đang active (ô chuyển câu). 0 = game hiển thị
  // một câu một màn; ≥2 = nhiều câu trên cùng màn, solver phải chuyển câu.
  function countQuestItems() {
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene) return 0;
    let n = 0;
    (function walk(x) {
      if (!x) return;
      try { if (x.activeInHierarchy === false) return; } catch (e) {}
      if (x.name === "btn_quest_item") n++;
      const kids = x.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(cc.director.getScene());
    return n;
  }

  // BUG#52 (live 23/09/2026, don-rac-bai-bien — Vòng 4 Bài 1): phân biệt game
  // đọc hiểu TỪNG CÂU với game trắc nghiệm/chọn cặp. Hai chế độ này cần cách
  // giải khác hẳn nhau, mà TÊN GAME không dùng được (tên là dữ liệu, mỗi vòng
  // một khác). Dấu hiệu đáng tin là NODE CÂU HỎI ĐANG HIỆN:
  //   • nConversationQuest → mỗi câu có đoạn văn riêng, phải đọc lại từng câu
  //   • nTracNghiem        → không có đoạn văn, một lượt AI cho cả bài
  // Live-verified: don-rac-bai-bien có nConversationQuest active và passage đổi
  // thật giữa các câu ("Generation Y…" → "Fred Lorz…"); an-khe-tra-vang (100
  // điểm) không có đoạn văn nào, prompt toàn từ đơn (sorrow/polite/…).
  function activeQuestionMode() {
    const out = { conversation: false, tracNghiem: false, node: null };
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene) return out;
    (function walk(n) {
      if (!n) return;
      let act = true;
      try { act = n.activeInHierarchy !== false; } catch (e) {}
      if (act && n.name === "nConversationQuest") { out.conversation = true; out.node = n.name; }
      if (act && n.name === "nTracNghiem") { out.tracNghiem = true; if (!out.node) out.node = n.name; }
      const kids = n.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(cc.director.getScene());
    return out;
  }

  function clickQuestItem(index) {
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene || index === undefined || index === null) return { ok: false, reason: "bad_args" };
    const target = normText(String(index));
    if (!target) return { ok: false, reason: "bad_args" };
    let found = null;
    (function walk(n) {
      if (!n || found) return;
      try { if (n.activeInHierarchy === false) return; } catch (e) {}
      if (n.name === "btn_quest_item" && normText(nodeText(n)) === target) found = n;
      const kids = n.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(cc.director.getScene());
    // BUG#40 (live 22/09/2026, an-khe-tra-vang — Vòng 3 Bài 2): đường khớp THEO
    // TEXT ở trên chỉ đúng khi ô chuyển câu có Label mang số ("1".."N"). Game
    // này vẽ số bằng SPRITE ⇒ nodeText() trả null ⇒ no_item_N → solver đứng mãi
    // ở câu 1 dù đã click đủ 5 đáp án (live: panel hiện 5 đáp án đúng, điểm 0).
    // Fallback: đánh số các node btn_quest_item ĐANG ACTIVE theo đúng thứ tự
    // duyệt (trái→phải, đã kiểm chứng live: tab2 ở x=279 đổi câu 1→2) rồi click
    // node thứ `index`. Đã kiểm chứng click TRUSTED vào toạ độ tab hoạt động.
    if (!found) {
      const items = [];
      (function walk(n) {
        if (!n) return;
        try { if (n.activeInHierarchy === false) return; } catch (e) {}
        if (n.name === "btn_quest_item") items.push(n);
        const kids = n.children;
        if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
      })(cc.director.getScene());
      const want = parseInt(target, 10);
      if (items.length >= want && want >= 1) found = items[want - 1];
      if (!found) return { ok: false, reason: "no_item_" + target + "_of_" + items.length };
    }
    return clickNode(found) ? { ok: true } : { ok: false, reason: "click_failed" };
  }

  // BUG#26 (chim-hai-tao): nút game có tên kèm hậu tố editor ("btnTrue copy") —
  // CLICK_NAME exact "btnTrue" luôn thất bại. Thử exact → prefix ("btnTrue ") →
  // contains; trả về tên node đã click để solver ghi log.
  function clickNameSmart(name) {
    if (!name) return { ok: false, reason: "no_name" };
    let n = findNodeByName(name);
    let via = "exact";
    // BUG#32: try a case-insensitive exact match before fuzzy prefix/contains —
    // `btnd` (lowercase) never matched the solver's "btnD" and the fuzzy passes
    // could latch onto an unrelated node.
    if (!n) { n = findNodeByNameCI(name); if (n) via = "ci_exact"; }
    if (!n) {
      for (const x of allNodes()) {
        if (x && x.activeInHierarchy !== false && typeof x.name === "string" && x.name.startsWith(name + " ")) { n = x; via = "prefix"; break; }
      }
    }
    if (!n) {
      for (const x of allNodes()) {
        if (x && x.activeInHierarchy !== false && typeof x.name === "string" && x.name !== name && x.name.includes(name)) { n = x; via = "contains"; break; }
      }
    }
    if (!n) return { ok: false, reason: "not_found" };
    return clickNode(n) ? { ok: true, node: n.name, via } : { ok: false, reason: "click_failed" };
  }
  // BUG#38 (live 22/09/2026, chim-hai-tao Vòng 1 Bài 1 — tài khoản test 2):
  // bài ĐỌC HIỂU để đoạn văn và câu hỏi trong HAI node RichText RIÊNG BIỆT
  // ("conv_content_scroll" = đoạn văn, "ask_content_no_scroll" = câu hỏi),
  // mỗi node chứa nhiều node con "RICHTEXT_CHILD". readGameScreen() gom MỌI
  // RICHTEXT_CHILD rồi sắp theo toạ độ y → hai khối ĐAN XEN NHAU:
  //     "Percy Ross is the only Percy Ross was one of the most famous
  //      millionaire who has millionaires who gave away all their money to
  //      given away all his help others. Ross was born in 1916..."
  // ⇒ AI nhận văn bản RÁC. Tệ hơn: solveReadingTfExam chỉ lấy passage từ
  // payload.des = controller.desStrContent, mà game này KHÔNG có controller
  // (đã kiểm chứng: readGameScreen() không hề có key "des") ⇒ passage RỖNG
  // ⇒ AI đoán True/False không có ngữ cảnh. Trong khi đoạn văn SẠCH 670 ký tự
  // vẫn nằm nguyên trong node conv_content_scroll.
  // Hàm này đọc theo TÊN NODE (nguồn đáng tin nhất), có fallback.
  function getPassageText() {
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene) return "";
    // Tên node chứa đoạn văn, ưu tiên từ trên xuống (đã gặp trên live).
    const PASSAGE_NODES = ["conv_content_scroll", "content_scroll", "conv_content", "scrollRtext"];
    const nodes = [];
    (function walk(n, d) {
      if (!n || d > 90) return;
      nodes.push(n);
      (n.children || []).forEach(c => walk(c, d + 1));
    })(cc.director.getScene(), 0);
    // BUG#55 (live 23/09/2026, chinh-phuc-fansipan — Vòng 7 Bài 2, 70 điểm):
    // game đọc hiểu True/False dựng HAI node cùng tên `content_scroll` — một node
    // chứa ĐOẠN VĂN (320 ký tự) và một node chứa CÂU KHẲNG ĐỊNH (107 ký tự).
    // Bản cũ trả về node ĐẦU TIÊN khớp tên có text >= 40 ký tự, nên khi node câu
    // hỏi đứng trước trong thứ tự duyệt thì nó che mất đoạn văn thật:
    // `getPassageText()` trả 107 ký tự (là CÂU HỎI) → `looksLikePassage()` đòi
    // >= 180 nên loại → solver log "⚠️ Không đọc được đoạn văn" → AI đoán
    // True/False không ngữ cảnh (live: 30/100, rồi 40/100, rồi 70/100).
    // Sửa: trong CÙNG một tên, chọn text DÀI NHẤT thay vì text đầu tiên. Thứ tự
    // ưu tiên theo TÊN giữ nguyên (đoạn văn thật vẫn thắng scrollRtext của màn
    // hướng dẫn), nhưng node ngắn không còn che được node dài.
    for (const name of PASSAGE_NODES) {
      let best = "";
      for (const n of nodes) {
        try { if (n.activeInHierarchy === false) continue; } catch (e) { continue; }
        if (n.name !== name) continue;
        // labelOf đã stripRichText → đoạn văn liền mạch, không dính markup.
        const t = labelOf(n) || nodeText(n, 12);
        const s = t ? String(t).trim() : "";
        if (s.length > best.length) best = s;
      }
      if (best.length >= 40) return best;
    }
    // Fallback: controller (game đọc hiểu đời cũ có desStrContent).
    try {
      const qc = findQuestControllerComponent();
      if (qc) {
        const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const des = strip(qc.desStrContent);
        if (des && des.length >= 40) return des;
      }
    } catch (e) {}
    return "";
  }

  function currentQuestionInfo() {
    const cc = getCC();
    const labels = scanLabels();
    const out = { text: "", qnum: null, raw: labels.length };

    // 0. BUG#26 (chim-hai-tao): question controller component — qnum/ask/des/
    //    canClick chính xác 100%, ưu tiên trước mọi heuristic label.
    try {
      const qc = findQuestControllerComponent();
      if (qc) {
        if (qc.currentQuestionNumber !== undefined && qc.currentQuestionNumber !== null && /^\d+$/.test(String(qc.currentQuestionNumber))) {
          out.qnum = parseInt(String(qc.currentQuestionNumber), 10) + 1; // 1-based như label "n/total"
        }
        const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const ask = strip(qc.askStrContent);
        if (ask) out.ask = ask;
        const des = strip(qc.desStrContent);
        if (des) out.des = des;
        if (qc.canClick !== undefined) out.canClick = !!qc.canClick;
      }
    } catch (e) {}

    // BUG#38: `des` PHẢI luôn có khi game có đoạn văn — nhánh controller ở trên
    // chỉ chạy khi game CÓ controller, còn game đọc hiểu mới (chim-hai-tao) thì
    // không. Đọc thẳng từ node conv_content_scroll.
    if (!out.des) {
      try { const p = getPassageText(); if (p) out.des = p; } catch (e) {}
    }

    // 1a. Separate counter labels (live 17/09/2026, bach-tuoc-thu-ngoc):
    //     lblCurrent "1" + lbl_total_quest "10" — hai label RỜI, không có
    //     dạng "1/10" nên regex bên dưới không bao giờ khớp → qnum null →
    //     solver không phát hiện được game đã chuyển câu (gốc BUG#24).
    const META_NODE = /^(lblName|lblID|lbLevel|lblScore|lblTimer|lblVersion)$/i;
    for (const l of labels) {
      if (l.node === "lblCurrent" && /^\d+$/.test(String(l.text || "").trim())) {
        out.qnum = parseInt(String(l.text).trim(), 10);
      } else if (/^(lbl_total_quest|lblTotalQuest|lbl_total|total_quest)$/i.test(l.node || "") && /^\d+$/.test(String(l.text || "").trim())) {
        out.total = parseInt(String(l.text).trim(), 10);
      }
    }

    // 1b. Find a "3/10", "Câu 3/10" or "3 / 10" style counter
    if (out.qnum === null) {
      for (const l of labels) {
        const m = String(l.text || "").match(/(?:c\u00e2u\s*)?(\d+)\s*\/\s*(\d+)/i);
        if (m) { out.qnum = parseInt(m[1]); out.total = parseInt(m[2]); break; }
      }
    }

    // 2. Longest visible label = the question statement (statement is longer
    //    than buttons/counters/audio hints like "Click to replay").
    //    LOẠI TRỪ label meta: tên người chơi ("Nguyễn Thế Lương") đủ dài và
    //    lọt vào heuristic cũ → "text" không bao giờ đổi giữa các câu.
    let best = "";
    for (const l of labels) {
      if (META_NODE.test(l.node || "")) continue;
      const t = String(l.text || "").trim();
      if (t.length > best.length && t.length >= 15) best = t;
    }
    out.text = best;

    // 3. BUG#26: signature = join RICHTEXT_CHILD (statement + passage) — đổi
    // khi statement đổi (passage giữ nguyên giữa các câu) → detector chuyển
    // câu cho game KHÔNG có counter và component (label-only games).
    let sig = "";
    for (const l of labels) {
      if (l.node === "RICHTEXT_CHILD") sig += (sig ? " " : "") + String(l.text || "");
    }
    out.sig = sig.slice(0, 500);
    return out;
  }

  function scanLabels() {
    const cc = getCC();
    const out = [];
    if (!cc || !cc.director || !cc.director.getScene) return out;
    let scene;
    try { scene = cc.director.getScene(); } catch (e) { return out; }
    if (!scene) return out;
    const seen = new Set();
    function walk(node, depth) {
      if (!node || depth > 80) return;
      // Skip hidden branches: preloaded (inactive) question panels must not be
      // reported as "on screen" — the solver relies on this to sync per-question.
      try { if (node.activeInHierarchy === false) return; } catch (e) {}
      try {
        const txt = labelOf(node);
        if (txt) {
          const pt = designToClient(nodeWorld(node));
          const key = txt + "@" + Math.round(pt.x) + "," + Math.round(pt.y);
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ text: txt, x: Math.round(pt.x), y: Math.round(pt.y), node: node.name || "" });
          }
        }
      } catch (e) {}
      const kids = node.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    walk(scene, 0);
    return out;
  }

  function reply(reqId, type, payload) {
    window.postMessage({ __ioeBridge: true, type: type, payload: payload, reqId: reqId }, window.location.origin);
  }

  // ================== NEW GAME TYPES (live-verified 16/09/2026) ==================

  // Tìm mọi EditBox đang active, sắp xếp theo vị trí trên màn hình (trên→xuống, trái→phải)
  function orderedEditBoxes() {
    const cc = getCC();
    const out = [];
    if (!cc || !cc.director || !cc.director.getScene) return out;
    (function walk(n) {
      if (!n) return;
      let active = true;
      try { active = n.activeInHierarchy !== false; } catch (e) {}
      if (!active) return;
      try {
        const eb = n.getComponent(cc.EditBox);
        if (eb) out.push({ n, eb });
      } catch (e) {}
      (n.children || []).forEach(walk);
    })(cc.director.getScene());
    return out.map(b => {
      const w = nodeWorld(b.n);
      return { node: b.n, eb: b.eb, world: w, string: b.eb.string, maxLength: b.eb.maxLength };
    }).sort((a, b) => (b.world.y - a.world.y) || (a.world.x - b.world.x));
  }

  // Đọc màn hình game tổng quát — phục vụ 3 dạng mới:
  //  * transform typing (hanh-tinh-tim): câu 1 + skeleton câu 2 + EditBox masks
  //  * MCQ khung_tracnghiem (thanh-pho-xanh): options từ node khung_tracnghiem*
  //  * cloze chip (cuon-giay-bi-an): word bank từ controller _lstAnswers
  function readGameScreen() {
    const cc = getCC();
    const out = { qNumber: null, first: null, skeleton: null, editboxes: [], khungOptions: [], wordBank: null, answerBtn: null, clozeBlanks: 0 };
    if (!cc || !cc.director || !cc.director.getScene) return out;
    const nodes = [];
    (function walk(n, d) {
      if (!n || d > 90) return;
      nodes.push(n);
      (n.children || []).forEach(c => walk(c, d + 1));
    })(cc.director.getScene(), 0);
    // RICHTEXT_CHILD theo vị trí
    const rts = [];
    // BUG#42 (live 22/09/2026, cuon-giay-bi-an — Vòng 6 Bài 2): game cloze vẽ mỗi
    // ô trống bằng một node con tên SELECT_RICH_TEXT_CHILD_NAME, KHÔNG phải
    // RICHTEXT_CHILD → đoạn văn gom được bị MẤT HẾT marker "(n)____" ("He had and
    // lots of ideas..."), AI không biết từ nào vào ô nào. Gom riêng rồi chèn lại
    // theo toạ độ ở nhánh cloze bên dưới.
    const clozeMarks = [];
    for (const n of nodes) {
      let active = true;
      try { active = n.activeInHierarchy !== false; } catch (e) {}
      if (!active) continue;
      try {
        const l = n.getComponent(cc.Label);
        if (l && l.string) {
          const t = String(l.string).trim();
          if (n.name === "number_lbl" && /^\d+$/.test(t)) out.qNumber = parseInt(t, 10);
          if (n.name === "RICHTEXT_CHILD" && t) rts.push({ t, w: nodeWorld(n) });
          else if (t && n.parent && n.parent.name === "SELECT_RICH_TEXT_CHILD_NAME") clozeMarks.push({ t, w: nodeWorld(n) });
        }
      } catch (e) {}
      if (n.name === "btnA" || n.name === "submit") {
        try { out.answerBtn = nodeWorld(n); } catch (e) {}
      }
    }
    // EditBox ordered
    out.editboxes = orderedEditBoxes().map((b, i) => ({ i, maxLength: b.maxLength, string: b.string, world: b.world }));
    // chia câu 1 / câu 2 theo gap lớn nhất giữa các dòng
    if (rts.length) {
      rts.sort((a, b) => (b.w.y - a.w.y) || (a.w.x - b.w.x));
      let splitIdx = 0, maxGap = 0;
      for (let i = 1; i < rts.length; i++) {
        const gap = rts[i - 1].w.y - rts[i].w.y;
        if (gap > maxGap) { maxGap = gap; splitIdx = i; }
      }
      if (maxGap > 100 && out.editboxes.length) {
        out.first = rts.slice(0, splitIdx).map(r => r.t).join(" ");
        const segs = rts.slice(splitIdx).map(r => ({ type: "text", t: r.t, w: r.w }));
        out.editboxes.forEach(eb => segs.push({ type: "blank", i: eb.i, w: eb.world }));
        segs.sort((a, b) => (b.w.y - a.w.y) || (a.w.x - b.w.x));
        out.skeleton = segs.map(s => (s.type === "text" ? s.t : "[B" + (s.i + 1) + "]")).join(" ");
      } else {
        out.first = rts.map(r => r.t).join(" ");
      }
    }
    // khung_tracnghiem options (thanh-pho-xanh: khung_tracnghiem, -001, -002, -003)
    for (const n of nodes) {
      if (!/^khung_tracnghiem(-\d+)?$/.test(n.name || "")) continue;
      let active = true;
      try { active = n.activeInHierarchy !== false; } catch (e) {}
      if (!active) continue;
      let marker = null;
      const words = [];
      (function collect(x) {
        if (!x) return;
        try {
          const l = x.getComponent(cc.Label);
          if (l && l.string) {
            const t = String(l.string).trim();
            if (/^[A-D]\.$/.test(t)) marker = t[0];
            else if (t && t !== ".") words.push(t);
          }
        } catch (e) {}
        (x.children || []).forEach(collect);
      })(n);
      if (words.length || marker) out.khungOptions.push({ marker, text: words.join(" "), world: nodeWorld(n) });
    }
    out.khungOptions.sort((a, b) => (a.marker || "Z").localeCompare(b.marker || "Z"));
    // cloze controller (cuon-giay-bi-an): component có _curentSelectIndex
    out.cloze = findClozeController();
    if (out.cloze) {
      out.wordBank = out.cloze._lstAnswers || null;
      out.clozeBlanks = (out.cloze._lstSelect || []).length;
      delete out.cloze; // không serialise component
      // BUG#42: chèn marker "(n)____" trở lại đúng chỗ trong đoạn văn, dùng toạ độ
      // của node marker so với các mảnh RICHTEXT_CHILD (sort y giảm, x tăng — cùng
      // quy tắc với nhánh rts ở trên). Không có bước này thì `first` là đoạn văn
      // liền mạch không ô trống, AI không thể biết từ nào điền vào đâu.
      if (clozeMarks.length && rts.length) {
        const segs = rts.map(r => ({ t: r.t, w: r.w }));
        for (const m of clozeMarks) segs.push({ t: m.t, w: m.w });
        // Sort theo DÒNG, không sort thuần theo y: marker "(1)____" nằm cùng dòng
        // với 2 mảnh text nhưng y lệch 2px (336 vs 338, do baseline khác nhau) →
        // sort (b.y-a.y)||(a.x-b.x) đẩy marker xuống CUỐI dòng →
        // "He had and lots of ideas... (1)____" → AI điền sai vị trí (60 điểm).
        // Gom các mảnh có y trong cùng dải ±8px thành một dòng rồi mới xếp theo x.
        const TOL = 8;
        segs.sort((a, b) => b.w.y - a.w.y);
        let line = 0;
        for (let i = 1; i < segs.length; i++) {
          if (segs[i - 1].w.y - segs[i].w.y > TOL) line++;
          segs[i]._line = line;
        }
        segs[0]._line = 0;
        segs.sort((a, b) => (a._line - b._line) || (a.w.x - b.w.x));
        out.first = segs.map(s => s.t).join(" ");
        out.clozeMarked = true;
      }
    }
    return out;
  }

  // Tìm controller của game cloze (cuon-giay-bi-an): component có thuộc tính _curentSelectIndex
  function findClozeController() {
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene) return null;
    let ctrl = null;
    (function walk(n) {
      if (!n || ctrl) return;
      try {
        for (const c of n.getComponents(cc.Component)) {
          if (c && Object.prototype.hasOwnProperty.call(c, "_curentSelectIndex")) { ctrl = c; break; }
        }
      } catch (e) {}
      if (!ctrl) (n.children || []).forEach(walk);
    })(cc.director.getScene());
    return ctrl;
  }

  // Set nhiều EditBox cùng lúc (mảng text theo thứ tự position) — dạng transform typing
  function fillEditBoxes(texts) {
    const boxes = orderedEditBoxes();
    const results = [];
    for (let i = 0; i < boxes.length; i++) {
      const text = (texts || [])[i];
      if (text == null) break;
      try {
        boxes[i].eb.string = String(text);
        try { boxes[i].eb.node.emit("editing-did-ended"); } catch (e) {}
        results.push(String(boxes[i].eb.string));
      } catch (e) { results.push(null); }
    }
    return results;
  }

  // Nộp bài cloze trực tiếp qua controller (bypass UI click từng chip —
  // hit-test của chip không nhận mouse synthetic; live-caught 16/09/2026)
  function submitCloze(wordsPerBlank) {
    const ctrl = findClozeController();
    if (!ctrl) return { ok: false, reason: "no cloze controller" };
    try {
      const n = (ctrl._lstSelect || []).length;
      const chipWords = ctrl._lstAnswers || [];
      // BUG#42: khớp từ KHÔNG phân biệt hoa/thường. AI hay trả "success" cho chip
      // "Success" → indexOf = -1 → rơi vào nhánh `idx >= 0 ? idx : i` và gán bừa
      // index = vị trí ô, tức là điền SAI TỪ mà vẫn báo ok. Đồng thời ghi lại
      // unmatched để log ra biết AI trả từ lạ.
      const unmatched = [];
      ctrl._lstSelect = (wordsPerBlank || []).slice(0, n).map((w, i) => {
        const raw = String(w == null ? "" : w);
        let idx = chipWords.indexOf(raw);
        if (idx < 0) idx = chipWords.findIndex(c => String(c).toLowerCase() === raw.toLowerCase());
        if (idx < 0) unmatched.push(raw);
        return { index: idx >= 0 ? idx : i, contents: idx >= 0 ? chipWords[idx] : raw };
      });
      while (ctrl._lstSelect.length < n) ctrl._lstSelect.push(null);
      try { ctrl._updateQuestionContainer && ctrl._updateQuestionContainer(); } catch (e) {}
      const selected = ctrl._isSelectedAll;
      if (!selected) return { ok: false, reason: "not all filled", select: ctrl._lstSelect };
      ctrl.onSubmitGame();
      return { ok: true, submitted: true, unmatched: unmatched, select: ctrl._lstSelect.map(s => s && s.contents) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  // Click nút ANSWER/submit của màn chơi (btnA — hanh-tinh-tim; submit — cuon-giay)
  function clickAnswerButton() {
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene) return { ok: false };
    for (const nm of ["btnA", "submit", "btn_answer"]) {
      let n = null;
      try { n = findNodeByName(nm); } catch (e) {}
      if (n) { try { clickNode(n); return { ok: true, name: nm }; } catch (e) {} }
    }
    return { ok: false };
  }

  // BUG#37 (live 22/09/2026, hanh-tinh-tim, Vòng 4 Bài 2): game nộp từng câu qua
  // AnswerCheck rồi tự chuyển câu, NHƯNG hết câu cuối thì KHÔNG có nút nào để bấm
  // nộp cả bài — trong scene không tồn tại node "btnSubmit"/"nameSubmit" (dump
  // toàn bộ tên node active chỉ có btnA/btnClose/btn_container/btn_home/audioBtn).
  // Đường nộp thật nằm trong GamePlay.onClimbNextCheckPoint:
  //     currentQuestionId >= questionArr.length  →  this.endGame()
  // endGame() POST FINISH_GAME (đúng payload {examKey, ans, token, ...}) rồi
  // showEndGameScene → PopupEndGame. Vì vậy phải gọi THẲNG endGame() của component
  // GamePlay. Dò theo prototype (constructor.name bị minify thành "t"/"CCClass"
  // nên KHÔNG so tên class được — chính vì thế nhánh cũ dò currentQuestionNumber
  // không thấy GamePlay): nhận diện bằng bộ đôi questComs + currentQuestionId,
  // đúng 2 field mà onClimbNextCheckPoint đọc.
  function findGamePlay() {
    const cc = getCC();
    if (!cc || !cc.director || !cc.director.getScene) return null;
    let found = null;
    (function walk(n) {
      if (!n || found) return;
      try { if (n.activeInHierarchy === false) return; } catch (e) {}
      const comps = n._components || n.components;
      if (comps) for (const c of comps) {
        if (c && Array.isArray(c.questComs) && c.currentQuestionId !== undefined && typeof c.endGame === "function") { found = c; return; }
      }
      const kids = n.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(cc.director.getScene());
    return found;
  }

  // Nộp cả bài bằng chính hàm endGame() của game (POST FINISH_GAME). Trả về
  // isEndGame sau khi chờ — true nghĩa là server đã nhận và game đã dựng popup.
  async function finishGameDirect() {
    try { dismissSystemPopups(); } catch (e) {}
    const gp = findGamePlay();
    if (!gp) return { ok: false, reason: "no_gameplay" };
    const before = gp.isEndGame === true;
    try { gp.endGame(); } catch (e) { return { ok: false, reason: "throw:" + (e && e.message) }; }
    // endGame là POST bất đồng bộ → chờ tối đa ~6s cho isEndGame bật.
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { if (gp.isEndGame === true) return { ok: true, alreadyEnded: before }; } catch (e) { break; }
    }
    return { ok: false, reason: "no_endgame_ack", alreadyEnded: before };
  }

  // BUG#30c (nh-tim/hanh-tinh-tim transform, 17/09/2026): nút ANSWER của game
  // biến đổi câu = controller.onKeyEnterPress — nhưng validation isAnswerAll()
  // đòi MỖI từ phải dài ĐÚNG maxLength của ô (live-verified: 'aaa' vào ô
  // maxLength 8 → "Vui lòng nhập đủ số ký tự" → game kẹt cả bài). Đường chuẩn:
  // set từng EditBox theo ddv.results + gọi ctrl.onKeyEnterPress() trực tiếp
  // (callApiAnswer bên trong) — verified: AnswerCheck bay + chuyển câu ngay.
  function submitTransform(words) {
    try { dismissSystemPopups(); } catch (e) {}
    const cc = getCC();
    const ctrl = findQuestionController();
    if (!ctrl || !ctrl.dienDoanVan || !ctrl.dienDoanVan.results || !cc || !cc.EditBox) {
      return { ok: false, reason: "no_controller" };
    }
    const ddv = ctrl.dienDoanVan;
    const out = [];
    try {
      for (let i = 0; i < ddv.results.length; i++) {
        const eb = ddv.results[i].getComponent(cc.EditBox);
        if (!eb) continue;
        const ml = eb.maxLength || 0;
        let w = String((words || [])[i] || "");
        // Từ sai độ dài → placeholder đúng maxLength: isAnswerAll đòi ĐÚNG từng ô,
        // 1 ô sai = KHÔNG nộp được cả câu (kẹt game). Placeholder giúp câu vẫn
        // nộp (điểm 0 cho câu đó) và game tiếp tục.
        if (!w.length || (ml > 0 && w.length !== ml)) w = "x".repeat(Math.max(1, ml));
        eb.string = w;
        out.push(w);
      }
      if (!ddv.isAnswerAll || !ddv.isAnswerAll()) {
        return { ok: false, reason: "not_all_filled", filled: out };
      }
    } catch (e) {
      return { ok: false, reason: "fill_err:" + (e && e.message) };
    }
    try {
      ctrl.onKeyEnterPress();
      return { ok: true, submitted: out };
    } catch (e) {
      return { ok: false, reason: "enter_err:" + (e && e.message) };
    }
  }

  // BUG#45 (live 22/09/2026, chim-hai-tao — Vòng 7 Bài 4, 20/100):
  //   audio-sniffer.js hook `fetch` / `XHR` / `new Audio()` nhưng chạy ở world
  //   ISOLATED, còn Cocos tải asset ở world MAIN → sniffer KHÔNG BAO GIỜ thấy file
  //   nghe (live: __LAST_CAPTURED_IOE_AUDIO__ rỗng suốt bài). Hậu quả: đề NGHE
  //   bị phân loại reading_tf (API trả isListening:false, audio:null) → AI suy luận
  //   chay từ câu khẳng định → 1/5 đúng.
  //   Trong MAIN world ta ĐỌC ĐƯỢC URL thật qua performance.getEntriesByType("resource")
  //   (live-verified: bắt đúng .../a3/a36d401a-....mp3, 1.13 MB). Trả về cho ISO để
  //   gửi kèm audioUrls cho AI — không cần hook gì thêm.
  function getAudioUrlsFromPerf() {
    try {
      const out = [];
      for (const r of performance.getEntriesByType("resource")) {
        const n = r.name || "";
        if (!/\.(mp3|m4a|ogg|wav|aac)(\?|$)/i.test(n)) continue;
        if (out.some(o => o.url === n)) continue;
        // Kích thước để phân biệt BÀI NGHE với hiệu ứng âm thanh nhỏ (live: bài
        // nghe 1.13 MB, hiệu ứng vài chục KB). transferSize = 0 khi lấy từ cache
        // → lấy max của decoded/encoded cho chắc.
        const size = Math.max(r.transferSize || 0, r.encodedBodySize || 0, r.decodedBodySize || 0);
        out.push({ url: n, size });
      }
      // Bài nghe dài nhất/lớn nhất đứng đầu.
      out.sort((a, b) => b.size - a.size);
      return out;
    } catch (e) {
      return [];
    }
  }

  // BUG#45b (live 22/09/2026, chim-hai-tao — Vòng 7 Bài 4): đường BUG#45 đoán
  // theo KÍCH THƯỚC file trong performance entries là SAI. File mp3 to nhất
  // (1.13 MB) hoá ra là NHẠC NỀN của game — AudioManager._currentMusicUrl =
  // "sounds/NhacNenGame" — nên AI được nghe nhạc nền và trả lời theo câu khẳng
  // định, tiếp tục 20/100.
  // Đường ĐÚNG: component AudioContent (node nAudioQuest) giữ trường `remoteSound`
  // = URL bài nghe thật. Live-verified sau khi bấm SOUND_REPLAY_BTN:
  //   https://cdn-s3.vtconline.vn/.../Lop11/Vong7/Amthanh/E11_V7_1.mp3
  // Trước khi bấm thì remoteSound còn null → hàm này trả rỗng, caller phải bấm
  // SOUND_REPLAY_BTN rồi đọc lại.
  function getQuestAudioUrl() {
    try {
      let found = null;
      const walk = (n, d) => {
        if (found || d > 16) return;
        try {
          for (const c of (n._components || [])) {
            const cn = (c && c.__classname__) || (c && c.constructor && c.constructor.name) || "";
            if (/AudioContent/i.test(cn) && c.remoteSound) { found = String(c.remoteSound); return; }
          }
        } catch (e) {}
        for (const ch of (n.children || [])) walk(ch, d + 1);
      };
      const sc = getCC() && getCC().director && getCC().director.getScene();
      if (sc) walk(sc, 0);
      return found;
    } catch (e) {
      return null;
    }
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source && ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__ioeBridgeRequest) return;
    const reqId = d.reqId || null;
    try {
      switch (d.type) {
        case "SCAN_LABELS":
          reply(reqId, "LABELS", scanLabels());
          break;
        case "SYNC_STATE":
          emit("SYNC");
          reply(reqId, "SYNC_OK", state.questions ? state.questions.length : 0);
          break;
        case "LIST_NODES":
          reply(reqId, "NODES", listNodes());
          break;
        case "CURRENT_QUESTION":
          reply(reqId, "CURRENT_QUESTION_OK", currentQuestionInfo());
          break;
        case "GET_PASSAGE":
          // BUG#38: đoạn văn SẠCH (node conv_content_scroll), tách khỏi câu hỏi.
          reply(reqId, "GET_PASSAGE_OK", { passage: getPassageText() });
          break;
        case "GET_AUDIO_URLS":
          // BUG#45b: URL bài nghe THẬT lấy từ AudioContent.remoteSound (KHÔNG dùng
          // kích thước file trong performance — file to nhất là nhạc nền).
          reply(reqId, "GET_AUDIO_URLS_OK", { quest: getQuestAudioUrl(), urls: getAudioUrlsFromPerf() });
          break;
        case "PLAY_QUEST_AUDIO":
          // BUG#45b: bấm nút replay để game nạp remoteSound (trước đó là null).
          reply(reqId, "PLAY_QUEST_AUDIO_OK", clickNameSmart("SOUND_REPLAY_BTN"));
          break;
        case "START_GAME":
          reply(reqId, "START_GAME_OK", await startGame());
          break;
        case "CLICK_TEXT":
          reply(reqId, "CLICK_TEXT_OK", { ok: clickNode(findClickTargetByText((d.data || {}).text, { contains: !!(d.data || {}).contains })) });
          break;
        case "CLICK_NAME":
          reply(reqId, "CLICK_NAME_OK", clickNameSmart((d.data || {}).name));
          break;
        case "CLICK_QUEST_ITEM":
          reply(reqId, "CLICK_QUEST_ITEM_OK", clickQuestItem((d.data || {}).index));
          break;
        case "COUNT_QUEST_ITEMS":
          // BUG#40: đếm ô chuyển câu đang active để biết game có nhiều câu trên
          // một màn hay không (an-khe-tra-vang = 5, game một-câu-một-màn = 0).
          reply(reqId, "COUNT_QUEST_ITEMS_OK", { count: countQuestItems() });
          break;
        case "ACTIVE_QUESTION_MODE":
          // BUG#52: game đọc hiểu TỪNG CÂU (nConversationQuest) có ĐOẠN VĂN RIÊNG
          // cho mỗi câu, còn trắc nghiệm/chọn cặp (nTracNghiem) thì không. Solver
          // phải biết đang ở chế độ nào để đọc lại đoạn văn trước mỗi câu — đọc
          // một lần rồi trả lời cả loạt là sai (live: 10/100).
          reply(reqId, "ACTIVE_QUESTION_MODE_OK", activeQuestionMode());
          break;
        case "AUTO_MATCH":
          reply(reqId, "AUTO_MATCH_STARTED", { total: ((d.data || {}).pairs || []).length });
          await autoMatch((d.data || {}).pairs || [], (d.data || {}).runId);
          break;
        case "CLICK_SEQUENCE":
          reply(reqId, "SEQ_OK", await clickSequence((d.data || {}).items || [], (d.data || {}).runId));
          break;
        case "TYPE_EDITBOX":
          reply(reqId, "TYPE_EDITBOX_OK", await typeIntoEditBox((d.data || {}).text, (d.data || {}).index));
          break;
        case "CONFIRM_ANSWER":
          reply(reqId, "CONFIRM_ANSWER_OK", confirmAnswer());
          break;
        case "DISMISS_POPUPS":
          reply(reqId, "DISMISS_POPUPS_OK", { closed: dismissSystemPopups() });
          break;
        case "LIST_EDITBOXES":
          reply(reqId, "EDITBOXES", findEditBoxes().map(b => ({ name: b.name, string: b.string })));
          break;
        case "CONTROLLER_INFO":
          (async () => {
            const c = findQuestionController();
            reply(reqId, "CONTROLLER_INFO_OK", c ? {
              found: true, inputTxt: c.inputTxt, canClick: c.canClick,
              hasDienDoanVan: !!c.dienDoanVan
            } : { found: false });
          })();
          break;
        case "READ_GAME_SCREEN":
          reply(reqId, "GAME_SCREEN", readGameScreen());
          break;
        case "FILL_EDITBOXES":
          reply(reqId, "FILL_EDITBOXES_OK", fillEditBoxes((d.data || {}).texts));
          break;
        case "SUBMIT_CLOZE":
          reply(reqId, "SUBMIT_CLOZE_OK", submitCloze((d.data || {}).words));
          break;
        case "SUBMIT_TRANSFORM":
          reply(reqId, "SUBMIT_TRANSFORM_OK", submitTransform((d.data || {}).words));
          break;
        case "CLICK_ANSWER_BTN":
          reply(reqId, "CLICK_ANSWER_BTN_OK", clickAnswerButton());
          break;
        case "FINISH_GAME":
          reply(reqId, "FINISH_GAME_OK", await finishGameDirect());
          break;
        default:
          break;
      }
    } catch (e) {
      reply(reqId, "ERROR", { message: e.message });
    }
  });

  window.__IOE_GAME_BRIDGE__ = {
    getState: () => JSON.parse(JSON.stringify(state)),
    isReady: () => state.ready,
    scanLabels: scanLabels,
    listNodes: listNodes,
    startGame: startGame,
    clickText: (t) => clickNode(findClickTargetByText(t, { contains: true })),
    clickName: (n) => clickNode(findNodeByName(n)),
    // BUG#32 diagnostics: resolve (without clicking) which node an option text
    // would hit — lets the solver/tests prove the mapping before mutating state.
    resolveText: (t) => { const n = findClickTargetByText(t, { contains: true }); return n ? { name: n.name, text: nodeText(n, 3), isButton: isButton(n) } : null; },
    typeIntoEditBox: typeIntoEditBox,
    confirmAnswer: confirmAnswer,
    dismissSystemPopups: dismissSystemPopups,
    findQuestionController: findQuestionController,
    readGameScreen: readGameScreen,
    fillEditBoxes: fillEditBoxes,
    submitCloze: submitCloze,
    clickAnswerButton: clickAnswerButton,
    // BUG#37: nộp cả bài bằng endGame() của chính game (game không có nút submit).
    finishGame: finishGameDirect,
    findGamePlay: findGamePlay,
    // BUG#38: đoạn văn sạch cho bài đọc hiểu (tách khỏi câu hỏi).
    getPassage: getPassageText
  };

  // Announce readiness so the isolated script can request a re-sync if needed.
  try {
    window.postMessage({ __ioeBridge: true, type: "BRIDGE_READY" }, window.location.origin);
  } catch (e) {}

  console.log("%c[IOE Bridge] Game API bridge armed (MAIN world).", "color:#6366f1;font-weight:bold");
})();
