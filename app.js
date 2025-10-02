/* Big update per user's spec: inline feedback, meta-comprehension, dev uploads, week/topic changes */

const CONFIG = {
  CSV_URL: "items.csv",
  FEEDBACK_MS: 3000, // 3 sec with visible countdown
  MAX_ANSWER_LEN: 120,
  UNIT_MAPS: [
    { re: /\bm\/s\b/g, to: "m s^-1" },
    { re: /\bg\/ml\b/gi, to: "g mL^-1" },
    { re: /\buL\b/g, to: "μL" },
    { re: /\bumol\b/g, to: "μmol" },
    { re: /\bmol\/L\b/gi, to: "M" },
    { re: /\bdeg\b/gi, to: "°" },
  ],
  WEEK_TOPICS: {
    6: ["organic"],
    7: ["organic"],
    8: ["organic"],
    9: ["organic"],
    10: ["organic"],
    11: ["organic"],
    12: ["organic","inorganic"],
  },
  TOPIC_LABELS: {
    organic: "Organic Nomenclature",
    inorganic: "Inorganic Nomenclature"
  },
  MASTERY_REQUIRED: {
    organic: 1,
    inorganic: 1 // inorganic gets goal 4 if week=12
  },
  // Dev upload fallback: if running on pages.dev, use workers.dev endpoint
  WORKER_FALLBACK_URL: "https://srp-results-worker.rjmaligaya.workers.dev/api/ingest", // TODO: fill in
};

function nfkc(s) { return s.normalize("NFKC"); }
function collapseSpaces(s) { return s.replace(/\s+/g, " ").trim(); }
function normalizeCommonUnits(s) {
  let out = s;
  CONFIG.UNIT_MAPS.forEach(({re,to}) => { out = out.replace(re, to); });
  return out;
}
function normalizeAnswer(s) {
  if (s == null) return "";
  let out = String(s).toLowerCase();
  out = nfkc(out);
  out = collapseSpaces(out);
  out = normalizeCommonUnits(out);
  out = out.replace(/\btrans\b/g, "trans")
           .replace(/\bcis\b/g, "cis")
           .replace(/\b\(e\)\b/g, "(e)")
           .replace(/\b\(z\)\b/g, "(z)");
  return out;
}
function toAcceptableList(cell) {
  if (!cell) return [];
  return String(cell).split("||").map(a => normalizeAnswer(a)).filter(Boolean);
}
function toAcceptableSet(cell) { return new Set(toAcceptableList(cell)); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function nowISO() { return new Date().toISOString(); }

const State = {
  csvItems: [],
  itemsByTopicWeek: {}, // key: topic|week -> items[]
  week: null,
  topicsQueue: [],
  currentTopic: null,
  masteryGoal: 1,
  studentNumber: "",
  startTime: null,
  device: { w: window.innerWidth, h: window.innerHeight, ua: navigator.userAgent },

  firstPass: [],
  fpIndex: 0,
  masteryPool: [],
  masteryIndex: 0,
  correctCounts: new Map(),
  trials: [],
  trialIndex: 0,
  attemptNumber: 1, // Attempt 1 = first pass, then 2,3... per mastery sweep

  // first-pass stats (per topic)
  fpCorrectCount: 0,
  fpToRetryCount: 0,

  // meta estimate per topic
  metaEstimate: null,
};

// DOM helpers
function $(sel) { return document.querySelector(sel); }
function show(sel) {
  document.querySelectorAll(".view").forEach(n => n.classList.add("hidden"));
  const view = document.querySelector(sel);
  view.classList.remove("hidden");
  requestAnimationFrame(() => {
    const target = view.querySelector("[data-autofocus]") || view.querySelector("input, textarea, select");
    if (target && typeof target.focus === "function") target.focus({ preventScroll:true });
  });
}
function setText(sel, txt) { const n = $(sel); if (n) n.textContent = txt; }
function setImage(sel, src) { const n = $(sel); if (n) n.src = src; }
function toast(msg) { const n=$("#toast"); n.textContent=msg; n.classList.remove("hidden"); setTimeout(()=>n.classList.add("hidden"),2000); }

async function loadCSV() {
  const res = await fetch(CONFIG.CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load items.csv");
  const rows = parseCSV(await res.text());
  // expected columns: id,topic,week,image,answers,q_type,unfilled
  rows.forEach(r => {
    r.week = Number(r.week || 0);
    r.acceptableList = toAcceptableList(r.answers);
    r.acceptable = new Set(r.acceptableList);
    r.unfilled = r.unfilled || "";
  });
  State.csvItems = rows;
  State.itemsByTopicWeek = {};
  rows.forEach(r => {
    const key = `${String(r.topic).toLowerCase()}|${r.week}`;
    if (!State.itemsByTopicWeek[key]) State.itemsByTopicWeek[key] = [];
    State.itemsByTopicWeek[key].push(r);
  });
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i=0;i<text.length;i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i+1] === '"') { field+='"'; i++; } else { inQuotes = false; } }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") {}
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.length && r.some(x=>x!=="")).map(r => {
    const o = {}; header.forEach((h,i)=>o[h.trim()] = (r[i] ?? "")); return o;
  });
}

