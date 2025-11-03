/* Big update per user's spec: inline feedback, meta-comprehension, dev uploads, week/topic changes */

let lastView = "#landing"; 

const CONFIG = {
  CSV_URL: "items.csv",
  FEEDBACK_MS: 5000, // 5 sec with visible countdown
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
    11: ["inorganic"],    // massed practice (40 items)
    12: ["inorganic"],    // post-test (10 higher-order)
  },
  TOPIC_LABELS: {
    organic: "Organic Nomenclature",
    inorganic: "Inorganic Nomenclature"
  },
  MASTERY_REQUIRED: {
    organic: 1,
    inorganic: 1 // inorganic gets goal 4 if week=12
  },
  CONFETTI: {
    PIECES: 100,
    SPEED: 1.5,
    GRAVITY: 0.06,
    DURATION_FRAMES: 120
  },

  // === NEW: course timezone + week windows ===
  COURSE_TZ: "America/Toronto",
  WEEK_SCHEDULE: {
    // End dates are exclusive
    6:  { start: "2025-10-06", end: "2025-10-13" },
    7:  { start: "2025-10-13", end: "2025-10-20" },
    8:  { start: "2025-10-20", end: "2025-10-27" },
    9:  { start: "2025-10-27", end: "2025-11-03" },
    10: { start: "2025-11-03", end: "2025-11-10" },
    11: { start: "2025-11-10", end: "2025-11-17" },
    12: { start: "2025-11-17", end: "2025-11-24" }
  },

NO_RETRY_WEEKS: [], // no mastery/retries in Week 12


  // === CHANGE: make this the BASE url (no /api/ingest here) ===
  WORKER_FALLBACK_URL: "https://srp-results-worker.rjmaligaya.workers.dev",
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

// Extra state for repeat detection / timezone
State.userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
State.reattemptMode = false; // toggled true when student chooses "do it anyway"

// Track current "session" and pending cleanups/timers
State.session = 0;
State.cleanups = new Set();

function addCleanup(fn) { if (typeof fn === "function") State.cleanups.add(fn); }
function runCleanups() {
  for (const fn of State.cleanups) {
    try { fn(); } catch {}
  }
  State.cleanups.clear();
}


// Detect mobile once and tag <html>
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 768;
if (isMobile) document.documentElement.classList.add("mobile");

if (isMobile) {
  // Prevent any HTML-level autofocus from triggering keyboards
  document.querySelectorAll("[autofocus], [data-autofocus]").forEach(el => {
    el.removeAttribute("autofocus");
    el.removeAttribute("data-autofocus");
  });
  // If something already focused, blur it
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
}


// Turn off keyboard-driven layout changes
const ENABLE_KB_ADJUST = false;

// Keyboard-aware class (disabled unless toggle is true)
if (ENABLE_KB_ADJUST) {
  (function (){
    let kbTimer = null;
    const isTextField = el => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

    document.addEventListener("focusin", (e) => {
      if (isMobile && isTextField(e.target)) {
        clearTimeout(kbTimer);
        kbTimer = setTimeout(() => document.documentElement.classList.add("kbd-open"), 100);
      }
    }, true);

    document.addEventListener("focusout", (e) => {
      if (isMobile && isTextField(e.target)) {
        clearTimeout(kbTimer);
        kbTimer = setTimeout(() => document.documentElement.classList.remove("kbd-open"), 150);
      }
    }, true);
  })();
}


// Keyboard-aware class without fighting scrolling (works nicer on iOS/Android)
(function (){
  let kbTimer = null;
  const isTextField = el => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

  document.addEventListener("focusin", (e) => {
    if (isMobile && isTextField(e.target)) {
      // add a small delay so the browser can place the caret before we tweak layout
      clearTimeout(kbTimer);
      kbTimer = setTimeout(() => document.documentElement.classList.add("kbd-open"), 100);
    }
  }, true);

  document.addEventListener("focusout", (e) => {
    if (isMobile && isTextField(e.target)) {
      // remove the class shortly after blur so normal layout returns
      clearTimeout(kbTimer);
      kbTimer = setTimeout(() => document.documentElement.classList.remove("kbd-open"), 150);
    }
  }, true);
})();

