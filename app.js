/* Updated app.js with UX tweaks and CSV-ready logging */

const CONFIG = {
  CSV_URL: "items.csv",
  FEEDBACK_MS: 4000,
  POST_URL: "/api/ingest",
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
    6: ["organic", "units"],
    7: ["units"],
    8: ["organic"],
    9: ["units"],
    10: ["organic"],
    12: ["organic", "units", "inorganic"],
  },
  TOPIC_LABELS: {
    organic: "Organic Nomenclature",
    units: "Units / Dimensional Analysis",
    inorganic: "Inorganic Nomenclature"
  },
  MASTERY_REQUIRED: {
    organic: 1,
    units: 1,
    inorganic: 1
  },
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
function toAcceptableSet(cell) {
  if (!cell) return new Set();
  return new Set(String(cell).split("||").map(a => normalizeAnswer(a)).filter(Boolean));
}
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
  itemsByTopic: {},
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

  fpCorrectCount: 0,
  fpToRetryCount: 0,
};

function $(sel) { return document.querySelector(sel); }
function show(id) { document.querySelectorAll(".view").forEach(n => n.classList.add("hidden")); $(id).classList.remove("hidden"); }
function setText(sel, txt) { const n = $(sel); if (n) n.textContent = txt; }
function setImage(sel, src) { const n = $(sel); if (n) n.src = src; }
function toast(msg) { const n = $("#toast"); n.textContent = msg; n.classList.remove("hidden"); setTimeout(()=>n.classList.add("hidden"),2000); }

