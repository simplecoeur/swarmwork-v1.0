import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../context';
import type { AppState, Member, Team } from '../types';

/* ============================================================
   像素办公室（UI 恢复 v0.4.0）：视觉实现移植自用户认可的原型
   space.html（模拟测试版）——世界网格/分区/像素小人/气泡/审核桌/
   交付台/任务墙/小地图的画法与配色与原型一致；数据全部来自
   真实 /api/state（队伍、成员、任务、审核标准），不带模拟逻辑。
   与原型的差异：小人静止于工位（无寻路走动模拟）、无拖拽换组
   （工程版无对应 API）、气泡无进度条（真实任务无百分比数据）。
   ============================================================ */

const CELL = 30;
const COLS = 32;
const GROUP_Y0 = 15;
const TILE_W = 10;
const TILE_H = 8;
const TCOLS = 3;
const VIEW_W = 960;
const VIEW_H = 540;

const SKINS = ['#f2c79b', '#eec39a', '#f6cfae', '#e9bd8d', '#d9a06b'];
const ROLE_SHIRT: Record<string, string> = {
  组长: '#e8862e',
  研究员: '#1f8a70',
  文案: '#d93a2b',
  程序员: '#3a6fd8',
  审核: '#5a5f6a',
};
const ROLE_HAIR: Record<string, string> = {
  组长: '#3a2a1a',
  研究员: '#20303a',
  文案: '#5a2320',
  程序员: '#14181f',
  审核: '#101010',
};
const FALLBACK_SHIRTS = ['#8a5aa8', '#d98a16', '#3f9e4d', '#e8503f', '#274156'];
const TYPE_COLOR: Record<string, string> = { 文案: '#ff8fa0', 调研: '#8fd8b2', 代码: '#93b8f5' };
const REVIEW_SEATS: Array<[number, number]> = [
  [25, 3], [24, 3], [26, 3], [23, 3], [27, 3], [28, 3], [22, 3], [29, 3],
];

type StatusText = '执行中' | '审核中' | '待命';

interface AgentView {
  member: Member;
  x: number; // 所在格子（浮点，左上角）
  y: number;
  deskX: number; // 工位桌格子，-1 表示无桌（审核员/溢出）
  deskY: number;
  shirt: string;
  skin: string;
  hair: string;
  status: StatusText;
  bubble: string;
}

interface Zone { x: number; y: number; w: number; h: number }

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function statusOf(S: AppState, m: Member): StatusText {
  if (S.tasks.some((t) => t.assigneeId === m.id && t.status === '执行中')) return '执行中';
  if (m.role === '审核' && S.tasks.some((t) => t.teamId === m.teamId && t.status === '待审核')) return '审核中';
  return '待命';
}

function bubbleOf(m: Member, st: StatusText): string {
  if (st === '执行中') return '💻 执行中';
  if (st === '审核中') return '📋 审核中';
  return m.role === '审核' ? '📋 待命审核' : '💤 待命';
}

function computeZones(teams: Team[]): Map<string, Zone> {
  const map = new Map<string, Zone>();
  teams.forEach((t, i) => {
    const cx = i % TCOLS;
    const cy = Math.floor(i / TCOLS);
    map.set(t.id, { x: 1 + cx * TILE_W, y: GROUP_Y0 + cy * TILE_H, w: TILE_W - 1, h: TILE_H - 1 });
  });
  return map;
}

function worldRows(teamCount: number): number {
  const zrows = Math.max(1, Math.ceil(teamCount / TCOLS));
  return GROUP_Y0 + zrows * TILE_H + 1;
}

