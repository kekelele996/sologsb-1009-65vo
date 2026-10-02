import "@shoelace-style/shoelace/dist/shoelace.js";
import {
  analyze,
  escapeHtml,
  exportHtml,
  simplifyText,
  uid,
  buildLiveBlocks,
  parkedEntries,
  type AccessibilityIssue,
  type JoinedBlock,
  type ReviewStatus,
  type RewriteEntry,
  type Severity,
} from "./model";
import {
  commitIngest,
  ingestNewSource,
  loadWorkspace,
  newComment,
  newReply,
  SAMPLE_NEW_EDITION,
  saveRewrite,
  type IngestJournal,
  type IngestStatus,
} from "./storage";

// ---------------------------------------------------------------------------
// 状态：原稿侧与改写侧两份文档各自持有
// ---------------------------------------------------------------------------

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Application root was not found");
const app: HTMLDivElement = rootElement;

const initial = loadWorkspace(localStorage, new Date().toISOString());
let source = initial.source;
let rewrite = initial.rewrite;
let notices: string[] = [...initial.notices];
let pendingJournal: IngestJournal | null = initial.journal;

let activeBlockId = source.blocks[0]?.id ?? "";
let view: "live" | "parked" = "live";
let activeParkedId = "";
let activeIssueId = "";
let previewMode: "normal" | "assisted" = "normal";
let selectedVersionId = "";
let showGlossary = false;
let showIngest = false;
let showReport = false;
let ingestBusy = false;
let ingestError = "";
let ingestResume = false;

interface WorkspaceSnapshot {
  source: typeof source;
  rewrite: typeof rewrite;
}
let undoStack: WorkspaceSnapshot[] = [];
let redoStack: WorkspaceSnapshot[] = [];
let saveTimer = 0;

const blocks = (): JoinedBlock[] => buildLiveBlocks(source, rewrite);
const activeItem = (): JoinedBlock | undefined => blocks().find((item) => item.block.id === activeBlockId) ?? blocks()[0];
const activeParked = (): RewriteEntry | undefined =>
  parkedEntries(rewrite).find((entry) => entry.id === activeParkedId) ?? parkedEntries(rewrite)[0];
const issues = (): AccessibilityIssue[] => analyze(blocks(), rewrite.glossary);

function saveRewriteSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const result = saveRewrite(localStorage, rewrite);
    if (!result.ok) notices.push(`改写侧自动保存失败：${result.error}。内容仍在本页，可稍后重试。`);
  }, 320);
}

/** 编辑操作只改改写侧；原稿侧永远不在这里被写入。 */
function commitRewrite(label: string, update: (draft: typeof rewrite) => void, renderAfter = true) {
  undoStack = [...undoStack.slice(-49), { source: structuredClone(source), rewrite: structuredClone(rewrite) }];
  redoStack = [];
  const draft = structuredClone(rewrite);
  update(draft);
  draft.updatedAt = new Date().toISOString();
  rewrite = draft;
  document.documentElement.dataset.lastAction = label;
  saveRewriteSoon();
  if (renderAfter) render();
}

function undo() {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack = [{ source: structuredClone(source), rewrite: structuredClone(rewrite) }, ...redoStack].slice(0, 50);
  source = previous.source;
  rewrite = previous.rewrite;
  if (!blocks().some((item) => item.block.id === activeBlockId)) activeBlockId = blocks()[0]?.block.id ?? "";
  saveRewriteSoon();
  render();
}

function redo() {
  const next = redoStack.shift();
  if (!next) return;
  undoStack = [...undoStack.slice(-49), { source: structuredClone(source), rewrite: structuredClone(rewrite) }];
  source = next.source;
  rewrite = next.rewrite;
  saveRewriteSoon();
  render();
}

function updateActiveEntry(update: (entry: RewriteEntry) => void, label = "修改改写稿") {
  const item = activeItem();
  if (!item) return;
  const blockId = item.block.id;
  commitRewrite(label, (draft) => {
    const entry = draft.entries.find((candidate) => candidate.sourceId === blockId && candidate.state === "live");
    if (entry) update(entry);
  });
}

// ---------------------------------------------------------------------------
// 接入新版原稿（两侧分别提交，失败按侧重试）
// ---------------------------------------------------------------------------

function applyIngestStatus(status: IngestStatus) {
  if (status.ok) {
    // 提交完成后重新读取两侧，保证界面与存储一致。
    const workspace = loadWorkspace(localStorage, new Date().toISOString());
    source = workspace.source;
    rewrite = workspace.rewrite;
    pendingJournal = workspace.journal;
    showIngest = false;
    showReport = true;
    ingestError = "";
    ingestResume = false;
    ingestBusy = false;
    activeBlockId = source.blocks[0]?.id ?? "";
    activeIssueId = "";
    document.documentElement.dataset.lastAction = "已接入新版原稿";
    render();
    return;
  }
  ingestBusy = false;
  ingestError = status.error;
  ingestResume = status.resumeAvailable;
  pendingJournal = loadWorkspace(localStorage, new Date().toISOString()).journal;
  if (status.stage === "parse") notices.push(status.error);
  render();
}

