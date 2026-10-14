'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extract parseIdeaMarkdown and findVariationsForIdea from public/app.js for testing
const appJsContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const parseMatch = appJsContent.match(/function parseIdeaMarkdown\([\s\S]*?\n\}/);
const lineageMatch = appJsContent.match(/function findVariationsForIdea\([\s\S]*?\n\}/);

const parseIdeaMarkdown = new Function(parseMatch[0] + '; return parseIdeaMarkdown;')();
const findVariationsForIdea = new Function('parseIdeaMarkdown', lineageMatch[0] + '; return findVariationsForIdea;')(parseIdeaMarkdown);

test('findVariationsForIdea resolves variations through branchLineage', () => {
  const mockState = {
    project: {
      stages: {
        idea: {
          data: {
            branchLineage: {
              '00_project/idea_v2.md': {
                parentArtifact: '00_project/idea_v1.md',
                parentIndex: 2,
                parentTitle: 'Test Parent Idea',
              }
            }
          }
        }
      }
    },
    ideaArtifactCache: {
      '00_project/idea_v2.md': `### Idea 1: Sub-variation 1\n- **Pitch:** Pitch 1\n- **Angle:** Angle 1\n- **Ratings:** Tension: 5/5 | Evidence: 5/5 | Visual: 4/5\n\n### Idea 2: Sub-variation 2\n- **Pitch:** Pitch 2\n- **Angle:** Angle 2\n- **Ratings:** Tension: 4/5 | Evidence: 4/5 | Visual: 5/5`
    },
    artifacts: [
      { relativePath: '00_project/idea_v1.md' },
      { relativePath: '00_project/idea_v2.md' }
    ]
  };

  // Run in mock context
  const fn = new Function('State', 'parseIdeaMarkdown', lineageMatch[0] + '; return findVariationsForIdea;')(mockState, parseIdeaMarkdown);
  const result = fn('00_project/idea_v1.md', 2, 'Test Parent Idea');

  assert.ok(result);
  assert.equal(result.targetArtifact, '00_project/idea_v2.md');
  assert.equal(result.versionNum, '2');
  assert.equal(result.variations.length, 2);
  assert.equal(result.variations[0].title, 'Sub-variation 1');
  assert.equal(result.variations[1].title, 'Sub-variation 2');
});

test('findVariationsForIdea falls back to content detection if branchLineage is not set', () => {
  const mockState = {
    project: {
      stages: {
        idea: {
          data: {} // no explicit branchLineage
        }
      }
    },
    ideaArtifactCache: {
      '00_project/idea_v2.md': `All six variations are rooted in the core premise of **Idea 2 ("Example premise")**\n\n### Idea 1: Example variation\n- **Pitch:** Distributed networks\n- **Angle:** Decentralization\n- **Ratings:** Tension: 5/5 | Evidence: 5/5 | Visual: 5/5`
    },
    artifacts: [
      { relativePath: '00_project/idea_v1.md' },
      { relativePath: '00_project/idea_v2.md' }
    ]
  };

  const fn = new Function('State', 'parseIdeaMarkdown', lineageMatch[0] + '; return findVariationsForIdea;')(mockState, parseIdeaMarkdown);
  const result = fn('00_project/idea_v1.md', 2, 'Example premise');

  assert.ok(result);
  assert.equal(result.targetArtifact, '00_project/idea_v2.md');
  assert.equal(result.versionNum, '2');
  assert.equal(result.variations.length, 1);
  assert.equal(result.variations[0].title, 'Example variation');
});