function buildAgents(S: AppState, zones: Map<string, Zone>): AgentView[] {
  const out: AgentView[] = [];
  const mk = (m: Member, x: number, y: number, deskX: number, deskY: number): AgentView => {
    const st = statusOf(S, m);
    const h = hashStr(m.id);
    return {
      member: m,
      x, y, deskX, deskY,
      shirt: ROLE_SHIRT[m.role] ?? FALLBACK_SHIRTS[h % FALLBACK_SHIRTS.length],
      skin: SKINS[h % SKINS.length],
      hair: ROLE_HAIR[m.role] ?? '#3a2a1a',
      status: st,
      bubble: bubbleOf(m, st),
    };
  };
  // 普通成员：本组分区内摆工位（与原型 assignHomes 同规则）
  for (const team of S.teams) {
    const z = zones.get(team.id);
    if (!z) continue;
    const members = S.members.filter((m) => m.teamId === team.id && m.role !== '审核');
    const perRow = Math.max(1, Math.floor((z.w - 4) / 4) + 1);
    members.forEach((m, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const deskX = z.x + 1 + c * 4;
      const deskY = z.y + 1 + r * 3;
      if (deskY + 1 <= z.y + z.h - 1) {
        out.push(mk(m, deskX + 1, deskY + 1, deskX, deskY));
      } else {
        out.push(mk(m, z.x + 1 + ((i * 2) % Math.max(2, z.w - 2)), z.y + z.h - 1, -1, -1));
      }
    });
  }
  // 审核员：统一坐审核桌（与原型一致，跨组共用）
  S.members
    .filter((m) => m.role === '审核')
    .forEach((m, i) => {
      const seat = REVIEW_SEATS[i % REVIEW_SEATS.length];
      out.push(mk(m, seat[0], seat[1], -1, -1));
    });
  return out;
}

