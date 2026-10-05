/**
 * /balance/ledger 气量平衡台账
 * 展示区段 × 日期的毛/净损耗、超阈标记、核算依据与待补原因、归档快照；支持归档/取消归档、详情抽屉、CSV 导出。
 * 消费 BalanceRecord、Segment、FlowBatch；复用 <BalanceSubNav>、<StatBadge>、<BalanceStatusTag>、<BalanceBasisList>。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Drawer,
  Message,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import StatBadge from '@/components/common/StatBadge'
import EmptyPanel from '@/components/common/EmptyPanel'
import BalanceSubNav from '@/components/common/BalanceSubNav'
import BalanceStatusTag from '@/components/common/BalanceStatusTag'
import BalanceBasisList from '@/components/common/BalanceBasisList'
import { useStationStore } from '@/stores/stationStore'
import { useBalanceStore, type BalanceRecordFilterStatus } from '@/stores/balanceStore'
import type { BalanceRecord } from '@/types/balance'
import { formatM3 } from '@/utils/balance'
import { csvCell, download, stampSuffix } from '@/utils/export'

export default function BalanceLedger() {
  const stationStore = useStationStore()
  const balanceStore = useBalanceStore()
  const [detail, setDetail] = useState<BalanceRecord | null>(null)

  const segmentById = useMemo(
    () => new Map(balanceStore.segments.map((segment) => [segment.id, segment])),
    [balanceStore.segments]
  )
  const batchById = useMemo(() => new Map(balanceStore.batches.map((batch) => [batch.id, batch])), [balanceStore.batches])

  const stationName = (id: string): string => stationStore.stations.find((station) => station.id === id)?.name ?? '未知站点'

  const records = balanceStore.filteredRecords()

  const archive = async (record: BalanceRecord): Promise<void> => {
    await balanceStore.archiveRecord(record.id)
    Message.success(`已归档 ${record.date} 核算结果，后续更新保留该快照`)
  }

  const unarchive = async (record: BalanceRecord): Promise<void> => {
    await balanceStore.unarchiveRecord(record.id)
    Message.success('已取消归档并按当前拓扑/流量包重新核算该日期')
  }

  const exportCsv = (): void => {
    const header = [
      '区段编号',
      '区段名称',
      '日期',
      '上游站',
      '下游站',
      '上游出口(m³)',
      '下游进口(m³)',
      '毛损耗(m³)',
      '核销泄漏(m³)',
      '净损耗(m³)',
      '超阈',
      '状态',
      '是否沿用',
      '是否临时值',
      '是否归档',
      '待补原因',
      '流量批次'
    ]
    const lines = [header.map(csvCell).join(',')]
    records.forEach((record) => {
      const segment = segmentById.get(record.segmentId)
      lines.push(
        [
          segment?.code ?? '—',
          segment?.name ?? '—',
          record.date,
          segment ? stationName(segment.upstreamStationId) : '—',
          segment ? stationName(segment.downstreamStationId) : '—',
          record.upstreamOutletM3 ?? '待补',
          record.downstreamInletM3 ?? '待补',
          record.grossLossM3 ?? '待补',
          record.leakLossM3,
          record.netLossM3 ?? '待补',
          record.overThreshold ? '是' : '否',
          record.status,
          record.carriedForward ? `是(${record.carriedBatchNo})` : '否',
          record.provisional ? '是' : '否',
          record.archived ? '是' : '否',
          record.pendingReason || '—',
          batchById.get(record.batchId)?.batchNo ?? '—'
        ]
          .map(csvCell)
          .join(',')
      )
    })
    download(`气量平衡台账-${stampSuffix()}.csv`, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8')
    Message.success('气量平衡台账 CSV 已导出')
  }

  const columns: TableColumnProps<BalanceRecord>[] = [
    { title: '日期', dataIndex: 'date', width: 110 },
    {
      title: '区段',
      width: 210,
      render: (_v, record) => {
        const segment = segmentById.get(record.segmentId)
        return segment ? (
          <div>
            <div style={{ fontWeight: 600 }}>{segment.code}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {segment.name}
            </div>
          </div>
        ) : (
          '—'
        )
      }
    },
    {
      title: '上游出口',
      dataIndex: 'upstreamOutletM3',
      width: 120,
      render: (v: number | null, record) => (
        <span style={{ color: v === null ? '#ff7d00' : undefined }}>
          {formatM3(v)}
          {record.carriedForward ? <Tag size="small">沿用</Tag> : null}
        </span>
      )
    },
    { title: '下游进口', dataIndex: 'downstreamInletM3', width: 120, render: (v: number | null) => formatM3(v) },
    {
      title: '毛损耗',
      dataIndex: 'grossLossM3',
      width: 110,
      render: (v: number | null) => <strong>{formatM3(v)}</strong>
    },
    {
      title: '核销泄漏',
      dataIndex: 'leakLossM3',
      width: 100,
      render: (v: number) => (v > 0 ? <Tag color="purple">{v} m³</Tag> : '0 m³')
    },
    {
      title: '净损耗',
      dataIndex: 'netLossM3',
      width: 120,
      render: (v: number | null, record) => (
        <Space size={4}>
          <strong style={{ color: record.overThreshold ? '#f53f3f' : '#1d2129' }}>{formatM3(v)}</strong>
          {record.overThreshold ? <Tag color="red">超阈</Tag> : null}
        </Space>
      )
    },
    { title: '状态', width: 170, render: (_v, record) => <BalanceStatusTag record={record} /> },
    {
      title: '待补原因 / 依据',
      width: 220,
      render: (_v, record) =>
        record.pendingReason ? (
          <Tooltip content={record.pendingReason}>
            <Typography.Text
              style={{ color: '#b85c00', fontSize: 12, display: 'inline-block', maxWidth: 200 }}
              ellipsis
            >
              {record.pendingReason}
            </Typography.Text>
          </Tooltip>
        ) : (
          <span className="muted">{record.basis.length} 条依据齐备</span>
        )
    },
    {
      title: '操作',
      width: 170,
      render: (_v, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => setDetail(record)}>
            核算依据
          </Button>
          {record.archived ? (
            <Button type="text" size="small" onClick={() => unarchive(record)}>
              取消归档
            </Button>
          ) : (
            <Popconfirm title="归档后保留核算快照，拓扑/流量包更新不再重算该日期，确认？" onOk={() => archive(record)}>
              <Button type="text" size="small" status="success">
                归档
              </Button>
            </Popconfirm>
          )}
        </Space>
      )
    }
  ]

  const detailSegment = detail ? segmentById.get(detail.segmentId) : null

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">气量平衡台账（区段损耗核算）</h2>
          <p className="page-head__desc">
            毛损耗＝上游出口−下游进口；净损耗＝毛损耗−已复检合格泄漏。读数缺失或处置未复检不算 0，标「待补依据」并沿用上一有效批次。
            已归档日期保留快照，只重算未归档日期。
          </p>
        </div>
        <div className="page-head__actions">
          <Button disabled={records.length === 0} onClick={exportCsv}>
            导出台账 CSV
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="核算记录" value={balanceStore.records.length} suffix="日" tone="primary" />
        <StatBadge label="超阈（未归档）" value={balanceStore.overThresholdCount()} suffix="日" tone="danger" />
        <StatBadge label="待补依据" value={balanceStore.pendingCount()} suffix="日" tone="warning" />
        <StatBadge label="已归档快照" value={balanceStore.records.filter((r) => r.archived).length} suffix="日" tone="default" />
      </div>

      <BalanceSubNav active="/balance/ledger" />

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          padding: '12px 16px',
          background: '#fff',
          border: '1px solid #e5e6eb',
          borderRadius: 10,
          marginBottom: 16
        }}
      >
        <Space size={6}>
          <span className="muted">区段</span>
          <Select
            style={{ width: 240 }}
            allowClear
            placeholder="全部区段"
            value={balanceStore.filter.segmentId || undefined}
            onChange={(value) => balanceStore.patchFilter({ segmentId: value ?? '' })}
            options={balanceStore.segments.map((segment) => ({
              label: `${segment.code} ${segment.name}`,
              value: segment.id
            }))}
          />
        </Space>
        <Space size={6}>
          <span className="muted">状态</span>
          <Select
            style={{ width: 150 }}
            allowClear
            placeholder="全部状态"
            value={balanceStore.filter.status || undefined}
            onChange={(value) => balanceStore.patchFilter({ status: (value ?? '') as BalanceRecordFilterStatus | '' })}
            options={[
              { label: '已核算', value: '已核算' },
              { label: '待补依据', value: '待补' },
              { label: '超阈', value: '超阈' },
              { label: '已归档', value: '已归档' }
            ]}
          />
        </Space>
        <Space size={6}>
          <Switch
            size="small"
            checked={balanceStore.filter.onlyOverThreshold}
            onChange={(checked) => balanceStore.patchFilter({ onlyOverThreshold: checked })}
          />
          <span className="muted">仅看超阈</span>
        </Space>
        <Space size={6}>
          <Switch
            size="small"
            checked={balanceStore.filter.onlyPending}
            onChange={(checked) => balanceStore.patchFilter({ onlyPending: checked })}
          />
          <span className="muted">仅看待补</span>
        </Space>
      </div>

      <div className="panel">
        {records.length === 0 ? (
          <EmptyPanel
            title="没有匹配的核算记录"
            description="先在「区段拓扑」建立管段、在「流量包快照」导入当日进出口流量，系统会自动按日期核算区段损耗。"
            compact
          />
        ) : (
          <Table<BalanceRecord>
            rowKey="id"
            size="small"
            border
            data={records}
            columns={columns}
            pagination={false}
            scroll={{ x: 1500 }}
            rowClassName={(record) => (record.archived ? 'balance-row--archived' : record.overThreshold ? 'balance-row--over' : '')}
          />
        )}
      </div>

      <Drawer
        width={620}
        title={detail ? `核算依据 · ${detailSegment?.code ?? ''} · ${detail.date}` : ''}
        visible={detail !== null}
        onCancel={() => setDetail(null)}
        footer={null}
        unmountOnExit
      >
        {detail && detailSegment ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Space wrap>
              <BalanceStatusTag record={detail} />
              {detail.overThreshold ? <Tag color="red">净损耗超阈值 {detailSegment.thresholdM3} m³/日</Tag> : null}
              {detail.archived ? <Tag color="gray">已归档 · {new Date(detail.archivedAt).toLocaleDateString('zh-CN')}</Tag> : null}
            </Space>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10
              }}
            >
              {[
                { label: `${stationName(detailSegment.upstreamStationId)} · 出口`, value: detail.upstreamOutletM3 },
                { label: `${stationName(detailSegment.downstreamStationId)} · 进口`, value: detail.downstreamInletM3 },
                { label: '毛损耗', value: detail.grossLossM3 },
                { label: '已核销泄漏损耗', value: detail.leakLossM3 },
                { label: '净损耗', value: detail.netLossM3, emphasize: detail.overThreshold },
                { label: '流量批次', valueText: batchById.get(detail.batchId)?.batchNo ?? '—' }
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    padding: '10px 12px',
                    background: '#f7f8fa',
                    border: `1px solid ${item.emphasize ? '#f53f3f' : '#e5e6eb'}`,
                    borderRadius: 8
                  }}
                >
                  <div className="muted" style={{ fontSize: 12 }}>
                    {item.label}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: item.emphasize ? '#f53f3f' : '#1d2129' }}>
                    {item.valueText !== undefined ? item.valueText : formatM3(item.value ?? null)}
                  </div>
                </div>
              ))}
            </div>

            {detail.pendingReason ? (
              <div style={{ padding: '10px 12px', background: '#fff7e8', border: '1px solid #ffcf8b', borderRadius: 8 }}>
                <strong style={{ color: '#b85c00' }}>待补原因：</strong>
                <span style={{ color: '#b85c00' }}>{detail.pendingReason}</span>
              </div>
            ) : null}

            <div>
              <h4 style={{ margin: '0 0 8px' }}>核算依据（{detail.basis.length}）</h4>
              <BalanceBasisList basis={detail.basis} />
            </div>

            <Typography.Text className="muted" style={{ fontSize: 12 }}>
              最近核算：{new Date(detail.computedAt).toLocaleString('zh-CN')}
              {detail.archived ? '；该日期已归档，结果为保留快照。' : '；未归档，拓扑或流量包更新后会自动重算。'}
            </Typography.Text>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
