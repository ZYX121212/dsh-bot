import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { TEAM_THEMES } from '../src/team-theme.mjs';

export async function auditWorkspaceColors(page, { check, artifacts }) {
  const originalDraft = await page.getByRole('textbox', { name: '给 Bot 发消息', exact: true }).inputValue();
  const promptCount = await page.evaluate(() => window.__fixture.stats.prompts.length);
  const cases = [];
  const expectedRgb = color => `rgb(${color.slice(1).match(/../g).map(x => parseInt(x, 16)).join(', ')})`;
  for (const [setting, os, expected, screenshot] of [
    ['light', 'light', 'light', 'team-palette-light.png'],
    ['dark', 'light', 'dark', 'team-palette-dark.png'],
    ['light', 'dark', 'light'],
    ['system', 'dark', 'dark'],
    ['system', 'light', 'light'],
  ]) {
    await page.emulateMedia({ colorScheme: os, reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '工作空间设置', exact: true }).click();
    await page.getByLabel('外观', { exact: true }).selectOption(setting);
    await page.waitForFunction(value => document.querySelector('.dt-app')?.dataset.theme === value, setting);
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    const result = await page.evaluate(({ palette, expected }) => {
      const app = document.querySelector('.dt-app'), style = getComputedStyle(app), failures = [], measurements = [];
      const rgb = value => value.startsWith('#') ? value.slice(1).match(/../g).map(n => parseInt(n, 16)) : value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      const same = (a, b) => JSON.stringify(rgb(a)) === JSON.stringify(rgb(b));
      const lum = value => { const c = rgb(value).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      for (const [key, value] of Object.entries(palette)) if (style.getPropertyValue(key).trim() !== value) failures.push(`${key} token mismatch`);
      if (style.colorScheme !== expected) failures.push(`native color-scheme ${style.colorScheme}`);
      const probe = document.createElement('div'); probe.inert = true; probe.setAttribute('aria-hidden', 'true');
      Object.assign(probe.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none' }); app.append(probe);
      const add = (tag, classes, parent = probe) => { const node = document.createElement(tag); node.className = classes; node.textContent = tag === 'input' ? '' : 'Test'; parent.append(node); return node; };
      const expect = (name, node, properties, threshold) => {
        const css = getComputedStyle(node), value = { name, color: css.color, background: css.backgroundColor };
        for (const [property, token] of Object.entries(properties)) if (!same(css[property], palette[token])) failures.push(`${name} ${property}: ${css[property]} != ${palette[token]}`);
        if (threshold) { value.contrast = ratio(css.color, css.backgroundColor); if (value.contrast < threshold) failures.push(`${name} contrast ${value.contrast}`); }
        measurements.push(value);
      };
      try {
        expect('primary', add('button', 'dt-button dt-button-primary'), { color: '--dt-on-accent', backgroundColor: '--dt-accent' }, 4.5);
        const disabled = add('button', 'dt-send-button'); disabled.disabled = true;
        expect('disabled-send', disabled, { color: '--dt-disabled-text', backgroundColor: '--dt-disabled' });
        if (getComputedStyle(disabled).opacity !== '1') failures.push('disabled opacity cascaded twice');
        expect('selected-roster', add('button', 'dt-bot-row dt-bot-selected'), { color: '--dt-selected-text', backgroundColor: '--dt-selected' }, 4.5);
        expect('selected-nav', add('button', 'dt-nav-home dt-nav-selected'), { color: '--dt-selected-text', backgroundColor: '--dt-selected' }, 4.5);
        const tablist = add('div', 'dt-tabs'), tab = add('button', '', tablist); tab.setAttribute('aria-selected', 'true');
        expect('selected-tab', tab, { color: '--dt-accent', backgroundColor: '--dt-card', borderBottomColor: '--dt-accent' }, 4.5);
        const vocabulary = [['thinking', 'accent', 'selected'], ['researching', 'accent', 'selected'], ['coding', 'accent', 'selected'], ['writing', 'accent', 'selected'], ['working', 'accent', 'selected'], ['waiting', 'warning', 'warning-soft'], ['queued', 'muted', 'soft'], ['completed', 'success', 'success-soft'], ['error', 'danger', 'danger-soft'], ['offline', 'muted', 'soft'], ['stopped', 'muted', 'soft']];
        const row = add('div', 'dt-bot-row-copy'), title = add('div', 'dt-conversation-title');
        for (const [state, foreground, background] of vocabulary) {
          const properties = { color: `--dt-${foreground}`, backgroundColor: `--dt-${background}` };
          expect(`badge-${state}`, add('span', `dt-presence-badge dt-presence-${state}`), properties, 4.5);
          expect(`roster-${state}`, add('small', `dt-roster-presence dt-presence-${state}`, row), { color: `--dt-${foreground}` });
          expect(`header-${state}`, add('small', `dt-roster-presence dt-presence-${state}`, title), { color: `--dt-${foreground}` });
        }
        const taskList = add('div', 'dt-home-tasks');
        for (const [state, foreground, background] of [['running', 'accent', 'selected'], ['queued', 'muted', 'soft'], ['waiting', 'warning', 'warning-soft'], ['completed', 'success', 'success-soft'], ['failed', 'danger', 'danger-soft']]) {
          const task = add('span', `dt-task-status dt-status-${state}`, taskList);
          expect(`task-${state}`, task, { color: `--dt-${foreground}`, backgroundColor: `--dt-${background}` }, 4.5);
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); task.append(icon);
          expect(`task-icon-${state}`, icon, { color: `--dt-${foreground}` });
        }
        expect('human-avatar', add('span', 'dt-user-avatar'), { color: '--dt-avatar-text', backgroundColor: '--dt-avatar-bg' }, 4.5);
        expect('account-avatar', add('span', 'dt-account-avatar'), { color: '--dt-avatar-text', backgroundColor: '--dt-avatar-bg' }, 4.5);
        expect('error-banner', add('div', 'dt-banner dt-banner-error'), { color: '--dt-danger', backgroundColor: '--dt-danger-soft' }, 4.5);
        expect('inline-error', add('div', 'dt-alert'), { color: '--dt-danger', backgroundColor: '--dt-danger-soft' }, 4.5);
        expect('actual-modal', add('div', 'dt-modal'), { color: '--dt-text', backgroundColor: '--dt-card' }, 4.5);
        expect('form-input', add('input', 'dt-input'), { color: '--dt-text', backgroundColor: '--dt-input', borderColor: '--dt-control-line' }, 4.5);
        const picker = add('div', 'dt-group-picker'), box = add('input', '', picker); box.type = 'checkbox';
        if (!same(getComputedStyle(box).accentColor, palette['--dt-accent'])) failures.push('checkbox native accent mismatch');
      } finally { probe.remove(); }
      return { failures, measurements, scheme: style.colorScheme };
    }, { palette: TEAM_THEMES[expected], expected });
    if (result.failures.length) console.error({ setting, os, failures: result.failures });
    const label = `${setting} theme / ${os} OS`;
    check(`${label}: actual component colors and semantic labels match the palette`, result.failures.length === 0);
    const composer = page.getByRole('textbox', { name: '给 Bot 发消息', exact: true });
    await composer.fill('配色检查');
    await composer.focus();
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.dt-compose')).borderTopColor === color, expectedRgb(TEAM_THEMES[expected]['--dt-focus']));
    const focus = await page.locator('.dt-compose').evaluate(el => ({ border: getComputedStyle(el).borderTopColor, expected: getComputedStyle(el.closest('.dt-app')).getPropertyValue('--dt-focus').trim(), shadow: getComputedStyle(el).boxShadow }));
    check(`${label}: compound input focus uses the theme ring`, focus.border === expectedRgb(TEAM_THEMES[expected]['--dt-focus']) && focus.shadow !== 'none');
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await send.hover();
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.dt-send-button')).backgroundColor === color, expectedRgb(TEAM_THEMES[expected]['--dt-accent-hover']));
    const hover = await send.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, opacity: getComputedStyle(el).opacity }));
    check(`${label}: real send-button hover is readable and not faded`, hover.background === expectedRgb(TEAM_THEMES[expected]['--dt-accent-hover']) && hover.opacity === '1');
    await page.mouse.move(0, 0);
    await composer.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    const keyboard = await send.evaluate(el => ({ focused: document.activeElement === el, color: getComputedStyle(el).outlineColor, width: getComputedStyle(el).outlineWidth, style: getComputedStyle(el).outlineStyle }));
    check(`${label}: keyboard focus remains visible`, keyboard.focused && keyboard.color === expectedRgb(TEAM_THEMES[expected]['--dt-focus']) && keyboard.width === '2px' && keyboard.style === 'solid');
    await composer.fill('');
    await send.hover();
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.dt-send-button')).backgroundColor === color, expectedRgb(TEAM_THEMES[expected]['--dt-disabled']));
    const disabled = await send.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, opacity: getComputedStyle(el).opacity }));
    check(`${label}: disabled hover retains explicit disabled colors`, disabled.background === expectedRgb(TEAM_THEMES[expected]['--dt-disabled']) && disabled.color === expectedRgb(TEAM_THEMES[expected]['--dt-disabled-text']) && disabled.opacity === '1');
    await page.mouse.move(0, 0);
    await composer.fill(originalDraft);
    cases.push({ setting, os, expected, ...result });
    if (screenshot) {
      await page.getByRole('button', { name: 'dsh-bot', exact: true }).click();
      await page.screenshot({ path: resolve(artifacts, screenshot) });
      await page.locator('.dt-bot-row').filter({ hasText: 'Milo' }).first().click();
    }
  }
  check('Palette switching never sends or replays native prompts', await page.evaluate(() => window.__fixture.stats.prompts.length) === promptCount);
  await page.getByRole('button', { name: '工作空间设置', exact: true }).click();
  await page.getByLabel('外观', { exact: true }).selectOption('light');
  await page.waitForFunction(() => document.querySelector('.dt-app')?.dataset.theme === 'light');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await writeFile(resolve(artifacts, 'palette-browser-audit.json'), JSON.stringify({ kind: 'fixture-component-color-audit', cases }, null, 2));
}
