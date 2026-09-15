/**
 * English Master AI - Deterministic DOM & Canvas Slot Inspector
 * Extracts exact slot count, maxlengths, and underline widths directly from the webpage
 */

(function () {
  if (window.__IOE_SLOT_INSPECTOR__) return;

  window.__IOE_SLOT_INSPECTOR__ = {
    // 1. Inspect DOM inputs & attributes
    inspectDOMSlots: function () {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, .input-answer, .fill-blank, .blank-slot'));
      const visibleInputs = inputs.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== "none" && window.getComputedStyle(el).visibility !== "hidden";
      });

      if (visibleInputs.length > 0) {
        const slotDetails = visibleInputs.map((el, i) => {
          const maxLen = el.getAttribute("maxlength") || el.maxLength;
          const size = el.getAttribute("size") || el.size;
          return {
            slot: i + 1,
            maxLen: (maxLen && maxLen > 0 && maxLen < 100) ? parseInt(maxLen) : null,
            placeholder: el.placeholder || "",
            value: el.value || ""
          };
        });

        return {
          source: "DOM_INPUTS",
          count: visibleInputs.length,
          slots: slotDetails
        };
      }
      return null;
    },

    // 2. Inspect IOE Game Memory / Global JavaScript Variables
    inspectGameMemory: function () {
      const candidateKeys = [
        "curQuestion", "currentQuestion", "gameData", "testData", "currentQues",
        "questionData", "listQuestion", "questionInfo", "game_data", "examData"
      ];

      for (const k of candidateKeys) {
        if (window[k]) {
          try {
            const data = window[k];
            if (typeof data === "object") {
              const str = JSON.stringify(data);
              if (str.length > 10 && str.length < 5000) {
                return { source: "GAME_MEMORY", key: k, data: data };
              }
            }
          } catch (e) {}
        }
      }
      return null;
    },

    // 3. Pixel-level Underline & Slot Analyzer (Deterministic Computer Vision)
    inspectCanvasUnderlines: function (canvas) {
      if (!canvas) canvas = document.querySelector("canvas");
      if (!canvas) return null;

      try {
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        const width = canvas.width;
        const height = canvas.height;
        // Scan the bottom half of the canvas where answer underlines typically reside
        const startY = Math.floor(height * 0.45);
        const endY = Math.floor(height * 0.85);

        const imgData = ctx.getImageData(0, startY, width, endY - startY);
        const data = imgData.data;

        // Find consecutive horizontal bright line segments (underlines)
        let underlineSegments = [];
        for (let y = 0; y < (endY - startY); y += 4) {
          let lineStart = -1;
          for (let x = 0; x < width; x += 3) {
            const idx = (y * width + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            // Check for white / light cyan underline pixels
            const isUnderlineColor = (r > 200 && g > 200 && b > 200) || (g > 210 && b > 210);

            if (isUnderlineColor) {
              if (lineStart === -1) lineStart = x;
            } else {
              if (lineStart !== -1) {
                const len = x - lineStart;
                if (len >= 35 && len <= 300) {
                  underlineSegments.push({ y: startY + y, x: lineStart, width: len });
                }
                lineStart = -1;
              }
            }
          }
        }

        // Group detected lines on similar Y coordinate
        if (underlineSegments.length > 0) {
          // Sort by Y and cluster
          const clusters = {};
          underlineSegments.forEach(seg => {
            const key = Math.round(seg.y / 15) * 15;
            clusters[key] = clusters[key] || [];
            clusters[key].push(seg);
          });

          // Find the best cluster
          let bestCluster = null;
          let maxCount = 0;
          for (const k in clusters) {
            if (clusters[k].length > maxCount) {
              maxCount = clusters[k].length;
              bestCluster = clusters[k];
            }
          }

          if (bestCluster && bestCluster.length > 0) {
            // Deduplicate segments by X position
            bestCluster.sort((a, b) => a.x - b.x);
            const distinctSlots = [];
            bestCluster.forEach(s => {
              if (!distinctSlots.some(d => Math.abs(d.x - s.x) < 25)) {
                distinctSlots.push(s);
              }
            });

            if (distinctSlots.length > 0) {
              return {
                source: "CANVAS_PIXEL_SCAN",
                count: distinctSlots.length,
                slots: distinctSlots.map((s, i) => ({
                  slot: i + 1,
                  pixelWidth: s.width,
                  estimatedChars: Math.max(2, Math.round(s.width / 18))
                }))
              };
            }
          }
        }
      } catch (e) {
        console.warn("Canvas pixel scan error:", e);
      }
      return null;
    },

    // Master Get Analysis
    getCompleteSlotAnalysis: function () {
      const url = window.location.href;
      // Skip slot inspection on MCQ, Listening True/False, or Matching games
      if (url.includes("don-rac") || url.includes("ghep-cap") || url.includes("matching") || url.includes("tai-tao-san-ho") || url.includes("san-ho") || url.includes("fansipan") || url.includes("leo-nui")) {
        return null;
      }

      // Check if DOM has radio buttons or choice elements (MCQ)
      const hasMCQElements = document.querySelector('.answer-item, .btn-answer, input[type="radio"], [class*="choice"], [class*="option"]');
      if (hasMCQElements) {
        return null;
      }

      const domResult = this.inspectDOMSlots();
      if (domResult) return domResult;

      const memoryResult = this.inspectGameMemory();
      if (memoryResult) return memoryResult;

      const canvasResult = this.inspectCanvasUnderlines();
      if (canvasResult) return canvasResult;

      return null;
    }
  };
})();
