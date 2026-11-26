/**
 * 让 tsc 认识 @testing-library/jest-dom 注入的断言扩展
 * （toBeInTheDocument / toHaveAttribute …）。
 *
 * 这些断言在 vitest.setup.ts 里运行时注册；类型侧需要显式引入，
 * 否则 `npm run build`（tsc）会对 src 下的 *.test.tsx 报 TS2339。
 */
import '@testing-library/jest-dom/vitest';