/* ---------- 绘制（原型 draw* 函数移植，ctx 显式传参） ---------- */

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawZone(ctx: CanvasRenderingContext2D, team: Team, z: Zone) {
  ctx.globalAlpha = 0.16;
  px(ctx, z.x * CELL, z.y * CELL, z.w * CELL, z.h * CELL, team.color);
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = team.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(z.x * CELL + 2, z.y * CELL + 2, z.w * CELL - 4, z.h * CELL - 4);
  ctx.globalAlpha = 1;
  ctx.font = '900 11px sans-serif, "Noto Color Emoji"';
  const tw = ctx.measureText(team.name).width + 12;
  const lx = z.x * CELL + 5;
  const ly = z.y * CELL + 5;
  px(ctx, lx, ly, tw, 16, team.color);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(team.name, lx + tw / 2, ly + 8.5);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawBossOffice(ctx: CanvasRenderingContext2D) {
  for (let y = 0; y <= 3; y++) px(ctx, 6 * CELL, y * CELL, CELL, CELL, '#b09a76');
  for (let x = 0; x <= 6; x++) {
    if (x !== 2) px(ctx, x * CELL, 4 * CELL, CELL, CELL, '#b09a76');
  }
  px(ctx, 1 * CELL + 3, 1 * CELL + 8, 2 * CELL - 6, 16, '#7a4a21');
  px(ctx, 1 * CELL + 8, 1 * CELL + 2, 16, 10, '#2b2b33');
  px(ctx, 1 * CELL + 10, 1 * CELL + 4, 12, 6, '#7fd4ff');
  px(ctx, 1 * CELL + 13, 2 * CELL + 2, 18, 12, '#d93a2b');
  px(ctx, 3.15 * CELL, 0.25 * CELL, 22, 20, '#8a8f7a');
  px(ctx, 3.15 * CELL, 0.6 * CELL, 22, 3, '#6d7260');
  ctx.fillStyle = '#5a4632';
  ctx.font = '900 11px sans-serif, "Noto Color Emoji"';
  ctx.textAlign = 'center';
  ctx.fillText('老 板 办 公 室', 3.5 * CELL, 3.6 * CELL);
  ctx.textAlign = 'left';
}

function drawTaskWall(ctx: CanvasRenderingContext2D, S: AppState) {
  px(ctx, 8 * CELL - 4, 2, 10 * CELL + 8, 2 * CELL - 4, '#8a5a2b');
  px(ctx, 8 * CELL, 6, 10 * CELL, 2 * CELL - 12, '#d9b078');
  ctx.fillStyle = '#7a4a21';
  ctx.font = '900 12px sans-serif, "Noto Color Emoji"';
  ctx.textAlign = 'center';
  ctx.fillText('任 务 墙', 13 * CELL, 20);
  const active = S.tasks.filter((t) => t.status !== '已完成');
  for (let i = 0; i < Math.min(active.length, 12); i++) {
    const nx = 8 * CELL + 14 + (i % 6) * 46;
    const ny = 28 + Math.floor(i / 6) * 22;
    px(ctx, nx, ny, 34, 18, TYPE_COLOR[active[i].type] || '#ffe08a');
    px(ctx, nx + 13, ny - 3, 8, 5, '#d93a2b');
    ctx.fillStyle = 'rgba(60,40,10,.8)';
    ctx.font = '700 8px sans-serif, "Noto Color Emoji"';
    ctx.fillText(active[i].type, nx + 17, ny + 12);
  }
  ctx.textAlign = 'left';
}

function drawDeskAt(ctx: CanvasRenderingContext2D, cellX: number, cellY: number, accent: string) {
  const dx = cellX * CELL;
  const dy = cellY * CELL;
  px(ctx, dx + 2, dy + 6, 3 * CELL - 4, 18, '#a5713d');
  px(ctx, dx + 2, dy + 6, 3 * CELL - 4, 4, '#c08b52');
  px(ctx, dx + CELL + 4, dy + 1, 22, 15, '#2b2b33');
  px(ctx, dx + CELL + 6, dy + 3, 18, 11, accent);
  px(ctx, dx + CELL + 12, dy + 16, 6, 4, '#2b2b33');
  px(ctx, dx + 8, dy + 11, 13, 9, '#fffdf4');
  px(ctx, dx + 10, dy + 14, 9, 2, '#c9bfa5');
  px(ctx, dx + 2 * CELL + 8, dy + 12, 7, 8, '#e8503f');
  px(ctx, dx + 2 * CELL + 9, dy + 10, 5, 3, '#fff');
  px(ctx, dx + CELL + 5, dy + CELL + 6, 20, 14, accent);
  px(ctx, dx + CELL + 5, dy + CELL + 6, 20, 4, 'rgba(0,0,0,.18)');
}

function drawReviewDesk(ctx: CanvasRenderingContext2D, stdCount: number) {
  const dx = 23 * CELL;
  const dy = 4 * CELL;
  px(ctx, dx + 2, dy + 4, 6 * CELL - 4, CELL - 8, '#8a5a2b');
  px(ctx, dx + 2, dy + 4, 6 * CELL - 4, 5, '#a5713d');
  px(ctx, dx + 16, dy + 10, 20, 14, '#fffdf4');
  px(ctx, dx + 19, dy + 14, 14, 2, '#c9bfa5');
  px(ctx, dx + 19, dy + 18, 11, 2, '#c9bfa5');
  px(ctx, dx + 120, dy + 12, 16, 12, '#fdf6e3');
  px(ctx, dx + 123, dy + 16, 10, 2, '#d93a2b');
  px(ctx, dx + 70, dy + 9, 8, 9, '#3a6fd8');
  for (const s of REVIEW_SEATS) {
    px(ctx, s[0] * CELL + 5, (s[1] + 1) * CELL - 4, 20, 9, '#5a5f6a');
    px(ctx, s[0] * CELL + 5, (s[1] + 1) * CELL - 4, 20, 3, 'rgba(255,255,255,.25)');
  }
  ctx.fillStyle = '#5a4632';
  ctx.font = '900 11px sans-serif, "Noto Color Emoji"';
  ctx.textAlign = 'center';
  ctx.fillText('审 核 桌', 26 * CELL, 5.8 * CELL);
  const label = '审核标准 ' + stdCount + ' 条';
  ctx.font = '900 11px sans-serif, "Noto Color Emoji"';
  const tw = ctx.measureText(label).width + 14;
  const bx = 26 * CELL - tw / 2;
  const by = 2 * CELL + 4;
  px(ctx, bx + tw / 2 - 2, by + 15, 4, 8, '#8a5a2b');
  px(ctx, bx, by, tw, 16, '#d98a16');
  ctx.strokeStyle = '#2c2519';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx, by, tw, 16);
  ctx.fillStyle = '#241a05';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 26 * CELL, by + 8.5);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