function runIngest(text: string, edition: string) {
  ingestBusy = true;
  ingestError = "";
  render();
  // 让按钮的 loading 状态先画出来。
  requestAnimationFrame(() => {
    applyIngestStatus(ingestNewSource(localStorage, source, rewrite, { text, edition }, new Date().toISOString()));
  });
}

function retryPendingSide() {
  ingestBusy = true;
  render();
  requestAnimationFrame(() => applyIngestStatus(commitIngest(localStorage)));
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

function blockRoleType(type: JoinedBlock["block"]["type"]) {
  if (type === "heading") return "标题";
  if (type === "image") return "图片 / 替代文本";
  if (type === "link") return "链接";
  return "正文段落";
}

function blockRole(item: JoinedBlock) {
  if (item.block.type === "heading") return `H${item.block.headingLevel ?? 2} 标题`;
  return blockRoleType(item.block.type);
}

function statusLabel(status: ReviewStatus) {
  if (status === "approved") return "已通过";
  if (status === "needs-work") return "需修改";
  return "待改写";
}

function severityLabel(severity: Severity) {
  if (severity === "error") return "必须修复";
  if (severity === "warning") return "建议优化";
  return "一致性提醒";
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

function saveVersionSnapshot(label: string) {
  const versionId = uid("version");
  commitRewrite("保存版本快照", (draft) => {
    draft.versions.unshift({
      id: versionId,
      label,
      createdAt: new Date().toISOString(),
      sourceEdition: source.edition,
      entries: blocks().map((item) => ({
        sourceId: item.block.id,
        sourceText: item.block.text,
        accessibleText: item.entry.accessibleText,
        changeReason: item.entry.changeReason,
        conclusion: item.entry.conclusion,
        reviewStatus: item.entry.reviewStatus,
      })),
      glossary: structuredClone(draft.glossary),
    });
    draft.versions = draft.versions.slice(0, 10);
  });
  selectedVersionId = versionId;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  const list = issues();
  const item = activeItem();
  const parked = parkedEntries(rewrite);
  const activeIssues = item ? list.filter((issue) => issue.blockId === item.block.id) : [];
  const approved = blocks().filter((block) => block.entry.reviewStatus === "approved" && !block.entry.stale).length;
  const staleCount = blocks().filter((block) => block.entry.stale).length;
  const version = rewrite.versions.find((candidate) => candidate.id === selectedVersionId) ?? rewrite.versions[0];

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span>无障碍</span><b>1009</b></div>
        <div class="title-block">
          <input id="project-title" aria-label="改写稿名称" value="${escapeHtml(rewrite.title)}" />
          <div class="meta">
            <span>原稿：${escapeHtml(source.title || "未命名")}（${escapeHtml(source.edition)}）</span>
            <span>${escapeHtml(source.subject)}</span><span>${escapeHtml(source.grade)}</span>
            <span class="save-dot">两侧分离 · 本地自动保存改写侧</span>
          </div>
        </div>
        <div class="top-actions">
          <span class="online-pill">${navigator.onLine ? "在线" : "离线可编辑"}</span>
          <sl-button size="small" variant="default" ${undoStack.length ? "" : "disabled"} data-action="undo">撤销</sl-button>
          <sl-button size="small" variant="default" ${redoStack.length ? "" : "disabled"} data-action="redo">重做</sl-button>
          <sl-button size="small" variant="default" data-action="glossary">术语表</sl-button>
          <sl-button size="small" variant="warning" outline data-action="open-ingest">接入新版原稿</sl-button>
          <sl-button size="small" variant="primary" data-action="save-version">保存版本</sl-button>
          <sl-button size="small" variant="success" data-action="export">导出无障碍 HTML</sl-button>
        </div>
      </header>

      ${pendingJournal ? renderResumeBanner() : ""}
      ${notices.length ? renderNotices() : ""}

      <div class="progress-strip">
        <div class="progress-copy"><b>${approved}/${blocks().length}</b><span>块已重新核对通过</span></div>
        <div class="progress-bar"><i style="width:${Math.round((approved / Math.max(1, blocks().length)) * 100)}%"></i></div>
        <div class="issue-counts">
          ${staleCount ? `<span class="stale">${staleCount} 块原稿已改 · 待重写</span>` : ""}
          <span class="error">${list.filter((issue) => issue.severity === "error").length} 必须修复</span>
          <span class="warning">${list.filter((issue) => issue.severity === "warning").length} 建议优化</span>
          <span class="info">${list.filter((issue) => issue.severity === "info").length} 术语提醒</span>
        </div>
      </div>

      <div class="workspace">
        <aside class="outline-panel">
          <div class="panel-title"><span>原稿结构（出版社版）</span><sl-badge>${blocks().length} 块</sl-badge></div>
          <div class="block-list">
            ${blocks().map((joined, index) => {
              const blockIssues = list.filter((issue) => issue.blockId === joined.block.id);
              return `<button class="block-item ${joined.block.id === activeBlockId && view === "live" ? "active" : ""}" data-action="select-block" data-block-id="${joined.block.id}">
                <span class="block-order">${index + 1}</span>
                <span class="block-copy"><b>${joined.block.type === "heading" ? `H${joined.block.headingLevel}` : blockRoleType(joined.block.type)}${joined.entry.stale ? " · 原稿已改" : ""}</b><span>${escapeHtml(joined.entry.accessibleText || joined.block.text || "（空）")}</span></span>
                <i class="status-${joined.entry.reviewStatus} ${joined.entry.stale ? "stale" : ""}" title="${joined.entry.stale ? "原稿文字动过，已退回待改写" : statusLabel(joined.entry.reviewStatus)}"></i>
                ${blockIssues.length ? `<em>${blockIssues.length}</em>` : ""}
              </button>`;
            }).join("")}
          </div>
          <sl-button class="import-button" variant="warning" outline data-action="open-ingest">接入新版原稿（TXT / Markdown）</sl-button>

          <div class="parked-head ${parked.length ? "has-items" : ""}">
            <span>原稿已去掉 · 改写留档</span><sl-badge variant="neutral">${parked.length}</sl-badge>
          </div>
          ${parked.length ? `<div class="parked-list">${parked.map((entry) => `
            <button class="parked-item ${entry.id === activeParkedId && view === "parked" ? "active" : ""}" data-action="select-parked" data-entry-id="${entry.id}">
              <b>${blockRoleType(entry.parkedSource?.type ?? "paragraph")}</b><span>${escapeHtml(entry.parkedSource?.text ?? "（原文缺失）")}</span>
            </button>`).join("")}</div>` : `<div class="parked-empty">新版去掉的块，旧改写会自动挪到这里对照。</div>`}

          <div class="keyboard-note"><b>键盘</b><span><kbd>J</kbd><kbd>K</kbd> 跳转问题</span><span><kbd>E</kbd> 自动改写</span><span><kbd>⌘ Z</kbd> 撤销</span><span><kbd>1</kbd><kbd>2</kbd> 预览模式</span></div>
        </aside>

        <main class="editor-panel">
          ${view === "parked" ? renderParkedEditor() : item ? renderLiveEditor(item, activeIssues) : `<div class="issue-clear">原稿还没有内容块，请先接入出版社原稿。</div>`}
        </main>

        <aside class="review-panel">
          <section class="preview-card">
            <div class="section-heading"><div><span class="eyebrow">Reader preview</span><h2>阅读预览</h2></div><div class="mode-switch"><button class="${previewMode === "normal" ? "active" : ""}" data-action="preview-normal">普通</button><button class="${previewMode === "assisted" ? "active" : ""}" data-action="preview-assisted">辅助</button></div></div>
            <div class="reader-preview mode-${previewMode}">${renderPreview()}</div>
          </section>

          <section class="order-card">
            <div class="section-heading"><div><span class="eyebrow">Screen reader order</span><h2>读屏阅读顺序</h2></div><sl-badge>从上到下</sl-badge></div>
            <ol class="reading-order">
              ${blocks().map((joined, index) => `<li class="${joined.block.id === activeBlockId && view === "live" ? "active" : ""}"><b>${index + 1}</b><div><strong>${blockRole(joined)}</strong><span>${escapeHtml(joined.entry.accessibleText || joined.block.text || "（无内容）")}</span></div></li>`).join("")}
            </ol>
          </section>

          <section class="issues-panel">
            <div class="section-heading"><div><span class="eyebrow">All checks</span><h2>全章问题</h2></div></div>
            <div class="issue-list">
              ${list.length ? list.map((issue) => `<button class="${issue.id === activeIssueId ? "active" : ""} ${issue.severity}" data-action="jump-issue" data-issue-id="${issue.id}" data-block-id="${issue.blockId}"><span>${severityLabel(issue.severity)}</span><b>${escapeHtml(issue.title)}</b><small>段 ${source.blocks.findIndex((block) => block.id === issue.blockId) + 1} · ${escapeHtml(issue.suggestion)}</small></button>`).join("") : `<div class="issue-clear">✓ 全章检查通过</div>`}
            </div>
          </section>

          <section class="version-card">
            <div class="section-heading"><div><span class="eyebrow">Version compare</span><h2>版本比较</h2></div><sl-badge>${rewrite.versions.length} 版</sl-badge></div>
            ${rewrite.versions.length ? `
              <sl-select id="version-select" size="small" value="${version?.id ?? ""}">${rewrite.versions.map((candidate) => `<sl-option value="${candidate.id}">${escapeHtml(candidate.label)} · ${new Date(candidate.createdAt).toLocaleTimeString()}</sl-option>`).join("")}</sl-select>
              <div class="version-diff">${item && version ? renderVersionDiff(version, item) : ""}</div>
            ` : `<div class="empty-note">保存版本后，可按块比较改写前后；版本按原稿块内容编号，段落挪动仍可对照。</div>`}
          </section>
        </aside>
      </div>

      <footer class="statusbar"><span>最近操作：${escapeHtml(document.documentElement.dataset.lastAction || "两侧数据已载入")}</span><span>原稿 ${source.blocks.length} 块 · 留档 ${parked.length} 块 · ${list.length} 个待处理问题</span></footer>
    </div>

    ${renderIngestDialog()}
    ${renderReportDialog()}

    <sl-dialog label="全书术语表" ${showGlossary ? "open" : ""} data-dialog="glossary">
      <div class="glossary-editor">
        ${rewrite.glossary.map((term) => `<div class="term-row"><div><b>${escapeHtml(term.source)}</b><sl-input size="small" value="${escapeHtml(term.preferred)}" data-term-id="${term.id}"></sl-input><small>${escapeHtml(term.note)}</small></div><sl-button size="small" variant="danger" outline data-action="remove-term" data-term-id="${term.id}">删除</sl-button></div>`).join("")}
      </div>
      <div class="term-add"><sl-input id="new-term-source" placeholder="原文术语"></sl-input><sl-input id="new-term-preferred" placeholder="统一表达"></sl-input><sl-button variant="primary" data-action="add-term">添加术语</sl-button></div>
      <sl-button slot="footer" variant="primary" data-action="close-glossary">完成</sl-button>
    </sl-dialog>`;

  wireLiveFields();
}

function renderResumeBanner() {
  const stage = pendingJournal?.stage === "pending-source" ? "原稿侧" : "改写侧";
  return `<div class="resume-banner">
    <b>上次接入新版原稿（${escapeHtml(pendingJournal?.edition ?? "")}）在${stage}中断</b>
    <span>编辑已写好的内容没有丢失。接入日志保留了对接结果，可以只重试${stage}。</span>
    <sl-button size="small" variant="warning" data-action="retry-ingest" ${ingestBusy ? "loading" : ""}>按侧重试（${stage}）</sl-button>
    <sl-button size="small" variant="text" data-action="dismiss-journal">先不处理</sl-button>
  </div>`;
}

function renderNotices() {
  return `<div class="notice-banner">
    ${notices.map((notice, index) => `<div class="notice-row"><span>⚠ ${escapeHtml(notice)}</span><button data-action="dismiss-notice" data-index="${index}" aria-label="关闭提示">×</button></div>`).join("")}
  </div>`;
}

function renderLiveEditor(item: JoinedBlock, activeIssues: AccessibilityIssue[]) {
  const block = item.block;
  const entry = item.entry;
  const oldRevision = entry.history[entry.history.length - 1];
  return `
          <div class="editor-head">
            <div><span class="eyebrow">当前内容块 · ${escapeHtml(source.edition)}</span><h1>${blockRole(item)}</h1></div>
            <div class="review-actions">
              <sl-button size="small" variant="${entry.reviewStatus === "approved" ? "success" : "default"}" data-action="approve" ${entry.stale ? "disabled" : ""}>${entry.reviewStatus === "approved" ? "✓ 已通过" : "审核通过"}</sl-button>
              <sl-button size="small" variant="${entry.reviewStatus === "needs-work" ? "danger" : "default"}" data-action="needs-work">需修改</sl-button>
            </div>
          </div>

          ${entry.stale ? `<div class="stale-banner">
            <b>原稿文字动过，本块已退回待改写，原「已通过」作废。</b>
            <span>旧改写保留在下方和改写历史中，改完并审核通过后标记才会恢复。</span>
          </div>` : ""}

          ${activeIssues.length ? `<div class="active-issues">${activeIssues.map((issue) => `
            <div class="issue-card ${issue.severity}">
              <div><sl-badge variant="${issue.severity === "error" ? "danger" : issue.severity === "warning" ? "warning" : "primary"}">${severityLabel(issue.severity)}</sl-badge><strong>${escapeHtml(issue.title)}</strong></div>
              <p>${escapeHtml(issue.detail)}</p><small>${escapeHtml(issue.suggestion)}</small>
            </div>`).join("")}</div>` : `<div class="issue-clear">✓ 当前内容块没有新的无障碍问题</div>`}

          <section class="edit-card source-card">
            <div class="section-heading"><div><span class="eyebrow">出版社原稿（只读）</span><h2>${block.type === "image" ? "图片信息" : block.type === "link" ? "链接信息" : "原文"}</h2></div><sl-badge variant="neutral">${block.type}</sl-badge></div>
            ${renderSourceView(block)}
          </section>

          ${oldRevision ? `<section class="edit-card history-card">
            <div class="section-heading"><div><span class="eyebrow">旧版对照（原稿更新前）</span><h2>旧改写留档</h2></div><sl-badge variant="warning">原状态：${statusLabel(oldRevision.reviewStatus)}</sl-badge></div>
            <div class="history-grid">
              <div><span>旧原文</span><p>${escapeHtml(oldRevision.sourceSnapshot.text)}</p></div>
              <div class="new"><span>现原文</span><p>${escapeHtml(block.text)}</p></div>
              <div class="old-rewrite"><span>旧改写（仅供对照）</span><p>${escapeHtml(oldRevision.accessibleText || "（空）")}</p></div>
              <div><span>旧改写原因</span><p>${escapeHtml(oldRevision.changeReason || "（未填写）")}</p></div>
            </div>
          </section>` : ""}

          <section class="edit-card rewrite-card">
            <div class="section-heading">
              <div><span class="eyebrow">Accessible rewrite · 编辑侧</span><h2>无障碍表达</h2></div>
              <sl-button size="small" variant="primary" outline data-action="generate">生成易读版本</sl-button>
            </div>
            ${renderAccessibleEditor(item)}
            <label class="field-label" for="reason-${block.id}">改写原因（每处改写必须记录）</label>
            <sl-textarea id="reason-${block.id}" data-field="reason" rows="2" value="${escapeHtml(entry.changeReason)}" placeholder="例如：拆分长句、替换专业表达、补充链接目的"></sl-textarea>
            <label class="field-label" for="conclusion-${block.id}">改写结论</label>
            <sl-textarea id="conclusion-${block.id}" data-field="conclusion" rows="2" value="${escapeHtml(entry.conclusion)}" placeholder="例如：已拆成三个短句，术语已统一，顺序与原文一致。"></sl-textarea>
          </section>

          <section class="edit-card">
            <div class="section-heading"><div><span class="eyebrow">Review discussion</span><h2>批注与回复</h2></div><sl-badge variant="warning">${entry.comments.length} 条</sl-badge></div>
            <div class="comment-compose"><sl-textarea id="new-comment" rows="2" placeholder="记录改写依据、审核意见或术语讨论…"></sl-textarea><sl-button size="small" variant="primary" data-action="add-comment">添加批注</sl-button></div>
            <div class="comment-list">
              ${entry.comments.length ? entry.comments.map((comment) => `
                <article class="comment ${comment.resolved ? "resolved" : ""}">
                  <header><b>${escapeHtml(comment.author)}</b><time>${new Date(comment.createdAt).toLocaleString()}</time></header>
                  <p>${escapeHtml(comment.body)}</p>
                  ${comment.replies.map((reply) => `<div class="reply"><b>${escapeHtml(reply.author)}</b><span>${escapeHtml(reply.body)}</span></div>`).join("")}
                  <div class="reply-row"><sl-input size="small" id="reply-${comment.id}" placeholder="回复…"></sl-input><sl-button size="small" data-action="reply" data-comment-id="${comment.id}">回复</sl-button><sl-button size="small" variant="text" data-action="resolve-comment" data-comment-id="${comment.id}">${comment.resolved ? "重新打开" : "解决"}</sl-button></div>
                </article>`).join("") : `<div class="empty-note">当前内容块还没有批注。</div>`}
            </div>
          </section>`;
}

function renderParkedEditor() {
  const entry = activeParked();
  if (!entry) return `<div class="issue-clear">没有留档的改写。</div>`;
  const parked = entry.parkedSource;
  return `
          <div class="editor-head">
            <div><span class="eyebrow">原稿已去掉 · 改写留档</span><h1>${blockRoleType(parked?.type ?? "paragraph")}</h1></div>
            <sl-button size="small" variant="default" data-action="back-live">回到当前原稿</sl-button>
          </div>
          <div class="stale-banner parked"><b>这块在新版原稿中已不存在。</b><span>改写原因、结论和批注原样留档对照，不会进入导出的无障碍 HTML；若出版社恢复该块，接入时会自动重新对上。</span></div>
          <section class="edit-card source-card">
            <div class="section-heading"><div><span class="eyebrow">当时的出版社原稿</span><h2>原文快照</h2></div></div>
            ${parked ? renderSourceView(parked) : "<p>原稿快照缺失。</p>"}
          </section>
          <section class="edit-card history-card">
            <div class="section-heading"><div><span class="eyebrow">编辑侧留档</span><h2>旧改写</h2></div><sl-badge variant="neutral">${statusLabel(entry.reviewStatus)}</sl-badge></div>
            <div class="history-grid">
              <div class="old-rewrite"><span>无障碍表达</span><p>${escapeHtml(entry.accessibleText || "（空）")}</p></div>
              <div><span>改写原因</span><p>${escapeHtml(entry.changeReason || "（未填写）")}</p></div>
              <div><span>改写结论</span><p>${escapeHtml(entry.conclusion || "（未填写）")}</p></div>
            </div>
            ${entry.comments.length ? `<div class="comment-list" style="margin-top:10px">${entry.comments.map((comment) => `<article class="comment ${comment.resolved ? "resolved" : ""}"><header><b>${escapeHtml(comment.author)}</b><time>${new Date(comment.createdAt).toLocaleString()}</time></header><p>${escapeHtml(comment.body)}</p></article>`).join("")}</div>` : ""}
          </section>`;
}

function renderSourceView(block: JoinedBlock["block"]) {
  if (block.type === "image") {
    return `<div class="image-source"><img src="${escapeHtml(block.imageSrc ?? "")}" alt="" /><div><b>图注</b><p>${escapeHtml(block.text)}</p><b>出版社提供的替代文本</b><p>${escapeHtml(block.imageAlt || "（空，需编辑补写）")}</p></div></div>`;
  }
  if (block.type === "link") {
    return `<div class="source-readonly"><b>链接文案</b><p>${escapeHtml(block.text)}</p><b>链接地址</b><p>${escapeHtml(block.linkHref ?? "")}</p></div>`;
  }
  if (block.type === "heading") {
    return `<div class="source-readonly"><b>标题层级 H${block.headingLevel ?? 2}</b><p>${escapeHtml(block.text)}</p></div>`;
  }
  return `<div class="source-readonly"><p>${escapeHtml(block.text)}</p></div>`;
}

function renderAccessibleEditor(item: JoinedBlock) {
  const block = item.block;
  if (block.type === "image") {
    return `<sl-textarea id="accessible-${block.id}" data-field="accessible" rows="3" label="图片替代文本" value="${escapeHtml(item.entry.accessibleText || block.imageAlt || "")}" help-text="读屏软件会朗读这里的内容。"></sl-textarea>`;
  }
  return `<sl-textarea id="accessible-${block.id}" data-field="accessible" rows="6" value="${escapeHtml(item.entry.accessibleText)}"></sl-textarea>`;
}

function renderPreview() {
  return blocks().map((item, index) => {
    const block = item.block;
    const content = escapeHtml(item.entry.accessibleText || block.text);
    const activeClass = block.id === activeBlockId && view === "live" ? "active-block" : "";
    if (block.type === "heading") {
      const tag = `h${Math.min(6, Math.max(1, block.headingLevel ?? 2))}`;
      return `<${tag} class="${activeClass}"><span class="order-marker">${index + 1}</span>${content}</${tag}>`;
    }
    if (block.type === "image") {
      return `<figure class="${activeClass}"><img src="${escapeHtml(block.imageSrc ?? "")}" alt="${escapeHtml(item.entry.accessibleText || block.imageAlt || "")}"><figcaption><span class="order-marker">${index + 1}</span>${escapeHtml(block.text)}</figcaption></figure>`;
    }
    if (block.type === "link") {
      return `<p class="${activeClass}"><span class="order-marker">${index + 1}</span><a href="${escapeHtml(block.linkHref ?? "#")}" onclick="return false">${content}</a><span class="link-role">链接</span></p>`;
    }
    return `<p class="${activeClass}"><span class="order-marker">${index + 1}</span>${content}</p>`;
  }).join("");
}

