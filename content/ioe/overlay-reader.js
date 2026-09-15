/**
 * English Master AI - Overlay Reader v1.0
 * Deterministic multi-source question text extraction for IOE:
 *   DOM text nodes • Shadow DOM • same-origin iframes • CreateJS/EaselJS canvas text • game memory
 * Reconstructs reading order and de-duplicates noise so the overlay can display/edit
 * exactly what the AI is asked to solve.
 *
 * Exposes: window.__IOE_OVERLAY_READER__
 */

(function () {
  if (window.__IOE_OVERLAY_READER__) return;

  const EXCLUDE_SELECTOR = "#ioe-master-root, #eng-master-ai-root, script, style, noscript, link, meta, head";
  const MIN_BLOCK_LEN = 2;
  const MAX_RESULT_CHARS = 12000;

  function clean(s) {
    return (s || "").replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
  }

  function norm(s) {
    return clean(s).toLowerCase();
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
    if (rect.width < 1 || rect.height < 1) return false;
    let cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return true; }
    if (!cs) return true;
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity || "1") === 0) return false;
    return true;
  }

  function directText(el) {
    let t = "";
    try {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) t += " " + node.nodeValue;
      }
    } catch (e) {}
    return clean(t);
  }

  // ---------- 1. DOM leaf block collection (Shadow-DOM aware) ----------
  function collectLeafBlocks(root, out, depth) {
    if (!root || depth > 40) return;
    let children = [];
    try { children = Array.from(root.children || []); } catch (e) { return; }

    if (children.length === 0) return;

    const tag = (root.tagName || "").toUpperCase();
    const excluded = (root.matches && root.matches(EXCLUDE_SELECTOR)) ||
      tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT";

    const own = directText(root);
    if (!excluded && own.length >= MIN_BLOCK_LEN && isVisible(root)) {
      let rect = { left: 0, top: 0, width: 0, height: 0 };
      try { rect = root.getBoundingClientRect(); } catch (e) {}
      let fontSize = 14;
      try { fontSize = parseFloat(window.getComputedStyle(root).fontSize) || 14; } catch (e) {}
      out.push({ text: own, x: rect.left, y: rect.top, w: rect.width, h: rect.height, fontSize });
    }

    for (const child of children) {
      if (child.shadowRoot) collectLeafBlocks(child.shadowRoot, out, depth + 1);
      collectLeafBlocks(child, out, depth + 1);
    }
  }

  function collectIframeBlocks() {
    const out = [];
    const iframes = document.querySelectorAll("iframe");
    for (const frame of iframes) {
      try {
        const doc = frame.contentDocument;
        if (doc && doc.body) collectLeafBlocks(doc.body, out, 0);
      } catch (e) {}
    }
    return out;
  }

  function readDomBlocks() {
    const blocks = [];
    if (document.body) collectLeafBlocks(document.body, blocks, 0);
    blocks.push(...collectIframeBlocks());

    // Sort in reading order: top -> bottom, left -> right with row tolerance
    blocks.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 8) return a.y - b.y;
      return a.x - b.x;
    });

    return blocks;
  }

  // ---------- 2. Known high-value containers ----------
  const KNOWN_SELECTORS = [
    ".reading-content", ".passage", ".reading-text", ".text-reading",
    "#contentReading", ".exam-reading", ".box-reading", ".scroll-text",
    "#txtQuestion", ".question-title", ".question-content",
    ".question-title-2", ".title-question", "#contentQuestion"
  ];

  function readKnownContainers() {
    const out = [];
    for (const sel of KNOWN_SELECTORS) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
      for (const el of els) {
        if (!isVisible(el)) continue;
        const txt = clean(el.innerText || el.textContent || "");
        if (txt.length >= 20) out.push(txt);
      }
    }
    return out;
  }

  // ---------- 3. CreateJS / EaselJS canvas text ----------
  function findStage() {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { canvas: null, stage: null };
    const win = (canvas.ownerDocument && canvas.ownerDocument.defaultView) || window;
    let stage = null;
    try {
      stage = win.stage ||
        (win.exportRoot && win.exportRoot.stage) ||
        (win.createjs && win.createjs.Stage && win.createjs.Stage._stages && win.createjs.Stage._stages[0]) ||
        null;
    } catch (e) {}
    return { canvas, stage };
  }

  function readCanvasStageText() {
    const { stage } = findStage();
    if (!stage) return "";
    const items = [];

    function walk(obj, depth) {
      if (!obj || depth > 60) return;
      if (obj.visible === false) return;
      if (obj.text && typeof obj.text === "string") {
        const t = clean(obj.text);
        if (t.length >= 2) {
          let gx = 0, gy = 0;
          try {
            const p = obj.localToGlobal ? obj.localToGlobal(0, 0) : { x: obj.x || 0, y: obj.y || 0 };
            gx = p.x; gy = p.y;
          } catch (e) { gx = obj.x || 0; gy = obj.y || 0; }
          let fs = 14;
          try { fs = obj.font ? parseFloat(obj.font) || 14 : 14; } catch (e) {}
          items.push({ text: t, x: gx, y: gy, fontSize: fs });
        }
      }
      if (obj.children && Array.isArray(obj.children)) {
        for (const c of obj.children) walk(c, depth + 1);
      }
    }

    try { walk(stage, 0); } catch (e) {}
    if (items.length === 0) return "";

    items.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 12) return a.y - b.y;
      return a.x - b.x;
    });
    return items.map(i => i.text).join("\n");
  }

  // ---------- 4. Global game memory ----------
  function readGameMemoryText() {
    const candidateKeys = [
      "curQuestion", "currentQuestion", "gameData", "testData", "currentQues",
      "questionData", "examData", "listQuestion", "questionInfo", "game_data"
    ];
    const found = [];
    for (const k of candidateKeys) {
      const data = window[k];
      if (!data || typeof data !== "object") continue;
      try {
        const str = JSON.stringify(data);
        const matches = str.match(/"(?:content|reading|passage|text|story|question|title)"\s*:\s*"([^"]{25,})"/gi);
        if (matches) {
          for (const m of matches) {
            const c = m.replace(/^[^:]+:\s*"/, "").replace(/"$/, "")
              .replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
            const ct = clean(c);
            if (ct.length >= 25) found.push(ct);
          }
        }
      } catch (e) {}
    }
    return found;
  }

  // ---------- 5. Merge + de-duplicate ----------
  function addUnique(list, text) {
    const t = clean(text);
    const n = norm(t);
    if (!n || n.length < MIN_BLOCK_LEN) return;
    for (const existing of list) {
      const en = norm(existing.text !== undefined ? existing.text : existing);
      if (en === n) return;
      if (en.includes(n)) return;          // candidate is a fragment of an existing richer block
      if (n.includes(en)) {                // candidate richer -> replace fragment
        existing.text = t;
        return;
      }
    }
    list.push({ text: t });
  }

  function buildText(sources) {
    const merged = [];
    // Highest priority: known containers, canvas reconstruction, memory
    sources.known.forEach(t => addUnique(merged, t));
    if (sources.canvas) addUnique(merged, sources.canvas);
    sources.memory.forEach(t => addUnique(merged, t));
    // Fallback: DOM leaf blocks in reading order
    sources.blocks.forEach(b => addUnique(merged, b.text));

    let out = merged.map(m => m.text).join("\n").trim();
    if (out.length > MAX_RESULT_CHARS) out = out.slice(0, MAX_RESULT_CHARS);
    return out;
  }

  function readStructured() {
    let blocks = [];
    try { blocks = readDomBlocks(); } catch (e) {}
    let known = [];
    try { known = readKnownContainers(); } catch (e) {}
    let canvas = "";
    try { canvas = readCanvasStageText(); } catch (e) {}
    let memory = [];
    try { memory = readGameMemoryText(); } catch (e) {}

    const sources = { blocks, known, canvas, memory };
    const text = buildText(sources);

    return {
      text,
      stats: {
        domBlocks: blocks.length,
        knownContainers: known.length,
        hasCanvasText: !!canvas,
        memoryStrings: memory.length,
        chars: text.length
      }
    };
  }

  function readQuestionText() {
    try {
      const r = readStructured();
      return r.text || "";
    } catch (e) {
      console.warn("[English Master AI] Overlay reader failed:", e);
      return "";
    }
  }

  window.__IOE_OVERLAY_READER__ = {
    readQuestionText,
    readStructured,
    readCanvasStageText,
    readGameMemoryText,
    readDomBlocks
  };
})();
