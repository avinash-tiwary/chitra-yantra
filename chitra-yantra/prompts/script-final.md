Write the polished final {{SCRIPT_WORKFLOW_MODE}} for: "{{VIDEO_TITLE}}"
Channel: {{CHANNEL_NAME}}
Output language: {{SCRIPT_LANGUAGE}}
Channel promise: {{CHANNEL_PROMISE}}

Apply the fact-check report at: {{FACTCHECK_PATH}}
Draft to revise: {{DRAFT_PATH}}

Rules:
- {{SCRIPT_LANGUAGE_INSTRUCTIONS}}
- For Hindi narration: {{SCRIPT_LANGUAGE_REGISTER}} {{SCRIPT_LANGUAGE_LEXICAL_POLICY}}
- Same as draft, but corrected, refined, and tightened.
- Preserve the draft's factual claim boundaries and its editor-only `[SOURCE:]` metadata. A fact-check travels with an adaptive language branch when those claim boundaries and source tags are preserved; do not invent, remove, or broaden claims.
- Every UNSOURCED claim identified in the supplied report must be rewritten or removed.
- Every ARTISTIC section must be labeled.
- Embed visual cue markers: [MAP:], [ART:], [GEN:], [PHOTO:], [TEXT:], [MUSIC:]
- Maintain tone and narrative flow throughout.
- If this is an adaptation, keep the source script's emotional cadence while making the spoken {{SCRIPT_LANGUAGE}} natural rather than literal.

Save to: {{FINAL_SCRIPT_PATH}}
