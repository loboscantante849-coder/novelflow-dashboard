/**
 * Vercel Edge Function middleware (legacy, framework-agnostic)
 * Overrides CORS headers after Vercel's default injection
 */
const ALLOWED_ORIGINS = new Set([
  'https://novelflow.top',
  'https://www.novelflow.top',
  'https://dash.novelflow.app',
  'https://novelflow.app',
  'https://novelflow-dashboard.vercel.app',
]);

export default function middleware(request) {
  const origin = request.headers.get('origin');
  const isAllowed = origin && (ALLOWED_ORIGINS.has(origin) || /^http:\/\/localhost:\d{1,5}$/.test(origin));

  // OPTIONS preflight: handle entirely at edge
  if (request.method === 'OPTIONS') {
    const headers = new Headers({
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
    });
    if (isAllowed) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Vary', 'Origin');
    }
    return new Response(null, { status: 204, headers });
  }

  // For other requests, let the function handle it, then fix response CORS
  return fetch(request, { redirect: 'manual' }).then(response => {
    const newResponse = new Response(response.body, response);
    if (isAllowed) {
      newResponse.headers.set('Access-Control-Allow-Origin', origin);
      newResponse.headers.set('Vary', 'Origin');
      // Preserve credentials from function response
    } else {
      newResponse.headers.delete('Access-Control-Allow-Origin');
      newResponse.headers.delete('Access-Control-Allow-Credentials');
    }
    return newResponse;
  });
}

export const config = {
  runtime: 'edge',
};
