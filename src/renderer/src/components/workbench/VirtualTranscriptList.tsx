import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptSegment } from "../../../../shared/api-types";

function lowerBound(offsets: number[], value: number): number {
  let low = 0, high = offsets.length - 1;
  while (low < high) { const mid = Math.floor((low + high + 1) / 2); if (offsets[mid] <= value) low = mid; else high = mid - 1; }
  return low;
}

function MeasuredRow({ id, top, measure, children }: { id: number; top: number; measure: (id: number, size: number) => void; children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current!;
    const observer = new ResizeObserver(() => measure(id, node.getBoundingClientRect().height));
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, measure]);
  return <div ref={ref} style={{ position: "absolute", top, left: 0, right: 0 }}>{children}</div>;
}

export function VirtualTranscriptList({ segments, targetId, targetKey, pinnedId, children, label }: {
  segments: TranscriptSegment[]; targetId?: number; targetKey?: string; pinnedId: number | null; children: (segment: TranscriptSegment) => ReactNode; label: string;
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const sizes = useRef(new Map<number, number>());
  const [revision, setRevision] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(500);
  const measure = useCallback((id: number, size: number) => {
    if (size > 0 && Math.abs((sizes.current.get(id) ?? 0) - size) > 0.5) {
      sizes.current.set(id, size); setRevision((v) => v + 1);
    }
  }, []);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => setHeight(viewport.current?.clientHeight ?? 500));
    observer.observe(viewport.current!);
    return () => observer.disconnect();
  }, []);
  const offsets = useMemo(() => {
    const values = [0];
    for (const segment of segments) values.push(values[values.length - 1] + (sizes.current.get(segment.id) ?? 48));
    return values;
  }, [segments, revision]);
  const targetIndex = segments.findIndex((s) => s.id === targetId);
  useEffect(() => {
    if (targetIndex < 0 || !viewport.current) return;
    const top = offsets[targetIndex];
    viewport.current.scrollTop = top;
    setScroll(top);
    const frame = requestAnimationFrame(() => viewport.current?.querySelector("mark")?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
    // Do not follow subsequent row measurements while the user scrolls away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, targetKey, segments]);
  useEffect(() => {
    const node = viewport.current;
    if (node && scroll > offsets[offsets.length - 1]) { node.scrollTop = 0; setScroll(0); }
  }, [offsets, scroll]);
  const start = Math.max(0, lowerBound(offsets, scroll) - 4);
  const end = Math.min(segments.length, lowerBound(offsets, scroll + height) + 6);
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
  const pinnedIndex = segments.findIndex((s) => s.id === pinnedId);
  if (pinnedIndex >= 0 && !indices.includes(pinnedIndex)) indices.push(pinnedIndex);
  indices.sort((a, b) => a - b);
  return <div ref={viewport} onScroll={(event) => setScroll(event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-y-auto" aria-label={label}>
    <div style={{ position: "relative", height: offsets[offsets.length - 1] }}>
      {indices.map((index) => <MeasuredRow key={segments[index].id} id={segments[index].id} top={offsets[index]} measure={measure}>{children(segments[index])}</MeasuredRow>)}
    </div>
  </div>;
}
