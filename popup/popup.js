/*
 * @Author: WayneFerdon wayneferdon@hotmail.com
 * @Date: 2026-05-29 16:46:01
 * @LastEditors: WayneFerdon wayneferdon@hotmail.com
 * @LastEditTime: 2026-06-03 01:31:56
 * @FilePath: \Auto-Refresh-Chronium\popup\popup.js
 * ----------------------------------------------------------------
 * Licensed to the .NET Foundation under one or more agreements.
 * The .NET Foundation licenses this file to you under the MIT license.
 */
// Auto Refresh Pro — Popup Controller
// Manages all UI interactions, settings sync, and real-time state updates

import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../utils/storage.js';
import { loadLocale, t, applyTranslations } from '../utils/i18n.js';

// ═══════════════════════════════════════════════════════════
// DOM REFERENCES
// ═══════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Header
const langSelect = $('#langSelect');
const themeBtn = $('#themeBtn');

// Main Tab
const intervalInput = $('#intervalInput');
const intervalSection = $('#intervalSection');
const countdownValue = $('#countdownValue');
const progressFill = $('#progressFill');
const refreshCounter = $('#refreshCounter');
const toggleBtn = $('#toggleBtn');
const toggleText = $('#toggleText');
const toggleIcon = $('#toggleIcon');
const urlInput = $('#urlInput');
const addUrlBtn = $('#addUrlBtn');
const urlList = $('#urlList');
const urlEmptyState = $('#urlEmptyState');
const urlSection = $('#urlSection');
const matchModeSelect = $('#matchModeSelect');

// OnError Tab
const onErrorToggle = $('#onErrorToggle');
const onErrorBody = $('#onErrorBody');
const onErrorInterval = $('#onErrorInterval');
const onErrorUrlInput = $('#onErrorUrlInput');
const onErrorAddUrlBtn = $('#onErrorAddUrlBtn');
const onErrorUrlList = $('#onErrorUrlList');
const onErrorUrlEmptyState = $('#onErrorUrlEmptyState');
const onErrorUrlSection = $('#onErrorUrlSection');
const onErrorMatchModeSelect = $('#onErrorMatchModeSelect');

// Advanced Tab
const onLaunchToggle = $('#onLaunchToggle');
const randomToggle = $('#randomToggle');
const randomBody = $('#randomBody');
const randomMin = $('#randomMin');
const randomMax = $('#randomMax');
const hardRefreshToggle = $('#hardRefreshToggle');
const allTabsToggle = $('#allTabsToggle');
const limitToggle = $('#limitToggle');
const limitBody = $('#limitBody');
const limitCount = $('#limitCount');
const detectToggle = $('#detectToggle');
const detectBody = $('#detectBody');
const detectAction = $('#detectAction');
const notifToggle = $('#notifToggle');
const editShortcutBtn = $('#editShortcutBtn');
const shortcutKeys = $('#shortcutKeys');
const shortcutCapture = $('#shortcutCapture');
const capturePrompt = $('#capturePrompt');
const saveShortcutBtn = $('#saveShortcutBtn');
const cancelShortcutBtn = $('#cancelShortcutBtn');
const exportBtn = $('#exportBtn');
const importBtn = $('#importBtn');
const importFile = $('#importFile');

// Logs Tab
const clearLogsBtn = $('#clearLogsBtn');
const logsList = $('#logsList');
const logsFooter = $('#logsFooter');

// Toast
const toast = $('#toast');

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

let settings = { ...DEFAULT_SETTINGS };
let isRunning = false;
let currentCapturedShortcut = null;
let captureKeyHandler = null;
let logsRefreshInterval = null;

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

async function init() {
  // Load settings
  settings = await getSettings();

  // Load language
  await loadLocale(settings.language);
  applyTranslations();

  // Apply theme
  applyTheme(settings.theme);

  // Populate all UI controls
  populateSettings();

  // Get current running state from background
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (response && response.state) {
      updateStateUI(response.state);
    }
  } catch (e) {
    console.warn('Failed to get state:', e);
  }

  // Load logs
  await loadLogs();

  // Bind event listeners
  setupEventListeners();

  // Start auto-refresh for logs tab
  startLogsAutoRefresh();
}

