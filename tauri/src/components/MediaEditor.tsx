import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Check, Crop, RotateCcw, RotateCw, X } from "lucide-solid";

import { assetUrl, editImage } from "../lib/bridge";
import { t } from "../lib/i18n";
import {
  rotatedSize,
  scaleRect,
  type CropRect,
  type PixelSize,
  type Rotation,
} from "../lib/media-crop";
import type { StagedMedia } from "../lib/types";
import "../media-editor.css";

/** Longest edge of the preview, in CSS pixels. */
const PREVIEW_EDGE = 460;
/** Smallest crop the user can leave behind, in preview pixels. */
const MIN_CROP_EDGE = 24;

type DragMode = "create" | "move" | "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: DragMode;
  originX: number;
  originY: number;
  start: CropRect;
}

/**
 * Crop and rotate a picture before it is sent.
 *
 * The preview shows the picture already rotated, and the crop rectangle is
 * kept in preview pixels. On confirm the rectangle is mapped back to the
 * pixels of the rotated picture, which is exactly the space the desktop core
 * crops in.
 */
export function MediaEditor(props: {
  source: string;
  fileName: string;
  onCancel: () => void;
  onConfirm: (staged: StagedMedia) => void;
  onError: (message: string) => void;
}) {
  const [natural, setNatural] = createSignal<PixelSize>({ width: 0, height: 0 });
  const [rotation, setRotation] = createSignal<Rotation>(0);
  const [crop, setCrop] = createSignal<CropRect | null>(null);
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [working, setWorking] = createSignal(false);
  let surface: HTMLDivElement | undefined;

  const previewScale = createMemo(() => {
    const size = natural();
    if (size.width <= 0 || size.height <= 0) return 0;
    return Math.min(1, PREVIEW_EDGE / Math.max(size.width, size.height));
  });

  /** Size of the unrotated picture as it is drawn inside the preview box. */
  const drawnSize = createMemo<PixelSize>(() => {
    const size = natural();
    const scale = previewScale();
    return { width: size.width * scale, height: size.height * scale };
  });

  /** Size of the preview box, which shows the rotated picture. */
  const boxSize = createMemo<PixelSize>(() => rotatedSize(drawnSize(), rotation()));

  const cropRect = createMemo<CropRect>(() => {
    const box = boxSize();
    const current = crop();
    if (current) return current;
    return { x: 0, y: 0, width: box.width, height: box.height };
  });

  function pointFromEvent(event: PointerEvent): { x: number; y: number } {
    const bounds = surface?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(0, event.clientX - bounds.left), bounds.width),
      y: Math.min(Math.max(0, event.clientY - bounds.top), bounds.height),
    };
  }

  function beginDrag(mode: DragMode, event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    surface?.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    setDrag({ mode, originX: point.x, originY: point.y, start: cropRect() });
  }

  function moveDrag(event: PointerEvent) {
    const state = drag();
    if (!state) return;
    const point = pointFromEvent(event);
    const box = boxSize();
    if (state.mode === "create") {
      const x = Math.min(state.originX, point.x);
      const y = Math.min(state.originY, point.y);
      const width = Math.abs(point.x - state.originX);
      const height = Math.abs(point.y - state.originY);
      setCrop({ x, y, width, height });
      return;
    }
    if (state.mode === "move") {
      const dx = point.x - state.originX;
      const dy = point.y - state.originY;
      const width = Math.min(state.start.width, box.width);
      const height = Math.min(state.start.height, box.height);
      const x = Math.min(Math.max(0, state.start.x + dx), Math.max(0, box.width - width));
      const y = Math.min(Math.max(0, state.start.y + dy), Math.max(0, box.height - height));
      setCrop({ x, y, width, height });
      return;
    }
    const start = state.start;
    const right = start.x + start.width;
    const bottom = start.y + start.height;
    let x = start.x;
    let y = start.y;
    let width = start.width;
    let height = start.height;
    if (state.mode === "nw" || state.mode === "sw") {
      x = Math.min(point.x, right - MIN_CROP_EDGE);
      width = right - x;
    } else {
      width = Math.min(Math.max(point.x - start.x, MIN_CROP_EDGE), box.width - start.x);
    }
    if (state.mode === "nw" || state.mode === "ne") {
      y = Math.min(point.y, bottom - MIN_CROP_EDGE);
      height = bottom - y;
    } else {
      height = Math.min(Math.max(point.y - start.y, MIN_CROP_EDGE), box.height - start.y);
    }
    setCrop({ x: Math.max(0, x), y: Math.max(0, y), width, height });
  }

  function endDrag(event: PointerEvent) {
    if (drag()) {
      surface?.releasePointerCapture(event.pointerId);
      setDrag(null);
      const box = boxSize();
      const current = cropRect();
      const width = Math.min(Math.max(current.width, MIN_CROP_EDGE), box.width);
      const height = Math.min(Math.max(current.height, MIN_CROP_EDGE), box.height);
      setCrop({ x: Math.min(current.x, box.width - width), y: Math.min(current.y, box.height - height), width, height });
    }
  }

  function rotate(steps: number) {
    const next = (((rotation() + steps) % 360) + 360) % 360;
    const current = crop();
    if (current) {
      // The crop travels with the picture: a clockwise quarter turn maps the
      // normalised rectangle onto its rotated counterpart.
      const box = boxSize();
      const fx = current.x / box.width;
      const fy = current.y / box.height;
      const fw = current.width / box.width;
      const fh = current.height / box.height;
      const rotatedBox = rotatedSize(box, next as Rotation);
      let nx = fx;
      let ny = fy;
      let nw = fw;
      let nh = fh;
      if (next === 90) {
        nx = 1 - fy - fh;
        ny = fx;
        nw = fh;
        nh = fw;
      } else if (next === 180) {
        nx = 1 - fx - fw;
        ny = 1 - fy - fh;
      } else if (next === 270) {
        nx = fy;
        ny = 1 - fx - fw;
        nw = fh;
        nh = fw;
      }
      setCrop({
        x: nx * rotatedBox.width,
        y: ny * rotatedBox.height,
        width: nw * rotatedBox.width,
        height: nh * rotatedBox.height,
      });
    }
    setRotation(next as Rotation);
  }

  async function confirm() {
    if (working()) return;
    const size = natural();
    if (size.width <= 0 || size.height <= 0) {
      props.onError(t("mediaEditor.error"));
      return;
    }
    setWorking(true);
    try {
      const rotatedNatural = rotatedSize(size, rotation());
      const mapped = scaleRect(cropRect(), boxSize(), rotatedNatural);
      const staged = await editImage({
        path: props.source,
        rotation: rotation(),
        cropX: mapped.x,
        cropY: mapped.y,
        cropWidth: mapped.width,
        cropHeight: mapped.height,
      });
      props.onConfirm(staged);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : t("mediaEditor.error"));
    } finally {
      setWorking(false);
    }
  }

  const handles = [
    { mode: "nw" as DragMode, style: { left: "0", top: "0", cursor: "nwse-resize" } },
    { mode: "ne" as DragMode, style: { right: "0", top: "0", cursor: "nesw-resize" } },
    { mode: "sw" as DragMode, style: { left: "0", bottom: "0", cursor: "nesw-resize" } },
    { mode: "se" as DragMode, style: { right: "0", bottom: "0", cursor: "nwse-resize" } },
  ];

  return (
    <Portal>
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="media-editor-title">
        <div class="dialog-card media-editor">
          <div class="forward-dialog-heading">
            <Crop size={22} />
            <h2 id="media-editor-title">{t("mediaEditor.title")}</h2>
            <button
              type="button"
              class="media-editor-close"
              aria-label={t("mediaEditor.cancel")}
              onClick={() => props.onCancel()}
            >
              <X size={19} />
            </button>
          </div>
          <p class="media-editor-file" title={props.fileName}>
            {props.fileName}
          </p>
          <div class="media-editor-stage">
            <div
              ref={surface}
              class="media-editor-surface"
              style={{ width: `${boxSize().width}px`, height: `${boxSize().height}px` }}
              onPointerDown={(event) => beginDrag("create", event)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <img
                class="media-editor-image"
                src={assetUrl(props.source)}
                alt=""
                draggable={false}
                style={{
                  width: `${drawnSize().width}px`,
                  height: `${drawnSize().height}px`,
                  transform: `translate(-50%, -50%) rotate(${rotation()}deg)`,
                }}
                onLoad={(event) =>
                  setNatural({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
              <div
                class="media-editor-crop"
                style={{
                  left: `${cropRect().x}px`,
                  top: `${cropRect().y}px`,
                  width: `${cropRect().width}px`,
                  height: `${cropRect().height}px`,
                }}
                onPointerDown={(event) => beginDrag("move", event)}
              >
                <For each={handles}>
                  {(handle) => (
                    <span
                      class="media-editor-handle"
                      style={handle.style}
                      onPointerDown={(event) => beginDrag(handle.mode, event)}
                    />
                  )}
                </For>
              </div>
            </div>
          </div>
          <p class="media-editor-hint">{t("mediaEditor.hint")}</p>
          <div class="media-editor-toolbar">
            <button type="button" class="secondary-button" onClick={() => rotate(270)}>
              <RotateCcw size={18} />
              <span>{t("mediaEditor.rotateLeft")}</span>
            </button>
            <button type="button" class="secondary-button" onClick={() => rotate(90)}>
              <RotateCw size={18} />
              <span>{t("mediaEditor.rotateRight")}</span>
            </button>
            <button type="button" class="secondary-button" onClick={() => setCrop(null)}>
              <Crop size={18} />
              <span>{t("mediaEditor.reset")}</span>
            </button>
          </div>
          <div class="dialog-actions">
            <button type="button" class="secondary-button" disabled={working()} onClick={() => props.onCancel()}>
              {t("mediaEditor.cancel")}
            </button>
            <button type="button" class="primary-button" disabled={working()} onClick={() => void confirm()}>
              <Show when={working()} fallback={<><Check size={18} />{t("mediaEditor.send")}</>}>
                {t("mediaEditor.working")}
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
