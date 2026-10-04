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

// z units per tick
export const SPEED = 0.22;
export const ROAD_HALF_WIDTH = 110;
const COURSE = [0, 0, 1, 1, 0, 0, -1, -1, 0, 1, 0, 0, -1, 0];
// z units per segment (about 4 s)
const SEGMENT = 26;
// how far ahead the road is worked out, in z units
const Z_MAX = 64;
// the step of that table
const DZ = 0.25;
// how many stand along the road at once
const BUILDINGS = 28;
// the depth from one to the next
const BUILDING_GAP = 1.1;

/** The curvature of the course at a travelled depth: it eases into the next segment in the last
 * 30% of each segment. */
export function curvatureAt(depth) {
  const index = Math.floor(depth / SEGMENT);
  const within = depth / SEGMENT - index;

  const here = COURSE[index % COURSE.length];
  const nextIndex = (index + 1) % COURSE.length;
  const next = COURSE[nextIndex];

  const intoLastPart = (within - 0.7) / 0.3;
  const atMostOne = Math.min(1, intoLastPart);
  const progress = Math.max(0, atMostOne);
  const eased = progress * progress * (3 - 2 * progress);

  return here + (next - here) * eased;
}

export class Road {
  /** `glass`: the see-through part of the cockpit picture, in world pixels. `buildingSprites`:
   * [{img, meta}], each a ladder of sizes (ladderCell in pixel.js). */
  constructor(glass, buildingSprites) {
    this.centerX = glass.x + glass.w / 2;

    const horizonBelowGlassTop = Math.round(glass.h * 0.36);
    this.horizonY = glass.y + horizonBelowGlassTop;

    // the camera's height above the ground
    this.G = 56;
    this.sprites = buildingSprites;
    this.travel = 0;
    // the cockpit's lean: the curvature where it is, -1 to 1, followed with a lag
    this.tilt = 0;
    // Elena's sideways sway, in pixels
    this.swayX = 0;
    this.swayV = 0;

    // the road's lateral offset at each depth of the table
    const tableSteps = Math.ceil((Z_MAX - 1) / DZ);
    this.offsets = new Float32Array(tableSteps + 2);

    // each building: side (-1 left, 1 right), d (its depth z), v (which sprite), off (how far
    // it stands back from the road's edge: 40 and this, so 40 to 79, at z = 1)
    this.buildings = Array.from({ length: BUILDINGS }, (_, k) => {
      const side = k % 2 ? 1 : -1;
      const spriteCount = Math.max(1, buildingSprites.length);

      return {
        side,
        d: 1.2 + k * BUILDING_GAP,
        v: k % spriteCount,
        off: (k * 37) % 40,
      };
    });

    this.buildTable();
  }

  /** Fill `offsets`: the road's lateral offset at each depth ahead, the curvature summed twice. */
  buildTable() {
    let offset = 0;
    let slope = 0;

    for (let i = 0; i < this.offsets.length; i++) {
      this.offsets[i] = offset;

      const z = 1 + i * DZ;
      const curvature = curvatureAt(this.travel + z);
      slope += 2.8 * curvature * DZ;
      offset += slope * DZ;
    }
  }

  /** One tick of travel; `factor` scales the speed (1 while moving, 0 stands still). */
  move(factor = 1) {
    const step = SPEED * factor;
    this.travel += step;
    this.buildTable();

    // the curvature where the cockpit is
    const curve = curvatureAt(this.travel + 1);
    // standing still, it does not tilt
    const wantedTilt = curve * Math.min(1, factor);
    this.tilt += (wantedTilt - this.tilt) * 0.15;

    for (const building of this.buildings) {
      building.d -= step;

      if (building.d < 0.9) {
        building.d += BUILDINGS * BUILDING_GAP;

        const spriteCount = Math.max(1, this.sprites.length);
        building.v = (building.v + 3) % spriteCount;
      }
    }

    // Elena's sway: a damped spring pulled to the outside of the curve
    const pull = -this.tilt * 9 - this.swayX;
    this.swayV += pull * 0.06;
    this.swayV *= 0.86;
    this.swayX += this.swayV;
  }

