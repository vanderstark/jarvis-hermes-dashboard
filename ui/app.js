/* JARVIS Live HUD — drives Claude Code, streams its telemetry.

   The brain is your own `claude` CLI (Path A), so whatever MCP connectors and
   skills you've configured are live. This file only streams and renders. */
const $ = s => document.querySelector(s);
const RT = {tts:false, stt:false};

// ── reactor ticks ──
(() => {
  const g = $('#ticks480');
  for (let i = 0; i < 96; i++){
    const a = (i/96) * Math.PI*2, maj = i % 8 === 0;
    const r0 = maj ? 226 : 230, r1 = 238;
    const l = document.createElementNS('http://www.w3.org/2000/svg','line');
    l.setAttribute('x1', 240+Math.cos(a)*r0); l.setAttribute('y1', 240+Math.sin(a)*r0);
    l.setAttribute('x2', 240+Math.cos(a)*r1); l.setAttribute('y2', 240+Math.sin(a)*r1);
    if (maj) l.setAttribute('class','maj');
    g.appendChild(l);
  }
})();

const now = () => new Date().toLocaleTimeString('en-GB', {hour12:false});
const rid = () => 'run_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'').slice(0,24)
                                              : Math.random().toString(16).slice(2,14));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// ── reactor state ──
function setState(cls, word, sub){
  document.body.className = cls;
  if (word) $('#stword').textContent = word;
  if (sub != null) $('#strun').textContent = sub;
}
function setTag(cls, text){ const t=$('#rtag'); t.className='rtag '+cls; t.textContent=text; }

// ── action log ──
function log(kind, label, msg, jsonHtml){
  const e = document.createElement('div');
  e.className = 'entry k-' + kind;
  e.innerHTML = `<div class="top"><span class="ts">${now()}</span>`
    + `<span class="kind">${esc(label)}</span></div>`
    + (msg ? `<div class="msg">${esc(msg)}</div>` : '')
    + (jsonHtml ? `<div class="jsonblk">${jsonHtml}</div>` : '');
  const box = $('#log');
  box.insertBefore(e, box.firstChild);
  while (box.children.length > 40) box.removeChild(box.lastChild);
}
function usageBlock(u){
  const row = (k,v) => `  <span class="k">"${k}"</span>: <span class="v">${v}</span>`;
  return `{\n  <span class="k">"usage"</span>: {\n`
    + [row('input_tokens', u.input_tokens), row('output_tokens', u.output_tokens),
       row('total_tokens', u.total_tokens)].join(',\n')
    + `\n  }\n}`;
}

// ── the run ──
let running = false, answer = '', firstDelta = false, speakDone = Promise.resolve();

async function transmit(message){
  if (!message.trim()) return;
  if (running){
    // don't silently swallow it — say so, so it never looks like nothing happened
    log('note','BUSY',`still working — "${message.slice(0,40)}" not sent. Wait, or press Esc to cancel.`);
    return;
  }
  running = true; answer = ''; firstDelta = false;

  const fresh = /^\/new\b/.test(message.trim());
  const id = rid();
  setState('running', 'RUNNING', id.slice(0,20) + '…');
  setTag('run', 'RUNNING');
  $('#response').innerHTML = '<span class="cur"></span>';
  log('run', 'RUN', `started ${id}; uplink cleared`);

  // visible elapsed counter — a slow answer should never look like a dead screen
  const t0 = performance.now();
  const tick = setInterval(() => {
    if (!running) return;
    const s = ((performance.now()-t0)/1000).toFixed(1);
    if (!answer) $('#strun').textContent = `thinking… ${s}s`;
  }, 200);

  try {
    const res = await fetch('/api/run', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({message, fresh})
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true){
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream:true});
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
  } catch (e){
    log('error', 'ERROR', String(e).slice(0,200));
    setState('error', 'FAULT', 'stream dropped');
    setTag('err', 'ERROR');
  }
  running = false;
  clearInterval(tick);
  await speakDone;                 // don't return until Jarvis has finished talking
}

