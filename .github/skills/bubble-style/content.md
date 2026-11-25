# bubble-style 参考细节

> 本文件是 [SKILL.md](SKILL.md) 的详细补充：组件 API、页面模板示例、反例、验证命令与对照图流程。
> 与源码冲突时以源码为准；规则冲突时以 [DESIGN.md](../../../docs/bubble-style/DESIGN.md) 为准。

---

## 1. 组件 API

入口：`src/response/presentation/index.ts`

| 导出                             | 用途                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `buildBubble(input)`             | 通用气泡骨架：标题、状态徽章、单/多段引用块、页脚、导航、键盘 |
| `section(input)`                 | 单个引用块：对象行 + 编号 + 标记 + 状态 + 事实行 + 行内按钮   |
| `listBubble(input)`              | 列表页：标题 + 多条目 + 分页 + 页脚                           |
| `detailBubble(input)`            | 详情/单对象页：单块事实行 + 页脚动作                          |
| `confirmBubble(input)`           | 确认页：目标/代价 + ⚠️风险 + 确认/取消同块 + 返回             |
| `resultBubble(input)`            | 结果页：标题 + 状态徽章 + 结果行 + 奖励                       |
| `errorBubble(input)`             | 错误页：`<动作> · 未完成 ❌` + 原因/建议同块                  |
| `noticeBubble(input)`            | 主动通知：标题 ` · 通知`、正文引用块、操作单独一行、无键盘    |
| `titleWithStatus(title, status)` | 标题追加四态符号                                              |
| `noticeTitle(title)`             | 通知标题追加 ` · 通知`                                        |
| `errorTitle(operation)`          | `<动作> · 未完成`（operation 前缀映射）                       |

### `section(input)`

```ts
type BubbleSection = {
  title?: string; // 对象名（加粗）
  id?: string | number; // 对象编号 → ` #123`（不加粗）
  suffix?: string; // 对象标记/视角 → ` · 进攻方`、`🔒`
  status?: 'done' | 'fail' | 'skip' | 'warn' | 'none';
  lines: string[]; // 事实行，必须带标签
  actions?: BubbleAction[]; // 条目级按钮 ≤3（背包类 ≤4）
};
```

渲染顺序：`加粗名称` → ` #编号` → 状态符号 → ` 标记` → 事实行 → 行内按钮。

### `buildBubble(input)` 关键字段

```ts
{
  isPrivate?: boolean; bid?: string; mention?: boolean;
  title?: string;
  status?: BubbleStatus;
  sections: BubbleSection[];
  nav?: { current: number; total?: number; count?: number; command: string };
  footer?: GuiButton[] | GuiButton[][];
  keyboard?: GuiButton[] | GuiButton[][];
  bar?: GuiButton[] | false;
}
```

`buildBubble` 内部委托 `FormatGui`，保留 `featureVisibility` 过滤与按钮紧凑逻辑。

---

## 2. 页面模板示例

### 2.1 列表页

```ts
void message.send(
  listBubble({
    isPrivate,
    bid,
    title: `宗门成员 · ${guildName}`,
    items: members.map(member => ({
      title: `${role} · ${member.userName}`,
      id: member.userId,
      lines: [`日活：${member.dailyActivity} · 周活：${member.weeklyActivity}`],
      actions:
        member.userId !== userId
          ? [
              { label: '查看', command: `/查看信息 ${member.userId}` },
              { label: '飞信', command: `/发飞信 ${member.userId} ` }
            ]
          : []
    })),
    nav: { current, total, count: total, command: '/宗门成员列表 {page}' },
    footer: [{ label: '返回', command: '/我的宗门' }]
  })
);
```

### 2.2 单对象页（主页、储物袋总览）

```ts
void message.send(
  buildBubble({
    isPrivate,
    bid,
    title: '储物袋',
    sections: [{ lines: [serverText] }], // 服务端文案原样
    footer: tabs,
    bar: false
  })
);
```

### 2.3 确认页