function renderVersionDiff(version: { entries: { sourceId: string; accessibleText: string; sourceText: string }[] }, current: JoinedBlock) {
  const oldEntry = version.entries.find((candidate) => candidate.sourceId === current.block.id);
  if (!oldEntry) return `<div class="empty-note">当前内容块在保存该版本时尚不存在，或来自更新的原稿版本。</div>`;
  return `<div class="diff-column"><span>旧版改写</span><p>${escapeHtml(oldEntry.accessibleText || oldEntry.sourceText)}</p></div><div class="diff-column current"><span>当前改写</span><p>${escapeHtml(current.entry.accessibleText || current.block.text)}</p></div>`;
}

function renderIngestDialog() {
  return `<sl-dialog label="接入新版原稿" ${showIngest ? "open" : ""} class="ingest-dialog">
    <div class="ingest-body">
      <p class="ingest-hint">新版原稿只从这里接入，接入时按内容逐块对接：<b>接得上</b>的沿用原改写（含已通过）；<b>文字动过</b>的退回待改写并保留旧改写对照；<b>去掉</b>的块挪到留档区；<b>新加</b>的按待改写进入。编辑已写的原因、结论、批注不会丢。</p>
      <label class="field-label" for="ingest-edition">出版社版本名称</label>
      <sl-input id="ingest-edition" placeholder="例如：2026 秋修订版" value=""></sl-input>
      <label class="field-label" for="ingest-text">粘贴新版章节文本（TXT / Markdown）</label>
      <sl-textarea id="ingest-text" rows="9" placeholder="支持 Markdown 标题 #、图片 ![alt](url)、单行链接 [文案](地址)"></sl-textarea>
      <div class="ingest-row">
        <sl-button size="small" variant="default" data-action="ingest-file">选择文件…</sl-button>
        <sl-button size="small" variant="text" data-action="ingest-sample">填入演示新版（含挪动/改动/删除/新增）</sl-button>
        <input id="ingest-file-input" type="file" accept=".txt,.md,.markdown" hidden />
      </div>
      ${ingestError ? `<div class="ingest-error"><b>接入未完成：</b>${escapeHtml(ingestError)}</div>` : ""}
    </div>
    <sl-button slot="footer" variant="default" data-action="close-ingest">取消</sl-button>
    ${ingestResume ? `<sl-button slot="footer" variant="warning" data-action="retry-ingest" ${ingestBusy ? "loading" : ""}>按侧重试未完成的提交</sl-button>` : ""}
    <sl-button slot="footer" variant="primary" data-action="confirm-ingest" ${ingestBusy ? "loading" : ""}>开始逐块对接</sl-button>
  </sl-dialog>`;
}