function resetAndGoHome() {
  goHome(); // already does runCleanups() + State.session++ + resets + show("#landing")
}

// Topbar: Home + Instructions
function attachTopbar() {
  const bounceAnd = (el, fn) => {
    if (!el) return;
    rePop(el);
    const sid = State.session;
    setTimeout(() => { if (sid !== State.session) return; fn(); }, 400);
  };

  const home = document.getElementById("homeBtn");
  const instr = document.getElementById("instrBtn");
  const back  = document.getElementById("backFromInstr");

  if (home) home.onclick = () => bounceAnd(home, resetAndGoHome);
  if (instr) instr.onclick = () => bounceAnd(instr, () => {goHome(); show("#instructions"); });
  if (back)  back.onclick  = () => bounceAnd(back,  resetAndGoHome);
}


function goHome() {
  // cancel any active listeners/timers from prior views
  runCleanups();
  State.session++; // invalidate in-flight callbacks

  // soft reset
  State.week = null;
  State.topicsQueue = [];
  State.currentTopic = null;
  State.masteryGoal = 1;
  State.firstPass = [];
  State.fpIndex = 0;
  State.masteryPool = [];
  State.masteryIndex = 0;
  State.correctCounts.clear();
  State.trials = [];
  State.trialIndex = 0;
  State.attemptNumber = 1;
  State.metaEstimate = null;

  // clear inputs
  const s = document.getElementById("student");
  const w = document.getElementById("week");
  if (s) s.value = "";
  if (w) w.value = "6";

  // remove full-screen confetti canvas if present
  const conf = document.getElementById("confettiFull");
  if (conf && conf.parentNode) conf.parentNode.removeChild(conf);

  try { const a = $("#sndOk"); a.pause(); a.currentTime = 0; } catch {}
  try { const b = $("#sndBad"); b.pause(); b.currentTime = 0; } catch {}

  show("#landing");
}


function showInstructions() {
  // Ensure the iframe is pointed at your pdf (already is by default)
  const f = document.getElementById("instrFrame");
  if (f && !f.src) f.src = "instructions.pdf";
  show("#instructions");
}


// DOM helpers
function $(sel) { return document.querySelector(sel); }