function handle(ev){
  switch (ev.t){
    case 'status':
      if (ev.session_id) sys('session', ev.session_id.slice(0,8));
      log('status', 'STATUS',
          `core online · tools=${ev.tools} `
          + `mcp=[${(ev.mcp||[]).join(', ')||'—'}] permission=${ev.permission}`);
      break;
    case 'latency':
      log('latency', 'LATENCY', `first token after ${ev.ms}ms`);
      break;
    case 'tool':
      if (ev.phase === 'use')
        log('tool', 'TOOL', `→ ${ev.name}(${ev.input || ''})`);
      else
        log('tool', 'TOOL', `✓ ${ev.ok===false?'error':'ok'}`);
      break;
    case 'delta':
      answer += ev.text;
      renderAnswer();
      if (!firstDelta){
        firstDelta = true;
        log('reason', 'REASONING', answer.slice(0, 220));
      }
      break;
    case 'usage':
      log('status', 'COMPLETE', 'run completed', usageBlock(ev));
      break;
    case 'complete':
      setState('done', 'COMPLETE', (ev.ms!=null?`${ev.ms}ms`:'') );
      setTag('done', 'COMPLETE');
      log('complete', 'COMPLETE', ev.ms!=null?`run completed in ${ev.ms}ms`:'run completed');
      renderAnswer(true);
      speakDone = speak(answer);         // transmit() awaits this before re-listening
      break;
    case 'error':
      setState('error', 'FAULT', ev.message?.slice(0,40) || 'error');
      setTag('err', 'ERROR');
      log('error', 'ERROR', ev.message || 'unknown');
      // show it in the panel too, so a failure isn't a silent empty box
      if (!answer) $('#response').innerHTML =
        `<span style="color:var(--red)">⚠ ${esc(ev.message || 'Run failed.')}</span>`;
      else renderAnswer(true);
      break;
    case 'note':
      log('note', 'NOTE', ev.message || '');
      break;
  }
}

function renderAnswer(finaldone){
  const el = $('#response');
  el.innerHTML = esc(answer) + (finaldone ? '' : '<span class="cur"></span>');
  el.scrollTop = el.scrollHeight;
}

/* ══════════ continuous voice conversation ══════════
   Click VOICE once. From then on: listen → you stop → transcribe → Jarvis
   answers and speaks → it listens again, automatically. No re-clicking between
   turns. Click VOICE again (or press Esc) to end the conversation.

   The mic is deliberately DEAF while Jarvis is thinking or speaking (`suppress`)
   — otherwise it transcribes his own voice through the speakers and talks to
   itself forever. That's why re-arming happens only after he finishes. */
let convo = false, suppress = false;
let micStream=null, recorder=null, chunks=[], actx=null, analyser=null, vdata=null;
let vad=null, spoke=false, loudAt=0, turnStart=0;
let floorSum=0, floorN=0, threshold=0.02, peak=0, calibrating=true;
const SILENCE=900, MIN_TURN_MS=350, MAX_TURN_MS=18000, NO_SPEECH_MS=7000;

// ── voice out ──
let muted = false, player = null;
function speak(text){
  return new Promise(resolve => {
    text = (text||'').trim();
    if (muted || !RT.tts || !text) return resolve();
    suppress = true;                                  // go deaf before audio starts
    const spoken = text.length > 700 ? text.slice(0, 680).replace(/\s+\S*$/,'') + '…' : text;
    fetch('/api/speak', {method:'POST', headers:{'content-type':'application/json'},
                         body: JSON.stringify({text:spoken})})
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        if (player) player.pause();
        player = new Audio(url);
        document.body.classList.add('speaking');
        const done = () => { document.body.classList.remove('speaking');
          URL.revokeObjectURL(url); resolve(); };
        player.onended = done; player.onerror = done;
        return player.play();
      })
      .catch(() => resolve());
  });
}

// ── start / stop the whole conversation ──
async function micToggle(){
  if (convo){ stopConvo(); return; }
  if (!RT.stt){ log('error','VOICE','no ElevenLabs key — set one in .env'); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia(
      {audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}});
  } catch(e){ log('error','VOICE','mic blocked — allow it in the address bar'); return; }
  actx = new (window.AudioContext||window.webkitAudioContext)();
  await actx.resume();
  analyser = actx.createAnalyser(); analyser.fftSize = 1024;
  actx.createMediaStreamSource(micStream).connect(analyser);
  vdata = new Uint8Array(analyser.fftSize);
  convo = true; suppress = false;
  $('#mic').classList.add('on'); $('#mic').textContent = '● LIVE';
  log('voice','VOICE','conversation open · listening');
  beginTurn();
}