function renderReportDialog() {
  const report = rewrite.lastJoinReport;
  if (!showReport || !report) return "";
  const labels: Record<string, string> = {
    reused: "沿用原改写",
    changed: "原稿已改 · 待重写",
    added: "新加 · 待改写",
    removed: "去掉 · 已留档",
  };
  return `<sl-dialog label="新版原稿接入结果" open>
    <div class="report-head">
      <div><b>${escapeHtml(report.edition)}</b><span>${new Date(report.importedAt).toLocaleString()}</span></div>
    </div>
    <div class="report-counts">
      <span class="reused">${report.reused} 沿用</span>
      <span class="changed">${report.changed} 改动</span>
      <span class="added">${report.added} 新增</span>
      <span class="removed">${report.removed} 去掉</span>
    </div>
    <ol class="report-list">
      ${report.items.map((line) => `<li class="${line.outcome}"><b>${labels[line.outcome]}</b><span>${escapeHtml(line.sourceText)}</span>${line.previousAccessibleText && line.outcome !== "reused" ? `<small>旧改写：${escapeHtml(line.previousAccessibleText)}</small>` : ""}</li>`).join("")}
    </ol>
    <sl-button slot="footer" variant="primary" data-action="close-report">开始改写</sl-button>
  </sl-dialog>`;
}

