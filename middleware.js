/**
 * Vercel Edge Middleware (pure Web API, no Next.js dependency)
 * 
 * Fixes the Vercel auto-injected "Access-Control-Allow-Origin: *" which creates
 * dangerous '*' + 'credentials:true' combo.
 */

const ALLOWED_ORIGINS = new Set([
  'https://novelflow.top',
  'https://www.novelflow.top',
  'https://dash.novelflow.app',
  'https://novelflow.app',
  'https://novelflow-dashboard.vercel.app',
]);

const LOCALHOST_RE = /^http:\/\/localhost:\d{1,5}$/;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin) || LOCALHOST_RE.test(origin);
}

export default function middleware(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return;

  const origin = request.headers.get('origin');
  const allowed = isAllowedOrigin(origin);

  // OPTIONS preflight handled entirely at edge
  if (request.method === 'OPTIONS') {
    const h = new Headers();
    if (allowed) {
      h.set('Access-Control-Allow-Origin', origin);
      h.set('Access-Control-Allow-Credentials', 'true');
      h.set('Vary', 'Origin');
    }
    h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    h.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: h });
  }

  // Non-OPTIONS: fetch the actual function response, then fix CORS
  return fetch(request).then(response => {
    const newResp = new Response(response.body, response);
    // Remove Vercel's auto-injected wildcard
    newResp.headers.delete('Access-Control-Allow-Origin');
    newResp.headers.delete('Access-Control-Allow-Credentials');
    if (allowed) {
      newResp.headers.set('Access-Control-Allow-Origin', origin);
      newResp.headers.set('Vary', 'Origin');
      // Let individual API functions set credentials when they need it
      // (they set it via setHeader in Node; Vercel forwards those headers)
    }
    return newResp;
  });
}

export const config = {
  matcher: ['/api/:path*'],
};
