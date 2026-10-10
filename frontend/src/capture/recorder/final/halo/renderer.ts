import { whitenSpectrum, type HaloSource } from "./source";

export const BLEED = 1.75;
const MAX_PIXEL_SIZE = 640;
const ATLAS_SIZE = 1024;
const SPECTRUM_SIZE = 32;
const DATA_SIZE = 128;
const RA = 1 / BLEED;
const compareByPixelSize = (a: HaloEntry, b: HaloEntry) =>
  b.pixelSize - a.pixelSize;

export interface HaloConfig {
  size: number;
  ticks: number;
  paused: boolean;
  still: boolean;
  theme: "night" | "day";
  sourceRef: { current: HaloSource };
  weight: number;
  spread: number;
}

type HaloSurface = HTMLCanvasElement | OffscreenCanvas;
export type RenderPath = "webgl-atlas" | "webgl-drawImage" | "canvas-2d";
export type FrameCallback = (now: number) => boolean;

export class HaloRafLoop {
  private running = false;
  private frameId: number | null = null;

  constructor(
    private readonly callback: FrameCallback,
    private readonly request: (callback: FrameRequestCallback) => number = (
      callback,
    ) => requestAnimationFrame(callback),
    private readonly cancel: (frameId: number) => void = (frameId) =>
      cancelAnimationFrame(frameId),
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.frameId = this.request(this.onFrame);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.frameId !== null) this.cancel(this.frameId);
    this.frameId = null;
  }

  private onFrame: FrameRequestCallback = (now) => {
    this.frameId = null;
    if (!this.running) return;
    if (!this.callback(now)) {
      this.running = false;
      return;
    }
    this.frameId = this.request(this.onFrame);
  };
}

export function haloFrameInterval(
  path: RenderPath,
  level: number,
  act: number,
  paused: boolean,
  still: boolean,
  settlingPause: boolean,
): number {
  if (settlingPause) return 0;
  if (path === "canvas-2d" || paused || still || (act < 0.01 && level < 0.01)) {
    return 1000 / 15;
  }
  return 0;
}

export function easePause(value: number, target: number, dt: number): number {
  return value + (target - value) * (1 - Math.exp(-Math.min(0.1, dt) * 7));
}

interface SelectedSurface {
  canvas: HaloSurface;
  gl: WebGLRenderingContext | null;
  path: RenderPath;
}

interface HaloEntry {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  config: HaloConfig;
  visible: boolean;
  pixelSize: number;
  lastDraw: number;
  // Draws that reached this display canvas since it was last cleared.
  draws: number;
  reduced: boolean;
  avatarTexture: WebGLTexture | null;
  dataTexture: WebGLTexture | null;
  uploadedTheme: HaloConfig["theme"] | null;
  source: HaloSource;
  frozenSource: HaloSource;
  data: Uint8Array;
  interpolated: Float32Array;
  whitened: Float32Array;
  peak: Float32Array;
  hold: Float32Array;
  mean: Float32Array;
  pauseValue: number;
  atlasX: number;
  atlasY: number;
}

interface Uniforms {
  resolution: WebGLUniformLocation | null;
  origin: WebGLUniformLocation | null;
  tickCount: WebGLUniformLocation | null;
  weight: WebGLUniformLocation | null;
  spread: WebGLUniformLocation | null;
  pause: WebGLUniformLocation | null;
  still: WebGLUniformLocation | null;
  clock: WebGLUniformLocation | null;
  accent: WebGLUniformLocation | null;
  accent2: WebGLUniformLocation | null;
  level: WebGLUniformLocation | null;
  act: WebGLUniformLocation | null;
  light: WebGLUniformLocation | null;
  reduced: WebGLUniformLocation | null;
  avatar: WebGLUniformLocation | null;
  data: WebGLUniformLocation | null;
}

