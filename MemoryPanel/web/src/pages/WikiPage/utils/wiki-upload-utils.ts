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
  return { filename: file.name, content: await readAsBase64(file), encoding: 'base64' };
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