function initLanding() {
  $("#startBtn").addEventListener("click", startSession);
  // Enter to start anywhere on landing
  document.addEventListener("keydown", (e)=>{
    if ($("#landing") && !$("#landing").classList.contains("hidden") && e.key === "Enter") {
      startSession();
    }
  });
}

function startSession() {
  const student = $("#student").value.trim();
  const week = Number($("#week").value);
  const warn = $("#landingWarn");
  warn.style.display = "none";
  if (!/^[0-9]{8}$/.test(student)) { warn.textContent="Enter an 8-digit student number."; warn.style.display="block"; return; }
  if (!CONFIG.WEEK_TOPICS[week]?.length) { toast("Select a valid week."); return; }
  State.studentNumber = student;
  State.week = week;
  State.topicsQueue = CONFIG.WEEK_TOPICS[week].slice();
  State.startTime = nowISO();
  State.trials = [];
  State.trialIndex = 0;
  State.attemptNumber = 1;
  showWeekIntro();
}

function showWeekIntro() {
  // Build prediction prompt per current topic to be shown on topic intro instead; but the user wants it before each quiz.
  // We'll collect prediction here per upcoming topic when we enter topicIntro; for now show a neutral screen.
  show("#weekIntro");
  setText("#predictPrompt", "Predict how many you will get correct (1–10).");
  // Build buttons 1..10
  const wrap = $("#predictBtns"); wrap.innerHTML = "";
  for (let i=1;i<=10;i++){
    const b=document.createElement("button");
    b.textContent=String(i);
    b.onclick=()=>{
      State.metaEstimate = i;
      $("#beginWeekBtn").disabled=false;
      $("#predictWarn").style.display="none";
      [...wrap.children].forEach(ch=>{ ch.classList.remove("active"); ch.classList.remove("btn-ok"); ch.classList.remove("btn-bad"); });
      b.classList.add("active"); b.classList.add("btn-ok");
    };
    wrap.appendChild(b);
  }
  const onKey=(e)=>{
    if (e.key==="Enter"){
      if (State.metaEstimate==null){ const w=$("#predictWarn"); w.textContent="Please select a number."; w.style.display="block"; }
      else { cleanup(); nextTopic(); }
    }
  };
  const cleanup=()=>document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  $("#beginWeekBtn").onclick=()=>{
    if (State.metaEstimate==null){ const w=$("#predictWarn"); w.textContent="Please select a number."; w.style.display="block"; return; }
    cleanup(); nextTopic();
  };
}

function nextTopic() {
  if (!State.topicsQueue.length) { return showSummary(); }
  State.currentTopic = State.topicsQueue.shift();
  State.masteryGoal = CONFIG.MASTERY_REQUIRED[State.currentTopic] || 1;
  if (State.currentTopic === "inorganic" && State.week === 12) State.masteryGoal = 4;
  showTopicIntro();
}