// ---------------------------------------------------------------------------
// 表单绑定
// ---------------------------------------------------------------------------

function wireLiveFields() {
  app.querySelectorAll<HTMLElement>("sl-input[data-field], sl-textarea[data-field]").forEach((element) => {
    // 输入过程中不重绘，避免每次击键丢焦点；状态照常更新并自动保存。
    element.addEventListener("sl-input", () => {
      const value = (element as HTMLElement & { value: string }).value;
      updateActiveEntryLive((entry) => {
        const field = element.dataset.field;
        if (field === "accessible") entry.accessibleText = value;
        if (field === "reason") entry.changeReason = value;
        if (field === "conclusion") entry.conclusion = value;
        // 编辑动手改了改写内容，即视为已按新原稿重新处理，stale 解除；仍需重新审核通过。
        if (field === "accessible" || field === "reason" || field === "conclusion") {
          entry.stale = false;
          entry.reviewStatus = "pending";
        }
      }, "编辑改写内容");
    });
    // 失焦/回车后重绘一次，让状态点、问题列表等同步。
    element.addEventListener("sl-change", () => render());
  });
}

function updateActiveEntryLive(update: (entry: RewriteEntry) => void, label: string) {
  const item = activeItem();
  if (!item) return;
  const blockId = item.block.id;
  commitRewrite(label, (draft) => {
    const entry = draft.entries.find((candidate) => candidate.sourceId === blockId && candidate.state === "live");
    if (entry) update(entry);
  }, false);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "undo") return undo();
  if (action === "redo") return redo();
  if (action === "select-block") {
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    view = "live";
    activeIssueId = "";
    return render();
  }
  if (action === "select-parked") {
    activeParkedId = target.dataset.entryId ?? activeParkedId;
    view = "parked";
    return render();
  }
  if (action === "back-live") {
    view = "live";
    return render();
  }
  if (action === "jump-issue") {
    activeIssueId = target.dataset.issueId ?? "";
    activeBlockId = target.dataset.blockId ?? activeBlockId;
    view = "live";
    render();
    requestAnimationFrame(() => app.querySelector<HTMLElement>(".editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    return;
  }
  if (action === "generate") {
    const item = activeItem();
    if (!item) return;
    const suggestion = item.block.type === "link"
      ? "打开水循环互动实验"
      : simplifyText(item.block.type === "image" ? item.block.imageAlt || item.block.text : item.block.text, rewrite.glossary);
    updateActiveEntry((entry) => {
      entry.accessibleText = suggestion;
      entry.changeReason ||= "原稿换版后重新生成：拆分长句并替换复杂表达，保留原有知识信息。";
      entry.stale = false;
      entry.reviewStatus = "pending";
    }, "生成易读版本");
    return;
  }
  if (action === "approve") {
    updateActiveEntry((entry) => {
      if (entry.stale) return; // 原稿动过的块不算通过
      entry.reviewStatus = "approved";
    }, "审核通过");
    return;
  }
  if (action === "needs-work") {
    updateActiveEntry((entry) => { entry.reviewStatus = "needs-work"; }, "标记需修改");
    return;
  }
  if (action === "add-comment") {
    const input = app.querySelector<HTMLElement & { value: string }>("#new-comment");
    const body = input?.value.trim();
    if (body) updateActiveEntry((entry) => {
      entry.comments.unshift(newComment(body, "当前编辑", new Date().toISOString()));
    }, "添加批注");
    return;
  }
  if (action === "reply") {
    const commentId = target.dataset.commentId ?? "";
    const input = app.querySelector<HTMLElement & { value: string }>(`#reply-${CSS.escape(commentId)}`);
    const body = input?.value.trim();
    if (body) updateActiveEntry((entry) => {
      entry.comments.find((comment) => comment.id === commentId)?.replies.push(newReply(body, "当前编辑", new Date().toISOString()));
    }, "回复批注");
    return;
  }
  if (action === "resolve-comment") {
    const commentId = target.dataset.commentId ?? "";
    updateActiveEntry((entry) => {
      const comment = entry.comments.find((candidate) => candidate.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    }, "更新批注状态");
    return;
  }
  if (action === "preview-normal") { previewMode = "normal"; return render(); }
  if (action === "preview-assisted") { previewMode = "assisted"; return render(); }
  if (action === "glossary") { showGlossary = true; return render(); }
  if (action === "close-glossary") { showGlossary = false; return render(); }
  if (action === "add-term") {
    const sourceInput = app.querySelector<HTMLElement & { value: string }>("#new-term-source");
    const preferred = app.querySelector<HTMLElement & { value: string }>("#new-term-preferred");
    if (sourceInput?.value.trim() && preferred?.value.trim()) {
      commitRewrite("添加术语", (draft) => {
        draft.glossary.push({ id: uid("term"), source: sourceInput.value.trim(), preferred: preferred.value.trim(), note: "编辑新增术语" });
      });
    }
    return;
  }
  if (action === "remove-term") {
    const termId = target.dataset.termId;
    commitRewrite("删除术语", (draft) => { draft.glossary = draft.glossary.filter((term) => term.id !== termId); });
    return;
  }
  if (action === "save-version") {
    saveVersionSnapshot(`版本 ${rewrite.versions.length + 1}（${source.edition}）`);
    return;
  }
  if (action === "export") {
    download(`${rewrite.title}-无障碍版.html`, exportHtml(rewrite.title, blocks()));
    document.documentElement.dataset.lastAction = "已导出无障碍 HTML";
    return render();
  }
  // 接入新版原稿
  if (action === "open-ingest") {
    showIngest = true;
    ingestError = "";
    return render();
  }
  if (action === "close-ingest") {
    if (ingestBusy) return;
    showIngest = false;
    return render();
  }
  if (action === "ingest-file") {
    app.querySelector<HTMLInputElement>("#ingest-file-input")?.click();
    return;
  }
  if (action === "ingest-sample") {
    const textArea = app.querySelector<HTMLElement & { value: string }>("#ingest-text");
    const editionInput = app.querySelector<HTMLElement & { value: string }>("#ingest-edition");
    if (textArea) textArea.value = SAMPLE_NEW_EDITION;
    if (editionInput && !editionInput.value) editionInput.value = "2026 修订版（演示）";
    return;
  }
  if (action === "confirm-ingest") {
    const text = app.querySelector<HTMLElement & { value: string }>("#ingest-text")?.value ?? "";
    const edition = app.querySelector<HTMLElement & { value: string }>("#ingest-edition")?.value ?? "";
    if (!text.trim()) {
      ingestError = "没有读到新版原稿内容：请粘贴文本或选择文件。";
      return render();
    }
    runIngest(text, edition);
    return;
  }
  if (action === "retry-ingest") {
    retryPendingSide();
    return;
  }
  if (action === "dismiss-journal") {
    pendingJournal = null;
    return render();
  }
  if (action === "dismiss-notice") {
    const index = Number(target.dataset.index);
    notices = notices.filter((_, current) => current !== index);
    return render();
  }
  if (action === "close-report") {
    showReport = false;
    return render();
  }
});

app.addEventListener("sl-change", (event) => {
  const element = event.target as HTMLElement;
  if (element.id === "version-select") {
    selectedVersionId = (element as HTMLElement & { value: string }).value;
    render();
  }
  if (element.matches("[data-term-id]")) {
    const termId = element.dataset.termId;
    const value = (element as HTMLElement & { value: string }).value;
    commitRewrite("修改术语表", (draft) => {
      const term = draft.glossary.find((candidate) => candidate.id === termId);
      if (term) term.preferred = value;
    });
  }
});

app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== "ingest-file-input" || !input.files?.[0]) return;
  void input.files[0].text().then((text) => {
    if (!text.trim()) {
      ingestError = "文件读不出来：内容为空，编辑侧数据未做任何改动。";
      return render();
    }
    const textArea = app.querySelector<HTMLElement & { value: string }>("#ingest-text");
    const editionInput = app.querySelector<HTMLElement & { value: string }>("#ingest-edition");
    if (textArea) textArea.value = text;
    if (editionInput && !editionInput.value) {
      editionInput.value = input.files?.[0]?.name.replace(/\.(txt|md|markdown)$/i, "") ?? "导入版本";
    }
    ingestError = "";
    render();
  });
});

app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "project-title") {
    rewrite.title = input.value;
    saveRewriteSoon();
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
    saveVersionSnapshot(`版本 ${rewrite.versions.length + 1}（${source.edition}）`);
    return;
  }
  if (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k") {
    const list = issues();
    if (!list.length) return;
    const current = Math.max(0, list.findIndex((issue) => issue.id === activeIssueId));
    const next = (current + (event.key.toLowerCase() === "j" ? 1 : -1) + list.length) % list.length;
    activeIssueId = list[next].id;
    activeBlockId = list[next].blockId;
    view = "live";
    render();
    return;
  }
  if (event.key.toLowerCase() === "e") {
    app.querySelector<HTMLElement>('[data-action="generate"]')?.click();
    return;
  }
  if (event.key === "1") { previewMode = "normal"; render(); }
  if (event.key === "2") { previewMode = "assisted"; render(); }
});

render();
