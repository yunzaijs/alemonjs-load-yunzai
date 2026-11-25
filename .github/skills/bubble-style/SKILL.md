---
name: bubble-style
description: 新增或修改 QQ 气泡展示时的排版规范：涉及 src/response 的 res.ts、列表/详情/结果/通知/错误页、分页、按钮与符号时先启用。
---

## 这是做什么的

本 skill 规定**新气泡怎么排版**，保证后续新增页面与已统一的 40+ 页保持一致。

- 规范总纲：[DESIGN.md](../../../docs/bubble-style/DESIGN.md)
- 实现细节、组件 API、正反例与验证命令：[content.md](content.md)
- 迁移进度与决策记录：[BATCH-0.md](../../../docs/bubble-style/BATCH-0.md) … `BATCH-2.md`

这里的 `bubble-style` 指**展示层排版规范**，与游戏玩法/数值无关。

---

## 分层前提

| 层           | 落点                           | 职责                                             |
| ------------ | ------------------------------ | ------------------------------------------------ |
| 服务端       | `../xiuxian-game-server/**`    | 业务真相、文案、结算                             |
| 投影         | `src/response-apps/**/app.ts`  | 接口数据 → 页面输入                              |
| **气泡排版** | `src/response/**/res.ts`       | 组装标题/事实行/按钮/分页                        |
| **渲染组件** | `src/response/presentation/**` | `buildBubble`/`section`/presets                  |
| 渲染骨架     | `src/utils/messageHelper.ts`   | `FormatGui`、`createQuoteMarkdown`、`addOptions` |

**边界 B**：服务端 text/quote 一字不改，只调整客户端容器与排版。

---

## 十条硬性规则

1. **优先组件**：新页面用 `buildBubble` / `listBubble` / `detailBubble` / `confirmBubble` / `resultBubble` / `errorBubble` / `noticeBubble`，不再手拼 `createQuoteMarkdown`。
2. **单对象页禁分组标题**：主页/详情/面板一个引用块，空行分段；`目标/代价/风险` 等语义段例外。
3. **列表对象行**：`**名称**`（不是 `【名称】`），一个对象一个引用块。
4. **编号并入对象行**：`section({ title, id })` → `**名称** #123`；序号同样 `#N`；禁止 `ID：` / `序号：` 单独成行。
5. **事实行必带标签**：`时间：` / `结果：` / `数量：` / `状态：` …；标签只用 DESIGN §5.9 表内词，同一含义不得多写法。
6. **视角标签 V3**：`**阿青** #12 · 进攻方`（`suffix`），不要塞进标题或事实行首。
7. **返回置底**：`返回*` 按钮只写 `footer`；误写 `header` 时 `FormatGui` 会兜底移动，但新代码不要依赖兜底。
8. **分页只用 nav**：`nav: { current, total, count?, command: '/xx {page}' }`，自动渲染 `第X/Y页 · 共N条 ‹上一页›‹下一页›`；禁止手写页码/翻页按钮。
9. **符号受控**：四态 `✅ ❌ · ⚠️`、奖励 `🎁`、锁定 `🔒`、通知图标；禁止 `🎉 ✨ 💰 📦` 等装饰符号。
10. **按钮预算**：header ≤3、逐条目 ≤3（背包 ≤4）、页脚 ≤2 行、普通页 ≤10（+5 键盘）、主页 ≤18；命令 ≤80 Unicode 字符（AGENTS.md）。
11. **长列表必须分页**：条目数可能超过 8 条的任何列表页（背包、邮件、好友、订单、记录、悬赏等）必须提供 `nav` 分页，不允许一次性铺满屏幕；格式见 DESIGN §5.9.2。

---

## 玩家输入与 QQ 输出安全

- 搜索结果、空结果、参数错误、审核拒绝和后端失败使用固定提示。禁止回显玩家原始消息、自由文本参数或命中的违禁词。业务确需展示的玩家创作内容必须通过对应审核链路。
- 标题、正文、通知、按钮标签、按钮指令、分页和链接参数均为输出。按钮只用固定指令、已校验的标识或服务端短引用。重新编辑保留对象或会话标识，提示玩家重新输入正文。
- 用无害占位词覆盖失败和成功分支，检查真实发送节点及按钮载荷。后端输出若含原始输入，须追溯其来源，并考虑兼容旧服务端返回。

## 组件速查

```ts
import { buildBubble, section } from '@src/response/presentation/index';
import { listBubble } from '@src/response/presentation/presets';

// 列表页
message.send(
  listBubble({
    isPrivate,
    bid,
    title: '队伍列表',
    items: teams.map(team => ({
      title: `${team.leaderName}的队伍`,
      id: team.teamId,
      lines: [`人数：${team.memberCount}/${team.maxMembers} · 门槛：${team.minRealmName ?? '无'}`],
      actions: [{ label: '查看', command: `/队伍信息 ${team.teamId}` }]
    })),
    nav: { current, total, command: '/队伍列表 {page}' },
    footer
  })
);

// 单对象页
message.send(
  buildBubble({
    isPrivate,
    bid,
    title: '储物袋',
    sections: [{ title: '聚灵丹', id: 101, lines: ['数量：×5 · 品级：玄品'] }],
    bar: false
  })
);
```

更多示例与反例见 [content.md](content.md)。

---

## 新增气泡自检清单（提交前逐条打勾）

- [ ] 用了 presentation 组件，而不是裸 `createQuoteMarkdown`。
- [ ] 标题无 `【】`；对象行 `**名称** #ID`；无 `ID：`/`序号：` 独立行。
- [ ] 所有事实行都有 DESIGN §5.9 标签。
- [ ] `返回*` 在 footer；分页走 `nav`；无手写页码。
- [ ] 状态用四态符号，无装饰 emoji。
- [ ] 按钮未超预算，未删既有功能入口（零阉割）。
- [ ] 服务端文案原样保留。
- [ ] `tsgo`、`yarn lint:fix`、相关离线测试通过；与迁移前基线对比无新增失败。
- [ ] 出了「改前 / 改后」对照图（产物放仓库外 `bubble-style-mockups`）。
- [ ] `docs/bubble-style/BATCH-*.md` 已记录；新标签已补进 `DESIGN.md §5.9`。

---

## 明确禁止

- 手写 `【】`、`ID：xxx`、`序号：xxx`、裸值行。
- `返回` 写进 header；分页按钮写进 footer。
- `🎉/✨/💰/📦` 当状态或装饰；用 `⭐` 表示状态（星级除外）。
- 改写服务端正文；为统一样式删除按钮/功能入口。
- 在仓库内提交模拟图、截图脚本、临时 CSV（放仓库外）。
