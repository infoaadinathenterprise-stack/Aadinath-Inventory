interface Env {
  GEMINI_KEY: string;
  GEMINI_MODEL?: string;
}

const GEMINI_TIMEOUT_MS = 12_000;
const DEFAULT_MODEL = 'gemini-2.0-flash-lite';
// v4: switched request format from JSON-wrapped base64 (~800KB JSON.parse,
// blew the free-tier 10ms CPU budget) to raw image bytes in the body with
// prompt + mime in headers. Worker reads ArrayBuffer (zero parse cost),
// base64-encodes server-side just before forwarding to Gemini.
const WORKER_VERSION = 'v4-2026-05-09-binary-body';

// btoa() on long binary strings can stack-overflow when built with the
// spread operator; chunk it.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin') ?? '';

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Prompt, X-Mime-Type',
    'Content-Type': 'application/json',
    'X-Worker-Version': WORKER_VERSION,
  };

  if (!context.env.GEMINI_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_KEY not set', workerVersion: WORKER_VERSION }), { status: 500, headers: corsHeaders });
  }

  // Prompt arrives in a header, base64-encoded so it can carry any
  // characters safely (raw header values are restricted to ASCII).
  const promptB64 = context.request.headers.get('X-Prompt') ?? '';
  if (!promptB64) {
    return new Response(JSON.stringify({ error: 'Missing X-Prompt header', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }
  let prompt: string;
  try {
    prompt = decodeURIComponent(escape(atob(promptB64)));
  } catch {
    return new Response(JSON.stringify({ error: 'X-Prompt is not valid base64', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }

  const mimeType = context.request.headers.get('X-Mime-Type') ?? '';
  const contentLen = context.request.headers.get('Content-Length');

  // The body is the raw image bytes — no JSON parsing on the hot path.
  const buf = await context.request.arrayBuffer();
  const hasImage = buf.byteLength > 0;
  if (hasImage && !mimeType) {
    return new Response(JSON.stringify({ error: 'Missing X-Mime-Type header for image', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }

  type GeminiPart =
    | { inline_data: { mime_type: string; data: string } }
    | { text: string };

  const parts: GeminiPart[] = [];
  if (hasImage) {
    parts.push({ inline_data: { mime_type: mimeType, data: arrayBufferToBase64(buf) } });
  }
  parts.push({ text: prompt });

  const model = context.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${context.env.GEMINI_KEY}`;

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
      JSON.stringify({
        error: `Gemini HTTP ${geminiRes.status} (${model})`,
        detail: errText.slice(0, 800),
        workerVersion: WORKER_VERSION,
        bodyBytes: contentLen,
      }),
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
      'Access-Control-Allow-Headers': 'Content-Type, X-Prompt, X-Mime-Type',
    },
  });
};
