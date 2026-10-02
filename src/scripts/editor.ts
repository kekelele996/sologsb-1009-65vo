import "@shoelace-style/shoelace/dist/shoelace.js";

type BlockType = "heading" | "paragraph" | "image" | "link";
type ReviewStatus = "pending" | "approved" | "needs-work";
type Severity = "error" | "warning" | "info";

interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

interface CommentItem {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
}

/** 原稿侧快照：出版社某一版原稿的块内容，只读。 */
interface SourceSnapshot {
  type: BlockType;
  text: string;
  headingLevel?: number;
  imageSrc?: string;
  linkHref?: string;
}

/** 原稿块：只认出版社的版本，编辑不可在工作台内改动。 */
interface SourceBlock extends SourceSnapshot {
  id: string;
}

/** 改写块：留在编辑手里，装无障碍表达、改写原因、结论与批注。 */
interface RewriteBlock {
  id: string;
  /** 指向当前出版社原稿块；null 表示暂时对接不上（待对接或已移出）。 */
  sourceBlockId: string | null;
  type: BlockType;
  /** 上次确认通过时所依据的原稿快照，用于新旧对照。 */
  basedOn: SourceSnapshot;
  accessibleText: string;
  imageAlt: string;
  changeReason: string;
  reviewStatus: ReviewStatus;
  comments: CommentItem[];
  /** 新版原稿文字动过：旧改写保留对照，状态退回待改写。 */
  stale: boolean;
  /** 新版中新增的块。 */
  isNew: boolean;
  /** 原稿已去掉、被挪到一边的块。 */
  orphaned: boolean;
}

interface GlossaryTerm {
  id: string;
  source: string;
  preferred: string;
  note: string;
}

interface VersionSnapshot {
  id: string;
  label: string;
  createdAt: string;
  blocks: RewriteBlock[];
  glossary: GlossaryTerm[];
}

interface SourceDocument {
  schema: 2;
  fileName: string;
  importedAt: string;
  blocks: SourceBlock[];
}

interface RewriteDocument {
  schema: 2;
  blocks: RewriteBlock[];
  orphaned: RewriteBlock[];
  glossary: GlossaryTerm[];
  versions: VersionSnapshot[];
  updatedAt: string;
}

interface ChapterProject {
  id: string;
  title: string;
  subject: string;
  grade: string;
  source: SourceDocument;
  rewrite: RewriteDocument;
}

interface AccessibilityIssue {
  id: string;
  blockId: string;
  type: "heading" | "link" | "image" | "glossary" | "sentence" | "stale";
  severity: Severity;
  title: string;
  detail: string;
  suggestion: string;
}

interface AlignmentReport {
  matched: number;
  changed: number;
  added: number;
  removed: number;
}

const STORAGE_KEY = "sologsb-1009-accessible-textbook-v1";
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function snapshotSource(source: SourceBlock): SourceSnapshot {
  return { type: source.type, text: source.text, headingLevel: source.headingLevel, imageSrc: source.imageSrc, linkHref: source.linkHref };
}

function blankRewriteBlock(source: SourceBlock): RewriteBlock {
  return {
    id: uid("rewrite"),
    sourceBlockId: source.id,
    type: source.type,
    basedOn: snapshotSource(source),
    accessibleText: "",
    imageAlt: "",
    changeReason: "",
    reviewStatus: "pending",
    comments: [],
    stale: false,
    isNew: true,
    orphaned: false,
  };
}

