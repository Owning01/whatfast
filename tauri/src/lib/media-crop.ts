/**
 * Geometry for the image editor: crop rectangle, rotation and preview transform.
 *
 * Coordinate spaces
 * -----------------
 * - SOURCE space: the pixels of the original image. The origin is the top-left
 *   corner, `x` grows to the right and `y` grows downwards.
 * - ROTATED space: the pixels of the whole source image AFTER the requested
 *   rotation has been applied. Every crop rectangle that leaves this module
 *   through `EditPlan.crop` is expressed in this space, and the Rust side must
 *   crop the rotated image with it (rotate first, crop second).
 *
 * Rotation convention
 * --------------------
 * All rotations are CLOCKWISE, and the rotated canvas is the source image
 * rotated around its own centre. A source point `(x, y)` maps to:
 *
 *   -   0 degrees -> `(x, y)`                  canvas stays `width x height`
 *   -  90 degrees -> `(height - y, x)`         canvas becomes `height x width`
 *   - 180 degrees -> `(width - x, height - y)` canvas stays `width x height`
 *   - 270 degrees -> `(y, width - x)`          canvas becomes `height x width`
 *
 * The Rust side must use the same convention. A pixel `(x, y)` of the rotated
 * image therefore reads the source pixel `(y, width - 1 - x)` for 90 degrees.
 *
 * Rounding rule
 * -------------
 * Every pixel coordinate is rounded exactly once with `Math.round` (halves go
 * up, towards +infinity). The order is: interpret the drag in float pixels
 * (a negative width or height means the drag went up or left and moves the
 * origin), round to whole pixels, then clamp into the source bounds. The
 * result of every function that returns pixels is therefore an integer and
 * never `NaN` or `Infinity`. The only fractional numbers the module produces
 * are the preview scale factors of `cropTransformForCanvas`.
 */

/** Size of a bitmap in pixels. */
export interface PixelSize {
  width: number;
  height: number;
}

/** An axis-aligned rectangle in pixels. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A clockwise rotation in degrees. */
export type Rotation = 0 | 90 | 180 | 270;

/** The full description of one edit, ready to be handed to the Rust side. */
export interface EditPlan {
  rotation: Rotation;
  /** The crop rectangle, expressed in the ROTATED coordinate space. */
  crop: CropRect;
  /** Size of the produced image, in pixels. */
  output: PixelSize;
}

/** The four clockwise steps, in order. */
export const ROTATION_ANGLES: readonly Rotation[] = [0, 90, 180, 270];

const FALLBACK_RECT: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/** Maps a plain number onto the four quarter turns, without a type assertion. */
function toRotation(value: number): Rotation {
  for (const angle of ROTATION_ANGLES) {
    if (angle === value) {
      return angle;
    }
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/** Negates without producing negative zero. */
function negate(value: number): number {
  return value === 0 ? 0 : -value;
}

/**
 * Rounds to a whole pixel. Non-finite input becomes 0 and negative zero is
 * normalised to positive zero so the result is always a plain integer.
 */
function integral(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

/**
 * A source size is a programming error when it is not finite or negative:
 * unlike a crop rectangle there is nothing sensible to clamp it to.
 */
function assertSourceSize(size: PixelSize, label: string): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    throw new RangeError(
      `${label} size must be finite, received ${String(size.width)}x${String(size.height)}`,
    );
  }
  if (size.width < 0 || size.height < 0) {
    throw new RangeError(
      `${label} size must not be negative, received ${size.width}x${size.height}`,
    );
  }
}

function rotatePoint(
  pointX: number,
  pointY: number,
  source: PixelSize,
  rotation: Rotation,
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: source.height - pointY, y: pointX };
    case 180:
      return { x: source.width - pointX, y: source.height - pointY };
    case 270:
      return { x: pointY, y: source.width - pointX };
    case 0:
    default:
      return { x: pointX, y: pointY };
  }
}

/**
 * Clamps a crop rectangle into the source image.
 *
 * A negative width or height means the drag went left or up: the origin moves
 * with it. The rectangle is then rounded to whole pixels and clamped to the
 * source bounds with a minimum of 1x1. A rectangle that lies completely
 * outside the source collapses to a 1x1 rectangle at the source origin.
 * Non-finite components are treated as 0 instead of throwing.
 */
export function normalizeCropRect(rect: CropRect, source: PixelSize): CropRect {
  assertSourceSize(source, "source");

  const sourceWidth = integral(source.width);
  const sourceHeight = integral(source.height);

  let x = Number.isFinite(rect.x) ? rect.x : 0;
  let y = Number.isFinite(rect.y) ? rect.y : 0;
  let width = Number.isFinite(rect.width) ? rect.width : 0;
  let height = Number.isFinite(rect.height) ? rect.height : 0;

  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }

  const outside =
    x >= sourceWidth ||
    x + width <= 0 ||
    y >= sourceHeight ||
    y + height <= 0;
  if (outside) {
    return { ...FALLBACK_RECT };
  }

  const originX = clamp(integral(x), 0, Math.max(0, sourceWidth - 1));
  const originY = clamp(integral(y), 0, Math.max(0, sourceHeight - 1));

  return {
    x: originX,
    y: originY,
    width: clamp(integral(width), 1, Math.max(1, sourceWidth - originX)),
    height: clamp(integral(height), 1, Math.max(1, sourceHeight - originY)),
  };
}

