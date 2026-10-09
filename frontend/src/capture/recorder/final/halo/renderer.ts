import { whitenSpectrum, type HaloSource } from "./source";

export const BLEED = 1.75;
const MAX_PIXEL_SIZE = 640;
const ATLAS_SIZE = 1024;
const SPECTRUM_SIZE = 32;
const DATA_SIZE = 128;
const RA = 1 / BLEED;

export interface HaloConfig {
  size: number;
  ticks: number;
  paused: boolean;
  still: boolean;
  theme: "night" | "day";
  source: HaloSource;
  weight: number;
  spread: number;
}

type HaloSurface = HTMLCanvasElement | OffscreenCanvas;
type RenderPath = "webgl-atlas" | "webgl-drawImage" | "canvas-2d";

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
  reduced: boolean;
  avatarTexture: WebGLTexture | null;
  dataTexture: WebGLTexture | null;
  data: Uint8Array;
  peak: Float32Array;
  hold: Float32Array;
  mean: Float32Array;
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

const TICKS_SHADER = `
void main() {
  vec2 p = P();
  float r = length(p);
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
  tick *= mix(1.0, breathe, uPause);

  float glow = exp(-max(distance, 0.0) * 55.0) * 0.45 * uAct
    * (1.0 - uPause) * (1.0 - uStill);
  float disk = exp(-max(r - RA, 0.0) * 10.0) * step(RA, r) * uLevel * 0.22
    * (1.0 - uPause) * (1.0 - uStill);
  vec4 effect = vec4(color * tick, tick)
    + vec4(hot, 1.0) * (glow + disk) * (1.0 - tick) * (uLight > 0.5 ? 0.7 : 1.0);

  gl_FragColor = over(avatarAt(p, 1.0), effect) * EF(p);
}
`;

const GL_OPTIONS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  powerPreference: "low-power",
};

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

function makeDisc(theme: HaloConfig["theme"]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create the halo disc texture");
  }

  context.fillStyle = theme === "night" ? "#2a2033" : "#f4ebe4";
  context.fillRect(0, 0, 256, 256);
  const gradient = context.createRadialGradient(96, 74, 8, 128, 128, 190);
  if (theme === "night") {
    gradient.addColorStop(0, "rgba(255,255,255,.16)");
    gradient.addColorStop(0.55, "rgba(255,255,255,.07)");
    gradient.addColorStop(1, "rgba(255,255,255,.04)");
  } else {
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.55, "#f7efe9");
    gradient.addColorStop(1, "#efe4dc");
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return canvas;
}