function createSeedProject(): ChapterProject {
  const imageSrc = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='420'%3E%3Crect width='800' height='420' fill='%23dcecf3'/%3E%3Ccircle cx='650' cy='85' r='45' fill='%23f4c95d'/%3E%3Cpath d='M0 300 Q180 240 340 300 T800 280 V420 H0Z' fill='%2389b7d0'/%3E%3Cpath d='M130 285 Q220 170 330 285' fill='none' stroke='%233a7c9e' stroke-width='12'/%3E%3C/svg%3E";
  const sourceBlocks: SourceBlock[] = [
    { id: "block-h1", type: "heading", headingLevel: 1, text: "第三章 水循环与城市" },
    { id: "block-p1", type: "paragraph", text: "城市中的水并非取之不尽，由于其会通过蒸发、降水以及地表径流等若干复杂过程在自然界中持续循环，因此理解这些过程对于建设具有韧性的城市具有十分重要的意义。" },
    { id: "block-h2", type: "heading", headingLevel: 2, text: "一、水从哪里来" },
    { id: "block-img", type: "image", text: "图 3-1 城市水循环示意", imageSrc },
    { id: "block-p2", type: "paragraph", text: "当太阳照射到水面时，水会受热变成水蒸气升到空中。水蒸气冷却后形成云，再以雨或雪的形式落回地面。" },
    { id: "block-link", type: "link", text: "点击这里", linkHref: "/resources/water-cycle" },
    { id: "block-h3", type: "heading", headingLevel: 3, text: "雨水花园怎样工作" },
    { id: "block-p3", type: "paragraph", text: "雨水花园利用土壤和植物的共同作用暂时储存雨水，同时通过下渗补给地下水，并在降雨较集中时减轻城市排水管道所承受的压力。" },
  ];

  const rewriteBlocks: RewriteBlock[] = [
    { id: "block-h1", sourceBlockId: "block-h1", type: "heading", basedOn: snapshotSource(sourceBlocks[0]), accessibleText: "第三章 水循环与城市", imageAlt: "", changeReason: "", reviewStatus: "approved", comments: [], stale: false, isNew: false, orphaned: false },
    { id: "block-p1", sourceBlockId: "block-p1", type: "paragraph", basedOn: snapshotSource(sourceBlocks[1]), accessibleText: "城市里的水会不断循环。它经过蒸发、降水并沿地面流动。了解这些过程，可以帮助我们建设更能适应变化的城市。", imageAlt: "", changeReason: "拆分长句，把抽象表述改为更直接的说明。", reviewStatus: "pending", comments: [], stale: false, isNew: false, orphaned: false },
    { id: "block-h2", sourceBlockId: "block-h2", type: "heading", basedOn: snapshotSource(sourceBlocks[2]), accessibleText: "一、水从哪里来", imageAlt: "", changeReason: "保留原章节结构。", reviewStatus: "approved", comments: [], stale: false, isNew: false, orphaned: false },
    { id: "block-img", sourceBlockId: "block-img", type: "image", basedOn: snapshotSource(sourceBlocks[3]), accessibleText: "", imageAlt: "", changeReason: "", reviewStatus: "needs-work", comments: [], stale: false, isNew: false, orphaned: false },
    { id: "block-p2", sourceBlockId: "block-p2", type: "paragraph", basedOn: snapshotSource(sourceBlocks[4]), accessibleText: "太阳照在水面上，水会变成水蒸气升到空中。水蒸气冷却后变成云，最后以雨或雪落回地面。", imageAlt: "", changeReason: "使用较短句子，并明确每个步骤的先后顺序。", reviewStatus: "approved", comments: [], stale: false, isNew: false, orphaned: false },
    { id: "block-link", sourceBlockId: "block-link", type: "link", basedOn: snapshotSource(sourceBlocks[5]), accessibleText: "打开水循环互动实验", imageAlt: "", changeReason: "改为说明链接目标的独立文案。", reviewStatus: "pending", comments: [], stale: false, isNew: false, orphaned: false },
    { id: "block-h3", sourceBlockId: "block-h3", type: "heading", basedOn: snapshotSource(sourceBlocks[6]), accessibleText: "雨水花园怎样工作", imageAlt: "", changeReason: "", reviewStatus: "approved", comments: [], stale: false, isNew: false, orphaned: false },
    { id: "block-p3", sourceBlockId: "block-p3", type: "paragraph", basedOn: snapshotSource(sourceBlocks[7]), accessibleText: "雨水花园用土壤和植物暂时存住雨水。雨水还会慢慢渗入地下，补充地下水。雨很大时，它可以减轻排水管的压力。", imageAlt: "", changeReason: "把并列成分拆成短句，减少专业术语密度。", reviewStatus: "pending", comments: [], stale: false, isNew: false, orphaned: false },
  ];

  const now = new Date().toISOString();
  return {
    id: "accessible-textbook-1009",
    title: "科学（五年级下册）·无障碍改写稿",
    subject: "科学",
    grade: "五年级",
    source: { schema: 2, fileName: "出版社样章", importedAt: now, blocks: sourceBlocks },
    rewrite: {
      schema: 2,
      blocks: rewriteBlocks,
      orphaned: [],
      glossary: [
        { id: "term-1", source: "水循环", preferred: "水循环", note: "全书统一使用" },
        { id: "term-2", source: "地表径流", preferred: "沿地面流动的水", note: "首次出现时使用通俗解释" },
        { id: "term-3", source: "下渗", preferred: "渗入地下", note: "避免单独使用专业词" },
      ],
      versions: [],
      updatedAt: now,
    },
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** 解析出版社原稿（TXT / Markdown），只产出原稿块，不含任何改写内容。 */
function parseSourceEdition(input: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ id: uid("src"), type: "heading", text: heading[2], headingLevel: heading[1].length });
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)(?:\s+(.+))?$/.exec(line);
    if (image) {
      blocks.push({ id: uid("src"), type: "image", text: image[3] || "未命名图片", imageSrc: image[2] });
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(line);
    if (link) {
      blocks.push({ id: uid("src"), type: "link", text: link[1], linkHref: link[2] });
      continue;
    }
    blocks.push({ id: uid("src"), type: "paragraph", text: line });
  }
  return blocks;
}

/** 归一化文本，用于块对齐：去空白、去标点、拉丁字母小写。 */
function normalizeText(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/[，。！？；：、“”‘’（）《》〈〉【】\[\]()\-—…·.,!?;:'"]/g, "")
    .toLowerCase();
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na.length) return nb.length ? 0 : 1;
  if (!nb.length) return 0;
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
}

/**
 * 新版原稿接入：逐块对齐。
 * - 接得上（文字相同）：沿用原改写与审核结论；
 * - 原稿文字动过：旧改写留着对照，状态退回待改写，已通过的不算通过；
 * - 原稿去掉的块：挪到一边（orphaned），不进新版流程；
 * - 新加的块：按待改写进来。
 * 纯函数：给定新原稿块与现有改写稿，返回新的改写稿状态，失败可原样重试。
 */
function alignEdition(newSources: SourceBlock[], rewrites: RewriteBlock[]): { blocks: RewriteBlock[]; orphaned: RewriteBlock[]; report: AlignmentReport } {
  const active = rewrites.filter((block) => !block.orphaned);
  const orphaned = rewrites.filter((block) => block.orphaned);

  interface Candidate {
    si: number;
    ri: number;
    score: number;
    exact: boolean;
  }
  const candidates: Candidate[] = [];
  newSources.forEach((source, si) => {
    active.forEach((rewrite, ri) => {
      if (source.type !== rewrite.type) return;
      const old = rewrite.basedOn;
      let score = textSimilarity(source.text, old.text);
      if (source.type === "heading" && (source.headingLevel ?? 2) !== (old.headingLevel ?? 2)) score -= 0.25;
      if (source.type === "image" && source.imageSrc && source.imageSrc === old.imageSrc) score = Math.max(score, 0.92);
      if (source.type === "link" && source.linkHref && source.linkHref === old.linkHref) score = Math.max(score, 0.92);
      // 位置相近时略加分，打破同分时的平局。
      score += 0.001 / (1 + Math.abs(si - ri));
      const exact =
        normalizeText(source.text) === normalizeText(old.text) &&
        (source.type !== "heading" || (source.headingLevel ?? 2) === (old.headingLevel ?? 2)) &&
        (source.type !== "image" || source.imageSrc === old.imageSrc) &&
        (source.type !== "link" || source.linkHref === old.linkHref);
      if (exact || score >= 0.6) candidates.push({ si, ri, score, exact });
    });
  });

  candidates.sort((a, b) => b.score - a.score);
  const usedS = new Set<number>();
  const usedR = new Set<number>();
  const pairs: { si: number; ri: number; exact: boolean }[] = [];
  for (const candidate of candidates) {
    if (usedS.has(candidate.si) || usedR.has(candidate.ri)) continue;
    usedS.add(candidate.si);
    usedR.add(candidate.ri);
    pairs.push({ si: candidate.si, ri: candidate.ri, exact: candidate.exact });
  }

  const blocks: RewriteBlock[] = [];
  const report: AlignmentReport = { matched: 0, changed: 0, added: 0, removed: 0 };
  const pairBySource = new Map(pairs.map((pair) => [pair.si, pair]));
  const pairByRewrite = new Map(pairs.map((pair) => [pair.ri, pair]));

  newSources.forEach((source, si) => {
    const pair = pairBySource.get(si);
    if (!pair) {
      blocks.push(blankRewriteBlock(source));
      report.added += 1;
      return;
    }
    const rewrite = active[pair.ri];
    rewrite.sourceBlockId = source.id;
    rewrite.type = source.type;
    if (pair.exact) {
      rewrite.basedOn = snapshotSource(source);
      rewrite.stale = false;
      report.matched += 1;
    } else {
      rewrite.stale = true;
      rewrite.reviewStatus = "pending";
      rewrite.isNew = false;
      // basedOn 保留旧稿快照，供新旧对照。
      report.changed += 1;
    }
    blocks.push(rewrite);
  });

  active.forEach((rewrite, ri) => {
    if (!pairByRewrite.has(ri)) {
      orphaned.push({ ...rewrite, orphaned: true, sourceBlockId: null, stale: false });
      report.removed += 1;
    }
  });

  return { blocks, orphaned, report };
}

