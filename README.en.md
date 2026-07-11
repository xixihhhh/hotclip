# HotClip — Free Open-Source AI Clip Generator: Turn Long Videos & Livestream VODs into Viral Vertical Shorts

[简体中文](README.md) | **English**

> **HotClip is a free, open-source AI clipping tool (Windows / macOS desktop app) that auto-cuts long videos, livestream VODs, podcasts and lectures into vertical 9:16 shorts — AI highlight detection (quotables, conflict, peak moments), auto captions (word-level karaoke), auto-reframe, silence trimming — 100% local, no watermark, no uploads, no credits, no length caps.**
>
> Ready to post on TikTok / Reels / Shorts / Douyin / Bilibili. A free, open-source alternative to OpusClip, Klap, Vizard and SubMagic, beginner-friendly, no code required. Human-in-the-loop by design: AI nominates the highlights with evidence, you make the call.

<p>
  <a href="https://github.com/xixihhhh/hotclip/releases/latest"><img src="https://img.shields.io/github/v/release/xixihhhh/hotclip?label=release&color=ff5722" alt="Latest release"></a>
  <a href="https://github.com/xixihhhh/hotclip/releases"><img src="https://img.shields.io/github/downloads/xixihhhh/hotclip/total?label=downloads&color=ff9800" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xixihhhh/hotclip" alt="License"></a>
  <a href="https://github.com/xixihhhh/hotclip/stargazers"><img src="https://img.shields.io/github/stars/xixihhhh/hotclip?style=social" alt="GitHub stars"></a>
</p>

