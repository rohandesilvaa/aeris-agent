import { useEffect, useRef } from "react";

export type FaceState = "idle" | "listening" | "thinking" | "speaking" | "offline";

type Vec3 = [number, number, number];

const STATE_WORDS: Record<FaceState, string> = {
  idle: "ready",
  listening: "listening",
  thinking: "working",
  speaking: "speaking",
  offline: "offline",
};

// Hologram light: each teammate has its own colour; amber means working and
// slate means offline, whoever it is.
const DEFAULT_TONE: Vec3 = [142, 222, 255];
const WORKING_TONE: Vec3 = [255, 192, 118];
const OFFLINE_TONE: Vec3 = [104, 118, 136];

function stateTone(state: FaceState, tone: Vec3): Vec3 {
  if (state === "thinking") return WORKING_TONE;
  if (state === "offline") return OFFLINE_TONE;
  if (state === "listening") return [tone[0] + (255 - tone[0]) * 0.45, tone[1] + (255 - tone[1]) * 0.45, tone[2] + (255 - tone[2]) * 0.45];
  return tone;
}

// ---- Head geometry -------------------------------------------------------
// Head space: x to the face's left, y up, z out of the face. The skull is an
// ellipsoid, narrowed toward the jaw, with the facial relief pushed out of it.
const HEAD_X = 0.69;
const HEAD_Y = 1;
const HEAD_Z = 0.88;
const RINGS = 66;
const SEGMENTS = 100;

const smooth = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
const bump = (value: number, width: number) => Math.exp(-(value * value) / (width * width));

function relief(u: number, v: number): number {
  const side = Math.abs(u);
  return (
    bump(u, 0.075) * bump(v + 0.02, 0.2) * 0.075 + // nose ridge
    bump(u, 0.095) * bump(v + 0.17, 0.075) * 0.15 + // nose tip
    bump(side - 0.085, 0.04) * bump(v + 0.2, 0.04) * 0.03 - // nostrils
    bump(side - 0.25, 0.12) * bump(v - 0.1, 0.075) * 0.1 + // eye sockets
    bump(u, 0.55) * bump(v - 0.24, 0.06) * 0.05 + // brow ridge
    bump(side - 0.42, 0.14) * bump(v + 0.1, 0.13) * 0.035 + // cheekbones
    bump(u, 0.2) * bump(v + 0.42, 0.05) * 0.05 - // lips
    bump(u, 0.16) * bump(v + 0.52, 0.035) * 0.022 + // crease under the lip
    bump(u, 0.17) * bump(v + 0.68, 0.09) * 0.05 // chin
  );
}

const jawTaper = (y: number) => 1 - 0.27 * Math.pow(smooth(0, 1, -y), 1.4);
// Half-width of the head at height y: a superellipse, squarer below the eyes
// so the jaw reads as a jaw instead of tapering to a point.
const ringWidth = (y: number) => {
  const power = y < 0 ? 2.45 : 2.15;
  return Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(y) / HEAD_Y), power)), 1 / power);
};

function headPoint(y: number, lon: number): Vec3 {
  const ring = ringWidth(y);
  const lower = smooth(0, 1, -y);
  const x = HEAD_X * ring * Math.sin(lon) * jawTaper(y);
  let z = HEAD_Z * ring * Math.cos(lon);
  z *= z > 0 ? 1 - 0.1 * lower : 1 - 0.42 * lower;
  const facing = Math.cos(lon);
  if (facing > 0) z += relief(x, y) * Math.sqrt(facing);
  return [x, y, z];
}

/** A point on the front of the face at face coordinates (u, v). */
function facePoint(u: number, v: number, lift = 0.012): Vec3 {
  const reach = HEAD_X * ringWidth(v) * jawTaper(v);
  const lon = Math.asin(Math.max(-0.98, Math.min(0.98, u / reach)));
  const point = headPoint(v, lon);
  return [u, v, point[2] + lift];
}

type HeadMesh = { positions: Float32Array; normals: Float32Array };

