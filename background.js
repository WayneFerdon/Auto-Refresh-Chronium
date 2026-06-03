/*
 * @Author: WayneFerdon wayneferdon@hotmail.com
 * @Date: 2026-05-29 16:46:01
 * @LastEditors: WayneFerdon wayneferdon@hotmail.com
 * @LastEditTime: 2026-06-04 00:08:05
 * @FilePath: \Auto-Refresh-Chronium\background.js
 * ----------------------------------------------------------------
 * Licensed to the .NET Foundation under one or more agreements.
 * The .NET Foundation licenses this file to you under the MIT license.
 */
// Auto Refresh Pro — Background Service Worker
// Core engine: timers, tab refresh, badge, URL matching, page change detection

import { getSettings, saveSettings, addLog, clearLogs, getLogs } from './utils/storage.js';

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

const state = {
	isRunning: false,
	countdown: 0,
	currentInterval: 10,
	refreshCount: 0,
	pageHashes: {},       // tabId -> hash string
	tickIntervalId: null, // setInterval ID
};

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
	const settings = await getSettings();
	state.currentInterval = settings.interval;
	state.countdown = settings.interval;
	updateBadge();
});

chrome.runtime.onStartup.addListener(() => restoreState());

// Restore immediately in case SW restarted mid-session
restoreState();

async function restoreState() {
	try {
		const result = await chrome.storage.session.get('refreshState');
		if (result.refreshState && result.refreshState.isRunning) {
			const saved = result.refreshState;
			state.currentInterval = saved.currentInterval || 10;
			state.refreshCount = saved.refreshCount || 0;
			state.isRunning = true;

			// Calculate remaining time from saved target
			if (saved.nextRefreshTime) {
				const remaining = Math.max(1, Math.round((saved.nextRefreshTime - Date.now()) / 1000));
				state.countdown = Math.min(remaining, state.currentInterval);
			} else {
				state.countdown = state.currentInterval;
			}

			startTick();
			startKeepAlive();
			updateBadge();
		}
	} catch (e) {
		console.warn('Auto Refresh: Failed to restore state:', e);
	}
}

async function persistState() {
	try {
		await chrome.storage.session.set({
			refreshState: {
				isRunning: state.isRunning,
				currentInterval: state.currentInterval,
				refreshCount: state.refreshCount,
				nextRefreshTime: state.isRunning ? Date.now() + (state.countdown * 1000) : 0,
			}
		});
	} catch (e) {
		// Session storage may not be available
	}
}

// ═══════════════════════════════════════════════════════════
// TICK ENGINE
// ═══════════════════════════════════════════════════════════

function startTick() {
	stopTick();
	state.tickIntervalId = setInterval(tick, 1000);
}

function stopTick() {
	if (state.tickIntervalId) {
		clearInterval(state.tickIntervalId);
		state.tickIntervalId = null;
	}
}

async function tick() {
	if (!state.isRunning) return;

	state.countdown--;
	updateBadge();
	broadcastState();

	if (state.countdown <= 0) {
		await performRefresh();
	}

	// Persist for recovery
	persistState();
}

// ═══════════════════════════════════════════════════════════
// KEEP-ALIVE (prevent SW termination)
// ═══════════════════════════════════════════════════════════

function startKeepAlive() {
	chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

function stopKeepAlive() {
	chrome.alarms.clear('keepAlive');
}

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === 'keepAlive' && state.isRunning && !state.tickIntervalId) {
		// Timer died, restart it
		startTick();
	}
});

// ═══════════════════════════════════════════════════════════
// CORE REFRESH LOGIC
// ═══════════════════════════════════════════════════════════

async function performRefresh() {
	const settings = await getSettings();

	// Check refresh limit
	if (settings.limitEnabled && state.refreshCount >= settings.limitCount) {
		await addLog({ type: 'limit', message: 'Refresh limit reached' });

		if (settings.notificationsEnabled) {
			safeNotify('limit-' + Date.now(), {
				type: 'basic',
				title: 'Auto Refresh Pro',
				message: 'Refresh limit reached. Stopping.',
				iconUrl: 'icons/icon128.png',
			});
		}

		doStop();
		broadcastState();
		return;
	}

	// Get target tabs
	const tabs = await getTargetTabs(settings);

	if (tabs.length === 0) {
		resetCountdown(settings);
		return;
	}

	for (const tab of tabs) {
		try {
			// Page change detection (before refresh)
			if (settings.detectChanges) {
				const shouldStop = await checkPageChange(tab, settings);
				if (shouldStop) return;
			}

			// Hard refresh: clear origin cache first
			if (settings.hardRefresh) {
				try {
					const origin = new URL(tab.url).origin;
					await chrome.browsingData.remove({ origins: [origin] }, { cache: true });
				} catch (e) {
					// Silently continue
				}
			}

			// Reload the tab
			await chrome.tabs.reload(tab.id, { bypassCache: settings.hardRefresh });

			await addLog({
				type: 'refresh',
				tabId: tab.id,
				url: tab.url,
				title: tab.title || 'Untitled',
			});
		} catch (e) {
			console.error('Auto Refresh: Failed to refresh tab', tab.id, e);
		}
	}

	state.refreshCount++;
	resetCountdown(settings);
}