<!-- TODO(P0): 30-60s demo mp4 here (drag into GitHub's README web editor to get a user-attachments inline player):
     drop in a livestream replay → highlight candidate cards appear → one-click export → vertical clip with karaoke captions -->

<!-- TODO(P0): "Sample output" table here: 2-3 vertical clips side by side in a <table> with <video> tags -->

---

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

> Real UI, driven with a sample livestream-selling replay. **If the cuts look right to you, a ⭐ helps more creators escape credit-metered clipping tools.**

## What's New

- **[v0.6.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.6.0)** (2026-07-10) "See the picture, join the ecosystem": a **six-signal evidence chain** (+on-device vision peaks · facial-emotion peaks · live-chat density), **bilingual caption burn-in**, a **local MCP server** (one sentence to Claude drives the whole pipeline), **24/7 recording watch folder**, a publish kit (post copy / SRT / EDL timeline) and clip-length presets / prefs memory / inline title editing
- **[v0.5.0](https://github.com/xixihhhh/hotclip/releases/tag/v0.5.0)** (2026-07-09) "Pick right, ship steady": a **clip review workbench** (preview clips in-app, drag cut points on a waveform timeline), **shot-snapped cut points** (TransNetV2 — cuts land on real shot changes), **brand style templates** (highlight color / size / position / logo watermark), and an **on-device two-stage funnel** (local small-LLM pre-filter — an order of magnitude less LLM cost on long videos); plus opening-hook burn-in and -14 LUFS loudness normalization
- **[v0.4.3](https://github.com/xixihhhh/hotclip/releases/tag/v0.4.3)** (2026-07-06) Engineering base: local transcript cache (reopen the same file and jump straight to highlight picking) + clips.json processing receipt (auditable record of what the AI did to each clip)
- **[v0.4.2](https://github.com/xixihhhh/hotclip/releases/tag/v0.4.2)** (2026-07-05) Caption readability: semantic line breaking (wraps at real clause boundaries instead of chopping mid-phrase) + anti-flicker

Full history in [Releases](https://github.com/xixihhhh/hotclip/releases).

## How It Works

1. **Import**: drop in a podcast, livestream replay, lecture or vlog (MP4 / MKV / MOV / FLV / TS, audio-only files too)
2. **Pick highlights**: local word-level transcription → the AI reads the whole transcript and nominates quotables, conflicts and peak moments — each with a virality score, an opening hook, and its reasoning, cut points accurate to the word; untick anything you don't like
3. **Export**: one click produces vertical 9:16 clips with karaoke word-by-word captions burned in, saved to `Movies/HotClip`, ready to post

## Why HotClip

Every commercial clipper has at least one of these problems: **credit metering by source minute** (a 2-hour podcast burns a whole month's quota — and unused credits expire monthly), **mandatory cloud uploads** (unreleased footage and client work you'd rather not hand over — see CapCut's 2025 terms-of-service backlash), **sloppy cut points** (sentences chopped in half, no context), or **Chinese support in name only**. Open-source alternatives (FunClip, ShortGPT, clipsai…) are CLI/Docker/self-hosted — most creators can't even install them.

HotClip fills the gap from both sides:

- 🖥️ **Double-click to run**: Windows / macOS installers — no Python, no Docker, no command line
- 🔒 **Local-first**: transcription, highlight detection and cutting all run on your machine; footage never leaves it
- 🆓 **Actually free**: open source (AGPL-3.0), no credits, no watermark, no video-length caps
- 🎯 **Accurate cuts**: the LLM only decides *which part*; timestamps come from reverse-aligning the word-level transcript — the AI never guesses times
- 🇨🇳 **Native Chinese + English**: Chinese speech goes through dedicated ASR engines (SenseVoice, Cantonese included), the UI is bilingual, and highlight prompts are routed by content language — not an English product with a translation layer
- 🤖 **Bring your own AI (or none)**: free local models by default; for stronger highlight judgment, plug in [Atlas Cloud](https://www.atlascloud.ai) (one key for all major Chinese & Western LLMs), fal.ai, or any OpenAI-compatible endpoint

## How It Compares

| | HotClip | OpusClip / Klap / Vizard (SaaS) | CapCut smart clipping | FunClip / autoclip (open source) |
|---|---|---|---|---|
| Price | **Free & open source** | $15–29+/mo, credits metered per source minute, regenerations billed again, credits expire monthly, projects deleted after unsubscribing | Core features paywalled into Pro | Free |
| Where your footage goes | **Stays on your machine** | Mandatory cloud upload | Mostly cloud | Local |
| Watermark / length caps | **None** | Free tier: watermark, length caps, projects expire in 3 days | Some templates restricted | None |
| Beginner-friendly | **Double-click installer** | Web app, easy | Easy | CLI / Docker / self-hosted |
| Cut quality | **Word-aligned, reasoning attached, veto anything** | Black-box scoring, frequent out-of-context complaints | Black box | Sentence-level, no virality ranking |
| Vertical captions | **9:16 reframe + karaoke captions built in** | Yes (paid tiers) | Auto-captions paywalled | Mostly no vertical reframe |

> In one line: credit metering and black boxes are what SaaS users complain about most; open-source tools are what they can't install. HotClip fixes both at once.

## Shipped

- **Local word-level ASR (three tiers)**: fast SenseVoice (5 languages, 170MB) / balanced Paraformer (better Chinese, 230MB) / most-accurate FireRedASR2 (Mandarin, dialects, code-switching; open-sourced by Xiaohongshu, 520MB) — all local, word timestamps, auto-downloaded on first run (China mirrors preferred); tiers without punctuation get it restored by a punctuation model. Optional **cloud tier: ElevenLabs** (your key, 90+ languages, only the extracted audio track is uploaded — never the video)
- **AI highlight detection**: the LLM only picks *which part* and must quote the transcript; timestamps come from reverse alignment (word-exact / endpoint-anchored / sentence-level, degradation clearly shown in the UI) — the AI never guesses times
- **Evidence-chain cards**: every candidate ships with a virality score, opening hook, reasoning, and precise time bounds — tick or veto
- **Face-tracked smart reframing**: 9:16 reframing detects and follows faces (three per-shot modes: locked / smooth pan / One Euro tracking); falls back to center crop when no face is found
- **Karaoke word-level captions**: word-timestamp-driven highlight-as-you-speak captions (ASS/libass), burned into the export, toggleable
- **Semantic line breaking (no API key needed)**: captions no longer chop mid-phrase — lines wrap at real clause boundaries using ASR punctuation, falling back to structural particles in long unpunctuated stretches; equivalent to the LLM-inserted `[br]` approach used by commercial leaders, but from local signals with zero extra calls
- **Bubble caption engine (web-rendered)**: the app's built-in Chromium renders a CSS caption layer offscreen frame by frame — adaptive rounded bubbles, gradient-gold keywords, springy entrances; effects libass can't do, one toggle away; deterministic frame-driven rendering, same input → same output
- **Title cards**: the AI-written viral title is burned into the top safe area automatically
- **Opening hook (first 3 golden seconds)**: the AI's teaser line is burned large into the upper third of the first ~2 seconds (fade in/out, avoiding the subject and the title card) — the retention-critical moment when viewers decide to keep watching or swipe away
- **Cold open (payoff first)**: one toggle splices the clip's hottest hook line (1-4s) to the very front, then plays the full clip — it repeats at its original spot, the standard retention trick in clip editing (50-60% of swipe-aways happen in the first 3 seconds; commercial tools paywall their AI Hook); the hook line is located word-accurately with the same quote back-alignment used for clip selection, captions/teaser/title card burn onto the cold-open segment as usual, and SRT/cover timestamps shift accordingly; skipped automatically when the hook can't be located or already sits within the first 10s — recorded either way in the clips.json receipt
- **AI review quality gate**: a strict second-pass blind reviewer scores every candidate on **hook / structure / value / trend** with a one-line rationale each, plus a printable teaser line; weak candidates are transparently flagged and unselected by default
- **Virality score = ranking, not astrology**: dimension-weighted totals are normalized by relative rank within the batch (recommended range 76–99), so scores are comparable within a batch and immune to LLM scoring drift — same approach as commercial tools, honestly labeled as a ranker, not a view-count oracle
- **Speaker diarization**: one toggle (local pyannote + 3D-Speaker, zero upload) labels who's speaking per sentence — the AI picks segments per speaker and avoids stitching two people's half-sentences out of context; bubble captions can color per speaker
- **Screen-recording UI removal**: status bars, fixed UI and letterboxing in phone-recorded livestreams are detected via temporal variance (static = UI, moving = content) and cropped out; no detection, no crop
- **Silence jump cuts**: pauses between speech are cut and spliced with the caption timeline remapped — the rhythm feels hand-edited; cuts require *no words AND acoustic silence*, so laughter, applause and BGM peaks survive
- **Filler-word removal**: um/uh-class fillers and stutter repeats are cut (deliberately conservative word list); every cut is itemized in clips.json — you always know what the AI touched
- **Loudness normalization**: every clip is normalized to **-14 LUFS (EBU R128)**, the social-platform standard — a whole batch exports at consistent volume; jump-cut clips are measured on the spliced audio, not per segment
- **One-click denoise (hiss & mains hum)**: livestream VODs often carry a noise floor and 50Hz mains hum that used to mean a round-trip through Audacity — now it's one toggle in the export toolbar: double highpass (24dB/oct against hum) + spectral subtraction in the export chain; measured on synthetic fixtures: **noise floor -7.9dB in silence, speech moved just 0.2dB**, identical chain across all three export paths (plain cut / jump-cut / audiogram), always ahead of loudness normalization (denoise first so loudnorm doesn't lift the noise floor); honestly positioned as basic zero-cost denoising, not AI audio repair
- **Cover image + metadata export**: every clip ships with a cover JPG (captions and title card included, ready for direct upload) and clips.json (title / hook / scores / review notes / timecodes / keywords) — plug straight into a CMS for multi-account operations; plus a **processing receipt** (effective caption style, face-track vs center-crop fallback, jump-cut ratio and segment count, filler words removed) — fully auditable
- **Audio-visual evidence**: loudness peaks and shot-change density are collected locally and injected into highlight judgment — no more text-only picking
- **Visual peak signal (on-device vision)**: optionally let a local Ollama vision model (e.g. qwen3-vl:4b) sample frames and judge visually hot moments — big expressions, physical action, spectacle that **transcripts simply cannot see** — merged into windows and handed to the cloud model as evidence; frame times are spent on loudness-peak / dense-cut windows first (free priors) with uniform coverage as backstop; unreachable endpoints or thin evidence are silently skipped so detection never stalls, and the frame count is shown in the results view — aimed squarely at the industry-wide "under 35% accuracy on visual content" problem
- **On-device two-stage funnel (cost saver)**: optionally let a small local Ollama model (e.g. qwen3:4b) read the full transcript first and shortlist candidate ranges, so the cloud model only reads the shortlist — **an order of magnitude less cloud spend on long videos**; quote reverse-matching still runs on the full transcript, so cut-point accuracy is untouched; unreachable local endpoints silently fall back to full-text, failed chunks are kept wholesale (spend more rather than miss content), and the savings are shown in the results view
- **Shot-snapped cut points**: TransNetV2 shot-boundary detection (31MB ONNX, local inference, MIT) finds real shot changes frame by frame, and clip boundaries snap to the nearest one (extending outward first, ≤0.8s) — clips no longer open mid-action or mid-transition; a **word-boundary guard** guarantees snapping never clips speech, detection failures silently fall back to no snapping, and every snap is logged in the clips.json receipt
- **Brand style templates**: one highlight color driving karaoke sweep / keyword emphasis / opening hook / bubble gradients, three caption sizes and positions, and a **logo watermark** (any corner, adjustable opacity) — configure once, save as named presets, and every clip (hands-off mode included) ships in your style; the applied style lands in the clips.json receipt so multi-account pipelines can verify brand consistency. Competitors keep this behind a paywall
- **Cancellable exports**: stop an export any time with one click — the running ffmpeg process is killed immediately (not after it finishes), and already-completed clips stay in the output folder
- **Real-time encode progress**: the progress bar no longer jumps in half-clip steps — ffmpeg's encoding progress is streamed back live, so even a minutes-long clip shows a steadily advancing in-clip percentage instead of looking frozen; all three export paths (plain cut / jump-cut / audiogram) share one execution layer, and cancel still kills instantly
- **Update notifications**: a silent check against the latest GitHub release on launch — when a newer version exists, a small badge lights up in the header linking to the download page; offline/rate-limited checks fail silently and never nag, and your current version keeps working
- **Inline transcript correction**: ASR typos no longer ride all the way into burned captions — hover any sentence on the transcript page and fix it in place; captions, bilingual translation and post copy all use the corrected text, and that sentence's karaoke timing is rebuilt by character width (CJK per-character, English per-word)
- **Hotword glossary (fix a name once, every episode auto-corrects)**: ASR misrecognizing the same names, brands and jargon all stream long is an industry-wide pain — fix one occurrence in the transcript, then **apply to every matching sentence and save to the glossary** in one click; the glossary persists locally and every future transcript is auto-corrected (whole-word matching so "AI" never touches "MAIN", longest wrong term wins) across captions, translation, post copy, watch folder and MCP; after a glossary update the same file replays from the transcript cache — **no re-recognition** — and corrected sentences carry a visible "glossary" tag
- **Smart cover frame**: covers no longer grab a fixed 0.8s frame (often a transition) — each clip's cover is **the loudest moment inside the clip**, which is usually the laugh, the shout, the peak expression that deserves to be the face of the clip (excited-face thumbnails earn 20-30% more clicks); jump-cut-removed regions are excluded, edges are guarded against transitions, and silent footage falls back to the old behavior
- **AIGC labeling (compliance built-in)**: one toggle labels output per China's AIGC labeling measures (and platform AI-disclosure rules) — a visible "AI 生成" badge in the top-left corner (**explicit**) plus container metadata with attribute/tool/content-id (**implicit**); enable when your platform requires AI disclosure, off by default so nothing is mislabeled
- **Audiogram rendering (a picture for podcasts)**: audio-only sources (podcasts/recordings) **auto-compose a visual** on export — dark canvas + brand-colored animated waveform, with captions and title cards burned in as usual; static cover art gets scrolled past, a moving waveform earns the pause (Headliner built a whole product on this one capability); the waveform is generated from the already-jump-cut audio so it stays perfectly in sync, follows your vertical/horizontal setting, zero config and zero new dependencies
- **EDL timeline export (AI rough cut, human final cut)**: one toggle adds a `timeline.edl` (universal CMX3600) to the output dir — every AI cut point **including each jump-cut splice** lands on a timeline you can import into DaVinci Resolve / Premiere, relink the source and keep refining; the machine's every decision stays visible, editable and overrulable
- **One-click compilation (weekly highlights reel)**: one toggle splices the exported batch into a single compilation video in timeline order — the "this week's highlights" reel is a mature weekly format on Bilibili/YouTube that used to require a second editing pass; **stream-copy splicing finishes in milliseconds with zero quality loss**, hard cuts between clips (the compilation convention — transitions just drag the pace), plus a `.chapters.txt` **chapter timestamp file** ready to paste into a YouTube/Bilibili description; a failed splice is skipped silently and never harms the exported clips
- **Render prefs memory + inline title editing**: the toolbar's toggle combo (vertical / caption style / jump-cut / bilingual / post copy / length preset…) is remembered across videos — no re-clicking a dozen switches per export; and every candidate's title is editable in place, with the file name, title card and post copy all following the new title
- **Clip length presets**: cycle between short (10-30s) / standard (8-40s) / long (40-90s) and re-detect in one click — the target length goes into the selection prompt as a **hard constraint** (picked right, not trimmed after), serving fast vertical pacing and podcast/YouTube punch segments alike; candidates beyond tolerance are filtered out
- **SRT subtitle export**: one toggle drops a same-name `.srt` next to every clip — for native platform captions (YouTube/bilibili), editor fine-tuning and accessibility; **timestamps already reflect the jump-cut / filler-removed output**, line breaks match the burned-in captions exactly, bilingual mode includes the translated second line. Local, zero cost
- **Live-chat density signal (the audience's own vote)**: detection **auto-discovers the same-name danmaku .xml next to a recording** (the BililiveRecorder convention, compatible with bilibili exports) and marks audience-hype windows via sliding-window density with hype-word weighting — live chat is the audience voting second by second, more direct than any model inference, so it enters highlight judgment as the **strongest evidence**; the threshold adapts to each stream's baseline (chat floods and chat trickles both work), and missing files simply mean no signal — a differentiating edge for CJK live-stream clipping
- **Recording watch folder (24/7 hands-off)**: point HotClip at your OBS / stream-recorder output dir and **every new recording is auto-transcribed, mined and exported the moment it finishes writing** — stream ends, clips appear while you sleep; polling-based watching survives network drives and segmented writes, "two rounds of stable size" means half-written files are never cut, processed files stay processed across restarts, and a failed file is skipped (never burning LLM spend in a retry loop)
- **Local MCP server (agent-ready)**: register in Claude Code / Claude Desktop and let an agent drive the whole local pipeline in one sentence — `clip_video` (fully managed) / `detect_highlights` (review first) / `transcribe_video` (on-device ASR); a hand-rolled zero-dependency stdio protocol, filling the "local MCP clipper" gap (the only commercial one is OpusClip's cloud version)
- **Post copy generation (no more empty caption box)**: one toggle generates a **hooky post title + 3-6 niche hashtags + a one-or-two-line description** for every clip, saved as a same-name `.post.txt` next to each mp4 for select-all copy-paste and written into clips.json for matrix pipelines — sourced entirely from the detection evidence chain (title/hook/keywords/text), Chinese sources get Chinese copy and English sources get English; failures are silently skipped
- **Facial-emotion peak signal (zero-config)**: YuNet face detection + FER+ emotion recognition (two MIT-licensed ONNX models of a few MB, auto-downloaded on first use) scan sampled frames for **laughter / surprise / excitement** peaks and feed the windows into highlight judgment — the free out-of-the-box tier of visual evidence, no Ollama required; sampling bets on loudness-peak and dense-cut windows (that's where expressions live), face-less footage and unavailable models are silently skipped, and the face count is shown in the results view
- **Bilingual captions (go global in one step)**: one toggle and your configured LLM translates every line **as a full sentence** (real context, not caption fragments), burned in as a smaller second track under the main captions — the broadcast bilingual layout with the karaoke original on top and the translation below; Chinese sources auto-translate to English and vice versa; translation lines are remapped through jump-cut timeline compression so removed sentences leave no ghosts; failures are silently skipped so exports never stall, and the burned line count lands in the clips.json receipt. Competitors sell "captions in 100+ languages" as a paid tier — here it's free
- **Clip review workbench (watch before you export)**: one click on any candidate opens the workbench — **play the clip right inside the app** (local streaming protocol, scrub-friendly), then **drag the two handles on a waveform timeline to fine-tune cut points word by word** (they snap to word boundaries, and the video scrubs as you drag); sentence-step extend/shrink, one-click restore of the AI cut points, and a "check ending" button that plays just the last 2.5 seconds; manually tuned clips skip shot-snapping on export — **the machine never overrides a human decision**. Built for the "AI picked it, but can I trust it?" moment
- **Caption safe-zone preview (stop posting fails)**: one toggle in the review workbench overlays each platform's **real UI occlusion areas** — the action rail, caption area and status bar that will cover your frame after posting; captions or subjects inside the red zones get hidden. Nine presets built from measured data (Douyin / Kuaishou / Bilibili story / WeChat Channels / RedNote / TikTok / Reels / Shorts + a generic union — including quirks like Channels only keeping the middle 6:7 visible), plus a dashed frame marking the 9:16 vertical crop; CapCut's safe frame is just an outline and NarratoAI only previews caption position — platform-accurate occlusion masks are a first
- **Local transcript cache**: transcription is the slowest stage; results are cached per (file + engine), so reopening the same file skips straight to highlight picking (and saves a cloud API call); invalidated automatically when the file or engine changes
- **One-click hands-off mode**: import, press one button — transcribe → find highlights → reframe + captions + jump cuts, all automatic; you only review the output
- **Frame-accurate cutting**: fast seek + re-encode, so the first second of a highlight is never blurry or misaligned; hours-long FLV/TS livestream replays go straight in
- **Bilingual UI (EN/中文)** — adding a language is a single locale file

## Roadmap

See the full [product plan](docs/PRODUCT-PLAN.md) (Chinese). Highlights:

- **v0.5 — cut smarter**: candidate review workbench (drag to fine-tune boundaries, one-click regenerate) · shot-boundary detection (cuts snap to shot edges) · caption style templates / brand presets · on-device small-LLM pre-filtering
- ~~**v0.6 — see the frame**: visual highlight signals · facial-emotion peaks · translated captions~~ ✅ shipped (plus MCP server / watch folder / danmaku signal pulled forward)
- **v0.7 — publish from the app**: multi-platform one-click publishing & scheduling · CapCut/JianYing draft export · English ASR upgrade (Parakeet)

Want a say in what ships first? Tell us in [Discussions](https://github.com/xixihhhh/hotclip/discussions).

## Download

**[⬇️ Get the latest release](https://github.com/xixihhhh/hotclip/releases/latest)**

| Platform | File |
|---|---|
| Windows installer | `HotClip-x.y.z-win-x64.exe` |
| Windows portable (unzip & run) | `HotClip-x.y.z-win-x64.zip` |
| macOS (Apple Silicon) | `HotClip-x.y.z-mac-arm64.dmg` |

> ⚠️ Builds are currently unsigned: on Windows SmartScreen choose "More info → Run anyway"; on macOS right-click → Open on first launch (or allow it under System Settings → Privacy & Security). Code signing is on the roadmap.

## Quick Start (developers)

```bash
git clone https://github.com/xixihhhh/hotclip.git
cd hotclip
pnpm install
pnpm dev        # run the desktop app in dev mode
pnpm test       # run unit tests
```

## Agent-ready (MCP Server)

HotClip ships a **local MCP server** — register it in Claude Code / Claude Desktop and just tell your agent "turn this 2-hour VOD into viral shorts": transcription, highlight detection and export all run on your machine, footage never leaves it:

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

Three tools: `clip_video` (fully managed end-to-end), `detect_highlights` (candidates only, review before cutting), `transcribe_video` (on-device ASR with caching). Set `HOTCLIP_LLM_API_KEY` for cloud endpoints; models are shared with the desktop app — download once, use in both.

## Tech Stack

Electron + React 19 + TypeScript + Tailwind 4 · ffmpeg (bundled, nothing to install) · sherpa-onnx local ASR + speaker diarization · libass karaoke captions + offscreen-Chromium bubble caption engine · LLM highlight detection (Atlas Cloud / local Ollama / any OpenAI-compatible endpoint, BYO key)

### Standing on the shoulders of

| Project | Role in HotClip |
|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Local speech recognition runtime (CPU-only friendly) |
| [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) / [FunASR](https://github.com/modelscope/FunASR) | Fast 5-language ASR / Paraformer Chinese ASR & punctuation |
| [FireRedASR](https://github.com/FireRedTeam/FireRedASR) | Highest-accuracy tier: Mandarin, dialects, code-switching |
| [pyannote-audio](https://github.com/pyannote/pyannote-audio) + [3D-Speaker](https://github.com/modelscope/3D-Speaker) | Speaker diarization (local, zero upload) |
| [FFmpeg](https://ffmpeg.org/) + [libass](https://github.com/libass/libass) | Frame-accurate cutting / caption burn-in |
| [onnxruntime](https://github.com/microsoft/onnxruntime) | On-device model inference |

## FAQ

**Is HotClip free?**
Yes — open source (AGPL-3.0), runs locally, no watermark, no credits. Optional cloud LLMs bill your own key.

**How is HotClip different from OpusClip / Klap / Vizard?**
Your footage never leaves your machine. Those SaaS tools require cloud uploads and meter credits per source minute (credits expire monthly; free tiers watermark your exports). HotClip is free, local, watermark-free and cap-free — and every AI cut comes with auditable reasoning. See the [comparison table](#how-it-compares).

**Does it need an internet connection?**
Transcription, captions, cutting and export are fully offline. Only the "find highlights" step calls a cloud LLM by default (with your own key) — point it at a local Ollama model and the whole pipeline is 100% offline.

**How do I turn a podcast or livestream replay into shorts?**
Import the file → the AI transcribes and flags highlights (fully editable) → export vertical clips.

**Does it work for Chinese video?**
Yes — Chinese speech goes through dedicated ASR engines with noticeably better accuracy than general-purpose models; UI, captions and prompts are all adapted for Chinese content.

**Do I need a GPU?**
No. The local ASR models are int8-quantized and run fine on CPU; the highlight LLM runs in the cloud (or your local Ollama).

## License & Boundaries

- Code: **AGPL-3.0-only**
- HotClip is for **your own content** or **clips you're authorized to make** (e.g. streamer clipping programs). Respect each platform's rules — unauthorized re-uploading of movies/streams is not supported and not welcome.

## Community

- 🐛 [Report a bug / installation help](https://github.com/xixihhhh/hotclip/issues)
- 💡 [Feature ideas & roadmap discussion](https://github.com/xixihhhh/hotclip/discussions)

## From the same author

🔨 **[ClipForge](https://github.com/xixihhhh/clipforge)** — open-source AI e-commerce short-video generator: upload one product photo and AI extracts selling points, writes the script, and assembles visuals/voiceover/captions into a ready-to-post shoppable video (TikTok Shop, Douyin, Kuaishou, RED). **HotClip clips highlights out of long videos; ClipForge builds short videos from a single image** — they pair well for e-commerce creators.

[![Star History Chart](https://api.star-history.com/svg?repos=xixihhhh/hotclip&type=Date)](https://star-history.com/#xixihhhh/hotclip&Date)

**⭐ Star the repo to catch new releases first.**
