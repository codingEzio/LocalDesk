# LocalDesk 0.2.1 — 已备妥的源码候选

[English](RELEASE.md) · [繁體中文](RELEASE.zh-TW.md)

LocalDesk 原创代码和文档采用 MIT，版权为 2026 LocalDesk contributors。
内附的修改字体和另行获取的依赖保留各自条款。请保留 LICENSE、NOTICE.md
和完整字体／声明目录。这次准备不代表已公开仓库、更改远程可见性或更新正式服务。

## 内容与功能

源码 ZIP 只包含 public-source.json 明列的目标文件和 candidate-receipt.json：
代码、空白来源默认值、合成测试、manifest／锁定文件、MIT／来源声明和可选像素字体。
不含 Git 历史、私人覆盖、账号／对话、Local 数据、node_modules、缓存、前端 dist、
原生工具或 source map。私人历史另行保留；分发此整理后的源码无须重写原历史。

设置可即时接入／拔除工作区和项目来源，并持久保存连接状态。拔除后停止新读取和
来源任务，历史保留。排队／运行中的任务会阻挡拔除，可到活动页停止。
已拔除和来源不存在有不同状态；更改来源路径仍需重启。可移植默认配置不选模型。

## 复现与验证

在准备仓库执行 deno task source-check --index 检查具名源码和索引内容； deno task
source-export --index 在忽略的 Local/public-candidates/ 生成源码封存、 ZIP 和
.zip.sha256。ZIP 固定根目录为 localdesk-source/，时间戳规范化，
逐项读回内容、权限、清单和 receipt；既有产物不符时拒绝覆盖。归档器只需 Python 3
标准库。

将 ZIP 的 SHA-256 与另行提供的预期值比对。解压后的验证器无须 Git
历史或准备仓库：

```sh
shasum -a 256 /path/to/candidate.zip
python3 scripts/public_source.py --verify-archive /path/to/candidate.zip --sha256 EXPECTED_HASH
```

验证器拒绝重复、额外、越界、私人路径、内容／权限改变、符号链接和超大条目；
单文件上限 2 MiB、4096 个条目，压缩和解压总量上限 64 MiB。 Receipt
绑定文件哈希和权限；哈希不是作者签名或全面权利保证。

解压到其他仓库之外，再用固定版本包管理器执行：

```sh
pnpm --dir frontend install --frozen-lockfile --ignore-scripts
pnpm --dir frontend build
deno task check
deno lint backend scripts tests
deno task test
```

合成项目测试和产品 Git 功能仍需要 Git 可执行文件，但源码本身不需 .git 目录。
首次冻结安装／获取依赖需要网络；pnpm 版本和两份锁定文件保持固定。 构建会保留 App
原创 LICENSE.txt／NOTICE.txt，生成实际打包代码的
THIRD-PARTY-LICENSES.md，以及字体／声明； 分发前端构建时须一并保留。此 ZIP
不含前端构建或工具二进制文件。

## 范围与待决事项

已验证主机为 macOS。未更改功能沿用既有来源开关 UI／运行证据；本次另验新归档、
全新依赖安装／构建和合成流程，不宣称真实模型请求、其他系统／设备、重启或正式服务升级。
依赖清单是官方许可声明核对，并非未附带平台二进制文件的全面法律审查；日后打包工具或
二进制文件须另查实际产物。公开发布和远程写入仍须另行决定。LocalDesk 的 MIT
不改变 原始来源仓库的许可或公开状态。
