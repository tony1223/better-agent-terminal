# PageUp/Down/Home/End 訊息視窗滾動 — 設計思路

## 1. 初始設計 (d20fcc1)

### 目標
讓使用者在輸入框 focus 時，也能用鍵盤快速瀏覽訊息歷史，不需手動點擊或切換焦點到訊息區。

### 實作策略

| 按鍵 | 行為 | preventDefault | 原因 |
|------|------|----------------|------|
| **PageUp** | 向上滾動 85% 視窗高度 | ✅ | textarea 無預設行為，完全攔截 |
| **PageDown** | 向下滾動 85% 視窗高度 | ✅ | 同上 |
| **Home** | 滾動到訊息最頂部 | ❌ | 保留游標移到行首的原生行為 |
| **End** | 滾動到訊息最底部 | ❌ | 保留游標移到行尾的原生行為 |

### 技術細節
- 滾動量設定為 `container.clientHeight * 0.85`，與常見分頁滾動一致
- 使用 `messagesContainerRef.current.scrollTop` 直接操作 DOM
- Home/End 不 preventDefault，試圖兼顧雙重功能（游標移動 + 訊息滾動）

---

## 2. 修正設計 (0b05594)

### 發現的問題
1. **Home 鍵衝突**：使用者在多行輸入時按 Home 想移到行首，訊息卻同時跳到頂部，產生困擾
2. **End 鍵語意不明**：有輸入內容時，使用者更常想「移游標到行尾」而非「滾動訊息到底」

### 解決方案

| 按鍵 | 新行為 | 判斷條件 |
|------|--------|----------|
| **Home** | 完全移除訊息滾動功能 | — |
| **End** | 僅在輸入框為空時滾動訊息 | `!inputValueRef.current` |

### 設計邏輯

```typescript
if (e.key === 'End' && !inputValueRef.current) {
  // 輸入框為空 → 滾動訊息到底部
  if (container) container.scrollTop = container.scrollHeight
}
// 有輸入內容時 → fall through 到原生行為（游標移到行尾）
```

---

## 3. 核心設計原則

### Context-aware 行為
根據輸入框狀態（空 vs 有內容）動態調整按鍵語意，避免單一按鍵同時觸發兩種功能

### 使用者意圖推斷
- **輸入框為空** → 使用者可能在瀏覽歷史訊息
- **輸入框有內容** → 使用者在編輯文字，快捷鍵應服務編輯需求

### 漸進式優化
先實作完整功能（4 個按鍵都支援），再根據實際衝突回退不合理的部分，而非一開始就過度保守

### 保留原生行為
不破壞 textarea 的基本編輯體驗（Home/End 移動游標）

---

## 4. 最終狀態

- **PageUp/PageDown**：無條件滾動訊息（85% 視窗高度）
- **End**：僅在輸入框為空時滾動到底部
- **Home**：完全回歸原生行為（移游標到行首）

---

## 5. 相關 Commits

- `d20fcc1` - feat: PageUp/Down/Home/End scroll message window from input
- `0b05594` - fix: Home no longer scrolls messages; End only scrolls when input empty

---

## 總結

這個設計在「快速瀏覽」與「文字編輯」之間取得平衡，避免快捷鍵衝突影響使用體驗。核心策略是根據輸入框狀態智慧判斷使用者意圖，讓同一個按鍵在不同 context 下執行最合理的行為。

---

## 6. 實作狀態

✅ **Implemented** - 2026-03-31

**Commits:**
- feat: add PageUp key to scroll messages up by 85% viewport
- feat: add PageDown key to scroll messages down by 85% viewport
- feat: add End key to scroll messages to bottom when input empty
- refactor: add messagesContainerRef to handleKeyDown dependencies

**Location:** `src/components/ClaudeAgentPanel.tsx:1245-1275`

**Testing:** Manual testing required ⏳
**Build:** ✅ Success
