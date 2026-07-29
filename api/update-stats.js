/**
 * Retired compatibility endpoint. No implementation or infrastructure details
 * are returned to callers.
 */

'use strict';

const { setCORSHeaders } = require('./_lib/cors');

module.exports = async (req, res) => {
  setCORSHeaders(req, res, { methods: 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({ error: 'Endpoint retired' });
};
