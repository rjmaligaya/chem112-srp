/* 
  CHEM112 SRP — Clean Web Experiment (DOM-based, PsychoJS-free scaffold)
  ---------------------------------------------------------
  Notes:
  - This is a clean, framework-free JS implementation that mirrors the PsychoJS flow you described:
      * week/topic gating
      * randomized first pass
      * mastery loop (until 1 correct) for Organic & Units
      * special mastery (until 4 total correct per item) for Inorganic in Week 12
      * single POST at the very end (no time gating)
  - It loads a single CSV (items.csv) with columns: id,topic,image,answers
  - Multiple acceptable answers are delimited with "||"
  - Answers are normalized (case/space, basic chemistry units variants)
  - Results are stored locally during the session and POSTed once to /api/ingest
  - UI is mobile-first and minimal; no fullscreen
  - You can style with CSS as desired

  If you prefer a PsychoJS-specific Builder export, this file's logic can be
  adapted to run inside Builder's routines (mapping presentItem(), handleResponse(), etc.).
*/

const CONFIG = {
  CSV_URL: "items.csv",
  FEEDBACK_MS: 4000,
  POST_URL: "/api/ingest",     // Worker endpoint; update if you deploy at another path
  MAX_ANSWER_LEN: 120,
  UNIT_MAPS: [
    // Unit normalizations (first-year friendly)
    { re: /\bm\/s\b/g, to: "m s^-1" },
    { re: /\bg\/ml\b/gi, to: "g mL^-1" },
    { re: /\buL\b/g, to: "μL" },
    { re: /\bumol\b/g, to: "μmol" },
    { re: /\bmol\/L\b/gi, to: "M" }, // common equivalence
    { re: /\bdeg\b/gi, to: "°" },
  ],
  // Week -> list of topics to run sequentially
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
  // For mastery criteria by topic (default 1; inorganic in week 12 -> 4)
  MASTERY_REQUIRED: {
    organic: 1,
    units: 1,
    inorganic: 1 // will be overridden to 4 if week === 12
  },
};

// --- Utilities ---
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
  // Common organic nomenclature cleanups
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
function uuidv4() {
  // Simple UUID generator for client side (used only for local session tracking)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
function nowISO() { return new Date().toISOString(); }

// --- Simple CSV parser (no external deps) ---
function parseCSV(text) {
  // Basic CSV parser that handles quoted fields with commas
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; } // escaped quote
        else { inQuotes = false; }
      } else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip CR */ }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.length && r.some(x => x !== "")).map(r => {
    const obj = {};
    header.forEach((h, idx) => obj[h.trim()] = (r[idx] ?? ""));
    return obj;
  });
}

// --- Global state ---
const State = {
  step: "landing",           // landing -> topicIntro -> trial -> feedback -> summary or nextTopic
  csvItems: [],              // all items from CSV
  itemsByTopic: {},          // topic -> items[]
  week: null,
  topicsQueue: [],           // topics to run in order for the chosen week
  currentTopic: null,
  masteryGoal: 1,            // per-topic (4 for inorganic in week 12)
  studentNumber: "",
  sessionId: uuidv4(),
  startTime: null,
  device: { w: window.innerWidth, h: window.innerHeight, ua: navigator.userAgent },
  visibilityBlurs: 0,

  // Trial bookkeeping
  firstPass: [],             // shuffled
  fpIndex: 0,
  masteryPool: [],           // items needing further correct attempts
  masteryIndex: 0,
  // For inorganic week 12: we track per-item correct count goal of 4
  correctCounts: new Map(),  // id -> count of correct attempts

  // Results to POST
  trials: [],
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) State.visibilityBlurs += 1;
});

// --- UI helpers ---
function $(sel) { return document.querySelector(sel); }
function show(id) { document.querySelectorAll(".view").forEach(n => n.classList.add("hidden")); $(id).classList.remove("hidden"); }
function setText(sel, txt) { const n = $(sel); if (n) n.textContent = txt; }
function setImage(sel, src) { const n = $(sel); if (n) n.src = src; }

function toast(msg) {
  const n = $("#toast");
  n.textContent = msg;
  n.classList.remove("hidden");
  setTimeout(() => n.classList.add("hidden"), 2000);
}

