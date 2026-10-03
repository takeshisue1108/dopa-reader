// The road outside the glass (ドパ ED D-43, D-48): a pseudo-3D road with buildings on both sides
// that rush past without end; in curves the cockpit tilts and Elena sways after it with inertia.
// Taken from the accepted test scene (testscene.js), unchanged in what it draws.
//
// Things stand on the ground; z is the distance (1 = at the glass). On the screen (world pixels),
// feet are at horizon + G / z and x at the road's center + X / z.
//
// The course is made of segments, as in Out Run (research 13, Lou's pseudo 3d page): each segment
// is straight (0) or curves (+1 right, -1 left), and the curvature eases from one segment to the
// next. The road's lateral offset at depth z is the double integral of the curvature ahead of the
// player, so a curve shows first far away; the tilt uses only the curvature where the player is,
// so it is exactly zero on a straight.

export const SPEED = 0.22; // depth units per tick
export const ROAD_HALF_WIDTH = 110;
const COURSE = [0, 0, 1, 1, 0, 0, -1, -1, 0, 1, 0, 0, -1, 0];
const SEGMENT = 26; // depth units per segment (about 4 s)
const Z_MAX = 64,
  DZ = 0.25;
const BUILDINGS = 28,
  BUILDING_GAP = 1.1;

/** The curvature of the course at a travelled depth: it eases into the next segment in the last
 * 30% of each segment. */
export function curvatureAt(depth) {
  const index = Math.floor(depth / SEGMENT),
    within = depth / SEGMENT - index,
    here = COURSE[index % COURSE.length],
    next = COURSE[(index + 1) % COURSE.length];
  const t = Math.max(0, Math.min(1, (within - 0.7) / 0.3)),
    eased = t * t * (3 - 2 * t);
  return here + (next - here) * eased;
}

export class Road {
  /** `glass`: the see-through part of the cockpit picture, in world pixels. `buildings`: the
   * building sprites as [{img, meta}] (ladders of sizes). */
  constructor(glass, buildings) {
    this.centerX = glass.x + glass.w / 2;
    this.horizonY = glass.y + Math.round(glass.h * 0.36);
    this.G = 56; // the camera's height above the ground
    this.sprites = buildings;
    this.travel = 0;
    this.tilt = 0; // the cockpit's lean, following the curvature where it is
    this.swayX = 0; // Elena's sideways sway, in pixels
    this.swayV = 0;
    this.offsets = new Float32Array(Math.ceil((Z_MAX - 1) / DZ) + 2); // lateral offset at each depth
    this.buildings = Array.from({ length: BUILDINGS }, (_, k) => ({
      side: k % 2 ? 1 : -1,
      d: 1.2 + k * BUILDING_GAP,
      v: k % Math.max(1, buildings.length),
      off: (k * 37) % 40,
    }));
    this.buildTable();
  }

  buildTable() {
    let x = 0,
      v = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      this.offsets[i] = x;
      const z = 1 + i * DZ;
      v += 2.8 * curvatureAt(this.travel + z) * DZ;
      x += v * DZ;
    }
  }

  /** One tick of travel; `factor` scales the speed (1 while moving, 0 stands still). */
  move(factor = 1) {
    const step = SPEED * factor;
    this.travel += step;
    this.buildTable();
    const curve = curvatureAt(this.travel + 1); // the curvature where the cockpit is
    this.tilt += (curve * Math.min(1, factor) - this.tilt) * 0.15; // standing still, it does not tilt
    for (const building of this.buildings) {
      building.d -= step;
      if (building.d < 0.9) {
        building.d += BUILDINGS * BUILDING_GAP;
        building.v = (building.v + 3) % Math.max(1, this.sprites.length);
      }
    }
    // Elena's sway: a damped spring pulled to the outside of the curve
    this.swayV += (-this.tilt * 9 - this.swayX) * 0.06;
    this.swayV *= 0.86;
    this.swayX += this.swayV;
  }

  /** The screen x of the road's center at depth z. */
  roadX(z) {
    const i = Math.max(0, Math.min(this.offsets.length - 2, (z - 1) / DZ)),
      k = Math.floor(i),
      w = i - k;
    return this.centerX + (this.offsets[k] * (1 - w) + this.offsets[k + 1] * w) / Math.max(1, z);
  }
  /** A point on the ground, X to the side of the road's center at depth z. */
  project(X, z) {
    return { x: this.roadX(z) + X / z, y: this.horizonY + this.G / z };
  }
  /** A point H above the ground. */
  project3(X, H, z) {
    return { x: this.roadX(z) + X / z, y: this.horizonY + (this.G - H) / z };
  }

  /** The road, row by row: alternating bands rush toward the glass. */
  drawGround(m) {
    for (let y = this.horizonY + 1; y < 240; y++) {
      const z = this.G / (y - this.horizonY),
        cx = this.roadX(z),
        hw = ROAD_HALF_WIDTH / z,
        band = Math.floor((z + this.travel) * 1.2) % 2;
      m.fillStyle = band ? "#c4c4ca" : "#b8b8c0"; // light gray beside the road (ED D-138)
      m.fillRect(0, y, 426, 1); // sidewalk
      m.fillStyle = band ? "#5a5560" : "#524d58";
      m.fillRect(Math.round(cx - hw), y, Math.round(hw * 2), 1); // asphalt
      const rumble = Math.max(1, Math.round(10 / z));
      m.fillStyle = band ? "#e8e4ee" : "#c33142"; // rumble strips
      m.fillRect(Math.round(cx - hw - rumble), y, rumble, 1);
      m.fillRect(Math.round(cx + hw), y, rumble, 1);
      if (band) {
        m.fillStyle = "#f4f1ff"; // center line
        m.fillRect(Math.round(cx - Math.max(1, 3 / z)), y, Math.max(1, Math.round(6 / z)), 1);
      }
    }
  }

  /** The buildings on both sides, the farthest first. */
  drawBuildings(m) {
    if (!this.sprites.length) return;
    const list = this.buildings.filter((b) => b.d > 0.9).sort((a, b) => b.d - a.d);
    for (const b of list) {
      const sprite = this.sprites[b.v],
        cell = ladderCell(sprite.meta, (sprite.meta.H * 1.6) / b.d);
      if (cell.h < 6) continue;
      const x = this.roadX(b.d) + (b.side * (ROAD_HALF_WIDTH + 40 + b.off)) / b.d,
        footY = this.horizonY + this.G / b.d;
      m.drawImage(
        sprite.img,
        cell.x,
        sprite.meta.H - cell.h,
        cell.w,
        cell.h,
        Math.round(b.side < 0 ? x - cell.w : x),
        Math.round(footY - cell.h),
        cell.w,
        cell.h,
      );
    }
  }
}

/** The cell of a sprite ladder (one picture in several sizes) whose height is nearest to `h`. */
export function ladderCell(meta, h) {
  let best = meta.sizes[0];
  for (const size of meta.sizes) if (Math.abs(size.h - h) < Math.abs(best.h - h)) best = size;
  return best;
}
