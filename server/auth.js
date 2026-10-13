/**
 * auth.js - API authentication helpers.
 *
 * Local desktop use remains tokenless. A non-loopback listener must provide
 * EDUOWL_AUTH_TOKEN; clients may send Bearer/X-Auth-Token or use browser Basic Auth.
 */

const crypto = require('crypto');

function configuredToken() {
  const token = String(process.env.EDUOWL_AUTH_TOKEN || '').trim();
  return token || null;
}

function isLoopbackAddress(address) {
  const value = String(address || '');
  return value === '127.0.0.1'
    || value === '::1'
    || value === '::ffff:127.0.0.1'
    || value.startsWith('127.');
}

function equalSecret(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestToken(req) {
  const headers = req && req.headers ? req.headers : {};
  const authorization = String(headers.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  if (/^Basic\s+/i.test(authorization)) {
    try {
      const decoded = Buffer.from(authorization.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
      const split = decoded.indexOf(':');
      return split >= 0 ? decoded.slice(split + 1) : '';
    } catch (_) {
      return '';
    }
  }
  return String(headers['x-auth-token'] || '').trim();
}

function authenticate(req) {
  const expected = configuredToken();
  if (!expected) return { ok: true, enabled: false };
  return { ok: equalSecret(requestToken(req), expected), enabled: true };
}

function challengeHeaders() {
  return { 'WWW-Authenticate': 'Basic realm="EduPilot"' };
}

module.exports = { configuredToken, isLoopbackAddress, authenticate, challengeHeaders };
