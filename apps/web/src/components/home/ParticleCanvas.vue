<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 粒子班徽背景：还原根目录静态原型（js/particle-background.js）的效果。
 * - 运行时从 /badge.png 采样点阵：班徽藏青区域生成粒子，白色线稿与透明底留空
 * - 藏青为主、医青点缀的双色柔边圆点，尺寸带有机差异
 * - 鼠标靠近时按平方反比散开，离开后按各自速度弹回复原
 * - 画布 pointer-events: none，交互监听挂在 window，不遮挡正文与按钮
 * - 桌面端以完整班徽为低透明度底图，并在其上渲染粒子
 * - 窄屏和 prefers-reduced-motion 下只显示静态班徽，不初始化画布
 */

interface Target {
  x: number;
  y: number;
  a: number;
}

interface Particle {
  x: number;
  y: number;
  a: number;
  ta: number;
  speed: number;
  teal: boolean;
  sizeFactor: number;
}

const COLOR_NAVY = '#1d2a63';
const COLOR_TEAL = '#0f8a96';
/** 医青点缀粒子占比 */
const TEAL_RATIO = 0.16;
const MODEL_SIZE = 800;
const SAMPLE_STEP = 6;
/** 亮度高于该值视为白色线稿，留空不生成粒子 */
const WHITE_LUMINANCE = 210;
/** 亮度低于该值视为纯色藏青，粒子透明度为 1 */
const NAVY_LUMINANCE = 120;
const POINT_SIZE = 3.2;
/** 单颗粒尺寸抖动范围，让图样更有机 */
const SIZE_FACTOR_MIN = 0.75;
const SIZE_FACTOR_MAX = 1.4;
const REPEL_STRENGTH = -100;
const REPEL_RADIUS = 2;
const SPEED_MIN = 20;
const SPEED_MAX = 30;
const FIT_RATIO = 0.84;

const canvas = ref<HTMLCanvasElement>();
let destroy: (() => void) | null = null;