type StoredV1Block = {
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
};

type StoredV1Project = {
  id: string;
  title: string;
  subject: string;
  grade: string;
  blocks: StoredV1Block[];
  glossary: GlossaryTerm[];
  versions: { id: string; label: string; createdAt: string; blocks: StoredV1Block[]; glossary: GlossaryTerm[] }[];
  updatedAt: string;
};

function migrateV1ToV2(old: StoredV1Project): ChapterProject {
  const toSource = (block: StoredV1Block): SourceBlock => ({
    id: block.id,
    type: block.type,
    text: block.text,
    headingLevel: block.headingLevel,
    imageSrc: block.imageSrc,
    linkHref: block.linkHref,
  });
  const toRewrite = (block: StoredV1Block): RewriteBlock => ({
    id: block.id,
    sourceBlockId: block.id,
    type: block.type,
    basedOn: { type: block.type, text: block.text, headingLevel: block.headingLevel, imageSrc: block.imageSrc, linkHref: block.linkHref },
    accessibleText: block.accessibleText,
    imageAlt: block.imageAlt ?? "",
    changeReason: block.changeReason,
    reviewStatus: block.reviewStatus,
    comments: block.comments,
    stale: false,
    isNew: false,
    orphaned: false,
  });

  const sourceBlocks = old.blocks.map(toSource);
  const rewriteBlocks = old.blocks.map(toRewrite);
  const versions: VersionSnapshot[] = (old.versions ?? []).map((version) => ({
    id: version.id,
    label: version.label,
    createdAt: version.createdAt,
    blocks: version.blocks.map(toRewrite),
    glossary: version.glossary,
  }));

  return {
    id: old.id,
    title: old.title,
    subject: old.subject,
    grade: old.grade,
    source: { schema: 2, fileName: "出版社原稿（迁移自旧版）", importedAt: old.updatedAt, blocks: sourceBlocks },
    rewrite: {
      schema: 2,
      blocks: rewriteBlocks,
      orphaned: [],
      glossary: old.glossary ?? [],
      versions,
      updatedAt: old.updatedAt,
    },
  };
}

function loadProject(): ChapterProject {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as { schema?: number; project?: ChapterProject | StoredV1Project };
    if (raw?.schema === 2 && raw.project && "source" in raw.project && "rewrite" in raw.project) {
      return raw.project as ChapterProject;
    }
    if (raw?.schema === 1 && raw.project && "blocks" in raw.project && (raw.project as StoredV1Project).blocks?.length) {
      return migrateV1ToV2(raw.project as StoredV1Project);
    }
  } catch {
    // 存档损坏时回退到示例章节。
  }
  return createSeedProject();
}

function sentenceLength(text: string) {
  const normalized = text.replace(/\s+/g, "");
  return /[A-Za-z]/.test(text) ? text.trim().split(/\s+/).length : normalized.length;
}

function sourceOf(project: ChapterProject, block: RewriteBlock): SourceBlock | undefined {
  return project.source.blocks.find((item) => item.id === block.sourceBlockId);
}

