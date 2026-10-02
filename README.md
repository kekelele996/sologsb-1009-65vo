# 教材无障碍改写工作台

面向教材编辑和特殊教育内容团队的无障碍改写、自动检查、审校与导出工具。项目预置科学教材章节示例并包含真实的待处理问题。

## 功能

- 导入 TXT、Markdown 章节文本；识别 Markdown 标题、图片和单行链接。
- 检查标题层级跳跃、图片替代文本缺失、链接文案不明确、长句和术语不一致。
- 将复杂段落按标点和语义拆为较短的易读表达，并统一术语表中的固定表达。
- 为每个内容块记录改写原因及待审核、已通过、需修改状态。
- 添加批注、回复和解决批注。
- 阅读预览可在普通模式和高对比、大字号辅助模式间切换。
- 以编号列表展示读屏软件从 H1 到正文、图片和链接的阅读顺序。
- 保存最多 10 个版本快照，并并排比较旧版和当前无障碍文本。
- 撤销/重做、自动保存、离线继续编辑。
- 导出完整无障碍 HTML：包含 `lang`、跳转正文链接、语义标题、图片 `alt`、描述性链接、键盘焦点样式和屏幕阅读器可读结构。
- 键盘操作：`J`/`K` 跳转问题，`E` 生成易读版本，`1`/`2` 切换预览模式，`Ctrl/Cmd+Z` 撤销，`Ctrl/Cmd+Shift+Z` 重做，`Ctrl/Cmd+S` 保存版本。

## 技术栈

- Astro 7 + TypeScript
- Shoelace Web Components
- 原生 DOM/CSS 与浏览器 `localStorage`
- 静态 HTML 构建、nginx 容器部署

## 开发

需要 Node.js 22.12 或更高版本。

```bash
npm install
npm run dev
```

## 检查与构建

```bash
npm run check
npm run build
npm run preview
```

`npm run build` 会先执行 Astro 类型/内容检查，再生成 `dist/` 静态产物。

## Docker

容器内 nginx 监听 `80`，宿主端口按根端口映射为 `10009`。

```bash
docker build -t sologsb-1009 .
docker run --rm -p 10009:80 sologsb-1009
```

访问 `http://localhost:10009`。

## 数据说明

章节、改写原因、批注、术语和版本均保存在当前浏览器 `localStorage`。导出的 HTML 是独立文件，不依赖后端，但演示图片使用内嵌 SVG；接入真实教材时应替换为可访问的正式图片地址并复核替代文本。
