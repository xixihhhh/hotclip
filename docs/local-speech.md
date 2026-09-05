# 长稿编辑与本地语音 / Long transcripts and local speech

## 编辑与恢复

- 本地转写每完成一个 28 秒识别窗口就原子保存结果。停止、退出或异常中断后，对同一素材使用同一引擎再次开始，会复用已完成窗口。素材版本、模型配置、语言或运行契约变化会重新计算。可用“从头重新转写”清除本次进度。
- PCM 保存在临时磁盘文件，识别时每次只读一个窗口。恢复时只抽取剩余音频；完整结果缓存仍然保留。缓存不可写时仍可完成转写，但不能保证下次恢复。云端 ElevenLabs 不提供本地分段恢复。
- 逐句稿支持忽略大小写、标点和空白的跨句搜索，兼容组合重音、全角字符与多种文字。Enter / Shift+Enter 跳到下一项 / 上一项；匹配内容高亮。每次搜索最多展示 2,000 项结果，缩小关键词可继续定位。
- 长稿只渲染当前视口附近的句子，行高随文字内容变化。编辑区采用紧凑预览，时间轴可展开；较小窗口内仍可滚动到全部控件。
- 打开“校准时间”，勾选句子或选择当前待复核句，生成校准预览。支持原时间 / 新时间试听，确认应用后可用工作台撤销或重做。每批最多 20 句、总计 5 分钟，单句不超过 2 分钟 / 2,000 字符。校准保留原文和句子边界。
- Paraformer 校准仅用于中文 / 英文；其他语种选择 Qwen3 与明确语言。模型不支持、匹配不足或时间无效的句子会保留原时间并计入跳过项。自动语言无法明确识别时，请手动指定。
- 导出字幕按文字类型使用不同阅读速度预设，合并能容纳的短行，并在相邻字幕、说话人和剪辑边界内延长显示。ASS、动态字幕、SRT 与质检共用显示规划；逐字高亮的语音时间不随显示延长而改变。仍无法满足阅读速度的字幕继续报告告警。

## 可选 Qwen3 本地服务

默认引擎仍为 SenseVoice。Qwen3-ASR 0.6B / 1.7B 是用户管理的可选服务；HotClip 不自动安装 Python、不自动启动服务，也不将素材发送到远程地址。模型首次由服务加载时下载并缓存在本机。协议仅接受 `http://127.0.0.1:<端口>` 或 `http://[::1]:<端口>`，拒绝重定向。

在源码目录中建立独立 Python 3.12 环境（已验证 `qwen-asr==0.0.6`、`transformers==4.57.6`）：

```sh
python3.12 -m venv .venv-qwen
.venv-qwen/bin/python -m pip install "qwen-asr==0.0.6"
.venv-qwen/bin/python tools/qwen-speech-server.py --model 0.6B --device cpu --aligner
```

Windows 将 `.venv-qwen/bin/python` 换成 `.venv-qwen\Scripts\python.exe`。安装包也携带 `speech/qwen-speech-server.py`（位于应用的 Resources / resources 目录），可用独立环境直接运行。CPU 路径已做 macOS ARM64 实测；`--device mps` / `--device cuda:0` 与 Windows、Linux 需要在目标设备另行验证，不代表已验证的加速效果。

启动后，在“转写引擎”中选择 Qwen3-ASR，填写 `http://127.0.0.1:8766` 并“检查连接”。界面会显示实际加载的模型、设备和对齐器状态。`--model 1.7B` 选择更大的模型；`--port` 可改端口。省略 `--aligner` 可减少模型加载，转写字词时间将明确标为估算，编辑阶段的 Qwen 校准不可用。停止客户端任务会中止等待；服务可能仍在完成当前推理，忙碌时会返回明确错误，完成后可续跑。