function analyze(project: ChapterProject): AccessibilityIssue[] {
  const issues: AccessibilityIssue[] = [];
  let lastHeading = 0;
  for (const block of project.rewrite.blocks) {
    const source = sourceOf(project, block);
    if (!source) continue;

    if (source.type === "heading") {
      const level = source.headingLevel ?? 2;
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
    if (source.type === "image" && !(block.imageAlt ?? "").trim()) {
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
    if (source.type === "link") {
      const label = block.accessibleText || source.text;
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
    const sentences = source.text.split(/(?<=[。！？!?])\s*/).filter(Boolean);
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
    const sourceText = `${source.text} ${block.accessibleText}`;
    for (const term of project.rewrite.glossary) {
      if (sourceText.includes(term.source) && block.accessibleText && !block.accessibleText.includes(term.preferred)) {
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
    if (block.stale) {
      issues.push({
        id: `stale-${block.id}`,
        blockId: block.id,
        type: "stale",
        severity: "info",
        title: "原稿已变动，待重新对照",
        detail: "出版社新版原稿调整了这段文字，旧改写已保留供对照。",
        suggestion: "对照新版原稿更新无障碍表达，然后重新审核通过。",
      });
    }
  }
  return issues;
}

function simplifyText(input: string, glossary: GlossaryTerm[]) {
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
  result = result
    .split(/(?<=[。！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .join("\n");
  return result;
}

function blockRole(type: BlockType, headingLevel?: number) {
  if (type === "heading") return `H${headingLevel ?? 2} 标题`;
  if (type === "image") return "图片 / 替代文本";
  if (type === "link") return "链接";
  return "正文段落";
}

function statusLabel(status: ReviewStatus) {
  if (status === "approved") return "已通过";
  if (status === "needs-work") return "需修改";
  return "待审核";
}

/** 字符级 LCS，用于新旧原稿对照。 */
function diffSegments(oldText: string, newText: string): { text: string; kind: "equal" | "del" | "ins" }[] {
  const m = oldText.length;
  const n = newText.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldText[i] === newText[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segments: { text: string; kind: "equal" | "del" | "ins" }[] = [];
  const push = (text: string, kind: "equal" | "del" | "ins") => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldText[i] === newText[j]) {
      push(oldText[i], "equal");
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(oldText[i], "del");
      i += 1;
    } else {
      push(newText[j], "ins");
      j += 1;
    }
  }
  while (i < m) {
    push(oldText[i], "del");
    i += 1;
  }
  while (j < n) {
    push(newText[j], "ins");
    j += 1;
  }
  return segments;
}

function renderDiffSide(segments: { text: string; kind: "equal" | "del" | "ins" }[], side: "old" | "new") {
  return segments
    .map((segment) => {
      if (segment.kind === "equal") return escapeHtml(segment.text);
      if (side === "old" && segment.kind === "del") return `<del>${escapeHtml(segment.text)}</del>`;
      if (side === "new" && segment.kind === "ins") return `<ins>${escapeHtml(segment.text)}</ins>`;
      return "";
    })
    .join("");
}

function exportHtml(project: ChapterProject) {
  const body = project.rewrite.blocks
    .map((block) => {
      const source = sourceOf(project, block);
      if (!source) return "";
      if (source.type === "heading") {
        const level = Math.min(6, Math.max(1, source.headingLevel ?? 2));
        return `<h${level}>${escapeHtml(block.accessibleText || source.text)}</h${level}>`;
      }
      if (source.type === "image") {
        return `<figure><img src="${escapeHtml(source.imageSrc ?? "")}" alt="${escapeHtml(block.imageAlt || block.accessibleText)}"><figcaption>${escapeHtml(source.text)}</figcaption></figure>`;
      }
      if (source.type === "link") {
        return `<p><a href="${escapeHtml(source.linkHref ?? "#")}">${escapeHtml(block.accessibleText || source.text)}</a></p>`;
      }
      return `<p>${escapeHtml(block.accessibleText || source.text)}</p>`;
    })
    .join("\n      ");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.title)} · 无障碍版本</title>
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

function download(filename: string, content: string, type = "text/html;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Application root was not found");
const app: HTMLDivElement = rootElement;

let project = loadProject();
let activeBlockId = project.rewrite.blocks[0]?.id ?? "";
let activeIssueId = "";
let previewMode: "normal" | "assisted" = "normal";
let selectedVersionId = "";
let showGlossary = false;
let showArchive = false;
let sourceImportError = "";
let lastAlignReport: AlignmentReport | null = null;
let pendingSourceFile: File | null = null;
let undoStack: ChapterProject[] = [];
let redoStack: ChapterProject[] = [];
let saveTimer = 0;

const activeBlock = () => project.rewrite.blocks.find((block) => block.id === activeBlockId) ?? project.rewrite.blocks[0];
const issues = () => analyze(project);

function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 2, project }));
  }, 320);
}

function commit(label: string, update: (draft: ChapterProject) => void, renderAfter = true) {
  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  redoStack = [];
  const draft = structuredClone(project);
  update(draft);
  draft.rewrite.updatedAt = new Date().toISOString();
  project = draft;
  document.documentElement.dataset.lastAction = label;
  saveSoon();
  if (renderAfter) render();
}

function undo() {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack = [structuredClone(project), ...redoStack].slice(0, 50);
  project = previous;
  if (!project.rewrite.blocks.some((block) => block.id === activeBlockId)) activeBlockId = project.rewrite.blocks[0]?.id ?? "";
  saveSoon();
  render();
}

function redo() {
  const next = redoStack.shift();
  if (!next) return;
  undoStack = [...undoStack.slice(-49), structuredClone(project)];
  project = next;
  saveSoon();
  render();
}

function updateActiveBlock(update: (block: RewriteBlock, draft: ChapterProject) => void, label = "修改无障碍文本", renderAfter = true) {
  commit(label, (draft) => {
    const block = draft.rewrite.blocks.find((item) => item.id === activeBlockId);
    if (block) update(block, draft);
  }, renderAfter);
}

function renderSourceView(source: SourceBlock) {
  if (source.type === "image") {
    return `<div class="image-source">
      <img src="${escapeHtml(source.imageSrc ?? "")}" alt="" />
      <div><b>图注</b><p>${escapeHtml(source.text)}</p></div>
    </div>`;
  }
  if (source.type === "link") {
    return `<div class="link-source"><b>原链接文案</b><p>${escapeHtml(source.text)}</p><b>链接地址</b><p>${escapeHtml(source.linkHref ?? "")}</p></div>`;
  }
  if (source.type === "heading") {
    return `<div class="heading-source"><sl-badge variant="neutral">H${source.headingLevel ?? 2}</sl-badge><p>${escapeHtml(source.text)}</p></div>`;
  }
  return `<p class="source-text">${escapeHtml(source.text)}</p>`;
}

function renderSourceCard(block: RewriteBlock) {
  const source = sourceOf(project, block);
  if (!source) {
    return `<div class="empty-note">该块尚未对接出版社原稿，内容仅保存在改写稿一侧。</div>`;
  }
  if (block.stale) {
    const segments = diffSegments(block.basedOn.text, source.text);
    return `
      <div class="source-diff">
        <div class="diff-col old"><span>旧稿（改写依据）</span><p>${renderDiffSide(segments, "old")}</p></div>
        <div class="diff-col new"><span>新版原稿</span><p>${renderDiffSide(segments, "new")}</p></div>
      </div>
      <div class="old-rewrite-note">原稿已变动：旧改写仍保留在下方编辑框中供对照，请对照新版更新改写后重新审核。</div>
      <div class="source-meta">${renderSourceMeta(source)}</div>`;
  }
  return renderSourceView(source);
}

function renderSourceMeta(source: SourceBlock) {
  if (source.type === "heading") return `<sl-badge variant="neutral">H${source.headingLevel ?? 2}</sl-badge>`;
  if (source.type === "image") return `<span class="meta-note">图片地址：${escapeHtml(source.imageSrc ?? "")}</span>`;
  if (source.type === "link") return `<span class="meta-note">链接地址：${escapeHtml(source.linkHref ?? "")}</span>`;
  return "";
}

