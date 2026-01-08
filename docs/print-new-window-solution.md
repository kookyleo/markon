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

### 2. 新窗口打印 (`viewed.js:504-624`)

```javascript
async printSectionInNewWindow(headingId) {
    // 1. 获取并克隆内容
    const heading = document.getElementById(headingId);
    const content = this.getSectionContent(heading);
    const headingClone = heading.cloneNode(true);

    // 移除 UI 控件
    headingClone.querySelectorAll('.section-action, .viewed-checkbox-label').forEach(el => el.remove());

    // 2. 内联 CSS 样式
    const styles = await this.fetchPrintStyles();

    // 3. 创建完整 HTML 文档
    const fullHTML = `<!DOCTYPE html>
<html>
<head>
    <style>${styles}</style>
</head>
<body>
    <div class="markdown-body">${contentHTML}</div>
    <script>
        // 移动端：显示提示
        // 桌面端：自动打印
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        window.addEventListener('load', function() {
            if (!isMobile) {
                setTimeout(() => window.print(), 500);
            } else {
                // 显示蓝色提示框
                // "点击右上角菜单 → 打印"
            }
        });
    </script>
</body>
</html>`;

    // 4. 创建 Blob URL
    const blob = new Blob([fullHTML], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);

    // 5. 打开新窗口
    const printWindow = window.open(url, '_blank');

    // 6. 清理 Blob URL
    setTimeout(() => URL.revokeObjectURL(url), 2000);
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
3. 顶部显示蓝色提示框："点击右上角菜单 → 打印"
4. 用户点击分享按钮 → 打印
5. 打印预览只显示该章节
6. ✅ 功能可用

#### Android Chrome

1. 点击章节 Print 按钮
2. **打开新标签页**，显示章节内容
3. 顶部显示蓝色提示框："点击右上角菜单 → 打印"
4. 用户点击菜单 → 分享 → 打印
5. 打印预览只显示该章节
6. ✅ 功能可用

---

## 潜在问题与处理

### 1. 弹窗拦截器

**问题**：浏览器可能阻止 `window.open()`

**处理**：
```javascript
const printWindow = window.open(url, '_blank');

if (!printWindow) {
    // 弹窗被拦截
    alert('请允许弹出窗口以打印章节。\n\n或使用浏览器菜单中的"打印"功能打印整个页面。');
    URL.revokeObjectURL(url);
    return;
}
```

**用户操作**：
- 浏览器会提示"允许弹出窗口"
- 用户允许后，再次点击 Print 即可

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

### 3. Blob URL 清理

**问题**：需要及时释放内存

**处理**：
```javascript
// 2秒后清理（足够窗口加载）
setTimeout(() => {
    URL.revokeObjectURL(url);
}, 2000);
```

### 4. 移动端新标签页管理

**问题**：移动端打开新标签页后，用户可能不知道如何打印

**处理**：显示友好的蓝色提示框
- 5秒后自动淡出
- 明确告知用户下一步操作
- 样式醒目但不遮挡内容

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
   - ✅ 打开新标签页
   - ✅ 显示章节内容
   - ✅ 顶部蓝色提示："点击右上角菜单 → 打印"
   - ✅ 5秒后提示淡出
4. 点击分享按钮 → 打印
5. **预期**：
   - ✅ 打印预览只显示该章节
   - ✅ 内容完整（标题、段落、代码块、表格）

#### Android Chrome
1. 在 Android 设备上访问
2. 点击章节 Print 按钮
3. **预期**：同 iPad Safari

#### 弹窗拦截测试
1. 在移动设备上首次点击 Print
2. 如果弹窗被拦截：
   - ✅ 显示 alert："请允许弹出窗口..."
3. 浏览器提示允许弹窗后
4. 再次点击 Print
5. **预期**：
   - ✅ 成功打开新标签页

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