const VERTEX_SHADER = `
attribute vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_PRELUDE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform vec2 uOrig;
uniform float uLevel;
uniform float uAct;
uniform float uLight;
uniform float uReduce;
uniform float uPause;
uniform float uStill;
uniform float uClock;
uniform float uTickN;
uniform float uTickW;
uniform float uSpread;
uniform vec3 uAccA;
uniform vec3 uAccB;
uniform sampler2D uAvatar;
uniform sampler2D uData;

const float RA = ${RA.toFixed(8)};
const float PI = 3.14159265;
const float TAU = 6.2831853;
float px;

float specAt(float x) {
  return texture2D(uData, vec2(clamp(x, 0.0, 1.0) * 0.97 + 0.015, 0.125)).r;
}

float waveAt(float x) {
  return texture2D(uData, vec2(clamp(x, 0.0, 1.0), 0.375)).r * 2.0 - 1.0;
}

float peakAt(float x) {
  return texture2D(uData, vec2(clamp(x, 0.0, 1.0) * 0.97 + 0.015, 0.625)).r;
}

float whiteAt(float x) {
  return texture2D(uData, vec2(clamp(x, 0.0, 1.0) * 0.97 + 0.015, 0.875)).r;
}

vec4 avatarAt(vec2 p, float scale) {
  vec2 uv = p / (RA * scale) * 0.5 + 0.5;
  vec3 color = texture2D(uAvatar, uv).rgb;
  float mask = 1.0 - smoothstep(RA * scale - px, RA * scale + px, length(p));
  return vec4(color * mask, mask);
}

vec4 over(vec4 top, vec4 bottom) {
  return top + bottom * (1.0 - top.a);
}

float EF(vec2 p) {
  return smoothstep(0.99, 0.74, length(p));
}

vec2 P() {
  px = 2.0 / uRes.y;
  return ((gl_FragCoord.xy - uOrig) * 2.0 - uRes) / uRes.y;
}
`;

export const TICKS_SHADER = `
void main() {
  vec2 p = P();
  float r = length(p);
  if (r < RA - 2.0 * px) {
    gl_FragColor = avatarAt(p, 1.0) * EF(p);
    return;
  }
  float angle = atan(p.x, p.y);
  float count = uTickN;
  float cell = floor((angle / TAU + 0.5) * count);
  float tickAngle = (cell + 0.5) / count * TAU - PI;
  vec2 direction = vec2(sin(tickAngle), cos(tickAngle));
  vec2 tangent = vec2(direction.y, -direction.x);
  float mirror = abs(tickAngle) / PI;
  float value = specAt(mirror * 0.85);

  float scatter = 0.06 + fract(cell * 0.618034 + 0.21) * 0.7;
  value = mix(value, clamp(whiteAt(scatter) * 0.75 + uLevel * 0.4, 0.0, 1.0), uSpread);

  float tickLength = 0.012 + pow(value, 1.15) * 0.30 * uAct + uLevel * 0.025 * uAct;
  float radius = RA + 0.055;
  float width = (0.0115 + 0.003 * uAct) * uTickW;
  float along = dot(p, direction) - radius;
  float across = abs(dot(p, tangent));
  float distance = length(vec2(max(0.0, abs(along - tickLength * 0.5) - tickLength * 0.5), across)) - width;
  float tick = 1.0 - smoothstep(-px, px, distance);

  vec3 hot = mix(uAccA, uAccB, mirror);
  vec3 neutral = uLight > 0.5 ? vec3(0.62, 0.62, 0.70) : vec3(0.30, 0.30, 0.38);
  vec3 color = mix(neutral, hot, uAct);

  float breathe = 0.62 + 0.38 * (0.5 + 0.5 * sin(uClock * 2.4));
  vec3 rest = mix(uAccA, uAccB, 0.5);
  vec3 drained = mix(vec3(dot(rest, vec3(0.33))), rest, 0.1)
    * (uLight > 0.5 ? 0.9 : 0.8);
  color = mix(color, drained, uPause);
  if (uStill > 0.5) {
    color = neutral;
  }
  tick *= mix(1.0, breathe, uPause * (1.0 - uReduce));

  float glow = exp(-max(distance, 0.0) * 55.0) * 0.45 * uAct
    * (1.0 - uPause) * (1.0 - uStill);
  float disk = exp(-max(r - RA, 0.0) * 10.0) * step(RA, r) * uLevel * 0.22
    * (1.0 - uPause) * (1.0 - uStill);
  vec4 effect = vec4(color * tick, tick)
    + vec4(hot, 1.0) * (glow + disk) * (1.0 - tick) * (uLight > 0.5 ? 0.7 : 1.0);

  gl_FragColor = over(avatarAt(p, 1.0), effect) * EF(p);
}
`;

