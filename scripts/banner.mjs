// Generates docs/media/banner.svg — the isocline slope-field hero.
// Math: direction field m = v - u², zero-isocline v = u² traced in cyan,
// dashed point-forecast continuation + violet uncertainty fan at the tip.
import { writeFileSync, mkdirSync } from "node:fs";

const W = 1280, H = 640;
const C = {
  bg: "#0b0e14", ink: "#e6edf3", muted: "#8b98a9",
  cyan: "#22d3ee", violet: "#a78bfa", hair: "rgba(255,255,255,0.12)",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// field coordinate mapping: math (u,v) -> screen (x,y), v up
const CX = 820, CY = 430, S = 150;
const px = (u) => CX + u * S;
const py = (v) => CY - v * S;

// --- slope field segments over the right two-thirds ---
const segs = [];
for (let x = 492; x <= 1268; x += 44) {
  for (let y = 36; y <= 620; y += 44) {
    const u = (x - CX) / S, v = (CY - y) / S;
    const m = v - u * u;                 // dy/dx of the system
    const a = Math.atan(-m);             // screen angle (y down)
    const L = 16;
    const dx = Math.cos(a) * L / 2, dy = Math.sin(a) * L / 2;
    const alpha = (0.13 + 0.20 * Math.exp(-Math.abs(m))).toFixed(3);
    segs.push(`<line x1="${(x - dx).toFixed(1)}" y1="${(y - dy).toFixed(1)}" x2="${(x + dx).toFixed(1)}" y2="${(y + dy).toFixed(1)}" stroke="${C.muted}" stroke-opacity="${alpha}" stroke-width="1.5" stroke-linecap="round"/>`);
  }
}

// --- isocline v = u², drawn from u=-1.72 to the fan origin u=0.92 ---
const iso = [];
for (let u = -1.72; u <= 0.92; u += 0.02) iso.push(`${px(u).toFixed(1)},${py(u * u).toFixed(1)}`);
const isoPath = `M ${iso.join(" L ")}`;
// faint companions v = u² ± 1
const comp = (c) => {
  const pts = [];
  for (let u = -1.72; u <= 1.72; u += 0.03) {
    const v = u * u + c;
    if (v > 2.9) continue;
    pts.push(`${px(u).toFixed(1)},${py(v).toFixed(1)}`);
  }
  return `M ${pts.join(" L ")}`;
};

// --- forecast: dashed continuation + violet fan from the tip ---
const uT = 0.92, vT = uT * uT;                 // tip of solid isocline
const tip = [px(uT), py(vT)];
const tangent = Math.atan(-(2 * uT));           // screen angle at tip
const fanLen = 235;
// five paths spreading from tangent toward shallower angles
const fanPaths = [];
for (let i = 0; i <= 4; i++) {
  const t = i / 4;                              // 0..1 across the fan
  const ang = tangent - t * 0.62 + 0.10;        // radians, bending right
  const len = fanLen * (0.82 + 0.24 * Math.sin(Math.PI * t));
  const ex = tip[0] + Math.cos(ang) * len;
  const ey = tip[1] + Math.sin(ang) * len;
  const cx1 = tip[0] + Math.cos(ang - 0.22) * len * 0.55;
  const cy1 = tip[1] + Math.sin(ang - 0.22) * len * 0.55;
  fanPaths.push({ d: `M ${tip[0].toFixed(1)} ${tip[1].toFixed(1)} Q ${cx1.toFixed(1)} ${cy1.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`, end: [ex, ey], t });
}
// dashed median continuation (the point forecast)
const medAng = tangent - 0.21;
const medEnd = [tip[0] + Math.cos(medAng) * fanLen * 1.02, tip[1] + Math.sin(medAng) * fanLen * 1.02];
// wedge fill between outermost fan paths
const wedge = `M ${tip[0].toFixed(1)} ${tip[1].toFixed(1)} Q ${fanPaths[0].end[0] - 40} ${fanPaths[0].end[1] + 10} ${fanPaths[0].end[0].toFixed(1)} ${fanPaths[0].end[1].toFixed(1)} L ${fanPaths[4].end[0].toFixed(1)} ${fanPaths[4].end[1].toFixed(1)} Q ${tip[0] + 150} ${tip[1] - 10} ${tip[0].toFixed(1)} ${tip[1].toFixed(1)} Z`;

// --- wordmark block ---
const chip = (x, label) => {
  const w = 22 + label.length * 10.6;
  return `<g><rect x="${x}" y="540" width="${w}" height="40" rx="9" fill="rgba(255,255,255,0.03)" stroke="${C.hair}"/><text x="${x + w / 2}" y="565" font-family="${MONO}" font-size="17" fill="${C.muted}" text-anchor="middle">${label}</text></g>`;
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="0.66" cy="0.42" r="0.62">
      <stop offset="0" stop-color="${C.cyan}" stop-opacity="0.055"/>
      <stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- slope field: m = v - u² -->
  ${segs.join("\n  ")}

  <!-- companion isoclines v = u² ± 1 -->
  <path d="${comp(-1)}" fill="none" stroke="${C.cyan}" stroke-opacity="0.10" stroke-width="1.2"/>
  <path d="${comp(1)}" fill="none" stroke="${C.cyan}" stroke-opacity="0.10" stroke-width="1.2"/>

  <!-- the zero isocline -->
  <path d="${isoPath}" fill="none" stroke="${C.cyan}" stroke-width="2.6" stroke-linecap="round"/>

  <!-- forecast fan at the tip -->
  <path d="${wedge}" fill="${C.violet}" fill-opacity="0.10"/>
  ${fanPaths.filter((p) => p.t > 0 && p.t < 1).map((p) => `<path d="${p.d}" fill="none" stroke="${C.violet}" stroke-opacity="0.38" stroke-width="1.4"/>`).join("\n  ")}
  <path d="M ${tip[0].toFixed(1)} ${tip[1].toFixed(1)} L ${medEnd[0].toFixed(1)} ${medEnd[1].toFixed(1)}" stroke="${C.cyan}" stroke-width="1.8" stroke-dasharray="7 6" opacity="0.85"/>
  <circle cx="${tip[0].toFixed(1)}" cy="${tip[1].toFixed(1)}" r="4.5" fill="${C.cyan}"/>

  <!-- wordmark -->
  <text x="60" y="292" font-family="${MONO}" font-size="106" font-weight="600" letter-spacing="-2" fill="${C.ink}">isocline<tspan fill="${C.cyan}">.</tspan></text>
  <text x="64" y="346" font-family="${MONO}" font-size="25" fill="${C.muted}">tiny, fast time-series intelligence</text>
  <text x="64" y="384" font-family="${MONO}" font-size="17" fill="${C.cyan}" opacity="0.9">rust &#8594; wasm &#8594; web</text>

  <!-- real stats -->
  ${chip(64, "88 KB gzipped")}
  ${chip(64 + 200, "10k pts &#183; 95 ms")}
  ${chip(64 + 424, "110 tests green")}
</svg>
`;

mkdirSync("docs/media", { recursive: true });
writeFileSync("docs/media/banner.svg", svg);
console.log(`docs/media/banner.svg written (${segs.length} field segments)`);
