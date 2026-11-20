/** Camera centre and width as fractions of the displayed source frame. */
export interface CameraRegion { x: number; y: number; width: number }
export const DEFAULT_CAMERA: CameraRegion = { x: 0.15, y: 0.18, width: 0.22 };
export const CAMERA_WIDTH_MIN = 0.08;
export const CAMERA_WIDTH_MAX = 1;
export const CAMERA_PANEL = { width: 1080, height: 768, gameHeight: 1152 } as const;

export function normalizeCameraRegion(value: unknown): CameraRegion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, width } = value as Partial<CameraRegion>;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" ||
      !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width)) return undefined;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(CAMERA_WIDTH_MIN, Math.min(CAMERA_WIDTH_MAX, width)),
  };
}

/** Source rectangle displayed in the upper pane, preserving its aspect ratio. */
export function cameraRect(region: CameraRegion, sourceWidth: number, sourceHeight: number) {
  const aspect = CAMERA_PANEL.width / CAMERA_PANEL.height;
  const width = Math.min(sourceWidth * region.width, sourceHeight * aspect);
  const height = width / aspect;
  return {
    x: Math.max(0, Math.min(sourceWidth - width, sourceWidth * region.x - width / 2)),
    y: Math.max(0, Math.min(sourceHeight - height, sourceHeight * region.y - height / 2)),
    width, height,
  };
}