function showTopicIntro() {
  setText("#topicTitle", CONFIG.TOPIC_LABELS[State.currentTopic]);
  setText("#topicDesc", State.currentTopic === "inorganic" && State.week === 12
    ? "You will practice Inorganic Nomenclature. Each item must be answered correctly four times in total to achieve mastery."
    : "You will practice this topic until you master all items at least once.");
  show("#topicIntro");

  // Topic intro requires no extra action; enable Start once we enter
  const btn=$("#beginTopicBtn"); btn.disabled=false;
  const onKey=(e)=>{ if (e.key==="Enter"){ cleanup(); prepareTrialsForTopic(State.currentTopic); } };
  const cleanup=()=>document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  btn.onclick=()=>{ cleanup(); prepareTrialsForTopic(State.currentTopic); };
}

function prepareTrialsForTopic(topic) {
  const key = `${topic}|${State.week}`;
  const items = (State.itemsByTopicWeek[key] || []).slice();
  if (!items.length) { toast("No items found for topic/week."); return nextTopic(); }
  // record meta estimate as a special row
  if (State.metaEstimate != null){
    State.trials.push({
      trial_index: ++State.trialIndex,
      id: "meta_estimate",
      topic: topic,
      week: State.week,
      phase: "meta",
      attempt: 0,
      q_type: "",
      rt_ms: 0,
      answer_raw: String(State.metaEstimate),
      answer_norm: String(State.metaEstimate),
      correct: "",
      ts: nowISO(),
    });
    State.metaEstimate = null; // reset so next topic can ask again
  }

  if (State.masteryGoal > 1) { State.correctCounts.clear(); items.forEach(it => State.correctCounts.set(it.id, 0)); }

  State.firstPass = shuffle(items);
  State.fpIndex = 0;
  State.masteryPool = [];
  State.fpCorrectCount = 0;
  State.fpToRetryCount = 0;
  State.attemptNumber = 1;
  presentItem(State.firstPass[State.fpIndex], "first_pass");
}

function labelForType(q_type){
  if (String(q_type).toLowerCase()==="fill") return "Fill in the Blank";
  return "Give the correct IUPAC name of the following molecule";
}

function presentItem(item, phase) {
  setImage("#qImage", item.image);
  setText("#answerLabel", labelForType(item.q_type));
  $("#answer").value = "";
  const fillPrompt = document.getElementById("fillPrompt");
  if (String(item.q_type).toLowerCase()==="fill" && item.unfilled) {
    fillPrompt.style.display="block";
    fillPrompt.textContent = item.unfilled; // e.g., "2-______pentane"
  } else {
    fillPrompt.style.display="none";
    fillPrompt.textContent = "";
  }

  $("#trialWarn").style.display="none";
  $("#inlineFeedback").style.display="none";
  $("#countdown").textContent="";
  $("#answer").focus();
  show("#trial");

  const t0 = performance.now();
  const submitBtn=$("#submitBtn");
  submitBtn.classList.remove("btn-ok","active","btn-bad");
  submitBtn.disabled=false;

  const onKey = (e)=>{ if (e.key === "Enter") { e.preventDefault(); submit(); } };
  document.addEventListener("keydown", onKey);
  $("#submitBtn").onclick = submit;

  function submit() {
    const raw = $("#answer").value;
    if (String(raw).trim()===""){
      const w=$("#trialWarn"); w.textContent="Please enter an answer"; w.style.display="block";
      return;
    }
    document.removeEventListener("keydown", onKey);
    submitBtn.disabled=true;
    const norm = normalizeAnswer(raw).slice(0, CONFIG.MAX_ANSWER_LEN);
    const ok = item.acceptable.has(norm);
    const rt = Math.max(0, Math.round(performance.now() - t0));

    State.trials.push({
      trial_index: ++State.trialIndex,
      id: item.id,
      topic: State.currentTopic,
      week: State.week,
      phase,
      attempt: State.attemptNumber,
      q_type: item.q_type || "",
      rt_ms: rt,
      answer_raw: raw,
      answer_norm: norm,
      correct: ok ? 1 : 0,
      ts: nowISO(),
    });

    if (phase === "first_pass") {
      if (ok) State.fpCorrectCount++;
      else State.fpToRetryCount++;
    }

    if (ok && State.masteryGoal > 1) {
      const cur = State.correctCounts.get(item.id) ?? 0;
      State.correctCounts.set(item.id, cur + 1);
    }

    // Inline feedback
    $("#inlineFeedback").style.display="block";
    setText("#fbYour", raw);
    const preferred = item.acceptableList[0] || "(no key)";
    setText("#fbCorrect", preferred);
    const fpEl = document.getElementById("fillPrompt");
    if (fpEl && fpEl.style.display!=="none") {
      fpEl.textContent = fpEl.textContent.replace("______", preferred);
    }
    if (item.acceptableList.length > 1){
      const alts = item.acceptableList.join(", ");
      const altDiv=$("#altAnswers");
      altDiv.textContent = `Alternative answers: ${alts}`;
      altDiv.style.display="block";
    } else {
      $("#altAnswers").style.display="none";
    }

    // Button visuals, sound, vibration
    if (ok){
      submitBtn.textContent="Correct ✅";
      submitBtn.classList.add("btn-ok","active");
      try { $("#sndOk").play(); } catch{}
    } else {
      submitBtn.textContent="Incorrect ❗";
      submitBtn.classList.add("btn-bad","active");
      try { $("#sndBad").play(); } catch{}
      if (navigator.vibrate) navigator.vibrate([50,30,50]);
    }

    // Confetti on correct
    if (ok) confettiBurst();

    // Countdown 3..1 then advance
    startCountdown(()=>{
      const lastPhase = phase;
      if (lastPhase === "mastery") return advanceAfterMasteryFeedback();
      return advanceFlow();
    });
  }
}