function render() {
  const list = issues();
  const active = activeBlock();
  const activeIssues = list.filter((issue) => issue.blockId === active?.id);
  const approved = project.rewrite.blocks.filter((block) => block.reviewStatus === "approved").length;
  const staleCount = project.rewrite.blocks.filter((block) => block.stale).length;
  const newCount = project.rewrite.blocks.filter((block) => block.isNew).length;
  const pendingCount = project.rewrite.blocks.filter((block) => block.reviewStatus === "pending" || block.reviewStatus === "needs-work").length;
  const version = project.rewrite.versions.find((item) => item.id === selectedVersionId) ?? project.rewrite.versions[0];

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span>无障碍</span><b>1009</b></div>
        <div class="title-block">
          <input id="project-title" aria-label="教材名称" value="${escapeHtml(project.title)}" />
          <div class="meta"><span>${escapeHtml(project.subject)}</span><span>${escapeHtml(project.grade)}</span><span class="save-dot">本地自动保存</span></div>
        </div>
        <div class="top-actions">
          <span class="online-pill">${navigator.onLine ? "在线" : "离线可编辑"}</span>
          <sl-button size="small" variant="default" ${undoStack.length ? "" : "disabled"} data-action="undo">撤销</sl-button>
          <sl-button size="small" variant="default" ${redoStack.length ? "" : "disabled"} data-action="redo">重做</sl-button>
          <sl-button size="small" variant="default" data-action="glossary">术语表</sl-button>
          <sl-button size="small" variant="primary" data-action="save-version">保存版本</sl-button>
          <sl-button size="small" variant="success" data-action="export">导出无障碍 HTML</sl-button>
        </div>
      </header>

      <div class="progress-strip">
        <div class="progress-copy"><b>${approved}/${project.rewrite.blocks.length}</b><span>改写块已审核通过</span></div>
        <div class="progress-bar"><i style="width:${Math.round((approved / Math.max(1, project.rewrite.blocks.length)) * 100)}%"></i></div>
        <div class="issue-counts">
          <span class="warning">${pendingCount} 待改写</span>
          <span class="info">${staleCount} 原稿变动</span>
          <span class="info">${newCount} 新增</span>
          <span class="error">${list.filter((issue) => issue.severity === "error").length} 必须修复</span>
          <span class="warning">${list.filter((issue) => issue.severity === "warning").length} 建议优化</span>
        </div>
      </div>

      <div class="workspace">
        <aside class="outline-panel">
          <div class="panel-title"><span>改写稿结构</span><sl-badge>${project.rewrite.blocks.length} 块</sl-badge></div>
          ${lastAlignReport ? `
            <div class="align-report">
              <strong>新版原稿已接入</strong>
              <span>${lastAlignReport.matched} 块沿用原改写</span>
              <span>${lastAlignReport.changed} 块原稿变动，已退回待改写</span>
              <span>${lastAlignReport.added} 块新增</span>
              <span>${lastAlignReport.removed} 块已移出</span>
              <button data-action="dismiss-align">知道了</button>
            </div>` : ""}
          <div class="block-list">
            ${project.rewrite.blocks.map((block, index) => {
              const blockIssues = list.filter((issue) => issue.blockId === block.id);
              const source = sourceOf(project, block);
              const preview = block.accessibleText || source?.text || "（空）";
              return `<button class="block-item ${active && block.id === active.id ? "active" : ""}" data-action="select-block" data-block-id="${block.id}">
                <span class="block-order">${index + 1}</span>
                <span class="block-copy">
                  <b>${blockRole(block.type, source?.headingLevel)}</b>
                  <span class="block-text">${escapeHtml(preview)}</span>
                  <span class="block-flags">
                    ${block.stale ? `<em class="flag flag-stale">原稿变动</em>` : ""}
                    ${block.isNew ? `<em class="flag flag-new">新增</em>` : ""}
                    ${!source ? `<em class="flag flag-unlinked">待对接</em>` : ""}
                    ${blockIssues.length ? `<em class="flag flag-issue">${blockIssues.length} 问题</em>` : ""}
                  </span>
                </span>
                <i class="status-${block.reviewStatus}" title="${statusLabel(block.reviewStatus)}"></i>
              </button>`;
            }).join("")}
          </div>

          <div class="archive-panel">
            <button class="archive-toggle" data-action="toggle-archive">已移出原稿的块（${project.rewrite.orphaned.length}）</button>
            ${showArchive ? `<div class="archive-list">
              ${project.rewrite.orphaned.length ? project.rewrite.orphaned.map((block) => {
                const source = block.basedOn;
                return `<div class="archive-item">
                  <div class="archive-head"><b>${blockRole(block.type, source.headingLevel)}</b><span>${escapeHtml(source.text)}</span></div>
                  <p class="archive-old">旧改写：${escapeHtml(block.accessibleText || "（空）")}</p>
                  <sl-button size="small" variant="default" data-action="restore-block" data-block-id="${block.id}">恢复到改写稿</sl-button>
                </div>`;
              }).join("") : `<div class="empty-note">没有被移出的块。新版原稿去掉的段落会挪到这里，旧改写保留不丢。</div>`}
            </div>` : ""}
          </div>

          <input id="chapter-file" type="file" accept=".txt,.md,.markdown" hidden />
          <sl-button class="import-button" variant="primary" data-action="import">导入新版原稿</sl-button>
          <div class="source-edition">
            <b>当前原稿</b><span>${escapeHtml(project.source.fileName)}</span><time>${new Date(project.source.importedAt).toLocaleString()}</time>
          </div>
          ${sourceImportError ? `
            <div class="source-error">
              <strong>原稿读取失败</strong>
              <span>${escapeHtml(sourceImportError)}</span>
              <span>编辑写好的内容已保留，未受影响。</span>
              <div class="source-error-actions">
                <sl-button size="small" variant="primary" data-action="retry-source">重试读取原稿</sl-button>
                <sl-button size="small" variant="text" data-action="dismiss-source-error">取消</sl-button>
              </div>
            </div>` : ""}
          <div class="keyboard-note"><b>键盘</b><span><kbd>J</kbd><kbd>K</kbd> 跳转问题</span><span><kbd>E</kbd> 自动改写</span><span><kbd>⌘ Z</kbd> 撤销</span><span><kbd>1</kbd><kbd>2</kbd> 预览模式</span></div>
        </aside>

        <main class="editor-panel">
          ${active ? `
          <div class="editor-head">
            <div><span class="eyebrow">当前改写块</span><h1>${blockRole(active.type, sourceOf(project, active)?.headingLevel)}</h1></div>
            <div class="review-actions">
              <sl-button size="small" variant="${active.reviewStatus === "approved" ? "success" : "default"}" data-action="approve">${active.reviewStatus === "approved" ? "✓ 已通过" : "审核通过"}</sl-button>
              <sl-button size="small" variant="${active.reviewStatus === "needs-work" ? "danger" : "default"}" data-action="needs-work">需修改</sl-button>
            </div>
          </div>

          ${activeIssues.length ? `<div class="active-issues">${activeIssues.map((issue) => `
            <div class="issue-card ${issue.severity}">
              <div><sl-badge variant="${issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warning" : "primary"}">${issue.severity === "error" ? "必须修复" : issue.severity === "warning" ? "建议优化" : "一致性提醒"}</sl-badge><strong>${escapeHtml(issue.title)}</strong></div>
              <p>${escapeHtml(issue.detail)}</p><small>${escapeHtml(issue.suggestion)}</small>
            </div>`).join("")}</div>` : `<div class="issue-clear">✓ 当前改写块没有新的无障碍问题</div>`}

          <section class="edit-card source-card">
            <div class="section-heading">
              <div><span class="eyebrow">出版社原稿（只读）</span><h2>${active.stale ? "新旧原稿对照" : "原教材"}</h2></div>
              ${active.stale ? `<sl-badge variant="warning">原稿已变动</sl-badge>` : `<sl-badge variant="neutral">${active.type}</sl-badge>`}
            </div>
            ${renderSourceCard(active)}
          </section>

          <section class="edit-card rewrite-card">
            <div class="section-heading">
              <div><span class="eyebrow">Accessible rewrite</span><h2>无障碍表达</h2></div>
              <sl-button size="small" variant="primary" outline data-action="generate">生成易读版本</sl-button>
            </div>
            ${active.stale ? `<div class="stale-note">原稿已变动 · 旧改写保留对照，请更新后重新审核</div>` : ""}
            ${active.type === "image"
              ? `<sl-textarea id="accessible-${active.id}" data-field="accessible" rows="3" label="图片替代文本" value="${escapeHtml(active.imageAlt || active.accessibleText)}" help-text="读屏软件会朗读这里的内容。"></sl-textarea>`
              : `<sl-textarea id="accessible-${active.id}" data-field="accessible" rows="6" value="${escapeHtml(active.accessibleText)}"></sl-textarea>`}
            <label class="field-label" for="reason-${active.id}">改写原因（每处改写必须记录）</label>
            <sl-textarea id="reason-${active.id}" data-field="reason" rows="2" value="${escapeHtml(active.changeReason)}" placeholder="例如：拆分长句、替换专业表达、补充链接目的"></sl-textarea>
          </section>

          <section class="edit-card">
            <div class="section-heading"><div><span class="eyebrow">Review discussion</span><h2>批注与回复</h2></div><sl-badge variant="warning">${active.comments.length} 条</sl-badge></div>
            <div class="comment-compose"><sl-textarea id="new-comment" rows="2" placeholder="记录改写依据、审核意见或术语讨论…"></sl-textarea><sl-button size="small" variant="primary" data-action="add-comment">添加批注</sl-button></div>
            <div class="comment-list">
              ${active.comments.length ? active.comments.map((comment) => `
                <article class="comment ${comment.resolved ? "resolved" : ""}">
                  <header><b>${escapeHtml(comment.author)}</b><time>${new Date(comment.createdAt).toLocaleString()}</time></header>
                  <p>${escapeHtml(comment.body)}</p>
                  ${comment.replies.map((reply) => `<div class="reply"><b>${escapeHtml(reply.author)}</b><span>${escapeHtml(reply.body)}</span></div>`).join("")}
                  <div class="reply-row"><sl-input size="small" id="reply-${comment.id}" placeholder="回复…"></sl-input><sl-button size="small" data-action="reply" data-comment-id="${comment.id}">回复</sl-button><sl-button size="small" variant="text" data-action="resolve-comment" data-comment-id="${comment.id}">${comment.resolved ? "重新打开" : "解决"}</sl-button></div>
                </article>`).join("") : `<div class="empty-note">当前改写块还没有批注。</div>`}
            </div>
          </section>
          ` : `<div class="empty-note">当前没有可编辑的改写块。</div>`}
        </main>

        <aside class="review-panel">
          <section class="preview-card">
            <div class="section-heading"><div><span class="eyebrow">Reader preview</span><h2>阅读预览</h2></div><div class="mode-switch"><button class="${previewMode === "normal" ? "active" : ""}" data-action="preview-normal">普通</button><button class="${previewMode === "assisted" ? "active" : ""}" data-action="preview-assisted">辅助</button></div></div>
            <div class="reader-preview mode-${previewMode}">${renderPreview()}</div>
          </section>

          <section class="order-card">
            <div class="section-heading"><div><span class="eyebrow">Screen reader order</span><h2>读屏阅读顺序</h2></div><sl-badge>从上到下</sl-badge></div>
            <ol class="reading-order">
              ${project.rewrite.blocks.map((block, index) => {
                const source = sourceOf(project, block);
                if (!source) return "";
                return `<li class="${active && block.id === active.id ? "active" : ""}"><b>${index + 1}</b><div><strong>${blockRole(block.type, source.headingLevel)}</strong><span>${escapeHtml(block.accessibleText || source.text || "（无内容）")}</span></div></li>`;
              }).join("")}
            </ol>
          </section>

          <section class="issues-panel">
            <div class="section-heading"><div><span class="eyebrow">All checks</span><h2>全章问题</h2></div><sl-button size="small" variant="default" outline data-action="approve-all">全部通过</sl-button></div>
            <div class="issue-list">
              ${list.length ? list.map((issue) => {
                const blockIndex = project.rewrite.blocks.findIndex((block) => block.id === issue.blockId);
                return `<button class="${issue.id === activeIssueId ? "active" : ""} ${issue.severity}" data-action="jump-issue" data-issue-id="${issue.id}" data-block-id="${issue.blockId}"><span>${issue.severity === "error" ? "必须修复" : issue.severity === "warning" ? "建议优化" : "一致性提醒"}</span><b>${escapeHtml(issue.title)}</b><small>段 ${blockIndex + 1} · ${escapeHtml(issue.suggestion)}</small></button>`;
              }).join("") : `<div class="issue-clear">✓ 全章检查通过</div>`}
            </div>
          </section>

          <section class="version-card">
            <div class="section-heading"><div><span class="eyebrow">Version compare</span><h2>版本比较</h2></div><sl-badge>${project.rewrite.versions.length} 版</sl-badge></div>
            ${project.rewrite.versions.length ? `
              <sl-select id="version-select" size="small" value="${version?.id ?? ""}">${project.rewrite.versions.map((item) => `<sl-option value="${item.id}">${escapeHtml(item.label)} · ${new Date(item.createdAt).toLocaleTimeString()}</sl-option>`).join("")}</sl-select>
              <div class="version-diff">${version && active ? renderVersionDiff(version, active) : ""}</div>
            ` : `<div class="empty-note">保存版本后，可比较改写前后的无障碍文本。</div>`}
          </section>
        </aside>
      </div>

      <footer class="statusbar"><span>最近操作：${escapeHtml(document.documentElement.dataset.lastAction || "示例章节已载入")}</span><span>${project.rewrite.blocks.length} 个改写块 · ${pendingCount} 待改写 · ${staleCount} 原稿变动 · ${list.length} 个问题</span></footer>
    </div>

    <sl-dialog label="全书术语表" ${showGlossary ? "open" : ""} data-dialog="glossary">
      <div class="glossary-editor">
        ${project.rewrite.glossary.map((term) => `<div class="term-row"><div><b>${escapeHtml(term.source)}</b><sl-input size="small" value="${escapeHtml(term.preferred)}" data-term-id="${term.id}"></sl-input><small>${escapeHtml(term.note)}</small></div><sl-button size="small" variant="danger" outline data-action="remove-term" data-term-id="${term.id}">删除</sl-button></div>`).join("")}
      </div>
      <div class="term-add"><sl-input id="new-term-source" placeholder="原文术语"></sl-input><sl-input id="new-term-preferred" placeholder="统一表达"></sl-input><sl-button variant="primary" data-action="add-term">添加术语</sl-button></div>
      <sl-button slot="footer" variant="primary" data-action="close-glossary">完成</sl-button>
    </sl-dialog>`;

  wireLiveFields();
}

function renderPreview() {
  return project.rewrite.blocks
    .map((block, index) => {
      const source = sourceOf(project, block);
      if (!source) return "";
      const content = escapeHtml(block.accessibleText || source.text);
      if (source.type === "heading") {
        const tag = `h${Math.min(6, Math.max(1, source.headingLevel ?? 2))}`;
        return `<${tag} class="${activeBlockId === block.id ? "active-block" : ""}"><span class="order-marker">${index + 1}</span>${content}</${tag}>`;
      }
      if (source.type === "image") {
        return `<figure class="${activeBlockId === block.id ? "active-block" : ""}"><img src="${escapeHtml(source.imageSrc ?? "")}" alt="${escapeHtml(block.imageAlt || block.accessibleText)}"><figcaption><span class="order-marker">${index + 1}</span>${escapeHtml(source.text)}</figcaption></figure>`;
      }
      if (source.type === "link") {
        return `<p class="${activeBlockId === block.id ? "active-block" : ""}"><span class="order-marker">${index + 1}</span><a href="${escapeHtml(source.linkHref ?? "#")}" onclick="return false">${content}</a><span class="link-role">链接</span></p>`;
      }
      return `<p class="${activeBlockId === block.id ? "active-block" : ""}"><span class="order-marker">${index + 1}</span>${content}</p>`;
    })
    .join("");
}

