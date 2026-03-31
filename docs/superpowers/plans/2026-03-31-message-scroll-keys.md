# PageUp/PageDown/End Message Scroll Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者在輸入框 focus 時，能用 PageUp/PageDown/End 鍵快速瀏覽訊息歷史，無需切換焦點。

**Architecture:** 在 ClaudeAgentPanel 的 handleKeyDown 函數中攔截特定按鍵，根據 context（輸入框狀態）決定是否執行訊息滾動，直接操作 messagesContainerRef 的 scrollTop。

**Tech Stack:** React, TypeScript, DOM API

**Design Document:** `docs/design-message-scroll-keys.md`

---

## Task 1: 添加 PageUp 鍵滾動功能

**Files:**
- Modify: `src/components/ClaudeAgentPanel.tsx:1244-1248`

- [ ] **Step 1: 在 handleKeyDown 中添加 PageUp 處理邏輯**

在第 1244 行（Enter 鍵處理之前）插入以下程式碼：

```typescript
    // PageUp: scroll messages up by 85% viewport height
    if (e.key === 'PageUp') {
      e.preventDefault()
      const container = messagesContainerRef.current
      if (container) {
        container.scrollTop -= container.clientHeight * 0.85
      }
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
```

- [ ] **Step 2: 手動測試 PageUp 功能**

測試步驟：
1. `npm run dev` 啟動應用程式
2. 開啟 Claude Agent 面板，發送多條訊息直到需要滾動
3. 點擊輸入框確保 focus
4. 按下 PageUp 鍵

預期結果：
- 訊息視窗向上滾動約 85% 視窗高度
- 輸入框保持 focus
- 游標位置不變

- [ ] **Step 3: 提交 PageUp 功能**

```bash
git add src/components/ClaudeAgentPanel.tsx
git commit -m "feat: add PageUp key to scroll messages up by 85% viewport"
```

---

## Task 2: 添加 PageDown 鍵滾動功能

**Files:**
- Modify: `src/components/ClaudeAgentPanel.tsx:1251-1255`

- [ ] **Step 1: 在 handleKeyDown 中添加 PageDown 處理邏輯**

在 PageUp 處理之後插入以下程式碼：

```typescript
    // PageDown: scroll messages down by 85% viewport height
    if (e.key === 'PageDown') {
      e.preventDefault()
      const container = messagesContainerRef.current
      if (container) {
        container.scrollTop += container.clientHeight * 0.85
      }
      return
    }
```

- [ ] **Step 2: 手動測試 PageDown 功能**

測試步驟：
1. 在輸入框 focus 狀態下，先按 PageUp 向上滾動數次
2. 按下 PageDown 鍵

預期結果：
- 訊息視窗向下滾動約 85% 視窗高度
- 輸入框保持 focus
- 游標位置不變

- [ ] **Step 3: 提交 PageDown 功能**

```bash
git add src/components/ClaudeAgentPanel.tsx
git commit -m "feat: add PageDown key to scroll messages down by 85% viewport"
```

---

## Task 3: 添加 End 鍵條件式滾動功能

**Files:**
- Modify: `src/components/ClaudeAgentPanel.tsx:1258-1264`

- [ ] **Step 1: 在 handleKeyDown 中添加 End 處理邏輯**

在 PageDown 處理之後插入以下程式碼：

```typescript
    // End: scroll to bottom ONLY when input is empty
    if (e.key === 'End' && !inputValueRef.current) {
      const container = messagesContainerRef.current
      if (container) {
        container.scrollTop = container.scrollHeight
      }
      // Fall through to native behavior if input has content
    }
```

**注意**：End 鍵不使用 `preventDefault()`，保留原生游標移動行為。

- [ ] **Step 2: 測試 End 鍵在空輸入框時的行為**

測試步驟：
1. 確保輸入框為空
2. 按 PageUp 向上滾動數次
3. 按下 End 鍵

預期結果：
- 訊息視窗滾動到最底部
- 輸入框保持 focus 且為空

- [ ] **Step 3: 測試 End 鍵在有內容輸入框時的行為**

測試步驟：
1. 在輸入框中輸入多行文字（按 Shift+Enter）
2. 將游標移到文字開頭
3. 按 PageUp 向上滾動訊息
4. 按下 End 鍵

預期結果：
- 游標移到**當前行的行尾**（原生行為）
- 訊息視窗**不滾動**

- [ ] **Step 4: 提交 End 鍵功能**

```bash
git add src/components/ClaudeAgentPanel.tsx
git commit -m "feat: add End key to scroll messages to bottom when input empty"
```

---

## Task 4: 更新 useCallback 依賴陣列

**Files:**
- Modify: `src/components/ClaudeAgentPanel.tsx:1280`

- [ ] **Step 1: 在 handleKeyDown 的依賴陣列中添加 messagesContainerRef**

找到 `handleKeyDown` 的 `useCallback` 結尾（約 1280 行），更新依賴陣列：

```typescript
  }, [handleSend, handlePermissionModeCycle, setInputValue, showSlashMenu, filteredSlashCommands, slashMenuIndex, handleSlashSelect, promptSuggestion, messagesContainerRef])
```

**Why:** 雖然 ref 本身是穩定的，但明確列出依賴可提升程式碼可讀性和 linter 合規性。

