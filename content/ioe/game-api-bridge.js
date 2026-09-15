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

  function normalizeGetInfo(json) {
    const g = json && json.data && json.data.game;
    if (!g) return null;
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
      if (normalizeGetInfo(json)) {
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

  function clickNode(node) {
    if (!node) return false;
    const world = nodeWorld(node);
    const pt = designToClient(world);
    if (!pt.ok) return false;
    return domClickAt(pt.x, pt.y);
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

  function startGame() {
    let closed = 0, started = 0;
    // 1. Close intro/warning popups (emit only — never DOM-click, popup is not a gameplay node)
    const closedNames = ["btn_close", "btnClose"];
    for (const nm of closedNames) {
      const n = findNodeByName(nm);
      if (n) { try { n.emit("click"); closed++; } catch (e) {} }
    }
    // 2. Start the game — ONLY the real start button (emit only).
    //    NEVER touch GAME_PLAY / play / start: those are full-screen containers whose
    //    center overlaps an answer card → would select an option before solving!
    const n = findNodeByName("start_btn");
    if (n) { try { n.emit("click"); started++; } catch (e) {} }
    return { closed, started, scene: (getCC() && getCC().director ? (getCC().director.getScene() || {}).name : null) };
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function autoMatch(pairs, runId) {
    let done = 0, failed = 0;
    for (let i = 0; i < pairs.length; i++) {
      const a = pairs[i][0], b = pairs[i][1];
      const na = findNodeByText(a, { contains: true });
      if (na) { clickNode(na); done++; }
      await sleep(getRandom(350, 550));
      const nb = findNodeByText(b, { contains: true });
      if (nb) { clickNode(nb); done++; }
      else failed++;
      await sleep(getRandom(750, 1050));
      window.postMessage({ __ioeBridge: true, type: "MATCH_PROGRESS", payload: { runId, pair: pairs[i], index: i, total: pairs.length } }, window.location.origin);
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
          reply(reqId, "START_GAME_OK", startGame());
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
    clickName: (n) => clickNode(findNodeByName(n))
  };

  // Announce readiness so the isolated script can request a re-sync if needed.
  try {
    window.postMessage({ __ioeBridge: true, type: "BRIDGE_READY" }, window.location.origin);
  } catch (e) {}

  console.log("%c[IOE Bridge] Game API bridge armed (MAIN world).", "color:#6366f1;font-weight:bold");
})();
