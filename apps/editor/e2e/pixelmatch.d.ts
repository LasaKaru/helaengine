/**
 * `pixelmatch` v6 ships no types and there is no `@types/pixelmatch` for it.
 *
 * Declared here rather than pulled in as a dependency: this is the whole surface the visual suite
 * uses, and a hand-written declaration that covers exactly what is called is more honest than a
 * community package that may describe a different version.
 */
declare module 'pixelmatch' {
  interface PixelmatchOptions {
    /** Per-pixel colour tolerance, 0..1. Higher means more forgiving. */
    threshold?: number;
    includeAA?: boolean;
    alpha?: number;
    diffColor?: [number, number, number];
    diffMask?: boolean;
  }

  /** Returns the number of differing pixels, and writes a diff image into `output`. */
  export default function pixelmatch(
    img1: Uint8Array | Buffer,
    img2: Uint8Array | Buffer,
    output: Uint8Array | Buffer | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
