'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coreClaimClearsVerification } = require('../lib/research-validation');

test('an explicitly non-blocking barred core claim is quarantined rather than blocking research approval', () => {
  const claim = {
    id: 'CLM-070', class: 'core', status: 'not_factual',
    verification: { blocking: false, reason: 'This comparison is barred from production.' },
  };
  assert.equal(coreClaimClearsVerification(claim), true);
});

test('unverified or blocking core claims remain approval blockers', () => {
  assert.equal(coreClaimClearsVerification({ class: 'core', status: 'unsupported', verification: { blocking: false } }), false);
  assert.equal(coreClaimClearsVerification({ class: 'core', status: 'not_factual', verification: { blocking: true, reason: 'Unresolved' } }), false);
  assert.equal(coreClaimClearsVerification({ class: 'core', status: 'verified', verification: { blocking: true } }), false);
});
