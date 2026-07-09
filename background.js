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
  merged.dmJob = { phase: 'idle' };
  merged.blockedUntil = null;
  await chrome.storage.local.set(merged);
  await setupAlarm();
});

chrome.runtime.onStartup.addListener(setupAlarm);

async function setupAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  // First fire after 6 seconds, then every 3 minutes
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1, periodInMinutes: INTERVAL });
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
  const p = [{ stage: 'alarm', status: 'ok', detail: 'auto check fired', ts: now }];
  await chrome.storage.local.set({ lastAlarmAt: now, lastCheckResult: p });

  const data = await chrome.storage.local.get(null);

  if (!data.enabled) { p.push({ stage: 'skip', status: 'skip', detail: 'toggle is OFF', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  if (!data.messages?.length) { p.push({ stage: 'skip', status: 'skip', detail: 'no messages set', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  if (data.blockedUntil && Date.now() < data.blockedUntil) { p.push({ stage: 'skip', status: 'skip', detail: 'paused by instagram', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  if (data.blockedUntil) await chrome.storage.local.set({ blockedUntil: null });

  const today = new Date().toISOString().slice(0, 10);
  if (data.lastResetDate !== today) await chrome.storage.local.set({ sentToday: 0, lastResetDate: today });
  const sent = data.lastResetDate !== today ? 0 : (data.sentToday || 0);
  if (sent >= Math.min(data.dailyCap || 15, 30)) { p.push({ stage: 'skip', status: 'skip', detail: `daily limit hit (${sent})`, ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }

  if (data.dmJob?.phase && data.dmJob.phase !== 'idle') {
    if (Date.now() - (data.dmJob.started || 0) > 10 * 60 * 1000) {
      await chrome.storage.local.set({ dmJob: { phase: 'idle' } });
      p.push({ stage: 'fix', status: 'ok', detail: 'cleared stale job', ts: Date.now() });
    } else {
      p.push({ stage: 'skip', status: 'skip', detail: 'send already in progress', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return;
    }
  }

  p.push({ stage: 'dispatch', status: 'ok', detail: 'sending RUN_CHECK to instagram tab', ts: Date.now() });
  await chrome.storage.local.set({ lastCheckResult: p });

  const result = await sendToContent({ type: 'RUN_CHECK' });

  p.push({ stage: 'result', status: result.ok ? 'ok' : 'fail', detail: result.ok ? 'content script responded' : (result.error || 'no response'), ts: Date.now() });
  await chrome.storage.local.set({ lastCheckResult: p });
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
        return { ok: false, error: 'unknown' };
    }
  };
  handle().then(respond).catch(() => respond({ ok: false }));
  return true;
});
