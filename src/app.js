(async function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  };
  let state = { bills: [], mappings: {}, unit: 'K', start: '', end: '' };
  let db;
  let busy = false;
  let saveQueue = Promise.resolve();
  let toastTimer;
  let latestResult;
  let selectedMappingName = '';
  const mappingStore = new ProjectMappings.FileStore();
  let mappingRevision = 0;
  let mappingStatus = 'empty';
  let mappingStorageBusy = false;
  let mappingStorageError = '';
  const integer = n => n.toLocaleString('en-US');
  for (const id of ['import-button', 'dropzone', 'manage-mappings']) $(id).disabled = true;

  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
  }
  function storageError() {
    $('storage-notice').textContent = '当前浏览器无法保存账单和筛选条件。已授权的映射文件仍可同步，不使用浏览器映射缓存。';
    $('storage-notice').hidden = false;
    $('save-status').textContent = '本次临时使用 · 自动保存不可用';
  }
  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function initializeStorage() {
    try {
      const request = indexedDB.open('zhipu-usage-ledger', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      db = await requestResult(request);
      db.onversionchange = () => { db.close(); db = null; storageError(); };
      const saved = await requestResult(db.transaction('settings').objectStore('settings').get('state'));
      if (saved && Array.isArray(saved.bills)) {
        state.bills = saved.bills;
        state.unit = saved.unit === 'M' ? 'M' : 'K';
        state.start = typeof saved.start === 'string' ? saved.start : '';
        state.end = typeof saved.end === 'string' ? saved.end : '';
      }
      // Remove legacy mappings and directory handles without using either of them.
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('settings', 'readwrite');
        transaction.objectStore('settings').put(storageSnapshot(), 'state');
        transaction.objectStore('settings').delete('mappingDirectory');
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      $('save-status').textContent = '账单自动保存已开启';
    } catch { db = null; storageError(); }
  }
  function storageSnapshot() {
    return structuredClone({ bills: state.bills, unit: state.unit, start: state.start, end: state.end });
  }
  function persist() {
    if (!db) return;
    const snapshot = storageSnapshot();
    $('save-status').textContent = '正在保存…';
    saveQueue = saveQueue.then(() => new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      transaction.objectStore('settings').put(snapshot, 'state');
    })).then(() => { $('save-status').textContent = '账单已自动保存 · 映射文件需每次重新选择'; })
      .catch(() => storageError());
  }

  function renderMappingStorage() {
    const message = mappingStorageError || (mappingStatus === 'saving'
      ? `正在同步：${selectedMappingName}…`
      : mappingStatus === 'saved'
        ? `已同步：${selectedMappingName}`
      : mappingStatus === 'modified'
      ? '映射已修改，尚未写回文件。请导出保存，或使用 Chrome / Edge 重新选择文件并授予读写权限。'
      : mappingStatus === 'exported'
        ? `已导出「${ProjectMappings.filename}」，下次打开请重新选择映射文件。`
        : selectedMappingName
          ? `已加载：${selectedMappingName}（${Object.keys(state.mappings).length} 条映射）${mappingStore.ready ? '，修改自动同步到原文件。' : '，当前为只读导入；修改后需导出保存。'}`
          : '请先选择「用户映射.json」，再导入账单。每次打开需重新选择映射文件。');
    $('mapping-storage-notice').hidden = (mappingStatus === 'saved' || mappingStatus === 'loaded' && mappingStore.ready) && !mappingStorageError;
    $('mapping-storage-message').textContent = message;
    $('mapping-storage-notice').className = mappingStorageError ? 'notice error' : 'notice';
    $('mapping-file-status').textContent = message;
    $('select-mapping').textContent = selectedMappingName ? '更换映射文件' : '选择映射文件';
    $('change-mapping').textContent = selectedMappingName ? '更换映射文件' : '选择映射文件';
    $('save-mapping-file').hidden = mappingStatus !== 'modified';
    $('save-mapping-file').textContent = mappingStore.ready ? '重试保存' : '导出映射';
    for (const id of ['select-mapping', 'change-mapping', 'mapping-key', 'mapping-name', 'save-mapping', 'import-mappings', 'export-mappings', 'save-mapping-file']) $(id).disabled = mappingStorageBusy;
    for (const id of ['select-mapping', 'change-mapping', 'import-mappings']) $(id).disabled = mappingStorageBusy || mappingStatus === 'saving';
    document.querySelectorAll('#mapping-list button').forEach(button => { button.disabled = mappingStorageBusy; });
    document.querySelectorAll('.name-input').forEach(input => { input.readOnly = mappingStorageBusy; });
  }

  async function mappingChanged() {
    const revision = ++mappingRevision;
    mappingStatus = mappingStore.ready ? 'saving' : 'modified';
    mappingStorageError = '';
    renderMappingStorage();
    if (!mappingStore.ready) return false;
    try {
      await mappingStore.write(state.mappings);
      if (revision === mappingRevision) {
        mappingStatus = 'saved';
        mappingStorageError = '';
      }
      return true;
    } catch (error) {
      if (revision === mappingRevision) {
        mappingStatus = 'modified';
        mappingStorageError = `映射未同步，修改暂留页面中。请重试保存或导出备份：${error.message}`;
      }
      return false;
    } finally { renderMappingStorage(); }
  }

  function applyMappings(mappings, name) {
    state.mappings = mappings;
    selectedMappingName = name;
    mappingRevision = 0;
    mappingStatus = 'loaded';
    mappingStorageError = '';
    renderMappingList(); renderResults();
  }

  async function selectMapping() {
    if (mappingStorageBusy || mappingStatus === 'saving') return;
    if (!window.showOpenFilePicker) { $('mapping-file').click(); return; }
    mappingStorageBusy = true;
    renderMappingStorage();
    try {
      const [file] = await window.showOpenFilePicker({ multiple: false, types: [{ description: '用户映射 JSON', accept: { 'application/json': ['.json'] } }] });
      const mappings = await mappingStore.open(file);
      applyMappings(mappings, file.name);
      toast('映射文件已连接，修改会自动同步');
    } catch (error) {
      if (error.name !== 'AbortError') mappingStorageError = `映射文件未连接，本次选择未应用：${error.message}`;
    } finally { mappingStorageBusy = false; renderMappingStorage(); }
  }

  async function retryMappings() {
    try { await mappingStore.authorize(); await mappingChanged(); }
    catch (error) {
      mappingStorageError = `映射未同步：${error.message}`;
      renderMappingStorage();
    }
  }

  function exportMappings() {
    download(ProjectMappings.filename, ProjectMappings.encode(state.mappings), 'application/json');
    if (!mappingStore.ready) mappingStatus = 'exported';
    renderMappingStorage();
  }

  function renderBills() {
    $('bill-count').textContent = `${state.bills.length} 份`;
    const selected = state.bills.filter(bill => bill.selected).length;
    $('selected-count').textContent = `已选择 ${selected} 份账单`;
    $('select-all').textContent = selected === state.bills.length && selected ? '取消全选' : '全选';
    const list = $('bill-list');
    list.replaceChildren();
    if (!state.bills.length) list.append(el('div', 'empty-bills', '尚未导入账单'));
    for (const bill of state.bills) {
      const card = el('div', `bill${bill.selected ? ' selected' : ''}`);
      const label = el('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = bill.selected;
      checkbox.setAttribute('aria-label', `统计 ${bill.name}`);
      checkbox.addEventListener('change', () => { bill.selected = checkbox.checked; render(); persist(); });
      const body = el('div', 'bill-main');
      body.append(el('div', 'bill-name', bill.name));
      const dates = [...new Set(bill.records.map(r => r.date))].sort();
      body.append(el('p', 'bill-meta', `${dates.length ? `${dates[0]} — ${dates.at(-1)}` : '无模型推理记录'}\n模型推理 ${integer(bill.records.length)} 条 · 排除其他产品 ${integer(bill.excludedRows)} 条`));
      const remove = el('button', 'bill-delete');
      remove.append(icon('trash'));
      remove.setAttribute('aria-label', `删除 ${bill.name}`);
      remove.addEventListener('click', async () => {
        if (!await confirmDelete(`删除「${bill.name}」及其已保存明细？用户名映射会保留，账单可以重新导入。`)) return;
        state.bills = state.bills.filter(item => item.id !== bill.id);
        render(); persist(); toast('已删除账单');
      });
      label.append(checkbox, body); card.append(label, remove); list.append(card);
    }
  }

  function renderResults(updateRows = true) {
    let result;
    let problem = '';
    try { result = BillCore.aggregate(state.bills, { start: state.start, end: state.end, mappings: state.mappings, query: $('search').value }); }
    catch (error) { problem = error.message; }
    if (result?.conflicts.length) {
      const conflict = result.conflicts[0];
      problem = `发现 ${result.conflicts.length} 条账单号相同、内容不同的明细，已暂停统计。请检查「${conflict.first}」和「${conflict.second}」（第 ${conflict.row} 行），取消勾选或删除其中的错误账单。`;
    }
    latestResult = problem ? null : result;
    $('result-notice').textContent = problem;
    $('result-notice').hidden = !problem;
    $('result-notice').className = 'notice error';
    const rows = problem ? [] : result.rows;
    $('total-usage').textContent = problem ? '—' : BillCore.formatUsage(result.tokens, state.unit);
    $('total-unit').textContent = state.unit;
    $('total-raw').textContent = problem ? '处理提示后继续统计' : `${integer(result.tokens)} token · 实际消耗`;
    $('key-count').textContent = problem ? '—' : rows.length;
    $('user-count').textContent = problem ? '—' : new Set(rows.filter(row => row.name).map(row => row.name)).size;
    const missing = rows.filter(row => !row.name).length;
    $('unmapped-count').textContent = rows.length ? missing ? `${missing} 个待配置用户名` : '已全部配置用户名' : '暂无用量记录';
    $('usage-heading').textContent = `用量（${state.unit}）`;
    $('unit-K').setAttribute('aria-pressed', String(state.unit === 'K'));
    $('unit-M').setAttribute('aria-pressed', String(state.unit === 'M'));
    $('table-count').textContent = `共 ${rows.length} 个 API key${$('search').value ? ' · 已筛选搜索结果' : ''}`;
    $('dedup-count').textContent = result?.duplicates ? `已自动排除 ${integer(result.duplicates)} 条重复明细` : '按账单号去重后统计';
    $('range-label').textContent = `${state.start || state.end ? `${state.start || '最早'} — ${state.end || '最近'}` : '全部时间'} · 用量从高到低`;
    $('export-results').disabled = !rows.length;
    const tbody = $('results');
    if (updateRows !== false) {
      tbody.replaceChildren();
      rows.forEach((row, index) => {
      const tr = document.createElement('tr');
      const keyCell = document.createElement('td');
      const key = el('div', 'key-cell');
      const keyIcon = el('span', 'key-icon'); keyIcon.append(icon('key'));
      key.append(el('span', 'row-rank mono', String(index + 1).padStart(2, '0')), keyIcon, el('span', 'key-text mono', row.key));
      keyCell.append(key);
      const nameCell = el('td', 'name-cell');
      const input = el('input', 'name-input');
      input.value = row.name; input.placeholder = '未配置'; input.maxLength = 100;
      input.readOnly = mappingStorageBusy;
      input.setAttribute('aria-label', `用户名 ${row.key}`);
      input.addEventListener('change', () => {
        setMapping(row.key, input.value);
        input.value = input.value.trim();
        renderResults(Boolean($('search').value)); mappingChanged();
      });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });
      nameCell.append(input);
      const usageCell = el('td', 'usage-cell mono', BillCore.formatUsage(row.tokens, state.unit));
      usageCell.title = `${integer(row.tokens)} token`;
      const percentage = result.tokens === 0 ? 0 : row.tokens / result.tokens * 100;
      const percentageCell = el('td', 'percentage-cell mono');
      const percentageWrap = el('div', 'percentage-wrap');
      const percentageValue = el('span', 'percentage-value', `${BillCore.formatPercentage(percentage)}%`);
      const percentageBar = el('span', 'percentage-bar');
      percentageBar.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
      percentageWrap.append(percentageValue, percentageBar);
      percentageCell.append(percentageWrap);
      percentageCell.title = '当前统计结果中的用量占比';
      tr.append(keyCell, nameCell, usageCell, percentageCell); tbody.append(tr);
      });
    }
    $('empty-state').hidden = rows.length > 0;
    const emptyTitle = problem ? '需要处理统计提示' : !state.bills.length ? '从导入第一份账单开始' : !state.bills.some(bill => bill.selected) ? '选择参与统计的账单' : '当前范围没有匹配记录';
    $('empty-title').textContent = emptyTitle;
    $('empty-description').textContent = problem ? '解决上方提示后，统计结果会自动更新。' : !state.bills.length ? '选择智谱 AI 开放平台费用明细 Excel，自动汇总每个 API key 的用量。' : '可调整账单勾选、消费日期或搜索条件。';
  }
  function render() { renderBills(); renderResults(); }
  function setMapping(key, value) {
    const name = value.trim();
    if (name) Object.defineProperty(state.mappings, key, { value: name, writable: true, configurable: true, enumerable: true });
    else delete state.mappings[key];
  }
  function confirmDelete(message) {
    return new Promise(resolve => {
      const dialog = $('confirm-dialog');
      $('confirm-body').textContent = message;
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true });
      dialog.showModal();
    });
  }

  async function importFiles(fileList) {
    if (busy || !fileList.length) return;
    busy = true;
    $('import-button').disabled = true; $('dropzone').disabled = true;
    $('dropzone-label').textContent = '正在读取账单…';
    $('import-notice').hidden = true;
    let imported = 0;
    let skipped = 0;
    const errors = [];
    for (const file of fileList) {
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        if (!/\.xlsx$/i.test(file.name) || file.name.startsWith('.~') || file.name.startsWith('~$')) throw new Error('请选择正式的 .xlsx 账单文件。');
        const parsed = BillCore.parseWorkbook(XLSX, await file.arrayBuffer());
        const identity = JSON.stringify(parsed.records.map(r => [r.id, r.signature]).sort((a, b) => a[0].localeCompare(b[0])));
        if (state.bills.some(bill => bill.identity === identity)) { skipped++; continue; }
        state.bills.push({ ...parsed, id: crypto.randomUUID(), identity, name: file.name, selected: true });
        imported++;
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
    if (imported) { render(); persist(); }
    if (errors.length) { $('import-notice').textContent = errors.join('\n'); $('import-notice').style.whiteSpace = 'pre-line'; $('import-notice').hidden = false; }
    busy = false;
    $('import-button').disabled = false; $('dropzone').disabled = false;
    $('dropzone-label').textContent = '点击选择，或拖拽账单到这里';
    $('file-input').value = '';
    toast(`已导入 ${imported} 份账单${skipped ? `，跳过 ${skipped} 份重复内容` : ''}${errors.length ? `，${errors.length} 份导入失败` : ''}`);
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderMappingList() {
    const list = $('mapping-list'); list.replaceChildren();
    const entries = Object.entries(state.mappings);
    if (!entries.length) { list.append(el('p', 'muted', '尚未配置用户名')); return; }
    for (const [key, name] of entries) {
      const row = el('div'); row.style.cssText = 'display:flex;gap:9px;align-items:center;padding:8px 0;border-top:1px solid #edf1e9';
      const description = el('div'); description.style.cssText = 'flex:1;min-width:0;font-size:12px';
      const keyLabel = el('div', 'mono muted', key); keyLabel.style.cssText = 'font-size:10px;overflow-wrap:anywhere;margin-top:5px';
      description.append(el('span', '', name), keyLabel);
      const edit = el('button', 'small', '编辑');
      edit.disabled = mappingStorageBusy;
      edit.addEventListener('click', () => { $('mapping-key').value = key; $('mapping-name').value = name; $('mapping-name').focus(); });
      const remove = el('button', 'small danger', '移除'); remove.setAttribute('aria-label', `移除映射 ${key}`);
      remove.disabled = mappingStorageBusy;
      remove.addEventListener('click', () => { delete state.mappings[key]; renderMappingList(); renderResults(); mappingChanged(); });
      row.append(description, edit, remove); list.append(row);
    }
  }

  $('import-button').addEventListener('click', () => $('file-input').click());
  $('dropzone').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', event => importFiles([...event.target.files]));
  for (const eventName of ['dragenter', 'dragover']) $('dropzone').addEventListener(eventName, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); });
  for (const eventName of ['dragleave', 'drop']) $('dropzone').addEventListener(eventName, event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); });
  $('dropzone').addEventListener('drop', event => importFiles([...event.dataTransfer.files]));
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());
  $('select-all').addEventListener('click', () => {
    const selected = !state.bills.every(bill => bill.selected);
    state.bills.forEach(bill => { bill.selected = selected; }); render(); persist();
  });
  $('search').addEventListener('input', renderResults);
  for (const id of ['start-date', 'end-date']) $(id).addEventListener('change', () => {
    state.start = $('start-date').value; state.end = $('end-date').value;
    renderResults(); persist();
  });
  $('reset-dates').addEventListener('click', () => { state.start = ''; state.end = ''; $('start-date').value = ''; $('end-date').value = ''; renderResults(); persist(); });
  for (const unit of ['K', 'M']) $(`unit-${unit}`).addEventListener('click', () => { state.unit = unit; renderResults(); persist(); });
  $('export-results').addEventListener('click', () => {
    if (!latestResult || !latestResult.rows.length) return;
    const csv = (value, column) => `"${(column < 2 ? String(value).replace(/^[=+@\-\t\r]/, "'$&") : String(value)).replaceAll('"', '""')}"`;
    const rows = [['用户apikey', '用户名', `用量（${state.unit}）`], ...latestResult.rows.map(row => [row.key, row.name || '未配置', BillCore.formatUsage(row.tokens, state.unit, false)])];
    download(`用户用量_${state.start || '全部'}_${state.end || '全部'}_${state.unit}.csv`, '\uFEFF' + rows.map(row => row.map(csv).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  });
  $('manage-mappings').addEventListener('click', () => { renderMappingList(); $('mapping-dialog').showModal(); });
  for (const id of ['select-mapping', 'change-mapping', 'import-mappings']) $(id).addEventListener('click', selectMapping);
  $('close-mappings').addEventListener('click', () => $('mapping-dialog').close());
  $('mapping-form').addEventListener('submit', async event => {
    event.preventDefault();
    const key = $('mapping-key').value.trim(); const name = $('mapping-name').value.trim();
    if (!key || !name) { toast('请填写 API key 和用户名'); return; }
    setMapping(key, name); $('mapping-form').reset(); renderMappingList(); renderResults();
    if (await mappingChanged()) toast('用户名映射已同步到原文件');
    else toast('映射暂留页面，请查看保存提示');
  });
  $('export-mappings').addEventListener('click', exportMappings);
  $('save-mapping-file').addEventListener('click', () => mappingStore.ready ? retryMappings() : exportMappings());
  $('mapping-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file || mappingStorageBusy || mappingStatus === 'saving') return;
    mappingStorageBusy = true;
    renderMappingStorage();
    try {
      const mappings = ProjectMappings.decode(await file.text());
      mappingStore.detach();
      applyMappings(mappings, file.name);
      toast(`已加载 ${file.name}，可导入账单`);
    } catch (error) {
      mappingStorageError = `映射文件读取失败，本次选择未应用：${error.message}`;
      toast(mappingStorageError);
    } finally {
      event.target.value = '';
      mappingStorageBusy = false;
      renderMappingStorage();
    }
  });
  $('cancel-confirm').addEventListener('click', () => $('confirm-dialog').close('cancel'));
  $('accept-confirm').addEventListener('click', () => $('confirm-dialog').close('delete'));
  await initializeStorage();
  $('start-date').value = state.start; $('end-date').value = state.end;
  for (const id of ['import-button', 'dropzone', 'manage-mappings']) $(id).disabled = false;
  render(); renderMappingStorage();
})();