/**
 * The size of the image after the rotation is applied. 90 and 270 degrees
 * swap the width and the height.
 */
export function rotatedSize(size: PixelSize, rotation: Rotation): PixelSize {
  assertSourceSize(size, "source");
  if (rotation === 90 || rotation === 270) {
    return { width: size.height, height: size.width };
  }
  return { width: size.width, height: size.height };
}

/**
 * Converts a crop rectangle from the SOURCE space into the ROTATED space.
 *
 * The rectangle is normalised first, then its four corners are rotated and the
 * bounding box of the rotated corners is returned. Because the bounding box
 * is taken from the corners, the result is correct for any rectangle and not
 * only for one anchored at the origin. The result always stays inside the
 * rotated canvas.
 */
export function cropInRotatedSpace(
  rect: CropRect,
  source: PixelSize,
  rotation: Rotation,
): CropRect {
  assertSourceSize(source, "source");
  const normalized = normalizeCropRect(rect, source);

  const right = normalized.x + normalized.width;
  const bottom = normalized.y + normalized.height;
  const corners: ReadonlyArray<readonly [number, number]> = [
    [normalized.x, normalized.y],
    [right, normalized.y],
    [normalized.x, bottom],
    [right, bottom],
  ];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [cornerX, cornerY] of corners) {
    const rotated = rotatePoint(cornerX, cornerY, source, rotation);
    minX = Math.min(minX, rotated.x);
    minY = Math.min(minY, rotated.y);
    maxX = Math.max(maxX, rotated.x);
    maxY = Math.max(maxY, rotated.y);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Builds the edit plan for one image: the requested crop is normalised in the
 * SOURCE space, moved into the ROTATED space and the output size is the size
 * of that rotated crop. The Rust side rotates the whole image first and
 * crops it afterwards with `plan.crop`.
 */
export function planEdit(
  source: PixelSize,
  requestedCrop: CropRect,
  rotation: Rotation,
): EditPlan {
  assertSourceSize(source, "source");
  const normalized = normalizeCropRect(requestedCrop, source);
  const crop = cropInRotatedSpace(normalized, source, rotation);
  return {
    rotation,
    crop,
    output: { width: crop.width, height: crop.height },
  };
}

/** The crop that keeps the whole image. */
export function defaultCrop(source: PixelSize): CropRect {
  assertSourceSize(source, "source");
  return {
    x: 0,
    y: 0,
    width: integral(source.width),
    height: integral(source.height),
  };
}

/**
 * Maps a rectangle from one pixel space into another one. It is used to take
 * the crop the user drew on a scaled down preview back to the original image.
 * The result is rounded to whole pixels and clamped to the target size.
 */
export function scaleRect(rect: CropRect, from: PixelSize, to: PixelSize): CropRect {
  assertSourceSize(from, "source");
  assertSourceSize(to, "target");

  const normalized = normalizeCropRect(rect, from);
  const factorX = from.width > 0 ? to.width / from.width : 0;
  const factorY = from.height > 0 ? to.height / from.height : 0;

  const scaled: CropRect = {
    x: integral(normalized.x * factorX),
    y: integral(normalized.y * factorY),
    width: integral(normalized.width * factorX),
    height: integral(normalized.height * factorY),
  };
  return normalizeCropRect(scaled, to);
}

/**
 * The CSS transform that makes a preview show exactly the cropped region.
 *
 * `x` and `y` are the negative offsets in canvas pixels: the rectangle is
 * expected to live in the pixel space of the canvas. `width` and `height` are
 * the scale factors that map the crop onto the canvas, one per axis.
 *
 * Apply it as `transform: scale(width, height) translate(x px, y px)` so the
 * translation is expressed in canvas pixels (the space before the scale) and
 * the crop lands on the top left corner of the canvas.
 */
export function cropTransformForCanvas(
  rect: CropRect,
  canvas: PixelSize,
): { x: number; y: number; width: number; height: number } {
  assertSourceSize(canvas, "canvas");
  const normalized = normalizeCropRect(rect, canvas);
  return {
    x: negate(normalized.x),
    y: negate(normalized.y),
    width: normalized.width > 0 ? canvas.width / normalized.width : 1,
    height: normalized.height > 0 ? canvas.height / normalized.height : 1,
  };
}

/**
 * True when the rectangle is fully inside the source image and covers at
 * least one pixel.
 */
export function isValidCrop(rect: CropRect, source: PixelSize): boolean {
  assertSourceSize(source, "source");
  const { x, y, width, height } = rect;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return false;
  }
  if (width < 1 || height < 1) {
    return false;
  }
  if (x < 0 || y < 0) {
    return false;
  }
  return x + width <= source.width && y + height <= source.height;
}

/** Advances the rotation one step clockwise: 0 -> 90 -> 180 -> 270 -> 0. */
export function rotationAfterRotate(rotation: Rotation): Rotation {
  return toRotation((rotation + 90) % 360);
}

/**
 * Normalises any number of degrees into the nearest quarter turn. Ties go
 * clockwise (45 becomes 90, -45 becomes 0) and non-finite input becomes 0.
 */
export function parseRotation(degrees: number): Rotation {
  if (!Number.isFinite(degrees)) {
    return 0;
  }
  const steps = Math.round(degrees / 90);
  return toRotation(((steps * 90) % 360 + 360) % 360);
}