- [ ] **Step 2: 檢查是否有 TypeScript 或 ESLint 錯誤**

```bash
npx tsc --noEmit
```

預期結果：無 type errors

- [ ] **Step 3: 提交依賴陣列更新**

```bash
git add src/components/ClaudeAgentPanel.tsx
git commit -m "refactor: add messagesContainerRef to handleKeyDown dependencies"
```

---

## Task 5: 完整功能驗證

**Files:**
- Test: `src/components/ClaudeAgentPanel.tsx` (manual testing)

- [ ] **Step 1: 執行完整的功能測試腳本**

測試場景：

**Scenario 1: PageUp/PageDown 基本功能**
1. 發送 20+ 條訊息讓視窗需滾動
2. 點擊輸入框
3. 按 PageUp → 應向上滾動約 85%
4. 按 PageDown → 應向下滾動約 85%
5. 連續按 PageUp 直到頂部 → 應停在頂部不再滾動
6. 連續按 PageDown 直到底部 → 應停在底部不再滾動

**Scenario 2: End 鍵 context-aware 行為**
1. 輸入框為空，按 PageUp 滾動到中間位置
2. 按 End → 應滾動到訊息底部
3. 在輸入框中輸入 "line1\nline2\nline3"（多行）
4. 將游標移到 line2 的開頭
5. 按 End → 游標應移到 line2 的行尾，訊息視窗**不滾動**

**Scenario 3: Home 鍵保留原生行為**
1. 在輸入框中輸入 "test message"
2. 將游標移到文字中間
3. 按 Home → 游標應移到行首，訊息視窗**不滾動**

**Scenario 4: 與其他快捷鍵不衝突**
1. 按 ArrowUp/ArrowDown → 應正常瀏覽輸入歷史
2. 按 Shift+Tab → 應正常切換 permission mode
3. 按 Enter → 應正常發送訊息
4. 開啟 slash menu（輸入 /），按 ArrowUp/ArrowDown → 應正常導航選單

- [ ] **Step 2: 檢查跨平台相容性（如果可行）**

在 Windows 和 macOS 上測試基本功能（如果雙系統可用）。

預期：在兩個平台上行為一致。

- [ ] **Step 3: 執行 build 確保無 regression**

```bash
npm run build
```

預期結果：
- Build 成功完成
- 無 TypeScript errors
- 無 warnings（或僅有既存的 warnings）

- [ ] **Step 4: 提交驗證記錄**

在設計文件中添加驗證註記：

```bash
echo "## Verification Log

Tested on: $(date +%Y-%m-%d)
Platform: $(uname -s)
Build: ✅ Success

All test scenarios passed." >> docs/design-message-scroll-keys.md

git add docs/design-message-scroll-keys.md
git commit -m "docs: add verification log to message-scroll-keys design"
```

---

## Task 6: 最終審查與文檔更新

**Files:**
- Review: `src/components/ClaudeAgentPanel.tsx:1244-1280`
- Update: `docs/design-message-scroll-keys.md`

- [ ] **Step 1: Code review checklist**

檢查清單：
- [ ] PageUp/PageDown 使用 `preventDefault()`
- [ ] End 鍵**不使用** `preventDefault()`
- [ ] End 鍵有條件判斷 `!inputValueRef.current`
- [ ] Home 鍵**沒有**被處理
- [ ] 所有按鍵處理都有 `return` 或明確的 fall-through
- [ ] 依賴陣列包含 `messagesContainerRef`
- [ ] 程式碼風格與檔案其他部分一致

- [ ] **Step 2: 更新設計文件的實作狀態**

在 `docs/design-message-scroll-keys.md` 結尾添加：

```markdown
---

## 6. 實作狀態

✅ **Implemented** - 2026-03-31

**Commits:**
- feat: add PageUp key to scroll messages up by 85% viewport
- feat: add PageDown key to scroll messages down by 85% viewport
- feat: add End key to scroll messages to bottom when input empty
- refactor: add messagesContainerRef to handleKeyDown dependencies
- docs: add verification log to message-scroll-keys design

**Location:** `src/components/ClaudeAgentPanel.tsx:1244-1280`

**Testing:** Manual testing across all scenarios ✅
```

```bash
git add docs/design-message-scroll-keys.md
git commit -m "docs: mark message-scroll-keys as implemented"
```

- [ ] **Step 3: 最終確認**

執行以下命令確認所有變更已提交：

```bash
git status
git log --oneline -6
```

預期結果：
- Working tree clean
- 可見 6 個新 commits（3 個 feat + 2 個 docs + 1 個 refactor）

---

## Summary

**Total Tasks:** 6
**Total Steps:** 18
**Estimated Time:** 30-45 minutes

**Modified Files:**
- `src/components/ClaudeAgentPanel.tsx` (1 file, ~40 lines added)

**New Behavior:**
- PageUp: 無條件向上滾動 85% 視窗高度
- PageDown: 無條件向下滾動 85% 視窗高度
- End: 僅在輸入框為空時滾動到底部
- Home: 保留原生行為（不處理）

**Design Principles Applied:**
- Context-aware behavior
- YAGNI (只實作必要功能，Home 不處理)
- DRY (重用現有 ref，不建立新狀態)
- Frequent commits (每個按鍵一個 commit)
