// HeyBack v3 — simplified engine
// Detection: notifications API + followers API
// Send: navigate to profile → click Message → type → send
// No search dropdown. No strategy A-G. Just profile → message → done.

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

  // ═══ MESSAGE LISTENER ═══

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.type === 'RUN_CHECK') { if (isRunning) respond({ ok: false }); else { runCheck(); respond({ ok: true }); } }
    else if (msg.type === 'TEST_SEND') { testSend(msg.username, msg.message); respond({ ok: true }); }
    else if (msg.type === 'VERIFY_LAST_SEND') { doVerify().then(r => chrome.storage.local.set({ lastVerifyResult: r })); respond({ ok: true }); }
    else if (msg.type === 'FORCE_RESET_JOB') { chrome.storage.local.set({ dmJob: { phase: 'idle' } }).then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'RESET_TODAY') { chrome.storage.local.set({ sentToday: 0 }).then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'RESET_ALL') { chrome.storage.local.clear().then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'AUTO_DIAGNOSE') { runDiagnose(); respond({ ok: true }); }
    else if (msg.type === 'SIMULATE_AUTO_FLOW') { simulateAutoFlow(); respond({ ok: true }); }
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
    const arr = Array.from(s);
    await chrome.storage.local.set({ seenFollowers: arr });
    await log('mark_seen', 'ok', `@${username} marked seen (${before} -> ${arr.length})`);
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

  // ═══ COMPOSER TYPING — execCommand only, no manual events ═══

  async function typeInComposer(el, message) {
    el.focus(); await sleep(50);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(100);
    document.execCommand('insertText', false, message);
    const actual = el.textContent;
    if (actual.length > message.length + 2) {
      el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
      throw new Error('DUPLICATE: composer text too long');
    }
    await sleep(300);
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

  // ═══ FETCH NEW FOLLOWERS — two sources merged ═══

  async function fetchNewFollowerUsernames(userId) {
    const all = new Set();

    // Source 1: notifications/activity feed
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
        await log('fetch', 'ok', `notifications: ${all.size} recent follows`);
      }
    } catch (e) { await log('fetch', 'fail', `notifications: ${e.message}`); }

    // Source 2: followers API (first page only for speed)
    try {
      const r = await fetch(`/api/v1/friendships/${userId}/followers/?count=50&search_surface=follow_list_page&_t=${Date.now()}`, {
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': getCookie('csrftoken') || '' },
        credentials: 'include'
      });
      if (r.ok) {
        const j = await r.json();
        for (const u of (j.users || [])) all.add(u.username);
        await log('fetch', 'ok', `API: ${(j.users || []).length} followers (page 1)`);
      }
    } catch (e) { await log('fetch', 'fail', `API: ${e.message}`); }

    await log('fetch', 'ok', `total unique: ${all.size}`);
    return Array.from(all);
  }

  // ═══════════════════════════════════════════════════════════════
  // SEND DM VIA PROFILE PAGE
  // The simple approach: go to instagram.com/{username}, click the
  // "Message" button, wait for composer, type message, click send.
  // No search dropdown. No strategies. Just click Message on profile.
  // ═══════════════════════════════════════════════════════════════

  async function sendDMviaProfile(username, message) {
    const clean = strip(username);
    await log('send', 'ok', `sending to @${clean}`);

    // Step 1: navigate to their profile
    await log('send', 'ok', 'opening profile...');
    window.location.href = `https://www.instagram.com/${clean}/`;

    // We need to wait for page load. The content script will be re-injected.
    // Save state so resumeJob picks it up.
    return 'navigating';
  }

  async function executeOnProfile(username, message) {
    await log('send', 'ok', `on profile page for @${username}`);

    if (!await forceFocus()) {
      await log('send', 'fail', 'tab not focused');
      return { sent: false, started: false };
    }

    // Wait for profile to load
    await sleep(2000);

    if (checkBlock()) return { sent: false, started: false, blocked: true };

    // Step 2: find and click the "Message" button on profile
    await log('send', 'ok', 'looking for Message button...');
    const msgBtn = await waitFor(() => {
      // Look for a button/link with text "Message"
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const txt = el.textContent.trim();
        if (/^message$/i.test(txt) && el.offsetParent) return el;
      }
      // Fallback: aria-label
      const ariaBtn = document.querySelector('[aria-label="Message" i], [aria-label="Send message" i]');
      if (ariaBtn && ariaBtn.offsetParent) return ariaBtn;
      return null;
    }, 8000);

    if (!msgBtn) {
      await log('send', 'fail', 'Message button not found on profile');
      // Maybe this user has messaging restricted or profile is private
      return { sent: false, started: false };
    }

    await log('send', 'ok', 'clicking Message button');
    click(msgBtn);
    await sleep(3000);

    if (checkBlock()) return { sent: false, started: true, blocked: true };

    // Step 3: we should now be in a DM thread. Find the composer.
    await log('send', 'ok', 'looking for message composer...');
    const composer = await waitFor(() => {
      return document.querySelector('[role="textbox"][contenteditable="true"]')
        || document.querySelector('[aria-label*="essage" i][contenteditable="true"]')
        || document.querySelector('form [contenteditable="true"]');
    }, 10000);

    if (!composer) {
      await log('send', 'fail', 'composer not found after clicking Message');
      return { sent: false, started: true };
    }

    await log('send', 'ok', 'composer found, typing message...');

    // Step 4: type the message
    try { await typeInComposer(composer, message); }
    catch (e) { await log('send', 'fail', e.message); return { sent: false, started: true }; }

    await log('send', 'ok', `typed: "${message.slice(0, 40)}"`);

    // Step 5: find and click Send
    const sendBtn = await waitFor(() => {
      const byAria = document.querySelector('[role="button"][aria-label="Send" i], button[aria-label="Send" i]');
      if (byAria && byAria.offsetParent) return byAria;
      for (const b of document.querySelectorAll('button, [role="button"]'))
        if (b.textContent.trim().toLowerCase() === 'send' && b.offsetParent) return b;
      return null;
    }, 5000);

    if (sendBtn) {
      click(sendBtn);
      await log('send', 'ok', 'clicked send');
    } else {
      // Fallback: press Enter
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      await log('send', 'ok', 'pressed Enter (no send button found)');
    }

    await sleep(2500);

    if (checkBlock()) return { sent: false, started: true, blocked: true };

    // Step 6: verify — check if our message appears on the page
    await sleep(1500);
    const pageText = document.body.innerText;
    const verified = pageText.includes(message);
    const threadUrl = window.location.href;

    // Check for duplicate in bubble
    const spans = document.querySelectorAll('span');
    for (let i = spans.length - 1; i >= Math.max(0, spans.length - 10); i--) {
      if ((spans[i]?.textContent || '').includes(message + message)) {
        await log('send', 'fail', 'DUPLICATE detected in sent bubble');
        return { sent: true, verified: false, threadUrl };
      }
    }

    await log('send', verified ? 'ok' : 'fail', verified ? `verified: message delivered to @${strip(username)}` : 'sent but could not verify on page');
    return { sent: true, verified, threadUrl };
  }

  // ═══ VERIFY LAST SEND ═══

  async function doVerify() {
    const d = await chrome.storage.local.get('sentLog');
    const sentLog = d.sentLog || [];
    if (!sentLog.length) return { ok: false, detail: 'No sends recorded' };
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
            if (!items.length) return { ok: false, detail: `Thread with @${last.username} is empty`, username: last.username };
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

  // ═══ DM JOB STATE MACHINE ═══
  // Phases:
  //   idle → nothing
  //   go_to_profile → need to navigate to instagram.com/{username}
  //   on_profile → page loaded, execute the send
  //   waiting → delay between sends

  async function startBatch(usernames, data) {
    const job = {
      queue: usernames.map(u => ({ username: strip(u), message: pickMsg(data.messages) })),
      index: 0,
      phase: 'go_to_profile',
      today: data.sentToday || 0,
      total: data.sentTotalCount || 0,
      cap: Math.min(data.dailyCap || 15, ABS_MAX_DAILY),
      started: Date.now(),
      fails: 0
    };
    await chrome.storage.local.set({ dmJob: job, lastCheckResult: [] });
    await log('batch', 'ok', `${job.queue.length} to send: [${usernames.join(', ')}]`);

    // Navigate to first profile
    const first = job.queue[0].username;
    window.location.href = `https://www.instagram.com/${first}/`;
  }

  async function resumeJob() {
    const { dmJob: job } = await chrome.storage.local.get('dmJob');
    if (!job || job.phase === 'idle') return;

    // Stale check
    if (Date.now() - job.started > JOB_STALE_MS) {
      job.phase = 'idle';
      await chrome.storage.local.set({ dmJob: job });
      await log('job', 'fail', 'job timed out');
      return;
    }

    if (job.phase === 'go_to_profile') {
      const target = job.queue[job.index];
      if (!target) { await finishJob(job); return; }
      // Check if we're on the right profile page
      const path = window.location.pathname.replace(/\/$/, '').toLowerCase();
      const expected = `/${target.username.toLowerCase()}`;
      if (path === expected || path.startsWith(expected + '/')) {
        // We're on the profile page, execute
        job.phase = 'on_profile';
        await chrome.storage.local.set({ dmJob: job });
        await execOnCurrentProfile(job);
      } else {
        // Navigate to the profile
        window.location.href = `https://www.instagram.com/${target.username}/`;
      }
      return;
    }

    if (job.phase === 'on_profile') {
      await execOnCurrentProfile(job);
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
      // Delay expired
      job.phase = 'go_to_profile';
      await chrome.storage.local.set({ dmJob: job });
      const next = job.queue[job.index];
      if (next) window.location.href = `https://www.instagram.com/${next.username}/`;
      else await finishJob(job);
      return;
    }
  }

  async function execOnCurrentProfile(job) {
    if (job.index >= job.queue.length || job.today >= job.cap) { await finishJob(job); return; }
    if (checkBlock()) {
      await chrome.storage.local.set({ blockedUntil: Date.now() + 86400000 });
      await log('job', 'fail', 'Instagram rate limit detected');
      await finishJob(job);
      return;
    }

    const { username, message } = job.queue[job.index];
    await log('sending', 'ok', `DM @${username} (${job.index + 1}/${job.queue.length})`);

    const result = await executeOnProfile(username, message);

    if (result.blocked) {
      await markSeen(username);
      await chrome.storage.local.set({ blockedUntil: Date.now() + 86400000 });
      await log('result', 'fail', `@${username}: rate limited`);
      await finishJob(job);
      return;
    }

    if (result.sent) {
      await markSeen(username);
      job.today++;
      job.total++;
      job.fails = 0;
      const cur = await chrome.storage.local.get('sentLog');
      const sentLog = cur.sentLog || [];
      sentLog.push({ username, message, ts: Date.now(), verified: result.verified, threadUrl: result.threadUrl || '', markedSeen: true });
      if (sentLog.length > 100) sentLog.splice(0, sentLog.length - 100);
      await chrome.storage.local.set({ sentLog, sentToday: job.today, sentTotalCount: job.total });
      await log('result', 'ok', `@${username}: ${result.verified ? 'DELIVERED' : 'sent'}`);
    } else {
      if (result.started) await markSeen(username);
      job.fails++;
      await log('result', 'fail', `@${username}: send failed`);
      if (job.fails >= 3) {
        await log('job', 'fail', '3 consecutive failures, stopping');
        await finishJob(job);
        return;
      }
    }

    job.index++;
    if (job.index < job.queue.length && job.today < job.cap) {
      const delay = MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
      job.waitUntil = Date.now() + delay;
      job.phase = 'waiting';
      await chrome.storage.local.set({ dmJob: job });
      await log('job', 'ok', `waiting ${Math.round(delay / 1000)}s before next...`);
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
    await log('done', 'ok', `batch complete: ${job.today} sent today`);
  }

  // ═══ TEST SEND ═══

  async function testSend(rawUsername, message) {
    const u = strip(rawUsername);
    await chrome.storage.local.set({ lastCheckResult: [] });
    await log('test', 'ok', `test send to @${u}`);
    const data = await chrome.storage.local.get(null);
    const job = {
      queue: [{ username: u, message }],
      index: 0,
      phase: 'go_to_profile',
      today: 0, total: 0, cap: 99,
      started: Date.now(), fails: 0, isTest: true
    };
    await chrome.storage.local.set({ dmJob: job });
    window.location.href = `https://www.instagram.com/${u}/`;
  }

  // ═══ SIMULATE AUTO FLOW ═══

  async function simulateAutoFlow() {
    await chrome.storage.local.set({ lastCheckResult: [] });
    await log('simulate', 'ok', 'starting simulation');
    const data = await chrome.storage.local.get(null);
    if (!data.messages?.length) { await log('simulate', 'fail', 'no messages set'); return; }
    const uid = await getUserId();
    if (!uid) { await log('simulate', 'fail', 'not logged in'); return; }

    const allFollowers = await fetchNewFollowerUsernames(uid);
    const seen = new Set(data.seenFollowers || []);
    const candidate = allFollowers.find(u => seen.has(u));
    if (!candidate) { await log('simulate', 'fail', 'no seen follower to test with'); return; }

    await log('simulate', 'ok', `testing with @${candidate}`);
    const without = (data.seenFollowers || []).filter(u => u !== candidate);
    await chrome.storage.local.set({ seenFollowers: Array.from(new Set(without)), enabled: true, sentToday: 0, simulateTarget: candidate });
    await runCheck();
  }

  // ═══ RUN CHECK — the main loop ═══

  async function runCheck() {
    isRunning = true;
    try {
      await log('check', 'ok', 'checking for new followers...');
      const data = await chrome.storage.local.get(null);

      if (!data.enabled) { await log('check', 'skip', 'HeyBack is off'); return; }
      if (!data.messages?.length) { await log('check', 'skip', 'no messages set'); return; }
      if (data.blockedUntil && Date.now() < data.blockedUntil) { await log('check', 'skip', 'paused (rate limit)'); return; }
      if (data.dmJob?.phase && data.dmJob.phase !== 'idle') {
        if (Date.now() - (data.dmJob.started || 0) > JOB_STALE_MS) {
          await chrome.storage.local.set({ dmJob: { phase: 'idle' } });
        } else { await log('check', 'skip', 'send in progress'); return; }
      }

      const today = new Date().toISOString().slice(0, 10);
      if (data.lastResetDate !== today) { await chrome.storage.local.set({ sentToday: 0, lastResetDate: today }); data.sentToday = 0; }
      const cap = Math.min(data.dailyCap || 15, ABS_MAX_DAILY);
      if ((data.sentToday || 0) >= cap) { await log('check', 'skip', `daily limit (${data.sentToday}/${cap})`); return; }

      const uid = await getUserId();
      if (!uid) { await log('check', 'fail', 'not logged in'); return; }

      const allFollowers = await fetchNewFollowerUsernames(uid);
      if (!allFollowers.length) { await log('check', 'fail', 'could not fetch followers'); return; }

      // First run: mark everyone as seen
      if (!data.hasCompletedFirstRun) {
        const all = Array.from(new Set(allFollowers));
        await chrome.storage.local.set({ seenFollowers: all, hasCompletedFirstRun: true });
        await log('check', 'ok', `first run: marked ${all.length} as seen`);
        return;
      }

      // Find new followers
      const seen = new Set(data.seenFollowers || []);
      const fresh = allFollowers.filter(u => !seen.has(u));

      if (!fresh.length) {
        await log('check', 'ok', `no new followers (${seen.size} seen, ${allFollowers.length} total)`);
        return;
      }

      await log('check', 'ok', `${fresh.length} NEW: [${fresh.join(', ')}]`);

      const batch = fresh.slice(0, Math.min(fresh.length, MAX_BATCH, cap - (data.sentToday || 0)));
      await startBatch(batch, data);

    } catch (e) {
      await log('check', 'fail', `error: ${e.message}`);
    } finally {
      isRunning = false;
    }
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
    await step(`${followers.length} followers found`, followers.length ? 'ok' : 'fail');

    const data = await chrome.storage.local.get(null);
    const seen = new Set(data.seenFollowers || []);
    const fresh = followers.filter(u => !seen.has(u));
    await step(`${seen.size} seen, ${fresh.length} new`, 'ok');
    if (fresh.length) await step(`new: ${fresh.slice(0, 5).join(', ')}`, 'ok');

    await step(`enabled: ${data.enabled}, msgs: ${(data.messages || []).length}, cap: ${data.dailyCap}, today: ${data.sentToday}, blocked: ${data.blockedUntil ? 'yes' : 'no'}, job: ${data.dmJob?.phase || 'idle'}`, 'ok');

    res.status = 'done';
    await chrome.storage.local.set({ autoDiagnoseResult: res });
  }

  // ═══ ON PAGE LOAD — resume any pending job ═══

  setTimeout(async () => {
    const { dmJob: job } = await chrome.storage.local.get('dmJob');
    if (job && job.phase !== 'idle') {
      await resumeJob();
    }
  }, 2500);

})();
