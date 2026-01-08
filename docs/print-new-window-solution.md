# 移动端章节打印新方案：新窗口 + Blob URL

**版本**: 0.6.2
**日期**: 2026-01-08
**状态**: 已实施

---

## 方案概述

使用 **新窗口 + Blob URL** 方案替代移动端的禁用提示，为移动设备提供真正可用的章节打印功能。

### 核心思路

1. 创建包含章节内容的完整 HTML 文档
2. 内联所有 CSS 样式（避免外部资源加载问题）
3. 转换为 Blob URL
4. 在新窗口/标签页打开
5. 移动端显示友好提示，桌面端自动打印

---

## 技术细节

### Blob URL 优势

| 特性 | Data URL | Blob URL |
|------|---------|----------|
| 格式 | `data:text/html,<html>...` | `blob:http://localhost/uuid` |
| 长度限制 | ❌ 2-10MB（浏览器差异） | ✅ 无限制（仅受内存限制）|
| 性能 | 慢（Base64 编码） | 快（直接引用）|
| 适用场景 | 小文档 | **大型内容**（推荐）|

### 实现架构

```
用户点击 Print
    ↓
检测设备类型
    ↓
┌──────────────┬──────────────┐
│   桌面端     │   移动端     │
│   iframe     │  新窗口方案   │
└──────────────┴──────────────┘
                    ↓
        1. 克隆章节内容
        2. 移除 UI 控件
        3. 内联 CSS 样式
        4. 创建 Blob URL
        5. window.open()
                    ↓
        ┌──────────┴──────────┐
        │   新窗口/标签页      │
        │  ┌────────────────┐ │
        │  │ 章节标题        │ │
        │  │ 章节内容        │ │
        │  │ [蓝色提示框]    │ │
        │  └────────────────┘ │
        └─────────────────────┘
                    ↓
        移动端：显示"点击菜单→打印"
        桌面端：自动触发 window.print()
```

---

## 代码实现

### 1. 主入口 (`viewed.js:297-311`)

```javascript
async printSection(headingId) {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isMobile) {
        // 移动端：新窗口方案
        return this.printSectionInNewWindow(headingId);
    }

    // 桌面端：iframe 方案（保持不变）
    // ...
}
```

### 2. 新窗口打印 (`viewed.js:504-601`)

```javascript
async printSectionInNewWindow(headingId) {
    // 1. 获取内容
    const heading = document.getElementById(headingId);
    const content = this.getSectionContent(heading);

    // 2. ⚠️ 关键：立即同步打开窗口（在用户手势上下文中）
    // 这样可以避免 Safari 弹窗拦截器
    const printWindow = window.open('about:blank', '_blank');

    if (!printWindow) {
        alert('请允许弹出窗口以打印章节...');
        return;
    }

    // 显示加载提示
    printWindow.document.write('<html><body><h2>正在准备打印内容...</h2></body></html>');

    // 3. 克隆并清理内容（异步，但窗口已打开）
    const headingClone = heading.cloneNode(true);
    headingClone.querySelectorAll('.section-action, .viewed-checkbox-label').forEach(el => el.remove());
    const contentHTML = [headingClone, ...contentClones].map(el => el.outerHTML).join('\n');

    // 4. 异步 fetch CSS（窗口已打开，不会被拦截）
    const styles = await this.fetchPrintStyles();

    // 5. 创建完整 HTML 文档
    const fullHTML = `<!DOCTYPE html>
<html>
<head>
    <style>${styles}</style>
</head>
<body>
    <div class="markdown-body">${contentHTML}</div>
    <script>
        // 所有设备都自动打印
        window.addEventListener('load', function() {
            setTimeout(() => window.print(), 300);
        });
    </script>
</body>
</html>`;

    // 6. 写入内容到已打开的窗口
    printWindow.document.open();
    printWindow.document.write(fullHTML);
    printWindow.document.close();
}
```

### 3. 样式内联 (`viewed.js:626-650`)

```javascript
async fetchPrintStyles() {
    const cssFiles = [
        '/_/css/github-markdown-light.css',  // 浅色主题
        '/_/css/github-print.css'            // 打印优化
    ];

    const cssContents = await Promise.all(
        cssFiles.map(async (file) => {
            const response = await fetch(file);
            return await response.text();
        })
    );

    return cssContents.join('\n\n');
}
```

---

## 用户体验

### 桌面端（无变化）

1. 点击章节 Print 按钮
2. 打印预览自动打开
3. 只显示选中章节
4. ✅ 体验完美

### 移动端（新功能）

#### iPad/iPhone Safari

1. 点击章节 Print 按钮
2. **打开新标签页**，显示章节内容
3. **自动弹出打印对话框** 🎉
4. 打印预览只显示该章节
5. ✅ 一键打印，体验流畅

#### Android Chrome

1. 点击章节 Print 按钮
2. **打开新标签页**，显示章节内容
3. **自动弹出打印对话框** 🎉
4. 打印预览只显示该章节
5. ✅ 一键打印，体验流畅

---

## 潜在问题与处理

