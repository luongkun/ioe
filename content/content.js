/**
 * English Master AI - Content Script
 * Text selection is unblocked; a quick-solve toolbar appears on selection when
 * the autoShowToolbar setting is enabled (toggle in popup/options).
 */

(function () {
  if (window.__ENGLISH_MASTER_AI_LOADED__) return;
  window.__ENGLISH_MASTER_AI_LOADED__ = true;

  // Unblock text selection globally without annoying popups
  document.addEventListener("selectstart", (e) => e.stopImmediatePropagation(), true);
  document.addEventListener("contextmenu", (e) => e.stopImmediatePropagation(), true);

  let shadowRoot = null;
  let hostEl = null;
  let modalEl = null;
  let lastSelectedText = "";
  let currentTaskType = "mcq";
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  const TASK_TITLES = {
    mcq: "🎯 Giải trắc nghiệm",
    fill_blank: "✏️ Điền từ vào chỗ trống",
    grammar_check: "🛠️ Sửa ngữ pháp & Viết lại",
    translate_analyze: "📖 Dịch & Phân tích"
  };

  function initShadowHost() {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = "eng-master-ai-root";
    hostEl.style.position = "absolute";
    hostEl.style.top = "0";
    hostEl.style.left = "0";
    hostEl.style.width = "0";
    hostEl.style.height = "0";
    hostEl.style.zIndex = "2147483647";
    document.documentElement.appendChild(hostEl);

    shadowRoot = hostEl.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("content/content.css");
    shadowRoot.appendChild(link);
  }

  function hideModal() {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
  }

  function showToast(message) {
    if (!shadowRoot) return;
    const toast = document.createElement("div");
    toast.className = "ema-toast";
    toast.textContent = message;
    shadowRoot.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  function speakEnglish(text) {
    if (!("speechSynthesis" in window)) {
      showToast("Trình duyệt không hỗ trợ Text-to-Speech.");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
    showToast("🔊 Đang đọc phát âm...");
  }

  function openModalAndSolve(text, taskType) {
    initShadowHost();
    hideModal();

    currentTaskType = taskType || "mcq";
    lastSelectedText = text;

    modalEl = document.createElement("div");
    modalEl.className = "ema-modal";

    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;
    const leftPos = Math.max(20, (winWidth - 440) / 2);
    const topPos = Math.max(40, (winHeight - 520) / 2);

    modalEl.style.left = `${leftPos}px`;
    modalEl.style.top = `${topPos}px`;

    modalEl.innerHTML = `
      <div class="ema-header" id="ema-drag-header">
        <div class="ema-header-title">
          <div class="ema-header-logo">EM</div>
          <span id="ema-modal-title">${TASK_TITLES[currentTaskType] || "English Master AI"}</span>
        </div>
        <div class="ema-header-actions">
          <button class="ema-icon-btn" id="ema-tts-btn" title="Nghe đọc tiếng Anh">🔊</button>
          <button class="ema-icon-btn" id="ema-copy-btn" title="Sao chép kết quả">📋</button>
          <button class="ema-icon-btn" id="ema-close-btn" title="Đóng">✕</button>
        </div>
      </div>

      <div class="ema-tabs">
        <button class="ema-tab-btn ${currentTaskType === 'mcq' ? 'active' : ''}" data-task="mcq">🎯 Trắc nghiệm</button>
        <button class="ema-tab-btn ${currentTaskType === 'fill_blank' ? 'active' : ''}" data-task="fill_blank">✏️ Điền từ</button>
        <button class="ema-tab-btn ${currentTaskType === 'grammar_check' ? 'active' : ''}" data-task="grammar_check">🛠️ Sửa lỗi</button>
        <button class="ema-tab-btn ${currentTaskType === 'translate_analyze' ? 'active' : ''}" data-task="translate_analyze">📖 Dịch & Phân tích</button>
      </div>

      <div class="ema-question-preview" title="Đề bài">
        ${escapeHtml(text)}
      </div>

      <div class="ema-body" id="ema-body-content">
        <div class="ema-loading-box">
          <div class="ema-spinner"></div>
          <div class="ema-loading-text">AI đang phân tích và giải bài...</div>
        </div>
      </div>
    `;

    const header = modalEl.querySelector("#ema-drag-header");
    const closeBtn = modalEl.querySelector("#ema-close-btn");
    const copyBtn = modalEl.querySelector("#ema-copy-btn");
    const ttsBtn = modalEl.querySelector("#ema-tts-btn");
    const tabs = modalEl.querySelectorAll(".ema-tab-btn");

    closeBtn.addEventListener("click", hideModal);

    copyBtn.addEventListener("click", () => {
      const bodyEl = modalEl.querySelector("#ema-body-content");
      if (bodyEl) {
        navigator.clipboard.writeText(bodyEl.innerText || "");
        showToast("Đã sao chép kết quả!");
      }
    });

    ttsBtn.addEventListener("click", () => {
      speakEnglish(lastSelectedText);
    });

    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        const newTask = tab.getAttribute("data-task");
        if (newTask === currentTaskType) return;
        tabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentTaskType = newTask;
        modalEl.querySelector("#ema-modal-title").textContent = TASK_TITLES[currentTaskType];
        executeSolveRequest(lastSelectedText, currentTaskType);
      });
    });

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".ema-header-actions")) return;
      isDragging = true;
      const rect = modalEl.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });

    shadowRoot.appendChild(modalEl);
    executeSolveRequest(text, currentTaskType);
  }

  document.addEventListener("mousemove", (e) => {
    if (!isDragging || !modalEl) return;
    const newX = Math.max(10, Math.min(window.innerWidth - modalEl.offsetWidth - 10, e.clientX - dragOffset.x));
    const newY = Math.max(10, Math.min(window.innerHeight - modalEl.offsetHeight - 10, e.clientY - dragOffset.y));
    modalEl.style.left = `${newX}px`;
    modalEl.style.top = `${newY}px`;
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });

  function executeSolveRequest(text, taskType) {
    const bodyEl = modalEl.querySelector("#ema-body-content");
    if (!bodyEl) return;

    bodyEl.innerHTML = `
      <div class="ema-loading-box">
        <div class="ema-spinner"></div>
        <div class="ema-loading-text">AI đang phân tích và giải bài...</div>
      </div>
    `;

    chrome.runtime.sendMessage(
      {
        action: "SOLVE_QUESTION",
        text: text,
        taskType: taskType
      },
      (response) => {
        if (!modalEl) return;
        if (!response) {
          renderError("Không thể kết nối đến extension service worker. Vui lòng tải lại trang.");
          return;
        }

        if (response.success) {
          const parsedHtml = (window.marked && window.marked.parse) ? window.marked.parse(response.data) : escapeHtml(response.data);
          bodyEl.innerHTML = parsedHtml;
        } else {
          renderError(response.error || "Đã xảy ra lỗi khi gọi AI.");
        }
      }
    );
  }

  function renderError(errMsg) {
    const bodyEl = modalEl.querySelector("#ema-body-content");
    if (!bodyEl) return;
    bodyEl.innerHTML = `
      <div class="ema-error-box">
        <strong>⚠️ Lỗi:</strong> ${escapeHtml(errMsg)}
      </div>
    `;
  }

  function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ===== Floating selection toolbar =====
  // The autoShowToolbar setting (popup/options) and the user guide both promise a
  // quick-solve toolbar on text selection, but it had been removed. This restores
  // it and makes the setting functional.
  let autoShowToolbar = true;
  let toolbarEl = null;

  chrome.storage.local.get({ autoShowToolbar: true }, (cfg) => {
    autoShowToolbar = cfg.autoShowToolbar !== false;
  });

  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.autoShowToolbar) {
        autoShowToolbar = changes.autoShowToolbar.newValue !== false;
        if (!autoShowToolbar) hideToolbar();
      }
    });
  }

  function hideToolbar() {
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
  }

  function showSelectionToolbar(text, rect) {
    initShadowHost();
    hideToolbar();

    toolbarEl = document.createElement("div");
    toolbarEl.className = "ema-selection-toolbar";

    const buttons = [
      { task: "mcq", label: "🎯 Trắc nghiệm" },
      { task: "fill_blank", label: "✏️ Điền từ" },
      { task: "grammar_check", label: "🛠️ Sửa lỗi" },
      { task: "translate_analyze", label: "📖 Dịch" }
    ];

    buttons.forEach((b) => {
      const btn = document.createElement("button");
      btn.className = "ema-toolbar-btn";
      btn.textContent = b.label;
      // Keep the page selection alive when the button is pressed.
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        hideToolbar();
        openModalAndSolve(text, b.task);
      });
      toolbarEl.appendChild(btn);
    });

    const width = 268;
    let left = rect.left + (rect.width / 2) - (width / 2);
    left = Math.max(8, Math.min(window.innerWidth - width - 8, left));
    let top = rect.top - 44;
    if (top < 8) top = rect.bottom + 8;
    toolbarEl.style.left = `${left}px`;
    toolbarEl.style.top = `${top}px`;

    shadowRoot.appendChild(toolbarEl);
  }

  document.addEventListener("mouseup", (e) => {
    if (!autoShowToolbar) return;
    if (hostEl && e.composedPath && e.composedPath().includes(hostEl)) return;

    // Let the browser finalize the selection before reading it.
    setTimeout(() => {
      const active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;

      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || text.length < 3 || text.length > 1000) return;

      let rect = null;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (err) {}
      if (!rect || (rect.width === 0 && rect.height === 0)) return;

      showSelectionToolbar(text, rect);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (hostEl && e.composedPath && e.composedPath().includes(hostEl)) return;
    hideToolbar();
  });

  window.addEventListener("scroll", hideToolbar, true);

  // Listen for context menu trigger from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "TRIGGER_SOLVE_FROM_CONTEXT_MENU") {
      openModalAndSolve(msg.text, msg.taskType);
    }
  });

})();
