interface Env {
  GEMINI_KEY: string;
}

interface GeminiBody {
  prompt: string;
  imageBase64?: string;
  mimeType?: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const origin = context.request.headers.get('Origin') ?? '';

  const corsHeaders = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${context.env.GEMINI_KEY}`;

  let geminiRes: Response;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to reach Gemini' }), { status: 502, headers: corsHeaders });
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return new Response(JSON.stringify({ error: 'Gemini error', detail: errText }), { status: 502, headers: corsHeaders });
  }

  const data = await geminiRes.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return new Response(JSON.stringify({ result: text }), { status: 200, headers: corsHeaders });
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
