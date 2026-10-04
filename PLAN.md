# Better Terminal - Windows 終端聚合程式實作計畫（歷史文件）

> 本文保留最初的 Electron 架構與實作規劃，供歷史參考。BAT 自 3.0 起採用 Rust/Tauri host、React renderer 與 Node SDK sidecar；下方的目錄、依賴及安裝步驟屬於當時的設計。現行架構與開發方式請見 [README](README.md)，專案操作規則請見 [AGENTS.md](AGENTS.md) 與 [CLAUDE.md](CLAUDE.md)。

## 專案概述
一個 Windows 終端聚合程式，支援多工作區管理，每個工作區包含一個 Claude Code 實例和多個可多開的 Terminal。

## 技術選型
- **框架**: Electron + React + TypeScript
- **終端模擬**: xterm.js + node-pty
- **UI**: 簡單 CSS（或可選 Tailwind）
- **持久化**: 本地 JSON 檔案

## 專案結構
```
better-terminal/
├── package.json
├── tsconfig.json
├── electron/
│   ├── main.ts              # Electron 主進程
│   ├── preload.ts           # 預載腳本（IPC bridge）
│   └── pty-manager.ts       # PTY 進程管理
├── src/
│   ├── index.html
│   ├── main.tsx             # React 入口
│   ├── App.tsx              # 主應用元件
│   ├── types/
│   │   └── index.ts         # TypeScript 類型定義
│   ├── stores/
│   │   └── workspace-store.ts  # 工作區狀態管理
│   ├── components/
│   │   ├── Sidebar.tsx            # 工作區列表側邊欄
│   │   ├── WorkspaceView.tsx      # 單一工作區視圖（主區域+小視窗）
│   │   ├── MainPanel.tsx          # 主區域（70%）終端顯示
│   │   ├── ThumbnailBar.tsx       # 小視窗列（30%）
│   │   ├── TerminalThumbnail.tsx  # 小視窗縮圖（含 mini preview）
│   │   ├── TerminalPanel.tsx      # xterm.js 終端面板
│   │   └── CloseConfirmDialog.tsx # Claude Code 關閉確認
│   └── styles/
│       └── main.css
└── config/
    └── workspaces.json      # 持久化的工作區設定
```

## 核心資料模型

```typescript
interface Workspace {
  id: string;
  name: string;
  folderPath: string;
  createdAt: number;
}

interface TerminalInstance {
  id: string;
  workspaceId: string;
  type: 'terminal' | 'claude-code';
  title: string;
  pid?: number;
  cwd: string;                    // 當前工作目錄（用於重啟時恢復）
  scrollbackBuffer: string[];     // 歷史輸出（重啟後保留顯示）
}

interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  terminals: TerminalInstance[];
  activeTerminalId: string | null;
}
```

## IPC 通訊設計

### 主進程 → 渲染進程
- `pty:output` - 終端輸出資料
- `pty:exit` - 終端進程結束

### 渲染進程 → 主進程
- `pty:create` - 建立新 PTY (terminal 或 claude-code)
- `pty:write` - 寫入終端
- `pty:resize` - 調整終端大小
- `pty:kill` - 終止終端（Claude Code 需確認）
- `pty:restart` - 重啟終端（保留 cwd 和歷史輸出）
- `pty:get-cwd` - 取得終端當前工作目錄
- `workspace:save` - 保存工作區設定
- `workspace:load` - 載入工作區設定
- `dialog:select-folder` - 選擇資料夾對話框

## 實作步驟

### Step 1: 初始化專案
- 建立 package.json
- 安裝依賴：electron, react, xterm, node-pty, typescript 等
- 設定 TypeScript 和建置工具

### Step 2: Electron 主進程
- 建立視窗
- 設定 preload 腳本
- 實作 PTY 管理器（node-pty）

### Step 3: React 基礎架構
- 建立 App 元件和路由
- 實作工作區狀態管理
- 建立基礎 UI 佈局

### Step 4: 終端元件
- 整合 xterm.js
- 實作終端捲動（scrollback）
- 連接 IPC 進行輸入輸出

### Step 5: 工作區管理
- 側邊欄工作區列表
- 新增/刪除/切換工作區
- 資料夾選擇器

### Step 6: Claude Code 整合
- 識別 Claude Code 終端類型
- 關閉時顯示確認對話框
- 特殊標記顯示

