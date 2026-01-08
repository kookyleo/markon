# Markon 打印功能移动端兼容性修复

**文档版本**: 1.0
**创建日期**: 2026-01-08
**作者**: Technical Team
**状态**: 已实施混合方案

---

## 目录

- [问题背景](#问题背景)
- [症状描述](#症状描述)
- [根本原因分析](#根本原因分析)
- [技术调研](#技术调研)
- [iframe 方案的价值](#iframe-方案的价值)
- [CSS 方案评估](#css-方案评估)
- [解决方案设计](#解决方案设计)
- [实现细节](#实现细节)
- [测试指南](#测试指南)
- [后续计划](#后续计划)
- [参考资料](#参考资料)

---

## 问题背景

Markon 是一个轻量级 Markdown 渲染器，支持按章节打印功能。用户可以点击章节标题旁的 "Print" 按钮，打印单个章节而非整个文档。

该功能在桌面浏览器（Chrome、Firefox、Safari、Edge）上运行良好，但在移动设备上完全失效。

---

## 症状描述

### iPad Safari

1. **打印预览空白**
   - 点击 Print 按钮后，进入打印预览
   - 预览界面只显示底部的 footer，主体内容完全空白
   - 有时会先显示内容，但一闪而过后变成空白

2. **浏览器拦截警告**
   - 弹出 alert: `"This website has been blocked from automatically printing"`
   - 即使点击"允许"，打印功能仍然不稳定

### 移动端 Chrome (Android/iOS)

1. **打印整个页面而非章节**
   - 点击章节的 Print 按钮
   - 打印预览显示的是整个页面，而不是选中的章节
   - 包含了导航、TOC、所有章节等不应打印的内容

---

## 根本原因分析

通过深入调研，我们发现这是**移动浏览器对 iframe 打印的系统性限制**，而非代码实现问题。

### 移动端 Chrome 的已知 Bug

Chromium 官方 Bug Tracker 中有多个长期未修复的 issue：

- **Issue 40896385**: "iframe window.print() prints parent window"
- **Issue 41222716**: "Unable to print the content of an Iframe on Android"
- **Issue 561438**: "Unable to print the content of an Iframe on Android"

**核心问题**：在移动 Chrome（Android/iOS）上，调用 `iframe.contentWindow.print()` 会打印父页面而非 iframe 内容。

官方回复明确表示这是浏览器 API 差异，非短期能修复的问题。

### Safari 的自动打印拦截

iOS Safari 将非用户手势触发的 `print()` 调用视为"自动打印"并主动拦截，这是 WebKit 的安全特性：

- **Apple Developer Forums Thread 87624**: "Website was blocked for printing"
- **Apple Community Discussion**: 多个用户报告相同问题

即使我们优化了资源加载速度，由于 iframe 的创建、样式加载、内容注入都是异步操作，`print()` 调用不在原始点击事件的同步上下文中，Safari 仍会拦截。

### iframe onload 事件在移动端的问题

移动浏览器中，iframe 的 `onload` 事件行为不一致：

- 某些情况下，空白的 iframe 永远不会触发 `onload`
- 导致打印逻辑永远不会执行
- 这是移动浏览器的实现差异，无法通过代码规避

---

## 技术调研

### Print.js 库分析

我们调研了流行的打印库 [Print.js](https://github.com/crabbly/Print.js)，发现：

#### 实现方式

Print.js 使用的打印流程与我们的 iframe 方案**完全相同**：

```javascript
1. 创建 iframe 并添加到 DOM
2. 监听 iframe 的 onload 事件
3. 将可打印元素追加到 iframe 的 body
4. 注入样式到 iframe 的 head
5. 等待图片加载完成
6. 调用 iframe.contentWindow.print()
7. 清理 iframe
```

#### 浏览器检测

Print.js 的 `browser.js` 检测以下浏览器：
- Firefox
- Internet Explorer
- Edge
- Chrome
- Safari
- iOS Chrome

**但没有基于平台（移动/桌面）采取不同策略**，所有设备都使用相同的 iframe 打印流程。

#### 移动端问题

Print.js 在移动端有相同的失效问题：

- **Issue #415**: "It doesn't work on Chrome - Android"
  - 官方回复：*"Mobile browser support is currently weak due to different behavior between mobile and desktop browsers Api."*
  - 状态：已关闭，认为是浏览器限制

- **Issue #349**: "unable to print from the mobile browser chrome"
  - 技术分析：*"the `<iframe>` element is blank once inserted and so `onload` never fires"*
  - 关联了 Chromium Bug 979746
  - 状态：未解决（2020 年至今）

#### 结论

**Print.js 无法解决移动端问题**，因为：
1. 使用相同的 iframe 方案
2. 不区分移动/桌面平台
3. 官方承认移动端支持薄弱
4. 底层问题是浏览器限制，任何基于 iframe 的库都会遇到

---

## iframe 方案的价值

尽管 iframe 方案在移动端失效，但它在**桌面端仍是最优解**。

### iframe 方案解决的核心问题

#### 1. 避免打印主页面的复杂 UI 元素

主页面包含大量不应打印的交互元素：

```css
.section-print-btn         /* 打印按钮本身 */
.section-action            /* 章节操作按钮 */
.section-action-separator  /* 分隔符 */
.section-expand-toggle     /* 展开/折叠按钮 */
.viewed-checkbox-label     /* "已读"复选框 */
.toc                       /* 目录导航 */
#toc-container            /* 目录容器 */
.shortcuts-help-panel     /* 快捷键帮助面板 */
.selection-popover        /* 选择弹出层 */
.note-popup               /* 注释弹出层 */
header, .footer           /* 页眉页脚 */
```

如果在主页面打印，需要通过 CSS `@media print` 隐藏这些元素，存在：
- CSS 选择器复杂度高
- 可能遗漏新增的 UI 元素
- 样式优先级冲突

#### 2. 创建干净的打印文档结构

iframe 允许创建**完全独立的 HTML 文档**：

```javascript
doc.write(`<!DOCTYPE html><html><head>
<link rel="stylesheet" href="${themeCss}">
<link rel="stylesheet" href="/_/css/github-print.css">
<style>
  html, body { margin:0; padding:0; background: transparent !important; }
  .markdown-body { box-sizing: border-box; max-width: 980px; margin: 0 auto; }
</style>
</head><body><div class="markdown-body" id="root"></div></body></html>`);
```

**优势**：
- ✅ 只包含要打印的章节内容
- ✅ 独立的 CSS 上下文，不受主页面样式污染
- ✅ 可以自由定制打印样式（@page、页边距等）
- ✅ 不需要担心主页面的动态样式变化

#### 3. 保持主页面状态不变

打印时主页面的所有状态都不会改变：

```javascript
// 只克隆内容，不影响原始 DOM
const headingClone = heading.cloneNode(true);
content.forEach(el => {
    const clone = el.cloneNode(true);
    sectionContainer.appendChild(clone);
});
```

**避免的问题**：
- ❌ 在主页面操作 DOM 隐藏/显示元素 → 用户看到页面闪烁
- ❌ 改变滚动位置 → 打印后用户丢失阅读位置
- ❌ 改变章节展开/折叠状态 → 破坏用户的浏览状态
- ❌ 影响 viewed 复选框状态 → 数据混乱

#### 4. 独立的主题控制

打印时可以强制使用浅色主题，即使主页面是深色模式：

```javascript
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const themeCss = prefersDark ?
    '/_/css/github-markdown-dark.css' :
    '/_/css/github-markdown-light.css';
```

**好处**：
- 打印到纸张时使用浅色背景、深色文字（节省墨水）
- 不影响主页面的主题显示

#### 5. 桌面浏览器的最佳实践

在桌面浏览器上，iframe 打印是**成熟且可靠**的方案：
- Chrome/Firefox/Edge：完美支持
- Safari（桌面版）：支持良好
- 被广泛用于 PDF 预览、发票打印、报告生成等场景

---

## CSS 方案评估

我们详细评估了纯 CSS 方案能否替代 iframe 的所有功能。

### 功能对比矩阵

| 能力项 | iframe | CSS 方案 | 可行性 | 实现方式 |
|-------|--------|---------|--------|---------|
| 只打印选中章节 | ✅ | ✅ | **完全可行** | JS 动态标记 + CSS 隐藏 |
| 移除 UI 控件 | ✅ | ✅ | **完全可行** | @media print { display: none } |
| 保持主页面状态 | ✅ | ✅ | **完全可行** | beforeprint/afterprint 事件 |
| 独立 CSS 上下文 | ✅ | ⚠️ | **需要细致处理** | CSS !important 强制覆盖 |
| 强制打印主题 | ✅ | ✅ | **完全可行** | CSS 强制覆盖深色主题 |
| 移除特定元素 | ✅ | ✅ | **完全可行** | CSS 隐藏即可 |
| 无闪烁体验 | ✅ | ✅ | **完全可行** | beforeprint 事件保证 |
| 精确内容边界 | ✅ | ✅ | **完全可行** | JS 辅助标记范围 |
| **移动端兼容** | ❌ | ✅ | **最大优势** | CSS 方案无浏览器限制 |
| 代码复杂度 | 中等 | 低 | **更简洁** | 无需 iframe 管理 |

### 关键实现要点

#### 1. 打印内容标记

```javascript
// beforeprint 事件中标记
heading.classList.add('print-target');
content.forEach(el => el.classList.add('print-content'));
document.body.classList.add('printing-active');
```

#### 2. CSS 选择性显示

```css
@media print {
  /* 隐藏所有内容 */
  body.printing-active .markdown-body > * {
    display: none !important;
  }

  /* 只显示标记的内容 */
  body.printing-active .print-target,
  body.printing-active .print-content {
    display: block !important;
  }
}
```

#### 3. 无闪烁保证

`beforeprint` 事件在打印对话框打开前触发，用户看不到 DOM 变化：

```javascript
window.addEventListener('beforeprint', beforePrint);
window.addEventListener('afterprint', afterPrint);
window.print();
```

#### 4. 主题强制覆盖

```css
@media print {
  body.printing-active,
  body.printing-active .markdown-body,
  body.printing-active .markdown-body * {
    background: white !important;
    color: black !important;
  }
}
```

### 结论

✅ **纯 CSS 方案可以完全实现 iframe 的所有能力**

关键优势：
1. ✅ 功能完整性：通过 JS + CSS 配合，可以实现 iframe 的所有功能
2. ✅ 移动端兼容：彻底解决移动端打印问题
3. ✅ 代码更简洁：不需要创建 iframe、注入 HTML、等待资源加载
4. ✅ 性能更好：无异步等待，直接调用 window.print()

唯一需要注意：
- 需要细致的 CSS 样式重置（使用 `!important` 覆盖主题样式）
- 需要正确处理 `beforeprint`/`afterprint` 事件

---

## 解决方案设计

基于以上分析，我们采用**混合策略**：

### 方案架构

```
┌─────────────────────────────────────────────┐
│         printSection(headingId)             │
└─────────────┬───────────────────────────────┘
              │
              ▼
      ┌───────────────┐
      │ 检测设备类型   │
      └───┬───────┬───┘
          │       │
    移动设备      桌面设备
          │       │
          ▼       ▼
  ┌──────────┐  ┌──────────┐
  │ CSS 方案 │  │ iframe 方案│
  └──────────┘  └──────────┘
  • beforeprint  • 创建 iframe
  • 标记内容    • 注入 HTML
  • afterprint   • 等待资源
  • CSS 控制    • 调用 print
                • 清理 iframe
```

### 设备检测策略

```javascript
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
```

检测以下移动设备：
- Android
- iOS (iPhone, iPad, iPod)
- Windows Phone (IEMobile)
- BlackBerry
- Opera Mini

### 分支逻辑

```javascript
async printSection(headingId) {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isMobile) {
        // 移动端：CSS 方案
        return this.printSectionWithCSS(headingId);
    }

    // 桌面端：iframe 方案（保持现有实现）
    // ...
}
```

### 优势

| 方面 | 效果 |
|------|------|
| 桌面端体验 | ✅ 保持现有稳定的 iframe 方案 |
| 移动端兼容性 | ✅ 彻底解决打印问题 |
| 代码维护 | ✅ 两套独立逻辑，互不干扰 |
| 风险控制 | ✅ 渐进式迁移，降低风险 |
| 后续优化 | ✅ 移动端验证成熟后，可统一使用 CSS 方案 |

---

## 实现细节

### 1. JavaScript 实现

#### 设备检测与分发 (`viewed.js:297-311`)

```javascript
async printSection(headingId) {
    // Detect mobile devices
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    // Use CSS-based printing for mobile, iframe for desktop
    if (isMobile) {
        return this.printSectionWithCSS(headingId);
    }

    // Desktop: use iframe method (existing implementation)
    const heading = document.getElementById(headingId);
    if (!heading) {
        console.warn('[ViewedManager] printSection: heading not found:', headingId);
        return;
    }
    // ... 后续 iframe 逻辑保持不变
}
```

#### CSS 打印实现 (`viewed.js:504-553`)

```javascript
printSectionWithCSS(headingId) {
    // CSS-based printing for mobile devices
    const heading = document.getElementById(headingId);
    if (!heading) {
        console.warn('[ViewedManager] printSectionWithCSS: heading not found:', headingId);
        return;
    }

    const content = this.getSectionContent(heading);
    if (!content || content.length === 0) {
        console.warn('[ViewedManager] printSectionWithCSS: no content found');
        return;
    }

    // Event handlers for print lifecycle
    const beforePrint = () => {
        // Mark the target section for printing
        heading.classList.add('print-target');
        content.forEach(el => el.classList.add('print-content'));
        document.body.classList.add('printing-active');
        console.log('[ViewedManager] printSectionWithCSS: marked content');
    };

    const afterPrint = () => {
        // Clean up print markers
        heading.classList.remove('print-target');
        content.forEach(el => el.classList.remove('print-content'));
        document.body.classList.remove('printing-active');

        // Remove event listeners
        window.removeEventListener('beforeprint', beforePrint);
        window.removeEventListener('afterprint', afterPrint);
        console.log('[ViewedManager] printSectionWithCSS: cleaned up');
    };

    // Register print events
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);

    // Trigger print dialog
    try {
        window.print();
        console.log('[ViewedManager] printSectionWithCSS: print dialog opened');
    } catch (error) {
        console.warn('[ViewedManager] printSectionWithCSS: print failed', error);
        afterPrint(); // Cleanup on error
    }
}
```

### 2. CSS 实现 (`github-print.css:85-112`)

```css
@media print {
  /* ========== CSS-BASED SECTION PRINTING (MOBILE) ========== */

  /* When printing-active class is present, hide everything except marked content */
  body.printing-active > *:not(.markdown-body):not(script):not(style) {
    display: none !important;
  }

  body.printing-active .markdown-body > * {
    display: none !important;
  }

  /* Show only the marked print target and content */
  body.printing-active .print-target,
  body.printing-active .print-content {
    display: block !important;
  }

  /* Ensure inline elements within print content are visible */
  body.printing-active .print-content * {
    display: revert !important;
  }

  /* Force light theme for printing (override dark mode) */
  body.printing-active,
  body.printing-active .markdown-body,
  body.printing-active .markdown-body * {
    background: white !important;
    color: black !important;
  }
}
```

### 3. 工作流程

#### 移动端打印流程

```
1. 用户点击 Print 按钮
   ↓
2. printSection() 检测到移动设备
   ↓
3. 调用 printSectionWithCSS()
   ↓
4. 注册 beforeprint/afterprint 事件
   ↓
5. 调用 window.print()
   ↓
6. beforeprint 触发（用户看不到）
   - 添加 .print-target 到标题
   - 添加 .print-content 到章节内容
   - 添加 .printing-active 到 body
   ↓
7. 打印对话框打开
   - CSS @media print 生效
   - 隐藏所有非标记内容
   - 只显示 .print-target 和 .print-content
   - 强制使用浅色主题
   ↓
8. 用户完成打印或取消
   ↓
9. afterprint 触发
   - 移除所有 class 标记
   - 清理事件监听器
   ↓
10. 页面恢复原始状态（用户无感知）
```

#### 桌面端打印流程（保持不变）

```
1. 用户点击 Print 按钮
   ↓
2. printSection() 检测到桌面设备
   ↓
3. 创建隐藏的 iframe (A4 尺寸，屏幕外)
   ↓
4. 注入独立的 HTML 文档
   ↓
5. 加载主题 CSS 和打印 CSS
   ↓
6. 克隆章节内容到 iframe
   ↓
7. 等待资源加载（图片、字体、样式表）
   ↓
8. 规范化 SVG 尺寸
   ↓
9. 调用 iframe.contentWindow.print()
   ↓
10. 监听 afterprint 事件清理 iframe
```

---

## 测试指南

### 桌面端测试

#### Chrome/Firefox/Edge
1. 打开任意 Markdown 文档
2. 点击任一章节的 "Print" 按钮
3. 验证：
   - ✅ 打印预览只显示选中章节
   - ✅ 不包含导航、TOC、按钮等 UI 元素
   - ✅ 使用浅色主题（即使主页面是深色）
   - ✅ 底部显示页码
   - ✅ 代码块、表格、Mermaid 图表正常显示

#### Safari (macOS)
1. 同上测试步骤
2. 额外验证：
   - ✅ 无"自动打印拦截"警告
   - ✅ 打印对话框正常打开

### 移动端测试

#### iOS Safari (iPad)
1. 在 iPad 上访问 Markon 站点
2. 打开任意 Markdown 文档
3. 点击章节的 "Print" 按钮
4. 验证：
   - ✅ 打印预览显示完整内容（非空白）
   - ✅ 只显示选中章节
   - ✅ 无"自动打印拦截"警告
   - ✅ 内容不闪烁
   - ✅ 底部 footer 和页码正常

#### Android Chrome
1. 在 Android 手机/平板上访问
2. 点击章节的 "Print" 按钮
3. 验证：
   - ✅ 打印预览只显示选中章节（非整个页面）
   - ✅ 不包含 TOC、导航等
   - ✅ 使用浅色主题

#### iOS Chrome
1. 同 Android Chrome 测试步骤

### 调试工具

#### Chrome DevTools
```javascript
// 在控制台检查设备检测
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
console.log('Device:', isMobile ? 'Mobile' : 'Desktop');
```

#### 模拟移动设备
1. Chrome DevTools → Toggle Device Toolbar (Ctrl+Shift+M)
2. 选择设备：iPad Pro, iPhone 12, Galaxy S20 等
3. 注意：模拟模式下 User-Agent 会变化，会触发移动端代码路径

#### 打印样式预览
1. Chrome DevTools → More tools → Rendering
2. Emulate CSS media type → print
3. 可以看到 @media print 样式生效的效果

---

## 后续计划

### 阶段一：移动端验证（当前）
**目标**：确保移动端 CSS 方案稳定可靠

**任务**：
- ✅ 实现混合方案（已完成）
- ⏳ 在真实移动设备上测试（iPad、iPhone、Android）
- ⏳ 收集用户反馈
- ⏳ 修复发现的边界情况

**验收标准**：
- 移动端打印成功率 > 95%
- 无内容丢失或显示异常
- 用户体验与桌面端一致

### 阶段二：桌面端迁移（未来）
**前提条件**：移动端 CSS 方案经过充分验证（至少 3 个月稳定运行）

**任务**：
- 在桌面端同时启用两种方案，A/B 测试
- 对比 CSS 方案与 iframe 方案的效果差异
- 修复 CSS 方案在桌面端的任何问题

**迁移策略**：
```javascript
// 渐进式迁移
async printSection(headingId) {
    const isMobile = this.isMobileDevice();
    const enableCSSPrintForDesktop = this.getFeatureFlag('css-print-desktop');

    if (isMobile || enableCSSPrintForDesktop) {
        return this.printSectionWithCSS(headingId);
    }

    // Fallback to iframe for desktop
    return this.printSectionWithIframe(headingId);
}
```

### 阶段三：统一方案（长期）
**目标**：所有平台统一使用 CSS 方案

**效果**：
- 删除 iframe 相关代码（~180 行）
- 代码库更简洁，维护成本更低
- 统一的打印体验

**时间估算**：
- 阶段一：1-2 周（当前）
- 阶段二：2-3 个月验证期
- 阶段三：1 周代码清理

---

## 参考资料

### 浏览器 Bug Tracker
- [Chromium Issue 40896385: iframe window.print() prints parent window](https://issues.chromium.org/issues/40896385)
- [Chromium Issue 41222716: Unable to print content of iframe on Android](https://issues.chromium.org/issues/41222716)
- [Chromium Issue 561438: Unable to print iframe on Android](https://bugs.chromium.org/p/chromium/issues/detail?id=561438)

### 社区讨论
- [Apple Developer Forums: Website blocked from printing](https://developer.apple.com/forums/thread/87624)
- [Apple Community: Automatic printing blocked](https://discussions.apple.com/thread/8243399)
- [iOS Chrome printing parent page instead of iframe](https://support.google.com/chrome/thread/183386002/ios-chrome-app-is-printing-entire-page-instead-of-an-iframe?hl=en)

### Print.js 相关
- [Print.js GitHub Repository](https://github.com/crabbly/Print.js)
- [Print.js Official Site](https://printjs.crabbly.com/)
- [Print.js Issue #415: Android Chrome doesn't work](https://github.com/crabbly/Print.js/issues/415)
- [Print.js Issue #349: Mobile Chrome print issues](https://github.com/crabbly/Print.js/issues/349)

### Web 标准与最佳实践
- [MDN: CSS Media Queries - Printing](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing)
- [Smashing Magazine: Print Stylesheets in 2018](https://www.smashingmagazine.com/2018/05/print-stylesheets-in-2018/)
- [Print Styles Best Practices](https://blog.pixelfreestudio.com/print-styles-gone-wrong-avoiding-pitfalls-in-media-print-css/)

### 代码位置
- JavaScript 实现：`/mnt/sdb1/markon/assets/js/viewed.js`
  - printSection(): 第 297-502 行（iframe 方案）
  - printSectionWithCSS(): 第 504-553 行（CSS 方案）
- CSS 实现：`/mnt/sdb1/markon/assets/css/github-print.css`
  - CSS 打印支持：第 85-112 行
  - 通用打印样式：第 1-627 行

---

## 版本历史

| 版本 | 日期 | 修改内容 | 作者 |
|------|------|---------|------|
| 1.0 | 2026-01-08 | 初始版本，记录混合方案实施 | Technical Team |
| 1.1 | 2026-01-08 | 修复移动端事件兼容性问题 | Technical Team |
| 1.2 | 2026-01-08 | 回滚 CSS 方案，移动端改为提示用户 | Technical Team |

---

## 附录：移动端兼容性修复 (v1.1)

### 发现的问题

初始实现后，在真实移动设备上测试发现：**移动端仍然打印整个页面，而非选中章节**。

### 根本原因

经调研发现，移动端浏览器对 `beforeprint`/`afterprint` 事件支持极差：

1. **iOS Safari**: 完全不支持这些事件
2. **Chrome Android**: 虽然支持，但 `afterprint` 会立即触发，时机不对
3. 参考资料：
   - [Can I Use: Printing Events](https://caniuse.com/beforeafterprint) - 显示移动端支持缺失
   - [Chromium Issue 218205](https://bugs.chromium.org/p/chromium/issues/detail?id=218205) - Android 事件时机问题
   - [WebKit Bug 19937](https://bugs.webkit.org/show_bug.cgi?id=19937) - Safari 不支持

### 解决方案

#### 1. JavaScript 改进

**核心改变**: 在调用 `window.print()` **之前**就标记内容，而非依赖 `beforeprint` 事件

**新实现** (`viewed.js:520-579`):

```javascript
printSectionWithCSS(headingId) {
    // ... 获取 heading 和 content

    // 立即标记内容（不等待 beforeprint 事件）
    heading.classList.add('print-target');
    content.forEach(el => el.classList.add('print-content'));
    document.body.classList.add('printing-active');

    // 使用 matchMedia 检测打印完成（移动端兼容性更好）
    if (window.matchMedia) {
        const printMedia = window.matchMedia('print');
        const handleChange = (mql) => {
            if (!mql.matches) {
                // 打印对话框关闭后清理
                cleanup();
                printMedia.removeListener(handleChange);
            }
        };
        printMedia.addListener(handleChange);
    }

    // 保留 beforeprint/afterprint 作为桌面端后备
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);

    // 立即触发打印
    window.print();

    // 60秒安全超时
    setTimeout(() => {
        if (document.body.classList.contains('printing-active')) {
            cleanup();
        }
    }, 60000);
}
```

**关键改进**:
- ✅ 提前标记（不依赖事件）
- ✅ 使用 `window.matchMedia('print')` 监听（移动端更可靠）
- ✅ 保留事件监听作为后备（桌面端兼容）
- ✅ 添加超时保护（避免标记永久残留）

参考资料：
- [Detecting Print Requests with JavaScript](https://www.tjvantoll.com/2012/06/15/detecting-print-requests-with-javascript/)
- [Cross-browser print detection using matchMedia](https://gist.github.com/shaliko/4110822)

#### 2. CSS 优化

**问题**: 原始 CSS 选择器 `body.printing-active .markdown-body > *` 只隐藏直接子元素，可能遗漏嵌套内容

**优化后** (`github-print.css:85-139`):

```css
@media print {
  /* 隐藏所有 markdown-body 内的元素 */
  body.printing-active .markdown-body * {
    display: none !important;
  }

  /* 显示标记的内容 */
  body.printing-active .print-target,
  body.printing-active .print-content {
    display: block !important;
    visibility: visible !important;
  }

  /* 确保标记内容的所有子元素也可见 */
  body.printing-active .print-target *,
  body.printing-active .print-content * {
    display: revert !important;
    visibility: visible !important;
  }

  /* 特殊元素类型处理 */
  body.printing-active .print-target p,
  body.printing-active .print-content p,
  body.printing-active .print-target ul,
  body.printing-active .print-content ul,
  /* ... 更多元素类型 */ {
    display: block !important;
  }

  body.printing-active .print-target li,
  body.printing-active .print-content li {
    display: list-item !important;
  }
}
```

**改进点**:
- ✅ 使用 `*` 选择器隐藏所有后代元素（非仅直接子元素）
- ✅ 添加 `visibility: visible` 确保内容可见
- ✅ 为常见元素类型指定正确的 `display` 值
- ✅ 列表项使用 `display: list-item` 保持样式

### 调试工具

创建了 `docs/print-debug-guide.md`，包含：

1. **设备检测验证**
2. **DOM 标记检查**
3. **CSS 样式调试**
4. **移动端远程调试指南** (iOS Safari Web Inspector, Android Chrome Remote Debugging)
5. **常见问题排查**

### 测试建议

在以下环境重新测试：

| 设备 | 浏览器 | 验证点 |
|------|--------|--------|
| iPad | Safari | 打印预览只显示选中章节，无空白 |
| iPad | Chrome | 同上 |
| Android | Chrome | 同上 |
| iPhone | Safari | 同上 |
| iPhone | Chrome | 同上 |

**验证流程**:
1. 点击任一章节的 "Print" 按钮
2. 打开控制台，检查日志：`marked content for printing`
3. 查看打印预览
4. 确认只显示选中章节（标题 + 内容）
5. 确认不包含导航、TOC、其他章节

### 未来优化

如果移动端仍有问题，考虑：

1. **完全禁用移动端章节打印**，提示用户使用整页打印
2. **使用新窗口方案**（虽然体验较差，但兼容性最好）
3. **等待浏览器改进事件支持**（长期）

---

## 附录 B：CSS 方案回滚 (v1.2)

### 紧急问题

v1.1 实施后，在真实移动设备上测试发现：**CSS 方案破坏了全文打印功能**

症状：
- iPad Safari：只显示空白页（底部有 footer）
- 移动端 Chrome：只显示空白页
- 即使使用浏览器自带的打印功能也失效

### 根本原因

添加的 CSS 规则过于激进：

```css
/* ❌ 问题代码 */
@media print {
  body.printing-active .markdown-body * {
    display: none !important;  /* 隐藏所有内容 */
  }
}
```

**问题**：
1. 如果 `printing-active` class 未被正确清理，会永久隐藏内容
2. CSS 规则在 `@media print` 中，影响所有打印操作（包括浏览器自带的打印）
3. 移动端 `beforeprint`/`afterprint` 事件不触发，导致 class 无法被清理

### 最终方案：移动端禁用章节打印

经过多次尝试，移动端浏览器的限制无法通过纯前端技术绕过：

1. ❌ iframe 方案：移动端不支持 `iframe.contentWindow.print()`
2. ❌ CSS 方案：事件支持差，会破坏全文打印
3. ❌ matchMedia 方案：仍然依赖 CSS，存在相同问题

**最终决定**：移动端显示友好提示，引导用户使用浏览器自带的打印功能

### 实现代码

#### JavaScript (`viewed.js:297-307`)

```javascript
async printSection(headingId) {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isMobile) {
        const message = '移动端浏览器暂不支持章节打印功能。\n\n' +
                       '建议使用浏览器菜单中的"打印"功能打印整个页面。\n\n' +
                       'iOS: 点击分享按钮 → 打印\n' +
                       'Android: 菜单 → 分享 → 打印';
        alert(message);
        console.log('[ViewedManager] printSection: mobile section printing not supported');
        return;
    }

    // Desktop: iframe 方案继续工作
    // ...
}
```

#### CSS (`github-print.css:85-87`)

```css
/* Note: CSS-based section printing for mobile has been temporarily disabled
 * due to conflicts with browser's native print functionality.
 * Mobile devices will show a message to use browser's built-in print feature. */
```

### 最终状态

| 平台 | 章节打印 | 全文打印 | 说明 |
|------|---------|---------|------|
| 桌面浏览器 | ✅ iframe 方案 | ✅ 正常 | 完全支持 |
| 移动端 Safari | ❌ 显示提示 | ✅ 正常 | 提示使用浏览器打印 |
| 移动端 Chrome | ❌ 显示提示 | ✅ 正常 | 提示使用浏览器打印 |

### 用户体验

**桌面端**：
- 点击 Print 按钮 → 打印预览只显示选中章节 → 完美体验

**移动端**：
- 点击 Print 按钮 → 弹出提示："移动端暂不支持章节打印，建议使用浏览器自带的打印功能"
- 用户了解限制，不会产生困惑
- 仍可使用浏览器的打印功能打印整个页面

### 经验教训

1. **移动端浏览器限制是系统性的**
   - iframe 打印：Chromium/WebKit 长期 Bug，无法修复
   - 打印事件：移动端支持极差，不可依赖
   - CSS 方案：过于激进，容易破坏正常功能

2. **优雅降级优于破坏体验**
   - 提示用户使用替代方案 > 功能失效但无提示
   - 保护全文打印功能 > 追求章节打印

3. **真机测试至关重要**
   - 桌面模拟器无法复现移动端的所有问题
   - 必须在真实设备上验证

### 代码清理

- ✅ 删除了 `printSectionWithCSS()` 函数
- ✅ 移除了破坏性的 CSS 规则
- ✅ 保持桌面端 iframe 方案不变
- ✅ 确保全文打印功能正常

---

**文档结束**