function show(sel) {
  // whenever we swap views, clear old listeners/timers
  runCleanups();
  document.querySelectorAll("button.pop, button.shake").forEach(b => {
  b.classList.remove("pop", "shake");
});

// record current visible view before switching
  const current = document.querySelector(".view:not(.hidden)");
  if (current && current.id) lastView = `#${current.id}`;


  document.querySelectorAll(".view").forEach(n => n.classList.add("hidden"));
  const view = document.querySelector(sel);
  view.classList.remove("hidden");
  // 👇 Only auto-focus on desktop / non-mobile
  if (!isMobile) {
    requestAnimationFrame(() => {
      const target = view.querySelector("[data-autofocus]") || view.querySelector("input, textarea, select");
      if (target && typeof target.focus === "function") target.focus({ preventScroll:true });
    });
  }
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

// ===== Week schedule / timezone helpers =====
function toZonedDate(d, tz){
  try {
    const fmt = new Intl.DateTimeFormat(tz, {
      year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    });
    const parts = fmt.formatToParts(d);
    const get = (t)=>Number(parts.find(p=>p.type===t).value);
    // Construct a Date interpreted in local machine time (fine for comparisons)
    return new Date(get("year"), get("month")-1, get("day"), get("hour"), get("minute"), get("second"));
  } catch { return d; }
}
function parseYMD(ymd, tz){
  const [y,m,d] = ymd.split("-").map(Number);
  const local = new Date(y, m-1, d, 0,0,0);
  return toZonedDate(local, tz);
}
function todayInTZ(tz){
  const now = new Date();
  const z = toZonedDate(now, tz);
  return new Date(z.getFullYear(), z.getMonth(), z.getDate(), 0,0,0);
}
function weekFromDate(d, schedule, tz){
  const t = d.getTime();
  for (const wk of Object.keys(schedule)){
    const { start, end } = schedule[wk];
    const s = parseYMD(start, tz).getTime();
    const e = parseYMD(end, tz).getTime();
    if (t >= s && t < e) return Number(wk);
  }
  return null;
}
function lockWeekOptions(){
  const tz = CONFIG.COURSE_TZ;
  const today = todayInTZ(tz);
  const currentWk = weekFromDate(today, CONFIG.WEEK_SCHEDULE, tz);
  const sel = $("#week");
  const note = $("#weekNote");
  const tzInfo = $("#tzInfo");
  if (tzInfo) tzInfo.textContent = `Detected timezone: ${State.userTimeZone}. Course timezone: ${CONFIG.COURSE_TZ}.`;

  if (!sel) return;

  // Disable future weeks (start > today)
  Array.from(sel.options).forEach(opt=>{
    const wk = Number(opt.value);
    const start = parseYMD(CONFIG.WEEK_SCHEDULE[wk].start, CONFIG.COURSE_TZ);
    if (start.getTime() > today.getTime()) {
      opt.disabled = true; 
      if (!/locked until/.test(opt.textContent)) opt.textContent += " (locked until start)";
    }
  });

  // Auto-select current week if open; else last open week
  if (currentWk && !sel.querySelector(`option[value="${currentWk}"]`)?.disabled) {
    sel.value = String(currentWk);
    if (note) note.textContent = `(auto-selected for ${CONFIG.COURSE_TZ})`;
  } else {
    let pick = null, maxStart = -Infinity;
    for (const wk of Object.keys(CONFIG.WEEK_SCHEDULE)){
      const start = parseYMD(CONFIG.WEEK_SCHEDULE[wk].start, CONFIG.COURSE_TZ).getTime();
      if (start <= today.getTime() && start > maxStart) { maxStart = start; pick = wk; }
    }
    if (pick) { sel.value = String(pick); if (note) note.textContent = `(latest available)`; }
  }
}


function initLanding() {
  // Click on Begin
  $("#startBtn").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn) rePop(btn);
    const sid = State.session;
    setTimeout(() => { if (sid !== State.session) return; startSession(); }, 400);
  });

  // Enter to start anywhere on landing
  const onKey = (e) => {
    if ($("#landing") && !$("#landing").classList.contains("hidden") && e.key === "Enter") {
      const start = $("#startBtn");
      if (start) rePop(start);
      const sid = State.session;
      setTimeout(() => { if (sid !== State.session) return; startSession(); }, 400);
    }
  };
  document.addEventListener("keydown", onKey);
  addCleanup(() => document.removeEventListener("keydown", onKey));
}