### 1. 弹窗拦截器

**问题**：浏览器可能阻止 `window.open()`（尤其是异步调用后）

**解决方案**：在用户手势的同步上下文中立即打开窗口
```javascript
// ✅ 正确：立即同步打开（在 await 之前）
const printWindow = window.open('about:blank', '_blank');

// ❌ 错误：在 await 之后打开（会被 Safari 拦截）
const styles = await this.fetchPrintStyles();
const printWindow = window.open(url, '_blank');  // 已失去用户手势上下文
```

**优势**：
- Safari Mobile 无需设置弹窗权限
- 窗口在用户点击的同步路径中打开，不会被拦截
- 内容可以异步加载到已打开的窗口

### 2. CSS 加载失败

**问题**：网络问题导致 CSS fetch 失败

**处理**：
```javascript
try {
    const response = await fetch(file);
    if (!response.ok) return '';
    return await response.text();
} catch (error) {
    console.warn(`Failed to fetch ${file}`);
    return '';  // 返回空字符串，继续执行
}
```

**影响**：内容仍可打印，只是样式可能不完整

### 3. 自动打印失败

**问题**：某些浏览器可能阻止自动调用 `window.print()`

**处理**：
```javascript
window.addEventListener('load', function() {
    setTimeout(function() {
        try {
            window.print();
        } catch (error) {
            // 如果自动打印失败，窗口仍然打开，用户可手动打印
            console.warn('Auto-print failed, user can manually print');
        }
    }, 300);
});
```

**影响**：即使自动打印失败，用户仍可看到完整内容，手动使用浏览器打印功能

---

## 测试指南

### 桌面端测试

#### Chrome/Firefox/Edge
1. 打开任意 Markdown 文档
2. 点击章节 Print 按钮
3. **预期**：
   - ✅ 打印预览自动打开（iframe 方案）
   - ✅ 只显示选中章节
   - ✅ 无新窗口弹出

### 移动端测试

#### iPad Safari
1. 在 iPad 上访问 Markon
2. 点击章节 Print 按钮
3. **预期**：
   - ✅ 立即打开新标签页（无弹窗拦截）
   - ✅ 短暂显示"正在准备打印内容..."
   - ✅ **自动弹出打印对话框**
   - ✅ 打印预览只显示该章节
   - ✅ 内容完整（标题、段落、代码块、表格）

#### Android Chrome
1. 在 Android 设备上访问
2. 点击章节 Print 按钮
3. **预期**：
   - ✅ 立即打开新标签页（无弹窗拦截）
   - ✅ 短暂显示"正在准备打印内容..."
   - ✅ **自动弹出打印对话框**
   - ✅ 打印预览只显示该章节
   - ✅ 内容完整（标题、段落、代码块、表格）

#### 边缘情况测试
1. **网络慢速**：CSS 加载慢时，窗口显示"正在准备..."直到加载完成
2. **自动打印失败**：窗口仍显示内容，用户可手动打印
3. **极端情况**：如果弹窗仍被拦截（极少见），显示提示用户允许弹窗

---

## 优势对比

### vs. iframe 方案（移动端不可用）

| 方面 | iframe | 新窗口 |
|------|--------|--------|
| 移动端支持 | ❌ 失效 | ✅ 可用 |
| 用户体验 | - | 中等（需打开新标签）|
| 实现复杂度 | 中 | 中 |

### vs. CSS 方案（破坏全文打印）

| 方面 | CSS | 新窗口 |
|------|-----|--------|
| 移动端支持 | ❌ 事件缺失 | ✅ 可用 |
| 全文打印 | ❌ 破坏 | ✅ 不影响 |
| 风险 | 高 | 低 |

### vs. 禁用功能（当前方案）

| 方面 | 禁用 | 新窗口 |
|------|------|--------|
| 移动端支持 | ❌ 无功能 | ✅ 可用 |
| 用户体验 | 差（只能整页打印）| 好（有章节打印）|
| 实现复杂度 | 低 | 中 |

---

## 最终状态

| 平台 | 章节打印方案 | 全文打印 | 用户体验 |
|------|-------------|---------|---------|
| 桌面 Chrome | iframe | ✅ 正常 | 完美 |
| 桌面 Safari | iframe | ✅ 正常 | 完美 |
| iPad Safari | **新窗口** | ✅ 正常 | **良好** ✨ |
| 移动 Chrome | **新窗口** | ✅ 正常 | **良好** ✨ |

---

## 后续优化

### 可能的改进

1. **样式缓存**
   - 首次 fetch CSS 后缓存在内存中
   - 后续打印直接使用缓存
   - 减少网络请求

2. **进度指示**
   - 在 fetch CSS 时显示 loading 提示
   - 提升用户体验

3. **智能检测**
   - 检测是否支持 iframe 打印
   - 动态选择最佳方案

4. **预加载样式**
   - 页面加载时预先 fetch CSS
   - 打印时直接使用

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.6.2 | 2026-01-08 | 实施新窗口 + Blob URL 方案 |

---

**文档结束**
