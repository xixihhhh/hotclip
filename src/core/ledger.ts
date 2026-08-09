/**
 * 分发台账(v0.14):2026-07 起平台对切片/二创的授权审核要求「逐条分发记录」
 * ——授权方核查时要能对上:哪条成片、来自哪个源文件的哪个区间、什么时候
 * 导出、发到了哪。我们持有源文件与精确时间戳,台账几乎零成本;发布侧的
 * 四列(平台/账号/链接/日期)留空给用户手填,这正是审核台账的形态。
 *
 * CSV 带 UTF-8 BOM(Excel 双击打开中文不乱码);字段含逗号/引号/换行时按
 * RFC4180 转义。纯函数,可单测。
 */

/** 一条台账行(导出侧填得出的部分)。 */
export interface LedgerRow {
  /** 成片文件名。 */
  file: string;
  title: string;
  durationSec: number;
  /** 源文件绝对路径。 */
  source: string;
  sourceStartSec: number | null;
  sourceEndSec: number | null;
  /** 拼接段数(1 = 连续切片)。 */
  pieces: number;
  /** ISO 导出时间。 */
  exportedAt: string;
  /** 是否带 AIGC 标识。 */
  aigcLabel: boolean;
  /** 变形度评分(0-100;缺省 = 未评估)。 */
  transformScore: number | null;
}

/** RFC4180 字段转义:含逗号/引号/换行才加引号,内部引号翻倍。 */
export function csvField(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = [
  "成片文件",
  "标题",
  "时长(秒)",
  "源文件",
  "源开始(秒)",
  "源结束(秒)",
  "拼接段数",
  "导出时间",
  "AIGC标识",
  "变形度(0-100)",
  // 以下四列留给用户逐条手填——授权审核要的「一视频一条分发记录」
  "发布平台",
  "发布账号",
  "发布链接",
  "发布日期",
];

/** 台账 CSV 全文(含 BOM 与表头;发布侧四列留空待填)。 */
export function buildLedgerCsv(rows: LedgerRow[]): string {
  const BOM = "\uFEFF"; // Excel 双击打开中文不乱码
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.file),
        csvField(r.title),
        csvField(Number(r.durationSec.toFixed(1))),
        csvField(r.source),
        csvField(r.sourceStartSec !== null ? Number(r.sourceStartSec.toFixed(1)) : null),
        csvField(r.sourceEndSec !== null ? Number(r.sourceEndSec.toFixed(1)) : null),
        csvField(r.pieces),
        csvField(r.exportedAt),
        csvField(r.aigcLabel ? "是" : "否"),
        csvField(r.transformScore),
        "", "", "", "",
      ].join(",")
    );
  }
  return BOM + lines.join("\r\n") + "\r\n";
}