async function startSession() {
  runCleanups();     // clear any leftovers just in case
  State.session++;   // new session; invalidate old timers

  const student = $("#student").value.trim();
  const week = Number($("#week").value);
  const warn = $("#landingWarn");
  warn.style.display = "none";
  if (!/^[0-9]{8}$/.test(student)) { warn.textContent="Enter an 8-digit student number."; warn.style.display="block"; return; }
  if (!CONFIG.WEEK_TOPICS[week]?.length) { toast("Select a valid week."); return; }

  State.studentNumber = student;
  State.week = week;
  State.reattemptMode = false;

  // === NEW: preflight status query to worker ===
  try {
    const base = location.hostname.endsWith(".pages.dev") ? CONFIG.WORKER_FALLBACK_URL : "";
    const url = `${base}/api/status?sn=${encodeURIComponent(student)}&week=${encodeURIComponent(week)}`;
    const res = await fetch(url, { method: "GET", cache:"no-store" });
    if (res.ok){
      const data = await res.json();
      if (data.exists){
        // Show warning screen with recommended next time
        const msg = $("#repeatMsg");
        const nextDue = $("#nextDue");
        const when = data.completed_at || data.uploaded_at || "";
        let nextStr = "";
        if (when){
          const next = new Date(new Date(when).getTime() + 7*24*60*60*1000);
          try {
            const fmt = new Intl.DateTimeFormat(State.userTimeZone, { dateStyle:"full", timeStyle:"short" });
            nextStr = fmt.format(next);
          } catch { nextStr = next.toString(); }
        }
        if (nextStr) nextDue.textContent = `Recommended next attempt after: ${nextStr}`;
        else nextDue.textContent = "";

        show("#repeatWarn");
        $("#doReattemptBtn").onclick = ()=>{ State.reattemptMode = true; proceedAfterPreflight(); };
        $("#cancelReattemptBtn").onclick = ()=>{ State.reattemptMode = false; goHome(); };
        return; // stop here, user must choose
      }
    }
  } catch (e) {
    console.error("status preflight failed", e); // proceed silently
  }

  proceedAfterPreflight();
}


function proceedAfterPreflight(){
  State.topicsQueue = CONFIG.WEEK_TOPICS[State.week].slice();
  State.startTime = nowISO();
  State.trials = [];
  State.trialIndex = 0;
  State.attemptNumber = 1;
  showWeekIntro();
}


function showWeekIntro() {
  show("#weekIntro");

  const isW11 = (State.week === 11);
  const isW12 = (State.week === 12);
  const itemCount = isW11 ? 40 : (isW12 ? 10 : 10); // default 10, 40 only for Week 11
  const subject = (State.week >= 11) ? "INORGANIC nomenclature" : "IUPAC nomenclature";

  // Set the summary + meta lines
  setText("#weekIntroSummary",
    isW11
      ? `You are going to be asked ${itemCount} ${subject} questions.`
      : `You are going to be asked ${itemCount} questions about ${subject}.`
  );

  setText("#weekIntroMeta",
    isW11
      ? "Predict how many you will get correct (0–40)."
      : "Predict how many you will get correct (1–10)."
  );

  // Build metacognition UI
  const wrap = $("#predictWrap");
  const btnRow = $("#predictBtns");
  const input = $("#predictInput");
  const warnP = $("#predictWarn");
  btnRow.innerHTML = "";
  warnP.style.display = "none";

  if (isW11) {
    // Text-entry (0..40)
    btnRow.style.display = "none";
    input.style.display = "block";
    input.value = "";
    input.focus && input.focus();

    const validateAndSet = () => {
      const n = Number(input.value);
      if (Number.isFinite(n) && n >= 0 && n <= 40) {
        State.metaEstimate = n;
        $("#beginWeekBtn").disabled = false;
        warnP.style.display = "none";
      } else {
        State.metaEstimate = null;
        $("#beginWeekBtn").disabled = true;
      }
    };

    input.oninput = validateAndSet;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); validateAndSet(); if (!$("#beginWeekBtn").disabled) proceed(); } };
  } else {
    // Buttons 1..10
    btnRow.style.display = "flex";
    input.style.display = "none";
    for (let i = 1; i <= 10; i++) {
      const b = document.createElement("button");
      b.textContent = String(i);
      b.onclick = () => {
        State.metaEstimate = i;
        $("#beginWeekBtn").disabled = false;
        warnP.style.display = "none";
        [...btnRow.children].forEach(ch => ch.classList.remove("active", "btn-ok", "btn-bad"));
        b.classList.add("active", "btn-ok");
      };
      btnRow.appendChild(b);
    }
  }

  const btn = $("#beginWeekBtn");

  const proceed = () => {
    if (State.metaEstimate == null) {
      warnP.textContent = isW11 ? "Please enter a number between 0 and 40." : "Please select a number.";
      warnP.style.display = "block";
      return;
    }
    if (btn) rePop(btn);
    const sid = State.session;
    setTimeout(() => {
      if (sid !== State.session) return;
      cleanup();
      nextTopic();
    }, 400);
  };

  const onKey = (e) => { if (e.key === "Enter" && !isW11) proceed(); };
  const cleanup = () => { document.removeEventListener("keydown", onKey); };

  document.addEventListener("keydown", onKey);
  addCleanup(() => document.removeEventListener("keydown", onKey));
  btn.onclick = proceed;

  // Inline instructions toggle unchanged...
  const toggle = $("#toggleInlineInstr");
  const panel  = $("#inlineInstr");
  if (toggle && panel) {
    toggle.onclick = () => {
      const open = panel.classList.toggle("open");
      if (open) { panel.hidden = false; }
      requestAnimationFrame(() => panel.classList.toggle("open", open));
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide instructions" : "Show instructions";
      if (!open) panel.addEventListener("transitionend", () => { panel.hidden = true; }, { once: true });
    };
  }
}




