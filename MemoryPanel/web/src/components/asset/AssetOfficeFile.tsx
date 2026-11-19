/**
 * AssetOfficeFile —— `preview: "client"` 的分发器组件。
 *
 * 本组件**不内嵌任何格式分支**，只做三件事：
 *   1. base64 → ArrayBuffer
 *   2. 按文件名查前端 previewer id（`client-previewer-map.ts`）
 *   3. 从 previewer 注册表取实现、执行渲染
 *
 * 新增一种 client 预览：
 *   - `previewer-xxx.ts` 实现 `Previewer` 接口并在 `register-previewers.ts` 注册
 *   - `client-previewer-map.ts` 加 ext → previewer id 映射
 *   - 后端 `format-registry.ts` 把该 ext 的 `preview` 字段设为 `"client"`
 * 本组件不动。
 */
import { useEffect, useRef, useState } from "react";
import { getPreviewer, type PreviewCleanup } from "./previewers";
import { previewerIdFor } from "./client-previewer-map";
// 导入这个文件触发所有内置 previewer 的注册（import 副作用，只执行一次）
import "./register-previewers";

/** base64 → ArrayBuffer（Blob/XLSX.read 都可直接消费） */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

interface Props {
  base64: string;
  filename: string;
}

export function AssetOfficeFile({ base64, filename }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const disposeRef = useRef<PreviewCleanup | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const controller = new AbortController();
    container.innerHTML = "";
    disposeRef.current?.();
    disposeRef.current = null;
    setError(null);

    const id = previewerIdFor(filename);
    if (!id) {
      setError(`该格式暂无前端预览器：${filename}`);
      return;
    }
    const previewer = getPreviewer(id);
    if (!previewer) {
      // 注册表未命中：register-previewers 未导入？或 id 拼错
      setError(`预览器未注册：${id}`);
      return;
    }

    void (async () => {
      try {
        const bytes = base64ToArrayBuffer(base64);
        if (controller.signal.aborted) return;
        disposeRef.current = await previewer.render({
          container,
          bytes,
          filename,
          signal: controller.signal,
        });
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      controller.abort();
      disposeRef.current?.();
      disposeRef.current = null;
    };
  }, [base64, filename]);

  if (error) {
    return <div className="_asset-native-file-fallback">文档渲染失败：{error}</div>;
  }
  return <div className="_asset-office-file" ref={containerRef} />;
}
