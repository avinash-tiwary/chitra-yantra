Plan music cues for the video: "{{VIDEO_TITLE}}"
Channel style: {{CHANNEL_STYLE}}
Approved narration versions: {{APPROVED_SCRIPT_PATHS}}
Editorial Blueprint: {{EDITORIAL_BLUEPRINT_PATH}}

Read the approved narration versions and Blueprint beats first. Music, ambience, and SFX are shared across language versions; narration takes are produced per approved language. For each planned music cue and any [MUSIC:] marker not yet represented:
1. Describe the mood and emotional arc
2. Suggest instrumentation appropriate to the channel's style
3. Specify tempo (BPM range)
4. Write a detailed music generation prompt for ACE-Step
5. Estimate duration in seconds

Use music only to support a documented emotional turn or scene change. Specify silence, room for breath, and dialogue ducking. Do not use generic “Indian” musical stereotypes or imply historical authenticity through instrumentation.

Quality rules:
- Treat the narration as the lead instrument. If a cue does not reveal a change in stakes, place, evidence, or emotional temperature, omit it.
- Never use a continuous wallpaper bed. Build entries, exits, rests, and silence around actual narration turns.
- Specify a mix risk for each cue: masking consonants, crowding pauses, accidental triumphalism, or false solemnity. Give the mixer one concrete mitigation.
- SFX must be motivated by a visible action or a clearly marked transition; do not add “cinematic” effects merely to signal importance.
- The plan must give a voice actor direction at turning points: pace, breath, intensity, and restraint. Do not request exaggerated devotional, trailer, or synthetic delivery unless the approved script explicitly requires it.

Output: JSON array of music cue objects, preserving beat IDs, timing anchors, silence, SFX, and dialogue-ducking direction.
Save to: {{PROJECT_PATH}}/03_audio/music/01_generation_prompts/music_cues.json
