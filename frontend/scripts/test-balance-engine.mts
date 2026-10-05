/* 引擎纯函数冒烟测试：node 直跑（tsx/esbuild 不可用时用简单转译） */
import assert from 'node:assert'
import { recomputeBalances, findCarry } from '../src/utils/balanceEngine.ts'

const stations = [
  { id: 'st-1', name: '城东' },
  { id: 'st-2', name: '西城' }
]
const segment = {
  id: 'sg-1',
  name: '连通段',
  upstreamStationId: 'st-1',
  downstreamStationId: 'st-2',
  lossRateThresholdPct: 3,
  remark: '',
  createdAt: 1,
  updatedAt: 1
}
const batch = (id, no, date, state = '待确认') => ({
  id,
  batchNo: no,
  bizDate: date,
  collector: 'c',
  source: 's',
  state,
  importedAt: 1,
  confirmedAt: state === '已确认' ? 2 : null,
  confirmedBy: state === '已确认' ? '值班长' : '',
  snapshotCount: 2,
  auditTrail: [],
  createdAt: 1,
  updatedAt: 1
})
const snap = (batchId, stationId, inlet, outlet) => ({
  id: `${batchId}-${stationId}`,
  batchId,
  stationId,
  inletFlowM3h: inlet,
  outletFlowM3h: outlet,
  note: '',
  createdAt: 1,
  updatedAt: 1
})
const leak = (id, date, state) => ({
  id,
  stationId: 'st-2',
  concentrationPpm: 80,
  foundTime: date,
  state,
  retestValuePpm: state === '已复检' ? 30 : 0,
  measure: 'm',
  handler: 'h'
})

// 场景：已确认 06-01 正常 -> 06-02 超阈已确认 -> 06-03 读数缺失 -> 06-04 处置未复检 -> 06-05 复检后恢复
const batches = [
  batch('b1', 'B1', '2024-06-01', '已确认'),
  batch('b2', 'B2', '2024-06-02', '已确认'),
  batch('b3', 'B3', '2024-06-03'),
  batch('b4', 'B4', '2024-06-04'),
  batch('b5', 'B5', '2024-06-05')
]
const snapshots = [
  snap('b1', 'st-1', 7800, 7650), snap('b1', 'st-2', 7576, 7200), // 0.97%
  snap('b2', 'st-1', 7800, 7600), snap('b2', 'st-2', 7340, 7000), // 3.42% 超阈
  snap('b3', 'st-1', 7800, 7500), snap('b3', 'st-2', null, 7000), // 下游进口缺失
  snap('b4', 'st-1', 7800, 7500), snap('b4', 'st-2', 7400, 7000), // 有未复检泄漏
  snap('b5', 'st-1', 7800, 7500), snap('b5', 'st-2', 7420, 7000) // 复检后
]

function run(existing) {
  return recomputeBalances({
    segments: [segment],
    stations,
    batches,
    snapshots,
    patrols: [],
    leaks: [
      { id: 'l1', stationId: 'st-2', concentrationPpm: 80, foundTime: '2024-06-04', state: '待处置', retestValuePpm: 0, measure: '', handler: '' }
    ],
    existing,
    now: 1000
  })
}

// 初始：空库（模拟播种后补算未确认），已确认行会冻结补齐
const first = run([])
const byDate = Object.fromEntries(first.upserts.map((r) => [r.bizDate, r]))
assert.ok(byDate['2024-06-01'].archived === true, '06-01 归档')
assert.ok(Math.abs(byDate['2024-06-01'].lossRatePct - 0.97) < 0.01, '06-01 损耗率 0.97%')
assert.ok(byDate['2024-06-02'].archived && byDate['2024-06-02'].overThreshold, '06-02 归档且超阈')
assert.ok(byDate['2024-06-03'].status === '待补依据', '06-03 读数缺失 -> 待补')
assert.ok(byDate['2024-06-03'].lossM3h === null, '待补损耗必须为 null，不能是 0')
assert.ok(byDate['2024-06-03'].carryFrom?.batchNo === 'B2', '06-03 沿用上一有效批次 B2')
assert.ok(byDate['2024-06-04'].status === '待补依据', '06-04 未复检 -> 待补')
assert.ok(/尚未复检/.test(byDate['2024-06-04'].pendingReasons.join()), '未复检原因')
assert.ok(byDate['2024-06-04'].carryFrom?.batchNo === 'B2', '06-04 沿用最近有效 B2')
assert.ok(byDate['2024-06-05'].status === '已核算', '06-05 无关联泄漏，正常核算')

// 签名增量：同样输入再跑，未确认行签名不变 -> 不产生 upsert
const allRows = first.upserts
const second = run(allRows)
assert.ok(second.upserts.length === 0, `输入不变不应重算，实际 upserts=${second.upserts.length}`)

// 泄漏复检完成后：06-04 依据补齐 -> 变为已核算
const afterRetest = recomputeBalances({
  segments: [segment],
  stations,
  batches,
  snapshots,
  patrols: [],
  leaks: [
    { id: 'l1', stationId: 'st-2', concentrationPpm: 80, foundTime: '2024-06-04', state: '已复检', retestValuePpm: 32, measure: 'x', handler: 'h' }
  ],
  existing: allRows,
  now: 2000
})
const r0604 = afterRetest.upserts.find((r) => r.id === 'sg-1@2024-06-04')
assert.ok(r0604 && r0604.status === '已核算', '复检闭环后 06-04 转为已核算')
assert.ok(Math.abs(r0604.lossM3h - 100) < 0.01, '06-04 损耗 100')

// 批次删除：未归档结果进 staleDeletes；归档行不动
const removed = recomputeBalances({
  segments: [segment],
  stations,
  batches: batches.filter((b) => b.id !== 'b3'),
  snapshots: snapshots.filter((s) => s.batchId !== 'b3'),
  patrols: [],
  leaks: [],
  existing: allRows,
  now: 3000
})
assert.ok(removed.staleDeletes.includes('sg-1@2024-06-03'), '删除批次后清理未归档行')
assert.ok(!removed.staleDeletes.includes('sg-1@2024-06-01'), '归档行不因批次删除被清（快照保留）')

// findCarry 边界
assert.ok(findCarry([], '2024-06-03') === null, '无历史 -> null')

console.log('balanceEngine smoke tests passed')
