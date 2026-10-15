/**
 * 包根目录（兼容 src/ 开发 和 dist/ 编译两种场景）。
 *
 * - 从 src/paths.ts  运行：__dirname = <root>/src       → 上一级就是包根
 * - 从 dist/paths.js 运行：__dirname = <root>/dist      → 上一级就是包根
 */
export declare const packageRoot: string;
/** data/ 目录的绝对路径 */
export declare const dataDir: string;
//# sourceMappingURL=paths.d.ts.map