class SharedHaloRenderer {
  private readonly entries = new Set<HaloEntry>();
  private canvas: HaloSurface;
  private gl: WebGLRenderingContext | null;
  private path: RenderPath;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uniforms: Uniforms | null = null;
  private readonly discCanvases = new Map<
    HaloConfig["theme"],
    HTMLCanvasElement
  >();
  private startTime = performance.now();

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
    requestAnimationFrame(this.tick);
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
      reduced: reduceQuery.matches,
      avatarTexture: null,
      dataTexture: null,
      data: new Uint8Array(DATA_SIZE * 4),
      peak: new Float32Array(DATA_SIZE),
      hold: new Float32Array(DATA_SIZE),
      mean: new Float32Array(DATA_SIZE).fill(0.15),
    };
    const intersection = new IntersectionObserver(
      ([item]) => {
        entry.visible = item.isIntersecting;
      },
      { rootMargin: "80px" },
    );
    const resize = new ResizeObserver(() => this.resize(entry));
    const onMotionChange = (event: MediaQueryListEvent) => {
      entry.reduced = event.matches;
      entry.lastDraw = 0;
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
    };
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
    if (!this.gl) {
      return;
    }
    this.deleteTextures(entry);
    const gl = this.gl;
    entry.avatarTexture = this.createTexture(gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.getDisc(entry.config.theme),
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    entry.dataTexture = this.createTexture(gl.LINEAR);
    this.uploadSource(entry, 0);
  }

  private deleteTextures(entry: HaloEntry) {
    if (!this.gl) {
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

  private getDisc(theme: HaloConfig["theme"]): HTMLCanvasElement {
    let disc = this.discCanvases.get(theme);
    if (!disc) {
      disc = makeDisc(theme);
      this.discCanvases.set(theme, disc);
    }
    return disc;
  }

  private uploadSource(entry: HaloEntry, dt: number) {
    const gl = this.gl;
    const texture = entry.dataTexture;
    if (!gl || !texture) {
      return;
    }
    const { source } = entry.config;
    const bytes = entry.data;
    const interpolated = new Float32Array(DATA_SIZE);
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

    const whitened = whitenSpectrum(interpolated, entry.mean, source.level);
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
    }
  }

  private tick = (now: number) => {
    requestAnimationFrame(this.tick);
    const idleInterval = 1000 / 15;
    const entries = [...this.entries].filter((entry) => {
      if (!entry.visible || entry.pixelSize === 0) {
        return false;
      }
      const lowActivity =
        entry.config.paused ||
        entry.config.still ||
        entry.config.source.act < 0.01;
      const interval =
        this.path === "canvas-2d" || lowActivity ? idleInterval : 0;
      return now - entry.lastDraw >= interval;
    });
    if (entries.length === 0) {
      return;
    }
    if (this.gl && this.program && this.buffer && this.uniforms) {
      this.drawWebgl(entries, now);
    } else {
      this.drawCanvas(entries, now);
    }
  };

  private drawWebgl(entries: HaloEntry[], now: number) {
    const gl = this.gl!;
    gl.useProgram(this.program!);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);

    const batch: Array<{ entry: HaloEntry; x: number; y: number }> = [];
    let x = 0;
    let y = 0;
    let shelfHeight = 0;
    const flush = () => {
      if (batch.length === 0) {
        return;
      }
      const offscreen = this.canvas as OffscreenCanvas;
      const bitmap =
        this.path === "webgl-atlas" ? offscreen.transferToImageBitmap() : null;
      const source = bitmap ?? (this.canvas as HTMLCanvasElement);
      for (const item of batch) {
        const size = item.entry.pixelSize;
        item.entry.context.clearRect(0, 0, size, size);
        item.entry.context.drawImage(
          source,
          item.x,
          ATLAS_SIZE - item.y - size,
          size,
          size,
          0,
          0,
          size,
          size,
        );
        item.entry.lastDraw = now;
      }
      bitmap?.close();
      batch.length = 0;
    };

    const sorted = [...entries].sort((a, b) => b.pixelSize - a.pixelSize);
    for (const entry of sorted) {
      const size = entry.pixelSize;
      if (x + size > ATLAS_SIZE) {
        x = 0;
        y += shelfHeight;
        shelfHeight = 0;
      }
      if (y + size > ATLAS_SIZE) {
        flush();
        x = 0;
        y = 0;
        shelfHeight = 0;
      }

      gl.viewport(x, y, size, size);
      gl.scissor(x, y, size, size);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.drawEntry(entry, x, y, size, now);
      batch.push({ entry, x, y });
      x += size;
      shelfHeight = Math.max(shelfHeight, size);
    }
    flush();
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
    gl.uniform1f(uniforms.pause, paused ? 1 : 0);
    gl.uniform1f(uniforms.still, still ? 1 : 0);
    gl.uniform3fv(uniforms.accent, this.accent(config.theme, false));
    gl.uniform3fv(uniforms.accent2, this.accent(config.theme, true));
    gl.uniform1f(uniforms.tickCount, config.ticks);
    gl.uniform1f(uniforms.weight, config.weight);
    gl.uniform1f(uniforms.spread, config.spread);
    gl.uniform1f(uniforms.level, config.source.level);
    gl.uniform1f(uniforms.act, config.source.act);
    gl.uniform1f(uniforms.light, config.theme === "day" ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private accent(theme: HaloConfig["theme"], second: boolean): Float32Array {
    const hex =
      theme === "night"
        ? second
          ? "#e8475a"
          : "#ff6b62"
        : second
          ? "#f07a72"
          : "#e5483f";
    return new Float32Array([
      Number.parseInt(hex.slice(1, 3), 16) / 255,
      Number.parseInt(hex.slice(3, 5), 16) / 255,
      Number.parseInt(hex.slice(5, 7), 16) / 255,
    ]);
  }

  private drawCanvas(entries: HaloEntry[], now: number) {
    for (const entry of entries) {
      const { context, config } = entry;
      const size = entry.pixelSize;
      const dt =
        entry.lastDraw === 0
          ? 1 / 60
          : Math.min(0.1, (now - entry.lastDraw) / 1000);
      context.clearRect(0, 0, size, size);
      context.drawImage(
        this.getDisc(config.theme),
        0,
        0,
        size,
        size,
        (size * (1 - RA)) / 2,
        (size * (1 - RA)) / 2,
        size * RA,
        size * RA,
      );
      for (let index = 0; index < DATA_SIZE; index++) {
        const position = (index / (DATA_SIZE - 1)) * (SPECTRUM_SIZE - 1);
        const left = Math.floor(position);
        const fraction = position - left;
        const value =
          config.source.spec[left] * (1 - fraction) +
          config.source.spec[Math.min(SPECTRUM_SIZE - 1, left + 1)] * fraction;
        entry.mean[index] +=
          (value - entry.mean[index]) * Math.min(1, dt / 2.5);
      }

      const paused = config.paused;
      const neutral = config.theme === "day" ? "#9e9eaa" : "#4d4d61";
      const restA = config.theme === "night" ? "#ff6b62" : "#e5483f";
      const restB = config.theme === "night" ? "#e8475a" : "#f07a72";
      const drained = config.theme === "day" ? "#d9d4d9" : "#59515f";
      const breathe =
        paused && !config.still && !entry.reduced
          ? 0.62 +
            0.38 * (0.5 + 0.5 * Math.sin(((now - this.startTime) / 1000) * 2.4))
          : 1;
      for (let index = 0; index < config.ticks; index++) {
        const angle = ((index + 0.5) / config.ticks) * Math.PI * 2 - Math.PI;
        const cell = Math.floor((angle / (Math.PI * 2) + 0.5) * config.ticks);
        const mirror = Math.abs(angle) / Math.PI;
        const bandPosition = mirror * 0.85 * (SPECTRUM_SIZE - 1);
        const bandLeft = Math.floor(bandPosition);
        const bandMix = bandPosition - bandLeft;
        const spectrum =
          config.source.spec[bandLeft] * (1 - bandMix) +
          config.source.spec[Math.min(SPECTRUM_SIZE - 1, bandLeft + 1)] *
            bandMix;
        const scatter = 0.06 + ((cell * 0.618034 + 0.21) % 1) * 0.7;
        const samplePosition = scatter * (SPECTRUM_SIZE - 1);
        const sampleLeft = Math.floor(samplePosition);
        const sampleMix = samplePosition - sampleLeft;
        const sample =
          config.source.spec[sampleLeft] * (1 - sampleMix) +
          config.source.spec[Math.min(SPECTRUM_SIZE - 1, sampleLeft + 1)] *
            sampleMix;
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
            (sample / (mean + 0.08)) *
              0.45 *
              (0.35 + 0.9 * config.source.level),
          ),
        );
        const value =
          spectrum * (1 - config.spread) +
          Math.max(0, Math.min(1, white * 0.75 + config.source.level * 0.4)) *
            config.spread;
        const length =
          0.012 +
          Math.pow(value, 1.15) * 0.3 * config.source.act +
          config.source.level * 0.025 * config.source.act;
        const radius = RA + 0.055;
        const tickRadius = (radius * size) / 2;
        const tickLength = (length * size) / 2;
        const center = size / 2;
        const x = center + Math.sin(angle) * tickRadius;
        const y = center - Math.cos(angle) * tickRadius;
        const endX = x + Math.sin(angle) * tickLength;
        const endY = y - Math.cos(angle) * tickLength;
        const accent = mirror < 0.5 ? restA : restB;
        context.strokeStyle = config.still
          ? neutral
          : paused
            ? drained
            : accent;
        context.globalAlpha =
          paused || config.still ? 1 : Math.max(0.3, config.source.act);
        context.lineWidth =
          ((0.0115 + 0.003 * config.source.act) * config.weight * size) / 2;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + (endX - x) * breathe, y + (endY - y) * breathe);
        context.stroke();
      }
      context.globalAlpha = 1;
      entry.lastDraw = now;
    }
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
  };

  private onContextRestored = () => {
    this.program = null;
    this.buffer = null;
    this.uniforms = null;
    this.buildProgram();
  };
}

let sharedRenderer: SharedHaloRenderer | undefined;

export function registerHalo(canvas: HTMLCanvasElement, config: HaloConfig) {
  sharedRenderer ??= new SharedHaloRenderer();
  return sharedRenderer.add(canvas, config);
}
