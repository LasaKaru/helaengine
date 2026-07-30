// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputManager } from './InputManager.js';

function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
}
function release(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

/** A standard-mapping gamepad with every axis and button at rest. */
function fakePad(overrides: { axes?: number[]; buttons?: number[] } = {}): Gamepad {
  const axes = overrides.axes ?? [0, 0, 0, 0];
  const pressed = new Set(overrides.buttons ?? []);
  return {
    index: 0,
    id: 'test pad',
    mapping: 'standard',
    connected: true,
    timestamp: 0,
    axes,
    buttons: Array.from({ length: 17 }, (_unused, index) => ({
      pressed: pressed.has(index),
      touched: pressed.has(index),
      value: pressed.has(index) ? 1 : 0,
    })),
    vibrationActuator: null,
  } as unknown as Gamepad;
}

describe('InputManager', () => {
  let element: HTMLElement;
  let input: InputManager;

  beforeEach(() => {
    document.body.innerHTML = '';
    element = document.createElement('div');
    document.body.appendChild(element);
    input = new InputManager({ element, touchControls: false });
    input.attach();
  });

  it('turns four keys into one movement vector', () => {
    press('KeyW');
    press('KeyD');
    input.update(1 / 60);

    expect(input.move).toEqual({ x: 1, y: 1 });

    release('KeyW');
    input.update(1 / 60);
    expect(input.move.y).toBe(0);
  });

  it('accepts arrow keys as the same actions', () => {
    press('ArrowUp');
    input.update(1 / 60);
    expect(input.move.y).toBe(1);
  });

  it('separates a held action from the frame it was pressed on', () => {
    // A jump wants the edge and a sprint wants the level; conflating them gives you a character
    // that jumps every frame the key is down.
    press('Space');
    input.update(1 / 60);

    expect(input.wasPressed('jump')).toBe(true);
    expect(input.isDown('jump')).toBe(true);

    input.endFrame();
    input.update(1 / 60);

    expect(input.wasPressed('jump')).toBe(false);
    expect(input.isDown('jump')).toBe(true);
  });

  it('releases everything when the window loses focus', () => {
    press('KeyW');
    press('ShiftLeft');
    window.dispatchEvent(new Event('blur'));
    input.update(1 / 60);

    expect(input.move.y).toBe(0);
    expect(input.isDown('sprint')).toBe(false);
  });

  it('ignores keys it has no binding for', () => {
    press('KeyZ');
    input.update(1 / 60);
    expect(input.move).toEqual({ x: 0, y: 0 });
  });

  it('accumulates mouse look only while the pointer is locked', () => {
    const move = new MouseEvent('mousemove');
    Object.defineProperty(move, 'movementX', { value: 100 });
    Object.defineProperty(move, 'movementY', { value: 50 });

    document.dispatchEvent(move);
    expect(input.look.x).toBe(0);

    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => element,
    });
    document.dispatchEvent(move);

    // Moving the mouse right turns right, which is a decreasing yaw under the engine's convention.
    expect(input.look.x).toBeLessThan(0);
    expect(input.look.y).toBeLessThan(0);
  });

  it('scales look by sensitivity', () => {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => element,
    });
    const move = new MouseEvent('mousemove');
    Object.defineProperty(move, 'movementX', { value: 100 });
    Object.defineProperty(move, 'movementY', { value: 0 });

    document.dispatchEvent(move);
    const atOne = Math.abs(input.look.x);
    input.consumeLook({ x: 0, y: 0 });

    input.lookSensitivity = 3;
    document.dispatchEvent(move);

    expect(Math.abs(input.look.x)).toBeCloseTo(atOne * 3, 6);
  });

  it('hands the look delta over exactly once', () => {
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => element,
    });
    const move = new MouseEvent('mousemove');
    Object.defineProperty(move, 'movementX', { value: 100 });
    Object.defineProperty(move, 'movementY', { value: 0 });
    document.dispatchEvent(move);

    const first = input.consumeLook({ x: 0, y: 0 });
    const second = input.consumeLook({ x: 0, y: 0 });

    expect(first.x).not.toBe(0);
    expect(second).toEqual({ x: 0, y: 0 });
  });

  it('reads a gamepad stick as movement, past the deadzone', () => {
    vi.stubGlobal('navigator', {
      maxTouchPoints: 0,
      getGamepads: () => [fakePad({ axes: [0.9, -0.6, 0, 0] })],
    });

    input.update(1 / 60);

    expect(input.gamepadConnected).toBe(true);
    expect(input.move.x).toBeCloseTo(0.9, 5);
    expect(input.move.y).toBeCloseTo(0.6, 5);
    vi.unstubAllGlobals();
  });

  it('ignores a stick resting near centre', () => {
    vi.stubGlobal('navigator', {
      maxTouchPoints: 0,
      getGamepads: () => [fakePad({ axes: [0.05, -0.08, 0, 0] })],
    });

    input.update(1 / 60);

    expect(input.move).toEqual({ x: 0, y: 0 });
    vi.unstubAllGlobals();
  });

  it('maps standard gamepad buttons to actions', () => {
    vi.stubGlobal('navigator', {
      maxTouchPoints: 0,
      getGamepads: () => [fakePad({ buttons: [0, 7] })],
    });

    input.update(1 / 60);

    expect(input.isDown('jump')).toBe(true);
    expect(input.isDown('fire')).toBe(true);
    expect(input.isDown('crouch')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('refuses a controller whose layout it cannot know', () => {
    // A non-standard mapping means the button indices mean something else entirely, and guessing
    // produces a character that jumps when you meant to shoot.
    vi.stubGlobal('navigator', {
      maxTouchPoints: 0,
      getGamepads: () => [{ ...fakePad({ buttons: [0] }), mapping: '' } as Gamepad],
    });

    input.update(1 / 60);

    expect(input.gamepadConnected).toBe(false);
    expect(input.isDown('jump')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('lets the strongest source win an axis rather than summing them', () => {
    vi.stubGlobal('navigator', {
      maxTouchPoints: 0,
      getGamepads: () => [fakePad({ axes: [0, -0.5, 0, 0] })],
    });
    press('KeyW');

    input.update(1 / 60);

    // Key says 1, stick says 0.5. Summing would give 1.5 and a character that outruns its own
    // speed limit whenever a controller happens to be plugged in.
    expect(input.move.y).toBe(1);
    vi.unstubAllGlobals();
  });

  it('scales stick look by frame time, because a held stick is a rate', () => {
    vi.stubGlobal('navigator', {
      maxTouchPoints: 0,
      getGamepads: () => [fakePad({ axes: [0, 0, 1, 0] })],
    });

    input.update(1 / 60);
    const short = Math.abs(input.look.x);
    input.consumeLook({ x: 0, y: 0 });
    input.update(1 / 30);

    expect(Math.abs(input.look.x)).toBeCloseTo(short * 2, 5);
    vi.unstubAllGlobals();
  });

  it('builds touch controls only when asked', () => {
    expect(input.touchControlsVisible).toBe(false);

    const touch = new InputManager({ element, touchControls: true });
    touch.attach();

    expect(touch.touchControlsVisible).toBe(true);
    expect(document.querySelectorAll('.hela-touch-controls')).toHaveLength(1);

    touch.detach();
    expect(document.querySelectorAll('.hela-touch-controls')).toHaveLength(0);
  });

  it('fires an action from an on-screen button', () => {
    const touch = new InputManager({ element, touchControls: true });
    touch.attach();

    const fire = document.querySelector('[data-action="fire"]')!;
    fire.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(touch.isDown('fire')).toBe(true);

    fire.dispatchEvent(new Event('pointerup', { bubbles: true }));
    expect(touch.isDown('fire')).toBe(false);
    touch.detach();
  });

  it('stops listening once detached', () => {
    input.detach();
    press('KeyW');
    input.update(1 / 60);

    expect(input.attached).toBe(false);
    expect(input.move.y).toBe(0);
  });
});

describe('secret sequence keys', () => {
  let element: HTMLElement;
  let input: InputManager;

  beforeEach(() => {
    document.body.innerHTML = '';
    element = document.createElement('div');
    document.body.appendChild(element);
    input = new InputManager({ element, touchControls: false });
    input.attach();
  });

  it('reports named buttons rather than key codes', () => {
    press('ArrowUp');
    press('KeyB');
    press('KeyA');

    expect(input.sequenceKeys).toEqual(['Up', 'B', 'A']);
  });

  it('clears them at the end of a frame, like every other edge', () => {
    press('ArrowUp');
    input.update(1 / 60);
    input.endFrame();

    expect(input.sequenceKeys).toEqual([]);
  });

  it('ignores auto-repeat, or no code with a repeated key is ever enterable', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true }));
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'ArrowUp', bubbles: true, repeat: true }),
    );

    expect(input.sequenceKeys).toEqual(['Up']);
  });

  it('lets a key both move the player and feed a sequence', () => {
    // KeyA strafes left *and* contributes an 'A'. That overlap is how console cheat codes have
    // always worked, and refusing it would leave the letter keys unusable in a secret.
    press('KeyA');
    input.update(1 / 60);

    expect(input.isDown('moveLeft')).toBe(true);
    expect(input.sequenceKeys).toEqual(['A']);
  });

  it('takes the same buttons from a gamepad, on the press rather than while held', () => {
    const pad = fakePad({ buttons: [12] }); // d-pad up
    vi.stubGlobal('navigator', { getGamepads: () => [pad], maxTouchPoints: 0 });

    input.update(1 / 60);
    expect(input.sequenceKeys).toEqual(['Up']);

    // Still held on the next poll: a level, not a second press.
    input.endFrame();
    input.update(1 / 60);
    expect(input.sequenceKeys).toEqual([]);

    vi.unstubAllGlobals();
  });

  it('forgets a part-entered sequence when the window loses focus', () => {
    press('ArrowUp');
    window.dispatchEvent(new Event('blur'));

    expect(input.sequenceKeys).toEqual([]);
  });
});