export function pauseBreathOpacity(
  clock: number,
  pause: number,
  reduced: boolean,
): number {
  const breathe = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(clock * 2.4));
  return 1 - (reduced ? 0 : pause) * (1 - breathe);
}

const GL_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  powerPreference: "low-power",
};

const ACCENTS = {
  night: [
    new Float32Array([1, 107 / 255, 98 / 255]),
    new Float32Array([232 / 255, 71 / 255, 90 / 255]),
  ],
  day: [
    new Float32Array([229 / 255, 72 / 255, 63 / 255]),
    new Float32Array([240 / 255, 122 / 255, 114 / 255]),
  ],
} as const;

function webglContext(canvas: HaloSurface): WebGLRenderingContext | null {
  return canvas.getContext("webgl", GL_OPTIONS) as WebGLRenderingContext | null;
}

export function selectRenderSurface(
  createOffscreen: () => OffscreenCanvas | null,
  createCanvas: () => HTMLCanvasElement,
  logPath: (path: RenderPath) => void = (path) =>
    console.info(`[HaloRing] renderer: ${path}`),
): SelectedSurface {
  const offscreen = createOffscreen();
  let canvas: HaloSurface = offscreen ?? createCanvas();
  let gl = webglContext(canvas);

  if (!gl && offscreen) {
    canvas = createCanvas();
    gl = webglContext(canvas);
  }

  const supportsBitmap = Boolean(
    offscreen &&
    canvas === offscreen &&
    typeof (offscreen as OffscreenCanvas).transferToImageBitmap === "function",
  );
  const path: RenderPath = gl
    ? supportsBitmap
      ? "webgl-atlas"
      : "webgl-drawImage"
    : "canvas-2d";
  logPath(path);
  return { canvas, gl, path };
}

function makeDisc(background: string, surface: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create the halo disc texture");
  }

  context.fillStyle = background;
  context.fillRect(0, 0, 256, 256);
  const gradient = context.createRadialGradient(96, 74, 8, 128, 128, 190);
  gradient.addColorStop(0, surface);
  gradient.addColorStop(0.55, surface);
  gradient.addColorStop(1, "transparent");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return canvas;
}

function sourceSnapshot(source: HaloSource): HaloSource {
  return {
    level: source.level,
    act: source.act,
    low: source.low,
    mid: source.mid,
    high: source.high,
    centroid: source.centroid,
    spec: new Float32Array(source.spec),
    wave: new Float32Array(source.wave),
  };
}

function copySource(target: HaloSource, source: HaloSource) {
  target.level = source.level;
  target.act = source.act;
  target.low = source.low;
  target.mid = source.mid;
  target.high = source.high;
  target.centroid = source.centroid;
  target.spec.set(source.spec);
  target.wave.set(source.wave);
}

class SharedHaloRenderer {
  private readonly entries = new Set<HaloEntry>();
  private readonly todo: HaloEntry[] = [];
  private readonly batch: HaloEntry[] = [];
  // A bitmap is closed only after the next frame has drawn: closing it right
  // after drawImage frees its backing store while WebKit's GPU process may
  // still be reading it, which leaves the display canvas blank.
  private held: ImageBitmap[] = [];
  private spare: ImageBitmap[] = [];
  private readonly frameLoop = new HaloRafLoop((now) => this.tick(now));
  private canvas: HaloSurface;
  private gl: WebGLRenderingContext | null;
  private path: RenderPath;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uniforms: Uniforms | null = null;
  private readonly discCanvases = new Map<string, HTMLCanvasElement>();
  private startTime = performance.now();
  private lost = false;

