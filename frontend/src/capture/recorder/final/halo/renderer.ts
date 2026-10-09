import type { HaloSource } from "./source";

export interface HaloConfig { size: number; ticks: number; paused: boolean; still: boolean; theme: "night" | "day"; source: HaloSource; weight: number; spread: number }
interface Entry { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; config: HaloConfig; visible: boolean; pixelSize: number; lastDraw: number; reduced: boolean; mean: Float32Array }
const ATLAS = 2048;
const VERTEX = "attribute vec2 p; void main(){gl_Position=vec4(p,0.,1.);}";
const FRAGMENT = `precision mediump float; uniform vec2 resolution, origin; uniform float tickCount, weight, spread, level, act, paused, still, clock, reduced; uniform vec3 accent, accent2; uniform float spectrum[32], whiteSpectrum[32];
void main(){ vec2 p=(gl_FragCoord.xy-origin-resolution*.5)/(resolution.y*.5); float r=length(p); float a=atan(p.x,p.y); float cell=floor((a/6.2831853+.5)*tickCount); float ac=(cell+.5)/tickCount*6.2831853-3.1415926; vec2 dir=vec2(sin(ac),cos(ac)), tan=vec2(dir.y,-dir.x); float band=abs(ac)/3.1415926; float ix=floor(fract(cell*.618034+.21)*32.); float spec=0., white=0.; for(int i=0;i<32;i++){if(abs(float(i)-ix)<.5){spec=spectrum[i];white=whiteSpectrum[i];}} float v=mix(spec, clamp(white*.75+level*.4,0.,1.), spread); float len=(.012+pow(v,1.15)*.30*act+level*.025*act)*mix(1.,.42,paused); float along=dot(p,dir)-.62; float across=abs(dot(p,tan)); float d=length(vec2(max(0.,abs(along-len*.5)-len*.5),across))-(.0115+.003*act)*weight; float tick=1.-smoothstep(-2./resolution.y,2./resolution.y,d); float breathe=1.; if(paused>.5&&reduced<.5) breathe=.62+.38*(.5+.5*sin(clock*2.4)); tick*=breathe; vec3 hot=mix(accent,accent2,band); vec3 neutral=vec3(.30,.30,.38); vec3 col=mix(neutral,hot,act); if(paused>.5) col=mix(col,vec3(.42),.8); if(still>.5) col=vec3(.42); float glow=exp(-max(d,0.)*55.)*.24*act*(1.-paused)*(1.-still); float inside=1.-smoothstep(.57,.575,r); gl_FragColor=vec4(col*tick+hot*glow, max(tick,glow))*(1.-inside); }`;

class SharedHaloRenderer {
  private entries = new Set<Entry>();
  private atlas: OffscreenCanvas | HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private glProgram: WebGLProgram | null = null;
  private glBuffer: WebGLBuffer | null = null;
  private path: "webgl-atlas" | "webgl-drawImage" | "canvas-2d";
  private frame = 0;
  private start = performance.now();

  constructor() {
    let atlas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(ATLAS, ATLAS) : document.createElement("canvas");
    atlas.width = atlas.height = ATLAS;
    let gl: WebGLRenderingContext | null = atlas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" }) as WebGLRenderingContext | null;
    if (gl) this.path = typeof (atlas as OffscreenCanvas).transferToImageBitmap === "function" ? "webgl-atlas" : "webgl-drawImage";
    else { atlas = document.createElement("canvas"); atlas.width = atlas.height = ATLAS; gl = null; this.path = "canvas-2d"; }
    this.atlas = atlas;
    this.gl = gl;
    if (gl) this.buildProgram();
    console.info(`[HaloRing] renderer: ${this.path}`);
    if (gl) {
      atlas.addEventListener("webglcontextlost", (event) => event.preventDefault());
      atlas.addEventListener("webglcontextrestored", () => this.buildProgram());
    }
    requestAnimationFrame(this.tick);
  }

