/**
 * 出片方案面板:33 个开关按用途收进六组,循环档改分段控件,「打开文件/
 * 弹窗」不再伪装成开关;当前组合可存成命名方案,一键复用。
 */
import { EpisodeRecipes } from "../EpisodeRecipes";
import { useEffect, useRef, useState } from "react";
import { LuX, LuPalette, LuTrash2, LuLoaderCircle, LuRectangleVertical, LuScissors, LuAudioLines, LuCaptions, LuUpload, LuPackage, LuLayers } from "react-icons/lu";
import { useT, useLocaleStore } from "../../i18n/store";
import { getApi } from "../../api/provider";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { useLlmStore } from "../../stores/llm-store";
import { useSchemes, BUILTIN_SCHEMES, matchesScheme } from "../../stores/scheme-store";
import { PLATFORM_SPECS } from "../../../../shared/platform-specs";
import { ModalShell, Segmented, SwitchRow } from "../ui";
import type { CaptionStyleChoice } from "../../../../shared/api-types";

const CAPTION_ORDER: CaptionStyleChoice[] = ["keyword", "pop", "bubble", "hormozi", "minimal", "karaoke", "none"];
const CAPTION_KEY: Record<CaptionStyleChoice, string> = {
  none: "captionNone",
  karaoke: "captionKaraoke",
  keyword: "captionKeyword",
  pop: "captionPop",
  hormozi: "captionHormozi",
  minimal: "captionMinimal",
  bubble: "captionBubble",
};

const PANELS = [
  ["groupPicture", LuRectangleVertical], ["groupCut", LuScissors], ["groupAudio", LuAudioLines],
  ["groupCaption", LuCaptions], ["groupPublish", LuUpload], ["groupDistribute", LuPackage], ["recipes", LuLayers],
] as const;
type Panel = typeof PANELS[number][0];

function Group({ active, title, children }: { active: boolean; title: string; children: React.ReactNode }) {
  if (!active) return null;
  return <section className="export-group"><h3>{title}</h3>{children}</section>;
}

