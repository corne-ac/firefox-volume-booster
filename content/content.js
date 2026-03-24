"use strict";

/**
 * Extreme Volume Booster — content script
 *
 * Injected on demand (only when the user first moves the popup slider).
 * Uses the Web Audio API to apply a GainNode to every <audio> and <video>
 * element on the page, boosting volume beyond the browser's default limit.
 *
 * Pipeline (when reduceDistortion is enabled):
 *   HTMLMediaElement → GainNode → DynamicsCompressor → Limiter
 *                    → BassFilter → TrebleFilter → destination
 *
 * A guard variable prevents double-initialization if the script is executed
 * more than once in the same document context.
 */

if (typeof window.__evbInitialized === "undefined") {
  window.__evbInitialized = true;

  // Single shared AudioContext for the entire page.
  let audioContext = null;

  // Map from HTMLMediaElement → { source, gainNode, compressor, limiter, bassFilter, trebleFilter }
  const mediaNodes = new WeakMap();

  /** Lazily create (or return) the shared AudioContext. */
  function getAudioContext() {
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
    }
    return audioContext;
  }

  /** Current audio config so newly added elements can be configured immediately. */
  let currentConfig = {
    volume: 1,
    compression: 0.5,
    bassBoost: 0,
    trebleReduction: 0,
    reduceDistortion: true,
  };

  /**
   * Create a full set of audio processing nodes for one media element.
   *
   * @param {AudioContext} ctx
   * @param {HTMLMediaElement} el
   * @returns {{ source, gainNode, compressor, limiter, bassFilter, trebleFilter }}
   */
  function createNodeSet(ctx, el) {
    const source = ctx.createMediaElementSource(el);
    const gainNode = ctx.createGain();

    // Main compressor — smooths out peaks and prevents clipping.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 30;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    // Limiter (second compressor with very high ratio) — hard peak control.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 3;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    // Bass-boost shelf filter.
    const bassFilter = ctx.createBiquadFilter();
    bassFilter.type = "lowshelf";
    bassFilter.frequency.value = 200;
    bassFilter.gain.value = 0;

    // Treble-reduction low-pass filter.
    const trebleFilter = ctx.createBiquadFilter();
    trebleFilter.type = "lowpass";
    trebleFilter.frequency.value = 20000;

    return { source, gainNode, compressor, limiter, bassFilter, trebleFilter };
  }

  /**
   * Wire up (or rewire) all nodes according to the reduceDistortion flag.
   * Existing connections are torn down first.
   *
   * Full chain:   source → gain → compressor → limiter → bass → treble → dest
   * Simple chain: source → gain → dest
   *
   * @param {{ source, gainNode, compressor, limiter, bassFilter, trebleFilter }} nodes
   * @param {boolean} reduceDistortion
   */
  function connectNodes(nodes, reduceDistortion) {
    const { source, gainNode, compressor, limiter, bassFilter, trebleFilter } = nodes;
    const ctx = getAudioContext();

    // Tear down all existing connections before rewiring.
    try { source.disconnect(); } catch (_) { /* already disconnected */ }
    try { gainNode.disconnect(); } catch (_) { /* already disconnected */ }
    try { compressor.disconnect(); } catch (_) { /* already disconnected */ }
    try { limiter.disconnect(); } catch (_) { /* already disconnected */ }
    try { bassFilter.disconnect(); } catch (_) { /* already disconnected */ }
    try { trebleFilter.disconnect(); } catch (_) { /* already disconnected */ }

    source.connect(gainNode);
    if (reduceDistortion) {
      gainNode.connect(compressor);
      compressor.connect(limiter);
      limiter.connect(bassFilter);
      bassFilter.connect(trebleFilter);
      trebleFilter.connect(ctx.destination);
    } else {
      gainNode.connect(ctx.destination);
    }
  }

  /**
   * Get (or create and wire) the node set for a media element.
   *
   * @param {HTMLMediaElement} el
   * @returns {{ source, gainNode, compressor, limiter, bassFilter, trebleFilter }}
   */
  function getOrCreateNodes(el) {
    if (mediaNodes.has(el)) {
      return mediaNodes.get(el);
    }
    const ctx = getAudioContext();
    const nodes = createNodeSet(ctx, el);
    connectNodes(nodes, currentConfig.reduceDistortion);
    mediaNodes.set(el, nodes);
    return nodes;
  }

  /**
   * Apply audio config parameters to the node set of a single element.
   * Does NOT rewire the graph — call connectNodes() separately when
   * reduceDistortion changes.
   *
   * @param {HTMLMediaElement} el
   * @param {object} config
   */
  function applyConfigToElement(el, config) {
    const { gainNode, compressor, bassFilter, trebleFilter } = getOrCreateNodes(el);

    // Gain staging: cap raw gain to ~2.5 to prevent hard clipping;
    // the compressor handles perceived loudness at higher slider values.
    gainNode.gain.value = Math.min(config.volume, 2.5);

    if (config.reduceDistortion) {
      // Compression strength: 0 = minimal (ratio 2, threshold -6),
      //                       0.5 = default (ratio 8, threshold -24),
      //                       1 = heavy (ratio 20, threshold -40).
      compressor.ratio.value = 1 + config.compression * 19;
      // Keep threshold at least -6 dB so a ratio near 1:1 still provides a
      // safe headroom ceiling and avoids floating-point edge cases at 0 dB.
      compressor.threshold.value = Math.min(-6, -config.compression * 40);

      // Bass boost (0–10 dB shelf at 200 Hz).
      bassFilter.gain.value = config.bassBoost;

      // Treble reduction: 0 → 20 000 Hz (no cut), 1 → 4 000 Hz (aggressive).
      trebleFilter.frequency.value = 20000 - config.trebleReduction * 16000;
    }
  }

  /**
   * Apply the given config to all media elements currently in the document.
   *
   * @param {object} config
   */
  function applyConfigToAllMedia(config) {
    const prevReduceDistortion = currentConfig.reduceDistortion;
    currentConfig = { ...config };

    const ctx = getAudioContext();
    // The AudioContext may be suspended if no user gesture occurred on this
    // page (the gesture in the popup is not enough). Resume it so gain nodes
    // take effect immediately.
    if (ctx.state === "suspended") {
      ctx.resume().catch((err) => {
        console.error("[EVB] Failed to resume AudioContext:", err);
      });
    }

    const elements = document.querySelectorAll("video, audio");
    elements.forEach((el) => {
      try {
        const nodes = getOrCreateNodes(el);
        // Rewire the graph only when the topology actually changes.
        if (prevReduceDistortion !== config.reduceDistortion) {
          connectNodes(nodes, config.reduceDistortion);
        }
        applyConfigToElement(el, config);
      } catch (err) {
        console.error("[EVB] Could not apply config to element:", el, err);
      }
    });
  }

  /**
   * Watch for dynamically added <audio>/<video> elements and boost them
   * as soon as they appear in the DOM.
   */
  const observer = new MutationObserver((mutations) => {
    // Nothing to do when volume is at default and no processing is active.
    if (
      currentConfig.volume === 1 &&
      !currentConfig.reduceDistortion &&
      currentConfig.bassBoost === 0 &&
      currentConfig.trebleReduction === 0
    ) return;
    mutations.forEach(({ addedNodes }) => {
      addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const elements =
          node.matches("video, audio")
            ? [node]
            : Array.from(node.querySelectorAll("video, audio"));
        elements.forEach((el) => {
          try {
            applyConfigToElement(el, currentConfig);
          } catch (err) {
            console.error("[EVB] Could not apply config to dynamically added element:", el, err);
          }
        });
      });
    });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  browser.runtime.onMessage.addListener((message) => {
    if (!message) return;

    if (message.type === "SET_VOLUME") {
      // Legacy message format — convert to full config update.
      const multiplier = parseFloat(message.value);
      if (!isFinite(multiplier) || multiplier < 0) return;
      applyConfigToAllMedia({ ...currentConfig, volume: multiplier });
    } else if (message.type === "SET_AUDIO_CONFIG") {
      const config = {
        volume: isFinite(message.volume) ? message.volume : currentConfig.volume,
        compression: isFinite(message.compression) ? message.compression : currentConfig.compression,
        bassBoost: isFinite(message.bassBoost) ? message.bassBoost : currentConfig.bassBoost,
        trebleReduction: isFinite(message.trebleReduction) ? message.trebleReduction : currentConfig.trebleReduction,
        reduceDistortion: typeof message.reduceDistortion === "boolean"
          ? message.reduceDistortion
          : currentConfig.reduceDistortion,
      };
      applyConfigToAllMedia(config);
    }
  });
}