// ═══════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════

const THEME_ICONS = {
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
};

function applyTheme(theme) {
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  themeBtn.innerHTML = THEME_ICONS[theme] || THEME_ICONS.dark;
  themeBtn.title = t(theme);
}

function cycleTheme() {
  const themes = ['dark', 'light', 'system'];
  const idx = themes.indexOf(settings.theme);
  settings.theme = themes[(idx + 1) % themes.length];
  applyTheme(settings.theme);
  saveSettingsDebounced();
}

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});

// ═══════════════════════════════════════════════════════════
// POPULATE UI FROM SETTINGS
// ═══════════════════════════════════════════════════════════

function populateSettings() {
  // Main
  intervalInput.value = settings.interval;
  langSelect.value = settings.language;
  matchModeSelect.value = settings.matchMode;

  onErrorToggle.checked = settings.onErrorEnabled;
  onErrorInterval.value = settings.onErrorInterval;
  toggleSettingBody(onErrorBody, true);
  
  // Advanced toggles
  randomToggle.checked = settings.randomEnabled;
  randomMin.value = settings.randomMin;
  randomMax.value = settings.randomMax;
  toggleSettingBody(randomBody, settings.randomEnabled);

  hardRefreshToggle.checked = settings.hardRefresh;
  onLaunchToggle.checked = settings.onLaunch;

  allTabsToggle.checked = settings.allTabs;
  urlSection.classList.toggle('disabled', settings.allTabs);

  limitToggle.checked = settings.limitEnabled;
  limitCount.value = settings.limitCount;
  toggleSettingBody(limitBody, settings.limitEnabled);

  detectToggle.checked = settings.detectChanges;
  detectAction.value = settings.detectAction;
  toggleSettingBody(detectBody, settings.detectChanges);

  notifToggle.checked = settings.notificationsEnabled;

  // Shortcut display
  updateShortcutDisplay();

  // URL list
  renderUrlList();

  // On Error URL list
  renderOnErrorUrlList();

  // Interval disabled when random is on
  if (settings.randomEnabled) {
    intervalSection.classList.add('disabled');
  }
}

// ═══════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════