  constructor() {
    const selected = selectRenderSurface(
      () =>
        typeof OffscreenCanvas === "undefined"
          ? null
          : new OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE),
      () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = ATLAS_SIZE;
        return canvas;
      },
    );
    this.canvas = selected.canvas;
    this.gl = selected.gl;
    this.path = selected.path;
    if (this.gl) {
      this.buildProgram();
      this.canvas.addEventListener("webglcontextlost", this.onContextLost);
      this.canvas.addEventListener(
        "webglcontextrestored",
        this.onContextRestored,
      );
    }
  }

  add(canvas: HTMLCanvasElement, config: HaloConfig): () => void {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Halo display canvas does not support 2D rendering");
    }
    const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
    const entry: HaloEntry = {
      canvas,
      context,
      config,
      visible: false,
      pixelSize: 0,
      lastDraw: 0,
      draws: 0,
      reduced: reduceQuery.matches,
      avatarTexture: null,
      dataTexture: null,
      uploadedTheme: null,
      source: config.sourceRef.current,
      frozenSource: sourceSnapshot(config.sourceRef.current),
      data: new Uint8Array(DATA_SIZE * 4),
      interpolated: new Float32Array(DATA_SIZE),
      whitened: new Float32Array(DATA_SIZE),
      peak: new Float32Array(DATA_SIZE),
      hold: new Float32Array(DATA_SIZE),
      mean: new Float32Array(DATA_SIZE).fill(0.15),
      pauseValue: config.paused ? 1 : 0,
      atlasX: 0,
      atlasY: 0,
    };
    const intersection = new IntersectionObserver(
      ([item]) => {
        entry.visible = item.isIntersecting;
        if (entry.visible) this.frameLoop.start();
      },
      { rootMargin: "80px" },
    );
    const resize = new ResizeObserver(() => {
      this.resize(entry);
      if (entry.visible) this.frameLoop.start();
    });
    const onMotionChange = (event: MediaQueryListEvent) => {
      entry.reduced = event.matches;
      entry.lastDraw = 0;
      if (entry.visible) this.frameLoop.start();
    };

    intersection.observe(canvas);
    resize.observe(canvas);
    reduceQuery.addEventListener("change", onMotionChange);
    this.entries.add(entry);
    this.resize(entry);
    this.prepareTextures(entry);

    return () => {
      intersection.disconnect();
      resize.disconnect();
      reduceQuery.removeEventListener("change", onMotionChange);
      this.deleteTextures(entry);
      this.entries.delete(entry);
      if (this.entries.size === 0) {
        this.frameLoop.stop();
        this.releaseBitmaps();
      }
    };
  }

  get renderPath(): RenderPath {
    return this.path;
  }

  drawCount(canvas: HTMLCanvasElement): number {
    for (const entry of this.entries) {
      if (entry.canvas === canvas) return entry.draws;
    }
    return 0;
  }

  invalidate(canvas: HTMLCanvasElement) {
    for (const entry of this.entries) {
      if (entry.canvas !== canvas) continue;
      entry.lastDraw = 0;
      this.frameLoop.start();
      return;
    }
  }

  private buildProgram() {
    const gl = this.gl;
    if (!gl) {
      return;
    }
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind);
      if (!shader) {
        throw new Error("Could not allocate a halo shader");
      }
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(
          `Halo shader compilation failed: ${gl.getShaderInfoLog(shader)}`,
        );
      }
      return shader;
    };

    const program = gl.createProgram();
    if (!program) {
      throw new Error("Could not allocate the halo program");
    }
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(
      program,
      compile(gl.FRAGMENT_SHADER, FRAGMENT_PRELUDE + TICKS_SHADER),
    );
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `Halo program link failed: ${gl.getProgramInfoLog(program)}`,
      );
    }

    this.program = program;
    this.buffer = gl.createBuffer();
    if (!this.buffer) {
      throw new Error("Could not allocate the halo vertex buffer");
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    this.uniforms = {
      resolution: gl.getUniformLocation(program, "uRes"),
      origin: gl.getUniformLocation(program, "uOrig"),
      tickCount: gl.getUniformLocation(program, "uTickN"),
      weight: gl.getUniformLocation(program, "uTickW"),
      spread: gl.getUniformLocation(program, "uSpread"),
      pause: gl.getUniformLocation(program, "uPause"),
      still: gl.getUniformLocation(program, "uStill"),
      clock: gl.getUniformLocation(program, "uClock"),
      accent: gl.getUniformLocation(program, "uAccA"),
      accent2: gl.getUniformLocation(program, "uAccB"),
      level: gl.getUniformLocation(program, "uLevel"),
      act: gl.getUniformLocation(program, "uAct"),
      light: gl.getUniformLocation(program, "uLight"),
      reduced: gl.getUniformLocation(program, "uReduce"),
      avatar: gl.getUniformLocation(program, "uAvatar"),
      data: gl.getUniformLocation(program, "uData"),
    };
    for (const entry of this.entries) {
      entry.lastDraw = 0;
      this.prepareTextures(entry);
    }
  }

  private createTexture(filter: number): WebGLTexture {
    const gl = this.gl;
    if (!gl) {
      throw new Error("WebGL is not available for halo texture creation");
    }
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Could not allocate a halo texture");
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private prepareTextures(entry: HaloEntry) {
    if (!this.gl || this.lost || this.gl.isContextLost()) return;
    this.ensureAvatarTexture(entry);
    const gl = this.gl;
    if (!entry.dataTexture) entry.dataTexture = this.createTexture(gl.LINEAR);
    this.uploadSource(entry, 0);
  }

  private ensureAvatarTexture(entry: HaloEntry) {
    const gl = this.gl;
    if (!gl || this.lost || gl.isContextLost()) return;
    if (entry.avatarTexture && entry.uploadedTheme === entry.config.theme)
      return;
    if (entry.avatarTexture) gl.deleteTexture(entry.avatarTexture);
    entry.avatarTexture = this.createTexture(gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.getDisc(entry.canvas),
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    entry.uploadedTheme = entry.config.theme;
  }

  private deleteTextures(entry: HaloEntry) {
    if (!this.gl || this.lost || this.gl.isContextLost()) {
      entry.avatarTexture = null;
      entry.dataTexture = null;
      entry.uploadedTheme = null;
      return;
    }
    if (entry.avatarTexture) {
      this.gl.deleteTexture(entry.avatarTexture);
      entry.avatarTexture = null;
    }
    if (entry.dataTexture) {
      this.gl.deleteTexture(entry.dataTexture);
      entry.dataTexture = null;
    }
  }

  private getDisc(canvas: HTMLCanvasElement): HTMLCanvasElement {
    const root =
      canvas.closest?.(".soft-skin") ?? canvas.ownerDocument?.documentElement;
    const styles =
      root && canvas.ownerDocument?.defaultView?.getComputedStyle(root);
    const backgroundToken = styles?.getPropertyValue("--background").trim();
    const surfaceToken = styles?.getPropertyValue("--secondary").trim();
    const background = backgroundToken ? `hsl(${backgroundToken})` : "#ffffff";
    const surface = surfaceToken
      ? `hsl(${surfaceToken} / 0.12)`
      : "rgb(0 0 0 / 0.04)";
    const key = `${background}|${surface}`;
    let disc = this.discCanvases.get(key);
    if (!disc) {
      disc = makeDisc(background, surface);
      this.discCanvases.set(key, disc);
    }
    return disc;
  }

  private uploadSource(entry: HaloEntry, dt: number) {
    const gl = this.gl;
    const texture = entry.dataTexture;
    if (!gl || !texture) {
      return;
    }
    const { source } = entry;
    const bytes = entry.data;
    const interpolated = entry.interpolated;
    for (let index = 0; index < DATA_SIZE; index++) {
      const position = (index / (DATA_SIZE - 1)) * (SPECTRUM_SIZE - 1);
      const left = Math.floor(position);
      const fraction = position - left;
      const value =
        source.spec[left] * (1 - fraction) +
        source.spec[Math.min(SPECTRUM_SIZE - 1, left + 1)] * fraction;
      interpolated[index] = value;
      bytes[index] = Math.min(255, value * 255);
      bytes[DATA_SIZE + index] = Math.max(
        0,
        Math.min(255, 128 + source.wave[index] * 127),
      );

      const activeValue = value * source.act;
      if (activeValue >= entry.peak[index]) {
        entry.peak[index] = activeValue;
        entry.hold[index] = 0.4;
      } else if ((entry.hold[index] -= dt) <= 0) {
        entry.peak[index] = Math.max(0, entry.peak[index] - dt * 0.75);
      }
      bytes[DATA_SIZE * 2 + index] = Math.min(255, entry.peak[index] * 255);
      entry.mean[index] += (value - entry.mean[index]) * Math.min(1, dt / 2.5);
    }

    const whitened = whitenSpectrum(
      interpolated,
      entry.mean,
      source.level,
      entry.whitened,
    );
    for (let index = 0; index < DATA_SIZE; index++) {
      bytes[DATA_SIZE * 3 + index] = Math.min(255, whitened[index] * 255);
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      DATA_SIZE,
      4,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      bytes,
    );
  }

  private resize(entry: HaloEntry) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    entry.pixelSize = Math.min(
      MAX_PIXEL_SIZE,
      Math.round(entry.config.size * BLEED * dpr),
    );
    if (entry.pixelSize > 0) {
      entry.canvas.width = entry.canvas.height = entry.pixelSize;
      entry.lastDraw = 0;
      entry.draws = 0;
    }
  }

  private tick(now: number): boolean {
    if (this.lost || this.gl?.isContextLost() || this.entries.size === 0) {
      return false;
    }
    this.todo.length = 0;
    let visible = false;
    for (const entry of this.entries) {
      if (!entry.visible || entry.pixelSize === 0) continue;
      visible = true;
      const { config } = entry;
      const current = config.sourceRef.current;
      if (!config.paused && !config.still)
        copySource(entry.frozenSource, current);
      entry.source =
        config.paused || config.still ? entry.frozenSource : current;
      const dt =
        entry.lastDraw === 0
          ? 1 / 60
          : Math.min(0.1, Math.max(0, (now - entry.lastDraw) / 1000));
      const pauseTarget = config.paused ? 1 : 0;
      entry.pauseValue = easePause(entry.pauseValue, pauseTarget, dt);
      const settlingPause = Math.abs(pauseTarget - entry.pauseValue) > 0.01;
      const interval = haloFrameInterval(
        this.path,
        entry.source.level,
        entry.source.act,
        config.paused || config.still,
        config.still,
        settlingPause,
      );
      if (now - entry.lastDraw >= interval) this.todo.push(entry);
    }
    if (!visible) {
      this.releaseBitmaps();
      return false;
    }
    if (this.todo.length > 0) {
      if (this.gl && this.program && this.buffer && this.uniforms) {
        this.drawWebgl(now);
      } else {
        this.drawCanvas(now);
      }
    }
    return true;
  }

  private drawWebgl(now: number) {
    const gl = this.gl!;
    if (this.lost || gl.isContextLost()) return;
    gl.useProgram(this.program!);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);

    const previous = this.held;
    this.held = this.spare;
    let x = 0;
    let y = 0;
    let shelfHeight = 0;
    this.todo.sort(compareByPixelSize);
    for (const entry of this.todo) {
      const size = entry.pixelSize;
      if (x + size > ATLAS_SIZE) {
        x = 0;
        y += shelfHeight;
        shelfHeight = 0;
      }
      if (y + size > ATLAS_SIZE) {
        this.flushBatch(now);
        x = 0;
        y = 0;
        shelfHeight = 0;
      }

      entry.atlasX = x;
      entry.atlasY = y;
      gl.viewport(x, y, size, size);
      gl.scissor(x, y, size, size);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawEntry(entry, x, y, size, now);
      this.batch.push(entry);
      x += size;
      shelfHeight = Math.max(shelfHeight, size);
    }
    this.flushBatch(now);
    for (const bitmap of previous) bitmap.close();
    previous.length = 0;
    this.spare = previous;
  }

  private releaseBitmaps() {
    for (const bitmap of this.held) bitmap.close();
    for (const bitmap of this.spare) bitmap.close();
    this.held.length = 0;
    this.spare.length = 0;
  }

  private flushBatch(now: number) {
    if (this.batch.length === 0) return;
    if (this.lost || this.gl?.isContextLost()) {
      this.batch.length = 0;
      return;
    }
    const offscreen = this.canvas as OffscreenCanvas;
    const bitmap =
      this.path === "webgl-atlas" ? offscreen.transferToImageBitmap() : null;
    const source = bitmap ?? (this.canvas as HTMLCanvasElement);
    for (const entry of this.batch) {
      const size = entry.pixelSize;
      entry.context.clearRect(0, 0, size, size);
      entry.context.drawImage(
        source,
        entry.atlasX,
        ATLAS_SIZE - entry.atlasY - size,
        size,
        size,
        0,
        0,
        size,
        size,
      );
      entry.lastDraw = now;
      entry.draws++;
    }
    if (bitmap) this.held.push(bitmap);
    this.batch.length = 0;
  }

  private drawEntry(
    entry: HaloEntry,
    x: number,
    y: number,
    size: number,
    now: number,
  ) {
    const gl = this.gl!;
    const uniforms = this.uniforms!;
    const { config } = entry;
    const paused = config.paused;
    const still = config.still;
    const dt =
      entry.lastDraw === 0
        ? 1 / 60
        : Math.min(0.1, (now - entry.lastDraw) / 1000);
    this.ensureAvatarTexture(entry);
    this.uploadSource(entry, paused || still ? 0 : dt);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.avatarTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, entry.dataTexture);
    gl.uniform1i(uniforms.avatar, 0);
    gl.uniform1i(uniforms.data, 1);
    gl.uniform2f(uniforms.resolution, size, size);
    gl.uniform2f(uniforms.origin, x, y);
    gl.uniform1f(uniforms.clock, (now - this.startTime) / 1000);
    gl.uniform1f(uniforms.pause, entry.pauseValue);
    gl.uniform1f(uniforms.still, still ? 1 : 0);
    gl.uniform3fv(uniforms.accent, ACCENTS[config.theme][0]);
    gl.uniform3fv(uniforms.accent2, ACCENTS[config.theme][1]);
    gl.uniform1f(uniforms.tickCount, config.ticks);
    gl.uniform1f(uniforms.weight, config.weight);
    gl.uniform1f(uniforms.spread, config.spread);
    gl.uniform1f(uniforms.level, entry.source.level);
    gl.uniform1f(uniforms.act, entry.source.act);
    gl.uniform1f(uniforms.light, config.theme === "day" ? 1 : 0);
    gl.uniform1f(uniforms.reduced, entry.reduced ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  private drawCanvas(now: number) {
    for (const entry of this.todo) {
      const { context, config } = entry;
      const { source } = entry;
      const size = entry.pixelSize;
      const dt =
        entry.lastDraw === 0
          ? 1 / 60
          : Math.min(0.1, (now - entry.lastDraw) / 1000);
      context.clearRect(0, 0, size, size);
      const center = size / 2;
      const discSize = size * RA;
      const discOrigin = center - discSize / 2;
      context.save();
      context.beginPath();
      context.arc(center, center, discSize / 2, 0, Math.PI * 2);
      context.clip();
      context.drawImage(
        this.getDisc(entry.canvas),
        0,
        0,
        256,
        256,
        discOrigin,
        discOrigin,
        discSize,
        discSize,
      );
      context.restore();
      for (let index = 0; index < DATA_SIZE; index++) {
        const position = (index / (DATA_SIZE - 1)) * (SPECTRUM_SIZE - 1);
        const left = Math.floor(position);
        const fraction = position - left;
        const value =
          source.spec[left] * (1 - fraction) +
          source.spec[Math.min(SPECTRUM_SIZE - 1, left + 1)] * fraction;
        entry.mean[index] +=
          (value - entry.mean[index]) * Math.min(1, dt / 2.5);
      }

      const [accentA, accentB] = ACCENTS[config.theme];
      const light = config.theme === "day";
      const neutralR = light ? 0.62 : 0.3;
      const neutralG = light ? 0.62 : 0.3;
      const neutralB = light ? 0.7 : 0.38;
      const restR = (accentA[0] + accentB[0]) / 2;
      const restG = (accentA[1] + accentB[1]) / 2;
      const restB = (accentA[2] + accentB[2]) / 2;
      const gray = (restR + restG + restB) * 0.33;
      const drainAmount = light ? 0.9 : 0.8;
      const drainedR = (gray + (restR - gray) * 0.1) * drainAmount;
      const drainedG = (gray + (restG - gray) * 0.1) * drainAmount;
      const drainedB = (gray + (restB - gray) * 0.1) * drainAmount;
      const breathAlpha = pauseBreathOpacity(
        (now - this.startTime) / 1000,
        entry.pauseValue,
        entry.reduced || config.still,
      );
      for (let index = 0; index < config.ticks; index++) {
        const angle = ((index + 0.5) / config.ticks) * Math.PI * 2 - Math.PI;
        const mirror = Math.abs(angle) / Math.PI;
        const bandPosition = mirror * 0.85 * (SPECTRUM_SIZE - 1);
        const bandLeft = Math.floor(bandPosition);
        const bandMix = bandPosition - bandLeft;
        const spectrum =
          source.spec[bandLeft] * (1 - bandMix) +
          source.spec[Math.min(SPECTRUM_SIZE - 1, bandLeft + 1)] * bandMix;
        const cell = index;
        const scatter = 0.06 + ((cell * 0.618034 + 0.21) % 1) * 0.7;
        const samplePosition = scatter * (SPECTRUM_SIZE - 1);
        const sampleLeft = Math.floor(samplePosition);
        const sampleMix = samplePosition - sampleLeft;
        const sample =
          source.spec[sampleLeft] * (1 - sampleMix) +
          source.spec[Math.min(SPECTRUM_SIZE - 1, sampleLeft + 1)] * sampleMix;
        const meanPosition = scatter * (DATA_SIZE - 1);
        const meanLeft = Math.floor(meanPosition);
        const meanMix = meanPosition - meanLeft;
        const mean =
          entry.mean[meanLeft] * (1 - meanMix) +
          entry.mean[Math.min(DATA_SIZE - 1, meanLeft + 1)] * meanMix;
        const white = Math.max(
          0,
          Math.min(
            1,
            (sample / (mean + 0.08)) * 0.45 * (0.35 + 0.9 * source.level),
          ),
        );
        const value =
          spectrum * (1 - config.spread) +
          Math.max(0, Math.min(1, white * 0.75 + source.level * 0.4)) *
            config.spread;
        const length =
          0.012 +
          Math.pow(value, 1.15) * 0.3 * source.act +
          source.level * 0.025 * source.act;
        const radius = RA + 0.055;
        const tickRadius = (radius * size) / 2;
        const tickLength = (length * size) / 2;
        const center = size / 2;
        const x = center + Math.sin(angle) * tickRadius;
        const y = center - Math.cos(angle) * tickRadius;
        const endX = x + Math.sin(angle) * tickLength;
        const endY = y - Math.cos(angle) * tickLength;
        const hotR = accentA[0] + (accentB[0] - accentA[0]) * mirror;
        const hotG = accentA[1] + (accentB[1] - accentA[1]) * mirror;
        const hotB = accentA[2] + (accentB[2] - accentA[2]) * mirror;
        const activeR = neutralR + (hotR - neutralR) * source.act;
        const activeG = neutralG + (hotG - neutralG) * source.act;
        const activeB = neutralB + (hotB - neutralB) * source.act;
        const colorR = config.still
          ? neutralR
          : activeR + (drainedR - activeR) * entry.pauseValue;
        const colorG = config.still
          ? neutralG
          : activeG + (drainedG - activeG) * entry.pauseValue;
        const colorB = config.still
          ? neutralB
          : activeB + (drainedB - activeB) * entry.pauseValue;
        const red = Math.round(colorR * 255);
        const green = Math.round(colorG * 255);
        const blue = Math.round(colorB * 255);
        context.strokeStyle = `rgb(${red} ${green} ${blue})`;
        context.globalAlpha = breathAlpha;
        context.lineWidth =
          (0.0115 + 0.003 * source.act) * config.weight * size;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(endX, endY);
        context.stroke();
      }
      context.globalAlpha = 1;
      context.beginPath();
      context.arc(center, center, discSize / 2, 0, Math.PI * 2);
      context.strokeStyle = light
        ? "rgb(158 158 179 / 0.12)"
        : "rgb(77 77 97 / 0.12)";
      context.lineWidth = 1;
      context.stroke();
      entry.lastDraw = now;
      entry.draws++;
    }
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.frameLoop.stop();
    this.releaseBitmaps();
    for (const entry of this.entries) {
      entry.avatarTexture = null;
      entry.dataTexture = null;
      entry.uploadedTheme = null;
    }
  };

  private onContextRestored = () => {
    this.lost = false;
    this.program = null;
    this.buffer = null;
    this.uniforms = null;
    this.buildProgram();
    for (const entry of this.entries) {
      entry.lastDraw = 0;
      if (entry.visible) this.frameLoop.start();
    }
  };
}

let sharedRenderer: SharedHaloRenderer | undefined;

export function registerHalo(canvas: HTMLCanvasElement, config: HaloConfig) {
  sharedRenderer ??= new SharedHaloRenderer();
  return sharedRenderer.add(canvas, config);
}

export function haloRenderPath(): RenderPath | null {
  return sharedRenderer?.renderPath ?? null;
}

export function haloDrawCount(canvas: HTMLCanvasElement): number {
  return sharedRenderer?.drawCount(canvas) ?? 0;
}

export function invalidateHalo(canvas: HTMLCanvasElement) {
  sharedRenderer?.invalidate(canvas);
}
