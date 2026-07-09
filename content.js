(() => {
  const IG_APP_ID = '936619743392459';
  const MAX_BATCH = 2;
  const MIN_DELAY = 45000;
  const MAX_DELAY = 90000;
  const BLOCK_RE = /action blocked|try again|challenge|verify your|we limit|temporarily blocked/i;
  const JOB_STALE_MS = 5 * 60 * 1000;
  const ABS_MAX_DAILY = 30; // C3: absolute ceiling
  let isRunning = false;
  let lastMsgIdx = -1;
  let consecutiveSearchFails = 0; // C5: track selector failures

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.type === 'RUN_CHECK') { if (isRunning) respond({ ok: false, reason: 'running' }); else { runCheck(); respond({ ok: true }); } }
    else if (msg.type === 'VERIFY_LAST_SEND') { doVerify().then(r => chrome.storage.local.set({ lastVerifyResult: r })); respond({ ok: true }); }
    else if (msg.type === 'TEST_SEND') { testSendToSelf(msg.username, msg.message); respond({ ok: true }); }
    else if (msg.type === 'FORCE_RESET_JOB') { chrome.storage.local.set({ dmJob: { phase: 'idle' } }).then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'RESET_TODAY') { chrome.storage.local.set({ sentToday: 0 }).then(() => respond({ ok: true })); return true; }
    else if (msg.type === 'AUTO_DIAGNOSE') { runAutoDiagnose(); respond({ ok: true }); }
    else if (msg.type === 'MANUAL_TEST_TYPING') { runManualTestTyping(); respond({ ok: true }); }
    else if (msg.type === 'SIMULATE_AUTO_FLOW') { simulateAutoFlow(); respond({ ok: true }); }
    else if (msg.type === 'RESET_ALL') { chrome.storage.local.clear().then(() => respond({ ok: true })); return true; }
    return true;
  });

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function getCookie(n) { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]+)')); return m ? m[1] : null; }
  function strip(u) { return (u || '').replace(/^@+/, ''); }
  function checkBlock() { for (const d of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) if (BLOCK_RE.test(d.innerText)) return true; return false; }
  function pickMsg(msgs) { if (msgs.length <= 1) return msgs[0] || ''; let i, t = 0; do { i = Math.floor(Math.random() * msgs.length); t++; } while (i === lastMsgIdx && t < 10); lastMsgIdx = i; return msgs[i]; }
  function dumpHTML() { return (document.querySelector('[role="dialog"]') || document.body).innerHTML.replace(/\n/g, ' ').slice(0, 5000); }
  function friendlyError(e) {
    if (e.includes('not found')) return `Couldn't find this user on Instagram search`;
    if (e.includes('action blocked') || e.includes('blocked')) return 'Instagram is asking us to slow down. Paused for 24 hours.';
    if (e.includes('tab not focused')) return 'Please keep the Instagram tab open in Chrome for HeyBack to work';
    if (e.includes('composer not found')) return 'Instagram changed their message layout. Check for updates.';
    return e;
  }

  async function log(stage, status, detail) {
    const d = await chrome.storage.local.get('lastCheckResult');
    const a = d.lastCheckResult || [];
    a.push({ stage, status, detail, ts: Date.now() });
    await chrome.storage.local.set({ lastCheckResult: a });
  }

  // A1/A2/A4: MARK SEEN — reads current storage, adds via Set, writes back, logs count
  async function markSeen(username) {
    const d = await chrome.storage.local.get('seenFollowers');
    const arr = d.seenFollowers || [];
    const s = new Set(arr);
    const before = s.size;
    s.add(username);
    const deduped = Array.from(s);
    await chrome.storage.local.set({ seenFollowers: deduped });
    await log('mark_seen', 'ok', `MARKED SEEN: @${username}, seen count: ${before} -> ${deduped.length}`);
  }

  async function forceFocus() {
    window.focus(); document.body.click(); await sleep(300);
    if (!document.hasFocus()) { await log('dom_step', 'fail', friendlyError('tab not focused')); return false; }
    return true;
  }

  // Search input typing (for <input> elements)
  async function typeIntoReactInput(inputEl, text) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    inputEl.focus(); inputEl.click();
    inputEl.dispatchEvent(new Event('focus', { bubbles: true }));
    inputEl.dispatchEvent(new Event('focusin', { bubbles: true }));
    await sleep(150);
    nativeSetter.call(inputEl, '');
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
    for (const char of text) {
      nativeSetter.call(inputEl, inputEl.value + char);
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(60 + Math.random() * 40);
    }
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    return inputEl.value === text;
  }

  // Composer typing — execCommand ONLY, zero manual events
  async function typeInComposer(el, message) {
    el.focus(); await sleep(50);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await sleep(100);
    document.execCommand('insertText', false, message);
    const actual = el.textContent;
    await log('dom_step', 'ok', `composer: "${actual.slice(0,60)}" (${actual.length}/${message.length} chars)`);
    if (actual.length > message.length + 2) {
      el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
      throw new Error(`DUPLICATE BUG: ${actual.length} chars in composer, expected ${message.length}`);
    }
    await sleep(300);
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

  async function waitFor(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const r = fn(); if (r) return r; await sleep(300); } return null; }

  function findSearchInput() {
    for (const sel of ['input[placeholder*="earch" i]','input[aria-label*="earch" i]','input[name="queryBox"]','[role="dialog"] input[type="text"]']) { const el = document.querySelector(sel); if (el) return el; }
    for (const el of document.querySelectorAll('input[type="text"],input:not([type])')) if (el.offsetParent && el.getBoundingClientRect().width > 50) return el;
    return null;
  }

  // Dropdown detection (proven working)
  function makeTextMatcher(u) { const c = u.toLowerCase(), n = c.replace(/[._]/g, ''); return el => { const t = el.textContent.toLowerCase(); return t.includes(c) || t.replace(/[._]/g, '').includes(n); }; }
  function stratA(tm) { const d = document.querySelector('[role="dialog"]'); if (!d) return null; for (const el of d.querySelectorAll('[role="button"],button,[role="option"],[role="checkbox"],label,div[tabindex]')) if (tm(el) && el.offsetParent) return el; return null; }
  function stratB(tm) { for (const el of document.querySelectorAll('[role="button"],button,[role="option"],[role="checkbox"],label,div[tabindex]')) if (tm(el) && el.offsetParent) return el; return null; }
  function stratC(tm) { for (const img of document.querySelectorAll('img')) { let c = img.parentElement; for (let i = 0; i < 6 && c; i++) { if (tm(c) && c.offsetParent) { const r = c.getBoundingClientRect(); if (r.height > 30 && r.height < 200 && r.width > 80) return c; } c = c.parentElement; } } return null; }
  function stratD(tm, u) { const root = document.querySelector('[role="dialog"]') || document.body; const cl = u.toLowerCase(); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent.toLowerCase().includes(cl) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }); let nd; while (nd = w.nextNode()) { if (nd.parentElement?.closest('input')) continue; let el = nd.parentElement; for (let i = 0; i < 10 && el; i++) { const role = el.getAttribute?.('role'), tag = el.tagName?.toLowerCase(), ti = el.getAttribute?.('tabindex'); if (tag === 'button' || role === 'button' || role === 'option' || role === 'checkbox' || ti !== null) { if (el.offsetParent) return el; } if ((tag === 'div' || tag === 'label' || tag === 'span') && el.offsetParent) { try { if (window.getComputedStyle(el).cursor === 'pointer') return el; } catch (_) {} } el = el.parentElement; } } return null; }
  function stratG() { return new Promise(resolve => { const dlg = document.querySelector('[role="dialog"]') || document.body; const timer = setTimeout(() => { obs.disconnect(); resolve(null); }, 6000); const obs = new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; const all = n.querySelectorAll ? [n, ...n.querySelectorAll('*')] : [n]; for (const el of all) { const txt = el.textContent?.trim(); if (txt && txt.length > 3 && el.offsetParent) { const hit = el.closest('[role="button"],button,[role="option"],[role="checkbox"],label,div[tabindex]'); if (hit && hit.offsetParent) { clearTimeout(timer); obs.disconnect(); resolve(hit); return; } let p = el; for (let i = 0; i < 8 && p; i++) { if (p.offsetParent) { try { if (window.getComputedStyle(p).cursor === 'pointer') { clearTimeout(timer); obs.disconnect(); resolve(p); return; } } catch (_) {} } p = p.parentElement; } } } } }); obs.observe(dlg, { childList: true, subtree: true }); }); }
  function fallbackFirstProfile() { const d = document.querySelector('[role="dialog"]'); if (!d) return null; for (const img of d.querySelectorAll('img')) { let c = img.parentElement; for (let i = 0; i < 5 && c; i++) { const r = c.getBoundingClientRect(); if (r.height > 35 && r.height < 120 && r.width > 100 && c.offsetParent) return c; c = c.parentElement; } } return null; }
  async function findUserResult(username) { const tm = makeTextMatcher(username); for (const [n, fn] of [['A', () => stratA(tm)], ['B', () => stratB(tm)], ['C', () => stratC(tm)], ['D', () => stratD(tm, username)]]) { const el = fn(); if (el) return { el, strategy: n }; } const gEl = await stratG(); if (gEl) return { el: gEl, strategy: 'G' }; return { el: null, strategy: null }; }

  // User ID / Fetch followers
  async function getUserId() {
    const c = getCookie('ds_user_id'); if (c) { await log('user_id_fetched', 'ok', `cookie: ${c}`); return c; }
    const u = getCookie('ds_user');
    if (u) { try { const r = await fetch(`/api/v1/users/web_profile_info/?username=${u}`, { headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' }); if (r.ok) { const j = await r.json(); const id = j.data?.user?.id || j.data?.user?.pk; if (id) { await log('user_id_fetched', 'ok', `api: ${id}`); return String(id); } } } catch (_) {} }
    try { const r = await fetch('/api/v1/accounts/current_user/', { headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest' }, credentials: 'include' }); if (r.ok) { const j = await r.json(); const id = j.user?.pk || j.user?.id; if (id) { await log('user_id_fetched', 'ok', `cur: ${id}`); return String(id); } } } catch (_) {}
    await log('user_id_fetched', 'fail', 'Not logged into Instagram'); return null;
  }

  // Method 1: followers API
  async function fetchFollowersAPI(userId) {
    const csrf = getCookie('csrftoken') || ''; const all = []; let maxId = null, pages = 0;
    for (let p = 0; p < 10; p++) {
      let url = `/api/v1/friendships/${userId}/followers/?count=100&search_surface=follow_list_page&_t=${Date.now()}`; if (maxId) url += `&max_id=${maxId}`;
      try { const r = await fetch(url, { headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': csrf }, credentials: 'include' });
        if (!r.ok) { await log('followers_fetched', 'fail', `API page ${p}: HTTP ${r.status}`); break; }
        const j = await r.json(); for (const u of (j.users||[])) all.push({ username: u.username, id: String(u.pk||u.pk_id||u.id) });
        pages = p + 1; if (!j.next_max_id || !(j.users||[]).length) break; maxId = j.next_max_id;
      } catch (e) { await log('followers_fetched', 'fail', `API page ${p}: ${e.message}`); break; }
      if (p < 9) await sleep(1500);
    }
    return all;
  }

  // Method 2: notifications/activity feed — catches new followers even when API is stale
  async function fetchNewFollowersFromActivity() {
    const newFollowers = [];
    try {
      const r = await fetch('/api/v1/news/inbox/?_t=' + Date.now(), {
        headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': getCookie('csrftoken') || '' },
        credentials: 'include'
      });
      if (!r.ok) { await log('activity_fetch', 'fail', `HTTP ${r.status}`); return []; }
      const j = await r.json();
      const stories = j.old_stories || j.new_stories || [];
      const allStories = [...(j.new_stories || []), ...(j.old_stories || [])];
      for (const s of allStories) {
        // story_type 101 = follow, also check args.text for "started following you"
        if (s.story_type === 101 || (s.args?.text || '').includes('started following')) {
          const u = s.args?.profile_id ? { username: s.args.profile_name || '', id: String(s.args.profile_id) } : null;
          if (u && u.username) newFollowers.push(u);
          // also check inline_follow_button users
          if (s.args?.inline_follow?.user_info) {
            const ui = s.args.inline_follow.user_info;
            newFollowers.push({ username: ui.username, id: String(ui.id || ui.pk) });
          }
        }
      }
      if (newFollowers.length) await log('activity_fetch', 'ok', `${newFollowers.length} recent follows from notifications`);
    } catch (e) { await log('activity_fetch', 'fail', e.message); }
    return newFollowers;
  }

  // Combined: merge both sources, dedup by username
  async function fetchFollowers(userId) {
    const [apiFollowers, activityFollowers] = await Promise.all([
      fetchFollowersAPI(userId),
      fetchNewFollowersFromActivity()
    ]);
    // Merge: activity followers first (most recent), then API followers
    const seen = new Set();
    const merged = [];
    for (const f of [...activityFollowers, ...apiFollowers]) {
      if (!seen.has(f.username)) { seen.add(f.username); merged.push(f); }
    }
    await log('followers_fetched', merged.length ? 'ok' : 'fail', `${merged.length} total (${apiFollowers.length} API + ${activityFollowers.length} notifications)`);
    return merged;
  }

  // THE ONE shared send function
  async function executeSendToUser(username, message) {
    const clean = strip(username);
    await log('dm_step', 'ok', `Sending to @${clean}...`);
    const focused = await forceFocus();
    if (!focused) return { sent: false, verified: false, error: 'tab not focused', started: false };

    const searchEl = await waitFor(findSearchInput, 15000);
    if (!searchEl) { await log('dom_step', 'fail', 'Search input not found'); return { sent: false, verified: false, error: 'search input not found', started: false }; }
    await log('dom_step', 'ok', 'Typing username...');
    await typeIntoReactInput(searchEl, clean);
    await sleep(3500);

    await log('dom_step', 'ok', 'Waiting for dropdown...');
    let { el: clickTarget, strategy } = await findUserResult(clean);
    if (!clickTarget) {
      searchEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      await sleep(2000);
      if (window.location.pathname.includes('/direct/t/')) {
        await log('dom_step', 'ok', 'Opened thread directly');
        consecutiveSearchFails = 0;
        return await composerAndSend(message);
      }
      ({ el: clickTarget, strategy } = await findUserResult(clean));
      if (!clickTarget) clickTarget = fallbackFirstProfile();
      if (!clickTarget) {
        consecutiveSearchFails++;
        // C5: if selectors fail 5 times in a row, auto-pause 12h
        if (consecutiveSearchFails >= 5) {
          await chrome.storage.local.set({ blockedUntil: Date.now() + 12 * 3600000 });
          await log('dom_step', 'fail', 'Instagram may have updated their site. HeyBack paused 12h. Check for updates.');
        } else {
          await log('dom_step', 'fail', friendlyError(`@${clean} not found`));
        }
        return { sent: false, verified: false, error: `Couldn't find @${clean} on Instagram search`, started: true };
      }
    }
    consecutiveSearchFails = 0;
    await log('dropdown_strategy_used', 'ok', `Found via strategy ${strategy || 'fallback'}`);
    click(clickTarget); await sleep(800);

    const chatEl = await waitFor(() => { for (const b of document.querySelectorAll('button,[role="button"],div[role="button"]')) if (/^(chat|next|send message)$/i.test(b.textContent.trim()) && b.offsetParent) return b; return null; }, 4000);
    if (chatEl) { await log('dom_step', 'ok', `Clicking "${chatEl.textContent.trim()}"`); click(chatEl); }
    else if (window.location.pathname.includes('/direct/t/')) { await log('dom_step', 'ok', 'Thread opened'); }
    else { click(clickTarget); }
    await sleep(2500);
    if (checkBlock()) return { sent: false, verified: false, blocked: true, error: friendlyError('action blocked'), started: true };

    return await composerAndSend(message);
  }

  async function composerAndSend(message) {
    const compFns = [() => document.querySelector('[role="textbox"][contenteditable="true"]'), () => document.querySelector('[aria-label*="essage" i][contenteditable="true"]'), () => document.querySelector('form [contenteditable="true"]'), () => { for (const e of document.querySelectorAll('[contenteditable="true"]')) if (e.offsetParent && e.getBoundingClientRect().height > 15) return e; return null; }];
    const compEl = await waitFor(() => { for (const fn of compFns) { const r = fn(); if (r) return r; } return null; }, 10000);
    if (!compEl) { await log('dom_step', 'fail', friendlyError('composer not found')); return { sent: false, verified: false, error: 'composer not found', started: true }; }
    await log('dom_step', 'ok', 'Composer found');

    const existing = compEl.textContent;
    if (existing.length > 0) await log('dom_step', 'skip', `Cleared draft: "${existing.slice(0,40)}"`);

    try { await typeInComposer(compEl, message); }
    catch (e) { await log('dom_step', 'fail', e.message); return { sent: false, verified: false, error: e.message, started: true }; }

    const sendFns = [() => document.querySelector('[role="button"][aria-label="Send" i],button[aria-label="Send" i]'), () => { for (const b of document.querySelectorAll('button,[role="button"]')) if (b.textContent.trim().toLowerCase() === 'send' && b.offsetParent) return b; return null; }, () => document.querySelector('form button[type="submit"]')];
    let sendEl = await waitFor(() => { for (const fn of sendFns) { const r = fn(); if (r) return r; } return null; }, 5000);
    if (!sendEl) { await sleep(2000); for (const fn of sendFns) { sendEl = fn(); if (sendEl) break; } }
    if (sendEl) { click(sendEl); await log('dom_step', 'ok', 'Clicked send'); }
    else { compEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true })); await log('dom_step', 'skip', 'Used Enter key'); }

    await sleep(2500);
    if (checkBlock()) return { sent: false, verified: false, blocked: true, error: friendlyError('blocked after send'), started: true };

    const threadUrl = window.location.href;
    await log('thread_url_after_send', 'ok', threadUrl);

    // A5: post-send duplicate check
    const v = await verifyInThread(message);
    const spans = document.querySelectorAll('span');
    for (let i = spans.length - 1; i >= Math.max(0, spans.length - 10); i--) {
      if ((spans[i]?.textContent || '').includes(message + message)) {
        await log('delivery_verified', 'fail', 'DUPLICATE BUG DETECTED in sent bubble');
        return { sent: true, verified: false, threadUrl, error: 'message duplicated in bubble', started: true };
      }
    }

    await log('delivery_verified', v.ok ? 'ok' : 'fail', v.detail);
    return { sent: true, verified: v.ok, threadUrl, error: v.ok ? null : v.detail, started: true };
  }

  async function verifyInThread(message) {
    await sleep(2000);
    const spans = document.querySelectorAll('span');
    for (let i = spans.length - 1; i >= Math.max(0, spans.length - 60); i--)
      if (spans[i]?.textContent === message) return { ok: true, detail: `Verified: message delivered` };
    if (document.body.innerText.includes(message)) return { ok: true, detail: 'Message found on page' };
    if (window.location.pathname.includes('/direct/t/')) return { ok: false, detail: 'On thread but message not visible' };
    return { ok: false, detail: 'Not on thread page' };
  }

  async function doVerify() {
    const d = await chrome.storage.local.get('sentLog'); const sentLog = d.sentLog || []; if (!sentLog.length) return { ok: false, detail: 'No sends recorded yet' }; const last = sentLog[sentLog.length-1];
    try { const r = await fetch(`/api/v1/direct_v2/inbox/?limit=20&_t=${Date.now()}`, { headers: { 'x-ig-app-id': IG_APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-csrftoken': getCookie('csrftoken')||'' }, credentials: 'include' });
      if (r.ok) { const j = await r.json(); for (const t of (j.inbox?.threads||[])) { if ((t.users||[]).some(u => u.username.toLowerCase() === last.username.toLowerCase())) { const items = t.items||[]; if (!items.length) return { ok: false, detail: `Thread with @${last.username} exists but is empty`, username: last.username }; const txt = items[0].text||''; if (txt && (txt.includes(last.message)||last.message.includes(txt))) return { ok: true, detail: `Delivered: "${txt}"`, username: last.username }; return { ok: false, detail: `Thread exists, last message: "${(txt||items[0].item_type||'?').slice(0,80)}"`, username: last.username }; } } return { ok: false, detail: `No thread found with @${last.username}`, username: last.username }; }
    } catch (_) {}
    if (window.location.pathname.includes('/direct/') && document.body.innerText.includes(last.message)) return { ok: true, detail: 'Delivered (found on page)', username: last.username };
    return { ok: false, detail: 'Could not verify — try opening Instagram inbox manually', username: last.username };
  }

  // Test send — calls executeSendToUser
  async function testSendToSelf(raw, msg) {
    const u = strip(raw);
    await chrome.storage.local.set({ lastCheckResult: [] });
    await log('test_send', 'ok', `Test send to @${u}`);
    const job = { queue: [{ username: u, message: msg }], index: 0, phase: 'execute', today: 0, total: 0, cap: 99, started: Date.now(), isTest: true, consecutiveFails: 0 };
    await chrome.storage.local.set({ dmJob: job });
    if (!window.location.pathname.startsWith('/direct/new')) window.location.href = 'https://www.instagram.com/direct/new/';
    else await execCurrent(job);
  }

  // A3: Simulate auto flow — restores state after completion
  async function simulateAutoFlow() {
    await chrome.storage.local.set({ lastCheckResult: [] });
    await log('simulate', 'ok', 'SIMULATE FULL AUTO FLOW');
    const data = await chrome.storage.local.get(null);
    if (!data.messages?.length) { await log('simulate', 'fail', 'No messages configured'); return; }
    const uid = await getUserId();
    if (!uid) { await log('simulate', 'fail', 'No user ID'); return; }
    const followers = await fetchFollowers(uid);
    if (!followers.length) { await log('simulate', 'fail', 'No followers'); return; }
    const seen = new Set(data.seenFollowers || []);
    const candidate = followers.find(f => seen.has(f.username));
    if (!candidate) { await log('simulate', 'fail', 'No seen follower to simulate with'); return; }

    await log('simulate', 'ok', `Testing with @${candidate.username}`);
    // Remove from seen temporarily
    const without = (data.seenFollowers || []).filter(u => u !== candidate.username);
    await chrome.storage.local.set({ seenFollowers: Array.from(new Set(without)), enabled: true, sentToday: 0, simulateTarget: candidate.username });
    await log('simulate', 'ok', 'Calling runCheck()...');
    await runCheck();
    // A3: re-add after simulation completes (done in finishJob via simulateTarget check)
  }

  // DM Job state machine
  async function startDMBatch(batch, data) {
    const job = { queue: batch.map(b => ({ username: strip(b.username), message: pickMsg(data.messages) })), index: 0, phase: 'execute', today: data.sentToday, total: data.sentTotalCount||0, cap: Math.min(data.dailyCap, ABS_MAX_DAILY), started: Date.now(), consecutiveFails: 0 };
    await chrome.storage.local.set({ dmJob: job });
    await log('dm_batch_started', 'ok', `${batch.length} queued: [${batch.map(b=>b.username).join(', ')}]`);
    window.location.href = 'https://www.instagram.com/direct/new/';
  }

  async function resumeJob() {
    const { dmJob: job, pendingDiagnose, pendingManualTest } = await chrome.storage.local.get(['dmJob', 'pendingDiagnose', 'pendingManualTest']);
    if (pendingDiagnose && window.location.pathname.startsWith('/direct/new')) { await chrome.storage.local.set({ pendingDiagnose: false }); runAutoDiagnose(); return; }
    if (pendingManualTest && window.location.pathname.startsWith('/direct/new')) { await chrome.storage.local.set({ pendingManualTest: false }); runManualTestTyping(); return; }
    if (!job || job.phase === 'idle') return;
    if (Date.now() - job.started > JOB_STALE_MS) { await log('dm_job', 'fail', 'Job timed out, resetting'); job.phase = 'idle'; await chrome.storage.local.set({ dmJob: job }); return; }
    if (job.phase === 'waiting') { const left = (job.waitUntil||0) - Date.now();
      if (left > 0) { setTimeout(async () => { const f = (await chrome.storage.local.get('dmJob')).dmJob; if (f?.phase === 'waiting') { f.phase = 'execute'; await chrome.storage.local.set({ dmJob: f }); window.location.href = 'https://www.instagram.com/direct/new/'; } }, left); return; }
      job.phase = 'execute'; await chrome.storage.local.set({ dmJob: job }); window.location.href = 'https://www.instagram.com/direct/new/'; return; }
    if (job.phase === 'execute') { if (!window.location.pathname.startsWith('/direct/')) { window.location.href = 'https://www.instagram.com/direct/new/'; return; } await execCurrent(job); }
  }

  async function execCurrent(job) {
    if (job.index >= job.queue.length || job.today >= job.cap) { await finishJob(job); return; }
    if (checkBlock()) { await chrome.storage.local.set({ blockedUntil: Date.now() + 86400000 }); await finishJob(job); return; }
    const { username, message } = job.queue[job.index];
    await log('dm_sending', 'ok', `Sending to @${username} (${job.index+1}/${job.queue.length})...`);

    const result = await executeSendToUser(username, message);

    if (result.blocked) {
      await chrome.storage.local.set({ blockedUntil: Date.now() + 86400000 });
      await log('dm_result', 'fail', `@${username}: ${friendlyError('blocked')}`);
      // A2: mark seen even on block (send was attempted)
      if (result.started) await markSeen(username);
      await finishJob(job); return;
    }

    if (result.sent) {
      // A1: ALWAYS mark seen after send clicked, regardless of verification
      await markSeen(username);
      job.today++; job.total++;
      // Read current sentLog from storage to avoid stale overwrites
      const cur = await chrome.storage.local.get(['sentLog']);
      const sentLog = cur.sentLog || [];
      sentLog.push({ username, message, ts: Date.now(), verified: result.verified, threadUrl: result.threadUrl || '', markedSeen: true });
      if (sentLog.length > 100) sentLog.splice(0, sentLog.length - 100);
      await chrome.storage.local.set({ sentLog, sentToday: job.today, sentTotalCount: job.total });
      await log('dm_result', 'ok', `@${username}: ${result.verified ? 'VERIFIED' : 'sent (unverified)'}`);

      if (!result.verified) { job.consecutiveFails = (job.consecutiveFails||0)+1; }
      else { job.consecutiveFails = 0; }
      // C4: 3 consecutive block/fail = pause 24h
      if (job.consecutiveFails >= 3) { await log('dm_job', 'fail', 'Multiple failures. Pausing 24h.'); await chrome.storage.local.set({ blockedUntil: Date.now() + 86400000 }); await finishJob(job); return; }
    } else {
      // A2: if send was started (typing happened) but failed, still mark seen
      if (result.started) await markSeen(username);
      else await log('dm_result', 'skip', `@${username}: not started, will retry next cycle`);
      await log('dm_result', 'fail', `@${username}: ${friendlyError(result.error||'unknown')}`);
      job.consecutiveFails = (job.consecutiveFails||0)+1;
      if (job.consecutiveFails >= 3) { await log('dm_job', 'fail', 'Multiple failures. Stopping.'); await finishJob(job); return; }
    }

    job.index++;
    if (job.index < job.queue.length && job.today < job.cap) {
      // C3: enforce absolute floor of 45s between sends
      const delay = Math.max(MIN_DELAY, MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY)));
      job.waitUntil = Date.now() + delay; job.phase = 'waiting';
      await chrome.storage.local.set({ dmJob: job });
      await log('dm_job', 'ok', `Waiting ${Math.round(delay/1000)}s...`);
      setTimeout(async () => { const f = (await chrome.storage.local.get('dmJob')).dmJob; if (f?.phase === 'waiting') { f.phase = 'execute'; await chrome.storage.local.set({ dmJob: f }); window.location.href = 'https://www.instagram.com/direct/new/'; } }, delay);
    } else { await finishJob(job); }
  }

  async function finishJob(job) {
    job.phase = 'idle';
    await chrome.storage.local.set({ dmJob: job, sentToday: job.today, sentTotalCount: job.total });
    // A3: if this was a simulation, re-add the target
    const { simulateTarget } = await chrome.storage.local.get('simulateTarget');
    if (simulateTarget) {
      await markSeen(simulateTarget);
      await chrome.storage.local.set({ simulateTarget: null });
      await log('simulate', 'ok', `Re-added @${simulateTarget} to seenFollowers after simulation`);
    }
    await log('final_status', 'ok', `Batch done: ${job.today} sent today`);
  }

  // runCheck — called by alarm AND by simulateAutoFlow
  async function runCheck() {
    isRunning = true;
    try {
      await log('content_script_reached', 'ok', 'Check started');
      const data = await chrome.storage.local.get(null);
      if (!data.enabled) { await log('final_status', 'skip', 'HeyBack is off'); return; }
      if (!data.messages?.length) { await log('final_status', 'skip', 'No messages set up'); return; }
      if (data.blockedUntil && Date.now() < data.blockedUntil) { await log('final_status', 'skip', 'Paused (Instagram limit)'); return; }
      if (data.dmJob?.phase && data.dmJob.phase !== 'idle') { if (Date.now() - (data.dmJob.started||0) > JOB_STALE_MS) { await chrome.storage.local.set({ dmJob: { phase: 'idle' } }); } else { await log('final_status', 'skip', 'Send in progress'); return; } }
      const today = new Date().toISOString().slice(0,10);
      if (data.lastResetDate !== today) { await chrome.storage.local.set({ sentToday: 0, lastResetDate: today }); data.sentToday = 0; }
      // C3: enforce absolute ceiling
      const effectiveCap = Math.min(data.dailyCap || 15, ABS_MAX_DAILY);
      if (data.sentToday >= effectiveCap) { await log('final_status', 'skip', `Daily limit reached (${data.sentToday}/${effectiveCap})`); return; }
      const uid = await getUserId(); if (!uid) { await log('final_status', 'fail', 'Not logged into Instagram'); return; }
      const followers = await fetchFollowers(uid);
      if (!followers.length) { await log('final_status', 'fail', 'No followers found'); return; }
      if (!data.hasCompletedFirstRun) {
        const all = Array.from(new Set(followers.map(f=>f.username)));
        await chrome.storage.local.set({ seenFollowers: all, hasCompletedFirstRun: true });
        await log('final_status', 'ok', `First run: marked ${all.length} existing followers as seen`); return;
      }
      // A4: dedup seenFollowers on read
      const seen = new Set(data.seenFollowers||[]);
      const fresh = followers.filter(f => !seen.has(f.username));
      await log('new_followers_diff', fresh.length ? 'ok' : 'skip', fresh.length ? `${fresh.length} new: [${fresh.map(f=>f.username).join(', ')}]` : `0 new (${seen.size} seen, ${followers.length} fetched)`);
      if (!fresh.length) { await log('final_status', 'ok', 'No new followers'); return; }
      await startDMBatch(fresh.slice(0, Math.min(fresh.length, MAX_BATCH, effectiveCap - data.sentToday)), data);
    } catch (e) { await log('final_status', 'fail', `Error: ${e.message}`); }
    finally { isRunning = false; }
  }

  // Diagnose functions (compact)
  async function runAutoDiagnose() {
    const username = 'yourrealestatecoo'; const res = { status: 'running', steps: [], htmlDump: '' };
    async function step(t, s) { res.steps.push({ text: t, status: s, ts: Date.now() }); await chrome.storage.local.set({ autoDiagnoseResult: { ...res } }); }
    async function upd(t, s) { res.steps[res.steps.length-1] = { text: t, status: s, ts: Date.now() }; await chrome.storage.local.set({ autoDiagnoseResult: { ...res } }); }
    if (!window.location.pathname.startsWith('/direct/new')) { await step('Navigating...', 'running'); await chrome.storage.local.set({ autoDiagnoseResult: res, pendingDiagnose: true }); window.location.href = 'https://www.instagram.com/direct/new/'; return; }
    await forceFocus(); await step('On /direct/new/', 'ok'); await sleep(2000);
    const searchEl = findSearchInput(); if (!searchEl) { await step('Search NOT FOUND', 'fail'); res.htmlDump = dumpHTML(); res.status = 'done'; await chrome.storage.local.set({ autoDiagnoseResult: res }); return; }
    await step('Found search input', 'ok');
    await step('Typing...', 'running'); const ok = await typeIntoReactInput(searchEl, username); await upd(`Typed. value="${searchEl.value}"`, ok?'ok':'fail');
    await step('Waiting 3.5s...', 'running'); await sleep(3500); await upd('Waited', 'ok');
    const tm = makeTextMatcher(username); let w = null;
    for (const [n,fn] of [['A',()=>stratA(tm)],['B',()=>stratB(tm)],['C',()=>stratC(tm)],['D',()=>stratD(tm,username)]]) { const el = fn(); await step(`${n}: ${el?'FOUND':'miss'}`, el?'ok':'fail'); if (el && !w) w = n; }
    const gEl = await stratG(); await step(`G: ${gEl?'FOUND':'miss'}`, gEl?'ok':'fail'); if (gEl && !w) w = 'G';
    const hEl = fallbackFirstProfile(); await step(`H: ${hEl?'FOUND':'miss'}`, hEl?'ok':'fail'); if (hEl && !w) w = 'H';
    await step(w ? `SUCCESS via ${w}` : 'FAILED: account may be search-restricted', w?'ok':'fail');
    res.htmlDump = dumpHTML(); res.status = 'done'; await chrome.storage.local.set({ autoDiagnoseResult: res, pendingDiagnose: false });
  }

  async function runManualTestTyping() {
    const username = 'yourrealestatecoo'; const res = { status: 'running', steps: [], htmlDump: '' };
    async function step(t, s) { res.steps.push({ text: t, status: s, ts: Date.now() }); await chrome.storage.local.set({ autoDiagnoseResult: { ...res } }); }
    async function upd(t, s) { res.steps[res.steps.length-1] = { text: t, status: s, ts: Date.now() }; await chrome.storage.local.set({ autoDiagnoseResult: { ...res } }); }
    if (!window.location.pathname.startsWith('/direct/new')) { await step('Navigating...', 'running'); await chrome.storage.local.set({ autoDiagnoseResult: res, pendingManualTest: true }); window.location.href = 'https://www.instagram.com/direct/new/'; return; }
    await forceFocus(); await step('Focused', 'ok'); await sleep(2000);
    const searchEl = findSearchInput(); if (!searchEl) { await step('Search NOT FOUND', 'fail'); res.status='done'; res.htmlDump=dumpHTML(); await chrome.storage.local.set({ autoDiagnoseResult: res }); return; }
    await step('Found input', 'ok');
    let xhrFired = false, xhrUrl = ''; const origFetch = window.fetch;
    window.fetch = function(...a) { const url = typeof a[0]==='string'?a[0]:a[0]?.url||''; if (url.includes('search')||url.includes('query')||url.includes('recipient')) { xhrFired=true; xhrUrl=url; } return origFetch.apply(this, a); };
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    ns.call(searchEl, ''); searchEl.dispatchEvent(new Event('input', { bubbles: true })); await sleep(100);
    for (let i = 0; i < username.length; i++) { const ch = username[i], p = username.slice(0,i+1); ns.call(searchEl, p);
      searchEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
      if (i%4===3||i===username.length-1) await step(`"${p}"`, searchEl.value===p?'ok':'fail'); await sleep(60+Math.random()*40); }
    await step('Waiting 3.5s...', 'running'); await sleep(3500); await upd('Waited', 'ok');
    window.fetch = origFetch;
    await step(xhrFired ? `XHR: ${xhrUrl.slice(0,100)}` : 'NO XHR', xhrFired?'ok':'fail');
    res.htmlDump = dumpHTML(); res.status = 'done'; await chrome.storage.local.set({ autoDiagnoseResult: res, pendingManualTest: false });
  }

  setTimeout(() => resumeJob(), 3000);
})();
