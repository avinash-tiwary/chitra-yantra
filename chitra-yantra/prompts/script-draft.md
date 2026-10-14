Write a full {{SCRIPT_WORKFLOW_MODE}} for: "{{VIDEO_TITLE}}"
Channel: {{CHANNEL_NAME}} | Output language: {{SCRIPT_LANGUAGE}}
Channel promise: {{CHANNEL_PROMISE}}
Audience: {{CHANNEL_AUDIENCE}}
Storytelling style: {{CHANNEL_STORYTELLING_STYLE}}
Based on outline: {{OUTLINE_PATH}}
Primary research dossier: {{RESEARCH_MASTER_PATH}}
Script-safe production brief: {{RESEARCH_PRODUCTION_PATH}}
Original research passes: {{RESEARCH_PASSES_PATH}}
Target: {{WORD_COUNT}} words
Parent script, if this is a revision or adaptation: {{PARENT_SCRIPT_PATH}}
Parent script language: {{PARENT_SCRIPT_LANGUAGE}}

Rules:
- {{SCRIPT_LANGUAGE_INSTRUCTIONS}}
- For Hindi narration: {{SCRIPT_LANGUAGE_REGISTER}} {{SCRIPT_LANGUAGE_LEXICAL_POLICY}}
- If a parent script is supplied in another language, create an adaptive branch: preserve its claim boundaries, emotional arc, pacing, visual markers, and citations, but rewrite naturally rather than translating sentence by sentence. If it is supplied in the same language, treat it as a revision branch and preserve what remains sound.
- Never start with a generic introduction; start in media res with a concrete, intelligible situation.
- Make the evidence trail visible: distinguish what a source says, what the episode infers, and what remains uncertain. Explain each necessary technical term in plain language on first use; do not use terminology as a substitute for explanation.
- Sustain a plot-led investigation: every major section must either raise the stakes, test an earlier conclusion, introduce a meaningful disagreement, or change what the viewer can responsibly conclude.
- Embed visual cue markers inline: [MAP:], [ART:], [GEN:], [PHOTO:], [TEXT:], [MUSIC:]
- Label all AI-generated visuals with the appropriate disclaimer instruction
- End with a bibliography section (sources read on screen)
- Use the production brief as the factual release gate. Consult the master dossier and original passes for nuance, but do not revive a claim barred by verification.
- Every factual claim must retain a direct source link from the research outputs.
- Never put a URL or Markdown citation inside a `**NARRATION:**` block. Put source metadata on a separate editor-only `[SOURCE: concise claim — URL]` line immediately after the supported passage, and retain the bibliography. Do not invent a quotation, source locator, asset, or historical reconstruction.

Revision standard:
- Treat the supplied revision direction as an independent editorial brief. Repair every concrete finding, not just the easiest one.
- Do not lengthen the script merely to sound more complete. Replace weak material with stronger scenes, evidence, or reasoning; cut material that cannot earn its time.
- Preserve the title’s promise and improve the first 30 seconds before polishing later sections.
- After revision, internally re-read for unsupported claims, repeated conclusions, generic AI phrasing, and lines that cannot be spoken naturally in one breath.

Save to: {{DRAFT_PATH}}
