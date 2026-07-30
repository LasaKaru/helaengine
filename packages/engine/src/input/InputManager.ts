/**
 * Everything the game can be told to do, independent of what told it.
 *
 * The whole point of naming these is that nothing downstream ever asks "was W pressed" — it asks
 * whether the player wants to move forward, and a keyboard, a thumbstick and a virtual joystick are
 * three equally valid ways of saying yes. Bolting touch on per-platform later is how an engine ends
 * up with three divergent control paths that each fix bugs the others still have.
 */
export type InputAction =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'fire'
  | 'reload'
  | 'nextWeapon'
  | 'interact'
  | 'switchCamera';

export const INPUT_ACTIONS: readonly InputAction[] = [
  'moveForward',
  'moveBack',
  'moveLeft',
  'moveRight',
  'jump',
  'sprint',
  'crouch',
  'fire',
  'reload',
  'nextWeapon',
  'interact',
  'switchCamera',
];

/** Default keyboard binding, by `KeyboardEvent.code` so it is layout-independent. */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<string, InputAction>> = {
  KeyW: 'moveForward',
  ArrowUp: 'moveForward',
  KeyS: 'moveBack',
  ArrowDown: 'moveBack',
  KeyA: 'moveLeft',
  ArrowLeft: 'moveLeft',
  KeyD: 'moveRight',
  ArrowRight: 'moveRight',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyR: 'reload',
  KeyQ: 'nextWeapon',
  KeyE: 'interact',
  KeyV: 'switchCamera',
};

/**
 * Standard-gamepad button indices, per the W3C mapping.
 *
 * Only meaningful when `gamepad.mapping === 'standard'`; a controller reporting anything else has
 * an unknown layout, and guessing at it produces a character that jumps when you meant to shoot.
 */
const GAMEPAD_BUTTONS: Readonly<Record<number, InputAction>> = {
  0: 'jump', // A
  1: 'crouch', // B
  2: 'interact', // X
  3: 'switchCamera', // Y
  4: 'reload', // left shoulder
  5: 'nextWeapon', // right shoulder
  7: 'fire', // right trigger
  10: 'sprint', // left stick click
};

/** Below this, a stick is at rest — analogue sticks never quite return to zero. */
const STICK_DEADZONE = 0.15;

export interface InputManagerOptions {
  /** Element that receives pointer lock and hosts the touch overlay. */
  element: HTMLElement;
  /** Multiplier on look input. The settings menu scales this. Default 1. */
  lookSensitivity?: number;
  /** Show the on-screen controls. Default: only when the device reports touch support. */
  touchControls?: boolean;
  /** Radians of yaw per pixel of mouse movement, before sensitivity. */
  mouseRadiansPerPixel?: number;
}

/** A movement or look vector, both axes in -1..1 (move) or radians (look). */
export interface Axis2 {
  x: number;
  y: number;
}

/**
 * Collects input from every source the browser offers and presents it as one abstract state.
 *
 * Framework-free and DOM-only, because this runs inside an exported project as well as inside the
 * editor. Reading is deliberately split into "held" and "pressed": a jump wants the edge, a sprint
 * wants the level, and conflating them gives you a character that jumps once per frame.
 */
export class InputManager {
  readonly #element: HTMLElement;
  readonly #keyBindings: Record<string, InputAction>;
  readonly #held = new Set<InputAction>();
  readonly #pressed = new Set<InputAction>();
  readonly #mouseRadiansPerPixel: number;
  readonly #look: Axis2 = { x: 0, y: 0 };
  readonly #move: Axis2 = { x: 0, y: 0 };
  readonly #stickMove: Axis2 = { x: 0, y: 0 };
  readonly #stickLook: Axis2 = { x: 0, y: 0 };
  readonly #touchMove: Axis2 = { x: 0, y: 0 };
  readonly #touchLook: Axis2 = { x: 0, y: 0 };
  readonly #touchActions = new Set<InputAction>();
  readonly #showTouchControls: boolean;

  lookSensitivity: number;
  /** Whether a click on the element grabs the pointer. Turned off while a menu is showing. */
  captureOnClick = true;

