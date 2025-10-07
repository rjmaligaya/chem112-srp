export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // NEW: status probe
    if (pathname === "/api/status" && request.method === "GET") {
      return statusHandler(url, env, request);
    }

    if (pathname === "/api/ingest") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(request) });
      }
      return ingestHandler(request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(request) });
  }
}

async function statusHandler(url, env, request){
  const sn = String(url.searchParams.get("sn") || "");
  const week = Number(url.searchParams.get("week") || "0");
  const validWeeks = new Set([6,7,8,9,10,11,12]);
  if (!/^[0-9]{8}$/.test(sn) || !validWeeks.has(week)) {
    return new Response(JSON.stringify({ error: "invalid_params" }), {
      status: 400,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" }
    });
  }
  const key = `Week-${week}/Week_${week}_${sn}_chem112srp.csv`;
  try {
    const head = await env.RESULTS.head(key);
    if (!head) {
      return new Response(JSON.stringify({ exists: false }), {
        status: 200,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" }
      });
    }
    // Try to read completed_at from the CSV first data row
    const obj = await env.RESULTS.get(key);
    let completed_at = "";
    if (obj) {
      const csv = await obj.text();
      const lines = csv.split(/\r?\n/).filter(Boolean);
      if (lines.length >= 2) {
        const header = lines[0].split(",");
        const completedIdx = header.indexOf("completed_at");
        if (completedIdx !== -1) {
          const firstData = parseCSVLine(lines[1]);
          completed_at = firstData[completedIdx] || "";
        }
      }
    }
    const uploaded_at = head?.uploaded?.toISOString?.();
    return new Response(JSON.stringify({ exists: true, key, completed_at, uploaded_at }), {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "status_failed", message: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" }
    });
  }
}

async function ingestHandler(request, env){
  let body;
  try { body = await request.json(); }
  catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders(request) }); }

  const sn = String(body.student_number || "");
  const week = Number(body.week);
  if (!/^[0-9]{8}$/.test(sn)) return new Response("Invalid student_number", { status: 400, headers: corsHeaders(request) });
  const validWeeks = new Set([6,7,8,9,10,11,12]);
  if (!validWeeks.has(week)) return new Response("Invalid week", { status: 400, headers: corsHeaders(request) });
  if (!Array.isArray(body.trials) || body.trials.length === 0) return new Response("No trials", { status: 400, headers: corsHeaders(request) });

  const header = [
    "student_number","week","topic","trial_index","attempt","phase","id","q_type","rt_ms",
    "answer_raw","answer_norm","correct","estimate","started_at","completed_at","ts","ua","w","h"
  ];
  const rows = [header.join(",")];

  const started = body.started_at || "";
  const completed = body.completed_at || "";
  const ua = (body.device && body.device.ua) || "";
  const w = (body.device && body.device.w) || "";
  const h = (body.device && body.device.h) || "";

  for (const t of body.trials) {
    const isMeta = t.phase === "meta";
    const estimate = isMeta ? String(t.answer_raw || "") : "";
    const r = [
      sn,
      week,
      safeCSV(t.topic),
      t.trial_index ?? "",
      t.attempt ?? "",
      safeCSV(t.phase),
      safeCSV(t.id),
      safeCSV(t.q_type || ""),
      t.rt_ms ?? "",
      safeCSV(t.answer_raw ?? ""),
      safeCSV(t.answer_norm ?? ""),
      t.correct === 1 ? "1" : (t.correct === 0 ? "0" : ""),
      safeCSV(estimate),
      started,
      completed,
      t.ts || "",
      safeCSV(ua),
      w,
      h,
    ];
    rows.push(r.join(","));
  }

  const csv = rows.join("\n");
  const primaryKey = `Week-${week}/Week_${week}_${sn}_chem112srp.csv`;
  const isReattempt = Boolean(body.reattempt);

  // Reattempts always go to a separate folder
  if (isReattempt) {
    const ts = Date.now();
    const reKey = `Week-${week}/Reattempts/Week_${week}_${sn}_${ts}.csv`;
    try {
      await env.RESULTS.put(reKey, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
      return new Response(JSON.stringify({ ok: true, saved: true, key: reKey, reattempt: true }), {
        status: 200,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" }
      });
    } catch (e) {
      return new Response("R2 write failed: " + (e?.message || e), { status: 500, headers: corsHeaders(request) });
    }
  }

  // First attempt only: if object exists, do not overwrite
  try {
    const head = await env.RESULTS.head(primaryKey);
    if (head) {
      return new Response(JSON.stringify({ ok: true, saved: false, reason: "already_exists", key: primaryKey }), {
        status: 200,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" }
      });
    }
  } catch {}

  try {
    await env.RESULTS.put(primaryKey, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
  } catch (e) {
    return new Response("R2 write failed: " + (e?.message || e), { status: 500, headers: corsHeaders(request) });
  }

  return new Response(JSON.stringify({ ok: true, saved: true, key: primaryKey, reattempt: false }), {
    status: 200,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" }
  });
}

function parseCSVLine(line){
  const out=[]; let field="", inQuotes=false;
  for (let i=0;i<line.length;i++){
    const c=line[i];
    if(inQuotes){
      if(c==='\"'){ if(line[i+1]==='\"'){ field+='\"'; i++; } else { inQuotes=false; } }
      else field+=c;
    } else {
      if(c==='\"') inQuotes=true;
      else if(c===','){ out.push(field); field=""; }
      else { field+=c; }
    }
  }
  out.push(field);
  return out;
}

function safeCSV(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", // allow GET for /api/status
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
