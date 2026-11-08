# LocalDesk 來源發布

[English](RELEASE.md) · [简体中文](RELEASE.zh-CN.md)

LocalDesk 原創程式與文件採 MIT，著作權為 2026 LocalDesk contributors。
內附的修改字型與另行取得的相依套件保留各自條款。請保留 LICENSE、NOTICE.md
及完整字型／聲明目錄。產生匯出不會公開儲存庫、變更遠端可見性或更新正式服務。

## 內容與功能

來源 ZIP 只包含 public-source.json 明列的目標檔案與 candidate-receipt.json：
程式碼、空白來源預設、合成測試、manifest／鎖定檔、MIT／來源聲明與選用像素字型。
不含 Git 歷史、私人覆寫、帳號／對話、Local 資料、node_modules、快取、前端 dist、
原生工具或 source map。私人歷史另行保留；散布此整理後的來源無須重寫原歷史。

設定可即時接入／拔除工作區及專案來源，並持久保存連線狀態。拔除後停止新讀取與
來源工作，歷史保留。排隊／執行中的工作會阻擋拔除，可到活動頁停止。
已拔除與來源不存在有不同狀態；更換來源路徑仍需重啟。可攜預設不選模型。

## 重現與驗證

在來源儲存庫執行 deno task source-check --index 檢查具名來源與索引內容； deno
task source-export --index 在忽略的 Local/public-candidates/ 產生來源封存、 ZIP
與 .zip.sha256。ZIP 固定根目錄為 localdesk-source/，時間戳正規化，
逐項讀回內容、權限、清單與 receipt；既有產物不符時會拒絕覆寫。封存器僅需 Python
3 標準庫。

將 ZIP 的 SHA-256 與另行提供的預期值比對。解壓後的驗證器無須 Git 歷史或準備庫：

```sh
shasum -a 256 /path/to/candidate.zip
python3 scripts/public_source.py --verify-archive /path/to/candidate.zip --sha256 EXPECTED_HASH
```

驗證器拒絕重複、額外、越界、私人路徑、內容／權限改變、符號連結與超大項目；
單檔上限 2 MiB、4096 個項目，壓縮及解壓總量上限 64 MiB。 Receipt
綁定檔案雜湊與權限；雜湊不是作者簽章或全面權利保證。

解壓至其他儲存庫以外，再以固定版本套件管理器執行：

```sh
pnpm --dir frontend install --frozen-lockfile --ignore-scripts
pnpm --dir frontend build
deno task check
deno lint backend scripts tests
deno task test
```

合成專案測試與產品 Git 功能仍需要 Git 執行檔，但來源本身不需 .git 目錄。
首次凍結安裝／取得相依需要網路；pnpm 版本與兩份鎖定檔保持固定。 建置會保留 App
原創 LICENSE.txt／NOTICE.txt，產生實際打包程式的
THIRD-PARTY-LICENSES.md，以及字型／聲明； 散布前端建置時須一併保留。此 ZIP
不含前端建置或工具二進位。

## 範圍與待決事項

已驗主機為 macOS。未變更功能沿用既有來源開關 UI／執行證據；本次另驗新封存、
全新相依安裝／建置與合成流程，不宣稱真模型請求、其他系統／裝置、重開機或正式服務升級。
相依清單是官方授權宣告核對，並非未附帶平台二進位的全面法律審查；日後打包工具或
二進位須另查實際產物。公開發布及遠端寫入仍需另行決定。LocalDesk 的 MIT 不改變
原始來源儲存庫的授權或公開狀態。
