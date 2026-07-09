(() => {
  const $ = s => document.querySelector(s);
  let saveTimer = null, shiftDCount = 0, shiftDTimer = null, modalRefresh = null;

  function timeAgo(ts) { if(!ts) return 'never'; const s=Math.floor((Date.now()-ts)/1000); if(s<60) return `${s}s ago`; const m=Math.floor(s/60); if(m<60) return `${m}m ago`; return `${Math.floor(m/60)}h ${m%60}m ago`; }
  function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  async function init() {
    const d = await chrome.storage.local.get(null);
    // B1: onboarding
    if (!d.onboardingDone) {
      $('#onboarding').style.display='block'; $('#main').style.display='none';
      $('#onboardBtn').addEventListener('click', async () => {
        await chrome.storage.local.set({ onboardingDone: true });
        $('#onboarding').style.display='none'; $('#main').style.display='block'; render(d);
      }); return;
    }
    $('#main').style.display='block'; render(d);
  }

  function render(d) {
    $('#toggle').checked=!!d.enabled;
    if (d.messages?.length) $('#messages').value=d.messages.join('\n');
    $('#cap').value=d.dailyCap||15;
    updateCharCount();
    renderStatus(d); renderSent(d); renderRecent(d.sentLog||[]);
  }

  // B4: status states
  function renderStatus(d) {
    const dot=$('#dot'), t=$('#statusText');
    dot.classList.remove('pulse');
    if (d.blockedUntil && Date.now() < d.blockedUntil) {
      const reason = d.blockedUntil - Date.now() > 13*3600000 ? 'Instagram may have changed. Check for updates.' : 'Instagram is asking us to slow down.';
      dot.className='dot orange'; t.textContent=`Paused — ${reason}`;
    } else if (!d.enabled) {
      dot.className='dot red'; t.textContent='Off';
    } else if (d.dmJob?.phase && d.dmJob.phase !== 'idle') {
      dot.className='dot green pulse'; t.textContent=`Sending... @${d.dmJob.queue?.[d.dmJob.index]?.username||''}`;
    } else if ((d.sentToday||0) >= Math.min(d.dailyCap||15, 30)) {
      dot.className='dot orange'; t.textContent='Daily limit reached — resumes tomorrow';
    } else {
      dot.className='dot green pulse'; t.textContent='Ready — watching for new followers';
    }
  }

  function renderSent(d) {
    const c=Math.min(d.dailyCap||15,30), t=d.sentToday||0;
    $('#sentToday').textContent = t>=c ? `${t} / ${c} (limit)` : `${t} / ${c}`;
    // D2: progress bar
    const pct = c > 0 ? Math.min(100, (t/c)*100) : 0;
    $('#progressFill').style.width = `${pct}%`;
  }

  // D3: relative time + D4: hover shows message
  function renderRecent(log) {
    const el=$('#recent');
    if (!log.length) { el.innerHTML='<div class="recent-empty">No DMs sent yet</div>'; return; }
    el.innerHTML=log.slice(-5).reverse().map(e => {
      const ago = timeAgo(e.ts);
      const msgPreview = e.message ? e.message.slice(0,60) : '';
      return `<div class="recent-item" title="${esc(msgPreview)}"><span>@${esc(e.username)}</span><span>${ago}</span></div>`;
    }).join('');
  }

  function updateCharCount() {
    const msgs = $('#messages').value.split('\n').map(l=>l.trim()).filter(Boolean);
    $('#charCount').textContent = `${msgs.length} message${msgs.length !== 1 ? 's' : ''}`;
  }

  function debouncedSave() { clearTimeout(saveTimer); saveTimer=setTimeout(save,500); }
  async function save() {
    const messages=$('#messages').value.split('\n').map(l=>l.trim()).filter(Boolean);
    let cap=parseInt($('#cap').value,10); if(isNaN(cap)||cap<1) cap=1; if(cap>30) cap=30;
    const enabled=$('#toggle').checked&&messages.length>0; $('#toggle').checked=enabled;
    await chrome.storage.local.set({enabled,messages,dailyCap:cap});
    const d=await chrome.storage.local.get(null); renderStatus(d); renderSent(d); updateCharCount();
  }

  // C1: safety warning on first toggle ON
  $('#toggle').addEventListener('change', async () => {
    if ($('#toggle').checked) {
      const d = await chrome.storage.local.get('safetyAcknowledged');
      if (!d.safetyAcknowledged) {
        $('#toggle').checked = false;
        $('#safetyModal').style.display = 'flex';
        return;
      }
    }
    save();
  });
  $('#safetyAccept').addEventListener('click', async () => {
    await chrome.storage.local.set({ safetyAcknowledged: true });
    $('#safetyModal').style.display = 'none';
    $('#toggle').checked = true;
    save();
  });
  $('#safetyCancel').addEventListener('click', () => { $('#safetyModal').style.display = 'none'; });

  $('#messages').addEventListener('input', () => { updateCharCount(); debouncedSave(); });
  $('#cap').addEventListener('change', save);

  // Advanced (Shift+D x3)
  document.addEventListener('keydown', e => { if(e.shiftKey&&e.key==='D'){shiftDCount++;clearTimeout(shiftDTimer);shiftDTimer=setTimeout(()=>shiftDCount=0,1500);if(shiftDCount>=3){$('#advanced').style.display='block';shiftDCount=0;}} });
  $('#advToggle').addEventListener('click', () => { const b=$('#advBody'); b.style.display=b.style.display==='none'?'flex':'none'; });
  $('#advReset').addEventListener('click', async () => { if(!confirm('Reset all seen followers?'))return; await chrome.storage.local.set({seenFollowers:[],hasCompletedFirstRun:false}); });
  $('#advDump').addEventListener('click', async () => { console.log('[HeyBack]',await chrome.storage.local.get(null)); alert('Dumped to console (F12)'); });

  // Modal + Tabs
  $('#bugBtn').addEventListener('click', () => { $('#bugModal').style.display='flex'; refreshModal(); modalRefresh=setInterval(refreshModal,1000); });
  $('#bugClose').addEventListener('click', closeModal);
  $('#bugModal').addEventListener('click', e => { if(e.target===$('#bugModal')) closeModal(); });
  function closeModal() { $('#bugModal').style.display='none'; clearInterval(modalRefresh); }
  function disableFor(b,t,ms) { b.disabled=true; const o=b.textContent; b.textContent=t; setTimeout(()=>{b.disabled=false;b.textContent=o;},ms); }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  }

  // Test tab
  $('#sendSelfBtn').addEventListener('click', async () => { const u=prompt('Instagram username to DM:'); if(!u?.trim())return; const d=await chrome.storage.local.get('messages'); const msgs=d.messages||[]; const msg=msgs.length?msgs[Math.floor(Math.random()*msgs.length)]:'test from HeyBack'; disableFor($('#sendSelfBtn'),'Sending...',15000); await chrome.storage.local.set({lastCheckResult:[]}); try{await chrome.runtime.sendMessage({type:'TEST_SEND',username:u.trim(),message:msg});}catch(_){} });
  $('#simAutoBtn').addEventListener('click', async () => { disableFor($('#simAutoBtn'),'Running...',30000); await chrome.storage.local.set({lastCheckResult:[]}); try{await chrome.runtime.sendMessage({type:'SIMULATE_AUTO_FLOW'});}catch(_){} });

  // Diagnose tab
  $('#diagnoseBtn').addEventListener('click', async () => { disableFor($('#diagnoseBtn'),'Running...',25000); await chrome.storage.local.set({autoDiagnoseResult:{status:'running',steps:[{text:'Starting...',status:'running',ts:Date.now()}],htmlDump:''},pendingDiagnose:false}); $('#diagnosePanel').style.display='block'; try{await chrome.runtime.sendMessage({type:'AUTO_DIAGNOSE'});}catch(_){} });
  $('#manualTypingBtn').addEventListener('click', async () => { disableFor($('#manualTypingBtn'),'Running...',25000); await chrome.storage.local.set({autoDiagnoseResult:{status:'running',steps:[{text:'Starting...',status:'running',ts:Date.now()}],htmlDump:''},pendingManualTest:false}); $('#diagnosePanel').style.display='block'; try{await chrome.runtime.sendMessage({type:'MANUAL_TEST_TYPING'});}catch(_){} });
  $('#copyDiagBtn').addEventListener('click', async () => { const d=await chrome.storage.local.get('autoDiagnoseResult'); const r=d.autoDiagnoseResult; if(!r){alert('Run a diagnosis first.');return;} const lines=(r.steps||[]).map(s=>`${s.status==='ok'?'OK':s.status==='fail'?'FAIL':'...'} ${s.text}`); if(r.htmlDump) lines.push('\n--- HTML ---\n'+r.htmlDump); try{await navigator.clipboard.writeText(lines.join('\n'));}catch(_){const ta=document.createElement('textarea');ta.value=lines.join('\n');document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);} alert('Copied!'); });

  // Log tab
  $('#verifyBtn').addEventListener('click', async () => { disableFor($('#verifyBtn'),'Checking...',6000); await chrome.storage.local.set({lastVerifyResult:null}); try{await chrome.runtime.sendMessage({type:'VERIFY_LAST_SEND'});}catch(_){} });
  $('#testNow').addEventListener('click', async () => { disableFor($('#testNow'),'Running...',5000); try{await chrome.runtime.sendMessage({type:'MANUAL_RUN_CHECK'});}catch(_){} });
  $('#resetTodayBtn').addEventListener('click', async () => { try{await chrome.runtime.sendMessage({type:'RESET_TODAY'});}catch(_){} });
  $('#resetJobBtn').addEventListener('click', async () => { try{await chrome.runtime.sendMessage({type:'FORCE_RESET_JOB'});}catch(_){} });
  $('#resetAllBtn').addEventListener('click', async () => { if(!confirm('Delete ALL HeyBack data? This cannot be undone.'))return; try{await chrome.runtime.sendMessage({type:'RESET_ALL'});}catch(_){} window.close(); });

  async function refreshModal() {
    const d = await chrome.storage.local.get(null);
    renderPipeline(d.lastCheckResult||[]);
    renderState(d);
    renderVerify(d.lastVerifyResult);
    renderDiagnose(d.autoDiagnoseResult);
    renderDeliveryLog(d.sentLog||[]);
    renderQueue(d);
  }

  function renderQueue(d) {
    const el=$('#queueInfo');
    const seen = (d.seenFollowers||[]).length;
    const job = d.dmJob;
    const pending = job?.phase !== 'idle' && job?.queue ? job.queue.slice(job.index||0).map(q=>`@${q.username}`).join(', ') : 'none';
    el.innerHTML = `Seen: <b>${seen}</b> | Today: <b>${d.sentToday||0}/${Math.min(d.dailyCap||15,30)}</b><br>Active queue: ${pending}`;
  }

  function renderPipeline(stages) {
    const el=$('#pipeline'); if(!stages.length){el.innerHTML='<div class="pipe-empty">No checks yet</div>';return;}
    const L={alarm_fired:'Alarm',tab_query_result:'IG tab',message_sent_to_content:'Content',content_script_reached:'Check',user_id_fetched:'User ID',followers_fetched:'Followers',new_followers_diff:'New followers',dm_batch_started:'Batch',dm_sending:'Sending',dm_result:'Result',dm_step:'Step',test_send:'Test',simulate:'Simulate',dom_step:'DOM',dropdown_strategy_used:'Dropdown',thread_url_after_send:'Thread',delivery_verified:'Delivery',mark_seen:'Seen',dm_job:'Job',final_status:'Done'};
    el.innerHTML=stages.map(s=>{const i=s.status==='ok'?'&#x2713;':s.status==='skip'?'&#x2014;':'&#x2717;';const c=s.status==='ok'?'':s.status==='skip'?' skip':' fail';return`<div class="pipe-row"><span class="pipe-icon">${i}</span><span class="pipe-text${c}">${esc(L[s.stage]||s.stage)}: ${esc(s.detail)} <span style="color:#bbb">(${timeAgo(s.ts)})</span></span></div>`;}).join('');
  }

  function renderState(d) {
    const a=d.lastAlarmAt?timeAgo(d.lastAlarmAt):'never'; const st=d.lastAlarmAt&&(Date.now()-d.lastAlarmAt>25*60*1000); const j=d.dmJob?.phase||'idle';
    $('#stateInfo').innerHTML=[`Enabled: <b>${d.enabled?'yes':'no'}</b>`,`Seen: <b>${(d.seenFollowers||[]).length}</b>`,`First run: <b>${d.hasCompletedFirstRun?'done':'pending'}</b>`,`Today: <b>${d.sentToday||0}/${Math.min(d.dailyCap||15,30)}</b>`,`Blocked: <b>${d.blockedUntil?'until '+new Date(d.blockedUntil).toLocaleTimeString():'no'}</b>`,`Job: <b>${j}</b>`,`Alarm: <b${st?' class="state-warn"':''}>${a}</b>${st?' <span class="state-warn">(stale)</span>':''}`].join('<br>');
  }

  function renderVerify(r) { const el=$('#verifyResult'); if(!r){el.style.display='none';return;} el.style.display='block'; el.className='verify-result '+(r.ok?'verify-ok':'verify-fail'); el.innerHTML=`${r.ok?'&#x2713;':'&#x2717;'} ${esc(r.detail)}`; }

  function renderDiagnose(r) { if(!r){$('#diagnosePanel').style.display='none';return;} $('#diagnosePanel').style.display='block';
    $('#diagnoseSteps').innerHTML=(r.steps||[]).map(s=>{const icon=s.status==='ok'?'&#x2713;':s.status==='fail'?'&#x2717;':'&#x25CF;';return`<div class="diag-step"><span class="icon">${icon}</span><span class="txt ${s.status}">${esc(s.text)}</span></div>`;}).join('');
    const htmlEl=$('#diagnoseHtml');if(r.htmlDump&&r.status==='done'){htmlEl.style.display='block';htmlEl.textContent=r.htmlDump;}else{htmlEl.style.display='none';}}

  function renderDeliveryLog(log) {
    const el=$('#deliveryLog'); if(!log||!log.length){el.innerHTML='<div class="dl-empty">No deliveries yet</div>';return;}
    el.innerHTML=log.slice(-20).reverse().map(e=>{
      const ago=timeAgo(e.ts); const v=e.verified; const icon=v===true?'&#x2713;':v===false?'&#x2717;':'?'; const color=v===true?'color:#2e7d32':v===false?'color:#d32f2f':'color:#888';
      const seenTag = e.markedSeen ? '<span class="dl-seen">seen</span>' : '';
      return`<div class="dl-row"><span class="dl-icon" style="${color}">${icon}</span><span class="dl-user">@${esc(e.username)}</span><span class="dl-meta">${ago} ${seenTag}</span></div>`;
    }).join('');
  }

  // D3: auto-refresh recent list times
  const interval=setInterval(async()=>{const d=await chrome.storage.local.get(null);renderStatus(d);renderSent(d);renderRecent(d.sentLog||[]);},2000);
  window.addEventListener('unload',()=>{clearInterval(interval);clearInterval(modalRefresh);});
  init();
})();