Qwen3-ASR 的识别语种范围和 ForcedAligner 的对齐语种范围不同。对齐支持 zh / en / yue / fr / de / it / ja / ko / pt / ru / es，其他识别语种使用估算时间。零时长字词不会被当作准确时间锚点，保留文字并标记插值或估时。完整识别原文（含标点）保留。[模型与运行接口说明](https://github.com/QwenLM/Qwen3-ASR)

```sh
pnpm cli transcribe recording.mp4 --engine qwen3 --asr-url http://127.0.0.1:8766 --json
pnpm cli transcribe recording.mp4 --engine sensevoice --restart-transcription
```

`transcribe`、`highlights`、`clip` 都支持 `--engine` / `--asr-url` / `--restart-transcription`。MCP 的三个对应工具支持 `engineId` / `localServiceUrl` / `restart`。显式提供字幕文件时仍优先导入字幕，不启动 ASR。

## 可复现评估

```json
[
  { "id": "clean-zh", "audio": "speech.wav", "text": "人工确认的原文" },
  { "id": "silence", "audio": "silence.wav", "text": "" }
]
```

将上面的清单保存为 `fixtures.json`，音频路径相对于清单；显式选择参与测试的本地模型：

```sh
pnpm quality:eval:asr fixtures.json sensevoice,qwen3
```

输出字符 / 单词错误率、实时率、静音误识别、时间来源和主进程内存采样。`HOTCLIP_MODELS_DIR` 指定本地模型缓存，`HOTCLIP_QWEN_URL` 指定服务。首次测试可含模型准备耗时，应预热后再比较；主进程 RSS 不包含独立 Qwen 服务，不能直接作两种模型的内存排名。若需边界误差，给样例添加人工标注的 `boundaries: { firstSec, lastSec }`，未标注时输出 null。

2026-09-05 的 macOS ARM64 CPU 冒烟覆盖合成中文 10.94 秒、英文 8.57 秒、静音 5 秒。Qwen3-ASR 0.6B + ForcedAligner 与 SenseVoice 的两条语音样例字符错误率均为 0，纯静音样例均无误识别；Qwen 英语虚词的零时长输出已通过插值兼容。两种校准器均完成了同一中文句子的 41 字词校准，并保留原文。样例规模不足以判断真实录播、方言、噪音环境中的整体质量；1.7B 未在本次下载实测。

## English

Local transcription checkpoints each completed 28-second decode window and resumes the same source/model configuration after interruption. PCM stays on disk; only one window is read at a time. Use **Start over** to discard that run's partial results. Cache faults lose reuse, not the ability to transcribe; cloud jobs do not support local window recovery.

The transcript supports Unicode-aware cross-sentence search, highlighted matches, Enter / Shift+Enter navigation and dynamic-height virtualization. Search is capped at 2,000 matches. The transcript workspace provides a compact player and an expandable timeline.

**Align timing** previews selected or uncertain sentences before an explicit apply. Listen before/after, apply, then undo or redo. Limits: 20 sentences / 5 minutes per batch, 2 minutes / 2,000 characters per sentence. Original text and cue boundaries remain intact. Unsupported languages, poor matches and invalid timings keep the originals with a skipped count. Paraformer is Chinese/English; choose Qwen3 and an explicit supported language for other scripts.

Exports share a language-aware caption display plan across ASS, web overlays, SRT and quality checks. Short lines merge only within width, speaker and splice constraints. Display duration extends into available space without moving speech/karaoke timestamps. Unresolved reading-speed issues remain visible in the report.

Qwen3 is optional and user-managed. Follow the Python commands above, then choose Qwen3-ASR and check the loopback URL in the engine settings. The service accepts `--model 0.6B|1.7B`, `--device cpu|mps|cuda:0`, `--port` and `--aligner`. First load downloads model weights locally. HotClip installs no Python runtime automatically and rejects remote service URLs and redirects. Without the aligner, word times are marked estimated. The ASR and alignment language sets differ; see the explicit list above. Client cancellation stops waiting; a service already inferring may finish that request before becoming available again.

Run `pnpm quality:eval:asr fixtures.json sensevoice,qwen3` against locally annotated fixtures to measure character/word errors, runtime, silence hallucinations and timing provenance. Paths are relative to the manifest. Memory is a host-process sample, not total service memory; boundary error requires manual `boundaries` labels. The small CPU smoke covered 0.6B, Chinese/English synthesized speech and silence; it does not establish general accuracy or GPU/cross-platform performance. The 1.7B path remains opt-in and was not benchmarked in this run.
