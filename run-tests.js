#!/usr/bin/env node
/**
 * 假期存摺 — 自動化測試套件
 * =========================
 * 怎麼用：
 *   node tests/run-tests.js
 *   (或指定檔案位置) node tests/run-tests.js ../index.html
 *
 * 這份測試不會碰你的真實資料、不會連網路、不會動到 Firebase，
 * 純粹把 index.html 裡的 <script> 邏輯抓出來，在 Node 環境裡跑過一遍，
 * 檢查核心計算（天數換算、額度、先進先出扣抵、關鍵字解析…）有沒有跟預期一樣。
 *
 * 每次要上傳新版 index.html 之前，建議先跑一次這個檔案，
 * 如果哪個測試變成 ✗ 失敗，代表這次改動可能把舊功能弄壞了，先不要急著上傳。
 *
 * 這份檔案只涵蓋「算得對不對」這種純邏輯，不會去檢查畫面排版好不好看
 * （排版還是要靠人眼看手機截圖確認）。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const targetPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(__dirname, '..', 'index.html');

if (!fs.existsSync(targetPath)) {
  console.error(`找不到檔案：${targetPath}`);
  process.exit(1);
}

const html = fs.readFileSync(targetPath, 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.error('在 index.html 裡找不到 <script> 區塊，測試無法執行。');
  process.exit(1);
}

// ---- 最小限度的瀏覽器環境模擬（只求程式碼載入時不要噴錯，不求畫面正確） ----
const fakeStorage = {};
const domStub = {
  getElementById: () => ({ value: '', innerHTML: '', style: {}, textContent: '', className: '', disabled: false }),
  querySelectorAll: () => [],
  addEventListener: () => {},
};
const windowStub = {
  scrollTo: () => {},
  alert: () => {},
  confirm: () => true,
  prompt: () => null,
  addEventListener: () => {},
  location: { href: 'https://ksepb.github.io/leave-passbook/' },
  history: { replaceState: () => {} },
  localStorage: {
    getItem: (k) => (k in fakeStorage ? fakeStorage[k] : null),
    setItem: (k, v) => { fakeStorage[k] = String(v); },
    removeItem: (k) => { delete fakeStorage[k]; },
  },
};

const sandbox = {
  document: domStub,
  window: windowStub,
  localStorage: windowStub.localStorage,
  navigator: { onLine: true, serviceWorker: undefined, share: undefined, canShare: undefined },
  fetch: async () => { throw new Error('測試環境不允許真的連網路'); },
  console,
  setTimeout,
  clearTimeout,
  Date,
};

const vm = require('vm');
const context = vm.createContext(sandbox);
try {
  vm.runInContext(scriptMatch[1], context, { filename: 'index.html-inline-script.js' });
} catch (e) {
  console.error('載入 index.html 的程式碼時發生錯誤，測試無法繼續：');
  console.error(e);
  process.exit(1);
}

// ---- 簡易測試框架 ----
let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function group(title, fn) {
  console.log(`\n${title}`);
  fn();
}

// 方便測試用：把 state 重置成乾淨狀態
// 注意：index.html 裡的 state / selectedYear 是用 let 宣告的區塊變數，
// 不能直接用 context.state = ... 賦值（那樣只會在 context 物件上加一個沒用的屬性，
// 不會真的改到程式碼內部函式關閉作用域(closure)所參照的那個 state）。
// 必須把賦值語法也丟進同一個 vm context 執行，才能真的改到。
function resetState(overrides) {
  const merged = Object.assign(
    {
      quotaByYear: {},
      records: {},
      compRecords: [],
      hoursPerDay: 8,
      personalPaidDays: 7,
      uiScale: 1,
      annualMinDays: 10,
    },
    overrides || {}
  );
  vm.runInContext(`state = ${JSON.stringify(merged)};`, context);
}
function setSelectedYear(y) {
  vm.runInContext(`selectedYear = ${y};`, context);
}

console.log(`測試對象：${targetPath}`);
console.log('='.repeat(50));

// ============================================================
group('① 天數／小時換算', () => {
  test('toDays：天為單位直接回傳', () => {
    assert.strictEqual(context.toDays({ unit: 'day', amount: 2 }), 2);
  });
  test('toDays：小時換算成天（8小時制）', () => {
    context.state = { hoursPerDay: 8 };
    assert.strictEqual(context.toDays({ unit: 'hour', amount: 4 }), 0.5);
  });
  test('displayAmount：小時單位顯示格式正確', () => {
    assert.strictEqual(context.displayAmount({ unit: 'hour', amount: 4 }), '4 小時');
  });
  test('displayAmount：天單位顯示格式正確', () => {
    assert.strictEqual(context.displayAmount({ unit: 'day', amount: 1.5 }), '1.5 天');
  });
});

// ============================================================
group('② 假別額度與剩餘天數計算', () => {
  test('usedOf：一般假別加總正確', () => {
    resetState({
      records: {
        annual: [
          { id: 'a1', date: '2026-03-01', unit: 'day', amount: 1 },
          { id: 'a2', date: '2026-05-01', unit: 'day', amount: 0.5 },
        ],
      },
    });
    setSelectedYear(2026);
    assert.strictEqual(context.usedOf('annual', 2026), 1.5);
  });
  test('usedOf：生理假超過 3 天會併入病假', () => {
    resetState({
      records: {
        menstrual: [{ id: 'm1', date: '2026-01-01', unit: 'day', amount: 5 }],
        sick: [],
      },
    });
    setSelectedYear(2026);
    // 超過 MENSTRUAL_FREE_DAYS(3) 的 2 天，應該被算進病假已使用
    assert.strictEqual(context.usedOf('sick', 2026), 2);
  });
  test('usedOf：家庭照顧假全額併入事假', () => {
    resetState({
      records: {
        familyCare: [{ id: 'f1', date: '2026-01-01', unit: 'day', amount: 1 }],
        personal: [],
      },
    });
    setSelectedYear(2026);
    assert.strictEqual(context.usedOf('personal', 2026), 1);
  });
  test('remainOf：剩餘天數 = 總天數 - 已使用', () => {
    resetState({
      quotaByYear: { 2026: { annual: 7 } },
      records: { annual: [{ id: 'a1', date: '2026-01-01', unit: 'day', amount: 2 }] },
    });
    setSelectedYear(2026);
    assert.strictEqual(context.remainOf('annual', 2026), 5);
  });
});

// ============================================================
group('③ 補休／換休：先進先出扣抵邏輯', () => {
  test('用掉的天數優先扣最早獲得的那筆', () => {
    resetState({
      compRecords: [
        { id: 'e1', category: 'comp', type: 'earn', date: '2026-01-01', unit: 'day', amount: 2, expiry: '2028-01-01' },
        { id: 'e2', category: 'comp', type: 'earn', date: '2026-03-01', unit: 'day', amount: 2, expiry: '2028-03-01' },
        { id: 'u1', category: 'comp', type: 'use', date: '2026-06-01', unit: 'day', amount: 2 },
      ],
    });
    const batches = context.compFifoRemaining('comp');
    const e1 = batches.find((b) => b.id === 'e1');
    const e2 = batches.find((b) => b.id === 'e2');
    assert.strictEqual(e1.remainDays, 0, '最早那筆應該被扣完');
    assert.strictEqual(e2.remainDays, 2, '比較晚的那筆應該完全沒被動到');
  });
  test('手動指定批次不夠扣時，自動接回先進先出補足', () => {
    resetState({
      compRecords: [
        { id: 'e1', category: 'comp', type: 'earn', date: '2026-01-01', unit: 'day', amount: 1, expiry: '2028-01-01' },
        { id: 'e2', category: 'comp', type: 'earn', date: '2026-03-01', unit: 'day', amount: 2, expiry: '2028-03-01' },
        { id: 'u1', category: 'comp', type: 'use', date: '2026-06-01', unit: 'day', amount: 2, sourceEarnId: 'e1' },
      ],
    });
    const batches = context.compFifoRemaining('comp');
    const e1 = batches.find((b) => b.id === 'e1');
    const e2 = batches.find((b) => b.id === 'e2');
    assert.strictEqual(e1.remainDays, 0, '指定的那批（只有1天）應該被扣完');
    assert.strictEqual(e2.remainDays, 1, '缺口 1 天應該自動從下一批扣');
  });
  test('已經完全用完的批次，剩餘量不會變成負數', () => {
    resetState({
      compRecords: [
        { id: 'e1', category: 'comp', type: 'earn', date: '2026-01-01', unit: 'day', amount: 1, expiry: '2028-01-01' },
        { id: 'u1', category: 'comp', type: 'use', date: '2026-06-01', unit: 'day', amount: 5 },
      ],
    });
    const batches = context.compFifoRemaining('comp');
    const e1 = batches.find((b) => b.id === 'e1');
    assert.strictEqual(e1.remainDays, 0, '扣過頭也應該停在 0，不會變負數');
  });
  test('compBalanceAsOf：日期精確計算，抓出使用日期比獲得日期早的情況', () => {
    resetState({
      compRecords: [
        { id: 'e1', category: 'exchange', type: 'earn', date: '2026-08-07', unit: 'day', amount: 1 },
      ],
    });
    // 在還沒有任何獲得紀錄之前（7/1），結餘應該是 0，不是把之後才有的獲得也算進去
    const bal = context.compBalanceAsOf('exchange', '2026-07-01', null);
    assert.strictEqual(bal, 0);
  });
});

// ============================================================
group('④ 關鍵字快速輸入解析', () => {
  test('單一日期＋假別＋天數', () => {
    setSelectedYear(2026);
    const { items, unmatched } = context.parseKeywordLines('8/10 特休1天（回診）', 'earn');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(unmatched.length, 0);
    assert.strictEqual(items[0].leaveKey, 'annual');
    assert.strictEqual(items[0].amount, 1);
    assert.strictEqual(items[0].note, '回診');
  });
  test('沒寫天數時預設為 1 天', () => {
    setSelectedYear(2026);
    const { items } = context.parseKeywordLines('8/10 特休（回診）', 'earn');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].amount, 1);
  });
  test('日期後面沒有空格也能辨識', () => {
    setSelectedYear(2026);
    const { items } = context.parseKeywordLines('2/26補休', 'earn');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'comp');
  });
  test('日期區間會展開成每天一筆', () => {
    setSelectedYear(2026);
    const { items } = context.parseKeywordLines('7/23-7/25 特休1天（返鄉）', 'earn');
    assert.strictEqual(items.length, 3, '7/23、7/24、7/25 應該各一筆');
  });
  test('看不懂的格式會放進 unmatched，不會亂猜', () => {
    setSelectedYear(2026);
    const { items, unmatched } = context.parseKeywordLines('這是一段亂打的文字', 'earn');
    assert.strictEqual(items.length, 0);
    assert.strictEqual(unmatched.length, 1);
  });
});

// ============================================================
group('⑤ 日期格式轉換', () => {
  test('西元轉民國格式', () => {
    assert.strictEqual(context.toROC('2026-08-07'), '115/8/7');
  });
  test('addYears：年份加減正確', () => {
    assert.strictEqual(context.addYears('2026-08-07', 2), '2028-08-07');
  });
  test('isoDate：組合出正確的西元日期字串', () => {
    assert.strictEqual(context.isoDate(2026, 8, 7), '2026-08-07');
  });
});

// ============================================================
console.log('\n' + '='.repeat(50));
console.log(`結果：${pass} 通過、${fail} 失敗（共 ${pass + fail} 項）`);

if (fail > 0) {
  console.log('\n失敗的測試：');
  failures.forEach((f) => console.log(`  - ${f.name}：${f.error.message}`));
  process.exit(1);
} else {
  console.log('\n全部通過 ✓ 可以放心上傳這個版本。');
  process.exit(0);
}
