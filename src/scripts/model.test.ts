import { describe, expect, it } from "vitest";
import {
  blockFingerprint,
  buildLiveBlocks,
  joinSource,
  parseImportedChapter,
  parkedEntries,
  reconcileRewrite,
  similarity,
  type ParsedBlockInput,
  type RewriteDocument,
  type SourceDocument,
} from "./model";

const now = "2026-10-02T08:00:00.000Z";

function seedSource(): SourceDocument {
  return {
    schema: 2,
    kind: "source",
    id: "source-1",
    title: "教材",
    subject: "科学",
    grade: "五年级",
    edition: "初版",
    updatedAt: now,
    blocks: [
      { id: "b-h1", type: "heading", headingLevel: 1, text: "第一章 水" },
      { id: "b-p1", type: "paragraph", text: "水会蒸发，水蒸气升到空中形成云，然后变成雨落下来。" },
      { id: "b-p2", type: "paragraph", text: "城市排水系统在暴雨时承受很大压力。" },
      { id: "b-img", type: "image", text: "图1 水循环", imageSrc: "https://example.test/a.svg", imageAlt: "" },
      { id: "b-link", type: "link", text: "点击这里", linkHref: "/water" },
    ],
  };
}

function seedRewrite(source: SourceDocument): RewriteDocument {
  const entry = (id: string, status: RewriteDocument["entries"][number]["reviewStatus"], extra = {}) => ({
    id: `e-${id}`,
    sourceId: id,
    sourceFingerprint: blockFingerprint(source.blocks.find((block) => block.id === id)!),
    state: "live" as const,
    accessibleText: `改写-${id}`,
    changeReason: `原因-${id}`,
    conclusion: `结论-${id}`,
    reviewStatus: status,
    stale: false,
    history: [],
    comments: [],
    updatedAt: now,
    ...extra,
  });
  return {
    schema: 2,
    kind: "rewrite",
    id: "rewrite-1",
    title: "教材·改写稿",
    entries: [
      entry("b-h1", "approved"),
      entry("b-p1", "approved"),
      entry("b-p2", "pending"),
      entry("b-img", "needs-work"),
      entry("b-link", "pending"),
    ],
    glossary: [],
    versions: [],
    updatedAt: now,
  };
}

function parse(text: string): ParsedBlockInput[] {
  return parseImportedChapter(text);
}