function renderVersionDiff(version: VersionSnapshot, current: RewriteBlock) {
  const oldBlock = version.blocks.find((block) => block.id === current.id);
  if (!oldBlock) return `<div class="empty-note">当前改写块不在该版本中。</div>`;
  return `<div class="diff-column"><span>旧版</span><p>${escapeHtml(oldBlock.accessibleText || oldBlock.basedOn.text)}</p></div><div class="diff-column current"><span>当前</span><p>${escapeHtml(current.accessibleText || current.basedOn.text)}</p></div>`;
}

function wireLiveFields() {
  app.querySelectorAll<HTMLElement>("sl-input[data-field], sl-textarea[data-field], sl-select[data-field]").forEach((element) => {
    element.addEventListener("sl-input", () => {
      const value = (element as HTMLElement & { value: string }).value;
      updateActiveBlock((block) => {
        const field = element.dataset.field;
        if (field === "accessible") {
          block.accessibleText = value;
          if (block.type === "image") block.imageAlt = value;
        }
        if (field === "reason") block.changeReason = value;
        block.isNew = false;
        block.reviewStatus = "pending";
      }, "编辑无障碍文本", false);
    });
    element.addEventListener("sl-change", () => render());
  });
}

async function handleSourceFile(file: File) {
  pendingSourceFile = file;
  sourceImportError = "";
  try {
    const text = await file.text();
    const sources = parseSourceEdition(text);
    if (!sources.length) throw new Error("未从文件中解析出任何内容块，请确认文件为 TXT 或 Markdown 章节文本。");
    const result = alignEdition(sources, project.rewrite.blocks);
    commit("接入新版原稿", (draft) => {
      draft.source = { schema: 2, fileName: file.name, importedAt: new Date().toISOString(), blocks: sources };
      draft.rewrite.blocks = result.blocks;
      draft.rewrite.orphaned = result.orphaned;
    });
    lastAlignReport = result.report;
    activeBlockId = result.blocks[0]?.id ?? "";
    activeIssueId = "";
    showArchive = false;
  } catch (error) {
    // 原稿侧读取失败：改写稿一侧原样保留，不做任何改动。
    sourceImportError = error instanceof Error ? error.message : "原稿读取失败，编辑内容未受影响。";
  }
  render();
}

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "undo") undo();
  if (action === "redo") redo();
  if (action === "select-block") {
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    activeIssueId = "";
    render();
  }
  if (action === "jump-issue") {
    activeIssueId = target.dataset.issueId ?? "";
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    render();
    requestAnimationFrame(() => app.querySelector<HTMLElement>(".editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  if (action === "generate") {
    const block = activeBlock();
    if (!block) return;
    const source = sourceOf(project, block);
    const raw = source?.text ?? block.basedOn.text;
    const suggestion = block.type === "link" ? "打开水循环互动实验" : simplifyText(block.type === "image" ? block.imageAlt || raw : raw, project.rewrite.glossary);
    updateActiveBlock((current) => {
      if (current.type === "image") current.imageAlt = suggestion;
      current.accessibleText = suggestion;
      current.changeReason ||= "拆分长句并替换复杂表达，保留原有知识信息。";
      current.isNew = false;
      current.reviewStatus = "pending";
    }, "生成易读版本");
  }
  if (action === "approve") updateActiveBlock((block, draft) => {
    block.reviewStatus = "approved";
    block.isNew = false;
    // 原稿变动后通过：以当前新版原稿为准，消除变动标记。
    if (block.stale) {
      const source = sourceOf(draft, block);
      if (source) {
        block.basedOn = snapshotSource(source);
        block.stale = false;
      }
    }
  }, "审核通过");
  if (action === "needs-work") updateActiveBlock((block) => { block.reviewStatus = "needs-work"; block.isNew = false; }, "标记需修改");
  if (action === "add-comment") {
    const input = app.querySelector<HTMLElement & { value: string }>("#new-comment");
    const body = input?.value.trim();
    if (body) updateActiveBlock((block) => {
      block.comments.unshift({ id: uid("comment"), author: "当前编辑", body, createdAt: new Date().toISOString(), resolved: false, replies: [] });
    }, "添加批注");
  }
  if (action === "reply") {
    const commentId = target.dataset.commentId ?? "";
    const input = app.querySelector<HTMLElement & { value: string }>(`#reply-${CSS.escape(commentId)}`);
    const body = input?.value.trim();
    if (body) updateActiveBlock((block) => {
      block.comments.find((comment) => comment.id === commentId)?.replies.push({ id: uid("reply"), author: "当前编辑", body, createdAt: new Date().toISOString() });
    }, "回复批注");
  }
  if (action === "resolve-comment") {
    const commentId = target.dataset.commentId ?? "";
    updateActiveBlock((block) => {
      const comment = block.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    }, "更新批注状态");
  }
  if (action === "preview-normal") { previewMode = "normal"; render(); }
  if (action === "preview-assisted") { previewMode = "assisted"; render(); }
  if (action === "glossary") { showGlossary = true; render(); }
  if (action === "close-glossary") { showGlossary = false; render(); }
  if (action === "add-term") {
    const source = app.querySelector<HTMLElement & { value: string }>("#new-term-source");
    const preferred = app.querySelector<HTMLElement & { value: string }>("#new-term-preferred");
    if (source?.value.trim() && preferred?.value.trim()) {
      commit("添加术语", (draft) => { draft.rewrite.glossary.push({ id: uid("term"), source: source.value.trim(), preferred: preferred.value.trim(), note: "编辑新增术语" }); });
    }
  }
  if (action === "remove-term") {
    const termId = target.dataset.termId;
    commit("删除术语", (draft) => { draft.rewrite.glossary = draft.rewrite.glossary.filter((term) => term.id !== termId); });
  }
  if (action === "save-version") {
    const versionId = uid("version");
    commit("保存版本快照", (draft) => {
      draft.rewrite.versions.unshift({ id: versionId, label: `版本 ${draft.rewrite.versions.length + 1}`, createdAt: new Date().toISOString(), blocks: structuredClone(draft.rewrite.blocks), glossary: structuredClone(draft.rewrite.glossary) });
      draft.rewrite.versions = draft.rewrite.versions.slice(0, 10);
    });
    selectedVersionId = versionId;
    render();
  }
  if (action === "approve-all") {
    commit("全部审核通过", (draft) => {
      draft.rewrite.blocks.forEach((block) => {
        block.reviewStatus = "approved";
        block.isNew = false;
        if (block.stale) {
          const source = sourceOf(draft, block);
          if (source) {
            block.basedOn = snapshotSource(source);
            block.stale = false;
          }
        }
      });
    });
  }
  if (action === "export") {
    download(`${project.title}-无障碍版.html`, exportHtml(project));
    document.documentElement.dataset.lastAction = "已导出无障碍 HTML";
    render();
  }
  if (action === "import") app.querySelector<HTMLInputElement>("#chapter-file")?.click();
  if (action === "retry-source") {
    if (pendingSourceFile) void handleSourceFile(pendingSourceFile);
  }
  if (action === "dismiss-source-error") {
    sourceImportError = "";
    render();
  }
  if (action === "dismiss-align") {
    lastAlignReport = null;
    render();
  }
  if (action === "toggle-archive") {
    showArchive = !showArchive;
    render();
  }
  if (action === "restore-block") {
    const blockId = target.dataset.blockId ?? "";
    commit("恢复已移出的块", (draft) => {
      const index = draft.rewrite.orphaned.findIndex((block) => block.id === blockId);
      if (index < 0) return;
      const [block] = draft.rewrite.orphaned.splice(index, 1);
      block.orphaned = false;
      block.sourceBlockId = null;
      block.stale = false;
      block.reviewStatus = "pending";
      draft.rewrite.blocks.push(block);
    });
  }
});

