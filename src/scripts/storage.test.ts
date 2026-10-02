import { describe, expect, it } from "vitest";
import {
  commitIngest,
  createSeedRewrite,
  createSeedSource,
  ingestNewSource,
  INGEST_JOURNAL_KEY,
  loadWorkspace,
  migrateLegacy,
  REWRITE_KEY,
  saveRewrite,
  SOURCE_KEY,
  type KeyValueStore,
} from "./storage";
import { blockFingerprint, buildLiveBlocks, parkedEntries } from "./model";

const now = "2026-10-02T08:00:00.000Z";

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  /** 设为抛错的 key，模拟配额满 / 存储损坏。 */
  failing = new Set<string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    if (this.failing.has(key)) throw new Error("quota exceeded");
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const NEW_EDITION = `# 第三章 水循环与城市

## 一、水从哪里来

当太阳照射到水面时，水会受热变成水蒸气升到空中。水蒸气冷却后形成云，再以雨或雪的形式落回地面。

城市中的水并非取之不尽，水会通过蒸发、降水与地表径流在自然界中循环。理解这些过程，对建设韧性城市非常重要。

## 二、节水小贴士

在日常生活中，我们可以通过缩短淋浴时间、及时修理漏水的龙头来节约水资源。`;

function seedWorkspace(store: KeyValueStore) {
  const source = createSeedSource(now);
  const rewrite = createSeedRewrite(source, now);
  saveRewrite(store, rewrite);
  store.setItem(SOURCE_KEY, JSON.stringify(source));
  return { source, rewrite };
}

describe("ingestNewSource 失败按侧重试", () => {
  it("文件读不出来（空内容）时两侧数据一概不动", () => {
    const store = new MemoryStore();
    const { source, rewrite } = seedWorkspace(store);
    const beforeSource = store.getItem(SOURCE_KEY);
    const beforeRewrite = store.getItem(REWRITE_KEY);

    const status = ingestNewSource(store, source, rewrite, { text: "  \n  ", edition: "第2版" }, now);
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.stage).toBe("parse");

    expect(store.getItem(SOURCE_KEY)).toBe(beforeSource);
    expect(store.getItem(REWRITE_KEY)).toBe(beforeRewrite);
    expect(store.getItem(INGEST_JOURNAL_KEY)).toBeNull();
  });

  it("源侧写入失败：编辑改写原样保留，重试后接入完成", () => {
    const store = new MemoryStore();
    const { source, rewrite } = seedWorkspace(store);

    store.failing.add(SOURCE_KEY);
    const failed = ingestNewSource(store, source, rewrite, { text: NEW_EDITION, edition: "第2版" }, now);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.stage).toBe("source");
      expect(failed.resumeAvailable).toBe(true);
    }
    // 改写侧完全没被碰过
    const loadedRewrite = JSON.parse(store.getItem(REWRITE_KEY)!);
    expect(loadedRewrite.lastJoinReport).toBeUndefined();
    // 日志停在 pending-source
    const journal = JSON.parse(store.getItem(INGEST_JOURNAL_KEY)!);
    expect(journal.stage).toBe("pending-source");

    store.failing.delete(SOURCE_KEY);
    const retried = commitIngest(store);
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.report.edition).toBe("第2版");
      expect(retried.report.added).toBeGreaterThan(0);
    }
    expect(store.getItem(INGEST_JOURNAL_KEY)).toBeNull();

    const workspace = loadWorkspace(store, now);
    expect(workspace.source.edition).toBe("第2版");
    // 接得上的旧改写沿用（p2 在新版里文字未动）
    const blocks = buildLiveBlocks(workspace.source, workspace.rewrite);
    const untouched = blocks.find((item) => item.block.text.startsWith("当太阳照射"));
    expect(untouched?.entry.reviewStatus).toBe("approved");
  });

  it("改写侧写入失败：原稿已是新版，只重试改写侧，编辑内容随后正常落地", () => {
    const store = new MemoryStore();
    const { source, rewrite } = seedWorkspace(store);

    store.failing.add(REWRITE_KEY);
    const failed = ingestNewSource(store, source, rewrite, { text: NEW_EDITION, edition: "第2版" }, now);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.stage).toBe("rewrite");
      expect(failed.error).toContain("只重试改写侧");
    }
    // 源侧已经提交为新版
    const committedSource = JSON.parse(store.getItem(SOURCE_KEY)!);
    expect(committedSource.edition).toBe("第2版");
    // 改写侧仍旧
    const oldRewrite = JSON.parse(store.getItem(REWRITE_KEY)!);
    expect(oldRewrite.lastJoinReport).toBeUndefined();
    const journal = JSON.parse(store.getItem(INGEST_JOURNAL_KEY)!);
    expect(journal.stage).toBe("pending-rewrite");
    expect(journal.attempts.source).toBe(1);

    store.failing.delete(REWRITE_KEY);
    const retried = commitIngest(store);
    expect(retried.ok).toBe(true);
    const workspace = loadWorkspace(store, now);
    expect(workspace.source.edition).toBe("第2版");
    expect(workspace.rewrite.lastJoinReport?.removed).toBeGreaterThan(0);
    // 删掉的段落（如「点击这里」链接、雨水花园段）挪到了一边
    expect(parkedEntries(workspace.rewrite).length).toBe(workspace.rewrite.lastJoinReport!.removed);
  });

  it("源侧重试是幂等的：一直失败也不会产生重复块", () => {
    const store = new MemoryStore();
    const { source, rewrite } = seedWorkspace(store);
    store.failing.add(SOURCE_KEY);

    ingestNewSource(store, source, rewrite, { text: NEW_EDITION, edition: "第2版" }, now);
    commitIngest(store);
    const journal = JSON.parse(store.getItem(INGEST_JOURNAL_KEY)!);
    expect(journal.attempts.source).toBe(2);
    expect(journal.source.blocks.length).toBe(parseCount(NEW_EDITION));
  });
});

