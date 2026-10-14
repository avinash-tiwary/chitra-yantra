You are assembling the final video for: "{{VIDEO_TITLE}}"
Channel: {{CHANNEL_NAME}}

Available assets:
- Voice narration: {{VOICE_PATH}}
- Background music: {{MUSIC_PATH}}
- Visual assets directory: {{VISUALS_DIR}}
- Editorial Blueprint: {{EDITORIAL_BLUEPRINT_PATH}}

Creative intent:
- The voice is the primary anchor. Visuals illustrate and amplify — they do not compete.
- Transitions should feel like turning a page — clean and unhurried.
- Background music should be present but invisible: the viewer feels it, not hears it over narration.
- The approved Blueprint is the timing and motion contract. Do not distribute images evenly.
- Each image should linger long enough to absorb but not so long it stalls momentum.
- Use the Blueprint’s deliberate Ken Burns movement, source cards, text reveals, map routes, and silence; do not add generic motion.
- The overall rhythm should match the narration's pace — slower for reflective moments, tighter for revelatory ones.

Output:
1. First create a storyboard plan at 05_edit/storyboard.json with this structure:
   [{ "label": "Scene name", "assetFile": "filename.png", "startTime": "00:00", "endTime": "00:45", "notes": "brief note on visual treatment" }]
2. Assemble the final video and save to: 05_edit/assembled_v01.mp4
3. Target: 1920x1080, broadcast quality. Use whatever tools you determine best for this task.

Project path: {{PROJECT_PATH}}
