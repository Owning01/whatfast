import assert from "node:assert/strict";
import test from "node:test";
import {
  cropInRotatedSpace,
  cropTransformForCanvas,
  defaultCrop,
  isValidCrop,
  normalizeCropRect,
  parseRotation,
  planEdit,
  rotationAfterRotate,
  rotatedSize,
  scaleRect,
} from "../src/lib/media-crop.ts";
import type { CropRect, PixelSize, Rotation } from "../src/lib/media-crop.ts";

const SOURCE: PixelSize = { width: 200, height: 100 };
const RECT: CropRect = { x: 20, y: 10, width: 40, height: 30 };

/** Inverse of the clockwise rotation, used to check the round trip. */
function unrotatePoint(
  x: number,
  y: number,
  source: PixelSize,
  rotation: Rotation,
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: y, y: source.height - x };
    case 180:
      return { x: source.width - x, y: source.height - y };
    case 270:
      return { x: source.width - y, y: x };
    case 0:
    default:
      return { x, y };
  }
}

function corners(rect: CropRect): Array<[number, number]> {
  return [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ];
}

test("a reversed drag becomes a positive rectangle anchored at the dragged corner", () => {
  assert.deepEqual(
    normalizeCropRect({ x: 80, y: 60, width: -40, height: -30 }, SOURCE),
    { x: 40, y: 30, width: 40, height: 30 },
  );
  assert.deepEqual(
    normalizeCropRect({ x: 60, y: 40, width: -40, height: 30 }, SOURCE),
    { x: 20, y: 40, width: 40, height: 30 },
  );
});

test("a rectangle that leaves the source is clamped to its bounds", () => {
  assert.deepEqual(
    normalizeCropRect({ x: 180, y: 90, width: 100, height: 100 }, SOURCE),
    { x: 180, y: 90, width: 20, height: 10 },
  );
  assert.deepEqual(
    normalizeCropRect({ x: -10, y: -10, width: 30, height: 30 }, SOURCE),
    { x: 0, y: 0, width: 30, height: 30 },
  );
});

test("a rectangle entirely outside the source collapses to one pixel at the origin", () => {
  assert.deepEqual(
    normalizeCropRect({ x: 500, y: 0, width: 10, height: 10 }, SOURCE),
    { x: 0, y: 0, width: 1, height: 1 },
  );
  assert.deepEqual(
    normalizeCropRect({ x: -50, y: 0, width: 10, height: 10 }, SOURCE),
    { x: 0, y: 0, width: 1, height: 1 },
  );
  assert.deepEqual(
    normalizeCropRect({ x: 0, y: 500, width: 10, height: 10 }, SOURCE),
    { x: 0, y: 0, width: 1, height: 1 },
  );
});

test("a crop never covers less than one pixel", () => {
  assert.deepEqual(
    normalizeCropRect({ x: 10, y: 10, width: 0, height: 0 }, SOURCE),
    { x: 10, y: 10, width: 1, height: 1 },
  );
  assert.deepEqual(
    normalizeCropRect({ x: 199, y: 99, width: 0, height: 0 }, SOURCE),
    { x: 199, y: 99, width: 1, height: 1 },
  );
});

test("non-finite rectangle components never leak into the result", () => {
  const broken = normalizeCropRect(
    { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: Number.NaN, height: Number.NEGATIVE_INFINITY },
    SOURCE,
  );
  assert.deepEqual(broken, { x: 0, y: 0, width: 1, height: 1 });
  for (const value of [broken.x, broken.y, broken.width, broken.height]) {
    assert.ok(Number.isFinite(value));
  }
  assert.deepEqual(
    normalizeCropRect({ x: Number.NaN, y: 10, width: 20, height: 20 }, SOURCE),
    { x: 0, y: 10, width: 20, height: 20 },
  );
});

