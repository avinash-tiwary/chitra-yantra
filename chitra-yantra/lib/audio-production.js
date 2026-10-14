'use strict';

// The audio plan is intentionally plain JSON.  It is the boundary between the
// editorial agent, local inference workers and ffmpeg; no desktop audio tool
// or provider-specific workflow is part of a project.
const fs = require('node:fs');
const path = require('node:path');

function latestPlan(projectPath) {
  const directory = path.join(projectPath, '03_audio', 'plans');
  if (!fs.existsSync(directory)) return null;
  const files = fs.readdirSync(directory).filter((name) => /^audio_plan_v\d+\.json$/i.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return files.at(-1) || null;
}

function planVersion(filename) { return Number(String(filename || '').match(/_v(\d+)\./i)?.[1] || 0); }

function makePlan({ blueprint, title = '', version = 1, voiceProfile = 'default-clone', narrations = [] }) {
  const beats = Array.isArray(blueprint?.beats) ? blueprint.beats : [];
  const cues = new Map();
  const effects = [];
  for (const beat of beats) {
    const audio = beat.audio || {};
    const timing = beat.timing || {};
    const startSeconds = Number(timing.startSeconds || 0);
    const endSeconds = Number(timing.endSeconds || startSeconds);
    const cueId = String(audio.musicCueId || audio.musicBrief || '').trim();
    if (cueId) {
      const existingCue = cues.get(cueId);
      if (existingCue) existingCue.endSeconds = Math.max(existingCue.endSeconds, endSeconds);
      else cues.set(cueId, {
        id: cueId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80), type: 'music', provider: 'ace_step',
        brief: String(audio.musicBrief || cueId), startSeconds, endSeconds,
        narrationPriority: audio.narrationPriority !== false, status: 'planned', candidates: [], selectedAssetId: null,
      });
    }
    const sfx = audio.sfxBrief || audio.sfx;
    if (sfx && String(sfx).trim()) effects.push({
      id: `sfx_${String(beat.id || effects.length + 1).replace(/[^A-Za-z0-9_-]+/g, '_')}`,
      type: 'sfx', provider: 'ace_step', brief: String(sfx), startSeconds, endSeconds,
      narrationPriority: true, status: 'planned', candidates: [], selectedAssetId: null,
    });
  }
  return {
    schemaVersion: 1, title, version, createdAt: new Date().toISOString(),
    timingBasis: blueprint?.timing?.basis || 'script_estimate',
    voice: { profileId: voiceProfile, provider: 'higgs', status: 'planned', segments: [] },
    narrations: narrations.map((narration) => ({ ...narration, profileId: narration.profileId || voiceProfile, provider: narration.provider || 'higgs', status: 'planned', segments: [] })),
    cues: [...cues.values(), ...effects],
    mix: { sampleRate: 48000, reviewLufs: -14, truePeakDb: -1, narrationTargetLufs: -16, status: 'planned' },
    revisions: [],
  };
}

function affectedItems(plan, startSeconds, endSeconds) {
  const start = Number(startSeconds); const end = Number(endSeconds);
  const overlaps = (item) => Number(item.endSeconds || Infinity) >= start && Number(item.startSeconds || 0) <= end;
  return (plan.cues || []).filter(overlaps).map((item) => item.id);
}

function addCommentRevision(plan, { startSeconds, endSeconds, body }) {
  if (!Number.isFinite(Number(startSeconds)) || !Number.isFinite(Number(endSeconds)) || Number(endSeconds) < Number(startSeconds)) {
    throw new Error('A valid audio start and end time are required');
  }
  const text = String(body || '').trim();
  if (!text) throw new Error('An audio revision comment is required');
  const affected = affectedItems(plan, startSeconds, endSeconds);
  const revision = { id: `audio_comment_${Date.now()}`, startSeconds: Number(startSeconds), endSeconds: Number(endSeconds), body: text, affectedCueIds: affected, status: 'open', createdAt: new Date().toISOString() };
  plan.revisions = [...(plan.revisions || []), revision];
  for (const cue of plan.cues || []) if (affected.includes(cue.id)) cue.status = 'revision_requested';
  plan.mix = { ...(plan.mix || {}), status: 'revision_requested' };
  return revision;
}

module.exports = { latestPlan, planVersion, makePlan, affectedItems, addCommentRevision };
