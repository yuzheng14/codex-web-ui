import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Project, SystemInfo } from '../../src/shared/types';
import { confirmCompatibility, controlRuntime, projectGroup } from './helpers';

const longModel = 'private-provider-gpt-5-codex-with-a-very-long-version-name';
const longProject = 'codex-web-ui-项目名称超长时应该保留省略号并支持查看完整名称';

async function configureNames(page: Page, model: string, projectName: string) {
  await page.route('**/api/system', async (route) => {
    const response = await route.fetch();
    const system = (await response.json()) as SystemInfo;
    await route.fulfill({
      response,
      json: {
        ...system,
        models: [...system.models, { ...system.models[0]!, id: model, name: model }],
      },
    });
  });
  await page.route('**/api/projects', async (route) => {
    const response = await route.fetch();
    const projects = (await response.json()) as { data: Project[] };
    await route.fulfill({
      response,
      json: {
        ...projects,
        data: projects.data.map((project) =>
          project.id === 'fixture' ? { ...project, name: projectName } : project,
        ),
      },
    });
  });
  await page.route('**/api/projects/fixture/runtime-settings', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), model, reasoningEffort: 'ultra' },
    });
  });
}

test('switching model names preserves layout and active controls fit on a narrow screen', async ({
  page,
  request,
}) => {
  await controlRuntime(request, { reset: true });
  await configureNames(page, longModel, longProject);
  await page.goto('/');
  await confirmCompatibility(page);
  await projectGroup(page, longProject)
    .getByRole('button', { name: '新建会话', exact: true })
    .click();
  await expect(page.getByText('这个会话准备好了')).toBeVisible();
  const model = page.getByRole('combobox', { name: '模型', exact: true });
  const shortBox = (await model.boundingBox())!;
  const projectBox = (await page.locator('.composer-target').boundingBox())!;
  await model.click();
  await page.getByRole('option', { name: longModel, exact: true }).click();
  await expect(page.locator('.settings-defaults')).toHaveText('已保存为 Codex 新会话默认值');
  expect(await model.boundingBox()).toEqual(shortBox);
  expect(await page.locator('.composer-target').boundingBox()).toEqual(projectBox);

  await page
    .getByRole('textbox', { name: '任务内容', exact: true })
    .fill('[approval] 验证运行状态布局');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  const composer = page.locator('.composer-box');
  for (const width of [1280, 1000, 960, 940, 900, 760, 430, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const group of ['.composer-context', '.composer-send-controls']) {
      let previousRight = 0;
      for (const child of await page.locator(`${group} > *`).all()) {
        const box = await expectInside(child, composer);
        expect(box.x).toBeGreaterThanOrEqual(previousRight);
        previousRight = box.x + box.width;
      }
    }
    expect((await page.locator('.composer-target > span').boundingBox())!.width).toBeGreaterThan(
      30,
    );
  }
  await expect(page.locator('.composer-target > span')).toBeVisible();
  await expect(page.getByRole('button', { name: '追加要求', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await expect(model).toBeEnabled();
});

async function expectInside(control: Locator, container: Locator) {
  const box = (await control.boundingBox())!;
  const bounds = (await container.boundingBox())!;
  expect(box.width).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  return box;
}

for (const model of ['gpt-5', longModel]) {
  for (const projectName of ['测试项目', longProject]) {
    test(`composer keeps ${model === longModel ? 'long' : 'short'} model and ${projectName === longProject ? 'long' : 'short'} project names readable at every width`, async ({
      page,
      request,
    }) => {
      await controlRuntime(request, { reset: true });
      await configureNames(page, model, projectName);
      await page.goto('/');
      await confirmCompatibility(page);
      const modelControl = page.getByRole('combobox', { name: '模型', exact: true });
      const target = page.locator('.composer-target');
      const projectText = target.locator('span');
      const composer = page.locator('.composer-box');
      await expect(modelControl).toHaveAttribute('data-value', model);
      await expect(modelControl).toHaveAttribute('title', `模型：${model}`);
      await expect(target).toHaveAttribute('title', projectName);
      await expect(projectText).toHaveText(projectName);

      for (const width of [1440, 1000, 900, 760, 430, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(projectText).toBeVisible();
        const modelBox = await expectInside(modelControl, composer);
        const projectBox = await expectInside(target, composer);
        expect(modelBox.width).toBeLessThanOrEqual(160);
        expect(projectBox.width).toBeLessThanOrEqual(180);
        expect((await projectText.boundingBox())!.width).toBeGreaterThan(30);
        for (const group of ['.composer-context', '.composer-send-controls']) {
          const children = page.locator(group).locator(':scope > *');
          let previousRight = 0;
          for (const child of await children.all()) {
            const box = await expectInside(child, composer);
            expect(box.x).toBeGreaterThanOrEqual(previousRight);
            previousRight = box.x + box.width;
          }
        }
        expect(
          projectBox.x + projectBox.width <= modelBox.x ||
            projectBox.y + projectBox.height <= modelBox.y,
        ).toBe(true);
        const modelText = page.locator('.settings-model-value');
        expect(
          await modelText.evaluate((element) => element.scrollWidth > element.clientWidth),
        ).toBe(model === longModel);
        expect(
          await projectText.evaluate((element) => element.scrollWidth > element.clientWidth),
        ).toBe(projectName === longProject);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }

      await modelControl.click();
      const menu = page.getByRole('listbox', { name: '模型', exact: true });
      await expect(page.getByRole('option', { name: model, exact: true })).toBeVisible();
      await expect(page.getByRole('option', { name: model, exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const menuBox = (await menu.boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(320);
      await page.keyboard.press('Escape');
      await expect(modelControl).toHaveAttribute('data-value', model);
    });
  }
}
