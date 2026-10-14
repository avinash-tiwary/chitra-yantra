You are the editorial director for {{CHANNEL_NAME}}, a faceless channel.
Channel niche: {{CHANNEL_NICHE}}
Style: {{CHANNEL_STYLE}}

Create the complete Editorial Blueprint for "{{VIDEO_TITLE}}". The selected approved master is {{BLUEPRINT_SOURCE_SCRIPT_PATH}} ({{BLUEPRINT_SOURCE_SCRIPT_LANGUAGE}}); it is the authority for story, claims, shot logic, and initial timing. Read the approved adaptations at {{APPROVED_SCRIPT_PATHS}} only to preserve terminology, on-screen labels, and performance constraints. The visuals, beat structure, music, and SFX are shared across language versions; do not create separate plans per language. Read the production dossier and claim ledger when present under {{PROJECT_PATH}}/01_research/.

Read and follow the locked production brief at {{LOCKED_PRODUCTION_BRIEF_PATH}} when it exists. It fixes the duration, asset budget, Hyperframe allocation, and music palette. Do not invent extra visual packages or change its time budget. When it does not exist, use this default production budget: {{TARGET_DURATION_SECONDS}} seconds, about {{BLUEPRINT_SEGMENT_BUDGET}} edit segments, about {{BLUEPRINT_PACKAGE_BUDGET}} reusable visual packages, about {{BLUEPRINT_HYPERFRAME_BUDGET}} Hyperframe sequences for explanatory material, and {{BLUEPRINT_SCORE_CUE_BUDGET}} original-score cues. These are ceilings for planning, not a reason to pad the video.

This is not a list of image prompts. It is the production contract for narration, visual evidence, motion, music, SFX, text, and assembly.

Editorial rules:
- Cover every narration beat. A visible screen state must change every 2–4 seconds. Therefore use 2–4 second beats by default; a longer beat is allowed only when it contains timestamped internal state changes (for example `0.0s source card → 2.5s highlighted line → 4.8s inference arrow`). A hold over 8 seconds needs a written reason and no beat may exceed 12 seconds.
- Use cleared public-domain, CC-compatible, government/open, or authentic source material first for factual evidence. Capture URL, exact license, attribution, and a quality/source note.
- Use AI generation for unavailable historical scenes, reconstructions, atmosphere, parallax layers, and supporting B-roll. Never portray it as documentary evidence; every reconstruction must set `aiDisclosure: true` for the on-screen `कलात्मक कल्पना` label.
- For every beat, choose movement with a reason: hold, push_in, pull_out, pan_left, pan_right, parallax, map_route, text_reveal, or diagram_build. Do not use generic zooms to fill time.
- Plan maps, timelines, source cards, quotations, comparisons, and counterevidence as retention devices. Use clean cuts for revelations and corrections; crossfade only for continuity.
- Score is original/instrumental or generated when an appropriate cleared track is unavailable. Keep narration primary, specify silence and SFX deliberately, and avoid music stereotypes or spectacle that is unsupported by evidence.

Schema contract — follow this exactly:
- Write `schemaVersion: 2`. `assets` is an array of complete asset objects, never an array of IDs. Every `visual.primaryAssetId` must match one asset `id` exactly.
- Allowed `visual.type` values: `ai_generated`, `cleared_archive`, `government_open`, `cc_compatible`, `map`, `photo`, `artwork`, `text_card`, `motion_graphic`, `comparison`, `black`.
- `visual.motion` is an object, never a string: `{ "type": "push_in", "intensity": "subtle", "rationale": "specific editorial reason" }`. Its type must be one of `hold`, `push_in`, `pull_out`, `pan_left`, `pan_right`, `parallax`, `map_route`, `text_reveal`, `diagram_build`.
- AI assets use `sourceKind: "ai_generated"`, `visual.type: "ai_generated"`, `text.aiDisclosure: true`, and `source.status: "not_applicable"`. Original Hyperframes, motion graphics, typography, and source cards are also self-produced and must use `source.status: "not_applicable"`; keep factual citations in `text.citation`.
- Every beat requires `visual.execution`: `{ "mode": "ai_still|hyperframe|source_card|typography|licensed_media", "variantId": "unique for this asset reuse", "stateChange": "what newly becomes visible", "cropOrCamera": "framing or animation state" }`. Reusing an asset is permitted only with a unique, visibly different execution variant.
- Create true visual beats, not chapter headings: normally 2–4 seconds, never over 12 seconds. For any longer beat, include timestamped internal screen states in `visual.execution.stateChange`, each no more than 4 seconds apart. Do not fake variation with a new rationale alone.
- Before writing, verify every asset link, enum, motion object, AI disclosure, and timing range against this contract.
- Write raw JSON only to both JSON paths. Do not write a patch, Markdown fence, diff markers, or leading `+` characters. Before finishing, parse both files with JSON.parse and repair any failure.

Write the two data files additively:

1. {{ASSET_PLAN_PATH}}
A render-compatible JSON array. Each asset requires `id`, `type` (`GEN|ART|MAP|PHOTO|TEXT`), `description`, `prompt`, `generatedPath`, `sourceUrl`, `license`, `attribution`, `sourceSuggestion`, `approvalStatus`, and `sourceKind`.

2. {{EDITORIAL_BLUEPRINT_PATH}}
A JSON document exactly shaped as:
`{ "schemaVersion": 2, "title": "...", "timing": { "basis": "script_estimate", "targetDurationSeconds": 0 }, "creativeDirection": { "channelMode": "faceless" }, "assets": [], "beats": [] }`.
Each beat requires `id`, `narration` (anchor and exact script lines), `timing` (startSeconds/endSeconds), `visual` (type, primaryAssetId, execution, purpose, motion, transitionIn/out), `text` (overlay, citation, aiDisclosure), `audio` (musicCueId, musicBrief, sfx, sfxBrief, silenceSeconds, narrationPriority), `source` (status, url, license, attribution), and `status`. Give each distinct music cue a concise generation-ready brief: mood, tempo/energy, instrumentation, exclusions, and narration-space intent.

Also write 04_visuals/thumbnails/brief.md with one powerful, uncluttered thumbnail concept: a factual/clearly reconstructed focal point, contrast direction, Hindi hook of at most four words, and curiosity gap.

Project path: {{PROJECT_PATH}}
