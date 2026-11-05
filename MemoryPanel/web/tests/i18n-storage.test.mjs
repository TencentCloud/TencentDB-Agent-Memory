import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;

function storageDouble({ storedValue = null, readError, writeError } = {}) {
  let currentValue = storedValue;
  const storage = {
    getItem() {
      if (readError) throw new DOMException('Storage disabled', 'SecurityError');
      return currentValue;
    },
    setItem(_key, value) {
      if (writeError) throw new DOMException('Storage full', 'QuotaExceededError');
      currentValue = value;
    },
    removeItem() {},
    clear() {},
    key() {
      return null;
    },
    length: 0,
  };
  Object.defineProperty(storage, 'storedValue', {
    get: () => currentValue,
  });
  return storage;
}

async function loadI18n({ storedValue = null, readError, writeError, navigatorLanguage }) {
  const storage = storageDouble({ storedValue, readError, writeError });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: navigatorLanguage },
  });

  server.moduleGraph.invalidateAll();
  const i18nModule = await server.ssrLoadModule(
    `/src/i18n/index.ts?case=${crypto.randomUUID()}`,
  );
  return { ...i18nModule, storage };
}

before(async () => {
  server = await createServer({
    appType: 'custom',
    server: { middlewareMode: true },
    logLevel: 'silent',
  });
});

after(async () => {
  await server.close();
});

test('initializes from navigator.language when storage reads throw', async () => {
  const { getCurrentLanguage } = await loadI18n({
    readError: true,
    navigatorLanguage: 'en-GB',
  });

  assert.equal(getCurrentLanguage(), 'en-US');
});

test('keeps an in-memory language change when storage writes throw', async () => {
  const { changeLanguage, getCurrentLanguage } = await loadI18n({
    writeError: true,
    navigatorLanguage: 'zh-CN',
  });

  assert.doesNotThrow(() => changeLanguage('en-US'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getCurrentLanguage(), 'en-US');
});

test('uses a supported stored language before the browser language', async () => {
  const { getCurrentLanguage } = await loadI18n({
    storedValue: 'zh-CN',
    navigatorLanguage: 'en-US',
  });

  assert.equal(getCurrentLanguage(), 'zh-CN');
});

test('persists a successful language change for the next initialization', async () => {
  const first = await loadI18n({ navigatorLanguage: 'zh-CN' });
  first.changeLanguage('en-US');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(first.storage.storedValue, 'en-US');

  const next = await loadI18n({
    storedValue: first.storage.storedValue,
    navigatorLanguage: 'zh-CN',
  });
  assert.equal(next.getCurrentLanguage(), 'en-US');
});

test('ignores an unsupported stored language and keeps the navigator fallbacks', async () => {
  const unsupported = await loadI18n({
    storedValue: 'fr-FR',
    navigatorLanguage: 'fr-FR',
  });
  assert.equal(unsupported.getCurrentLanguage(), 'en-US');

  const emptyLanguage = await loadI18n({
    storedValue: 'not-a-language',
    navigatorLanguage: '',
  });
  assert.equal(emptyLanguage.getCurrentLanguage(), 'zh-CN');
});
