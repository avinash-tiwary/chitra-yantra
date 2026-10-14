'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extract the parseIdeaMarkdown function for node testing
const appJsPath = path.resolve(__dirname, '..', 'public', 'app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');
const match = appJsContent.match(/function parseIdeaMarkdown\([\s\S]*?\n\}/);
if (!match) throw new Error('Could not find parseIdeaMarkdown in app.js');

const parseIdeaMarkdown = new Function(`${match[0]}; return parseIdeaMarkdown;`)();

test('parseIdeaMarkdown parses standard idea format correctly', () => {
  const sample = `
### Idea 1: How can a historical claim be tested?
- **Pitch:** An investigative inquiry into evidence and interpretation.
  
  Second paragraph of premise exploring competing explanations.
- **Angle:** Evidence vs. assumption: the limits of a compelling story.
- **Ratings:** Tension: 4/5 | Evidence: 5/5 | Visual: 5/5
- **Why Now:** Modern civilization grapples with bit-rot and AI.
- **Visuals:** Evidence cards and explanatory diagrams.

### Idea 2: What survives when archives are dispersed?
- **Pitch:** A dramatic investigation tracing the survival of distributed records.
- **Angle:** Centralized Archives vs. Decentralized Human Networks.
- **Ratings:** Tension: 5/5 | Evidence: 4/5 | Visual: 4/5
- **Why Now:** Cloud server vulnerabilities during geopolitical warfare.
- **Visuals:** Kinetic dynamic cartography of migration routes.

## Sources, Primary Evidence & Provenance Metadata
1. Example primary source
`;

  const ideas = parseIdeaMarkdown(sample);
  assert.equal(ideas.length, 2);

  const id1 = ideas[0];
  assert.equal(id1.index, 1);
  assert.equal(id1.title, 'How can a historical claim be tested?');
  assert.match(id1.pitch, /Second paragraph of premise/);
  assert.equal(id1.angle, 'Evidence vs. assumption: the limits of a compelling story.');
  assert.equal(id1.ratings.tension, '4');
  assert.equal(id1.ratings.evidence, '5');
  assert.equal(id1.ratings.visual, '5');
  assert.equal(id1.whyNow, 'Modern civilization grapples with bit-rot and AI.');
  assert.match(id1.visuals, /Evidence cards/);

  const id2 = ideas[1];
  assert.equal(id2.index, 2);
  assert.equal(id2.title, 'What survives when archives are dispersed?');
  assert.equal(id2.ratings.tension, '5');
});

test('parseIdeaMarkdown gracefully handles alternative bullet styles and missing fields', () => {
  const sample = `
### 1. An undeciphered writing system
**Pitch:** Testing a difficult classification problem through computational linguistics.
**Angle:** Script vs. Non-linguistic symbols.
**Why Now:** Recent AI attempts at decipherment.

### 2. A historical trade network
- **Premise:** How a trade network changed across regions and time.
- **Ratings:** Tension: 3/5, Evidence: 5/5, Visual: 4/5
`;

  const ideas = parseIdeaMarkdown(sample);
  assert.equal(ideas.length, 2);
  assert.equal(ideas[0].title, 'An undeciphered writing system');
  assert.equal(ideas[0].pitch, 'Testing a difficult classification problem through computational linguistics.');
  assert.equal(ideas[1].title, 'A historical trade network');
  assert.equal(ideas[1].pitch, 'How a trade network changed across regions and time.');
  assert.equal(ideas[1].ratings.tension, '3');
});
