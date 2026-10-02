/**
 * 两侧存储与新版原稿接入编排
 *
 * - SOURCE_KEY / REWRITE_KEY 两份数据各自持有，读坏一边只重建一边；
 * - INGEST_JOURNAL_KEY 保存「接入新版原稿」的阶段日志，
 *   源侧已提交而改写侧失败时，可以只重试改写侧；
 * - 旧版（schema 1，原稿与改写混在一起）数据在首次启动时升级到两侧结构。
 */

import {
  blockFingerprint,
  joinSource,
  parseImportedChapter,
  reconcileRewrite,
  uid,
  validateParsedBlocks,
  type BlockType,
  type CommentItem,
  type CommentReply,
  type GlossaryTerm,
  type JoinReport,
  type ParsedBlockInput,
  type ReviewStatus,
  type RewriteDocument,
  type RewriteEntry,
  type SourceBlock,
  type SourceDocument,
  type VersionSnapshot,
} from "./model";

export const SOURCE_KEY = "sologsb-1009-source-v2";
export const REWRITE_KEY = "sologsb-1009-rewrite-v2";
export const INGEST_JOURNAL_KEY = "sologsb-1009-ingest-journal-v2";
/** 旧版（schema 1）数据键，升级时读取。 */
export const LEGACY_KEY = "sologsb-1009-accessible-textbook-v1";

/** 只要求 localStorage 的子集，方便用内存对象做测试。 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SideName = "source" | "rewrite";

export interface SideWriteResult {
  ok: boolean;
  side: SideName;
  error?: string;
}

/** 接入流程阶段日志：已解析的对接结果先落日志，再两侧分别提交。 */
export interface IngestJournal {
  schema: 2;
  kind: "ingest-journal";
  /** pending-source：源侧还没提交；pending-rewrite：源侧已提交，等改写侧重试。 */
  stage: "pending-source" | "pending-rewrite";
  edition: string;
  source: SourceDocument;
  rewrite: RewriteDocument;
  report: JoinReport;
  createdAt: string;
  attempts: Partial<Record<SideName, number>>;
  lastError?: string;
}

export type IngestStatus =
  | { ok: true; report: JoinReport; resumed?: boolean }
  | { ok: false; stage: "parse" | "journal" | "source" | "rewrite"; error: string; resumeAvailable: boolean };

// ---------------------------------------------------------------------------
// 基础读写（单侧失败不牵连另一侧）
// ---------------------------------------------------------------------------

function safeWrite(store: KeyValueStore, key: string, value: unknown, side: SideName): SideWriteResult {
  try {
    store.setItem(key, JSON.stringify(value));
    return { ok: true, side };
  } catch (error) {
    return { ok: false, side, error: error instanceof Error ? error.message : String(error) };
  }
}

function writeSourceSide(store: KeyValueStore, source: SourceDocument): SideWriteResult {
  return safeWrite(store, SOURCE_KEY, source, "source");
}

function writeRewriteSide(store: KeyValueStore, rewrite: RewriteDocument): SideWriteResult {
  return safeWrite(store, REWRITE_KEY, rewrite, "rewrite");
}

function readJson(store: KeyValueStore, key: string): unknown | null {
  const raw = store.getItem(key);
  if (raw == null) return null;
  return JSON.parse(raw) as unknown;
}

function isSourceDocument(value: unknown): value is SourceDocument {
  const doc = value as Partial<SourceDocument> | null;
  return !!doc && doc.schema === 2 && doc.kind === "source" && Array.isArray(doc.blocks);
}

function isRewriteDocument(value: unknown): value is RewriteDocument {
  const doc = value as Partial<RewriteDocument> | null;
  return !!doc && doc.schema === 2 && doc.kind === "rewrite" && Array.isArray(doc.entries) && Array.isArray(doc.glossary);
}

export function isIngestJournal(value: unknown): value is IngestJournal {
  const journal = value as Partial<IngestJournal> | null;
  return !!journal && journal.kind === "ingest-journal" && !!journal.source && !!journal.rewrite && !!journal.report;
}

export function loadSource(store: KeyValueStore): { doc: SourceDocument | null; error?: string } {
  try {
    const value = readJson(store, SOURCE_KEY);
    if (value == null) return { doc: null };
    if (!isSourceDocument(value)) return { doc: null, error: "原稿侧数据无法识别，已按内置示例重建；编辑改写侧未受影响。" };
    return { doc: value };
  } catch (error) {
    return { doc: null, error: `原稿侧读不出来（${error instanceof Error ? error.message : String(error)}），已只重建原稿侧。` };
  }
}

