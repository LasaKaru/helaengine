import type { UiTheme } from '@helaengine/schema';

interface ThemeTokens {
  background: string;
  panel: string;
  panelBorder: string;
  text: string;
  textDim: string;
  primary: string;
  onPrimary: string;
  font: string;
  radius: string;
}

/**
 * The presets.
 *
 * Four, deliberately: enough that a game does not look like every other game built with this, few
 * enough that each one is actually designed rather than being a random palette. A fifth is a
 * fifteen-line addition here and needs no other change anywhere.
 */
const PRESETS: Record<UiTheme['preset'], ThemeTokens> = {
  midnight: {
    background: 'radial-gradient(ellipse at 50% 0%, #1d2634 0%, #0b0e14 70%)',
    panel: 'rgba(18, 23, 32, 0.86)',
    panelBorder: 'rgba(143, 214, 148, 0.35)',
    text: '#e8edf5',
    textDim: '#93a0b4',
    primary: '#8fd694',
    onPrimary: '#0b0e14',
    font: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    radius: '10px',
  },
  parchment: {
    background: 'radial-gradient(ellipse at 50% 0%, #f3e6cc 0%, #d9c49a 75%)',
    panel: 'rgba(255, 250, 240, 0.9)',
    panelBorder: 'rgba(120, 88, 46, 0.4)',
    text: '#3a2a16',
    textDim: '#7a6444',
    primary: '#a8622a',
    onPrimary: '#fffaf0',
    font: "'Iowan Old Style', Georgia, 'Times New Roman', serif",
    radius: '4px',
  },
  neon: {
    background: 'radial-gradient(ellipse at 50% 100%, #2a0b45 0%, #06010f 70%)',
    panel: 'rgba(20, 6, 38, 0.82)',
    panelBorder: 'rgba(255, 92, 209, 0.55)',
    text: '#f6e9ff',
    textDim: '#b78fd4',
    primary: '#ff5cd1',
    onPrimary: '#12021d',
    font: "'Space Grotesk', 'Inter', system-ui, sans-serif",
    radius: '2px',
  },
  mono: {
    background: '#0a0a0a',
    panel: 'rgba(20, 20, 20, 0.9)',
    panelBorder: 'rgba(255, 255, 255, 0.28)',
    text: '#f2f2f2',
    textDim: '#9a9a9a',
    primary: '#f2f2f2',
    onPrimary: '#0a0a0a',
    font: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    radius: '0px',
  },
};

/** Panel treatments, applied on top of whichever preset is in use. */
const PANEL_STYLES: Record<UiTheme['panelStyle'], string> = {
  solid: 'backdrop-filter: none;',
  glass: 'backdrop-filter: blur(14px) saturate(1.1);',
  outline: 'background: transparent !important; border-width: 2px;',
};

/**
 * Turns a theme into CSS custom properties.
 *
 * Custom properties rather than generated per-element rules, because a theme change then costs one
 * assignment on one element and the browser does the rest — which is what makes "swap the preset
 * and every menu restyles" true rather than a claim about a rebuild.
 */
export function themeVariables(theme: UiTheme): Record<string, string> {
  const tokens = PRESETS[theme.preset];
  return {
    '--hela-bg': tokens.background,
    '--hela-panel': tokens.panel,
    '--hela-panel-border': theme.primaryColor ?? tokens.panelBorder,
    '--hela-text': tokens.text,
    '--hela-text-dim': tokens.textDim,
    '--hela-primary': theme.primaryColor ?? tokens.primary,
    '--hela-on-primary': tokens.onPrimary,
    '--hela-font': theme.fontFamily ?? tokens.font,
    '--hela-radius': tokens.radius,
  };
}

export function panelStyleCss(theme: UiTheme): string {
  return PANEL_STYLES[theme.panelStyle];
}

/** Every preset name, for the editor's picker. */
export const THEME_PRESETS = Object.keys(PRESETS) as Array<UiTheme['preset']>;
