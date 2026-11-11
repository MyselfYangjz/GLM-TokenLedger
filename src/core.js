(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BillCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const clean = value => String(value ?? '').trim();
  const required = ['账单号', 'apiKey', '产品类型', '用量', '用量单位', '消费时间'];

  function dateOnly(value) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 1 || value > 2958465) return null;
      value = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
    }
    if (value instanceof Date) {
      if (Number.isNaN(value.valueOf())) return null;
      value = `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
    }
    const match = clean(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?=$|[\sT])/);
    if (!match) return null;
    const [, y, m, d] = match;
    const date = new Date(Date.UTC(+y, +m - 1, +d));
    if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d) return null;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  function normalizeSheet(grid, sheetName) {
    const headerIndex = grid.slice(0, 30).findIndex(row => required.every(name => row.map(clean).includes(name)));
    if (headerIndex < 0) return null;
    const headers = grid[headerIndex].map(clean);
    if (required.some(name => headers.filter(h => h === name).length !== 1)) {
      throw new Error(`工作表「${sheetName}」有重复表头，请检查原始账单。`);
    }
    const indices = Object.fromEntries(headers.map((name, index) => [name, index]));
    const records = [];
    let totalRows = 0;
    let excludedRows = 0;
    for (let i = headerIndex + 1; i < grid.length; i++) {
      const values = grid[i];
      if (values.every(v => clean(v) === '')) continue;
      totalRows++;
      const get = name => values[indices[name]];
      if (clean(get('产品类型')) !== '模型推理') { excludedRows++; continue; }
      const fail = reason => { throw new Error(`工作表「${sheetName}」第 ${i + 1} 行：${reason}，本文件未导入。`); };
      const id = clean(get('账单号'));
      const key = clean(get('apiKey'));
      if (!id || !key) fail('账单号或 API key 为空');
      if (!/^tokens?$/i.test(clean(get('用量单位')))) fail('模型推理的用量单位必须为 token');
      const usage = clean(get('用量'));
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(usage)) fail('用量不是有效数字');
      const tokens = Number(usage);
      if (!Number.isSafeInteger(tokens)) fail('用量必须是安全范围内的整数 token');
      const date = dateOnly(get('消费时间'));
      if (!date) fail('消费日期无效');
      const parts = clean(get('消费时间')).split(/\s*[~～至]\s*/);
      if (parts.length > 1 && dateOnly(parts[1]) !== date) fail('消费时间跨越多个自然日，无法按日准确统计');
      const kind = clean(get('价格类型'));
      const model = clean(get('模型编码（推理专用）')) || clean(get('模型产品编码'));
      const signature = JSON.stringify([key, date, tokens, kind, model]);
      records.push({ id, key, date, tokens, kind, model, signature, sheet: sheetName, row: i + 1 });
    }
    return { records, totalRows, excludedRows };
  }

  function parseWorkbook(XLSX, buffer) {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
    const result = { records: [], totalRows: 0, excludedRows: 0, sheetCount: 0 };
    for (const name of workbook.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: true });
      const sheet = normalizeSheet(grid, name);
      if (!sheet) continue;
      result.records.push(...sheet.records);
      result.totalRows += sheet.totalRows;
      result.excludedRows += sheet.excludedRows;
      result.sheetCount++;
    }
    if (!result.sheetCount) throw new Error(`找不到有效账单表头，需要：${required.join('、')}。`);
    return result;
  }

  function aggregate(bills, options = {}) {
    const { start = '', end = '', mappings = {}, query = '' } = options;
    if ((start && !dateOnly(start)) || (end && !dateOnly(end))) throw new Error('请选择有效日期。');
    if (start && end && start > end) throw new Error('开始日期不能晚于结束日期。');
    const seen = new Map();
    const conflicts = [];
    let duplicates = 0;
    for (const bill of bills.filter(b => b.selected !== false)) {
      for (const record of bill.records) {
        const prior = seen.get(record.id);
        if (prior) {
          if (prior.record.signature === record.signature) duplicates++;
          else conflicts.push({ id: record.id, first: prior.bill, second: bill.name, row: record.row });
        } else seen.set(record.id, { record, bill: bill.name });
      }
    }
    if (conflicts.length) return { rows: [], tokens: 0, count: 0, duplicates, conflicts, dates: [] };
    const groups = new Map();
    const dates = new Set();
    let count = 0;
    for (const { record } of seen.values()) {
      dates.add(record.date);
      if ((start && record.date < start) || (end && record.date > end)) continue;
      count++;
      groups.set(record.key, (groups.get(record.key) || 0) + record.tokens);
      if (!Number.isSafeInteger(groups.get(record.key))) throw new Error('累计用量超过可精确计算范围，请缩小统计区间。');
    }
    const search = clean(query).toLowerCase();
    const rows = [...groups].map(([key, tokens]) => ({ key, name: clean(Object.hasOwn(mappings, key) ? mappings[key] : ''), tokens }))
      .filter(row => !search || row.key.toLowerCase().includes(search) || row.name.toLowerCase().includes(search))
      .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
    const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
    if (!Number.isSafeInteger(tokens)) throw new Error('累计用量超过可精确计算范围，请缩小统计区间。');
    return { rows, tokens, count, duplicates, conflicts, dates: [...dates].sort() };
  }

  function formatUsage(tokens, unit = 'K', useGrouping = true) {
    const decimals = unit === 'M' ? 6 : 3;
    return (tokens / (unit === 'M' ? 1000000 : 1000)).toLocaleString('en-US', {
      useGrouping,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }
  function formatPercentage(value, useGrouping = true) {
    return Number(value).toLocaleString('en-US', { useGrouping, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return { dateOnly, normalizeSheet, parseWorkbook, aggregate, formatUsage, formatPercentage };
});