function drawDeliveryCounter(ctx: CanvasRenderingContext2D, deliveredCount: number) {
  const dx = 7 * CELL;
  const dy = 12 * CELL;
  px(ctx, dx, dy + 6, 12 * CELL, 2 * CELL - 6, '#8a5a2b');
  px(ctx, dx, dy + 6, 12 * CELL, 6, '#c08b52');
  px(ctx, dx, dy + 2 * CELL - 8, 12 * CELL, 4, 'rgba(0,0,0,.18)');
  ctx.fillStyle = '#fff3d6';
  ctx.font = '900 13px sans-serif, "Noto Color Emoji"';
  ctx.textAlign = 'center';
  ctx.fillText('交 付 台', 13 * CELL, 13.35 * CELL);
  const n = Math.min(deliveredCount, 10);
  for (let i = 0; i < n; i++) {
    const bx = dx + 14 + (i % 5) * 56;
    const by = dy - 12 - Math.floor(i / 5) * 4;
    px(ctx, bx, by, 24, 16, '#d9a45c');
    px(ctx, bx, by, 24, 4, '#bd8a42');
    px(ctx, bx + 10, by, 4, 16, '#a5713d');
    ctx.fillStyle = '#1f8a70';
    ctx.font = '900 11px sans-serif, "Noto Color Emoji"';
    ctx.fillText('✓', bx + 12, by + 13);
  }
  ctx.textAlign = 'left';
}

function drawPlant(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  const dx = cx * CELL;
  const dy = cy * CELL;
  px(ctx, dx + 9, dy + 16, 12, 10, '#b0562f');
  px(ctx, dx + 6, dy + 4, 18, 13, '#3f9e4d');
  px(ctx, dx + 11, dy + 0, 8, 8, '#54b765');
  px(ctx, dx + 3, dy + 9, 8, 8, '#35853f');
}

function drawDoor(ctx: CanvasRenderingContext2D) {
  px(ctx, 18.5 * CELL, 14 * CELL + 22, 2 * CELL, 8, '#8a5a2b');
  ctx.fillStyle = '#5a4632';
  ctx.font = '900 10px sans-serif, "Noto Color Emoji"';
  ctx.textAlign = 'center';
  ctx.fillText('大 门', 19.5 * CELL, 14 * CELL + 14);
  ctx.textAlign = 'left';
}