export function loadRewrite(store: KeyValueStore): { doc: RewriteDocument | null; error?: string } {
  try {
    const value = readJson(store, REWRITE_KEY);
    if (value == null) return { doc: null };
    if (!isRewriteDocument(value)) return { doc: null, error: "改写侧数据无法识别，已按空白改写稿重建；出版社原稿侧未受影响。" };
    return { doc: value };
  } catch (error) {
    return { doc: null, error: `改写侧读不出来（${error instanceof Error ? error.message : String(error)}），已只重建改写侧。` };
  }
}

export function saveSource(store: KeyValueStore, source: SourceDocument): SideWriteResult {
  return writeSourceSide(store, source);
}

export function saveRewrite(store: KeyValueStore, rewrite: RewriteDocument): SideWriteResult {
  return writeRewriteSide(store, rewrite);
}

export function loadIngestJournal(store: KeyValueStore): IngestJournal | null {
  try {
    const value = readJson(store, INGEST_JOURNAL_KEY);
    return value && isIngestJournal(value) ? value : null;
  } catch {
    return null;
  }
}

function clearJournal(store: KeyValueStore) {
  try {
    store.removeItem(INGEST_JOURNAL_KEY);
  } catch {
    // 清不掉日志不影响已提交的数据；下次 resume 是幂等的。
  }
}

// ---------------------------------------------------------------------------
// 旧版（schema 1）数据升级
// ---------------------------------------------------------------------------

interface LegacyBlock {
  id: string;
  type: BlockType;
  text: string;
  accessibleText: string;
  headingLevel?: number;
  imageSrc?: string;
  imageAlt?: string;
  linkHref?: string;
  changeReason: string;
  reviewStatus: ReviewStatus;
  comments: CommentItem[];
}

interface LegacyProject {
  id: string;
  title: string;
  subject: string;
  grade: string;
  blocks: LegacyBlock[];
  glossary: GlossaryTerm[];
  versions: Array<{
    id: string;
    label: string;
    createdAt: string;
    blocks: LegacyBlock[];
    glossary: GlossaryTerm[];
  }>;
  updatedAt: string;
}

function legacyBlockToSource(block: LegacyBlock): SourceBlock {
  return {
    id: block.id,
    type: block.type,
    text: block.text,
    headingLevel: block.headingLevel,
    imageSrc: block.imageSrc,
    imageAlt: block.imageAlt,
    linkHref: block.linkHref,
  };
}

function legacyBlockToEntry(block: LegacyBlock, now: string): RewriteEntry {
  return {
    id: uid("entry"),
    sourceId: block.id,
    sourceFingerprint: blockFingerprint(legacyBlockToSource(block)),
    state: "live",
    accessibleText: block.accessibleText,
    changeReason: block.changeReason ?? "",
    conclusion: "",
    reviewStatus: block.reviewStatus ?? "pending",
    stale: false,
    history: [],
    comments: Array.isArray(block.comments) ? block.comments : [],
    updatedAt: now,
  };
}

