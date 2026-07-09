// HeyBack v4 — production engine
// Auto-starts on alarm. No manual clicks needed.
// Sends via profile page. Checks existing threads before sending.
// Navigates home after each send. Handles message requests.

(() => {
  const IG_APP_ID = '936619743392459';
  const MAX_BATCH = 3;
  const MIN_DELAY = 45000;
  const MAX_DELAY = 90000;
  const ABS_MAX_DAILY = 30;
  const BLOCK_RE = /action blocked|try again|challenge|verify your|we limit|temporarily blocked/i;
  const JOB_STALE_MS = 10 * 60 * 1000;

  let isRunning = false;
  let lastMsgIdx = -1;

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.type === 'RUN_CHECK') { if (isRunning) respond({ ok: false }); else { runCheck(); respond({ ok: true }); } }
    else if (msg.type === 'TEST_SEND') { testSend(msg.username, msg.message); respond({ ok: true }); }
    else if (msg.type === 'VERIFY_LAST_SEND') { doVerify().then(r => chrome.storage.local.set({ lastVerifyResult: r })); respond({ ok: true }); }
    else if (msg.type === 'FORCE_RESET_JOB') { chrome.storage.local.set({ dmJob: { phase: 'idle' } }).then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'RESET_TODAY') { chrome.storage.local.set({ sentToday: 0 }).then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'RESET_ALL') { chrome.storage.local.clear().then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'AUTO_DIAGNOSE') { runDiagnose(); respond({ ok: true }); }
    else if (msg.type === 'SIMULATE_AUTO_FLOW') { simulateAutoFlow(); respond({ ok: true }); }
    else if (msg.type === 'MANUAL_TEST_TYPING') { runDiagnose(); respond({ ok: true }); }
    else if (msg.type === 'MANUAL_RUN_CHECK') { if (!isRunning) runCheck(); respond({ ok: true }); }
    return true;
  });

  // ═══ HELPERS ═══

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function getCookie(n) { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]+)')); return m ? m[1] : null; }
  function strip(u) { return (u || '').replace(/^@+/, ''); }
  function checkBlock() { for (const d of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) if (BLOCK_RE.test(d.innerText)) return true; return false; }
  function pickMsg(msgs) { if (msgs.length <= 1) return msgs[0] || ''; let i, t = 0; do { i = Math.floor(Math.random() * msgs.length); t++; } while (i === lastMsgIdx && t < 10); lastMsgIdx = i; return msgs[i]; }

  async function log(stage, status, detail) {
    const d = await chrome.storage.local.get('lastCheckResult');
    const a = d.lastCheckResult || [];
    a.push({ stage, status, detail, ts: Date.now() });
    await chrome.storage.local.set({ lastCheckResult: a });
  }

  async function markSeen(username) {
    const d = await chrome.storage.local.get('seenFollowers');
    const s = new Set(d.seenFollowers || []);
    const before = s.size;
    s.add(username);
    await chrome.storage.local.set({ seenFollowers: Array.from(s) });
    await log('seen', 'ok', `@${username} marked seen (${before} -> ${s.size})`);
  }

  async function forceFocus() {
    window.focus(); document.body.click(); await sleep(300);
    return document.hasFocus();
  }

  function click(el) {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  async function waitFor(fn, ms = 15000) {
    const t = Date.now();
    while (Date.now() - t < ms) { const r = fn(); if (r) return r; await sleep(300); }
    return null;
  }

  async function typeInComposer(el, message) {
    el.focus(); await sleep(50);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(100);
    document.execCommand('insertText', false, message);
    const actual = el.textContent;
    if (actual.length > message.length + 2) {
      el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
      throw new Error('duplicate in composer');
    }
    await sleep(300);
  }

  function goHome() {
    window.location.href = 'https://www.instagram.com/';
  }

  // ═══ CHECK IF ALREADY MESSAGED ═══
  // Before sending, check if a DM thread already exists with this person.
  // If it does, skip them — we only send the FIRST message ever.

  async function alreadyMessaged(username) {
    try {
      const r = await fetch(`/api/v1/direct_v2/inbox/?limit=20&_t=${Date.now()}`, {
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': getCookie('csrftoken') || '' },
        credentials: 'include'
      });
      if (!r.ok) return false; // can't check, assume not messaged
      const j = await r.json();
      for (const t of (j.inbox?.threads || [])) {
        if ((t.users || []).some(u => u.username.toLowerCase() === username.toLowerCase())) {
          await log('check', 'skip', `@${username} already has a DM thread, skipping`);
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // ═══ GET USER ID ═══

  async function getUserId() {
    const c = getCookie('ds_user_id');
    if (c) return c;
    const u = getCookie('ds_user');
    if (u) {
      try {
        const r = await fetch(`/api/v1/users/web_profile_info/?username=${u}`, { headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' });
        if (r.ok) { const j = await r.json(); return String(j.data?.user?.id || j.data?.user?.pk || ''); }
      } catch (_) {}
    }
    return null;
  }

  // ═══ FETCH NEW FOLLOWERS ═══

  async function fetchNewFollowerUsernames(userId) {
    const all = new Set();

    // Source 1: notifications
    try {
      const r = await fetch('/api/v1/news/inbox/?_t=' + Date.now(), {
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': getCookie('csrftoken') || '' },
        credentials: 'include'
      });
      if (r.ok) {
        const j = await r.json();
        for (const s of [...(j.new_stories || []), ...(j.old_stories || [])]) {
          if (s.story_type === 101 || (s.args?.text || '').includes('started following')) {
            const name = s.args?.profile_name || s.args?.username || '';
            if (name) all.add(name);
            if (s.args?.inline_follow?.user_info?.username) all.add(s.args.inline_follow.user_info.username);
          }
        }
        await log('fetch', 'ok', `notifications: ${all.size} follows`);
      }
    } catch (e) { await log('fetch', 'fail', `notifications: ${e.message}`); }

    // Source 2: followers API page 1
    try {
      const r = await fetch(`/api/v1/friendships/${userId}/followers/?count=50&search_surface=follow_list_page&_t=${Date.now()}`, {
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': getCookie('csrftoken') || '' },
        credentials: 'include'
      });
      if (r.ok) {
        const j = await r.json();
        for (const u of (j.users || [])) all.add(u.username);
        await log('fetch', 'ok', `API: ${(j.users || []).length} followers`);
      }
    } catch (e) { await log('fetch', 'fail', `API: ${e.message}`); }

    return Array.from(all);
  }

  // ═══ EXECUTE ON PROFILE PAGE ═══
  // Called when we're on instagram.com/{username}
  // Clicks Message, types, sends, then goes HOME immediately

  async function executeOnProfile(username, message) {
    if (!await forceFocus()) {
      await log('send', 'fail', 'tab not focused');
      return { sent: false, started: false };
    }

    await sleep(2000);
    if (checkBlock()) return { sent: false, started: false, blocked: true };

    // Find Message button on profile
    await log('send', 'ok', `on @${username}'s profile, looking for Message button...`);
    const msgBtn = await waitFor(() => {
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const txt = el.textContent.trim().toLowerCase();
        if (txt === 'message' && el.offsetParent) return el;
      }
      const ariaBtn = document.querySelector('[aria-label="Message" i], [aria-label="Send message" i]');
      if (ariaBtn && ariaBtn.offsetParent) return ariaBtn;
      return null;
    }, 8000);

    if (!msgBtn) {
      await log('send', 'fail', 'no Message button found on profile');
      return { sent: false, started: false };
    }

    click(msgBtn);
    await log('send', 'ok', 'clicked Message');
    await sleep(3000);

    if (checkBlock()) return { sent: false, started: true, blocked: true };

    // Handle "Send message request" or regular composer
    // Instagram shows a composer either way, the message just goes to requests
    const composer = await waitFor(() => {
      return document.querySelector('[role="textbox"][contenteditable="true"]')
        || document.querySelector('[aria-label*="essage" i][contenteditable="true"]')
        || document.querySelector('form [contenteditable="true"]');
    }, 10000);

    if (!composer) {
      await log('send', 'fail', 'composer not found');
      return { sent: false, started: true };
    }

    // Check if there are already messages in this thread (manual or previous)
    // If yes, don't send — we only send the FIRST message ever
    await sleep(500);
    const existingMessages = document.querySelectorAll('[role="row"]');
    // More than 1 row usually means there are existing messages (1 row = empty thread placeholder)
    if (existingMessages.length > 2) {
      await log('send', 'skip', `@${username} already has messages in thread, skipping`);
      return { sent: false, started: true, alreadyHasMessages: true };
    }

    try { await typeInComposer(composer, message); }
    catch (e) { await log('send', 'fail', e.message); return { sent: false, started: true }; }

    await log('send', 'ok', `typed: "${message.slice(0, 40)}"`);

    // Click send
    const sendBtn = await waitFor(() => {
      const byAria = document.querySelector('[role="button"][aria-label="Send" i], button[aria-label="Send" i]');
      if (byAria && byAria.offsetParent) return byAria;
      for (const b of document.querySelectorAll('button, [role="button"]'))
        if (b.textContent.trim().toLowerCase() === 'send' && b.offsetParent) return b;
      return null;
    }, 5000);

    if (sendBtn) { click(sendBtn); await log('send', 'ok', 'clicked send'); }
    else {
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      await log('send', 'ok', 'pressed Enter');
    }

    await sleep(2000);
    if (checkBlock()) return { sent: false, started: true, blocked: true };

    // Quick verify
    const verified = document.body.innerText.includes(message);
    const threadUrl = window.location.href;
    await log('send', verified ? 'ok' : 'skip', verified ? `delivered to @${username}` : 'sent, could not verify on page');

    // GO HOME IMMEDIATELY — don't sit in their inbox
    await sleep(500);
    goHome();

    return { sent: true, verified, threadUrl };
  }

  // ═══ VERIFY LAST SEND ═══

  async function doVerify() {
    const d = await chrome.storage.local.get('sentLog');
    const sentLog = d.sentLog || [];
    if (!sentLog.length) return { ok: false, detail: 'No sends yet' };
    const last = sentLog[sentLog.length - 1];
    try {
      const r = await fetch(`/api/v1/direct_v2/inbox/?limit=20&_t=${Date.now()}`, {
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': getCookie('csrftoken') || '' },
        credentials: 'include'
      });
      if (r.ok) {
        const j = await r.json();
        for (const t of (j.inbox?.threads || [])) {
          if ((t.users || []).some(u => u.username.toLowerCase() === last.username.toLowerCase())) {
            const items = t.items || [];
            if (!items.length) return { ok: false, detail: `Thread with @${last.username} empty`, username: last.username };
            const txt = items[0].text || '';
            if (txt.includes(last.message) || last.message.includes(txt))
              return { ok: true, detail: `Delivered: "${txt}"`, username: last.username };
            return { ok: false, detail: `Last msg: "${txt.slice(0, 60)}"`, username: last.username };
          }
        }
        return { ok: false, detail: `No thread with @${last.username}`, username: last.username };
      }
    } catch (_) {}
    return { ok: false, detail: 'Could not verify', username: last?.username };
  }

  // ═══ STATE MACHINE ═══

  async function startBatch(usernames, data) {
    const job = {
      queue: usernames.map(u => ({ username: strip(u), message: pickMsg(data.messages) })),
      index: 0, phase: 'go_to_profile',
      today: data.sentToday || 0, total: data.sentTotalCount || 0,
      cap: Math.min(data.dailyCap || 15, ABS_MAX_DAILY),
      started: Date.now(), fails: 0
    };
    await chrome.storage.local.set({ dmJob: job, lastCheckResult: [] });
    await log('batch', 'ok', `${job.queue.length} to DM: [${usernames.join(', ')}]`);
    window.location.href = `https://www.instagram.com/${job.queue[0].username}/`;
  }

  async function resumeJob() {
    const { dmJob: job } = await chrome.storage.local.get('dmJob');
    if (!job || job.phase === 'idle') return;
    if (Date.now() - job.started > JOB_STALE_MS) {
      job.phase = 'idle'; await chrome.storage.local.set({ dmJob: job });
      await log('job', 'fail', 'timed out'); return;
    }

    const target = job.queue[job.index];
    if (!target) { await finishJob(job); return; }

    if (job.phase === 'go_to_profile' || job.phase === 'on_profile') {
      const path = window.location.pathname.replace(/\/$/, '').toLowerCase();
      const expected = `/${target.username.toLowerCase()}`;

      if (path === expected || path.startsWith(expected + '/')) {
        // We're on the right profile
        job.phase = 'on_profile';
        await chrome.storage.local.set({ dmJob: job });
        await runOnProfile(job);
      } else if (window.location.pathname === '/' || window.location.pathname === '') {
        // We're on home (after a previous send navigated home)
        // Go to the next profile
        window.location.href = `https://www.instagram.com/${target.username}/`;
      } else {
        // Wrong page, navigate
        window.location.href = `https://www.instagram.com/${target.username}/`;
      }
      return;
    }

    if (job.phase === 'waiting') {
      const left = (job.waitUntil || 0) - Date.now();
      if (left > 0) {
        setTimeout(async () => {
          const fresh = (await chrome.storage.local.get('dmJob')).dmJob;
          if (fresh?.phase === 'waiting') {
            fresh.phase = 'go_to_profile';
            await chrome.storage.local.set({ dmJob: fresh });
            const next = fresh.queue[fresh.index];
            if (next) window.location.href = `https://www.instagram.com/${next.username}/`;
            else { fresh.phase = 'idle'; await chrome.storage.local.set({ dmJob: fresh }); }
          }
        }, left);
        return;
      }
      job.phase = 'go_to_profile';
      await chrome.storage.local.set({ dmJob: job });
      window.location.href = `https://www.instagram.com/${target.username}/`;
    }
  }

  async function runOnProfile(job) {
    if (job.index >= job.queue.length || job.today >= job.cap) { await finishJob(job); return; }
    if (checkBlock()) {
      await chrome.storage.local.set({ blockedUntil: Date.now() + 86400000 });
      await finishJob(job); return;
    }

    const { username, message } = job.queue[job.index];
    await log('dm', 'ok', `@${username} (${job.index + 1}/${job.queue.length})`);

    const result = await executeOnProfile(username, message);

    if (result.blocked) {
      await markSeen(username);
      await chrome.storage.local.set({ blockedUntil: Date.now() + 86400000 });
      await log('dm', 'fail', `@${username}: rate limited`);
      await finishJob(job); return;
    }

    if (result.alreadyHasMessages) {
      // Thread exists, skip but mark seen
      await markSeen(username);
      await log('dm', 'skip', `@${username}: already has messages, skipped`);
    } else if (result.sent) {
      await markSeen(username);
      job.today++; job.total++; job.fails = 0;
      const cur = await chrome.storage.local.get('sentLog');
      const sentLog = cur.sentLog || [];
      sentLog.push({ username, message, ts: Date.now(), verified: result.verified, threadUrl: result.threadUrl || '', markedSeen: true });
      if (sentLog.length > 100) sentLog.splice(0, sentLog.length - 100);
      await chrome.storage.local.set({ sentLog, sentToday: job.today, sentTotalCount: job.total });
      await log('dm', 'ok', `@${username}: ${result.verified ? 'DELIVERED' : 'sent'}`);
    } else {
      if (result.started) await markSeen(username);
      job.fails++;
      await log('dm', 'fail', `@${username}: failed`);
      if (job.fails >= 3) { await log('job', 'fail', '3 fails, stopping'); await finishJob(job); return; }
    }

    job.index++;
    if (job.index < job.queue.length && job.today < job.cap) {
      const delay = MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
      job.waitUntil = Date.now() + delay;
      job.phase = 'waiting';
      await chrome.storage.local.set({ dmJob: job });
      await log('job', 'ok', `waiting ${Math.round(delay / 1000)}s...`);
      // goHome already happened in executeOnProfile, so we're waiting on the home page
      setTimeout(async () => {
        const fresh = (await chrome.storage.local.get('dmJob')).dmJob;
        if (fresh?.phase === 'waiting') {
          fresh.phase = 'go_to_profile';
          await chrome.storage.local.set({ dmJob: fresh });
          const next = fresh.queue[fresh.index];
          if (next) window.location.href = `https://www.instagram.com/${next.username}/`;
        }
      }, delay);
    } else {
      await finishJob(job);
    }
  }

  async function finishJob(job) {
    job.phase = 'idle';
    await chrome.storage.local.set({ dmJob: job, sentToday: job.today, sentTotalCount: job.total });
    const { simulateTarget } = await chrome.storage.local.get('simulateTarget');
    if (simulateTarget) {
      await markSeen(simulateTarget);
      await chrome.storage.local.set({ simulateTarget: null });
    }
    await log('done', 'ok', `batch done: ${job.today} sent today`);
    // Make sure we end up on home page
    if (!window.location.pathname.startsWith('/direct/') && window.location.pathname !== '/') {
      goHome();
    }
  }

  // ═══ TEST SEND ═══

  async function testSend(rawUsername, message) {
    const u = strip(rawUsername);
    await chrome.storage.local.set({ lastCheckResult: [] });
    await log('test', 'ok', `test send to @${u}`);
    const job = {
      queue: [{ username: u, message }], index: 0, phase: 'go_to_profile',
      today: 0, total: 0, cap: 99, started: Date.now(), fails: 0, isTest: true
    };
    await chrome.storage.local.set({ dmJob: job });
    window.location.href = `https://www.instagram.com/${u}/`;
  }

  // ═══ SIMULATE ═══

  async function simulateAutoFlow() {
    await chrome.storage.local.set({ lastCheckResult: [] });
    await log('sim', 'ok', 'simulating auto flow');
    const data = await chrome.storage.local.get(null);
    if (!data.messages?.length) { await log('sim', 'fail', 'no messages set'); return; }
    const uid = await getUserId();
    if (!uid) { await log('sim', 'fail', 'not logged in'); return; }
    const followers = await fetchNewFollowerUsernames(uid);
    const seen = new Set(data.seenFollowers || []);
    const candidate = followers.find(u => seen.has(u));
    if (!candidate) { await log('sim', 'fail', 'no seen follower to test with'); return; }
    const without = (data.seenFollowers || []).filter(u => u !== candidate);
    await chrome.storage.local.set({ seenFollowers: Array.from(new Set(without)), enabled: true, sentToday: 0, simulateTarget: candidate });
    await log('sim', 'ok', `testing @${candidate}`);
    await runCheck();
  }

  // ═══ RUN CHECK — fully automatic, triggered by alarm ═══

  async function runCheck() {
    isRunning = true;
    try {
      await log('check', 'ok', 'auto check started');
      const data = await chrome.storage.local.get(null);

      if (!data.enabled) { await log('check', 'skip', 'off'); return; }
      if (!data.messages?.length) { await log('check', 'skip', 'no messages'); return; }
      if (data.blockedUntil && Date.now() < data.blockedUntil) { await log('check', 'skip', 'paused'); return; }
      if (data.dmJob?.phase && data.dmJob.phase !== 'idle') {
        if (Date.now() - (data.dmJob.started || 0) > JOB_STALE_MS) await chrome.storage.local.set({ dmJob: { phase: 'idle' } });
        else { await log('check', 'skip', 'job running'); return; }
      }

      const today = new Date().toISOString().slice(0, 10);
      if (data.lastResetDate !== today) { await chrome.storage.local.set({ sentToday: 0, lastResetDate: today }); data.sentToday = 0; }
      const cap = Math.min(data.dailyCap || 15, ABS_MAX_DAILY);
      if ((data.sentToday || 0) >= cap) { await log('check', 'skip', `limit (${data.sentToday}/${cap})`); return; }

      const uid = await getUserId();
      if (!uid) { await log('check', 'fail', 'not logged in'); return; }

      const allFollowers = await fetchNewFollowerUsernames(uid);
      if (!allFollowers.length) { await log('check', 'fail', 'no followers found'); return; }

      if (!data.hasCompletedFirstRun) {
        await chrome.storage.local.set({ seenFollowers: Array.from(new Set(allFollowers)), hasCompletedFirstRun: true });
        await log('check', 'ok', `first run: ${allFollowers.length} marked seen`);
        return;
      }

      const seen = new Set(data.seenFollowers || []);
      let fresh = allFollowers.filter(u => !seen.has(u));

      if (!fresh.length) {
        await log('check', 'ok', `no new (${seen.size} seen)`);
        return;
      }

      // Filter out anyone we already have a DM thread with
      const filtered = [];
      for (const u of fresh) {
        if (await alreadyMessaged(u)) {
          await markSeen(u); // mark seen so we don't check again
        } else {
          filtered.push(u);
        }
        if (filtered.length >= MAX_BATCH) break;
      }

      if (!filtered.length) {
        await log('check', 'ok', 'new followers exist but all already messaged');
        return;
      }

      await log('check', 'ok', `${filtered.length} NEW to DM: [${filtered.join(', ')}]`);
      const batch = filtered.slice(0, Math.min(filtered.length, cap - (data.sentToday || 0)));
      await startBatch(batch, data);

    } catch (e) { await log('check', 'fail', `error: ${e.message}`); }
    finally { isRunning = false; }
  }

  // ═══ DIAGNOSE ═══

  async function runDiagnose() {
    const res = { status: 'running', steps: [], htmlDump: '' };
    async function step(t, s) { res.steps.push({ text: t, status: s, ts: Date.now() }); await chrome.storage.local.set({ autoDiagnoseResult: { ...res } }); }

    await step('checking login...', 'running');
    const uid = await getUserId();
    if (!uid) { await step('not logged in', 'fail'); res.status = 'done'; await chrome.storage.local.set({ autoDiagnoseResult: res }); return; }
    await step(`logged in: ${uid}`, 'ok');

    await step('fetching followers...', 'running');
    const followers = await fetchNewFollowerUsernames(uid);
    await step(`${followers.length} found`, followers.length ? 'ok' : 'fail');

    const data = await chrome.storage.local.get(null);
    const seen = new Set(data.seenFollowers || []);
    const fresh = followers.filter(u => !seen.has(u));
    await step(`${seen.size} seen, ${fresh.length} new`, 'ok');
    if (fresh.length) await step(`new: ${fresh.slice(0, 5).join(', ')}`, 'ok');

    await step(`enabled: ${data.enabled}, msgs: ${(data.messages || []).length}, cap: ${data.dailyCap}, today: ${data.sentToday}, blocked: ${data.blockedUntil ? 'yes' : 'no'}, job: ${data.dmJob?.phase || 'idle'}`, 'ok');

    res.status = 'done';
    await chrome.storage.local.set({ autoDiagnoseResult: res });
  }

  // ═══ ON PAGE LOAD — resume job or just chill ═══

  setTimeout(async () => {
    const { dmJob: job } = await chrome.storage.local.get('dmJob');
    if (job && job.phase !== 'idle') {
      await resumeJob();
    }
  }, 2500);

})();
