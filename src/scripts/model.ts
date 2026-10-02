/**
 * 教材无障碍改写工作台 · 数据模型与核心逻辑
 *
 * 两侧分离设计：
 * - 原稿侧（SourceDocument）：只装出版社发布的版本，编辑不能直接改文字，
 *   新版原稿只能通过「接入新版原稿」整块替换。
 * - 改写侧（RewriteDocument）：只装编辑写的内容——改写文本、改写原因、
 *   改写结论、审核状态、批注、术语表、版本快照。
 *
 * 新版原稿接入（join）按内容逐块对接：
 * - 接得上（文字未动）：沿用原改写，含「已通过」状态；
 * - 原稿文字动过：退回待改写并标 stale，旧改写留在 history 里对照，已通过作废；
 * - 原稿去掉的块：改写挪到 parked 一边（parked）留档，不参与正文；
 * - 新加的块：按待改写（pending）进来。
 *
 * 存储与失败恢复：
 * - 两侧各自持有一个 key，任一一侧读不出来只重建该侧，另一侧原样保留；
 * - 接入流程先读原稿，读不出来只重新处理原稿侧，编辑写的内容完全不碰；
 * - 接入结果带阶段日志（journal），源侧/改写侧分别提交，失败后可「按侧重试」。
 */

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

export type BlockType = "heading" | "paragraph" | "image" | "link";
export type ReviewStatus = "pending" | "approved" | "needs-work";
export type RewriteState = "live" | "parked";
export type Severity = "error" | "warning" | "info";

export interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface CommentItem {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
}

/** 原稿侧的一个内容块：只有出版社给的东西，不允许混入编辑稿。 */
export interface SourceBlock {
  id: string;
  type: BlockType;
  text: string;
  headingLevel?: number;
  imageSrc?: string;
  imageAlt?: string;
  linkHref?: string;
}

/** 旧改写留档：原稿文字动过的块退回待改写时，上一版改写存在这里对照。 */
export interface RewriteHistoryEntry {
  sourceFingerprint: string;
  sourceSnapshot: SourceBlock;
  accessibleText: string;
  changeReason: string;
  conclusion: string;
  reviewStatus: ReviewStatus;
  updatedAt: string;
}

/**
 * 改写侧的一个条目，用 sourceId 与原稿块绑定。
 * state=live 挂在当前原稿块上；state=parked 是原稿去掉后挪到一边的留档。
 */
export interface RewriteEntry {
  id: string;
  sourceId: string;
  /** 该条目最后依据的原稿指纹；与当前原稿不一致即「原稿文字动过」。 */
  sourceFingerprint: string;
  /** live：挂当前原稿；parked：原稿已去掉，整条挪到一边。 */
  state: RewriteState;
  /** 块从当前原稿移除时，保存一份原稿快照，留档才看得见当时的原文。 */
  parkedSource?: SourceBlock;
  accessibleText: string;
  changeReason: string;
  conclusion: string;
  reviewStatus: ReviewStatus;
  /** 原稿文字动过：true 表示沿用了旧改写但需要重新核对，已通过作废。 */
  stale: boolean;
  history: RewriteHistoryEntry[];
  comments: CommentItem[];
  updatedAt: string;
}

export interface SourceDocument {
  schema: 2;
  kind: "source";
  id: string;
  title: string;
  subject: string;
  grade: string;
  /** 出版社版本标识，例如「2026 修订版」。 */
  edition: string;
  blocks: SourceBlock[];
  updatedAt: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  preferred: string;
  note: string;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  /** 保存时对应的出版社版本。 */
  sourceEdition: string;
  /** 以 sourceId 为键保存改写内容，原稿段落挪动也能对上。 */
  entries: Array<{
    sourceId: string;
    sourceText: string;
    accessibleText: string;
    changeReason: string;
    conclusion: string;
    reviewStatus: ReviewStatus;
  }>;
  glossary: GlossaryTerm[];
}

export interface RewriteDocument {
  schema: 2;
  kind: "rewrite";
  id: string;
  /** 改写稿标题等元信息归编辑侧管理。 */
  title: string;
  entries: RewriteEntry[];
  glossary: GlossaryTerm[];
  versions: VersionSnapshot[];
  /** 上一次「接入新版原稿」的结果汇报。 */
  lastJoinReport?: JoinReport;
  updatedAt: string;
}

