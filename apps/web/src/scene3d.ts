/**
 * Workspace 3D view, built only from registry data:
 *  - buildings from 3D BAG LoD 2.2 faces (real roof shapes); if missing, the BAG footprint
 *    extruded to its measured height (or 3 m, marked as assumed in the Inspector);
 *  - the plot and nearby public areas as ground surfaces; registered trees as simple trees.
 * Same frame as the 2D plan: street at the front. three.js is loaded only when this view opens.
 */
import { smoothedPieces } from "./plotLine.ts";
import type { Building, PlotContext } from "@vergunbuy/data";
import { polyToLocal, toLocal, type Polygon } from "@vergunbuy/engine";
import * as THREE from "three";
import { isOtherHomeOnParcel } from "./format.ts";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface SceneHandle {
  dispose(): void;
  /** The live scene: objects added to it are drawn from the next frame on. */
  scene: THREE.Scene;
}

// Local plan (x, y) and height h → three.js (X = x, Y = h, Z = -y), so the street faces the camera.
const v3 = (x: number, y: number, h: number) => new THREE.Vector3(x, h, -y);

function faceGeometry(
  ctx: PlotContext,
  ring: [number, number, number][],
): THREE.BufferGeometry | undefined {
  if (ring.length < 3) return undefined;
  const pts = ring.map(([x, y, h]) => {
    const [lx, ly] = toLocal(ctx.frame, [x, y]);
    return v3(lx, ly, h);
  });
  // Newell normal → drop the dominant axis → triangulate in 2D.
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  const flat = pts.map((p) =>
    ax >= ay && ax >= az
      ? new THREE.Vector2(p.y, p.z)
      : ay >= az
        ? new THREE.Vector2(p.x, p.z)
        : new THREE.Vector2(p.x, p.y),
  );
  const tris = THREE.ShapeUtils.triangulateShape(flat, []);
  if (!tris.length) return undefined;
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  g.setIndex(tris.flat());
  g.computeVertexNormals();
  return g;
}

