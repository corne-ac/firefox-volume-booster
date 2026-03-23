"use strict";

const slider = document.getElementById("volumeSlider");
const label = document.getElementById("volumeLabel");
const status = document.getElementById("status");

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

function setStatus(message, type) {
  status.textContent = message;
  status.className = "status" + (type ? ` ${type}` : "");
}

/**
 * Ensure the content script is injected into the given tab, then send the
 * SET_VOLUME message. Injection happens at most once per tab per popup session.
 *
 * @param {number} tabId
 * @param {number} multiplier  1.0 – 5.0
 */
async function sendVolumeToTab(tabId, multiplier) {
  if (!injectedTabs.has(tabId)) {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ["content/content.js"],
      });
      injectedTabs.add(tabId);
    } catch (err) {
      // Restricted pages (about:, moz-extension:, etc.) cannot be injected into
      setStatus("Cannot boost on this page.", "error");
      return;
    }
  }

  try {
    await browser.tabs.sendMessage(tabId, {
      type: "SET_VOLUME",
      value: multiplier,
    });
    setStatus(`Boost active: ${Math.round(multiplier * 100)}%`, "active");
  } catch (err) {
    setStatus("Could not reach page script.", "error");
  }
}

/** Get the active tab and send it the volume multiplier */
async function applyVolume(multiplier) {
  let tabs;
  try {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    setStatus("Could not query tabs.", "error");
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