test("a broken source size is a programming error", () => {
  for (const size of [
    { width: -1, height: 10 },
    { width: 10, height: -1 },
    { width: Number.NaN, height: 10 },
    { width: 10, height: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => normalizeCropRect(RECT, size), RangeError);
    assert.throws(() => rotatedSize(size, 90), RangeError);
    assert.throws(() => cropInRotatedSpace(RECT, size, 90), RangeError);
    assert.throws(() => planEdit(size, RECT, 90), RangeError);
    assert.throws(() => defaultCrop(size), RangeError);
    assert.throws(() => scaleRect(RECT, size, SOURCE), RangeError);
    assert.throws(() => scaleRect(RECT, SOURCE, size), RangeError);
    assert.throws(() => cropTransformForCanvas(RECT, size), RangeError);
    assert.throws(() => isValidCrop(RECT, size), RangeError);
  }
});

test("rotating by a quarter turn swaps the image dimensions", () => {
  assert.deepEqual(rotatedSize(SOURCE, 0), { width: 200, height: 100 });
  assert.deepEqual(rotatedSize(SOURCE, 180), { width: 200, height: 100 });
  assert.deepEqual(rotatedSize(SOURCE, 90), { width: 100, height: 200 });
  assert.deepEqual(rotatedSize(SOURCE, 270), { width: 100, height: 200 });
});

test("the same crop maps to the four expected rectangles in the rotated space", () => {
  assert.deepEqual(cropInRotatedSpace(RECT, SOURCE, 0), {
    x: 20,
    y: 10,
    width: 40,
    height: 30,
  });
  assert.deepEqual(cropInRotatedSpace(RECT, SOURCE, 90), {
    x: 60,
    y: 20,
    width: 30,
    height: 40,
  });
  assert.deepEqual(cropInRotatedSpace(RECT, SOURCE, 180), {
    x: 140,
    y: 60,
    width: 40,
    height: 30,
  });
  assert.deepEqual(cropInRotatedSpace(RECT, SOURCE, 270), {
    x: 10,
    y: 140,
    width: 30,
    height: 40,
  });
});

test("the rotated crop stays inside the rotated canvas for every angle", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const canvas = rotatedSize(SOURCE, rotation);
    const crop = cropInRotatedSpace(RECT, SOURCE, rotation);
    assert.ok(crop.x >= 0, `x of ${rotation}`);
    assert.ok(crop.y >= 0, `y of ${rotation}`);
    assert.ok(crop.x + crop.width <= canvas.width, `width of ${rotation}`);
    assert.ok(crop.y + crop.height <= canvas.height, `height of ${rotation}`);
    assert.ok(crop.width >= 1 && crop.height >= 1);
  }
});

test("a quarter turn is the bounding box of the four rotated corners", () => {
  const rect: CropRect = { x: 20, y: 10, width: 40, height: 30 };
  const crop = cropInRotatedSpace(rect, SOURCE, 90);
  const mapped = corners(rect).map(([x, y]) => ({
    x: SOURCE.height - y,
    y: x,
  }));
  const minX = Math.min(...mapped.map((point) => point.x));
  const maxX = Math.max(...mapped.map((point) => point.x));
  const minY = Math.min(...mapped.map((point) => point.y));
  const maxY = Math.max(...mapped.map((point) => point.y));
  assert.deepEqual(crop, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  for (const point of mapped) {
    assert.ok(point.x >= crop.x);
    assert.ok(point.x <= crop.x + crop.width);
    assert.ok(point.y >= crop.y);
    assert.ok(point.y <= crop.y + crop.height);
  }
});

test("rotating a crop and rotating it back returns the original rectangle", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const crop = cropInRotatedSpace(RECT, SOURCE, rotation);
    for (const [x, y] of corners(crop)) {
      const back = unrotatePoint(x, y, SOURCE, rotation);
      assert.ok(back.x >= RECT.x, `x of ${rotation}`);
      assert.ok(back.x <= RECT.x + RECT.width, `x of ${rotation}`);
      assert.ok(back.y >= RECT.y, `y of ${rotation}`);
      assert.ok(back.y <= RECT.y + RECT.height, `y of ${rotation}`);
    }
  }
});

test("the plan outputs the size of the rotated crop", () => {
  const plan0 = planEdit(SOURCE, RECT, 0);
  assert.deepEqual(plan0.rotation, 0);
  assert.deepEqual(plan0.output, { width: 40, height: 30 });
  assert.deepEqual(plan0.crop, { x: 20, y: 10, width: 40, height: 30 });

  const plan90 = planEdit(SOURCE, RECT, 90);
  assert.deepEqual(plan90.rotation, 90);
  assert.deepEqual(plan90.output, { width: 30, height: 40 });
  assert.deepEqual(plan90.crop, { x: 60, y: 20, width: 30, height: 40 });

  const plan180 = planEdit(SOURCE, RECT, 180);
  assert.deepEqual(plan180.output, { width: 40, height: 30 });

  const plan270 = planEdit(SOURCE, RECT, 270);
  assert.deepEqual(plan270.output, { width: 30, height: 40 });
});

