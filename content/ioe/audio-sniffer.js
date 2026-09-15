/**
 * English Master AI - Deep Audio Interceptor & Sniffer for IOE
 * Injected at document_start to capture all audio files played by any game engine
 */

(function () {
  if (window.__IOE_AUDIO_SNIFFER_INITIALIZED__) return;
  window.__IOE_AUDIO_SNIFFER_INITIALIZED__ = true;

  window.__LAST_CAPTURED_IOE_AUDIO__ = {
    audioId: 0,
    url: null,
    base64: null,
    timestamp: 0,
    isReady: false,
    history: []
  };

  window.invalidateIOEAudio = function () {
    if (window.__LAST_CAPTURED_IOE_AUDIO__) {
      window.__LAST_CAPTURED_IOE_AUDIO__.url = null;
      window.__LAST_CAPTURED_IOE_AUDIO__.base64 = null;
      window.__LAST_CAPTURED_IOE_AUDIO__.isReady = false;
      window.__LAST_CAPTURED_IOE_AUDIO__.timestamp = 0;
    }
  };

  function convertBlobToBase64(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  async function registerAudioSource(src) {
    if (!src || typeof src !== "string" || src.startsWith("data:image")) return;
    try {
      const fullUrl = new URL(src, window.location.href).href;
      const thisId = ++window.__LAST_CAPTURED_IOE_AUDIO__.audioId;

      window.__LAST_CAPTURED_IOE_AUDIO__.url = fullUrl;
      window.__LAST_CAPTURED_IOE_AUDIO__.timestamp = Date.now();
      window.__LAST_CAPTURED_IOE_AUDIO__.isReady = false;
      window.__LAST_CAPTURED_IOE_AUDIO__.base64 = null;

      if (!window.__LAST_CAPTURED_IOE_AUDIO__.history.includes(fullUrl)) {
        window.__LAST_CAPTURED_IOE_AUDIO__.history.unshift(fullUrl);
        if (window.__LAST_CAPTURED_IOE_AUDIO__.history.length > 20) {
          window.__LAST_CAPTURED_IOE_AUDIO__.history.pop();
        }
      }
      console.log("%c[English Master AI] 🎧 Audio Question Captured (id #" + thisId + "):", "color: #8b5cf6; font-weight: bold;", fullUrl);

      // Fetch and convert to Base64 in content script
      try {
        const res = await fetch(fullUrl);
        if (res.ok) {
          const blob = await res.blob();
          const base64Data = await convertBlobToBase64(blob);

          if (window.__LAST_CAPTURED_IOE_AUDIO__.audioId === thisId) {
            window.__LAST_CAPTURED_IOE_AUDIO__.base64 = base64Data;
            window.__LAST_CAPTURED_IOE_AUDIO__.isReady = true;
            console.log("%c[English Master AI] 🎧 Audio Base64 Ready (id #" + thisId + ", " + (base64Data ? base64Data.length : 0) + " bytes)", "color: #10b981; font-weight: bold;");
          }
        }
      } catch (err) {}

      // Dispatch custom event for content script
      window.dispatchEvent(new CustomEvent("IOE_AUDIO_CAPTURED", { detail: { url: fullUrl, audioId: thisId } }));
    } catch (e) {}
  }

  // 1. Hook HTMLAudioElement & new Audio(url)
  const OriginalAudio = window.Audio;
  window.Audio = function (src) {
    const audioInstance = new OriginalAudio(src);
    if (src) registerAudioSource(src);

    const origPlay = audioInstance.play;
    audioInstance.play = function () {
      if (audioInstance.src) registerAudioSource(audioInstance.src);
      return origPlay.apply(this, arguments);
    };

    return audioInstance;
  };
  window.Audio.prototype = OriginalAudio.prototype;

  // 2. Hook HTMLMediaElement.prototype.play and src setter
  const origPlayProto = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const src = this.currentSrc || this.src;
    if (src) registerAudioSource(src);
    return origPlayProto.apply(this, arguments);
  };

  const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  if (origSrcDesc && origSrcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      set: function (val) {
        if (val) registerAudioSource(val);
        return origSrcDesc.set.apply(this, arguments);
      },
      get: origSrcDesc.get
    });
  }

  // 3. Hook fetch
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url ? input.url : "");
    if (url && (url.includes(".mp3") || url.includes(".wav") || url.includes(".m4a") || url.includes(".ogg") || url.includes("audio") || url.includes("sound") || url.includes("Media") || url.includes("media"))) {
      registerAudioSource(url);
    }
    return origFetch.apply(this, arguments);
  };

  // 4. Hook XMLHttpRequest (XHR)
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === "string" && (url.includes(".mp3") || url.includes(".wav") || url.includes(".m4a") || url.includes(".ogg") || url.includes("audio") || url.includes("sound") || url.includes("Media") || url.includes("media"))) {
      registerAudioSource(url);
    }
    return origXHROpen.apply(this, arguments);
  };

  // 5. Scan existing audio tags periodically
  function scanDOMAudios() {
    const audios = document.querySelectorAll("audio, source, [data-audio], [data-sound]");
    audios.forEach(a => {
      const src = a.src || a.getAttribute("src") || a.getAttribute("data-audio") || a.getAttribute("data-sound");
      if (src) registerAudioSource(src);
    });
  }

  document.addEventListener("DOMContentLoaded", scanDOMAudios);
  setInterval(scanDOMAudios, 1500);
})();
