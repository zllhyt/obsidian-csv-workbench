# CSV Workbench

Obsidian 插件：把 CSV 当 Excel 表格编辑，文件始终是仓库里的 UTF-8 文本。任意编辑器或 Agent 都可以直接读写同一份 `.csv`。

## 功能

- 把 `.csv` / `.tsv` 拖进笔记，写入仓库并插入 `![[file.csv]]`
- 同名文件复用，不生成 `coverage 1.csv` 这类副本
- Excel 风格网格，嫩粉色表头，可编辑单元格
- 增删行列、排序、筛选、撤销重做、复制粘贴
- `Ctrl/Cmd+S` 保存写回原文件；外部程序改完后可点「重载」

## 安装

### 手动安装

1. 下载本仓库，或从 [Releases](https://github.com/zllhyt/obsidian-csv-workbench/releases) 取 `main.js`、`manifest.json`、`styles.css`
2. 放到你的库：`.obsidian/plugins/csv-workbench/`
3. 重载 Obsidian，在第三方插件里启用 **CSV Workbench**
4. 设置 → 文件与链接 → 打开「检测所有文件扩展名」

### [BRAT](https://github.com/TfTHacker/obsidian42-brat)

Add community plugin beta → `zllhyt/obsidian-csv-workbench`

## 对 Agent

CSV 是普通 UTF-8 文本。用读/写文件工具直接改 `.csv` 路径，不要誊成 Markdown 表。

## License

MIT