async function getTargetTabs(settings) {
	let tabs = [];

	try {
		if (settings.allTabs) {
			tabs = await chrome.tabs.query({});
		} else if (settings.urls && settings.urls.length > 0) {
			tabs = await chrome.tabs.query({});
			tabs = tabs.filter(tab => matchesUrlList(tab.url, settings.urls, settings.matchMode));
		} else {
			const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
			if (activeTabs.length > 0) tabs = activeTabs;
		}
	} catch (e) {
		console.error('Auto Refresh: Failed to query tabs:', e);
	}

	// Filter out non-web pages
	return tabs.filter(tab =>
		tab.url &&
		(tab.url.startsWith('http://') || tab.url.startsWith('https://'))
	);
}

async function checkPageChange(tab, settings) {
	try {
		const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_HASH' });
		if (response && response.hash) {
			const prevHash = state.pageHashes[tab.id];
			state.pageHashes[tab.id] = response.hash;

			if (prevHash && prevHash !== response.hash) {
				await addLog({
					type: 'change',
					tabId: tab.id,
					url: tab.url,
					title: tab.title || 'Untitled',
				});

				if (settings.notificationsEnabled) {
					safeNotify('change-' + Date.now(), {
						type: 'basic',
						title: 'Page Changed',
						message: tab.title || tab.url,
						iconUrl: 'icons/icon128.png',
					});
				}

				if (settings.detectAction === 'stop') {
					doStop();
					broadcastState();
					return true; // Signal to stop
				}
			}
		}
	} catch (e) {
		// Content script not available (chrome:// pages, etc.)
	}
	return false;
}

function resetCountdown(settings) {
	if (settings.randomEnabled) {
		const min = Math.max(1, parseInt(settings.randomMin) || 1);
		const max = Math.max(min + 1, parseInt(settings.randomMax) || min + 1);
		state.currentInterval = randomBetween(min, max);
	}
	state.countdown = state.currentInterval;
}

// ═══════════════════════════════════════════════════════════
// URL MATCHING
// ═══════════════════════════════════════════════════════════

function matchesUrlList(tabUrl, urls, matchMode) {
	if (!tabUrl) return false;

	try {
		const tabUrlObj = new URL(tabUrl);
		const tabDomain = tabUrlObj.hostname.replace(/^www\./, '');

		return urls.some(entry => {
			try {
				let entryDomain, entryPath, entrySearch;

				if (entry.includes('://')) {
					const entryUrl = new URL(entry);
					entryDomain = entryUrl.hostname.replace(/^www\./, '');
					entryPath = entryUrl.pathname;
					entrySearch = entryUrl.search;
				} else if (entry.includes('/')) {
					const entryUrl = new URL('https://' + entry);
					entryDomain = entryUrl.hostname.replace(/^www\./, '');
					entryPath = entryUrl.pathname;
					entrySearch = entryUrl.search;
				} else {
					// Just a domain name
					return tabDomain === entry.replace(/^www\./, '');
				}

				// Domain must always match
				if (tabDomain !== entryDomain) return false;
				if (matchMode === 'domain') return true;

				// Path match
				if (matchMode === 'domainPath' || matchMode === 'domainPathQuery') {
					const tabPath = tabUrlObj.pathname.replace(/\/$/, '') || '';
					const cleanEntryPath = (entryPath || '').replace(/\/$/, '') || '';
					if (cleanEntryPath && cleanEntryPath !== '' && tabPath !== cleanEntryPath) return false;
					if (matchMode === 'domainPath') return true;

					// Query match
					return tabUrlObj.search === (entrySearch || '');
				}

				return true;
			} catch (e) {
				return false;
			}
		});
	} catch (e) {
		return false;
	}
}

// ═══════════════════════════════════════════════════════════
// CONTROL FUNCTIONS
// ═══════════════════════════════════════════════════════════

