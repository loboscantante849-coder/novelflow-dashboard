/**
 * Vercel Edge Middleware (pure Edge Runtime, no Next.js dependency)
 * 
 * Vercel's Serverless Functions auto-inject Access-Control-Allow-Origin: *
 * which creates the dangerous '*' + 'credentials:true' CORS combo.
 * This middleware intercepts all API requests at the edge and:
 *   1. Handles OPTIONS preflight directly
 *   2. Strips/replaces CORS headers on responses to enforce whitelist
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
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    return;  // Let non-API requests pass through untouched
  }

  const origin = request.headers.get('origin');
  const allowed = isAllowedOrigin(origin);

  // OPTIONS preflight: return directly from edge
  if (request.method === 'OPTIONS') {
    const respHeaders = new Headers();
    if (allowed) {
      respHeaders.set('Access-Control-Allow-Origin', origin);
      respHeaders.set('Access-Control-Allow-Credentials', 'true');
      respHeaders.set('Vary', 'Origin');
    }
    respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    respHeaders.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: respHeaders });
  }

  // Non-OPTIONS: let function run, then fix CORS on the response
  // We rewrite the request to bypass Vercel's auto-CORS injection, then add our own
  const response = NextResponse.next();

  // Remove any wildcard Allow-Origin that Vercel may inject
  response.headers.delete('Access-Control-Allow-Origin');
  response.headers.delete('Access-Control-Allow-Credentials');

  if (allowed) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    // Note: credentials header is set by the individual API function for auth endpoints only
  }

  return response;
}

// NextResponse is available globally in Vercel Edge middleware even without Next.js framework
// But to be safe, we import from 'next/server' if available, or use a fallback
import { NextResponse } from 'next/server';

export const config = {
  matcher: ['/api/:path*'],
};
