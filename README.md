# 燃气调压站巡检、泄漏处置与气量平衡台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环；并新增**气量平衡台**：维护站点上下游连接与方向，导入进出口流量快照，结合当天巡检与泄漏处置单核算区段损耗。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、跟踪漏检；维护区段拓扑、导入流量包、核算区段气量损耗并归档审计。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22809**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Arco Design 2.66 | 表格、表单、Modal、Tag、Badge、Progress |
| 状态管理 | Zustand 4.5 | `stationStore` / `patrolStore` / `leakStore` / `balanceStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1009/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbgaspress
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts
        │                       # segment.ts flowBatch.ts flowSnapshot.ts balance.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts balanceStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        │                       # BalanceSubNav.tsx BalanceStatusTag.tsx BalanceBasisList.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts useFlowImport.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx LeakBoard.tsx PlanList.tsx
        │                       # SegmentList.tsx FlowPacketBoard.tsx BalanceLedger.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts export.ts balance.ts balanceEngine.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、Device | 维护点位上下限/单位/关键点标记（草稿 → 逐条/批量提交并重算历史读数）；按模板批量复制标准值 |
| `/patrols` | 巡检录入 | Patrol、Reading、Point | 选定任务后逐点录入读数，实时偏差率与异常级别；逐点或整批保存；完成巡检、标记漏检、现场备注 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按关键点权重降序排列；勾选批量确认；浓度类点位一键派发泄漏处置单 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 填写处置措施与处置人 → 录入复检浓度判合格闭环；导出处置台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |
| `/balance/segments` | 气量平衡 · 区段拓扑 | Segment、Station | 维护上下游站点连接、方向、管长与超阈值；保存后只重算受影响区段的未归档日期 |
| `/balance/flows` | 气量平衡 · 流量包快照 | FlowBatch、FlowSnapshot、Station | JSON / 手工导入各站进出口流量；读数缺失留空；重复导入只刷新未确认批次；确认后只能追加修订；批次审计 |
| `/balance/ledger` | 气量平衡台账 | BalanceRecord、Segment、FlowBatch | 区段×日期毛/净损耗、超阈标记、待补原因与核算依据；归档保留快照；导出平衡台账 CSV |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`segments`、`flowBatches`、`flowSnapshots`、`balanceRecords`
- **数据结构版本**：`DB_VERSION = 3`
  - `version(1)` → `version(2)`：补齐 `revision`、用所属设备回填点位与处置单的 `stationId` 冗余列、按标准区间重算历史读数
  - `version(3)`：新增气量平衡四张表（区段拓扑 / 流量批次 / 流量快照 / 核算记录），历史数据无需迁移
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位 → 8 次巡检 → 11 条读数 → 3 张泄漏处置单 → 1 个区段 → 3 个流量批次 → 6 条站点快照 → 3 条区段核算记录（含已归档、沿用待补、临时超阈三种样例）的完整链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22809
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

## 七、判定口径

- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空

### 气量平衡核算口径（`utils/balance.ts` 纯函数 + `utils/balanceEngine.ts` 引擎）

- 毛损耗 = 上游站**出口**流量 − 下游站**进口**流量；净损耗 = 毛损耗 − 已核销泄漏损耗（m³/日）
- **读数缺失不算 0**：当日某端口读数未抄回（快照值为空）时，向更早的**已确认**批次沿用最近一个有效值，并标记「沿用 · 待补依据」；没有任何可沿用依据时毛/净损耗记为「待补」（null），绝不记 0
- **处置未复检不核销**：只有当日「已复检且复检值 ≤ 50 ppm」的泄漏处置单才按浓度 × `0.5 m³/ppm` 核销泄漏损耗；待处置/已处置/复检不合格的单据列入「待补依据」，损耗不得被抵减
- 当日流量只来自**未确认批次**时结果标「临时值」，批次确认后自动转正；当日任一端站点缺少「已完成」巡检也列待补
- **只重算受影响的未归档日期**：拓扑更新重算该区段；流量包/巡检/处置更新重算该日期起（沿用会波及更晚日期）的未归档记录；`archived` 已归档记录保留核算快照不动
- **批次审计**：同一批次号重复导入只刷新「已导入（未确认）」结果；确认后拒绝覆盖、只能「追加修订说明」（只追加不改写历史，修订作为核算依据展示）
- **导入事务安全**：流量包导入在单个 Dexie 读写事务内完成并在同事务重算；任一步骤失败自动回滚，并把导入前的批次/快照恢复回库（恢复导入前状态）
- 超阈判定：净损耗 > 区段 `thresholdM3`（默认 300 m³/日）台账标「超阈」