async function loadCSV() {
  const res = await fetch(CONFIG.CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load items.csv");
  const rows = parseCSV(await res.text());
  rows.forEach(r => r.acceptable = toAcceptableSet(r.answers));
  State.csvItems = rows;
  State.itemsByTopic = {
    organic: rows.filter(r => String(r.topic).toLowerCase() === "organic"),
    units: rows.filter(r => String(r.topic).toLowerCase() === "units"),
    inorganic: rows.filter(r => String(r.topic).toLowerCase() === "inorganic"),
  };
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
  document.addEventListener("keydown", (e)=>{
    if (["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName)) {
      if (e.key === "Enter" && $("#landing") && !$("#landing").classList.contains("hidden")) {
        startSession();
      }
    }
  });
}

function startSession() {
  const student = $("#student").value.trim();
  const week = Number($("#week").value);
  if (!/^[0-9]{8}$/.test(student)) { toast("Enter an 8-digit student number."); return; }
  if (!CONFIG.WEEK_TOPICS[week]?.length) { toast("Select a valid week."); return; }
  State.studentNumber = student;
  State.week = week;
  State.topicsQueue = CONFIG.WEEK_TOPICS[week].slice();
  State.startTime = nowISO();
  State.trials = [];
  State.trialIndex = 0;
  showWeekIntro();
}

function showWeekIntro() {
  show("#weekIntro");
  const onKey = (e)=>{ if (e.key === "Enter") { cleanup(); nextTopic(); } };
  const cleanup = ()=>document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  $("#beginWeekBtn").onclick = ()=>{ cleanup(); nextTopic(); };
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
  const onKey = (e)=>{ if (e.key === "Enter") { cleanup(); prepareTrialsForTopic(State.currentTopic); } };
  const cleanup = ()=>document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  $("#beginTopicBtn").onclick = ()=>{ cleanup(); prepareTrialsForTopic(State.currentTopic); };
}

function prepareTrialsForTopic(topic) {
  const items = State.itemsByTopic[topic] || [];
  if (!items.length) { toast("No items found for topic."); return nextTopic(); }
  if (State.masteryGoal > 1) { State.correctCounts.clear(); items.forEach(it => State.correctCounts.set(it.id, 0)); }

  State.firstPass = shuffle(items);
  State.fpIndex = 0;
  State.masteryPool = [];
  State.fpCorrectCount = 0;
  State.fpToRetryCount = 0;
  presentItem(State.firstPass[State.fpIndex], "first_pass");
}

function presentItem(item, phase) {
  setImage("#qImage", item.image);
  $("#answer").value = "";
  $("#answer").focus();
  show("#trial");
  const t0 = performance.now();

  const onKey = (e)=>{ if (e.key === "Enter") { e.preventDefault(); submit(); } };
  document.addEventListener("keydown", onKey);
  $("#submitBtn").onclick = submit;

  function submit() {
    document.removeEventListener("keydown", onKey);
    const raw = $("#answer").value;
    const norm = normalizeAnswer(raw).slice(0, CONFIG.MAX_ANSWER_LEN);
    const ok = item.acceptable.has(norm);
    const rt = Math.max(0, Math.round(performance.now() - t0));

    State.trials.push({
      trial_index: ++State.trialIndex,
      id: item.id,
      topic: State.currentTopic,
      week: State.week,
      phase,
      rt_ms: rt,
      answer_raw: raw,
      answer_norm: norm,
      correct: !!ok,
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

    const canonical = [...item.acceptable][0] || "(no key)";
    showFeedback(ok ? "Correct!" : "Incorrect.", `The correct answer is: ${canonical}`);
  }
}

function showFeedback(msg, canonicalLine) {
  setText("#fbText", msg);
  setText("#fbCanonical", canonicalLine || "");
  show("#feedback");
  setTimeout(() => advanceFlow(), CONFIG.FEEDBACK_MS);
}

function advanceFlow() {
  if (State.fpIndex < State.firstPass.length - 1) {
    State.fpIndex++;
    return presentItem(State.firstPass[State.fpIndex], "first_pass");
  }
  if (State.masteryGoal > 1) {
    State.masteryPool = State.firstPass.filter(it => (State.correctCounts.get(it.id) || 0) < State.masteryGoal);
  }
  if (State.masteryGoal === 1) {
    const missedIds = new Set(State.trials.filter(t => t.phase === "first_pass" && !t.correct && t.topic === State.currentTopic).map(t => t.id));
    State.masteryPool = State.firstPass.filter(it => missedIds.has(it.id));
  }

  setText("#fpCorrect", String(State.fpCorrectCount));
  setText("#fpToRetry", String(State.fpToRetryCount));
  if (State.fpToRetryCount === 0) { return nextTopic(); }
  show("#fpSummary");
  const onKey = (e)=>{ if (e.key === "Enter") { cleanup(); startMasteryLoop(); } };
  const cleanup = ()=>document.removeEventListener("keydown", onKey);
  document.addEventListener("keydown", onKey);
  $("#beginMasteryBtn").onclick = ()=>{ cleanup(); startMasteryLoop(); };
}

function startMasteryLoop() {
  if (!State.masteryPool.length) return nextTopic();
  State.masteryPool = shuffle(State.masteryPool);
  State.masteryIndex = 0;
  presentMastery(State.masteryPool[State.masteryIndex]);
}

function presentMastery(item) {
  setImage("#qImage", item.image);
  $("#answer").value = "";
  $("#answer").focus();
  show("#trial");
  const t0 = performance.now();

  const onKey = (e)=>{ if (e.key === "Enter") { e.preventDefault(); submit(); } };
  document.addEventListener("keydown", onKey);
  $("#submitBtn").onclick = submit;

  function submit() {
    document.removeEventListener("keydown", onKey);
    const raw = $("#answer").value;
    const norm = normalizeAnswer(raw).slice(0, CONFIG.MAX_ANSWER_LEN);
    const ok = item.acceptable.has(norm);
    const rt = Math.max(0, Math.round(performance.now() - t0));

    State.trials.push({
      trial_index: ++State.trialIndex,
      id: item.id,
      topic: State.currentTopic,
      week: State.week,
      phase: "mastery",
      rt_ms: rt,
      answer_raw: raw,
      answer_norm: norm,
      correct: !!ok,
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
    const canonical = [...item.acceptable][0] || "(no key)";
    showFeedback(ok ? "Correct!" : "Incorrect.", `The correct answer is: ${canonical}`);
  }
}

function advanceAfterMasteryFeedback() {
  if (!State.masteryPool.length) return nextTopic();
  State.masteryIndex++;
  if (State.masteryIndex >= State.masteryPool.length) {
    State.masteryPool = shuffle(State.masteryPool);
    State.masteryIndex = 0;
  }
  presentMastery(State.masteryPool[State.masteryIndex]);
}

const _origShowFeedback = showFeedback;
showFeedback = function(msg, canonicalLine) {
  setText("#fbText", msg);
  setText("#fbCanonical", canonicalLine || "");
  show("#feedback");
  setTimeout(() => {
    const last = State.trials[State.trials.length-1];
    if (last && last.phase === "mastery") return advanceAfterMasteryFeedback();
    return advanceFlow();
  }, CONFIG.FEEDBACK_MS);
};

function showSummary() {
  const total = State.trials.length;
  const correct = State.trials.filter(t => t.correct).length;
  setText("#sumTotal", String(total));
  setText("#sumCorrect", String(correct));
  show("#summary");

  const btn = $("#submitResultsBtn");
  btn.disabled = false;
  btn.textContent = "Submit Results";
  $("#uploadStatus").textContent = "";
  btn.onclick = submitResultsOnce;
}

let submittedOk = false;
async function submitResultsOnce() {
  if (submittedOk) return;
  const btn = $("#submitResultsBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  const payload = {
    student_number: State.studentNumber,
    week: State.week,
    topics_run: CONFIG.WEEK_TOPICS[State.week] || [],
    started_at: State.startTime,
    completed_at: nowISO(),
    device: State.device,
    trials: State.trials,
  };

  try {
    const res = await fetch(CONFIG.POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error("Upload failed: " + res.status + " " + txt);
    }
    submittedOk = true;
    $("#uploadStatus").textContent = "Results uploaded successfully.";
    setTimeout(()=>show("#thankyou"), 600);
  } catch (err) {
    console.error(err);
    $("#uploadStatus").textContent = "Upload failed. Please click Submit Results again to retry.";
    btn.disabled = false;
    btn.textContent = "Submit Results";
  }
}

window.addEventListener("load", async () => {
  try { await loadCSV(); } catch (e) { console.error(e); toast("CSV failed to load. Ensure items.csv is in the same folder."); }
  initLanding();
  show("#landing");
  const s = document.getElementById("student");
  if (s) s.focus();
});
