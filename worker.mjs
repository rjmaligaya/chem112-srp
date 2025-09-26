export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Minimal CORS for your domain(s)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(request),
      });
    }

    if (url.pathname !== "/api/ingest") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(request) });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders(request) });
    }

    // Basic validation
    const sn = String(body.student_number || "");
    const week = Number(body.week);
    if (!/^[0-9]{8}$/.test(sn)) {
      return new Response("Invalid student_number", { status: 400, headers: corsHeaders(request) });
    }
    const validWeeks = new Set([6,7,8,9,10,12]);
    if (!validWeeks.has(week)) {
      return new Response("Invalid week", { status: 400, headers: corsHeaders(request) });
    }
    if (!Array.isArray(body.trials) || body.trials.length === 0) {
      return new Response("No trials", { status: 400, headers: corsHeaders(request) });
    }

    // Store the "latest run" for this (student, week) across topics
    // Overwrite semantics: latest timestamp wins
    const now = new Date().toISOString();
    const key = `latest/${week}/${sn}.json`;
    const content = JSON.stringify({ ...body, stored_at: now });

    try {
      await env.RESULTS.put(key, content, {
        httpMetadata: { contentType: "application/json" }
      });
    } catch (e) {
      return new Response("R2 write failed: " + (e && e.message || e), { status: 500, headers: corsHeaders(request) });
    }

    // Also append a write-once line (audit trail) if you want — disabled by default
    // const appendKey = `archive/${now.slice(0,10)}/${crypto.randomUUID()}.json`;
    // await env.RESULTS.put(appendKey, content, { httpMetadata: { contentType: "application/json" } });

    return new Response(JSON.stringify({ ok: true, key }), {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" }
    });
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  // Lock this down to your domains in production:
  const allow = /queenschem112srp\.com$/.test(new URL(request.url).hostname) ? origin : origin;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