function nextTopic() {
  if (!State.topicsQueue.length) { return showSummary(); }
  State.currentTopic = State.topicsQueue.shift();
  State.masteryGoal = CONFIG.MASTERY_REQUIRED[State.currentTopic] || 1;
  showTopicIntro();
}

function showTopicIntro() {
  const subject = CONFIG.TOPIC_LABELS[State.currentTopic] || "This topic";

  setText("#topicTitle", subject);
  const desc = "You will practice this topic until you master all items at least once.";
  setText("#topicDesc", desc);

  show("#topicIntro");

  const btn = $("#beginTopicBtn");
  btn.disabled = false;

  const onKey = (e) => {
    if (e.key === "Enter") {
      rePop(btn);
      const sid = State.session;
      setTimeout(() => {
        if (sid !== State.session) return;
        cleanup();
        prepareTrialsForTopic(State.currentTopic);
      }, 400);
    }
  };
  const cleanup = () => document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  addCleanup(() => document.removeEventListener("keydown", onKey));

  btn.onclick = () => {
    rePop(btn);
    const sid = State.session;
    setTimeout(() => {
      if (sid !== State.session) return;
      cleanup();
      prepareTrialsForTopic(State.currentTopic);
    }, 400);
  };
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

function rePop(el){
  try {
    el.classList.remove("pop");
    void el.offsetWidth;              // restart animation
    el.classList.add("pop");
    const onEnd = () => { el.classList.remove("pop"); };
    el.addEventListener("animationend", onEnd, { once: true });
  } catch {}
}


function shakeEl(el){
  try {
    // stop any active bounce first so the shake shows
    el.classList.remove("pop");
    void el.offsetWidth;             // reflow to reset animations
    el.classList.add("shake");
    el.addEventListener("animationend", () => {
      el.classList.remove("shake");
    }, { once: true });
  } catch {}
}

// Global bounce for any button click (mouse/touch/spacebar-enter on focused button)
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest && e.target.closest("button");
  if (b) rePop(b);
});