  #overlay: HTMLElement | null = null;
  #attached = false;
  #gamepadIndex: number | null = null;
  /** Pointer id driving the virtual joystick, and where it started. */
  #joystickPointer: number | null = null;
  #joystickOrigin: Axis2 = { x: 0, y: 0 };
  #lookPointer: number | null = null;
  #lookLast: Axis2 = { x: 0, y: 0 };

  constructor(options: InputManagerOptions) {
    this.#element = options.element;
    this.#keyBindings = { ...DEFAULT_KEY_BINDINGS };
    this.lookSensitivity = options.lookSensitivity ?? 1;
    this.#mouseRadiansPerPixel = options.mouseRadiansPerPixel ?? 0.0022;
    this.#showTouchControls =
      options.touchControls ?? (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  }

  get attached(): boolean {
    return this.#attached;
  }

  /** True while a gamepad is connected and reporting the standard mapping. */
  get gamepadConnected(): boolean {
    return this.#gamepadIndex !== null;
  }

  get touchControlsVisible(): boolean {
    return this.#overlay !== null;
  }

  /**
   * Movement intent, in -1..1 per axis.
   *
   * `y` is forward. Combining a keyboard's four booleans and a thumbstick's two floats into one
   * vector here is what lets the character controller take a single, source-agnostic input.
   */
  get move(): Readonly<Axis2> {
    return this.#move;
  }

  /** Look delta accumulated since the last `update()`, in radians. */
  get look(): Readonly<Axis2> {
    return this.#look;
  }

  isDown(action: InputAction): boolean {
    return this.#held.has(action) || this.#touchActions.has(action);
  }

  /** True only on the frame an action went down. Cleared by `update()`. */
  wasPressed(action: InputAction): boolean {
    return this.#pressed.has(action);
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;

    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onBlur);
    this.#element.addEventListener('mousedown', this.#onMouseDown);
    window.addEventListener('mouseup', this.#onMouseUp);
    this.#element.addEventListener('click', this.#onClick);
    document.addEventListener('mousemove', this.#onMouseMove);
    window.addEventListener('gamepadconnected', this.#onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.#onGamepadDisconnected);

    if (this.#showTouchControls) this.#buildTouchOverlay();
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;

    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);
    this.#element.removeEventListener('mousedown', this.#onMouseDown);
    window.removeEventListener('mouseup', this.#onMouseUp);
    this.#element.removeEventListener('click', this.#onClick);
    document.removeEventListener('mousemove', this.#onMouseMove);
    window.removeEventListener('gamepadconnected', this.#onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.#onGamepadDisconnected);

    // Optional-called: pointer lock is not universal, and a teardown that throws on an older
    // browser would leave every listener above still attached.
    if (document.pointerLockElement === this.#element) document.exitPointerLock?.();
    this.#overlay?.remove();
    this.#overlay = null;
    this.#onBlur();
  }

  /**
   * Folds every source into `move` and `look` for this frame, then clears the edges.
   *
   * Called once per frame, before anything reads the state. `deltaSeconds` matters because a
   * thumbstick reports a *rate* of turn while a mouse reports an accumulated delta, and the two
   * only agree once the stick has been multiplied by frame time.
   */
  update(deltaSeconds: number): void {
    this.#pollGamepad(deltaSeconds);

    const keyboardX = (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0);
    const keyboardY = (this.isDown('moveForward') ? 1 : 0) - (this.isDown('moveBack') ? 1 : 0);

    // Whichever source is pushing hardest wins on each axis, so a stick nudge does not cancel a
    // held key and a plugged-in-but-idle controller contributes nothing.
    this.#move.x = pickStronger(keyboardX, this.#stickMove.x, this.#touchMove.x);
    this.#move.y = pickStronger(keyboardY, this.#stickMove.y, this.#touchMove.y);

    this.#look.x += (this.#stickLook.x + this.#touchLook.x) * this.lookSensitivity;
    this.#look.y += (this.#stickLook.y + this.#touchLook.y) * this.lookSensitivity;
    this.#touchLook.x = 0;
    this.#touchLook.y = 0;
  }

  /** Reads and zeroes the accumulated look delta. Call after applying it to a camera. */
  consumeLook(out: Axis2): Axis2 {
    out.x = this.#look.x;
    out.y = this.#look.y;
    this.#look.x = 0;
    this.#look.y = 0;
    return out;
  }

  /** Clears one-frame edges. Call at the very end of a frame. */
  endFrame(): void {
    this.#pressed.clear();
  }

  /** Asks for pointer lock. Browsers only grant it inside a user gesture. */
  requestPointerLock(): void {
    if (document.pointerLockElement !== this.#element) void this.#element.requestPointerLock?.();
  }

  /**
   * Hands the cursor back.
   *
   * A menu is unusable while the pointer is locked — the click never reaches it, because the
   * pointer is captured rather than pointing at anything. Anything that shows a menu has to call
   * this, which is why it is public rather than something `detach` does on the way out.
   */
  releasePointerLock(): void {
    if (document.pointerLockElement === this.#element) document.exitPointerLock?.();
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.#element;
  }

  #press(action: InputAction): void {
    if (!this.#held.has(action)) this.#pressed.add(action);
    this.#held.add(action);
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    const action = this.#keyBindings[event.code];
    if (!action) return;
    // Space scrolls the page and the arrows scroll panels; neither is wanted mid-game.
    event.preventDefault();
    this.#press(action);
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    const action = this.#keyBindings[event.code];
    if (action) this.#held.delete(action);
  };

  readonly #onBlur = (): void => {
    // A tab switch mid-stride otherwise leaves the character sprinting forever.
    this.#held.clear();
    this.#pressed.clear();
    this.#touchActions.clear();
    this.#stickMove.x = 0;
    this.#stickMove.y = 0;
    this.#touchMove.x = 0;
    this.#touchMove.y = 0;
  };

  readonly #onMouseDown = (event: MouseEvent): void => {
    if (event.button === 0) this.#press('fire');
  };

  readonly #onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.#held.delete('fire');
  };

  readonly #onClick = (): void => {
    if (this.captureOnClick) this.requestPointerLock();
  };

  readonly #onMouseMove = (event: MouseEvent): void => {
    if (!this.pointerLocked) return;
    this.#look.x -= event.movementX * this.#mouseRadiansPerPixel * this.lookSensitivity;
    this.#look.y -= event.movementY * this.#mouseRadiansPerPixel * this.lookSensitivity;
  };

  readonly #onGamepadConnected = (event: Event): void => {
    const pad = (event as GamepadEvent).gamepad;
    if (pad.mapping === 'standard') this.#gamepadIndex = pad.index;
  };

  readonly #onGamepadDisconnected = (event: Event): void => {
    if ((event as GamepadEvent).gamepad.index === this.#gamepadIndex) this.#gamepadIndex = null;
  };

  #pollGamepad(deltaSeconds: number): void {
    this.#stickMove.x = 0;
    this.#stickMove.y = 0;
    this.#stickLook.x = 0;
    this.#stickLook.y = 0;

    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    // Re-read every frame rather than caching: the Gamepad object is a snapshot, and a stale one
    // reports the stick position from whenever it was captured.
    const pads = navigator.getGamepads();
    const pad =
      this.#gamepadIndex === null
        ? [...pads].find((candidate) => candidate?.mapping === 'standard')
        : pads[this.#gamepadIndex];
    if (!pad) return;
    this.#gamepadIndex = pad.index;

    this.#stickMove.x = deadzone(pad.axes[0] ?? 0);
    this.#stickMove.y = -deadzone(pad.axes[1] ?? 0);
    // A stick held over says "keep turning", so it is a rate and has to be scaled by frame time.
    // A mouse already reports how far it moved, which is why the two are summed rather than mixed.
    const lookRate = 2.5 * deltaSeconds;
    this.#stickLook.x = -deadzone(pad.axes[2] ?? 0) * lookRate;
    this.#stickLook.y = -deadzone(pad.axes[3] ?? 0) * lookRate;

    for (const [index, action] of Object.entries(GAMEPAD_BUTTONS)) {
      const button = pad.buttons[Number(index)];
      if (button?.pressed) this.#press(action);
      else this.#held.delete(action);
    }
  }

  /**
   * Builds the on-screen controls: a joystick on the left, action buttons on the right.
   *
   * Plain DOM, created by the engine rather than the editor, because an exported game running on a
   * phone needs these and has no React to build them with.
   */
  #buildTouchOverlay(): void {
    const overlay = document.createElement('div');
    overlay.className = 'hela-touch-controls';
    overlay.setAttribute('aria-hidden', 'true');
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      touchAction: 'none',
      userSelect: 'none',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);

    const stickBase = document.createElement('div');
    Object.assign(stickBase.style, {
      position: 'absolute',
      left: '24px',
      bottom: '24px',
      width: '120px',
      height: '120px',
      borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)',
      background: 'rgba(0,0,0,0.25)',
    } satisfies Partial<CSSStyleDeclaration>);

    const stickKnob = document.createElement('div');
    Object.assign(stickKnob.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '48px',
      height: '48px',
      marginLeft: '-24px',
      marginTop: '-24px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.55)',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    stickBase.appendChild(stickKnob);
    overlay.appendChild(stickBase);

    for (const [action, label, offset] of [
      ['jump', 'Jump', 24],
      ['fire', 'Fire', 100],
      ['reload', 'Reload', 176],
      ['nextWeapon', 'Swap', 252],
      ['interact', 'Use', 328],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset['action'] = action;
      Object.assign(button.style, {
        position: 'absolute',
        right: '24px',
        bottom: `${offset}px`,
        width: '68px',
        height: '68px',
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.35)',
        background: 'rgba(0,0,0,0.3)',
        color: '#fff',
        font: 'inherit',
        fontSize: '12px',
      } satisfies Partial<CSSStyleDeclaration>);

      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#touchActions.add(action);
        this.#pressed.add(action);
      });
      const release = (): void => {
        this.#touchActions.delete(action);
      };
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', release);
      overlay.appendChild(button);
    }