function groundShape(
  ctx: PlotContext,
  poly: Polygon,
  y: number,
  material: THREE.Material,
): THREE.Mesh {
  const local = polyToLocal(ctx.frame, poly);
  const shape = new THREE.Shape(local.map(([x, yy]) => new THREE.Vector2(x, yy)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = y;
  return mesh;
}

function buildingObject(
  ctx: PlotContext,
  b: Building,
  roof: THREE.Material,
  wall: THREE.Material,
): THREE.Object3D {
  const mesh = b.heights?.mesh;
  const group = new THREE.Group();
  if (mesh && mesh.faces.length) {
    for (const f of mesh.faces) {
      if (f.kind === "ground") continue;
      const g = faceGeometry(ctx, f.ring);
      if (g) group.add(new THREE.Mesh(g, f.kind === "roof" ? roof : wall));
    }
    if (group.children.length) return group;
  }
  // Fallback: extrude the footprint to the measured height (or 3 m).
  const local = polyToLocal(ctx.frame, b.outline);
  const shape = new THREE.Shape(local.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: b.heights?.heightM ?? 3,
    bevelEnabled: false,
  });
  geo.rotateX(-Math.PI / 2);
  group.add(new THREE.Mesh(geo, wall));
  return group;
}

/** True when the browser can create a WebGL context. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** One odd building (e.g. a broken roof face) must not take down the whole scene. */
function safeBuilding(
  ctx: PlotContext,
  b: Building,
  roof: THREE.Material,
  wall: THREE.Material,
): THREE.Object3D | undefined {
  try {
    return buildingObject(ctx, b, roof, wall);
  } catch (err) {
    console.warn("3D: skipped building", b.id, err);
    return undefined;
  }
}

export function mountScene(el: HTMLElement, ctx: PlotContext): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#eef1f4");
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8578, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(-30, 60, 40);
  scene.add(sun);

  const L = ctx.layout;
  const cx = (L.plot.minX + L.plot.maxX) / 2;
  const cy = (L.plot.minY + L.plot.maxY) / 2;
  const size = Math.max(L.plotWidthM, L.plotDepthM, 20);
  const range = size * 0.9 + 15;
  const inRange = (poly: Polygon) =>
    polyToLocal(ctx.frame, poly).some(
      ([x, y]) => Math.abs(x - cx) < range && Math.abs(y - cy) < range,
    );

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(range * 2.4, range * 2.4),
    new THREE.MeshLambertMaterial({ color: "#dcd8cd" }),
  );
  base.rotation.x = -Math.PI / 2;
  base.position.set(cx, -0.03, -cy);
  scene.add(base);

  const mats = {
    road: new THREE.MeshLambertMaterial({ color: "#bdb8ad" }),
    path: new THREE.MeshLambertMaterial({ color: "#d3cec3" }),
    green: new THREE.MeshLambertMaterial({ color: "#a9cf8f" }),
    water: new THREE.MeshLambertMaterial({ color: "#8fbfe6" }),
    exit: new THREE.MeshLambertMaterial({ color: "#f2b134" }),
    plot: new THREE.MeshLambertMaterial({ color: "#f7f5ef" }),
    houseRoof: new THREE.MeshLambertMaterial({ color: "#a2513b", side: THREE.DoubleSide }),
    houseWall: new THREE.MeshLambertMaterial({ color: "#f1ebe0", side: THREE.DoubleSide }),
    outRoof: new THREE.MeshLambertMaterial({ color: "#7d6fd6", side: THREE.DoubleSide }),
    outWall: new THREE.MeshLambertMaterial({ color: "#d9d3f5", side: THREE.DoubleSide }),
    otherRoof: new THREE.MeshLambertMaterial({ color: "#2a9d8f", side: THREE.DoubleSide }),
    otherWall: new THREE.MeshLambertMaterial({ color: "#bfe3de", side: THREE.DoubleSide }),
    nbRoof: new THREE.MeshLambertMaterial({ color: "#9a958c", side: THREE.DoubleSide }),
    nbWall: new THREE.MeshLambertMaterial({ color: "#d8d4cc", side: THREE.DoubleSide }),
    trunk: new THREE.MeshLambertMaterial({ color: "#6b4f35" }),
    crown: new THREE.MeshLambertMaterial({ color: "#4d8f3f", transparent: true, opacity: 0.9 }),
    obstacle: new THREE.MeshLambertMaterial({ color: "#d9a520", transparent: true, opacity: 0.85 }),
    overhang: new THREE.MeshLambertMaterial({ color: "#8a7fd6", transparent: true, opacity: 0.55 }),
  };

  for (const a of ctx.publicAreas ?? []) {
    if (!inRange(a.outline)) continue;
    const isExit = ctx.exits.some((e) => e.id === a.id);
    const m = isExit
      ? mats.exit
      : a.kind === "road"
        ? mats.road
        : a.kind === "green"
          ? mats.green
          : a.kind === "water"
            ? mats.water
            : mats.path;
    scene.add(groundShape(ctx, a.outline, isExit ? 0.012 : 0.006, m));
  }
  scene.add(groundShape(ctx, ctx.plot.outline, 0.02, mats.plot));
  // Plot boundary as a dark line.
  const boundary = polyToLocal(ctx.frame, ctx.plot.outline).map(([x, y]) => v3(x, y, 0.05));
  boundary.push(boundary[0]!.clone());
  scene.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(boundary),
      new THREE.LineBasicMaterial({ color: "#1d1f24" }),
    ),
  );

  const add = (o: THREE.Object3D | undefined) => o && scene.add(o);
  for (const b of ctx.house) add(safeBuilding(ctx, b, mats.houseRoof, mats.houseWall));
  for (const b of ctx.outbuildings) add(safeBuilding(ctx, b, mats.outRoof, mats.outWall));
  for (const b of ctx.neighbours)
    if (inRange(b.outline))
      add(
        isOtherHomeOnParcel(b)
          ? safeBuilding(ctx, b, mats.otherRoof, mats.otherWall)
          : safeBuilding(ctx, b, mats.nbRoof, mats.nbWall),
      );
  // Obstacles from the height scan as 0.5 m columns of their measured height.
  if (ctx.obstacles) {
    const res = ctx.obstacles.res;
    const all = ctx.obstacles.obstacles.flatMap((o) =>
      o.cells.map((p, i) => ({ p, h: o.cellHeights[i] ?? 1, overhang: o.kind === "overhang" })),
    );
    // Green for crowns (2.5 m and up), amber for hedges and shrubs, violet for a neighbour's
    // overhanging tree: each cell by its own measured height.
    const groupsByMat: [THREE.Material, typeof all][] = [
      [mats.crown, all.filter((c) => !c.overhang && c.h >= 2.5)],
      [mats.obstacle, all.filter((c) => !c.overhang && c.h < 2.5)],
      [mats.overhang, all.filter((c) => c.overhang)],
    ];
    for (const [mat, list] of groupsByMat) {
      const cells = list.map((c) => [c.p, c.h] as const);
      if (!cells.length) continue;
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(res, 1, res), mat, cells.length);
      const mx = new THREE.Matrix4();
      cells.forEach(([p, h], i) => {
        const [x, y] = toLocal(ctx.frame, p);
        mx.makeScale(1, Math.max(h, 0.2), 1).setPosition(v3(x, y, h / 2));
        mesh.setMatrixAt(i, mx);
      });
      scene.add(mesh);
    }
  }
  for (const t of ctx.trees ?? []) {
    const [x, y] = toLocal(ctx.frame, t.at);
    if (Math.abs(x - cx) > range || Math.abs(y - cy) > range) continue;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 3, 8), mats.trunk);
    trunk.position.copy(v3(x, y, 1.5));
    const crown = new THREE.Mesh(new THREE.SphereGeometry(t.crownM / 2, 14, 10), mats.crown);
    crown.position.copy(v3(x, y, 3 + t.crownM / 2 - 0.4));
    scene.add(trunk, crown);
  }

  // What stands on the street side of the plot line: hedges green, fences and walls dark, each
  // piece at its scanned height (at least 0.6 m, so it shows), and exits as a low yellow kerb.
  {
    const hedgeMat = new THREE.MeshLambertMaterial({ color: 0x2f7d32 });
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    const exitMat = new THREE.MeshLambertMaterial({ color: 0xf2b134 });
    for (const p of smoothedPieces(ctx.boundary?.pieces ?? [])) {
      if (p.side !== "street" || p.state === "open" || p.state === "unknown") continue;
      const [ax, ay] = toLocal(ctx.frame, p.a);
      const [bx, by] = toLocal(ctx.frame, p.b);
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const exit = p.state === "exit";
      const h = exit ? 0.08 : Math.max(0.6, p.heightM ?? 1);
      const thick = p.state === "hedge" ? 0.6 : exit ? 0.3 : 0.15;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(len + 0.02, h, thick),
        exit ? exitMat : p.state === "hedge" ? hedgeMat : wallMat,
      );
      m.position.copy(v3((ax + bx) / 2, (ay + by) / 2, h / 2));
      m.rotation.y = Math.atan2(by - ay, bx - ax);
      scene.add(m);
    }
  }
  // Lamp posts (5 m, with a head) and other poles and cabinets in the street.
  {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a4f57 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd23f });
    for (const o of ctx.streetObjects ?? []) {
      const [x, y] = toLocal(ctx.frame, o.at);
      if (Math.abs(x - cx) > range || Math.abs(y - cy) > range) continue;
      if (o.kind === "lamp post") {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 5, 8), poleMat);
        pole.position.copy(v3(x, y, 2.5));
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), lampMat);
        head.position.copy(v3(x, y, 5.1));
        scene.add(pole, head);
      } else if (o.kind.includes("cabinet")) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 0.35), poleMat);
        box.position.copy(v3(x, y, 0.6));
        scene.add(box);
      } else {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), poleMat);
        pole.position.copy(v3(x, y, 1.2));
        scene.add(pole);
      }
    }
  }

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
  const target = new THREE.Vector3(cx, 2, -cy);
  camera.position.set(cx - size * 0.35, size * 0.75 + 8, -L.plot.minY + size * 0.9 + 8);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();

  const resize = () => {
    const w = el.clientWidth || 800;
    const h = Math.round(w * 0.72);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "auto";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  let running = true;
  const loop = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();

  return {
    scene,
    dispose() {
      running = false;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      el.innerHTML = "";
    },
  };
}