function presentItem(item, phase) {
  const sid = State.session;
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
  // 👇 show first
  show("#trial");

  // 👇 only auto-focus on desktop
  if (!isMobile) {
    requestAnimationFrame(() => {
      const ans = $("#answer");
      if (ans && typeof ans.focus === "function") {
        ans.focus({ preventScroll: true });
      }
    });
  }

  const t0 = performance.now();
  const submitBtn=$("#submitBtn");
  submitBtn.classList.remove("btn-ok","active","btn-bad");
  submitBtn.disabled=false;
  submitBtn.textContent = "Submit";

  const onKey = (e)=>{ if (e.key === "Enter") { e.preventDefault(); submit(); } };
  document.addEventListener("keydown", onKey);
  addCleanup(() => document.removeEventListener("keydown", onKey));
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
      submitBtn.textContent="Correct 🥳"; rePop(submitBtn);
      submitBtn.classList.add("btn-ok","active");
      try { $("#sndOk").play(); } catch{}
    } else {
      submitBtn.textContent="Incorrect 😢"; rePop(submitBtn);
      submitBtn.classList.add("btn-bad","active");
      try { $("#sndBad").play(); } catch{}
      try { if (typeof navigator.vibrate==="function") navigator.vibrate([140,80,140,80,140]); } catch{}
      // Add a shake animation on wrong answers
      shakeEl(submitBtn);
    }

    // Confetti on correct
    if (ok) confettiFrom(submitBtn);
    

    // Countdown 3..1 then advance
    startCountdown(()=>{
      const lastPhase = phase;
      if (lastPhase === "mastery") return advanceAfterMasteryFeedback();
      return advanceFlow();
    });
  }
}

function startCountdown(done){
  const sid = State.session;
  const label = $("#countdown");
  let t = Math.max(1, Math.round(CONFIG.FEEDBACK_MS/1000));
  label.textContent = `Continuing in ${t}…`;
  const id = setInterval(() => {
    if (sid !== State.session) { clearInterval(id); return; } // session changed; stop
    t--;
    if (t <= 0) {
      clearInterval(id);
      label.textContent = "";
      // only run 'done' if we’re still in this session
      if (sid === State.session) done();
      return;
    }
    label.textContent = `Continuing in ${t}…`;
  }, 1000);

  // ensure we clear it on navigation/Home
  addCleanup(() => clearInterval(id));
}


function confettiFrom(el){
  try{
    const rect = el.getBoundingClientRect();
    let cvs = document.getElementById("confettiFull");
    if (!cvs){
      cvs = document.createElement("canvas");
      cvs.id = "confettiFull";
      document.body.appendChild(cvs);
      const onresize = ()=>{ cvs.width = window.innerWidth; cvs.height = window.innerHeight; };
      window.addEventListener("resize", onresize); onresize();
      addCleanup(() => window.removeEventListener("resize", onresize));
    } else {
      cvs.width = window.innerWidth; cvs.height = window.innerHeight;
    }

    const ctx = cvs.getContext("2d");
    const { PIECES, SPEED, GRAVITY, DURATION_FRAMES } = (CONFIG.CONFETTI || {});
    const left = rect.left, top = rect.top, w = rect.width, h = rect.height;

    // create pieces along the edges of the button
    const rand = (a,b)=> a + Math.random()*(b-a);
    const pieces = Array.from({length: PIECES}, () => {
      const side = (Math.random()*4)|0; // 0=top,1=bottom,2=left,3=right
      let x, y, vx, vy;

      switch (side) {
        case 0: // top edge, shoot up
          x = left + Math.random()*w;
          y = top;
          vx = rand(-1.2, 1.2) * SPEED;
          vy = rand(-3.0, -1.6) * SPEED;
          break;
        case 1: // bottom edge, shoot down
          x = left + Math.random()*w;
          y = top + h;
          vx = rand(-1.2, 1.2) * SPEED;
          vy = rand(1.6, 3.0) * SPEED;
          break;
        case 2: // left edge, shoot left
          x = left;
          y = top + Math.random()*h;
          vx = rand(-3.0, -1.6) * SPEED;
          vy = rand(-1.2, 1.2) * SPEED;
          break;
        default: // right edge, shoot right
          x = left + w;
          y = top + Math.random()*h;
          vx = rand(1.6, 3.0) * SPEED;
          vy = rand(-1.2, 1.2) * SPEED;
          break;
      }

      return {
        x, y, vx, vy,
        gr: GRAVITY,
        rx: Math.random()*6.28,         // rotation
        vr: 0.2 + Math.random()*0.4,    // spin speed
        w: 4 + Math.random()*4,
        h: 8 + Math.random()*8,
        color: ["#11b66a","#3a80ff","#f2c94c","#eb5757","#bb6bd9"][(Math.random()*5)|0]
      };
    });

    let frames = 0;
    function tick(){
      frames++;
      ctx.clearRect(0,0,cvs.width,cvs.height);
      for (const p of pieces){
        p.vy += p.gr;         // gravity
        p.x  += p.vx;
        p.y  += p.vy;
        p.rx += p.vr;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rx);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
        ctx.restore();
      }
      if (frames < DURATION_FRAMES) {
        requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0,0,cvs.width,cvs.height);
      }
    }
    tick();
  }catch(e){}
}


