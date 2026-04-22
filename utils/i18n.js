// Auto Refresh Pro — Internationalization Module
// Custom i18n for runtime language switching (more flexible than Chrome's _locales)

let currentLocale = 'en';
let translations = {};
let loadedLocales = {};

/**
 * Load a locale JSON file and set it as current
 */
export async function loadLocale(locale) {
  if (loadedLocales[locale]) {
    translations = loadedLocales[locale];
    currentLocale = locale;
    return;
  }

  try {
    const url = chrome.runtime.getURL(`locales/${locale}.json`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    loadedLocales[locale] = data;
    translations = data;
    currentLocale = locale;
  } catch (e) {
    console.warn(`Failed to load locale "${locale}":`, e);
    // Fallback to English
    if (locale !== 'en') {
      await loadLocale('en');
    }
  }
}

/**
 * Translate a key with optional parameter substitution
 * Usage: t('showingEntries', { count: 5, max: 100 })
 */
export function t(key, params = {}) {
  let text = translations[key] || key;
  for (const [param, value] of Object.entries(params)) {
    text = text.replace(new RegExp(`\\{${param}\\}`, 'g'), String(value));
  }
  return text;
}

/**
 * Apply translations to all elements with data-i18n attributes
 * Supports: data-i18n (textContent), data-i18n-placeholder, data-i18n-title
 */
export function applyTranslations(root = document) {
  // Text content
  const elements = root.querySelectorAll('[data-i18n]');
  elements.forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text !== key) {
      el.textContent = text;
    }
  });

  // Placeholders
  const placeholders = root.querySelectorAll('[data-i18n-placeholder]');
  placeholders.forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const text = t(key);
    if (text !== key) {
      el.placeholder = text;
    }
  });

  // Titles / tooltips
  const titles = root.querySelectorAll('[data-i18n-title]');
  titles.forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const text = t(key);
    if (text !== key) {
      el.title = text;
    }
  });
}

export function getCurrentLocale() {
  return currentLocale;
}