```ts
void message.send(
  confirmBubble({
    isPrivate,
    bid,
    title: '结为道侣 · 待确认',
    targetLines: [`对象：${name}`],
    costLines: ['消耗：同心结 ×1'],
    riskLines: ['确认后不可撤销'],
    actions: [
      { label: '确认', command: confirmCommand },
      { label: '取消', command: cancelCommand }
    ],
    footer: [{ label: '返回', command: '/我的好友' }]
  })
);
```

### 2.4 结果页 / 错误页 / 通知

```ts
resultBubble({ title: '悬赏发布成功', status: 'done', id: bountyId, lines: ['支付：100灵晶 · 手续费：5灵晶'] });
errorBubble({ title: errorTitle('guild.members'), reason: reasonText, advice: tips, actions, footer });
noticeBubble({ title: noticeTitle(serverTitle), lines: bodyLines, actions });
```

---

## 3. 事实行标签表（DESIGN §5.9）

- 时间：`时间` `完成` `申请时间` `解锁`
- 结果/状态：`结果` `状态` `反击状态` `反击截止`
- 对象属性：`数量` `品级` `等级` `境界` `修为` `属性` `类型` `关系` `灵犀` `玩法` `条件`
- 数值：`赏金` `每份` `剩余份数` `剩余` `损失` `物品` `消耗` `费用` `支付` `手续费` `赏金池` `每人` `名额` `有效期` `今日剩余` `灵石收益` `物品机会` `战斗` `回合数` `掉落`
- 列表：`人数` `门槛` `日活` `周活` `称号` `简介` `入宗要求` `申请编号` `申请时间` `待审核` `说明` `宝箱`
- 成就/成长：`进度` `奖励` `完成` `完成率` `待领取` `战力` `目标战力` `还差`
- 词条：`分类` `作者` `编辑` `最后编辑`

新增标签必须同步 `DESIGN.md` 表；不允许多写法（`战斗结果`/`创建时间`/`物品状态` 都要改）。

---

## 4. 符号集合

| 用途         | 符号                                         |
| ------------ | -------------------------------------------- |
| 状态（四态） | `✅` `❌` `·` `⚠️`                           |
| 奖励/获得    | `🎁`                                         |
| 锁定/上架    | `🔒` `📦`（📦 仅表示上架标记，不作装饰）     |
| 通知来源     | `📬` `🤝` `⚔️` `🏯` `💕` `🌿` `☠️` `✉️` `🔔` |
| 排行         | `🥇🥈🥉`（仅排行榜/第 1-3 名）               |

**禁止**：`🎉` `✨` `💰` `📋` `📂` `💡` `✊` 等装饰性符号出现在标题或状态位。

---

## 5. 分页与返回

### 分页

```ts
nav: { current: page, total: totalPages, count: total, command: '/xx {page}' }
```

渲染：

- `第X/Y页 · 共N条 ‹上一页› ‹下一页›`
- 无 count：`第X/Y页 ‹上一页› ‹下一页›`
- 游标：`第X页 ‹下一页›`

禁止：`md.addText('第 1/2 页')`、自建 `上一页/下一页` 按钮（含页脚 helper）。

### 返回

- 一律写 `footer`，首行第一个。
- `FormatGui` 会把 `header` 里 label 含「返回」的按钮移到 footer 首行（兜底），但**新代码不要依赖兜底**。
- 页脚 `返回` 与键盘/页面动作重复时按命令去重。

---

## 6. 按钮预算

| 位置               | 预算                      |
| ------------------ | ------------------------- |
| header（Z2）       | ≤3                        |
| 引用块内（每条目） | ≤3（背包条目 ≤4）         |
| 页脚               | ≤2 行                     |
| 普通页总数         | ≤10（不含 5 个键盘）      |
| 主页               | ≤18（不含 5 个键盘 → 23） |

命令长度：`[...command].length ≤ 80`（AGENTS.md 故障复盘约束）。

---

### 6.1 引用块使用（硬规则）

