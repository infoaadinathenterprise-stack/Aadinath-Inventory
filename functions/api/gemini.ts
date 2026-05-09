interface Env {
  GEMINI_KEY: string;
  GEMINI_MODEL?: string;
}

interface GeminiBody {
  prompt: string;
  imageBase64?: string;
  mimeType?: string;
}

// Cloudflare Pages Functions are killed at ~30s wall time. We abort
// well before that so we can return a clean JSON error instead of
// Cloudflare's HTML 502 page. 12s is plenty for flash-lite under
// normal conditions and leaves a huge safety margin.
const GEMINI_TIMEOUT_MS = 12_000;

// Bump this when you change worker behavior so the client can prove
// which version of the function is actually live (Pages caches
// functions separately from the static site and stale deploys are a
// common source of "fix didn't work" reports).
const WORKER_VERSION = 'v3-2026-05-09';

// Default to flash-lite — about 2x faster than flash on cold-start
// quota and plenty accurate for invoice OCR. Override via the
// GEMINI_MODEL env var if you want to switch (e.g., 'gemini-2.0-flash',
// 'gemini-2.5-flash', 'gemini-flash-latest').
const DEFAULT_MODEL = 'gemini-2.0-flash-lite';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin') ?? '';

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'X-Worker-Version': WORKER_VERSION,
  };

  let body: GeminiBody;
  try {
    body = await context.request.json() as GeminiBody;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders });
  }

  const { prompt, imageBase64, mimeType } = body;
  if (!prompt) return new Response(JSON.stringify({ error: 'Missing prompt' }), { status: 400, headers: corsHeaders });
  if (!context.env.GEMINI_KEY) return new Response(JSON.stringify({ error: 'GEMINI_KEY not set' }), { status: 500, headers: corsHeaders });

  type GeminiPart =
    | { inline_data: { mime_type: string; data: string } }
    | { text: string };

  const parts: GeminiPart[] = [];
  if (imageBase64 && mimeType) {
    parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  }
  parts.push({ text: prompt });

  const model = context.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${context.env.GEMINI_KEY}`;

  // Forced JSON output mode + temperature 0 + a generous-but-bounded
  // maxOutputTokens makes generation finish faster (Gemini stops as
  // soon as the JSON closes) and removes any need to strip markdown
  // fences client-side.
  const requestBody = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let geminiRes: Response;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutHandle);
  } catch (e) {
    clearTimeout(timeoutHandle);
    const isAbort = e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message));
    if (isAbort) {
      return new Response(
        JSON.stringify({
          error: `Gemini took longer than ${GEMINI_TIMEOUT_MS / 1000}s. Model ${model} may be slow on free quota — set GEMINI_MODEL or check API quota.`,
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
