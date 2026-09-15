/**
 * Mock Cocos Creator runtime — mô phỏng đủ API mà game-api-bridge.js dùng:
 *   cc.director.getScene() / node.children / activeInHierarchy
 *   node.getComponent(cc.Label | cc.Button | cc.EditBox)
 *   node.convertToWorldSpaceAR(cc.v2(0,0)) / cc.view.getVisibleSize()
 *   node.emit("click") + DOM MouseEvents trên #GameCanvas
 * Trang gọi: window.MOCK_GAME.init({ type: 'fillword'|'mcq', questions: [...] })
 */
(function () {
  const CANVAS_W = 900, CANVAS_H = 560;

  function CCClass(name) { function C() { this.__name = name; } C.prototype.toString = () => name; return C; }
  const cc = {
    v2: (x, y) => ({ x, y }),
    Label: CCClass("Label"),
    Button: CCClass("Button"),
    EditBox: CCClass("EditBox"),
    director: { getScene: () => scene },
    view: { getVisibleSize: () => ({ width: CANVAS_W, height: CANVAS_H }) }
  };
  cc.EditBox.EventType = { TEXT_CHANGED: "text-changed", EDITING_DID_ENDED: "editing-did-ended" };
  window.cc = cc;

  // ---------- node factory ----------
  function makeNode(name, x, y, opts = {}) {
    const node = {
      name, x, y,
      width: opts.width || 120, height: opts.height || 50,
      parent: opts.parent || null,
      children: [],
      activeInHierarchy: true,
      _handlers: {},
      on(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
      emit(type, ...args) {
        (this._handlers[type] || []).forEach(fn => { try { fn(...args); } catch (e) { console.warn(e); } });
      },
      convertToWorldSpaceAR() { return { x: this.x, y: this.y }; },
      getComponent(C) {
        if (C === cc.Label && this._label) return { string: this._label };
        if (C === cc.Button && this._isButton) return {};
        if (C === cc.EditBox && this._editBox) return this._editBox;
        return null;
      },
      setLabel(text) { this._label = text; },
      _isButton: !!opts.button,
      _label: null
    };
    (opts.parent || scene).children.push(node);
    return node;
  }

  // ---------- scene ----------
  const scene = { name: "MockScene", children: [], parent: null, x: 0, y: 0, activeInHierarchy: true };
  const startLayer = { name: "StartLayer", x: 0, y: 0, parent: scene, children: [], activeInHierarchy: true };
  scene.children.push(startLayer);
  const gameLayer = { name: "GameLayer", x: 0, y: 0, parent: scene, children: [], activeInHierarchy: true };
  scene.children.push(gameLayer);

  const startBtn = makeNode("start_btn", 450, 90, { parent: startLayer, button: true, width: 220, height: 70 });
  startBtn.setLabel("BẮT ĐẦU");
  const startLabel = makeNode("start_label", 450, 90, { parent: startLayer, width: 200, height: 40 });
  startLabel.setLabel("BẮT ĐẦU");

  const promptLabel = makeNode("prompt_label", 450, 420, { parent: gameLayer, width: 700, height: 60 });
  const counterLabel = makeNode("counter_label", 450, 500, { parent: gameLayer, width: 120, height: 40 });
  const editBoxNode = makeNode("itemAnswer", 450, 260, { parent: gameLayer, width: 320, height: 56 });
  const editBox = {
    string: "",
    node: editBoxNode,
    focus() {},
    _handlers: {}
  };
  editBoxNode._editBox = editBox;
  const answerBtn = makeNode("btn_answer", 720, 260, { parent: gameLayer, button: true, width: 150, height: 56 });
  answerBtn.setLabel("ANSWER");
  const doneLabel = makeNode("done_label", 450, 200, { parent: gameLayer, width: 400, height: 50 });

  // MCQ option buttons (chỉ dùng ở chế độ mcq)
  const optNodes = [];
  const OPT_POS = [[260, 150, "optA"], [640, 150, "optB"], [260, 230, "optC"], [640, 230, "optD"]];
  OPT_POS.forEach(([x, y, nm]) => {
    const n = makeNode(nm, x, y, { parent: gameLayer, button: true, width: 300, height: 60 });
    optNodes.push(n);
  });

  // ---------- game state ----------
  const state = {
    type: "fillword",
    questions: [],
    current: -1,       // 0-based; -1 = chưa start
    started: false,
    finished: false,
    submitted: [],     // [{ q, answer }] — kết quả assert trong test
    typedEvents: []    // các lần EditBox nhận chữ
  };
  window.MOCK_GAME_STATE = state;

  function showQuestion(i) {
    state.current = i;
    const q = state.questions[i];
    promptLabel.setLabel(q.prompt);
    counterLabel.setLabel(`${i + 1}/${state.questions.length}`);
    editBox.string = "";
    if (state.type === "mcq") {
      q.answers.forEach((a, k) => optNodes[k] && optNodes[k].setLabel(a));
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    startLayer.activeInHierarchy = false;
    startBtn.activeInHierarchy = false;
    startLabel.activeInHierarchy = false;
    showQuestion(0);
  }

  function submitAnswer(word) {
    state.submitted.push({ q: state.current, answer: word });
    if (state.current + 1 >= state.questions.length) {
      state.finished = true;
      promptLabel.setLabel("HOÀN THÀNH BÀI THI MOCK");
      counterLabel.setLabel(`${state.questions.length}/${state.questions.length}`);
      doneLabel.setLabel(`DONE ${state.submitted.length} answers`);
      editBoxNode.activeInHierarchy = false;
      answerBtn.activeInHierarchy = false;
      optNodes.forEach(n => { n.activeInHierarchy = false; });
    } else {
      showQuestion(state.current + 1);
    }
  }

  startBtn.on("click", start);
  answerBtn.on("click", () => submitAnswer(editBox.string));
  editBoxNode.on && editBoxNode.on("text-changed", (w) => state.typedEvents.push(String(w)));

  // click trên option MCQ → submit ngay (giống game thật: chọn xong tự sang câu)
  optNodes.forEach((n, idx) => {
    n.on("click", () => {
      const q = state.questions[state.current];
      submitAnswer((q && q.answers && q.answers[idx]) || "");
    });
  });

  // ---------- canvas click → node (đảo ngược designToClient của bridge) ----------
  const canvas = document.getElementById("GameCanvas");
  function clientToDesign(ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / CANVAS_W, sy = rect.height / CANVAS_H;
    return { x: (ev.clientX - rect.left) / sx, y: CANVAS_H - (ev.clientY - rect.top) / sy };
  }
  function nodeAt(pt) {
    const cands = [startBtn, answerBtn, ...optNodes];
    for (const n of cands) {
      if (!n.activeInHierarchy) continue;
      if (Math.abs(pt.x - n.x) <= n.width / 2 && Math.abs(pt.y - n.y) <= n.height / 2) return n;
    }
    return null;
  }
  // Chỉ nhận "click" trọn vẹn (như engine thật) — mousedown/mouseup không tính riêng
  canvas.addEventListener("click", (ev) => {
    const n = nodeAt(clientToDesign(ev));
    if (n) n.emit("click");
  });

  // ---------- fetch đề từ API (bridge sẽ bắt được request này) ----------
  window.MOCK_GAME = {
    init(config) {
      state.type = config.type;
      state.questions = config.questions;
      promptLabel.setLabel(config.type === "fillword" ? "Nhấn BẮT ĐẦU để làm bài nghe điền từ" : "Nhấn BẮT ĐẦU để làm bài trắc nghiệm");
      counterLabel.setLabel("0/" + config.questions.length);
      fetch("/ioe-service/v2/game/getinfo?type=" + config.type)
        .then(r => r.json())
        .then(j => { window.MOCK_GETINFO = j; console.log("[MockGame] getinfo fetched, questions:", j.data.game.question.length); })
        .catch(e => console.warn("[MockGame] getinfo failed", e));
    }
  };
})();
