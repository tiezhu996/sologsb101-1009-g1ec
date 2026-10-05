/**
 * 核算台账：区段 × 日期的损耗核算结果
 * - 超阈区段高亮；待补依据单列原因并展示沿用的上一有效批次
 * - 展开/抽屉查看巡检与泄漏处置现场结论、流量依据、修订与批次审计
 */
import { useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Message,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import EmptyPanel from '@/components/common/EmptyPanel'
import { useBalanceStore } from '@/stores/balanceStore'
import { BALANCE_STATUSES, formatDateTime, formatM3h, formatRatePct, type SegmentBalance } from '@/types/balance'
import { exportBalanceCsv } from '@/utils/export'
import BatchAuditDrawer from '@/components/balance/BatchAuditDrawer'
import type { FlowBatch } from '@/types/balance'

export default function BalanceLedger() {
  const balanceStore = useBalanceStore()
  const [detail, setDetail] = useState<SegmentBalance | null>(null)
  const [auditBatch, setAuditBatch] = useState<FlowBatch | null>(null)

  const filter = balanceStore.filter
  const rows = balanceStore.filteredBalances()

  const exportCsv = (): void => {
    const filename = exportBalanceCsv(balanceStore.segments, balanceStore.batches, balanceStore.balances)
    Message.success(`已导出 ${filename}`)
  }

  const columns: TableColumnProps<SegmentBalance>[] = [
    { title: '业务日期', dataIndex: 'bizDate', width: 110 },
    {
      title: '区段（上游 → 下游）',
      width: 260,
      render: (_value, record) => (
        <div>
          <div style={{ fontWeight: 600 }}>{record.segmentName}</div>
          <div className="muted">
            {record.upstreamStationName} → {record.downstreamStationName}
          </div>
        </div>
      )
    },
    {
      title: '上游出口',
      width: 120,
      render: (_value, record) =>
        record.upstreamOutletM3h === null ? (
          <Tag color="red" size="small">缺失</Tag>
        ) : (
          formatM3h(record.upstreamOutletM3h, 0)
        )
    },
    {
      title: '下游进口',
      width: 120,
      render: (_value, record) =>
        record.downstreamInletM3h === null ? (
          <Tag color="red" size="small">缺失</Tag>
        ) : (
          formatM3h(record.downstreamInletM3h, 0)
        )
    },
    {
      title: '损耗 / 损耗率',
      width: 170,
      render: (_value, record) => {
        if (record.lossM3h === null || record.lossRatePct === null) {
          return (
            <div>
              <Tag color="red">待补依据</Tag>
              {record.carryFrom ? (
                <div className="muted" style={{ marginTop: 2 }}>
                  沿用 {record.carryFrom.batchNo}：{record.carryFrom.lossM3h.toFixed(0)} m³/h（{formatRatePct(record.carryFrom.lossRatePct)}）
                </div>
              ) : (
                <div className="muted" style={{ marginTop: 2 }}>
                  暂无有效批次可沿用
                </div>
              )}
            </div>
          )
        }
        return (
          <Space direction="vertical" size={0}>
            <strong style={{ color: record.overThreshold ? '#f53f3f' : undefined }}>
              {record.lossM3h.toFixed(1)} m³/h
            </strong>
            <Tag color={record.overThreshold ? 'red' : 'green'} size="small">
              {formatRatePct(record.lossRatePct)} / 阈值 {record.thresholdPct}%
            </Tag>
          </Space>
        )
      }
    },
    {
      title: '状态',
      width: 120,
      render: (_value, record) => (
        <Space direction="vertical" size={2}>
          <Tag color={record.status === '待补依据' ? 'red' : record.overThreshold ? 'orange' : 'green'} size="small">
            {record.status === '待补依据' ? '待补依据' : record.overThreshold ? '已核算·超阈' : '已核算'}
          </Tag>
          {record.archived ? (
            <Tag color="arcoblue" size="small">
              已归档
            </Tag>
          ) : null}
        </Space>
      )
    },
    {
      title: '依据速览',
      render: (_value, record) => (
        <Space size={6} wrap>
          <Tag size="small">巡检 {record.patrolEvidence.length}</Tag>
          <Tag size="small" color={record.leakEvidence.some((leak) => leak.state !== '已复检') ? 'red' : undefined}>
            处置单 {record.leakEvidence.length}
          </Tag>
          {record.pendingReasons.slice(0, 1).map((reason) => (
            <Tag key={reason} color="red" size="small">
              {reason.length > 22 ? `${reason.slice(0, 22)}…` : reason}
            </Tag>
          ))}
          {record.revisionNotes.length > 0 ? (
            <Tag color="orange" size="small">
              修订 {record.revisionNotes.length}
            </Tag>
          ) : null}
        </Space>
      )
    },
    {
      title: '操作',
      width: 130,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => setDetail(record)}>
            核算依据
          </Button>
          <Button
            type="text"
            size="small"
            onClick={() => {
              const batch = balanceStore.batches.find((item) => item.id === record.batchId)
              if (batch) setAuditBatch(batch)
              else Message.info('该批次已不在批次表（归档台账仅保留快照）')
            }}
          >
            批次审计
          </Button>
        </Space>
      )
    }
  ]

  const detailBatch = detail ? balanceStore.batches.find((batch) => batch.id === detail.batchId) ?? null : null

  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="panel-title" style={{ margin: 0 }}>
          区段损耗核算台账（{rows.length}）
        </h3>
        <Space size={12} wrap>
          <Select
            style={{ width: 180 }}
            placeholder="选择区段"
            allowClear
            value={filter.segmentId || undefined}
            onChange={(value) => balanceStore.patchFilter({ segmentId: value ?? '' })}
            options={balanceStore.segments.map((segment) => ({ label: segment.name, value: segment.id }))}
          />
          <Select
            style={{ width: 140 }}
            placeholder="核算状态"
            allowClear
            value={filter.statusFilter || undefined}
            onChange={(value) =>
              balanceStore.patchFilter({ statusFilter: (value as '' | (typeof BALANCE_STATUSES)[number]) ?? '' })
            }
            options={BALANCE_STATUSES.map((status) => ({ label: status, value: status }))}
          />
          <Select
            style={{ width: 140 }}
            placeholder="归档范围"
            allowClear
            value={filter.archivedFilter || undefined}
            onChange={(value) =>
              balanceStore.patchFilter({ archivedFilter: (value as '' | 'open' | 'archived') ?? '' })
            }
            options={[
              { label: '仅未归档', value: 'open' },
              { label: '仅已归档', value: 'archived' }
            ]}
          />
          <Space size={6}>
            <Switch
              size="small"
              checked={filter.onlyOverThreshold}
              onChange={(checked) => balanceStore.patchFilter({ onlyOverThreshold: checked })}
            />
            <span className="muted">仅看超阈区段</span>
          </Space>
          <Button size="small" onClick={exportCsv}>
            导出核算台账 CSV
          </Button>
        </Space>
      </div>

      {rows.length === 0 ? (
        <EmptyPanel
          title="暂无核算结果"
          description="维护区段拓扑并导入流量包后，系统会按日期自动核算区段损耗。"
          compact
        />
      ) : (
        <Table<SegmentBalance>
          rowKey="id"
          size="small"
          border
          data={rows}
          columns={columns}
          pagination={false}
          scroll={{ x: 1500 }}
        />
      )}

      <Drawer
        visible={detail !== null}
        onCancel={() => setDetail(null)}
        footer={null}
        width={640}
        title={detail ? `${detail.bizDate} · ${detail.segmentName}` : ''}
      >
        {detail ? (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <Descriptions
              column={2}
              size="small"
              border
              data={[
                { label: '核算状态', value: detail.status },
                { label: '归档状态', value: detail.archived ? `已归档 · ${formatDateTime(detail.frozenAt)}` : '未归档（可随输入重算）' },
                { label: '上游出口', value: formatM3h(detail.upstreamOutletM3h, 0) },
                { label: '下游进口', value: formatM3h(detail.downstreamInletM3h, 0) },
                {
                  label: '损耗',
                  value: detail.lossM3h === null ? '待补依据（不计零）' : `${detail.lossM3h.toFixed(1)} m³/h`
                },
                {
                  label: '损耗率',
                  value: detail.lossRatePct === null ? '—' : `${formatRatePct(detail.lossRatePct)}（阈值 ${detail.thresholdPct}%）`
                },
                { label: '流量批次', value: `${detail.batchNo}` },
                { label: '最近计算', value: formatDateTime(detail.computedAt) }
              ]}
            />

            {detail.status === '待补依据' ? (
              <Alert
                type="error"
                title="待补依据（损耗不得按零处理）"
                content={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {detail.pendingReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}

            {detail.carryFrom ? (
              <Alert
                type="warning"
                content={
                  <span>
                    当前批次依据不全，损耗沿用上一有效批次 <strong>{detail.carryFrom.batchNo}</strong>（
                    {detail.carryFrom.bizDate}）：{detail.carryFrom.lossM3h.toFixed(1)} m³/h，损耗率{' '}
                    {formatRatePct(detail.carryFrom.lossRatePct)}。补齐读数与复检结论后将自动重算。
                  </span>
                }
              />
            ) : null}

            {detail.overThreshold && detail.status === '已核算' ? (
              <Alert type="warning" content={`损耗率 ${formatRatePct(detail.lossRatePct)} 超过区段阈值 ${detail.thresholdPct}%，已列入超阈区段台账。`} />
            ) : null}

            <div>
              <Typography.Title heading={6} style={{ margin: '0 0 8px' }}>
                当天巡检现场结论（{detail.patrolEvidence.length}）
              </Typography.Title>
              {detail.patrolEvidence.length === 0 ? (
                <span className="muted">当天无巡检记录</span>
              ) : (
                <Timeline>
                  {detail.patrolEvidence.map((patrol) => (
                    <Timeline.Item key={patrol.patrolId}>
                      <Space wrap>
                        <strong>{patrol.stationName}</strong>
                        <Tag size="small" color={patrol.state === '漏检' ? 'red' : patrol.state === '已完成' ? 'green' : 'blue'}>
                          {patrol.state}
                        </Tag>
                        <span className="muted">{patrol.patrolman || '未署名'} · 生效 {patrol.effectiveDate}</span>
                        {patrol.abnormalCount > 0 ? <Tag color="orange" size="small">异常读数 {patrol.abnormalCount}</Tag> : null}
                      </Space>
                      {patrol.envNote ? <div className="muted">{patrol.envNote}</div> : null}
                    </Timeline.Item>
                  ))}
                </Timeline>
              )}
            </div>

            <div>
              <Typography.Title heading={6} style={{ margin: '0 0 8px' }}>
                当天泄漏处置单现场结论（{detail.leakEvidence.length}）
              </Typography.Title>
              {detail.leakEvidence.length === 0 ? (
                <span className="muted">当天无泄漏处置单</span>
              ) : (
                <Timeline>
                  {detail.leakEvidence.map((leak) => (
                    <Timeline.Item key={leak.leakId}>
                      <Space wrap>
                        <strong>{leak.stationName}</strong>
                        <Tag color={leak.state === '已复检' ? 'green' : 'red'} size="small">
                          {leak.state}
                        </Tag>
                        <span className="muted">
                          {leak.concentrationPpm} ppm · {leak.handler || '未署名'}
                          {leak.retestValuePpm ? ` · 复检 ${leak.retestValuePpm} ppm` : ''}
                        </span>
                      </Space>
                      {leak.measure ? <div className="muted">处置措施：{leak.measure}</div> : <div className="muted">尚未填写处置措施 / 复检结论</div>}
                    </Timeline.Item>
                  ))}
                </Timeline>
              )}
            </div>

            <div>
              <Typography.Title heading={6} style={{ margin: '0 0 8px' }}>
                修订说明（{detail.revisionNotes.length}，确认后只追加不改算）
              </Typography.Title>
              {detail.revisionNotes.length === 0 ? (
                <span className="muted">无修订</span>
              ) : (
                <Timeline>
                  {detail.revisionNotes.map((revision) => (
                    <Timeline.Item key={`${revision.at}-${revision.note}`} label={formatDateTime(revision.at)}>
                      <strong>{revision.operator}</strong>
                      <div>{revision.note}</div>
                    </Timeline.Item>
                  ))}
                </Timeline>
              )}
              {detailBatch ? (
                <Button size="mini" style={{ marginTop: 8 }} onClick={() => setAuditBatch(detailBatch)}>
                  查看完整批次审计链
                </Button>
              ) : null}
            </div>
          </Space>
        ) : null}
      </Drawer>

      <BatchAuditDrawer batch={auditBatch} visible={auditBatch !== null} onClose={() => setAuditBatch(null)} />
    </div>
  )
}
