const assert = require('node:assert/strict');
const test = require('node:test');

const { invoke } = require('./helpers/endpoint');

const tokenPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
process.env.NOVELSPA_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${tokenPayload}.test-signature`;
delete process.env.OIDC_USERNAME;
delete process.env.OIDC_PASSWORD;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const detail = require('../api/books/detail');

test('book detail accepts the bookstore nested list response', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async url => {
    requestedUrl = String(url);
    return ({
    ok: true,
    json: async () => ({ data: { data: [{ bookId: 'book-1', title: 'Title' }] } }),
    });
  };

  try {
    const res = await invoke(detail, {
      method: 'GET',
      query: { bookId: 'book-1', lang: 'en' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.bookId, 'book-1');
    const query = new URL(requestedUrl).searchParams;
    assert.equal(query.get('bookIds'), 'book-1');
    assert.equal(query.has('bookId'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('book detail returns 404 for an empty bookstore response', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { data: [] } }) });

  try {
    const res = await invoke(detail, {
      method: 'GET',
      query: { bookId: 'missing', lang: 'en' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  } finally {
    global.fetch = originalFetch;
  }
});

test('book detail rejects an unrelated first result when the upstream ignores bookId', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { data: [{ bookId: 'different-book', title: 'Wrong Title' }] } }),
  });

  try {
    const res = await invoke(detail, {
      method: 'GET',
      query: { bookId: 'requested-book', lang: 'en' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
  } finally {
    global.fetch = originalFetch;
  }
});
