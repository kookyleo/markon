<script setup>
import { withBase } from 'vitepress';

const groups = [
  {
    title: '舒适阅读',
    items: [
      {
        image: 'illustrations/01-rendering.svg',
        title: 'GitHub 风格渲染',
        desc: '原生 GitHub Markdown 样式：GFM 表格、任务列表、Alerts、Mermaid、40+ 语言语法高亮。',
      },
      {
        image: 'illustrations/12-chat.svg',
        title: '与文档对话',
        desc: '直接向文档发问，AI 引用原文回答，让长篇资料也能"问出来"。',
        link: '/features/chat',
      },
      {
        image: 'illustrations/02-search.svg',
        title: '全文搜索',
        desc: '基于 Tantivy 构建索引，支持中日英分词。浏览器中按 / 实时搜索全部 Markdown。',
        link: '/features/search',
      },
      {
        image: 'illustrations/08-print.svg',
        title: '章节打印',
        desc: '标题旁的打印按钮，仅打印当前章节内容，保持 GitHub 风格排版。',
        link: '/features/print',
      },
    ],
  },
  {
    title: '便捷协作',
    items: [
      {
        image: 'illustrations/05-annotate.svg',
        title: '注解与笔记',
        desc: 'Medium 风格三色高亮、删除线、便条笔记，支持侧边栏卡片或弹窗呈现。',
        link: '/features/annotations',
      },
      {
        image: 'illustrations/03-viewed.svg',
        title: '已读追踪',
        desc: '受 GitHub PR Review 启发，按段落标记进度，自动折叠已读章节，下次打开即恢复。',
        link: '/features/viewed',
      },
      {
        image: 'illustrations/06-live.svg',
        title: '实时协作 (Live)',
        desc: '以颜色为身份，主控 / 被控之间实时同步聚焦章节、文字选区、Viewed 勾选。',
        link: '/features/live',
      },
      {
        image: 'illustrations/04-edit.svg',
        title: '快捷编辑',
        desc: '按 e 直接在浏览器编辑 Markdown 源文件，左右双栏 + 滚动联动，Ctrl/Cmd+S 保存。',
        link: '/features/edit',
      },
    ],
  },
  {
    title: '多端覆盖',
    items: [
      {
        image: 'illustrations/11-platforms.svg',
        title: '全平台覆盖',
        desc: 'macOS · Windows · Linux 原生构建，arm64 / x86_64 同步发布；CLI 与 GUI 体验一致。',
      },
      {
        image: 'illustrations/09-desktop.svg',
        title: '桌面集成',
        desc: 'macOS 拖入 Finder 工具栏一键打开，Windows 右键菜单集成，系统托盘常驻。',
      },
      {
        image: 'illustrations/10-mobile.svg',
        title: '移动端友好',
        desc: '响应式设计，生成 QR 码方便扫码移动端查看。',
      },
      {
        image: 'illustrations/07-sync.svg',
        title: '多端同步',
        desc: '自动同步批注与已读状态，个人多设备或团队协同审阅，支持私有化部署。',
        link: '/advanced/shared-annotations',
      },
    ],
  },
];
</script>

<template>
  <section class="feature-gallery">
    <div v-for="(group, gi) in groups" :key="gi" class="group">
      <div class="group-title">{{ group.title }}</div>
      <div class="grid">
        <component
          :is="item.link ? 'a' : 'div'"
          v-for="(item, i) in group.items"
          :key="i"
          :href="item.link ? withBase(item.link) : undefined"
          class="card"
          :class="{ 'is-link': !!item.link }"
        >
          <div class="illustration">
            <img :src="withBase(item.image)" :alt="item.title" loading="lazy" />
          </div>
          <div class="body">
            <h3>{{ item.title }}</h3>
            <p>{{ item.desc }}</p>
          </div>
        </component>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Gallery sits inside .vp-doc.container which already provides max-width
   (1280px) and horizontal padding (64px). Don't double-pad — let the grid
   align with the code blocks / CTA blocks above and below. The hero already
   contributes ~64px padding-bottom, so a small extra margin is enough. */
.feature-gallery {
  margin: 8px 0 16px;
}

.group + .group {
  margin-top: 48px;
}

.group-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  letter-spacing: 0.04em;
  margin: 0 0 16px;
}

.group-title::before {
  content: '';
  display: inline-block;
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--vp-c-brand-1);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 20px;
}

.card {
  display: flex;
  flex-direction: column;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
  text-decoration: none;
  color: inherit;
}

.card.is-link {
  cursor: pointer;
}

.illustration {
  aspect-ratio: 1 / 1;
  background: #FAFAF7;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid var(--vp-c-divider);
}

.illustration img {
  width: 100%;
  height: 100%;
  display: block;
}

.body {
  padding: 14px 18px 18px;
}

.body h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 6px;
  line-height: 1.4;
}

.body p {
  font-size: 13px;
  color: var(--vp-c-text-2);
  line-height: 1.55;
  margin: 0;
}

@media (max-width: 640px) {
  .feature-gallery { margin: 4px 0 8px; }
  .group + .group { margin-top: 36px; }
  .grid { grid-template-columns: 1fr; gap: 14px; }
  .body { padding: 12px 16px 16px; }
}
</style>
