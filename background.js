const ALARM_NAME = 'heyback-check';
const INTERVAL = 3;
const DEFAULTS = { enabled: false, messages: [], dailyCap: 15, seenFollowers: [], sentLog: [], sentToday: 0, sentTotalCount: 0, lastResetDate: new Date().toISOString().slice(0,10), blockedUntil: null, hasCompletedFirstRun: false, onboardingDone: false, safetyAcknowledged: false, lastAlarmAt: null, lastCheckResult: [], dmJob: null, lastVerifyResult: null, autoDiagnoseResult: null, pendingDiagnose: false, simulateTarget: null };

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null); const merged = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (existing[k] !== undefined) merged[k] = existing[k];
  if (existing.firstRunDone !== undefined && existing.hasCompletedFirstRun === undefined) merged.hasCompletedFirstRun = existing.firstRunDone;
  await chrome.storage.local.set(merged); await setupAlarm();
});
chrome.runtime.onStartup.addListener(setupAlarm);
async function setupAlarm() { await chrome.alarms.clear(ALARM_NAME); chrome.alarms.create(ALARM_NAME, { delayInMinutes: INTERVAL, periodInMinutes: INTERVAL }); }

async function findIGTab(force) {
  let t = await chrome.tabs.query({ url: 'https://www.instagram.com/*', active: true, lastFocusedWindow: true });
  if (!t.length) t = await chrome.tabs.query({ url: 'https://www.instagram.com/*', active: true });
  if (!t.length && force) t = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  return t[0] || null;
}
async function focusIGTab(tab) {
  try { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  await new Promise(r => setTimeout(r, 800));
}
async function forwardToIG(msg, respond) {
  const tab = await findIGTab(true); if (!tab) { respond({ ok: false, error: 'no IG tab' }); return; }
  await focusIGTab(tab);
  try { await chrome.tabs.sendMessage(tab.id, msg); respond({ ok: true }); } catch (e) { respond({ ok: false, error: e.message }); }
}

async function dispatch() {
  const now = Date.now();
  const p = [{ stage: 'alarm_fired', status: 'ok', detail: 'Check cycle started', ts: now }];
  await chrome.storage.local.set({ lastAlarmAt: now, lastCheckResult: p });
  const data = await chrome.storage.local.get(null);
  if (!data.enabled) { p.push({ stage: 'final_status', status: 'skip', detail: 'HeyBack is off', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  if (data.blockedUntil && Date.now() < data.blockedUntil) { p.push({ stage: 'final_status', status: 'skip', detail: 'Paused', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  if (data.blockedUntil) await chrome.storage.local.set({ blockedUntil: null });
  const today = new Date().toISOString().slice(0,10);
  if (data.lastResetDate !== today) await chrome.storage.local.set({ sentToday: 0, lastResetDate: today });
  const sent = data.lastResetDate !== today ? 0 : data.sentToday;
  if (sent >= Math.min(data.dailyCap||15, 30)) { p.push({ stage: 'final_status', status: 'skip', detail: `Daily limit (${sent})`, ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  if (!data.messages?.length) { p.push({ stage: 'final_status', status: 'skip', detail: 'No messages', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  if (data.dmJob?.phase && data.dmJob.phase !== 'idle' && Date.now() - (data.dmJob.started||0) > 5*60*1000) await chrome.storage.local.set({ dmJob: { phase: 'idle' } });
  if (data.dmJob?.phase && data.dmJob.phase !== 'idle' && Date.now() - (data.dmJob.started||0) <= 5*60*1000) { p.push({ stage: 'final_status', status: 'skip', detail: 'Send in progress', ts: Date.now() }); await chrome.storage.local.set({ lastCheckResult: p }); return; }
  const tab = await findIGTab(true);
  p.push({ stage: 'tab_query_result', status: tab ? 'ok' : 'fail', detail: tab ? `tab ${tab.id}` : 'Instagram tab not open', ts: Date.now() });
  await chrome.storage.local.set({ lastCheckResult: p }); if (!tab) return;
  await focusIGTab(tab);
  try { const r = await chrome.tabs.sendMessage(tab.id, { type: 'RUN_CHECK' }); p.push({ stage: 'message_sent_to_content', status: r?.ok ? 'ok' : 'fail', detail: r?.ok ? 'ok' : JSON.stringify(r), ts: Date.now() }); }
  catch (e) { p.push({ stage: 'message_sent_to_content', status: 'fail', detail: e.message, ts: Date.now() }); }
  await chrome.storage.local.set({ lastCheckResult: p });
}

chrome.alarms.onAlarm.addListener(async a => { if (a.name === ALARM_NAME) await dispatch(); });

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'MANUAL_RUN_CHECK') { dispatch().then(() => respond({ ok: true })); return true; }
  if (msg.type === 'VERIFY_LAST_SEND') { forwardToIG({ type: 'VERIFY_LAST_SEND' }, respond); return true; }
  if (msg.type === 'TEST_SEND') { forwardToIG({ type: 'TEST_SEND', username: msg.username, message: msg.message }, respond); return true; }
  if (msg.type === 'FORCE_RESET_JOB') { chrome.storage.local.set({ dmJob: { phase: 'idle' } }).then(() => respond({ ok: true })); return true; }
  if (msg.type === 'RESET_TODAY') { chrome.storage.local.set({ sentToday: 0 }).then(() => respond({ ok: true })); return true; }
  if (msg.type === 'RESET_ALL') { forwardToIG({ type: 'RESET_ALL' }, respond); return true; }
  if (msg.type === 'AUTO_DIAGNOSE') { forwardToIG({ type: 'AUTO_DIAGNOSE' }, respond); return true; }
  if (msg.type === 'MANUAL_TEST_TYPING') { forwardToIG({ type: 'MANUAL_TEST_TYPING' }, respond); return true; }
  if (msg.type === 'SIMULATE_AUTO_FLOW') { forwardToIG({ type: 'SIMULATE_AUTO_FLOW' }, respond); return true; }
});
