import { createEffect, createSignal, Show } from "solid-js";
import { UsersRound } from "lucide-solid";
import { assetUrl } from "../lib/bridge";
import { hueFor, initials } from "../lib/format";

interface AvatarProps {
  name: string;
  path?: string;
  size?: number;
  group?: boolean;
  class?: string;
  onClick?: (event: MouseEvent) => void;
}

export function Avatar(props: AvatarProps) {
  const size = () => props.size ?? 44;
  const [loadError, setLoadError] = createSignal(false);

  createEffect(() => {
    // Reset load error if path changes
    props.path;
    setLoadError(false);
  });

  const imageUrl = () => (!loadError() && props.path ? assetUrl(props.path) : "");

  return (
    <div
      class={`avatar ${props.class ?? ""}`}
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        "min-width": `${size()}px`,
        "--avatar-hue": `${hueFor(props.name)}`,
        cursor: props.onClick ? "pointer" : undefined,
      }}
      aria-label={props.name}
      onClick={props.onClick}
    >
      <Show
        when={imageUrl()}
        fallback={
          <Show when={!props.group} fallback={<UsersRound size={size() * 0.48} />}>
            <span>{initials(props.name)}</span>
          </Show>
        }
      >
        <img
          src={imageUrl()}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setLoadError(true)}
        />
      </Show>
    </div>
  );
}
