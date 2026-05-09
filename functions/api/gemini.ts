interface Env {
  GEMINI_KEY: string;
  GEMINI_MODEL?: string;
}

const GEMINI_TIMEOUT_MS = 20_000;
const DEFAULT_MODEL = 'gemini-2.0-flash-lite';
// v5: stop base64-encoding images in the worker. v4 read the body
// cheaply but then had to base64-encode the bytes in JS to inline them
// into Gemini's generateContent request — that's ~50ms of CPU on
// 600KB, which blows the Pages free-tier 10ms budget. v5 uploads the
// raw bytes to Gemini's File API (no encoding work on our side), then
// references the returned file URI in generateContent.
const WORKER_VERSION = 'v5-2026-05-09-file-api';

const FILES_UPLOAD = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEN_BASE     = 'https://generativelanguage.googleapis.com/v1beta/models';

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

  // Body = raw image bytes (or empty for text-only). No parsing, no
  // encoding. arrayBuffer() is essentially zero CPU.
  const buf = await context.request.arrayBuffer();
  const hasImage = buf.byteLength > 0;
  if (hasImage && !mimeType) {
    return new Response(JSON.stringify({ error: 'Missing X-Mime-Type header for image', workerVersion: WORKER_VERSION }), { status: 400, headers: corsHeaders });
  }

  const model = context.env.GEMINI_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  type GeminiPart =
    | { inline_data?: { mime_type: string; data: string } }
    | { file_data?:   { mime_type: string; file_uri: string } }
    | { text: string };

  try {
    const parts: GeminiPart[] = [];

    if (hasImage) {
      // Upload bytes to Gemini's File API and reference by URI in
      // generateContent. The platform handles the encoding for us; we
      // ship raw octets straight through.
      const uploadUrl = `${FILES_UPLOAD}?uploadType=media&key=${context.env.GEMINI_KEY}`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': mimeType, 'X-Goog-Upload-Protocol': 'raw' },
        body: buf,
        signal: controller.signal,
      });
      if (!uploadRes.ok) {
        clearTimeout(timeoutHandle);
        const errText = await uploadRes.text();
        return new Response(
          JSON.stringify({
            error: `Gemini File API HTTP ${uploadRes.status}`,
            detail: errText.slice(0, 500),
            workerVersion: WORKER_VERSION,
          }),
          { status: 502, headers: corsHeaders },
        );
      }
      const uploaded = await uploadRes.json() as { file?: { uri?: string; mimeType?: string } };
      const fileUri = uploaded.file?.uri;
      if (!fileUri) {
        clearTimeout(timeoutHandle);
        return new Response(
          JSON.stringify({ error: 'Gemini upload returned no file URI', detail: JSON.stringify(uploaded).slice(0, 300), workerVersion: WORKER_VERSION }),
          { status: 502, headers: corsHeaders },
        );
      }
      parts.push({ file_data: { mime_type: uploaded.file?.mimeType || mimeType, file_uri: fileUri } });
    }
    parts.push({ text: prompt });

    const requestBody = {
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    };

    const genUrl = `${GEN_BASE}/${model}:generateContent?key=${context.env.GEMINI_KEY}`;
    const geminiRes = await fetch(genUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutHandle);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(
        JSON.stringify({
          error: `Gemini HTTP ${geminiRes.status} (${model})`,
          detail: errText.slice(0, 800),
          workerVersion: WORKER_VERSION,
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
  } catch (e) {
    clearTimeout(timeoutHandle);
    const isAbort = e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message));
    if (isAbort) {
      return new Response(
        JSON.stringify({
          error: `Gemini round-trip exceeded ${GEMINI_TIMEOUT_MS / 1000}s — try a smaller image or check API quota.`,
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