function setupEventListeners() {
  // --- Tab switching ---
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // --- Header ---
  themeBtn.addEventListener('click', cycleTheme);

  langSelect.addEventListener('change', async (e) => {
    settings.language = e.target.value;
    await loadLocale(settings.language);
    applyTranslations();
    // Re-apply dynamic content
    updateShortcutDisplay();
    saveSettingsDebounced();
  });

  // --- Main Tab ---
  intervalInput.addEventListener('change', (e) => {
    let val = parseInt(e.target.value) || 10;
    val = Math.max(1, Math.min(86400, val));
    e.target.value = val;
    settings.interval = val;
    saveAndUpdate();
  });

  toggleBtn.addEventListener('click', toggleRefresh);

  addUrlBtn.addEventListener('click', addUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addUrl();
  });

  matchModeSelect.addEventListener('change', (e) => {
    settings.matchMode = e.target.value;
    saveAndUpdate();
  });
  
  onErrorAddUrlBtn.addEventListener('click', onErrorAddUrl);
  onErrorUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onErrorAddUrl();
  });

  matchModeSelect.addEventListener('change', (e) => {
    settings.matchMode = e.target.value;
    saveAndUpdate();
  });

  // --- On Error toggles ---

  onErrorToggle.addEventListener('change', (e) => {
    settings.onErrorEnabled = e.target.checked;
    intervalSection.classList.toggle('disabled', e.target.checked);
    saveAndUpdate();
  });

  onErrorInterval.addEventListener('change', (e) => {
    settings.onErrorInterval = Math.max(1, parseInt(e.target.value) || 1);
    saveAndUpdate();
  });

  // --- Advanced toggles ---

  onLaunchToggle.addEventListener('change', (e) => {
    settings.onLaunch = e.target.checked;
    saveAndUpdate();
  });
  
  randomToggle.addEventListener('change', (e) => {
    settings.randomEnabled = e.target.checked;
    toggleSettingBody(randomBody, e.target.checked);
    intervalSection.classList.toggle('disabled', e.target.checked);
    saveAndUpdate();
  });

  randomMin.addEventListener('change', (e) => {
    settings.randomMin = Math.max(1, parseInt(e.target.value) || 1);
    e.target.value = settings.randomMin;
    if (settings.randomMax <= settings.randomMin) {
      settings.randomMax = settings.randomMin + 1;
      randomMax.value = settings.randomMax;
    }
    saveAndUpdate();
  });

  randomMax.addEventListener('change', (e) => {
    settings.randomMax = Math.max(settings.randomMin + 1, parseInt(e.target.value) || settings.randomMin + 1);
    e.target.value = settings.randomMax;
    saveAndUpdate();
  });

  hardRefreshToggle.addEventListener('change', (e) => {
    settings.hardRefresh = e.target.checked;
    saveAndUpdate();
  });

  allTabsToggle.addEventListener('change', (e) => {
    settings.allTabs = e.target.checked;
    urlSection.classList.toggle('disabled', e.target.checked);
    saveAndUpdate();
  });

  limitToggle.addEventListener('change', (e) => {
    settings.limitEnabled = e.target.checked;
    toggleSettingBody(limitBody, e.target.checked);
    saveAndUpdate();
  });

  limitCount.addEventListener('change', (e) => {
    settings.limitCount = Math.max(1, parseInt(e.target.value) || 1);
    e.target.value = settings.limitCount;
    saveAndUpdate();
  });

  detectToggle.addEventListener('change', (e) => {
    settings.detectChanges = e.target.checked;
    toggleSettingBody(detectBody, e.target.checked);
    saveAndUpdate();
  });

  detectAction.addEventListener('change', (e) => {
    settings.detectAction = e.target.value;
    saveAndUpdate();
  });

  notifToggle.addEventListener('change', (e) => {
    settings.notificationsEnabled = e.target.checked;
    saveAndUpdate();
  });

  // --- Keyboard Shortcut ---
  editShortcutBtn.addEventListener('click', startShortcutCapture);
  saveShortcutBtn.addEventListener('click', saveShortcut);
  cancelShortcutBtn.addEventListener('click', cancelShortcutCapture);

  // --- Export / Import ---
  exportBtn.addEventListener('click', doExport);
  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', doImport);

  // --- Logs ---
  clearLogsBtn.addEventListener('click', doClearLogs);

  // --- Listen for state broadcasts from background ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE') {
      updateStateUI(msg.state);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════

function switchTab(tabName) {
  $$('.tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabName));

  const panelId = 'panel' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
  $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === panelId));

  // Refresh logs when switching to logs tab
  if (tabName === 'logs') loadLogs();
}

// ═══════════════════════════════════════════════════════════
// START / PAUSE
// ═══════════════════════════════════════════════════════════

async function toggleRefresh() {
  try {
    const msgType = isRunning ? 'PAUSE' : 'START';
    const response = await chrome.runtime.sendMessage({ type: msgType });
    if (response && response.state) {
      updateStateUI(response.state);
    }
  } catch (e) {
    console.error('Toggle failed:', e);
  }
}

function updateStateUI(state) {
  isRunning = state.isRunning;

  // Button state
  toggleBtn.classList.toggle('running', isRunning);

  if (isRunning) {
    toggleText.textContent = t('pause');
    toggleIcon.innerHTML = '<rect x="6" y="4" width="4" height="16" fill="currentColor" rx="1"/><rect x="14" y="4" width="4" height="16" fill="currentColor" rx="1"/>';

    // Countdown
    countdownValue.textContent = state.countdown + 's';
    const progress = ((state.currentInterval - state.countdown) / state.currentInterval) * 100;
    progressFill.style.width = Math.min(100, Math.max(0, progress)) + '%';
  } else {
    toggleText.textContent = t('start');
    toggleIcon.innerHTML = '<polygon points="6,3 20,12 6,21" fill="currentColor"/>';

    if (state.countdown === 0) {
      countdownValue.textContent = '--';
      progressFill.style.width = '0%';
    }
  }

  // Refresh count
  if (settings.limitEnabled && state.refreshCount > 0) {
    refreshCounter.textContent = t('refreshCount', { count: state.refreshCount, max: settings.limitCount });
  } else if (state.refreshCount > 0) {
    refreshCounter.textContent = t('refreshCountUnlimited', { count: state.refreshCount });
  } else {
    refreshCounter.textContent = '';
  }
}