    overlay.addEventListener('pointerdown', (event) => {
      const rect = stickBase.getBoundingClientRect();
      const onStick =
        event.clientX >= rect.left - 40 &&
        event.clientX <= rect.right + 40 &&
        event.clientY >= rect.top - 40;

      if (onStick && this.#joystickPointer === null) {
        this.#joystickPointer = event.pointerId;
        this.#joystickOrigin = { x: event.clientX, y: event.clientY };
      } else if (this.#lookPointer === null) {
        this.#lookPointer = event.pointerId;
        this.#lookLast = { x: event.clientX, y: event.clientY };
      }
    });

    overlay.addEventListener('pointermove', (event) => {
      if (event.pointerId === this.#joystickPointer) {
        const radius = 52;
        const dx = clamp((event.clientX - this.#joystickOrigin.x) / radius, -1, 1);
        const dy = clamp((event.clientY - this.#joystickOrigin.y) / radius, -1, 1);
        this.#touchMove.x = dx;
        this.#touchMove.y = -dy;
        stickKnob.style.transform = `translate(${dx * radius}px, ${dy * radius}px)`;
        return;
      }
      if (event.pointerId === this.#lookPointer) {
        this.#touchLook.x -= (event.clientX - this.#lookLast.x) * this.#mouseRadiansPerPixel;
        this.#touchLook.y -= (event.clientY - this.#lookLast.y) * this.#mouseRadiansPerPixel;
        this.#lookLast = { x: event.clientX, y: event.clientY };
      }
    });

    const endPointer = (event: PointerEvent): void => {
      if (event.pointerId === this.#joystickPointer) {
        this.#joystickPointer = null;
        this.#touchMove.x = 0;
        this.#touchMove.y = 0;
        stickKnob.style.transform = '';
      }
      if (event.pointerId === this.#lookPointer) this.#lookPointer = null;
    };
    overlay.addEventListener('pointerup', endPointer);
    overlay.addEventListener('pointercancel', endPointer);

    // The overlay is positioned against the element, which has to be a containing block for it.
    if (getComputedStyle(this.#element).position === 'static') {
      this.#element.style.position = 'relative';
    }
    (this.#element.parentElement ?? this.#element).appendChild(overlay);
    this.#overlay = overlay;
  }
}

function deadzone(value: number): number {
  return Math.abs(value) < STICK_DEADZONE ? 0 : value;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The input pushing hardest on an axis, keeping its sign. */
function pickStronger(...values: number[]): number {
  let best = 0;
  for (const value of values) {
    if (Math.abs(value) > Math.abs(best)) best = value;
  }
  return clamp(best, -1, 1);
}
