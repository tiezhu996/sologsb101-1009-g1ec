/**
 * 批次审计抽屉：流量包快照、批次审计链、确认后修订说明。
 * 被流量包面板与核算台账复用。
 */
import { Drawer, Descriptions, Space, Table, Tag, Timeline, Typography } from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import { useStationStore } from '@/stores/stationStore'
import { useBalanceStore } from '@/stores/balanceStore'
import type { FlowBatch, FlowSnapshot } from '@/types/balance'
import { formatDateTime, formatM3h } from '@/types/balance'

export interface BatchAuditDrawerProps {
  batch: FlowBatch | null
  visible: boolean
  onClose: () => void
}

const ACTION_COLOR: Record<string, string> = {
  导入: 'blue',
  刷新: 'arcoblue',
  确认: 'green',
  追加修订: 'orange',
  删除: 'red'
}

export function BatchAuditDrawer({ batch, visible, onClose }: BatchAuditDrawerProps) {
  const stationStore = useStationStore()
  const balanceStore = useBalanceStore()

  if (!batch) return <Drawer visible={visible} onCancel={onClose} footer={null} width={560} />

  const snapshots: FlowSnapshot[] = balanceStore.snapshotsOfBatch(batch.id)
  const snapshotColumns: TableColumnProps<FlowSnapshot>[] = [
    {
      title: '站点',
      render: (_value, record) => stationStore.stations.find((station) => station.id === record.stationId)?.name ?? '已删除站点'
    },
    {
      title: '进口流量',
      width: 120,
      render: (_value, record) =>
        record.inletFlowM3h === null ? <Tag color="red" size="small">缺失</Tag> : formatM3h(record.inletFlowM3h)
    },
    {
      title: '出口流量',
      width: 120,
      render: (_value, record) =>
        record.outletFlowM3h === null ? <Tag color="red" size="small">缺失</Tag> : formatM3h(record.outletFlowM3h)
    },
    { title: '备注', dataIndex: 'note', render: (value: string) => value || '—' }
  ]

  return (
    <Drawer
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={600}
      title={
        <span>
          批次 {batch.batchNo} · {batch.bizDate}{' '}
          <Tag color={batch.state === '已确认' ? 'green' : 'orange'}>{batch.state}</Tag>
        </span>
      }
    >
      <Descriptions
        column={2}
        size="small"
        border
        data={[
          { label: '业务日期', value: batch.bizDate },
          { label: '数据来源', value: batch.source || '—' },
          { label: '抄回人', value: batch.collector || '—' },
          { label: '快照站点数', value: `${batch.snapshotCount}` },
          { label: '导入时间', value: formatDateTime(batch.importedAt) },
          {
            label: '确认信息',
            value: batch.state === '已确认' ? `${batch.confirmedBy || '—'} · ${formatDateTime(batch.confirmedAt)}` : '未确认'
          }
        ]}
      />

      <Typography.Title heading={6} style={{ margin: '18px 0 10px' }}>
        进出口流量快照（流量包抄回）
      </Typography.Title>
      <Table<FlowSnapshot>
        rowKey="id"
        size="small"
        border
        data={snapshots}
        columns={snapshotColumns}
        pagination={false}
      />

      <Typography.Title heading={6} style={{ margin: '18px 0 10px' }}>
        批次审计链（{batch.auditTrail.length}）
      </Typography.Title>
      <Timeline>
        {batch.auditTrail.map((entry, index) => (
          <Timeline.Item
            key={`${entry.at}-${index}`}
            dotColor={entry.action === '确认' ? '#00b42a' : entry.action === '刷新' ? '#165dff' : undefined}
            label={formatDateTime(entry.at)}
          >
            <Space wrap>
              <Tag color={ACTION_COLOR[entry.action] ?? 'gray'} size="small">
                {entry.action}
              </Tag>
              <strong>{entry.operator || '未署名'}</strong>
            </Space>
            <div className="muted" style={{ marginTop: 2, whiteSpace: 'pre-wrap' }}>
              {entry.detail}
            </div>
          </Timeline.Item>
        ))}
      </Timeline>
    </Drawer>
  )
}

export default BatchAuditDrawer