// ═══════════════════════════════════════════════════════════
// URL LIST
// ═══════════════════════════════════════════════════════════

function addUrl() {
  const url = urlInput.value.trim();
  if (!url) return;

  if (settings.urls.includes(url)) {
    showToast(t('urlExists'));
    return;
  }

  settings.urls.push(url);
  urlInput.value = '';
  renderUrlList();
  saveAndUpdate();
}

function removeUrl(index) {
  settings.urls.splice(index, 1);
  renderUrlList();
  saveAndUpdate();
}

function renderUrlList() {
  if (!settings.urls || settings.urls.length === 0) {
    urlList.innerHTML = `<div class="empty-state" data-i18n="noUrls">${t('noUrls')}</div>`;
    return;
  }

  urlList.innerHTML = settings.urls.map((url, i) => `
    <div class="url-item" data-index="${i}">
      <span class="url-item-text" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
      <button class="url-item-remove" data-index="${i}" title="${t('removeUrl')}">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `).join('');

  // Bind remove buttons
  urlList.querySelectorAll('.url-item-remove').forEach(btn => {
    btn.addEventListener('click', () => removeUrl(parseInt(btn.dataset.index)));
  });
}

// ═══════════════════════════════════════════════════════════
// ON ERROR URL LIST
// ═══════════════════════════════════════════════════════════

function onErrorAddUrl() {
  const url = onErrorUrlInput.value.trim();
  console.log(url)
  if (!url) return;

  if (settings.onErrorUrls.includes(url)) {
    showToast(t('urlExists'));
    return;
  }

  settings.onErrorUrls.push(url);
  onErrorUrlInput.value = '';
  renderOnErrorUrlList();
  saveAndUpdate();
}

function removeOnErrorUrl(index) {
  settings.onErrorUrls.splice(index, 1);
  renderOnErrorUrlList();
  saveAndUpdate();
}

function renderOnErrorUrlList() {
  if (!settings.onErrorUrls || settings.onErrorUrls.length === 0) {
    onErrorUrlList.innerHTML = `<div class="empty-state" data-i18n="noUrls">${t('noUrls')}</div>`;
    return;
  }

  onErrorUrlList.innerHTML = settings.onErrorUrls.map((url, i) => `
    <div class="url-item" data-index="${i}">
      <span class="url-item-text" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
      <button class="onerror-url-item-remove" data-index="${i}" title="${t('removeUrl')}">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `).join('');

  // Bind remove buttons
  onErrorUrlList.querySelectorAll('.onerror-url-item-remove').forEach(btn => {
    btn.addEventListener('click', () => removeOnErrorUrl(parseInt(btn.dataset.index)));
  });
}


// ═══════════════════════════════════════════════════════════
// KEYBOARD SHORTCUT CAPTURE
// ═══════════════════════════════════════════════════════════

function updateShortcutDisplay() {
  const mods = settings.shortcutModifiers || [];
  const key = settings.shortcutKey || 'R';
  shortcutKeys.innerHTML = [...mods, key].map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('');
}

function startShortcutCapture() {
  shortcutCapture.classList.remove('hidden');
  editShortcutBtn.classList.add('hidden');
  currentCapturedShortcut = null;
  capturePrompt.textContent = t('pressKeys');

  captureKeyHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Ignore modifier-only presses
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');

    if (mods.length === 0) {
      capturePrompt.textContent = t('pressKeys');
      return;
    }

    currentCapturedShortcut = { modifiers: mods, key: e.key.length === 1 ? e.key.toUpperCase() : e.key };
    capturePrompt.innerHTML = [...mods, currentCapturedShortcut.key].map(k => `<kbd>${escapeHtml(k)}</kbd>`).join(' + ');

    // Remove handler after capture
    document.removeEventListener('keydown', captureKeyHandler, true);
  };

  document.addEventListener('keydown', captureKeyHandler, true);
}

