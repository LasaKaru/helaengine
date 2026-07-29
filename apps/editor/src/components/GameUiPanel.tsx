import { useCallback, useEffect, useState } from 'react';
import { THEME_PRESETS } from '@helaengine/engine';
import {
  HudElementSchema,
  UiActionSchema,
  type HudElement,
  type UiAction,
  type UiButton,
  type UiTheme,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import {
  deleteUiAsset,
  listUiAssets,
  saveUiAsset,
  UiAssetError,
  uiAssetUrl,
} from '../storage/uiAssets';
import type { StoredUiAsset } from '../storage/db';
import { NumberField } from './NumberField';

type MenuName = 'mainMenu' | 'pauseMenu';

/** Plain-English names for the action vocabulary, so the picker is not a list of identifiers. */
const ACTION_LABELS: Record<UiAction, string> = {
  startGame: 'Start the game',
  resume: 'Resume',
  restartCheckpoint: 'Restart from checkpoint',
  openSettings: 'Open settings',
  closeSettings: 'Close settings',
  mainMenu: 'Go to main menu',
  quit: 'Quit',
};

const ANCHORS = [
  'topLeft',
  'topCenter',
  'topRight',
  'bottomLeft',
  'bottomCenter',
  'bottomRight',
] as const;

const BINDINGS = ['none', 'health', 'ammo', 'score', 'timer'] as const;

/**
 * Uploaded image and video picker.
 *
 * Uploads land in the browser rather than on a server, because there is no server yet and the
 * editor is local-first by design. Sprint 30 swaps the storage without any of this UI changing.
 */
function AssetField({
  label,
  kind,
  value,
  assets,
  onPick,
  onUpload,
}: {
  label: string;
  kind: 'image' | 'video';
  value: string | null;
  assets: StoredUiAsset[];
  onPick(id: string | null): void;
  onUpload(file: File): void;
}): React.JSX.Element {
  const matching = assets.filter((asset) => asset.kind === kind);

  return (
    <div className="param-row ui-asset-row">
      <span>{label}</span>
      <div className="ui-asset-controls">
        <select
          aria-label={label}
          value={value ?? ''}
          onChange={(event) => onPick(event.target.value || null)}
        >
          <option value="">None</option>
          {matching.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name}
            </option>
          ))}
        </select>
        <label className="ui-upload">
          Upload
          <input
            type="file"
            aria-label={`Upload ${label.toLowerCase()}`}
            accept={kind === 'image' ? 'image/*' : 'video/*'}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file);
              // Cleared so re-picking the same file fires `change` again.
              event.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}

