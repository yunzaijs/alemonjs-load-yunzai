import PluginReadme from '@src/img/views/PluginReadme';
import { getPluginInfo, getYunzaiDir } from '@src/path';
import { createEvent, EventsEnum, Format, useMessage } from 'alemonjs';
import { renderComponentIsHtmlToBuffer } from 'jsxp';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default async (e: EventsEnum) => {
  const event = createEvent({
    event: e,
    selects: ['message.create', 'private.message.create']
  });

  const [message] = useMessage(event);

  // 提取别名：去掉前缀 #yz插件说明
  const alias = e.MessageText.replace(/^(\/|#|＃)(yz|云崽)\s*插件说明\s*/, '').trim();

  if (!alias) {
    const format = Format.create();

    format.addText('用法: #yz插件说明<别名>\n例: #yz插件说明miao');
    void message.send({ format });

    return;
  }

  const plugin = getPluginInfo(alias);

  if (!plugin) {
    const format = Format.create();

    format.addText(`未知插件「${alias}」`);
    void message.send({ format });

    return;
  }

  const readmePath = join(getYunzaiDir(), 'plugins', plugin.dirName, 'README.md');

  if (!existsSync(readmePath)) {
    const format = Format.create();

    format.addText(`${plugin.label} 未安装或没有 README.md`);
    void message.send({ format });

    return;
  }

  const content = readFileSync(readmePath, 'utf-8');

  const img = await renderComponentIsHtmlToBuffer(PluginReadme, {
    data: { label: plugin.label, dirName: plugin.dirName, content }
  });

  if (typeof img === 'boolean') {
    const format = Format.create();
    const md = Format.createMarkdown();

    md.addText('插件说明图片渲染失败，请稍后重试');
    format.addMarkdown(md);
    void message.send({ format });

    return;
  }

  const format = Format.create();

  format.addImage(img);
  void message.send({ format });
};
