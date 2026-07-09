// HeyBack Dropdown Detection Test Harness
// ========================================
// USAGE: Navigate to https://www.instagram.com/direct/new/ in Chrome.
// Open DevTools console (F12). Paste this entire script and press Enter.
// It will prompt for a username, then test all 5 detection strategies.
// Does NOT send any message. Safe to run repeatedly.

(async function testHeyBackDropdown() {
  const raw = prompt('Enter Instagram username to test (a real follower):');
  if (!raw) { console.log('[HeyBack Test] Cancelled.'); return; }
  const username = raw.replace(/^@+/, '').toLowerCase();
  const normalized = username.replace(/[._]/g, '');

  function textMatch(el) {
    const t = el.textContent.toLowerCase();
    return t.includes(username) || t.replace(/[._]/g, '').includes(normalized);
  }

  console.log(`\n[HeyBack Test] ==============================`);
  console.log(`[HeyBack Test] Testing: "${username}"`);
  console.log(`[HeyBack Test] URL: ${window.location.href}`);
  console.log(`[HeyBack Test] ==============================\n`);

  // ── STEP 1: Find search input ──

  console.log('--- STEP 1: Finding search input ---');
  const inputStrats = [
    { name: 'aria-label*=earch', el: document.querySelector('input[aria-label*="earch" i]') },
    { name: 'placeholder*=earch', el: document.querySelector('input[placeholder*="earch" i]') },
    { name: 'name=queryBox', el: document.querySelector('input[name="queryBox"]') },
    { name: 'dialog input[text]', el: document.querySelector('[role="dialog"] input[type="text"]') },
  ];
  let searchInput = null;
  for (const s of inputStrats) {
    const status = s.el ? 'FOUND' : 'miss';
    console.log(`  ${status}: ${s.name}`, s.el || '');
    if (s.el && !searchInput) searchInput = s.el;
  }
  if (!searchInput) {
    // Fallback
    for (const el of document.querySelectorAll('input[type="text"],input:not([type])')) {
      if (el.offsetParent && el.getBoundingClientRect().width > 50) { searchInput = el; break; }
    }
    console.log(`  ${searchInput ? 'FOUND' : 'MISS'}: fallback visible input`, searchInput || '');
  }
  if (!searchInput) {
    console.error('[HeyBack Test] FAILED: No search input found. Are you on /direct/new/?');
    console.log('Page HTML (first 2000):', document.body.innerHTML.slice(0, 2000));
    return;
  }
  console.log(`  Using: <${searchInput.tagName} aria-label="${searchInput.getAttribute('aria-label')}" placeholder="${searchInput.getAttribute('placeholder')}">`);

  // ── STEP 2: Type username ──

  console.log('\n--- STEP 2: Typing username ---');
  searchInput.focus();
  searchInput.dispatchEvent(new Event('focus', { bubbles: true }));
  searchInput.dispatchEvent(new Event('focusin', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));

  const proto = Object.getPrototypeOf(searchInput);
  const protoSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const setter = (protoSetter && protoSetter !== nativeSetter) ? protoSetter : nativeSetter;

  // Clear
  if (setter) setter.call(searchInput, ''); else searchInput.value = '';
  searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  await new Promise(r => setTimeout(r, 100));

  // Type char by char
  let current = '';
  for (const ch of username) {
    current += ch;
    if (setter) setter.call(searchInput, current); else searchInput.value = current;
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    searchInput.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true, cancelable: true }));
    searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
    searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
  }
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));

  console.log(`  Typed: "${username}"`);
  console.log(`  input.value after typing: "${searchInput.value}"`);
  if (searchInput.value !== username) {
    console.warn(`  WARNING: Value mismatch! React may have reset the input. This is likely why results don't appear.`);
  }

  // ── STEP 3: Wait for results ──

  console.log('\n--- STEP 3: Waiting 2.5s for search results ---');
  await new Promise(r => setTimeout(r, 2500));

  // ── STEP 4: Test all 5 dropdown strategies ──

  console.log('\n--- STEP 4: Testing dropdown detection strategies ---');
  const results = {};

  // Strategy A: dialog interactive elements
  console.log('\n  Strategy A: role=button/option/checkbox/label inside [role="dialog"]');
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) {
    console.log('    No [role="dialog"] found on page');
    results.A = null;
  } else {
    let found = null;
    for (const el of dlg.querySelectorAll('[role="button"],button,[role="option"],[role="checkbox"],label,div[tabindex]')) {
      if (textMatch(el) && el.offsetParent) { found = el; break; }
    }
    console.log(`    ${found ? 'FOUND' : 'miss'}`, found || '');
    if (found) console.log('    Element:', found.outerHTML.slice(0, 300));
    results.A = found;
  }

  // Strategy B: global interactive
  console.log('\n  Strategy B: global interactive elements');
  let bFound = null;
  for (const el of document.querySelectorAll('[role="button"],button,[role="option"],[role="checkbox"],label,div[tabindex]')) {
    if (textMatch(el) && el.offsetParent) { bFound = el; break; }
  }
  console.log(`    ${bFound ? 'FOUND' : 'miss'}`, bFound || '');
  if (bFound) console.log('    Element:', bFound.outerHTML.slice(0, 300));
  results.B = bFound;

  // Strategy C: avatar img parent chain
  console.log('\n  Strategy C: img avatar whose parent chain contains username');
  let cFound = null;
  for (const img of document.querySelectorAll('img')) {
    let container = img.parentElement;
    for (let i = 0; i < 6 && container; i++) {
      if (textMatch(container) && container.offsetParent) {
        const rect = container.getBoundingClientRect();
        if (rect.height > 30 && rect.height < 200 && rect.width > 80) { cFound = container; break; }
      }
      container = container.parentElement;
    }
    if (cFound) break;
  }
  console.log(`    ${cFound ? 'FOUND' : 'miss'}`, cFound || '');
  if (cFound) console.log('    Element:', cFound.outerHTML.slice(0, 300));
  results.C = cFound;

  // Strategy D: TreeWalker
  console.log('\n  Strategy D: TreeWalker text node search');
  let dFound = null;
  const root = dlg || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.textContent.toLowerCase().includes(username) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  let textNode;
  const textNodes = [];
  while (textNode = walker.nextNode()) {
    if (textNode.parentElement?.closest('input')) continue;
    textNodes.push(textNode);
    let el = textNode.parentElement;
    for (let i = 0; i < 10 && el; i++) {
      const role = el.getAttribute?.('role');
      const tag = el.tagName?.toLowerCase();
      const ti = el.getAttribute?.('tabindex');
      if (tag === 'button' || role === 'button' || role === 'option' || role === 'checkbox' || ti !== null) {
        if (el.offsetParent) { dFound = el; break; }
      }
      if ((tag === 'div' || tag === 'label') && el.offsetParent) {
        try { if (window.getComputedStyle(el).cursor === 'pointer') { dFound = el; break; } } catch(_) {}
      }
      el = el.parentElement;
    }
    if (dFound) break;
  }
  console.log(`    Text nodes containing "${username}": ${textNodes.length}`);
  for (const tn of textNodes.slice(0, 5)) {
    console.log(`      "${tn.textContent.trim().slice(0, 80)}" inside <${tn.parentElement?.tagName}>`);
  }
  console.log(`    ${dFound ? 'FOUND' : 'miss'}`, dFound || '');
  if (dFound) console.log('    Element:', dFound.outerHTML.slice(0, 300));
  results.D = dFound;

  // Strategy E: MutationObserver (already waited, just report)
  console.log('\n  Strategy E: MutationObserver (skipped in test — already waited)');
  results.E = null;

  // ── STEP 5: HTML dump ──

  console.log('\n--- STEP 5: Container HTML dump ---');
  const dumpTarget = dlg || searchInput.closest('div')?.parentElement?.parentElement?.parentElement || document.body;
  const html = dumpTarget.innerHTML.replace(/\n/g, ' ');
  console.log(`  Container: <${dumpTarget.tagName} role="${dumpTarget.getAttribute('role')}">`);
  console.log(`  Full HTML (${html.length} chars, showing first 3000):`);
  console.log(html.slice(0, 3000));

  // ── STEP 6: Report ──

  console.log('\n--- REPORT ---');
  const winners = [];
  if (results.A) winners.push('A');
  if (results.B) winners.push('B');
  if (results.C) winners.push('C');
  if (results.D) winners.push('D');

  if (winners.length > 0) {
    console.log(`%c SUCCESS: Strategies [${winners.join(', ')}] found an element for "${username}"`, 'color: green; font-weight: bold; font-size: 14px');
    const winner = results[winners[0]];
    console.log('  Winning element:', winner);
    console.log('  outerHTML:', winner.outerHTML.slice(0, 500));

    // Dry-run: simulate click
    console.log('\n--- DRY RUN: Simulating click (no actual send) ---');
    console.log('  Would click:', winner.tagName, winner.getAttribute('role'), winner.className?.toString().slice(0, 60));

    // Check if clicking would reveal a Chat/Next button
    winner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    await new Promise(r => setTimeout(r, 1000));

    let chatBtn = null;
    for (const b of document.querySelectorAll('button,[role="button"],div[role="button"]')) {
      if (/^(chat|next|send message)$/i.test(b.textContent.trim()) && b.offsetParent) { chatBtn = b; break; }
    }
    if (chatBtn) {
      console.log(`%c  Chat/Next button appeared: "${chatBtn.textContent.trim()}"`, 'color: green');
      console.log('  Two-step flow confirmed. Extension will click this to proceed.');
    } else {
      console.log('  No Chat/Next button found after click. May need retry or different flow.');
      console.log('  Current URL:', window.location.href);
    }

  } else {
    console.log(`%c FAILED: All strategies missed for "${username}"`, 'color: red; font-weight: bold; font-size: 14px');
    console.log('  Possible causes:');
    console.log('  1. input.value was reset by React (check STEP 2 output)');
    console.log('  2. Instagram did not return search results (rate limited? account issue?)');
    console.log('  3. Results rendered with a structure none of our strategies cover');
    console.log('  → Check the HTML dump in STEP 5 for the actual DOM structure');
    console.log('  → Look for any element containing the text "' + username + '"');
  }

  console.log('\n[HeyBack Test] Done.');
})();
