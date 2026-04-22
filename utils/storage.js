// Auto Refresh Pro — Storage Utilities
// Wraps chrome.storage.local (persistent) and chrome.storage.session (ephemeral logs)

export const DEFAULT_SETTINGS = {
  interval: 10,
  urls: [],
  matchMode: 'domain', // 'domain' | 'domainPath' | 'domainPathQuery'
  randomEnabled: false,
  randomMin: 5,
  randomMax: 15,
  hardRefresh: false,
  allTabs: false,
  limitEnabled: false,
  limitCount: 50,
  detectChanges: false,
  detectAction: 'notify', // 'notify' | 'stop'
  notificationsEnabled: false,
  theme: 'dark', // 'dark' | 'light' | 'system'
  language: 'en',
  shortcutModifiers: ['Alt', 'Shift'],
  shortcutKey: 'R',
};

export async function getSettings() {
  try {
    const result = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
  } catch (e) {
    console.warn('Failed to get settings:', e);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  try {
    await chrome.storage.local.set({ settings });
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

export async function getLogs() {
  try {
    const result = await chrome.storage.session.get('logs');
    return result.logs || [];
  } catch (e) {
    return [];
  }
}

export async function addLog(entry) {
  try {
    const logs = await getLogs();
    logs.unshift({
      ...entry,
      timestamp: Date.now(),
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    });
    // Keep max 100 entries
    if (logs.length > 100) logs.length = 100;
    await chrome.storage.session.set({ logs });
  } catch (e) {
    console.error('Failed to add log:', e);
  }
}

export async function clearLogs() {
  try {
    await chrome.storage.session.set({ logs: [] });
  } catch (e) {
    console.error('Failed to clear logs:', e);
  }
}
