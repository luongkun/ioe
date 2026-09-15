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
    try {
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

  function labelOf(node) {
    const cc = getCC();
    try {
      const l = cc.Label && node.getComponent ? node.getComponent(cc.Label) : null;
      if (l && typeof l.string === "string" && l.string.trim()) return l.string.replace(/\s+/g, " ").trim();
    } catch (e) {}
    return null;
  }

  // Return the displayed text of a node: own Label or first descendant Label
  function nodeText(node) {
    const own = labelOf(node);
    if (own) return own;
    for (const c of (node.children || [])) {
      const t = labelOf(c);
      if (t) return t;
      for (const g of (c.children || [])) {
        const t2 = labelOf(g);
        if (t2) return t2;
      }
    }
    return null;
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

  function isButton(node) {
    const cc = getCC();
    try { return !!(cc.Button && node.getComponent && node.getComponent(cc.Button)); } catch (e) { return false; }
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
    // 1. Close intro/warning popups — the real games show a system-requirements
    //    dialog whose button is named btnOK (plus btn_close variants).
    const closedNames = ["btn_close", "btnClose", "btnOK", "ok_btn", "btn_ok", "btnOkay"];
    for (const nm of closedNames) {
      const n = findNodeByName(nm);
      if (n) { try { n.emit("click"); closed++; } catch (e) {} }
    }
    // Also close any active button whose label is exactly "OK"
    const okLabel = findNodeByText("ok", { contains: false });
    if (okLabel && isButton(okLabel)) { try { okLabel.emit("click"); closed++; } catch (e) {} }
    // Give the scene a beat to settle after closing the popup BEFORE pressing
    // start — pressing both in the same tick loses the start press (the scene
    // is still switching) and the round dies instantly with "Total Time 00:00".
    await sleep(700);
    // 2. Start the game — ONLY the real start button (emit only).
    //    NEVER touch GAME_PLAY / play / start: those are full-screen containers whose
    //    center overlaps an answer card → would select an option before solving!
    const n = findNodeByName("start_btn");
    if (n) { try { n.emit("click"); started++; } catch (e) {} }
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

  async function autoMatch(pairs, runId) {
    let done = 0, failed = 0;
    for (let i = 0; i < pairs.length; i++) {
      const a = pairs[i][0], b = pairs[i][1];
      // Wait for EACH card to be live before clicking — clicking a card that is
      // still animating in is a silent no-op and derails the whole round
      // (observed live: "Wrong attempt" cascade → score 0).
      const na = await waitForNodeByText(a, 6000);
      if (na) { clickNode(na); done++; }
      await sleep(getRandom(180, 320));
      // Pass na as the exclusion: when two cards share the same text (Q/A echo
      // pairs like "How do you do?"), the second click must land on the OTHER card.
      const nb = await waitForNodeByText(b, 4000, na || undefined);
      if (nb) { clickNode(nb); done++; }
      else failed++;
      await sleep(getRandom(300, 500));
      window.postMessage({ __ioeBridge: true, type: "MATCH_PROGRESS", payload: { runId, pair: pairs[i], index: i, total: pairs.length, okA: !!na, okB: !!nb } }, window.location.origin);
    }
    window.postMessage({ __ioeBridge: true, type: "MATCH_DONE", payload: { runId, done, failed, total: pairs.length } }, window.location.origin);
    return { done, failed };
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

    // --- 0. THE REAL PATH: drive the game's own controller (live-validated:
    //     this is the only route that updates inputTxt → validation → submit;
    //     direct eb.string assignment renders nothing and the game rejects it
    //     with "Vui lòng nhập đủ số ký tự"). ---
    try {
      const ctrl = findQuestionController();
      if (ctrl) {
        ctrl.onEditTextChange(word);          // inputTxt = word
        try { if (ctrl.dienDoanVan && ctrl.dienDoanVan.getFirstEditBox) { const fe = ctrl.dienDoanVan.getFirstEditBox(); if (fe) fe.string = word; } } catch (e) {}
        viaController = true;
      }
    } catch (e) {}

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
    return { ok: true, boxes: boxes.length, typed: word, typedViaDom, viaController, dismissed };
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
        return { ok: true, via: "controller.onKeyEnterPress" };
      }
    } catch (e) {}
    // 1. Well-known button node names
    const names = ["btn_answer", "btnAnswer", "answer_btn", "btnSubmit", "btn_submit", "submit_btn", "btnOK", "ok_btn", "btn_ok"];
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
  function currentQuestionInfo() {
    const cc = getCC();
    const labels = scanLabels();
    const out = { text: "", qnum: null, raw: labels.length };

    // 1. Find a "3/10", "Câu 3/10" or "3 / 10" style counter
    for (const l of labels) {
      const m = String(l.text || "").match(/(?:c\u00e2u\s*)?(\d+)\s*\/\s*(\d+)/i);
      if (m) { out.qnum = parseInt(m[1]); out.total = parseInt(m[2]); break; }
    }

    // 2. Longest visible label = the question statement (statement is longer
    //    than buttons/counters/audio hints like "Click to replay").
    let best = "";
    for (const l of labels) {
      const t = String(l.text || "").trim();
      if (t.length > best.length && t.length >= 15) best = t;
    }
    out.text = best;
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
        case "START_GAME":
          reply(reqId, "START_GAME_OK", await startGame());
          break;
        case "CLICK_TEXT":
          reply(reqId, "CLICK_TEXT_OK", { ok: clickNode(findNodeByText((d.data || {}).text, { contains: !!(d.data || {}).contains })) });
          break;
        case "CLICK_NAME":
          reply(reqId, "CLICK_NAME_OK", { ok: clickNode(findNodeByName((d.data || {}).name)) });
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
    clickText: (t) => clickNode(findNodeByText(t, { contains: true })),
    clickName: (n) => clickNode(findNodeByName(n)),
    typeIntoEditBox: typeIntoEditBox,
    confirmAnswer: confirmAnswer,
    dismissSystemPopups: dismissSystemPopups,
    findQuestionController: findQuestionController
  };

  // Announce readiness so the isolated script can request a re-sync if needed.
  try {
    window.postMessage({ __ioeBridge: true, type: "BRIDGE_READY" }, window.location.origin);
  } catch (e) {}

  console.log("%c[IOE Bridge] Game API bridge armed (MAIN world).", "color:#6366f1;font-weight:bold");
})();
