"use strict";

/**
 * Extreme Volume Booster — content script
 *
 * Injected on demand (only when the user first moves the popup slider).
 * Uses the Web Audio API to apply a GainNode to every <audio> and <video>
 * element on the page, boosting volume beyond the browser's default limit.
 *
 * A guard variable prevents double-initialization if the script is executed
 * more than once in the same document context.
 */

if (typeof window.__evbInitialized === "undefined") {
  window.__evbInitialized = true;

  // Single shared AudioContext for the entire page.
  let audioContext = null;

  // Map from HTMLMediaElement → GainNode
  const mediaNodes = new WeakMap();

  /** Lazily create (or return) the shared AudioContext. */
  function getAudioContext() {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
    }
    return audioContext;
  }

  /**
   * Connect a media element to a GainNode (if not already connected)
   * and return the GainNode so its gain can be updated.
   *
   * @param {HTMLMediaElement} el
   * @returns {GainNode}
   */
  function getOrCreateGainNode(el) {
    if (mediaNodes.has(el)) {
      return mediaNodes.get(el);
    }

    const ctx = getAudioContext();
    const source = ctx.createMediaElementSource(el);
    const gainNode = ctx.createGain();

    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    mediaNodes.set(el, gainNode);
    return gainNode;
  }

  /** Current multiplier so newly added elements can be boosted immediately. */
  let currentMultiplier = 1;

  /**
   * Apply the given multiplier to all media elements currently in the document.
   *
   * @param {number} multiplier  1.0 – 5.0
   */
  function applyVolumeToAllMedia(multiplier) {
    currentMultiplier = multiplier;
    document.querySelectorAll("video, audio").forEach((el) => {
      try {
        getOrCreateGainNode(el).gain.value = multiplier;
      } catch (err) {
        // Silently skip elements that cannot be processed (e.g. CORS-restricted)
      }
    });
  }

  /**
   * Watch for dynamically added <audio>/<video> elements and boost them
   * as soon as they appear in the DOM.
   */
  const observer = new MutationObserver((mutations) => {
    if (currentMultiplier === 1) return; // nothing to do at default level
    mutations.forEach(({ addedNodes }) => {
      addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const elements =
          node.matches("video, audio")
            ? [node]
            : Array.from(node.querySelectorAll("video, audio"));
        elements.forEach((el) => {
          try {
            getOrCreateGainNode(el).gain.value = currentMultiplier;
          } catch (err) {
            // Silently skip
          }
        });
      });
    });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  browser.runtime.onMessage.addListener((message) => {
    if (message && message.type === "SET_VOLUME") {
      const multiplier = parseFloat(message.value);
      if (!isFinite(multiplier) || multiplier < 0) return;
      applyVolumeToAllMedia(multiplier);
    }
  });
}