function startCountdown(done){
  const label=$("#countdown");
  let t=3;
  label.textContent = `Continuing in ${t}…`;
  const id=setInterval(()=>{
    t--; if (t<=0){ clearInterval(id); label.textContent=""; done(); }
    else label.textContent = `Continuing in ${t}…`;
  }, 1000);
}

function confettiBurst(){
  const cvs = $("#confetti");
  if (!cvs) return;
  const ctx = cvs.getContext("2d");
  const w = cvs.width, h = cvs.height;
  const pieces = Array.from({length:60}, ()=>({x:Math.random()*w,y:-10,vy:2+Math.random()*3,rx:Math.random()*6.28,vr:0.1+Math.random()*0.2,w:4+Math.random()*4,h:8+Math.random()*8}));
  const colors = ["#11b66a","#3a80ff","#f2c94c","#eb5757","#bb6bd9"];
  let frames=0;
  function tick(){
    frames++;
    ctx.clearRect(0,0,w,h);
    pieces.forEach(p=>{
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rx);
      ctx.fillStyle = colors[Math.floor(Math.random()*colors.length)];
      ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      ctx.restore();
      p.y += p.vy; p.rx += p.vr;
    });
    if (frames<45) requestAnimationFrame(tick);
    else ctx.clearRect(0,0,w,h);
  }
  tick();
}

function showFeedbackInline(){ /* replaced by inline logic above */ }

function advanceFlow() {
  if (State.fpIndex < State.firstPass.length - 1) {
    State.fpIndex++;
    return presentItem(State.firstPass[State.fpIndex], "first_pass");
  }
  // Build mastery pool
  if (State.masteryGoal > 1) {
    State.masteryPool = State.firstPass.filter(it => (State.correctCounts.get(it.id) || 0) < State.masteryGoal);
  } else {
    const missedIds = new Set(State.trials.filter(t => t.phase === "first_pass" && !t.correct && t.topic === State.currentTopic).map(t => t.id));
    State.masteryPool = State.firstPass.filter(it => missedIds.has(it.id));
  }

  // Attempt 1 summary
  setText("#attemptTitle", "Attempt 1 summary");
  setText("#attemptStats", `total correct = ${State.fpCorrectCount}/${State.firstPass.length}`);
  const toRetry = State.masteryPool.length;
  if (toRetry===0){
    setText("#attemptNext", "All correct — great job!");
    show("#fpSummary");
    const onKey=(e)=>{ if (e.key==="Enter"){ cleanup(); nextTopic(); } };
    const cleanup=()=>document.removeEventListener("keydown", onKey);
    document.addEventListener("keydown", onKey);
    $("#beginMasteryBtn").onclick=()=>{ cleanup(); nextTopic(); };
    return;
  } else {
    setText("#attemptNext", `To re-attempt: ${toRetry}`);
  }
  show("#fpSummary");
  const onKey=(e)=>{ if (e.key==="Enter"){ cleanup(); startMasteryLoop(); } };
  const cleanup=()=>document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  $("#beginMasteryBtn").onclick=()=>{ cleanup(); startMasteryLoop(); };
}

