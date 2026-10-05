/**
 * Dexie 存储层端到端冒烟测试（fake-indexeddb）：
 * v3 播种 → 已确认冻结 → 待补依据/沿用 → 泄漏复检触发重算 → 重复导入刷新 →
 * 已确认拒覆盖 → 写入失败回滚 → 确认归档 → 追加修订不改数字 → 归档行不受拓扑变化影响。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert'
import { db } from '../src/utils/db'
import { seedDatabase } from '../src/utils/db'
import { useBalanceStore, persistRecompute } from '../src/stores/balanceStore'

async function main() {
  await db.delete()
  await db.open()
  await seedDatabase()

  const batches = await db.flowBatches.toArray()
  const balances = await db.segmentBalances.toArray()
  assert.equal((await db.pipeSegments.toArray()).length, 1, '播种 1 个区段')
  assert.equal(batches.length, 4, '播种 4 个流量包批次')
  assert.ok(balances.length >= 4, '每个批次都有核算行')

  const b1 = balances.find((r) => r.bizDate === '2024-06-03')!
  const b2 = balances.find((r) => r.bizDate === '2024-06-05')!
  assert.ok(b1.archived && b1.status === '已核算', '06-03 归档已核算')
  assert.ok(b2.archived && b2.overThreshold, '06-05 归档超阈')

  const b3 = balances.find((r) => r.bizDate === '2024-06-12')!
  assert.ok(!b3.archived && b3.status === '待补依据', '06-12 未复检泄漏 -> 待补')
  assert.equal(b3.lossM3h, null, '待补损耗为 null 而非 0')
  assert.equal(b3.carryFrom?.batchNo, 'FB20240605', '06-12 沿用上一有效批次')
  assert.ok(b3.pendingReasons.some((x) => x.includes('尚未复检')), '含未复检原因')

  const b4 = balances.find((r) => r.bizDate === '2024-06-19')!
  assert.ok(b4.status === '待补依据', '06-19 读数缺失 -> 待补')
  assert.equal(b4.upstreamOutletM3h, null, '上游出口快照为 null')
  assert.equal(b4.carryFrom?.batchNo, 'FB20240605', '06-19 沿用上一有效批次')

  // 泄漏单复检闭环 -> 手动排队的增量重算（node 下 liveQuery 订阅不触发）
  await db.leaks.update('lk-2', { state: '已复检', retestValuePpm: 32 })
  await persistRecompute()
  const b3after = await db.segmentBalances.get(b3.id)
  assert.equal(b3after.status, '已核算', '泄漏复检后重算为已核算')
  assert.ok(Math.abs(b3after.lossM3h - 250) < 0.01, '06-12 损耗 7400-7150=250')
  assert.equal(b3after.archived, false, '复检后仍是未归档')

  // 重复导入同一批次：只刷新未确认快照，审计追加
  const before = await db.flowBatches.where('batchNo').equals('FB20240619').first()!
  await useBalanceStore.getState().importFlowPackage({
    batchNo: 'FB20240619',
    bizDate: '2024-06-19',
    collector: '刘洋',
    source: 'SCADA 流量日报',
    snapshots: [
      { stationId: 'st-1', inletFlowM3h: 7700, outletFlowM3h: 7300, note: '补抄' },
      { stationId: 'st-2', inletFlowM3h: 6900, outletFlowM3h: 6600, note: '' }
    ]
  })
  const after = await db.flowBatches.where('batchNo').equals('FB20240619').first()!
  assert.equal(after.snapshotCount, 2)
  assert.ok(after.auditTrail.some((x) => x.action === '刷新'), '审计链含刷新')
  assert.equal(after.state, '待确认')
  const b4after = await db.segmentBalances.get(b4.id)
  assert.equal(b4after.status, '已核算', '读数补齐后 06-19 转已核算')
  assert.ok(Math.abs(b4after.lossM3h - 400) < 0.01, '06-19 损耗 7300-6900=400')
  assert.equal(b4after.carryFrom, null, '补齐后不再沿用')
  assert.equal(before.auditTrail.length + 1, after.auditTrail.length, '审计只追加一条')

  // 已确认批次拒绝覆盖
  await assert.rejects(
    () =>
      useBalanceStore.getState().importFlowPackage({
        batchNo: 'FB20240603',
        bizDate: '2024-06-03',
        snapshots: [
          { stationId: 'st-1', inletFlowM3h: 1, outletFlowM3h: 1 },
          { stationId: 'st-2', inletFlowM3h: 1, outletFlowM3h: 1 }
        ]
      }),
    /已确认归档/
  )

  // 写入失败回滚：非法站点 -> 批次与快照都不落库
  const batchCountBefore = await db.flowBatches.count()
  const snapCountBefore = await db.flowSnapshots.count()
  await assert.rejects(
    () =>
      useBalanceStore.getState().importFlowPackage({
        batchNo: 'FB-BAD',
        bizDate: '2024-06-30',
        snapshots: [{ stationId: 'st-404', inletFlowM3h: 1, outletFlowM3h: 1 }]
      }),
    /不在站点台账/
  )
  assert.equal(await db.flowBatches.count(), batchCountBefore, '失败后批次数不变（回滚）')
  assert.equal(await db.flowSnapshots.count(), snapCountBefore, '失败后快照数不变（回滚）')

  // 确认归档：待补行数为 0（此时已补齐）
  const target = await db.flowBatches.where('batchNo').equals('FB20240619').first()!
  const { pendingRows } = await useBalanceStore.getState().confirmBatch(target.id, '调度值班长')
  assert.equal(pendingRows, 0)
  const frozen = await db.segmentBalances.get(b4.id)
  assert.equal(frozen.archived, true, '确认后冻结')
  const frozenLoss = frozen.lossM3h

  // 追加修订不改数字
  await useBalanceStore.getState().appendRevision(target.id, '经复核含站场自用气，数字不改', '值班长')
  const frozen2 = await db.segmentBalances.get(b4.id)
  assert.equal(frozen2.lossM3h, frozenLoss, '追加修订不改数字')
  assert.equal(frozen2.revisionNotes.length, 1, '修订追加一条')
  const batchAfter = await db.flowBatches.get(target.id)
  assert.ok(batchAfter!.auditTrail.some((x) => x.action === '追加修订'))

  // 归档后拓扑阈值变化：归档行快照保留
  await db.pipeSegments.update('sg-1', { lossRateThresholdPct: 99 })
  await persistRecompute()
  const frozen3 = await db.segmentBalances.get(b4.id)
  assert.equal(frozen3.thresholdPct, 3, '归档行阈值快照保留')
  assert.equal(frozen3.overThreshold, true, '归档判定保留')

  console.log('db e2e smoke tests passed')
  await db.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
