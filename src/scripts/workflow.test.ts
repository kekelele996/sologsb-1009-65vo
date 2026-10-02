import { describe, expect, it } from "vitest";
import { buildLiveBlocks, exportHtml, parkedEntries, simplifyText } from "./model";
import {
  ingestNewSource,
  loadWorkspace,
  SAMPLE_NEW_EDITION,
  SOURCE_KEY,
  REWRITE_KEY,
  saveRewrite,
} from "./storage";

class MemoryStore implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

describe("端到端冒烟：两侧工作流", () => {
  it("编辑→通过→换版→沿用/退回/留档/新增→导出", () => {
    const store = new MemoryStore();
    const now = () => "2026-10-02T09:00:00.000Z";

    // 首次启动：示例两侧
    let ws = loadWorkspace(store, now());
    expect(ws.source.blocks.length).toBe(8);

    // 编辑改写一段并通过
    const target = ws.source.blocks.find((b) => b.text.startsWith("雨水花园利用"))!;
    const entry = ws.rewrite.entries.find((e) => e.sourceId === target.id)!;
    entry.accessibleText = simplifyText(target.text, ws.rewrite.glossary);
    entry.changeReason = "编辑手动改写：拆短句";
    entry.conclusion = "结论：三个短句";
    entry.reviewStatus = "approved";
    saveRewrite(store, ws.rewrite);

    // 接入演示新版（含挪位、改动、删除、新增）
    const status = ingestNewSource(store, ws.source, ws.rewrite, { text: SAMPLE_NEW_EDITION, edition: "2026 修订版" }, now());
    expect(status.ok).toBe(true);

    ws = loadWorkspace(store, now());
    const live = buildLiveBlocks(ws.source, ws.rewrite);

    // 挪位且未动的段落沿用已通过
    const moved = live.find((i) => i.block.text.startsWith("当太阳照射"))!;
    expect(moved.entry.reviewStatus).toBe("approved");
    expect(moved.entry.stale).toBe(false);

    // 手动通过的段落这次原文被改写 → 退回、已通过作废、历史留档
    const changed = live.find((i) => i.block.text.startsWith("雨水花园利用"))!;
    expect(changed.entry.reviewStatus).toBe("pending");
    expect(changed.entry.stale).toBe(true);
    expect(changed.entry.history.at(-1)?.reviewStatus).toBe("approved");
    expect(changed.entry.history.at(-1)?.accessibleText).toContain("雨水花园使用土壤");

    // 删掉的链接挪到留档区
    const parked = parkedEntries(ws.rewrite);
    expect(parked.some((e) => e.parkedSource?.text === "点击这里")).toBe(true);

    // 新增段落待改写
    const added = live.find((i) => i.block.text.includes("缩短淋浴时间"))!;
    expect(added.entry.reviewStatus).toBe("pending");

    // 导出不含留档块、含新增块
    const html = exportHtml(ws.rewrite.title, live);
    expect(html).not.toContain("点击这里");
    expect(html).toContain("缩短淋浴时间");
    expect(html).toContain('lang="zh-CN"');

    // 两侧 key 独立存在
    expect(store.getItem(SOURCE_KEY)).toBeTruthy();
    expect(store.getItem(REWRITE_KEY)).toBeTruthy();
  });
});