function stopConvo(){
  convo = false; suppress = false;
  if (vad){ clearInterval(vad); vad=null; }
  if (recorder && recorder.state==='recording'){ recorder._cancel=true; try{recorder.stop();}catch(_){} }
  recorder = null;
  if (player){ try{player.pause();}catch(_){} }
  if (micStream){ micStream.getTracks().forEach(t=>t.stop()); micStream=null; }
  if (actx){ actx.close().catch(()=>{}); actx=null; analyser=null; }
  document.body.classList.remove('speaking');
  $('#mic').classList.remove('on'); $('#mic').textContent = '◉ VOICE';
  log('voice','VOICE','conversation closed');
  setState('', 'STANDBY', 'awaiting uplink');
}

// ── one listening turn ──
function beginTurn(){
  if (!convo || suppress || !micStream) return;
  chunks = []; spoke = false; peak = 0;
  floorSum = 0; floorN = 0; calibrating = true; threshold = 0.02;
  recorder = new MediaRecorder(micStream, pickMime());
  recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = ship;
  recorder.start(250);                          // timeslice → data flows reliably
  turnStart = loudAt = performance.now();
  setState('listening','LISTENING','listening…');
  if (!vad) vad = setInterval(vtick, 40);
}

function meter(rms){
  // live input bar in the reactor subtitle, so you can SEE it hearing you
  const n = Math.max(0, Math.min(14, Math.round(rms * 90)));
  $('#strun').textContent = 'IN ' + '▮'.repeat(n) + '▯'.repeat(14 - n);
}

function endTurn(reason){
  log('voice','VOICE',`${reason} · peak ${peak.toFixed(3)} · thr ${threshold.toFixed(3)}`);
  try { recorder.stop(); } catch(_){}           // → ship()
}

function pickMime(){
  for (const m of ['audio/webm;codecs=opus','audio/webm','audio/mp4'])
    if (window.MediaRecorder?.isTypeSupported?.(m)) return {mimeType:m};
  return undefined;
}

function vtick(){
  if (!analyser || suppress || !recorder || recorder.state!=='recording') return;
  analyser.getByteTimeDomainData(vdata);
  let s=0; for (let i=0;i<vdata.length;i++){ const v=(vdata[i]-128)/128; s+=v*v; }
  const rms = Math.sqrt(s/vdata.length);
  const t = performance.now();
  peak = Math.max(peak, rms);
  meter(rms);

  // first 300ms: measure the room's noise floor, set a threshold just above it
  if (calibrating){
    floorSum += rms; floorN++;
    if (t - turnStart > 300){
      const floor = floorSum / Math.max(1, floorN);
      threshold = Math.max(0.012, floor * 2.2 + 0.006);
      calibrating = false;
    }
    return;
  }

  if (rms > threshold){
    loudAt = t;
    if (!spoke){ spoke = true; log('voice','VOICE','speech detected'); }
  } else if (spoke && t - loudAt > SILENCE){
    return endTurn('silence');
  }

  // failsafes so it can never hang: cap the length, re-listen if no speech at all
  if (t - turnStart > MAX_TURN_MS) return endTurn('max-length');
  if (!spoke && t - turnStart > NO_SPEECH_MS) return endTurn('no-speech');
}

async function ship(){
  const cancel = recorder?._cancel;
  const blob = new Blob(chunks, {type: recorder?.mimeType || 'audio/webm'}); chunks=[];
  if (cancel){ return; }
  // no speech heard, too short, or too small — just listen again, don't ship ambient noise
  if (!spoke || blob.size < 1400 || performance.now()-turnStart < MIN_TURN_MS){
    if (convo && !suppress) beginTurn();
    return;
  }
  setState('running','TRANSCRIBING','…');
  log('voice','VOICE',`uploading ${Math.round(blob.size/1024)}KB to server STT`);
  const t0 = performance.now();
  try {
    const r = await fetch('/api/listen', {method:'POST',
      headers:{'content-type':blob.type||'audio/webm'}, body:blob}).then(r=>r.json());
    const text = (r.text||'').trim();
    const ms = Math.round(performance.now() - t0);
    if (!text){
      log('voice','VOICE','nothing transcribed');
      if (convo) beginTurn(); else setState('','STANDBY','nothing heard');
      return;
    }
    log('voice','VOICE',`transcribed by ElevenLabs in ${ms}ms: "${text}"`);
    const armed = $('#input').dataset.cmd || '';
    const full = (armed ? armed + ' ' : '') + text;
    $('#input').value = ''; disarm();
    log('send','SEND',`auto-sent voice: ${full}`);
    await transmit(full);                       // runs, then speaks; both with mic deaf
    // turn's done — hand the floor back and listen again
    suppress = false;
    if (convo) beginTurn();
  } catch(e){
    log('error','VOICE','transcription failed');
    suppress = false;
    if (convo) beginTurn(); else setState('error','FAULT','transcription failed');
  }
}