async function doStart() {
	const settings = await getSettings();

	if (settings.randomEnabled) {
		const min = Math.max(1, parseInt(settings.randomMin) || 1);
		const max = Math.max(min + 1, parseInt(settings.randomMax) || min + 1);
		state.currentInterval = randomBetween(min, max);
	} else {
		state.currentInterval = settings.interval;
	}

	state.countdown = state.currentInterval;
	state.isRunning = true;
	state.refreshCount = 0;
	state.pageHashes = {};

	startTick();
	startKeepAlive();
	updateBadge();
	persistState();

	return { success: true, state: getStateSnapshot() };
}

function doPause() {
	state.isRunning = false;
	stopTick();
	// Keep countdown value for resume
	updateBadge();
	persistState();
	return { success: true, state: getStateSnapshot() };
}

function doResume() {
	state.isRunning = true;
	startTick();
	startKeepAlive();
	updateBadge();
	persistState();
	return { success: true, state: getStateSnapshot() };
}

function doStop() {
	state.isRunning = false;
	stopTick();
	stopKeepAlive();
	state.countdown = 0;
	state.refreshCount = 0;
	state.pageHashes = {};
	updateBadge();
	persistState();
	return { success: true, state: getStateSnapshot() };
}

// ═══════════════════════════════════════════════════════════
// BADGE
// ═══════════════════════════════════════════════════════════

function pad(num, digits = 2) { return String(num).padStart(digits, '0'); }

function formatSeconds(seconds, format = 'auto') {
	if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) seconds = 0;
	seconds = Math.floor(seconds);
	if (format === 'auto') {
		switch (true) {
			case seconds >= 6000: // 99*60+59
				format = 'hhmm'
				break;
			case seconds >= 1000:
				format = 'mmss'
				break;
			default:
				format = 'ss'
				break;
		}
	}
	switch (format) {
		case 'hhmm':
			const hours = Math.floor(seconds / 3600);
			const minutes = Math.floor((seconds % 3600) / 60);
			return `${pad(hours)}:${pad(minutes)}`;
		case 'mmss':
			const totalMinutes = Math.floor(seconds / 60);
			const remainingSeconds = seconds % 60;
			return `${pad(totalMinutes)}:${pad(remainingSeconds)}`;
		case 'ss':
			return `${seconds}`;
		default:
			return formatSeconds(seconds, 'auto');
	}
}

function updateBadge() {
	if (state.isRunning) {
		const text = formatSeconds(state.countdown); // state.countdown > 999 ? '999' : state.countdown.toString();
		chrome.action.setBadgeText({ text });
		chrome.action.setBadgeBackgroundColor({ color: '#ffffff' });
		chrome.action.setBadgeTextColor({ color: '#000000' });
	} else {
		chrome.action.setBadgeText({ text: '' });
	}
}

// ═══════════════════════════════════════════════════════════
// COMMUNICATION
// ═══════════════════════════════════════════════════════════

function broadcastState() {
	chrome.runtime.sendMessage({
		type: 'STATE_UPDATE',
		state: getStateSnapshot(),
	}).catch(() => { });
}

function getStateSnapshot() {
	return {
		isRunning: state.isRunning,
		countdown: state.countdown,
		currentInterval: state.currentInterval,
		refreshCount: state.refreshCount,
	};
}

// ═══════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	(async () => {
		try {
			let result;

			switch (msg.type) {
				case 'START':
					result = await doStart();
					break;

				case 'PAUSE':
					result = doPause();
					break;

				case 'RESUME':
					result = doResume();
					break;

				case 'STOP':
					result = doStop();
					break;

				case 'TOGGLE':
					if (state.isRunning) {
						result = doPause();
					} else {
						result = await doStart();
					}
					break;

				case 'GET_STATE':
					result = { state: getStateSnapshot() };
					break;

				case 'UPDATE_SETTINGS': {
					const current = await getSettings();
					const merged = { ...current, ...msg.settings };
					await saveSettings(merged);

					// Update interval if not currently running
					if (!state.isRunning) {
						if (merged.randomEnabled) {
							const min = Math.max(1, parseInt(merged.randomMin) || 1);
							const max = Math.max(min + 1, parseInt(merged.randomMax) || min + 1);
							state.currentInterval = randomBetween(min, max);
						} else {
							state.currentInterval = merged.interval;
						}

						state.countdown = state.currentInterval;
					}

					result = { success: true };
					break;
				}

				case 'GET_LOGS': {
					const logs = await getLogs();
					result = { logs };
					break;
				}

				case 'CLEAR_LOGS':
					await clearLogs();
					result = { success: true };
					break;

				default:
					result = { error: 'Unknown message type' };
			}

			sendResponse(result);
		} catch (e) {
			console.error('Auto Refresh: Message handler error:', e);
			sendResponse({ error: e.message });
		}
	})();

	return true; // Async response
});

// ═══════════════════════════════════════════════════════════
// KEYBOARD SHORTCUT (chrome.commands)
// ═══════════════════════════════════════════════════════════