function confettiBurst(){ // legacy fallback

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

  if (State.masteryGoal > 1) {
    State.masteryPool = State.firstPass.filter(it => (State.correctCounts.get(it.id) || 0) < State.masteryGoal);
  } else {
    const missedIds = new Set(State.trials.filter(t => t.phase === "first_pass" && !t.correct && t.topic === State.currentTopic).map(t => t.id));
    State.masteryPool = State.firstPass.filter(it => missedIds.has(it.id));
  }

  setText("#attemptTitle", "Attempt 1 Summary");
  const toRetry = State.masteryPool.length;
  if (toRetry===0){
    setText("#attemptNext", "All correct — great job!");
    show("#fpSummary");
    const onKey=(e)=>{ if (e.key==="Enter"){ cleanup(); nextTopic(); } };
    const cleanup=()=>document.removeEventListener("keydown", onKey);
    document.addEventListener("keydown", onKey);
    addCleanup(() => document.removeEventListener("keydown", onKey));
    $("#beginMasteryBtn").onclick=()=>{ cleanup(); nextTopic(); };
    return;
  } else {
    setText("#attemptNext", `To Re-Attempt: ${toRetry}`);
  }

  show("#fpSummary");
  const onKey=(e)=>{ if (e.key==="Enter"){ cleanup(); startMasteryLoop(); } };
  const cleanup=()=>document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  addCleanup(() => document.removeEventListener("keydown", onKey));
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
  const sid = State.session;
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
  // 👇 show first
  show("#trial");

  // 👇 only auto-focus on desktop
  if (!isMobile) {
    requestAnimationFrame(() => {
      const ans = $("#answer");
      if (ans && typeof ans.focus === "function") {
        ans.focus({ preventScroll: true });
      }
    });
  }
  const t0 = performance.now();

  const submitBtn=$("#submitBtn");
  submitBtn.classList.remove("btn-ok","active","btn-bad");
  submitBtn.disabled=false;
  submitBtn.textContent = "Submit";


  const onKey = (e)=>{ if (e.key === "Enter") { e.preventDefault(); submit(); } };
  document.addEventListener("keydown", onKey);
  addCleanup(() => document.removeEventListener("keydown", onKey));
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
      submitBtn.textContent="Correct 🥳"; rePop(submitBtn);
      submitBtn.classList.add("btn-ok","active");
      try { $("#sndOk").play(); } catch{}
    } else {
      submitBtn.textContent="Incorrect 😢"; rePop(submitBtn);
      submitBtn.classList.add("btn-bad","active");
      try { $("#sndBad").play(); } catch{}
      try { if (typeof navigator.vibrate==="function") navigator.vibrate([140,80,140,80,140]); } catch{}
      // Add a shake animation on wrong answers
      shakeEl(submitBtn);
    }
    if (ok) confettiFrom(submitBtn);

    startCountdown(()=> advanceAfterMasteryFeedback());
  }
}


function advanceAfterMasteryFeedback() {
  // If pool empty → move on
  if (!State.masteryPool.length) { return nextTopic(); }

  // Next item in current sweep
  State.masteryIndex++;
  if (State.masteryIndex >= State.masteryPool.length) {
    // End of sweep: if items remain, start next attempt immediately; otherwise next topic
    if (State.masteryPool.length) {
      State.attemptNumber++;
      State.masteryPool = shuffle(State.masteryPool);
      State.masteryIndex = 0;
      return presentMastery(State.masteryPool[State.masteryIndex]);
    } else {
      return nextTopic();
    }
  }
  presentMastery(State.masteryPool[State.masteryIndex]);
}