app.addEventListener("sl-change", (event) => {
  const element = event.target as HTMLElement;
  if (element.id === "chapter-file") return;
  if (element.id === "version-select") {
    selectedVersionId = (element as HTMLElement & { value: string }).value;
    render();
  }
  if (element.matches("[data-term-id]")) {
    const termId = element.dataset.termId;
    const value = (element as HTMLElement & { value: string }).value;
    commit("修改术语表", (draft) => { const term = draft.rewrite.glossary.find((item) => item.id === termId); if (term) term.preferred = value; });
  }
});

app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== "chapter-file" || !input.files?.[0]) return;
  const file = input.files[0];
  input.value = "";
  void handleSourceFile(file);
});

app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "project-title") {
    project.title = input.value;
    saveSoon();
  }
});

window.addEventListener("online", render);
window.addEventListener("offline", render);
window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.matches("input, textarea, sl-input, sl-textarea, [contenteditable='true']")) return;
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (command && event.key.toLowerCase() === "s") {
    event.preventDefault();
    const versionId = uid("version");
    commit("键盘保存版本", (draft) => { draft.rewrite.versions.unshift({ id: versionId, label: `版本 ${draft.rewrite.versions.length + 1}`, createdAt: new Date().toISOString(), blocks: structuredClone(draft.rewrite.blocks), glossary: structuredClone(draft.rewrite.glossary) }); });
    selectedVersionId = versionId;
    return;
  }
  if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
    const list = issues();
    if (!list.length) return;
    const current = Math.max(0, list.findIndex((issue) => issue.id === activeIssueId));
    const next = (current + (event.key.toLowerCase() === "j" ? 1 : -1) + list.length) % list.length;
    activeIssueId = list[next].id;
    activeBlockId = list[next].blockId;
    render();
  }
  if (event.key.toLowerCase() === "e") {
    const button = app.querySelector<HTMLElement>('[data-action="generate"]');
    button?.click();
  }
  if (event.key === "1") { previewMode = "normal"; render(); }
  if (event.key === "2") { previewMode = "assisted"; render(); }
});

render();
