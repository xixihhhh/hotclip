<div align="center">

<a href="https://github.com/xixihhhh/hotclip/releases/latest">
  <img src="docs/readme-hero-en.png" alt="HotClip — turn long videos and livestream VODs into viral vertical shorts, locally" width="100%">
</a>

# HotClip — Free Open-Source AI Video Clipper: Long Videos → Viral Vertical Shorts

**A free, local Opus Clip alternative — no credits, no watermark, no uploads**

[简体中文](README.md) | **English** | [Website](https://xixihhhh.github.io/hotclip/en.html) | [Download](https://github.com/xixihhhh/hotclip/releases/latest) | [FAQ](#faq) | [Issues](https://github.com/xixihhhh/hotclip/issues)

<p>
  <a href="https://github.com/xixihhhh/hotclip/releases/latest"><img src="https://img.shields.io/github/v/release/xixihhhh/hotclip?label=release&color=ff5722" alt="Latest release"></a>
  <a href="https://github.com/xixihhhh/hotclip/releases"><img src="https://img.shields.io/github/downloads/xixihhhh/hotclip/total?label=downloads&color=ff9800" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xixihhhh/hotclip" alt="License"></a>
  <a href="https://github.com/xixihhhh/hotclip/stargazers"><img src="https://img.shields.io/github/stars/xixihhhh/hotclip?style=social" alt="GitHub stars"></a>
</p>

**AI highlight detection (with reasoning) · 9:16 face-tracked auto-reframe · dynamic word-level captions · filler-word & silence removal**

100% local · no watermark · no credits · no length caps · no account

</div>

## ⬇️ Download

**[Get the latest release »](https://github.com/xixihhhh/hotclip/releases/latest)**

| Platform | File | Notes |
|---|---|---|
| Windows installer | `HotClip-x.y.z-win-x64.exe` | Double-click to install |
| Windows portable | `HotClip-x.y.z-win-x64.zip` | Unzip & run |
| macOS (Apple Silicon) | `HotClip-x.y.z-mac-arm64.dmg` | Drag into Applications |

> ⚠️ Builds are currently unsigned: on Windows SmartScreen choose "More info → Run anyway"; on macOS right-click → Open on first launch (or allow it under System Settings → Privacy & Security). Code signing is on the roadmap.
>
> No Python, no Docker, no command line, no account — a real desktop app you double-click.

<!-- TODO(P0): 30-60s demo mp4 here (drag into GitHub's README web editor to get a user-attachments inline player):
     drop in a livestream replay → highlight candidate cards appear → one-click export → vertical clip with dynamic captions -->

<!-- TODO(P0): "Sample output" table here: 2-3 vertical clips side by side in a <table> with <video> tags -->

## How to turn a long video into shorts — in three steps

1. **Import**: drop in a podcast, livestream replay, lecture or vlog (MP4 / MKV / MOV / FLV / TS, audio-only too). Hours-long VODs go straight in — everything is processed locally
2. **Pick highlights**: local word-level transcription → the AI reads the whole transcript and nominates quotables, conflicts and peak moments — each with a **virality score, an opening hook and its reasoning**, cut points accurate to the word; untick anything you don't like
3. **Export**: one click produces vertical 9:16 clips — face-tracked reframe, dynamic word-synced captions, title cards, -14 LUFS loudness — plus a cover image and post copy, ready for **TikTok / Reels / Shorts / Douyin / Bilibili**

## Screenshots

<p align="center">
  <img src="docs/screenshots/04-highlights.png" width="840" alt="AI highlight candidates with four-dimension virality scoring">
</p>
<p align="center"><sub><b>The AI reads the whole transcript and nominates highlights</b> — each with a virality score, hook, four-dimension breakdown (hook / structure / value / trend), a teaser line, and word-accurate cut points. Weak picks are auto-flagged "not recommended"; you make the final call.</sub></p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/01-import.png" alt="Import a long video"><br/><sub>① <b>Import</b> a podcast / livestream replay / lecture — everything is processed locally, nothing is uploaded</sub></td>
    <td width="50%"><img src="docs/screenshots/02-engines.png" alt="Pick a transcription engine"><br/><sub>② <b>Pick an ASR engine</b> — three local tiers (SenseVoice / Paraformer / FireRedASR2) plus an optional cloud tier, privacy levels clearly labeled</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/03-transcript.png" alt="Word-level transcript"><br/><sub>③ <b>Word-level transcript</b> — timestamped, sentence by sentence; the foundation for highlight detection and captions</sub></td>
    <td width="50%"><img src="docs/screenshots/05-export.png" alt="One-click export"><br/><sub>④ <b>One-click export</b> — vertical clips ready to post, with cover images and clips.json metadata</sub></td>
  </tr>
</table>

> Real UI, driven with a sample livestream-selling replay. **If the cuts look right to you, a ⭐ helps more creators escape credit-metered clipping tools — and Star + Watch gets you release notifications.**

## Who it's for

- **Streamers & clippers**: clip your own VODs into highlight shorts right after the stream; the 24/7 **watch folder** turns finished recordings into clips while you sleep; live-chat density feeds straight into highlight detection
- **Podcasters**: audio-only episodes still become video — an **audiogram waveform** plus quote captions turns your podcast into vertical clips
- **Educators & marketers**: lectures, webinars and demos become snackable clips with covers, titles and metadata — with a banned-words lint before publish
- **Talking-head creators**: silences, ums and stutters removed automatically; click-to-fix transcripts and a custom-vocabulary glossary keep names right, episode after episode

## How it compares (free Opus Clip alternative)

Commercial clippers meter **credits per source minute** (a 2-hour podcast burns a month's quota; credits expire monthly), require **cloud uploads**, ship **black-box scoring**, or paywall captions. Open-source alternatives are CLI/Docker tools most creators can't install. HotClip fixes both sides:

| | HotClip | OpusClip / Klap / Vizard (SaaS) | CapCut smart clipping | FunClip / autoclip (open source) |
|---|---|---|---|---|
| Price | **Free & open source** | $15–29+/mo, credits per source minute, expire monthly | Core features paywalled | Free |
| Your footage | **Stays on your machine** | Mandatory cloud upload | Mostly cloud | Local |
| Watermark / caps | **None** | Free tier: watermark, caps, projects expire in 3 days | Some restricted | None |
| Account | **No sign-up** | Account required, projects deleted on unsubscribe | Login required | None |
| Beginner-friendly | **Double-click installer** | Web app, easy | Easy | CLI / Docker / self-hosted |
| Cut quality | **Word-aligned, reasoning attached, veto anything** | Black-box scoring | Black box | Sentence-level, unranked |
| Vertical captions | **9:16 reframe + dynamic captions built in** | Yes (paid tiers) | Auto-captions paywalled | Mostly no vertical reframe |

<sub>Competitor info verified 2026-07. Deep dive: [HotClip vs OpusClip](https://xixihhhh.github.io/hotclip/alternatives/opus-clip.html)</sub>

## Features

> The full pipeline — import → AI highlights → vertical clips with captions — ships today. Expand each group for details; the details are all real features, not adjectives.

### 🎙️ Local transcription: three engines, word-level timestamps

Fast SenseVoice (5 languages, 170MB) / balanced Paraformer / most-accurate FireRedASR2 (Mandarin, dialects, code-switching) — all local, CPU-friendly, auto-downloaded with resume support; optional cloud tier (ElevenLabs, your key, audio track only).

<details>
<summary><b>Details</b>: transcript cache · click-to-fix transcripts · hotword glossary · speaker diarization</summary>

- **Local transcript cache**: reopen the same file and jump straight to highlight picking; invalidated when the file or engine changes
- **Inline transcript correction**: hover any sentence and fix it in place; captions, translation and post copy all use the corrected text, per-word timing rebuilt automatically
- **Hotword glossary**: fix a name once, apply to every matching sentence, and every future transcript auto-corrects (whole-word matching, longest wrong term wins); glossary updates replay from cache — no re-recognition
- **Speaker diarization**: one toggle (local pyannote + 3D-Speaker, zero upload) labels who's speaking; the AI picks segments per speaker and never stitches two people out of context; bubble captions can color per speaker
</details>

### 🔥 AI highlights: six evidence channels, every cut with receipts

The LLM only picks *which part* and must quote the transcript; timestamps come from **reverse-aligning the word-level transcript** — the AI never guesses times. Every candidate ships with a virality score, hook, reasoning and four-dimension review; weak picks are flagged "not recommended".

<details>
<summary><b>Details</b>: review gate · chat/emotion/vision signals · reference clips · cost funnel · product mode</summary>

- **AI review quality gate**: a strict second-pass blind reviewer scores hook / structure / value / trend with one-line rationales, plus a printable teaser line
- **Virality score = ranking, not astrology**: dimension-weighted totals normalized by relative rank within the batch (76–99), immune to LLM scoring drift — honestly labeled a ranker, not a view-count oracle
- **Audio-visual evidence**: loudness peaks and shot-change density collected locally and injected into judgment
- **Live-chat density signal**: auto-discovers the danmaku .xml next to a recording (BililiveRecorder convention); sliding-window density with hype-word weighting — the audience voting second by second, the strongest evidence there is
- **Facial-emotion peaks (zero-config)**: YuNet + FER+ (MIT-licensed, a few MB) find laughter/surprise/excitement peaks — visual evidence without installing anything
- **Visual peak signal (optional)**: a local Ollama vision model samples frames for spectacle transcripts can't see; contact-sheet scoring drops VLM calls 20→3
- **AI visual review (optional)**: after detection, top candidates get a contact-sheet look-over by a vision model — striking visuals boost the score, lifeless visuals demote signal-driven candidates, title/visual mismatches get flagged, and the scene note lands in the reasoning; free with local Ollama, or drop an API key into vision settings for a cloud model
- **Reference-clip driven detection**: hand in a viral clip to model after — its pacing is measured locally and steers selection (CLI `--reference`)
- **Review feedback loop**: kept/rejected candidates land in a local preference file steering the next run — it learns your taste, and the data never leaves your machine
- **On-device two-stage funnel**: a small local model shortlists first, the cloud model reads only the shortlist — an order of magnitude less LLM spend on long videos, zero accuracy loss
- **Shot-snapped cut points**: TransNetV2 (31MB ONNX, local) finds real shot changes; boundaries snap with a word-boundary guard that never clips speech
- **Product mode (live-selling)**: type product words and selection follows conversion logic (demos > pitches > price mechanics); stalling-for-engagement segments excluded
- **Clip length presets**: short 10-30s / standard 8-40s / long 40-90s — the target length is a hard constraint in the selection prompt
</details>

### 📝 Captions & copy: auto captions and post copy, one toggle each

Dynamic captions in multiple styles — keyword highlight, word pop, bubble, minimal — burned in automatically, word-timestamp driven with semantic line breaks (never chopped mid-phrase); **SRT export** and bilingual captions included; AI titles burned as top cards; post copy generated per clip.

<details>
<summary><b>Details</b>: bubble captions · opening hook · bilingual · Hormozi style · banned-words lint · AIGC labeling</summary>

- **Semantic line breaking (no API key)**: lines wrap at real clause boundaries from ASR punctuation — the commercial LLM-`[br]` result from local signals, zero extra calls
- **Bubble caption engine**: built-in Chromium renders CSS captions offscreen frame-by-frame — rounded bubbles, gradient keywords, springy entrances; deterministic, same input → same output
- **Opening hook (first 3 golden seconds)**: the AI's teaser line burned large into the first ~2 seconds, avoiding the subject and title card; skipped when there's no good teaser
- **Cold open (payoff first)**: the hottest hook line spliced to the very front, then the full clip — the standard retention trick, paywalled elsewhere; skipped when the hook can't be located (never done wrong rather than done badly)
- **Flash-forward cold open**: flash the clip's most explosive 0.3-1s before the story starts, then cut back — only 0.04% of clips ship any visual hook; auto-coordinates with the climax-first cold open (one or the other), skipped when no safe peak exists
- **Hormozi-style impact captions**: big bold chunks, hard shadows, word-by-word lighting
- **Bilingual captions**: full-sentence translation burned as a second track, remapped through jump-cut compression; competitors sell this as a paid tier
- **SRT export**: timestamps already reflect the jump-cut/filler-removed output; line breaks match the burned captions exactly
- **Post copy generation**: hooky title + 3-6 niche hashtags + description per clip (8 hook angles × 5 CTA types), saved as `.post.txt` and into clips.json
- **Platform banned-words lint**: 120+ local rules over titles/copy/captions — absolute claims, medical claims, off-platform funneling flagged before publish
- **AIGC labeling (compliance built-in)**: one toggle adds the explicit on-frame badge plus implicit container metadata per China's AIGC labeling measures
</details>

### 🎬 Finishing: edits that feel hand-made

Face-tracked 9:16 reframing (three per-shot modes), silence jump cuts, filler-word removal, -14 LUFS loudness, frame-accurate cutting — with render QA and self-repair after every export.

<details>
<summary><b>Details</b>: reframe · silence cuts · denoise · SFX · BGM · QA & self-repair · smart covers</summary>

- **Face-tracked smart reframing**: locked / smooth-pan / One Euro tracking per shot; center-crop fallback when no face is found
- **Screen-recording UI removal**: status bars and letterboxing detected via temporal variance and cropped out
- **Silence jump cuts**: pauses cut and spliced with caption timeline remapped; requires *no words AND acoustic silence*, so laughter and applause survive
- **Filler-word removal**: um/uh-class fillers and stutters cut (deliberately conservative), itemized in clips.json
- **Loudness normalization**: -14 LUFS (EBU R128) per clip, measured on the spliced audio after jump cuts
- **One-click denoise**: double highpass + spectral subtraction; measured -7.9dB noise floor with speech moved just 0.2dB — honest basic denoising, not AI audio repair
- **SFX cues**: a whoosh on stitch/cold-open hard cuts, a ding on the clip's emotional peak, a soft pop as the opening hook lands — rule-based placement, at most 3 per clip; effects are synthesized locally (zero assets, zero licensing), drop in your own same-named wav files to replace them
- **Background music (with ducking)**: pick any local audio file — it loops to fit the clip, sits well under the voice, ducks automatically while speech plays and fades out at the end; mixed in a separate pass with the video stream copied untouched
- **Render QA + self-repair**: black frames / silences / loudness / duration / mid-word cuts re-checked into clips.json; fixable warnings fixed on the spot and kept only if the re-check improves
- **Smart cover frame**: the loudest moment inside the clip becomes the cover (usually the laugh or the shout); transitions avoided
- **Frame-accurate cutting**: fast seek + re-encode; hours-long FLV/TS replays go straight in
- **Precision cut points (Paraformer second pass)**: selected clips are re-decoded before export; integrated word timestamps (±50ms, better than forced alignment) fix captions, jump cuts and cut boundaries — covering the fast ASR tier's weakness; ~240MB model downloaded on first use, falls back safely when alignment is unreliable
- **Cancellable exports + real-time progress**: ffmpeg progress streamed live; cancel kills the encoder instantly, finished clips stay
</details>

### 🧰 Review & workflow: AI rough cut, human final cut

A clip review workbench (play in-app, drag cut points word-by-word on a waveform), platform-accurate caption safe-zone masks, brand style presets, render prefs memory.

<details>
<summary><b>Details</b>: workbench · safe zones · publish packs · variants · brand templates · dual aspect · compilation · EDL · settings</summary>

- **Clip review workbench**: play candidates in-app, drag waveform handles to fine-tune word by word (snapping to word boundaries), one-click restore of AI cuts; manually tuned clips skip shot-snapping — the machine never overrides a human decision
- **Caption safe-zone preview**: overlay each platform's real UI occlusion areas — nine presets from measured data (Douyin / Kuaishou / Bilibili / WeChat Channels / RedNote / TikTok / Reels / Shorts + generic union)
- **Platform publish packs (post right after cutting)**: per-platform folders with the video hard-linked, the cover re-cropped to that platform's aspect (RedNote 3:4, Bilibili 16:10, Channels 6:7) and post copy trimmed to platform limits, plus a manifest of what was adapted — open the folder, upload platform by platform
- **Multi-version variants (real differentiation for multi-account posting)**: 2-3 packagings of each clip in one run — different hook-angle title cards, opening teasers, post copy, covers from different loudness peaks; built on added value, not the frame-dropping/mirroring tricks platforms now flag as reposts
- **Brand style templates**: one highlight color, caption size/position, logo watermark — named presets applied to every clip, recorded in the receipt
- **Dual aspect ratios in one click**: vertical 9:16 plus a landscape set in one run (title card dropped, captions switch layout) — competitors export one ratio per run
- **One-click compilation**: the batch spliced into a highlights reel via stream copy (milliseconds, zero quality loss) with a `.chapters.txt` chapter file
- **EDL timeline export**: `timeline.edl` (CMX3600) with every cut including jump-cut splices — import into DaVinci / Premiere and keep refining
- **Audiogram rendering**: audio-only sources auto-compose a dark canvas + animated brand-colored waveform, captions burned as usual
- **Render prefs memory + inline title editing**: toggle combos remembered across videos; titles editable in place with file names and copy following
- **Settings page**: model storage visible and movable (cross-drive moves copy → verify → then delete), three export quality tiers (Compact measured 66% smaller), default caption style and export location
- **Update notifications**: silent check on launch, a small badge when a new release exists; offline checks fail silently
</details>

### 🤖 Batch & ecosystem: CLI / MCP / Agent Skill

One-click hands-off mode + 24/7 watch folder + headless CLI + local MCP server — **the only local, no-upload clipping toolchain for coding agents**.

<details>
<summary><b>Details</b>: watch folder · CLI · MCP · Claude Code skill · doctor</summary>

- **Recording watch folder (24/7)**: point it at your OBS/recorder output dir; recordings are transcribed, mined and exported the moment they finish writing ("two rounds of stable size" — half-written files are never cut); failures are skipped, never retried in a loop
- **Headless CLI** (same outputs as the desktop app):

  ```bash
  pnpm cli transcribe vod.mp4                  # on-device word-level ASR (cached)
  pnpm cli highlights vod.mp4 --json           # AI highlight candidates, review first
  pnpm cli clip vod.mp4 --max-clips 10         # fully managed export + QA report
  pnpm cli doctor --download                   # environment self-check + model pre-fetch
  ```

- **Local MCP server** (register in Claude Code / Claude Desktop) — three tools: `clip_video`, `detect_highlights`, `transcribe_video`:

  ```json
  {
    "mcpServers": {
      "hotclip": {
        "command": "npx",
        "args": ["-y", "tsx", "src/mcp/server.ts"],
        "cwd": "/path/to/hotclip",
        "env": {
          "HOTCLIP_LLM_BASE_URL": "http://localhost:11434/v1",
          "HOTCLIP_LLM_MODEL": "qwen3:8b"
        }
      }
    }
  }
  ```

- **Official agent skill** — paste this into Claude Code / Codex and the agent installs everything itself:

  > Install HotClip as my local clipping skill: `git clone https://github.com/xixihhhh/hotclip.git && cd hotclip && pnpm install`, then copy `skills/hotclip/` into my agent skills directory (`~/.claude/skills/hotclip/` for Claude Code) and configure the LLM env vars per `skills/hotclip/SKILL.md`. Verify with `pnpm cli highlights` on a test video.

- **clips.json processing receipt**: what the AI did to each clip (caption style, reframe mode, jump-cut ratio, fillers removed) — fully auditable, pipeline-ready
- **Bring your own AI (or none)**: free local models by default; plug in [Atlas Cloud](https://www.atlascloud.ai), fal.ai or any OpenAI-compatible endpoint — or local Ollama for a fully offline pipeline
</details>

## What's new

**[v0.13.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.13.0)** (2026-08-09) "Watch it all, dare to drop": **three-tier quality gate** — the AI review now ends with a zero-context verdict (pretend you never saw the stream; does this clip stand alone?): **publish / needs review / drop**; a deterministic rule layer catches hard flaws on top (openings dangling on "so/but", endings cut on a comma, dense speaker overlap); dropped clips fold to the bottom of the list with reasons and can be rescued by hand; unattended watch-folder mode only auto-exports the publish tier — 30-45% of AI picks being duds is the industry reality, and posting duds throttles the whole account. **Full-stream visual scan** — samples ~1 frame every 30s across the entire stream and feeds on-screen events (memes, action, fails) into selection evidence with one-line descriptions, closing the text-only blind spot; free with local Ollama, roughly cents per stream on a cloud tier (qwen3-vl-flash), with the frame/call count estimated right next to the toggle. **User brief** — tell the AI in plain words what to hunt for and what to skip ("only the refund fiasco, no giveaways or chat reading"), and it re-detects on your brief. **Streamer clip commands** — "clip that" moments in the transcript count as the strongest evidence there is (the content sits before the command; the AI walks back to it). **Selling three-act stitch** — when the pain point, the demo and the price reveal sit far apart, they get stitched into one complete pitch clip (never forced when beats are missing). **Transcript pick** — build clips by clicking sentences (search lines, filter by speaker, pick across the timeline); manual stitches bypass the AI's piece-count guardrails. **No more dead-end LLM errors** — picking the Ollama preset warns upfront about what to install; a preflight check on start blocks doomed configs (Ollama down / bad key / model not pulled) with next steps and one-click picks from your installed models; failure messages now say what to do ([#6](https://github.com/xixihhhh/hotclip/issues/6)).

<details>
<summary><b>Release history</b> (v0.4.3 → v0.12.0) and milestones</summary>

- **[v0.12.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.12.0)** (2026-08-05) "Pick sharper, open louder": **flash-forward cold opens** (flash the most explosive 0.3-1s, then cut back; auto-coordinates with climax-first); **AI visual review** (contact-sheet look-over of top candidates: visual score feeds ranking, mismatches get flagged; free locally, API key switches to cloud); **precision cut points** (Paraformer second-pass word timestamps ±50ms fix captions/jump cuts/boundaries, safe fallback); **hook payoff check** (promised numbers must appear in the clip); **caption modernization** (keyword-highlight default, word-pop with per-word lighting and damped entrance); plus four never-wired export toggles fixed
- **[v0.11.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.11.0)** (2026-08-05) "Ready to post": **platform publish packs** (per-platform folders after export: hard-linked video + covers re-cropped per platform aspect + copy trimmed to platform limits, with an adaptation manifest); **multi-version variants** (2-3 genuinely different packagings per clip: hook-angle title cards, teasers, copy and covers; tagged `variantOf`, compilations/EDL include originals only); **SFX cues & BGM** (whoosh on hard cuts, ding on the emotional peak, soft pop under the hook, ≤3 per clip; BGM loops with voice ducking and end fade, mixed in a separate zero-quality-loss pass); plus the **dynamic minimal** caption style
- **[v0.10.1](https://github.com/xixihhhh/hotclip/releases/tag/v0.10.1)** (2026-08-05) "Switchable models, tolerant of hiccups": **the model picker is now always reachable** — previously, once configured, there was no way to change provider or model at all (the panel only reappeared on a detection error), so v0.10.0's seven new providers were unreachable for existing users; a toolbar button now shows the current model and reopens the panel, and confirming after a change re-runs detection; **malformed LLM JSON retried once** (mainstream endpoints intermittently emit junk tokens mid-JSON, killing the whole run); **the signal path nominates fewer moments** (12 candidates made the model return an unfilled template; capped at 8)
- **[v0.10.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.10.0)** (2026-08-05) "Pick better": a rework of **what gets picked** — clips can now be **stitched from multiple parts** (placing two moments ten minutes apart side by side is what makes a "caught contradicting himself" clip work at all); **stream-genre criteria** rebuilt against the **real category taxonomies** of Bilibili/Douyin (adding VTuber, radio, pets, food, esports, crafts and co-watching, which were missing entirely — and co-watching now explicitly forbids clipping the copyrighted content on screen); a new **signal-driven candidate path** so dance/pet/outdoor streams, whose transcripts are empty and which previously yielded nothing at all, get located by audio and visual signals instead; laughter is no longer treated as the highlight itself (it lags the punchline that caused it). Also: **vocal-tone and laughter/applause** as two new evidence paths, **auto-zoom**, **retake cutting**, **recorder webhooks** (BililiveRecorder/blrec), **multi-provider LLM presets** (DeepSeek, Model Studio, GLM, Kimi, SiliconFlow, OpenRouter, OpenAI) and **one-click model-list fetch** (model ids rot as vendors ship new generations — ask the endpoint instead)
- **[v0.9.4](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.4)** (2026-07-31) "Chinese usernames are off the hook": fixes guaranteed transcription failure under non-ASCII Windows usernames ([#4](https://github.com/xixihhhh/hotclip/issues/4)) — model paths auto-convert to 8.3 short paths, audio samples read app-side; cross-drive model moves unblocked; model-load failures now say what to actually do
- **[v0.9.3](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.3)** (2026-07-28) "You decide where things live": Settings page ([#3](https://github.com/xixihhhh/hotclip/issues/3)) — model storage visible & movable, three export quality tiers (Compact 66% smaller), default caption style & export location
- **[v0.9.2](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.2)** (2026-07-27) "Honest errors, unsquashed UI": transcription failures attributed correctly ([#2](https://github.com/xixihhhh/hotclip/issues/2)); export-options bar wraps instead of bursting the layout; configurable output folder
- **[v0.9.1](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.1)** (2026-07-24) "Windows first-run fix": the 100%-then-restart model download loop fixed (pure-JS extractor fallback for bzip2); extraction progress stage; atomic staging
- **[v0.9.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.9.0)** (2026-07-24) "Learns your taste": review feedback loop + `doctor` self-check + resumable model downloads + structured post-copy templates (8 angles × 5 CTAs) + reference-clip entrance completed
- **[v0.8.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.8.0)** (2026-07-20) "Clip like the viral one": reference-clip driven detection + self-repairing QA loop + banned-words lint (120+ rules) + Hormozi captions + contact-sheet frame scoring
- **[v0.7.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.7.0)** (2026-07-16) "Self-check every cut": render QA + headless CLI & agent skill + compilation + cold-open + dual-aspect + product mode
- **[v0.6.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.6.0)** (2026-07-10) "See the picture": six-signal evidence chain + bilingual captions + local MCP server + watch folder + publish kit
- **[v0.5.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.5.0)** (2026-07-09) "Pick right, ship steady": review workbench + shot snapping + brand templates + two-stage funnel
- **[v0.4.3](https://github.com/xixihhhh/hotclip/releases/tag/v0.4.3)** (2026-07-06) Engineering base: transcript cache + clips.json receipt

| Milestone | Status |
|---|---|
| Desktop app · three local ASR tiers · AI highlights · vertical clips with captions · face tracking | ✅ Done |
| Diarization · bubble captions · jump cuts · hands-off mode · installers | ✅ Done |
| v0.5 – v0.9 (workbench · MCP · watch folder · QA/repair · feedback loop · settings) | ✅ Shipped |
| Multi-platform publishing · CapCut draft export · English ASR upgrade (Parakeet) | 🗺️ [Planned](docs/PRODUCT-PLAN.md) |

</details>

Full history in [Releases](https://github.com/xixihhhh/hotclip/releases) · Want a say in what ships first? [Discussions](https://github.com/xixihhhh/hotclip/discussions)

## FAQ

**What is the best free Opus Clip alternative without watermark?**
HotClip — free, open source (AGPL-3.0), runs locally on Windows/macOS, no watermark, no credits, no length caps. Optional cloud LLMs bill your own key; a local Ollama model makes it fully free and offline.

**Is there an AI clipper that runs locally without uploading my video?**
Yes — transcription, captions, cutting and export all run on your machine. Only the highlight-detection step calls a cloud LLM by default (your key, transcript text only); point it at local Ollama for a 100% offline pipeline.

**How do I turn a podcast or livestream replay into shorts?**
Import the file → the AI transcribes and flags highlights (fully editable) → export vertical 9:16 clips with captions, covers and post copy.

**How do I add animated word-by-word captions to a video?**
They're automatic — word-level timestamps drive dynamic captions burned into every clip (keyword highlight, word pop, bubble and more, one toggle to switch); SRT export and bilingual captions are one toggle away.

**Can it remove filler words and silences?**
Yes — silence jump cuts plus an um/uh filler pass, with caption timing remapped and every edit logged to clips.json.

**Does it work for Chinese video?**
Yes, exceptionally well — dedicated Chinese ASR engines (SenseVoice / Paraformer / FireRedASR2) cover dialects, Cantonese and code-switching; UI, captions and prompts are language-routed.

**Do I need a GPU?**
No. The local ASR models are int8-quantized and run fine on CPU; the highlight LLM runs in the cloud (or your local Ollama).

**First run: the speech-model download hits 100%, restarts from zero, and keeps downloading forever?**
Upgrade to [v0.9.1](https://github.com/xixihhhh/hotclip/releases) or newer — the Windows extraction bug is fixed, and previously downloaded bytes resume automatically.

## Developers

```bash
git clone https://github.com/xixihhhh/hotclip.git
cd hotclip
pnpm install
pnpm dev        # run the desktop app in dev mode
pnpm test       # run unit tests
```

**Tech stack**: Electron + React 19 + TypeScript + Tailwind 4 · ffmpeg (bundled) · sherpa-onnx local ASR + speaker diarization · libass dynamic captions + offscreen-Chromium bubble caption engine · LLM highlight detection (Atlas Cloud / Ollama / any OpenAI-compatible endpoint, BYO key)

<details>
<summary><b>Standing on the shoulders of</b></summary>

| Project | Role in HotClip |
|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Local speech recognition runtime (CPU-only friendly) |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) / [FunASR](https://github.com/modelscope/FunASR) | Fast 5-language ASR / Paraformer Chinese ASR & punctuation |
| [FireRedASR](https://github.com/FireRedTeam/FireRedASR) | Highest-accuracy tier: Mandarin, dialects, code-switching |
| [pyannote-audio](https://github.com/pyannote/pyannote-audio) + [3D-Speaker](https://github.com/modelscope/3D-Speaker) | Speaker diarization (local, zero upload) |
| [FFmpeg](https://ffmpeg.org/) + [libass](https://github.com/libass/libass) | Frame-accurate cutting / caption burn-in |
| [onnxruntime](https://github.com/microsoft/onnxruntime) | On-device model inference |

</details>

## License & boundaries

- Code: **AGPL-3.0-only**
- HotClip is for **your own content** or **clips you're authorized to make** (e.g. streamer clipping programs). Unauthorized re-uploading of movies/streams is not supported and not welcome.

## Community & related projects

- 🐛 [Report a bug / installation help](https://github.com/xixihhhh/hotclip/issues) · 💡 [Feature ideas & roadmap](https://github.com/xixihhhh/hotclip/discussions)
- 🔨 **[ClipForge](https://github.com/xixihhhh/clipforge)** — open-source AI e-commerce short-video generator: one product photo in, a ready-to-post shoppable video out. **HotClip clips highlights out of long videos; ClipForge builds short videos from a single image** — they pair well.

[![Star History Chart](https://api.star-history.com/svg?repos=xixihhhh/hotclip&type=Date)](https://star-history.com/#xixihhhh/hotclip&Date)

<div align="center">

**⭐ Star + Watch to catch new releases first.**

</div>