export interface AccessibilityIssue {
  id: string;
  blockId: string;
  type: "heading" | "link" | "image" | "glossary" | "sentence";
  severity: Severity;
  title: string;
  detail: string;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 原稿文字指纹：标题层级、图地址、链接地址都纳入。
 * 图片 alt 不纳入——源稿通常不给 alt，空白差异不能算出版社改了原稿。
 */
export function blockFingerprint(block: SourceBlock): string {
  const text = normalizeWhitespace(block.text);
  if (block.type === "heading") return `heading:${block.headingLevel ?? 2}:${text}`;
  if (block.type === "image") return `image:${block.imageSrc ?? ""}:${text}`;
  if (block.type === "link") return `link:${block.linkHref ?? ""}:${text}`;
  return `paragraph:${text}`;
}

function blockTextForCompare(block: SourceBlock): string {
  if (block.type === "image") return normalizeWhitespace(`${block.text} ${block.imageAlt ?? ""}`);
  return normalizeWhitespace(block.text);
}

/** 二元组相似度（Dice），对中文按字二元组、西文按词二元组。 */
export function similarity(a: string, b: string): number {
  const left = normalizeWhitespace(a).toLowerCase();
  const right = normalizeWhitespace(b).toLowerCase();
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value: string): Set<string> => {
    const result = new Set<string>();
    const tokens = /[A-Za-z]/.test(value) ? value.split(/\s+/).filter(Boolean) : [value.replace(/\s+/g, "")];
    for (const token of tokens) {
      if (token.length < 2) {
        result.add(token);
        continue;
      }
      for (let i = 0; i < token.length - 1; i += 1) result.add(token.slice(i, i + 2));
    }
    return result;
  };
  const ga = grams(left);
  const gb = grams(right);
  if (!ga.size || !gb.size) return 0;
  let overlap = 0;
  for (const gram of ga) if (gb.has(gram)) overlap += 1;
  return (2 * overlap) / (ga.size + gb.size);
}

/** 第二轮模糊对接的配对门槛：图片/链接还要求资源地址一致，避免张冠李戴。 */
function pairScore(oldBlock: SourceBlock, newBlock: SourceBlock): number {
  if (oldBlock.type !== newBlock.type) return 0;
  const textScore = similarity(blockTextForCompare(oldBlock), blockTextForCompare(newBlock));
  if (newBlock.type === "image") {
    if ((oldBlock.imageSrc ?? "") !== (newBlock.imageSrc ?? "")) return 0;
    return textScore >= 0.45 ? textScore : 0;
  }
  if (newBlock.type === "link") {
    if ((oldBlock.linkHref ?? "") !== (newBlock.linkHref ?? "")) return 0;
    return textScore >= 0.3 ? textScore : 0;
  }
  return textScore >= 0.5 ? textScore : 0;
}

// ---------------------------------------------------------------------------
// 新版原稿逐块对接
// ---------------------------------------------------------------------------

export type JoinOutcome = "reused" | "changed" | "added" | "removed";

export interface JoinItem {
  outcome: JoinOutcome;
  sourceBlockId: string;
  sourceText: string;
  blockType: BlockType;
  /** changed/removed 时携带旧原文、旧改写，便于界面对照。 */
  previousSourceText?: string;
  previousAccessibleText?: string;
}

export interface JoinReport {
  /** 出版社版本。 */
  edition: string;
  importedAt: string;
  reused: number;
  changed: number;
  added: number;
  removed: number;
  items: JoinItem[];
}

export interface JoinResult {
  source: SourceDocument;
  rewrite: RewriteDocument;
  report: JoinReport;
}

export interface ParsedBlockInput {
  type: BlockType;
  text: string;
  headingLevel?: number;
  imageSrc?: string;
  imageAlt?: string;
  linkHref?: string;
}

function blankEntry(source: SourceBlock): RewriteEntry {
  const now = new Date().toISOString();
  return {
    id: uid("entry"),
    sourceId: source.id,
    sourceFingerprint: blockFingerprint(source),
    state: "live",
    accessibleText: source.type === "image" ? source.imageAlt ?? "" : source.text,
    changeReason: "",
    conclusion: "",
    reviewStatus: "pending",
    stale: false,
    history: [],
    comments: [],
    updatedAt: now,
  };
}

/**
 * 把新版原稿接到现有两份文档上。纯函数：不碰存储、不抛错（输入已解析时），
 * 失败恢复交给 ingest 层的两侧分别提交。
 */
