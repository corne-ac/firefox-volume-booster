"use strict";

const slider = document.getElementById("volumeSlider");
const label = document.getElementById("volumeLabel");
const status = document.getElementById("status");
const errorDetails = document.getElementById("errorDetails");
const errorText = document.getElementById("errorText");

// Advanced controls
const compressionSlider = document.getElementById("compressionSlider");
const compressionLabel = document.getElementById("compressionLabel");
const bassSlider = document.getElementById("bassSlider");
const bassLabel = document.getElementById("bassLabel");
const trebleSlider = document.getElementById("trebleSlider");
const trebleLabel = document.getElementById("trebleLabel");
const reduceDistortionCheckbox = document.getElementById("reduceDistortion");

/**
 * Tracks which tab IDs have already had the content script injected so we
 * don't inject it more than once per tab lifecycle.
 */
const injectedTabs = new Set();

/** Update the slider's CSS fill gradient so the filled portion tracks the thumb */
function updateSliderFill(inputEl, value) {
  const min = parseFloat(inputEl.min);
  const max = parseFloat(inputEl.max);
  const pct = (((value - min) / (max - min)) * 100).toFixed(1);
  inputEl.style.setProperty("--fill", `${pct}%`);
}

function setStatus(message, type, detail) {
  status.textContent = message;
  status.className = "status" + (type ? ` ${type}` : "");
  if (detail) {
    errorText.textContent = detail;
    errorDetails.hidden = false;
  } else {
    errorDetails.hidden = true;
    errorText.textContent = "";
  }
}

/** Produce a human-readable string from an error, including stack if available. */
function errDetail(err) {
  if (!err) return "Unknown error";
  return err.stack || err.message || String(err);
}

/**
 * Inject the content script into the given tab (all frames).
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} true if injection succeeded
 */
async function injectContentScript(tabId) {
  try {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["../content/content.js"],
    });
    injectedTabs.add(tabId);
    return true;
  } catch (err) {
    // Restricted pages (about:, moz-extension:, etc.) cannot be injected into
    const detail = errDetail(err);
    setStatus("Cannot boost on this page.", "error", detail);
    return false;
  }
}

/**
 * Ensure the content script is injected into the given tab, then send the
 * SET_AUDIO_CONFIG message. If sending fails (e.g. after tab navigation), the
 * injection cache is cleared and one re-injection + retry is attempted.
 *
 * @param {number} tabId
 * @param {object} config
 */
async function sendConfigToTab(tabId, config) {
  if (!injectedTabs.has(tabId)) {
    const ok = await injectContentScript(tabId);
    if (!ok) return;
  }

  try {
    await browser.tabs.sendMessage(tabId, { type: "SET_AUDIO_CONFIG", ...config });
    setStatus(`Boost active: ${Math.round(config.volume * 100)}%`, "active");
  } catch (firstErr) {
    // The cached injection may be stale (e.g. the tab navigated). Clear the
    // cache, re-inject, and try once more before giving up.
    injectedTabs.delete(tabId);
    const ok = await injectContentScript(tabId);
    if (!ok) return;

    try {
      await browser.tabs.sendMessage(tabId, { type: "SET_AUDIO_CONFIG", ...config });
      setStatus(`Boost active: ${Math.round(config.volume * 100)}%`, "active");
    } catch (retryErr) {
      const detail = errDetail(retryErr) + `\n\nFirst attempt:\n${errDetail(firstErr)}`;
      setStatus("Could not reach page script.", "error", detail);
    }
  }
}

/** Build the current config object from all controls. */
function buildConfig() {
  return {
    volume: parseFloat(slider.value),
    compression: parseFloat(compressionSlider.value),
    bassBoost: parseFloat(bassSlider.value),
    trebleReduction: parseFloat(trebleSlider.value),
    reduceDistortion: reduceDistortionCheckbox.checked,
  };
}

/** Get the active tab and send it the current audio config. */
async function applyConfig() {
  let tabs;
  try {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    setStatus("Could not query tabs.", "error", errDetail(err));
    return;
  }

  if (!tabs || tabs.length === 0) {
    setStatus("No active tab found.", "error");
    return;
  }

  await sendConfigToTab(tabs[0].id, buildConfig());
}

/** Persist the current advanced settings to local storage. */
function saveAdvancedSettings() {
  browser.storage.local.set({
    audioConfig: {
      compression: parseFloat(compressionSlider.value),
      bassBoost: parseFloat(bassSlider.value),
      trebleReduction: parseFloat(trebleSlider.value),
      reduceDistortion: reduceDistortionCheckbox.checked,
    },
  });
}

// ── Restore saved values when popup opens ─────────────────────────────────────

/**
 * Restore a slider + label from a saved value.
 *
 * @param {HTMLInputElement} inputEl
 * @param {HTMLElement} labelEl
 * @param {number|undefined} savedValue
 * @param {(v: number) => string} formatter
 */
function restoreSlider(inputEl, labelEl, savedValue, formatter) {
  if (isFinite(savedValue)) {
    inputEl.value = savedValue;
    labelEl.textContent = formatter(savedValue);
  }
  updateSliderFill(inputEl, parseFloat(inputEl.value));
}

browser.storage.local.get(["volumeMultiplier", "audioConfig"]).then((data) => {
  const saved = data.volumeMultiplier;
  if (saved && saved >= 1.0 && saved <= 5.0) {
    slider.value = saved;
    label.textContent = Math.round(saved * 100);
    updateSliderFill(slider, saved);
  } else {
    updateSliderFill(slider, 1.0);
  }

  const cfg = data.audioConfig || {};
  restoreSlider(compressionSlider, compressionLabel, cfg.compression,
    (v) => `${Math.round(v * 100)}%`);
  restoreSlider(bassSlider, bassLabel, cfg.bassBoost,
    (v) => `${v.toFixed(1)} dB`);
  restoreSlider(trebleSlider, trebleLabel, cfg.trebleReduction,
    (v) => `${Math.round(v * 100)}%`);
  if (typeof cfg.reduceDistortion === "boolean") {
    reduceDistortionCheckbox.checked = cfg.reduceDistortion;
  }
});

// ── Event listeners ───────────────────────────────────────────────────────────

slider.addEventListener("input", () => {
  const value = parseFloat(slider.value);
  label.textContent = Math.round(value * 100);
  updateSliderFill(slider, value);
  browser.storage.local.set({ volumeMultiplier: value });
  applyConfig();
});

compressionSlider.addEventListener("input", () => {
  const value = parseFloat(compressionSlider.value);
  compressionLabel.textContent = `${Math.round(value * 100)}%`;
  updateSliderFill(compressionSlider, value);
  saveAdvancedSettings();
  applyConfig();
});

bassSlider.addEventListener("input", () => {
  const value = parseFloat(bassSlider.value);
  bassLabel.textContent = `${value.toFixed(1)} dB`;
  updateSliderFill(bassSlider, value);
  saveAdvancedSettings();
  applyConfig();
});

trebleSlider.addEventListener("input", () => {
  const value = parseFloat(trebleSlider.value);
  trebleLabel.textContent = `${Math.round(value * 100)}%`;
  updateSliderFill(trebleSlider, value);
  saveAdvancedSettings();
  applyConfig();
});

reduceDistortionCheckbox.addEventListener("change", () => {
  saveAdvancedSettings();
  applyConfig();
});