export function ExportPanel({
  onNext,
  hasVideo,
  diarize,
  atlasReady,
  onClose,
  onOpenBrand,
}: {
  onNext: () => Promise<boolean>;
  hasVideo: boolean;
  diarize: boolean;
  atlasReady: boolean;
  onClose: () => void;
  onOpenBrand: () => void;
}): React.JSX.Element {
  const t = useT("workbench");
  const th = useT("highlights");
  const ts = useT("settings");
  const lang = useLocaleStore((s) => s.locale);
  const { config } = useLlmStore();
  const { prefs, setPref } = useRenderPrefs();
  const { userSchemes, saveCurrent, remove } = useSchemes();
  const [schemeName, setSchemeName] = useState("");
  const [bgmBusy, setBgmBusy] = useState(false);

  const [panel, setPanel] = useState<Panel>("groupPicture");
  const consoleRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    consoleRef.current?.querySelector<HTMLButtonElement>('nav button[aria-current="page"]')?.focus();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);

  const splitCamera = hasVideo && prefs.vertical && prefs.gameCameraEnabled;
  const schemes = [...BUILTIN_SCHEMES, ...userSchemes];
  const activeScheme = schemes.find((s) => matchesScheme(prefs, s));

  const pickBgm = async (): Promise<void> => {
    const p = await getApi().selectAudio();
    if (p) setPref({ bgmPath: p });
  };
  const bgmName = prefs.bgmPath ? (prefs.bgmPath.split(/[\\/]/).pop() ?? "") : "";

  return (
    <ModalShell onClose={onClose}>
      <section
        className="export-console" ref={consoleRef}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary"))
            .filter((node) => node.getClientRects().length > 0);
          const first = nodes[0], last = nodes.at(-1);
          if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
        }}
        onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t("exportPanelTitle")}>
        <header className="console-header">
          <h2>{t("exportPanelTitle")}</h2>
          <button type="button" className="desk-icon" onClick={onClose} aria-label={t("deskClose")}><LuX size={18} /></button>
        </header>
        <div className="console-body">
          <nav aria-label={t("deskSections")} className="console-nav" onKeyDown={(event) => {
            const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
            if (current < 0 || (step === undefined && event.key !== "Home" && event.key !== "End")) return;
            event.preventDefault();
            const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (step ?? 0) + buttons.length) % buttons.length;
            buttons[index].focus(); buttons[index].click();
          }}>{PANELS.map(([key, Icon]) =>
            <button type="button" key={key} aria-current={panel === key ? "page" : undefined} onClick={() => setPanel(key)}>
              <Icon aria-hidden="true" size={16}/>{t(key)}
            </button>)}</nav>
          <div className="console-scroller">
            <div hidden={panel !== "recipes"}><EpisodeRecipes onNext={onNext} canSave /></div>
            {panel !== "recipes" && <>
              <div className="scheme-tools">
                <label>{t("schemeLabel")}
                  <select value={activeScheme?.id ?? ""} onChange={(e) => {
                    const chosen = schemes.find((entry) => entry.id === e.target.value);
                    if (chosen) setPref({ ...chosen.prefs });
                  }}>
                    {!activeScheme && <option value="">{t("schemeCustom")}</option>}
                    {schemes.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </select>
                </label>
                {activeScheme && !activeScheme.builtin && <button type="button" className="desk-icon" title={t("schemeDelete")}
                  aria-label={t("schemeDelete")} onClick={() => remove(activeScheme.id)}><LuTrash2 size={15}/></button>}
                <input value={schemeName} aria-label={t("schemeSaveName")} placeholder={t("schemeSaveName")} onChange={(e) => setSchemeName(e.target.value)} />
                <button type="button" className="desk-secondary" disabled={!schemeName.trim()} onClick={() => {
                  saveCurrent(schemeName.trim(), prefs); setSchemeName("");
                }}>{t("schemeSave")}</button>
              </div>
          <Group active={panel === "groupPicture"} title={t("groupPicture")}>
            <SwitchRow label={th("optVertical")} hint={th("optVerticalHint")} on={prefs.vertical} onToggle={() => setPref({ vertical: !prefs.vertical })} />
            <SwitchRow
              label={th("optAlsoLandscape")}
              hint={th("optAlsoLandscapeHint")}
              on={prefs.alsoLandscape && prefs.vertical}
              disabled={!prefs.vertical}
              onToggle={() => setPref({ alsoLandscape: !prefs.alsoLandscape })}
            />
            <SwitchRow label={t("gameCamera")} hint={t("gameCameraHint")} on={splitCamera} disabled={!hasVideo || !prefs.vertical} onToggle={() => setPref({ gameCameraEnabled: !prefs.gameCameraEnabled })} />
            <SwitchRow label={th("optTrimUi")} hint={th("optTrimUiHint")} on={prefs.trimUi && !splitCamera} disabled={splitCamera} onToggle={() => setPref({ trimUi: !prefs.trimUi })} />
            <SwitchRow label={th("optTitleCard")} hint={th("optTitleCardHint")} on={prefs.titleCard} onToggle={() => setPref({ titleCard: !prefs.titleCard })} />
            <SwitchRow
              label={th("optAutoZoom")}
              hint={th("optAutoZoomHint")}
              on={prefs.autoZoom && prefs.vertical && !splitCamera}
              disabled={!prefs.vertical || splitCamera}
              onToggle={() => setPref({ autoZoom: !prefs.autoZoom })}
            />
            <SwitchRow
              label={th("optAutoEnhance")}
              hint={th("optAutoEnhanceHint")}
              on={prefs.autoEnhance}
              onToggle={() => setPref({ autoEnhance: !prefs.autoEnhance })}
            />
            <button
              type="button"
              onClick={onOpenBrand}
              className="mt-1 flex items-center gap-1.5 self-start rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-mut transition-colors hover:border-mut hover:text-fg"
              title={th("optBrandHint")}
            >
              <LuPalette className="h-3.5 w-3.5" />
              {th("optBrand")}
            </button>
          </Group>

          <Group active={panel === "groupCut"} title={t("groupCut")}>
            <SwitchRow label={th("optJumpCut")} hint={th("optJumpCutHint")} on={prefs.jumpCut} onToggle={() => setPref({ jumpCut: !prefs.jumpCut })} />
            <SwitchRow
              label={th("optBreath")}
              hint={th("optBreathHint")}
              on={prefs.keepBreath && prefs.jumpCut}
              disabled={!prefs.jumpCut}
              onToggle={() => setPref({ keepBreath: !prefs.keepBreath })}
            />
            <SwitchRow label={th("optCleanFillers")} hint={th("optCleanFillersHint")} on={prefs.cleanFillers} onToggle={() => setPref({ cleanFillers: !prefs.cleanFillers })} />
            <SwitchRow label={th("optCutRetakes")} hint={th("optCutRetakesHint")} on={prefs.cutRetakes} onToggle={() => setPref({ cutRetakes: !prefs.cutRetakes })} />
            <SwitchRow label={th("optAlign")} hint={th("optAlignHint")} on={prefs.preciseAlign} onToggle={() => setPref({ preciseAlign: !prefs.preciseAlign })} />
            <SwitchRow label={th("optOpeningHook")} hint={th("optOpeningHookHint")} on={prefs.openingHook} onToggle={() => setPref({ openingHook: !prefs.openingHook })} />
            <SwitchRow label={th("optColdOpen")} hint={th("optColdOpenHint")} on={prefs.coldOpen} onToggle={() => setPref({ coldOpen: !prefs.coldOpen })} />
            <SwitchRow label={th("optFlash")} hint={th("optFlashHint")} on={prefs.flashForward} onToggle={() => setPref({ flashForward: !prefs.flashForward })} />
          </Group>

          <Group active={panel === "groupAudio"} title={t("groupAudio")}>
            <SwitchRow label={th("optLoudness")} hint={th("optLoudnessHint")} on={prefs.normalizeLoudness} onToggle={() => setPref({ normalizeLoudness: !prefs.normalizeLoudness })} />
            <SwitchRow label={th("optDenoise")} hint={th("optDenoiseHint")} on={prefs.denoise} onToggle={() => setPref({ denoise: !prefs.denoise })} />
            {prefs.denoise && (
              <div className="flex min-h-7.5 items-center gap-2.5 pl-2" title={th("denoiseModeHint")}>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90">{t("denoiseModeLabel")}</span>
                <Segmented<"basic" | "smart">
                  value={prefs.denoiseMode}
                  ariaLabel={t("denoiseModeLabel")}
                  options={[
                    { value: "basic", label: t("denoiseBasic") },
                    { value: "smart", label: t("denoiseSmart") },
                  ]}
                  onChange={(value) => setPref({ denoiseMode: value })}
                />
              </div>
            )}
            <SwitchRow label={th("optMuteSensitive")} hint={th("optMuteSensitiveHint")} on={prefs.muteSensitive} onToggle={() => setPref({ muteSensitive: !prefs.muteSensitive })} />
            {prefs.muteSensitive && (
              <label className="mb-1 flex items-center gap-2 pl-2 text-[11px] text-mut">
                <span className="shrink-0">{th("sensitiveWordsLabel")}</span>
                <input
                  value={prefs.sensitiveWords.join(", ")}
                  onChange={(event) => setPref({ sensitiveWords: event.target.value.split(/[,，\n]/).map((term) => term.trim()).filter(Boolean).slice(0, 100) })}
                  className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-fg outline-none focus:border-ember/60"
                />
              </label>
            )}
            <SwitchRow label={th("optSfx")} hint={th("optSfxHint")} on={prefs.sfx} onToggle={() => setPref({ sfx: !prefs.sfx })} />
            <div className="flex min-h-7.5 items-center gap-2.5" title={prefs.bgmPath ? th("optBgmOn", { name: bgmName }) : th("optBgmHint")}>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90">
                {t("bgmLabel")}
                {bgmName && <span className="ml-2 text-[10.5px] text-ember/90">{bgmName}</span>}
              </span>
              {bgmBusy ? (
                <span className="flex items-center gap-1 text-[10.5px] text-mut">
                  <LuLoaderCircle className="h-3 w-3 animate-spin" />
                  {th("optAiBgmBusy")}
                </span>
              ) : (
                <Segmented<string>
                  value={prefs.bgmPath ? "file" : "off"}
                  options={[
                    { value: "off", label: t("bgmOff") },
                    { value: "file", label: t("bgmFile"), title: th("optBgmHint") },
                    ...(atlasReady ? [{ value: "ai", label: t("bgmAi"), title: th("optAiBgmHint") }] : []),
                  ]}
                  onChange={(v) => {
                    if (v === "off") setPref({ bgmPath: "" });
                    else if (v === "file") void pickBgm();
                    else {
                      setBgmBusy(true);
                      void getApi()
                        .generateBgm(config, prefs.genreId === "auto" ? undefined : prefs.genreId)
                        .then((p) => p && setPref({ bgmPath: p }))
                        .catch(() => {})
                        .finally(() => setBgmBusy(false));
                    }
                  }}
                />
              )}
            </div>
          </Group>

          <Group active={panel === "groupCaption"} title={t("groupCaption")}>
            <div className="flex min-h-7.5 flex-wrap items-center gap-2.5">
              <span className="text-[12.5px] text-fg/90">{t("captionLabel")}</span>
              <Segmented<CaptionStyleChoice>
                value={prefs.captionStyle}
                options={CAPTION_ORDER.map((c) => ({ value: c, label: ts(CAPTION_KEY[c]) }))}
                onChange={(v) => setPref({ captionStyle: v })}
              />
            </div>
            <SwitchRow
              label={th("optSpeakerTags")}
              hint={th("optSpeakerTagsHint")}
              on={prefs.speakerLabels && diarize}
              disabled={!diarize}
              onToggle={() => setPref({ speakerLabels: !prefs.speakerLabels })}
            />
            <SwitchRow label={th("optTranslateEn")} hint={th("optTranslateHint")} on={prefs.translate} onToggle={() => setPref({ translate: !prefs.translate })} />
            <SwitchRow label={th("optSrt")} hint={th("optSrtHint")} on={prefs.subtitleFile} onToggle={() => setPref({ subtitleFile: !prefs.subtitleFile })} />
          </Group>

          <Group active={panel === "groupPublish"} title={t("groupPublish")}>
            <SwitchRow label={th("optPublish")} hint={th("optPublishHint")} on={prefs.publishCopy} onToggle={() => setPref({ publishCopy: !prefs.publishCopy })} />
            <div className="flex min-h-7.5 items-center gap-2.5" title={th("optAiCoverHint")}>
              <span className={`min-w-0 flex-1 truncate text-[12.5px] ${atlasReady ? "text-fg/90" : "text-mut/60"}`}>{t("coverLabel")}</span>
              <Segmented<string>
                value={prefs.aiCover}
                disabled={!atlasReady}
                options={[
                  { value: "off", label: t("coverOff") },
                  { value: "volume", label: t("coverVolume") },
                  { value: "premium", label: t("coverPremium") },
                ]}
                onChange={(v) => setPref({ aiCover: v as typeof prefs.aiCover })}
              />
            </div>
            <SwitchRow label={th("optAigc")} hint={th("optAigcHint")} on={prefs.aigcLabel} onToggle={() => setPref({ aigcLabel: !prefs.aigcLabel })} />
            <SwitchRow label={th("optEvidence")} hint={th("optEvidenceHint")} on={prefs.evidencePack} onToggle={() => setPref({ evidencePack: !prefs.evidencePack })} />
            <SwitchRow label={th("optJianying")} hint={th("optJianyingHint")} on={prefs.jianyingDraft} onToggle={() => setPref({ jianyingDraft: !prefs.jianyingDraft })} />
            <SwitchRow label={th("optTimeline")} hint={th("optTimelineHint")} on={prefs.timeline} onToggle={() => setPref({ timeline: !prefs.timeline })} />
            <SwitchRow label={th("optCompilation")} hint={th("optCompilationHint")} on={prefs.compilation} onToggle={() => setPref({ compilation: !prefs.compilation })} />
          </Group>

          <Group active={panel === "groupDistribute"} title={t("groupDistribute")}>
            <div className="flex min-h-7.5 items-center gap-2.5" title={th("optVariantsHint")}>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90">{t("variantsLabel")}</span>
              <Segmented<number>
                value={prefs.variants}
                options={[
                  { value: 1, label: "1" },
                  { value: 2, label: "2" },
                  { value: 3, label: "3" },
                ]}
                onChange={(v) => setPref({ variants: v })}
              />
            </div>
            <SwitchRow label={th("optJitter")} hint={th("optJitterHint")} on={prefs.templateJitter} onToggle={() => setPref({ templateJitter: !prefs.templateJitter })} />
            <SwitchRow label={th("optSeriesPack")} hint={th("optSeriesPackHint")} on={prefs.seriesPack} onToggle={() => setPref({ seriesPack: !prefs.seriesPack })} />
            <SwitchRow label={th("optPack")} hint={th("optPackHint")} on={prefs.publishPack} onToggle={() => setPref({ publishPack: !prefs.publishPack })} />
            {prefs.publishPack && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="text-[10.5px] font-semibold text-mut">{th("packPlatformsLabel")}</span>
                {PLATFORM_SPECS.map((p) => {
                  const on = prefs.packPlatforms.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      title={p.noteZh}
                      onClick={() =>
                        setPref({ packPlatforms: on ? prefs.packPlatforms.filter((x) => x !== p.id) : [...prefs.packPlatforms, p.id] })
                      }
                      className={`chip rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                        on ? "border-ember/60 bg-ember/10 text-fg" : "text-mut hover:text-fg"
                      }`}
                    >
                      {lang === "zh" ? p.name.zh : p.name.en}
                    </button>
                  );
                })}
              </div>
            )}
          </Group>
            </>}
          </div>
        </div>
      </section>
    </ModalShell>
  );
}
