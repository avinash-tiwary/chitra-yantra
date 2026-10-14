'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertId, assertProjectKey, assertRelativePath, resolveContained, safeEqual, parseCookies } = require('../lib/security');

test('identifiers reject separators and encoded traversal payloads', () => {
  assert.equal(assertId('example-channel-1'), 'example-channel-1');
  assert.equal(assertProjectKey('example-channel__example-topic-1'), 'example-channel__example-topic-1');
  for (const value of ['../x', 'x/y', '..', 'example-channel__../package']) assert.throws(() => value.includes('__') ? assertProjectKey(value) : assertId(value));
});

test('artifact paths stay within the real project directory', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-security-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chitra-outside-'));
  try {
    fs.writeFileSync(path.join(temporary, 'inside.txt'), 'ok');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'no');
    assert.equal(resolveContained(temporary, 'inside.txt', { mustExist: true }), fs.realpathSync(path.join(temporary, 'inside.txt')));
    for (const value of ['../secret.txt', '/etc/passwd', '..\\secret.txt']) assert.throws(() => assertRelativePath(value));
    fs.symlinkSync(outside, path.join(temporary, 'link'));
    assert.throws(() => resolveContained(temporary, 'link/secret.txt', { mustExist: true }));
    assert.throws(() => resolveContained(temporary, 'link/new.txt'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('malformed cookie encoding cannot crash request authentication', () => {
  assert.deepEqual(parseCookies('good=value; bad=%E0%A4%A'), { good: 'value', bad: '%E0%A4%A' });
});

test('constant-time token comparison handles invalid inputs', () => {
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('same', 'different'), false);
  assert.equal(safeEqual(null, 'same'), false);
});