- 结果/通知/服务端消息正文**必须放在引用块内**；标题只放页面名 + 状态。
- 裸文本行只用于分隔提示、代码/回放正文、极短补充。
- 反例：`md.addText('物品：聚灵丹')` 直接平铺在引用块外 → 正确：`md.addBlockquote(Format.createMarkdown().addText('物品：聚灵丹\n结果：锁定成功'))`。

### 6.2 长列表分页（硬规则，2026-11-03）

- 条目数**可能超过 8 条**的列表页必须分页；禁止一次渲染全部条目。
- 标准写法：`nav: { current, total, count?, command: '/xx {page}' }`，由 `FormatGui` 统一渲染。
- 适用：背包各分类、邮件、好友、悬赏、订单、战斗/领取记录、宗门成员/精华/日志、排行榜（>10）、秘境列表。
- 反例：`items.forEach(...)` 全塞进气泡且无 `nav`；或手写「第 X/Y 页」。
- 分页按钮不进页脚；页脚只放页面级动作。

## 7. 正反例

```ts
// ❌ 反例：手写行、无标签、ID 独立行、返回在 header
md.addText(`【${guild.id}】${guild.name}-${level}`);
md.addText(`ID:${id}  日活:${x}`);
FormatGui({ header: [{ label: '返回', command: '/我的宗门' }], content: md });

// ✅ 正例
buildBubble({
  title: '宗门列表',
  sections: [
    {
      title: guild.name,
      id: guild.id,
      lines: [`等级：${level} · 人数：${memberCount}`, `日活：${x}`],
      actions: [{ label: '加入', command: `/加入宗门 ${guild.id}` }]
    }
  ],
  footer: [{ label: '返回', command: '/我的宗门' }]
});
```

```ts
// ❌ 反例：装饰符号 + 裸状态行
md.addText(`🎉 ${item.name}：签到成功`);
md.addBlockquote(createQuoteMarkdown([`${item.name}`, `已开放`]));

// ✅ 正例
section({ title: item.name, status: 'done', lines: ['签到成功'] });

// ❌ 反例：手写分页
md.addText(`第 ${page}/${totalPages} 页`);
footer: [{ label: '上一页', command: ... }]

// ✅ 正例
nav: { current: page, total: totalPages, count: total, command: '/xx {page}' }
```

---

## 8. 验证与对照图流程

```bash
# 1. 类型
node node_modules/@typescript/native/bin/tsc --noEmit

# 2. lint / 格式化
npx prettier --write <files>
npx eslint <files> --ext .ts --fix --max-warnings=0

# 3. 定向测试（按域）
node tools/run-framework-tests.mjs --filter=presentation-primitives --offline
node tools/run-framework-tests.mjs --filter=<域> --offline

# 4. 基线对照（必要时）
git stash push -- <迁移文件> && node tools/run-framework-tests.mjs --filter=<域> --offline && git stash pop
```

**对照图（用户硬性要求）**

- 每次改动必须给「改前 vs 改后」左右对照图。
- 渲染/截图脚本与 PNG 放仓库外 `D:\data\alemone\bubble-style-mockups`（HTML+CSS 模拟 QQ 消息卡片，headless Edge 截图，Pillow 拼接）。
- 仓库内只保留可提交代码与 `docs/**`。
- 报告需区分：源码修复 / 定向测试 / 实机确认（用户已要求跳过实机核对）。

---

## 9. 页面类型判定表

| 现象                    | 模板                                |
| ----------------------- | ----------------------------------- |
| 多条同构条目 + 分页     | `listBubble`                        |
| 一个对象 + 多行属性     | `detailBubble` / `buildBubble` 单块 |
| 需要确认后执行          | `confirmBubble`（必须给取消/返回）  |
| 执行完成                | `resultBubble`                      |
| 业务拒绝/不可用         | `errorBubble`                       |
| 主动推送（通知）        | `noticeBubble`                      |
| 目录/入口列表（多分类） | `listBubble` + 单块入口行           |