describe("joinSource 逐块对接", () => {
  it("段落整体挪动时按内容对上，沿用原改写且保持已通过", () => {
    const source = seedSource();
    const rewrite = seedRewrite(source);
    // 新版：p1 与 p2 交换位置，文字一个字都没动
    const moved = `# 第一章 水

城市排水系统在暴雨时承受很大压力。

水会蒸发，水蒸气升到空中形成云，然后变成雨落下来。

![](https://example.test/a.svg) 图1 水循环

[点击这里](/water)`;
    const result = joinSource(source, rewrite, parse(moved), "第2版", now);

    expect(result.report.reused).toBe(5);
    expect(result.report.added + result.report.changed + result.report.removed).toBe(0);

    const blocks = buildLiveBlocks(result.source, result.rewrite);
    const movedParagraph = blocks[1]; // 新版第二块是旧 p2
    const entryForMoved = movedParagraph.entry;
    expect(movedParagraph.block.text).toContain("城市排水系统");
    expect(entryForMoved.accessibleText).toBe("改写-b-p2");
    expect(entryForMoved.reviewStatus).toBe("pending");
    expect(entryForMoved.stale).toBe(false);

    // 已通过的块跟着内容走，不因为位置变化失效
    const p1 = blocks.find((item) => item.block.text.includes("水会蒸发"))!;
    expect(p1.entry.reviewStatus).toBe("approved");
    expect(p1.entry.conclusion).toBe("结论-b-p1");
    expect(parkedEntries(result.rewrite)).toHaveLength(0);
  });

  it("原稿文字动过：退回待改写、已通过作废，旧改写留档对照", () => {
    const source = seedSource();
    const rewrite = seedRewrite(source);
    const edited = `# 第一章 水

水会蒸发，水蒸气升到空中形成云，随后化作雨水回到地面。

城市排水系统在暴雨时承受很大压力。

![](https://example.test/a.svg) 图1 水循环

[点击这里](/water)`;
    const result = joinSource(source, rewrite, parse(edited), "第2版", now);
    expect(result.report.changed).toBe(1);

    const blocks = buildLiveBlocks(result.source, result.rewrite);
    const changed = blocks.find((item) => item.block.text.includes("化作雨水"))!;
    expect(changed.entry.reviewStatus).toBe("pending");
    expect(changed.entry.stale).toBe(true);
    // 旧改写留着对照
    expect(changed.entry.accessibleText).toBe("改写-b-p1");
    expect(changed.entry.history).toHaveLength(1);
    expect(changed.entry.history[0].sourceSnapshot.text).toContain("然后变成雨落下来");
    expect(changed.entry.history[0].reviewStatus).toBe("approved");
  });

  it("原稿去掉的块挪到 parked 一边，旧改写完整保留", () => {
    const source = seedSource();
    const rewrite = seedRewrite(source);
    const shrunk = `# 第一章 水

水会蒸发，水蒸气升到空中形成云，然后变成雨落下来。

![](https://example.test/a.svg) 图1 水循环`;
    const result = joinSource(source, rewrite, parse(shrunk), "第2版", now);
    expect(result.report.removed).toBe(2); // p2 与 link 被删

    const parked = parkedEntries(result.rewrite);
    expect(parked.map((entry) => entry.sourceId).sort()).toEqual(["b-link", "b-p2"]);
    expect(parked[0].parkedSource?.text).toBeTruthy();
    expect(parked[0].accessibleText).toMatch(/^改写-b-(link|p2)$/);
    expect(buildLiveBlocks(result.source, result.rewrite)).toHaveLength(3);
  });

  it("新加的块按待改写进来，无障碍文本默认等于原文", () => {
    const source = seedSource();
    const rewrite = seedRewrite(source);
    const grown = `# 第一章 水

水会蒸发，水蒸气升到空中形成云，然后变成雨落下来。

城市排水系统在暴雨时承受很大压力。

新增的一段：节水要从随手关龙头做起。

![](https://example.test/a.svg) 图1 水循环

[点击这里](/water)`;
    const result = joinSource(source, rewrite, parse(grown), "第2版", now);
    expect(result.report.added).toBe(1);

    const fresh = result.report.items.find((item) => item.outcome === "added")!;
    expect(fresh.sourceText).toContain("节水要从随手关龙头");
    const blocks = buildLiveBlocks(result.source, result.rewrite);
    const added = blocks.find((item) => item.block.text.includes("随手关龙头"))!;
    expect(added.entry.reviewStatus).toBe("pending");
    expect(added.entry.stale).toBe(false);
    expect(added.entry.accessibleText).toBe(added.block.text);
    expect(added.entry.changeReason).toBe("");
  });

  it("改标题层级也算原稿动过，已通过作废", () => {
    const source = seedSource();
    const rewrite = seedRewrite(source);
    const levelChanged = `# 第一章 水

水会蒸发，水蒸气升到空中形成云，然后变成雨落下来。

城市排水系统在暴雨时承受很大压力。

![](https://example.test/a.svg) 图1 水循环

[点击这里](/water)`;
    // 直接构造：把 H1 改成 H2、文字不变
    const parsed = parse(levelChanged);
    parsed[0] = { type: "heading", text: "第一章 水", headingLevel: 2 };
    const result = joinSource(source, rewrite, parsed, "第2版", now);
    const changedHeading = result.report.items.find((item) => item.blockType === "heading");
    expect(changedHeading?.outcome).toBe("changed");
    const blocks = buildLiveBlocks(result.source, result.rewrite);
    expect(blocks[0].entry.reviewStatus).toBe("pending");
    expect(blocks[0].entry.stale).toBe(true);
  });
});

describe("相似度与解析", () => {
  it("中文按字二元组计算，完全相同为 1，无关文本接近 0", () => {
    expect(similarity("水循环包括蒸发和降水", "水循环包括蒸发和降水")).toBe(1);
    expect(similarity("水循环包括蒸发和降水", "今天下午我们去操场踢球")).toBeLessThan(0.2);
    expect(similarity("水会蒸发形成云，再变成雨", "水会蒸发形成云，随后变成雨落下来")).toBeGreaterThan(0.5);
  });

  it("空输入解析为空块列表", () => {
    expect(parseImportedChapter("  \n \n\t ")).toEqual([]);
  });
});

describe("reconcileRewrite 启动期对账", () => {
  it("原稿重建后多出的块补建待改写条目，挂空的旧条目挪到 parked", () => {
    const source = seedSource();
    const rewrite = seedRewrite(source);
    // 模拟原稿侧损坏后重建：块 id 全部变了，编辑侧还是旧条目
    const rebuiltSource: SourceDocument = {
      ...source,
      blocks: source.blocks.map((block) => ({ ...block, id: `new-${block.id}` })),
    };
    const reconciled = reconcileRewrite(rebuiltSource, rewrite, now);
    const live = reconciled.entries.filter((entry) => entry.state === "live");
    const parked = reconciled.entries.filter((entry) => entry.state === "parked");
    expect(live).toHaveLength(5);
    expect(parked).toHaveLength(5);
    // 编辑写的内容仍在留档里
    expect(parked[0].accessibleText).toMatch(/^改写-/);
    // 新块都是待改写
    expect(live.every((entry) => entry.reviewStatus === "pending")).toBe(true);
    expect(buildLiveBlocks(rebuiltSource, reconciled)).toHaveLength(5);
  });

  it("两侧配套时不产生改动（同一引用）", () => {
    const source = seedSource();
    const rewrite = seedRewrite(source);
    expect(reconcileRewrite(source, rewrite, now)).toBe(rewrite);
  });
});