function saveShortcut() {
  if (currentCapturedShortcut) {
    settings.shortcutModifiers = currentCapturedShortcut.modifiers;
    settings.shortcutKey = currentCapturedShortcut.key;
    updateShortcutDisplay();
    saveAndUpdate();
    showToast(t('shortcutSaved') + ' ✓');
  }
  cancelShortcutCapture();
}

function cancelShortcutCapture() {
  shortcutCapture.classList.add('hidden');
  editShortcutBtn.classList.remove('hidden');
  if (captureKeyHandler) {
    document.removeEventListener('keydown', captureKeyHandler, true);
    captureKeyHandler = null;
  }
  currentCapturedShortcut = null;
}

// ═══════════════════════════════════════════════════════════
// EXPORT / IMPORT
// ═══════════════════════════════════════════════════════════

function doExport() {
  const data = JSON.stringify(settings, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'auto-refresh-settings.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(t('exportSuccess'));
}

async function doImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (typeof imported !== 'object' || imported === null) throw new Error('Invalid');

    // Merge with defaults for safety
    settings = { ...DEFAULT_SETTINGS, ...imported };
    await saveSettings(settings);
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });

    // Reload UI
    populateSettings();
    applyTheme(settings.theme);
    await loadLocale(settings.language);
    applyTranslations();
    renderUrlList();
    renderOnErrorUrlList();

    showToast(t('importSuccess'));
  } catch (err) {
    showToast(t('importError'));
    console.error('Import failed:', err);
  }

  e.target.value = '';
}

// ═══════════════════════════════════════════════════════════
// LOGS
// ═══════════════════════════════════════════════════════════

async function loadLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    const logs = response?.logs || [];

    if (logs.length === 0) {
      logsList.innerHTML = `<div class="empty-state">${t('noLogs')}</div>`;
      logsFooter.textContent = '';
      return;
    }

    logsList.innerHTML = logs.map(log => {
      const time = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      let icon, iconClass, action;

      switch (log.type) {
        case 'refresh':
          icon = '✓'; iconClass = 'refresh'; action = t('refreshed');
          break;
        case 'change':
          icon = '⚠'; iconClass = 'change'; action = t('pageChanged');
          break;
        case 'limit':
          icon = 'ⓘ'; iconClass = 'limit'; action = t('limitReached');
          break;
        default:
          icon = '•'; iconClass = ''; action = log.type;
      }

      const urlLine = log.url
        ? `<div class="log-url" title="${escapeHtml(log.url)}">${escapeHtml(log.title || log.url)}</div>`
        : '';

      return `
        <div class="log-entry">
          <span class="log-time">${time}</span>
          <span class="log-icon ${iconClass}">${icon}</span>
          <div class="log-details">
            <div class="log-action">${action}</div>
            ${urlLine}
          </div>
        </div>
      `;
    }).join('');

    logsFooter.textContent = t('showingEntries', { count: logs.length, max: 100 });
  } catch (e) {
    console.error('Failed to load logs:', e);
  }
}

async function doClearLogs() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  await loadLogs();
}

function startLogsAutoRefresh() {
  // Refresh logs every 2s when logs tab is active
  logsRefreshInterval = setInterval(() => {
    const logsPanel = $('#panelLogs');
    if (logsPanel && logsPanel.classList.contains('active')) {
      loadLogs();
    }
  }, 2000);
}

// ═══════════════════════════════════════════════════════════
// SETTINGS PERSISTENCE
// ═══════════════════════════════════════════════════════════

let saveDebounceTimer = null;

function saveSettingsDebounced() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(async () => {
    await saveSettings(settings);
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings }).catch(() => {});
  }, 300);
}

async function saveAndUpdate() {
  await saveSettings(settings);
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function toggleSettingBody(body, show) {
  body.classList.toggle('visible', show);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');

  setTimeout(() => {
    toast.classList.remove('visible');
  }, 2000);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════

init();
