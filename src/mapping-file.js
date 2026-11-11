(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectMappings = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const filename = '用户映射.json';
  function decode(text) {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    const mappings = data?.mappings;
    if (data?.version !== 1 || !mappings || Array.isArray(mappings) || typeof mappings !== 'object' ||
      Object.entries(mappings).some(([key, name]) => !key.trim() || key !== key.trim() || typeof name !== 'string' || !name.trim() || name.length > 100)) {
      throw new Error('映射文件格式无效，需要 version: 1 和 mappings 对象。原文件未被覆盖。');
    }
    return Object.fromEntries(Object.entries(mappings).map(([key, name]) => [key, name.trim()]));
  }
  function encode(mappings) {
    const text = JSON.stringify({ version: 1, mappings }, null, 2) + '\n';
    decode(text);
    return text;
  }
  class FileStore {
    constructor() { this.file = null; this.queue = Promise.resolve(); }
    get ready() { return Boolean(this.file); }
    detach() { this.file = null; }
    async authorize(file = this.file) {
      if (!file) throw new Error('请先选择映射文件。');
      if (!file.queryPermission) return;
      let permission = await file.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') permission = await file.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') throw new Error('未获得映射文件的读写权限，请重新选择并授权。');
    }
    async open(file) {
      await this.authorize(file);
      const mappings = decode(await (await file.getFile()).text());
      this.file = file;
      return mappings;
    }
    write(mappings) {
      if (!this.file) return Promise.reject(new Error('请先选择映射文件。'));
      const content = encode(mappings);
      const file = this.file;
      const job = this.queue.catch(() => {}).then(async () => {
        const writable = await file.createWritable();
        try { await writable.write(content); await writable.close(); }
        catch (error) { try { await writable.abort(); } catch {} throw error; }
      });
      this.queue = job;
      return job;
    }
  }
  return { filename, decode, encode, FileStore };
});
