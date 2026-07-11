import { describe, it, expect } from "vitest";
import { SAFE_ZONE_PLATFORMS, zonesFor, fitContain, cropRect9x16 } from "../../shared/safe-zones";

describe("SAFE_ZONE_PLATFORMS 数据合法性", () => {
  it("至少含通用预设,矩形全部落在画面内", () => {
    expect(SAFE_ZONE_PLATFORMS.length).toBeGreaterThan(0);
    for (const p of SAFE_ZONE_PLATFORMS) {
      expect(p.id).toBeTruthy();
      expect(p.name.zh).toBeTruthy();
      expect(p.name.en).toBeTruthy();
      expect(p.zones.length).toBeGreaterThan(0);
      for (const z of p.zones) {
        expect(z.x).toBeGreaterThanOrEqual(0);
        expect(z.y).toBeGreaterThanOrEqual(0);
        expect(z.w).toBeGreaterThan(0);
        expect(z.h).toBeGreaterThan(0);
        expect(z.x + z.w).toBeLessThanOrEqual(1.0001);
        expect(z.y + z.h).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it("zonesFor:未知 id 回落第一个预设", () => {
    expect(zonesFor("不存在的平台")).toBe(SAFE_ZONE_PLATFORMS[0]);
    for (const p of SAFE_ZONE_PLATFORMS) expect(zonesFor(p.id)).toBe(p);
  });
});

describe("fitContain(object-contain 显示盒)", () => {
  it("宽视频在方容器:上下留黑边", () => {
    const b = fitContain(100, 100, 16 / 9);
    expect(b.w).toBeCloseTo(100);
    expect(b.h).toBeCloseTo(100 / (16 / 9));
    expect(b.x).toBeCloseTo(0);
    expect(b.y).toBeCloseTo((100 - b.h) / 2);
  });

  it("竖视频在宽容器:左右留黑边", () => {
    const b = fitContain(200, 100, 9 / 16);
    expect(b.h).toBeCloseTo(100);
    expect(b.w).toBeCloseTo(100 * (9 / 16));
    expect(b.x).toBeCloseTo((200 - b.w) / 2);
  });

  it("非法输入回零盒", () => {
    expect(fitContain(0, 100, 1)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(fitContain(100, 100, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("cropRect9x16(竖屏中心裁窗)", () => {
  it("16:9 显示盒:裁窗满高、水平居中、比例 9:16", () => {
    const box = { x: 0, y: 0, w: 160, h: 90 };
    const c = cropRect9x16(box);
    expect(c.h).toBeCloseTo(90);
    expect(c.w).toBeCloseTo(90 * (9 / 16));
    expect(c.x).toBeCloseTo((160 - c.w) / 2);
    expect(c.y).toBeCloseTo(0);
  });

  it("已是 9:16 的显示盒:裁窗即全盒", () => {
    const box = { x: 10, y: 5, w: 90, h: 160 };
    const c = cropRect9x16(box);
    expect(c.x).toBeCloseTo(10);
    expect(c.y).toBeCloseTo(5);
    expect(c.w).toBeCloseTo(90);
    expect(c.h).toBeCloseTo(160);
  });

  it("比 9:16 更窄的源:裁窗保宽、垂直居中", () => {
    const box = { x: 0, y: 0, w: 45, h: 160 }; // 窄于 9:16
    const c = cropRect9x16(box);
    expect(c.w).toBeCloseTo(45);
    expect(c.h).toBeCloseTo(45 * (16 / 9));
    expect(c.y).toBeCloseTo((160 - c.h) / 2);
  });
});
