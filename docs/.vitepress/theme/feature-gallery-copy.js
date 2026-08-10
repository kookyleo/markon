export const FEATURE_GALLERY_COPY = {
  zh: {
    label: 'Markon 使用路线',
    groups: [
      {
        title: '不必额外搬运，只需要使用 Markon 打开，无论文档、目录或 Git 仓库',
        items: [
          {
            image: 'illustrations/20-open-entrypoints.svg',
            title: '文档在哪，就从哪开始',
            desc: '不必导入、建库或预先启动应用。从文件管理器、右键菜单或终端选择使用 Markon 打开文档、目录或 Git 仓库即可。',
            link: '/guide/getting-started',
          },
          {
            image: 'illustrations/13-workspace.svg',
            title: '打开文档，也保留它的上下文',
            desc: '文档不只有正文，还有目录结构与 Git 历史。Markon 保留这些关系，让阅读、审阅和修改始终发生在同一个工作区。',
            link: '/features/workspaces',
          },
          {
            image: 'illustrations/01-rendering.svg',
            title: '主流 Markdown 扩展和图表，一应俱全',
            desc: '基于 Supramark，Markon 广泛支持 GFM、Alerts、脚注、Emoji、KaTeX，以及 Mermaid、PlantUML、D2、Graphviz、Vega 等主流扩展和图表。',
            link: '/features/rendering',
          },
        ],
      },
      {
        title: '快速找到关键内容，必要时直接唤起聊天窗，与内容对话',
        items: [
          {
            image: 'illustrations/02-search.svg',
            title: '不必来回跳转，随处搜索目标内容',
            desc: '内容越多，翻找越容易打断思路。在工作区或阅读页面，按下 / 搜索文件名、路径、标题与正文，直接落到命中位置。',
            link: '/features/search',
          },
          {
            image: 'illustrations/14-git-diff.svg',
            title: '不必重读整个仓库，只关注真正的变化',
            desc: '不用每轮都重新开始，Markdiff 按文件呈现前后差异，也可切换到 Raw 源码视图，在语义与细节之间自由选择。',
            link: '/features/git',
          },
          {
            image: 'illustrations/12-chat.svg',
            title: '必要时，直接与内容对话',
            desc: '选中内容或 @ 相关文件提问，让 AI 成为你的文档助理，结合工作区上下文查找、解释和归纳，并可附上可点击的出处，方便核验。',
            link: '/features/chat',
          },
        ],
      },
      {
        title: '读到哪，就在哪写写画画，批注或者批改原稿',
        items: [
          {
            image: 'illustrations/05-annotate.svg',
            title: '读到哪，就标注到哪',
            desc: '选中文字即可高亮、划掉或写下 Note，把阅读时的判断和线索留在它真正发生的位置。',
            link: '/features/annotations',
          },
          {
            image: 'illustrations/17-export-notes.svg',
            title: '所有 Notes 都可以随时打包带走',
            desc: '思考不会被锁在产品里。把整页或当前章节写下的 Notes 导出为 Markdown，归档、分享，或交给伙伴和 Agent 继续处理。',
            link: '/features/export',
          },
          {
            image: 'illustrations/04-edit.svg',
            title: '如果需要修改原文，也不必重新定位',
            desc: '可以从选中的阅读位置直达对应 Markdown 源码，边改边看。如果由 AI 执笔，提出的改动仍由你逐项 Apply 或 Reject，决定权始终在你。',
            link: '/features/edit',
          },
        ],
      },
      {
        title: '长文不必一气读完，进度也不必记在脑子里',
        items: [
          {
            image: 'illustrations/18-section-reading.svg',
            title: '让每个 Section 自成阅读卡片',
            desc: '密密麻麻的长文很容易产生认知疲劳。Markon 在保留完整目录层级和正文连续性的同时，为每个 Section 划出边界，让注意力有落点。',
            link: '/features/viewed',
          },
          {
            image: 'illustrations/03-viewed.svg',
            title: '读过的就收起，把进度交给 Markon',
            desc: '按 Section 标记 Viewed，读完一段就折叠一段。进度会被记住，下次回来，哪些读过、哪些还没读一目了然。',
            link: '/features/viewed',
          },
          {
            image: 'illustrations/19-viewed-complete.svg',
            title: '让滚动条越来越短，Get things done',
            desc: '同一套方法也用于 Markdiff：逐个读完文件变更并标记 Viewed。未读内容归零后，这轮审阅也就完成啦。',
            link: '/features/git',
          },
        ],
      },
      {
        title: '阅读不局限于一个人、一块屏幕或一种操作方式',
        items: [
          {
            image: 'illustrations/06-live.svg',
            title: '一起读，先让所有人看见同一处',
            desc: '远程讲解，最怕听众不同步。开启 Live 后，跟随端会同步主控端的 Section 焦点、文字选区和 Viewed 状态，共享同一份阅读上下文。',
            link: '/features/live',
          },
          {
            image: 'illustrations/08-print.svg',
            title: '离开屏幕，换个舒服的姿势继续',
            desc: '屏幕适合检索，纸笔更适合深读与思考。把整页或 Section 带到纸上，摊开对照、随手圈画，也让眼睛和身体换个姿势。有些阅读体验，纸笔依然无可替代。',
            link: '/features/print',
          },
          {
            image: 'illustrations/21-shortcuts.svg',
            title: '还有更多功能，随时按下 ?',
            desc: 'Markon 将快捷键视为工作流的一部分。无论身处哪个页面，按下 ? 即可查看当前可用的功能与快捷键。每一次使用快捷键，都是在保护你的注意力。',
            link: '/advanced/shortcuts',
          },
        ],
      },
    ],
  },
  en: {
    label: 'How Markon fits into your workflow',
    groups: [
      {
        title: 'No import step—just open a document, folder, or Git repository with Markon',
        items: [
          {
            image: 'illustrations/20-open-entrypoints.svg',
            title: 'Start wherever the document already lives',
            desc: 'There is nothing to import, index, or launch first. Open a document, folder, or Git repository with Markon from your file manager, context menu, or terminal.',
            link: '/guide/getting-started',
          },
          {
            image: 'illustrations/13-workspace.svg',
            title: 'Open the document without losing its context',
            desc: 'A document is more than its body: its folder structure and Git history matter too. Markon keeps those relationships together in one workspace for reading, review, and revision.',
            link: '/features/workspaces',
          },
          {
            image: 'illustrations/01-rendering.svg',
            title: 'Mainstream Markdown extensions and diagrams, broadly covered',
            desc: 'Built on Supramark, Markon supports GFM, Alerts, footnotes, Emoji, KaTeX, Mermaid, PlantUML, D2, Graphviz, Vega, and other widely used extensions and diagram formats.',
            link: '/features/rendering',
          },
        ],
      },
      {
        title: 'Find what matters quickly, and open a conversation with the content when needed',
        items: [
          {
            image: 'illustrations/02-search.svg',
            title: 'Search from where you are—without jumping around',
            desc: 'The larger the workspace, the easier it is to lose your train of thought while browsing. In a workspace or reading page, press / to search filenames, paths, headings, and body text, then jump straight to a match.',
            link: '/features/search',
          },
          {
            image: 'illustrations/14-git-diff.svg',
            title: 'Do not reread the repository—focus on what changed',
            desc: 'There is no need to restart every review from page one. Markdiff presents changes file by file and can switch to a Raw source view when syntax-level detail matters.',
            link: '/features/git',
          },
          {
            image: 'illustrations/12-chat.svg',
            title: 'When needed, talk to the content directly',
            desc: 'Ask about a selection or @-mention related files. AI can work as a document assistant across the workspace—finding, explaining, and summarizing material, with clickable references when available.',
            link: '/features/chat',
          },
        ],
      },
      {
        title: 'Annotate where you read, or revise the source without breaking stride',
        items: [
          {
            image: 'illustrations/05-annotate.svg',
            title: 'Mark it where you noticed it',
            desc: 'Highlight, strike through, or add a Note to selected text, keeping every judgment and clue beside the passage that gave it meaning.',
            link: '/features/annotations',
          },
          {
            image: 'illustrations/17-export-notes.svg',
            title: 'Take every Note with you at any time',
            desc: 'Your thinking is not locked into the product. Export Notes from the whole page or the current section as Markdown for archiving, sharing, or handing to a teammate or agent.',
            link: '/features/export',
          },
          {
            image: 'illustrations/04-edit.svg',
            title: 'If the source needs changing, do not locate it twice',
            desc: 'Jump from selected rendered text to the corresponding Markdown source and edit with the preview beside you. If AI writes a patch, every Apply or Reject decision remains yours.',
            link: '/features/edit',
          },
        ],
      },
      {
        title: 'A long document need not be finished at once—or held in your head',
        items: [
          {
            image: 'illustrations/18-section-reading.svg',
            title: 'Let every Section become a reading card',
            desc: 'Dense long-form documents create cognitive fatigue. Markon preserves the complete outline and continuous text while giving every Section a clear boundary and your attention a place to land.',
            link: '/features/viewed',
          },
          {
            image: 'illustrations/03-viewed.svg',
            title: 'Put completed reading away and let Markon track progress',
            desc: 'Mark a Section Viewed and fold it when you finish. Progress is remembered, so when you return, what is read and what remains are immediately clear.',
            link: '/features/viewed',
          },
          {
            image: 'illustrations/19-viewed-complete.svg',
            title: 'Shorten the scroll until the review is done',
            desc: 'The same method works in Markdiff: review changed files one by one and mark them Viewed. When unread changes reach zero, the review is complete.',
            link: '/features/git',
          },
        ],
      },
      {
        title: 'Reading is not limited to one person, one screen, or one way of working',
        items: [
          {
            image: 'illustrations/06-live.svg',
            title: 'For a shared reading, first put everyone on the same passage',
            desc: 'Remote walkthroughs fail when the audience falls out of sync. Live lets followers mirror the presenter’s Section focus, text selection, and Viewed state, sharing the same reading context.',
            link: '/features/live',
          },
          {
            image: 'illustrations/08-print.svg',
            title: 'Leave the screen and continue in a more comfortable position',
            desc: 'Screens excel at retrieval; paper is often better for deep reading and thought. Print a whole page or a Section to compare, mark up, and read away from the screen—some experiences remain irreplaceably physical.',
            link: '/features/print',
          },
          {
            image: 'illustrations/21-shortcuts.svg',
            title: 'There is more—press ? at any time',
            desc: 'Markon treats keyboard shortcuts as part of the workflow. On any page, press ? to see the functions and shortcuts currently available. Each shortcut helps protect your attention.',
            link: '/advanced/shortcuts',
          },
        ],
      },
    ],
  },
  ja: {
    label: 'Markon の使い方',
    groups: [
      {
        title: '移行作業は不要。文書、フォルダー、Git リポジトリを Markon で開くだけ',
        items: [
          {
            image: 'illustrations/20-open-entrypoints.svg',
            title: '文書がある場所から、そのまま始める',
            desc: 'インポートやライブラリ作成、アプリの事前起動は不要です。ファイルマネージャー、コンテキストメニュー、またはターミナルから、文書やフォルダー、Git リポジトリを Markon で開くだけです。',
            link: '/guide/getting-started',
          },
          {
            image: 'illustrations/13-workspace.svg',
            title: '文書を開いても、文脈は失わない',
            desc: '文書は本文だけではありません。フォルダー構造や Git 履歴も大切な文脈です。Markon はそれらを一つのワークスペースに保ち、読む・レビューする・直すをつなげます。',
            link: '/features/workspaces',
          },
          {
            image: 'illustrations/01-rendering.svg',
            title: '主要な Markdown 拡張と図表を幅広くサポート',
            desc: 'Supramark を基盤に、GFM、Alerts、脚注、Emoji、KaTeX、Mermaid、PlantUML、D2、Graphviz、Vega など、広く使われる拡張と図表形式に対応します。',
            link: '/features/rendering',
          },
        ],
      },
      {
        title: '大事な箇所をすばやく見つけ、必要なら内容そのものと対話する',
        items: [
          {
            image: 'illustrations/02-search.svg',
            title: '行き来せず、その場から目的の内容を探す',
            desc: '情報量が増えるほど、探し回るだけで思考は途切れます。ワークスペースや閲覧ページで / を押し、ファイル名、パス、見出し、本文を検索して、その位置へ直接移動できます。',
            link: '/features/search',
          },
          {
            image: 'illustrations/14-git-diff.svg',
            title: 'リポジトリ全体を読み直さず、本当の変更だけを見る',
            desc: 'レビューのたびに最初から読む必要はありません。Markdiff は差分をファイル単位で示し、必要なら Raw ソース表示に切り替えて細部を確認できます。',
            link: '/features/git',
          },
          {
            image: 'illustrations/12-chat.svg',
            title: '必要なときは、内容と直接対話する',
            desc: '選択範囲について質問したり、関連ファイルを @ で指定したりできます。AI はワークスペースを横断して検索・説明・要約し、可能な場合は確認できるリンク付きの出典も示します。',
            link: '/features/chat',
          },
        ],
      },
      {
        title: '読んだ場所で書き込み、流れを切らずに原文も直す',
        items: [
          {
            image: 'illustrations/05-annotate.svg',
            title: '気づいた場所に、そのまま残す',
            desc: '選択した文字をハイライトし、取り消し線や Note を加えて、判断や手がかりを意味の生まれた箇所に残せます。',
            link: '/features/annotations',
          },
          {
            image: 'illustrations/17-export-notes.svg',
            title: 'すべての Notes をいつでも持ち出せる',
            desc: '考えたことは製品の中に閉じ込められません。ページ全体または現在の Section の Notes を Markdown として書き出し、保存、共有、仲間や Agent への引き継ぎに使えます。',
            link: '/features/export',
          },
          {
            image: 'illustrations/04-edit.svg',
            title: '原文を直すときも、同じ場所を探し直さない',
            desc: '選択した閲覧位置から対応する Markdown ソースへ移動し、プレビューを見ながら編集できます。AI が変更案を書いても、Apply / Reject の判断は一つずつ自分で行えます。',
            link: '/features/edit',
          },
        ],
      },
      {
        title: '長文は一気に読み切らなくていい。進捗も頭で覚えなくていい',
        items: [
          {
            image: 'illustrations/18-section-reading.svg',
            title: 'Section ごとに、一枚の読書カードにする',
            desc: '密度の高い長文は認知疲労を招きます。Markon は目次の階層と本文の連続性を保ちながら、各 Section に明確な境界をつくり、注意を置く場所を与えます。',
            link: '/features/viewed',
          },
          {
            image: 'illustrations/03-viewed.svg',
            title: '読み終えた部分はしまい、進捗は Markon に任せる',
            desc: 'Section を Viewed にして、読み終えたら折りたためます。進捗は記憶されるため、戻ったときに既読と未読がひと目で分かります。',
            link: '/features/viewed',
          },
          {
            image: 'illustrations/19-viewed-complete.svg',
            title: 'スクロールを短くし、レビューを完了へ近づける',
            desc: '同じ方法は Markdiff でも使えます。変更されたファイルを一つずつ読み、Viewed にします。未読がゼロになれば、そのレビューは完了です。',
            link: '/features/git',
          },
        ],
      },
      {
        title: '読むことは、一人、一つの画面、一つの操作方法に限られない',
        items: [
          {
            image: 'illustrations/06-live.svg',
            title: '一緒に読むなら、まず同じ箇所を見る',
            desc: '遠隔での説明は、聞き手とのずれが大きな障害です。Live を使うと、フォロワー側が主操作側の Section、文字選択、Viewed 状態に追従し、同じ閲覧文脈を共有できます。',
            link: '/features/live',
          },
          {
            image: 'illustrations/08-print.svg',
            title: '画面を離れ、楽な姿勢で続きを読む',
            desc: '検索には画面が向き、深く読むことや考えることには紙が向く場合があります。ページ全体や Section を印刷して、並べて比べ、自由に書き込みながら読む。紙でしか得られない体験もあります。',
            link: '/features/print',
          },
          {
            image: 'illustrations/21-shortcuts.svg',
            title: 'まだあります。いつでも ? を押してください',
            desc: 'Markon はショートカットをワークフローの一部と考えます。どのページでも ? を押すと、現在使える機能とショートカットを確認できます。キー操作の一つひとつが、注意を守ります。',
            link: '/advanced/shortcuts',
          },
        ],
      },
    ],
  },
};