// --- Data loading ---
async function loadCSV() {
  const res = await fetch(CONFIG.CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load items.csv");
  const text = await res.text();
  const rows = parseCSV(text);
  rows.forEach(r => {
    r.acceptable = toAcceptableSet(r.answers);
  });
  State.csvItems = rows;
  State.itemsByTopic = {
    organic: rows.filter(r => String(r.topic).toLowerCase() === "organic"),
    units: rows.filter(r => String(r.topic).toLowerCase() === "units"),
    inorganic: rows.filter(r => String(r.topic).toLowerCase() === "inorganic"),
  };
}

// --- Landing flow ---
function initLanding() {
  // Parse URL query for deep links
  const q = new URLSearchParams(location.search);
  const weekQ = q.get("week");
  if (weekQ) $("#week").value = weekQ;
  const topicQ = q.get("topic");
  if (topicQ) $("#topic").value = topicQ;

  $("#week").addEventListener("change", () => {
    const w = Number($("#week").value);
    populateTopicsForWeek(w);
  });
  populateTopicsForWeek(Number($("#week").value || 6));

  $("#startBtn").addEventListener("click", startSession);
}

function populateTopicsForWeek(w) {
  const topics = CONFIG.WEEK_TOPICS[w] || [];
  const sel = $("#topic");
  sel.innerHTML = "";
  topics.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = CONFIG.TOPIC_LABELS[t] || t;
    sel.appendChild(opt);
  });
}

// --- Session start ---
function startSession() {
  const student = $("#student").value.trim();
  const week = Number($("#week").value);
  if (!/^[0-9]{8}$/.test(student)) {
    toast("Enter an 8-digit student number.");
    return;
  }
  if (!CONFIG.WEEK_TOPICS[week]?.length) {
    toast("Select a valid week.");
    return;
  }
  State.studentNumber = student;
  State.week = week;
  State.topicsQueue = CONFIG.WEEK_TOPICS[week].slice(); // copy
  State.startTime = nowISO();
  State.trials = [];
  State.visibilityBlurs = 0;
  nextTopic();
}

function nextTopic() {
  if (!State.topicsQueue.length) {
    return showSummary();
  }
  State.currentTopic = State.topicsQueue.shift();
  // Mastery goal: default or special rule
  State.masteryGoal = CONFIG.MASTERY_REQUIRED[State.currentTopic] || 1;
  if (State.currentTopic === "inorganic" && State.week === 12) {
    State.masteryGoal = 4; // special spaced-like massed goal
  }
  showTopicIntro();
}

function showTopicIntro() {
  setText("#topicTitle", CONFIG.TOPIC_LABELS[State.currentTopic]);
  setText("#topicDesc", State.currentTopic === "inorganic" && State.week === 12
    ? "You will practice Inorganic Nomenclature. Each item must be answered correctly four times in total to achieve mastery."
    : "You will practice this topic until you master all items at least once.");
  show("#topicIntro");
  $("#beginTopicBtn").onclick = () => prepareTrialsForTopic(State.currentTopic);
}

// --- Build first pass and mastery pools ---
function prepareTrialsForTopic(topic) {
  const items = State.itemsByTopic[topic] || [];
  if (!items.length) {
    toast("No items found for topic.");
    return nextTopic();
  }
  // initialize correctCounts if 4-correct mode
  if (State.masteryGoal > 1) {
    State.correctCounts.clear();
    items.forEach(it => State.correctCounts.set(it.id, 0));
  }

  State.firstPass = shuffle(items);
  State.fpIndex = 0;
  State.masteryPool = []; // items that still need mastery (goal dependent)
  presentItem(State.firstPass[State.fpIndex], "first_pass");
}

function presentItem(item, phase) {
  setImage("#qImage", item.image);
  $("#answer").value = "";
  $("#answer").focus();
  show("#trial");
  const t0 = performance.now();

  $("#submitBtn").onclick = () => {
    const raw = $("#answer").value;
    const norm = normalizeAnswer(raw).slice(0, CONFIG.MAX_ANSWER_LEN);
    const ok = item.acceptable.has(norm);
    const rt = Math.max(0, Math.round(performance.now() - t0));
    // record trial
    const rec = {
      id: item.id,
      topic: State.currentTopic,
      week: State.week,
      phase,
      rt_ms: rt,
      answer_raw: raw,
      answer_norm: norm,
      correct: !!ok,
      ts: nowISO(),
    };
    State.trials.push(rec);

    if (ok) {
      // For 4-correct goal: increment count; if not yet mastered, keep in pool
      if (State.masteryGoal > 1) {
        const cur = State.correctCounts.get(item.id) ?? 0;
        State.correctCounts.set(item.id, cur + 1);
      }
      showFeedback("Correct!", null);
    } else {
      const canonical = [...item.acceptable][0] || "(no key)";
      showFeedback("Incorrect.", canonical);
      // For first pass, we add to mastery; for mastery loop, we keep it there
      if (!inMasteryPool(item)) State.masteryPool.push(item);
    }
  };
}

function inMasteryPool(item) {
  return State.masteryPool.some(it => it.id === item.id);
}

