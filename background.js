const ALARM_NAME = 'heyback-check';
const INTERVAL = 3;

const DEFAULTS = {
  enabled: false, messages: [], dailyCap: 15, seenFollowers: [], sentLog: [],
  sentToday: 0, sentTotalCount: 0, lastResetDate: new Date().toISOString().slice(0, 10),
  blockedUntil: null, hasCompletedFirstRun: false, onboardingDone: false,
  safetyAcknowledged: false, lastAlarmAt: null, lastCheckResult: [],
  dmJob: { phase: 'idle' }, lastVerifyResult: null, autoDiagnoseResult: null,
  simulateTarget: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const merged = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (existing[k] !== undefined) merged[k] = existing[k];
  }
  // Always clear stuck state on install/update
  merged.dmJob = { phase: 'idle' };
  merged.blockedUntil = null;
  await chrome.storage.local.set(merged);
  await setupAlarm();
});

chrome.runtime.onStartup.addListener(setupAlarm);

async function setupAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: INTERVAL, periodInMinutes: INTERVAL });
}

async function findIGTab() {
  let t = await chrome.tabs.query({ url: 'https://www.instagram.com/*', active: true, lastFocusedWindow: true });
  if (!t.length) t = await chrome.tabs.query({ url: 'https://www.instagram.com/*', active: true });
  if (!t.length) t = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  return t[0] || null;
}

async function focusTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (_) {}
  await new Promise(r => setTimeout(r, 800));
}

async function sendToContent(msg) {
  const tab = await findIGTab();
  if (!tab) return { ok: false, error: 'no instagram tab' };
  await focusTab(tab);
  try {
    const r = await chrome.tabs.sendMessage(tab.id, msg);
    return r || { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function dispatch() {
  const now = Date.now();
  await chrome.storage.local.set({ lastAlarmAt: now });

  const data = await chrome.storage.local.get(null);
  if (!data.enabled) return;
  if (data.blockedUntil && Date.now() < data.blockedUntil) return;
  if (data.blockedUntil) await chrome.storage.local.set({ blockedUntil: null });

  const today = new Date().toISOString().slice(0, 10);
  if (data.lastResetDate !== today) await chrome.storage.local.set({ sentToday: 0, lastResetDate: today });

  const sent = data.lastResetDate !== today ? 0 : (data.sentToday || 0);
  if (sent >= Math.min(data.dailyCap || 15, 30)) return;
  if (!data.messages?.length) return;

  // Clear stale jobs
  if (data.dmJob?.phase && data.dmJob.phase !== 'idle' && Date.now() - (data.dmJob.started || 0) > 10 * 60 * 1000) {
    await chrome.storage.local.set({ dmJob: { phase: 'idle' } });
  }
  if (data.dmJob?.phase && data.dmJob.phase !== 'idle') return;

  await sendToContent({ type: 'RUN_CHECK' });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM_NAME) await dispatch();
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const handle = async () => {
    switch (msg.type) {
      case 'MANUAL_RUN_CHECK':
        await dispatch();
        return { ok: true };
      case 'TEST_SEND':
      case 'VERIFY_LAST_SEND':
      case 'AUTO_DIAGNOSE':
      case 'MANUAL_TEST_TYPING':
      case 'SIMULATE_AUTO_FLOW':
      case 'RESET_ALL':
        return await sendToContent(msg);
      case 'FORCE_RESET_JOB':
        await chrome.storage.local.set({ dmJob: { phase: 'idle' } });
        return { ok: true };
      case 'RESET_TODAY':
        await chrome.storage.local.set({ sentToday: 0 });
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message type' };
    }
  };
  handle().then(respond).catch(() => respond({ ok: false }));
  return true; // keep channel open for async response
});
