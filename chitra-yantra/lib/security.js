'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SAFE_PROJECT_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}__[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;

function assertId(value, label = 'identifier') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400 });
  }
  return value;
}

function assertProjectKey(value) {
  if (typeof value !== 'string' || !SAFE_PROJECT_KEY.test(value)) {
    throw Object.assign(new Error('Invalid project key'), { statusCode: 400 });
  }
  return value;
}

function parseProjectKey(value) {
  const key = assertProjectKey(value);
  const separator = key.indexOf('__');
  return { key, channelId: key.slice(0, separator), slug: key.slice(separator + 2) };
}

function assertRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) {
    throw Object.assign(new Error('Invalid artifact path'), { statusCode: 400 });
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw Object.assign(new Error('Artifact path escapes the project'), { statusCode: 400 });
  }
  return normalized;
}

function resolveContained(root, relative, { mustExist = false } = {}) {
  const rootReal = fs.realpathSync(root);
  const safeRelative = assertRelativePath(relative);
  const candidate = path.resolve(rootReal, safeRelative);
  const relativeToRoot = path.relative(rootReal, candidate);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw Object.assign(new Error('Path escapes the allowed project root'), { statusCode: 400 });
  }
  if (mustExist) {
    const real = fs.realpathSync(candidate);
    const realRelative = path.relative(rootReal, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw Object.assign(new Error('Resolved path escapes the allowed project root'), { statusCode: 400 });
    }
    return real;
  }
  // Writes must also reject an existing symlink anywhere in the parent chain.
  // Checking only the lexical path would allow `project/link/new.txt` to escape.
  let existingAncestor = candidate;
  while (!fs.existsSync(existingAncestor) && existingAncestor !== rootReal) {
    existingAncestor = path.dirname(existingAncestor);
  }
  const ancestorReal = fs.realpathSync(existingAncestor);
  const ancestorRelative = path.relative(rootReal, ancestorReal);
  if (ancestorRelative.startsWith('..') || path.isAbsolute(ancestorRelative)) {
    throw Object.assign(new Error('Resolved path escapes the allowed project root'), { statusCode: 400 });
  }
  return candidate;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    const raw = part.slice(index + 1);
    try { return [part.slice(0, index), decodeURIComponent(raw)]; }
    catch { return [part.slice(0, index), raw]; }
  }));
}

module.exports = {
  assertId, assertProjectKey, parseProjectKey, assertRelativePath, resolveContained,
  randomToken, safeEqual, parseCookies,
};
