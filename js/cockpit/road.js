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
import { ladderCell } from "./pixel.js";

export const SPEED = 0.22; // z units per tick
export const ROAD_HALF_WIDTH = 110;
const COURSE = [0, 0, 1, 1, 0, 0, -1, -1, 0, 1, 0, 0, -1, 0];
const SEGMENT = 26; // z units per segment (about 4 s)
const Z_MAX = 64, // how far ahead the road is worked out, in z units
  DZ = 0.25; // the step of that table
const BUILDINGS = 28, // how many stand along the road at once
  BUILDING_GAP = 1.1; // the depth from one to the next

/** The curvature of the course at a travelled depth: it eases into the next segment in the last
 * 30% of each segment. */
export function curvatureAt(depth) {
  const index = Math.floor(depth / SEGMENT),
    within = depth / SEGMENT - index,
    here = COURSE[index % COURSE.length],
    next = COURSE[(index + 1) % COURSE.length];
  const progress = Math.max(0, Math.min(1, (within - 0.7) / 0.3)),
    eased = progress * progress * (3 - 2 * progress);
  return here + (next - here) * eased;
}

export class Road {
  /** `glass`: the see-through part of the cockpit picture, in world pixels. `buildingSprites`:
   * [{img, meta}], each a ladder of sizes (ladderCell in pixel.js). */
  constructor(glass, buildingSprites) {
    this.centerX = glass.x + glass.w / 2;
    this.horizonY = glass.y + Math.round(glass.h * 0.36);
    this.G = 56; // the camera's height above the ground
    this.sprites = buildingSprites;
    this.travel = 0;
    this.tilt = 0; // the cockpit's lean: the curvature where it is, -1 to 1, followed with a lag
    this.swayX = 0; // Elena's sideways sway, in pixels
    this.swayV = 0;
    // the road's lateral offset at each depth of the table
    this.offsets = new Float32Array(Math.ceil((Z_MAX - 1) / DZ) + 2);
    // each building: side (-1 left, 1 right), d (its depth z), v (which sprite), off (how far
    // it stands back from the road's edge: 40 and this, so 40 to 79, at z = 1)
    this.buildings = Array.from({ length: BUILDINGS }, (_, k) => ({
      side: k % 2 ? 1 : -1,
      d: 1.2 + k * BUILDING_GAP,
      v: k % Math.max(1, buildingSprites.length),
      off: (k * 37) % 40,
    }));
    this.buildTable();
  }

  /** Fill `offsets`: the road's lateral offset at each depth ahead, the curvature summed twice. */
  buildTable() {
    let offset = 0,
      slope = 0;
    for (let i = 0; i < this.offsets.length; i++) {
      this.offsets[i] = offset;
      const z = 1 + i * DZ;
      slope += 2.8 * curvatureAt(this.travel + z) * DZ;
      offset += slope * DZ;
    }
  }

  /** One tick of travel; `factor` scales the speed (1 while moving, 0 stands still). */
  move(factor = 1) {
    const step = SPEED * factor;
    this.travel += step;
    this.buildTable();
    const curve = curvatureAt(this.travel + 1); // the curvature where the cockpit is
    // standing still, it does not tilt
    this.tilt += (curve * Math.min(1, factor) - this.tilt) * 0.15;
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
    const place = Math.max(0, Math.min(this.offsets.length - 2, (z - 1) / DZ)),
      below = Math.floor(place),
      share = place - below;
    return (
      this.centerX +
      (this.offsets[below] * (1 - share) + this.offsets[below + 1] * share) / Math.max(1, z)
    );
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
  drawGround(ctx) {
    for (let y = this.horizonY + 1; y < 240; y++) {
      const z = this.G / (y - this.horizonY),
        center = this.roadX(z),
        halfWidth = ROAD_HALF_WIDTH / z,
        band = Math.floor((z + this.travel) * 1.2) % 2;
      ctx.fillStyle = band ? "#c4c4ca" : "#b8b8c0"; // light gray beside the road (ED D-138)
      ctx.fillRect(0, y, 426, 1); // sidewalk
      ctx.fillStyle = band ? "#5a5560" : "#524d58";
      ctx.fillRect(Math.round(center - halfWidth), y, Math.round(halfWidth * 2), 1); // asphalt
      const rumble = Math.max(1, Math.round(10 / z));
      ctx.fillStyle = band ? "#e8e4ee" : "#c33142"; // rumble strips
      ctx.fillRect(Math.round(center - halfWidth - rumble), y, rumble, 1);
      ctx.fillRect(Math.round(center + halfWidth), y, rumble, 1);
      if (band) {
        ctx.fillStyle = "#f4f1ff"; // center line
        ctx.fillRect(Math.round(center - Math.max(1, 3 / z)), y, Math.max(1, Math.round(6 / z)), 1);
      }
    }
  }

  /** The buildings on both sides, the farthest first. */
  drawBuildings(ctx) {
    if (!this.sprites.length) return;
    const list = this.buildings
      .filter((building) => building.d > 0.9)
      .sort((one, other) => other.d - one.d);
    for (const building of list) {
      const sprite = this.sprites[building.v],
        cell = ladderCell(sprite.meta, (sprite.meta.H * 1.6) / building.d);
      if (cell.h < 6) continue;
      const left =
          this.roadX(building.d) +
          (building.side * (ROAD_HALF_WIDTH + 40 + building.off)) / building.d,
        footY = this.horizonY + this.G / building.d;
      ctx.drawImage(
        sprite.img,
        cell.x,
        sprite.meta.H - cell.h,
        cell.w,
        cell.h,
        Math.round(building.side < 0 ? left - cell.w : left),
        Math.round(footY - cell.h),
        cell.w,
        cell.h,
      );
    }
  }
}
