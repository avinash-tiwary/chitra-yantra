'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makePlan, addCommentRevision } = require('../lib/audio-production');

test('audio plan derives deterministic music and effect cues from blueprint beats', () => {
  const plan = makePlan({ title: 'Test', version: 2, voiceProfile: 'my-clone', blueprint: { timing: { basis: 'voice_reconciled' }, beats: [
    { id: 'B01', timing: { startSeconds: 0, endSeconds: 12 }, audio: { musicCueId: 'C01', musicBrief: 'quiet strings', sfxBrief: 'room tone' } },
  ] } });
  assert.equal(plan.version, 2);
  assert.equal(plan.voice.profileId, 'my-clone');
  assert.deepEqual(plan.cues.map((item) => item.type), ['music', 'sfx']);
});

test('a recurring music cue spans all of its assigned beats', () => {
  const plan = makePlan({ blueprint: { beats: [
    { id: 'B01', timing: { startSeconds: 0, endSeconds: 8 }, audio: { musicCueId: 'M01', musicBrief: 'quiet inquiry' } },
    { id: 'B02', timing: { startSeconds: 8, endSeconds: 16 }, audio: { musicCueId: 'M01', musicBrief: 'quiet inquiry' } },
  ] } });
  const cue = plan.cues.find((item) => item.id === 'M01');
  assert.deepEqual({ start: cue.startSeconds, end: cue.endSeconds }, { start: 0, end: 16 });
});

test('time-ranged audio comments mark only overlapping cues for revision', () => {
  const plan = makePlan({ blueprint: { beats: [
    { id: 'B01', timing: { startSeconds: 0, endSeconds: 10 }, audio: { musicCueId: 'opening' } },
    { id: 'B02', timing: { startSeconds: 12, endSeconds: 20 }, audio: { musicCueId: 'ending' } },
  ] } });
  const revision = addCommentRevision(plan, { startSeconds: 11, endSeconds: 14, body: 'Make this guitar, not flute' });
  assert.deepEqual(revision.affectedCueIds, ['ending']);
  assert.equal(plan.cues.find((item) => item.id === 'ending').status, 'revision_requested');
  assert.equal(plan.cues.find((item) => item.id === 'opening').status, 'planned');
});