  /** The screen x of the road's center at depth z. */
  roadX(z) {
    const lastPlace = this.offsets.length - 2;
    const wantedPlace = (z - 1) / DZ;
    const atMostLast = Math.min(lastPlace, wantedPlace);
    const place = Math.max(0, atMostLast);

    const below = Math.floor(place);
    const share = place - below;

    const partBelow = this.offsets[below] * (1 - share);
    const partAbove = this.offsets[below + 1] * share;
    const offsetAtGlass = partBelow + partAbove;

    const depth = Math.max(1, z);
    return this.centerX + offsetAtGlass / depth;
  }

  /** A point on the ground, X to the side of the road's center at depth z. */
  project(X, z) {
    const x = this.roadX(z) + X / z;
    const y = this.horizonY + this.G / z;
    return { x, y };
  }

  /** A point H above the ground. */
  project3(X, H, z) {
    const x = this.roadX(z) + X / z;
    const y = this.horizonY + (this.G - H) / z;
    return { x, y };
  }

  /** The road, row by row: alternating bands rush toward the glass. */
  drawGround(ctx) {
    for (let y = this.horizonY + 1; y < 240; y++) {
      const z = this.G / (y - this.horizonY);
      const center = this.roadX(z);
      const halfWidth = ROAD_HALF_WIDTH / z;
      const band = Math.floor((z + this.travel) * 1.2) % 2;

      // sidewalk: light gray beside the road (ED D-138)
      ctx.fillStyle = band ? "#c4c4ca" : "#b8b8c0";
      ctx.fillRect(0, y, 426, 1);

      // asphalt
      const asphaltLeft = Math.round(center - halfWidth);
      const asphaltWidth = Math.round(halfWidth * 2);
      ctx.fillStyle = band ? "#5a5560" : "#524d58";
      ctx.fillRect(asphaltLeft, y, asphaltWidth, 1);

      // rumble strips
      const rumble = Math.max(1, Math.round(10 / z));
      const leftStripLeft = Math.round(center - halfWidth - rumble);
      const rightStripLeft = Math.round(center + halfWidth);
      ctx.fillStyle = band ? "#e8e4ee" : "#c33142";
      ctx.fillRect(leftStripLeft, y, rumble, 1);
      ctx.fillRect(rightStripLeft, y, rumble, 1);

      if (band) {
        // center line
        const lineHalfWidth = Math.max(1, 3 / z);
        const lineLeft = Math.round(center - lineHalfWidth);
        const lineWidth = Math.max(1, Math.round(6 / z));
        ctx.fillStyle = "#f4f1ff";
        ctx.fillRect(lineLeft, y, lineWidth, 1);
      }
    }
  }

  /** The buildings on both sides, the farthest first. */
  drawBuildings(ctx) {
    if (!this.sprites.length) {
      return;
    }

    const list = this.buildings.filter((building) => building.d > 0.9);
    list.sort((one, other) => other.d - one.d);

    for (const building of list) {
      const sprite = this.sprites[building.v];
      const wantedHeight = (sprite.meta.H * 1.6) / building.d;
      const cell = ladderCell(sprite.meta, wantedHeight);
      if (cell.h < 6) {
        continue;
      }

      const besideRoad = ROAD_HALF_WIDTH + 40 + building.off;
      const besideRoadOnScreen = (building.side * besideRoad) / building.d;
      const left = this.roadX(building.d) + besideRoadOnScreen;
      const footY = this.horizonY + this.G / building.d;

      // a building on the left stands with its right edge at that place
      let drawLeft = left;
      if (building.side < 0) {
        drawLeft = left - cell.w;
      }

      const sheetTop = sprite.meta.H - cell.h;
      const screenLeft = Math.round(drawLeft);
      const screenTop = Math.round(footY - cell.h);
      ctx.drawImage(
        sprite.img,
        cell.x,
        sheetTop,
        cell.w,
        cell.h,
        screenLeft,
        screenTop,
        cell.w,
        cell.h,
      );
    }
  }
}