export function joinSource(
  currentSource: SourceDocument,
  currentRewrite: RewriteDocument,
  parsedBlocks: ParsedBlockInput[],
  edition: string,
  now: string,
): JoinResult {
  const newBlocks: SourceBlock[] = parsedBlocks.map((block) => ({ id: uid("block"), ...block }));
  const oldBlocks = currentSource.blocks;
  const oldEntriesById = new Map(currentRewrite.entries.map((entry) => [entry.sourceId, entry]));

  // 第一轮：类型 + 指纹完全一致 → 接得上，沿用原改写，段落挪动也不受位置影响。
  const oldByFingerprint = new Map<string, SourceBlock[]>();
  for (const block of oldBlocks) {
    const key = blockFingerprint(block);
    oldByFingerprint.set(key, [...(oldByFingerprint.get(key) ?? []), block]);
  }

  const matchedOldIds = new Set<string>();
  const matchedNewIds = new Set<string>();
  const exactPairs: Array<{ oldBlock: SourceBlock; newBlock: SourceBlock }> = [];
  for (const newBlock of newBlocks) {
    const candidates = oldByFingerprint.get(blockFingerprint(newBlock)) ?? [];
    const oldBlock = candidates.find((candidate) => !matchedOldIds.has(candidate.id));
    if (oldBlock) {
      matchedOldIds.add(oldBlock.id);
      matchedNewIds.add(newBlock.id);
      exactPairs.push({ oldBlock, newBlock });
    }
  }

  // 第二轮：文字动过但大体还是同一块（改写、调标题层级、改图注等）。
  const fuzzyPairs: Array<{ oldBlock: SourceBlock; newBlock: SourceBlock }> = [];
  if (matchedOldIds.size < oldBlocks.length && matchedNewIds.size < newBlocks.length) {
    const remainingOld = oldBlocks.filter((block) => !matchedOldIds.has(block.id));
    const remainingNew = newBlocks.filter((block) => !matchedNewIds.has(block.id));
    const scored: Array<{ score: number; oldId: string; newId: string }> = [];
    for (const oldBlock of remainingOld) {
      for (const newBlock of remainingNew) {
        const score = pairScore(oldBlock, newBlock);
        if (score > 0) scored.push({ score, oldId: oldBlock.id, newId: newBlock.id });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    for (const pair of scored) {
      if (matchedOldIds.has(pair.oldId) || matchedNewIds.has(pair.newId)) continue;
      matchedOldIds.add(pair.oldId);
      matchedNewIds.add(pair.newId);
      const oldBlock = remainingOld.find((block) => block.id === pair.oldId);
      const newBlock = remainingNew.find((block) => block.id === pair.newId);
      if (oldBlock && newBlock) fuzzyPairs.push({ oldBlock, newBlock });
    }
  }

  // 第三轮：图片按图址、链接按地址——同一资源即同一块。
  // 链接文案的易读化本就由改写侧承载，不算「出版社改了原稿」；
  // 源稿不给图片 alt 是常态，空 alt 差异也不应当作原稿改动。
  const resourcePairs: Array<{ oldBlock: SourceBlock; newBlock: SourceBlock }> = [];
  for (const newBlock of newBlocks) {
    if (matchedNewIds.has(newBlock.id)) continue;
    if (newBlock.type !== "image" && newBlock.type !== "link") continue;
    const sameResource = oldBlocks.find((oldBlock) => {
      if (matchedOldIds.has(oldBlock.id) || oldBlock.type !== newBlock.type) return false;
      if (newBlock.type === "image") return (oldBlock.imageSrc ?? "") === (newBlock.imageSrc ?? "");
      return (oldBlock.linkHref ?? "") === (newBlock.linkHref ?? "");
    });
    if (sameResource) {
      matchedOldIds.add(sameResource.id);
      matchedNewIds.add(newBlock.id);
      resourcePairs.push({ oldBlock: sameResource, newBlock });
    }
  }

  const newEntries: RewriteEntry[] = [];
  const items: JoinItem[] = [];

  // 沿用：条目改挂到新块 id，其余（原因/结论/批注/已通过）原样保留。
  const reusePairs = [...exactPairs, ...resourcePairs];
  for (const { oldBlock, newBlock } of reusePairs) {
    const entry = oldEntriesById.get(oldBlock.id);
    if (entry) {
      newEntries.push({
        ...structuredClone(entry),
        sourceId: newBlock.id,
        sourceFingerprint: blockFingerprint(newBlock),
        state: "live",
        parkedSource: undefined,
        stale: false,
        updatedAt: now,
      });
      items.push({
        outcome: "reused",
        sourceBlockId: newBlock.id,
        sourceText: newBlock.text,
        blockType: newBlock.type,
      });
    }
  }

  // 文字动过：退回待改写 + stale，旧改写入 history 留档，已通过作废。
  for (const { oldBlock, newBlock } of fuzzyPairs) {
    const oldEntry = oldEntriesById.get(oldBlock.id);
    const base = oldEntry ? structuredClone(oldEntry) : blankEntry(oldBlock);
    const historyEntry: RewriteHistoryEntry = {
      sourceFingerprint: blockFingerprint(oldBlock),
      sourceSnapshot: structuredClone(oldBlock),
      accessibleText: base.accessibleText,
      changeReason: base.changeReason,
      conclusion: base.conclusion,
      reviewStatus: base.reviewStatus,
      updatedAt: base.updatedAt,
    };
    newEntries.push({
      ...base,
      id: oldEntry ? base.id : uid("entry"),
      sourceId: newBlock.id,
      sourceFingerprint: blockFingerprint(newBlock),
      state: "live",
      parkedSource: undefined,
      reviewStatus: "pending",
      stale: true,
      history: [...base.history, historyEntry].slice(-10),
      updatedAt: now,
    });
    items.push({
      outcome: "changed",
      sourceBlockId: newBlock.id,
      sourceText: newBlock.text,
      blockType: newBlock.type,
      previousSourceText: oldBlock.text,
      previousAccessibleText: historyEntry.accessibleText,
    });
  }

  // 新加的块：按待改写进来。
  for (const newBlock of newBlocks) {
    if (matchedNewIds.has(newBlock.id)) continue;
    newEntries.push(blankEntry(newBlock));
    items.push({
      outcome: "added",
      sourceBlockId: newBlock.id,
      sourceText: newBlock.text,
      blockType: newBlock.type,
    });
  }

  // 原稿去掉的块：带着当时原稿快照挪到 parked 一边，原改写完整留档。
  for (const oldBlock of oldBlocks) {
    if (matchedOldIds.has(oldBlock.id)) continue;
    const oldEntry = oldEntriesById.get(oldBlock.id);
    if (oldEntry) {
      newEntries.push({
        ...structuredClone(oldEntry),
        state: "parked",
        parkedSource: structuredClone(oldBlock),
        stale: false,
        updatedAt: now,
      });
      items.push({
        outcome: "removed",
        sourceBlockId: oldBlock.id,
        sourceText: oldBlock.text,
        blockType: oldBlock.type,
        previousSourceText: oldBlock.text,
        previousAccessibleText: oldEntry.accessibleText,
      });
    }
  }

  // 既在旧原稿找不到、却一直留在改写侧的孤儿条目（源侧曾丢失）也一并挪边。
  for (const entry of currentRewrite.entries) {
    if (!oldBlocks.some((block) => block.id === entry.sourceId) && entry.state === "live") {
      newEntries.push({ ...structuredClone(entry), state: "parked", stale: false, updatedAt: now });
    }
  }

  const report: JoinReport = {
    edition,
    importedAt: now,
    reused: items.filter((item) => item.outcome === "reused").length,
    changed: items.filter((item) => item.outcome === "changed").length,
    added: items.filter((item) => item.outcome === "added").length,
    removed: items.filter((item) => item.outcome === "removed").length,
    items,
  };

  const source: SourceDocument = {
    ...currentSource,
    blocks: newBlocks,
    edition,
    updatedAt: now,
  };
  const rewrite: RewriteDocument = {
    ...currentRewrite,
    entries: newEntries,
    lastJoinReport: report,
    updatedAt: now,
  };

  return { source, rewrite, report };
}

// ---------------------------------------------------------------------------
// 原稿解析（TXT / Markdown）
// ---------------------------------------------------------------------------

export function parseImportedChapter(input: string): ParsedBlockInput[] {
  const blocks: ParsedBlockInput[] = [];
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", text: heading[2], headingLevel: heading[1].length });
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)(?:\s+(.+))?$/.exec(line);
    if (image) {
      blocks.push({ type: "image", text: image[3] || "未命名图片", imageSrc: image[2], imageAlt: image[1] });
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(line);
    if (link) {
      blocks.push({ type: "link", text: link[1], linkHref: link[2] });
      continue;
    }
    blocks.push({ type: "paragraph", text: line });
  }
  return blocks;
}

/** 读不出来的判定：空文件或没有任何可识别内容块。 */
export function validateParsedBlocks(blocks: ParsedBlockInput[]): string | null {
  if (!blocks.length) return "没有读到任何标题、段落、图片或链接，文件可能是空的或格式不受支持。";
  const hasContent = blocks.some((block) => normalizeWhitespace(block.text).length > 0);
  if (!hasContent) return "读到的内容全是空白，无法作为新版原稿接入。";
  return null;
}

// ---------------------------------------------------------------------------
// 编辑视图：原稿块 + 改写条目拼成工作块
// ---------------------------------------------------------------------------

export interface JoinedBlock {
  block: SourceBlock;
  entry: RewriteEntry;
  fingerprint: string;
}

export function buildLiveBlocks(source: SourceDocument, rewrite: RewriteDocument): JoinedBlock[] {
  const entriesById = new Map(rewrite.entries.map((entry) => [entry.sourceId, entry]));
  return source.blocks.map((block) => {
    const entry = entriesById.get(block.id) ?? blankEntry(block);
    return { block, entry, fingerprint: blockFingerprint(block) };
  });
}

export function liveEntries(rewrite: RewriteDocument): RewriteEntry[] {
  return rewrite.entries.filter((entry) => entry.state === "live");
}

export function parkedEntries(rewrite: RewriteDocument): RewriteEntry[] {
  return rewrite.entries.filter((entry) => entry.state === "parked");
}

/**
 * 启动期对账：原稿有块但改写侧没有条目（例如原稿侧曾损坏重建），
 * 补建待改写条目；改写侧还挂着已不存在原稿的 live 条目，挪到 parked。
 */
export function reconcileRewrite(source: SourceDocument, rewrite: RewriteDocument, now: string): RewriteDocument {
  let changed = false;
  const entries = [...rewrite.entries];
  const liveSourceIds = new Set(source.blocks.map((block) => block.id));

  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].state === "live" && !liveSourceIds.has(entries[i].sourceId)) {
      entries[i] = { ...entries[i], state: "parked", stale: false, updatedAt: now };
      changed = true;
    }
  }

  const existingLiveIds = new Set(entries.filter((entry) => entry.state === "live").map((entry) => entry.sourceId));
  for (const block of source.blocks) {
    if (!existingLiveIds.has(block.id)) {
      entries.push(blankEntry(block));
      changed = true;
    }
  }

  return changed ? { ...rewrite, entries, updatedAt: now } : rewrite;
}

