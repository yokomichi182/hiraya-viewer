// 平屋の3Dウォークスルー描画。シーン（scene.py が house.json から作る、メートル単位）を Three.js で組み立てる。
// 動画書き出しでは Python が各フレームの状態（カメラ・工程の進み・夜の度合い）を renderAt に渡す。
// ?interactive を付けると scene.json を読み込み、マウス／タッチで見回せる共有用ビューアになる。
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const VIDEO_W = 1080, VIDEO_H = 1920;
const T_EXT = 0.16, T_INT = 0.1;

let renderer, scene, camera, S;
let skyMesh, skyUniforms, hemi, sun, ambient;
const G = {};                 // 表示切り替えするグループ
const glassMats = [];
const roomLights = [];
const furnitureObjs = [];

// ---- 小物 ---------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, k);
  return '#' + c.getHexString();
}

const TEXTURES = {
  wood: () => canvasTexture((ctx, s) => {
    const r = rng(11), rows = 8;
    for (let i = 0; i < rows; i++) {
      ctx.fillStyle = shade('#c49a6c', (r() - 0.5) * 0.06);
      ctx.fillRect(0, i * s / rows, s, s / rows);
      ctx.fillStyle = 'rgba(70,45,20,0.35)';
      ctx.fillRect(0, i * s / rows, s, 1.5);
      const cut = r() * s;
      ctx.fillRect(cut, i * s / rows, 1.5, s / rows);
      ctx.fillStyle = 'rgba(90,60,30,0.08)';
      for (let k = 0; k < 6; k++) ctx.fillRect(0, i * s / rows + r() * s / rows, s, 1);
    }
  }),
  mortar: () => canvasTexture((ctx, s) => {
    const r = rng(5);
    ctx.fillStyle = '#a7a39b'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2500; i++) { ctx.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '40,40,40'},0.06)`; ctx.fillRect(r() * s, r() * s, 2, 2); }
  }),
  tile: () => canvasTexture((ctx, s) => {
    ctx.fillStyle = '#e4e9ea'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(120,130,135,0.5)'; ctx.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * s / 4, 0); ctx.lineTo(i * s / 4, s); ctx.moveTo(0, i * s / 4); ctx.lineTo(s, i * s / 4); ctx.stroke(); }
  }),
  deck: () => canvasTexture((ctx, s) => {
    const r = rng(3), rows = 6;
    ctx.fillStyle = '#3a2a1c'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < rows; i++) { ctx.fillStyle = shade('#9b6b45', (r() - 0.5) * 0.08); ctx.fillRect(0, i * s / rows + 3, s, s / rows - 6); }
  }),
  grass: () => canvasTexture((ctx, s) => {
    const r = rng(9);
    ctx.fillStyle = '#86b46a'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 4000; i++) { ctx.fillStyle = `rgba(${r() > 0.5 ? '60,100,40' : '170,210,120'},0.18)`; ctx.fillRect(r() * s, r() * s, 2, 3); }
  }),
};
const texCache = {};
function tex(name, rx, ry) {
  texCache[name] = texCache[name] || TEXTURES[name]();
  const t = texCache[name].clone();
  t.needsUpdate = true;
  t.repeat.set(rx, ry);
  return t;
}

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// 平面上のループ（[x, z] の配列）を y∈[0, depth] に押し出す
function extrudeXZ(loops, depth) {
  const shape = new THREE.Shape(loops[0].map(([x, z]) => new THREE.Vector2(x, z)));
  for (const hole of loops.slice(1)) shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, z))));
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, depth, 0);
  return geo;
}

// ---- 家具 -----------------------------------------------------------------

function furniture(f) {
  const g = new THREE.Group();
  const c = f.color, w = f.w, d = f.d, h = f.h;
  const main = std(c), light = std(shade(c, 0.12)), dark = std(shade(c, -0.15));
  const white = std('#f3f1ec'), metal = std('#9aa0a6', { metalness: 0.4, roughness: 0.4 });
  const wide = w >= d;
  switch (f.type) {
    case 'bed':
      g.add(box(w, 0.28, d, dark, 0, 0.14, 0));
      g.add(box(w - 0.06, 0.2, d - 0.06, white, 0, 0.38, 0));
      g.add(box(wide ? 0.4 : w - 0.3, 0.1, wide ? d - 0.3 : 0.4, std('#ffffff'), wide ? -w / 2 + 0.3 : 0, 0.52, wide ? 0 : -d / 2 + 0.3));
      g.add(box(wide ? w * 0.55 : w - 0.08, 0.05, wide ? d - 0.08 : d * 0.55, std('#8fa3b5'), wide ? w * 0.2 : 0, 0.5, wide ? 0 : d * 0.2));
      break;
    case 'sofa': {
      g.add(box(w, 0.42, d, main, 0, 0.21, 0));
      const bt = 0.2;
      const bk = f.back || (wide ? '-z' : '-x'), sg = bk[0] === '-' ? -1 : 1;
      g.add(bk[1] === 'z' ? box(w, 0.4, bt, dark, 0, 0.6, sg * (d / 2 - bt / 2)) : box(bt, 0.4, d, dark, sg * (w / 2 - bt / 2), 0.6, 0));
      g.add(wide ? box(0.18, 0.25, d, dark, -w / 2 + 0.09, 0.55, 0) : box(w, 0.25, 0.18, dark, 0, 0.55, -d / 2 + 0.09));
      g.add(wide ? box(0.18, 0.25, d, dark, w / 2 - 0.09, 0.55, 0) : box(w, 0.25, 0.18, dark, 0, 0.55, d / 2 - 0.09));
      break;
    }
    case 'table': case 'desk': case 'workbench':
      g.add(box(w, 0.04, d, main, 0, h - 0.02, 0));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(box(0.05, h - 0.04, 0.05, dark, sx * (w / 2 - 0.06), (h - 0.04) / 2, sz * (d / 2 - 0.06)));
      break;
    case 'chair':
      g.add(box(w, 0.05, d, main, 0, 0.45, 0));
      g.add(box(w, 0.4, 0.05, main, 0, 0.7, -d / 2 + 0.03));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(box(0.04, 0.43, 0.04, main, sx * (w / 2 - 0.04), 0.215, sz * (d / 2 - 0.04)));
      break;
    case 'shelf': case 'record_shelf': {
      const r = rng(Math.round(f.x * 100 + f.z * 7));
      const t = 0.03, levels = f.type === 'shelf' ? 5 : 3;
      const bk = f.back || (wide ? '-z' : '-x');
      if (bk[1] === 'x') g.add(box(t, h, d, main, (bk[0] === '-' ? -1 : 1) * (w / 2 - t / 2), h / 2, 0));
      else g.add(box(w, h, t, main, 0, h / 2, (bk[0] === '-' ? -1 : 1) * (d / 2 - t / 2)));
      // 端は側板ではなく柱だけ（横から見ても中の道具が見えるラック）
      for (const s of [-1, 1]) for (const f of [-1, 1]) {
        const px = wide ? s * (w / 2 - 0.02) : f * (w / 2 - 0.02), pz = wide ? f * (d / 2 - 0.02) : s * (d / 2 - 0.02);
        g.add(box(0.04, h, 0.04, main, px, h / 2, pz));
      }
      const gear = ['#6b7a3e', '#c46a2b', '#5b6770', '#d8c39a', '#2f4f6f', '#8a3b2e'];
      for (let i = 0; i < levels; i++) {
        const y = 0.06 + i * (h - 0.1) / (levels - 1);
        g.add(box(w - 0.01, t, d - 0.01, light, 0, y, 0));
        if (i === levels - 1) continue;
        const span = wide ? w - 0.1 : d - 0.1;
        let p = -span / 2;
        while (p < span / 2 - 0.15) {
          const len = 0.15 + r() * 0.3, bh = 0.12 + r() * (h / levels - 0.2);
          if (p + len > span / 2) break;
          const m = std(gear[Math.floor(r() * gear.length)]);
          const depth = (wide ? d : w) * 0.8;
          g.add(wide ? box(len, bh, depth, m, p + len / 2, y + bh / 2 + 0.015, 0) : box(depth, bh, len, m, 0, y + bh / 2 + 0.015, p + len / 2));
          p += len + 0.04 + r() * 0.1;
        }
      }
      break;
    }
    case 'kitchen_counter': case 'island':
      g.add(box(w, h - 0.04, d, std('#e9e6df'), 0, (h - 0.04) / 2, 0));
      g.add(box(w + 0.02, 0.04, d + 0.02, std('#4a4a4a', { roughness: 0.35 }), 0, h - 0.02, 0));
      if (f.type === 'kitchen_counter') g.add(box(0.5, 0.02, 0.35, metal, w * 0.15, h + 0.005, 0));
      break;
    case 'fridge':
      g.add(box(w, h, d, std('#d9dcdf', { metalness: 0.3, roughness: 0.35 }), 0, h / 2, 0));
      break;
    case 'plant': {
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(w * 0.32, w * 0.25, 0.4, 16), std('#d8cfc0')));
      g.children[0].position.y = 0.2;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(w * 0.55, 16, 12), std('#4f7a4a'));
      leaf.position.y = h * 0.7; leaf.scale.y = 1.4; leaf.castShadow = true;
      g.add(leaf);
      break;
    }
    case 'rug':
      g.add(box(w, 0.015, d, main, 0, 0.008, 0));
      break;
    case 'bathtub':
      g.add(box(w, h, d, white, 0, h / 2, 0));
      g.add(box(w - 0.12, 0.02, d - 0.12, std('#bcd9e6', { roughness: 0.2 }), 0, h - 0.08, 0));
      break;
    case 'toilet_bowl':
      g.add(box(w, 0.4, d * 0.65, white, 0, 0.2, d * 0.15));
      g.add(box(w, 0.45, 0.2, white, 0, 0.6, -d / 2 + 0.1));
      break;
    case 'washbasin':
      g.add(box(w, h - 0.05, d, std('#c9b79c'), 0, (h - 0.05) / 2, 0));
      g.add(box(w, 0.05, d, white, 0, h - 0.025, 0));
      g.add(box(w * 0.9, 0.7, 0.02, std('#cfe3ee', { roughness: 0.05, metalness: 0.5 }), 0, h + 0.55, -d / 2 + 0.02));
      break;
    default:
      g.add(box(w, h, d, main, 0, h / 2, 0));
  }
  return g;
}

// ---- 組み立て -----------------------------------------------------------

function build(spec) {
  S = spec;
  const slab = spec.slab, Hc = spec.ceiling, g = spec.grid;
  scene = new THREE.Scene();

  skyUniforms = { top: { value: new THREE.Color('#5d9fd8') }, bottom: { value: new THREE.Color('#e3f0fb') } };
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({
    uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y * 1.8 + 0.1, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0);\n#include <colorspace_fragment>\n}',
  }));
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
  scene.fog = new THREE.Fog(skyUniforms.bottom.value.clone(), 70, 300);

  const cx = (spec.roof.xmin + spec.roof.xmax) / 2, cz = (spec.roof.zmin + spec.roof.zmax) / 2;
  hemi = new THREE.HemisphereLight('#eef5ff', '#cfc6b4', 1.5);
  scene.add(hemi);
  ambient = new THREE.AmbientLight('#fff6ea', 0.55);
  scene.add(ambient);
  sun = new THREE.DirectionalLight('#fff0d8', 2.8);
  sun.position.set(cx + 14, 26, cz + 20);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 90 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // 地面と敷地
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), std('#7c9e63', { roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.01, cz); ground.receiveShadow = true;
  scene.add(ground);
  const lot = new THREE.Mesh(new THREE.PlaneGeometry(spec.lot.w, spec.lot.d), std('#ffffff', { map: tex('grass', spec.lot.w / 3, spec.lot.d / 3), roughness: 1 }));
  lot.rotation.x = -Math.PI / 2; lot.position.set(spec.lot.w / 2, 0.005, spec.lot.d / 2); lot.receiveShadow = true;
  scene.add(lot);
  G.ext = new THREE.Group();
  const curb = std('#c9c5bc');
  G.ext.add(box(spec.lot.w, 0.12, 0.12, curb, spec.lot.w / 2, 0.06, 0), box(spec.lot.w, 0.12, 0.12, curb, spec.lot.w / 2, 0.06, spec.lot.d),
    box(0.12, 0.12, spec.lot.d, curb, 0, 0.06, spec.lot.d / 2), box(0.12, 0.12, spec.lot.d, curb, spec.lot.w, 0.06, spec.lot.d / 2));
  scene.add(G.ext);

  // 基礎と床
  G.found = new THREE.Group();
  const found = new THREE.Mesh(extrudeXZ(spec.footprint, slab - 0.03), std('#bdb9b0'));
  found.castShadow = found.receiveShadow = true;
  G.found.add(found);
  scene.add(G.found);
  G.floors = new THREE.Group();
  G.ceil = new THREE.Group();
  const ceilMat = std('#f6f4ef', { roughness: 0.95 });
  for (const room of spec.rooms) {
    for (const [x, z, w, d] of room.rects) {
      if (room.finish === 'deck') {
        G.floors.add(box(w, 0.2, d, std('#ffffff', { map: tex('deck', w / 0.9, 1) }), x + w / 2, slab - 0.15, z + d / 2));
        continue;
      }
      if (room.finish === 'grass') {
        const m = box(w, 0.04, d, std('#ffffff', { map: tex('grass', w / 3, d / 3) }), x + w / 2, 0.02, z + d / 2);
        G.floors.add(m);
        continue;
      }
      const scale = room.finish === 'wood' ? 1.2 : 0.9;
      G.floors.add(box(w, 0.03, d, std('#ffffff', { map: tex(room.finish, w / scale, d / scale), roughness: room.finish === 'tile' ? 0.4 : 0.75 }), x + w / 2, slab - 0.015, z + d / 2));
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set(x + w / 2, slab + Hc - 0.001, z + d / 2);
      ceil.receiveShadow = true;
      G.ceil.add(ceil);
    }
    if (room.indoor && room.jo >= 1.4) {
      const light = new THREE.PointLight('#ffd49a', 0, 4.5, 2);
      light.position.set(room.center[0], slab + Hc - 0.35, room.center[1]);
      roomLights.push(light);
      scene.add(light);
    }
  }
  scene.add(G.floors);
  scene.add(G.ceil);

  // 壁と建具（壁グループの原点は床の高さ。工程で高さ方向に伸ばす）
  G.walls = new THREE.Group();
  G.walls.position.y = slab;
  const inner = std('#f3f0ea', { roughness: 0.92 });
  const outer = std(spec.colors.wall, { roughness: 0.6, metalness: 0.15 });
  const sash = std('#2b2b2b', { roughness: 0.5 });
  const trim = std(spec.colors.trim);
  const head = spec.door_head, sill = spec.sill;
  for (const w of spec.walls) {
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    const t = w.exterior ? T_EXT : T_INT;
    const mx = (w.x1 + w.x2) / 2, mz = (w.z1 + w.z2) / 2;
    const alongX = w.orient === 'h';
    const mats = [inner, inner, w.exterior ? outer : inner, inner, inner, inner];
    if (w.exterior) mats[alongX ? (w.outside > 0 ? 4 : 5) : (w.outside > 0 ? 0 : 1)] = outer;
    const piece = (y0, y1, extend = true) => {
      const h = y1 - y0, L = len + (extend ? t : 0);
      const m = new THREE.Mesh(alongX ? new THREE.BoxGeometry(L, h, t) : new THREE.BoxGeometry(t, h, L), mats);
      m.position.set(mx, y0 + h / 2, mz);
      m.castShadow = m.receiveShadow = true;
      G.walls.add(m);
    };
    const glass = (y0, y1) => {
      const mat = new THREE.MeshStandardMaterial({ color: '#a8cde3', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.32, emissive: '#ffcf86', emissiveIntensity: 0 });
      glassMats.push(mat);
      const h = y1 - y0;
      const pane = new THREE.Mesh(alongX ? new THREE.BoxGeometry(len - 0.06, h, 0.02) : new THREE.BoxGeometry(0.02, h, len - 0.06), mat);
      pane.position.set(mx, y0 + h / 2, mz);
      G.walls.add(pane);
      const f = 0.04;
      const fr = (fw, fh, fx, fy) => {
        const m = new THREE.Mesh(alongX ? new THREE.BoxGeometry(fw, fh, 0.06) : new THREE.BoxGeometry(0.06, fh, fw), sash);
        m.position.set(alongX ? mx + fx : mx, fy, alongX ? mz : mz + fx);
        G.walls.add(m);
      };
      fr(len, f, 0, y0 + f / 2); fr(len, f, 0, y1 - f / 2);
      fr(f, h, -len / 2 + f / 2, y0 + h / 2); fr(f, h, len / 2 - f / 2, y0 + h / 2);
    };
    switch (w.kind) {
      case 'window': piece(0, sill); piece(head, Hc); glass(sill, head); break;
      case 'glassdoor': piece(head, Hc); glass(0, head); break;
      case 'entry': {
        piece(head, Hc);
        const m = new THREE.Mesh(alongX ? new THREE.BoxGeometry(len, 0.06, t + 0.02) : new THREE.BoxGeometry(t + 0.02, 0.06, len), trim);
        m.position.set(mx, head + 0.03, mz);
        G.walls.add(m);
        break;
      }
      case 'door': case 'shutter': piece(head, Hc); break;
      default: piece(0, Hc);
    }
  }
  scene.add(G.walls);

  // 家具
  G.furn = new THREE.Group();
  for (const f of spec.furniture) {
    const obj = furniture(f);
    obj.position.set(f.x, slab, f.z);
    obj.userData.base = slab;
    furnitureObjs.push(obj);
    G.furn.add(obj);
  }
  scene.add(G.furn);

  // 屋根（片流れ。北側が高い。flat は立ち上がり 0。gable / hip は片流れで代用）
  G.roof = new THREE.Group();
  const r = spec.roof, base = slab + Hc, thick = 0.2;
  const rise = r.type === 'flat' ? 0 : r.rise;
  const slope = (z) => rise * (r.zmax - z) / Math.max(r.zmax - r.zmin, 0.01);
  const roofGeo = extrudeXZ(r.outline, thick);
  const pos = roofGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + base + slope(pos.getZ(i)));
  roofGeo.computeVertexNormals();
  const roofMesh = new THREE.Mesh(roofGeo, [std(spec.colors.roof, { roughness: 0.5, metalness: 0.3 }), trim]);
  roofMesh.castShadow = roofMesh.receiveShadow = true;
  G.roof.add(roofMesh);
  const soffitShape = new THREE.Shape(r.outline[0].map(([x, z]) => new THREE.Vector2(x, z)));
  const soffit = new THREE.ShapeGeometry(soffitShape);
  soffit.rotateX(Math.PI / 2);
  const sp = soffit.attributes.position;
  for (let i = 0; i < sp.count; i++) sp.setY(i, base - 0.002 + slope(sp.getZ(i)));
  soffit.computeVertexNormals();
  G.roof.add(new THREE.Mesh(soffit, std(spec.colors.trim, { side: THREE.DoubleSide })));
  if (rise > 0) {
    const verts = [];
    for (const loop of spec.footprint) {
      for (let i = 0; i < loop.length; i++) {
        const [x1, z1] = loop[i], [x2, z2] = loop[(i + 1) % loop.length];
        const a = base, b1 = base + slope(z1), b2 = base + slope(z2);
        verts.push(x1, a, z1, x2, a, z2, x2, b2, z2, x1, a, z1, x2, b2, z2, x1, b1, z1);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    fg.computeVertexNormals();
    const fascia = new THREE.Mesh(fg, std(spec.colors.wall, { side: THREE.DoubleSide, roughness: 0.6, metalness: 0.15 }));
    fascia.castShadow = true;
    G.roof.add(fascia);
  }
  scene.add(G.roof);

  // 外構: 玄関からのアプローチと木
  const stone = std('#d8d3c8');
  for (const w of spec.walls) {
    if (w.kind !== 'entry' || !w.exterior) continue;
    const nx = w.orient === 'v' ? w.outside : 0, nz = w.orient === 'h' ? w.outside : 0;
    const mx = (w.x1 + w.x2) / 2, mz = (w.z1 + w.z2) / 2;
    G.ext.add(box(w.orient === 'h' ? 1.4 : 1.1, slab - 0.1, w.orient === 'h' ? 1.1 : 1.4, std('#bdb9b0'), mx + nx * 0.6, (slab - 0.1) / 2, mz + nz * 0.6));
    for (let k = 1; k < 8; k++) {
      const px = mx + nx * (0.6 + k * 0.75), pz = mz + nz * (0.6 + k * 0.75);
      if (px < 0.4 || pz < 0.4 || px > spec.lot.w - 0.4 || pz > spec.lot.d - 0.4) break;
      G.ext.add(box(0.55, 0.06, 0.55, stone, px, 0.03, pz));
    }
  }
  const trunk = std('#6e5038'), leaves = [std('#4e7d45'), std('#5f8f4f')];
  const spots = [[1.2, spec.lot.d - 1.2], [spec.lot.w - 1.2, spec.lot.d - 1.2], [spec.lot.w - 1.3, 1.3], [1.3, 1.3], [spec.lot.w / 2, spec.lot.d - 1.0]];
  let planted = 0;
  for (const [x, z] of spots) {
    if (planted >= 3) break;
    if (x > r.xmin - 1.6 && x < r.xmax + 1.6 && z > r.zmin - 1.6 && z < r.zmax + 1.6) continue;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 1.6, 10), trunk);
    t.position.set(x, 0.8, z); t.castShadow = true;
    G.ext.add(t);
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.9 - k * 0.2, 16, 12), leaves[k % 2]);
      s.position.set(x + (k - 1) * 0.25, 1.9 + k * 0.55, z + (k % 2) * 0.2);
      s.castShadow = true;
      G.ext.add(s);
    }
    planted++;
  }
}

// ---- 状態の反映 -----------------------------------------------------------

const DAY = { top: new THREE.Color('#5d9fd8'), bottom: new THREE.Color('#e3f0fb'), hemiSky: new THREE.Color('#eef5ff'), hemi: 1.5, sun: 2.8, sunColor: new THREE.Color('#fff0d8') };
const NIGHT = { top: new THREE.Color('#0a1230'), bottom: new THREE.Color('#2c3966'), hemiSky: new THREE.Color('#5a6aa0'), hemi: 0.5, sun: 0.35, sunColor: new THREE.Color('#9fb3ff') };

function setNight(k) {
  skyUniforms.top.value.copy(DAY.top).lerp(NIGHT.top, k);
  skyUniforms.bottom.value.copy(DAY.bottom).lerp(NIGHT.bottom, k);
  scene.fog.color.copy(skyUniforms.bottom.value);
  hemi.color.copy(DAY.hemiSky).lerp(NIGHT.hemiSky, k);
  hemi.intensity = DAY.hemi + (NIGHT.hemi - DAY.hemi) * k;
  sun.intensity = DAY.sun + (NIGHT.sun - DAY.sun) * k;
  sun.color.copy(DAY.sunColor).lerp(NIGHT.sunColor, k);
  for (const m of glassMats) { m.emissiveIntensity = 1.6 * k; m.opacity = 0.32 + 0.5 * k; }
  for (const l of roomLights) l.intensity = 2.5 + 4 * k;
  ambient.intensity = 0.55 - 0.4 * k;
}

function apply(st) {
  camera.fov = st.fov;
  camera.position.set(...st.pos);
  camera.lookAt(...st.target);
  camera.updateProjectionMatrix();
  G.found.scale.y = Math.max(st.slab, 0.001);
  G.found.visible = st.slab > 0.001;
  G.floors.visible = st.slab >= 0.999;
  G.ceil.visible = st.walls >= 0.999;
  G.walls.scale.y = Math.max(st.walls, 0.001);
  G.walls.visible = st.walls > 0.001;
  furnitureObjs.forEach((obj, i) => {
    const off = st.furn ? st.furn[i] : 0;
    obj.visible = off !== null && off !== undefined;
    if (obj.visible) obj.position.y = obj.userData.base + off;
  });
  G.roof.visible = st.roof !== null && st.roof !== undefined;
  if (G.roof.visible) G.roof.position.y = st.roof;
  setNight(st.night || 0);
  skyMesh.position.copy(camera.position);
}

function init(width, height, preserve) {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: preserve });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 900);
}

// 動画書き出し用の API（Python から呼ぶ）
window.walk = {
  load(spec) {
    init(VIDEO_W, VIDEO_H, true);
    build(spec);
    return { walls: spec.walls.length, furniture: furnitureObjs.length };
  },
  renderAt(st, quality = 0.92) {
    apply(st);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/jpeg', quality);
  },
};

// 共有用ビューア
if (new URLSearchParams(location.search).has('interactive')) {
  document.body.classList.add('interactive');
  const spec = await (await fetch('./scene.json')).json();
  init(innerWidth, innerHeight, false);
  build(spec);
  const r = spec.roof;
  const center = new THREE.Vector3((r.xmin + r.xmax) / 2, spec.slab, (r.zmin + r.zmax) / 2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2;
  controls.maxDistance = 80;
  const outside = () => {
    const k = Math.max(1, 0.8 / (innerWidth / innerHeight));   // 縦長の画面では家全体が入るまで引く
    camera.fov = 45;
    camera.position.set(center.x + 16 * k, 14 * k, center.z + 22 * k);
    controls.target.copy(center);
    camera.updateProjectionMatrix();
  };
  outside();
  const state = { roof: true, night: 0 };
  document.querySelectorAll('#ui button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'outside') outside();
    if (b.dataset.act === 'roof') { state.roof = !state.roof; b.textContent = state.roof ? '屋根を外す' : '屋根をのせる'; }
    if (b.dataset.act === 'night') { state.night = state.night ? 0 : 1; b.textContent = state.night ? '昼にする' : '夜にする'; }
  }));
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
  renderer.setAnimationLoop(() => {
    controls.update();
    G.roof.visible = state.roof;
    G.found.visible = G.floors.visible = G.walls.visible = G.ceil.visible = true;
    setNight(state.night);
    skyMesh.position.copy(camera.position);
    renderer.render(scene, camera);
  });
}