/** 旧数据升级：一份混装数据拆成两侧各自持有，原改写原因/状态/批注全部保留。 */
export function migrateLegacy(raw: string, now: string): { source: SourceDocument; rewrite: RewriteDocument } | null {
  try {
    const envelope = JSON.parse(raw) as { schema?: number; project?: LegacyProject };
    if (envelope.schema !== 1 || !envelope.project?.blocks?.length) return null;
    const project = envelope.project;
    const source: SourceDocument = {
      schema: 2,
      kind: "source",
      id: uid("source"),
      title: project.title,
      subject: project.subject ?? "",
      grade: project.grade ?? "",
      edition: "升级前存档版本",
      blocks: project.blocks.map(legacyBlockToSource),
      updatedAt: now,
    };
    const versions: VersionSnapshot[] = (project.versions ?? []).map((snapshot) => ({
      id: snapshot.id,
      label: snapshot.label,
      createdAt: snapshot.createdAt,
      sourceEdition: "升级前存档版本",
      glossary: snapshot.glossary ?? [],
      entries: snapshot.blocks.map((block) => ({
        sourceId: block.id,
        sourceText: block.text,
        accessibleText: block.accessibleText,
        changeReason: block.changeReason ?? "",
        conclusion: "",
        reviewStatus: block.reviewStatus ?? "pending",
      })),
    }));
    const rewrite: RewriteDocument = {
      schema: 2,
      kind: "rewrite",
      id: uid("rewrite"),
      title: project.title,
      entries: project.blocks.map((block) => legacyBlockToEntry(block, now)),
      glossary: project.glossary ?? [],
      versions,
      updatedAt: now,
    };
    return { source, rewrite };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内置示例（首次启动 / 单侧数据坏掉时，只重建坏掉的那一侧）
// ---------------------------------------------------------------------------

export function createSeedSource(now: string): SourceDocument {
  const blocks: SourceBlock[] = [
    { id: "block-h1", type: "heading", headingLevel: 1, text: "第三章 水循环与城市" },
    {
      id: "block-p1",
      type: "paragraph",
      text: "城市中的水并非取之不尽，由于其会通过蒸发、降水以及地表径流等若干复杂过程在自然界中持续循环，因此理解这些过程对于建设具有韧性的城市具有十分重要的意义。",
    },
    { id: "block-h2", type: "heading", headingLevel: 2, text: "一、水从哪里来" },
    {
      id: "block-img",
      type: "image",
      text: "图 3-1 城市水循环示意",
      imageSrc:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='420'%3E%3Crect width='800' height='420' fill='%23dcecf3'/%3E%3Ccircle cx='650' cy='85' r='45' fill='%23f4c95d'/%3E%3Cpath d='M0 300 Q180 240 340 300 T800 280 V420 H0Z' fill='%2389b7d0'/%3E%3Cpath d='M130 285 Q220 170 330 285' fill='none' stroke='%233a7c9e' stroke-width='12'/%3E%3C/svg%3E",
      imageAlt: "",
    },
    {
      id: "block-p2",
      type: "paragraph",
      text: "当太阳照射到水面时，水会受热变成水蒸气升到空中。水蒸气冷却后形成云，再以雨或雪的形式落回地面。",
    },
    { id: "block-link", type: "link", text: "点击这里", linkHref: "/resources/water-cycle" },
    { id: "block-h3", type: "heading", headingLevel: 3, text: "雨水花园怎样工作" },
    {
      id: "block-p3",
      type: "paragraph",
      text: "雨水花园利用土壤和植物的共同作用暂时储存雨水，同时通过下渗补给地下水，并在降雨较集中时减轻城市排水管道所承受的压力。",
    },
  ];
  return {
    schema: 2,
    kind: "source",
    id: "source-seed-1009",
    title: "科学（五年级下册）",
    subject: "科学",
    grade: "五年级",
    edition: "出版社初版",
    blocks,
    updatedAt: now,
  };
}

interface SeedRewriteSpec {
  accessibleText: string;
  changeReason: string;
  conclusion?: string;
  reviewStatus: RewriteEntry["reviewStatus"];
}

export function createSeedRewrite(source: SourceDocument, now: string): RewriteDocument {
  const specs: Record<string, SeedRewriteSpec> = {
    "block-h1": { accessibleText: "第三章 水循环与城市", changeReason: "", reviewStatus: "approved" },
    "block-p1": {
      accessibleText: "城市里的水会不断循环。它经过蒸发、降水并沿地面流动。了解这些过程，可以帮助我们建设更能适应变化的城市。",
      changeReason: "拆分长句，把抽象表述改为更直接的说明。",
      conclusion: "已拆成三个短句，先讲现象再讲意义。",
      reviewStatus: "pending",
    },
    "block-h2": { accessibleText: "一、水从哪里来", changeReason: "保留原章节结构。", reviewStatus: "approved" },
    "block-img": { accessibleText: "", changeReason: "", reviewStatus: "needs-work" },
    "block-p2": {
      accessibleText: "太阳照在水面上，水会变成水蒸气升到空中。水蒸气冷却后变成云，最后以雨或雪落回地面。",
      changeReason: "使用较短句子，并明确每个步骤的先后顺序。",
      conclusion: "蒸发、成云、降水三步顺序清楚。",
      reviewStatus: "approved",
    },
    "block-link": {
      accessibleText: "打开水循环互动实验",
      changeReason: "改为说明链接目标的独立文案。",
      reviewStatus: "pending",
    },
    "block-h3": { accessibleText: "雨水花园怎样工作", changeReason: "", reviewStatus: "approved" },
    "block-p3": {
      accessibleText: "雨水花园用土壤和植物暂时存住雨水。雨水还会慢慢渗入地下，补充地下水。雨很大时，它可以减轻排水管的压力。",
      changeReason: "把并列成分拆成短句，减少专业术语密度。",
      reviewStatus: "pending",
    },
  };
  const entries: RewriteEntry[] = source.blocks.map((block) => {
    const spec = specs[block.id] ?? {
      accessibleText: block.type === "image" ? block.imageAlt ?? "" : block.text,
      changeReason: "",
      reviewStatus: "pending" as const,
    };
    return {
      id: uid("entry"),
      sourceId: block.id,
      sourceFingerprint: blockFingerprint(block),
      state: "live",
      accessibleText: spec.accessibleText,
      changeReason: spec.changeReason,
      conclusion: spec.conclusion ?? "",
      reviewStatus: spec.reviewStatus,
      stale: false,
      history: [],
      comments: [],
      updatedAt: now,
    };
  });
  return {
    schema: 2,
    kind: "rewrite",
    id: "rewrite-seed-1009",
    title: "科学（五年级下册）·无障碍改写稿",
    entries,
    glossary: [
      { id: "term-1", source: "水循环", preferred: "水循环", note: "全书统一使用" },
      { id: "term-2", source: "地表径流", preferred: "沿地面流动的水", note: "首次出现时使用通俗解释" },
      { id: "term-3", source: "下渗", preferred: "渗入地下", note: "避免单独使用专业词" },
    ],
    versions: [],
    updatedAt: now,
  };
}

export interface WorkspaceLoadResult {
  source: SourceDocument;
  rewrite: RewriteDocument;
  notices: string[];
  journal: IngestJournal | null;
}

/**
 * 启动加载：两侧独立读取，坏哪边重建哪边；
 * 都没有时先看旧版数据能否升级，否则放入内置示例。
 */
export function loadWorkspace(store: KeyValueStore, now: string): WorkspaceLoadResult {
  const notices: string[] = [];
  const loadedSource = loadSource(store);
  const loadedRewrite = loadRewrite(store);

  let source: SourceDocument | null = loadedSource.doc;
  let rewrite: RewriteDocument | null = loadedRewrite.doc;

  if (!source && !rewrite) {
    const legacyRaw = store.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const migrated = migrateLegacy(legacyRaw, now);
      if (migrated) {
        source = migrated.source;
        rewrite = migrated.rewrite;
        // 升级结果立即各自落位，写失败不影响本次会话使用。
        writeSourceSide(store, source);
        writeRewriteSide(store, rewrite);
        notices.push("已把旧版数据升级为两侧分离结构，原改写原因、审核状态和批注都已保留。");
      }
    }
  }

  if (!source) {
    notices.push(loadedSource.error ?? "未找到原稿侧数据，已载入出版社示例原稿。");
    source = createSeedSource(now);
  }
  if (!rewrite) {
    notices.push(loadedRewrite.error ?? "未找到改写侧数据，已按当前原稿建立空白改写稿。");
    rewrite = createSeedRewrite(source, now);
  }

  // 两侧可能各自来自不同时间（一侧曾读坏重建），启动时对账补齐。
  const reconciled = reconcileRewrite(source, rewrite, now);
  if (reconciled !== rewrite) {
    rewrite = reconciled;
    writeRewriteSide(store, rewrite);
  }

  return {
    source,
    rewrite,
    notices,
    journal: loadIngestJournal(store),
  };
}

// ---------------------------------------------------------------------------
// 接入新版原稿：解析 → 对接 → 日志 → 源侧提交 → 改写侧提交
// ---------------------------------------------------------------------------

export interface IngestInput {
  text: string;
  edition: string;
}

/**
 * 接入新版原稿。
 * 文件读不出来 / 解析为空：返回 parse 失败，已有两侧数据一概不动。
 * 源侧写入失败：日志停在 pending-source，重试时两侧重放。
 * 改写侧写入失败：源侧已经是新版，日志停在 pending-rewrite，只重试改写侧。
 */
export function ingestNewSource(
  store: KeyValueStore,
  currentSource: SourceDocument,
  currentRewrite: RewriteDocument,
  input: IngestInput,
  now: string,
): IngestStatus {
  let parsed: ParsedBlockInput[];
  try {
    parsed = parseImportedChapter(input.text);
  } catch (error) {
    return {
      ok: false,
      stage: "parse",
      error: `新版原稿解析失败：${error instanceof Error ? error.message : String(error)}`,
      resumeAvailable: false,
    };
  }
  const invalid = validateParsedBlocks(parsed);
  if (invalid) {
    return { ok: false, stage: "parse", error: invalid, resumeAvailable: false };
  }

  let joined;
  try {
    joined = joinSource(currentSource, currentRewrite, parsed, input.edition.trim() || "未命名新版本", now);
  } catch (error) {
    return {
      ok: false,
      stage: "parse",
      error: `逐块对接失败：${error instanceof Error ? error.message : String(error)}`,
      resumeAvailable: false,
    };
  }

  const journal: IngestJournal = {
    schema: 2,
    kind: "ingest-journal",
    stage: "pending-source",
    edition: joined.report.edition,
    source: joined.source,
    rewrite: joined.rewrite,
    report: joined.report,
    createdAt: now,
    attempts: {},
  };
  const journalWrite = safeWrite(store, INGEST_JOURNAL_KEY, journal, "rewrite");
  if (!journalWrite.ok) {
    return {
      ok: false,
      stage: "journal",
      error: `无法写入接入日志：${journalWrite.error}。两侧现有数据均未改动。`,
      resumeAvailable: false,
    };
  }

  return commitIngest(store);
}

/**
 * 按侧重试：从日志继续。pending-source 从源侧开始；pending-rewrite 只补改写侧。
 * 对已提交的一侧重放是幂等的（内容相同）。
 */
export function commitIngest(store: KeyValueStore): IngestStatus {
  const journal = loadIngestJournal(store);
  if (!journal) {
    return { ok: false, stage: "journal", error: "没有找到未完成的接入日志。", resumeAvailable: false };
  }
  journal.attempts = journal.attempts ?? {};

  if (journal.stage === "pending-source") {
    const sourceAttempts = (journal.attempts.source ?? 0) + 1;
    const sourceWrite = writeSourceSide(store, journal.source);
    if (!sourceWrite.ok) {
      const updated: IngestJournal = {
        ...journal,
        attempts: { ...journal.attempts, source: sourceAttempts },
        lastError: sourceWrite.error,
      };
      safeWrite(store, INGEST_JOURNAL_KEY, updated, "rewrite");
      return {
        ok: false,
        stage: "source",
        error: `原稿侧第 ${sourceAttempts} 次提交失败：${sourceWrite.error}。编辑改写稿原样保留，可按侧重试。`,
        resumeAvailable: true,
      };
    }
    journal.stage = "pending-rewrite";
    journal.attempts = { ...journal.attempts, source: sourceAttempts };
    safeWrite(store, INGEST_JOURNAL_KEY, journal, "rewrite");
  }

  const rewriteAttempts = (journal.attempts.rewrite ?? 0) + 1;
  const rewriteWrite = writeRewriteSide(store, journal.rewrite);
  if (!rewriteWrite.ok) {
    const updated: IngestJournal = {
      ...journal,
      stage: "pending-rewrite",
      attempts: { ...journal.attempts, rewrite: rewriteAttempts },
      lastError: rewriteWrite.error,
    };
    safeWrite(store, INGEST_JOURNAL_KEY, updated, "rewrite");
    return {
      ok: false,
      stage: "rewrite",
      error: `改写侧第 ${rewriteAttempts} 次提交失败：${rewriteWrite.error}。原稿侧已是新版，请只重试改写侧。`,
      resumeAvailable: true,
    };
  }

  clearJournal(store);
  return { ok: true, report: journal.report };
}

// ---------------------------------------------------------------------------
// 供界面复用的小工具
// ---------------------------------------------------------------------------

export function newComment(body: string, author = "当前编辑", now: string): CommentItem {
  return { id: uid("comment"), author, body, createdAt: now, resolved: false, replies: [] };
}

export function newReply(body: string, author = "当前编辑", now: string): CommentReply {
  return { id: uid("reply"), author, body, createdAt: now };
}

/** 供「尝试新版示例」使用的演示文本：挪动段落、改正文、删块、加块各一种。 */
export const SAMPLE_NEW_EDITION = `# 第三章 水循环与城市

## 一、水从哪里来

当太阳照射到水面时，水会受热变成水蒸气升到空中。水蒸气冷却后形成云，再以雨或雪的形式落回地面。

城市中的水并非取之不尽，水会通过蒸发、降水与地表径流在自然界中循环。理解这些过程，对建设韧性城市非常重要。

![图 3-1 城市水循环示意](data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='420'%3E%3Crect width='800' height='420' fill='%23dcecf3'/%3E%3Ccircle cx='650' cy='85' r='45' fill='%23f4c95d'/%3E%3Cpath d='M0 300 Q180 240 340 300 T800 280 V420 H0Z' fill='%2389b7d0'/%3E%3Cpath d='M130 285 Q220 170 330 285' fill='none' stroke='%233a7c9e' stroke-width='12'/%3E%3C/svg%3E) 图 3-1 城市水循环示意

### 雨水花园怎样工作

雨水花园利用土壤和植物暂时存住雨水，通过下渗补给地下水，并减轻排水管道的压力。

## 二、节水小贴士

在日常生活中，我们可以通过缩短淋浴时间、及时修理漏水的龙头来节约水资源。`;