// ---------------------------------------------------------------------------
// 无障碍检查
// ---------------------------------------------------------------------------

function sentenceLength(text: string): number {
  const normalized = text.replace(/\s+/g, "");
  return /[A-Za-z]/.test(text) ? text.trim().split(/\s+/).length : normalized.length;
}

export function analyze(blocks: JoinedBlock[], glossary: GlossaryTerm[]): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  let lastHeading = 0;
  for (const item of blocks) {
    const block = item.block;
    if (block.type === "heading") {
      const level = block.headingLevel ?? 2;
      if (lastHeading && level > lastHeading + 1) {
        issues.push({
          id: `heading-${block.id}`,
          blockId: block.id,
          type: "heading",
          severity: "error",
          title: "标题层级跳跃",
          detail: `从 H${lastHeading} 直接到 H${level}，读屏用户会失去清晰的章节结构。`,
          suggestion: `改为 H${lastHeading + 1}，或补上中间的上级标题。`,
        });
      }
      lastHeading = level;
    }
    if (block.type === "image" && !(block.imageAlt ?? item.entry.accessibleText).trim()) {
      issues.push({
        id: `image-${block.id}`,
        blockId: block.id,
        type: "image",
        severity: "error",
        title: "图片缺少替代文本",
        detail: "视觉用户能看到的图表信息，读屏用户目前无法获得。",
        suggestion: "说明图中主体、变化和结论；纯装饰图片应标记为空替代文本。",
      });
    }
    if (block.type === "link") {
      const label = item.entry.accessibleText || block.text;
      if (/^(点击这里|这里|链接|更多|here|click here|read more)$/i.test(label.trim())) {
        issues.push({
          id: `link-${block.id}`,
          blockId: block.id,
          type: "link",
          severity: "error",
          title: "链接文案缺少目的",
          detail: `“${label}”单独朗读时无法说明会前往哪里。`,
          suggestion: "改成“打开水循环互动实验”等可独立理解的文案。",
        });
      }
    }
    const sentences = block.text.split(/(?<=[。！？!?])\s*/).filter(Boolean);
    for (const [index, sentence] of sentences.entries()) {
      if (sentenceLength(sentence) > (/[A-Za-z]/.test(sentence) ? 28 : 42)) {
        issues.push({
          id: `sentence-${block.id}-${index}`,
          blockId: block.id,
          type: "sentence",
          severity: "warning",
          title: "句子过长",
          detail: `该句约 ${sentenceLength(sentence)} ${/[A-Za-z]/.test(sentence) ? "个词" : "个字"}，一次理解的信息较多。`,
          suggestion: "按动作或因果关系拆成 2—3 个短句。",
        });
      }
    }
    const haystack = `${block.text} ${item.entry.accessibleText}`;
    for (const term of glossary) {
      if (haystack.includes(term.source) && item.entry.accessibleText && !item.entry.accessibleText.includes(term.preferred)) {
        issues.push({
          id: `term-${block.id}-${term.id}`,
          blockId: block.id,
          type: "glossary",
          severity: "info",
          title: `术语“${term.source}”尚未统一`,
          detail: `全书建议表述为“${term.preferred}”。${term.note}`,
          suggestion: `将无障碍文本调整为“${term.preferred}”。`,
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 自动改写、术语统一、HTML 导出
// ---------------------------------------------------------------------------

export function simplifyText(input: string, glossary: GlossaryTerm[]): string {
  let result = input
    .replaceAll("由于其", "因为")
    .replaceAll("因此", "所以")
    .replaceAll("具有十分重要的意义", "很重要")
    .replaceAll("利用", "使用")
    .replaceAll("共同作用", "一起作用")
    .replaceAll("暂时储存", "暂时存住")
    .replaceAll("所承受的压力", "受到的压力")
    .replace(/([^。！？]{38,}?)[，、]([^。！？]{12,}?[。！？])/g, "$1。$2");
  for (const term of glossary) {
    if (result.includes(term.source)) result = result.replaceAll(term.source, term.preferred);
  }
  return result
    .split(/(?<=[。！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join("\n");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** 导出只取 live 块；parked 是已从新原稿去掉的留档，不进成品。 */
export function exportHtml(title: string, blocks: JoinedBlock[]): string {
  const body = blocks.map((item) => {
    const block = item.block;
    const text = item.entry.accessibleText || block.text;
    if (block.type === "heading") {
      const level = Math.min(6, Math.max(1, block.headingLevel ?? 2));
      return `<h${level}>${escapeHtml(text)}</h${level}>`;
    }
    if (block.type === "image") {
      return `<figure><img src="${escapeHtml(block.imageSrc ?? "")}" alt="${escapeHtml(item.entry.accessibleText || block.imageAlt || "")}"><figcaption>${escapeHtml(block.text)}</figcaption></figure>`;
    }
    if (block.type === "link") {
      return `<p><a href="${escapeHtml(block.linkHref ?? "#")}">${escapeHtml(text)}</a></p>`;
    }
    return `<p>${escapeHtml(text)}</p>`;
  }).join("\n      ");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · 无障碍版本</title>
  <style>
    :root { font-family: "Noto Sans SC", sans-serif; font-size: 20px; line-height: 1.85; color: #17231f; background: #fffdf7; }
    body { max-width: 760px; margin: 0 auto; padding: 32px 24px 80px; }
    a { color: #075c9d; text-decoration-thickness: 2px; text-underline-offset: 3px; }
    a:focus-visible, [tabindex]:focus-visible { outline: 4px solid #d08a00; outline-offset: 3px; }
    h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin-top: 1.8em; }
    figure { margin: 2em 0; } img { max-width: 100%; height: auto; } figcaption { font-size: .86em; color: #46554f; }
    .skip { position: absolute; left: -9999px; } .skip:focus { position: static; display: inline-block; padding: .5em; background: #fff; }
  </style>
</head>
<body>
  <a class="skip" href="#main">跳到正文</a>
  <main id="main" tabindex="-1">
      ${body}
  </main>
</body>
</html>`;
}
