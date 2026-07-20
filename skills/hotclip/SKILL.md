---
name: hotclip
description: Turn long videos & livestream VODs into viral vertical shorts, 100% locally — on-device transcription, LLM highlight detection, 9:16 reframe with karaoke captions, and a per-clip render-QA report. Use when the user asks to clip / cut / 切片 / 剪 a long video, podcast or stream replay into short clips, find highlights / 爆点 in a video, or transcribe a media file. Footage never leaves the machine.
---

# HotClip — local AI clipping pipeline

HotClip（AGPL-3.0 开源）把几小时的直播回放/播客/课程切成可直接发布的竖屏短视频,全程本地运行。You drive the same pipeline the desktop app uses, via a headless CLI (or the bundled MCP server). Everything — ASR, highlight detection, cutting, caption burn-in — runs on this machine; the footage is never uploaded.

## Setup (once)

1. Repo + deps (skip what already exists):
   ```bash
   git clone https://github.com/xixihhhh/hotclip.git && cd hotclip
   pnpm install   # ffmpeg/ffprobe are bundled npm binaries — nothing else to install
   ```
2. LLM config for highlight detection, via env vars (any OpenAI-compatible endpoint):
   ```bash
   export HOTCLIP_LLM_BASE_URL=http://localhost:11434/v1   # local Ollama (no key needed)
   export HOTCLIP_LLM_MODEL=qwen3:8b
   # cloud endpoints additionally need: export HOTCLIP_LLM_API_KEY=sk-...
   ```
   If these are missing, ask the user which LLM endpoint to use — do not guess keys.
3. First `transcribe`/`clip` run auto-downloads the ASR model (~1GB, CN mirror first). Warn the user it may take a few minutes once.

## Commands (run from the repo root)

```bash
pnpm cli transcribe <video>                    # on-device word-level ASR (cached; instant on re-run)
pnpm cli highlights <video> [--max-clips N] [--reference REF] [--json]   # AI highlight candidates — review before cutting
pnpm cli clip <video> [--max-clips N] [--reference REF] [--no-vertical] [--no-captions] [--out DIR] [--json]
                                               # fully managed: transcribe → detect → export + render-QA
```

`--reference <video>`: hand in a viral clip to model after — its pacing (duration / speech rate / shot-cut frequency / hook shape) is measured locally and steers candidate selection as a preference (never a hard rule). Use when the user says "切得像这条" / "learn from this clip".

Input: MP4 / MKV / MOV / FLV / TS, or audio-only (podcasts get an auto-generated waveform video). Paths with spaces need quoting.

## Recommended workflow

1. **Review-first (default for interactive sessions)**: run `highlights --json`, show the user the candidates (title / score / hook / recommended), let them pick, then run `clip` — the pipeline re-detects from cache so this is cheap. For "just do it" requests, run `clip` directly.
2. **Read the output receipt**: the export folder contains one mp4 + cover JPG + `.post.txt` (publish copy) per clip, plus `clips.json` — per-clip evidence chain (`render`: what the pipeline did) and **`qa`: render-QA report** (`status: pass|warn` with issues like black frames, long silences, loudness deviation, duration mismatch, mid-word cuts, and **platform-risk words** in title/copy/captions via a local rule lint — `qa.contentHits` lists each term and where it appeared).
3. **Self-repair is automatic**: fixable warnings (leading/trailing silence or black frames → edge-trim; loudness deviation → second normalize pass) are repaired and re-checked in one pass; `qa.repair` records what was done (`actions`, `applied`). A repair is only kept when the re-check strictly improves.
4. **Surface QA warnings**: if any clip still has `qa.status === "warn"`, tell the user which clip and why; content-lint hits mean the copy/captions may be throttled or rejected by 抖音/小红书/视频号 — suggest rewording before publishing. Never silently ship a warned clip.

## Hard rules

- **Never guess timestamps.** Cut points come from word-aligned transcription (`highlights` output); do not invent start/end seconds or hand-roll ffmpeg cuts when the pipeline covers it.
- **Local-first**: do not upload the footage or transcript to any service beyond the user-configured LLM endpoint (which only ever receives transcript text, never media).
- Exports land next to the source video in `<name>-hotclip/` unless `--out` is given; tell the user the absolute path when done.

## MCP alternative

The same pipeline is exposed as a local stdio MCP server (`pnpm mcp`, tools: `clip_video` / `detect_highlights` / `transcribe_video`) — prefer it when the host supports MCP registration; the CLI is equivalent otherwise.
