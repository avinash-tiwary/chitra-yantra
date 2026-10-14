Extract and expand the shared visual asset requests from the approved canonical script: {{FINAL_SCRIPT_PATH}}. Check the approved narration versions at {{APPROVED_SCRIPT_PATHS}} for language-specific text overlays, but do not duplicate visual assets for English and Hindi.

For each visual cue marker in the script:
- [GEN: ...] → Expand to a detailed image generation prompt. Specify: period, location, lighting, composition, art style, emotional tone. No anachronisms.
- [ART: ...] → Search for real historical artwork on Wikimedia Commons. Provide best match URL.
- [MAP: ...] → Describe the precise map needed, or locate an existing one on Wikimedia Commons.
- [PHOTO: ...] → Search Wikimedia Commons and government archives for authentic photographs.

Quality rules:
- A visual is successful only when it makes the current sentence easier to understand or remember. Never generate an attractive but non-evidentiary “ancient India” illustration as a substitute for a source, map, or comparison.
- Preserve one coherent art direction per episode. Prompts must name camera distance, subject hierarchy, negative space for captions, and what must not appear; avoid the default centered deity/warrior tableau.
- For sources and artifacts, prefer a legible, provenance-labeled detail over a generic full-frame image. For reconstructions, include the exact on-screen AI-reconstruction disclosure.
- Before rendering, reject any prompt with invented inscriptions, unreadable pseudo-text, anachronistic costume or architecture, or a visual claim stronger than the narration can support.
- Thumbnail imagery must communicate the episode’s actual comparison or evidence question in one glance; it cannot rely on alarm, sacred spectacle, or vague “mystery” styling.

Image generation: Render visual assets using the local FLUX.1 engine (`tools/render_visuals.py`).
Save generated assets to 04_visuals/renders/ with filename format: ASSET_{sequence_number}.png

Create these output files:
- Read the latest `04_visuals/plans/asset_plan_v{n}.json`; keep each plan version immutable. Rendered assets update fields:
  { "id": "ASSET_001", "type": "GEN|ART|MAP|PHOTO", "description": "...", "prompt": "...", "generatedPath": "04_visuals/renders/ASSET_001.png", "resolution": "1280x720", "upscaled": false, "approvalStatus": "pending" }
- 04_visuals/thumbnails/brief.md — thumbnail concept with visual direction and generation prompt

Project path: {{PROJECT_PATH}}
