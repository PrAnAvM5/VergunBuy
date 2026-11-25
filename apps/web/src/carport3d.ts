/**
 * "Carport 3D": the 3D view of the plot (3D BAG buildings, laser-scan trees and shrubs) with the
 * selected carport, the parked car(s) and the car driving in and out. The controls and verdict are
 * the same as in "Carport 2D" and share its state.
 */
import type { PlotContext } from "@vergunbuy/data";
import { CARPORT_HEIGHT_M, POST_M, rectangle, type Car, type Pose } from "@vergunbuy/engine";
import * as THREE from "three";
import {
  bindControls,
  controlsHtml,
  getSession,
  verdictHtml,
  type Session,
} from "./carportSession.ts";
import { esc } from "./format.ts";
import { mountScene, webglAvailable } from "./scene3d.ts";

export interface CarportView {
  dispose(): void;
}

// Plan (x, y), height h → three.js (x, h, -y), as in the 3D view.
const v3 = (x: number, y: number, h: number) => new THREE.Vector3(x, h, -y);
const VCOL = { green: 0x2f7d32, amber: 0xd08a12, red: 0xb3261e } as const;

function makeCar(car: Car, paint: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: paint });
  const glass = new THREE.MeshLambertMaterial({ color: 0x2a3440 });
  const tyre = new THREE.MeshLambertMaterial({ color: 0x1d1f22 });
  const light = new THREE.MeshLambertMaterial({ color: 0xf2efe6 });
  const rev = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const w = car.w;
  const l = car.l;
  // Model space: centre of the body at the origin, front towards -z.
  add(new THREE.BoxGeometry(w, 0.62, l), body, 0, 0.62, 0);
  add(new THREE.BoxGeometry(w * 0.9, 0.5, l * 0.51), body, 0, 1.18, l * 0.055);
  add(new THREE.BoxGeometry(w * 0.91, 0.36, l * 0.44), glass, 0, 1.2, l * 0.055);
  add(new THREE.BoxGeometry(0.4, 0.12, 0.04), light, -w * 0.3, 0.72, -l / 2 - 0.01);
  add(new THREE.BoxGeometry(0.4, 0.12, 0.04), light, w * 0.3, 0.72, -l / 2 - 0.01);
  const rl = add(new THREE.BoxGeometry(w * 0.8, 0.1, 0.04), rev, 0, 0.72, l / 2 + 0.01);
  rl.name = "rev";
  const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 18);
  wheel.rotateZ(Math.PI / 2);
  const ax = l * 0.3;
  for (const [x, z] of [
    [-w / 2 + 0.04, -ax],
    [w / 2 - 0.04, -ax],
    [-w / 2 + 0.04, ax],
    [w / 2 - 0.04, ax],
  ] as const)
    add(wheel, tyre, x, 0.33, z);
  return g;
}

function poseCar(g: THREE.Group, car: Car, p: Pose): void {
  const cx = p.x + car.bodyC * Math.sin(p.a);
  const cy = p.y + car.bodyC * Math.cos(p.a);
  g.position.copy(v3(cx, cy, 0));
  g.rotation.y = -p.a;
  const rev = g.getObjectByName("rev") as THREE.Mesh | undefined;
  if (rev) (rev.material as THREE.MeshBasicMaterial).opacity = p.rev ? 1 : 0;
}

