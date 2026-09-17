/**
 * ParticleWaveBackground — 明亮风格的点阵波纹动效背景（纯 Canvas，零外部依赖）。
 *
 * 视觉参考 React Bits 的 Particles / DotGrid：网格点阵 + 多层正弦波驱动的起伏，
 * 点的半径与透明度随波峰变化，形成"呼吸感"的柔和波纹。
 *
 * 为什么不直接装 React Bits 的包：
 *   其 Particles / DotGrid / Aurora 分别依赖 ogl / gsap / three，本项目均未安装。
 *   按 React Bits 官方推荐的 manual 方式（复制源码进项目）实现，避免新增运行时依赖
 *   与构建风险，同时保留完全可控的视觉调参能力。
 *
 * 实现要点：
 *   - devicePixelRatio 适配，避免高清屏发虚；
 *   - ResizeObserver 跟随容器尺寸，不监听 window 以免多实例互相干扰；
 *   - 尊重 prefers-reduced-motion：偏好减少动效时渲染静态一帧，不启动 rAF；
 *   - 组件卸载时取消 rAF 与 observer，无内存泄漏。
 */
import { useEffect, useRef } from 'react';

export interface ParticleWaveBackgroundProps {
  /** 点阵间距（px），越小越密。默认 26 */
  gap?: number;
  /** 点的基础半径（px）。默认 1.5 */
  dotRadius?: number;
  /** 点颜色，需为 `r, g, b` 形式（透明度由内部按波峰计算）。默认深灰蓝 */
  color?: string;
  /** 动画速度系数，默认 1 */
  speed?: number;
  /** 附加类名 */
  className?: string;
}

export default function ParticleWaveBackground({
  gap = 26,
  dotRadius = 1.5,
  color = '100, 116, 139',
  speed = 1,
  className,
}: ParticleWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let width = 0;
    let height = 0;
    let disposed = false;

    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      // 用 setTransform 而非 scale，避免多次 resize 后缩放系数累积
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * 渲染一帧。三层不同频率/相位的正弦波叠加，得到 [-1, 1] 的强度场；
     * 强度映射到点的半径与透明度，形成明暗起伏的点阵波纹。
     *
     * 参数取值说明：时间系数决定"看起来动得多快"。太小（<0.5）时单个波周期会长达
     * 十几秒，肉眼几乎判断不出在动、像一张静态图；这里取 0.65~1.15 让主波约 5 秒
     * 一个周期，既能明确看出流动感又不至于晃眼。
     */
    function draw(elapsedMs: number) {
      if (width <= 0 || height <= 0) return;
      const t = (elapsedMs / 1000) * speed;
      ctx!.clearRect(0, 0, width, height);

      const cols = Math.ceil(width / gap) + 1;
      const rows = Math.ceil(height / gap) + 1;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * gap;
          const y = row * gap;
          // 归一化坐标让波形不随画布尺寸变形
          const nx = x / Math.max(width, 1);
          const ny = y / Math.max(height, 1);

          // 主波自右向左流动，另两层不同角度叠加，避免出现规则条纹
          const wave =
            Math.sin(nx * 7.5 - t * 1.15) * 0.45 +
            Math.sin(ny * 5.5 + t * 0.75) * 0.28 +
            Math.sin((nx * 3.2 + ny * 4.1) + t * 0.95) * 0.27;

          // wave ∈ 约 [-1, 1] → intensity ∈ [0, 1]
          const intensity = (wave + 1) / 2;
          // 幂次收缩暗部，让波峰更突出、波谷更干净，明暗对比更清晰
          const shaped = Math.pow(intensity, 1.4);
          // 顶部略淡、底部略实，增强"光从上方来"的明亮感
          const depth = 0.6 + ny * 0.4;
          const alpha = (0.08 + shaped * 0.5) * depth;
          const radius = dotRadius * (0.45 + shaped * 1.15);
          if (alpha <= 0.01 || radius <= 0.05) continue;

          ctx!.beginPath();
          ctx!.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
          ctx!.arc(x, y, radius, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    function loop(now: number) {
      if (disposed) return;
      draw(now);
      rafId = window.requestAnimationFrame(loop);
    }

    resize();

    const observer = new ResizeObserver(() => {
      resize();
      // 偏好减少动效时不跑 rAF，resize 后需手动补画一帧
      if (reduceMotion) draw(0);
    });
    const parent = canvas.parentElement;
    if (parent) observer.observe(parent);

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = window.requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [gap, dotRadius, color, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
