# 移动端打印功能调试指南

## 问题症状

移动端点击 Print 按钮后，仍然打印整个页面而非选中章节。

## 调试步骤

### 1. 检查设备检测

在移动端浏览器的控制台运行：

```javascript
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
console.log('设备类型:', isMobile ? '移动端' : '桌面端');
console.log('User-Agent:', navigator.userAgent);
```

**预期结果**: 应该显示"移动端"

### 2. 检查 class 标记是否添加

点击 Print 按钮前，在控制台运行：

```javascript
// 监听 DOM 变化
const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
            console.log('Class changed:', mutation.target.className);
        }
    });
});

observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
    subtree: true
});

console.log('DOM observer started');
```

然后点击 Print 按钮。

**预期结果**: 应该看到以下日志：
- `Class changed: printing-active` (body)
- `Class changed: ... print-target` (标题元素)
- `Class changed: ... print-content` (内容元素)

### 3. 检查 DOM 结构

在控制台运行：

```javascript
// 找到第一个 h2 标题
const firstH2 = document.querySelector('.markdown-body h2');
console.log('标题:', firstH2);
console.log('标题 ID:', firstH2 ? firstH2.id : 'not found');

// 检查 getSectionContent 逻辑
let content = [];
if (firstH2) {
    let next = firstH2.nextElementSibling;
    while (next) {
        const isHeading = /^H[123456]$/.test(next.tagName);
        if (isHeading) {
            const nextLevel = parseInt(next.tagName[1]);
            const currentLevel = parseInt(firstH2.tagName[1]);
            if (nextLevel <= currentLevel) break;
        }
        content.push(next);
        next = next.nextElementSibling;
    }
}
console.log('章节内容元素数量:', content.length);
console.log('章节内容:', content);
```

**预期结果**: 应该找到章节标题和若干内容元素

### 4. 模拟打印标记

手动添加 class 测试 CSS：

```javascript
const firstH2 = document.querySelector('.markdown-body h2');
if (firstH2) {
    // 添加打印标记
    firstH2.classList.add('print-target');
    document.body.classList.add('printing-active');

    let next = firstH2.nextElementSibling;
    while (next) {
        const isHeading = /^H[123456]$/.test(next.tagName);
        if (isHeading) {
            const nextLevel = parseInt(next.tagName[1]);
            if (nextLevel <= 2) break;
        }
        next.classList.add('print-content');
        next = next.nextElementSibling;
    }

    console.log('已添加打印标记，现在可以使用浏览器的打印功能（Cmd+P 或菜单）测试');
}
```

然后使用浏览器的打印功能（不要点击 Print 按钮），看打印预览是否只显示选中章节。

**清理标记**：

```javascript
document.body.classList.remove('printing-active');
document.querySelectorAll('.print-target, .print-content').forEach(el => {
    el.classList.remove('print-target', 'print-content');
});
console.log('已清理打印标记');
```

### 5. 检查 CSS 样式生效

在添加打印标记后，检查样式：

```javascript
const body = document.body;
const markdown = document.querySelector('.markdown-body');

console.log('body 是否有 printing-active:', body.classList.contains('printing-active'));
console.log('.markdown-body 子元素数量:', markdown.children.length);

// 检查第一个子元素的 display 样式
const firstChild = markdown.firstElementChild;
const computedStyle = window.getComputedStyle(firstChild);
console.log('第一个子元素:', firstChild.tagName, firstChild.className);
console.log('display 样式:', computedStyle.display);

// 检查 print-target 元素
const printTarget = document.querySelector('.print-target');
if (printTarget) {
    const targetStyle = window.getComputedStyle(printTarget);
    console.log('print-target display:', targetStyle.display);
}
```

**预期结果**:
- 非打印内容: `display: none`
- print-target/print-content: `display: block` 或其他可见值

## 常见问题

### 问题 1: 设备检测失败

**症状**: isMobile 返回 false，但明明是移动设备

**解决方案**:
- 检查是否在模拟器中测试（需要在真实设备上测试）
- 某些 iPad 可能被识别为桌面设备（修改正则表达式）

### 问题 2: class 标记未添加

**症状**: 点击 Print 后没有看到 class 变化

**可能原因**:
- getSectionContent() 返回空数组
- 标题元素找不到
- JavaScript 报错

**检查方法**:
```javascript
// 打开控制台，查看是否有错误
console.log('Console errors check');
```

### 问题 3: CSS 样式未生效

**症状**: class 已添加，但元素仍然可见

**可能原因**:
- CSS 优先级不够
- @media print 规则在非打印模式下不生效
- 选择器不匹配

**解决方案**: 检查打印预览（真正的打印模式），而非页面显示

## 移动端特定调试

### iOS Safari

1. 在 Mac 上打开 Safari
2. 连接 iPad/iPhone (USB)
3. Safari → Develop → [设备名] → [网页]
4. 使用 Web Inspector 调试

### Android Chrome

1. 在电脑上打开 Chrome
2. 连接 Android 设备 (USB，开启 USB 调试)
3. 访问 `chrome://inspect`
4. 选择设备和页面进行调试

## 临时解决方案

如果移动端 CSS 方案仍然有问题，可以临时禁用移动端打印：

```javascript
// 在 printSection() 开头添加
if (isMobile) {
    alert('移动端打印功能正在优化中，请使用浏览器自带的打印功能（选择"分享" → "打印"）');
    return;
}
```

或者提示用户使用整页打印：

```javascript
if (isMobile) {
    const useFull = confirm('移动端章节打印暂时不可用。\n\n点击"确定"打印整个页面，或点击"取消"关闭。');
    if (useFull) {
        window.print();
    }
    return;
}
```
