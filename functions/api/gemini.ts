interface Env {
  GEMINI_KEY: string;
  GEMINI_MODEL?: string;
}

// v6 — text-only proxy, matching the architecture that worked in the
// older Aadinath-Inventory project. The browser does OCR via OCR.space
// directly (no proxy involvement), then sends only the extracted TEXT
// to this endpoint. Tiny JSON in / tiny JSON out — well within
// Cloudflare Pages free-tier CPU and wall-time limits.
const WORKER_VERSION = 'v6-2026-05-09-text-only';
const DEFAULT_MODEL  = 'gemini-2.0-flash';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin') ?? '';
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'X-Worker-Version': WORKER_VERSION,
  };

  if (!context.env.GEMINI_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_KEY not set', workerVersion: WORKER_VERSION }), { status: 500, headers: corsHeaders });
  }

  let body: { prompt?: string };
  try {
    body = await context.request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }
  const prompt = body.prompt;
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Missing prompt', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }

  const model = context.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${context.env.GEMINI_KEY}`;

  let geminiRes: Response;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
  } catch (e) {
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
