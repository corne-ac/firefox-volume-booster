"use strict";

const slider = document.getElementById("volumeSlider");
const label = document.getElementById("volumeLabel");
const status = document.getElementById("status");
const errorDetails = document.getElementById("errorDetails");
const errorText = document.getElementById("errorText");

/**
 * Tracks which tab IDs have already had the content script injected so we
 * don't inject it more than once per tab lifecycle.
 */
const injectedTabs = new Set();

/** Update the slider's CSS fill gradient so the filled portion tracks the thumb */
function updateSliderFill(value) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const pct = (((value - min) / (max - min)) * 100).toFixed(1);
  slider.style.setProperty("--fill", `${pct}%`);
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
      files: ["content/content.js"],
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
 * SET_VOLUME message. If sending fails (e.g. after tab navigation), the
 * injection cache is cleared and one re-injection + retry is attempted.
 *
 * @param {number} tabId
 * @param {number} multiplier  1.0 – 5.0
 */
async function sendVolumeToTab(tabId, multiplier) {
  if (!injectedTabs.has(tabId)) {
    const ok = await injectContentScript(tabId);
    if (!ok) return;
  }

  try {
    await browser.tabs.sendMessage(tabId, {
      type: "SET_VOLUME",
      value: multiplier,
    });
    setStatus(`Boost active: ${Math.round(multiplier * 100)}%`, "active");
  } catch (firstErr) {
    // The cached injection may be stale (e.g. the tab navigated). Clear the
    // cache, re-inject, and try once more before giving up.
    injectedTabs.delete(tabId);
    const ok = await injectContentScript(tabId);
    if (!ok) return;

    try {
      await browser.tabs.sendMessage(tabId, {
        type: "SET_VOLUME",
        value: multiplier,
      });
      setStatus(`Boost active: ${Math.round(multiplier * 100)}%`, "active");
    } catch (retryErr) {
      const detail = errDetail(retryErr) + `\n\nFirst attempt:\n${errDetail(firstErr)}`;
      setStatus("Could not reach page script.", "error", detail);
    }
  }
}

/** Get the active tab and send it the volume multiplier */
async function applyVolume(multiplier) {
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

  await sendVolumeToTab(tabs[0].id, multiplier);
}

// Restore saved value when popup opens
browser.storage.local.get("volumeMultiplier").then((data) => {
  const saved = data.volumeMultiplier;
  if (saved && saved >= 1.0 && saved <= 5.0) {
    slider.value = saved;
    label.textContent = Math.round(saved * 100);
    updateSliderFill(saved);
  } else {
    updateSliderFill(1.0);
  }
});

slider.addEventListener("input", () => {
  const value = parseFloat(slider.value);
  label.textContent = Math.round(value * 100);
  updateSliderFill(value);
  browser.storage.local.set({ volumeMultiplier: value });
  applyVolume(value);
});
