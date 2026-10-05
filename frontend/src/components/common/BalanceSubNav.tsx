/**
 * <BalanceSubNav> 气量平衡台内部页签：区段拓扑 / 流量包 / 气量台账。
 */
import { useNavigate } from 'react-router-dom'

export interface BalanceSubNavItem {
  path: string
  label: string
}

export const BALANCE_NAV_ITEMS: BalanceSubNavItem[] = [
  { path: '/balance/segments', label: '区段拓扑' },
  { path: '/balance/flows', label: '流量包快照' },
  { path: '/balance/ledger', label: '气量平衡台账' }
]

export interface BalanceSubNavProps {
  active: string
  onNavigate?: (path: string) => void
}

export function BalanceSubNav({ active, onNavigate }: BalanceSubNavProps) {
  const navigate = useNavigate()
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: 6,
        marginBottom: 16,
        background: '#eaf1ff',
        border: '1px solid #c9ddff',
        borderRadius: 10
      }}
    >
      {BALANCE_NAV_ITEMS.map((item) => (
        <button
          key={item.path}
          type="button"
          onClick={() => (onNavigate ? onNavigate(item.path) : navigate(item.path))}
          style={{
            flex: '0 0 auto',
            padding: '6px 18px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            fontWeight: active.startsWith(item.path) ? 700 : 500,
            color: active.startsWith(item.path) ? '#ffffff' : '#165dff',
            background: active.startsWith(item.path) ? '#165dff' : 'transparent'
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export default BalanceSubNav