function buildHead(): HeadMesh {
  const positions = new Float32Array(RINGS * SEGMENTS * 3);
  const normals = new Float32Array(RINGS * SEGMENTS * 3);
  const ringY = (ring: number) => -0.985 + (1.97 * ring) / (RINGS - 1);
  const lonAt = (segment: number) => (segment / SEGMENTS) * Math.PI * 2 - Math.PI;
  for (let ring = 0; ring < RINGS; ring++) {
    for (let segment = 0; segment < SEGMENTS; segment++) {
      const y = ringY(ring);
      const lon = lonAt(segment);
      const point = headPoint(y, lon);
      const east = headPoint(y, lon + 0.02);
      const west = headPoint(y, lon - 0.02);
      const north = headPoint(Math.min(0.995, y + 0.02), lon);
      const south = headPoint(Math.max(-0.995, y - 0.02), lon);
      const ax = east[0] - west[0], ay = east[1] - west[1], az = east[2] - west[2];
      const bx = north[0] - south[0], by = north[1] - south[1], bz = north[2] - south[2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      if (nx * point[0] + ny * point[1] + nz * point[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const length = Math.hypot(nx, ny, nz) || 1;
      const index = (ring * SEGMENTS + segment) * 3;
      positions.set(point, index);
      normals.set([nx / length, ny / length, nz / length], index);
    }
  }
  return { positions, normals };
}

// Neck arcs under the jaw, then shoulder lines that slope away like a coat
// hanger so the figure reads as a bust instead of a head on a stand.
function buildBust(): Vec3[][] {
  const lines: Vec3[][] = [];
  for (let level = 0; level < 4; level++) {
    const y = -0.88 - level * 0.075;
    const line: Vec3[] = [];
    for (let step = 0; step <= 24; step++) {
      const angle = (step / 24 - 0.5) * Math.PI * 1.05;
      line.push([Math.sin(angle) * 0.37, y, -0.16 + Math.cos(angle) * 0.38]);
    }
    lines.push(line);
  }
  for (let level = 0; level < 7; level++) {
    const reach = 0.5 + level * 0.14;
    const line: Vec3[] = [];
    for (let step = 0; step <= 40; step++) {
      const x = (step / 40 - 0.5) * 2 * reach;
      const slope = smooth(0.28, 1.35, Math.abs(x));
      line.push([x, -1.2 - level * 0.075 - slope * 0.5, -0.12 + Math.cos((x / 1.4) * Math.PI * 0.5) * 0.3]);
    }
    lines.push(line);
  }
  return lines;
}

const range = (count: number) => Array.from({ length: count + 1 }, (_, index) => index / count);

const EYE_X = 0.25;
const EYE_Y = 0.1;

function eyeOutline(side: number, openness: number): Vec3[] {
  return range(28).map((t) => {
    const angle = t * Math.PI * 2;
    const lid = Math.sin(angle);
    // The upper lid arches more than the lower one.
    const height = (lid > 0 ? 0.036 : 0.022) * openness;
    return facePoint(side * EYE_X + Math.cos(angle) * 0.096, EYE_Y + lid * height);
  });
}

function brow(side: number, raise: number): Vec3[] {
  return range(12).map((t) => facePoint(side * (0.12 + t * 0.28), 0.215 + raise + Math.sin(t * Math.PI) * 0.028 - t * 0.02, 0.02));
}

const MOUTH_HALF = 0.175;
function mouthLine(kind: "top" | "upper" | "lower" | "bottom", open: number): Vec3[] {
  return range(20).map((t) => {
    const u = (t * 2 - 1) * MOUTH_HALF;
    const across = u / MOUTH_HALF;
    const middle = 1 - across * across;
    let v = -0.428 - 0.006 * across * across;
    if (kind === "top") v += 0.034 * middle - 0.012 * bump(u, 0.035);
    if (kind === "upper") v += open * 0.25 * middle;
    if (kind === "lower") v -= open * middle;
    if (kind === "bottom") v -= (0.05 + open * 0.85) * middle;
    return facePoint(u, v, 0.016);
  });
}

const NOSE_BASE = range(12).map((t) => {
  const u = (t * 2 - 1) * 0.085;
  return facePoint(u, -0.222 - 0.014 * Math.cos((u / 0.085) * Math.PI * 0.5), 0.01);
});

// The sides of the nose, from the brow down to the nostril.
const noseSide = (side: number) => range(14).map((t) => facePoint(side * (0.035 + 0.05 * t * t), 0.17 - t * 0.37, 0.004));

function ear(side: number): Vec3[] {
  return range(22).map((t) => {
    const angle = t * Math.PI * 2;
    const y = -0.03 + Math.sin(angle) * 0.19;
    const edge = HEAD_X * ringWidth(y) * jawTaper(y);
    return [side * (edge + 0.012 + (Math.cos(angle) + 1) * 0.038), y, -0.1 + Math.cos(angle) * 0.03];
  });
}

const HEAD = buildHead();
const BUST = buildBust();
const SHADE_LEVELS = 12;

type Props = { state: FaceState; tone?: Vec3; label?: string; className?: string };

export default function HoloFace({ state, tone = DEFAULT_TONE, label, className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const toneRef = useRef(tone);
  toneRef.current = tone;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const vertexCount = RINGS * SEGMENTS;
    const screenX = new Float32Array(vertexCount);
    const screenY = new Float32Array(vertexCount);
    const shade = new Float32Array(vertexCount);
    const buckets = Array.from({ length: SHADE_LEVELS }, () => new Float32Array(vertexCount * 4));
    const bucketFill = new Int32Array(SHADE_LEVELS);

    let width = 0, height = 0, pixelRatio = 1;
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(bounds.width * pixelRatio));
      height = Math.max(1, Math.round(bounds.height * pixelRatio));
      canvas.width = width;
      canvas.height = height;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const pointer = { x: 0, y: 0 };
    const onPointerMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointerMove);

    // Eased values, so every state change glides instead of snapping.
    const tone: Vec3 = [...stateTone(stateRef.current, toneRef.current)];
    let yaw = 0, pitch = 0, mouth = 0, energy = 0, focus = 0, glow = 1;
    let nextBlink = 2.5, blinkStart = -1;
    let frame = 0;
    let previous = performance.now();
    let clock = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const delta = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      if (document.hidden) return;
      clock += delta * (reducedMotion ? 0.25 : 1);
      const current = stateRef.current;
      const ease = (speed: number) => 1 - Math.exp(-delta * speed);

      const target = stateTone(current, toneRef.current);
      for (let channel = 0; channel < 3; channel++) tone[channel] += (target[channel] - tone[channel]) * ease(5);
      const color = (alpha: number) => `rgba(${tone[0] | 0}, ${tone[1] | 0}, ${tone[2] | 0}, ${alpha})`;

      // Head pose: a slow idle sway, a lean toward the pointer, a tilt while thinking.
      const sway = current === "offline" ? 0 : Math.sin(clock * 0.42) * 0.2;
      const targetYaw = sway + pointer.x * 0.22 + (current === "thinking" ? Math.sin(clock * 0.9) * 0.1 - 0.12 : 0);
      const targetPitch = 0.13 + Math.sin(clock * 0.31) * 0.03 + pointer.y * 0.1 + (current === "listening" ? 0.06 : current === "offline" ? 0.16 : 0);
      yaw += (targetYaw - yaw) * ease(3);
      pitch += (targetPitch - pitch) * ease(3);

      // Mouth follows a speech-like envelope: syllable bursts with short pauses.
      const syllable = Math.abs(Math.sin(clock * 9.2) * Math.sin(clock * 5.1 + 1.3));
      const phrase = smooth(-0.35, 0.1, Math.sin(clock * 1.7));
      const targetMouth = current === "speaking" ? (0.012 + syllable * 0.085) * phrase : 0;
      mouth += (targetMouth - mouth) * ease(22);
      energy += ((current === "speaking" ? 0.35 + syllable * 0.65 * phrase : current === "listening" ? 0.45 + Math.sin(clock * 3.1) * 0.2 : 0.08) - energy) * ease(10);
      focus += ((current === "thinking" ? 1 : 0) - focus) * ease(4);
      glow += ((current === "offline" ? 0.38 : 1) - glow) * ease(4);

      if (blinkStart < 0 && clock > nextBlink) blinkStart = clock;
      let openness = 1;
      if (blinkStart >= 0) {
        const phase = (clock - blinkStart) / 0.16;
        openness = phase >= 1 ? 1 : Math.abs(phase * 2 - 1) * 0.9 + 0.1;
        if (phase >= 1) { blinkStart = -1; nextBlink = clock + 2.4 + Math.random() * 3.5; }
      }
      if (current === "offline") openness = 0.12;
      if (current === "listening") openness *= 1.08;

      const size = Math.min(width, height);
      const centerX = width / 2;
      const centerY = height * 0.52;
      const unit = size * 0.288;
      const breathing = 1 + Math.sin(clock * 1.25) * 0.006;
      const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw), cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);
      const CAMERA = 4.4;
      const project = (x: number, y: number, z: number): Vec3 => {
        const rx = x * cosYaw + z * sinYaw;
        const rz1 = -x * sinYaw + z * cosYaw;
        const ry = y * cosPitch - rz1 * sinPitch;
        const rz = y * sinPitch + rz1 * cosPitch;
        const scale = (unit * breathing * CAMERA) / (CAMERA - rz);
        return [centerX + rx * scale, centerY - (ry + 0.3) * scale, rz];
      };

      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";
      context.lineCap = "round";
      context.lineJoin = "round";

      // Projector glow under the bust.
      const base = context.createRadialGradient(centerX, centerY + unit * 1.42, 0, centerX, centerY + unit * 1.42, unit * 1.5);
      base.addColorStop(0, color(0.16 * glow));
      base.addColorStop(1, color(0));
      context.fillStyle = base;
      context.beginPath();
      context.arc(centerX, centerY + unit * 1.42, unit * 1.5, 0, Math.PI * 2);
      context.fill();

      // Scan band: sweeps the face while thinking, drifts faintly otherwise.
      const scanY = Math.sin(clock * (1.1 + focus * 1.5)) * 0.95;
      const scanStrength = 0.12 + focus * 0.6;

      // --- Head: horizontal contour lines, shaded by a fixed key light. ---
      const { positions, normals } = HEAD;
      const lightX = -0.52, lightY = 0.36, lightZ = 0.78;
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        const index = vertex * 3;
        const x = positions[index], y = positions[index + 1], z = positions[index + 2];
        const point = project(x, y, z);
        screenX[vertex] = point[0];
        screenY[vertex] = point[1];
        const nx = normals[index], ny = normals[index + 1], nz = normals[index + 2];
        const rnx = nx * cosYaw + nz * sinYaw;
        const rnz1 = -nx * sinYaw + nz * cosYaw;
        const rny = ny * cosPitch - rnz1 * sinPitch;
        const rnz = ny * sinPitch + rnz1 * cosPitch;
        if (rnz < -0.05) {
          shade[vertex] = 0.035; // the far side of the head shows through faintly
          continue;
        }
        const lambert = Math.max(0, rnx * lightX + rny * lightY + rnz * lightZ);
        const rim = Math.pow(1 - Math.max(0, rnz), 3);
        const scan = bump(y - scanY, 0.07) * scanStrength;
        shade[vertex] = 0.03 + Math.pow(lambert, 2.4) * 0.8 + rim * 0.5 + scan;
      }
      bucketFill.fill(0);
      for (let ring = 0; ring < RINGS; ring++) {
        const row = ring * SEGMENTS;
        for (let segment = 0; segment < SEGMENTS; segment++) {
          const from = row + segment;
          const to = row + ((segment + 1) % SEGMENTS);
          const level = Math.min(SHADE_LEVELS - 1, Math.max(0, Math.floor((shade[from] + shade[to]) * 0.5 * SHADE_LEVELS)));
          const bucket = buckets[level];
          const offset = bucketFill[level];
          bucket[offset] = screenX[from];
          bucket[offset + 1] = screenY[from];
          bucket[offset + 2] = screenX[to];
          bucket[offset + 3] = screenY[to];
          bucketFill[level] = offset + 4;
        }
      }
      const flicker = reducedMotion ? 1 : 0.94 + Math.random() * 0.06;
      context.lineWidth = Math.max(1, size / 380);
      for (let level = 0; level < SHADE_LEVELS; level++) {
        const count = bucketFill[level];
        if (!count) continue;
        const bucket = buckets[level];
        context.beginPath();
        for (let offset = 0; offset < count; offset += 4) {
          context.moveTo(bucket[offset], bucket[offset + 1]);
          context.lineTo(bucket[offset + 2], bucket[offset + 3]);
        }
        context.strokeStyle = color(((level + 0.6) / SHADE_LEVELS) * 0.9 * glow * flicker * (1 + energy * 0.15));
        context.stroke();
      }

      const strokePath = (points: Vec3[], alpha: number, lineWidth: number, close = false) => {
        context.beginPath();
        points.forEach((point, index) => {
          const projected = project(point[0], point[1], point[2]);
          if (index === 0) context.moveTo(projected[0], projected[1]);
          else context.lineTo(projected[0], projected[1]);
        });
        if (close) context.closePath();
        context.strokeStyle = color(alpha * glow);
        context.lineWidth = lineWidth;
        context.stroke();
      };

      // --- Neck and shoulders fade out toward the bottom. ---
      BUST.forEach((line, level) => strokePath(line, 0.36 * Math.pow(1 - level / BUST.length, 1.3), Math.max(1, size / 380)));
      for (const side of [-1, 1]) strokePath(ear(side), 0.3, Math.max(1, size / 380), true);

      // --- Features: the lines that make it read as a face. ---
      const featureWidth = Math.max(1.2, size / 230);
      context.shadowColor = color(0.9);
      context.shadowBlur = size / 28;
      for (const side of [-1, 1]) {
        const outline = eyeOutline(side, openness);
        strokePath(outline, 0.85, featureWidth, true);
        strokePath(brow(side, focus * 0.018 + (current === "listening" ? 0.014 : 0)), 0.5, featureWidth);
        if (openness > 0.3) {
          const gazeX = pointer.x * 0.02 + (current === "thinking" ? Math.sin(clock * 1.3) * 0.03 : 0);
          const gazeY = -pointer.y * 0.008 + focus * 0.012;
          const iris = project(...facePoint(side * EYE_X + gazeX, EYE_Y + 0.004 + gazeY, 0.02));
          const radius = (unit * 0.027 * CAMERA) / (CAMERA - iris[2]);
          context.beginPath();
          context.arc(iris[0], iris[1], radius * (1 + energy * 0.12), 0, Math.PI * 2);
          context.strokeStyle = color(0.95 * glow);
          context.lineWidth = featureWidth;
          context.stroke();
          context.beginPath();
          context.arc(iris[0], iris[1], radius * 0.42, 0, Math.PI * 2);
          context.fillStyle = color(0.95 * glow);
          context.fill();
        }
      }
      for (const side of [-1, 1]) strokePath(noseSide(side), 0.22, featureWidth * 0.7);
      strokePath(NOSE_BASE, 0.4, featureWidth * 0.8);
      strokePath(mouthLine("top", mouth), 0.55, featureWidth * 0.9);
      strokePath(mouthLine("upper", mouth), 0.9, featureWidth);
      if (mouth > 0.006) strokePath(mouthLine("lower", mouth), 0.9, featureWidth);
      strokePath(mouthLine("bottom", mouth), 0.45, featureWidth * 0.9);
      context.shadowBlur = 0;

      // --- HUD: a tick ring, three orbiting arcs, and a voice ring. ---
      const ringRadius = size * 0.44;
      const hudY = height * 0.5;
      context.lineWidth = Math.max(1, size / 420);
      context.beginPath();
      for (let tick = 0; tick < 96; tick++) {
        const angle = (tick / 96) * Math.PI * 2 + clock * 0.05;
        const inner = ringRadius * (tick % 8 === 0 ? 0.955 : 0.975);
        context.moveTo(centerX + Math.cos(angle) * inner, hudY + Math.sin(angle) * inner);
        context.lineTo(centerX + Math.cos(angle) * ringRadius, hudY + Math.sin(angle) * ringRadius);
      }
      context.strokeStyle = color(0.2 * glow);
      context.stroke();
      const spin = clock * (0.25 + focus * 1.4);
      [[0, 0.9], [2.2, 0.55], [4.1, 0.35]].forEach(([offset, length], index) => {
        context.beginPath();
        const start = offset + spin * (index === 1 ? -0.7 : 1);
        context.arc(centerX, hudY, ringRadius * (1.025 + index * 0.02), start, start + length);
        context.strokeStyle = color((0.55 - index * 0.12) * glow);
        context.lineWidth = Math.max(1.2, size / 260);
        context.stroke();
      });
      if (energy > 0.1) {
        context.beginPath();
        for (let bar = 0; bar < 72; bar++) {
          const angle = (bar / 72) * Math.PI * 2 - Math.PI / 2;
          const wave = Math.abs(Math.sin(bar * 0.71 + clock * 7.3) * Math.sin(bar * 0.23 - clock * 4.1));
          const reach = ringRadius * (0.9 - wave * energy * 0.075);
          context.moveTo(centerX + Math.cos(angle) * ringRadius * 0.905, hudY + Math.sin(angle) * ringRadius * 0.905);
          context.lineTo(centerX + Math.cos(angle) * reach, hudY + Math.sin(angle) * reach);
        }
        context.strokeStyle = color(Math.min(0.7, energy) * glow);
        context.lineWidth = Math.max(1.2, size / 300);
        context.stroke();
      }
      context.globalCompositeOperation = "source-over";
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  return (
    <div className={`holo-face ${state} ${className}`} role="img" aria-label={`${label ?? "Aeris"} is ${STATE_WORDS[state]}`}>
      <canvas ref={canvasRef} />
    </div>
  );
}