  private buildProgram() {
    const gl = this.gl;
    if (!gl) return;
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind);
      if (!shader) throw new Error("Could not allocate halo shader");
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Halo shader compilation failed: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram();
    if (!program) throw new Error("Could not allocate halo program");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.bindAttribLocation(program, 0, "p"); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Halo program link failed: ${gl.getProgramInfoLog(program)}`);
    this.glProgram = program;
    this.glBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    for (const entry of this.entries) entry.lastDraw = 0;
  }

  add(canvas: HTMLCanvasElement, config: HaloConfig): () => void {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Halo display canvas does not support 2D rendering");
    const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
    const entry: Entry = { canvas, context, config, visible: false, pixelSize: 0, lastDraw: 0, reduced: reduceQuery.matches, mean: new Float32Array(32).fill(0.15) };
    const observer = new IntersectionObserver(([item]) => { entry.visible = item.isIntersecting; });
    observer.observe(canvas);
    const resize = new ResizeObserver(() => this.resize(entry)); resize.observe(canvas);
    reduceQuery.addEventListener("change", (event) => { entry.reduced = event.matches; entry.lastDraw = 0; });
    this.entries.add(entry); this.resize(entry);
    return () => { observer.disconnect(); resize.disconnect(); this.entries.delete(entry); };
  }

  private resize(entry: Entry) {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    entry.pixelSize = Math.max(1, Math.round(entry.config.size * 1.75 * scale));
    entry.canvas.width = entry.canvas.height = entry.pixelSize;
    entry.lastDraw = 0;
  }

  private tick = (now: number) => {
    requestAnimationFrame(this.tick);
    if (!this.entries.size) return;
    const eligible = [...this.entries].filter((entry) => entry.visible && (now - entry.lastDraw > (entry.config.paused || entry.config.still || entry.config.source.act < .01 ? 66 : 0)));
    if (!eligible.length) return;
    const gl = this.gl;
    if (gl && this.glProgram && this.glBuffer) this.drawWebgl(eligible, now);
    else this.drawCanvas(eligible, now);
  };

  private drawWebgl(entries: Entry[], now: number) {
    const gl = this.gl!; gl.useProgram(this.glProgram!); gl.bindBuffer(gl.ARRAY_BUFFER, this.glBuffer!);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.enable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0);
    const batch: Array<{ entry: Entry; x: number; y: number }> = [];
    let x = 0, y = 0, shelf = 0;
    for (const entry of [...entries].sort((a, b) => b.pixelSize - a.pixelSize)) {
      const n = Math.min(entry.pixelSize, ATLAS);
      if (x + n > ATLAS) { x = 0; y += shelf; shelf = 0; }
      if (y + n > ATLAS) throw new Error("Halo atlas capacity exceeded for visible rings");
      gl.viewport(x, y, n, n); gl.scissor(x, y, n, n); gl.clear(gl.COLOR_BUFFER_BIT);
      this.uniform(entry, n, x, y, now);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      batch.push({ entry, x, y }); x += n; shelf = Math.max(shelf, n);
    }
    let source: CanvasImageSource = this.atlas as HTMLCanvasElement;
    const offscreen = this.atlas as OffscreenCanvas;
    if (typeof offscreen.transferToImageBitmap === "function") source = offscreen.transferToImageBitmap();
    for (const { entry, x: left, y: top } of batch) {
      entry.context.clearRect(0, 0, entry.pixelSize, entry.pixelSize);
      entry.context.drawImage(source, left, ATLAS - top - entry.pixelSize, entry.pixelSize, entry.pixelSize, 0, 0, entry.pixelSize, entry.pixelSize);
      entry.lastDraw = now;
    }
    if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
  }

  private uniform(entry: Entry, size: number, x: number, y: number, now: number) {
    const gl = this.gl!, p = this.glProgram!, c = entry.config;
    const u = (name: string) => gl.getUniformLocation(p, name);
    const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255);
    const a = c.theme === "night" ? "#ff6b62" : "#e5483f", b = c.theme === "night" ? "#e8475a" : "#f07a72";
    gl.uniform2f(u("resolution"), size, size); gl.uniform2f(u("origin"), x, y); gl.uniform1f(u("tickCount"), c.ticks); gl.uniform1f(u("weight"), c.weight); gl.uniform1f(u("spread"), c.spread);
    gl.uniform1f(u("level"), c.source.level); gl.uniform1f(u("act"), c.source.act); gl.uniform1f(u("paused"), c.paused ? 1 : 0); gl.uniform1f(u("still"), c.still ? 1 : 0);
    const delta = Math.min(1, (now - entry.lastDraw) / 2500);
    const white = new Float32Array(32);
    for (let i = 0; i < 32; i++) {
      entry.mean[i] += (c.source.spec[i] - entry.mean[i]) * delta;
      white[i] = Math.max(0, Math.min(1, c.source.spec[i] / (entry.mean[i] + 0.08) * 0.45 * (0.35 + 0.9 * c.source.level)));
    }
    gl.uniform1f(u("clock"), (now - this.start) / 1000); gl.uniform1f(u("reduced"), entry.reduced ? 1 : 0);
    gl.uniform3fv(u("accent"), rgb(a)); gl.uniform3fv(u("accent2"), rgb(b));
    gl.uniform1fv(u("spectrum[0]"), c.source.spec); gl.uniform1fv(u("whiteSpectrum[0]"), white);
  }

  private drawCanvas(entries: Entry[], now: number) {
    for (const entry of entries) {
      const ctx = entry.context, n = entry.pixelSize, c = entry.config;
      const delta = Math.min(1, (now - entry.lastDraw) / 2500);
      for (let i = 0; i < 32; i++) entry.mean[i] += (c.source.spec[i] - entry.mean[i]) * delta;
      ctx.clearRect(0, 0, n, n);
      for (let i = 0; i < c.ticks; i++) {
        const angle = i / c.ticks * Math.PI * 2 - Math.PI;
        const index = Math.floor(((i * 0.618034 + 0.21) % 1) * 32);
        const white = Math.max(0, Math.min(1, c.source.spec[index] / (entry.mean[index] + 0.08) * 0.45 * (0.35 + 0.9 * c.source.level)));
        const v = c.source.spec[index] * (1 - c.spread) + Math.max(0, Math.min(1, white * 0.75 + c.source.level * 0.4)) * c.spread;
        const length = (0.012 + Math.pow(v, 1.15) * 0.30 * c.source.act + c.source.level * 0.025 * c.source.act) * n / 2;
        const pulse = c.paused && !c.still && !entry.reduced ? 0.62 + 0.38 * (0.5 + 0.5 * Math.sin((now - this.start) / 1000 * 2.4)) : 1;
        const radius = 0.62 * n / 2;
        const x = n / 2 + Math.sin(angle) * radius, y = n / 2 - Math.cos(angle) * radius;
        const endX = x + Math.sin(angle) * length * pulse, endY = y - Math.cos(angle) * length * pulse;
        const colors = c.theme === "night" ? ["#ff6b62", "#e8475a"] : ["#e5483f", "#f07a72"];
        ctx.strokeStyle = c.still ? "#77747b" : c.paused ? "#77747b" : colors[Math.floor(i / c.ticks * 2)];
        ctx.globalAlpha = c.paused ? 0.8 : Math.max(0.3, c.source.act);
        ctx.lineWidth = Math.max(1, (0.0115 + 0.003 * c.source.act) * c.weight * n);
        ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY); ctx.stroke();
      }
      ctx.globalAlpha = 1; entry.lastDraw = now;
    }
  }
}

let shared: SharedHaloRenderer | undefined;
export function registerHalo(canvas: HTMLCanvasElement, config: HaloConfig) { shared ??= new SharedHaloRenderer(); return shared.add(canvas, config); }
