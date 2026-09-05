import { useEffect, useRef, useState } from "react";
import { useAsrStore } from "../stores/asr-store";
import { useT } from "../i18n/store";
import { getApi } from "../api/provider";

export function LocalSpeechConnection(): React.JSX.Element {
  const t = useT("transcribe");
  const { localServiceUrl, setLocalServiceUrl } = useAsrStore();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const serial = useRef(0);
  useEffect(() => () => { serial.current++; }, []);
  return <div className="space-y-2 rounded-lg border border-line bg-panel p-3" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <label className="block text-xs">{t("localService")}<input value={localServiceUrl} onChange={(event) => { serial.current++; setBusy(false); setLocalServiceUrl(event.target.value); setStatus(""); }} className="mt-1 w-full rounded border border-line bg-panel-2 px-3 py-2" /></label>
    <button type="button" disabled={busy} onClick={() => {
      const id = ++serial.current;
      setBusy(true); setStatus(t("serviceChecking"));
      void getApi().checkLocalSpeech(localServiceUrl).then((info) => {
        if (id === serial.current) setStatus(`${info.model} · ${info.device} · ${t(info.aligner ? "serviceWithAligner" : "serviceWithoutAligner")}`);
      }, () => { if (id === serial.current) setStatus(t("serviceUnavailable")); }).finally(() => { if (id === serial.current) setBusy(false); });
    }} className="rounded border border-line px-3 py-2 text-xs disabled:opacity-40">{t("serviceCheck")}</button>
    <p role="status" className="text-xs leading-relaxed text-mut">{status || t("serviceSetupHint")}</p>
  </div>;
}