/** One menu, edited in place: relabel, reassign, reorder, remove. */
function MenuEditor({ menu, label }: { menu: MenuName; label: string }): React.JSX.Element {
  const buttons = useSceneStore((state) => state.scene.uiConfig[menu].buttons);
  const setMenuButtons = useSceneStore((state) => state.setMenuButtons);
  const moveMenuButton = useSceneStore((state) => state.moveMenuButton);

  const update = (index: number, patch: Partial<UiButton>): void =>
    setMenuButtons(
      menu,
      buttons.map((button, at) => (at === index ? { ...button, ...patch } : button)),
    );

  return (
    <div className="trigger-list">
      <h3>{label}</h3>
      {buttons.length === 0 && <p className="panel-hint">No buttons. The menu will say so.</p>}

      {buttons.map((button, index) => (
        <div className="action-card" key={`${menu}-${index}`}>
          <div className="behavior-head">
            <input
              type="text"
              aria-label={`${label} button ${index + 1} label`}
              value={button.label}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <div className="ui-button-actions">
              <button
                type="button"
                aria-label={`Move ${label} button ${index + 1} up`}
                disabled={index === 0}
                onClick={() => moveMenuButton(menu, index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${label} button ${index + 1} down`}
                disabled={index === buttons.length - 1}
                onClick={() => moveMenuButton(menu, index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${label} button ${index + 1}`}
                onClick={() =>
                  setMenuButtons(
                    menu,
                    buttons.filter((_unused, at) => at !== index),
                  )
                }
              >
                ×
              </button>
            </div>
          </div>

          <label className="param-row">
            <span>Does</span>
            <select
              aria-label={`${label} button ${index + 1} action`}
              value={button.action}
              onChange={(event) => update(index, { action: event.target.value as UiAction })}
            >
              {UiActionSchema.options.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ))}

      <button
        type="button"
        className="ui-add"
        // Labelled with the menu it belongs to: there are two of these on the panel, and "Add
        // button" alone tells neither a screen reader nor a test which one it is.
        aria-label={`Add ${label} button`}
        onClick={() =>
          setMenuButtons(menu, [...buttons, { label: 'New button', action: 'resume' }])
        }
      >
        Add button
      </button>
    </div>
  );
}

/** Custom HUD text and images: what they say, where they sit, how big they are. */
function HudElementsEditor({ assets }: { assets: StoredUiAsset[] }): React.JSX.Element {
  const elements = useSceneStore((state) => state.scene.uiConfig.hud.customElements);
  const setHudElements = useSceneStore((state) => state.setHudElements);

  const update = (index: number, patch: Partial<HudElement>): void =>
    setHudElements(
      elements.map((element, at) => (at === index ? { ...element, ...patch } : element)),
    );

  const add = (): void => {
    // Ids have to be unique and stable; numbering from the count would collide after a removal.
    const used = new Set(elements.map((element) => element.id));
    let index = elements.length + 1;
    while (used.has(`hud_${index}`)) index += 1;

    setHudElements([
      ...elements,
      HudElementSchema.parse({ id: `hud_${index}`, kind: 'text', value: 'Text' }),
    ]);
  };

  return (
    <div className="trigger-list">
      <h3>HUD elements</h3>
      {elements.length === 0 && (
        <p className="panel-hint">Nothing pinned. Add a label, a timer, or an image.</p>
      )}

      {elements.map((element, index) => (
        <div className="action-card" key={element.id}>
          <div className="behavior-head">
            <span className="behavior-name">{element.id}</span>
            <button
              type="button"
              aria-label={`Remove HUD element ${index + 1}`}
              onClick={() => setHudElements(elements.filter((_unused, at) => at !== index))}
            >
              Remove
            </button>
          </div>

          <label className="param-row">
            <span>Kind</span>
            <select
              aria-label={`HUD element ${index + 1} kind`}
              value={element.kind}
              onChange={(event) =>
                update(index, { kind: event.target.value as HudElement['kind'] })
              }
            >
              <option value="text">Text</option>
              <option value="image">Image</option>
            </select>
          </label>

          {element.kind === 'text' ? (
            <>
              <label className="param-row">
                <span>Shows</span>
                <select
                  aria-label={`HUD element ${index + 1} binding`}
                  value={element.bind}
                  onChange={(event) =>
                    update(index, { bind: event.target.value as HudElement['bind'] })
                  }
                >
                  {BINDINGS.map((bind) => (
                    <option key={bind} value={bind}>
                      {bind === 'none' ? 'Fixed text' : bind}
                    </option>
                  ))}
                </select>
              </label>

              {element.bind === 'none' && (
                <label className="param-row">
                  <span>Text</span>
                  <input
                    type="text"
                    aria-label={`HUD element ${index + 1} text`}
                    value={element.value}
                    onChange={(event) => update(index, { value: event.target.value })}
                  />
                </label>
              )}
            </>
          ) : (
            <label className="param-row">
              <span>Image</span>
              <select
                aria-label={`HUD element ${index + 1} image`}
                value={element.value}
                onChange={(event) => update(index, { value: event.target.value })}
              >
                <option value="">None</option>
                {assets
                  .filter((asset) => asset.kind === 'image')
                  .map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
              </select>
            </label>
          )}

          <label className="param-row">
            <span>Corner</span>
            <select
              aria-label={`HUD element ${index + 1} anchor`}
              value={element.anchor}
              onChange={(event) =>
                update(index, { anchor: event.target.value as HudElement['anchor'] })
              }
            >
              {ANCHORS.map((anchor) => (
                <option key={anchor} value={anchor}>
                  {anchor}
                </option>
              ))}
            </select>
          </label>

          <div className="vector-row" role="group" aria-label={`HUD element ${index + 1} offset`}>
            <span className="vector-title">Offset</span>
            <div className="vector-fields">
              {(['X', 'Y'] as const).map((axis, at) => (
                <NumberField
                  key={axis}
                  label={`HUD element ${index + 1} offset ${axis}`}
                  scrubLabel={axis}
                  value={element.offset[at] ?? 0}
                  step={2}
                  onChange={(next) => {
                    const offset: [number, number] = [...element.offset];
                    offset[at] = next;
                    update(index, { offset });
                  }}
                />
              ))}
            </div>
          </div>

          <div className="param-row">
            <span>Size</span>
            <NumberField
              label={`HUD element ${index + 1} size`}
              scrubLabel=""
              value={element.fontSize}
              step={1}
              suffix="px"
              onChange={(next) => update(index, { fontSize: Math.min(96, Math.max(8, next)) })}
            />
          </div>
        </div>
      ))}

      <button type="button" className="ui-add" onClick={add}>
        Add HUD element
      </button>
    </div>
  );
}

/**
 * Everything about the game's shell, editable without touching JSON.
 *
 * The panel is deliberately long rather than clever: a home screen, two menus, a HUD and a theme
 * are four genuinely different things, and hiding them behind tabs would mean an author has to
 * remember where a setting lives. Scrolling is cheaper than searching.
 */
export function GameUiPanel(): React.JSX.Element {
  const ui = useSceneStore((state) => state.scene.uiConfig);
  const setUiConfig = useSceneStore((state) => state.setUiConfig);

  const [assets, setAssets] = useState<StoredUiAsset[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const stored = await listUiAssets();
    // Materialise every URL now: the UI renderer resolves assets synchronously while drawing.
    await Promise.all(stored.map((asset) => uiAssetUrl(asset.id)));
    setAssets(stored);
  }, []);

  useEffect(() => {
    // Guarded rather than fire-and-forget: the panel unmounts whenever the inspector re-renders
    // without a selection, and a late `setAssets` on a dead component is a warning nobody reads.
    let cancelled = false;
    void (async () => {
      const stored = await listUiAssets();
      await Promise.all(stored.map((asset) => uiAssetUrl(asset.id)));
      if (!cancelled) setAssets(stored);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const upload = async (file: File, apply: (id: string) => void): Promise<void> => {
    setError(null);
    try {
      const stored = await saveUiAsset(file);
      await uiAssetUrl(stored.id);
      await refresh();
      apply(stored.id);
    } catch (cause) {
      setError(cause instanceof UiAssetError ? cause.message : 'That upload failed.');
    }
  };

  return (
    <section className="panel" aria-label="Game UI">
      <h2>Game UI</h2>

      <label className="param-check">
        <input
          type="checkbox"
          checked={ui.enabled}
          onChange={(event) => setUiConfig({ enabled: event.target.checked })}
        />
        Show menus and HUD
      </label>

      {error && (
        <p className="panel-hint error" role="alert">
          {error}
        </p>
      )}

      <div className="trigger-list">
        <h3>Home screen</h3>

        <label className="param-row">
          <span>Title</span>
          <input
            type="text"
            aria-label="Game title"
            value={ui.homeScreen.title}
            onChange={(event) => setUiConfig({ homeScreen: { title: event.target.value } })}
          />
        </label>

        <label className="param-row">
          <span>Subtitle</span>
          <input
            type="text"
            aria-label="Game subtitle"
            value={ui.homeScreen.subtitle}
            onChange={(event) => setUiConfig({ homeScreen: { subtitle: event.target.value } })}
          />
        </label>

        <label className="param-row">
          <span>Play button</span>
          <input
            type="text"
            aria-label="Play button text"
            value={ui.homeScreen.playButtonText}
            onChange={(event) =>
              setUiConfig({ homeScreen: { playButtonText: event.target.value } })
            }
          />
        </label>

        <AssetField
          label="Background"
          kind="image"
          value={ui.homeScreen.backgroundImageAssetId}
          assets={assets}
          onPick={(id) => setUiConfig({ homeScreen: { backgroundImageAssetId: id } })}
          onUpload={(file) =>
            void upload(file, (id) => setUiConfig({ homeScreen: { backgroundImageAssetId: id } }))
          }
        />

        <AssetField
          label="Intro video"
          kind="video"
          value={ui.homeScreen.introVideoAssetId}
          assets={assets}
          onPick={(id) => setUiConfig({ homeScreen: { introVideoAssetId: id } })}
          onUpload={(file) =>
            void upload(file, (id) => setUiConfig({ homeScreen: { introVideoAssetId: id } }))
          }
        />

        {ui.homeScreen.introVideoAssetId && (
          <label className="param-check">
            <input
              type="checkbox"
              checked={ui.homeScreen.introSkippable}
              onChange={(event) =>
                setUiConfig({ homeScreen: { introSkippable: event.target.checked } })
              }
            />
            Intro can be skipped
          </label>
        )}
      </div>

      <MenuEditor menu="mainMenu" label="Main menu" />
      <MenuEditor menu="pauseMenu" label="Pause menu" />

      <div className="trigger-list">
        <h3>HUD</h3>
        {(
          [
            ['showCrosshair', 'Crosshair'],
            ['showHealthBar', 'Health bar'],
            ['showAmmoCounter', 'Ammo counter'],
          ] as const
        ).map(([key, label]) => (
          <label className="param-check" key={key}>
            <input
              type="checkbox"
              checked={ui.hud[key]}
              onChange={(event) => setUiConfig({ hud: { [key]: event.target.checked } })}
            />
            {label}
          </label>
        ))}
      </div>

      <HudElementsEditor assets={assets} />

      <div className="trigger-list">
        <h3>Theme</h3>

        <label className="param-row">
          <span>Preset</span>
          <select
            aria-label="Theme"
            value={ui.theme.preset}
            onChange={(event) =>
              setUiConfig({ theme: { preset: event.target.value as UiTheme['preset'] } })
            }
          >
            {THEME_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {preset}
              </option>
            ))}
          </select>
        </label>

        <label className="param-row">
          <span>Panels</span>
          <select
            aria-label="Panel style"
            value={ui.theme.panelStyle}
            onChange={(event) =>
              setUiConfig({ theme: { panelStyle: event.target.value as UiTheme['panelStyle'] } })
            }
          >
            {(['glass', 'solid', 'outline'] as const).map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </label>

        <label className="param-row">
          <span>Accent</span>
          <input
            type="color"
            aria-label="Accent colour"
            value={ui.theme.primaryColor ?? '#8fd694'}
            onChange={(event) => setUiConfig({ theme: { primaryColor: event.target.value } })}
          />
        </label>
      </div>

      {assets.length > 0 && (
        <div className="trigger-list">
          <h3>Uploaded</h3>
          <ul className="waypoint-list">
            {assets.map((asset) => (
              <li key={asset.id}>
                <span>
                  {asset.name} · {(asset.bytes / 1024).toFixed(0)} kB
                </span>
                <button
                  type="button"
                  aria-label={`Delete ${asset.name}`}
                  onClick={() => void deleteUiAsset(asset.id).then(refresh)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
