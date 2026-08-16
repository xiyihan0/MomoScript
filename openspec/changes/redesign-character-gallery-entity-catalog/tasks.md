## 1. 合同与数据边界

- [x] 1.1 写 `character-gallery` spec delta，固定 Catalog discovery/binding/fallback、横向列表、双列详情与插入权限
- [x] 1.2 实现 `galleryEntityCatalog.ts` 严格 parser、manifest binding、ETag/cache loader
- [x] 1.3 在 `main.ts` 的 manifest acceptance 后加载可选 Catalog，保持单一 `galleryPacks` 状态源
- [x] 1.4 扩展 `galleryPack.ts` 展示投影，保持 resolver-safe manifest 字段不变

## 2. 角色图鉴界面

- [x] 2.1 将实体 grid 改为 native 横向行列表，增加国服名称、affiliation、差分数和数据来源
- [x] 2.2 增加 Pack/学校/关系筛选与 Catalog alias 搜索，保留 48 项分页和 lazy avatar
- [x] 2.3 将差分详情改为默认双列大图，增加 alternate-skin 跳转和稳定选择 identity
- [x] 2.4 显示活动 MMT 路径/行列；非 MMT 时禁用 variant，命令 guard 与插入字符串不变
- [x] 2.5 保留 Ctrl+滚轮缩放并增加可见控制，完成 240–320 px 响应式样式
- [x] 2.6 增加折叠式基础/换装与差分数量筛选，移除单 Pack namespace 重复标签，并以 NFKC/大小写无关方式搜索全部 Catalog 语言名称
- [x] 2.7 在实体横向行显示差分总数，并仅对多 sticker set 实体追加套组数量

## 3. 合同与浏览器验证

- [x] 3.1 新增 parser/loader Node 合同，覆盖正负 schema、binding、URL、ETag、cache/fallback
- [x] 3.2 新增 digest-bound E2E Catalog fixture，更新 gallery route
- [x] 3.3 扩展 Playwright：horizontal rows、zh-CN、alias/filter、two-column、keyboard、target/disabled、fallback、no Kivo request
- [x] 3.4 运行 `openspec validate redesign-character-gallery-entity-catalog --strict`、`npm run test:gallery-entity-catalog`、`npm run check`
- [x] 3.5 运行 shared `test:pack-sync`、focused gallery Playwright、完整 local E2E 与 production build