function showSummary() {
  show("#summary");
  $("#uploadStatus").textContent = "Uploading in background…";
  // 2s lockout while the background upload starts
  const btn = $("#submitResultsBtn");
  btn.disabled = true;
  const sid = State.session;
  const t = setTimeout(() => { if (sid !== State.session) return; btn.disabled = false; }, 2000);
  addCleanup(() => clearTimeout(t));
  // start background upload
  uploadedOnce = false;
  lastUploadOk = false;
  autoUploadOnce();

  // click: advance if already ok, else retry upload
  btn.onclick = autoUploadInteractive;
}


let uploadedOnce = false;
let lastUploadOk = false;


async function autoUploadInteractive() {
  const btn = $("#submitResultsBtn");
  btn.disabled = true;

  if (lastUploadOk) {
    $("#uploadStatus").textContent = "Upload already recorded.";
    const sid = State.session;
    const t = setTimeout(() => { if (sid !== State.session) return; show("#thankyou"); }, 300);
    addCleanup(() => clearTimeout(t));
    return;
  }

  $("#uploadStatus").textContent = "Uploading…";
  const payload = {
    student_number: State.studentNumber,
    week: State.week,
    topics_run: CONFIG.WEEK_TOPICS[State.week] || [],
    started_at: State.startTime,
    completed_at: nowISO(),
    device: State.device,
    trials: State.trials,
    reattempt: !!State.reattemptMode, // NEW
  };


  let url = "/api/ingest";
  if (location.hostname.endsWith(".pages.dev")) url = CONFIG.WORKER_FALLBACK_URL + "/api/ingest";


  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    if (!res.ok) throw new Error(await res.text());
    uploadedOnce = true;
    lastUploadOk = true;
    $("#uploadStatus").textContent = "Upload recorded.";
    const sid = State.session;
    const t = setTimeout(() => { if (sid !== State.session) return; show("#thankyou"); }, 500);
    addCleanup(() => clearTimeout(t));
  } catch (err) {
    console.error(err);
    lastUploadOk = false;
    $("#uploadStatus").textContent = "Upload failed. Click 'Check/Retry Upload' to try again.";
    btn.disabled = false;
  }
}


async function autoUploadOnce() {
  if (uploadedOnce) return;
  const btn = $("#submitResultsBtn");
  $("#uploadStatus").textContent = "Uploading…";

  const payload = {
    student_number: State.studentNumber,
    week: State.week,
    topics_run: CONFIG.WEEK_TOPICS[State.week] || [],
    started_at: State.startTime,
    completed_at: nowISO(),
    device: State.device,
    trials: State.trials,
    reattempt: !!State.reattemptMode, // NEW
  };


  let url = "/api/ingest";
  if (location.hostname.endsWith(".pages.dev")) url = CONFIG.WORKER_FALLBACK_URL + "/api/ingest";


  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    if (!res.ok) throw new Error(await res.text());
    uploadedOnce = true;
    lastUploadOk = true;
    $("#uploadStatus").textContent = "Upload recorded (or already exists).";
    // no auto-advance; wait for user click
  } catch (err) {
    console.error(err);
    lastUploadOk = false;
    $("#uploadStatus").textContent = "Background upload failed. Click 'Check/Retry Upload' to try again.";
    btn.disabled = false;
  }
}


window.addEventListener("load", async () => {
  try { await loadCSV(); } catch (e) { console.error(e); toast("CSV failed to load. Ensure items.csv is in the same folder."); }
  attachTopbar();
  lockWeekOptions(); // NEW: auto-select/lock weeks based on course TZ
  initLanding();
  show("#landing");
});
