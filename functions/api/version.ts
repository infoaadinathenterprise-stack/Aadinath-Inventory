// Tiny diagnostic endpoint. Hit /api/version in a browser to check
// which build of the Pages Functions is actually live. If you see the
// expected version string, the deploy went through; if you see a 404
// or an older version, the function deploy is stale and you need to
// trigger a redeploy from the Cloudflare Pages dashboard.
//
// Bump the version below whenever you push a real change so you can
// always tell whether your code is running.

export const onRequest: PagesFunction = async () => {
  return new Response(
    JSON.stringify({
      version: 'v6-2026-05-09-text-only',
      builtAt: 'gemini.ts: text-only proxy (browser does OCR via OCR.space first)',
      time: new Date().toISOString(),
    }, null, 2),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Worker-Version': 'v6-2026-05-09-text-only',
      },
    },
  );
};