function startMasteryLoop() {
  if (!State.masteryPool.length) return nextTopic();
  State.attemptNumber = 2;
  State.masteryPool = shuffle(State.masteryPool);
  State.masteryIndex = 0;
  presentMastery(State.masteryPool[State.masteryIndex]);
}

function presentMastery(item) {
  setImage("#qImage", item.image);
  setText("#answerLabel", labelForType(item.q_type));
  $("#answer").value = "";
  const fillPrompt = document.getElementById("fillPrompt");
  if (String(item.q_type).toLowerCase()==="fill" && item.unfilled) {
    fillPrompt.style.display="block";
    fillPrompt.textContent = item.unfilled; // e.g., "2-______pentane"
  } else {
    fillPrompt.style.display="none";
    fillPrompt.textContent = "";
  }
  $("#trialWarn").style.display="none";
  $("#inlineFeedback").style.display="none";
  $("#countdown").textContent="";
  $("#answer").focus();
  show("#trial");
  const t0 = performance.now();

  const submitBtn=$("#submitBtn");
  submitBtn.classList.remove("btn-ok","active","btn-bad");
  submitBtn.disabled=false;
  submitBtn.textContent = "Submit";


  const onKey = (e)=>{ if (e.key === "Enter") { e.preventDefault(); submit(); } };
  document.addEventListener("keydown", onKey);
  $("#submitBtn").onclick = submit;

  function submit() {
    const raw = $("#answer").value;
    if (String(raw).trim()===""){
      const w=$("#trialWarn"); w.textContent="Please enter an answer"; w.style.display="block";
      return;
    }
    document.removeEventListener("keydown", onKey);
    submitBtn.disabled=true;
    const norm = normalizeAnswer(raw).slice(0, CONFIG.MAX_ANSWER_LEN);
    const ok = item.acceptable.has(norm);
    const rt = Math.max(0, Math.round(performance.now() - t0));

    State.trials.push({
      trial_index: ++State.trialIndex,
      id: item.id,
      topic: State.currentTopic,
      week: State.week,
      phase: "mastery",
      attempt: State.attemptNumber,
      q_type: item.q_type || "",
      rt_ms: rt,
      answer_raw: raw,
      answer_norm: norm,
      correct: ok ? 1 : 0,
      ts: nowISO(),
    });

    if (ok) {
      if (State.masteryGoal > 1) {
        const cur = State.correctCounts.get(item.id) ?? 0;
        const next = cur + 1;
        State.correctCounts.set(item.id, next);
        if (next >= State.masteryGoal) {
          State.masteryPool = State.masteryPool.filter(it => it.id !== item.id);
        }
      } else {
        State.masteryPool = State.masteryPool.filter(it => it.id !== item.id);
      }
    }

    // Inline feedback
    $("#inlineFeedback").style.display="block";
    setText("#fbYour", raw);
    const preferred = item.acceptableList[0] || "(no key)";
    setText("#fbCorrect", preferred);
    const fpEl = document.getElementById("fillPrompt");
    if (fpEl && fpEl.style.display!=="none") {
      fpEl.textContent = fpEl.textContent.replace("______", preferred);
    }
    if (item.acceptableList.length > 1){
      const alts = item.acceptableList.join(", ");
      const altDiv=$("#altAnswers");
      altDiv.textContent = `Alternative answers: ${alts}`;
      altDiv.style.display="block";
    } else {
      $("#altAnswers").style.display="none";
    }

    if (ok){
      submitBtn.textContent="Correct ✅";
      submitBtn.classList.add("btn-ok","active");
      try { $("#sndOk").play(); } catch{}
    } else {
      submitBtn.textContent="Incorrect ❗";
      submitBtn.classList.add("btn-bad","active");
      try { $("#sndBad").play(); } catch{}
      if (navigator.vibrate) navigator.vibrate([50,30,50]);
    }
    if (ok) confettiBurst();

    startCountdown(()=> advanceAfterMasteryFeedback());
  }
}