function startParticleEffect(canvasElement: HTMLCanvasElement) {
  const canvasContext = canvasElement.getContext('2d');
  if (!canvasContext) return;
  // 固定引用，保证闭包内类型收窄
  const element: HTMLCanvasElement = canvasElement;
  const context: CanvasRenderingContext2D = canvasContext;

  const image = new Image();
  const mouse = { x: 0, y: 0, active: false };
  let targets: Target[] = [];
  let particles: Particle[] = [];
  let order: number[] = [];
  let width = 0;
  let height = 0;
  let scale = 1;
  let offsetX = 0;
  let pointSize = POINT_SIZE;
  let spriteNavy: HTMLCanvasElement | null = null;
  let spriteTeal: HTMLCanvasElement | null = null;
  let frame = 0;
  let running = false;
  let observer: ResizeObserver | undefined;
  let visibilityObserver: IntersectionObserver | undefined;

  function sampleModel() {
    const sample = document.createElement('canvas');
    sample.width = MODEL_SIZE;
    sample.height = MODEL_SIZE;
    const sampleContext = sample.getContext('2d');
    if (!sampleContext) return;
    sampleContext.drawImage(image, 0, 0, MODEL_SIZE, MODEL_SIZE);
    const pixels = sampleContext.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    const half = MODEL_SIZE / 2;
    targets = [];
    for (let y = 0; y < MODEL_SIZE; y += SAMPLE_STEP) {
      for (let x = 0; x < MODEL_SIZE; x += SAMPLE_STEP) {
        const index = (y * MODEL_SIZE + x) * 4;
        const alpha = pixels[index + 3] ?? 0;
        if (alpha < 100) continue;
        const luminance =
          0.299 * (pixels[index] ?? 0) + 0.587 * (pixels[index + 1] ?? 0) + 0.114 * (pixels[index + 2] ?? 0);
        // 白色线稿处留空；藏青区域统一满透明度，抗锯齿边缘线性过渡
        const weight = Math.min(Math.max((WHITE_LUMINANCE - luminance) / (WHITE_LUMINANCE - NAVY_LUMINANCE), 0), 1);
        if (weight <= 0.05) continue;
        targets.push({
          x: x - half,
          y: half - y,
          a: weight * (alpha / 255),
        });
      }
    }
  }

  function createSprite(color: string) {
    const size = 32;
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = size;
    spriteCanvas.height = size;
    const spriteContext = spriteCanvas.getContext('2d');
    if (!spriteContext) return null;
    spriteContext.fillStyle = color;
    spriteContext.fillRect(0, 0, size, size);
    spriteContext.globalCompositeOperation = 'destination-in';
    const mask = spriteContext.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    mask.addColorStop(0, 'rgba(255,255,255,1)');
    mask.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    mask.addColorStop(1, 'rgba(255,255,255,0)');
    spriteContext.fillStyle = mask;
    spriteContext.fillRect(0, 0, size, size);
    return spriteCanvas;
  }

  function resize() {
    const rect = element.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    scale = (FIT_RATIO * Math.min(width, height)) / MODEL_SIZE;
    // 桌面右移给左侧文案让位；窄屏居中并由 CSS 降低不透明度
    offsetX = width > 900 ? 0.19 * width : 0;
    pointSize = Math.max(POINT_SIZE * (height / 1080), 1.2);
    spriteNavy = createSprite(COLOR_NAVY);
    spriteTeal = createSprite(COLOR_TEAL);
  }

  function spawn() {
    const count = targets.length;
    order = Array.from({ length: count }, (_, index) => index);
    for (let index = count - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [order[index], order[swap]] = [order[swap]!, order[index]!];
    }
    particles = targets.map((_, index) => ({
      x: (0.5 - Math.random()) * width,
      y: (0.5 - Math.random()) * height,
      a: -1,
      ta: targets[order[index]!]?.a ?? 0,
      speed: SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN),
      teal: Math.random() < TEAL_RATIO,
      sizeFactor: SIZE_FACTOR_MIN + Math.random() * (SIZE_FACTOR_MAX - SIZE_FACTOR_MIN),
    }));
  }

  function update() {
    const strength = REPEL_STRENGTH / REPEL_RADIUS;
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index]!;
      const target = targets[order[index]!];
      if (!target) continue;
      const easing = 1 / particle.speed;
      const dx = mouse.active ? mouse.x - particle.x : 0;
      const dy = mouse.active ? mouse.y - particle.y : 0;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const falloff = 1 / (1 + distance / REPEL_RADIUS) / (1 + distance / REPEL_RADIUS);
      particle.x += (scale * target.x + offsetX - particle.x) * easing + strength * dx * falloff;
      particle.y += (scale * target.y - particle.y) * easing + strength * dy * falloff;
      particle.a += (particle.ta - particle.a) * easing;
    }
  }

  function draw() {
    if (!spriteNavy || !spriteTeal) return;
    context.clearRect(0, 0, width, height);
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    for (const particle of particles) {
      if (particle.a <= 0) continue;
      const size = pointSize * particle.sizeFactor;
      const half = size / 2;
      context.globalAlpha = particle.a > 1 ? 1 : particle.a;
      context.drawImage(
        particle.teal ? spriteTeal : spriteNavy,
        halfWidth + particle.x - half,
        halfHeight - particle.y - half,
        size,
        size,
      );
    }
    context.globalAlpha = 1;
  }

  function loop() {
    update();
    draw();
    if (running) frame = requestAnimationFrame(loop);
  }

  /** 画布滚出视口时暂停动画循环，避免不可见内容空耗 CPU/GPU */
  function startLoop() {
    if (running) return;
    running = true;
    frame = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(frame);
  }

  function onPointerMove(event: PointerEvent) {
    const rect = element.getBoundingClientRect();
    mouse.active = true;
    mouse.x = event.clientX - rect.left - rect.width / 2;
    mouse.y = rect.height / 2 - (event.clientY - rect.top);
  }

  function onLeave() {
    mouse.active = false;
  }

  image.onload = () => {
    sampleModel();
    if (!targets.length) return;
    resize();
    spawn();
    startLoop();
    observer = new ResizeObserver(resize);
    observer.observe(element);
    visibilityObserver = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) startLoop();
      else stopLoop();
    });
    visibilityObserver.observe(element);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('blur', onLeave);
    document.documentElement.addEventListener('mouseleave', onLeave);
  };
  image.src = '/badge.png';

  return () => {
    stopLoop();
    observer?.disconnect();
    visibilityObserver?.disconnect();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('blur', onLeave);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    image.onload = null;
  };
}

onMounted(() => {
  const canvasElement = canvas.value;
  if (!canvasElement) return;
  const element: HTMLCanvasElement = canvasElement;

  const particleMode = window.matchMedia('(min-width: 901px) and (prefers-reduced-motion: no-preference)');
  let stopParticles: (() => void) | null = null;

  function syncParticleMode() {
    if (particleMode.matches) {
      stopParticles ??= startParticleEffect(element) ?? null;
      return;
    }
    stopParticles?.();
    stopParticles = null;
  }

  particleMode.addEventListener('change', syncParticleMode);
  syncParticleMode();

  destroy = () => {
    particleMode.removeEventListener('change', syncParticleMode);
    stopParticles?.();
    stopParticles = null;
  };
});

onBeforeUnmount(() => {
  destroy?.();
  destroy = null;
});
</script>

<template>
  <div class="emblem-backdrop" aria-hidden="true">
    <img class="emblem-image" src="/badge.png" alt="" decoding="async" />
    <canvas ref="canvas" class="particle-canvas" />
  </div>
</template>

<style scoped>
.emblem-backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.emblem-image {
  position: absolute;
  top: 50%;
  left: 69%;
  width: 84%;
  height: 84%;
  transform: translate(-50%, -50%);
  object-fit: contain;
  opacity: 0.08;
  mix-blend-mode: multiply;
}

.particle-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

@media (max-width: 900px) {
  .emblem-image {
    top: 62%;
    left: 50%;
    width: 88%;
    height: 72%;
    opacity: 0.14;
  }

  .particle-canvas {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .emblem-image {
    opacity: 0.1;
  }

  .particle-canvas {
    display: none;
  }
}
</style>