function drawAgent(ctx: CanvasRenderingContext2D, a: AgentView, now: number) {
  const cx = (a.x + 0.5) * CELL;
  const topY = a.y * CELL + 6;
  const bob = Math.sin(now / 600 + a.x * 1.7 + a.y) * 0.6;
  const y0 = topY - bob;
  ctx.fillStyle = 'rgba(60,40,10,.22)';
  ctx.beginPath();
  ctx.ellipse(cx, a.y * CELL + 27, 10, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();
  px(ctx, cx - 7, y0 + 24, 6, 7, '#4a4238');
  px(ctx, cx + 1, y0 + 24, 6, 7, '#4a4238');
  px(ctx, cx - 7, y0 + 30, 6, 2.5, '#2b2519');
  px(ctx, cx + 1, y0 + 30, 6, 2.5, '#2b2519');
  px(ctx, cx - 9, y0 + 13, 18, 12, a.shirt);
  px(ctx, cx - 9, y0 + 13, 18, 3, 'rgba(255,255,255,.22)');
  if (a.status === '执行中') {
    const tap = Math.sin(now / 90) * 1.5;
    px(ctx, cx - 12, y0 + 16 + tap, 4, 8, a.shirt);
    px(ctx, cx + 8, y0 + 16 - tap, 4, 8, a.shirt);
  } else {
    px(ctx, cx - 12, y0 + 14, 4, 9, a.shirt);
    px(ctx, cx + 8, y0 + 14, 4, 9, a.shirt);
  }
  px(ctx, cx - 7, y0 + 1, 14, 12, a.skin);
  px(ctx, cx - 7, y0 + 1, 14, 5, a.hair);
  px(ctx, cx - 7, y0 + 1, 3, 8, a.hair);
  px(ctx, cx + 4, y0 + 1, 3, 8, a.hair);
  px(ctx, cx - 4, y0 + 8, 2.4, 2.4, '#26221c');
  px(ctx, cx + 2, y0 + 8, 2.4, 2.4, '#26221c');
  if (a.member.role === '审核') {
    ctx.strokeStyle = '#26221c';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(cx - 6, y0 + 6.5, 6, 5);
    ctx.strokeRect(cx + 1, y0 + 6.5, 6, 5);
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, a: AgentView, camX: number, viewWpx: number) {
  const cx = (a.x + 0.5) * CELL;
  ctx.font = '800 10px sans-serif, "Noto Color Emoji"';
  const label = a.member.name + '·' + a.member.role;
  const nw = ctx.measureText(label).width + 10;
  const ny = a.y * CELL - 16;
  px(ctx, cx - nw / 2, ny, nw, 14, 'rgba(44,37,25,.88)');
  ctx.fillStyle = '#fff7e0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, ny + 7.5);
  ctx.font = '700 10.5px sans-serif, "Noto Color Emoji"';
  const bw = ctx.measureText(a.bubble).width + 12;
  const by = ny - 20;
  const bx = Math.max(camX + 2, Math.min(camX + viewWpx - bw - 2, cx - bw / 2));
  px(ctx, bx, by, bw, 15, '#fffdf4');
  ctx.strokeStyle = '#2c2519';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(bx, by, bw, 15);
  px(ctx, cx - 2, by + 15, 4, 4, '#fffdf4');
  ctx.fillStyle = '#2c2519';
  ctx.fillText(a.bubble, bx + bw / 2, by + 8);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

/* ---------- 组件 ---------- */

export default function PixelOffice({ onEdit }: { onEdit: (memberId: string) => void }) {
  const { S, apiName } = useApp();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mmRef = useRef<HTMLCanvasElement | null>(null);
  const camRef = useRef({ x: 0, y: 0, zoom: 0.75 });
  const dragRef = useRef<{ sx: number; sy: number; camX: number; camY: number; moved: boolean } | null>(null);
  const stateRef = useRef<AppState | null>(null);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  stateRef.current = S;

  const zones = useMemo(() => (S ? computeZones(S.teams) : new Map<string, Zone>()), [S]);
  const agents = useMemo(() => (S ? buildAgents(S, zones) : []), [S, zones]);
  const agentsRef = useRef<AgentView[]>([]);
  agentsRef.current = agents;
  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  // 初始镜头：全景
  useEffect(() => {
    const st = stateRef.current;
    const rows = worldRows(st ? st.teams.length : 1);
    const zoom = Math.min(1, VIEW_W / (COLS * CELL), VIEW_H / (rows * CELL));
    camRef.current = { x: 0, y: 0, zoom };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const mm = mmRef.current;
    if (!canvas || !mm) return;
    const ctx = canvas.getContext('2d');
    const mmCtx = mm.getContext('2d');
    if (!ctx || !mmCtx) return;
    let raf = 0;

    const fitView = () => {
      const st = stateRef.current;
      const rows = worldRows(st ? st.teams.length : 1);
      const zoom = Math.min(1, VIEW_W / (COLS * CELL), VIEW_H / (rows * CELL));
      camRef.current = { x: 0, y: 0, zoom };
    };
    fitRef.current = fitView;

    const clampCam = () => {
      const st = stateRef.current;
      const rows = worldRows(st ? st.teams.length : 1);
      const cam = camRef.current;
      const vw = VIEW_W / cam.zoom;
      const vh = VIEW_H / cam.zoom;
      const ww = COLS * CELL;
      const wh = rows * CELL;
      const loX = Math.min(0, ww - vw);
      const hiX = Math.max(0, ww - vw);
      const loY = Math.min(0, wh - vh);
      const hiY = Math.max(0, wh - vh);
      cam.x = Math.max(loX, Math.min(hiX, cam.x));
      cam.y = Math.max(loY, Math.min(hiY, cam.y));
    };

    const drawMinimap = () => {
      const st = stateRef.current;
      if (!st) return;
      const rows = worldRows(st.teams.length);
      const W = mm.width;
      const H = Math.max(60, Math.round((W * rows) / COLS));
      if (mm.height !== H) mm.height = H;
      const sx = W / (COLS * CELL);
      const sy = H / (rows * CELL);
      mmCtx.fillStyle = '#ead9b8';
      mmCtx.fillRect(0, 0, W, H);
      mmCtx.fillStyle = '#9a8f7a';
      mmCtx.fillRect(0, 0, 7 * CELL * sx, 5 * CELL * sy);
      mmCtx.fillRect(8 * CELL * sx, 0, 10 * CELL * sx, 2 * CELL * sy);
      mmCtx.fillRect(21 * CELL * sx, 2 * CELL * sy, 10 * CELL * sx, 6 * CELL * sy);
      mmCtx.fillRect(7 * CELL * sx, 10 * CELL * sy, 12 * CELL * sx, 4 * CELL * sy);
      mmCtx.font = '700 8px sans-serif, "Noto Color Emoji"';
      mmCtx.textAlign = 'left';
      mmCtx.textBaseline = 'alphabetic';
      for (const t of st.teams) {
        const z = zonesRef.current.get(t.id);
        if (!z) continue;
        mmCtx.fillStyle = t.color;
        mmCtx.fillRect(z.x * CELL * sx, z.y * CELL * sy, z.w * CELL * sx, z.h * CELL * sy);
        mmCtx.fillStyle = 'rgba(255,255,255,.92)';
        let label = t.name;
        const maxW = z.w * CELL * sx - 3;
        while (label.length > 1 && mmCtx.measureText(label).width > maxW) label = label.slice(0, -1);
        mmCtx.fillText(label, z.x * CELL * sx + 2, z.y * CELL * sy + 10);
      }
      const cam = camRef.current;
      const fx = Math.max(0, cam.x * sx);
      const fy = Math.max(0, cam.y * sy);
      const fw = Math.min(W - fx, (VIEW_W / cam.zoom) * sx);
      const fh = Math.min(H - fy, (VIEW_H / cam.zoom) * sy);
      mmCtx.strokeStyle = '#fff';
      mmCtx.lineWidth = 2;
      mmCtx.strokeRect(fx, fy, fw, fh);
      mmCtx.strokeStyle = '#2c2519';
      mmCtx.lineWidth = 1;
      mmCtx.strokeRect(fx, fy, fw, fh);
    };

    const draw = (now: number) => {
      const st = stateRef.current;
      const cam = camRef.current;
      clampCam();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#8a6a42';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      if (st) {
        const rows = worldRows(st.teams.length);
        ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < COLS; x++) {
            px(ctx, x * CELL, y * CELL, CELL, CELL, (x + y) % 2 === 0 ? '#ead9b8' : '#e3cfa6');
          }
        }
        ctx.strokeStyle = '#8a5a2b';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, COLS * CELL - 4, rows * CELL - 4);
        for (const t of st.teams) {
          const z = zonesRef.current.get(t.id);
          if (z) drawZone(ctx, t, z);
        }
        ctx.fillStyle = 'rgba(138,90,168,.14)';
        ctx.fillRect(21 * CELL, 2 * CELL, 10 * CELL, 6 * CELL);
        ctx.fillStyle = 'rgba(31,138,112,.15)';
        ctx.fillRect(7 * CELL, 10 * CELL, 12 * CELL, 4 * CELL);
        ctx.fillStyle = 'rgba(217,58,43,.10)';
        ctx.fillRect(0, 0, 7 * CELL, 5 * CELL);
        ctx.font = '700 11px sans-serif, "Noto Color Emoji"';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(90,70,40,.75)';
        ctx.fillText('交 付 区', 7.3 * CELL, 10.7 * CELL);

        drawBossOffice(ctx);
        drawTaskWall(ctx, st);
        const list = agentsRef.current;
        for (const a of list) {
          if (a.deskX >= 0) drawDeskAt(ctx, a.deskX, a.deskY, a.shirt);
        }
        const stdCount = (st.reviewStandards.points + '\n' + st.reviewStandards.clientNeeds)
          .split('\n')
          .filter((s) => s.trim()).length;
        drawReviewDesk(ctx, stdCount);
        drawDeliveryCounter(ctx, st.tasks.filter((t) => t.status === '已完成').length);
        drawPlant(ctx, 1, 13);
        drawPlant(ctx, 30, 13);
        drawPlant(ctx, 19, 1);
        drawDoor(ctx);
        const sorted = list.slice().sort((a, b) => a.y - b.y);
        for (const a of sorted) drawAgent(ctx, a, now);
        for (const a of sorted) drawBubble(ctx, a, cam.x, VIEW_W / cam.zoom);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        drawMinimap();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const fitRef = useRef<() => void>(() => {});

  const zoomBy = (factor: number) => {
    const cam = camRef.current;
    const nz = Math.max(0.3, Math.min(2.2, cam.zoom * factor));
    // 以视图中心为锚点缩放
    const cxw = cam.x + VIEW_W / cam.zoom / 2;
    const cyw = cam.y + VIEW_H / cam.zoom / 2;
    cam.zoom = nz;
    cam.x = cxw - VIEW_W / nz / 2;
    cam.y = cyw - VIEW_H / nz / 2;
  };

  const toWorld = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { wx: 0, wy: 0 };
    const r = canvas.getBoundingClientRect();
    const pxv = ((e.clientX - r.left) / r.width) * VIEW_W;
    const pyv = ((e.clientY - r.top) / r.height) * VIEW_H;
    const cam = camRef.current;
    return { wx: pxv / cam.zoom + cam.x, wy: pyv / cam.zoom + cam.y };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, camX: camRef.current.x, camY: camRef.current.y, moved: false };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const d = dragRef.current;
    if (d) {
      const r = canvas.getBoundingClientRect();
      const dxw = ((e.clientX - d.sx) / r.width) * VIEW_W;
      const dyw = ((e.clientY - d.sy) / r.height) * VIEW_H;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 5) d.moved = true;
      if (d.moved) {
        camRef.current.x = d.camX - dxw / camRef.current.zoom;
        camRef.current.y = d.camY - dyw / camRef.current.zoom;
        canvas.style.cursor = 'grabbing';
      }
      return;
    }
    const { wx, wy } = toWorld(e);
    const hit = agentsRef.current.some(
      (a) => Math.abs(wx - (a.x + 0.5) * CELL) < CELL * 0.85 && wy > a.y * CELL - 40 && wy < (a.y + 1.1) * CELL,
    );
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'grab';
    if (!d || d.moved) return;
    const { wx, wy } = toWorld(e);
    const hit = agentsRef.current.find(
      (a) => Math.abs(wx - (a.x + 0.5) * CELL) < CELL * 0.85 && wy > a.y * CELL - 40 && wy < (a.y + 1.1) * CELL,
    );
    if (hit) onEditRef.current(hit.member.id);
  };

  const onWheel = (e: React.WheelEvent) => {
    zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
  };

  const onMinimapClick = (e: React.MouseEvent) => {
    const mm = mmRef.current;
    const st = stateRef.current;
    if (!mm || !st) return;
    const rows = worldRows(st.teams.length);
    const r = mm.getBoundingClientRect();
    const wx = ((e.clientX - r.left) / r.width) * COLS * CELL;
    const wy = ((e.clientY - r.top) / r.height) * rows * CELL;
    camRef.current.x = wx - VIEW_W / camRef.current.zoom / 2;
    camRef.current.y = wy - VIEW_H / camRef.current.zoom / 2;
  };

  if (!S) return null;

  return (
    <>
      <div className="canvas-box">
        <canvas
          ref={canvasRef}
          className="stage-canvas"
          width={VIEW_W}
          height={VIEW_H}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          onWheel={onWheel}
        />
        <canvas ref={mmRef} className="minimap-canvas" width={192} height={120} title="小地图：点任意位置跳过去" onClick={onMinimapClick} />
        <div className="zoomctl">
          <button type="button" className="mini-btn" onClick={() => zoomBy(1.2)}>＋</button>
          <button type="button" className="mini-btn" onClick={() => zoomBy(0.8)}>－</button>
          <button type="button" className="mini-btn" onClick={() => fitRef.current()}>全景</button>
        </div>
      </div>
      <div className="legend-row">
        <span>💤 待命</span>
        <span>💻 执行中</span>
        <span>📋 审核中 / 待命审核</span>
        <span>🖱️ 拖动画布平移 · 滚轮缩放 · 点小人编辑</span>
        {S.teams.map((t) => (
          <span key={t.id}>
            <span style={{ color: t.color }}>■</span> {t.name} · API：{t.apiId ? apiName(t.apiId) : '跟随默认（' + apiName(S.defaultApiId) + '）'}
          </span>
        ))}
      </div>
    </>
  );
}
