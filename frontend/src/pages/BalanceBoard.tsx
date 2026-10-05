/**
 * /balance 气量平衡台
 * 区段拓扑（上下游方向）· 流量包（进出口快照）· 核算台账（损耗 / 超阈 / 依据 / 审计）。
 * 维护站点上下游连接和方向，导入进出口流量快照，结合当天巡检与泄漏处置单核算区段损耗。
 */
import { useState } from 'react'
import { Tabs } from '@arco-design/web-react'
import StatBadge from '@/components/common/StatBadge'
import TopologyPanel from '@/components/balance/TopologyPanel'
import FlowPackagePanel from '@/components/balance/FlowPackagePanel'
import BalanceLedger from '@/components/balance/BalanceLedger'
import { useBalanceStore } from '@/stores/balanceStore'

const TabPane = Tabs.TabPane

export default function BalanceBoard() {
  const balanceStore = useBalanceStore()
  const [activeTab, setActiveTab] = useState('ledger')
  const stats = balanceStore.stats()

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">气量平衡台</h2>
          <p className="page-head__desc">
            按区段方向取上下游进出口快照核算损耗；读数缺失或处置未复检时标「待补依据」并沿用上一有效批次，绝不把损耗算成零。
          </p>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="区段数" value={stats.segmentCount} suffix="段" tone="primary" />
        <StatBadge label="待确认批次" value={stats.pendingBatchCount} suffix="包" tone="warning" />
        <StatBadge
          label="待补依据（未归档）"
          value={stats.pendingRowCount}
          suffix="区段"
          tone="danger"
          hint="读数缺失或泄漏处置单未复检，损耗沿用上一有效批次"
        />
        <StatBadge label="超阈区段（未归档）" value={stats.overThresholdCount} suffix="区段" tone="danger" />
        <StatBadge label="沿用有效批次" value={stats.carryCount} suffix="区段" tone="info" />
        <StatBadge label="已归档台账" value={stats.archivedCount} suffix="条" tone="success" />
      </div>

      <div className="panel">
        <Tabs activeTab={activeTab} onChange={setActiveTab} type="rounded">
          <TabPane key="ledger" title="核算台账">
            <BalanceLedger />
          </TabPane>
          <TabPane key="packages" title="流量包">
            <FlowPackagePanel />
          </TabPane>
          <TabPane key="topology" title="区段拓扑">
            <TopologyPanel />
          </TabPane>
        </Tabs>
      </div>
    </div>
  )
}