### Step 7: 持久化
- 保存工作區設定到 JSON
- 啟動時自動載入

### Step 8: 優化
- 終端分頁 UI
- 快捷鍵支援
- 錯誤處理

## 所需套件

```json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "xterm": "^5.3.0",
    "xterm-addon-fit": "^0.8.0",
    "node-pty": "^1.0.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.2.0",
    "electron-builder": "^24.0.0",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@types/node": "^20.0.0",
    "@types/uuid": "^9.0.0"
  }
}
```

## UI 佈局設計（分割面板風格）

**設計理念**：主區域 (70%) + 小視窗 (30%)，類似視訊會議的分割畫面

### 情境 A：Terminal 是焦點（最常見）
- 主區域：當前操作的 Terminal
- 小視窗：**固定只顯示 Claude Code**（隨時監控進度）

```
┌─────────────────────────────────────────────────────────┐
│  Better Terminal                              [─][□][×] │
├──────────┬──────────────────────────────────────────────┤
│ 工作區   │  ┌────────────────────────────────────────┐  │
│          │  │  Terminal 1（主區域 70%）               │  │
│ ▶ Work1  │  │                                        │  │
│   Work2  │  │  $ npm test                            │  │
│          │  │  PASS  all tests passed                │  │
│          │  │  $ _                                   │  │
│          │  │                                        │  │
│          │  └────────────────────────────────────────┘  │
│          │  ┌─────────────────────┐                     │
│ [+ 新增] │  │ Claude Code ✦ (30%) │ ← 固定在此監控進度  │
│          │  │ > 正在修改檔案...   │                     │
│          │  └─────────────────────┘                     │
└──────────┴──────────────────────────────────────────────┘
```

### 情境 B：Claude Code 是焦點
- 主區域：Claude Code
- 小視窗：Terminal 1, Terminal 2, ... [+新增]

```
┌─────────────────────────────────────────────────────────┐
│  Better Terminal                              [─][□][×] │
├──────────┬──────────────────────────────────────────────┤
│ 工作區   │  ┌────────────────────────────────────────┐  │
│          │  │  Claude Code ✦（主區域 70%）           │  │
│ ▶ Work1  │  │                                        │  │
│   Work2  │  │  $ claude                              │  │
│          │  │  > 分析完成，建議修改以下檔案：          │  │
│          │  │  > - src/App.tsx                       │  │
│          │  │  > - src/utils.ts                      │  │
│          │  └────────────────────────────────────────┘  │
│          │  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────┐  │
│ [+ 新增] │  │ Term 1 │ │ Term 2 │ │ Term 3 │ │  +   │  │
│          │  │ $ _    │ │ $ npm  │ │ $ git  │ │ 新增 │  │
│          │  └────────┘ └────────┘ └────────┘ └──────┘  │
└──────────┴──────────────────────────────────────────────┘
```

### 互動邏輯
1. 點擊 Claude Code 小視窗 → Claude Code 放大到主區域，Terminal 們顯示在下方
2. 點擊任一 Terminal 小視窗 → 該 Terminal 放大到主區域，Claude Code 固定在下方小視窗
3. 小視窗內即時顯示終端輸出內容（mini preview）
4. 主區域可任意捲動查看歷史

### Terminal 重啟功能
每個 Terminal 都有重啟按鈕，重啟時：
1. **記住當前工作目錄** - 透過 `pty:get-cwd` 取得（或追蹤 cd 指令）
2. **保留歷史輸出** - 將 scrollback buffer 暫存
3. **重啟流程**：
   - 終止舊 PTY 進程
   - 建立新 PTY 進程，cwd 設為記住的目錄
   - 在新終端最上方顯示分隔線 `──── 已重啟 ────`
   - 將舊的歷史輸出顯示在分隔線上方（淡色/可折疊）
4. **UI**：主區域右上角顯示 `[⟳ 重啟]` 按鈕

```
┌────────────────────────────────────────┐
│  Terminal 1                    [⟳][×] │  ← 重啟和關閉按鈕
├────────────────────────────────────────┤
│  (舊的歷史輸出，淡色顯示)              │
│  $ npm install                         │
│  $ cd src                              │
│  ──────────── 已重啟 ────────────      │
│  $ _                                   │  ← 新的 shell，cwd = src/
└────────────────────────────────────────┘
```