function showFeedback(msg, canonical) {
  setText("#fbText", msg);
  setText("#fbCanonical", canonical ? `Correct answer: ${canonical}` : "");
  show("#feedback");
  setTimeout(() => advanceFlow(), CONFIG.FEEDBACK_MS);
}

function advanceFlow() {
  // If we are still in first pass
  if (State.fpIndex < State.firstPass.length - 1) {
    State.fpIndex++;
    return presentItem(State.firstPass[State.fpIndex], "first_pass");
  }
  // First pass finished → setup mastery criteria
  // For standard mastery (goal 1): pool already contains only misses.
  // For goal 4: pool initially includes all items with count < 4 after first pass.
  if (State.masteryGoal > 1) {
    State.masteryPool = State.firstPass.filter(it => (State.correctCounts.get(it.id) || 0) < State.masteryGoal);
  }
  // If nothing to master, move to next topic
  if (!State.masteryPool.length) return nextTopic();
  // Otherwise, start mastery loop
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

  $("#submitBtn").onclick = () => {
    const raw = $("#answer").value;
    const norm = normalizeAnswer(raw).slice(0, CONFIG.MAX_ANSWER_LEN);
    const ok = item.acceptable.has(norm);
    const rt = Math.max(0, Math.round(performance.now() - t0));
    const rec = {
      id: item.id,
      topic: State.currentTopic,
      week: State.week,
      phase: "mastery",
      rt_ms: rt,
      answer_raw: raw,
      answer_norm: norm,
      correct: !!ok,
      ts: nowISO(),
    };
    State.trials.push(rec);

    if (ok) {
      if (State.masteryGoal > 1) {
        const cur = State.correctCounts.get(item.id) ?? 0;
        const next = cur + 1;
        State.correctCounts.set(item.id, next);
        if (next >= State.masteryGoal) {
          // remove from pool
          State.masteryPool = State.masteryPool.filter(it => it.id !== item.id);
        }
      } else {
        // goal 1: remove item from pool
        State.masteryPool = State.masteryPool.filter(it => it.id !== item.id);
      }
      showFeedback("Correct!", null);
    } else {
      const canonical = [...item.acceptable][0] || "(no key)";
      showFeedback("Incorrect.", canonical);
      // keep item in pool
    }
  };
}

function advanceFlowFromMastery() {
  // Not used; we use showFeedback → advanceFlowMastery for clarity
}

function advanceFlowMastery() {
  if (!State.masteryPool.length) {
    return nextTopic();
  }
  // Move to next item; reshuffle if we hit the end
  State.masteryIndex++;
  if (State.masteryIndex >= State.masteryPool.length) {
    State.masteryPool = shuffle(State.masteryPool);
    State.masteryIndex = 0;
  }
  presentMastery(State.masteryPool[State.masteryIndex]);
}

// Override feedback transition when in mastery vs first pass
function advanceFlow() {
  if (State.fpIndex < State.firstPass.length - 1) {
    State.fpIndex++;
    return presentItem(State.firstPass[State.fpIndex], "first_pass");
  }
  // First pass done: ensure mastery pool prepared
  if (State.masteryGoal > 1 && State.trials.some(t => t.phase === "first_pass")) {
    State.masteryPool = State.firstPass.filter(it => (State.correctCounts.get(it.id) || 0) < State.masteryGoal);
  }
  if (!State.masteryPool.length) return nextTopic();
  // continue mastery
  if (State.masteryIndex == null) State.masteryIndex = 0;
  return advanceFlowMastery();
}

// --- Summary & POST ---
function showSummary() {
  // Simple stats
  const total = State.trials.length;
  const correct = State.trials.filter(t => t.correct).length;
  setText("#sumTotal", String(total));
  setText("#sumCorrect", String(correct));
  setText("#sumBlurs", String(State.visibilityBlurs));
  show("#summary");

  $("#submitResultsBtn").onclick = submitResults;
}

async function submitResults() {
  const payload = {
    student_number: State.studentNumber,
    week: State.week,
    topics_run: CONFIG.WEEK_TOPICS[State.week] || [],
    started_at: State.startTime,
    completed_at: nowISO(),
    device: State.device,
    visibility_blurs: State.visibilityBlurs,
    trials: State.trials,
  };

  try {
    const res = await fetch(CONFIG.POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "include",
      cache: "no-store"
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error("Upload failed: " + res.status + " " + txt);
    }
    setText("#uploadStatus", "Results uploaded successfully.");
  } catch (err) {
    console.error(err);
    setText("#uploadStatus", "Upload failed. You can retry by clicking the button again.");
  }
}

// --- Boot ---
window.addEventListener("load", async () => {
  initLanding();
  try {
    await loadCSV();
  } catch (e) {
    console.error(e);
    toast("CSV failed to load. Ensure items.csv is in the same folder.");
  }
  show("#landing");
});
