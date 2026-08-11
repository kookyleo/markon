---
title: 下载 Markon
description: 下载适用于 macOS、Windows 或 Linux 的最新 Markon，并查看项目代码签名策略。
head:
  - - meta
    - property: og:title
      content: 下载 Markon
  - - meta
    - property: og:description
      content: 自动匹配当前操作系统和 CPU 架构的最新 Markon 安装包。
---

# 下载 Markon

本页面打开时会读取 GitHub 最新稳定版，并按当前操作系统与 CPU 架构选择安装包。自动识别不准确时，请展开“其他平台 / 架构”手动选择。

<DownloadButton />

完整安装包列表和发布说明可在 [GitHub Releases](https://github.com/kookyleo/markon/releases/latest) 查看。

## 代码签名策略

Markon 的发布产物由 [`kookyleo/markon`](https://github.com/kookyleo/markon) 仓库中的公开源码和构建脚本通过 [GitHub Actions](https://github.com/kookyleo/markon/actions) 生成。只有此仓库发布工作流生成的产物才会进入签名流程。

免费代码签名由 [SignPath.io](https://about.signpath.io/) 提供，证书由 [SignPath Foundation](https://signpath.org/) 提供。

- **提交者与审阅者：** [Leo Kwoc (`kookyleo`)](https://github.com/kookyleo)
- **审批者：** [Leo Kwoc (`kookyleo`)](https://github.com/kookyleo)
- **审批：** 每次发布签名请求都需要审批者手动批准。
- **隐私：** 参见 Markon 的[数据与隐私](https://github.com/kookyleo/markon#data-and-privacy)声明。除非用户明确开启并配置需要联网的功能，否则 Markon 不会把工作区内容传输到其它网络系统。