function advanceAfterMasteryFeedback() {
  // If pool empty → topic done or start another sweep
  if (!State.masteryPool.length) {
    // finished mastery → next topic
    return nextTopic();
  }
  // Continue current sweep
  State.masteryIndex++;
  if (State.masteryIndex >= State.masteryPool.length) {
    // end of sweep → summarize and, if needed, continue Attempt 3,4...
    const len = State.masteryPool.length;
    const attempted = State.trials.filter(t => t.topic===State.currentTopic && t.phase==="mastery" && t.attempt===State.attemptNumber).length;
    const correctThisAttempt = State.trials.filter(t => t.topic===State.currentTopic && t.phase==="mastery" && t.attempt===State.attemptNumber && t.correct===1).length;
    setText("#attemptTitle", `Attempt ${State.attemptNumber} summary`);
    setText("#attemptStats", `total correct = ${correctThisAttempt}/${attempted}`);
    setText("#attemptNext", len ? `To re-attempt: ${len}` : "All correct — great job!");
    show("#fpSummary");
    const onKey=(e)=>{ if (e.key==="Enter"){ cleanup(); proceed(); } };
    const cleanup=()=>document.removeEventListener("keydown", onKey);
    const proceed=()=>{
      if (!State.masteryPool.length) return nextTopic();
      State.attemptNumber++;
      State.masteryPool = shuffle(State.masteryPool);
      State.masteryIndex = 0;
      presentMastery(State.masteryPool[State.masteryIndex]);
    };
    document.addEventListener("keydown", onKey);
    $("#beginMasteryBtn").onclick=()=>{ cleanup(); proceed(); };
    return;
  }
  presentMastery(State.masteryPool[State.masteryIndex]);
}

function showSummary() {
  show("#summary");
  // Auto-upload once; button serves as retry/status
  autoUploadOnce();
  $("#submitResultsBtn").onclick = autoUploadOnce;
}


let uploadedOnce = false;
async function autoUploadOnce() {
  if (uploadedOnce) return;
  const btn = $("#submitResultsBtn");
  btn.disabled = true;
  $("#uploadStatus").textContent = "Uploading…";

  const payload = {
    student_number: State.studentNumber,
    week: State.week,
    topics_run: CONFIG.WEEK_TOPICS[State.week] || [],
    started_at: State.startTime,
    completed_at: nowISO(),
    device: State.device,
    trials: State.trials,
  };

  // Choose endpoint: dev or prod
  let url = "/api/ingest";
  if (location.hostname.endsWith(".pages.dev")) {
    url = CONFIG.WORKER_FALLBACK_URL; // must be set
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    const ok = res.ok;
    const text = await res.text();
    if (!ok) throw new Error(text || String(res.status));

    uploadedOnce = true;
    $("#uploadStatus").textContent = "Upload recorded (or already exists).";
    btn.disabled = true;
    setTimeout(()=>show("#thankyou"), 700);
  } catch (err) {
    console.error(err);
    $("#uploadStatus").textContent = "Upload failed. Click the button to retry.";
    btn.disabled = false;
  }
}

window.addEventListener("load", async () => {
  try { await loadCSV(); } catch (e) { console.error(e); toast("CSV failed to load. Ensure items.csv is in the same folder."); }
  initLanding();
  show("#landing");
});

