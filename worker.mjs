export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(request) });
    if (url.pathname !== "/api/ingest") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(request) });

    let body;
    try { body = await request.json(); }
    catch { return new Response("Invalid JSON", { status: 400, headers: corsHeaders(request) }); }

    const sn = String(body.student_number || "");
    const week = Number(body.week);
    if (!/^[0-9]{8}$/.test(sn)) return new Response("Invalid student_number", { status: 400, headers: corsHeaders(request) });
    const validWeeks = new Set([6,7,8,9,10,12]);
    if (!validWeeks.has(week)) return new Response("Invalid week", { status: 400, headers: corsHeaders(request) });
    if (!Array.isArray(body.trials) || body.trials.length === 0) return new Response("No trials", { status: 400, headers: corsHeaders(request) });

    // Build CSV rows with required columns only
    const header = [
      "student_number","week","topic","trial_index","phase","id","rt_ms",
      "answer_raw","answer_norm","correct","started_at","completed_at","ts","ua","w","h"
    ];
    const rows = [header.join(",")];

    const started = body.started_at || "";
    const completed = body.completed_at || "";
    const ua = (body.device && body.device.ua) || "";
    const w = (body.device && body.device.w) || "";
    const h = (body.device && body.device.h) || "";

    for (const t of body.trials) {
      const r = [
        sn,
        week,
        safeCSV(t.topic),
        t.trial_index ?? "",
        safeCSV(t.phase),
        safeCSV(t.id),
        t.rt_ms ?? "",
        safeCSV(t.answer_raw),
        safeCSV(t.answer_norm),
        t.correct ? "1" : "0",
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
    const key = `${sn}_${week}_chem112srp.csv`; // requested naming

    try {
      await env.RESULTS.put(key, csv, { httpMetadata: { contentType: "text/csv; charset=utf-8" } });
    } catch (e) {
      return new Response("R2 write failed: " + (e && e.message || e), { status: 500, headers: corsHeaders(request) });
    }

    return new Response(JSON.stringify({ ok: true, key }), { status: 200, headers: { ...corsHeaders(request), "Content-Type": "application/json" } });
  }
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