chrome.commands.onCommand.addListener(async (command) => {
	if (command === 'toggle-refresh') {
		if (state.isRunning) {
			doPause();
		} else {
			await doStart();
		}

		broadcastState();
	}
});

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function randomBetween(min, max) {
	min = Math.max(1, parseInt(min) || 1);
	max = Math.max(min, parseInt(max) || min);
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function safeNotify(id, options) {
	try {
		chrome.notifications.create(id, options);
	} catch (e) {
		console.warn('Auto Refresh: Notification failed:', e);
	}
}

chrome.webRequest.onErrorOccurred.addListener(handleError, { urls: ["<all_urls>"] });
chrome.webNavigation.onErrorOccurred.addListener(handleError);

async function handleError(details) {
	let settings = await getSettings();
	if (!settings.onErrorEnabled) return;
	if (details.frameId !== 0) return;
	let waited = 0;
	while (waited < settings.onErrorInterval) {
		await new Promise(resolve => setTimeout(resolve, 1000));
		settings = await getSettings();
		waited++;
	}
	if (!settings.onErrorEnabled) return;
	const tabs = await getOnErrorTargetTabs(settings);
	for (const tab of tabs) {
		if (tab?.id !== details.tabId) continue;
		try {
			// Hard refresh: clear origin cache first
			if (settings.hardRefresh) {
				try {
					const origin = new URL(tab.url).origin;
					await chrome.browsingData.remove({ origins: [origin] }, { cache: true });
				} catch (e) {
					// Silently continue
				}
			}

			// Reload the tab
			await chrome.tabs.reload(tab.id, { bypassCache: settings.hardRefresh });

			await addLog({
				type: 'refresh',
				tabId: tab.id,
				url: tab.url,
				title: tab.title || 'Untitled',
			});
		} catch (e) {
			console.error('Auto Refresh: Failed to refresh tab', tab.id, e);
		}
	}
}

async function getOnErrorTargetTabs(settings) {
	let tabs = [];

	try {
		if (settings.onErrorUrls && settings.onErrorUrls.length > 0) {
			tabs = await chrome.tabs.query({});
			tabs = tabs.filter(tab => matchesUrlList(tab.url, settings.onErrorUrls, settings.onErrorMatchMode));
		} else {
			const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
			if (activeTabs.length > 0) tabs = activeTabs;
		}
	} catch (e) {
		console.error('Auto Refresh On Error: Failed to query tabs:', e);
	}

	// Filter out non-web pages
	return tabs.filter(tab =>
		tab.url &&
		(tab.url.startsWith('http://') || tab.url.startsWith('https://'))
	);
}

async function onLaunch() {
	const settings = await getSettings();
	if (!settings.onLaunch) return;
	doStart();
}

onLaunch();

const activeTabs = new Set();

async function enableFocusEmulationForTab(tabId) {
	if (activeTabs.has(tabId)) return;
	let settings = await getSettings();
	const tabs = await getFocusEmulationTargetTabs(settings);
	let tab;
	if (!(tab = tabs.find(tab => tab.id === tabId))) return;

    try {
        await chrome.debugger.attach({ tabId: tabId }, "1.3");
        await chrome.debugger.sendCommand({ tabId: tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
        activeTabs.add(tabId);
    } catch (error) {
        console.warn(`Tab ${tabId}-${tab.title} Failed Focus Emulation: ${error.message}`);
    }
}

chrome.tabs.onCreated.addListener((tab) => {
    enableFocusEmulationForTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        enableFocusEmulationForTab(tabId);
    }
});

async function enableForAllTabs() {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        enableFocusEmulationForTab(tab.id);
    }
}

chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId) {
        activeTabs.delete(source.tabId);
        console.log(`Tab ${source.tabId} DevTool has detached by: ${reason}`);
    }
});

async function getFocusEmulationTargetTabs(settings) {
	let tabs = [];

	try {
		if (settings.focusEmulationUrls && settings.focusEmulationUrls.length > 0) {
			tabs = await chrome.tabs.query({});
			tabs = tabs.filter(tab => matchesUrlList(tab.url, settings.focusEmulationUrls, settings.focusEmulationMatchMode));
		} else {
			const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
			if (activeTabs.length > 0) tabs = activeTabs;
		}
	} catch (e) {
		console.error('Auto Refresh Focus Emulation: Failed to query tabs:', e);
	}

	return tabs.filter(tab =>
		tab.url &&
		(tab.url.startsWith('http://') || tab.url.startsWith('https://'))
	);
}

chrome.runtime.onInstalled.addListener(enableForAllTabs);
chrome.runtime.onStartup.addListener(enableForAllTabs);
