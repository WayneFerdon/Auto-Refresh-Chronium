/*
 * @Author: WayneFerdon wayneferdon@hotmail.com
 * @Date: 2026-05-29 16:46:01
 * @LastEditors: WayneFerdon wayneferdon@hotmail.com
 * @LastEditTime: 2026-09-01 23:19:49
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
	isRefreshing: false,  // guard against re-entry while performing refresh
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

	// Prevent re-entry while a refresh batch is in flight (setInterval does
	// not wait for async work, so without this guard every second would
	// trigger another performRefresh once countdown hits 0).
	if (state.isRefreshing) return;

	state.countdown--;
	updateBadge();
	broadcastState();

	if (state.countdown <= 0) {
		state.isRefreshing = true;
		try {
			await performRefresh();
		} catch (e) {
			console.error('Auto Refresh: performRefresh failed:', e);
		} finally {
			state.isRefreshing = false;
		}
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

	// Page change detection (serial — may trigger a stop)
	if (settings.detectChanges) {
		for (const tab of tabs) {
			const shouldStop = await checkPageChange(tab, settings);
			if (shouldStop) return;
		}
	}

	// Hard refresh: clear origin cache first (dedupe by origin)
	if (settings.hardRefresh) {
		const origins = new Set();
		for (const tab of tabs) {
			try {
				origins.add(new URL(tab.url).origin);
			} catch (e) {
				// ignore malformed URLs
			}
		}
		await Promise.allSettled(
			[...origins].map(origin =>
				chrome.browsingData.remove({ origins: [origin] }, { cache: true }).catch(() => { })
			)
		);
	}

	// Refresh all target tabs concurrently
	const results = await Promise.allSettled(
		tabs.map(tab => refreshTab(tab, settings))
	);

	// Collect logs for tabs that successfully reloaded
	const logs = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (r.status === 'fulfilled' && r.value === true) {
			const tab = tabs[i];
			logs.push({
				type: 'refresh',
				tabId: tab.id,
				url: tab.url,
				title: tab.title || 'Untitled',
			});
		}
	}

	// Serial log writes (avoid storage race)
	for (const log of logs) {
		try {
			await addLog(log);
		} catch (e) {
			console.warn('Auto Refresh: addLog failed', e);
		}
	}

	// Count one per refresh round (每完成一轮倒计时算一次).
	// If you'd rather count per-tab, use: state.refreshCount += logs.length;
	state.refreshCount++;

	resetCountdown(settings);
	broadcastState();
}

// Refresh a single tab. Returns true on success, false otherwise.
async function refreshTab(tab, settings) {
	try {
		// Inject a small marker script
		try {
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => console.log('auto refresh on time'),
			});
		} catch (err) {
			console.warn('无法向标签页注入脚本:', err.message);
		}

		// Reload the tab
		await chrome.tabs.reload(tab.id, { bypassCache: settings.hardRefresh });
		return true;
	} catch (e) {
		console.error('Auto Refresh: Failed to refresh tab', tab.id, e);
		return false;
	}
}

async function getTargetTabs(settings) {
	let tabs = [];

	try {
		if (settings.allTabs) {
			tabs = await chrome.tabs.query({});
		} else if (settings.urls && settings.urls.length > 0) {
			tabs = await chrome.tabs.query({});
			tabs = tabs.filter(tab => matchesUrlList(tab.url, settings.urls));
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

function matchesUrlList(tabUrl, urls) {
	if (!tabUrl) return false;

	try {
		return urls.some(entry => tabUrl.match(new RegExp(entry)));
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
	state.isRefreshing = false;

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
	state.isRefreshing = false;
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
				format = 'hhmm';
				break;
			case seconds >= 1000:
				format = 'mmss';
				break;
			default:
				format = 'ss';
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
		const text = formatSeconds(state.countdown);
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

// ═══════════════════════════════════════════════════════════
// RELOAD-ON-ERROR
// ═══════════════════════════════════════════════════════════

// Dedupe key set so the same tab isn't reloaded twice concurrently
// when both webRequest and webNavigation fire for the same failure.
const errorReloadPending = new Set();

chrome.webRequest.onErrorOccurred.addListener(handleError, { urls: ["<all_urls>"] });
chrome.webNavigation.onErrorOccurred.addListener(handleError);

async function handleError(details) {
	// Only top-frame errors matter
	if (details.frameId !== 0) return;
	if (details.tabId == null || details.tabId < 0) return;

	const key = details.tabId;
	if (errorReloadPending.has(key)) return;
	errorReloadPending.add(key);

	try {
		let settings = await getSettings();
		if (!settings.onErrorEnabled) return;

		// Wait configured seconds before reloading (in case it self-recovers)
		let waited = 0;
		while (waited < settings.onErrorInterval) {
			await new Promise(resolve => setTimeout(resolve, 1000));
			settings = await getSettings();
			if (!settings.onErrorEnabled) return;
			waited++;
		}

		const tabs = await getOnErrorTargetTabs(settings);
		const tab = tabs.find(t => t?.id === details.tabId);
		if (!tab) return;

		console.log('reload on error', tab.title);

		// Hard refresh: clear origin cache first
		if (settings.hardRefresh) {
			try {
				const origin = new URL(tab.url).origin;
				await chrome.browsingData.remove({ origins: [origin] }, { cache: true });
			} catch (e) {
				// Silently continue
			}
		}

		await chrome.tabs.reload(tab.id, { bypassCache: settings.hardRefresh });

		await addLog({
			type: 'refresh',
			tabId: tab.id,
			url: tab.url,
			title: tab.title || 'Untitled',
		});
	} catch (e) {
		console.error('Auto Refresh: onError reload failed', e);
	} finally {
		errorReloadPending.delete(key);
	}
}

async function getOnErrorTargetTabs(settings) {
	let tabs = [];

	try {
		if (settings.onErrorUrls && settings.onErrorUrls.length > 0) {
			tabs = await chrome.tabs.query({});
			tabs = tabs.filter(tab => matchesUrlList(tab.url, settings.onErrorUrls));
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

// ═══════════════════════════════════════════════════════════
// LAUNCH ON STARTUP
// ═══════════════════════════════════════════════════════════

async function onLaunch() {
	const settings = await getSettings();
	if (!settings.onLaunch) return;
	doStart();
}

onLaunch();

// ═══════════════════════════════════════════════════════════
// FOCUS EMULATION (chrome.debugger)
// ═══════════════════════════════════════════════════════════

const activeTabs = new Set();

async function enableFocusEmulationForTab(tabId) {
	if (activeTabs.has(tabId)) return;
	const settings = await getSettings();
	if (!settings.focusEmulationEnabled) return;
	const tabs = await getFocusEmulationTargetTabs(settings);
	const tab = tabs.find(t => t.id === tabId);
	if (!tab) return;

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
			tabs = tabs.filter(tab => matchesUrlList(tab.url, settings.focusEmulationUrls));
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