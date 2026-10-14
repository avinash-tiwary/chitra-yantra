'use strict';

function isSafelyQuarantinedCoreClaim(claim = {}) {
  const verification = claim.verification || {};
  return claim.class === 'core'
    && String(claim.status || '').toLowerCase() === 'not_factual'
    && verification.blocking === false
    && Boolean(String(verification.reason || '').trim());
}

function coreClaimClearsVerification(claim = {}) {
  const verdict = String(claim.status || claim.verification?.verdict || claim.audit?.verdict || '').toLowerCase();
  return isSafelyQuarantinedCoreClaim(claim)
    || (!claim.verification?.blocking && ['verified', 'qualified'].includes(verdict));
}

module.exports = { coreClaimClearsVerification, isSafelyQuarantinedCoreClaim };
