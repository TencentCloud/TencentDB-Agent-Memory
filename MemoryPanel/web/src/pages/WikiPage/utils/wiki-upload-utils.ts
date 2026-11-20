/**
 * 读取文件为 base64（不含 data URL 前缀）。
 *
 * **所有格式统一走 base64**：HTTP+JSON 只能传字符串，而 UTF-8 解码对二进制
 * 是有损不可逆的（非法字节被替换为 U+FFFD），故不再按扩展名分流编码。
 * base64 是任意字节的可逆编码，服务端解码后按原始字节落盘。
 * 分块拼接以避免大文件在 `String.fromCharCode(...arr)` 上爆栈。
 */
export async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let bin = '';
  const arr = new Uint8Array(buf);
  const chunk = 8192;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * 读取上传文件内容。**所有格式统一走 base64**（不再按扩展名分流编码）。
 *
 * 服务端按 `encoding` 解码后以原始字节落盘，文本文件经 base64 往返同样无损。
 */
export async function readUploadFile(
  file: File,
): Promise<{ filename: string; content: string; encoding: 'base64' }> {
  return { filename: uploadFilename(file), content: await readAsBase64(file), encoding: 'base64' };
}

/** Keep the selected root as a namespace; reselecting it preserves source identity. */
export function uploadFilename(file: File): string {
  return file.webkitRelativePath || file.name;
}

export type WikiUploadItem = Awaited<ReturnType<typeof readUploadFile>>;

/** Upload bounded batches, then enqueue extraction once. Retrying the same
 * selection overwrites the same source paths; unchanged hashes stay ingested. */
export async function uploadWikiFiles<T>(
  files: readonly File[],
  writeBatch: (items: WikiUploadItem[]) => Promise<unknown>,
  finish: () => Promise<T>,
): Promise<T> {
  const maxFiles = 10;
  const maxBytes = 20 * 1024 * 1024;
  const snapshot = [...files];
  const paths = new Set<string>();
  // Validate the entire selection before making any writes.
  for (const file of snapshot) {
    const name = uploadFilename(file);
    if (
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`Invalid file path: ${name}`);
    }
    const key = name.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new Error(`Conflicting file paths: ${name}`);
    paths.add(key);
    if (file.size > maxBytes) throw new Error(`File exceeds the 20 MB upload limit: ${name}`);
  }
  if (snapshot.length === 0) throw new Error('Select files to upload.');

  let batch: File[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await writeBatch(await Promise.all(batch.map(readUploadFile)));
    batch = [];
    bytes = 0;
  };
  for (const file of snapshot) {
    if (batch.length === maxFiles || bytes + file.size > maxBytes) await flush();
    batch.push(file);
    bytes += file.size;
  }
  await flush();
  return finish();
}

export function findExistingRawFilenames(
  filenames: readonly string[],
  existingFilenames: readonly string[],
): string[] {
  const existing = new Set(existingFilenames);
  return [...new Set(filenames.filter((filename) => existing.has(filename)))];
}

export function formatOverwriteFilenames(filenames: readonly string[]): string {
  return filenames.map((filename) => `「${filename}」`).join('、 ');
}