// ══════════ command matrix ══════════
function disarm(){
  document.querySelectorAll('.cmd').forEach(c=>c.classList.remove('armed'));
  $('#input').dataset.cmd = '';
}
$('#cmds').addEventListener('click', e => {
  const b = e.target.closest('.cmd'); if (!b) return;
  const cmd = b.dataset.cmd;
  if ($('#input').dataset.cmd === cmd){ disarm(); $('#tip').textContent = defaultTip; return; }
  disarm(); b.classList.add('armed'); $('#input').dataset.cmd = cmd;
  $('#input').focus();
  $('#tip').textContent = TIPS[cmd] || `Armed ${cmd} — now type or speak.`;
  log('command', 'COMMAND', `armed ${cmd}`);
});
const TIPS = {
  '/new':'Fresh thread — clears the conversation and starts Jarvis clean.',
  '/goal':'Say your standing objective, e.g. “grow the newsletter to 5k”.',
  '/profile':'Tell Jarvis about you — it saves it for every future run.',
  '/background':'Say a mission, e.g. “research competitors and save a report”.',
  '/personality':'Set the persona, e.g. “dry, brief, British butler”.',
  '/kanban':'Ask about the work queue, e.g. “what’s on my board today?”.'
};
let defaultTip = '';

// ══════════ controls ══════════
function sendFromInput(){
  const armed = $('#input').dataset.cmd || '';
  const raw = $('#input').value.trim();
  if (!raw && !armed) return;
  const full = (armed && !raw.startsWith('/')) ? `${armed} ${raw}` : (raw || armed);
  $('#input').value = ''; disarm(); $('#tip').textContent = defaultTip;
  log('send','SEND',`transmit: ${full}`);
  transmit(full);
}
$('#run').onclick = sendFromInput;
$('#mic').onclick = micToggle;
$('#mute').onclick = () => {
  muted = !muted; const b=$('#mute');
  b.textContent = muted?'🔇':'🔊'; b.classList.toggle('on',!muted); b.classList.toggle('off',muted);
  if (muted && player) player.pause();
};
$('#input').addEventListener('keydown', e => {
  if (e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); sendFromInput(); }
});

// ══════════ system panel ══════════
function sys(id, val, cls){
  const el = $('#sy-' + id); if (!el) return;
  el.textContent = val; if (cls != null) el.className = cls;
}
// live clock in the system panel
setInterval(() => sys('clock', now()), 1000);

// poll for finished /background missions and report them when they land
setInterval(async () => {
  try {
    const j = await fetch('/api/jobs').then(r => r.json());
    for (const d of (j.done || [])){
      log('complete','MISSION', `${d.mission} → ${(d.result||'').slice(0,200)}`);
      if (!running) speak(`Mission complete. ${(d.result||'').slice(0,300)}`);
    }
  } catch(_){}
}, 4000);

// ══════════ boot ══════════
(async () => {
  defaultTip = $('#tip').textContent;
  try {
    const s = await fetch('/api/status').then(r=>r.json());
    RT.tts = s.tts==='elevenlabs'; RT.stt = s.stt==='elevenlabs';

    sys('gw', 'online · :8730', 'ok');
    sys('brain', 'JARVIS Core', 'ok');
    sys('voice', RT.tts ? 'ElevenLabs' : 'off', RT.tts ? '' : 'warn');
    sys('profile', 'default');
    sys('session', s.session ? s.session.slice(0,8) : 'none');
    sys('clock', now());

    log('status', 'BOOT',
        `gateway online · core ready · permission=${s.permission}`);
    log('voice', 'VOICE', `channel ready — ElevenLabs STT/TTS`);
    setState('', 'STANDBY', 'awaiting uplink');
  } catch(e){
    sys('gw','offline','warn');
    log('error','STATUS','server unreachable');
  }
})();