function parseCount(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

describe("两侧独立读取", () => {
  it("原稿侧读坏只重建原稿侧，改写侧保留", () => {
    const store = new MemoryStore();
    const { rewrite } = seedWorkspace(store);
    store.setItem(SOURCE_KEY, "{这不是合法JSON");

    const workspace = loadWorkspace(store, now);
    expect(workspace.source.edition).toBe("出版社初版");
    expect(workspace.notices.some((notice) => notice.includes("原稿侧"))).toBe(true);
    // 编辑写的改写原因等还在
    expect(workspace.rewrite.id).toBe(rewrite.id);
    const withReason = workspace.rewrite.entries.find((entry) => entry.changeReason.includes("拆分长句"));
    expect(withReason).toBeTruthy();
  });

  it("改写侧读坏只重建改写侧，出版社原稿保留", () => {
    const store = new MemoryStore();
    const { source } = seedWorkspace(store);
    store.setItem(REWRITE_KEY, "broken");

    const workspace = loadWorkspace(store, now);
    expect(workspace.source.id).toBe(source.id);
    expect(workspace.notices.some((notice) => notice.includes("改写侧"))).toBe(true);
    // 重建的改写稿按当前原稿逐块建条目
    expect(workspace.rewrite.entries).toHaveLength(source.blocks.length);
  });

  it("启动时发现未完成日志会带回给界面以便按侧重试", () => {
    const store = new MemoryStore();
    const { source, rewrite } = seedWorkspace(store);
    store.failing.add(REWRITE_KEY);
    ingestNewSource(store, source, rewrite, { text: NEW_EDITION, edition: "第2版" }, now);
    store.failing.delete(REWRITE_KEY);

    const workspace = loadWorkspace(store, now);
    expect(workspace.journal?.stage).toBe("pending-rewrite");
  });
});

describe("旧版 schema 1 数据升级", () => {
  it("混装旧数据拆成两侧，原因/结论以外字段与批注保留，版本快照按 sourceId 存", () => {
    const legacy = {
      schema: 1,
      project: {
        id: "p1",
        title: "旧教材",
        subject: "科学",
        grade: "三年级",
        updatedAt: now,
        blocks: [
          {
            id: "block-1",
            type: "paragraph",
            text: "旧原文",
            accessibleText: "旧改写",
            changeReason: "旧原因",
            reviewStatus: "approved",
            comments: [
              { id: "c1", author: "甲", body: "批注内容", createdAt: now, resolved: false, replies: [] },
            ],
          },
        ],
        glossary: [{ id: "t1", source: "术语", preferred: "通俗说法", note: "" }],
        versions: [
          {
            id: "v1",
            label: "版本 1",
            createdAt: now,
            blocks: [
              {
                id: "block-1",
                type: "paragraph",
                text: "旧原文",
                accessibleText: "更早的改写",
                changeReason: "更早的原因",
                reviewStatus: "pending",
                comments: [],
              },
            ],
            glossary: [],
          },
        ],
      },
    };
    const migrated = migrateLegacy(JSON.stringify(legacy), now);
    expect(migrated).not.toBeNull();
    const { source, rewrite } = migrated!;
    expect(source.kind).toBe("source");
    expect(source.blocks[0].text).toBe("旧原文");
    expect(source.blocks[0] as object).not.toHaveProperty("accessibleText");

    expect(rewrite.entries).toHaveLength(1);
    const entry = rewrite.entries[0];
    expect(entry.sourceId).toBe("block-1");
    expect(entry.accessibleText).toBe("旧改写");
    expect(entry.changeReason).toBe("旧原因");
    expect(entry.reviewStatus).toBe("approved");
    expect(entry.comments[0].body).toBe("批注内容");
    expect(entry.sourceFingerprint).toBe(blockFingerprint(source.blocks[0]));

    expect(rewrite.versions[0].entries[0]).toMatchObject({
      sourceId: "block-1",
      accessibleText: "更早的改写",
    });
  });

  it("损坏的旧数据不升级（返回 null），不影响后续示例载入", () => {
    expect(migrateLegacy("not json", now)).toBeNull();
    expect(migrateLegacy(JSON.stringify({ schema: 2 }), now)).toBeNull();
  });

  it("升级后的数据能直接用于再次接入新版原稿", () => {
    const store = new MemoryStore();
    const legacy = {
      schema: 1,
      project: {
        id: "p1",
        title: "旧教材",
        subject: "科学",
        grade: "三年级",
        updatedAt: now,
        blocks: [
          { id: "block-1", type: "paragraph", text: "第一段保持不变。", accessibleText: "第一段改写。", changeReason: "原因1", reviewStatus: "approved", comments: [] },
          { id: "block-2", type: "paragraph", text: "第二段将要被删除。", accessibleText: "第二段改写。", changeReason: "原因2", reviewStatus: "pending", comments: [] },
        ],
        glossary: [],
        versions: [],
      },
    };
    store.setItem("sologsb-1009-accessible-textbook-v1", JSON.stringify(legacy));
    const workspace = loadWorkspace(store, now);
    expect(workspace.source.blocks).toHaveLength(2);

    const status = ingestNewSource(
      store,
      workspace.source,
      workspace.rewrite,
      { text: "# 新标题\n\n第一段保持不变。\n\n全新的第三段内容。", edition: "升级后新版" },
      now,
    );
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.report.reused).toBe(1);
      expect(status.report.added).toBe(2); // 标题 + 第三段
      expect(status.report.removed).toBe(1);
    }
    const reloaded = loadWorkspace(store, now);
    const blocks = buildLiveBlocks(reloaded.source, reloaded.rewrite);
    const reused = blocks.find((item) => item.block.text === "第一段保持不变。");
    expect(reused?.entry.accessibleText).toBe("第一段改写。");
    expect(reused?.entry.reviewStatus).toBe("approved");
    expect(parkedEntries(reloaded.rewrite)[0].accessibleText).toBe("第二段改写。");
  });
});