export async function mountCarport3D(el: HTMLElement, ctx: PlotContext): Promise<CarportView> {
  const got = await getSession(ctx);
  if ("gate" in got) {
    el.innerHTML = `<div class="carport-msg"><h3>No carport check for this home</h3><p>${esc(got.gate)}</p></div>`;
    return { dispose: () => (el.innerHTML = "") };
  }
  const s: Session = got;
  el.innerHTML = `<div id="cp-controls"></div><div class="view3d" id="cp-3d"></div>
    <div class="small muted cp-legend">Drag to rotate · scroll to zoom · right-drag to move. Move or resize the carport in “Carport 2D”; it stays the same here. Buildings from 3D BAG (CC BY 4.0); trees and shrubs from the AHN laser scan.</div>
    <div id="cp-verdict"></div>`;
  const controls = el.querySelector<HTMLElement>("#cp-controls")!;
  const verdictEl = el.querySelector<HTMLElement>("#cp-verdict")!;
  const stage = el.querySelector<HTMLElement>("#cp-3d")!;
  if (!webglAvailable()) {
    stage.innerHTML = `<div class="carport-msg"><p>This browser cannot show 3D (WebGL is off). “Carport 2D” shows the same.</p></div>`;
  }
  const handle = webglAvailable() ? mountScene(stage, ctx) : null;
  const group = new THREE.Group();
  handle?.scene.add(group);
  let movCar: THREE.Group | null = null;
  let shownVerdict: unknown = null;
  let shownBay = -1;
  let shownParams = s.params;

  const build = () => {
    group.clear();
    movCar = null;
    const v = s.verdict;
    if (!s.pl || !v) return;
    const car = s.prep.vehicle.car;
    const r = rectangle(s.pl);
    const colour = VCOL[v.colour];
    const postMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    const roofMat = new THREE.MeshLambertMaterial({
      color: colour,
      transparent: true,
      opacity: 0.75,
    });
    const P = POST_M;
    const h = CARPORT_HEIGHT_M;
    for (const [px, py] of [
      [r[0]![0] + P / 2, r[0]![1] + P / 2],
      [r[1]![0] - P / 2, r[1]![1] + P / 2],
      [r[3]![0] + P / 2, r[3]![1] - P / 2],
      [r[2]![0] - P / 2, r[2]![1] - P / 2],
    ] as const) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(P, 0.12), h, Math.max(P, 0.12)),
        postMat,
      );
      post.position.copy(v3(px, py, h / 2));
      group.add(post);
    }
    const w = r[1]![0] - r[0]![0];
    const d = r[3]![1] - r[0]![1];
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.15, d + 0.2), roofMat);
    roof.position.copy(v3(r[0]![0] + w / 2, r[0]![1] + d / 2, h + 0.075));
    group.add(roof);
    // Swept path on the ground for the selected bay.
    const B = v.access.bays[s.bay];
    if (B?.route) {
      const pts = B.route.poses.map((p) =>
        v3(p.x + car.bodyC * Math.sin(p.a), p.y + car.bodyC * Math.cos(p.a), 0.08),
      );
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineDashedMaterial({ color: 0x1f6fd1, dashSize: 0.6, gapSize: 0.4 }),
        ).computeLineDistances(),
      );
    }
    if (v.access.fit.fits)
      v.access.bays.forEach((b, i) => {
        const g = makeCar(car, i === s.bay ? (b.route ? 0x3b78c4 : 0xb3261e) : 0xe8e6e1);
        poseCar(g, car, b.parked);
        group.add(g);
        if (i === s.bay) movCar = g;
      });
  };

  const render = () => {
    if (s.verdict !== shownVerdict || s.bay !== shownBay || s.params !== shownParams) {
      build();
      shownVerdict = s.verdict;
      shownBay = s.bay;
      shownParams = s.params;
      controls.innerHTML = controlsHtml(s);
      bindControls(controls, s);
      verdictEl.innerHTML = verdictHtml(s);
    } else if (!s.anim) {
      controls.innerHTML = controlsHtml(s);
      bindControls(controls, s);
    }
    const car = s.prep.vehicle.car;
    const B = s.verdict?.access.bays[s.bay];
    if (movCar && B) poseCar(movCar, car, s.moving ?? B.parked);
  };
  s.listeners.add(render);
  render();
  return {
    dispose: () => {
      s.listeners.delete(render);
      handle?.dispose();
      el.innerHTML = "";
    },
  };
}
