import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Environment, PostProcessing } from '@helaengine/schema';

/**
 * The image effects a scene document can ask for, and nothing else.
 *
 * Built on Three's own passes rather than a post-processing library, and that is a size decision
 * rather than a preference: `three/examples` is already in the bundle, and adding `postprocessing`
 * would put another hundred kilobytes into every exported game for effects most of them turn off.
 *
 * The vocabulary is closed for the same reason every vocabulary here is. A scene that could carry
 * a shader is a scene that can hang a GPU driver in a collaborator's browser, and one the
 * pre-delivery gate would have to guess about. So the grading pass below is a *fixed* shader with
 * validated uniforms — brightness, contrast, saturation, tint — which is what colour grading
 * amounts to in practice and which can be checked before it runs.
 */

/**
 * Brightness, contrast, saturation and tint in one pass.
 *
 * One pass rather than four: each is a full-screen read and write of the whole frame, and on a
 * phone that is the difference between a stack that costs a millisecond and one that costs four.
 */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    brightness: { value: 0 },
    contrast: { value: 0 },
    saturation: { value: 0 },
    tint: { value: new THREE.Color(0xffffff) },
    vignetteStrength: { value: 0 },
    vignetteOffset: { value: 0.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float brightness;
    uniform float contrast;
    uniform float saturation;
    uniform vec3 tint;
    uniform float vignetteStrength;
    uniform float vignetteOffset;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;

      color += brightness;
      color = (color - 0.5) * (1.0 + contrast) + 0.5;

      // Rec. 709 luminance weights: the eye is far more sensitive to green than to blue, and a
      // flat average desaturates towards a muddy grey that reads as a bug rather than a choice.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, 1.0 + saturation);
      color *= tint;

      if (vignetteStrength > 0.0) {
        float distance = length(vUv - vec2(0.5)) - vignetteOffset;
        float darkening = clamp(distance / max(1.0 - vignetteOffset, 0.001), 0.0, 1.0);
        color *= 1.0 - darkening * vignetteStrength;
      }

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), texel.a);
    }
  `,
};

/** Three's tone-mapping constants, keyed by the names a document uses. */
const TONE_MAPPING: Readonly<Record<Environment['toneMapping'], THREE.ToneMapping>> = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  aces: THREE.ACESFilmicToneMapping,
};

/** Whether a settings object asks for anything at all. */
export function wantsPostProcessing(post: PostProcessing): boolean {
  return post.enabled && (post.bloom.enabled || post.vignette.enabled || post.colorGrade.enabled);
}

/**
 * The composer for one scene, or null when nothing is asked for.
 *
 * Null is the common case and is not a degraded one: with no effects the renderer draws straight
 * to the canvas exactly as it always has, with no render target, no extra full-screen passes and
 * no memory for either. Somebody who has not asked for bloom should not pay for the machinery
 * that would deliver it.
 */
export class PostStack {
  readonly #composer: EffectComposer;
  readonly #grade: ShaderPass | null;
  readonly #bloom: UnrealBloomPass | null;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    post: PostProcessing,
    size: { width: number; height: number },
  ) {
    this.#composer = new EffectComposer(renderer);
    this.#composer.setSize(size.width, size.height);
    this.#composer.addPass(new RenderPass(scene, camera));

    if (post.bloom.enabled) {
      this.#bloom = new UnrealBloomPass(
        new THREE.Vector2(size.width, size.height),
        post.bloom.strength,
        post.bloom.radius,
        post.bloom.threshold,
      );
      this.#composer.addPass(this.#bloom);
    } else {
      this.#bloom = null;
    }

    if (post.colorGrade.enabled || post.vignette.enabled) {
      this.#grade = new ShaderPass(GRADE_SHADER);
      this.#applyGrade(post);
      this.#composer.addPass(this.#grade);
    } else {
      this.#grade = null;
    }

    // Last, and required: the composer's render targets are linear, and without this the frame is
    // written to the canvas without the sRGB conversion the renderer would have done itself. The
    // symptom is a washed-out image the moment any effect is switched on, which reads as the
    // effect being wrong rather than the colour space.
    this.#composer.addPass(new OutputPass());
  }

  #applyGrade(post: PostProcessing): void {
    if (!this.#grade) return;
    const uniforms = this.#grade.uniforms as typeof GRADE_SHADER.uniforms;
    const grade = post.colorGrade;

    uniforms.brightness.value = grade.enabled ? grade.brightness : 0;
    uniforms.contrast.value = grade.enabled ? grade.contrast : 0;
    uniforms.saturation.value = grade.enabled ? grade.saturation : 0;
    uniforms.tint.value.set(grade.enabled ? grade.tint : '#ffffff');
    uniforms.vignetteStrength.value = post.vignette.enabled ? post.vignette.strength : 0;
    uniforms.vignetteOffset.value = post.vignette.offset;
  }

  render(deltaSeconds: number): void {
    this.#composer.render(deltaSeconds);
  }

  setSize(width: number, height: number): void {
    this.#composer.setSize(width, height);
    this.#bloom?.setSize(width, height);
  }

  dispose(): void {
    this.#composer.dispose();
  }
}

/**
 * Puts the renderer's tone mapping and exposure where the document says.
 *
 * On the renderer rather than in a pass, because Three applies tone mapping during the material's
 * own shading — a pass doing it afterwards would work on colours that had already been clipped to
 * the display range, which is the thing tone mapping exists to avoid.
 */
export function applyToneMapping(renderer: THREE.WebGLRenderer, environment: Environment): void {
  renderer.toneMapping = TONE_MAPPING[environment.toneMapping];
  renderer.toneMappingExposure = environment.exposure;
}
