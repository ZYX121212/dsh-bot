import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_THEMES, TEAM_THEME_CSS } from '../src/team-theme.mjs';

const luminance = hex => {
  const c = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
};
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const readable = (theme, foreground, background, threshold = 4.5) => {
  const value = contrast(theme[foreground], theme[background]);
  assert.ok(value >= threshold, `${foreground} on ${background}: ${value.toFixed(3)} < ${threshold}`);
};
test('theme maps are immutable, complete and use explicit opaque sRGB colors', () => {
  assert.ok(Object.isFrozen(TEAM_THEMES));
  assert.deepEqual(Object.keys(TEAM_THEMES.light), Object.keys(TEAM_THEMES.dark));
  for (const theme of Object.values(TEAM_THEMES)) {
    assert.ok(Object.isFrozen(theme));
    for (const [key, value] of Object.entries(theme)) { assert.match(key, /^--dt-[a-z-]+$/); assert.match(value, /^#[\da-f]{6}$/i); }
  }
});
for (const [name, theme] of Object.entries(TEAM_THEMES)) {
  test(`${name}: normal, secondary and muted text have at least 4.5:1 across reading surfaces`, () => {
    for (const fg of ['--dt-text', '--dt-secondary', '--dt-muted']) for (const bg of ['--dt-bg', '--dt-side', '--dt-panel-bg', '--dt-card', '--dt-soft', '--dt-well', '--dt-code', '--dt-hover', '--dt-selected']) readable(theme, fg, bg);
  });
  test(`${name}: primary default, hover and pressed labels meet 4.5:1`, () => {
    for (const bg of ['--dt-accent', '--dt-accent-hover', '--dt-accent-pressed']) readable(theme, '--dt-on-accent', bg);
  });
  test(`${name}: state labels are readable on their opaque badge surfaces`, () => {
    for (const state of ['success', 'warning', 'danger']) readable(theme, `--dt-${state}`, `--dt-${state}-soft`);
    readable(theme, '--dt-accent', '--dt-selected'); readable(theme, '--dt-muted', '--dt-soft');
  });
  test(`${name}: state text remains readable directly in roster and header`, () => {
    for (const fg of ['--dt-accent', '--dt-success', '--dt-warning', '--dt-danger']) for (const bg of ['--dt-side', '--dt-bg', '--dt-selected']) readable(theme, fg, bg);
  });
  test(`${name}: selected labels, placeholders, human avatars and selected text meet 4.5:1`, () => {
    readable(theme, '--dt-selected-text', '--dt-selected'); readable(theme, '--dt-muted', '--dt-input'); readable(theme, '--dt-avatar-text', '--dt-avatar-bg'); readable(theme, '--dt-text', '--dt-selection');
  });
  test(`${name}: focus indicators and input boundaries meet 3:1`, () => {
    for (const bg of ['--dt-bg', '--dt-side', '--dt-card', '--dt-input', '--dt-selected', '--dt-soft']) readable(theme, '--dt-focus', bg, 3);
    for (const bg of ['--dt-input', '--dt-bg', '--dt-card']) readable(theme, '--dt-control-line', bg, 3);
  });
  test(`${name}: action icons stay identifiable on normal, selected and hovered surfaces`, () => {
    for (const bg of ['--dt-bg', '--dt-side', '--dt-card', '--dt-selected', '--dt-hover']) readable(theme, '--dt-icon', bg, 3);
    assert.notEqual(theme['--dt-warning'], theme['--dt-accent']); assert.notEqual(theme['--dt-danger'], theme['--dt-warning']);
  });
}
test('system mode has a light default and follows dark OS without overriding explicit themes', () => {
  assert.match(TEAM_THEME_CSS, /\.dt-app\[data-theme=light\],\.dt-app\[data-theme=system\]/);
  assert.match(TEAM_THEME_CSS, /@media\(prefers-color-scheme:dark\)\{\.dt-app\[data-theme=system\]/);
  assert.match(TEAM_THEME_CSS, /\.dt-app\[data-theme=dark\]\{/);
  assert.doesNotMatch(TEAM_THEME_CSS, /:root|\bbody\b|\bhtml\b/);
  assert.ok(TEAM_THEME_CSS.includes(`--dt-bg:${TEAM_THEMES.light['--dt-bg']};`));
  assert.equal(TEAM_THEME_CSS.split(`--dt-bg:${TEAM_THEMES.dark['--dt-bg']};`).length - 1, 2);
});
