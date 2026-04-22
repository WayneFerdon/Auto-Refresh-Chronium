// Auto Refresh Pro — Content Script
// Handles: page change detection (hash comparison) + custom keyboard shortcuts

(function () {
  'use strict';

  // === Page Hash for Change Detection ===
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  // === Custom Keyboard Shortcut ===
  let shortcutConfig = null;

  async function loadShortcutConfig() {
    try {
      const result = await chrome.storage.local.get('settings');
      if (result.settings) {
        const mods = result.settings.shortcutModifiers || ['Alt', 'Shift'];
        shortcutConfig = {
          ctrlKey: mods.includes('Ctrl'),
          altKey: mods.includes('Alt'),
          shiftKey: mods.includes('Shift'),
          metaKey: mods.includes('Meta'),
          key: (result.settings.shortcutKey || 'R').toUpperCase(),
        };
      }
    } catch (e) {
      // Fallback default
      shortcutConfig = { ctrlKey: false, altKey: true, shiftKey: true, metaKey: false, key: 'R' };
    }
  }

  // Load on init
  loadShortcutConfig();

  // Auto-reload config when settings change
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      loadShortcutConfig();
    }
  });

  // Listen for keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if (!shortcutConfig) return;

    // Don't trigger inside text inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
      return;
    }

    if (
      e.ctrlKey === shortcutConfig.ctrlKey &&
      e.altKey === shortcutConfig.altKey &&
      e.shiftKey === shortcutConfig.shiftKey &&
      e.metaKey === shortcutConfig.metaKey &&
      e.key.toUpperCase() === shortcutConfig.key
    ) {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'TOGGLE' });
    }
  });

  // === Message Listener ===
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_PAGE_HASH') {
      try {
        const text = document.body ? document.body.innerText.trim() : '';
        sendResponse({ hash: simpleHash(text) });
      } catch (e) {
        sendResponse({ hash: null, error: e.message });
      }
      return true;
    }
  });
})();