test("a plan over the whole image outputs the whole rotated image", () => {
  const whole = defaultCrop(SOURCE);
  assert.deepEqual(whole, { x: 0, y: 0, width: 200, height: 100 });
  const plan90 = planEdit(SOURCE, whole, 90);
  assert.deepEqual(plan90.crop, { x: 0, y: 0, width: 100, height: 200 });
  assert.deepEqual(plan90.output, { width: 100, height: 200 });
  assert.deepEqual(rotatedSize(SOURCE, 90), plan90.output);
});

test("a plan normalises the requested crop before rotating it", () => {
  const plan = planEdit(SOURCE, { x: 180, y: 90, width: 100, height: 100 }, 90);
  assert.deepEqual(plan.crop, { x: 0, y: 180, width: 10, height: 20 });
  assert.deepEqual(plan.output, { width: 10, height: 20 });
});

test("a scaled crop survives the trip back to the original image", () => {
  const original: PixelSize = { width: 400, height: 300 };
  const preview: PixelSize = { width: 100, height: 75 };
  const drawn: CropRect = { x: 40, y: 60, width: 100, height: 60 };

  const onPreview = scaleRect(drawn, original, preview);
  assert.deepEqual(onPreview, { x: 10, y: 15, width: 25, height: 15 });

  const backToOriginal = scaleRect(onPreview, preview, original);
  assert.deepEqual(backToOriginal, drawn);
});

test("a scaled crop is clamped to the target size", () => {
  const scaled = scaleRect(
    { x: 95, y: 95, width: 10, height: 10 },
    { width: 100, height: 100 },
    { width: 200, height: 200 },
  );
  assert.deepEqual(scaled, { x: 190, y: 190, width: 10, height: 10 });
  assert.ok(isValidCrop(scaled, { width: 200, height: 200 }));
});

test("the canvas transform offsets the crop and scales it onto the canvas", () => {
  const transform = cropTransformForCanvas(RECT, { width: 400, height: 300 });
  assert.equal(transform.x, -20);
  assert.equal(transform.y, -10);
  assert.equal(transform.width, 10);
  assert.equal(transform.height, 10);

  const uneven = cropTransformForCanvas({ x: 0, y: 0, width: 30, height: 30 }, { width: 100, height: 100 });
  assert.equal(uneven.x, 0);
  assert.equal(uneven.y, 0);
  assert.ok(Math.abs(uneven.width - 100 / 30) < 1e-9);
  assert.ok(Math.abs(uneven.height - 100 / 30) < 1e-9);
});

test("only a crop that fits the source is valid", () => {
  assert.equal(isValidCrop(RECT, SOURCE), true);
  assert.equal(isValidCrop({ x: 0, y: 0, width: 200, height: 100 }, SOURCE), true);
  assert.equal(isValidCrop({ x: 1, y: 0, width: 200, height: 100 }, SOURCE), false);
  assert.equal(isValidCrop({ x: 0, y: 1, width: 200, height: 100 }, SOURCE), false);
  assert.equal(isValidCrop({ x: 0, y: 0, width: 0, height: 10 }, SOURCE), false);
  assert.equal(isValidCrop({ x: 0, y: 0, width: 10, height: 0 }, SOURCE), false);
  assert.equal(isValidCrop({ x: -1, y: 0, width: 10, height: 10 }, SOURCE), false);
  assert.equal(isValidCrop({ x: Number.NaN, y: 0, width: 10, height: 10 }, SOURCE), false);
});

test("rotating advances a quarter turn clockwise", () => {
  assert.equal(rotationAfterRotate(0), 90);
  assert.equal(rotationAfterRotate(90), 180);
  assert.equal(rotationAfterRotate(180), 270);
  assert.equal(rotationAfterRotate(270), 0);
});

test("any number of degrees parses into the nearest quarter turn", () => {
  assert.equal(parseRotation(0), 0);
  assert.equal(parseRotation(45), 90);
  assert.equal(parseRotation(90), 90);
  assert.equal(parseRotation(-45), 0);
  assert.equal(parseRotation(-90), 270);
  assert.equal(parseRotation(180), 180);
  assert.equal(parseRotation(270), 270);
  assert.equal(parseRotation(360), 0);
  assert.equal(parseRotation(-360), 0);
  assert.equal(parseRotation(720), 0);
  assert.equal(parseRotation(400), 0);
  assert.equal(parseRotation(Number.NaN), 0);
  assert.equal(parseRotation(Number.POSITIVE_INFINITY), 0);
});
