interface Env {
  GEMINI_KEY: string;
  GEMINI_MODEL?: string;
}

// v8 — same shape as the gemini proxy but at a fresh route path.
// Cloudflare Pages was returning HTML 502 for /api/gemini in <1s with
// no worker code executing (no X-Worker-Version on the response),
// which is the classic "edge has a stuck/broken function record"
// symptom — moving to a new path forces a fresh materialization.
//
// Also defaults to gemini-2.0-flash-lite (faster on free quota) and
// supports a { test: true } payload that returns success without
// calling Gemini, so the worker plumbing can be tested in isolation.
const WORKER_VERSION = 'v8-2026-05-09-scan-fresh-route';
const DEFAULT_MODEL  = 'gemini-2.0-flash-lite';
const ABORT_MS       = 22_000;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin') ?? '';
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'X-Worker-Version': WORKER_VERSION,
  };

  let body: { prompt?: string; test?: boolean };
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }

  // Plumbing test — proves the worker path is alive without burning
  // any Gemini quota.
  if (body.test) {
    return new Response(
      JSON.stringify({
        ok: true,
        workerVersion: WORKER_VERSION,
        time: new Date().toISOString(),
        message: 'Worker reachable; Gemini was not called.',
      }),
      { status: 200, headers: corsHeaders },
    );
  }

  if (!context.env.GEMINI_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_KEY not set', workerVersion: WORKER_VERSION }), { status: 500, headers: corsHeaders });
  }

  const prompt = body.prompt;
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Missing prompt', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }

  const model = context.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${context.env.GEMINI_KEY}`;
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ABORT_MS);

  let geminiRes: Response;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    clearTimeout(timeout);
    const isAbort = e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message));
    if (isAbort) {
      return new Response(
        JSON.stringify({
          error: `Gemini took longer than ${ABORT_MS / 1000}s on model ${model}. Try a shorter bill or set GEMINI_MODEL to a faster variant.`,
          workerVersion: WORKER_VERSION,
        }),
        { status: 504, headers: corsHeaders },
      );
    }
    return new Response(
      JSON.stringify({ error: 'Failed to reach Gemini', detail: e instanceof Error ? e.message : String(e), workerVersion: WORKER_VERSION }),
      { status: 502, headers: corsHeaders },
    );
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return new Response(
      JSON.stringify({ error: `Gemini HTTP ${geminiRes.status} (${model})`, detail: errText.slice(0, 800), workerVersion: WORKER_VERSION }),
      { status: 502, headers: corsHeaders },
    );
  }

  const data = await geminiRes.json() as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) {
    const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason ?? 'unknown';
    return new Response(
      JSON.stringify({ error: `Gemini returned no text (reason: ${reason})`, workerVersion: WORKER_VERSION }),
      { status: 502, headers: corsHeaders },
    );
  }
  return new Response(JSON.stringify({ result: text, workerVersion: WORKER_VERSION }), { status: 200, headers: corsHeaders });
};

export const onRequestOptions: PagesFunction = async (context) => {
  const origin = context.request.headers.get('Origin') ?? '';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
};
