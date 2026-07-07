import { NextResponse } from 'next/server';

const ALLOWED_ORIGINS = new Set([
  'https://novelflow.top',
  'https://www.novelflow.top',
  'https://dash.novelflow.app',
  'https://novelflow.app',
  'https://novelflow-dashboard.vercel.app',
]);

const LOCALHOST_RE = /^http:\/\/localhost:\d{1,5}$/;

function getAllowedOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (LOCALHOST_RE.test(origin)) return origin;
  return null;
}

export default function middleware(request) {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const origin = request.headers.get('origin');
  const allowedOrigin = getAllowedOrigin(origin);

  // OPTIONS preflight → short-circuit at edge
  if (request.method === 'OPTIONS') {
    const headers = new Headers({
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
    });
    if (allowedOrigin) {
      headers.set('Access-Control-Allow-Origin', allowedOrigin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.set('Vary', 'Origin');
    }
    return new Response(null, { status: 204, headers });
  }

  // Normal request: let function run, then fix CORS headers on the response
  const response = NextResponse.next();

  if (allowedOrigin) {
    response.headers.set('Access-Control-Allow-Origin', allowedOrigin);
    response.headers.set('Vary', 'Origin');
    // Note: credentials is set by the function itself for auth endpoints;
    // middleware doesn't add it globally
  } else {
    response.headers.delete('Access-Control-Allow-Origin');
    response.headers.delete('Access-Control-Allow-Credentials');
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
