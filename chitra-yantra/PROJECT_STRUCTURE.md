# Chitra Yantra Project Structure — Schema v4

Every production workspace lives at `channels/{channel}/videos/{project}/`. The filesystem is the source of truth for material availability; the database stores workflow decisions, run history, and stage approvals.

```text
channels/{channel}/videos/{project}/
├── project.json                         # { "schemaVersion": 4 }
├── README.md
├── 00_project/
│   ├── project_brief.md                 # core question, audience promise
│   └── idea_v1.md                       # idea_v{n}.md
├── 01_research/
│   └── corpus/
│       ├── synthesis_v1.md              # required synthesized view
│       ├── sources.md                   # source citations & bibliography
│       ├── claim_ledger.json            # atomic verifiable claims
│       └── imported/                    # pasted PDFs, notes, CSV, JSON, HTML
├── 02_script/
│   ├── outline_v1.md
│   ├── draft_v1.md
│   └── final_v1.md                      # locked script with [MAP:], [GEN:], [ART:] cues
├── 03_audio/
│   ├── takes/                           # voice takes (Higgs TTS / human voiceover)
│   ├── music/                           # soundtrack cues (ACE-Step / YuE)
│   └── mixes/                           # -14 LUFS master mix (final_mix.wav)
├── 04_visuals/
│   ├── plans/
│   │   ├── asset_plan_v1.json           # visual cue plan
│   │   └── prompts.md                   # generated FLUX/SDXL prompts
│   ├── renders/                         # 4x upscaled visual assets (ASSET_001.png)
│   └── thumbnails/
│       ├── brief.md                     # thumbnail concept
│       └── final.png                    # approved thumbnail
├── 05_edit/
│   ├── review_exports/                  # assembled draft cut
│   └── final_exports/                   # final master 1080p/4K MP4
├── 06_publish/
│   ├── metadata.json                    # YouTube title, description, tags
│   ├── chapters.md                      # formatted timestamps
│   ├── subtitles/                       # hi.srt, hi.vtt
│   └── analytics/                       # post-release performance logs
└── 99_archive/                          # previous iterations and backups
```

## Production Principles

- **Schema Version**: Schema v4 is the standard project layout.
- **Additive Versions**: Runs produce new versions (`v1`, `v2`, `v3`) without destroying prior work.
- **Corpus Integrity**: Research is an evidence-backed corpus (`01_research/corpus/`), not a single loose file.
- **Audio Standards**: Narration-locked loudness standard `-14.0 LUFS (±0.5)` and True Peak `≤ -1.5 dBTP`.
